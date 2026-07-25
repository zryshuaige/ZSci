"""System router: health + settings."""
from __future__ import annotations

import logging

from fastapi import APIRouter, Depends, HTTPException
from sqlalchemy import text
from sqlalchemy.orm import Session

from app import __version__
from app.config import get_settings
from app.db.session import get_db
from app.llm.gateway import get_gateway
from app.literature.venue_registry import get_venue_registry
from app.schemas import (
    HealthOut,
    LLMConfigOut,
    LLMConfigUpdate,
    LLMCurrentConfigOut,
    LLMProviderPresetOut,
    SettingsOut,
)

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


def _match_preset_id(provider: str | None, model: str | None, base_url: str | None) -> str | None:
    """Find the preset id whose (provider, model, base_url) matches the current
    default_chat config, so the UI can pre-select the right dropdown entry.
    Falls back to a provider-only match, then None (custom)."""
    from app.llm.providers import PROVIDER_PRESETS

    if provider is None:
        return None
    for p in PROVIDER_PRESETS:
        if p.provider == provider and p.model == model and (p.base_url or None) == (base_url or None):
            return p.id
    for p in PROVIDER_PRESETS:
        if p.provider == provider and (p.base_url or None) == (base_url or None):
            return p.id
    return None


def _current_config() -> LLMCurrentConfigOut:
    """Build the safe current-config snapshot from the live gateway."""
    from app.llm.providers import is_api_key_set

    gw = get_gateway()
    desc = gw.describe()
    provider = desc.get("default_chat_provider")
    model = desc.get("default_chat_model")
    base_url = desc.get("default_chat_base_url")
    api_key_env = desc.get("default_chat_api_key_env")
    dc = gw.config.default_chat
    return LLMCurrentConfigOut(
        provider=provider,
        model=model,
        base_url=base_url,
        api_key_env=api_key_env,
        api_key_set=is_api_key_set(dc) if dc else False,
        matched_preset_id=_match_preset_id(provider, model, base_url),
    )


@router.get("/llm/config", response_model=LLMConfigOut)
def llm_config() -> LLMConfigOut:
    """Return the provider catalog + the current default_chat selection.

    Read-only and key-safe: never includes API key values, only whether each
    key is currently resolvable (`api_key_set`). The front-end renders the
    dropdown from `presets` and pre-selects `current.matched_preset_id`.
    """
    from app.llm.providers import PROVIDER_PRESETS

    return LLMConfigOut(
        presets=[LLMProviderPresetOut(**p.__dict__) for p in PROVIDER_PRESETS],
        current=_current_config(),
    )


@router.put("/llm/config", response_model=LLMCurrentConfigOut)
def update_llm_config(payload: LLMConfigUpdate) -> LLMCurrentConfigOut:
    """Save the model provider (+ optional API key) selection.

    Writes `workspace/.research-agent/config.yaml` (default_chat role) and, when
    an `api_key` is supplied, the key to `backend/.env` under the preset's env
    var. Applies the change to the running process (clears the gateway cache)
    and returns the updated safe snapshot. A blank/omitted `api_key` leaves any
    existing key untouched - the UI field is masked, so blank means "keep".
    """
    from app.llm.config_io import apply_to_runtime, save_api_key, write_default_chat
    from app.llm.providers import get_preset, preset_to_provider

    preset = get_preset(payload.provider_id)
    if preset is None:
        raise HTTPException(422, f"未知的供应商:{payload.provider_id}")

    provider = preset_to_provider(
        preset,
        model=payload.model,
        base_url=payload.base_url,
    )
    write_default_chat(provider)

    # Only write a key when the user actually entered one. Blank = keep existing
    # (the field is masked, so we can't tell "cleared" from "unchanged").
    if payload.api_key and payload.api_key.strip():
        if preset.api_key_env is None:
            raise HTTPException(422, "该供应商不需要 API Key")
        save_api_key(preset.api_key_env, payload.api_key.strip())

    apply_to_runtime()
    logger.info(
        "llm config updated: provider=%s model=%s base_url=%s key_set=%s",
        provider.provider, provider.model, provider.base_url, bool(payload.api_key),
    )
    return _current_config()
