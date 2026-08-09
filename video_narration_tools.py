"""video_narration_tools.py — Video Library AI Narration production engine
orchestration + routes.

Wires together, per lesson:
  video_narration_jobs.py  — atomic-claim job-stage engine (cost safety)
  video_scene_schema.py    — StoryAnalysis / ScriptBlueprint validation
  video_ai_provider.py     — Gemini whole-story analysis + script drafting
  sync_provider.py         — ElevenLabsProvider (reused, not reimplemented)
  sync_studio_tools.py     — R2/GridFS media storage, chapter_sync writes

Pipeline (matches the approved architecture):
    Gemini whole-story analysis (Mode A, grounded in the lesson's own
    already-approved ASR transcript)
        -> Gemini script blueprint draft (Mode B, grounded in the story
           analysis — never scene-by-scene in isolation)
        -> admin review/edit + voice assignment (role -> ElevenLabs voiceId,
           admin override always wins, preserved across regenerations)
        -> per-line ElevenLabs generation (real per-character alignment
           becomes the timing truth via sync_provider.reshape_elevenlabs_
           word_timestamps — the SAME function Book Factory's narration
           already trusts)
        -> assembly into ONE additive, synthesis-category sync document
           (auto-servable per is_servable_to_students' existing "TTS output
           was generated from already-approved text" rule — this is NOT a
           new exception, it's the same rule Book Factory narration already
           relies on)
        -> explicit admin publish gate (aiNarrationPublished) — separate
           from the sync document's own auto-servable status, so nothing
           reaches students until the administrator has actually listened
           to the assembled result and chosen to ship it.

Every stage is cost-safe via video_narration_jobs' claim/fence/complete/
fail primitives: a completed stage is never re-claimed, and a downstream
failure never triggers upstream re-generation. Voice REGENERATION after an
assignment change is never automatic — voiceStale is an informational flag
only; an explicit reset (a distinct, admin-confirmed action) is required
before a line can be re-claimed, so credits are never silently spent.

Gemini-only, no fallback: analyze_story/draft_script_blueprint (in
video_ai_provider.py) either call Gemini or return a clearly-labeled mock
result — there is no code path anywhere in this module that calls GPT,
Emergent, or any other LLM.
"""
from __future__ import annotations

import base64
import datetime as _dt
import io
import logging
import os
import uuid

import httpx
from fastapi import Body, Depends, HTTPException

import sync_schema
import sync_studio_tools
import video_ai_provider
import video_narration_jobs as jobs
import video_pipeline_tools
import video_render_tools
import video_scene_schema

logger = logging.getLogger("eduhub.video_narration")

LESSONS_COLL = "video_lessons"  # same constant as video_library_tools.LESSONS_COLL


class VideoNarrationError(Exception):
    def __init__(self, code: str, message: str = "", http_status: int = 400) -> None:
        super().__init__(message or code)
        self.code = code
        self.message = message or code
        self.http_status = http_status


def _now() -> str:
    return _dt.datetime.now(_dt.timezone.utc).strftime("%Y-%m-%dT%H:%M:%SZ")


def _env(name: str) -> str:
    return (os.environ.get(name) or "").strip()


# ── feature-flag gating — mirrors book_factory_jobs.py's _flag/status_payload
# pattern exactly, so the AI Narration production engine (the genuinely new,
# not-yet-live-tested surface added this session) can be staged, disabled, or
# hidden from Author Studio without deleting any code, the same way Book
# Factory's narration/conversation-audio automation is staged today. Reads
# env live (not cached) so tests can toggle per-case. Both default false —
# fail-closed until an operator explicitly turns this on. The REST of Video
# Factory (lesson CRUD, media upload, the existing Gemini pipeline, Sync
# Review, Teleprompter, Publish, Analytics) predates this flag and is
# deliberately left ungated here; this controls only the new Voice
# Production surface. ──────────────────────────────────────────────────────
def _flag(name: str) -> bool:
    return _env(name).lower() in ("1", "true", "yes", "on")


def narration_visible() -> bool:
    return _flag("VIDEO_NARRATION_VISIBLE")


def narration_enabled() -> bool:
    return _flag("VIDEO_NARRATION_ENABLED")


def narration_gemini_ready() -> bool:
    return video_ai_provider.ai_available()


def narration_elevenlabs_ready() -> bool:
    return bool(_env("ELEVENLABS_API_KEY"))


def narration_storage_ready() -> bool:
    required = ("R2_ACCOUNT_ID", "R2_ACCESS_KEY_ID", "R2_SECRET_ACCESS_KEY", "R2_BUCKET_NAME", "R2_PUBLIC_URL")
    return all(_env(k) for k in required)


def narration_status_payload() -> dict:
    return {
        "visible": narration_visible(),
        "enabled": narration_enabled(),
        "geminiReady": narration_gemini_ready(),
        "elevenLabsReady": narration_elevenlabs_ready(),
        "storageReady": narration_storage_ready(),
        "music": narration_music_status(),
        "sfx": narration_sfx_status(),
    }


# ── ElevenLabs single-line synthesis — self-contained, no import from
#    server.py (server.py imports its siblings, never the reverse; this
#    mirrors server.py's own _elevenlabs_generate_line exactly, byte for
#    byte behaviorally, so Book Factory's proven request shape is trusted
#    without a circular import). Feeds sync_provider.ElevenLabsProvider so
#    the ACTUAL reshaping into the canonical schema is fully reused, not
#    reimplemented. ──────────────────────────────────────────────────────
async def elevenlabs_generate_line(text: str, voice_id: str, *, acting_note: str | None = None,
                                    voice_settings: dict | None = None, http_client=None) -> dict:
    api_key = _env("ELEVENLABS_API_KEY")
    if not api_key:
        raise VideoNarrationError("no_api_key", "ELEVENLABS_API_KEY is not configured")
    if not voice_id:
        raise VideoNarrationError("no_voice", "no voice_id supplied")

    use_acting = bool(acting_note) and len(text.strip()) > 10
    tts_text = f"[{acting_note}] {text}" if use_acting else text
    model = _env("ELEVENLABS_MODEL") or "eleven_v3"

    url = f"https://api.elevenlabs.io/v1/text-to-speech/{voice_id}/with-timestamps"
    headers = {"xi-api-key": api_key, "Content-Type": "application/json"}
    body: dict = {"text": tts_text, "model_id": model, "output_format": "mp3_44100_128"}
    if voice_settings:
        vs = {}
        for key in ("stability", "similarity_boost", "style"):
            if key in voice_settings:
                try:
                    vs[key] = float(voice_settings[key])
                except (TypeError, ValueError):
                    pass
        if vs:
            vs["use_speaker_boost"] = True
            body["voice_settings"] = vs

    if http_client is not None:
        r = await http_client.post(url, headers=headers, json=body)
    else:
        async with httpx.AsyncClient(timeout=httpx.Timeout(90.0, connect=10.0), follow_redirects=True) as cli:
            r = await cli.post(url, headers=headers, json=body)
    if r.status_code != 200:
        code = "provider_rejected" if r.status_code < 500 else "provider_unavailable"
        raise VideoNarrationError(code, f"ElevenLabs HTTP {r.status_code}: {(r.text or '')[:200]}")

    data = r.json()
    audio_base64 = data.get("audio_base64", "")
    alignment = data.get("alignment", {}) or {}
    chars = alignment.get("characters", []) or []
    char_starts = alignment.get("character_start_times_seconds", []) or []
    char_ends = alignment.get("character_end_times_seconds", []) or []

    word_timestamps: list[dict] = []
    current_word, word_start, word_end = "", 0.0, 0.0
    for i, ch in enumerate(chars):
        char_str = ch if isinstance(ch, str) else str(ch)
        t_start = char_starts[i] if i < len(char_starts) else 0.0
        t_end = char_ends[i] if i < len(char_ends) else 0.0
        if char_str in (" ", "\n"):
            if current_word.strip():
                word_timestamps.append({"word": current_word.strip(),
                                         "start": round(word_start, 3), "end": round(word_end, 3)})
            current_word = ""
        else:
            if not current_word:
                word_start = t_start
            current_word += char_str
            word_end = t_end
    if current_word.strip():
        word_timestamps.append({"word": current_word.strip(),
                                 "start": round(word_start, 3), "end": round(word_end, 3)})

    duration = word_timestamps[-1]["end"] if word_timestamps else 0.0
    return {"audio_base64": audio_base64, "word_timestamps": word_timestamps, "duration": duration}


# ── ElevenLabs sound-effect generation — a REAL, separate ElevenLabs REST
#    endpoint (POST /v1/sound-generation), distinct from the text-to-speech
#    endpoint above. This is genuine "AI SFX" capability (item 7's ADD
#    case for SFX), not fabricated: same api key, same provider, its own
#    documented contract (raw audio bytes back, no per-character alignment
#    — sound effects have no word timing to reshape). Music generation has
#    NO equivalent verified endpoint wired here — see narration_music_
#    status() below, which reports it honestly as unsupported rather than
#    guessing at an unverified contract. ─────────────────────────────────
def narration_music_status() -> dict:
    return {
        "supported": False,
        "reason": "No verified ElevenLabs music-generation endpoint is integrated in this stack.",
    }


def narration_sfx_status() -> dict:
    return {"supported": True, "provider": "elevenlabs", "endpoint": "sound-generation"}


async def elevenlabs_generate_sfx(text: str, *, duration_seconds: float | None = None,
                                   http_client=None) -> bytes:
    api_key = _env("ELEVENLABS_API_KEY")
    if not api_key:
        raise VideoNarrationError("no_api_key", "ELEVENLABS_API_KEY is not configured")
    if not (text or "").strip():
        raise VideoNarrationError("no_sfx_description", "no sound description to generate from")

    body: dict = {"text": text[:450]}
    if duration_seconds is not None:
        body["duration_seconds"] = max(0.5, min(22.0, float(duration_seconds)))

    url = "https://api.elevenlabs.io/v1/sound-generation"
    headers = {"xi-api-key": api_key, "Content-Type": "application/json"}
    if http_client is not None:
        r = await http_client.post(url, headers=headers, json=body)
    else:
        async with httpx.AsyncClient(timeout=httpx.Timeout(90.0, connect=10.0), follow_redirects=True) as cli:
            r = await cli.post(url, headers=headers, json=body)
    if r.status_code != 200:
        code = "provider_rejected" if r.status_code < 500 else "provider_unavailable"
        raise VideoNarrationError(code, f"ElevenLabs HTTP {r.status_code}: {(r.text or '')[:200]}")
    return r.content


def _strip_id3_tags(buf: bytes) -> bytes:
    """Same algorithm as server.py's proven _strip_id3_tags (the fix for
    iOS AVFoundation stopping playback at the first segment's embedded
    duration when segments are naively concatenated) — small, pure, and
    duplicated deliberately rather than imported (see module docstring)."""
    if not buf or len(buf) < 10:
        return buf
    out = buf
    if out[:3] == b"ID3":
        b0, b1, b2, b3 = out[6], out[7], out[8], out[9]
        size = (b0 << 21) | (b1 << 14) | (b2 << 7) | b3
        tag_end = 10 + size
        if 10 < tag_end < len(out):
            out = out[tag_end:]
    if len(out) >= 128 and out[-128:-125] == b"TAG":
        out = out[:-128]
    return out


def _stitch_mp3_segments(segments: list[bytes]) -> bytes:
    if not segments:
        return b""
    parts = [segments[0]]
    for seg in segments[1:]:
        parts.append(_strip_id3_tags(seg))
    return b"".join(parts)


def _transcript_text_from_sync(sync_doc: dict | None) -> str:
    if not sync_doc:
        return ""
    out = []
    for p in sync_doc.get("paragraphs") or []:
        for s in p.get("sentences") or []:
            words = s.get("words") or []
            if words:
                out.append(" ".join(w.get("word", "") for w in words))
    return " ".join(out)


async def _store_audio(db, raw_bytes: bytes, key: str, lesson_id: str) -> str:
    """R2-first, GridFS-fallback — the exact same graceful-degradation
    pattern sync_studio_tools.create_sync_from_upload already uses,
    reused directly rather than reimplemented."""
    media_ref = await sync_studio_tools._upload_media_to_r2(
        raw_bytes, key, "audio/mpeg", {"lessonId": lesson_id},
    )
    if media_ref:
        return media_ref
    media_bucket = sync_studio_tools.get_media_bucket(db)
    filename = f"{uuid.uuid4().hex}.mp3"
    await media_bucket.upload_from_stream(
        filename, io.BytesIO(raw_bytes), metadata={"contentType": "audio/mpeg", "lessonId": lesson_id},
    )
    return f"gridfs://{sync_studio_tools.MEDIA_GRIDFS_BUCKET}/{filename}"


async def _store_video(db, raw_bytes: bytes, key: str, lesson_id: str) -> str:
    """Same R2-first/GridFS-fallback pattern as _store_audio, for the
    rendered final-master MP4 (content-type video/mp4 instead of audio)."""
    media_ref = await sync_studio_tools._upload_media_to_r2(
        raw_bytes, key, "video/mp4", {"lessonId": lesson_id},
    )
    if media_ref:
        return media_ref
    media_bucket = sync_studio_tools.get_media_bucket(db)
    filename = f"{uuid.uuid4().hex}.mp4"
    await media_bucket.upload_from_stream(
        filename, io.BytesIO(raw_bytes), metadata={"contentType": "video/mp4", "lessonId": lesson_id},
    )
    return f"gridfs://{sync_studio_tools.MEDIA_GRIDFS_BUCKET}/{filename}"


# ── Voice assignment ──────────────────────────────────────────────────────
async def set_voice_assignments(db, lesson_id: str, assignments: dict) -> dict:
    job = await jobs.get_or_create_job(db, lesson_id)
    clean = {
        str(k)[:60]: str(v)[:100]
        for k, v in (assignments or {}).items() if str(k or "").strip() and str(v or "").strip()
    }
    old = job.get("voiceAssignments") or {}
    changed_roles = {role for role, vid in clean.items() if old.get(role) != vid}

    stale_updates: dict = {}
    if changed_roles:
        for scene_id, scene in (job.get("voiceProduction") or {}).items():
            for line_id, stage in (scene.get("lines") or {}).items():
                if stage.get("state") == jobs.S_COMPLETED and (stage.get("result") or {}).get("speaker") in changed_roles:
                    stale_updates[f"voiceProduction.{scene_id}.lines.{line_id}.result.voiceStale"] = True

    await db[jobs.COLL].update_one(
        {"_id": lesson_id},
        {"$set": {"voiceAssignments": clean, "updatedAt": _now(), **stale_updates}},
    )
    return await jobs.get_or_create_job(db, lesson_id)


# ── Mode A: whole-story analysis ─────────────────────────────────────────
async def run_story_analysis(db, lesson_id: str, media_bucket, *, lesson_getter, sync_getter) -> dict:
    job = await jobs.get_or_create_job(db, lesson_id)
    if job["storyAnalysis"]["state"] == jobs.S_COMPLETED:
        return job  # cost-safe no-op — never re-pay for completed work

    claimed, attempt = await jobs.claim_stage(db, lesson_id, "storyAnalysis")
    if claimed is None:
        raise VideoNarrationError("busy_or_done", "story analysis is already running or completed", 409)
    genver = claimed["storyAnalysis"]["generationVersion"]
    if not await jobs.fence_provider(db, lesson_id, "storyAnalysis", attempt, genver):
        return await jobs.get_or_create_job(db, lesson_id)

    try:
        lesson = await lesson_getter(lesson_id)
        if not lesson or not lesson.get("mediaRef") or not lesson.get("syncId"):
            await jobs.fail_terminal(db, lesson_id, "storyAnalysis", attempt, genver,
                                      "lesson has no uploaded media/transcript yet")
            return await jobs.get_or_create_job(db, lesson_id)
        sync_doc = await sync_getter(lesson["syncId"])
        transcript_text = _transcript_text_from_sync(sync_doc)
        raw, content_type = await video_pipeline_tools.load_media_bytes(db, media_bucket, lesson["mediaRef"])
        result = await video_ai_provider.analyze_story(
            raw, content_type, transcript_text=transcript_text, title=lesson.get("title", ""),
        )
        if not result.get("ok"):
            await jobs.fail_stage(db, lesson_id, "storyAnalysis", attempt, genver, result.get("reason", "unknown"))
            return await jobs.get_or_create_job(db, lesson_id)
        ok, errors = video_scene_schema.validate_story_analysis(result["storyAnalysis"])
        if not ok:
            await jobs.fail_terminal(db, lesson_id, "storyAnalysis", attempt, genver,
                                      "invalid_story_analysis: " + "; ".join(errors))
            return await jobs.get_or_create_job(db, lesson_id)
        await jobs.complete_stage(db, lesson_id, "storyAnalysis", attempt, genver, result["storyAnalysis"])
    except Exception as exc:  # noqa: BLE001
        logger.exception("video_narration: story analysis failed lesson=%s", lesson_id)
        await jobs.fail_unknown(db, lesson_id, "storyAnalysis", attempt, genver, f"{type(exc).__name__}: {exc}")
    return await jobs.get_or_create_job(db, lesson_id)


# ── Mode B: script blueprint ──────────────────────────────────────────────
async def run_script_blueprint(db, lesson_id: str, *, lesson_getter, sync_getter) -> dict:
    job = await jobs.get_or_create_job(db, lesson_id)
    if job["scriptBlueprint"]["state"] == jobs.S_COMPLETED:
        return job
    if job["storyAnalysis"]["state"] != jobs.S_COMPLETED:
        raise VideoNarrationError("story_analysis_required", "run whole-story analysis first", 409)

    claimed, attempt = await jobs.claim_stage(db, lesson_id, "scriptBlueprint")
    if claimed is None:
        raise VideoNarrationError("busy_or_done", "script blueprint is already running or completed", 409)
    genver = claimed["scriptBlueprint"]["generationVersion"]
    if not await jobs.fence_provider(db, lesson_id, "scriptBlueprint", attempt, genver):
        return await jobs.get_or_create_job(db, lesson_id)

    try:
        story_analysis = claimed["storyAnalysis"]["result"]
        lesson = await lesson_getter(lesson_id)
        sync_doc = await sync_getter(lesson["syncId"]) if lesson and lesson.get("syncId") else None
        transcript_text = _transcript_text_from_sync(sync_doc)
        result = await video_ai_provider.draft_script_blueprint(
            story_analysis, transcript_text=transcript_text, title=(lesson or {}).get("title", ""),
        )
        if not result.get("ok"):
            await jobs.fail_stage(db, lesson_id, "scriptBlueprint", attempt, genver, result.get("reason", "unknown"))
            return await jobs.get_or_create_job(db, lesson_id)
        scene_ids = {sc["sceneId"] for sc in story_analysis.get("scenes", []) if sc.get("sceneId")}
        ok, errors = video_scene_schema.validate_script_blueprint(result["scriptBlueprint"], known_scene_ids=scene_ids)
        if not ok:
            await jobs.fail_terminal(db, lesson_id, "scriptBlueprint", attempt, genver,
                                      "invalid_script: " + "; ".join(errors))
            return await jobs.get_or_create_job(db, lesson_id)
        await jobs.complete_stage(db, lesson_id, "scriptBlueprint", attempt, genver, result["scriptBlueprint"])
    except Exception as exc:  # noqa: BLE001
        logger.exception("video_narration: script blueprint failed lesson=%s", lesson_id)
        await jobs.fail_unknown(db, lesson_id, "scriptBlueprint", attempt, genver, f"{type(exc).__name__}: {exc}")
    return await jobs.get_or_create_job(db, lesson_id)


async def edit_script_blueprint(db, lesson_id: str, scenes_payload: list) -> dict:
    """Admin correction pass over the Gemini-drafted script — human
    approval is never bypassed: nothing here is ever auto-published."""
    job = await jobs.get_or_create_job(db, lesson_id)
    if job["scriptBlueprint"]["state"] != jobs.S_COMPLETED:
        raise VideoNarrationError("no_script_yet", "no script blueprint exists to edit", 409)
    known_ids = {sc["sceneId"] for sc in job["storyAnalysis"]["result"].get("scenes", []) if sc.get("sceneId")}
    candidate = video_scene_schema.build_script_blueprint(scenes=scenes_payload)
    ok, errors = video_scene_schema.validate_script_blueprint(candidate, known_scene_ids=known_ids)
    if not ok:
        raise VideoNarrationError("invalid_script", "; ".join(errors), 400)
    await db[jobs.COLL].update_one(
        {"_id": lesson_id}, {"$set": {"scriptBlueprint.result": candidate, "updatedAt": _now()}},
    )
    return await jobs.get_or_create_job(db, lesson_id)


# ── Per-line ElevenLabs voice production ─────────────────────────────────
def _find_scene_and_line(job: dict, scene_id: str, line_id: str) -> tuple[dict, dict]:
    scenes = (job.get("scriptBlueprint", {}).get("result") or {}).get("scenes") or []
    scene = next((s for s in scenes if s.get("sceneId") == scene_id), None)
    if not scene:
        raise VideoNarrationError("scene_not_found", f"no scene {scene_id!r} in the script", 404)
    line = next((l for l in scene.get("lines") or [] if l.get("lineId") == line_id), None)
    if not line:
        raise VideoNarrationError("line_not_found", f"no line {line_id!r} in scene {scene_id!r}", 404)
    return scene, line


async def generate_line_voice(db, lesson_id: str, scene_id: str, line_id: str, *, http_client=None) -> dict:
    job = await jobs.get_or_create_job(db, lesson_id)
    if job["scriptBlueprint"]["state"] != jobs.S_COMPLETED:
        raise VideoNarrationError("no_script_yet", "no approved script exists yet", 409)
    _scene, line = _find_scene_and_line(job, scene_id, line_id)

    path = f"voiceProduction.{scene_id}.lines.{line_id}"
    if not jobs.get_path(job, path):
        await db[jobs.COLL].update_one({"_id": lesson_id}, {"$set": {path: jobs.new_stage()}})

    claimed, attempt = await jobs.claim_stage(db, lesson_id, path)
    if claimed is None:
        return await jobs.get_or_create_job(db, lesson_id)  # already completed/in-flight — cost-safe no-op
    genver = jobs.get_path(claimed, path)["generationVersion"]
    if not await jobs.fence_provider(db, lesson_id, path, attempt, genver):
        return await jobs.get_or_create_job(db, lesson_id)

    voice_assignments = claimed.get("voiceAssignments") or {}
    voice_id = voice_assignments.get(line["speaker"]) or _env("ELEVENLABS_DEFAULT_VOICE")
    if not voice_id:
        await jobs.fail_terminal(db, lesson_id, path, attempt, genver,
                                  f"no voice assigned for speaker {line['speaker']!r}")
        return await jobs.get_or_create_job(db, lesson_id)

    try:
        raw = await elevenlabs_generate_line(
            line["text"], voice_id, acting_note=line.get("emotion") or None, http_client=http_client,
        )
    except VideoNarrationError as exc:
        if exc.code == "no_api_key":
            await jobs.fail_terminal(db, lesson_id, path, attempt, genver, exc.message)
        else:
            await jobs.fail_stage(db, lesson_id, path, attempt, genver, exc.message)
        return await jobs.get_or_create_job(db, lesson_id)
    except Exception as exc:  # noqa: BLE001
        logger.exception("video_narration: line generation failed lesson=%s scene=%s line=%s",
                          lesson_id, scene_id, line_id)
        await jobs.fail_unknown(db, lesson_id, path, attempt, genver, f"{type(exc).__name__}: {exc}")
        return await jobs.get_or_create_job(db, lesson_id)

    audio_bytes = base64.b64decode(raw["audio_base64"]) if raw.get("audio_base64") else b""
    if not audio_bytes:
        await jobs.fail_stage(db, lesson_id, path, attempt, genver, "provider returned no audio")
        return await jobs.get_or_create_job(db, lesson_id)

    key = f"video-narration/{lesson_id}/{scene_id}/{line_id}/{attempt}.mp3"
    media_ref = await _store_audio(db, audio_bytes, key, lesson_id)

    result = {
        "speaker": line["speaker"], "text": line["text"], "mediaRef": media_ref,
        "wordTimestamps": raw["word_timestamps"], "durationSec": raw["duration"],
        "voiceId": voice_id, "voiceStale": False,
    }
    await jobs.complete_stage(db, lesson_id, path, attempt, genver, result)
    return await jobs.get_or_create_job(db, lesson_id)


async def reset_line_voice(db, lesson_id: str, scene_id: str, line_id: str) -> dict:
    """Explicit, admin-confirmed lifecycle reset — the ONLY way a completed
    line can ever be regenerated (the job engine structurally refuses to
    re-claim a completed stage otherwise). Always costs a fresh provider
    call once re-triggered via generate_line_voice — never silent, never
    automatic."""
    job = await jobs.get_or_create_job(db, lesson_id)
    path = f"voiceProduction.{scene_id}.lines.{line_id}"
    if not jobs.get_path(job, path):
        raise VideoNarrationError("line_not_found", f"no production record for {scene_id}/{line_id}", 404)
    await db[jobs.COLL].update_one({"_id": lesson_id}, {"$set": {path: jobs.new_stage(), "updatedAt": _now()}})
    return await jobs.get_or_create_job(db, lesson_id)


# ── Per-scene SFX generation — genuinely separate from voice production:
#    one optional ElevenLabs Sound Effects asset per scene, sourced from
#    Gemini's own audioObservations.sfx description for that scene (never
#    an invented sound; if Gemini reported nothing, there is nothing to
#    generate from and the stage fails honestly rather than guessing).
#    A completed SFX asset here is picked up automatically by
#    assemble_narration_track, which mixes it into the assembled track at
#    its scene's own narration start offset — see that function's comments
#    for the exact mixing/skip logic and build_audio_timeline for how the
#    resulting placement is reported back to the Author. ─────────────────
async def generate_scene_sfx(db, lesson_id: str, scene_id: str, *, http_client=None) -> dict:
    job = await jobs.get_or_create_job(db, lesson_id)
    if job["storyAnalysis"]["state"] != jobs.S_COMPLETED:
        raise VideoNarrationError("no_story_yet", "run whole-story analysis first", 409)
    scenes = (job["storyAnalysis"]["result"] or {}).get("scenes") or []
    scene = next((s for s in scenes if s.get("sceneId") == scene_id), None)
    if not scene:
        raise VideoNarrationError("scene_not_found", f"no scene {scene_id!r} in the story analysis", 404)
    sfx_description = (scene.get("audioObservations") or {}).get("sfx") or ""
    if not sfx_description.strip():
        raise VideoNarrationError(
            "no_sfx_description", f"Gemini reported no sound effects for scene {scene_id!r}", 409,
        )

    path = f"sfx.{scene_id}"
    if not jobs.get_path(job, path):
        await db[jobs.COLL].update_one({"_id": lesson_id}, {"$set": {path: jobs.new_stage()}})

    claimed, attempt = await jobs.claim_stage(db, lesson_id, path)
    if claimed is None:
        return await jobs.get_or_create_job(db, lesson_id)  # already completed/in-flight — cost-safe no-op
    genver = jobs.get_path(claimed, path)["generationVersion"]
    if not await jobs.fence_provider(db, lesson_id, path, attempt, genver):
        return await jobs.get_or_create_job(db, lesson_id)

    try:
        audio_bytes = await elevenlabs_generate_sfx(sfx_description, http_client=http_client)
    except VideoNarrationError as exc:
        if exc.code == "no_api_key":
            await jobs.fail_terminal(db, lesson_id, path, attempt, genver, exc.message)
        else:
            await jobs.fail_stage(db, lesson_id, path, attempt, genver, exc.message)
        return await jobs.get_or_create_job(db, lesson_id)
    except Exception as exc:  # noqa: BLE001
        logger.exception("video_narration: sfx generation failed lesson=%s scene=%s", lesson_id, scene_id)
        await jobs.fail_unknown(db, lesson_id, path, attempt, genver, f"{type(exc).__name__}: {exc}")
        return await jobs.get_or_create_job(db, lesson_id)

    if not audio_bytes:
        await jobs.fail_stage(db, lesson_id, path, attempt, genver, "provider returned no audio")
        return await jobs.get_or_create_job(db, lesson_id)

    duration_sec = await video_render_tools.probe_audio_duration_seconds(audio_bytes)

    key = f"video-narration/{lesson_id}/{scene_id}/sfx/{attempt}.mp3"
    media_ref = await _store_audio(db, audio_bytes, key, lesson_id)
    result = {
        "sceneId": scene_id, "sourceText": sfx_description, "mediaRef": media_ref,
        "provider": "elevenlabs", "providerAssetId": media_ref, "durationSec": duration_sec,
    }
    await jobs.complete_stage(db, lesson_id, path, attempt, genver, result)
    return await jobs.get_or_create_job(db, lesson_id)


# ── Assembly (additive narration track — no video muxing) ────────────────
async def assemble_narration_track(db, lesson_id: str) -> dict:
    job = await jobs.get_or_create_job(db, lesson_id)
    scenes = (job.get("scriptBlueprint", {}).get("result") or {}).get("scenes") or []
    if not scenes:
        raise VideoNarrationError("no_script", "no script blueprint to assemble", 409)

    ordered_results: list[dict] = []
    ordered_scene_ids: list[str] = []
    for scene in scenes:
        vp_lines = ((job.get("voiceProduction") or {}).get(scene["sceneId"], {}) or {}).get("lines") or {}
        for line in scene.get("lines") or []:
            stage = vp_lines.get(line["lineId"])
            if not stage or stage.get("state") != jobs.S_COMPLETED:
                raise VideoNarrationError(
                    "not_all_lines_complete",
                    f"scene {scene['sceneId']} line {line['lineId']} is not generated yet", 409,
                )
            ordered_results.append(stage["result"])
            ordered_scene_ids.append(scene["sceneId"])

    if not ordered_results:
        raise VideoNarrationError("no_lines", "the script has no lines to assemble", 409)

    audio_segments = []
    for entry in ordered_results:
        raw, _ct = await video_pipeline_tools.load_media_bytes(db, sync_studio_tools.get_media_bucket(db), entry["mediaRef"])
        audio_segments.append(raw)
    stitched = _stitch_mp3_segments(audio_segments)

    sentences = []
    cursor = 0.0
    speaker_ids: list[str] = []
    scene_starts: dict[str, float] = {}
    for entry, scene_id in zip(ordered_results, ordered_scene_ids):
        offset = cursor
        scene_starts.setdefault(scene_id, offset)
        raw_words = entry.get("wordTimestamps") or []
        words = [
            sync_schema.build_word(
                w.get("word", ""), float(w.get("start", 0.0)) + offset, float(w.get("end", 0.0)) + offset,
                confidence=sync_schema.build_confidence(transcript=1.0, alignment=None),
            )
            for w in raw_words if w.get("word")
        ]
        if words:
            sid = entry.get("speaker") or ""
            if sid and sid not in speaker_ids:
                speaker_ids.append(sid)
            sentences.append(sync_schema.build_sentence(f"s{len(sentences) + 1}", words, speaker_id=sid or None))
        line_duration = float(entry.get("durationSec") or (words[-1]["end"] - offset if words else 0.0))
        cursor = offset + line_duration

    # Mix any completed SFX into the stitched track BEFORE it's persisted —
    # additive overlay via video_render_tools.overlay_audio_at_offset, which
    # never shifts the base track's own timing (see its docstring), so the
    # word/sentence timestamps computed above (from the PRE-mix narration)
    # remain accurate against the POST-mix audio actually stored below.
    # Best-effort and non-fatal: SFX is an enhancement, never something
    # that can block narration assembly (an unavailable ffmpeg, or an SFX
    # scene with no narration line in it to anchor timing to, is recorded
    # and skipped, never raised).
    sfx_mixed: list[str] = []
    sfx_skipped: list[dict] = []
    for scene_id, stage in (job.get("sfx") or {}).items():
        if stage.get("state") != jobs.S_COMPLETED:
            continue
        result = stage.get("result") or {}
        offset = scene_starts.get(scene_id)
        if offset is None:
            sfx_skipped.append({"sceneId": scene_id, "reason": "scene has no narration line to anchor timing to"})
            continue
        try:
            sfx_bytes, _ct = await video_pipeline_tools.load_media_bytes(
                db, sync_studio_tools.get_media_bucket(db), result["mediaRef"],
            )
            stitched = await video_render_tools.overlay_audio_at_offset(stitched, sfx_bytes, offset)
            sfx_mixed.append(scene_id)
        except video_render_tools.RenderError as exc:
            sfx_skipped.append({"sceneId": scene_id, "reason": exc.message})

    paragraph = sync_schema.build_paragraph("p1", sentences)
    sync_doc = sync_schema.build_sync_document(
        media_ref="", provider_category="synthesis", provider_version="video-narration-v1",
        paragraphs=[paragraph], generated_at=_now(), duration_sec=cursor,
        speakers=[{"id": sid, "label": sid} for sid in speaker_ids] or None,
    )
    key = f"video-narration/{lesson_id}/assembled/{uuid.uuid4().hex}.mp3"
    media_ref = await _store_audio(db, stitched, key, lesson_id)
    sync_doc["mediaRef"] = media_ref

    ok, errors = sync_schema.validate_sync_document(sync_doc)
    if not ok:
        raise VideoNarrationError("invalid_assembled_sync", "; ".join(errors), 500)

    await db[sync_studio_tools.CHAPTER_SYNC_COLL].insert_one(dict(sync_doc))
    assembly_result = {
        "syncId": sync_doc["syncId"], "mediaRef": media_ref, "durationSec": cursor,
        "sfxMixed": sfx_mixed, "sfxSkipped": sfx_skipped,
    }
    await db[jobs.COLL].update_one(
        {"_id": lesson_id},
        {"$set": {
            "assembly": {**jobs.new_stage(), "state": jobs.S_COMPLETED,
                         "completedAt": _now(), "result": assembly_result},
            "updatedAt": _now(),
        }},
    )
    return await jobs.get_or_create_job(db, lesson_id)


# ── Audio timeline (read-only, structured — item 8) ───────────────────────
def build_audio_timeline(job: dict) -> dict:
    """Deterministic reconstruction of the production timeline from data the
    job ALREADY has — never a new source of truth, never fabricated. Reuses
    the exact same cumulative-offset algorithm assemble_narration_track
    uses to build the assembled sync document, so a line's reported start
    here matches where it actually lands in the assembled/rendered audio.

    Offsets are only trustworthy through the first not-yet-completed line —
    once a gap is hit, every remaining entry (and totalDurationSec) reports
    None rather than a guessed number; this function does not know the
    provider will ever finish generating that line the same way. An SFX
    asset's start reflects the ACTUAL offset assemble_narration_track mixes
    it in at (its scene's first narration line) once that offset is known —
    honestly None for a scene with no narration line to anchor to, or while
    any earlier line is still ungenerated. SFX duration/end are only filled
    in when generate_scene_sfx's ffprobe-based duration measurement
    succeeded (see its docstring) — otherwise None, never guessed."""
    scenes = (job.get("scriptBlueprint", {}).get("result") or {}).get("scenes") or []
    voice_production = job.get("voiceProduction") or {}
    sfx_map = job.get("sfx") or {}

    tracks: list[dict] = []
    cursor = 0.0
    trustworthy = True
    scene_starts: dict[str, float] = {}
    for scene in scenes:
        vp_lines = (voice_production.get(scene["sceneId"], {}) or {}).get("lines") or {}
        for line in scene.get("lines") or []:
            stage = vp_lines.get(line["lineId"]) or {}
            state = stage.get("state", jobs.S_PENDING)
            result = stage.get("result") or {}
            is_narrator = (line.get("speaker") or "").strip().lower() == "narrator"
            if trustworthy:
                scene_starts.setdefault(scene["sceneId"], cursor)
            entry = {
                "sceneId": scene["sceneId"], "lineId": line["lineId"],
                "role": "narrator" if is_narrator else "character",
                "type": "narration" if is_narrator else "dialogue",
                "speaker": line.get("speaker", ""),
                "start": None, "duration": None, "end": None,
                "provider": "elevenlabs", "providerAssetId": result.get("mediaRef"),
                "generationStatus": state,
                "version": stage.get("generationVersion", 0),
                "volume": 1.0, "treatment": "add", "provenance": "ai",
            }
            if state == jobs.S_COMPLETED and trustworthy:
                duration = float(result.get("durationSec") or 0.0)
                entry["start"] = round(cursor, 3)
                entry["duration"] = round(duration, 3)
                entry["end"] = round(cursor + duration, 3)
                cursor += duration
            else:
                trustworthy = False
            tracks.append(entry)

    for scene_id, stage in sfx_map.items():
        result = stage.get("result") or {}
        start = scene_starts.get(scene_id)
        duration = result.get("durationSec")
        tracks.append({
            "sceneId": scene_id, "lineId": None, "role": "sfx", "type": "sfx", "speaker": None,
            "start": round(start, 3) if start is not None else None,
            "duration": round(duration, 3) if duration is not None else None,
            "end": round(start + duration, 3) if start is not None and duration is not None else None,
            "provider": "elevenlabs", "providerAssetId": result.get("mediaRef"),
            "generationStatus": stage.get("state", jobs.S_PENDING),
            "version": stage.get("generationVersion", 0),
            "volume": 1.0, "treatment": "add", "provenance": "ai",
        })

    return {
        "tracks": tracks,
        "totalDurationSec": round(cursor, 3) if trustworthy and tracks else None,
        "sourceAudio": {
            "treatment": job.get("sourceAudioTreatment", "mute"),
            "provenance": "original",
        },
    }


async def set_source_audio_treatment(db, lesson_id: str, treatment: str) -> dict:
    """Sets how the ORIGINAL video's audio track is handled when the final
    master is rendered: mute (replace it entirely — the default, and the
    only option with zero regression risk), duck (keep it faint under the
    narration), or preserve (keep it near-full alongside the narration).
    Whole-track only — see video_render_tools.py's docstring for why
    per-layer (dialogue/music/ambience/sfx) treatment isn't offered: this
    stack has no audio source-separation capability to act on it safely.
    Never triggers a re-render itself — takes effect on the NEXT render."""
    if treatment not in video_render_tools.SOURCE_AUDIO_TREATMENTS:
        raise VideoNarrationError("invalid_treatment", f"unknown source audio treatment {treatment!r}", 400)
    await jobs.get_or_create_job(db, lesson_id)
    await db[jobs.COLL].update_one(
        {"_id": lesson_id}, {"$set": {"sourceAudioTreatment": treatment, "updatedAt": _now()}},
    )
    return await jobs.get_or_create_job(db, lesson_id)


# ── Final render (physically embeds the approved narration audio into the
# original video — REPLACE mode only; see video_render_tools.py's docstring
# for the honest scope statement on ducking/mixing multiple source layers
# and music/SFX generation, neither of which is implemented) ──────────────
async def render_final_master(db, lesson_id: str, media_bucket, *, lesson_getter) -> dict:
    job = await jobs.get_or_create_job(db, lesson_id)
    if job["render"]["state"] == jobs.S_COMPLETED:
        return job  # cost-safe no-op — never re-render already-successful work
    if job["assembly"]["state"] != jobs.S_COMPLETED:
        raise VideoNarrationError("not_assembled", "assemble the narration track before rendering", 409)

    claimed, attempt = await jobs.claim_stage(db, lesson_id, "render")
    if claimed is None:
        raise VideoNarrationError("busy_or_done", "render is already running or completed", 409)
    genver = claimed["render"]["generationVersion"]
    if not await jobs.fence_provider(db, lesson_id, "render", attempt, genver):
        return await jobs.get_or_create_job(db, lesson_id)

    try:
        lesson = await lesson_getter(lesson_id)
        if not lesson or not lesson.get("mediaRef"):
            await jobs.fail_terminal(db, lesson_id, "render", attempt, genver, "lesson has no source media")
            return await jobs.get_or_create_job(db, lesson_id)

        video_bytes, video_ct = await video_pipeline_tools.load_media_bytes(db, media_bucket, lesson["mediaRef"])
        assembly_result = claimed["assembly"]["result"]
        audio_bytes, _ct = await video_pipeline_tools.load_media_bytes(
            db, sync_studio_tools.get_media_bucket(db), assembly_result["mediaRef"],
        )
        treatment = claimed.get("sourceAudioTreatment") or video_render_tools.DEFAULT_SOURCE_AUDIO_TREATMENT

        try:
            rendered_bytes = await video_render_tools.mux_narration_into_video(
                video_bytes, video_ct, audio_bytes, treatment=treatment,
            )
        except video_render_tools.RenderError as exc:
            if exc.code == "ffmpeg_unavailable":
                await jobs.fail_terminal(db, lesson_id, "render", attempt, genver, exc.message)
            else:
                await jobs.fail_stage(db, lesson_id, "render", attempt, genver, exc.message)
            return await jobs.get_or_create_job(db, lesson_id)

        key = f"video-narration/{lesson_id}/master/{attempt}.mp4"
        media_ref = await _store_video(db, rendered_bytes, key, lesson_id)
        result = {
            "mediaRef": media_ref, "mode": "replace", "sourceMediaRef": lesson["mediaRef"],
            "audioMediaRef": assembly_result["mediaRef"], "sizeBytes": len(rendered_bytes),
            "sourceAudioTreatment": treatment, "renderedAt": _now(),
        }
        await jobs.complete_stage(db, lesson_id, "render", attempt, genver, result)
    except Exception as exc:  # noqa: BLE001
        logger.exception("video_narration: render failed lesson=%s", lesson_id)
        await jobs.fail_unknown(db, lesson_id, "render", attempt, genver, f"{type(exc).__name__}: {exc}")
    return await jobs.get_or_create_job(db, lesson_id)


async def publish_narration(db, lesson_id: str) -> dict:
    """The explicit human-approval gate — an assembled narration track is
    NEVER surfaced to students until this is called. Distinct from the
    sync document's own auto-servable status (providerCategory=='synthesis'
    is already publish-eligible per is_servable_to_students — the SAME
    rule Book Factory TTS narration relies on), which governs whether the
    DATA is well-formed, not whether the LESSON exposes it to students.

    If a final master has ALSO been rendered (job.render completed), publish
    additionally exposes it as aiNarrationMasterMediaRef — a real MP4 with
    the narration audio physically embedded — WITHOUT removing the
    audio-only aiNarrationMediaRef fields, so lessons that haven't rendered
    a master yet keep working exactly as before via the additive track."""
    job = await jobs.get_or_create_job(db, lesson_id)
    if job["assembly"]["state"] != jobs.S_COMPLETED:
        raise VideoNarrationError("not_assembled", "assemble the narration track before publishing", 409)
    result = job["assembly"]["result"]
    updates = {
        "aiNarrationSyncId": result["syncId"],
        "aiNarrationMediaRef": result["mediaRef"],
        "aiNarrationDurationSec": result["durationSec"],
        "aiNarrationPublished": True,
    }
    if job["render"]["state"] == jobs.S_COMPLETED:
        updates["aiNarrationMasterMediaRef"] = job["render"]["result"]["mediaRef"]
    await db[LESSONS_COLL].update_one({"lessonId": lesson_id}, {"$set": updates})
    await db[jobs.COLL].update_one({"_id": lesson_id}, {"$set": {"published": True, "updatedAt": _now()}})
    return await jobs.get_or_create_job(db, lesson_id)


async def unpublish_narration(db, lesson_id: str) -> dict:
    """Reversible — pulls the narration track back from students without
    destroying any generated work (the sync document/audio/render job all
    stay intact; only the lesson-level exposure flags flip off)."""
    await db[LESSONS_COLL].update_one(
        {"lessonId": lesson_id}, {"$set": {"aiNarrationPublished": False, "aiNarrationMasterMediaRef": None}},
    )
    await db[jobs.COLL].update_one({"_id": lesson_id}, {"$set": {"published": False, "updatedAt": _now()}})
    return await jobs.get_or_create_job(db, lesson_id)


# ── Routes ────────────────────────────────────────────────────────────────
def register_video_narration_routes(api, db, require_admin, *, lesson_getter, sync_getter) -> None:
    """`lesson_getter(lesson_id)` / `sync_getter(sync_id)` are injected
    read adapters (matching sync_studio_tools.register_sync_studio_routes'
    established DI convention) rather than importing video_library_tools.py
    /sync_studio_tools.py's Mongo access directly — keeps this module
    decoupled from exactly how a lesson/sync document is fetched."""

    def _raise(exc: VideoNarrationError):
        raise HTTPException(status_code=exc.http_status, detail=exc.message)

    def _need_enabled():
        if not narration_enabled():
            raise HTTPException(status_code=503, detail="Video AI Narration is disabled.")

    @api.get("/studio/video-factory/status")
    async def video_factory_status_route(_admin=Depends(require_admin)):
        return narration_status_payload()

    @api.get("/studio/video/lessons/{lesson_id}/narration")
    async def narration_status_route(lesson_id: str, _admin=Depends(require_admin)):
        _need_enabled()
        job = await jobs.get_or_create_job(db, lesson_id)
        return {"job": job}

    @api.post("/studio/video/lessons/{lesson_id}/narration/story-analysis/run")
    async def run_story_analysis_route(lesson_id: str, _admin=Depends(require_admin)):
        _need_enabled()
        try:
            job = await run_story_analysis(
                db, lesson_id, sync_studio_tools.get_media_bucket(db),
                lesson_getter=lesson_getter, sync_getter=sync_getter,
            )
        except VideoNarrationError as exc:
            _raise(exc)
        return {"ok": True, "job": job}

    @api.post("/studio/video/lessons/{lesson_id}/narration/script-blueprint/run")
    async def run_script_blueprint_route(lesson_id: str, _admin=Depends(require_admin)):
        _need_enabled()
        try:
            job = await run_script_blueprint(db, lesson_id, lesson_getter=lesson_getter, sync_getter=sync_getter)
        except VideoNarrationError as exc:
            _raise(exc)
        return {"ok": True, "job": job}

    @api.patch("/studio/video/lessons/{lesson_id}/narration/script-blueprint")
    async def edit_script_blueprint_route(lesson_id: str, payload: dict = Body(...), _admin=Depends(require_admin)):
        _need_enabled()
        try:
            job = await edit_script_blueprint(db, lesson_id, payload.get("scenes") or [])
        except VideoNarrationError as exc:
            _raise(exc)
        return {"ok": True, "job": job}

    @api.put("/studio/video/lessons/{lesson_id}/narration/voice-assignments")
    async def set_voice_assignments_route(lesson_id: str, payload: dict = Body(...), _admin=Depends(require_admin)):
        _need_enabled()
        job = await set_voice_assignments(db, lesson_id, payload.get("assignments") or {})
        return {"ok": True, "job": job}

    @api.post("/studio/video/lessons/{lesson_id}/narration/voice-production/{scene_id}/{line_id}/generate")
    async def generate_line_route(lesson_id: str, scene_id: str, line_id: str, _admin=Depends(require_admin)):
        _need_enabled()
        try:
            job = await generate_line_voice(db, lesson_id, scene_id, line_id)
        except VideoNarrationError as exc:
            _raise(exc)
        return {"ok": True, "job": job}

    @api.post("/studio/video/lessons/{lesson_id}/narration/voice-production/{scene_id}/{line_id}/reset")
    async def reset_line_route(lesson_id: str, scene_id: str, line_id: str, _admin=Depends(require_admin)):
        _need_enabled()
        try:
            job = await reset_line_voice(db, lesson_id, scene_id, line_id)
        except VideoNarrationError as exc:
            _raise(exc)
        return {"ok": True, "job": job}

    @api.post("/studio/video/lessons/{lesson_id}/narration/sfx/{scene_id}/generate")
    async def generate_scene_sfx_route(lesson_id: str, scene_id: str, _admin=Depends(require_admin)):
        _need_enabled()
        try:
            job = await generate_scene_sfx(db, lesson_id, scene_id)
        except VideoNarrationError as exc:
            _raise(exc)
        return {"ok": True, "job": job}

    @api.get("/studio/video/lessons/{lesson_id}/narration/timeline")
    async def narration_timeline_route(lesson_id: str, _admin=Depends(require_admin)):
        _need_enabled()
        job = await jobs.get_or_create_job(db, lesson_id)
        return {"timeline": build_audio_timeline(job)}

    @api.post("/studio/video/lessons/{lesson_id}/narration/assemble")
    async def assemble_route(lesson_id: str, _admin=Depends(require_admin)):
        _need_enabled()
        try:
            job = await assemble_narration_track(db, lesson_id)
        except VideoNarrationError as exc:
            _raise(exc)
        return {"ok": True, "job": job}

    @api.put("/studio/video/lessons/{lesson_id}/narration/source-audio-treatment")
    async def set_source_audio_treatment_route(
        lesson_id: str, payload: dict = Body(...), _admin=Depends(require_admin),
    ):
        _need_enabled()
        try:
            job = await set_source_audio_treatment(db, lesson_id, str(payload.get("treatment") or ""))
        except VideoNarrationError as exc:
            _raise(exc)
        return {"ok": True, "job": job}

    @api.post("/studio/video/lessons/{lesson_id}/narration/render")
    async def render_route(lesson_id: str, _admin=Depends(require_admin)):
        _need_enabled()
        try:
            job = await render_final_master(
                db, lesson_id, sync_studio_tools.get_media_bucket(db), lesson_getter=lesson_getter,
            )
        except VideoNarrationError as exc:
            _raise(exc)
        return {"ok": True, "job": job}

    @api.post("/studio/video/lessons/{lesson_id}/narration/publish")
    async def publish_route(lesson_id: str, _admin=Depends(require_admin)):
        _need_enabled()
        try:
            job = await publish_narration(db, lesson_id)
        except VideoNarrationError as exc:
            _raise(exc)
        return {"ok": True, "job": job}

    @api.post("/studio/video/lessons/{lesson_id}/narration/unpublish")
    async def unpublish_route(lesson_id: str, _admin=Depends(require_admin)):
        _need_enabled()
        job = await unpublish_narration(db, lesson_id)
        return {"ok": True, "job": job}

    logger.info("video_narration_tools: routes registered (/api/studio/video/*/narration/*)")
