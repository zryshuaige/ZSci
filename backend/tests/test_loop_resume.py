"""Loop resumability tests (R2.3): a checkpoint written by a previous
process survives and the relaunched loop continues without re-running
already-finished phases.

Scenarios:
  1. decide-after-restart: task parked at awaiting_approval, no live loop.
     POST /decide relaunches the loop, which adopts the decision and runs
     the NEXT phase (never re-running the parked one).
  2. startup recovery: a task with a pending approval is kept alive
     (awaiting_approval), a task without one is stopped + recoverable.
"""
from __future__ import annotations

import json
from dataclasses import replace
from unittest.mock import patch

import pytest


def _make_experiment(client, project):
    resp = client.post(
        f"/api/v1/projects/{project['id']}/experiments",
        json={"title": "Resume Exp", "research_question": "Does X improve Y?"},
    )
    assert resp.status_code in (200, 201), resp.text
    return resp.json()


def _stub_registry(calls: list[str]):
    """Patch every phase's run_fn with a recorder stub. Returns the original
    registry for restoration."""
    from app.experiments.stages import STAGE_REGISTRY, StageResult

    original = dict(STAGE_REGISTRY)

    def make_stub(key):
        async def _run(ctx, db):
            calls.append(key)
            return StageResult(summary={"title": f"stub {key}"}, outputs_json={"stub": key})
        return _run

    for key, sd in STAGE_REGISTRY.items():
        STAGE_REGISTRY[key] = replace(sd, run_fn=make_stub(key))
    return original


def _restore_registry(original):
    from app.experiments.stages import STAGE_REGISTRY
    STAGE_REGISTRY.clear()
    STAGE_REGISTRY.update(original)


def _seed_parked_checkpoint(client, project, exp, phase_key):
    """Simulate a checkpoint left by a dead process."""
    from app.db.models import AgentTask, Approval, Experiment
    from app.db.session import get_sessionmaker
    from app.experiments.stages import upsert_stage

    with get_sessionmaker()() as db:
        # phase_0 completed, `phase_key` waiting for user.
        upsert_stage(db, experiment_id=exp["id"], stage_key="phase_0_scope", status="completed")
        upsert_stage(db, experiment_id=exp["id"], stage_key=phase_key, status="waiting_for_user")
        task = AgentTask(
            id="task-resume-1",
            project_id=project["id"],
            task_type="experiment.autonomous_run",
            experiment_id=exp["id"],
            status="awaiting_approval",
            input_json=json.dumps({"experiment_id": exp["id"], "mode": "interactive"}),
        )
        db.add(task)
        db.add(Approval(
            id="appr-resume-1",
            task_id=task.id,
            action_type=f"experiment.stage.{phase_key}",
            payload_json=json.dumps({"stage_key": phase_key}),
            status="pending",
        ))
        e = db.get(Experiment, exp["id"])
        e.current_stage = phase_key
        e.overall_status = "waiting_user"
        db.commit()


def _wait_terminal(client, task_id, timeout=10.0):
    import time
    deadline = time.monotonic() + timeout
    t = None
    while time.monotonic() < deadline:
        t = client.get(f"/api/v1/agent/tasks/{task_id}").json()
        if t["status"] in ("completed", "failed", "stopped", "rejected"):
            return t
        time.sleep(0.1)
    raise AssertionError(f"task did not reach terminal state: {t['status']}")


def _drive_to_completion(client, exp_id, task_id, decision="approve", max_decisions=8):
    """Approve every checkpoint the (relaunched) loop opens, until the task
    reaches a terminal state."""
    import time

    for _ in range(max_decisions):
        deadline = time.monotonic() + 10
        while time.monotonic() < deadline:
            t = client.get(f"/api/v1/agent/tasks/{task_id}").json()
            if t["status"] in ("completed", "failed", "stopped", "rejected"):
                return t
            if t["status"] == "awaiting_approval":
                resp = client.post(
                    f"/api/v1/experiments/{exp_id}/decide",
                    json={"decision": decision},
                )
                assert resp.status_code == 200, resp.text
                break
            time.sleep(0.05)
        else:
            raise AssertionError("loop stalled: neither terminal nor awaiting decision")
    raise AssertionError("too many decisions — loop did not converge")


def test_decide_after_restart_resumes_without_rerunning(client, project):
    """Park at phase_1_plan (simulating a dead process), decide approve —
    the relaunched loop must NOT re-run phase_0 (completed) or phase_1
    (parked), and must run phase_2..4 to completion (approving each new
    checkpoint)."""
    exp = _make_experiment(client, project)
    _seed_parked_checkpoint(client, project, exp, "phase_1_plan")
    calls: list[str] = []
    original = _stub_registry(calls)
    try:
        resp = client.post(
            f"/api/v1/experiments/{exp['id']}/decide",
            json={"decision": "approve"},
        )
        assert resp.status_code == 200, resp.text
        task_id = resp.json()["task_id"]
        final = _drive_to_completion(client, exp["id"], task_id)
        assert final["status"] == "completed"

        from app.db.session import get_sessionmaker
        from app.db.models import Experiment
        with get_sessionmaker()() as db:
            e = db.get(Experiment, exp["id"])
            assert e.overall_status == "completed"
    finally:
        _restore_registry(original)

    # phase_0 (completed before) and phase_1 (parked, not re-run) are absent;
    # only the post-checkpoint phases ran (once each — no re-runs).
    assert "phase_0_scope" not in calls
    assert "phase_1_plan" not in calls
    assert calls == ["phase_2_build", "phase_3_run", "phase_4_report"]


def test_decide_skip_after_restart_marks_downstream(client, project):
    """Skip decision on a parked checkpoint: the parked phase is marked
    skipped, downstream phases run afterwards."""
    exp = _make_experiment(client, project)
    _seed_parked_checkpoint(client, project, exp, "phase_1_plan")
    calls: list[str] = []
    original = _stub_registry(calls)
    try:
        resp = client.post(
            f"/api/v1/experiments/{exp['id']}/decide",
            json={"decision": "skip"},
        )
        assert resp.status_code == 200, resp.text
        _drive_to_completion(client, exp["id"], resp.json()["task_id"])

        from app.db.session import get_sessionmaker
        from app.db.models import Experiment, ExperimentStage
        with get_sessionmaker()() as db:
            rows = {
                r.stage_key: r.status
                for r in db.scalars(
                    __import__("sqlalchemy").select(ExperimentStage).where(
                        ExperimentStage.experiment_id == exp["id"]
                    )
                ).all()
            }
            assert rows["phase_1_plan"] == "skipped"
    finally:
        _restore_registry(original)
    assert calls == ["phase_2_build", "phase_3_run", "phase_4_report"]


def test_startup_recovery_keeps_parked_checkpoints(client, project):
    """_reap_orphan_workflow_state keeps tasks with pending approvals alive
    (awaiting_approval) and marks the others stopped + recoverable."""
    from app.db.models import AgentTask, Approval
    from app.db.session import get_sessionmaker
    from app.main import _reap_orphan_workflow_state

    with get_sessionmaker()() as db:
        db.add(AgentTask(
            id="task-parked", project_id=project["id"],
            task_type="experiment.autonomous_run", status="running",
            input_json=json.dumps({"experiment_id": "exp-x"}),
        ))
        db.add(AgentTask(
            id="task-dead", project_id=project["id"],
            task_type="research.trend_analysis", status="running",
        ))
        db.flush()
        db.add(Approval(id="appr-parked", task_id="task-parked",
                        action_type="experiment.stage.phase_0_scope",
                        payload_json='{"stage_key": "phase_0_scope"}', status="pending"))
        db.commit()

    # No live loops in this process → both go through the recovery path.
    from app.agent import dispatch
    with patch.object(dispatch, "is_live", return_value=False):
        with patch("app.experiments.orchestrator.relaunch_experiment_loop", return_value=False):
            resumable = _reap_orphan_workflow_state()

    with get_sessionmaker()() as db:
        parked = db.get(AgentTask, "task-parked")
        dead = db.get(AgentTask, "task-dead")
        assert parked.status == "awaiting_approval"
        assert dead.status == "stopped"
        assert "重试" in (dead.error or "")
    assert resumable == ["task-parked"]


def test_start_autonomous_rejects_second_live_task(client, project):
    """Concurrency guard (bug found in smoke testing): a duplicated/retried
    POST /autonomous must 409 while another autonomous task for the SAME
    experiment is live (running or awaiting_approval) — otherwise the
    newest-first task lookup shadows the pending checkpoint and /decide
    bricks."""
    exp = _make_experiment(client, project)
    _seed_parked_checkpoint(client, project, exp, "phase_1_plan")

    resp = client.post(
        f"/api/v1/experiments/{exp['id']}/autonomous?mode=interactive", json={}
    )
    assert resp.status_code == 409, resp.text


def test_decide_prefers_awaiting_task_over_newer_failed(client, project):
    """Legacy duplicate rows (from before the guard): an older
    awaiting_approval task must not be shadowed by a NEWER failed task —
    /decide has to find the parked one."""
    from app.db.models import AgentTask
    from app.db.session import get_sessionmaker

    exp = _make_experiment(client, project)
    _seed_parked_checkpoint(client, project, exp, "phase_1_plan")
    with get_sessionmaker()() as db:
        # A newer, failed task for the same experiment (the duplicate that
        # used to brick /decide).
        db.add(AgentTask(
            id="task-dup-failed", project_id=project["id"],
            task_type="experiment.autonomous_run", experiment_id=exp["id"],
            status="failed", error="未配置 LLM 模型",
            input_json=json.dumps({"experiment_id": exp["id"]}),
        ))
        db.commit()

    calls: list[str] = []
    original = _stub_registry(calls)
    try:
        resp = client.post(
            f"/api/v1/experiments/{exp['id']}/decide",
            json={"decision": "approve"},
        )
        assert resp.status_code == 200, resp.text
        final = _drive_to_completion(client, exp["id"], resp.json()["task_id"])
    finally:
        _restore_registry(original)
    # The parked task's checkpoint was adopted; remaining phases ran.
    assert final["status"] == "completed"
    assert calls == ["phase_2_build", "phase_3_run", "phase_4_report"]
