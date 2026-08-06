"""sync_studio_tools.py — Universal Synchronization Engine, Mongo-backed
routes (Phase 0 — Universal Synchronization Foundation).

Implements the storage strategy and API contracts from
docs/proposals/universal-synchronization-engine-technical-spec.md §9/§10 in
the frontend repo. Collection: `chapter_sync`, owned exclusively by this
module (registered in tools/check_collection_ownership.py's
OWNED_COLLECTIONS) — primary-keyed by `syncId` per the schema's Media
Independence principle (spec §4): a sync document's identity is the media
asset, not a book/chapter. `slug`/`chapterIndex`/`blockIndex` on the stored
Mongo document are a STORAGE-LAYER convenience binding (secondary index for
"what does this chapter currently point to") — they are NOT part of the
canonical schema itself (sync_schema.py never mentions a book or chapter).

Phase 0 scope, deliberately: this module can only turn ALREADY-GENERATED
ElevenLabs narration (existing `wordTimestamps` on a `transcript` block)
into a canonical sync document — the "thin adapter at read time" spec §11
describes for backward compatibility. It has NO upload route and NO
Speech-Recognition/Alignment provider wiring: native audio/video upload is
explicitly blocked on a not-yet-made vendor decision (spec §12) and is not
implemented here. See the `/studio/sync/from-chapter` route's docstring.

Review-workflow scope, deliberately: `reviewStatus` transitions and speaker
relabeling are implemented and tested. Transcript-text editing with
nearest-neighbor word-boundary re-keying (spec §5) is NOT implemented in
this pass — it is real Review Studio UI/algorithm work for a follow-up
commit, not something to fake here. `editedTranscript` in the review
payload is accepted and stored as a pending note only; it does not yet
re-key any word boundaries. This is called out explicitly rather than
silently doing nothing with it.
"""
from __future__ import annotations

import logging

from sync_provider import reshape_elevenlabs_word_timestamps
from sync_schema import VALID_REVIEW_STATUSES, is_servable_to_students, validate_sync_document

logger = logging.getLogger("eduhub.sync_studio")

CHAPTER_SYNC_COLL = "chapter_sync"

# reviewStatus transition graph (spec §5): pending -> in_review -> approved |
# rejected; rejected -> in_review allows a re-submit loop after a provider
# re-run. approved is terminal via this endpoint (no un-approve here).
_ALLOWED_TRANSITIONS: dict[str, set[str]] = {
    "pending": {"in_review"},
    "in_review": {"approved", "rejected"},
    "rejected": {"in_review"},
    "approved": set(),
}


class SyncStudioError(Exception):
    def __init__(self, code: str, message: str = "", http_status: int = 400) -> None:
        super().__init__(message or code)
        self.code = code
        self.message = message or code
        self.http_status = http_status


async def ensure_sync_studio_indexes(db) -> None:
    await db[CHAPTER_SYNC_COLL].create_index("syncId", unique=True)
    await db[CHAPTER_SYNC_COLL].create_index([("slug", 1), ("chapterIndex", 1)])
    logger.info("sync_studio_tools: indexes ready")


async def create_sync_from_chapter_block(
    db, *, slug: str, chapter_index: int, block_index: int, get_book_by_slug,
) -> dict:
    """Backfill a canonical sync document from an ALREADY-GENERATED
    ElevenLabs `transcript` block's `wordTimestamps` — no new provider call,
    no new vendor. Raises SyncStudioError on any not-found/invalid input."""
    book = await get_book_by_slug(slug)
    if not book:
        raise SyncStudioError("book_not_found", f"no book for slug={slug!r}", 404)

    chapters = book.get("chapters") or []
    if not (0 <= chapter_index < len(chapters)):
        raise SyncStudioError("chapter_not_found", f"chapterIndex {chapter_index} out of range", 404)

    blocks = (chapters[chapter_index] or {}).get("blocks") or []
    if not (0 <= block_index < len(blocks)):
        raise SyncStudioError("block_not_found", f"blockIndex {block_index} out of range", 404)

    block = blocks[block_index] or {}
    word_timestamps = block.get("wordTimestamps")
    if not word_timestamps:
        raise SyncStudioError(
            "no_word_timestamps",
            "this block has no existing wordTimestamps to adapt — run ElevenLabs "
            "narration for this chapter first (Book Factory / Studio narration flow)",
            400,
        )

    doc = reshape_elevenlabs_word_timestamps(word_timestamps)
    doc["mediaRef"] = block.get("audioUrl") or ""
    doc["slug"] = slug
    doc["chapterIndex"] = chapter_index
    doc["blockIndex"] = block_index

    ok, errors = validate_sync_document(doc)
    if not ok:
        # Would indicate a bug in reshape_elevenlabs_word_timestamps itself,
        # not bad input — surfaced loudly rather than silently stored.
        raise SyncStudioError("invalid_sync_document", "; ".join(errors), 500)

    await db[CHAPTER_SYNC_COLL].insert_one(dict(doc))
    doc.pop("_id", None)
    return doc


async def get_sync_document(db, sync_id: str) -> dict | None:
    return await db[CHAPTER_SYNC_COLL].find_one({"syncId": sync_id}, {"_id": 0})


async def get_current_chapter_sync(db, slug: str, chapter_index: int) -> dict | None:
    """Most-recently-generated sync document currently bound to this
    chapter. Multiple sync documents may exist for the same chapter over
    time (re-generation) — the binding is "latest wins", not a hard
    1:1 foreign key, matching spec §4's reuse/replacement model."""
    return await db[CHAPTER_SYNC_COLL].find_one(
        {"slug": slug, "chapterIndex": chapter_index},
        {"_id": 0},
        sort=[("generatedAt", -1)],
    )


async def transition_review_status(
    db, sync_id: str, *, new_status: str, speaker_relabels: dict | None = None,
    edited_transcript: str | None = None,
) -> dict:
    doc = await get_sync_document(db, sync_id)
    if not doc:
        raise SyncStudioError("sync_not_found", f"no sync document for syncId={sync_id!r}", 404)

    if new_status not in VALID_REVIEW_STATUSES:
        raise SyncStudioError("invalid_status", f"invalid reviewStatus: {new_status!r}", 400)

    current = doc.get("reviewStatus", "pending")
    if new_status != current and new_status not in _ALLOWED_TRANSITIONS.get(current, set()):
        raise SyncStudioError(
            "invalid_transition",
            f"cannot transition reviewStatus from {current!r} to {new_status!r}",
            409,
        )

    updates: dict = {"reviewStatus": new_status}
    if new_status == "approved" and not doc.get("approvedAt"):
        import datetime as _dt
        updates["approvedAt"] = _dt.datetime.now(_dt.timezone.utc).strftime("%Y-%m-%dT%H:%M:%SZ")

    if speaker_relabels:
        speakers = doc.get("speakers") or []
        relabeled = [
            {**s, "label": speaker_relabels.get(s.get("id"), s.get("label"))}
            for s in speakers
        ]
        updates["speakers"] = relabeled

    if edited_transcript is not None:
        # NOT re-keyed to word boundaries in this pass (see module docstring)
        # — stored as a pending author note so it is visible, not silently
        # dropped, and so a follow-up commit has a real field to act on.
        updates["pendingTranscriptEdit"] = edited_transcript

    await db[CHAPTER_SYNC_COLL].update_one({"syncId": sync_id}, {"$set": updates})
    doc.update(updates)
    return doc


def register_sync_studio_routes(api, db, require_admin, current_student, get_book_by_slug) -> None:
    """Mounts the Phase 0 Universal Synchronization Engine routes. Matches
    notification_packs.py's register_*_routes(api, db, require_admin)
    convention, extended with `current_student` (optional-auth, matching
    the existing GET /books/{slug} pattern) and `get_book_by_slug` (a
    read-only adapter — see server.py's `_bf_get_book_by_slug` for the
    established precedent of injecting this rather than importing db.books
    logic directly into a sibling module)."""
    from fastapi import Body, Depends, HTTPException

    def _raise(exc: SyncStudioError):
        raise HTTPException(status_code=exc.http_status, detail=exc.message)

    @api.post("/studio/sync/from-chapter")
    async def from_chapter_route(payload: dict = Body(...), _admin=Depends(require_admin)):
        try:
            doc = await create_sync_from_chapter_block(
                db,
                slug=payload.get("slug", ""),
                chapter_index=int(payload.get("chapterIndex", -1)),
                block_index=int(payload.get("blockIndex", -1)),
                get_book_by_slug=get_book_by_slug,
            )
        except SyncStudioError as exc:
            _raise(exc)
        return {"ok": True, "sync": doc}

    @api.get("/studio/sync/{sync_id}")
    async def studio_get_sync_route(sync_id: str, _admin=Depends(require_admin)):
        doc = await get_sync_document(db, sync_id)
        if not doc:
            raise HTTPException(status_code=404, detail="sync document not found")
        return {"sync": doc}

    @api.post("/studio/sync/{sync_id}/review")
    async def review_route(sync_id: str, payload: dict = Body(...), _admin=Depends(require_admin)):
        try:
            doc = await transition_review_status(
                db, sync_id,
                new_status=payload.get("reviewStatus", ""),
                speaker_relabels=payload.get("speakerRelabels"),
                edited_transcript=payload.get("editedTranscript"),
            )
        except SyncStudioError as exc:
            _raise(exc)
        return {"ok": True, "sync": doc}

    @api.get("/sync/{sync_id}")
    async def public_get_sync_route(sync_id: str, student=Depends(current_student)):
        doc = await get_sync_document(db, sync_id)
        if not doc or not is_servable_to_students(doc):
            raise HTTPException(status_code=404, detail="sync document not found")
        return {"sync": doc}

    @api.get("/books/{slug}/chapters/{chapter_index}/sync")
    async def chapter_sync_route(slug: str, chapter_index: int, student=Depends(current_student)):
        doc = await get_current_chapter_sync(db, slug, chapter_index)
        if not doc or not is_servable_to_students(doc):
            raise HTTPException(status_code=404, detail="sync document not found")
        return {"sync": doc}

    logger.info("sync_studio_tools: routes registered (/api/sync*, /api/studio/sync*)")
