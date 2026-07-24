"""Regression tests for the ideas bulk-insert endpoint.

Pins down the `content` field contract: the backend `BulkIdeaIn.content` is a
dict (the router json.dumps() it into the TEXT column), so sending a
pre-serialized JSON string must be rejected with INPUT_INVALID, while sending
an object must succeed and be stored as a JSON string. This is the bug that
previously blocked the Multi-Idea -> experiment handoff (ExploreIdeasPage was
sending JSON.stringify(content)).
"""
from __future__ import annotations

import json


def test_bulk_insert_accepts_dict_content(project, client):
    project_id = project["id"]
    resp = client.post(
        f"/api/v1/projects/{project_id}/ideas/bulk",
        json={
            "ideas": [
                {
                    "title": "不确定性-多样性混合采样",
                    "hypothesis": "hybrid beats single-strategy sampling",
                    "content": {  # dict, NOT a JSON string
                        "feasibility": 3,
                        "novelty": 1,
                        "est_cost": "low",
                        "baseline_methods": ["不确定性采样", "随机采样"],
                    },
                    "status": "adopted",
                }
            ]
        },
    )
    assert resp.status_code == 201, resp.text
    body = resp.json()
    assert len(body["inserted"]) == 1
    idea = body["inserted"][0]
    # Stored as a JSON string in the TEXT column, round-trips back to the dict.
    parsed = json.loads(idea["content"])
    assert parsed["est_cost"] == "low"
    assert parsed["feasibility"] == 3
    assert parsed["baseline_methods"] == ["不确定性采样", "随机采样"]


def test_bulk_insert_rejects_string_content(project, client):
    """A pre-serialized JSON string is the wrong shape and must be rejected."""
    project_id = project["id"]
    resp = client.post(
        f"/api/v1/projects/{project_id}/ideas/bulk",
        json={
            "ideas": [
                {
                    "title": "bad payload",
                    "content": json.dumps({"feasibility": 3}),  # string, not dict
                }
            ]
        },
    )
    assert resp.status_code == 422, resp.text
    body = resp.json()
    # Friendly envelope: code + user_message, not a raw traceback.
    assert body["code"] == "INPUT_INVALID"
    assert "content" in body["user_message"]


def test_bulk_insert_skips_empty_rows(project, client):
    project_id = project["id"]
    resp = client.post(
        f"/api/v1/projects/{project_id}/ideas/bulk",
        json={
            "ideas": [
                {"title": "real idea", "hypothesis": "h"},
                {"title": None, "hypothesis": None},  # nothing to research
            ]
        },
    )
    assert resp.status_code == 201, resp.text
    body = resp.json()
    assert len(body["inserted"]) == 1
    assert body["skipped"] == [1]
