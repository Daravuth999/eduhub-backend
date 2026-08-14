"""
speaking_lab_enrollment_audit.py — durable, queryable audit trail for
every Speaking Lab Direct Join enrollment attempt (v1.0)
=============================================================================

Purpose
-------
The enrollment/ticket-assignment core (`speaking_lab_direct_join.py`) is
already an atomic, exactly-once, idempotent transaction. What it lacked
was a DURABLE record of every attempt's outcome — the one reliability
requirement not previously met. This module adds that trail so the
question "did every eligible participant who tapped Join receive their
Lucky Ticket?" becomes VERIFIABLE from data, not hopeful.

Design contract (why this is safe to add to a financial flow)
-------------------------------------------------------------
  * PURELY ADDITIVE / OBSERVABILITY ONLY — it never reads or writes any
    wallet, entry, code, or session collection. It only appends to its
    own `speaking_lab_enrollment_audit` collection.
  * ALWAYS FAILS OPEN — every write is wrapped so an audit failure can
    NEVER change, delay, or abort an enrollment outcome. Mirrors the
    exactly-once push helper's "notification failure never affects the
    join" guarantee.
  * RUNS OUTSIDE THE PAYMENT TRANSACTION — a rolled-back enrollment
    still leaves an audit row explaining WHY it failed, which is exactly
    the forensic value we want.
  * STORES NO SECRET — student id + session id + outcome + reason are
    the same identifiers already present throughout the Speaking Lab
    data model; the Lucky Code itself is intentionally NOT stored here
    (only a boolean `lucky_code_assigned`), so the audit trail is never
    an alternate source of a student's ticket.
"""
from __future__ import annotations

import logging
import uuid
from datetime import datetime, timezone
from typing import Optional

logger = logging.getLogger("eduhub.speaking_lab_enrollment_audit")

COLLECTION_ENROLLMENT_AUDIT = "speaking_lab_enrollment_audit"


def _utcnow_iso() -> str:
    return datetime.now(timezone.utc).isoformat()


async def ensure_enrollment_audit_indexes(db) -> bool:
    """Best-effort indexes for the two queries this trail exists to
    answer: 'show every attempt for session X' and 'show this student's
    attempt history'. Never raises — a missing index degrades query
    speed, never correctness, and must not block startup."""
    try:
        coll = db[COLLECTION_ENROLLMENT_AUDIT]
        await coll.create_index(
            [("session_id", 1), ("ts", 1)], name="idx_enroll_audit_session_ts")
        await coll.create_index(
            [("student_id", 1), ("ts", 1)], name="idx_enroll_audit_student_ts")
        await coll.create_index([("audit_id", 1)], unique=True, name="uq_enroll_audit_id")
        logger.info("speaking_lab_enrollment_audit: indexes ensured")
        return True
    except Exception as exc:  # noqa: BLE001
        logger.warning("speaking_lab_enrollment_audit: index ensure failed: %s", exc)
        return False


async def record_enrollment_attempt(
    db,
    *,
    session_id: str,
    student_id: str,
    outcome: str,
    reason_code: str,
    http_status: int,
    idempotency_key: Optional[str] = None,
    idempotent_replay: Optional[bool] = None,
    lucky_code_assigned: bool = False,
    join_id: Optional[str] = None,
    log: Optional[logging.Logger] = None,
) -> None:
    """Append one durable audit row for an enrollment attempt. NEVER
    raises — any failure is logged and swallowed so the caller's
    enrollment outcome is completely unaffected.

    ``outcome`` is the terminal classification, e.g. one of:
      committed | replayed | adopted_legacy   (success — ticket held)
      rejected | insufficient_points | wallet_blocked |
      join_temporarily_unavailable | wallet_not_ready | uncertain |
      server_error                             (no ticket assigned)
    """
    L = log or logger
    try:
        doc = {
            "audit_id": "sla_" + uuid.uuid4().hex,
            "ts": _utcnow_iso(),
            "session_id": session_id,
            "student_id": student_id,
            "outcome": outcome,
            "reason_code": reason_code,
            "http_status": int(http_status),
            "idempotency_key": idempotency_key,
            "idempotent_replay": idempotent_replay,
            "lucky_code_assigned": bool(lucky_code_assigned),
            "join_id": join_id,
        }
        await db[COLLECTION_ENROLLMENT_AUDIT].insert_one(doc)
    except Exception as exc:  # noqa: BLE001
        L.warning(
            "speaking_lab_enrollment_audit: record failed (enrollment "
            "outcome unaffected) session=%s student=%s outcome=%s err=%s",
            session_id, student_id, outcome, str(exc)[:200],
        )
