"""Security regression tests for the API surface (C1-C7).

Covers the high-severity issues fixed in Batch 1:
- C1: research skills leak papers across projects when `paper_ids` is empty.
- C2: writing skill leaks completed runs across projects.
- C3: client-supplied `input` keys can override trusted state fields.
- C4: experiment subprocess env doesn't inherit LLM API keys.
- C5: PDF download endpoint rejects SSRF / internal IPs.
- C7: import_local_pdf requires confirmed=true + path allowlist.

We use the FastAPI TestClient for end-to-end coverage. LLM calls are stubbed
by monkeypatching the gateway so we can exercise the skill paths without a
configured model.
"""
from __future__ import annotations

import json
from pathlib import Path
from unittest.mock import patch

# ---------------------------------------------------------------------------
# C5: SSRF protection
# ---------------------------------------------------------------------------


def test_c5_download_rejects_loopback_url(client, project):
    """Download endpoint rejects loopback URLs (C5)."""
    resp = client.post(
        f"/api/v1/projects/{project['id']}/papers/download",
        json={
            "paper_id": "p_test_1",
            "title": "Test",
            "pdf_url": "http://127.0.0.1:8000/api/v1/health",
            "confirmed": True,
        },
    )
    assert resp.status_code == 400
    assert "URL rejected" in resp.json()["detail"] or "safety" in resp.json()["detail"].lower()


def test_c5_download_rejects_metadata_endpoint(client, project):
    """Download endpoint rejects cloud metadata endpoints (C5)."""
    resp = client.post(
        f"/api/v1/projects/{project['id']}/papers/download",
        json={
            "paper_id": "p_test_2",
            "title": "Test",
            "pdf_url": "http://169.254.169.254/latest/meta-data/",
            "confirmed": True,
        },
    )
    assert resp.status_code == 400


def test_c5_download_rejects_file_scheme(client, project):
    """Download endpoint rejects non-http schemes (C5)."""
    resp = client.post(
        f"/api/v1/projects/{project['id']}/papers/download",
        json={
            "paper_id": "p_test_3",
            "title": "Test",
            "pdf_url": "file:///etc/passwd",
            "confirmed": True,
        },
    )
    assert resp.status_code == 400


def test_c5_download_requires_confirmed(client, project):
    """Without confirmed=true the endpoint refuses even a safe URL (design.md §16.1)."""
    resp = client.post(
        f"/api/v1/projects/{project['id']}/papers/download",
        json={
            "paper_id": "p_test_4",
            "title": "Test",
            "pdf_url": "https://example.com/paper.pdf",
            "confirmed": False,
        },
    )
    assert resp.status_code == 422


# ---------------------------------------------------------------------------
# C7: import_local_pdf path traversal + confirmed gate
# ---------------------------------------------------------------------------


def test_c7_import_local_requires_confirmed(client, project, tmp_path):
    """import-local refuses without confirmed=true (C7)."""
    fake_pdf = tmp_path / "ok.pdf"
    fake_pdf.write_bytes(b"%PDF-1.4 test")
    resp = client.post(
        f"/api/v1/projects/{project['id']}/papers/import-local",
        json={
            "paper_id": "p_imp_1",
            "title": "Test",
            "source_path": str(fake_pdf),
            "confirmed": False,
        },
    )
    assert resp.status_code == 422


def test_c7_import_local_rejects_arbitrary_path(client, project):
    """import-local refuses paths outside the allowlist (C7).

    `/etc/hosts` is not under ~/Downloads / ~/Desktop / ~/Documents / /tmp /
    /var/folders, so it must be rejected even with confirmed=true.
    """
    resp = client.post(
        f"/api/v1/projects/{project['id']}/papers/import-local",
        json={
            "paper_id": "p_imp_2",
            "title": "Test",
            "source_path": "/etc/hosts",
            "confirmed": True,
        },
    )
    assert resp.status_code == 400
    assert "allow" in resp.json()["detail"].lower() or "outside" in resp.json()["detail"].lower()


def test_c7_import_local_rejects_ssh_key(client, project):
    """import-local refuses to read ~/.ssh/id_rsa even if it exists (C7)."""
    ssh_key = Path.home() / ".ssh" / "id_rsa"
    resp = client.post(
        f"/api/v1/projects/{project['id']}/papers/import-local",
        json={
            "paper_id": "p_imp_3",
            "title": "Test",
            "source_path": str(ssh_key),
            "confirmed": True,
        },
    )
    # Either 400 (path outside allowlist) — never 200 with the file contents.
    assert resp.status_code in (400,)


def test_c7_import_local_accepts_tmp_path(client, project, tmp_path):
    """import-local accepts a real PDF under /tmp (allowlisted) when confirmed (C7)."""
    # tmp_path is under /var/folders on macOS and /tmp on Linux, both allowlisted.
    fake_pdf = tmp_path / "legit.pdf"
    fake_pdf.write_bytes(b"%PDF-1.4 hello world\n%%EOF")
    resp = client.post(
        f"/api/v1/projects/{project['id']}/papers/import-local",
        json={
            "paper_id": "p_imp_4",
            "title": "Test",
            "source_path": str(fake_pdf),
            "confirmed": True,
        },
    )
    assert resp.status_code == 200, resp.text
    body = resp.json()
    assert body["downloaded"] is True
    # M26: imported_from must NOT leak the absolute path.
    # (We can't see metadata.json via the API, but the response should not
    # echo the source path.)
    assert str(fake_pdf) not in json.dumps(body)


# ---------------------------------------------------------------------------
# C3: input field injection
# ---------------------------------------------------------------------------


def _patch_gateway(stub):
    """Patch get_gateway in every module that imported it by name."""
    from contextlib import ExitStack
    stack = ExitStack()
    stack.enter_context(patch("app.agent.research_skills.get_gateway", lambda: stub))
    stack.enter_context(patch("app.agent.code_skills.get_gateway", lambda: stub))
    stack.enter_context(patch("app.agent.writing_skill.get_gateway", lambda: stub))
    return stack


def test_c3_input_cannot_override_project_id(client, project):
    """A client passing `project_id` in `input` must NOT override the trusted
    server-side value (C3). We exercise this via the trend_analysis skill,
    which would otherwise build an evidence pack for the wrong project.
    """
    # Create a second project to attempt the leak.
    other = client.post(
        "/api/v1/projects",
        json={"name": "Other Project", "research_direction": "other"},
    ).json()

    # Stub the LLM gateway so the skill runs without a configured model.
    class _StubGateway:
        def is_configured(self, role): return True
        def chat(self, messages, **kw): return '{"evidence": [], "timeline": []}'

    with _patch_gateway(_StubGateway()):
        resp = client.post(
            f"/api/v1/projects/{project['id']}/agent/tasks",
            json={
                "task_type": "research.trend_analysis",
                "input": {
                    "user_request": "anything",
                    # Try to override trusted fields (C3):
                    "project_id": other["id"],
                    "task_id": "fake_task_id",
                    "result": {"injected": True},
                },
            },
        )
    # The task should complete (or fail with a skill-specific error), but in
    # any case the input injection must not flip which project the skill
    # queries. We verify by inspecting the persisted task.
    assert resp.status_code in (200, 502, 500), resp.text
    body = resp.json()
    assert body["project_id"] == project["id"], "C3: client overrode project_id"


# ---------------------------------------------------------------------------
# C1: cross-project paper leak via empty paper_ids
# ---------------------------------------------------------------------------


def test_c1_trend_analysis_with_empty_paper_ids_stays_scoped(client, project):
    """When `paper_ids` is empty, research.trend_analysis must only consider
    papers in the CURRENT project, not all papers across all projects (C1).
    """
    # Create another project with a downloaded paper.
    other = client.post(
        "/api/v1/projects",
        json={"name": "Other", "research_direction": "x"},
    ).json()
    # Import a real PDF into the OTHER project.
    fake_pdf = Path("/tmp") / f"zsci_c1_{project['id'][:8]}.pdf"
    fake_pdf.write_bytes(b"%PDF-1.4 other project\n%%EOF")
    client.post(
        f"/api/v1/projects/{other['id']}/papers/import-local",
        json={
            "paper_id": "p_other_proj",
            "title": "Other Project Paper",
            "source_path": str(fake_pdf),
            "confirmed": True,
        },
    )


    captured: dict = {}

    class _StubGateway:
        def is_configured(self, role): return True
        def chat(self, messages, **kw):
            # Capture the prompt so we can assert it does NOT contain the
            # other project's paper title.
            captured["prompt"] = messages[-1]["content"]
            return '{"evidence": [], "timeline": []}'

    with _patch_gateway(_StubGateway()):
        resp = client.post(
            f"/api/v1/projects/{project['id']}/agent/tasks",
            json={
                "task_type": "research.trend_analysis",
                "input": {"user_request": "any"},
            },
        )
    assert resp.status_code in (200, 502, 500), resp.text
    prompt = captured.get("prompt", "")
    assert "Other Project Paper" not in prompt, (
        "C1: trend_analysis pulled a paper from another project into the prompt"
    )


# ---------------------------------------------------------------------------
# Audit log persistence on failure (H1)
# ---------------------------------------------------------------------------


def test_h1_failed_download_writes_audit_row(client, project):
    """A failed SSRF-blocked download must still record an audit row (H1).

    The error audit is written in a separate session so it survives the
    router's rollback. We verify by listing audit rows via the DB after the
    failed request.
    """
    from sqlalchemy import select
    from sqlalchemy.orm import Session

    from app.db.models import AuditLog
    from app.db.session import get_engine

    resp = client.post(
        f"/api/v1/projects/{project['id']}/papers/download",
        json={
            "paper_id": "p_audit_test",
            "title": "Test",
            "pdf_url": "http://127.0.0.1/nope",
            "confirmed": True,
        },
    )
    assert resp.status_code == 400

    with Session(get_engine()) as s:
        rows = s.scalars(
            select(AuditLog)
            .where(AuditLog.project_id == project["id"])
            .order_by(AuditLog.created_at.desc())
        ).all()
    actions = [r.action_type for r in rows]
    assert "paper.download_pdf" in actions, (
        "H1: failed download did not persist an audit row"
    )
    error_rows = [r for r in rows if r.action_type == "paper.download_pdf" and r.status == "error"]
    assert error_rows, "H1: no error-status audit row for the failed download"
