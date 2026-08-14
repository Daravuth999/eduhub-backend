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


# ── §PART C: CEFR-scaled vocabulary-quantity ceiling (backend-authoritative;
# book_factory_gemini.py imports this SAME range for prompt guidance so the
# two can never drift apart) ────────────────────────────────────────────────
VOCAB_COUNT_BY_LEVEL: dict[str, tuple[int, int]] = {
    "A1": (3, 4), "A2": (4, 5), "B1": (5, 6), "B2": (6, 8),
}


def vocab_count_range(level: str) -> tuple[int, int]:
    return VOCAB_COUNT_BY_LEVEL.get((level or "A2").upper(), (4, 5))


# ── §PART D: IPA validation — never trust free-form Gemini IPA blindly ─────
#
# Gemini may PROPOSE an IPA transcription, but it is never published without
# passing this validator. On any failure the IPA is OMITTED (not fabricated,
# not passed through) and the word/definition/example are preserved — a
# missing IPA is always safer than a wrong or fake one.

# Broad-but-bounded whitelist of characters that legitimately appear inside
# an English IPA transcription: vowels, consonants, suprasegmentals (stress,
# length), and the separators multiword phrases legitimately need (space,
# hyphen, period as a syllable-break in some styles).
_IPA_ALLOWED_CHARS = frozenset(
    "ˈˌːˑ.ʰʲʷⁿˡ"                          # suprasegmentals / diacritics
    "iyɪʏeøɛœæaɶɐɑɒɔʌʊuɨʉɯəɚɝ"             # vowels
    "pbtdʈɖcɟkɡqɢʔ"                        # plosives
    "mɱnɳɲŋɴ"                              # nasals
    "ʙrʀⱱɾɽ"                               # trills / taps
    "ɸβfvθðszʃʒʂʐçʝxɣχʁħʕhɦ"               # fricatives
    "ɬɮʋɹɻjɰlɭʎʟ"                          # approximants / laterals
    "ʍw"
    " -'"                                  # word/syllable separators
)
# Characters whose PRESENCE proves the string is a real phonetic transcription
# rather than plain English spelling typed into the IPA field by mistake —
# every genuine IPA rendering of an English word contains at least one of
# these (a stress mark, length mark, schwa, or a non-ASCII phonetic symbol).
_IPA_MARKER_CHARS = frozenset("ˈˌːˑəɪʊʃʒθðŋɔæʌɛɜɑɒɡʔɾɹɻɯɨʉɶɐɚɝɸβçʝxɣχʁħʕɦɬɮʋɰɭʎʟʙʀⱱɽʈɖɳɲɴɱɟɢʰʲʷⁿˡ")

_IPA_MIN_LEN = 1      # a single symbol ("/ə/") is a valid, common transcription
_IPA_MAX_LEN = 80     # generous ceiling for a multiword phrase


def _strip_ipa_delimiters(raw: str) -> tuple[str, bool]:
    """Return (inner_content, had_delimiters). If delimiters are present they
    must be BALANCED (/ ... / or [ ... ]); mismatched/partial delimiters are
    signalled by returning had_delimiters=True with the ORIGINAL string
    unstripped, so the caller can reject it as malformed rather than silently
    stripping only one side."""
    s = raw.strip()
    if len(s) >= 2 and s[0] == "/" and s[-1] == "/":
        return s[1:-1].strip(), True
    if len(s) >= 2 and s[0] == "[" and s[-1] == "]":
        return s[1:-1].strip(), True
    # Unbalanced: starts with a delimiter char but doesn't close correctly.
    if s[:1] in ("/", "[") or s[-1:] in ("/", "]"):
        return s, True
    return s, False


def validate_ipa(raw) -> tuple[bool, str | None, str | None]:
    """Validate a proposed IPA transcription.

    Returns (ok, normalized_ipa, reason). `normalized_ipa` is the canonical
    "/…/"-wrapped string ONLY when ok is True; otherwise None — callers must
    never publish a value when ok is False.
    """
    if not isinstance(raw, str):
        return False, None, "ipa_not_a_string"

    # §1: normalize curly quotes / unicode / whitespace.
    s = unicodedata.normalize("NFKC", raw)
    s = "".join(_QUOTE_MAP.get(ch, ch) for ch in s)
    s = re.sub(r"\s+", " ", s).strip()

    if not s:
        return False, None, "ipa_empty"
    if len(s) > _IPA_MAX_LEN:
        return False, None, "ipa_too_long"

    inner, had_delims = _strip_ipa_delimiters(s)
    if had_delims and (not inner or inner[:1] in ("/", "[") or inner[-1:] in ("]", "/")):
        return False, None, "ipa_malformed_delimiters"
    if len(inner) < _IPA_MIN_LEN:
        return False, None, "ipa_too_short"
    if len(inner) > _IPA_MAX_LEN:
        return False, None, "ipa_too_long"

    # §2: every character must be an approved IPA symbol or separator.
    bad_chars = {ch for ch in inner if ch not in _IPA_ALLOWED_CHARS}
    if bad_chars:
        return False, None, "ipa_unsupported_symbols"

    # §3: reject ordinary Latin spelling disguised as IPA — a genuine English
    # IPA transcription contains at least one non-ASCII phonetic marker or a
    # stress/length mark; plain a-z-only content is almost certainly a
    # misplaced spelling, not a transcription.
    if not any(ch in _IPA_MARKER_CHARS for ch in inner):
        return False, None, "ipa_looks_like_plain_spelling"

    # §4 (contains no ordinary explanatory sentence): reject anything with
    # digits or punctuation beyond the allowed separator set (already
    # enforced by the character whitelist) — multi-sentence explanatory text
    # would contain characters (commas, periods used as sentence enders,
    # digits) outside _IPA_ALLOWED_CHARS and is rejected above.

    return True, f"/{inner}/", None


# Loose stress-guide validator (e.g. "re-co-men-DA-tion") — hyphen-separated
# syllables, at least one syllable in upper case. Purely advisory content;
# malformed input is simply omitted (never blocks the rest of the vocab item).
_STRESS_RE = re.compile(r"^[A-Za-z]+(-[A-Za-z]+)+$")


def validate_stress_guide(raw) -> str | None:
    if not isinstance(raw, str):
        return None
    s = raw.strip()
    if not s or len(s) > 60:
        return None
    if not _STRESS_RE.match(s):
        return None
    if not any(part.isupper() for part in s.split("-") if part.isalpha()):
        return None
    return s


# ── §PART E: Khmer script + bilingual vocabulary validation ────────────────
# Khmer Unicode block: U+1780–U+17FF.
_KHMER_RE = re.compile(r"[ក-៿]")


def contains_khmer(s) -> bool:
    return isinstance(s, str) and bool(_KHMER_RE.search(s))


_MAX_WORD_LEN = 80
_MAX_DEFINITION_LEN = 400
_MAX_KHMER_LEN = 400
_MAX_EXAMPLE_LEN = 300
_ALLOWED_POS = frozenset({
    "noun", "verb", "adjective", "adverb", "preposition", "conjunction",
    "pronoun", "interjection", "phrase", "expression", "idiom", "",
})


def validate_vocab_item(item: dict) -> tuple[dict | None, list[str]]:
    """Validate + sanitize one semantic vocabulary item into the canonical
    shape used by book_factory_composer._vocab_word_block.

    Returns (sanitized_item_or_None, warnings). `sanitized_item_or_None` is
    None only when the word/definition core is unusable (no salvage
    possible); IPA and Khmer are independently validated — a bad IPA or a
    missing/malformed Khmer explanation degrades gracefully (omitted +
    warned) rather than discarding the whole word.
    """
    warnings: list[str] = []
    if not isinstance(item, dict):
        return None, ["vocab_item_not_object"]

    word = str(item.get("word") or "").strip()
    if not word or len(word) > _MAX_WORD_LEN:
        return None, ["vocab_missing_or_invalid_word"]

    definition = str(item.get("definitionEnglish") or item.get("meaning") or "").strip()
    if not definition:
        return None, [f"vocab_missing_definition:{word}"]
    definition = definition[:_MAX_DEFINITION_LEN]

    pos = str(item.get("partOfSpeech") or "").strip().lower()
    if pos not in _ALLOWED_POS:
        warnings.append(f"vocab_pos_dropped:{word}")
        pos = ""

    out = {"word": word, "partOfSpeech": pos, "definitionEnglish": definition}

    ipa_ok, ipa_norm, ipa_reason = validate_ipa(item.get("ipa"))
    if ipa_ok:
        out["ipa"] = ipa_norm
    elif item.get("ipa"):  # something was proposed but failed — warn, don't fabricate
        warnings.append(f"vocab_ipa_rejected:{word}:{ipa_reason}")

    stress = validate_stress_guide(item.get("stress"))
    if stress:
        out["stress"] = stress

    khmer_raw = item.get("explanationKhmer") or item.get("khmer") or ""
    khmer = str(khmer_raw).strip()[:_MAX_KHMER_LEN]
    if khmer and contains_khmer(khmer):
        out["explanationKhmer"] = khmer
    elif khmer:
        # Non-empty but no Khmer script detected — likely a duplicated English
        # sentence or corrupted output. Never publish it as "Khmer".
        warnings.append(f"vocab_khmer_missing_script:{word}")
    else:
        warnings.append(f"vocab_khmer_missing:{word}")

    example = str(item.get("example") or "").strip()[:_MAX_EXAMPLE_LEN]
    if example:
        out["example"] = example

    return out, warnings
