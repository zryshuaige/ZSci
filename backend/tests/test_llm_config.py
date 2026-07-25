"""Tests for the LLM provider settings UI flow:

  - GET  /api/v1/llm/config  -> provider catalog + current selection
  - PUT  /api/v1/llm/config  -> save provider/model/base_url + optional key

These exercise the new read/write surface that lets the user pick a model
provider and enter an API key from the Settings page instead of hand-editing
config.yaml + .env. Key writes go to a temp .env (conftest's isolated_workspace
redirects ZSCI_ENV_FILE), never the real backend/.env.
"""
from __future__ import annotations

import os

import yaml


def _get_config(client):
    return client.get("/api/v1/llm/config").json()


def test_llm_config_returns_preset_catalog(client):
    """GET /llm/config returns the fixed provider presets + a current snapshot."""
    body = _get_config(client)
    assert client.get("/api/v1/llm/config").status_code == 200

    preset_ids = [p["id"] for p in body["presets"]]
    # The 9 documented providers must all be present and stable-ordered.
    assert preset_ids == [
        "deepseek", "openai", "anthropic", "gemini",
        "qwen", "zhipu", "siliconflow", "ollama", "custom",
    ]
    # Presets carry the fields the dropdown needs (no key values).
    sf = next(p for p in body["presets"] if p["id"] == "siliconflow")
    assert sf["provider"] == "openai"
    assert sf["base_url"] == "https://api.siliconflow.cn/v1"
    assert sf["api_key_env"] == "SILICONFLOW_API_KEY"
    assert sf["needs_key"] is True
    assert "key_hint" in sf

    # current is a safe snapshot (no key value), defaulting to "not configured"
    # for a brand-new isolated workspace with no config.yaml.
    cur = body["current"]
    assert "provider" in cur
    assert "api_key_set" in cur
    assert "matched_preset_id" in cur


def test_put_llm_config_rejects_unknown_provider(client):
    """An unknown provider_id is a 422 (not a 500)."""
    resp = client.put(
        "/api/v1/llm/config",
        json={"provider_id": "bogus-provider"},
    )
    assert resp.status_code == 422


def test_put_llm_config_writes_provider_and_key(client, isolated_workspace):
    """Saving a provider writes config.yaml + the key to .env, and the change
    is immediately visible to GET /llm/config (cache cleared)."""
    resp = client.put(
        "/api/v1/llm/config",
        json={
            "provider_id": "deepseek",
            "api_key": "sk-test-deepseek-123",
        },
    )
    assert resp.status_code == 200, resp.text
    out = resp.json()
    assert out["provider"] == "deepseek"
    assert out["model"] == "deepseek-chat"
    assert out["api_key_env"] == "DEEPSEEK_API_KEY"
    assert out["api_key_set"] is True
    assert out["matched_preset_id"] == "deepseek"

    # config.yaml was written with the default_chat role.
    cfg_path = isolated_workspace / ".research-agent" / "config.yaml"
    raw = yaml.safe_load(cfg_path.read_text(encoding="utf-8"))
    dc = raw["models"]["default_chat"]
    assert dc["provider"] == "deepseek"
    assert dc["model"] == "deepseek-chat"
    assert dc["api_key_env"] == "DEEPSEEK_API_KEY"
    assert "base_url" not in dc  # native provider -> no base_url written

    # The key landed in the redirected temp .env (NOT the real backend/.env).
    env_path = os.environ["ZSCI_ENV_FILE"]
    assert os.path.abspath(env_path) != os.path.abspath("backend/.env"), (
        "test must not touch the real backend/.env"
    )
    from dotenv import dotenv_values
    assert dotenv_values(env_path).get("DEEPSEEK_API_KEY") == "sk-test-deepseek-123"

    # resolve_api_key now returns the saved key (reads .env live, no restart).
    from app.config import ProviderConfig, resolve_api_key
    pc = ProviderConfig(provider="deepseek", model="deepseek-chat", api_key_env="DEEPSEEK_API_KEY")
    assert resolve_api_key(pc) == "sk-test-deepseek-123"

    # GET reflects the saved config too.
    cur = _get_config(client)["current"]
    assert cur["api_key_set"] is True
    assert cur["matched_preset_id"] == "deepseek"


def test_put_llm_config_preserves_other_roles(client, isolated_workspace):
    """Saving default_chat must not wipe other roles (e.g. embedding)."""
    # Seed an embedding role first.
    cfg_path = isolated_workspace / ".research-agent" / "config.yaml"
    cfg_path.parent.mkdir(parents=True, exist_ok=True)
    cfg_path.write_text(yaml.safe_dump({"models": {
        "embedding": {"provider": "openai", "model": "text-embedding-3-small", "api_key_env": "OPENAI_API_KEY"},
    }}), encoding="utf-8")
    from app.llm.gateway import get_gateway
    get_gateway.cache_clear()

    resp = client.put(
        "/api/v1/llm/config",
        json={"provider_id": "openai", "api_key": "sk-x"},
    )
    assert resp.status_code == 200, resp.text
    raw = yaml.safe_load(cfg_path.read_text(encoding="utf-8"))
    assert "embedding" in raw["models"], "embedding role must be preserved"
    assert raw["models"]["default_chat"]["provider"] == "openai"


def test_put_llm_config_blank_key_keeps_existing(client, isolated_workspace):
    """A blank/omitted api_key leaves the existing key untouched.

    The UI field is masked, so blank means "don't change" - we must NOT clear
    or overwrite a previously-saved key when the user saves a different model
    without re-entering the key.
    """
    # Save once with a key.
    client.put("/api/v1/llm/config", json={"provider_id": "deepseek", "api_key": "sk-keep-me"})
    # Save again (same provider, different model) WITHOUT a key.
    resp = client.put(
        "/api/v1/llm/config",
        json={"provider_id": "deepseek", "model": "deepseek-reasoner"},
    )
    assert resp.status_code == 200, resp.text
    from dotenv import dotenv_values
    from app.config import env_file_path
    assert dotenv_values(env_file_path()).get("DEEPSEEK_API_KEY") == "sk-keep-me"
    assert resp.json()["model"] == "deepseek-reasoner"


def test_put_llm_config_custom_base_url_override(client, isolated_workspace):
    """The custom preset lets the user override model + base_url."""
    resp = client.put(
        "/api/v1/llm/config",
        json={
            "provider_id": "custom",
            "model": "openai/my-local-model",
            "base_url": "http://127.0.0.1:8000/v1",
            "api_key": "local-key",
        },
    )
    assert resp.status_code == 200, resp.text
    out = resp.json()
    assert out["provider"] == "openai"
    assert out["base_url"] == "http://127.0.0.1:8000/v1"
    assert out["model"] == "openai/my-local-model"
    cfg_path = isolated_workspace / ".research-agent" / "config.yaml"
    raw = yaml.safe_load(cfg_path.read_text(encoding="utf-8"))
    assert raw["models"]["default_chat"]["base_url"] == "http://127.0.0.1:8000/v1"


def test_put_llm_config_ollama_needs_no_key(client, isolated_workspace):
    """Ollama reports api_key_set=True even with no key entered."""
    resp = client.put("/api/v1/llm/config", json={"provider_id": "ollama"})
    assert resp.status_code == 200, resp.text
    assert resp.json()["api_key_set"] is True
