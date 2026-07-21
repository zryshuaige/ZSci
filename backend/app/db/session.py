"""SQLAlchemy engine and session factory.

Uses synchronous SQLite with WAL mode for MVP (design.md §4.2). The structure
is async-ready: swapping to aiosqlite later only touches this file.
"""
from __future__ import annotations

from collections.abc import Iterator
from pathlib import Path

from sqlalchemy import create_engine, event
from sqlalchemy.engine import Engine
from sqlalchemy.orm import Session, sessionmaker

from app.config import get_settings

_engine: Engine | None = None
_SessionLocal: sessionmaker[Session] | None = None


def _configure_sqlite(db_url: str) -> Engine:
    engine = create_engine(
        db_url,
        echo=False,
        future=True,
        connect_args={"check_same_thread": False},
    )

    @event.listens_for(engine, "connect")
    def _set_sqlite_pragma(dbapi_conn, _record):  # noqa: ANN001
        cur = dbapi_conn.cursor()
        cur.execute("PRAGMA journal_mode=WAL")
        cur.execute("PRAGMA foreign_keys=ON")
        cur.execute("PRAGMA synchronous=NORMAL")
        # Wait up to 30s for a write lock instead of failing immediately with
        # "database is locked". Helps the H1 pattern where an error audit is
        # written from a separate session right after the parent rolls back,
        # and covers any brief write-lock contention from concurrent requests.
        cur.execute("PRAGMA busy_timeout=30000")
        cur.close()

    return engine


def get_engine() -> Engine:
    global _engine, _SessionLocal
    if _engine is None:
        settings = get_settings()
        # M29: ensure the DB parent dir exists before SQLite tries to open the
        # file (was previously done in config.database_url property, which ran
        # on every read).
        db_url = settings.database_url
        if db_url.startswith("sqlite:///"):
            db_path = Path(db_url.removeprefix("sqlite:///"))
            db_path.parent.mkdir(parents=True, exist_ok=True)
        _engine = _configure_sqlite(db_url)
        _SessionLocal = sessionmaker(bind=_engine, autoflush=False, expire_on_commit=False)
    return _engine


def get_sessionmaker() -> sessionmaker[Session]:
    if _SessionLocal is None:
        get_engine()
    return _SessionLocal  # type: ignore[return-value]


def get_db() -> Iterator[Session]:
    """FastAPI dependency: yields a scoped session."""
    session = get_sessionmaker()()
    try:
        yield session
    finally:
        session.close()
