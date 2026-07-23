"""Integration tests for the agent router (task lifecycle / approvals / SSE).

LLM calls are stubbed so we can exercise the skill paths deterministically.
"""
from __future__ import annotations

from unittest.mock import patch

"""Helper: patch `get_gateway` everywhere it's been imported so skills pick up
our stub. Skills do `from app.llm.gateway import get_gateway` which binds a
local reference; patching only `app.llm.gateway.get_gateway` doesn't reach them.
"""
def _patch_gateway(stub):
    from contextlib import ExitStack
    stack = ExitStack()
    stack.enter_context(patch("app.agent.research_skills.get_gateway", lambda: stub))
    stack.enter_context(patch("app.agent.code_skills.get_gateway", lambda: stub))
    stack.enter_context(patch("app.agent.writing_skill.get_gateway", lambda: stub))
    return stack


def test_list_skills(client):
    resp = client.get("/api/v1/agent/skills")
    assert resp.status_code == 200
    skills = resp.json()["skills"]
    # The three skills registered at import time should be present.
    assert "research.trend_analysis" in skills
    assert "research.generate_hypothesis" in skills
    assert "code.search_github" in skills
    assert "writing.draft_section" in skills


def test_active_workflows_lists_running_task_with_experiment_id(client, project, db_session):
    """A running autonomous task should surface in /workflows/active with the
    experiment_id parsed from input_json (no FK column on agent_tasks)."""
    import json

    from app.db.models import AgentTask, AgentTaskEvent
    from app.utils import new_id

    exp = client.post(
        f"/api/v1/projects/{project['id']}/experiments",
        json={"title": "Auto Exp"},
    ).json()

    task = AgentTask(
        id=new_id("task"),
        project_id=project["id"],
        task_type="experiment.autonomous_run",
        input_json=json.dumps({"experiment_id": exp["id"], "research_question": "q"}),
        status="running",
    )
    db_session.add(task)
    db_session.add(AgentTaskEvent(
        id=new_id("evt"), task_id=task.id, kind="step", message="阶段 1/5:查找 benchmark",
    ))
    db_session.commit()

    resp = client.get("/api/v1/workflows/active")
    assert resp.status_code == 200, resp.text
    body = resp.json()
    matching = [t for t in body["tasks"] if t["id"] == task.id]
    assert len(matching) == 1, body
    t = matching[0]
    assert t["experiment_id"] == exp["id"]
    assert t["status"] == "running"
    assert t["last_message"] == "阶段 1/5:查找 benchmark"


def test_active_workflows_recent_terminal_tasks_linger(client, project, db_session):
    """Terminal tasks appear in /workflows/active for the recent window (so a
    fast sync task like generate-idea is still visible after it finishes), but
    old terminal tasks don't."""
    from datetime import UTC, datetime, timedelta

    from app.db.models import AgentTask
    from app.utils import new_id

    # Fresh terminal task -> should surface as recent.
    fresh = AgentTask(
        id=new_id("task"),
        project_id=project["id"],
        task_type="research.generate_hypothesis",
        input_json="{}",
        status="completed",
    )
    db_session.add(fresh)
    # Old terminal task (updated > 90s ago) -> must NOT appear.
    old = AgentTask(
        id=new_id("task"),
        project_id=project["id"],
        task_type="research.trend_analysis",
        input_json="{}",
        status="failed",
        updated_at=datetime.now(UTC) - timedelta(seconds=200),
    )
    db_session.add(old)
    db_session.commit()

    body = client.get("/api/v1/workflows/active").json()
    ids = [t["id"] for t in body["tasks"]]
    assert fresh.id in ids, body
    assert old.id not in ids, body
    fresh_out = next(t for t in body["tasks"] if t["id"] == fresh.id)
    assert fresh_out["recent"] is True
    assert fresh_out["status"] == "completed"


def test_active_workflows_lists_running_run(client, project, db_session):
    """A running experiment run should surface in /workflows/active with the
    owning experiment + project ids (for sidebar deep-linking). Exercises the
    ExperimentRun -> Experiment join."""
    from app.db.models import ExperimentRun
    from app.utils import new_id

    exp = client.post(
        f"/api/v1/projects/{project['id']}/experiments",
        json={"title": "Run Exp"},
    ).json()

    run = ExperimentRun(
        id=new_id("run"),
        experiment_id=exp["id"],
        status="running",
        command="uv run python -m src.train",
        seed=42,
    )
    db_session.add(run)
    db_session.commit()

    body = client.get("/api/v1/workflows/active").json()
    matching = [r for r in body["runs"] if r["run_id"] == run.id]
    assert len(matching) == 1, body
    r = matching[0]
    assert r["experiment_id"] == exp["id"]
    assert r["project_id"] == project["id"]
    assert r["command"] == "uv run python -m src.train"


def test_create_task_unknown_type_rejected(client, project):
    resp = client.post(
        f"/api/v1/projects/{project['id']}/agent/tasks",
        json={"task_type": "no.such.skill", "input": {}},
    )
    assert resp.status_code == 400


def test_create_task_unknown_project_rejected(client):
    resp = client.post(
        "/api/v1/projects/no-such-project/agent/tasks",
        json={"task_type": "research.trend_analysis", "input": {}},
    )
    assert resp.status_code == 404


def test_trend_analysis_task_completes_with_stub_llm(client, project):
    """A trend_analysis task with a stubbed LLM should complete and persist
    events (including the final 'result' event)."""
    class _Stub:
        def is_configured(self, role): return True
        def chat(self, messages, **kw):
            return '{"evidence": [], "timeline": [{"year": 2020, "event": "x"}]}'

    with _patch_gateway(_Stub()):
        resp = client.post(
            f"/api/v1/projects/{project['id']}/agent/tasks",
            json={"task_type": "research.trend_analysis", "input": {"user_request": "test"}},
        )
    assert resp.status_code == 200, resp.text
    task = resp.json()
    assert task["status"] == "completed"
    assert task["result_json"] is not None
    # Events should include at least the creation + result.
    events = client.get(f"/api/v1/agent/tasks/{task['id']}/events").json()
    kinds = [e["kind"] for e in events]
    assert "step" in kinds  # creation event
    assert "result" in kinds  # final response event


def test_task_with_unconfigured_llm_returns_503(client, project):
    """When no LLM is configured, the API should return 503 (not 500) and the
    task should be persisted in a non-running state so it can be retried.
    """
    # Default test config has no models, so get_gateway returns an empty config.
    resp = client.post(
        f"/api/v1/projects/{project['id']}/agent/tasks",
        json={"task_type": "research.trend_analysis", "input": {"user_request": "x"}},
    )
    assert resp.status_code == 503, resp.text
    assert "default_chat" in resp.json()["detail"]


def test_get_task_404(client):
    assert client.get("/api/v1/agent/tasks/nope").status_code == 404


def test_list_events_404_for_unknown_task(client):
    assert client.get("/api/v1/agent/tasks/nope/events").status_code == 404


def test_approve_unknown_task_404(client):
    resp = client.post(
        "/api/v1/agent/tasks/nope/approve",
        json={"approved": True},
    )
    assert resp.status_code == 404


def test_approve_with_no_pending_approval_404(client, project):
    """Approving a task that has no pending approval should return 404."""
    class _Stub:
        def is_configured(self, role): return True
        def chat(self, messages, **kw): return '{"evidence": []}'

    with _patch_gateway(_Stub()):
        task = client.post(
            f"/api/v1/projects/{project['id']}/agent/tasks",
            json={"task_type": "research.trend_analysis", "input": {}},
        ).json()
    # The task completed without requesting approval, so there's nothing pending.
    resp = client.post(
        f"/api/v1/agent/tasks/{task['id']}/approve",
        json={"approved": True},
    )
    assert resp.status_code == 404


def test_list_approvals_empty_for_completed_task(client, project):
    class _Stub:
        def is_configured(self, role): return True
        def chat(self, messages, **kw): return '{"evidence": []}'

    with _patch_gateway(_Stub()):
        task = client.post(
            f"/api/v1/projects/{project['id']}/agent/tasks",
            json={"task_type": "research.trend_analysis", "input": {}},
        ).json()
    approvals = client.get(f"/api/v1/agent/tasks/{task['id']}/approvals").json()
    assert approvals == []


def test_gateway_error_returns_502_not_500(client, project):
    """H11: when the LLM call itself fails (GatewayError), the API returns 502
    and persists the task's failed status instead of leaving it in 'running'."""
    from app.llm.gateway import GatewayError

    class _Broken:
        def is_configured(self, role): return True
        def chat(self, messages, **kw):
            raise GatewayError("simulated upstream failure")

    with _patch_gateway(_Broken()):
        resp = client.post(
            f"/api/v1/projects/{project['id']}/agent/tasks",
            json={"task_type": "research.trend_analysis", "input": {}},
        )
    assert resp.status_code == 502, resp.text
    # The task should be persisted in a failed state (H11).
    from sqlalchemy import select
    from sqlalchemy.orm import Session

    from app.db.models import AgentTask
    from app.db.session import get_engine

    with Session(get_engine()) as s:
        rows = s.scalars(
            select(AgentTask).where(AgentTask.project_id == project["id"]).order_by(AgentTask.created_at.desc())
        ).all()
    assert rows, "H11: task row not persisted after GatewayError"
    assert rows[0].status == "failed", (
        f"H11: task stuck in '{rows[0].status}' after GatewayError"
    )
