"""Repositories router (design.md §9.4)."""
from __future__ import annotations

from fastapi import APIRouter, Depends, HTTPException
from sqlalchemy import select
from sqlalchemy.orm import Session

from app.db.models import Repository
from app.db.session import get_db
from app.schemas import RepositoryOut, RepositoryUpdate
from app.workspace.manager import audit

router = APIRouter(tags=["repositories"])


@router.get("/api/v1/projects/{project_id}/repositories", response_model=list[RepositoryOut])
def list_repositories(project_id: str, db: Session = Depends(get_db)) -> list[RepositoryOut]:
    rows = db.scalars(
        select(Repository)
        .where(Repository.project_id == project_id)
        .order_by(Repository.created_at.desc())
    ).all()
    return [RepositoryOut.model_validate(r) for r in rows]


@router.patch("/api/v1/repositories/{repo_id}", response_model=RepositoryOut)
def update_repo_status(
    repo_id: str,
    payload: RepositoryUpdate,
    db: Session = Depends(get_db),
) -> RepositoryOut:
    """Allow manual correction of official_status (e.g. after user verifies).

    M8: typed Pydantic model with a Literal for `official_status` instead of
    the previous untyped `dict` body.
    """
    repo = db.get(Repository, repo_id)
    if repo is None:
        raise HTTPException(404, "Repository not found")
    if payload.official_status is not None:
        repo.official_status = payload.official_status
    if payload.evidence is not None:
        repo.evidence = payload.evidence
    # M12: audit the manual status correction.
    audit(
        db,
        action_type="repository.update",
        project_id=repo.project_id,
        target=repo.id,
        payload={"official_status": repo.official_status},
    )
    db.commit()
    db.refresh(repo)
    return RepositoryOut.model_validate(repo)


@router.delete("/api/v1/repositories/{repo_id}", status_code=204)
def delete_repository(repo_id: str, db: Session = Depends(get_db)) -> None:
    repo = db.get(Repository, repo_id)
    if repo is None:
        raise HTTPException(404, "Repository not found")
    # M12: audit the deletion (capture id before delete).
    audit(
        db,
        action_type="repository.delete",
        project_id=repo.project_id,
        target=repo.id,
        payload={"repo_url": repo.repo_url},
    )
    db.delete(repo)
    db.commit()
