"""tests/test_book_factory_validator.py
========================================
Pure-function tests for block-type whitelisting, evidence grounding, MCQ/
fillblank validation, and the canonical composer/export guarantees (§7-§9).
No network, no Mongo.
"""
from __future__ import annotations

import pytest

import book_factory_validator as v
import book_factory_composer as c


CHAPTER_TEXT = (
    "The cat sat on the warm mat by the door.\n"
    "Dara said, \u201cHello, how are you today?\u201d"
)


# ── block-type whitelist ───────────────────────────────────────────────────
def test_allowed_set_is_exact_intersection():
    assert v.ALLOWED_BLOCK_TYPES == frozenset(
        {"heading", "paragraph", "quote", "markdown", "dialog", "mcq", "fillblank"}
    )


@pytest.mark.parametrize("bad", ["image", "audio", "video", "embed", "transcript", "example"])
def test_forbidden_types_detected(bad):
    blocks = [{"type": "paragraph", "text": "ok"}, {"type": bad, "text": "x"}]
    assert v.disallowed_block_types(blocks) == [bad]
    with pytest.raises(ValueError):
        v.assert_blocks_allowed(blocks)


def test_all_allowed_passes():
    blocks = [{"type": t, "text": "x"} for t in v.ALLOWED_BLOCK_TYPES]
    assert v.disallowed_block_types(blocks) == []
    v.assert_blocks_allowed(blocks)  # no raise


# ── normalization + evidence grounding ─────────────────────────────────────
def test_normalize_collapses_ws_preserves_boundaries():
    assert v.normalize_text("  The   CAT\tsat. ") == "the cat sat"
    # boundary preserved: two words never glue into one
    assert "catsat" not in v.normalize_text("cat   sat")


def test_evidence_curly_quotes_match_straight():
    assert v.evidence_in_text("Hello, how are you today?", CHAPTER_TEXT)


def test_evidence_spanning_blocks():
    # evidence drawn from the concatenated paragraph+dialog text
    text = c.build_chapter_full_text({
        "paragraphs": ["The cat sat on the warm mat."],
        "dialogueLines": [{"speaker": "Dara", "text": "Hello there."}],
    })
    assert v.evidence_in_text("warm mat", text)


def test_evidence_absent_fails():
    assert not v.evidence_in_text("a spaceship landed", CHAPTER_TEXT)


# ── MCQ validation ─────────────────────────────────────────────────────────
def _mcq(**kw):
    base = {"question": "Where did the cat sit?",
            "options": ["on the mat", "on the roof"],
            "correctIndex": 0,
            "evidenceQuote": "The cat sat on the warm mat"}
    base.update(kw)
    return base


def test_valid_mcq_passes():
    ok, reason = v.validate_mcq(_mcq(), CHAPTER_TEXT)
    assert ok and reason is None


@pytest.mark.parametrize("mutation,expected", [
    ({"question": ""}, "empty_question"),
    ({"options": ["only one"]}, "too_few_options"),
    ({"correctIndex": 9}, "correctIndex_out_of_range"),
    ({"correctIndex": "0"}, "correctIndex_not_int"),
    ({"evidenceQuote": ""}, "empty_evidenceQuote"),
    ({"evidenceQuote": "not in the text"}, "evidence_not_in_chapter"),
])
def test_invalid_mcq_reasons(mutation, expected):
    ok, reason = v.validate_mcq(_mcq(**mutation), CHAPTER_TEXT)
    assert not ok
    assert reason == expected


def test_fillblank_validation():
    assert v.validate_fillblank({"text": "I ___ home", "answer": "go"})[0]
    assert not v.validate_fillblank({"text": "", "answer": "go"})[0]
    assert not v.validate_fillblank({"text": "I ___ home", "answer": ""})[0]


# ── composer / canonical export ─────────────────────────────────────────────
def test_mcq_block_matches_exerciseblock_contract():
    blocks = c.compose_chapter_blocks(
        {"paragraphs": ["The cat sat on the warm mat."]},
        [_mcq(explain="because")],
        [],
    )
    mcq = next(b for b in blocks if b["type"] == "mcq")
    assert set(mcq.keys()) == {"type", "text", "options", "answer", "explain"}
    assert mcq["answer"] == "on the mat"   # full option text, not {question,choices}
    assert "evidenceQuote" not in mcq


def test_export_forces_unpublished_and_preserves_tier_price():
    config = {"title": "My Book", "tier": "premium", "price": 499, "section": "story"}
    chapters = [{"title": "Ch1", "blocks": [{"type": "paragraph", "text": "hi"}]}]
    book = c.export_canonical_book(config, chapters)
    assert book["published"] is False
    assert book["tier"] == "premium"
    assert book["price"] == 499
    assert book["format"] == "blocks"
    assert book["chapters"] == [{"title": "Ch1", "blocks": [{"type": "paragraph", "text": "hi"}]}]


def test_export_strips_job_internal_and_provenance():
    chapters = [{
        "title": "Ch1",
        "blocks": [{
            "type": "mcq", "text": "Q?", "options": ["a", "b"], "answer": "a",
            "evidenceQuote": "leak", "_internal": "x", "attemptId": "att",
            "generationVersion": 3, "state": "completed",
        }],
    }]
    book = c.export_canonical_book({"title": "T"}, chapters)
    blk = book["chapters"][0]["blocks"][0]
    assert set(blk.keys()) == {"type", "text", "options", "answer"}
    # no job-internal / provenance fields anywhere in the payload
    flat = repr(book)
    for leak in ("evidenceQuote", "attemptId", "generationVersion", "chapterId", "_internal"):
        assert leak not in flat


def test_export_rejects_disallowed_block_type():
    chapters = [{"title": "Ch1", "blocks": [{"type": "image", "text": "http://x"}]}]
    with pytest.raises(ValueError):
        c.export_canonical_book({"title": "T"}, chapters)
