"""Research ideas router (design.md §9.5)."""
from __future__ import annotations

from fastapi import APIRouter, Depends, HTTPException
from sqlalchemy import select
from sqlalchemy.orm import Session

from app.db.models import Idea, Project
from app.db.session import get_db
from app.schemas import IdeaCreate, IdeaOut, IdeaUpdate
from app.utils import new_id
from app.workspace.manager import audit

router = APIRouter(tags=["ideas"])


@router.get("/api/v1/projects/{project_id}/ideas", response_model=list[IdeaOut])
def list_ideas(project_id: str, db: Session = Depends(get_db)) -> list[IdeaOut]:
    rows = db.scalars(
        select(Idea).where(Idea.project_id == project_id).order_by(Idea.created_at.desc())
    ).all()
    return [IdeaOut.model_validate(r) for r in rows]


@router.post("/api/v1/projects/{project_id}/ideas", response_model=IdeaOut, status_code=201)
def create_idea(project_id: str, payload: IdeaCreate, db: Session = Depends(get_db)) -> IdeaOut:
    if db.get(Project, project_id) is None:
        raise HTTPException(404, "Project not found")
    idea = Idea(
        id=new_id("idea"),
        project_id=project_id,
        title=payload.title,
        hypothesis=payload.hypothesis,
        motivation=payload.motivation,
        content=payload.content,
        status=payload.status,
    )
    db.add(idea)
    # M12: audit idea creation.
    audit(db, action_type="idea.create", project_id=project_id, target=idea.id,
          payload={"status": idea.status})
    db.commit()
    db.refresh(idea)
    return IdeaOut.model_validate(idea)


@router.patch("/api/v1/ideas/{idea_id}", response_model=IdeaOut)
def update_idea(idea_id: str, payload: IdeaUpdate, db: Session = Depends(get_db)) -> IdeaOut:
    idea = db.get(Idea, idea_id)
    if idea is None:
        raise HTTPException(404, "Idea not found")
    for f in ("title", "hypothesis", "motivation", "content", "status"):
        v = getattr(payload, f)
        if v is not None:
            setattr(idea, f, v)
    # M12: audit idea update.
    audit(db, action_type="idea.update", project_id=idea.project_id, target=idea.id,
          payload={"fields": [f for f in ("title", "hypothesis", "motivation", "content", "status")
                              if getattr(payload, f) is not None]})
    db.commit()
    db.refresh(idea)
    return IdeaOut.model_validate(idea)


@router.delete("/api/v1/ideas/{idea_id}", status_code=204)
def delete_idea(idea_id: str, db: Session = Depends(get_db)) -> None:
    idea = db.get(Idea, idea_id)
    if idea is None:
        raise HTTPException(404, "Idea not found")
    # M12: audit before delete.
    audit(db, action_type="idea.delete", project_id=idea.project_id, target=idea.id)
    db.delete(idea)
    db.commit()
