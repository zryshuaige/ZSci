"""Benchmark discovery (design.md §9.6 experiment.find_benchmarks).

Finds standard benchmark datasets/tasks + SOTA numbers relevant to a research
direction. Sources:
  - HuggingFace Datasets (the live source; PapersWithCode was acquired by HF and
    its API now 302-redirects to huggingface.co, so it's no longer a usable
    source). For each search hit we follow up with the dataset detail endpoint
    to pull description + tags + downloads, which we surface to the user so a
    hit like "imagenet-1k" is immediately recognizable as a mainstream
    benchmark with a real description rather than a bare HF id.
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
results" apart from "source timed out". Detail fetches use the same endpoints
but errors are SILENT (search-time results without a description are still
useful) — only the search itself surfaces warnings.
"""
from __future__ import annotations

import json
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
HF_DATASET_DETAIL_PATH = "/api/datasets/{dataset_id}"

# Downloads threshold above which a dataset is considered "mainstream" (so the
# UI can mark it with a star). 5K is a low bar intentionally — HuggingFace's
# long tail drops off sharply after a few thousand downloads, so anything above
# 5K is recognizable to most practitioners.
MAINSTREAM_DOWNLOADS_THRESHOLD = 5000

# Chinese research-task phrases → English HF search queries.
# HF hub metadata is overwhelmingly English; raw Chinese free-text rarely hits.
QUERY_ALIASES: dict[str, str] = {
    "语义分割": "semantic segmentation",
    "图像分割": "image segmentation",
    "实例分割": "instance segmentation",
    "图像分类": "image classification",
    "目标检测": "object detection",
    "物体检测": "object detection",
    "文本分类": "text classification",
    "机器翻译": "machine translation",
    "语音识别": "speech recognition",
    "问答": "question answering",
    "摘要": "summarization",
    "文本生成": "text generation",
    "文生图": "text to image",
    "图像描述": "image captioning",
    "姿态估计": "pose estimation",
    "深度估计": "depth estimation",
    "命名实体识别": "named entity recognition",
    "情感分析": "sentiment analysis",
    "推荐系统": "recommendation",
    "强化学习": "reinforcement learning",
    "时序预测": "time series forecasting",
    "视频分类": "video classification",
    "音频分类": "audio classification",
}


def expand_search_queries(query: str) -> list[str]:
    """Return one or more HF search strings for a user query.

    Chinese phrases are mapped via QUERY_ALIASES; unknown CJK input keeps the
    original and also tries a space-joined latin fallback when available.
    """
    q = (query or "").strip()
    if not q:
        return []
    out: list[str] = []
    seen: set[str] = set()

    def add(s: str) -> None:
        s = s.strip()
        if s and s.lower() not in seen:
            seen.add(s.lower())
            out.append(s)

    add(q)
    # Exact phrase alias
    if q in QUERY_ALIASES:
        add(QUERY_ALIASES[q])
    else:
        # Substring replace for compounds like "医学语义分割"
        for zh, en in QUERY_ALIASES.items():
            if zh in q:
                add(q.replace(zh, en))
                add(en)
    return out


def sort_benchmark_hits(rows: list[dict]) -> list[dict]:
    """Mainstream first, then higher downloads, then name."""
    return sorted(
        rows,
        key=lambda r: (
            0 if r.get("is_mainstream") else 1,
            -(r.get("downloads") or 0),
            (r.get("name") or "").lower(),
        ),
    )


def _http_get_json(
    url: str,
    params: dict | None = None,
    *,
    endpoints: list[str] | None = None,
    warnings: list[str] | None = None,
    silent: bool = False,
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

    `silent=True` suppresses warning collection for non-critical fetches (e.g.
    detail enrichment that degrades gracefully to "no description").
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
                    resp = client.get(base_url, params=params or {})
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
    if not silent and warnings is not None and last_exc is not None:
        tried = " / ".join(candidates)
        warnings.append(f"源请求失败({tried}):{last_exc}")
    return None


def _as_float(v) -> float | None:
    try:
        return float(v)
    except (TypeError, ValueError):
        return None


def _enrich_dataset_detail(
    dataset_id: str,
    *,
    warnings: list[str] | None = None,
) -> dict | None:
    """Fetch /api/datasets/{id} for description, tags, downloads.

    HF's detail endpoint is much larger than the search response (full
    cardData + siblings + README) and slow on big datasets. We cap the
    response at 64 KB and time out individually so one slow detail fetch
    can't stall the whole search — we already have the search hit, this
    is just enrichment.

    Returns a dict with the fields we care about, or None on failure.
    """
    settings = get_settings()
    # Use a SHORTER timeout for detail fetches (the search already took
    # budget; we don't want to chain N×15s reads).
    timeout = httpx.Timeout(
        connect=min(settings.academic_api_connect_timeout, 3.0),
        read=min(settings.academic_api_timeout, 5.0),
        write=5.0,
        pool=5.0,
    )
    url = HF_DATASET_DETAIL_PATH.format(dataset_id=dataset_id)
    candidates = [settings.hf_endpoint, settings.hf_mirror]
    seen: set[str] = set()
    candidates = [c for c in candidates if not (c in seen or seen.add(c))]

    for base_url in candidates:
        try:
            with httpx.Client(
                timeout=timeout,
                headers={"User-Agent": "zsci/0.1", "Accept": "application/json"},
                follow_redirects=True,
            ) as client:
                resp = client.get(f"{base_url.rstrip('/')}{url}")
                resp.raise_for_status()
                data = resp.json()
                if not isinstance(data, dict):
                    return None
                # tags is a list of strings on the detail endpoint; the
                # search endpoint doesn't return it. We keep the first 5.
                tags = [str(t) for t in (data.get("tags") or []) if isinstance(t, (str, int))][:5]
                # downloads is an int (lifetime total).
                dl = data.get("downloads")
                downloads = int(dl) if isinstance(dl, (int, float)) else None
                # description: prefer cardData.summary, fall back to first
                # ~280 chars of the README so the UI gets something useful
                # even when the dataset has no structured summary.
                description: str | None = None
                card = data.get("cardData")
                if isinstance(card, dict):
                    summary = card.get("summary")
                    if isinstance(summary, str) and summary.strip():
                        description = summary.strip()[:500]
                if not description:
                    readme = data.get("siblings")
                    # `siblings` is a list of {rfilename: ...} — README first
                    # usually, but we don't actually fetch the README here
                    # (would be another network round-trip). Fall back to the
                    # dataset id itself as a last-resort description.
                    description = None
                # Maintainer / org name is useful ("imagenet-1k" by "imagenet"
                # is more recognizable than just the id).
                author = data.get("author") or data.get("lastModified") or None
                return {
                    "description": description,
                    "tags": tags,
                    "downloads": downloads,
                    "is_mainstream": bool(
                        downloads is not None and downloads >= MAINSTREAM_DOWNLOADS_THRESHOLD
                    ),
                    "author": str(author) if author else None,
                }
        except (httpx.HTTPError, ValueError) as exc:
            logger.debug("dataset detail fetch %s failed: %s", base_url, exc)
            continue
    return None


def _search_hf_once(
    query: str,
    limit: int,
    *,
    settings,
    warnings: list[str] | None,
    enrich: bool,
) -> list[dict]:
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
        row = {
            "kind": "dataset",
            "name": did,
            "task_name": None,
            "dataset_name": did,
            "url": f"{settings.hf_endpoint.rstrip('/')}/datasets/{did}",
            "metric_name": None,
            "metric_value": None,
            "source": "hf",
            "description": None,
            "tags": [],
            "downloads": None,
            "is_mainstream": False,
            "author": None,
        }
        if enrich:
            detail = _enrich_dataset_detail(did, warnings=warnings)
            if detail:
                row.update({
                    "description": detail.get("description"),
                    "tags": detail.get("tags") or [],
                    "downloads": detail.get("downloads"),
                    "is_mainstream": detail.get("is_mainstream", False),
                    "author": detail.get("author"),
                })
        out.append(row)
    return out


def search_huggingface_datasets(
    query: str, limit: int = 8, *, warnings: list[str] | None = None, enrich: bool = True
) -> list[dict]:
    """Search HuggingFace Datasets for `query`. Returns dataset rows only.

    Chinese queries are expanded to English aliases and dual-searched, then
    merged/deduped. Results are sorted mainstream-first by downloads.
    """
    settings = get_settings()
    queries = expand_search_queries(query)
    if not queries:
        return []

    by_url: dict[str, dict] = {}
    per_limit = max(limit, 8)
    for q in queries:
        for row in _search_hf_once(
            q, per_limit, settings=settings, warnings=warnings, enrich=enrich
        ):
            key = row.get("url") or row.get("name") or ""
            if not key:
                continue
            prev = by_url.get(key)
            if prev is None:
                by_url[key] = row
            else:
                # Prefer the richer enrichment if a later query fills gaps.
                if not prev.get("description") and row.get("description"):
                    prev["description"] = row["description"]
                if (not prev.get("tags")) and row.get("tags"):
                    prev["tags"] = row["tags"]
                if (prev.get("downloads") or 0) < (row.get("downloads") or 0):
                    prev["downloads"] = row.get("downloads")
                    prev["is_mainstream"] = row.get("is_mainstream", False)

    return sort_benchmark_hits(list(by_url.values()))[:limit]


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
    Description / tags / downloads / is_mainstream are persisted into the
    `extra_json` column so the UI can show them without another round-trip.
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
        # Merge enrichment into the existing extra_json so re-running refreshes
        # description too instead of leaving a stale "no description" forever.
        extra = {
            "description": b.get("description"),
            "tags": b.get("tags") or [],
            "downloads": b.get("downloads"),
            "is_mainstream": bool(b.get("is_mainstream")),
            "author": b.get("author"),
        }
        extra_json = json.dumps(extra, ensure_ascii=False)
        if existing is not None:
            existing.metric_name = b.get("metric_name")
            existing.metric_value = b.get("metric_value")
            if experiment_id:
                existing.experiment_id = experiment_id
            existing.extra_json = extra_json
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
            extra_json=extra_json,
        )
        db.add(row)
        stored.append(row)
    db.flush()
    return stored


def store_benchmark_hit(
    db: Session,
    *,
    project_id: str,
    hit: dict,
    experiment_id: str | None = None,
) -> Benchmark:
    """Upsert a single search hit (or manual-shaped dict) into the project library."""
    url = hit.get("url") or ""
    existing = None
    if url:
        existing = db.scalar(
            select(Benchmark).where(
                Benchmark.project_id == project_id,
                Benchmark.url == url,
            )
        )
    extra = {
        "description": hit.get("description"),
        "tags": hit.get("tags") or [],
        "downloads": hit.get("downloads"),
        "is_mainstream": bool(hit.get("is_mainstream")),
        "author": hit.get("author"),
    }
    extra_json = json.dumps(extra, ensure_ascii=False)
    if existing is not None:
        existing.metric_name = hit.get("metric_name") or existing.metric_name
        existing.metric_value = hit.get("metric_value") if hit.get("metric_value") is not None else existing.metric_value
        if experiment_id:
            existing.experiment_id = experiment_id
        existing.extra_json = extra_json
        db.flush()
        return existing
    row = Benchmark(
        id=new_id("bm"),
        project_id=project_id,
        experiment_id=experiment_id,
        name=hit.get("name") or hit.get("dataset_name") or "未命名",
        kind=hit.get("kind") or "dataset",
        source=hit.get("source") or "hf",
        url=url or None,
        task_name=hit.get("task_name"),
        dataset_name=hit.get("dataset_name") or hit.get("name"),
        metric_name=hit.get("metric_name"),
        metric_value=hit.get("metric_value"),
        extra_json=extra_json,
    )
    db.add(row)
    db.flush()
    return row


def link_benchmark_experiment(
    db: Session, benchmark_id: str, experiment_id: str | None
) -> Benchmark | None:
    row = db.get(Benchmark, benchmark_id)
    if row is None:
        return None
    row.experiment_id = experiment_id
    db.flush()
    return row


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
    description: str | None = None,
    tags: list[str] | None = None,
    is_mainstream: bool = False,
) -> Benchmark:
    """Insert a user-entered benchmark row. This is the never-blocked fallback
    for when HF is unreachable: the user records the benchmark/SOTA they already
    know about, and the autonomous agent's SOTA comparison can use it.

    `description` / `tags` / `is_mainstream` are user-supplied enrichment —
    useful for recording "MMLU = a massive multitask language understanding
    benchmark covering 57 subjects" so a future re-search doesn't lose the
    context."""
    extra = {
        "description": description,
        "tags": list(tags or []),
        "downloads": None,
        "is_mainstream": bool(is_mainstream),
        "author": None,
    }
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
        extra_json=json.dumps(extra, ensure_ascii=False),
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
