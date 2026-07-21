"""Writing / citation verification tests (design.md §17.4)."""
from __future__ import annotations

import json

from app.db.models import Paper, Project
from app.utils import new_id
from app.writing.latex import CITE_RE, init_writing_project, verify_citations


def test_cite_regex():
    text = r"as shown in \cite{smith2024abc} and \citep{jones2023x,doe2024y}"
    matches = CITE_RE.findall(text)
    assert matches == ["smith2024abc", "jones2023x,doe2024y"]


def test_init_writing_project(db_session, isolated_workspace):
    project = Project(
        id=new_id("prj"), name="Write Test", slug="write-test",
        root_path=str(isolated_workspace / "projects" / "write-test"),
    )
    db_session.add(project)
    db_session.flush()
    root = init_writing_project("write-test", "Write Test")
    assert (root / "main.tex").exists()
    assert (root / "references.bib").exists()
    assert (root / "sections" / "introduction.tex").exists()
    assert "\\title{Write Test}" in (root / "main.tex").read_text()


def test_verify_citations_flags_missing(db_session, isolated_workspace):
    r"""A \cite{unknown} with no matching downloaded paper -> missing."""
    project = Project(
        id=new_id("prj"), name="W", slug="w-cite",
        root_path=str(isolated_workspace / "projects" / "w-cite"),
    )
    db_session.add(project)
    db_session.flush()

    # one downloaded paper -> available key
    paper = Paper(
        id="paper_0001", project_id=project.id, title="Real Paper",
        authors_json=json.dumps(["Alice Smith"]), year=2024, downloaded=True,
    )
    db_session.add(paper)
    db_session.flush()

    root = init_writing_project("w-cite", "W")
    (root / "sections" / "related_work.tex").write_text(
        r"\cite{smith2024realpaper} and \cite{totally_unknown_key}", encoding="utf-8"
    )

    result = verify_citations(db_session, project.id, "w-cite")
    assert "smith2024realpaper" in result["available_keys"]
    assert "totally_unknown_key" in result["missing"]
    assert result["ok"] is False


def test_verify_citations_ok_when_all_known(db_session, isolated_workspace):
    project = Project(
        id=new_id("prj"), name="W2", slug="w-ok",
        root_path=str(isolated_workspace / "projects" / "w-ok"),
    )
    db_session.add(project)
    db_session.flush()
    paper = Paper(
        id="paper_0001", project_id=project.id, title="Real Paper",
        authors_json=json.dumps(["Alice Smith"]), year=2024, downloaded=True,
    )
    db_session.add(paper)
    db_session.flush()
    root = init_writing_project("w-ok", "W2")
    (root / "sections" / "introduction.tex").write_text(
        r"\citep{smith2024realpaper}", encoding="utf-8"
    )
    result = verify_citations(db_session, project.id, "w-ok")
    assert result["ok"] is True
    assert result["missing"] == []


def test_switch_template_overwrites_main_but_preserves_sections(isolated_workspace):
    """force=True rewrites main.tex with the new template but leaves section
    content and references.bib intact, so switching templates never loses what
    the user wrote. Regression for the "first template is permanent" bug."""
    project = Project(
        id=new_id("prj"), name="Tpl", slug="tpl-switch",
        root_path=str(isolated_workspace / "projects" / "tpl-switch"),
    )
    root = init_writing_project("tpl-switch", "Tpl", template="generic")
    # User writes real content into a section + bib.
    (root / "sections" / "introduction.tex").write_text(
        r"\section{Introduction}" "\nMy real intro content.\n", encoding="utf-8"
    )
    (root / "references.bib").write_text("@article{mine2024, ...}\n", encoding="utf-8")
    assert r"\documentclass[10pt]{article}" in (root / "main.tex").read_text()

    # Without force, re-init is a no-op: main.tex keeps the generic class.
    init_writing_project("tpl-switch", "Tpl", template="ieee")
    assert r"\documentclass[10pt]{article}" in (root / "main.tex").read_text()

    # With force=True, main.tex switches to IEEE, but the section + bib survive.
    init_writing_project("tpl-switch", "Tpl", template="ieee", force=True)
    main = (root / "main.tex").read_text()
    assert "IEEEtran" in main
    assert "My real intro content." in (root / "sections" / "introduction.tex").read_text()
    assert "@article{mine2024" in (root / "references.bib").read_text()
