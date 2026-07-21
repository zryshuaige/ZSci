"""Normalized candidate paper model shared across literature sources."""
from __future__ import annotations

from pydantic import BaseModel, Field


class CandidatePaper(BaseModel):
    """A paper discovered via search, before download. design.md §9.2."""

    paper_id: str  # stable hash-based id for dedup/storage
    title: str
    authors: list[str] = Field(default_factory=list)
    year: int | None = None
    venue: str | None = None
    venue_verified: bool = False
    abstract: str | None = None
    doi: str | None = None
    arxiv_id: str | None = None
    pdf_url: str | None = None
    source_url: str | None = None
    source: str  # OpenAlex / arXiv / Crossref / ...
    cited_by_count: int | None = None
    is_downloaded: bool = False

    def dedup_key(self) -> tuple:
        """Priority: DOI > arXiv ID > normalized title. design.md §9.2."""
        if self.doi:
            return ("doi", self.doi.lower().strip())
        if self.arxiv_id:
            return ("arxiv", self.arxiv_id.strip())
        return ("title", _normalize_title(self.title))


def _normalize_title(title: str) -> str:
    import re

    t = title.lower().strip()
    t = re.sub(r"[^a-z0-9]+", " ", t)
    return re.sub(r"\s+", " ", t).strip()
