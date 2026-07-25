"""Read/write helpers for the model-gateway config files.

Two files back the LLM settings (design.md §4.4):

  - ``workspace/.research-agent/config.yaml`` - which provider/model/base_url
    the ``default_chat`` role uses, and which env var holds its key.
  - ``backend/.env`` - the actual API key values, one per provider env var.

The settings UI (``PUT /api/v1/llm/config``) writes BOTH on save. Keys are
written to ``.env`` (the existing key store documented in ``.env.example``) so
they persist across restarts; ``resolve_api_key`` reads ``.env`` directly (via
``dotenv_values``) so a saved key takes effect immediately without a restart
and without polluting ``os.environ``. The save flow also clears the
``get_gateway`` cache so the new provider/model is picked up.

Security note (M30): keys are NEVER written to ``os.environ`` by this module.
They live only in ``.env`` on disk and are read fresh per LLM call, so they
aren't inherited by user-run experiment subprocesses. The gateway still passes
keys per-call via ``params["api_key"]`` and never logs them.
"""
from __future__ import annotations

from pathlib import Path

import yaml
from dotenv import set_key

from app.config import (
    ProviderConfig,
    env_file_path,
    get_settings,
    load_llm_config,
)


def _config_path() -> Path:
    """Resolve the config.yaml path the gateway actually reads."""
    s = get_settings()
    return s.llm_config_path or (s.research_agent_dir / "config.yaml")


def _env_path() -> Path:
    """The .env file holding API keys (redirectable via ZSCI_ENV_FILE)."""
    return env_file_path()


def write_default_chat(
    provider: ProviderConfig,
    *,
    config_path: Path | None = None,
) -> None:
    """Persist the ``default_chat`` role into config.yaml.

    Preserves any OTHER roles present (e.g. ``embedding``) by loading the
    existing ``models`` dict first and only replacing the ``default_chat``
    entry. Comments in the file are NOT preserved (yaml.safe_dump can't keep
    them); a short header is written pointing at config.example.yaml for the
    annotated reference. The file is created if missing.
    """
    path = config_path or _config_path()
    existing = load_llm_config(path)
    models: dict[str, dict] = {}
    for role, pc in existing.models.items():
        models[role] = _provider_to_dict(pc)
    models["default_chat"] = _provider_to_dict(provider)

    path.parent.mkdir(parents=True, exist_ok=True)
    body = yaml.safe_dump(
        {"models": models},
        allow_unicode=True,
        sort_keys=False,
        default_flow_style=False,
    )
    header = (
        "# Z-Sci model-gateway configuration.\n"
        "# Managed by the Settings UI; see backend/config.example.yaml for the\n"
        "# annotated reference. API keys live in backend/.env, NOT here.\n\n"
    )
    path.write_text(header + body, encoding="utf-8")


def _provider_to_dict(pc: ProviderConfig) -> dict:
    """Serialize a ProviderConfig to the YAML dict shape (omit None fields)."""
    d: dict = {"provider": pc.provider, "model": pc.model}
    if pc.base_url:
        d["base_url"] = pc.base_url
    if pc.api_key_env:
        d["api_key_env"] = pc.api_key_env
    if pc.extra:
        d["extra"] = pc.extra
    return d


def save_api_key(
    key_env: str,
    value: str,
    *,
    env_path: Path | None = None,
) -> None:
    """Write an API key into backend/.env.

    Uses ``dotenv.set_key`` so quoting / escaping is handled correctly and the
    file is created if missing. Does NOT touch ``os.environ`` (M30): the key is
    read back fresh from ``.env`` by ``resolve_api_key`` on the next LLM call,
    so it takes effect immediately without leaking into subprocess environments.
    """
    path = env_path or _env_path()
    path.parent.mkdir(parents=True, exist_ok=True)
    if not path.exists():
        path.write_text("", encoding="utf-8")
    set_key(str(path), key_env, value)


def apply_to_runtime() -> None:
    """Clear the cached gateway so the next call re-reads config.yaml.

    Must be called after ``write_default_chat`` so provider/model/base_url
    changes take effect without a restart. Key changes need no cache clear
    (``resolve_api_key`` reads ``.env`` live per call) but calling this is
    harmless.
    """
    from app.llm.gateway import get_gateway

    get_gateway.cache_clear()
