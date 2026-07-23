"""Benchmark discovery (design.md §9.6 experiment.find_benchmarks).

Finds standard benchmark datasets/tasks + SOTA numbers relevant to a research
direction. Sources:
  - HuggingFace Datasets (the live source; PapersWithCode was acquired by HF and
    its API now 302-redirects to huggingface.co, so it's no longer a usable
    source).
  - Manual entry (POST .../benchmarks/manual) as the never-blocked fallback: if
    the network can't reach HF at all, the user can still record the benchmark
    they already know about, and the autonomous agent's SOTA comparison can use
    it.

Network resilience: huggingface.co is unreachable from some networks (e.g.
mainland China without a proxy). We try the configured endpoint first, then fall
back to the hf-mirror.com mirror. A dead host fails *fast* (connect error -> move
to the next candidate immediately, no retry) so a search doesn't hang for tens of
seconds; only a slow-but-alive host (read timeout) gets a single retry. When
every candidate fails we surface a human-readable warning so the UI can tell "no
results" apart from "source timed out".
"""
from __future__ import annotations

import logging
import time

import httpx
from sqlalchemy import select
from sqlalchemy.orm import Session

from app.config import get_settings
from app.db.models import Benchmark
from app.utils import new_id

logger = logging.getLogger("zsci.experiments.benchmarks")

HF_DATASETS_PATH = "/api/datasets"


def _http_get_json(
    url: str,
    params: dict,
    *,
    endpoints: list[str] | None = None,
    warnings: list[str] | None = None,
) -> dict | list | None:
    """GET JSON from `url`, trying mirror `endpoints` on connect failure.

    `endpoints` is the list of candidate base URLs (scheme+host) to try in order
    for this source; `url` is the path-only form (e.g. "/api/datasets"). If
    `endpoints` is None, `url` is used as-is (absolute). Candidates are de-duped
    so setting ZSCI_HF_ENDPOINT to the mirror collapses to a single attempt.

    Failure policy (the point of this helper): a connect error means the host is
    dead/unreachable - retrying it just burns the connect timeout N times, so we
    move to the next candidate immediately. Only a read timeout (host alive but
    slow) earns one retry. This keeps a search to ~connect_timeout + mirror RTT
    instead of retries × connect_timeout.
    """
    settings = get_settings()
    timeout = httpx.Timeout(
        connect=settings.academic_api_connect_timeout,
        read=settings.academic_api_timeout,
        write=5.0,
        pool=5.0,
    )
    # De-dupe while preserving order (ZSCI_HF_ENDPOINT == ZSCI_HF_MIRROR -> one).
    seen: set[str] = set()
    candidates: list[str] = []
    raw = [f"{base.rstrip('/')}{url}" for base in endpoints] if endpoints is not None else [url]
    for c in raw:
        if c not in seen:
            seen.add(c)
            candidates.append(c)

    last_exc: Exception | None = None
    for base_url in candidates:
        # One retry, but ONLY for a read timeout (slow host). Connect errors
        # break out to the next candidate right away.
        for attempt in range(2):
            try:
                with httpx.Client(
                    timeout=timeout,
                    headers={"User-Agent": "zsci/0.1", "Accept": "application/json"},
                    follow_redirects=True,
                ) as client:
                    resp = client.get(base_url, params=params)
                    resp.raise_for_status()
                    return resp.json()
            except (httpx.HTTPError, ValueError) as exc:
                last_exc = exc
                # Connect-level failure: host is dead, don't retry - try mirror.
                if isinstance(exc, (httpx.ConnectError, httpx.ConnectTimeout)):
                    break
                # Read timeout: the host answered but was slow - one retry.
                if isinstance(exc, httpx.ReadTimeout) and attempt == 0:
                    time.sleep(0.4)
                    continue
                # Anything else (4xx/5xx, parse error): no point retrying.
                break
        logger.warning("benchmark fetch %s failed: %s", base_url, last_exc)
    if warnings is not None and last_exc is not None:
        tried = " / ".join(candidates)
        warnings.append(f"源请求失败({tried}):{last_exc}")
    return None


def _as_float(v) -> float | None:
    try:
        return float(v)
    except (TypeError, ValueError):
        return None


def search_huggingface_datasets(
    query: str, limit: int = 8, *, warnings: list[str] | None = None
) -> list[dict]:
    """Search HuggingFace Datasets for `query`. Returns dataset rows only.

    Tries the configured endpoint first (official huggingface.co by default),
    then the mirror (hf-mirror.com) on connect failure/timeout so the search
    works on networks where huggingface.co is blocked. Set ZSCI_HF_ENDPOINT to
    the mirror to skip the dead-host wait entirely.
    """
    settings = get_settings()
    data = _http_get_json(
        HF_DATASETS_PATH,
        {"search": query, "limit": limit},
        endpoints=[settings.hf_endpoint, settings.hf_mirror],
        warnings=warnings,
    )
    if not isinstance(data, list):
        return []
    out: list[dict] = []
    for item in data[:limit]:
        if not isinstance(item, dict):
            continue
        did = item.get("id")
        if not did:
            continue
        out.append({
            "kind": "dataset",
            "name": did,
            "task_name": None,
            "dataset_name": did,
            # Link to the official dataset page; the mirror serves the same ids.
            "url": f"{settings.hf_endpoint.rstrip('/')}/datasets/{did}",
            "metric_name": None,
            "metric_value": None,
            "source": "hf",
        })
    return out


def find_and_store_benchmarks(
    db: Session,
    *,
    project_id: str,
    query: str,
    experiment_id: str | None = None,
    limit: int = 8,
    warnings: list[str] | None = None,
) -> list[Benchmark]:
    """Search HuggingFace for benchmarks relevant to `query`, upsert into the
    benchmarks table (dedup by project_id + url), return the stored rows.

    Re-running refreshes metric_name/metric_value and links experiment_id
    without creating duplicate rows. `warnings` (if given) collects human-readable
    messages about source failures so callers can surface them to the user.
    """
    found = search_huggingface_datasets(query, limit=limit, warnings=warnings)
    stored: list[Benchmark] = []
    for b in found:
        url = b.get("url") or ""
        existing = None
        if url:
            existing = db.scalar(
                select(Benchmark).where(
                    Benchmark.project_id == project_id,
                    Benchmark.url == url,
                )
            )
        if existing is not None:
            existing.metric_name = b.get("metric_name")
            existing.metric_value = b.get("metric_value")
            if experiment_id:
                existing.experiment_id = experiment_id
            stored.append(existing)
            continue
        row = Benchmark(
            id=new_id("bm"),
            project_id=project_id,
            experiment_id=experiment_id,
            name=b["name"],
            kind=b["kind"],
            source=b["source"],
            url=url or None,
            task_name=b.get("task_name"),
            dataset_name=b.get("dataset_name"),
            metric_name=b.get("metric_name"),
            metric_value=b.get("metric_value"),
        )
        db.add(row)
        stored.append(row)
    db.flush()
    return stored


def create_manual_benchmark(
    db: Session,
    *,
    project_id: str,
    name: str,
    kind: str = "dataset",
    url: str | None = None,
    task_name: str | None = None,
    dataset_name: str | None = None,
    metric_name: str | None = None,
    metric_value: float | None = None,
    experiment_id: str | None = None,
) -> Benchmark:
    """Insert a user-entered benchmark row. This is the never-blocked fallback
    for when HF is unreachable: the user records the benchmark/SOTA they already
    know about, and the autonomous agent's SOTA comparison can use it."""
    row = Benchmark(
        id=new_id("bm"),
        project_id=project_id,
        experiment_id=experiment_id,
        name=name,
        kind=kind,
        source="manual",
        url=url or None,
        task_name=task_name,
        dataset_name=dataset_name or name,
        metric_name=metric_name,
        metric_value=metric_value,
    )
    db.add(row)
    db.flush()
    return row


def delete_benchmark(db: Session, benchmark_id: str) -> bool:
    """Delete a benchmark row. Returns True if a row was removed."""
    row = db.get(Benchmark, benchmark_id)
    if row is None:
        return False
    db.delete(row)
    db.flush()
    return True
