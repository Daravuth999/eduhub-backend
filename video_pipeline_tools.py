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
import uuid

import httpx
from fastapi import Body, Depends, HTTPException

import sync_studio_tools
import video_ai_provider
import video_render_tools

logger = logging.getLogger("eduhub.video_pipeline")

LESSONS_COLL = "video_lessons"  # same constant as video_library_tools.LESSONS_COLL

PIPELINE_STEPS = (
    "media_check",
    "audio_extraction",
    "speech_recognition",
    "synchronization",
    "educational_analysis",
    "review_ready",
)

MAX_TRANSCRIBE_BYTES = 300 * 1024 * 1024

# Watchdog ceiling for one complete pipeline run. Root-cause fix for a real
# production incident: the shared Mongo client (server.py) sets no
# socketTimeoutMS, so a stalled read on a dead/half-open connection (or a
# hung GridFS/R2 fetch) can await forever with no exception ever raised —
# run_pipeline's own try/except is correct but never fires, leaving
# pipeline.state="running" in Mongo permanently, with nothing in-process to
# ever revisit it. asyncio.wait_for() below bounds the whole run so a hang
# becomes a truthful "failed" state instead of eternal "running". Generous
# for a single lesson (Gemini transcription + educational analysis).
PIPELINE_TIMEOUT_S = 600


def _now() -> str:
    return _dt.datetime.now(_dt.timezone.utc).strftime("%Y-%m-%dT%H:%M:%SZ")


def _iso_in(seconds: int) -> str:
    return (_dt.datetime.now(_dt.timezone.utc) + _dt.timedelta(seconds=seconds)).strftime("%Y-%m-%dT%H:%M:%SZ")


def _pipeline_is_stale(pipeline_doc: dict | None) -> bool:
    """A 'running' pipeline whose startedAt is older than the watchdog
    ceiling is orphaned — almost certainly a process restart/redeploy that
    killed the in-flight asyncio task before it ever reached run_pipeline's
    except block (a process death is not an exception; nothing catches it).
    Without this, such a lesson could never be retried: the atomic claim
    below would refuse forever, since pipeline.state is stuck at "running"."""
    started = (pipeline_doc or {}).get("startedAt")
    if not started:
        return False
    return started < _iso_in(-PIPELINE_TIMEOUT_S)


def build_pipeline_record(provider_version: str, run_id: str | None = None) -> dict:
    return {
        "runId": run_id or uuid.uuid4().hex[:12],
        "state": "running",
        "currentStep": PIPELINE_STEPS[0],
        "provider": provider_version,
        "steps": {step: {"status": "pending", "error": None, "at": None} for step in PIPELINE_STEPS},
        "startedAt": _now(),
        "finishedAt": None,
        "error": None,
        "log": [{"at": _now(), "step": "queued", "status": "info", "message": "Processing run scheduled"}],
    }


async def _set_step(db, lesson_id: str, run_id: str, step: str, status: str, error: str | None = None) -> None:
    # Fenced on runId (Directive 3 race fix): a poll-triggered self-heal in
    # get_pipeline_status can demote a STILL-genuinely-running pipeline to
    # "failed" purely because it observed a stale startedAt, moments before
    # a manual retry claims a fresh run (new runId) for the same lesson —
    # after which the ORIGINAL _run_stages() coroutine is still alive (a
    # Mongo write doesn't kill an in-process asyncio task) and would
    # otherwise keep writing steps into what is now a DIFFERENT run's
    # document, corrupting it and effectively running two pipelines for one
    # lesson at once. Filtering on the exact runId this call was started
    # with makes a superseded run's writes silently no-op instead.
    updates = {
        f"pipeline.steps.{step}.status": status,
        f"pipeline.steps.{step}.error": error,
        f"pipeline.steps.{step}.at": _now(),
        "pipeline.currentStep": step,
    }
    entry = {"at": _now(), "step": step, "status": status,
             "message": error or f"{step.replace('_', ' ')} {status}"}
    await db[LESSONS_COLL].update_one(
        {"lessonId": lesson_id, "pipeline.runId": run_id},
        {"$set": updates, "$push": {"pipeline.log": {"$each": [entry], "$slice": -80}}},
    )


async def _finish(db, lesson_id: str, run_id: str, state: str, error: str | None = None) -> None:
    # See _set_step's identical runId-fencing comment.
    await db[LESSONS_COLL].update_one(
        {"lessonId": lesson_id, "pipeline.runId": run_id},
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

    # A fresh runId identifies exactly this attempt — every _set_step/
    # _finish call below is fenced on it (see their docstrings) so a
    # superseded run (e.g. a manual retry claimed after self-heal
    # pessimistically marked this run "failed" while it was still
    # genuinely alive) can never corrupt a newer run's document.
    run_id = uuid.uuid4().hex[:12]

    # Stale-claim override: a "running" pipeline whose startedAt is older
    # than PIPELINE_TIMEOUT_S is orphaned (see _pipeline_is_stale) — allow
    # reclaiming it instead of refusing forever, mirroring video_narration_
    # jobs.py's own CLAIM_LEASE_S reclaim pattern from this same codebase.
    claimed = await db[LESSONS_COLL].find_one_and_update(
        {
            "lessonId": lesson_id,
            "$or": [
                {"pipeline.state": {"$ne": "running"}},
                {"pipeline.startedAt": {"$lt": _iso_in(-PIPELINE_TIMEOUT_S)}},
            ],
        },
        {"$set": {"pipeline": build_pipeline_record(provider.provider_version, run_id)}},
    )
    if claimed is None and (lesson.get("pipeline") or {}).get("state") == "running" \
            and not _pipeline_is_stale(lesson.get("pipeline")):
        raise RuntimeError("pipeline already running for this lesson")
    if claimed is None:
        # lesson had no pipeline field at all — seed it directly
        await db[LESSONS_COLL].update_one(
            {"lessonId": lesson_id},
            {"$set": {"pipeline": build_pipeline_record(provider.provider_version, run_id)}},
        )

    sync_id = lesson["syncId"]

    async def _run_stages() -> None:
        # 1 — media check + load
        await _set_step(db, lesson_id, run_id, "media_check", "running")
        raw, content_type = await load_media_bytes(db, media_bucket, lesson["mediaRef"])
        if not raw or len(raw) > MAX_TRANSCRIBE_BYTES:
            raise RuntimeError("media is empty or exceeds the processing size limit")
        stored_ct = lesson.get("contentType") or content_type
        await _set_step(db, lesson_id, run_id, "media_check", "complete")

        # 2 — audio extraction (root-cause fix: speech recognition never
        # needs video frames, but a video-typed lesson was previously sent
        # to the provider in full — for a large upload that means a slow
        # large-file provider upload/processing round trip for no reason.
        # Extracting just the audio track first shrinks a typical few-
        # minute lesson from tens/hundreds of MB down to a few MB, which
        # usually fits the provider's inline-request path entirely. Best-
        # effort and never fatal: any failure here honestly falls back to
        # sending the original media, exactly the pipeline's prior
        # behavior — this step can only make things faster, never break
        # them.
        await _set_step(db, lesson_id, run_id, "audio_extraction", "running")
        transcribe_bytes, transcribe_ct = raw, stored_ct
        # has_audio starts True (the audio-only branch below never probes,
        # and an "unknown" probe result must be treated as "might have
        # audio, proceed as before" — see probe_audio_stream_status's own
        # docstring). Only a POSITIVELY CONFIRMED absent stream sets this
        # False; ambiguity must never cause real speech to be skipped.
        has_audio = True
        if "video" in (stored_ct or "").lower():
            audio_status = await video_render_tools.probe_audio_stream_status(raw, content_type=stored_ct)
            if audio_status == "absent":
                # Root-cause fix for a real production incident: a genuinely
                # silent video was previously falling through to "extraction
                # failed — send the original video", which then sent the
                # ENTIRE raw file (sometimes 100+MB) through Gemini's Files
                # API purely to be told there is no speech — slow enough to
                # trip the pipeline watchdog on a large upload. A confirmed-
                # absent audio stream is known locally, in milliseconds, via
                # ffprobe, so speech recognition is skipped outright instead.
                has_audio = False
                await _set_step(
                    db, lesson_id, run_id, "audio_extraction", "complete",
                    "no audio track detected — this video is silent",
                )
            else:
                try:
                    extracted = await video_render_tools.extract_audio_track(raw, stored_ct)
                except Exception as exc:  # noqa: BLE001
                    logger.warning("video_pipeline: audio extraction errored lesson=%s (%s)", lesson_id, exc)
                    extracted = None
                if extracted:
                    transcribe_bytes, transcribe_ct = extracted, "audio/mpeg"
                    await _set_step(db, lesson_id, run_id, "audio_extraction", "complete")
                else:
                    await _set_step(
                        db, lesson_id, run_id, "audio_extraction", "complete",
                        "extraction unavailable or failed — sending original video to the provider",
                    )
        else:
            await _set_step(db, lesson_id, run_id, "audio_extraction", "complete", "media is already audio-only")

        # 3 — speech recognition (Gemini / mock, provider-neutral surface).
        # Skipped entirely — never "running" then "failed" — for a
        # confirmed-silent video: there is nothing to transcribe, and this
        # is an expected, valid production mode (a purely visual lesson),
        # not an error condition (see Section 5/13 of the silent-video
        # production spec this satisfies).
        if has_audio:
            await _set_step(db, lesson_id, run_id, "speech_recognition", "running")
            await sync_studio_tools.mark_alignment_processing(db, sync_id)
            result = await provider.align(transcribe_bytes, transcribe_ct)
            transcript_text = result.get("transcriptText", "")
            await _set_step(db, lesson_id, run_id, "speech_recognition", "complete")

            # 3 — synchronization generation (canonical schema, versioned)
            await _set_step(db, lesson_id, run_id, "synchronization", "running")
            sync_doc = await sync_studio_tools.apply_alignment_result(db, sync_id, result["sync"])
            duration = float(sync_doc.get("durationSec") or 0.0)
            if duration > 0:
                await db[LESSONS_COLL].update_one(
                    {"lessonId": lesson_id, "durationSec": {"$in": [0, 0.0, None]}},
                    {"$set": {"durationSec": round(duration, 3)}},
                )
            await _set_step(db, lesson_id, run_id, "synchronization", "complete")
        else:
            transcript_text = ""
            await _set_step(db, lesson_id, run_id, "speech_recognition", "skipped",
                             "no audio track — nothing to transcribe")
            # An empty-but-valid sync document (the SAME shape a real
            # zero-segment Gemini answer would produce via segments_to_
            # sync([...])) — so every downstream consumer (Story Analysis's
            # transcript lookup, Sync Review Studio, the student Teleprompter)
            # sees one consistent, genuinely valid document, never one stuck
            # mid-"processing".
            empty_sync = video_ai_provider.segments_to_sync(
                [], provider_category="speech_recognition", provider_version="no-audio-v1",
                generated_at=_now(),
            )
            await sync_studio_tools.apply_alignment_result(db, sync_id, empty_sync)
            await _set_step(db, lesson_id, run_id, "synchronization", "skipped",
                             "no transcript to synchronize — this video has no audio")

        # Real memory-pressure fix: `raw` holds the full original upload in
        # memory (up to MAX_TRANSCRIBE_BYTES, ~300MB) and `transcribe_bytes`
        # may alias it. Neither is read again anywhere below this point —
        # educational analysis and review_ready work off `transcript_text`/
        # Mongo documents only — but as local variables in this closure
        # they would otherwise stay resident for the rest of the run purely
        # because the frame still references them. On a large video this is
        # real, avoidable memory held during Gemini analysis + Mongo I/O,
        # not bounded by anything else in this function.
        del raw, transcribe_bytes

        # 4 — Gemini educational analysis (never sinks the pipeline). An
        # empty transcript — whether from a silent video or from real audio
        # that simply has no speech — is an EXPECTED, valid state, never a
        # failure: this text-based stage genuinely has nothing to analyze,
        # and the visual Story Analysis path (Gemini 2.5 Pro, independent
        # of this pipeline) is what understands a purely visual lesson.
        if not transcript_text.strip():
            await _set_step(
                db, lesson_id, run_id, "educational_analysis", "skipped",
                "no transcript to analyze — run Story Analysis for visual understanding",
            )
        else:
            await _set_step(db, lesson_id, run_id, "educational_analysis", "running")
            # Bilingual (Khmer) learning layer: the sync document's own
            # already-timed sentence units (id + English text) are handed
            # to the SAME Gemini call as the English learning analysis —
            # never a second, per-sentence request — so translation is
            # keyed by the REAL sentence id, never a positional guess.
            sentence_list = video_ai_provider.sentences_from_sync_document(sync_doc)
            analysis = await video_ai_provider.analyze_transcript(
                transcript_text, sentences=sentence_list, title=lesson.get("title", ""),
            )
            if analysis.get("ok"):
                learning = {**analysis["learning"], "engine": analysis.get("engine"), "generatedAt": _now()}
                await db[LESSONS_COLL].update_one(
                    {"lessonId": lesson_id}, {"$set": {"learning": learning}},
                )
                if learning.get("speakerLabels"):
                    await sync_studio_tools.suggest_speaker_labels(db, sync_id, learning["speakerLabels"])
                # Translation is an ADDITIONAL educational layer, never a
                # single point of failure for the English lesson (Directive
                # §20): applied best-effort, any failure here is logged
                # honestly but never flips this already-succeeded stage to
                # "failed" — the English learning content stands on its own
                # regardless of whether Khmer translation attached cleanly.
                translations = analysis.get("sentenceTranslations") or []
                if translations:
                    try:
                        await sync_studio_tools.apply_sentence_translations(db, sync_id, translations)
                    except Exception as exc:  # noqa: BLE001
                        logger.warning(
                            "video_pipeline: sentence translation apply failed lesson=%s (%s)", lesson_id, exc,
                        )
                await _set_step(db, lesson_id, run_id, "educational_analysis", "complete")
            else:
                await _set_step(db, lesson_id, run_id, "educational_analysis", "failed", analysis.get("reason"))

        # 5 — review ready
        await _set_step(db, lesson_id, run_id, "review_ready", "complete")
        await _finish(db, lesson_id, run_id, "complete")
        logger.info("video_pipeline: complete lesson=%s provider=%s", lesson_id, provider.provider_version)

    logger.info("video_pipeline: START lesson=%s provider=%s", lesson_id, provider.provider_version)
    try:
        # Concurrency cap first (see video_render_tools.heavy_op_semaphore):
        # bounds how many lessons' worth of raw media + Gemini/ffmpeg work
        # can be resident in memory across the whole process at once — the
        # per-lesson claim above only prevents the SAME lesson running
        # twice, not multiple different lessons piling up simultaneously.
        # Diagnostic instrumentation (Directive 3 §18): logging how long
        # this run waited for a slot separates "genuinely slow processing"
        # from "healthy but queued behind other lessons" in a future
        # production investigation — never logged as part of the per-stage
        # Mongo pipeline.log the Studio UI reads, since that only makes
        # sense once processing has actually started.
        _wait_started = _dt.datetime.now(_dt.timezone.utc)
        async with video_render_tools.heavy_op_semaphore:
            queued_s = (_dt.datetime.now(_dt.timezone.utc) - _wait_started).total_seconds()
            if queued_s > 1.0:
                logger.info("video_pipeline: lesson=%s waited %.1fs for a processing slot", lesson_id, queued_s)
            # Watchdog inside the cap: bounds the whole run so a stalled I/O
            # call (dead Mongo connection, hung GridFS/R2 fetch — see
            # PIPELINE_TIMEOUT_S) becomes a truthful "failed" state instead
            # of an eternal "running" one, measured from when processing
            # actually starts rather than including time spent queued.
            await asyncio.wait_for(_run_stages(), timeout=PIPELINE_TIMEOUT_S)
    except Exception as exc:  # noqa: BLE001
        message = (
            f"Processing timed out after {PIPELINE_TIMEOUT_S}s (stalled I/O — retry is safe)"
            if isinstance(exc, asyncio.TimeoutError) else f"{type(exc).__name__}: {exc}"
        )
        logger.exception("video_pipeline: FAILED lesson=%s", lesson_id)
        current = await db[LESSONS_COLL].find_one({"lessonId": lesson_id}, {"_id": 0, "pipeline": 1})
        step = ((current or {}).get("pipeline") or {}).get("currentStep") or "media_check"
        await _set_step(db, lesson_id, run_id, step, "failed", message)
        await _finish(db, lesson_id, run_id, "failed", message)
        try:
            await sync_studio_tools.mark_alignment_failed(db, sync_id)
        except Exception:  # noqa: BLE001
            pass

    final = await db[LESSONS_COLL].find_one({"lessonId": lesson_id}, {"_id": 0, "pipeline": 1})
    return (final or {}).get("pipeline") or {}


async def get_pipeline_status(db, lesson_id: str) -> dict:
    """Read path for the Studio's ~2.5s poller. Self-heals a stale
    "running" pipeline THE MOMENT it's observed: if the recorded run
    started longer ago than PIPELINE_TIMEOUT_S, the process that was
    running it is provably gone (a redeploy/crash/OOM kill — run_pipeline's
    own asyncio.wait_for watchdog dies WITH the process, so it never gets
    a chance to fire and mark the job failed). Without this, PipelinePanel.
    jsx's retry button stays hidden forever (`!running &&` — see its
    render logic), a genuine dead end: pipeline_run_route already has the
    matching _pipeline_is_stale override to allow a manual retry, but
    nothing can ever reach it if the button that calls it is never shown.
    Marking it failed HERE, on every poll, means the very next poll shows
    an honest, retryable state instead of an indefinite spinner."""
    doc = await db[LESSONS_COLL].find_one(
        {"lessonId": lesson_id}, {"_id": 0, "pipeline": 1, "learning": 1, "syncId": 1},
    )
    if not doc:
        return {}
    pipeline_doc = doc.get("pipeline")
    if pipeline_doc and pipeline_doc.get("state") == "running" and _pipeline_is_stale(pipeline_doc):
        message = (
            f"Processing stalled — no progress in over {PIPELINE_TIMEOUT_S}s "
            "(the server likely restarted mid-run). Safe to retry."
        )
        current_step = pipeline_doc.get("currentStep") or PIPELINE_STEPS[0]
        # Fence this self-heal write to the exact run it observed (None for
        # a legacy pre-runId doc — Mongo's equality match on a missing/null
        # field still matches, so old in-flight pipelines self-heal exactly
        # as before). See _set_step's docstring for why this matters.
        run_id = pipeline_doc.get("runId")
        await _set_step(db, lesson_id, run_id, current_step, "failed", message)
        await _finish(db, lesson_id, run_id, "failed", message)
        sync_id = doc.get("syncId")
        if sync_id:
            try:
                await sync_studio_tools.mark_alignment_failed(db, sync_id)
            except Exception:  # noqa: BLE001
                pass
        doc = await db[LESSONS_COLL].find_one(
            {"lessonId": lesson_id}, {"_id": 0, "pipeline": 1, "learning": 1, "syncId": 1},
        )
    return doc or {}


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
        doc = await get_pipeline_status(db, lesson_id)
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
        pipeline_doc = lesson.get("pipeline") or {}
        # A "running" pipeline older than the watchdog ceiling is orphaned
        # (see _pipeline_is_stale) — let the admin retry it manually instead
        # of the button staying refused forever with no way out.
        if pipeline_doc.get("state") == "running" and not _pipeline_is_stale(pipeline_doc):
            raise HTTPException(status_code=409, detail="pipeline already running")
        schedule_pipeline(db, lesson_id, sync_studio_tools.get_media_bucket(db))
        return {"ok": True, "scheduled": True, "aiEngine": "gemini" if video_ai_provider.ai_available() else "mock"}

    logger.info("video_pipeline_tools: routes registered (/api/studio/video/*/pipeline)")
