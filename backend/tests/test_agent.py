"""Agent evidence validator + research skill tests (design.md §2.3, §8).

Uses a fake gateway to avoid real LLM calls, and an in-memory-ish workspace DB.
"""
from __future__ import annotations

import json
from unittest.mock import patch

from app.agent.evidence import validate_evidence


def test_validate_flags_unsourced_fact():
    items = [{"kind": "事实", "claim": "LoRA 把秩设为 8 效果最好", "source_type": "paper"}]
    out = validate_evidence(items)
    assert out[0].get("_warning") and "来源引用" in out[0]["_warning"]


def test_validate_accepts_sourced_fact():
    items = [
        {
            "kind": "事实",
            "claim": "LoRA 在低秩下接近全参微调",
            "source_type": "paper",
            "source_id": "paper_0001",
            "citation": "(p.5)",
        }
    ]
    out = validate_evidence(items)
    assert not out[0].get("_warning")


def test_inference_needs_no_source():
    items = [{"kind": "推断", "claim": "PEFT 方法路线正从固定秩走向自适应秩"}]
    out = validate_evidence(items)
    assert not out[0].get("_warning")


def test_hypothesis_skill_persists_ideas(db_session, isolated_workspace):
    """generate_hypothesis should parse JSON + persist Idea rows."""
    from app.db.models import Idea, Project
    from app.utils import new_id

    project = Project(
        id=new_id("prj"), name="T", slug="t", root_path=str(isolated_workspace / "projects" / "t"),
    )
    db_session.add(project)
    db_session.flush()

    # Seed a fake parsed paper so the evidence pack is non-empty.
    from app.db.models import Paper

    paper = Paper(
        id="paper_0001", project_id=project.id, title="A Paper", downloaded=True,
        parse_status="success", local_pdf_path="projects/t/literature/papers/paper_0001/paper.pdf",
    )
    db_session.add(paper)
    db_session.flush()

    fake_response = json.dumps(
        {
            "hypotheses": [
                {
                    "name": "Adaptive Rank LoRA",
                    "hypothesis": "Rank-adaptive allocation improves low-resource fine-tuning",
                    "motivation": "Fixed rank under-fits some layers",
                    "evidence": [{"kind": "事实", "claim": "x", "source_id": "paper_0001", "citation": "(p.3)"}],
                    "risks": ["may increase memory"],
                }
            ],
            "evidence": [],
        }
    )

    fake_gw = type(
        "FakeGW",
        (),
        {
            "is_configured": lambda self, role=True: True,
            "chat": lambda self, messages, **kw: fake_response,
            "provider_for": lambda self, role: type("P", (), {"provider": "fake", "model": "fake"})(),
        },
    )()

    from app.agent import research_skills

    with patch("app.agent.research_skills.get_gateway", return_value=fake_gw), \
         patch("app.agent.research_skills.load_extracted_text", return_value={"pages": 10, "page_texts": [{"page": 3, "text": "some text"}]}):
        state = {
            "project_id": project.id,
            "selected_papers": ["paper_0001"],
            "user_request": "adaptive rank",
            "warnings": [],
            "evidence": [],
            "result": {},
        }
        new_state = research_skills.generate_hypothesis(db_session, state)

    ideas = db_session.query(Idea).all()
    assert len(ideas) == 1
    assert ideas[0].title == "Adaptive Rank LoRA"
    assert ideas[0].status == "hypothesis"
    assert "1" in new_state["final_response"]
    assert new_state["result"]["hypotheses"][0]["name"] == "Adaptive Rank LoRA"


def test_idea_title_prefers_explicit_name():
    from app.agent.research_skills import _idea_title

    assert _idea_title({"name": "自适应秩 LoRA", "hypothesis": "blah"}) == "自适应秩 LoRA"
    # title is an accepted alias for name.
    assert _idea_title({"title": "别名标题", "hypothesis": "blah"}) == "别名标题"
    # A whitespace-only name falls through to derivation.
    assert _idea_title({"name": "   ", "hypothesis": "实际假设内容"}) == "实际假设内容"


def test_idea_title_derives_from_hypothesis_when_missing():
    """When the model omits name/title, the title comes from its own text,
    never a generic placeholder (the user asked the AI to name each idea)."""
    from app.agent.research_skills import _idea_title

    # Trailing clause punctuation is stripped - a title shouldn't end with 。.
    title = _idea_title({"hypothesis": "在低资源场景下,动态秩分配能提升微调效果。"})
    assert title == "在低资源场景下,动态秩分配能提升微调效果"


def test_idea_title_truncates_long_text():
    from app.agent.research_skills import _idea_title

    long = "在低资源场景下动态秩分配能显著提升视觉语言模型的微调效果并降低显存开销"
    title = _idea_title({"hypothesis": long})
    assert title.endswith("…")
    assert len(title) <= 25  # 24 chars + ellipsis


def test_idea_title_fallback_only_when_nothing_to_derive():
    from app.agent.research_skills import _idea_title

    assert _idea_title({}) == "未命名想法"
    assert _idea_title({"motivation": ""}) == "未命名想法"


def test_hypothesis_skill_derives_title_when_model_omits_name(db_session, isolated_workspace):
    """End-to-end: if the model returns a hypothesis without a name field, the
    persisted Idea title is derived from the hypothesis text, not a placeholder."""
    from app.db.models import Idea, Paper, Project
    from app.utils import new_id

    project = Project(
        id=new_id("prj"), name="T", slug="t2", root_path=str(isolated_workspace / "projects" / "t2"),
    )
    db_session.add(project)
    db_session.flush()
    paper = Paper(
        id="paper_0002", project_id=project.id, title="A Paper", downloaded=True,
        parse_status="success", local_pdf_path="projects/t2/literature/papers/paper_0002/paper.pdf",
    )
    db_session.add(paper)
    db_session.flush()

    fake_response = json.dumps(
        {
            "hypotheses": [
                {
                    # No "name" field - title must be derived from hypothesis.
                    "hypothesis": "动态秩分配能提升低资源微调效果",
                    "motivation": "fixed rank under-fits",
                }
            ],
            "evidence": [],
        }
    )
    fake_gw = type(
        "FakeGW",
        (),
        {
            "is_configured": lambda self, role=True: True,
            "chat": lambda self, messages, **kw: fake_response,
            "provider_for": lambda self, role: type("P", (), {"provider": "fake", "model": "fake"})(),
        },
    )()

    from app.agent import research_skills

    with patch("app.agent.research_skills.get_gateway", return_value=fake_gw), \
         patch("app.agent.research_skills.load_extracted_text", return_value={"pages": 1, "page_texts": [{"page": 1, "text": "x"}]}):
        state = {
            "project_id": project.id, "selected_papers": ["paper_0002"],
            "user_request": "adaptive rank", "warnings": [], "evidence": [], "result": {},
        }
        research_skills.generate_hypothesis(db_session, state)

    idea = db_session.query(Idea).one()
    assert idea.title == "动态秩分配能提升低资源微调效果"
    assert idea.title != "未命名 idea"
