"""PDF parsing with PyMuPDF (design.md §9.3 pdf.parse).

Extracts page-level text, heuristically detects sections, and pulls embedded
images into figures/. Writes extracted_text.json. Updates parse_status.
"""
from __future__ import annotations

import json
import logging
import re
from pathlib import Path

from sqlalchemy.orm import Session

from app.config import get_settings
from app.db.models import Paper
from app.workspace.manager import WorkspaceManager, audit
from app.workspace.sandbox import assert_within_project

logger = logging.getLogger("zsci.pdf.parse")

# Heuristic section headers common in CS papers. The numeric prefix is OPTIONAL
# so unnumbered headers like "Abstract" / "References" are also detected (L15).
SECTION_RE = re.compile(
    r"^\s*(?:\d+\.?\d*\s+)?("
    r"abstract|introduction|related work|background|preliminaries|method|methods|"
    r"approach|methodology|model|experiments|experimental setup|results|"
    r"evaluation|discussion|conclusion|conclusions|references|acknowledg"
    r")\s*$",
    re.IGNORECASE,
)


class ParseError(RuntimeError):
    pass


def _resolve_pdf_path(paper: Paper) -> Path:
    settings = get_settings()
    if not paper.local_pdf_path:
        raise ParseError("Paper has no local PDF.")
    return (settings.projects_root / paper.local_pdf_path).resolve()


def parse_pdf(
    db: Session,
    ws: WorkspaceManager,
    *,
    paper: Paper,
    project_slug: str,
) -> dict:
    """Parse the paper's local PDF. Returns a summary dict (design.md §9.3)."""
    pdf_path = _resolve_pdf_path(paper)
    assert_within_project(project_slug, pdf_path)

    pdir = pdf_path.parent
    figures_dir = pdir / "figures"

    # H12: use a context manager so the doc is always closed even if extraction
    # raises. Previously, an exception between `fitz.open` and `doc.close()`
    # leaked file descriptors and memory-mapped pages.
    try:
        import fitz  # PyMuPDF (inside try so a missing dep -> ParseError, not a 500)

        with fitz.open(pdf_path) as doc:
            pages: list[dict] = []
            sections: list[dict] = []
            current_section: dict | None = None

            for i, page in enumerate(doc, start=1):
                text = page.get_text("text") or ""
                pages.append({"page": i, "text": text})

                # Section header detection (first non-empty lines).
                for line in text.splitlines():
                    stripped = line.strip()
                    if not stripped:
                        continue
                    if SECTION_RE.match(stripped):
                        if current_section:
                            # M1: page_end should be the current page (the page
                            # the new header was found on), not i-1 which could
                            # be less than current_section["page_start"] when
                            # two headers share a page.
                            current_section["page_end"] = i
                            sections.append(current_section)
                        current_section = {
                            "title": stripped,
                            "page_start": i,
                            "page_end": i,
                        }
                    break  # only inspect the first non-empty line per page

                # Extract images on the page.
                for img_index, img in enumerate(page.get_images(full=True)):
                    pix = None
                    try:
                        xref = img[0]
                        pix = fitz.Pixmap(doc, xref)
                        if pix.n - pix.alpha >= 4:  # CMYK -> RGB
                            rgb = fitz.Pixmap(fitz.csRGB, pix)
                            pix.close()
                            pix = rgb
                        fig_path = figures_dir / f"page{i:03d}_img{img_index:02d}.png"
                        fig_path.parent.mkdir(parents=True, exist_ok=True)
                        pix.save(fig_path)
                    except Exception:  # noqa: BLE001
                        logger.debug("Failed to extract image %s on page %s", img_index, i)
                    finally:
                        # Explicit close releases the mmap'd image buffer now
                        # instead of queuing for GC; matters on image-heavy PDFs.
                        if pix is not None:
                            try:
                                pix.close()
                            except Exception:  # noqa: BLE001
                                pass

            if current_section:
                current_section["page_end"] = len(doc)
                sections.append(current_section)

            total_pages = len(doc)
    except Exception as exc:  # noqa: BLE001
        # L28: set error status before raising so the UI doesn't stay "pending".
        paper.parse_status = "error"
        db.flush()
        raise ParseError(f"Cannot open/parse PDF: {exc}") from exc

    extracted = {
        "paper_id": paper.id,
        "pages": total_pages,
        "page_texts": pages,
        "sections": sections,
        "parse_status": "success",
    }
    try:
        ws.safe_write(
            project_slug,
            pdir / "extracted_text.json",
            json.dumps(extracted, ensure_ascii=False, indent=2).encode("utf-8"),
        )
    except Exception as exc:  # noqa: BLE001
        paper.parse_status = "error"
        db.flush()
        raise ParseError(f"Failed to write extracted_text.json: {exc}") from exc

    paper.parse_status = "success"
    audit(
        db,
        action_type="paper.parse",
        project_id=paper.project_id,
        target=str(pdf_path),
        payload={"paper_id": paper.id, "pages": total_pages, "sections": len(sections)},
    )
    db.flush()
    return {"paper_id": paper.id, "pages": total_pages, "parse_status": "success", "sections": sections}


def load_extracted_text(paper: Paper) -> dict | None:
    """Read previously-extracted text for a paper, if present."""
    if not paper.local_pdf_path:
        return None
    pdf_path = _resolve_pdf_path(paper)
    extracted = pdf_path.parent / "extracted_text.json"
    if not extracted.exists():
        return None
    try:
        return json.loads(extracted.read_text(encoding="utf-8"))
    except (ValueError, OSError):
        return None


def page_text(paper: Paper, page_number: int) -> str | None:
    """Convenience: get text for a single page."""
    data = load_extracted_text(paper)
    if not data:
        return None
    for p in data.get("page_texts", []):
        if p.get("page") == page_number:
            return p.get("text")
    return None
