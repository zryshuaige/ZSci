"""BibTeX generation from paper metadata (design.md §5.2 paper.bib)."""
from __future__ import annotations

import re

from app.db.models import Paper


def _cite_key(paper: Paper) -> str:
    first_author = ""
    if paper.authors_json:
        import json

        try:
            authors = json.loads(paper.authors_json)
            if authors:
                last = str(authors[0]).split()[-1]
                first_author = re.sub(r"[^A-Za-z]", "", last).lower()
        except (ValueError, IndexError, KeyError, TypeError):
            # KeyError: authors_json decoded to a dict instead of a list.
            # TypeError: authors_json decoded to a non-subscriptable value.
            pass
    year = paper.year or "nd"
    slug = re.sub(r"[^a-z0-9]+", "", (paper.title or "").lower())[:15]
    return f"{first_author or 'anon'}{year}{slug}"


# L4: LaTeX special chars that must be escaped inside BibTeX fields.
_BIBTEX_ESCAPE_MAP = {
    "&": r"\&",
    "%": r"\%",
    "$": r"\$",
    "#": r"\#",
    "_": r"\_",
}


def _escape_bibtex(value: str) -> str:
    """Escape LaTeX special chars in a BibTeX field value.

    Note: braces `{`/`}` are intentionally NOT escaped because callers often
    wrap fields in `{...}` to preserve capitalization; escaping them would
    break that wrapping. We escape the chars that would otherwise break
    BibTeX parsing or render incorrectly.
    """
    if not value:
        return value
    out = value
    for ch, repl in _BIBTEX_ESCAPE_MAP.items():
        out = out.replace(ch, repl)
    return out


def to_bibtex(paper: Paper) -> str:
    """Render a @article/@inproceedings entry for the paper."""
    import json

    key = _cite_key(paper)
    authors_list: list[str] = []
    if paper.authors_json:
        try:
            authors_list = json.loads(paper.authors_json)
        except ValueError:
            authors_list = []

    authors = " and ".join(authors_list) if authors_list else "Unknown"
    venue = paper.venue or "Preprint"
    # L5: use the correct field name per entry type — booktitle for
    # inproceedings, journal for article. Previously emitted
    # "booktitle/journal = {...}" which is not a valid BibTeX field.
    entry_type = "inproceedings" if paper.venue else "article"
    venue_field = "booktitle" if entry_type == "inproceedings" else "journal"

    lines = [f"@{entry_type}{{{key},"]
    lines.append(f"  title = {{{_escape_bibtex(paper.title)}}},")
    lines.append(f"  author = {{{_escape_bibtex(authors)}}},")
    if paper.year:
        lines.append(f"  year = {{{paper.year}}},")
    if paper.venue:
        lines.append(f"  {venue_field} = {{{_escape_bibtex(venue)}}},")
    if paper.doi:
        lines.append(f"  doi = {{{paper.doi}}},")
    if paper.arxiv_id:
        lines.append(f"  eprint = {{{paper.arxiv_id}}},")
        lines.append("  archivePrefix = {arXiv},")
    if paper.source_url:
        lines.append(f"  url = {{{paper.source_url}}},")
    lines.append("}")
    return "\n".join(lines)
