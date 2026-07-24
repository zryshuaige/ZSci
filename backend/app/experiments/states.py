"""State machine for the 5-phase interactive experiment workflow.

Design notes
============

Two layers of state:

  - `experiment_stages.status` (per stage) — single source of truth
  - `Experiment.overall_status` (aggregate) — derived from active stages

Status values are `Literal[...]` strings (not Python Enum) to match the
existing `Approval.status` / `AgentTask.status` / `Job.status` strings
already in the schema; Pydantic serializes them as plain strings without
`use_enum_values` plumbing.

Transitions are validated against `STAGE_TRANSITIONS` and `EXP_TRANSITIONS`
when the orchestrator writes a status. Illegal transitions raise
`InvalidTransition` (HTTP 409 in the API layer). The transition table is
intentionally permissive — the workflow is human-driven, so we don't want
to reject "user reopens a completed stage" by enforcing strict gates.

Terminology parity with the agent tasks / jobs systems:
  AgentTask.status ∈ {pending, planning, awaiting_approval, running,
                      completed, failed, rejected, stopped}
  Job.status        ∈ {running, completed, failed, stopped}
  ExperimentStage.status  (this file) — 12 values
  Experiment.overall_status (this file) — 7 values
"""
from __future__ import annotations

from typing import Final, Literal


# --- Stage-level status ----------------------------------------------------

StageStatus = Literal[
    "not_started",       # never run
    "draft",             # AI produced a draft, not yet shown to user
    "waiting_for_user",  # checkpoint reached; UI shows CheckpointCard
    "approved",          # user said "approve", execution can proceed
    "running",           # skill / subprocess in flight
    "paused",            # user explicitly paused
    "completed",         # finished successfully
    "failed",            # execution failed (see logs_json)
    "needs_revision",    # user rejected; AI should re-plan / re-run
    "skipped",           # user opted to skip this stage
    "outdated",          # upstream was edited; downstream is invalid
    "archived",          # retained for history but not active
]

# --- Experiment-level (aggregate) status -----------------------------------

ExpStatus = Literal[
    "draft",         # created, no stages executed yet
    "running",       # at least one stage running
    "paused",        # user paused the workflow
    "waiting_user",  # at least one stage waiting_for_user
    "completed",     # all stages completed
    "failed",        # any stage failed (transient; user can resume)
    "archived",      # supersession / fork parent
]

# --- Mode ------------------------------------------------------------------

ExpMode = Literal["interactive", "auto"]
# interactive: pause at every checkpoint (default per product spec)
# auto:        legacy 5-stage linear pipeline, no checkpoints


# --- Phase key registry (the canonical 5 phases) --------------------------
# The user-facing workflow is 5 phases. Each phase composes one or more of
# the 9 internal atomic step functions defined in stages.py (stage_0_init ..
# stage_8_report). The orchestrator walks STAGE_KEYS (these 5 phases) and
# checkpoints once per phase; experiment_stages.stage_key stores phase keys.
# See PHASE_COMPOSITION in stages.py for which atomic steps each phase runs.

STAGE_KEYS: Final[tuple[str, ...]] = (
    "phase_0_scope",    # 需求与基准(确认研究问题 + 检索基准/SOTA)
    "phase_1_plan",     # 方案设计(LLM 生成方案/指标/基线)
    "phase_2_build",    # 代码与自检(生成代码 + smoke 自迭代 + 环境探测)
    "phase_3_run",      # 运行实验(执行各 run 配置)
    "phase_4_report",   # 分析与报告(SOTA 对比 + 生成报告)
)


# --- User-facing phase view (single source of truth) -----------------------
# Iteration 4: this dictionary is the *only* place that defines the
# user-facing Chinese name, one-line summary, and lucide icon for each of
# the 5 phases. The front-end (`frontend/src/lib/stageLabels.ts`) imports
# the same dict via the `/api/v1/experiments/phase-view` endpoint (cached
# in localStorage for the page session), so we never have two divergent
# label tables drifting.
#
# Icon names are the same identifiers the lucide-react package exports
# (e.g. "Target" → import { Target } from "lucide-react"). The front-end
# renders an icon column for each phase; mismatches fall back to "Circle".
STAGE_USER_VIEW: Final[dict[str, dict[str, str]]] = {
    "phase_0_scope":  {
        "name": "研究目标确认",
        "summary": "明确本轮研究要解决的问题,并选择合适的参考基准。",
        "icon": "Target",
    },
    "phase_1_plan":   {
        "name": "实验方案设计",
        "summary": "制定首轮实验方法、对照方式和验证目标。",
        "icon": "Compass",
    },
    "phase_2_build": {
        "name": "实验代码准备",
        "summary": "生成并检查可复现的实验代码与环境。",
        "icon": "Code2",
    },
    "phase_3_run":    {
        "name": "首轮实验运行",
        "summary": "执行实验并记录关键结果。",
        "icon": "PlayCircle",
    },
    "phase_4_report": {
        "name": "结果分析与建议",
        "summary": "分析结果并整理下一步研究建议。",
        "icon": "FileText",
    },
}


# User-facing labels for `Experiment.overall_status`. Single source of
# truth; the front-end reads these via the same `/phase-view` endpoint
# under the key `experiment_status_zh`.
EXPERIMENT_STATUS_ZH: Final[dict[str, str]] = {
    "draft":        "草稿",
    "running":      "正在进行",
    "paused":       "已暂停",
    "waiting_user": "等待你的确认",
    "completed":    "已完成",
    "failed":       "需要处理",
    "archived":     "已归档",
}


# --- Phase dependencies (DAG) ---------------------------------------------
# Linear chain: each phase depends on its predecessor. The orchestrator uses
# this to mark downstream phases `outdated` when an upstream phase is re-run,
# and `forking.py` uses STAGE_KEYS.index() to decide which phases a fork
# inherits.

STAGE_DEPENDS_ON: Final[dict[str, tuple[str, ...]]] = {
    "phase_0_scope":  (),
    "phase_1_plan":   ("phase_0_scope",),
    "phase_2_build":   ("phase_1_plan",),
    "phase_3_run":    ("phase_2_build",),
    "phase_4_report": ("phase_3_run",),
}


def downstream_of(stage_key: str) -> list[str]:
    """Return the list of stages that depend on `stage_key`, recursively.

    For the linear DAG we use here, this is just the chain after the
    stage. The function is generic — it'll keep working if we ever add
    forks (e.g. stage_4_static_check could branch into stage_4b_only_smoke
    and stage_4c_full_unit_tests).
    """
    visited: set[str] = set()
    order: list[str] = []
    queue: list[str] = [stage_key]
    while queue:
        cur = queue.pop(0)
        for k, deps in STAGE_DEPENDS_ON.items():
            if cur in deps and k not in visited:
                visited.add(k)
                order.append(k)
                queue.append(k)
    return order


# --- Phase checkpoint policy ----------------------------------------------
# Whether a phase pauses for user review. Every phase requires user review so
# the user drives each decision point (5 checkpoints total). The internal
# atomic steps (codegen / env_check) that used to be non-blocking are now
# composed inside phase_2_build, which checkpoints once after the whole build.

STAGE_POLICY: Final[dict[str, dict[str, bool]]] = {
    "phase_0_scope":  {"requires_user": True, "optional_user": False},
    "phase_1_plan":   {"requires_user": True, "optional_user": False},
    "phase_2_build":   {"requires_user": True, "optional_user": False},
    "phase_3_run":    {"requires_user": True, "optional_user": False},
    "phase_4_report": {"requires_user": True, "optional_user": False},
}


# --- Transition tables ----------------------------------------------------
# Permissive — humans can rewind, skip, re-run. The point is to catch
# programmer errors (e.g. setting "running" on a "completed" row without
# a version bump), not to enforce a workflow.

STAGE_TRANSITIONS: Final[dict[str, frozenset[str]]] = {
    "not_started":      frozenset({"draft", "running", "skipped", "outdated"}),
    "draft":            frozenset({"waiting_for_user", "running", "completed", "skipped", "failed"}),
    "waiting_for_user": frozenset({"approved", "needs_revision", "running", "skipped", "archived", "failed"}),
    "approved":         frozenset({"running", "completed", "failed", "skipped", "needs_revision"}),
    "running":          frozenset({"completed", "failed", "paused", "waiting_for_user"}),
    "paused":           frozenset({"running", "failed", "completed", "skipped", "needs_revision", "archived"}),
    "completed":        frozenset({"outdated", "needs_revision", "archived", "running"}),
    "failed":           frozenset({"running", "needs_revision", "skipped", "archived"}),
    "needs_revision":   frozenset({"draft", "running", "skipped", "archived"}),
    "skipped":          frozenset({"outdated", "running", "archived"}),
    "outdated":         frozenset({"draft", "running", "archived"}),
    "archived":         frozenset(),  # terminal
}

EXP_TRANSITIONS: Final[dict[str, frozenset[str]]] = {
    "draft":        frozenset({"running", "paused", "archived"}),
    "running":      frozenset({"paused", "waiting_user", "completed", "failed", "archived"}),
    "paused":       frozenset({"running", "waiting_user", "failed", "archived"}),
    "waiting_user": frozenset({"running", "paused", "completed", "failed", "archived"}),
    "completed":    frozenset({"archived", "running"}),  # reopen
    "failed":       frozenset({"running", "archived"}),  # retry
    "archived":     frozenset(),  # terminal
}


# --- Chinese labels for UI -------------------------------------------------
# Keep in sync with the labels used by the front-end's StageProgress and
# `lib/labels.ts` (if a labels.ts entry exists, prefer that as the single
# source of truth). These are the fallback for backend-emitted messages.

STAGE_NAME_ZH: Final[dict[str, str]] = {
    "phase_0_scope":  "需求与基准",
    "phase_1_plan":   "方案设计",
    "phase_2_build":   "代码与自检",
    "phase_3_run":    "运行实验",
    "phase_4_report": "分析与报告",
}

STAGE_STATUS_ZH: Final[dict[str, str]] = {
    "not_started":      "未开始",
    "draft":            "草稿",
    "waiting_for_user": "等待决策",
    "approved":         "已通过",
    "running":          "运行中",
    "paused":           "已暂停",
    "completed":        "已完成",
    "failed":           "失败",
    "needs_revision":   "需要修改",
    "skipped":          "已跳过",
    "outdated":         "已失效",
    "archived":         "已归档",
}


# --- Validation entry points ---------------------------------------------

class InvalidTransition(ValueError):
    """Raised when an orchestrator attempts an illegal stage transition."""


def assert_stage_transition(from_status: str, to_status: str) -> None:
    """Raise `InvalidTransition` if `from_status -> to_status` is not allowed."""
    allowed = STAGE_TRANSITIONS.get(from_status)
    if allowed is None:
        raise InvalidTransition(f"unknown stage status: {from_status!r}")
    if to_status not in allowed:
        raise InvalidTransition(
            f"illegal stage transition: {from_status!r} -> {to_status!r} "
            f"(allowed: {sorted(allowed)})"
        )


def assert_exp_transition(from_status: str, to_status: str) -> None:
    """Raise `InvalidTransition` if the experiment-level transition is illegal."""
    allowed = EXP_TRANSITIONS.get(from_status)
    if allowed is None:
        raise InvalidTransition(f"unknown experiment status: {from_status!r}")
    if to_status not in allowed:
        raise InvalidTransition(
            f"illegal experiment transition: {from_status!r} -> {to_status!r} "
            f"(allowed: {sorted(allowed)})"
        )
