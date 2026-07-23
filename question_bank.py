"""question_bank.py — the Question Bank (architecture.md's "Question Bank:
categories/search/import/export/versioning/publish, moved into Author
Studio"). Replaces the Speaking Lab Console's localStorage-as-source-of-
truth question editor with a real, versioned, structured Mongo store.

WHY A NEW MODULE INSTEAD OF EXTENDING /api/speaking-lab/questions
───────────────────────────────────────────────────────────────
The existing ``/api/speaking-lab/questions`` route (server.py) reads/
writes a SINGLE flat document (``db.speaking_lab_settings`` with
``_id: "questions"``) shaped ``{"beginner": [...], "intermediate": [...]}``
— plain strings, no id, no category beyond two hardcoded buckets, no
versioning, no publish lifecycle, no search. QuestionBankEditor.jsx (the
Speaking Lab Console's teacher UI) already documents that this backend
route was demoted to a best-effort mirror and localStorage is the actual
source of truth — exactly the anti-pattern architecture.md calls out.

This module is the structured replacement: individual question
documents, each with a free-form ``category`` (not limited to
beginner/intermediate — Author Studio can define new categories),
draft/published/archived lifecycle + per-item version counter (matching
event_engine.py's template lifecycle and eduhub_platform/config.py's
version-tracking conventions), and bulk import (including from the
legacy flat shape, so existing question sets aren't lost) / export.

The legacy route is left completely untouched — it is not this module's
concern and other consumers of it keep working unchanged ("wrap, don't
rewrite"). Event Templates already reserve a ``question_bank_ref`` field
(event_engine.py's ``_TEMPLATE_CONTENT_FIELDS``); that field can now
point at a real ``category`` name resolved through this module instead
of being an opaque unresolved reference.

Collection: ``question_bank_items`` (owned exclusively by this module).
"""
from __future__ import annotations

import logging
import re
import uuid
from datetime import datetime, timezone
from typing import Any, Optional

logger = logging.getLogger("eduhub.question_bank")

QUESTIONS_COLL = "question_bank_items"

QUESTION_STATUSES = ("draft", "published", "archived")


class QuestionBankError(Exception):
    def __init__(self, code: str, message: str = "", http_status: int = 400) -> None:
        super().__init__(message or code)
        self.code = code
        self.message = message or code
        self.http_status = http_status


def _now_iso() -> str:
    return datetime.now(timezone.utc).isoformat()


def _new_id() -> str:
    return f"qb_{uuid.uuid4().hex[:16]}"


# ─────────────────────────────────────────────────────────────────────────
# CRUD + lifecycle — one item at a time
# ─────────────────────────────────────────────────────────────────────────
async def create_question(
    db, *, category: str, text: str, tags: Optional[list] = None, created_by: str,
) -> dict:
    category = (category or "").strip()
    text = (text or "").strip()
    if not category:
        raise QuestionBankError("invalid_category", "category is required")
    if not text:
        raise QuestionBankError("invalid_text", "text is required")
    now = _now_iso()
    doc = {
        "_id": _new_id(),
        "category": category,
        "text": text,
        "tags": [str(t).strip() for t in (tags or []) if str(t).strip()],
        "status": "draft",
        "version": 1,
        "created_by": created_by,
        "created_at": now,
        "updated_at": now,
        "published_at": None,
        "archived_at": None,
    }
    await db[QUESTIONS_COLL].insert_one(doc)
    return doc


async def get_question(db, question_id: str) -> Optional[dict]:
    return await db[QUESTIONS_COLL].find_one({"_id": question_id})


async def list_questions(
    db, *, category: Optional[str] = None, status: Optional[str] = None,
    search: Optional[str] = None,
) -> list[dict]:
    query: dict = {}
    if category:
        query["category"] = category
    if status:
        query["status"] = status
    if search:
        # Escape so a search term isn't interpreted as a regex — this is a
        # plain substring/text search, not a power-user regex field.
        query["text"] = {"$regex": re.escape(search), "$options": "i"}
    cursor = db[QUESTIONS_COLL].find(query, {}).sort("updated_at", -1)
    return [doc async for doc in cursor]


async def list_categories(db) -> list[dict]:
    """Distinct categories with item counts — Author Studio's category
    picker. A simple in-Python aggregation rather than a Mongo pipeline:
    this collection is teacher-authored content, not high-volume data."""
    docs = await list_questions(db)
    counts: dict[str, int] = {}
    for doc in docs:
        counts[doc["category"]] = counts.get(doc["category"], 0) + 1
    return [{"category": c, "count": n} for c, n in sorted(counts.items())]


async def update_question(db, question_id: str, updates: dict, *, updated_by: str) -> dict:
    """Only mutable while ``draft`` — matches event_engine.py's template
    lifecycle rule (a published item is immutable so nothing consuming it
    is surprised; unpublish first to edit, or duplicate)."""
    q = await get_question(db, question_id)
    if not q:
        raise QuestionBankError("question_not_found", http_status=404)
    if q["status"] != "draft":
        raise QuestionBankError(
            "question_not_editable",
            "Only a draft question can be edited. Unpublish it first.",
        )
    changes: dict[str, Any] = {}
    if "category" in updates and (updates["category"] or "").strip():
        changes["category"] = updates["category"].strip()
    if "text" in updates and (updates["text"] or "").strip():
        changes["text"] = updates["text"].strip()
    if "tags" in updates:
        changes["tags"] = [str(t).strip() for t in (updates["tags"] or []) if str(t).strip()]
    changes["version"] = int(q.get("version") or 1) + 1
    changes["updated_at"] = _now_iso()
    changes["updated_by"] = updated_by
    await db[QUESTIONS_COLL].update_one({"_id": question_id}, {"$set": changes})
    return await get_question(db, question_id)


async def publish_question(db, question_id: str, *, updated_by: str) -> dict:
    q = await get_question(db, question_id)
    if not q:
        raise QuestionBankError("question_not_found", http_status=404)
    if q["status"] == "archived":
        raise QuestionBankError("question_archived", "An archived question cannot be published.")
    now = _now_iso()
    await db[QUESTIONS_COLL].update_one(
        {"_id": question_id},
        {"$set": {"status": "published", "published_at": now, "updated_at": now,
                   "updated_by": updated_by}},
    )
    return await get_question(db, question_id)


async def unpublish_question(db, question_id: str, *, updated_by: str) -> dict:
    q = await get_question(db, question_id)
    if not q:
        raise QuestionBankError("question_not_found", http_status=404)
    now = _now_iso()
    await db[QUESTIONS_COLL].update_one(
        {"_id": question_id},
        {"$set": {"status": "draft", "updated_at": now, "updated_by": updated_by}},
    )
    return await get_question(db, question_id)


async def archive_question(db, question_id: str, *, updated_by: str) -> dict:
    q = await get_question(db, question_id)
    if not q:
        raise QuestionBankError("question_not_found", http_status=404)
    now = _now_iso()
    await db[QUESTIONS_COLL].update_one(
        {"_id": question_id},
        {"$set": {"status": "archived", "archived_at": now, "updated_at": now,
                   "updated_by": updated_by}},
    )
    return await get_question(db, question_id)


async def delete_question(db, question_id: str) -> bool:
    """Permanent delete — only allowed for draft/archived items. A
    published item must be unpublished (or archived) first, mirroring the
    same "don't silently break something using this" caution as
    event_engine.py's template edit gate."""
    q = await get_question(db, question_id)
    if not q:
        raise QuestionBankError("question_not_found", http_status=404)
    if q["status"] == "published":
        raise QuestionBankError(
            "question_published",
            "Unpublish or archive this question before deleting it.",
        )
    result = await db[QUESTIONS_COLL].delete_one({"_id": question_id})
    return bool(getattr(result, "deleted_count", 0))


# ─────────────────────────────────────────────────────────────────────────
# Bulk import / export
# ─────────────────────────────────────────────────────────────────────────
def _normalize_import_items(payload: dict) -> list[dict]:
    """Accepts either the new shape (``{"items": [{"category", "text",
    "tags"?}, ...]}``) or the LEGACY flat shape this module supersedes
    (``{"beginner": [...], "intermediate": [...]}``, plain strings) so an
    existing question set can be imported without hand-conversion."""
    if isinstance(payload.get("items"), list):
        items = []
        for raw in payload["items"]:
            if isinstance(raw, dict):
                items.append({
                    "category": raw.get("category", ""),
                    "text": raw.get("text", ""),
                    "tags": raw.get("tags") or [],
                })
        return items

    items = []
    for key, value in (payload or {}).items():
        if key == "items" or not isinstance(value, list):
            continue
        for text in value:
            if isinstance(text, str) and text.strip():
                items.append({"category": key, "text": text, "tags": []})
    return items


async def import_questions(db, payload: dict, *, created_by: str) -> dict:
    """Bulk-create draft questions from either payload shape. Returns a
    summary rather than every created document — an import can be large
    and the caller (Author Studio's import screen) only needs counts plus
    the ids for undo/review."""
    items = _normalize_import_items(payload)
    created_ids = []
    skipped = 0
    for item in items:
        try:
            doc = await create_question(
                db, category=item["category"], text=item["text"],
                tags=item.get("tags"), created_by=created_by,
            )
            created_ids.append(doc["_id"])
        except QuestionBankError:
            skipped += 1
    return {"imported": len(created_ids), "skipped": skipped, "ids": created_ids}


async def export_questions(
    db, *, category: Optional[str] = None, status: Optional[str] = None,
) -> dict:
    """Returns the full structured documents for download/backup — the
    inverse of import_questions' "items" shape, so an export can be fed
    straight back into /import."""
    docs = await list_questions(db, category=category, status=status)
    items = [
        {"category": d["category"], "text": d["text"], "tags": d.get("tags") or []}
        for d in docs
    ]
    return {"items": items, "count": len(items)}


# ─────────────────────────────────────────────────────────────────────────
# Routes — Author Studio's "Question Bank" screen
# ─────────────────────────────────────────────────────────────────────────
def register_question_bank_routes(api, db, require_admin) -> None:
    """Mounts /api/v1/question-bank* onto the existing FastAPI router.
    Admin-only, matching the current /api/speaking-lab/questions route's
    own auth (require_admin) — this module has no student-facing surface;
    the Event Operator Console (a teacher-authenticated app) reads
    published questions through the same admin-gated routes."""
    from fastapi import Body, Depends, HTTPException

    def _raise(exc: QuestionBankError):
        raise HTTPException(status_code=exc.http_status, detail=exc.message)

    @api.get("/v1/question-bank")
    async def list_questions_route(
        category: str = "", status: str = "", search: str = "",
        _admin=Depends(require_admin),
    ):
        docs = await list_questions(
            db, category=category or None, status=status or None, search=search or None,
        )
        return {"questions": docs}

    @api.get("/v1/question-bank/categories")
    async def list_categories_route(_admin=Depends(require_admin)):
        return {"categories": await list_categories(db)}

    @api.get("/v1/question-bank/export")
    async def export_questions_route(
        category: str = "", status: str = "", _admin=Depends(require_admin),
    ):
        return await export_questions(db, category=category or None, status=status or None)

    @api.post("/v1/question-bank/import")
    async def import_questions_route(payload: dict = Body(...), admin=Depends(require_admin)):
        return await import_questions(db, payload, created_by=getattr(admin, "email", ""))

    @api.post("/v1/question-bank")
    async def create_question_route(payload: dict = Body(...), admin=Depends(require_admin)):
        try:
            doc = await create_question(
                db, category=payload.get("category", ""), text=payload.get("text", ""),
                tags=payload.get("tags"), created_by=getattr(admin, "email", ""),
            )
        except QuestionBankError as exc:
            _raise(exc)
        return {"ok": True, "question": doc}

    @api.get("/v1/question-bank/{question_id}")
    async def get_question_route(question_id: str, _admin=Depends(require_admin)):
        doc = await get_question(db, question_id)
        if not doc:
            raise HTTPException(status_code=404, detail="question not found")
        return {"question": doc}

    @api.patch("/v1/question-bank/{question_id}")
    async def update_question_route(
        question_id: str, payload: dict = Body(...), admin=Depends(require_admin),
    ):
        try:
            doc = await update_question(db, question_id, payload, updated_by=getattr(admin, "email", ""))
        except QuestionBankError as exc:
            _raise(exc)
        return {"ok": True, "question": doc}

    @api.post("/v1/question-bank/{question_id}/publish")
    async def publish_question_route(question_id: str, admin=Depends(require_admin)):
        try:
            doc = await publish_question(db, question_id, updated_by=getattr(admin, "email", ""))
        except QuestionBankError as exc:
            _raise(exc)
        return {"ok": True, "question": doc}

    @api.post("/v1/question-bank/{question_id}/unpublish")
    async def unpublish_question_route(question_id: str, admin=Depends(require_admin)):
        try:
            doc = await unpublish_question(db, question_id, updated_by=getattr(admin, "email", ""))
        except QuestionBankError as exc:
            _raise(exc)
        return {"ok": True, "question": doc}

    @api.post("/v1/question-bank/{question_id}/archive")
    async def archive_question_route(question_id: str, admin=Depends(require_admin)):
        try:
            doc = await archive_question(db, question_id, updated_by=getattr(admin, "email", ""))
        except QuestionBankError as exc:
            _raise(exc)
        return {"ok": True, "question": doc}

    @api.delete("/v1/question-bank/{question_id}")
    async def delete_question_route(question_id: str, _admin=Depends(require_admin)):
        try:
            deleted = await delete_question(db, question_id)
        except QuestionBankError as exc:
            _raise(exc)
        return {"ok": True, "deleted": deleted}

    logger.info("question_bank: routes registered (/api/v1/question-bank*)")


async def ensure_question_bank_indexes(db) -> None:
    await db[QUESTIONS_COLL].create_index("category")
    await db[QUESTIONS_COLL].create_index("status")
    await db[QUESTIONS_COLL].create_index([("category", 1), ("status", 1)])
    logger.info("question_bank: indexes ready")


__all__ = [
    "QUESTIONS_COLL",
    "QuestionBankError",
    "create_question",
    "get_question",
    "list_questions",
    "list_categories",
    "update_question",
    "publish_question",
    "unpublish_question",
    "archive_question",
    "delete_question",
    "import_questions",
    "export_questions",
    "register_question_bank_routes",
    "ensure_question_bank_indexes",
]
