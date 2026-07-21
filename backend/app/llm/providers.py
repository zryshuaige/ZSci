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

from app.config import ProviderConfig, resolve_api_key


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
