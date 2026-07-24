"""Regression tests for the Iteration-4 research_question three-tier fallback.

Background
----------
The M30 implementation inherited the RQ from a related Idea only when the
caller OMITTED the `research_question` field. Two real bugs followed:

  - When the caller provided `"research_question": ""` (e.g. the
    ExploreIdeasPage "adopt candidate" flow, which always sends the
    field explicitly even when blank), the empty string was preserved
    instead of being supplemented from the Idea's hypothesis /
    motivation / title.
  - When the Idea had a `motivation` but no `hypothesis`, only the
    hypothesis lookup ran — and the experiment was silently created
    with `research_question = None`.

The Iteration-4 fix introduces a 3-tier fallback chain (hypothesis →
motivation → title) that fires only when the field is omitted (so
explicit empty strings still round-trip literally — the existing
"create empty → PATCH later" workflow keeps working) and adds a
friendly 422 guard for the "no RQ anywhere" case.

Each test below exercises one path through the chain.
"""
from __future__ import annotations


def _create_idea(client, project_id: str, **fields) -> str:
    body = {"title": "Test idea"}
    body.update(fields)
    resp = client.post(f"/api/v1/projects/{project_id}/ideas", json=body)
    assert resp.status_code in (200, 201), resp.text
    return resp.json()["id"]


def test_explicit_rq_wins_over_idea_hypothesis(client, project):
    """Case 1: caller provides a non-empty RQ → use it as-is, even when
    the related Idea has a different hypothesis."""
    idea_id = _create_idea(
        client, project["id"],
        hypothesis="from idea",
    )
    resp = client.post(
        f"/api/v1/projects/{project['id']}/experiments",
        json={
            "title": "Explicit wins",
            "related_idea_id": idea_id,
            "research_question": "from caller",
            "hypothesis": "from caller",
        },
    )
    assert resp.status_code in (200, 201), resp.text
    exp = resp.json()
    assert exp["research_question"] == "from caller"
    assert exp["hypothesis"] == "from caller"


def test_omitted_rq_inherits_from_idea_hypothesis(client, project):
    """Case 2: caller omits RQ + idea.hypothesis non-empty → inherit
    idea.hypothesis."""
    idea_id = _create_idea(
        client, project["id"],
        hypothesis="idea hypothesis text",
        motivation="idea motivation",
    )
    resp = client.post(
        f"/api/v1/projects/{project['id']}/experiments",
        json={"title": "Inherit hyp", "related_idea_id": idea_id},
    )
    assert resp.status_code in (200, 201), resp.text
    exp = resp.json()
    assert exp["research_question"] == "idea hypothesis text"
    assert exp["hypothesis"] == "idea motivation"


def test_omitted_rq_falls_back_to_idea_motivation(client, project):
    """Case 3: caller omits RQ + idea.hypothesis blank + idea.motivation
    non-empty → use motivation. Previously the M30 lookup would
    silently produce an experiment with RQ=None in this case."""
    idea_id = _create_idea(
        client, project["id"],
        hypothesis="",
        motivation="idea motivation fallback",
    )
    resp = client.post(
        f"/api/v1/projects/{project['id']}/experiments",
        json={"title": "Inherit motivation", "related_idea_id": idea_id},
    )
    assert resp.status_code in (200, 201), resp.text
    exp = resp.json()
    assert exp["research_question"] == "idea motivation fallback"


def test_omitted_rq_falls_back_to_idea_title(client, project):
    """Case 4: caller omits RQ + idea.hypothesis blank + idea.motivation
    blank + idea.title non-empty → use title."""
    idea_id = _create_idea(
        client, project["id"],
        title="Inherit from title",
        hypothesis="",
        motivation="",
    )
    resp = client.post(
        f"/api/v1/projects/{project['id']}/experiments",
        json={"title": "Inherit title", "related_idea_id": idea_id},
    )
    assert resp.status_code in (200, 201), resp.text
    exp = resp.json()
    assert exp["research_question"] == "Inherit from title"


def test_omitted_rq_no_idea_returns_422_with_friendly_copy(client, project):
    """Case 5: caller omits RQ + no related_idea_id → 422 with the
    friendly Chinese error message (no silent empty experiment)."""
    resp = client.post(
        f"/api/v1/projects/{project['id']}/experiments",
        json={"title": "No RQ"},
    )
    assert resp.status_code == 422, resp.text
    # The friendly copy explains the recovery path; not the technical
    # "research_question is empty" the user used to see.
    assert "研究" in resp.json()["detail"]
    assert "请先" in resp.json()["detail"]


def test_omitted_rq_idea_all_blank_returns_422(client, project):
    """Case 6: caller omits RQ + related_idea_id points at an Idea
    with every text field blank → 422. Even though an Idea exists, no
    text could be recovered, so the user is asked to provide an RQ
    explicitly.

    (If the Idea has a non-blank title, the 3-tier chain recovers
    that as the RQ — title is the last fall-back tier. We explicitly
    blank the title here to exercise the genuine "no recovery
    possible" case.)"""
    # The /ideas endpoint requires a non-empty title (validation
    # upstream). To exercise the all-blank case we bypass the API
    # and write the Idea row directly so the title is also blank.
    from app.db.models import Idea
    from app.db.session import get_sessionmaker

    with get_sessionmaker()() as db:
        idea_id = "idea-blank-all-fields"
        db.add(
            Idea(
                id=idea_id,
                project_id=project["id"],
                title="",
                hypothesis="",
                motivation="",
            )
        )
        db.commit()

    resp = client.post(
        f"/api/v1/projects/{project['id']}/experiments",
        json={"title": "Blank idea fallback", "related_idea_id": idea_id},
    )
    assert resp.status_code == 422, resp.text
    assert "研究" in resp.json()["detail"]


def test_explicit_empty_rq_rounds_trips_literally(client, project):
    """Case 7: caller provides `research_question: ""` + no idea →
    preserve the empty string verbatim (the "create empty → PATCH
    later" workflow must keep working)."""
    resp = client.post(
        f"/api/v1/projects/{project['id']}/experiments",
        json={"title": "Explicit empty", "research_question": "", "hypothesis": ""},
    )
    assert resp.status_code in (200, 201), resp.text
    exp = resp.json()
    assert exp["research_question"] == ""
    assert exp["hypothesis"] == ""


def test_explicit_empty_rq_with_idea_still_falls_back(client, project):
    """Case 8 (Iteration 4 only): caller provides empty RQ + has a
    valid Idea → fall back to the Idea. Previously the M30
    inheritance only fired for omitted fields, leaving an empty
    RQ experiment; the new behavior is "explicit blank → fall back
    to Idea". Caller-provided non-empty strings still win."""
    idea_id = _create_idea(
        client, project["id"],
        hypothesis="idea hypothesis text",
        motivation="idea motivation",
    )
    resp = client.post(
        f"/api/v1/projects/{project['id']}/experiments",
        json={
            "title": "Empty RQ + idea",
            "research_question": "",
            "related_idea_id": idea_id,
        },
    )
    # Empty explicit RQ is interpreted as "no RQ" → fall back to Idea.
    # Note: explicit "" counts as omitted-in-spirit; the Idea's
    # hypothesis wins.
    assert resp.status_code in (200, 201), resp.text
    exp = resp.json()
    assert exp["research_question"] == "idea hypothesis text"