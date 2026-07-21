"""Sandbox security tests (design.md §16.3)."""
from __future__ import annotations

from pathlib import Path

import pytest

from app.workspace.sandbox import SandboxError, assert_within_project, project_dir


def test_project_dir_safe(isolated_workspace):
    d = project_dir("my-proj")
    assert d == (isolated_workspace / "projects" / "my-proj").resolve()


def test_reject_path_traversal_slug(isolated_workspace):
    with pytest.raises(SandboxError):
        project_dir("..")
    with pytest.raises(SandboxError):
        project_dir("a/b")
    with pytest.raises(SandboxError):
        project_dir(".")


def test_assert_within_project_allows_inner(isolated_workspace):
    root = project_dir("proj")
    inner = root / "literature" / "paper.pdf"
    assert assert_within_project("proj", inner) == inner.resolve()


def test_assert_within_project_rejects_escape(isolated_workspace, tmp_path):
    outside = tmp_path / "elsewhere" / "x.pdf"
    outside.parent.mkdir()
    outside.write_bytes(b"x")
    with pytest.raises(SandboxError):
        assert_within_project("proj", outside)
