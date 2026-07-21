"""Integration tests for the papers router (download / parse / pdf / list).

Uses TestClient + a stubbed PDF (real bytes written via import-local, since
that's the path that doesn't require network access).
"""
from __future__ import annotations

import pytest


def test_list_papers_empty(client, project):
    resp = client.get(f"/api/v1/projects/{project['id']}/papers")
    assert resp.status_code == 200
    assert resp.json() == []


def test_get_paper_404(client):
    resp = client.get("/api/v1/papers/nonexistent")
    assert resp.status_code == 404


def test_import_then_get_paper(client, project, tmp_path):
    """End-to-end: import a local PDF, list papers, fetch the paper record."""
    fake_pdf = tmp_path / "p.pdf"
    fake_pdf.write_bytes(b"%PDF-1.4 hello world\n%%EOF")
    imp = client.post(
        f"/api/v1/projects/{project['id']}/papers/import-local",
        json={
            "paper_id": "p_e2e_1",
            "title": "End-to-end Paper",
            "authors": ["Alice", "Bob"],
            "year": 2024,
            "venue": "ICML",
            "source_path": str(fake_pdf),
            "confirmed": True,
        },
    )
    assert imp.status_code == 200, imp.text
    body = imp.json()
    assert body["downloaded"] is True
    assert body["parse_status"] == "pending"
    assert body["local_pdf_path"] is not None

    # List should now contain the paper.
    lst = client.get(f"/api/v1/projects/{project['id']}/papers")
    assert lst.status_code == 200
    papers = lst.json()
    assert len(papers) == 1
    assert papers[0]["id"] == "p_e2e_1"

    # Get by id.
    one = client.get("/api/v1/papers/p_e2e_1")
    assert one.status_code == 200
    assert one.json()["title"] == "End-to-end Paper"


def test_get_paper_pdf(client, project, tmp_path):
    """The /papers/{id}/pdf endpoint streams the imported PDF."""
    fake_pdf = tmp_path / "with_bytes.pdf"
    fake_pdf.write_bytes(b"%PDF-1.4 streaming test\n%%EOF")
    client.post(
        f"/api/v1/projects/{project['id']}/papers/import-local",
        json={
            "paper_id": "p_stream_1",
            "title": "Stream Test",
            "source_path": str(fake_pdf),
            "confirmed": True,
        },
    )
    resp = client.get("/api/v1/papers/p_stream_1/pdf")
    assert resp.status_code == 200
    assert resp.headers["content-type"] == "application/pdf"
    assert b"%PDF-1.4" in resp.content


def test_get_paper_pdf_404_when_not_downloaded(client, project):
    resp = client.get("/api/v1/papers/never_downloaded/pdf")
    assert resp.status_code == 404


def test_import_non_pdf_rejected(client, project, tmp_path):
    """import-local refuses a file that doesn't start with %PDF (C7)."""
    fake = tmp_path / "not_a_pdf.txt"
    fake.write_bytes(b"hello, this is a text file")
    resp = client.post(
        f"/api/v1/projects/{project['id']}/papers/import-local",
        json={
            "paper_id": "p_not_pdf",
            "title": "Not a PDF",
            "source_path": str(fake),
            "confirmed": True,
        },
    )
    assert resp.status_code == 400


def test_parse_paper_creates_extracted_text(client, project, tmp_path):
    """Parsing an imported PDF writes extracted_text.json + updates parse_status.

    We import a minimal valid PDF that PyMuPDF can open. The section detection
    may find nothing, but parse_status should flip to "success".
    """
    # Build a tiny valid PDF with PyMuPDF directly so the parser can open it.
    try:
        import fitz  # noqa: F401
    except ImportError:
        pytest.skip("PyMuPDF not available")

    fake_pdf = tmp_path / "valid.pdf"
    doc = fitz.open()  # new empty PDF
    page = doc.new_page()
    page.insert_text((72, 72), "1 Introduction\nThis is the intro.")
    doc.save(str(fake_pdf))
    doc.close()

    client.post(
        f"/api/v1/projects/{project['id']}/papers/import-local",
        json={
            "paper_id": "p_parse_1",
            "title": "Parseable Paper",
            "source_path": str(fake_pdf),
            "confirmed": True,
        },
    )
    resp = client.post("/api/v1/papers/p_parse_1/parse")
    assert resp.status_code == 200, resp.text
    body = resp.json()
    assert body["parse_status"] == "success"
    assert body["pages"] >= 1

    # The paper record should reflect the new status.
    paper = client.get("/api/v1/papers/p_parse_1").json()
    assert paper["parse_status"] == "success"


def test_download_paper_creates_paper_row(client, project):
    """A confirmed download with a safe-but-non-PDF URL still creates the
    Paper row when the URL fails. Verify the row exists after a failure so
    the user can retry without re-entering metadata.

    Actually, with H1's separate-session audit, the router rolls back the
    Paper row on failure. So we only assert the API returns 400 (the row
    is NOT persisted on failed download, which is the desired behavior).
    """
    resp = client.post(
        f"/api/v1/projects/{project['id']}/papers/download",
        json={
            "paper_id": "p_fail_dl",
            "title": "Will Fail",
            "pdf_url": "http://127.0.0.1:9999/nope.pdf",
            "confirmed": True,
        },
    )
    assert resp.status_code == 400
    # Paper row should not be persisted (router rollback).
    lst = client.get(f"/api/v1/projects/{project['id']}/papers").json()
    ids = [p["id"] for p in lst]
    assert "p_fail_dl" not in ids
