"""tests/test_transcript_import_route.py
============================================
Route-level tests for POST .../pipeline/import-transcript — mirroring
test_video_pipeline_watchdog.py's established FastAPI TestClient +
fake-admin pattern for video_pipeline_tools' own registered routes.
"""
from __future__ import annotations

import asyncio

import pytest
from fastapi import APIRouter, FastAPI
from fastapi.testclient import TestClient

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
        if _get_dotted(doc, k) != v:
            return False
    return True


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


class _FakeDB:
    def __init__(self):
        self.video_lessons = _Coll()

    def __getitem__(self, name):
        assert name == vpt.LESSONS_COLL
        return self.video_lessons


LESSON = {
    "lessonId": "vid_1", "title": "Pchum Ben Ceremony",
    "mediaRef": "gridfs://sync_media/vid_1.mp4", "syncId": "sync_1",
    "contentType": "video/mp4",
}

VALID_SRT = (
    "1\n00:00:00,000 --> 00:00:02,500\n"
    "Before the sun rises, the village is still quiet.\n"
)


async def _admin_dep():
    return {"email": "admin@test"}


@pytest.fixture
def scheduled_calls(monkeypatch):
    calls = []

    def _fake_schedule(db_, lesson_id, media_bucket, *, imported_transcript=None):
        calls.append({"lesson_id": lesson_id, "imported_transcript": imported_transcript})

    monkeypatch.setattr(vpt, "schedule_pipeline", _fake_schedule)
    monkeypatch.setattr(vpt.sync_studio_tools, "get_media_bucket", lambda d: object())
    return calls


def _make_client(db):
    app = FastAPI()
    api = APIRouter(prefix="/api")
    vpt.register_video_pipeline_routes(api, db, _admin_dep)
    app.include_router(api)
    return TestClient(app)


def test_valid_srt_import_schedules_the_pipeline_with_parsed_segments(scheduled_calls):
    db = _FakeDB()
    asyncio.run(db.video_lessons.insert_one(dict(LESSON)))
    client = _make_client(db)

    r = client.post(
        "/api/studio/video/lessons/vid_1/pipeline/import-transcript",
        json={"format": "srt", "content": VALID_SRT},
    )

    assert r.status_code == 200
    body = r.json()
    assert body["ok"] is True
    assert body["scheduled"] is True
    assert body["cueCount"] == 1
    assert len(scheduled_calls) == 1
    assert scheduled_calls[0]["imported_transcript"]["format"] == "srt"
    assert len(scheduled_calls[0]["imported_transcript"]["segments"]) == 1


def test_unparseable_content_returns_400_and_never_schedules_anything(scheduled_calls):
    db = _FakeDB()
    asyncio.run(db.video_lessons.insert_one(dict(LESSON)))
    client = _make_client(db)

    r = client.post(
        "/api/studio/video/lessons/vid_1/pipeline/import-transcript",
        json={"format": "srt", "content": "not an srt file at all"},
    )

    assert r.status_code == 400
    assert len(scheduled_calls) == 0


def test_unsupported_format_returns_400(scheduled_calls):
    db = _FakeDB()
    asyncio.run(db.video_lessons.insert_one(dict(LESSON)))
    client = _make_client(db)

    r = client.post(
        "/api/studio/video/lessons/vid_1/pipeline/import-transcript",
        json={"format": "docx", "content": "irrelevant"},
    )
    assert r.status_code == 400


def test_missing_lesson_returns_404(scheduled_calls):
    db = _FakeDB()
    client = _make_client(db)

    r = client.post(
        "/api/studio/video/lessons/vid_missing/pipeline/import-transcript",
        json={"format": "srt", "content": VALID_SRT},
    )
    assert r.status_code == 404


def test_lesson_with_no_media_yet_is_refused_with_409(scheduled_calls):
    db = _FakeDB()
    asyncio.run(db.video_lessons.insert_one({"lessonId": "vid_1", "title": "x"}))
    client = _make_client(db)

    r = client.post(
        "/api/studio/video/lessons/vid_1/pipeline/import-transcript",
        json={"format": "srt", "content": VALID_SRT},
    )
    assert r.status_code == 409
    assert "upload media" in r.json()["detail"]


def test_refuses_while_a_pipeline_is_genuinely_already_running(scheduled_calls):
    db = _FakeDB()
    lesson = dict(LESSON)
    lesson["pipeline"] = {"state": "running", "startedAt": vpt._now()}
    asyncio.run(db.video_lessons.insert_one(lesson))
    client = _make_client(db)

    r = client.post(
        "/api/studio/video/lessons/vid_1/pipeline/import-transcript",
        json={"format": "srt", "content": VALID_SRT},
    )
    assert r.status_code == 409
    assert len(scheduled_calls) == 0
