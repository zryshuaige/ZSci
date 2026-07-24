"""Tests for /experiments/{exp_id}/next-steps (Phase D).

Verify that phase_4_report.outputs_json.analysis is mapped into the
user-facing NextStepsOut shape, with the recommendation -> judgement
mapping, best_metric extraction, and next_steps[] templating covered.
"""
from __future__ import annotations


def _make_experiment(client, project, **overrides):
    body = {
        "title": "Next Steps Test",
        "research_question": "Does X improve Y?",
        "hypothesis": "X reduces training time without accuracy loss",
    }
    body.update(overrides)
    return client.post(
        f"/api/v1/projects/{project['id']}/experiments",
        json=body,
    ).json()


def _seed_report_stage(db, experiment_id: str, outputs: dict) -> None:
    from app.experiments.stages import upsert_stage

    upsert_stage(
        db,
        experiment_id=experiment_id,
        stage_key="phase_4_report",
        status="completed",
        outputs=outputs,
    )
    db.commit()


def test_next_steps_404_for_unknown_experiment(client):
    resp = client.get("/api/v1/experiments/no-such-exp/next-steps")
    assert resp.status_code == 404, resp.text


def test_next_steps_empty_when_phase_4_report_missing(client, project):
    exp = _make_experiment(client, project)
    resp = client.get(f"/api/v1/experiments/{exp['id']}/next-steps")
    assert resp.status_code == 200, resp.text
    body = resp.json()
    assert body["has_analysis"] is False
    assert body["next_steps"] == []
    assert body["metrics"] == {}


def test_next_steps_maps_recommendation_to_judgement(client, project, db_session):
    exp = _make_experiment(client, project)
    _seed_report_stage(
        db_session,
        exp["id"],
        {
            "analysis": {
                "recommendation": "iterate",
                "best_metric": {"name": "acc", "value": 0.84},
                "ai_judgement": "观察到一定改善,但方差仍较大。",
                "next_steps": [
                    "扩大数据集与测试场景",
                    "调整训练超参数并复跑",
                    "尝试新方向作为分支",
                ],
                "risks": ["单次结果可能波动"],
            }
        },
    )
    resp = client.get(f"/api/v1/experiments/{exp['id']}/next-steps").json()
    assert resp["has_analysis"] is True
    assert resp["judgement"] == "adjust"
    assert resp["metrics"]["acc"] == 0.84
    assert resp["conclusion"] == "观察到一定改善,但方差仍较大。"
    titles = [s["title"] for s in resp["next_steps"]]
    assert "扩大数据集与测试场景" in titles
    assert len(resp["next_steps"]) == 3
    # template hints should be derived from the title text.
    templates = {s["title"]: s["template"] for s in resp["next_steps"]}
    assert templates["扩大数据集与测试场景"] == "change_dataset"
    assert templates["尝试新方向作为分支"] == "branch"
    assert templates["调整训练超参数并复跑"] == "iterate"


def test_next_steps_handles_dict_shaped_steps(client, project, db_session):
    exp = _make_experiment(client, project)
    _seed_report_stage(
        db_session,
        exp["id"],
        {
            "analysis": {
                "recommendation": "publish",
                "next_steps": [
                    {
                        "title": "起稿写作",
                        "description": "把本轮结论整理为可投稿版本",
                        "est_cost": "low",
                    }
                ],
            }
        },
    )
    resp = client.get(f"/api/v1/experiments/{exp['id']}/next-steps").json()
    assert resp["judgement"] == "continue"
    assert len(resp["next_steps"]) == 1
    step = resp["next_steps"][0]
    assert step["title"] == "起稿写作"
    assert step["description"] == "把本轮结论整理为可投稿版本"
    assert step["est_cost"] == "low"
    assert step["template"] == "into_writing"


def test_next_steps_falls_back_to_series_metrics(client, project, db_session):
    exp = _make_experiment(client, project)
    _seed_report_stage(
        db_session,
        exp["id"],
        {
            "analysis": {
                "recommendation": "inconclusive",
                "next_steps": [],
            },
            "series": [
                {"run_id": "r1", "status": "completed", "metrics": {"acc": 0.7}},
                {"run_id": "r2", "status": "completed", "metrics": {"acc": 0.9}},
            ],
        },
    )
    resp = client.get(f"/api/v1/experiments/{exp['id']}/next-steps").json()
    assert resp["has_analysis"] is True
    # analysis.best_metric missing → fall back to most recent series entry.
    assert resp["metrics"] == {"acc": 0.9}
    assert resp["judgement"] == "insufficient"
    assert resp["next_steps"] == []


def test_next_steps_does_not_leak_phase_key(client, project, db_session):
    """Sanity: response must not include any phase_* or stage_key."""
    exp = _make_experiment(client, project)
    _seed_report_stage(
        db_session,
        exp["id"],
        {"analysis": {"recommendation": "iterate", "next_steps": ["扩数据"]}},
    )
    resp = client.get(f"/api/v1/experiments/{exp['id']}/next-steps").json()
    for forbidden in ("stage_key", "phase_4_report", "outputs_json"):
        assert forbidden not in resp