"""Pydantic request/response schemas for all routers."""
from __future__ import annotations

from datetime import datetime
from typing import Literal

from pydantic import BaseModel, Field, field_serializer


# ---------------------------------------------------------------------------
# M34: naive-datetime serialization fix.
#
# SQLite columns store naive `datetime` (no `timezone=True`), so a raw
# `dt.isoformat()` doesn't tell the browser the value is UTC. JS's
# `new Date('2026-07-24 08:57:47')` parses that as LOCAL time, which
# shifts the rendered timestamp by the user's UTC offset (the bug the
# user reported as "08:57:58" — the actual stored value was
# `2026-07-24 08:57:47` UTC and the browser was rendering it without
# conversion).
#
# We force every Pydantic model in this app to serialize naive datetimes
# as ISO-8601 with an explicit 'Z' suffix (Pydantic v2 uses the field's
# serializer before JSON encoding). All schema classes below should
# inherit from `ZSciBaseModel` rather than `BaseModel` directly so they
# pick this up automatically.
# ---------------------------------------------------------------------------


class ZSciBaseModel(BaseModel):
    """Base model that auto-appends 'Z' to naive datetimes on serialization."""

    @field_serializer("*", when_used="json")
    def _serialize_datetime(self, value, _info):  # noqa: ANN001
        # Pydantic only calls this for datetime fields (it's a generic
        # serializer; other types pass through untouched).
        if isinstance(value, datetime):
            return _iso_z(value)
        return value


def _iso_z(dt: datetime) -> str:
    """ISO-8601 UTC string with explicit 'Z' suffix.

    Naive datetimes are treated as already-UTC (the convention used by
    `app/utils.iso_utc`); tz-aware datetimes are converted to UTC and
    the offset is normalised to `+00:00` -> `Z`.
    """
    if dt.tzinfo is None:
        return dt.isoformat(timespec="seconds") + "Z"
    return dt.astimezone(tz=__import__("datetime").timezone.utc).isoformat(timespec="seconds").replace("+00:00", "Z")


# ---------------------------------------------------------------------------
# Friendly error envelope (Phase A: 全局友好错误层)
#
# FastAPI's exception_handlers (app/exception_handlers.py) returns this shape
# instead of the default {"detail": "..."}. The frontend's useFriendlyError
# hook (frontend/src/lib/useFriendlyError.ts) parses it to render a localised
# toast with an optional CTA (`suggestion`).
#
# The wire format is intentionally small: `code` is a stable enum string,
# `user_message` is localised Chinese, and `suggestion` (optional) names a
# CTA the UI can render ("go_settings" / "retry" / "check_input"). `detail`
# carries any extra technical info for a developer debug panel; the regular
# UI never needs to read it.
# ---------------------------------------------------------------------------


class FriendlyErrorOut(ZSciBaseModel):
    code: str
    user_message: str
    detail: str | None = None
    suggestion: str | None = None


# ---------------------------------------------------------------------------
# Phase C/D preview-plan / next-steps (面向用户的非技术化研究结果视图)
# ---------------------------------------------------------------------------


class PlanPreviewMetricOut(ZSciBaseModel):
    """一项拟跟踪的指标。"""

    name: str
    definition: str | None = None
    aggregation: str | None = None


class PlanPreviewOut(ZSciBaseModel):
    """研究计划确认页用的非技术化视图。

    - 不直接暴露 phase key / 内部 stage 名。
    - 所有时间/算力均为面向用户的描述,后端在拿到 phase_1_plan.outputs_json
      之后做一次轻度语义化(把 metrics 列表扁平、把 compute_plan 提炼为
      算力描述、把 risks 拼成可读句子)。
    - 若 plan 阶段尚未完成(无 outputs_json),返回时所有字段为 None,
      前端按"计划待生成"路径渲染,主 CTA 仍可触发首轮验证。
    """

    goal: str | None = None
    hypothesis: str | None = None
    scope: str | None = None  # 来自 run_specs 的非技术化描述
    fairness_note: str | None = None
    compute_plan: str | None = None  # 算力与运行规模描述
    risks: list[str] = []
    metrics: list[PlanPreviewMetricOut] = []
    est_minutes: int | None = None  # 估计首轮耗时(分钟),仅参考
    success_means: str | None = None
    failure_means: str | None = None
    has_plan: bool = False  # 标记 phase_1_plan 是否已就绪


class NextStepOut(ZSciBaseModel):
    """研究结果页面的后续研究方向之一。"""

    id: str  # 稳定 id,形如 "step_<n>"
    title: str  # 一句话方向标题
    description: str | None = None  # 详细说明
    est_cost: str | None = None  # 算力描述(low/medium/high 或人类描述)
    template: str | None = None  # 模板键: iterate / change_dataset / novel / into_writing / branch


class NextStepsOut(ZSciBaseModel):
    """实验结果下一步建议的非技术化视图。

    数据来源:phase_4_report.outputs_json.analysis.{recommendation,next_steps,...}
    - judgement:基于 recommendation(publish/iterate/inconclusive)映射成
      continue / adjust / insufficient / pivot。
    - metrics:从 analysis.best_metric 与 series[*].metrics 抽出关键指标。
    - conclusion / risks:直接透传 analysis 的自然语言字段。
    """

    conclusion: str | None = None
    judgement: str | None = None
    metrics: dict[str, float | int | str] = {}
    risks: list[str] = []
    next_steps: list[NextStepOut] = []
    has_analysis: bool = False  # 标记 phase_4_report 是否包含 analysis


# ---------------------------------------------------------------------------
# Multi-Ideas (Phase B): bulk insertion endpoint. Lets the candidate-comparison
# page (ExploreIdeasPage) persist 1-N LLM candidates in a single request,
# after the user has selected which ones to keep.
# ---------------------------------------------------------------------------


class BulkIdeaIn(ZSciBaseModel):
    title: str | None = None
    hypothesis: str | None = None
    motivation: str | None = None
    content: dict | None = None
    evidence_json: list[dict] | None = None
    risks_json: list[str] | None = None
    status: str = "backlog"


class BulkIdeasPayload(ZSciBaseModel):
    ideas: list[BulkIdeaIn] = Field(min_length=1, max_length=20)


class BulkIdeasOut(ZSciBaseModel):
    inserted: list[IdeaOut]
    skipped: list[int] = []


# ---------------------------------------------------------------------------
# Projects
# ---------------------------------------------------------------------------


class ProjectCreate(ZSciBaseModel):
    name: str = Field(min_length=1, max_length=200)
    research_direction: str | None = None
    slug: str | None = None  # optional; derived from name if omitted


class ProjectUpdate(ZSciBaseModel):
    name: str | None = None
    research_direction: str | None = None
    status: str | None = None


class ProjectOut(ZSciBaseModel):
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


class LiteratureSearchRequest(ZSciBaseModel):
    query: str = Field(min_length=1)
    years: tuple[int, int] | None = None
    venues: list[str] | None = None
    sources: list[str] = Field(default_factory=lambda: ["openalex", "arxiv"])
    limit: int = Field(default=50, ge=1, le=200)
    top_venues_only: bool = False


class CandidatePaperOut(ZSciBaseModel):
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


class LiteratureSearchResponse(ZSciBaseModel):
    query: str
    count: int
    papers: list[CandidatePaperOut]


class LiteratureRecommendResponse(ZSciBaseModel):
    """Top-N papers ranked by similarity to the project's interest profile."""

    query: str
    count: int
    papers: list[CandidatePaperOut]


# ---------------------------------------------------------------------------
# Papers
# ---------------------------------------------------------------------------


class PaperOut(ZSciBaseModel):
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


class DownloadPaperRequest(ZSciBaseModel):
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


class ImportLocalPdfRequest(ZSciBaseModel):
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


class ParseResponse(ZSciBaseModel):
    paper_id: str
    pages: int
    parse_status: str
    sections: list[dict] = Field(default_factory=list)


# ---------------------------------------------------------------------------
# Translation + reading notes
# ---------------------------------------------------------------------------


class TranslateRequest(ZSciBaseModel):
    text: str = Field(min_length=1)
    page: int | None = None
    target_lang: str = "中文"


class TranslationOut(ZSciBaseModel):
    id: str
    paper_id: str
    page: int | None
    original_text: str | None
    translated_text: str
    model: str | None
    created_at: datetime

    model_config = {"from_attributes": True}


class ReadingNoteOut(ZSciBaseModel):
    id: str
    paper_id: str
    kind: str
    page: int | None
    original_text: str | None
    content: str
    model: str | None
    created_at: datetime

    model_config = {"from_attributes": True}


class ReadingNoteUpdate(ZSciBaseModel):
    content: str


# ---------------------------------------------------------------------------
# Annotations
# ---------------------------------------------------------------------------


class AnnotationCreate(ZSciBaseModel):
    page_number: int | None = None
    selected_text: str | None = None
    rects_json: str | None = None
    comment: str | None = None
    color: str = "#fde047"
    kind: str = "highlight"


class AnnotationUpdate(ZSciBaseModel):
    comment: str | None = None
    color: str | None = None


class AnnotationOut(ZSciBaseModel):
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


class HealthOut(ZSciBaseModel):
    status: str
    version: str
    workspace: str
    db_ok: bool = True
    db_error: str | None = None


class SettingsOut(ZSciBaseModel):
    workspace_path: str
    models: dict
    venues: list[str]


class LLMProviderPresetOut(ZSciBaseModel):
    """A selectable provider template shown in the settings dropdown."""

    id: str
    name_zh: str
    provider: str
    model: str
    base_url: str | None = None
    api_key_env: str | None = None
    needs_key: bool = True
    key_hint: str = ""


class LLMCurrentConfigOut(ZSciBaseModel):
    """The currently-applied default_chat config (no key value)."""

    provider: str | None = None
    model: str | None = None
    base_url: str | None = None
    api_key_env: str | None = None
    api_key_set: bool = False
    matched_preset_id: str | None = None


class LLMConfigOut(ZSciBaseModel):
    """GET /llm/config response: the catalog + the current selection."""

    presets: list[LLMProviderPresetOut]
    current: LLMCurrentConfigOut


class LLMConfigUpdate(ZSciBaseModel):
    """PUT /llm/config body.

    `provider_id` selects a preset (carries provider/model/base_url/api_key_env
    defaults). `model` / `base_url` optionally override the preset's defaults
    (base_url="" clears it). `api_key` is written to .env under the preset's
    api_key_env; omit or leave blank to keep any existing key untouched (the
    field is masked in the UI, so blank means "don't change").
    """

    provider_id: str
    model: str | None = None
    base_url: str | None = None
    api_key: str | None = None


# ---------------------------------------------------------------------------
# Phase 2: ideas, repositories, agent tasks, approvals
# ---------------------------------------------------------------------------


class IdeaCreate(ZSciBaseModel):
    title: str | None = None
    hypothesis: str | None = None
    motivation: str | None = None
    content: str | None = None
    status: str = "backlog"


class IdeaUpdate(ZSciBaseModel):
    title: str | None = None
    hypothesis: str | None = None
    motivation: str | None = None
    content: str | None = None
    status: str | None = None


class IdeaOut(ZSciBaseModel):
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


class RepositoryOut(ZSciBaseModel):
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


class AgentTaskCreate(ZSciBaseModel):
    task_type: str
    input: dict = Field(default_factory=dict)


class AgentTaskStartResponse(ZSciBaseModel):
    """Response for POST /projects/{id}/agent/tasks.

    Async (default): only `task_id` + `job_id` are populated; the caller
    polls `/workflows/active` or `/agent/tasks/{id}` for status.
    Sync (?sync=1, tests only): `task` carries the full row.
    """
    task_id: str
    job_id: str
    task: AgentTaskOut | None = None


class AgentTaskOut(ZSciBaseModel):
    id: str
    project_id: str
    task_type: str
    status: str
    input_json: str | None
    plan_json: str | None
    result_json: str | None
    error: str | None
    evidence_ids: str | None
    # M34: ZSciBaseModel's serializer auto-appends 'Z' to naive datetimes
    # so the browser parses them as UTC.
    created_at: datetime
    updated_at: datetime

    model_config = {"from_attributes": True}


class AgentEventOut(ZSciBaseModel):
    id: str
    task_id: str
    kind: str
    message: str | None
    payload_json: str | None
    # M34: see note on AgentTaskOut.created_at.
    created_at: datetime

    model_config = {"from_attributes": True}


class ApprovalOut(ZSciBaseModel):
    id: str
    task_id: str
    action_type: str
    payload_json: str | None
    status: str
    decision_at: datetime | None
    created_at: datetime

    model_config = {"from_attributes": True}


class ApprovalDecision(ZSciBaseModel):
    approved: bool


# ---------------------------------------------------------------------------
# Active workflows (global sidebar status): in-progress agent tasks + runs
# ---------------------------------------------------------------------------


class ActiveWorkflowTaskOut(ZSciBaseModel):
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
    # M34: ZSciBaseModel's serializer auto-appends 'Z' to naive datetimes.
    created_at: datetime
    updated_at: datetime

    model_config = {"from_attributes": True}


class ActiveWorkflowRunOut(ZSciBaseModel):
    """An in-progress experiment run, for the global workflow-status sidebar."""

    run_id: str
    experiment_id: str
    project_id: str
    experiment_title: str | None = None
    command: str | None = None
    # M34: see note on ActiveWorkflowTaskOut.created_at.
    created_at: datetime

    model_config = {"from_attributes": True}


class ActiveWorkflowsOut(ZSciBaseModel):
    tasks: list[ActiveWorkflowTaskOut] = Field(default_factory=list)
    runs: list[ActiveWorkflowRunOut] = Field(default_factory=list)
    jobs: list[JobOut] = Field(default_factory=list)


class JobOut(ZSciBaseModel):
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
    # M34: ZSciBaseModel's serializer auto-appends 'Z' to naive datetimes.
    created_at: datetime
    updated_at: datetime

    model_config = {"from_attributes": True}


# ---------------------------------------------------------------------------
# Phase 2: repositories — typed update body (M8)
# ---------------------------------------------------------------------------


class RepositoryUpdate(ZSciBaseModel):
    """Manual correction of a repository's official_status / evidence (M8).

    Replaces the previous untyped `dict` body which had no OpenAPI schema and
    accepted arbitrary values for `official_status`.
    """
    official_status: Literal["official", "author_affiliated", "community", "unverified"] | None = None
    evidence: str | None = None


# ---------------------------------------------------------------------------
# Phase 3: experiments + runs
# ---------------------------------------------------------------------------


class ExperimentCreate(ZSciBaseModel):
    title: str
    research_question: str | None = None
    hypothesis: str | None = None
    related_idea_id: str | None = None
    source_repository_id: str | None = None


class PhaseViewItem(ZSciBaseModel):
    """One entry in the `phase-view` endpoint. Carries the user-facing
    Chinese label, a one-line summary, and the lucide icon name so the
    front-end can render a phase cell without consulting a hard-coded
    table.

    Icon names match lucide-react's exports (e.g. "Target" → `Target`).
    Front-end unknown icon names fall back to `Circle`.
    """

    key: str
    name: str
    summary: str
    icon: str


class PhaseViewOut(ZSciBaseModel):
    """Aggregate response for `GET /api/v1/experiments/phase-view`.

    The front-end hydrates from this once per session (cached in
    localStorage) so it never has a divergent label table from the
    backend. Each phase key here is one of `STAGE_USER_VIEW`; statuses
    here are the union of `Experiment.overall_status` (7 values) and
    `ExperimentStage.status` (12 values), so the front-end can look up
    either kind of label via the same endpoint.
    """

    phases: list[PhaseViewItem]
    # Experiment-level aggregate status (`Experiment.overall_status`).
    experiment_status_zh: dict[str, str]
    # Stage-level status (`ExperimentStage.status`).
    stage_status_zh: dict[str, str]


class ExperimentOut(ZSciBaseModel):
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
    # 9-stage interactive workflow (see app/experiments/states.py). Older
    # experiments pre-dating the refactor have mode='interactive' and empty
    # aggregate status. These are optional so legacy / old DB rows still
    # validate; a server-side default in `_to_out` fills them when the
    # columns are null.
    mode: str | None = None
    overall_status: str | None = None
    current_stage: str | None = None
    parent_experiment_id: str | None = None
    branch_name: str | None = None
    decision_history_json: str | None = None

    model_config = {"from_attributes": True}


class RunOut(ZSciBaseModel):
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


class RunCreate(ZSciBaseModel):
    command: str
    seed: int | None = None
    confirmed: bool = False  # design.md §16.1: running shell needs approval


class MetricOut(ZSciBaseModel):
    id: str
    run_id: str
    step: int
    metric_name: str
    metric_value: float
    created_at: datetime

    model_config = {"from_attributes": True}


class BenchmarkOut(ZSciBaseModel):
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


class BenchmarkSearchRequest(ZSciBaseModel):
    query: str
    experiment_id: str | None = None
    limit: int = 8


class BenchmarkHitOut(ZSciBaseModel):
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


class BenchmarkAddRequest(ZSciBaseModel):
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


class BenchmarkUpdate(ZSciBaseModel):
    experiment_id: str | None = None


class BenchmarkManualCreate(ZSciBaseModel):
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


class BenchmarkSearchResponse(ZSciBaseModel):
    """Search-only response: ephemeral hits + source warnings.

    `benchmarks` is kept as an alias of `hits` for older clients; prefer `hits`.
    """

    hits: list[BenchmarkHitOut] = Field(default_factory=list)
    benchmarks: list[BenchmarkHitOut] = Field(default_factory=list)
    warnings: list[str] = Field(default_factory=list)
    query_used: list[str] = Field(default_factory=list)


class CodegenRequest(ZSciBaseModel):
    selected_papers: list[str] = Field(default_factory=list)
    selected_repositories: list[str] = Field(default_factory=list)


class CodegenResponse(ZSciBaseModel):
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


class DraftSectionRequest(ZSciBaseModel):
    section_name: str
    citation_keys: list[str] = Field(default_factory=list)
    run_ids: list[str] = Field(default_factory=list)
    notes: str | None = None


# ---------------------------------------------------------------------------
# Phase 4: writing router typed bodies
# ---------------------------------------------------------------------------


class WriteFileRequest(ZSciBaseModel):
    content: str = Field(min_length=0, max_length=1_000_000)


class WriteFileResponse(ZSciBaseModel):
    ok: bool
    path: str | None = None


class FileContentResponse(ZSciBaseModel):
    path: str
    content: str


class FileListResponse(ZSciBaseModel):
    files: list[str]


class InitWritingResponse(ZSciBaseModel):
    root: str
    files: list[str]


class InitWritingRequest(ZSciBaseModel):
    """Template choice for writing project init. design.md §13.6."""

    template: str = "generic"  # generic / ieee / elsevier
    # When True, an existing main.tex is overwritten with the new template's
    # preamble (document class + frontmatter). Section files and references.bib
    # are always preserved so switching templates never loses user content.
    force: bool = False


class WritingTemplateOut(ZSciBaseModel):
    key: str
    label: str
    note: str


class WritingTemplatesResponse(ZSciBaseModel):
    templates: list[WritingTemplateOut]


class CompileResponse(ZSciBaseModel):
    ok: bool
    pdf_path: str | None = None
    log: str | None = None
    error: str | None = None


# ---------------------------------------------------------------------------
# 5-phase interactive experiment workflow (see app/experiments/states.py)
# ---------------------------------------------------------------------------


class ExperimentStageOut(ZSciBaseModel):
    """Single phase snapshot returned by GET /experiments/{id}/stages.

    The front-end StageProgress component reads `stage_key` + `status`
    for the 5-cell horizontal bar, and `summary` (when waiting_for_user)
    to render the CheckpointCard.
    """

    id: str
    experiment_id: str
    stage_key: str
    stage_name_zh: str
    description: str
    requires_user: bool
    optional_user: bool
    expected_seconds: int
    version: int
    status: str
    inputs_json: dict | None = None
    outputs_json: dict | None = None
    artifacts_json: list[dict] | None = None
    config_json: dict | None = None
    user_decisions_json: list[dict] | None = None
    dependencies: list[str] | None = None
    invalidated_by_stage_id: str | None = None
    started_at: str | None = None
    ended_at: str | None = None
    # M34: ZSciBaseModel's serializer auto-appends 'Z' to naive datetimes.
    created_at: datetime
    updated_at: datetime
    # The current checkpoint summary (markdown + structured fields) so the
    # front-end can render the CheckpointCard without a second round-trip.
    # `None` until the stage reaches `waiting_for_user`.
    checkpoint_summary: dict | None = None


class StageProgressOut(ZSciBaseModel):
    """Aggregated response for GET /experiments/{id}/stages."""

    experiment_id: str
    overall_status: str
    current_stage: str | None
    mode: str
    stages: list[ExperimentStageOut]
    decision_history: list[dict] = Field(default_factory=list)
    # Most-recent error message (or `AgentTask.error`) so the page can
    # show a friendly Chinese banner when overall_status="failed". Populated
    # by the router from the latest `kind="error"` AgentTaskEvent if the
    # task itself doesn't carry an `error` string.
    last_error: str | None = None


class StartInteractiveExperimentRequest(ZSciBaseModel):
    """Body for POST /experiments/{id}/autonomous (interactive mode).

    `selected_papers` / `selected_repositories` accept FK ids so the
    orchestrator can grab the relevant context for stage_3_codegen /
    stage_2_plan.
    """

    title: str | None = None
    research_question: str | None = None
    hypothesis: str | None = None
    selected_papers: list[str] = Field(default_factory=list)
    selected_repositories: list[str] = Field(default_factory=list)
    benchmarks_query: str | None = None
    run_configs: list[str] = Field(default_factory=lambda: ["baseline"])


class ExperimentUpdate(ZSciBaseModel):
    """Body for PATCH /api/v1/experiments/{exp_id}.

    All fields optional; only provided ones are written. Use this to fill
    in `research_question` / `hypothesis` after the experiment is created
    (so the page can let the user draft a new experiment, write the
    question, then click "启动实验").
    """

    title: str | None = None
    research_question: str | None = None
    hypothesis: str | None = None


# --- Checkpoint decisions (only the 4 core buttons; UI simplified) --------


class ExperimentStageDecision(ZSciBaseModel):
    """Body for POST /api/v1/experiments/{exp_id}/decide.

    `decision` is one of the 4 stage decisions surfaced to the user:
      - approve / edit / skip / abort

    `payload` carries optional fields — e.g. an edited plan for `edit`.
    The backend resolves the owning AgentTask + pending Approval from the
    experiment's `current_stage` and the AgentTask's `checkpoint_payload`.
    """

    decision: Literal["approve", "edit", "skip", "abort"]
    target_stage_id: str | None = None
    payload: dict | None = None


class ExperimentStageDecisionOut(ZSciBaseModel):
    """Response for POST /decide."""

    ok: bool
    decision: str
    experiment_id: str
    task_id: str | None = None
    # Kept for backward-compat (the legacy fork endpoint wrote here).
    # Always None now; fork is intentionally not exposed in the UI.
    fork_experiment_id: str | None = None


class BranchOut(ZSciBaseModel):
    """A fork relationship row (experiment_branches)."""

    id: str
    experiment_id: str
    parent_experiment_id: str | None
    parent_branch_id: str | None
    fork_stage_id: str | None
    fork_stage_key: str | None
    branch_name: str
    created_at: str


class ForkRequest(ZSciBaseModel):
    """Body for POST /api/v1/experiments/{exp_id}/fork (direct, non-decide path)."""

    target_stage_id: str
    title: str | None = None
    branch_name: str | None = None
