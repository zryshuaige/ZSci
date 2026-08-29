"""PDF download service (design.md §6.5, §9.2 literature.download_pdf).

- Downloads only after explicit user request (caller enforces approval).
- Saves into the project sandbox under literature/papers/<paper_id>/.
- Records sha256, metadata.json, paper.bib, and an audit-log entry.
- SSRF protection: client-controlled URLs are validated before fetch (C5).
- Error audits are written in a separate session so they survive the caller's
  rollback (H1).
"""
from __future__ import annotations

import hashlib
import json
import logging
from datetime import datetime, timezone
from pathlib import Path

import httpx
from sqlalchemy.orm import Session

from app.config import get_settings
from app.db.models import Paper, PaperFile
from app.pdf.bib import to_bibtex
from app.utils_net import UrlSafetyError, assert_safe_external_url
from app.workspace.manager import WorkspaceManager, audit
from app.workspace.sandbox import SandboxError

logger = logging.getLogger("zsci.pdf.download")


class DownloadError(RuntimeError):
    """Raised when a download/import fails. Carries audit info so the router
    can persist an error audit row AFTER rolling back its own transaction
    (H1): SQLite is single-writer, so writing the audit from inside the
    failed call would deadlock on the parent session's lock.
    """

    def __init__(self, message: str, *, audit_action: str | None = None, audit_target: str | None = None, audit_payload: dict | None = None) -> None:
        super().__init__(message)
        self.audit_action = audit_action
        self.audit_target = audit_target
        self.audit_payload = audit_payload


# Allowlist for `import_local_pdf` source paths (C7). Users may import PDFs
# from these well-known locations only; arbitrary filesystem paths are rejected
# to prevent server-side file probing.
def _local_import_allowed_roots() -> list[Path]:
    import os

    home = Path.home()
    roots = [
        (home / "Downloads").resolve(),
        (home / "Desktop").resolve(),
        (home / "Documents").resolve(),
    ]
    if os.name == "nt":
        # Windows: the user's temp tree (pytest tmp_path, browser downloads
        # in progress, etc. live under %LOCALAPPDATA%\Temp).
        roots.append(Path(os.environ.get("TEMP", home / "AppData" / "Local" / "Temp")).resolve())
    else:
        roots.append((Path("/tmp")).resolve())
        roots.append((Path("/var/folders")).resolve())
    return roots


def _is_within_allowed_source(path: Path) -> bool:
    """Return True if `path` is within one of the allowed import roots."""
    import os

    resolved = Path(os.path.normcase(str(path.resolve())))
    for root in _local_import_allowed_roots():
        try:
            resolved.relative_to(Path(os.path.normcase(str(root))))
            return True
        except ValueError:
            continue
    return False


def _sha256(data: bytes) -> str:
    return hashlib.sha256(data).hexdigest()


def _audit_failure_separately(
    *,
    action_type: str,
    project_id: str | None,
    target: str,
    payload: dict,
) -> None:
    """Write an error audit row in a SEPARATE session so it survives the
    caller's `db.rollback()` (H1). Must be called AFTER the caller has rolled
    back its own transaction, otherwise SQLite's single-writer lock blocks.
    """
    from sqlalchemy.orm import Session as _Session

    from app.db.session import get_engine

    try:
        with _Session(get_engine()) as session:
            audit(
                session,
                action_type=action_type,
                project_id=project_id,
                target=target,
                payload=payload,
                status="error",
            )
            session.commit()
    except Exception:  # noqa: BLE001
        logger.exception("failed to persist error audit row")


async def download_paper_pdf(
    db: Session,
    ws: WorkspaceManager,
    *,
    paper: Paper,
    project_slug: str,
) -> Path:
    """Download the PDF for `paper` into the project sandbox."""
    if not paper.pdf_url:
        raise DownloadError(
            "Paper has no pdf_url to download.",
            audit_action="paper.download_pdf",
            audit_target="",
            audit_payload={"paper_id": paper.id, "error": "no pdf_url"},
        )

    # SSRF protection (C5): validate scheme + resolved IP before any fetch.
    try:
        assert_safe_external_url(paper.pdf_url)
    except UrlSafetyError as exc:
        # H1: don't write the audit here; the router will rollback first and
        # then persist it via the error info attached to the exception.
        raise DownloadError(
            f"URL rejected for safety: {exc}",
            audit_action="paper.download_pdf",
            audit_target=paper.pdf_url,
            audit_payload={"paper_id": paper.id, "error": str(exc)},
        ) from exc

    settings = get_settings()
    try:
        async with httpx.AsyncClient(
            timeout=settings.academic_api_timeout,
            follow_redirects=True,
            headers={"User-Agent": "zsci/0.1 (research-agent)"},
        ) as client:
            resp = await client.get(paper.pdf_url)
            resp.raise_for_status()
            content = resp.content
    except httpx.HTTPError as exc:
        logger.warning("PDF download failed for %s: %s", paper.id, exc)
        raise DownloadError(
            f"Failed to download PDF: {exc}",
            audit_action="paper.download_pdf",
            audit_target=paper.pdf_url,
            audit_payload={"paper_id": paper.id, "error": str(exc)},
        ) from exc

    if not content.startswith(b"%PDF"):
        raise DownloadError(
            "Downloaded content is not a valid PDF "
            "(possibly an HTML landing page). The source URL may require a browser.",
            audit_action="paper.download_pdf",
            audit_target=paper.pdf_url,
            audit_payload={"paper_id": paper.id, "error": "not a PDF (bad magic bytes)"},
        )

    pdir = ws.paper_dir(project_slug, paper.id)
    pdf_path = pdir / "paper.pdf"
    try:
        pdf_path = ws.safe_write(project_slug, pdf_path, content)
    except SandboxError as exc:
        raise DownloadError(str(exc)) from exc

    sha = _sha256(content)
    paper.local_pdf_path = str(pdf_path.relative_to(get_settings().projects_root))
    paper.downloaded = True
    paper.parse_status = "pending"

    # metadata.json
    metadata = {
        "paper_id": paper.id,
        "title": paper.title,
        "doi": paper.doi,
        "arxiv_id": paper.arxiv_id,
        "venue": paper.venue,
        "year": paper.year,
        "pdf_url": paper.pdf_url,
        "source": paper.source,
        "sha256": sha,
        "file_size": len(content),
        "downloaded_at": datetime.now(timezone.utc).isoformat(),
    }
    ws.safe_write(project_slug, pdir / "metadata.json", json.dumps(metadata, ensure_ascii=False, indent=2).encode("utf-8"))

    # paper.bib
    ws.safe_write(project_slug, pdir / "paper.bib", to_bibtex(paper).encode("utf-8"))

    # annotations.json stub
    ws.safe_write(project_slug, pdir / "annotations.json", b"[]")

    # Sync the bibtex entry into the writing project's references.bib so
    # latexmk can actually resolve the citation keys the writing agent uses
    # (M23: previously references.bib was empty and compile failed).
    _append_to_references_bib(project_slug, paper)

    # paper_files record. Upsert by the deterministic PK `pf_<paper_id>` so a
    # re-download refreshes sha256/size/path (previously the existing row kept
    # the OLD sha256, flagging the freshly-written file as a tamper mismatch),
    # and a concurrent double-download doesn't raise IntegrityError -> 500.
    rel = str(pdf_path.relative_to(get_settings().projects_root))
    existing = db.query(PaperFile).filter_by(paper_id=paper.id, file_type="pdf").first()
    if existing is None:
        from sqlalchemy.exc import IntegrityError

        try:
            with db.begin_nested():
                db.add(
                    PaperFile(
                        id=f"pf_{paper.id}",
                        paper_id=paper.id,
                        file_type="pdf",
                        relative_path=rel,
                        sha256=sha,
                        file_size=len(content),
                    )
                )
        except IntegrityError:
            existing = db.query(PaperFile).filter_by(paper_id=paper.id, file_type="pdf").first()
    if existing is not None:
        existing.relative_path = rel
        existing.sha256 = sha
        existing.file_size = len(content)

    audit(
        db,
        action_type="paper.download_pdf",
        project_id=paper.project_id,
        target=str(pdf_path),
        payload={"paper_id": paper.id, "sha256": sha, "bytes": len(content)},
    )
    db.flush()
    return pdf_path


def _append_to_references_bib(project_slug: str, paper: Paper) -> None:
    """Append the paper's bibtex entry to writing/paper/references.bib.

    Idempotent: skips if the cite_key is already present (M23). The
    read-check-write is guarded by an exclusive file lock so concurrent
    downloads (e.g. multiple workers) don't clobber each other's entry.
    """
    from app.pdf.bib import _cite_key
    from app.utils import exclusive_file_lock

    settings = get_settings()
    writing_root = settings.projects_root / project_slug / "writing" / "paper"
    # Only sync if the writing project has been initialized.
    if not writing_root.exists():
        return
    bib_path = writing_root / "references.bib"
    lock_path = writing_root / ".references.bib.lock"
    cite_key = _cite_key(paper)
    entry = to_bibtex(paper)
    with open(lock_path, "w", encoding="utf-8") as lockf:
        with exclusive_file_lock(lockf):
            existing = ""
            if bib_path.exists():
                existing = bib_path.read_text(encoding="utf-8", errors="replace")
            # Check whether the entry is already present by looking for the
            # cite_key token at the start of an entry: e.g. `@inproceedings{KEY,`.
            if cite_key and f"{{{cite_key}," in existing:
                return  # already present
            new_content = (existing.rstrip() + "\n\n" + entry) if existing.strip() else entry
            bib_path.write_text(new_content, encoding="utf-8")


async def import_local_pdf(
    db: Session,
    ws: WorkspaceManager,
    *,
    paper: Paper,
    project_slug: str,
    source_path: Path,
) -> Path:
    """Import a user-supplied local PDF by copying it into the sandbox.

    Security (C7): `source_path` must be within an allowlisted root (~/Downloads,
    ~/Desktop, ~/Documents, /tmp, /var/folders) so the endpoint can't be used to
    probe arbitrary server files (e.g. ~/.ssh/id_rsa).
    """
    # C7: reject paths outside the allowlist.
    if not _is_within_allowed_source(source_path):
        raise DownloadError(
            f"Source path '{source_path}' is outside the allowed import roots "
            "(~/Downloads, ~/Desktop, ~/Documents, /tmp, /var/folders).",
            audit_action="paper.import_local_pdf",
            audit_target=str(source_path),
            audit_payload={"paper_id": paper.id, "error": "source path outside allowlist"},
        )
    if not source_path.exists():
        raise DownloadError(
            f"Source PDF not found: {source_path}",
            audit_action="paper.import_local_pdf",
            audit_target=str(source_path),
            audit_payload={"paper_id": paper.id, "error": "source not found"},
        )
    content = source_path.read_bytes()
    if not content.startswith(b"%PDF"):
        raise DownloadError(
            "Selected file is not a valid PDF.",
            audit_action="paper.import_local_pdf",
            audit_target=str(source_path),
            audit_payload={"paper_id": paper.id, "error": "not a PDF (bad magic bytes)"},
        )

    pdir = ws.paper_dir(project_slug, paper.id)
    pdf_path = pdir / "paper.pdf"
    pdf_path = ws.safe_write(project_slug, pdf_path, content)

    sha = _sha256(content)
    paper.local_pdf_path = str(pdf_path.relative_to(get_settings().projects_root))
    paper.downloaded = True
    paper.parse_status = "pending"
    paper.pdf_url = paper.pdf_url or f"file://{source_path.name}"

    # M26: don't leak absolute filesystem paths in metadata; store basename only.
    metadata = {
        "paper_id": paper.id,
        "title": paper.title,
        "sha256": sha,
        "file_size": len(content),
        "imported_from": source_path.name,
        "imported_at": datetime.now(timezone.utc).isoformat(),
    }
    ws.safe_write(project_slug, pdir / "metadata.json", json.dumps(metadata, ensure_ascii=False, indent=2).encode("utf-8"))
    ws.safe_write(project_slug, pdir / "paper.bib", to_bibtex(paper).encode("utf-8"))
    ws.safe_write(project_slug, pdir / "annotations.json", b"[]")

    # Keep references.bib in sync (same as download_paper_pdf).
    _append_to_references_bib(project_slug, paper)

    audit(
        db,
        action_type="paper.import_local_pdf",
        project_id=paper.project_id,
        target=str(pdf_path),
        payload={"paper_id": paper.id, "imported_from": source_path.name},
    )
    db.flush()
    return pdf_path
