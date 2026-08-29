"""ORM models for Phase 1.

Subset of design.md §14 plus `reading_notes` and `audit_log`:
projects, papers, paper_files, annotations, reading_notes, audit_log.
Deferred to Phase 2+: ideas, experiments, experiment_runs, run_metrics,
repositories, agent_tasks, approvals.
"""
from __future__ import annotations

from datetime import datetime, timezone

from sqlalchemy import (
    Boolean,
    DateTime,
    Float,
    ForeignKey,
    Integer,
    String,
    Text,
)
from sqlalchemy.orm import Mapped, mapped_column, relationship

from app.db.base import Base


def _now() -> datetime:
    return datetime.now(timezone.utc)


class Project(Base):
    __tablename__ = "projects"

    id: Mapped[str] = mapped_column(String, primary_key=True)
    name: Mapped[str] = mapped_column(String, nullable=False)
    slug: Mapped[str] = mapped_column(String, unique=True, nullable=False, index=True)
    research_direction: Mapped[str | None] = mapped_column(Text, nullable=True)
    root_path: Mapped[str] = mapped_column(Text, nullable=False)
    status: Mapped[str] = mapped_column(String, default="active")
    created_at: Mapped[datetime] = mapped_column(DateTime, default=_now)
    updated_at: Mapped[datetime] = mapped_column(DateTime, default=_now, onupdate=_now)

    papers: Mapped[list[Paper]] = relationship(
        back_populates="project", cascade="all, delete-orphan"
    )


class Paper(Base):
    __tablename__ = "papers"

    id: Mapped[str] = mapped_column(String, primary_key=True)
    project_id: Mapped[str] = mapped_column(
        ForeignKey("projects.id", ondelete="CASCADE"), nullable=False, index=True
    )
    title: Mapped[str] = mapped_column(Text, nullable=False)
    abstract: Mapped[str | None] = mapped_column(Text, nullable=True)
    authors_json: Mapped[str | None] = mapped_column(Text, nullable=True)  # JSON list
    year: Mapped[int | None] = mapped_column(Integer, nullable=True, index=True)
    venue: Mapped[str | None] = mapped_column(String, nullable=True)
    venue_verified: Mapped[bool] = mapped_column(Boolean, default=False)
    doi: Mapped[str | None] = mapped_column(String, nullable=True, index=True)
    arxiv_id: Mapped[str | None] = mapped_column(String, nullable=True, index=True)
    source_url: Mapped[str | None] = mapped_column(Text, nullable=True)
    pdf_url: Mapped[str | None] = mapped_column(Text, nullable=True)
    local_pdf_path: Mapped[str | None] = mapped_column(Text, nullable=True)
    downloaded: Mapped[bool] = mapped_column(Boolean, default=False)
    parse_status: Mapped[str | None] = mapped_column(String, default=None)
    official_code_url: Mapped[str | None] = mapped_column(Text, nullable=True)
    source: Mapped[str | None] = mapped_column(String, nullable=True)  # OpenAlex/arXiv/...
    created_at: Mapped[datetime] = mapped_column(DateTime, default=_now)
    updated_at: Mapped[datetime] = mapped_column(DateTime, default=_now, onupdate=_now)

    project: Mapped[Project] = relationship(back_populates="papers")
    files: Mapped[list[PaperFile]] = relationship(
        back_populates="paper", cascade="all, delete-orphan"
    )
    annotations: Mapped[list[Annotation]] = relationship(
        back_populates="paper", cascade="all, delete-orphan"
    )
    notes: Mapped[list[ReadingNote]] = relationship(
        back_populates="paper", cascade="all, delete-orphan"
    )


class PaperFile(Base):
    __tablename__ = "paper_files"

    id: Mapped[str] = mapped_column(String, primary_key=True)
    paper_id: Mapped[str] = mapped_column(
        ForeignKey("papers.id", ondelete="CASCADE"), nullable=False, index=True
    )
    file_type: Mapped[str | None] = mapped_column(String, nullable=True)
    relative_path: Mapped[str] = mapped_column(Text, nullable=False)
    sha256: Mapped[str | None] = mapped_column(String, nullable=True)
    file_size: Mapped[int | None] = mapped_column(Integer, nullable=True)
    created_at: Mapped[datetime] = mapped_column(DateTime, default=_now)

    paper: Mapped[Paper] = relationship(back_populates="files")


class Annotation(Base):
    """PDF highlight/comment, design.md §14.1."""

    __tablename__ = "annotations"

    id: Mapped[str] = mapped_column(String, primary_key=True)
    paper_id: Mapped[str] = mapped_column(
        ForeignKey("papers.id", ondelete="CASCADE"), nullable=False, index=True
    )
    page_number: Mapped[int | None] = mapped_column(Integer, nullable=True)
    selected_text: Mapped[str | None] = mapped_column(Text, nullable=True)
    rects_json: Mapped[str | None] = mapped_column(Text, nullable=True)
    comment: Mapped[str | None] = mapped_column(Text, nullable=True)
    color: Mapped[str | None] = mapped_column(String, default="#fde047")
    kind: Mapped[str] = mapped_column(String, default="highlight")  # highlight/note/translation
    created_at: Mapped[datetime] = mapped_column(DateTime, default=_now)
    updated_at: Mapped[datetime] = mapped_column(DateTime, default=_now, onupdate=_now)

    paper: Mapped[Paper] = relationship(back_populates="annotations")


class ReadingNote(Base):
    """Generated reading note or translation record, design.md §7.3 + §9.3."""

    __tablename__ = "reading_notes"

    id: Mapped[str] = mapped_column(String, primary_key=True)
    paper_id: Mapped[str] = mapped_column(
        ForeignKey("papers.id", ondelete="CASCADE"), nullable=False, index=True
    )
    kind: Mapped[str] = mapped_column(String, nullable=False)  # note/translation
    page: Mapped[int | None] = mapped_column(Integer, nullable=True)
    original_text: Mapped[str | None] = mapped_column(Text, nullable=True)
    content: Mapped[str] = mapped_column(Text, nullable=False)  # note body / translated text
    model: Mapped[str | None] = mapped_column(String, nullable=True)
    created_at: Mapped[datetime] = mapped_column(DateTime, default=_now)

    paper: Mapped[Paper] = relationship(back_populates="notes")


class AuditLog(Base):
    """Audit trail for downloads, file writes, model calls. design.md §2.1, §8.1."""

    __tablename__ = "audit_log"

    id: Mapped[str] = mapped_column(String, primary_key=True)
    action_type: Mapped[str] = mapped_column(String, nullable=False, index=True)
    project_id: Mapped[str | None] = mapped_column(String, nullable=True, index=True)
    target: Mapped[str | None] = mapped_column(Text, nullable=True)
    payload_json: Mapped[str | None] = mapped_column(Text, nullable=True)
    status: Mapped[str] = mapped_column(String, default="ok")  # ok/error
    created_at: Mapped[datetime] = mapped_column(DateTime, default=_now, index=True)


# ---------------------------------------------------------------------------
# Phase 2: ideas, repositories, agent_tasks, approvals (design.md §14)
# ---------------------------------------------------------------------------


class Idea(Base):
    """A research idea / hypothesis. design.md §9.5, §14.1."""

    __tablename__ = "ideas"

    id: Mapped[str] = mapped_column(String, primary_key=True)
    project_id: Mapped[str] = mapped_column(
        ForeignKey("projects.id", ondelete="CASCADE"), nullable=False, index=True
    )
    title: Mapped[str | None] = mapped_column(Text, nullable=True)
    hypothesis: Mapped[str | None] = mapped_column(Text, nullable=True)
    motivation: Mapped[str | None] = mapped_column(Text, nullable=True)
    status: Mapped[str] = mapped_column(String, default="backlog")  # backlog/hypothesis/decision/rejected
    evidence_json: Mapped[str | None] = mapped_column(Text, nullable=True)
    risks_json: Mapped[str | None] = mapped_column(Text, nullable=True)
    content: Mapped[str | None] = mapped_column(Text, nullable=True)  # free-form markdown body
    created_at: Mapped[datetime] = mapped_column(DateTime, default=_now)
    updated_at: Mapped[datetime] = mapped_column(DateTime, default=_now, onupdate=_now)


class Repository(Base):
    """A code repository linked to a paper. design.md §9.4, §14.1."""

    __tablename__ = "repositories"

    id: Mapped[str] = mapped_column(String, primary_key=True)
    project_id: Mapped[str] = mapped_column(
        ForeignKey("projects.id", ondelete="CASCADE"), nullable=False, index=True
    )
    paper_id: Mapped[str | None] = mapped_column(
        ForeignKey("papers.id", ondelete="SET NULL"), nullable=True, index=True
    )
    repo_url: Mapped[str] = mapped_column(Text, nullable=False)
    full_name: Mapped[str | None] = mapped_column(String, nullable=True)  # owner/repo
    local_path: Mapped[str | None] = mapped_column(Text, nullable=True)
    commit_sha: Mapped[str | None] = mapped_column(String, nullable=True)
    official_status: Mapped[str] = mapped_column(String, default="unverified")
    # official / author_affiliated / community / unverified
    license: Mapped[str | None] = mapped_column(String, nullable=True)
    stars: Mapped[int | None] = mapped_column(Integer, nullable=True)
    evidence: Mapped[str | None] = mapped_column(Text, nullable=True)
    provenance_json: Mapped[str | None] = mapped_column(Text, nullable=True)
    created_at: Mapped[datetime] = mapped_column(DateTime, default=_now)


class AgentTask(Base):
    """An Agent task with plan/result + approval gates. design.md §8.1, §14.1, §15.4."""

    __tablename__ = "agent_tasks"

    id: Mapped[str] = mapped_column(String, primary_key=True)
    project_id: Mapped[str] = mapped_column(
        ForeignKey("projects.id", ondelete="CASCADE"), nullable=False, index=True
    )
    task_type: Mapped[str] = mapped_column(String, nullable=False, index=True)
    # e.g. research.trend_analysis / research.generate_hypothesis / code.search_github /
    #      experiment.create_plan / writing.draft_section
    input_json: Mapped[str | None] = mapped_column(Text, nullable=True)
    # Real column for the experiment an autonomous-run task drives (was
    # previously buried inside input_json, forcing JSON scans per query).
    experiment_id: Mapped[str | None] = mapped_column(String, nullable=True, index=True)
    plan_json: Mapped[str | None] = mapped_column(Text, nullable=True)
    status: Mapped[str] = mapped_column(String, default="pending")
    # pending / planning / awaiting_approval / running / completed / failed / rejected
    result_json: Mapped[str | None] = mapped_column(Text, nullable=True)
    error: Mapped[str | None] = mapped_column(Text, nullable=True)
    evidence_ids: Mapped[str | None] = mapped_column(Text, nullable=True)  # JSON list
    # --- 9-stage interactive workflow (see app/experiments/states.py) ---
    # `stage_key` lets the front-end identify which stage's checkpoint is
    # pending via the existing `/workflows/active` SSE stream without
    # joining experiment_stages. `checkpoint_payload_json` is the cached
    # summary that the orchestrator wrote when calling request_approval,
    # so the UI can render the checkpoint card without another round-trip.
    stage_key: Mapped[str | None] = mapped_column(String, nullable=True, index=True)
    checkpoint_payload_json: Mapped[str | None] = mapped_column(Text, nullable=True)
    created_at: Mapped[datetime] = mapped_column(DateTime, default=_now, index=True)
    updated_at: Mapped[datetime] = mapped_column(DateTime, default=_now, onupdate=_now)

    approvals: Mapped[list["Approval"]] = relationship(
        back_populates="task", cascade="all, delete-orphan"
    )
    events: Mapped[list["AgentTaskEvent"]] = relationship(
        back_populates="task", cascade="all, delete-orphan"
    )


class Approval(Base):
    """A user approval gate for a sensitive Agent action. design.md §16, §14.1."""

    __tablename__ = "approvals"

    id: Mapped[str] = mapped_column(String, primary_key=True)
    task_id: Mapped[str] = mapped_column(
        ForeignKey("agent_tasks.id", ondelete="CASCADE"), nullable=False, index=True
    )
    action_type: Mapped[str] = mapped_column(String, nullable=False)
    payload_json: Mapped[str | None] = mapped_column(Text, nullable=True)
    status: Mapped[str] = mapped_column(String, default="pending")  # pending/approved/rejected
    decision_at: Mapped[datetime | None] = mapped_column(DateTime, nullable=True)
    created_at: Mapped[datetime] = mapped_column(DateTime, default=_now)

    task: Mapped[AgentTask] = relationship(back_populates="approvals")


class AgentTaskEvent(Base):
    """Append-only event stream for an Agent task (SSE source). design.md §8.1."""

    __tablename__ = "agent_task_events"

    id: Mapped[str] = mapped_column(String, primary_key=True)
    task_id: Mapped[str] = mapped_column(
        ForeignKey("agent_tasks.id", ondelete="CASCADE"), nullable=False, index=True
    )
    kind: Mapped[str] = mapped_column(String, nullable=False)  # step/tool/warning/result/approval
    message: Mapped[str | None] = mapped_column(Text, nullable=True)
    payload_json: Mapped[str | None] = mapped_column(Text, nullable=True)
    created_at: Mapped[datetime] = mapped_column(DateTime, default=_now, index=True)

    task: Mapped[AgentTask] = relationship(back_populates="events")


# ---------------------------------------------------------------------------
# Phase 3: experiments, experiment_runs, run_metrics (design.md §14.1)
# ---------------------------------------------------------------------------


class Experiment(Base):
    """An experiment in a project. design.md §9.6, §14.1.

    The 9-stage interactive workflow (see app/experiments/states.py) writes
    each stage's snapshot to `experiment_stages`. The `status` field is kept
    for backward compatibility with the legacy 5-stage linear pipeline —
    newer code reads `overall_status` instead, which is the aggregated
    state across all stages (draft / running / paused / waiting_user /
    completed / failed / archived). `current_stage` is the most recently
    active stage_key (cached for the front-end's quick lookup).
    """

    __tablename__ = "experiments"

    id: Mapped[str] = mapped_column(String, primary_key=True)
    project_id: Mapped[str] = mapped_column(
        ForeignKey("projects.id", ondelete="CASCADE"), nullable=False, index=True
    )
    title: Mapped[str | None] = mapped_column(Text, nullable=True)
    slug: Mapped[str | None] = mapped_column(String, nullable=True, index=True)
    root_path: Mapped[str | None] = mapped_column(Text, nullable=True)
    source_repository_id: Mapped[str | None] = mapped_column(
        ForeignKey("repositories.id", ondelete="SET NULL"), nullable=True
    )
    related_idea_id: Mapped[str | None] = mapped_column(
        ForeignKey("ideas.id", ondelete="SET NULL"), nullable=True
    )
    # Legacy linear status — kept for back-compat reads; new code should
    # consult `overall_status` + experiment_stages rows.
    status: Mapped[str] = mapped_column(String, default="planned")
    # planned / scaffolded / running / done / failed
    plan_json: Mapped[str | None] = mapped_column(Text, nullable=True)
    research_question: Mapped[str | None] = mapped_column(Text, nullable=True)
    hypothesis: Mapped[str | None] = mapped_column(Text, nullable=True)
    # --- 9-stage interactive workflow (see app/experiments/states.py) ---
    mode: Mapped[str] = mapped_column(String, default="interactive")
    # interactive | auto (legacy 5-stage linear)
    overall_status: Mapped[str] = mapped_column(String, default="draft")
    # draft / running / paused / waiting_user / completed / failed / archived
    current_stage: Mapped[str | None] = mapped_column(String, nullable=True, index=True)
    parent_experiment_id: Mapped[str | None] = mapped_column(
        ForeignKey("experiments.id", ondelete="SET NULL"), nullable=True, index=True
    )
    branch_name: Mapped[str | None] = mapped_column(String, nullable=True)
    decision_history_json: Mapped[str | None] = mapped_column(Text, nullable=True)
    created_at: Mapped[datetime] = mapped_column(DateTime, default=_now)
    updated_at: Mapped[datetime] = mapped_column(DateTime, default=_now, onupdate=_now)

    runs: Mapped[list["ExperimentRun"]] = relationship(
        back_populates="experiment", cascade="all, delete-orphan"
    )
    stages: Mapped[list["ExperimentStage"]] = relationship(
        back_populates="experiment",
        cascade="all, delete-orphan",
        order_by="ExperimentStage.stage_key",
    )
    branches: Mapped[list["ExperimentBranch"]] = relationship(
        back_populates="experiment",
        cascade="all, delete-orphan",
        foreign_keys="ExperimentBranch.experiment_id",
    )


class ExperimentRun(Base):
    """A single execution of an experiment. design.md §11.4, §14.1."""

    __tablename__ = "experiment_runs"

    id: Mapped[str] = mapped_column(String, primary_key=True)
    experiment_id: Mapped[str] = mapped_column(
        ForeignKey("experiments.id", ondelete="CASCADE"), nullable=False, index=True
    )
    run_path: Mapped[str | None] = mapped_column(Text, nullable=True)
    command: Mapped[str | None] = mapped_column(Text, nullable=True)
    status: Mapped[str] = mapped_column(String, default="created")
    # created / running / completed / failed / stopped
    git_commit: Mapped[str | None] = mapped_column(String, nullable=True)
    environment_fingerprint: Mapped[str | None] = mapped_column(Text, nullable=True)
    seed: Mapped[int | None] = mapped_column(Integer, nullable=True)
    pid: Mapped[int | None] = mapped_column(Integer, nullable=True)
    start_at: Mapped[datetime | None] = mapped_column(DateTime, nullable=True)
    end_at: Mapped[datetime | None] = mapped_column(DateTime, nullable=True)
    created_at: Mapped[datetime] = mapped_column(DateTime, default=_now, index=True)

    experiment: Mapped[Experiment] = relationship(back_populates="runs")
    metrics: Mapped[list["RunMetric"]] = relationship(
        back_populates="run", cascade="all, delete-orphan"
    )


class RunMetric(Base):
    """A single metric value at a training step. design.md §12, §14.1."""

    __tablename__ = "run_metrics"

    id: Mapped[str] = mapped_column(String, primary_key=True)
    run_id: Mapped[str] = mapped_column(
        ForeignKey("experiment_runs.id", ondelete="CASCADE"), nullable=False, index=True
    )
    step: Mapped[int] = mapped_column(Integer, default=0)
    metric_name: Mapped[str] = mapped_column(String, nullable=False, index=True)
    metric_value: Mapped[float] = mapped_column(Float, nullable=False)
    created_at: Mapped[datetime] = mapped_column(DateTime, default=_now)

    run: Mapped[ExperimentRun] = relationship(back_populates="metrics")


class Benchmark(Base):
    """A benchmark dataset/task + optional SOTA number found for a project.

    Populated by the experiment agent's find_benchmarks step (PapersWithCode /
    HuggingFace). `kind` is "dataset" | "task" | "sota". For SOTA rows,
    metric_name + metric_value hold the leaderboard number to compare the
    user's results against.
    """

    __tablename__ = "benchmarks"

    id: Mapped[str] = mapped_column(String, primary_key=True)
    project_id: Mapped[str] = mapped_column(
        ForeignKey("projects.id", ondelete="CASCADE"), nullable=False, index=True
    )
    experiment_id: Mapped[str | None] = mapped_column(
        ForeignKey("experiments.id", ondelete="SET NULL"), nullable=True, index=True
    )
    name: Mapped[str] = mapped_column(Text, nullable=False)
    kind: Mapped[str] = mapped_column(String, nullable=False)  # dataset | task | sota
    source: Mapped[str] = mapped_column(String, nullable=False)  # paperswithcode | hf
    url: Mapped[str | None] = mapped_column(Text, nullable=True)
    task_name: Mapped[str | None] = mapped_column(Text, nullable=True)
    dataset_name: Mapped[str | None] = mapped_column(Text, nullable=True)
    metric_name: Mapped[str | None] = mapped_column(String, nullable=True)
    metric_value: Mapped[float | None] = mapped_column(Float, nullable=True)
    paper_id: Mapped[str | None] = mapped_column(
        ForeignKey("papers.id", ondelete="SET NULL"), nullable=True
    )
    extra_json: Mapped[str | None] = mapped_column(Text, nullable=True)
    created_at: Mapped[datetime] = mapped_column(DateTime, default=_now)


class Job(Base):
    """A user-triggered long-running operation, for the global workflow sidebar.

    The sidebar (`GET /workflows/active`) lists in-progress Jobs across all
    projects so navigating away from a slow operation (literature search, paper
    download, translation, LaTeX compile, benchmark search, ...) doesn't lose
    it. The key invariant: `start_job` COMMITS the `running` row immediately -
    not just flush - so the sidebar's separate DB session can read it while the
    operation is still in-flight in the originating request.

    `kind` values: literature_search | literature_recommend | paper_download |
    paper_parse | translate | reading_note | latex_compile | benchmark_search |
    experiment_run | experiment_scaffold | writing_init.
    `target_type` values: paper | experiment | run | literature | writing - drives
    the sidebar's deep-link target. `target_id` is the related entity id (if any).
    """

    __tablename__ = "jobs"

    id: Mapped[str] = mapped_column(String, primary_key=True)
    project_id: Mapped[str] = mapped_column(
        ForeignKey("projects.id", ondelete="CASCADE"), nullable=False, index=True
    )
    kind: Mapped[str] = mapped_column(String, nullable=False, index=True)
    status: Mapped[str] = mapped_column(String, default="running")
    # running | completed | failed | stopped
    title: Mapped[str | None] = mapped_column(Text, nullable=True)
    target_id: Mapped[str | None] = mapped_column(String, nullable=True, index=True)
    target_type: Mapped[str | None] = mapped_column(String, nullable=True)
    message: Mapped[str | None] = mapped_column(Text, nullable=True)
    error: Mapped[str | None] = mapped_column(Text, nullable=True)
    result_summary: Mapped[str | None] = mapped_column(Text, nullable=True)
    created_at: Mapped[datetime] = mapped_column(DateTime, default=_now, index=True)
    updated_at: Mapped[datetime] = mapped_column(DateTime, default=_now, onupdate=_now)


# ---------------------------------------------------------------------------
# 9-stage interactive experiment workflow (see app/experiments/states.py)
# ---------------------------------------------------------------------------


class ExperimentStage(Base):
    """A single stage's snapshot in the 9-stage interactive workflow.

    The `stage_key` follows the convention `stage_<index>_<short>`, e.g.
    `stage_0_init`, `stage_1_benchmarks`, `stage_2_plan`, ...

    Each row is a (version, status) pair — when a stage is re-run, a new
    row is created with a bumped `version` instead of mutating in place,
    so the history of edits is preserved per `agent_tasks` audit.

    `status` is the source of truth for the state machine; `overall_status`
    on the parent Experiment is the aggregate.

    `invalidated_by_stage_id` is non-null when a downstream stage's inputs
    no longer match the upstream ones (e.g. user edited stage_3 codegen,
    which marked stage_4..8 as `outdated`).
    """

    __tablename__ = "experiment_stages"

    id: Mapped[str] = mapped_column(String, primary_key=True)
    experiment_id: Mapped[str] = mapped_column(
        ForeignKey("experiments.id", ondelete="CASCADE"), nullable=False, index=True
    )
    stage_key: Mapped[str] = mapped_column(String, nullable=False, index=True)
    version: Mapped[int] = mapped_column(Integer, default=1)
    status: Mapped[str] = mapped_column(String, default="not_started")
    # not_started / draft / waiting_for_user / approved / running /
    # paused / completed / failed / needs_revision / skipped / outdated / archived
    inputs_json: Mapped[str | None] = mapped_column(Text, nullable=True)
    outputs_json: Mapped[str | None] = mapped_column(Text, nullable=True)
    artifacts_json: Mapped[str | None] = mapped_column(Text, nullable=True)
    config_json: Mapped[str | None] = mapped_column(Text, nullable=True)
    logs_json: Mapped[str | None] = mapped_column(Text, nullable=True)
    user_decisions_json: Mapped[str | None] = mapped_column(Text, nullable=True)
    dependencies: Mapped[str | None] = mapped_column(Text, nullable=True)
    # JSON list of upstream stage_keys; the orchestrator uses this to
    # mark downstream stages as `outdated` when an upstream is re-run.
    invalidated_by_stage_id: Mapped[str | None] = mapped_column(
        ForeignKey("experiment_stages.id", ondelete="SET NULL"), nullable=True
    )
    started_at: Mapped[datetime | None] = mapped_column(DateTime, nullable=True)
    ended_at: Mapped[datetime | None] = mapped_column(DateTime, nullable=True)
    created_at: Mapped[datetime] = mapped_column(DateTime, default=_now)
    updated_at: Mapped[datetime] = mapped_column(DateTime, default=_now, onupdate=_now)

    experiment: Mapped[Experiment] = relationship(back_populates="stages")


class ExperimentBranch(Base):
    """A fork of an experiment at a specific stage.

    One row per branch. The current experiment's `parent_experiment_id` is
    the parent in the branch graph; `fork_stage_id` is the stage at which
    the fork happened (the new experiment starts re-running from that
    stage). `parent_branch_id` allows chains of forks.

    Like git's branch model — `branch_name` is human-readable (e.g.
    "ablation-no-aug"); the parent_id gives the immutable graph.
    """

    __tablename__ = "experiment_branches"

    id: Mapped[str] = mapped_column(String, primary_key=True)
    experiment_id: Mapped[str] = mapped_column(
        ForeignKey("experiments.id", ondelete="CASCADE"), nullable=False, index=True
    )
    parent_experiment_id: Mapped[str | None] = mapped_column(
        ForeignKey("experiments.id", ondelete="SET NULL"), nullable=True, index=True
    )
    parent_branch_id: Mapped[str | None] = mapped_column(
        ForeignKey("experiment_branches.id", ondelete="SET NULL"), nullable=True
    )
    fork_stage_id: Mapped[str | None] = mapped_column(
        ForeignKey("experiment_stages.id", ondelete="SET NULL"), nullable=True
    )
    branch_name: Mapped[str] = mapped_column(String, nullable=False)
    created_at: Mapped[datetime] = mapped_column(DateTime, default=_now)

    experiment: Mapped[Experiment] = relationship(
        back_populates="branches",
        foreign_keys=[experiment_id],
    )
