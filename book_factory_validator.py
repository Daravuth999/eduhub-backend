"""book_factory_validator.py — Book Factory (Phase 1) pure validation helpers.

Self-contained, dependency-free (stdlib only). NEVER touches Mongo, network,
or any protected module. Everything here is deterministic and unit-testable.

Two responsibilities:

  1. Block-type whitelisting — Phase 1 may only emit the verified intersection
     of Reader-rendering support (ChapterBlocks.jsx) and Editor-native palette
     support (StudioEditor.jsx BLOCK_TYPES).  That intersection EXCLUDES
     `example` (absent from the Editor palette) and all media/embed/transcript
     types (Phase 1 generates no media).  See §7 of the build spec.

  2. Exercise grounding — every generated MCQ must cite an `evidenceQuote`
     that appears verbatim (after light normalization) inside the generated
     chapter text.  This proves the cited evidence text EXISTS in the chapter;
     it does NOT prove the answer is semantically correct (see ground-truth
     limitation noted below and in the implementation summary).
"""
from __future__ import annotations

import re
import unicodedata

# ── Phase 1 canonical block whitelist (verified intersection) ──────────────
# Reader support (ChapterBlocks.jsx): paragraph/paragraphs/text, heading,
#   quote, example, image, audio, video, embed, transcript, dialog, mcq,
#   fillblank, markdown.
# Editor native palette (StudioEditor.jsx BLOCK_TYPES): paragraph, heading,
#   quote, image, audio, video, embed, dialog, mcq, fillblank, transcript,
#   markdown  (NOTE: `example` is ABSENT).
# Phase 1 forbids ALL media (image/audio/video/embed/transcript) and `example`.
ALLOWED_BLOCK_TYPES: frozenset[str] = frozenset(
    {"heading", "paragraph", "quote", "markdown", "dialog", "mcq", "fillblank"}
)

# Types the generator must NEVER emit (explicit, for clear rejection messages).
FORBIDDEN_BLOCK_TYPES: frozenset[str] = frozenset(
    {"image", "audio", "video", "embed", "transcript", "example"}
)


# ── Text normalization ─────────────────────────────────────────────────────
_QUOTE_MAP = {
    "\u2018": "'", "\u2019": "'", "\u201a": "'", "\u201b": "'",
    "\u201c": '"', "\u201d": '"', "\u201e": '"', "\u201f": '"',
    "\u2013": "-", "\u2014": "-", "\u00a0": " ",
}


def normalize_text(s: str) -> str:
    """Lowercase, normalize unicode + quote variants, collapse whitespace, and
    strip harmless trailing punctuation.

    IMPORTANT: collapses runs of whitespace to a single space but PRESERVES
    word boundaries (it never deletes the separator entirely), so it cannot
    manufacture a false substring match by gluing two words together.
    """
    if not isinstance(s, str):
        s = str(s or "")
    s = unicodedata.normalize("NFKC", s)
    s = "".join(_QUOTE_MAP.get(ch, ch) for ch in s)
    s = s.lower()
    # Collapse any whitespace run to a single ASCII space (boundary preserved).
    s = re.sub(r"\s+", " ", s)
    # Ignore harmless leading/trailing punctuation + whitespace.
    s = s.strip()
    s = s.strip(".,;:!?\"'-")
    s = s.strip()
    return s


def evidence_in_text(evidence: str, chapter_text: str) -> bool:
    """True iff the normalized `evidence` appears in normalized `chapter_text`
    with PHRASE BOUNDARIES on both sides (§MEDIUM 15).

    Both sides are normalized identically (case/whitespace/quote/punctuation).
    The match requires that the evidence is not glued inside a larger token:
    e.g. "cat" must NOT match "concatenate", but "the cat sat" matches.
    """
    ev = normalize_text(evidence)
    if not ev:
        return False
    body = normalize_text(chapter_text)
    # normalize_text lowercases → the token class is [a-z0-9]. Require a
    # non-alphanumeric boundary (or string edge) on each side of the evidence.
    pattern = r"(?<![a-z0-9])" + re.escape(ev) + r"(?![a-z0-9])"
    return re.search(pattern, body) is not None


# ── MCQ validation ─────────────────────────────────────────────────────────
def validate_mcq(mcq: dict, chapter_text: str) -> tuple[bool, str | None]:
    """Validate a single semantic MCQ against the spec's hard requirements.

    Returns (ok, reason). reason is None when ok is True.

    Hard requirements (§8):
      * non-empty `question`
      * at least two `options`
      * `correctIndex` present and in range
      * non-empty `evidenceQuote`
      * normalized `evidenceQuote` is a substring of normalized chapter text

    LIMITATION: a passing MCQ proves only that the cited evidence text exists
    verbatim in the chapter.  It does NOT prove the option at `correctIndex`
    is the semantically correct answer.
    """
    if not isinstance(mcq, dict):
        return False, "mcq_not_object"

    question = mcq.get("question")
    if not isinstance(question, str) or not question.strip():
        return False, "empty_question"

    options = mcq.get("options")
    if not isinstance(options, list):
        return False, "options_not_list"
    if len(options) < 2:
        return False, "too_few_options"
    # §HIGH E: EVERY option must be a non-empty string (no salvage).
    for o in options:
        if not isinstance(o, str) or not o.strip():
            return False, "empty_option"

    correct_index = mcq.get("correctIndex")
    if not isinstance(correct_index, int) or isinstance(correct_index, bool):
        return False, "correctIndex_not_int"
    if correct_index < 0 or correct_index >= len(options):
        return False, "correctIndex_out_of_range"
    # Explicit: the chosen option must be non-empty so _mcq_block never
    # receives an empty answer (redundant given the loop above, but explicit).
    if not options[correct_index].strip():
        return False, "empty_answer_option"

    evidence = mcq.get("evidenceQuote")
    if not isinstance(evidence, str) or not evidence.strip():
        return False, "empty_evidenceQuote"

    if not evidence_in_text(evidence, chapter_text):
        return False, "evidence_not_in_chapter"

    return True, None


# §HIGH F: accepted blank markers.
_BLANK_RE = re.compile(r'___|…|\[blank\]', re.IGNORECASE)


def validate_fillblank(fb: dict) -> tuple[bool, str | None]:
    """Validate a semantic fill-in-the-blank entry: needs a blank marker in
    the text and a non-empty answer (§HIGH F)."""
    if not isinstance(fb, dict):
        return False, "fillblank_not_object"
    text = fb.get("text")
    if not isinstance(text, str) or not text.strip():
        return False, "empty_text"
    if not _BLANK_RE.search(text.strip()):
        return False, "no_blank_marker"
    # §HIGH 6: answer MUST be a non-empty string. Integers/bools/objects/lists
    # are rejected — the composer must never stringify an arbitrary value.
    answer = fb.get("answer")
    if not isinstance(answer, str) or not answer.strip():
        return False, "empty_answer"
    return True, None


def disallowed_block_types(blocks: list[dict]) -> list[str]:
    """Return the list of block `type` values that are NOT in the Phase 1
    whitelist.  Empty list means every block is allowed.
    """
    bad: list[str] = []
    for b in blocks or []:
        if not isinstance(b, dict):
            bad.append("__not_object__")
            continue
        t = str(b.get("type") or "").lower()
        if t not in ALLOWED_BLOCK_TYPES:
            bad.append(t or "__missing_type__")
    return bad


def assert_blocks_allowed(blocks: list[dict]) -> None:
    """Raise ValueError if any block uses a type outside the Phase 1 whitelist.

    Used as a hard gate immediately before canonical export so an unsupported
    type can never reach `db.books`.
    """
    bad = disallowed_block_types(blocks)
    if bad:
        raise ValueError(f"disallowed block types reached export: {sorted(set(bad))}")
