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
    duration_sec: float = 0.0,
    status: str = "draft",
    created_by: str = "",
    created_at: str = "",
) -> dict:
    """Assemble a video lesson metadata document. `syncId` is a reference
    into the existing chapter_sync collection (sync_schema.py's canonical
    document) — this module never embeds transcript/word data itself."""
    if status not in VIDEO_LESSON_STATUSES:
        raise ValueError(f"invalid status: {status!r}")
    if price < 0:
        raise ValueError("price cannot be negative")

    return {
        "lessonId": lesson_id or new_lesson_id(),
        "title": title,
        "subtitle": subtitle,
        "thumbnailUrl": thumbnail_url,
        "price": int(price),
        "tier": tier,
        "syncId": sync_id,  # None until a transcript/teleprompter track exists
        "durationSec": round(float(duration_sec), 3),
        "status": status,
        "revision": 1,
        "createdBy": created_by,
        "createdAt": created_at,
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
