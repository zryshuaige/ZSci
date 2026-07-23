"""Experiment runner (design.md §9.6 experiment.run, §11.4, §16.2).

Executes a shell command in the experiment dir, streams stdout/stderr to the
run directory, parses `METRIC step=<n> <name>=<value>` lines into run_metrics,
and records environment + git info. Supports stop. Agent never runs shell
directly - the user must confirm (design.md §16.2).
"""
from __future__ import annotations

import asyncio
import json
import os
import re
import shlex
import signal
import subprocess
from datetime import UTC, datetime
from pathlib import Path

from sqlalchemy.orm import Session

from app.db.models import ExperimentRun, RunMetric
from app.utils import new_id
from app.workspace.manager import audit
from app.workspace.sandbox import assert_within_project, project_dir

METRIC_RE = re.compile(r"METRIC\s+step=(\d+)\s+(\S+)=(\S+)")

# Active runs: run_id -> asyncio.subprocess.Process (for in-process stop).
_ACTIVE: dict[str, asyncio.subprocess.Process] = {}
# run_ids that the user asked to stop; run_experiment prefers "stopped" over
# "failed" when this is set (H5).
_STOPPING: set[str] = set()

# Env vars passed through to user-run experiment subprocesses. We DON'T copy the
# full os.environ because the parent process may hold LLM API keys that a
# malicious experiment script could exfiltrate (C4).
_SUBPROCESS_ENV_ALLOWLIST = (
    "PATH",
    "HOME",
    "USER",
    "LANG",
    "LC_ALL",
    "LC_CTYPE",
    "TERM",
    "SHELL",
    "TMPDIR",
    "CUDA_VISIBLE_DEVICES",
    "CUDA_DEVICE_ORDER",
    "HF_HOME",
    "TRANSFORMERS_CACHE",
    "TORCH_HOME",
    "PYTHONPATH",
    "PYTHONUNBUFFERED",
    "VIRTUAL_ENV",
    "UV_CACHE_DIR",
    "HTTP_PROXY",
    "HTTPS_PROXY",
    "NO_PROXY",
    "http_proxy",
    "https_proxy",
    "no_proxy",
)


def _build_subprocess_env() -> dict[str, str]:
    """Build a sanitized env for user-run experiment subprocesses (C4)."""
    return {k: v for k, v in os.environ.items() if k in _SUBPROCESS_ENV_ALLOWLIST}


def _now_iso() -> str:
    return datetime.now(UTC).isoformat()


def create_run_dir(project_slug: str, exp_slug: str, run_id: str) -> Path:
    root = project_dir(project_slug) / "experiments" / exp_slug / "runs" / run_id
    root.mkdir(parents=True, exist_ok=True)
    (root / "figures").mkdir(exist_ok=True)
    (root / "checkpoints").mkdir(exist_ok=True)
    (root / "artifacts").mkdir(exist_ok=True)
    return root


def _write_run_json(run_dir: Path, run: ExperimentRun, command: str, seed: int | None) -> None:
    run_json = {
        "run_id": run.id,
        "experiment_id": run.experiment_id,
        "command": shlex.split(command),
        "seed": seed,
        "git_commit": run.git_commit,
        "status": run.status,
        "created_at": run.created_at.isoformat(),
    }
    (run_dir / "run.json").write_text(json.dumps(run_json, indent=2), encoding="utf-8")


def _git_commit(exp_root: Path) -> str | None:
    try:
        out = subprocess.run(
            ["git", "rev-parse", "HEAD"], cwd=exp_root, capture_output=True, text=True, timeout=5
        )
        return out.stdout.strip() if out.returncode == 0 else None
    except Exception:  # noqa: BLE001
        return None


async def run_experiment(
    db: Session,
    *,
    run: ExperimentRun,
    command: str,
    project_slug: str,
    exp_slug: str,
    exp_root: Path,
    project_id: str | None = None,
    seed: int | None = None,
) -> ExperimentRun:
    """Execute the command, streaming logs + parsing metrics. Updates `run`.

    `project_id` is forwarded to the audit row so run events are queryable per
    project (M24). If unset, we try to resolve it from `run.experiment_id`.
    """
    assert_within_project(project_slug, exp_root)
    run_dir = create_run_dir(project_slug, exp_slug, run.id)
    run.run_path = str(run_dir.relative_to(project_dir(project_slug)))
    run.command = command
    run.seed = seed
    run.git_commit = _git_commit(exp_root)
    run.status = "running"
    run.start_at = datetime.now(UTC)
    db.flush()
    _write_run_json(run_dir, run, command, seed)

    stdout_path = run_dir / "stdout.log"
    stderr_path = run_dir / "stderr.log"
    metrics_path = run_dir / "metrics.jsonl"

    if project_id is None:
        # Resolve project_id via the experiment for the audit row (M24).
        from app.db.models import Experiment

        exp = db.get(Experiment, run.experiment_id)
        project_id = exp.project_id if exp else None

    audit(
        db,
        action_type="experiment.run",
        project_id=project_id,
        target=str(run_dir),
        payload={"run_id": run.id, "command": command},
        status="ok",
    )

    env = _build_subprocess_env()
    proc: asyncio.subprocess.Process | None = None
    try:
        proc = await asyncio.create_subprocess_shell(
            command,
            cwd=str(exp_root),
            stdout=asyncio.subprocess.PIPE,
            stderr=asyncio.subprocess.PIPE,
            env=env,
        )
        _ACTIVE[run.id] = proc
        # Persist PID immediately so stop_run can find it even if this worker
        # is restarted or does not own the process. H6, L27.
        run.pid = proc.pid
        # COMMIT (not just flush) the running status and pid before the
        # subprocess runs. A run can take minutes; without a commit the whole
        # run sits in one open transaction holding the SQLite write lock and
        # stays invisible to other sessions. Committing here releases that lock
        # so other operations (sidebar, agent events) can write, and lets the
        # global workflow sidebar separate session see this run as running --
        # mirroring how agent/service.py commits running before a skill runs.
        # Final status is committed by the caller after we return.
        db.commit()

        with open(stdout_path, "w", encoding="utf-8") as fout, \
             open(stderr_path, "w", encoding="utf-8") as ferr, \
             open(metrics_path, "w", encoding="utf-8") as fmet:

            async def drain(stream, outfile, is_stderr):
                while True:
                    line = await stream.readline()
                    if not line:
                        break
                    text = line.decode("utf-8", errors="replace")
                    outfile.write(text)
                    outfile.flush()
                    if not is_stderr:
                        m = METRIC_RE.search(text)
                        if m:
                            step, name, val = int(m.group(1)), m.group(2), float(m.group(3))
                            db.add(RunMetric(
                                id=new_id("metric"),
                                run_id=run.id, step=step,
                                metric_name=name, metric_value=val,
                            ))
                            fmet.write(json.dumps({"step": step, name: val}) + "\n")
                            fmet.flush()

            await asyncio.gather(
                drain(proc.stdout, fout, False),
                drain(proc.stderr, ferr, True),
            )
            await proc.wait()
            # H5: prefer "stopped" over "failed" if the user asked to stop.
            if run.id in _STOPPING:
                run.status = "stopped"
                _STOPPING.discard(run.id)
            else:
                run.status = "completed" if proc.returncode == 0 else "failed"
    except asyncio.CancelledError:
        # H4: client disconnect -> terminate the subprocess so it doesn't keep
        # running in the background with the run stuck in "running".
        _STOPPING.add(run.id)
        if proc is not None:
            try:
                proc.terminate()
                await asyncio.wait_for(proc.wait(), timeout=5)
            except (TimeoutError, ProcessLookupError):  # noqa: BLE001
                try:
                    proc.kill()
                except ProcessLookupError:
                    pass
        run.status = "stopped"
        raise
    except FileNotFoundError as exc:
        run.status = "failed"
        stderr_path.write_text(f"Command not found: {exc}\n", encoding="utf-8")
    finally:
        _ACTIVE.pop(run.id, None)
        _STOPPING.discard(run.id)

    run.end_at = datetime.now(UTC)
    db.flush()
    return run


def stop_run(run_id: str) -> bool:
    """Stop an active run. Returns True if a signal was sent.

    Falls back to `os.kill(pid, SIGTERM)` using the persisted PID so this works
    even when the run is owned by a different worker process (H6).
    """
    proc = _ACTIVE.get(run_id)
    if proc is not None:
        _STOPPING.add(run_id)
        try:
            proc.terminate()
            return True
        except ProcessLookupError:
            return False

    # Fallback: look up the PID from the DB and signal it directly.
    from sqlalchemy import select
    from sqlalchemy.orm import Session as _Session

    from app.db.session import get_engine

    with _Session(get_engine()) as session:
        row = session.scalar(select(ExperimentRun).where(ExperimentRun.id == run_id))
        if row is None or row.pid is None or row.status != "running":
            return False
        try:
            os.kill(row.pid, signal.SIGTERM)
            _STOPPING.add(run_id)
            return True
        except (ProcessLookupError, PermissionError):
            return False


def tail_log(run_dir: Path, n: int = 200) -> str:
    """Return the last `n` lines of stdout.log + stderr.log."""
    parts: list[str] = []
    for name in ("stdout.log", "stderr.log"):
        p = run_dir / name
        if p.exists():
            lines = p.read_text(encoding="utf-8", errors="replace").splitlines()[-n:]
            parts.append(f"=== {name} ===\n" + "\n".join(lines))
    return "\n\n".join(parts)
