"""Agent tasks router (design.md §15.4, §16).

POST creates + runs a task synchronously (Phase 2 MVP; Phase 3 may add a queue).
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
from app.db.models import AgentTask, Approval, Project
from app.db.session import get_db
from app.llm.gateway import GatewayError, ModelNotConfigured
from app.schemas import AgentEventOut, AgentTaskCreate, AgentTaskOut, ApprovalDecision, ApprovalOut

router = APIRouter(tags=["agent"])
logger = logging.getLogger("zsci.router.agent")


@router.get("/api/v1/agent/skills")
def get_skills() -> dict:
    return {"skills": list_skills()}


@router.post("/api/v1/projects/{project_id}/agent/tasks", response_model=AgentTaskOut)
def create_and_run_task(
    project_id: str, payload: AgentTaskCreate, db: Session = Depends(get_db)
) -> AgentTaskOut:
    if db.get(Project, project_id) is None:
        raise HTTPException(404, "Project not found")
    if payload.task_type not in list_skills():
        raise HTTPException(400, f"Unknown task type: {payload.task_type}")
    try:
        task = create_task(db, project_id=project_id, task_type=payload.task_type, input_data=payload.input)
        task = run_task(db, task)
    except ModelNotConfigured as exc:
        # run_task already persisted the failed status; commit it so the task
        # row survives, then return 503 so the frontend can show a clear
        # "configure your model" message.
        db.commit()
        raise HTTPException(503, str(exc)) from exc
    except GatewayError as exc:
        # run_task already persisted the failed status; commit it so the task
        # row survives, then return 502.
        db.commit()
        raise HTTPException(502, str(exc)) from exc
    except ValueError as exc:
        db.rollback()
        raise HTTPException(400, str(exc)) from exc
    except Exception as exc:  # noqa: BLE001
        # Unexpected error: persist the failed status (run_task may have set it)
        # then surface a 500. Without this, get_db's close would rollback the
        # "failed" status and the task would be stuck in "running" (H11).
        logger.exception("agent task %s failed unexpectedly", payload.task_type)
        try:
            db.commit()
        except Exception:  # noqa: BLE001
            db.rollback()
        raise HTTPException(500, f"Agent task failed: {exc}") from exc
    db.commit()
    db.refresh(task)
    return AgentTaskOut.model_validate(task)


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
        db.flush()
        task = run_task(db, task)
    else:
        task.status = "rejected"
    db.commit()
    db.refresh(approval)
    return ApprovalOut.model_validate(approval)
