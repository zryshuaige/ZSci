"""Smoke tests for the 5-phase interactive workflow.

The 5 phases (`phase_0_scope` → `phase_4_report`) each compose one or more
of the 9 atomic step functions (`stage_0_init` … `stage_8_report`); the
orchestrator walks only the 5 phases and checkpoints once per phase.

Verifies the foundational pieces that don't involve the autonomous
orchestrator:
  - the registry has exactly 5 phases with the right keys
  - the dependency DAG is a linear chain (no cycles, no jumps)
  - policy flags (requires_user / optional_user) are set sensibly
  - STAGE_TRANSITIONS allows the common moves and rejects illegal ones
  - downstream_of() returns the correct transitive set
  - GET /experiments/{id}/stages returns a 5-cell array of "not_started"
    placeholders for new experiments (not 9 archived placeholders — that
    was bug #4 reported by the user).
"""
from __future__ import annotations


def test_stage_registry_has_five_phases():
    from app.experiments.states import STAGE_KEYS
    assert len(STAGE_KEYS) == 5
    assert STAGE_KEYS == (
        "phase_0_scope",
        "phase_1_plan",
        "phase_2_build",
        "phase_3_run",
        "phase_4_report",
    )


def test_stage_registry_supports_all_keys():
    from app.experiments.stages import STAGE_REGISTRY
    from app.experiments.states import STAGE_KEYS
    for k in STAGE_KEYS:
        assert k in STAGE_REGISTRY, f"phase {k!r} not in registry"
        sd = STAGE_REGISTRY[k]
        assert sd.run_fn is not None, f"phase {k!r} has no run_fn"
        assert sd.name_zh, f"phase {k!r} has no Chinese name"


def test_stage_dependency_graph_is_linear_chain():
    """No cycles; each phase depends on exactly its predecessor (or
    nothing for phase 0)."""
    from app.experiments.states import STAGE_KEYS, STAGE_DEPENDS_ON

    assert STAGE_DEPENDS_ON["phase_0_scope"] == ()
    for prev, cur in zip(STAGE_KEYS, STAGE_KEYS[1:]):
        assert STAGE_DEPENDS_ON[cur] == (prev,), (
            f"{cur} should depend on {prev} but depends on {STAGE_DEPENDS_ON[cur]}"
        )


def test_checkpoint_policy_is_sensible():
    """All 5 phases pause for user review — the workflow is human-driven."""
    from app.experiments.states import STAGE_KEYS, STAGE_POLICY

    for k in STAGE_KEYS:
        assert STAGE_POLICY[k]["requires_user"], f"{k} should require user"
        assert STAGE_POLICY[k]["optional_user"] is False, (
            f"{k} should not be optional_user"
        )


def test_downstream_of_returns_transitive_chain():
    from app.experiments.states import STAGE_KEYS, downstream_of

    assert downstream_of("phase_0_scope") == [
        "phase_1_plan", "phase_2_build", "phase_3_run", "phase_4_report",
    ]
    # Phase 4 has no downstream.
    assert downstream_of("phase_4_report") == []
    # Mid-graph phase returns the chain after it.
    assert downstream_of("phase_2_build") == ["phase_3_run", "phase_4_report"]
    # All 5 phase keys are covered.
    assert set(STAGE_KEYS) == {
        "phase_0_scope", "phase_1_plan", "phase_2_build",
        "phase_3_run", "phase_4_report",
    }


def test_stage_transitions_allow_common_moves():
    from app.experiments.states import assert_stage_transition

    # Lifecycle: not_started -> running -> completed is OK.
    assert_stage_transition("not_started", "running")
    assert_stage_transition("running", "completed")
    assert_stage_transition("running", "paused")
    assert_stage_transition("paused", "running")
    assert_stage_transition("completed", "outdated")
    assert_stage_transition("waiting_for_user", "approved")
    assert_stage_transition("waiting_for_user", "needs_revision")


def test_stage_transitions_reject_illegal_moves():
    import pytest

    from app.experiments.states import InvalidTransition, assert_stage_transition

    # Archived is terminal.
    with pytest.raises(InvalidTransition):
        assert_stage_transition("archived", "running")
    # Unknown source.
    with pytest.raises(InvalidTransition):
        assert_stage_transition("garbage", "running")
    # not_started can't go straight to completed.
    with pytest.raises(InvalidTransition):
        assert_stage_transition("not_started", "completed")


def test_experiment_status_transitions():
    import pytest

    from app.experiments.states import (
        InvalidTransition,
        assert_exp_transition,
    )

    assert_exp_transition("draft", "running")
    assert_exp_transition("running", "paused")
    assert_exp_transition("paused", "running")
    assert_exp_transition("running", "waiting_user")
    assert_exp_transition("waiting_user", "running")
    assert_exp_transition("running", "completed")
    with pytest.raises(InvalidTransition):
        assert_exp_transition("archived", "running")


def test_orchestrator_dispatch_table_exposes_pause_resume_helpers():
    """The orchestrator module exposes the pause/resume/stop helpers that
    the new /decide endpoint will call. They don't need to do anything
    (no in-flight task) but the imports must be wired up."""
    from app.experiments.orchestrator import (
        pause_experiment,
        resume_experiment,
        stop_experiment,
    )
    # Stop / resume / pause on a never-registered task_id should not raise.
    pause_experiment("nonexistent_task")
    resume_experiment("nonexistent_task")
    stop_experiment("nonexistent_task")


def test_set_overall_status_idempotent_write_still_advances_current_stage():
    """Regression: `_set_overall_status` must NOT bail when asked to write the
    SAME status it already holds - the orchestrator re-affirms "running"
    between phases and rides a `current_stage` advance on those calls. The
    `decide_stage` endpoint also sets overall_status="running" synchronously
    on approve, so the orchestrator's next `_set_overall_status("running",
    current_stage=next_phase)` is a same-status write. If that bails,
    `current_stage` never advances and the stepper/hero keep pointing at the
    just-approved phase. Only a genuinely illegal *change* should bail."""
    import tempfile
    from pathlib import Path
    from sqlalchemy import create_engine
    from sqlalchemy.orm import sessionmaker

    from app.db.base import Base
    import app.db.models  # noqa: F401
    from app.db.models import Experiment
    from app.experiments.orchestrator import _set_overall_status

    tmp = Path(tempfile.mkdtemp())
    engine = create_engine(f"sqlite:///{tmp / 't.db'}", future=True)
    Base.metadata.create_all(engine)
    Session = sessionmaker(bind=engine, autoflush=False, expire_on_commit=False)
    db = Session()
    try:
        exp = Experiment(id="exp-oidem", project_id="proj1", title="t", slug="s",
                         status="scaffolded", mode="interactive",
                         overall_status="running", current_stage="phase_0_scope")
        db.add(exp)
        db.commit()

        # Same-status write ("running" -> "running") with a new current_stage.
        # Before the fix this early-returned and left current_stage untouched.
        _set_overall_status(db, "exp-oidem", "running", current_stage="phase_1_plan")
        db.commit()
        db.refresh(exp)
        assert exp.overall_status == "running"
        assert exp.current_stage == "phase_1_plan", (
            f"idempotent write dropped current_stage advance: {exp.current_stage}"
        )

        # A genuinely illegal *change* still bails (no crash, no write).
        # "running" -> "draft" is not in EXP_TRANSITIONS (running can only
        # go to paused/waiting_user/completed/failed/archived).
        _set_overall_status(db, "exp-oidem", "draft", current_stage="phase_2_build")
        db.commit()
        db.refresh(exp)
        assert exp.overall_status == "running", "illegal change should not have written"
        assert exp.current_stage == "phase_1_plan", "illegal change should not advance stage"
    finally:
        db.close()
        Base.metadata.drop_all(engine)
        engine.dispose()


def test_get_stages_for_legacy_experiment_synthesizes_five_not_started_cells(client, project):
    """A brand-new experiment has no experiment_stages rows; GET /stages
    should still return 5 cells in `not_started` status (NOT 9 archived —
    that was bug #4 where the page looked like all stages were already
    done)."""
    old = client.post(
        f"/api/v1/projects/{project['id']}/experiments",
        json={"title": "Legacy Exp", "research_question": "rq", "hypothesis": "h"},
    ).json()
    resp = client.get(f"/api/v1/experiments/{old['id']}/stages")
    assert resp.status_code == 200, resp.text
    body = resp.json()
    assert body["experiment_id"] == old["id"]
    assert len(body["stages"]) == 5
    # New behaviour: 5 `not_started` cells (was 9 `archived`).
    assert all(s["status"] == "not_started" for s in body["stages"])
    # The phase keys match the registry.
    keys = [s["stage_key"] for s in body["stages"]]
    assert keys == [
        "phase_0_scope", "phase_1_plan", "phase_2_build",
        "phase_3_run", "phase_4_report",
    ]


def test_get_stages_404_for_unknown_experiment(client):
    resp = client.get("/api/v1/experiments/no-such-exp/stages")
    assert resp.status_code == 404
