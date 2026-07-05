"""tests/test_book_factory_content_quality.py
================================================
Surgical content-quality pass: IPA validation (never fabricated), Khmer/
bilingual vocabulary validation, and (later in this file) chapter-balance /
vocabulary-count-by-CEFR bounds. Pure functions — no network, no Mongo.
"""
from __future__ import annotations

import copy

import pytest
from fastapi import APIRouter, FastAPI, HTTPException
from fastapi.testclient import TestClient

import book_factory_validator as bfv
import book_factory_gemini as bf_gemini
import book_factory_jobs as bfj
from tests.test_book_factory_jobs import _DB


# ── IPA validation (Part D) ─────────────────────────────────────────────────
def test_valid_american_style_ipa():
    ok, norm, reason = bfv.validate_ipa("/rəkɑːr/")
    assert ok is True and reason is None
    assert norm == "/rəkɑːr/"


def test_valid_ipa_with_primary_and_secondary_stress():
    ok, norm, _ = bfv.validate_ipa("/ˌrekəmenˈdeɪʃən/")
    assert ok is True
    assert norm == "/ˌrekəmenˈdeɪʃən/"


def test_valid_british_style_ipa_with_length_mark():
    ok, norm, _ = bfv.validate_ipa("/kɑːr/")
    assert ok is True
    assert "ː" in norm


def test_valid_multiword_phrase_ipa():
    ok, norm, _ = bfv.validate_ipa("/wʌn stɛp æt ə taɪm/")
    assert ok is True
    assert " " in norm


def test_minimal_single_symbol_ipa_is_valid():
    ok, norm, _ = bfv.validate_ipa("/ə/")
    assert ok is True
    assert norm == "/ə/"


def test_ordinary_latin_spelling_falsely_presented_as_ipa_is_rejected():
    ok, norm, reason = bfv.validate_ipa("/recommendation/")
    assert ok is False and norm is None
    assert reason is not None


def test_plain_english_word_using_only_ipa_overlap_chars_is_rejected():
    """"sun" is spelled entirely with characters that ALSO happen to be valid
    IPA symbols (s, u, n) but contains no stress/length/marker character —
    the validator must still reject it as "looks like plain spelling"."""
    ok, norm, reason = bfv.validate_ipa("/sun/")
    assert ok is False
    assert reason == "ipa_looks_like_plain_spelling"


def test_malformed_delimiters_missing_close_is_rejected():
    ok, norm, reason = bfv.validate_ipa("/wʌn")
    assert ok is False and norm is None


def test_malformed_delimiters_mismatched_brackets_is_rejected():
    ok, norm, reason = bfv.validate_ipa("/wʌn]")
    assert ok is False


def test_unsupported_symbols_rejected():
    ok, norm, reason = bfv.validate_ipa("/wʌn$#@/")
    assert ok is False
    assert reason == "ipa_unsupported_symbols"


def test_empty_ipa_rejected():
    ok, norm, reason = bfv.validate_ipa("")
    assert ok is False
    assert reason == "ipa_empty"


def test_whitespace_only_ipa_rejected():
    ok, norm, reason = bfv.validate_ipa("   ")
    assert ok is False


def test_excessively_long_ipa_rejected():
    ok, norm, reason = bfv.validate_ipa("/" + "a" * 200 + "/")
    assert ok is False
    assert reason == "ipa_too_long"


def test_khmer_sentence_in_ipa_field_rejected():
    ok, norm, reason = bfv.validate_ipa("/នេះជាភាសាខ្មែរមិនមែនសូរស័ព្ទទេ/")
    assert ok is False


def test_english_sentence_in_ipa_field_rejected():
    ok, norm, reason = bfv.validate_ipa("/This is a whole sentence, not a transcription!/")
    assert ok is False


def test_non_string_ipa_rejected():
    ok, norm, reason = bfv.validate_ipa(12345)
    assert ok is False
    assert reason == "ipa_not_a_string"
    ok2, _, reason2 = bfv.validate_ipa(None)
    assert ok2 is False


def test_ipa_without_delimiters_is_still_validated_by_content():
    # Delimiters are optional on input (many prompts return bare IPA); the
    # validator still checks the actual phonetic content and normalizes the
    # OUTPUT to the canonical /…/ form.
    ok, norm, _ = bfv.validate_ipa("wʌn")
    assert ok is True
    assert norm == "/wʌn/"


def test_curly_quotes_and_unicode_are_normalized():
    ok, norm, _ = bfv.validate_ipa("’wʌn’")  # curly single quotes, not real delimiters
    # Curly quotes normalize to straight apostrophes (an allowed separator
    # char), not slash/bracket delimiters — content still validates on marker
    # presence via ʌ.
    assert ok is True


# ── stress-guide validation ─────────────────────────────────────────────────
def test_valid_stress_guide_accepted():
    assert bfv.validate_stress_guide("re-co-men-DA-tion") == "re-co-men-DA-tion"


def test_stress_guide_without_capitalized_syllable_rejected():
    assert bfv.validate_stress_guide("re-co-men-da-tion") is None


def test_stress_guide_non_string_rejected():
    assert bfv.validate_stress_guide(123) is None
    assert bfv.validate_stress_guide(None) is None


# ── Khmer script detection (Part E) ─────────────────────────────────────────
def test_contains_khmer_true_for_khmer_script():
    assert bfv.contains_khmer("ដំបូន្មានអំពីជម្រើស ឬសកម្មភាពដែលគួរធ្វើបំផុត។") is True


def test_contains_khmer_false_for_english_only():
    assert bfv.contains_khmer("This is only English.") is False


def test_contains_khmer_false_for_non_string():
    assert bfv.contains_khmer(None) is False
    assert bfv.contains_khmer(123) is False


# ── full vocabulary item validation (Part C/D/E integration) ────────────────
_GOOD_ITEM = {
    "word": "recommendation",
    "partOfSpeech": "noun",
    "ipa": "/ˌrekəmenˈdeɪʃən/",
    "stress": "re-co-men-DA-tion",
    "definitionEnglish": "Advice about the best action to take.",
    "explanationKhmer": "ដំបូន្មានអំពីជម្រើស ឬសកម្មភាពដែលគួរធ្វើបំផុត។",
    "example": "The manager gave us a useful recommendation.",
}


def test_valid_vocab_item_passes_through_with_no_warnings():
    out, warnings = bfv.validate_vocab_item(_GOOD_ITEM)
    assert out is not None
    assert warnings == []
    assert out["word"] == "recommendation"
    assert out["ipa"] == "/ˌrekəmenˈdeɪʃən/"
    assert out["explanationKhmer"].strip()
    assert out["example"]


def test_vocab_item_missing_word_is_dropped_entirely():
    out, warnings = bfv.validate_vocab_item({**_GOOD_ITEM, "word": ""})
    assert out is None
    assert warnings


def test_vocab_item_missing_definition_is_dropped_entirely():
    out, warnings = bfv.validate_vocab_item({**_GOOD_ITEM, "definitionEnglish": ""})
    assert out is None


def test_vocab_item_with_bad_ipa_omits_ipa_but_keeps_word(monkeypatch):
    out, warnings = bfv.validate_vocab_item({**_GOOD_ITEM, "ipa": "/recommendation/"})
    assert out is not None
    assert "ipa" not in out
    assert any("vocab_ipa_rejected" in w for w in warnings)
    assert out["word"] == "recommendation"  # word/definition survive


def test_vocab_item_missing_khmer_warns_but_keeps_english():
    out, warnings = bfv.validate_vocab_item({**_GOOD_ITEM, "explanationKhmer": ""})
    assert out is not None
    assert "explanationKhmer" not in out
    assert any("vocab_khmer_missing" in w for w in warnings)


def test_vocab_item_with_english_text_disguised_as_khmer_is_rejected():
    """A duplicated English sentence in the Khmer field (no Khmer script at
    all) must never be published as if it were the Khmer explanation."""
    out, warnings = bfv.validate_vocab_item({**_GOOD_ITEM, "explanationKhmer": "Advice about the best action."})
    assert out is not None
    assert "explanationKhmer" not in out
    assert any("vocab_khmer_missing_script" in w for w in warnings)


def test_vocab_item_unknown_part_of_speech_dropped_with_warning():
    out, warnings = bfv.validate_vocab_item({**_GOOD_ITEM, "partOfSpeech": "gerund-thing"})
    assert out is not None
    assert out["partOfSpeech"] == ""
    assert any("vocab_pos_dropped" in w for w in warnings)


def test_vocab_item_not_a_dict_rejected():
    out, warnings = bfv.validate_vocab_item("not a dict")
    assert out is None
    assert warnings == ["vocab_item_not_object"]


def test_vocab_item_legacy_meaning_key_still_works():
    """Backward-compat: the OLD semantic shape used "meaning" instead of
    "definitionEnglish" — must still populate definitionEnglish."""
    out, warnings = bfv.validate_vocab_item({"word": "cat", "meaning": "a small pet animal"})
    assert out is not None
    assert out["definitionEnglish"] == "a small pet animal"


# ── CEFR-scaled quantity ceiling ─────────────────────────────────────────────
@pytest.mark.parametrize("level,expected_hi", [("A1", 4), ("A2", 5), ("B1", 6), ("B2", 8)])
def test_vocab_count_range_by_cefr_level(level, expected_hi):
    lo, hi = bfv.vocab_count_range(level)
    assert hi == expected_hi
    assert lo <= hi


def test_vocab_count_range_unknown_level_falls_back_to_a2():
    assert bfv.vocab_count_range("Z9") == bfv.vocab_count_range("A2")


# ── chapter balance ──────────────────────────────────────────────────────────
def _mk_chapter(state, words, is_review=False):
    text = " ".join(["word"] * words)
    return {"state": state, "isReview": is_review, "blocks": [{"type": "paragraph", "text": text}]}


def test_chapter_balance_flags_a_disproportionately_long_chapter():
    chapters_map = {
        "c1": _mk_chapter("completed", 200),
        "c2": _mk_chapter("completed", 210),
        "c3": _mk_chapter("completed", 600),  # ~3x the others
    }
    warnings = bfj.check_chapter_balance(chapters_map, ["c1", "c2", "c3"])
    flagged = {w["chapterId"] for w in warnings}
    assert "c3" in flagged
    assert "c1" not in flagged and "c2" not in flagged


def test_chapter_balance_excludes_review_chapter_from_comparison():
    chapters_map = {
        "c1": _mk_chapter("completed", 200),
        "c2": _mk_chapter("completed", 210),
        "c3": _mk_chapter("completed", 900, is_review=True),  # deliberately longer, excluded
    }
    warnings = bfj.check_chapter_balance(chapters_map, ["c1", "c2", "c3"])
    assert warnings == []


def test_chapter_balance_no_warnings_when_evenly_matched():
    chapters_map = {"c1": _mk_chapter("completed", 200), "c2": _mk_chapter("completed", 220)}
    assert bfj.check_chapter_balance(chapters_map, ["c1", "c2"]) == []


def test_chapter_balance_ignores_incomplete_chapters():
    chapters_map = {
        "c1": _mk_chapter("completed", 200),
        "c2": _mk_chapter("pending", 900),  # not completed — must not be counted
    }
    assert bfj.check_chapter_balance(chapters_map, ["c1", "c2"]) == []


def test_chapter_balance_single_chapter_has_nothing_to_compare():
    chapters_map = {"c1": _mk_chapter("completed", 999)}
    assert bfj.check_chapter_balance(chapters_map, ["c1"]) == []


# ── end-to-end: full job flow produces individually-structured vocab blocks ─
async def _admin_dep():
    return {"email": "admin@test"}


def _make_client(db=None):
    app = FastAPI()
    api = APIRouter(prefix="/api")
    bfj.register_book_factory_routes(api, db or _DB(), _admin_dep)
    app.include_router(api)
    return TestClient(app)


def _enable_all(monkeypatch):
    monkeypatch.setenv("BOOK_FACTORY_VISIBLE", "true")
    monkeypatch.setenv("BOOK_FACTORY_ENABLED", "true")
    monkeypatch.setenv("BOOK_FACTORY_GEMINI_ENABLED", "true")
    monkeypatch.setenv("GEMINI_API_KEY", "test-key")


_RICH_CHAPTER = {
    "title": "Chapter 1",
    "paragraphs": ["A short opening paragraph to introduce the topic."],
    "dialogueLines": [{"speaker": "Dara", "text": "Let's talk about this."}],
    "vocabulary": [
        {"word": "recommendation", "partOfSpeech": "noun", "ipa": "/ˌrekəmenˈdeɪʃən/",
         "stress": "re-co-men-DA-tion", "definitionEnglish": "Advice about the best action.",
         "explanationKhmer": "ដំបូន្មានអំពីជម្រើសល្អបំផុត។", "example": "She gave a useful recommendation."},
        {"word": "achievement", "partOfSpeech": "noun", "ipa": "/recommendation/",  # bad IPA — should be dropped
         "definitionEnglish": "Something accomplished successfully.",
         "explanationKhmer": "", "example": "Winning was a great achievement."},
        {"word": "confidence", "partOfSpeech": "noun", "ipa": "/ˈkɒnfɪdəns/",
         "definitionEnglish": "A feeling of self-assurance.",
         "explanationKhmer": "ភាពជឿជាក់លើខ្លួនឯង។", "example": "He spoke with confidence."},
        {"word": "opportunity", "partOfSpeech": "noun", "ipa": "/ˌɒpəˈtjuːnəti/",
         "definitionEnglish": "A good chance for something.",
         "explanationKhmer": "ឱកាសល្អ។", "example": "This is a great opportunity."},
        {"word": "extra_one_too_many", "partOfSpeech": "noun", "ipa": "",
         "definitionEnglish": "Should be dropped by the CEFR cap for A2 (max 5).",
         "explanationKhmer": "", "example": ""},
        {"word": "another_extra", "partOfSpeech": "noun", "ipa": "",
         "definitionEnglish": "Should also be dropped by the CEFR cap.",
         "explanationKhmer": "", "example": ""},
    ],
    "pronunciationTargets": ["confidence"],
    "speakingPrompts": ["Describe a recent achievement."],
    "mcqs": [],
    "fillblanks": [],
    "summary": "A short recap of the chapter.",
}


def test_full_job_flow_produces_one_block_per_vocab_word_with_cefr_cap(monkeypatch):
    _enable_all(monkeypatch)

    async def fake_bp(config):
        return {"bookTitle": "B", "summary": "s", "chapters": [{"title": "One", "outline": "o"}]}

    async def fake_chapter(config, spec):
        return copy.deepcopy(_RICH_CHAPTER)

    monkeypatch.setattr(bf_gemini, "generate_blueprint", fake_bp)
    monkeypatch.setattr(bf_gemini, "generate_chapter", fake_chapter)

    client = _make_client()
    r = client.post("/api/studio/book-factory/jobs",
                    json={"config": {"title": "B", "topic": "Growth", "section": "story",
                                     "level": "A2", "pedagogyProfile": "general_english",
                                     "mode": "simple", "readingMinutes": 6,
                                     "minWordsPerChapter": 50, "maxWordsPerChapter": 320,
                                     "tier": "free", "price": 0, "chapterCount": 1}})
    job_id = r.json()["job"]["jobId"]
    r = client.post(f"/api/studio/book-factory/jobs/{job_id}/step", json={"stage": "blueprint"})
    cid = r.json()["job"]["chapterOrder"][0]
    client.post(f"/api/studio/book-factory/jobs/{job_id}/approve")
    r = client.post(f"/api/studio/book-factory/jobs/{job_id}/step", json={"chapterId": cid})
    assert r.json()["result"]["status"] == "completed"

    exp = client.get(f"/api/studio/book-factory/jobs/{job_id}/export").json()
    book = exp["book"]
    vocab_blocks = [b for b in book["chapters"][0]["blocks"]
                    if b["type"] == "markdown" and b["text"].startswith("### 📘")]

    # A2 CEFR cap is (4, 5) — 6 semantic vocab items in, at most 5 survive.
    assert len(vocab_blocks) == 5

    # Each word is its OWN block (never one combined blob).
    words_seen = [b["text"].split("\n")[0] for b in vocab_blocks]
    assert len(words_seen) == len(set(words_seen))

    # The valid IPA word carries its IPA; the deliberately-bad-IPA word does not.
    reco_block = next(b for b in vocab_blocks if "recommendation" in b["text"])
    assert "ˌrekəmenˈdeɪʃən" in reco_block["text"]
    achievement_block = next(b for b in vocab_blocks if "achievement" in b["text"])
    assert "IPA" not in achievement_block["text"]  # bad IPA silently omitted, never fabricated

    # Khmer explanation present for words that supplied real Khmer script.
    assert "ដំបូន្មាន" in reco_block["text"]

    # No single vocabulary block contains more than one word's content.
    for b in vocab_blocks:
        assert b["text"].count("### 📘") == 1
