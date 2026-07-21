"""LaTeX project init + compile + citation verification (design.md §13.6, §17.4).

Compile uses latexmk if available; gracefully degrades (clear message) if no TeX
distribution is installed - same pattern as the LLM gateway.
"""
from __future__ import annotations

import re
import shutil
import subprocess
from pathlib import Path

from sqlalchemy import select
from sqlalchemy.orm import Session

from app.db.models import Paper
from app.workspace.sandbox import project_dir

MAIN_TEX = r"""\documentclass[10pt]{article}
\usepackage[utf8]{inputenc}
\usepackage{graphicx}
\usepackage{hyperref}
\usepackage{booktabs}
\usepackage{amsmath}

\title{TITLE_PLACEHOLDER}
\author{Your Name}
\date{\today}

\begin{document}
\maketitle

\begin{abstract}
Abstract placeholder.
\end{abstract}

\input{sections/introduction}
\input{sections/related_work}
\input{sections/method}
\input{sections/experiments}
\input{sections/conclusion}

\bibliographystyle{plain}
\bibliography{references}

\end{document}
"""

# ---------------------------------------------------------------------------
# Journal / conference templates (IEEE, Elsevier). The .cls files ship with any
# full TeX distribution (MacTeX / TeX Live), so we don't vendor them - if TeX
# is missing the compile button degrades gracefully, and the source is still
# editable. Each template has its own bib style + frontmatter conventions.
# ---------------------------------------------------------------------------

IEEE_TEX = r"""\documentclass[conference]{IEEEtran}
\usepackage{cite}
\usepackage{amsmath,amssymb,amsfonts}
\usepackage{algorithmic}
\usepackage{graphicx}
\usepackage{textcomp}
\usepackage{xcolor}
\usepackage{hyperref}

\def\BibTeX{{\rm B\kern-.05em{\sc i\kern-.025em b}\kern-.08em T\kern-.1667em\lower.7ex\hbox{E}\kern-.125emX}}

\title{TITLE_PLACEHOLDER}
\author{
  \IEEEauthorblockN{Your Name}
  \IEEEauthorblockA{\textit{Your Affiliation} \\
  Your City, Country \\
  your.email@example.com}
}

\begin{document}
\maketitle

\begin{abstract}
Abstract placeholder.
\end{abstract}

\begin{IEEEkeywords}
keyword one, keyword two, keyword three
\end{IEEEkeywords}

\input{sections/introduction}
\input{sections/related_work}
\input{sections/method}
\input{sections/experiments}
\input{sections/conclusion}

\bibliographystyle{IEEEtran}
\bibliography{references}

\end{document}
"""

ELSEVIER_TEX = r"""\documentclass[review,3p]{elsarticle}
\usepackage{lineno}
\usepackage{graphicx}
\usepackage{amsmath}
\usepackage{hyperref}

\journal{Journal Name}

\begin{frontmatter}
\title{TITLE_PLACEHOLDER}
\author[a]{Your Name}
\affiliation[a]{organization={Your Affiliation},addressline={Your Address},city={Your City},country={Country}}

\begin{abstract}
Abstract placeholder.
\end{abstract}

\begin{keyword}
keyword one \sep keyword two \sep keyword three
\end{keyword}
\end{frontmatter}

\linenumbers

\input{sections/introduction}
\input{sections/related_work}
\input{sections/method}
\input{sections/experiments}
\input{sections/conclusion}

\bibliographystyle{elsarticle-num}
\bibliography{references}

\end{document}
"""

#: Available writing templates: main.tex source + bib style + human label + note.
TEMPLATES: dict[str, dict] = {
    "generic": {
        "tex": MAIN_TEX,
        "label": "通用 article",
        "note": "标准 article 文档类，适合草稿与通用排版。",
    },
    "ieee": {
        "tex": IEEE_TEX,
        "label": "IEEE (IEEEtran)",
        "note": "IEEE 会议/期刊格式，需 IEEEtran.cls（随 TeX 发行版安装）。",
    },
    "elsevier": {
        "tex": ELSEVIER_TEX,
        "label": "Elsevier (elsarticle)",
        "note": "Elsevier 期刊格式，需 elsarticle.cls（随 TeX 发行版安装）。",
    },
}

REFERENCES_BIB = """\
% References bibliography. Z-Sci inserts entries here when you download papers.
"""


def init_writing_project(project_slug: str, title: str, template: str = "generic", *, force: bool = False) -> Path:
    r"""Create the LaTeX project skeleton under writing/paper/.

    `template` selects the document class layout (generic / ieee / elsevier).
    Unknown templates fall back to generic so a bad request never 400s the init.

    `force=True` overwrites an existing main.tex with the new template's
    preamble (document class + frontmatter), so users can switch templates
    after the first init. Section files and references.bib are ALWAYS preserved
    — only main.tex is rewritten, because that's where the template choice
    lives (\documentclass, \usepackage, title/author block, bib style).
    """
    tpl = TEMPLATES.get(template, TEMPLATES["generic"])
    root = project_dir(project_slug) / "writing" / "paper"
    (root / "sections").mkdir(parents=True, exist_ok=True)
    (root / "figures").mkdir(exist_ok=True)
    (root / "tables").mkdir(exist_ok=True)
    (root / "output").mkdir(exist_ok=True)
    main = root / "main.tex"
    # Write main.tex when (a) it doesn't exist yet, or (b) the caller asked to
    # force a template switch. We always preserve sections/*.tex and
    # references.bib so switching templates never loses user-written content.
    if force or not main.exists():
        main.write_text(
            tpl["tex"].replace("TITLE_PLACEHOLDER", title.replace("&", "\\&")),
            encoding="utf-8",
        )
    bib = root / "references.bib"
    if not bib.exists():
        bib.write_text(REFERENCES_BIB, encoding="utf-8")
    for sec in ("introduction", "related_work", "method", "experiments", "conclusion"):
        p = root / "sections" / f"{sec}.tex"
        if not p.exists():
            p.write_text(f"\\section{{{sec.replace('_', ' ').title()}}}\n% TODO\n", encoding="utf-8")
    # Leave a note about which template was used + its requirements, so users
    # know what to install if compile fails.
    note = root / "TEMPLATE.md"
    if not note.exists():
        note.write_text(
            f"# 模板：{tpl['label']}\n\n{tpl['note']}\n\n"
            "编译：点击页面「编译 PDF」（调用 latexmk）。未安装 TeX 时仍可编辑源文件。\n",
            encoding="utf-8",
        )
    return root


def writing_root(project_slug: str) -> Path:
    return project_dir(project_slug) / "writing" / "paper"


def has_latex() -> bool:
    """True if latexmk is on PATH. compile_latex invokes latexmk specifically
    (L20): previously returned True if only pdflatex existed, which then crashed
    inside compile_latex with an uncaught FileNotFoundError.
    """
    return shutil.which("latexmk") is not None


def compile_latex(project_slug: str) -> dict:
    """Compile main.tex -> PDF. Returns {ok, pdf_path, log, error}."""
    root = writing_root(project_slug)
    main = root / "main.tex"
    if not main.exists():
        return {"ok": False, "error": "main.tex not found; init the writing project first."}
    if not has_latex():
        return {
            "ok": False,
            "error": (
                "No LaTeX distribution found (latexmk). Install MacTeX/TeX Live "
                "to compile. On macOS: brew install --cask mactex. The LaTeX source is still "
                "editable and saved on disk."
            ),
        }
    out_dir = root / "output"
    out_dir.mkdir(exist_ok=True)
    cmd = ["latexmk", "-pdf", "-interaction=nonstopmode", "-output-directory=" + str(out_dir), str(main)]
    try:
        # L19: start a new session so we can kill the whole process group on
        # timeout (latexmk spawns pdflatex/bibtex/makeindex as children).
        proc = subprocess.run(
            cmd,
            cwd=str(root),
            capture_output=True,
            text=True,
            timeout=120,
            start_new_session=True,
        )
    except subprocess.TimeoutExpired:
        # Kill any orphaned children that still hold locks on output/main.pdf.
        import os
        import signal

        try:
            os.killpg(os.getpgid(proc.pid if hasattr(proc, "pid") else 0), signal.SIGTERM)  # type: ignore[arg-type]
        except (ProcessLookupError, PermissionError, OSError):
            pass
        return {"ok": False, "error": "Compilation timed out (>120s)."}
    log = proc.stdout + "\n" + proc.stderr
    pdf = out_dir / "main.pdf"
    if proc.returncode == 0 and pdf.exists():
        return {"ok": True, "pdf_path": str(pdf), "log": log[-4000:]}
    return {"ok": False, "error": "Compilation failed.", "log": log[-4000:]}


# ---------------------------------------------------------------------------
# Citation verification (design.md §17.4)
# ---------------------------------------------------------------------------

CITE_RE = re.compile(r"\\(?:cite|citep|citet|citeauthor)\{([^}]+)\}")


def available_citation_keys(db: Session, project_id: str) -> list[dict]:
    """Return [{key, paper_id, title}] for all downloaded papers' BibTeX keys."""
    from app.pdf.bib import _cite_key

    papers = db.scalars(
        select(Paper).where(Paper.project_id == project_id, Paper.downloaded.is_(True))
    ).all()
    out = []
    for p in papers:
        out.append({"key": _cite_key(p), "paper_id": p.id, "title": p.title})
    return out


def verify_citations(db: Session, project_id: str, project_slug: str) -> dict:
    """Scan main.tex + sections for \\cite{...} and check keys exist. design.md §17.4."""
    root = writing_root(project_slug)
    available = {c["key"] for c in available_citation_keys(db, project_id)}
    used: dict[str, list[str]] = {}
    # M21: rglob so nested section files (e.g. sections/related_work/old.tex)
    # are scanned too; previously glob("*.tex") missed one level down.
    files = [root / "main.tex"] + list((root / "sections").rglob("*.tex"))
    for f in files:
        if not f.exists():
            continue
        text = f.read_text(encoding="utf-8", errors="replace")
        for m in CITE_RE.finditer(text):
            for key in m.group(1).split(","):
                key = key.strip()
                if key:
                    used.setdefault(key, []).append(f.name)
    missing = sorted(k for k in used if k not in available)
    undefined_in_bib = missing  # keys used but no matching downloaded paper
    return {
        "available_keys": sorted(available),
        "used_keys": sorted(used.keys()),
        "used_in": {k: sorted(set(v)) for k, v in used.items()},
        "missing": undefined_in_bib,
        "ok": len(undefined_in_bib) == 0,
    }


def read_tex_file(project_slug: str, rel_path: str) -> str | None:
    root = writing_root(project_slug)
    target = (root / rel_path).resolve()
    try:
        target.relative_to(root.resolve())
    except ValueError:
        return None
    if not target.exists() or not target.is_file():
        return None
    return target.read_text(encoding="utf-8", errors="replace")


def write_tex_file(project_slug: str, rel_path: str, content: str) -> bool:
    root = writing_root(project_slug)
    target = (root / rel_path).resolve()
    try:
        target.relative_to(root.resolve())
    except ValueError:
        return False
    target.parent.mkdir(parents=True, exist_ok=True)
    target.write_text(content, encoding="utf-8")
    return True


def list_tex_files(project_slug: str) -> list[str]:
    root = writing_root(project_slug)
    if not root.exists():
        return []
    files: list[str] = []
    for p in sorted(root.rglob("*.tex")):
        files.append(str(p.relative_to(root)))
    for p in sorted(root.glob("*.bib")):
        files.append(str(p.relative_to(root)))
    return files


def available_templates() -> list[dict]:
    """Template metadata for the writing-page template picker."""
    return [
        {"key": k, "label": v["label"], "note": v["note"]}
        for k, v in TEMPLATES.items()
    ]
