"""
speaking_lab_direct_join.py — Speaking Lab Direct Join (v1.0, DARK)
=============================================================================

Focused, additive module implementing the authenticated, atomic "tap to
join" Prize Pool flow. Gated end-to-end behind
``speaking_lab_feature_flags.direct_join_enabled`` — when disabled (the
production default), both routes return a safe, explicit response and
perform ZERO mutation.

Core invariant this module exists to guarantee:

    A student can never be successfully charged without a durable lucky
    code existing. HTTP 200 is returned ONLY when a committed join record
    (with its lucky code) durably exists.

Design summary
--------------
* Student identity comes ONLY from the authenticated ``require_student``
  dependency (canonical ``clean_id``) — never from the request body, a
  query parameter, or a free-text name.
* Authoritative uniqueness is ``(session_id, canonical_student_id)`` — a
  unique index on the NEW ``speaking_lab_direct_joins`` collection (safe
  to create: this collection has no legacy data). The client-supplied
  ``idempotency_key`` is recorded for audit but is NOT the uniqueness
  boundary — a different UUID for the same (session, student) can never
  create a second charge.
* One Mongo multi-document transaction covers: session re-validation,
  schedule eligibility, legacy-paid adoption check, the wallet transfer,
  the paid-entry upsert, the lucky-code persistence, and the join-record
  insert. No push, SSE, HTTP, or GAS call happens inside the transaction
  — see ``persist_lucky_code``/``publish_lucky_code_events`` in
  lucky_draw.py for the same split applied there.
* ``WalletService.transfer(..., session=<txn session>)`` is used via the
  additive caller-owned-session support added to wallet_service.py —
  WalletService never opens or commits its own session when one is
  supplied, so it participates in (and rolls back with) this
  transaction.
* Commit uncertainty (``UnknownTransactionCommitResult``) is handled by
  re-querying the authoritative (session_id, student_id) key rather than
  ever blindly repeating the wallet transfer.
* Push notification (after commit only) reuses the exact
  atomic-claim / attempt-ID / stale-sending-recovery pattern already
  proven this session for Lucky Draw and Mystery Box.
"""

from __future__ import annotations

import asyncio
import logging
import uuid
from datetime import datetime, timedelta, timezone
from typing import Any, Awaitable, Callable, Optional

from fastapi import APIRouter, Depends, HTTPException, status
from pydantic import BaseModel, ConfigDict, Field

import wallet_service as ws
import speaking_lab_feature_flags as flags
import speaking_lab_enrollment_audit as enroll_audit
from teacher_admission import (
    ALLOWED_SESSION_STATES,
    COLLECTION_CODES,
    _draw_locked,
    _is_synthetic_id,
    session_schedule_eligibility,
    utcnow,
)
from lucky_draw import persist_lucky_code, publish_lucky_code_events

logger = logging.getLogger("eduhub.speaking_lab_direct_join")

COLLECTION_DIRECT_JOINS = "speaking_lab_direct_joins"

PUSH_PENDING = "pending"
PUSH_SENDING = "sending"
PUSH_SENT = "sent"
PUSH_FAILED = "failed"
PUSH_STALE_SECONDS = 120


# ──────────────────────────────────────────────────────────────────────────────
# Indexes — this collection is BRAND NEW with zero legacy data, so creating
# unique indexes on it up front is safe (unlike speaking_lab_entries /
# speaking_lab_lucky_codes, which the migration tooling treats separately
# and never touches with a blind index creation).
# ──────────────────────────────────────────────────────────────────────────────
async def ensure_direct_join_indexes(db) -> bool:
    try:
        coll = db[COLLECTION_DIRECT_JOINS]
        await coll.create_index([("join_id", 1)], unique=True, name="uq_direct_join_id")
        await coll.create_index(
            [("session_id", 1), ("student_id", 1)],
            unique=True, name="uq_direct_join_session_student",
        )
        await coll.create_index([("payment_reference", 1)],
                                name="idx_direct_join_payment_reference")
        logger.info("speaking_lab_direct_join: indexes ensured")
        return True
    except Exception as exc:  # noqa: BLE001
        logger.warning("speaking_lab_direct_join: index ensure failed: %s", exc)
        return False


# ──────────────────────────────────────────────────────────────────────────────
# Errors — mapped to HTTP status by the route handlers
# ──────────────────────────────────────────────────────────────────────────────
class DirectJoinError(Exception):
    def __init__(self, code: str, message: str = "", http_status: int = 409):
        self.code = code
        self.message = message or code
        self.http_status = http_status
        super().__init__(self.message)


# ──────────────────────────────────────────────────────────────────────────────
# Request / response models
# ──────────────────────────────────────────────────────────────────────────────
class DirectJoinRequest(BaseModel):
    model_config = ConfigDict(extra="ignore")
    idempotency_key: str = Field(..., min_length=1, max_length=128)


class DirectJoinResponse(BaseModel):
    ok: bool = True
    session_id: str
    lucky_code: str
    position: int
    entry_fee: int
    pool_total: int
    player_count: int
    idempotent_replay: bool = False


class MyEntryResponse(BaseModel):
    ok: bool = True
    found: bool
    session_id: str = ""
    lucky_code: str = ""
    position: int = 0
    entry_fee: int = 0
    pool_total: int = 0
    player_count: int = 0
    source: str = ""  # "direct_join" | "legacy" | ""


class JoinPreviewExistingEntry(BaseModel):
    lucky_code: str
    status: str = "confirmed"


class JoinPreviewResponse(BaseModel):
    """Read-only, pre-join session preview. Never mutates anything — no
    wallet transfer, no entry creation, no code generation, no push.
    Lets the PWA distinguish an invalid/nonexistent code (404) from a
    valid session that simply isn't open for entry yet, which
    `/my-entry` cannot do (it only ever reports the CALLING student's
    own entry, never validates the session itself exists)."""
    ok: bool = True
    session_id: str
    session_code: str
    schedule: str = ""
    status: str  # "waiting" | "active" | "closed"
    entry_fee: int = 0
    pool_total: int = 0
    player_count: int = 0
    direct_join_enabled: bool = False
    existing_entry: Optional[JoinPreviewExistingEntry] = None


class ActiveSessionResponse(BaseModel):
    """Read-only "is there a live session for me right now?" answer that
    drives the one-tap My Portal card. The card fires this on open and
    silently HIDES itself if it fails or ``active`` is false — it never
    shows an error on the student's main screen. No session code is ever
    typed: the server resolves the student's eligible live session from
    their schedule. Never mutates anything."""
    ok: bool = True
    active: bool
    session_id: str = ""
    schedule: str = ""
    entry_fee: int = 0
    pool_total: int = 0
    player_count: int = 0
    direct_join_enabled: bool = False
    existing_entry: Optional[JoinPreviewExistingEntry] = None


class EnrollAllFailure(BaseModel):
    student_id: str
    reason: str


class EnrollAllResponse(BaseModel):
    """Teacher "Enroll All Eligible Students" result. Every entry in
    ``failed`` came from the SAME per-student _perform_join call the
    manual one-tap route uses — no second success/failure taxonomy."""
    ok: bool = True
    session_id: str
    attempted: int
    joined: int
    already_had_ticket: int
    failed: list[EnrollAllFailure] = []


class EnrollmentStatusFailure(BaseModel):
    student_id: str
    reason: str


class EnrollmentStatusResponse(BaseModel):
    """Teacher control-panel counters, computed live from the roster +
    direct-join + audit collections — never a separately-maintained
    status field that could drift from reality."""
    ok: bool = True
    session_id: str
    roster_size: int
    joined: int
    pending: int
    failed: int
    failed_detail: list[EnrollmentStatusFailure] = []


# ──────────────────────────────────────────────────────────────────────────────
# Notification — exactly-once, atomic claim on the join record itself
# ──────────────────────────────────────────────────────────────────────────────
def _join_push_content(code: str) -> tuple[str, str]:
    return (
        "🎟 Speaking Lab Entry Confirmed!",
        f"Your lucky code is {code}. You're now in the Prize Pool.",
    )


async def notify_speaking_lab_join(
    db, push_notify: Optional[Callable[[str, str, str], Awaitable[dict]]],
    join_id: str, student_id: str, lucky_code: str, log=None,
) -> dict:
    """Send the join-confirmed push truthfully and EXACTLY ONCE, for a
    join that is ALREADY durably committed (``status == "committed"``).

    Never grants anything. Never calls WalletService, GAS, entry
    creation, or code generation — it only atomically claims the
    notification slot on the existing join record and calls the real
    push helper, mirroring ``_send_winner_push_idempotent`` (Lucky Draw)
    and ``notify_mystery_box_prize`` (Mystery Box) exactly."""
    L = log or logger
    if push_notify is None:
        return {"ok": True, "skipped": True, "reason": "no_push_notify_configured"}

    coll = db[COLLECTION_DIRECT_JOINS]
    now = utcnow()
    now_iso = now.isoformat()
    attempt_id = uuid.uuid4().hex
    stale_cut = (now - timedelta(seconds=PUSH_STALE_SECONDS)).isoformat()

    claim = await coll.update_one(
        {"join_id": join_id, "status": "committed",
         "notification_status": {"$in": [None, PUSH_PENDING, PUSH_FAILED]}},
        {"$set": {"notification_status": PUSH_SENDING,
                  "notification_attempt_id": attempt_id,
                  "notification_attempted_at": now_iso}},
    )
    if getattr(claim, "modified_count", 0) != 1:
        reclaim = await coll.update_one(
            {"join_id": join_id, "status": "committed",
             "notification_status": PUSH_SENDING,
             "notification_attempted_at": {"$lt": stale_cut}},
            {"$set": {"notification_status": PUSH_SENDING,
                      "notification_attempt_id": attempt_id,
                      "notification_attempted_at": now_iso}},
        )
        if getattr(reclaim, "modified_count", 0) != 1:
            return {"ok": True, "skipped": True, "reason": "not_claimable"}

    title, body = _join_push_content(lucky_code)
    try:
        result = await push_notify(student_id, title, body)
    except Exception as exc:  # noqa: BLE001
        await coll.update_one(
            {"join_id": join_id, "notification_attempt_id": attempt_id},
            {"$set": {"notification_status": PUSH_FAILED,
                      "notification_error": str(exc)[:200]}},
        )
        L.warning("speaking_lab_direct_join: push raised (join stays "
                  "committed) join_id=%s err=%s", join_id, str(exc)[:200])
        return {"ok": False, "sent": False, "error": str(exc)[:200]}

    sent = int((result or {}).get("sent") or 0)
    if sent >= 1:
        await coll.update_one(
            {"join_id": join_id, "notification_attempt_id": attempt_id},
            {"$set": {"notification_status": PUSH_SENT,
                      "notification_sent_at": utcnow().isoformat(),
                      "notification_error": ""}},
        )
        return {"ok": True, "sent": True}

    no_subs = bool((result or {}).get("no_subscribers"))
    err = str((result or {}).get("error") or "")
    await coll.update_one(
        {"join_id": join_id, "notification_attempt_id": attempt_id},
        {"$set": {"notification_status": PUSH_FAILED,
                  "notification_error": err or ("no_subscribers" if no_subs else "delivery_failed")}},
    )
    return {"ok": True, "sent": False,
            "reason": "no_subscribers" if no_subs else "delivery_failed"}


# ──────────────────────────────────────────────────────────────────────────────
# Legacy-adoption + entry-canonicalization helpers (shared by the txn body)
# ──────────────────────────────────────────────────────────────────────────────
async def _find_synthetic_candidate(SL_ENTRIES, session_id, display_name_key,
                                    canonical_student_id, *, mongo_session):
    matches = []
    cur = SL_ENTRIES.find(
        {"session_id": session_id, "display_name_key": display_name_key},
        {"_id": 0}, session=mongo_session,
    )
    async for row in cur:
        sid = row.get("student_id")
        if sid == canonical_student_id:
            return None
        if _is_synthetic_id(sid):
            matches.append(row)
        else:
            return None
    return matches[0] if len(matches) == 1 else None


async def _pool_snapshot(db, session_id, *, mongo_session=None):
    total, n = 0, 0
    cur = db[COLLECTION_CODES].find(
        {"session_id": session_id}, {"_id": 0, "entry_fee": 1},
        session=mongo_session,
    )
    async for r in cur:
        n += 1
        total += int(r.get("entry_fee") or 0)
    return {"pool_total": total, "player_count": n}


# ──────────────────────────────────────────────────────────────────────────────
# The atomic transaction body
# ──────────────────────────────────────────────────────────────────────────────
async def _direct_join_txn_body(
    db, SL_SESSIONS, SL_ENTRIES, norm_student_id,
    session_id: str, canonical_student_id: str, display_name: str,
    client_idempotency_key: str, *, mongo_session,
) -> dict:
    """Runs entirely inside one caller-owned Mongo transaction. Raises
    ``DirectJoinError``/wallet exceptions to abort (and roll back
    everything) on any failure. Returns a dict describing the outcome —
    the caller (outside the transaction) is responsible for post-commit
    SSE publication and the push notification."""
    joins_coll = db[COLLECTION_DIRECT_JOINS]

    # 1) Fast idempotent replay — handles retries of with_transaction's own
    #    callback AND genuine duplicate requests identically.
    existing_join = await joins_coll.find_one(
        {"session_id": session_id, "student_id": canonical_student_id,
         "status": "committed"},
        {"_id": 0}, session=mongo_session,
    )
    if existing_join:
        return {"outcome": "replayed", "join": existing_join}

    # 2) Re-read + validate session state INSIDE the transaction.
    sess = await SL_SESSIONS.find_one(
        {"session_id": session_id}, session=mongo_session)
    if not sess:
        raise DirectJoinError("session_not_found", http_status=404)
    locked = _draw_locked(sess)
    if locked:
        raise DirectJoinError("draw_locked", f"Session is locked ({locked}).",
                              http_status=409)
    sess_status = (sess.get("status") or "").strip().lower()
    if sess_status not in ALLOWED_SESSION_STATES:
        raise DirectJoinError("session_not_open",
                              f"Session state '{sess_status}' does not accept joins.",
                              http_status=422)
    entry_fee = int(sess.get("entry_fee") or 0)
    treasury_id = norm_student_id(sess.get("treasury_id") or "stu092")

    # 3) Schedule eligibility (shared rule with Missing Code Rescue).
    student_doc = await db.students.find_one(
        {"$or": [{"clean_id": canonical_student_id},
                 {"student_id": canonical_student_id}]},
        {"_id": 0, "group": 1, "schedule": 1}, session=mongo_session,
    )
    student_group = (student_doc or {}).get("group") or (student_doc or {}).get("schedule") or ""
    eligible, reason = session_schedule_eligibility(student_group, sess.get("schedule"))
    if not eligible:
        raise DirectJoinError(reason, http_status=409)

    display_name_key = display_name.lower()

    # 4) Legacy-paid adoption: a proven legacy entry (paid_entry=True) with
    #    a code already existing for this canonical student must be
    #    ADOPTED, never charged again.
    existing_entry = await SL_ENTRIES.find_one(
        {"session_id": session_id, "student_id": canonical_student_id},
        {"_id": 0}, session=mongo_session,
    )
    existing_code = await db[COLLECTION_CODES].find_one(
        {"session_id": session_id, "student_id": canonical_student_id},
        {"_id": 0}, session=mongo_session,
    )
    if existing_entry and existing_code and existing_entry.get("paid_entry"):
        join_id = "djn_" + uuid.uuid4().hex
        now = utcnow()
        join_doc = {
            "join_id": join_id, "session_id": session_id,
            "student_id": canonical_student_id,
            "idempotency_key": client_idempotency_key,
            "entry_fee": entry_fee,
            "payment_reference": "adopted_legacy_entry",
            "entry_id": existing_entry.get("entry_id") or "",
            "lucky_code_id": existing_code.get("code_id") or "",
            "lucky_code": existing_code.get("code"),
            "status": "committed",
            "adopted_legacy": True,
            "created_at": now.isoformat(),
            "committed_at": now.isoformat(),
            "notification_status": None,
            "notification_attempt_id": None,
            "notification_attempted_at": None,
            "notification_sent_at": None,
            "notification_error": None,
        }
        try:
            await joins_coll.insert_one(dict(join_doc), session=mongo_session)
        except Exception:
            # Concurrent adoption/commit already landed — re-read and
            # converge on it rather than raising.
            winner = await joins_coll.find_one(
                {"session_id": session_id, "student_id": canonical_student_id,
                 "status": "committed"},
                {"_id": 0}, session=mongo_session,
            )
            if winner:
                return {"outcome": "replayed", "join": winner}
            raise
        return {"outcome": "adopted_legacy", "join": join_doc}

    # 5) Authoritative points transfer — student -> treasury. Idempotency
    #    key is STABLE (session_id, student_id), never the client UUID, so
    #    a different UUID can never trigger a second real transfer.
    wallet_idem_key = f"speaking_lab_direct_join:{session_id}:{canonical_student_id}"
    wallet_svc = ws.WalletService(db)
    await wallet_svc.transfer(
        canonical_student_id, treasury_id, entry_fee,
        source="speaking_lab_direct_join", source_ref=session_id,
        idempotency_key=wallet_idem_key,
        session=mongo_session,
    )

    # 6) Create or canonicalize exactly one paid entry.
    entry_id = "ent_" + uuid.uuid4().hex
    if existing_entry:
        entry_id = existing_entry.get("entry_id") or entry_id
        await SL_ENTRIES.update_one(
            {"session_id": session_id, "student_id": canonical_student_id},
            {"$set": {
                "entry_id": entry_id, "display_name": display_name,
                "display_name_key": display_name_key,
                "paid_entry": True, "eligible": True,
                "source": "speaking_lab_direct_join",
                "direct_join_at": utcnow().isoformat(),
            }},
            session=mongo_session,
        )
        position = existing_entry.get("position")
    else:
        synth = await _find_synthetic_candidate(
            SL_ENTRIES, session_id, display_name_key, canonical_student_id,
            mongo_session=mongo_session,
        )
        if synth:
            position = synth.get("position")
            await SL_ENTRIES.update_one(
                {"session_id": session_id, "student_id": synth["student_id"]},
                {"$set": {
                    "student_id": canonical_student_id,
                    "entry_id": entry_id,
                    "display_name": display_name,
                    "display_name_key": display_name_key,
                    "paid_entry": True, "eligible": True,
                    "source": "speaking_lab_direct_join",
                    "linked_from_synthetic_id": synth["student_id"],
                    "direct_join_at": utcnow().isoformat(),
                }},
                session=mongo_session,
            )
        else:
            position = (await SL_ENTRIES.count_documents(
                {"session_id": session_id}, session=mongo_session)) + 1
            await SL_ENTRIES.insert_one({
                "session_id": session_id, "student_id": canonical_student_id,
                "entry_id": entry_id,
                "display_name": display_name, "display_name_key": display_name_key,
                "position": position, "entered_at": utcnow().isoformat(),
                "paid_entry": True, "eligible": True,
                "source": "speaking_lab_direct_join",
                "direct_join_at": utcnow().isoformat(),
            }, session=mongo_session)

    # 7) Persist exactly one lucky code (pure, transaction-safe — no SSE).
    code_doc = await persist_lucky_code(
        db, session_id, canonical_student_id, display_name,
        amount=entry_fee, session=mongo_session,
    )
    if not code_doc or not code_doc.get("code"):
        raise DirectJoinError("code_persist_failed", http_status=500)
    code_id = code_doc.get("code_id")
    if not code_id:
        code_id = "cod_" + uuid.uuid4().hex
        await db[COLLECTION_CODES].update_one(
            {"session_id": session_id, "student_id": canonical_student_id},
            {"$set": {"code_id": code_id}}, session=mongo_session,
        )

    # 8) Persist exactly one committed join record — the durable proof
    #    this whole operation succeeded.
    join_id = "djn_" + uuid.uuid4().hex
    now = utcnow()
    join_doc = {
        "join_id": join_id, "session_id": session_id,
        "student_id": canonical_student_id,
        "idempotency_key": client_idempotency_key,
        "entry_fee": entry_fee,
        "payment_reference": wallet_idem_key,
        "entry_id": entry_id,
        "lucky_code_id": code_id,
        "lucky_code": code_doc["code"],
        "status": "committed",
        "adopted_legacy": False,
        "created_at": now.isoformat(),
        "committed_at": now.isoformat(),
        "notification_status": None,
        "notification_attempt_id": None,
        "notification_attempted_at": None,
        "notification_sent_at": None,
        "notification_error": None,
    }
    await joins_coll.insert_one(dict(join_doc), session=mongo_session)

    return {"outcome": "committed", "join": join_doc, "position": position}


# ──────────────────────────────────────────────────────────────────────────────
# Outer orchestration — session lifecycle, commit-uncertainty recovery
# ──────────────────────────────────────────────────────────────────────────────
async def _run_direct_join(
    db, SL_SESSIONS, SL_ENTRIES, norm_student_id,
    session_id: str, canonical_student_id: str, display_name: str,
    client_idempotency_key: str,
) -> dict:
    client = db.client
    result_holder: dict[str, Any] = {}

    async def _runner(s):
        result_holder["v"] = await _direct_join_txn_body(
            db, SL_SESSIONS, SL_ENTRIES, norm_student_id,
            session_id, canonical_student_id, display_name,
            client_idempotency_key, mongo_session=s,
        )

    try:
        async with await client.start_session() as session:
            await session.with_transaction(_runner)
    except DirectJoinError:
        raise
    except (ws.InsufficientFunds, ws.WalletStatusBlocked, ws.WalletNotFound,
            ws.TransferNotAtomic):
        raise
    except Exception as exc:  # noqa: BLE001
        # Commit uncertainty (UnknownTransactionCommitResult label, or any
        # other ambiguous driver-level failure at/after commit time): never
        # blindly repeat the wallet transfer. Query the authoritative key —
        # if a committed join exists, the transaction actually succeeded
        # and we recover its code; if not, nothing happened and it is safe
        # to report a retryable failure.
        has_label = getattr(exc, "has_error_label", None)
        is_unknown_commit = bool(has_label and has_label("UnknownTransactionCommitResult"))
        recovered = await db[COLLECTION_DIRECT_JOINS].find_one(
            {"session_id": session_id, "student_id": canonical_student_id,
             "status": "committed"},
            {"_id": 0},
        )
        if recovered:
            result_holder["v"] = {"outcome": "replayed", "join": recovered}
        elif is_unknown_commit:
            raise DirectJoinError(
                "join_uncertain_retry",
                "Could not confirm your join. Please try again — you have "
                "not been charged.",
                http_status=503,
            ) from exc
        else:
            raise
    return result_holder["v"]


# ──────────────────────────────────────────────────────────────────────────────
# Route factory
# ──────────────────────────────────────────────────────────────────────────────
def register_speaking_lab_direct_join_routes(
    api: APIRouter,
    db,
    SL_SESSIONS,
    SL_ENTRIES,
    sl_publish: Callable[[str, dict], Awaitable[None]],
    require_student_dep,
    norm_student_id: Callable[[Any], str],
    push_notify: Optional[Callable[[str, str, str], Awaitable[dict]]] = None,
    log: Optional[logging.Logger] = None,
    require_admin_dep=None,
) -> dict:
    """Returns a dict of internally-callable hooks (currently just
    ``enroll_all_eligible``) so server.py can trigger Auto Enroll
    synchronously right after session creation, without a second HTTP
    round-trip."""
    L = log or logger

    def _resolve_session_id(session_or_code: str) -> str:
        # Sessions are already keyed by their own id today (no separate
        # "join code" concept exists for direct join — the session_id
        # itself, shown/scanned by the teacher, IS the join code).
        return (session_or_code or "").strip()

    async def _resolve_active_session(canonical_student_id: str):
        """Find the ONE live session this student is eligible to join,
        server-side, so the student never types a code. A session is a
        candidate when its status is open for entry (waiting/active),
        its draw is not locked, and the shared schedule-eligibility rule
        admits this student's group. When several qualify, the most
        recently created wins (teachers run one session at a time in
        practice; newest = the one they just started). Read-only."""
        student_doc = await db.students.find_one(
            {"$or": [{"clean_id": canonical_student_id},
                     {"student_id": canonical_student_id}]},
            {"_id": 0, "group": 1, "schedule": 1},
        )
        student_group = (
            (student_doc or {}).get("group")
            or (student_doc or {}).get("schedule")
            or ""
        )
        candidates = []
        cur = SL_SESSIONS.find({"status": {"$in": list(ALLOWED_SESSION_STATES)}})
        async for sess in cur:
            if _draw_locked(sess):
                continue
            eligible, _reason = session_schedule_eligibility(
                student_group, sess.get("schedule"))
            if eligible:
                candidates.append(sess)
        if not candidates:
            return None
        # created_at is stored as an ISO-8601 string, which sorts
        # lexicographically in timestamp order — newest first.
        candidates.sort(key=lambda s: s.get("created_at") or "", reverse=True)
        return candidates[0]

    async def _perform_join(
        session_id: str,
        canonical_student_id: str,
        display_name: str,
        idempotency_key: str,
    ) -> DirectJoinResponse:
        """The single atomic enrollment + Lucky Ticket assignment, shared
        by the code-based `direct-join` route and the one-tap
        `join-active` route. Behavior is IDENTICAL for both — the only
        difference upstream is how the session_id was obtained (typed
        code vs server-resolved active session)."""
        # Shared identifiers for the durable enrollment audit trail. The
        # audit write is purely additive/observability, always fails
        # open, and runs OUTSIDE the payment transaction — a rolled-back
        # attempt still leaves a row explaining why (see
        # speaking_lab_enrollment_audit.py).
        _audit_ctx = {
            "session_id": session_id,
            "student_id": canonical_student_id,
            "idempotency_key": idempotency_key,
        }

        try:
            outcome = await _run_direct_join(
                db, SL_SESSIONS, SL_ENTRIES, norm_student_id,
                session_id, canonical_student_id, display_name,
                idempotency_key,
            )
        except DirectJoinError as exc:
            await enroll_audit.record_enrollment_attempt(
                db, **_audit_ctx, outcome="rejected", reason_code=exc.code,
                http_status=exc.http_status, lucky_code_assigned=False, log=L)
            raise HTTPException(
                status_code=exc.http_status,
                detail={"error": exc.code, "message": exc.message},
            ) from exc
        except ws.InsufficientFunds as exc:
            await enroll_audit.record_enrollment_attempt(
                db, **_audit_ctx, outcome="insufficient_points",
                reason_code="insufficient_points", http_status=402,
                lucky_code_assigned=False, log=L)
            raise HTTPException(
                status_code=402,
                detail={"error": "insufficient_points",
                        "balance": getattr(exc, "balance", None),
                        "message": "You don't have enough points to join."},
            ) from exc
        except ws.WalletStatusBlocked as exc:
            status_val = getattr(exc, "status", "blocked")
            await enroll_audit.record_enrollment_attempt(
                db, **_audit_ctx, outcome="wallet_blocked",
                reason_code=f"wallet_{status_val}", http_status=403,
                lucky_code_assigned=False, log=L)
            raise HTTPException(
                status_code=403,
                detail={"error": f"wallet_{status_val}",
                        "message": "Your wallet cannot be used right now."},
            ) from exc
        except ws.TransferNotAtomic as exc:
            await enroll_audit.record_enrollment_attempt(
                db, **_audit_ctx, outcome="join_temporarily_unavailable",
                reason_code="join_temporarily_unavailable", http_status=503,
                lucky_code_assigned=False, log=L)
            raise HTTPException(
                status_code=503,
                detail={"error": "join_temporarily_unavailable",
                        "message": "Please try again shortly."},
            ) from exc
        except ws.WalletNotFound as exc:
            await enroll_audit.record_enrollment_attempt(
                db, **_audit_ctx, outcome="wallet_not_ready",
                reason_code="wallet_not_ready", http_status=503,
                lucky_code_assigned=False, log=L)
            raise HTTPException(
                status_code=503,
                detail={"error": "wallet_not_ready",
                        "message": "Please try again shortly."},
            ) from exc

        join = outcome["join"]
        is_replay = outcome["outcome"] != "committed"

        # ── Post-commit side effects only — never inside the transaction ──
        if outcome["outcome"] == "committed":
            code_doc = await db[COLLECTION_CODES].find_one(
                {"session_id": session_id, "student_id": canonical_student_id},
                {"_id": 0},
            )
            if code_doc:
                await publish_lucky_code_events(
                    db, sl_publish, session_id, canonical_student_id,
                    display_name, code_doc, log=L,
                )
        try:
            await notify_speaking_lab_join(
                db, push_notify, join["join_id"], canonical_student_id,
                join["lucky_code"], log=L,
            )
        except Exception as exc:  # noqa: BLE001
            # Notification failure must NEVER affect the join's success.
            L.warning("speaking_lab_direct_join: notify raised (join stays "
                     "committed) join_id=%s err=%s", join.get("join_id"),
                     str(exc)[:200])

        snap = await _pool_snapshot(db, session_id)
        if not join.get("lucky_code"):
            # Defense in depth — this should be structurally impossible,
            # but HTTP 200 is forbidden without a durable code, no exceptions.
            await enroll_audit.record_enrollment_attempt(
                db, **_audit_ctx, outcome="server_error",
                reason_code="join_code_missing", http_status=500,
                idempotent_replay=is_replay, lucky_code_assigned=False,
                join_id=join.get("join_id"), log=L)
            raise HTTPException(status_code=500, detail="join_code_missing")

        # Terminal success — the student holds a durable Lucky Ticket.
        await enroll_audit.record_enrollment_attempt(
            db, **_audit_ctx, outcome=outcome["outcome"],
            reason_code=outcome["outcome"], http_status=200,
            idempotent_replay=is_replay, lucky_code_assigned=True,
            join_id=join.get("join_id"), log=L)

        return DirectJoinResponse(
            session_id=session_id,
            lucky_code=join["lucky_code"],
            position=int(outcome.get("position") or 0),
            entry_fee=int(join.get("entry_fee") or 0),
            pool_total=snap["pool_total"],
            player_count=snap["player_count"],
            idempotent_replay=is_replay,
        )

    async def _eligible_roster(sess: dict) -> list[dict]:
        """Every student eligible for THIS session's schedule, per the
        exact same session_schedule_eligibility rule _perform_join
        re-validates per student. There is no "online"/presence concept
        anywhere in this codebase — eligibility here is schedule
        membership only, same as manual Join Now. Read-only."""
        schedule = sess.get("schedule") or ""
        roster: list[dict] = []
        cur = db.students.find(
            {},
            {"_id": 0, "clean_id": 1, "student_id": 1, "group": 1,
             "schedule": 1, "display_name": 1, "name": 1},
        )
        async for doc in cur:
            student_group = doc.get("group") or doc.get("schedule") or ""
            eligible, _reason = session_schedule_eligibility(student_group, schedule)
            if not eligible:
                continue
            canonical = norm_student_id(doc.get("clean_id") or doc.get("student_id"))
            if not canonical:
                continue
            roster.append({
                "student_id": canonical,
                "display_name": doc.get("display_name") or doc.get("name") or canonical,
            })
        return roster

    async def enroll_all_eligible(session_id: str, *, max_concurrency: int = 20) -> dict:
        """Teacher "Enroll All Eligible Students" / Auto Enroll core.
        Every eligible student is run through the IDENTICAL _perform_join
        used by the code-based and one-tap routes — one independent
        atomic transaction per student, never one mega-transaction. One
        student's failure (insufficient points, wrong schedule, already
        drawn-locked, ...) never blocks or rolls back anyone else's."""
        if not await flags.direct_join_enabled(db):
            raise DirectJoinError("direct_join_disabled", http_status=503)
        sess = await SL_SESSIONS.find_one({"session_id": session_id})
        if not sess:
            raise DirectJoinError("session_not_found", http_status=404)

        roster = await _eligible_roster(sess)
        sem = asyncio.Semaphore(max_concurrency)
        counters = {"joined": 0, "already_had_ticket": 0}
        failed: list[dict] = []

        async def _one(entry: dict) -> None:
            async with sem:
                idem_key = f"bulk_enroll:{session_id}:{entry['student_id']}"
                try:
                    result = await _perform_join(
                        session_id, entry["student_id"], entry["display_name"], idem_key,
                    )
                    if result.idempotent_replay:
                        counters["already_had_ticket"] += 1
                    else:
                        counters["joined"] += 1
                except HTTPException as exc:
                    detail = exc.detail
                    reason = (detail.get("error") if isinstance(detail, dict) else None) or "error"
                    failed.append({"student_id": entry["student_id"], "reason": reason})

        await asyncio.gather(*(_one(e) for e in roster))

        return {
            "ok": True, "session_id": session_id,
            "attempted": len(roster),
            "joined": counters["joined"],
            "already_had_ticket": counters["already_had_ticket"],
            "failed": failed,
        }

    async def _enrollment_status(session_id: str) -> dict:
        """Live-computed Joined / Pending / Failed counters for the
        teacher control panel — derived entirely from the roster,
        direct-join, legacy-entry, and audit collections. No separate
        mutable status field to drift from reality."""
        sess = await SL_SESSIONS.find_one({"session_id": session_id})
        if not sess:
            raise DirectJoinError("session_not_found", http_status=404)

        roster = await _eligible_roster(sess)
        roster_ids = {e["student_id"] for e in roster}
        if not roster_ids:
            return {"ok": True, "session_id": session_id, "roster_size": 0,
                    "joined": 0, "pending": 0, "failed": 0, "failed_detail": []}

        joined_ids: set[str] = set()
        cur = db[COLLECTION_DIRECT_JOINS].find(
            {"session_id": session_id, "status": "committed",
             "student_id": {"$in": list(roster_ids)}},
            {"_id": 0, "student_id": 1},
        )
        async for row in cur:
            joined_ids.add(row["student_id"])

        remaining = roster_ids - joined_ids
        if remaining:
            cur2 = SL_ENTRIES.find(
                {"session_id": session_id, "paid_entry": True,
                 "student_id": {"$in": list(remaining)}},
                {"_id": 0, "student_id": 1},
            )
            async for row in cur2:
                joined_ids.add(row["student_id"])
            remaining = roster_ids - joined_ids

        failed_detail: list[dict] = []
        if remaining:
            latest_reason: dict[str, str] = {}
            cur3 = db[enroll_audit.COLLECTION_ENROLLMENT_AUDIT].find(
                {"session_id": session_id, "student_id": {"$in": list(remaining)}},
                {"_id": 0, "student_id": 1, "reason_code": 1, "ts": 1},
            ).sort("ts", 1)
            async for row in cur3:
                latest_reason[row["student_id"]] = row.get("reason_code") or "unknown"
            failed_detail = [
                {"student_id": sid, "reason": reason}
                for sid, reason in latest_reason.items()
            ]
        attempted_ids = {d["student_id"] for d in failed_detail}
        pending_count = len(remaining) - len(attempted_ids)

        return {
            "ok": True, "session_id": session_id,
            "roster_size": len(roster_ids),
            "joined": len(joined_ids),
            "pending": pending_count,
            "failed": len(attempted_ids),
            "failed_detail": failed_detail,
        }

    if require_admin_dep is not None:
        @api.post(
            "/speaking-lab/sessions/{session_id}/enroll-all",
            response_model=EnrollAllResponse,
            summary="Teacher: enroll every eligible student on the roster at once (DARK)",
        )
        async def enroll_all_route(
            session_id: str,
            _admin=Depends(require_admin_dep),
        ) -> EnrollAllResponse:
            try:
                summary = await enroll_all_eligible(session_id)
            except DirectJoinError as exc:
                raise HTTPException(
                    status_code=exc.http_status,
                    detail={"error": exc.code, "message": exc.message},
                ) from exc
            return EnrollAllResponse(**summary)

        @api.get(
            "/speaking-lab/sessions/{session_id}/enrollment-status",
            response_model=EnrollmentStatusResponse,
            summary="Teacher control panel: Joined / Pending / Failed counters",
        )
        async def enrollment_status_route(
            session_id: str,
            _admin=Depends(require_admin_dep),
        ) -> EnrollmentStatusResponse:
            try:
                summary = await _enrollment_status(session_id)
            except DirectJoinError as exc:
                raise HTTPException(
                    status_code=exc.http_status,
                    detail={"error": exc.code, "message": exc.message},
                ) from exc
            return EnrollmentStatusResponse(**summary)

    @api.post(
        "/speaking-lab/sessions/{session_or_code}/direct-join",
        response_model=DirectJoinResponse,
        summary="Direct Join — authenticated, atomic Prize Pool entry (DARK)",
    )
    async def direct_join(
        session_or_code: str,
        body: DirectJoinRequest,
        student=Depends(require_student_dep),
    ) -> DirectJoinResponse:
        if not await flags.direct_join_enabled(db):
            raise HTTPException(
                status_code=503,
                detail={"error": "direct_join_disabled",
                        "message": "Direct Join is not enabled yet."},
            )
        canonical_student_id = norm_student_id(
            getattr(student, "clean_id", None) or getattr(student, "student_id", None)
        )
        if not canonical_student_id:
            raise HTTPException(status_code=401, detail="student identity required")
        display_name = getattr(student, "display_name", None) or canonical_student_id
        session_id = _resolve_session_id(session_or_code)
        if not session_id:
            raise HTTPException(status_code=404, detail="Session not found")
        return await _perform_join(
            session_id, canonical_student_id, display_name, body.idempotency_key)

    @api.get(
        "/speaking-lab/active-session",
        response_model=ActiveSessionResponse,
        summary="One-tap driver: is there a live session for me right now? (read-only)",
    )
    async def active_session(
        student=Depends(require_student_dep),
    ) -> ActiveSessionResponse:
        canonical_student_id = norm_student_id(
            getattr(student, "clean_id", None) or getattr(student, "student_id", None)
        )
        if not canonical_student_id:
            raise HTTPException(status_code=401, detail="student identity required")

        dj_enabled = await flags.direct_join_enabled(db)
        sess = await _resolve_active_session(canonical_student_id)
        if not sess:
            return ActiveSessionResponse(active=False, direct_join_enabled=dj_enabled)

        session_id = sess["session_id"]
        # Surface the student's OWN existing ticket if they already joined
        # (direct-join record first, then a legacy-paid entry) — never
        # another student's.
        existing: Optional[JoinPreviewExistingEntry] = None
        join = await db[COLLECTION_DIRECT_JOINS].find_one(
            {"session_id": session_id, "student_id": canonical_student_id,
             "status": "committed"},
            {"_id": 0, "lucky_code": 1},
        )
        if join and join.get("lucky_code"):
            existing = JoinPreviewExistingEntry(lucky_code=join["lucky_code"])
        else:
            legacy_entry = await SL_ENTRIES.find_one(
                {"session_id": session_id, "student_id": canonical_student_id,
                 "paid_entry": True},
                {"_id": 0},
            )
            code_doc = await db[COLLECTION_CODES].find_one(
                {"session_id": session_id, "student_id": canonical_student_id},
                {"_id": 0},
            )
            if legacy_entry and code_doc and code_doc.get("code"):
                existing = JoinPreviewExistingEntry(lucky_code=code_doc["code"])

        snap = await _pool_snapshot(db, session_id)
        return ActiveSessionResponse(
            active=True,
            session_id=session_id,
            schedule=(sess.get("schedule") or ""),
            entry_fee=int(sess.get("entry_fee") or 0),
            pool_total=snap["pool_total"],
            player_count=snap["player_count"],
            direct_join_enabled=dj_enabled,
            existing_entry=existing,
        )

    @api.post(
        "/speaking-lab/join-active",
        response_model=DirectJoinResponse,
        summary="One-tap join — server resolves the live session, then atomic entry (DARK)",
    )
    async def join_active(
        body: DirectJoinRequest,
        student=Depends(require_student_dep),
    ) -> DirectJoinResponse:
        if not await flags.direct_join_enabled(db):
            raise HTTPException(
                status_code=503,
                detail={"error": "direct_join_disabled",
                        "message": "Direct Join is not enabled yet."},
            )
        canonical_student_id = norm_student_id(
            getattr(student, "clean_id", None) or getattr(student, "student_id", None)
        )
        if not canonical_student_id:
            raise HTTPException(status_code=401, detail="student identity required")
        display_name = getattr(student, "display_name", None) or canonical_student_id

        sess = await _resolve_active_session(canonical_student_id)
        if not sess:
            raise HTTPException(
                status_code=404,
                detail={"error": "no_active_session",
                        "message": "There's no live Speaking Lab session right now."},
            )
        # Identical atomic enrollment as the code-based route — same
        # exactly-once, idempotent, audited guarantees.
        return await _perform_join(
            sess["session_id"], canonical_student_id, display_name, body.idempotency_key)

    @api.get(
        "/speaking-lab/sessions/{session_or_code}/my-entry",
        response_model=MyEntryResponse,
        summary="Persistent, authenticated retrieval of the student's own entry/code",
    )
    async def my_entry(
        session_or_code: str,
        student=Depends(require_student_dep),
    ) -> MyEntryResponse:
        canonical_student_id = norm_student_id(
            getattr(student, "clean_id", None) or getattr(student, "student_id", None)
        )
        if not canonical_student_id:
            raise HTTPException(status_code=401, detail="student identity required")
        session_id = _resolve_session_id(session_or_code)

        join = await db[COLLECTION_DIRECT_JOINS].find_one(
            {"session_id": session_id, "student_id": canonical_student_id,
             "status": "committed"},
            {"_id": 0},
        )
        if join:
            snap = await _pool_snapshot(db, session_id)
            entry = await SL_ENTRIES.find_one(
                {"session_id": session_id, "student_id": canonical_student_id},
                {"_id": 0, "position": 1},
            )
            return MyEntryResponse(
                found=True, session_id=session_id,
                lucky_code=join["lucky_code"],
                position=int((entry or {}).get("position") or 0),
                entry_fee=int(join.get("entry_fee") or 0),
                pool_total=snap["pool_total"], player_count=snap["player_count"],
                source="direct_join",
            )

        # Fall back to a legacy-paid canonical entry (never a synthetic /
        # unauthenticated roster row — that is never proof of payment).
        entry = await SL_ENTRIES.find_one(
            {"session_id": session_id, "student_id": canonical_student_id,
             "paid_entry": True},
            {"_id": 0},
        )
        code_doc = await db[COLLECTION_CODES].find_one(
            {"session_id": session_id, "student_id": canonical_student_id},
            {"_id": 0},
        )
        if entry and code_doc:
            snap = await _pool_snapshot(db, session_id)
            return MyEntryResponse(
                found=True, session_id=session_id, lucky_code=code_doc["code"],
                position=int(entry.get("position") or 0),
                entry_fee=int(code_doc.get("entry_fee") or 0),
                pool_total=snap["pool_total"], player_count=snap["player_count"],
                source="legacy",
            )

        return MyEntryResponse(found=False, session_id=session_id)

    @api.get(
        "/speaking-lab/sessions/{session_or_code}/join-preview",
        response_model=JoinPreviewResponse,
        summary="Read-only session preview before a student joins (DARK, no mutation)",
    )
    async def join_preview(
        session_or_code: str,
        student=Depends(require_student_dep),
    ) -> JoinPreviewResponse:
        canonical_student_id = norm_student_id(
            getattr(student, "clean_id", None) or getattr(student, "student_id", None)
        )
        if not canonical_student_id:
            raise HTTPException(status_code=401, detail="student identity required")
        session_id = _resolve_session_id(session_or_code)
        if not session_id:
            raise HTTPException(
                status_code=404,
                detail={"error": "session_not_found",
                        "message": "We couldn't find that session. Check the code with your teacher."},
            )

        sess = await SL_SESSIONS.find_one({"session_id": session_id}, {"_id": 0})
        if not sess:
            raise HTTPException(
                status_code=404,
                detail={"error": "session_not_found",
                        "message": "We couldn't find that session. Check the code with your teacher."},
            )

        # Same rules _direct_join_txn_body uses to decide join eligibility —
        # a preview must never claim "open" for a session that would 409
        # the instant the student actually tapped Join.
        raw_status = (sess.get("status") or "").strip().lower()
        if _draw_locked(sess) or raw_status not in ALLOWED_SESSION_STATES:
            preview_status = "closed"
        else:
            preview_status = raw_status

        snap = await _pool_snapshot(db, session_id)

        existing_entry: Optional[JoinPreviewExistingEntry] = None
        join = await db[COLLECTION_DIRECT_JOINS].find_one(
            {"session_id": session_id, "student_id": canonical_student_id,
             "status": "committed"},
            {"_id": 0, "lucky_code": 1},
        )
        if join and join.get("lucky_code"):
            existing_entry = JoinPreviewExistingEntry(lucky_code=join["lucky_code"])
        else:
            legacy_entry = await SL_ENTRIES.find_one(
                {"session_id": session_id, "student_id": canonical_student_id,
                 "paid_entry": True},
                {"_id": 0},
            )
            code_doc = await db[COLLECTION_CODES].find_one(
                {"session_id": session_id, "student_id": canonical_student_id},
                {"_id": 0},
            )
            if legacy_entry and code_doc and code_doc.get("code"):
                existing_entry = JoinPreviewExistingEntry(lucky_code=code_doc["code"])

        return JoinPreviewResponse(
            session_id=session_id,
            session_code=session_id,
            schedule=(sess.get("schedule") or ""),
            status=preview_status,
            entry_fee=int(sess.get("entry_fee") or 0),
            pool_total=snap["pool_total"],
            player_count=snap["player_count"],
            direct_join_enabled=await flags.direct_join_enabled(db),
            existing_entry=existing_entry,
        )

    return {
        "enroll_all_eligible": enroll_all_eligible,
        "enrollment_status": _enrollment_status,
        # Exposed for speaking_lab_eligibility.py (V4 attendance-assisted
        # enrollment) to reuse UNCHANGED — never a second roster/enrollment
        # implementation.
        "eligible_roster": _eligible_roster,
        "perform_join": _perform_join,
    }
