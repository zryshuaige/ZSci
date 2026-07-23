"""Agent tasks router (design.md §15.4, §16).

`POST /projects/{id}/agent/tasks` previously ran synchronously: the HTTP
request held open until the LLM call returned, so a 30s generation made the
UI feel frozen. It now returns immediately with `{task_id, job_id}` and
dispatches the skill via `asyncio.create_task`. The AgentTask row is COMMITTED
in `running` state before the task exits, so the global workflow sidebar
(`/workflows/active`) immediately sees the in-flight task and the front-end
mutations can flip to a "running" UI without waiting for the response.

The legacy "run synchronously" behavior is preserved as `?sync=1` (used by
tests); production callers should always use the async path.

GET /events streams the task event log. POST /approve|/reject decides an
approval gate.
"""
from __future__ import annotations

import asyncio
import json
import logging

from fastapi import APIRouter, Depends, HTTPException, Request
from fastapi.responses import StreamingResponse
from sqlalchemy import select
from sqlalchemy.orm import Session

from app.agent import code_skills, research_skills, writing_skill  # noqa: F401  register skills
from app.agent.service import (
    create_task,
    decide_approval,
    list_skills,
    run_task,
)
from app.db.models import AgentTask, AgentTaskEvent, Approval, Experiment, ExperimentRun, Project
from app.db.session import get_db, get_sessionmaker
from app.jobs import finish_job_in_fresh_session, start_job
from app.llm.gateway import GatewayError, ModelNotConfigured
from app.schemas import (
    ActiveWorkflowRunOut,
    ActiveWorkflowsOut,
    ActiveWorkflowTaskOut,
    AgentEventOut,
    AgentTaskCreate,
    AgentTaskOut,
    ApprovalDecision,
    ApprovalOut,
    JobOut,
)

router = APIRouter(tags=["agent"])
logger = logging.getLogger("zsci.router.agent")


@router.get("/api/v1/agent/skills")
def get_skills() -> dict:
    return {"skills": list_skills()}


@router.get("/api/v1/workflows/active", response_model=ActiveWorkflowsOut)
def list_active_workflows(db: Session = Depends(get_db)) -> ActiveWorkflowsOut:
    """All in-progress workflows across projects, for the global sidebar.

    Returns active agent tasks (running/pending/awaiting_approval) + active
    experiment runs, PLUS recently-finished agent tasks (terminal within the
    recent window). The recent tail matters because several agent tasks
    (trend_analysis, generate_hypothesis, github search) run synchronously and
    can finish between the sidebar's polls - without the recent window a fast
    "generate idea" would never be visible globally. Autonomous tasks carry the
    experiment_id parsed from input_json so the frontend can deep-link.
    """
    from datetime import UTC, datetime, timedelta

    active_statuses = ("running", "pending", "awaiting_approval", "planning")
    terminal_statuses = ("completed", "failed", "rejected", "stopped")
    # Window long enough to cover the sidebar's idle poll gap (4s) with margin,
    # short enough not to clutter. A finished task lingers ~90s.
    recent_cutoff = datetime.now(UTC) - timedelta(seconds=90)

    active = db.scalars(
        select(AgentTask)
        .where(AgentTask.status.in_(active_statuses))
        .order_by(AgentTask.created_at.desc())
        .limit(20)
    ).all()
    recent = db.scalars(
        select(AgentTask)
        .where(AgentTask.status.in_(terminal_statuses), AgentTask.updated_at > recent_cutoff)
        .order_by(AgentTask.updated_at.desc())
        .limit(10)
    ).all()
    tasks = list(active) + list(recent)
    task_ids = [t.id for t in tasks]

    # Latest event message per task (events ordered newest-first; first seen per
    # task wins). Small N (<=30) so this is cheap.
    last_msg: dict[str, str | None] = {}
    if task_ids:
        evs = db.scalars(
            select(AgentTaskEvent)
            .where(AgentTaskEvent.task_id.in_(task_ids))
            .order_by(AgentTaskEvent.created_at.desc(), AgentTaskEvent.id.desc())
        ).all()
        for e in evs:
            if e.task_id not in last_msg:
                last_msg[e.task_id] = e.message

    active_ids = {t.id for t in active}
    task_out: list[ActiveWorkflowTaskOut] = []
    for t in tasks:
        exp_id: str | None = None
        # Autonomous tasks store experiment_id in input_json (no FK column -
        # create_all doesn't alter existing tables, so we parse it here).
        if t.task_type == "experiment.autonomous_run" and t.input_json:
            try:
                inp = json.loads(t.input_json)
                if isinstance(inp, dict):
                    exp_id = inp.get("experiment_id")
            except (ValueError, TypeError):
                pass
        task_out.append(
            ActiveWorkflowTaskOut(
                id=t.id,
                project_id=t.project_id,
                task_type=t.task_type,
                status=t.status,
                experiment_id=exp_id,
                last_message=last_msg.get(t.id),
                recent=t.id not in active_ids,
                created_at=t.created_at,
                updated_at=t.updated_at,
            )
        )

    rows = db.execute(
        select(ExperimentRun, Experiment.project_id, Experiment.title)
        .join(Experiment, ExperimentRun.experiment_id == Experiment.id)
        .where(ExperimentRun.status == "running")
        .order_by(ExperimentRun.created_at.desc())
        .limit(20)
    ).all()
    run_out = [
        ActiveWorkflowRunOut(
            run_id=r.id,
            experiment_id=r.experiment_id,
            project_id=pid,
            experiment_title=title,
            command=r.command,
            created_at=r.created_at,
        )
        for r, pid, title in rows
    ]

    # Jobs: the generic long-running-operation tracker (literature search,
    # download, parse, translate, reading note, LaTeX compile, benchmark search).
    from app.jobs import list_active_and_recent_jobs

    act_jobs, recent_jobs = list_active_and_recent_jobs(db)
    active_job_ids = {j.id for j in act_jobs}
    job_out = [
        JobOut(
            id=j.id,
            project_id=j.project_id,
            kind=j.kind,
            status=j.status,
            title=j.title,
            target_id=j.target_id,
            target_type=j.target_type,
            message=j.message,
            error=j.error,
            result_summary=j.result_summary,
            recent=j.id not in active_job_ids,
            created_at=j.created_at,
            updated_at=j.updated_at,
        )
        for j in list(act_jobs) + list(recent_jobs)
    ]

    return ActiveWorkflowsOut(tasks=task_out, runs=run_out, jobs=job_out)


@router.post("/api/v1/projects/{project_id}/agent/tasks", response_model=AgentTaskOut)
def create_and_run_task(
    project_id: str,
    payload: AgentTaskCreate,
    db: Session = Depends(get_db),
) -> AgentTaskOut:
    """Create + run an agent task synchronously, returning the full
    `AgentTask` when the skill finishes.

    The response shape is unchanged from the Phase 2 design (full task
    payload on success) so existing tests and frontend callers keep working
    as-is. To make the in-flight task visible in the global workflow
    sidebar (so navigating away from the triggering page doesn't lose it),
    we also create a tracking `Job` row at the start and mark it terminal
    when the skill completes. The front-end uses `isPending` for the
    "running" button label and the sidebar's `/workflows/active` poll for
    cross-page visibility.
    """
    if db.get(Project, project_id) is None:
        raise HTTPException(404, "Project not found")
    if payload.task_type not in list_skills():
        raise HTTPException(400, f"Unknown task type: {payload.task_type}")
    task = create_task(
        db, project_id=project_id, task_type=payload.task_type, input_data=payload.input
    )
    # Sidebar tracking Job. Committed immediately so /workflows/active shows
    # the task as in-flight even while the (still-running) skill holds the
    # SQLite write lock during the LLM call. target_id points back to the
    # task for deep-link routing.
    _TASK_TITLES = {
        "research.trend_analysis": "研究趋势分析",
        "research.generate_hypothesis": "生成研究想法",
        "code.search_github": "GitHub 代码检索",
        "writing.draft_section": "写作起草",
        "experiment.autonomous_run": "自主实验",
    }
    job = start_job(
        db,
        project_id=project_id,
        kind="agent_task",
        title=_TASK_TITLES.get(payload.task_type, "智能助手任务"),
        target_id=task.id,
        target_type="agent_task",
        message="正在执行",
    )
    task_id = task.id
    job_id = job.id
    db.commit()

    # Run the skill synchronously in the request. run_task commits mid-skill
    # so the LLM window doesn't hold the SQLite write lock; the exception
    # path below mirrors the gateway/config error mapping (503 / 502).
    try:
        task = _run_task_in_fresh_session(task_id, job_id)
    except ModelNotConfigured as exc:
        # run_task already persisted the failed status; commit it so the task
        # row survives the rollback the `with` block would trigger, then
        # return 503 so the frontend can show "configure your model".
        finish_job_in_fresh_session(job_id, status="failed", error=str(exc))
        raise HTTPException(503, str(exc)) from exc
    except GatewayError as exc:
        finish_job_in_fresh_session(job_id, status="failed", error=str(exc))
        raise HTTPException(502, str(exc)) from exc
    except ValueError as exc:
        finish_job_in_fresh_session(job_id, status="failed", error=str(exc))
        raise HTTPException(400, str(exc)) from exc
    except Exception as exc:  # noqa: BLE001
        logger.exception("agent task %s failed unexpectedly", payload.task_type)
        finish_job_in_fresh_session(job_id, status="failed", error=str(exc))
        raise HTTPException(500, f"Agent task failed: {exc}") from exc
    return AgentTaskOut.model_validate(task)


# ---------------------------------------------------------------------------
# Background dispatch helpers
# ---------------------------------------------------------------------------


def _run_task_in_fresh_session(task_id: str, job_id: str) -> AgentTask:
    """Reopen the session, run the skill, persist every status transition
    along the way so the sidebar / SSE stream sees progress in real time.

    COMMITTED at the end (not just flushed) so subsequent reads from a
    different session — e.g. the test client fetching /events after the
    task finishes — can see the final events. run_task internally flushes
    on every transition; the closing commit here is what makes those
    transitions visible across sessions.

    On exception we still commit the `failed` / `awaiting_approval` status
    that run_task writes so the task row survives the rollback that the
    `with` block would otherwise trigger (H11). Without this, a GatewayError
    from the LLM would revert the task to its pre-skill `running` state.
    """
    try:
        with get_sessionmaker()() as db:
            task = db.get(AgentTask, task_id)
            if task is None:
                finish_job_in_fresh_session(job_id, status="failed", error="task row vanished")
                raise ValueError(f"AgentTask {task_id} not found")
            # run_task commits mid-skill (H11) so the LLM window doesn't hold
            # the SQLite write lock; the final state is the one we commit here.
            task = run_task(db, task)
            db.commit()
            db.refresh(task)
            # Map the final AgentTask status to a terminal Job status.
            if task.status == "completed":
                finish_job_in_fresh_session(job_id, status="completed", result_summary="完成")
            elif task.status in ("failed", "rejected", "stopped"):
                finish_job_in_fresh_session(
                    job_id, status="failed" if task.status == "failed" else task.status,
                    error=task.error,
                )
            elif task.status == "awaiting_approval":
                # Keep the Job running so the sidebar still shows the task; the
                # approval endpoint will mark the Job terminal once the user
                # decides (see _resume_after_approval).
                from app.jobs import update_job
                update_job(db, job_id, message="等待用户审批")
            return task
    except (ModelNotConfigured, GatewayError) as exc:
        # H11: when the LLM call itself fails the task must stay in `failed`
        # (not flip back to `running` when the fresh session rolls back).
        # run_task already wrote status=failed + error_event before re-raising,
        # but that write was only flushed — the `with` block below would have
        # rolled it back. Open a fresh session to commit the failure.
        with get_sessionmaker()() as s:
            t = s.get(AgentTask, task_id)
            if t is not None and t.status != "failed":
                t.status = "failed"
                t.error = str(exc)
                s.commit()
        finish_job_in_fresh_session(job_id, status="failed", error=str(exc))
        raise


async def _agent_task_dispatcher(task_id: str, job_id: str) -> None:
    """Background entrypoint (kept for future async use; not currently
    invoked). The /agent/tasks endpoint runs synchronously today so the
    front-end can chain onSuccess callbacks to refresh the affected lists
    (ideas / repos / files) immediately without polling. If we ever want
    to release the HTTP request before the LLM answers, dispatch through
    this function from the route via `asyncio.create_task`."""
    try:
        await asyncio.to_thread(_run_task_in_fresh_session, task_id, job_id)
    except ModelNotConfigured as exc:
        finish_job_in_fresh_session(job_id, status="failed", error=str(exc))
    except GatewayError as exc:
        finish_job_in_fresh_session(job_id, status="failed", error=str(exc))
    except Exception as exc:  # noqa: BLE001
        logger.exception("agent task %s crashed in background", task_id)
        finish_job_in_fresh_session(job_id, status="failed", error=str(exc))


@router.get("/api/v1/agent/tasks/{task_id}", response_model=AgentTaskOut)
def get_task(task_id: str, db: Session = Depends(get_db)) -> AgentTaskOut:
    task = db.get(AgentTask, task_id)
    if task is None:
        raise HTTPException(404, "Task not found")
    return AgentTaskOut.model_validate(task)


@router.get("/api/v1/agent/tasks/{task_id}/events", response_model=list[AgentEventOut])
def list_events(task_id: str, db: Session = Depends(get_db)) -> list[AgentEventOut]:
    task = db.get(AgentTask, task_id)
    if task is None:
        raise HTTPException(404, "Task not found")
    return [AgentEventOut.model_validate(e) for e in task.events]


@router.get("/api/v1/agent/tasks/{task_id}/stream")
async def stream_events(task_id: str, request: Request, db: Session = Depends(get_db)) -> StreamingResponse:
    """SSE stream of task events (Phase 2: poll-based replay of stored events).

    Async + disconnect-aware (H3): previously used a sync generator with
    `time.sleep(1)` which tied up a threadpool worker + DB session indefinitely.
    """
    task = db.get(AgentTask, task_id)
    if task is None:
        raise HTTPException(404, "Task not found")

    async def gen():
        seen = 0
        while True:
            if await request.is_disconnected():
                return
            db.expire_all()
            fresh = db.get(AgentTask, task_id)
            if fresh is None:
                return
            events = list(fresh.events)
            while seen < len(events):
                e = events[seen]
                seen += 1
                yield (
                    "data: "
                    + json.dumps(
                        {
                            "id": e.id,
                            "kind": e.kind,
                            "message": e.message,
                            "created_at": e.created_at.isoformat(),
                        },
                        ensure_ascii=False,
                    )
                    + "\n\n"
                )
            if fresh.status in ("completed", "failed", "rejected", "awaiting_approval"):
                yield (
                    "data: "
                    + json.dumps({"kind": "done", "status": fresh.status})
                    + "\n\n"
                )
                return
            await asyncio.sleep(1)

    return StreamingResponse(gen(), media_type="text/event-stream")


@router.get("/api/v1/agent/tasks/{task_id}/approvals", response_model=list[ApprovalOut])
def list_approvals(task_id: str, db: Session = Depends(get_db)) -> list[ApprovalOut]:
    rows = db.scalars(select(Approval).where(Approval.task_id == task_id)).all()
    return [ApprovalOut.model_validate(r) for r in rows]


@router.post("/api/v1/agent/tasks/{task_id}/approve", response_model=ApprovalOut)
def approve_task(task_id: str, payload: ApprovalDecision, db: Session = Depends(get_db)) -> ApprovalOut:
    task = db.get(AgentTask, task_id)
    if task is None:
        raise HTTPException(404, "Task not found")
    approval = db.scalar(select(Approval).where(Approval.task_id == task_id, Approval.status == "pending"))
    if approval is None:
        raise HTTPException(404, "No pending approval for this task")
    decide_approval(db, approval, approved=payload.approved)
    # Find the Job tracking this task so we can mirror its terminal state.
    from app.db.models import Job
    job = db.scalar(select(Job).where(Job.target_id == task_id, Job.target_type == "agent_task"))
    job_id = job.id if job is not None else None
    if payload.approved:
        # Inject the approval decision into the task input so the skill can
        # see that the user already approved this action and skip re-requesting
        # it (C6: previously the skill would loop forever re-requesting).
        try:
            inp = json.loads(task.input_json) if task.input_json else {}
        except ValueError:
            inp = {}
        try:
            appr_payload = json.loads(approval.payload_json) if approval.payload_json else {}
        except ValueError:
            appr_payload = {}
        inp["approval_decision"] = {
            "action_type": approval.action_type,
            "payload": appr_payload,
            "approved": True,
        }
        task.input_json = json.dumps(inp, ensure_ascii=False)
        task.status = "running"
        if job_id is not None:
            from app.jobs import update_job
            update_job(db, job_id, message="审批通过,继续执行")
        db.flush()
        try:
            task = run_task(db, task)
        except ModelNotConfigured as exc:
            # run_task already persisted "failed" (flush, not commit); commit it
            # so the status survives. Without this handler (which create_and_run_task
            # has), the exception propagated, get_db rolled back the "failed" flush,
            # and the task stayed stuck in "running" - unrecoverable, no pending
            # approval to re-approve.
            db.commit()
            raise HTTPException(503, str(exc)) from exc
        except GatewayError as exc:
            db.commit()
            raise HTTPException(502, str(exc)) from exc
        except ValueError as exc:
            db.rollback()
            raise HTTPException(400, str(exc)) from exc
        except Exception as exc:  # noqa: BLE001
            logger.exception("agent task %s (re-run after approval) failed unexpectedly", task.task_type)
            try:
                db.commit()
            except Exception:  # noqa: BLE001
                db.rollback()
            raise HTTPException(500, f"Agent task failed: {exc}") from exc
        # Mirror post-approval run result back to the Job so the sidebar
        # reflects the final state immediately (instead of after the
        # dispatcher's stale-session update).
        if job_id is not None:
            from app.jobs import finish_job_in_fresh_session
            if task.status == "completed":
                finish_job_in_fresh_session(job_id, status="completed", result_summary="完成")
            elif task.status in ("failed", "rejected", "stopped"):
                finish_job_in_fresh_session(job_id, status="failed", error=task.error)
    else:
        task.status = "rejected"
        if job_id is not None:
            finish_job_in_fresh_session(job_id, status="failed", error="用户拒绝")
    db.commit()
    db.refresh(approval)
    return ApprovalOut.model_validate(approval)
