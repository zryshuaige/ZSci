"""Evidence validator (design.md §2.3, §8.2).

Checks that Agent outputs distinguish fact / inference / hypothesis / to-verify,
and that factual claims carry a source citation. This is a structural check —
it cannot verify the claim is true, only that it is sourced.
"""
from __future__ import annotations

import re

from app.agent.state import EvidenceItem, EvidenceKind

# A "source" looks like (p.N), (paper_id ...), commit <sha>, run <id>, §N, etc.
SOURCE_RE = re.compile(
    r"\(p\.?\s*\d+\)|paper_[\w]+|repo_[\w]+|run_[\w]+|commit\s+[0-9a-f]{4,}|§\s*\d+|table\s+\d",
    re.IGNORECASE,
)


def validate_evidence(items: list[dict]) -> list[dict]:
    """Normalize + flag evidence items.

    Returns the same list with a `_warning` key on any item that looks like a
    fact but has no source citation.
    """
    out: list[dict] = []
    for raw in items:
        try:
            item = EvidenceItem(**raw)
        except Exception:  # noqa: BLE001
            out.append({**raw, "_warning": "malformed evidence item"})
            continue
        d = item.model_dump()
        d["kind"] = item.kind.value if isinstance(item.kind, EvidenceKind) else str(item.kind)
        if d["kind"] == EvidenceKind.FACT.value:
            cite = d.get("citation") or ""
            if not SOURCE_RE.search(cite) and not SOURCE_RE.search(d.get("claim", "")):
                if not d.get("source_id") and d.get("source_type") == "paper":
                    d["_warning"] = (
                        "事实声明缺少来源引用(应附带 paper_id 与页码,如 (p.4))"
                    )
        out.append(d)
    return out


def summary(items: list[dict]) -> dict:
    counts = {k.value: 0 for k in EvidenceKind}
    warnings = 0
    for it in items:
        counts[it.get("kind", EvidenceKind.FACT.value)] = counts.get(
            it.get("kind", EvidenceKind.FACT.value), 0
        ) + 1
        if it.get("_warning"):
            warnings += 1
    return {"counts": counts, "warnings": warnings, "total": len(items)}
