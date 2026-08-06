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

from fastapi import Body, Depends, File, Form, HTTPException, UploadFile
from motor.motor_asyncio import AsyncIOMotorGridFSBucket

import video_library_points_adapter as points
import sync_studio_tools
from video_schema import (
    RETRYABLE_STATES,
    build_bookmark_record,
    build_progress_record,
    build_purchase_record,
    build_video_lesson,
    is_owned,
    validate_video_lesson,
)

logger = logging.getLogger("eduhub.video_library")

LESSONS_COLL = "video_lessons"
PURCHASES_COLL = "video_purchases"
PROGRESS_COLL = "video_progress"
BOOKMARKS_COLL = "video_bookmarks"


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
    await db[LESSONS_COLL].create_index([("status", 1), ("category", 1)])
    await db[LESSONS_COLL].create_index([("status", 1), ("difficulty", 1)])
    await db[PURCHASES_COLL].create_index("purchaseId", unique=True)
    await db[PURCHASES_COLL].create_index([("studentId", 1), ("lessonId", 1)])
    await db[PROGRESS_COLL].create_index([("studentId", 1), ("lessonId", 1)])
    await db[PROGRESS_COLL].create_index([("studentId", 1), ("updatedAt", -1)])
    await db[BOOKMARKS_COLL].create_index([("studentId", 1), ("lessonId", 1)])
    await db[BOOKMARKS_COLL].create_index([("studentId", 1), ("createdAt", -1)])
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


async def list_video_lessons(
    db, *, status: str | None = None, category: str | None = None, difficulty: str | None = None,
) -> list[dict]:
    """Discovery filters (category/difficulty) power the standalone
    dashboard's category rows and level tabs — additive query params, never
    a second listing function."""
    query: dict = {}
    if status:
        query["status"] = status
    if category:
        query["category"] = category
    if difficulty:
        query["difficulty"] = difficulty
    cursor = db[LESSONS_COLL].find(query, {"_id": 0}).sort([("createdAt", -1)])
    return await cursor.to_list(length=500)


async def update_video_lesson(db, lesson_id: str, updates: dict) -> dict:
    existing = await get_video_lesson(db, lesson_id)
    if not existing:
        raise VideoLibraryError("lesson_not_found", f"no lesson {lesson_id!r}", 404)
    safe_updates = {k: v for k, v in updates.items() if k in (
        "title", "subtitle", "thumbnailUrl", "price", "tier", "syncId", "mediaRef", "durationSec", "status",
        "instructor", "category", "difficulty", "cefrLevel", "estimatedStudyMinutes", "featured",
    )}
    merged = {**existing, **safe_updates}
    ok, errors = validate_video_lesson(merged)
    if not ok:
        raise VideoLibraryError("invalid_lesson", "; ".join(errors), 400)
    safe_updates["revision"] = int(existing.get("revision", 1)) + 1
    await db[LESSONS_COLL].update_one({"lessonId": lesson_id}, {"$set": safe_updates})
    merged["revision"] = safe_updates["revision"]
    return merged


async def attach_lesson_media(
    db, lesson_id: str, *, raw: bytes, declared_content_type: str, media_bucket, uploaded_by: str = "",
) -> dict:
    """Upload a lesson's video/audio and bind the resulting syncId AND
    mediaRef onto it. Reuses sync_studio_tools.create_sync_from_upload —
    the SAME storage validation, R2-first/GridFS-fallback, and canonical
    schema Books uses — via its public function, never by touching the
    chapter_sync collection directly (that stays exclusively owned by
    sync_studio_tools.py, per tools/check_collection_ownership.py).
    `owner_ref` (not `slug`/`chapter_index`) is how this product binds to
    the shared, provider-neutral Universal Synchronization Engine without
    either module knowing about the other's domain.

    `mediaRef` is denormalized onto the lesson itself (not fetched from
    the sync document at playback time) so video playback never depends
    on sync_schema.is_servable_to_students()'s alignment-readiness gate —
    see build_video_lesson()'s docstring for why that gate must stay
    scoped to captions/highlighting only."""
    lesson = await get_video_lesson(db, lesson_id)
    if not lesson:
        raise VideoLibraryError("lesson_not_found", f"no lesson {lesson_id!r}", 404)

    try:
        sync_doc = await sync_studio_tools.create_sync_from_upload(
            db, raw=raw, declared_content_type=declared_content_type, media_bucket=media_bucket,
            owner_ref=f"video_lesson:{lesson_id}", uploaded_by=uploaded_by,
        )
    except sync_studio_tools.SyncStudioError as exc:
        raise VideoLibraryError(exc.code, exc.message, exc.http_status) from exc

    return await update_video_lesson(
        db, lesson_id, {"syncId": sync_doc["syncId"], "mediaRef": sync_doc["mediaRef"]},
    )


async def delete_video_lesson(db, lesson_id: str) -> None:
    """Video Factory delete. Published lessons must be unpublished first —
    a lesson students can currently see/purchase can never silently vanish
    in one step. Purchase and progress records are deliberately RETAINED
    (they are the financial audit trail; entitlement history outlives the
    catalog entry, matching the codebase's reconciliation discipline)."""
    lesson = await get_video_lesson(db, lesson_id)
    if not lesson:
        raise VideoLibraryError("lesson_not_found", f"no lesson {lesson_id!r}", 404)
    if lesson.get("status") == "published":
        raise VideoLibraryError(
            "lesson_published", "unpublish this lesson before deleting it", 409,
        )
    await db[LESSONS_COLL].delete_one({"lessonId": lesson_id})
    logger.info("video_library: lesson deleted lessonId=%s", lesson_id)


# ── Ownership (the ONLY function anything should call to decide access) ────
async def get_purchase(db, student_id: str, lesson_id: str) -> dict | None:
    return await db[PURCHASES_COLL].find_one({"_id": _purchase_key(student_id, lesson_id)}, {"_id": 0})


async def student_owns_lesson(db, student_id: str, lesson_id: str) -> bool:
    return is_owned(await get_purchase(db, student_id, lesson_id))


# ── Progress ("where did I leave off") ──────────────────────────────────────
async def record_progress(db, *, student_id: str, lesson_id: str, position_sec: float, duration_sec: float) -> dict:
    doc = build_progress_record(
        student_id=student_id, lesson_id=lesson_id, position_sec=position_sec,
        duration_sec=duration_sec, updated_at=_utcnow_iso(),
    )
    key = _purchase_key(student_id, lesson_id)  # same {studentId}::{lessonId} shape, different collection
    await db[PROGRESS_COLL].update_one({"_id": key}, {"$set": doc}, upsert=True)
    return doc


async def get_progress(db, student_id: str, lesson_id: str) -> dict | None:
    return await db[PROGRESS_COLL].find_one({"_id": _purchase_key(student_id, lesson_id)}, {"_id": 0})


async def list_continue_watching(db, student_id: str) -> list[dict]:
    """Lessons with real, saved progress that are not yet complete —
    powers the dashboard's "Continue Learning" row. Never returns a lesson
    the student hasn't actually started (no synthetic "recommended as
    continue watching" — that's a different, unbuilt "Recommended" concern)."""
    cursor = db[PROGRESS_COLL].find(
        {"studentId": student_id, "completed": False}, {"_id": 0},
    ).sort([("updatedAt", -1)])
    return await cursor.to_list(length=50)


# ── Bookmarks (saved lessons) ────────────────────────────────────────────
async def toggle_bookmark(db, *, student_id: str, lesson_id: str) -> dict:
    """Idempotent toggle. Same deterministic `{studentId}::{lessonId}` _id
    convention as purchases/progress — one bookmark row per pair, ever."""
    lesson = await get_video_lesson(db, lesson_id)
    if not lesson or lesson.get("status") != "published":
        raise VideoLibraryError("lesson_not_found", f"no published lesson {lesson_id!r}", 404)
    key = _purchase_key(student_id, lesson_id)
    existing = await db[BOOKMARKS_COLL].find_one({"_id": key}, {"_id": 0})
    if existing:
        await db[BOOKMARKS_COLL].delete_one({"_id": key})
        return {"bookmarked": False, "lessonId": lesson_id}
    doc = {**build_bookmark_record(student_id=student_id, lesson_id=lesson_id, created_at=_utcnow_iso()), "_id": key}
    await db[BOOKMARKS_COLL].update_one({"_id": key}, {"$setOnInsert": doc}, upsert=True)
    return {"bookmarked": True, "lessonId": lesson_id}


async def list_bookmarks(db, student_id: str) -> list[dict]:
    cursor = db[BOOKMARKS_COLL].find({"studentId": student_id}, {"_id": 0}).sort([("createdAt", -1)])
    return await cursor.to_list(length=200)


async def serialize_lesson_for_student(db, lesson: dict, student_id: str | None) -> dict:
    """Backend-computed ownership flag — the frontend never decides this.
    Free lessons (price<=0) are always "owned"; a paid lesson only exposes
    its syncId AND mediaRef (the actual protected content — transcript
    reference and the playable video file itself) once owned — everything
    else (title, thumbnail, price, instructor, category) is always visible
    so a student can browse and decide whether to purchase."""
    price = int(lesson.get("price") or 0)
    owned = price <= 0 or (bool(student_id) and await student_owns_lesson(db, student_id, lesson["lessonId"]))
    out = {**lesson, "owned": owned}
    if not owned:
        out.pop("syncId", None)
        out.pop("mediaRef", None)
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
    register_*_routes(api, db, ...) DI convention exactly.

    `media_bucket` points at the SAME GridFS bucket name
    (sync_studio_tools.MEDIA_GRIDFS_BUCKET) sync_studio_tools.py's own
    routes use — a second handle onto the same underlying bucket, which is
    how every GridFS bucket handle in this codebase already works (each
    module constructs its own AsyncIOMotorGridFSBucket(db, bucket_name=...)
    instance; the bucket name, not the handle object, is the real identity).
    Streaming a Video Library asset back out reuses sync_studio_tools.py's
    existing GET /api/sync/media/{filename} route — no new streaming route
    needed here."""
    media_bucket = AsyncIOMotorGridFSBucket(db, bucket_name=sync_studio_tools.MEDIA_GRIDFS_BUCKET)

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
                instructor=payload.get("instructor", ""),
                category=payload.get("category") or None,
                difficulty=payload.get("difficulty") or None,
                cefr_level=payload.get("cefrLevel") or None,
                estimated_study_minutes=int(payload.get("estimatedStudyMinutes", 0) or 0),
                featured=bool(payload.get("featured", False)),
            )
        except VideoLibraryError as exc:
            _raise(exc)
        return {"ok": True, "lesson": doc}

    @api.get("/studio/video/lessons")
    async def list_lessons_admin_route(status: str = "", _admin=Depends(require_admin)):
        docs = await list_video_lessons(db, status=status or None)
        return {"lessons": docs}

    @api.post("/video/lessons/{lesson_id}/progress")
    async def progress_route(lesson_id: str, payload: dict = Body(...), student=Depends(require_student)):
        student_id = getattr(student, "clean_id", "") or getattr(student, "student_id", "")
        doc = await record_progress(
            db, student_id=student_id, lesson_id=lesson_id,
            position_sec=float(payload.get("positionSec", 0.0)),
            duration_sec=float(payload.get("durationSec", 0.0)),
        )
        return {"ok": True, "progress": doc}

    @api.get("/video/progress/mine")
    async def my_continue_watching_route(student=Depends(require_student)):
        student_id = getattr(student, "clean_id", "") or getattr(student, "student_id", "")
        docs = await list_continue_watching(db, student_id)
        return {"progress": docs}

    @api.patch("/studio/video/lessons/{lesson_id}")
    async def update_lesson_route(lesson_id: str, payload: dict = Body(...), _admin=Depends(require_admin)):
        try:
            doc = await update_video_lesson(db, lesson_id, payload)
        except VideoLibraryError as exc:
            _raise(exc)
        return {"ok": True, "lesson": doc}

    @api.post("/studio/video/lessons/{lesson_id}/media")
    async def upload_lesson_media_route(lesson_id: str, file: UploadFile = File(...), admin=Depends(require_admin)):
        raw = await file.read()
        try:
            doc = await attach_lesson_media(
                db, lesson_id, raw=raw, declared_content_type=file.content_type or "",
                media_bucket=media_bucket, uploaded_by=getattr(admin, "email", ""),
            )
        except VideoLibraryError as exc:
            _raise(exc)
        return {"ok": True, "lesson": doc}

    @api.delete("/studio/video/lessons/{lesson_id}")
    async def delete_lesson_route(lesson_id: str, _admin=Depends(require_admin)):
        try:
            await delete_video_lesson(db, lesson_id)
        except VideoLibraryError as exc:
            _raise(exc)
        return {"ok": True}

    @api.post("/video/lessons/{lesson_id}/bookmark")
    async def bookmark_toggle_route(lesson_id: str, student=Depends(require_student)):
        student_id = getattr(student, "clean_id", "") or getattr(student, "student_id", "")
        try:
            out = await toggle_bookmark(db, student_id=student_id, lesson_id=lesson_id)
        except VideoLibraryError as exc:
            _raise(exc)
        return {"ok": True, **out}

    @api.get("/video/bookmarks/mine")
    async def my_bookmarks_route(student=Depends(require_student)):
        student_id = getattr(student, "clean_id", "") or getattr(student, "student_id", "")
        docs = await list_bookmarks(db, student_id)
        return {"bookmarks": docs}

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
    async def list_lessons_route(category: str = "", difficulty: str = "", student=Depends(require_student)):
        lessons = await list_video_lessons(
            db, status="published", category=category or None, difficulty=difficulty or None,
        )
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
