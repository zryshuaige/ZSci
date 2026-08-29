"""WorkspaceManager: project directory lifecycle, sandboxed writes, audit.

The on-disk layout for one research project (all under
``<workspace>/projects/<slug>/``)::

    project.yaml            project metadata (id/name/slug/direction)
    README.md               human-facing pointer file
    .gitignore              ignores local artifacts inside the project
    literature/papers/      one dir per downloaded paper (+ figures/)
    experiments/templates/  scaffold templates live next to experiments
    experiments/<slug>/     one dir per experiment (scaffold.py creates it)
    writing/paper/          LaTeX project (sections/ + main.tex + refs)

``audit()`` is the single helper every router/service uses to append to the
``audit_log`` table. It flushes (but does not commit) so the row participates
in the caller's transaction; a failing caller rolls the audit entry back with
its failed action, and callers that need the failure recorded separately use a
fresh session (see ``pdf.download._audit_failure_separately``).
"""
from __future__ import annotations

import json
from pathlib import Path

from sqlalchemy.orm import Session

from app.config import get_settings
from app.db.models import AuditLog
from app.utils import new_id
from app.workspace.sandbox import SandboxError, assert_within_project, project_dir

__all__ = ["WorkspaceManager", "audit", "SandboxError", "project_dir", "assert_within_project"]

# Subtree created with a new project. `experiments/templates` hosts the
# scaffold template so experiment skeletons can reference it locally.
_PROJECT_SUBTREE = (
    "literature/papers",
    "experiments/templates",
    "writing/paper/sections",
)

_PROJECT_YAML = """\
id: {project_id}
name: {name}
slug: {slug}
research_direction: {direction}
created_by: zsci
"""

_PROJECT_README = """\
# {name}

Z-Sci 研究工作区。研究方向：{direction}

- `literature/papers/` — 下载的论文 PDF、笔记与批注
- `experiments/` — 实验工程（uv + Hydra 骨架）与运行产物
- `writing/paper/` — LaTeX 论文工程

本目录由 Z-Sci 管理，可整体拷贝备份；删除项目时会一并清理。
"""

_PROJECT_GITIGNORE = """\
# Z-Sci project local artifacts
__pycache__/
.venv/
runs/*/checkpoints/
*.pyc
"""


class WorkspaceManager:
    """Owns the on-disk project tree. Stateless — instantiate freely."""

    def create_project(
        self,
        db: Session,
        *,
        project_id: str,
        name: str,
        slug: str,
        research_direction: str = "",
    ) -> Path:
        """Create the directory tree for a new project. Returns the root.

        Raises ``FileExistsError`` when the directory already exists and
        :class:`SandboxError` for an illegal slug (mapped to HTTP 409 by the
        projects router).
        """
        root = project_dir(slug)
        if root.exists():
            raise FileExistsError(f"project directory already exists: {root}")
        for rel in _PROJECT_SUBTREE:
            (root / rel).mkdir(parents=True)
        (root / "project.yaml").write_text(
            _PROJECT_YAML.format(
                project_id=project_id, name=name, slug=slug, direction=research_direction
            ),
            encoding="utf-8",
        )
        (root / "README.md").write_text(
            _PROJECT_README.format(name=name, direction=research_direction),
            encoding="utf-8",
        )
        (root / ".gitignore").write_text(_PROJECT_GITIGNORE, encoding="utf-8")
        audit(db, action_type="project.create", project_id=project_id, target=str(root))
        return root

    def project_root(self, slug: str) -> Path:
        """Resolved root of an existing project (may not exist on disk yet)."""
        return project_dir(slug)

    def paper_dir(self, slug: str, paper_id: str) -> Path:
        """Create (if needed) and return the sandboxed dir for one paper.

        Layout: ``literature/papers/<paper_id>/`` with ``figures/`` for
        extracted images.
        """
        if not paper_id or "/" in paper_id or "\\" in paper_id or paper_id in {".", ".."}:
            raise SandboxError(f"illegal paper id: {paper_id!r}")
        pdir = project_dir(slug) / "literature" / "papers" / paper_id
        (pdir / "figures").mkdir(parents=True, exist_ok=True)
        return pdir

    def safe_write(self, slug: str, path: Path, data: bytes) -> Path:
        """Write ``data`` to ``path`` after verifying it stays in the project.

        Returns the resolved path (callers persist it relative to
        ``projects_root``). Creates parent directories as needed.
        """
        resolved = assert_within_project(slug, Path(path))
        resolved.parent.mkdir(parents=True, exist_ok=True)
        resolved.write_bytes(data)
        return resolved


def audit(
    db: Session,
    *,
    action_type: str,
    project_id: str | None = None,
    target: str | None = None,
    payload: dict | list | None = None,
    status: str = "ok",
) -> None:
    """Append one row to ``audit_log``. Flushes, does not commit."""
    row = AuditLog(
        id=new_id("aud"),
        action_type=action_type,
        project_id=project_id,
        target=str(target) if target is not None else None,
        payload_json=(
            json.dumps(payload, ensure_ascii=False, default=str) if payload is not None else None
        ),
        status=status,
    )
    db.add(row)
    db.flush()
