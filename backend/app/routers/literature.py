"""Literature search router (design.md §9.2, §15.2).

Search merges OpenAlex + arXiv, dedups, tags venues, and returns metadata only.
No PDFs are downloaded here.
"""
from __future__ import annotations

import asyncio
import re

from fastapi import APIRouter, Depends, HTTPException
from sqlalchemy import select
from sqlalchemy.orm import Session

from app.db.models import Paper, Project
from app.db.session import get_db
from app.literature.arxiv import search_arxiv
from app.literature.dedup import filter_to_top_venues, merge_and_tag, sort_by_relevance
from app.literature.models import CandidatePaper
from app.literature.openalex import search_openalex
from app.literature.similarity import rank_by_similarity
from app.schemas import (
    CandidatePaperOut,
    LiteratureRecommendResponse,
    LiteratureSearchRequest,
    LiteratureSearchResponse,
)

router = APIRouter(prefix="/api/v1/projects/{project_id}/literature", tags=["literature"])

# Matches ASCII technical tokens: letters/digits with internal +, -, _, ., :.
# e.g. "clip", "deeplabv3+", "ViT-L", "gpt-4", "yolov8". Captures the kind of
# terms that index well in arXiv/OpenAlex even when surrounded by CJK prose.
_ASCII_TERM_RE = re.compile(r"[A-Za-z][A-Za-z0-9+_\-.:]*")


def _extract_search_terms(query: str) -> str:
    """Pick the most search-effective form of a query.

    arXiv and OpenAlex index primarily English text. A raw Chinese research
    direction like "多模态视觉模型 基于clip和deelabv3+的结合" returns almost
    nothing from either source. When the query contains CJK characters, we
    extract the embedded ASCII technical terms (clip, deeplabv3+, ...) and use
    THEM as the search query — they're the part that actually matches. If no
    ASCII terms are found, fall back to the original query so a pure-English
    query still works as-is.
    """
    q = (query or "").strip()
    if not q:
        return q
    has_cjk = bool(re.search(r"[\u4e00-\u9fff]", q))
    if not has_cjk:
        return q
    terms = _ASCII_TERM_RE.findall(q)
    # Drop trivially short noise (single letters), keep real tokens.
    terms = [t for t in terms if len(t) >= 2]
    if not terms:
        return q
    return " ".join(terms)


def _to_out(c: CandidatePaper, is_downloaded: bool = False, similarity: float | None = None) -> CandidatePaperOut:
    return CandidatePaperOut(
        paper_id=c.paper_id,
        title=c.title,
        authors=c.authors,
        year=c.year,
        venue=c.venue,
        venue_verified=c.venue_verified,
        abstract=c.abstract,
        doi=c.doi,
        arxiv_id=c.arxiv_id,
        pdf_url=c.pdf_url,
        source_url=c.source_url,
        source=c.source,
        cited_by_count=c.cited_by_count,
        is_downloaded=is_downloaded,
        similarity=similarity,
    )


def _downloaded_keys(db: Session, project_id: str) -> set[str]:
    """Fingerprint set of the project's downloaded papers for dedup/marking."""
    existing = db.scalars(
        select(Paper).where(
            Paper.project_id == project_id,
            Paper.downloaded.is_(True),
        )
    ).all()
    keys: set[str] = set()
    for p in existing:
        if p.doi:
            keys.add("doi:" + p.doi.lower())
        if p.arxiv_id:
            keys.add("arxiv:" + p.arxiv_id)
        keys.add("title:" + p.title.lower().strip())
    return keys


def _is_downloaded(c: CandidatePaper, keys: set[str]) -> bool:
    if c.doi and "doi:" + c.doi.lower() in keys:
        return True
    if c.arxiv_id and "arxiv:" + c.arxiv_id in keys:
        return True
    return "title:" + c.title.lower().strip() in keys


async def _gather_candidates(query: str, sources: list[str], years, limit: int) -> list[CandidatePaper]:
    """Run OpenAlex + arXiv in parallel, merge + tag, return normalized candidates."""
    src = {s.lower() for s in sources}
    tasks: list = []
    if "openalex" in src:
        tasks.append(search_openalex(query, years=years, limit=limit))
    if "arxiv" in src:
        tasks.append(search_arxiv(query, years=years, limit=limit))
    if not tasks:
        return []
    results = await asyncio.gather(*tasks, return_exceptions=True)
    candidates: list[CandidatePaper] = []
    for r in results:
        if isinstance(r, Exception):
            continue
        candidates.extend(r)
    return merge_and_tag(candidates)


def _project_interest_profile(db: Session, project: Project) -> str | None:
    """Build a text profile from the research direction + downloaded papers.

    Used as the query for recommendations and as the TF-IDF similarity target.
    Returns None if there is not enough signal to recommend from.
    """
    parts: list[str] = []
    if project.research_direction and project.research_direction.strip():
        parts.append(project.research_direction.strip())
    papers = db.scalars(
        select(Paper).where(
            Paper.project_id == project.id,
            Paper.downloaded.is_(True),
        )
    ).all()
    for p in papers:
        if p.title:
            parts.append(p.title)
        if p.abstract:
            parts.append(p.abstract)
    profile = " ".join(parts).strip()
    return profile or None


@router.post("/search", response_model=LiteratureSearchResponse)
async def search_literature(
    project_id: str,
    payload: LiteratureSearchRequest,
    db: Session = Depends(get_db),
) -> LiteratureSearchResponse:
    project = db.get(Project, project_id)
    if project is None:
        raise HTTPException(404, "Project not found")

    # Track as a global Job so the sidebar shows "文献检索" while it runs and
    # for ~90s after - literature search can take several seconds (OpenAlex +
    # arXiv gather) and used to be invisible after navigating away.
    from app.jobs import start_job, update_job

    job = start_job(
        db, project_id=project_id, kind="literature_search",
        title=f"文献检索: {payload.query}", target_type="literature",
        message="正在检索 OpenAlex + arXiv",
    )
    try:
        # Extract English/technical terms from CJK-heavy queries so arXiv/OpenAlex
        # (English-indexed) actually match. Pure-English queries pass through.
        search_query = _extract_search_terms(payload.query)
        candidates = await _gather_candidates(search_query, payload.sources, payload.years, payload.limit)
        if payload.top_venues_only:
            candidates = filter_to_top_venues(candidates)
        if payload.venues:
            wanted = {v.lower() for v in payload.venues}
            candidates = [c for c in candidates if c.venue and any(w in c.venue.lower() for w in wanted)]
        candidates = sort_by_relevance(candidates)[: payload.limit]

        keys = _downloaded_keys(db, project_id)
        outs = [_to_out(c, _is_downloaded(c, keys)) for c in candidates]
        update_job(db, job.id, status="completed", result_summary=f"找到 {len(outs)} 篇")
        return LiteratureSearchResponse(query=payload.query, count=len(outs), papers=outs)
    except HTTPException:
        update_job(db, job.id, status="failed", error="检索失败")
        raise
    except Exception as exc:  # noqa: BLE001
        update_job(db, job.id, status="failed", error=str(exc))
        raise


@router.post("/recommend", response_model=LiteratureRecommendResponse)
async def recommend_literature(
    project_id: str,
    db: Session = Depends(get_db),
) -> LiteratureRecommendResponse:
    """Recommend the most similar papers to the project's interest profile.

    Derives a query from the research direction (+ downloaded papers), searches
    the literature sources, then re-ranks by TF-IDF cosine similarity to the
    full interest profile. Returns the top 6 not-yet-downloaded papers.
    """
    project = db.get(Project, project_id)
    if project is None:
        raise HTTPException(404, "Project not found")

    from app.jobs import start_job, update_job

    job = start_job(
        db, project_id=project_id, kind="literature_recommend",
        title="智能推荐相似论文", target_type="literature",
        message="正在检索并排序相似论文",
    )
    try:
        profile = _project_interest_profile(db, project)
        if not profile:
            raise HTTPException(400, "项目还没有研究方向或已下载论文，无法生成推荐。请先填写研究方向或下载几篇论文。")

        raw_query = project.research_direction.strip() if project.research_direction else profile
        query = _extract_search_terms(raw_query)

        candidates = await _gather_candidates(query, ["openalex", "arxiv"], None, 60)
        if not candidates:
            if raw_query and _extract_search_terms(raw_query) == raw_query and bool(re.search(r"[一-鿿]", raw_query)):
                raise HTTPException(502, "检索源暂无返回。你的研究方向是中文，尝试加入英文术语(如 CLIP、DeepLabV3+、VLM)能搜到更多论文。")
            raise HTTPException(502, "检索源暂无返回，请稍后重试。")

        keys = _downloaded_keys(db, project_id)
        pool = [c for c in candidates if not _is_downloaded(c, keys)]
        if not pool:
            raise HTTPException(409, "候选论文均已下载，暂无新推荐。")

        scored = rank_by_similarity(pool, profile)
        top_n = 6
        top = scored[:top_n]
        outs = [_to_out(c, False, round(sim, 4)) for c, sim in top]
        update_job(db, job.id, status="completed", result_summary=f"推荐 {len(outs)} 篇")
        return LiteratureRecommendResponse(query=query, count=len(outs), papers=outs)
    except HTTPException as exc:
        update_job(db, job.id, status="failed", error=exc.detail if isinstance(exc.detail, str) else "推荐失败")
        raise
    except Exception as exc:  # noqa: BLE001
        update_job(db, job.id, status="failed", error=str(exc))
        raise
