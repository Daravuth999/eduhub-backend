"""
experience_config_tools.py — EduHub Experience Configuration Platform (v1.0)
══════════════════════════════════════════════════════════════════════════════
100% additive — bolts onto the existing FastAPI app without touching any
protected business logic. Same isolation convention as notification_center.py.

WHAT THIS IS
────────────
A generic, reusable configuration platform for premium "experience" surfaces
across EduHub — NOT a "Welcome Hero" system. The Welcome Dashboard hero is
simply the FIRST experience type to consume it. Every field, collection, and
route name below is deliberately experience-type-agnostic so future surfaces
(Digital Books hero, Speaking Lab landing, AI Assistant greeting, achievement
celebrations, seasonal campaigns, promotional banners, onboarding) can reuse
the exact same model without a schema redesign.

DOMAIN SEPARATION
──────────────────
Every config document separates FIVE independent domains — never mix
presentation values into `content`:
  content     — what it says (title, subtitle, description, CTA, visibility)
  appearance  — how it looks (theme reference, palette, typography, radius,
                glass/shadow/lighting settings, safe margins)
  motion      — how it moves (references a motion preset + entrance/stagger/
                easing/sunrise/bloom/particle/ambient/idle overrides)
  playback    — when/how often it plays (first-launch-of-day, per-session,
                replay interval, reduced-motion mode, performance mode)
  scheduling  — when it's active (activeWindow start/end, draft/published/
                expired status)

`appearance`/`motion` REFERENCE presets by id (theme_presets / motion_presets
collections) rather than inlining every value — this is what makes the
platform-level design/motion tokens (frontend) reusable across experiences
instead of re-specified per document.

RESOLUTION CONTRACT (enforced by the frontend resolver, not this module —
this module only ever answers "what is published and active for this type
right now?"):
  1. A published experience_configs doc, active for "now", for the
     requested experienceType — if one exists, it wins.
  2. (frontend-only) legacy Google Sheets compatibility adapter.
  3. (frontend-only) hardcoded per-type defaults.
This module implements ONLY tier 1. Tiers 2-3 have no backend involvement —
Sheets stays a read-only legacy content source, never written to or merged
here.

STORAGE
───────
Collection ``experience_configs``:
  experienceType   e.g. "welcome_dashboard" (open string, not a hard enum —
                   new experience types never require a schema migration)
  key              distinguishes multiple configs of the same type
                   (e.g. a seasonal variant vs. the type's "default")
  status           draft | published | expired
  activeWindow     { startsAt: iso|null, endsAt: iso|null } — null means
                   unbounded on that side
  content / appearance / motion / playback   see domain separation above
  version          monotonic int, bumped on every update (optimistic
                   concurrency + audit trail — Author Studio will use this)
  createdAt, updatedAt, createdBy

WIRING (1 surgical insertion in server.py, same convention as every other
isolated module in this codebase):
  from experience_config_tools import register_experience_config_routes
  register_experience_config_routes(api, app, db, require_admin)

Phase 1 scope was read-only (`GET /experience-configs/active` only).

Phase 3 adds the Author Studio management surface — full CRUD plus the
explicit draft/published lifecycle actions — so "code defines
capabilities, Author Studio controls the experience" (every visual/
motion/playback value becomes admin-editable, not a code change):

  Admin (require_admin), all `/api`-prefixed:
    GET    /experience-configs?type=<t>        list (drafts included)
    POST   /experience-configs                 create draft
    GET    /experience-configs/{id}            fetch one
    PUT    /experience-configs/{id}             update content/appearance/
                                                 motion/playback/activeWindow
                                                 (bumps version; never
                                                 touches status)
    POST   /experience-configs/{id}/publish    draft -> published
    POST   /experience-configs/{id}/unpublish  published -> draft
    POST   /experience-configs/{id}/duplicate  clone as a new draft
    DELETE /experience-configs/{id}            delete (published requires
                                                 ?force=true — unpublish
                                                 first is the safe path)

Public (no auth):
    GET    /experience-configs/active?type=<t>  unchanged from Phase 1.

Documents use a UUID `id` field (same convention as
artwork_campaign_tools.py) rather than a stringified Mongo `_id` — `_id`
is always projected out of every response.
"""
from __future__ import annotations

import logging
import uuid
from datetime import datetime, timezone
from typing import Any, Optional

from fastapi import Depends, HTTPException, Query

log = logging.getLogger("eduhub.experience_config")

# Known experience types as of Phase 1. This is documentation, NOT a
# validation allowlist — `experienceType` is stored as a plain string so a
# future experience never requires touching this module.
KNOWN_EXPERIENCE_TYPES = (
    "welcome_dashboard",
    "digital_books_hero",
    "speaking_lab_landing",
    "ai_assistant_greeting",
    "achievement_celebration",
    "seasonal_campaign",
    "promotional_banner",
    "onboarding",
)


def _parse_iso(value: Any) -> Optional[datetime]:
    if not value:
        return None
    if isinstance(value, datetime):
        return value if value.tzinfo else value.replace(tzinfo=timezone.utc)
    try:
        dt = datetime.fromisoformat(str(value).replace("Z", "+00:00"))
        return dt if dt.tzinfo else dt.replace(tzinfo=timezone.utc)
    except ValueError:
        return None


def _is_active_now(doc: dict, now: datetime) -> bool:
    if doc.get("status") != "published":
        return False
    window = doc.get("activeWindow") or {}
    starts = _parse_iso(window.get("startsAt"))
    ends = _parse_iso(window.get("endsAt"))
    if starts and now < starts:
        return False
    if ends and now > ends:
        return False
    return True


def _serialize(doc: dict) -> dict:
    return {
        "id": doc.get("id", ""),
        "experienceType": doc.get("experienceType", ""),
        "key": doc.get("key", "default"),
        "status": doc.get("status", "draft"),
        "activeWindow": doc.get("activeWindow") or {"startsAt": None, "endsAt": None},
        "content": doc.get("content") or {},
        "appearance": doc.get("appearance") or {},
        "motion": doc.get("motion") or {},
        "playback": doc.get("playback") or {},
        "version": doc.get("version", 1),
        "createdBy": doc.get("createdBy", ""),
        "createdAt": doc.get("createdAt").isoformat() if isinstance(doc.get("createdAt"), datetime) else doc.get("createdAt"),
        "updatedAt": doc.get("updatedAt").isoformat() if isinstance(doc.get("updatedAt"), datetime) else doc.get("updatedAt"),
    }


def _as_domain_dict(value: Any) -> dict:
    """content/appearance/motion/playback are intentionally free-form per
    experience type (the whole point of the generic platform) — this just
    guards against a non-dict payload crashing the write, it does not
    enforce a fixed shape."""
    return value if isinstance(value, dict) else {}


def _sanitize_active_window(value: Any) -> dict:
    if not isinstance(value, dict):
        return {"startsAt": None, "endsAt": None}
    return {
        "startsAt": value.get("startsAt") or None,
        "endsAt": value.get("endsAt") or None,
    }


async def ensure_experience_config_indexes(db) -> None:
    coll = db["experience_configs"]
    await coll.create_index([("experienceType", 1), ("status", 1)])
    await coll.create_index([("experienceType", 1), ("key", 1)], unique=True)
    await coll.create_index([("id", 1)], unique=True)


def register_experience_config_routes(api, app, db, require_admin=None) -> None:
    coll = db["experience_configs"]

    @api.get("/experience-configs/active")
    async def get_active_experience_config(
        type: str = Query(..., min_length=1, max_length=64, alias="type"),
    ):
        """Public, read-only. Returns the currently-active PUBLISHED config
        for the given experienceType, or {"config": null} if none exists —
        callers (the frontend resolver) fall through to the legacy Sheets
        adapter and then hardcoded defaults on a null response. This route
        NEVER 404s for "no config" — an absent experience config is a
        normal, expected state during migration, not an error.
        """
        now = datetime.now(timezone.utc)
        candidates = coll.find({"experienceType": type, "status": "published"})
        best = None
        async for doc in candidates:
            if not _is_active_now(doc, now):
                continue
            # Prefer the most recently updated active candidate if more
            # than one is somehow active at once (e.g. overlapping
            # seasonal windows) — deterministic, no ambiguity.
            if best is None or (doc.get("updatedAt") or now) > (best.get("updatedAt") or now):
                best = doc
        return {"config": _serialize(best) if best else None}

    if require_admin is not None:
        _register_admin_crud_routes(api, coll, require_admin)

    @app.on_event("startup")
    async def _experience_config_startup():
        try:
            await ensure_experience_config_indexes(db)
            log.info("experience-config: indexes ready")
        except Exception as exc:  # noqa: BLE001
            log.warning("experience-config: index bootstrap failed: %s", str(exc)[:200])

    log.info("experience-config: routes registered (/api/experience-configs/active)")


def _register_admin_crud_routes(api, coll, require_admin) -> None:
    """Author Studio management surface — Phase 3. Kept as a separate
    function (rather than inline in register_experience_config_routes) so
    a caller that only wants the public read-only route can omit
    `require_admin` entirely and get Phase 1 behavior unchanged."""

    @api.get("/experience-configs")
    async def list_experience_configs(
        type: Optional[str] = Query(default=None, alias="type"),
        admin=Depends(require_admin),
    ):
        query = {"experienceType": type} if type else {}
        cursor = coll.find(query, {"_id": 0}).sort([("updatedAt", -1)])
        items = await cursor.to_list(length=500)
        return {"ok": True, "configs": [_serialize(d) for d in items]}

    @api.post("/experience-configs")
    async def create_experience_config(payload: dict, admin=Depends(require_admin)):
        experience_type = str(payload.get("experienceType") or "").strip()
        if not experience_type:
            raise HTTPException(status_code=400, detail="experienceType is required.")
        key = str(payload.get("key") or "default").strip() or "default"

        existing = await coll.find_one({"experienceType": experience_type, "key": key})
        if existing:
            raise HTTPException(
                status_code=409,
                detail=f"A config for experienceType='{experience_type}' key='{key}' already exists.",
            )

        now = datetime.now(timezone.utc)
        doc = {
            "id": uuid.uuid4().hex,
            "experienceType": experience_type,
            "key": key,
            "status": "draft",
            "activeWindow": _sanitize_active_window(payload.get("activeWindow")),
            "content": _as_domain_dict(payload.get("content")),
            "appearance": _as_domain_dict(payload.get("appearance")),
            "motion": _as_domain_dict(payload.get("motion")),
            "playback": _as_domain_dict(payload.get("playback")),
            "version": 1,
            "createdBy": getattr(admin, "email", "admin"),
            "createdAt": now,
            "updatedAt": now,
        }
        await coll.insert_one(dict(doc))
        log.info("experience-config: created %s/%s (%s) by %s", experience_type, key, doc["id"], doc["createdBy"])
        return {"ok": True, "config": _serialize(doc)}

    @api.get("/experience-configs/{config_id}")
    async def get_experience_config(config_id: str, admin=Depends(require_admin)):
        doc = await coll.find_one({"id": config_id})
        if not doc:
            raise HTTPException(status_code=404, detail="Config not found.")
        return {"ok": True, "config": _serialize(doc)}

    @api.put("/experience-configs/{config_id}")
    async def update_experience_config(config_id: str, payload: dict, admin=Depends(require_admin)):
        existing = await coll.find_one({"id": config_id})
        if not existing:
            raise HTTPException(status_code=404, detail="Config not found.")

        updates = {"updatedAt": datetime.now(timezone.utc), "version": existing.get("version", 1) + 1}
        for domain in ("content", "appearance", "motion", "playback"):
            if domain in payload:
                updates[domain] = _as_domain_dict(payload.get(domain))
        if "activeWindow" in payload:
            updates["activeWindow"] = _sanitize_active_window(payload.get("activeWindow"))

        await coll.update_one({"id": config_id}, {"$set": updates})
        doc = await coll.find_one({"id": config_id})
        log.info("experience-config: updated %s by %s (v%s)", config_id, getattr(admin, "email", "?"), doc.get("version"))
        return {"ok": True, "config": _serialize(doc)}

    @api.post("/experience-configs/{config_id}/publish")
    async def publish_experience_config(config_id: str, admin=Depends(require_admin)):
        existing = await coll.find_one({"id": config_id})
        if not existing:
            raise HTTPException(status_code=404, detail="Config not found.")
        await coll.update_one(
            {"id": config_id},
            {"$set": {"status": "published", "updatedAt": datetime.now(timezone.utc)}},
        )
        doc = await coll.find_one({"id": config_id})
        log.info("experience-config: published %s by %s", config_id, getattr(admin, "email", "?"))
        return {"ok": True, "config": _serialize(doc)}

    @api.post("/experience-configs/{config_id}/unpublish")
    async def unpublish_experience_config(config_id: str, admin=Depends(require_admin)):
        existing = await coll.find_one({"id": config_id})
        if not existing:
            raise HTTPException(status_code=404, detail="Config not found.")
        await coll.update_one(
            {"id": config_id},
            {"$set": {"status": "draft", "updatedAt": datetime.now(timezone.utc)}},
        )
        doc = await coll.find_one({"id": config_id})
        log.info("experience-config: unpublished %s by %s", config_id, getattr(admin, "email", "?"))
        return {"ok": True, "config": _serialize(doc)}

    @api.post("/experience-configs/{config_id}/duplicate")
    async def duplicate_experience_config(config_id: str, payload: Optional[dict] = None, admin=Depends(require_admin)):
        existing = await coll.find_one({"id": config_id})
        if not existing:
            raise HTTPException(status_code=404, detail="Config not found.")

        new_key = str((payload or {}).get("key") or f"{existing.get('key', 'default')}-copy-{uuid.uuid4().hex[:6]}").strip()
        if await coll.find_one({"experienceType": existing["experienceType"], "key": new_key}):
            raise HTTPException(
                status_code=409,
                detail=f"A config for experienceType='{existing['experienceType']}' key='{new_key}' already exists.",
            )

        now = datetime.now(timezone.utc)
        doc = {
            "id": uuid.uuid4().hex,
            "experienceType": existing["experienceType"],
            "key": new_key,
            "status": "draft",
            "activeWindow": existing.get("activeWindow") or {"startsAt": None, "endsAt": None},
            "content": existing.get("content") or {},
            "appearance": existing.get("appearance") or {},
            "motion": existing.get("motion") or {},
            "playback": existing.get("playback") or {},
            "version": 1,
            "createdBy": getattr(admin, "email", "admin"),
            "createdAt": now,
            "updatedAt": now,
        }
        await coll.insert_one(dict(doc))
        log.info("experience-config: duplicated %s -> %s by %s", config_id, doc["id"], doc["createdBy"])
        return {"ok": True, "config": _serialize(doc)}

    @api.delete("/experience-configs/{config_id}")
    async def delete_experience_config(config_id: str, force: bool = False, admin=Depends(require_admin)):
        existing = await coll.find_one({"id": config_id})
        if not existing:
            raise HTTPException(status_code=404, detail="Config not found.")
        if existing.get("status") == "published" and not force:
            raise HTTPException(
                status_code=409,
                detail="This config is published (live). Unpublish it first, or pass ?force=true to delete anyway.",
            )
        await coll.delete_one({"id": config_id})
        log.info("experience-config: deleted %s by %s (force=%s)", config_id, getattr(admin, "email", "?"), force)
        return {"ok": True}
