"""tests/test_video_pipeline_watchdog.py
==========================================
Regression coverage for a real production incident: a Video Library lesson
stuck permanently at "AI Processing -> media_check -> PROCESSING" with no
further log lines, in a live (not restarted) server process, for 8+
minutes. Root-cause investigation (video_pipeline_tools.py) found the
pipeline's own exception handling is correct — but nothing ever bounds the
awaited I/O inside a stage, and the shared Mongo client (server.py) sets no
socketTimeoutMS. A stalled read (dead/half-open connection, a hung GridFS
or R2 fetch) can await forever with no exception ever raised, so the
try/except in run_pipeline never fires — the lesson is left showing
pipeline.state="running" in Mongo permanently, and the atomic "already
running" claim then refuses every future retry attempt too.

This file proves the fix: run_pipeline now bounds the whole run with
asyncio.wait_for(timeout=PIPELINE_TIMEOUT_S), and both the internal claim
and the admin's manual "Retry" route treat a "running" pipeline whose
startedAt predates that ceiling as orphaned/stale and reclaimable — instead
of refusing forever.

No real Mongo/network — an in-memory fake DB supporting the $or/$ne/$lt
operators the new claim query actually uses.
"""
from __future__ import annotations

import asyncio

import pytest
from fastapi import APIRouter, FastAPI, HTTPException
from fastapi.testclient import TestClient

import video_pipeline_tools as vpt


# ── in-memory Mongo fake — $or/$ne/$lt/$in, dotted paths, $push/$slice ────
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
                before = dict(doc)
                if "$set" in update:
                    for k, v in update["$set"].items():
                        _set_dotted(doc, k, v)
                return before
        return None


class _FakeDB:
    def __init__(self):
        self.video_lessons = _Coll()

    def __getitem__(self, name):
        assert name == vpt.LESSONS_COLL
        return self.video_lessons


LESSON = {
    "lessonId": "vid_1", "title": "Ordering Coffee",
    "mediaRef": "gridfs://sync_media/vid_1.mp4", "syncId": "sync_1",
    "contentType": "video/mp4",
}


class _HangingBucket:
    """Simulates a stalled GridFS/R2 read — never resolves within the test's
    patience, exactly the failure mode a dead Mongo connection or a wedged
    HTTP fetch produces in production (no exception, just no completion)."""
    async def open_download_stream_by_name(self, filename):
        await asyncio.sleep(3600)  # would hang "forever" relative to any sane timeout
        raise AssertionError("should never resolve — test timeout must fire first")


class _FastBucket:
    class _GridOut:
        metadata = {"contentType": "video/mp4"}

        async def read(self):
            return b"fake-media-bytes"

    async def open_download_stream_by_name(self, filename):
        return self._GridOut()


@pytest.fixture(autouse=True)
def _no_real_env(monkeypatch):
    monkeypatch.delenv("GEMINI_API_KEY", raising=False)
    monkeypatch.delenv("VIDEO_AI_MOCK", raising=False)


@pytest.fixture(autouse=True)
def _fast_watchdog(monkeypatch):
    """A short ceiling so the timeout test doesn't actually wait 600s."""
    monkeypatch.setattr(vpt, "PIPELINE_TIMEOUT_S", 0.2)


def _stub_sync_studio(monkeypatch):
    """The watchdog/staleness mechanism under test lives entirely in
    video_pipeline_tools.py — sync_studio_tools' own correctness is covered
    by its own test file. Stubbing its calls keeps this file focused and
    avoids needing a full chapter_sync fake schema."""
    async def _noop(*a, **k):
        return None

    async def _fake_apply_alignment_result(db, sync_id, result_fields):
        return {"durationSec": 12.0}

    monkeypatch.setattr(vpt.sync_studio_tools, "mark_alignment_processing", _noop)
    monkeypatch.setattr(vpt.sync_studio_tools, "apply_alignment_result", _fake_apply_alignment_result)
    monkeypatch.setattr(vpt.sync_studio_tools, "suggest_speaker_labels", _noop)
    monkeypatch.setattr(vpt.sync_studio_tools, "mark_alignment_failed", _noop)


# ── the actual regression: a stalled I/O call must become a truthful
#    "failed" state, never an eternal "running" one ────────────────────────
@pytest.mark.asyncio
async def test_stalled_media_fetch_times_out_to_a_truthful_failed_state():
    db = _FakeDB()
    await db.video_lessons.insert_one(dict(LESSON))

    pipeline = await vpt.run_pipeline(db, "vid_1", _HangingBucket())

    assert pipeline["state"] == "failed"
    assert "timed out" in pipeline["error"].lower()
    assert pipeline["steps"]["media_check"]["status"] == "failed"
    assert pipeline["currentStep"] == "media_check"


@pytest.mark.asyncio
async def test_stalled_run_never_leaves_the_lesson_permanently_running():
    """The exact symptom from the incident: pipeline.state must not still
    read 'running' after the watchdog fires — that permanent-running state
    is precisely what made the lesson unrecoverable in production."""
    db = _FakeDB()
    await db.video_lessons.insert_one(dict(LESSON))

    await vpt.run_pipeline(db, "vid_1", _HangingBucket())

    doc = await db.video_lessons.find_one({"lessonId": "vid_1"})
    assert doc["pipeline"]["state"] != "running"
    assert doc["pipeline"]["finishedAt"] is not None


# ── stale-claim reclaim: an orphaned "running" pipeline (the process-
#    restart variant of the same incident) must be retryable ──────────────
@pytest.mark.asyncio
async def test_orphaned_running_pipeline_is_reclaimed_and_completes(monkeypatch):
    _stub_sync_studio(monkeypatch)
    db = _FakeDB()
    lesson = dict(LESSON)
    # Simulate a pipeline left "running" by a process that died mid-flight —
    # startedAt is older than the watchdog ceiling, so it must be treated as
    # orphaned rather than genuinely in-flight.
    lesson["pipeline"] = {
        "state": "running", "currentStep": "media_check", "provider": "mock-asr-v1",
        "steps": {s: {"status": "pending", "error": None, "at": None} for s in vpt.PIPELINE_STEPS},
        "startedAt": "2020-01-01T00:00:00Z", "finishedAt": None, "error": None, "log": [],
    }
    await db.video_lessons.insert_one(lesson)

    pipeline = await vpt.run_pipeline(db, "vid_1", _FastBucket())

    assert pipeline["state"] == "complete"
    assert pipeline["steps"]["review_ready"]["status"] == "complete"


@pytest.mark.asyncio
async def test_genuinely_fresh_running_pipeline_is_still_refused():
    """A REAL concurrent run (startedAt just now) must still be refused —
    the stale-reclaim fix must not turn into 'always allow a second run'."""
    db = _FakeDB()
    lesson = dict(LESSON)
    lesson["pipeline"] = {
        "state": "running", "currentStep": "media_check", "provider": "mock-asr-v1",
        "steps": {s: {"status": "pending", "error": None, "at": None} for s in vpt.PIPELINE_STEPS},
        "startedAt": vpt._now(), "finishedAt": None, "error": None, "log": [],
    }
    await db.video_lessons.insert_one(lesson)

    with pytest.raises(RuntimeError, match="already running"):
        await vpt.run_pipeline(db, "vid_1", _FastBucket())


def test_pipeline_is_stale_helper():
    assert vpt._pipeline_is_stale({"startedAt": "2020-01-01T00:00:00Z"}) is True
    assert vpt._pipeline_is_stale({"startedAt": vpt._now()}) is False
    assert vpt._pipeline_is_stale({}) is False
    assert vpt._pipeline_is_stale(None) is False


# ── route-level: the manual "Retry" button must not stay refused forever ──
async def _admin_dep():
    return {"email": "admin@test"}


def _make_client(db):
    app = FastAPI()
    api = APIRouter(prefix="/api")
    vpt.register_video_pipeline_routes(api, db, _admin_dep)
    app.include_router(api)
    return TestClient(app)


def test_route_refuses_retry_while_genuinely_running(monkeypatch):
    monkeypatch.setattr(vpt, "schedule_pipeline", lambda *a, **k: None)
    monkeypatch.setattr(vpt.sync_studio_tools, "get_media_bucket", lambda db: object())
    db = _FakeDB()
    lesson = dict(LESSON)
    lesson["pipeline"] = {"state": "running", "startedAt": vpt._now()}
    asyncio.run(db.video_lessons.insert_one(lesson))
    client = _make_client(db)
    r = client.post("/api/studio/video/lessons/vid_1/pipeline/run")
    assert r.status_code == 409
    assert "already running" in r.json()["detail"]


def test_route_allows_retry_once_orphaned_running_pipeline_is_stale(monkeypatch):
    # schedule_pipeline is a fire-and-forget asyncio.create_task — stub it
    # so this test verifies the route's 409-vs-200 decision only, not a real
    # background run (that path is covered by the run_pipeline tests above).
    monkeypatch.setattr(vpt, "schedule_pipeline", lambda *a, **k: None)
    monkeypatch.setattr(vpt.sync_studio_tools, "get_media_bucket", lambda db: object())
    db = _FakeDB()
    lesson = dict(LESSON)
    lesson["pipeline"] = {"state": "running", "startedAt": "2020-01-01T00:00:00Z"}
    asyncio.run(db.video_lessons.insert_one(lesson))
    client = _make_client(db)
    r = client.post("/api/studio/video/lessons/vid_1/pipeline/run")
    assert r.status_code == 200
    assert r.json()["scheduled"] is True
