"""Idempotency test for code.search_github: re-running the skill must not
duplicate repository rows. Regression for the "click 检索代码 N times -> N
copies of the same repo" bug."""
from __future__ import annotations

from unittest.mock import patch

from sqlalchemy import select

from app.agent.code_skills import search_github
from app.db.models import Paper, Project, Repository
from app.utils import new_id


def _fake_github_items():
    # Two distinct repos returned by the (stubbed) GitHub Search API.
    return [
        {
            "html_url": "https://github.com/foo/bar",
            "full_name": "foo/bar",
            "stargazers_count": 123,
            "description": "a repo",
            "license": {"spdx_id": "MIT"},
            "default_branch": "main",
        },
        {
            "html_url": "https://github.com/baz/qux",
            "full_name": "baz/qux",
            "stargazers_count": 7,
            "description": "another repo",
            "license": None,
            "default_branch": "main",
        },
    ]


def _run_skill(db_session, project, paper):
    state = {
        "project_id": project.id,
        "task_id": "t",
        "task_type": "code.search_github",
        "selected_papers": [paper.id],
        "warnings": [],
        "evidence": [],
        "result": {},
        "final_response": "",
    }
    with patch("app.agent.code_skills._github_search_sync", return_value=_fake_github_items()):
        with patch("app.agent.code_skills.get_gateway") as gw:
            gw.return_value.is_configured.return_value = False
            state = search_github(db_session, state)
    db_session.commit()
    return state


def test_search_github_is_idempotent(db_session, isolated_workspace):
    project = Project(
        id=new_id("prj"), name="Code Test", slug="code-test",
        root_path=str(isolated_workspace / "projects" / "code-test"),
    )
    db_session.add(project)
    db_session.flush()
    paper = Paper(
        id=new_id("pap"), project_id=project.id, title="CLIP Demo Paper",
        downloaded=True,
    )
    db_session.add(paper)
    db_session.flush()

    # First run inserts both repos.
    _run_skill(db_session, project, paper)
    rows = db_session.scalars(
        select(Repository).where(Repository.project_id == project.id)
    ).all()
    urls = sorted(r.repo_url for r in rows)
    assert urls == ["https://github.com/baz/qux", "https://github.com/foo/bar"]

    # Second run with the same results must NOT duplicate — it should refresh
    # the existing rows in place (e.g. update stars) and keep the count at 2.
    _run_skill(db_session, project, paper)
    rows = db_session.scalars(
        select(Repository).where(Repository.project_id == project.id)
    ).all()
    urls = sorted(r.repo_url for r in rows)
    assert urls == ["https://github.com/baz/qux", "https://github.com/foo/bar"], (
        f"re-running search_github duplicated repos: {urls}"
    )
    # Stars should be refreshed on the existing row, not lost.
    foo = next(r for r in rows if r.repo_url.endswith("foo/bar"))
    assert foo.stars == 123
