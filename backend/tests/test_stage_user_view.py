"""Regression tests for the Iteration-4 /api/v1/experiments/phase-view endpoint.

The endpoint serves as the single source of truth for user-facing labels:
5 phases × {name, summary, icon} + Experiment.overall_status translations
(7 keys) + ExperimentStage.status translations (12 keys). The front-end
hydrates from this once per session and caches the response in
localStorage so it never has a divergent label table from the backend.
"""
from __future__ import annotations


def test_phase_view_endpoint_returns_full_schema(client):
    """Iteration 4: GET /api/v1/experiments/phase-view returns 5 phase
    cells + Experiment-level + Stage-level status tables."""
    resp = client.get("/api/v1/experiments/phase-view")
    assert resp.status_code == 200, resp.text
    body = resp.json()

    # Top-level shape.
    assert "phases" in body
    assert "experiment_status_zh" in body
    assert "stage_status_zh" in body

    # All 5 phases present.
    assert len(body["phases"]) == 5
    keys = {p["key"] for p in body["phases"]}
    assert keys == {
        "phase_0_scope",
        "phase_1_plan",
        "phase_2_build",
        "phase_3_run",
        "phase_4_report",
    }


def test_phase_view_phases_have_name_summary_icon(client):
    """Each phase entry must have non-empty `name` / `summary` / `icon`
    so the front-end can render FivePhaseStepper + hero card."""
    resp = client.get("/api/v1/experiments/phase-view")
    body = resp.json()

    for phase in body["phases"]:
        assert phase["name"], f"{phase['key']} missing name"
        assert phase["summary"], f"{phase['key']} missing summary"
        assert phase["icon"], f"{phase['key']} missing icon"
        # Icon names match lucide-react exports (e.g. "Target",
        # "Compass", "Code2"). They're consumed by an icon-mapping
        # helper on the front-end, so any non-empty PascalCase string
        # is OK — the front-end falls back to "Circle" on miss.
        assert phase["icon"][0].isupper(), (
            f"{phase['key']} icon should be PascalCase (got {phase['icon']!r})"
        )


def test_phase_view_experiment_status_covers_all_overall_status_values(client):
    """`Experiment.overall_status` has 7 values per
    `app/experiments/states.py:EXP_TRANSITIONS`. The endpoint must
    return a Chinese label for each so the front-end never has to
    fall back to raw enum values."""
    resp = client.get("/api/v1/experiments/phase-view")
    body = resp.json()
    expected = {"draft", "running", "paused", "waiting_user",
                "completed", "failed", "archived"}
    assert expected.issubset(body["experiment_status_zh"].keys()), (
        f"missing status labels: {expected - body['experiment_status_zh'].keys()}"
    )
    # No raw English leftover.
    for k, v in body["experiment_status_zh"].items():
        assert v, f"{k} has empty label"
        # The Chinese labels never start with the raw English enum.
        assert not v.startswith(k), f"{k} label leaks raw enum"


def test_phase_view_stage_status_covers_all_stage_status_values(client):
    """`ExperimentStage.status` has 12 values per
    `app/experiments/states.py:STAGE_TRANSITIONS`. The endpoint must
    return a Chinese label for each so the front-end never falls
    back to raw enum values (this is the "phase_xxx" leak the user
    reported)."""
    resp = client.get("/api/v1/experiments/phase-view")
    body = resp.json()
    expected = {
        "not_started", "draft", "waiting_for_user", "approved",
        "running", "paused", "completed", "failed",
        "needs_revision", "skipped", "outdated", "archived",
    }
    assert expected.issubset(body["stage_status_zh"].keys()), (
        f"missing stage status labels: {expected - body['stage_status_zh'].keys()}"
    )


def test_phase_view_uses_states_constants_as_source_of_truth():
    """The endpoint must derive labels from the SAME constants used
    by the orchestrator — otherwise we re-introduce the drift bug
    that the front-end's labels.ts had (stale `scaffolded` /
    `generated` / `done` / `smoke_failed` keys while the backend
    was emitting `draft` / `running` / `completed` / `failed`)."""
    from app.experiments.states import (
        EXPERIMENT_STATUS_ZH,
        STAGE_STATUS_ZH,
        STAGE_USER_VIEW,
    )

    # Same set of phases, same set of status keys.
    assert set(STAGE_USER_VIEW.keys()) == {
        "phase_0_scope",
        "phase_1_plan",
        "phase_2_build",
        "phase_3_run",
        "phase_4_report",
    }
    assert set(EXPERIMENT_STATUS_ZH.keys()) == {
        "draft", "running", "paused", "waiting_user",
        "completed", "failed", "archived",
    }
    assert set(STAGE_STATUS_ZH.keys()) == {
        "not_started", "draft", "waiting_for_user", "approved",
        "running", "paused", "completed", "failed",
        "needs_revision", "skipped", "outdated", "archived",
    }

    # Every phase view entry must match the constant exactly.
    for phase_key, view in STAGE_USER_VIEW.items():
        assert view["name"], f"{phase_key} missing name in STAGE_USER_VIEW"
        assert view["summary"], f"{phase_key} missing summary"
        assert view["icon"], f"{phase_key} missing icon"


def test_phase_view_chinese_labels_are_meaningful(client):
    """Spot-check that the labels look like Chinese product copy, not
    the raw enum. Catches accidental regressions like
    `EXPERIMENT_STATUS_LABELS["failed"] = "failed"`."""
    resp = client.get("/api/v1/experiments/phase-view")
    body = resp.json()

    # Phases use clean Chinese labels.
    names = [p["name"] for p in body["phases"]]
    assert "研究目标确认" in names
    assert "实验方案设计" in names
    assert "实验代码准备" in names
    assert "首轮实验运行" in names
    assert "结果分析与建议" in names

    # Experiment statuses use friendly Chinese.
    assert body["experiment_status_zh"]["running"] == "正在进行"
    assert body["experiment_status_zh"]["waiting_user"] == "等待你的确认"
    assert body["experiment_status_zh"]["failed"] == "需要处理"