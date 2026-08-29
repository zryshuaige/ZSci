"""Background task dispatch: one place that launches and tracks async work.

Everything long-running (agent skills, the experiment orchestrator loop)
runs through ``dispatch()`` which:

1. Launches the coroutine via ``asyncio.create_task`` (never blocking the
   HTTP request).
2. Records the asyncio task in ``_LIVE`` so callers can check liveness and
   we never double-launch the same logical task (e.g. an orchestrator that
   is already waiting at a checkpoint).
3. Attaches a done-callback that logs unexpected crashes and always clears
   the registry entry.

The registry is also the answer to "is this task still alive in THIS
process?" — after a restart it's empty, which is exactly the signal the
startup recovery and ``decide`` endpoint need to relaunch a loop.
"""
from __future__ import annotations

import asyncio
import logging
from collections.abc import Coroutine
from typing import Any

logger = logging.getLogger("zsci.agent.dispatch")

# logical task id -> asyncio.Task
_LIVE: dict[str, asyncio.Task] = {}


def is_live(task_id: str) -> bool:
    """True when ``task_id``'s coroutine is alive in this process."""
    t = _LIVE.get(task_id)
    return t is not None and not t.done()


def live_task_ids() -> set[str]:
    return {tid for tid, t in _LIVE.items() if not t.done()}


def dispatch(logical_id: str, coro: Coroutine[Any, Any, Any], *, name: str | None = None) -> asyncio.Task:
    """Launch ``coro`` in the background, tracked as ``logical_id``.

    If a coroutine with the same logical id is already running, the new one
    is NOT launched and the existing task is returned — callers use this for
    idempotent relaunch (e.g. after a restart the decide endpoint may race
    the startup recovery).
    """
    existing = _LIVE.get(logical_id)
    if existing is not None and not existing.done():
        return existing

    task = asyncio.create_task(coro, name=name or f"zsci-{logical_id}")

    def _cleanup(t: asyncio.Task) -> None:
        _LIVE.pop(logical_id, None)
        if t.cancelled():
            return
        exc = t.exception()
        if exc is not None:
            logger.error("background task %s crashed: %r", logical_id, exc)

    _LIVE[logical_id] = task
    task.add_done_callback(_cleanup)
    return task


def cancel(logical_id: str) -> bool:
    """Cancel a live background task. Returns True if one was cancelled."""
    t = _LIVE.get(logical_id)
    if t is not None and not t.done():
        t.cancel()
        return True
    return False
