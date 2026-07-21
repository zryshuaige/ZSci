"""Agent service: task lifecycle, event stream, approval gates (design.md §8, §16).

Each Agent skill is a callable that takes a DB session + state and returns an
updated state. The service persists tasks/events, runs skills, and surfaces
approval gates to the API layer.

We use LangGraph's StateGraph where it earns its keep (planning -> skill ->
evidence validation -> approval -> result). For skills that are single-step LLM
calls we keep them as plain functions registered in a registry - LangGraph is
not forced on everything.
"""
from __future__ import annotations

import json
import logging
from collections.abc import Callable
from datetime import UTC, datetime
from typing import Any

from sqlalchemy.orm import Session

from app.agent.evidence import validate_evidence
from app.agent.state import ResearchAgentState
from app.db.models import AgentTask, AgentTaskEvent, Approval
from app.utils import new_id

logger = logging.getLogger("zsci.agent")

# A skill is a function (db, state) -> state. Registered by task_type.
SkillFn = Callable[[Session, ResearchAgentState], ResearchAgentState]
_SKILLS: dict[str, SkillFn] = {}

# State keys that are always derived from trusted server-side data and must
# never be overridden by client-supplied `input` fields (C3).
_RESERVED_STATE_KEYS = {
    "project_id",
    "task_id",
    "task_type",
    "plan",
    "evidence",
    "pending_approval",
    "warnings",
    "tool_results",
    "final_response",
    "result",
}


def register_skill(task_type: str) -> Callable[[SkillFn], SkillFn]:
    def deco(fn: SkillFn) -> SkillFn:
        _SKILLS[task_type] = fn
        return fn

    return deco


def get_skill(task_type: str) -> SkillFn | None:
    return _SKILLS.get(task_type)


def list_skills() -> list[str]:
    return sorted(_SKILLS)


# ---------------------------------------------------------------------------
# Task lifecycle helpers
# ---------------------------------------------------------------------------


def create_task(
    db: Session,
    *,
    project_id: str,
    task_type: str,
    input_data: dict | None = None,
) -> AgentTask:
    if task_type not in _SKILLS:
        raise ValueError(f"Unknown agent task type: {task_type}")
    task = AgentTask(
        id=new_id("task"),
        project_id=project_id,
        task_type=task_type,
        input_json=json.dumps(input_data, ensure_ascii=False) if input_data else None,
        status="pending",
    )
    db.add(task)
    db.flush()
    _emit(db, task.id, "step", f"任务创建:{task_type}")
    return task


def run_task(db: Session, task: AgentTask) -> AgentTask:
    """Execute a task synchronously: plan -> skill -> validate -> result.

    Skills may set `pending_approval` in state; in that case the task pauses in
    `awaiting_approval` and the caller (API) re-runs after the user decides.
    """
    skill = get_skill(task.task_type)
    if skill is None:
        task.status = "failed"
        task.error = f"No skill registered for {task.task_type}"
        db.flush()
        return task

    task.status = "running"
    db.flush()
    _emit(db, task.id, "step", f"开始执行:{task.task_type}")
    # Commit here so the SQLite WAL write lock is released BEFORE the skill
    # runs. Skills make synchronous LLM calls that can take 10-60s; holding an
    # open write transaction across them serializes all other writers and trips
    # "database is locked" (busy_timeout) on any concurrent write. With this
    # commit, the LLM window holds no write lock, and the skill's post-LLM
    # writes (Idea rows, events) re-acquire it only briefly.
    db.commit()

    input_data = json.loads(task.input_json) if task.input_json else {}
    # Reserved keys are always set from trusted server-side state, never from
    # client input. Input keys are spread FIRST so explicit assignments below
    # win even if a malicious client tries to override them (C3).
    state: ResearchAgentState = {
        **{k: v for k, v in input_data.items() if k not in _RESERVED_STATE_KEYS},
        "project_id": task.project_id,
        "task_id": task.id,
        "task_type": task.task_type,
        "user_request": input_data.get("user_request", ""),
        "intent": input_data.get("intent", task.task_type),
        "plan": [],
        "evidence": [],
        "selected_papers": input_data.get("selected_papers", []),
        "selected_repositories": input_data.get("selected_repositories", []),
        "selected_experiments": input_data.get("selected_experiments", []),
        "pending_approval": None,
        "warnings": [],
        "tool_results": [],
        "final_response": "",
        "result": {},
    }

    try:
        state = skill(db, state)
    except Exception as exc:  # noqa: BLE001
        # Persist the failed status + error event so the UI can show why.
        logger.exception("agent skill %s failed", task.task_type)
        task.status = "failed"
        task.error = str(exc)
        _emit(db, task.id, "error", f"执行失败:{exc}")
        db.flush()
        # Re-raise config/gateway errors so the router can map them to the
        # right HTTP status (503 for ModelNotConfigured, 502 for GatewayError).
        # Other exceptions are treated as "task failed" and return 200 with the
        # failed task (the router's broad except handles unexpected crashes).
        from app.llm.gateway import GatewayError, ModelNotConfigured

        if isinstance(exc, (ModelNotConfigured, GatewayError)):
            raise
        return task

    # Evidence validation pass.
    if state.get("evidence"):
        state["evidence"] = validate_evidence(state["evidence"])
        warnings = [e["_warning"] for e in state["evidence"] if e.get("_warning")]
        for w in warnings:
            state.setdefault("warnings", []).append(w)
            _emit(db, task.id, "warning", w)

    # Approval gate?
    if state.get("pending_approval"):
        task.status = "awaiting_approval"
        task.plan_json = json.dumps(state.get("plan"), ensure_ascii=False) if state.get("plan") else None
        _emit(
            db, task.id, "approval",
            f"等待用户审批:{state['pending_approval'].get('action_type')}",
            state["pending_approval"],
        )
        db.flush()
        return task

    task.status = "completed"
    task.result_json = json.dumps(_serialize(state.get("result") or {}), ensure_ascii=False)
    task.plan_json = json.dumps(state.get("plan"), ensure_ascii=False) if state.get("plan") else None
    task.evidence_ids = (
        json.dumps(state.get("evidence"), ensure_ascii=False) if state.get("evidence") else None
    )
    if state.get("final_response"):
        _emit(db, task.id, "result", state["final_response"][:500])
    db.flush()
    return task


def request_approval(
    db: Session, task: AgentTask, action_type: str, payload: dict
) -> Approval:
    """Record an approval gate requested by a skill."""
    approval = Approval(
        id=new_id("appr"),
        task_id=task.id,
        action_type=action_type,
        payload_json=json.dumps(payload, ensure_ascii=False),
        status="pending",
    )
    db.add(approval)
    db.flush()
    return approval


def decide_approval(db: Session, approval: Approval, approved: bool) -> Approval:
    approval.status = "approved" if approved else "rejected"
    approval.decision_at = datetime.now(UTC)
    _emit(
        db, approval.task_id, "approval",
        f"审批{'通过' if approved else '拒绝'}:{approval.action_type}",
    )
    db.flush()
    return approval


def _emit(
    db: Session, task_id: str, kind: str, message: str | None, payload: dict | None = None
) -> None:
    # Payload may contain arbitrary skill-produced objects; serialize defensively
    # so a non-JSON-safe value (datetime/set/Pydantic model) can't break the
    # task lifecycle (M13).
    payload_json: str | None = None
    if payload is not None:
        try:
            payload_json = json.dumps(_serialize(payload), ensure_ascii=False)
        except (TypeError, ValueError):
            payload_json = json.dumps(str(payload), ensure_ascii=False)
    db.add(
        AgentTaskEvent(
            id=new_id("evt"),
            task_id=task_id,
            kind=kind,
            message=message,
            payload_json=payload_json,
        )
    )
    db.flush()


def _serialize(obj: Any) -> Any:
    if isinstance(obj, dict):
        return {k: _serialize(v) for k, v in obj.items()}
    if isinstance(obj, list):
        return [_serialize(v) for v in obj]
    if isinstance(obj, tuple):
        return [_serialize(v) for v in obj]
    if isinstance(obj, datetime):
        return obj.isoformat()
    if isinstance(obj, (set, frozenset)):
        return [_serialize(v) for v in obj]
    # Fall back to string for unknown types instead of raising (M14).
    if isinstance(obj, (str, int, float, bool, type(None))):
        return obj
    return str(obj)
