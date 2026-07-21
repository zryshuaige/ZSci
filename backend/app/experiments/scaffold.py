"""Experiment scaffolding (design.md §9.6 experiment.scaffold, §11.3).

Creates a uv + pyproject.toml Python project skeleton under the project's
experiments/ dir. Does NOT install deps or run anything (design.md §16.1).
"""
from __future__ import annotations

from pathlib import Path

from app.workspace.sandbox import project_dir

PYPROJECT = """\
[project]
name = "{name}"
version = "0.1.0"
description = "Z-Sci experiment: {title}"
requires-python = ">=3.11"
dependencies = [
    "torch>=2.2",
    "numpy>=1.26",
    "hydra-core>=1.3",
    "omegaconf>=2.3",
    "tensorboard>=2.16",
    "mlflow>=2.12",
]

[tool.uv]
# Managed by Z-Sci. Run: uv sync && uv run python -m src.train experiment=baseline
"""

TRAIN_PY = '''\
"""Training entrypoint. Replace with your method."""
import hydra
from omegaconf import DictConfig


@hydra.main(version_base=None, config_path="../configs", config_name="base")
def main(cfg: DictConfig) -> None:
    print(f"[smoke] experiment={cfg.experiment.name} seed={cfg.seed}")
    # TODO: model / data / train loop. Log metrics to runs/<run_id>/metrics.jsonl
    # Z-Sci parses lines like: METRIC step=<n> <name>=<value>
    print("METRIC step=0 loss=0.0")


if __name__ == "__main__":
    main()
'''

BASE_YAML = """\
seed: 42

experiment:
  name: baseline

data:
  dataset: TODO
  root: ./data

model:
  name: TODO

trainer:
  epochs: 1
  lr: 1e-4
  batch_size: 32

# Z-Sci reads METRIC lines from stdout to build metric curves.
"""

SMOKE_SH = """\
#!/usr/bin/env bash
# Minimal smoke test (design.md §10 rule 10).
set -e
cd "$(dirname "$0")/.."
uv run python -m src.train experiment=smoke trainer.epochs=1
"""

README = """\
# {title}

Z-Sci 实验项目。由 Agent 生成骨架,需人工填写方法实现。

## 运行
```bash
uv sync
uv run python -m src.train experiment=baseline
```

## 约定
- 每次 run 在 `runs/<timestamp>_<id>/` 下保存:config、stdout/stderr、metrics.jsonl、checkpoints
- stdout 中形如 `METRIC step=<n> <name>=<value>` 的行会被 Z-Sci 解析为指标曲线
"""


def scaffold_experiment(project_slug: str, exp_slug: str, title: str) -> Path:
    """Create the experiment project skeleton. Returns the experiment root."""
    root = project_dir(project_slug) / "experiments" / exp_slug
    if root.exists() and any(root.iterdir()):
        raise FileExistsError(f"Experiment directory already populated: {root}")
    (root / "src").mkdir(parents=True)
    (root / "configs").mkdir(parents=True)
    (root / "scripts").mkdir(parents=True)
    (root / "tests").mkdir(parents=True)
    (root / "runs").mkdir(parents=True)

    (root / "pyproject.toml").write_text(
        PYPROJECT.format(name=exp_slug.replace("-", "_"), title=title), encoding="utf-8"
    )
    (root / "src" / "train.py").write_text(TRAIN_PY, encoding="utf-8")
    (root / "src" / "evaluate.py").write_text(
        '# TODO: evaluation script\nprint("evaluate placeholder")\n', encoding="utf-8"
    )
    (root / "configs" / "base.yaml").write_text(BASE_YAML, encoding="utf-8")
    (root / "scripts" / "smoke_test.sh").write_text(SMOKE_SH, encoding="utf-8")
    (root / "README.md").write_text(README.format(title=title), encoding="utf-8")
    (root / ".python-version").write_text("3.11\n", encoding="utf-8")
    return root
