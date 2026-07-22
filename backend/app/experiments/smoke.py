"""Smoke-test self-iteration (design.md §10 rule 10, §9.6).

After code generation, runs the smoke command and, on failure, feeds the stderr
back to the LLM to patch the affected files, then re-runs. Capped at
max_attempts so a broken generation can't burn tokens forever.
"""
from __future__ import annotations

import logging

from sqlalchemy.orm import Session

from app.config import get_settings
from app.db.models import Experiment, ExperimentRun
from app.experiments.codegen import CODEGEN_SYSTEM, _safe_json_load, _safe_rel_path
from app.experiments.runner import run_experiment
from app.llm.gateway import ModelNotConfigured, get_gateway
from app.workspace.manager import WorkspaceManager
from app.workspace.sandbox import assert_within_project

logger = logging.getLogger("zsci.experiments.smoke")

SMOKE_FIX_SYSTEM = CODEGEN_SYSTEM + """

你现在在修复 smoke test 报错。给定失败的命令和 stderr,请输出修复后的完整受影响文件(只含需要改动的文件)。
JSON 结构同前,但 files 只包含受影响的文件。不要解释,直接给 JSON。
"""


async def _read_run_logs(project_slug: str, run: ExperimentRun) -> str:
    if not run.run_path:
        return ""
    settings = get_settings()
    # run.run_path is relative to the project dir (projects_root / <slug>).
    run_dir = (settings.projects_root / project_slug / run.run_path).resolve()
    try:
        assert_within_project(project_slug, run_dir)
    except Exception:  # noqa: BLE001
        return ""
    parts: list[str] = []
    for name in ("stdout.log", "stderr.log"):
        p = run_dir / name
        if p.exists():
            parts.append(f"=== {name} ===\n" + p.read_text(encoding="utf-8", errors="replace")[-4000:])
    return "\n\n".join(parts)


async def run_smoke_with_iteration(
    db: Session,
    ws: WorkspaceManager,
    *,
    experiment: Experiment,
    project,
    smoke_command: str,
    max_attempts: int = 3,
) -> dict:
    """Run the smoke command, LLM-patch on failure, re-run. Returns a dict with
    `attempts`, `passed`, last run, and any fix history.

    Raises ModelNotConfigured if no LLM is configured (needed for the fix loop).
    """
    gw = get_gateway()
    if not gw.is_configured("default_chat"):
        raise ModelNotConfigured("default_chat")

    settings = get_settings()
    exp_root = (settings.projects_root / experiment.root_path).resolve()
    assert_within_project(project.slug, exp_root)

    history: list[dict] = []
    last_run: ExperimentRun | None = None
    for attempt in range(1, max_attempts + 1):
        run = ExperimentRun(id=f"smoke_{experiment.id}_{attempt}", experiment_id=experiment.id, status="created")
        db.add(run)
        db.flush()
        await run_experiment(
            db,
            run=run,
            command=smoke_command,
            project_slug=project.slug,
            exp_slug=experiment.slug or "",
            exp_root=exp_root,
            project_id=project.id,
        )
        db.commit()
        db.refresh(run)
        last_run = run

        if run.status == "completed":
            history.append({"attempt": attempt, "passed": True})
            return {"attempts": attempt, "passed": True, "last_run_id": run.id, "history": history}

        logs = await _read_run_logs(project.slug, run)
        history.append({
            "attempt": attempt,
            "passed": False,
            "status": run.status,
            "stderr_tail": logs[-1500:],
        })
        if attempt >= max_attempts:
            break

        # Ask the LLM to patch.
        messages = [
            {"role": "system", "content": SMOKE_FIX_SYSTEM},
            {"role": "user", "content": f"失败的命令:\n{smoke_command}\n\n输出日志:\n{logs}\n\n请输出修复后的完整受影响文件 JSON。"},
        ]
        raw = gw.chat(messages, role="default_chat", temperature=0.1, max_tokens=8000)
        parsed = _safe_json_load(raw)
        if not parsed or not isinstance(parsed.get("files"), list):
            history[-1]["fix_result"] = "LLM 未返回有效文件,跳过修复"
            continue
        patched = 0
        for f in parsed["files"]:
            if not isinstance(f, dict):
                continue
            target = _safe_rel_path(exp_root, f.get("path", ""))
            content = f.get("content", "")
            if target is None or not isinstance(content, str) or not content.strip():
                continue
            ws.safe_write(project.slug, target, content.encode("utf-8"))
            patched += 1
        history[-1]["fix_result"] = f"修补了 {patched} 个文件"

    return {"attempts": max_attempts, "passed": False, "last_run_id": last_run.id if last_run else None, "history": history}
