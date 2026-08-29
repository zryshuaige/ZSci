"""Experiments router (design.md §15.3, §9.6)."""
from __future__ import annotations

import asyncio
import json
from datetime import UTC, datetime

from fastapi import APIRouter, Depends, HTTPException, Query, Request
from fastapi.responses import StreamingResponse
from sqlalchemy import select
from sqlalchemy.orm import Session

from app.config import get_settings
from app.db.models import AgentTask, Benchmark, Experiment, ExperimentRun, Idea, Project, RunMetric
from app.db.session import get_db
from app.experiments.benchmarks import (
    create_manual_benchmark,
    delete_benchmark,
    expand_search_queries,
    link_benchmark_experiment,
    search_huggingface_datasets,
    store_benchmark_hit,
)
from app.experiments.codegen import generate_experiment_code
from app.experiments.runner import run_experiment, stop_run, tail_log
from app.experiments.scaffold import scaffold_experiment
from app.llm.gateway import ModelNotConfigured
from app.schemas import (
    BenchmarkAddRequest,
    BenchmarkHitOut,
    BenchmarkManualCreate,
    BenchmarkOut,
    BenchmarkSearchRequest,
    BenchmarkSearchResponse,
    BenchmarkUpdate,
    BranchOut,
    ExperimentCreate,
    ExperimentOut,
    ExperimentStageDecision,
    ExperimentStageDecisionOut,
    ExperimentStageOut,
    ExperimentUpdate,
    ForkRequest,
    MetricOut,
    NextStepOut,
    NextStepsOut,
    PhaseViewItem,
    PhaseViewOut,
    PlanPreviewMetricOut,
    PlanPreviewOut,
    RunCreate,
    RunOut,
    StageProgressOut,
)
from app.utils import iso_utc, new_id, slugify
from app.workspace.manager import WorkspaceManager, audit
from app.workspace.sandbox import assert_within_project, project_dir

router = APIRouter(tags=["experiments"])
_ws = WorkspaceManager()


def _to_out(e: Experiment) -> ExperimentOut:
    return ExperimentOut(
        id=e.id, project_id=e.project_id, title=e.title, slug=e.slug,
        root_path=e.root_path, source_repository_id=e.source_repository_id,
        related_idea_id=e.related_idea_id, status=e.status,
        research_question=e.research_question, hypothesis=e.hypothesis,
        plan_json=e.plan_json, created_at=e.created_at, updated_at=e.updated_at,
        mode=e.mode, overall_status=e.overall_status, current_stage=e.current_stage,
        parent_experiment_id=e.parent_experiment_id, branch_name=e.branch_name,
        decision_history_json=e.decision_history_json,
    )


@router.post("/api/v1/projects/{project_id}/experiments", response_model=ExperimentOut)
def create_experiment(
    project_id: str, payload: ExperimentCreate, db: Session = Depends(get_db)
) -> ExperimentOut:
    project = db.get(Project, project_id)
    if project is None:
        raise HTTPException(404, "Project not found")
    # Iteration 4 — three-tier fallback for research_question:
    #   1. Explicit non-empty caller-provided RQ (used as-is, even
    #      when an Idea is also present).
    #   2. Blank RQ (caller omitted OR sent "") + valid related_idea_id
    #      with `hypothesis` → inherit that as the RQ.
    #   3. Blank RQ + Idea with blank `hypothesis` but non-blank
    #      `motivation` → inherit `motivation`. (Previously the M30
    #      inheritance was a one-shot lookup of `idea.hypothesis` only,
    #      which silently produced empty-RQ experiments when a candidate
    #      had motivation but no hypothesis.)
    #   4. Blank RQ + Idea with blank `hypothesis` + blank `motivation`
    #      + non-blank `title` → inherit the title.
    #   5. Blank RQ + no valid Idea (or all-blank Idea) → if the caller
    #      omitted the field entirely, 422 with the friendly Chinese
    #      message. If the caller sent an explicit empty string, the
    #      round-trip preserves "" verbatim so the existing
    #      "create empty → PATCH later" workflow keeps working
    #      (see test_stage_decisions.py::_make_experiment).
    #
    # Hypothesis follows the same chain (omitted → motivation →
    # hypothesis → title) but only triggers on **omitted** (M30
    # semantics): an explicit "" or "X" round-trips literally so
    # the "create empty → PATCH later" workflow + PATCH tests keep
    # working.
    rq: str | None = payload.research_question
    hyp: str | None = payload.hypothesis
    rq_inherited = "research_question" not in payload.model_fields_set
    hyp_inherited = "hypothesis" not in payload.model_fields_set
    idea: Idea | None = None
    if payload.related_idea_id:
        idea = db.get(Idea, payload.related_idea_id)
        # M30 semantics: only inherit from ideas that belong to the
        # same project; cross-project idea → no inheritance (treated
        # the same as no idea at all for this lookup).
        if idea is not None and idea.project_id != project_id:
            idea = None
    # 3-tier fall-back triggers whenever the RQ is blank (omitted OR
    # explicit "") AND a usable Idea exists with at least one
    # non-blank text field. This matches the plan's "若空且有
    # related_idea_id" wording and prevents the ExploreIdeasPage
    # "adopt blank candidate" flow from producing empty-RQ
    # experiments when a candidate's hypothesis happens to be blank.
    # The fall-back mutates `rq` only when there's actually something
    # to grab — caller-provided `""` is preserved when the Idea has
    # nothing usable, so the "create empty → PATCH later" workflow
    # still works.
    rq_is_blank = not (rq or "").strip()
    if rq_is_blank and idea is not None:
        recovered = idea.hypothesis or idea.motivation or idea.title
        if recovered and recovered.strip():
            rq = recovered
    if hyp_inherited and idea is not None:
        recovered_hyp = idea.motivation or idea.hypothesis or idea.title
        if recovered_hyp and recovered_hyp.strip():
            hyp = recovered_hyp
    # Normalise blank values to None when the value came from
    # inheritance (Idea fields might be None/blank). Caller-provided
    # explicit "" round-trips literally so PATCH /experiments/{id}
    # tests + the front-end see the same shape back.
    rq_norm: str | None = (
        (rq or "").strip() or None if rq_inherited else rq
    )
    hyp_norm: str | None = (
        (hyp or "").strip() or None if hyp_inherited else hyp
    )

    # Final guard: 422 only fires when the caller OMITTED the field
    # entirely AND no Idea fallback could supply text. Explicit empty
    # strings (the "create empty → PATCH later" workflow) bypass the
    # 422 by design — see test_stage_decisions.py::_make_experiment.
    if rq_inherited and not (rq_norm and rq_norm.strip()):
        raise HTTPException(
            status_code=422,
            detail=(
                "请先描述要研究的问题,再创建实验。"
                "你可以在表单里直接填写,或先选择一个研究想法。"
            ),
        )
    exp_slug = slugify(payload.title)
    # ensure uniqueness
    existing = db.scalar(select(Experiment).where(Experiment.project_id == project_id, Experiment.slug == exp_slug))
    if existing:
        exp_slug = f"{exp_slug}-{new_id('x')[:4]}"
    try:
        root = scaffold_experiment(project.slug, exp_slug, payload.title)
    except FileExistsError as exc:
        raise HTTPException(409, str(exc)) from exc
    exp = Experiment(
        id=new_id("exp"),
        project_id=project_id,
        title=payload.title,
        slug=exp_slug,
        root_path=str(root.relative_to(get_settings().projects_root)),
        source_repository_id=payload.source_repository_id,
        related_idea_id=payload.related_idea_id,
        status="scaffolded",
        research_question=rq_norm,
        hypothesis=hyp_norm,
    )
    db.add(exp)
    audit(db, action_type="experiment.scaffold", project_id=project_id, target=str(root),
          payload={"experiment_id": exp.id, "slug": exp_slug})
    db.commit()
    db.refresh(exp)
    return _to_out(exp)


@router.get("/api/v1/projects/{project_id}/experiments", response_model=list[ExperimentOut])
def list_experiments(project_id: str, db: Session = Depends(get_db)) -> list[ExperimentOut]:
    rows = db.scalars(
        select(Experiment).where(Experiment.project_id == project_id).order_by(Experiment.created_at.desc())
    ).all()
    return [_to_out(e) for e in rows]


# Iteration 4 — Phase-view endpoint declared BEFORE the
# /experiments/{exp_id} routes so the static "phase-view" path wins
# over the dynamic {exp_id} path. (FastAPI/Starlette matches routes in
# declaration order; otherwise the `{exp_id}` matcher would consume
# "phase-view" as an experiment id and 404 with "Experiment not found".)
@router.get("/api/v1/experiments/phase-view", response_model=PhaseViewOut)
def get_phase_view() -> PhaseViewOut:
    """Return the user-facing phase / status labels as a single document.

    Iteration 4 — the front-end previously maintained its own copy of
    these label tables in `lib/labels.ts` and `lib/stageLabels.ts`, which
    drifted from the backend's `STAGE_USER_VIEW` / `EXPERIMENT_STATUS_ZH`
    / `STAGE_STATUS_ZH` over time (e.g. `EXPERIMENT_STATUS_LABELS` still
    referenced the deprecated `scaffolded` / `generated` / `done` /
    `smoke_failed` keys while the backend was emitting `draft` /
    `running` / `completed` / `failed`). This endpoint is the single
    source of truth: the front-end hydrates once per page session and
    caches the response in localStorage under `zsci.phase-view.v1`.

    Returning a single endpoint (instead of three separate ones) means
    the front-end has one fetch + one cache key to invalidate, and the
    schemas can stay in lock-step with `app.experiments.states`.
    """
    from app.experiments.states import (
        EXPERIMENT_STATUS_ZH,
        STAGE_STATUS_ZH,
        STAGE_USER_VIEW,
    )
    from app.schemas import PhaseViewItem

    phases = [
        PhaseViewItem(
            key=k,
            name=v["name"],
            summary=v["summary"],
            icon=v["icon"],
        )
        for k, v in STAGE_USER_VIEW.items()
    ]
    return PhaseViewOut(
        phases=phases,
        experiment_status_zh=dict(EXPERIMENT_STATUS_ZH),
        stage_status_zh=dict(STAGE_STATUS_ZH),
    )


@router.get("/api/v1/experiments/{exp_id}", response_model=ExperimentOut)
def get_experiment(exp_id: str, db: Session = Depends(get_db)) -> ExperimentOut:
    e = db.get(Experiment, exp_id)
    if e is None:
        raise HTTPException(404, "Experiment not found")
    return _to_out(e)


@router.post("/api/v1/experiments/{exp_id}/runs", response_model=RunOut)
async def create_run(
    exp_id: str, payload: RunCreate, db: Session = Depends(get_db)
) -> RunOut:
    """Create + execute a run. Requires confirmed=true (design.md §16.1)."""
    exp = db.get(Experiment, exp_id)
    if exp is None:
        raise HTTPException(404, "Experiment not found")
    if not payload.confirmed:
        raise HTTPException(422, "Running a command requires explicit approval (confirmed=true).")
    project = db.get(Project, exp.project_id)
    if project is None:
        raise HTTPException(404, "Project not found")

    run = ExperimentRun(
        id=new_id("run"),
        experiment_id=exp_id,
        status="created",
        seed=payload.seed,
    )
    db.add(run)
    db.flush()

    exp_root = (get_settings().projects_root / exp.root_path).resolve()
    try:
        await run_experiment(
            db,
            run=run,
            command=payload.command,
            project_slug=project.slug,
            exp_slug=exp.slug,
            exp_root=exp_root,
            project_id=project.id,
            seed=payload.seed,
        )
    except asyncio.CancelledError:
        # Client disconnected mid-run. CancelledError is a BaseException, so the
        # `except Exception` below never caught it - the run row (with
        # status="stopped" set by run_experiment's own handler) was rolled back
        # by get_db, leaving an orphaned run directory on disk with no DB record
        # the user could see/stop/clean. Commit the stopped status so the run
        # remains visible, then re-raise to unwind the request.
        try:
            db.commit()
        except Exception:  # noqa: BLE001
            db.rollback()
        raise
    except Exception as exc:  # noqa: BLE001
        run.status = "failed"
        db.flush()
        db.commit()
        raise HTTPException(400, f"Run failed: {exc}") from exc
    db.commit()
    db.refresh(run)
    return RunOut.model_validate(run)


@router.post("/api/v1/runs/{run_id}/stop")
def stop(run_id: str, db: Session = Depends(get_db)) -> dict:
    ok = stop_run(run_id)
    if ok:
        run = db.get(ExperimentRun, run_id)
        if run:
            run.status = "stopped"
            run.end_at = datetime.now(UTC)
            db.commit()
    return {"stopped": ok}


@router.get("/api/v1/runs/{run_id}", response_model=RunOut)
def get_run(run_id: str, db: Session = Depends(get_db)) -> RunOut:
    run = db.get(ExperimentRun, run_id)
    if run is None:
        raise HTTPException(404, "Run not found")
    return RunOut.model_validate(run)


@router.get("/api/v1/runs/{run_id}/logs")
def get_logs(run_id: str, db: Session = Depends(get_db)) -> dict:
    run = db.get(ExperimentRun, run_id)
    if run is None:
        raise HTTPException(404, "Run not found")
    if run.run_path is None:
        return {"logs": ""}
    # H7: validate run_dir stays within the project sandbox before reading.
    # run.run_path is stored relative to the project dir (not projects_root),
    # so we reconstruct via project_dir(slug).
    project_slug = _project_slug_for_run(db, run)
    run_dir = (project_dir(project_slug) / run.run_path).resolve()
    try:
        assert_within_project(project_slug, run_dir)
    except Exception as exc:  # noqa: BLE001
        raise HTTPException(403, str(exc)) from exc
    if not run_dir.exists():
        return {"logs": ""}
    return {"logs": tail_log(run_dir)}


@router.get("/api/v1/runs/{run_id}/stream")
async def stream_logs(
    run_id: str, request: Request, db: Session = Depends(get_db)
) -> StreamingResponse:
    run = db.get(ExperimentRun, run_id)
    if run is None:
        raise HTTPException(404, "Run not found")
    if run.run_path is None:
        raise HTTPException(404, "Run has no log directory")
    # H7: sandbox-check before tailing. Same path reconstruction as get_logs.
    project_slug = _project_slug_for_run(db, run)
    run_dir = (project_dir(project_slug) / run.run_path).resolve()
    try:
        assert_within_project(project_slug, run_dir)
    except Exception as exc:  # noqa: BLE001
        raise HTTPException(403, str(exc)) from exc

    async def gen():
        offsets = {"stdout.log": 0, "stderr.log": 0}
        while True:
            if await request.is_disconnected():
                return
            db.expire_all()
            fresh = db.get(ExperimentRun, run_id)
            if fresh and run_dir.exists():
                for name in ("stdout.log", "stderr.log"):
                    p = run_dir / name
                    if p.exists():
                        try:
                            with open(p, encoding="utf-8", errors="replace") as f:
                                f.seek(offsets[name])
                                chunk = f.read()
                                offsets[name] = f.tell()
                        except OSError:
                            chunk = ""
                        if chunk:
                            yield (
                                "data: "
                                + json.dumps({"file": name, "text": chunk}, ensure_ascii=False)
                                + "\n\n"
                            )
            if fresh and fresh.status in ("completed", "failed", "stopped"):
                yield (
                    "data: "
                    + json.dumps({"kind": "done", "status": fresh.status})
                    + "\n\n"
                )
                return
            await asyncio.sleep(1)

    return StreamingResponse(gen(), media_type="text/event-stream")


def _project_slug_for_run(db: Session, run: ExperimentRun) -> str:
    """Resolve the owning project's slug for a run, with a 404 guard (H8)."""
    exp = db.get(Experiment, run.experiment_id)
    if exp is None:
        raise HTTPException(404, "Owning experiment not found")
    project = db.get(Project, exp.project_id)
    if project is None:
        raise HTTPException(404, "Owning project not found")
    return project.slug


@router.get("/api/v1/runs/{run_id}/metrics", response_model=list[MetricOut])
def get_metrics(run_id: str, db: Session = Depends(get_db)) -> list[MetricOut]:
    rows = db.scalars(
        select(RunMetric).where(RunMetric.run_id == run_id).order_by(RunMetric.step, RunMetric.created_at)
    ).all()
    return [MetricOut.model_validate(r) for r in rows]


@router.get("/api/v1/experiments/{exp_id}/runs", response_model=list[RunOut])
def list_runs(exp_id: str, db: Session = Depends(get_db)) -> list[RunOut]:
    rows = db.scalars(
        select(ExperimentRun).where(ExperimentRun.experiment_id == exp_id).order_by(ExperimentRun.created_at.desc())
    ).all()
    return [RunOut.model_validate(r) for r in rows]


# ---------------------------------------------------------------------------
# 9-stage interactive workflow (see app/experiments/states.py)
# ---------------------------------------------------------------------------


def _stage_row_to_out(row, *, checkpoint_summary: dict | None = None) -> "ExperimentStageOut":
    """Convert a DB ExperimentStage row to the API schema.

    Decodes the *_json columns on the way out so the front-end doesn't
    need to JSON.parse every field. Tolerates malformed JSON (returns
    None / [] for the affected field rather than crashing).
    """
    from app.experiments.stages import STAGE_REGISTRY
    from app.schemas import ExperimentStageOut

    def _jd(s: str | None) -> dict | None:
        if not s:
            return None
        try:
            v = json.loads(s)
            return v if isinstance(v, dict) else None
        except (ValueError, TypeError):
            return None

    def _jl(s: str | None) -> list | None:
        if not s:
            return None
        try:
            v = json.loads(s)
            return v if isinstance(v, list) else None
        except (ValueError, TypeError):
            return None

    sd = STAGE_REGISTRY.get(row.stage_key)
    return ExperimentStageOut(
        id=row.id,
        experiment_id=row.experiment_id,
        stage_key=row.stage_key,
        stage_name_zh=sd.name_zh if sd else row.stage_key,
        description=sd.description if sd else "",
        requires_user=sd.requires_user if sd else False,
        optional_user=sd.optional_user if sd else False,
        expected_seconds=sd.expected_seconds if sd else 0,
        version=row.version or 1,
        status=row.status,
        inputs_json=_jd(row.inputs_json),
        outputs_json=_jd(row.outputs_json),
        artifacts_json=_jl(row.artifacts_json),
        config_json=_jd(row.config_json),
        user_decisions_json=_jl(row.user_decisions_json),
        dependencies=_jl(row.dependencies),
        invalidated_by_stage_id=row.invalidated_by_stage_id,
        # `started_at` / `ended_at` are kept as `str` (only `created_at` /
        # `updated_at` got promoted to `datetime` in M34) — `iso_utc` returns
        # either a string or None, which matches the field type.
        started_at=iso_utc(row.started_at),
        ended_at=iso_utc(row.ended_at),
        # M34: pass naive datetimes; ZSciBaseModel's serializer appends 'Z'.
        created_at=row.created_at,
        updated_at=row.updated_at,
        checkpoint_summary=checkpoint_summary,
    )


def _synth_phase_cells() -> list[dict]:
    """For brand-new experiments (no stage rows yet), synthesize 5 cells
    in `not_started` so the page doesn't render 5 "已归档" blocks. The
    orchestrator will replace these with real rows as it runs each phase.
    """
    from app.experiments.states import STAGE_KEYS, STAGE_NAME_ZH

    return [
        {
            "stage_key": k,
            "stage_name_zh": STAGE_NAME_ZH[k],
            "status": "not_started",
            "version": 0,
            "description": "",
        }
        for k in STAGE_KEYS
    ]


@router.get("/api/v1/experiments/{exp_id}/stages", response_model=StageProgressOut)
def list_stages(exp_id: str, db: Session = Depends(get_db)) -> StageProgressOut:
    """Return the 5-phase progress for an experiment.

    The orchestrator upserts one row per `(experiment_id, stage_key)` (5
    rows total — phase keys). Brand-new experiments have no rows yet, so
    we synthesize 5 `not_started` cells (was previously 9 "archived" cells,
    which made the page look like all stages were done — bug #4).

    `checkpoint_summary` is populated only for the stage currently in
    `waiting_for_user` status, sourced from the matching AgentTask's
    `checkpoint_payload_json` column. `last_error` carries the most
    recent friendly error so the page can render a "失败" banner.
    """
    from app.db.models import AgentTask, AgentTaskEvent, ExperimentStage
    from app.schemas import StageProgressOut

    exp = db.get(Experiment, exp_id)
    if exp is None:
        raise HTTPException(404, "Experiment not found")

    rows = db.scalars(
        select(ExperimentStage)
        .where(ExperimentStage.experiment_id == exp_id)
        .order_by(ExperimentStage.stage_key)
    ).all()

    # Resolve the active checkpoint summary + last error from the running task.
    checkpoint_summary: dict | None = None
    last_error: str | None = None
    # Bug fix (M31): scope to THIS experiment's autonomous task, not any
    # `experiment.autonomous_run` row in the system — otherwise a second
    # in-flight experiment hijacks the first's checkpoint_summary.
    pending_task = _find_autonomous_task_for_experiment(db, exp_id)
    checkpoint_stage_key: str | None = None
    if pending_task is not None:
        # `_open_checkpoint` flips the task to `awaiting_approval` while the
        # user is looking at the confirm card (startup recovery may leave it
        # `running` with a payload). Both states mean checkpoint_payload_json
        # is the live summary. Restricting to "running" made the summary
        # invisible exactly when the user needed it — an empty confirm card.
        if (
            pending_task.status in ("running", "awaiting_approval")
            and pending_task.checkpoint_payload_json
        ):
            try:
                checkpoint_summary = json.loads(pending_task.checkpoint_payload_json)
            except (ValueError, TypeError):
                checkpoint_summary = None
        checkpoint_stage_key = pending_task.stage_key
        if pending_task.status == "failed":
            # Prefer AgentTask.error (set by the orchestrator's friendly
            # handler); fall back to the most recent kind="error" event.
            last_error = pending_task.error or None
            if not last_error:
                err_event = db.scalar(
                    select(AgentTaskEvent)
                    .where(
                        AgentTaskEvent.task_id == pending_task.id,
                        AgentTaskEvent.kind == "error",
                    )
                    .order_by(AgentTaskEvent.created_at.desc())
                )
                if err_event is not None:
                    last_error = err_event.message

    if not rows:
        # Brand-new (or legacy) experiment — synthesize 5 not_started cells.
        return StageProgressOut(
            experiment_id=exp_id,
            overall_status=exp.overall_status or "draft",
            current_stage=exp.current_stage,
            mode=exp.mode or "interactive",
            stages=[_stage_row_to_out_legacy(s, exp=exp) for s in _synth_phase_cells()],
            decision_history=_decision_history(exp),
            last_error=last_error,
        )

    stage_outs = []
    for r in rows:
        # Only the active checkpoint gets the summary, and only the stage the
        # task is actually blocked on (guards against a stale payload leaking
        # to a different phase row).
        this_summary = (
            checkpoint_summary
            if r.status == "waiting_for_user"
            and (checkpoint_stage_key is None or checkpoint_stage_key == r.stage_key)
            else None
        )
        stage_outs.append(_stage_row_to_out(r, checkpoint_summary=this_summary))
    return StageProgressOut(
        experiment_id=exp_id,
        overall_status=exp.overall_status or "draft",
        current_stage=exp.current_stage,
        mode=exp.mode or "interactive",
        stages=stage_outs,
        decision_history=_decision_history(exp),
        last_error=last_error,
    )


def _stage_row_to_out_legacy(synth: dict, exp: Experiment | None = None) -> "ExperimentStageOut":
    """Adapt a synthesized phase dict to the ExperimentStageOut schema.
    `exp` is used for the created_at/updated_at timestamps when supplied
    (otherwise they're empty strings, which the front-end renders as '—')."""
    from app.experiments.states import STAGE_DEPENDS_ON, STAGE_NAME_ZH, STAGE_POLICY
    from app.schemas import ExperimentStageOut

    return ExperimentStageOut(
        id=f"legacy-{synth['stage_key']}",
        experiment_id=exp.id if exp is not None else "",
        stage_key=synth["stage_key"],
        stage_name_zh=STAGE_NAME_ZH.get(synth["stage_key"], synth["stage_key"]),
        description="",
        requires_user=STAGE_POLICY.get(synth["stage_key"], {}).get("requires_user", False),
        optional_user=STAGE_POLICY.get(synth["stage_key"], {}).get("optional_user", False),
        expected_seconds=0,
        version=1,
        status=synth.get("status", "not_started"),
        inputs_json=None, outputs_json=None, artifacts_json=None, config_json=None,
        user_decisions_json=None, dependencies=list(STAGE_DEPENDS_ON.get(synth["stage_key"], ())),
        invalidated_by_stage_id=None,
        started_at=None, ended_at=None,
        created_at=iso_utc(exp.created_at) if exp is not None else "",
        updated_at=iso_utc(exp.updated_at) if exp is not None else "",
        checkpoint_summary=None,
    )


def _decision_history(exp: Experiment) -> list[dict]:
    if not exp.decision_history_json:
        return []
    try:
        v = json.loads(exp.decision_history_json)
        return v if isinstance(v, list) else []
    except (ValueError, TypeError):
        return []


# ---------------------------------------------------------------------------
# Stage decision + fork endpoints (Week 2 / Week 4)
# ---------------------------------------------------------------------------


@router.post(
    "/api/v1/experiments/{exp_id}/decide",
    response_model=ExperimentStageDecisionOut,
)
async def decide_stage(
    exp_id: str, payload: ExperimentStageDecision, db: Session = Depends(get_db)
) -> ExperimentStageDecisionOut:
    """Resolve a pending checkpoint on the experiment's current phase.

    1. Finds this experiment's autonomous task (running OR awaiting_approval
       — the latter is the state while the orchestrator blocks at a
       checkpoint, including one adopted after a process restart).
    2. Writes the decision into the pending Approval row (the durable
       signal the orchestrator loop polls).
    3. Applies the decision's state transitions SYNCHRONOUSLY via
       ``apply_stage_decision`` so the very next /stages refetch (including
       the front-end's optimistic update) sees the post-decision state.
    4. Wakes the live loop, or relaunches it (post-restart: no live
       coroutine exists — the loop adopts the checkpoint and continues from
       the resolved decision).
    """
    from app.db.models import AgentTask, Approval, ExperimentStage
    from app.experiments.orchestrator import (
        apply_stage_decision,
        relaunch_experiment_loop,
        resume_experiment,
    )

    exp = db.get(Experiment, exp_id)
    if exp is None:
        raise HTTPException(404, "Experiment not found")

    # Only live states count here — a newer failed/completed task must not
    # shadow an older awaiting_approval one (legacy duplicate rows from
    # before the start_autonomous concurrency guard). Prefer the parked
    # task when both exist: it's the one holding the pending checkpoint.
    task = _find_autonomous_task_for_experiment(
        db, exp_id, statuses=("awaiting_approval",)
    ) or _find_autonomous_task_for_experiment(db, exp_id, statuses=("running",))
    if task is None or task.status not in ("running", "awaiting_approval"):
        raise HTTPException(409, "没有正在等待决策的自主实验任务")
    # `awaiting_approval` = parked at a checkpoint by the (new) loop. If no
    # live coroutine backs it in THIS process, the process restarted since
    # the checkpoint was written and the loop must be relaunched.
    task_was_parked = task.status == "awaiting_approval"

    approval = db.scalar(
        select(Approval).where(
            Approval.task_id == task.id,
            Approval.status == "pending",
        ).order_by(Approval.created_at.desc())
    )
    if approval is None:
        raise HTTPException(409, "当前没有待决策的 checkpoint")

    decision = payload.decision
    target_stage_key = exp.current_stage
    if payload.target_stage_id:
        tgt = db.get(ExperimentStage, payload.target_stage_id)
        if tgt is not None:
            target_stage_key = tgt.stage_key

    # Write the decision into the Approval row — the loop's durable signal.
    try:
        apv_payload = json.loads(approval.payload_json) if approval.payload_json else {}
    except (ValueError, TypeError):
        apv_payload = {}
    apv_payload["decision_kind"] = decision
    apv_payload["decision_payload"] = payload.payload or {}
    apv_payload["target_stage_key"] = target_stage_key
    approval.payload_json = json.dumps(apv_payload, ensure_ascii=False)
    approval.status = "rejected" if decision == "abort" else "approved"
    approval.decision_at = datetime.now(UTC)

    # Apply transitions synchronously (single authority: apply_stage_decision).
    apply_stage_decision(
        db,
        experiment_id=exp_id,
        task_id=task.id,
        stage_key=target_stage_key,
        decision=decision,
        decision_payload=payload.payload or {},
    )
    task.status = "running" if decision != "abort" else "stopped"

    # Decision history trail.
    history = _decision_history(exp)
    history.append({
        "stage_key": target_stage_key,
        "decision": decision,
        "target_stage_id": payload.target_stage_id,
        "at": iso_utc(approval.decision_at),
        "fork_experiment_id": None,
    })
    exp.decision_history_json = json.dumps(history, ensure_ascii=False, default=str)

    db.commit()

    # Wake the live loop, or relaunch it when this process has none and the
    # task was parked at the checkpoint (post-restart resume).
    if task_was_parked:
        if not relaunch_experiment_loop(task):
            resume_experiment(task.id)
    else:
        resume_experiment(task.id)

    return ExperimentStageDecisionOut(
        ok=True,
        decision=decision,
        experiment_id=exp_id,
        task_id=task.id,
        fork_experiment_id=None,
    )


@router.post("/api/v1/experiments/{exp_id}/fork", response_model=ExperimentOut)
def fork_experiment_endpoint(
    exp_id: str, payload: ForkRequest, db: Session = Depends(get_db)
) -> ExperimentOut:
    """Fork an experiment at a stage without going through a checkpoint
    decision (direct API). Useful for the BranchTree UI."""
    from app.db.models import ExperimentStage
    from app.experiments.forking import fork_experiment as _fork

    exp = db.get(Experiment, exp_id)
    if exp is None:
        raise HTTPException(404, "Experiment not found")
    tgt = db.get(ExperimentStage, payload.target_stage_id)
    if tgt is None:
        raise HTTPException(404, "target stage not found")
    new_exp = _fork(
        db,
        source_experiment_id=exp_id,
        fork_stage_key=tgt.stage_key,
        title=payload.title,
        branch_name=payload.branch_name,
    )
    return _to_out(new_exp)


@router.get("/api/v1/experiments/{exp_id}/branches", response_model=list[BranchOut])
def list_branches(exp_id: str, db: Session = Depends(get_db)) -> list[BranchOut]:
    """Return the branch graph visible from this experiment (its own fork
    record + any experiments that forked from it)."""
    from app.db.models import ExperimentStage
    from app.experiments.forking import list_branches_for_experiment

    if db.get(Experiment, exp_id) is None:
        raise HTTPException(404, "Experiment not found")
    rows = list_branches_for_experiment(db, exp_id)
    out: list[BranchOut] = []
    for b in rows:
        fork_key = None
        if b.fork_stage_id:
            st = db.get(ExperimentStage, b.fork_stage_id)
            fork_key = st.stage_key if st is not None else None
        out.append(BranchOut(
            id=b.id,
            experiment_id=b.experiment_id,
            parent_experiment_id=b.parent_experiment_id,
            parent_branch_id=b.parent_branch_id,
            fork_stage_id=b.fork_stage_id,
            fork_stage_key=fork_key,
            branch_name=b.branch_name,
            created_at=b.created_at.isoformat() if b.created_at else "",
        ))
    return out


# ---------------------------------------------------------------------------
# Benchmarks (Phase A): dataset/task/SOTA discovery for a research direction.
# ---------------------------------------------------------------------------


@router.post("/api/v1/projects/{project_id}/benchmarks/search", response_model=BenchmarkSearchResponse)
@router.post("/api/v1/projects/{project_id}/benchmarks", response_model=BenchmarkSearchResponse)
def search_benchmarks(
    project_id: str, payload: BenchmarkSearchRequest, db: Session = Depends(get_db)
) -> BenchmarkSearchResponse:
    """Search HuggingFace only — does NOT persist. User must call /add to keep hits."""
    if db.get(Project, project_id) is None:
        raise HTTPException(404, "Project not found")
    from app.jobs import start_job, update_job

    job = start_job(
        db, project_id=project_id, kind="benchmark_search",
        title=f"查找数据集: {payload.query}", target_type="experiment",
        message="正在检索数据集",
    )
    warnings: list[str] = []
    try:
        queries = expand_search_queries(payload.query)
        hits = search_huggingface_datasets(
            payload.query, limit=payload.limit, warnings=warnings
        )
        summary = f"找到 {len(hits)} 个候选" + (f"，{len(warnings)} 条告警" if warnings else "")
        update_job(db, job.id, status="completed", result_summary=summary)
        hit_outs = [BenchmarkHitOut.from_hit(h) for h in hits]
        return BenchmarkSearchResponse(
            hits=hit_outs,
            benchmarks=hit_outs,
            warnings=warnings,
            query_used=queries,
        )
    except Exception as exc:  # noqa: BLE001
        update_job(db, job.id, status="failed", error=str(exc))
        raise


@router.post("/api/v1/projects/{project_id}/benchmarks/add", response_model=BenchmarkOut)
def add_benchmark_from_hit(
    project_id: str, payload: BenchmarkAddRequest, db: Session = Depends(get_db)
) -> BenchmarkOut:
    """Persist a search hit into the project library (optional experiment link)."""
    if db.get(Project, project_id) is None:
        raise HTTPException(404, "Project not found")
    if payload.experiment_id and db.get(Experiment, payload.experiment_id) is None:
        raise HTTPException(404, "Experiment not found")
    row = store_benchmark_hit(
        db,
        project_id=project_id,
        hit=payload.model_dump(),
        experiment_id=payload.experiment_id,
    )
    db.commit()
    db.refresh(row)
    return BenchmarkOut.from_row(row)


@router.get("/api/v1/projects/{project_id}/benchmarks", response_model=list[BenchmarkOut])
def list_benchmarks(project_id: str, db: Session = Depends(get_db)) -> list[BenchmarkOut]:
    if db.get(Project, project_id) is None:
        raise HTTPException(404, "Project not found")
    rows = db.scalars(
        select(Benchmark).where(Benchmark.project_id == project_id).order_by(Benchmark.created_at.desc())
    ).all()
    outs = [BenchmarkOut.from_row(r) for r in rows]
    # Mainstream first for the project library view.
    outs.sort(
        key=lambda b: (
            0 if b.is_mainstream else 1,
            -(b.downloads or 0),
            (b.name or "").lower(),
        )
    )
    return outs


@router.patch("/api/v1/benchmarks/{benchmark_id}", response_model=BenchmarkOut)
def update_benchmark(
    benchmark_id: str, payload: BenchmarkUpdate, db: Session = Depends(get_db)
) -> BenchmarkOut:
    if payload.experiment_id is not None and payload.experiment_id != "":
        if db.get(Experiment, payload.experiment_id) is None:
            raise HTTPException(404, "Experiment not found")
    exp_id = payload.experiment_id if payload.experiment_id else None
    # Allow explicit unlink via null
    if "experiment_id" not in payload.model_fields_set:
        raise HTTPException(400, "experiment_id required")
    row = link_benchmark_experiment(db, benchmark_id, exp_id)
    if row is None:
        raise HTTPException(404, "Benchmark not found")
    db.commit()
    db.refresh(row)
    return BenchmarkOut.from_row(row)


@router.post("/api/v1/projects/{project_id}/benchmarks/manual", response_model=BenchmarkOut)
def add_manual_benchmark(
    project_id: str, payload: BenchmarkManualCreate, db: Session = Depends(get_db)
) -> BenchmarkOut:
    """Add a user-entered benchmark. Never-blocked fallback for when HuggingFace
    is unreachable: the user records the benchmark/SOTA they already know about
    (e.g. "ImageNet top-1 acc=0.910"), and the autonomous agent's SOTA
    comparison can use it."""
    if db.get(Project, project_id) is None:
        raise HTTPException(404, "Project not found")
    row = create_manual_benchmark(
        db,
        project_id=project_id,
        name=payload.name,
        kind=payload.kind,
        url=payload.url,
        task_name=payload.task_name,
        dataset_name=payload.dataset_name,
        metric_name=payload.metric_name,
        metric_value=payload.metric_value,
        experiment_id=payload.experiment_id,
        description=payload.description,
        tags=payload.tags,
        is_mainstream=payload.is_mainstream,
    )
    db.commit()
    db.refresh(row)
    return BenchmarkOut.from_row(row)


@router.delete("/api/v1/benchmarks/{benchmark_id}")
def remove_benchmark(benchmark_id: str, db: Session = Depends(get_db)) -> dict:
    ok = delete_benchmark(db, benchmark_id)
    if not ok:
        raise HTTPException(404, "Benchmark not found")
    db.commit()
    return {"ok": True}


# ---------------------------------------------------------------------------
# ---------------------------------------------------------------------------
# Phase D: autonomous experiment agent. Launches a background orchestrator that
# runs benchmarks -> codegen -> smoke (self-fix) -> experiment runs -> finalize,
# streaming progress as agent-task events. Fully autonomous: bypasses the
# manual `confirmed` gate (safety preserved by run_experiment's sandbox).
# ---------------------------------------------------------------------------


@router.patch("/api/v1/experiments/{exp_id}", response_model=ExperimentOut)
def patch_experiment(
    exp_id: str, patch: ExperimentUpdate, db: Session = Depends(get_db)
) -> ExperimentOut:
    """Update mutable fields on an experiment (title / research_question /
    hypothesis). Used by the detail page to let the user fill in the
    research question before starting the workflow.
    """
    exp = db.get(Experiment, exp_id)
    if exp is None:
        raise HTTPException(404, "Experiment not found")
    if patch.title is not None:
        exp.title = patch.title
    if patch.research_question is not None:
        exp.research_question = patch.research_question
    if patch.hypothesis is not None:
        exp.hypothesis = patch.hypothesis
    db.commit()
    db.refresh(exp)
    return _to_out(exp)


@router.post("/api/v1/experiments/{exp_id}/autonomous")
async def start_autonomous(
    exp_id: str,
    payload: dict,
    mode: str = Query("interactive", description="interactive | auto (legacy 5-stage linear)"),
    db: Session = Depends(get_db),
) -> dict:
    """Start the experiment workflow in the background.

    `?mode=interactive` (default) — the 5-phase registry with checkpoint
    pauses; the user must approve each phase before the next runs.
    `?mode=auto` — the legacy 5-stage linear pipeline (no checkpoints).

    Returns the agent task id whose event stream (GET /agent/tasks/{id}/stream)
    tracks progress. The front-end's StageProgress component polls
    GET /experiments/{id}/stages for the structured progress + the
    latest checkpoint summary.

    Validates: research_question must be non-empty (bug #2 — users were
    seeing cryptic `research_question is empty - please fill it in ...`
    errors after the workflow had already started).
    """
    exp = db.get(Experiment, exp_id)
    if exp is None:
        raise HTTPException(404, "Experiment not found")
    project = db.get(Project, exp.project_id)
    if project is None:
        raise HTTPException(404, "Project not found")

    if mode not in ("interactive", "auto"):
        raise HTTPException(400, "mode must be 'interactive' or 'auto'")

    rq = (exp.research_question or payload.get("research_question") or "").strip()
    if not rq:
        # Iteration 4 — friendly Chinese copy; previously this was
        # "请先填写研究问题,再启动实验" which still surfaced the technical
        # "研究问题" term and didn't hint at the recovery path.
        # Now mirrors the create_experiment 422 wording so users see a
        # consistent message whether they hit the gate on creation or
        # on start.
        raise HTTPException(
            422,
            "请先描述要研究的问题,再启动实验。"
            "你可以在实验设置里补充,或在启动时直接填写。",
        )

    # Concurrency guard: ONE live autonomous task per experiment. Without
    # this, a retried/duplicated POST (e.g. client-side timeout while the
    # server processed the first request) creates a second AgentTask, and
    # the newest-first lookup in _find_autonomous_task_for_experiment then
    # shadows the older awaiting_approval task — bricking /decide for the
    # pending checkpoint (observed in smoke testing).
    live_task = db.scalar(
        select(AgentTask)
        .where(
            AgentTask.task_type == "experiment.autonomous_run",
            AgentTask.experiment_id == exp_id,
            AgentTask.status.in_(("running", "awaiting_approval")),
        )
        .order_by(AgentTask.created_at.desc())
        .limit(1)
    )
    if live_task is not None:
        raise HTTPException(
            409,
            "该实验已有正在进行的自主实验任务,"
            "请等待其完成或先在详情页处理待确认的环节。",
        )

    input_data = {
        # experiment_id is ALSO on the task row (real column) for direct
        # queries; kept in input_json for API backward-compat.
        "experiment_id": exp_id,
        "mode": mode,
        "research_question": rq,
        "selected_papers": payload.get("selected_papers", []),
        "selected_repositories": payload.get("selected_repositories", []),
        "benchmarks_query": payload.get("benchmarks_query") or rq or exp.title or "",
        "run_configs": payload.get("run_configs") or ["baseline"],
        # New runs by default resume from the first non-completed phase
        # (so retrying a failed experiment picks up where it crashed).
        "resume": True,
    }
    # Persist the mode on the experiment row so /stages returns it.
    exp.mode = mode
    # Allow retry: failed → running is a legal transition (see EXP_TRANSITIONS).
    if exp.overall_status in (None, "draft", "archived", "failed"):
        exp.overall_status = "running"
    task = AgentTask(
        id=new_id("task"),
        project_id=project.id,
        task_type="experiment.autonomous_run",
        experiment_id=exp_id,
        input_json=json.dumps(input_data, ensure_ascii=False),
        status="running",
    )
    db.add(task)
    db.commit()

    # Launch the loop in the background via the dispatcher (tracked, no
    # double-launch). `?mode=auto` runs the SAME loop — checkpoints simply
    # auto-approve (see run_experiment_loop).
    from app.agent import dispatch
    from app.experiments.orchestrator import run_experiment_loop

    bg = dispatch.dispatch(
        task.id,
        run_experiment_loop(
            task_id=task.id,
            experiment_id=exp_id,
            project_id=project.id,
            input_data=input_data,
        ),
        name=f"zsci-exp-{task.id}",
    )

    def _on_done(t: asyncio.Task) -> None:
        if t.cancelled():
            _mark_terminal(task.id, "stopped", "autonomous task cancelled")
        elif t.exception() and not isinstance(t.exception(), asyncio.CancelledError):
            _mark_terminal(task.id, "failed", f"orchestrator crashed: {t.exception()}")

    bg.add_done_callback(_on_done)
    return {"task_id": task.id, "experiment_id": exp_id, "mode": mode}


def _mark_terminal(task_id: str, status: str, error: str | None) -> None:
    """Backstop: ensure a background autonomous task reaches a terminal state
    even if its orchestrator crashed before its own try/except could mark it.

    Bug fix (M32): previously only marked the AgentTask; the matching
    Experiment row stayed "running" forever and the UI showed a ghost
    running status with no recovery path. Now also flip the experiment's
    `overall_status` and the in-flight stage row so the page renders the
    "失败" banner with the "重试" button (see ExperimentDetailPage).
    """
    from app.db.session import get_sessionmaker

    try:
        with get_sessionmaker()() as db:
            row = db.get(AgentTask, task_id)
            if row is not None and row.status not in ("completed", "failed", "stopped", "rejected"):
                row.status = status
                if error:
                    row.error = error
                # Best-effort: flip the owning experiment + current stage row.
                exp_id = None
                if row.input_json:
                    try:
                        inp = json.loads(row.input_json)
                        if isinstance(inp, dict):
                            exp_id = inp.get("experiment_id")
                    except (ValueError, TypeError):
                        pass
                if exp_id:
                    exp = db.get(Experiment, exp_id)
                    if exp is not None and exp.overall_status in (
                        "running", "waiting_user", "draft"
                    ):
                        exp.overall_status = "failed"
                    if exp is not None and exp.current_stage:
                        from app.db.models import ExperimentStage
                        stage = db.scalar(
                            select(ExperimentStage).where(
                                ExperimentStage.experiment_id == exp_id,
                                ExperimentStage.stage_key == exp.current_stage,
                            )
                        )
                        if stage is not None and stage.status in (
                            "running", "waiting_for_user", "draft"
                        ):
                            stage.status = "failed"
                db.commit()
    except Exception:  # noqa: BLE001
        pass


@router.get("/api/v1/experiments/{exp_id}/files")
def list_experiment_files(exp_id: str, db: Session = Depends(get_db)) -> dict:
    """List source files under the experiment dir (for the code browser tab)."""
    exp = db.get(Experiment, exp_id)
    if exp is None:
        raise HTTPException(404, "Experiment not found")
    project = db.get(Project, exp.project_id)
    if project is None:
        raise HTTPException(404, "Project not found")
    exp_root = (get_settings().projects_root / exp.root_path).resolve()
    assert_within_project(project.slug, exp_root)
    if not exp_root.exists():
        return {"files": []}
    # Source files only: skip runs/ (large), hidden dirs, caches.
    skip_dirs = {"runs", "__pycache__", ".venv", ".git", "figures", "checkpoints", "artifacts"}
    files: list[str] = []
    for p in sorted(exp_root.rglob("*")):
        if not p.is_file():
            continue
        if any(part in skip_dirs for part in p.relative_to(exp_root).parts):
            continue
        # POSIX separators — the API contract is OS-independent.
        files.append(p.relative_to(exp_root).as_posix())
    return {"files": files}


@router.get("/api/v1/experiments/{exp_id}/file")
def get_experiment_file(exp_id: str, path: str, db: Session = Depends(get_db)) -> dict:
    """Read a single source file from the experiment dir (sandboxed)."""
    exp = db.get(Experiment, exp_id)
    if exp is None:
        raise HTTPException(404, "Experiment not found")
    project = db.get(Project, exp.project_id)
    if project is None:
        raise HTTPException(404, "Project not found")
    exp_root = (get_settings().projects_root / exp.root_path).resolve()
    target = (exp_root / path).resolve()
    try:
        assert_within_project(project.slug, target)
    except Exception as exc:  # noqa: BLE001
        raise HTTPException(403, str(exc)) from exc
    if not target.is_file():
        raise HTTPException(404, "File not found")
    return {"path": path, "content": target.read_text(encoding="utf-8", errors="replace")}


# ---------------------------------------------------------------------------
# Phase C/D — 研究计划确认 / 结果下一步(非技术化视图)
# 端点消费 experiment_stages.outputs_json(plan / analysis)并把
# 内部字段翻译成面向科研用户的描述,避免前端直接读到 phase_* 内部 key。
# ---------------------------------------------------------------------------


def _safe_json_load(raw: str | None) -> dict:
    if not raw:
        return {}
    try:
        v = json.loads(raw)
        return v if isinstance(v, dict) else {}
    except Exception:  # noqa: BLE001
        return {}


def _latest_stage_outputs(
    db: Session, experiment_id: str, stage_key: str
) -> dict:
    """Return the most recent outputs_json dict for a given stage, or {}."""
    from app.db.models import ExperimentStage

    row = db.scalars(
        select(ExperimentStage)
        .where(
            ExperimentStage.experiment_id == experiment_id,
            ExperimentStage.stage_key == stage_key,
        )
        .order_by(ExperimentStage.version.desc())
        .limit(1)
    ).first()
    if row is None:
        return {}
    return _safe_json_load(row.outputs_json)


def _find_autonomous_task_for_experiment(
    db: Session,
    experiment_id: str,
    statuses: tuple[str, ...] = ("running", "awaiting_approval", "failed", "completed", "stopped"),
) -> AgentTask | None:
    """Find the most recent `experiment.autonomous_run` task for THIS experiment.

    Uses the real `agent_tasks.experiment_id` column, falling back to parsing
    `input_json` for rows written before the column existed (backfilled at
    startup, but a dev DB may lag).

    `statuses` narrows which lifecycle states count. /decide passes only the
    live states so a newer FAILED task can never shadow an older
    awaiting_approval one (that combination bricked checkpoint decisions
    before the start_autonomous concurrency guard existed).
    """
    direct = db.scalar(
        select(AgentTask)
        .where(
            AgentTask.task_type == "experiment.autonomous_run",
            AgentTask.experiment_id == experiment_id,
            AgentTask.status.in_(statuses),
        )
        .order_by(AgentTask.created_at.desc())
        .limit(1)
    )
    if direct is not None:
        return direct
    # Legacy rows without the column: parse input_json (bounded scan).
    candidates = db.scalars(
        select(AgentTask)
        .where(
            AgentTask.task_type == "experiment.autonomous_run",
            AgentTask.experiment_id.is_(None),
            AgentTask.status.in_(statuses),
        )
        .order_by(AgentTask.created_at.desc())
        .limit(50)
    ).all()
    for t in candidates:
        if not t.input_json:
            continue
        try:
            inp = json.loads(t.input_json)
        except (ValueError, TypeError):
            continue
        if isinstance(inp, dict) and inp.get("experiment_id") == experiment_id:
            return t
    return None


@router.get(
    "/api/v1/experiments/{exp_id}/preview-plan",
    response_model=PlanPreviewOut,
)
def get_preview_plan(
    exp_id: str, db: Session = Depends(get_db)
) -> PlanPreviewOut:
    """面向用户的研究计划确认视图。

    来源:experiment_stages(stage_key='phase_1_plan').outputs_json 的 8 个字段
    (goal/hypothesis/metrics/baselines/run_specs/fairness_note/compute_plan/risks)。

    若该实验尚未进入 phase_1_plan,返回 has_plan=False 且所有字段为 None;
    前端按"计划待生成"路径渲染,主 CTA 不阻塞。
    """
    exp = db.get(Experiment, exp_id)
    if exp is None:
        raise HTTPException(404, "Experiment not found")

    plan = _latest_stage_outputs(db, exp_id, "phase_1_plan")
    if not plan:
        return PlanPreviewOut(has_plan=False)

    metrics_raw = plan.get("metrics") or []
    metrics: list[PlanPreviewMetricOut] = []
    if isinstance(metrics_raw, list):
        for m in metrics_raw:
            if isinstance(m, dict):
                metrics.append(
                    PlanPreviewMetricOut(
                        name=str(m.get("name") or "未命名指标"),
                        definition=m.get("definition") if isinstance(m.get("definition"), str) else None,
                        aggregation=m.get("aggregation") if isinstance(m.get("aggregation"), str) else None,
                    )
                )
            elif isinstance(m, str):
                metrics.append(PlanPreviewMetricOut(name=m))

    run_specs = plan.get("run_specs") or []
    scope: str | None = None
    if isinstance(run_specs, list) and run_specs:
        scope = "本轮对照与变体:" + "、".join(str(s) for s in run_specs if s)

    risks_raw = plan.get("risks") or []
    risks: list[str] = [str(r) for r in risks_raw if isinstance(r, (str, int))]

    compute_plan_val = plan.get("compute_plan")
    compute_plan: str | None = (
        str(compute_plan_val) if compute_plan_val not in (None, "") else None
    )

    return PlanPreviewOut(
        goal=plan.get("goal") if isinstance(plan.get("goal"), str) else None,
        hypothesis=plan.get("hypothesis") if isinstance(plan.get("hypothesis"), str) else None,
        scope=scope,
        fairness_note=plan.get("fairness_note") if isinstance(plan.get("fairness_note"), str) else None,
        compute_plan=compute_plan,
        risks=risks,
        metrics=metrics,
        # 估计耗时是面向用户的"初步估计",后端不强行算,留给前端做兜底。
        est_minutes=None,
        success_means=None,
        failure_means=None,
        has_plan=True,
    )


_RECOMMENDATION_TO_JUDGEMENT: dict[str, str] = {
    "publish": "continue",
    "iterate": "adjust",
    "inconclusive": "insufficient",
    "abort": "pivot",
}

_NEXT_STEP_TEMPLATE_HINTS: list[tuple[str, str]] = [
    ("重跑", "iterate"),
    ("重新训练", "iterate"),
    ("复现", "iterate"),
    ("扩大", "change_dataset"),
    ("增加数据", "change_dataset"),
    ("写作", "into_writing"),
    ("起稿", "into_writing"),
    # 顺序:具体意图(分支/写作)在通用意图(新方向/创新)前,因为
    # "尝试新方向作为分支"应被理解为分支,而不是笼统的创新。
    ("分支", "branch"),
    ("新方向", "novel"),
    ("创新", "novel"),
]


def _next_step_template(title: str, description: str | None) -> str:
    text = (title or "") + " " + (description or "")
    for hint, template in _NEXT_STEP_TEMPLATE_HINTS:
        if hint in text:
            return template
    return "iterate"


@router.get(
    "/api/v1/experiments/{exp_id}/next-steps",
    response_model=NextStepsOut,
)
def get_next_steps(
    exp_id: str, db: Session = Depends(get_db)
) -> NextStepsOut:
    """面向用户的实验后续研究方向视图。

    来源:experiment_stages(stage_key='phase_4_report').outputs_json.analysis
    的 recommendation / next_steps / best_metric / best_run / vs_sota 等。

    若实验未到 analysis 阶段,返回 has_analysis=False 且 next_steps=[];
    前端按"系统在整理"路径渲染。
    """
    exp = db.get(Experiment, exp_id)
    if exp is None:
        raise HTTPException(404, "Experiment not found")

    report = _latest_stage_outputs(db, exp_id, "phase_4_report")
    analysis = report.get("analysis")
    if not isinstance(analysis, dict):
        return NextStepsOut(has_analysis=False)

    recommendation = analysis.get("recommendation")
    judgement: str | None = None
    if isinstance(recommendation, str):
        judgement = _RECOMMENDATION_TO_JUDGEMENT.get(
            recommendation.lower(), recommendation
        )

    metrics: dict[str, float | int | str] = {}
    best_metric = analysis.get("best_metric")
    if isinstance(best_metric, dict):
        name = best_metric.get("name")
        value = best_metric.get("value")
        if isinstance(name, str) and value is not None:
            metrics[name] = value
    series = report.get("series")
    if isinstance(series, list):
        # 若 analysis 没有 best_metric,取最近一次 series 的 metrics
        if not metrics:
            for entry in reversed(series):
                if isinstance(entry, dict):
                    sm = entry.get("metrics")
                    if isinstance(sm, dict) and sm:
                        for k, v in sm.items():
                            metrics[str(k)] = v
                        break

    conclusion = analysis.get("ai_judgement")
    if not isinstance(conclusion, str):
        vs_sota = analysis.get("vs_sota")
        conclusion = vs_sota if isinstance(vs_sota, str) else None

    risks_raw = analysis.get("risks") or []
    risks: list[str] = [str(r) for r in risks_raw if isinstance(r, (str, int))]

    next_steps_raw = analysis.get("next_steps") or []
    next_steps: list[NextStepOut] = []
    if isinstance(next_steps_raw, list):
        for i, step in enumerate(next_steps_raw[:5]):
            if isinstance(step, str):
                title = step.strip()
                if not title:
                    continue
                next_steps.append(
                    NextStepOut(
                        id=f"step_{i + 1}",
                        title=title,
                        description=None,
                        est_cost=None,
                        template=_next_step_template(title, None),
                    )
                )
            elif isinstance(step, dict):
                title = str(step.get("title") or step.get("name") or f"方向 {i + 1}").strip()
                description = step.get("description")
                est_cost = step.get("est_cost")
                next_steps.append(
                    NextStepOut(
                        id=f"step_{i + 1}",
                        title=title,
                        description=str(description) if isinstance(description, str) else None,
                        est_cost=str(est_cost) if est_cost is not None else None,
                        template=_next_step_template(
                            title,
                            str(description) if isinstance(description, str) else None,
                        ),
                    )
                )

    return NextStepsOut(
        conclusion=conclusion,
        judgement=judgement,
        metrics=metrics,
        risks=risks,
        next_steps=next_steps,
        has_analysis=True,
    )
