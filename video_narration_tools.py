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

import asyncio
import base64
import datetime as _dt
import hashlib
import io
import logging
import os
import re
import time
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
def _short_acting_cue(acting_note: str) -> str:
    """Derives a short, natural delivery cue from a fuller directorial note
    for the ACTUAL text sent to ElevenLabs. eleven_v3's real, documented
    bracket mechanism is for brief cues (e.g. "[softly]", "[hesitates]") —
    not a full paragraph-length director's note. Sending the whole 300-char
    `emotion` field verbatim (as this function used to) risks the model
    reading it back as literal spoken content instead of treating it as a
    style instruction — exactly the "too many/too long cues make speech
    artificial" failure mode. The FULL note is untouched everywhere else
    (Author Studio still shows it in full) — this only shortens what's
    physically placed inside the TTS bracket. Accumulates comma/period/
    semicolon-separated segments (e.g. "Warm" + "reassuring tone") up to a
    ~60-char budget, so several short descriptors survive together instead
    of being cut at the very first comma — "Warm, reassuring tone" reads as
    a real delivery cue; "Warm" alone throws away useful direction for no
    reason. Still never exceeds the budget: a single segment longer than it
    is hard-capped, exactly as before."""
    max_len = 60
    segments = [s.strip() for s in re.split(r"[.,;]", acting_note) if s.strip()]
    if not segments:
        return acting_note[:max_len].strip()
    cue = segments[0]
    for segment in segments[1:]:
        candidate = f"{cue}, {segment}"
        if len(candidate) > max_len:
            break
        cue = candidate
    return cue[:max_len].strip()


# ── ElevenLabs narration model/voice isolation ──────────────────────────
# Deliberately SEPARATE env vars from the shared ELEVENLABS_MODEL/
# ELEVENLABS_DEFAULT_VOICE that server.py/edutalk_tools.py also read for
# Book Factory/EduTalk — the SAME isolation discipline video_ai_provider.py
# already applies to Gemini (VIDEO_AI_MODEL/VIDEO_ANALYSIS_MODEL vs the
# shared GEMINI_MODEL). Without this, changing Book Factory's configured
# model/voice would silently change Video Library narration too, and vice
# versa — reading the shared vars here would have been exactly that bug.
DEFAULT_NARRATION_MODEL = "eleven_multilingual_v2"
# "Sarah" — the approved default storyteller voice, used only when the
# admin hasn't assigned a voice to a speaker and no override env var is
# set. Ensures a lesson never fails narration purely for lack of
# configuration, while every speaker still gets exactly ONE voice for the
# whole episode (voice_assignments is set once per speaker, never varied
# per scene/line).
DEFAULT_STORYTELLER_VOICE_ID = "EXAVITQu4vr4xnSDxMaL"

# Per-scene-intent ElevenLabs performance settings. Grounded in the
# production baseline given for this feature: stability/style trade
# emotional stability for expressiveness, speed adjusts delivery pace.
# Every row already respects "stability >= 0.30, style <= 0.65" — no
# runtime clamping needed as long as this table itself isn't edited into
# an extreme.
_SCENE_VOICE_SETTINGS: dict[str, dict[str, float]] = {
    "reverent":    {"stability": 0.72, "similarity_boost": 0.80, "style": 0.20, "speed": 0.92},
    "warm":        {"stability": 0.50, "similarity_boost": 0.78, "style": 0.42, "speed": 0.98},
    "joyful":      {"stability": 0.38, "similarity_boost": 0.75, "style": 0.60, "speed": 1.05},
    "nostalgic":   {"stability": 0.62, "similarity_boost": 0.80, "style": 0.35, "speed": 0.90},
    "curious":     {"stability": 0.42, "similarity_boost": 0.75, "style": 0.50, "speed": 1.00},
    "closing":     {"stability": 0.68, "similarity_boost": 0.82, "style": 0.28, "speed": 0.90},
}
# Keyword groups a scene's real Gemini-observed text is matched against, in
# priority order — checked in this order so a scene that's both e.g.
# "joyful" and mentions a "goodbye" resolution still reads as the intended
# emotional arc position rather than whichever keyword happens first
# alphabetically. Grounded entirely in words Gemini itself would plausibly
# write in emotionalContext/narrativeRole/description — never inferred from
# anything the scene doesn't actually say.
_EMOTION_KEYWORDS: list[tuple[str, tuple[str, ...]]] = [
    ("reverent", ("reverent", "sacred", "solemn", "prayer", "worship", "holy", "ceremony")),
    ("closing", ("resolution", "closing", "farewell", "goodbye", "conclu", "ending", "peace")),
    ("joyful", ("joy", "festiv", "celebrat", "excit", "laugh", "cheer", "delight")),
    ("nostalgic", ("nostalg", "memory", "memories", "remember", "longing", "wistful", "childhood")),
    ("curious", ("curious", "question", "wonder", "confus", "puzzle", "uncertain")),
    ("warm", ("warm", "family", "domestic", "home", "comfort", "gentle", "tender", "love")),
]


def _scene_voice_settings(scene: dict | None) -> dict[str, float] | None:
    """Classifies a story-analysis scene into one of the documented
    emotional-intent categories using ONLY the scene's own real Gemini-
    observed text (emotionalContext, narrativeRole, title, description) —
    never a fabricated guess — and returns that category's ElevenLabs
    voice_settings. Returns None when the scene is missing or its text
    doesn't confidently match any category, so the caller can fall back to
    the existing global default rather than force an arbitrary category
    onto a scene Gemini gave no emotional signal for."""
    if not isinstance(scene, dict):
        return None
    haystack = " ".join(str(scene.get(f) or "") for f in
                         ("emotionalContext", "narrativeRole", "title", "description")).lower()
    if not haystack.strip():
        return None
    for category, keywords in _EMOTION_KEYWORDS:
        if any(kw in haystack for kw in keywords):
            return dict(_SCENE_VOICE_SETTINGS[category])
    return None


async def elevenlabs_generate_line(text: str, voice_id: str, *, acting_note: str | None = None,
                                    voice_settings: dict | None = None,
                                    previous_text: str | None = None, next_text: str | None = None,
                                    http_client=None) -> dict:
    api_key = _env("ELEVENLABS_API_KEY")
    if not api_key:
        raise VideoNarrationError("no_api_key", "ELEVENLABS_API_KEY is not configured")
    if not voice_id:
        raise VideoNarrationError("no_voice", "no voice_id supplied")

    use_acting = bool(acting_note) and len(text.strip()) > 10
    tts_cue = _short_acting_cue(acting_note) if use_acting else ""
    tts_text = f"[{tts_cue}] {text}" if use_acting else text
    # Isolated from the shared ELEVENLABS_MODEL other EduHub systems read
    # (see DEFAULT_NARRATION_MODEL's own comment) — Video Library narration
    # always defaults to the multilingual model for its stronger prosody/
    # emotional performance, regardless of what Book Factory/EduTalk have
    # configured for their own, unrelated ElevenLabs usage.
    model = _env("VIDEO_NARRATION_MODEL") or DEFAULT_NARRATION_MODEL

    url = f"https://api.elevenlabs.io/v1/text-to-speech/{voice_id}/with-timestamps"
    headers = {"xi-api-key": api_key, "Content-Type": "application/json"}
    # output_format is a QUERY parameter in ElevenLabs' documented request
    # contract, not a JSON body field — a body-embedded copy is silently
    # ignored by the API, so the actual output format previously depended
    # on account/endpoint defaults rather than the mp3_44100_128 this
    # module's own downstream ffmpeg pipeline (mono/44.1kHz MP3 splicing)
    # actually assumes.
    params = {"output_format": "mp3_44100_128"}
    body: dict = {"text": tts_text, "model_id": model}
    # Adjacent-scene context text — shapes delivery continuity across the
    # cut but is never itself spoken (ElevenLabs' documented contract for
    # these fields). Only included when real (never empty strings), and
    # never contaminates the actual spoken `text`/transcript.
    if previous_text and previous_text.strip():
        body["previous_text"] = previous_text.strip()[:1000]
    if next_text and next_text.strip():
        body["next_text"] = next_text.strip()[:1000]
    if voice_settings:
        vs = {}
        for key in ("stability", "similarity_boost", "style", "speed"):
            if key in voice_settings:
                try:
                    vs[key] = float(voice_settings[key])
                except (TypeError, ValueError):
                    pass
        if vs:
            vs["use_speaker_boost"] = True
            body["voice_settings"] = vs

    if http_client is not None:
        r = await http_client.post(url, params=params, headers=headers, json=body)
    else:
        async with httpx.AsyncClient(timeout=httpx.Timeout(90.0, connect=10.0), follow_redirects=True) as cli:
            r = await cli.post(url, params=params, headers=headers, json=body)
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

    # duration is measured against the FULL alignment (the real audio file's
    # true length, whatever it contains) — computed BEFORE the strip below,
    # since downstream timeline placement (assemble_narration_track's
    # cumulative offset) must reflect the real clip length regardless of
    # what's in it.
    duration = word_timestamps[-1]["end"] if word_timestamps else 0.0

    # Root-cause fix for a real production bug: ElevenLabs' alignment
    # covers the WHOLE tts_text string, including the "[{tts_cue}]" prefix
    # — so word_timestamps previously contained the acting-note's own words
    # indistinguishable from the actual spoken line. Since these are
    # sentence/word-level timestamps, this array becomes the sync
    # document's words via sync_schema.build_word — i.e. it IS the student
    # transcript and the karaoke highlight source, not just an internal
    # detail. A leaked acting note (e.g. "[Warm, reassuring tone,
    # highlighting Maya's...]") rendered verbatim in the Video Library
    # transcript and got highlighted by karaoke exactly like this. Fixed at
    # the source, deterministically: the bracket prefix's own word count
    # (tokenized the SAME way the alignment loop above tokenizes — split on
    # space/newline) tells us exactly how many leading entries in
    # word_timestamps belong to the prefix, never to the real line.
    if use_acting:
        prefix_word_count = len(f"[{tts_cue}]".split())
        word_timestamps = word_timestamps[prefix_word_count:]

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


# Root-cause fix for the same class of incident already fixed once in
# video_pipeline_tools.py (PIPELINE_TIMEOUT_S): every provider-calling
# stage below claims a job stage (state -> "claimed" -> "provider_pending")
# and previously had NO enclosing watchdog — if the awaited provider call
# ever failed to resolve (a stalled connection, an event-loop stall, a
# worker restart mid-flight) the stage stayed in "provider_pending"
# ("Processing" in the UI) forever, with no automatic recovery AND no
# manual retry available (RETRYABLE_STATES in the Studio panel excludes
# "claimed"/"provider_pending" by design, since a genuinely in-flight
# attempt must never be double-claimed). asyncio.wait_for bounds each
# stage the same way the ASR pipeline is already bounded, converting an
# indefinite hang into an honest, retryable failure. 900s is generous for
# a full-video Gemini Files-API round trip (upload + processing poll +
# generation) — see video_ai_provider.py's own internal per-call timeouts,
# which this is a backstop for, not a replacement of.
STAGE_TIMEOUT_S = 900

# See assemble_narration_track's scene-anchoring gap-padding logic: the
# ceiling beyond which a scene's reported visual start is treated as an
# implausible Gemini timestamp rather than a real pause to wait out. Chosen
# generously above any real production pause a scene transition would need
# — real videos rarely have 20+ seconds of dead air between spoken scenes —
# while still catching the failure mode that actually caused a real
# karaoke-freeze incident (a hallucinated scene.start minutes beyond the
# real video's length).
MAX_SAFE_GAP_PADDING_S = 20.0


# ── Mode A: whole-story analysis ─────────────────────────────────────────
async def run_story_analysis(db, lesson_id: str, media_bucket, *, lesson_getter, sync_getter) -> dict:
    job = await jobs.get_or_create_job(db, lesson_id)
    if job["storyAnalysis"]["state"] == jobs.S_COMPLETED:
        return job  # cost-safe no-op — never re-pay for completed work

    claimed, attempt = await jobs.claim_stage(db, lesson_id, "storyAnalysis")
    if claimed is None:
        raise VideoNarrationError("busy_or_done", "story analysis is already running or completed", 409)
    genver = claimed["storyAnalysis"]["generationVersion"]
    if not await jobs.fence_provider(db, lesson_id, "storyAnalysis", attempt, genver, lease_s=STAGE_TIMEOUT_S):
        return await jobs.get_or_create_job(db, lesson_id)

    async def _do() -> None:
        lesson = await lesson_getter(lesson_id)
        if not lesson or not lesson.get("mediaRef") or not lesson.get("syncId"):
            await jobs.fail_terminal(db, lesson_id, "storyAnalysis", attempt, genver,
                                      "lesson has no uploaded media/transcript yet")
            return
        sync_doc = await sync_getter(lesson["syncId"])
        transcript_text = _transcript_text_from_sync(sync_doc)
        raw, content_type = await video_pipeline_tools.load_media_bytes(db, media_bucket, lesson["mediaRef"])
        result = await video_ai_provider.analyze_story(
            raw, content_type, transcript_text=transcript_text, title=lesson.get("title", ""),
        )
        if not result.get("ok"):
            await jobs.fail_stage(db, lesson_id, "storyAnalysis", attempt, genver, result.get("reason", "unknown"))
            return
        ok, errors = video_scene_schema.validate_story_analysis(result["storyAnalysis"])
        if not ok:
            await jobs.fail_terminal(db, lesson_id, "storyAnalysis", attempt, genver,
                                      "invalid_story_analysis: " + "; ".join(errors))
            return
        await jobs.complete_stage(db, lesson_id, "storyAnalysis", attempt, genver, result["storyAnalysis"])

    _started = time.monotonic()
    try:
        # Concurrency cap (video_render_tools.heavy_op_semaphore): bounds
        # how many lessons' full raw media buffers + Gemini requests can be
        # in flight across the whole process at once — claim/fence above
        # only prevents THIS lesson's story analysis running twice.
        async with video_render_tools.heavy_op_semaphore:
            await asyncio.wait_for(_do(), timeout=STAGE_TIMEOUT_S)
        logger.info("video_narration: story analysis done lesson=%s attempt=%s duration=%.1fs",
                    lesson_id, attempt, time.monotonic() - _started)
    except asyncio.TimeoutError:
        logger.warning("video_narration: story analysis timed out lesson=%s attempt=%s after=%.1fs",
                        lesson_id, attempt, time.monotonic() - _started)
        await jobs.fail_stage(db, lesson_id, "storyAnalysis", attempt, genver,
                               f"timed out after {STAGE_TIMEOUT_S}s (stalled I/O — retry is safe)")
    except Exception as exc:  # noqa: BLE001
        logger.exception("video_narration: story analysis failed lesson=%s attempt=%s", lesson_id, attempt)
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
    if not await jobs.fence_provider(db, lesson_id, "scriptBlueprint", attempt, genver, lease_s=STAGE_TIMEOUT_S):
        return await jobs.get_or_create_job(db, lesson_id)

    async def _do() -> None:
        story_analysis = claimed["storyAnalysis"]["result"]
        lesson = await lesson_getter(lesson_id)
        sync_doc = await sync_getter(lesson["syncId"]) if lesson and lesson.get("syncId") else None
        transcript_text = _transcript_text_from_sync(sync_doc)
        result = await video_ai_provider.draft_script_blueprint(
            story_analysis, transcript_text=transcript_text, title=(lesson or {}).get("title", ""),
        )
        if not result.get("ok"):
            await jobs.fail_stage(db, lesson_id, "scriptBlueprint", attempt, genver, result.get("reason", "unknown"))
            return
        scene_ids = {sc["sceneId"] for sc in story_analysis.get("scenes", []) if sc.get("sceneId")}
        ok, errors = video_scene_schema.validate_script_blueprint(result["scriptBlueprint"], known_scene_ids=scene_ids)
        if not ok:
            await jobs.fail_terminal(db, lesson_id, "scriptBlueprint", attempt, genver,
                                      "invalid_script: " + "; ".join(errors))
            return
        await jobs.complete_stage(db, lesson_id, "scriptBlueprint", attempt, genver, result["scriptBlueprint"])

    _started = time.monotonic()
    try:
        # See run_story_analysis's identical comment on heavy_op_semaphore.
        async with video_render_tools.heavy_op_semaphore:
            await asyncio.wait_for(_do(), timeout=STAGE_TIMEOUT_S)
        logger.info("video_narration: script blueprint done lesson=%s attempt=%s duration=%.1fs",
                    lesson_id, attempt, time.monotonic() - _started)
    except asyncio.TimeoutError:
        logger.warning("video_narration: script blueprint timed out lesson=%s attempt=%s after=%.1fs",
                        lesson_id, attempt, time.monotonic() - _started)
        await jobs.fail_stage(db, lesson_id, "scriptBlueprint", attempt, genver,
                               f"timed out after {STAGE_TIMEOUT_S}s (stalled I/O — retry is safe)")
    except Exception as exc:  # noqa: BLE001
        logger.exception("video_narration: script blueprint failed lesson=%s attempt=%s", lesson_id, attempt)
        await jobs.fail_unknown(db, lesson_id, "scriptBlueprint", attempt, genver, f"{type(exc).__name__}: {exc}")
    return await jobs.get_or_create_job(db, lesson_id)


async def edit_script_blueprint(db, lesson_id: str, scenes_payload: list) -> dict:
    """Admin correction pass over the Gemini-drafted script — human
    approval is never bypassed: nothing here is ever auto-published.

    Stale-translation guard: if an edit changes a line's own `text`, that
    line's `translationKm` (drafted against the OLD text) no longer
    describes what the line actually says. Rather than let a now-wrong
    Khmer translation silently keep shipping to students, this drops it
    back to "" — the same honest "no translation yet" state a line has
    before Gemini ever drafted one — regardless of whatever translationKm
    value the edit payload itself carried for that line."""
    job = await jobs.get_or_create_job(db, lesson_id)
    if job["scriptBlueprint"]["state"] != jobs.S_COMPLETED:
        raise VideoNarrationError("no_script_yet", "no script blueprint exists to edit", 409)
    known_ids = {sc["sceneId"] for sc in job["storyAnalysis"]["result"].get("scenes", []) if sc.get("sceneId")}

    old_text_by_line: dict[tuple[str, str], str] = {}
    for sc in (job["scriptBlueprint"]["result"] or {}).get("scenes") or []:
        for ln in sc.get("lines") or []:
            if isinstance(ln, dict) and ln.get("lineId"):
                old_text_by_line[(sc.get("sceneId"), ln["lineId"])] = ln.get("text") or ""

    cleaned_scenes = []
    for sc in scenes_payload or []:
        if not isinstance(sc, dict):
            cleaned_scenes.append(sc)
            continue
        scene_id = sc.get("sceneId")
        cleaned_lines = []
        for ln in sc.get("lines") or []:
            if not isinstance(ln, dict):
                cleaned_lines.append(ln)
                continue
            old_text = old_text_by_line.get((scene_id, ln.get("lineId")))
            if old_text is not None and old_text != (ln.get("text") or ""):
                ln = {**ln, "translationKm": ""}
            cleaned_lines.append(ln)
        cleaned_scenes.append({**sc, "lines": cleaned_lines})

    candidate = video_scene_schema.build_script_blueprint(scenes=cleaned_scenes)
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


def _ordered_script_lines(job: dict) -> list[tuple[str, str, str]]:
    """Flat (sceneId, lineId, text) list across the WHOLE script, in real
    narration order — used to find a line's genuine adjacent-context text
    for ElevenLabs' previous_text/next_text continuity fields. Deliberately
    crosses scene boundaries: the goal is one continuous narrative
    performance, not disconnected per-scene clips."""
    scenes = (job.get("scriptBlueprint", {}).get("result") or {}).get("scenes") or []
    out: list[tuple[str, str, str]] = []
    for scene in scenes:
        for line in scene.get("lines") or []:
            out.append((scene.get("sceneId"), line.get("lineId"), line.get("text") or ""))
    return out


def _adjacent_context_text(job: dict, scene_id: str, line_id: str) -> tuple[str | None, str | None]:
    """The real, already-drafted TEXT of the immediately preceding/
    following line in the whole script — never fabricated, never the
    acting-note/performance-direction field. None at either end of the
    script, exactly as it should be — there is no adjacent line to use."""
    ordered = _ordered_script_lines(job)
    idx = next((i for i, (s, l, _t) in enumerate(ordered) if s == scene_id and l == line_id), None)
    if idx is None:
        return None, None
    previous_text = ordered[idx - 1][2] if idx > 0 else None
    next_text = ordered[idx + 1][2] if idx + 1 < len(ordered) else None
    return previous_text, next_text


def _story_scene_for(job: dict, scene_id: str) -> dict | None:
    """The story-analysis record for a scriptBlueprint sceneId — the two
    stages share sceneId values by construction (run_script_blueprint
    copies the story analysis's own scene ordering/ids), so a direct
    lookup is safe and never needs fuzzy matching."""
    scenes = (job.get("storyAnalysis", {}).get("result") or {}).get("scenes") or []
    return next((s for s in scenes if s.get("sceneId") == scene_id), None)


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
    if not await jobs.fence_provider(db, lesson_id, path, attempt, genver, lease_s=STAGE_TIMEOUT_S):
        return await jobs.get_or_create_job(db, lesson_id)

    # Isolated from the shared ELEVENLABS_DEFAULT_VOICE other EduHub systems
    # read (server.py/edutalk_tools.py) — a per-speaker assignment always
    # wins (the admin's explicit, once-set choice, locked for the whole
    # episode); VIDEO_NARRATION_VOICE lets ops override the default without
    # touching Book Factory/EduTalk's own voice config; the hardcoded
    # DEFAULT_STORYTELLER_VOICE_ID ("Sarah") is the final safety net so a
    # lesson never fails narration purely for lack of configuration.
    voice_assignments = claimed.get("voiceAssignments") or {}
    voice_id = (voice_assignments.get(line["speaker"])
                or _env("VIDEO_NARRATION_VOICE") or DEFAULT_STORYTELLER_VOICE_ID)

    # Real, Gemini-observed scene emotion (never a keyword guess about text
    # that doesn't exist) drives per-scene performance settings; real
    # adjacent script lines (never fabricated) give ElevenLabs continuity
    # context so the whole episode reads as one performance, not
    # disconnected clips.
    story_scene = _story_scene_for(claimed, scene_id)
    voice_settings = _scene_voice_settings(story_scene)
    previous_text, next_text = _adjacent_context_text(claimed, scene_id, line_id)

    # Idempotent asset-reuse (closes a real, previously-identified crash
    # window: the ElevenLabs call succeeds and the audio is genuinely
    # stored, but the process dies before jobs.complete_stage's fenced
    # Mongo write lands — every retry always minted a brand-new attemptId/
    # generationVersion, so the fencing that protects THIS engine
    # everywhere else could never recognize "this is the same request,
    # already paid for" and unconditionally re-spent on ElevenLabs).
    # fingerprint is computed from every input that actually changes the
    # audio ElevenLabs would generate — text, voice, per-scene settings,
    # and continuity context — so an admin edit to the line (which bumps
    # none of these identically) is never mistaken for the same request.
    fingerprint = hashlib.sha256(repr((
        line["text"], voice_id, sorted((voice_settings or {}).items()), previous_text, next_text,
    )).encode("utf-8")).hexdigest()
    checkpoint = jobs.get_path(claimed, path).get("lastGeneratedAsset") or {}
    if checkpoint.get("fingerprint") == fingerprint and checkpoint.get("mediaRef"):
        logger.info("video_narration: line generation reused a checkpointed asset (crash-safe, no re-spend) "
                    "lesson=%s scene=%s line=%s attempt=%s", lesson_id, scene_id, line_id, attempt)
        result = {
            "speaker": line["speaker"], "text": line["text"], "mediaRef": checkpoint["mediaRef"],
            "wordTimestamps": checkpoint["wordTimestamps"], "durationSec": checkpoint["durationSec"],
            "voiceId": voice_id, "voiceStale": False,
        }
        await jobs.complete_stage(db, lesson_id, path, attempt, genver, result)
        return await jobs.get_or_create_job(db, lesson_id)

    _started = time.monotonic()
    try:
        # See run_story_analysis's identical comment on heavy_op_semaphore
        # — bounds concurrent ElevenLabs requests across ALL lessons/lines
        # at once, not just this one line's own claim/fence above.
        async with video_render_tools.heavy_op_semaphore:
            raw = await asyncio.wait_for(
                elevenlabs_generate_line(
                    line["text"], voice_id, acting_note=line.get("emotion") or None,
                    voice_settings=voice_settings, previous_text=previous_text, next_text=next_text,
                    http_client=http_client,
                ),
                timeout=STAGE_TIMEOUT_S,
            )
        logger.info("video_narration: line generation done lesson=%s scene=%s line=%s attempt=%s duration=%.1fs",
                    lesson_id, scene_id, line_id, attempt, time.monotonic() - _started)
    except asyncio.TimeoutError:
        logger.warning("video_narration: line generation timed out lesson=%s scene=%s line=%s attempt=%s after=%.1fs",
                        lesson_id, scene_id, line_id, attempt, time.monotonic() - _started)
        await jobs.fail_stage(db, lesson_id, path, attempt, genver,
                               f"timed out after {STAGE_TIMEOUT_S}s (stalled I/O — retry is safe)")
        return await jobs.get_or_create_job(db, lesson_id)
    except VideoNarrationError as exc:
        logger.warning("video_narration: line generation rejected lesson=%s scene=%s line=%s attempt=%s code=%s",
                        lesson_id, scene_id, line_id, attempt, exc.code)
        if exc.code == "no_api_key":
            await jobs.fail_terminal(db, lesson_id, path, attempt, genver, exc.message)
        else:
            await jobs.fail_stage(db, lesson_id, path, attempt, genver, exc.message)
        return await jobs.get_or_create_job(db, lesson_id)
    except Exception as exc:  # noqa: BLE001
        logger.exception("video_narration: line generation failed lesson=%s scene=%s line=%s attempt=%s",
                          lesson_id, scene_id, line_id, attempt)
        await jobs.fail_unknown(db, lesson_id, path, attempt, genver, f"{type(exc).__name__}: {exc}")
        return await jobs.get_or_create_job(db, lesson_id)

    audio_bytes = base64.b64decode(raw["audio_base64"]) if raw.get("audio_base64") else b""
    if not audio_bytes:
        await jobs.fail_stage(db, lesson_id, path, attempt, genver, "provider returned no audio")
        return await jobs.get_or_create_job(db, lesson_id)

    key = f"video-narration/{lesson_id}/{scene_id}/{line_id}/{attempt}.mp3"
    media_ref = await _store_audio(db, audio_bytes, key, lesson_id)

    # Checkpoint the real, already-stored asset BEFORE the fenced
    # complete_stage write — an unconditional, best-effort $set (not
    # fenced on attemptId/genver) so it survives even if the process dies
    # in the next line, or if a self-heal race (see complete_stage's own
    # docstring) demotes this attempt moments before this point. The
    # fingerprint check above is what makes finding it on a later retry
    # safe: only the exact same request (same text/voice/settings/
    # context) can ever match and reuse it.
    await db[jobs.COLL].update_one(
        {"_id": lesson_id},
        {"$set": {f"{path}.lastGeneratedAsset": {
            "fingerprint": fingerprint, "mediaRef": media_ref,
            "wordTimestamps": raw["word_timestamps"], "durationSec": raw["duration"],
        }}},
    )

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
    if not await jobs.fence_provider(db, lesson_id, path, attempt, genver, lease_s=STAGE_TIMEOUT_S):
        return await jobs.get_or_create_job(db, lesson_id)

    _started = time.monotonic()
    try:
        # See run_story_analysis's identical comment on heavy_op_semaphore.
        async with video_render_tools.heavy_op_semaphore:
            audio_bytes = await asyncio.wait_for(
                elevenlabs_generate_sfx(sfx_description, http_client=http_client), timeout=STAGE_TIMEOUT_S,
            )
        logger.info("video_narration: sfx generation done lesson=%s scene=%s attempt=%s duration=%.1fs",
                    lesson_id, scene_id, attempt, time.monotonic() - _started)
    except asyncio.TimeoutError:
        logger.warning("video_narration: sfx generation timed out lesson=%s scene=%s attempt=%s after=%.1fs",
                        lesson_id, scene_id, attempt, time.monotonic() - _started)
        await jobs.fail_stage(db, lesson_id, path, attempt, genver,
                               f"timed out after {STAGE_TIMEOUT_S}s (stalled I/O — retry is safe)")
        return await jobs.get_or_create_job(db, lesson_id)
    except VideoNarrationError as exc:
        logger.warning("video_narration: sfx generation rejected lesson=%s scene=%s attempt=%s code=%s",
                        lesson_id, scene_id, attempt, exc.code)
        if exc.code == "no_api_key":
            await jobs.fail_terminal(db, lesson_id, path, attempt, genver, exc.message)
        else:
            await jobs.fail_stage(db, lesson_id, path, attempt, genver, exc.message)
        return await jobs.get_or_create_job(db, lesson_id)
    except Exception as exc:  # noqa: BLE001
        logger.exception("video_narration: sfx generation failed lesson=%s scene=%s attempt=%s",
                          lesson_id, scene_id, attempt)
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


def _strip_bracketed_instruction_words(raw_words: list[dict]) -> list[dict]:
    """Defense-in-depth for the student-facing sync document: drops any
    contiguous "[...]" run of word-timestamp tokens — a fragment of a
    bracketed production instruction (e.g. "[Warm, reassuring tone]"),
    never real spoken dialogue. elevenlabs_generate_line already strips
    the acting-note bracket at the source, deterministically — this is a
    second, independent guard at the sentence-building boundary, so a
    line generated before that fix shipped (whose stored wordTimestamps
    may still be contaminated) can never leak into a newly (re)assembled
    narration track either. Stateful (tracks "currently inside an open
    bracket") rather than per-token, since an interior word of a multi-
    word note (e.g. "and" in "[Uplifting and hopeful]") carries no bracket
    character of its own and a per-token check alone would miss it."""
    out: list[dict] = []
    suppressing = False
    for w in raw_words:
        token = str(w.get("word") or "").strip()
        if not suppressing and token.startswith("["):
            suppressing = True
        if suppressing:
            if token.endswith("]"):
                suppressing = False
            continue
        out.append(w)
    return out


# ── Assembly (additive narration track — no video muxing) ────────────────
async def assemble_narration_track(db, lesson_id: str) -> dict:
    job = await jobs.get_or_create_job(db, lesson_id)
    scenes = (job.get("scriptBlueprint", {}).get("result") or {}).get("scenes") or []
    if not scenes:
        raise VideoNarrationError("no_script", "no script blueprint to assemble", 409)

    ordered_results: list[dict] = []
    ordered_scene_ids: list[str] = []
    # Bilingual learning layer: each line's own translationKm (drafted by
    # the SAME Gemini call as its English text — see video_scene_schema.
    # build_script_line's docstring) rides through this exact same
    # iteration, indexed 1:1 with ordered_results/ordered_scene_ids, so it
    # attaches to the sentence built from THIS line and no other — there is
    # no separate id-matching step, so no way for a translation to attach
    # to the wrong sentence.
    ordered_translations: list[str] = []
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
            ordered_translations.append(str(line.get("translationKm") or ""))

    if not ordered_results:
        raise VideoNarrationError("no_lines", "the script has no lines to assemble", 409)

    # Scene-anchored timing: a scene's narration should not begin before
    # that scene has actually started on screen. Real story-analysis scene
    # start/end times (Gemini's own timestamps — never invented here) are
    # used ONLY to insert REAL generated silence at a scene boundary when
    # the track's own running cursor would otherwise place that scene's
    # first line too early. This never stretches/trims ElevenLabs audio
    # and never touches a line's OWN relative word timestamps (those stay
    # exactly as ElevenLabs measured them) — only the absolute OFFSET each
    # line is placed at changes, which is why this must be the SAME loop
    # that builds both the real audio segments and the word timestamps:
    # a gap inserted into one but not the other would make the sync
    # document lie about what the assembled audio actually contains.
    # Gracefully degrades to the prior pure back-to-back concatenation
    # when story-analysis timing is unavailable for a scene, or when real
    # silence generation itself is unavailable (no ffmpeg) — an honest
    # fallback, never a fabricated gap.
    story_scenes = (job.get("storyAnalysis", {}).get("result") or {}).get("scenes") or []
    scene_time_map: dict[str, tuple[float, float]] = {}
    scene_visual_events: dict[str, list[dict]] = {}
    for sc in story_scenes:
        if not isinstance(sc, dict) or not sc.get("sceneId"):
            continue
        try:
            s_start = float(sc.get("start"))
            s_end = float(sc.get("end"))
        except (TypeError, ValueError):
            continue
        if s_end > s_start >= 0:
            scene_time_map[sc["sceneId"]] = (s_start, s_end)
        scene_visual_events[sc["sceneId"]] = sc.get("visualEvents") or []

    # Loudness normalization runs per-line, BEFORE stitching: ElevenLabs
    # renders each line independently, so raw output loudness genuinely
    # varies line to line — normalizing the already-assembled track as one
    # blob afterward would just average that inconsistency out rather than
    # correcting it. video_render_tools.normalize_line_loudness never
    # changes clip duration, so the timestamps built below (from
    # ElevenLabs' own alignment) remain accurate against the normalized
    # audio actually stored.
    audio_segments: list[bytes] = []
    sentences = []
    cursor = 0.0
    speaker_ids: list[str] = []
    scene_starts: dict[str, float] = {}
    scene_timing_notes: list[dict] = []
    seen_scenes: set[str] = set()
    for entry, scene_id, translation_km in zip(ordered_results, ordered_scene_ids, ordered_translations):
        scene_bounds = scene_time_map.get(scene_id)
        if scene_id not in seen_scenes:
            seen_scenes.add(scene_id)
            intended_start = scene_bounds[0] if scene_bounds else None
            if intended_start is not None and intended_start > cursor + 0.05 \
                    and (intended_start - cursor) > MAX_SAFE_GAP_PADDING_S:
                # Root-cause fix for a real karaoke-freeze incident: Gemini's
                # scene.start is occasionally implausibly far ahead of where
                # the narration track has actually reached (a timestamp
                # hallucination on long/complex video, not a real pause).
                # generate_silence_clip has no length limit of its own, so
                # inserting that gap verbatim would push every subsequent
                # word's ABSOLUTE offset far beyond the real audio's actual
                # duration — and since every later word then shares that same
                # corrupted, un-reachable offset, the student-facing karaoke
                # engine's binary search can never advance past the last
                # word before this scene for the rest of playback, even
                # though the audio/video keep playing normally. Skipping the
                # padding here (never fabricating a smaller, equally
                # arbitrary gap instead) keeps every absolute timestamp
                # honest and bounded, at the cost of this one scene's
                # narration starting immediately rather than waiting.
                scene_timing_notes.append({
                    "sceneId": scene_id, "type": "padding_implausible", "paddedSec": 0.0,
                    "reason": f"scene's reported visual start is {round(intended_start - cursor, 1)}s "
                              "ahead of the narration cursor — implausibly large for real padding, "
                              "skipped to avoid corrupting synchronization for the rest of the episode",
                })
            elif intended_start is not None and intended_start > cursor + 0.05:
                gap = intended_start - cursor
                silence = await video_render_tools.generate_silence_clip(gap)
                if silence:
                    audio_segments.append(silence)
                    cursor += gap
                    scene_timing_notes.append({
                        "sceneId": scene_id, "type": "padding", "paddedSec": round(gap, 3),
                        "reason": "waited for the scene's real visual start",
                    })
                else:
                    scene_timing_notes.append({
                        "sceneId": scene_id, "type": "padding_unavailable", "paddedSec": 0.0,
                        "reason": "scene's visual start is later than the narration cursor, but real "
                                  "silence padding was unavailable (ffmpeg missing/failed) — narration "
                                  "starts immediately instead",
                    })
            elif intended_start is not None and intended_start < cursor - 0.05:
                scene_timing_notes.append({
                    "sceneId": scene_id, "type": "overran", "paddedSec": 0.0,
                    "reason": "the prior scene's narration overran into this scene's visual start — "
                              "not corrected (would require compressing or stretching real audio)",
                })

        offset = cursor
        scene_starts.setdefault(scene_id, offset)

        raw, _ct = await video_pipeline_tools.load_media_bytes(db, sync_studio_tools.get_media_bucket(db), entry["mediaRef"])
        normalized = await video_render_tools.normalize_line_loudness(raw)

        raw_words = _strip_bracketed_instruction_words(entry.get("wordTimestamps") or [])
        # Defense-in-depth against the exact incident class documented in
        # sync_schema.validate_sync_document's own docstring: ElevenLabs'
        # per-line alignment is expected to already be chronological within
        # that one line, but this producer had no guard confirming it —
        # unlike video_ai_provider.segments_to_sync's sibling ASR path,
        # which already sorts its own raw segments for the identical
        # reason. A stable sort on the REAL, already-measured `start`
        # value never fabricates a timestamp; it only makes this line's
        # own word ARRAY POSITION match the real values it already
        # carries — done here, before `raw_words[-1]` is trusted as "the
        # chronologically last word" for the duration fallback below, and
        # before the words themselves are built further down.
        raw_words = sorted(raw_words, key=lambda w: float(w.get("start", 0.0)))
        line_duration = float(entry.get("durationSec") or (raw_words[-1]["end"] if raw_words else 0.0))

        # Overrun handling: if THIS line's own audio would run past its
        # scene's real end, apply a small, pitch-preserving time
        # compression (ffmpeg atempo — never a naive resample, never a
        # large/robotic-sounding factor; see MAX_SAFE_TIME_COMPRESSION) to
        # fit it back within the scene window. The audio and the (already
        # real, ElevenLabs-measured) relative word timestamps are scaled
        # by the EXACT SAME factor, so karaoke stays accurate against the
        # actual compressed audio that gets stored — never a fabricated
        # number. If the overrun is too large for a safe compression to
        # fix, or compression itself is unavailable, the line is left at
        # its natural, undamaged length and the overrun is recorded
        # honestly — never silently ignored, never destructively stretched.
        compression_factor = 1.0
        if scene_bounds is not None:
            available = scene_bounds[1] - offset
            if available > 0 and line_duration > available + 0.05:
                needed = line_duration / available
                if needed <= video_render_tools.MAX_SAFE_TIME_COMPRESSION:
                    compressed = await video_render_tools.time_compress_clip(normalized, needed)
                    if compressed:
                        normalized = compressed
                        compression_factor = needed
                        scene_timing_notes.append({
                            "sceneId": scene_id, "type": "compressed", "compressedBy": round(needed, 4),
                            "reason": f"line overran its scene end by {round(line_duration - available, 3)}s — "
                                      "safely time-compressed to fit (pitch-preserving)",
                        })
                        line_duration = available
                    else:
                        scene_timing_notes.append({
                            "sceneId": scene_id, "type": "compression_unavailable", "paddedSec": 0.0,
                            "reason": "line overran its scene end, but real time-compression was "
                                      "unavailable (ffmpeg missing/failed) — left at its natural length",
                        })
                else:
                    scene_timing_notes.append({
                        "sceneId": scene_id, "type": "overran", "paddedSec": 0.0,
                        "reason": f"line overran its scene end by more than a safe compression could fix "
                                  f"({round(needed, 2)}x needed) — left at its natural length rather than "
                                  "risk unnatural, robotic-sounding speech",
                    })

        audio_segments.append(normalized)

        words = [
            sync_schema.build_word(
                w.get("word", ""),
                float(w.get("start", 0.0)) / compression_factor + offset,
                float(w.get("end", 0.0)) / compression_factor + offset,
                confidence=sync_schema.build_confidence(transcript=1.0, alignment=None),
            )
            for w in raw_words if w.get("word")
        ]
        if words:
            sid = entry.get("speaker") or ""
            if sid and sid not in speaker_ids:
                speaker_ids.append(sid)
            sentences.append(sync_schema.build_sentence(
                f"s{len(sentences) + 1}", words, speaker_id=sid or None,
                translation_km=translation_km,
            ))
        cursor = offset + line_duration

    stitched = await video_render_tools.concat_audio_segments(audio_segments)

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

        # Anchor to the scene's own visual event ONLY when there is exactly
        # ONE for this scene — a 1:1, unambiguous relationship (e.g. "00:18.4
        # - laptop closes"). Zero events means Gemini never confidently
        # reported a beat to anchor to; two or more means there is no
        # reliable way to know WHICH one this SFX belongs to. Either way,
        # guessing would fabricate a timing relationship that was never
        # actually given — the honest fallback is the scene's own real
        # start, exactly as before this anchoring existed.
        bounds = scene_time_map.get(scene_id)
        events = scene_visual_events.get(scene_id) or []
        if len(events) == 1 and bounds is not None:
            event_ts = events[0].get("timestamp")
            if isinstance(event_ts, (int, float)):
                scene_start, scene_end = bounds
                delta = max(0.0, min(float(event_ts) - scene_start, scene_end - scene_start))
                offset = offset + delta
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
        # Honest, explicit record of every scene-boundary timing decision —
        # never silent. Empty list means every scene either had no story-
        # analysis timing to anchor to, or landed within 0.05s of its
        # intended start with no correction needed.
        "sceneTiming": scene_timing_notes,
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
    if not await jobs.fence_provider(db, lesson_id, "render", attempt, genver, lease_s=STAGE_TIMEOUT_S):
        return await jobs.get_or_create_job(db, lesson_id)

    async def _do() -> None:
        lesson = await lesson_getter(lesson_id)
        if not lesson or not lesson.get("mediaRef"):
            await jobs.fail_terminal(db, lesson_id, "render", attempt, genver, "lesson has no source media")
            return

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
            return

        key = f"video-narration/{lesson_id}/master/{attempt}.mp4"
        media_ref = await _store_video(db, rendered_bytes, key, lesson_id)
        result = {
            "mediaRef": media_ref, "mode": "replace", "sourceMediaRef": lesson["mediaRef"],
            "audioMediaRef": assembly_result["mediaRef"], "sizeBytes": len(rendered_bytes),
            "sourceAudioTreatment": treatment, "renderedAt": _now(),
        }
        await jobs.complete_stage(db, lesson_id, "render", attempt, genver, result)

    try:
        await asyncio.wait_for(_do(), timeout=STAGE_TIMEOUT_S)
    except asyncio.TimeoutError:
        logger.warning("video_narration: render timed out lesson=%s", lesson_id)
        await jobs.fail_stage(db, lesson_id, "render", attempt, genver,
                               f"timed out after {STAGE_TIMEOUT_S}s (stalled I/O — retry is safe)")
    except Exception as exc:  # noqa: BLE001
        logger.exception("video_narration: render failed lesson=%s", lesson_id)
        await jobs.fail_unknown(db, lesson_id, "render", attempt, genver, f"{type(exc).__name__}: {exc}")
    return await jobs.get_or_create_job(db, lesson_id)


async def reset_render(db, lesson_id: str) -> dict:
    """Explicit, admin-confirmed reset of an already-completed render —
    the ONLY way to force a fresh final-master mux (render_final_master's
    own cost-safe guard otherwise refuses to re-run a completed stage,
    matching reset_line_voice's identical pattern for ElevenLabs lines).
    Needed whenever the ASSEMBLY that feeds the render genuinely changed
    (e.g. re-running "Assemble narration track" after a fix to how
    narration is timed/cleaned) — the existing per-line ElevenLabs audio
    is fully reused; this never re-triggers any provider call, only a new
    ffmpeg mux the next time render_final_master runs. Does not un-publish
    an already-published lesson — publish_narration must be re-run
    afterward to expose the new master, exactly like a first render."""
    job = await jobs.get_or_create_job(db, lesson_id)
    if job["render"]["state"] == jobs.S_PENDING:
        raise VideoNarrationError("nothing_to_reset", "no render has been produced yet", 409)
    await db[jobs.COLL].update_one({"_id": lesson_id}, {"$set": {"render": jobs.new_stage(), "updatedAt": _now()}})
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


async def rebuild_narration_production(db, lesson_id: str, media_bucket, *, lesson_getter) -> dict:
    """One-call safe rebuild for a lesson whose narration was already
    assembled/rendered (optionally published) and needs regenerating after
    a fix to assembly/render logic — e.g. the overrun-compression and SFX
    visual-event anchoring corrections in this module. Reuses every
    already-generated per-line ElevenLabs/SFX asset as-is (assembly never
    re-calls a provider); the only real cost is a fresh ffmpeg mux.

    Sequence: re-assemble (always safe — re-running assembly never spends
    a provider call, and picks up every fix made since the last assembly)
    -> reset the render stage IF a render already existed (render_final_
    master's own cost-safe guard would otherwise refuse to redo a
    "completed" render that is now stale) -> render a fresh final master
    -> re-publish ONLY if the lesson was already published before this
    call started, so a rebuild never auto-publishes an unreviewed lesson
    for the first time. Never deletes or duplicates R2/GridFS objects for
    prior attempts — each stage's own existing storage-key scheme (keyed by
    attempt number) already avoids collisions."""
    job = await jobs.get_or_create_job(db, lesson_id)
    was_published = bool(job.get("published"))
    had_render = job["render"]["state"] == jobs.S_COMPLETED

    job = await assemble_narration_track(db, lesson_id)

    if had_render:
        job = await reset_render(db, lesson_id)

    job = await render_final_master(db, lesson_id, media_bucket, lesson_getter=lesson_getter)

    if was_published:
        job = await publish_narration(db, lesson_id)

    return job


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

    @api.post("/studio/video/lessons/{lesson_id}/narration/render/reset")
    async def reset_render_route(lesson_id: str, _admin=Depends(require_admin)):
        _need_enabled()
        try:
            job = await reset_render(db, lesson_id)
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

    @api.post("/studio/video/lessons/{lesson_id}/narration/rebuild")
    async def rebuild_narration_production_route(lesson_id: str, _admin=Depends(require_admin)):
        _need_enabled()
        try:
            job = await rebuild_narration_production(
                db, lesson_id, sync_studio_tools.get_media_bucket(db), lesson_getter=lesson_getter,
            )
        except VideoNarrationError as exc:
            _raise(exc)
        return {"ok": True, "job": job}

    logger.info("video_narration_tools: routes registered (/api/studio/video/*/narration/*)")
