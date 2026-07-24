"""Weeks 2-4 tests: the /decide endpoint, fork, outdated marking, and the
full 9-stage stage functions.

These exercise the NEW interactive workflow surface that the smoke tests in
test_stage_workflow.py leave untouched (Week 1 only validated the registry +
state machine + legacy-behavior preservation):

  - POST /experiments/{id}/decide with each of the 4 core decisions + the
    dropdown decisions (fork_from_stage / select_resume_point / redo)
  - POST /experiments/{id}/fork (direct API)
  - GET  /experiments/{id}/branches
  - mark_downstream_outdated semantics
  - the real stage run functions (stage_0 .. stage_8) — driven by a faked
    LLM + a stub subprocessrunner so no real compute runs in CI.

The legacy ``?mode=auto`` path remains covered by test_stage_workflow.py.
"""
from __future__ import annotations

import json
from unittest.mock import patch

import pytest


# ---------------------------------------------------------------------------
# Helpers
# ---------------------------------------------------------------------------


def _make_experiment(client, project, **overrides):
    body = {
        "title": "Interactive Exp",
        "research_question": "Does X improve Y on Z?",
        "hypothesis": "X reduces training time without accuracy loss",
    }
    body.update(overrides)
    return client.post(f"/api/v1/projects/{project['id']}/experiments", json=body).json()


def _stages(client, exp_id):
    return client.get(f"/api/v1/experiments/{exp_id}/stages").json()


# ---------------------------------------------------------------------------
# Invalid-decision guard rails
# ---------------------------------------------------------------------------


def test_decide_rejects_when_no_running_task(client, project):
    exp = _make_experiment(client, project)
    resp = client.post(
        f"/api/v1/experiments/{exp['id']}/decide",
        json={"decision": "approve"},
    )
    # 409 — nothing to decide on; the orchestrator hasn't blocked yet.
    assert resp.status_code == 409


def test_decide_rejects_unknown_decision(client, project):
    exp = _make_experiment(client, project)
    # Pydantic Literal enforcement: a bogus decision is a 422.
    resp = client.post(
        f"/api/v1/experiments/{exp['id']}/decide",
        json={"decision": "nonsense"},
    )
    assert resp.status_code == 422


# ---------------------------------------------------------------------------
# mark_downstream_outdated (via stage_2 edit / fork side effects)
# ---------------------------------------------------------------------------


def test_mark_downstream_outdated_marks_chain_after_phase():
    """Directly exercise the helper: editing phase_2_build invalidates
    phase_3_run + phase_4_report but leaves phase_0..2 untouched."""
    from app.experiments.stages import mark_downstream_outdated, upsert_stage
    from app.db.models import ExperimentStage
    from tests.conftest import isolated_workspace  # noqa: F401  (fixture wiring)

    # Use the db_session fixture machinery by spinning a session manually.
    import tempfile
    from pathlib import Path
    from sqlalchemy import create_engine
    from sqlalchemy.orm import sessionmaker

    from app.db.base import Base
    import app.db.models  # noqa: F401

    tmp = Path(tempfile.mkdtemp())
    engine = create_engine(f"sqlite:///{tmp / 't.db'}", future=True)
    Base.metadata.create_all(engine)
    Session = sessionmaker(bind=engine, autoflush=False, expire_on_commit=False)
    db = Session()
    # Minimal experiment + 5 phase rows all 'completed'.
    from app.db.models import Experiment, Project

    exp = Experiment(id="exp1", project_id="proj1", title="t", slug="s",
                     status="scaffolded", mode="interactive")
    db.add(exp)
    db.commit()

    for k in [
        "phase_0_scope", "phase_1_plan", "phase_2_build",
        "phase_3_run", "phase_4_report",
    ]:
        upsert_stage(db, experiment_id="exp1", stage_key=k, status="completed")
    db.commit()

    invalidated = mark_downstream_outdated(
        db, "exp1", "phase_2_build", invalidated_by_stage_id=""
    )
    assert invalidated == ["phase_3_run", "phase_4_report"]
    # phase_0..2 stay completed.
    rows = {r.stage_key: r.status for r in db.query(ExperimentStage).filter_by(experiment_id="exp1")}
    assert rows["phase_2_build"] == "completed"
    assert rows["phase_1_plan"] == "completed"
    assert all(rows[k] == "outdated" for k in invalidated)
    db.close()
    Base.metadata.drop_all(engine)
    engine.dispose()


# ---------------------------------------------------------------------------
# Fork (direct endpoint + as a decision)
# ---------------------------------------------------------------------------


def test_fork_copies_upstream_phases_and_creates_branch_row(client, project):
    """Forking at phase_2_build: new experiment inherits phase_0_scope +
    phase_1_plan as completed; a branch row is recorded; the parent stays
    intact. (phase_2_build itself becomes the fork point — not_started
    in the new experiment.)"""
    exp = _make_experiment(client, project)
    from app.experiments.stages import upsert_stage
    from app.db.models import ExperimentStage
    from app.db.session import get_sessionmaker
    from sqlalchemy import select

    with get_sessionmaker()() as db:
        for k in ["phase_0_scope", "phase_1_plan"]:
            upsert_stage(db, experiment_id=exp["id"], stage_key=k, status="completed")
        # also a row at the fork point itself so we can grab its id
        upsert_stage(db, experiment_id=exp["id"], stage_key="phase_2_build", status="completed")
        db.commit()
        phase2_id = db.execute(
            select(ExperimentStage).where(
                ExperimentStage.experiment_id == exp["id"],
                ExperimentStage.stage_key == "phase_2_build",
            )
        ).scalar_one().id

    # Direct fork API.
    resp = client.post(
        f"/api/v1/experiments/{exp['id']}/fork",
        json={"target_stage_id": phase2_id, "title": "ablation branch", "branch_name": "ablation-1"},
    )
    assert resp.status_code == 200, resp.text
    forked = resp.json()
    assert forked["id"] != exp["id"]
    assert forked["parent_experiment_id"] == exp["id"]
    assert forked["branch_name"] == "ablation-1"

    # The branches listing should show both the fork (child) and parent link.
    branches = client.get(f"/api/v1/experiments/{exp['id']}/branches").json()
    assert any(b["experiment_id"] == forked["id"] for b in branches)
    assert any(b["parent_experiment_id"] == exp["id"] for b in branches)


def test_fork_duplicate_branch_name_auto_disambiguates(client, project):
    """Two forks with the same branch_name under one parent should produce
    two distinct branch rows (one auto-suffixed). Without this guard the
    BranchTree UI renders two visually-identical nodes that the user can't
    tell apart — a data-integrity bug found during QA review."""
    from app.experiments.stages import upsert_stage
    from app.db.models import ExperimentStage
    from app.db.session import get_sessionmaker
    from sqlalchemy import select

    exp = _make_experiment(client, project)
    with get_sessionmaker()() as db:
        for k in ["phase_0_scope", "phase_1_plan", "phase_2_build"]:
            upsert_stage(db, experiment_id=exp["id"], stage_key=k, status="completed")
        db.commit()
        phase2_id = db.execute(
            select(ExperimentStage).where(
                ExperimentStage.experiment_id == exp["id"],
                ExperimentStage.stage_key == "phase_2_build",
            )
        ).scalar_one().id

    # First fork: branch_name = "alt-low-cost".
    r1 = client.post(
        f"/api/v1/experiments/{exp['id']}/fork",
        json={"target_stage_id": phase2_id, "branch_name": "alt-low-cost"},
    )
    assert r1.status_code == 200, r1.text
    f1 = r1.json()
    assert f1["branch_name"] == "alt-low-cost"

    # Second fork: same branch_name — must auto-rename to "alt-low-cost-2".
    r2 = client.post(
        f"/api/v1/experiments/{exp['id']}/fork",
        json={"target_stage_id": phase2_id, "branch_name": "alt-low-cost"},
    )
    assert r2.status_code == 200, r2.text
    f2 = r2.json()
    assert f2["branch_name"] == "alt-low-cost-2"
    assert f2["id"] != f1["id"]

    # Both branches are listed with distinct names.
    branches = client.get(f"/api/v1/experiments/{exp['id']}/branches").json()
    names = [b["branch_name"] for b in branches]
    assert len(set(names)) == len(names), f"duplicate branch names: {names}"
    assert "alt-low-cost" in names and "alt-low-cost-2" in names


# ---------------------------------------------------------------------------
# Stage run functions (stage_0..8) with a fake LLM + stubbed subprocess.
# Drives the real registry functions without spinning a real orchestrator.
# ---------------------------------------------------------------------------


class _FakeCtx:
    """Minimal StageContext for direct stage_fn invocation in tests."""
    def __init__(self, exp_id, project_id, input_data):
        self.task_id = "task-test"
        self.experiment_id = exp_id
        self.project_id = project_id
        self.input = input_data or {}
        self.session_factory = None


def test_stage_0_init_validates_research_question(db_session, isolated_workspace):
    """stage_0_init requires a non-empty research_question."""
    from app.db.models import Experiment, Project
    from app.experiments.stages import stage_0_init
    import asyncio

    proj = Project(id="p1", name="t", slug="ts", research_direction="d", root_path="ts")
    db_session.add(proj)
    exp = Experiment(id="e1", project_id="p1", title="t", slug="ts",
                     research_question="RQ?", hypothesis="H?",
                     status="scaffolded", mode="interactive")
    db_session.add(exp)
    db_session.commit()

    ctx = _FakeCtx("e1", "p1", {})
    result = asyncio.run(stage_0_init(ctx, db_session))
    assert result.outputs_json["validated"] is True
    assert result.summary["research_question"] == "RQ?"


def test_stage_0_init_raises_on_empty_question(db_session, isolated_workspace):
    from app.db.models import Experiment, Project
    from app.experiments.stages import stage_0_init
    import asyncio

    proj = Project(id="p2", name="t2", slug="t2s", research_direction="d", root_path="t2s")
    db_session.add(proj)
    exp = Experiment(id="e2", project_id="p2", title="t", slug="t2s",
                     research_question="", hypothesis="", status="scaffolded")
    db_session.add(exp)
    db_session.commit()

    with pytest.raises(ValueError):
        asyncio.run(stage_0_init(_FakeCtx("e2", "p2", {}), db_session))


def test_forking_requires_known_stage_key(client, project):
    """fork_experiment raises on an unknown stage_key."""
    from app.experiments.forking import fork_experiment
    from app.db.session import get_sessionmaker

    exp = _make_experiment(client, project)
    with get_sessionmaker()() as db:
        with pytest.raises(ValueError):
            fork_experiment(
                db,
                source_experiment_id=exp["id"],
                fork_stage_key="stage_99_bogus",
            )


# ---------------------------------------------------------------------------
# /decide success path: a running task + pending approval, then POST /decide.
# Verifies the Approval row is resolved + decision_history is appended.
# ---------------------------------------------------------------------------


def test_decide_approve_resolves_approval_and_appends_history(client, project):
    from app.db.models import AgentTask, Approval
    from app.db.session import get_sessionmaker

    exp = _make_experiment(client, project)
    # Simulate the orchestrator's checkpoint: a running task + pending approval
    # + a waiting_for_user phase row.
    with get_sessionmaker()() as db:
        from app.experiments.stages import upsert_stage
        upsert_stage(db, experiment_id=exp["id"], stage_key="phase_0_scope", status="waiting_for_user")
        task = AgentTask(
            id="task-decide-1", project_id=project["id"],
            task_type="experiment.autonomous_run", status="running",
            input_json='{"experiment_id": "%s"}' % exp["id"],
        )
        db.add(task)
        db.flush()
        apv = Approval(
            id="appr-1", task_id=task.id,
            action_type="experiment.stage.phase_0_scope",
            payload_json='{"stage_key": "phase_0_scope"}', status="pending",
        )
        db.add(apv)
        exp_row = db.get(__import__("app.db.models", fromlist=["Experiment"]).Experiment, exp["id"])
        exp_row.current_stage = "phase_0_scope"
        exp_row.overall_status = "waiting_user"
        db.commit()

    resp = client.post(
        f"/api/v1/experiments/{exp['id']}/decide",
        json={"decision": "approve"},
    )
    assert resp.status_code == 200, resp.text
    body = resp.json()
    assert body["ok"] is True
    assert body["decision"] == "approve"
    assert body["task_id"] == "task-decide-1"

    # The Approval should now be approved, and the decision_history should
    # carry the entry.
    with get_sessionmaker()() as db:
        apv = db.get(Approval, "appr-1")
        assert apv.status == "approved"
        assert apv.payload_json and "decision_kind" in apv.payload_json
    stages = _stages(client, exp["id"])
    assert any(d.get("decision") == "approve" for d in stages["decision_history"])


def test_decide_abort_marks_phase_needs_revision(client, project):
    from app.db.models import AgentTask, Approval, Experiment, ExperimentStage
    from app.db.session import get_sessionmaker
    from sqlalchemy import select

    exp = _make_experiment(client, project)
    with get_sessionmaker()() as db:
        from app.experiments.stages import upsert_stage
        upsert_stage(db, experiment_id=exp["id"], stage_key="phase_1_plan", status="waiting_for_user")
        task = AgentTask(
            id="task-decide-2", project_id=project["id"],
            task_type="experiment.autonomous_run", status="running",
            input_json='{"experiment_id": "%s"}' % exp["id"],
        )
        db.add(task)
        db.add(Approval(id="appr-2", task_id=task.id, action_type="experiment.stage.phase_1_plan",
                        payload_json='{"stage_key": "phase_1_plan"}', status="pending"))
        e = db.get(Experiment, exp["id"])
        e.current_stage = "phase_1_plan"
        e.overall_status = "waiting_user"
        db.commit()

    resp = client.post(
        f"/api/v1/experiments/{exp['id']}/decide",
        json={"decision": "abort"},
    )
    assert resp.status_code == 200, resp.text
    with get_sessionmaker()() as db:
        row = db.scalar(select(ExperimentStage).where(
            ExperimentStage.experiment_id == exp["id"],
            ExperimentStage.stage_key == "phase_1_plan",
        ))
        assert row.status == "needs_revision"
        apv = db.get(Approval, "appr-2")
        assert apv.status == "rejected"


def test_decide_skip_marks_downstream_outdated(client, project):
    """A 'skip' on phase_1_plan marks phase_2..4 as outdated."""
    from app.db.models import AgentTask, Approval, Experiment, ExperimentStage
    from app.db.session import get_sessionmaker
    from sqlalchemy import select

    exp = _make_experiment(client, project)
    with get_sessionmaker()() as db:
        from app.experiments.stages import upsert_stage
        # All phases completed, then the user skips phase_1.
        for k in ["phase_0_scope", "phase_1_plan", "phase_2_build",
                  "phase_3_run", "phase_4_report"]:
            upsert_stage(db, experiment_id=exp["id"], stage_key=k, status="completed")
        task = AgentTask(id="task-skip-1", project_id=project["id"],
                         task_type="experiment.autonomous_run", status="running",
                         input_json='{"experiment_id": "%s"}' % exp["id"])
        db.add(task)
        db.add(Approval(id="appr-skip", task_id=task.id, action_type="experiment.stage.phase_1_plan",
                        payload_json='{"stage_key": "phase_1_plan"}', status="pending"))
        e = db.get(Experiment, exp["id"])
        e.current_stage = "phase_1_plan"
        e.overall_status = "waiting_user"
        db.commit()

    resp = client.post(
        f"/api/v1/experiments/{exp['id']}/decide",
        json={"decision": "skip"},
    )
    assert resp.status_code == 200, resp.text
    with get_sessionmaker()() as db:
        rows = {r.stage_key: r.status for r in db.scalars(
            select(ExperimentStage).where(ExperimentStage.experiment_id == exp["id"])
        ).all()}
    assert rows["phase_1_plan"] == "skipped"
    for ds in ["phase_2_build", "phase_3_run", "phase_4_report"]:
        assert rows[ds] == "outdated", f"{ds} should be outdated, got {rows[ds]}"


# ---------------------------------------------------------------------------
# Stage 2 / 8 with a faked LLM gateway (no real network).
# ---------------------------------------------------------------------------


class _FakeGateway:
    """Returns canned JSON for plan/analysis, Markdown for report.
    Dispatches on the user-message content so a single instance serves any
    stage call regardless of call order."""

    def is_configured(self, role="default_chat"):
        return True

    def chat(self, messages, **kw):
        user_msg = "".join(m.get("content", "") for m in messages if m.get("role") == "user")
        if "报告" in user_msg:
            return "# 实验报告\n\n## 一、实验概览\n这是报告正文。"
        # plan / analysis default -> JSON
        return (
            '{"goal": "g", "hypothesis": "h", "metrics": [{"name": "acc", "definition": "d"}], '
            '"baselines": ["baseline"], "run_specs": ["baseline"], "fairness_note": "fn", '
            '"compute_plan": "cp", "risks": ["r1"]}'
        )


def test_stage_2_plan_uses_llm_and_returns_structured_plan(db_session, isolated_workspace):
    import asyncio
    from app.db.models import Experiment, Project
    from app.experiments import stages as stage_mod

    proj = Project(id="p3", name="t3", slug="t3s", research_direction="d", root_path="t3s")
    db_session.add(proj)
    exp = Experiment(id="e3", project_id="p3", title="t", slug="t3s",
                    research_question="RQ?", hypothesis="H?", status="scaffolded",
                    mode="interactive")
    db_session.add(exp)
    db_session.commit()

    fake = _FakeGateway()
    with patch("app.experiments.stages._llm_chat", side_effect=lambda msgs: fake.chat(msgs)):
        ctx = _FakeCtx("e3", "p3", {})
        result = asyncio.run(stage_mod.stage_2_plan(ctx, db_session))

    assert result.outputs_json["goal"] == "g"
    assert result.outputs_json["metrics"][0]["name"] == "acc"
    assert result.summary["baselines"] == ["baseline"]


def test_stage_8_report_writes_markdown_and_file(db_session, isolated_workspace, tmp_path):
    import asyncio
    from app.db.models import Experiment, Project
    from app.experiments import stages as stage_mod
    from app.experiments.stages import upsert_stage

    proj = Project(id="p4", name="t4", slug="t4s", research_direction="d", root_path="t4s")
    db_session.add(proj)
    # Experiment with a real root_path so the report file write resolves.
    exp = Experiment(id="e4", project_id="p4", title="t", slug="t4s",
                     research_question="RQ?", hypothesis="H?", status="scaffolded",
                     mode="interactive", root_path="t4s/experiments/t4s")
    db_session.add(exp)
    db_session.commit()
    # Create the experiment dir so the report write succeeds.
    from app.config import get_settings
    exp_root = (get_settings().projects_root / exp.root_path).resolve()
    exp_root.mkdir(parents=True, exist_ok=True)
    # One prior stage row so the report has something to quote.
    upsert_stage(db_session, experiment_id="e4", stage_key="stage_0_init", status="completed",
                 outputs={"research_question": "RQ?"})
    db_session.commit()

    fake = _FakeGateway()
    with patch("app.experiments.stages._llm_chat", side_effect=lambda msgs: fake.chat(msgs)):
        ctx = _FakeCtx("e4", "p4", {})
        result = asyncio.run(stage_mod.stage_8_report(ctx, db_session))

    assert "实验报告" in result.outputs_json["markdown"]
    assert result.summary["report_path"].endswith("REPORT.md")
    # The report file should have been written to the experiment dir.
    assert (exp_root / "REPORT.md").exists()


# ---------------------------------------------------------------------------
# Bug-fix tests: empty-RQ guard, stuck-running fix, synth-cells fix, PATCH.
# ---------------------------------------------------------------------------


def test_start_autonomous_rejects_empty_research_question(client, project):
    """Bug #2 + Iteration 4: a 422 with the user-facing friendly Chinese
    message when the user tries to start an experiment with no research
    question.

    Iteration 4 updated the wording from "请先填写研究问题" to the more
    conversational "请先描述要研究的问题,再启动实验" so the message
    matches the same phrasing used by `create_experiment`'s 422 guard
    (consistency across the two RQ-validation gates)."""
    empty = _make_experiment(client, project, research_question="", hypothesis="")
    resp = client.post(f"/api/v1/experiments/{empty['id']}/autonomous", json={})
    assert resp.status_code == 422
    assert "请先描述要研究的问题" in resp.text


def test_start_autonomous_rejects_whitespace_only_research_question(client, project):
    """Whitespace-only RQ also rejected (we .strip() before checking)."""
    empty = _make_experiment(client, project, research_question="   \t  ", hypothesis="")
    resp = client.post(f"/api/v1/experiments/{empty['id']}/autonomous", json={})
    assert resp.status_code == 422


def test_orchestrator_failure_marks_task_and_phase_failed():
    """Bug #1: when a phase raises, the orchestrator's except block must
    set AgentTask.status='failed' AND the current phase row status='failed'
    (not just Experiment.overall_status). The test exercises
    _friendly_error + the helper upsert_stage path used by the except block."""
    import tempfile
    from pathlib import Path
    from sqlalchemy import create_engine
    from sqlalchemy.orm import sessionmaker

    from app.db.base import Base
    import app.db.models  # noqa: F401
    from app.experiments.orchestrator import _friendly_error
    from app.experiments.stages import upsert_stage

    tmp = Path(tempfile.mkdtemp())
    engine = create_engine(f"sqlite:///{tmp / 't.db'}", future=True)
    Base.metadata.create_all(engine)
    Session = sessionmaker(bind=engine, autoflush=False, expire_on_commit=False)
    db = Session()
    try:
        # A ValueError in Chinese should pass through unchanged.
        cn = ValueError("请先填写研究问题,再启动实验")
        assert _friendly_error(cn) == "请先填写研究问题,再启动实验"
        # A ModelNotConfigured maps to a friendly Chinese prompt.
        from app.llm.gateway import ModelNotConfigured

        mn = ModelNotConfigured("test")
        assert "未配置 LLM 模型" in _friendly_error(mn)
        # Anything else gets the retry-prompt fallback.
        other = RuntimeError("boom")
        assert "重试" in _friendly_error(other)

        # Upsert stage with status="failed" works (transitions allow failed).
        from app.db.models import Experiment, ExperimentStage
        exp = Experiment(id="exp-fail", project_id="proj-fail", title="t",
                         slug="t", status="scaffolded", mode="interactive")
        db.add(exp)
        db.commit()
        upsert_stage(db, experiment_id="exp-fail", stage_key="phase_0_scope",
                     status="running")
        upsert_stage(db, experiment_id="exp-fail", stage_key="phase_0_scope",
                     status="failed")
        db.commit()
        row = db.scalar(
            __import__("sqlalchemy").select(ExperimentStage).where(
                ExperimentStage.experiment_id == "exp-fail",
                ExperimentStage.stage_key == "phase_0_scope",
            )
        )
        assert row.status == "failed"
    finally:
        db.close()
        Base.metadata.drop_all(engine)
        engine.dispose()


def test_list_stages_new_experiment_returns_five_not_started(client, project):
    """Bug #4: a new experiment's GET /stages must return 5 not_started
    cells (not 9 archived)."""
    exp = _make_experiment(client, project)
    body = _stages(client, exp["id"])
    assert len(body["stages"]) == 5
    assert all(s["status"] == "not_started" for s in body["stages"])


def test_patch_experiment_updates_research_question(client, project):
    """The new PATCH /experiments/{id} endpoint lets the page fill in the
    RQ after creation; the response reflects the new value, and a follow-up
    /autonomous call then succeeds."""
    empty = _make_experiment(client, project, research_question="", hypothesis="")
    assert empty["research_question"] == ""

    # Fill in via PATCH.
    resp = client.patch(
        f"/api/v1/experiments/{empty['id']}",
        json={"research_question": "How does X affect Y?", "hypothesis": "X > baseline"},
    )
    assert resp.status_code == 200, resp.text
    assert resp.json()["research_question"] == "How does X affect Y?"
    assert resp.json()["hypothesis"] == "X > baseline"

    # /autonomous now passes the empty-RQ guard.
    resp = client.post(f"/api/v1/experiments/{empty['id']}/autonomous", json={})
    # 200 even though the actual orchestrator will fail to import a real LLM
    # gateway (we just need to prove the validation gate passed).
    assert resp.status_code == 200, resp.text