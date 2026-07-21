"""System router: health + settings."""
from __future__ import annotations

from fastapi import APIRouter

from app import __version__
from app.config import get_settings
from app.llm.gateway import get_gateway
from app.literature.venue_registry import get_venue_registry
from app.schemas import HealthOut, SettingsOut

router = APIRouter(prefix="/api/v1", tags=["system"])


@router.get("/health", response_model=HealthOut)
def health() -> HealthOut:
    settings = get_settings()
    return HealthOut(
        status="ok", version=__version__, workspace=str(settings.workspace_path)
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
