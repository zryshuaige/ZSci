"""Writing agent skill (design.md §17.4, §13.6).

Generates a LaTeX section draft using ONLY verified citations + completed runs.
Verifies citations and reports missing ones. Registered as an Agent skill.
"""
from __future__ import annotations

import json
import logging

from sqlalchemy import select
from sqlalchemy.orm import Session

from app.agent.prompts import WRITING_SYSTEM
from app.agent.service import register_skill
from app.agent.state import ResearchAgentState
from app.db.models import AgentTask, Experiment, ExperimentRun, Paper, Project
from app.llm.gateway import ModelNotConfigured, get_gateway
from app.pdf.bib import _cite_key
from app.workspace.manager import audit
from app.writing.latex import writing_root

logger = logging.getLogger("zsci.agent.writing")


def _safe_json(text: str) -> dict:
    import re

    fence = re.search(r"```(?:json)?\s*(\{.*?\})\s*```", text, re.DOTALL)
    if fence:
        text = fence.group(1)
    m = re.search(r"\{.*\}", text, re.DOTALL)
    try:
        return json.loads(m.group(0)) if m else {}
    except ValueError:
        return {}


@register_skill("writing.draft_section")
def draft_section(db: Session, state: ResearchAgentState) -> ResearchAgentState:
    """Draft a LaTeX section. Only uses verified papers + completed runs."""
    gw = get_gateway()
    if not gw.is_configured("default_chat"):
        raise ModelNotConfigured("default_chat")

    project = db.get(Project, state["project_id"])
    if project is None:
        raise ValueError("Project not found")

    inp = json.loads(db.get(AgentTask, state["task_id"]).input_json or "{}")
    section_name = inp.get("section_name", "related_work")
    requested_keys = set(inp.get("citation_keys", []))
    requested_runs = set(inp.get("run_ids", []))
    notes = inp.get("notes", "")

    # Available verified citations.
    papers = db.scalars(
        select(Paper).where(Paper.project_id == project.id, Paper.downloaded.is_(True))
    ).all()
    cite_map = {_cite_key(p): p for p in papers}
    available_keys = set(cite_map.keys())
    usable_keys = (requested_keys & available_keys) or list(available_keys)[:10]

    # Completed runs, scoped to THIS project to prevent cross-project leaks.
    runs = db.scalars(
        select(ExperimentRun)
        .join(Experiment, ExperimentRun.experiment_id == Experiment.id)
        .where(
            Experiment.project_id == project.id,
            ExperimentRun.status == "completed",
        )
    ).all()
    usable_runs = [r for r in runs if (not requested_runs or r.id in requested_runs)][:10]

    context = {
        "section": section_name,
        "available_citation_keys": sorted(usable_keys),
        "completed_runs": [{"run_id": r.id, "command": r.command, "seed": r.seed} for r in usable_runs],
        "user_notes": notes,
    }
    messages = [
        {"role": "system", "content": WRITING_SYSTEM},
        {"role": "user", "content": f"为章节 {section_name} 生成 LaTeX 草稿。可用资源:\n{json.dumps(context, ensure_ascii=False, indent=2)}"},
    ]
    raw = gw.chat(messages, role="default_chat", temperature=0.3, max_tokens=2500)
    parsed = _safe_json(raw)

    tex_body = parsed.get("tex_body", "")
    cited = parsed.get("cited_papers", [])
    missing = [k for k in cited if k not in available_keys]
    used_runs = parsed.get("used_runs", [])

    # Write the draft to the section file.
    root = writing_root(project.slug)
    sec_path = root / "sections" / f"{section_name}.tex"
    sec_path.parent.mkdir(parents=True, exist_ok=True)
    sec_path.write_text(tex_body, encoding="utf-8")
    audit(db, action_type="writing.draft", project_id=project.id, target=str(sec_path),
          payload={"section": section_name, "cited": cited, "missing": missing})

    state["result"] = {
        "section": section_name,
        "tex_path": str(sec_path.relative_to(root)),
        "cited_papers": cited,
        "used_runs": used_runs,
        "missing_citations": missing,
        "claims_to_verify": parsed.get("claims_to_verify", []),
    }
    state["evidence"] = [
        {
            "kind": "事实",
            "claim": f"为章节 {section_name} 生成 LaTeX 草稿,引用 {len(cited)} 篇,使用 {len(used_runs)} 个 run",
            "source_type": "user_note",
            "citation": "writing agent",
        }
    ]
    state["final_response"] = (
        f"已生成 {section_name} 草稿并写入 sections/{section_name}.tex。"
        + (f"⚠️ {len(missing)} 个引用未在已下载论文中找到,需补充:{', '.join(missing[:5])}。" if missing else "引用校验通过。")
    )
    return state
