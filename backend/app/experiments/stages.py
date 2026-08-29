"""Stage registry for the 5-phase interactive experiment workflow.

Each entry in `STAGE_REGISTRY` is a `StageDef` whose `key` is a phase key
(see `STAGE_KEYS` in states.py) and whose `run_fn` is a phase function that
composes one or more of the 9 internal atomic step functions
(`stage_0_init` ... `stage_8_report`).

The orchestrator (`orchestrator.py`) walks `STAGE_REGISTRY` in order,
calling `ctx.checkpoint()` after each phase that requires user review.
The 9 atomic step functions are kept as module-level helpers because:
  1. The unit tests in `tests/test_stage_decisions.py` invoke them directly.
  2. Future split-points (e.g. parallel codegen + env probe) can pull a
     single atomic step out of its phase without rewriting its body.
"""
from __future__ import annotations

import asyncio
import json
import logging
from dataclasses import dataclass, field
from datetime import UTC, datetime
from typing import Any, Awaitable, Callable

from sqlalchemy import select
from sqlalchemy.orm import Session

from app.experiments.benchmarks import find_and_store_benchmarks
from app.experiments.states import (
    STAGE_DEPENDS_ON,
    STAGE_KEYS,
    STAGE_NAME_ZH,
    STAGE_POLICY,
    StageStatus,
)
from app.utils import new_id

logger = logging.getLogger("zsci.experiments.stages")


# ---------------------------------------------------------------------------
# LLM helper — a single JSON chat call with a fence-tolerant parser.
# ---------------------------------------------------------------------------

_PLAN_SYSTEM = """你是计算机科学研究实验方案设计助手。基于研究问题、假设、检索到的基准数据集/任务/SOTA,设计一个可执行、可审计的实验方案。

必须遵循:
1. 紧扣研究问题与假设,明确要验证的命题。
2. 指标必须有清晰定义与计算口径,且与基准的指标可比。
3. 对照组(baseline)必须公平:相同数据、相同评估流程、仅被研究变量不同。
4. 不得捏造任何实验结果、超参数或 SOTA 数字;若基准缺失需明确说明。
5. 列出运行计划(run_specs)与所需的 compute / data 资源。

输出必须是单个 JSON 对象(不要 markdown 代码块),结构如下:
{
  "goal": "一句话说明本实验要验证什么",
  "hypothesis": "假设陈述",
  "metrics": [{"name": "acc", "definition": "准确率", "aggregation": "mean"}],
  "baselines": ["baseline", "no_aug", "no_pretrain"],
  "run_specs": ["baseline", "no_aug"],
  "fairness_note": "如何保证对照公平",
  "compute_plan": "预计 GPU/时间/数据规模",
  "risks": ["..."]
}
"""

_ANALYSIS_SYSTEM = """你是科研实验结果分析助手。给定一个实验的多组运行的指标曲线与基准 SOTA,做公平、保守的结论分析。

必须遵循:
1. 不得夸大,不得把"代码预期效果"写成"已验证效果"。
2. 指出最优配置,并与 SOTA 对比(若基准可行)。
3. 给出稳定性/方差判断(若多 seed)。
4. 标注任何公平性问题或数据泄漏风险。
5. 给出"是否可以发表论文/需要迭代"的诚实结论。

输出必须是单个 JSON 对象(不要 markdown 代码块),结构如下:
{
  "best_run": "run_id",
  "best_metric": {"name": "acc", "value": 0.0},
  "vs_sota": "对比说明",
  "stability": "稳定性判断",
  "fairness": "公平性说明",
  "recommendation": "publish / iterate / inconclusive",
  "next_steps": ["..."]
}
"""

_REPORT_SYSTEM = """你是科研实验报告撰写助手。把实验全流程的 9 个阶段产物拼成一份可复现、可审计、可继续迭代的中文 Markdown 报告。

必须遵循:
1. 报告结构:一、实验概览;二、方案与指标;三、代码与运行;四、结果;五、分析与结论;六、风险与下一轮建议。
2. 引用阶段实际产物(research_question / 基准 / run_command / metrics / analysis),不得编造。
3. 给出复现步骤(命令 + 种子 + commit)。
4. 末尾给出"可继续迭代的下一步"清单。

输出 Markdown 正文(不要外层 JSON,不要 ```markdown 围栏)。"""


def _safe_json_load(text: str) -> dict | None:
    """Extract the first JSON object from an LLM response.

    Delegates to :func:`app.llm.json_utils.extract_json_object` (tolerates
    fences, prose, truncation).
    """
    from app.llm.json_utils import extract_json_object

    return extract_json_object(text)


def _llm_chat(messages: list[dict]) -> str:
    """Call the configured LLM. Raises ModelNotConfigured if unset."""
    from app.llm.gateway import get_gateway

    gw = get_gateway()
    if not gw.is_configured("default_chat"):
        from app.llm.gateway import ModelNotConfigured

        raise ModelNotConfigured("default_chat")
    return gw.chat(messages, role="default_chat", temperature=0.2, max_tokens=8000)


# ---------------------------------------------------------------------------
# Stage context protocol
# ---------------------------------------------------------------------------


@dataclass
class StageResult:
    """What a stage function returns to the orchestrator.

    `summary` is the human-readable checkpoint payload (markdown text +
    structured fields). `outputs_json` and `artifacts_json` are persisted
    onto the experiment_stages row alongside the summary. The orchestrator
    hands `summary` to `ctx.checkpoint()` so the user sees it in the
    CheckpointCard.
    """

    summary: dict[str, Any]
    outputs_json: dict[str, Any] = field(default_factory=dict)
    artifacts_json: list[dict[str, Any]] = field(default_factory=list)


# StageFn: async (StageContext, db session) -> StageResult
# The orchestrator owns the ctx and the session lifecycle; stages only
# need to do their work and return a result.
StageFn = Callable[["StageContextLike", Session], Awaitable[StageResult]]


# Lightweight protocol so we don't have to import orchestrator.StageContext
# (which would create a circular import).
class StageContextLike:
    task_id: str
    experiment_id: str
    project_id: str
    input: dict[str, Any]
    # A fresh DB session factory the stage can use to spawn short-lived reads
    # (e.g. the project's benchmarks) without holding the caller's session.
    # The orchestrator wires this to its own `_sessions`.
    session_factory: Any


# ---------------------------------------------------------------------------
# Stage definition + registry
# ---------------------------------------------------------------------------


@dataclass(frozen=True)
class StageDef:
    key: str
    name_zh: str
    description: str
    requires_user: bool
    optional_user: bool
    expected_seconds: int
    depends_on: tuple[str, ...]
    run_fn: StageFn


# ---------------------------------------------------------------------------
# Stage implementations
# ---------------------------------------------------------------------------


async def stage_0_init(ctx: StageContextLike, db: Session) -> StageResult:
    """Stage 0: validate + persist the experiment's research question.

    Goal: make sure the user has committed to a research question,
    hypothesis, and a known set of constraints before any benchmark or
    code is generated. The stage is intentionally light — the actual
    creation already happened in `POST /projects/{id}/experiments`. Here
    we just snapshot the inputs and gate the workflow on them.
    """
    from app.db.models import Experiment

    exp = db.get(Experiment, ctx.experiment_id)
    if exp is None:
        raise ValueError(f"Experiment {ctx.experiment_id} not found")

    rq = (exp.research_question or "").strip()
    hyp = (exp.hypothesis or "").strip()
    if not rq:
        # The router also validates this in start_autonomous (returns 422
        # 中文 before launching). This defensive check covers any other
        # caller (LLM skill / legacy auto mode) that bypasses the router.
        raise ValueError("请先填写研究问题,再启动实验")

    inputs = {
        "research_question": rq,
        "hypothesis": hyp,
        "title": exp.title,
        "mode": exp.mode,
    }
    summary = {
        "title": "Stage 0 — 初始化与需求确认",
        "research_question": rq,
        "hypothesis": hyp or "(未填写)",
        "checklist": [
            ("研究问题清晰", bool(rq)),
            ("有可验证假设", bool(hyp)),
            ("运行模式", "用户参与" if exp.mode == "interactive" else "一键自动"),
        ],
        "recommendation": (
            "请确认研究问题与假设;若不清晰可返回实验列表修改。"
        ),
        "risks": (
            ["假设措辞模糊会影响后续方案与指标设计"]
            if not hyp
            else []
        ),
    }
    return StageResult(
        summary=summary,
        outputs_json={"validated": True, "mode": exp.mode},
    )


async def stage_1_benchmarks(ctx: StageContextLike, db: Session) -> StageResult:
    """Stage 1: find / curate benchmark candidates for the experiment.

    Search HuggingFace Datasets for the experiment's research question
    (falling back to the question text if no explicit query is supplied).
    Reuses `find_and_store_benchmarks` from the legacy 5-stage pipeline —
    it's already wired up to the SQLite + HF mirror fallback, so we
    don't duplicate the network-resilience logic.
    """
    from app.db.models import Experiment

    exp = db.get(Experiment, ctx.experiment_id)
    if exp is None:
        raise ValueError(f"Experiment {ctx.experiment_id} not found")

    query = (exp.research_question or "").strip()
    # Allow the user to override the query via `input.benchmarks_query`.
    query = (ctx.input.get("benchmarks_query") or query).strip()

    warnings: list[str] = []
    rows = find_and_store_benchmarks(
        db,
        project_id=ctx.project_id,
        query=query,
        experiment_id=ctx.experiment_id,
        limit=8,
        warnings=warnings,
    )
    db.commit()

    by_kind: dict[str, list[dict[str, Any]]] = {"dataset": [], "task": [], "sota": []}
    for r in rows:
        by_kind[r.kind].append({
            "id": r.id,
            "name": r.name,
            "metric_name": r.metric_name,
            "metric_value": r.metric_value,
            "url": r.url,
            "is_mainstream": (
                json.loads(r.extra_json or "{}").get("is_mainstream", False)
                if r.extra_json
                else False
            ),
        })

    summary = {
        "title": "Stage 1 — 查找/确定基准",
        "query": query,
        "counts": {k: len(v) for k, v in by_kind.items()},
        "datasets": by_kind["dataset"][:8],
        "tasks": by_kind["task"][:8],
        "sota": by_kind["sota"][:8],
        "warnings": warnings,
        "ai_judgement": (
            "已按研究方向检索候选数据/任务/SOTA 数字。"
            "请确认主基准与备选基准;后续阶段以确认的基准为对比基线。"
        ),
        "risks": (
            ["HF 检索失败,候选数量可能不足"] if warnings else []
        ),
    }
    return StageResult(
        summary=summary,
        outputs_json={"by_kind": by_kind, "query": query, "warnings": warnings},
        artifacts_json=[
            {"kind": "benchmark", "id": r.id, "name": r.name, "kind_type": r.kind}
            for r in rows
        ],
    )


# ---------------------------------------------------------------------------
# Stage 2: experiment plan + metric design (LLM)
# ---------------------------------------------------------------------------


async def stage_2_plan(ctx: StageContextLike, db: Session) -> StageResult:
    """LLM produces an experiment plan + metric definitions grounded in the
    research question, hypothesis, and the benchmarks collected in stage 1.

    The plan is the contract for every downstream stage: codegen implements
    `run_specs`, analysis compares against `metrics`, report quotes the goal.
    """
    from app.db.models import Benchmark, Experiment

    exp = db.get(Experiment, ctx.experiment_id)
    if exp is None:
        raise ValueError(f"Experiment {ctx.experiment_id} not found")
    rq = (exp.research_question or "").strip()
    hyp = (exp.hypothesis or "").strip()

    # Pull the benchmarks linked to this experiment (stage_1 wrote them).
    bench_rows = db.scalars(
        select(Benchmark).where(Benchmark.experiment_id == ctx.experiment_id)
    ).all() if hasattr(Benchmark, "experiment_id") else []
    bench_lines = [
        f"- {b.name} ({b.kind}): {b.metric_name}={b.metric_value}"
        for b in bench_rows[:12]
    ]

    user_msg = (
        f"研究问题:{rq or '(未填写)'}\n"
        f"假设:{hyp or '(未填写)'}\n"
        f"候选基准:\n" + ("\n".join(bench_lines) if bench_lines else "- (无)")
    )
    raw = await asyncio.to_thread(
        _llm_chat,
        [
            {"role": "system", "content": _PLAN_SYSTEM},
            {"role": "user", "content": user_msg + "\n\n输出 JSON。"},
        ],
    )
    parsed = _safe_json_load(raw) or {}
    plan = {
        "goal": parsed.get("goal", rq or ""),
        "hypothesis": parsed.get("hypothesis", hyp or ""),
        "metrics": parsed.get("metrics", []),
        "baselines": parsed.get("baselines", ["baseline"]),
        "run_specs": parsed.get("run_specs", ["baseline"]),
        "fairness_note": parsed.get("fairness_note", ""),
        "compute_plan": parsed.get("compute_plan", ""),
        "risks": parsed.get("risks", []),
    }

    summary = {
        "title": "Stage 2 — 实验方案与指标设计",
        "goal": plan["goal"],
        "hypothesis": plan["hypothesis"],
        "metrics": [
            {"name": m.get("name"), "definition": m.get("definition")}
            for m in plan["metrics"]
        ],
        "baselines": plan["baselines"],
        "run_specs": plan["run_specs"],
        "fairness_note": plan["fairness_note"],
        "compute_plan": plan["compute_plan"],
        "ai_judgement": (
            "已基于研究问题与候选基准生成方案。请确认指标与基线;确认后进入代码生成。"
        ),
        "risks": plan["risks"] or ["未配置 LLM 时方案将为空,建议先配置模型"],
    }
    return StageResult(
        summary=summary,
        outputs_json=plan,
    )


# ---------------------------------------------------------------------------
# Stage 3: codegen (reuses generate_experiment_code)
# ---------------------------------------------------------------------------


async def stage_3_codegen(ctx: StageContextLike, db: Session) -> StageResult:
    """Generate / write the experiment code. Reuses the legacy
    `generate_experiment_code` (already wired to the LLM + sandboxed writes).
    No checkpoint here (codegen doesn't require_user) — the static check in
    stage 4 is the gate. We persist run_command / smoke_command back into
    the experiment's `plan_json` so stages 6 / 4 pick them up.
    """
    import asyncio as _a
    from app.db.models import Experiment, Project
    from app.experiments.codegen import generate_experiment_code
    from app.workspace.manager import WorkspaceManager
    import json as _json

    exp = db.get(Experiment, ctx.experiment_id)
    project = db.get(Project, ctx.project_id)
    if exp is None or project is None:
        raise ValueError("experiment or project missing for codegen")
    ws = WorkspaceManager()
    result = await _a.to_thread(
        generate_experiment_code,
        db,
        ws,
        experiment=exp,
        project=project,
        selected_papers=ctx.input.get("selected_papers", []),
        selected_repositories=ctx.input.get("selected_repositories", []),
    )
    # Persist commands + plan on the experiment row so downstream stages
    # (smoke, run) read them without regenerating.
    plan_json = _json.loads(exp.plan_json) if exp.plan_json else {}
    plan_json.update({
        "run_command": result["run_command"],
        "smoke_command": result["smoke_command"],
        "plan": result["plan"],
        "relevant_papers": result["relevant_papers"],
        "official_code_note": result["official_code_note"],
        "risks": result["risks"],
    })
    exp.plan_json = _json.dumps(plan_json, ensure_ascii=False)
    exp.status = "generated"
    db.commit()

    return StageResult(
        summary={
            "title": "Stage 3 — 生成实验代码",
            "files_written": result["files_written"],
            "run_command": result["run_command"],
            "smoke_command": result["smoke_command"],
            "official_code_note": result["official_code_note"],
            "risks": result["risks"],
        },
        outputs_json={
            "files_written": result["files_written"],
            "run_command": result["run_command"],
            "smoke_command": result["smoke_command"],
            "plan": result["plan"],
        },
        artifacts_json=[
            {"kind": "file", "path": f} for f in result["files_written"]
        ],
    )


# ---------------------------------------------------------------------------
# Stage 4: static check + smoke self-iteration (reuses run_smoke_with_iteration)
# ---------------------------------------------------------------------------


async def stage_4_static_check(ctx: StageContextLike, db: Session) -> StageResult:
    """Run the smoke command with LLM-patched re-tries (reuses
    `run_smoke_with_iteration`). The result is the user-facing gate — code
    must at least import + produce a METRIC line before the experiment can run.
    """
    import asyncio as _a
    import json as _json
    from app.db.models import Experiment, Project
    from app.experiments.smoke import run_smoke_with_iteration
    from app.workspace.manager import WorkspaceManager

    exp = db.get(Experiment, ctx.experiment_id)
    project = db.get(Project, ctx.project_id)
    if exp is None or project is None:
        raise ValueError("experiment or project missing for smoke")
    plan = _json.loads(exp.plan_json) if exp.plan_json else {}
    smoke_cmd = plan.get("smoke_command") or "uv run python -m src.train experiment=smoke trainer.epochs=1"
    ws = WorkspaceManager()
    result = await _a.to_thread(
        lambda: run_smoke_with_iteration(
            db,
            ws,
            experiment=exp,
            project=project,
            smoke_command=smoke_cmd,
            max_attempts=3,
        )
    )
    passed = bool(result.get("passed"))
    summary = {
        "title": "Stage 4 — 静态检查 / Smoke 自检",
        "passed": passed,
        "attempts": result.get("attempts"),
        "history": result.get("history", []),
        "smoke_command": smoke_cmd,
        "ai_judgement": (
            "smoke test 通过,代码可最小运行。请确认后进入环境检查与正式运行。"
            if passed
            else "smoke 自检未通过(已自迭代修复 3 次)。建议查看日志后重跑或手动修复。"
        ),
        "risks": ([] if passed else ["smoke 失败,后续运行可能同样失败"]),
    }
    if not passed:
        # A failed smoke should make the orchestrator gate before running.
        summary["risks"].append("建议选择 redo 重跑本阶段,或 skip 跳过但风险自负")
    return StageResult(
        summary=summary,
        outputs_json={
            "passed": passed,
            "attempts": result.get("attempts"),
            "history": result.get("history", []),
        },
    )


# ---------------------------------------------------------------------------
# Stage 5: environment / resource check (subprocess probe, optional banner).
# ---------------------------------------------------------------------------


async def stage_5_env_check(ctx: StageContextLike, db: Session) -> StageResult:
    """Probe torch / CUDA / disk / data accessibility. Optional checkpoint —
    surfaces warnings as a non-blocking banner; the workflow continues even
    if the GPU is absent (CPU fallback is the experiment's responsibility).
    """
    import asyncio as _a
    import shutil
    from app.config import get_settings
    from app.db.models import Experiment

    exp = db.get(Experiment, ctx.experiment_id)
    if exp is None:
        raise ValueError("experiment missing for env check")
    settings = get_settings()
    exp_root = (settings.projects_root / exp.root_path).resolve()

    # Probe: torch importable? CUDA available? free disk? config files exist?
    probe_cmd = (
        "uv run python -c \""
        "import sys;"
        "try:\n"
        " import torch;\n"
        " print('torch', torch.__version__);"
        " print('cuda', torch.cuda.is_available());"
        " print('devices', torch.cuda.device_count())\n"
        "except Exception as e:\n"
        " print('torch_err', e)"
        "\""
    )
    try:
        proc = await _a.create_subprocess_shell(
            probe_cmd,
            cwd=str(exp_root),
            stdout=_a.subprocess.PIPE,
            stderr=_a.subprocess.PIPE,
        )
        out, err = await _a.wait_for(proc.communicate(), timeout=60)
        probe_out = (out or b"").decode("utf-8", errors="replace")
    except Exception as exc:  # noqa: BLE001
        probe_out = f"probe_failed: {exc}"

    # Disk free on the project volume.
    try:
        usage = shutil.disk_usage(str(exp_root))
        disk_gb = round(usage.free / (1024 ** 3), 1)
    except OSError:
        disk_gb = None

    # Config + data presence (rough).
    config_ok = (exp_root / "configs").is_dir() and any(
        (exp_root / "configs").iterdir()
    )
    warnings: list[str] = []
    if "cuda True" not in probe_out and "torch_err" not in probe_out:
        warnings.append("未检测到可用 CUDA,将以 CPU 模式运行(训练可能极慢)")
    if "torch_err" in probe_out:
        warnings.append("torch 导入失败,实验代码可能无法运行")
    if disk_gb is not None and disk_gb < 2:
        warnings.append(f"可用磁盘仅 {disk_gb}GB,大模型/数据可能写不下")
    if not config_ok:
        warnings.append("configs/ 目录为空,运行前需先生成配置")

    summary = {
        "title": "Stage 5 — 环境 / 资源检查",
        "probe": probe_out.strip().splitlines(),
        "disk_free_gb": disk_gb,
        "config_present": config_ok,
        "warnings": warnings,
        "ai_judgement": (
            "环境探测完成。"
            + ("未见阻断性问题,可继续运行。" if not warnings else "存在告警,请确认后继续(可跳过)。")
        ),
        "risks": warnings,
    }
    return StageResult(
        summary=summary,
        outputs_json={"probe": probe_out, "disk_free_gb": disk_gb, "warnings": warnings},
    )


# ---------------------------------------------------------------------------
# Stage 6: run the experiment (reuses run_experiment per run_spec).
# ---------------------------------------------------------------------------


async def stage_6_run(ctx: StageContextLike, db: Session) -> StageResult:
    """Run every `run_spec` from the stage_2 plan serially via the existing
    `run_experiment`. High cost — this stage requires_user, so the orchestrator
    checkpoints before it starts (the user confirms compute cost)."""
    import asyncio as _a
    import json as _json
    from app.config import get_settings
    from app.db.models import Experiment, ExperimentRun, Project
    from app.experiments.runner import run_experiment
    from app.utils import new_id as _new_id

    exp = db.get(Experiment, ctx.experiment_id)
    project = db.get(Project, ctx.project_id)
    if exp is None or project is None:
        raise ValueError("experiment or project missing for run")
    plan = _json.loads(exp.plan_json) if exp.plan_json else {}
    baseline_cmd = plan.get("run_command") or "uv run python -m src.train experiment=baseline"
    specs = ctx.input.get("run_configs") or plan.get("run_specs") or ["baseline"]
    settings = get_settings()
    exp_root = (settings.projects_root / exp.root_path).resolve()

    run_ids: list[str] = []
    failures: list[str] = []
    for spec in specs:
        # Spec can be a bare name (use baseline command) or a full command.
        cmd = spec if (isinstance(spec, str) and ("python" in spec or "uv run" in spec)) else baseline_cmd
        run = ExperimentRun(id=_new_id("run"), experiment_id=ctx.experiment_id, status="created", seed=42)
        db.add(run)
        db.flush()
        try:
            await run_experiment(
                db,
                run=run,
                command=cmd,
                project_slug=project.slug,
                exp_slug=exp.slug or "",
                exp_root=exp_root,
                project_id=project.id,
                seed=42,
            )
        except Exception as exc:  # noqa: BLE001
            run.status = "failed"
            failures.append(f"{spec}: {exc}")
        db.commit()
        db.refresh(run)
        run_ids.append(run.id)
        if run.status != "completed" and run.status != "created":
            failures.append(f"{spec}: run.status={run.status}")

    summary = {
        "title": "Stage 6 — 运行实验",
        "run_ids": run_ids,
        "specs": specs,
        "failures": failures,
        "ai_judgement": (
            f"完成 {len(run_ids)} 个 run。"
            + (f"{len(failures)} 个失败。" if failures else "全部成功。")
        ),
        "risks": failures,
    }
    return StageResult(
        summary=summary,
        outputs_json={"run_ids": run_ids, "failures": failures},
        artifacts_json=[{"kind": "run", "id": rid} for rid in run_ids],
    )


# ---------------------------------------------------------------------------
# Stage 7: analysis (LLM aggregates run metrics → SOTA comparison).
# ---------------------------------------------------------------------------


async def stage_7_analysis(ctx: StageContextLike, db: Session) -> StageResult:
    """Aggregate metrics across the experiment's runs + LLM writes a SOTA
    comparison + stability / fairness judgement. Reads RunMetrics +
    Benchmark rows; produces a verdict the report stage can quote.
    """
    import asyncio as _a
    import json as _json
    from app.db.models import Benchmark, Experiment, ExperimentRun, RunMetric

    exp = db.get(Experiment, ctx.experiment_id)
    if exp is None:
        raise ValueError("experiment missing for analysis")
    runs = db.scalars(
        select(ExperimentRun).where(
            ExperimentRun.experiment_id == ctx.experiment_id
        )
    ).all()
    # Gather last value per (run, metric_name).
    series: list[dict] = []
    for run in runs:
        ms = db.scalars(
            select(RunMetric).where(
                RunMetric.run_id == run.id
            ).order_by(RunMetric.step)
        ).all()
        last: dict[str, float] = {}
        for m in ms:
            last[m.metric_name] = m.metric_value
        if last:
            series.append({"run_id": run.id, "status": run.status, "metrics": last})

    sota_rows = db.scalars(
        select(Benchmark).where(
            Benchmark.kind == "sota",
            Benchmark.experiment_id == ctx.experiment_id,
        )
    ).all() if hasattr(Benchmark, "experiment_id") else []
    sota_lines = [f"{b.name}: {b.metric_name}={b.metric_value}" for b in sota_rows[:6]]

    user_msg = (
        f"实验标题:{exp.title}\n"
        f"运行数:{len(series)}\n"
        f"指标末值:\n" + _json.dumps(series, ensure_ascii=False, default=str)
        + "\nSOTA 基准:\n" + ("\n".join(sota_lines) if sota_lines else "(无)")
    )
    try:
        raw = await _a.to_thread(
            _llm_chat,
            [
                {"role": "system", "content": _ANALYSIS_SYSTEM},
                {"role": "user", "content": user_msg + "\n\n输出 JSON。"},
            ],
        )
        parsed = _safe_json_load(raw) or {}
    except Exception as exc:  # noqa: BLE001
        parsed = {"recommendation": "inconclusive", "error": str(exc)}

    summary = {
        "title": "Stage 7 — 结果分析与 SOTA 对比",
        "best_run": parsed.get("best_run"),
        "best_metric": parsed.get("best_metric"),
        "vs_sota": parsed.get("vs_sota", ""),
        "stability": parsed.get("stability", ""),
        "fairness": parsed.get("fairness", ""),
        "recommendation": parsed.get("recommendation", "inconclusive"),
        "next_steps": parsed.get("next_steps", []),
        "series": series,
        "ai_judgement": parsed.get("stability") or "分析完成,请查看结论。",
        "risks": parsed.get("fairness", "").split("。") if parsed.get("fairness") else [],
    }
    return StageResult(
        summary=summary,
        outputs_json={"analysis": parsed, "series": series},
    )


# ---------------------------------------------------------------------------
# Stage 8: report (LLM assembles all stage outputs into Markdown).
# ---------------------------------------------------------------------------


async def stage_8_report(ctx: StageContextLike, db: Session) -> StageResult:
    """LLM stitches the 9 stages' outputs into a reproducible / auditable
    Markdown report. Reads each stage row's outputs_json + writes the report
    file into the experiment dir.
    """
    import asyncio as _a
    from app.config import get_settings
    from app.db.models import Experiment, ExperimentStage
    from app.workspace.manager import WorkspaceManager

    exp = db.get(Experiment, ctx.experiment_id)
    if exp is None:
        raise ValueError("experiment missing for report")
    rows = db.scalars(
        select(ExperimentStage).where(
            ExperimentStage.experiment_id == ctx.experiment_id
        ).order_by(ExperimentStage.stage_key)
    ).all()
    stage_dump: list[str] = []
    for r in rows:
        outs = json.loads(r.outputs_json) if r.outputs_json else None
        stage_dump.append(f"### {r.stage_key} (status={r.status})\n{json.dumps(outs, ensure_ascii=False, default=str)[:1200]}")

    user_msg = (
        f"实验标题:{exp.title}\n"
        f"研究问题:{exp.research_question}\n"
        f"假设:{exp.hypothesis}\n\n"
        f"各阶段产物(节选):\n" + "\n\n".join(stage_dump)
    )
    try:
        markdown = await _a.to_thread(
            _llm_chat,
            [
                {"role": "system", "content": _REPORT_SYSTEM},
                {"role": "user", "content": user_msg + "\n\n生成报告。"},
            ],
        )
    except Exception as exc:  # noqa: BLE001
        markdown = f"# 实验报告\n\n(LLM 生成失败: {exc})\n\n## 阶段产物\n\n" + "\n\n".join(stage_dump)

    # Persist the report to the experiment dir (sandboxed write).
    settings = get_settings()
    exp_root = (settings.projects_root / exp.root_path).resolve()
    report_path = exp_root / "REPORT.md"
    try:
        from app.db.models import Project
        project = db.get(Project, exp.project_id)
        if project is not None:
            WorkspaceManager().safe_write(
                project.slug, report_path, markdown.encode("utf-8")
            )
    except Exception as exc:  # noqa: BLE001
        logger.warning("failed to write REPORT.md for %s: %s", ctx.experiment_id, exc)

    return StageResult(
        summary={
            "title": "Stage 8 — 实验报告",
            "report_path": str(report_path),
            "preview": markdown[:3000],
        },
        outputs_json={"markdown": markdown},
        artifacts_json=[{"kind": "report", "path": "REPORT.md"}],
    )


# ---------------------------------------------------------------------------
# Phase composition functions
# ---------------------------------------------------------------------------
# Each phase function runs one or more atomic step functions in order and
# returns a single StageResult whose `summary` is the merge of the atomic
# summaries (with a phase-level title + ai_judgement). The orchestrator only
# sees this merged result, so it still checkpoints once per phase.
#
# Why merge by `**`? The atomic step summaries mostly have disjoint keys
# (stage_0 uses research_question/hypothesis/checklist; stage_1 uses
# datasets/tasks/sota/warnings; stage_2 uses goal/metrics/baselines/...;
# etc.). When keys DO collide the later step wins (the closer-to-execution
# state is the more accurate one for the user to confirm).

def _merge(parts: list[StageResult], *, title: str, ai_judgement: str) -> StageResult:
    summary: dict[str, Any] = {}
    outputs: dict[str, Any] = {}
    artifacts: list[dict[str, Any]] = []
    for p in parts:
        summary.update(p.summary)
        outputs.update(p.outputs_json)
        artifacts.extend(p.artifacts_json)
    # 阶段级标题/结论最后写入:原子步骤的同名键不应覆盖掉确认卡上
    # 展示的阶段标题(此前 "① 需求与基准" 会被 "Stage 1 — …" 顶掉)。
    summary["title"] = title
    summary["ai_judgement"] = ai_judgement
    return StageResult(summary=summary, outputs_json=outputs, artifacts_json=artifacts)


async def phase_0_scope(ctx: StageContextLike, db: Session) -> StageResult:
    """Phase 0: 需求与基准 — 校验研究问题并检索基准/SOTA。"""
    a = await stage_0_init(ctx, db)
    b = await stage_1_benchmarks(ctx, db)
    return _merge(
        [a, b],
        title="① 需求与基准",
        ai_judgement=(
            "已校验研究问题并按方向检索候选数据/任务/SOTA。"
            "请确认主基准与备选基准;确认后进入方案设计。"
        ),
    )


async def phase_1_plan(ctx: StageContextLike, db: Session) -> StageResult:
    """Phase 1: 方案设计 — LLM 输出方案 + 指标 + 基线。"""
    p = await stage_2_plan(ctx, db)
    return _merge(
        [p],
        title="② 方案设计",
        ai_judgement=(
            "已基于研究问题与候选基准生成方案。"
            "请确认指标、基线与运行配置;确认后进入代码生成。"
        ),
    )


async def phase_2_build(ctx: StageContextLike, db: Session) -> StageResult:
    """Phase 2: 代码与自检 — 生成代码 → smoke 自迭代 → 环境探测。"""
    cg = await stage_3_codegen(ctx, db)
    sm = await stage_4_static_check(ctx, db)
    env = await stage_5_env_check(ctx, db)
    passed = bool(sm.outputs_json.get("passed"))
    return _merge(
        [cg, sm, env],
        title="③ 代码与自检",
        ai_judgement=(
            "代码已生成,smoke 测试通过,可继续运行。"
            if passed
            else "smoke 自检未通过(已自迭代修复 3 次)。"
                 "建议查看日志后选择重跑或手动修复。"
        ),
    )


async def phase_3_run(ctx: StageContextLike, db: Session) -> StageResult:
    """Phase 3: 运行实验 — 串行执行各 run_spec。"""
    r = await stage_6_run(ctx, db)
    failures = r.outputs_json.get("failures") or []
    return _merge(
        [r],
        title="④ 运行实验",
        ai_judgement=(
            f"已完成 {len(r.outputs_json.get('run_ids') or [])} 个 run。"
            + (f"{len(failures)} 个失败。" if failures else "全部成功。")
        ),
    )


async def phase_4_report(ctx: StageContextLike, db: Session) -> StageResult:
    """Phase 4: 分析与报告 — SOTA 对比 + 生成 Markdown 报告。"""
    a = await stage_7_analysis(ctx, db)
    rp = await stage_8_report(ctx, db)
    return _merge(
        [a, rp],
        title="⑤ 分析与报告",
        ai_judgement=(
            "已生成实验报告与 SOTA 对比;请确认后结束本轮实验。"
        ),
    )


# ---------------------------------------------------------------------------
# Registry
# ---------------------------------------------------------------------------
# Defined AFTER the phase functions so the forward references resolve at
# module import time. The 5 entries here are what `STAGE_KEYS` enumerates.

STAGE_REGISTRY: dict[str, StageDef] = {
    "phase_0_scope": StageDef(
        key="phase_0_scope",
        name_zh=STAGE_NAME_ZH["phase_0_scope"],
        description="确认研究问题与假设,检索数据集 / 任务 / SOTA",
        requires_user=STAGE_POLICY["phase_0_scope"]["requires_user"],
        optional_user=STAGE_POLICY["phase_0_scope"]["optional_user"],
        expected_seconds=90,
        depends_on=STAGE_DEPENDS_ON["phase_0_scope"],
        run_fn=phase_0_scope,
    ),
    "phase_1_plan": StageDef(
        key="phase_1_plan",
        name_zh=STAGE_NAME_ZH["phase_1_plan"],
        description="LLM 生成实验方案 / 指标 / 基线",
        requires_user=STAGE_POLICY["phase_1_plan"]["requires_user"],
        optional_user=STAGE_POLICY["phase_1_plan"]["optional_user"],
        expected_seconds=120,
        depends_on=STAGE_DEPENDS_ON["phase_1_plan"],
        run_fn=phase_1_plan,
    ),
    "phase_2_build": StageDef(
        key="phase_2_build",
        name_zh=STAGE_NAME_ZH["phase_2_build"],
        description="生成代码 → smoke 自迭代修复 → 环境探测",
        requires_user=STAGE_POLICY["phase_2_build"]["requires_user"],
        optional_user=STAGE_POLICY["phase_2_build"]["optional_user"],
        expected_seconds=360,
        depends_on=STAGE_DEPENDS_ON["phase_2_build"],
        run_fn=phase_2_build,
    ),
    "phase_3_run": StageDef(
        key="phase_3_run",
        name_zh=STAGE_NAME_ZH["phase_3_run"],
        description="执行各 run 配置(高成本)",
        requires_user=STAGE_POLICY["phase_3_run"]["requires_user"],
        optional_user=STAGE_POLICY["phase_3_run"]["optional_user"],
        expected_seconds=600,
        depends_on=STAGE_DEPENDS_ON["phase_3_run"],
        run_fn=phase_3_run,
    ),
    "phase_4_report": StageDef(
        key="phase_4_report",
        name_zh=STAGE_NAME_ZH["phase_4_report"],
        description="对比 SOTA + 生成可复现实验报告",
        requires_user=STAGE_POLICY["phase_4_report"]["requires_user"],
        optional_user=STAGE_POLICY["phase_4_report"]["optional_user"],
        expected_seconds=210,
        depends_on=STAGE_DEPENDS_ON["phase_4_report"],
        run_fn=phase_4_report,
    ),
}


def get_stage(key: str) -> StageDef:
    """Look up a stage by key. Raises KeyError if the key is unknown."""
    sd = STAGE_REGISTRY.get(key)
    if sd is None:
        raise KeyError(f"unknown stage_key: {key!r}; expected one of {STAGE_KEYS}")
    return sd


# ---------------------------------------------------------------------------
# Stage snapshot helpers (used by the orchestrator)
# ---------------------------------------------------------------------------


def upsert_stage(
    db: Session,
    *,
    experiment_id: str,
    stage_key: str,
    status: StageStatus,
    inputs: dict[str, Any] | None = None,
    outputs: dict[str, Any] | None = None,
    artifacts: list[dict[str, Any]] | None = None,
    config: dict[str, Any] | None = None,
    logs: list[dict[str, Any]] | None = None,
    user_decisions: list[dict[str, Any]] | None = None,
    dependencies: list[str] | None = None,
    invalidated_by: str | None = None,
    bump_version: bool = False,
) -> "ExperimentStage":
    """Insert-or-update the (experiment_id, stage_key) row.

    For stage 0..8, this is a single row per stage_key. New runs of the
    same stage re-write the same row (the orchestrator keeps the latest
    version) unless `bump_version=True`, which creates a new row.

    Returns the ExperimentStage row written.
    """
    from app.db.models import ExperimentStage

    row = db.scalar(
        select(ExperimentStage).where(
            ExperimentStage.experiment_id == experiment_id,
            ExperimentStage.stage_key == stage_key,
        )
    )
    is_new = row is None
    if is_new:
        row = ExperimentStage(
            id=new_id("stage"),
            experiment_id=experiment_id,
            stage_key=stage_key,
            version=1,
            status=status,
        )
        db.add(row)
    else:
        if bump_version:
            row.version = (row.version or 1) + 1
        row.status = status

    if inputs is not None:
        row.inputs_json = json.dumps(inputs, ensure_ascii=False)
    if outputs is not None:
        row.outputs_json = json.dumps(outputs, ensure_ascii=False)
    if artifacts is not None:
        row.artifacts_json = json.dumps(artifacts, ensure_ascii=False)
    if config is not None:
        row.config_json = json.dumps(config, ensure_ascii=False)
    if logs is not None:
        row.logs_json = json.dumps(logs, ensure_ascii=False)
    if user_decisions is not None:
        row.user_decisions_json = json.dumps(user_decisions, ensure_ascii=False)
    if dependencies is not None:
        row.dependencies = json.dumps(dependencies, ensure_ascii=False)
    if invalidated_by is not None:
        row.invalidated_by_stage_id = invalidated_by

    now = datetime.now(UTC)
    if status == "running" and row.started_at is None:
        row.started_at = now
    if status in ("completed", "failed", "skipped", "archived"):
        row.ended_at = now

    db.flush()
    return row


def get_stage_row(db: Session, experiment_id: str, stage_key: str) -> "ExperimentStage | None":
    """Read the latest (experiment_id, stage_key) row, or None."""
    from app.db.models import ExperimentStage

    return db.scalar(
        select(ExperimentStage).where(
            ExperimentStage.experiment_id == experiment_id,
            ExperimentStage.stage_key == stage_key,
        )
    )


def mark_downstream_outdated(
    db: Session,
    experiment_id: str,
    upstream_stage_key: str,
    invalidated_by_stage_id: str,
) -> list[str]:
    """Mark every stage that depends on `upstream_stage_key` as `outdated`.

    Returns the list of stage_keys that were marked outdated. The rows
    stay in DB (the user can still see the old outputs) but their status
    flips so the front-end Badge: outdated appears and the orchestrator
    won't re-run them until the user explicitly approves.
    """
    from app.db.models import ExperimentStage
    from app.experiments.states import downstream_of

    targets = downstream_of(upstream_stage_key)
    if not targets:
        return []
    rows = db.scalars(
        select(ExperimentStage).where(
            ExperimentStage.experiment_id == experiment_id,
            ExperimentStage.stage_key.in_(targets),
            ExperimentStage.status.notin_(["outdated", "archived"]),
        )
    ).all()
    for r in rows:
        r.status = "outdated"
        r.invalidated_by_stage_id = invalidated_by_stage_id
        r.updated_at = datetime.now(UTC)
    db.flush()
    return [r.stage_key for r in rows]
