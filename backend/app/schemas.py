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
    db_ok: bool = True
    db_error: str | None = None


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


class AgentTaskStartResponse(BaseModel):
    """Response for POST /projects/{id}/agent/tasks.

    Async (default): only `task_id` + `job_id` are populated; the caller
    polls `/workflows/active` or `/agent/tasks/{id}` for status.
    Sync (?sync=1, tests only): `task` carries the full row.
    """
    task_id: str
    job_id: str
    task: AgentTaskOut | None = None


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
# Active workflows (global sidebar status): in-progress agent tasks + runs
# ---------------------------------------------------------------------------


class ActiveWorkflowTaskOut(BaseModel):
    """An agent task for the global workflow-status sidebar.

    `experiment_id` is set only for autonomous experiment tasks (parsed from
    input_json - no schema change to agent_tasks). `last_message` is the most
    recent event message so the sidebar can show what the task is doing.
    `recent` is True for tasks that just reached a terminal state (within the
    recent window) so the sidebar can show "generate idea -> done" feedback even
    for fast synchronous tasks that finished between polls.
    """

    id: str
    project_id: str
    task_type: str
    status: str
    experiment_id: str | None = None
    last_message: str | None = None
    recent: bool = False
    created_at: datetime
    updated_at: datetime

    model_config = {"from_attributes": True}


class ActiveWorkflowRunOut(BaseModel):
    """An in-progress experiment run, for the global workflow-status sidebar."""

    run_id: str
    experiment_id: str
    project_id: str
    experiment_title: str | None = None
    command: str | None = None
    created_at: datetime

    model_config = {"from_attributes": True}


class ActiveWorkflowsOut(BaseModel):
    tasks: list[ActiveWorkflowTaskOut] = Field(default_factory=list)
    runs: list[ActiveWorkflowRunOut] = Field(default_factory=list)
    jobs: list[JobOut] = Field(default_factory=list)


class JobOut(BaseModel):
    """A user-triggered long-running operation (literature search, download,
    translation, LaTeX compile, benchmark search, ...). Surfaced in the global
    workflow sidebar so it survives page navigation. `recent` flags the
    90s finished-tail (same idea as ActiveWorkflowTaskOut.recent)."""

    id: str
    project_id: str
    kind: str
    status: str
    title: str | None = None
    target_id: str | None = None
    target_type: str | None = None
    message: str | None = None
    error: str | None = None
    result_summary: str | None = None
    recent: bool = False
    created_at: datetime
    updated_at: datetime

    model_config = {"from_attributes": True}


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


class BenchmarkOut(BaseModel):
    id: str
    project_id: str
    experiment_id: str | None
    name: str
    kind: str
    source: str
    url: str | None
    task_name: str | None
    dataset_name: str | None
    metric_name: str | None
    metric_value: float | None
    paper_id: str | None
    # Enrichment (populated in app/experiments/benchmarks.py from the HF
    # detail endpoint, or supplied by the user when creating a manual benchmark).
    # Stored in `extra_json` on the model — these fields are derived on the way
    # out so the wire format doesn't depend on the column being migrated.
    description: str | None = None
    tags: list[str] = Field(default_factory=list)
    downloads: int | None = None
    is_mainstream: bool = False
    author: str | None = None
    created_at: datetime

    @classmethod
    def from_row(cls, row) -> "BenchmarkOut":
        """Validate from a SQLAlchemy row, merging extra_json into the
        enrichment fields (description / tags / downloads / is_mainstream /
        author). Tolerates malformed extra_json without raising."""
        import json
        try:
            data = json.loads(row.extra_json) if row.extra_json else {}
        except (ValueError, TypeError):
            data = {}
        return cls(
            id=row.id,
            project_id=row.project_id,
            experiment_id=row.experiment_id,
            name=row.name,
            kind=row.kind,
            source=row.source,
            url=row.url,
            task_name=row.task_name,
            dataset_name=row.dataset_name,
            metric_name=row.metric_name,
            metric_value=row.metric_value,
            paper_id=row.paper_id,
            description=data.get("description") if isinstance(data, dict) else None,
            tags=[str(t) for t in (data.get("tags") or [])] if isinstance(data, dict) else [],
            downloads=(data.get("downloads") if isinstance(data, dict) else None),
            is_mainstream=bool(data.get("is_mainstream")) if isinstance(data, dict) else False,
            author=(data.get("author") if isinstance(data, dict) else None),
            created_at=row.created_at,
        )

    model_config = {"from_attributes": True}


class BenchmarkSearchRequest(BaseModel):
    query: str
    experiment_id: str | None = None
    limit: int = 8


class BenchmarkHitOut(BaseModel):
    """Ephemeral HF search hit — not persisted until the user adds it."""

    name: str
    kind: str = "dataset"
    source: str = "hf"
    url: str | None = None
    task_name: str | None = None
    dataset_name: str | None = None
    metric_name: str | None = None
    metric_value: float | None = None
    description: str | None = None
    tags: list[str] = Field(default_factory=list)
    downloads: int | None = None
    is_mainstream: bool = False
    author: str | None = None

    @classmethod
    def from_hit(cls, hit: dict) -> "BenchmarkHitOut":
        return cls(
            name=str(hit.get("name") or ""),
            kind=str(hit.get("kind") or "dataset"),
            source=str(hit.get("source") or "hf"),
            url=hit.get("url"),
            task_name=hit.get("task_name"),
            dataset_name=hit.get("dataset_name"),
            metric_name=hit.get("metric_name"),
            metric_value=hit.get("metric_value"),
            description=hit.get("description"),
            tags=[str(t) for t in (hit.get("tags") or [])],
            downloads=hit.get("downloads"),
            is_mainstream=bool(hit.get("is_mainstream")),
            author=hit.get("author"),
        )


class BenchmarkAddRequest(BaseModel):
    """Persist a search hit (or equivalent fields) into the project library."""

    name: str = Field(min_length=1, max_length=300)
    kind: Literal["dataset", "task", "sota"] = "dataset"
    source: str = "hf"
    url: str | None = None
    task_name: str | None = None
    dataset_name: str | None = None
    metric_name: str | None = None
    metric_value: float | None = None
    experiment_id: str | None = None
    description: str | None = Field(default=None, max_length=1000)
    tags: list[str] = Field(default_factory=list, max_length=20)
    downloads: int | None = None
    is_mainstream: bool = False
    author: str | None = None


class BenchmarkUpdate(BaseModel):
    experiment_id: str | None = None


class BenchmarkManualCreate(BaseModel):
    """User-entered benchmark (never-blocked fallback when HF is unreachable)."""

    name: str = Field(min_length=1, max_length=300)
    kind: Literal["dataset", "task", "sota"] = "dataset"
    url: str | None = None
    task_name: str | None = None
    dataset_name: str | None = None
    metric_name: str | None = None
    metric_value: float | None = None
    experiment_id: str | None = None
    description: str | None = Field(default=None, max_length=1000)
    tags: list[str] = Field(default_factory=list, max_length=10)
    is_mainstream: bool = False


class BenchmarkSearchResponse(BaseModel):
    """Search-only response: ephemeral hits + source warnings.

    `benchmarks` is kept as an alias of `hits` for older clients; prefer `hits`.
    """

    hits: list[BenchmarkHitOut] = Field(default_factory=list)
    benchmarks: list[BenchmarkHitOut] = Field(default_factory=list)
    warnings: list[str] = Field(default_factory=list)
    query_used: list[str] = Field(default_factory=list)


class CodegenRequest(BaseModel):
    selected_papers: list[str] = Field(default_factory=list)
    selected_repositories: list[str] = Field(default_factory=list)


class CodegenResponse(BaseModel):
    relevant_papers: list[str] = Field(default_factory=list)
    official_code_note: str = ""
    plan: list[dict] = Field(default_factory=list)
    files_written: list[str] = Field(default_factory=list)
    run_command: str
    smoke_command: str
    risks: list[str] = Field(default_factory=list)


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
