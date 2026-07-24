"""FastAPI application entrypoint.

Mounts all routers, configures CORS, ensures the DB schema exists on startup
(Alembic is the canonical migration path; `create_all` is a dev convenience so
`uvicorn app.main:app` works without a prior `alembic upgrade`).
"""
from __future__ import annotations

import asyncio
from contextlib import asynccontextmanager

from fastapi import FastAPI
from fastapi.middleware.cors import CORSMiddleware

from app.config import get_settings
from app.db.base import Base
from app.db.session import get_engine
from app.exception_handlers import register_friendly_handlers
from app.logging import setup_logging
from app.routers import (
    agent,
    annotations,
    experiments,
    ideas,
    literature,
    notes,
    papers,
    projects,
    repositories,
    system,
    writing,
)


@asynccontextmanager
async def lifespan(app: FastAPI):  # noqa: ANN001
    setup_logging()
    # Import agent skills so they register with the skill registry. (The
    # routers/agent import already triggers this at module load, but we keep
    # the explicit import here for clarity and to support non-router callers.)
    from app.agent import code_skills, research_skills, writing_skill  # noqa: F401
    # Ensure workspace dirs exist up front instead of in property getters (M29).
    settings = get_settings()
    settings.research_agent_dir  # noqa: B018 - intentional: trigger mkdir once
    settings.projects_root  # noqa: B018
    # Create tables off the event loop (H10). SQLite DDL is fast but still
    # shouldn't block async startup.
    import app.db.models  # noqa: F401  register tables with Base.metadata
    await asyncio.to_thread(Base.metadata.create_all, get_engine())
    # create_all only creates missing tables - it never adds columns to a
    # table it made on a previous run. Backfill any columns/indexes the ORM
    # models declare that the existing dev DB lacks (e.g. agent_tasks.stage_key,
    # experiments.mode after the 9-stage interactive-workflow landed), so a
    # pre-existing dev DB doesn't crash with `no such column`. (app/db/migrate.py)
    from app.db.migrate import ensure_schema

    await asyncio.to_thread(ensure_schema, get_engine())
    # Reap orphaned workflow state: any agent task / experiment run still marked
    # "running" at startup is an orphan - the background orchestrator / subprocess
    # died with the previous process. Mark them stopped so the global workflow
    # sidebar doesn't list ghost tasks forever. (Single-process assumption; safe
    # because there's no separate worker that might still be running them.)
    await asyncio.to_thread(_reap_orphan_workflow_state)
    # M32: start the in-process task reconciler. The orchestrator stores
    # `AgentTask.error` on the "happy path" failure handler, but if its
    # asyncio task gets silently dropped (event-loop cancellation, unhandled
    # exception swallowed by create_task's `add_done_callback` if the
    # callback itself raises, etc.) the row can stay "running" forever —
    # the user then sees the experiment as "运行中" but it never advances.
    # The reconciler marks any task that's been "running" without progress
    # for >REAP_STALE_AFTER_SECONDS as failed and surfaces a friendly error.
    reconciler_task = asyncio.create_task(_task_reconciler_loop(), name="zsci-task-reconciler")
    try:
        yield
    finally:
        # Stop the reconciler first so it doesn't race the engine dispose.
        reconciler_task.cancel()
        try:
            await reconciler_task
        except (asyncio.CancelledError, Exception):
            pass
        # Dispose the engine on shutdown so file handles / connections release.
        await asyncio.to_thread(get_engine().dispose)


# Iteration 4: was 180s. The new orchestrator heartbeats every 30s (see
# `app/experiments/orchestrator.py:HEARTBEAT_INTERVAL_SECONDS`), so a healthy
# task always has a fresh `updated_at`. 30 min covers model training /
# dataset downloads / large code-generation rounds that legitimately have
# no UI-facing event for many minutes. Anything without heartbeat for
# >30 min is genuinely orphaned.
REAP_STALE_AFTER_SECONDS = 1800


async def _task_reconciler_loop() -> None:
    """Periodically scan for `running` AgentTask rows that haven't progressed
    in a long time and mark them failed.

    "Progress" = a new AgentTaskEvent was appended OR status changed. We use
    the row's `updated_at` as a coarse proxy (the orchestrator updates
    `updated_at` on every checkpoint event because the session flushes after
    every emit).
    """
    while True:
        try:
            await asyncio.sleep(60)  # check every minute
            await asyncio.to_thread(_reap_stale_tasks)
        except asyncio.CancelledError:
            return
        except Exception:  # noqa: BLE001
            # The reconciler must never crash the process. Log and keep going.
            import logging
            logging.getLogger("zsci.main").exception("task reconciler iteration failed")


def _reap_stale_tasks() -> None:
    """Find running AgentTask rows with `updated_at` older than the threshold
    and mark them failed. Also flip the experiment's overall_status to
    `failed` and its current_stage row to `failed` so the UI shows a proper
    red banner with the "重试" button.

    Bug fix (M33): also reap orphaned `ExperimentStage` rows that are stuck
    in `running` / `waiting_for_user` even though their owning experiment is
    already in a terminal state (the previous reconciler only walked from
    AgentTask → Experiment → current stage, so legacy / pre-5-phase stage
    rows like `stage_0_init` would survive forever and the UI rendered
    "运行中 stage_0_init" indefinitely). We now:
      1. flip any in-flight stage row whose experiment is already terminal,
      2. flip any in-flight stage row whose `stage_key` is NOT in the current
         `STAGE_KEYS` registry (legacy atomic keys from the 9-stage era),
      3. flip any in-flight stage row whose experiment has no live
         `experiment.autonomous_run` task.
    """
    from datetime import UTC, datetime, timedelta

    from sqlalchemy import select, update

    from app.db.models import AgentTask, Experiment, ExperimentStage
    from app.db.session import get_sessionmaker
    from app.experiments.states import STAGE_KEYS

    # SQLite columns are naive datetimes; strip tzinfo so the comparison
    # happens on the same basis (avoids the "can't compare offset-naive
    # and offset-aware datetimes" trap if SQLAlchemy ever changes how it
    # binds tz-aware parameters to SQLite).
    cutoff = (datetime.now(UTC) - timedelta(seconds=REAP_STALE_AFTER_SECONDS)).replace(tzinfo=None)
    try:
        with get_sessionmaker()() as db:
            stale = db.scalars(
                select(AgentTask).where(
                    AgentTask.status == "running",
                    AgentTask.updated_at < cutoff,
                )
            ).all()
            for t in stale:
                t.status = "failed"
                t.error = (
                    "实验暂时停下来了。系统长时间没有收到 AI 的更新信号。"
                    "你可以查看详细原因,或在下方选择其他操作。"
                )
                # Best-effort: flip the experiment + current stage row too.
                exp_id = None
                if t.input_json:
                    try:
                        import json
                        inp = json.loads(t.input_json)
                        if isinstance(inp, dict):
                            exp_id = inp.get("experiment_id")
                    except (ValueError, TypeError):
                        pass
                if exp_id:
                    exp = db.get(Experiment, exp_id)
                    if exp is not None and exp.overall_status in (
                        "running", "waiting_user", "draft"
                    ):
                        exp.overall_status = "failed"
                    if exp is not None and exp.current_stage:
                        stage = db.scalar(
                            select(ExperimentStage).where(
                                ExperimentStage.experiment_id == exp_id,
                                ExperimentStage.stage_key == exp.current_stage,
                            )
                        )
                        if stage is not None and stage.status in (
                            "running", "waiting_for_user", "draft"
                        ):
                            stage.status = "failed"
            # M33: orphan-stage reaper. Runs in the same transaction so a
            # single failure rolls everything back, but if anything goes
            # wrong we still commit the task reaper above (separate try).
            _reap_orphan_stage_rows(db)
            if stale:
                db.commit()
    except Exception:  # noqa: BLE001
        # Same as startup reap: never crash on cleanup.
        pass


def _reap_orphan_stage_rows(db) -> None:
    """Reap ExperimentStage rows that are visibly orphaned.

    Three classes of orphan (each flipped to `failed` with a friendly note):

      1. The owning experiment is already in a terminal state
         (`failed` / `completed` / `archived`) but a stage row is still
         `running` or `waiting_for_user` — UI then renders a stale spinner.

      2. The stage's `stage_key` is not in the current STAGE_KEYS registry
         — i.e. legacy atomic keys (`stage_0_init`, `stage_1_benchmarks`,
         …) from before the 5-phase refactor. These rows can never make a
         transition (the orchestrator only walks `STAGE_KEYS`) and the
         UI literally prints "stage_0_init" in the progress bar.

      3. No `experiment.autonomous_run` task exists for the experiment AND
         no AgentTask for the experiment has been `running` within the
         staleness window — the orchestrator is gone but the stage row
         is still in `running`. Belt + suspenders for cases the task-row
         reaper missed (e.g. task was deleted, not just stopped).
    """
    from datetime import UTC, datetime, timedelta

    from sqlalchemy import select

    from app.db.models import AgentTask, Experiment, ExperimentStage
    from app.experiments.states import STAGE_KEYS

    in_flight = ("running", "waiting_for_user", "draft")
    valid_keys = set(STAGE_KEYS)
    stale_cutoff = datetime.now(UTC) - timedelta(seconds=REAP_STALE_AFTER_SECONDS)
    orphan_msg = "阶段状态已与实验不同步。请查看详细原因,或在下方选择其他操作。"

    rows = db.scalars(
        select(ExperimentStage).where(ExperimentStage.status.in_(in_flight))
    ).all()
    if not rows:
        return

    # Pre-collect AgentTasks per experiment to avoid N+1.
    exp_ids = {r.experiment_id for r in rows}
    task_rows = db.scalars(
        select(AgentTask).where(
            AgentTask.task_type == "experiment.autonomous_run",
            AgentTask.project_id.in_(
                select(Experiment.project_id).where(Experiment.id.in_(exp_ids))
            ),
        )
    ).all()
    import json
    tasks_by_exp: dict[str, list[AgentTask]] = {}
    for t in task_rows:
        if not t.input_json:
            continue
        try:
            inp = json.loads(t.input_json)
        except (ValueError, TypeError):
            continue
        eid = inp.get("experiment_id") if isinstance(inp, dict) else None
        if eid:
            tasks_by_exp.setdefault(eid, []).append(t)

    flipped = 0
    for r in rows:
        exp = db.get(Experiment, r.experiment_id)
        if exp is None:
            # No experiment backing this stage — drop it.
            r.status = "failed"
            flipped += 1
            continue

        # Class 1: owning experiment already terminal.
        if exp.overall_status in ("failed", "completed", "archived"):
            r.status = "failed"
            flipped += 1
            continue

        # Class 2: legacy / unknown stage key.
        if r.stage_key not in valid_keys:
            r.status = "failed"
            # Also patch logs_json with a hint so debugging is easier.
            try:
                logs = json.loads(r.logs_json) if r.logs_json else {}
            except (ValueError, TypeError):
                logs = {}
            logs["orphan_reason"] = f"legacy stage_key {r.stage_key!r} not in STAGE_KEYS"
            r.logs_json = json.dumps(logs, ensure_ascii=False)
            flipped += 1
            continue

        # Class 3: no live task — every `experiment.autonomous_run` for this
        # experiment is in a terminal state AND the most recent update is
        # older than the staleness window.
        tasks = tasks_by_exp.get(r.experiment_id, [])
        if tasks and not any(t.status == "running" for t in tasks):
            # SQLite stores naive datetimes; the cutoff is UTC-aware. Treat
            # naive datetimes as already-UTC for the comparison (matches the
            # semantics used in `iso_utc`).
            latest = max(t.updated_at for t in tasks if t.updated_at)
            if latest is not None:
                if latest.tzinfo is None:
                    latest_cmp = latest.replace(tzinfo=UTC)
                else:
                    latest_cmp = latest
                if latest_cmp < stale_cutoff:
                    r.status = "failed"
                    flipped += 1
                    continue

    # Surface a friendly message in the orchestrator's event log so users
    # who hit the bug pre-reap have a pointer. We attach it to the most
    # recent failed task of the affected experiments so the detail page
    # can show it. (Best-effort, not critical.)
    if flipped:
        from app.utils import new_id
        from app.db.models import AgentTaskEvent

        affected_exp_ids = {r.experiment_id for r in rows if r.status == "failed"}
        for eid in affected_exp_ids:
            t = tasks_by_exp.get(eid, [])
            latest_failed = next(
                (x for x in t if x.status in ("failed", "stopped")), None
            )
            if latest_failed is None:
                continue
            db.add(
                AgentTaskEvent(
                    id=new_id("evt"),
                    task_id=latest_failed.id,
                    kind="warning",
                    message=orphan_msg,
                    payload_json=json.dumps({"orphan_stages_reaped": flipped}, ensure_ascii=False),
                )
            )


def _reap_orphan_workflow_state() -> None:
    """Mark in-flight tasks/runs as stopped on startup (they can't still be running)."""
    from sqlalchemy import update

    from app.db.models import AgentTask, ExperimentRun, Job
    from app.db.session import get_sessionmaker

    try:
        with get_sessionmaker()() as db:
            db.execute(
                update(AgentTask)
                .where(AgentTask.status.in_(("running", "pending", "planning")))
                .values(status="stopped", error="进程重启,任务中断")
            )
            db.execute(
                update(ExperimentRun)
                .where(ExperimentRun.status == "running")
                .values(status="stopped")
            )
            # Jobs too - a background LaTeX compile dies with the process.
            db.execute(
                update(Job)
                .where(Job.status == "running")
                .values(status="stopped", error="进程重启,任务中断")
            )
            db.commit()
    except Exception:  # noqa: BLE001
        # Startup must not fail on cleanup - the app is still usable without it.
        pass


def create_app() -> FastAPI:
    settings = get_settings()
    app = FastAPI(
        title="Z-Sci API",
        version="0.1.0",
        description="Local research agent backend (Phase 1).",
        lifespan=lifespan,
    )
    app.add_middleware(
        CORSMiddleware,
        allow_origins=settings.cors_origins,
        allow_credentials=True,
        # Restrict to verbs actually used (M27) instead of "*" — limits the
        # blast radius if cors_origins is ever widened.
        allow_methods=["GET", "POST", "PUT", "PATCH", "DELETE", "OPTIONS"],
        allow_headers=["Content-Type", "Authorization"],
    )
    app.include_router(system.router)
    app.include_router(projects.router)
    app.include_router(literature.router)
    app.include_router(papers.router)
    app.include_router(notes.router)
    app.include_router(annotations.router)
    app.include_router(ideas.router)
    app.include_router(repositories.router)
    app.include_router(agent.router)
    app.include_router(experiments.router)
    app.include_router(writing.router)

    # Phase A: friendly error handlers — see app/exception_handlers.py.
    # Mounted AFTER all routers so they catch uncaught exceptions from
    # route handlers, but FastAPI's add_exception_handler uses the
    # most-recently-registered handler for a given type, so order matters
    # when multiple are defined; ours are the only ones for these types.
    register_friendly_handlers(app)

    @app.get("/")
    def root() -> dict:
        return {"name": "Z-Sci API", "version": "0.1.0", "docs": "/docs"}

    return app


app = create_app()
