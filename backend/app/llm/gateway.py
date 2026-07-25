"""Model gateway: unified chat/stream over multiple providers via litellm.

Design principles (design.md §2.3, §4.4, §8.1):
- Multi-provider, switchable via config.yaml.
- API keys resolved from env only; never logged or stored.
- Graceful degradation: if no model is configured, raise ModelNotConfigured so
  callers can surface a clear message instead of crashing.
- Every call is auditable (model + token usage), without dumping private
  prompt content into logs by default.
"""
from __future__ import annotations

import logging
import os
from collections.abc import Iterator
from functools import lru_cache

from app.config import ModelGatewayConfig, ProviderConfig, get_settings, load_llm_config
from app.llm.providers import build_litellm_params

logger = logging.getLogger("zsci.llm")

# litellm fetches a remote model-cost map from raw.githubusercontent.com on
# first use; on networks where that host is slow/blocked it times out (adding
# delay to the first LLM call) before falling back to a local copy. Force the
# local bundled map up front so the remote fetch is skipped entirely.
os.environ.setdefault("LITELLM_LOCAL_MODEL_COST_MAP", "True")


class GatewayError(RuntimeError):
    """Base gateway error."""


class ModelNotConfigured(GatewayError):
    """Raised when no model is configured for the requested role."""

    def __init__(self, role: str = "default_chat"):
        super().__init__(
            f"No model configured for role '{role}'. "
            "Edit workspace/.research-agent/config.yaml and set the relevant "
            "API key environment variable. See backend/config.example.yaml."
        )
        self.role = role


class Gateway:
    """Wraps litellm with config + audit + graceful degradation."""

    def __init__(self, config: ModelGatewayConfig) -> None:
        self._config = config

    @property
    def config(self) -> ModelGatewayConfig:
        return self._config

    def provider_for(self, role: str = "default_chat") -> ProviderConfig:
        provider = self._config.models.get(role)
        if provider is None:
            raise ModelNotConfigured(role)
        return provider

    def is_configured(self, role: str = "default_chat") -> bool:
        return role in self._config.models

    def describe(self) -> dict:
        """Safe description of configured providers (no keys).

        Exposes whether the `default_chat` role's API key env var is currently
        resolvable (`api_key_set`) so the settings UI can render a
        "已配置 / 未配置 Key" badge. Never includes the key value itself.
        """
        from app.llm.providers import is_api_key_set

        dc = self._config.default_chat
        return {
            "configured_roles": sorted(self._config.models.keys()),
            "default_chat_model": dc.model if dc else None,
            "default_chat_provider": dc.provider if dc else None,
            "default_chat_base_url": dc.base_url if dc else None,
            "default_chat_api_key_env": dc.api_key_env if dc else None,
            "default_chat_api_key_set": is_api_key_set(dc) if dc else False,
        }

    def chat(
        self,
        messages: list[dict],
        *,
        role: str = "default_chat",
        temperature: float = 0.2,
        max_tokens: int | None = None,
        **extra,
    ) -> str:
        """Synchronous chat completion. Returns the assistant text."""
        import litellm  # imported lazily so tests/health don't require it

        provider = self.provider_for(role)
        params = build_litellm_params(provider)
        params["messages"] = messages
        params["temperature"] = temperature
        if max_tokens is not None:
            params["max_tokens"] = max_tokens
        params.update(extra)

        logger.info(
            "llm.chat role=%s provider=%s model=%s",
            role, provider.provider, provider.model,
        )
        try:
            resp = litellm.completion(**params)
        except Exception as exc:  # noqa: BLE001
            logger.error("llm.chat failed: %s", exc)
            raise GatewayError(f"Model call failed: {exc}") from exc

        try:
            text = resp["choices"][0]["message"]["content"] or ""
        except (KeyError, IndexError, TypeError) as exc:
            raise GatewayError(f"Unexpected model response shape: {exc}") from exc
        return text

    def stream_chat(
        self,
        messages: list[dict],
        *,
        role: str = "default_chat",
        temperature: float = 0.2,
        **extra,
    ) -> Iterator[str]:
        """Streaming chat completion; yields text chunks."""
        import litellm

        provider = self.provider_for(role)
        params = build_litellm_params(provider)
        params["messages"] = messages
        params["temperature"] = temperature
        params["stream"] = True
        params.update(extra)

        logger.info("llm.stream role=%s model=%s", role, provider.model)
        try:
            stream = litellm.completion(**params)
        except Exception as exc:  # noqa: BLE001
            raise GatewayError(f"Model stream failed: {exc}") from exc
        try:
            for chunk in stream:
                try:
                    delta = chunk["choices"][0]["delta"].get("content")
                except (KeyError, IndexError, TypeError):
                    delta = None
                if delta:
                    yield delta
        except Exception as exc:  # noqa: BLE001
            # Errors raised lazily during iteration (timeout / 429 / 401
            # mid-stream) surface as raw litellm/provider exceptions; wrap them
            # so callers' `except GatewayError` actually catches the failure.
            raise GatewayError(f"Model stream failed: {exc}") from exc


@lru_cache
def get_gateway() -> Gateway:
    settings = get_settings()
    config_path = settings.llm_config_path
    if config_path is None:
        # Default location per README: workspace/.research-agent/config.yaml
        config_path = settings.research_agent_dir / "config.yaml"
    config = load_llm_config(config_path)
    return Gateway(config)
