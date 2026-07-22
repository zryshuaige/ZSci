"""Experiment code generation (design.md §10, §9.6 experiment.generate_code).

Asks the LLM to produce a file-level plan + complete runnable code for an
experiment, grounded in the research question/hypothesis, benchmark info, and
official-code/paper context. Writes the files into the experiment dir via the
sandboxed WorkspaceManager.safe_write, overwriting the scaffold placeholders.

Constraints from design.md §10 are baked into the system prompt: must include
baseline/seed/config/logs/metrics/checkpoint/smoke/eval; must not fabricate
hyperparameters or results; metrics must use `METRIC step=<n> <name>=<value>`.
"""
from __future__ import annotations

import json
import logging
import re
from pathlib import Path

from sqlalchemy import select
from sqlalchemy.orm import Session

from app.config import get_settings
from app.db.models import Benchmark, Experiment, Paper, Repository
from app.llm.gateway import ModelNotConfigured, get_gateway
from app.workspace.manager import WorkspaceManager
from app.workspace.sandbox import assert_within_project

logger = logging.getLogger("zsci.experiments.codegen")

CODEGEN_SYSTEM = """你是计算机科学实验实现助手。任务是为当前研究假设设计或修改实验代码。

必须遵循:
1. 首先列出与当前实验最相关的论文。
2. 优先使用论文明确提到的官方代码链接(若提供)。
3. 若不存在可验证的官方代码,明确说明"未找到可验证的官方代码,本方案参考社区实现或自行设计",不得把未确认仓库称为官方代码。
4. 不得捏造论文中的超参数、训练轮数、数据增强、指标或实验结果。
5. 不得将"代码预期效果"描述为"实验已验证效果"。
6. 所有实验必须包含:baseline、随机种子、配置文件、日志、指标保存、checkpoint、最小 smoke test、评估脚本。
7. 指标必须以 `METRIC step=<n> <name>=<value>` 格式打到 stdout,系统据此解析曲线。

输出必须是单个 JSON 对象(不要 markdown 代码块),结构如下:
{
  "relevant_papers": ["论文标题或 id"],
  "official_code_note": "官方代码情况说明",
  "plan": [{"file": "src/train.py", "action": "create|modify", "responsibility": "..."}],
  "files": [{"path": "src/train.py", "content": "...完整文件内容..."}],
  "run_command": "uv run python -m src.train experiment=baseline",
  "smoke_command": "uv run python -m src.train experiment=smoke trainer.epochs=1",
  "risks": ["..."]
}
files 里 path 相对实验根目录,只含字母数字/_-.,不得含 .. 或绝对路径。content 必须是完整可运行文件。
"""


def _safe_json_load(text: str) -> dict | None:
    """Extract the first JSON object from an LLM response (tolerates fences)."""
    fence = re.search(r"```(?:json)?\s*(\{.*?\})\s*```", text, re.DOTALL)
    if fence:
        text = fence.group(1)
    m = re.search(r"\{.*\}", text, re.DOTALL)
    if not m:
        return None
    try:
        v = json.loads(m.group(0))
        return v if isinstance(v, dict) else None
    except ValueError:
        return None


def _build_context(
    db: Session,
    *,
    experiment: Experiment,
    project,
    selected_papers: list[str],
    selected_repositories: list[str],
) -> str:
    parts: list[str] = [
        f"研究问题:{experiment.research_question or '(未指定)'}",
        f"假设/想法:{experiment.hypothesis or '(未指定)'}",
    ]

    bms = db.scalars(
        select(Benchmark)
        .where(Benchmark.project_id == project.id)
        .order_by(Benchmark.created_at.desc())
        .limit(20)
    ).all()
    if bms:
        bm_lines = []
        for b in bms:
            if b.metric_name and b.metric_value is not None:
                extra = f"{b.metric_name}={b.metric_value}"
            else:
                extra = b.dataset_name or b.task_name or ""
            bm_lines.append(f"- [{b.kind}] {b.name} ({b.source}) {extra}".rstrip())
        parts.append("已查到的 benchmark:\n" + "\n".join(bm_lines))

    repo_q = select(Repository).where(Repository.project_id == project.id)
    if selected_repositories:
        repo_q = repo_q.where(Repository.id.in_(selected_repositories))
    repos = db.scalars(repo_q.limit(10)).all()
    if repos:
        repo_lines = [f"- {r.full_name} ({r.official_status}): {r.repo_url}" for r in repos if r.full_name]
        if repo_lines:
            parts.append("相关代码仓库:\n" + "\n".join(repo_lines))

    paper_q = select(Paper).where(Paper.project_id == project.id, Paper.downloaded.is_(True))
    if selected_papers:
        paper_q = paper_q.where(Paper.id.in_(selected_papers))
    papers = db.scalars(paper_q.limit(8)).all()
    if papers:
        p_lines = [f"- {p.title} ({p.year or ''} {p.venue or ''}) arxiv={p.arxiv_id or ''}" for p in papers if p.title]
        if p_lines:
            parts.append("相关论文:\n" + "\n".join(p_lines))

    return "\n\n".join(parts)


def _safe_rel_path(exp_root: Path, rel: str) -> Path | None:
    """Validate a model-supplied path: no absolute, no traversal, within exp_root.

    The `..` check MUST run before any normalization: str.lstrip("./") eats the
    leading dots of `../escape.py` (it strips a char SET, not a prefix), turning
    it into `escape.py` which then resolves inside exp_root and passes the
    relative_to check - a sandbox escape. So we reject any path whose segments
    contain `..` or that's absolute, then resolve + relative_to as a backstop.
    """
    if not rel or not isinstance(rel, str):
        return None
    # Strip a single leading "./" prefix only (not a char set).
    if rel.startswith("./"):
        rel = rel[2:]
    if rel.startswith("/") or rel.startswith("\\"):
        return None
    parts = Path(rel).parts
    if ".." in parts or "." in parts:
        return None
    p = (exp_root / rel).resolve()
    try:
        p.relative_to(exp_root.resolve())
    except ValueError:
        return None
    return p


def generate_experiment_code(
    db: Session,
    ws: WorkspaceManager,
    *,
    experiment: Experiment,
    project,
    selected_papers: list[str] | None = None,
    selected_repositories: list[str] | None = None,
) -> dict:
    """Generate + write experiment code. Returns a result dict with the plan,
    the list of files written, and the run/smoke commands.

    Raises ModelNotConfigured if no LLM is configured, ValueError if the model
    didn't return valid file JSON.
    """
    gw = get_gateway()
    if not gw.is_configured("default_chat"):
        raise ModelNotConfigured("default_chat")

    settings = get_settings()
    exp_root = (settings.projects_root / experiment.root_path).resolve()
    assert_within_project(project.slug, exp_root)

    context = _build_context(
        db,
        experiment=experiment,
        project=project,
        selected_papers=selected_papers or [],
        selected_repositories=selected_repositories or [],
    )
    messages = [
        {"role": "system", "content": CODEGEN_SYSTEM},
        {"role": "user", "content": f"请为以下实验生成完整可运行代码。\n\n{context}\n\n输出 JSON。"},
    ]
    raw = gw.chat(messages, role="default_chat", temperature=0.2, max_tokens=8000)
    parsed = _safe_json_load(raw)
    if not parsed or not isinstance(parsed.get("files"), list) or not parsed["files"]:
        raise ValueError(f"LLM did not return valid code JSON. Raw: {raw[:500]}")

    files_written: list[str] = []
    for f in parsed["files"]:
        if not isinstance(f, dict):
            continue
        rel = f.get("path", "")
        content = f.get("content", "")
        target = _safe_rel_path(exp_root, rel)
        if target is None or not isinstance(content, str) or not content.strip():
            logger.warning("skipping invalid generated file path: %r", rel)
            continue
        ws.safe_write(project.slug, target, content.encode("utf-8"))
        files_written.append(rel)

    if not files_written:
        raise ValueError("LLM returned no valid files to write.")

    return {
        "relevant_papers": parsed.get("relevant_papers", []),
        "official_code_note": parsed.get("official_code_note", ""),
        "plan": parsed.get("plan", []),
        "files_written": files_written,
        "run_command": parsed.get("run_command") or "uv run python -m src.train experiment=baseline",
        "smoke_command": parsed.get("smoke_command") or "uv run python -m src.train experiment=smoke trainer.epochs=1",
        "risks": parsed.get("risks", []),
        "raw": raw[:2000],
    }
