"""Research skills: trend analysis + hypothesis generation (design.md §9.5).

Both build an evidence pack from the project's downloaded+parsed papers, call
the LLM with the §17 prompt, parse structured JSON, and validate evidence.
"""
from __future__ import annotations

import json
import logging

from sqlalchemy import select
from sqlalchemy.orm import Session

from app.agent.evidence import validate_evidence
from app.agent.prompts import HYPOTHESIS_SYSTEM, TREND_ANALYSIS_SYSTEM
from app.agent.service import register_skill
from app.agent.state import ResearchAgentState
from app.db.models import Paper, ReadingNote
from app.llm.gateway import ModelNotConfigured, get_gateway
from app.pdf.parse import load_extracted_text

logger = logging.getLogger("zsci.agent.research")

MAX_PAPERS_IN_PACK = 12
MAX_PAGES_PER_PAPER = 20


def _build_evidence_pack(
    db: Session, paper_ids: list[str], project_id: str
) -> tuple[str, list[dict]]:
    """Return (markdown pack, raw evidence) from selected/downloaded papers.

    Always scoped to `project_id` to prevent cross-project data leaks.
    """
    if paper_ids:
        papers = db.scalars(
            select(Paper).where(
                Paper.project_id == project_id,
                Paper.id.in_(paper_ids),
            )
        ).all()
    else:
        # default: all downloaded+parsed papers in THIS project
        papers = db.scalars(
            select(Paper).where(
                Paper.project_id == project_id,
                Paper.downloaded.is_(True),
            )
        ).all()

    chunks: list[str] = []
    evidence: list[dict] = []
    for p in papers[:MAX_PAPERS_IN_PACK]:
        extracted = load_extracted_text(p)
        note = db.scalar(
            select(ReadingNote).where(ReadingNote.paper_id == p.id, ReadingNote.kind == "note")
        )
        meta = f"### {p.title}\npaper_id={p.id} | {p.year or ''} | {p.venue or ''} | doi={p.doi or ''} | arxiv={p.arxiv_id or ''}"
        body_parts = [meta]
        if note:
            body_parts.append(f"阅读笔记摘要:\n{note.content[:1500]}")
        if extracted:
            pages = extracted.get("page_texts", [])[:MAX_PAGES_PER_PAPER]
            for pg in pages:
                txt = (pg.get("text") or "").strip()
                if txt:
                    body_parts.append(f"(p.{pg['page']}) {txt[:1200]}")
            evidence.append({
                "kind": "事实",
                "claim": f"论文《{p.title}》已下载并解析,共 {extracted.get('pages')} 页",
                "source_type": "paper",
                "source_id": p.id,
                "citation": f"paper {p.id}",
            })
        else:
            body_parts.append("(未解析,仅有元数据)")
        chunks.append("\n".join(body_parts))

    pack = "\n\n---\n\n".join(chunks) if chunks else "(无可用论文证据)"
    return pack, evidence


def _safe_json_load(text: str) -> dict | None:
    """Extract the first JSON object from an LLM response (tolerates code fences)."""
    import re

    fence = re.search(r"```(?:json)?\s*(\{.*?\}|\[.*?\])\s*```", text, re.DOTALL)
    if fence:
        text = fence.group(1)
    # find first { ... } or [ ... ]
    m = re.search(r"(\{.*\}|\[.*\])", text, re.DOTALL)
    if not m:
        return None
    try:
        return json.loads(m.group(1))
    except ValueError:
        return None


@register_skill("research.trend_analysis")
def trend_analysis(db: Session, state: ResearchAgentState) -> ResearchAgentState:
    pack, evidence = _build_evidence_pack(db, state.get("selected_papers", []), state["project_id"])
    gw = get_gateway()
    if not gw.is_configured("default_chat"):
        raise ModelNotConfigured("default_chat")

    topic = state.get("user_request") or "(未指定研究方向)"
    messages = [
        {"role": "system", "content": TREND_ANALYSIS_SYSTEM},
        {
            "role": "user",
            "content": f"研究主题:{topic}\n\n论文证据包:\n{pack}\n\n请按规则输出 JSON。",
        },
    ]
    raw = gw.chat(messages, role="default_chat", temperature=0.3, max_tokens=3000)
    parsed = _safe_json_load(raw) or {}

    merged_evidence = evidence + parsed.get("evidence", [])
    state["evidence"] = validate_evidence(merged_evidence)
    state["result"] = {
        "timeline": parsed.get("timeline"),
        "method_taxonomy": parsed.get("method_taxonomy"),
        "representative_papers": parsed.get("representative_papers"),
        "tech_route_shifts": parsed.get("tech_route_shifts"),
        "limitations": parsed.get("limitations"),
        "research_gaps": parsed.get("research_gaps"),
        "open_questions": parsed.get("open_questions"),
        "raw": raw[:2000],
    }
    state["final_response"] = (
        f"研究趋势分析完成,基于 {len(evidence)} 篇已解析论文。"
        f"{'⚠️ 部分事实声明缺少来源引用,见 warnings。' if any(e.get('_warning') for e in state['evidence']) else ''}"
    )
    return state


@register_skill("research.generate_hypothesis")
def generate_hypothesis(db: Session, state: ResearchAgentState) -> ResearchAgentState:
    pack, evidence = _build_evidence_pack(db, state.get("selected_papers", []), state["project_id"])
    gw = get_gateway()
    if not gw.is_configured("default_chat"):
        raise ModelNotConfigured("default_chat")

    topic = state.get("user_request") or "(未指定研究方向)"
    messages = [
        {"role": "system", "content": HYPOTHESIS_SYSTEM},
        {
            "role": "user",
            "content": f"研究主题:{topic}\n\n论文证据包:\n{pack}\n\n请生成可验证的研究假设(JSON)。",
        },
    ]
    raw = gw.chat(messages, role="default_chat", temperature=0.4, max_tokens=3000)
    parsed = _safe_json_load(raw) or {}

    hypotheses = parsed.get("hypotheses", [])
    merged_evidence = evidence + parsed.get("evidence", [])
    state["evidence"] = validate_evidence(merged_evidence)
    state["result"] = {"hypotheses": hypotheses, "raw": raw[:2000]}

    # Persist hypotheses as Idea rows for the ideas page.
    from app.db.models import Idea
    from app.utils import new_id

    project_id = state["project_id"]
    for h in hypotheses:
        db.add(
            Idea(
                id=new_id("idea"),
                project_id=project_id,
                title=_idea_title(h),
                hypothesis=h.get("hypothesis") or h.get("problem") or "",
                motivation=h.get("motivation") or "",
                status="hypothesis",
                evidence_json=json.dumps(h.get("evidence"), ensure_ascii=False) if h.get("evidence") else None,
                risks_json=json.dumps(h.get("risks") or h.get("counterexamples"), ensure_ascii=False),
                content=json.dumps(h, ensure_ascii=False, indent=2),
            )
        )
    db.flush()
    state["final_response"] = f"生成了 {len(hypotheses)} 个 idea,已保存到研究想法库。"
    return state


def _idea_title(h: dict) -> str:
    """Pick a title the model actually generated, never a placeholder.

    Preference: explicit name/title field. If the model omitted one, derive a
    concise title from its own hypothesis/problem text (truncated) rather than
    falling back to a generic "未命名 idea" - the user asked the AI to name
    each idea itself.
    """
    name = (h.get("name") or h.get("title") or "").strip()
    if name:
        return name
    body = (h.get("hypothesis") or h.get("problem") or h.get("motivation") or "").strip()
    if body:
        # Take the first clause / ~24 chars so the list view shows something
        # meaningful the AI itself produced.
        first_clause = body.split("。", 1)[0].split("；", 1)[0].split(";", 1)[0]
        first_clause = first_clause.replace("\n", " ").strip()
        if len(first_clause) > 24:
            return first_clause[:24] + "…"
        return first_clause or "未命名 idea"
    return "未命名 idea"
