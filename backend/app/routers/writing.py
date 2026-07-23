"""Writing router (design.md §13.6, §17.4)."""
from __future__ import annotations

import asyncio

from fastapi import APIRouter, Depends, HTTPException
from fastapi.responses import FileResponse
from sqlalchemy.orm import Session

from app.db.models import Project
from app.db.session import get_db
from app.jobs import finish_job_in_fresh_session, start_job
from app.schemas import (
    FileContentResponse,
    FileListResponse,
    InitWritingRequest,
    InitWritingResponse,
    WriteFileRequest,
    WriteFileResponse,
    WritingTemplatesResponse,
)
from app.workspace.manager import audit
from app.writing.latex import (
    available_templates,
    compile_latex,
    init_writing_project,
    list_tex_files,
    read_tex_file,
    verify_citations,
    write_tex_file,
    writing_root,
)

router = APIRouter(tags=["writing"])


def _project(db: Session, project_id: str) -> Project:
    p = db.get(Project, project_id)
    if p is None:
        raise HTTPException(404, "Project not found")
    return p


@router.get("/api/v1/projects/{project_id}/writing/templates", response_model=WritingTemplatesResponse)
def list_templates(project_id: str, db: Session = Depends(get_db)) -> WritingTemplatesResponse:
    """List the available LaTeX templates for the template picker."""
    _project(db, project_id)
    return WritingTemplatesResponse(
        templates=[{"key": t["key"], "label": t["label"], "note": t["note"]} for t in available_templates()]
    )


@router.post("/api/v1/projects/{project_id}/writing/init", response_model=InitWritingResponse)
def init_writing(
    project_id: str,
    body: InitWritingRequest | None = None,
    db: Session = Depends(get_db),
) -> InitWritingResponse:
    project = _project(db, project_id)
    template = (body.template if body else None) or "generic"
    force = (body.force if body else False) or False
    root = init_writing_project(project.slug, project.name, template=template, force=force)
    # M11: audit the writing project init (file creation).
    audit(
        db,
        action_type="writing.init",
        project_id=project_id,
        target=str(root),
        payload={"template": template, "force": force, "files": list_tex_files(project.slug)},
    )
    db.commit()
    return InitWritingResponse(root=str(root), files=list_tex_files(project.slug))


@router.get("/api/v1/projects/{project_id}/writing/files", response_model=FileListResponse)
def get_files(project_id: str, db: Session = Depends(get_db)) -> FileListResponse:
    project = _project(db, project_id)
    return FileListResponse(files=list_tex_files(project.slug))


@router.get("/api/v1/projects/{project_id}/writing/file", response_model=FileContentResponse)
def get_file(project_id: str, path: str, db: Session = Depends(get_db)) -> FileContentResponse:
    project = _project(db, project_id)
    content = read_tex_file(project.slug, path)
    if content is None:
        raise HTTPException(404, "File not found")
    return FileContentResponse(path=path, content=content)


@router.put("/api/v1/projects/{project_id}/writing/file", response_model=WriteFileResponse)
def put_file(
    project_id: str,
    path: str,
    body: WriteFileRequest,
    db: Session = Depends(get_db),
) -> WriteFileResponse:
    """Write content to a file under the writing/ root.

    M9: previously accepted a raw `dict` and defaulted missing `content` to "",
    which would silently overwrite a file with empty content. Now uses a typed
    Pydantic model with max_length to prevent runaway writes.
    """
    project = _project(db, project_id)
    if not body.content:
        # Refuse to write empty content: an editor that saves before loading
        # would otherwise silently wipe a section file (M9 follow-up).
        raise HTTPException(400, "Refusing to write empty content (would wipe the file).")
    ok = write_tex_file(project.slug, path, body.content)
    if not ok:
        raise HTTPException(400, "Invalid path")
    # M11: audit manual file writes (design.md §2.1/§8.1).
    audit(
        db,
        action_type="writing.write_file",
        project_id=project_id,
        target=path,
        payload={"bytes": len(body.content.encode("utf-8"))},
    )
    db.commit()
    return WriteFileResponse(ok=True, path=path)


@router.post("/api/v1/projects/{project_id}/writing/compile")
async def compile(project_id: str, db: Session = Depends(get_db)) -> dict:
    """Compile the writing project to PDF in the BACKGROUND. LaTeX compile can
    take up to 2 minutes (latexmk timeout); blocking the HTTP request that long
    used to freeze the UI and vanish on navigation. Now we start a Job, fire the
    compile as an asyncio background task, and return immediately. The frontend
    polls the Job (via /workflows/active) for completion, then loads the PDF.

    Returns {"job_id": ...} so the caller can track status if it wants a direct
    poll, though the sidebar already surfaces it.
    """
    project = _project(db, project_id)
    job = start_job(
        db, project_id=project_id, kind="latex_compile",
        title="编译 LaTeX PDF", target_type="writing",
        message="正在编译(laTeX,最多 2 分钟)",
    )
    job_id = job.id
    project_slug = project.slug

    async def _run() -> None:
        # compile_latex runs a subprocess (latexmk) - keep it off the event loop.
        try:
            result = await asyncio.to_thread(compile_latex, project_slug)
        except Exception as exc:  # noqa: BLE001
            finish_job_in_fresh_session(job_id, status="failed", error=str(exc))
            return
        # Audit + mark the Job terminal in a fresh session (this runs detached
        # from the request session, which is long gone).
        try:
            from app.db.session import get_sessionmaker

            with get_sessionmaker()() as s:
                audit(
                    s,
                    action_type="writing.compile",
                    project_id=project_id,
                    target=str(writing_root(project_slug) / "output" / "main.pdf"),
                    payload={"ok": result.get("ok"), "error": result.get("error")},
                    status="ok" if result.get("ok") else "error",
                )
                s.commit()
        except Exception:  # noqa: BLE001
            pass
        if result.get("ok"):
            finish_job_in_fresh_session(job_id, status="completed", result_summary="编译成功")
        else:
            finish_job_in_fresh_session(
                job_id, status="failed", error=result.get("error") or "编译失败",
            )

    asyncio.create_task(_run())
    return {"job_id": job_id}


@router.get("/api/v1/projects/{project_id}/writing/pdf")
def get_pdf(project_id: str, db: Session = Depends(get_db)) -> FileResponse:
    project = _project(db, project_id)
    pdf = writing_root(project.slug) / "output" / "main.pdf"
    if not pdf.exists():
        raise HTTPException(404, "PDF not compiled yet. Call /compile first.")
    return FileResponse(str(pdf), media_type="application/pdf")


@router.get("/api/v1/projects/{project_id}/writing/citations")
def citations(project_id: str, db: Session = Depends(get_db)) -> dict:
    project = _project(db, project_id)
    return verify_citations(db, project_id, project.slug)
