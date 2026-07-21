"""Tests for the TF-IDF recommendation ranking + writing templates."""
from __future__ import annotations


def test_rank_by_similarity_prefers_overlapping_text():
    from app.literature.models import CandidatePaper
    from app.literature.similarity import rank_by_similarity

    profile = "vision language model efficient fine-tuning"
    candidates = [
        CandidatePaper(
            paper_id="c1",
            title="Unrelated paper about ocean currents",
            abstract="marine biology deep sea",
            source="test",
        ),
        CandidatePaper(
            paper_id="c2",
            title="Efficient Fine-Tuning of Vision Language Models",
            abstract="We study parameter efficient fine-tuning for VLMs.",
            source="test",
        ),
        CandidatePaper(
            paper_id="c3",
            title="A survey of cooking recipes",
            abstract="pasta bread oven",
            source="test",
        ),
    ]
    ranked = rank_by_similarity(candidates, profile)
    # The VLM paper must rank strictly above the two unrelated ones.
    assert ranked[0][0].paper_id == "c2"
    assert ranked[0][1] > ranked[1][1]
    assert ranked[0][1] > 0.0


def test_rank_empty_profile_returns_zero_scores():
    from app.literature.models import CandidatePaper
    from app.literature.similarity import rank_by_similarity

    candidates = [
        CandidatePaper(paper_id="c1", title="some paper", abstract="x", source="test"),
    ]
    ranked = rank_by_similarity(candidates, "")
    assert ranked[0][1] == 0.0


def test_writing_templates_endpoint(client, project):
    resp = client.get(f"/api/v1/projects/{project['id']}/writing/templates")
    assert resp.status_code == 200
    keys = {t["key"] for t in resp.json()["templates"]}
    assert {"generic", "ieee", "elsevier"}.issubset(keys)


def test_init_writing_with_ieee_template(client, project):
    resp = client.post(
        f"/api/v1/projects/{project['id']}/writing/init",
        json={"template": "ieee"},
    )
    assert resp.status_code == 200, resp.text
    main = client.get(
        f"/api/v1/projects/{project['id']}/writing/file",
        params={"path": "main.tex"},
    )
    assert main.status_code == 200
    assert "IEEEtran" in main.json()["content"]
    assert "IEEEkeywords" in main.json()["content"]


def test_init_writing_with_elsevier_template(client, project):
    resp = client.post(
        f"/api/v1/projects/{project['id']}/writing/init",
        json={"template": "elsevier"},
    )
    assert resp.status_code == 200, resp.text
    main = client.get(
        f"/api/v1/projects/{project['id']}/writing/file",
        params={"path": "main.tex"},
    ).json()["content"]
    assert "elsarticle" in main
    assert "frontmatter" in main


def test_init_writing_unknown_template_falls_back(client, project):
    """An unknown template key must not 400; it falls back to generic."""
    resp = client.post(
        f"/api/v1/projects/{project['id']}/writing/init",
        json={"template": "nope"},
    )
    assert resp.status_code == 200
    main = client.get(
        f"/api/v1/projects/{project['id']}/writing/file",
        params={"path": "main.tex"},
    ).json()["content"]
    assert r"\documentclass[10pt]{article}" in main


def test_extract_search_terms_pulls_english_from_cjk_query():
    """A Chinese research direction with embedded English/technical terms
    should reduce to those terms so arXiv/OpenAlex (English-indexed) can match.
    Pure-English queries pass through unchanged; pure-CJK queries with no
    extractable terms fall back to the original so we don't search nothing."""
    from app.routers.literature import _extract_search_terms

    # Mixed CJK + ASCII technical terms -> just the terms.
    out = _extract_search_terms("多模态视觉模型 基于clip和deelabv3+的结合")
    assert "clip" in out
    assert "deelabv3+" in out
    assert "多模态" not in out  # CJK dropped

    # Hyphenated / dotted terms survive.
    out2 = _extract_search_terms("视觉语言模型 ViT-L 与 gpt-4 的对比")
    assert "ViT-L" in out2
    assert "gpt-4" in out2

    # Pure English passes through untouched.
    en = "parameter efficient fine-tuning for vision language models"
    assert _extract_search_terms(en) == en

    # Pure CJK with no ASCII terms falls back to the original (don't return "").
    pure_cjk = "多模态视觉模型的高效微调"
    assert _extract_search_terms(pure_cjk) == pure_cjk
