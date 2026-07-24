"""Tests for app.db.migrate.ensure_schema - the additive dev-DB migrator.

Reproduces the real-world failure: a dev DB created before the 9-stage
interactive-workflow columns landed crashes with `no such column` because
create_all never adds columns to existing tables. ensure_schema backfills
them without dropping data.
"""
from __future__ import annotations

from sqlalchemy import create_engine, inspect, text

from app.db.base import Base
import app.db.models  # noqa: F401  register tables with Base.metadata
from app.db.migrate import ensure_schema


def _stale_schema(engine) -> None:
    """Build a DB shaped like the pre-interactive-workflow era."""
    with engine.begin() as conn:
        conn.execute(text("PRAGMA foreign_keys=OFF"))
        conn.execute(text(
            """
            CREATE TABLE projects (
                id VARCHAR PRIMARY KEY,
                name VARCHAR NOT NULL,
                slug VARCHAR NOT NULL UNIQUE,
                research_direction TEXT,
                root_path TEXT NOT NULL,
                status VARCHAR DEFAULT 'active',
                created_at DATETIME,
                updated_at DATETIME
            )
            """
        ))
        conn.execute(text(
            """
            CREATE TABLE agent_tasks (
                id VARCHAR PRIMARY KEY,
                project_id VARCHAR NOT NULL,
                task_type VARCHAR NOT NULL,
                input_json TEXT,
                plan_json TEXT,
                status VARCHAR DEFAULT 'pending',
                result_json TEXT,
                error TEXT,
                evidence_ids TEXT,
                created_at DATETIME,
                updated_at DATETIME
            )
            """
        ))
        conn.execute(text(
            """
            CREATE TABLE experiments (
                id VARCHAR PRIMARY KEY,
                project_id VARCHAR NOT NULL,
                title TEXT,
                slug VARCHAR,
                root_path TEXT,
                source_repository_id VARCHAR,
                related_idea_id VARCHAR,
                status VARCHAR DEFAULT 'planned',
                plan_json TEXT,
                research_question TEXT,
                hypothesis TEXT,
                created_at DATETIME,
                updated_at DATETIME
            )
            """
        ))
        conn.execute(text("INSERT INTO projects (id,name,slug,root_path) VALUES ('p1','P','p1','/x')"))
        conn.execute(text(
            "INSERT INTO agent_tasks (id,project_id,task_type,status,created_at,updated_at) "
            "VALUES ('t1','p1','experiment.run','pending','2024-01-01','2024-01-01')"
        ))
        conn.execute(text(
            "INSERT INTO experiments (id,project_id,status,created_at,updated_at) "
            "VALUES ('e1','p1','planned','2024-01-01','2024-01-01')"
        ))


def test_ensure_schema_adds_missing_columns(tmp_path):
    engine = create_engine(f"sqlite:///{tmp_path / 'stale.db'}", future=True)
    _stale_schema(engine)

    ensure_schema(engine)

    agent_cols = {c["name"] for c in inspect(engine).get_columns("agent_tasks")}
    assert "stage_key" in agent_cols
    assert "checkpoint_payload_json" in agent_cols

    exp_cols = {c["name"] for c in inspect(engine).get_columns("experiments")}
    assert {"mode", "overall_status", "current_stage", "parent_experiment_id",
            "branch_name", "decision_history_json"} <= exp_cols


def test_ensure_schema_preserves_existing_rows(tmp_path):
    engine = create_engine(f"sqlite:///{tmp_path / 'stale.db'}", future=True)
    _stale_schema(engine)
    ensure_schema(engine)

    with engine.begin() as conn:
        row = conn.execute(
            text("SELECT id, stage_key FROM agent_tasks WHERE id='t1'")
        ).fetchone()
        assert row[0] == "t1"
        assert row[1] is None  # new nullable column -> NULL for old rows


def test_ensure_schema_applies_not_null_default_to_existing_rows(tmp_path):
    """mode is NOT NULL default 'interactive' - old rows must get the default."""
    engine = create_engine(f"sqlite:///{tmp_path / 'stale.db'}", future=True)
    _stale_schema(engine)
    ensure_schema(engine)

    with engine.begin() as conn:
        row = conn.execute(
            text("SELECT mode, overall_status FROM experiments WHERE id='e1'")
        ).fetchone()
        assert row[0] == "interactive"
        assert row[1] == "draft"


def test_ensure_schema_is_idempotent(tmp_path):
    engine = create_engine(f"sqlite:///{tmp_path / 'stale.db'}", future=True)
    _stale_schema(engine)
    ensure_schema(engine)
    # Second run must be a no-op (no "duplicate column" / "index exists" errors).
    ensure_schema(engine)

    agent_cols = {c["name"] for c in inspect(engine).get_columns("agent_tasks")}
    assert "stage_key" in agent_cols
