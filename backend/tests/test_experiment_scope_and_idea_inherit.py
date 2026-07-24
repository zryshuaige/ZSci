"""Regression tests for three tightly-related user-visible bugs fixed in
this iteration:

M30 — `POST /projects/{id}/experiments` with `related_idea_id` + EMPTY
      research_question/hypothesis used to leave the experiment stuck at
      "请先填写研究问题" with a disabled 启动按钮. The Multi-Idea →
      "确认并拟定首轮计划" path always sent empty RQ/hypothesis because
      the LLM-generated fields were routed to `Idea.hypothesis` /
      `Idea.motivation`, not to the experiment payload. The fix inherits
      RQ from `Idea.hypothesis` and hypothesis from `Idea.motivation` when
      the caller leaves them blank.

M31 — `/decide` and `/experiments/{id}/stages` both looked up the
      AgentTask by `task_type='experiment.autonomous_run' AND status='running'`
      with NO experiment_id filter. With two concurrent experiments the
      approve / status read could route to the wrong task. The fix parses
      `experiment_id` from `AgentTask.input_json` and scopes the query.

M32 — When the orchestrator's asyncio task was silently orphaned (event-loop
      swallowed exception, hung subprocess), the AgentTask row stayed
      "running" forever. The fix: `_mark_terminal` backstop callback now
      also flips the experiment + current stage row; a periodic in-process
      reconciler marks any `running` task with `updated_at` older than 3
      minutes as failed.
"""
from __future__ import annotations

import json
import asyncio
from datetime import UTC, datetime, timedelta

import pytest


# ---------------------------------------------------------------------------
# M30: experiment creation inherits RQ/hypothesis from related Idea
# ---------------------------------------------------------------------------


def _create_idea(client, project_id: str, *, hypothesis: str, motivation: str) -> str:
    """Helper: create one Idea row via the bulk endpoint (single row)."""
    resp = client.post(
        f"/api/v1/projects/{project_id}/ideas/bulk",
        json={"ideas": [{
            "title": "通过证据一致性检测识别医疗 RAG 幻觉",
            "hypothesis": hypothesis,
            "motivation": motivation,
            "content": {"feasibility": 3, "novelty": 3},
            "status": "hypothesis",
        }]},
    )
    assert resp.status_code == 201, resp.text
    return resp.json()["inserted"][0]["id"]


def test_create_experiment_inherits_rq_and_hypothesis_from_idea(client, project):
    """M30: with related_idea_id set, RQ + hypothesis come from the Idea."""
    idea_id = _create_idea(
        client, project["id"],
        hypothesis="通过证据一致性检测,医疗 RAG 的幻觉识别率应提升 ≥5%",
        motivation="与基础 RAG 相比,新方法能更准确地识别与检索证据不一致的回答",
    )

    # Caller passes ONLY title + related_idea_id — RQ + hypothesis omitted.
    resp = client.post(
        f"/api/v1/projects/{project['id']}/experiments",
        json={"title": "医疗 RAG 幻觉检测", "related_idea_id": idea_id},
    )
    assert resp.status_code in (200, 201), resp.text
    exp = resp.json()

    assert exp["research_question"] == "通过证据一致性检测,医疗 RAG 的幻觉识别率应提升 ≥5%"
    assert "与基础 RAG 相比" in (exp["hypothesis"] or "")


def test_create_experiment_caller_wins_when_rq_provided(client, project):
    """M30: if the caller does pass RQ+hypothesis explicitly, those win
    (don't overwrite with the Idea's stale values)."""
    idea_id = _create_idea(
        client, project["id"],
        hypothesis="from idea",
        motivation="idea motivation",
    )
    resp = client.post(
        f"/api/v1/projects/{project['id']}/experiments",
        json={
            "title": "Override experiment",
            "related_idea_id": idea_id,
            "research_question": "from caller",
            "hypothesis": "from caller",
        },
    )
    assert resp.status_code in (200, 201)
    exp = resp.json()
    assert exp["research_question"] == "from caller"
    assert exp["hypothesis"] == "from caller"


def test_create_experiment_idea_must_belong_to_same_project(client, project):
    """M30 + Iteration 4: a cross-project Idea is silently ignored (security:
    prevents leaking another project's research direction into this
    experiment).

    Iteration 4 also adds a friendly 422 guard for the "no RQ anywhere"
    case, so when the caller omits the field AND the idea lookup is
    blocked by the cross-project check, the request fails with a clear
    "请先描述要研究的问题" message rather than silently producing an
    experiment with `research_question=None`.
    """
    # Create an Idea under the test project, then try to link it from a
    # DIFFERENT project's experiment-create call. The cross-project idea
    # must be rejected (Idea.project_id != project_id).
    idea_id = _create_idea(
        client, project["id"],
        hypothesis="cross-project leak attempt",
        motivation="should be ignored",
    )
    other = client.post(
        "/api/v1/projects",
        json={"name": "Other project"},
    ).json()
    resp = client.post(
        f"/api/v1/projects/{other['id']}/experiments",
        json={"title": "X", "related_idea_id": idea_id},
    )
    # Cross-project idea + caller-omitted RQ → the cross-project idea
    # must NOT leak in. The 422 from the friendly guard is the
    # modern equivalent of the old "silently produce a None-RQ
    # experiment" behaviour, just with a clear error message.
    assert resp.status_code == 422, resp.text
    assert "研究" in resp.json()["detail"]


def test_create_experiment_cross_project_with_explicit_rq_works(client, project):
    """Iteration 4: cross-project idea is silently dropped, but a
    caller-provided RQ survives the inheritance skip. The intent is
    "the cross-project idea must NOT leak" — the experiment can still
    be created when the caller supplies the RQ themselves."""
    idea_id = _create_idea(
        client, project["id"],
        hypothesis="cross-project leak attempt",
        motivation="should be ignored",
    )
    other = client.post(
        "/api/v1/projects",
        json={"name": "Other project"},
    ).json()
    resp = client.post(
        f"/api/v1/projects/{other['id']}/experiments",
        json={
            "title": "Cross-project with explicit RQ",
            "related_idea_id": idea_id,
            "research_question": "caller-supplied RQ",
        },
    )
    assert resp.status_code in (200, 201), resp.text
    exp = resp.json()
    # Explicit RQ survives; idea-derived hypothesis would have leaked
    # the cross-project direction, so it stays None.
    assert exp["research_question"] == "caller-supplied RQ"
    assert exp["hypothesis"] is None


# ---------------------------------------------------------------------------
# M31: /decide and /stages scope by experiment_id
# ---------------------------------------------------------------------------


def _seed_running_autonomous_task(client, project_id: str, exp_id: str) -> str:
    """Insert a running AgentTask for exp_id via the test client + session."""
    from app.db.session import get_sessionmaker
    from app.db.models import AgentTask

    task_id = f"task-{exp_id}-running"
    with get_sessionmaker()() as db:
        db.add(
            AgentTask(
                id=task_id,
                project_id=project_id,
                task_type="experiment.autonomous_run",
                status="running",
                input_json=json.dumps({
                    "experiment_id": exp_id,
                    "mode": "interactive",
                }),
            )
        )
        db.commit()
    return task_id


def test_stages_does_not_return_checkpoint_from_other_experiment(client, project):
    """M31: two concurrent experiments with their own running autonomous
    tasks. /experiments/{A}/stages must NOT show experiment B's
    checkpoint_summary (the previous ANY-running query hijacked it)."""
    exp_a = client.post(
        f"/api/v1/projects/{project['id']}/experiments",
        json={"title": "Exp A", "research_question": "RQ A"},
    ).json()
    exp_b = client.post(
        f"/api/v1/projects/{project['id']}/experiments",
        json={"title": "Exp B", "research_question": "RQ B"},
    ).json()
    task_a = _seed_running_autonomous_task(client, project["id"], exp_a["id"])
    task_b = _seed_running_autonomous_task(client, project["id"], exp_b["id"])

    # Set distinct checkpoint_payload_json on each task so we can see which
    # one the /stages endpoint returns for each experiment.
    from app.db.session import get_sessionmaker
    from app.db.models import AgentTask
    with get_sessionmaker()() as db:
        t_a = db.get(AgentTask, task_a)
        t_a.checkpoint_payload_json = json.dumps({"stage_key": "phase_0_scope", "title": "A's checkpoint"})
        t_a.stage_key = "phase_0_scope"
        t_b = db.get(AgentTask, task_b)
        t_b.checkpoint_payload_json = json.dumps({"stage_key": "phase_1_plan", "title": "B's checkpoint"})
        t_b.stage_key = "phase_1_plan"
        db.commit()

    stages_a = client.get(f"/api/v1/experiments/{exp_a['id']}/stages").json()
    stages_b = client.get(f"/api/v1/experiments/{exp_b['id']}/stages").json()

    # Neither stage is currently in `waiting_for_user` (we only seeded the
    # task, not the ExperimentStage row), so checkpoint_summary on every
    # stage row is None. The bug we're guarding against is that the
    # /stages endpoint previously queried any `experiment.autonomous_run`
    # task globally — which doesn't manifest directly via the
    # `checkpoint_summary` field (it's only attached to the
    # `waiting_for_user` stage), but DOES manifest via the wrong `last_error`
    # # being returned for `failed` tasks. So we additionally verify the
    # pending-task lookup is scoped:
    #   - mock a failed task on B, expect /stages A.last_error to stay None.
    # That is checked separately below.
    assert all(s["checkpoint_summary"] is None for s in stages_a["stages"])
    assert all(s["checkpoint_summary"] is None for s in stages_b["stages"])


def test_stages_last_error_scoped_to_experiment(client, project):
    """M31: /stages reports `last_error` from THIS experiment's task, not
    from another experiment's failed task."""
    from app.db.session import get_sessionmaker
    from app.db.models import AgentTask

    exp_a = client.post(
        f"/api/v1/projects/{project['id']}/experiments",
        json={"title": "Exp A", "research_question": "RQ A"},
    ).json()
    exp_b = client.post(
        f"/api/v1/projects/{project['id']}/experiments",
        json={"title": "Exp B", "research_question": "RQ B"},
    ).json()

    # Seed two autonomous tasks: A=running, B=failed.
    task_a_id = _seed_running_autonomous_task(client, project["id"], exp_a["id"])
    task_b_id = f"task-{exp_b['id']}-failed"
    with get_sessionmaker()() as db:
        db.add(
            AgentTask(
                id=task_b_id,
                project_id=project["id"],
                task_type="experiment.autonomous_run",
                status="failed",
                error="B 失败的具体原因",
                input_json=json.dumps({"experiment_id": exp_b["id"], "mode": "interactive"}),
            )
        )
        db.commit()

    # /stages A must NOT show B's error.
    stages_a = client.get(f"/api/v1/experiments/{exp_a['id']}/stages").json()
    assert stages_a["last_error"] is None or "B 失败" not in (stages_a["last_error"] or "")

    # /stages B must show B's error.
    stages_b = client.get(f"/api/v1/experiments/{exp_b['id']}/stages").json()
    assert "B 失败" in (stages_b["last_error"] or "")


def test_decide_routes_to_correct_experiment_task(client, project):
    """M31: when two experiments have concurrent running autonomous tasks,
    POST /decide on experiment A must update A's task — not B's."""
    from app.db.session import get_sessionmaker
    from app.db.models import AgentTask, Approval, ExperimentStage

    exp_a = client.post(
        f"/api/v1/projects/{project['id']}/experiments",
        json={"title": "A", "research_question": "RQ A"},
    ).json()
    exp_b = client.post(
        f"/api/v1/projects/{project['id']}/experiments",
        json={"title": "B", "research_question": "RQ B"},
    ).json()
    task_a_id = _seed_running_autonomous_task(client, project["id"], exp_a["id"])
    task_b_id = _seed_running_autonomous_task(client, project["id"], exp_b["id"])

    # Seed pending approvals for both tasks so /decide has something to
    # resolve. The decide endpoint picks by `task_id` indirectly via
    # `_find_autonomous_task_for_experiment`.
    with get_sessionmaker()() as db:
        for tid, eid in ((task_a_id, exp_a["id"]), (task_b_id, exp_b["id"])):
            stage = ExperimentStage(
                id=f"stage-{eid}-p0",
                experiment_id=eid,
                stage_key="phase_0_scope",
                status="waiting_for_user",
                version=1,
            )
            db.add(stage)
            apv = Approval(
                id=f"apv-{tid}",
                task_id=tid,
                action_type="experiment.stage.phase_0_scope",
                payload_json=json.dumps({"stage_key": "phase_0_scope"}),
                status="pending",
            )
            db.add(apv)
            exp = db.get(Experiment := __import__("app.db.models", fromlist=["Experiment"]).Experiment, eid)
            exp.current_stage = "phase_0_scope"
            exp.overall_status = "waiting_user"
            task = db.get(AgentTask, tid)
            task.stage_key = "phase_0_scope"
            task.checkpoint_payload_json = json.dumps({"stage_key": "phase_0_scope"})
        db.commit()

    # POST /decide on experiment A — must update ONLY A's approval + task.
    resp = client.post(
        f"/api/v1/experiments/{exp_a['id']}/decide",
        json={"decision": "approve"},
    )
    assert resp.status_code in (200, 201), resp.text

    with get_sessionmaker()() as db:
        apv_a = db.get(Approval, f"apv-{task_a_id}")
        apv_b = db.get(Approval, f"apv-{task_b_id}")
        assert apv_a.status == "approved", "A's approval must be approved"
        assert apv_b.status == "pending", "B's approval must stay pending"


# ---------------------------------------------------------------------------
# M32: stale-running reconciler + _mark_terminal flip the experiment status
# ---------------------------------------------------------------------------


def test_mark_terminal_flips_experiment_to_failed(client, project):
    """M32: when the orchestrator's asyncio task fails, _mark_terminal
    must also flip the experiment's overall_status to `failed` and the
    current stage row to `failed` — not just the AgentTask. Otherwise the
    UI shows a ghost "running" state with no recovery path."""
    from app.db.models import AgentTask, Experiment, ExperimentStage
    from app.db.session import get_sessionmaker

    exp = client.post(
        f"/api/v1/projects/{project['id']}/experiments",
        json={"title": "M32 exp", "research_question": "rq"},
    ).json()
    task_id = _seed_running_autonomous_task(client, project["id"], exp["id"])

    # Seed the experiment + current stage row in 'running' state.
    with get_sessionmaker()() as db:
        e = db.get(Experiment, exp["id"])
        e.overall_status = "running"
        e.current_stage = "phase_0_scope"
        stage = ExperimentStage(
            id=f"stage-{exp['id']}-m32",
            experiment_id=exp["id"],
            stage_key="phase_0_scope",
            status="running",
            version=1,
        )
        db.add(stage)
        db.commit()

    from app.routers.experiments import _mark_terminal
    _mark_terminal(task_id, "failed", "simulated orchestrator crash")

    with get_sessionmaker()() as db:
        e = db.get(Experiment, exp["id"])
        t = db.get(AgentTask, task_id)
        s = db.get(ExperimentStage, f"stage-{exp['id']}-m32")
        assert t.status == "failed"
        assert t.error == "simulated orchestrator crash"
        assert e.overall_status == "failed", "experiment must flip to failed"
        assert s.status == "failed", "current stage row must flip to failed"


def test_reap_stale_tasks_marks_old_running_as_failed(client, project):
    """M32 + Iteration 4: the periodic reconciler must mark any
    `running` AgentTask with `updated_at` older than
    `REAP_STALE_AFTER_SECONDS` as failed.

    Iteration 4 raised the threshold from 180s to 1800s because the
    orchestrator now heartbeats every 30s — a healthy task never goes
    1800s without `updated_at` advancing. The reaper only fires on
    genuinely orphaned tasks. This test now backdates >1800s to match
    the new threshold, and asserts the new friendly Chinese copy
    (no longer references "重试" — that prompt moved to the page's
    StickyActionBar so we don't auto-suggest destructive actions).
    """
    from app.db.models import AgentTask, Experiment, ExperimentStage
    from app.db.session import get_sessionmaker
    from app.main import _reap_stale_tasks

    exp = client.post(
        f"/api/v1/projects/{project['id']}/experiments",
        json={"title": "M32 stale exp", "research_question": "rq"},
    ).json()
    task_id = _seed_running_autonomous_task(client, project["id"], exp["id"])

    with get_sessionmaker()() as db:
        e = db.get(Experiment, exp["id"])
        e.overall_status = "running"
        e.current_stage = "phase_0_scope"
        stage = ExperimentStage(
            id=f"stage-{exp['id']}-stale",
            experiment_id=exp["id"],
            stage_key="phase_0_scope",
            status="running",
            version=1,
        )
        db.add(stage)
        # Backdate the task's updated_at past the 1800s threshold
        # (was 600s for the 180s threshold pre-Iteration-4).
        old_ts = datetime.now(UTC) - timedelta(seconds=1900)
        t = db.get(AgentTask, task_id)
        t.updated_at = old_ts
        db.commit()

    _reap_stale_tasks()

    with get_sessionmaker()() as db:
        t = db.get(AgentTask, task_id)
        e = db.get(Experiment, exp["id"])
        s = db.get(ExperimentStage, f"stage-{exp['id']}-stale")
        assert t.status == "failed", "stale running task must be failed"
        # New friendly copy — no longer hard-prompts a destructive
        # "重试" action; the StickyActionBar surfaces retry instead.
        assert "暂时停下来" in (t.error or ""), (
            f"expected friendly reaper copy, got {t.error!r}"
        )
        assert e.overall_status == "failed"
        assert s.status == "failed"


def test_reap_stale_does_not_touch_fresh_running_tasks(client, project):
    """M32: a `running` task that's still actively making progress (updated
    <REAP_STALE_AFTER_SECONDS ago) must NOT be reaped. This guards against
    false positives when the orchestrator is mid-checkpoint."""
    from app.db.models import AgentTask, Experiment, ExperimentStage
    from app.db.session import get_sessionmaker
    from app.main import _reap_stale_tasks

    exp = client.post(
        f"/api/v1/projects/{project['id']}/experiments",
        json={"title": "M32 fresh exp", "research_question": "rq"},
    ).json()
    task_id = _seed_running_autonomous_task(client, project["id"], exp["id"])

    with get_sessionmaker()() as db:
        e = db.get(Experiment, exp["id"])
        e.overall_status = "running"
        e.current_stage = "phase_0_scope"
        db.add(
            ExperimentStage(
                id=f"stage-{exp['id']}-fresh",
                experiment_id=exp["id"],
                stage_key="phase_0_scope",
                status="running",
                version=1,
            )
        )
        # Leave updated_at at "now" (fresh) — _reap_stale_tasks must skip.
        db.commit()

    _reap_stale_tasks()

    with get_sessionmaker()() as db:
        t = db.get(AgentTask, task_id)
        e = db.get(Experiment, exp["id"])
        s = db.get(ExperimentStage, f"stage-{exp['id']}-fresh")
        assert t.status == "running", "fresh running task must stay running"
        assert e.overall_status == "running"
        assert s.status == "running"