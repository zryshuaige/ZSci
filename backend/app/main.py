"""FastAPI application entrypoint.

Mounts all routers, configures CORS, ensures the DB schema exists on startup
(Alembic is the canonical migration path; `create_all` is a dev convenience so
`uvicorn app.main:app` works without a prior `alembic upgrade`).
"""
from __future__ import annotations

import asyncio
from contextlib import asynccontextmanager

from fastapi import FastAPI
from fastapi.middleware.cors import CORSMiddleware

from app.config import get_settings
from app.db.base import Base
from app.db.session import get_engine
from app.logging import setup_logging
from app.routers import (
    agent,
    annotations,
    experiments,
    ideas,
    literature,
    notes,
    papers,
    projects,
    repositories,
    system,
    writing,
)


@asynccontextmanager
async def lifespan(app: FastAPI):  # noqa: ANN001
    setup_logging()
    # Import agent skills so they register with the skill registry. (The
    # routers/agent import already triggers this at module load, but we keep
    # the explicit import here for clarity and to support non-router callers.)
    from app.agent import code_skills, research_skills, writing_skill  # noqa: F401
    # Ensure workspace dirs exist up front instead of in property getters (M29).
    settings = get_settings()
    settings.research_agent_dir  # noqa: B018 - intentional: trigger mkdir once
    settings.projects_root  # noqa: B018
    # Create tables off the event loop (H10). SQLite DDL is fast but still
    # shouldn't block async startup.
    import app.db.models  # noqa: F401  register tables with Base.metadata
    await asyncio.to_thread(Base.metadata.create_all, get_engine())
    try:
        yield
    finally:
        # Dispose the engine on shutdown so file handles / connections release.
        await asyncio.to_thread(get_engine().dispose)


def create_app() -> FastAPI:
    settings = get_settings()
    app = FastAPI(
        title="Z-Sci API",
        version="0.1.0",
        description="Local research agent backend (Phase 1).",
        lifespan=lifespan,
    )
    app.add_middleware(
        CORSMiddleware,
        allow_origins=settings.cors_origins,
        allow_credentials=True,
        # Restrict to verbs actually used (M27) instead of "*" — limits the
        # blast radius if cors_origins is ever widened.
        allow_methods=["GET", "POST", "PUT", "PATCH", "DELETE", "OPTIONS"],
        allow_headers=["Content-Type", "Authorization"],
    )
    app.include_router(system.router)
    app.include_router(projects.router)
    app.include_router(literature.router)
    app.include_router(papers.router)
    app.include_router(notes.router)
    app.include_router(annotations.router)
    app.include_router(ideas.router)
    app.include_router(repositories.router)
    app.include_router(agent.router)
    app.include_router(experiments.router)
    app.include_router(writing.router)

    @app.get("/")
    def root() -> dict:
        return {"name": "Z-Sci API", "version": "0.1.0", "docs": "/docs"}

    return app


app = create_app()
