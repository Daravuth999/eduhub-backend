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
  register_experience_config_routes(api, app, db)

Phase 1 scope: read-only. `GET /experience-configs/active` is the ONLY
route. Create/update/publish/duplicate/import-export (Author Studio's
backend surface) are deliberately NOT built yet — the schema above is
shaped so they can be added later without breaking this contract or
requiring existing published documents to change shape.
"""
from __future__ import annotations

import logging
from datetime import datetime, timezone
from typing import Any, Optional

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
        "id": str(doc.get("_id", "")),
        "experienceType": doc.get("experienceType", ""),
        "key": doc.get("key", "default"),
        "status": doc.get("status", "draft"),
        "activeWindow": doc.get("activeWindow") or {"startsAt": None, "endsAt": None},
        "content": doc.get("content") or {},
        "appearance": doc.get("appearance") or {},
        "motion": doc.get("motion") or {},
        "playback": doc.get("playback") or {},
        "version": doc.get("version", 1),
        "updatedAt": doc.get("updatedAt").isoformat() if isinstance(doc.get("updatedAt"), datetime) else doc.get("updatedAt"),
    }


async def ensure_experience_config_indexes(db) -> None:
    coll = db["experience_configs"]
    await coll.create_index([("experienceType", 1), ("status", 1)])
    await coll.create_index([("experienceType", 1), ("key", 1)], unique=True)


def register_experience_config_routes(api, app, db) -> None:
    from fastapi import Query

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

    @app.on_event("startup")
    async def _experience_config_startup():
        try:
            await ensure_experience_config_indexes(db)
            log.info("experience-config: indexes ready")
        except Exception as exc:  # noqa: BLE001
            log.warning("experience-config: index bootstrap failed: %s", str(exc)[:200])

    log.info("experience-config: routes registered (/api/experience-configs/active)")
