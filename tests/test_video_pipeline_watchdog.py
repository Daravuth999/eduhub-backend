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

    # Audio extraction's own correctness (real ffmpeg) is covered by
    # video_render_tools' test file — stubbed here as a fast no-op so this
    # file's own artificially tiny PIPELINE_TIMEOUT_S (see _fast_watchdog)
    # isn't spent on a real subprocess spawn unrelated to what this file
    # actually tests. Returning None is itself a real, honest code path
    # (extraction unavailable/failed -> fall back to the original bytes),
    # not a shortcut around the pipeline's own logic.
    async def _no_extraction(*a, **k):
        return None

    monkeypatch.setattr(vpt.video_render_tools, "extract_audio_track", _no_extraction)

    # Same reasoning as extract_audio_track above, for the synchronization
    # step's ground-truth timing probe (also real ffprobe) — this file's
    # own correctness (watchdog/staleness) is unrelated to that diagnostic,
    # and None is itself a real, honest "could not determine" result, not
    # a shortcut.
    async def _no_duration_probe(*a, **k):
        return None

    monkeypatch.setattr(vpt.video_render_tools, "probe_audio_duration_seconds", _no_duration_probe)


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
async def test_media_fetch_has_its_own_tighter_timeout_than_the_whole_pipeline(monkeypatch):
    """2026-09 follow-up incident (vid_bb7134374575431b, a real ~250MB
    upload wedged at "Media validation" for 7.5+ minutes and counting).

    Investigation confirmed the OUTER watchdog above (PIPELINE_TIMEOUT_S
    via asyncio.wait_for) still works correctly — re-verified by direct
    empirical reproduction against this project's actual Python 3.14
    interpreter, including against a genuinely-blocking (uninterruptible)
    call dispatched to a thread, the real-world shape of a stalled Mongo
    socket read with no socketTimeoutMS configured (confirmed absent in
    server.py's AsyncIOMotorClient construction). The incident log
    provided only covered ~7.5 minutes of a 600-second (10-minute) budget
    — not yet proof of a broken watchdog.

    The GENUINE gap found: httpx's own `read` timeout bounds the gap
    BETWEEN chunks, never the total transfer time (reproduced directly:
    a slow-drip response succeeded well past the configured read
    timeout), and the GridFS branch had no timeout of its own at all —
    so a merely SLOW (not fully dead) ~250MB fetch could silently consume
    nearly the entire pipeline budget before anything raised, with zero
    diagnostic signal about which operation stalled. load_media_bytes
    now has its own tighter MEDIA_FETCH_TIMEOUT_S ceiling (reusing, not
    inventing, the same 300s already chosen for the httpx client) — this
    proves it fires well before the outer pipeline watchdog would, with
    a specific, honest message."""
    monkeypatch.setattr(vpt, "MEDIA_FETCH_TIMEOUT_S", 0.1)
    # Real headroom above the fetch timeout, so this test actually proves
    # the FETCH-specific ceiling fires first, not the outer pipeline one
    # (which _fast_watchdog already set to 0.2s — too close to 0.1s to
    # prove ordering cleanly, so this test picks its own wider gap).
    monkeypatch.setattr(vpt, "PIPELINE_TIMEOUT_S", 5.0)
    db = _FakeDB()
    await db.video_lessons.insert_one(dict(LESSON))

    import time
    t0 = time.monotonic()
    pipeline = await vpt.run_pipeline(db, "vid_1", _HangingBucket())
    elapsed = time.monotonic() - t0

    assert pipeline["state"] == "failed"
    assert pipeline["steps"]["media_check"]["status"] == "failed"
    assert "media fetch stalled" in pipeline["error"].lower()
    assert "safe to retry" in pipeline["error"].lower()
    # The SPECIFIC fetch timeout fired — not the generic outer-pipeline
    # "Processing timed out after Xs" message the 5.0s ceiling would have
    # produced had this fix not existed.
    assert "processing timed out after" not in pipeline["error"].lower()
    assert elapsed < 2.0, (
        "the fetch-specific timeout should fire in well under a second, "
        "not wait for the outer 5s pipeline ceiling"
    )


@pytest.mark.asyncio
async def test_a_merely_slow_but_healthy_fetch_still_succeeds_within_the_fetch_timeout(monkeypatch):
    """No false positives: the new MEDIA_FETCH_TIMEOUT_S must not turn a
    legitimately-slow-but-completing transfer into a failure."""
    monkeypatch.setattr(vpt, "MEDIA_FETCH_TIMEOUT_S", 5.0)
    # Real headroom above both the simulated fetch delay AND a real
    # ffprobe subprocess call this run also reaches (audio_extraction's
    # probe_audio_stream_status, video content type) — the file's default
    # 0.2s _fast_watchdog ceiling is intentionally tight for tests that
    # never get this far; this one legitimately needs more room.
    monkeypatch.setattr(vpt, "PIPELINE_TIMEOUT_S", 5.0)

    class _SlowButHealthyBucket:
        class _GridOut:
            metadata = {"contentType": "video/mp4"}

            async def read(self):
                await asyncio.sleep(0.2)  # slow, but well within the 5s ceiling
                return b"fake-media-bytes"

        async def open_download_stream_by_name(self, filename):
            return self._GridOut()

    db = _FakeDB()
    await db.video_lessons.insert_one(dict(LESSON))
    _stub_sync_studio(monkeypatch)

    pipeline = await vpt.run_pipeline(db, "vid_1", _SlowButHealthyBucket())

    assert pipeline["steps"]["media_check"]["status"] == "complete"


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


# ── read-time self-heal: GET .../pipeline must never keep reporting
#    "running" once the watchdog ceiling has passed — otherwise the
#    Studio's own retry button (hidden while `running`) never reappears,
#    a genuine dead end distinct from the run_pipeline-level watchdog
#    above (which only fires if the SAME process that started the run is
#    still alive to await it) ────────────────────────────────────────────
@pytest.mark.asyncio
async def test_get_pipeline_status_heals_an_orphaned_running_pipeline_on_read(monkeypatch):
    _stub_sync_studio(monkeypatch)
    db = _FakeDB()
    lesson = dict(LESSON)
    lesson["pipeline"] = {
        "state": "running", "currentStep": "speech_recognition", "provider": "mock-asr-v1",
        "steps": {s: {"status": "pending", "error": None, "at": None} for s in vpt.PIPELINE_STEPS},
        "startedAt": "2020-01-01T00:00:00Z", "finishedAt": None, "error": None, "log": [],
    }
    await db.video_lessons.insert_one(lesson)

    status = await vpt.get_pipeline_status(db, "vid_1")

    assert status["pipeline"]["state"] == "failed"
    assert "restarted" in status["pipeline"]["error"].lower()
    assert status["pipeline"]["steps"]["speech_recognition"]["status"] == "failed"

    # And it's now genuinely retryable end-to-end, closing the loop.
    pipeline = await vpt.run_pipeline(db, "vid_1", _FastBucket())
    assert pipeline["state"] == "complete"


@pytest.mark.asyncio
async def test_get_pipeline_status_never_touches_a_still_fresh_running_pipeline():
    db = _FakeDB()
    lesson = dict(LESSON)
    lesson["pipeline"] = {
        "state": "running", "currentStep": "media_check", "provider": "mock-asr-v1",
        "steps": {s: {"status": "pending", "error": None, "at": None} for s in vpt.PIPELINE_STEPS},
        "startedAt": vpt._now(), "finishedAt": None, "error": None, "log": [],
    }
    await db.video_lessons.insert_one(lesson)

    status = await vpt.get_pipeline_status(db, "vid_1")

    assert status["pipeline"]["state"] == "running"  # still genuinely in flight


def test_pipeline_status_route_self_heals_and_the_retry_route_then_accepts(monkeypatch):
    """End-to-end proof at the HTTP layer: polling the status route for an
    orphaned lesson flips it to failed, and the retry route (which the
    Studio's now-visible Retry button calls) accepts immediately after —
    no more permanent 409 dead end."""
    monkeypatch.setattr(vpt, "schedule_pipeline", lambda *a, **k: None)
    monkeypatch.setattr(vpt.sync_studio_tools, "get_media_bucket", lambda db: object())
    db = _FakeDB()
    lesson = dict(LESSON)
    lesson["pipeline"] = {
        "state": "running", "currentStep": "speech_recognition", "provider": "mock-asr-v1",
        "steps": {s: {"status": "pending", "error": None, "at": None} for s in vpt.PIPELINE_STEPS},
        "startedAt": "2020-01-01T00:00:00Z", "finishedAt": None, "error": None, "log": [],
    }
    asyncio.run(db.video_lessons.insert_one(lesson))
    client = _make_client(db)

    status = client.get("/api/studio/video/lessons/vid_1/pipeline")
    assert status.status_code == 200
    assert status.json()["pipeline"]["state"] == "failed"

    retry = client.post("/api/studio/video/lessons/vid_1/pipeline/run")
    assert retry.status_code == 200
    assert retry.json()["scheduled"] is True


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


# ── runId fencing: the pipeline-level analog of video_narration_jobs'
#    attempt/generation fencing, added in the same pass ────────────────────
@pytest.mark.asyncio
async def test_set_step_and_finish_are_fenced_to_the_runid_and_ignore_a_superseded_run():
    """get_pipeline_status's self-heal can flip pipeline.state away from
    "running" (and a subsequent manual retry then claims a brand new runId)
    while the ORIGINAL run_pipeline() coroutine for that lesson is still
    alive in-process — a Mongo write doesn't kill an asyncio task. Without
    runId fencing, the old coroutine's own _set_step/_finish calls would
    keep writing into what is now a DIFFERENT run's pipeline document,
    corrupting it and effectively running two pipelines for one lesson at
    once. Proven directly against _set_step/_finish, the exact functions
    every step transition in run_pipeline goes through."""
    db = _FakeDB()
    await db.video_lessons.insert_one(dict(LESSON))
    old_run_id = "old_run_1"
    new_run_id = "new_run_2"
    await db.video_lessons.update_one(
        {"lessonId": "vid_1"},
        {"$set": {"pipeline": vpt.build_pipeline_record("mock", new_run_id)}},
    )

    # The OLD (superseded) coroutine keeps trying to write — must silently no-op.
    await vpt._set_step(db, "vid_1", old_run_id, "media_check", "complete")
    await vpt._finish(db, "vid_1", old_run_id, "complete")
    doc = await db.video_lessons.find_one({"lessonId": "vid_1"})
    assert doc["pipeline"]["state"] == "running"  # untouched by the stale write
    assert doc["pipeline"]["steps"]["media_check"]["status"] == "pending"

    # The CURRENT run's own writes must still work exactly as before.
    await vpt._set_step(db, "vid_1", new_run_id, "media_check", "complete")
    await vpt._finish(db, "vid_1", new_run_id, "complete")
    doc = await db.video_lessons.find_one({"lessonId": "vid_1"})
    assert doc["pipeline"]["state"] == "complete"
    assert doc["pipeline"]["steps"]["media_check"]["status"] == "complete"


@pytest.mark.asyncio
async def test_get_pipeline_status_self_heal_write_is_fenced_to_the_run_it_observed():
    """The self-heal write itself (get_pipeline_status) must target the
    exact run it read — if a fresher run has already been claimed by the
    time this write lands, it must not stamp "failed" over live progress."""
    db = _FakeDB()
    await db.video_lessons.insert_one(dict(LESSON))
    stale_run_id = "stale_run"
    await db.video_lessons.update_one(
        {"lessonId": "vid_1"},
        {"$set": {"pipeline": {
            **vpt.build_pipeline_record("mock", stale_run_id),
            "startedAt": "2020-01-01T00:00:00Z",
        }}},
    )
    # A fresh run has ALREADY been claimed on top of it (race won by a
    # legitimate retry) before the stale self-heal write below lands.
    fresh_run_id = "fresh_run"
    await db.video_lessons.update_one(
        {"lessonId": "vid_1"}, {"$set": {"pipeline": vpt.build_pipeline_record("mock", fresh_run_id)}},
    )
    await vpt._set_step(db, "vid_1", stale_run_id, "media_check", "failed", "stale self-heal")
    await vpt._finish(db, "vid_1", stale_run_id, "failed", "stale self-heal")

    doc = await db.video_lessons.find_one({"lessonId": "vid_1"})
    assert doc["pipeline"]["runId"] == fresh_run_id
    assert doc["pipeline"]["state"] == "running"  # the fresh run's state survives untouched
