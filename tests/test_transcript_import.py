"""tests/test_transcript_import.py
=====================================
Manual transcript import (§1.1/§0 Rule 2-3): SRT/VTT parsing into the
exact `{speaker, start, end, text}` shape video_ai_provider.
segments_to_sync already consumes — proves the parser output actually
feeds that SAME, unmodified consolidation path (no new interpolation,
no new paragraph-grouping logic), and that every word produced this way
is honestly marked interpolated, never measured.
"""
from __future__ import annotations

import pytest

import transcript_import as ti
import video_ai_provider as vai


SRT_SAMPLE = """1
00:00:00,000 --> 00:00:02,500
Before the sun rises, the village is still quiet.

2
00:00:02,500 --> 00:00:05,200
Today is Pchum Ben, the time when Khmer
families remember their ancestors.
"""

VTT_SAMPLE_NO_SPEAKER = """WEBVTT

1
00:00:00.000 --> 00:00:02.500
Before the sun rises, the village is still quiet.

2
00:00:02.500 --> 00:00:05.200
Today is Pchum Ben.
"""

VTT_SAMPLE_WITH_SPEAKERS = """WEBVTT

1
00:00:00.000 --> 00:00:02.500
<v Narrator>Before the sun rises, the village is still quiet.</v>

2
00:00:02.500 --> 00:00:05.200
<v Soka>Today is Pchum Ben, the time when Khmer families remember their ancestors.</v>
"""


# ── parse_srt ────────────────────────────────────────────────────────────
def test_parse_srt_extracts_real_cue_timing_and_text():
    segs = ti.parse_srt(SRT_SAMPLE)
    assert len(segs) == 2
    assert segs[0]["start"] == 0.0
    assert segs[0]["end"] == 2.5
    assert segs[0]["text"] == "Before the sun rises, the village is still quiet."
    assert segs[0]["speaker"] is None


def test_parse_srt_joins_a_multi_line_cue_into_one_text():
    segs = ti.parse_srt(SRT_SAMPLE)
    assert segs[1]["text"] == "Today is Pchum Ben, the time when Khmer families remember their ancestors."


def test_parse_srt_never_assigns_a_speaker_srt_has_no_speaker_concept():
    segs = ti.parse_srt(SRT_SAMPLE)
    assert all(s["speaker"] is None for s in segs)


def test_parse_srt_works_without_a_sequence_number_line():
    no_seq = "00:00:00,000 --> 00:00:01,000\nHello there.\n"
    segs = ti.parse_srt(no_seq)
    assert len(segs) == 1
    assert segs[0]["text"] == "Hello there."


def test_parse_srt_strips_inline_formatting_tags():
    tagged = "1\n00:00:00,000 --> 00:00:01,000\n<b>Hello</b> <i>there</i>.\n"
    segs = ti.parse_srt(tagged)
    assert segs[0]["text"] == "Hello there."


def test_parse_srt_rejects_empty_content_with_a_clear_error():
    with pytest.raises(ti.TranscriptImportError):
        ti.parse_srt("")


def test_parse_srt_rejects_content_with_no_parseable_cues():
    with pytest.raises(ti.TranscriptImportError):
        ti.parse_srt("this is not an SRT file at all")


# ── parse_vtt ────────────────────────────────────────────────────────────
def test_parse_vtt_extracts_real_cue_timing_and_text_without_speakers():
    segs = ti.parse_vtt(VTT_SAMPLE_NO_SPEAKER)
    assert len(segs) == 2
    assert segs[0]["start"] == 0.0
    assert segs[0]["end"] == 2.5
    assert segs[0]["text"] == "Before the sun rises, the village is still quiet."
    assert segs[0]["speaker"] is None


def test_parse_vtt_extracts_the_real_webvtt_voice_tag_as_speaker():
    segs = ti.parse_vtt(VTT_SAMPLE_WITH_SPEAKERS)
    assert segs[0]["speaker"] == "Narrator"
    assert segs[0]["text"] == "Before the sun rises, the village is still quiet."
    assert segs[1]["speaker"] == "Soka"
    assert segs[1]["text"] == "Today is Pchum Ben, the time when Khmer families remember their ancestors."


def test_parse_vtt_rejects_content_missing_the_required_webvtt_header():
    with pytest.raises(ti.TranscriptImportError):
        ti.parse_vtt("1\n00:00:00.000 --> 00:00:01.000\nHello.\n")


def test_parse_vtt_rejects_empty_content():
    with pytest.raises(ti.TranscriptImportError):
        ti.parse_vtt("")


def test_parse_vtt_supports_hour_prefixed_timestamps():
    hour_prefixed = "WEBVTT\n\n1\n01:00:00.000 --> 01:00:02.000\nAn hour in.\n"
    segs = ti.parse_vtt(hour_prefixed)
    assert segs[0]["start"] == 3600.0
    assert segs[0]["end"] == 3602.0


# ── parse_transcript_import (dispatch) ───────────────────────────────────
def test_dispatch_routes_srt_and_vtt_to_the_right_parser():
    assert ti.parse_transcript_import("srt", SRT_SAMPLE)[0]["text"].startswith("Before the sun")
    assert ti.parse_transcript_import("VTT", VTT_SAMPLE_NO_SPEAKER)[0]["text"].startswith("Before the sun")


def test_dispatch_rejects_an_unsupported_format_honestly():
    with pytest.raises(ti.TranscriptImportError):
        ti.parse_transcript_import("docx", "irrelevant")


# ── Integration: MUST feed straight into segments_to_sync, no parallel
#    consolidation path (§1.1 hard requirement) ──────────────────────────
def test_parsed_srt_segments_consolidate_via_the_existing_segments_to_sync_unchanged():
    segs = ti.parse_srt(SRT_SAMPLE)
    doc = vai.segments_to_sync(
        segs, provider_category="manual", provider_version="manual-import-srt",
        generated_at="2026-01-01T00:00:00Z",
    )
    all_words = [w for p in doc["paragraphs"] for s in p["sentences"] for w in s["words"]]
    assert len(all_words) > 0
    # No speaker in SRT -> segments_to_sync's own speaker_ids stays empty
    # -> no `speakers` key at all, exactly like any other speakerless call.
    assert "speakers" not in doc or not doc.get("speakers")


def test_parsed_srt_words_are_honestly_interpolated_never_measured():
    """§0 Rule 2 — the core correctness requirement. A cue-level import
    provides only one timestamp per LINE; segments_to_sync's own
    distribute_words interpolates every word within it, and NEVER sets
    `measured` — the same honesty already enforced for Gemini's own
    lower-confidence output must not be silently bypassed for an import."""
    segs = ti.parse_srt(SRT_SAMPLE)
    doc = vai.segments_to_sync(
        segs, provider_category="manual", provider_version="manual-import-srt",
        generated_at="2026-01-01T00:00:00Z",
    )
    all_words = [w for p in doc["paragraphs"] for s in p["sentences"] for w in s["words"]]
    assert len(all_words) > 0
    for w in all_words:
        assert w.get("measured") is not True
        assert w["confidence"].get("alignment") is None


def test_parsed_vtt_speakers_flow_through_to_real_speaker_ids_and_sentence_speakerid():
    segs = ti.parse_vtt(VTT_SAMPLE_WITH_SPEAKERS)
    doc = vai.segments_to_sync(
        segs, provider_category="manual", provider_version="manual-import-vtt",
        generated_at="2026-01-01T00:00:00Z",
    )
    speaker_ids = {sp["id"] for sp in doc.get("speakers") or []}
    assert speaker_ids == {"Narrator", "Soka"}
    all_sentences = [s for p in doc["paragraphs"] for s in p["sentences"]]
    assert all(s.get("speakerId") in speaker_ids for s in all_sentences)


def test_parsed_vtt_words_are_also_honestly_interpolated_never_measured():
    segs = ti.parse_vtt(VTT_SAMPLE_WITH_SPEAKERS)
    doc = vai.segments_to_sync(
        segs, provider_category="manual", provider_version="manual-import-vtt",
        generated_at="2026-01-01T00:00:00Z",
    )
    all_words = [w for p in doc["paragraphs"] for s in p["sentences"] for w in s["words"]]
    for w in all_words:
        assert w.get("measured") is not True


def test_manual_timing_correction_tools_work_identically_on_an_imported_document():
    """§5.5 — the manual timing-correction tools built in the prior round
    must work identically on an imported-and-consolidated document as on
    a Gemini-generated one. sync_studio_tools._apply_one_edit's
    set_word_timing branch has no provider-origin special-casing at all
    (confirmed by reading it directly) — this proves that by construction
    claim with real evidence: a correction on an imported word is marked
    measured/reviewer-provenance exactly like a Gemini one already was."""
    import sync_studio_tools as sst

    segs = ti.parse_srt(SRT_SAMPLE)
    doc = vai.segments_to_sync(
        segs, provider_category="manual", provider_version="manual-import-srt",
        generated_at="2026-01-01T00:00:00Z",
    )
    word_before = doc["paragraphs"][0]["sentences"][0]["words"][0]
    assert word_before.get("measured") is not True  # honestly interpolated before any correction

    sst._apply_one_edit(doc, {"op": "set_word_timing", "p": 0, "s": 0, "w": 0, "start": 0.1, "end": 0.4})

    word_after = doc["paragraphs"][0]["sentences"][0]["words"][0]
    assert word_after["measured"] is True
    assert word_after["source"] == "reviewer"
    assert word_after["start"] == 0.1
    assert word_after["end"] == 0.4


def test_consolidated_document_is_chronologically_valid_per_the_schema():
    """Reuses sync_schema.py's own validator — the same global order
    invariant every producer's document must satisfy, never worked
    around for the import path."""
    import sync_schema
    segs = ti.parse_srt(SRT_SAMPLE)
    doc_fragment = vai.segments_to_sync(
        segs, provider_category="manual", provider_version="manual-import-srt",
        generated_at="2026-01-01T00:00:00Z",
    )
    full_doc = sync_schema.build_sync_document(
        media_ref="gridfs://x/y.mp4", provider_category="manual", provider_version="manual-import-srt",
        paragraphs=doc_fragment["paragraphs"], generated_at="2026-01-01T00:00:00Z",
        duration_sec=doc_fragment["durationSec"],
    )
    ok, errors = sync_schema.validate_sync_document(full_doc)
    assert ok, errors
