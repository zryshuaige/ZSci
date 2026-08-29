"""Smart directory copy for experiment forks.

``copytree_smart`` duplicates an experiment directory while:

- skipping heavyweight regenerable dirs: ``runs/``, ``__pycache__``,
  ``.venv``, ``.git``;
- hard-linking files under any ``checkpoints/`` directory (large ``.pt``
  weights) instead of copying, so a fork shares storage with its parent
  until either side rewrites the file;
- copying everything else verbatim.
"""
from __future__ import annotations

import logging
import os
import shutil
from pathlib import Path

logger = logging.getLogger("zsci.workspace.branching")

_SKIP_DIRS = {"runs", "__pycache__", ".venv", "venv", ".git", ".ruff_cache", ".pytest_cache"}
_LINK_DIRS = {"checkpoints"}


def _hardlink_or_copy(src: Path, dst: Path) -> None:
    try:
        os.link(src, dst)
    except OSError:
        # Cross-device or filesystem without hardlink support: fall back.
        shutil.copy2(src, dst)


def copytree_smart(src: Path, dst: Path) -> None:
    """Copy ``src`` to ``dst``, skipping regenerable dirs, hard-linking
    checkpoint weights. ``dst`` must already exist."""
    for root, dirs, files in os.walk(src):
        root_path = Path(root)
        rel_root = root_path.relative_to(src)

        # Prune skipped directories in-place so os.walk descends no further.
        dirs[:] = [d for d in dirs if d not in _SKIP_DIRS]

        link_all = any(part in _LINK_DIRS for part in rel_root.parts)
        for d in dirs:
            (dst / rel_root / d).mkdir(parents=True, exist_ok=True)
        for f in files:
            src_file = root_path / f
            dst_file = dst / rel_root / f
            dst_file.parent.mkdir(parents=True, exist_ok=True)
            if link_all:
                _hardlink_or_copy(src_file, dst_file)
            else:
                shutil.copy2(src_file, dst_file)
    logger.info("copytree_smart %s -> %s done", src, dst)
