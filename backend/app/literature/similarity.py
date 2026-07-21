"""Lightweight TF-IDF cosine similarity for paper recommendations.

No external deps and no embedding model required (works offline). We build an
interest profile from the project's research direction + downloaded papers'
titles/abstracts, then rank search candidates by cosine similarity to that
profile. Good enough to surface "most similar" papers; the LLM is only needed
for deeper semantic matching later.
"""
from __future__ import annotations

import math
import re
from collections import Counter

from app.literature.models import CandidatePaper

# Common English stopwords only; CJK text is tokenized as runs of word chars.
_STOPWORDS = {
    "a", "an", "the", "and", "or", "of", "for", "to", "in", "on", "with",
    "by", "from", "is", "are", "was", "were", "be", "been", "being", "as",
    "at", "it", "its", "this", "that", "these", "those", "we", "our", "their",
    "they", "them", "which", "who", "whom", "whose", "but", "not", "no", "so",
    "if", "then", "than", "via", "using", "use", "used", "based", "through",
    "into", "such", "each", "both", "between", "within", "over", "under",
    "more", "most", "can", "may", "also", "et", "al", "doi", "http", "https",
}


def tokenize(text: str) -> list[str]:
    """Lowercase word tokens, dropping stopwords and 1-char ASCII tokens.

    `\\w+` with re.UNICODE keeps CJK runs as tokens, so Chinese research
    directions still contribute signal (a shared CJK phrase becomes a strong
    matching token).
    """
    if not text:
        return []
    tokens = re.findall(r"\w+", text.lower(), flags=re.UNICODE)
    return [t for t in tokens if t not in _STOPWORDS and (len(t) > 1 or not t.isascii())]


def _tf(tokens: list[str]) -> Counter:
    return Counter(tokens)


def _idf(corpus_tokens: list[list[str]]) -> dict[str, float]:
    """Smoothed idf: log((1 + N) / (1 + df)) + 1."""
    n = len(corpus_tokens)
    df: Counter = Counter()
    for toks in corpus_tokens:
        for term in set(toks):
            df[term] += 1
    return {term: math.log((1 + n) / (1 + d)) + 1.0 for term, d in df.items()}


def _tfidf_vector(tokens: list[str], idf: dict[str, float]) -> dict[str, float]:
    tf = _tf(tokens)
    return {term: count * idf.get(term, 0.0) for term, count in tf.items()}


def _cosine(a: dict[str, float], b: dict[str, float]) -> float:
    if not a or not b:
        return 0.0
    # Iterate over the smaller vector for dot product.
    if len(b) < len(a):
        a, b = b, a
    dot = sum(v * b.get(term, 0.0) for term, v in a.items())
    na = math.sqrt(sum(v * v for v in a.values()))
    nb = math.sqrt(sum(v * v for v in b.values()))
    if na == 0 or nb == 0:
        return 0.0
    return dot / (na * nb)


def rank_by_similarity(
    candidates: list[CandidatePaper], profile_text: str
) -> list[tuple[CandidatePaper, float]]:
    """Return (candidate, similarity) pairs sorted desc by cosine similarity.

    `profile_text` is the project's interest profile (research direction +
    downloaded papers' text). Candidates with empty text get similarity 0.
    """
    profile_tokens = tokenize(profile_text)
    if not profile_tokens:
        return [(c, 0.0) for c in candidates]

    cand_tokens_list = [tokenize((c.title or "") + " " + (c.abstract or "")) for c in candidates]
    idf = _idf([profile_tokens] + cand_tokens_list)
    profile_vec = _tfidf_vector(profile_tokens, idf)

    scored: list[tuple[CandidatePaper, float]] = []
    for c, toks in zip(candidates, cand_tokens_list, strict=True):
        sim = _cosine(profile_vec, _tfidf_vector(toks, idf))
        scored.append((c, sim))
    scored.sort(key=lambda x: x[1], reverse=True)
    return scored
