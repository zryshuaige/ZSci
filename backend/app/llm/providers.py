"""Translate a ProviderConfig (design.md §4.4) into litellm call parameters.

litellm unifies OpenAI / Anthropic / Gemini / DeepSeek / Qwen / Zhipu / Ollama /
vLLM / LM Studio behind one `completion()` interface keyed by `provider/model`.
We avoid hand-rolling 9 adapters by leaning on litellm, and layer our own config
+ audit + key-resolution on top.

Security: API keys are passed per-call via the `api_key` kwarg, NEVER written to
`os.environ`. Writing to `os.environ` would (a) leak keys to user-run experiment
subprocesses that inherit the environment, and (b) race with concurrent calls
using different providers (M30).
"""
from __future__ import annotations

from dataclasses import dataclass

from app.config import ProviderConfig, resolve_api_key


# ---------------------------------------------------------------------------
# Provider catalog - the single source of truth for the settings-page dropdown.
# ---------------------------------------------------------------------------
# Each preset mirrors an entry documented in `backend/.env.example` and
# `backend/config.example.yaml`. The front-end reads this list via
# `GET /api/v1/llm/config` and renders a provider <select>; picking one
# pre-fills the model / base_url / api_key_env defaults. The `id` is stable
# across renames so saved UI state stays valid.

@dataclass(frozen=True)
class ProviderPreset:
    """A selectable provider template shown in the settings UI."""

    id: str               # stable dropdown id, e.g. "siliconflow"
    name_zh: str          # display label, e.g. "硅基流动 (SiliconFlow)"
    provider: str         # litellm provider key
    model: str            # default model string
    base_url: str | None  # None for native providers that need no base_url
    api_key_env: str | None  # env var holding the key (None = no key needed)
    needs_key: bool       # False for ollama (key ignored)
    key_hint: str         # short hint on where to obtain a key


PROVIDER_PRESETS: list[ProviderPreset] = [
    ProviderPreset(
        id="deepseek",
        name_zh="DeepSeek (深度求索)",
        provider="deepseek",
        model="deepseek-chat",
        base_url=None,
        api_key_env="DEEPSEEK_API_KEY",
        needs_key=True,
        key_hint="在 platform.deepseek.com 创建 API Key",
    ),
    ProviderPreset(
        id="openai",
        name_zh="OpenAI",
        provider="openai",
        model="gpt-4o-mini",
        base_url=None,
        api_key_env="OPENAI_API_KEY",
        needs_key=True,
        key_hint="在 platform.openai.com 创建 API Key",
    ),
    ProviderPreset(
        id="anthropic",
        name_zh="Anthropic Claude",
        provider="anthropic",
        model="claude-sonnet-5",
        base_url=None,
        api_key_env="ANTHROPIC_API_KEY",
        needs_key=True,
        key_hint="在 console.anthropic.com 创建 API Key",
    ),
    ProviderPreset(
        id="gemini",
        name_zh="Google Gemini",
        provider="gemini",
        model="gemini-1.5-pro",
        base_url=None,
        api_key_env="GEMINI_API_KEY",
        needs_key=True,
        key_hint="在 aistudio.google.com 创建 API Key",
    ),
    ProviderPreset(
        id="qwen",
        name_zh="通义千问 (Qwen)",
        provider="qwen",
        model="qwen-plus",
        base_url=None,
        api_key_env="DASHSCOPE_API_KEY",
        needs_key=True,
        key_hint="在 dashscope.aliyun.com 创建 API Key",
    ),
    ProviderPreset(
        id="zhipu",
        name_zh="智谱 GLM",
        provider="zhipu",
        model="glm-4-flash",
        base_url=None,
        api_key_env="ZHIPUAI_API_KEY",
        needs_key=True,
        key_hint="在 open.bigmodel.cn 创建 API Key",
    ),
    ProviderPreset(
        id="siliconflow",
        name_zh="硅基流动 (SiliconFlow)",
        provider="openai",
        model="openai/zai-org/GLM-5.2",
        base_url="https://api.siliconflow.cn/v1",
        api_key_env="SILICONFLOW_API_KEY",
        needs_key=True,
        key_hint="在 siliconflow.cn 创建 API Key",
    ),
    ProviderPreset(
        id="ollama",
        name_zh="Ollama (本地)",
        provider="ollama",
        model="llama3",
        base_url="http://127.0.0.1:11434",
        api_key_env="OLLAMA_API_KEY",
        needs_key=False,
        key_hint="本地部署,Ollama 忽略 Key,可填任意值",
    ),
    ProviderPreset(
        id="custom",
        name_zh="自定义 OpenAI 兼容服务",
        provider="openai",
        model="openai/your-model",
        base_url="",
        api_key_env="LOCAL_LLM_API_KEY",
        needs_key=True,
        key_hint="vLLM / LM Studio 等本地兼容服务,填入 base_url 与模型名",
    ),
]


def get_preset(preset_id: str) -> ProviderPreset | None:
    """Look up a preset by its stable id. None if unknown."""
    for p in PROVIDER_PRESETS:
        if p.id == preset_id:
            return p
    return None


def preset_to_provider(p: ProviderPreset, *, model: str | None = None, base_url: str | None = None) -> ProviderConfig:
    """Build a ProviderConfig from a preset, applying optional overrides.

    `base_url=""` (empty) means "no base_url" (native provider); pass None to
    keep the preset's default. This lets the UI clear the base_url field for
    a custom server that exposes no path.
    """
    return ProviderConfig(
        provider=p.provider,
        model=model or p.model,
        base_url=p.base_url if base_url is None else (base_url or None),
        api_key_env=p.api_key_env,
    )


def is_api_key_set(provider: ProviderConfig) -> bool:
    """True if the provider's key env var is currently resolvable.

    Mirrors `resolve_api_key` so the UI can show a "已配置 / 未配置 Key" badge
    without ever exposing the key value itself. Ollama needs no key, so it
    always reports as set.
    """
    if provider.provider == "ollama":
        return True
    if provider.api_key_env is None:
        return False
    return resolve_api_key(provider) is not None





def build_litellm_params(provider: ProviderConfig) -> dict:
    """Build kwargs for `litellm.completion(model=..., **params)`.

    Keys (api keys, base URLs) are pulled from the environment at call time,
    never read from disk/DB or embedded in prompts. The resolved key is placed
    in `params["api_key"]` so litellm uses it for THIS call only.
    """
    # litellm expects model strings like "openai/gpt-4o", "anthropic/claude-...",
    # "deepseek/deepseek-chat", "gemini/gemini-1.5-pro", "ollama/llama3".
    model = provider.model
    if "/" not in model and provider.provider not in ("openai",):
        # Let users write just the model name; prefix with provider.
        model = f"{provider.provider}/{model}"
    elif "/" not in model and provider.provider == "openai":
        # OpenAI models can be bare, but prefixing is safe and unambiguous.
        model = f"openai/{model}"

    params: dict = {"model": model}
    if provider.base_url:
        params["api_base"] = provider.base_url

    api_key = resolve_api_key(provider)
    if api_key:
        # Pass per-call so litellm doesn't read from os.environ (avoids races
        # between concurrent calls using different providers, and keeps the key
        # out of any subprocess env inherited from this process).
        params["api_key"] = api_key

    params.update(provider.extra)
    return params
