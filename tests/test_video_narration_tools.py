"""tests/test_video_narration_tools.py — the AI Narration production
engine orchestration: whole-story analysis (Mode A) -> script blueprint
(Mode B) -> voice assignment/role-consistency -> per-line ElevenLabs
generation (mock/no-key path + real-provider-shaped fake HTTP) -> assembly
-> explicit publish gate. Verifies cost-safety end to end (a downstream
failure never re-triggers upstream work), role-consistency across
regeneration, and that nothing is ever auto-published to students.
"""
from __future__ import annotations

import asyncio
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
    def __init__(self, status_code=200, payload=None, text="", content=b""):
        self.status_code = status_code
        self._payload = payload or {}
        self.text = text
        self.content = content

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


# ── regression coverage for a real production bug: the ElevenLabs acting-
#    note bracket leaking into word_timestamps (which becomes the sync
#    document's words — the student transcript AND the karaoke highlight
#    source). A leaked note like "[Warm, reassuring tone, highlighting
#    Maya's...]" rendered verbatim to students and got karaoke-highlighted
#    exactly like a real spoken word. ─────────────────────────────────────
class TestElevenlabsGenerateLineActingNoteStripped:
    def test_short_acting_cue_takes_the_first_clause_and_stays_short(self):
        cue = vnt._short_acting_cue(
            "Warm, reassuring tone, highlighting Maya's understanding and empathy for Daniel's situation.",
        )
        assert cue == "Warm"
        assert len(cue) <= 60

    def test_short_acting_cue_falls_back_to_a_bounded_prefix_with_no_punctuation(self):
        cue = vnt._short_acting_cue("a" * 200)
        assert len(cue) <= 60

    @pytest.mark.asyncio
    async def test_word_timestamps_never_contain_the_acting_note(self, monkeypatch):
        monkeypatch.setenv("ELEVENLABS_API_KEY", "test-key")
        client = _FakeElevenLabsClient()
        result = await vnt.elevenlabs_generate_line(
            "He knew he was not alone.", "voice_1",
            acting_note="Uplifting and hopeful, conveying the relief in Daniel's expression.",
            http_client=client,
        )
        words = [w["word"] for w in result["word_timestamps"]]
        joined = " ".join(words)
        assert "Uplifting" not in joined
        assert "hopeful" not in joined
        assert "[" not in joined and "]" not in joined
        # The real spoken line survives intact and in order.
        assert words == ["He", "knew", "he", "was", "not", "alone."]

    @pytest.mark.asyncio
    async def test_duration_reflects_the_full_audio_including_any_bracket_time(self, monkeypatch):
        """duration must still reflect the REAL full clip length (used to
        place the NEXT line's offset in the assembled track) even though
        the bracket's words are stripped from what's returned as the
        transcript-facing word_timestamps."""
        monkeypatch.setenv("ELEVENLABS_API_KEY", "test-key")
        client = _FakeElevenLabsClient()
        text = "Hello there, how are you doing today?"
        with_note = await vnt.elevenlabs_generate_line(
            text, "voice_1", acting_note="Quiet and cautious.", http_client=client,
        )
        without_note = await vnt.elevenlabs_generate_line(text, "voice_1", http_client=client)
        assert with_note["duration"] > without_note["duration"]

    @pytest.mark.asyncio
    async def test_no_acting_note_is_a_pure_passthrough(self, monkeypatch):
        monkeypatch.setenv("ELEVENLABS_API_KEY", "test-key")
        client = _FakeElevenLabsClient()
        result = await vnt.elevenlabs_generate_line("Oh no.", "voice_1", http_client=client)
        assert [w["word"] for w in result["word_timestamps"]] == ["Oh", "no."]

    @pytest.mark.asyncio
    async def test_very_short_lines_skip_acting_direction_entirely(self, monkeypatch):
        """use_acting requires len(text.strip()) > 10 — a very short line
        (e.g. a single interjection) is sent as-is, with no bracket to strip."""
        monkeypatch.setenv("ELEVENLABS_API_KEY", "test-key")
        client = _FakeElevenLabsClient()
        result = await vnt.elevenlabs_generate_line("Oh no.", "voice_1", acting_note="Startled.", http_client=client)
        assert [w["word"] for w in result["word_timestamps"]] == ["Oh", "no."]
        assert "[" not in client.calls[0][1]["text"]


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
async def test_assemble_strips_pre_existing_contaminated_word_timestamps(monkeypatch):
    """Defense-in-depth: a line generated BEFORE the elevenlabs_generate_
    line source fix shipped may still have a contaminated wordTimestamps
    array stored in Mongo (bracket-fragment tokens mixed in with the real
    spoken words). Re-assembling that job today must never let those
    fragments reach the sync document — _looks_like_production_metadata
    is the independent guard at this second boundary."""
    db = _FakeDB()
    bucket, scene_id, line_id = await _job_with_script(db, monkeypatch)
    path = f"voiceProduction.{scene_id}.lines.{line_id}"
    contaminated_result = {
        "speaker": "Narrator", "text": "He knew he was not alone.", "mediaRef": "gridfs://sync_media/line.mp3",
        "wordTimestamps": [
            {"word": "[Uplifting", "start": 0.0, "end": 0.3},
            {"word": "and", "start": 0.3, "end": 0.5},
            {"word": "hopeful]", "start": 0.5, "end": 0.9},
            {"word": "He", "start": 1.0, "end": 1.2},
            {"word": "knew", "start": 1.2, "end": 1.4},
        ],
        "durationSec": 1.4, "voiceId": "voice_1", "voiceStale": False,
    }
    _set_dotted(db.video_narration_jobs.docs["vid_1"], f"{path}.state", jobs.S_COMPLETED)
    _set_dotted(db.video_narration_jobs.docs["vid_1"], f"{path}.result", contaminated_result)
    await bucket.upload_from_stream("line.mp3", __import__("io").BytesIO(b"fake-audio"), {"contentType": "audio/mpeg"})

    job = await vnt.assemble_narration_track(db, "vid_1")
    sync_id = job["assembly"]["result"]["syncId"]
    sync_doc = await db.chapter_sync.find_one({"syncId": sync_id})
    words = [w["word"] for s in sync_doc["paragraphs"][0]["sentences"] for w in s["words"]]

    assert words == ["He", "knew"]
    assert not any("[" in w or "]" in w for w in words)


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


# ── Final render (physically embedded audio via video_render_tools) ───────
async def _assembled_job(db, monkeypatch):
    bucket, scene_id, line_id = await _job_with_script(db, monkeypatch)
    monkeypatch.setenv("ELEVENLABS_API_KEY", "test-key")
    await vnt.set_voice_assignments(db, "vid_1", {"Narrator": "voice_1"})
    client = _FakeElevenLabsClient()
    await vnt.generate_line_voice(db, "vid_1", scene_id, line_id, http_client=client)
    await vnt.assemble_narration_track(db, "vid_1")
    return bucket


async def _fake_mux(video_bytes, video_ct, audio_bytes, *, treatment="mute"):
    return b"FAKE-RENDERED-MP4:" + video_bytes + b":" + audio_bytes + b":" + treatment.encode()


@pytest.mark.asyncio
async def test_render_requires_assembly_first():
    db = _FakeDB()
    await jobs.get_or_create_job(db, "vid_1")
    with pytest.raises(vnt.VideoNarrationError) as exc:
        await vnt.render_final_master(db, "vid_1", None, lesson_getter=_lesson_getter)
    assert exc.value.code == "not_assembled"


@pytest.mark.asyncio
async def test_render_happy_path_produces_master_and_publish_exposes_it(monkeypatch):
    db = _FakeDB()
    bucket = await _assembled_job(db, monkeypatch)
    monkeypatch.setattr(vnt.video_render_tools, "mux_narration_into_video", _fake_mux)

    job = await vnt.render_final_master(db, "vid_1", bucket, lesson_getter=_lesson_getter)
    assert job["render"]["state"] == jobs.S_COMPLETED
    assert job["render"]["result"]["mediaRef"].startswith("gridfs://sync_media/")
    assert job["render"]["result"]["mode"] == "replace"
    # Source video is never overwritten — provenance is tracked separately.
    assert job["render"]["result"]["sourceMediaRef"] == LESSON["mediaRef"]

    db.video_lessons.docs["vid_1"] = dict(LESSON)
    published = await vnt.publish_narration(db, "vid_1")
    lesson = await db.video_lessons.find_one({"lessonId": "vid_1"})
    assert lesson["aiNarrationMasterMediaRef"] == job["render"]["result"]["mediaRef"]
    assert published["published"] is True


@pytest.mark.asyncio
async def test_render_is_cost_safe_never_reruns_when_completed(monkeypatch):
    db = _FakeDB()
    bucket = await _assembled_job(db, monkeypatch)
    calls = []

    async def _counting_mux(video_bytes, video_ct, audio_bytes, *, treatment="mute"):
        calls.append(1)
        return await _fake_mux(video_bytes, video_ct, audio_bytes, treatment=treatment)

    monkeypatch.setattr(vnt.video_render_tools, "mux_narration_into_video", _counting_mux)
    await vnt.render_final_master(db, "vid_1", bucket, lesson_getter=_lesson_getter)
    await vnt.render_final_master(db, "vid_1", bucket, lesson_getter=_lesson_getter)
    assert len(calls) == 1


@pytest.mark.asyncio
async def test_reset_render_allows_a_genuinely_fresh_render_without_new_elevenlabs_calls(monkeypatch):
    """The safe re-render path: after a fix changes what assembly produces
    (e.g. corrected timing/clean transcript), the admin must be able to
    force a fresh mux WITHOUT paying for ElevenLabs again — reset_render
    only clears the render stage; every per-line audio asset is reused
    as-is."""
    db = _FakeDB()
    bucket = await _assembled_job(db, monkeypatch)
    elevenlabs_calls = []

    class _CountingClient(_FakeElevenLabsClient):
        async def post(self, url, headers=None, json=None, **kwargs):
            elevenlabs_calls.append(1)
            return await super().post(url, headers=headers, json=json, **kwargs)

    mux_calls = []

    async def _counting_mux(video_bytes, video_ct, audio_bytes, *, treatment="mute"):
        mux_calls.append(1)
        return await _fake_mux(video_bytes, video_ct, audio_bytes, treatment=treatment)

    monkeypatch.setattr(vnt.video_render_tools, "mux_narration_into_video", _counting_mux)
    await vnt.render_final_master(db, "vid_1", bucket, lesson_getter=_lesson_getter)
    assert len(mux_calls) == 1

    job = await vnt.reset_render(db, "vid_1")
    assert job["render"]["state"] == jobs.S_PENDING

    await vnt.render_final_master(db, "vid_1", bucket, lesson_getter=_lesson_getter)
    assert len(mux_calls) == 2  # a genuinely fresh mux ran
    assert elevenlabs_calls == []  # no ElevenLabs re-spend — audio assets reused as-is


@pytest.mark.asyncio
async def test_reset_render_refuses_when_nothing_has_been_rendered_yet():
    db = _FakeDB()
    await jobs.get_or_create_job(db, "vid_1")
    with pytest.raises(vnt.VideoNarrationError) as exc:
        await vnt.reset_render(db, "vid_1")
    assert exc.value.code == "nothing_to_reset"


@pytest.mark.asyncio
async def test_render_fails_terminal_when_ffmpeg_unavailable(monkeypatch):
    db = _FakeDB()
    bucket = await _assembled_job(db, monkeypatch)

    async def _unavailable_mux(video_bytes, video_ct, audio_bytes, *, treatment="mute"):
        raise vnt.video_render_tools.RenderError("ffmpeg_unavailable", "ffmpeg not found", 503)

    monkeypatch.setattr(vnt.video_render_tools, "mux_narration_into_video", _unavailable_mux)
    job = await vnt.render_final_master(db, "vid_1", bucket, lesson_getter=_lesson_getter)
    assert job["render"]["state"] == jobs.S_FAILED_TERMINAL
    assert "ffmpeg" in job["render"]["lastError"].lower()


@pytest.mark.asyncio
async def test_render_fails_retryable_on_a_transient_render_error(monkeypatch):
    db = _FakeDB()
    bucket = await _assembled_job(db, monkeypatch)

    async def _failing_mux(video_bytes, video_ct, audio_bytes, *, treatment="mute"):
        raise vnt.video_render_tools.RenderError("ffmpeg_failed", "exit code 1", 500)

    monkeypatch.setattr(vnt.video_render_tools, "mux_narration_into_video", _failing_mux)
    job = await vnt.render_final_master(db, "vid_1", bucket, lesson_getter=_lesson_getter)
    assert job["render"]["state"] == jobs.S_FAILED_RETRYABLE


@pytest.mark.asyncio
async def test_unpublish_clears_master_ref_without_destroying_the_render(monkeypatch):
    db = _FakeDB()
    bucket = await _assembled_job(db, monkeypatch)
    monkeypatch.setattr(vnt.video_render_tools, "mux_narration_into_video", _fake_mux)
    await vnt.render_final_master(db, "vid_1", bucket, lesson_getter=_lesson_getter)
    db.video_lessons.docs["vid_1"] = dict(LESSON)
    await vnt.publish_narration(db, "vid_1")

    await vnt.unpublish_narration(db, "vid_1")
    lesson = await db.video_lessons.find_one({"lessonId": "vid_1"})
    assert not lesson.get("aiNarrationMasterMediaRef")
    job = await jobs.get_or_create_job(db, "vid_1")
    assert job["render"]["state"] == jobs.S_COMPLETED  # the rendered file itself is untouched


# ── Source audio treatment (mute/duck/preserve — whole-track only) ────────
@pytest.mark.asyncio
async def test_new_job_defaults_source_audio_treatment_to_mute():
    db = _FakeDB()
    job = await jobs.get_or_create_job(db, "vid_1")
    assert job["sourceAudioTreatment"] == "mute"


@pytest.mark.asyncio
async def test_set_source_audio_treatment_persists_a_valid_choice():
    db = _FakeDB()
    await jobs.get_or_create_job(db, "vid_1")
    job = await vnt.set_source_audio_treatment(db, "vid_1", "duck")
    assert job["sourceAudioTreatment"] == "duck"


@pytest.mark.asyncio
async def test_set_source_audio_treatment_rejects_unknown_value():
    db = _FakeDB()
    await jobs.get_or_create_job(db, "vid_1")
    with pytest.raises(vnt.VideoNarrationError) as exc:
        await vnt.set_source_audio_treatment(db, "vid_1", "surgical_remove")
    assert exc.value.code == "invalid_treatment"
    job = await jobs.get_or_create_job(db, "vid_1")
    assert job["sourceAudioTreatment"] == "mute"  # rejected — unchanged


@pytest.mark.asyncio
async def test_render_passes_the_chosen_treatment_through_to_mux(monkeypatch):
    db = _FakeDB()
    bucket = await _assembled_job(db, monkeypatch)
    await vnt.set_source_audio_treatment(db, "vid_1", "preserve")
    seen = {}

    async def _capturing_mux(video_bytes, video_ct, audio_bytes, *, treatment="mute"):
        seen["treatment"] = treatment
        return await _fake_mux(video_bytes, video_ct, audio_bytes, treatment=treatment)

    monkeypatch.setattr(vnt.video_render_tools, "mux_narration_into_video", _capturing_mux)
    job = await vnt.render_final_master(db, "vid_1", bucket, lesson_getter=_lesson_getter)
    assert seen["treatment"] == "preserve"
    assert job["render"]["result"]["sourceAudioTreatment"] == "preserve"


@pytest.mark.asyncio
async def test_render_defaults_to_mute_when_treatment_never_set(monkeypatch):
    db = _FakeDB()
    bucket = await _assembled_job(db, monkeypatch)
    seen = {}

    async def _capturing_mux(video_bytes, video_ct, audio_bytes, *, treatment="mute"):
        seen["treatment"] = treatment
        return await _fake_mux(video_bytes, video_ct, audio_bytes, treatment=treatment)

    monkeypatch.setattr(vnt.video_render_tools, "mux_narration_into_video", _capturing_mux)
    await vnt.render_final_master(db, "vid_1", bucket, lesson_getter=_lesson_getter)
    assert seen["treatment"] == "mute"


# ── Per-scene SFX generation (real ElevenLabs Sound Effects endpoint) ─────
class _FakeSfxClient:
    """Simulates POST /v1/sound-generation — raw audio bytes back, no
    per-character alignment (there is none for a sound effect)."""
    def __init__(self, status_code=200):
        self.calls = []
        self.status_code = status_code

    async def post(self, url, headers=None, json=None, **kwargs):
        self.calls.append((url, json))
        if self.status_code != 200:
            return _FakeHttpResponse(self.status_code, text="provider error")
        return _FakeHttpResponse(200, content=f"sfx-for:{json['text']}".encode())


async def _job_with_sfx_scene(db, monkeypatch, *, sfx_text="a door creaks open"):
    bucket = _FakeMediaBucket()
    _fake_bucket_patch(monkeypatch, bucket)
    await bucket.upload_from_stream("vid_1.mp4", __import__("io").BytesIO(b"fake-video"), {"contentType": "video/mp4"})
    job = await vnt.run_story_analysis(db, "vid_1", bucket, lesson_getter=_lesson_getter, sync_getter=_sync_getter)
    scene_id = job["storyAnalysis"]["result"]["scenes"][0]["sceneId"]
    doc = db.video_narration_jobs.docs["vid_1"]
    doc["storyAnalysis"]["result"]["scenes"][0]["audioObservations"]["sfx"] = sfx_text
    return scene_id


@pytest.mark.asyncio
async def test_generate_scene_sfx_requires_story_analysis_first():
    db = _FakeDB()
    await jobs.get_or_create_job(db, "vid_1")
    with pytest.raises(vnt.VideoNarrationError) as exc:
        await vnt.generate_scene_sfx(db, "vid_1", "sc_1")
    assert exc.value.code == "no_story_yet"


@pytest.mark.asyncio
async def test_generate_scene_sfx_fails_honestly_when_gemini_reported_no_sfx(monkeypatch):
    db = _FakeDB()
    bucket = _FakeMediaBucket()
    _fake_bucket_patch(monkeypatch, bucket)
    await bucket.upload_from_stream("vid_1.mp4", __import__("io").BytesIO(b"fake-video"), {"contentType": "video/mp4"})
    job = await vnt.run_story_analysis(db, "vid_1", bucket, lesson_getter=_lesson_getter, sync_getter=_sync_getter)
    scene_id = job["storyAnalysis"]["result"]["scenes"][0]["sceneId"]

    with pytest.raises(vnt.VideoNarrationError) as exc:
        await vnt.generate_scene_sfx(db, "vid_1", scene_id)
    assert exc.value.code == "no_sfx_description"


@pytest.mark.asyncio
async def test_generate_scene_sfx_happy_path_stores_audio_and_completes(monkeypatch):
    db = _FakeDB()
    scene_id = await _job_with_sfx_scene(db, monkeypatch)
    client = _FakeSfxClient()
    monkeypatch.setenv("ELEVENLABS_API_KEY", "test-key")

    job = await vnt.generate_scene_sfx(db, "vid_1", scene_id, http_client=client)
    assert job["sfx"][scene_id]["state"] == jobs.S_COMPLETED
    assert job["sfx"][scene_id]["result"]["sourceText"] == "a door creaks open"
    assert job["sfx"][scene_id]["result"]["provider"] == "elevenlabs"
    assert len(client.calls) == 1


@pytest.mark.asyncio
async def test_generate_scene_sfx_is_cost_safe_never_reruns_when_completed(monkeypatch):
    db = _FakeDB()
    scene_id = await _job_with_sfx_scene(db, monkeypatch)
    client = _FakeSfxClient()
    monkeypatch.setenv("ELEVENLABS_API_KEY", "test-key")

    await vnt.generate_scene_sfx(db, "vid_1", scene_id, http_client=client)
    await vnt.generate_scene_sfx(db, "vid_1", scene_id, http_client=client)
    assert len(client.calls) == 1


@pytest.mark.asyncio
async def test_generate_scene_sfx_fails_terminal_without_api_key(monkeypatch):
    db = _FakeDB()
    scene_id = await _job_with_sfx_scene(db, monkeypatch)

    job = await vnt.generate_scene_sfx(db, "vid_1", scene_id, http_client=_FakeSfxClient())
    assert job["sfx"][scene_id]["state"] == jobs.S_FAILED_TERMINAL


@pytest.mark.asyncio
async def test_generate_scene_sfx_fails_retryable_on_provider_rejection(monkeypatch):
    db = _FakeDB()
    scene_id = await _job_with_sfx_scene(db, monkeypatch)
    monkeypatch.setenv("ELEVENLABS_API_KEY", "test-key")

    job = await vnt.generate_scene_sfx(db, "vid_1", scene_id, http_client=_FakeSfxClient(status_code=400))
    assert job["sfx"][scene_id]["state"] == jobs.S_FAILED_RETRYABLE


def test_narration_music_status_is_honestly_unsupported():
    status = vnt.narration_music_status()
    assert status["supported"] is False
    assert "reason" in status


def test_narration_sfx_status_reports_the_real_endpoint():
    status = vnt.narration_sfx_status()
    assert status == {"supported": True, "provider": "elevenlabs", "endpoint": "sound-generation"}


# ── Audio timeline (read-only, structured reconstruction) ─────────────────
@pytest.mark.asyncio
async def test_build_audio_timeline_empty_before_any_script_exists():
    db = _FakeDB()
    job = await jobs.get_or_create_job(db, "vid_1")
    timeline = vnt.build_audio_timeline(job)
    assert timeline["tracks"] == []
    assert timeline["totalDurationSec"] is None
    assert timeline["sourceAudio"]["treatment"] == "mute"


@pytest.mark.asyncio
async def test_build_audio_timeline_reports_null_offsets_until_lines_are_generated(monkeypatch):
    db = _FakeDB()
    bucket, scene_id, line_id = await _job_with_script(db, monkeypatch)
    job = await jobs.get_or_create_job(db, "vid_1")

    timeline = vnt.build_audio_timeline(job)
    assert len(timeline["tracks"]) == 1
    assert timeline["tracks"][0]["generationStatus"] == "pending"
    assert timeline["tracks"][0]["start"] is None
    assert timeline["totalDurationSec"] is None


@pytest.mark.asyncio
async def test_build_audio_timeline_computes_real_cumulative_offsets_once_generated(monkeypatch):
    db = _FakeDB()
    bucket, scene_id, line_id = await _job_with_script(db, monkeypatch)
    monkeypatch.setenv("ELEVENLABS_API_KEY", "test-key")
    await vnt.set_voice_assignments(db, "vid_1", {"Narrator": "voice_1"})
    client = _FakeElevenLabsClient()
    job = await vnt.generate_line_voice(db, "vid_1", scene_id, line_id, http_client=client)

    timeline = vnt.build_audio_timeline(job)
    track = timeline["tracks"][0]
    assert track["generationStatus"] == "completed"
    assert track["start"] == 0.0
    assert track["duration"] == job["voiceProduction"][scene_id]["lines"][line_id]["result"]["durationSec"]
    assert track["end"] == track["duration"]
    assert timeline["totalDurationSec"] == track["duration"]
    assert track["role"] == "narrator"
    assert track["treatment"] == "add"
    assert track["provenance"] == "ai"


@pytest.mark.asyncio
async def test_build_audio_timeline_includes_sfx_entries_without_fabricated_placement(monkeypatch):
    db = _FakeDB()
    scene_id = await _job_with_sfx_scene(db, monkeypatch)
    monkeypatch.setenv("ELEVENLABS_API_KEY", "test-key")
    await vnt.generate_scene_sfx(db, "vid_1", scene_id, http_client=_FakeSfxClient())
    job = await jobs.get_or_create_job(db, "vid_1")

    timeline = vnt.build_audio_timeline(job)
    sfx_tracks = [t for t in timeline["tracks"] if t["role"] == "sfx"]
    assert len(sfx_tracks) == 1
    assert sfx_tracks[0]["sceneId"] == scene_id
    assert sfx_tracks[0]["generationStatus"] == "completed"
    assert sfx_tracks[0]["start"] is None  # not wired into placement/timing yet — never fabricated


@pytest.mark.asyncio
async def test_build_audio_timeline_reflects_source_audio_treatment_choice():
    db = _FakeDB()
    await jobs.get_or_create_job(db, "vid_1")
    await vnt.set_source_audio_treatment(db, "vid_1", "duck")
    job = await jobs.get_or_create_job(db, "vid_1")

    timeline = vnt.build_audio_timeline(job)
    assert timeline["sourceAudio"] == {"treatment": "duck", "provenance": "original"}


# ── SFX mixed into the assembled narration track (real production wiring) ─
@pytest.mark.asyncio
async def test_assembly_mixes_a_completed_sfx_asset_into_the_narration_track(monkeypatch):
    db = _FakeDB()
    bucket, scene_id, line_id = await _job_with_script(db, monkeypatch)
    monkeypatch.setenv("ELEVENLABS_API_KEY", "test-key")
    await vnt.set_voice_assignments(db, "vid_1", {"Narrator": "voice_1"})
    await vnt.generate_line_voice(db, "vid_1", scene_id, line_id, http_client=_FakeElevenLabsClient())

    doc = db.video_narration_jobs.docs["vid_1"]
    doc["storyAnalysis"]["result"]["scenes"][0]["audioObservations"]["sfx"] = "a bell rings"
    await vnt.generate_scene_sfx(db, "vid_1", scene_id, http_client=_FakeSfxClient())

    mixed_calls = []

    async def _fake_overlay(base, overlay, offset, **kwargs):
        mixed_calls.append((base, overlay, offset))
        return base + b":mixed:" + overlay

    monkeypatch.setattr(vnt.video_render_tools, "overlay_audio_at_offset", _fake_overlay)
    job = await vnt.assemble_narration_track(db, "vid_1")

    assert job["assembly"]["result"]["sfxMixed"] == [scene_id]
    assert job["assembly"]["result"]["sfxSkipped"] == []
    assert len(mixed_calls) == 1
    assert mixed_calls[0][2] == 0.0  # the scene's only line starts at cursor 0


@pytest.mark.asyncio
async def test_assembly_skips_an_sfx_asset_whose_scene_has_no_narration_line(monkeypatch):
    db = _FakeDB()
    bucket, scene_id, line_id = await _job_with_script(db, monkeypatch)
    monkeypatch.setenv("ELEVENLABS_API_KEY", "test-key")
    await vnt.set_voice_assignments(db, "vid_1", {"Narrator": "voice_1"})
    await vnt.generate_line_voice(db, "vid_1", scene_id, line_id, http_client=_FakeElevenLabsClient())

    doc = db.video_narration_jobs.docs["vid_1"]
    doc["sfx"] = {"sc_orphan": {"state": jobs.S_COMPLETED, "result": {"mediaRef": "gridfs://sync_media/orphan.mp3"}}}

    job = await vnt.assemble_narration_track(db, "vid_1")
    assert job["assembly"]["result"]["sfxMixed"] == []
    assert job["assembly"]["result"]["sfxSkipped"] == [
        {"sceneId": "sc_orphan", "reason": "scene has no narration line to anchor timing to"},
    ]


@pytest.mark.asyncio
async def test_assembly_never_fails_when_sfx_mixing_hits_a_render_error(monkeypatch):
    db = _FakeDB()
    bucket, scene_id, line_id = await _job_with_script(db, monkeypatch)
    monkeypatch.setenv("ELEVENLABS_API_KEY", "test-key")
    await vnt.set_voice_assignments(db, "vid_1", {"Narrator": "voice_1"})
    await vnt.generate_line_voice(db, "vid_1", scene_id, line_id, http_client=_FakeElevenLabsClient())

    doc = db.video_narration_jobs.docs["vid_1"]
    doc["storyAnalysis"]["result"]["scenes"][0]["audioObservations"]["sfx"] = "a bell rings"
    await vnt.generate_scene_sfx(db, "vid_1", scene_id, http_client=_FakeSfxClient())

    async def _unavailable_overlay(base, overlay, offset, **kwargs):
        raise vnt.video_render_tools.RenderError("ffmpeg_unavailable", "ffmpeg not found", 503)

    monkeypatch.setattr(vnt.video_render_tools, "overlay_audio_at_offset", _unavailable_overlay)
    job = await vnt.assemble_narration_track(db, "vid_1")

    assert job["assembly"]["state"] == jobs.S_COMPLETED  # SFX mixing failure never blocks assembly
    assert job["assembly"]["result"]["sfxSkipped"] == [{"sceneId": scene_id, "reason": "ffmpeg not found"}]


@pytest.mark.asyncio
async def test_assembly_with_no_sfx_reports_empty_mixed_and_skipped_lists(monkeypatch):
    db = _FakeDB()
    bucket = await _assembled_job(db, monkeypatch)
    job = await jobs.get_or_create_job(db, "vid_1")
    assert job["assembly"]["result"]["sfxMixed"] == []
    assert job["assembly"]["result"]["sfxSkipped"] == []


@pytest.mark.asyncio
async def test_build_audio_timeline_reports_real_sfx_start_once_its_scene_narration_is_generated(monkeypatch):
    db = _FakeDB()
    bucket, scene_id, line_id = await _job_with_script(db, monkeypatch)
    monkeypatch.setenv("ELEVENLABS_API_KEY", "test-key")
    await vnt.set_voice_assignments(db, "vid_1", {"Narrator": "voice_1"})
    await vnt.generate_line_voice(db, "vid_1", scene_id, line_id, http_client=_FakeElevenLabsClient())

    doc = db.video_narration_jobs.docs["vid_1"]
    doc["storyAnalysis"]["result"]["scenes"][0]["audioObservations"]["sfx"] = "a bell rings"
    await vnt.generate_scene_sfx(db, "vid_1", scene_id, http_client=_FakeSfxClient())

    job = await jobs.get_or_create_job(db, "vid_1")
    timeline = vnt.build_audio_timeline(job)
    sfx_track = next(t for t in timeline["tracks"] if t["role"] == "sfx")
    assert sfx_track["start"] == 0.0  # the scene's only (now-generated) line starts at 0


# ── Real end-to-end production pipeline (genuine ffmpeg media throughout) ─
NO_FFMPEG_E2E = not vnt.video_render_tools.ffmpeg_available()
NO_FFPROBE_E2E = not vnt.video_render_tools.ffprobe_available()


async def _make_real_media(*, kind: str, duration: float = 0.4) -> bytes:
    """Generates genuinely real, playable media via ffmpeg lavfi sources —
    no fixtures checked into the repo, no fake byte strings — so every
    downstream mixing/muxing step in the e2e test below operates on real
    audio/video, and every claim of "the master has an embedded audio
    stream" is verified with real ffprobe rather than assumed."""
    import os
    import tempfile
    import uuid

    vrt = vnt.video_render_tools
    work_id = uuid.uuid4().hex
    if kind == "video_with_audio":
        path = os.path.join(tempfile.gettempdir(), f"vnt_e2e_{work_id}.mp4")
        args = [
            "ffmpeg", "-y",
            "-f", "lavfi", "-i", f"color=c=red:s=64x64:d={duration}",
            "-f", "lavfi", "-i", f"sine=frequency=220:duration={duration}",
            "-c:v", "libx264", "-pix_fmt", "yuv420p", "-c:a", "aac", "-shortest", path,
        ]
    elif kind == "audio":
        path = os.path.join(tempfile.gettempdir(), f"vnt_e2e_{work_id}.mp3")
        args = ["ffmpeg", "-y", "-f", "lavfi", "-i", f"sine=frequency=440:duration={duration}",
                "-c:a", "libmp3lame", path]
    else:
        raise ValueError(kind)
    loop = asyncio.get_running_loop()
    await loop.run_in_executor(vrt._executor, vrt._run_blocking, tuple(args), 30.0)
    with open(path, "rb") as f:
        data = f.read()
    os.remove(path)
    return data


class _RealAudioElevenLabsClient:
    """Same request/response SHAPE as _FakeElevenLabsClient (so the real
    reshape/alignment code is exercised identically), but returns a
    genuinely real, playable audio clip instead of an arbitrary byte
    string — required so this test's downstream real-ffmpeg mixing/muxing
    has real audio to operate on."""
    def __init__(self, audio_bytes: bytes):
        self._audio_bytes = audio_bytes
        self.calls = []

    async def post(self, url, headers=None, json=None, **kwargs):
        self.calls.append((url, json))
        text = json["text"]
        chars = list(text)
        starts = [i * 0.05 for i in range(len(chars))]
        ends = [(i + 1) * 0.05 for i in range(len(chars))]
        return _FakeHttpResponse(200, {
            "audio_base64": base64.b64encode(self._audio_bytes).decode(),
            "alignment": {"characters": chars, "character_start_times_seconds": starts,
                          "character_end_times_seconds": ends},
        })


class _RealSfxClient:
    def __init__(self, audio_bytes: bytes):
        self._audio_bytes = audio_bytes
        self.calls = []

    async def post(self, url, headers=None, json=None, **kwargs):
        self.calls.append((url, json))
        return _FakeHttpResponse(200, content=self._audio_bytes)


@pytest.mark.skipif(NO_FFMPEG_E2E or NO_FFPROBE_E2E, reason="ffmpeg/ffprobe not installed in this environment")
@pytest.mark.asyncio
async def test_real_end_to_end_production_pipeline_with_genuine_ffmpeg_media(monkeypatch):
    """One real, continuous pass through the ENTIRE production chain this
    module owns: story analysis -> script -> voice assignment -> per-line
    ElevenLabs generation -> SFX generation -> automatic timeline placement
    -> source-audio treatment -> assembly (real SFX mix) -> final render
    (real mux) -> publish. Gemini/ElevenLabs themselves are NOT live-called
    (no credentials in this environment — mock story/script generation and
    fake HTTP clients stand in for them, exactly as every other test in
    this file already does), but every byte of audio/video touched from
    that point on is genuine ffmpeg output, and every "it worked" claim is
    checked with real ffprobe, never assumed from a function simply
    returning without raising."""
    db = _FakeDB()
    bucket = _FakeMediaBucket()
    _fake_bucket_patch(monkeypatch, bucket)

    source_video = await _make_real_media(kind="video_with_audio", duration=0.6)
    await bucket.upload_from_stream("vid_1.mp4", __import__("io").BytesIO(source_video), {"contentType": "video/mp4"})

    job = await vnt.run_story_analysis(db, "vid_1", bucket, lesson_getter=_lesson_getter, sync_getter=_sync_getter)
    assert job["storyAnalysis"]["state"] == jobs.S_COMPLETED
    scene_id = job["storyAnalysis"]["result"]["scenes"][0]["sceneId"]
    db.video_narration_jobs.docs["vid_1"]["storyAnalysis"]["result"]["scenes"][0]["audioObservations"]["sfx"] = "a soft chime"

    job = await vnt.run_script_blueprint(db, "vid_1", lesson_getter=_lesson_getter, sync_getter=_sync_getter)
    assert job["scriptBlueprint"]["state"] == jobs.S_COMPLETED
    line_id = job["scriptBlueprint"]["result"]["scenes"][0]["lines"][0]["lineId"]

    monkeypatch.setenv("ELEVENLABS_API_KEY", "test-key")
    await vnt.set_voice_assignments(db, "vid_1", {"Narrator": "voice_1"})
    narration_clip = await _make_real_media(kind="audio", duration=0.5)
    job = await vnt.generate_line_voice(db, "vid_1", scene_id, line_id,
                                         http_client=_RealAudioElevenLabsClient(narration_clip))
    assert job["voiceProduction"][scene_id]["lines"][line_id]["state"] == jobs.S_COMPLETED

    sfx_clip = await _make_real_media(kind="audio", duration=0.2)
    job = await vnt.generate_scene_sfx(db, "vid_1", scene_id, http_client=_RealSfxClient(sfx_clip))
    assert job["sfx"][scene_id]["state"] == jobs.S_COMPLETED
    assert job["sfx"][scene_id]["result"]["durationSec"] is not None  # real ffprobe measurement

    timeline = vnt.build_audio_timeline(job)
    narration_track = next(t for t in timeline["tracks"] if t["role"] == "narrator")
    sfx_track = next(t for t in timeline["tracks"] if t["role"] == "sfx")
    assert narration_track["start"] == 0.0
    assert sfx_track["start"] == 0.0  # same scene, automatically anchored to the same offset

    job = await vnt.set_source_audio_treatment(db, "vid_1", "duck")
    assert job["sourceAudioTreatment"] == "duck"

    job = await vnt.assemble_narration_track(db, "vid_1")
    assert job["assembly"]["state"] == jobs.S_COMPLETED
    assert job["assembly"]["result"]["sfxMixed"] == [scene_id]
    assembled_bytes, _ct = await vnt.video_pipeline_tools.load_media_bytes(
        db, bucket, job["assembly"]["result"]["mediaRef"],
    )
    assert await vnt.video_render_tools.probe_audio_duration_seconds(assembled_bytes) is not None

    job = await vnt.render_final_master(db, "vid_1", bucket, lesson_getter=_lesson_getter)
    assert job["render"]["state"] == jobs.S_COMPLETED
    master_ref = job["render"]["result"]["mediaRef"]
    master_bytes, _ct = await vnt.video_pipeline_tools.load_media_bytes(db, bucket, master_ref)
    assert len(master_bytes) > 0
    assert await vnt.video_render_tools.probe_has_audio_stream(master_bytes) is True

    db.video_lessons.docs["vid_1"] = dict(LESSON)
    published = await vnt.publish_narration(db, "vid_1")
    lesson = await db.video_lessons.find_one({"lessonId": "vid_1"})
    assert lesson["aiNarrationMasterMediaRef"] == master_ref
    assert published["published"] is True


@pytest.mark.skipif(NO_FFMPEG_E2E or NO_FFPROBE_E2E, reason="ffmpeg/ffprobe not installed in this environment")
@pytest.mark.asyncio
async def test_real_multi_scene_narration_is_anchored_to_real_scene_start_times(monkeypatch):
    """The production-grade correction this test exists to prove: two
    scenes with a real visual GAP between them (scene 2 doesn't start on
    screen until well after scene 1's narration finishes speaking) must
    result in scene 2's narration actually landing at scene 2's real
    start time in the assembled audio — not immediately after scene 1's
    narration ends. Verified with genuine ffmpeg-generated audio and real
    ffprobe duration measurement, not just asserted numbers."""
    db = _FakeDB()
    bucket = _FakeMediaBucket()
    _fake_bucket_patch(monkeypatch, bucket)
    await bucket.upload_from_stream("vid_1.mp4", __import__("io").BytesIO(b"fake-video"), {"contentType": "video/mp4"})

    # Scene 1: 0.0s-1.0s on screen. Scene 2 doesn't begin until 3.0s — a
    # real 2s+ visual gap (e.g. a transition/pause) the narration must
    # respect rather than just picking up immediately where scene 1 left off.
    story_analysis = {
        "summary": "s", "narrativeArc": "a", "characters": [],
        "scenes": [
            {"sceneId": "sc1", "start": 0.0, "end": 1.0, "title": "Opening", "description": "d",
             "characters": [], "speakers": ["S1"], "narrativeRole": "setup",
             "audioObservations": {"dialogue": "", "music": "", "ambience": "", "sfx": ""},
             "emotionalContext": "", "visualEvents": [], "confidence": None},
            {"sceneId": "sc2", "start": 3.0, "end": 5.0, "title": "Later", "description": "d",
             "characters": [], "speakers": ["S1"], "narrativeRole": "development",
             "audioObservations": {"dialogue": "", "music": "", "ambience": "", "sfx": ""},
             "emotionalContext": "", "visualEvents": [], "confidence": None},
        ],
        "generatedAt": vnt._now(), "engine": "gemini",
    }

    async def _fake_analyze_story(*a, **k):
        return {"ok": True, "storyAnalysis": story_analysis, "engine": "gemini"}

    monkeypatch.setattr(vnt.video_ai_provider, "analyze_story", _fake_analyze_story)
    job = await vnt.run_story_analysis(db, "vid_1", bucket, lesson_getter=_lesson_getter, sync_getter=_sync_getter)
    assert job["storyAnalysis"]["state"] == jobs.S_COMPLETED

    script_blueprint = {
        "scenes": [
            {"sceneId": "sc1", "lines": [{"lineId": "ln1", "speaker": "Narrator", "text": "Scene one begins.", "emotion": ""}]},
            {"sceneId": "sc2", "lines": [{"lineId": "ln2", "speaker": "Narrator", "text": "Scene two begins.", "emotion": ""}]},
        ],
        "generatedAt": vnt._now(), "engine": "gemini",
    }

    async def _fake_draft_script(*a, **k):
        return {"ok": True, "scriptBlueprint": script_blueprint, "engine": "gemini"}

    monkeypatch.setattr(vnt.video_ai_provider, "draft_script_blueprint", _fake_draft_script)
    job = await vnt.run_script_blueprint(db, "vid_1", lesson_getter=_lesson_getter, sync_getter=_sync_getter)
    assert job["scriptBlueprint"]["state"] == jobs.S_COMPLETED

    monkeypatch.setenv("ELEVENLABS_API_KEY", "test-key")
    await vnt.set_voice_assignments(db, "vid_1", {"Narrator": "voice_1"})

    # Both narration lines are short (0.4s) — scene 1's narration finishes
    # at t=0.4, well before scene 2's real visual start at t=3.0. Without
    # scene anchoring, scene 2's narration would start speaking at t=0.4.
    clip1 = await _make_real_media(kind="audio", duration=0.4)
    job = await vnt.generate_line_voice(db, "vid_1", "sc1", "ln1", http_client=_RealAudioElevenLabsClient(clip1))
    assert job["voiceProduction"]["sc1"]["lines"]["ln1"]["state"] == jobs.S_COMPLETED

    clip2 = await _make_real_media(kind="audio", duration=0.4)
    job = await vnt.generate_line_voice(db, "vid_1", "sc2", "ln2", http_client=_RealAudioElevenLabsClient(clip2))
    assert job["voiceProduction"]["sc2"]["lines"]["ln2"]["state"] == jobs.S_COMPLETED

    job = await vnt.assemble_narration_track(db, "vid_1")
    assert job["assembly"]["state"] == jobs.S_COMPLETED

    # _RealAudioElevenLabsClient (see its docstring above) fabricates
    # alignment timing from TEXT LENGTH (0.05s/char) — decoupled from the
    # real ffmpeg clip's actual playtime, since no real ElevenLabs call is
    # made. In real production usage the alignment always matches the real
    # audio it was measured from; here, computing the expected cursor the
    # SAME way durationSec is actually derived (word_timestamps[-1]["end"])
    # keeps this assertion honest rather than guessing a number.
    line1_duration = len("Scene one begins.") * 0.05
    line2_duration = len("Scene two begins.") * 0.05

    # Honest record of the timing decision actually made.
    timing_notes = job["assembly"]["result"]["sceneTiming"]
    sc2_note = next(n for n in timing_notes if n["sceneId"] == "sc2")
    assert sc2_note["paddedSec"] == pytest.approx(3.0 - line1_duration, abs=0.2)

    # Real audio proof: the assembled track's ACTUAL playable duration must
    # be unmistakably longer than the two real clips played back-to-back —
    # proof that genuine silence bytes were spliced in, not just numbers
    # changed in the sync document. (The exact total isn't asserted against
    # line1_duration/line2_duration precisely: those are the FAKE
    # alignment's text-length-derived durations, which this fixture uses
    # to decide the gap size — real ElevenLabs always measures duration
    # from the real audio it generated, so this mismatch is a test-fixture
    # artifact, never a product behavior.)
    real_clip1_duration = await vnt.video_render_tools.probe_audio_duration_seconds(clip1)
    real_clip2_duration = await vnt.video_render_tools.probe_audio_duration_seconds(clip2)
    assembled_bytes, _ct = await vnt.video_pipeline_tools.load_media_bytes(
        db, bucket, job["assembly"]["result"]["mediaRef"],
    )
    total_duration = await vnt.video_render_tools.probe_audio_duration_seconds(assembled_bytes)
    assert total_duration > real_clip1_duration + real_clip2_duration + 1.0

    # Karaoke proof: scene 2's line's word timestamps are absolute against
    # the REAL assembled timeline — the sync document must place them
    # around t=3.0, not t=0.4.
    sync_doc = await db.chapter_sync.find_one({"syncId": job["assembly"]["result"]["syncId"]})
    sentences = sync_doc["paragraphs"][0]["sentences"]
    scene2_sentence = sentences[1]  # sc1's line assembled first, sc2's second
    assert scene2_sentence["words"][0]["start"] == pytest.approx(3.0, abs=0.2)


# ── Stage watchdog — root-cause fix for a job stuck forever in "claimed"/
# "provider_pending" ("Processing" in the UI, no retry button available)
# if the awaited provider call never resolves (stalled connection, worker
# restart mid-flight) — the exact same incident class already fixed once
# in video_pipeline_tools.py's PIPELINE_TIMEOUT_S. ───────────────────────
@pytest.mark.asyncio
async def test_story_analysis_timeout_fails_retryable_not_stuck_forever(monkeypatch):
    db = _FakeDB()
    bucket = _FakeMediaBucket()
    _fake_bucket_patch(monkeypatch, bucket)
    await bucket.upload_from_stream("vid_1.mp4", __import__("io").BytesIO(b"fake-video"), {"contentType": "video/mp4"})
    monkeypatch.setattr(vnt, "STAGE_TIMEOUT_S", 0.05)

    async def _hangs(*a, **k):
        await asyncio.sleep(3600)

    monkeypatch.setattr(vnt.video_ai_provider, "analyze_story", _hangs)

    job = await vnt.run_story_analysis(db, "vid_1", bucket, lesson_getter=_lesson_getter, sync_getter=_sync_getter)
    assert job["storyAnalysis"]["state"] == jobs.S_FAILED_RETRYABLE
    assert "timed out" in job["storyAnalysis"]["lastError"].lower()


@pytest.mark.asyncio
async def test_script_blueprint_timeout_fails_retryable_not_stuck_forever(monkeypatch):
    db = _FakeDB()
    bucket = _FakeMediaBucket()
    _fake_bucket_patch(monkeypatch, bucket)
    await bucket.upload_from_stream("vid_1.mp4", __import__("io").BytesIO(b"fake-video"), {"contentType": "video/mp4"})
    await vnt.run_story_analysis(db, "vid_1", bucket, lesson_getter=_lesson_getter, sync_getter=_sync_getter)
    monkeypatch.setattr(vnt, "STAGE_TIMEOUT_S", 0.05)

    async def _hangs(*a, **k):
        await asyncio.sleep(3600)

    monkeypatch.setattr(vnt.video_ai_provider, "draft_script_blueprint", _hangs)

    job = await vnt.run_script_blueprint(db, "vid_1", lesson_getter=_lesson_getter, sync_getter=_sync_getter)
    assert job["scriptBlueprint"]["state"] == jobs.S_FAILED_RETRYABLE
    assert "timed out" in job["scriptBlueprint"]["lastError"].lower()


@pytest.mark.asyncio
async def test_generate_line_voice_timeout_fails_retryable_not_stuck_forever(monkeypatch):
    db = _FakeDB()
    bucket, scene_id, line_id = await _job_with_script(db, monkeypatch)
    monkeypatch.setenv("ELEVENLABS_API_KEY", "test-key")
    await vnt.set_voice_assignments(db, "vid_1", {"Narrator": "voice_1"})
    monkeypatch.setattr(vnt, "STAGE_TIMEOUT_S", 0.05)

    class _HangingClient:
        async def post(self, url, headers=None, json=None, **kwargs):
            await asyncio.sleep(3600)

    job = await vnt.generate_line_voice(db, "vid_1", scene_id, line_id, http_client=_HangingClient())
    stage = job["voiceProduction"][scene_id]["lines"][line_id]
    assert stage["state"] == jobs.S_FAILED_RETRYABLE
    assert "timed out" in stage["lastError"].lower()


@pytest.mark.asyncio
async def test_generate_scene_sfx_timeout_fails_retryable_not_stuck_forever(monkeypatch):
    db = _FakeDB()
    scene_id = await _job_with_sfx_scene(db, monkeypatch)
    monkeypatch.setenv("ELEVENLABS_API_KEY", "test-key")
    monkeypatch.setattr(vnt, "STAGE_TIMEOUT_S", 0.05)

    class _HangingClient:
        async def post(self, url, headers=None, json=None, **kwargs):
            await asyncio.sleep(3600)

    job = await vnt.generate_scene_sfx(db, "vid_1", scene_id, http_client=_HangingClient())
    assert job["sfx"][scene_id]["state"] == jobs.S_FAILED_RETRYABLE
    assert "timed out" in job["sfx"][scene_id]["lastError"].lower()


@pytest.mark.asyncio
async def test_render_timeout_fails_retryable_not_stuck_forever(monkeypatch):
    db = _FakeDB()
    bucket = await _assembled_job(db, monkeypatch)
    monkeypatch.setattr(vnt, "STAGE_TIMEOUT_S", 0.05)

    async def _hangs(*a, **k):
        await asyncio.sleep(3600)

    monkeypatch.setattr(vnt.video_render_tools, "mux_narration_into_video", _hangs)

    job = await vnt.render_final_master(db, "vid_1", bucket, lesson_getter=_lesson_getter)
    assert job["render"]["state"] == jobs.S_FAILED_RETRYABLE
    assert "timed out" in job["render"]["lastError"].lower()
