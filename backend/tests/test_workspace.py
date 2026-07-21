"""Project creation + workspace manager tests (design.md §5.2, §9.1)."""
from __future__ import annotations

from app.utils import slugify
from app.workspace.manager import WorkspaceManager, audit


def test_slugify():
    assert slugify("VLM Efficient Fine-tuning!") == "vlm-efficient-fine-tuning"
    assert slugify("  多模态  研究方向 ")  # non-empty, returns something safe
    assert slugify("") == "project"


def test_create_project_tree(db_session, isolated_workspace):
    ws = WorkspaceManager()
    root = ws.create_project(
        db_session,
        project_id="prj_test1",
        name="Test Project",
        slug="test-project",
        research_direction="test direction",
    )
    assert (root / "project.yaml").exists()
    assert (root / "README.md").exists()
    assert (root / ".gitignore").exists()
    assert (root / "literature" / "papers").is_dir()
    assert (root / "experiments" / "templates").is_dir()
    assert (root / "writing" / "paper" / "sections").is_dir()

    yaml_text = (root / "project.yaml").read_text(encoding="utf-8")
    assert "prj_test1" in yaml_text
    assert "test direction" in yaml_text

    # Audit log row written.
    from app.db.models import AuditLog
    rows = db_session.query(AuditLog).all()
    assert any(r.action_type == "project.create" for r in rows)


def test_paper_dir_is_sandboxed(db_session, isolated_workspace):
    ws = WorkspaceManager()
    ws.create_project(
        db_session, project_id="prj_t2", name="T2", slug="t2", research_direction="d"
    )
    pdir = ws.paper_dir("t2", "paper_0001")
    assert pdir.name == "paper_0001"
    assert pdir.parent.name == "papers"
    assert "figures" in {p.name for p in pdir.iterdir()}


def test_safe_write_escapes_rejected(db_session, isolated_workspace, tmp_path):
    ws = WorkspaceManager()
    ws.create_project(
        db_session, project_id="prj_t3", name="T3", slug="t3", research_direction="d"
    )
    from app.workspace.sandbox import SandboxError

    outside = tmp_path / "escape.pdf"
    outside.write_bytes(b"%PDF-1.4")
    with __import__("pytest").raises(SandboxError):
        ws.safe_write("t3", outside, b"x")
