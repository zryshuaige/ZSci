"""System router: health + settings."""
from __future__ import annotations

import logging

from fastapi import APIRouter, Depends
from sqlalchemy import text
from sqlalchemy.orm import Session

from app import __version__
from app.config import get_settings
from app.db.session import get_db
from app.llm.gateway import get_gateway
from app.literature.venue_registry import get_venue_registry
from app.schemas import HealthOut, SettingsOut

router = APIRouter(prefix="/api/v1", tags=["system"])
logger = logging.getLogger("zsci.router.system")


@router.get("/health", response_model=HealthOut)
def health(db: Session = Depends(get_db)) -> HealthOut:
    """Lightweight liveness probe.

    The original endpoint returned a static "ok" — fine for a desktop app,
    but it meant a corrupt / locked SQLite looked healthy. We now do a
    round-trip `SELECT 1` so the UI can surface "DB unreachable" instead
    of mysterious 500s on every page. The check is wrapped in try/except
    so a transient DB error returns a 200 with `status="degraded"` rather
    than a 500 (which would make a load balancer mark the node down for
    something the user can recover from by restarting).
    """
    settings = get_settings()
    db_ok = True
    db_err: str | None = None
    try:
        db.execute(text("SELECT 1"))
    except Exception as exc:  # noqa: BLE001
        db_ok = False
        db_err = str(exc)
        logger.warning("health: DB check failed: %s", exc)
    return HealthOut(
        status="ok" if db_ok else "degraded",
        version=__version__,
        workspace=str(settings.workspace_path),
        db_ok=db_ok,
        db_error=db_err,
    )


@router.get("/settings", response_model=SettingsOut)
def settings() -> SettingsOut:
    s = get_settings()
    gw = get_gateway()
    return SettingsOut(
        workspace_path=str(s.workspace_path),
        models=gw.describe(),
        venues=get_venue_registry().names(),
    )
