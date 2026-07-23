"""Experiments router (design.md §15.3, §9.6)."""
from __future__ import annotations

import asyncio
import json
from datetime import UTC, datetime

from fastapi import APIRouter, Depends, HTTPException, Request
from fastapi.responses import StreamingResponse
from sqlalchemy import select
from sqlalchemy.orm import Session

from app.config import get_settings
from app.db.models import AgentTask, Benchmark, Experiment, ExperimentRun, Project, RunMetric
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
from app.experiments.orchestrator import run_autonomous_experiment
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
    CodegenRequest,
    CodegenResponse,
    ExperimentCreate,
    ExperimentOut,
    MetricOut,
    RunCreate,
    RunOut,
)
from app.utils import new_id, slugify
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
    )


@router.post("/api/v1/projects/{project_id}/experiments", response_model=ExperimentOut)
def create_experiment(
    project_id: str, payload: ExperimentCreate, db: Session = Depends(get_db)
) -> ExperimentOut:
    project = db.get(Project, project_id)
    if project is None:
        raise HTTPException(404, "Project not found")
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
        research_question=payload.research_question,
        hypothesis=payload.hypothesis,
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
# Phase B: code generation. The autonomous agent calls generate_experiment_code
# directly; this endpoint surfaces it for manual / preview use and Phase D will
# store the generated run/smoke commands on the experiment for later steps.
# ---------------------------------------------------------------------------


@router.post("/api/v1/experiments/{exp_id}/generate-code", response_model=CodegenResponse)
def generate_code(
    exp_id: str, payload: CodegenRequest, db: Session = Depends(get_db)
) -> CodegenResponse:
    exp = db.get(Experiment, exp_id)
    if exp is None:
        raise HTTPException(404, "Experiment not found")
    project = db.get(Project, exp.project_id)
    if project is None:
        raise HTTPException(404, "Project not found")
    try:
        result = generate_experiment_code(
            db,
            _ws,
            experiment=exp,
            project=project,
            selected_papers=payload.selected_papers,
            selected_repositories=payload.selected_repositories,
        )
    except ModelNotConfigured as exc:
        db.rollback()
        raise HTTPException(503, str(exc)) from exc
    except ValueError as exc:
        db.rollback()
        raise HTTPException(422, str(exc)) from exc
    # Persist the run/smoke commands + plan on the experiment so the orchestrator
    # (Phase D) and the detail page can pick them up without re-generating.
    exp.plan_json = json.dumps(
        {
            "relevant_papers": result["relevant_papers"],
            "official_code_note": result["official_code_note"],
            "plan": result["plan"],
            "run_command": result["run_command"],
            "smoke_command": result["smoke_command"],
            "risks": result["risks"],
        },
        ensure_ascii=False,
    )
    exp.status = "generated"
    db.commit()
    db.refresh(exp)
    return CodegenResponse(
        relevant_papers=result["relevant_papers"],
        official_code_note=result["official_code_note"],
        plan=result["plan"],
        files_written=result["files_written"],
        run_command=result["run_command"],
        smoke_command=result["smoke_command"],
        risks=result["risks"],
    )


# ---------------------------------------------------------------------------
# Phase D: autonomous experiment agent. Launches a background orchestrator that
# runs benchmarks -> codegen -> smoke (self-fix) -> experiment runs -> finalize,
# streaming progress as agent-task events. Fully autonomous: bypasses the
# manual `confirmed` gate (safety preserved by run_experiment's sandbox).
# ---------------------------------------------------------------------------


@router.post("/api/v1/experiments/{exp_id}/autonomous")
async def start_autonomous(
    exp_id: str, payload: dict, db: Session = Depends(get_db)
) -> dict:
    """Start the autonomous experiment agent in the background. Returns the
    agent task id whose event stream (GET /agent/tasks/{id}/stream) tracks
    progress."""
    exp = db.get(Experiment, exp_id)
    if exp is None:
        raise HTTPException(404, "Experiment not found")
    project = db.get(Project, exp.project_id)
    if project is None:
        raise HTTPException(404, "Project not found")

    input_data = {
        # experiment_id is stored here (not a FK column on agent_tasks - create_all
        # doesn't alter existing tables) so GET /workflows/active can deep-link the
        # sidebar entry back to this experiment.
        "experiment_id": exp_id,
        "research_question": exp.research_question or payload.get("research_question", ""),
        "selected_papers": payload.get("selected_papers", []),
        "selected_repositories": payload.get("selected_repositories", []),
        "benchmarks_query": payload.get("benchmarks_query") or exp.research_question or exp.title or "",
        "run_configs": payload.get("run_configs") or ["baseline"],
    }
    task = AgentTask(
        id=new_id("task"),
        project_id=project.id,
        task_type="experiment.autonomous_run",
        input_json=json.dumps(input_data, ensure_ascii=False),
        status="running",
    )
    db.add(task)
    db.commit()

    # Fire-and-forget the background orchestrator. It opens its own sessions
    # and commits events as it goes; the SSE stream on /agent/tasks/{id}/stream
    # surfaces them live. The orchestrator's own try/except marks the task
    # failed on any stage error; the done_callback is a backstop for failures
    # that escape that (e.g. an error before the try, or a CancelledError) so
    # the task row never gets stuck in "running" with no terminal event.
    def _on_done(t: asyncio.Task) -> None:
        if t.cancelled():
            _mark_terminal(task.id, "stopped", "autonomous task cancelled")
        elif t.exception() and not isinstance(t.exception(), asyncio.CancelledError):
            _mark_terminal(task.id, "failed", f"orchestrator crashed: {t.exception()}")

    bg = asyncio.create_task(
        run_autonomous_experiment(
            task_id=task.id,
            experiment_id=exp_id,
            project_id=project.id,
            input_data=input_data,
        )
    )
    bg.add_done_callback(_on_done)
    return {"task_id": task.id, "experiment_id": exp_id}


def _mark_terminal(task_id: str, status: str, error: str | None) -> None:
    """Backstop: ensure a background autonomous task reaches a terminal state
    even if its orchestrator crashed before its own try/except could mark it."""
    from app.db.session import get_sessionmaker

    try:
        with get_sessionmaker()() as db:
            row = db.get(AgentTask, task_id)
            if row is not None and row.status not in ("completed", "failed", "stopped", "rejected"):
                row.status = status
                if error:
                    row.error = error
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
        files.append(str(p.relative_to(exp_root)))
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
