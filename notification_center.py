"""
notification_center.py — EduHub Activity Center™ (v1.1, isolated module)
══════════════════════════════════════════════════════════════════════════════
Enterprise notification system. 100% additive — bolts onto the existing
FastAPI app without touching any protected business logic.

v1.1 — Unified badge platform support. Adds two OPTIONAL, keyword-only
params to the wrapped fan-out (`category`, `dedupe_key`) and a `byCategory`
breakdown on GET /notifications/unread-count. Every v1.0 call site — all of
which call positionally with exactly 4 args — is byte-identical in
behaviour; nothing existing was rewritten to adopt the new params. See
the unified-notification-badge-platform implementation report for the
frontend half (per-module badges + Home Screen app icon badge sync).

DESIGN
──────
Every real platform event (points credits, lucky draw, mystery box, login
rewards, attendance, teacher pushes, Speaking Lab admission, EduTalk coach
rewards, tuition reminders, …) already funnels through the single
``_fan_out_push(subs_query, title, body, url)`` helper in server.py.

This module wraps that helper with an ADAPTER (``wrap_fan_out_push``) that,
AFTER the original push fan-out completes, additionally:
  1. persists a notification document per targeted student (30-day TTL), and
  2. delivers it in realtime over an isolated WebSocket layer.

The adapter NEVER raises into the caller — any Activity Center failure is
logged and swallowed so existing push behaviour is bit-for-bit unchanged.

NO fake / demo / seed data exists anywhere in this module. Notifications are
created exclusively from real ``_fan_out_push`` invocations.

WIRING (2 surgical insertions in server.py)
───────────────────────────────────────────
  # right after the `_fan_out_push` definition:
  from notification_center import wrap_fan_out_push as _nc_wrap
  _fan_out_push = _nc_wrap(_fan_out_push, db)

  # with the other module registrations (require_student must exist):
  from notification_center import register_notification_center
  register_notification_center(api, app, db, require_student)

STORAGE
───────
Collection ``activity_notifications``:
  studentId   normalised (lowercase, stripped) student id, or "*" broadcast
  title/body/url  exactly what the push carried (real event content)
  category    all|rewards|points|vouchers|payments|classes|speaking_lab|
              attendance|system  (derived from url + bilingual keywords)
  priority    critical|important|normal|achievement
  read        bool (per-student docs)          readBy: [ids] (broadcast docs)
  createdAt   tz-aware datetime
  expiresAt   createdAt + 30 days  → MongoDB TTL index (expireAfterSeconds=0)
"""
from __future__ import annotations

import asyncio
import logging
import re
from datetime import datetime, timedelta, timezone
from typing import Any, Awaitable, Callable, Optional

from bson import ObjectId
from bson.errors import InvalidId
from fastapi import HTTPException, Query, WebSocket, WebSocketDisconnect

log = logging.getLogger("eduhub.notification_center")

RETENTION_DAYS = 30
MAX_TARGETS_PER_EVENT = 2000
LIST_MAX_LIMIT = 50

CATEGORIES = (
    "rewards", "points", "vouchers", "payments",
    "classes", "speaking_lab", "attendance", "system",
)
PRIORITIES = ("critical", "important", "normal", "achievement")


def _norm_id(raw: Any) -> str:
    return str(raw or "").strip().lower()


# ─────────────────────────────────────────────────────────────────────────────
# Event classification (category + priority) from real push content
# ─────────────────────────────────────────────────────────────────────────────
_URL_CATEGORY_RULES: list[tuple[str, str]] = [
    ("attendance", "attendance"),
    ("speaking-lab", "speaking_lab"),
    ("speaking_lab", "speaking_lab"),
    ("lucky", "rewards"),
    ("mystery", "rewards"),
    ("reward", "rewards"),
    ("voucher", "vouchers"),
    ("topup", "payments"),
    ("top-up", "payments"),
    ("payment", "payments"),
    ("khqr", "payments"),
    ("wallet", "points"),
    ("portal/me", "points"),
    ("edutalk", "classes"),
    ("library", "classes"),
    ("tuition", "payments"),
]

_TEXT_CATEGORY_RULES: list[tuple[str, str]] = [
    ("payment failed", "payments"),
    ("payment", "payments"),
    ("top up", "payments"),
    ("top-up", "payments"),
    ("topup", "payments"),
    ("khqr", "payments"),
    ("aba", "payments"),
    ("tuition", "payments"),
    ("invoice", "payments"),
    ("voucher", "vouchers"),
    ("coupon", "vouchers"),
    ("speaking lab", "speaking_lab"),
    ("speaking results", "speaking_lab"),
    ("admitted", "speaking_lab"),
    ("admission", "speaking_lab"),
    ("attendance", "attendance"),
    ("check-in", "attendance"),
    ("check in", "attendance"),
    ("session", "classes"),
    ("class", "classes"),
    ("enroll", "classes"),
    ("edutalk", "classes"),
    ("lucky", "rewards"),
    ("mystery box", "rewards"),
    ("treasure", "rewards"),
    ("daily reward", "rewards"),
    ("login reward", "rewards"),
    ("referral", "rewards"),
    ("streak", "rewards"),
    ("badge", "rewards"),
    ("achievement", "rewards"),
    ("leaderboard", "rewards"),
    ("top 10", "rewards"),
    ("points credited", "points"),
    ("points added", "points"),
    ("ពិន្ទុ", "points"),          # Khmer: points
    ("point", "points"),
    ("balance", "points"),
    ("credit", "points"),
]

_PRIORITY_RULES: list[tuple[str, str]] = [
    # critical — account / money problems
    ("failed", "critical"),
    ("suspended", "critical"),
    ("restricted", "critical"),
    ("deactivated", "critical"),
    ("overdue", "critical"),
    ("expired", "critical"),
    # important — money confirmed / access granted / deadlines
    ("payment", "important"),
    ("top up", "important"),
    ("top-up", "important"),
    ("confirmed", "important"),
    ("admitted", "important"),
    ("admission", "important"),
    ("tuition", "important"),
    ("due", "important"),
    ("reminder", "important"),
    ("closing", "important"),
    # achievement — wins & rewards
    ("congrat", "achievement"),
    ("earned", "achievement"),
    ("credited", "achievement"),
    ("added to your account", "achievement"),
    ("ពិន្ទុ", "achievement"),
    ("reward", "achievement"),
    ("lucky", "achievement"),
    ("mystery", "achievement"),
    ("voucher", "achievement"),
    ("streak", "achievement"),
    ("leaderboard", "achievement"),
    ("top 10", "achievement"),
    ("badge", "achievement"),
    ("won", "achievement"),
    ("winner", "achievement"),
    ("treasure", "achievement"),
]


def classify_event(
    title: str, body: str, url: str, category: Optional[str] = None,
) -> tuple[str, str]:
    """Derive (category, priority) from the real push content. Pure fn.

    v1.1 — ``category`` lets a caller state its own category explicitly
    instead of relying on keyword/URL inference. Must be one of CATEGORIES
    or it's ignored (falls through to inference) — never trust caller input
    blindly. Existing callers that omit it get byte-identical behaviour.
    """
    text = f"{title or ''} {body or ''}".lower()
    u = (url or "").lower()

    if not (category and category in CATEGORIES):
        category = "system"
        for needle, cat in _TEXT_CATEGORY_RULES:
            if needle in text:
                category = cat
                break
        else:
            for needle, cat in _URL_CATEGORY_RULES:
                if needle in u:
                    category = cat
                    break

    priority = "normal"
    for needle, pri in _PRIORITY_RULES:
        if needle in text:
            priority = pri
            break
    return category, priority


# ─────────────────────────────────────────────────────────────────────────────
# Target extraction from the push subscription query (read-only inspection)
# ─────────────────────────────────────────────────────────────────────────────
_REGEX_WRAP = re.compile(r"^\^\\s\*(.*)\\s\*\$$")


def _unwrap_anchor_regex(pattern: str) -> Optional[str]:
    """Recover the raw student id from the `^\\s*<escaped>\\s*$` pattern
    produced by server.py's _build_target_query."""
    m = _REGEX_WRAP.match(pattern or "")
    if not m:
        return None
    return re.sub(r"\\(.)", r"\1", m.group(1)) or None


def extract_target_ids(subs_query: Any) -> tuple[list[str], bool, bool]:
    """Return (student_ids, is_broadcast, is_group_query)."""
    if not isinstance(subs_query, dict):
        return [], False, False
    if not subs_query:
        return [], True, False

    sid = subs_query.get("studentId")
    if isinstance(sid, str):
        return [sid], False, False
    if isinstance(sid, dict):
        ins = sid.get("$in")
        if isinstance(ins, list):
            return [s for s in ins if isinstance(s, str)], False, False
        rgx = sid.get("$regex")
        if isinstance(rgx, str):
            v = _unwrap_anchor_regex(rgx)
            return ([v] if v else []), False, False

    ors = subs_query.get("$or")
    if isinstance(ors, list):
        out: list[str] = []
        for clause in ors:
            ids, _, _ = extract_target_ids(clause)
            out.extend(ids)
        return out, False, False

    if "group" in subs_query:
        return [], False, True
    return [], False, False


# ─────────────────────────────────────────────────────────────────────────────
# Realtime layer — minimal isolated in-process WebSocket manager
# ─────────────────────────────────────────────────────────────────────────────
class _WSManager:
    def __init__(self) -> None:
        self._conns: dict[str, set[WebSocket]] = {}
        self._lock = asyncio.Lock()

    async def connect(self, ids: list[str], ws: WebSocket) -> None:
        async with self._lock:
            for sid in ids:
                self._conns.setdefault(sid, set()).add(ws)

    async def disconnect(self, ids: list[str], ws: WebSocket) -> None:
        async with self._lock:
            for sid in ids:
                bucket = self._conns.get(sid)
                if bucket:
                    bucket.discard(ws)
                    if not bucket:
                        self._conns.pop(sid, None)

    async def send_to(self, ids: list[str], payload: dict) -> None:
        targets: set[WebSocket] = set()
        async with self._lock:
            for sid in ids:
                targets |= self._conns.get(sid, set())
        for ws in targets:
            try:
                await ws.send_json(payload)
            except Exception:  # noqa: BLE001 — dead socket, reaped on disconnect
                pass

    async def broadcast(self, payload: dict) -> None:
        async with self._lock:
            targets = {ws for bucket in self._conns.values() for ws in bucket}
        for ws in targets:
            try:
                await ws.send_json(payload)
            except Exception:  # noqa: BLE001
                pass


_ws_manager = _WSManager()

# ─────────────────────────────────────────────────────────────────────────────
# Event Platform bridge (Architecture Reconstruction Phase 4) — additive.
#
# _ws_manager above is IN-PROCESS ONLY: a WebSocket client connected to one
# app instance/worker never sees an event recorded on another. That is fine
# for a single-instance deployment (today's default) and becomes a real gap
# the moment this app runs with more than one worker. eduhub_platform.events
# is the fix: _dispatch_realtime() below routes every delivery through an
# EventBus instead of calling _ws_manager directly.
#
#   * Before register_notification_center()'s startup hook runs (e.g. an
#     isolated unit test that calls _record_event directly, exactly like the
#     existing test suite already does), `_event_bus` is None and
#     _dispatch_realtime() falls back to calling _ws_manager directly —
#     byte-identical to this module's behaviour before this bridge existed.
#   * Once startup has run, `_event_bus` defaults to InProcessTransport
#     (still nothing changes: publishing immediately invokes the one
#     subscriber registered below, which itself just calls _ws_manager —
#     same effective call, same timing, one extra layer of indirection).
#   * Only when an operator sets EVENT_BUS_TRANSPORT=redis (via
#     eduhub_platform.config) AND REDIS_URL does this bridge start actually
#     relaying events to every other instance's own local _ws_manager —
#     the missing piece for realtime delivery to work correctly at more
#     than one instance. See eduhub_platform/events.py's own docstring.
# ─────────────────────────────────────────────────────────────────────────────
_event_bus: Any = None

_REALTIME_CHANNEL = "activity_notifications"


async def _deliver_ws(payload: dict) -> None:
    """The actual local WebSocket delivery. Called either directly
    (bus not yet initialized) or via the event bus subscriber (the normal
    running-app path, and the only path that also reaches other instances
    when Redis is configured)."""
    if payload.get("broadcast"):
        await _ws_manager.broadcast({"type": "notification", "item": payload["item"]})
    else:
        await _ws_manager.send_to(
            payload.get("student_ids") or [], {"type": "notification", "item": payload["item"]},
        )


async def _dispatch_realtime(payload: dict) -> None:
    """Deliver a fresh notification in realtime. Routes through the event
    bus when one has been initialized (register_notification_center's
    startup hook subscribes _deliver_ws on it, so publishing here already
    reaches this same process's local WebSocket clients — and every other
    instance's, once Redis is configured); falls back to a direct call
    otherwise. NEVER raises — matches every other function in this module's
    "never break the existing push flow" contract."""
    if _event_bus is not None:
        try:
            await _event_bus.publish(_REALTIME_CHANNEL, payload)
            return
        except Exception as exc:  # noqa: BLE001
            log.warning("notification-center: event bus publish failed, "
                        "delivering locally instead: %s", str(exc)[:200])
    await _deliver_ws(payload)


# ─────────────────────────────────────────────────────────────────────────────
# Persistence
# ─────────────────────────────────────────────────────────────────────────────
def _serialize(doc: dict, viewer_ids: Optional[set[str]] = None) -> dict:
    read = bool(doc.get("read"))
    if doc.get("studentId") == "*" and viewer_ids is not None:
        read_by = {_norm_id(x) for x in (doc.get("readBy") or [])}
        read = bool(read_by & viewer_ids)
    created = doc.get("createdAt")
    return {
        "id": str(doc.get("_id", "")),
        "title": doc.get("title", ""),
        "body": doc.get("body", ""),
        "url": doc.get("url", "/"),
        "category": doc.get("category", "system"),
        "priority": doc.get("priority", "normal"),
        "broadcast": doc.get("studentId") == "*",
        "read": read,
        "createdAt": created.isoformat() if isinstance(created, datetime) else str(created or ""),
    }


async def _record_event(
    db, subs_query: Any, title: str, body: str, url: str,
    *, category: Optional[str] = None, dedupe_key: Optional[str] = None,
) -> None:
    """v1.1 — ``category`` and ``dedupe_key`` are both optional, keyword-only,
    and additive. Omitting either reproduces v1.0 behaviour exactly (keyword
    inference, no dedupe check) — existing callers are untouched.

    ``dedupe_key`` guards against the SAME event being recorded twice (e.g. a
    caller-side retry). It is checked at the EVENT level (one lookup before
    fan-out), not per-student — if a prior call already recorded any document
    carrying this key, the whole event is skipped. This does not change
    Web Push delivery (the original push already happened in the wrapper
    before this function runs) — it only prevents a duplicate Activity
    Center entry.
    """
    if dedupe_key:
        try:
            existing = await db["activity_notifications"].find_one(
                {"dedupeKey": dedupe_key}, {"_id": 1}
            )
            if existing:
                return
        except Exception as exc:  # noqa: BLE001 — dedupe check must never block recording
            log.warning("notification-center: dedupe check failed: %s", str(exc)[:160])

    ids, is_broadcast, is_group = extract_target_ids(subs_query)

    if is_group:
        try:
            raw = await db["push_subscriptions"].distinct("studentId", subs_query)
            ids = [s for s in raw if isinstance(s, str)]
        except Exception as exc:  # noqa: BLE001
            log.warning("notification-center: group resolve failed: %s", str(exc)[:160])
            return

    resolved_category, priority = classify_event(title, body, url, category)
    now = datetime.now(timezone.utc)
    expires = now + timedelta(days=RETENTION_DAYS)
    coll = db["activity_notifications"]

    if is_broadcast:
        doc = {
            "studentId": "*",
            "title": title, "body": body, "url": url or "/",
            "category": resolved_category, "priority": priority,
            "read": False, "readBy": [],
            "source": "push_fanout",
            "createdAt": now, "expiresAt": expires,
        }
        if dedupe_key:
            doc["dedupeKey"] = dedupe_key
        res = await coll.insert_one(doc)
        doc["_id"] = res.inserted_id
        await _dispatch_realtime({"broadcast": True, "item": _serialize(doc, set())})
        return

    norm_ids: list[str] = []
    seen: set[str] = set()
    for raw in ids:
        n = _norm_id(raw)
        if n and n not in seen:
            seen.add(n)
            norm_ids.append(n)
    if not norm_ids:
        return
    norm_ids = norm_ids[:MAX_TARGETS_PER_EVENT]

    docs = [
        {
            "studentId": sid,
            "title": title, "body": body, "url": url or "/",
            "category": resolved_category, "priority": priority,
            "read": False,
            "source": "push_fanout",
            "createdAt": now, "expiresAt": expires,
            **({"dedupeKey": dedupe_key} if dedupe_key else {}),
        }
        for sid in norm_ids
    ]
    res = await coll.insert_many(docs)
    for doc, oid in zip(docs, res.inserted_ids):
        doc["_id"] = oid
        await _dispatch_realtime({"student_ids": [doc["studentId"]], "item": _serialize(doc)})


# ─────────────────────────────────────────────────────────────────────────────
# Adapter — wraps the existing _fan_out_push helper (behaviour preserved)
# ─────────────────────────────────────────────────────────────────────────────
def wrap_fan_out_push(
    original: Callable[..., Awaitable[tuple[int, int]]],
    db,
) -> Callable[..., Awaitable[tuple[int, int]]]:
    async def _fan_out_push_with_activity_center(
        subs_query: dict, title: str, body: str, url: str,
        *, category: Optional[str] = None, dedupe_key: Optional[str] = None,
    ) -> tuple[int, int]:
        # v1.1 — category/dedupe_key are Activity Center-only hints; NEVER
        # forwarded to `original` (the real Web Push sender), whose
        # signature is unchanged. Every existing call site — all of which
        # call positionally with exactly 4 args — is byte-identical in
        # behaviour; these are opt-in for new/updated call sites only.
        result = await original(subs_query, title, body, url)
        try:
            await _record_event(
                db, subs_query, title, body, url,
                category=category, dedupe_key=dedupe_key,
            )
        except Exception as exc:  # noqa: BLE001 — NEVER break existing push flow
            log.warning("notification-center: record failed: %s", str(exc)[:200])
        return result

    return _fan_out_push_with_activity_center


# ─────────────────────────────────────────────────────────────────────────────
# Index bootstrap (30-day TTL, backend-driven cleanup — no manual jobs)
# ─────────────────────────────────────────────────────────────────────────────
async def ensure_notification_indexes(db) -> None:
    coll = db["activity_notifications"]
    await coll.create_index("expiresAt", expireAfterSeconds=0)
    await coll.create_index([("studentId", 1), ("createdAt", -1)])
    await coll.create_index([("studentId", 1), ("read", 1)])
    # v1.1 — supports the per-category unread breakdown (unified badge
    # platform) and the optional caller-supplied idempotency key. Both
    # additive; neither changes the meaning of any existing query.
    await coll.create_index([("studentId", 1), ("category", 1), ("read", 1)])
    await coll.create_index("dedupeKey", sparse=True)


# ─────────────────────────────────────────────────────────────────────────────
# Routes
# ─────────────────────────────────────────────────────────────────────────────
async def _resolve_student_by_session_token(db, session_token: str):
    """Mirrors current_student()'s session lookup exactly (server.py), for a
    single candidate token string. Returns the student doc or None — never
    raises. Used by the WS handler to try BOTH the query-string token and
    the cookie independently (see notifications_ws for why)."""
    session_token = (session_token or "").strip()
    if not session_token:
        return None
    sess = await db.student_sessions.find_one(
        {"session_token": session_token}, {"_id": 0}
    )
    if not sess:
        return None
    expires = sess.get("expires_at")
    if expires:
        try:
            exp_dt = (
                datetime.fromisoformat(expires)
                if isinstance(expires, str) else expires
            )
            if exp_dt.tzinfo is None:
                exp_dt = exp_dt.replace(tzinfo=timezone.utc)
            if datetime.now(timezone.utc) > exp_dt:
                return None
        except ValueError:
            return None
    return await db.students.find_one(
        {"student_id": sess.get("student_id"), "is_active": {"$ne": False}},
        {"_id": 0, "password_hash": 0},
    )


def register_notification_center(api, app, db, require_student, require_admin=None) -> None:
    """``require_admin`` is optional and additive (Architecture
    Reconstruction Phase 4, "event platform" verification tooling) — when
    supplied, mounts GET /api/admin/event-bus/status. Every existing call
    site (server.py, and both existing test files) passes exactly 4
    positional args and is unaffected; omitting require_admin simply
    skips registering that one diagnostic route."""
    from fastapi import Depends

    coll = db["activity_notifications"]

    def _viewer_ids(student) -> list[str]:
        out: list[str] = []
        for raw in (getattr(student, "clean_id", ""), getattr(student, "student_id", "")):
            n = _norm_id(raw)
            if n and n not in out:
                out.append(n)
        return out

    def _own_query(student) -> dict:
        return {"studentId": {"$in": _viewer_ids(student) + ["*"]}}

    @api.get("/notifications")
    async def list_notifications(
        category: str = Query(default=""),
        limit: int = Query(default=30, ge=1, le=LIST_MAX_LIMIT),
        before: str = Query(default=""),
        student=Depends(require_student),
    ):
        q: dict = _own_query(student)
        if category and category in CATEGORIES:
            q["category"] = category
        if before:
            try:
                q["createdAt"] = {"$lt": datetime.fromisoformat(before.replace("Z", "+00:00"))}
            except ValueError:
                raise HTTPException(status_code=400, detail="invalid before cursor")
        viewer = set(_viewer_ids(student))
        cursor = coll.find(q).sort("createdAt", -1).limit(limit + 1)
        docs = await cursor.to_list(length=limit + 1)
        has_more = len(docs) > limit
        items = [_serialize(d, viewer) for d in docs[:limit]]
        return {"items": items, "hasMore": has_more}

    @api.get("/notifications/unread-count")
    async def unread_count(student=Depends(require_student)):
        # v1.1 — adds `byCategory` alongside the original `count`. Purely
        # additive: existing callers reading only `.count` see byte-identical
        # values and behaviour. `byCategory` is what the unified badge
        # platform (Dashboard/nav/Wallet/Speaking Lab/EduTalk/Attendance
        # module badges) reads to know WHICH module has unread activity,
        # without a second endpoint or a second round trip.
        viewer = _viewer_ids(student)
        by_category: dict[str, int] = {}

        own_pipeline = [
            {"$match": {"studentId": {"$in": viewer}, "read": False}},
            {"$group": {"_id": "$category", "n": {"$sum": 1}}},
        ]
        async for row in coll.aggregate(own_pipeline):
            cat = row["_id"] or "system"
            by_category[cat] = by_category.get(cat, 0) + int(row["n"])

        bc_pipeline = [
            {"$match": {"studentId": "*", "readBy": {"$nin": viewer}}},
            {"$group": {"_id": "$category", "n": {"$sum": 1}}},
        ]
        async for row in coll.aggregate(bc_pipeline):
            cat = row["_id"] or "system"
            by_category[cat] = by_category.get(cat, 0) + int(row["n"])

        total = min(sum(by_category.values()), 99)
        return {"count": total, "byCategory": by_category}

    @api.post("/notifications/read-all")
    async def mark_all_read(student=Depends(require_student)):
        viewer = _viewer_ids(student)
        r1 = await coll.update_many(
            {"studentId": {"$in": viewer}, "read": False},
            {"$set": {"read": True}},
        )
        r2 = await coll.update_many(
            {"studentId": "*", "readBy": {"$nin": viewer}},
            {"$addToSet": {"readBy": viewer[0] if viewer else ""}},
        )
        return {"ok": True, "updated": r1.modified_count + r2.modified_count}

    @api.post("/notifications/{notification_id}/read")
    async def mark_read(notification_id: str, student=Depends(require_student)):
        try:
            oid = ObjectId(notification_id)
        except (InvalidId, TypeError):
            raise HTTPException(status_code=400, detail="invalid notification id")
        viewer = _viewer_ids(student)
        doc = await coll.find_one({"_id": oid})
        if not doc:
            raise HTTPException(status_code=404, detail="notification not found")
        if doc.get("studentId") == "*":
            await coll.update_one(
                {"_id": oid}, {"$addToSet": {"readBy": viewer[0] if viewer else ""}}
            )
        elif doc.get("studentId") in viewer:
            await coll.update_one({"_id": oid}, {"$set": {"read": True}})
        else:
            raise HTTPException(status_code=403, detail="not your notification")
        return {"ok": True}

    # ── Event Platform verification tooling (Phase 4) — admin-only,
    #    read-only diagnostic. Registered only when require_admin is
    #    supplied (see the function docstring above). ───────────────────
    if require_admin is not None:
        @api.get("/admin/event-bus/status")
        async def event_bus_status(_admin=Depends(require_admin)):
            import os as _os
            transport_name = (
                type(_event_bus._transport).__name__ if _event_bus is not None
                else "not_initialized"
            )
            return {
                "transport": transport_name,
                "channel": _REALTIME_CHANNEL,
                "redis_url_configured": bool(_os.environ.get("REDIS_URL")),
            }

    # ── Realtime — isolated WS. Auth via ?token= (Bearer fallback token) OR
    #    the existing student_session cookie (sent automatically on wss).
    #    BOTH are attempted independently (query token first, then cookie) —
    #    never just "whichever string is non-empty". A stale cached Bearer
    #    token in localStorage must not shadow a still-valid cookie session
    #    (or vice versa): each candidate is validated on its own merits,
    #    matching current_student()'s guarantee that a valid session in
    #    EITHER place authenticates the request. ─────────────────────────
    @app.websocket("/api/notifications/ws")
    async def notifications_ws(ws: WebSocket, token: str = Query(default="")):
        student_doc = await _resolve_student_by_session_token(db, token)
        if not student_doc:
            cookie_token = (ws.cookies or {}).get("student_session", "")
            student_doc = await _resolve_student_by_session_token(db, cookie_token)
        if not student_doc:
            await ws.close(code=4401)
            return

        ids = []
        for raw in (student_doc.get("clean_id"), student_doc.get("student_id")):
            n = _norm_id(raw)
            if n and n not in ids:
                ids.append(n)

        await ws.accept()
        await _ws_manager.connect(ids, ws)
        try:
            await ws.send_json({"type": "connected"})
            while True:
                msg = await ws.receive_text()
                if msg == "ping":
                    await ws.send_json({"type": "pong"})
        except WebSocketDisconnect:
            pass
        except Exception:  # noqa: BLE001
            pass
        finally:
            await _ws_manager.disconnect(ids, ws)

    @app.on_event("startup")
    async def _notification_center_startup():
        try:
            await ensure_notification_indexes(db)
            log.info("notification-center: indexes ready (TTL %sd)", RETENTION_DAYS)
        except Exception as exc:  # noqa: BLE001
            log.warning("notification-center: index bootstrap failed: %s", str(exc)[:200])

        # Architecture Reconstruction Phase 4 ("event platform") — build the
        # event bus (defaults to InProcessTransport, a no-op behaviour change
        # from before this bridge existed) and subscribe the SAME local
        # delivery function this module always used. Non-fatal: a failure
        # here just leaves _event_bus as None, and _dispatch_realtime's own
        # fallback keeps every existing push flow working unchanged.
        global _event_bus
        try:
            from eduhub_platform.events import build_event_bus
            _event_bus = await build_event_bus(db)
            await _event_bus.subscribe(_REALTIME_CHANNEL, _deliver_ws)
            log.info("notification-center: event bus ready (transport=%s)",
                     type(_event_bus._transport).__name__)
        except Exception as exc:  # noqa: BLE001
            log.warning("notification-center: event bus init failed (falling back "
                        "to direct local delivery): %s", str(exc)[:200])
            _event_bus = None

    log.info("notification-center: routes registered (/api/notifications*)")
