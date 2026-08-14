"""book_factory_composer.py — Book Factory (Phase 1) deterministic composition.

Gemini returns *semantic* JSON (paragraphs, dialogueLines, vocabulary, mcqs,
…).  It NEVER authors Reader blocks directly.  This module deterministically
turns that semantic output into canonical Reader/Editor blocks, then performs
the final canonical book export.

Hard guarantees enforced here:
  * Only the Phase 1 whitelist block types are ever produced (§7).
  * MCQ/fillblank blocks match `ExerciseBlock.jsx`'s real contract:
        {type:"mcq",       text, options(list), answer(string), explain?}
        {type:"fillblank", text, answer(string), explain?}
    NOT AiSceneBuilder's {question, choices} shape (which does not render).
  * `evidenceQuote` is stripped before a block is composed — it never reaches
    db.books.
  * Canonical export uses an EXPLICIT field whitelist (never spreads a job's
    internal chapter/stage objects), forces `published: false`, and preserves
    the author-configured tier + price exactly (never infers/overrides).

Stdlib only; no Mongo, no network, no protected-module imports.
"""
from __future__ import annotations

from book_factory_validator import ALLOWED_BLOCK_TYPES, assert_blocks_allowed

# Author-configurable fields copied verbatim into the canonical book.
# Mirrors the current server.py BookPayload shape (re-verified §1b).  `slug`
# is intentionally omitted (Book Factory never assigns a slug; the Editor save
# path mints one).  `published` is forced separately.
_EXPORT_CONFIG_WHITELIST = (
    "title", "subtitle", "author", "section", "coverEmoji", "coverImage",
    "coverGradient", "accent", "badge", "level", "readingMinutes", "price",
    "tier", "newUntil", "contentType",
)

_CONFIG_DEFAULTS = {
    "title": "Untitled",
    "subtitle": "",
    "author": "Classroom Library",
    "section": "story",
    "coverEmoji": "\U0001F4D6",  # 📖
    "coverImage": "",
    "coverGradient": "linear-gradient(155deg, #2a2140 0%, #4a3a6a 100%)",
    "accent": "#D4A843",
    "badge": "",
    "level": "",
    "readingMinutes": 6,
    "price": 0,
    "tier": "",
    "newUntil": "",
    "contentType": "",
}

# Per-type key whitelist for a composed block reaching export.
_BLOCK_KEY_WHITELIST = {
    "heading": ("type", "text"),
    "paragraph": ("type", "text"),
    "quote": ("type", "text"),
    "markdown": ("type", "text"),
    "dialog": ("type", "text", "speaker"),
    "mcq": ("type", "text", "options", "answer", "explain"),
    "fillblank": ("type", "text", "answer", "explain"),
}


# ── chapter full text (for evidence grounding) ─────────────────────────────
def build_chapter_full_text(semantic: dict) -> str:
    """Concatenate the chapter's paragraph + dialog text so an evidence quote
    that spans adjacent blocks still matches.  Used by the validator.
    §PHASE B1: _safe_list() guards against non-list field values.
    """
    parts: list[str] = []
    for p in _safe_list(semantic.get("paragraphs")):
        if isinstance(p, str) and p.strip():
            parts.append(p.strip())
    for line in _safe_list(semantic.get("dialogueLines")):
        if isinstance(line, dict):
            t = line.get("text")
            if isinstance(t, str) and t.strip():
                parts.append(t.strip())
    return "\n".join(parts)


# ── block composition ──────────────────────────────────────────────────────
def _mcq_block(mcq: dict) -> dict:
    """Compose a validated semantic MCQ into ExerciseBlock's contract.
    `answer` is the FULL correct option text (ExerciseBlock matches options
    case-insensitively).  `evidenceQuote` is dropped here.
    """
    # §HIGH E: options are already confirmed non-empty by validate_mcq; copy
    # them as-is (do NOT filter, which could shift correctIndex).
    options = list(mcq.get("options") or [])
    idx = int(mcq.get("correctIndex", 0))
    answer = options[idx] if 0 <= idx < len(options) else ""
    if not str(answer).strip():
        raise ValueError("composed MCQ has empty answer (validator contract violated)")
    block = {
        "type": "mcq",
        "text": str(mcq.get("question") or "").strip(),
        "options": options,
        "answer": answer,
    }
    explain = mcq.get("explain")
    if isinstance(explain, str) and explain.strip():
        block["explain"] = explain.strip()
    return block


def _fillblank_block(fb: dict) -> dict:
    block = {
        "type": "fillblank",
        "text": str(fb.get("text") or "").strip(),
        "answer": str(fb.get("answer") or "").strip(),
    }
    explain = fb.get("explain")
    if isinstance(explain, str) and explain.strip():
        block["explain"] = explain.strip()
    return block


def _markdown_section(heading: str, lines: list[str]) -> dict | None:
    body = [ln for ln in lines if isinstance(ln, str) and ln.strip()]
    if not body:
        return None
    md = f"### {heading}\n\n" + "\n".join(f"- {ln.strip()}" for ln in body)
    return {"type": "markdown", "text": md}


def _safe_list(val) -> list:
    """Return `val` if it is a list, otherwise return [].
    Prevents iterating over a string ('abc' → ['a','b','c']) or other
    non-list types when Gemini returns a malformed field (§PHASE B1)."""
    return val if isinstance(val, list) else []


def _vocab_word_block(item: dict) -> dict:
    """Compose ONE canonical markdown block for a single validated vocabulary
    word (§PART C: a separate, concise content unit — never one giant
    combined vocabulary dump). `item` is already validated + sanitized by
    book_factory_validator.validate_vocab_item — this function does no
    further validation, only formatting, and uses ONLY the existing
    `markdown` block type (already rendered by ChapterBlocks.jsx — no new
    Reader component)."""
    head = f"### 📘 {item['word']}"
    if item.get("partOfSpeech"):
        head += f" · *{item['partOfSpeech']}*"
    lines = [head]

    meta_bits = []
    if item.get("ipa"):
        meta_bits.append(f"**IPA:** {item['ipa']}")
    if item.get("stress"):
        meta_bits.append(f"**Stress:** {item['stress']}")
    if meta_bits:
        lines.append(" &nbsp;·&nbsp; ".join(meta_bits))

    lines.append(f"**Meaning:** {item['definitionEnglish']}")
    if item.get("explanationKhmer"):
        lines.append(f"**ខ្មែរ:** {item['explanationKhmer']}")
    if item.get("example"):
        lines.append(f"*Example:* {item['example']}")

    return {"type": "markdown", "text": "\n\n".join(lines)}


def compose_chapter_blocks(
    semantic: dict,
    validated_mcqs: list[dict],
    fillblanks: list[dict],
    validated_vocab: list[dict] | None = None,
) -> list[dict]:
    """Deterministically compose canonical blocks for one chapter.

    `validated_mcqs` are semantic MCQs that already passed validation/repair.
    `fillblanks` are semantic fill-in-the-blank entries already validated.
    `validated_vocab` are semantic vocabulary items already validated +
    CEFR-quantity-capped by book_factory_jobs._validate_and_compose (via
    book_factory_validator.validate_vocab_item / vocab_count_range) — this
    function only formats them, one markdown block per word.

    §PHASE B1: all semantic fields are guarded with _safe_list() so a
    malformed field (e.g. paragraphs="abc") never iterates over characters.
    """
    blocks: list[dict] = []

    # 1. Body paragraphs — §B1: must be a list; a non-list value is ignored.
    for p in _safe_list(semantic.get("paragraphs")):
        if isinstance(p, str) and p.strip():
            blocks.append({"type": "paragraph", "text": p.strip()})

    # 2. Dialogue → one dialog block per line.
    for line in _safe_list(semantic.get("dialogueLines")):
        if not isinstance(line, dict):
            continue
        text = line.get("text")
        if not isinstance(text, str) or not text.strip():
            continue
        block = {"type": "dialog", "text": text.strip()}
        speaker = line.get("speaker") or line.get("name")
        if isinstance(speaker, str) and speaker.strip():
            block["speaker"] = speaker.strip()
        blocks.append(block)

    # 3. Vocabulary → one markdown block PER validated word (§PART C/G: never
    # one giant combined blob — a single huge block is exactly what turns the
    # Reader page into an unbroken wall of scrolling text).
    for item in (validated_vocab or []):
        blocks.append(_vocab_word_block(item))

    # 4. Pronunciation targets → markdown list.
    pron = [str(x).strip() for x in _safe_list(semantic.get("pronunciationTargets")) if str(x).strip()]
    sec = _markdown_section("Pronunciation practice", pron)
    if sec:
        blocks.append(sec)

    # 5. Speaking prompts → markdown list.
    speak = [str(x).strip() for x in _safe_list(semantic.get("speakingPrompts")) if str(x).strip()]
    sec = _markdown_section("Speaking practice", speak)
    if sec:
        blocks.append(sec)

    # 6. MCQs.
    for mcq in validated_mcqs or []:
        blocks.append(_mcq_block(mcq))

    # 7. Fill-in-the-blanks.
    for fb in fillblanks or []:
        blocks.append(_fillblank_block(fb))

    # 8. Summary → markdown.
    summary = semantic.get("summary")
    if isinstance(summary, str) and summary.strip():
        blocks.append({"type": "markdown", "text": f"### Summary\n\n{summary.strip()}"})

    return blocks


# ── canonical export ───────────────────────────────────────────────────────
def _strip_block(b: dict) -> dict:
    """Return a copy of `b` keeping ONLY the per-type whitelisted keys.
    Raises ValueError for any non-whitelisted type (defence-in-depth).
    """
    t = str(b.get("type") or "").lower()
    if t not in ALLOWED_BLOCK_TYPES:
        raise ValueError(f"disallowed block type at export: {t!r}")
    allowed = _BLOCK_KEY_WHITELIST[t]
    out = {k: b[k] for k in allowed if k in b}
    out["type"] = t
    return out


def export_canonical_book(config: dict, chapters: list[dict]) -> dict:
    """Build the final canonical book payload.

    `config`   — the author-configured book settings (tier/price preserved).
    `chapters` — ordered list of {title, blocks} chapter dicts whose blocks are
                 already-composed canonical blocks.  NEVER a job's internal
                 chapter/stage object.

    Guarantees: explicit whitelist only, `published: false` forced, tier/price
    untouched, only Phase 1 block types present, all job-internal metadata
    (chapterId/position/state/locked/warnings/attemptId/generationVersion/…)
    absent because we never spread the job object.
    """
    cfg = config or {}
    out: dict = {}
    for field in _EXPORT_CONFIG_WHITELIST:
        out[field] = cfg.get(field, _CONFIG_DEFAULTS[field])

    out["format"] = "blocks"
    out["published"] = False  # unconditional — Phase 1 produces drafts only.

    export_chapters: list[dict] = []
    for ch in chapters or []:
        blocks = ch.get("blocks") or []
        assert_blocks_allowed(blocks)  # hard gate before stripping
        export_chapters.append({
            "title": str(ch.get("title") or "Chapter"),
            "blocks": [_strip_block(b) for b in blocks if isinstance(b, dict)],
        })
    out["chapters"] = export_chapters
    return out


# ── Phase 4: speaker extraction for zero-copy conversation automation ──────
def extract_speakers(chapters: list[dict]) -> list[str]:
    """Return unique dialog-block speaker names across the given chapters, in
    first-seen order. `chapters` may be raw {title, blocks} dicts (as passed
    to export_canonical_book) — never mutates its input."""
    seen: list[str] = []
    seen_set: set[str] = set()
    for ch in chapters or []:
        for b in (ch or {}).get("blocks") or []:
            if not isinstance(b, dict) or b.get("type") != "dialog":
                continue
            speaker = str(b.get("speaker") or "").strip()
            if speaker and speaker not in seen_set:
                seen_set.add(speaker)
                seen.append(speaker)
    return seen
