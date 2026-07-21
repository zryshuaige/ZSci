"""GitHub code search skill (design.md §9.4, §17.2).

Searches the GitHub Search API for repositories matching a paper title / keywords,
judges official-status conservatively (community/unverified by default; only
official if the paper metadata explicitly linked it), and records license + stars.
Does NOT auto-clone; cloning is a separate approval-gated skill.
"""
from __future__ import annotations

import json
import logging
import re

import httpx
from sqlalchemy import select
from sqlalchemy.orm import Session

from app.agent.prompts import CODE_SEARCH_SYSTEM
from app.agent.service import register_skill
from app.agent.state import ResearchAgentState
from app.config import get_settings
from app.db.models import Paper, Repository
from app.llm.gateway import get_gateway
from app.utils import new_id

logger = logging.getLogger("zsci.agent.code")

GITHUB_SEARCH = "https://api.github.com/search/repositories"


def _judge_official(paper: Paper | None, repo_full_name: str, repo_url: str) -> tuple[str, str]:
    """Conservatively judge official status. Returns (status, evidence_note)."""
    if paper is None:
        return "unverified", "未关联论文,无法判定官方性"
    # If the paper's recorded official_code_url matches this repo, it's official.
    if paper.official_code_url:
        # M19: compare normalized URLs (rstrip /, lowercase, strip .git) instead
        # of loose substring match, which produced false positives like
        # "github.com/foo" matching "github.com/foo/bar".
        def _norm(u: str) -> str:
            return u.lower().rstrip("/").removesuffix(".git")

        if _norm(repo_url) == _norm(paper.official_code_url):
            return "official", f"论文元数据明确给出的代码链接匹配:{paper.official_code_url}"
        return "unverified", "论文元数据给出的是其他仓库链接"
    return "unverified", (
        "无明确官方声明。标题/仓库名相似或 Star 数高不能作为 official 依据(design.md §17.2)。"
        "如需标记为 official,请人工核对论文 PDF/作者主页并填写 official_code_url。"
    )


def _github_search_sync(query: str, limit: int = 8) -> list[dict]:
    """Blocking wrapper around the GitHub search for use in sync skills."""
    settings = get_settings()
    headers = {"Accept": "application/vnd.github+json", "User-Agent": "zsci/0.1"}
    params = {"q": query, "sort": "stars", "order": "desc", "per_page": min(limit, 30)}
    try:
        with httpx.Client(timeout=settings.academic_api_timeout) as client:
            resp = client.get(GITHUB_SEARCH, params=params, headers=headers)
            resp.raise_for_status()
            data = resp.json()
    except (httpx.HTTPError, ValueError) as exc:
        logger.warning("GitHub search failed: %s", exc)
        return []
    return data.get("items", [])[:limit]


@register_skill("code.search_github")
def search_github(db: Session, state: ResearchAgentState) -> ResearchAgentState:
    """Search GitHub for repos related to the selected paper(s)."""
    paper_ids = state.get("selected_papers", [])
    if not paper_ids:
        state["warnings"].append("未选择论文,无法进行代码检索")
        state["result"] = {"repositories": []}
        state["final_response"] = "未选择论文,代码检索跳过。"
        return state

    results: list[dict] = []
    for pid in paper_ids:
        paper = db.get(Paper, pid)
        if paper is None:
            continue
        query = paper.title
        items = _github_search_sync(query, limit=8)
        if not items:
            # fallback: try without parentheses / short title
            short = re.sub(r"[\(\)\[\]:]", " ", paper.title)[:80]
            items = _github_search_sync(short, limit=8)

        # Optional LLM-assisted judgment when a model is configured.
        gw = get_gateway()
        llm_verdicts: dict[str, dict] = {}
        if gw.is_configured("default_chat") and items:
            try:
                payload = json.dumps(
                    [
                        {
                            "repo_url": it["html_url"],
                            "full_name": it["full_name"],
                            "stars": it.get("stargazers_count"),
                            "description": it.get("description"),
                        }
                        for it in items
                    ],
                    ensure_ascii=False,
                )
                raw = gw.chat(
                    [
                        {"role": "system", "content": CODE_SEARCH_SYSTEM},
                        {"role": "user", "content": f"论文标题:{paper.title}\n候选仓库:\n{payload}\n请输出 JSON 数组。"},
                    ],
                    role="default_chat", temperature=0.1, max_tokens=1500,
                )
                parsed = _safe_json_load_list(raw)
                for v in parsed:
                    llm_verdicts[v.get("repo_url", "")] = v
            except Exception as exc:  # noqa: BLE001
                logger.warning("LLM code judgment failed: %s", exc)

        for it in items:
            repo_url = it["html_url"]
            status, note = _judge_official(paper, it["full_name"], repo_url)
            llm = llm_verdicts.get(repo_url, {})
            if llm.get("official_status"):
                # LLM may upgrade to author_affiliated/community but NOT to official
                # (official requires the paper link match, handled above).
                if llm["official_status"] != "official":
                    status = llm["official_status"]
            license_name = (it.get("license") or {}).get("spdx_id") if it.get("license") else None
            evidence = note + (" | LLM:" + (llm.get("evidence") or "") if llm else "")
            provenance = json.dumps(
                {"source": "github_search", "query": query, "default_branch": it.get("default_branch")},
                ensure_ascii=False,
            )
            # Idempotent upsert by (project_id, repo_url): if this repo was
            # already recorded for this project, refresh its stars/official
            # status/evidence instead of inserting a duplicate row. Without this
            # every click of "检索代码" re-inserted the same repos, so the list
            # grew with dupes on each run.
            existing = db.scalar(
                select(Repository).where(
                    Repository.project_id == state["project_id"],
                    Repository.repo_url == repo_url,
                )
            )
            if existing is not None:
                existing.full_name = it["full_name"]
                existing.official_status = status
                existing.license = license_name
                existing.stars = it.get("stargazers_count")
                existing.evidence = evidence
                existing.provenance_json = provenance
                existing.paper_id = paper.id
                repo_id = existing.id
            else:
                repo_id = new_id("repo")
                db.add(
                    Repository(
                        id=repo_id,
                        project_id=state["project_id"],
                        paper_id=paper.id,
                        repo_url=repo_url,
                        full_name=it["full_name"],
                        commit_sha=None,
                        official_status=status,
                        license=license_name,
                        stars=it.get("stargazers_count"),
                        evidence=evidence,
                        provenance_json=provenance,
                    )
                )
            results.append({
                "repo_url": repo_url,
                "full_name": it["full_name"],
                "official_status": status,
                "license": license_name,
                "stars": it.get("stargazers_count"),
                "evidence": note,
                "paper_id": paper.id,
            })
    db.flush()
    state["result"] = {"repositories": results}
    state["evidence"] = [
        {
            "kind": "事实",
            "claim": f"检索到 {len(results)} 个 GitHub 仓库候选",
            "source_type": "repo",
            "citation": "github search api",
        }
    ]
    state["final_response"] = (
        f"代码检索完成,找到 {len(results)} 个候选仓库。"
        "注意:无明确官方声明的仓库标记为 unverified;如需克隆请在仓库列表中确认。"
    )
    return state


def _safe_json_load_list(text: str) -> list[dict]:
    import re

    fence = re.search(r"```(?:json)?\s*(\[.*?\])\s*```", text, re.DOTALL)
    if fence:
        text = fence.group(1)
    m = re.search(r"\[.*\]", text, re.DOTALL)
    if not m:
        return []
    try:
        v = json.loads(m.group(0))
        return v if isinstance(v, list) else []
    except ValueError:
        return []
