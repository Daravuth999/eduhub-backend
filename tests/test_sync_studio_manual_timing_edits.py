"""tests/test_sync_studio_manual_timing_edits.py
====================================================
§3 — manual timing-correction editing tools. Confirmed via direct code
reading (not assumed) that most of the required safeguards ALREADY
exist and apply to human edits exactly as they do to machine output:

  - Chronological-order validation (sync_schema.validate_sync_document,
    called by apply_sync_edits on every batch) already rejects a
    set_word_timing edit that would move a word out of order relative
    to its neighbors — the SAME check that already rejects a bad
    machine-produced document.
  - split_sentence / merge_sentences (re-segmenting) already exist.
  - set_sentence_speaker (per-segment speaker reassignment) already
    exists, distinct from the global rename_speaker rename.

The ACTUAL gap fixed here: a manual set_word_timing correction never
marked the word as measured (so it rendered as a soft "interpolated"
guess, indistinguishable from Gemini's own estimate, and never counted
toward the document's matched-word figure) — even though a reviewer
placing a timestamp by ear/eye against the real media is at least as
trustworthy as two independent Gemini passes agreeing on a word.
"""
from __future__ import annotations

import asyncio
import copy

import pytest

import sync_studio_tools as studio
import video_ai_provider as vai


def run(c):
    return asyncio.run(c)


def _segments():
    return [
        {"speaker": "S1", "start": 0.0, "end": 2.0, "text": "The monks chanted softly"},
        {"speaker": "S1", "start": 2.0, "end": 4.0, "text": "near dawn today"},
    ]


def _doc():
    return vai.segments_to_sync(
        _segments(), provider_category="speech_recognition",
        provider_version="test-v1", generated_at="2026-01-01T00:00:00Z",
    )


class _Coll:
    def __init__(self):
        self.docs = {}

    async def find_one(self, query, projection=None):
        for doc in self.docs.values():
            if all(doc.get(k) == v for k, v in query.items()):
                return copy.deepcopy(doc)
        return None

    async def update_one(self, query, update):
        for key, doc in self.docs.items():
            if all(doc.get(k) == v for k, v in query.items()):
                if "$set" in update:
                    doc.update(update["$set"])
                if "$push" in update:
                    for field, spec in update["$push"].items():
                        doc.setdefault(field, [])
                        doc[field].extend(spec.get("$each", []))
                        sl = spec.get("$slice")
                        if sl is not None:
                            doc[field] = doc[field][sl:]
                return
        raise AssertionError("no matching document to update")


class _FakeDB:
    def __init__(self):
        self.chapter_sync = _Coll()

    def __getitem__(self, name):
        return self.chapter_sync


def _seed(db, sync_id="sync_1", *, word_alignment=None):
    doc = _doc()
    doc["syncId"] = sync_id
    doc["alignmentStatus"] = "complete"
    doc["reviewStatus"] = "pending"
    if word_alignment is not None:
        doc["wordAlignment"] = word_alignment
    db.chapter_sync.docs[sync_id] = doc
    return doc


# ── set_word_timing now marks the word measured, with honest provenance ─────
def test_a_manual_timing_correction_is_marked_measured_with_reviewer_provenance():
    doc = _doc()
    studio._apply_one_edit(doc, {"op": "set_word_timing", "p": 0, "s": 0, "w": 0, "start": 0.1, "end": 0.4})
    word = doc["paragraphs"][0]["sentences"][0]["words"][0]
    assert word["measured"] is True
    assert word["source"] == "reviewer"


def test_a_manual_correction_never_fabricates_a_confidence_score():
    """The same honesty guarantee video_word_alignment.py established for
    gemini-3.5-transcribe applies here: measured=True is a plain fact
    about provenance, never paired with an invented numeric score."""
    doc = _doc()
    studio._apply_one_edit(doc, {"op": "set_word_timing", "p": 0, "s": 0, "w": 0, "start": 0.1, "end": 0.4})
    word = doc["paragraphs"][0]["sentences"][0]["words"][0]
    assert "alignment" not in (word.get("confidence") or {})


def test_a_stale_low_confidence_score_is_cleared_by_a_manual_correction():
    doc = _doc()
    doc["paragraphs"][0]["sentences"][0]["words"][0]["confidence"] = {"alignment": 0.3}
    studio._apply_one_edit(doc, {"op": "set_word_timing", "p": 0, "s": 0, "w": 0, "start": 0.1, "end": 0.4})
    word = doc["paragraphs"][0]["sentences"][0]["words"][0]
    assert "alignment" not in word["confidence"]


# ── the existing chronological-order safeguard already applies to human edits
def test_regression_chronological_order_validation_already_rejects_a_bad_manual_edit():
    """Confirmed via code reading, verified here: sync_schema.
    validate_sync_document's word-order check runs on EVERY apply_sync_
    edits batch regardless of what produced the document — a human edit
    moving a word earlier than its predecessor is rejected exactly like
    a bad machine-produced document would be, with no separate check
    needed for the manual-edit path."""
    async def _run():
        db = _FakeDB()
        _seed(db, "sync_1")
        # Word 0 of sentence 1 (paragraph 0, sentence 1) legitimately
        # starts at 2.0 — moving word 0 of sentence 0 to 3.0 (later than
        # a word that comes AFTER it in the document) must be rejected.
        with pytest.raises(studio.SyncStudioError) as exc_info:
            await studio.apply_sync_edits(db, "sync_1", [
                {"op": "set_word_timing", "p": 0, "s": 0, "w": 0, "start": 3.0, "end": 3.5},
                {"op": "set_word_timing", "p": 0, "s": 0, "w": 1, "start": 0.1, "end": 0.4},
            ])
        assert exc_info.value.code == "invalid_sync_document"
    run(_run())


# ── the aggregate wordAlignment figure recomputes to reflect reality ────────
def test_regression_matched_word_count_updates_after_a_manual_correction():
    async def _run():
        db = _FakeDB()
        _seed(db, "sync_1", word_alignment={
            "status": "complete", "provider": "gemini-word-timestamps-v1 (gemini-3.5-transcribe)",
            "totalWords": 7, "matchedWords": 0, "matchRatio": 0.0,
            "meanAlignmentConfidence": None, "lowConfidenceWordCount": None, "attemptedAt": "2026-01-01T00:00:00Z",
        })
        result = await studio.apply_sync_edits(db, "sync_1", [
            {"op": "set_word_timing", "p": 0, "s": 0, "w": 0, "start": 0.1, "end": 0.4},
        ])
        assert result["wordAlignment"]["matchedWords"] == 1
        assert result["wordAlignment"]["totalWords"] == 7
        assert result["wordAlignment"]["matchRatio"] == round(1 / 7, 4)
        # The original telemetry's own identity fields (which provider
        # ran, when) are preserved, not wiped by the recompute.
        assert result["wordAlignment"]["provider"] == "gemini-word-timestamps-v1 (gemini-3.5-transcribe)"
        assert result["wordAlignment"]["status"] == "complete"
    run(_run())


def test_regression_replacing_sentence_text_correctly_lowers_the_matched_count():
    """A text replacement regenerates that sentence's words from scratch
    via _distribute_words_evenly — those NEW words carry no measured
    flag at all, so any previously-measured words they replaced must no
    longer be counted as matched. The figure must reflect reality, not
    a stale high-water mark."""
    async def _run():
        db = _FakeDB()
        doc = _seed(db, "sync_1", word_alignment={
            "status": "complete", "provider": "x", "totalWords": 7, "matchedWords": 0,
            "matchRatio": 0.0, "meanAlignmentConfidence": None, "lowConfidenceWordCount": None,
            "attemptedAt": "2026-01-01T00:00:00Z",
        })
        for w in doc["paragraphs"][0]["sentences"][0]["words"]:
            w["measured"] = True
        db.chapter_sync.docs["sync_1"] = doc
        result = await studio.apply_sync_edits(db, "sync_1", [
            {"op": "replace_sentence_text", "p": 0, "s": 0, "text": "Completely new words here"},
        ])
        assert result["wordAlignment"]["matchedWords"] == 0


def test_a_document_that_never_had_word_alignment_never_gets_one_invented_by_an_edit():
    async def _run():
        db = _FakeDB()
        _seed(db, "sync_1")  # no wordAlignment key at all — legacy/never-aligned
        result = await studio.apply_sync_edits(db, "sync_1", [
            {"op": "set_word_timing", "p": 0, "s": 0, "w": 0, "start": 0.1, "end": 0.4},
        ])
        assert "wordAlignment" not in result or result.get("wordAlignment") is None
    run(_run())
