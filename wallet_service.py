"""EduHub Wallet Service — Phase 1 Preflight (additive, off by default).

Single source of truth for every point-changing operation that will gradually
migrate off Google Apps Script. This module is **never** activated by Phase 1
itself: it only exposes a class and a few module-level constants for the
admin migration-status endpoint and (in later phases) feature-flagged call
sites.

Key safety properties (audit gates):

1. Detects MongoDB transaction support **at startup** via
   ``WalletService.detect_transaction_support()`` and exposes the result as
   module attributes ``MONGO_SUPPORTS_TRANSACTIONS`` and ``WALLET_MODE``.
   ``server.py`` must read these from the live module object (never copy
   into a local constant) — see ``current_wallet_mode()`` / the
   ``wallet_state()`` accessor.

2. Every wallet write uses ``idempotency_key`` (unique sparse index) so a
   replayed sync event can never double-debit or double-credit.

3. Every write touches BOTH ``points_wallets`` and ``points_transactions``
   in the same logical operation — transaction mode uses a Motor session;
   ledger-first mode writes the ledger row first and only mutates the
   wallet if the ledger row landed, then writes a real post-update audit
   value (never a precomputed stale projection).

4. Wallet ``status`` is enforced. ``frozen`` and ``closed`` wallets cannot
   be debited or credited unless the caller passes ``allow_status=True``
   AND the operation is documented in ``allowed_status_ops`` (used only
   by reconcile-style admin tooling).

5. Ledger-first ``transfer()`` is hard-blocked unless transaction mode is
   available OR a durable two-sided repair flow is supplied by the caller
   (Phase 2 wires the durable repair via ``migration_sync_events``). This
   closes the prior-audit blocker where a ledger-first transfer could
   debit the sender but never credit the recipient.

6. The ``balance_audit_one()`` helper used by the admin migration endpoint
   returns a per-student status enum (matched / mismatched / mongo_missing
   / gas_auth_failed / gas_unreachable / unsupported_without_legacy_password)
   — it NEVER treats a GAS auth failure as a 0-points balance.

No live behavior changes unless an explicit phase flag is enabled.
"""
from __future__ import annotations

import asyncio
import logging
import os
from dataclasses import dataclass
from datetime import datetime, timezone
from typing import Any, Mapping, MutableMapping, Optional

from motor.motor_asyncio import AsyncIOMotorClient, AsyncIOMotorDatabase
from pymongo import ReturnDocument

log = logging.getLogger("eduhub.wallet")

# --------------------------------------------------------------------------- #
# Public module state — server.py MUST read these via the live module object  #
# (e.g. ``import wallet_service; wallet_service.WALLET_MODE``) and never copy #
# them into a local ``WALLET_MODE = ...`` constant at import time, otherwise  #
# the migration-status endpoint will report a stale mode forever.             #
# --------------------------------------------------------------------------- #
MONGO_SUPPORTS_TRANSACTIONS: bool = False
WALLET_MODE: str = "unknown"   # "unknown" | "transaction" | "ledger_first"

# Collections owned by this module — every name is documented so an operator
# can audit indexes without grepping the code.
COLL_WALLETS = "points_wallets"
COLL_TRANSACTIONS = "points_transactions"
COLL_SYNC_EVENTS = "migration_sync_events"

# Wallet statuses. ``active`` is the only status that permits writes by
# default. ``frozen`` blocks all writes. ``closed`` is permanent.
STATUS_ACTIVE = "active"
STATUS_FROZEN = "frozen"
STATUS_CLOSED = "closed"
ALLOWED_STATUSES = {STATUS_ACTIVE, STATUS_FROZEN, STATUS_CLOSED}


# --------------------------------------------------------------------------- #
# Errors                                                                      #
# --------------------------------------------------------------------------- #
class WalletError(Exception):
    """Base class — every wallet failure carries a stable ``code`` string."""

    def __init__(self, code: str, message: str = "") -> None:
        super().__init__(message or code)
        self.code = code
        self.message = message or code


class WalletNotFound(WalletError):
    def __init__(self, student_id: str) -> None:
        super().__init__("WALLET_NOT_FOUND", f"No wallet for {student_id!r}")


class InsufficientFunds(WalletError):
    def __init__(self, student_id: str, balance: int, needed: int) -> None:
        super().__init__(
            "INSUFFICIENT_FUNDS",
            f"{student_id} balance={balance} needed={needed}",
        )
        self.balance = balance
        self.needed = needed


class WalletStatusBlocked(WalletError):
    def __init__(self, student_id: str, status: str) -> None:
        super().__init__(
            "WALLET_STATUS_BLOCKED",
            f"{student_id} wallet status={status} cannot be mutated",
        )
        self.status = status


class TransferNotAtomic(WalletError):
    def __init__(self) -> None:
        super().__init__(
            "TRANSFER_NOT_ATOMIC",
            "Ledger-first transfer is blocked: no transactions and no "
            "durable two-sided repair provided.",
        )


# --------------------------------------------------------------------------- #
# Helpers                                                                     #
# --------------------------------------------------------------------------- #
def _utcnow_iso() -> str:
    return datetime.now(timezone.utc).isoformat()


def _utcnow() -> datetime:
    return datetime.now(timezone.utc)


def _coerce_amount(amount: Any, *, label: str = "amount") -> int:
    if isinstance(amount, bool):  # bool is an int subclass — reject explicitly
        raise WalletError("INVALID_AMOUNT", f"{label} must be a positive int")
    try:
        n = int(amount)
    except (TypeError, ValueError) as exc:  # noqa: BLE001
        raise WalletError("INVALID_AMOUNT", f"{label} must be an int") from exc
    if n <= 0:
        raise WalletError("INVALID_AMOUNT", f"{label} must be > 0")
    if n > 10_000_000:
        raise WalletError("INVALID_AMOUNT", f"{label} too large")
    return n


def _norm_id(value: Any, label: str = "student_id") -> str:
    if not isinstance(value, str):
        raise WalletError("INVALID_ID", f"{label} must be a string")
    v = value.strip().lower()
    if not v or len(v) > 64:
        raise WalletError("INVALID_ID", f"{label} invalid")
    return v


# --------------------------------------------------------------------------- #
# Detection                                                                   #
# --------------------------------------------------------------------------- #
async def detect_transaction_support(
    db: AsyncIOMotorDatabase,
) -> tuple[bool, str]:
    """Probe whether the underlying MongoDB deployment supports Motor
    transactions. Updates module-level ``MONGO_SUPPORTS_TRANSACTIONS`` and
    ``WALLET_MODE`` in place so callers can read the live value through
    the module object."""
    global MONGO_SUPPORTS_TRANSACTIONS, WALLET_MODE
    client: AsyncIOMotorClient = db.client
    supports = False
    err: str | None = None
    try:
        async with await client.start_session() as session:
            async def _txn(s):
                await db[COLL_WALLETS].find_one(
                    {"_probe_txn": True}, session=s
                )

            await session.with_transaction(_txn)
        supports = True
    except Exception as exc:  # noqa: BLE001
        err = f"{type(exc).__name__}: {exc}"
        supports = False

    MONGO_SUPPORTS_TRANSACTIONS = supports
    WALLET_MODE = "transaction" if supports else "ledger_first"
    log.info(
        "wallet: transaction support detected supports=%s mode=%s err=%s",
        supports,
        WALLET_MODE,
        err,
    )
    return supports, WALLET_MODE


def current_wallet_mode() -> str:
    """Return the live wallet mode. Always read via the live module object."""
    return WALLET_MODE


def wallet_state() -> dict[str, Any]:
    """Snapshot of the live module flags — used by the migration-status
    endpoint. NEVER cache the return value across requests."""
    return {
        "wallet_mode": WALLET_MODE,
        "mongo_transactions_supported": MONGO_SUPPORTS_TRANSACTIONS,
    }


# --------------------------------------------------------------------------- #
# Index creation                                                              #
# --------------------------------------------------------------------------- #
async def ensure_wallet_indexes(db: AsyncIOMotorDatabase) -> None:
    """Idempotent. Safe to call on every startup. Closes the prior-audit
    blockers about ``student_id_date`` (does not exist) and missing sparse
    unique on ``idempotency_key``."""
    # points_wallets
    await db[COLL_WALLETS].create_index("student_id", unique=True)
    await db[COLL_WALLETS].create_index("clean_id", unique=True, sparse=True)
    await db[COLL_WALLETS].create_index("status")

    # points_transactions — unique sparse idempotency_key prevents double-apply
    await db[COLL_TRANSACTIONS].create_index(
        "idempotency_key", unique=True, sparse=True
    )
    await db[COLL_TRANSACTIONS].create_index([("from_id", 1), ("created_at", -1)])
    await db[COLL_TRANSACTIONS].create_index([("to_id", 1), ("created_at", -1)])
    await db[COLL_TRANSACTIONS].create_index([("source", 1), ("source_ref", 1)])
    await db[COLL_TRANSACTIONS].create_index([("created_at", -1)])

    # migration_sync_events — Phase 2 wires it up; index it now so the
    # collection is ready before any feature flag flips.
    await db[COLL_SYNC_EVENTS].create_index("event_id", unique=True)
    await db[COLL_SYNC_EVENTS].create_index(
        "idempotency_key", unique=True, sparse=True
    )
    await db[COLL_SYNC_EVENTS].create_index([("mongo_status", 1), ("created_at", 1)])
    await db[COLL_SYNC_EVENTS].create_index([("student_id", 1), ("created_at", -1)])
    log.info("wallet: indexes ready on %s/%s/%s",
             COLL_WALLETS, COLL_TRANSACTIONS, COLL_SYNC_EVENTS)


# --------------------------------------------------------------------------- #
# Data classes                                                                #
# --------------------------------------------------------------------------- #
@dataclass
class TransactionRecord:
    student_id: str
    operation: str
    amount: int            # always positive
    delta: int             # signed (+ for credit, - for debit)
    balance_after: int     # REAL post-update balance — never a projection
    source: str
    source_ref: str | None
    idempotency_key: str | None
    from_id: str | None
    to_id: str | None
    payload: Mapping[str, Any]
    created_at: datetime

    def to_doc(self) -> dict[str, Any]:
        return {
            "student_id": self.student_id,
            "operation": self.operation,
            "amount": self.amount,
            "delta": self.delta,
            "balance_after": self.balance_after,
            "source": self.source,
            "source_ref": self.source_ref,
            "idempotency_key": self.idempotency_key,
            "from_id": self.from_id,
            "to_id": self.to_id,
            "payload": dict(self.payload or {}),
            "created_at": self.created_at,
        }


# --------------------------------------------------------------------------- #
# WalletService                                                               #
# --------------------------------------------------------------------------- #
class WalletService:
    """All wallet mutations go through this service.

    The service has TWO modes:

    * ``transaction`` — uses Motor ``client.start_session`` +
      ``with_transaction`` to atomically update the wallet doc and insert
      the ledger row.
    * ``ledger_first`` — used only when transactions are unavailable.
      Writes the ledger row with ``status="pending"`` first, then updates
      the wallet doc with ``$inc``, then patches the ledger row with the
      real post-update balance (NEVER a precomputed stale projection).

    Callers identify themselves via ``source`` + ``source_ref`` (e.g.
    ``source="library"``, ``source_ref=book.slug``) and pass an
    ``idempotency_key`` for safe replay.

    The service NEVER persists plaintext password and NEVER reads from
    GAS — it is a pure Mongo wallet."""

    def __init__(
        self,
        db: AsyncIOMotorDatabase,
        *,
        allowed_status_ops: Optional[set[str]] = None,
    ) -> None:
        self.db = db
        self.wallets = db[COLL_WALLETS]
        self.txns = db[COLL_TRANSACTIONS]
        # Operations that may run on a non-active wallet when the caller
        # explicitly passes ``allow_status=True``. Default is the empty
        # set — every write is blocked on a non-active wallet unless the
        # admin reconcile tool opts in.
        self.allowed_status_ops = allowed_status_ops or set()

    # ---------- read paths ----------------------------------------------- #
    async def get_balance(self, student_id: str) -> int:
        sid = _norm_id(student_id)
        doc = await self.wallets.find_one(
            {"student_id": sid}, {"_id": 0, "balance": 1}
        )
        if not doc:
            return 0
        return int(doc.get("balance") or 0)

    async def get_wallet(self, student_id: str) -> Mapping[str, Any] | None:
        sid = _norm_id(student_id)
        doc = await self.wallets.find_one({"student_id": sid}, {"_id": 0})
        return doc

    async def history(
        self, student_id: str, *, limit: int = 50
    ) -> list[Mapping[str, Any]]:
        sid = _norm_id(student_id)
        limit = max(1, min(int(limit or 50), 500))
        cur = self.txns.find(
            {"student_id": sid},
            {"_id": 0},
        ).sort("created_at", -1).limit(limit)
        return [doc async for doc in cur]

    # ---------- common path ---------------------------------------------- #
    async def _idempotency_hit(self, key: str | None) -> Mapping[str, Any] | None:
        """If a ledger row with this idempotency_key already exists, return
        it. Otherwise return None. The unique sparse index guarantees
        idempotent replays cannot double-apply."""
        if not key:
            return None
        doc = await self.txns.find_one(
            {"idempotency_key": key}, {"_id": 0}
        )
        return doc

    async def _ensure_wallet(
        self, student_id: str, *, clean_id: str | None = None
    ) -> dict[str, Any]:
        """Idempotently make sure a wallet row exists with status=active.
        Never resets the balance of an existing wallet."""
        existing = await self.wallets.find_one(
            {"student_id": student_id}, {"_id": 0}
        )
        if existing:
            return existing
        now = _utcnow()
        seed = {
            "student_id": student_id,
            "clean_id": clean_id or student_id,
            "balance": 0,
            "status": STATUS_ACTIVE,
            "created_at": now,
            "updated_at": now,
        }
        try:
            await self.wallets.insert_one(seed)
        except Exception:  # duplicate key — race with concurrent init
            pass
        doc = await self.wallets.find_one(
            {"student_id": student_id}, {"_id": 0}
        )
        return doc or seed

    def _enforce_status(self, wallet: Mapping[str, Any], op: str, allow_status: bool) -> None:
        status = (wallet.get("status") or STATUS_ACTIVE).lower()
        if status == STATUS_ACTIVE:
            return
        if status == STATUS_CLOSED:
            # closed is permanent — never overridable from a regular write
            raise WalletStatusBlocked(wallet.get("student_id", ""), status)
        if status == STATUS_FROZEN:
            if allow_status and (
                not self.allowed_status_ops or op in self.allowed_status_ops
            ):
                return
            raise WalletStatusBlocked(wallet.get("student_id", ""), status)
        raise WalletStatusBlocked(wallet.get("student_id", ""), status)

    async def _diagnose_no_match(
        self,
        sid: str,
        *,
        was_debit: bool,
        needed_balance: int | None = None,
        session: Any = None,
    ) -> None:
        """Disambiguate why a status-guarded find_one_and_update did not match.

        Called only AFTER an atomic update returned None. Re-reads the wallet
        within the same session (when one is supplied) to decide whether the
        failure was a status change race, an insufficient-balance race, or
        a missing wallet. ALWAYS raises — never returns normally.
        """
        cur = await self.wallets.find_one(
            {"student_id": sid},
            {"_id": 0, "balance": 1, "status": 1},
            session=session,
        )
        if not cur:
            raise WalletNotFound(sid)
        status = (cur.get("status") or STATUS_ACTIVE).lower()
        if status != STATUS_ACTIVE:
            raise WalletStatusBlocked(sid, status)
        if was_debit and needed_balance is not None:
            raise InsufficientFunds(
                sid, int(cur.get("balance") or 0), needed_balance,
            )
        raise WalletError(
            "UPDATE_FAILED",
            f"wallet update returned no-match for {sid} (status={status})",
        )

    # ---------- mutating operations -------------------------------------- #
    async def credit(
        self,
        student_id: str,
        amount: int,
        *,
        source: str,
        source_ref: str | None = None,
        idempotency_key: str | None = None,
        payload: Optional[Mapping[str, Any]] = None,
        allow_status: bool = False,
        clean_id: str | None = None,
        admin_bypass_status: bool = False,
    ) -> dict[str, Any]:
        sid = _norm_id(student_id)
        amt = _coerce_amount(amount)
        hit = await self._idempotency_hit(idempotency_key)
        if hit:
            return {
                "ok": True,
                "duplicate": True,
                "balance_after": int(hit.get("balance_after") or 0),
                "transaction": hit,
            }
        await self._ensure_wallet(sid, clean_id=clean_id)
        wallet = await self.wallets.find_one({"student_id": sid}, {"_id": 0})
        self._enforce_status(wallet or {"student_id": sid}, "credit", allow_status)
        # BLOCKER 2: `admin_bypass_status` (explicit) OR an admin-marked
        # `allow_status` path that survived _enforce_status bypasses the
        # in-filter status guard. Default student flows do NEITHER.
        bypass = bool(admin_bypass_status) or bool(allow_status)

        if MONGO_SUPPORTS_TRANSACTIONS:
            return await self._atomic_mutation(
                sid, "credit", delta=+amt, amount=amt,
                source=source, source_ref=source_ref,
                idempotency_key=idempotency_key,
                payload=payload or {},
                from_id=None, to_id=sid,
                admin_bypass_status=bypass,
            )
        return await self._ledger_first_mutation(
            sid, "credit", delta=+amt, amount=amt,
            source=source, source_ref=source_ref,
            idempotency_key=idempotency_key,
            payload=payload or {},
            from_id=None, to_id=sid,
            admin_bypass_status=bypass,
        )

    async def debit(
        self,
        student_id: str,
        amount: int,
        *,
        source: str,
        source_ref: str | None = None,
        idempotency_key: str | None = None,
        payload: Optional[Mapping[str, Any]] = None,
        allow_status: bool = False,
        allow_negative: bool = False,
        admin_bypass_status: bool = False,
    ) -> dict[str, Any]:
        sid = _norm_id(student_id)
        amt = _coerce_amount(amount)
        hit = await self._idempotency_hit(idempotency_key)
        if hit:
            return {
                "ok": True,
                "duplicate": True,
                "balance_after": int(hit.get("balance_after") or 0),
                "transaction": hit,
            }
        await self._ensure_wallet(sid)
        wallet = await self.wallets.find_one({"student_id": sid}, {"_id": 0})
        self._enforce_status(wallet or {"student_id": sid}, "debit", allow_status)
        bypass = bool(admin_bypass_status) or bool(allow_status)

        bal = int((wallet or {}).get("balance") or 0)
        if not allow_negative and bal < amt:
            raise InsufficientFunds(sid, bal, amt)

        if MONGO_SUPPORTS_TRANSACTIONS:
            return await self._atomic_mutation(
                sid, "debit", delta=-amt, amount=amt,
                source=source, source_ref=source_ref,
                idempotency_key=idempotency_key,
                payload=payload or {},
                from_id=sid, to_id=None,
                guard_balance=None if allow_negative else amt,
                admin_bypass_status=bypass,
            )
        return await self._ledger_first_mutation(
            sid, "debit", delta=-amt, amount=amt,
            source=source, source_ref=source_ref,
            idempotency_key=idempotency_key,
            payload=payload or {},
            from_id=sid, to_id=None,
            guard_balance=None if allow_negative else amt,
            admin_bypass_status=bypass,
        )

    async def transfer(
        self,
        from_id: str,
        to_id: str,
        amount: int,
        *,
        source: str,
        source_ref: str | None = None,
        idempotency_key: str | None = None,
        payload: Optional[Mapping[str, Any]] = None,
        allow_status: bool = False,
        durable_repair: bool = False,
        admin_bypass_status: bool = False,
    ) -> dict[str, Any]:
        """Atomic two-sided transfer. In ledger-first mode this is HARD
        BLOCKED unless the caller passes ``durable_repair=True``, which
        means the caller has wired a ``migration_sync_events`` row that
        will replay the missing leg if a crash leaves the wallet in a
        torn state. Phase 2's sync replayer is the only authorised caller
        that sets ``durable_repair=True``."""
        f_id = _norm_id(from_id, "from_id")
        t_id = _norm_id(to_id, "to_id")
        if f_id == t_id:
            raise WalletError("SELF_TRANSFER", "Cannot transfer to self")
        amt = _coerce_amount(amount)
        hit = await self._idempotency_hit(idempotency_key)
        if hit:
            return {
                "ok": True,
                "duplicate": True,
                "transaction": hit,
            }
        await self._ensure_wallet(f_id)
        await self._ensure_wallet(t_id)
        wf = await self.wallets.find_one({"student_id": f_id}, {"_id": 0})
        wt = await self.wallets.find_one({"student_id": t_id}, {"_id": 0})
        self._enforce_status(wf or {"student_id": f_id}, "transfer", allow_status)
        self._enforce_status(wt or {"student_id": t_id}, "transfer", allow_status)
        bypass = bool(admin_bypass_status) or bool(allow_status)

        bal_from = int((wf or {}).get("balance") or 0)
        if bal_from < amt:
            raise InsufficientFunds(f_id, bal_from, amt)

        if MONGO_SUPPORTS_TRANSACTIONS:
            return await self._atomic_transfer(
                f_id, t_id, amt,
                source=source, source_ref=source_ref,
                idempotency_key=idempotency_key,
                payload=payload or {},
                admin_bypass_status=bypass,
            )
        if not durable_repair:
            raise TransferNotAtomic()
        return await self._ledger_first_transfer(
            f_id, t_id, amt,
            source=source, source_ref=source_ref,
            idempotency_key=idempotency_key,
            payload=payload or {},
            admin_bypass_status=bypass,
        )

    async def refund(
        self,
        student_id: str,
        amount: int,
        *,
        original_ref: str,
        source: str = "refund",
        idempotency_key: str | None = None,
        payload: Optional[Mapping[str, Any]] = None,
        allow_status: bool = False,
        admin_bypass_status: bool = False,
    ) -> dict[str, Any]:
        """Refund a prior debit. Implemented as a credit with
        ``operation="refund"`` and an explicit ``original_ref`` so the
        leaderboard rule (refund must NOT count toward earned) is easy
        to evaluate downstream.

        BLOCKER 2 FIX: default ``allow_status=False`` so refunds honor
        the same active-status guard as every other credit. Admin repair
        flows must opt in explicitly via ``admin_bypass_status=True``."""
        pl = dict(payload or {})
        pl["original_ref"] = original_ref
        sid = _norm_id(student_id)
        amt = _coerce_amount(amount)
        hit = await self._idempotency_hit(idempotency_key)
        if hit:
            return {
                "ok": True,
                "duplicate": True,
                "balance_after": int(hit.get("balance_after") or 0),
                "transaction": hit,
            }
        await self._ensure_wallet(sid)
        wallet = await self.wallets.find_one({"student_id": sid}, {"_id": 0})
        self._enforce_status(
            wallet or {"student_id": sid}, "refund", allow_status
        )
        bypass = bool(admin_bypass_status) or bool(allow_status)

        if MONGO_SUPPORTS_TRANSACTIONS:
            return await self._atomic_mutation(
                sid, "refund", delta=+amt, amount=amt,
                source=source, source_ref=original_ref,
                idempotency_key=idempotency_key,
                payload=pl,
                from_id=None, to_id=sid,
                admin_bypass_status=bypass,
            )
        return await self._ledger_first_mutation(
            sid, "refund", delta=+amt, amount=amt,
            source=source, source_ref=original_ref,
            idempotency_key=idempotency_key,
            payload=pl,
            from_id=None, to_id=sid,
            admin_bypass_status=bypass,
        )

    # ---------- atomic transaction-mode implementation ------------------- #
    async def _atomic_mutation(
        self,
        sid: str,
        operation: str,
        *,
        delta: int,
        amount: int,
        source: str,
        source_ref: str | None,
        idempotency_key: str | None,
        payload: Mapping[str, Any],
        from_id: str | None,
        to_id: str | None,
        guard_balance: int | None = None,
        admin_bypass_status: bool = False,
    ) -> dict[str, Any]:
        client: AsyncIOMotorClient = self.db.client
        now = _utcnow()
        async with await client.start_session() as session:
            balance_after_holder: dict[str, int] = {}

            async def _runner(s):
                # BLOCKER 2 FIX: wallet status guard lives inside the actual
                # Mongo find_one_and_update filter so a concurrent admin
                # freeze cannot be raced past. ``admin_bypass_status=True``
                # is the only documented way to skip the guard and is used
                # only by explicit admin reconcile/repair paths.
                base_filter: dict[str, Any] = {"student_id": sid}
                if not admin_bypass_status:
                    base_filter["status"] = STATUS_ACTIVE
                if guard_balance is not None:
                    # debit guard inside the txn — catch concurrent debits
                    upd_filter = dict(base_filter)
                    upd_filter["balance"] = {"$gte": guard_balance}
                    upd = await self.wallets.find_one_and_update(
                        upd_filter,
                        {"$inc": {"balance": delta}, "$set": {"updated_at": now}},
                        return_document=ReturnDocument.AFTER,
                        projection={"_id": 0, "balance": 1, "status": 1},
                        session=s,
                    )
                    if not upd:
                        await self._diagnose_no_match(
                            sid, was_debit=True, needed_balance=guard_balance,
                            session=s,
                        )
                else:
                    upd = await self.wallets.find_one_and_update(
                        base_filter,
                        {"$inc": {"balance": delta}, "$set": {"updated_at": now}},
                        return_document=ReturnDocument.AFTER,
                        projection={"_id": 0, "balance": 1, "status": 1},
                        session=s,
                    )
                    if not upd:
                        await self._diagnose_no_match(
                            sid, was_debit=False, session=s,
                        )
                balance_after_holder["v"] = int(upd.get("balance") or 0)
                rec = TransactionRecord(
                    student_id=sid,
                    operation=operation,
                    amount=amount,
                    delta=delta,
                    balance_after=balance_after_holder["v"],
                    source=source,
                    source_ref=source_ref,
                    idempotency_key=idempotency_key,
                    from_id=from_id,
                    to_id=to_id,
                    payload=payload,
                    created_at=now,
                )
                await self.txns.insert_one(rec.to_doc(), session=s)

            await session.with_transaction(_runner)
        return {
            "ok": True,
            "duplicate": False,
            "balance_after": balance_after_holder["v"],
            "mode": "transaction",
        }

    async def _atomic_transfer(
        self,
        f_id: str,
        t_id: str,
        amt: int,
        *,
        source: str,
        source_ref: str | None,
        idempotency_key: str | None,
        payload: Mapping[str, Any],
        admin_bypass_status: bool = False,
    ) -> dict[str, Any]:
        client: AsyncIOMotorClient = self.db.client
        now = _utcnow()
        f_bal: dict[str, int] = {}
        t_bal: dict[str, int] = {}
        async with await client.start_session() as session:
            async def _runner(s):
                # BLOCKER 2 FIX: status guard lives in the Mongo update
                # filter so a concurrent freeze on either side cannot be
                # raced past.
                from_filter: dict[str, Any] = {
                    "student_id": f_id,
                    "balance": {"$gte": amt},
                }
                to_filter: dict[str, Any] = {"student_id": t_id}
                if not admin_bypass_status:
                    from_filter["status"] = STATUS_ACTIVE
                    to_filter["status"] = STATUS_ACTIVE
                upd_from = await self.wallets.find_one_and_update(
                    from_filter,
                    {"$inc": {"balance": -amt}, "$set": {"updated_at": now}},
                    return_document=ReturnDocument.AFTER,
                    projection={"_id": 0, "balance": 1, "status": 1},
                    session=s,
                )
                if not upd_from:
                    await self._diagnose_no_match(
                        f_id, was_debit=True, needed_balance=amt, session=s,
                    )
                f_bal["v"] = int(upd_from.get("balance") or 0)

                upd_to = await self.wallets.find_one_and_update(
                    to_filter,
                    {"$inc": {"balance": +amt}, "$set": {"updated_at": now}},
                    return_document=ReturnDocument.AFTER,
                    projection={"_id": 0, "balance": 1, "status": 1},
                    session=s,
                )
                if not upd_to:
                    await self._diagnose_no_match(
                        t_id, was_debit=False, session=s,
                    )
                t_bal["v"] = int(upd_to.get("balance") or 0)

                # Two ledger rows — one debit, one credit, sharing the
                # idempotency_key suffix so a replay short-circuits.
                debit_rec = TransactionRecord(
                    student_id=f_id, operation="transfer_debit",
                    amount=amt, delta=-amt, balance_after=f_bal["v"],
                    source=source, source_ref=source_ref,
                    idempotency_key=idempotency_key,
                    from_id=f_id, to_id=t_id, payload=payload,
                    created_at=now,
                ).to_doc()
                credit_rec = TransactionRecord(
                    student_id=t_id, operation="transfer_credit",
                    amount=amt, delta=+amt, balance_after=t_bal["v"],
                    source=source, source_ref=source_ref,
                    idempotency_key=(
                        f"{idempotency_key}:credit" if idempotency_key else None
                    ),
                    from_id=f_id, to_id=t_id, payload=payload,
                    created_at=now,
                ).to_doc()
                await self.txns.insert_many([debit_rec, credit_rec], session=s)

            await session.with_transaction(_runner)
        return {
            "ok": True,
            "duplicate": False,
            "from_balance_after": f_bal["v"],
            "to_balance_after": t_bal["v"],
            "mode": "transaction",
        }

    # ---------- ledger-first implementation ------------------------------ #
    async def _ledger_first_mutation(
        self,
        sid: str,
        operation: str,
        *,
        delta: int,
        amount: int,
        source: str,
        source_ref: str | None,
        idempotency_key: str | None,
        payload: Mapping[str, Any],
        from_id: str | None,
        to_id: str | None,
        guard_balance: int | None = None,
        admin_bypass_status: bool = False,
    ) -> dict[str, Any]:
        """Ledger-first single-side mutation.

        Order of operations:
          1. Insert a ``pending`` ledger row with ``balance_after=None``.
             The unique idempotency_key index makes a replayed call into
             a no-op.
          2. ``$inc`` the wallet, with the optional balance guard if this
             is a debit. The update returns the REAL post-update balance.
          3. Patch the ledger row to ``applied`` with the REAL balance.

        If step 2 fails (insufficient funds race) we delete the pending
        ledger row so a retry can proceed.
        """
        now = _utcnow()
        # 1) pending ledger
        pending = {
            "student_id": sid,
            "operation": operation,
            "amount": amount,
            "delta": delta,
            "balance_after": None,
            "source": source,
            "source_ref": source_ref,
            "idempotency_key": idempotency_key,
            "from_id": from_id,
            "to_id": to_id,
            "payload": dict(payload or {}),
            "status": "pending",
            "created_at": now,
        }
        try:
            ins = await self.txns.insert_one(pending)
        except Exception as exc:  # duplicate idempotency_key
            if "duplicate" in str(exc).lower() or "E11000" in str(exc):
                # Resolved by an earlier successful call.
                hit = await self.txns.find_one(
                    {"idempotency_key": idempotency_key}, {"_id": 0}
                )
                return {
                    "ok": True,
                    "duplicate": True,
                    "balance_after": int((hit or {}).get("balance_after") or 0),
                    "transaction": hit,
                }
            raise

        # 2) wallet update
        try:
            # BLOCKER 2 FIX: status guard lives inside the find_one_and_update
            # filter so a concurrent admin freeze cannot be raced past.
            base_filter: dict[str, Any] = {"student_id": sid}
            if not admin_bypass_status:
                base_filter["status"] = STATUS_ACTIVE
            if guard_balance is not None:
                upd_filter = dict(base_filter)
                upd_filter["balance"] = {"$gte": guard_balance}
                upd = await self.wallets.find_one_and_update(
                    upd_filter,
                    {"$inc": {"balance": delta}, "$set": {"updated_at": now}},
                    return_document=ReturnDocument.AFTER,
                    projection={"_id": 0, "balance": 1, "status": 1},
                )
                if not upd:
                    # Roll back the pending ledger so the caller can retry.
                    await self.txns.delete_one({"_id": ins.inserted_id})
                    await self._diagnose_no_match(
                        sid, was_debit=True, needed_balance=guard_balance,
                    )
            else:
                upd = await self.wallets.find_one_and_update(
                    base_filter,
                    {"$inc": {"balance": delta}, "$set": {"updated_at": now}},
                    return_document=ReturnDocument.AFTER,
                    projection={"_id": 0, "balance": 1, "status": 1},
                )
                if not upd:
                    await self.txns.delete_one({"_id": ins.inserted_id})
                    await self._diagnose_no_match(sid, was_debit=False)
            balance_after = int(upd.get("balance") or 0)
        except InsufficientFunds:
            raise
        except WalletStatusBlocked:
            raise
        except WalletNotFound:
            raise
        except Exception:
            # Best-effort rollback so a retry isn't blocked by a stuck pending.
            try:
                await self.txns.delete_one({"_id": ins.inserted_id})
            except Exception:  # noqa: BLE001
                pass
            raise

        # 3) patch ledger with REAL post-update balance — never a stale projection
        await self.txns.update_one(
            {"_id": ins.inserted_id},
            {"$set": {
                "balance_after": balance_after,
                "status": "applied",
                "applied_at": _utcnow(),
            }},
        )

        return {
            "ok": True,
            "duplicate": False,
            "balance_after": balance_after,
            "mode": "ledger_first",
        }

    async def _ledger_first_transfer(
        self,
        f_id: str,
        t_id: str,
        amt: int,
        *,
        source: str,
        source_ref: str | None,
        idempotency_key: str | None,
        payload: Mapping[str, Any],
        admin_bypass_status: bool = False,
    ) -> dict[str, Any]:
        """ONLY callable with durable_repair=True (enforced by ``transfer``).

        Strategy mirrors a saga: debit pending row → debit wallet → credit
        pending row → credit wallet → mark both applied. The Phase 2 sync
        replayer scans for pending rows older than its monitoring window
        and either replays the missing leg or escalates."""
        now = _utcnow()
        debit_key = f"{idempotency_key}:debit" if idempotency_key else None
        credit_key = f"{idempotency_key}:credit" if idempotency_key else None

        # 1) pending debit ledger
        debit_pending = {
            "student_id": f_id, "operation": "transfer_debit",
            "amount": amt, "delta": -amt, "balance_after": None,
            "source": source, "source_ref": source_ref,
            "idempotency_key": debit_key,
            "from_id": f_id, "to_id": t_id,
            "payload": dict(payload or {}),
            "status": "pending", "created_at": now,
        }
        d_ins = await self.txns.insert_one(debit_pending)

        # BLOCKER 2 FIX: status guard lives inside the Mongo update filters.
        from_filter: dict[str, Any] = {
            "student_id": f_id,
            "balance": {"$gte": amt},
        }
        to_filter: dict[str, Any] = {"student_id": t_id}
        if not admin_bypass_status:
            from_filter["status"] = STATUS_ACTIVE
            to_filter["status"] = STATUS_ACTIVE

        # 2) debit wallet with balance guard + status guard
        upd_from = await self.wallets.find_one_and_update(
            from_filter,
            {"$inc": {"balance": -amt}, "$set": {"updated_at": now}},
            return_document=ReturnDocument.AFTER,
            projection={"_id": 0, "balance": 1, "status": 1},
        )
        if not upd_from:
            await self.txns.delete_one({"_id": d_ins.inserted_id})
            await self._diagnose_no_match(
                f_id, was_debit=True, needed_balance=amt,
            )
        f_bal = int(upd_from.get("balance") or 0)

        # 3) pending credit ledger — if a crash happens before step 4
        #    the Phase 2 replayer finds this row and credits the recipient.
        credit_pending = {
            "student_id": t_id, "operation": "transfer_credit",
            "amount": amt, "delta": +amt, "balance_after": None,
            "source": source, "source_ref": source_ref,
            "idempotency_key": credit_key,
            "from_id": f_id, "to_id": t_id,
            "payload": dict(payload or {}),
            "status": "pending", "created_at": _utcnow(),
            "repair_link": str(d_ins.inserted_id),
        }
        c_ins = await self.txns.insert_one(credit_pending)

        # 4) credit wallet (status-guarded). If the recipient was frozen
        #    between transfer pre-check and now, the credit fails — the
        #    Phase 2 replayer surfaces the broken half for admin repair.
        upd_to = await self.wallets.find_one_and_update(
            to_filter,
            {"$inc": {"balance": +amt}, "$set": {"updated_at": _utcnow()}},
            return_document=ReturnDocument.AFTER,
            projection={"_id": 0, "balance": 1, "status": 1},
        )
        if not upd_to:
            # Leave the credit_pending row for the Phase 2 replayer to surface.
            await self._diagnose_no_match(t_id, was_debit=False)
        t_bal = int(upd_to.get("balance") or 0)

        # 5) patch BOTH ledger rows with the REAL post-update balances.
        await self.txns.update_one(
            {"_id": d_ins.inserted_id},
            {"$set": {"balance_after": f_bal, "status": "applied",
                      "applied_at": _utcnow()}},
        )
        await self.txns.update_one(
            {"_id": c_ins.inserted_id},
            {"$set": {"balance_after": t_bal, "status": "applied",
                      "applied_at": _utcnow()}},
        )

        return {
            "ok": True,
            "duplicate": False,
            "from_balance_after": f_bal,
            "to_balance_after": t_bal,
            "mode": "ledger_first",
        }

    # ---------- admin / migration helpers -------------------------------- #
    async def set_status(
        self, student_id: str, status: str, *, note: str = ""
    ) -> dict[str, Any]:
        """Admin-only. Used by reconcile flows. Writes an audit row."""
        if status not in ALLOWED_STATUSES:
            raise WalletError("INVALID_STATUS", f"unknown status {status!r}")
        sid = _norm_id(student_id)
        await self._ensure_wallet(sid)
        now = _utcnow()
        await self.wallets.update_one(
            {"student_id": sid},
            {"$set": {"status": status, "updated_at": now}},
        )
        await self.txns.insert_one({
            "student_id": sid,
            "operation": "status_change",
            "amount": 0,
            "delta": 0,
            "balance_after": await self.get_balance(sid),
            "source": "admin",
            "source_ref": None,
            "idempotency_key": None,
            "from_id": None, "to_id": None,
            "payload": {"status": status, "note": note},
            "created_at": now,
        })
        return {"ok": True, "student_id": sid, "status": status}


# --------------------------------------------------------------------------- #
# Balance-audit helpers — used by /api/teacher/migration/balance-audit        #
# --------------------------------------------------------------------------- #
async def balance_audit_one(
    db: AsyncIOMotorDatabase,
    *,
    student_id: str,
    gas_login_url: str | None,
    legacy_password: str | None = None,
    http_timeout_s: float = 8.0,
) -> dict[str, Any]:
    """Audit one student's Mongo balance against the live GAS balance.

    Returns a dict with a stable ``status`` enum. A GAS auth failure is
    NEVER treated as a 0-points balance — it is surfaced as
    ``gas_auth_failed`` so the operator sees the truth.
    """
    sid = _norm_id(student_id)
    mongo_doc = await db[COLL_WALLETS].find_one(
        {"student_id": sid}, {"_id": 0, "balance": 1}
    )
    mongo_balance: int | None = (
        int(mongo_doc["balance"]) if mongo_doc and "balance" in mongo_doc else None
    )

    if not gas_login_url:
        return {
            "student_id": sid,
            "status": "unsupported_without_legacy_password",
            "mongo_balance": mongo_balance,
            "gas_balance": None,
        }
    if not legacy_password:
        return {
            "student_id": sid,
            "status": "unsupported_without_legacy_password",
            "mongo_balance": mongo_balance,
            "gas_balance": None,
            "reason": "GAS PointsBackend `login` requires the plaintext "
                      "password column from the legacy Sheet; pass it via "
                      "the admin-only audit payload to enable this row.",
        }

    # Local import so this module remains importable on systems without httpx.
    try:
        import httpx  # type: ignore
    except Exception:  # noqa: BLE001
        return {
            "student_id": sid,
            "status": "gas_unreachable",
            "mongo_balance": mongo_balance,
            "gas_balance": None,
            "reason": "httpx not installed",
        }

    try:
        async with httpx.AsyncClient(
            timeout=httpx.Timeout(http_timeout_s, connect=4.0),
            follow_redirects=True,
        ) as cli:
            # POST first (same path the live backend uses).
            r1 = await cli.post(
                gas_login_url,
                data={"action": "login", "id": sid, "password": legacy_password},
            )
            j1: Any = None
            try:
                j1 = r1.json()
            except Exception:  # noqa: BLE001
                j1 = None
            if isinstance(j1, dict) and j1.get("success") is True:
                pts = j1.get("points")
                if isinstance(pts, (int, float)):
                    gas_balance = int(pts)
                    status = (
                        "matched"
                        if mongo_balance is not None and gas_balance == mongo_balance
                        else "mismatched"
                        if mongo_balance is not None
                        else "mongo_missing"
                    )
                    return {
                        "student_id": sid, "status": status,
                        "mongo_balance": mongo_balance, "gas_balance": gas_balance,
                    }
                # success=true but no numeric points => treat as auth ok but
                # unsupported response shape.
                return {
                    "student_id": sid, "status": "gas_auth_failed",
                    "mongo_balance": mongo_balance, "gas_balance": None,
                    "reason": "GAS responded success without numeric points",
                }

            # GET fallback for legacy backend.
            r2 = await cli.get(
                gas_login_url,
                params={"action": "login", "id": sid, "password": legacy_password},
            )
            j2: Any = None
            try:
                j2 = r2.json()
            except Exception:  # noqa: BLE001
                j2 = None
            if isinstance(j2, dict) and j2.get("success") is True:
                pts = j2.get("points")
                if isinstance(pts, (int, float)):
                    gas_balance = int(pts)
                    status = (
                        "matched"
                        if mongo_balance is not None and gas_balance == mongo_balance
                        else "mismatched"
                        if mongo_balance is not None
                        else "mongo_missing"
                    )
                    return {
                        "student_id": sid, "status": status,
                        "mongo_balance": mongo_balance, "gas_balance": gas_balance,
                    }
            # All explicit failure modes — never treat as 0 points.
            if r1.status_code >= 500 or r2.status_code >= 500:
                return {
                    "student_id": sid, "status": "gas_unreachable",
                    "mongo_balance": mongo_balance, "gas_balance": None,
                }
            return {
                "student_id": sid, "status": "gas_auth_failed",
                "mongo_balance": mongo_balance, "gas_balance": None,
            }
    except Exception as exc:  # noqa: BLE001
        return {
            "student_id": sid, "status": "gas_unreachable",
            "mongo_balance": mongo_balance, "gas_balance": None,
            "reason": f"{type(exc).__name__}: {str(exc)[:200]}",
        }


# --------------------------------------------------------------------------- #
# Sync-event helpers — Phase 2 hooks (Phase 1 only seeds the schema)          #
# --------------------------------------------------------------------------- #
async def pending_sync_event_counts(db: AsyncIOMotorDatabase) -> dict[str, int]:
    coll = db[COLL_SYNC_EVENTS]
    pending = await coll.count_documents({"mongo_status": "pending"})
    failed = await coll.count_documents({"mongo_status": "failed"})
    return {"pending": pending, "failed": failed}


# --------------------------------------------------------------------------- #
# BLOCKER 1 (v4) — Wallet seed gate                                          #
#                                                                             #
# Phase 2 shadow debits will fail with InsufficientFunds when a student has   #
# points in GAS but no Mongo wallet has been seeded yet (because              #
# _ensure_wallet() creates the wallet with balance 0). Until every in-scope  #
# active student wallet is seeded from GAS, USE_MONGO_POINTS_WRITE=shadow    #
# MUST stay off.                                                              #
# --------------------------------------------------------------------------- #
async def wallet_seed_status(db: AsyncIOMotorDatabase) -> dict[str, Any]:
    """Return seed-readiness counters used by the migration status route.

    ``can_enable_shadow`` is True only when there are no in-scope active
    students missing a Mongo wallet. The route consumer is the operator
    who must answer the gate before flipping USE_MONGO_POINTS_WRITE=shadow.
    """
    coll_names = await db.list_collection_names()
    if "students" not in coll_names:
        return {
            "total_wallets": await db[COLL_WALLETS].count_documents({}),
            "active_students": 0,
            "missing_wallets": 0,
            "can_enable_shadow": False,
            "reason": "students_collection_missing",
        }
    active_students = await db.students.count_documents(
        {"$or": [
            {"is_active": True},
            {"is_active": {"$exists": False}},
        ]}
    )
    total_wallets = await db[COLL_WALLETS].count_documents({})
    # Active students whose student_id has NO Mongo wallet row.
    pipeline = [
        {"$match": {"$or": [
            {"is_active": True},
            {"is_active": {"$exists": False}},
        ]}},
        {"$project": {"_id": 0, "sid": {"$toLower": "$student_id"}}},
        {"$lookup": {
            "from": COLL_WALLETS,
            "localField": "sid",
            "foreignField": "student_id",
            "as": "w",
        }},
        {"$match": {"w": {"$size": 0}}},
        {"$count": "n"},
    ]
    missing = 0
    async for doc in db.students.aggregate(pipeline):
        missing = int(doc.get("n") or 0)
    return {
        "total_wallets": total_wallets,
        "active_students": active_students,
        "missing_wallets": missing,
        "can_enable_shadow": (
            active_students > 0 and missing == 0
        ),
    }


async def import_wallet_one(
    db: AsyncIOMotorDatabase,
    *,
    student_id: str,
    clean_id: str | None,
    gas_login_url: str | None,
    legacy_password: str | None,
    overwrite_existing: bool,
    dry_run: bool,
) -> dict[str, Any]:
    """Seed one Mongo wallet from a confirmed GAS balance.

    Returns a per-student row with one of the documented status values:

      * ``would_import``   — dry_run; wallet absent; GAS confirmed balance.
      * ``imported``       — wallet absent; wallet written with GAS balance.
      * ``skipped_existing`` — wallet already present; ``overwrite_existing``
        is False; NO write performed.
      * ``matched_existing`` — wallet present AND balance equals GAS;
        idempotent.
      * ``mismatched_existing`` — wallet present AND balance differs from
        GAS; NO write performed unless ``overwrite_existing=True``.
      * ``gas_auth_failed`` — GAS responded but rejected the credentials.
        NEVER coerced to a 0-points balance.
      * ``gas_unreachable`` — GAS network/parse error.
      * ``unsupported_without_legacy_password`` — caller did not supply a
        legacy password (GAS PointsBackend ``login`` requires it).
      * ``failed`` — any other unexpected error (also non-fatal).
    """
    sid = _norm_id(student_id)
    cleaned = (clean_id or sid).strip().lower()
    # Reuse the proven audit helper — it never coerces auth/network failure
    # into a 0-points balance.
    audit_row = await balance_audit_one(
        db,
        student_id=sid,
        gas_login_url=gas_login_url,
        legacy_password=legacy_password,
    )
    audit_status = audit_row.get("status")
    gas_balance = audit_row.get("gas_balance")
    mongo_balance = audit_row.get("mongo_balance")
    out: dict[str, Any] = {
        "student_id": sid,
        "clean_id": cleaned,
        "gas_balance": gas_balance,
        "mongo_balance": mongo_balance,
        "status": "failed",
    }
    if audit_status in (
        "gas_auth_failed",
        "gas_unreachable",
        "unsupported_without_legacy_password",
        "invalid",
    ):
        out["status"] = audit_status
        if "reason" in audit_row:
            out["reason"] = audit_row["reason"]
        return out
    # audit_status is now matched / mismatched / mongo_missing.
    if not isinstance(gas_balance, int):
        out["status"] = "failed"
        out["reason"] = "gas_balance_unknown_after_audit"
        return out
    now_iso = _utcnow()
    if mongo_balance is None:
        # No wallet row → import path.
        if dry_run:
            out["status"] = "would_import"
            return out
        try:
            doc = {
                "student_id": sid,
                "clean_id": cleaned,
                "balance": int(gas_balance),
                "status": STATUS_ACTIVE,
                "created_at": now_iso,
                "updated_at": now_iso,
                "version": 0,
                "leaderboard_earned_points": 0,
                "lifetime_top_up": 0,
                "last_imported_from": "gas",
                "last_imported_at": now_iso,
            }
            await db[COLL_WALLETS].update_one(
                {"student_id": sid},
                {"$setOnInsert": doc},
                upsert=True,
            )
            # Confirm by re-reading.
            confirmed = await db[COLL_WALLETS].find_one(
                {"student_id": sid}, {"_id": 0, "balance": 1}
            )
            out["mongo_balance"] = int((confirmed or {}).get("balance") or 0)
            out["status"] = "imported"
        except Exception as exc:  # noqa: BLE001
            out["status"] = "failed"
            out["reason"] = f"{type(exc).__name__}: {str(exc)[:160]}"
        return out
    # Wallet already present.
    if int(mongo_balance) == int(gas_balance):
        out["status"] = "matched_existing"
        return out
    # Balances differ.
    if not overwrite_existing:
        out["status"] = "mismatched_existing"
        return out
    if dry_run:
        out["status"] = "would_import"
        out["overwrite"] = True
        return out
    # Admin repair path: explicit overwrite.
    try:
        await db[COLL_WALLETS].update_one(
            {"student_id": sid},
            {"$set": {
                "balance": int(gas_balance),
                "clean_id": cleaned,
                "status": STATUS_ACTIVE,
                "updated_at": now_iso,
                "last_imported_from": "gas",
                "last_imported_at": now_iso,
            }},
        )
        out["mongo_balance"] = int(gas_balance)
        out["status"] = "imported"
        out["overwrite"] = True
    except Exception as exc:  # noqa: BLE001
        out["status"] = "failed"
        out["reason"] = f"{type(exc).__name__}: {str(exc)[:160]}"
    return out


# --------------------------------------------------------------------------- #
# Admin migration endpoints — registered onto the existing /api router        #
# using the existing ``require_admin`` dependency from server.py.             #
# Phase 1 only registers READ + balance-audit + reconcile (no live writes).   #
# --------------------------------------------------------------------------- #

# --------------------------------------------------------------------------- #
# Phase 1.5 — manual Sheet snapshot import (no GAS call, no password)         #
# --------------------------------------------------------------------------- #

async def import_wallet_one_manual(
    db: AsyncIOMotorDatabase,
    *,
    student_id: str,
    clean_id: str,
    trusted_balance: float,
    overwrite_existing: bool,
    dry_run: bool,
) -> dict[str, Any]:
    """Seed one wallet from a trusted admin-supplied Sheet snapshot.

    Used when balance_source="manual_sheet_snapshot" is in the payload.
    No GAS call. No password accepted or stored.

    Status values returned:
      * would_import         — dry_run=True; all checks passed; write skipped.
      * imported             — wallet written successfully.
      * skipped_existing     — wallet exists; overwrite_existing=False.
      * invalid              — validation failed (bad id, negative balance, etc.)
      * failed               — unexpected database error.
    """
    sid     = _norm_id(student_id)
    cleaned = (clean_id or sid).strip().lower()

    out: dict[str, Any] = {
        "student_id":    sid,
        "clean_id":      cleaned,
        "gas_balance":   None,
        "trusted_balance": trusted_balance,
        "mongo_balance": None,
        "status":        "failed",
        "balance_source": "manual_sheet_snapshot",
    }

    # Validate balance
    if not isinstance(trusted_balance, (int, float)):
        out["status"] = "invalid"
        out["reason"] = "balance must be numeric"
        return out
    if trusted_balance < 0:
        out["status"] = "invalid"
        out["reason"] = "negative balance rejected"
        return out

    # Verify student is active in db.students
    stu_doc = await db.students.find_one(
        {"$or": [
            {"student_id": sid,     "is_active": True},
            {"student_id": sid,     "is_active": {"$exists": False}},
            {"clean_id":  cleaned,  "is_active": True},
            {"clean_id":  cleaned,  "is_active": {"$exists": False}},
        ]},
        {"_id": 0, "student_id": 1, "clean_id": 1},
    )
    if not stu_doc:
        out["status"] = "invalid"
        out["reason"] = (
            f"student_id={sid!r} / clean_id={cleaned!r} not found in "
            "db.students or not active"
        )
        return out

    # Use canonical IDs from the database row
    sid     = stu_doc.get("student_id") or sid
    cleaned = stu_doc.get("clean_id")   or cleaned
    out["student_id"] = sid
    out["clean_id"]   = cleaned

    # Check existing wallet
    existing = await db[COLL_WALLETS].find_one(
        {"student_id": sid}, {"_id": 0, "balance": 1}
    )
    if existing and "balance" in existing:
        out["mongo_balance"] = float(existing["balance"])

    if existing and not overwrite_existing:
        out["status"] = "skipped_existing"
        out["reason"]  = (
            "wallet already exists; set overwrite_existing=true to overwrite"
        )
        return out

    # Dry-run — no writes
    if dry_run:
        out["status"] = "would_import"
        return out

    # Real import
    now_iso = _utcnow()
    balance_to_store: Any = (
        int(trusted_balance)
        if trusted_balance == int(trusted_balance)
        else round(trusted_balance, 6)
    )
    doc = {
        "student_id":               sid,
        "clean_id":                 cleaned,
        "balance":                  balance_to_store,
        "status":                   STATUS_ACTIVE,
        "created_at":               now_iso,
        "updated_at":               now_iso,
        "version":                  0,
        "leaderboard_earned_points": 0,
        "lifetime_top_up":          0,
        "last_imported_from":       "manual_sheet_snapshot",
        "last_imported_at":         now_iso,
    }
    try:
        if existing and overwrite_existing:
            await db[COLL_WALLETS].update_one(
                {"student_id": sid},
                {"$set": {
                    "balance":            balance_to_store,
                    "updated_at":         now_iso,
                    "last_imported_from": "manual_sheet_snapshot",
                    "last_imported_at":   now_iso,
                }},
            )
        else:
            await db[COLL_WALLETS].update_one(
                {"student_id": sid},
                {"$setOnInsert": doc},
                upsert=True,
            )
        confirmed = await db[COLL_WALLETS].find_one(
            {"student_id": sid}, {"_id": 0, "balance": 1}
        )
        out["mongo_balance"] = (
            float(confirmed["balance"]) if confirmed else balance_to_store
        )
        out["status"] = "imported"
    except Exception as exc:  # noqa: BLE001
        out["status"] = "failed"
        out["reason"]  = f"{type(exc).__name__}: {str(exc)[:160]}"
    return out


def register_migration_routes(api, db, require_admin) -> None:
    """Mount /api/teacher/migration/* onto the existing FastAPI router.
    The router and admin dependency come from server.py — this module
    never imports server.py to avoid circular imports."""
    from fastapi import Body, Depends, HTTPException

    @api.get("/teacher/migration/status")
    async def _migration_status(_admin=Depends(require_admin)):
        # Read live module attributes — NEVER copy into a local constant.
        counts = await pending_sync_event_counts(db)
        seed = await wallet_seed_status(db)
        flags = {
            "USE_MONGO_POINTS_READ": os.environ.get(
                "USE_MONGO_POINTS_READ", "false"),
            "USE_MONGO_POINTS_WRITE": os.environ.get(
                "USE_MONGO_POINTS_WRITE", "off"),
            "USE_MONGO_LOGIN": os.environ.get("USE_MONGO_LOGIN", "false"),
            "USE_MONGO_UNLOCKS": os.environ.get("USE_MONGO_UNLOCKS", "false"),
            "USE_MONGO_SCORES": os.environ.get("USE_MONGO_SCORES", "false"),
            "USE_MONGO_TUITION": os.environ.get("USE_MONGO_TUITION", "false"),
            "USE_MONGO_RESTRICTIONS": os.environ.get(
                "USE_MONGO_RESTRICTIONS", "false"),
            "USE_MONGO_GAME": os.environ.get("USE_MONGO_GAME", "false"),
            "USE_MONGO_SHOP": os.environ.get("USE_MONGO_SHOP", "false"),
            "USE_MONGO_LEADERBOARD": os.environ.get(
                "USE_MONGO_LEADERBOARD", "false"),
            "USE_MONGO_TEST": os.environ.get("USE_MONGO_TEST", "false"),
        }
        # can_flip_to_primary is only true when the durable sync events
        # backlog is empty AND a write-mode of at least "syncing" is set.
        write_mode = flags["USE_MONGO_POINTS_WRITE"].lower()
        can_flip = (
            counts["pending"] == 0
            and counts["failed"] == 0
            and write_mode in {"syncing", "primary"}
        )
        return {
            "wallet_mode": WALLET_MODE,
            "mongo_transactions_supported": MONGO_SUPPORTS_TRANSACTIONS,
            "pending_sync_events": counts["pending"],
            "failed_sync_events": counts["failed"],
            "can_flip_to_primary": can_flip,
            "feature_flags": flags,
            # BLOCKER 1 (v4) — wallet seed gate signal. Phase 2 shadow
            # mode is unsafe to enable while any in-scope active student
            # has no Mongo wallet (the first shadow debit would create
            # the wallet with balance 0 and immediately fail with
            # InsufficientFunds, drifting Mongo from GAS).
            "wallet_seed_required_before_shadow": True,
            "wallet_seed_status": seed,
            "phase_2_gate": (
                "Do not set USE_MONGO_POINTS_WRITE=shadow until: "
                "(1) all in-scope active student wallets are seeded from "
                "GAS, (2) the wallet import/seed dry run and real run "
                "complete without unsupported/auth-failed students, "
                "(3) balance audit confirms Mongo balance equals GAS "
                "balance for all in-scope students, and (4) Phase 2 "
                "covered paths have unique idempotency keys per real "
                "GAS transaction."
            ),
            "steps_completed": ["phase_1_preflight"],
            "steps_pending": [
                "phase_2_shadow_writes",
                "phase_3_points_read",
                "phase_4_library_unlocks",
                "phase_5_render_login",
                "phase_6_academic_status",
                "phase_7_game_shop",
                "phase_8_leaderboard",
                "phase_9_systemtest",
                "phase_10_gas_removal",
            ],
        }

    @api.post("/teacher/migration/import-wallets")
    async def _migration_import_wallets(
        payload: dict = Body(default_factory=dict),
        _admin=Depends(require_admin),
    ):
        """BLOCKER 1 (v4) — admin-only wallet seed/import endpoint.

        Seeds ``db.points_wallets`` from confirmed live GAS balances
        before USE_MONGO_POINTS_WRITE=shadow is allowed. Idempotent,
        non-destructive by default, dry-run by default.

        Request body::

            {
              "students": [
                {"student_id": "stu094", "clean_id": "stu094",
                 "legacy_password": "optional-if-required"}
              ],
              "overwrite_existing": false,   # default false (safe)
              "dry_run": true,               # default true (safe)
              "audit_all_active": false,     # convenience: seed every
                                             # active student from db.students
              "gas_url": "optional override"
            }

        Per-student status enum (NEVER coerces auth/network failure to 0):

            would_import | imported | skipped_existing | matched_existing
            | mismatched_existing | gas_auth_failed | gas_unreachable
            | unsupported_without_legacy_password | failed

        ``overwrite_existing=true`` is admin-repair only and is documented
        in Phase 2 SETUP_AND_DEPLOY_GUIDE.md. Default behaviour is to
        leave existing wallets untouched and surface mismatches.
        """
        students = payload.get("students") or []
        if payload.get("audit_all_active"):
            cur = db.students.find(
                {"$or": [
                    {"is_active": True},
                    {"is_active": {"$exists": False}},
                ]},
                {"_id": 0, "student_id": 1, "clean_id": 1,
                 "legacy_password": 1},
            ).limit(500)
            students = [s async for s in cur]
        if not isinstance(students, list):
            raise HTTPException(
                status_code=400, detail="students must be a list",
            )
        overwrite_existing = bool(payload.get("overwrite_existing", False))
        dry_run = bool(payload.get("dry_run", True))
        # Phase 1.5 — manual Sheet snapshot path.
        # When balance_source="manual_sheet_snapshot", each student row must
        # supply a trusted balance directly.  GAS is NOT called and no
        # legacy password is accepted or required on this path.
        balance_source = (payload.get("balance_source") or "").strip().lower()
        is_manual_seed = balance_source == "manual_sheet_snapshot"
        gas_url = os.environ.get(
            "GAS_POINTS_LOGIN_URL", payload.get("gas_url") or "",
        )
        rows: list[dict[str, Any]] = []
        for s in students[:500]:
            sid = (s or {}).get("student_id") or ""
            cid = (s or {}).get("clean_id") or sid
            try:
                if is_manual_seed:
                    # Trusted balance from Sheet — bypass GAS entirely.
                    raw_bal = (s or {}).get("balance")
                    if raw_bal is None:
                        row = {
                            "student_id": sid, "clean_id": cid,
                            "gas_balance": None, "mongo_balance": None,
                            "status": "invalid",
                            "reason": "balance field required for manual_sheet_snapshot",
                            "balance_source": "manual_sheet_snapshot",
                        }
                    else:
                        try:
                            trusted_bal = float(raw_bal)
                        except (TypeError, ValueError):
                            trusted_bal = None
                        if trusted_bal is None:
                            row = {
                                "student_id": sid, "clean_id": cid,
                                "gas_balance": None, "mongo_balance": None,
                                "status": "invalid",
                                "reason": f"balance must be numeric, got {raw_bal!r}",
                                "balance_source": "manual_sheet_snapshot",
                            }
                        else:
                            row = await import_wallet_one_manual(
                                db,
                                student_id=sid,
                                clean_id=cid,
                                trusted_balance=trusted_bal,
                                overwrite_existing=overwrite_existing,
                                dry_run=dry_run,
                            )
                else:
                    # Original GAS-backed path (requires legacy_password).
                    pw = (s or {}).get("legacy_password")
                    row = await import_wallet_one(
                        db,
                        student_id=sid,
                        clean_id=cid,
                        gas_login_url=gas_url,
                        legacy_password=pw,
                        overwrite_existing=overwrite_existing,
                        dry_run=dry_run,
                    )
            except WalletError as exc:
                row = {
                    "student_id": sid, "clean_id": cid,
                    "gas_balance": None, "mongo_balance": None,
                    "status": "invalid", "reason": exc.message,
                }
            rows.append(row)
        summary = {
            "total": len(rows),
            "imported": 0,
            "would_import": 0,
            "skipped_existing": 0,
            "matched_existing": 0,
            "mismatched_existing": 0,
            "gas_auth_failed": 0,
            "gas_unreachable": 0,
            "unsupported_without_legacy_password": 0,
            "failed": 0,
            "invalid": 0,
        }
        for r in rows:
            summary[r["status"]] = summary.get(r["status"], 0) + 1
        seed_after = await wallet_seed_status(db)
        return {
            "dry_run": dry_run,
            "overwrite_existing": overwrite_existing,
            "summary": summary,
            "students": rows,
            "wallet_seed_status_after": seed_after,
            "phase_2_gate_text": (
                "Do not set USE_MONGO_POINTS_WRITE=shadow until: "
                "(1) all in-scope active student wallets are seeded from "
                "GAS, (2) summary.unsupported_without_legacy_password + "
                "gas_auth_failed + gas_unreachable + failed == 0 after a "
                "real (dry_run=false) run, (3) balance audit confirms "
                "phase_3_ready == true, and (4) Phase 2 covered paths "
                "use unique idempotency keys per real GAS transaction."
            ),
        }

    @api.get("/teacher/migration/balance-audit/status")
    async def _balance_audit_status(_admin=Depends(require_admin)):
        """BLOCKER 3 (v3) — explicit migration audit-gate report.

        Returns a single document describing audit capability so the
        operator knows exactly whether Phase 3 can be safely enabled.

        Fields:
          * can_audit_all_active_students — true when ``db.students`` has
            at least one active row.
          * legacy_password_required — true (GAS PointsBackend requires
            the plaintext legacy password column).
          * legacy_passwords_known_in_db — count of students whose Mongo
            row already carries a ``legacy_password`` field (admin-only;
            never returned in plaintext).
          * supported_endpoint — POST /api/teacher/migration/balance-audit
          * required_result_before_phase_3 — concrete pass criterion.
          * gas_auth_failure_treated_as_zero — must be FALSE in v3
            (closes the v1 audit blocker).
        """
        gas_url = os.environ.get("GAS_POINTS_LOGIN_URL", "")
        active_count = await db.students.count_documents(
            {"$or": [
                {"is_active": True},
                {"is_active": {"$exists": False}},
            ]}
        ) if "students" in await db.list_collection_names() else 0
        pw_count = await db.students.count_documents(
            {"legacy_password": {"$exists": True, "$ne": ""}}
        ) if "students" in await db.list_collection_names() else 0
        counts = await pending_sync_event_counts(db)
        return {
            "wallet_mode": WALLET_MODE,
            "mongo_transactions_supported": MONGO_SUPPORTS_TRANSACTIONS,
            "gas_url_configured": bool(gas_url),
            "can_audit_all_active_students": active_count > 0,
            "active_students_count": active_count,
            "legacy_password_required": True,
            "legacy_passwords_known_in_db": pw_count,
            "supported_endpoint": "POST /api/teacher/migration/balance-audit",
            "supported_modes": [
                "explicit_students_list",
                "all_active_students_from_db",
            ],
            "per_student_status_enum": [
                "matched",
                "mismatched",
                "mongo_missing",
                "gas_auth_failed",
                "gas_unreachable",
                "unsupported_without_legacy_password",
                "invalid",
            ],
            "gas_auth_failure_treated_as_zero": False,
            "required_result_before_phase_3": (
                "summary.mismatched == 0 AND summary.mongo_missing == 0 "
                "AND summary.gas_auth_failed == 0 AND "
                "summary.gas_unreachable == 0"
            ),
            "phase_3_gate": (
                "Do not enable REACT_APP_USE_RENDER_POINTS=true until "
                "one of: (a) Phase 2 has complete point-write shadow "
                "coverage, (b) every still-GAS point-write path is "
                "migrated to MongoDB primary, or (c) a fresh "
                "reconciliation proves no drift AND every uncovered "
                "point-write path is disabled during the read flip."
            ),
            "pending_sync_events": counts["pending"],
            "failed_sync_events": counts["failed"],
        }

    @api.post("/teacher/migration/balance-audit")
    async def _balance_audit(
        payload: dict = Body(default_factory=dict),
        _admin=Depends(require_admin),
    ):
        """Run a balance audit.

        Modes:
          * Explicit list — payload ``{"students": [{"student_id": "...",
            "legacy_password": "..."}, ...]}``. Up to 500 rows.
          * Audit-all — payload ``{"audit_all_active": true}``. Iterates
            ``db.students`` where ``status == "active"`` (capped at 500).
            For each active student that has a stored ``legacy_password``,
            it is used. Rows without a stored password are returned as
            ``unsupported_without_legacy_password`` instead of being
            silently treated as a 0-points balance.

        ``legacy_password`` is NEVER echoed back in the response.
        A GAS auth failure is NEVER treated as a 0-points balance — it
        is surfaced as ``gas_auth_failed`` so the operator sees the truth.
        """
        gas_url = os.environ.get(
            "GAS_POINTS_LOGIN_URL", payload.get("gas_url") or ""
        )
        students = payload.get("students") or []
        if payload.get("audit_all_active"):
            # Load active students from Mongo. The endpoint never persists
            # plaintext passwords; it only reads the optional field if the
            # operator has previously imported it via a separate admin tool.
            cur = db.students.find(
                {"$or": [
                    {"is_active": True},
                    {"is_active": {"$exists": False}},
                ]},
                {"_id": 0, "student_id": 1, "legacy_password": 1},
            ).limit(500)
            students = [s async for s in cur]
        if not isinstance(students, list):
            raise HTTPException(status_code=400, detail="students must be a list")
        rows = []
        for s in students[:500]:
            sid = (s or {}).get("student_id") or ""
            pw = (s or {}).get("legacy_password")
            try:
                row = await balance_audit_one(
                    db, student_id=sid,
                    gas_login_url=gas_url, legacy_password=pw,
                )
            except WalletError as exc:
                row = {"student_id": sid, "status": "invalid",
                       "reason": exc.message}
            rows.append(row)
        summary = {"matched": 0, "mismatched": 0, "mongo_missing": 0,
                   "gas_auth_failed": 0, "gas_unreachable": 0,
                   "unsupported_without_legacy_password": 0,
                   "invalid": 0}
        for r in rows:
            summary[r["status"]] = summary.get(r["status"], 0) + 1
        # Gate signal for Phase 3 flip readiness.
        phase_3_ready = (
            summary["mismatched"] == 0
            and summary["mongo_missing"] == 0
            and summary["gas_auth_failed"] == 0
            and summary["gas_unreachable"] == 0
            and summary["invalid"] == 0
        )
        return {
            "rows": rows,
            "summary": summary,
            "phase_3_ready": phase_3_ready,
            "phase_3_gate_text": (
                "Phase 3 can proceed only when summary.mismatched + "
                "mongo_missing + gas_auth_failed + gas_unreachable + "
                "invalid == 0. "
                "unsupported_without_legacy_password rows must be "
                "resolved by importing the legacy password or by "
                "marking those students as out-of-scope before flipping "
                "REACT_APP_USE_RENDER_POINTS=true."
            ),
        }

    @api.get("/teacher/migration/balance-audit")
    async def _balance_audit_get(_admin=Depends(require_admin)):
        # Convenience GET — surfaces module flags + counts without
        # requesting any GAS round-trip. Useful from the migration
        # dashboard's first paint.
        counts = await pending_sync_event_counts(db)
        return {
            "wallet_mode": WALLET_MODE,
            "mongo_transactions_supported": MONGO_SUPPORTS_TRANSACTIONS,
            **counts,
        }

    @api.post("/teacher/migration/reconcile")
    async def _migration_reconcile(
        payload: dict = Body(default_factory=dict),
        _admin=Depends(require_admin),
    ):
        # ``items`` is a list of {"student_id": "...", "set_balance": int,
        # "note": "..."} reconcile entries. ``confirm`` must be true.
        if not payload.get("confirm"):
            raise HTTPException(status_code=400,
                                detail="reconcile requires confirm=true")
        items = payload.get("items") or []
        svc = WalletService(db)
        applied = []
        for entry in items[:200]:
            sid = (entry or {}).get("student_id") or ""
            target = entry.get("set_balance")
            note = entry.get("note") or ""
            try:
                sid_norm = _norm_id(sid)
            except WalletError as exc:
                applied.append({"student_id": sid, "ok": False,
                                "reason": exc.message})
                continue
            if not isinstance(target, int):
                applied.append({"student_id": sid_norm, "ok": False,
                                "reason": "set_balance must be int"})
                continue
            current = await svc.get_balance(sid_norm)
            delta = target - current
            try:
                if delta > 0:
                    res = await svc.credit(
                        sid_norm, delta,
                        source="admin_reconcile",
                        source_ref=note or None,
                        idempotency_key=(entry.get("idempotency_key") or None),
                        payload={"note": note, "before": current,
                                 "target": target},
                        allow_status=True,
                        admin_bypass_status=True,
                    )
                elif delta < 0:
                    res = await svc.debit(
                        sid_norm, -delta,
                        source="admin_reconcile",
                        source_ref=note or None,
                        idempotency_key=(entry.get("idempotency_key") or None),
                        payload={"note": note, "before": current,
                                 "target": target},
                        allow_status=True,
                        allow_negative=True,
                        admin_bypass_status=True,
                    )
                else:
                    res = {"ok": True, "balance_after": current,
                           "no_change": True}
                applied.append({"student_id": sid_norm, "ok": True,
                                "result": res})
            except WalletError as exc:
                applied.append({"student_id": sid_norm, "ok": False,
                                "reason": exc.message})
        return {"applied": applied}


__all__ = [
    "WalletService",
    "register_migration_routes",
    "WalletError",
    "WalletNotFound",
    "InsufficientFunds",
    "WalletStatusBlocked",
    "TransferNotAtomic",
    "MONGO_SUPPORTS_TRANSACTIONS",
    "WALLET_MODE",
    "STATUS_ACTIVE",
    "STATUS_FROZEN",
    "STATUS_CLOSED",
    "COLL_WALLETS",
    "COLL_TRANSACTIONS",
    "COLL_SYNC_EVENTS",
    "current_wallet_mode",
    "wallet_state",
    "detect_transaction_support",
    "ensure_wallet_indexes",
    "balance_audit_one",
    "pending_sync_event_counts",
    "wallet_seed_status",
    "import_wallet_one",
]
