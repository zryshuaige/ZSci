"""Pydantic request/response schemas for all routers."""
from __future__ import annotations

from datetime import datetime
from typing import Literal

from pydantic import BaseModel, Field

# ---------------------------------------------------------------------------
# Projects
# ---------------------------------------------------------------------------


class ProjectCreate(BaseModel):
    name: str = Field(min_length=1, max_length=200)
    research_direction: str | None = None
    slug: str | None = None  # optional; derived from name if omitted


class ProjectUpdate(BaseModel):
    name: str | None = None
    research_direction: str | None = None
    status: str | None = None


class ProjectOut(BaseModel):
    id: str
    name: str
    slug: str
    research_direction: str | None
    root_path: str
    status: str
    created_at: datetime
    updated_at: datetime
    paper_count: int = 0
    downloaded_count: int = 0

    model_config = {"from_attributes": True}


# ---------------------------------------------------------------------------
# Literature search
# ---------------------------------------------------------------------------


class LiteratureSearchRequest(BaseModel):
    query: str = Field(min_length=1)
    years: tuple[int, int] | None = None
    venues: list[str] | None = None
    sources: list[str] = Field(default_factory=lambda: ["openalex", "arxiv"])
    limit: int = Field(default=50, ge=1, le=200)
    top_venues_only: bool = False


class CandidatePaperOut(BaseModel):
    paper_id: str
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
    source: str
    cited_by_count: int | None = None
    is_downloaded: bool = False
    # Set only on recommendation responses; null for plain search results.
    similarity: float | None = None


class LiteratureSearchResponse(BaseModel):
    query: str
    count: int
    papers: list[CandidatePaperOut]


class LiteratureRecommendResponse(BaseModel):
    """Top-N papers ranked by similarity to the project's interest profile."""

    query: str
    count: int
    papers: list[CandidatePaperOut]


# ---------------------------------------------------------------------------
# Papers
# ---------------------------------------------------------------------------


class PaperOut(BaseModel):
    id: str
    project_id: str
    title: str
    abstract: str | None
    authors: list[str] = Field(default_factory=list)
    year: int | None = None
    venue: str | None = None
    venue_verified: bool = False
    doi: str | None = None
    arxiv_id: str | None = None
    pdf_url: str | None = None
    source_url: str | None = None
    local_pdf_path: str | None = None
    downloaded: bool = False
    parse_status: str | None = None
    source: str | None = None
    created_at: datetime
    updated_at: datetime

    model_config = {"from_attributes": True}


class DownloadPaperRequest(BaseModel):
    paper_id: str
    title: str
    authors: list[str] = Field(default_factory=list)
    year: int | None = None
    venue: str | None = None
    venue_verified: bool = False
    doi: str | None = None
    arxiv_id: str | None = None
    pdf_url: str | None = None
    source_url: str | None = None
    abstract: str | None = None
    source: str = "search"
    confirmed: bool = False  # caller sets True after user approval


class ImportLocalPdfRequest(BaseModel):
    paper_id: str
    title: str
    authors: list[str] = Field(default_factory=list)
    year: int | None = None
    venue: str | None = None
    doi: str | None = None
    arxiv_id: str | None = None
    source_path: str
    abstract: str | None = None
    source: str = "local_import"
    confirmed: bool = False  # design.md §16.1: importing a local file needs approval


class ParseResponse(BaseModel):
    paper_id: str
    pages: int
    parse_status: str
    sections: list[dict] = Field(default_factory=list)


# ---------------------------------------------------------------------------
# Translation + reading notes
# ---------------------------------------------------------------------------


class TranslateRequest(BaseModel):
    text: str = Field(min_length=1)
    page: int | None = None
    target_lang: str = "中文"


class TranslationOut(BaseModel):
    id: str
    paper_id: str
    page: int | None
    original_text: str | None
    translated_text: str
    model: str | None
    created_at: datetime

    model_config = {"from_attributes": True}


class ReadingNoteOut(BaseModel):
    id: str
    paper_id: str
    kind: str
    page: int | None
    original_text: str | None
    content: str
    model: str | None
    created_at: datetime

    model_config = {"from_attributes": True}


class ReadingNoteUpdate(BaseModel):
    content: str


# ---------------------------------------------------------------------------
# Annotations
# ---------------------------------------------------------------------------


class AnnotationCreate(BaseModel):
    page_number: int | None = None
    selected_text: str | None = None
    rects_json: str | None = None
    comment: str | None = None
    color: str = "#fde047"
    kind: str = "highlight"


class AnnotationUpdate(BaseModel):
    comment: str | None = None
    color: str | None = None


class AnnotationOut(BaseModel):
    id: str
    paper_id: str
    page_number: int | None
    selected_text: str | None
    rects_json: str | None
    comment: str | None
    color: str | None
    kind: str
    created_at: datetime
    updated_at: datetime

    model_config = {"from_attributes": True}


# ---------------------------------------------------------------------------
# System
# ---------------------------------------------------------------------------


class HealthOut(BaseModel):
    status: str
    version: str
    workspace: str


class SettingsOut(BaseModel):
    workspace_path: str
    models: dict
    venues: list[str]


# ---------------------------------------------------------------------------
# Phase 2: ideas, repositories, agent tasks, approvals
# ---------------------------------------------------------------------------


class IdeaCreate(BaseModel):
    title: str | None = None
    hypothesis: str | None = None
    motivation: str | None = None
    content: str | None = None
    status: str = "backlog"


class IdeaUpdate(BaseModel):
    title: str | None = None
    hypothesis: str | None = None
    motivation: str | None = None
    content: str | None = None
    status: str | None = None


class IdeaOut(BaseModel):
    id: str
    project_id: str
    title: str | None
    hypothesis: str | None
    motivation: str | None
    status: str
    content: str | None
    evidence_json: str | None
    risks_json: str | None
    created_at: datetime
    updated_at: datetime

    model_config = {"from_attributes": True}


class RepositoryOut(BaseModel):
    id: str
    project_id: str
    paper_id: str | None
    repo_url: str
    full_name: str | None
    local_path: str | None
    commit_sha: str | None
    official_status: str
    license: str | None
    stars: int | None
    evidence: str | None
    created_at: datetime

    model_config = {"from_attributes": True}


class AgentTaskCreate(BaseModel):
    task_type: str
    input: dict = Field(default_factory=dict)


class AgentTaskOut(BaseModel):
    id: str
    project_id: str
    task_type: str
    status: str
    input_json: str | None
    plan_json: str | None
    result_json: str | None
    error: str | None
    evidence_ids: str | None
    created_at: datetime
    updated_at: datetime

    model_config = {"from_attributes": True}


class AgentEventOut(BaseModel):
    id: str
    task_id: str
    kind: str
    message: str | None
    payload_json: str | None
    created_at: datetime

    model_config = {"from_attributes": True}


class ApprovalOut(BaseModel):
    id: str
    task_id: str
    action_type: str
    payload_json: str | None
    status: str
    decision_at: datetime | None
    created_at: datetime

    model_config = {"from_attributes": True}


class ApprovalDecision(BaseModel):
    approved: bool


# ---------------------------------------------------------------------------
# Phase 2: repositories — typed update body (M8)
# ---------------------------------------------------------------------------


class RepositoryUpdate(BaseModel):
    """Manual correction of a repository's official_status / evidence (M8).

    Replaces the previous untyped `dict` body which had no OpenAPI schema and
    accepted arbitrary values for `official_status`.
    """
    official_status: Literal["official", "author_affiliated", "community", "unverified"] | None = None
    evidence: str | None = None


# ---------------------------------------------------------------------------
# Phase 3: experiments + runs
# ---------------------------------------------------------------------------


class ExperimentCreate(BaseModel):
    title: str
    research_question: str | None = None
    hypothesis: str | None = None
    related_idea_id: str | None = None
    source_repository_id: str | None = None


class ExperimentOut(BaseModel):
    id: str
    project_id: str
    title: str | None
    slug: str | None
    root_path: str | None
    source_repository_id: str | None
    related_idea_id: str | None
    status: str
    research_question: str | None
    hypothesis: str | None
    plan_json: str | None
    created_at: datetime
    updated_at: datetime

    model_config = {"from_attributes": True}


class RunOut(BaseModel):
    id: str
    experiment_id: str
    run_path: str | None
    command: str | None
    status: str
    git_commit: str | None
    seed: int | None
    pid: int | None
    start_at: datetime | None
    end_at: datetime | None
    created_at: datetime

    model_config = {"from_attributes": True}


class RunCreate(BaseModel):
    command: str
    seed: int | None = None
    confirmed: bool = False  # design.md §16.1: running shell needs approval


class MetricOut(BaseModel):
    id: str
    run_id: str
    step: int
    metric_name: str
    metric_value: float
    created_at: datetime

    model_config = {"from_attributes": True}


# ---------------------------------------------------------------------------
# Phase 4: writing
# ---------------------------------------------------------------------------


class DraftSectionRequest(BaseModel):
    section_name: str
    citation_keys: list[str] = Field(default_factory=list)
    run_ids: list[str] = Field(default_factory=list)
    notes: str | None = None


# ---------------------------------------------------------------------------
# Phase 4: writing router typed bodies
# ---------------------------------------------------------------------------


class WriteFileRequest(BaseModel):
    content: str = Field(min_length=0, max_length=1_000_000)


class WriteFileResponse(BaseModel):
    ok: bool
    path: str | None = None


class FileContentResponse(BaseModel):
    path: str
    content: str


class FileListResponse(BaseModel):
    files: list[str]


class InitWritingResponse(BaseModel):
    root: str
    files: list[str]


class InitWritingRequest(BaseModel):
    """Template choice for writing project init. design.md §13.6."""

    template: str = "generic"  # generic / ieee / elsevier
    # When True, an existing main.tex is overwritten with the new template's
    # preamble (document class + frontmatter). Section files and references.bib
    # are always preserved so switching templates never loses user content.
    force: bool = False


class WritingTemplateOut(BaseModel):
    key: str
    label: str
    note: str


class WritingTemplatesResponse(BaseModel):
    templates: list[WritingTemplateOut]


class CompileResponse(BaseModel):
    ok: bool
    pdf_path: str | None = None
    log: str | None = None
    error: str | None = None
