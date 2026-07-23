"""notification_packs.py — the Notification Packs module (architecture.md
continuation: "Notification Packs UI (push/event/reminder/reward
templates)"). Gives Author Studio a reusable, versioned template store
that an Event Template's ``notification_pack_ref`` (event_engine.py's
``_TEMPLATE_CONTENT_FIELDS``) can point at instead of staying an opaque,
unresolved string.

WHY A NEW MODULE, NOT AN EXTENSION OF notification_center.py
──────────────────────────────────────────────────────────────
notification_center.py is a RUNTIME delivery/read-tracking layer — it
records a push that already happened (``wrap_fan_out_push``) and exposes
``/notifications`` for the unread list/badge. It has no concept of an
admin-authored, reusable template; every caller today (login_reward_
tools.py, mystery_box_tools.py) builds its title/body with hardcoded
Python f-strings at send time. This module is the missing AUTHORING
layer: a named pack of title/body/url templates with ``{placeholder}``
tokens, versioned and lifecycle-managed the same way question_bank.py
and event_engine.py's templates already are. It does not send anything
itself — ``render_pack`` only resolves a template's tokens against a
context dict; the caller still sends the result through the EXISTING
``_fan_out_push``/``wrap_fan_out_push`` pipeline, unchanged ("wrap,
don't rewrite").

Every real send site found in this codebase (server.py's ``_fan_out_
push``, mystery_box_tools.py's ``_mbt_push_notify_prize``, login_reward_
tools.py's push call) takes exactly ``title``, ``body``, ``url`` — so
that is exactly what a pack's template fields are, nothing more.

Collection: ``notification_packs`` (owned exclusively by this module).
"""
from __future__ import annotations

import logging
import re
import uuid
from datetime import datetime, timezone
from typing import Any, Optional

logger = logging.getLogger("eduhub.notification_packs")

PACKS_COLL = "notification_packs"

PACK_STATUSES = ("draft", "published", "archived")
PACK_TYPES = ("push", "event", "reminder", "reward")

_PLACEHOLDER_RE = re.compile(r"\{(\w+)\}")


class NotificationPackError(Exception):
    def __init__(self, code: str, message: str = "", http_status: int = 400) -> None:
        super().__init__(message or code)
        self.code = code
        self.message = message or code
        self.http_status = http_status


def _now_iso() -> str:
    return datetime.now(timezone.utc).isoformat()


def _new_id() -> str:
    return f"pack_{uuid.uuid4().hex[:16]}"


def render_template(template: str, context: dict) -> str:
    """Resolve ``{placeholder}`` tokens against ``context``. An unknown
    token is left LITERAL (not blanked) so a typo'd or not-yet-supplied
    placeholder is visible in the preview/output rather than silently
    disappearing — this is a template author's tool, not a fault-
    tolerant runtime path."""
    def _repl(m: "re.Match[str]") -> str:
        key = m.group(1)
        return str(context[key]) if key in context else m.group(0)
    return _PLACEHOLDER_RE.sub(_repl, template or "")


def render_pack(pack: dict, context: Optional[dict] = None) -> dict:
    """Resolve a pack's title/body/url templates against ``context``.
    Does NOT send anything — the caller still sends the result through
    the existing _fan_out_push/wrap_fan_out_push pipeline."""
    context = context or {}
    return {
        "title": render_template(pack.get("title_template", ""), context),
        "body": render_template(pack.get("body_template", ""), context),
        "url": render_template(pack.get("url_template", "") or "/portal", context),
    }


# ─────────────────────────────────────────────────────────────────────────
# CRUD + lifecycle
# ─────────────────────────────────────────────────────────────────────────
async def create_pack(
    db, *, name: str, pack_type: str, title_template: str, body_template: str,
    url_template: str = "", placeholders: Optional[list] = None, created_by: str,
) -> dict:
    name = (name or "").strip()
    if not name:
        raise NotificationPackError("invalid_name", "name is required")
    if pack_type not in PACK_TYPES:
        raise NotificationPackError("invalid_type", f"type must be one of {PACK_TYPES}")
    if not (title_template or "").strip():
        raise NotificationPackError("invalid_title_template", "title_template is required")
    if not (body_template or "").strip():
        raise NotificationPackError("invalid_body_template", "body_template is required")
    now = _now_iso()
    doc = {
        "_id": _new_id(),
        "name": name,
        "type": pack_type,
        "title_template": title_template.strip(),
        "body_template": body_template.strip(),
        "url_template": (url_template or "").strip(),
        "placeholders": [str(p).strip() for p in (placeholders or []) if str(p).strip()],
        "status": "draft",
        "version": 1,
        "created_by": created_by,
        "created_at": now,
        "updated_at": now,
        "published_at": None,
        "archived_at": None,
    }
    await db[PACKS_COLL].insert_one(doc)
    return doc


async def get_pack(db, pack_id: str) -> Optional[dict]:
    return await db[PACKS_COLL].find_one({"_id": pack_id})


async def list_packs(db, *, pack_type: Optional[str] = None, status: Optional[str] = None) -> list[dict]:
    query: dict = {}
    if pack_type:
        query["type"] = pack_type
    if status:
        query["status"] = status
    cursor = db[PACKS_COLL].find(query, {}).sort("updated_at", -1)
    return [doc async for doc in cursor]


_EDITABLE_FIELDS = ("name", "title_template", "body_template", "url_template", "placeholders")


async def update_pack(db, pack_id: str, updates: dict, *, updated_by: str) -> dict:
    """Only mutable while ``draft`` — matches question_bank.py's and
    event_engine.py's template lifecycle rule (a published pack is
    immutable so anything referencing it isn't surprised; unpublish
    first to edit)."""
    pack = await get_pack(db, pack_id)
    if not pack:
        raise NotificationPackError("pack_not_found", http_status=404)
    if pack["status"] != "draft":
        raise NotificationPackError(
            "pack_not_editable",
            "Only a draft notification pack can be edited. Unpublish it first.",
        )
    changes: dict[str, Any] = {}
    for field in _EDITABLE_FIELDS:
        if field not in updates:
            continue
        if field == "placeholders":
            changes[field] = [str(p).strip() for p in (updates[field] or []) if str(p).strip()]
        elif (updates[field] or "").strip() or field == "url_template":
            changes[field] = (updates[field] or "").strip()
    changes["version"] = int(pack.get("version") or 1) + 1
    changes["updated_at"] = _now_iso()
    changes["updated_by"] = updated_by
    await db[PACKS_COLL].update_one({"_id": pack_id}, {"$set": changes})
    return await get_pack(db, pack_id)


async def publish_pack(db, pack_id: str, *, updated_by: str) -> dict:
    pack = await get_pack(db, pack_id)
    if not pack:
        raise NotificationPackError("pack_not_found", http_status=404)
    if pack["status"] == "archived":
        raise NotificationPackError("pack_archived", "An archived pack cannot be published.")
    now = _now_iso()
    await db[PACKS_COLL].update_one(
        {"_id": pack_id},
        {"$set": {"status": "published", "published_at": now, "updated_at": now,
                   "updated_by": updated_by}},
    )
    return await get_pack(db, pack_id)


async def unpublish_pack(db, pack_id: str, *, updated_by: str) -> dict:
    pack = await get_pack(db, pack_id)
    if not pack:
        raise NotificationPackError("pack_not_found", http_status=404)
    now = _now_iso()
    await db[PACKS_COLL].update_one(
        {"_id": pack_id},
        {"$set": {"status": "draft", "updated_at": now, "updated_by": updated_by}},
    )
    return await get_pack(db, pack_id)


async def archive_pack(db, pack_id: str, *, updated_by: str) -> dict:
    pack = await get_pack(db, pack_id)
    if not pack:
        raise NotificationPackError("pack_not_found", http_status=404)
    now = _now_iso()
    await db[PACKS_COLL].update_one(
        {"_id": pack_id},
        {"$set": {"status": "archived", "archived_at": now, "updated_at": now,
                   "updated_by": updated_by}},
    )
    return await get_pack(db, pack_id)


async def delete_pack(db, pack_id: str) -> bool:
    """Permanent delete — only allowed for draft/archived packs, mirroring
    question_bank.py's delete_question guard (a published pack may be
    referenced by an Event Template's notification_pack_ref)."""
    pack = await get_pack(db, pack_id)
    if not pack:
        raise NotificationPackError("pack_not_found", http_status=404)
    if pack["status"] == "published":
        raise NotificationPackError(
            "pack_published",
            "Unpublish or archive this notification pack before deleting it.",
        )
    result = await db[PACKS_COLL].delete_one({"_id": pack_id})
    return bool(getattr(result, "deleted_count", 0))


# ─────────────────────────────────────────────────────────────────────────
# Routes — Author Studio's "Notification Packs" screen
# ─────────────────────────────────────────────────────────────────────────
def register_notification_pack_routes(api, db, require_admin) -> None:
    """Mounts /api/v1/notification-packs* onto the existing FastAPI
    router. Admin-only, matching question_bank.py's 3-arg register_*_
    routes(api, db, require_admin) convention — Author-Studio-only, no
    student-facing surface."""
    from fastapi import Body, Depends, HTTPException

    def _raise(exc: NotificationPackError):
        raise HTTPException(status_code=exc.http_status, detail=exc.message)

    @api.get("/v1/notification-packs")
    async def list_packs_route(type: str = "", status: str = "", _admin=Depends(require_admin)):
        docs = await list_packs(db, pack_type=type or None, status=status or None)
        return {"packs": docs}

    @api.post("/v1/notification-packs")
    async def create_pack_route(payload: dict = Body(...), admin=Depends(require_admin)):
        try:
            doc = await create_pack(
                db, name=payload.get("name", ""), pack_type=payload.get("type", ""),
                title_template=payload.get("title_template", ""),
                body_template=payload.get("body_template", ""),
                url_template=payload.get("url_template", ""),
                placeholders=payload.get("placeholders"),
                created_by=getattr(admin, "email", ""),
            )
        except NotificationPackError as exc:
            _raise(exc)
        return {"ok": True, "pack": doc}

    @api.get("/v1/notification-packs/{pack_id}")
    async def get_pack_route(pack_id: str, _admin=Depends(require_admin)):
        doc = await get_pack(db, pack_id)
        if not doc:
            raise HTTPException(status_code=404, detail="notification pack not found")
        return {"pack": doc}

    @api.patch("/v1/notification-packs/{pack_id}")
    async def update_pack_route(pack_id: str, payload: dict = Body(...), admin=Depends(require_admin)):
        try:
            doc = await update_pack(db, pack_id, payload, updated_by=getattr(admin, "email", ""))
        except NotificationPackError as exc:
            _raise(exc)
        return {"ok": True, "pack": doc}

    @api.post("/v1/notification-packs/{pack_id}/publish")
    async def publish_pack_route(pack_id: str, admin=Depends(require_admin)):
        try:
            doc = await publish_pack(db, pack_id, updated_by=getattr(admin, "email", ""))
        except NotificationPackError as exc:
            _raise(exc)
        return {"ok": True, "pack": doc}

    @api.post("/v1/notification-packs/{pack_id}/unpublish")
    async def unpublish_pack_route(pack_id: str, admin=Depends(require_admin)):
        try:
            doc = await unpublish_pack(db, pack_id, updated_by=getattr(admin, "email", ""))
        except NotificationPackError as exc:
            _raise(exc)
        return {"ok": True, "pack": doc}

    @api.post("/v1/notification-packs/{pack_id}/archive")
    async def archive_pack_route(pack_id: str, admin=Depends(require_admin)):
        try:
            doc = await archive_pack(db, pack_id, updated_by=getattr(admin, "email", ""))
        except NotificationPackError as exc:
            _raise(exc)
        return {"ok": True, "pack": doc}

    @api.delete("/v1/notification-packs/{pack_id}")
    async def delete_pack_route(pack_id: str, _admin=Depends(require_admin)):
        try:
            deleted = await delete_pack(db, pack_id)
        except NotificationPackError as exc:
            _raise(exc)
        return {"ok": True, "deleted": deleted}

    @api.post("/v1/notification-packs/{pack_id}/preview")
    async def preview_pack_route(
        pack_id: str, payload: dict = Body(default_factory=dict), _admin=Depends(require_admin),
    ):
        doc = await get_pack(db, pack_id)
        if not doc:
            raise HTTPException(status_code=404, detail="notification pack not found")
        return {"preview": render_pack(doc, payload.get("context") or {})}

    logger.info("notification_packs: routes registered (/api/v1/notification-packs*)")


async def ensure_notification_pack_indexes(db) -> None:
    await db[PACKS_COLL].create_index("type")
    await db[PACKS_COLL].create_index("status")
    await db[PACKS_COLL].create_index([("type", 1), ("status", 1)])
    logger.info("notification_packs: indexes ready")


__all__ = [
    "PACKS_COLL",
    "PACK_TYPES",
    "NotificationPackError",
    "render_template",
    "render_pack",
    "create_pack",
    "get_pack",
    "list_packs",
    "update_pack",
    "publish_pack",
    "unpublish_pack",
    "archive_pack",
    "delete_pack",
    "register_notification_pack_routes",
    "ensure_notification_pack_indexes",
]
