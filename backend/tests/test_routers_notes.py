"""Integration tests for the notes router: translation deletion (issue 2).

The translate endpoint needs an LLM, so translations are seeded straight into
the DB via the app's session factory (same engine the TestClient uses), then
exercised through the public DELETE route.
"""
from __future__ import annotations


def _seed_translation(paper_id: str, *, kind: str = "translation") -> str:
    """Insert a ReadingNote row directly and return its id."""
    from app.db.models import ReadingNote
    from app.db.session import get_sessionmaker

    session = get_sessionmaker()()
    try:
        note = ReadingNote(
            id=f"rn_{kind}_{paper_id}",
            paper_id=paper_id,
            kind=kind,
            page=1,
            original_text="hello",
            content="你好",
            model="test-model",
        )
        session.add(note)
        session.commit()
        return note.id
    finally:
        session.close()


def _import_paper(client, project, tmp_path, paper_id="p_notes_1"):
    fake_pdf = tmp_path / "p.pdf"
    fake_pdf.write_bytes(b"%PDF-1.4 notes test\n%%EOF")
    resp = client.post(
        f"/api/v1/projects/{project['id']}/papers/import-local",
        json={
            "paper_id": paper_id,
            "title": "Notes Paper",
            "source_path": str(fake_pdf),
            "confirmed": True,
        },
    )
    assert resp.status_code == 200, resp.text
    return paper_id


def test_delete_translation_removes_it(client, project, tmp_path):
    paper_id = _import_paper(client, project, tmp_path)
    tid = _seed_translation(paper_id)

    # It shows up in the list.
    lst = client.get(f"/api/v1/papers/{paper_id}/translations")
    assert lst.status_code == 200
    assert any(t["id"] == tid for t in lst.json())

    # Delete it.
    resp = client.delete(f"/api/v1/translations/{tid}")
    assert resp.status_code == 204

    # Gone from the list.
    lst2 = client.get(f"/api/v1/papers/{paper_id}/translations")
    assert all(t["id"] != tid for t in lst2.json())


def test_delete_translation_404(client):
    resp = client.delete("/api/v1/translations/does_not_exist")
    assert resp.status_code == 404


def test_delete_translation_rejects_reading_note(client, project, tmp_path):
    """A DELETE on a kind=note row must not clobber a real reading note."""
    paper_id = _import_paper(client, project, tmp_path)
    note_id = _seed_translation(paper_id, kind="note")

    resp = client.delete(f"/api/v1/translations/{note_id}")
    assert resp.status_code == 400

    # The reading note survives.
    from app.db.models import ReadingNote
    from app.db.session import get_sessionmaker

    session = get_sessionmaker()()
    try:
        assert session.get(ReadingNote, note_id) is not None
    finally:
        session.close()
