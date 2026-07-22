"""arXiv API client. Public, no key. Returns Atom XML."""
from __future__ import annotations

import hashlib
import logging
import re
from xml.etree import ElementTree as ET

import httpx

from app.config import get_settings
from app.literature.models import CandidatePaper

logger = logging.getLogger("zsci.literature.arxiv")

# arXiv now 301-redirects http -> https; hit https directly and still allow
# redirects as a safety net so a future move doesn't silently break search.
ARXIV_BASE = "https://export.arxiv.org/api/query"

ATOM = "{http://www.w3.org/2005/Atom}"
ARXIV_NS = "{http://arxiv.org/schemas/atom}"


def _make_id(arxiv_id: str, title: str) -> str:
    raw = arxiv_id or title
    return "cand_" + hashlib.sha1(raw.encode("utf-8")).hexdigest()[:16]


def _clean_arxiv_id(raw: str | None) -> str | None:
    if not raw:
        return None
    # raw like http://arxiv.org/abs/2401.00001v1 -> 2401.00001
    m = re.search(r"(abs/)?([\d.]+)(v\d+)?", raw)
    if m:
        return m.group(2)
    return raw.strip()


async def search_arxiv(
    query: str,
    *,
    years: tuple[int, int] | None = None,
    limit: int = 50,
) -> list[CandidatePaper]:
    """Search arXiv by relevance."""
    settings = get_settings()
    params = {
        "search_query": f"all:{query}",
        "start": 0,
        "max_results": min(limit, 200),
        "sortBy": "relevance",
    }

    try:
        async with httpx.AsyncClient(timeout=settings.academic_api_timeout, follow_redirects=True) as client:
            resp = await client.get(ARXIV_BASE, params=params)
            resp.raise_for_status()
            text = resp.text
    except (httpx.HTTPError, ValueError) as exc:
        logger.warning("arXiv search failed: %s", exc)
        return []

    results: list[CandidatePaper] = []
    try:
        root = ET.fromstring(text)
    except ET.ParseError as exc:
        logger.warning("arXiv parse failed: %s", exc)
        return []

    for entry in root.findall(f"{ATOM}entry"):
        title_el = entry.find(f"{ATOM}title")
        title = (title_el.text or "").strip().replace("\n", " ") if title_el is not None else ""
        title = re.sub(r"\s+", " ", title)
        if not title:
            continue

        arxiv_id = _clean_arxiv_id((entry.findtext(f"{ATOM}id") or "").strip())

        authors: list[str] = []
        for author in entry.findall(f"{ATOM}author"):
            name = author.findtext(f"{ATOM}name")
            if name:
                authors.append(name.strip())

        abstract = (entry.findtext(f"{ATOM}summary") or "").strip()
        abstract = re.sub(r"\s+", " ", abstract) if abstract else None

        pdf_url = None
        for link in entry.findall(f"{ATOM}link"):
            if link.get("title") == "pdf" or link.get("type") == "application/pdf":
                pdf_url = link.get("href")
                break
        abs_url = entry.findtext(f"{ATOM}id")

        year = None
        published = entry.findtext(f"{ATOM}published") or ""
        if published[:4].isdigit():
            year = int(published[:4])

        # If a year filter is set but the entry's year can't be parsed, drop it
        # rather than silently passing (old `and year` short-circuit kept
        # unparseable entries inside a "2020-2024 only" search).
        if years and (year is None or not (years[0] <= year <= years[1])):
            continue

        # arXiv has no "venue"; we leave it null (preprint).
        doi_el = entry.find(f"{ARXIV_NS}doi")
        doi = doi_el.text.strip() if doi_el is not None and doi_el.text else None

        results.append(
            CandidatePaper(
                paper_id=_make_id(arxiv_id, title),
                title=title,
                authors=authors,
                year=year,
                venue=None,
                abstract=abstract,
                doi=doi,
                arxiv_id=arxiv_id,
                pdf_url=pdf_url,
                source_url=abs_url,
                source="arXiv",
            )
        )
    return results[:limit]
