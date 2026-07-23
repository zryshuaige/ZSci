"""Autonomous experiment orchestrator (design.md §9.6, §10).

Ties the Phase A-C pieces together into a fully-autonomous run:
  1. find_benchmarks (PapersWithCode + HF)
  2. gather context + generate_code (LLM §10 prompt, safe_write to disk)
  3. smoke_test (run + LLM-patch loop, capped)
  4. run_experiments (baseline + ablations)
  5. finalize (status + summary)

Runs in the background via asyncio.create_task, started by the
POST /experiments/{id}/autonomous endpoint. Each step commits its events in a
fresh session so the existing GET /agent/tasks/{id}/stream SSE endpoint streams
progress in real time (the synchronous run_task only flushes, never commits
mid-skill, so long tasks were invisible until the end).

Fully autonomous per the user's decision: the orchestrator invokes
run_experiment directly, bypassing the §16.2 `confirmed` gate that the manual
create_run endpoint enforces. Safety is preserved by run_experiment's sandbox:
cwd is locked to the experiment dir (assert_within_project), the subprocess env
is an allowlist (no LLM API keys leak), and every run gets an audit row.
"""
from __future__ import annotations

import asyncio
import json
import logging
from pathlib import Path

from sqlalchemy.orm import Session

from app.config import get_settings
from app.db.models import AgentTask, AgentTaskEvent, Experiment, ExperimentRun, Project
from app.db.session import get_sessionmaker
from app.experiments.benchmarks import find_and_store_benchmarks
from app.experiments.codegen import generate_experiment_code
from app.experiments.runner import run_experiment
from app.experiments.smoke import run_smoke_with_iteration
from app.utils import new_id
from app.workspace.manager import WorkspaceManager

logger = logging.getLogger("zsci.experiments.orchestrator")

MAX_SMOKE_ATTEMPTS = 3
SessionLocal = None  # resolved lazily so tests importing this module don't need a DB


def _sessions():
    global SessionLocal
    if SessionLocal is None:
        SessionLocal = get_sessionmaker()
    return SessionLocal


def _emit(db: Session, task_id: str, kind: str, message: str, payload: dict | None = None) -> None:
    """Append an event and commit immediately so the SSE stream sees it live."""
    payload_json = None
    if payload is not None:
        try:
            payload_json = json.dumps(payload, ensure_ascii=False, default=str)
        except (TypeError, ValueError):
            payload_json = json.dumps(str(payload), ensure_ascii=False)
    db.add(AgentTaskEvent(id=new_id("evt"), task_id=task_id, kind=kind, message=message, payload_json=payload_json))
    db.commit()


def _set_status(db: Session, task: AgentTask, status: str, error: str | None = None) -> None:
    task.status = status
    if error is not None:
        task.error = error
    db.commit()


def _exp_root(exp: Experiment) -> Path:
    return (get_settings().projects_root / exp.root_path).resolve()


async def run_autonomous_experiment(
    *,
    task_id: str,
    experiment_id: str,
    project_id: str,
    input_data: dict,
) -> None:
    """Background entrypoint. Each stage opens its own DB session + commits events."""
    ws = WorkspaceManager()

    research_question = (input_data.get("research_question") or "").strip()
    selected_papers = input_data.get("selected_papers", []) or []
    selected_repositories = input_data.get("selected_repositories", []) or []
    benchmarks_query = input_data.get("benchmarks_query") or research_question
    run_specs = input_data.get("run_configs") or ["baseline"]

    try:
        await _stage_benchmarks(task_id, experiment_id, project_id, benchmarks_query)
        await _stage_codegen(ws, task_id, experiment_id, project_id, research_question,
                             selected_papers, selected_repositories)
        smoke_ok = await _stage_smoke(ws, task_id, experiment_id)
        if not smoke_ok:
            with _sessions()() as db:
                _set_status(db, db.get(AgentTask, task_id), "failed", "smoke test 未通过,已停止(见历史)")
            return
        await _stage_runs(task_id, experiment_id, project_id, run_specs)
        await _stage_finalize(task_id, experiment_id)
        with _sessions()() as db:
            _set_status(db, db.get(AgentTask, task_id), "completed")
    except Exception as exc:  # noqa: BLE001
        logger.exception("autonomous experiment %s failed", task_id)
        with _sessions()() as db:
            _set_status(db, db.get(AgentTask, task_id), "failed", str(exc))


async def _stage_benchmarks(task_id, experiment_id, project_id, query) -> None:
    with _sessions()() as db:
        _emit(db, task_id, "step", "阶段 1/5:查找 benchmark")
    if not query:
        return
    # find_and_store_benchmarks is sync (httpx.Client); run off the event loop.
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
        # Surface source failures (timeouts/mirror fallback) so the user knows
        # why benchmark results may be thin - a silent empty list looks like the
        # agent did nothing.
        for w in warnings:
            _emit(db, task_id, "warning", w)
        _emit(db, task_id, "step", f"阶段 1/5 完成:找到 {len(rows)} 个 benchmark(SOTA {len(sota)})", {
            "benchmarks": [{"name": r.name, "kind": r.kind, "metric": r.metric_name, "value": r.metric_value} for r in rows],
        })


async def _stage_codegen(ws, task_id, experiment_id, project_id,
                         research_question, selected_papers, selected_repositories) -> None:
    with _sessions()() as db:
        _emit(db, task_id, "step", "阶段 2/5:生成实验代码")
    # generate_experiment_code makes a sync LLM call; run off the event loop.
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


async def _stage_smoke(ws, task_id, experiment_id) -> bool:
    with _sessions()() as db:
        _emit(db, task_id, "step", "阶段 3/5:smoke test(自迭代修复)")
        exp = db.get(Experiment, experiment_id)
        plan = json.loads(exp.plan_json) if exp.plan_json else {}
        smoke_cmd = plan.get("smoke_command") or "uv run python -m src.train experiment=smoke trainer.epochs=1"
    # run_smoke_with_iteration is async and manages its own commits on the passed session.
    # Open one session, keep it alive across the await (it spans subprocess runs).
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


async def _stage_runs(task_id, experiment_id, project_id, specs) -> None:
    with _sessions()() as db:
        _emit(db, task_id, "step", f"阶段 4/5:运行实验({len(specs)} 个配置)")
        exp = db.get(Experiment, experiment_id)
        plan = json.loads(exp.plan_json) if exp.plan_json else {}
        baseline_cmd = plan.get("run_command") or "uv run python -m src.train experiment=baseline"
    run_ids: list[str] = []
    for spec in specs:
        # A spec is either a command string (override) or a label (use baseline run_command).
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
                exp_slug=exp.slug or "", exp_root=_exp_root(exp), project_id=project.id, seed=42,
            )
            db.commit()
            db.refresh(run)
            run_ids.append(run.id)
    with _sessions()() as db:
        _emit(db, task_id, "step", f"阶段 4/5 完成:{len(run_ids)} 个 run", {"run_ids": run_ids})


async def _stage_finalize(task_id, experiment_id) -> None:
    with _sessions()() as db:
        _emit(db, task_id, "step", "阶段 5/5:汇总与 SOTA 对比")
        exp = db.get(Experiment, experiment_id)
        exp.status = "done"
        db.commit()
