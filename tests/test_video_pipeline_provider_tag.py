"""tests/test_video_pipeline_provider_tag.py
=================================================
Real, previously-confirmed bug, already caused one misdiagnosis:
pipeline.provider (and the pipeline's own log lines) only ever showed
the segmentation stage's static version string — set once at pipeline
CLAIM time, before the real per-word alignment call
(video_word_alignment.py, gemini-3.5-transcribe) had even run — and was
NEVER updated afterward, for the rest of that run's lifetime, to
reflect whether alignment actually ran, was skipped, or failed.

Live verification during this investigation (real Gemini API, real
synthesized speech audio, not mocked): both the segmentation call
(gemini-2.5-flash) and the real alignment call (gemini-3.5-transcribe)
genuinely fired and BOTH contributed real data to the final document —
21/24 words got real measured timing from the second call. The bug was
confirmed to be the misleading tag ONLY, not a pipeline regression.

This file covers the fix: build_combined_provider_tag (pure function,
mirrors SyncReviewStudio.jsx's formatProviderTag exactly) and the
pipeline actually persisting the combined tag to pipeline.provider
after the alignment stage's real outcome is known — not just at claim
time.
"""
from __future__ import annotations

import asyncio

import pytest

import video_pipeline_tools as vpt


def run(c):
    return asyncio.run(c)


# ── build_combined_provider_tag — pure function ──────────────────────────────
SEG = "gemini-video-asr-v1 (gemini-2.5-flash, word-interp)"


def test_no_word_alignment_yet_reports_segmentation_only_honestly():
    """Before the alignment stage has run at all (e.g. the value written
    at pipeline claim time) — never a guess about a stage that hasn't
    happened yet."""
    assert vpt.build_combined_provider_tag(SEG, None) == SEG


def test_both_stages_complete_shows_both_models_and_real_measured_count():
    wa = {
        "status": "complete", "provider": "gemini-word-timestamps-v1 (gemini-3.5-transcribe)",
        "totalWords": 24, "matchedWords": 21,
    }
    tag = vpt.build_combined_provider_tag(SEG, wa)
    assert SEG in tag
    assert "gemini-word-timestamps-v1 (gemini-3.5-transcribe)" in tag
    assert "21/24 words measured" in tag


def test_alignment_skipped_reports_the_real_reason_not_a_generic_message():
    wa = {"status": "skipped", "reason": "GEMINI_API_KEY not configured (or mock mode forced) — real alignment unavailable this run"}
    tag = vpt.build_combined_provider_tag(SEG, wa)
    assert SEG in tag
    assert "alignment skipped" in tag
    assert "GEMINI_API_KEY not configured" in tag


def test_alignment_failed_is_honest_about_falling_back_to_interpolated_timing():
    wa = {"status": "failed", "error": "HTTPStatusError: 503"}
    tag = vpt.build_combined_provider_tag(SEG, wa)
    assert SEG in tag
    assert "alignment failed" in tag
    assert "interpolated" in tag


def test_regression_a_complete_status_with_zero_total_words_never_divides_by_zero_or_crashes():
    wa = {"status": "complete", "provider": "gemini-word-timestamps-v1 (gemini-3.5-transcribe)", "totalWords": 0, "matchedWords": 0}
    tag = vpt.build_combined_provider_tag(SEG, wa)
    assert SEG in tag  # never raises


# ── real pipeline execution — pipeline.provider actually gets updated ───────
def _get_path(doc: dict, dotted_key: str):
    """Real MongoDB resolves a dotted query/update key by walking nested
    dicts (e.g. "pipeline.runId" reads doc["pipeline"]["runId"]) — this
    fake must do the same, since the real production code (this exact
    module's own _set_step/_finish, and this fix's new pipeline.provider
    update) queries and writes dotted paths throughout."""
    node = doc
    for part in dotted_key.split("."):
        if not isinstance(node, dict) or part not in node:
            return None
        node = node[part]
    return node


def _set_path(doc: dict, dotted_key: str, value) -> None:
    parts = dotted_key.split(".")
    node = doc
    for part in parts[:-1]:
        node = node.setdefault(part, {})
    node[parts[-1]] = value


def _matches(doc: dict, query: dict) -> bool:
    return all(_get_path(doc, k) == v for k, v in query.items() if not isinstance(v, dict))


class _Coll:
    def __init__(self):
        self.docs = {}

    async def insert_one(self, doc):
        self.docs[doc["lessonId"]] = dict(doc)

    async def find_one(self, query, projection=None):
        for doc in self.docs.values():
            if _matches(doc, query):
                return dict(doc)
        return None

    async def update_one(self, query, update):
        for doc in self.docs.values():
            if _matches(doc, query):
                if "$set" in update:
                    for k, v in update["$set"].items():
                        _set_path(doc, k, v)
                return
        return None

    async def find_one_and_update(self, query, update):
        for doc in self.docs.values():
            if _matches(doc, query):
                before = dict(doc)
                if "$set" in update:
                    for k, v in update["$set"].items():
                        _set_path(doc, k, v)
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


def _measured_word(word, start, end):
    return {"word": word, "start": start, "end": end}


async def _run_real_pipeline(monkeypatch, *, alignment_provider):
    """Drives an ACTUAL video_pipeline_tools.run_pipeline() call — same
    harness shape as test_video_word_alignment.py's own real-execution
    test — and returns the final persisted lesson document so the
    caller can inspect pipeline.provider's real, post-run value."""
    import video_word_alignment as vwa

    monkeypatch.setattr(vpt, "PIPELINE_TIMEOUT_S", 5.0)
    monkeypatch.setattr(vpt, "MEDIA_FETCH_TIMEOUT_S", 5.0)
    monkeypatch.delenv("GEMINI_API_KEY", raising=False)
    monkeypatch.setenv("VIDEO_AI_MOCK", "1")
    monkeypatch.setattr(vwa, "get_word_alignment_provider", lambda: alignment_provider)
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
    return db.video_lessons.docs["vid_1"]


async def _async_none():
    return None


@pytest.mark.asyncio
async def test_regression_pipeline_provider_is_updated_after_a_real_run_to_show_both_stages(monkeypatch):
    """THE regression this fix targets: before this change,
    pipeline.provider stayed frozen at whatever build_pipeline_record
    wrote at claim time (segmentation-only) for the entire run,
    including after this exact successful alignment call completed."""
    class _WorkingAlignmentProvider:
        provider_version = "gemini-word-timestamps-v1 (gemini-3.5-transcribe)"

        async def align(self, audio_bytes, content_type=None, **kwargs):
            return {"sync": {"paragraphs": [{"sentences": [{"words": [_measured_word("hi", 0.02, 0.38)]}]}]}}

    doc = await _run_real_pipeline(monkeypatch, alignment_provider=_WorkingAlignmentProvider())
    final_provider = doc["pipeline"]["provider"]
    assert "gemini-word-timestamps-v1 (gemini-3.5-transcribe)" in final_provider, (
        f"expected the completed alignment stage to appear in pipeline.provider, got: {final_provider!r}"
    )


@pytest.mark.asyncio
async def test_pipeline_provider_honestly_shows_skipped_when_no_alignment_provider_is_configured(monkeypatch):
    doc = await _run_real_pipeline(monkeypatch, alignment_provider=None)
    final_provider = doc["pipeline"]["provider"]
    assert "alignment skipped" in final_provider
