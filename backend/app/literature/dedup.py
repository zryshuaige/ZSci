"""Deduplication + venue tagging for merged search results.

Priority (design.md §9.2): DOI > arXiv ID > Semantic Scholar ID > normalized
title > author-year similarity. We implement DOI/arXiv/title here; S2 id falls
back to title since we don't store it separately yet.
"""
from __future__ import annotations

from app.literature.models import CandidatePaper
from app.literature.venue_registry import VenueRegistry, get_venue_registry


def deduplicate(papers: list[CandidatePaper]) -> list[CandidatePaper]:
    """Merge duplicates by dedup_key, preferring entries with richer metadata."""
    buckets: dict[tuple, list[CandidatePaper]] = {}
    for p in papers:
        buckets.setdefault(p.dedup_key(), []).append(p)

    merged: list[CandidatePaper] = []
    for group in buckets.values():
        if len(group) == 1:
            merged.append(group[0])
            continue
        # Score by completeness; pick the best, graft missing fields from others.
        def score(p: CandidatePaper) -> int:
            return sum(
                1 for v in (p.doi, p.arxiv_id, p.abstract, p.pdf_url, p.venue, p.year) if v
            )
        group.sort(key=score, reverse=True)
        best = group[0].model_copy()
        for other in group[1:]:
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
