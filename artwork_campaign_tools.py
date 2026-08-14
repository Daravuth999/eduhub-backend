"""
artwork_campaign_tools.py — Author Studio Artwork Campaign System v1.0

ISOLATED & ADDITIVE module. Registers a self-contained set of routes for
managing promotional artwork campaigns (Dashboard Hero, Library Hero,
Featured Collection, Shelf Card). It touches NOTHING else:

  * No EduTalk / audio / reader / wallet / payment / auth code is imported
    or modified here.
  * Storage is a dedicated `artwork_campaigns` MongoDB collection.
  * v1.0 is LINK-BASED: admins configure one high-quality `image_url`; the
    frontend handles all responsive sizing (object-fit). No server-side
    image processing, no new object-storage infra, no base64 in Mongo.

Routes (all `/api`-prefixed via the shared `api` router):

  Admin (require_admin):
    GET    /api/artwork-campaigns            list all
    POST   /api/artwork-campaigns            create
    GET    /api/artwork-campaigns/{id}       fetch one
    PUT    /api/artwork-campaigns/{id}       update
    DELETE /api/artwork-campaigns/{id}       delete

  Public (no auth — read-only, only returns active + in-window campaigns):
    GET    /api/artwork-campaigns/active?placement=<key>
"""
from __future__ import annotations

import logging
import uuid
from datetime import datetime, timezone

from fastapi import Depends, HTTPException

log = logging.getLogger("eduhub.artwork")

PLACEMENTS = {
    "dashboard_hero",
    "library_hero",
    "library_featured",
    "library_shelf",
}

CLICK_ACTION_TYPES = {
    "topup",
    "book",
    "collection",
    "speaking_lab",
    "edutalk",
    "reward",
    "internal_route",
    "external_url",
}

ANIMATIONS = {"none", "fade", "slide", "float", "zoom", "parallax"}

# Display-safe allowlist. The /active endpoint is PUBLIC (called by student
# browsers) so it must NEVER expose internal/admin metadata such as
# created_by (admin email), created_at or updated_at. Only the fields below
# — exactly what the frontend renderers consume — are returned publicly.
PUBLIC_FIELDS = (
    "id",
    "name",
    "image_url",
    "fallback_url",
    "image_focus",
    "placements",
    "click_action",
    "animation",
    "priority",
    "start_date",
    "end_date",
    "active",
)


def _public_view(doc: dict) -> dict:
    """Project a campaign document down to display-safe public fields only."""
    return {k: doc.get(k) for k in PUBLIC_FIELDS}


def _now_iso() -> str:
    return datetime.now(timezone.utc).isoformat()


def _coerce_placements(raw) -> list[str]:
    if isinstance(raw, str):
        raw = [raw]
    if not isinstance(raw, (list, tuple)):
        return []
    out = [p for p in raw if p in PLACEMENTS]
    return list(dict.fromkeys(out))  # de-dupe, keep order


def _coerce_click_action(raw) -> dict:
    if not isinstance(raw, dict):
        return {"type": "internal_route", "value": "/library"}
    a_type = raw.get("type") if raw.get("type") in CLICK_ACTION_TYPES else "internal_route"
    value = str(raw.get("value") or "").strip()
    return {"type": a_type, "value": value}


def _sanitize(payload: dict, created_by: str, existing: dict | None = None) -> dict:
    """Build a clean campaign document from admin payload."""
    base = dict(existing or {})
    name = str(payload.get("name") or base.get("name") or "").strip()
    if not name:
        raise HTTPException(status_code=400, detail="Campaign name is required.")

    image_url = str(payload.get("image_url") or base.get("image_url") or "").strip()
    if not image_url:
        raise HTTPException(status_code=400, detail="image_url is required (v1.0 is link-based).")

    placements = _coerce_placements(
        payload.get("placements", base.get("placements", []))
    )
    if not placements:
        raise HTTPException(status_code=400, detail="At least one valid placement is required.")

    try:
        priority = int(payload.get("priority", base.get("priority", 5)))
    except (TypeError, ValueError):
        priority = 5
    priority = max(1, min(10, priority))

    animation = payload.get("animation", base.get("animation", "fade"))
    if animation not in ANIMATIONS:
        animation = "fade"

    doc = {
        "id":          base.get("id") or uuid.uuid4().hex,
        "name":        name,
        "image_url":   image_url,
        "fallback_url": str(payload.get("fallback_url") or base.get("fallback_url") or "").strip() or None,
        "image_focus": str(payload.get("image_focus") or base.get("image_focus") or "center").strip() or "center",
        "placements":  placements,
        "click_action": _coerce_click_action(
            payload.get("click_action", base.get("click_action"))
        ),
        "animation":   animation,
        "start_date":  (payload.get("start_date") if "start_date" in payload else base.get("start_date")) or None,
        "end_date":    (payload.get("end_date") if "end_date" in payload else base.get("end_date")) or None,
        "priority":    priority,
        "active":      bool(payload.get("active", base.get("active", True))),
        "created_by":  base.get("created_by") or created_by,
        "created_at":  base.get("created_at") or _now_iso(),
        "updated_at":  _now_iso(),
    }
    return doc


def _parse_dt(value):
    if not value:
        return None
    if isinstance(value, datetime):
        dt = value
    else:
        try:
            dt = datetime.fromisoformat(str(value).replace("Z", "+00:00"))
        except (TypeError, ValueError):
            return None
    if dt.tzinfo is None:
        dt = dt.replace(tzinfo=timezone.utc)
    return dt


def _is_live(doc: dict, now: datetime) -> bool:
    if not doc.get("active"):
        return False
    start = _parse_dt(doc.get("start_date"))
    end = _parse_dt(doc.get("end_date"))
    if start and now < start:
        return False
    if end and now > end:
        return False
    return True


def register_artwork_campaign_routes(api, db, require_admin):
    """Wire artwork-campaign routes onto the shared `api` router."""

    coll = db.artwork_campaigns

    @api.get("/artwork-campaigns")
    async def list_artwork_campaigns(admin=Depends(require_admin)):
        cursor = coll.find({}, {"_id": 0}).sort([("priority", -1), ("created_at", -1)])
        items = await cursor.to_list(length=500)
        return {"ok": True, "campaigns": items}

    @api.post("/artwork-campaigns")
    async def create_artwork_campaign(payload: dict, admin=Depends(require_admin)):
        doc = _sanitize(payload, created_by=getattr(admin, "email", "admin"))
        await coll.insert_one(dict(doc))
        log.info("artwork: created '%s' (%s) by %s", doc["name"], doc["id"], getattr(admin, "email", "?"))
        return {"ok": True, "campaign": doc}

    @api.get("/artwork-campaigns/active")
    async def active_artwork_campaigns(placement: str | None = None):
        """Public, read-only. Returns live campaigns, optionally filtered by placement."""
        query: dict = {"active": True}
        if placement:
            if placement not in PLACEMENTS:
                return {"ok": True, "campaigns": []}
            query["placements"] = placement
        cursor = coll.find(query, {"_id": 0}).sort([("priority", -1), ("created_at", -1)])
        raw = await cursor.to_list(length=200)
        now = datetime.now(timezone.utc)
        # Filter by schedule window, then strip to display-safe public fields
        # so created_by / created_at / updated_at never leave the server.
        live = [_public_view(d) for d in raw if _is_live(d, now)]
        return {"ok": True, "campaigns": live}

    @api.get("/artwork-campaigns/{campaign_id}")
    async def get_artwork_campaign(campaign_id: str, admin=Depends(require_admin)):
        doc = await coll.find_one({"id": campaign_id}, {"_id": 0})
        if not doc:
            raise HTTPException(status_code=404, detail="Campaign not found.")
        return {"ok": True, "campaign": doc}

    @api.put("/artwork-campaigns/{campaign_id}")
    async def update_artwork_campaign(campaign_id: str, payload: dict, admin=Depends(require_admin)):
        existing = await coll.find_one({"id": campaign_id}, {"_id": 0})
        if not existing:
            raise HTTPException(status_code=404, detail="Campaign not found.")
        doc = _sanitize(payload, created_by=getattr(admin, "email", "admin"), existing=existing)
        await coll.update_one({"id": campaign_id}, {"$set": doc})
        log.info("artwork: updated %s by %s", campaign_id, getattr(admin, "email", "?"))
        return {"ok": True, "campaign": doc}

    @api.delete("/artwork-campaigns/{campaign_id}")
    async def delete_artwork_campaign(campaign_id: str, admin=Depends(require_admin)):
        res = await coll.delete_one({"id": campaign_id})
        if res.deleted_count == 0:
            raise HTTPException(status_code=404, detail="Campaign not found.")
        log.info("artwork: deleted %s by %s", campaign_id, getattr(admin, "email", "?"))
        return {"ok": True}

    log.info("artwork_campaign_tools: routes registered (artwork campaigns v1.0)")
