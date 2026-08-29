"""The experiment agent loop — one durable state machine, driven by the DB.

This module is the *core* of the autonomous experiment. It is deliberately
written as one explicit loop so the execution model is readable at a
glance::

    async def run_experiment_loop(...):
        while (phase := _next_phase(db, exp_id)) is not None:
            if phase.status == "waiting_for_user":      # restart / re-entry
                decision = await _await_decision(...)
            else:                                        # not_started / failed /
                result = await _run_phase(phase)         # needs_revision / outdated
                decision = await _checkpoint(phase, result)
            if not _apply_decision(phase, decision):
                break                                    # abort → stop the loop
        _finalize()

Design invariants
=================

1. **The DB is the single source of truth.** `experiment_stages.status`,
   `experiments.overall_status`, the `approvals` row, and
   `agent_tasks.status` fully describe where a workflow is. The loop can be
   killed at ANY point and correctly relaunched later (same process after a
   decide, or a fresh process after a restart) purely from these rows.

2. **A phase in `waiting_for_user` is never re-run.** Its outputs are
   already persisted; re-launching the loop adopts the pending checkpoint:
   if the approval is still pending we re-enter the wait, if it was decided
   (e.g. the user decided while the process was down) we apply the decision
   and continue with the next phase.

3. **All transitions go through `_apply_decision`** — both the live loop
   and the `/decide` endpoint (which applies them synchronously so the UI
   reflects the decision immediately; the loop's application is idempotent).

4. **Short transactions.** Every DB write opens a fresh session via
   `_sessions()` and commits immediately — SQLite's single-writer lock is
   never held across an LLM call or subprocess (H1).

Pause / stop sentinels (`_PAUSE_EVENTS`, `_STOP_FLAGS`) are in-process
fast paths for the same process; the DB polling inside `_await_decision`
is the durable fallback that makes cross-restart resume work.
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

from app.agent.events import get_event_bus
from app.config import get_settings
from app.utils import iso_utc, new_id
from app.db.models import (
    AgentTask,
    AgentTaskEvent,
    Approval,
    Experiment,
    ExperimentStage,
    Project,
)
from app.db.session import get_sessionmaker
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
)
from app.workspace.manager import WorkspaceManager

logger = logging.getLogger("zsci.experiments.orchestrator")

MAX_SMOKE_ATTEMPTS = 3
# Heartbeat keeps `AgentTask.updated_at` fresh while the loop sits inside a
# long-running LLM / subprocess call so the reconciler in app/main.py does
# not confuse a healthy 5-30-minute training phase for a stuck task.
HEARTBEAT_INTERVAL_SECONDS = 30
# How long `_await_decision` sleeps between DB polls (the durable fallback
# path; the in-process event usually wakes us within milliseconds).
DECISION_POLL_INTERVAL = 0.5


def _sessions():
    """Session factory shortcut: ``with _sessions()() as db: ...``."""
    return get_sessionmaker()


# ---------------------------------------------------------------------------
# Pause / resume / stop sentinels (in-process fast paths)
# ---------------------------------------------------------------------------

_PAUSE_EVENTS: dict[str, asyncio.Event] = {}
_STOP_FLAGS: dict[str, bool] = {}


def pause_experiment(task_id: str) -> None:
    evt = _PAUSE_EVENTS.get(task_id)
    if evt is not None:
        evt.clear()


def resume_experiment(task_id: str) -> None:
    evt = _PAUSE_EVENTS.get(task_id)
    if evt is not None:
        evt.set()


def stop_experiment(task_id: str) -> None:
    _STOP_FLAGS[task_id] = True
    evt = _PAUSE_EVENTS.get(task_id)
    if evt is not None:
        evt.set()


# ---------------------------------------------------------------------------
# Events: durable row + live bus publish
# ---------------------------------------------------------------------------


def emit_event(db: Session, task_id: str, kind: str, message: str, payload: dict | None = None) -> None:
    """Append an AgentTaskEvent, commit, and publish to the live bus.

    Commits immediately so SSE clients on the DB-replay path see it on
    their next poll; the bus publish delivers it to live subscribers
    instantly.
    """
    payload_json: str | None = None
    if payload is not None:
        try:
            payload_json = json.dumps(payload, ensure_ascii=False, default=str)
        except (TypeError, ValueError):
            payload_json = json.dumps(str(payload))
    event_id = new_id("evt")
    db.add(
        AgentTaskEvent(
            id=event_id,
            task_id=task_id,
            kind=kind,
            message=message,
            payload_json=payload_json,
        )
    )
    db.commit()
    get_event_bus().publish(
        task_id,
        {"id": event_id, "kind": kind, "message": message, "payload": payload},
    )


def _emit(db: Session, task_id: str, kind: str, message: str, payload: dict | None = None) -> None:
    """Backwards-compatible alias for emit_event."""
    emit_event(db, task_id, kind, message, payload)


# ---------------------------------------------------------------------------
# Heartbeat
# ---------------------------------------------------------------------------


async def _heartbeat_loop(task_id: str, stop_event: asyncio.Event) -> None:
    """Keep `AgentTask.updated_at` fresh so the reconciler doesn't reap a
    healthy long-running phase. Exits when `stop_event` is set."""
    while not stop_event.is_set():
        try:
            await asyncio.wait_for(stop_event.wait(), timeout=HEARTBEAT_INTERVAL_SECONDS)
            break
        except asyncio.TimeoutError:
            pass
        try:
            await asyncio.to_thread(_touch_task_updated_at, task_id)
        except Exception:  # noqa: BLE001
            logger.debug("heartbeat for task %s failed", task_id, exc_info=True)


def _touch_task_updated_at(task_id: str) -> None:
    """Naive-UTC write of AgentTask.updated_at (SQLite stores naive)."""
    now = datetime.now(UTC).replace(tzinfo=None)
    with get_sessionmaker()() as db:
        t = db.get(AgentTask, task_id)
        if t is not None and t.status in (
            "running", "planning", "pending", "awaiting_approval",
        ):
            t.updated_at = now
            db.commit()


# ---------------------------------------------------------------------------
# Status helpers
# ---------------------------------------------------------------------------


def _set_overall_status(
    db: Session,
    experiment_id: str,
    status: str,
    current_stage: str | None = None,
) -> None:
    """Write `Experiment.overall_status`; idempotent re-writes pass through."""
    from app.experiments.states import assert_exp_transition

    exp = db.get(Experiment, experiment_id)
    if exp is None:
        return
    cur = exp.overall_status or "draft"
    if cur != status:
        try:
            assert_exp_transition(cur, status)
        except Exception as exc:  # noqa: BLE001
            logger.warning("overall_status transition %s -> %s rejected: %s", cur, status, exc)
            return
    exp.overall_status = status
    if current_stage is not None:
        exp.current_stage = current_stage


def _set_task_status(db: Session, task_id: str, status: str) -> None:
    task = db.get(AgentTask, task_id)
    if task is not None:
        task.status = status


def _set_stage_status(
    db: Session,
    experiment_id: str,
    stage_key: str,
    status: StageStatus,
) -> None:
    """Write a stage's status (permissive on stale-row transitions)."""
    from app.experiments.states import assert_stage_transition

    row = upsert_stage(db, experiment_id=experiment_id, stage_key=stage_key, status=status)
    db.commit()
    try:
        assert_stage_transition(row.status, status)
    except Exception as exc:  # noqa: BLE001
        logger.warning("stage %s transition rejected: %s (continuing)", stage_key, exc)


def _append_decision(db: Session, experiment_id: str, decision: dict[str, Any]) -> None:
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


def _decision_history(exp: Experiment) -> list[dict]:
    if not exp.decision_history_json:
        return []
    try:
        v = json.loads(exp.decision_history_json)
        return v if isinstance(v, list) else []
    except (ValueError, TypeError):
        return []


# ---------------------------------------------------------------------------
# StageContext — per-task state object handed to every phase function
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
    session_factory: Any = field(default_factory=lambda: get_sessionmaker)

    def is_paused(self) -> bool:
        return not self.pause_event.is_set()

    def is_stopped(self) -> bool:
        return self.stop_flag.get(self.task_id, False)

    async def checkpoint(
        self,
        stage_key: str,
        summary: dict[str, Any],
        stage_outputs: dict[str, Any] | None = None,
    ) -> str:
        """Pause for user review; return the decision string.

        Kept for stage functions that checkpoint mid-phase. The main loop
        uses `_open_checkpoint` / `_await_decision` directly so it can also
        *adopt* a checkpoint left behind by a previous process.
        """
        if self.input.get("mode") == "auto":
            return "approve"
        approval_id = _open_checkpoint(self, stage_key, summary, stage_outputs)
        return await _await_decision(self, stage_key, approval_id)

    async def checkpoint_optional(self, stage_key: str, summary: dict[str, Any]) -> None:
        """Non-blocking checkpoint: surface a banner, keep going."""
        with _sessions()() as db:
            upsert_stage(
                db,
                experiment_id=self.experiment_id,
                stage_key=stage_key,
                status="approved",
                outputs=summary,
            )
            emit_event(db, self.task_id, "step",
                       f"「{STAGE_REGISTRY[stage_key].name_zh}」已完成（无需确认,自动继续）", {
                "stage_key": stage_key,
            })
            db.commit()


def _open_checkpoint(
    ctx: StageContext,
    stage_key: str,
    summary: dict[str, Any],
    stage_outputs: dict[str, Any] | None = None,
) -> str:
    """Persist a checkpoint (stage row + task + Approval) and return the
    approval id. Does NOT wait — callers use `_await_decision` next, or (on
    relaunch) skip straight to reading an already-resolved decision."""
    with _sessions()() as db:
        task = db.get(AgentTask, ctx.task_id)
        if task is None:
            raise RuntimeError(f"task {ctx.task_id} vanished mid-workflow")
        upsert_stage(
            db,
            experiment_id=ctx.experiment_id,
            stage_key=stage_key,
            status="waiting_for_user",
            outputs=stage_outputs or summary,
        )
        _set_overall_status(db, ctx.experiment_id, "waiting_user", current_stage=stage_key)
        task.stage_key = stage_key
        task.status = "awaiting_approval"
        task.checkpoint_payload_json = json.dumps(summary, ensure_ascii=False, default=str)
        apv = Approval(
            id=new_id("appr"),
            task_id=task.id,
            action_type=f"experiment.stage.{stage_key}",
            payload_json=json.dumps(
                {
                    "stage_id": None,
                    "stage_key": stage_key,
                    "stage_name": STAGE_REGISTRY[stage_key].name_zh,
                    "summary": summary,
                    "decision_options": ["approve", "edit", "skip", "abort"],
                },
                ensure_ascii=False,
            ),
            status="pending",
        )
        db.add(apv)
        db.commit()
        emit_event(db, ctx.task_id, "step", f"「{STAGE_REGISTRY[stage_key].name_zh}」已完成,等待你的确认", {
            "stage_key": stage_key,
            "summary_keys": list(summary.keys()),
        })
        return apv.id


async def _await_decision(
    ctx: StageContext,
    stage_key: str,
    approval_id: str,
) -> str:
    """Block until the user resolves `approval_id` (or the task is stopped).

    Fast path: the in-process asyncio event set by `resume_experiment`.
    Durable path: poll the Approval row — this is what makes a checkpoint
    created before a process restart still resolvable after relaunch.
    """
    evt = _PAUSE_EVENTS.setdefault(ctx.task_id, asyncio.Event())
    evt.set()  # not paused; the poll below is the real gate

    while True:
        await evt.wait()
        decision, payload = _read_decision(ctx.task_id, approval_id)
        if decision is not None:
            if payload:
                ctx.input["stage_decision_payload"] = payload.get("decision_payload")
            evt.set()
            return decision
        if _STOP_FLAGS.get(ctx.task_id, False):
            return "abort"
        await asyncio.sleep(DECISION_POLL_INTERVAL)


def _read_decision(task_id: str, approval_id: str) -> tuple[str | None, dict | None]:
    """Read an approval row: (decision, payload) or (None, None) if pending."""
    with _sessions()() as db:
        apv = db.get(Approval, approval_id)
        if apv is None:
            return ("abort", None)
        if apv.status == "pending":
            return (None, None)
        try:
            payload = json.loads(apv.payload_json) if apv.payload_json else {}
        except (ValueError, TypeError):
            payload = {}
        if apv.status == "rejected":
            return ("abort", payload)
        return (payload.get("decision_kind") or "approve", payload)


def find_pending_checkpoint(db: Session, task_id: str) -> Approval | None:
    """The task's oldest still-pending checkpoint, if any."""
    return db.scalar(
        select(Approval).where(
            Approval.task_id == task_id,
            Approval.status == "pending",
        ).order_by(Approval.created_at.desc())
    )


# ---------------------------------------------------------------------------
# Decision application — the single state-transition authority
# ---------------------------------------------------------------------------


def apply_stage_decision(
    db: Session,
    *,
    experiment_id: str,
    task_id: str,
    stage_key: str,
    decision: str,
    decision_payload: dict | None = None,
) -> bool:
    """Apply a checkpoint decision to the stage row + experiment status.

    Returns True when the loop should continue to the next phase, False
    when the workflow must stop (abort). Idempotent — both the /decide
    endpoint and the loop call this.
    """
    stage_row = get_stage_row(db, experiment_id, stage_key)
    exp = db.get(Experiment, experiment_id)

    if decision == "skip":
        if stage_row is not None:
            stage_row.status = "skipped"
            invalidated = mark_downstream_outdated(
                db, experiment_id, stage_key,
                invalidated_by_stage_id=stage_row.id,
            )
            for ds in invalidated:
                ds_name = STAGE_REGISTRY[ds].name_zh if ds in STAGE_REGISTRY else ds
                emit_event(db, task_id, "warning",
                           f"你跳过了「{STAGE_REGISTRY[stage_key].name_zh}」,后续的「{ds_name}」结果已作废,需要重做")
        if exp is not None:
            exp.overall_status = "running"
        return True

    if decision == "abort":
        if stage_row is not None:
            stage_row.status = "needs_revision"
        if exp is not None:
            exp.overall_status = "paused"
            exp.current_stage = stage_key
        return False

    # approve / edit: the phase already ran (outputs persisted before the
    # checkpoint). edit additionally overrides the outputs with the user's
    # edited payload so downstream phases consume the user's version.
    if decision == "edit" and decision_payload:
        upsert_stage(
            db,
            experiment_id=experiment_id,
            stage_key=stage_key,
            status="completed",
            outputs=decision_payload,
            user_decisions=[{"decision": "edit", "payload": decision_payload}],
        )
    elif stage_row is not None:
        stage_row.status = "completed"
        stage_row.ended_at = datetime.now(UTC)
    if exp is not None:
        exp.overall_status = "running"
    return True


# ---------------------------------------------------------------------------
# THE LOOP
# ---------------------------------------------------------------------------


def _phase_state(db: Session, experiment_id: str, stage_key: str) -> str:
    row = get_stage_row(db, experiment_id, stage_key)
    return row.status if row is not None else "not_started"


def _next_phase(db: Session, experiment_id: str) -> tuple[str, str] | None:
    """First phase that still needs attention, in STAGE_KEYS order.

    ``completed`` and ``skipped`` phases are done. Everything else —
    not_started / draft / running / waiting_for_user / failed /
    needs_revision / outdated — is pending. Returns (key, state).
    """
    for key in STAGE_KEYS:
        state = _phase_state(db, experiment_id, key)
        if state in ("completed", "skipped"):
            continue
        return (key, state)
    return None


async def run_experiment_loop(
    *,
    task_id: str,
    experiment_id: str,
    project_id: str,
    input_data: dict,
) -> None:
    """The agent loop. Walks the 5 phases, checkpointing after each.

    Safe to launch at any time: phases already completed are skipped, a
    phase left in `waiting_for_user` by a previous process is adopted (its
    pending approval either waits again or applies an already-made
    decision).
    """
    evt = _PAUSE_EVENTS.setdefault(task_id, asyncio.Event())
    evt.set()
    _STOP_FLAGS.setdefault(task_id, False)

    ctx = StageContext(
        task_id=task_id,
        experiment_id=experiment_id,
        project_id=project_id,
        input=input_data,
        pause_event=evt,
        stop_flag=_STOP_FLAGS,
    )

    heartbeat_stop = asyncio.Event()
    heartbeat_task = asyncio.create_task(
        _heartbeat_loop(task_id, heartbeat_stop),
        name=f"zsci-heartbeat-{task_id}",
    )

    resume = input_data.get("resume", True)
    current_phase: str | None = None

    try:
        with _sessions()() as db:
            _set_overall_status(db, experiment_id, "running")
            _set_task_status(db, task_id, "running")
            emit_event(db, task_id, "step", "自动化实验已启动（共 5 个阶段,关键节点会停下来等你确认）", {
                "mode": input_data.get("mode", "interactive"),
            })
            db.commit()

        while True:
            with _sessions()() as db:
                nxt = _next_phase(db, experiment_id)
            if nxt is None:
                break
            stage_key, state = nxt
            current_phase = stage_key
            sd: StageDef = get_stage(stage_key)

            if ctx.is_stopped():
                with _sessions()() as db:
                    _set_overall_status(db, experiment_id, "paused", current_stage=stage_key)
                break

            # ---- waiting_for_user: adopt the checkpoint from a previous run
            if state == "waiting_for_user" and resume:
                decision, decision_payload = await _resolve_adopted_checkpoint(
                    ctx, task_id, experiment_id, stage_key
                )
                if decision is None:  # task stopped while waiting
                    break
                continue_after = _apply_decision_in_loop(
                    ctx, experiment_id, stage_key, decision, decision_payload
                )
                if not continue_after:
                    break
                continue

            # ---- run the phase
            with _sessions()() as db:
                _set_stage_status(db, experiment_id, stage_key, "running")
                _set_overall_status(db, experiment_id, "running", current_stage=stage_key)
                emit_event(db, task_id, "step", f"开始执行:{sd.name_zh}")

            try:
                with _sessions()() as db:
                    result: StageResult = await sd.run_fn(ctx, db)
            except Exception as exc:  # noqa: BLE001
                logger.exception("phase %s of task %s failed", stage_key, task_id)
                _mark_phase_failed(task_id, experiment_id, stage_key, exc)
                return

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
                emit_event(db, task_id, "step", f"「{sd.name_zh}」完成", {
                    "summary_keys": list(result.summary.keys()),
                })

            # ---- checkpoint
            if input_data.get("mode") == "auto":
                decision = "approve"
                decision_payload: dict | None = None
            else:
                approval_id = _open_checkpoint(ctx, stage_key, result.summary, result.outputs_json)
                decision = await _await_decision(ctx, stage_key, approval_id)
                decision_payload = ctx.input.get("stage_decision_payload")

            continue_after = _apply_decision_in_loop(
                ctx, experiment_id, stage_key, decision, decision_payload
            )
            if not continue_after:
                break

        # ---- finalize
        with _sessions()() as db:
            all_done = _next_phase(db, experiment_id) is None
            if all_done:
                _set_overall_status(db, experiment_id, "completed")
                _set_task_status(db, task_id, "completed")
                emit_event(db, task_id, "step", "全部 5 个阶段已完成")
            else:
                _set_overall_status(db, experiment_id, "paused")
                _set_task_status(db, task_id, "stopped")
                emit_event(db, task_id, "step", "实验已暂停,可随时继续")
            db.commit()
    except Exception as exc:  # noqa: BLE001
        logger.exception("experiment loop %s crashed", task_id)
        _mark_phase_failed(task_id, experiment_id, current_phase, exc)
    finally:
        heartbeat_stop.set()
        heartbeat_task.cancel()
        try:
            await heartbeat_task
        except (asyncio.CancelledError, Exception):
            pass


async def _resolve_adopted_checkpoint(
    ctx: StageContext,
    task_id: str,
    experiment_id: str,
    stage_key: str,
) -> tuple[str | None, dict | None]:
    """A previous process left this phase at a checkpoint. Either wait for a
    new decision (approval still pending) or return the made decision."""
    with _sessions()() as db:
        apv = find_pending_checkpoint(db, task_id)
        approval_id = None
        if apv is not None:
            try:
                apv_payload = json.loads(apv.payload_json or "{}")
            except (ValueError, TypeError):
                apv_payload = {}
            if apv_payload.get("stage_key") == stage_key:
                approval_id = apv.id
        # Re-arm the task row so the sidebar shows "等待确认".
        task = db.get(AgentTask, task_id)
        if task is not None:
            task.status = "awaiting_approval"
            task.stage_key = stage_key
        _set_overall_status(db, experiment_id, "waiting_user", current_stage=stage_key)
        emit_event(db, task_id, "step", f"继续等待你的确认:「{STAGE_REGISTRY[stage_key].name_zh}」")
        db.commit()

    if approval_id is None:
        # No pending approval for this phase — treat as approved and move on.
        return ("approve", None)
    decision = await _await_decision(ctx, stage_key, approval_id)
    if decision == "abort" and _STOP_FLAGS.get(task_id, False):
        return (None, None)
    decision_payload: dict | None = None
    with _sessions()() as db:
        apv_row = db.get(Approval, approval_id)
        if apv_row is not None:
            try:
                apv_payload = json.loads(apv_row.payload_json) if apv_row.payload_json else {}
            except (ValueError, TypeError):
                apv_payload = {}
            decision_payload = apv_payload.get("decision_payload")
    return (decision, decision_payload)


def _apply_decision_in_loop(
    ctx: StageContext,
    experiment_id: str,
    stage_key: str,
    decision: str,
    decision_payload: dict | None,
) -> bool:
    """Record the decision and apply its side effects. Returns whether the
    loop should continue."""
    with _sessions()() as db:
        _append_decision(db, experiment_id, {
            "stage_key": stage_key,
            "decision": decision,
            "at": iso_utc(datetime.now(UTC)),
        })
        db.commit()

    with _sessions()() as db:
        _set_task_status(db, ctx.task_id, "running")
        continue_after = apply_stage_decision(
            db,
            experiment_id=experiment_id,
            task_id=ctx.task_id,
            stage_key=stage_key,
            decision=decision,
            decision_payload=decision_payload,
        )
        emit_event(
            db, ctx.task_id, "step",
            _decision_event_message(stage_key, decision, continue_after),
        )
        db.commit()
    return continue_after


_DECISION_VERB_ZH = {
    "approve": "确认通过",
    "edit": "要求修改",
    "skip": "选择跳过",
    "abort": "选择结束",
}


def _decision_event_message(stage_key: str, decision: str, continue_after: bool) -> str:
    """用户决策的事件消息 —— 面向研究者的措辞,不暴露内部枚举值。"""
    name = STAGE_REGISTRY[stage_key].name_zh if stage_key in STAGE_REGISTRY else stage_key
    verb = _DECISION_VERB_ZH.get(decision, decision)
    tail = "流程继续进入下一阶段" if continue_after else "实验到此停止"
    return f"你{verb}了「{name}」,{tail}"


def _mark_phase_failed(
    task_id: str,
    experiment_id: str,
    stage_key: str | None,
    exc: BaseException,
) -> None:
    """Mark the task + current phase + experiment failed with a friendly
    message (the UI's 重试 button relaunches from the first non-completed
    phase)."""
    friendly = _friendly_error(exc)
    try:
        with _sessions()() as db:
            task = db.get(AgentTask, task_id)
            if task is not None:
                task.status = "failed"
                task.error = friendly
            if stage_key is not None:
                upsert_stage(
                    db,
                    experiment_id=experiment_id,
                    stage_key=stage_key,
                    status="failed",
                )
            _set_overall_status(db, experiment_id, "failed", current_stage=stage_key)
            emit_event(db, task_id, "error", friendly)
            db.commit()
    except Exception:  # noqa: BLE001
        logger.exception("failed to persist failure state for task %s", task_id)


def _friendly_error(exc: BaseException) -> str:
    """Map loop exceptions to a user-readable Chinese message."""
    msg = str(exc)
    if msg and any("一" <= c <= "鿿" for c in msg):
        return msg
    name = type(exc).__name__
    if name == "ModelNotConfigured":
        return "未配置 LLM 模型,请先在设置中配置"
    return "实验运行出错,可点击「重试」从失败阶段继续"


# ---------------------------------------------------------------------------
# Public API
# ---------------------------------------------------------------------------

# Tests and the router import this name; both interactive and `?mode=auto`
# now run the same loop (auto simply auto-approves every checkpoint).
run_autonomous_experiment_v2 = run_experiment_loop


def relaunch_experiment_loop(task: AgentTask) -> bool:
    """(Re)launch the loop for an existing AgentTask, in this process.

    Used by the /decide endpoint (after a restart left no live loop) and by
    startup recovery. Returns True when a new loop was launched.
    """
    from app.agent import dispatch

    if dispatch.is_live(task.id):
        return False
    try:
        input_data = json.loads(task.input_json) if task.input_json else {}
    except (ValueError, TypeError):
        input_data = {}
    experiment_id = task.experiment_id or input_data.get("experiment_id")
    if not experiment_id:
        return False
    dispatch.dispatch(
        task.id,
        run_experiment_loop(
            task_id=task.id,
            experiment_id=experiment_id,
            project_id=task.project_id,
            input_data=input_data,
        ),
        name=f"zsci-exp-{task.id}",
    )
    return True
