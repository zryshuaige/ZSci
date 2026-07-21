"""Small shared utilities: id + slug generation."""
from __future__ import annotations

import re
import unicodedata
import uuid


def new_id(prefix: str) -> str:
    return f"{prefix}_{uuid.uuid4().hex[:16]}"


def slugify(value: str) -> str:
    """Make a filesystem-safe slug from a project name or research direction."""
    value = unicodedata.normalize("NFKC", value or "").strip().lower()
    # Replace non-alphanumeric runs with hyphens, keep unicode letters via regex.
    value = re.sub(r"[^\w\s-]", "", value, flags=re.UNICODE)
    value = re.sub(r"[\s_-]+", "-", value).strip("-")
    if not value:
        value = "project"
    # ASCII-only for filesystem safety; strip CJK by transliterating to nothing
    # would lose meaning, so keep unicode word chars but cap length.
    value = value[:60]
    return value or "project"
