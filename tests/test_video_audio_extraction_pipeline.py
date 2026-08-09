"""tests/test_video_audio_extraction_pipeline.py
=====================================================
Regression coverage for a real production incident: a ~3-minute/130MB
Video Library upload stuck indefinitely at "AI Processing -> Speech
Recognition -> running". Root-cause investigation (video_pipeline_tools.py
/ video_ai_provider.py) found the pipeline was sending the ENTIRE video to
Gemini's Files API for every video-typed lesson, regardless of length —
by far the slowest available path (large raw upload, then server-side
video processing, before transcription can even start) for a capability
(speech recognition) that never needed the video frames in the first
place.

This file proves the fix: video_pipeline_tools.run_pipeline now extracts
just the audio track (video_render_tools.extract_audio_track, real
ffmpeg) before calling the speech-recognition provider, honestly falls
back to the original media when extraction isn't available/fails (never
blocking the pipeline), and leaves audio-only media untouched.

No real Mongo/network — the same in-memory fake DB pattern already
established in test_video_pipeline_watchdog.py.
"""
from __future__ import annotations

import asyncio

import pytest

import video_ai_provider
import video_pipeline_tools as vpt
import video_render_tools as vrt


# ── in-memory Mongo fake — same minimal pattern as test_video_pipeline_watchdog.py
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


class _RecordingProvider:
    """Records exactly what bytes/content-type it was asked to transcribe
    — the real assertion surface for "was the whole video sent, or just
    the extracted audio?"."""
    category = "speech_recognition"
    provider_version = "recording-test-v1"

    def __init__(self):
        self.calls: list[tuple[bytes, str]] = []

    async def align(self, media_bytes: bytes, content_type: str = "audio/mpeg") -> dict:
        self.calls.append((media_bytes, content_type))
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


def _stub_downstream(monkeypatch):
    """Everything AFTER speech recognition is covered by its own test
    files — stubbed here so this file stays focused on the audio-
    extraction wiring specifically."""
    async def _noop(*a, **k):
        return None

    async def _fake_apply_alignment_result(db, sync_id, result_fields):
        return {"durationSec": result_fields.get("durationSec", 1.0) if isinstance(result_fields, dict) else 1.0}

    monkeypatch.setattr(vpt.sync_studio_tools, "mark_alignment_processing", _noop)
    monkeypatch.setattr(vpt.sync_studio_tools, "apply_alignment_result", _fake_apply_alignment_result)
    monkeypatch.setattr(vpt.sync_studio_tools, "suggest_speaker_labels", _noop)
    monkeypatch.setattr(vpt.sync_studio_tools, "mark_alignment_failed", _noop)


LESSON = {
    "lessonId": "vid_1", "title": "Ordering Coffee",
    "mediaRef": "gridfs://sync_media/vid_1.mp4", "syncId": "sync_1",
    "contentType": "video/mp4",
}


async def _make_video_with_audio(*, duration: float = 2.0) -> bytes:
    """A real, ffmpeg-generated video WITH its own audio track — large
    relative to its duration (uncompressed-ish color frames), so the
    extracted-audio-only comparison is meaningful, not noise."""
    import os
    import tempfile
    import uuid

    path = os.path.join(tempfile.gettempdir(), f"vae_{uuid.uuid4().hex}.mp4")
    args = [
        "ffmpeg", "-y",
        "-f", "lavfi", "-i", f"color=c=blue:s=320x240:d={duration}",
        "-f", "lavfi", "-i", f"sine=frequency=440:duration={duration}",
        "-c:v", "libx264", "-pix_fmt", "yuv420p", "-c:a", "aac", "-shortest", path,
    ]
    loop = asyncio.get_running_loop()
    await loop.run_in_executor(vrt._executor, vrt._run_blocking, tuple(args), 30.0)
    with open(path, "rb") as f:
        data = f.read()
    os.remove(path)
    return data


NO_FFMPEG = not vrt.ffmpeg_available()
NO_FFPROBE = not vrt.ffprobe_available()


def test_audio_extraction_step_exists_between_media_check_and_speech_recognition():
    assert "audio_extraction" in vpt.PIPELINE_STEPS
    assert vpt.PIPELINE_STEPS.index("audio_extraction") == vpt.PIPELINE_STEPS.index("media_check") + 1
    assert vpt.PIPELINE_STEPS.index("speech_recognition") == vpt.PIPELINE_STEPS.index("audio_extraction") + 1


@pytest.mark.skipif(NO_FFMPEG or NO_FFPROBE, reason="ffmpeg/ffprobe not installed in this environment")
@pytest.mark.asyncio
async def test_video_lesson_sends_extracted_smaller_audio_to_the_provider(monkeypatch):
    _stub_downstream(monkeypatch)
    video_bytes = await _make_video_with_audio(duration=3.0)
    db = _FakeDB()
    await db.video_lessons.insert_one(dict(LESSON))
    provider = _RecordingProvider()
    monkeypatch.setattr(vpt.video_ai_provider, "get_video_ai_provider", lambda: provider)

    pipeline = await vpt.run_pipeline(db, "vid_1", _FakeBucket(video_bytes, "video/mp4"))

    assert pipeline["state"] == "complete"
    assert pipeline["steps"]["audio_extraction"]["status"] == "complete"
    assert len(provider.calls) == 1
    sent_bytes, sent_ct = provider.calls[0]
    assert sent_ct == "audio/mpeg"
    assert len(sent_bytes) < len(video_bytes)  # genuinely smaller — audio only, not the whole video
    assert await vrt.probe_audio_duration_seconds(sent_bytes) == pytest.approx(3.0, abs=0.3)


@pytest.mark.asyncio
async def test_audio_only_lesson_skips_extraction_and_sends_original_bytes(monkeypatch):
    _stub_downstream(monkeypatch)
    db = _FakeDB()
    lesson = {**LESSON, "contentType": "audio/mpeg", "mediaRef": "gridfs://sync_media/vid_1.mp3"}
    await db.video_lessons.insert_one(lesson)
    provider = _RecordingProvider()
    monkeypatch.setattr(vpt.video_ai_provider, "get_video_ai_provider", lambda: provider)
    extraction_calls = []

    async def _spy(*a, **k):
        extraction_calls.append(1)
        return None

    monkeypatch.setattr(vpt.video_render_tools, "extract_audio_track", _spy)

    pipeline = await vpt.run_pipeline(db, "vid_1", _FakeBucket(b"fake-audio-bytes", "audio/mpeg"))

    assert pipeline["state"] == "complete"
    assert pipeline["steps"]["audio_extraction"]["status"] == "complete"
    assert pipeline["steps"]["audio_extraction"]["error"] == "media is already audio-only"
    assert extraction_calls == []  # never even attempted for already-audio media
    assert provider.calls[0] == (b"fake-audio-bytes", "audio/mpeg")


@pytest.mark.asyncio
async def test_extraction_failure_falls_back_to_original_video_without_blocking_pipeline(monkeypatch):
    _stub_downstream(monkeypatch)
    db = _FakeDB()
    await db.video_lessons.insert_one(dict(LESSON))
    provider = _RecordingProvider()
    monkeypatch.setattr(vpt.video_ai_provider, "get_video_ai_provider", lambda: provider)

    async def _extraction_unavailable(*a, **k):
        return None  # the real, honest "ffmpeg unavailable or failed" outcome

    monkeypatch.setattr(vpt.video_render_tools, "extract_audio_track", _extraction_unavailable)

    pipeline = await vpt.run_pipeline(db, "vid_1", _FakeBucket(b"fake-video-bytes", "video/mp4"))

    assert pipeline["state"] == "complete"  # extraction failure never blocks the pipeline
    assert pipeline["steps"]["audio_extraction"]["status"] == "complete"
    assert "unavailable or failed" in pipeline["steps"]["audio_extraction"]["error"]
    assert provider.calls[0] == (b"fake-video-bytes", "video/mp4")  # honest fallback to the original


@pytest.mark.asyncio
async def test_extraction_exception_is_caught_and_falls_back_honestly(monkeypatch):
    """A real ffmpeg crash (not just "unavailable") must degrade the same
    way — audio extraction is an optimization, never a hard dependency."""
    _stub_downstream(monkeypatch)
    db = _FakeDB()
    await db.video_lessons.insert_one(dict(LESSON))
    provider = _RecordingProvider()
    monkeypatch.setattr(vpt.video_ai_provider, "get_video_ai_provider", lambda: provider)

    async def _boom(*a, **k):
        raise RuntimeError("simulated ffmpeg crash")

    monkeypatch.setattr(vpt.video_render_tools, "extract_audio_track", _boom)

    pipeline = await vpt.run_pipeline(db, "vid_1", _FakeBucket(b"fake-video-bytes", "video/mp4"))

    assert pipeline["state"] == "complete"
    assert provider.calls[0] == (b"fake-video-bytes", "video/mp4")
