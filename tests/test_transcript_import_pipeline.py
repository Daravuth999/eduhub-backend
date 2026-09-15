"""tests/test_transcript_import_pipeline.py
==============================================
Manual transcript import — the pipeline-orchestration half (§1.1/§1.2/§4).
Proves: (1) run_pipeline's imported_transcript fork bypasses ONLY Gemini
speech recognition + word-alignment, never calling the provider at all;
(2) every other stage (media_check, audio_extraction's own honest
"skipped" step, synchronization, educational_analysis, review_ready)
still runs, reusing the SAME code the Gemini path uses; (3) words
produced from an import are honestly interpolated, never `measured`;
(4) the existing Gemini auto-generate path (imported_transcript=None,
the default) is completely unaffected — the highest-scrutiny regression
proof for this whole feature.

Same in-memory fake-Mongo pattern as test_video_audio_extraction_
pipeline.py (per-file-duplicated, not shared, per this repo's own
convention).
"""
from __future__ import annotations

import pytest

import video_ai_provider
import video_pipeline_tools as vpt


def _get_dotted(doc, path):
    cur = doc
    for part in path.split("."):
        if not isinstance(cur, dict):
            return None
        cur = cur.get(part)
    return cur


def _match(doc, query):
    for k, v in query.items():
        if k == "$or":
            if not any(_match(doc, sub) for sub in v):
                return False
            continue
        if isinstance(v, dict) and "$ne" in v:
            if _get_dotted(doc, k) == v["$ne"]:
                return False
            continue
        if isinstance(v, dict) and "$lt" in v:
            actual = _get_dotted(doc, k)
            if actual is None or not (actual < v["$lt"]):
                return False
            continue
        if isinstance(v, dict) and "$in" in v:
            if _get_dotted(doc, k) not in v["$in"]:
                return False
            continue
        if _get_dotted(doc, k) != v:
            return False
    return True


def _set_dotted(doc, path, value):
    parts = path.split(".")
    cur = doc
    for part in parts[:-1]:
        cur = cur.setdefault(part, {})
    cur[parts[-1]] = value


class _Coll:
    def __init__(self):
        self.docs: dict = {}

    async def insert_one(self, doc):
        self.docs[doc["lessonId"]] = dict(doc)

    async def find_one(self, query, projection=None):
        for doc in self.docs.values():
            if _match(doc, query):
                out = dict(doc)
                if projection and projection.get("_id") == 0:
                    out.pop("_id", None)
                return out
        return None

    async def update_one(self, query, update):
        for doc in self.docs.values():
            if _match(doc, query):
                if "$set" in update:
                    for k, v in update["$set"].items():
                        _set_dotted(doc, k, v)
                if "$push" in update:
                    for k, v in update["$push"].items():
                        each = v.get("$each", [v]) if isinstance(v, dict) else [v]
                        cur = doc.setdefault(k, [])
                        cur.extend(each)
                        if isinstance(v, dict) and "$slice" in v:
                            n = v["$slice"]
                            doc[k] = cur[n:] if n < 0 else cur[:n]
                return
        return None

    async def find_one_and_update(self, query, update):
        for doc in self.docs.values():
            if _match(doc, query):
                if "$set" in update:
                    for k, v in update["$set"].items():
                        _set_dotted(doc, k, v)
                return dict(doc)
        return None


class _FakeDB:
    def __init__(self):
        self.video_lessons = _Coll()

    def __getitem__(self, name):
        assert name == vpt.LESSONS_COLL
        return self.video_lessons


class _FakeBucket:
    class _GridOut:
        def __init__(self, data: bytes, content_type: str):
            self._data = data
            self.metadata = {"contentType": content_type}

        async def read(self):
            return self._data

    def __init__(self, data: bytes, content_type: str):
        self._data = data
        self._content_type = content_type

    async def open_download_stream_by_name(self, filename):
        return self._GridOut(self._data, self._content_type)


class _RefusingProvider:
    """A provider that FAILS the test if it's ever called at all — the
    real assertion surface for "Gemini speech recognition is genuinely
    bypassed for an import", not just "happens not to be reached"."""
    category = "speech_recognition"
    provider_version = "should-never-be-called-v1"

    async def align(self, media_bytes, content_type="audio/mpeg"):
        raise AssertionError("provider.align() was called — the import path must never call Gemini ASR")


@pytest.fixture(autouse=True)
def _no_real_env(monkeypatch):
    monkeypatch.delenv("GEMINI_API_KEY", raising=False)
    monkeypatch.delenv("VIDEO_AI_MOCK", raising=False)


LESSON = {
    "lessonId": "vid_1", "title": "Pchum Ben Ceremony",
    "mediaRef": "gridfs://sync_media/vid_1.mp4", "syncId": "sync_1",
    "contentType": "video/mp4",
}

SRT_CONTENT = (
    "1\n00:00:00,000 --> 00:00:02,500\n"
    "Before the sun rises, the village is still quiet.\n\n"
    "2\n00:00:02,500 --> 00:00:05,200\n"
    "Today is Pchum Ben.\n"
)


def _stub_apply_alignment_result(monkeypatch, sink: list):
    async def _fake_apply(db_, sync_id, aligned):
        sink.append(aligned)
        return {"durationSec": aligned.get("durationSec", 0.0)}

    async def _noop(*a, **k):
        return None

    monkeypatch.setattr(vpt.sync_studio_tools, "mark_alignment_processing", _noop)
    monkeypatch.setattr(vpt.sync_studio_tools, "apply_alignment_result", _fake_apply)
    monkeypatch.setattr(vpt.sync_studio_tools, "suggest_speaker_labels", _noop)
    monkeypatch.setattr(vpt.sync_studio_tools, "mark_alignment_failed", _noop)


@pytest.mark.asyncio
async def test_imported_transcript_never_calls_the_gemini_provider(monkeypatch):
    applied = []
    _stub_apply_alignment_result(monkeypatch, applied)
    db = _FakeDB()
    await db.video_lessons.insert_one(dict(LESSON))
    monkeypatch.setattr(vpt.video_ai_provider, "get_video_ai_provider", lambda: _RefusingProvider())
    from transcript_import import parse_srt
    segments = parse_srt(SRT_CONTENT)

    pipeline = await vpt.run_pipeline(
        db, "vid_1", _FakeBucket(b"fake-video-bytes", "video/mp4"),
        imported_transcript={"format": "srt", "segments": segments},
    )

    assert pipeline["state"] == "complete"
    assert len(applied) == 1  # would raise AssertionError above if the provider were ever called


@pytest.mark.asyncio
async def test_imported_transcript_marks_audio_extraction_and_speech_recognition_honestly(monkeypatch):
    applied = []
    _stub_apply_alignment_result(monkeypatch, applied)
    db = _FakeDB()
    await db.video_lessons.insert_one(dict(LESSON))
    monkeypatch.setattr(vpt.video_ai_provider, "get_video_ai_provider", lambda: _RefusingProvider())
    from transcript_import import parse_srt
    segments = parse_srt(SRT_CONTENT)

    pipeline = await vpt.run_pipeline(
        db, "vid_1", _FakeBucket(b"fake-video-bytes", "video/mp4"),
        imported_transcript={"format": "srt", "segments": segments},
    )

    assert pipeline["steps"]["audio_extraction"]["status"] == "skipped"
    assert "transcript imported" in pipeline["steps"]["audio_extraction"]["error"]
    assert pipeline["steps"]["speech_recognition"]["status"] == "complete"
    assert "imported" in pipeline["steps"]["speech_recognition"]["error"]
    assert pipeline["steps"]["synchronization"]["status"] == "complete"
    assert pipeline["steps"]["review_ready"]["status"] == "complete"


@pytest.mark.asyncio
async def test_imported_words_are_honestly_interpolated_never_measured(monkeypatch):
    applied = []
    _stub_apply_alignment_result(monkeypatch, applied)
    db = _FakeDB()
    await db.video_lessons.insert_one(dict(LESSON))
    monkeypatch.setattr(vpt.video_ai_provider, "get_video_ai_provider", lambda: _RefusingProvider())
    from transcript_import import parse_srt
    segments = parse_srt(SRT_CONTENT)

    await vpt.run_pipeline(
        db, "vid_1", _FakeBucket(b"fake-video-bytes", "video/mp4"),
        imported_transcript={"format": "srt", "segments": segments},
    )

    assert len(applied) == 1
    all_words = [w for p in applied[0]["paragraphs"] for s in p["sentences"] for w in s["words"]]
    assert len(all_words) > 0
    for w in all_words:
        assert w.get("measured") is not True
    assert applied[0]["providerVersion"] == "manual-import-srt"
    assert applied[0]["providerCategory"] == "manual"


@pytest.mark.asyncio
async def test_educational_analysis_still_runs_for_an_imported_transcript_only_asr_is_bypassed(monkeypatch):
    """§0 Rule 4 — the core scope boundary: ONLY Gemini speech recognition
    and word-alignment are bypassed. Educational analysis is a SEPARATE
    Gemini call on the resulting transcript text and must still run."""
    applied = []
    _stub_apply_alignment_result(monkeypatch, applied)
    db = _FakeDB()
    await db.video_lessons.insert_one(dict(LESSON))
    monkeypatch.setattr(vpt.video_ai_provider, "get_video_ai_provider", lambda: _RefusingProvider())

    analysis_calls = []

    async def _fake_analyze_transcript(transcript_text, *, sentences=None, title=""):
        analysis_calls.append(transcript_text)
        return {"ok": False, "reason": "test stub — not exercising real analysis"}

    monkeypatch.setattr(vpt.video_ai_provider, "analyze_transcript", _fake_analyze_transcript)
    from transcript_import import parse_srt
    segments = parse_srt(SRT_CONTENT)

    pipeline = await vpt.run_pipeline(
        db, "vid_1", _FakeBucket(b"fake-video-bytes", "video/mp4"),
        imported_transcript={"format": "srt", "segments": segments},
    )

    assert len(analysis_calls) == 1  # educational analysis WAS attempted
    assert "Pchum Ben" in analysis_calls[0]  # on the real imported transcript text
    assert pipeline["steps"]["educational_analysis"]["status"] == "failed"  # honest stub outcome, not silently skipped


@pytest.mark.asyncio
async def test_default_gemini_path_is_completely_unaffected_by_the_new_parameter(monkeypatch):
    """§1.2 highest-scrutiny regression proof: imported_transcript=None
    (the default, used by every existing caller) must behave exactly as
    it did before this parameter existed — the real Gemini provider IS
    called."""
    applied = []
    _stub_apply_alignment_result(monkeypatch, applied)
    db = _FakeDB()
    await db.video_lessons.insert_one(dict(LESSON))

    calls = []

    class _RecordingProvider:
        category = "speech_recognition"
        provider_version = "recording-v1"

        async def align(self, media_bytes, content_type="audio/mpeg"):
            calls.append((media_bytes, content_type))
            return {
                "sync": video_ai_provider.segments_to_sync(
                    [{"speaker": "S1", "start": 0.0, "end": 1.0, "text": "Hello."}],
                    provider_category="speech_recognition", provider_version="recording-v1",
                    generated_at="2026-01-01T00:00:00Z",
                ),
                "transcriptText": "Hello.",
            }

    monkeypatch.setattr(vpt.video_ai_provider, "get_video_ai_provider", lambda: _RecordingProvider())

    async def _unknown(*a, **k):
        return "unknown"  # ambiguous probe — must still attempt real ASR, same as before

    monkeypatch.setattr(vpt.video_render_tools, "probe_audio_stream_status", _unknown)

    # No imported_transcript argument at all — the exact call shape every
    # existing caller (schedule_pipeline with no keyword, the /pipeline/run
    # route) already uses.
    pipeline = await vpt.run_pipeline(db, "vid_1", _FakeBucket(b"fake-video-bytes", "video/mp4"))

    assert pipeline["state"] == "complete"
    assert len(calls) == 1  # the real Gemini provider WAS called — default path unchanged
    assert applied[0]["providerVersion"] == "recording-v1"  # NOT a manual-import tag
