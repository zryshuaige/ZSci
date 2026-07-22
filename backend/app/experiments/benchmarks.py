"""Benchmark discovery (design.md §9.6 experiment.find_benchmarks).

Finds standard benchmark datasets/tasks + SOTA leaderboard numbers relevant to a
research direction, via PapersWithCode (tasks/datasets/evaluations) and
HuggingFace Datasets. All calls are read-only; failures degrade to an empty
result + warning rather than blocking the agent.
"""
from __future__ import annotations

import logging

import httpx
from sqlalchemy import select
from sqlalchemy.orm import Session

from app.config import get_settings
from app.db.models import Benchmark
from app.utils import new_id

logger = logging.getLogger("zsci.experiments.benchmarks")

PWC_SEARCH = "https://paperswithcode.com/api/v1/search/"
HF_DATASETS = "https://huggingface.co/api/datasets"


def _http_get_json(url: str, params: dict) -> dict | list | None:
    settings = get_settings()
    try:
        with httpx.Client(
            timeout=settings.academic_api_timeout,
            headers={"User-Agent": "zsci/0.1", "Accept": "application/json"},
        ) as client:
            resp = client.get(url, params=params)
            resp.raise_for_status()
            return resp.json()
    except (httpx.HTTPError, ValueError) as exc:
        logger.warning("benchmark fetch %s failed: %s", url, exc)
        return None


def _as_float(v) -> float | None:
    try:
        return float(v)
    except (TypeError, ValueError):
        return None


def search_paperswithcode(query: str, limit: int = 8) -> list[dict]:
    """Search PapersWithCode for tasks/datasets/SOTA matching `query`.

    The search endpoint returns one entry per (paper, task, dataset) tuple with
    an optional `evaluation` carrying the SOTA metric+value. We normalize into
    one row per kind (task / dataset / sota). Fields are parsed defensively
    since PWC's response shape varies by result.
    """
    data = _http_get_json(PWC_SEARCH, {"q": query, "page": 1})
    if not isinstance(data, dict):
        return []
    out: list[dict] = []
    for item in data.get("results", [])[:limit]:
        if not isinstance(item, dict):
            continue
        task = item.get("task") or {}
        dataset = item.get("dataset") or {}
        evaluation = item.get("evaluation") or {}
        task_name = task.get("name") if isinstance(task, dict) else None

        if task_name:
            out.append({
                "kind": "task",
                "name": task_name,
                "task_name": task_name,
                "dataset_name": dataset.get("name") if isinstance(dataset, dict) else None,
                "url": task.get("url"),
                "metric_name": None,
                "metric_value": None,
                "source": "paperswithcode",
            })
        if isinstance(dataset, dict) and dataset.get("name"):
            out.append({
                "kind": "dataset",
                "name": dataset["name"],
                "task_name": task_name,
                "dataset_name": dataset["name"],
                "url": dataset.get("url"),
                "metric_name": None,
                "metric_value": None,
                "source": "paperswithcode",
            })
        if isinstance(evaluation, dict) and evaluation.get("metric"):
            metric_name = (
                evaluation["metric"].get("name")
                if isinstance(evaluation.get("metric"), dict)
                else str(evaluation["metric"])
            )
            val = _as_float(evaluation.get("value"))
            if metric_name and val is not None:
                out.append({
                    "kind": "sota",
                    "name": f"{task_name or 'task'} SOTA",
                    "task_name": task_name,
                    "dataset_name": dataset.get("name") if isinstance(dataset, dict) else None,
                    "url": evaluation.get("paper_url") or (task.get("url") if isinstance(task, dict) else None),
                    "metric_name": metric_name,
                    "metric_value": val,
                    "source": "paperswithcode",
                })
    return out


def search_huggingface_datasets(query: str, limit: int = 8) -> list[dict]:
    """Search HuggingFace Datasets for `query`. Returns dataset rows only."""
    data = _http_get_json(HF_DATASETS, {"search": query, "limit": limit})
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
            "url": f"https://huggingface.co/datasets/{did}",
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
) -> list[Benchmark]:
    """Search PWC + HF for benchmarks relevant to `query`, upsert into the
    benchmarks table (dedup by project_id + url), return the stored rows.

    Re-running refreshes metric_name/metric_value and links experiment_id
    without creating duplicate rows.
    """
    found = search_paperswithcode(query, limit=limit) + search_huggingface_datasets(query, limit=limit)
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
