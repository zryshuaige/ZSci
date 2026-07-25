"""Application configuration.

Loads process-level settings from environment variables (via pydantic-settings)
and model-gateway configuration from a YAML file (design.md §4.4).
"""
from __future__ import annotations

import os
from functools import lru_cache
from pathlib import Path

import yaml
from pydantic import BaseModel, Field
from pydantic_settings import BaseSettings, SettingsConfigDict

# Repo root = backend/../
REPO_ROOT = Path(__file__).resolve().parents[2]
BACKEND_ROOT = Path(__file__).resolve().parents[1]


class Settings(BaseSettings):
    """Process-level settings, overridable via environment variables."""

    model_config = SettingsConfigDict(
        env_file=BACKEND_ROOT / ".env",
        env_prefix="ZSCI_",
        env_file_encoding="utf-8",
        extra="ignore",
    )

    # Workspace: where projects + app.db live. Default <repo>/workspace.
    workspace_path: Path = REPO_ROOT / "workspace"

    # SQLite database file (inside workspace's .research-agent dir).
    db_path: Path | None = None  # None -> resolved at runtime under workspace

    # CORS
    cors_origins: list[str] = Field(default_factory=lambda: [
        "http://127.0.0.1:5173",
        "http://localhost:5173",
        "http://127.0.0.1:8000",
    ])

    # Path to the model-gateway YAML config. None -> use defaults / no models.
    llm_config_path: Path | None = None

    # Request timeouts for external academic APIs (seconds). `academic_api_timeout`
    # is the read timeout; `academic_api_connect_timeout` is the connect timeout so
    # a dead/blocked host fails fast (and the benchmark mirror fallback kicks in
    # quickly) instead of hanging the full read timeout.
    academic_api_timeout: float = 30.0
    academic_api_connect_timeout: float = 5.0

    # Benchmark discovery source. The official huggingface.co endpoint is the
    # default; on connect failure/timeout the benchmarks module falls back to the
    # hf-mirror.com mirror (China-accessible). To skip the dead-host wait entirely
    # on a network where huggingface.co is blocked, set ZSCI_HF_ENDPOINT to the
    # mirror (candidates are de-duped, so only one host is tried).
    hf_endpoint: str = "https://huggingface.co"
    hf_mirror: str = "https://hf-mirror.com"

    @property
    def research_agent_dir(self) -> Path:
        d = self.workspace_path / ".research-agent"
        # Don't mkdir here (M29); startup does it once. We still ensure callers
        # get a usable path object even if the dir doesn't exist yet.
        return d

    @property
    def projects_root(self) -> Path:
        return self.workspace_path / "projects"

    @property
    def database_url(self) -> str:
        db = self.db_path or (self.research_agent_dir / "app.db")
        return f"sqlite:///{db}"


@lru_cache
def get_settings() -> Settings:
    return Settings()


# ---------------------------------------------------------------------------
# Model-gateway YAML config (design.md §4.4)
# ---------------------------------------------------------------------------


class ProviderConfig(BaseModel):
    """A single model provider entry."""

    provider: str  # litellm provider key, e.g. openai, anthropic, gemini, deepseek, ollama
    model: str
    base_url: str | None = None
    api_key_env: str | None = None  # name of env var holding the key
    extra: dict = Field(default_factory=dict)


class ModelGatewayConfig(BaseModel):
    """Top-level model gateway configuration."""

    models: dict[str, ProviderConfig] = Field(default_factory=dict)

    @property
    def default_chat(self) -> ProviderConfig | None:
        return self.models.get("default_chat")


def load_llm_config(path: Path | None) -> ModelGatewayConfig:
    """Load model-gateway YAML config. Returns empty config if missing/invalid."""
    if path is None or not path.exists():
        return ModelGatewayConfig()
    try:
        raw = yaml.safe_load(path.read_text(encoding="utf-8")) or {}
    except (yaml.YAMLError, OSError, UnicodeDecodeError):
        # M31: catch OSError/UnicodeDecodeError too so a permissions or encoding
        # issue can't crash the whole app on startup.
        return ModelGatewayConfig()
    if not isinstance(raw, dict):
        return ModelGatewayConfig()
    models_raw = raw.get("models", {}) or {}
    models: dict[str, ProviderConfig] = {}
    for name, entry in models_raw.items():
        if not isinstance(entry, dict):
            continue
        models[name] = ProviderConfig(**entry)
    return ModelGatewayConfig(models=models)


def env_file_path() -> Path:
    """Path to the ``.env`` file holding provider API keys.

    Defaults to ``backend/.env`` (the file pydantic-settings reads for ZSCI_
    app settings). Overridable via the ``ZSCI_ENV_FILE`` env var so tests can
    redirect key reads/writes to a temp file and never touch the real
    ``backend/.env``.
    """
    override = os.environ.get("ZSCI_ENV_FILE")
    if override:
        return Path(override)
    return BACKEND_ROOT / ".env"


def resolve_api_key(provider: ProviderConfig) -> str | None:
    """Resolve a provider's API key.

    Checks ``os.environ`` first (keys the user exported in their shell), then
    falls back to reading ``backend/.env`` directly via ``dotenv_values``.

    The fallback is what makes keys stored in ``.env`` actually work: pydantic-
    settings reads ``.env`` to populate its own ZSCI_ fields but does NOT inject
    the provider key vars (SILICONFLOW_API_KEY, etc.) into ``os.environ`` - so
    without this fallback every key in ``.env`` was dead weight and this
    function always returned None. Reading the file here (rather than calling
    ``load_dotenv`` at startup) keeps keys OUT of ``os.environ`` so they aren't
    inherited by user-run experiment subprocesses (M30). The file is tiny and
    read fresh per call, so a saved key takes effect immediately.
    """
    if provider.api_key_env is None:
        return None
    val = os.environ.get(provider.api_key_env)
    if val:
        return val
    from dotenv import dotenv_values

    return dotenv_values(env_file_path()).get(provider.api_key_env)
