"""Translation + reading-note router (design.md §7.3, §9.3)."""
from __future__ import annotations

from fastapi import APIRouter, Depends, HTTPException
from sqlalchemy import select
from sqlalchemy.orm import Session

from app.db.models import Paper, ReadingNote
from app.db.session import get_db
from app.llm.gateway import GatewayError, ModelNotConfigured
from app.notes.reading_note import generate_reading_note
from app.notes.translate import translate_text
from app.schemas import (
    ReadingNoteOut,
    ReadingNoteUpdate,
    TranslateRequest,
    TranslationOut,
)
from app.workspace.manager import audit

router = APIRouter(tags=["notes"])


@router.post("/api/v1/papers/{paper_id}/translate", response_model=TranslationOut)
def translate(paper_id: str, payload: TranslateRequest, db: Session = Depends(get_db)) -> TranslationOut:
    paper = db.get(Paper, paper_id)
    if paper is None:
        raise HTTPException(404, "Paper not found")
    try:
        note = translate_text(
            db, paper_id=paper_id, text=payload.text, page=payload.page,
            target_lang=payload.target_lang,
        )
    except ModelNotConfigured as exc:
        raise HTTPException(503, str(exc)) from exc
    except (GatewayError, ValueError) as exc:
        raise HTTPException(400, str(exc)) from exc
    db.commit()
    db.refresh(note)
    return TranslationOut(
        id=note.id,
        paper_id=note.paper_id,
        page=note.page,
        original_text=note.original_text,
        translated_text=note.content,
        model=note.model,
        created_at=note.created_at,
    )


@router.post("/api/v1/papers/{paper_id}/reading-note", response_model=ReadingNoteOut)
def make_reading_note(paper_id: str, db: Session = Depends(get_db)) -> ReadingNoteOut:
    paper = db.get(Paper, paper_id)
    if paper is None:
        raise HTTPException(404, "Paper not found")
    try:
        note = generate_reading_note(db, paper=paper)
    except ModelNotConfigured as exc:
        raise HTTPException(503, str(exc)) from exc
    except (GatewayError, ValueError) as exc:
        raise HTTPException(400, str(exc)) from exc
    db.commit()
    db.refresh(note)
    return ReadingNoteOut.model_validate(note)


@router.get("/api/v1/papers/{paper_id}/reading-note", response_model=ReadingNoteOut | None)
def get_reading_note(paper_id: str, db: Session = Depends(get_db)) -> ReadingNoteOut | None:
    note = db.scalar(
        select(ReadingNote).where(ReadingNote.paper_id == paper_id, ReadingNote.kind == "note")
    )
    return ReadingNoteOut.model_validate(note) if note else None


@router.patch("/api/v1/papers/{paper_id}/reading-note", response_model=ReadingNoteOut)
def update_reading_note(
    paper_id: str, payload: ReadingNoteUpdate, db: Session = Depends(get_db)
) -> ReadingNoteOut:
    note = db.scalar(
        select(ReadingNote).where(ReadingNote.paper_id == paper_id, ReadingNote.kind == "note")
    )
    if note is None:
        raise HTTPException(404, "No reading note yet; generate one first.")
    note.content = payload.content
    db.commit()
    db.refresh(note)
    return ReadingNoteOut.model_validate(note)


@router.get("/api/v1/papers/{paper_id}/translations", response_model=list[TranslationOut])
def list_translations(paper_id: str, db: Session = Depends(get_db)) -> list[TranslationOut]:
    rows = db.scalars(
        select(ReadingNote)
        .where(ReadingNote.paper_id == paper_id, ReadingNote.kind == "translation")
        .order_by(ReadingNote.created_at.desc())
    ).all()
    return [
        TranslationOut(
            id=r.id,
            paper_id=r.paper_id,
            page=r.page,
            original_text=r.original_text,
            translated_text=r.content,
            model=r.model,
            created_at=r.created_at,
        )
        for r in rows
    ]


@router.delete("/api/v1/translations/{translation_id}", status_code=204)
def delete_translation(translation_id: str, db: Session = Depends(get_db)) -> None:
    """Delete a saved translation (a reading_note row of kind=translation).

    Mirrors the annotations DELETE contract so the reader's translate tab can
    let users remove individual translations (issue 2).
    """
    note = db.get(ReadingNote, translation_id)
    if note is None:
        raise HTTPException(404, "Translation not found")
    if note.kind != "translation":
        # Don't let a translation delete clobber a real reading note.
        raise HTTPException(400, "Not a translation record")
    project_id = note.paper.project_id if note.paper else None
    audit(db, action_type="translation.delete", project_id=project_id, target=note.id)
    db.delete(note)
    db.commit()
