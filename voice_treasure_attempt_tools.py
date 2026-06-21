"""voice_treasure_attempt_tools.py
==================================
Voice Treasure — Core Game milestone: mission image, recorder submission,
multimodal evaluation, attempt persistence + ownership + result recovery.

Isolated. Imports only own VT modules + the Gemini adapter. No reward payout,
no chest, no collection/progress (later milestones). GAS untouched here —
playing requires an already-PAID entry (state `succeeded`) created by
voice_treasure_entry_tools.

Privacy: raw audio is validated, sent to the evaluator, and DISCARDED. It is
never persisted, never written to R2, never logged, never put in localStorage.
Only the normalized evaluation result is stored.

Routes
------
  GET  /api/voice-treasure/mission/{mission_id}/image   (student, fallback img)
  POST /api/voice-treasure/submit-attempt               (student, multipart)
  GET  /api/voice-treasure/attempt/{attempt_id}         (student, ownership)
  GET  /api/admin/voice-treasure/attempts               (admin)
  GET  /api/admin/voice-treasure/attempts/{attempt_id}  (admin)

Attempt state machine
---------------------
  created → evaluating → evaluated
                       → evaluation_unavailable   (retryable; provider off)
                       → evaluation_failed          (retryable; provider error)
One attempt record per paid entry (_id = vt-attempt:{student_id}:{entry_id}).
Re-submission after a non-evaluated state is allowed (retry); a successful
`evaluated` attempt is returned as-is (idempotent, never re-charged/re-run).
"""
from __future__ import annotations

import logging
from datetime import datetime, timezone
from typing import Any

# NOTE: `from __future__ import annotations` (above) turns every annotation in
# this module into a STRING that FastAPI/Pydantic must resolve against this
# module's globals at request time. The multipart endpoint below annotates a
# parameter as `UploadFile`, so that name MUST live in the module namespace —
# importing it only inside register_*_routes() leaves the ForwardRef unresolved
# and makes every /submit-attempt call 500 on Python 3.14. Keep this here.
from fastapi import File, Form, UploadFile

try:
    # pymongo>=4 ships ReturnDocument used for the atomic compare-and-set
    # claim below. Imported at module top so a missing pymongo fails fast
    # at startup rather than at the first submission.
    from pymongo import ReturnDocument
except ImportError:  # pragma: no cover — pymongo is a hard dep via motor
    ReturnDocument = None  # type: ignore[assignment]

import voice_treasure_config_tools as vt_cfg
import voice_treasure_entry_tools as vt_entry
import voice_treasure_gemini as vt_gemini

log = logging.getLogger("eduhub.voice_treasure.attempt")

COLL_ATTEMPTS = "voice_treasure_attempts"

A_CREATED = "created"
A_EVALUATING = "evaluating"
A_EVALUATED = "evaluated"
A_UNAVAILABLE = "evaluation_unavailable"
A_FAILED = "evaluation_failed"
_RETRYABLE = {A_UNAVAILABLE, A_FAILED, A_CREATED}

# Audio upload validation
MAX_AUDIO_BYTES = 12 * 1024 * 1024  # 12 MB hard ceiling
ALLOWED_AUDIO_MIME = {
    "audio/webm", "audio/ogg", "audio/mp4", "audio/mpeg",
    "audio/mp3", "audio/wav", "audio/x-wav", "audio/aac", "audio/m4a",
}


def _utcnow_iso() -> str:
    return datetime.now(timezone.utc).isoformat()


def _attempt_key(sid: str, entry_id: str) -> str:
    return f"vt-attempt:{sid}:{entry_id}"


def _attempt_view(a: dict) -> dict[str, Any]:
    """Student-safe attempt projection. Returns ONLY the fixed evaluation
    contract fields — never any invented metric, never raw provider text."""
    out = {
        "attempt_id": a.get("attempt_id"),
        "entry_id": a.get("entry_id"),
        "mission_id": a.get("mission_id"),
        "state": a.get("state"),
        "evaluated": a.get("state") == A_EVALUATED,
        "reason": a.get("public_reason"),
        "updated_at": a.get("updated_at"),
    }
    res = a.get("result")
    if a.get("state") == A_EVALUATED and isinstance(res, dict):
        out["result"] = {
            "scores": {k: int(res["scores"][k]) for k in vt_gemini.EVAL_CATEGORIES
                       if k in (res.get("scores") or {})},
            "overall": res.get("overall"),
            "understanding_summary": res.get("understanding_summary"),
            "strongest_skill": res.get("strongest_skill"),
            "next_improvement": res.get("next_improvement"),
            "coach_feedback": res.get("coach_feedback"),
        }
    return out


async def ensure_voice_treasure_attempt_indexes(db) -> None:
    try:
        await db[COLL_ATTEMPTS].create_index([("student_id", 1), ("mission_date", 1)])
        await db[COLL_ATTEMPTS].create_index([("state", 1), ("updated_at", -1)])
    except Exception as exc:  # noqa: BLE001
        log.warning("voice_treasure: attempt index ensure failed (non-fatal): %s", exc)


def register_voice_treasure_attempt_routes(api, db, require_admin, require_student) -> None:
    from fastapi import Depends, HTTPException
    # UploadFile/File/Form are imported at module level (see top-of-file note)
    # so the string annotation `audio: UploadFile` resolves under
    # `from __future__ import annotations`.

    def _sid(student) -> str:
        return str(getattr(student, "student_id", "") or "")

    def _groups(student) -> list[str]:
        for attr in ("groups", "group", "class_name", "class_id", "level"):
            v = getattr(student, attr, None)
            if isinstance(v, list):
                return v
            if isinstance(v, str) and v.strip():
                return [v.strip()]
        return []

    async def _gate(student):
        cfg = await vt_cfg.load_config(db)
        pub = vt_cfg.public_projection(cfg, student_id=_sid(student), groups=_groups(student))
        if not pub.get("available"):
            raise HTTPException(status_code=403, detail="voice_treasure_unavailable")
        return cfg, pub

    # ── Mission image (metadata + delivery contract) ─────────────────────
    # For BUNDLED missions, returns the bundled asset key the frontend maps.
    # For GENERATED missions, returns the authenticated content URL so the
    # frontend never receives bytes here and never sees a backend filesystem
    # path or model name.
    @api.get("/voice-treasure/mission/{mission_id}/image")
    async def vt_mission_image(mission_id: str, student=Depends(require_student)):
        await _gate(student)
        sid = _sid(student)
        # Mission is owned per-student/day; locate it without trusting the id.
        date = vt_entry._today()
        mkey = vt_entry._mission_key(sid, date)
        mission = await db[vt_entry.COLL_MISSIONS].find_one({"_id": mkey}, {"_id": 0})
        if not mission or mission.get("mission_id") != mission_id:
            raise HTTPException(status_code=404, detail="mission_not_found")
        kind = mission.get("image_kind", "bundled")
        resp = {
            "mission_id": mission_id,
            "scene_id": mission.get("scene_id"),
            "image_kind": kind,
            "image_ref": mission.get("image_ref", vt_gemini.FALLBACK_IMAGE_REF),
            "title": mission.get("title"),
            "alt": mission.get("alt"),
            "prompt": mission.get("prompt"),
        }
        if kind == "generated":
            # Authenticated content URL — the frontend renders THIS exact URL
            # for generated missions. No bytes are leaked here, only a path
            # whose ownership is re-checked at fetch time.
            resp["image_url"] = (
                f"/api/voice-treasure/mission/"
                f"{mission_id}/image/content"
            )
        return resp

    # ── Authenticated generated-image content (durable bytes) ────────────
    # Streams the EXACT assigned image for a GENERATED mission. Bundled
    # missions return 409 — the frontend uses the bundled asset for those.
    # Re-verifies ownership + that the entry is paid (or recoverable per
    # reopen/replace rules) so an unpaid student cannot scrape image bytes.
    @api.get("/voice-treasure/mission/{mission_id}/image/content")
    async def vt_mission_image_content(mission_id: str, student=Depends(require_student)):
        from fastapi.responses import Response
        await _gate(student)
        sid = _sid(student)
        date = vt_entry._today()
        mkey = vt_entry._mission_key(sid, date)
        mission = await db[vt_entry.COLL_MISSIONS].find_one({"_id": mkey}, {"_id": 0})
        if not mission or mission.get("mission_id") != mission_id:
            raise HTTPException(status_code=404, detail="mission_not_found")
        if mission.get("student_id") != sid:
            # Cross-student access is impossible by mission key, but guard explicitly.
            raise HTTPException(status_code=404, detail="mission_not_found")
        if mission.get("image_kind") != "generated":
            raise HTTPException(status_code=409, detail="not_generated")
        # Playable, OR previously paid (reopen/replace) — never expose bytes
        # for an unpaid student.
        ekey = vt_entry._entry_key(sid, date, mission_id)
        entry = await db[vt_entry.COLL_ENTRIES].find_one({"_id": ekey}, {"_id": 0})
        if not entry or entry.get("state") != vt_entry.S_SUCCEEDED:
            raise HTTPException(status_code=403, detail="mission_not_paid")
        object_key = mission.get("image_ref")
        try:
            import voice_treasure_media as vt_media
            data, mime, _meta = await vt_media.load_generated_image_durable(db, object_key)
        except Exception as exc:  # noqa: BLE001
            # The student saw a generated mission but the bytes can no longer
            # be resolved — DO NOT serve a different scene silently. Return
            # 503 so the frontend can request authoritative recovery.
            log.warning("voice_treasure: image_content load failed: %s", type(exc).__name__)
            raise HTTPException(status_code=503, detail="image_unavailable") from exc
        headers = {
            # Private cache only; never edge-cached. Authenticated endpoint.
            "Cache-Control": "private, max-age=300",
            # Prevent the client from sniffing the type and downgrading.
            "X-Content-Type-Options": "nosniff",
        }
        return Response(content=data, media_type=mime, headers=headers)

    # ── Submit attempt (multipart audio) ──
    @api.post("/voice-treasure/submit-attempt")
    async def vt_submit_attempt(
        entry_id: str = Form(...),
        audio: UploadFile = File(...),
        student=Depends(require_student),
    ):
        cfg, pub = await _gate(student)
        sid = _sid(student)

        # 1) Entry must exist, be owned by this student, and be PAID.
        entry = await db[vt_entry.COLL_ENTRIES].find_one({"_id": entry_id}, {"_id": 0})
        if not entry or entry.get("student_id") != sid:
            raise HTTPException(status_code=404, detail="entry_not_found")
        if entry.get("state") != vt_entry.S_SUCCEEDED:
            raise HTTPException(status_code=409, detail="entry_not_paid")

        akey = _attempt_key(sid, entry_id)
        # NOTE: The legacy read-then-unconditional-update path was vulnerable
        # to a race where two concurrent submissions for the same (student,
        # entry) could both observe state == "created" and both proceed to
        # call Gemini. v6 fix: a single atomic compare-and-set
        # (find_one_and_update) on the persisted state below claims the slot
        # for exactly one caller. Validate audio + load the assigned image
        # BEFORE the claim so a malformed request does not consume the
        # one-shot transition.

        # 2) Validate audio (size + MIME). Read once.
        ctype = (audio.content_type or "").split(";")[0].strip().lower()
        if ctype not in ALLOWED_AUDIO_MIME:
            raise HTTPException(status_code=415, detail="unsupported_audio_type")
        data = await audio.read()
        if not data:
            raise HTTPException(status_code=400, detail="empty_audio")
        if len(data) > MAX_AUDIO_BYTES:
            raise HTTPException(status_code=413, detail="audio_too_large")

        # 3) Resolve mission context (scene grounding for evaluation).
        date = entry.get("mission_date") or vt_entry._today()
        mkey = vt_entry._mission_key(sid, date)
        mission = await db[vt_entry.COLL_MISSIONS].find_one({"_id": mkey}, {"_id": 0})
        image_ref = (mission or {}).get("image_ref", vt_gemini.FALLBACK_IMAGE_REF)
        mission_id = (mission or {}).get("mission_id") or entry.get("mission_id")
        image_kind = (mission or {}).get("image_kind", "bundled")
        # Ground on the assigned bundled scene's rubric/prompt/keywords when present.
        scene_id = (mission or {}).get("scene_id")
        import voice_treasure_scenes as vt_scenes
        if scene_id:
            scene = vt_scenes.SCENES_BY_ID.get(scene_id)
            context = vt_scenes.grounding_context(scene) if scene else \
                vt_gemini.mission_context_for(image_ref)
        else:
            context = vt_gemini.mission_context_for(image_ref)

        # 3b) Load the EXACT assigned image bytes server-side. The image sent to
        # the evaluator is resolved ONLY from the authoritative mission record
        # (scene_id / generated ref) — never from a client-supplied path. A
        # missing/invalid/oversized image fails the evaluation SAFELY (no
        # fabricated scores, paid entry preserved, retryable) rather than
        # silently evaluating without the picture.
        image_bytes: bytes | None = None
        image_mime: str | None = None
        image_load_error: str | None = None
        try:
            if image_kind == "generated" and image_ref:
                # Durable bytes path — opaque object_key → GridFS bytes,
                # verified by hash + size + allowed MIME before use.
                import voice_treasure_media as vt_media
                try:
                    image_bytes, image_mime, _meta = await vt_media.load_generated_image_durable(db, image_ref)
                except vt_media.MediaStorageError as exc:
                    image_load_error = str(exc)
            elif scene_id:
                image_bytes, image_mime = vt_scenes.load_scene_image_bytes(scene_id)
            else:
                image_load_error = "no_assigned_image"
        except vt_scenes.SceneAssetError as exc:
            image_load_error = str(exc)

        # 4) Claim the evaluation slot ATOMICALLY.
        # We seed the attempt document idempotently, then perform a single
        # find_one_and_update that transitions state ∈ _RETRYABLE
        # (= {created, evaluation_failed, evaluation_unavailable}) to
        # "evaluating". MongoDB guarantees this is atomic at the document
        # level, so under N concurrent submissions only ONE returns a
        # claimed doc; the others see `None` and short-circuit without
        # calling Gemini.
        now = _utcnow_iso()
        seed = {
            "_id": akey, "attempt_id": akey, "student_id": sid,
            "entry_id": entry_id, "mission_id": mission_id, "mission_date": date,
            "state": A_CREATED, "result": None, "reason": None,
            "public_reason": None, "submit_count": 0,
            "created_at": now, "updated_at": now,
        }
        await db[COLL_ATTEMPTS].update_one({"_id": akey}, {"$setOnInsert": seed}, upsert=True)

        claim_filter = {"_id": akey, "state": {"$in": list(_RETRYABLE)}}
        claim_update = {
            "$set": {"state": A_EVALUATING, "updated_at": _utcnow_iso(),
                     "reason": None, "public_reason": None},
            "$inc": {"submit_count": 1},
        }
        if ReturnDocument is not None:
            claimed = await db[COLL_ATTEMPTS].find_one_and_update(
                claim_filter, claim_update,
                projection={"_id": 0},
                return_document=ReturnDocument.AFTER,
            )
        else:  # pragma: no cover — degraded fallback only if pymongo is absent
            claimed = await db[COLL_ATTEMPTS].find_one_and_update(
                claim_filter, claim_update, projection={"_id": 0},
            )

        if claimed is None:
            # We did not win the claim. Discard buffered audio immediately
            # (never persist, never re-call the provider) and surface the
            # current persisted state. Non-retryable / ambiguous states are
            # rejected SAFELY — Gemini is NOT called.
            del data
            existing = await db[COLL_ATTEMPTS].find_one({"_id": akey}, {"_id": 0})
            if existing and existing.get("state") == A_EVALUATED:
                return {"attempt": _attempt_view(existing), "already_evaluated": True}
            if existing and existing.get("state") == A_EVALUATING:
                return {"attempt": _attempt_view(existing), "in_progress": True}
            # Any other state (manual reconciliation / unknown) — refuse,
            # but never re-charge and never call Gemini.
            raise HTTPException(status_code=409, detail="attempt_not_retryable")

        # 5) Evaluate (raw audio + image used in-memory only, then discarded).
        # If the authoritative image could not be loaded, do NOT evaluate without
        # it — mark unavailable (retryable), keep the paid entry intact.
        if image_bytes is None:
            await db[COLL_ATTEMPTS].update_one(
                {"_id": akey},
                {"$set": {"state": A_UNAVAILABLE, "reason": "image_unavailable",
                          "public_reason": "evaluation_unavailable",
                          "image_error": image_load_error, "updated_at": _utcnow_iso()}},
            )
            del data
            final = await db[COLL_ATTEMPTS].find_one({"_id": akey}, {"_id": 0})
            return {"attempt": _attempt_view(final or {})}

        tone = (cfg.get("speaking") or {}).get("feedback_tone") or "encouraging"
        ev = await vt_gemini.evaluate_speaking(
            audio_bytes=data, audio_mime=ctype, mission_context=context,
            feedback_tone=tone, image_bytes=image_bytes, image_mime=image_mime,
        )
        del data          # discard raw audio explicitly
        image_bytes = None  # discard raw image bytes explicitly (never persisted)

        if ev.get("ok"):
            await db[COLL_ATTEMPTS].update_one(
                {"_id": akey},
                {"$set": {"state": A_EVALUATED, "result": ev["result"],
                          "public_reason": None, "updated_at": _utcnow_iso()}},
            )
        else:
            reason = ev.get("reason", "evaluation_failed")
            state = A_UNAVAILABLE if reason == "evaluation_unavailable" else A_FAILED
            await db[COLL_ATTEMPTS].update_one(
                {"_id": akey},
                {"$set": {"state": state, "reason": reason,
                          "public_reason": reason, "updated_at": _utcnow_iso()}},
            )

        final = await db[COLL_ATTEMPTS].find_one({"_id": akey}, {"_id": 0})
        return {"attempt": _attempt_view(final or {})}

    # ── Result recovery (ownership-checked) ──
    @api.get("/voice-treasure/attempt/{attempt_id}")
    async def vt_get_attempt(attempt_id: str, student=Depends(require_student)):
        sid = _sid(student)
        a = await db[COLL_ATTEMPTS].find_one({"_id": attempt_id}, {"_id": 0})
        if not a or a.get("student_id") != sid:
            raise HTTPException(status_code=404, detail="attempt_not_found")
        return {"attempt": _attempt_view(a)}

    # ── Admin views ──
    @api.get("/admin/voice-treasure/attempts")
    async def vt_admin_attempts(state: str | None = None, limit: int = 100,
                                admin=Depends(require_admin)):
        q: dict[str, Any] = {}
        if state:
            q["state"] = state
        limit = max(1, min(int(limit or 100), 500))
        cur = db[COLL_ATTEMPTS].find(q, {"_id": 0}).sort("updated_at", -1).limit(limit)
        rows = [r async for r in cur]
        return {"attempts": rows, "count": len(rows)}

    @api.get("/admin/voice-treasure/attempts/{attempt_id}")
    async def vt_admin_attempt(attempt_id: str, admin=Depends(require_admin)):
        a = await db[COLL_ATTEMPTS].find_one({"_id": attempt_id}, {"_id": 0})
        if not a:
            raise HTTPException(status_code=404, detail="attempt_not_found")
        return {"attempt": a}

    log.info("voice_treasure: attempt routes registered (Core Game milestone).")
