"""Paragraph translation via the model gateway (design.md §7.3).

Translation records are persisted as ReadingNote rows with kind="translation".
Original text is always preserved.
"""
from __future__ import annotations

import logging

from sqlalchemy.orm import Session

from app.db.models import ReadingNote
from app.llm.gateway import ModelNotConfigured, get_gateway
from app.notes.prompts import TRANSLATE_SYSTEM
from app.utils import new_id

logger = logging.getLogger("zsci.notes.translate")


def translate_text(
    db: Session,
    *,
    paper_id: str,
    text: str,
    page: int | None = None,
    target_lang: str = "中文",
    model_role: str = "default_chat",
) -> ReadingNote:
    """Translate `text` into `target_lang`; persist a translation record."""
    if not text.strip():
        raise ValueError("Empty text.")

    if not get_gateway().is_configured(model_role):
        raise ModelNotConfigured(model_role)

    messages = [
        {"role": "system", "content": TRANSLATE_SYSTEM.format(target_lang=target_lang)},
        {
            "role": "user",
            "content": (
                f"Translate the following academic text into {target_lang}. "
                "Keep formulas, variable names, and citations intact. "
                "Output only the translation.\n\n---\n" + text
            ),
        },
    ]
    gw = get_gateway()
    translated = gw.chat(messages, role=model_role, temperature=0.2)

    provider = gw.provider_for(model_role)
    note = ReadingNote(
        id=new_id("rn_tr"),
        paper_id=paper_id,
        kind="translation",
        page=page,
        original_text=text,
        content=translated,
        model=f"{provider.provider}/{provider.model}",
    )
    db.add(note)
    db.flush()
    return note
