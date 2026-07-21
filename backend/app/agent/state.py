"""Agent state + evidence taxonomy (design.md §8.3, §2.3).

The state object threads through every LangGraph node. Evidence is classified
into four buckets per design.md §2.3 so the Agent never smuggles guesses in as
facts.
"""
from __future__ import annotations

from enum import Enum
from typing import Any, TypedDict

from pydantic import BaseModel

class EvidenceKind(str, Enum):
    FACT = "事实"  # directly from a paper / code / log
    INFERENCE = "推断"  # Agent's synthesis of multiple facts
    HYPOTHESIS = "假设"  # unverified idea
    TO_VERIFY = "待验证"  # needs reading/running to confirm


class EvidenceItem(BaseModel):
    """A single piece of evidence tied to a source (paper page / repo / run)."""

    kind: EvidenceKind = EvidenceKind.FACT
    claim: str
    source_type: str = "paper"  # paper / repo / run / dataset / user_note
    source_id: str | None = None  # paper_id / repo_id / run_id
    page: int | None = None
    citation: str | None = None  # e.g. "(p.4)" or "commit abc123"


class ResearchAgentState(TypedDict, total=False):
    """LangGraph state object. design.md §8.3, extended for Phase 2/3."""

    project_id: str
    task_id: str
    task_type: str
    user_request: str
    intent: str

    plan: list[dict]
    evidence: list[dict]  # serialized EvidenceItem

    selected_papers: list[str]
    selected_repositories: list[str]
    selected_experiments: list[str]

    pending_approval: dict | None  # action awaiting user approval
    warnings: list[str]

    tool_results: list[dict]
    final_response: str
    result: dict[str, Any]


def classify_evidence(claim: str, *, kind: EvidenceKind = EvidenceKind.FACT, **kw) -> dict:
    """Helper to build a serialized evidence item."""
    return EvidenceItem(kind=kind, claim=claim, **kw).model_dump()
