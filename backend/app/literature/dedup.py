"""Deduplication + venue tagging for merged search results.

Priority (design.md §9.2): DOI > arXiv ID > Semantic Scholar ID > normalized
title > author-year similarity. We implement DOI/arXiv/title here; S2 id falls
back to title since we don't store it separately yet.
"""
from __future__ import annotations

from app.literature.models import CandidatePaper, _normalize_title
from app.literature.venue_registry import VenueRegistry, get_venue_registry


def _dedup_keys(p: CandidatePaper) -> list[tuple]:
    """All identifiers `p` can be matched by; two papers merge if they share any.

    arxiv_id is included ALONGSIDE DOI so a preprint (arXiv DOI
    10.48550/arxiv.X) and its published version (publisher DOI) - which share
    arxiv_id but NOT a DOI - still dedup. Title is only a key when no
    DOI/arXiv is present (design §9.2 fallback), so two distinct papers that
    happen to share a title but have real identifiers don't get wrongly merged.
    """
    keys: list[tuple] = []
    if p.doi:
        keys.append(("doi", p.doi.lower().strip()))
    if p.arxiv_id:
        keys.append(("arxiv", p.arxiv_id.strip().lower()))
    if not p.doi and not p.arxiv_id:
        keys.append(("title", _normalize_title(p.title)))
    return keys


def deduplicate(papers: list[CandidatePaper]) -> list[CandidatePaper]:
    """Merge duplicates by any shared identifier (DOI / arXiv id / title).

    Uses union-find so a paper matches if it shares ANY identifier with another,
    not just one canonical key. Single-key bucketing split the same paper in two
    when OpenAlex returned the publisher DOI and arXiv returned the arXiv DOI
    (same arxiv_id, different DOI). Now both shared-DOI and shared-arxiv pairs
    merge correctly.
    """
    n = len(papers)
    parent = list(range(n))

    def find(x: int) -> int:
        while parent[x] != x:
            parent[x] = parent[parent[x]]
            x = parent[x]
        return x

    def union(a: int, b: int) -> None:
        ra, rb = find(a), find(b)
        if ra != rb:
            parent[ra] = rb

    seen: dict[tuple, int] = {}
    for i, p in enumerate(papers):
        for k in _dedup_keys(p):
            j = seen.get(k)
            if j is None:
                seen[k] = i
            else:
                union(i, j)

    groups: dict[int, list[int]] = {}
    for i in range(n):
        groups.setdefault(find(i), []).append(i)

    def score(p: CandidatePaper) -> int:
        return sum(1 for v in (p.doi, p.arxiv_id, p.abstract, p.pdf_url, p.venue, p.year) if v)

    merged: list[CandidatePaper] = []
    for group in groups.values():
        if len(group) == 1:
            merged.append(papers[group[0]])
            continue
        # Score by completeness; pick the best, graft missing fields from others.
        ordered = sorted((papers[i] for i in group), key=score, reverse=True)
        best = ordered[0].model_copy()
        for other in ordered[1:]:
            for field in ("doi", "arxiv_id", "abstract", "pdf_url", "venue", "year", "cited_by_count"):
                if not getattr(best, field) and getattr(other, field):
                    setattr(best, field, getattr(other, field))
        merged.append(best)
    return merged


def tag_venues(papers: list[CandidatePaper]) -> list[CandidatePaper]:
    """Mark venue_verified=True where venue matches the registry (design.md §6.2)."""
    registry = get_venue_registry()
    out: list[CandidatePaper] = []
    for p in papers:
        if p.venue and registry.match(p.venue):
            p = p.model_copy(update={"venue_verified": True, "venue": registry.canonical(p.venue)})
        out.append(p)
    return out


def merge_and_tag(papers: list[CandidatePaper]) -> list[CandidatePaper]:
    return tag_venues(deduplicate(papers))


def sort_by_relevance(papers: list[CandidatePaper]) -> list[CandidatePaper]:
    """Verified-venue first, then citation count, then year descending."""
    return sorted(
        papers,
        key=lambda p: (
            not p.venue_verified,
            -(p.cited_by_count or 0),
            -(p.year or 0),
        ),
    )


def filter_to_top_venues(
    papers: list[CandidatePaper], registry: VenueRegistry | None = None
) -> list[CandidatePaper]:
    """Keep only papers whose venue matches a registered top venue."""
    registry = registry or get_venue_registry()
    return [p for p in papers if p.venue and registry.match(p.venue)]
