"""Integration tests for the generic Job tracker + /workflows/active jobs.

Verifies the core invariant that makes the global sidebar work: a `running` Job
row is COMMITTED (not just flushed), so the sidebar's separate session sees it
while the originating request is still in flight. Also checks jobs are surfaced
in /workflows/active with the recent-tail behavior.
"""
from __future__ import annotations


def test_start_job_commits_running_row(db_session):
    """start_job must commit (not flush) so a separate session can read it."""
    from app.db.session import get_sessionmaker
    from app.jobs import start_job

    prj_id = "prj_job_test"
    # Seed a project so the FK is satisfied.
    from app.db.models import Project

    db_session.add(Project(id=prj_id, name="Job Test", slug="job-test", root_path="/tmp"))
    db_session.commit()

    job = start_job(db_session, project_id=prj_id, kind="benchmark_search", title="t")
    assert job.status == "running"

    # A FRESH session (like the sidebar's) must see the row immediately.
    other = get_sessionmaker()()
    try:
        row = other.get(type(job), job.id)
        assert row is not None
        assert row.status == "running"
    finally:
        other.close()


def test_workflows_active_lists_active_and_recent_jobs(client, project, db_session):
    """Jobs surface in /workflows/active: running ones as active, finished ones
    as 'recent' (within the window)."""
    from app.jobs import start_job, update_job

    running = start_job(db_session, project_id=project["id"], kind="literature_search", title="r")
    done = start_job(db_session, project_id=project["id"], kind="translate", title="d")
    update_job(db_session, done.id, status="completed", result_summary="ok")
    assert running.status == "running"

    body = client.get("/api/v1/workflows/active").json()
    kinds = {j["kind"]: j for j in body["jobs"]}
    assert "literature_search" in kinds, body
    assert kinds["literature_search"]["status"] == "running"
    assert kinds["literature_search"]["recent"] is False
    assert kinds["translate"]["status"] == "completed"
    assert kinds["translate"]["recent"] is True


def test_jobs_reaped_on_startup(client, project, db_session):
    """The startup orphan-reap marks running Jobs as stopped (single-process
    assumption: a background Job can't survive a restart)."""
    from app.db.models import Job
    from app.jobs import start_job
    from app.main import _reap_orphan_workflow_state

    start_job(db_session, project_id=project["id"], kind="latex_compile", title="c")

    _reap_orphan_workflow_state()

    rows = db_session.query(Job).filter_by(kind="latex_compile").all()
    assert rows, "job should still exist"
    assert all(r.status == "stopped" for r in rows)
