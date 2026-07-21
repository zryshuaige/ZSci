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
from app.db.models import Experiment, ExperimentRun, Project, RunMetric
from app.db.session import get_db
from app.experiments.runner import run_experiment, stop_run, tail_log
from app.experiments.scaffold import scaffold_experiment
from app.schemas import ExperimentCreate, ExperimentOut, MetricOut, RunCreate, RunOut
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
