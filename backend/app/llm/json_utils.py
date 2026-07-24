r"""Robust extraction of JSON from LLM responses.

LLM outputs are often wrapped in triple-backtick json fences, sometimes
have trailing prose ("以上是5个候选方向。"), and occasionally get truncated
mid-object when `max_tokens` is hit. The naive `json.loads(raw)` and even a
fenced regex (backticks + a non-greedy capture) fail silently on those cases:
the regex requires a closing fence, and its non-greedy span plus a greedy
fallback both grab the wrong span or an unbalanced fragment, so the caller
gets `None` and the user sees an empty result (the "AI understood but
returned 0 candidates" bug).

These helpers use a balanced-brace scan that:
  * strips a leading ```json / ``` fence and a trailing ``` (independently,
    so a missing closing fence from truncation still works);
  * skips braces inside JSON string literals;
  * returns the first *complete* object/list, or None/[] if the text is
    truncated before the braces balance (rather than returning a broken
    prefix that json.loads would reject).
"""
from __future__ import annotations

import json
import re

# A leading fence opener: ```json / ```JSON / ```  (optionally followed by a newline)
_LEADING_FENCE = re.compile(r"^\s*```(?:json|JSON)?\s*\n?", re.IGNORECASE)


def _strip_fences(text: str | None) -> str:
    """Remove one leading and one trailing markdown code fence.

    The closing fence is removed only if present, so truncated outputs (no
    closing fence) are not corrupted.
    """
    if not text:
        return ""
    text = text.strip()
    m = _LEADING_FENCE.match(text)
    if m:
        text = text[m.end():]
    # Strip a trailing closing fence (``` possibly preceded by whitespace).
    stripped = text.rstrip()
    if stripped.endswith("```"):
        text = stripped[:-3].rstrip()
    return text


def _extract_balanced(text: str, open_ch: str, close_ch: str) -> str | None:
    """Return the first complete balanced ``open_ch ... close_ch`` span.

    Braces/brackets inside JSON string literals are ignored. Returns None if
    no balanced span exists (e.g. output truncated before it closes).
    """
    start = text.find(open_ch)
    if start < 0:
        return None
    depth = 0
    in_str = False
    esc = False
    for i in range(start, len(text)):
        c = text[i]
        if in_str:
            if esc:
                esc = False
            elif c == "\\":
                esc = True
            elif c == '"':
                in_str = False
        else:
            if c == '"':
                in_str = True
            elif c == open_ch:
                depth += 1
            elif c == close_ch:
                depth -= 1
                if depth == 0:
                    return text[start : i + 1]
    return None  # unbalanced - likely truncated


def extract_json_object(text: str | None) -> dict | None:
    """Extract the first JSON object from an LLM response.

    Tolerates ```json fences, surrounding prose, and truncation. Returns the
    parsed dict, or None if no complete object can be recovered.
    """
    if not text:
        return None
    cleaned = _strip_fences(text)
    # Fast path: the whole thing is the object.
    try:
        v = json.loads(cleaned)
        if isinstance(v, dict):
            return v
    except ValueError:
        pass
    span = _extract_balanced(cleaned, "{", "}")
    if span is None:
        return None
    try:
        v = json.loads(span)
        return v if isinstance(v, dict) else None
    except ValueError:
        return None


def extract_json_list(text: str | None) -> list[dict]:
    """Extract the first JSON array of objects from an LLM response.

    Tolerates fences, prose, and truncation. Returns the parsed list (only
    dict elements kept), or [] if nothing can be recovered.
    """
    if not text:
        return []
    cleaned = _strip_fences(text)
    try:
        v = json.loads(cleaned)
        if isinstance(v, list):
            return [x for x in v if isinstance(x, dict)]
    except ValueError:
        pass
    span = _extract_balanced(cleaned, "[", "]")
    if span is None:
        return []
    try:
        v = json.loads(span)
        if isinstance(v, list):
            return [x for x in v if isinstance(x, dict)]
    except ValueError:
        return []
    return []
