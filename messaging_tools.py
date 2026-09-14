"""messaging_tools.py — EduHub in-app messaging (first release).

Private-by-default 1:1 and group conversations between ALREADY-LOGGED-IN
EduHub students/staff. Governing test applied throughout this module:
a capability only belongs here if it requires two people who are
already logged-in EduHub accounts (referral/invite-style reach to
someone outside the platform does not belong here).

REUSED INFRASTRUCTURE (per this feature's own audit — nothing below is
a new parallel system unless explicitly justified):
  * eduhub_platform.events (build_event_bus) — the SAME transport-
    pluggable pub/sub notification_center.py already uses for its own
    WebSocket layer. A second EventBus instance is constructed here
    (own module-global, own channel name "messaging") rather than
    sharing notification_center's object — pub/sub channels are
    logically independent by name regardless of which EventBus object
    published them, and Redis (when configured) is a single shared
    server regardless of how many local EventBus objects exist in this
    process, so this costs nothing and avoids a cross-module import of
    notification_center's private state.
  * eduhub_platform.config (resolve_flag/set_override/get_audit_history)
    — the on/off toggle and the two numeric retention settings are
    plain published-config flags, not a new settings system.
  * r2_object_store.py — a NEW shared module (see its own docstring for
    why this is a deliberate, product-owner-approved deviation from the
    existing R2-client-per-module isolation convention), used for voice/
    image attachment upload.
  * The existing `_fan_out_push` chokepoint (passed in by server.py,
    exactly like every other module that sends push) — offline/
    backgrounded recipients get a real push notification, bilingual
    Khmer+English strings written per-callsite exactly like every other
    push call site in this codebase (there is no separate "Khmer
    notification infrastructure" to plug into — verified during this
    feature's own audit; every existing bilingual push is hand-written
    at its own call site, and this one is too).
  * `_resolve_student_by_session_token` is imported directly from
    notification_center.py rather than re-implemented — it is exactly
    the session-token-or-cookie resolution the WS layer here needs, and
    duplicating security-sensitive session validation logic a second
    time would risk the two copies silently diverging over time.

DATA MODEL
──────────
messaging_conversations:
  kind             "dm" | "class" | "speaking_lab_group"
  participantIds   list[str], normalised student ids — the ONLY thing
                   read/write authorization is ever based on
  ownerId          the admin who created a "class" channel or triggered
                   a "speaking_lab_group" formation — READ-only
                   moderator visibility (never write), see
                   can_read_conversation/can_write_conversation below.
                   NEVER set for "dm" — a private 1:1 has no moderator,
                   by design (rule: "no admin back-door for private
                   DMs specifically").
  speakingLab      {sessionId, groupNumber, sessionLabel} — only for
                   kind="speaking_lab_group". sessionId is a FRESH
                   identifier minted at every group-formation event
                   (see speaking_lab_group_chat.py) — never reused
                   across sessions, so (sessionId, groupNumber) is
                   always a genuinely new, distinct conversation even
                   when the displayed group number repeats.
  archived         bool — read-only once true, hidden from the active
                   conversation list, never deleted.
  archiveAt        datetime | None — when an archive job should flip
                   `archived` (see archive_due_conversations).
  title            display title for "class"/"speaking_lab_group"
                   (e.g. "Group 2 · Fri Sep 12 Speaking Lab") — "dm"
                   conversations have no stored title; the frontend
                   shows the other participant's name.
  createdAt / updatedAt / lastMessageAt / lastMessagePreview

messaging_messages:
  conversationId, senderId, kind ("text"|"voice"|"card_achievement")
  body             text content (kind="text"), or a caption (optional
                   for voice/card)
  attachment       {r2Key, mimeType, durationSec, sizeBytes, expiresAt,
                    expired} — ONLY for kind="voice". `expiresAt` is
                    the 30-day (configurable) attachment retention
                    clock; the MESSAGE DOCUMENT ITSELF is never
                    time-limited — text and message rows persist
                    indefinitely (rule 1.2) even after their attachment
                    expires; `expired` flips to True once the
                    underlying R2 object has actually been removed, so
                    a client can render "voice message no longer
                    available" instead of trying (and failing) to play
                    a since-deleted URL.
  card             {type:"achievement", trophyId, name, artwork,
                    claimedAt} — a real, server-verified SNAPSHOT taken
                    at send time (see send_message's card-verification
                    step), never a live reference the recipient could
                    use to query the sender's own /api/achievements/me
                    (which is self-scoped and must stay that way).
  clientMessageId  echoed back verbatim so the sender's optimistic
                   local message can be reconciled with the server-
                   confirmed one without a duplicate appearing.
  reported         bool — set True the moment a report is filed
                   referencing this message; while True, the
                   attachment-expiry sweep (sweep_expired_attachments)
                   skips it entirely, regardless of `attachment.
                   expiresAt` — satisfies "reported items survive their
                   TTL until resolved" (rule 4.3 / 6.5) by construction,
                   not by a race between two independent processes.

messaging_read_state: {conversationId, studentId} unique — lastReadAt.
  A separate collection (not embedded on the conversation doc) so a
  read-receipt write never contends with, or grows unbounded on, the
  conversation document itself as more students read a large class
  channel.

messaging_blocks: {blockerId, blockedId} unique. Directional record,
  bidirectional enforcement: `is_blocked_pair` treats a MATCH in EITHER
  direction as "these two may not exchange messages", from a single
  block action by either party — matching rule 4.1 exactly ("Blocking
  prevents messages in both directions... from ONE block").

messaging_reports: {reporterId, conversationId, messageId, reason,
  createdAt, resolved, resolvedAt, resolvedBy, resolutionNote}.
"""
from __future__ import annotations

import logging
from datetime import datetime, timedelta, timezone
from typing import Any, Awaitable, Callable, Optional

from bson import ObjectId
from bson.errors import InvalidId
from fastapi import Body, Depends, File, Form, Header, HTTPException, Query, UploadFile, WebSocket, WebSocketDisconnect
from pymongo.errors import DuplicateKeyError

import r2_object_store
from eduhub_platform.config import resolve_bool_flag, resolve_flag

log = logging.getLogger("eduhub.messaging")

DEFAULT_ATTACHMENT_TTL_DAYS = 30
DEFAULT_SPEAKING_LAB_ARCHIVE_HOURS = 24
MAX_TEXT_LEN = 4000
MAX_VOICE_BYTES = 8 * 1024 * 1024  # 8MB — a few minutes of compressed audio; generous for a classroom voice note
ALLOWED_VOICE_MIME = ("audio/webm", "audio/ogg", "audio/mpeg", "audio/mp4", "audio/wav", "audio/x-m4a")
LIST_PAGE_SIZE = 30
HISTORY_PAGE_SIZE = 50


def _norm_id(raw: Any) -> str:
    return str(raw or "").strip().lower()


# Public alias — speaking_lab_group_chat.py (a separate, closely-related
# module) needs the exact same normalization when reconciling late-
# arrival membership against this module's own participant id format.
norm_id = _norm_id


def _student_ids(student) -> list[str]:
    """Both identity forms a student doc/session can carry — mirrors
    notification_center.py's `_viewer_ids` exactly, for the same reason
    (some older records use the wallet-form id, current ones the clean
    id; a lookup must accept either)."""
    out: list[str] = []
    for raw in (getattr(student, "clean_id", ""), getattr(student, "student_id", "")):
        n = _norm_id(raw)
        if n and n not in out:
            out.append(n)
    return out


# ─────────────────────────────────────────────────────────────────────────────
# Authorization — the single most important part of this module
# ─────────────────────────────────────────────────────────────────────────────
def is_participant(conversation: dict, student_ids: list[str]) -> bool:
    parts = {_norm_id(p) for p in (conversation.get("participantIds") or [])}
    return bool(parts & set(student_ids))


def can_read_conversation(conversation: dict, student_ids: list[str]) -> bool:
    """Participant → always. Owning admin of a "class"/"speaking_lab_group"
    channel → read-only moderator visibility (rule 3.2), NEVER for "dm"
    (rule 3: "no admin back-door for private DMs specifically") — the
    `kind != "dm"` guard is what makes that guarantee structural rather
    than a matter of which admins happen to be set as owner."""
    if is_participant(conversation, student_ids):
        return True
    if conversation.get("kind") != "dm" and conversation.get("ownerId"):
        return _norm_id(conversation["ownerId"]) in student_ids
    return False


def can_write_conversation(conversation: dict, student_ids: list[str]) -> bool:
    """Deliberately NARROWER than can_read_conversation — the owning
    admin of a class/group channel can see it (moderation) but cannot
    post as if they were a member unless they are ALSO a genuine
    participant. Never call this for "who can read" checks."""
    return is_participant(conversation, student_ids)


async def is_blocked_pair(db, a: str, b: str) -> bool:
    a, b = _norm_id(a), _norm_id(b)
    if not a or not b or a == b:
        return False
    existing = await db.messaging_blocks.find_one(
        {"$or": [
            {"blockerId": a, "blockedId": b},
            {"blockerId": b, "blockedId": a},
        ]},
        {"_id": 1},
    )
    return existing is not None


async def _assert_no_block_with_any(db, actor_id: str, other_ids: list[str]) -> None:
    for other in other_ids:
        if other == actor_id:
            continue
        if await is_blocked_pair(db, actor_id, other):
            raise HTTPException(status_code=403, detail="messaging is blocked between these accounts")


# ─────────────────────────────────────────────────────────────────────────────
# Config flags — eduhub_platform.config, same three-tier resolver every
# other admin-toggleable setting in this codebase already uses.
# ─────────────────────────────────────────────────────────────────────────────
async def messaging_enabled(db) -> bool:
    value, _source = await resolve_bool_flag(db, "MESSAGING_ENABLED", default=False)
    return value


async def attachment_ttl_days(db) -> int:
    value, _source = await resolve_flag(db, "MESSAGING_ATTACHMENT_TTL_DAYS", default=DEFAULT_ATTACHMENT_TTL_DAYS)
    try:
        n = int(value)
    except (TypeError, ValueError):
        return DEFAULT_ATTACHMENT_TTL_DAYS
    return n if n > 0 else DEFAULT_ATTACHMENT_TTL_DAYS


async def speaking_lab_archive_hours(db) -> int:
    value, _source = await resolve_flag(
        db, "MESSAGING_SPEAKING_LAB_ARCHIVE_HOURS", default=DEFAULT_SPEAKING_LAB_ARCHIVE_HOURS,
    )
    try:
        n = int(value)
    except (TypeError, ValueError):
        return DEFAULT_SPEAKING_LAB_ARCHIVE_HOURS
    return n if n > 0 else DEFAULT_SPEAKING_LAB_ARCHIVE_HOURS


async def _require_enabled(db) -> None:
    """Defense in depth — rule 8.2 only mandates the NAV entry point be
    omitted when the feature is off; a client could still call the API
    directly. Never trust client-only enforcement for a private-by-
    default surface: every write/read path re-checks this server-side."""
    if not await messaging_enabled(db):
        raise HTTPException(status_code=403, detail="messaging is currently disabled")


# ─────────────────────────────────────────────────────────────────────────────
# Realtime layer — mirrors notification_center.py's _WSManager /
# event-bus bridge exactly (see that module's own comment for the full
# rationale); the only differences are the channel name and payload
# shape, both messaging-specific.
# ─────────────────────────────────────────────────────────────────────────────
class _MsgWSManager:
    def __init__(self) -> None:
        self._conns: dict[str, set[WebSocket]] = {}
        import asyncio
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

    def is_connected_locally(self, student_id: str) -> bool:
        return bool(self._conns.get(student_id))

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


_ws_manager = _MsgWSManager()
_event_bus: Any = None
_REALTIME_CHANNEL = "messaging"


async def _deliver_ws(payload: dict) -> None:
    await _ws_manager.send_to(payload.get("student_ids") or [], payload["message"])


async def _dispatch_realtime(student_ids: list[str], message: dict) -> None:
    payload = {"student_ids": student_ids, "message": message}
    if _event_bus is not None:
        try:
            await _event_bus.publish(_REALTIME_CHANNEL, payload)
            return
        except Exception as exc:  # noqa: BLE001
            log.warning("messaging: event bus publish failed, delivering locally instead: %s", str(exc)[:200])
    await _deliver_ws(payload)


# ─────────────────────────────────────────────────────────────────────────────
# Serialization
# ─────────────────────────────────────────────────────────────────────────────
def _iso(dt: Optional[datetime]) -> Optional[str]:
    """Motor/PyMongo returns NAIVE datetimes on read (this app's client
    has no tz_aware=True) even though every value here was written as a
    proper UTC instant via datetime.now(timezone.utc) — BSON dates are
    always UTC internally, PyMongo just doesn't reattach tzinfo unless
    asked. A bare `.isoformat()` on that naive value omits the timezone
    suffix (e.g. "2026-09-14T04:30:00" instead of "...+00:00"), and the
    frontend's `new Date(...)` then parses a suffix-less string as LOCAL
    browser time — for a student in Cambodia (UTC+7) this silently
    turned a message sent seconds ago into "7h ago" the moment the
    thread/inbox re-fetched over REST (the realtime WebSocket path was
    unaffected, since it serializes the freshly-built aware value before
    it ever round-trips through Mongo). A naive value read back from
    this collection is always a real UTC instant, so tagging it UTC here
    is a fact, not a guess."""
    if not isinstance(dt, datetime):
        return None
    if dt.tzinfo is None:
        dt = dt.replace(tzinfo=timezone.utc)
    return dt.astimezone(timezone.utc).isoformat()


def _serialize_message(doc: dict) -> dict:
    attachment = doc.get("attachment")
    return {
        "id": str(doc.get("_id", "")),
        "conversationId": doc.get("conversationId", ""),
        "senderId": doc.get("senderId", ""),
        "kind": doc.get("kind", "text"),
        "body": doc.get("body"),
        "attachment": (
            None if not attachment else {
                "mimeType": attachment.get("mimeType"),
                "durationSec": attachment.get("durationSec"),
                "sizeBytes": attachment.get("sizeBytes"),
                "expired": bool(attachment.get("expired")),
                "url": (None if attachment.get("expired") else attachment.get("url")),
            }
        ),
        "card": doc.get("card"),
        "clientMessageId": doc.get("clientMessageId"),
        "createdAt": _iso(doc.get("createdAt")),
        "reported": bool(doc.get("reported")),
    }


def _serialize_conversation(doc: dict, unread: int = 0, *, other_display_name: Optional[str] = None) -> dict:
    return {
        "id": str(doc.get("_id", "")),
        "kind": doc.get("kind", "dm"),
        "participantIds": doc.get("participantIds") or [],
        "title": doc.get("title"),
        # "dm" conversations store no title (there's no single fixed
        # label for a 1:1 — see the module docstring); the frontend
        # needs a name to show, so the OTHER participant's real
        # display_name (never fabricated, looked up from db.students —
        # see list_conversations' batched resolution) is provided here
        # under a separate key rather than overloading `title`.
        "otherDisplayName": other_display_name,
        "speakingLab": doc.get("speakingLab"),
        "archived": bool(doc.get("archived")),
        "lastMessageAt": _iso(doc.get("lastMessageAt")),
        "lastMessagePreview": doc.get("lastMessagePreview"),
        "unreadCount": unread,
        "createdAt": _iso(doc.get("createdAt")),
    }


# ─────────────────────────────────────────────────────────────────────────────
# Conversation resolution
# ─────────────────────────────────────────────────────────────────────────────
async def get_or_create_dm(db, a: str, b: str) -> dict:
    a, b = _norm_id(a), _norm_id(b)
    if not a or not b:
        raise HTTPException(status_code=400, detail="both participants are required")
    if a == b:
        raise HTTPException(status_code=400, detail="cannot start a conversation with yourself")
    pair = sorted([a, b])
    existing = await db.messaging_conversations.find_one({"kind": "dm", "participantIds": pair})
    if existing:
        return existing
    now = datetime.now(timezone.utc)
    doc = {
        "kind": "dm", "participantIds": pair, "title": None, "ownerId": None,
        "speakingLab": None, "archived": False, "archiveAt": None,
        "createdAt": now, "updatedAt": now, "lastMessageAt": None, "lastMessagePreview": None,
    }
    try:
        res = await db.messaging_conversations.insert_one(doc)
    except DuplicateKeyError:
        # Two concurrent "first message to this person" requests raced
        # to create the same pair's DM — the unique index
        # (ensure_messaging_indexes) caught it. The other request won;
        # fetch and return ITS document rather than erroring, so the
        # caller never sees a spurious failure for a conversation that
        # in fact already exists.
        winner = await db.messaging_conversations.find_one({"kind": "dm", "participantIds": pair})
        if winner:
            return winner
        raise
    doc["_id"] = res.inserted_id
    return doc


async def create_group_conversation(
    db, *, participant_ids: list[str], title: str, owner_id: Optional[str] = None,
    speaking_lab: Optional[dict] = None, archive_hours: Optional[int] = None,
) -> dict:
    """Used both for admin-created "class" channels and (via
    speaking_lab_group_chat.py) "speaking_lab_group" conversations.
    `speaking_lab` presence determines `kind`."""
    norm_ids = sorted({_norm_id(p) for p in participant_ids if _norm_id(p)})
    if len(norm_ids) < 2:
        raise HTTPException(status_code=400, detail="a group conversation needs at least 2 participants")
    now = datetime.now(timezone.utc)
    archive_at = None
    kind = "speaking_lab_group" if speaking_lab else "class"
    if speaking_lab and archive_hours:
        archive_at = now + timedelta(hours=archive_hours)
    doc = {
        "kind": kind, "participantIds": norm_ids, "title": title,
        "ownerId": _norm_id(owner_id) if owner_id else None,
        "speakingLab": speaking_lab, "archived": False, "archiveAt": archive_at,
        "createdAt": now, "updatedAt": now, "lastMessageAt": None, "lastMessagePreview": None,
    }
    res = await db.messaging_conversations.insert_one(doc)
    doc["_id"] = res.inserted_id
    return doc


def _oid(raw: str, what: str = "id") -> ObjectId:
    try:
        return ObjectId(raw)
    except (InvalidId, TypeError):
        raise HTTPException(status_code=400, detail=f"invalid {what}")


async def _load_conversation_or_404(db, conversation_id: str) -> dict:
    conv = await db.messaging_conversations.find_one({"_id": _oid(conversation_id, "conversation id")})
    if not conv:
        raise HTTPException(status_code=404, detail="conversation not found")
    return conv


# ─────────────────────────────────────────────────────────────────────────────
# Sending
# ─────────────────────────────────────────────────────────────────────────────
async def _verify_and_snapshot_achievement(db, sender_ids: list[str], trophy_id: str) -> dict:
    """Re-verifies (never trusts the client) that the sender has
    genuinely unlocked this trophy, via achievement_tools.py's own
    PUBLIC `get_unlocked_trophy_for_student` (added alongside this
    feature specifically so this cross-module check never has to reach
    into that module's private evaluation internals) — never fabricated
    content (rule 7). Returns a plain snapshot dict safe to embed
    permanently in the message; the recipient never gets a live
    reference back into the sender's own (self-scoped)
    /api/achievements/me."""
    import achievement_tools

    snapshot = await achievement_tools.get_unlocked_trophy_for_student(db, sender_ids, trophy_id)
    if snapshot is None:
        raise HTTPException(status_code=403, detail="you have not unlocked this achievement")
    return {
        "type": "achievement",
        "trophyId": snapshot["trophy_id"],
        "name": snapshot["name"],
        "artwork": snapshot["artwork"],
        # achievement_tools.py stores claimed_at as an already-ISO string
        # (_now_iso()), never a datetime — passed through as-is, NOT
        # through this module's own _iso() helper (which only converts
        # real datetime objects and would silently discard a string).
        "claimedAt": snapshot.get("claimed_at"),
    }


async def send_message(
    db, *, conversation: dict, sender_ids: list[str], sender_display: str,
    kind: str, body: Optional[str], attachment: Optional[dict],
    trophy_id: Optional[str], client_message_id: Optional[str],
    fan_out_push: Callable[..., Awaitable[tuple[int, int]]],
) -> dict:
    if conversation.get("archived"):
        raise HTTPException(status_code=403, detail="this conversation is archived (read-only)")
    if not can_write_conversation(conversation, sender_ids):
        raise HTTPException(status_code=403, detail="you are not a participant in this conversation")

    other_ids = [p for p in (conversation.get("participantIds") or []) if _norm_id(p) not in sender_ids]
    await _assert_no_block_with_any(db, sender_ids[0] if sender_ids else "", other_ids)

    now = datetime.now(timezone.utc)
    card = None
    if kind == "card_achievement":
        if not trophy_id:
            raise HTTPException(status_code=400, detail="trophyId is required for an achievement card")
        card = await _verify_and_snapshot_achievement(db, sender_ids, trophy_id)
        preview = f"🏆 {card['name']}"
    elif kind == "voice":
        if not attachment:
            raise HTTPException(status_code=400, detail="a voice message requires an attachment")
        preview = "🎤 Voice message"
    else:
        kind = "text"
        text = (body or "").strip()
        if not text:
            raise HTTPException(status_code=400, detail="message text cannot be empty")
        if len(text) > MAX_TEXT_LEN:
            raise HTTPException(status_code=400, detail=f"message too long (max {MAX_TEXT_LEN} characters)")
        body = text
        preview = text[:120]

    doc = {
        "conversationId": str(conversation["_id"]), "senderId": sender_ids[0] if sender_ids else "",
        "kind": kind, "body": body if kind == "text" else (body or None),
        "attachment": attachment, "card": card,
        "clientMessageId": client_message_id, "createdAt": now, "reported": False,
    }
    res = await db.messaging_messages.insert_one(doc)
    doc["_id"] = res.inserted_id

    await db.messaging_conversations.update_one(
        {"_id": conversation["_id"]},
        {"$set": {"lastMessageAt": now, "lastMessagePreview": preview, "updatedAt": now}},
    )
    # Sender implicitly reads their own message immediately — an
    # optimistic send should never leave the sender's own conversation
    # showing an unread badge for the message they just wrote.
    await mark_read(db, conversation_id=str(conversation["_id"]), student_id=sender_ids[0] if sender_ids else "")

    serialized = _serialize_message(doc)
    await _dispatch_realtime(other_ids, {"type": "message", "item": serialized})

    for recipient in other_ids:
        if _ws_manager.is_connected_locally(recipient):
            continue  # heuristic: connected on THIS process, skip the redundant push
        try:
            title = f"សារថ្មី / New message from {sender_display}"
            push_body = preview if kind != "voice" else "🎤 សារជាសំឡេង / Voice message"
            await fan_out_push(
                {"studentId": recipient}, title, push_body, "/messages",
                category="system",
            )
        except Exception as exc:  # noqa: BLE001 — a push failure must never break the send itself
            log.warning("messaging: push fallback failed for %s: %s", recipient, str(exc)[:160])

    return serialized


# ─────────────────────────────────────────────────────────────────────────────
# Read state / unread counts
# ─────────────────────────────────────────────────────────────────────────────
async def mark_read(db, *, conversation_id: str, student_id: str) -> None:
    now = datetime.now(timezone.utc)
    await db.messaging_read_state.update_one(
        {"conversationId": conversation_id, "studentId": student_id},
        {"$set": {"lastReadAt": now}},
        upsert=True,
    )


async def _unread_count(db, conversation_id: str, student_id: str) -> int:
    state = await db.messaging_read_state.find_one(
        {"conversationId": conversation_id, "studentId": student_id}, {"_id": 0, "lastReadAt": 1},
    )
    since = state["lastReadAt"] if state else datetime.fromtimestamp(0, tz=timezone.utc)
    return await db.messaging_messages.count_documents(
        {"conversationId": conversation_id, "createdAt": {"$gt": since}, "senderId": {"$ne": student_id}},
    )


async def list_conversations(db, student_ids: list[str]) -> list[dict]:
    cursor = db.messaging_conversations.find(
        {"participantIds": {"$in": student_ids}, "archived": False},
    ).sort("lastMessageAt", -1).limit(200)
    convs = await cursor.to_list(length=200)

    # Batched (not N+1) resolution of the "who is this DM with" name —
    # real data from db.students, never fabricated (rule 7). Collect
    # every DM's other-participant id across the whole page first, one
    # query for all of them.
    other_ids: set[str] = set()
    for conv in convs:
        if conv.get("kind") == "dm":
            for p in conv.get("participantIds") or []:
                if _norm_id(p) not in student_ids:
                    other_ids.add(_norm_id(p))
    names: dict[str, str] = {}
    if other_ids:
        cursor2 = db.students.find(
            {"$or": [{"clean_id": {"$in": list(other_ids)}}, {"student_id": {"$in": list(other_ids)}}]},
            {"_id": 0, "clean_id": 1, "student_id": 1, "display_name": 1},
        )
        async for s in cursor2:
            name = s.get("display_name") or s.get("clean_id") or s.get("student_id") or ""
            for key in (s.get("clean_id"), s.get("student_id")):
                if key:
                    names[_norm_id(key)] = name

    out = []
    for conv in convs:
        unread = await _unread_count(db, str(conv["_id"]), student_ids[0] if student_ids else "")
        other_name = None
        if conv.get("kind") == "dm":
            for p in conv.get("participantIds") or []:
                np = _norm_id(p)
                if np not in student_ids:
                    other_name = names.get(np)
                    break
        out.append(_serialize_conversation(conv, unread, other_display_name=other_name))
    return out


async def total_unread_count(db, student_ids: list[str]) -> int:
    total = 0
    cursor = db.messaging_conversations.find(
        {"participantIds": {"$in": student_ids}, "archived": False}, {"_id": 1},
    )
    async for conv in cursor:
        total += await _unread_count(db, str(conv["_id"]), student_ids[0] if student_ids else "")
        if total >= 99:
            return 99
    return total


# ─────────────────────────────────────────────────────────────────────────────
# Block / Report
# ─────────────────────────────────────────────────────────────────────────────
async def block_student(db, blocker_id: str, blocked_id: str) -> None:
    blocker_id, blocked_id = _norm_id(blocker_id), _norm_id(blocked_id)
    if not blocker_id or not blocked_id or blocker_id == blocked_id:
        raise HTTPException(status_code=400, detail="invalid block target")
    await db.messaging_blocks.update_one(
        {"blockerId": blocker_id, "blockedId": blocked_id},
        {"$setOnInsert": {"createdAt": datetime.now(timezone.utc)}},
        upsert=True,
    )


async def unblock_student(db, blocker_id: str, blocked_id: str) -> None:
    await db.messaging_blocks.delete_one({"blockerId": _norm_id(blocker_id), "blockedId": _norm_id(blocked_id)})


async def file_report(
    db, *, reporter_id: str, conversation_id: str, message_id: str, reason: str,
) -> dict:
    conv = await _load_conversation_or_404(db, conversation_id)
    if not can_read_conversation(conv, [_norm_id(reporter_id)]):
        raise HTTPException(status_code=403, detail="you cannot report a conversation you cannot see")
    msg_oid = _oid(message_id, "message id")
    msg = await db.messaging_messages.find_one({"_id": msg_oid, "conversationId": conversation_id})
    if not msg:
        raise HTTPException(status_code=404, detail="message not found")

    now = datetime.now(timezone.utc)
    report_doc = {
        "reporterId": _norm_id(reporter_id), "conversationId": conversation_id,
        "messageId": message_id, "reason": (reason or "").strip()[:500],
        "createdAt": now, "resolved": False, "resolvedAt": None, "resolvedBy": None, "resolutionNote": None,
    }
    res = await db.messaging_reports.insert_one(report_doc)
    report_doc["_id"] = res.inserted_id
    # TTL exemption (rule 4.3 / 6.5) — flip the flag the sweep checks,
    # BEFORE the report can be lost to a race with the reaper.
    await db.messaging_messages.update_one({"_id": msg_oid}, {"$set": {"reported": True}})
    log.info("messaging: report filed reporter=%s conversation=%s message=%s",
              reporter_id, conversation_id, message_id)
    return report_doc


async def resolve_report(db, *, report_id: str, resolved_by: str, note: str, ttl_days: int) -> dict:
    oid = _oid(report_id, "report id")
    report = await db.messaging_reports.find_one({"_id": oid})
    if not report:
        raise HTTPException(status_code=404, detail="report not found")
    now = datetime.now(timezone.utc)
    await db.messaging_reports.update_one(
        {"_id": oid},
        {"$set": {"resolved": True, "resolvedAt": now, "resolvedBy": _norm_id(resolved_by), "resolutionNote": (note or "")[:500]}},
    )
    # Clear the exemption and give the attachment (if any) a FRESH
    # ttl_days window from resolution time — never resume a clock that
    # may have already silently elapsed during review, which would
    # re-expire it the instant protection lifts.
    msg_oid = _oid(report["messageId"], "message id")
    msg = await db.messaging_messages.find_one({"_id": msg_oid})
    update: dict = {"reported": False}
    if msg and msg.get("attachment") and not msg["attachment"].get("expired"):
        update["attachment.expiresAt"] = now + timedelta(days=ttl_days)
    await db.messaging_messages.update_one({"_id": msg_oid}, {"$set": update})
    report["resolved"] = True
    return report


# ─────────────────────────────────────────────────────────────────────────────
# Attachment retention sweep — cron-triggered, matches the SAME
# established convention as push_scheduled's `POST /push/schedule/
# run-due` (an external cron hits a REST endpoint; no in-process
# scheduler loop exists anywhere in this codebase to hook into instead).
# A raw Mongo TTL index (notification_center.py's own mechanism) cannot
# be used directly here: it can only delete a whole document by a fixed
# date field, with no way to (a) delete the R2 object first or (b)
# dynamically skip documents currently under report review. This sweep
# reproduces the SAME 30-day-retention intent with the same "reused,
# not reinvented" spirit, adapted to what a bare index genuinely cannot
# do. Text/message ROWS are never touched — only `attachment` fields on
# already-expired, unreported voice messages.
# ─────────────────────────────────────────────────────────────────────────────
async def sweep_expired_attachments(db, *, delete_object: Callable[[str], Awaitable[bool]] = r2_object_store.delete_object) -> dict:
    now = datetime.now(timezone.utc)
    cursor = db.messaging_messages.find({
        "kind": "voice",
        "reported": {"$ne": True},
        "attachment.expired": {"$ne": True},
        "attachment.expiresAt": {"$lte": now},
    })
    reaped, failed = 0, 0
    async for msg in cursor:
        key = (msg.get("attachment") or {}).get("r2Key")
        ok = await delete_object(key) if key else True
        if ok:
            await db.messaging_messages.update_one(
                {"_id": msg["_id"]},
                {"$set": {"attachment.expired": True}, "$unset": {"attachment.url": "", "attachment.r2Key": ""}},
            )
            reaped += 1
        else:
            failed += 1
    return {"reaped": reaped, "failed": failed}


# ─────────────────────────────────────────────────────────────────────────────
# Conversation archiving (Speaking Lab groups, rule 5.7) — same cron-
# driven pattern as the attachment sweep above, for the same reason
# (archiving needs to also stop future writes / drop off the active
# list, not just flip a bare boolean a raw TTL index can't compute).
# ─────────────────────────────────────────────────────────────────────────────
async def archive_due_conversations(db) -> dict:
    now = datetime.now(timezone.utc)
    res = await db.messaging_conversations.update_many(
        {"archived": False, "archiveAt": {"$ne": None, "$lte": now}},
        {"$set": {"archived": True}},
    )
    return {"archived": res.modified_count}


# ─────────────────────────────────────────────────────────────────────────────
# Index bootstrap
# ─────────────────────────────────────────────────────────────────────────────
async def ensure_messaging_indexes(db) -> None:
    await db.messaging_conversations.create_index("participantIds")
    await db.messaging_conversations.create_index([("participantIds", 1), ("archived", 1), ("lastMessageAt", -1)])
    await db.messaging_conversations.create_index("archiveAt", sparse=True)
    # Prevents a duplicate DM conversation for the same pair under
    # concurrent "first message" requests (see get_or_create_dm's
    # DuplicateKeyError handling) — partial so it never constrains
    # "class"/"speaking_lab_group" documents, which legitimately share
    # overlapping participantIds sets across many conversations.
    await db.messaging_conversations.create_index(
        [("kind", 1), ("participantIds", 1)], unique=True,
        partialFilterExpression={"kind": "dm"},
    )
    await db.messaging_messages.create_index([("conversationId", 1), ("createdAt", -1)])
    await db.messaging_messages.create_index("clientMessageId", sparse=True)
    await db.messaging_read_state.create_index([("conversationId", 1), ("studentId", 1)], unique=True)
    await db.messaging_blocks.create_index([("blockerId", 1), ("blockedId", 1)], unique=True)
    await db.messaging_reports.create_index([("resolved", 1), ("createdAt", -1)])


# ─────────────────────────────────────────────────────────────────────────────
# Voice upload helper
# ─────────────────────────────────────────────────────────────────────────────
async def upload_voice_attachment(raw: bytes, mime_type: str, duration_sec: Optional[float]) -> dict:
    if mime_type not in ALLOWED_VOICE_MIME:
        raise HTTPException(status_code=400, detail=f"unsupported audio type: {mime_type}")
    if len(raw) > MAX_VOICE_BYTES:
        raise HTTPException(status_code=400, detail="voice message too large")
    ext = {"audio/webm": "webm", "audio/ogg": "ogg", "audio/mpeg": "mp3",
           "audio/mp4": "m4a", "audio/x-m4a": "m4a", "audio/wav": "wav"}.get(mime_type, "bin")
    key = r2_object_store.content_hash_key(raw, prefix="messaging/voice", ext=ext)
    url = await r2_object_store.upload_bytes(raw, key, mime_type, {"feature": "messaging"})
    if url is None:
        raise HTTPException(status_code=503, detail="voice upload failed — please try again")
    return {"r2Key": key, "mimeType": mime_type, "durationSec": duration_sec, "sizeBytes": len(raw), "url": url, "expired": False}


# ─────────────────────────────────────────────────────────────────────────────
# Routes
# ─────────────────────────────────────────────────────────────────────────────
def register_messaging_routes(
    api, app, db, require_student, require_admin, fan_out_push,
    *, current_user_dep=None, is_super_admin_fn=None, cron_secret: str = "",
) -> None:
    """`current_user_dep` / `is_super_admin_fn` / `cron_secret` are only
    needed for the cron-triggered attachment-reap endpoint below, which
    mirrors server.py's own `push_schedule_run_due` dual-auth contract
    exactly (super-admin session OR the shared x-cron-secret header) —
    `require_admin` alone can't be reused there because it raises 401
    before a cron-secret-only caller (no user session at all) would get
    a chance to authenticate the other way. All other routes are
    unaffected by these three optional params."""
    from notification_center import _resolve_student_by_session_token

    @api.get("/messaging/conversations")
    async def list_my_conversations(student=Depends(require_student)):
        await _require_enabled(db)
        my_ids = _student_ids(student)
        return {"items": await list_conversations(db, my_ids), "viewerId": my_ids[0] if my_ids else ""}

    @api.get("/messaging/conversations/{conversation_id}")
    async def get_conversation(conversation_id: str, student=Depends(require_student)):
        # Deliberately separate from list_my_conversations: the list
        # excludes archived conversations (they're meant to drop off the
        # active list — rule 5.7), but a participant must still be able
        # to open and read an archived conversation directly (read-only,
        # NOT deleted) — this single-fetch route is what the thread page
        # uses precisely so archived history is never unreachable.
        await _require_enabled(db)
        my_ids = _student_ids(student)
        conv = await _load_conversation_or_404(db, conversation_id)
        if not can_read_conversation(conv, my_ids):
            raise HTTPException(status_code=403, detail="you are not a participant in this conversation")
        other_name = None
        if conv.get("kind") == "dm":
            for p in conv.get("participantIds") or []:
                if _norm_id(p) not in my_ids:
                    other = await db.students.find_one(
                        {"$or": [{"clean_id": _norm_id(p)}, {"student_id": _norm_id(p)}]},
                        {"_id": 0, "display_name": 1, "clean_id": 1, "student_id": 1},
                    )
                    other_name = (other or {}).get("display_name") if other else None
                    break
        unread = await _unread_count(db, conversation_id, my_ids[0] if my_ids else "")
        result = _serialize_conversation(conv, unread, other_display_name=other_name)
        # The client needs an authoritative "which senderId is ME" value
        # to render message bubbles correctly for HISTORICAL messages
        # (not just its own just-sent optimistic ones, which it already
        # knows are its own) — client-side auth state doesn't reliably
        # expose the same clean_id/student_id form the backend uses as
        # senderId, so this is handed over explicitly rather than guessed.
        result["viewerId"] = my_ids[0] if my_ids else ""
        return result

    @api.get("/messaging/unread-count")
    async def my_unread_count(student=Depends(require_student)):
        await _require_enabled(db)
        return {"count": await total_unread_count(db, _student_ids(student))}

    @api.post("/messaging/dm/{target_student_id}")
    async def start_dm(target_student_id: str, student=Depends(require_student)):
        await _require_enabled(db)
        my_ids = _student_ids(student)
        target = _norm_id(target_student_id)
        exists = await db.students.find_one(
            {"$or": [{"clean_id": target}, {"student_id": target}]}, {"_id": 1},
        )
        if not exists:
            raise HTTPException(status_code=404, detail="student not found")
        conv = await get_or_create_dm(db, my_ids[0] if my_ids else "", target)
        return _serialize_conversation(conv, await _unread_count(db, str(conv["_id"]), my_ids[0] if my_ids else ""))

    @api.get("/messaging/conversations/{conversation_id}/messages")
    async def get_history(
        conversation_id: str,
        before: str = Query(default=""),
        limit: int = Query(default=HISTORY_PAGE_SIZE, ge=1, le=HISTORY_PAGE_SIZE),
        student=Depends(require_student),
    ):
        await _require_enabled(db)
        my_ids = _student_ids(student)
        conv = await _load_conversation_or_404(db, conversation_id)
        if not can_read_conversation(conv, my_ids):
            raise HTTPException(status_code=403, detail="you are not a participant in this conversation")
        q: dict = {"conversationId": conversation_id}
        if before:
            try:
                q["createdAt"] = {"$lt": datetime.fromisoformat(before.replace("Z", "+00:00"))}
            except ValueError:
                raise HTTPException(status_code=400, detail="invalid before cursor")
        cursor = db.messaging_messages.find(q).sort("createdAt", -1).limit(limit + 1)
        docs = await cursor.to_list(length=limit + 1)
        has_more = len(docs) > limit
        items = [_serialize_message(d) for d in reversed(docs[:limit])]
        return {"items": items, "hasMore": has_more}

    @api.post("/messaging/conversations/{conversation_id}/read")
    async def mark_conversation_read(conversation_id: str, student=Depends(require_student)):
        await _require_enabled(db)
        my_ids = _student_ids(student)
        conv = await _load_conversation_or_404(db, conversation_id)
        if not is_participant(conv, my_ids):
            raise HTTPException(status_code=403, detail="you are not a participant in this conversation")
        await mark_read(db, conversation_id=conversation_id, student_id=my_ids[0] if my_ids else "")
        return {"ok": True}

    @api.post("/messaging/conversations/{conversation_id}/messages")
    async def post_message(
        conversation_id: str,
        kind: str = Form(default="text"),
        body: Optional[str] = Form(default=None),
        trophy_id: Optional[str] = Form(default=None),
        client_message_id: Optional[str] = Form(default=None),
        duration_sec: Optional[float] = Form(default=None),
        audio: Optional[UploadFile] = File(default=None),
        student=Depends(require_student),
    ):
        await _require_enabled(db)
        my_ids = _student_ids(student)
        conv = await _load_conversation_or_404(db, conversation_id)

        attachment = None
        if kind == "voice":
            if audio is None:
                raise HTTPException(status_code=400, detail="an audio file is required for a voice message")
            raw = await audio.read()
            uploaded = await upload_voice_attachment(raw, audio.content_type or "application/octet-stream", duration_sec)
            days = await attachment_ttl_days(db)
            attachment = {**uploaded, "expiresAt": datetime.now(timezone.utc) + timedelta(days=days)}

        item = await send_message(
            db, conversation=conv, sender_ids=my_ids,
            sender_display=getattr(student, "display_name", "") or "a classmate",
            kind=kind, body=body, attachment=attachment, trophy_id=trophy_id,
            client_message_id=client_message_id, fan_out_push=fan_out_push,
        )
        return item

    @api.post("/messaging/block/{target_student_id}")
    async def block(target_student_id: str, student=Depends(require_student)):
        my_ids = _student_ids(student)
        await block_student(db, my_ids[0] if my_ids else "", target_student_id)
        return {"ok": True}

    @api.post("/messaging/unblock/{target_student_id}")
    async def unblock(target_student_id: str, student=Depends(require_student)):
        my_ids = _student_ids(student)
        await unblock_student(db, my_ids[0] if my_ids else "", target_student_id)
        return {"ok": True}

    @api.get("/messaging/blocks")
    async def list_blocks(student=Depends(require_student)):
        my_ids = _student_ids(student)
        cursor = db.messaging_blocks.find({"blockerId": {"$in": my_ids}}, {"_id": 0, "blockedId": 1, "createdAt": 1})
        return {"items": [{"studentId": d["blockedId"], "blockedAt": _iso(d.get("createdAt"))} async for d in cursor]}

    @api.post("/messaging/conversations/{conversation_id}/messages/{message_id}/report")
    async def report_message(
        conversation_id: str, message_id: str,
        reason: str = Body(embed=True), student=Depends(require_student),
    ):
        my_ids = _student_ids(student)
        report = await file_report(
            db, reporter_id=my_ids[0] if my_ids else "", conversation_id=conversation_id,
            message_id=message_id, reason=reason,
        )
        return {"ok": True, "reportId": str(report["_id"])}

    # ── Admin — review queue (rule 4.2: follow an existing admin-queue
    #    UI convention rather than a bespoke pattern; this is the plain
    #    list/resolve shape PasswordResetRequestsPanel's own backend
    #    already established). ────────────────────────────────────────
    @api.get("/admin/messaging/reports")
    async def admin_list_reports(resolved: bool = Query(default=False), admin=Depends(require_admin)):
        cursor = db.messaging_reports.find({"resolved": resolved}).sort("createdAt", -1).limit(200)
        out = []
        async for r in cursor:
            msg = await db.messaging_messages.find_one({"_id": _oid(r["messageId"])})
            out.append({
                "id": str(r["_id"]), "reporterId": r["reporterId"], "conversationId": r["conversationId"],
                "messageId": r["messageId"], "reason": r["reason"], "createdAt": _iso(r["createdAt"]),
                "resolved": r["resolved"],
                "message": _serialize_message(msg) if msg else None,
            })
        return {"items": out}

    @api.post("/admin/messaging/reports/{report_id}/resolve")
    async def admin_resolve_report(report_id: str, note: str = Body(default="", embed=True), admin=Depends(require_admin)):
        ttl_days = await attachment_ttl_days(db)
        report = await resolve_report(db, report_id=report_id, resolved_by=getattr(admin, "email", ""), note=note, ttl_days=ttl_days)
        return {"ok": True, "reportId": str(report["_id"])}

    # ── Cron-triggered maintenance — same x-cron-secret-or-admin dual
    #    auth as push_schedule_run_due (server.py): a super-admin session
    #    OR the shared secret header, never neither. ─────────────────────
    @api.post("/admin/messaging/attachments/reap-expired")
    async def admin_reap_expired(
        x_cron_secret: str | None = Header(default=None, alias="x-cron-secret"),
        user=Depends(current_user_dep) if current_user_dep is not None else None,
    ):
        is_admin = bool(is_super_admin_fn and user and is_super_admin_fn(user))
        secret_ok = bool(cron_secret) and x_cron_secret == cron_secret
        if not (is_admin or secret_ok):
            raise HTTPException(status_code=403, detail="forbidden")
        return await sweep_expired_attachments(db)

    @api.post("/admin/messaging/conversations/archive-due")
    async def admin_archive_due(admin=Depends(require_admin)):
        return await archive_due_conversations(db)

    @app.websocket("/api/messaging/ws")
    async def messaging_ws(ws: WebSocket, token: str = Query(default="")):
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
    async def _messaging_startup():
        try:
            await ensure_messaging_indexes(db)
            log.info("messaging: indexes ready")
        except Exception as exc:  # noqa: BLE001
            log.warning("messaging: index bootstrap failed: %s", str(exc)[:200])

        global _event_bus
        try:
            from eduhub_platform.events import build_event_bus
            _event_bus = await build_event_bus(db)
            await _event_bus.subscribe(_REALTIME_CHANNEL, _deliver_ws)
            log.info("messaging: event bus ready (transport=%s)", type(_event_bus._transport).__name__)
        except Exception as exc:  # noqa: BLE001
            log.warning("messaging: event bus init failed (falling back to direct local delivery): %s", str(exc)[:200])
            _event_bus = None

    log.info("messaging: routes registered (/api/messaging*)")
