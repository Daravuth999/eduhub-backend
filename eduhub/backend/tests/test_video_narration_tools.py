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

import sync_schema
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

    async def post(self, url, headers=None, json=None, params=None, **kwargs):
        self.calls.append((url, json, params))
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
    monkeypatch.delenv("ELEVENLABS_MODEL", raising=False)
    monkeypatch.delenv("VIDEO_NARRATION_VOICE", raising=False)
    monkeypatch.delenv("VIDEO_NARRATION_MODEL", raising=False)
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
    def test_short_acting_cue_accumulates_short_segments_up_to_the_budget(self):
        """Multiple short comma-separated descriptors should survive
        together, not just the very first one — "Warm" alone throws away
        useful direction that "Warm, reassuring tone" still keeps concise."""
        cue = vnt._short_acting_cue(
            "Warm, reassuring tone, highlighting Maya's understanding and empathy for Daniel's situation.",
        )
        assert cue == "Warm, reassuring tone"
        assert len(cue) <= 60

    def test_short_acting_cue_stops_before_a_segment_would_exceed_the_budget(self):
        cue = vnt._short_acting_cue("quiet, concerned, slightly breathless and visibly shaken throughout")
        assert cue.startswith("quiet, concerned")
        assert len(cue) <= 60
        # Never a mid-word truncation past the budget — every accepted
        # segment fit whole, or wasn't accepted at all.
        assert not cue.endswith(",")

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


# ── ElevenLabs production request shape ────────────────────────────────
class TestElevenlabsRequestShape:
    @pytest.mark.asyncio
    async def test_defaults_to_the_multilingual_model(self, monkeypatch):
        monkeypatch.setenv("ELEVENLABS_API_KEY", "test-key")
        client = _FakeElevenLabsClient()
        await vnt.elevenlabs_generate_line("Hello there.", "voice_1", http_client=client)
        assert client.calls[0][1]["model_id"] == "eleven_multilingual_v2"

    @pytest.mark.asyncio
    async def test_video_narration_model_overrides_the_default_without_touching_shared_var(self, monkeypatch):
        """VIDEO_NARRATION_MODEL is isolated from the shared ELEVENLABS_MODEL
        other EduHub systems (Book Factory/EduTalk) read — setting the
        shared var alone must NOT change narration's model."""
        monkeypatch.setenv("ELEVENLABS_API_KEY", "test-key")
        monkeypatch.setenv("ELEVENLABS_MODEL", "eleven_v3")
        client = _FakeElevenLabsClient()
        await vnt.elevenlabs_generate_line("Hello there.", "voice_1", http_client=client)
        assert client.calls[0][1]["model_id"] == "eleven_multilingual_v2"

        monkeypatch.setenv("VIDEO_NARRATION_MODEL", "eleven_v3")
        await vnt.elevenlabs_generate_line("Hello there.", "voice_1", http_client=client)
        assert client.calls[-1][1]["model_id"] == "eleven_v3"

    @pytest.mark.asyncio
    async def test_output_format_is_a_query_param_not_a_body_field(self, monkeypatch):
        """ElevenLabs' documented contract expects output_format as a query
        parameter — a body-embedded copy is silently ignored by the API."""
        monkeypatch.setenv("ELEVENLABS_API_KEY", "test-key")
        client = _FakeElevenLabsClient()
        await vnt.elevenlabs_generate_line("Hello there.", "voice_1", http_client=client)
        _url, body, params = client.calls[0]
        assert params == {"output_format": "mp3_44100_128"}
        assert "output_format" not in body

    @pytest.mark.asyncio
    async def test_speed_is_included_in_voice_settings(self, monkeypatch):
        monkeypatch.setenv("ELEVENLABS_API_KEY", "test-key")
        client = _FakeElevenLabsClient()
        await vnt.elevenlabs_generate_line(
            "Hello there.", "voice_1",
            voice_settings={"stability": 0.5, "similarity_boost": 0.78, "style": 0.42, "speed": 0.98},
            http_client=client,
        )
        vs = client.calls[0][1]["voice_settings"]
        assert vs["speed"] == 0.98
        assert vs["use_speaker_boost"] is True

    @pytest.mark.asyncio
    async def test_previous_and_next_text_are_included_when_provided(self, monkeypatch):
        monkeypatch.setenv("ELEVENLABS_API_KEY", "test-key")
        client = _FakeElevenLabsClient()
        await vnt.elevenlabs_generate_line(
            "He froze.", "voice_1", previous_text="The room went quiet.", next_text="No one moved.",
            http_client=client,
        )
        body = client.calls[0][1]
        assert body["previous_text"] == "The room went quiet."
        assert body["next_text"] == "No one moved."

    @pytest.mark.asyncio
    async def test_previous_and_next_text_are_omitted_when_empty(self, monkeypatch):
        """Never send empty/whitespace context — an omitted field, not a
        fabricated empty one."""
        monkeypatch.setenv("ELEVENLABS_API_KEY", "test-key")
        client = _FakeElevenLabsClient()
        await vnt.elevenlabs_generate_line("He froze.", "voice_1", previous_text="  ", next_text=None, http_client=client)
        body = client.calls[0][1]
        assert "previous_text" not in body
        assert "next_text" not in body

    @pytest.mark.asyncio
    async def test_context_text_is_never_spoken_only_the_real_text_is(self, monkeypatch):
        monkeypatch.setenv("ELEVENLABS_API_KEY", "test-key")
        client = _FakeElevenLabsClient()
        result = await vnt.elevenlabs_generate_line(
            "He froze.", "voice_1", previous_text="The room went quiet.", next_text="No one moved.",
            http_client=client,
        )
        spoken = " ".join(w["word"] for w in result["word_timestamps"])
        assert "quiet" not in spoken and "moved" not in spoken


# ── Scene-emotion voice-settings classifier ────────────────────────────
class TestSceneVoiceSettings:
    def test_reverent_scene_maps_to_reverent_settings(self):
        scene = {"emotionalContext": "A solemn, reverent moment as they bow their heads."}
        settings = vnt._scene_voice_settings(scene)
        assert settings == {"stability": 0.72, "similarity_boost": 0.80, "style": 0.20, "speed": 0.92}

    def test_joyful_scene_maps_to_joyful_settings(self):
        scene = {"narrativeRole": "celebration", "description": "Everyone laughs and cheers together."}
        settings = vnt._scene_voice_settings(scene)
        assert settings == {"stability": 0.38, "similarity_boost": 0.75, "style": 0.60, "speed": 1.05}

    def test_warm_family_scene_maps_to_warm_settings(self):
        scene = {"emotionalContext": "A warm, gentle family moment at home."}
        settings = vnt._scene_voice_settings(scene)
        assert settings == {"stability": 0.50, "similarity_boost": 0.78, "style": 0.42, "speed": 0.98}

    def test_closing_scene_maps_to_closing_settings(self):
        scene = {"narrativeRole": "resolution", "description": "A peaceful farewell as the story concludes."}
        settings = vnt._scene_voice_settings(scene)
        assert settings == {"stability": 0.68, "similarity_boost": 0.82, "style": 0.28, "speed": 0.90}

    def test_scene_with_no_emotional_signal_returns_none(self):
        scene = {"emotionalContext": "", "narrativeRole": "development", "title": "Scene 4", "description": "d"}
        assert vnt._scene_voice_settings(scene) is None

    def test_missing_scene_returns_none(self):
        assert vnt._scene_voice_settings(None) is None

    def test_every_row_respects_the_safety_bounds(self):
        """stability >= 0.30 and style <= 0.65 for every documented row —
        the safety bound the production spec requires."""
        for settings in vnt._SCENE_VOICE_SETTINGS.values():
            assert settings["stability"] >= 0.30
            assert settings["style"] <= 0.65


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
async def test_generate_line_voice_fails_terminal_without_an_api_key(monkeypatch):
    """No ELEVENLABS_API_KEY is the one thing that must still fail
    terminally — everything else (missing voice assignment) now has a
    real, safe fallback (see the default-storyteller-voice test below)."""
    db = _FakeDB()
    _bucket, scene_id, line_id = await _job_with_script(db, monkeypatch)
    job = await vnt.generate_line_voice(db, "vid_1", scene_id, line_id)
    path = f"voiceProduction.{scene_id}.lines.{line_id}"
    assert _get_dotted(job, path)["state"] == jobs.S_FAILED_TERMINAL


@pytest.mark.asyncio
async def test_generate_line_voice_falls_back_to_the_default_storyteller_voice(monkeypatch):
    """A lesson must never fail narration purely for lack of voice
    configuration — with no per-speaker assignment and no override env
    var, the approved default storyteller voice (Sarah) is used."""
    db = _FakeDB()
    bucket, scene_id, line_id = await _job_with_script(db, monkeypatch)
    monkeypatch.setenv("ELEVENLABS_API_KEY", "test-key")
    monkeypatch.delenv("VIDEO_NARRATION_VOICE", raising=False)
    client = _FakeElevenLabsClient()
    job = await vnt.generate_line_voice(db, "vid_1", scene_id, line_id, http_client=client)
    path = f"voiceProduction.{scene_id}.lines.{line_id}"
    stage = _get_dotted(job, path)
    assert stage["state"] == jobs.S_COMPLETED
    assert stage["result"]["voiceId"] == vnt.DEFAULT_STORYTELLER_VOICE_ID


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


async def _job_with_two_scenes(db, monkeypatch, *, scene1_emotional_context=""):
    bucket = _FakeMediaBucket()
    _fake_bucket_patch(monkeypatch, bucket)
    await bucket.upload_from_stream("vid_1.mp4", __import__("io").BytesIO(b"fake-video"), {"contentType": "video/mp4"})

    story_analysis = {
        "summary": "s", "narrativeArc": "a", "characters": [],
        "scenes": [
            {"sceneId": "sc1", "start": 0.0, "end": 5.0, "title": "Opening", "description": "d",
             "characters": [], "speakers": ["S1"], "narrativeRole": "setup",
             "audioObservations": {"dialogue": "", "music": "", "ambience": "", "sfx": ""},
             "emotionalContext": scene1_emotional_context, "visualEvents": [], "confidence": None},
            {"sceneId": "sc2", "start": 5.0, "end": 10.0, "title": "Later", "description": "d",
             "characters": [], "speakers": ["S1"], "narrativeRole": "development",
             "audioObservations": {"dialogue": "", "music": "", "ambience": "", "sfx": ""},
             "emotionalContext": "", "visualEvents": [], "confidence": None},
        ],
        "generatedAt": vnt._now(), "engine": "gemini",
    }

    async def _fake_analyze_story(*a, **k):
        return {"ok": True, "storyAnalysis": story_analysis, "engine": "gemini"}

    monkeypatch.setattr(vnt.video_ai_provider, "analyze_story", _fake_analyze_story)
    await vnt.run_story_analysis(db, "vid_1", bucket, lesson_getter=_lesson_getter, sync_getter=_sync_getter)

    script_blueprint = {
        "scenes": [
            {"sceneId": "sc1", "lines": [{"lineId": "ln1", "speaker": "Narrator", "text": "The room went quiet.", "emotion": ""}]},
            {"sceneId": "sc2", "lines": [{"lineId": "ln2", "speaker": "Narrator", "text": "No one moved.", "emotion": ""}]},
        ],
        "generatedAt": vnt._now(), "engine": "gemini",
    }

    async def _fake_draft_script(*a, **k):
        return {"ok": True, "scriptBlueprint": script_blueprint, "engine": "gemini"}

    monkeypatch.setattr(vnt.video_ai_provider, "draft_script_blueprint", _fake_draft_script)
    await vnt.run_script_blueprint(db, "vid_1", lesson_getter=_lesson_getter, sync_getter=_sync_getter)
    return bucket


@pytest.mark.asyncio
async def test_generate_line_voice_uses_the_scenes_real_emotional_settings(monkeypatch):
    db = _FakeDB()
    await _job_with_two_scenes(db, monkeypatch, scene1_emotional_context="A solemn, reverent farewell.")
    monkeypatch.setenv("ELEVENLABS_API_KEY", "test-key")
    await vnt.set_voice_assignments(db, "vid_1", {"Narrator": "voice_1"})

    client = _FakeElevenLabsClient()
    job = await vnt.generate_line_voice(db, "vid_1", "sc1", "ln1", http_client=client)
    assert job["voiceProduction"]["sc1"]["lines"]["ln1"]["state"] == jobs.S_COMPLETED
    vs = client.calls[0][1]["voice_settings"]
    assert vs["stability"] == 0.72 and vs["style"] == 0.20  # the "reverent" row


@pytest.mark.asyncio
async def test_generate_line_voice_passes_real_adjacent_line_text_as_context(monkeypatch):
    db = _FakeDB()
    await _job_with_two_scenes(db, monkeypatch)
    monkeypatch.setenv("ELEVENLABS_API_KEY", "test-key")
    await vnt.set_voice_assignments(db, "vid_1", {"Narrator": "voice_1"})

    client = _FakeElevenLabsClient()
    await vnt.generate_line_voice(db, "vid_1", "sc1", "ln1", http_client=client)
    first_body = client.calls[0][1]
    assert "previous_text" not in first_body  # first line in the whole script
    assert first_body["next_text"] == "No one moved."

    await vnt.generate_line_voice(db, "vid_1", "sc2", "ln2", http_client=client)
    second_body = client.calls[1][1]
    assert second_body["previous_text"] == "The room went quiet."
    assert "next_text" not in second_body  # last line in the whole script


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
async def test_assemble_sorts_a_scrambled_elevenlabs_word_alignment_before_persisting(monkeypatch):
    """Root-cause regression for the conversation-karaoke incident (2026-08):
    ElevenLabs' own per-line alignment is EXPECTED to already be
    chronological, but nothing previously verified that for the AI-narrated
    (conversation/storytelling) producer path — unlike video_ai_provider.
    segments_to_sync's sibling ASR path, which already defends itself.

    This seeds a voice-production result exactly as it would look coming
    back from a real ElevenLabs response whose word alignment is NOT sorted
    by `start` (array position 0 has the LATEST start, matching the exact
    "final word ends up near the front of the array" shape that made the
    frontend's binary search resolve the wrong active word within seconds
    of Play). Proves assemble_narration_track now produces a document whose
    persisted word order matches the real, already-measured start times —
    and that the resulting document passes sync_schema's own chronological
    gate, which a naive (unsorted) assembly would fail."""
    db = _FakeDB()
    bucket, scene_id, line_id = await _job_with_script(db, monkeypatch)
    path = f"voiceProduction.{scene_id}.lines.{line_id}"
    scrambled_result = {
        "speaker": "S1", "text": "Thanks for the deal today.", "mediaRef": "gridfs://sync_media/line.mp3",
        "wordTimestamps": [
            {"word": "today.", "start": 1.5, "end": 2.0},   # array position 0 — LATEST real time
            {"word": "for", "start": 0.2, "end": 0.4},
            {"word": "the", "start": 0.4, "end": 0.6},
            {"word": "deal", "start": 0.6, "end": 1.5},
            {"word": "Thanks", "start": 0.0, "end": 0.2},   # array position 4 — EARLIEST real time
        ],
        "durationSec": 2.0, "voiceId": "voice_1", "voiceStale": False,
    }
    _set_dotted(db.video_narration_jobs.docs["vid_1"], f"{path}.state", jobs.S_COMPLETED)
    _set_dotted(db.video_narration_jobs.docs["vid_1"], f"{path}.result", scrambled_result)
    await bucket.upload_from_stream("line.mp3", __import__("io").BytesIO(b"fake-audio"), {"contentType": "audio/mpeg"})

    job = await vnt.assemble_narration_track(db, "vid_1")
    sync_id = job["assembly"]["result"]["syncId"]
    sync_doc = await db.chapter_sync.find_one({"syncId": sync_id})

    words = sync_doc["paragraphs"][0]["sentences"][0]["words"]
    assert [w["word"] for w in words] == ["Thanks", "for", "the", "deal", "today."]
    starts = [w["start"] for w in words]
    assert starts == sorted(starts)

    ok, errors = sync_schema.validate_sync_document(sync_doc)
    assert ok, errors


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


# ── rebuild_narration_production: one-call safe rebuild ───────────────────
@pytest.mark.asyncio
async def test_rebuild_reassembles_and_renders_without_publishing_an_unpublished_lesson(monkeypatch):
    db = _FakeDB()
    bucket = await _assembled_job(db, monkeypatch)
    monkeypatch.setattr(vnt.video_render_tools, "mux_narration_into_video", _fake_mux)
    db.video_lessons.docs["vid_1"] = dict(LESSON)

    job = await vnt.rebuild_narration_production(db, "vid_1", bucket, lesson_getter=_lesson_getter)
    assert job["assembly"]["state"] == jobs.S_COMPLETED
    assert job["render"]["state"] == jobs.S_COMPLETED
    assert job.get("published") is not True

    lesson = await db.video_lessons.find_one({"lessonId": "vid_1"})
    assert not lesson.get("aiNarrationPublished")


@pytest.mark.asyncio
async def test_rebuild_forces_a_genuinely_fresh_render_and_republishes_an_already_published_lesson(monkeypatch):
    """The safe rebuild path this exists for: a lesson that was already
    rendered AND published (e.g. "The Wrong Email!") needs its assembly
    and render regenerated after a fix — WITHOUT a second ElevenLabs spend
    and WITHOUT students losing access mid-rebuild (the old master keeps
    serving until the new one lands)."""
    db = _FakeDB()
    bucket = await _assembled_job(db, monkeypatch)
    monkeypatch.setattr(vnt.video_render_tools, "mux_narration_into_video", _fake_mux)
    await vnt.render_final_master(db, "vid_1", bucket, lesson_getter=_lesson_getter)
    db.video_lessons.docs["vid_1"] = dict(LESSON)
    await vnt.publish_narration(db, "vid_1")
    first_master_ref = (await db.video_lessons.find_one({"lessonId": "vid_1"}))["aiNarrationMasterMediaRef"]

    # assemble_narration_track only ever reads already-completed voice-
    # production lines — it structurally cannot call ElevenLabs again, so
    # the "no re-spend" guarantee holds for free; what this test proves is
    # the RENDER side: a genuinely fresh mux runs (not the cost-safe no-op).
    mux_calls = []

    async def _counting_mux(video_bytes, video_ct, audio_bytes, *, treatment="mute"):
        mux_calls.append(1)
        return await _fake_mux(video_bytes, video_ct, audio_bytes, treatment=treatment)

    monkeypatch.setattr(vnt.video_render_tools, "mux_narration_into_video", _counting_mux)

    job = await vnt.rebuild_narration_production(db, "vid_1", bucket, lesson_getter=_lesson_getter)
    assert job["render"]["state"] == jobs.S_COMPLETED
    assert len(mux_calls) == 1  # a genuinely fresh mux ran, not the cost-safe no-op

    lesson = await db.video_lessons.find_one({"lessonId": "vid_1"})
    assert lesson["aiNarrationPublished"] is True  # re-published automatically, it was already live
    assert lesson["aiNarrationMasterMediaRef"] == job["render"]["result"]["mediaRef"]
    assert lesson["aiNarrationMasterMediaRef"] != first_master_ref  # a genuinely new master


@pytest.mark.asyncio
async def test_rebuild_before_any_render_existed_renders_for_the_first_time(monkeypatch):
    """No prior render means reset_render must never be called (it would
    raise nothing_to_reset) — rebuild should just render for the first
    time, exactly like calling render_final_master directly."""
    db = _FakeDB()
    bucket = await _assembled_job(db, monkeypatch)
    monkeypatch.setattr(vnt.video_render_tools, "mux_narration_into_video", _fake_mux)

    job = await vnt.rebuild_narration_production(db, "vid_1", bucket, lesson_getter=_lesson_getter)
    assert job["render"]["state"] == jobs.S_COMPLETED


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


# ── SFX 1:1 visual-event anchoring ────────────────────────────────────────
async def _sfx_event_anchor_offset(db, monkeypatch, *, visual_events: list[dict]) -> float:
    """Common scaffolding for the three visual-event-anchoring tests below:
    one scene with a real (0.0-10.0) window, one narration line, one
    completed SFX asset, and a caller-controlled visualEvents list. Returns
    the single offset overlay_audio_at_offset was actually called with."""
    bucket = _FakeMediaBucket()
    _fake_bucket_patch(monkeypatch, bucket)
    monkeypatch.setenv("ELEVENLABS_API_KEY", "test-key")
    await _single_scene_job(db, monkeypatch, bucket, text="Narrator line for the anchored scene.", scene_end=10.0)
    await vnt.generate_line_voice(db, "vid_1", "sc1", "ln1", http_client=_FakeElevenLabsClient())

    doc = db.video_narration_jobs.docs["vid_1"]
    doc["storyAnalysis"]["result"]["scenes"][0]["visualEvents"] = visual_events
    doc["storyAnalysis"]["result"]["scenes"][0]["audioObservations"]["sfx"] = "a sound effect"
    await vnt.generate_scene_sfx(db, "vid_1", "sc1", http_client=_FakeSfxClient())

    mixed_calls: list[float] = []

    async def _fake_overlay(base, overlay, offset, **kwargs):
        mixed_calls.append(offset)
        return base + b":mixed:" + overlay

    monkeypatch.setattr(vnt.video_render_tools, "overlay_audio_at_offset", _fake_overlay)
    job = await vnt.assemble_narration_track(db, "vid_1")
    assert job["assembly"]["result"]["sfxMixed"] == ["sc1"]
    assert len(mixed_calls) == 1
    return mixed_calls[0]


@pytest.mark.asyncio
async def test_sfx_anchors_to_the_scenes_single_unambiguous_visual_event(monkeypatch):
    """The 1:1-cardinality anchoring rule: when a scene has EXACTLY ONE
    visual event, its SFX lands at that event's own real timestamp (e.g.
    "laptop closes" at 4.2s into the scene) instead of just the scene's
    start — a deterministic, unambiguous relationship, never a guess."""
    db = _FakeDB()
    offset = await _sfx_event_anchor_offset(
        db, monkeypatch, visual_events=[{"timestamp": 4.2, "description": "laptop closes"}],
    )
    assert offset == pytest.approx(4.2, abs=0.01)


@pytest.mark.asyncio
async def test_sfx_falls_back_to_scene_start_when_no_visual_events(monkeypatch):
    """Zero visual events means Gemini never confidently reported a beat
    to anchor to — the honest fallback is the scene's own real start,
    exactly as before event-anchoring existed."""
    db = _FakeDB()
    offset = await _sfx_event_anchor_offset(db, monkeypatch, visual_events=[])
    assert offset == pytest.approx(0.0, abs=0.01)


@pytest.mark.asyncio
async def test_sfx_falls_back_to_scene_start_when_visual_events_are_ambiguous(monkeypatch):
    """Two or more visual events means there is no reliable way to know
    WHICH one this SFX belongs to — guessing would fabricate a timing
    relationship that was never actually given, so this must fall back to
    the scene's own real start rather than pick either candidate."""
    db = _FakeDB()
    offset = await _sfx_event_anchor_offset(db, monkeypatch, visual_events=[
        {"timestamp": 2.0, "description": "door opens"},
        {"timestamp": 6.0, "description": "door closes"},
    ])
    assert offset == pytest.approx(0.0, abs=0.01)


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

    async def post(self, url, headers=None, json=None, params=None, **kwargs):
        self.calls.append((url, json, params))
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


@pytest.mark.skipif(NO_FFMPEG_E2E or NO_FFPROBE_E2E, reason="ffmpeg/ffprobe not installed in this environment")
@pytest.mark.asyncio
async def test_real_implausible_scene_start_never_corrupts_downstream_karaoke_timing(monkeypatch):
    """Root-cause fix for a real karaoke-freeze incident: a hallucinated
    Gemini scene.start far beyond the real narration cursor must NEVER be
    inserted as real silence padding — doing so would push every
    subsequent word's ABSOLUTE offset out to that same implausible value,
    and since the student's karaoke engine can never advance past a word
    whose timestamp is beyond the actual video's real length, playback
    would freeze on the last word before this scene for the rest of the
    episode while audio/video kept playing normally. The fix: an
    implausibly large gap is skipped honestly (scene 2 starts immediately
    after scene 1) rather than fabricated as real silence, keeping every
    absolute timestamp small, real, and reachable."""
    db = _FakeDB()
    bucket = _FakeMediaBucket()
    _fake_bucket_patch(monkeypatch, bucket)
    await bucket.upload_from_stream("vid_1.mp4", __import__("io").BytesIO(b"fake-video"), {"contentType": "video/mp4"})

    # Scene 2's reported start (500s) is wildly beyond any real narration
    # cursor position for this short test clip — exactly the Gemini
    # timestamp-hallucination failure mode this guards against.
    story_analysis = {
        "summary": "s", "narrativeArc": "a", "characters": [],
        "scenes": [
            {"sceneId": "sc1", "start": 0.0, "end": 1.0, "title": "Opening", "description": "d",
             "characters": [], "speakers": ["S1"], "narrativeRole": "setup",
             "audioObservations": {"dialogue": "", "music": "", "ambience": "", "sfx": ""},
             "emotionalContext": "", "visualEvents": [], "confidence": None},
            {"sceneId": "sc2", "start": 500.0, "end": 505.0, "title": "Later", "description": "d",
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

    clip1 = await _make_real_media(kind="audio", duration=0.4)
    job = await vnt.generate_line_voice(db, "vid_1", "sc1", "ln1", http_client=_RealAudioElevenLabsClient(clip1))
    assert job["voiceProduction"]["sc1"]["lines"]["ln1"]["state"] == jobs.S_COMPLETED

    clip2 = await _make_real_media(kind="audio", duration=0.4)
    job = await vnt.generate_line_voice(db, "vid_1", "sc2", "ln2", http_client=_RealAudioElevenLabsClient(clip2))
    assert job["voiceProduction"]["sc2"]["lines"]["ln2"]["state"] == jobs.S_COMPLETED

    job = await vnt.assemble_narration_track(db, "vid_1")
    assert job["assembly"]["state"] == jobs.S_COMPLETED

    # Honest record: the implausible gap was recognized and skipped, never
    # fabricated as real silence.
    timing_notes = job["assembly"]["result"]["sceneTiming"]
    sc2_note = next(n for n in timing_notes if n["sceneId"] == "sc2")
    assert sc2_note["type"] == "padding_implausible"
    assert sc2_note["paddedSec"] == 0.0

    # Real audio proof: the assembled track's actual playtime is just the
    # two short real clips back-to-back — NOT hundreds of seconds of
    # silence that would make the file impractically large and would have
    # pushed every later timestamp out of reach.
    real_clip1_duration = await vnt.video_render_tools.probe_audio_duration_seconds(clip1)
    real_clip2_duration = await vnt.video_render_tools.probe_audio_duration_seconds(clip2)
    assembled_bytes, _ct = await vnt.video_pipeline_tools.load_media_bytes(
        db, bucket, job["assembly"]["result"]["mediaRef"],
    )
    total_duration = await vnt.video_render_tools.probe_audio_duration_seconds(assembled_bytes)
    assert total_duration < real_clip1_duration + real_clip2_duration + 2.0

    # Karaoke proof: scene 2's word timestamps stay small and reachable —
    # anchored to where the narration cursor actually is, never jumped out
    # to the implausible 500s the story analysis reported.
    sync_doc = await db.chapter_sync.find_one({"syncId": job["assembly"]["result"]["syncId"]})
    sentences = sync_doc["paragraphs"][0]["sentences"]
    scene2_sentence = sentences[1]
    assert scene2_sentence["words"][0]["start"] < 5.0


# ── Scene overrun handling: bounded, pitch-preserving time compression ────
async def _single_scene_job(db, monkeypatch, bucket, *, text, scene_end):
    """Builds a one-scene, one-line job with a caller-controlled scene end
    time, so the narration line's (fabricated, alignment-derived) duration
    can be made to overrun it by an exact, chosen amount."""
    await bucket.upload_from_stream("vid_1.mp4", __import__("io").BytesIO(b"fake-video"), {"contentType": "video/mp4"})

    story_analysis = {
        "summary": "s", "narrativeArc": "a", "characters": [],
        "scenes": [
            {"sceneId": "sc1", "start": 0.0, "end": scene_end, "title": "Opening", "description": "d",
             "characters": [], "speakers": ["S1"], "narrativeRole": "setup",
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
        "scenes": [{"sceneId": "sc1", "lines": [{"lineId": "ln1", "speaker": "Narrator", "text": text, "emotion": ""}]}],
        "generatedAt": vnt._now(), "engine": "gemini",
    }

    async def _fake_draft_script(*a, **k):
        return {"ok": True, "scriptBlueprint": script_blueprint, "engine": "gemini"}

    monkeypatch.setattr(vnt.video_ai_provider, "draft_script_blueprint", _fake_draft_script)
    job = await vnt.run_script_blueprint(db, "vid_1", lesson_getter=_lesson_getter, sync_getter=_sync_getter)
    assert job["scriptBlueprint"]["state"] == jobs.S_COMPLETED
    await vnt.set_voice_assignments(db, "vid_1", {"Narrator": "voice_1"})


@pytest.mark.skipif(NO_FFMPEG_E2E or NO_FFPROBE_E2E, reason="ffmpeg/ffprobe not installed in this environment")
@pytest.mark.asyncio
async def test_real_overrunning_narration_line_is_safely_time_compressed_to_fit_its_scene(monkeypatch):
    """The production-grade correction this test exists to prove: a
    narration line whose real spoken length would run PAST its scene's
    real end time must be safely, transparently time-compressed (ffmpeg's
    pitch-preserving atempo, never a naive resample) to land exactly at
    the scene boundary — never silently left overrunning, and never sped
    up beyond MAX_SAFE_TIME_COMPRESSION. Verified with genuine ffmpeg
    compression, real ffprobe duration measurement, and correctly scaled
    karaoke word timestamps."""
    db = _FakeDB()
    bucket = _FakeMediaBucket()
    _fake_bucket_patch(monkeypatch, bucket)

    text = "This narration line runs slightly long for its scene."
    raw_duration = len(text) * 0.05  # _RealAudioElevenLabsClient's 0.05s/char fabricated alignment
    needed_factor = 1.05
    assert needed_factor <= vnt.video_render_tools.MAX_SAFE_TIME_COMPRESSION
    scene_end = raw_duration / needed_factor

    monkeypatch.setenv("ELEVENLABS_API_KEY", "test-key")
    await _single_scene_job(db, monkeypatch, bucket, text=text, scene_end=scene_end)

    real_clip = await _make_real_media(kind="audio", duration=0.3)
    job = await vnt.generate_line_voice(db, "vid_1", "sc1", "ln1", http_client=_RealAudioElevenLabsClient(real_clip))
    assert job["voiceProduction"]["sc1"]["lines"]["ln1"]["state"] == jobs.S_COMPLETED

    job = await vnt.assemble_narration_track(db, "vid_1")
    assert job["assembly"]["state"] == jobs.S_COMPLETED

    # Honest record: the overrun was detected and safely compressed, not
    # silently ignored and not fabricated.
    timing_notes = job["assembly"]["result"]["sceneTiming"]
    note = next(n for n in timing_notes if n["sceneId"] == "sc1" and n["type"] == "compressed")
    assert note["compressedBy"] == pytest.approx(needed_factor, abs=0.01)

    # Real audio proof: ffmpeg's atempo genuinely shortened the real clip —
    # the assembled track's actual playtime is measurably shorter than the
    # original real clip it was generated from.
    real_clip_duration = await vnt.video_render_tools.probe_audio_duration_seconds(real_clip)
    assembled_bytes, _ct = await vnt.video_pipeline_tools.load_media_bytes(
        db, bucket, job["assembly"]["result"]["mediaRef"],
    )
    assembled_duration = await vnt.video_render_tools.probe_audio_duration_seconds(assembled_bytes)
    assert assembled_duration < real_clip_duration

    # Karaoke proof: the word timestamps are scaled by the SAME factor the
    # real audio was compressed by, so the line's last word now lands at
    # the scene's real end instead of past it.
    sync_doc = await db.chapter_sync.find_one({"syncId": job["assembly"]["result"]["syncId"]})
    words = sync_doc["paragraphs"][0]["sentences"][0]["words"]
    assert words[-1]["end"] == pytest.approx(scene_end, abs=0.05)


@pytest.mark.asyncio
async def test_overrun_too_large_for_safe_compression_is_recorded_honestly_not_forced(monkeypatch):
    """When a line would need MORE than MAX_SAFE_TIME_COMPRESSION to fit,
    compression must never even be attempted (would risk unnatural,
    robotic-sounding speech) — the overrun is instead recorded honestly
    and the line is left at its real, undamaged length."""
    db = _FakeDB()
    bucket = _FakeMediaBucket()
    _fake_bucket_patch(monkeypatch, bucket)

    text = "A line so long it massively overruns its tiny scene window here."
    raw_duration = len(text) * 0.1  # _FakeElevenLabsClient's 0.1s/char alignment
    scene_end = raw_duration / 2.0  # would need a destructive 2x speed-up — far beyond the safe bound

    monkeypatch.setenv("ELEVENLABS_API_KEY", "test-key")
    await _single_scene_job(db, monkeypatch, bucket, text=text, scene_end=scene_end)
    client = _FakeElevenLabsClient()
    job = await vnt.generate_line_voice(db, "vid_1", "sc1", "ln1", http_client=client)
    assert job["voiceProduction"]["sc1"]["lines"]["ln1"]["state"] == jobs.S_COMPLETED

    job = await vnt.assemble_narration_track(db, "vid_1")
    timing_notes = job["assembly"]["result"]["sceneTiming"]
    note = next(n for n in timing_notes if n["sceneId"] == "sc1" and n["type"] == "overran")
    assert "risk unnatural" in note["reason"]

    # Never compressed: the real word timestamps are untouched, proving no
    # destructive speed-up was silently applied.
    sync_doc = await db.chapter_sync.find_one({"syncId": job["assembly"]["result"]["syncId"]})
    words = sync_doc["paragraphs"][0]["sentences"][0]["words"]
    assert words[-1]["end"] == pytest.approx(raw_duration, abs=0.01)


@pytest.mark.asyncio
async def test_overrun_within_safe_bound_but_compression_unavailable_is_recorded_honestly(monkeypatch):
    """A safely-compressible overrun where real time-compression genuinely
    fails (here: the fake test audio bytes aren't decodable media, so
    ffmpeg's atempo pass fails exactly as it would if ffmpeg itself were
    missing) must fall back to the line's natural length and record the
    limitation honestly — never fabricate a compression that didn't
    actually happen."""
    db = _FakeDB()
    bucket = _FakeMediaBucket()
    _fake_bucket_patch(monkeypatch, bucket)

    text = "This narration line runs slightly long for its scene."
    raw_duration = len(text) * 0.1  # _FakeElevenLabsClient's 0.1s/char alignment
    scene_end = raw_duration / 1.05  # safely compressible in principle

    monkeypatch.setenv("ELEVENLABS_API_KEY", "test-key")
    await _single_scene_job(db, monkeypatch, bucket, text=text, scene_end=scene_end)
    client = _FakeElevenLabsClient()
    job = await vnt.generate_line_voice(db, "vid_1", "sc1", "ln1", http_client=client)
    assert job["voiceProduction"]["sc1"]["lines"]["ln1"]["state"] == jobs.S_COMPLETED

    job = await vnt.assemble_narration_track(db, "vid_1")
    timing_notes = job["assembly"]["result"]["sceneTiming"]
    note = next(n for n in timing_notes if n["sceneId"] == "sc1" and n["type"] == "compression_unavailable")
    assert "unavailable" in note["reason"]

    sync_doc = await db.chapter_sync.find_one({"syncId": job["assembly"]["result"]["syncId"]})
    words = sync_doc["paragraphs"][0]["sentences"][0]["words"]
    assert words[-1]["end"] == pytest.approx(raw_duration, abs=0.01)


@pytest.mark.skipif(NO_FFMPEG_E2E or NO_FFPROBE_E2E, reason="ffmpeg/ffprobe not installed in this environment")
@pytest.mark.asyncio
async def test_real_combined_multi_scene_overrun_sfx_anchor_and_render_pipeline(monkeypatch):
    """One real, continuous pass proving every production-timing correction
    in this module works TOGETHER, not just in isolation: two scenes with a
    real visual gap between them; scene 2's narration line genuinely
    overruns its own scene end and must be safely time-compressed to fit;
    scene 1 has exactly one visual event and its SFX must land there, not
    at the scene's plain start; and the whole thing renders to a real,
    faststart MP4 master with karaoke timestamps that never point past the
    scene they belong to. Every claim below is checked with genuine ffmpeg/
    ffprobe output, never assumed from a function simply not raising."""
    db = _FakeDB()
    bucket = _FakeMediaBucket()
    _fake_bucket_patch(monkeypatch, bucket)
    source_video = await _make_real_media(kind="video_with_audio", duration=6.0)
    await bucket.upload_from_stream("vid_1.mp4", __import__("io").BytesIO(source_video), {"contentType": "video/mp4"})

    text1 = "Scene one line."
    text2 = "This second scene line overruns its own window just a little too much."
    raw_duration2 = len(text2) * 0.05  # _RealAudioElevenLabsClient's 0.05s/char fabricated alignment
    needed_factor = 1.05
    assert needed_factor <= vnt.video_render_tools.MAX_SAFE_TIME_COMPRESSION
    sc2_start = 3.0
    sc2_end = sc2_start + raw_duration2 / needed_factor

    story_analysis = {
        "summary": "s", "narrativeArc": "a", "characters": [],
        "scenes": [
            {"sceneId": "sc1", "start": 0.0, "end": 1.0, "title": "Opening", "description": "d",
             "characters": [], "speakers": ["S1"], "narrativeRole": "setup",
             "audioObservations": {"dialogue": "", "music": "", "ambience": "", "sfx": "a laptop closing"},
             "emotionalContext": "", "visualEvents": [{"timestamp": 0.4, "description": "laptop closes"}],
             "confidence": None},
            {"sceneId": "sc2", "start": sc2_start, "end": sc2_end, "title": "Later", "description": "d",
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
            {"sceneId": "sc1", "lines": [{"lineId": "ln1", "speaker": "Narrator", "text": text1, "emotion": ""}]},
            {"sceneId": "sc2", "lines": [{"lineId": "ln2", "speaker": "Narrator", "text": text2, "emotion": ""}]},
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

    clip1 = await _make_real_media(kind="audio", duration=0.3)
    job = await vnt.generate_line_voice(db, "vid_1", "sc1", "ln1", http_client=_RealAudioElevenLabsClient(clip1))
    assert job["voiceProduction"]["sc1"]["lines"]["ln1"]["state"] == jobs.S_COMPLETED

    clip2 = await _make_real_media(kind="audio", duration=0.4)
    job = await vnt.generate_line_voice(db, "vid_1", "sc2", "ln2", http_client=_RealAudioElevenLabsClient(clip2))
    assert job["voiceProduction"]["sc2"]["lines"]["ln2"]["state"] == jobs.S_COMPLETED

    sfx_clip = await _make_real_media(kind="audio", duration=0.2)
    job = await vnt.generate_scene_sfx(db, "vid_1", "sc1", http_client=_RealSfxClient(sfx_clip))
    assert job["sfx"]["sc1"]["state"] == jobs.S_COMPLETED

    real_overlay = vnt.video_render_tools.overlay_audio_at_offset
    sfx_offsets: list[float] = []

    async def _capturing_overlay(base, overlay, offset, **kwargs):
        sfx_offsets.append(offset)
        return await real_overlay(base, overlay, offset, **kwargs)

    monkeypatch.setattr(vnt.video_render_tools, "overlay_audio_at_offset", _capturing_overlay)
    job = await vnt.assemble_narration_track(db, "vid_1")
    assert job["assembly"]["state"] == jobs.S_COMPLETED

    # SFX anchored to sc1's single real visual event (0.4s into the scene),
    # not just the scene's plain start (0.0) — real ffmpeg mix, real offset.
    assert job["assembly"]["result"]["sfxMixed"] == ["sc1"]
    assert sfx_offsets == [pytest.approx(0.4, abs=0.01)]

    # sc2's overrunning line was safely compressed, not silently dropped.
    timing_notes = job["assembly"]["result"]["sceneTiming"]
    padding_note = next(n for n in timing_notes if n["sceneId"] == "sc2" and n["type"] == "padding")
    assert padding_note["paddedSec"] > 0
    compression_note = next(n for n in timing_notes if n["sceneId"] == "sc2" and n["type"] == "compressed")
    assert compression_note["compressedBy"] == pytest.approx(needed_factor, abs=0.01)

    # Karaoke proof: scene 2's last word lands AT its real scene end, never
    # past it — the compression genuinely fixed the overrun in the actual
    # assembled timeline, not just in the honesty log.
    sync_doc = await db.chapter_sync.find_one({"syncId": job["assembly"]["result"]["syncId"]})
    sentences = sync_doc["paragraphs"][0]["sentences"]
    assert sentences[1]["words"][-1]["end"] == pytest.approx(sc2_end, abs=0.1)

    # Mathematical karaoke-safety proof (Directive: "prove there is no
    # unreachable timestamp that could make the frontend appear frozen"):
    # every absolute word timestamp across the WHOLE assembled track, not
    # just one scene, must fall inside [0, the job's own reported
    # durationSec] and must never move backward or overlap the next word —
    # the exact invariants a JS binary-search highlight engine
    # (useSyncHighlight) depends on to always be able to advance past
    # currentTime. Checked against durationSec (the number the real player
    # actually uses), not a separate ffprobe re-measurement of the
    # assembled bytes: this test's own _RealAudioElevenLabsClient fixture
    # deliberately fabricates alignment timestamps from TEXT length while
    # returning a fixed-duration, unrelated real audio clip (so real ffmpeg
    # mixing/muxing has real bytes to operate on without needing to
    # synthesize per-character-accurate speech) — a real ElevenLabs
    # response never has that mismatch, since the same request produces
    # both the audio and its alignment together.
    all_words = [w for sentence in sentences for w in sentence["words"]]
    assert all_words, "no words to verify — test setup produced an empty transcript"
    reported_duration = job["assembly"]["result"]["durationSec"]
    assert all_words[0]["start"] >= 0.0
    assert all_words[-1]["end"] <= reported_duration + 0.05
    for prev_word, next_word in zip(all_words, all_words[1:]):
        assert next_word["start"] >= prev_word["start"], "a word timestamp moved backward — unreachable by a monotonic seek"
        assert next_word["start"] >= prev_word["end"] - 0.05, "words overlap enough to corrupt highlight advancement"

    # The assembled audio must still be genuinely playable and non-empty —
    # concat_audio_segments' real ffmpeg decode/re-encode (replacing naive
    # byte-concatenation — see its own docstring for the real MP3 Xing/LAME
    # header risk that motivated this) must never produce corrupt output.
    assembled_bytes, _ct = await vnt.video_pipeline_tools.load_media_bytes(
        db, bucket, job["assembly"]["result"]["mediaRef"],
    )
    real_duration = await vnt.video_render_tools.probe_audio_duration_seconds(assembled_bytes)
    assert real_duration > 0, "the assembled audio must genuinely be a playable, non-empty file"

    # Real render proof: a genuine, faststart MP4 master with an embedded
    # audio stream — the whole pipeline survives all the way to publish.
    job = await vnt.render_final_master(db, "vid_1", bucket, lesson_getter=_lesson_getter)
    assert job["render"]["state"] == jobs.S_COMPLETED
    master_ref = job["render"]["result"]["mediaRef"]
    master_bytes, _ct = await vnt.video_pipeline_tools.load_media_bytes(db, bucket, master_ref)
    assert await vnt.video_render_tools.probe_has_audio_stream(master_bytes) is True
    moov_pos, mdat_pos = master_bytes.find(b"moov"), master_bytes.find(b"mdat")
    assert moov_pos != -1 and mdat_pos != -1 and moov_pos < mdat_pos, "faststart did not take effect"

    db.video_lessons.docs["vid_1"] = dict(LESSON)
    published = await vnt.publish_narration(db, "vid_1")
    assert published["published"] is True


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


# ── Process-death simulation (autonomous production-validation pass) ──────
# Six points requested: (1) dies during Gemini, (2) dies during ElevenLabs,
# (3) dies after ElevenLabs succeeds but before DB completion, (4) dies
# after R2 upload but before DB completion, (5) dies during assembly,
# (6) dies during final render. (5)/(6) are already covered by the
# existing *_timeout_fails_retryable_not_stuck_forever tests above (render
# goes through the same claim/fence engine; assembly has no claim at all —
# it re-derives everything from already-completed line/sfx stages, so a
# crash mid-assembly just means "run it again," never a stranded claim).
# This section covers (1)-(4): the genuine claim/fence/provider-spend paths.
@pytest.mark.asyncio
async def test_crash_mid_gemini_call_is_safely_retryable_with_exactly_one_respend(monkeypatch):
    """Process dies (simulated as the provider call itself raising) while
    Gemini story analysis is in flight. Must land in unknown_outcome (never
    silently lost, never auto-retried), and a subsequent retry must call
    Gemini exactly once more — no duplicate/lost work."""
    db = _FakeDB()
    bucket = _FakeMediaBucket()
    _fake_bucket_patch(monkeypatch, bucket)
    await bucket.upload_from_stream("vid_1.mp4", __import__("io").BytesIO(b"fake-video"), {"contentType": "video/mp4"})

    calls = {"n": 0}

    async def _dies_once(*a, **k):
        calls["n"] += 1
        if calls["n"] == 1:
            raise ConnectionResetError("simulated process death mid-request")
        return {"ok": True, "storyAnalysis": {
            "summary": "s", "narrativeArc": "a", "characters": [],
            "scenes": [{"sceneId": "sc1", "start": 0.0, "end": 1.0, "title": "t", "description": "d",
                        "characters": [], "speakers": ["S1"], "narrativeRole": "setup",
                        "audioObservations": {"dialogue": "", "music": "", "ambience": "", "sfx": ""},
                        "emotionalContext": "", "visualEvents": [], "confidence": None}],
            "generatedAt": vnt._now(), "engine": "gemini",
        }, "engine": "gemini"}

    monkeypatch.setattr(vnt.video_ai_provider, "analyze_story", _dies_once)

    job = await vnt.run_story_analysis(db, "vid_1", bucket, lesson_getter=_lesson_getter, sync_getter=_sync_getter)
    assert job["storyAnalysis"]["state"] == jobs.S_UNKNOWN
    assert calls["n"] == 1

    # Retry — must call Gemini exactly once more, and reach a real terminal success.
    job2 = await vnt.run_story_analysis(db, "vid_1", bucket, lesson_getter=_lesson_getter, sync_getter=_sync_getter)
    assert calls["n"] == 2
    assert job2["storyAnalysis"]["state"] == jobs.S_COMPLETED


@pytest.mark.asyncio
async def test_crash_mid_elevenlabs_call_is_safely_retryable_with_exactly_one_respend(monkeypatch):
    """Same class of crash, at the ElevenLabs line-generation call site."""
    db = _FakeDB()
    bucket, scene_id, line_id = await _job_with_script(db, monkeypatch)
    monkeypatch.setenv("ELEVENLABS_API_KEY", "test-key")

    class _DiesOnceClient:
        def __init__(self):
            self.calls = 0

        async def post(self, url, headers=None, json=None, params=None, **kwargs):
            self.calls += 1
            if self.calls == 1:
                raise ConnectionResetError("simulated process death mid-request")
            text = json["text"]
            audio = f"audio-for:{text}".encode()
            chars = list(text)
            return _FakeHttpResponse(200, {
                "audio_base64": base64.b64encode(audio).decode(),
                "alignment": {"characters": chars, "character_start_times_seconds": [i * 0.1 for i in range(len(chars))],
                              "character_end_times_seconds": [(i + 1) * 0.1 for i in range(len(chars))]},
            })

    client = _DiesOnceClient()
    job = await vnt.generate_line_voice(db, "vid_1", scene_id, line_id, http_client=client)
    path = f"voiceProduction.{scene_id}.lines.{line_id}"
    assert _get_dotted(job, path)["state"] == jobs.S_UNKNOWN
    assert client.calls == 1

    job2 = await vnt.generate_line_voice(db, "vid_1", scene_id, line_id, http_client=client)
    assert client.calls == 2
    assert _get_dotted(job2, path)["state"] == jobs.S_COMPLETED


@pytest.mark.asyncio
async def test_crash_after_elevenlabs_succeeds_but_before_db_completion(monkeypatch):
    """The narrowest of the six requested crash points: the ElevenLabs HTTP
    call itself succeeds (audio genuinely generated and stored to media
    storage) but the process dies before jobs.complete_stage's Mongo write
    lands. Root-cause fix: generate_line_voice now writes a fingerprinted
    checkpoint (lastGeneratedAsset) immediately after the audio is stored,
    via an unconditional (non-fenced) $set that survives even a self-heal
    demotion. A subsequent retry — even with a brand-new attemptId/
    generationVersion — computes the same fingerprint from the same
    (text, voice, settings, context) and finds the checkpoint, so it
    completes directly from the already-stored asset instead of re-calling
    ElevenLabs. This closes the real double-spend window this test
    originally documented as an accepted architectural gap."""
    db = _FakeDB()
    bucket, scene_id, line_id = await _job_with_script(db, monkeypatch)
    monkeypatch.setenv("ELEVENLABS_API_KEY", "test-key")
    path = f"voiceProduction.{scene_id}.lines.{line_id}"

    client = _FakeElevenLabsClient()  # a normal, successful client
    real_complete_stage = jobs.complete_stage
    jobs.complete_stage = None  # simulate "the process dies right here"
    try:
        with pytest.raises(TypeError):  # calling None(...) — stands in for a hard crash
            await vnt.generate_line_voice(db, "vid_1", scene_id, line_id, http_client=client)
    finally:
        jobs.complete_stage = real_complete_stage

    # The stage never reached "completed" — genuinely stranded in provider_pending —
    # but the real asset was generated, stored, AND checkpointed before the crash.
    stage = _get_dotted(db.video_narration_jobs.docs["vid_1"], path)
    assert stage["state"] == jobs.S_PROVIDER_PENDING
    assert stage.get("lastGeneratedAsset", {}).get("mediaRef"), "the checkpoint must survive the crash"
    files_after_first_attempt = len(bucket.files)
    assert files_after_first_attempt >= 1, "the audio genuinely was generated and stored before the crash"

    # Self-heal (lease expiry) demotes it, exactly like a real restart would.
    stage["claimExpiresAt"] = "2000-01-01T00:00:00+00:00"
    healed = await jobs.get_or_create_job(db, "vid_1")
    assert _get_dotted(healed, path)["state"] == jobs.S_UNKNOWN

    # A fresh retry with a normal client reaches a real, uncorrupted success —
    # WITHOUT re-spending, by reusing the checkpointed asset from the crashed attempt.
    job_final = await vnt.generate_line_voice(db, "vid_1", scene_id, line_id, http_client=client)
    final_stage = _get_dotted(job_final, path)
    assert final_stage["state"] == jobs.S_COMPLETED
    assert final_stage["result"]["mediaRef"] == stage["lastGeneratedAsset"]["mediaRef"]
    assert len(client.calls) == 1, "must NOT re-spend on ElevenLabs — the checkpointed asset was reused"


@pytest.mark.asyncio
async def test_idempotent_reuse_never_fires_for_a_genuinely_different_request(monkeypatch):
    """The safety half of the same fix: a checkpoint must only ever be
    reused for the EXACT SAME request. If the admin edits the line's text
    (or voice/settings change) between the crash and the retry, the
    fingerprint changes and a fresh, genuinely new ElevenLabs call must be
    made — never silently serving stale audio for different text."""
    db = _FakeDB()
    bucket, scene_id, line_id = await _job_with_script(db, monkeypatch)
    monkeypatch.setenv("ELEVENLABS_API_KEY", "test-key")
    path = f"voiceProduction.{scene_id}.lines.{line_id}"

    client = _FakeElevenLabsClient()
    real_complete_stage = jobs.complete_stage
    jobs.complete_stage = None
    try:
        with pytest.raises(TypeError):
            await vnt.generate_line_voice(db, "vid_1", scene_id, line_id, http_client=client)
    finally:
        jobs.complete_stage = real_complete_stage

    stage = _get_dotted(db.video_narration_jobs.docs["vid_1"], path)
    stage["claimExpiresAt"] = "2000-01-01T00:00:00+00:00"
    await jobs.get_or_create_job(db, "vid_1")

    # The admin edits the line's text before the retry — a genuinely
    # different request must never reuse the old checkpoint.
    job_doc = db.video_narration_jobs.docs["vid_1"]
    scenes = job_doc["scriptBlueprint"]["result"]["scenes"]
    for scene in scenes:
        for line in scene.get("lines", []):
            if line["lineId"] == line_id:
                line["text"] = "This is a genuinely different line of text now."

    job_final = await vnt.generate_line_voice(db, "vid_1", scene_id, line_id, http_client=client)
    final_stage = _get_dotted(job_final, path)
    assert final_stage["state"] == jobs.S_COMPLETED
    assert len(client.calls) == 2, "a genuinely different request must call ElevenLabs again, not reuse stale audio"


# ── Bilingual (Khmer) learning layer in the AI-narrated pipeline ───────────
# One coherent bilingual architecture regardless of which pipeline produced
# a lesson's sync document: video_scene_schema.build_script_line's own
# translationKm (drafted by the SAME Gemini call that writes the line's
# English "text" — see video_ai_provider._SCRIPT_PROMPT_TEMPLATE) rides
# through assemble_narration_track onto the exact sentence built from that
# line, with no separate id-matching step at all.
async def _job_with_two_scenes_and_translations(db, monkeypatch):
    """Same shape as _job_with_two_scenes, but each script line already
    carries a real translationKm — as if Gemini had drafted it in the same
    response as the line's English text."""
    bucket = _FakeMediaBucket()
    _fake_bucket_patch(monkeypatch, bucket)
    await bucket.upload_from_stream("vid_1.mp4", __import__("io").BytesIO(b"fake-video"), {"contentType": "video/mp4"})

    story_analysis = {
        "summary": "s", "narrativeArc": "a", "characters": [],
        "scenes": [
            {"sceneId": "sc1", "start": 0.0, "end": 5.0, "title": "Opening", "description": "d",
             "characters": [], "speakers": ["S1"], "narrativeRole": "setup",
             "audioObservations": {"dialogue": "", "music": "", "ambience": "", "sfx": ""},
             "emotionalContext": "", "visualEvents": [], "confidence": None},
            {"sceneId": "sc2", "start": 5.0, "end": 10.0, "title": "Later", "description": "d",
             "characters": [], "speakers": ["S1"], "narrativeRole": "development",
             "audioObservations": {"dialogue": "", "music": "", "ambience": "", "sfx": ""},
             "emotionalContext": "", "visualEvents": [], "confidence": None},
        ],
        "generatedAt": vnt._now(), "engine": "gemini",
    }

    async def _fake_analyze_story(*a, **k):
        return {"ok": True, "storyAnalysis": story_analysis, "engine": "gemini"}

    monkeypatch.setattr(vnt.video_ai_provider, "analyze_story", _fake_analyze_story)
    await vnt.run_story_analysis(db, "vid_1", bucket, lesson_getter=_lesson_getter, sync_getter=_sync_getter)

    script_blueprint = {
        "scenes": [
            {"sceneId": "sc1", "lines": [{"lineId": "ln1", "speaker": "Narrator", "text": "The room went quiet.",
                                           "emotion": "", "translationKm": "បន្ទប់នោះស្ងាត់ស្ងៀម។"}]},
            {"sceneId": "sc2", "lines": [{"lineId": "ln2", "speaker": "Narrator", "text": "No one moved.",
                                           "emotion": "", "translationKm": "គ្មាននរណាម្នាក់កម្រើកឡើយ។"}]},
        ],
        "generatedAt": vnt._now(), "engine": "gemini",
    }

    async def _fake_draft_script(*a, **k):
        return {"ok": True, "scriptBlueprint": script_blueprint, "engine": "gemini"}

    monkeypatch.setattr(vnt.video_ai_provider, "draft_script_blueprint", _fake_draft_script)
    await vnt.run_script_blueprint(db, "vid_1", lesson_getter=_lesson_getter, sync_getter=_sync_getter)
    return bucket


def _bypass_real_audio_concat(monkeypatch):
    """These tests are about Khmer translation carry-through/timing-safety,
    not audio-concatenation correctness (already covered by the dedicated
    real-ffmpeg E2E tests) — the fake ElevenLabs client's placeholder
    "audio-for:<text>" byte strings are not real, decodable MP3, so a
    genuine ffmpeg concat/decode would fail on them. Stubbed to the exact
    same honest byte-join fallback concat_audio_segments itself already
    uses when ffmpeg is genuinely unavailable."""
    async def _fake_concat(segments, *, timeout=180.0):
        real = [s for s in segments if s]
        return real[0] if len(real) <= 1 else b"".join(real)
    monkeypatch.setattr(vnt.video_render_tools, "concat_audio_segments", _fake_concat)


@pytest.mark.asyncio
async def test_assemble_carries_each_lines_translation_onto_its_own_sentence(monkeypatch):
    db = _FakeDB()
    await _job_with_two_scenes_and_translations(db, monkeypatch)
    _bypass_real_audio_concat(monkeypatch)
    monkeypatch.setenv("ELEVENLABS_API_KEY", "test-key")
    await vnt.set_voice_assignments(db, "vid_1", {"Narrator": "voice_1"})
    client = _FakeElevenLabsClient()
    await vnt.generate_line_voice(db, "vid_1", "sc1", "ln1", http_client=client)
    await vnt.generate_line_voice(db, "vid_1", "sc2", "ln2", http_client=client)

    job = await vnt.assemble_narration_track(db, "vid_1")
    sync_id = job["assembly"]["result"]["syncId"]
    sync_doc = await db.chapter_sync.find_one({"syncId": sync_id})
    sentences = sync_doc["paragraphs"][0]["sentences"]

    assert len(sentences) == 2
    assert sentences[0]["translationKm"] == "បន្ទប់នោះស្ងាត់ស្ងៀម។"
    assert sentences[1]["translationKm"] == "គ្មាននរណាម្នាក់កម្រើកឡើយ។"
    # Never leaked into the actual spoken words.
    for s in sentences:
        for w in s["words"]:
            assert "translationKm" not in w


@pytest.mark.asyncio
async def test_assemble_translation_present_or_absent_yields_identical_word_timing(monkeypatch):
    """The exact karaoke-safety proof this directive demands: attaching a
    translation to a line must never change the resulting audio segments,
    word timestamps, or sentence count — only add the extra field."""
    db_with = _FakeDB()
    await _job_with_two_scenes_and_translations(db_with, monkeypatch)
    _bypass_real_audio_concat(monkeypatch)
    monkeypatch.setenv("ELEVENLABS_API_KEY", "test-key")
    await vnt.set_voice_assignments(db_with, "vid_1", {"Narrator": "voice_1"})
    client_with = _FakeElevenLabsClient()
    await vnt.generate_line_voice(db_with, "vid_1", "sc1", "ln1", http_client=client_with)
    await vnt.generate_line_voice(db_with, "vid_1", "sc2", "ln2", http_client=client_with)
    job_with = await vnt.assemble_narration_track(db_with, "vid_1")
    doc_with = await db_with.chapter_sync.find_one({"syncId": job_with["assembly"]["result"]["syncId"]})

    db_without = _FakeDB()
    await _job_with_two_scenes(db_without, monkeypatch)
    await vnt.set_voice_assignments(db_without, "vid_1", {"Narrator": "voice_1"})
    client_without = _FakeElevenLabsClient()
    await vnt.generate_line_voice(db_without, "vid_1", "sc1", "ln1", http_client=client_without)
    await vnt.generate_line_voice(db_without, "vid_1", "sc2", "ln2", http_client=client_without)
    job_without = await vnt.assemble_narration_track(db_without, "vid_1")
    doc_without = await db_without.chapter_sync.find_one({"syncId": job_without["assembly"]["result"]["syncId"]})

    def _words_only(doc):
        return [{k: v for k, v in w.items() if k != "confidence"}
                for s in doc["paragraphs"][0]["sentences"] for w in s["words"]]

    assert _words_only(doc_with) == _words_only(doc_without)
    assert doc_with["durationSec"] == doc_without["durationSec"]


@pytest.mark.asyncio
async def test_edit_script_blueprint_clears_stale_translation_when_text_changes(monkeypatch):
    db = _FakeDB()
    await _job_with_two_scenes_and_translations(db, monkeypatch)

    corrected = [
        {"sceneId": "sc1", "lines": [{"lineId": "ln1", "speaker": "Narrator",
                                       "text": "The room went completely silent.",  # text changed
                                       "emotion": "", "translationKm": "បន្ទប់នោះស្ងាត់ស្ងៀម។"}]},
        {"sceneId": "sc2", "lines": [{"lineId": "ln2", "speaker": "Narrator", "text": "No one moved.",  # unchanged
                                       "emotion": "", "translationKm": "គ្មាននរណាម្នាក់កម្រើកឡើយ។"}]},
    ]
    job = await vnt.edit_script_blueprint(db, "vid_1", corrected)
    lines_by_scene = {sc["sceneId"]: sc["lines"][0] for sc in job["scriptBlueprint"]["result"]["scenes"]}

    assert lines_by_scene["sc1"]["text"] == "The room went completely silent."
    assert lines_by_scene["sc1"]["translationKm"] == "", "stale translation (drafted against the OLD text) must be cleared"
    assert lines_by_scene["sc2"]["translationKm"] == "គ្មាននរណាម្នាក់កម្រើកឡើយ។", "unchanged line keeps its real translation"


@pytest.mark.asyncio
async def test_edit_script_blueprint_keeps_translation_when_only_emotion_changes(monkeypatch):
    db = _FakeDB()
    await _job_with_two_scenes_and_translations(db, monkeypatch)

    corrected = [
        {"sceneId": "sc1", "lines": [{"lineId": "ln1", "speaker": "Narrator", "text": "The room went quiet.",
                                       "emotion": "More hesitant, drawn out", "translationKm": "បន្ទប់នោះស្ងាត់ស្ងៀម។"}]},
        {"sceneId": "sc2", "lines": [{"lineId": "ln2", "speaker": "Narrator", "text": "No one moved.",
                                       "emotion": "", "translationKm": "គ្មាននរណាម្នាក់កម្រើកឡើយ។"}]},
    ]
    job = await vnt.edit_script_blueprint(db, "vid_1", corrected)
    line = job["scriptBlueprint"]["result"]["scenes"][0]["lines"][0]
    assert line["translationKm"] == "បន្ទប់នោះស្ងាត់ស្ងៀម។"
