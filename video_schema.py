"""video_schema.py — Video Library, canonical lesson + purchase schema.

Pure, stdlib-only, no Mongo/network — same purity discipline as
sync_schema.py/book_factory_interaction_planner.py. Video Library is an
architecturally INDEPENDENT product from Books (per explicit product
direction): this module owns its own document shapes and never imports
from book_factory_*.py or server.py's book routes.

A video lesson's synchronized transcript/teleprompter data is NOT
duplicated here — it is a reference (`syncId`) into the EXISTING,
already-shipping Universal Synchronization Engine (sync_schema.py,
merged/production). Video Library reuses that schema exactly as Books
does; it does not fork or reimplement it. This module owns only what is
genuinely video-lesson-specific: title/thumbnail/pricing/publish metadata,
and the purchase/entitlement record.

Purchase state machine (mirrors voice_treasure_entry_tools.py's proven,
production state graph — the same shape, a new instance for this product):

    created -> initiating -> succeeded
                           -> failed     (retryable: new attempt = new state)
                           -> reconcile  (ambiguous GAS outcome, admin-only)

`succeeded` is the ONLY state that grants ownership. There is no
client-settable state — every transition happens inside
video_library_tools.py's atomic claim, never via a raw update from a route
payload.
"""
from __future__ import annotations

import uuid

VIDEO_LESSON_STATUSES = ("draft", "published", "archived")

PURCHASE_STATES = ("created", "initiating", "succeeded", "failed", "reconcile")

# Terminal states a NEW purchase attempt may start from. "succeeded" is
# excluded — an already-owned lesson has nothing left to purchase (the
# caller must check ownership before ever reaching this state machine).
RETRYABLE_STATES = ("created", "failed")

# Discovery/curation metadata (product direction: a standalone premium
# streaming-style dashboard needs real category/level data to filter and
# group by — these are additive fields on the same lesson document, never
# a second schema). CEFR is optional and separate from the coarser
# `difficulty` grouping the dashboard's Beginner/Intermediate/Advanced
# tabs use — a lesson may set one, both, or neither.
VIDEO_CATEGORIES = (
    "conversation", "storytelling", "business", "pronunciation", "grammar", "vocabulary",
)
VIDEO_DIFFICULTIES = ("beginner", "intermediate", "advanced")
CEFR_LEVELS = ("A1", "A2", "B1", "B2", "C1", "C2")

# A lesson is "complete" for progress-tracking purposes once watched past
# this fraction of its duration — matches this codebase's existing
# convention of treating near-the-end as complete rather than requiring
# frame-perfect 100% (accounts for credits/outro).
PROGRESS_COMPLETE_THRESHOLD = 0.9


def new_lesson_id() -> str:
    return "vid_" + uuid.uuid4().hex[:16]


def new_purchase_id() -> str:
    return "vpur_" + uuid.uuid4().hex[:16]


def build_video_lesson(
    *,
    title: str,
    price: int,
    lesson_id: str | None = None,
    subtitle: str = "",
    thumbnail_url: str = "",
    tier: str = "standard",
    sync_id: str | None = None,
    media_ref: str | None = None,
    duration_sec: float = 0.0,
    status: str = "draft",
    created_by: str = "",
    created_at: str = "",
    instructor: str = "",
    category: str | None = None,
    difficulty: str | None = None,
    cefr_level: str | None = None,
    estimated_study_minutes: int = 0,
    featured: bool = False,
) -> dict:
    """Assemble a video lesson metadata document. `syncId` is a reference
    into the existing chapter_sync collection (sync_schema.py's canonical
    document) — this module never embeds transcript/word data itself.

    `mediaRef` is deliberately ALSO stored here, denormalized from the sync
    document, rather than requiring every video-playback caller to fetch
    the sync document first: playing a video must not depend on whether
    its transcript/alignment is ready. `is_servable_to_students()` (the
    sync document's own publish gate) is about caption/highlight
    readiness — it has nothing to do with whether the underlying video
    file itself may be watched, and gating playback on it would silently
    make every lesson unwatchable until an ASR vendor exists."""
    if status not in VIDEO_LESSON_STATUSES:
        raise ValueError(f"invalid status: {status!r}")
    if price < 0:
        raise ValueError("price cannot be negative")
    if category is not None and category not in VIDEO_CATEGORIES:
        raise ValueError(f"invalid category: {category!r}")
    if difficulty is not None and difficulty not in VIDEO_DIFFICULTIES:
        raise ValueError(f"invalid difficulty: {difficulty!r}")
    if cefr_level is not None and cefr_level not in CEFR_LEVELS:
        raise ValueError(f"invalid cefr_level: {cefr_level!r}")

    return {
        "lessonId": lesson_id or new_lesson_id(),
        "title": title,
        "subtitle": subtitle,
        "thumbnailUrl": thumbnail_url,
        "price": int(price),
        "tier": tier,
        "syncId": sync_id,  # None until a transcript/teleprompter track exists
        "mediaRef": media_ref,  # None until media is uploaded — the playable video/audio URL
        "durationSec": round(float(duration_sec), 3),
        "status": status,
        "revision": 1,
        "createdBy": created_by,
        "createdAt": created_at,
        "instructor": instructor,
        "category": category,
        "difficulty": difficulty,
        "cefrLevel": cefr_level,
        "estimatedStudyMinutes": max(0, int(estimated_study_minutes)),
        # Curation flag for the standalone dashboard's "Featured Lessons"
        # row — editorial, admin-set, never derived from sales data.
        "featured": bool(featured),
    }


def validate_video_lesson(doc: dict) -> tuple[bool, list[str]]:
    errors: list[str] = []
    if not isinstance(doc, dict):
        return False, ["document is not a dict"]
    for field in ("lessonId", "title", "price", "status"):
        if field not in doc:
            errors.append(f"missing required field: {field}")
    if doc.get("status") not in (*VIDEO_LESSON_STATUSES, None):
        errors.append(f"invalid status: {doc.get('status')!r}")
    price = doc.get("price")
    if price is not None and (not isinstance(price, (int, float)) or price < 0):
        errors.append(f"invalid price: {price!r}")
    if doc.get("category") not in (*VIDEO_CATEGORIES, None):
        errors.append(f"invalid category: {doc.get('category')!r}")
    if doc.get("difficulty") not in (*VIDEO_DIFFICULTIES, None):
        errors.append(f"invalid difficulty: {doc.get('difficulty')!r}")
    if doc.get("cefrLevel") not in (*CEFR_LEVELS, None):
        errors.append(f"invalid cefrLevel: {doc.get('cefrLevel')!r}")
    return (len(errors) == 0), errors


def build_purchase_record(
    *,
    student_id: str,
    lesson_id: str,
    price: int,
    purchase_id: str | None = None,
    created_at: str = "",
) -> dict:
    """A purchase record's `_id` is deliberately (student_id, lesson_id) —
    see video_library_tools.py — so the atomic upsert-claim can only ever
    create ONE record per (student, lesson) pair, making double-purchase
    structurally impossible rather than merely unlikely."""
    return {
        "purchaseId": purchase_id or new_purchase_id(),
        "studentId": student_id,
        "lessonId": lesson_id,
        "price": int(price),
        "state": "created",
        "reason": None,
        "pointsAfter": None,
        "stateHistory": [{"state": "created", "at": created_at}],
        "createdAt": created_at,
        "updatedAt": created_at,
    }


def is_owned(purchase: dict | None) -> bool:
    """The ONLY check that grants access to a video lesson's protected
    content. `succeeded` is the sole ownership-granting state — this
    function is the single place that decision is made, so every route
    that gates video content calls this, never re-derives the logic."""
    return isinstance(purchase, dict) and purchase.get("state") == "succeeded"


def build_progress_record(
    *, student_id: str, lesson_id: str, position_sec: float, duration_sec: float, updated_at: str = "",
) -> dict:
    """A student's watch position for one lesson. `_id` is deliberately
    `{studentId}::{lessonId}` (see video_library_tools.py) — one record per
    (student, lesson) pair, upserted on every position report, never
    accumulated as a history log (this is "where did I leave off", not an
    analytics event stream — see Analytics as a separate future concern)."""
    fraction = (position_sec / duration_sec) if duration_sec > 0 else 0.0
    return {
        "studentId": student_id,
        "lessonId": lesson_id,
        "positionSec": max(0.0, round(float(position_sec), 2)),
        "durationSec": round(float(duration_sec), 2),
        "completed": fraction >= PROGRESS_COMPLETE_THRESHOLD,
        "updatedAt": updated_at,
    }


def build_bookmark_record(*, student_id: str, lesson_id: str, created_at: str = "") -> dict:
    """A student's saved/bookmarked lesson. Same one-record-per-
    (student, lesson) `_id` convention as purchases/progress (see
    video_library_tools.py) — toggling a bookmark twice is structurally
    a no-op pair, never a duplicate row."""
    return {
        "studentId": student_id,
        "lessonId": lesson_id,
        "createdAt": created_at,
    }
