"""Additive schema migration for dev SQLite (no Alembic).

`Base.metadata.create_all` creates tables that don't exist but never adds
columns to tables that already exist. So when a column is added to an ORM
model, a previously-initialized dev DB is left without it and the app
crashes at runtime with `sqlite3.OperationalError: no such column: ...`
- exactly the `agent_tasks.stage_key` / `experiments.mode` failure that hit
the running dev DB after the 9-stage interactive-workflow columns landed.

This closes that gap. After create_all, walk every mapped table, compare
the model's columns against the DB's `PRAGMA table_info`, and `ALTER TABLE
ADD COLUMN` for any missing ones; likewise `CREATE INDEX IF NOT EXISTS`
for any missing indexes the model declares. It only ADDS (never drops /
renames / retypes), so it's safe and idempotent - running it twice is a
no-op. Dev convenience only; Alembic remains the canonical migration path
for real schema evolution.
"""
from __future__ import annotations

from sqlalchemy import inspect, text
from sqlalchemy.engine import Engine

from app.db.base import Base


def ensure_schema(engine: Engine) -> None:
    """Add any model columns/indexes missing from existing tables. Idempotent.

    Runs after ``Base.metadata.create_all``; the latter has just created any
    tables that didn't exist, so every table in ``Base.metadata`` now exists
    in the DB. What it can't do is add columns to a table it created on a
    previous run - that's what this function backfills.
    """
    inspector = inspect(engine)
    with engine.begin() as conn:
        dialect = conn.dialect
        for table_name, table in Base.metadata.tables.items():
            if not inspector.has_table(table_name):
                continue  # defensive - create_all should have made it
            _add_missing_columns(conn, dialect, table_name, table, inspector)
            _add_missing_indexes(conn, table_name, table, inspector)


def _add_missing_columns(conn, dialect, table_name: str, table, inspector) -> None:
    existing = {c["name"] for c in inspector.get_columns(table_name)}
    for column in table.columns:
        if column.name in existing:
            continue
        type_ddl = column.type.compile(dialect=dialect)
        default_sql = _default_sql(column)
        sql = f"ALTER TABLE {table_name} ADD COLUMN {column.name} {type_ddl}"
        if not column.nullable:
            if default_sql is not None:
                # NOT NULL requires a DEFAULT so existing rows get a value.
                sql += f" NOT NULL DEFAULT {default_sql}"
            else:
                # No inlineable default - leave the column nullable so startup
                # doesn't crash on a non-empty table. New rows still get the
                # ORM's Python-side default; the divergence (nullable vs the
                # model's NOT NULL) is acceptable for a dev DB.
                pass
        elif default_sql is not None:
            sql += f" DEFAULT {default_sql}"
        conn.execute(text(sql))


def _add_missing_indexes(conn, table_name: str, table, inspector) -> None:
    existing = {ix["name"] for ix in inspector.get_indexes(table_name)}
    for index in table.indexes:
        if index.name is None or index.name in existing:
            continue
        cols = ", ".join(f'"{c.name}"' for c in index.columns)
        conn.execute(
            text(f'CREATE INDEX IF NOT EXISTS "{index.name}" ON {table_name} ({cols})')
        )


def _default_sql(column) -> str | None:
    """Render the column's default as a SQL literal, or None if not inlineable.

    Prefers the server-side default; falls back to a scalar Python-side
    default (``default="interactive"``, ``default=0``). Callables / expressions
    / FetchedValue can't be inlined into ALTER, so return None for those.
    """
    default = column.server_default if column.server_default is not None else column.default
    if default is None:
        return None
    arg = getattr(default, "arg", None)
    if isinstance(arg, bool):
        return "1" if arg else "0"
    if isinstance(arg, (int, float)):
        return str(arg)
    if isinstance(arg, str):
        escaped = arg.replace("'", "''")
        return f"'{escaped}'"
    return None
