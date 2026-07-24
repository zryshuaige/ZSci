"""Fork / branch an experiment at a specific stage.

A fork creates a NEW Experiment row that copies the completed outputs of
stages 0..target_stage, then marks stages after the fork point as
`not_started`. The fork's own experiment_stages will be created when the
new experiment is launched through the 9-stage orchestrator (each stage
that the fork already satisfied will short-circuit — see the orchestrator's
`skip-if-already-completed` logic).

The branch graph is recorded in `experiment_branches` so the front-end's
BranchTree can render the ancestry.

NOTE on workspace copying: `branching.copytree_smart` duplicates the
experiment directory minus `runs/` / `__pycache__/` / `.venv/`; checkpoints
are hard-linked to avoid duplicating large .pt files. The new experiment
gets a fresh slug under the same project so its run directory is isolated.
"""
from __future__ import annotations

import logging
from datetime import UTC, datetime
from typing import Any

from sqlalchemy import select
from sqlalchemy.orm import Session

from app.config import get_settings
from app.db.models import (
    Experiment,
    ExperimentBranch,
    ExperimentStage,
    Project,
)
from app.experiments.states import STAGE_KEYS, STAGE_NAME_ZH
from app.utils import new_id, slugify
from app.workspace.branching import copytree_smart
from app.workspace.sandbox import project_dir

logger = logging.getLogger("zsci.experiments.forking")


def fork_experiment(
    db: Session,
    *,
    source_experiment_id: str,
    fork_stage_key: str,
    title: str | None = None,
    branch_name: str | None = None,
) -> Experiment:
    """Fork `source_experiment_id` at the stage *named* by `fork_stage_key`.

    Copies the source experiment's completed stage outputs for every stage
    up to and including `fork_stage_key`, plus the workspace directory (smart
    copytree). Returns the new Experiment row, persisted + committed.

    `fork_stage_key` is the stage_key (e.g. ``stage_3_codegen``) at which we
    branch — the new experiment is considered to have run stages up to and
    including this one, and will re-run from the next.
    """
    src = db.get(Experiment, source_experiment_id)
    if src is None:
        raise ValueError(f"Source experiment {source_experiment_id} not found")
    project = db.get(Project, src.project_id)
    if project is None:
        raise ValueError("Source experiment's project not found")
    if fork_stage_key not in STAGE_KEYS:
        raise ValueError(f"Unknown fork_stage_key: {fork_stage_key!r}")

    fork_idx = STAGE_KEYS.index(fork_stage_key)
    # Stages up to and including the fork point are inherited (copied); the
    # rest are left not_started so the orchestrator re-runs them.
    inherited_keys = STAGE_KEYS[: fork_idx + 1]

    # Snapshot the source's completed stage rows in this order.
    src_rows = {
        r.stage_key: r
        for r in db.scalars(
            select(ExperimentStage).where(
                ExperimentStage.experiment_id == src.id,
            )
        ).all()
    }

    # Build a unique slug + title for the fork under the same project.
    base_title = title or f"{src.title or 'experiment'} (分支)"
    fork_title = base_title
    base_slug = slugify(fork_title) or f"exp-{new_id('x')[:6]}"
    existing_slugs = {
        s for (s,) in db.execute(
            select(Experiment.slug).where(Experiment.project_id == project.id)
        ).all()
    }
    fork_slug = base_slug
    if fork_slug in existing_slugs:
        fork_slug = f"{base_slug}-{new_id('x')[:4]}"

    # Branch name must be unique within the parent experiment's branch tree —
    # the BranchTree UI keys on `branch_name`, and two identical names would
    # render as duplicate nodes the user can't disambiguate. If the caller
    # supplied a branch_name that already exists for this source, auto-suffix
    # it (e.g. "alt-low-cost" → "alt-low-cost-2") and log the conflict.
    final_branch_name = (branch_name or "").strip() or None
    if final_branch_name is not None:
        existing_branch_names = {
            bn for (bn,) in db.execute(
                select(ExperimentBranch.branch_name).where(
                    ExperimentBranch.parent_experiment_id == src.id,
                    ExperimentBranch.branch_name.is_not(None),
                )
            ).all()
        }
        if final_branch_name in existing_branch_names:
            # Auto-disambiguate: try "name-2", "name-3", ... until free.
            base = final_branch_name
            n = 2
            while f"{base}-{n}" in existing_branch_names:
                n += 1
            logger.info(
                "fork: branch_name %r already exists under %s; auto-renamed to %r",
                base, src.id, f"{base}-{n}",
            )
            final_branch_name = f"{base}-{n}"

    # Create the new experiment's workspace directory by copying the source's
    # (minus runs / caches / venv). We DON'T scaffold first — copytree brings
    # the source's real generated code (configs/run commands) over wholesale,
    # which is what we want for a faithful branch.
    settings = get_settings()
    src_root = (settings.projects_root / src.root_path).resolve()
    new_root = project_dir(project.slug) / "experiments" / fork_slug
    if new_root.exists():
        new_root = project_dir(project.slug) / "experiments" / f"{fork_slug}-{new_id('x')[:4]}"
    new_root.mkdir(parents=True, exist_ok=True)
    if src_root.exists():
        try:
            copytree_smart(src_root, new_root)
        except Exception as exc:  # noqa: BLE001
            logger.warning("copytree_smart for fork %s failed: %s", fork_slug, exc)
    new_root_path = new_root

    new_exp = Experiment(
        id=new_id("exp"),
        project_id=project.id,
        title=fork_title,
        slug=fork_slug,
        root_path=str(new_root_path.relative_to(settings.projects_root)),
        source_repository_id=src.source_repository_id,
        related_idea_id=src.related_idea_id,
        status="scaffolded",
        research_question=src.research_question,
        hypothesis=src.hypothesis,
        # Inherit the interactive mode so the fork also checkpoints; carry the
        # source's plan_json so codegen/smoke can resume without regeneration.
        mode=src.mode or "interactive",
        overall_status="draft",
        current_stage=fork_stage_key,
        parent_experiment_id=src.id,
        branch_name=final_branch_name or fork_slug,
        decision_history_json="[]",
    )
    db.add(new_exp)
    db.flush()

    # Copy the inherited stage rows (completed / approved / skipped) so the
    # new experiment starts looking like it already passed the fork point.
    copied_stage_ids: dict[str, str] = {}
    for key in inherited_keys:
        src_row = src_rows.get(key)
        new_row = ExperimentStage(
            id=new_id("stage"),
            experiment_id=new_exp.id,
            stage_key=key,
            version=(src_row.version if src_row else 1),
            status=(src_row.status if src_row else "completed"),
            inputs_json=(src_row.inputs_json if src_row else None),
            outputs_json=(src_row.outputs_json if src_row else None),
            artifacts_json=(src_row.artifacts_json if src_row else None),
            config_json=(src_row.config_json if src_row else None),
            logs_json=(src_row.logs_json if src_row else None),
            user_decisions_json=(src_row.user_decisions_json if src_row else None),
            dependencies=None,
            started_at=(src_row.started_at if src_row else None),
            ended_at=(src_row.ended_at if src_row else datetime.now(UTC)),
        )
        db.add(new_row)
        copied_stage_ids[key] = new_row.id

    db.flush()

    # Record the branch relationship.
    parent_branch_row = db.scalar(
        select(ExperimentBranch).where(
            ExperimentBranch.experiment_id == src.id
        ).order_by(ExperimentBranch.created_at.desc()).limit(1)
    )
    branch = ExperimentBranch(
        id=new_id("branch"),
        experiment_id=new_exp.id,
        parent_experiment_id=src.id,
        parent_branch_id=(parent_branch_row.id if parent_branch_row else None),
        fork_stage_id=copied_stage_ids.get(fork_stage_key),
        branch_name=new_exp.branch_name or (final_branch_name or fork_slug),
    )
    db.add(branch)
    db.commit()
    db.refresh(new_exp)
    return new_exp


def list_branches_for_experiment(db: Session, experiment_id: str) -> list[Any]:
    """Return all branch rows visible from this experiment: its own branch
    record (if it's a fork), plus any experiments that forked from it.

    Returns a list of `ExperimentBranch` rows ordered newest-first.
    """
    return list(
        db.scalars(
            select(ExperimentBranch).where(
                (ExperimentBranch.experiment_id == experiment_id)
                | (ExperimentBranch.parent_experiment_id == experiment_id)
            ).order_by(ExperimentBranch.created_at.desc())
        ).all()
    )