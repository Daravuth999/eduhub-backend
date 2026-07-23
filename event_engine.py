"""event_engine.py — the Event Engine (architecture.md §4.3, Migration
Phase 3). Speaking Lab becomes the FIRST event *type* instead of its own
hard-coded system.

SCOPE OF THIS INCREMENT (v1) — read before extending
─────────────────────────────────────────────────────
This wraps, rather than rewrites, the existing battle-tested internals,
per architecture.md's own risk mitigation ("Wrap, don't rewrite: keep
_perform_join and the draw state machine as the engine's internals"):

  * Registration reuses speaking_lab_direct_join.py's ``_run_direct_join``
    — the SAME atomic join+wallet-charge+ticket-assignment transaction
    every existing Speaking Lab flow already uses. Nothing about how a
    student joins changed; only the caller (Event Engine instead of the
    raw /api/speaking-lab/direct-join route) is new.
  * An Event of event_type="speaking_lab_session" drives an underlying
    ``speaking_lab_sessions`` document using the EXACT field shape
    server.py's own ``sl_create_session`` route already writes
    (session_id / schedule / entry_fee / treasury_id / status /
    created_by / created_at / auto_enroll) — so every existing route
    that reads a session (eligibility, teacher admission, the live SSE
    stream, lucky draw) keeps working unchanged against events created
    this way.

NOT YET WRAPPED (explicitly deferred, not silently skipped) — the Draw /
PrizePool machinery. lucky_draw.py's payout state machine lives entirely
inside its single ``register_lucky_draw_routes`` closure today (no
module-level function analogous to ``_run_direct_join`` to call), so
wrapping it here would mean either duplicating that logic or first
refactoring lucky_draw.py to expose one — real work, not attempted in
this increment. Events can reach "live" and be operated through the
EXISTING lucky-draw admin routes exactly as today; the Event's own
lifecycle just tracks "drawing/settling/settled" as bookkeeping states
an operator advances explicitly once the legacy draw flow completes.

DATA MODEL
──────────
``event_templates`` — versioned, draft/publish/archive lifecycle
  (Author Studio-owned, matches architecture.md's T2 config tier):
    _id, name, event_type, status (draft|published|archived), version,
    registration_policy, eligibility, prize_policy, question_bank_ref,
    timers, notification_pack_ref, branding, runtime_defaults,
    created_by, created_at, updated_at, published_at, archived_at

``events`` — runtime instances, state-machined, config snapshot frozen
  at creation (architecture.md §4.3 — "why snapshots matter"):
    _id, event_type, template_id, template_version, config_snapshot,
    state, state_history, linked_session_id, schedule, created_by,
    created_at, updated_at
"""
from __future__ import annotations

import copy
import logging
import uuid
from datetime import datetime, timezone
from typing import Any, Optional

logger = logging.getLogger("eduhub.event_engine")

TEMPLATES_COLL = "event_templates"
EVENTS_COLL = "events"

TEMPLATE_STATUSES = ("draft", "published", "archived")
EVENT_TYPES = ("speaking_lab_session",)

# The teacher-facing lifecycle (architecture.md §4.3). "drawing"/
# "settling"/"settled" are currently advanced explicitly by an operator
# once the legacy lucky-draw flow completes — see the module docstring.
EVENT_STATES = (
    "draft", "scheduled", "registration_open", "live",
    "drawing", "settling", "settled", "archived", "cancelled",
)
_ALLOWED_TRANSITIONS: dict[str, set[str]] = {
    "draft": {"scheduled", "cancelled"},
    "scheduled": {"registration_open", "cancelled"},
    "registration_open": {"live", "cancelled"},
    "live": {"drawing", "cancelled"},
    "drawing": {"settling", "cancelled"},
    "settling": {"settled"},
    "settled": {"archived"},
    "cancelled": {"archived"},
}
# Session states (teacher_admission.ALLOWED_SESSION_STATES) an event's
# underlying speaking_lab_sessions row should carry for each event state.
_SESSION_STATUS_FOR_EVENT_STATE: dict[str, str] = {
    "registration_open": "waiting",
    "live": "active",
    "drawing": "active",
    "settling": "closed",
    "settled": "closed",
    "cancelled": "closed",
    "archived": "closed",
}


class EventEngineError(Exception):
    def __init__(self, code: str, message: str = "", http_status: int = 400) -> None:
        super().__init__(message or code)
        self.code = code
        self.message = message or code
        self.http_status = http_status


def _now_iso() -> str:
    return datetime.now(timezone.utc).isoformat()


def _new_id(prefix: str) -> str:
    return f"{prefix}_{uuid.uuid4().hex[:16]}"


# ─────────────────────────────────────────────────────────────────────────
# Event Templates — Author Studio's CRUD surface (T2 config tier)
# ─────────────────────────────────────────────────────────────────────────
_TEMPLATE_CONTENT_FIELDS = (
    "registration_policy", "eligibility", "prize_policy",
    "question_bank_ref", "timers", "notification_pack_ref",
    "branding", "runtime_defaults",
)


def _clean_template_content(payload: dict) -> dict:
    return {k: payload.get(k) for k in _TEMPLATE_CONTENT_FIELDS if k in payload}


async def create_template(
    db, *, name: str, event_type: str, content: dict, created_by: str,
) -> dict:
    name = (name or "").strip()
    if not name:
        raise EventEngineError("invalid_name", "name is required")
    if event_type not in EVENT_TYPES:
        raise EventEngineError("invalid_event_type", f"event_type must be one of {EVENT_TYPES}")
    now = _now_iso()
    doc = {
        "_id": _new_id("tmpl"),
        "name": name,
        "event_type": event_type,
        "status": "draft",
        "version": 1,
        **_clean_template_content(content or {}),
        "created_by": created_by,
        "created_at": now,
        "updated_at": now,
        "published_at": None,
        "archived_at": None,
    }
    await db[TEMPLATES_COLL].insert_one(doc)
    return doc


async def list_templates(db, *, status: Optional[str] = None) -> list[dict]:
    query: dict = {}
    if status:
        query["status"] = status
    cursor = db[TEMPLATES_COLL].find(query, {}).sort("updated_at", -1)
    return [doc async for doc in cursor]


async def get_template(db, template_id: str) -> Optional[dict]:
    return await db[TEMPLATES_COLL].find_one({"_id": template_id})


async def update_template(db, template_id: str, updates: dict, *, updated_by: str) -> dict:
    """Only mutable while ``draft`` — a published template is immutable
    (architecture.md §4.3's "why snapshots matter": editing a template
    must never silently change events already created from it). To
    change a published template, duplicate it into a new draft version
    first, edit that, then publish it."""
    tmpl = await get_template(db, template_id)
    if not tmpl:
        raise EventEngineError("template_not_found", http_status=404)
    if tmpl["status"] != "draft":
        raise EventEngineError(
            "template_not_editable",
            "Only a draft template can be edited. Duplicate this template "
            "to create a new editable draft version.",
        )
    changes = _clean_template_content(updates or {})
    if "name" in (updates or {}) and (updates["name"] or "").strip():
        changes["name"] = updates["name"].strip()
    changes["updated_at"] = _now_iso()
    changes["updated_by"] = updated_by
    await db[TEMPLATES_COLL].update_one({"_id": template_id}, {"$set": changes})
    return await get_template(db, template_id)


async def publish_template(db, template_id: str, *, updated_by: str) -> dict:
    tmpl = await get_template(db, template_id)
    if not tmpl:
        raise EventEngineError("template_not_found", http_status=404)
    if tmpl["status"] == "archived":
        raise EventEngineError("template_archived", "An archived template cannot be published.")
    now = _now_iso()
    await db[TEMPLATES_COLL].update_one(
        {"_id": template_id},
        {"$set": {"status": "published", "published_at": now, "updated_at": now,
                   "updated_by": updated_by}},
    )
    return await get_template(db, template_id)


async def unpublish_template(db, template_id: str, *, updated_by: str) -> dict:
    tmpl = await get_template(db, template_id)
    if not tmpl:
        raise EventEngineError("template_not_found", http_status=404)
    now = _now_iso()
    await db[TEMPLATES_COLL].update_one(
        {"_id": template_id},
        {"$set": {"status": "draft", "updated_at": now, "updated_by": updated_by}},
    )
    return await get_template(db, template_id)


async def archive_template(db, template_id: str, *, updated_by: str) -> dict:
    tmpl = await get_template(db, template_id)
    if not tmpl:
        raise EventEngineError("template_not_found", http_status=404)
    now = _now_iso()
    await db[TEMPLATES_COLL].update_one(
        {"_id": template_id},
        {"$set": {"status": "archived", "archived_at": now, "updated_at": now,
                   "updated_by": updated_by}},
    )
    return await get_template(db, template_id)


async def duplicate_template(db, template_id: str, *, created_by: str) -> dict:
    tmpl = await get_template(db, template_id)
    if not tmpl:
        raise EventEngineError("template_not_found", http_status=404)
    now = _now_iso()
    new_doc = {
        k: copy.deepcopy(v) for k, v in tmpl.items()
        if k not in ("_id", "status", "version", "created_at", "updated_at",
                     "published_at", "archived_at", "created_by", "updated_by")
    }
    new_doc.update({
        "_id": _new_id("tmpl"),
        "name": f"{tmpl['name']} (copy)",
        "status": "draft",
        "version": int(tmpl.get("version") or 1) + 1,
        "created_by": created_by,
        "created_at": now,
        "updated_at": now,
        "published_at": None,
        "archived_at": None,
        "duplicated_from": template_id,
    })
    await db[TEMPLATES_COLL].insert_one(new_doc)
    return new_doc


# ─────────────────────────────────────────────────────────────────────────
# Events — runtime instances (Event Operator Console's CRUD surface)
# ─────────────────────────────────────────────────────────────────────────
async def create_event(
    db, *, template_id: str, schedule: str = "", entry_fee: Optional[int] = None,
    created_by: str,
) -> dict:
    tmpl = await get_template(db, template_id)
    if not tmpl:
        raise EventEngineError("template_not_found", http_status=404)
    if tmpl["status"] != "published":
        raise EventEngineError(
            "template_not_published",
            "Only a published template can be used to create an event.",
        )
    schedule_norm = (schedule or "").strip().upper()
    if schedule_norm and schedule_norm not in ("A", "B", "AB"):
        raise EventEngineError("invalid_schedule", "schedule must be 'A', 'B', 'AB', or empty")
    runtime_defaults = tmpl.get("runtime_defaults") or {}
    resolved_entry_fee = entry_fee if entry_fee is not None else runtime_defaults.get("entry_fee", 0)
    if not isinstance(resolved_entry_fee, int) or not (0 <= resolved_entry_fee <= 500):
        raise EventEngineError("invalid_entry_fee", "entry_fee out of range")

    now = _now_iso()
    config_snapshot = {k: copy.deepcopy(tmpl.get(k)) for k in _TEMPLATE_CONTENT_FIELDS}
    doc = {
        "_id": _new_id("evt"),
        "event_type": tmpl["event_type"],
        "template_id": template_id,
        "template_version": tmpl.get("version"),
        "config_snapshot": config_snapshot,
        "state": "draft",
        "state_history": [{"state": "draft", "at": now, "by": created_by}],
        "linked_session_id": None,
        "schedule": schedule_norm,
        "entry_fee": resolved_entry_fee,
        "created_by": created_by,
        "created_at": now,
        "updated_at": now,
    }
    await db[EVENTS_COLL].insert_one(doc)
    return doc


async def list_events(db, *, state: Optional[str] = None) -> list[dict]:
    query: dict = {}
    if state:
        query["state"] = state
    cursor = db[EVENTS_COLL].find(query, {}).sort("created_at", -1)
    return [doc async for doc in cursor]


async def get_event(db, event_id: str) -> Optional[dict]:
    return await db[EVENTS_COLL].find_one({"_id": event_id})


# Runtime Dashboard bucketing (architecture.md continuation, Author
# Studio's "Runtime Dashboard": active/upcoming/finished events,
# participants, prize pools, event health, realtime status).
_DASHBOARD_BUCKET_FOR_STATE: dict[str, str] = {
    "draft": "upcoming",
    "scheduled": "upcoming",
    "registration_open": "active",
    "live": "active",
    "drawing": "active",
    "settling": "active",
    "settled": "finished",
    "archived": "finished",
    "cancelled": "finished",
}


def _event_health(event: dict, participant_count: int) -> str:
    """A simple, honest heuristic — no ML, no external signal, just the
    fields already on the event. "healthy" means the event is in an
    active operating state; the shortfall variants exist so a teacher
    scanning the dashboard immediately sees which live events have zero
    signups rather than having to open each one."""
    state = event["state"]
    if state == "cancelled":
        return "cancelled"
    if state in ("settled", "archived"):
        return "completed"
    if state == "draft":
        return "not_started"
    if state in ("scheduled", "registration_open") and participant_count == 0:
        return "no_registrations"
    return "healthy"


async def get_runtime_dashboard(db, SL_ENTRIES) -> dict:
    """Author Studio's Runtime Dashboard: every event bucketed into
    active/upcoming/finished, each enriched with a live participant
    count (counted from the SAME speaking_lab_entries collection every
    existing enrollment route already writes to — no new participant
    tracking), an estimated prize pool (entry_fee * participants — the
    real Draw/PrizePool machinery is not yet wrapped into the Event
    Engine, see this module's own docstring), a simple health signal,
    and the owning template's name for display."""
    events = await list_events(db)
    templates = await list_templates(db)
    template_names = {t["_id"]: t["name"] for t in templates}

    buckets: dict[str, list[dict]] = {"active": [], "upcoming": [], "finished": []}
    for event in events:
        session_id = event.get("linked_session_id")
        participant_count = 0
        if session_id:
            participant_count = await SL_ENTRIES.count_documents({"session_id": session_id})
        entry_fee = int(event.get("entry_fee") or 0)
        enriched = {
            **event,
            "template_name": template_names.get(event.get("template_id"), "(unknown template)"),
            "participant_count": participant_count,
            "estimated_prize_pool": entry_fee * participant_count,
            "health": _event_health(event, participant_count),
            "realtime_active": event["state"] in ("live", "drawing") and session_id is not None,
        }
        bucket = _DASHBOARD_BUCKET_FOR_STATE.get(event["state"], "finished")
        buckets[bucket].append(enriched)

    return buckets


async def transition_event(
    db, SL_SESSIONS, event_id: str, to_state: str, *, actor: str,
) -> dict:
    """Advance an event's lifecycle. Validates the transition against
    _ALLOWED_TRANSITIONS, then (for event_type=speaking_lab_session)
    creates or updates the underlying speaking_lab_sessions document so
    every EXISTING route that reads that collection keeps working
    unchanged — this is the actual "wrap, don't rewrite" seam."""
    event = await get_event(db, event_id)
    if not event:
        raise EventEngineError("event_not_found", http_status=404)
    current = event["state"]
    if to_state not in EVENT_STATES:
        raise EventEngineError("invalid_state", f"unknown state {to_state!r}")
    allowed = _ALLOWED_TRANSITIONS.get(current, set())
    if to_state not in allowed:
        raise EventEngineError(
            "invalid_transition",
            f"cannot move from {current!r} to {to_state!r} "
            f"(allowed: {sorted(allowed) or 'none'})",
        )

    now = _now_iso()
    linked_session_id = event.get("linked_session_id")

    if event["event_type"] == "speaking_lab_session":
        if linked_session_id is None and to_state == "registration_open":
            # First time this event opens for entry — create the
            # underlying session NOW, using the exact document shape
            # server.py's own sl_create_session route already writes.
            linked_session_id = _new_id("sl")
            await SL_SESSIONS.insert_one({
                "session_id": linked_session_id,
                "schedule": event.get("schedule") or "",
                "entry_fee": event.get("entry_fee") or 0,
                "treasury_id": "stu092",
                "status": "waiting",
                "created_by": event.get("created_by"),
                "created_at": now,
                "auto_enroll": False,
                "event_id": event_id,  # back-reference, additive column
            })
        elif linked_session_id is not None:
            new_status = _SESSION_STATUS_FOR_EVENT_STATE.get(to_state)
            if new_status:
                await SL_SESSIONS.update_one(
                    {"session_id": linked_session_id},
                    {"$set": {"status": new_status}},
                )

    history_entry = {"state": to_state, "at": now, "by": actor}
    await db[EVENTS_COLL].update_one(
        {"_id": event_id},
        {
            "$set": {"state": to_state, "updated_at": now,
                     "linked_session_id": linked_session_id},
            "$push": {"state_history": history_entry},
        },
    )
    return await get_event(db, event_id)


# ─────────────────────────────────────────────────────────────────────────
# Registration — delegates to the EXISTING atomic join transaction
# ─────────────────────────────────────────────────────────────────────────
async def register_participant(
    db, SL_SESSIONS, SL_ENTRIES, norm_student_id, *,
    event_id: str, student_id: str, display_name: str, idempotency_key: str,
) -> dict:
    event = await get_event(db, event_id)
    if not event:
        raise EventEngineError("event_not_found", http_status=404)
    if event["state"] not in ("registration_open", "live"):
        raise EventEngineError(
            "event_not_open",
            f"This event is not open for registration (state={event['state']!r}).",
        )
    session_id = event.get("linked_session_id")
    if not session_id:
        raise EventEngineError("event_not_open", "This event has no active session yet.")

    if event["event_type"] != "speaking_lab_session":
        raise EventEngineError(
            "unsupported_event_type",
            f"Registration for event_type={event['event_type']!r} is not implemented yet.",
        )

    # Wrap, don't rewrite: the SAME atomic join+wallet-charge+ticket
    # transaction every existing Speaking Lab entry point already uses.
    from speaking_lab_direct_join import _run_direct_join, DirectJoinError

    canonical_id = norm_student_id(student_id)
    try:
        outcome = await _run_direct_join(
            db, SL_SESSIONS, SL_ENTRIES, norm_student_id,
            session_id, canonical_id, display_name, idempotency_key,
        )
    except DirectJoinError as exc:
        raise EventEngineError(exc.code, exc.message, http_status=exc.http_status) from exc
    return outcome


def register_event_engine_routes(
    api, db, SL_SESSIONS, SL_ENTRIES, norm_student_id,
    require_admin, require_student,
) -> None:
    """Mounts /api/v1/event-templates/* (admin) and /api/v1/events/*
    (admin + student) onto the existing FastAPI router. Registered via
    explicit DI, matching the register_*_routes convention established
    across this codebase's Phase 1 conversion."""
    from fastapi import Body, Depends, HTTPException

    def _raise(exc: EventEngineError):
        raise HTTPException(status_code=exc.http_status, detail=exc.message)

    # ── Event Templates (Author Studio) ────────────────────────────────
    @api.post("/v1/event-templates")
    async def create_template_route(payload: dict = Body(...), admin=Depends(require_admin)):
        try:
            doc = await create_template(
                db, name=payload.get("name", ""), event_type=payload.get("event_type", ""),
                content=payload, created_by=getattr(admin, "email", ""),
            )
        except EventEngineError as exc:
            _raise(exc)
        return {"ok": True, "template": doc}

    @api.get("/v1/event-templates")
    async def list_templates_route(status: str = "", admin=Depends(require_admin)):
        docs = await list_templates(db, status=status or None)
        return {"templates": docs}

    @api.get("/v1/event-templates/{template_id}")
    async def get_template_route(template_id: str, admin=Depends(require_admin)):
        doc = await get_template(db, template_id)
        if not doc:
            raise HTTPException(status_code=404, detail="template not found")
        return {"template": doc}

    @api.patch("/v1/event-templates/{template_id}")
    async def update_template_route(
        template_id: str, payload: dict = Body(...), admin=Depends(require_admin),
    ):
        try:
            doc = await update_template(db, template_id, payload, updated_by=getattr(admin, "email", ""))
        except EventEngineError as exc:
            _raise(exc)
        return {"ok": True, "template": doc}

    @api.post("/v1/event-templates/{template_id}/publish")
    async def publish_template_route(template_id: str, admin=Depends(require_admin)):
        try:
            doc = await publish_template(db, template_id, updated_by=getattr(admin, "email", ""))
        except EventEngineError as exc:
            _raise(exc)
        return {"ok": True, "template": doc}

    @api.post("/v1/event-templates/{template_id}/unpublish")
    async def unpublish_template_route(template_id: str, admin=Depends(require_admin)):
        try:
            doc = await unpublish_template(db, template_id, updated_by=getattr(admin, "email", ""))
        except EventEngineError as exc:
            _raise(exc)
        return {"ok": True, "template": doc}

    @api.post("/v1/event-templates/{template_id}/archive")
    async def archive_template_route(template_id: str, admin=Depends(require_admin)):
        try:
            doc = await archive_template(db, template_id, updated_by=getattr(admin, "email", ""))
        except EventEngineError as exc:
            _raise(exc)
        return {"ok": True, "template": doc}

    @api.post("/v1/event-templates/{template_id}/duplicate")
    async def duplicate_template_route(template_id: str, admin=Depends(require_admin)):
        try:
            doc = await duplicate_template(db, template_id, created_by=getattr(admin, "email", ""))
        except EventEngineError as exc:
            _raise(exc)
        return {"ok": True, "template": doc}

    # ── Events (Event Operator Console) ────────────────────────────────
    @api.post("/v1/events")
    async def create_event_route(payload: dict = Body(...), admin=Depends(require_admin)):
        try:
            doc = await create_event(
                db, template_id=payload.get("template_id", ""),
                schedule=payload.get("schedule", ""),
                entry_fee=payload.get("entry_fee"),
                created_by=getattr(admin, "email", ""),
            )
        except EventEngineError as exc:
            _raise(exc)
        return {"ok": True, "event": doc}

    @api.get("/v1/events")
    async def list_events_route(state: str = "", admin=Depends(require_admin)):
        docs = await list_events(db, state=state or None)
        return {"events": docs}

    # NOTE: /v1/events/available (a static path) MUST be registered
    # before /v1/events/{event_id} (a dynamic path) — FastAPI/Starlette
    # matches routes in registration order, so a dynamic path registered
    # first would shadow every static sibling under the same prefix
    # (a GET to /v1/events/available would otherwise match
    # /v1/events/{event_id} with event_id="available" and 404).
    @api.get("/v1/events/available")
    async def list_available_events_route(student=Depends(require_student)):
        docs = await list_events(db, state=None)
        open_docs = [d for d in docs if d["state"] in ("registration_open", "live")]
        templates = await list_templates(db)
        template_names = {t["_id"]: t["name"] for t in templates}
        for d in open_docs:
            d["template_name"] = template_names.get(d.get("template_id"), "Event")
        return {"events": open_docs}

    # Also a static path — same ordering requirement as /v1/events/available
    # above, registered before the dynamic /v1/events/{event_id} route below.
    @api.get("/v1/events/dashboard")
    async def events_dashboard_route(admin=Depends(require_admin)):
        return await get_runtime_dashboard(db, SL_ENTRIES)

    @api.get("/v1/events/{event_id}")
    async def get_event_route(event_id: str, admin=Depends(require_admin)):
        doc = await get_event(db, event_id)
        if not doc:
            raise HTTPException(status_code=404, detail="event not found")
        return {"event": doc}

    @api.post("/v1/events/{event_id}/transition")
    async def transition_event_route(
        event_id: str, payload: dict = Body(...), admin=Depends(require_admin),
    ):
        try:
            doc = await transition_event(
                db, SL_SESSIONS, event_id, payload.get("to", ""),
                actor=getattr(admin, "email", ""),
            )
        except EventEngineError as exc:
            _raise(exc)
        return {"ok": True, "event": doc}

    # ── Student-facing ──────────────────────────────────────────────────
    @api.post("/v1/events/{event_id}/register")
    async def register_event_route(
        event_id: str, payload: dict = Body(default_factory=dict), student=Depends(require_student),
    ):
        display_name = payload.get("display_name") or getattr(student, "display_name", "") or ""
        idempotency_key = payload.get("idempotency_key") or f"{event_id}:{getattr(student, 'student_id', '')}"
        try:
            outcome = await register_participant(
                db, SL_SESSIONS, SL_ENTRIES, norm_student_id,
                event_id=event_id,
                student_id=getattr(student, "student_id", "") or getattr(student, "clean_id", ""),
                display_name=display_name,
                idempotency_key=idempotency_key,
            )
        except EventEngineError as exc:
            _raise(exc)
        return {"ok": True, "result": outcome}

    logger.info("event_engine: routes registered (/api/v1/event-templates*, /api/v1/events*)")


async def ensure_event_engine_indexes(db) -> None:
    await db[TEMPLATES_COLL].create_index("status")
    await db[TEMPLATES_COLL].create_index([("event_type", 1), ("status", 1)])
    await db[EVENTS_COLL].create_index("state")
    await db[EVENTS_COLL].create_index("template_id")
    await db[EVENTS_COLL].create_index([("event_type", 1), ("state", 1)])
