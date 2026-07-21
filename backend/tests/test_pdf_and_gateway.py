"""BibTeX + gateway config tests (design.md §4.4, §5.2)."""
from __future__ import annotations

import json

from app.db.models import Paper
from app.pdf.bib import to_bibtex


def _make_paper(**kw):
    defaults = dict(
        id="paper_0001",
        project_id="prj_1",
        title="A Great Paper",
        authors_json=json.dumps(["Alice Smith", "Bob Jones"]),
        year=2024,
        venue="CVPR",
        doi="10.1109/CVPR.2024.001",
        arxiv_id="2401.00001",
        source_url="https://example.com",
    )
    defaults.update(kw)
    return Paper(**defaults)


def test_bibtex_has_citekey_and_fields():
    p = _make_paper()
    bib = to_bibtex(p)
    assert bib.startswith("@inproceedings{")
    assert "smith2024agreatpaper" in bib.lower()
    assert "Alice Smith and Bob Jones" in bib
    assert "10.1109/CVPR.2024.001" in bib
    assert "2401.00001" in bib


def test_bibtex_article_when_no_venue():
    p = _make_paper(venue=None)
    bib = to_bibtex(p)
    assert bib.startswith("@article{")


def test_gateway_config_missing_file(isolated_workspace, tmp_path):
    from app.config import load_llm_config

    cfg = load_llm_config(tmp_path / "nope.yaml")
    assert cfg.default_chat is None
    assert not cfg.models


def test_gateway_not_configured_describe(isolated_workspace):
    from app.llm.gateway import ModelNotConfigured, get_gateway

    gw = get_gateway()
    assert not gw.is_configured("default_chat")
    desc = gw.describe()
    assert desc["default_chat_model"] is None
    try:
        gw.provider_for("default_chat")
    except ModelNotConfigured:
        return
    raise AssertionError("expected ModelNotConfigured")


def test_gateway_config_loaded(isolated_workspace, tmp_path):
    import yaml

    from app.config import load_llm_config

    cfg_file = tmp_path / "config.yaml"
    cfg_file.write_text(
        yaml.safe_dump(
            {
                "models": {
                    "default_chat": {
                        "provider": "deepseek",
                        "model": "deepseek-chat",
                        "api_key_env": "DEEPSEEK_API_KEY",
                    }
                }
            }
        ),
        encoding="utf-8",
    )
    cfg = load_llm_config(cfg_file)
    assert cfg.default_chat is not None
    assert cfg.default_chat.model == "deepseek-chat"
