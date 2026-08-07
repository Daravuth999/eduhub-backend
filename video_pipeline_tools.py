"""video_pipeline_tools.py — Video Library automatic AI processing pipeline.

Orchestrates the post-upload flow the product spec defines:

    Upload → Media Ready → Speech Recognition (Gemini, see
    video_ai_provider.py) → Synchronization Generation (canonical
    sync_schema.py document, applied via sync_studio_tools.apply_alignment_
    result — chapter_sync stays exclusively owned by sync_studio_tools) →
    Gemini Educational Analysis → Review Ready (Synchronization Review
    Studio takes over) → Author Approval → Publish.

The player NEVER performs speech recognition — everything here happens at
content-processing time, once, server-side.

Pipeline state lives ON the lesson document (`pipeline` field, owned by
video_library_tools' video_lessons collection — this module only writes it
through video_library_tools-style direct updates on the same collection
constant, matching the "pipeline is lesson production metadata" reality).
An atomic claim ($set running only when not already running) makes
concurrent runs structurally impossible, mirroring the purchase state
machine's claim discipline.

Runs as an asyncio background task (asyncio.create_task) fired by the media
upload route — this codebase is a single-process FastAPI service and every
existing long-running job (Book Factory narration, Voice Treasure image
generation) follows the same in-process pattern; no new queue infrastructure
is introduced.
"""
from __future__ import annotations

import asyncio
import datetime as _dt
import logging

import httpx
from fastapi import Body, Depends, HTTPException

import sync_studio_tools
import video_ai_provider

logger = logging.getLogger("eduhub.video_pipeline")

LESSONS_COLL = "video_lessons"  # same constant as video_library_tools.LESSONS_COLL

PIPELINE_STEPS = (
    "media_check",
    "speech_recognition",
    "synchronization",
    "educational_analysis",
    "review_ready",
)

MAX_TRANSCRIBE_BYTES = 300 * 1024 * 1024


def _now() -> str:
    return _dt.datetime.now(_dt.timezone.utc).strftime("%Y-%m-%dT%H:%M:%SZ")


def build_pipeline_record(provider_version: str) -> dict:
    return {
        "state": "running",
        "currentStep": PIPELINE_STEPS[0],
        "provider": provider_version,
        "steps": {step: {"status": "pending", "error": None, "at": None} for step in PIPELINE_STEPS},
        "startedAt": _now(),
        "finishedAt": None,
        "error": None,
        "log": [{"at": _now(), "step": "queued", "status": "info", "message": "Processing run scheduled"}],
    }


async def _set_step(db, lesson_id: str, step: str, status: str, error: str | None = None) -> None:
    updates = {
        f"pipeline.steps.{step}.status": status,
        f"pipeline.steps.{step}.error": error,
        f"pipeline.steps.{step}.at": _now(),
        "pipeline.currentStep": step,
    }
    entry = {"at": _now(), "step": step, "status": status,
             "message": error or f"{step.replace('_', ' ')} {status}"}
    await db[LESSONS_COLL].update_one(
        {"lessonId": lesson_id},
        {"$set": updates, "$push": {"pipeline.log": {"$each": [entry], "$slice": -80}}},
    )


async def _finish(db, lesson_id: str, state: str, error: str | None = None) -> None:
    await db[LESSONS_COLL].update_one(
        {"lessonId": lesson_id},
        {"$set": {"pipeline.state": state, "pipeline.error": error, "pipeline.finishedAt": _now()}},
    )


async def load_media_bytes(db, media_bucket, media_ref: str) -> tuple[bytes, str]:
    """Fetch the lesson's stored media back for processing. GridFS refs are
    read from the shared sync_media bucket; R2 refs are fetched over HTTP
    (Cloudflare serves them publicly by design)."""
    prefix = f"gridfs://{sync_studio_tools.MEDIA_GRIDFS_BUCKET}/"
    if media_ref.startswith(prefix):
        filename = media_ref[len(prefix):]
        gridout = await media_bucket.open_download_stream_by_name(filename)
        raw = await gridout.read()
        content_type = (gridout.metadata or {}).get("contentType", "application/octet-stream")
        return raw, content_type
    async with httpx.AsyncClient(timeout=httpx.Timeout(300.0, connect=15.0)) as cli:
        r = await cli.get(media_ref)
        if r.status_code != 200:
            raise RuntimeError(f"media fetch failed: HTTP {r.status_code}")
        return r.content, r.headers.get("content-type", "application/octet-stream")


async def run_pipeline(db, lesson_id: str, media_bucket) -> dict:
    """The complete automatic processing run. Atomic claim first — exactly
    one concurrent run per lesson. Returns the final pipeline record."""
    lesson = await db[LESSONS_COLL].find_one({"lessonId": lesson_id}, {"_id": 0})
    if not lesson:
        raise RuntimeError(f"no lesson {lesson_id!r}")
    if not lesson.get("mediaRef") or not lesson.get("syncId"):
        raise RuntimeError("lesson has no uploaded media yet")

    provider = video_ai_provider.get_video_ai_provider()

    claimed = await db[LESSONS_COLL].find_one_and_update(
        {"lessonId": lesson_id, "pipeline.state": {"$ne": "running"}},
        {"$set": {"pipeline": build_pipeline_record(provider.provider_version)}},
    )
    if claimed is None and (lesson.get("pipeline") or {}).get("state") == "running":
        raise RuntimeError("pipeline already running for this lesson")
    if claimed is None:
        # lesson had no pipeline field at all — seed it directly
        await db[LESSONS_COLL].update_one(
            {"lessonId": lesson_id},
            {"$set": {"pipeline": build_pipeline_record(provider.provider_version)}},
        )

    sync_id = lesson["syncId"]
    try:
        # 1 — media check + load
        await _set_step(db, lesson_id, "media_check", "running")
        raw, content_type = await load_media_bytes(db, media_bucket, lesson["mediaRef"])
        if not raw or len(raw) > MAX_TRANSCRIBE_BYTES:
            raise RuntimeError("media is empty or exceeds the processing size limit")
        stored_ct = lesson.get("contentType") or content_type
        await _set_step(db, lesson_id, "media_check", "complete")

        # 2 — speech recognition (Gemini / mock, provider-neutral surface)
        await _set_step(db, lesson_id, "speech_recognition", "running")
        await sync_studio_tools.mark_alignment_processing(db, sync_id)
        result = await provider.align(raw, stored_ct)
        transcript_text = result.get("transcriptText", "")
        await _set_step(db, lesson_id, "speech_recognition", "complete")

        # 3 — synchronization generation (canonical schema, versioned)
        await _set_step(db, lesson_id, "synchronization", "running")
        sync_doc = await sync_studio_tools.apply_alignment_result(db, sync_id, result["sync"])
        duration = float(sync_doc.get("durationSec") or 0.0)
        if duration > 0:
            await db[LESSONS_COLL].update_one(
                {"lessonId": lesson_id, "durationSec": {"$in": [0, 0.0, None]}},
                {"$set": {"durationSec": round(duration, 3)}},
            )
        await _set_step(db, lesson_id, "synchronization", "complete")

        # 4 — Gemini educational analysis (never sinks the pipeline)
        await _set_step(db, lesson_id, "educational_analysis", "running")
        analysis = await video_ai_provider.analyze_transcript(
            transcript_text, title=lesson.get("title", ""),
        )
        if analysis.get("ok"):
            learning = {**analysis["learning"], "engine": analysis.get("engine"), "generatedAt": _now()}
            await db[LESSONS_COLL].update_one(
                {"lessonId": lesson_id}, {"$set": {"learning": learning}},
            )
            if learning.get("speakerLabels"):
                await sync_studio_tools.suggest_speaker_labels(db, sync_id, learning["speakerLabels"])
            await _set_step(db, lesson_id, "educational_analysis", "complete")
        else:
            await _set_step(db, lesson_id, "educational_analysis", "failed", analysis.get("reason"))

        # 5 — review ready
        await _set_step(db, lesson_id, "review_ready", "complete")
        await _finish(db, lesson_id, "complete")
        logger.info("video_pipeline: complete lesson=%s provider=%s", lesson_id, provider.provider_version)
    except Exception as exc:  # noqa: BLE001
        logger.exception("video_pipeline: FAILED lesson=%s", lesson_id)
        current = await db[LESSONS_COLL].find_one({"lessonId": lesson_id}, {"_id": 0, "pipeline": 1})
        step = ((current or {}).get("pipeline") or {}).get("currentStep") or "media_check"
        await _set_step(db, lesson_id, step, "failed", f"{type(exc).__name__}: {exc}")
        await _finish(db, lesson_id, "failed", f"{type(exc).__name__}: {exc}")
        try:
            await sync_studio_tools.mark_alignment_failed(db, sync_id)
        except Exception:  # noqa: BLE001
            pass

    final = await db[LESSONS_COLL].find_one({"lessonId": lesson_id}, {"_id": 0, "pipeline": 1})
    return (final or {}).get("pipeline") or {}


def schedule_pipeline(db, lesson_id: str, media_bucket) -> None:
    """Fire-and-forget background run — the upload route returns immediately
    and the Studio polls GET …/pipeline for progress."""
    async def _run():
        try:
            await run_pipeline(db, lesson_id, media_bucket)
        except Exception as exc:  # noqa: BLE001
            logger.warning("video_pipeline: scheduled run refused lesson=%s (%s)", lesson_id, exc)

    asyncio.create_task(_run())


def register_video_pipeline_routes(api, db, require_admin) -> None:
    # Bucket fix: resolved lazily per-request via get_media_bucket(db),
    # not constructed eagerly here — see sync_studio_tools.get_media_
    # bucket()'s docstring for why eager construction at this function's
    # own synchronous, import-time call site crashed in production before
    # any event loop existed.

    @api.get("/studio/video/lessons/{lesson_id}/pipeline")
    async def pipeline_status_route(lesson_id: str, _admin=Depends(require_admin)):
        doc = await db[LESSONS_COLL].find_one({"lessonId": lesson_id}, {"_id": 0, "pipeline": 1, "learning": 1, "syncId": 1})
        if not doc:
            raise HTTPException(status_code=404, detail="lesson not found")
        return {"pipeline": doc.get("pipeline"), "learning": doc.get("learning"), "syncId": doc.get("syncId")}

    @api.post("/studio/video/lessons/{lesson_id}/pipeline/run")
    async def pipeline_run_route(lesson_id: str, payload: dict = Body(default={}), _admin=Depends(require_admin)):
        lesson = await db[LESSONS_COLL].find_one({"lessonId": lesson_id}, {"_id": 0})
        if not lesson:
            raise HTTPException(status_code=404, detail="lesson not found")
        if not lesson.get("mediaRef") or not lesson.get("syncId"):
            raise HTTPException(status_code=409, detail="upload media before running the pipeline")
        if (lesson.get("pipeline") or {}).get("state") == "running":
            raise HTTPException(status_code=409, detail="pipeline already running")
        schedule_pipeline(db, lesson_id, sync_studio_tools.get_media_bucket(db))
        return {"ok": True, "scheduled": True, "aiEngine": "gemini" if video_ai_provider.ai_available() else "mock"}

    logger.info("video_pipeline_tools: routes registered (/api/studio/video/*/pipeline)")
