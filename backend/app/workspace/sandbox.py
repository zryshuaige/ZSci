"""Path sandbox: every filesystem access is constrained to a project dir.

Two entry points:

- ``project_dir(slug)`` — resolve a project slug to its root under
  ``<workspace>/projects/``. Rejects anything that could escape
  (traversal, separators, dot slugs).
- ``assert_within_project(slug, path)`` — resolve an arbitrary path and
  verify it lies inside the project root; returns the resolved path so
  callers can persist it. Raises :class:`SandboxError` otherwise.

Case-insensitive comparison via ``os.path.normcase`` because the app runs
on case-insensitive filesystems (Windows) as well as case-sensitive ones.
"""
from __future__ import annotations

import os
from pathlib import Path

from app.config import get_settings


class SandboxError(PermissionError):
    """A path escaped (or tried to escape) its project sandbox."""


def _norm(path: Path) -> Path:
    return Path(os.path.normcase(str(path)))


def _is_within(child: Path, parent: Path) -> bool:
    child_n, parent_n = _norm(child), _norm(parent)
    return child_n == parent_n or parent_n in child_n.parents


def project_dir(slug: str) -> Path:
    """Return the resolved project root for ``slug``.

    Raises :class:`SandboxError` for empty/dot/traversal slugs or any slug
    containing a path separator — slugs are single directory names, never
    relative paths.
    """
    if not slug or slug in {".", ".."} or "/" in slug or "\\" in slug:
        raise SandboxError(f"illegal project slug: {slug!r}")
    projects_root = get_settings().projects_root
    root = (projects_root / slug).resolve()
    if not _is_within(root, projects_root.resolve()):
        raise SandboxError(f"project path escapes workspace: {slug!r}")
    return root


def assert_within_project(slug: str, path: Path) -> Path:
    """Resolve ``path`` and verify it lies inside project ``slug``'s root.

    Returns the resolved path so callers can persist it (e.g. store paths
    relative to ``projects_root`` in the DB). Raises :class:`SandboxError`
    when the path escapes the project root.
    """
    root = project_dir(slug)
    resolved = Path(path).resolve()
    if not _is_within(resolved, root):
        raise SandboxError(f"path escapes project sandbox: {path}")
    return resolved
