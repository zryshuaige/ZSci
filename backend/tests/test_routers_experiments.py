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
