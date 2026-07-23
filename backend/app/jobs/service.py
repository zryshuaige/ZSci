"""Job lifecycle service.

A Job is a user-triggered long-running operation tracked in the `jobs` table so
the global workflow sidebar can show it as in-progress (and recently-finished)
even when the user navigates away from the page that started it.

The critical rule (mirrors app/agent/service.py:run_task): the `running` row is
COMMITTED immediately, not just flushed. Operations run sync-in-request (LLM
calls, network fetches, parsing) hold the HTTP connection open for seconds;
without a committed status row, the sidebar's separate DB session can't see the
work in flight. With a commit, it can - no need to background every operation.
"""
from __future__ import annotations

from datetime import UTC, datetime, timedelta

from sqlalchemy import select
from sqlalchemy.orm import Session

from app.db.models import Job
from app.utils import new_id

ACTIVE_STATUSES = ("running",)
TERMINAL_STATUSES = ("completed", "failed", "stopped")
# Window a finished Job lingers in the sidebar so fast operations (translation,
# reading note, literature search) leave a visible trace even if they finished
# between the sidebar's polls.
RECENT_WINDOW_SECONDS = 90


def start_job(
    db: Session,
    *,
    project_id: str,
    kind: str,
    title: str | None = None,
    target_id: str | None = None,
    target_type: str | None = None,
    message: str | None = None,
) -> Job:
    """Create + COMMIT a `running` Job row. The commit is the whole point: it
    makes the row visible to the sidebar's separate session while the operation
    is still in flight in the caller's request."""
    job = Job(
        id=new_id("job"),
        project_id=project_id,
        kind=kind,
        status="running",
        title=title,
        target_id=target_id,
        target_type=target_type,
        message=message,
    )
    db.add(job)
    db.commit()
    db.refresh(job)
    return job


def update_job(
    db: Session,
    job_id: str,
    *,
    status: str | None = None,
    message: str | None = None,
    error: str | None = None,
    result_summary: str | None = None,
) -> Job | None:
    """Commit updates to a Job. Used at operation end (terminal status) and at
    progress milestones. Returns the row or None if it vanished."""
    job = db.get(Job, job_id)
    if job is None:
        return None
    if status is not None:
        job.status = status
    if message is not None:
        job.message = message
    if error is not None:
        job.error = error
    if result_summary is not None:
        job.result_summary = result_summary
    db.commit()
    db.refresh(job)
    return job


def finish_job_in_fresh_session(
    job_id: str,
    *,
    status: str,
    error: str | None = None,
    result_summary: str | None = None,
) -> None:
    """Mark a Job terminal using a FRESH session, for the case where the
    caller's main session is being rolled back (e.g. a failed download that
    rolls back to release the write lock before persisting an error audit).
    Mirrors app/pdf/download._audit_failure_separately."""
    from app.db.session import get_sessionmaker

    try:
        with get_sessionmaker()() as db:
            job = db.get(Job, job_id)
            if job is not None and job.status not in TERMINAL_STATUSES:
                job.status = status
                if error is not None:
                    job.error = error
                if result_summary is not None:
                    job.result_summary = result_summary
                db.commit()
    except Exception:  # noqa: BLE001
        # Status tracking must never break the operation itself.
        pass


def list_active_and_recent_jobs(db: Session) -> tuple[list[Job], list[Job]]:
    """Return (active, recent) Jobs. Active = running. Recent = terminal within
    RECENT_WINDOW_SECONDS, for the sidebar's finished-tail."""
    cutoff = datetime.now(UTC) - timedelta(seconds=RECENT_WINDOW_SECONDS)
    active = list(db.scalars(
        select(Job).where(Job.status.in_(ACTIVE_STATUSES)).order_by(Job.created_at.desc()).limit(30)
    ).all())
    active_ids = {j.id for j in active}
    recent = list(db.scalars(
        select(Job)
        .where(Job.status.in_(TERMINAL_STATUSES), Job.updated_at > cutoff)
        .order_by(Job.updated_at.desc()).limit(15)
    ).all())
    recent = [j for j in recent if j.id not in active_ids]
    return active, recent
