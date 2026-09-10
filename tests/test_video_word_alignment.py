"""tests/test_video_word_alignment.py — real per-word alignment merge
(video_word_alignment.py), the Teleprompter karaoke structural-fix §1.

Covers: honest word-level merging (matched words get real Scribe timing +
confidence, unmatched words keep Gemini's own interpolation untouched),
multi-speaker/silence/off-script handling, provider-failure resilience
(never blocks the pipeline), and the architectural guarantee that the
alignment provider is reachable ONLY from the authoring-time pipeline,
never from any playback path — proven two ways: a call-count spy through
the real pipeline run, and a static import-boundary check that can never
regress silently.
"""
from __future__ import annotations

import ast
from pathlib import Path

import pytest

import video_word_alignment as vwa
from sync_schema import build_confidence, build_paragraph, build_sentence, build_sync_document, build_word


def _gemini_word(word, start, end):
    return build_word(word, start, end, confidence=build_confidence(transcript=None, alignment=None))


def _scribe_word(word, start, end, *, confidence=0.95):
    return build_word(word, start, end, confidence=build_confidence(transcript=confidence, alignment=None))


def _gemini_doc(words, *, speaker_id=None):
    sentence = build_sentence("s1", words, speaker_id=speaker_id)
    return build_sync_document(
        media_ref="", provider_category="speech_recognition", provider_version="gemini-video-asr-v1 (test, word-interp)",
        paragraphs=[build_paragraph("p1", [sentence])], generated_at="2026-01-01T00:00:00Z",
        duration_sec=words[-1]["end"] if words else 0.0,
    )


# ── merge_real_word_timing — the core matching/merge logic ────────────────
def test_matched_words_get_real_timing_and_honest_confidence():
    gemini = _gemini_doc([_gemini_word("hello", 0.0, 0.5), _gemini_word("world", 0.5, 1.0)])
    scribe_words = [_scribe_word("hello", 0.02, 0.48, confidence=0.99), _scribe_word("world", 0.51, 0.97, confidence=0.91)]

    merged, telemetry = vwa.merge_real_word_timing(gemini, scribe_words)

    words = merged["paragraphs"][0]["sentences"][0]["words"]
    assert words[0]["start"] == 0.02 and words[0]["end"] == 0.48
    assert words[0]["confidence"]["alignment"] == 0.99
    assert words[1]["start"] == 0.51 and words[1]["end"] == 0.97
    assert words[1]["confidence"]["alignment"] == 0.91
    assert telemetry == {
        "status": "complete", "provider": "elevenlabs-scribe-v1",
        "totalWords": 2, "matchedWords": 2, "matchRatio": 1.0,
        "meanAlignmentConfidence": pytest.approx(0.95),
        "lowConfidenceWordCount": 0,
        "attemptedAt": telemetry["attemptedAt"],  # timestamp, not asserted exactly
    }


def test_off_script_or_unrecognized_words_stay_interpolated_and_honestly_unconfident():
    """A word Gemini transcribed that Scribe's independent ASR did not
    recognize the same way (background noise, a mumble, genuine ASR
    disagreement) must NEVER be assigned a fabricated real timing —
    the interpolated estimate and its None alignment confidence are the
    honest answer here, exactly as before this feature existed."""
    gemini = _gemini_doc([
        _gemini_word("the", 0.0, 0.3), _gemini_word("quick", 0.3, 0.7), _gemini_word("fox", 0.7, 1.0),
    ])
    # Scribe only clearly recognized "the" and "fox" — "quick" is absent
    # (masked by noise), a real and expected ASR-disagreement scenario.
    scribe_words = [_scribe_word("the", 0.01, 0.29, confidence=0.98), _scribe_word("fox", 0.75, 1.05, confidence=0.9)]

    merged, telemetry = vwa.merge_real_word_timing(gemini, scribe_words)
    words = merged["paragraphs"][0]["sentences"][0]["words"]

    assert words[0]["start"] == 0.01  # "the" — matched, real timing
    assert words[1]["start"] == 0.3 and words[1]["end"] == 0.7  # "quick" — untouched interpolation
    assert words[1]["confidence"].get("alignment") is None  # never fabricated (key omitted, per build_confidence)
    assert words[2]["start"] == 0.75  # "fox" — matched, real timing
    assert telemetry["totalWords"] == 3
    assert telemetry["matchedWords"] == 2
    assert telemetry["matchRatio"] == round(2 / 3, 4)


def test_multi_speaker_structure_and_labels_are_never_touched():
    """Gemini's own sentence/speaker segmentation is the preserved source
    of truth (§1.4) — this function only ever rewrites word start/end/
    confidence, never speakerId, sentence boundaries, or paragraph
    grouping, even when merging in real per-word timing."""
    s1 = build_sentence("s1", [_gemini_word("hi", 0.0, 0.4)], speaker_id="S1")
    s2 = build_sentence("s2", [_gemini_word("hello", 1.0, 1.4)], speaker_id="S2")
    gemini = build_sync_document(
        media_ref="", provider_category="speech_recognition", provider_version="test",
        paragraphs=[build_paragraph("p1", [s1, s2])], generated_at="2026-01-01T00:00:00Z",
        duration_sec=1.4, speakers=[{"id": "S1", "label": "S1"}, {"id": "S2", "label": "S2"}],
    )
    scribe_words = [_scribe_word("hi", 0.05, 0.35), _scribe_word("hello", 1.02, 1.38)]

    merged, _telemetry = vwa.merge_real_word_timing(gemini, scribe_words)

    assert merged["paragraphs"][0]["sentences"][0]["speakerId"] == "S1"
    assert merged["paragraphs"][0]["sentences"][1]["speakerId"] == "S2"
    assert merged["speakers"] == [{"id": "S1", "label": "S1"}, {"id": "S2", "label": "S2"}]
    assert merged["paragraphs"][0]["sentences"][0]["words"][0]["start"] == 0.05  # still got real timing


def test_silence_gap_with_zero_scribe_words_leaves_everything_interpolated():
    """A sentence-level silence/no-recognizable-speech result from Scribe
    (e.g. it returned nothing at all) must degrade to the existing
    interpolated behavior, not error or fabricate timing."""
    gemini = _gemini_doc([_gemini_word("quiet", 0.0, 0.5)])
    merged, telemetry = vwa.merge_real_word_timing(gemini, [])
    words = merged["paragraphs"][0]["sentences"][0]["words"]
    assert words[0]["start"] == 0.0 and words[0]["end"] == 0.5
    assert words[0]["confidence"].get("alignment") is None
    assert telemetry["matchedWords"] == 0
    assert telemetry["matchRatio"] == 0.0
    assert telemetry["meanAlignmentConfidence"] is None


def test_low_confidence_matched_words_are_counted_honestly():
    gemini = _gemini_doc([_gemini_word("mumble", 0.0, 0.5)])
    merged, telemetry = vwa.merge_real_word_timing(gemini, [_scribe_word("mumble", 0.02, 0.48, confidence=0.2)])
    assert merged["paragraphs"][0]["sentences"][0]["words"][0]["confidence"]["alignment"] == 0.2
    assert telemetry["lowConfidenceWordCount"] == 1


def test_an_inverted_scribe_span_is_rejected_not_persisted():
    """Defensive: a provider returning a genuinely malformed end<start span
    must never corrupt the document — the interpolated span is kept."""
    gemini = _gemini_doc([_gemini_word("word", 1.0, 1.5)])
    bad = build_word("word", 2.0, 1.0, confidence=build_confidence(transcript=0.9))
    merged, telemetry = vwa.merge_real_word_timing(gemini, [bad])
    words = merged["paragraphs"][0]["sentences"][0]["words"]
    assert words[0]["start"] == 1.0 and words[0]["end"] == 1.5  # untouched
    assert telemetry["matchedWords"] == 0


# ── run_word_alignment — provider orchestration + resilience ──────────────
@pytest.mark.asyncio
async def test_run_word_alignment_returns_skipped_when_no_provider_configured():
    gemini = _gemini_doc([_gemini_word("hi", 0.0, 0.4)])
    sync_doc, telemetry = await vwa.run_word_alignment(b"audio", "hi", gemini, provider=None)
    assert sync_doc is gemini  # unchanged
    assert telemetry["status"] == "skipped"
    assert telemetry["provider"] is None


@pytest.mark.asyncio
async def test_run_word_alignment_never_raises_and_falls_back_on_provider_failure():
    """§1.5 pipeline resilience: a transient provider outage (rate limit,
    timeout, HTTP error) must never block the lesson — the pipeline must
    still complete using Gemini's existing interpolated timing."""
    class _FailingProvider:
        provider_version = "elevenlabs-scribe-v1"

        async def align(self, audio_bytes, transcript=None, **kwargs):
            raise RuntimeError("ElevenLabs Scribe 429: rate limited")

    gemini = _gemini_doc([_gemini_word("hi", 0.0, 0.4)])
    sync_doc, telemetry = await vwa.run_word_alignment(b"audio", "hi", gemini, provider=_FailingProvider())

    assert sync_doc is gemini
    assert sync_doc["paragraphs"][0]["sentences"][0]["words"][0]["start"] == 0.0  # interpolated, untouched
    assert telemetry["status"] == "failed"
    assert "rate limited" in telemetry["error"]
    assert telemetry["provider"] == "elevenlabs-scribe-v1"


@pytest.mark.asyncio
async def test_run_word_alignment_merges_on_a_successful_provider_call():
    class _FakeProvider:
        provider_version = "elevenlabs-scribe-v1"
        calls = 0

        async def align(self, audio_bytes, transcript=None, **kwargs):
            self.calls += 1
            scribe_doc = _gemini_doc([_scribe_word("hi", 0.03, 0.37, confidence=0.93)])
            return {"sync": scribe_doc}

    provider = _FakeProvider()
    gemini = _gemini_doc([_gemini_word("hi", 0.0, 0.4)])
    sync_doc, telemetry = await vwa.run_word_alignment(b"audio", "hi", gemini, provider=provider)

    assert provider.calls == 1
    assert sync_doc["paragraphs"][0]["sentences"][0]["words"][0]["start"] == 0.03
    assert telemetry["status"] == "complete"
    assert telemetry["matchedWords"] == 1


def test_get_word_alignment_provider_is_none_without_an_api_key(monkeypatch):
    monkeypatch.delenv("ELEVENLABS_API_KEY", raising=False)
    assert vwa.get_word_alignment_provider() is None


def test_get_word_alignment_provider_constructs_a_real_scribe_provider_when_key_present(monkeypatch):
    monkeypatch.setenv("ELEVENLABS_API_KEY", "test-key-123")
    provider = vwa.get_word_alignment_provider()
    assert provider is not None
    assert provider.category == "speech_recognition"
    assert provider.provider_version == "elevenlabs-scribe-v1"


# ── architectural guarantee (§1.3/§1.7): authoring-time only, never
#    playback-reachable — proven structurally, not just by convention ─────
def test_video_word_alignment_module_is_imported_only_by_the_authoring_pipeline():
    """Static, permanent regression guard: if a future change ever wires
    this module into a student-facing route (sync_studio_tools.py's
    playback routes, video_library_tools.py's student endpoints, or
    server.py directly), this test fails immediately — the constraint is
    enforced by the codebase's actual import graph, not merely by
    convention or a docstring."""
    repo_root = Path(__file__).resolve().parent.parent
    importers = []
    for py_file in repo_root.glob("*.py"):
        if py_file.name in ("video_word_alignment.py",):
            continue
        try:
            tree = ast.parse(py_file.read_text(encoding="utf-8"), filename=str(py_file))
        except SyntaxError:
            continue
        for node in ast.walk(tree):
            if isinstance(node, ast.Import) and any(a.name == "video_word_alignment" for a in node.names):
                importers.append(py_file.name)
            if isinstance(node, ast.ImportFrom) and node.module == "video_word_alignment":
                importers.append(py_file.name)

    assert importers == ["video_pipeline_tools.py"], (
        f"video_word_alignment.py must be imported ONLY by the authoring-time pipeline "
        f"(video_pipeline_tools.py), never by a student-facing route module. "
        f"Found importers: {importers}"
    )


@pytest.mark.asyncio
async def test_alignment_provider_is_called_exactly_once_per_pipeline_run_via_a_real_pipeline_execution():
    """Dynamic proof alongside the static one above: drives an ACTUAL
    video_pipeline_tools.run_pipeline() call (the real authoring-time
    entrypoint) with a spy standing in for the alignment provider, and
    asserts it was invoked exactly once — then separately confirms no
    student-facing sync-document read path (get_sync_document /
    is_servable_to_students) touches video_word_alignment at all, since
    those functions don't import it (already proven statically above;
    this just documents the same guarantee from the call-site side)."""
    import video_pipeline_tools as vpt

    class _CountingProvider:
        provider_version = "elevenlabs-scribe-v1"

        def __init__(self):
            self.call_count = 0

        async def align(self, audio_bytes, transcript=None, **kwargs):
            self.call_count += 1
            return {"sync": _gemini_doc([_scribe_word("hi", 0.02, 0.38)])}

    counting_provider = _CountingProvider()

    class _Coll:
        def __init__(self):
            self.docs = {}

        async def insert_one(self, doc):
            self.docs[doc["lessonId"]] = dict(doc)

        async def find_one(self, query, projection=None):
            for doc in self.docs.values():
                if all(doc.get(k) == v for k, v in query.items() if not isinstance(v, dict)):
                    return dict(doc)
            return None

        async def update_one(self, query, update):
            for doc in self.docs.values():
                if all(doc.get(k) == v for k, v in query.items() if not isinstance(v, dict)):
                    if "$set" in update:
                        for k, v in update["$set"].items():
                            doc[k] = v
                    return
            return None

        async def find_one_and_update(self, query, update):
            for doc in self.docs.values():
                if all(doc.get(k) == v for k, v in query.items() if not isinstance(v, dict)):
                    before = dict(doc)
                    if "$set" in update:
                        for k, v in update["$set"].items():
                            doc[k] = v
                    return before
            return None

    class _FakeDB:
        def __init__(self):
            self.video_lessons = _Coll()

        def __getitem__(self, name):
            return self.video_lessons

    class _FastBucket:
        class _GridOut:
            metadata = {"contentType": "audio/mpeg"}

            async def read(self):
                return b"fake-audio-bytes"

        async def open_download_stream_by_name(self, filename):
            return self._GridOut()

    import pytest as _pytest

    monkeypatch = _pytest.MonkeyPatch()
    try:
        monkeypatch.setattr(vpt, "PIPELINE_TIMEOUT_S", 5.0)
        monkeypatch.setattr(vpt, "MEDIA_FETCH_TIMEOUT_S", 5.0)
        monkeypatch.delenv("GEMINI_API_KEY", raising=False)
        monkeypatch.setenv("VIDEO_AI_MOCK", "1")
        monkeypatch.setattr(vwa, "get_word_alignment_provider", lambda: counting_provider)
        monkeypatch.setattr(vpt.video_render_tools, "extract_audio_track", lambda *a, **k: _async_none())
        monkeypatch.setattr(vpt.video_render_tools, "probe_audio_duration_seconds", lambda *a, **k: _async_none())

        async def _noop(*a, **k):
            return None

        async def _fake_apply(db, sync_id, result_fields):
            return {"durationSec": result_fields.get("durationSec", 1.0)}

        monkeypatch.setattr(vpt.sync_studio_tools, "mark_alignment_processing", _noop)
        monkeypatch.setattr(vpt.sync_studio_tools, "apply_alignment_result", _fake_apply)
        monkeypatch.setattr(vpt.sync_studio_tools, "suggest_speaker_labels", _noop)
        monkeypatch.setattr(vpt.sync_studio_tools, "mark_alignment_failed", _noop)

        db = _FakeDB()
        lesson = {
            "lessonId": "vid_1", "title": "Test", "mediaRef": "gridfs://sync_media/vid_1.mp3",
            "syncId": "sync_1", "contentType": "audio/mpeg",
        }
        await db.video_lessons.insert_one(lesson)

        await vpt.run_pipeline(db, "vid_1", _FastBucket())
    finally:
        monkeypatch.undo()

    assert counting_provider.call_count == 1, (
        "the alignment provider must be called exactly once for this one pipeline run — "
        f"was called {counting_provider.call_count} times"
    )


async def _async_none():
    return None
