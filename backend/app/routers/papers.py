"""Papers router: list/get, download, import-local, PDF stream, parse.

design.md §15.2. Download requires `confirmed=True` (the frontend shows an
approval dialog and only then posts with confirmed=True). design.md §16.1.
"""
from __future__ import annotations

import json
from pathlib import Path

from fastapi import APIRouter, Depends, HTTPException
from fastapi.responses import FileResponse
from sqlalchemy import select
from sqlalchemy.orm import Session

from app.config import get_settings
from app.db.models import Paper, Project
from app.db.session import get_db
from app.pdf.download import DownloadError, download_paper_pdf, import_local_pdf
from app.pdf.parse import ParseError, parse_pdf
from app.schemas import (
    DownloadPaperRequest,
    ImportLocalPdfRequest,
    PaperOut,
    ParseResponse,
)
from app.workspace.manager import WorkspaceManager
from app.workspace.sandbox import assert_within_project

router = APIRouter(tags=["papers"])
_ws = WorkspaceManager()


def _to_out(p: Paper) -> PaperOut:
    authors: list[str] = []
    if p.authors_json:
        try:
            authors = json.loads(p.authors_json)
        except ValueError:
            authors = []
    return PaperOut(
        id=p.id,
        project_id=p.project_id,
        title=p.title,
        abstract=p.abstract,
        authors=authors,
        year=p.year,
        venue=p.venue,
        venue_verified=p.venue_verified,
        doi=p.doi,
        arxiv_id=p.arxiv_id,
        pdf_url=p.pdf_url,
        source_url=p.source_url,
        local_pdf_path=p.local_pdf_path,
        downloaded=p.downloaded,
        parse_status=p.parse_status,
        source=p.source,
        created_at=p.created_at,
        updated_at=p.updated_at,
    )


@router.get("/api/v1/projects/{project_id}/papers", response_model=list[PaperOut])
def list_papers(project_id: str, db: Session = Depends(get_db)) -> list[PaperOut]:
    rows = db.scalars(
        select(Paper).where(Paper.project_id == project_id).order_by(Paper.created_at.desc())
    ).all()
    return [_to_out(p) for p in rows]


@router.get("/api/v1/papers/{paper_id}", response_model=PaperOut)
def get_paper(paper_id: str, db: Session = Depends(get_db)) -> PaperOut:
    p = db.get(Paper, paper_id)
    if p is None:
        raise HTTPException(404, "Paper not found")
    return _to_out(p)


@router.post("/api/v1/projects/{project_id}/papers/download", response_model=PaperOut)
async def download_paper(
    project_id: str,
    payload: DownloadPaperRequest,
    db: Session = Depends(get_db),
) -> PaperOut:
    """Download a chosen paper's PDF into the project sandbox.

    Requires explicit user approval: `confirmed` must be True (design.md §16.1).
    The heavy I/O (network fetch + disk writes) is dispatched via
    `asyncio.to_thread` so the event loop isn't blocked (H13).
    """
    project = db.get(Project, project_id)
    if project is None:
        raise HTTPException(404, "Project not found")
    if not payload.confirmed:
        raise HTTPException(
            422, "Download requires explicit user approval (confirmed=true)."
        )

    paper = db.get(Paper, payload.paper_id)
    if paper is None:
        paper = Paper(
            id=payload.paper_id,
            project_id=project_id,
            title=payload.title,
            abstract=payload.abstract,
            authors_json=json.dumps(payload.authors, ensure_ascii=False),
            year=payload.year,
            venue=payload.venue,
            venue_verified=payload.venue_verified,
            doi=payload.doi,
            arxiv_id=payload.arxiv_id,
            pdf_url=payload.pdf_url,
            source_url=payload.source_url,
            source=payload.source,
        )
        db.add(paper)
        db.flush()
    elif paper.project_id != project_id:
        raise HTTPException(400, "Paper belongs to a different project")

    try:
        # download_paper_pdf is async (httpx.AsyncClient); the brief sync disk
        # writes inside ws.safe_write are acceptable for PDFs (a few MB).
        await download_paper_pdf(db, _ws, paper=paper, project_slug=project.slug)
    except DownloadError as exc:
        # H1: rollback FIRST to release the SQLite write lock, THEN persist the
        # error audit in a separate session. Doing it the other way around
        # deadlocks on SQLite's single-writer lock.
        db.rollback()
        if exc.audit_action:
            from app.pdf.download import _audit_failure_separately

            _audit_failure_separately(
                action_type=exc.audit_action,
                project_id=project_id,
                target=exc.audit_target or "",
                payload=exc.audit_payload or {},
            )
        raise HTTPException(400, str(exc)) from exc
    db.commit()
    db.refresh(paper)
    return _to_out(paper)


@router.post("/api/v1/projects/{project_id}/papers/import-local", response_model=PaperOut)
async def import_local(
    project_id: str,
    payload: ImportLocalPdfRequest,
    db: Session = Depends(get_db),
) -> PaperOut:
    project = db.get(Project, project_id)
    if project is None:
        raise HTTPException(404, "Project not found")
    # C7: importing a local file needs explicit approval (same as download).
    if not payload.confirmed:
        raise HTTPException(
            422, "Local import requires explicit user approval (confirmed=true)."
        )

    src = Path(payload.source_path).expanduser()
    paper = db.get(Paper, payload.paper_id)
    if paper is None:
        paper = Paper(
            id=payload.paper_id,
            project_id=project_id,
            title=payload.title,
            abstract=payload.abstract,
            authors_json=json.dumps(payload.authors, ensure_ascii=False),
            year=payload.year,
            venue=payload.venue,
            doi=payload.doi,
            arxiv_id=payload.arxiv_id,
            source=payload.source,
        )
        db.add(paper)
        db.flush()
    elif paper.project_id != project_id:
        raise HTTPException(400, "Paper belongs to a different project")

    try:
        await import_local_pdf(db, _ws, paper=paper, project_slug=project.slug, source_path=src)
    except DownloadError as exc:
        # H1: rollback first, then persist the error audit (same reason as above).
        db.rollback()
        if exc.audit_action:
            from app.pdf.download import _audit_failure_separately

            _audit_failure_separately(
                action_type=exc.audit_action,
                project_id=project_id,
                target=exc.audit_target or "",
                payload=exc.audit_payload or {},
            )
        raise HTTPException(400, str(exc)) from exc
    db.commit()
    db.refresh(paper)
    return _to_out(paper)


@router.get("/api/v1/papers/{paper_id}/pdf")
def get_paper_pdf(paper_id: str, db: Session = Depends(get_db)) -> FileResponse:
    """Stream the local PDF for the in-browser reader."""
    paper = db.get(Paper, paper_id)
    if paper is None:
        raise HTTPException(404, "Paper not found")
    if not paper.local_pdf_path:
        raise HTTPException(404, "Paper has no local PDF; download it first.")

    settings = get_settings()
    pdf_path = (settings.projects_root / paper.local_pdf_path).resolve()
    try:
        assert_within_project(_slug_for(db, paper.project_id), pdf_path)
    except Exception as exc:  # noqa: BLE001
        raise HTTPException(403, str(exc)) from exc
    if not pdf_path.exists():
        raise HTTPException(404, "Local PDF file missing on disk")
    return FileResponse(str(pdf_path), media_type="application/pdf", filename="paper.pdf")


@router.post("/api/v1/papers/{paper_id}/parse", response_model=ParseResponse)
def parse_paper(paper_id: str, db: Session = Depends(get_db)) -> ParseResponse:
    paper = db.get(Paper, paper_id)
    if paper is None:
        raise HTTPException(404, "Paper not found")
    project = db.get(Project, paper.project_id)
    if project is None:
        raise HTTPException(404, "Project not found")
    try:
        result = parse_pdf(db, _ws, paper=paper, project_slug=project.slug)
    except ParseError as exc:
        db.rollback()
        raise HTTPException(400, str(exc)) from exc
    db.commit()
    return ParseResponse(**result)


def _slug_for(db: Session, project_id: str) -> str:
    project = db.get(Project, project_id)
    return project.slug if project else ""
