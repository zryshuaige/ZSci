"""Tests for /experiments/{exp_id}/preview-plan (Phase C).

These tests verify the endpoint maps experiment_stages(stage_key='phase_1_plan')
.outputs_json into the user-facing PlanPreviewOut shape. Both the populated
case (plan ready) and the empty case (no plan yet) are covered.
"""
from __future__ import annotations


def _make_experiment(client, project, **overrides):
    body = {
        "title": "Preview Plan Test",
        "research_question": "Does X improve Y?",
        "hypothesis": "X reduces training time without accuracy loss",
    }
    body.update(overrides)
    return client.post(
        f"/api/v1/projects/{project['id']}/experiments",
        json=body,
    ).json()


def _seed_plan_stage(db, experiment_id: str, outputs: dict) -> None:
    from app.experiments.stages import upsert_stage

    upsert_stage(
        db,
        experiment_id=experiment_id,
        stage_key="phase_1_plan",
        status="completed",
        outputs=outputs,
    )
    db.commit()


def test_preview_plan_404_for_unknown_experiment(client):
    resp = client.get("/api/v1/experiments/no-such-exp/preview-plan")
    assert resp.status_code == 404, resp.text


def test_preview_plan_empty_when_phase_1_plan_missing(client, project):
    exp = _make_experiment(client, project)
    resp = client.get(f"/api/v1/experiments/{exp['id']}/preview-plan")
    assert resp.status_code == 200, resp.text
    body = resp.json()
    # No plan yet — endpoint returns has_plan=False and all other fields null/empty.
    assert body["has_plan"] is False
    assert body["goal"] is None
    assert body["metrics"] == []
    assert body["risks"] == []


def test_preview_plan_reads_phase_1_plan_outputs(client, project, db_session):
    exp = _make_experiment(client, project)
    _seed_plan_stage(
        db_session,
        exp["id"],
        {
            "goal": "验证 X 是否在 Z 上比基线更好",
            "hypothesis": "X 在保持精度的同时缩短训练时间",
            "metrics": [
                {"name": "acc", "definition": "准确率", "aggregation": "mean"},
                {"name": "f1"},
            ],
            "baselines": ["baseline", "no_aug"],
            "run_specs": ["baseline", "aug_v1", "aug_v2"],
            "fairness_note": "三组使用相同随机种子与相同数据划分",
            "compute_plan": "1 张中端 GPU,预计 2 小时",
            "risks": ["数据下载可能受限", "首轮小样本,结论有限"],
        },
    )

    resp = client.get(f"/api/v1/experiments/{exp['id']}/preview-plan")
    assert resp.status_code == 200, resp.text
    body = resp.json()
    assert body["has_plan"] is True
    assert body["goal"] == "验证 X 是否在 Z 上比基线更好"
    assert body["hypothesis"] == "X 在保持精度的同时缩短训练时间"
    # metrics with dict shape are flattened into PlanPreviewMetricOut;
    # the bare-string fallback also works.
    metric_names = [m["name"] for m in body["metrics"]]
    assert "acc" in metric_names
    assert "f1" in metric_names
    # scope derives from run_specs.
    assert body["scope"] is not None and "aug_v1" in body["scope"]
    assert body["compute_plan"] == "1 张中端 GPU,预计 2 小时"
    assert body["fairness_note"] == "三组使用相同随机种子与相同数据划分"
    assert "数据下载可能受限" in body["risks"]


def test_preview_plan_does_not_leak_phase_key_to_client(client, project, db_session):
    """Sanity: the response must not include any phase_* or stage_key
    identifiers — those are internal and should be hidden from the
    user-facing preview endpoint."""
    exp = _make_experiment(client, project)
    _seed_plan_stage(db_session, exp["id"], {"goal": "g", "hypothesis": "h"})
    resp = client.get(f"/api/v1/experiments/{exp['id']}/preview-plan").json()
    for forbidden in ("stage_key", "phase_1_plan", "phase_2_build"):
        assert forbidden not in resp