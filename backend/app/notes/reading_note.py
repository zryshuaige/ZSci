"""Structured reading-note generation (design.md §9.3).

Pulls extracted page text, calls the gateway with the §9.3 template, persists
the note as a ReadingNote(kind="note"). All claims must carry page citations;
the prompt enforces this and forbids fabrication.
"""
from __future__ import annotations

import logging

from sqlalchemy.orm import Session

from sqlalchemy import select

from app.db.models import Paper, ReadingNote
from app.llm.gateway import ModelNotConfigured, get_gateway
from app.notes.prompts import READING_NOTE_SYSTEM, READING_NOTE_USER
from app.pdf.parse import load_extracted_text

logger = logging.getLogger("zsci.notes.reading_note")

MAX_PAGES_IN_PROMPT = 40  # bound prompt size for very long papers


def _build_body(extracted: dict) -> tuple[str, int]:
    pages = extracted.get("page_texts", [])[:MAX_PAGES_IN_PROMPT]
    chunks = []
    for p in pages:
        text = (p.get("text") or "").strip()
        if text:
            chunks.append(f"=== PAGE {p['page']} ===\n{text}")
    body = "\n\n".join(chunks)
    return body, len(pages)


def generate_reading_note(
    db: Session,
    *,
    paper: Paper,
    model_role: str = "default_chat",
) -> ReadingNote:
    """Generate and persist a structured reading note for `paper`."""
    extracted = load_extracted_text(paper)
    if not extracted:
        raise ValueError(
            "Paper has not been parsed yet. Run pdf.parse first "
            "(or the PDF has no extracted_text.json)."
        )

    if not get_gateway().is_configured(model_role):
        raise ModelNotConfigured(model_role)

    body, used_pages = _build_body(extracted)
    if not body.strip():
        raise ValueError("No extractable text found in the PDF.")

    messages = [
        {"role": "system", "content": READING_NOTE_SYSTEM},
        {
            "role": "user",
            "content": READING_NOTE_USER.format(
                title=paper.title, pages=used_pages, body=body
            ),
        },
    ]
    gw = get_gateway()
    content = gw.chat(messages, role=model_role, temperature=0.2, max_tokens=2048)

    provider = gw.provider_for(model_role)
    note_id = f"rn_note_{paper.id}"
    note = db.scalar(select(ReadingNote).where(ReadingNote.id == note_id))
    if note is None:
        note = ReadingNote(
            id=note_id,
            paper_id=paper.id,
            kind="note",
            page=None,
            original_text=None,
            content=content,
            model=f"{provider.provider}/{provider.model}",
        )
        db.add(note)
    else:
        note.content = content
        note.model = f"{provider.provider}/{provider.model}"
    db.flush()
    return note
