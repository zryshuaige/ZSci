"""In-process event bus: instant pub/sub for agent task events.

The DB (`agent_task_events`) remains the durable source of truth and the
SSE fallback (replay + poll). This bus is the *live* channel: when a skill
or the orchestrator emits an event, connected SSE streams receive it within
milliseconds instead of on the next 1s poll.

Semantics:
- ``publish()`` never blocks and never raises — zero subscribers is the
  common case (nobody is watching this task right now).
- ``subscribe()`` yields ``(event_id, payload_dict)`` tuples. The queue is
  bounded; a slow consumer that falls >MAX_QUEUE events behind misses the
  oldest (the SSE layer falls back to a DB replay when it detects a gap,
  so no events are ever lost from the user's perspective).
- Bus state lives for the process lifetime; single-process FastAPI means
  one bus covers all connected clients.
"""
from __future__ import annotations

import asyncio
import logging
from typing import Any

logger = logging.getLogger("zsci.agent.events")

MAX_QUEUE = 256


class _Subscription:
    def __init__(self) -> None:
        self.queue: asyncio.Queue[dict[str, Any] | None] = asyncio.Queue(maxsize=MAX_QUEUE)
        self.dropped = 0  # events lost to a slow consumer


class EventBus:
    """Fan-out bus keyed by task id."""

    def __init__(self) -> None:
        self._subs: dict[str, list[_Subscription]] = {}

    def publish(self, task_id: str, event: dict[str, Any]) -> None:
        """Deliver ``event`` to every live subscriber of ``task_id``."""
        subs = self._subs.get(task_id)
        if not subs:
            return
        for sub in list(subs):
            try:
                sub.queue.put_nowait(event)
            except asyncio.QueueFull:
                sub.dropped += 1
                # Drop the oldest pending item to make room — the SSE layer
                # replays from the DB when it detects the gap.
                try:
                    sub.queue.get_nowait()
                    sub.queue.put_nowait(event)
                except (asyncio.QueueEmpty, asyncio.QueueFull):
                    pass

    def subscribe(self, task_id: str):
        """Async context manager yielding a subscription for ``task_id``."""
        sub = _Subscription()
        self._subs.setdefault(task_id, []).append(sub)
        return _SubscriberHandle(self, task_id, sub)

    def close(self, task_id: str, sub: _Subscription) -> None:
        subs = self._subs.get(task_id)
        if subs and sub in subs:
            subs.remove(sub)
            if not subs:
                self._subs.pop(task_id, None)


class _SubscriberHandle:
    """``async with bus.subscribe(task_id) as sub: ...``"""

    def __init__(self, bus: EventBus, task_id: str, sub: _Subscription) -> None:
        self._bus = bus
        self._task_id = task_id
        self._sub = sub

    async def __aenter__(self) -> "_SubscriberHandle":
        return self

    async def __aexit__(self, *exc_info) -> None:
        self._bus.close(self._task_id, self._sub)
        # Wake any pending iterator so it can exit promptly.
        try:
            self._sub.queue.put_nowait(None)
        except asyncio.QueueFull:
            pass

    @property
    def dropped(self) -> int:
        return self._sub.dropped

    async def next_event(self, timeout: float | None = None) -> dict[str, Any] | None:
        """Wait for the next event; ``None`` on timeout or close."""
        try:
            if timeout is None:
                item = await self._sub.queue.get()
            else:
                item = await asyncio.wait_for(self._sub.queue.get(), timeout=timeout)
        except asyncio.TimeoutError:
            return None
        return item


_bus: EventBus | None = None


def get_event_bus() -> EventBus:
    """Process-wide bus singleton."""
    global _bus
    if _bus is None:
        _bus = EventBus()
    return _bus
