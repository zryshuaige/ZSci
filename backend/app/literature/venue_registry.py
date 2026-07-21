"""Venue registry loader (design.md §6.2).

Reads `backend/data/venue_registry.yaml` and matches paper venue strings against
canonical names + aliases.
"""
from __future__ import annotations

from functools import lru_cache
from importlib import resources
from pathlib import Path

import yaml


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
        v = (venue or "").lower().strip()
        if not v:
            return False
        if self.name.lower() in v or v in self.name.lower():
            return True
        return any(a and a in v for a in self.aliases)


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
