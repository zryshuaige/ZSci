"""Regression test for the `datetime_iso is not defined` NameError.

Bug history:
    Before this fix, `orchestrator.py:452` called `datetime_iso()` after every
    phase checkpoint approval. The function was NEVER defined or imported
    anywhere in the codebase, so the first call to `POST /decide` in the
    interactive 5-phase workflow raised::

        NameError: name 'datetime_iso' is not defined

    The orchestrator's `except` block caught it as a generic failure, marking
    the AgentTask failed and the user saw the friendly "实验运行出错,可点击
    「重试」从失败阶段继续" message — with no clear path forward. This was
    a SHOWSTOPPER for the entire interactive workflow.

Fix:
    orchestrator.py now imports `iso_utc` from `app.utils` and calls
    `iso_utc(datetime.now(UTC))` to timestamp `decision_history` entries.

Why the existing test_stage_decisions.py didn't catch this:
    Those tests simulate the checkpoint state (AgentTask + Approval +
    ExperimentStage rows) directly and only call `POST /decide`. They never
    invoke `run_autonomous_experiment_v2`'s actual code path, so the buggy
    line `datetime_iso()` was never executed.

This test drives the real orchestrator end-to-end with stubbed stage run_fns
(so no real LLM / sandbox runs) and asserts that one approval cycle:
    1. appends a decision_history entry with a valid ISO timestamp
    2. does NOT raise NameError
"""
from __future__ import annotations

import json
from dataclasses import replace

import pytest


def test_decision_history_entry_has_iso_timestamp(client, project):
    """Driving one phase-0 approve through the real orchestrator must NOT
    raise NameError, and the decision_history must carry an ISO 8601 `at`."""
    from app.db.models import AgentTask, Experiment
    from app.db.session import get_sessionmaker
    from app.experiments import orchestrator as orch
    from app.experiments.stages import STAGE_REGISTRY, StageResult, phase_0_scope

    # 1. Create a real experiment via the API (so its DB row is canonical).
    exp_resp = client.post(
        f"/api/v1/projects/{project['id']}/experiments",
        json={
            "title": "Regression Test Exp",
            "research_question": "Does X improve Y on Z?",
            "hypothesis": "X reduces training time without accuracy loss",
        },
    )
    assert exp_resp.status_code in (200, 201), exp_resp.text
    exp = exp_resp.json()
    exp_id = exp["id"]
    task_id = "task-regression-1"

    # 2. Pre-seed: AgentTask row that the orchestrator will pick up.
    with get_sessionmaker()() as db:
        db.add(
            AgentTask(
                id=task_id,
                project_id=project["id"],
                task_type="experiment.autonomous_run",
                status="running",
                input_json=json.dumps({"experiment_id": exp_id, "mode": "auto"}),
            )
        )
        db.commit()

    # 3. Stub ALL phase run_fns except phase_0_scope (so we drive exactly one
    #    real phase and one checkpoint approval through the orchestrator).
    #    mode="auto" in the input makes checkpoint() return "approve" without
    #    blocking, so the loop completes in milliseconds.
    original = {k: sd for k, sd in STAGE_REGISTRY.items()}

    async def _stub(_ctx, _db) -> StageResult:
        return StageResult(
            summary={"title": "stub", "ai_judgement": "stub"},
            outputs_json={"stub": True},
        )

    try:
        # Replace every other stage's run_fn with the stub.
        for k, sd in STAGE_REGISTRY.items():
            if k != "phase_0_scope":
                STAGE_REGISTRY[k] = replace(sd, run_fn=_stub)

        # 4. Drive the orchestrator end-to-end (synchronous via asyncio.run).
        import asyncio
        asyncio.run(
            orch.run_autonomous_experiment_v2(
                task_id=task_id,
                experiment_id=exp_id,
                project_id=project["id"],
                input_data={"experiment_id": exp_id, "mode": "auto"},
            )
        )
    finally:
        # Restore STAGE_REGISTRY no matter what.
        STAGE_REGISTRY.clear()
        STAGE_REGISTRY.update(original)

    # 5. The orchestrator ran the real phase_0_scope + appended a real
    #    decision_history entry with `at`. This is the exact site of the
    #    NameError bug — if `datetime_iso` is referenced again, the entry's
    #    `at` will not be a valid ISO 8601 string.
    with get_sessionmaker()() as db:
        e = db.get(Experiment, exp_id)
        history = json.loads(e.decision_history_json or "[]")
        assert len(history) >= 1, (
            "expected at least 1 decision_history entry from the real "
            f"orchestrator path; got {history!r}"
        )
        entry = history[0]
        assert entry["stage_key"] == "phase_0_scope"
        assert entry["decision"] == "approve"
        # The critical assertion: `at` is a valid ISO 8601 timestamp, not
        # something the NameError left behind as None / "".
        at = entry["at"]
        assert isinstance(at, str) and len(at) >= 10, (
            f"decision_history entry missing ISO `at` timestamp: {entry!r}"
        )
        # Round-trip through datetime.fromisoformat to confirm it's parseable.
        from datetime import datetime
        # Python's fromisoformat handles both "Z" suffix and "+00:00".
        parsed = datetime.fromisoformat(at.replace("Z", "+00:00"))
        assert parsed.year >= 2024, f"unexpected `at`: {at!r}"