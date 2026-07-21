"""Dedup + venue registry tests (design.md §6.2, §9.2)."""
from __future__ import annotations

from app.literature.dedup import (
    deduplicate,
    filter_to_top_venues,
    merge_and_tag,
    sort_by_relevance,
)
from app.literature.models import CandidatePaper
from app.literature.venue_registry import get_venue_registry


def _paper(title="A", doi=None, arxiv_id=None, venue=None, venue_verified=False, year=2024, cited=0):
    return CandidatePaper(
        paper_id="cand_x",
        title=title,
        doi=doi,
        arxiv_id=arxiv_id,
        venue=venue,
        venue_verified=venue_verified,
        year=year,
        cited_by_count=cited,
        source="OpenAlex",
    )


def test_dedup_by_doi():
    a = _paper("Title One", doi="10.1/abc", cited=5)
    b = _paper("Title One Variant", doi="10.1/abc", cited=0, arxiv_id="2401.1")
    out = deduplicate([a, b])
    assert len(out) == 1
    # Best (richest) entry wins; graft missing arxiv_id.
    assert out[0].cited_by_count == 5
    assert out[0].arxiv_id == "2401.1"


def test_dedup_by_arxiv_when_no_doi():
    a = _paper("Some Title", arxiv_id="2401.00001")
    b = _paper("Some Title", arxiv_id="2401.00001", venue="arXiv")
    out = deduplicate([a, b])
    assert len(out) == 1
    assert out[0].venue == "arXiv"


def test_dedup_by_normalized_title():
    a = _paper("Parameter-Efficient Fine-Tuning!")
    b = _paper("parameter efficient fine tuning")
    out = deduplicate([a, b])
    assert len(out) == 1


def test_venue_tagging():
    p = _paper("X", venue="IEEE/CVF Conference on Computer Vision and Pattern Recognition")
    out = merge_and_tag([p])
    assert out[0].venue_verified is True
    assert out[0].venue == "CVPR"


def test_filter_top_venues():
    papers = [
        _paper("A", venue="CVPR"),
        _paper("B", venue="Some Workshop"),
        _paper("C", venue="NeurIPS"),
    ]
    out = filter_to_top_venues(papers)
    assert {p.venue for p in out} == {"CVPR", "NeurIPS"}


def test_sort_verified_first():
    papers = [
        _paper("A", venue="CVPR", venue_verified=True, cited=1),
        _paper("B", venue="Workshop", cited=100),
    ]
    out = sort_by_relevance(papers)
    assert out[0].venue == "CVPR"


def test_registry_basics():
    reg = get_venue_registry()
    assert reg.match("International Conference on Machine Learning")
    assert reg.canonical("International Conference on Machine Learning") == "ICML"
    assert not reg.match("Totally Unknown Venue")
