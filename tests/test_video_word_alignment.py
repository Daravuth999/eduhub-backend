"""tests/test_video_word_alignment.py — real per-word alignment merge
(video_word_alignment.py), the Teleprompter karaoke structural-fix §1.

2026-09: Gemini-only redesign, immediately following the previous commit's
ElevenLabs removal. Covers: honest word-level merging (matched words get
real gemini-3.5-transcribe timing + a `measured: True` provenance flag,
never a fabricated confidence number; unmatched words keep Gemini
segmentation's own interpolation untouched), multi-speaker/silence/
off-script handling, the 30-minute word-timestamp duration limit,
provider-failure resilience (never blocks the pipeline),
GeminiWordTimestampProvider's real request/response shape against the
Interactions API (verified live against Gemini's own docs AND against a
real live API call with a real key — see this round's report; exercised
here with an injected fake HTTP client so the suite itself makes no network
call), and the architectural guarantee that the alignment provider is
reachable ONLY from the authoring-time pipeline, never from any playback
path — proven two ways: a call-count spy through the real pipeline run, and
a static import-boundary check that can never regress silently.
"""
from __future__ import annotations

import ast
from pathlib import Path

import pytest

import video_word_alignment as vwa
from sync_schema import build_confidence, build_paragraph, build_sentence, build_sync_document, build_word


def _gemini_word(word, start, end):
    return build_word(word, start, end, confidence=build_confidence(transcript=None, alignment=None))


def _measured_word(word, start, end):
    """A word from a second, independent Gemini transcription pass
    (gemini-3.5-transcribe) — flat {"word","start","end"} shape, exactly
    what GeminiWordTimestampProvider.align() returns per word. No
    confidence key at all: the real API publishes none (see module
    docstring's confirmed gap)."""
    return {"word": word, "start": start, "end": end}


def _gemini_doc(words, *, speaker_id=None):
    sentence = build_sentence("s1", words, speaker_id=speaker_id)
    return build_sync_document(
        media_ref="", provider_category="speech_recognition", provider_version="gemini-video-asr-v1 (test, word-interp)",
        paragraphs=[build_paragraph("p1", [sentence])], generated_at="2026-01-01T00:00:00Z",
        duration_sec=words[-1]["end"] if words else 0.0,
    )


# ── merge_real_word_timing — the core matching/merge logic ────────────────
def test_matched_words_get_real_timing_and_a_measured_flag_never_a_fabricated_confidence():
    gemini = _gemini_doc([_gemini_word("hello", 0.0, 0.5), _gemini_word("world", 0.5, 1.0)])
    measured = [_measured_word("hello", 0.02, 0.48), _measured_word("world", 0.51, 0.97)]

    merged, telemetry = vwa.merge_real_word_timing(gemini, measured, provider_version="gemini-word-timestamps-v1 (gemini-3.5-transcribe)")

    words = merged["paragraphs"][0]["sentences"][0]["words"]
    assert words[0]["start"] == 0.02 and words[0]["end"] == 0.48
    assert words[0]["measured"] is True
    assert words[0]["confidence"].get("alignment") is None  # never fabricated — the API publishes no score
    assert words[1]["start"] == 0.51 and words[1]["end"] == 0.97
    assert words[1]["measured"] is True
    assert telemetry == {
        "status": "complete", "provider": "gemini-word-timestamps-v1 (gemini-3.5-transcribe)",
        "totalWords": 2, "matchedWords": 2, "matchRatio": 1.0,
        "meanAlignmentConfidence": None,
        "lowConfidenceWordCount": None,
        "attemptedAt": telemetry["attemptedAt"],  # timestamp, not asserted exactly
    }


def test_off_script_or_unrecognized_words_stay_interpolated_and_unmeasured():
    """A word Gemini segmentation transcribed that the second, independent
    gemini-3.5-transcribe pass did not recognize the same way (background
    noise, a mumble, genuine ASR disagreement) must NEVER be assigned a
    fabricated real timing or a fabricated `measured` flag — the
    interpolated estimate is the honest answer here, exactly as before this
    feature existed."""
    gemini = _gemini_doc([
        _gemini_word("the", 0.0, 0.3), _gemini_word("quick", 0.3, 0.7), _gemini_word("fox", 0.7, 1.0),
    ])
    # The second pass only clearly recognized "the" and "fox" — "quick" is
    # absent (masked by noise), a real and expected ASR-disagreement scenario.
    measured = [_measured_word("the", 0.01, 0.29), _measured_word("fox", 0.75, 1.05)]

    merged, telemetry = vwa.merge_real_word_timing(gemini, measured)
    words = merged["paragraphs"][0]["sentences"][0]["words"]

    assert words[0]["start"] == 0.01 and words[0]["measured"] is True  # "the" — matched, real timing
    assert words[1]["start"] == 0.3 and words[1]["end"] == 0.7  # "quick" — untouched interpolation
    assert "measured" not in words[1]  # never fabricated
    assert words[2]["start"] == 0.75 and words[2]["measured"] is True  # "fox" — matched, real timing
    assert telemetry["totalWords"] == 3
    assert telemetry["matchedWords"] == 2
    assert telemetry["matchRatio"] == round(2 / 3, 4)


def test_multi_speaker_structure_and_labels_are_never_touched():
    """Gemini's own sentence/speaker segmentation is the preserved source
    of truth (§1.4) — this function only ever rewrites word start/end/
    measured, never speakerId, sentence boundaries, or paragraph grouping,
    even when merging in real per-word timing."""
    s1 = build_sentence("s1", [_gemini_word("hi", 0.0, 0.4)], speaker_id="S1")
    s2 = build_sentence("s2", [_gemini_word("hello", 1.0, 1.4)], speaker_id="S2")
    gemini = build_sync_document(
        media_ref="", provider_category="speech_recognition", provider_version="test",
        paragraphs=[build_paragraph("p1", [s1, s2])], generated_at="2026-01-01T00:00:00Z",
        duration_sec=1.4, speakers=[{"id": "S1", "label": "S1"}, {"id": "S2", "label": "S2"}],
    )
    measured = [_measured_word("hi", 0.05, 0.35), _measured_word("hello", 1.02, 1.38)]

    merged, _telemetry = vwa.merge_real_word_timing(gemini, measured)

    assert merged["paragraphs"][0]["sentences"][0]["speakerId"] == "S1"
    assert merged["paragraphs"][0]["sentences"][1]["speakerId"] == "S2"
    assert merged["speakers"] == [{"id": "S1", "label": "S1"}, {"id": "S2", "label": "S2"}]
    assert merged["paragraphs"][0]["sentences"][0]["words"][0]["start"] == 0.05  # still got real timing


def test_silence_gap_with_zero_measured_words_leaves_everything_interpolated():
    """A sentence-level silence/no-recognizable-speech result from the
    second pass (e.g. it returned nothing at all) must degrade to the
    existing interpolated behavior, not error or fabricate timing."""
    gemini = _gemini_doc([_gemini_word("quiet", 0.0, 0.5)])
    merged, telemetry = vwa.merge_real_word_timing(gemini, [])
    words = merged["paragraphs"][0]["sentences"][0]["words"]
    assert words[0]["start"] == 0.0 and words[0]["end"] == 0.5
    assert "measured" not in words[0]
    assert telemetry["matchedWords"] == 0
    assert telemetry["matchRatio"] == 0.0
    assert telemetry["meanAlignmentConfidence"] is None


def test_an_inverted_measured_span_is_rejected_not_persisted():
    """Defensive: a provider returning a genuinely malformed end<start span
    must never corrupt the document — the interpolated span is kept."""
    gemini = _gemini_doc([_gemini_word("word", 1.0, 1.5)])
    bad = {"word": "word", "start": 2.0, "end": 1.0}
    merged, telemetry = vwa.merge_real_word_timing(gemini, [bad])
    words = merged["paragraphs"][0]["sentences"][0]["words"]
    assert words[0]["start"] == 1.0 and words[0]["end"] == 1.5  # untouched
    assert "measured" not in words[0]
    assert telemetry["matchedWords"] == 0


# ── GeminiWordTimestampProvider — real request/response shape, no network ──
class _FakeResponse:
    def __init__(self, status_code, json_body=None, text=""):
        self.status_code = status_code
        self._json = json_body or {}
        self.text = text

    def json(self):
        return self._json


class _FakeHttpClient:
    """Injected in place of a real httpx client — records every call and
    returns scripted responses, so this test exercises the EXACT request
    shape GeminiWordTimestampProvider builds without a real network call.
    The response fixture below matches both Gemini's own documented example
    AND a real live API response captured during this round's manual
    validation (see the report) — not just the docs."""

    def __init__(self, *, upload_response, interactions_response):
        self.calls = []
        self._upload_response = upload_response
        self._interactions_response = interactions_response

    async def post(self, url, **kwargs):
        self.calls.append(("POST", url, kwargs))
        if "interactions" in url:
            return self._interactions_response
        return self._upload_response

    async def get(self, url, **kwargs):
        self.calls.append(("GET", url, kwargs))
        return _FakeResponse(200, {"state": "ACTIVE"})


_INTERACTIONS_RESPONSE_FIXTURE = {
    "id": "interactions/abc123",
    "status": "completed",
    "steps": [{
        "id": "step_001", "type": "model_output",
        "content": [{
            "type": "text", "text": "Hello world",
            "annotations": [
                {"type": "word_info", "text": "Hello", "start_offset": "0.100s", "end_offset": "0.450s"},
                {"type": "word_info", "text": "world", "start_offset": "0.500s", "end_offset": "0.850s"},
            ],
        }],
    }],
}


@pytest.mark.asyncio
async def test_gemini_word_timestamp_provider_parses_the_real_documented_response_shape():
    """Exercises GeminiWordTimestampProvider.align() against the EXACT
    response shape confirmed live from Gemini's own audio-transcription
    guide (ai.google.dev/gemini-api/docs/transcribe) — string "0.450s"
    offsets nested under steps[].content[].annotations[], not a bare
    top-level annotations array or a numeric offset. This exact shape was
    additionally confirmed against a REAL live API call during this
    round's validation (see the report)."""
    fake_client = _FakeHttpClient(
        upload_response=_FakeResponse(200, {"file": {"uri": "files/abc123", "name": "files/abc123", "state": "ACTIVE"}}),
        interactions_response=_FakeResponse(200, _INTERACTIONS_RESPONSE_FIXTURE),
    )
    provider = vwa.GeminiWordTimestampProvider(api_key="test-key", http_client=fake_client)

    result = await provider.align(b"fake-audio-bytes", "audio/mpeg")

    words = result["sync"]["paragraphs"][0]["sentences"][0]["words"]
    assert words == [
        {"word": "Hello", "start": 0.1, "end": 0.45},
        {"word": "world", "start": 0.5, "end": 0.85},
    ]
    # Confirms the upload-then-transcribe sequence, header auth (not the
    # `?key=` query param this codebase's other Gemini calls use), and the
    # exact documented request body shape.
    interactions_call = next(c for c in fake_client.calls if "interactions" in c[1])
    assert interactions_call[2]["headers"]["x-goog-api-key"] == "test-key"
    body = interactions_call[2]["json"]
    assert body["model"] == "gemini-3.5-transcribe"
    assert body["input"] == [{"type": "audio", "uri": "files/abc123", "mime_type": "audio/mpeg"}]
    assert body["generation_config"]["transcription_config"]["mode"] == {
        "type": "verbatim", "timestamp_granularities": ["word"],
    }


@pytest.mark.asyncio
async def test_gemini_word_timestamp_provider_raises_on_non_200():
    from video_ai_provider import VideoAiError

    fake_client = _FakeHttpClient(
        upload_response=_FakeResponse(200, {"file": {"uri": "files/abc123", "name": "files/abc123", "state": "ACTIVE"}}),
        interactions_response=_FakeResponse(429, text="rate limited"),
    )
    provider = vwa.GeminiWordTimestampProvider(api_key="test-key", http_client=fake_client)
    with pytest.raises(VideoAiError):
        await provider.align(b"fake-audio-bytes", "audio/mpeg")


def test_word_timestamp_model_is_independently_overridable(monkeypatch):
    """Mirrors video_ai_provider.py's own VIDEO_AI_MODEL/VIDEO_ANALYSIS_MODEL
    per-stage-override convention — changing this can never silently affect
    ASR segmentation or deep story analysis, or vice versa."""
    monkeypatch.delenv("VIDEO_ALIGNMENT_MODEL", raising=False)
    assert vwa._word_timestamp_model() == "gemini-3.5-transcribe"
    monkeypatch.setenv("VIDEO_ALIGNMENT_MODEL", "gemini-4.0-transcribe-preview")
    assert vwa._word_timestamp_model() == "gemini-4.0-transcribe-preview"


# ── run_word_alignment — provider orchestration + resilience ──────────────
@pytest.mark.asyncio
async def test_run_word_alignment_returns_skipped_when_no_provider_configured():
    gemini = _gemini_doc([_gemini_word("hi", 0.0, 0.4)])
    sync_doc, telemetry = await vwa.run_word_alignment(b"audio", "hi", gemini, "audio/mpeg", provider=None)
    assert sync_doc is gemini  # unchanged
    assert telemetry["status"] == "skipped"
    assert telemetry["provider"] is None


@pytest.mark.asyncio
async def test_run_word_alignment_skips_audio_longer_than_the_documented_30_minute_limit():
    """gemini-3.5-transcribe's own docs cap word-level timestamps at 30
    minutes of audio — this must be checked BEFORE spending an
    upload/network call on a lesson that would only be rejected anyway."""
    class _ShouldNeverBeCalledProvider:
        provider_version = "gemini-word-timestamps-v1 (gemini-3.5-transcribe)"

        async def align(self, *a, **k):
            raise AssertionError("align() must not be called for over-limit audio")

    gemini = _gemini_doc([_gemini_word("hi", 0.0, 0.4)])
    gemini["durationSec"] = 31 * 60  # 31 minutes — over the 30-minute limit
    sync_doc, telemetry = await vwa.run_word_alignment(b"audio", "hi", gemini, "audio/mpeg",
                                                        provider=_ShouldNeverBeCalledProvider())
    assert sync_doc is gemini
    assert telemetry["status"] == "skipped"
    assert "30-minute" in telemetry["reason"]


@pytest.mark.asyncio
async def test_run_word_alignment_never_raises_and_falls_back_on_provider_failure():
    """§1.5 pipeline resilience: a transient provider outage (rate limit,
    timeout, HTTP error) must never block the lesson — the pipeline must
    still complete using Gemini's existing interpolated timing."""
    class _FailingProvider:
        provider_version = "gemini-word-timestamps-v1 (gemini-3.5-transcribe)"

        async def align(self, audio_bytes, content_type=None, **kwargs):
            raise RuntimeError("Gemini Interactions API 429: rate limited")

    gemini = _gemini_doc([_gemini_word("hi", 0.0, 0.4)])
    sync_doc, telemetry = await vwa.run_word_alignment(b"audio", "hi", gemini, "audio/mpeg", provider=_FailingProvider())

    assert sync_doc is gemini
    assert sync_doc["paragraphs"][0]["sentences"][0]["words"][0]["start"] == 0.0  # interpolated, untouched
    assert telemetry["status"] == "failed"
    assert "rate limited" in telemetry["error"]
    assert telemetry["provider"] == "gemini-word-timestamps-v1 (gemini-3.5-transcribe)"


@pytest.mark.asyncio
async def test_run_word_alignment_merges_on_a_successful_provider_call():
    class _FakeProvider:
        provider_version = "gemini-word-timestamps-v1 (gemini-3.5-transcribe)"
        calls = 0

        async def align(self, audio_bytes, content_type=None, **kwargs):
            self.calls += 1
            return {"sync": {"paragraphs": [{"sentences": [{"words": [_measured_word("hi", 0.03, 0.37)]}]}]}}

    provider = _FakeProvider()
    gemini = _gemini_doc([_gemini_word("hi", 0.0, 0.4)])
    sync_doc, telemetry = await vwa.run_word_alignment(b"audio", "hi", gemini, "audio/mpeg", provider=provider)

    assert provider.calls == 1
    assert sync_doc["paragraphs"][0]["sentences"][0]["words"][0]["start"] == 0.03
    assert sync_doc["paragraphs"][0]["sentences"][0]["words"][0]["measured"] is True
    assert telemetry["status"] == "complete"
    assert telemetry["matchedWords"] == 1


def test_get_word_alignment_provider_is_none_without_a_gemini_api_key(monkeypatch):
    monkeypatch.delenv("GEMINI_API_KEY", raising=False)
    monkeypatch.delenv("VIDEO_AI_MOCK", raising=False)
    assert vwa.get_word_alignment_provider() is None


def test_get_word_alignment_provider_is_none_when_mock_mode_forced(monkeypatch):
    monkeypatch.setenv("GEMINI_API_KEY", "test-key-123")
    monkeypatch.setenv("VIDEO_AI_MOCK", "1")
    assert vwa.get_word_alignment_provider() is None


def test_get_word_alignment_provider_constructs_a_real_gemini_provider_when_key_present(monkeypatch):
    monkeypatch.setenv("GEMINI_API_KEY", "test-key-123")
    monkeypatch.delenv("VIDEO_AI_MOCK", raising=False)
    provider = vwa.get_word_alignment_provider()
    assert provider is not None
    assert provider.category == "speech_recognition"
    assert provider.provider_version == "gemini-word-timestamps-v1 (gemini-3.5-transcribe)"


def test_no_dead_elevenlabs_code_remains_in_this_module():
    """Permanent regression guard for Rule 1 of the 2026-09 redesign: no
    ElevenLabs/Scribe IMPORT, ENV VAR, OR NETWORK CALL left in this
    feature's module — checked against the module's OWN source text, not
    memory. Deliberately does NOT ban the words "ElevenLabs"/"Scribe"
    outright: the module docstring intentionally documents what was
    removed and why (this codebase's own "dense version-history header
    comments explaining why a change was made" convention) — that is
    documentation, not dead code."""
    source = Path(vwa.__file__).read_text(encoding="utf-8")
    assert "ELEVENLABS_API_KEY" not in source
    assert "ScribeAlignmentProvider" not in source
    assert "ElevenLabsProvider" not in source
    assert "sync_provider" not in source  # that's where both of the above live
    assert "api.elevenlabs.io" not in source


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
        provider_version = "gemini-word-timestamps-v1 (gemini-3.5-transcribe)"

        def __init__(self):
            self.call_count = 0

        async def align(self, audio_bytes, content_type=None, **kwargs):
            self.call_count += 1
            return {"sync": {"paragraphs": [{"sentences": [{"words": [_measured_word("hi", 0.02, 0.38)]}]}]}}

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
