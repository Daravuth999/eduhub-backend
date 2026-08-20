"""tests/test_video_pipeline_sync_timing_ground_truth.py
=====================================================
Regression coverage for the 2026-08 "teleprompter word highlight desync"
investigation.

Root cause (see video_ai_provider.py's distribute_words/segments_to_sync):
word-level timestamps are honest length-weighted interpolation WITHIN each
Gemini-reported sentence span — that part cannot silently compound error
across sentences, since every sentence resets to Gemini's own absolute
start/end. But nothing anywhere in the pipeline cross-checked Gemini's own
self-reported segment timestamps against the media's real, measured
duration — sync_schema.validate_sync_document only checks internal
chronological ORDER, never accuracy. A long-context ASR timestamp that
drifts wrong deeper into a video would previously sail through untouched.

This file proves the fix: video_pipeline_tools.run_pipeline now reuses the
EXISTING ffprobe-based video_render_tools.probe_audio_duration_seconds
(already used elsewhere, for narration timeline duration display — never
before wired into this pipeline) to catch the one case that is unambiguous
evidence of bad timing, not a guess: Gemini's self-reported last-word
timestamp landing AFTER the media's own real, measured length. This is a
diagnostic only — it never fails or blocks the pipeline, and it never
fabricates a corrected timestamp; it leaves an honest note on the
synchronization step for whoever reviews the transcript.

No real Mongo/network — the same in-memory fake DB pattern already
established in test_video_pipeline_watchdog.py / test_video_audio_
extraction_pipeline.py.
"""
from __future__ import annotations

import asyncio

import pytest

import video_ai_provider
import video_pipeline_tools as vpt
import video_render_tools as vrt


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


class _RecordingProvider:
    category = "speech_recognition"
    provider_version = "recording-test-v1"

    async def align(self, media_bytes: bytes, content_type: str = "audio/mpeg") -> dict:
        return {
            "sync": video_ai_provider.segments_to_sync(
                [{"speaker": "S1", "start": 0.0, "end": 1.0, "text": "Hello."}],
                provider_category=self.category, provider_version=self.provider_version,
                generated_at="2026-01-01T00:00:00Z",
            ),
            "transcriptText": "Hello.",
        }


@pytest.fixture(autouse=True)
def _no_real_env(monkeypatch):
    monkeypatch.delenv("GEMINI_API_KEY", raising=False)
    monkeypatch.delenv("VIDEO_AI_MOCK", raising=False)


LESSON = {
    "lessonId": "vid_1", "title": "Ordering Coffee",
    "mediaRef": "gridfs://sync_media/vid_1.mp3", "syncId": "sync_1",
    "contentType": "audio/mpeg",
}


async def _make_audio(*, duration: float = 2.0) -> bytes:
    import os
    import tempfile
    import uuid

    path = os.path.join(tempfile.gettempdir(), f"vpsg_{uuid.uuid4().hex}.mp3")
    args = [
        "ffmpeg", "-y", "-f", "lavfi", "-i", f"sine=frequency=440:duration={duration}", path,
    ]
    loop = asyncio.get_running_loop()
    await loop.run_in_executor(vrt._executor, vrt._run_blocking, tuple(args), 30.0)
    with open(path, "rb") as f:
        data = f.read()
    os.remove(path)
    return data


NO_FFMPEG = not vrt.ffmpeg_available()
NO_FFPROBE = not vrt.ffprobe_available()


def _stub_downstream(monkeypatch, *, reported_duration: float):
    async def _noop(*a, **k):
        return None

    async def _fake_apply_alignment_result(db, sync_id, result_fields):
        return {"durationSec": reported_duration}

    monkeypatch.setattr(vpt.sync_studio_tools, "mark_alignment_processing", _noop)
    monkeypatch.setattr(vpt.sync_studio_tools, "apply_alignment_result", _fake_apply_alignment_result)
    monkeypatch.setattr(vpt.sync_studio_tools, "suggest_speaker_labels", _noop)
    monkeypatch.setattr(vpt.sync_studio_tools, "mark_alignment_failed", _noop)


@pytest.mark.skipif(NO_FFMPEG or NO_FFPROBE, reason="ffmpeg/ffprobe not installed in this environment")
@pytest.mark.asyncio
async def test_a_reported_duration_that_exceeds_the_real_measured_duration_gets_an_honest_note(monkeypatch):
    """The unambiguous case: Gemini's self-reported transcript timing
    claims speech continues well past where the media itself actually
    ends — a logical impossibility, not a guess. This must surface as a
    visible note, never silently pass through."""
    audio_bytes = await _make_audio(duration=2.0)  # real, measured ~2.0s
    _stub_downstream(monkeypatch, reported_duration=45.0)  # wildly exceeds real duration
    db = _FakeDB()
    await db.video_lessons.insert_one(dict(LESSON))
    monkeypatch.setattr(vpt.video_ai_provider, "get_video_ai_provider", lambda: _RecordingProvider())

    pipeline = await vpt.run_pipeline(db, "vid_1", _FakeBucket(audio_bytes, "audio/mpeg"))

    assert pipeline["state"] == "complete"  # diagnostic only — never blocks the run
    note = pipeline["steps"]["synchronization"]["error"]
    assert note is not None
    assert "timing check" in note
    assert "45.0" in note
    assert "not reliable" in note


@pytest.mark.skipif(NO_FFMPEG or NO_FFPROBE, reason="ffmpeg/ffprobe not installed in this environment")
@pytest.mark.asyncio
async def test_a_reported_duration_within_the_real_measured_duration_gets_no_note(monkeypatch):
    """No false positives: a transcript that plausibly ends BEFORE the
    real media duration (the normal case — trailing silence/outro after
    the last spoken word is expected) must never be flagged."""
    audio_bytes = await _make_audio(duration=3.0)  # real, measured ~3.0s
    _stub_downstream(monkeypatch, reported_duration=2.5)  # ends before real duration — normal
    db = _FakeDB()
    await db.video_lessons.insert_one(dict(LESSON))
    monkeypatch.setattr(vpt.video_ai_provider, "get_video_ai_provider", lambda: _RecordingProvider())

    pipeline = await vpt.run_pipeline(db, "vid_1", _FakeBucket(audio_bytes, "audio/mpeg"))

    assert pipeline["state"] == "complete"
    assert pipeline["steps"]["synchronization"]["error"] is None


@pytest.mark.asyncio
async def test_a_probe_failure_is_swallowed_and_never_blocks_or_fails_the_pipeline(monkeypatch):
    """The ground-truth check is best-effort diagnostics layered on top of
    an already-working pipeline — if the probe itself errors (e.g. ffprobe
    unavailable, corrupt bytes), that must never surface as a pipeline
    failure or even a visible error; it just means no note is added."""
    _stub_downstream(monkeypatch, reported_duration=10.0)
    db = _FakeDB()
    await db.video_lessons.insert_one(dict(LESSON))
    monkeypatch.setattr(vpt.video_ai_provider, "get_video_ai_provider", lambda: _RecordingProvider())

    async def _boom(*a, **k):
        raise RuntimeError("simulated ffprobe crash")

    monkeypatch.setattr(vpt.video_render_tools, "probe_audio_duration_seconds", _boom)

    pipeline = await vpt.run_pipeline(db, "vid_1", _FakeBucket(b"fake-audio-bytes", "audio/mpeg"))

    assert pipeline["state"] == "complete"
    assert pipeline["steps"]["synchronization"]["status"] == "complete"
    assert pipeline["steps"]["synchronization"]["error"] is None


@pytest.mark.asyncio
async def test_a_none_probe_result_never_produces_a_note(monkeypatch):
    """probe_audio_duration_seconds's own documented contract: None means
    "could not determine", never "zero" — must not be treated as if the
    media were confirmed to be zero-length (which would falsely flag
    every real lesson as exceeding it)."""
    _stub_downstream(monkeypatch, reported_duration=10.0)
    db = _FakeDB()
    await db.video_lessons.insert_one(dict(LESSON))
    monkeypatch.setattr(vpt.video_ai_provider, "get_video_ai_provider", lambda: _RecordingProvider())

    async def _unavailable(*a, **k):
        return None

    monkeypatch.setattr(vpt.video_render_tools, "probe_audio_duration_seconds", _unavailable)

    pipeline = await vpt.run_pipeline(db, "vid_1", _FakeBucket(b"fake-audio-bytes", "audio/mpeg"))

    assert pipeline["state"] == "complete"
    assert pipeline["steps"]["synchronization"]["error"] is None
