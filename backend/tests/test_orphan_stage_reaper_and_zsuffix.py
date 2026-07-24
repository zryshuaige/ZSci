"""Regression tests for two Iteration-3 bugs:

M33 — Orphan `ExperimentStage` rows stuck in `running` (or `waiting_for_user`)
      The previous reconciler only walked AgentTask → Experiment → current
      stage row, so:
        (a) a stage row whose `stage_key` is NOT in the current STAGE_KEYS
            registry (e.g. legacy `stage_0_init` from the 9-stage era) survived
            forever and the UI rendered "运行中 stage_0_init" indefinitely.
        (b) a stage row whose owning experiment was already in a terminal
            state (`failed` / `completed` / `archived`) survived forever.
        (c) a stage row whose `experiment.autonomous_run` task had been
            deleted (or all such tasks are terminal + stale) survived forever.
      `_reap_orphan_stage_rows` now flips each of these classes to `failed`.

M34 — Naive datetimes serialized without a 'Z' suffix made the browser parse
      timestamps as local time, producing bogus "08:57:58" style offsets.
      The fix is `ZSciBaseModel` in `app/schemas.py`: a `@field_serializer("*",
      when_used="json")` that appends 'Z' to naive datetimes on JSON output.
      All response models inherit from it.
"""
from __future__ import annotations

import json
from datetime import UTC, datetime, timedelta

import pytest
from sqlalchemy import select


# ---------------------------------------------------------------------------
# M33: orphan stage reaper
# ---------------------------------------------------------------------------


def _make_orphan_stage_row(client, project_id: str, exp_id: str, *, stage_key: str, status: str) -> str:
    """Insert one ExperimentStage row directly (bypassing the orchestrator)
    so the test exercises the reaper in isolation."""
    from app.db.models import ExperimentStage
    from app.db.session import get_sessionmaker

    row_id = f"orphan-{stage_key}-{status}"
    with get_sessionmaker()() as db:
        db.add(
            ExperimentStage(
                id=row_id,
                experiment_id=exp_id,
                stage_key=stage_key,
                status=status,
                version=1,
            )
        )
        db.commit()
    return row_id


def _make_experiment(client, project_id: str, *, title: str, overall_status: str = "draft") -> str:
    resp = client.post(
        f"/api/v1/projects/{project_id}/experiments",
        json={"title": title, "research_question": "rq"},
    )
    assert resp.status_code in (200, 201), resp.text
    eid = resp.json()["id"]
    # Flip overall_status to whatever the caller wants (the in-memory ORM
    # object is stale after `client.post` returns).
    from app.db.models import Experiment
    from app.db.session import get_sessionmaker

    with get_sessionmaker()() as db:
        e = db.get(Experiment, eid)
        e.overall_status = overall_status
        db.commit()
    return eid


def test_reaper_flips_legacy_stage_key_to_failed(client, project):
    """M33(a): a stage row with `stage_key='stage_0_init'` (legacy 9-stage
    atomic name) that's still in `running` must be reaped to `failed`.
    The exact scenario the user hit on the VLM project."""
    exp_id = _make_experiment(client, project["id"], title="M33 legacy")
    stage_id = _make_orphan_stage_row(
        client, project["id"], exp_id,
        stage_key="stage_0_init", status="running",
    )

    from app.db.models import ExperimentStage
    from app.db.session import get_sessionmaker
    from app.main import _reap_orphan_stage_rows

    with get_sessionmaker()() as db:
        _reap_orphan_stage_rows(db)
        db.commit()

    with get_sessionmaker()() as db:
        row = db.get(ExperimentStage, stage_id)
        assert row.status == "failed", "legacy stage_key row must flip to failed"
        # Sanity: logs_json captured the reason so debugging is easier.
        logs = json.loads(row.logs_json) if row.logs_json else {}
        assert "legacy stage_key" in logs.get("orphan_reason", "")


def test_reaper_flips_orphan_when_experiment_already_terminal(client, project):
    """M33(b): a stage row whose owning experiment is already `failed`
    must be reaped to `failed` even though no live task is touching it."""
    exp_id = _make_experiment(client, project["id"], title="M33 terminal", overall_status="failed")
    stage_id = _make_orphan_stage_row(
        client, project["id"], exp_id,
        stage_key="phase_0_scope", status="running",
    )

    from app.db.models import ExperimentStage
    from app.db.session import get_sessionmaker
    from app.main import _reap_orphan_stage_rows

    with get_sessionmaker()() as db:
        _reap_orphan_stage_rows(db)
        db.commit()

    with get_sessionmaker()() as db:
        row = db.get(ExperimentStage, stage_id)
        assert row.status == "failed"


def test_reaper_flips_orphan_when_no_live_task(client, project):
    """M33(c) + Iteration 4: a stage row whose only autonomous task is
    in `failed` / `stopped` AND was updated longer than the new 1800s
    staleness window must be reaped. The 1800s threshold (was 180s
    before Iteration 4) accommodates a healthy orchestrator that
    heartbeats every 30s."""
    from app.db.models import AgentTask
    from app.db.session import get_sessionmaker

    exp_id = _make_experiment(client, project["id"], title="M33 stale task")
    stage_id = _make_orphan_stage_row(
        client, project["id"], exp_id,
        stage_key="phase_1_plan", status="running",
    )
    # Seed a stale failed task pointing at this experiment.
    task_id = f"task-{exp_id}-orphan"
    with get_sessionmaker()() as db:
        db.add(
            AgentTask(
                id=task_id,
                project_id=project["id"],
                task_type="experiment.autonomous_run",
                status="failed",
                error="simulated prior failure",
                # Backdate the task past the 1800s staleness window.
                # Was 600s for the 180s threshold pre-Iteration-4.
                updated_at=(datetime.now(UTC) - timedelta(seconds=1900)).replace(tzinfo=None),
                input_json=json.dumps({"experiment_id": exp_id, "mode": "interactive"}),
            )
        )
        db.commit()

    from app.main import _reap_orphan_stage_rows

    with get_sessionmaker()() as db:
        _reap_orphan_stage_rows(db)
        db.commit()

    from app.db.models import ExperimentStage

    with get_sessionmaker()() as db:
        row = db.get(ExperimentStage, stage_id)
        assert row.status == "failed"


def test_reaper_does_not_touch_valid_in_flight_stages(client, project):
    """M33 (regression guard): a freshly-running, valid stage row whose
    owning experiment is `running` and which has a live AgentTask must
    NOT be reaped."""
    from app.db.models import AgentTask, AgentTaskEvent
    from app.db.session import get_sessionmaker

    exp_id = _make_experiment(client, project["id"], title="M33 live", overall_status="running")
    stage_id = _make_orphan_stage_row(
        client, project["id"], exp_id,
        stage_key="phase_0_scope", status="running",
    )
    task_id = f"task-{exp_id}-live"
    with get_sessionmaker()() as db:
        db.add(
            AgentTask(
                id=task_id,
                project_id=project["id"],
                task_type="experiment.autonomous_run",
                status="running",
                input_json=json.dumps({"experiment_id": exp_id, "mode": "interactive"}),
            )
        )
        db.commit()

    from app.main import _reap_orphan_stage_rows

    with get_sessionmaker()() as db:
        _reap_orphan_stage_rows(db)
        db.commit()

    from app.db.models import ExperimentStage

    with get_sessionmaker()() as db:
        row = db.get(ExperimentStage, stage_id)
        assert row.status == "running", "live stage row must stay running"


def test_reaper_emits_warning_event_on_orphan_experiment(client, project):
    """M33 + Iteration 4 side-effect: when the reaper flips a stage row,
    it should also emit a friendly `warning` AgentTaskEvent so the page
    can surface it.

    Iteration 4 dropped the explicit "重试" wording from the reaper copy
    — the StickyActionBar surfaces retry as a primary CTA when the user
    lands on the failed variant, so the reaper message just needs to
    acknowledge that the stage row had to be cleaned up.
    """
    from app.db.models import AgentTask, AgentTaskEvent
    from app.db.session import get_sessionmaker

    exp_id = _make_experiment(client, project["id"], title="M33 event", overall_status="failed")
    _make_orphan_stage_row(
        client, project["id"], exp_id,
        stage_key="stage_0_init", status="running",
    )
    task_id = f"task-{exp_id}-ev"
    with get_sessionmaker()() as db:
        db.add(
            AgentTask(
                id=task_id,
                project_id=project["id"],
                task_type="experiment.autonomous_run",
                status="failed",
                input_json=json.dumps({"experiment_id": exp_id, "mode": "interactive"}),
            )
        )
        db.commit()

    from app.main import _reap_orphan_stage_rows

    with get_sessionmaker()() as db:
        _reap_orphan_stage_rows(db)
        db.commit()

    with get_sessionmaker()() as db:
        ev = db.scalar(
            select(AgentTaskEvent)
            .where(
                AgentTaskEvent.task_id == task_id,
                AgentTaskEvent.kind == "warning",
            )
            .order_by(AgentTaskEvent.created_at.desc())
        )
        assert ev is not None, "reaper must emit a warning event"
        # New friendly copy points the user at the detail page (where
        # the StickyActionBar surfaces retry explicitly) instead of
        # hard-coding a destructive action.
        assert "阶段状态" in (ev.message or "") or "不同步" in (ev.message or "")


# ---------------------------------------------------------------------------
# M34: naive-datetime Z-suffix serialization
# ---------------------------------------------------------------------------


def test_zsci_base_model_appends_z_to_naive_datetime():
    """M34: ZSciBaseModel auto-appends 'Z' to naive datetimes on JSON output
    so the browser parses them as UTC (the bug the user reported as
    "08:57:58" — the stored value was 08:57:47 UTC)."""
    from app.schemas import ZSciBaseModel

    class M(ZSciBaseModel):
        created_at: datetime

    m = M(created_at=datetime(2026, 7, 24, 8, 57, 47))
    assert m.model_dump_json() == '{"created_at":"2026-07-24T08:57:47Z"}'


def test_zsci_base_model_passes_through_other_types():
    """M34: the * serializer must not break non-datetime fields."""
    from app.schemas import ZSciBaseModel

    class M(ZSciBaseModel):
        name: str
        n: int
        ok: bool
        when: datetime

    m = M(name="x", n=42, ok=True, when=datetime(2026, 7, 24, 8, 57, 47))
    payload = m.model_dump_json()
    assert '"name":"x"' in payload
    assert '"n":42' in payload
    assert '"ok":true' in payload
    assert '"when":"2026-07-24T08:57:47Z"' in payload


def test_workflows_active_serializes_with_z(client, project):
    """M34: GET /workflows/active must emit the 'Z' suffix on created_at
    and updated_at of the agent-task entries. Regression: previously the
    /workflows/active endpoint serialized via Pydantic's default datetime
    serializer, which dropped the timezone and produced timestamps that
    the browser interpreted as local time (the "08:57:58" bug)."""
    from app.db.models import AgentTask
    from app.db.session import get_sessionmaker

    with get_sessionmaker()() as db:
        db.add(
            AgentTask(
                id="task-zsuffix-test",
                project_id=project["id"],
                task_type="experiment.autonomous_run",
                status="running",
                created_at=datetime(2026, 7, 24, 8, 57, 47),
                updated_at=datetime(2026, 7, 24, 8, 57, 47),
            )
        )
        db.commit()

    resp = client.get("/api/v1/workflows/active")
    assert resp.status_code == 200
    body = resp.json()
    z_task = next((t for t in body["tasks"] if t["id"] == "task-zsuffix-test"), None)
    assert z_task is not None, "freshly-seeded task must appear in /workflows/active"
    assert z_task["created_at"].endswith("Z"), (
        f"created_at must end with 'Z' (got {z_task['created_at']!r})"
    )
    assert z_task["updated_at"].endswith("Z"), (
        f"updated_at must end with 'Z' (got {z_task['updated_at']!r})"
    )
    # The original value (08:57:47) must round-trip exactly.
    assert z_task["created_at"] == "2026-07-24T08:57:47Z"


def test_agent_events_endpoint_serializes_with_z(client, project):
    """M34: GET /agent/tasks/{id}/events must emit the 'Z' suffix on
    created_at of every event. Regression: previously these went through
    Pydantic's default datetime serializer."""
    from app.db.models import AgentTask, AgentTaskEvent
    from app.db.session import get_sessionmaker

    with get_sessionmaker()() as db:
        db.add(
            AgentTask(
                id="task-zsuffix-events",
                project_id=project["id"],
                task_type="research.trend_analysis",
                status="running",
            )
        )
        db.add(
            AgentTaskEvent(
                id="evt-zsuffix-1",
                task_id="task-zsuffix-events",
                kind="step",
                message="starting trend analysis",
                created_at=datetime(2026, 7, 24, 8, 57, 47),
            )
        )
        db.commit()

    resp = client.get("/api/v1/agent/tasks/task-zsuffix-events/events")
    assert resp.status_code == 200
    events = resp.json()
    assert events, "expected at least one event"
    assert all(ev["created_at"].endswith("Z") for ev in events), (
        f"every event created_at must end with 'Z' (got {events!r})"
    )