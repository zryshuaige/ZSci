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
