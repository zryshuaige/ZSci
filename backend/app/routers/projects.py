"""Project management router (design.md §9.1, §15.1)."""
from __future__ import annotations

from fastapi import APIRouter, Depends, HTTPException, status
from sqlalchemy import func, select
from sqlalchemy.exc import IntegrityError
from sqlalchemy.orm import Session

from app.db.models import Paper, Project
from app.db.session import get_db
from app.schemas import ProjectCreate, ProjectOut, ProjectUpdate
from app.utils import new_id, slugify
from app.workspace.manager import WorkspaceManager, audit
from app.workspace.sandbox import SandboxError

router = APIRouter(prefix="/api/v1/projects", tags=["projects"])
_ws = WorkspaceManager()


def _to_out(db: Session, p: Project, *, paper_count: int | None = None, downloaded: int | None = None) -> ProjectOut:
    # H2: callers may pass pre-aggregated counts to avoid N+1 queries; otherwise
    # we fall back to per-project COUNTs.
    if paper_count is None:
        paper_count = db.scalar(
            select(func.count()).select_from(Paper).where(Paper.project_id == p.id)
        ) or 0
    if downloaded is None:
        downloaded = db.scalar(
            select(func.count())
            .select_from(Paper)
            .where(Paper.project_id == p.id, Paper.downloaded.is_(True))
        ) or 0
    return ProjectOut(
        id=p.id,
        name=p.name,
        slug=p.slug,
        research_direction=p.research_direction,
        root_path=p.root_path,
        status=p.status,
        created_at=p.created_at,
        updated_at=p.updated_at,
        paper_count=paper_count,
        downloaded_count=downloaded,
    )


@router.post("", response_model=ProjectOut, status_code=status.HTTP_201_CREATED)
def create_project(payload: ProjectCreate, db: Session = Depends(get_db)) -> ProjectOut:
    slug = payload.slug or slugify(payload.name)
    existing = db.scalar(select(Project).where(Project.slug == slug))
    if existing:
        raise HTTPException(409, f"Project slug already exists: {slug}")

    project_id = new_id("prj")
    try:
        root = _ws.create_project(
            db,
            project_id=project_id,
            name=payload.name,
            slug=slug,
            research_direction=payload.research_direction or "",
        )
    except (FileExistsError, SandboxError) as exc:
        raise HTTPException(409, str(exc)) from exc

    project = Project(
        id=project_id,
        name=payload.name,
        slug=slug,
        research_direction=payload.research_direction,
        root_path=str(root),
        status="active",
    )
    db.add(project)
    try:
        db.commit()
    except IntegrityError as exc:
        # TOCTOU: two concurrent creates with the same slug both passed the
        # existence check. Roll back and remove the directory we just created
        # so a retry isn't blocked by FileExistsError, then surface a 409.
        db.rollback()
        try:
            import shutil

            shutil.rmtree(root, ignore_errors=True)
        except OSError:
            pass
        raise HTTPException(409, f"Project slug already exists: {slug}") from exc
    db.refresh(project)
    return _to_out(db, project, paper_count=0, downloaded=0)


@router.get("", response_model=list[ProjectOut])
def list_projects(db: Session = Depends(get_db)) -> list[ProjectOut]:
    rows = db.scalars(select(Project).order_by(Project.created_at.desc())).all()
    if not rows:
        return []
    # H2: single aggregation query for all projects instead of 2N+1.
    counts = db.execute(
        select(
            Paper.project_id.label("project_id"),
            func.count().label("total"),
            func.count(Paper.id).filter(Paper.downloaded).label("downloaded"),
        )
        .where(Paper.project_id.in_([p.id for p in rows]))
        .group_by(Paper.project_id)
    ).all()
    by_id = {r.project_id: (r.total, r.downloaded) for r in counts}  # type: ignore[attr-defined]
    out: list[ProjectOut] = []
    for p in rows:
        total, dl = by_id.get(p.id, (0, 0))
        out.append(_to_out(db, p, paper_count=total, downloaded=dl))
    return out


@router.get("/{project_id}", response_model=ProjectOut)
def get_project(project_id: str, db: Session = Depends(get_db)) -> ProjectOut:
    p = db.get(Project, project_id)
    if p is None:
        raise HTTPException(404, "Project not found")
    return _to_out(db, p)


@router.patch("/{project_id}", response_model=ProjectOut)
def update_project(
    project_id: str, payload: ProjectUpdate, db: Session = Depends(get_db)
) -> ProjectOut:
    p = db.get(Project, project_id)
    if p is None:
        raise HTTPException(404, "Project not found")
    for field in ("name", "research_direction", "status"):
        val = getattr(payload, field)
        if val is not None:
            setattr(p, field, val)
    db.commit()
    db.refresh(p)
    return _to_out(db, p)


@router.delete("/{project_id}", status_code=status.HTTP_204_NO_CONTENT)
def delete_project(project_id: str, db: Session = Depends(get_db)) -> None:
    p = db.get(Project, project_id)
    if p is None:
        raise HTTPException(404, "Project not found")
    slug = p.slug
    root = _ws.project_root(slug)
    # Commit the DB deletion BEFORE rmtree. The old order rmtree'd first, so a
    # commit failure (DB locked) left a Project row pointing at a missing dir,
    # breaking every later op. Now a commit failure leaves the dir intact and
    # the user can retry; a rmtree failure after commit leaves an orphan dir
    # (harmless) rather than a broken row.
    audit(db, action_type="project.delete", project_id=project_id, target=str(root))
    db.delete(p)
    db.commit()
    try:
        if root.exists():
            import shutil

            shutil.rmtree(root)
    except OSError:
        pass  # best-effort; the DB is already consistent
