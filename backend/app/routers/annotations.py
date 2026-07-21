"""Annotations router (design.md §14.1, §15.2)."""
from __future__ import annotations

from fastapi import APIRouter, Depends, HTTPException
from sqlalchemy import select
from sqlalchemy.orm import Session

from app.db.models import Annotation, Paper
from app.db.session import get_db
from app.schemas import AnnotationCreate, AnnotationOut, AnnotationUpdate
from app.utils import new_id
from app.workspace.manager import audit

router = APIRouter(tags=["annotations"])


@router.get("/api/v1/papers/{paper_id}/annotations", response_model=list[AnnotationOut])
def list_annotations(paper_id: str, db: Session = Depends(get_db)) -> list[AnnotationOut]:
    rows = db.scalars(
        select(Annotation)
        .where(Annotation.paper_id == paper_id)
        .order_by(Annotation.page_number, Annotation.created_at)
    ).all()
    return [AnnotationOut.model_validate(r) for r in rows]


@router.post(
    "/api/v1/papers/{paper_id}/annotations",
    response_model=AnnotationOut,
    status_code=201,
)
def create_annotation(
    paper_id: str, payload: AnnotationCreate, db: Session = Depends(get_db)
) -> AnnotationOut:
    paper = db.get(Paper, paper_id)
    if paper is None:
        raise HTTPException(404, "Paper not found")
    ann = Annotation(
        id=new_id("ann"),
        paper_id=paper_id,
        page_number=payload.page_number,
        selected_text=payload.selected_text,
        rects_json=payload.rects_json,
        comment=payload.comment,
        color=payload.color,
        kind=payload.kind,
    )
    db.add(ann)
    # M12: audit annotation creation.
    audit(db, action_type="annotation.create", project_id=paper.project_id, target=ann.id,
          payload={"page": payload.page_number, "kind": payload.kind})
    db.commit()
    db.refresh(ann)
    return AnnotationOut.model_validate(ann)


@router.patch("/api/v1/annotations/{annotation_id}", response_model=AnnotationOut)
def update_annotation(
    annotation_id: str, payload: AnnotationUpdate, db: Session = Depends(get_db)
) -> AnnotationOut:
    ann = db.get(Annotation, annotation_id)
    if ann is None:
        raise HTTPException(404, "Annotation not found")
    if payload.comment is not None:
        ann.comment = payload.comment
    if payload.color is not None:
        ann.color = payload.color
    # M12: audit annotation update.
    audit(db, action_type="annotation.update", project_id=ann.paper.project_id, target=ann.id,
          payload={"fields": [f for f in ("comment", "color") if getattr(payload, f) is not None]})
    db.commit()
    db.refresh(ann)
    return AnnotationOut.model_validate(ann)


@router.delete("/api/v1/annotations/{annotation_id}", status_code=204)
def delete_annotation(annotation_id: str, db: Session = Depends(get_db)) -> None:
    ann = db.get(Annotation, annotation_id)
    if ann is None:
        raise HTTPException(404, "Annotation not found")
    project_id = ann.paper.project_id if ann.paper else None
    # M12: audit before delete.
    audit(db, action_type="annotation.delete", project_id=project_id, target=ann.id)
    db.delete(ann)
    db.commit()
