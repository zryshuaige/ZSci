"""Venue registry loader (design.md §6.2).

Reads `backend/data/venue_registry.yaml` and matches paper venue strings against
canonical names + aliases.
"""
from __future__ import annotations

import re
from functools import lru_cache
from importlib import resources
from pathlib import Path

import yaml

_YEAR_RE = re.compile(r"\b(?:19|20)\d{2}\b")
_PUNCT_RE = re.compile(r"[^a-z0-9]+")


def _norm_venue(s: str | None) -> str:
    """Normalize a venue string for exact comparison: lowercase, drop the year,
    drop all non-alphanumerics. "ACL 2023" -> "acl", "NeurIPS Workshop" ->
    "neuripsworkshop" (deliberately != "neurips", so workshops don't verify as
    the main conference).
    """
    s = (s or "").lower().strip()
    s = _YEAR_RE.sub(" ", s)
    s = _PUNCT_RE.sub("", s)
    return s


class VenueEntry:
    def __init__(self, raw: dict) -> None:
        self.id: str = raw.get("id", "")
        self.name: str = raw.get("name", "")
        self.aliases: list[str] = [a.lower() for a in raw.get("aliases", [])]
        self.field: str = raw.get("field", "")
        self.level: str = raw.get("level", "")
        # name + year-stripped variants are also matchable.
        self.aliases.append(self.name.lower())

    def matches(self, venue: str) -> bool:
        v = _norm_venue(venue)
        if not v:
            return False
        # Exact normalized equality only (no substring). Bidirectional substring
        # matching over-matched: "neurips" in "neurips workshop" verified a
        # workshop as the NeurIPS main conference, and "acl" in "naacl"
        # relabeled NAACL papers as ACL. Because tag_venues rewrites the venue
        # string in place, those false positives permanently corrupted data.
        if v == _norm_venue(self.name):
            return True
        return any(v == _norm_venue(a) for a in self.aliases)


class VenueRegistry:
    def __init__(self, entries: list[VenueEntry]) -> None:
        self.entries = entries

    def match(self, venue: str | None) -> bool:
        if not venue:
            return False
        return any(e.matches(venue) for e in self.entries)

    def canonical(self, venue: str) -> str:
        for e in self.entries:
            if e.matches(venue):
                return e.name
        return venue or ""

    def names(self) -> list[str]:
        return [e.name for e in self.entries]


def _registry_path() -> Path:
    # backend/data/venue_registry.yaml  (this file is backend/app/literature/venue_registry.py)
    return Path(__file__).resolve().parents[2] / "data" / "venue_registry.yaml"


@lru_cache
def get_venue_registry() -> VenueRegistry:
    path = _registry_path()
    if not path.exists():
        # Fallback: try importlib resources for packaged data.
        try:
            with resources.files("app.data").joinpath("venue_registry.yaml").open("r", encoding="utf-8") as f:  # type: ignore[attr-defined]
                raw = yaml.safe_load(f) or {}
        except Exception:  # noqa: BLE001
            return VenueRegistry([])
    else:
        raw = yaml.safe_load(path.read_text(encoding="utf-8")) or {}
    entries = [VenueEntry(v) for v in raw.get("venues", []) if isinstance(v, dict)]
    return VenueRegistry(entries)
