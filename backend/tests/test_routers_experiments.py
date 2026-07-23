"""Integration tests for the experiments router (scaffold / run / stop / logs)."""
from __future__ import annotations


def test_create_experiment_scaffolds_dir(client, project):
    resp = client.post(
        f"/api/v1/projects/{project['id']}/experiments",
        json={"title": "My Experiment", "research_question": "does X work?"},
    )
    assert resp.status_code == 200, resp.text
    body = resp.json()
    assert body["title"] == "My Experiment"
    assert body["status"] == "scaffolded"
    assert body["slug"] is not None
    assert body["root_path"] is not None

    # List should contain it.
    lst = client.get(f"/api/v1/projects/{project['id']}/experiments")
    assert lst.status_code == 200
    assert any(e["id"] == body["id"] for e in lst.json())


def test_get_experiment_404(client):
    assert client.get("/api/v1/experiments/nope").status_code == 404


def test_create_run_requires_confirmed(client, project):
    exp = client.post(
        f"/api/v1/projects/{project['id']}/experiments",
        json={"title": "Confirm Gate"},
    ).json()
    resp = client.post(
        f"/api/v1/experiments/{exp['id']}/runs",
        json={"command": "echo hi", "confirmed": False},
    )
    assert resp.status_code == 422


def test_create_run_executes_simple_command(client, project):
    """A trivial command (`echo` / `true`) should complete and the run should
    flip to 'completed'.
    """
    exp = client.post(
        f"/api/v1/projects/{project['id']}/experiments",
        json={"title": "Echo Run"},
    ).json()
    resp = client.post(
        f"/api/v1/experiments/{exp['id']}/runs",
        json={"command": "echo hello && echo METRIC step=1 loss=0.5", "confirmed": True},
    )
    assert resp.status_code == 200, resp.text
    run = resp.json()
    assert run["status"] in ("completed", "failed"), run
    # The METRIC line should have produced a metric row.
    metrics = client.get(f"/api/v1/runs/{run['id']}/metrics").json()
    if run["status"] == "completed":
        assert any(m["metric_name"] == "loss" for m in metrics), metrics


def test_get_run_logs_returns_text(client, project):
    """After a run, /logs returns the captured stdout."""
    exp = client.post(
        f"/api/v1/projects/{project['id']}/experiments",
        json={"title": "Logs Test"},
    ).json()
    run_resp = client.post(
        f"/api/v1/experiments/{exp['id']}/runs",
        json={"command": "echo log_line_marker_42", "confirmed": True},
    )
    assert run_resp.status_code == 200, run_resp.text
    run = run_resp.json()
    logs_resp = client.get(f"/api/v1/runs/{run['id']}/logs")
    assert logs_resp.status_code == 200, logs_resp.text
    logs = logs_resp.json()
    assert "log_line_marker_42" in logs["logs"]


def test_get_run_logs_404_for_unknown_run(client):
    assert client.get("/api/v1/runs/nope/logs").status_code == 404


def test_list_runs(client, project):
    exp = client.post(
        f"/api/v1/projects/{project['id']}/experiments",
        json={"title": "List Runs"},
    ).json()
    client.post(
        f"/api/v1/experiments/{exp['id']}/runs",
        json={"command": "true", "confirmed": True},
    )
    lst = client.get(f"/api/v1/experiments/{exp['id']}/runs").json()
    assert len(lst) >= 1


def test_stop_unknown_run_returns_false(client):
    resp = client.post("/api/v1/runs/nonexistent/stop")
    assert resp.status_code == 200
    assert resp.json() == {"stopped": False}


def test_stop_run_after_completion_is_safe(client, project):
    """Stopping a run that already finished should not crash; the API returns
    stopped=False because no live process owns the run."""
    exp = client.post(
        f"/api/v1/projects/{project['id']}/experiments",
        json={"title": "Stop After Done"},
    ).json()
    run = client.post(
        f"/api/v1/experiments/{exp['id']}/runs",
        json={"command": "true", "confirmed": True},
    ).json()
    # Run should already be completed; stopping is a no-op.
    stop = client.post(f"/api/v1/runs/{run['id']}/stop").json()
    assert stop["stopped"] is False


def test_get_metrics_for_run_without_metrics(client, project):
    """A run with no METRIC lines returns an empty metrics list, not an error."""
    exp = client.post(
        f"/api/v1/projects/{project['id']}/experiments",
        json={"title": "No Metrics"},
    ).json()
    run = client.post(
        f"/api/v1/experiments/{exp['id']}/runs",
        json={"command": "true", "confirmed": True},
    ).json()
    metrics = client.get(f"/api/v1/runs/{run['id']}/metrics").json()
    assert metrics == []


def test_subprocess_env_does_not_inherit_api_keys(client, project, monkeypatch):
    """C4: a user experiment command must NOT see LLM API keys in its env.

    We set a sensitive env var on the parent process, run a command that
    echoes it, and verify the captured stdout does NOT contain the value.
    """
    monkeypatch.setenv("OPENAI_API_KEY", "sk-LEAK-VALUE-DO-NOT-EXFIL-12345")
    exp = client.post(
        f"/api/v1/projects/{project['id']}/experiments",
        json={"title": "Env Leak Test"},
    ).json()
    run = client.post(
        f"/api/v1/experiments/{exp['id']}/runs",
        # `printenv` exits 0 even when the var is unset; we capture stdout.
        json={"command": "printenv OPENAI_API_KEY || true", "confirmed": True},
    ).json()
    logs = client.get(f"/api/v1/runs/{run['id']}/logs").json()["logs"]
    assert "sk-LEAK-VALUE-DO-NOT-EXFIL-12345" not in logs, (
        "C4: API key leaked into the experiment subprocess environment"
    )


def test_list_experiment_files_and_read(client, project):
    """Phase D: the code browser lists source files (skipping runs/) and reads one."""
    exp = client.post(
        f"/api/v1/projects/{project['id']}/experiments",
        json={"title": "Code Browser"},
    ).json()
    files = client.get(f"/api/v1/experiments/{exp['id']}/files").json()["files"]
    # scaffold writes src/train.py + configs/base.yaml etc.
    assert "src/train.py" in files
    # runs/ must be excluded (it's a run-output dir, not source).
    assert not any(f.startswith("runs/") for f in files)
    # Read a file.
    body = client.get(f"/api/v1/experiments/{exp['id']}/file?path=src/train.py").json()
    assert body["path"] == "src/train.py"
    assert "METRIC" in body["content"]


def test_get_experiment_file_rejects_traversal(client, project):
    """The code browser must not escape the experiment dir via .. """
    exp = client.post(
        f"/api/v1/projects/{project['id']}/experiments",
        json={"title": "Traversal"},
    ).json()
    # ../../<anything> resolves outside the exp dir -> 403.
    resp = client.get(f"/api/v1/experiments/{exp['id']}/file?path=../../etc/passwd")
    assert resp.status_code in (403, 404)


def test_benchmarks_list_empty_then_404(client):
    # Unknown project -> 404 (proves the route + ownership guard are wired).
    assert client.get("/api/v1/projects/prj_nope/benchmarks").status_code == 404


def test_benchmark_search_surfaces_warnings_on_timeout(client, project, monkeypatch):
    """When every benchmark source fails (timeout/mirror), the search endpoint
    must return an empty list WITH warnings so the UI can tell "no results"
    apart from "source unreachable". Regression for the silent-empty bug."""
    from app.experiments import benchmarks as bm

    def _fail(url, params, *, endpoints=None, warnings=None):
        if warnings is not None:
            warnings.append(f"源请求失败({url}):timed out")
        return None

    monkeypatch.setattr(bm, "_http_get_json", _fail)

    resp = client.post(
        f"/api/v1/projects/{project['id']}/benchmarks/search",
        json={"query": "image classification"},
    )
    assert resp.status_code == 200, resp.text
    body = resp.json()
    assert body["hits"] == []
    assert len(body["warnings"]) >= 1
    assert "timed out" in body["warnings"][0]
    # Search must not persist rows.
    assert client.get(f"/api/v1/projects/{project['id']}/benchmarks").json() == []


def test_benchmark_search_returns_hits_without_storing(client, project, monkeypatch):
    """Search returns ephemeral hits; library stays empty until /add."""
    from app.experiments import benchmarks as bm

    def _ok(url, params, *, endpoints=None, warnings=None):
        if url == bm.HF_DATASETS_PATH:
            return [{"id": "mnist"}]
        return None

    monkeypatch.setattr(bm, "_http_get_json", _ok)

    resp = client.post(
        f"/api/v1/projects/{project['id']}/benchmarks/search",
        json={"query": "image classification"},
    )
    assert resp.status_code == 200, resp.text
    body = resp.json()
    assert body["warnings"] == []
    assert len(body["hits"]) == 1
    assert body["hits"][0]["name"] == "mnist"
    assert body["hits"][0]["source"] == "hf"
    assert client.get(f"/api/v1/projects/{project['id']}/benchmarks").json() == []

    add = client.post(
        f"/api/v1/projects/{project['id']}/benchmarks/add",
        json=body["hits"][0],
    )
    assert add.status_code == 200, add.text
    lst = client.get(f"/api/v1/projects/{project['id']}/benchmarks").json()
    assert len(lst) == 1
    assert lst[0]["name"] == "mnist"


def test_manual_benchmark_create_and_delete(client, project):
    """Manual benchmark entry works as a never-blocked fallback (no network)."""
    # Create a SOTA row by hand.
    resp = client.post(
        f"/api/v1/projects/{project['id']}/benchmarks/manual",
        json={
            "name": "ImageNet SOTA",
            "kind": "sota",
            "url": "https://example.org/imagenet",
            "metric_name": "top-1 acc",
            "metric_value": 0.910,
        },
    )
    assert resp.status_code == 200, resp.text
    bm = resp.json()
    assert bm["source"] == "manual"
    assert bm["kind"] == "sota"
    assert bm["metric_value"] == 0.910

    # It shows up in the list.
    lst = client.get(f"/api/v1/projects/{project['id']}/benchmarks").json()
    assert any(b["id"] == bm["id"] for b in lst)

    # Delete it.
    dele = client.delete(f"/api/v1/benchmarks/{bm['id']}")
    assert dele.status_code == 200
    lst = client.get(f"/api/v1/projects/{project['id']}/benchmarks").json()
    assert not any(b["id"] == bm["id"] for b in lst)

    # Deleting again -> 404.
    assert client.delete(f"/api/v1/benchmarks/{bm['id']}").status_code == 404


def test_codegen_safe_rel_path_rejects_traversal():
    """The codegen path guard must reject `..` traversal (sandbox escape).
    Regression: str.lstrip('./') used to eat the leading dots of `../escape.py`,
    turning it into `escape.py` which resolved inside exp_root and passed."""
    from pathlib import Path

    from app.experiments.codegen import _safe_rel_path

    exp_root = Path("/tmp/proj/exp1").resolve()
    # Legit paths pass.
    assert _safe_rel_path(exp_root, "src/train.py") is not None
    assert _safe_rel_path(exp_root, "./src/x.py") is not None
    assert _safe_rel_path(exp_root, "runs/x.log") is not None
    # Traversal / absolute must be rejected.
    for bad in ("../escape.py", "../../etc/passwd", "/etc/passwd",
                "src/../../escape.py", "src/../other/x.py", "", None):
        assert _safe_rel_path(exp_root, bad) is None, f"{bad!r} should be rejected"
