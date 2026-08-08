"""tests/test_video_narration_tools.py — the AI Narration production
engine orchestration: whole-story analysis (Mode A) -> script blueprint
(Mode B) -> voice assignment/role-consistency -> per-line ElevenLabs
generation (mock/no-key path + real-provider-shaped fake HTTP) -> assembly
-> explicit publish gate. Verifies cost-safety end to end (a downstream
failure never re-triggers upstream work), role-consistency across
regeneration, and that nothing is ever auto-published to students.
"""
from __future__ import annotations

import base64

import pytest

import sync_studio_tools
import video_narration_jobs as jobs
import video_narration_tools as vnt


# ── generic in-memory Mongo fake (dotted paths, $set/$inc/$unset/$or/$in/$lt) ─
def _get_dotted(doc, path):
    cur = doc
    for part in path.split("."):
        if not isinstance(cur, dict):
            return None
        cur = cur.get(part)
    return cur


def _set_dotted(doc, path, value):
    parts = path.split(".")
    cur = doc
    for part in parts[:-1]:
        cur = cur.setdefault(part, {})
    cur[parts[-1]] = value


def _unset_dotted(doc, path):
    parts = path.split(".")
    cur = doc
    for part in parts[:-1]:
        if not isinstance(cur, dict) or part not in cur:
            return
        cur = cur[part]
    cur.pop(parts[-1], None)


def _inc_dotted(doc, path, amount):
    cur = _get_dotted(doc, path) or 0
    _set_dotted(doc, path, cur + amount)


def _match(doc, query):
    for k, v in query.items():
        if k == "$or":
            if not any(_match(doc, sub) for sub in v):
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


class _Coll:
    def __init__(self):
        self.docs: dict = {}

    async def create_index(self, *a, **k):
        return None

    def _match_one(self, query):
        for doc in self.docs.values():
            if _match(doc, query):
                return doc
        return None

    async def insert_one(self, doc):
        key = doc.get("_id") or doc.get("syncId") or doc.get("lessonId")
        self.docs[key] = dict(doc)

    async def find_one(self, query, projection=None):
        doc = self._match_one(query)
        if doc is None:
            return None
        out = dict(doc)
        if projection and projection.get("_id") == 0:
            out.pop("_id", None)
        return out

    async def update_one(self, query, update, upsert=False):
        doc = self._match_one(query)
        if doc is None:
            if upsert and "$setOnInsert" in update:
                new_doc = dict(update["$setOnInsert"])
                self.docs[new_doc["_id"]] = new_doc
            return None
        if "$set" in update:
            for k, v in update["$set"].items():
                _set_dotted(doc, k, v)
        if "$unset" in update:
            for k in update["$unset"]:
                _unset_dotted(doc, k)
        return None

    async def find_one_and_update(self, query, update, **kwargs):
        doc = self._match_one(query)
        if doc is None:
            return None
        if "$set" in update:
            for k, v in update["$set"].items():
                _set_dotted(doc, k, v)
        if "$inc" in update:
            for k, v in update["$inc"].items():
                _inc_dotted(doc, k, v)
        return dict(doc)


class _FakeDB:
    def __init__(self):
        self.video_narration_jobs = _Coll()
        self.chapter_sync = _Coll()
        self.video_lessons = _Coll()

    def __getitem__(self, name):
        return {
            jobs.COLL: self.video_narration_jobs,
            sync_studio_tools.CHAPTER_SYNC_COLL: self.chapter_sync,
            vnt.LESSONS_COLL: self.video_lessons,
        }[name]


class _FakeGridOut:
    def __init__(self, data: bytes, metadata: dict):
        self._data = data
        self._pos = 0
        self.metadata = metadata
        self.length = len(data)

    async def seek(self, pos):
        self._pos = pos

    async def read(self, n=None):
        if n is None:
            chunk = self._data[self._pos:]
            self._pos = len(self._data)
            return chunk
        chunk = self._data[self._pos:self._pos + n]
        self._pos += len(chunk)
        return chunk


class _FakeMediaBucket:
    def __init__(self):
        self.files: dict[str, tuple[bytes, dict]] = {}

    async def upload_from_stream(self, filename, stream, metadata=None):
        self.files[filename] = (stream.read(), metadata or {})

    async def open_download_stream_by_name(self, filename):
        if filename not in self.files:
            raise FileNotFoundError(filename)
        data, metadata = self.files[filename]
        return _FakeGridOut(data, metadata)


class _FakeHttpResponse:
    def __init__(self, status_code=200, payload=None, text=""):
        self.status_code = status_code
        self._payload = payload or {}
        self.text = text

    def json(self):
        return self._payload


class _FakeElevenLabsClient:
    """Simulates ElevenLabs' /with-timestamps response shape exactly, so
    the real reshape/reassembly code is exercised end to end."""
    def __init__(self):
        self.calls = []

    async def post(self, url, headers=None, json=None, **kwargs):
        self.calls.append((url, json))
        text = json["text"]
        audio = f"audio-for:{text}".encode()
        chars = list(text)
        starts = [i * 0.1 for i in range(len(chars))]
        ends = [(i + 1) * 0.1 for i in range(len(chars))]
        return _FakeHttpResponse(200, {
            "audio_base64": base64.b64encode(audio).decode(),
            "alignment": {"characters": chars, "character_start_times_seconds": starts,
                          "character_end_times_seconds": ends},
        })


@pytest.fixture(autouse=True)
def _no_real_env(monkeypatch):
    monkeypatch.delenv("GEMINI_API_KEY", raising=False)
    monkeypatch.delenv("VIDEO_AI_MOCK", raising=False)
    monkeypatch.delenv("ELEVENLABS_API_KEY", raising=False)
    monkeypatch.delenv("ELEVENLABS_DEFAULT_VOICE", raising=False)
    monkeypatch.delenv("R2_ACCOUNT_ID", raising=False)


def _fake_bucket_patch(monkeypatch, bucket):
    monkeypatch.setattr(sync_studio_tools, "get_media_bucket", lambda db: bucket)


LESSON = {
    "lessonId": "vid_1", "title": "Ordering Coffee", "mediaRef": "gridfs://sync_media/vid_1.mp4",
    "syncId": "sync_1", "contentType": "video/mp4",
}
SYNC_DOC = {
    "syncId": "sync_1", "paragraphs": [{"id": "p1", "sentences": [
        {"id": "s1", "words": [{"word": "Hello"}, {"word": "there"}]},
    ]}],
}


async def _lesson_getter(lesson_id):
    return LESSON if lesson_id == "vid_1" else None


async def _sync_getter(sync_id):
    return SYNC_DOC if sync_id == "sync_1" else None


# ── Mode A: whole-story analysis (mock path — no GEMINI_API_KEY) ─────────
@pytest.mark.asyncio
async def test_run_story_analysis_mock_path_completes(monkeypatch):
    db = _FakeDB()
    bucket = _FakeMediaBucket()
    _fake_bucket_patch(monkeypatch, bucket)
    await bucket.upload_from_stream("vid_1.mp4", __import__("io").BytesIO(b"fake-video"), {"contentType": "video/mp4"})

    job = await vnt.run_story_analysis(db, "vid_1", bucket, lesson_getter=_lesson_getter, sync_getter=_sync_getter)
    assert job["storyAnalysis"]["state"] == jobs.S_COMPLETED
    assert job["storyAnalysis"]["result"]["engine"] == "mock"


@pytest.mark.asyncio
async def test_run_story_analysis_is_cost_safe_never_reruns_when_completed(monkeypatch):
    db = _FakeDB()
    bucket = _FakeMediaBucket()
    _fake_bucket_patch(monkeypatch, bucket)
    await bucket.upload_from_stream("vid_1.mp4", __import__("io").BytesIO(b"fake-video"), {"contentType": "video/mp4"})

    first = await vnt.run_story_analysis(db, "vid_1", bucket, lesson_getter=_lesson_getter, sync_getter=_sync_getter)
    second = await vnt.run_story_analysis(db, "vid_1", bucket, lesson_getter=_lesson_getter, sync_getter=_sync_getter)
    assert first["storyAnalysis"]["result"] == second["storyAnalysis"]["result"]
    assert second["storyAnalysis"]["attemptCount"] == 1  # never re-claimed


@pytest.mark.asyncio
async def test_run_story_analysis_fails_terminal_without_media():
    db = _FakeDB()

    async def no_media_lesson(lesson_id):
        return {"lessonId": lesson_id, "title": "x"}  # no mediaRef/syncId

    job = await vnt.run_story_analysis(db, "vid_2", _FakeMediaBucket(), lesson_getter=no_media_lesson, sync_getter=_sync_getter)
    assert job["storyAnalysis"]["state"] == jobs.S_FAILED_TERMINAL


# ── Mode B: script blueprint ──────────────────────────────────────────────
@pytest.mark.asyncio
async def test_run_script_blueprint_requires_story_analysis_first():
    db = _FakeDB()
    await jobs.get_or_create_job(db, "vid_1")
    with pytest.raises(vnt.VideoNarrationError) as exc:
        await vnt.run_script_blueprint(db, "vid_1", lesson_getter=_lesson_getter, sync_getter=_sync_getter)
    assert exc.value.code == "story_analysis_required"


@pytest.mark.asyncio
async def test_run_script_blueprint_mock_path_covers_every_scene(monkeypatch):
    db = _FakeDB()
    bucket = _FakeMediaBucket()
    _fake_bucket_patch(monkeypatch, bucket)
    await bucket.upload_from_stream("vid_1.mp4", __import__("io").BytesIO(b"fake-video"), {"contentType": "video/mp4"})
    await vnt.run_story_analysis(db, "vid_1", bucket, lesson_getter=_lesson_getter, sync_getter=_sync_getter)

    job = await vnt.run_script_blueprint(db, "vid_1", lesson_getter=_lesson_getter, sync_getter=_sync_getter)
    assert job["scriptBlueprint"]["state"] == jobs.S_COMPLETED
    scene_ids_story = [s["sceneId"] for s in job["storyAnalysis"]["result"]["scenes"]]
    scene_ids_script = [s["sceneId"] for s in job["scriptBlueprint"]["result"]["scenes"]]
    assert scene_ids_script == scene_ids_story


@pytest.mark.asyncio
async def test_edit_script_blueprint_rejects_unknown_scene_id(monkeypatch):
    db = _FakeDB()
    bucket = _FakeMediaBucket()
    _fake_bucket_patch(monkeypatch, bucket)
    await bucket.upload_from_stream("vid_1.mp4", __import__("io").BytesIO(b"fake-video"), {"contentType": "video/mp4"})
    await vnt.run_story_analysis(db, "vid_1", bucket, lesson_getter=_lesson_getter, sync_getter=_sync_getter)
    await vnt.run_script_blueprint(db, "vid_1", lesson_getter=_lesson_getter, sync_getter=_sync_getter)

    with pytest.raises(vnt.VideoNarrationError) as exc:
        await vnt.edit_script_blueprint(db, "vid_1", [{"sceneId": "sc_ghost", "lines": []}])
    assert exc.value.code == "invalid_script"


@pytest.mark.asyncio
async def test_edit_script_blueprint_accepts_valid_correction(monkeypatch):
    db = _FakeDB()
    bucket = _FakeMediaBucket()
    _fake_bucket_patch(monkeypatch, bucket)
    await bucket.upload_from_stream("vid_1.mp4", __import__("io").BytesIO(b"fake-video"), {"contentType": "video/mp4"})
    await vnt.run_story_analysis(db, "vid_1", bucket, lesson_getter=_lesson_getter, sync_getter=_sync_getter)
    job = await vnt.run_script_blueprint(db, "vid_1", lesson_getter=_lesson_getter, sync_getter=_sync_getter)
    scene_id = job["scriptBlueprint"]["result"]["scenes"][0]["sceneId"]

    corrected = [{"sceneId": scene_id, "lines": [
        {"lineId": "ln_x", "speaker": "Narrator", "text": "Corrected line.", "emotion": ""},
    ]}]
    job2 = await vnt.edit_script_blueprint(db, "vid_1", corrected)
    assert job2["scriptBlueprint"]["result"]["scenes"][0]["lines"][0]["text"] == "Corrected line."


# ── Per-line voice production ─────────────────────────────────────────────
async def _job_with_script(db, monkeypatch):
    bucket = _FakeMediaBucket()
    _fake_bucket_patch(monkeypatch, bucket)
    await bucket.upload_from_stream("vid_1.mp4", __import__("io").BytesIO(b"fake-video"), {"contentType": "video/mp4"})
    await vnt.run_story_analysis(db, "vid_1", bucket, lesson_getter=_lesson_getter, sync_getter=_sync_getter)
    job = await vnt.run_script_blueprint(db, "vid_1", lesson_getter=_lesson_getter, sync_getter=_sync_getter)
    scene_id = job["scriptBlueprint"]["result"]["scenes"][0]["sceneId"]
    line = job["scriptBlueprint"]["result"]["scenes"][0]["lines"][0]
    return bucket, scene_id, line["lineId"]


@pytest.mark.asyncio
async def test_generate_line_voice_fails_terminal_without_any_voice(monkeypatch):
    db = _FakeDB()
    _bucket, scene_id, line_id = await _job_with_script(db, monkeypatch)
    job = await vnt.generate_line_voice(db, "vid_1", scene_id, line_id)
    path = f"voiceProduction.{scene_id}.lines.{line_id}"
    assert _get_dotted(job, path)["state"] == jobs.S_FAILED_TERMINAL


@pytest.mark.asyncio
async def test_generate_line_voice_happy_path_with_assigned_voice(monkeypatch):
    db = _FakeDB()
    bucket, scene_id, line_id = await _job_with_script(db, monkeypatch)
    monkeypatch.setenv("ELEVENLABS_API_KEY", "test-key")
    await vnt.set_voice_assignments(db, "vid_1", {"Narrator": "voice_narrator_1"})

    client = _FakeElevenLabsClient()
    job = await vnt.generate_line_voice(db, "vid_1", scene_id, line_id, http_client=client)
    path = f"voiceProduction.{scene_id}.lines.{line_id}"
    stage = _get_dotted(job, path)
    assert stage["state"] == jobs.S_COMPLETED
    assert stage["result"]["voiceId"] == "voice_narrator_1"
    assert stage["result"]["mediaRef"].startswith("gridfs://sync_media/")
    assert stage["result"]["wordTimestamps"]
    assert client.calls, "should have called ElevenLabs"


@pytest.mark.asyncio
async def test_generate_line_voice_never_reclaims_completed_line_cost_safety(monkeypatch):
    db = _FakeDB()
    bucket, scene_id, line_id = await _job_with_script(db, monkeypatch)
    monkeypatch.setenv("ELEVENLABS_API_KEY", "test-key")
    await vnt.set_voice_assignments(db, "vid_1", {"Narrator": "voice_1"})
    client = _FakeElevenLabsClient()
    await vnt.generate_line_voice(db, "vid_1", scene_id, line_id, http_client=client)

    # A second call must be a cost-safe no-op — no new ElevenLabs request.
    calls_before = len(client.calls)
    await vnt.generate_line_voice(db, "vid_1", scene_id, line_id, http_client=client)
    assert len(client.calls) == calls_before


@pytest.mark.asyncio
async def test_reset_line_voice_allows_regeneration_after_explicit_confirmation(monkeypatch):
    db = _FakeDB()
    bucket, scene_id, line_id = await _job_with_script(db, monkeypatch)
    monkeypatch.setenv("ELEVENLABS_API_KEY", "test-key")
    await vnt.set_voice_assignments(db, "vid_1", {"Narrator": "voice_1"})
    client = _FakeElevenLabsClient()
    await vnt.generate_line_voice(db, "vid_1", scene_id, line_id, http_client=client)

    await vnt.reset_line_voice(db, "vid_1", scene_id, line_id)
    job = await vnt.generate_line_voice(db, "vid_1", scene_id, line_id, http_client=client)
    path = f"voiceProduction.{scene_id}.lines.{line_id}"
    assert _get_dotted(job, path)["state"] == jobs.S_COMPLETED
    assert len(client.calls) == 2  # genuinely regenerated, not skipped


@pytest.mark.asyncio
async def test_set_voice_assignments_marks_completed_lines_stale_on_change(monkeypatch):
    db = _FakeDB()
    bucket, scene_id, line_id = await _job_with_script(db, monkeypatch)
    monkeypatch.setenv("ELEVENLABS_API_KEY", "test-key")
    await vnt.set_voice_assignments(db, "vid_1", {"Narrator": "voice_1"})
    client = _FakeElevenLabsClient()
    await vnt.generate_line_voice(db, "vid_1", scene_id, line_id, http_client=client)

    # Changing the Narrator's assigned voice must flag the already-completed
    # line as stale WITHOUT resetting/regenerating it (never silently spend).
    job = await vnt.set_voice_assignments(db, "vid_1", {"Narrator": "voice_2"})
    path = f"voiceProduction.{scene_id}.lines.{line_id}"
    stage = _get_dotted(job, path)
    assert stage["state"] == jobs.S_COMPLETED  # untouched
    assert stage["result"]["voiceStale"] is True
    assert len(client.calls) == 1  # no new ElevenLabs call happened


# ── Assembly + publish ─────────────────────────────────────────────────────
@pytest.mark.asyncio
async def test_assemble_requires_all_lines_complete(monkeypatch):
    db = _FakeDB()
    bucket, scene_id, line_id = await _job_with_script(db, monkeypatch)
    with pytest.raises(vnt.VideoNarrationError) as exc:
        await vnt.assemble_narration_track(db, "vid_1")
    assert exc.value.code == "no_lines" or exc.value.code == "not_all_lines_complete"


@pytest.mark.asyncio
async def test_assemble_and_publish_full_happy_path(monkeypatch):
    db = _FakeDB()
    bucket, scene_id, line_id = await _job_with_script(db, monkeypatch)
    monkeypatch.setenv("ELEVENLABS_API_KEY", "test-key")
    await vnt.set_voice_assignments(db, "vid_1", {"Narrator": "voice_1"})
    client = _FakeElevenLabsClient()
    await vnt.generate_line_voice(db, "vid_1", scene_id, line_id, http_client=client)

    job = await vnt.assemble_narration_track(db, "vid_1")
    assert job["assembly"]["state"] == jobs.S_COMPLETED
    sync_id = job["assembly"]["result"]["syncId"]
    sync_doc = await db.chapter_sync.find_one({"syncId": sync_id})
    assert sync_doc is not None
    assert sync_doc["providerCategory"] == "synthesis"

    # Not published yet — publish is a distinct, explicit admin action.
    db.video_lessons.docs["vid_1"] = dict(LESSON)
    lesson_before = await db.video_lessons.find_one({"lessonId": "vid_1"})
    assert not lesson_before.get("aiNarrationPublished")

    await vnt.publish_narration(db, "vid_1")
    lesson_after = await db.video_lessons.find_one({"lessonId": "vid_1"})
    assert lesson_after["aiNarrationPublished"] is True
    assert lesson_after["aiNarrationSyncId"] == sync_id


@pytest.mark.asyncio
async def test_publish_requires_assembly_first():
    db = _FakeDB()
    await jobs.get_or_create_job(db, "vid_1")
    with pytest.raises(vnt.VideoNarrationError) as exc:
        await vnt.publish_narration(db, "vid_1")
    assert exc.value.code == "not_assembled"


@pytest.mark.asyncio
async def test_unpublish_is_reversible_without_destroying_generated_work(monkeypatch):
    db = _FakeDB()
    bucket, scene_id, line_id = await _job_with_script(db, monkeypatch)
    monkeypatch.setenv("ELEVENLABS_API_KEY", "test-key")
    await vnt.set_voice_assignments(db, "vid_1", {"Narrator": "voice_1"})
    client = _FakeElevenLabsClient()
    await vnt.generate_line_voice(db, "vid_1", scene_id, line_id, http_client=client)
    await vnt.assemble_narration_track(db, "vid_1")
    db.video_lessons.docs["vid_1"] = dict(LESSON)
    await vnt.publish_narration(db, "vid_1")

    await vnt.unpublish_narration(db, "vid_1")
    lesson = await db.video_lessons.find_one({"lessonId": "vid_1"})
    assert lesson["aiNarrationPublished"] is False
    # The generated work itself is untouched — re-publishing needs no rework.
    job = await jobs.get_or_create_job(db, "vid_1")
    assert job["assembly"]["state"] == jobs.S_COMPLETED
