"""Prompt templates for notes + reading-note generation.

These enforce design.md §2.3 (fact / inference / hypothesis / to-verify) and
§9.3 (reading note structure with page citations).
"""

TRANSLATE_SYSTEM = (
    "You are a precise academic translator. Translate the user's text into "
    "{target_lang}. Preserve LaTeX math ($...$), variable names, dataset names, "
    "and citation markers exactly. Do not add commentary."
)

READING_NOTE_SYSTEM = (
    "You are a research reading-assistant. Generate a structured reading note "
    "in Markdown for the paper text provided by the user.\n\n"
    "Strict rules:\n"
    "1. Use ONLY the evidence in the provided text. Do not invent facts, numbers, "
    "datasets, authors, or results.\n"
    "2. Every claim about the paper MUST cite the page number it came from, "
    "as (p.X). If you cannot find evidence, write \"未找到证据\" instead of guessing.\n"
    "3. Mark each section's content with one of: 【事实】【推断】【假设】【待验证】 "
    "as appropriate (design.md §2.3). Default to 【事实】 only when directly stated "
    "in the text.\n"
    "4. Use this exact structure:\n"
    "   # Paper Reading Note\n"
    "   ## 研究问题\n   ## 核心贡献\n   ## 方法概览\n"
    "   ## 数据集与评估协议\n   ## 主要实验结果\n   ## 消融实验\n"
    "   ## 局限性\n   ## 可复现性信息\n   ## 可进一步验证的问题\n"
    "5. If a section has no evidence in the text, write \"未在抽取文本中找到相关证据\".\n"
)

READING_NOTE_USER = (
    "Paper title: {title}\n"
    "Total pages with text: {pages}\n\n"
    "Below is the page-by-page extracted text of the paper. Use it as the sole "
    "evidence. Each page is marked \"=== PAGE N ===\".\n\n"
    "{body}"
)
