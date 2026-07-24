"""Tests for the LLM-output JSON extractor.

These pin down the shapes that the old per-module regex handled badly or not
at all: fenced output, fenced-but-truncated (no closing fence), prose-wrapped
output, braces inside string literals, and genuine truncation.
"""
from app.llm.json_utils import extract_json_list, extract_json_object


def test_clean_fenced_json():
    raw = '```json\n{"candidates": [{"name": "A"}], "evidence": []}\n```'
    out = extract_json_object(raw)
    assert out is not None
    assert len(out["candidates"]) == 1
    assert out["candidates"][0]["name"] == "A"


def test_bare_json_no_fence():
    raw = '{"candidates": [{"name": "A"}], "evidence": []}'
    out = extract_json_object(raw)
    assert out is not None
    assert len(out["candidates"]) == 1


def test_fenced_missing_closing_fence_still_parses():
    """LLM hit max_tokens before emitting the closing ``` fence."""
    raw = '```json\n{"candidates": [{"name": "A"}], "evidence": []}\n'
    out = extract_json_object(raw)
    assert out is not None
    assert len(out["candidates"]) == 1


def test_prose_wrapped_json():
    raw = (
        "好的，以下是 5 个候选方向：\n\n"
        '```json\n{"candidates": [{"name": "A"}, {"name": "B"}]}\n```\n\n'
        "希望对你有帮助。"
    )
    out = extract_json_object(raw)
    assert out is not None
    assert len(out["candidates"]) == 2


def test_braces_inside_string_literals_are_ignored():
    """A `}` inside a JSON string value must not fool the brace counter."""
    raw = '{"hypothesis": "use {a, b} set notation", "candidates": [{"name": "A"}]}'
    out = extract_json_object(raw)
    assert out is not None
    assert out["hypothesis"] == "use {a, b} set notation"
    assert len(out["candidates"]) == 1


def test_genuinely_truncated_returns_none():
    """Output cut mid-object: no balanced close exists. Must return None."""
    raw = '```json\n{"candidates": [{"name": "A"}, {"name": "B"'
    assert extract_json_object(raw) is None


def test_list_extraction_fenced():
    raw = '```json\n[{"name": "A"}, {"name": "B"}]\n```'
    out = extract_json_list(raw)
    assert len(out) == 2
    assert out[0]["name"] == "A"


def test_list_extraction_filters_non_dicts():
    raw = '```json\n[{"name": "A"}, "not-an-object", 42]\n```'
    out = extract_json_list(raw)
    assert len(out) == 1
    assert out[0]["name"] == "A"


def test_none_and_empty_inputs():
    assert extract_json_object(None) is None
    assert extract_json_object("") is None
    assert extract_json_list(None) == []
    assert extract_json_list("") == []


def test_nested_objects_full_recovery():
    """The real Multi-Idea shape: outer object with a nested array of objects."""
    raw = (
        "```json\n"
        '{\n'
        '  "candidates": [\n'
        '    {"name": "方向一", "feasibility": 3, "key_differences": ["a", "b"]},\n'
        '    {"name": "方向二", "feasibility": 2}\n'
        '  ],\n'
        '  "evidence": []\n'
        '}\n'
        "```\n以上是两个候选方向。"
    )
    out = extract_json_object(raw)
    assert out is not None
    assert len(out["candidates"]) == 2
    assert out["candidates"][0]["name"] == "方向一"
    assert out["candidates"][0]["key_differences"] == ["a", "b"]
