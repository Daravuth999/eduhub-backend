"""tests/test_transcript_import_upload_route.py
==================================================
§1.2 — the ONE edit in the whole manual-transcript-import feature that
touches every existing upload, so it gets the highest scrutiny: proving
`upload_lesson_media_route`'s new `awaitTranscriptChoice` form field is
purely additive. Route-level TestClient tests, mirroring test_video_
narration_routes.py's established FastAPI TestClient + fake-admin-
dependency pattern.
"""
from __future__ import annotations

import io

import pytest
from fastapi import APIRouter, FastAPI
from fastapi.testclient import TestClient

import video_library_tools as vlt


async def _admin_dep():
    return type("Admin", (), {"email": "admin@test"})()


async def _student_dep():
    return type("Student", (), {"studentId": "stu_1"})()


def _make_client(monkeypatch, *, attached_doc=None):
    scheduled_calls = []
    attach_calls = []

    async def _fake_attach_lesson_media(db, lesson_id, *, raw, declared_content_type, media_bucket, uploaded_by=""):
        attach_calls.append({"lesson_id": lesson_id, "raw_len": len(raw), "content_type": declared_content_type})
        return dict(attached_doc or {"lessonId": lesson_id, "syncId": "sync_1", "mediaRef": "gridfs://x/y.mp4"})

    def _fake_schedule_pipeline(db, lesson_id, media_bucket, *, imported_transcript=None):
        scheduled_calls.append({"lesson_id": lesson_id, "imported_transcript": imported_transcript})

    monkeypatch.setattr(vlt, "attach_lesson_media", _fake_attach_lesson_media)
    monkeypatch.setattr(vlt.sync_studio_tools, "get_media_bucket", lambda db: object())

    # The route does `import video_pipeline_tools as _pipeline` lazily
    # inside its own body — patching the real module's attribute is what
    # that lazy import will see at call time regardless.
    import video_pipeline_tools as vpt
    monkeypatch.setattr(vpt, "schedule_pipeline", _fake_schedule_pipeline)

    class _FakeLessonsColl:
        async def update_one(self, query, update):
            return None

    class _FakeDB:
        def __getitem__(self, name):
            return _FakeLessonsColl()

    app = FastAPI()
    api = APIRouter(prefix="/api")
    vlt.register_video_library_routes(api, _FakeDB(), _admin_dep, _student_dep)
    app.include_router(api)
    return TestClient(app), scheduled_calls, attach_calls


def test_default_upload_still_auto_schedules_exactly_as_before_this_feature_existed(monkeypatch):
    """§1.2 highest-scrutiny regression proof: a caller that doesn't know
    `awaitTranscriptChoice` exists (every existing admin client) must get
    byte-for-byte the same behavior as before — media lands, the Gemini
    pipeline starts immediately, full stop."""
    client, scheduled_calls, attach_calls = _make_client(monkeypatch)

    r = client.post(
        "/api/studio/video/lessons/vid_1/media",
        files={"file": ("lesson.mp4", io.BytesIO(b"fake-video-bytes"), "video/mp4")},
    )

    assert r.status_code == 200
    body = r.json()
    assert body["ok"] is True
    assert body["pipelineScheduled"] is True
    assert len(attach_calls) == 1
    assert len(scheduled_calls) == 1
    assert scheduled_calls[0]["imported_transcript"] is None


def test_awaiting_transcript_choice_uploads_media_but_does_not_schedule_the_pipeline(monkeypatch):
    client, scheduled_calls, attach_calls = _make_client(monkeypatch)

    r = client.post(
        "/api/studio/video/lessons/vid_1/media",
        files={"file": ("lesson.mp4", io.BytesIO(b"fake-video-bytes"), "video/mp4")},
        data={"awaitTranscriptChoice": "true"},
    )

    assert r.status_code == 200
    body = r.json()
    assert body["ok"] is True
    assert body["pipelineScheduled"] is False
    assert len(attach_calls) == 1  # media itself is still uploaded/stored
    assert len(scheduled_calls) == 0  # but no pipeline run was scheduled


def test_awaiting_transcript_choice_false_explicitly_behaves_identically_to_the_default(monkeypatch):
    client, scheduled_calls, _ = _make_client(monkeypatch)

    r = client.post(
        "/api/studio/video/lessons/vid_1/media",
        files={"file": ("lesson.mp4", io.BytesIO(b"fake-video-bytes"), "video/mp4")},
        data={"awaitTranscriptChoice": "false"},
    )

    assert r.status_code == 200
    assert r.json()["pipelineScheduled"] is True
    assert len(scheduled_calls) == 1
