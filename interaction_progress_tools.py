"""interaction_progress_tools.py — Signature Smart Interactive Book,
Checkpoint 1: student-facing local/server progress sync for the nine premium
interaction block types.

Isolated, additive, dedicated collection (`book_interaction_progress`) — NOT
an extension of the existing chapter-level `chapter_progress` collection
(coach_pack's chapter_progress_tools.py), since that collection is
chapter-level and this is item-level; keeping them separate means zero risk
to the existing chapter-completion/streak/badge consumers of the former.

§LOCKED CORRECTION 6/7 — verified access model (re-audited this checkpoint,
NOT assumed): `GET /api/books/{slug}` is a PUBLIC route today — there is no
book ownership/entitlement/purchase collection anywhere in this backend,
and no tier-based content gate on book reading. "Verify the student may
access the book using the real existing access rules" therefore reduces
EXACTLY to what `get_book()` itself checks: the book exists and is
`published: True`. This module reuses that identical filter — it does not
invent a stricter or looser rule than what already governs book reading.
If EduHub later adds real ownership/entitlements, tightening this check is a
one-line change in `_book_exists_and_published()` below.

Conflict resolution (§LOCKED CORRECTION 6): a client-supplied `clientUpdatedAt`
is stored ONLY for diagnostics — it is never used to decide which write wins.
Every write is a single atomic `update_one`:
  - `completed` (bool) and `attemptCount`/`hintLevel` (int) move via Mongo's
    native `$max` operator — they can only increase, never regress, no matter
    what order requests arrive in or whether a device's clock is wrong.
  - `selectedBranch` is plain last-write-wins (non-monotonic by nature; a
    student's most recent branch choice is what should display).
  - `progressVersion` increments via `$inc` on every processed write — a
    diagnostic/ordering counter, not itself the conflict-resolution
    mechanism (the per-field `$max` semantics are).
No read-modify-write race exists — every write is one Mongo operation.

Feature-flag gated (BOOK_PREMIUM_INTERACTIONS_ENABLED, default false — same
`_flag()`/`premium_interactions_permitted()` reused verbatim from
book_factory_jobs.py). While off, both routes 503 (per the authorization:
"progress endpoints may be unavailable or disabled safely").
"""
from __future__ import annotations

import logging
from datetime import datetime, timezone

from fastapi import APIRouter, Depends, HTTPException

import book_factory_jobs as bfj

log = logging.getLogger("eduhub.interaction_progress")

COL_INTERACTION_PROGRESS = "book_interaction_progress"

_MAX_BATCH_ITEMS = 25
_MAX_STR_LEN = 200
_MAX_ATTEMPT_COUNT = 20
_MAX_HINT_LEVEL = 3


def _now_iso() -> str:
    return datetime.now(timezone.utc).isoformat()


def _clip(v, limit=_MAX_STR_LEN) -> str:
    return str(v or "").strip()[:limit]


def _clamp_int(v, lo, hi, default=0) -> int:
    try:
        n = int(v)
    except (TypeError, ValueError):
        return default
    return max(lo, min(n, hi))


async def _book_exists_and_published(db, slug: str, revision: int | None) -> bool:
    """Reuses the EXACT filter server.py's get_book() uses to serve a book —
    the verified real access rule (§LOCKED CORRECTION 7), not an invented one."""
    query: dict = {"slug": slug, "published": True}
    if revision is not None:
        query["revision"] = revision
    doc = await db["books"].find_one(query, {"_id": 1})
    return doc is not None


def _progress_key(student_id: str, book_slug: str, revision, chapter_id: str, block_id: str) -> str:
    return f"{student_id}:{book_slug}:{revision}:{chapter_id}:{block_id}"


async def _apply_progress_item(db, student_id: str, item: dict) -> dict:
    book_slug = _clip(item.get("bookSlug"))
    chapter_id = _clip(item.get("chapterId"))
    block_id = _clip(item.get("blockId"))
    revision = item.get("revision")
    try:
        revision = int(revision)
    except (TypeError, ValueError):
        return {"bookSlug": book_slug, "chapterId": chapter_id, "blockId": block_id,
                "applied": False, "reason": "invalid_revision"}

    if not book_slug or not chapter_id or not block_id:
        return {"bookSlug": book_slug, "chapterId": chapter_id, "blockId": block_id,
                "applied": False, "reason": "missing_required_field"}

    if not await _book_exists_and_published(db, book_slug, revision):
        return {"bookSlug": book_slug, "chapterId": chapter_id, "blockId": block_id,
                "applied": False, "reason": "book_not_found_or_not_published"}

    completed = bool(item.get("state") == "completed")
    attempt_count = _clamp_int(item.get("attemptCount"), 0, _MAX_ATTEMPT_COUNT)
    hint_level = _clamp_int(item.get("hintLevel"), 0, _MAX_HINT_LEVEL)
    selected_branch = _clip(item.get("selectedBranch")) or None
    client_updated_at = _clip(item.get("clientUpdatedAt")) or None

    key = _progress_key(student_id, book_slug, revision, chapter_id, block_id)
    now = _now_iso()
    setter = {
        "studentId": student_id, "bookSlug": book_slug, "revision": revision,
        "chapterId": chapter_id, "blockId": block_id,
        "serverUpdatedAt": now, "clientUpdatedAt": client_updated_at,
    }
    if selected_branch is not None:
        setter["selectedBranch"] = selected_branch

    try:
        await db[COL_INTERACTION_PROGRESS].update_one(
            {"_id": key},
            {
                "$max": {"completed": completed, "attemptCount": attempt_count, "hintLevel": hint_level},
                "$set": setter,
                "$setOnInsert": {"createdAt": now},
                "$inc": {"progressVersion": 1},
            },
            upsert=True,
        )
    except Exception as exc:  # noqa: BLE001
        log.warning("interaction_progress: write failed: %s", exc)
        return {"bookSlug": book_slug, "chapterId": chapter_id, "blockId": block_id,
                "applied": False, "reason": "write_failed"}

    return {"bookSlug": book_slug, "chapterId": chapter_id, "blockId": block_id, "applied": True}


def register_interaction_progress_routes(api: APIRouter, db, require_admin, require_student) -> None:
    _ = require_admin  # unused; kept for call-site symmetry with other register_*_routes

    def _need_flag():
        if not bfj.premium_interactions_permitted():
            raise HTTPException(status_code=503, detail="Premium interactions are disabled.")

    @api.post("/student/interaction-progress/sync")
    async def interaction_progress_sync(payload: dict, student=Depends(require_student)):
        _need_flag()
        if not isinstance(payload, dict):
            raise HTTPException(status_code=400, detail="Body must be JSON.")
        items = payload.get("items")
        if not isinstance(items, list) or not items:
            raise HTTPException(status_code=400, detail="items must be a non-empty list.")
        if len(items) > _MAX_BATCH_ITEMS:
            raise HTTPException(status_code=400, detail=f"items exceeds max batch size ({_MAX_BATCH_ITEMS}).")

        # §BLOCKER: studentId is NEVER read from the payload — derived only
        # from the authenticated session, exactly like every other student
        # route in this codebase (chapter_progress_tools.py, etc.).
        student_id = student.clean_id

        results = []
        for raw in items:
            if not isinstance(raw, dict):
                results.append({"applied": False, "reason": "item_not_object"})
                continue
            results.append(await _apply_progress_item(db, student_id, raw))
        return {"success": True, "results": results}

    @api.get("/student/interaction-progress/{book_slug}")
    async def interaction_progress_get(book_slug: str, revision: int | None = None,
                                       student=Depends(require_student)):
        _need_flag()
        book_slug = _clip(book_slug)
        query: dict = {"studentId": student.clean_id, "bookSlug": book_slug}
        if revision is not None:
            query["revision"] = revision
        items = []
        try:
            cur = db[COL_INTERACTION_PROGRESS].find(query, {"_id": 0})
            async for d in cur:
                items.append({
                    "chapterId": d.get("chapterId"), "blockId": d.get("blockId"),
                    "revision": d.get("revision"),
                    "state": "completed" if d.get("completed") else "explored",
                    "attemptCount": int(d.get("attemptCount") or 0),
                    "hintLevel": int(d.get("hintLevel") or 0),
                    "selectedBranch": d.get("selectedBranch"),
                    "progressVersion": int(d.get("progressVersion") or 0),
                    "serverUpdatedAt": d.get("serverUpdatedAt"),
                })
        except Exception as exc:  # noqa: BLE001
            log.warning("interaction_progress: get failed: %s", exc)
        return {"success": True, "items": items}

    log.info("interaction_progress_tools: routes registered (flag-gated, default off)")


async def ensure_interaction_progress_indexes(db) -> None:
    """Idempotent index creation — safe to call unconditionally at startup
    (mirrors ensure_book_factory_indexes's pattern), independent of whether
    the feature flag is currently on."""
    await db[COL_INTERACTION_PROGRESS].create_index(
        [("studentId", 1), ("bookSlug", 1), ("revision", 1)]
    )
