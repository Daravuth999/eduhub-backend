"""tests/test_sync_schema_chronological_invariant.py — proves the exact
invariant syncConsumption.js's binary search silently assumes
("`units` must be sorted ascending by start and non-overlapping") is now
actually ENFORCED at validate_sync_document, the one gate every sync
document (any producer) must pass through before persistence.

Context: video_ai_provider.segments_to_sync already defends its own ASR
producer path with a sort, for a documented real incident where an
out-of-order array made the karaoke highlight "jump to the end" almost
immediately after Play. That fix lived at ONE producer. This test proves
the schema-level gate now catches the SAME class of violation regardless
of which producer built the document — including future ones nobody has
written yet.
"""
from __future__ import annotations

import sync_schema


def _word(word, start, end):
    return sync_schema.build_word(word, start, end)


def _sentence(sentence_id, words, speaker_id=None):
    return sync_schema.build_sentence(sentence_id, words, speaker_id=speaker_id)


def _doc(paragraphs):
    return sync_schema.build_sync_document(
        media_ref="gridfs://sync_media/x.mp3", provider_category="synthesis",
        provider_version="test-v1", paragraphs=paragraphs, generated_at="2026-01-01T00:00:00Z",
        duration_sec=10.0,
    )


def test_well_ordered_conversation_document_is_valid():
    """The healthy case: sentences AND words strictly non-decreasing by
    start, matching real alternating-speaker conversation structure."""
    sentences = [
        _sentence("s1", [_word("Welcome", 0.0, 0.5), _word("today.", 0.5, 1.0)], speaker_id="S1"),
        _sentence("s2", [_word("Thanks", 1.0, 1.4), _word("David.", 1.4, 1.9)], speaker_id="S2"),
        _sentence("s3", [_word("Of", 1.9, 2.1), _word("course.", 2.1, 2.6)], speaker_id="S1"),
    ]
    ok, errors = sync_schema.validate_sync_document(_doc([sync_schema.build_paragraph("p1", sentences)]))
    assert ok, errors


def test_rejects_a_sentence_out_of_chronological_order_by_array_position():
    """The exact failure class from the documented incident: array
    position 2 (by index) has a SMALLER start than position 0/1 — the
    thing the frontend's binary search never itself verifies."""
    sentences = [
        _sentence("s1", [_word("Welcome", 0.0, 0.5)], speaker_id="S1"),
        _sentence("s2", [_word("Thanks", 60.0, 60.5)], speaker_id="S2"),
        _sentence("s3", [_word("early", 1.0, 1.5)], speaker_id="S1"),  # out of order
    ]
    ok, errors = sync_schema.validate_sync_document(_doc([sync_schema.build_paragraph("p1", sentences)]))
    assert not ok
    assert any("out of chronological order" in e for e in errors)


def test_rejects_words_out_of_chronological_order_within_a_single_sentence():
    """Even if every SENTENCE is correctly ordered, a scrambled word array
    inside one sentence is still exactly the invariant violation the
    frontend's word-level binary search (computeActiveWord) depends on."""
    sentences = [
        _sentence("s1", [_word("second", 1.0, 1.5), _word("first", 0.0, 0.5)]),
    ]
    ok, errors = sync_schema.validate_sync_document(_doc([sync_schema.build_paragraph("p1", sentences)]))
    assert not ok
    assert any("out of chronological order" in e for e in errors)


def test_small_float_rounding_noise_between_back_to_back_units_is_not_flagged():
    """Matches syncConsumption.js's own TOL=0.01 boundary discipline — two
    genuinely back-to-back units (end of one == start of next, give or
    take float noise) must not be treated as a violation."""
    sentences = [
        _sentence("s1", [_word("one.", 0.0, 1.0)]),
        _sentence("s2", [_word("two.", 0.999, 2.0)]),  # 0.001s of float noise
    ]
    ok, errors = sync_schema.validate_sync_document(_doc([sync_schema.build_paragraph("p1", sentences)]))
    assert ok, errors


def test_does_not_reorder_or_correct_anything_itself():
    """validate_sync_document's own contract: detection only, never
    silent repair — the exact same document object is returned unchanged
    (there is nothing to return; the caller's original dict is untouched)."""
    sentences = [
        _sentence("s1", [_word("Thanks", 60.0, 60.5)]),
        _sentence("s2", [_word("Welcome", 0.0, 0.5)]),
    ]
    doc = _doc([sync_schema.build_paragraph("p1", sentences)])
    before = [s["words"][0]["word"] for s in doc["paragraphs"][0]["sentences"]]
    sync_schema.validate_sync_document(doc)
    after = [s["words"][0]["word"] for s in doc["paragraphs"][0]["sentences"]]
    assert before == after == ["Thanks", "Welcome"]


def test_existing_structural_checks_are_unchanged():
    """The new invariant check is additive — pre-existing structural
    validation (missing fields, bad enums) still fires exactly as before."""
    ok, errors = sync_schema.validate_sync_document({"paragraphs": "not-a-list"})
    assert not ok
    assert any("must be a list" in e for e in errors)
    assert any("missing required field" in e for e in errors)
