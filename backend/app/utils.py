"""Small shared utilities: id + slug + time helpers."""
from __future__ import annotations

import os
import re
import unicodedata
import uuid
from contextlib import contextmanager
from datetime import datetime
from typing import IO, Iterator


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


def iso_utc(dt: datetime | None) -> str | None:
    """Return an ISO-8601 UTC string with explicit 'Z' suffix.

    The SQLite columns store naive `datetime` (no `timezone=True`), so a
    raw `dt.isoformat()` doesn't tell the browser the value is UTC — it
    parses as local time and shows a ±8h shift (the bug the user reported
    on the experiment page). This helper appends 'Z' for naive datetimes
    and leaves tz-aware datetimes to format themselves (still ISO-8601).
    """
    if dt is None:
        return None
    if dt.tzinfo is None:
        return dt.isoformat(timespec="seconds") + "Z"
    return dt.isoformat(timespec="seconds").replace("+00:00", "Z")


@contextmanager
def exclusive_file_lock(fobj: IO[str]) -> Iterator[None]:
    """Exclusive advisory lock on an open file object, cross-platform.

    POSIX uses ``fcntl.flock``; Windows uses ``msvcrt.locking`` (blocks up
    to ~10s waiting for the lock, matching flock's blocking semantics).
    Unlock always runs on context exit, including early ``return``.
    """
    if os.name == "nt":
        import msvcrt

        fobj.seek(0)
        msvcrt.locking(fobj.fileno(), msvcrt.LK_LOCK, 1)
        try:
            yield
        finally:
            try:
                fobj.seek(0)
                msvcrt.locking(fobj.fileno(), msvcrt.LK_UNLCK, 1)
            except OSError:
                pass  # lock already released (e.g. handle closed on abnormal exit)
    else:
        import fcntl

        fcntl.flock(fobj, fcntl.LOCK_EX)
        try:
            yield
        finally:
            fcntl.flock(fobj, fcntl.LOCK_UN)
