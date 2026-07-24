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

DRAW WRAPPING (originally deferred, now wired) —
lucky_draw.py's ``_run_draw``/``_finalize_draw`` turned out to already
be module-level functions (not trapped in ``register_lucky_draw_routes``'s
closure, contrary to this file's original assessment), so no
lucky_draw.py refactor was needed. ``transition_event``'s optional
``lucky_draw_ctx`` parameter wires them in: advancing to "drawing"
calls ``_run_draw`` (prepare — lock entries, pick winners), advancing
to "settling" calls ``_finalize_draw`` (pay out + notify) — both
UNCHANGED, same atomic claims, same GAS transfer code. When
``lucky_draw_ctx`` is omitted, "drawing"/"settling" remain pure
bookkeeping as before, and the legacy per-session admin routes
(retry-failed, reconcile-historical) remain the only way to reach those
recovery paths — this wrapping only covers the normal prepare/finalize
happy path.

PRIZE POOL WIRING — every event created here (any event_type) gets a
companion Prize Pool via prize_pool.py's ``create_pool`` (owner_type=
"event", owner_ref=event id, ``event["prize_pool_id"]``). This does NOT
change how Speaking Lab actually pays winners today — that remains
lucky_draw.py's own GAS treasury transfer, wired above. The companion
pool exists so a FUTURE event_type with no legacy payout mechanism of
its own can contribute/distribute through it (the same "one pool,
multiple consumers" primitive Weekly Rewards/Tournament/etc. will use)
without another Event Engine schema change. When an event reaches
"settled" its pool is locked then settled too (bookkeeping only, best-
effort — see ``_close_event_prize_pool``); a pool nobody ever
contributed to simply settles at a zero balance.

AUTOMATIC WINNER SHOWCASE — when ``_finalize_lucky_draw`` succeeds (the
moment winners/amounts/payout status become authoritatively known,
inside the "settling" transition), ``_publish_winner_showcase`` auto-
publishes an experienceType="winner_showcase" experience_configs doc
(key=event id) via experience_config_tools.auto_publish_experience_config
— champion, top winners, payout status, all read straight from
lucky_draw's own finalize response, never guessed or duplicated. A
showcase-publish failure is logged and swallowed; it must never block
or roll back a settlement that has already moved real money.

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
from datetime import datetime, timedelta, timezone
from typing import Any, Optional

import prize_pool as pp

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
    event_id = _new_id("evt")

    # Every event gets a companion Prize Pool — see this module's own
    # docstring ("PRIZE POOL WIRING"). Best-effort: a pool-creation hiccup
    # must never block event creation itself (event creation has no money
    # movement of its own; the pool is a forward-looking capability, not a
    # dependency of THIS event_type's actual payout path).
    prize_pool_id = None
    try:
        pool = await pp.create_pool(
            db, name=f"{tmpl['name']} — Prize Pool",
            owner_type="event", owner_ref=event_id, created_by=created_by,
        )
        prize_pool_id = pool["_id"]
    except pp.PrizePoolError:
        logger.warning("event_engine: companion prize pool creation failed for event=%s", event_id)

    doc = {
        "_id": event_id,
        "event_type": tmpl["event_type"],
        "template_id": template_id,
        "template_version": tmpl.get("version"),
        "config_snapshot": config_snapshot,
        "state": "draft",
        "state_history": [{"state": "draft", "at": now, "by": created_by}],
        "linked_session_id": None,
        "schedule": schedule_norm,
        "entry_fee": resolved_entry_fee,
        "prize_pool_id": prize_pool_id,
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


async def get_runtime_dashboard(db, SL_SESSIONS, SL_ENTRIES) -> dict:
    """Author Studio's Runtime Dashboard: every event bucketed into
    active/upcoming/finished, each enriched with a live participant
    count (counted from the SAME speaking_lab_entries collection every
    existing enrollment route already writes to — no new participant
    tracking), a prize-pool readout, a simple health signal, and the
    owning template's name for display.

    Funding-source migration: ``estimated_prize_pool`` (entry_fee *
    participants) is preserved unchanged for any event still on the
    legacy entry-fee model. An event with an admin-funded Prize Pool
    linked instead gets ``funding_source: "prize_pool"`` and
    ``prize_pool_balance`` — that event's REAL available reward total,
    a live read through prize_pool.get_pool_balance, never a stale
    estimate. A balance lookup failure (pool deleted, etc.) degrades to
    the entry-fee estimate rather than breaking the dashboard."""
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
        funding_source = "entry_fee"
        prize_pool_balance = None
        # IMPORTANT: check the SESSION's own prize_pool_id (the field that
        # actually drives funding — set only via the explicit
        # prize_pool.link_pool_to_session action), NOT event["prize_pool_id"]
        # (the event's companion pool reference, which exists for EVERY
        # event regardless of whether it's ever linked/used — checking
        # that instead would wrongly report every event as pool-funded).
        # Mirrors lucky_draw.py's own _resolve_pool_total exactly.
        pool_id = None
        if session_id:
            sess = await SL_SESSIONS.find_one(
                {"session_id": session_id}, {"_id": 0, "prize_pool_id": 1},
            )
            pool_id = (sess or {}).get("prize_pool_id")
        if pool_id:
            try:
                import prize_pool as pp
                from wallet_service import WalletService
                prize_pool_balance = await pp.get_pool_balance(db, WalletService(db), pool_id)
                funding_source = "prize_pool"
            except Exception:  # noqa: BLE001
                pass  # fail safe to the entry-fee estimate below
        enriched = {
            **event,
            "template_name": template_names.get(event.get("template_id"), "(unknown template)"),
            "participant_count": participant_count,
            "estimated_prize_pool": entry_fee * participant_count,
            "funding_source": funding_source,
            "prize_pool_balance": prize_pool_balance,
            "health": _event_health(event, participant_count),
            "realtime_active": event["state"] in ("live", "drawing") and session_id is not None,
        }
        bucket = _DASHBOARD_BUCKET_FOR_STATE.get(event["state"], "finished")
        buckets[bucket].append(enriched)

    return buckets


async def _prepare_lucky_draw(db, session_id: str, event: dict, actor: str, ctx: dict) -> None:
    """Advancing to "drawing" now actually PREPARES the draw (locks
    entries, picks winners) by calling lucky_draw.py's module-level
    ``_run_draw`` — the SAME atomic-claim function every existing
    /lucky-draw admin route already calls, completely unchanged. This
    is the Draw/PrizePool wrapping event_engine.py's own module
    docstring originally deferred: lucky_draw.py's _run_draw and
    _finalize_draw turned out to already be module-level (not trapped
    in the register_lucky_draw_routes closure), so no lucky_draw.py
    refactor was needed after all — only this caller."""
    from fastapi import HTTPException
    from lucky_draw import LuckyDrawConfig, _run_draw

    prize_policy = (event.get("config_snapshot") or {}).get("prize_policy") or {}
    config = LuckyDrawConfig(
        num_winners=prize_policy.get("num_winners"),
        split=prize_policy.get("split"),
    )
    try:
        await _run_draw(
            db, ctx.get("sl_publish"), session_id, config,
            ctx.get("gas_url", ""), ctx.get("treasury_id", ""),
            ctx.get("treasury_password", ""), bool(ctx.get("mock_gas", False)),
            ctx.get("log") or logger, granted_by=actor,
            push_notify=ctx.get("push_notify"),
        )
    except HTTPException as exc:
        if exc.status_code == 409:
            # Draw already prepared for this session (e.g. retrying the
            # SAME transition after a partial failure elsewhere) — the
            # legacy /lucky-draw admin route treats this as idempotent
            # success, so the Event's transition does too.
            return
        raise EventEngineError(
            "lucky_draw_prepare_failed", str(exc.detail), http_status=exc.status_code,
        ) from exc


async def _finalize_lucky_draw(db, session_id: str, ctx: dict, *, actor: str = "") -> dict:
    """Advancing to "settling" now actually FINALIZES the prepared draw
    (GAS transfer + winner pushes) by calling lucky_draw.py's module-
    level ``_finalize_draw`` — unchanged, and already safe to call more
    than once (its own atomic finalize claim + per-winner claims). The
    returned dict (winners/amounts/payout_status) is what
    ``_publish_winner_showcase`` reads — real settlement data, not
    re-derived or guessed.

    Also records the payout in the session's linked Prize Pool (funding-
    source migration, additive/best-effort — see lucky_draw.py's own
    ``_record_pool_distribution``, which this reuses rather than
    duplicating)."""
    from fastapi import HTTPException
    from lucky_draw import _finalize_draw, _record_pool_distribution

    try:
        result = await _finalize_draw(
            db, ctx.get("sl_publish"), session_id,
            ctx.get("gas_url", ""), ctx.get("treasury_id", ""),
            ctx.get("treasury_password", ""), bool(ctx.get("mock_gas", False)),
            ctx.get("log") or logger, push_notify=ctx.get("push_notify"),
        )
    except HTTPException as exc:
        raise EventEngineError(
            "lucky_draw_finalize_failed", str(exc.detail), http_status=exc.status_code,
        ) from exc
    await _record_pool_distribution(db, session_id, result.get("winners") or [], actor=actor)
    return result


async def _publish_winner_showcase(db, event: dict, finalize_result: dict, *, actor: str) -> None:
    """Auto-publish a Winner Showcase right after a lucky draw finalizes —
    architecture continuation's "no manual dashboard editing" requirement.
    Champion/top winners/payout status all come straight from
    lucky_draw.py's own finalize response (the SAME data the teacher
    console already shows); nothing here is guessed or duplicated.

    Best-effort: a showcase-publish failure is logged and swallowed. The
    money has already moved by the time this runs — a display-layer
    hiccup must never roll back or block a real settlement."""
    winners = list(finalize_result.get("winners") or [])
    if not winners:
        return  # nothing to showcase (e.g. zero entries in the draw)
    try:
        from experience_config_tools import auto_publish_experience_config

        tmpl = await get_template(db, event.get("template_id"))
        event_name = (tmpl or {}).get("name") or "Event"
        payout_status = finalize_result.get("payout_status") or ""
        distribution_completed = (
            payout_status in ("paid", "completed")
            or all(w.get("transfer_ok") for w in winners)
        )
        now = datetime.now(timezone.utc)
        expires_at = (now + timedelta(hours=48)).isoformat()
        content = {
            "eventId": event["_id"],
            "eventName": event_name,
            "champion": winners[0],
            "topWinners": winners[:5],
            "rewardGranted": True,
            "distributionCompleted": distribution_completed,
            "payoutStatus": payout_status,
            "celebrationBanner": True,
            "settledAt": finalize_result.get("finalized_at") or now.isoformat(),
            "expiresAt": expires_at,
        }
        await auto_publish_experience_config(
            db, experience_type="winner_showcase", key=event["_id"],
            content=content, created_by=f"event_engine:{actor}",
            # Reuse the platform's OWN active-window expiry mechanism
            # (_is_active_now) rather than making every reader re-derive
            # "is this showcase still current" from content.expiresAt.
            active_window={"startsAt": None, "endsAt": expires_at, "recurringAnnual": False},
        )
    except Exception:  # noqa: BLE001
        logger.exception(
            "event_engine: winner showcase auto-publish failed for event=%s", event["_id"],
        )


async def _close_event_prize_pool(db, event: dict, *, actor: str) -> None:
    """When an event settles, its companion Prize Pool (if any) is locked
    then settled too — bookkeeping only, no money movement (see
    prize_pool.py's own settle_pool docstring). A pool nobody ever
    contributed to (true for every Speaking Lab event today — that
    event_type's real payout stays on the GAS/Lucky Draw path) simply
    settles at a zero balance. Best-effort: never blocks the event's own
    "settled" transition, which is what actually matters to the operator."""
    pool_id = event.get("prize_pool_id")
    if not pool_id:
        return
    try:
        pool = await pp.get_pool(db, pool_id)
        if not pool:
            return
        if pool["status"] == "open":
            await pp.lock_pool(db, pool_id, actor=actor)
            pool = await pp.get_pool(db, pool_id)
        if pool["status"] == "locked":
            await pp.settle_pool(db, pool_id, actor=actor)
    except pp.PrizePoolError:
        logger.warning(
            "event_engine: could not close prize pool %s for event %s", pool_id, event["_id"],
        )


async def transition_event(
    db, SL_SESSIONS, event_id: str, to_state: str, *, actor: str,
    lucky_draw_ctx: Optional[dict] = None,
) -> dict:
    """Advance an event's lifecycle. Validates the transition against
    _ALLOWED_TRANSITIONS, then (for event_type=speaking_lab_session)
    creates or updates the underlying speaking_lab_sessions document so
    every EXISTING route that reads that collection keeps working
    unchanged — this is the actual "wrap, don't rewrite" seam.

    ``lucky_draw_ctx`` (optional): when provided, wraps the EXISTING
    lucky_draw.py machinery so "drawing" actually prepares the draw and
    "settling" actually finalizes it (pays out + notifies) — see
    _prepare_lucky_draw/_finalize_lucky_draw above. Expected keys:
    sl_publish, gas_url, treasury_id, treasury_password, mock_gas, log,
    push_notify (all optional; missing keys degrade the same way
    lucky_draw.py's own register_lucky_draw_routes degrades). When
    omitted (the default), "drawing"/"settling" remain pure bookkeeping
    exactly as before this wrapping was added — an operator must still
    use the legacy /api/speaking-lab/sessions/{id}/lucky-draw* admin
    routes directly. A failure here raises and the event's state does
    NOT advance, so the operator sees the failure and can retry the
    same transition rather than the UI silently claiming success while
    no draw actually ran."""
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
                # Funding-source migration: deliberately NOT auto-stamping
                # prize_pool_id here. This event's own companion pool
                # (event["prize_pool_id"], created in create_event) exists
                # and is ready to be linked, but linking must stay an
                # EXPLICIT admin action (prize_pool.link_pool_to_session —
                # exactly what the architecture asks for: "Associate a
                # Prize Pool with an Event or Speaking Lab session").
                # Auto-linking here would silently break the DEFAULT
                # entry-fee funding model for every Event Engine session:
                # _resolve_pool_total would find a real (but empty)
                # companion pool and return 0 instead of falling through
                # to the entry-fee sum, failing "Pool total is zero" on
                # any entry-fee event nobody ever intended to be pool-
                # funded.
            })
        elif linked_session_id is not None:
            new_status = _SESSION_STATUS_FOR_EVENT_STATE.get(to_state)
            if new_status:
                await SL_SESSIONS.update_one(
                    {"session_id": linked_session_id},
                    {"$set": {"status": new_status}},
                )

            if lucky_draw_ctx:
                if to_state == "drawing":
                    await _prepare_lucky_draw(db, linked_session_id, event, actor, lucky_draw_ctx)
                elif to_state == "settling":
                    finalize_result = await _finalize_lucky_draw(db, linked_session_id, lucky_draw_ctx, actor=actor)
                    await _publish_winner_showcase(db, event, finalize_result, actor=actor)

    history_entry = {"state": to_state, "at": now, "by": actor}
    await db[EVENTS_COLL].update_one(
        {"_id": event_id},
        {
            "$set": {"state": to_state, "updated_at": now,
                     "linked_session_id": linked_session_id},
            "$push": {"state_history": history_entry},
        },
    )
    if to_state == "settled":
        await _close_event_prize_pool(db, event, actor=actor)
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
    require_admin, require_student, *, lucky_draw_ctx: Optional[dict] = None,
) -> None:
    """Mounts /api/v1/event-templates/* (admin) and /api/v1/events/*
    (admin + student) onto the existing FastAPI router. Registered via
    explicit DI, matching the register_*_routes convention established
    across this codebase's Phase 1 conversion.

    ``lucky_draw_ctx`` (optional): forwarded to transition_event so
    advancing an event to "drawing"/"settling" actually drives
    lucky_draw.py's existing prepare/finalize machinery — see
    transition_event's own docstring. Omit to keep those two states
    pure bookkeeping (this module's original behavior)."""
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
        return await get_runtime_dashboard(db, SL_SESSIONS, SL_ENTRIES)

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
                lucky_draw_ctx=lucky_draw_ctx,
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
