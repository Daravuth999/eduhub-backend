"""video_library_tools.py — Video Library backend: lesson metadata +
backend-owned purchase/entitlement service.

Architecturally independent from Books (per explicit product direction):
this module never imports book_factory_*.py, never touches db.books, and
the Books purchase mechanism (client-driven GAS + Google Form, see
src/eduhub/pages/library/books/{purchaseService,unlocksService}.js in the
frontend repo) is completely untouched by this file. Video Library reuses
only genuinely shared platform infrastructure: the GAS points/treasury
convention (via the isolated video_library_points_adapter.py, mirroring
voice_treasure_points_adapter.py's proven pattern) and the existing
Universal Synchronization Engine (sync_schema.py, referenced by `syncId`,
never re-embedded).

Two collections, both owned exclusively by this module:
  video_lessons    — metadata (title, price, tier, syncId reference, status)
  video_purchases  — the ONLY record of ownership. Primary-keyed by a
                     deterministic `{studentId}::{lessonId}` id, which makes
                     more-than-one purchase record per (student, lesson)
                     pair structurally impossible — not merely unlikely.

Purchase state machine (mirrors voice_treasure_entry_tools.py's proven,
already-production state graph):
    created -> initiating (atomic claim, exactly one concurrent
               request wins) -> succeeded | failed | reconcile
`succeeded` is the only state video_schema.is_owned() treats as owned.
Ambiguous GAS outcomes land in `reconcile` and are NEVER auto-resolved —
an admin route is the only way out of that state, matching this
codebase's own established Voice Treasure/CamRapidPay reconciliation
discipline.

Backend is the sole source of truth throughout: ownership is decided by
reading video_purchases, never by trusting anything the frontend sends.
"""
from __future__ import annotations

import datetime as _dt
import logging

from fastapi import Body, Depends, HTTPException

import video_library_points_adapter as points
from video_schema import (
    RETRYABLE_STATES,
    build_purchase_record,
    build_video_lesson,
    is_owned,
    validate_video_lesson,
)

logger = logging.getLogger("eduhub.video_library")

LESSONS_COLL = "video_lessons"
PURCHASES_COLL = "video_purchases"


def _utcnow_iso() -> str:
    return _dt.datetime.now(_dt.timezone.utc).strftime("%Y-%m-%dT%H:%M:%SZ")


def _purchase_key(student_id: str, lesson_id: str) -> str:
    return f"{student_id}::{lesson_id}"


class VideoLibraryError(Exception):
    def __init__(self, code: str, message: str = "", http_status: int = 400) -> None:
        super().__init__(message or code)
        self.code = code
        self.message = message or code
        self.http_status = http_status


async def ensure_video_library_indexes(db) -> None:
    await db[LESSONS_COLL].create_index("lessonId", unique=True)
    await db[LESSONS_COLL].create_index("status")
    await db[PURCHASES_COLL].create_index("purchaseId", unique=True)
    await db[PURCHASES_COLL].create_index([("studentId", 1), ("lessonId", 1)])
    logger.info("video_library_tools: indexes ready")


# ── Lesson metadata (admin, Video Factory) ─────────────────────────────────
async def create_video_lesson(db, *, title: str, price: int, created_by: str, **kwargs) -> dict:
    doc = build_video_lesson(title=title, price=price, created_by=created_by, created_at=_utcnow_iso(), **kwargs)
    ok, errors = validate_video_lesson(doc)
    if not ok:
        raise VideoLibraryError("invalid_lesson", "; ".join(errors), 400)
    await db[LESSONS_COLL].insert_one(dict(doc))
    doc.pop("_id", None)
    return doc


async def get_video_lesson(db, lesson_id: str) -> dict | None:
    return await db[LESSONS_COLL].find_one({"lessonId": lesson_id}, {"_id": 0})


async def list_video_lessons(db, *, status: str | None = None) -> list[dict]:
    query = {"status": status} if status else {}
    cursor = db[LESSONS_COLL].find(query, {"_id": 0}).sort([("createdAt", -1)])
    return await cursor.to_list(length=500)


async def update_video_lesson(db, lesson_id: str, updates: dict) -> dict:
    existing = await get_video_lesson(db, lesson_id)
    if not existing:
        raise VideoLibraryError("lesson_not_found", f"no lesson {lesson_id!r}", 404)
    safe_updates = {k: v for k, v in updates.items() if k in (
        "title", "subtitle", "thumbnailUrl", "price", "tier", "syncId", "durationSec", "status",
    )}
    merged = {**existing, **safe_updates}
    ok, errors = validate_video_lesson(merged)
    if not ok:
        raise VideoLibraryError("invalid_lesson", "; ".join(errors), 400)
    safe_updates["revision"] = int(existing.get("revision", 1)) + 1
    await db[LESSONS_COLL].update_one({"lessonId": lesson_id}, {"$set": safe_updates})
    merged["revision"] = safe_updates["revision"]
    return merged


# ── Ownership (the ONLY function anything should call to decide access) ────
async def get_purchase(db, student_id: str, lesson_id: str) -> dict | None:
    return await db[PURCHASES_COLL].find_one({"_id": _purchase_key(student_id, lesson_id)}, {"_id": 0})


async def student_owns_lesson(db, student_id: str, lesson_id: str) -> bool:
    return is_owned(await get_purchase(db, student_id, lesson_id))


async def serialize_lesson_for_student(db, lesson: dict, student_id: str | None) -> dict:
    """Backend-computed ownership flag — the frontend never decides this.
    Free lessons (price<=0) are always "owned"; a paid lesson only exposes
    its syncId (the actual transcript/teleprompter reference) once owned —
    everything else (title, thumbnail, price) is always visible so a
    student can browse and decide whether to purchase."""
    price = int(lesson.get("price") or 0)
    owned = price <= 0 or (bool(student_id) and await student_owns_lesson(db, student_id, lesson["lessonId"]))
    out = {**lesson, "owned": owned}
    if not owned:
        out.pop("syncId", None)
    return out


# ── Purchase state machine ──────────────────────────────────────────────────
async def initiate_purchase(
    db, *, student_id: str, lesson_id: str, password: str,
) -> dict:
    lesson = await get_video_lesson(db, lesson_id)
    if not lesson or lesson.get("status") != "published":
        raise VideoLibraryError("lesson_not_found", f"no published lesson {lesson_id!r}", 404)

    price = int(lesson.get("price") or 0)
    if price <= 0:
        raise VideoLibraryError("free_lesson", "this lesson is free — no purchase needed", 400)

    key = _purchase_key(student_id, lesson_id)
    now = _utcnow_iso()

    # (a) idempotent seed — never overwrites an existing record.
    seed = {**build_purchase_record(student_id=student_id, lesson_id=lesson_id, price=price, created_at=now), "_id": key}
    await db[PURCHASES_COLL].update_one({"_id": key}, {"$setOnInsert": seed}, upsert=True)

    # (b) atomic claim — exactly one concurrent request transitions this
    #     purchase out of a retryable state. Every other concurrent caller
    #     gets a clean, non-mutating rejection below.
    # No return_document kwarg — matches this codebase's own established
    # atomic-claim convention (camrapidpay_payment_tools.py): the default
    # pre-image return value is only used for a None-check (did a matching
    # document exist to claim), never read for its field values. The
    # current state is always re-fetched via get_purchase() when needed.
    claimed = await db[PURCHASES_COLL].find_one_and_update(
        {"_id": key, "state": {"$in": RETRYABLE_STATES}},
        {"$set": {"state": "initiating", "updatedAt": now},
         "$push": {"stateHistory": {"state": "initiating", "at": now}}},
    )
    if claimed is None:
        current = await db[PURCHASES_COLL].find_one({"_id": key}, {"_id": 0})
        current_state = (current or {}).get("state")
        if current_state == "succeeded":
            raise VideoLibraryError("already_owned", "you already own this lesson", 409)
        if current_state == "initiating":
            raise VideoLibraryError("in_progress", "a purchase attempt is already in progress", 409)
        raise VideoLibraryError(
            "needs_reconciliation",
            "a prior purchase attempt could not be confirmed and is pending admin review", 409,
        )

    # (c) the ONE real GAS call for this attempt.
    result = await points.debit_purchase(student_id, password, price)
    outcome = result.get("outcome")
    ts = _utcnow_iso()

    if outcome == points.OUTCOME_OK:
        post_balance, _ = await points.get_authoritative_balance(student_id, password)
        await db[PURCHASES_COLL].update_one(
            {"_id": key, "state": "initiating"},
            {"$set": {"state": "succeeded", "pointsAfter": post_balance, "updatedAt": ts},
             "$push": {"stateHistory": {"state": "succeeded", "at": ts}}},
        )
        logger.info("video_library: purchase succeeded student=%s lesson=%s", student_id, lesson_id)
    elif outcome == points.OUTCOME_REJECTED:
        await db[PURCHASES_COLL].update_one(
            {"_id": key, "state": "initiating"},
            {"$set": {"state": "failed", "reason": result.get("reason"), "updatedAt": ts},
             "$push": {"stateHistory": {"state": "failed", "at": ts}}},
        )
    else:  # OUTCOME_AMBIGUOUS — never guessed, never auto-retried.
        await db[PURCHASES_COLL].update_one(
            {"_id": key, "state": "initiating"},
            {"$set": {"state": "reconcile", "reason": result.get("reason"), "updatedAt": ts},
             "$push": {"stateHistory": {"state": "reconcile", "at": ts}}},
        )
        logger.warning("video_library: purchase AMBIGUOUS student=%s lesson=%s reason=%s", student_id, lesson_id, result.get("reason"))

    return await get_purchase(db, student_id, lesson_id)


async def admin_reconcile_purchase(db, student_id: str, lesson_id: str, *, resolution: str, actor: str) -> dict:
    """Admin-only. `resolution` is "succeeded" (confirmed the debit DID
    apply — e.g. verified via reconciliation_balance_probe or GAS ledger)
    or "failed" (confirmed it did NOT apply — safe to let the student
    retry). Only callable from a `reconcile` state."""
    if resolution not in ("succeeded", "failed"):
        raise VideoLibraryError("invalid_resolution", f"invalid resolution: {resolution!r}", 400)
    key = _purchase_key(student_id, lesson_id)
    purchase = await db[PURCHASES_COLL].find_one({"_id": key}, {"_id": 0})
    if not purchase:
        raise VideoLibraryError("purchase_not_found", "no purchase record", 404)
    if purchase.get("state") != "reconcile":
        raise VideoLibraryError("not_reconcilable", f"purchase is in state {purchase.get('state')!r}, not 'reconcile'", 409)

    ts = _utcnow_iso()
    audit = {"actor": actor, "resolution": resolution, "at": ts}
    await db[PURCHASES_COLL].update_one(
        {"_id": key},
        {"$set": {"state": resolution, "updatedAt": ts, "adminReconciliation": audit},
         "$push": {"stateHistory": {"state": resolution, "at": ts, "op": "admin_reconcile"}}},
    )
    return await get_purchase(db, student_id, lesson_id)


def register_video_library_routes(api, db, require_admin, require_student) -> None:
    """Mounts Video Library routes. Matches this codebase's
    register_*_routes(api, db, ...) DI convention exactly."""

    def _raise(exc: VideoLibraryError):
        raise HTTPException(status_code=exc.http_status, detail=exc.message)

    # ── Video Factory (admin) ──────────────────────────────────────────
    @api.post("/studio/video/lessons")
    async def create_lesson_route(payload: dict = Body(...), admin=Depends(require_admin)):
        try:
            doc = await create_video_lesson(
                db,
                title=payload.get("title", ""),
                price=int(payload.get("price", 0)),
                created_by=getattr(admin, "email", ""),
                subtitle=payload.get("subtitle", ""),
                thumbnail_url=payload.get("thumbnailUrl", ""),
                tier=payload.get("tier", "standard"),
                sync_id=payload.get("syncId"),
                duration_sec=float(payload.get("durationSec", 0.0)),
            )
        except VideoLibraryError as exc:
            _raise(exc)
        return {"ok": True, "lesson": doc}

    @api.get("/studio/video/lessons")
    async def list_lessons_admin_route(status: str = "", _admin=Depends(require_admin)):
        docs = await list_video_lessons(db, status=status or None)
        return {"lessons": docs}

    @api.patch("/studio/video/lessons/{lesson_id}")
    async def update_lesson_route(lesson_id: str, payload: dict = Body(...), _admin=Depends(require_admin)):
        try:
            doc = await update_video_lesson(db, lesson_id, payload)
        except VideoLibraryError as exc:
            _raise(exc)
        return {"ok": True, "lesson": doc}

    @api.post("/admin/video/purchases/{student_id}/{lesson_id}/reconcile")
    async def reconcile_route(student_id: str, lesson_id: str, payload: dict = Body(...), admin=Depends(require_admin)):
        try:
            doc = await admin_reconcile_purchase(
                db, student_id, lesson_id,
                resolution=payload.get("resolution", ""),
                actor=getattr(admin, "email", ""),
            )
        except VideoLibraryError as exc:
            _raise(exc)
        return {"ok": True, "purchase": doc}

    # ── Student-facing Video Library ────────────────────────────────────
    @api.get("/video/lessons")
    async def list_lessons_route(student=Depends(require_student)):
        lessons = await list_video_lessons(db, status="published")
        student_id = getattr(student, "clean_id", "") or getattr(student, "student_id", "")
        out = [await serialize_lesson_for_student(db, lesson, student_id) for lesson in lessons]
        return {"lessons": out}

    @api.get("/video/lessons/{lesson_id}")
    async def get_lesson_route(lesson_id: str, student=Depends(require_student)):
        lesson = await get_video_lesson(db, lesson_id)
        if not lesson or lesson.get("status") != "published":
            raise HTTPException(status_code=404, detail="lesson not found")
        student_id = getattr(student, "clean_id", "") or getattr(student, "student_id", "")
        return {"lesson": await serialize_lesson_for_student(db, lesson, student_id)}

    @api.post("/video/lessons/{lesson_id}/purchase")
    async def purchase_route(lesson_id: str, payload: dict = Body(...), student=Depends(require_student)):
        student_id = getattr(student, "clean_id", "") or getattr(student, "student_id", "")
        try:
            purchase = await initiate_purchase(
                db, student_id=student_id, lesson_id=lesson_id, password=payload.get("password", ""),
            )
        except VideoLibraryError as exc:
            _raise(exc)
        return {"ok": purchase.get("state") == "succeeded", "purchase": purchase}

    @api.get("/video/purchases/mine")
    async def my_purchases_route(student=Depends(require_student)):
        student_id = getattr(student, "clean_id", "") or getattr(student, "student_id", "")
        cursor = db[PURCHASES_COLL].find({"studentId": student_id}, {"_id": 0})
        docs = await cursor.to_list(length=500)
        return {"purchases": docs}

    logger.info("video_library_tools: routes registered (/api/video*, /api/studio/video*)")
