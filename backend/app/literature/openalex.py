"""OpenAlex API client. Public, no key required (polite email recommended)."""
from __future__ import annotations

import logging

import httpx

from app.config import get_settings
from app.literature.models import CandidatePaper

logger = logging.getLogger("zsci.literature.openalex")

OPENALEX_BASE = "https://api.openalex.org/works"


def _abstract_from_inverted_index(idx: dict | None) -> str | None:
    if not idx:
        return None
    positions: list[tuple[int, str]] = []
    for word, locs in idx.items():
        for pos in locs:
            positions.append((pos, word))
    positions.sort()
    return " ".join(w for _, w in positions) if positions else None


def _make_id(doi: str | None, arxiv_id: str | None, title: str) -> str:
    import hashlib

    raw = doi or arxiv_id or title
    return "cand_" + hashlib.sha1(raw.encode("utf-8")).hexdigest()[:16]


async def search_openalex(
    query: str,
    *,
    years: tuple[int, int] | None = None,
    limit: int = 50,
    polite_email: str | None = None,
) -> list[CandidatePaper]:
    """Search OpenAlex works by relevance. Returns normalized candidates."""
    settings = get_settings()
    params: dict = {
        "search": query,
        "per-page": min(limit, 200),
        "select": "id,doi,title,publication_year,authorships,primary_location,abstract_inverted_index,cited_by_count,open_access",
    }
    if years:
        params["filter"] = f"from_publication_date:{years[0]}-01-01,to_publication_date:{years[1]}-12-31"

    headers = {"User-Agent": "zsci/0.1 (research-agent)"}
    if polite_email:
        headers["User-Agent"] = f"zsci/0.1 (mailto:{polite_email})"

    try:
        async with httpx.AsyncClient(timeout=settings.academic_api_timeout, follow_redirects=True) as client:
            resp = await client.get(OPENALEX_BASE, params=params, headers=headers)
            resp.raise_for_status()
            data = resp.json()
    except (httpx.HTTPError, ValueError) as exc:
        logger.warning("OpenAlex search failed: %s", exc)
        return []

    results: list[CandidatePaper] = []
    for work in data.get("results", [])[:limit]:
        doi_raw = work.get("doi")  # like https://doi.org/10.x/...
        doi = doi_raw.replace("https://doi.org/", "").strip() if doi_raw else None
        title = (work.get("title") or "").strip()
        if not title:
            continue

        authors = [
            (a.get("author") or {}).get("display_name", "")
            for a in work.get("authorships", [])
        ]
        authors = [a for a in authors if a]

        primary = work.get("primary_location") or {}
        source = (primary.get("source") or {}) if primary else {}
        venue = source.get("display_name") if source else None

        oa = work.get("open_access") or {}
        pdf_url = oa.get("oa_url") or (primary.get("pdf_url") if primary else None)
        # NOTE: we deliberately do NOT fall back to landing_page_url here — that is
        # usually an HTML page, not a PDF, and would fail the %PDF check on download.
        # When no real PDF URL is available, pdf_url stays None and the frontend
        # disables the download button.

        # Try to extract arXiv id from DOI or ids.
        arxiv_id = None
        if doi and doi.startswith("10.48550/arxiv."):
            arxiv_id = doi.split("arxiv.")[-1]
        ids = work.get("ids") or {}
        if not arxiv_id and ids.get("mag"):
            pass
        if not arxiv_id:
            for mid in work.get("ids", {}).values() or []:
                if isinstance(mid, str) and "arxiv" in mid.lower():
                    arxiv_id = mid.rsplit("/", 1)[-1]
                    break

        results.append(
            CandidatePaper(
                paper_id=_make_id(doi, arxiv_id, title),
                title=title,
                authors=authors,
                year=work.get("publication_year"),
                venue=venue,
                abstract=_abstract_from_inverted_index(work.get("abstract_inverted_index")),
                doi=doi,
                arxiv_id=arxiv_id,
                pdf_url=pdf_url,
                source_url=work.get("id"),
                source="OpenAlex",
                cited_by_count=work.get("cited_by_count"),
            )
        )
    return results
