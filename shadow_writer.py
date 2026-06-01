"""shadow_writer.py — Phase 2 durable shadow-write support.

This module is the ONLY place that touches the Phase 2 shadow-write
concern.  It is intentionally kept small and free of business logic.

Design rules
============
1. When USE_MONGO_POINTS_WRITE != "shadow", every public function is a
   no-op.  Zero extra latency, zero extra database traffic.
2. Every function is fire-and-never-raises: the caller (premium_ai_tools,
   payment_bridge, lucky_draw) must never fail because of a shadow-write
   error.  All exceptions are caught and logged as WARNING.
3. Idempotency keys are caller-supplied and must be derived from stable,
   per-GAS-transaction identifiers.  This module NEVER generates a random
   key of its own.
4. Durability: a Render restart between a GAS success and a completed
   shadow write must not lose the event.  The row is written to
   db.migration_sync_events with mongo_status="pending" before any wallet
   update is attempted.  The reconcile endpoint replays pending rows.
5. The caller supplies the Motor `db` handle (same pool as the live app).
   register_shadow_db() must be called from server.py startup so the
   module always writes to the same database as the live application.

Collections written
===================
• db.migration_sync_events   — durable per-event journal
• db.points_wallets          — wallet balance update (shadow only)
• db.points_transactions     — ledger row (shadow only)
"""

from __future__ import annotations

import logging
import os
from datetime import datetime, timezone
from typing import Any

log = logging.getLogger("eduhub.shadow_writer")

# ── Module-level db handle ────────────────────────────────────────────────────
# Set by register_shadow_db() during server startup.
# If never set, every call short-circuits via _get_mode() == "off".
_db = None


def register_shadow_db(db) -> None:
    """Call once from server.py startup with the live Motor db handle.

    This ensures shadow writes target the same database as the live app.
    Failure is non-fatal: if called with None the module stays in no-op mode.
    """
    global _db
    if db is None:
        log.warning("shadow_writer: register_shadow_db called with None — shadow writes disabled")
        return
    _db = db
    log.info("shadow_writer: registered live db handle — ready")


# ── Feature flag ─────────────────────────────────────────────────────────────

def _get_mode() -> str:
    """Read USE_MONGO_POINTS_WRITE at call time — never cached."""
    return (os.environ.get("USE_MONGO_POINTS_WRITE") or "off").strip().lower()


def _should_shadow() -> bool:
    return _get_mode() == "shadow" and _db is not None


# ── Timestamp helper ─────────────────────────────────────────────────────────

def _utcnow() -> str:
    return datetime.now(timezone.utc).isoformat()


# ── Core durable write ───────────────────────────────────────────────────────

# Status constants returned by _write_durable_event
_EV_INSERTED        = "inserted_new"       # freshly created → safe to apply wallet
_EV_ALREADY_APPLIED = "already_applied"    # idempotent hit, wallet already updated
_EV_ALREADY_PENDING = "already_pending"    # interrupted apply; reconciler handles
_EV_FAILED          = "failed"             # DB error


async def _write_durable_event(
    *,
    idempotency_key: str,
    student_id: str,
    operation: str,
    amount: float,
    source: str,
    source_ref: str,
    payload: dict[str, Any],
) -> str:
    """Upsert a migration_sync_events row and return its status.

    Returns one of the _EV_* constants above.  Never raises.

    Idempotency contract
    --------------------
    Only _EV_INSERTED means the event is new and _apply_wallet_shadow()
    may proceed.  For _EV_ALREADY_APPLIED the wallet was already updated
    in a previous call — do NOT apply again.  For _EV_ALREADY_PENDING
    the previous apply was interrupted; the reconcile endpoint will retry
    it safely — do NOT apply again here to avoid a double-increment.
    """
    db = _db
    if db is None:
        return _EV_FAILED
    now = _utcnow()
    try:
        # Read the existing event (if any) BEFORE the upsert so we can
        # distinguish newly-inserted from already-existing rows.
        existing = await db.migration_sync_events.find_one(
            {"idempotency_key": idempotency_key},
            {"_id": 0, "mongo_status": 1},
        )
        if existing is not None:
            status = existing.get("mongo_status", "pending")
            if status == "applied":
                return _EV_ALREADY_APPLIED
            # pending or failed → safe only for the reconciler, not here
            return _EV_ALREADY_PENDING

        # No existing row — attempt fresh insert.
        result = await db.migration_sync_events.update_one(
            {"idempotency_key": idempotency_key},
            {"$setOnInsert": {
                "idempotency_key": idempotency_key,
                "student_id":      student_id,
                "operation":       operation,
                "amount":          amount,
                "source":          source,
                "source_ref":      source_ref,
                "payload":         payload,
                "gas_status":      "confirmed",
                "mongo_status":    "pending",
                "created_at":      now,
                "applied_at":      None,
                "failure_reason":  None,
            }},
            upsert=True,
        )
        if result.upserted_id is not None:
            # Freshly inserted — safe to apply wallet
            return _EV_INSERTED
        # Race: another coroutine inserted between our find_one and update_one.
        # Re-read to get the correct status.
        race_doc = await db.migration_sync_events.find_one(
            {"idempotency_key": idempotency_key},
            {"_id": 0, "mongo_status": 1},
        )
        race_status = (race_doc or {}).get("mongo_status", "pending")
        return _EV_ALREADY_APPLIED if race_status == "applied" else _EV_ALREADY_PENDING
    except Exception as exc:  # noqa: BLE001
        log.warning(
            "shadow_writer: _write_durable_event failed ikey=%s: %s",
            idempotency_key[:20], str(exc)[:200],
        )
        return _EV_FAILED


async def _apply_wallet_shadow(
    *,
    student_id: str,
    amount: float,
    operation: str,
    source: str,
    idempotency_key: str,
) -> None:
    """Best-effort wallet + ledger update after the durable event is written.

    Uses $inc so it is safe even if the wallet row does not yet exist
    (the wallet was seeded via Phase 1.5, but a new student created after
    the seed would not have a row yet — the shadow write must not crash).
    Never raises.
    """
    db = _db
    if db is None:
        return
    now = _utcnow()
    wallet_delta = -abs(amount) if operation == "debit" else abs(amount)
    try:
        await db.points_wallets.update_one(
            {"student_id": student_id},
            {
                "$inc": {"balance": wallet_delta, "version": 1},
                "$set": {"updated_at": now},
            },
        )
    except Exception as exc:  # noqa: BLE001
        log.warning(
            "shadow_writer: wallet update failed student=%s: %s",
            student_id, str(exc)[:200],
        )
        return

    try:
        await db.points_transactions.update_one(
            {"idempotency_key": idempotency_key},
            {"$setOnInsert": {
                "idempotency_key": idempotency_key,
                "from_id":  student_id if operation == "debit" else "treasury",
                "to_id":    "treasury" if operation == "debit" else student_id,
                "amount":   abs(amount),
                "type":     operation,
                "source":   source,
                "source_ref": idempotency_key,
                "created_at": now,
                "status":   "shadow",
            }},
            upsert=True,
        )
    except Exception as exc:  # noqa: BLE001
        log.warning(
            "shadow_writer: ledger insert failed ikey=%s: %s",
            idempotency_key[:20], str(exc)[:200],
        )


# ── Public API ────────────────────────────────────────────────────────────────

async def shadow_debit(
    *,
    student_clean_id: str,
    student_mongo_id: str,
    amount: float,
    source: str,
    idempotency_key: str,
) -> None:
    """Record a confirmed GAS debit as a durable shadow event.

    Parameters
    ----------
    student_clean_id : str
        The human-readable GAS ID (e.g. "stu001") — for payload audit.
    student_mongo_id : str
        The MongoDB _id prefix (e.g. "stu_694670a45690") used as the
        wallet document key.  Pass student_clean_id if mongo_id is
        unavailable — the function will resolve it.
    amount : float
        Positive number of points debited.
    source : str
        Short label for the debiting system, e.g. "premium_ai", "edutalk".
    idempotency_key : str
        Stable per-GAS-transaction key.  Must be derived from identifiers
        that existed BEFORE the GAS call so replay produces the same key.
        Example: f"shadow:debit:{source}:{student_clean_id}:{gas_nonce}"
    """
    if not _should_shadow():
        return
    try:
        sid = await _resolve_student_id(student_clean_id, student_mongo_id)
        event_status = await _write_durable_event(
            idempotency_key=idempotency_key,
            student_id=sid,
            operation="debit",
            amount=abs(amount),
            source=source,
            source_ref=student_clean_id,
            payload={"clean_id": student_clean_id, "amount": amount, "source": source},
        )
        if event_status == _EV_INSERTED:
            # Freshly inserted — safe to apply wallet exactly once.
            await _apply_wallet_shadow(
                student_id=sid,
                amount=abs(amount),
                operation="debit",
                source=source,
                idempotency_key=idempotency_key,
            )
            await _mark_event_applied(idempotency_key)
        elif event_status == _EV_ALREADY_APPLIED:
            log.debug(
                "shadow_writer.shadow_debit idempotent skip ikey=%s",
                idempotency_key[:20],
            )
        elif event_status == _EV_ALREADY_PENDING:
            # Interrupted apply — reconciler will retry safely.
            log.warning(
                "shadow_writer.shadow_debit event pending ikey=%s "
                "(reconciler will retry)",
                idempotency_key[:20],
            )
        # _EV_FAILED: already logged in _write_durable_event
    except Exception as exc:  # noqa: BLE001
        log.warning(
            "shadow_writer.shadow_debit non-fatal error clean_id=%s: %s",
            student_clean_id, str(exc)[:200],
        )


async def shadow_credit(
    *,
    student_clean_id: str,
    student_mongo_id: str,
    amount: float,
    source: str,
    idempotency_key: str,
) -> None:
    """Record a confirmed GAS credit as a durable shadow event.

    Parameters
    ----------
    idempotency_key : str
        Must be derived from stable payment identifiers
        (transaction_id, apv, order_id, tran_id, telegram_message_id).
        NEVER use a random/local nonce — a Render restart would produce
        a different key on retry, causing a duplicate credit shadow.
        If no stable identifier exists, pass None and this function
        will skip the shadow write and log a warning.
    """
    if not _should_shadow():
        return
    if not idempotency_key:
        log.warning(
            "shadow_writer.shadow_credit skipped — no stable idempotency key "
            "for clean_id=%s amount=%s source=%s",
            student_clean_id, amount, source,
        )
        return
    try:
        sid = await _resolve_student_id(student_clean_id, student_mongo_id)
        event_status = await _write_durable_event(
            idempotency_key=idempotency_key,
            student_id=sid,
            operation="credit",
            amount=abs(amount),
            source=source,
            source_ref=student_clean_id,
            payload={"clean_id": student_clean_id, "amount": amount, "source": source},
        )
        if event_status == _EV_INSERTED:
            # Freshly inserted — safe to apply wallet exactly once.
            await _apply_wallet_shadow(
                student_id=sid,
                amount=abs(amount),
                operation="credit",
                source=source,
                idempotency_key=idempotency_key,
            )
            await _mark_event_applied(idempotency_key)
        elif event_status == _EV_ALREADY_APPLIED:
            log.debug(
                "shadow_writer.shadow_credit idempotent skip ikey=%s",
                idempotency_key[:20],
            )
        elif event_status == _EV_ALREADY_PENDING:
            log.warning(
                "shadow_writer.shadow_credit event pending ikey=%s "
                "(reconciler will retry)",
                idempotency_key[:20],
            )
    except Exception as exc:  # noqa: BLE001
        log.warning(
            "shadow_writer.shadow_credit non-fatal error clean_id=%s: %s",
            student_clean_id, str(exc)[:200],
        )


# ── Internal helpers ─────────────────────────────────────────────────────────

async def _resolve_student_id(clean_id: str, mongo_id: str) -> str:
    """Return the canonical student_id (mongo prefix form).

    Tries mongo_id first; falls back to a db.students lookup by clean_id.
    Returns clean_id if all else fails — still usable for audit, just
    won't match wallet documents created with the long hex prefix.
    """
    if mongo_id and mongo_id.startswith("stu_"):
        return mongo_id
    db = _db
    if db is None:
        return clean_id
    try:
        doc = await db.students.find_one(
            {"clean_id": clean_id},
            {"_id": 0, "student_id": 1},
        )
        if doc and doc.get("student_id"):
            return str(doc["student_id"])
    except Exception as exc:  # noqa: BLE001
        log.warning(
            "shadow_writer: _resolve_student_id lookup failed clean_id=%s: %s",
            clean_id, str(exc)[:120],
        )
    return clean_id


async def _mark_event_applied(idempotency_key: str) -> None:
    """Update mongo_status to 'applied' after successful wallet write."""
    db = _db
    if db is None:
        return
    try:
        await db.migration_sync_events.update_one(
            {"idempotency_key": idempotency_key},
            {"$set": {"mongo_status": "applied", "applied_at": _utcnow()}},
        )
    except Exception as exc:  # noqa: BLE001
        log.warning(
            "shadow_writer: _mark_event_applied failed ikey=%s: %s",
            idempotency_key[:20], str(exc)[:120],
        )
