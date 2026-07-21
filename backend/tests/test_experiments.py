"""Experiment runner metric-parsing tests (design.md §11.4)."""
from __future__ import annotations

import re

from app.experiments.runner import METRIC_RE


def test_metric_re_basic():
    m = METRIC_RE.search("METRIC step=10 loss=0.234")
    assert m and int(m.group(1)) == 10 and m.group(2) == "loss" and float(m.group(3)) == 0.234


def test_metric_re_multiple_keys():
    line = "METRIC step=5 loss=0.5 acc=0.8"
    # Our regex captures the FIRST key=val after step=; multiple keys would need
    # multiple lines or extended parsing. Document the contract.
    m = METRIC_RE.search(line)
    assert m and m.group(2) == "loss"


def test_metric_re_ignores_non_metric_lines():
    assert METRIC_RE.search("Epoch 5/10") is None
    assert METRIC_RE.search("[INFO] training started") is None


def test_metric_re_scientific():
    m = METRIC_RE.search("METRIC step=1 lr=1e-4")
    assert m and m.group(2) == "lr" and float(m.group(3)) == 1e-4


def test_scaffold_creates_files(tmp_path):
    """scaffold_experiment writes the expected uv project skeleton."""
    import pathlib
    from app.experiments.scaffold import scaffold_experiment

    # Build a fake project root under tmp.
    fake_root = tmp_path / "projects" / "demo"
    (fake_root / "experiments").mkdir(parents=True)
    import app.workspace.sandbox as sandbox

    # Monkeypatch project_dir to return our fake root.
    orig = sandbox.project_dir
    sandbox.project_dir = lambda slug: fake_root  # type: ignore
    try:
        root = scaffold_experiment("demo", "my-exp", "My Exp")
    finally:
        sandbox.project_dir = orig  # type: ignore

    assert (root / "pyproject.toml").exists()
    assert (root / "src" / "train.py").exists()
    assert (root / "configs" / "base.yaml").exists()
    assert (root / "scripts" / "smoke_test.sh").exists()
    assert (root / "runs").is_dir()
    assert "torch" in (root / "pyproject.toml").read_text()
