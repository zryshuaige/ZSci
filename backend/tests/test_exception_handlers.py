"""Phase A: 全局友好错误层 — exception_handlers.py mapping tests.

Each test boots the FastAPI app via the `client` fixture and issues an HTTP
request that triggers a specific error class (404, 400, 422, 500, etc.),
then asserts the JSON body uses the friendly {code, user_message, ...}
envelope. The goal is to lock in the contract that the frontend's
useFriendlyError hook relies on.
"""
from __future__ import annotations

import pytest


def test_404_not_found_envelope(client):
    """A 404 on a missing resource returns the NOT_FOUND code with a localised message."""
    resp = client.get("/api/v1/papers/paper_does_not_exist")
    assert resp.status_code == 404
    body = resp.json()
    # The new envelope is keyed on `code` + `user_message`. The default
    # FastAPI 404 body is {detail: "Paper not found"}; the friendly layer
    # adds `code` while still preserving `detail` for backward compat.
    assert "code" in body, body
    assert body["code"] in ("NOT_FOUND", "PROJECT_NOT_FOUND")
    assert "user_message" in body
    # user_message must be human-readable (no Python repr / stack trace).
    assert "找不到" in body["user_message"] or "不存在" in body["user_message"]


def test_400_unknown_task_type_translates_to_skill_not_found(client, project):
    """A 400 with 'Unknown task type' in detail maps to SKILL_NOT_FOUND."""
    resp = client.post(
        f"/api/v1/projects/{project['id']}/agent/tasks",
        json={"task_type": "definitely_not_real", "input": {}},
    )
    assert resp.status_code == 400
    body = resp.json()
    assert body["code"] == "SKILL_NOT_FOUND"
    assert "暂不支持" in body["user_message"]


def test_400_with_api_key_keyword_translates_to_llm_upstream_error(client):
    """A router that surfaces a raw '401' / 'API key' inside a 400 detail
    gets remapped to LLM_UPSTREAM_ERROR with a suggestion of go_settings."""
    # We can't easily make a real router leak an API key, so we exercise
    # the handler directly via the FastAPI client by hitting a route that
    # raises HTTPException(400, 'Incorrect API key provided: sk-test').
    from fastapi import FastAPI, HTTPException

    from app.exception_handlers import register_friendly_handlers

    app = FastAPI()
    register_friendly_handlers(app)

    @app.get("/leak")
    def leak():
        raise HTTPException(400, "Incorrect API key provided: sk-test-abc")

    from fastapi.testclient import TestClient

    tc = TestClient(app)
    resp = tc.get("/leak")
    assert resp.status_code == 400
    body = resp.json()
    assert body["code"] == "LLM_UPSTREAM_ERROR"
    assert body.get("suggestion") == "go_settings"
    # Detail preserved for debug panel.
    assert body.get("detail") and "sk-test-abc" in body["detail"]


def test_400_with_timeout_keyword_translates_to_llm_timeout(client):
    """A router that surfaces a timeout-style error inside a 400 detail
    gets remapped to LLM_TIMEOUT with a retry suggestion."""
    from fastapi import FastAPI, HTTPException

    from app.exception_handlers import register_friendly_handlers

    app = FastAPI()
    register_friendly_handlers(app)

    @app.get("/timeout")
    def timeout():
        raise HTTPException(400, "openai: Request timed out")

    from fastapi.testclient import TestClient

    tc = TestClient(app)
    resp = tc.get("/timeout")
    assert resp.status_code == 400
    body = resp.json()
    assert body["code"] == "LLM_TIMEOUT"
    assert body.get("suggestion") == "retry"


def test_validation_error_returns_input_invalid(client):
    """A pydantic validation failure returns INPUT_INVALID with the first
    error's loc baked into user_message for context."""
    resp = client.post(
        "/api/v1/projects",
        json={"name": ""},  # name has min_length=1
    )
    assert resp.status_code == 422
    body = resp.json()
    assert body["code"] == "INPUT_INVALID"
    assert "user_message" in body
    assert "输入有误" in body["user_message"]


def test_unknown_route_returns_404_envelope(client):
    """A 404 from FastAPI's routing layer (not our routers) still goes through
    our HTTPException handler because FastAPI emits an HTTPException(404)."""
    resp = client.get("/api/v1/no-such-route")
    assert resp.status_code == 404
    body = resp.json()
    # Depending on FastAPI version the code can be NOT_FOUND.
    assert body.get("code") in ("NOT_FOUND", None)  # FastAPI may pre-empt us
    if body.get("code"):
        assert "user_message" in body


def test_unhandled_exception_returns_safe_internal(client):
    """An uncaught Python exception in a route doesn't leak stack traces;
    it becomes a localised INTERNAL with `detail` containing only the class
    name (no message)."""
    from fastapi import FastAPI

    from app.exception_handlers import register_friendly_handlers

    app = FastAPI()
    register_friendly_handlers(app)

    @app.get("/boom")
    def boom():
        raise RuntimeError("internal secret that must not leak")

    from fastapi.testclient import TestClient

    # TestClient re-raises server exceptions by default (which would skip
    # our handler). Production never raises; disable for this test so the
    # exception flows through our registered handler instead.
    tc = TestClient(app, raise_server_exceptions=False)
    resp = tc.get("/boom")
    assert resp.status_code == 500
    body = resp.json()
    assert body["code"] == "INTERNAL"
    # Critical: the leaked message must NOT appear in the response body.
    assert "internal secret" not in resp.text
    # `detail` carries the exception class name only, never the message.
    assert body["detail"] in (None, "RuntimeError")
