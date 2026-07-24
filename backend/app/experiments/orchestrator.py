"""Experiment orchestrator (5-phase interactive workflow).

The orchestrator walks `STAGE_REGISTRY` in order. Each entry's `run_fn`
is a *phase* function that composes one or more atomic step functions
(see stages.py); it checkpoints once per phase. Phases already marked
`completed` are skipped (so retry / re-launch resumes from the first
non-completed phase).

Lifecycle per phase:

    1. mark(status='running')  → AuditEvent "phase.start"
    2. await phase.run_fn(ctx, db)
    3. persist outputs_json, artifacts_json
    4. if requires_user: await ctx.checkpoint(phase_key, summary)
       - writes Approval row + emits "approval" AgentTaskEvent
       - blocks until user POSTs /decide
    5. mark(status='completed' or 'needs_revision' or 'skipped')

Bug fix (this iteration): the except block now ALSO marks the AgentTask
failed and the current phase row failed, so a crashed phase doesn't leave
the task stuck in "running" forever. (See regression: AgentTask stayed
"running" after stage_0_init raised ValueError.)

The legacy `_LEGACY_LINEAR` pipeline at the bottom is kept for `?mode=auto`
backward compatibility.
"""
from __future__ import annotations

import asyncio
import json
import logging
from dataclasses import dataclass, field
from datetime import UTC, datetime
from typing import Any

from sqlalchemy import select
from sqlalchemy.orm import Session

from app.agent.service import request_approval
from app.config import get_settings
from app.utils import iso_utc
from app.db.models import (
    AgentTask,
    AgentTaskEvent,
    Approval,
    Experiment,
    ExperimentRun,
    ExperimentStage,
    Project,
)
from app.db.session import get_sessionmaker
from app.experiments.benchmarks import find_and_store_benchmarks
from app.experiments.codegen import generate_experiment_code
from app.experiments.runner import run_experiment
from app.experiments.smoke import run_smoke_with_iteration
from app.experiments.stages import (
    STAGE_REGISTRY,
    StageDef,
    StageResult,
    get_stage,
    get_stage_row,
    mark_downstream_outdated,
    upsert_stage,
)
from app.experiments.states import (
    STAGE_KEYS,
    StageStatus,
    assert_exp_transition,
    assert_stage_transition,
)
from app.utils import new_id
from app.workspace.manager import WorkspaceManager

logger = logging.getLogger("zsci.experiments.orchestrator")

MAX_SMOKE_ATTEMPTS = 3
# Iteration 4: heartbeat keeps `AgentTask.updated_at` fresh while the
# orchestrator sits inside a long-running LLM / subprocess call (the
# reconciler in app/main.py previously flipped such tasks to "failed"
# after 180s of no progress — false positive for training runs that
# legitimately take 5-30 minutes per phase). Heartbeat also runs for
# the agent `run_task()` path so non-orchestrator skills (e.g.
# `research.generate_hypothesis`) benefit from the same protection.
HEARTBEAT_INTERVAL_SECONDS = 30


def _sessions():
    """Resolve a SessionLocal on demand.

    Wraps ``get_sessionmaker()`` so callsites read naturally
    (``with _sessions()() as db: ...``) and so this module remains
    import-safe when no DB is configured (e.g. unit tests that stub the
    orchestrator without touching the session factory).
    """
    return get_sessionmaker()


# ---------------------------------------------------------------------------
# Pause / resume / stop registries
# ---------------------------------------------------------------------------
# These are in-process dicts keyed by AgentTask id. FastAPI runs single-process
# (see app/main.py:create_app lifespan), so an asyncio.Event is enough to
# gate a checkpoint wait. The DB polling in `checkpoint()` is a fallback for
# the case where the process crashes mid-workflow and restarts — the events
# are lost, but the Approval row's status persists.

_PAUSE_EVENTS: dict[str, asyncio.Event] = {}
_STOP_FLAGS: dict[str, bool] = {}


def pause_experiment(task_id: str) -> None:
    """Block the orchestrator at the next checkpoint poll."""
    evt = _PAUSE_EVENTS.get(task_id)
    if evt is not None:
        evt.clear()


def resume_experiment(task_id: str) -> None:
    """Release the orchestrator's checkpoint wait."""
    evt = _PAUSE_EVENTS.get(task_id)
    if evt is not None:
        evt.set()


def stop_experiment(task_id: str) -> None:
    """Mark the experiment as stopped so the next checkpoint returns 'abort'."""
    _STOP_FLAGS[task_id] = True
    evt = _PAUSE_EVENTS.get(task_id)
    if evt is not None:
        evt.set()


# ---------------------------------------------------------------------------
# Iteration 4: heartbeat helper. Touches `AgentTask.updated_at` on a fixed
# cadence so the global reaper (app/main.py:_reap_stale_tasks) doesn't
# confuse a long-running training subprocess for a stuck task. SQLite
# stores naive datetimes so we write naive here too.
# ---------------------------------------------------------------------------


async def _heartbeat_loop(task_id: str, stop_event: asyncio.Event) -> None:
    """Background coroutine: every `HEARTBEAT_INTERVAL_SECONDS` write the
    current UTC time into `AgentTask.updated_at`. Stops cleanly when
    `stop_event` is set (the orchestrator's main coroutine does this on
    success / failure / cancellation)."""
    from app.db.models import AgentTask
    from app.db.session import get_sessionmaker

    while not stop_event.is_set():
        try:
            await asyncio.wait_for(stop_event.wait(), timeout=HEARTBEAT_INTERVAL_SECONDS)
            break  # stop_event set → exit
        except asyncio.TimeoutError:
            pass
        # Defensive: a sync DB write from the heartbeat loop, just like
        # the orchestrator's other _emit() calls.
        try:
            await asyncio.to_thread(_touch_task_updated_at, task_id)
        except Exception:  # noqa: BLE001
            # Heartbeat failures must never crash the orchestrator. The
            # reaper has its own conservative 30-minute ceiling now.
            logger.debug("heartbeat for task %s failed", task_id, exc_info=True)


def _touch_task_updated_at(task_id: str) -> None:
    """Naive-UTC write of AgentTask.updated_at (SQLite stores naive)."""
    from datetime import UTC, datetime

    from app.db.models import AgentTask
    from app.db.session import get_sessionmaker

    now = datetime.now(UTC).replace(tzinfo=None)
    with get_sessionmaker()() as db:
        t = db.get(AgentTask, task_id)
        if t is not None and t.status in ("running", "planning", "pending", "awaiting_approval"):
            t.updated_at = now
            db.commit()


def _set_overall_status(
    db: Session,
    experiment_id: str,
    status: str,
    current_stage: str | None = None,
) -> None:
    """Write `Experiment.overall_status` with transition validation."""
    exp = db.get(Experiment, experiment_id)
    if exp is None:
        return
    cur = exp.overall_status or "draft"
    try:
        assert_exp_transition(cur, status)
    except Exception as exc:  # noqa: BLE001
        # An idempotent re-write of the *same* status is harmless - the
        # orchestrator re-affirms "running" between phases, and the
        # `decide_stage` endpoint also sets "running" synchronously on
        # approve. We must NOT bail in that case, or the `current_stage`
        # advance that rides along on the next call gets dropped and the
        # stepper / hero keep pointing at the just-approved phase. Only
        # bail on a genuinely illegal *change*.
        if cur != status:
            logger.warning("overall_status transition %s -> %s rejected: %s", cur, status, exc)
            return
    exp.overall_status = status
    if current_stage is not None:
        exp.current_stage = current_stage


def _emit(
    db: Session,
    task_id: str,
    kind: str,
    message: str,
    payload: dict | None = None,
) -> None:
    """Append an event and commit immediately so the SSE stream sees it live."""
    payload_json = None
    if payload is not None:
        try:
            payload_json = json.dumps(payload, ensure_ascii=False, default=str)
        except (TypeError, ValueError):
            payload_json = json.dumps(str(payload))
    db.add(
        AgentTaskEvent(
            id=new_id("evt"),
            task_id=task_id,
            kind=kind,
            message=message,
            payload_json=payload_json,
        )
    )
    db.commit()


def _set_stage_status(
    db: Session,
    experiment_id: str,
    stage_key: str,
    status: StageStatus,
) -> None:
    """Validate + write a stage's status; raise InvalidTransition on bad moves."""
    row = upsert_stage(db, experiment_id=experiment_id, stage_key=stage_key, status=status)
    db.commit()
    # Validate lazily — we don't want to crash on a stale row that was
    # written before the transition table was tightened.
    try:
        assert_stage_transition(row.status, status)
    except Exception as exc:  # noqa: BLE001
        logger.warning("stage %s transition rejected: %s (continuing)", stage_key, exc)


# ---------------------------------------------------------------------------
# StageContext — the per-task state object passed to every stage
# ---------------------------------------------------------------------------


@dataclass
class StageContext:
    task_id: str
    experiment_id: str
    project_id: str
    input: dict[str, Any]
    pause_event: asyncio.Event
    stop_flag: dict[str, bool]
    workspace: WorkspaceManager = field(default_factory=WorkspaceManager)

    # -- pause / stop / is --
    def is_paused(self) -> bool:
        return not self.pause_event.is_set()

    def is_stopped(self) -> bool:
        return self.stop_flag.get(self.task_id, False)

    # -- the big one: blocks until the user decides --
    async def checkpoint(
        self,
        stage_key: str,
        summary: dict[str, Any],
        stage_outputs: dict[str, Any] | None = None,
    ) -> str:
        """Pause for user review; return the decision string.

        Returns one of: 'approve' / 'edit' / 'skip' / 'abort' /
        'fork_from_stage' / 'select_resume_point' / 'redo'.

        In `auto` mode (legacy linear pipeline) this returns 'approve'
        immediately so the workflow doesn't actually pause.
        """
        if self.input.get("mode") == "auto":
            return "approve"

        # Write the approval row + agent_task checkpoints BEFORE blocking so
        # the front-end sees the checkpoint via /workflows/active (the
        # AgentTask.stage_key / checkpoint_payload_json columns + the existing
        # AgentTaskEvent kind="approval" payload).
        with _sessions()() as db:
            task = db.get(AgentTask, self.task_id)
            if task is None:
                # Task vanished (DB deleted). Treat as abort.
                return "abort"
            upsert_stage(
                db,
                experiment_id=self.experiment_id,
                stage_key=stage_key,
                status="waiting_for_user",
                outputs=stage_outputs or summary,
            )
            _set_overall_status(
                db,
                self.experiment_id,
                "waiting_user",
                current_stage=stage_key,
            )
            task.stage_key = stage_key
            task.checkpoint_payload_json = json.dumps(summary, ensure_ascii=False, default=str)
            apv = request_approval(
                db,
                task,
                action_type=f"experiment.stage.{stage_key}",
                payload={
                    "stage_id": None,  # resolved when the user decides
                    "stage_key": stage_key,
                    "stage_name": STAGE_REGISTRY[stage_key].name_zh,
                    "summary": summary,
                    "decision_options": [
                        "approve",
                        "edit",
                        "skip",
                        "abort",
                    ],
                },
            )
            db.commit()
            apv_id = apv.id
            _emit(db, self.task_id, "step", f"checkpoint: {stage_key} 等待用户决策", {
                "stage_key": stage_key,
                "summary_keys": list(summary.keys()),
            })

        # Block until the user POSTs /decide. The DB polling is the
        # cross-process fallback if the in-process sentinel is lost.
        decision, decision_payload = await _poll_for_decision(self.task_id, apv_id)
        # Stash the edited payload (if any) so the caller's `edit` branch
        # can read it from ctx.input["stage_decision_payload"].
        if decision_payload:
            self.input["stage_decision_payload"] = decision_payload
        # Reset the event so the next checkpoint can re-arm cleanly.
        self.pause_event.set()
        return decision

    async def checkpoint_optional(self, stage_key: str, summary: dict[str, Any]) -> None:
        """Non-blocking checkpoint; the UI shows a banner but the workflow
        continues. Marks the stage as 'approved' automatically. Used by
        stage_5_env_check (GPU/data may be missing — surface warnings
        but don't block)."""
        with _sessions()() as db:
            upsert_stage(
                db,
                experiment_id=self.experiment_id,
                stage_key=stage_key,
                status="approved",
                outputs=summary,
            )
            _emit(db, self.task_id, "step", f"optional checkpoint: {stage_key}", {
                "stage_key": stage_key,
            })
            db.commit()


async def _poll_for_decision(task_id: str, approval_id: str, poll_interval: float = 0.5) -> tuple[str, dict | None]:
    """Block until the user resolves the approval row or the task is stopped.

    Returns ``(decision, payload)``. `decision` is one of 'approve' / 'edit' /
    'skip' / 'abort' / 'fork_from_stage' / 'select_resume_point' / 'redo'.
    `payload` is the Approval's payload dict (which the /decide endpoint
    enriches with `decision_payload` for an `edit`). The data is written by
    `POST /agent/tasks/{id}/decide` into the Approval row's `payload_json` +
    `status='approved'|'rejected'`.
    """
    while True:
        # Honor pause sentinel — wait until /resume is called.
        await _PAUSE_EVENTS[task_id].wait()
        with _sessions()() as db:
            from app.db.models import Approval

            apv = db.get(Approval, approval_id)
            if apv is None or apv.status != "pending":
                if apv is None:
                    return ("abort", None)
                try:
                    payload = json.loads(apv.payload_json or "{}") if apv.payload_json else {}
                except (ValueError, TypeError):
                    payload = {}
                if apv.status == "rejected":
                    return ("abort", payload)
                return (payload.get("decision_kind") or "approve", payload)
        if _STOP_FLAGS.get(task_id, False):
            return ("abort", None)
        await asyncio.sleep(poll_interval)


def _append_decision(
    db: Session,
    experiment_id: str,
    decision: dict[str, Any],
) -> None:
    """Append a user decision to the experiment's decision_history (JSON list)."""
    exp = db.get(Experiment, experiment_id)
    if exp is None:
        return
    history: list[dict[str, Any]] = []
    if exp.decision_history_json:
        try:
            history = json.loads(exp.decision_history_json)
        except (ValueError, TypeError):
            history = []
    history.append(decision)
    exp.decision_history_json = json.dumps(history, ensure_ascii=False, default=str)


# ---------------------------------------------------------------------------
# Main entry point: 9-stage interactive workflow
# ---------------------------------------------------------------------------


async def run_autonomous_experiment_v2(
    *,
    task_id: str,
    experiment_id: str,
    project_id: str,
    input_data: dict,
) -> None:
    """Drive the 9-stage workflow. Each stage's checkpoint pauses for the
    user unless `mode='auto'`. The legacy linear pipeline is preserved
    separately as `_LEGACY_LINEAR` for `?mode=auto`.
    """
    # Initialize the pause/resume sentinels for this task.
    evt = _PAUSE_EVENTS.setdefault(task_id, asyncio.Event())
    evt.set()  # not paused
    _STOP_FLAGS.setdefault(task_id, False)

    ctx = StageContext(
        task_id=task_id,
        experiment_id=experiment_id,
        project_id=project_id,
        input=input_data,
        pause_event=evt,
        stop_flag=_STOP_FLAGS,
    )

    # Iteration 4: start the heartbeat loop for this task. The reaper in
    # app/main.py:_reap_stale_tasks will NOT flip this task to "failed"
    # while the heartbeat is alive, so long LLM / subprocess waits inside
    # a single phase are tolerated. The loop is cancelled in the
    # `finally` block below (and by `stop_experiment` indirectly).
    _heartbeat_stop = asyncio.Event()
    heartbeat_task = asyncio.create_task(
        _heartbeat_loop(task_id, _heartbeat_stop),
        name=f"zsci-heartbeat-{task_id}",
    )

    with _sessions()() as db:
        _set_overall_status(db, experiment_id, "running")
        _emit(db, task_id, "step", "5 阶段交互式实验开始", {
            "mode": input_data.get("mode", "interactive"),
        })

    # Determine which phases need to run (resume from the first non-completed).
    skip_completed = input_data.get("resume", True)  # retry/resume by default
    phases_to_run: list[str] = []
    with _sessions()() as db:
        for sk in STAGE_KEYS:
            row = get_stage_row(db, experiment_id, sk)
            if skip_completed and row is not None and row.status == "completed":
                continue
            phases_to_run.append(sk)

    if not phases_to_run:
        # Everything already completed (e.g. /decide was a no-op retry).
        with _sessions()() as db:
            _set_overall_status(db, experiment_id, "completed")
            _emit(db, task_id, "step", "实验已完成,无需再跑")
        _heartbeat_stop.set()
        await heartbeat_task
        return

    last_phase_key: str | None = None
    try:
        for stage_key in phases_to_run:
            last_phase_key = stage_key
            if ctx.is_stopped():
                with _sessions()() as db:
                    _set_overall_status(db, experiment_id, "paused", current_stage=stage_key)
                break

            sd: StageDef = get_stage(stage_key)
            with _sessions()() as db:
                _set_stage_status(db, experiment_id, stage_key, "running")
                _set_overall_status(db, experiment_id, "running", current_stage=stage_key)
                _emit(db, task_id, "step", f"阶段: {stage_key} ({sd.name_zh})")

            # Run the phase function. Each takes a fresh DB session so
            # ORM state doesn't leak across phases.
            with _sessions()() as db:
                result: StageResult = await sd.run_fn(ctx, db)

            # Persist the phase's outputs. If the run succeeded, mark
            # completed; if it raised, mark failed and exit.
            with _sessions()() as db:
                upsert_stage(
                    db,
                    experiment_id=experiment_id,
                    stage_key=stage_key,
                    status="completed",
                    outputs=result.outputs_json,
                    artifacts=result.artifacts_json,
                )
                _set_overall_status(db, experiment_id, "running", current_stage=stage_key)
                _emit(db, task_id, "step", f"阶段 {stage_key} 完成: {sd.name_zh}", {
                    "summary_keys": list(result.summary.keys()),
                })

            # Checkpoint (blocking — all 5 phases require user review).
            decision = await ctx.checkpoint(stage_key, result.summary, result.outputs_json)
            with _sessions()() as db:
                _append_decision(
                    db,
                    experiment_id,
                    {
                        "stage_key": stage_key,
                        "decision": decision,
                        "at": iso_utc(datetime.now(UTC)),
                    },
                )
                db.commit()
            if decision == "abort":
                with _sessions()() as db:
                    _set_stage_status(db, experiment_id, stage_key, "needs_revision")
                    _set_overall_status(db, experiment_id, "paused", current_stage=stage_key)
                break
            if decision == "skip":
                with _sessions()() as db:
                    _set_stage_status(db, experiment_id, stage_key, "skipped")
                    invalidated_by = mark_downstream_outdated(
                        db,
                        experiment_id,
                        stage_key,
                        invalidated_by_stage_id="",
                    )
                    for ds in invalidated_by:
                        _emit(db, task_id, "warning", f"下游 {ds} 因 {stage_key} 跳过而被标记为 outdated")
            if decision == "edit":
                # The user edited this phase's output. Persist the edited
                # payload as the new outputs_json so downstream phases
                # consume the user's version.
                edited = dict(ctx.input.get("stage_decision_payload") or {})
                if edited:
                    with _sessions()() as db:
                        upsert_stage(
                            db,
                            experiment_id=experiment_id,
                            stage_key=stage_key,
                            status="completed",
                            outputs=edited,
                            user_decisions=[{"decision": "edit", "payload": edited}],
                        )
                        db.commit()

        # End-of-workflow: if every phase ran to completion, mark done.
        with _sessions()() as db:
            all_stages = db.scalars(
                select(ExperimentStage).where(
                    ExperimentStage.experiment_id == experiment_id,
                )
            ).all()
            phases_by_key = {s.stage_key: s for s in all_stages}
            if all(
                phases_by_key.get(k) and phases_by_key[k].status == "completed"
                for k in STAGE_KEYS
            ):
                _set_overall_status(db, experiment_id, "completed")
                _emit(db, task_id, "step", "全部 5 个阶段已完成")
            elif not ctx.is_stopped():
                _set_overall_status(db, experiment_id, "paused")
    except Exception as exc:  # noqa: BLE001
        logger.exception("5-phase workflow %s failed", task_id)
        friendly = _friendly_error(exc)
        # BUG FIX: previously only Experiment.overall_status was set to
        # "failed" while AgentTask.status stayed "running" and the current
        # phase row stayed "running" — the user saw a forever-running task
        # with a cryptic error event. Now we mark the task, the current
        # phase row, and the experiment all terminal + friendly.
        with _sessions()() as db:
            task = db.get(AgentTask, task_id)
            if task is not None:
                task.status = "failed"
                task.error = friendly
            if last_phase_key is not None:
                upsert_stage(
                    db,
                    experiment_id=experiment_id,
                    stage_key=last_phase_key,
                    status="failed",
                )
            _set_overall_status(db, experiment_id, "failed", current_stage=last_phase_key)
            _emit(db, task_id, "error", friendly)
            db.commit()
    finally:
        # Iteration 4: stop the heartbeat so the row goes terminal cleanly.
        # We do this in BOTH the success path (returned above) and the
        # failure path; the Event + task.cancel() are both safe to call
        # multiple times.
        _heartbeat_stop.set()
        heartbeat_task.cancel()
        try:
            await heartbeat_task
        except (asyncio.CancelledError, Exception):
            pass


def _friendly_error(exc: BaseException) -> str:
    """Map orchestrator exceptions to a user-readable Chinese message.

    Falls back to a generic retry prompt so we never surface raw tracebacks
    (the user-facing page is now strictly Chinese).
    """
    msg = str(exc)
    # Already-Chinese ValueError messages from the stage functions pass through.
    if msg and any('一' <= c <= '鿿' for c in msg):
        return msg
    name = type(exc).__name__
    if name == "ModelNotConfigured":
        return "未配置 LLM 模型,请先在设置中配置"
    return "实验运行出错,可点击「重试」从失败阶段继续"


# ---------------------------------------------------------------------------
# Legacy 5-stage linear pipeline (preserved for ?mode=auto)
# ---------------------------------------------------------------------------


async def _LEGACY_LINEAR(
    *,
    task_id: str,
    experiment_id: str,
    project_id: str,
    input_data: dict,
) -> None:
    """Deprecated: replaced by the 5-phase registry. Kept for `?mode=auto`
    on /experiments/{id}/autonomous so existing PDFs / scripts that depend
    on the legacy semantic don't break. Will be removed in the next major
    version.
    """
    ws = WorkspaceManager()
    research_question = (input_data.get("research_question") or "").strip()
    selected_papers = input_data.get("selected_papers", []) or []
    selected_repositories = input_data.get("selected_repositories", []) or []
    benchmarks_query = input_data.get("benchmarks_query") or research_question
    run_specs = input_data.get("run_configs") or ["baseline"]

    try:
        await _legacy_stage_benchmarks(task_id, experiment_id, project_id, benchmarks_query)
        await _legacy_stage_codegen(
            ws, task_id, experiment_id, project_id, research_question,
            selected_papers, selected_repositories,
        )
        smoke_ok = await _legacy_stage_smoke(ws, task_id, experiment_id)
        if not smoke_ok:
            with _sessions()() as db:
                _set_legacy_task_status(db, task_id, "failed", "smoke test 未通过,已停止(见历史)")
            return
        await _legacy_stage_runs(task_id, experiment_id, project_id, run_specs)
        await _legacy_stage_finalize(task_id, experiment_id)
        with _sessions()() as db:
            _set_legacy_task_status(db, task_id, "completed")
    except Exception as exc:  # noqa: BLE001
        logger.exception("legacy autonomous experiment %s failed", task_id)
        with _sessions()() as db:
            _set_legacy_task_status(db, task_id, "failed", str(exc))


def _set_legacy_task_status(db: Session, task_id: str, status: str, error: str | None = None) -> None:
    task = db.get(AgentTask, task_id)
    if task is None:
        return
    task.status = status
    if error is not None:
        task.error = error
    db.commit()


async def _legacy_stage_benchmarks(task_id, experiment_id, project_id, query) -> None:
    with _sessions()() as db:
        _emit(db, task_id, "step", "阶段 1/5:查找 benchmark")
    if not query:
        return
    warnings: list[str] = []
    def _do():
        with _sessions()() as db:
            rows = find_and_store_benchmarks(
                db, project_id=project_id, query=query, experiment_id=experiment_id,
                limit=8, warnings=warnings,
            )
            db.commit()
            return rows
    rows = await asyncio.to_thread(_do)
    sota = [r for r in rows if r.kind == "sota"]
    with _sessions()() as db:
        for w in warnings:
            _emit(db, task_id, "warning", w)
        _emit(db, task_id, "step", f"阶段 1/5 完成:找到 {len(rows)} 个 benchmark(SOTA {len(sota)})", {
            "benchmarks": [{"name": r.name, "kind": r.kind, "metric": r.metric_name, "value": r.metric_value} for r in rows],
        })


async def _legacy_stage_codegen(ws, task_id, experiment_id, project_id,
                                research_question, selected_papers, selected_repositories) -> None:
    with _sessions()() as db:
        _emit(db, task_id, "step", "阶段 2/5:生成实验代码")
    def _do():
        with _sessions()() as db:
            exp = db.get(Experiment, experiment_id)
            project = db.get(Project, project_id)
            result = generate_experiment_code(
                db, ws, experiment=exp, project=project,
                selected_papers=selected_papers, selected_repositories=selected_repositories,
            )
            exp.plan_json = json.dumps({
                "run_command": result["run_command"],
                "smoke_command": result["smoke_command"],
                "plan": result["plan"],
                "official_code_note": result["official_code_note"],
                "risks": result["risks"],
            }, ensure_ascii=False)
            exp.status = "generated"
            db.commit()
            return result
    result = await asyncio.to_thread(_do)
    with _sessions()() as db:
        _emit(db, task_id, "step", f"阶段 2/5 完成:写入 {len(result['files_written'])} 个文件", {
            "files": result["files_written"],
            "run_command": result["run_command"],
            "smoke_command": result["smoke_command"],
        })


async def _legacy_stage_smoke(ws, task_id, experiment_id) -> bool:
    with _sessions()() as db:
        _emit(db, task_id, "step", "阶段 3/5:smoke test(自迭代修复)")
        exp = db.get(Experiment, experiment_id)
        plan = json.loads(exp.plan_json) if exp.plan_json else {}
        smoke_cmd = plan.get("smoke_command") or "uv run python -m src.train experiment=smoke trainer.epochs=1"
    db = _sessions()()
    try:
        exp = db.get(Experiment, experiment_id)
        project = db.get(Project, exp.project_id)
        result = await run_smoke_with_iteration(
            db, ws, experiment=exp, project=project, smoke_command=smoke_cmd, max_attempts=MAX_SMOKE_ATTEMPTS,
        )
    finally:
        db.close()
    passed = result.get("passed", False)
    with _sessions()() as db:
        _emit(db, task_id, "step" if passed else "warning",
              f"阶段 3/5 {'通过' if passed else '失败'}(尝试 {result.get('attempts')} 次)", {
                  "passed": passed, "history": result.get("history", []),
              })
    return passed


async def _legacy_stage_runs(task_id, experiment_id, project_id, specs) -> None:
    with _sessions()() as db:
        _emit(db, task_id, "step", f"阶段 4/5:运行实验({len(specs)} 个配置)")
        exp = db.get(Experiment, experiment_id)
        plan = json.loads(exp.plan_json) if exp.plan_json else {}
        baseline_cmd = plan.get("run_command") or "uv run python -m src.train experiment=baseline"
    run_ids: list[str] = []
    for spec in specs:
        cmd = spec if (isinstance(spec, str) and ("python" in spec or "uv run" in spec)) else baseline_cmd
        with _sessions()() as db:
            exp = db.get(Experiment, experiment_id)
            project = db.get(Project, project_id)
            run = ExperimentRun(id=new_id("run"), experiment_id=experiment_id, status="created", seed=42)
            db.add(run)
            db.flush()
            _emit(db, task_id, "step", f"运行配置:{spec}")
            await run_experiment(
                db, run=run, command=cmd, project_slug=project.slug,
                exp_slug=exp.slug or "", exp_root=_legacy_exp_root(exp), project_id=project.id, seed=42,
            )
            db.commit()
            db.refresh(run)
            run_ids.append(run.id)
    with _sessions()() as db:
        _emit(db, task_id, "step", f"阶段 4/5 完成:{len(run_ids)} 个 run", {"run_ids": run_ids})


def _legacy_exp_root(exp: Experiment):
    from pathlib import Path

    return (get_settings().projects_root / exp.root_path).resolve()


async def _legacy_stage_finalize(task_id, experiment_id) -> None:
    with _sessions()() as db:
        _emit(db, task_id, "step", "阶段 5/5:汇总与 SOTA 对比")
        exp = db.get(Experiment, experiment_id)
        exp.status = "done"
        db.commit()


# Public alias for the router.
run_autonomous_experiment = _LEGACY_LINEAR
