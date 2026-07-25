"""Shared test fixtures: isolated workspace + in-memory-ish SQLite per test."""
from __future__ import annotations

import importlib
from pathlib import Path

import pytest
from sqlalchemy import create_engine
from sqlalchemy.orm import sessionmaker

# Force an isolated workspace before importing app code.
import tempfile


@pytest.fixture(autouse=True)
def isolated_workspace(tmp_path, monkeypatch):
    """Each test gets a fresh workspace + DB under tmp_path."""
    ws = tmp_path / "workspace"
    ws.mkdir()
    monkeypatch.setenv("ZSCI_WORKSPACE_PATH", str(ws))
    monkeypatch.delenv("ZSCI_LLM_CONFIG_PATH", raising=False)

    # Redirect the API-key .env to a temp file so tests NEVER read or write
    # the real backend/.env. resolve_api_key / config_io.save_api_key both
    # honor ZSCI_ENV_FILE (see app.config.env_file_path). Without this, a test
    # that saved a key would corrupt the developer's real .env.
    monkeypatch.setenv("ZSCI_ENV_FILE", str(tmp_path / "test.env"))

    # Reset cached singletons so they pick up the new env.
    from app import config as config_module
    config_module.get_settings.cache_clear()
    from app.llm import gateway as gateway_module
    gateway_module.get_gateway.cache_clear()
    from app.literature import venue_registry as vr_module
    vr_module.get_venue_registry.cache_clear()

    # Reset the DB engine cache.
    from app.db import session as session_module
    session_module._engine = None
    session_module._SessionLocal = None

    yield ws

    config_module.get_settings.cache_clear()
    gateway_module.get_gateway.cache_clear()


@pytest.fixture
def db_session(isolated_workspace):
    """A fresh SQLite DB with schema, in the isolated workspace."""
    from app.db.base import Base
    import app.db.models  # noqa: F401  register tables

    settings_db = isolated_workspace / ".research-agent" / "app.db"
    settings_db.parent.mkdir(parents=True, exist_ok=True)
    engine = create_engine(f"sqlite:///{settings_db}", future=True)
    Base.metadata.create_all(engine)
    SessionLocal = sessionmaker(bind=engine, autoflush=False, expire_on_commit=False)
    session = SessionLocal()
    try:
        yield session
    finally:
        session.close()
        Base.metadata.drop_all(engine)
        engine.dispose()


@pytest.fixture
def client(isolated_workspace):
    """A FastAPI TestClient backed by a fresh DB for each test.

    The TestClient uses the app's real get_db dependency, which reads from the
    cached engine. We let isolated_workspace reset the engine cache, then
    trigger schema creation by importing the app (lifespan's create_all runs
    via TestClient context manager).
    """
    from fastapi.testclient import TestClient

    from app.db.base import Base
    import app.db.models  # noqa: F401  register tables
    from app.main import create_app

    # Ensure the schema exists before the client issues requests. Using the
    # app's own engine avoids a second connection that wouldn't share data.
    from app.db.session import get_engine
    Base.metadata.create_all(get_engine())

    app = create_app()
    with TestClient(app) as c:
        yield c


@pytest.fixture
def project(client):
    """A freshly-created project via the API, returned as a dict."""
    resp = client.post(
        "/api/v1/projects",
        json={"name": "Test Project", "research_direction": "test direction"},
    )
    assert resp.status_code == 201, resp.text
    return resp.json()
