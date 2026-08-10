"""tests/test_video_pipeline.py
=====================================================
Video Library AI processing pipeline — Gemini-primary provider boundary
(video_ai_provider.py) and the Review Studio edit operations added to
sync_studio_tools.py. Pure-function coverage only (no Mongo, no network) —
same purity discipline as test_sync_foundation.py's schema sections.
"""
from __future__ import annotations

import asyncio

import pytest

import sync_studio_tools as studio
import video_ai_provider as vai
from sync_schema import validate_sync_document


# ═════════════════════════════════════════════════════════════════════════
# timing helpers
# ═════════════════════════════════════════════════════════════════════════
def test_parse_time_accepts_numbers_and_clock_strings():
    assert vai.parse_time_sec(12.4) == 12.4
    assert vai.parse_time_sec("12.4") == 12.4
    assert vai.parse_time_sec("1:05") == 65.0
    assert vai.parse_time_sec("01:02:03.5") == 3723.5
    assert vai.parse_time_sec("garbage") == 0.0
    assert vai.parse_time_sec(-3) == 0.0


def test_distribute_words_spans_exactly_and_orders():
    words = vai.distribute_words("hello there my friend", 10.0, 12.0)
    assert len(words) == 4
    assert words[0]["start"] == 10.0
    assert words[-1]["end"] == 12.0
    for a, b in zip(words, words[1:]):
        assert a["end"] <= b["start"] + 0.001


def test_distribute_words_empty_text():
    assert vai.distribute_words("   ", 0, 5) == []


# ═════════════════════════════════════════════════════════════════════════
# segments → canonical sync document
# ═════════════════════════════════════════════════════════════════════════
def _segments():
    return [
        {"speaker": "S1", "start": 0.0, "end": 4.0, "text": "Hello and welcome."},
        {"speaker": "S1", "start": 4.0, "end": 8.0, "text": "Today we practice ordering."},
        {"speaker": "S2", "start": 8.5, "end": 12.0, "text": "Could I have a coffee?"},
    ]


def test_segments_to_sync_builds_valid_canonical_document():
    doc = vai.segments_to_sync(
        _segments(), provider_category="speech_recognition",
        provider_version="test-v1", generated_at="2026-01-01T00:00:00Z",
    )
    ok, errors = validate_sync_document(doc)
    assert ok, errors
    assert doc["durationSec"] == 12.0
    assert [s["id"] for s in doc["speakers"]] == ["S1", "S2"]


def test_segments_to_sync_paragraph_breaks_on_speaker_change():
    doc = vai.segments_to_sync(
        _segments(), provider_category="speech_recognition",
        provider_version="test-v1", generated_at="2026-01-01T00:00:00Z",
    )
    # S1's two sentences share a paragraph; S2's turn starts a new one.
    assert len(doc["paragraphs"]) == 2
    assert len(doc["paragraphs"][0]["sentences"]) == 2
    assert doc["paragraphs"][1]["sentences"][0]["speakerId"] == "S2"


def test_segments_to_sync_skips_empty_text():
    doc = vai.segments_to_sync(
        [{"speaker": "S1", "start": 0, "end": 1, "text": "  "}],
        provider_category="speech_recognition",
        provider_version="test-v1", generated_at="2026-01-01T00:00:00Z",
    )
    assert doc["paragraphs"][0]["sentences"] == []


def test_segments_to_sync_sorts_out_of_order_segments_chronologically():
    """Root cause of a real karaoke defect: the ASR prompt instructs Gemini
    to return segments 'in chronological order', but that's a request, not
    a guarantee. One segment returned out of order used to leave the
    document's own LAST array entry with an early `end` timestamp, which
    made the frontend's own 'has playback reached the end' check
    (timeSec >= units[last].end) fire almost immediately after playback
    started and never recover — the exact 'karaoke jumps to the end'
    symptom. segments_to_sync must sort by each segment's own reported
    start time regardless of the order Gemini returned them in."""
    out_of_order = [
        {"speaker": "S1", "start": 5.0, "end": 10.0, "text": "This is the real ending."},
        {"speaker": "S1", "start": 0.0, "end": 2.0, "text": "This is the real beginning."},
        {"speaker": "S1", "start": 2.0, "end": 5.0, "text": "This is the real middle."},
    ]
    doc = vai.segments_to_sync(
        out_of_order, provider_category="speech_recognition",
        provider_version="test-v1", generated_at="2026-01-01T00:00:00Z",
    )
    ok, errors = validate_sync_document(doc)
    assert ok, errors

    sentences = doc["paragraphs"][0]["sentences"]
    starts = [s["start"] for s in sentences]
    assert starts == sorted(starts), "sentences must be in real chronological order regardless of provider order"
    # The document's own reported duration (used for "has reached the end"
    # everywhere downstream) must reflect the REAL final segment, not
    # whichever segment Gemini happened to list first/last.
    assert doc["durationSec"] == 10.0
    assert sentences[-1]["end"] == 10.0
    first_word_text = sentences[0]["words"][0]["word"]
    assert first_word_text == "This"  # sanity: sentence[0] really is the t=0 segment
    assert sentences[0]["end"] == 2.0


def test_segments_to_sync_skips_malformed_non_dict_segments_without_crashing():
    """Untrusted provider input must never crash sync-document assembly —
    a malformed entry is silently dropped, never fabricated into a
    timestamp."""
    doc = vai.segments_to_sync(
        [None, "not a dict", {"speaker": "S1", "start": 0, "end": 1, "text": "Real segment."}],
        provider_category="speech_recognition",
        provider_version="test-v1", generated_at="2026-01-01T00:00:00Z",
    )
    ok, errors = validate_sync_document(doc)
    assert ok, errors
    assert len(doc["paragraphs"][0]["sentences"]) == 1


# ═════════════════════════════════════════════════════════════════════════
# mock provider — the offline pipeline path
# ═════════════════════════════════════════════════════════════════════════
def test_mock_provider_aligns_to_valid_document():
    result = asyncio.run(vai.MockVideoProvider().align(b"fake-bytes", "audio/wav"))
    ok, errors = validate_sync_document(result["sync"])
    assert ok, errors
    assert "Welcome" in result["transcriptText"]
    assert result["sync"]["providerVersion"] == "mock-asr-v1"
    assert result["sync"]["speakers"]


def test_provider_selection_falls_back_to_mock_without_key(monkeypatch):
    monkeypatch.delenv("GEMINI_API_KEY", raising=False)
    assert isinstance(vai.get_video_ai_provider(), vai.MockVideoProvider)


def test_provider_selection_uses_gemini_with_key(monkeypatch):
    monkeypatch.setenv("GEMINI_API_KEY", "test-key")
    monkeypatch.delenv("VIDEO_AI_MOCK", raising=False)
    assert isinstance(vai.get_video_ai_provider(), vai.GeminiVideoProvider)


def test_mock_flag_forces_mock_even_with_key(monkeypatch):
    monkeypatch.setenv("GEMINI_API_KEY", "test-key")
    monkeypatch.setenv("VIDEO_AI_MOCK", "1")
    assert isinstance(vai.get_video_ai_provider(), vai.MockVideoProvider)


# ═════════════════════════════════════════════════════════════════════════
# educational analysis normalization
# ═════════════════════════════════════════════════════════════════════════
def test_normalize_learning_bounds_and_validates():
    learning = vai.normalize_learning({
        "cefrLevel": "b1",
        "summary": "x" * 5000,
        "vocabulary": [{"word": "order", "definition": "ask for", "example": "I order tea."},
                       {"notaword": True}],
        "difficultWords": ["one", 2, "three"],
        "conversationType": "CONVERSATION",
        "estimatedStudyMinutes": "12",
        "speakerLabels": {"S1": "Teacher"},
        "extraneous": "dropped",
    })
    assert learning["cefrLevel"] == "B1"
    assert len(learning["summary"]) == 800
    assert learning["vocabulary"] == [
        {"word": "order", "definition": "ask for", "example": "I order tea.", "meaningKm": "", "usageKm": ""},
    ]
    assert learning["conversationType"] == "conversation"
    assert learning["estimatedStudyMinutes"] == 12
    assert learning["speakerLabels"] == {"S1": "Teacher"}
    assert "extraneous" not in learning


def test_normalize_learning_rejects_garbage():
    assert vai.normalize_learning("not json at all") is None
    assert vai.normalize_learning(None) is None


def test_analyze_transcript_mock_path(monkeypatch):
    monkeypatch.delenv("GEMINI_API_KEY", raising=False)
    out = asyncio.run(
        vai.analyze_transcript("Welcome to this English conversation lesson.", title="Test")
    )
    assert out["ok"] and out["engine"] == "mock"
    assert out["learning"]["cefrLevel"] in {"A1", "A2", "B1", "B2", "C1", "C2"}


# ═════════════════════════════════════════════════════════════════════════
# Review Studio edit operations (pure, in-memory document)
# ═════════════════════════════════════════════════════════════════════════
def _doc():
    return vai.segments_to_sync(
        _segments(), provider_category="speech_recognition",
        provider_version="test-v1", generated_at="2026-01-01T00:00:00Z",
    )


def test_edit_word_replaces_text():
    doc = _doc()
    studio._apply_one_edit(doc, {"op": "edit_word", "p": 0, "s": 0, "w": 0, "word": "Hi"})
    assert doc["paragraphs"][0]["sentences"][0]["words"][0]["word"] == "Hi"


def test_edit_word_rejects_bad_reference():
    with pytest.raises(studio.SyncStudioError):
        studio._apply_one_edit(_doc(), {"op": "edit_word", "p": 9, "s": 0, "w": 0, "word": "x"})


def test_split_and_merge_roundtrip_preserves_word_count():
    doc = _doc()
    before = sum(len(s["words"]) for p in doc["paragraphs"] for s in p["sentences"])
    studio._apply_one_edit(doc, {"op": "split_sentence", "p": 0, "s": 0, "at": 2})
    assert len(doc["paragraphs"][0]["sentences"]) == 3
    studio._apply_one_edit(doc, {"op": "merge_sentences", "p": 0, "s": 0})
    after = sum(len(s["words"]) for p in doc["paragraphs"] for s in p["sentences"])
    assert before == after
    assert len(doc["paragraphs"][0]["sentences"]) == 2


def test_set_word_timing_validates_range():
    doc = _doc()
    studio._apply_one_edit(doc, {"op": "set_word_timing", "p": 0, "s": 0, "w": 0, "start": 0.5, "end": 1.0})
    assert doc["paragraphs"][0]["sentences"][0]["words"][0]["start"] == 0.5
    with pytest.raises(studio.SyncStudioError):
        studio._apply_one_edit(doc, {"op": "set_word_timing", "p": 0, "s": 0, "w": 0, "start": 2.0, "end": 1.0})


def test_replace_sentence_text_keeps_sentence_span():
    doc = _doc()
    s = doc["paragraphs"][0]["sentences"][0]
    start, end = s["start"], s["end"]
    studio._apply_one_edit(doc, {"op": "replace_sentence_text", "p": 0, "s": 0, "text": "Completely new words here"})
    s2 = doc["paragraphs"][0]["sentences"][0]
    assert s2["words"][0]["start"] == start
    assert s2["words"][-1]["end"] == end
    assert len(s2["words"]) == 4


def test_rename_speaker_and_set_sentence_speaker():
    doc = _doc()
    studio._apply_one_edit(doc, {"op": "rename_speaker", "id": "S1", "label": "Teacher"})
    assert doc["speakers"][0]["label"] == "Teacher"
    studio._apply_one_edit(doc, {"op": "set_sentence_speaker", "p": 0, "s": 0, "speakerId": "S3"})
    assert doc["paragraphs"][0]["sentences"][0]["speakerId"] == "S3"
    assert any(sp["id"] == "S3" for sp in doc["speakers"])
    with pytest.raises(studio.SyncStudioError):
        studio._apply_one_edit(doc, {"op": "rename_speaker", "id": "ghost", "label": "X"})


def test_unknown_op_rejected():
    with pytest.raises(studio.SyncStudioError):
        studio._apply_one_edit(_doc(), {"op": "explode"})


def test_recompute_bounds_drops_empty_and_rederives():
    doc = _doc()
    doc["paragraphs"][0]["sentences"][0]["words"] = []
    cleaned = studio._recompute_bounds(doc["paragraphs"])
    assert all(s["words"] for p in cleaned for s in p["sentences"])
    for p in cleaned:
        assert p["start"] == p["sentences"][0]["start"]
        assert p["end"] == p["sentences"][-1]["end"]


# ═════════════════════════════════════════════════════════════════════════
# analyze_story (Mode A whole-story analysis) — mock path, real-provider
# malformed-response rejection, and the no-fallback-to-another-AI guarantee.
# ═════════════════════════════════════════════════════════════════════════
class _FakeResponse:
    def __init__(self, status_code=200, payload=None, text=""):
        self.status_code = status_code
        self._payload = payload or {}
        self.text = text

    def json(self):
        return self._payload


def _gemini_envelope(text: str) -> dict:
    return {"candidates": [{"content": {"parts": [{"text": text}]}}]}


class _FakeHttpClient:
    def __init__(self, response: _FakeResponse):
        self._response = response
        self.calls = []

    async def post(self, url, **kwargs):
        self.calls.append((url, kwargs))
        return self._response

    async def get(self, url, **kwargs):
        return self._response


def test_analyze_story_mock_path_when_no_api_key(monkeypatch):
    monkeypatch.delenv("GEMINI_API_KEY", raising=False)
    out = asyncio.run(vai.analyze_story(b"fake-video-bytes", "video/mp4", transcript_text="Hello there."))
    assert out["ok"] and out["engine"] == "mock"
    assert out["storyAnalysis"]["scenes"]
    assert out["storyAnalysis"]["engine"] == "mock"


def test_analyze_story_rejects_empty_media():
    out = asyncio.run(vai.analyze_story(b"", "video/mp4", transcript_text="x"))
    assert out == {"ok": False, "reason": "empty_media"}


def test_analyze_story_real_provider_happy_path(monkeypatch):
    monkeypatch.setenv("GEMINI_API_KEY", "test-key")
    monkeypatch.delenv("VIDEO_AI_MOCK", raising=False)
    raw = {
        "summary": "A short story about a coffee shop.",
        "narrativeArc": "setup -> resolution",
        "characters": [{"name": "Emma", "description": "the customer"}],
        "scenes": [
            {"start": 0, "end": 5, "title": "Greeting", "narrativeRole": "setup",
             "speakers": ["S1"], "characters": ["Emma"]},
        ],
    }
    client = _FakeHttpClient(_FakeResponse(200, _gemini_envelope(__import__("json").dumps(raw))))
    out = asyncio.run(vai.analyze_story(
        b"fake-video-bytes", "video/mp4", transcript_text="Hi there.", http_client=client,
    ))
    assert out["ok"] is True
    assert out["engine"] == "gemini"
    assert out["storyAnalysis"]["summary"] == "A short story about a coffee shop."
    assert len(out["storyAnalysis"]["scenes"]) == 1
    assert client.calls, "should have made a real (fake-injected) HTTP call"


def test_analyze_story_rejects_malformed_gemini_response(monkeypatch):
    monkeypatch.setenv("GEMINI_API_KEY", "test-key")
    monkeypatch.delenv("VIDEO_AI_MOCK", raising=False)
    client = _FakeHttpClient(_FakeResponse(200, _gemini_envelope("not valid json at all")))
    out = asyncio.run(vai.analyze_story(
        b"fake-video-bytes", "video/mp4", transcript_text="x", http_client=client,
    ))
    assert out == {"ok": False, "reason": "bad_response"}


def test_analyze_story_never_falls_back_to_another_provider_on_http_error(monkeypatch):
    """A rejected Gemini call must surface as a failed/waiting state — never
    silently substitute GPT/Emergent/any other AI provider."""
    monkeypatch.setenv("GEMINI_API_KEY", "test-key")
    monkeypatch.delenv("VIDEO_AI_MOCK", raising=False)
    client = _FakeHttpClient(_FakeResponse(500, {}, text="internal error"))
    out = asyncio.run(vai.analyze_story(
        b"fake-video-bytes", "video/mp4", transcript_text="x", http_client=client,
    ))
    assert out["ok"] is False
    assert out["reason"].startswith("provider_rejected")
    assert "internal error" in out["reason"]
    assert "engine" not in out or out.get("engine") != "gpt"


# ═════════════════════════════════════════════════════════════════════════
# draft_script_blueprint (Mode B) — grounded in story analysis, mock path,
# malformed-response rejection, unknown-scene-id rejection.
# ═════════════════════════════════════════════════════════════════════════
def _story_with_two_scenes():
    return {
        "summary": "x", "scenes": [
            {"sceneId": "sc_1", "start": 0, "end": 5, "title": "One", "narrativeRole": "setup",
             "characters": [], "speakers": ["S1"], "confidence": None},
            {"sceneId": "sc_2", "start": 5, "end": 10, "title": "Two", "narrativeRole": "resolution",
             "characters": [], "speakers": ["S1"], "confidence": None},
        ],
    }


def test_draft_script_blueprint_mock_path_covers_every_scene(monkeypatch):
    monkeypatch.delenv("GEMINI_API_KEY", raising=False)
    out = asyncio.run(vai.draft_script_blueprint(_story_with_two_scenes(), transcript_text="hi"))
    assert out["ok"] and out["engine"] == "mock"
    assert [s["sceneId"] for s in out["scriptBlueprint"]["scenes"]] == ["sc_1", "sc_2"]


def test_draft_script_blueprint_rejects_when_no_scenes():
    out = asyncio.run(vai.draft_script_blueprint({"scenes": []}, transcript_text="hi"))
    assert out == {"ok": False, "reason": "no_scenes"}


def test_draft_script_blueprint_real_provider_happy_path(monkeypatch):
    monkeypatch.setenv("GEMINI_API_KEY", "test-key")
    monkeypatch.delenv("VIDEO_AI_MOCK", raising=False)
    raw = {"scenes": [
        {"sceneId": "sc_1", "lines": [{"speaker": "Narrator", "text": "It begins."}]},
        {"sceneId": "sc_2", "lines": [{"speaker": "Emma", "text": "The end."}]},
    ]}
    client = _FakeHttpClient(_FakeResponse(200, _gemini_envelope(__import__("json").dumps(raw))))
    out = asyncio.run(vai.draft_script_blueprint(
        _story_with_two_scenes(), transcript_text="x", http_client=client,
    ))
    assert out["ok"] is True
    assert out["scriptBlueprint"]["scenes"][0]["lines"][0]["text"] == "It begins."
    assert out["scriptBlueprint"]["scenes"][1]["lines"][0]["speaker"] == "Emma"


def test_draft_script_blueprint_drops_lines_for_unknown_scene_id(monkeypatch):
    monkeypatch.setenv("GEMINI_API_KEY", "test-key")
    monkeypatch.delenv("VIDEO_AI_MOCK", raising=False)
    raw = {"scenes": [{"sceneId": "sc_ghost", "lines": [{"speaker": "Narrator", "text": "hi"}]}]}
    client = _FakeHttpClient(_FakeResponse(200, _gemini_envelope(__import__("json").dumps(raw))))
    out = asyncio.run(vai.draft_script_blueprint(
        _story_with_two_scenes(), transcript_text="x", http_client=client,
    ))
    assert out["ok"] is True
    scene_ids = [s["sceneId"] for s in out["scriptBlueprint"]["scenes"]]
    assert scene_ids == ["sc_1", "sc_2"]  # only known scenes, unknown dropped
    assert out["scriptBlueprint"]["scenes"][0]["lines"] == []  # honest empty, nothing fabricated


def test_draft_script_blueprint_rejects_malformed_response(monkeypatch):
    monkeypatch.setenv("GEMINI_API_KEY", "test-key")
    monkeypatch.delenv("VIDEO_AI_MOCK", raising=False)
    client = _FakeHttpClient(_FakeResponse(200, _gemini_envelope("garbage, not json")))
    out = asyncio.run(vai.draft_script_blueprint(
        _story_with_two_scenes(), transcript_text="x", http_client=client,
    ))
    assert out == {"ok": False, "reason": "bad_response"}
