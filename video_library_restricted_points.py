"""video_library_restricted_points.py — a genuinely separate, Video-Library-
only spendable points balance.

WHY THIS IS ITS OWN MODULE AND COLLECTION, NOT AN ADDITION TO wallet_service.py
(verified against current code before writing a line of this, per this
round's explicit "do not guess, re-verify every prior-round lead" rule):

  - The prior-round lead assumed Video Library coupon points are credited
    into "the SAME shared GAS points wallet (wallet_service.py)". Reading
    both files directly shows this conflates two different systems:
    `video_library_coupon_tools.py` credits points via a raw GAS
    `sendPoints` HTTP call (`_credit_video_library_points`), never via
    `wallet_service.py` at all. `wallet_service.py` is explicitly a DORMANT
    "Phase 1 Preflight" migration layer — its own module docstring states
    "This module is never activated by Phase 1 itself... No live behavior
    changes unless an explicit phase flag is enabled." Its `points_wallets`
    collection exists to MIRROR the real GAS balance 1:1 for a future
    migration (`balance_audit_one()` compares the two and expects them to
    match) — injecting a semantically different "restricted, video-library-
    only" sub-balance into that collection would corrupt that migration's
    own correctness invariant, not extend it.
  - `video_library_points_adapter.py`'s own docstring independently
    confirms the same fact: "GAS remains the authoritative POINTS BALANCE
    store for the whole platform today."
  - GAS itself has exactly one points number per student — there is no way
    to represent a "restricted" sub-balance inside the legacy Sheets
    backend at all. A restricted balance is therefore a BRAND NEW financial
    concept with no GAS analog, so it is Mongo-native from day one, in its
    own collections, completely decoupled from both the live GAS balance
    and wallet_service.py's dormant GAS-mirror collections. This satisfies
    the "strictly additive, existing credit()/debit() semantics never
    touched" rule about as literally as possible: this module doesn't
    import wallet_service.py, doesn't touch its collections, and no
    existing call site anywhere in the app needs to know this module
    exists.

DESIGN (mirrors wallet_service.py's own proven conventions — idempotency
keys, an append-only transaction ledger, a real post-update balance never a
stale projection — per the explicit "use your own judgment... given this
codebase's existing wallet-service conventions" instruction, without
literally reusing its collections):

  - `video_library_restricted_wallets`: one document per student,
    `{student_id, balance, created_at, updated_at}`.
  - `video_library_restricted_transactions`: append-only ledger,
    `{student_id, operation, amount, delta, balance_after, source,
    source_ref, idempotency_key, payload, created_at}` — a unique sparse
    index on `idempotency_key` makes a replayed credit/debit a safe no-op,
    identical in spirit to wallet_service.py's own guarantee.
  - Every mutation is a single atomic `find_one_and_update` against ONE
    document (no multi-document transaction needed — there is no two-sided
    transfer here, only single-wallet credit/debit), with the debit guard
    (`balance >= amount`) enforced INSIDE the Mongo filter so a concurrent
    spend can never race past it and go negative.

SCOPE: this balance is Video-Library-wide, not tied to any single lesson —
so a lesson being deleted/unpublished after a student holds restricted
points never strands them; they remain spendable on any other purchasable
lesson. Expiry: verified against video_library_coupon_tools.py's existing
convention — a coupon's own `expires_at` gates whether it can still be
REDEEMED, but nothing in this codebase expires an already-credited points
balance (GAS points are permanent once credited). Restricted points inherit
that same "permanent once credited" behavior rather than inventing new
expiry semantics this codebase has no precedent for. Suspension: a
suspended/deactivated student's `is_active` flag already makes
`current_student()`/`require_student` reject them outright (server.py) —
every route that could credit or debit this balance requires
`require_student`, so a suspended account's restricted balance simply sits
frozen and unreachable, exactly like their real GAS balance already is,
with no new enforcement needed here.
"""
from __future__ import annotations

import datetime as _dt
import logging
from typing import Any, Mapping, Optional

from pymongo import ReturnDocument

log = logging.getLogger("eduhub.video_library_restricted_points")

COLL_WALLETS = "video_library_restricted_wallets"
COLL_TRANSACTIONS = "video_library_restricted_transactions"


class RestrictedPointsError(Exception):
    def __init__(self, code: str, message: str = "") -> None:
        super().__init__(message or code)
        self.code = code
        self.message = message or code


class InsufficientRestrictedFunds(RestrictedPointsError):
    def __init__(self, student_id: str, balance: int, needed: int) -> None:
        super().__init__(
            "INSUFFICIENT_RESTRICTED_FUNDS",
            f"{student_id} restricted_balance={balance} needed={needed}",
        )
        self.balance = balance
        self.needed = needed


def _utcnow() -> _dt.datetime:
    return _dt.datetime.now(_dt.timezone.utc)


def _norm_id(student_id: Any) -> str:
    s = str(student_id or "").strip().lower()
    if not s:
        raise RestrictedPointsError("INVALID_ID", "student_id required")
    return s


def _coerce_amount(amount: Any) -> int:
    """Restricted points are always whole numbers — this feature's own
    coupon validation (video_library_coupon_tools.py's `benefit_amount`)
    already only ever produces a positive int 1-1000, so a stricter,
    simpler contract than wallet_service.py's half-point allowance is
    honest here (no caller of this module has ever needed fractional
    restricted points)."""
    if isinstance(amount, bool) or not isinstance(amount, int):
        raise RestrictedPointsError("INVALID_AMOUNT", "amount must be a positive int")
    if amount <= 0:
        raise RestrictedPointsError("INVALID_AMOUNT", "amount must be > 0")
    if amount > 1_000_000:
        raise RestrictedPointsError("INVALID_AMOUNT", "amount too large")
    return amount


async def ensure_indexes(db) -> None:
    """Idempotent, safe on every startup — mirrors wallet_service.py's own
    ensure_wallet_indexes() convention."""
    await db[COLL_WALLETS].create_index("student_id", unique=True)
    await db[COLL_TRANSACTIONS].create_index("idempotency_key", unique=True, sparse=True)
    await db[COLL_TRANSACTIONS].create_index([("student_id", 1), ("created_at", -1)])


async def get_balance(db, student_id: str) -> int:
    sid = _norm_id(student_id)
    doc = await db[COLL_WALLETS].find_one({"student_id": sid}, {"_id": 0, "balance": 1})
    if not doc:
        return 0
    return int(doc.get("balance") or 0)


async def _idempotency_hit(db, key: Optional[str]) -> Optional[Mapping[str, Any]]:
    if not key:
        return None
    return await db[COLL_TRANSACTIONS].find_one({"idempotency_key": key}, {"_id": 0})


async def _record_txn(db, *, student_id: str, operation: str, amount: int, delta: int,
                       balance_after: int, source: str, source_ref: Optional[str],
                       idempotency_key: Optional[str], payload: Optional[Mapping[str, Any]]) -> None:
    await db[COLL_TRANSACTIONS].insert_one({
        "student_id": student_id,
        "operation": operation,
        "amount": amount,
        "delta": delta,
        "balance_after": balance_after,
        "source": source,
        "source_ref": source_ref,
        "idempotency_key": idempotency_key,
        "payload": dict(payload or {}),
        "created_at": _utcnow(),
    })


async def credit(db, student_id: str, amount: int, *, source: str, source_ref: Optional[str] = None,
                  idempotency_key: Optional[str] = None, payload: Optional[Mapping[str, Any]] = None) -> dict:
    """Credit restricted points — e.g. a redeemed Video Library POINTS
    coupon (§2.3). Idempotent replay-safe: a repeated call with the same
    `idempotency_key` returns the original result rather than double-
    crediting."""
    sid = _norm_id(student_id)
    amt = _coerce_amount(amount)
    hit = await _idempotency_hit(db, idempotency_key)
    if hit:
        return {"ok": True, "duplicate": True, "balance_after": int(hit.get("balance_after") or 0)}

    now = _utcnow()
    upd = await db[COLL_WALLETS].find_one_and_update(
        {"student_id": sid},
        {"$inc": {"balance": amt}, "$set": {"updated_at": now},
         "$setOnInsert": {"created_at": now}},
        upsert=True,
        return_document=ReturnDocument.AFTER,
        projection={"_id": 0, "balance": 1},
    )
    balance_after = int(upd.get("balance") or 0)
    await _record_txn(
        db, student_id=sid, operation="credit", amount=amt, delta=+amt,
        balance_after=balance_after, source=source, source_ref=source_ref,
        idempotency_key=idempotency_key, payload=payload,
    )
    return {"ok": True, "duplicate": False, "balance_after": balance_after}


async def debit(db, student_id: str, amount: int, *, source: str, source_ref: Optional[str] = None,
                 idempotency_key: Optional[str] = None, payload: Optional[Mapping[str, Any]] = None) -> dict:
    """Debit restricted points. Raises InsufficientRestrictedFunds if the
    balance is too low — the balance guard lives INSIDE the atomic Mongo
    filter (`$gte`) so a concurrent debit can never race past it and drive
    the balance negative, matching wallet_service.py's own guard-in-filter
    discipline."""
    sid = _norm_id(student_id)
    amt = _coerce_amount(amount)
    hit = await _idempotency_hit(db, idempotency_key)
    if hit:
        return {"ok": True, "duplicate": True, "balance_after": int(hit.get("balance_after") or 0)}

    now = _utcnow()
    upd = await db[COLL_WALLETS].find_one_and_update(
        {"student_id": sid, "balance": {"$gte": amt}},
        {"$inc": {"balance": -amt}, "$set": {"updated_at": now}},
        return_document=ReturnDocument.AFTER,
        projection={"_id": 0, "balance": 1},
    )
    if not upd:
        current = await get_balance(db, sid)
        raise InsufficientRestrictedFunds(sid, current, amt)
    balance_after = int(upd.get("balance") or 0)
    await _record_txn(
        db, student_id=sid, operation="debit", amount=amt, delta=-amt,
        balance_after=balance_after, source=source, source_ref=source_ref,
        idempotency_key=idempotency_key, payload=payload,
    )
    return {"ok": True, "duplicate": False, "balance_after": balance_after}


async def history(db, student_id: str, *, limit: int = 50) -> list[Mapping[str, Any]]:
    sid = _norm_id(student_id)
    limit = max(1, min(int(limit or 50), 500))
    cur = db[COLL_TRANSACTIONS].find({"student_id": sid}, {"_id": 0}).sort("created_at", -1).limit(limit)
    return [doc async for doc in cur]
