"""tests/test_video_pipeline_orphan_reconciliation.py — §2 of the video
pipeline crash/reconciliation round: real incident, lesson "Pchum Ben" (a
172MB upload) sat in pipeline.state="running" for minutes after a server
restart before anything server-side noticed — the "Processing stalled...
Safe to retry" message the client eventually showed actually comes from
get_pipeline_status's own in-process self-heal (confirmed by reading that
function directly — see reconcile_orphaned_pipelines's own docstring), but
that mechanism is LAZY: it only fires once a client polls AND the full
PIPELINE_TIMEOUT_S has elapsed since the run's own startedAt. This file
proves the COMPLEMENTARY startup-time mechanism: every "running" pipeline
found at boot is unconditionally reconciled immediately, regardless of age
— re-uses the same fake-Mongo convention as tests/test_video_pipeline_
watchdog.py (find_one/update_one/find_one_and_update), extended with a
`.find()` cursor since reconcile_orphaned_pipelines needs one.
"""
from __future__ import annotations

import pytest

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
        if _get_dotted(doc, k) != v:
            return False
    return True


def _set_dotted(doc, path, value):
    parts = path.split(".")
    cur = doc
    for part in parts[:-1]:
        cur = cur.setdefault(part, {})
    cur[parts[-1]] = value


def _project(doc, projection):
    if not projection:
        return dict(doc)
    out = {}
    for key in projection:
        if key == "_id":
            continue
        if "." in key:
            top = key.split(".", 1)[0]
            if top in doc:
                out[top] = doc[top]
        elif key in doc:
            out[key] = doc[key]
    return out


class _Cursor:
    def __init__(self, docs):
        self._docs = docs

    def __aiter__(self):
        self._it = iter(self._docs)
        return self

    async def __anext__(self):
        try:
            return next(self._it)
        except StopIteration:
            raise StopAsyncIteration


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

    def find(self, query=None, projection=None):
        query = query or {}
        matched = [_project(dict(d), projection) for d in self.docs.values() if _match(d, query)]
        return _Cursor(matched)

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


def _running_pipeline(*, run_id="run_orphan_1", current_step="audio_extraction", started_at="2020-01-01T00:00:00Z"):
    return {
        "runId": run_id, "state": "running", "currentStep": current_step,
        "provider": "gemini-video-asr-v1", "startedAt": started_at, "finishedAt": None, "error": None,
        "steps": {s: {"status": "pending", "error": None, "at": None} for s in vpt.PIPELINE_STEPS},
        "log": [],
    }


def _lesson(lesson_id, pipeline=None):
    doc = {
        "lessonId": lesson_id, "title": "Pchum Ben",
        "mediaRef": f"gridfs://sync_media/{lesson_id}.mp4", "syncId": f"sync_{lesson_id}",
        "contentType": "video/mp4",
    }
    if pipeline is not None:
        doc["pipeline"] = pipeline
    return doc


# ── the core fix: an orphaned "running" pipeline reconciled immediately,
#    regardless of age (unlike the in-process watchdog's 600s threshold) ────
@pytest.mark.asyncio
async def test_orphaned_running_pipeline_is_marked_failed_and_retryable():
    db = _FakeDB()
    # Deliberately a RECENT startedAt (well under PIPELINE_TIMEOUT_S=600s) —
    # proving this reconciliation does NOT wait for the in-process
    # watchdog's age threshold the way get_pipeline_status's self-heal does.
    # A restart that happened 10 seconds ago is just as orphaned as one
    # from an hour ago, because the CURRENT process has no live task tied
    # to either.
    await db.video_lessons.insert_one(_lesson("vid_25516a5eaa2a4c63", _running_pipeline(started_at=vpt._now())))

    reconciled = await vpt.reconcile_orphaned_pipelines(db)

    assert reconciled == 1
    doc = await db.video_lessons.find_one({"lessonId": "vid_25516a5eaa2a4c63"})
    assert doc["pipeline"]["state"] == "failed"
    assert doc["pipeline"]["finishedAt"] is not None
    assert "restart" in doc["pipeline"]["error"].lower()
    assert "retry" in doc["pipeline"]["error"].lower()
    # The specific step it was orphaned at is what the Studio UI reads to
    # render the red "Audio extraction — FAILED" state from the incident.
    assert doc["pipeline"]["steps"]["audio_extraction"]["status"] == "failed"
    assert "restart" in doc["pipeline"]["steps"]["audio_extraction"]["error"].lower()

    # And it's genuinely retryable afterward — closing the loop, same proof
    # style as test_video_pipeline_watchdog.py's own reclaim tests.
    result = await vpt.run_pipeline(db, "vid_25516a5eaa2a4c63", _FakeBucketForRetry())
    assert result["state"] == "complete"


class _FakeBucketForRetry:
    class _GridOut:
        metadata = {"contentType": "video/mp4"}

        async def read(self):
            return b"fake-media-bytes"

    async def open_download_stream_by_name(self, filename):
        return self._GridOut()


@pytest.fixture(autouse=True)
def _stub_heavy_stages(monkeypatch):
    """Same stubbing discipline as test_video_pipeline_watchdog.py — this
    file's own concern is reconciliation, not real ffmpeg/Gemini/sync
    correctness (each already covered by their own test files)."""
    monkeypatch.delenv("GEMINI_API_KEY", raising=False)
    monkeypatch.delenv("VIDEO_AI_MOCK", raising=False)
    monkeypatch.setenv("VIDEO_AI_MOCK", "1")

    async def _noop(*a, **k):
        return None

    async def _fake_apply_alignment_result(db, sync_id, result_fields):
        return {"durationSec": 12.0}

    monkeypatch.setattr(vpt.sync_studio_tools, "mark_alignment_processing", _noop)
    monkeypatch.setattr(vpt.sync_studio_tools, "apply_alignment_result", _fake_apply_alignment_result)
    monkeypatch.setattr(vpt.sync_studio_tools, "suggest_speaker_labels", _noop)
    monkeypatch.setattr(vpt.sync_studio_tools, "mark_alignment_failed", _noop)
    monkeypatch.setattr(vpt.video_render_tools, "extract_audio_track", _noop)
    monkeypatch.setattr(vpt.video_render_tools, "probe_audio_duration_seconds", _noop)


@pytest.mark.asyncio
async def test_multiple_orphaned_pipelines_are_all_reconciled_independently():
    db = _FakeDB()
    await db.video_lessons.insert_one(
        _lesson("vid_a", _running_pipeline(run_id="run_a", current_step="media_check")))
    await db.video_lessons.insert_one(
        _lesson("vid_b", _running_pipeline(run_id="run_b", current_step="speech_recognition")))

    reconciled = await vpt.reconcile_orphaned_pipelines(db)

    assert reconciled == 2
    doc_a = await db.video_lessons.find_one({"lessonId": "vid_a"})
    doc_b = await db.video_lessons.find_one({"lessonId": "vid_b"})
    assert doc_a["pipeline"]["state"] == "failed"
    assert doc_a["pipeline"]["steps"]["media_check"]["status"] == "failed"
    assert doc_b["pipeline"]["state"] == "failed"
    assert doc_b["pipeline"]["steps"]["speech_recognition"]["status"] == "failed"


# ── no false positives: anything NOT genuinely "running" is left untouched ──
@pytest.mark.asyncio
async def test_a_completed_pipeline_is_never_touched():
    db = _FakeDB()
    completed = _running_pipeline()
    completed["state"] = "complete"
    completed["finishedAt"] = "2026-01-01T00:00:00Z"
    await db.video_lessons.insert_one(_lesson("vid_done", completed))

    reconciled = await vpt.reconcile_orphaned_pipelines(db)

    assert reconciled == 0
    doc = await db.video_lessons.find_one({"lessonId": "vid_done"})
    assert doc["pipeline"]["state"] == "complete"  # untouched
    assert doc["pipeline"]["finishedAt"] == "2026-01-01T00:00:00Z"  # untouched


@pytest.mark.asyncio
async def test_an_already_failed_pipeline_is_never_touched():
    db = _FakeDB()
    failed = _running_pipeline()
    failed["state"] = "failed"
    failed["error"] = "some earlier, unrelated failure"
    await db.video_lessons.insert_one(_lesson("vid_failed", failed))

    reconciled = await vpt.reconcile_orphaned_pipelines(db)

    assert reconciled == 0
    doc = await db.video_lessons.find_one({"lessonId": "vid_failed"})
    assert doc["pipeline"]["error"] == "some earlier, unrelated failure"  # untouched, not overwritten


@pytest.mark.asyncio
async def test_a_lesson_with_no_pipeline_field_at_all_is_never_touched():
    db = _FakeDB()
    await db.video_lessons.insert_one(_lesson("vid_never_processed"))

    reconciled = await vpt.reconcile_orphaned_pipelines(db)

    assert reconciled == 0
    doc = await db.video_lessons.find_one({"lessonId": "vid_never_processed"})
    assert "pipeline" not in doc


@pytest.mark.asyncio
async def test_no_orphaned_pipelines_at_all_is_a_clean_no_op():
    db = _FakeDB()
    reconciled = await vpt.reconcile_orphaned_pipelines(db)
    assert reconciled == 0


# ── complementary, not duplicative: distinct from _pipeline_is_stale's own
#    age-gated in-process check ─────────────────────────────────────────────
def test_reconciliation_message_is_distinct_from_the_in_process_self_heal_message():
    """The two mechanisms are honest about WHY each fired — the in-process
    self-heal (get_pipeline_status) can truthfully say "no progress in over
    600s" because it only ever fires once that's actually elapsed; this
    startup-time reconciliation makes no such age claim (it may reconcile
    a run that had barely started), so its message must not borrow that
    now-inapplicable specific wording."""
    assert "600" not in vpt.ORPHANED_PIPELINE_RESTART_MESSAGE
    assert "restart" in vpt.ORPHANED_PIPELINE_RESTART_MESSAGE.lower()
    assert "retry" in vpt.ORPHANED_PIPELINE_RESTART_MESSAGE.lower()
