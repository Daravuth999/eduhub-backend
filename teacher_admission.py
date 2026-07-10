"""
teacher_admission.py — Speaking Lab Emergency Teacher Admit (v1.1.1)
=====================================================================

This module is a NARROW, ADDITIVE recovery route for one student in one
explicit Speaking Lab session. It NEVER moves money, NEVER edits a
student's balance, NEVER touches the protected lucky-draw / payout
logic in ``lucky_draw.py`` (which remains byte-for-byte unchanged), and
NEVER changes any unrelated EduHub system (payments, EduTalk, Premium
AI, library, referrals, login rewards, coupons, PWA, …).

What changed in v1.1.1 vs v1.1
------------------------------

The independent audit of v1.1 produced 10 release-blocker findings.
v1.1.1 fixes all 10, *without* broadening the feature:

  1. **Synthetic roster row linking.**  The production ``/enter`` flow
     creates rows with a synthetic ``sl-<12hex>`` ``student_id``. When
     the teacher subsequently admits the *real* canonical student,
     v1.1 hit a unique-index collision on ``display_name_key``. v1.1.1
     safely *links* the synthetic row to the canonical student under
     strict conditions and preserves ``position`` / ``entered_at``.

  2. **Prior-state snapshot + restore on failure.** Any field we may
     mutate on a pre-existing entry is captured first. On a later
     failure we restore the EXACT prior values (and remove additive
     fields we introduced).

  3. **Mandatory audit completion.** A successful response now
     requires a read-back of the audit document with
     ``status_after == "admitted"``, the persisted code, the right
     ``session_id`` / ``student_id`` and the right normalised
     reference. If the completion write or read-back fails, we roll
     back and return 5xx (no silent partial state).

  4. **Operation state machine + resume.** Each admission has an
     explicit state: ``pending → processing → admitted`` (or
     ``failed_retriable``/``rolled_back``). A retry with the same
     (session, student, normalised reference) RESUMES the existing
     operation; a same-ref-different-target is rejected.

  5. **Orphan code rollback + provenance.** Codes created by THIS
     operation carry ``admit_audit_id`` / ``admit_reference`` /
     ``source = teacher_emergency_admit`` / ``admit_by`` /
     ``admitted_at``. Rollback removes ONLY operation-owned codes; a
     legitimate pre-existing code is never touched. The provenance
     write is mandatory and verified.

  6. **Index health gate.** The route checks an ``_index_healthy``
     flag set by ``ensure_teacher_admission_indexes``. If the unique
     ``normalized_transfer_reference`` index is missing or its
     creation failed, the route fails closed (503) — startup itself
     remains non-fatal.

  7. **Real concurrency.** Tests use ``asyncio.gather`` against the
     real route (httpx ``AsyncClient``) so two simultaneous identical
     requests converge to one entry, one code, one completed audit.

  8. **Enrollment policy fails closed.** When the session declares a
     schedule and the student carries no verifiable matching schedule
     or group, admission is REJECTED with reason
     ``student_enrollment_unverified``. No hidden override.

  9. **Gameplay participation update.** The response advertises the
     canonical student so the frontend can add it to the active
     ``presentSet`` after success.

 10. **Frontend additivity preserved.** Original
     ``SpeakingLabPage.jsx`` / ``PoolScanner.jsx`` /
     ``speakingLabApi.js`` shipped with the v1.1.1 ZIP are the
     full upstream files plus minimal additive edits.

This module is registered from ``server.py`` via
``register_teacher_admission_routes(...)`` and all production
collaborators (``db``, ``SL_SESSIONS``, ``SL_ENTRIES``, ``_sl_publish``,
``require_admin``, ``_norm_student_id``,
``generate_and_publish_lucky_code``) are injected — there are no
placeholder dependencies anywhere.
"""

from __future__ import annotations

import asyncio
import logging
import re
import uuid
from datetime import datetime, timedelta, timezone
from typing import Any, Callable, Awaitable, Optional

from fastapi import APIRouter, Depends, HTTPException, status
from pydantic import BaseModel, ConfigDict, Field, field_validator

logger = logging.getLogger("eduhub.teacher_admission")


# ──────────────────────────────────────────────────────────────────────────────
# Collection names — match production exactly
# ──────────────────────────────────────────────────────────────────────────────
COLLECTION_ADMISSIONS = "speaking_lab_teacher_admissions"
COLLECTION_CODES      = "speaking_lab_lucky_codes"

# Session states production considers "open for entry" *pre-draw*.
ALLOWED_SESSION_STATES = {"waiting", "active"}

# Synthetic student-id pattern emitted by the production /enter flow
# (server.py: f"sl-{uuid.uuid4().hex[:12]}").
SYNTHETIC_ID_RE = re.compile(r"^sl-[0-9a-f]{6,32}$")


def _is_synthetic_id(sid: Optional[str]) -> bool:
    return bool(sid and SYNTHETIC_ID_RE.match(str(sid)))


def _draw_locked(sess: dict) -> Optional[str]:
    if sess.get("lucky_draw_done"):
        return "draw_completed"
    if sess.get("lucky_draw_prepared_draw_id"):
        return "draw_prepared"
    return None


# ──────────────────────────────────────────────────────────────────────────────
# Reference normalisation
# ──────────────────────────────────────────────────────────────────────────────
_WHITESPACE_RE = re.compile(r"\s+")


def normalize_reference(raw: str) -> str:
    """Trim, collapse internal whitespace, lowercase."""
    if raw is None:
        return ""
    s = str(raw).strip()
    s = _WHITESPACE_RE.sub(" ", s)
    return s.lower()


def parse_transfer_datetime(raw: str) -> str:
    if not raw:
        raise ValueError("transfer datetime is required")
    s = str(raw).strip()
    s_norm = s.replace("Z", "+00:00") if s.endswith("Z") else s
    dt = datetime.fromisoformat(s_norm)
    if dt.tzinfo is None:
        dt = dt.replace(tzinfo=timezone.utc)
    return dt.astimezone(timezone.utc).isoformat()


def utcnow() -> datetime:
    return datetime.now(timezone.utc)


# ──────────────────────────────────────────────────────────────────────────────
# Schedule normalisation — single source of truth is students.group.
# ALLOWED values are "A" / "B"; anything blank/None means "Unassigned".
# ──────────────────────────────────────────────────────────────────────────────
ALLOWED_SCHEDULE_VALUES = {"A", "B"}


def _normalize_schedule(raw: Optional[str]) -> str:
    """Uppercase/trim a schedule value. Returns "" for unassigned/blank.

    Does NOT validate against ALLOWED_SCHEDULE_VALUES — callers that need
    to reject invalid input (anything other than "A"/"B"/blank) must check
    that separately, since some callers (candidate classification) must
    tolerate legacy/free-form group values without raising.
    """
    if raw is None:
        return ""
    s = str(raw).strip().upper()
    # Legacy students.group sometimes carries "A:Beginner" style values —
    # only the part before ":" is the schedule.
    if ":" in s:
        s = s.split(":", 1)[0].strip()
    return s


# ──────────────────────────────────────────────────────────────────────────────
# Request / response models
# ──────────────────────────────────────────────────────────────────────────────
class TeacherAdmitRequest(BaseModel):
    model_config = ConfigDict(extra="ignore")

    student_id: str = Field(..., min_length=1, max_length=64)
    points_sent: int = Field(..., ge=1, le=1_000_000)
    transfer_reference: str = Field(..., min_length=1, max_length=128)
    transfer_datetime: str = Field(..., min_length=1, max_length=64)
    verification_method: str = Field(..., min_length=1, max_length=64)
    teacher_explanation: str = Field(..., min_length=1, max_length=1024)
    teacher_confirmed: bool
    # v4 (FIX 5): explicit human-authorized external-verification override for
    # empty-group admission when automatic authoritative ledger verification is
    # unavailable. Defaults False (no override).
    confirm_external_verification: bool = False

    @field_validator(
        "student_id", "transfer_reference", "transfer_datetime",
        "verification_method", "teacher_explanation",
        mode="before",
    )
    @classmethod
    def _strip_strings(cls, v: Any) -> Any:
        if isinstance(v, str):
            return v.strip()
        return v


class TeacherAdmitResponse(BaseModel):
    ok: bool = True
    session_id: str
    student_id: str
    display_name: str
    lucky_code: str
    entry_fee: int
    pool_total: int
    player_count: int
    eligible_to_play: bool = True
    admission_id: str
    admitted_at: str
    idempotent_replay: bool = False
    linked_synthetic_entry: bool = False
    # Hint to the frontend so it can update presentSet without reload.
    participant: dict = Field(default_factory=dict)


# ──────────────────────────────────────────────────────────────────────────────
# Index health
# ──────────────────────────────────────────────────────────────────────────────
class _IndexHealth:
    """Tiny module-level health flag used by Correction 6.

    ``ensure_teacher_admission_indexes`` flips ``unique_ref_ok`` to True
    only when the unique index on ``normalized_transfer_reference`` was
    created (or already existed). The route then refuses to run if the
    flag is False.
    """
    unique_ref_ok: bool = False
    last_error: str = ""


async def ensure_teacher_admission_indexes(db) -> bool:
    """Create indexes required by the route. Non-fatal at startup; the
    *route* will fail closed if the critical unique index is unhealthy."""
    _IndexHealth.unique_ref_ok = False
    _IndexHealth.last_error = ""
    try:
        admissions = db[COLLECTION_ADMISSIONS]
        await admissions.create_index(
            [("normalized_transfer_reference", 1)],
            unique=True,
            name="uq_teacher_admit_reference",
        )
        await admissions.create_index(
            [("session_id", 1), ("student_id", 1)],
            name="idx_teacher_admit_session_student",
        )
        await admissions.create_index(
            [("admission_id", 1)],
            unique=True,
            name="uq_teacher_admit_admission_id",
        )
        _IndexHealth.unique_ref_ok = True
        logger.info("teacher_admission: indexes ensured (unique_ref_ok=True).")
        return True
    except Exception as exc:  # noqa: BLE001
        _IndexHealth.last_error = str(exc)[:240]
        logger.warning("teacher_admission: index ensure failed: %s", exc)
        return False


def _force_index_health(ok: bool, last_error: str = "") -> None:
    """Test-only helper to drive the health gate without touching Mongo."""
    _IndexHealth.unique_ref_ok = ok
    _IndexHealth.last_error = last_error


# ──────────────────────────────────────────────────────────────────────────────
# Pool snapshot — identical formula to the production helper.
# ──────────────────────────────────────────────────────────────────────────────
async def _pool_snapshot(db, session_id: str) -> dict:
    total = 0
    n = 0
    cur = db[COLLECTION_CODES].find(
        {"session_id": session_id}, {"_id": 0, "entry_fee": 1},
    )
    async for r in cur:
        n += 1
        total += int(r.get("entry_fee") or 0)
    return {"pool_total": total, "player_count": n}


# ──────────────────────────────────────────────────────────────────────────────
# Helpers — synthetic linking + entry snapshot/restore
# ──────────────────────────────────────────────────────────────────────────────
_ENTRY_PROTECTED_KEYS = ("position", "entered_at")
_ENTRY_MUTABLE_KEYS = (
    "student_id", "display_name", "display_name_key",
    "paid_entry", "eligible", "source",
    "admit_source", "admit_audit_id", "admit_reference",
    "admit_amount", "admit_time", "admit_by", "admit_at",
    "linked_from_synthetic_id",
)


def _snapshot_entry(doc: dict) -> dict:
    """Return a dict containing every value we may mutate later, plus a
    sentinel `_existed` flag for keys absent before our writes."""
    snap = {"_existed_keys": list(doc.keys())}
    for k in (*_ENTRY_PROTECTED_KEYS, *_ENTRY_MUTABLE_KEYS):
        if k in doc:
            snap[k] = doc[k]
    return snap


async def _restore_entry(SL_ENTRIES, session_id: str, snapshot: dict,
                         current_student_id: str) -> bool:
    """Restore an entry row to its captured ``snapshot``.

    Returns True iff the database row matches the snapshot afterwards.
    """
    if not snapshot:
        return False
    existed = set(snapshot.get("_existed_keys", []))
    set_ops: dict = {}
    unset_ops: dict = {}
    for k in _ENTRY_MUTABLE_KEYS:
        if k in snapshot:
            set_ops[k] = snapshot[k]
        elif k not in existed:
            # field was not present originally — strip what we added
            unset_ops[k] = ""
    update: dict = {}
    if set_ops:
        update["$set"] = set_ops
    if unset_ops:
        update["$unset"] = unset_ops
    try:
        await SL_ENTRIES.update_one(
            {"session_id": session_id, "student_id": current_student_id},
            update,
        )
        # Verify
        verify = await SL_ENTRIES.find_one(
            {"session_id": session_id, "student_id": snapshot.get(
                "student_id", current_student_id)},
            {"_id": 0},
        )
        if not verify:
            return False
        for k, v in set_ops.items():
            if verify.get(k) != v:
                return False
        for k in unset_ops:
            if k in verify:
                return False
        return True
    except Exception as exc:  # noqa: BLE001
        logger.error("teacher_admit restore_entry FAILED: %s", str(exc)[:240])
        return False


# ──────────────────────────────────────────────────────────────────────────────
# Missing Code Rescue — human-reviewed recovery for "paid but no code" (v1.0)
# ──────────────────────────────────────────────────────────────────────────────
# IMPORTANT: `push_credit_log` (surfaced here via the injected
# ``find_recent_treasury_credits`` callable) is a CLIENT-SUBMITTED
# notification, NOT an authoritative treasury ledger — see
# server.py's ``_verify_pool_payment_evidence`` for the same caveat. This
# feature never claims automatic payment verification. It only turns a raw
# push_credit_log row into a *reviewable candidate*; the teacher must
# explicitly confirm (tap Restore) each one before any pool entry / lucky
# code is created. No wallet balance is ever touched and no GAS/provider
# call is made — recovery only repairs the pool-entry surface, exactly like
# the existing ``/pool/reconcile`` endpoint.
COLLECTION_RECOVERIES = "speaking_lab_missing_code_recoveries"


class _RecoveryIndexHealth:
    unique_ref_ok: bool = False
    last_error: str = ""


async def ensure_missing_code_recovery_indexes(db) -> bool:
    """Create indexes required by Missing Code Rescue. Non-fatal at
    startup; the routes fail closed if the unique indexes are unhealthy."""
    _RecoveryIndexHealth.unique_ref_ok = False
    _RecoveryIndexHealth.last_error = ""
    try:
        recoveries = db[COLLECTION_RECOVERIES]
        await recoveries.create_index(
            [("normalized_source_reference", 1)],
            unique=True,
            name="uq_missing_code_recovery_reference",
        )
        await recoveries.create_index(
            [("session_id", 1), ("student_id", 1)],
            unique=True,
            name="uq_missing_code_recovery_session_student",
        )
        await recoveries.create_index(
            [("recovery_id", 1)],
            unique=True,
            name="uq_missing_code_recovery_id",
        )
        _RecoveryIndexHealth.unique_ref_ok = True
        logger.info("missing_code_recovery: indexes ensured (unique_ref_ok=True).")
        return True
    except Exception as exc:  # noqa: BLE001
        _RecoveryIndexHealth.last_error = str(exc)[:240]
        logger.warning("missing_code_recovery: index ensure failed: %s", exc)
        return False


def _force_recovery_index_health(ok: bool, last_error: str = "") -> None:
    """Test-only helper to drive the health gate without touching Mongo."""
    _RecoveryIndexHealth.unique_ref_ok = ok
    _RecoveryIndexHealth.last_error = last_error


class MissingCodeCandidate(BaseModel):
    student_id: str
    student_name: str
    claimed_amount: int
    transfer_time: str
    transfer_reference: str
    entry_fee: int
    current_status: str
    status: str
    restorable: bool
    reason: str = ""
    student_schedule: str = ""


class MissingCodeCandidatesResponse(BaseModel):
    ok: bool = True
    session_id: str
    session_schedule: str = ""
    entry_fee: int
    candidates: list[MissingCodeCandidate] = Field(default_factory=list)
    restorable_count: int = 0


class RecoverMissingCodeRequest(BaseModel):
    model_config = ConfigDict(extra="ignore")
    student_id: str = Field(..., min_length=1, max_length=64)
    teacher_confirmed: bool


class RecoverMissingCodeResult(BaseModel):
    ok: bool = True
    student_id: str
    display_name: str = ""
    outcome: str
    reason: str = ""
    lucky_code: str = ""
    entry_fee: int = 0
    pool_total: int = 0
    player_count: int = 0
    recovery_id: str = ""
    idempotent_replay: bool = False


class RecoverMissingCodesBulkRequest(BaseModel):
    model_config = ConfigDict(extra="ignore")
    student_ids: list[str] = Field(..., min_length=1, max_length=200)
    teacher_confirmed: bool


class RecoverMissingCodesBulkResponse(BaseModel):
    ok: bool = True
    session_id: str
    restored_count: int = 0
    skipped_count: int = 0
    results: list[RecoverMissingCodeResult] = Field(default_factory=list)


async def _lookup_student_record(db, norm_id: str) -> dict:
    student_doc = await db.students.find_one(
        {"$or": [{"clean_id": norm_id}, {"student_id": norm_id}]},
        {"_id": 0, "display_name": 1, "name": 1, "group": 1, "schedule": 1},
    )
    return student_doc or {}


def session_schedule_eligibility(
    student_group_raw: Optional[str], session_schedule_raw: Optional[str],
) -> tuple[bool, str]:
    """Single shared eligibility rule, reused by Missing Code Rescue
    (``_gather_candidate``) and Speaking Lab Direct Join so both surfaces
    enforce the IDENTICAL rule rather than two hand-maintained copies.

    ``session_schedule_raw`` may be "A", "B", "AB" (Combined), or blank
    (no restriction — every student eligible, matching pre-Schedule-
    Assignment behavior). Returns ``(eligible, reason)`` where reason is
    one of "" | "schedule_assignment_required" | "wrong_schedule".

    Combined ("AB") sessions accept A, B, AND Unassigned students
    automatically for that session — this function never mutates
    anything, so an Unassigned student accepted here remains Unassigned
    afterward by construction."""
    session_schedule = _normalize_schedule(session_schedule_raw)
    if not session_schedule:
        return True, ""
    if session_schedule == "AB":
        return True, ""
    student_schedule = _normalize_schedule(student_group_raw)
    if not student_schedule:
        return False, "schedule_assignment_required"
    if student_schedule != session_schedule:
        return False, "wrong_schedule"
    return True, ""


async def _gather_candidate(
    db, SL_ENTRIES, session_id: str, entry_fee: int, norm_id: str,
    row: Optional[dict], session_schedule: str = "",
) -> dict:
    """Classify one push_credit_log row into a reviewable candidate.

    NEVER treats the row as proof of payment — only as a reviewable
    signal a human teacher must confirm before anything is created.
    """
    student_doc = await _lookup_student_record(db, norm_id)
    display_name = (
        student_doc.get("display_name") or student_doc.get("name") or norm_id
    )
    student_schedule = _normalize_schedule(
        student_doc.get("group") or student_doc.get("schedule") or "",
    )
    claimed_amount = int((row or {}).get("amount") or 0)
    raw_ref = str((row or {}).get("transferId") or "").strip()
    normalized_ref = normalize_reference(raw_ref)
    created_at = (row or {}).get("createdAt")
    transfer_time = (
        created_at.isoformat() if hasattr(created_at, "isoformat")
        else str(created_at or "")
    )

    entry_doc = await SL_ENTRIES.find_one(
        {"session_id": session_id, "student_id": norm_id}, {"_id": 0},
    )
    code_doc = await db[COLLECTION_CODES].find_one(
        {"session_id": session_id, "student_id": norm_id}, {"_id": 0},
    )
    has_entry, has_code = bool(entry_doc), bool(code_doc)
    current_status = (
        "has_entry_and_code" if (has_entry and has_code)
        else "has_entry_no_code" if has_entry
        else "no_entry_no_code"
    )
    base = {
        "display_name": display_name, "claimed_amount": claimed_amount,
        "transfer_time": transfer_time, "transfer_reference": raw_ref,
        "normalized_reference": normalized_ref,
        "current_status": current_status,
        "entry_doc": entry_doc, "code_doc": code_doc,
        "student_schedule": student_schedule,
    }

    if has_entry and has_code:
        return {**base, "status": "already_has_code", "restorable": False,
                "reason": ""}

    # Persistent schedule assignment gate — a student must be assigned to
    # THIS session's schedule before Missing Code Rescue may restore them.
    # Never inferred/auto-assigned here; see the schedule-assignment routes.
    # Shared with Speaking Lab Direct Join via `session_schedule_eligibility`
    # so both surfaces enforce the identical rule (including Combined A+B).
    eligible, ineligible_reason = session_schedule_eligibility(
        student_schedule, session_schedule)
    if not eligible:
        return {**base, "status": "manual_review_required",
                "restorable": False, "reason": ineligible_reason}

    if not raw_ref:
        return {**base, "status": "manual_review_required",
                "restorable": False, "reason": "missing_transfer_reference"}
    if claimed_amount != int(entry_fee or 0):
        return {**base, "status": "manual_review_required",
                "restorable": False, "reason": "amount_mismatch"}

    existing_recovery = await db[COLLECTION_RECOVERIES].find_one(
        {"normalized_source_reference": normalized_ref}, {"_id": 0},
    )
    if existing_recovery:
        if existing_recovery.get("session_id") == session_id \
                and existing_recovery.get("student_id") == norm_id \
                and existing_recovery.get("status") == "restored":
            return {**base, "status": "already_restored", "restorable": False,
                    "reason": "", "existing_recovery": existing_recovery}
        return {**base, "status": "manual_review_required",
                "restorable": False, "reason": "reference_already_consumed"}

    existing_admission = await db[COLLECTION_ADMISSIONS].find_one(
        {"normalized_transfer_reference": normalized_ref,
         "status_after": "admitted"}, {"_id": 0},
    )
    if existing_admission:
        return {**base, "status": "manual_review_required",
                "restorable": False, "reason": "reference_already_consumed"}

    return {**base, "status": "review_required", "restorable": True,
            "reason": ""}


# ──────────────────────────────────────────────────────────────────────────────
# Schedule Assignment — persistent A/B roster split (v1.0)
# ──────────────────────────────────────────────────────────────────────────────
# The existing generic `PATCH /teacher/students/{id}` (server.py) is shared
# with Author Studio / the original PWA and is intentionally left untouched
# here. These routes are Speaking-Lab-scoped but write the SAME
# ``students.group`` field — there is no second source of truth.
COLLECTION_SCHEDULE_AUDIT = "speaking_lab_schedule_assignments"


async def ensure_schedule_assignment_indexes(db) -> bool:
    """Best-effort index creation for the append-only assignment audit
    log. Non-fatal — this is a low-stakes audit trail, not a durable
    uniqueness contract, so no fail-closed health gate is needed."""
    try:
        audit = db[COLLECTION_SCHEDULE_AUDIT]
        await audit.create_index([("assignment_id", 1)], unique=True,
                                  name="uq_schedule_assignment_id")
        await audit.create_index([("student_id", 1), ("changed_at", -1)],
                                  name="idx_schedule_assignment_student")
        return True
    except Exception as exc:  # noqa: BLE001
        logger.warning("schedule_assignment: index ensure failed: %s", exc)
        return False


class UpdateStudentScheduleRequest(BaseModel):
    model_config = ConfigDict(extra="ignore")
    schedule: Optional[str] = None
    confirm: bool = False
    session_context_id: Optional[str] = None


class UpdateStudentScheduleResult(BaseModel):
    ok: bool = True
    student_id: str
    student_name: str = ""
    previous_schedule: str = ""
    new_schedule: str = ""
    outcome: str
    reason: str = ""


class BulkUpdateScheduleRequest(BaseModel):
    model_config = ConfigDict(extra="ignore")
    student_ids: list[str] = Field(..., min_length=1, max_length=500)
    schedule: Optional[str] = None
    confirm: bool = False
    session_context_id: Optional[str] = None


class BulkUpdateScheduleResponse(BaseModel):
    ok: bool = True
    updated_count: int = 0
    skipped_count: int = 0
    results: list[UpdateStudentScheduleResult] = Field(default_factory=list)


def _validate_schedule_target(raw: Optional[str]) -> str:
    """Normalise + validate a requested schedule value. Raises 422 for
    anything other than "A", "B", or blank/None (unassign)."""
    target = _normalize_schedule(raw)
    if raw not in (None, "") and target not in ALLOWED_SCHEDULE_VALUES:
        raise HTTPException(
            422, "schedule must be 'A', 'B', or empty/null (unassigned).",
        )
    return target


async def _has_active_entry_in_other_schedule(
    db, SL_SESSIONS, SL_ENTRIES, norm_id: str, target_schedule: str,
) -> Optional[str]:
    """Return the conflicting session_id if the student already has a pool
    entry or lucky code in an OPEN session whose schedule differs from
    ``target_schedule``; None if there is no conflict."""
    cur = SL_SESSIONS.find(
        {}, {"_id": 0, "session_id": 1, "schedule": 1, "status": 1,
             "lucky_draw_done": 1, "lucky_draw_prepared_draw_id": 1},
    )
    async for sess in cur:
        sess_schedule = _normalize_schedule(sess.get("schedule") or "")
        if not sess_schedule or sess_schedule == target_schedule:
            continue
        if _draw_locked(sess):
            continue
        status = (sess.get("status") or "").strip().lower()
        if status not in ALLOWED_SESSION_STATES:
            continue
        sid = sess.get("session_id")
        if not sid:
            continue
        has_entry = await SL_ENTRIES.find_one(
            {"session_id": sid, "student_id": norm_id},
            {"_id": 0, "student_id": 1},
        )
        has_code = await db[COLLECTION_CODES].find_one(
            {"session_id": sid, "student_id": norm_id},
            {"_id": 0, "student_id": 1},
        )
        if has_entry or has_code:
            return sid
    return None


async def _assign_schedule_one(
    db, SL_SESSIONS, SL_ENTRIES, norm_student_id, student_id_raw: str,
    target_schedule: str, confirm: bool, session_context_id: Optional[str],
    teacher_identity: str,
) -> UpdateStudentScheduleResult:
    norm_id = norm_student_id(student_id_raw)
    if not norm_id:
        return UpdateStudentScheduleResult(
            ok=False, student_id=str(student_id_raw or ""),
            outcome="not_found", reason="invalid_student_id",
        )
    student_doc = await db.students.find_one(
        {"$or": [{"clean_id": norm_id}, {"student_id": norm_id}]},
        {"_id": 0, "display_name": 1, "name": 1, "group": 1,
         "student_id": 1, "clean_id": 1},
    )
    if not student_doc:
        return UpdateStudentScheduleResult(
            student_id=norm_id, outcome="not_found",
            reason="student_not_found",
        )
    display_name = (
        student_doc.get("display_name") or student_doc.get("name") or norm_id
    )
    previous = _normalize_schedule(student_doc.get("group") or "")

    if previous == target_schedule:
        return UpdateStudentScheduleResult(
            student_id=norm_id, student_name=display_name,
            previous_schedule=previous, new_schedule=target_schedule,
            outcome="unchanged",
        )

    # Hard safety block — never silently move a student who already has an
    # active pool entry / lucky code under a DIFFERENT schedule's open
    # session. `confirm` cannot override this; it must be resolved manually.
    conflict_session = await _has_active_entry_in_other_schedule(
        db, SL_SESSIONS, SL_ENTRIES, norm_id, target_schedule,
    )
    if conflict_session:
        return UpdateStudentScheduleResult(
            student_id=norm_id, student_name=display_name,
            previous_schedule=previous, new_schedule=target_schedule,
            outcome="blocked_active_elsewhere",
            reason=f"active_entry_in_session:{conflict_session}",
        )

    # Reassigning an ALREADY-assigned student (A<->B, or A/B->unassigned)
    # requires an explicit confirmation. Assigning a previously-unassigned
    # student never requires it.
    if previous and not confirm:
        return UpdateStudentScheduleResult(
            student_id=norm_id, student_name=display_name,
            previous_schedule=previous, new_schedule=target_schedule,
            outcome="confirmation_required",
            reason="reassigning an already-assigned student requires "
                   "explicit confirmation",
        )

    canonical_student_id = (
        student_doc.get("student_id") or student_doc.get("clean_id") or norm_id
    )
    await db.students.update_one(
        {"student_id": canonical_student_id},
        {"$set": {"group": target_schedule}},
    )
    audit_doc = {
        "assignment_id":         str(uuid.uuid4()),
        "student_id":            canonical_student_id,
        "previous_schedule":     previous,
        "new_schedule":          target_schedule,
        "authenticated_teacher": teacher_identity,
        "session_context_id":    session_context_id or "",
        "changed_at":            utcnow().isoformat(),
    }
    await db[COLLECTION_SCHEDULE_AUDIT].insert_one(audit_doc)
    return UpdateStudentScheduleResult(
        student_id=norm_id, student_name=display_name,
        previous_schedule=previous, new_schedule=target_schedule,
        outcome="updated",
    )


# ──────────────────────────────────────────────────────────────────────────────
# Route factory
# ──────────────────────────────────────────────────────────────────────────────
def register_teacher_admission_routes(
    api: APIRouter,
    db,
    SL_SESSIONS,
    SL_ENTRIES,
    sl_publish: Callable[[str, dict], Awaitable[None]],
    require_admin_dep,
    norm_student_id: Callable[[Any], str],
    generate_and_publish_lucky_code: Callable[..., Awaitable[Optional[dict]]],
    log: Optional[logging.Logger] = None,
    verify_pool_payment: Optional[Callable[..., Awaitable[Optional[dict]]]] = None,
    find_recent_treasury_credits: Optional[
        Callable[..., Awaitable[list[dict]]]
    ] = None,
) -> None:
    L = log or logger

    # Per-process lock for the per-(session, ref) idempotency window. The
    # *durable* uniqueness contract is the Mongo unique index — this lock
    # only short-circuits the duplicate work locally so test
    # `asyncio.gather` does not double-write before the reservation lands.
    _serialize_lock = asyncio.Lock()

    # Separate lock for Missing Code Rescue so it never contends with the
    # unrelated teacher-admit path above.
    _recovery_lock = asyncio.Lock()

    @api.post(
        "/speaking-lab/sessions/{session_id}/teacher-admit",
        response_model=TeacherAdmitResponse,
        status_code=status.HTTP_200_OK,
        summary="Emergency Teacher Admit — restore eligibility for one "
                "student in one session",
    )
    async def teacher_admit(
        session_id: str,
        body: TeacherAdmitRequest,
        admin=Depends(require_admin_dep),
    ) -> TeacherAdmitResponse:
        # ── 0. Index-health gate (Correction 6) ─────────────────────────────
        if not _IndexHealth.unique_ref_ok:
            raise HTTPException(
                503,
                {
                    "detail": "Teacher admit unavailable: unique reference "
                              "index is unhealthy. Retry once indexes are "
                              "rebuilt.",
                    "index_health_error": _IndexHealth.last_error or "unknown",
                },
            )

        # ── 1. Lightweight pre-checks ───────────────────────────────────────
        if not body.teacher_confirmed:
            raise HTTPException(422, "Teacher confirmation is required.")
        normalized_ref = normalize_reference(body.transfer_reference)
        if not normalized_ref:
            raise HTTPException(422, "Transfer reference must not be blank.")
        try:
            transfer_time_iso = parse_transfer_datetime(body.transfer_datetime)
        except ValueError as exc:
            raise HTTPException(422, f"Invalid transfer datetime: {exc}") from exc

        # ── 2. Session lookup (production schema) ───────────────────────────
        sess = await SL_SESSIONS.find_one({"session_id": session_id})
        if not sess:
            raise HTTPException(404, "Session not found.")
        locked = _draw_locked(sess)
        if locked:
            raise HTTPException(409, f"Session is locked for admission ({locked}).")
        sess_status = (sess.get("status") or "").strip().lower()
        if sess_status not in ALLOWED_SESSION_STATES:
            raise HTTPException(
                409,
                f"Session state '{sess_status}' does not accept entries.",
            )
        entry_fee = int(sess.get("entry_fee") or 0)
        if body.points_sent < entry_fee:
            raise HTTPException(
                422,
                f"Underpayment: points_sent={body.points_sent} < entry_fee={entry_fee}.",
            )

        # ── 3. Canonical student lookup ─────────────────────────────────────
        norm_id = norm_student_id(body.student_id)
        if not norm_id:
            raise HTTPException(422, "student_id is required.")
        student_doc = await db.students.find_one(
            {"$or": [
                {"clean_id":   norm_id},
                {"student_id": norm_id},
                {"clean_id":   body.student_id.strip()},
                {"student_id": body.student_id.strip()},
                {"clean_id":   body.student_id.strip().upper()},
                {"student_id": body.student_id.strip().upper()},
            ]},
            {"_id": 0},
        )
        if not student_doc:
            raise HTTPException(404, "Student not found. Admission rejected.")
        if student_doc.get("is_active") is False or student_doc.get("active") is False:
            raise HTTPException(403, "Student account is inactive.")

        canonical_student_id = norm_student_id(
            student_doc.get("clean_id")
            or student_doc.get("student_id")
            or norm_id,
        )
        # Canonical id must NEVER look synthetic.
        if _is_synthetic_id(canonical_student_id):
            raise HTTPException(
                422,
                "Resolved canonical student id looks synthetic — refusing.",
            )
        display_name = (
            student_doc.get("display_name")
            or student_doc.get("name")
            or canonical_student_id
        )
        display_name_key = display_name.lower()

        # ── 4. Enrollment policy ───────────────────────────────────────────
        # Default: FAIL CLOSED. v4 (FIX 5) replaces the v3 push_credit_log
        # heuristic with SESSION-BOUND authoritative provider verification and
        # binds the authorization to the verified transfer reference (which
        # becomes the admission's unique reference, so one authoritative
        # transfer cannot admit into two sessions). When authoritative ledger
        # verification is unavailable, admission fails closed unless a human
        # operator supplies an explicit, audited external-verification override.
        session_schedule = (sess.get("schedule") or "").strip().upper()
        student_schedule = (
            (student_doc.get("group") or student_doc.get("schedule") or "")
            .strip()
            .upper()
        )
        session_treasury_id = norm_student_id(sess.get("treasury_id") or "")
        enrollment_override: Optional[dict] = None
        if session_schedule:
            if not student_schedule:
                # Same-session supporting records (necessary but NOT sufficient).
                code_doc = await db[COLLECTION_CODES].find_one(
                    {"session_id": session_id,
                     "student_id": canonical_student_id},
                    {"_id": 0, "code": 1})
                entry_doc = await SL_ENTRIES.find_one(
                    {"session_id": session_id,
                     "student_id": canonical_student_id},
                    {"_id": 0, "student_id": 1})

                if body.confirm_external_verification:
                    # ── Human-authorized, audited override (NOT automated
                    # payment verification). Requires reason + an explicit
                    # verified transfer reference, which becomes the unique
                    # admission reference.
                    if not (body.teacher_explanation or "").strip():
                        raise HTTPException(422, "External-verification "
                                            "override requires a reason.")
                    if not normalized_ref:
                        raise HTTPException(422, "External-verification "
                                            "override requires a verified "
                                            "transfer reference.")
                    # v5.1 (FIX 1): same-session evidence is a HARD
                    # requirement for the human-authorized override too.
                    # Without a same-session pool entry AND a same-session
                    # lucky code, the operator cannot demonstrate that this
                    # student participated in THIS session — the override
                    # would otherwise admit a stranger.
                    if not entry_doc:
                        raise HTTPException(
                            403,
                            {"detail": "student_enrollment_unverified",
                             "reason": "human-authorized override requires "
                                       "a same-session pool entry; none "
                                       "found for this student."})
                    if not (code_doc and code_doc.get("code")):
                        raise HTTPException(
                            403,
                            {"detail": "student_enrollment_unverified",
                             "reason": "human-authorized override requires "
                                       "a same-session lucky code; none "
                                       "found for this student."})
                    enrollment_override = {
                        "enrollment_override":           True,
                        "enrollment_override_basis":     "human_authorized_external_verification",
                        "human_authorized_override":     True,
                        "student_group_at_admission":    "",
                        "session_schedule_at_admission": session_schedule,
                        "session_treasury_at_admission": session_treasury_id,
                        "verified_transfer_reference":   normalized_ref,
                        "override_reason":               body.teacher_explanation,
                        "authenticated_teacher":         (getattr(admin, "email", None)
                                                          or getattr(admin, "user_id", None)
                                                          or "unknown_admin"),
                        "override_timestamp":            utcnow().isoformat(),
                        # v5.1 (FIX 1): record the same-session evidence
                        # consulted for the override (audit trail).
                        "same_session_entry_present":    True,
                        "same_session_lucky_code":       code_doc.get("code"),
                    }
                    L.warning(
                        "teacher_admit HUMAN-AUTHORIZED enrollment override: "
                        "student=%s session=%s ref=%s teacher=%s code=%s",
                        canonical_student_id, session_id, normalized_ref,
                        enrollment_override["authenticated_teacher"],
                        code_doc.get("code"))
                else:
                    if verify_pool_payment is None:
                        raise HTTPException(
                            403,
                            {"detail": "authoritative_payment_verification_unavailable",
                             "reason": "automatic authoritative ledger "
                                       "verification is not configured; use an "
                                       "audited external-verification override."})
                    if not (code_doc and code_doc.get("code")) or not entry_doc:
                        raise HTTPException(
                            403,
                            {"detail": "student_enrollment_unverified",
                             "reason": "missing same-session pool entry / lucky "
                                       "code supporting records."})
                    try:
                        evidence = await verify_pool_payment(
                            canonical_student_id=canonical_student_id,
                            session_id=session_id,
                            entry_fee=entry_fee,
                            session_treasury_id=session_treasury_id,
                        )
                    except Exception as _vexc:  # noqa: BLE001
                        L.warning("teacher_admit: verify_pool_payment error: %s",
                                  str(_vexc)[:200])
                        evidence = {"unavailable": True}
                    if isinstance(evidence, dict) and evidence.get("unavailable"):
                        raise HTTPException(
                            403,
                            {"detail": "authoritative_payment_verification_unavailable",
                             "reason": "authoritative ledger verification could "
                                       "not be performed; failing closed."})
                    if not evidence:
                        raise HTTPException(
                            403,
                            {"detail": "student_enrollment_unverified",
                             "reason": "no authoritative session-bound payment "
                                       "evidence was found for this student."})
                    verified_ref = (evidence.get("verified_transfer_reference")
                                    or "").strip()
                    if not verified_ref:
                        raise HTTPException(
                            403,
                            {"detail": "student_enrollment_unverified",
                             "reason": "authoritative evidence missing a "
                                       "transfer reference."})
                    # Bind authorization + dedup to the VERIFIED reference.
                    normalized_ref = normalize_reference(verified_ref)
                    enrollment_override = {
                        "enrollment_override":           True,
                        "enrollment_override_basis":     "authoritative_session_bound_verification",
                        "student_group_at_admission":    "",
                        "session_schedule_at_admission": session_schedule,
                        "session_treasury_at_admission": session_treasury_id,
                        "verified_transfer_reference":   verified_ref,
                        "verified_amount":               evidence.get("verified_amount"),
                        "verified_sender_id":            evidence.get("verified_sender_id"),
                        "verified_recipient_id":         evidence.get("verified_recipient_id"),
                        "override_timestamp":            utcnow().isoformat(),
                    }
                    L.info(
                        "teacher_admit enrollment_gap_override (authoritative): "
                        "student=%s session=%s treasury=%s transfer=%s amount=%s",
                        canonical_student_id, session_id, session_treasury_id,
                        verified_ref, evidence.get("verified_amount"))
            elif session_schedule != student_schedule:
                raise HTTPException(
                    403,
                    f"Student schedule '{student_schedule}' does not match "
                    f"session schedule '{session_schedule}'.",
                )

        # ── 5. Serialize the (session, ref) window locally ──────────────────
        async with _serialize_lock:
            return await _admit_serialised(
                db, SL_ENTRIES, sl_publish, generate_and_publish_lucky_code,
                L, sess, session_id, entry_fee,
                body, normalized_ref, transfer_time_iso,
                canonical_student_id, display_name, display_name_key,
                admin, enrollment_override,
            )

    # ── Missing Code Rescue: shared session gate ────────────────────────────
    def _require_session_open(sess: dict) -> None:
        locked = _draw_locked(sess)
        if locked:
            raise HTTPException(
                409, f"Session is locked for admission ({locked}).",
            )
        sess_status = (sess.get("status") or "").strip().lower()
        if sess_status not in ALLOWED_SESSION_STATES:
            raise HTTPException(
                409, f"Session state '{sess_status}' does not accept entries.",
            )

    async def _latest_rows_by_sender(
        session_treasury_id: str, look_back_minutes: int,
    ) -> dict:
        window = max(1, min(int(look_back_minutes or 1440), 24 * 60))
        since = utcnow() - timedelta(minutes=window)
        rows = await find_recent_treasury_credits(
            treasury_id=session_treasury_id, since=since,
        )
        by_sender: dict[str, dict] = {}
        for row in (rows or []):
            sender_norm = norm_student_id(row.get("senderStudentId") or "")
            if not sender_norm or sender_norm in by_sender:
                continue  # rows arrive most-recent-first; keep first seen
            by_sender[sender_norm] = row
        return by_sender

    @api.get(
        "/speaking-lab/sessions/{session_id}/missing-code-candidates",
        response_model=MissingCodeCandidatesResponse,
        summary="Missing Code Rescue — list reviewable candidates "
                "(NOT verified payment proof)",
    )
    async def missing_code_candidates(
        session_id: str,
        look_back_minutes: int = 1440,
        admin=Depends(require_admin_dep),
    ) -> MissingCodeCandidatesResponse:
        if find_recent_treasury_credits is None:
            raise HTTPException(
                503,
                {"detail": "missing_code_review_unavailable",
                 "reason": "no candidate signal source is configured."},
            )
        sess = await SL_SESSIONS.find_one({"session_id": session_id})
        if not sess:
            raise HTTPException(404, "Session not found.")
        entry_fee = int(sess.get("entry_fee") or 0)
        treasury_id = norm_student_id(sess.get("treasury_id") or "")
        session_schedule = _normalize_schedule(sess.get("schedule") or "")
        by_sender = await _latest_rows_by_sender(treasury_id, look_back_minutes)

        candidates: list[MissingCodeCandidate] = []
        for sender_norm, row in by_sender.items():
            info = await _gather_candidate(
                db, SL_ENTRIES, session_id, entry_fee, sender_norm, row,
                session_schedule,
            )
            candidates.append(MissingCodeCandidate(
                student_id=sender_norm,
                student_name=info["display_name"],
                claimed_amount=info["claimed_amount"],
                transfer_time=info["transfer_time"],
                transfer_reference=info["transfer_reference"],
                entry_fee=entry_fee,
                current_status=info["current_status"],
                status=info["status"],
                restorable=info["restorable"],
                reason=info["reason"],
                student_schedule=info["student_schedule"],
            ))
        return MissingCodeCandidatesResponse(
            session_id=session_id,
            session_schedule=session_schedule,
            entry_fee=entry_fee,
            candidates=candidates,
            restorable_count=sum(1 for c in candidates if c.restorable),
        )

    async def _recover_one(
        session_id: str, entry_fee: int, treasury_id: str,
        session_schedule: str, student_id_raw: str, teacher_identity: str,
    ) -> RecoverMissingCodeResult:
        norm_id = norm_student_id(student_id_raw)
        if not norm_id:
            return RecoverMissingCodeResult(
                ok=False, student_id=str(student_id_raw or ""),
                outcome="manual_review_required", reason="invalid_student_id",
            )
        async with _recovery_lock:
            by_sender = await _latest_rows_by_sender(treasury_id, 1440)
            row = by_sender.get(norm_id)
            info = await _gather_candidate(
                db, SL_ENTRIES, session_id, entry_fee, norm_id, row,
                session_schedule,
            )
            display_name = info["display_name"]

            if info["status"] == "already_has_code":
                snap = await _pool_snapshot(db, session_id)
                return RecoverMissingCodeResult(
                    student_id=norm_id, display_name=display_name,
                    outcome="skipped", reason="already_has_code",
                    lucky_code=(info.get("code_doc") or {}).get("code", ""),
                    entry_fee=entry_fee, pool_total=snap["pool_total"],
                    player_count=snap["player_count"],
                )
            if info["status"] == "already_restored":
                existing_recovery = info.get("existing_recovery") or {}
                snap = await _pool_snapshot(db, session_id)
                return RecoverMissingCodeResult(
                    student_id=norm_id, display_name=display_name,
                    outcome="already_restored",
                    lucky_code=(info.get("code_doc") or {}).get("code", "")
                        or existing_recovery.get("generated_code", ""),
                    entry_fee=entry_fee, pool_total=snap["pool_total"],
                    player_count=snap["player_count"],
                    recovery_id=existing_recovery.get("recovery_id", ""),
                    idempotent_replay=True,
                )
            if info["status"] == "manual_review_required":
                return RecoverMissingCodeResult(
                    student_id=norm_id, display_name=display_name,
                    outcome="manual_review_required", reason=info["reason"],
                    entry_fee=entry_fee,
                )

            # status == "review_required" → proceed with the human-confirmed
            # restore. Reserve the recovery row FIRST (durable dedup via the
            # unique indexes) before creating any pool state.
            recovery_id = str(uuid.uuid4())
            now = utcnow()
            audit_doc = {
                "recovery_id":                 recovery_id,
                "session_id":                  session_id,
                "student_id":                  norm_id,
                "display_name":                display_name,
                "entry_fee":                   entry_fee,
                "claimed_amount":               info["claimed_amount"],
                "source_reference_raw":        info["transfer_reference"],
                "normalized_source_reference": info["normalized_reference"],
                "source_transfer_time":        info["transfer_time"],
                "source_record":               "push_credit_log",
                "authenticated_teacher":       teacher_identity,
                "teacher_confirmed":           True,
                "confirmed_at":                now.isoformat(),
                "status":                      "processing",
                "generated_code":              None,
                "created_at":                  now.isoformat(),
                "updated_at":                  now.isoformat(),
                "completed_at":                None,
                "last_error":                  None,
            }
            try:
                await db[COLLECTION_RECOVERIES].insert_one(audit_doc)
            except Exception:  # noqa: BLE001 — race on either unique index
                re_read = await db[COLLECTION_RECOVERIES].find_one(
                    {"$or": [
                        {"normalized_source_reference": info["normalized_reference"]},
                        {"session_id": session_id, "student_id": norm_id},
                    ]},
                    {"_id": 0},
                )
                if re_read and re_read.get("status") == "restored":
                    snap = await _pool_snapshot(db, session_id)
                    return RecoverMissingCodeResult(
                        student_id=norm_id, display_name=display_name,
                        outcome="already_restored",
                        lucky_code=re_read.get("generated_code", ""),
                        entry_fee=entry_fee, pool_total=snap["pool_total"],
                        player_count=snap["player_count"],
                        recovery_id=re_read.get("recovery_id", ""),
                        idempotent_replay=True,
                    )
                return RecoverMissingCodeResult(
                    student_id=norm_id, display_name=display_name,
                    outcome="manual_review_required",
                    reason="concurrent_recovery_in_progress",
                    entry_fee=entry_fee,
                )

            entry_created = False
            code_owned_by_us = False
            try:
                if not info["entry_doc"]:
                    position = (
                        await SL_ENTRIES.count_documents(
                            {"session_id": session_id},
                        )
                    ) + 1
                    entry_doc = {
                        "session_id":         session_id,
                        "student_id":         norm_id,
                        "display_name":       display_name,
                        "display_name_key":   display_name.lower(),
                        "position":           position,
                        "entered_at":         utcnow().isoformat(),
                        "source":             "missing_code_recovery",
                        "recovery_id":        recovery_id,
                        "recovery_reference": info["normalized_reference"],
                        "recovery_by":        teacher_identity,
                        "recovery_at":        utcnow().isoformat(),
                        "eligible":           True,
                        "paid_entry":         True,
                    }
                    await SL_ENTRIES.insert_one(entry_doc)
                    entry_created = True
                    await sl_publish(session_id, {
                        "type":         "entry",
                        "student_id":   norm_id,
                        "display_name": display_name,
                        "position":     position,
                        "entered_at":   entry_doc["entered_at"],
                    })

                pre_existing_code = await db[COLLECTION_CODES].find_one(
                    {"session_id": session_id, "student_id": norm_id},
                    {"_id": 0, "code": 1},
                )
                code_owned_by_us = not bool(pre_existing_code)
                await generate_and_publish_lucky_code(
                    db, sl_publish, session_id, norm_id, display_name,
                    amount=entry_fee, log=L,
                )
                if code_owned_by_us:
                    await db[COLLECTION_CODES].update_one(
                        {"session_id": session_id, "student_id": norm_id,
                         "$or": [{"recovery_id": {"$exists": False}},
                                 {"recovery_id": recovery_id}]},
                        {"$set": {
                            "recovery_id":        recovery_id,
                            "recovery_reference": info["normalized_reference"],
                            "recovery_by":        teacher_identity,
                            "recovered_at":       utcnow().isoformat(),
                            "source":             "missing_code_recovery",
                        }},
                    )
                verify_code = await db[COLLECTION_CODES].find_one(
                    {"session_id": session_id, "student_id": norm_id},
                    {"_id": 0},
                )
                if not verify_code or not verify_code.get("code"):
                    raise RuntimeError("lucky code missing after write")
            except Exception as exc:  # noqa: BLE001
                if entry_created:
                    try:
                        await SL_ENTRIES.delete_one({
                            "session_id": session_id, "student_id": norm_id,
                            "recovery_id": recovery_id,
                            "source": "missing_code_recovery",
                        })
                    except Exception:  # noqa: BLE001
                        pass
                if code_owned_by_us:
                    try:
                        await db[COLLECTION_CODES].delete_one({
                            "session_id": session_id, "student_id": norm_id,
                            "recovery_id": recovery_id,
                            "source": "missing_code_recovery",
                        })
                    except Exception:  # noqa: BLE001
                        pass
                await db[COLLECTION_RECOVERIES].update_one(
                    {"recovery_id": recovery_id},
                    {"$set": {"status": "rolled_back",
                              "last_error": str(exc)[:240],
                              "updated_at": utcnow().isoformat()}},
                )
                L.error("missing_code_recovery FAILED recovery_id=%s: %s",
                        recovery_id, exc)
                return RecoverMissingCodeResult(
                    ok=False, student_id=norm_id, display_name=display_name,
                    outcome="error", reason="recovery_failed",
                    entry_fee=entry_fee,
                )

            await db[COLLECTION_RECOVERIES].update_one(
                {"recovery_id": recovery_id},
                {"$set": {
                    "status":         "restored",
                    "generated_code": verify_code["code"],
                    "completed_at":   utcnow().isoformat(),
                    "updated_at":     utcnow().isoformat(),
                }},
            )
            snap = await _pool_snapshot(db, session_id)
            try:
                await sl_publish(session_id, {
                    "type":         "pool_update",
                    "pool_total":   snap["pool_total"],
                    "player_count": snap["player_count"],
                })
            except Exception as pub_exc:  # noqa: BLE001
                L.warning("missing_code_recovery pool_update SSE failed: %s",
                          str(pub_exc)[:200])
            L.info(
                "missing_code_recovery OK: session=%s student=%s code=%s "
                "teacher=%s", session_id, norm_id, verify_code["code"],
                teacher_identity,
            )
            return RecoverMissingCodeResult(
                student_id=norm_id, display_name=display_name,
                outcome="restored", lucky_code=verify_code["code"],
                entry_fee=int(verify_code.get("entry_fee") or entry_fee),
                pool_total=snap["pool_total"], player_count=snap["player_count"],
                recovery_id=recovery_id,
            )

    @api.post(
        "/speaking-lab/sessions/{session_id}/recover-missing-code",
        response_model=RecoverMissingCodeResult,
        summary="Missing Code Rescue — restore one teacher-reviewed student",
    )
    async def recover_missing_code(
        session_id: str,
        body: RecoverMissingCodeRequest,
        admin=Depends(require_admin_dep),
    ) -> RecoverMissingCodeResult:
        if find_recent_treasury_credits is None:
            raise HTTPException(
                503, {"detail": "missing_code_review_unavailable"},
            )
        if not _RecoveryIndexHealth.unique_ref_ok:
            raise HTTPException(
                503,
                {"detail": "missing_code_recovery_unavailable",
                 "index_health_error": _RecoveryIndexHealth.last_error
                                        or "unknown"},
            )
        if not body.teacher_confirmed:
            raise HTTPException(422, "Teacher confirmation is required.")
        sess = await SL_SESSIONS.find_one({"session_id": session_id})
        if not sess:
            raise HTTPException(404, "Session not found.")
        _require_session_open(sess)
        entry_fee = int(sess.get("entry_fee") or 0)
        treasury_id = norm_student_id(sess.get("treasury_id") or "")
        session_schedule = _normalize_schedule(sess.get("schedule") or "")
        teacher_identity = (
            getattr(admin, "email", None) or getattr(admin, "user_id", None)
            or "unknown_admin"
        )
        return await _recover_one(
            session_id, entry_fee, treasury_id, session_schedule,
            body.student_id, teacher_identity,
        )

    @api.post(
        "/speaking-lab/sessions/{session_id}/recover-missing-codes/bulk",
        response_model=RecoverMissingCodesBulkResponse,
        summary="Missing Code Rescue — restore multiple teacher-reviewed "
                "students",
    )
    async def recover_missing_codes_bulk(
        session_id: str,
        body: RecoverMissingCodesBulkRequest,
        admin=Depends(require_admin_dep),
    ) -> RecoverMissingCodesBulkResponse:
        if find_recent_treasury_credits is None:
            raise HTTPException(
                503, {"detail": "missing_code_review_unavailable"},
            )
        if not _RecoveryIndexHealth.unique_ref_ok:
            raise HTTPException(
                503,
                {"detail": "missing_code_recovery_unavailable",
                 "index_health_error": _RecoveryIndexHealth.last_error
                                        or "unknown"},
            )
        if not body.teacher_confirmed:
            raise HTTPException(422, "Teacher confirmation is required.")
        sess = await SL_SESSIONS.find_one({"session_id": session_id})
        if not sess:
            raise HTTPException(404, "Session not found.")
        _require_session_open(sess)
        entry_fee = int(sess.get("entry_fee") or 0)
        treasury_id = norm_student_id(sess.get("treasury_id") or "")
        session_schedule = _normalize_schedule(sess.get("schedule") or "")
        teacher_identity = (
            getattr(admin, "email", None) or getattr(admin, "user_id", None)
            or "unknown_admin"
        )
        results: list[RecoverMissingCodeResult] = []
        for sid in body.student_ids:
            try:
                res = await _recover_one(
                    session_id, entry_fee, treasury_id, session_schedule,
                    sid, teacher_identity,
                )
            except Exception as exc:  # noqa: BLE001
                L.error("missing_code_recovery bulk item failed sid=%s: %s",
                        sid, exc)
                res = RecoverMissingCodeResult(
                    ok=False, student_id=str(sid), outcome="error",
                    reason="recovery_failed",
                )
            results.append(res)
        restored_count = sum(1 for r in results if r.outcome == "restored")
        skipped_count = len(results) - restored_count
        return RecoverMissingCodesBulkResponse(
            session_id=session_id, restored_count=restored_count,
            skipped_count=skipped_count, results=results,
        )

    @api.post(
        "/speaking-lab/students/{student_id}/schedule-assignment",
        response_model=UpdateStudentScheduleResult,
        summary="Assign a student's persistent Schedule A/B (or unassign)",
    )
    async def assign_student_schedule(
        student_id: str,
        body: UpdateStudentScheduleRequest,
        admin=Depends(require_admin_dep),
    ) -> UpdateStudentScheduleResult:
        target = _validate_schedule_target(body.schedule)
        teacher_identity = (
            getattr(admin, "email", None) or getattr(admin, "user_id", None)
            or "unknown_admin"
        )
        return await _assign_schedule_one(
            db, SL_SESSIONS, SL_ENTRIES, norm_student_id, student_id,
            target, body.confirm, body.session_context_id, teacher_identity,
        )

    @api.post(
        "/speaking-lab/students/schedule-assignment/bulk",
        response_model=BulkUpdateScheduleResponse,
        summary="Bulk-assign students' persistent Schedule A/B",
    )
    async def assign_student_schedules_bulk(
        body: BulkUpdateScheduleRequest,
        admin=Depends(require_admin_dep),
    ) -> BulkUpdateScheduleResponse:
        target = _validate_schedule_target(body.schedule)
        teacher_identity = (
            getattr(admin, "email", None) or getattr(admin, "user_id", None)
            or "unknown_admin"
        )
        results: list[UpdateStudentScheduleResult] = []
        for sid in body.student_ids:
            try:
                res = await _assign_schedule_one(
                    db, SL_SESSIONS, SL_ENTRIES, norm_student_id, sid,
                    target, body.confirm, body.session_context_id,
                    teacher_identity,
                )
            except Exception as exc:  # noqa: BLE001
                L.error("schedule_assignment bulk item failed sid=%s: %s",
                        sid, exc)
                res = UpdateStudentScheduleResult(
                    ok=False, student_id=str(sid), outcome="error",
                    reason="assignment_failed",
                )
            results.append(res)
        updated_count = sum(1 for r in results if r.outcome == "updated")
        return BulkUpdateScheduleResponse(
            updated_count=updated_count,
            skipped_count=len(results) - updated_count,
            results=results,
        )


# ──────────────────────────────────────────────────────────────────────────────
# Core admission flow (serialised inside the route)
# ──────────────────────────────────────────────────────────────────────────────
async def _admit_serialised(
    db, SL_ENTRIES, sl_publish, generate_and_publish_lucky_code, L,
    sess, session_id, entry_fee,
    body, normalized_ref, transfer_time_iso,
    canonical_student_id, display_name, display_name_key, admin,
    enrollment_override=None,
) -> TeacherAdmitResponse:

    teacher_identity = (
        getattr(admin, "email", None)
        or getattr(admin, "user_id", None)
        or "unknown_admin"
    )

    # ── A. Resume or create the operation ──────────────────────────────────
    existing_op = await db[COLLECTION_ADMISSIONS].find_one(
        {"normalized_transfer_reference": normalized_ref},
        {"_id": 0},
    )
    if existing_op:
        # Reference already reserved.
        if existing_op.get("session_id") != session_id \
                or existing_op.get("student_id") != canonical_student_id:
            raise HTTPException(
                409,
                "Transfer reference is already used for a different student "
                "or session.",
            )
        op_state = existing_op.get("status_after") or "pending"
        if op_state == "admitted":
            return await _verify_and_replay(
                db, SL_ENTRIES, existing_op,
                session_id, canonical_student_id, display_name, entry_fee,
                L,
            )
        # Resume pending / processing / failed_retriable
        admission_id = existing_op["admission_id"]
        L.info("teacher_admit RESUME admission_id=%s state=%s",
               admission_id, op_state)
        await _bump_attempt(db, admission_id, op_state="processing")
        prior_snapshot = existing_op.get("prior_entry_snapshot") or {}
    else:
        admission_id = str(uuid.uuid4())
        now = utcnow()
        status_before, prior_snapshot = await _classify_prior_state(
            db, SL_ENTRIES, session_id, canonical_student_id, display_name_key,
        )
        audit_doc = {
            "admission_id":                  admission_id,
            "session_id":                    session_id,
            "student_id":                    canonical_student_id,
            "display_name":                  display_name,
            "entry_fee":                     entry_fee,
            "verified_amount":               int(body.points_sent),
            "transfer_reference_raw":        body.transfer_reference,
            "normalized_transfer_reference": normalized_ref,
            "transfer_time":                 transfer_time_iso,
            "verification_method":           body.verification_method,
            "teacher_explanation":           body.teacher_explanation,
            "authenticated_teacher":         teacher_identity,
            "status_before":                 status_before,
            "status_after":                  "processing",
            "generated_code":                None,
            "created_at":                    now.isoformat(),
            "updated_at":                    now.isoformat(),
            "completed_at":                  None,
            "attempts":                      1,
            "last_error":                    None,
            "prior_entry_snapshot":          prior_snapshot,
            "linked_synthetic_entry":        False,
            "linked_from_synthetic_id":      None,
        }
        if enrollment_override:
            # FIX 1: persist authoritative empty-group recovery audit fields.
            audit_doc.update(enrollment_override)
            audit_doc["authenticated_teacher"] = teacher_identity
        try:
            await db[COLLECTION_ADMISSIONS].insert_one(audit_doc)
        except Exception as exc:  # noqa: BLE001
            # Race: another worker reserved this reference between our
            # find_one and our insert. Re-read and resume.
            re_read = await db[COLLECTION_ADMISSIONS].find_one(
                {"normalized_transfer_reference": normalized_ref},
                {"_id": 0},
            )
            if not re_read:
                raise HTTPException(
                    409,
                    "Transfer reference could not be reserved.",
                ) from exc
            if re_read.get("session_id") != session_id \
                    or re_read.get("student_id") != canonical_student_id:
                raise HTTPException(
                    409,
                    "Transfer reference is already used for a different "
                    "student or session.",
                ) from exc
            admission_id = re_read["admission_id"]
            prior_snapshot = re_read.get("prior_entry_snapshot") or {}
            if re_read.get("status_after") == "admitted":
                return await _verify_and_replay(
                    db, SL_ENTRIES, re_read,
                    session_id, canonical_student_id, display_name, entry_fee,
                    L,
                )

    # ── B. Upsert / link the entry row ─────────────────────────────────────
    linked_synthetic_id: Optional[str] = None
    try:
        existing_canonical = await SL_ENTRIES.find_one(
            {"session_id": session_id, "student_id": canonical_student_id},
            {"_id": 0},
        )
        if existing_canonical:
            # Capture a fresh snapshot only if we don't already have one.
            if not prior_snapshot:
                prior_snapshot = _snapshot_entry(existing_canonical)
                await _store_prior_snapshot(db, admission_id, prior_snapshot)
            await SL_ENTRIES.update_one(
                {"session_id": session_id, "student_id": canonical_student_id},
                {"$set": _admit_field_set(
                    display_name, display_name_key, normalized_ref,
                    body.points_sent, transfer_time_iso, teacher_identity,
                    admission_id, source_override=None,
                )},
            )
        else:
            # Look for a synthetic placeholder (Correction 1).
            synth = await _find_synthetic_candidate(
                SL_ENTRIES, session_id, display_name_key, canonical_student_id,
            )
            if synth and synth.get("student_id") and \
                    _is_synthetic_id(synth["student_id"]):
                linked_synthetic_id = synth["student_id"]
                if not prior_snapshot:
                    prior_snapshot = _snapshot_entry(synth)
                    prior_snapshot["_linked_synthetic"] = True
                    await _store_prior_snapshot(db, admission_id, prior_snapshot)
                # LINK: update the synthetic row's student_id → canonical
                # while preserving position / entered_at.
                set_payload = _admit_field_set(
                    display_name, display_name_key, normalized_ref,
                    body.points_sent, transfer_time_iso, teacher_identity,
                    admission_id, source_override="teacher_emergency_admit_link",
                )
                set_payload["student_id"] = canonical_student_id
                set_payload["linked_from_synthetic_id"] = linked_synthetic_id
                try:
                    await SL_ENTRIES.update_one(
                        {"session_id": session_id,
                         "student_id": linked_synthetic_id},
                        {"$set": set_payload},
                    )
                except Exception as exc_link:  # noqa: BLE001
                    msg = str(exc_link).lower()
                    if "duplicate" in msg or "e11000" in msg:
                        await _mark_failed_retriable(
                            db, admission_id, "link_synthetic_duplicate",
                        )
                        raise HTTPException(
                            409,
                            "Cannot link synthetic row: a canonical entry "
                            "already exists for this session.",
                        ) from exc_link
                    raise
                await db[COLLECTION_ADMISSIONS].update_one(
                    {"admission_id": admission_id},
                    {"$set": {"linked_synthetic_entry": True,
                              "linked_from_synthetic_id": linked_synthetic_id}},
                )
            else:
                # Fresh canonical insert.
                position = (
                    await SL_ENTRIES.count_documents({"session_id": session_id})
                ) + 1
                entry_doc = {
                    "session_id":       session_id,
                    "student_id":       canonical_student_id,
                    "display_name":     display_name,
                    "display_name_key": display_name_key,
                    "position":         position,
                    "entered_at":       utcnow().isoformat(),
                    "source":           "teacher_emergency_admit",
                    **_admit_field_set(
                        display_name, display_name_key, normalized_ref,
                        body.points_sent, transfer_time_iso, teacher_identity,
                        admission_id, source_override=None,
                    ),
                }
                try:
                    await SL_ENTRIES.insert_one(entry_doc)
                except Exception as exc_ins:  # noqa: BLE001
                    msg = str(exc_ins).lower()
                    if "duplicate" in msg or "e11000" in msg:
                        await _mark_failed_retriable(
                            db, admission_id, "display_name_collision",
                        )
                        raise HTTPException(
                            409,
                            "A different student with the same display name is "
                            "already in this session. Disambiguate the display "
                            "name before admitting.",
                        ) from exc_ins
                    raise
                await sl_publish(session_id, {
                    "type":         "entry",
                    "student_id":   canonical_student_id,
                    "display_name": display_name,
                    "position":     position,
                    "entered_at":   entry_doc["entered_at"],
                })
    except HTTPException:
        raise
    except Exception as exc:  # noqa: BLE001
        await _rollback_all(
            db, SL_ENTRIES, admission_id,
            session_id, canonical_student_id, prior_snapshot,
            linked_synthetic_id, L, reason=f"entry_phase: {exc}",
        )
        raise HTTPException(
            500, "Entry write failed. Admission rolled back.",
        ) from exc

    # ── C. Lucky code via protected helper ─────────────────────────────────
    # Capture whether a code already existed BEFORE we called the helper,
    # so we never claim ownership of a legitimate pre-existing code (and
    # so rollback never deletes it).
    pre_existing_code = await db[COLLECTION_CODES].find_one(
        {"session_id": session_id, "student_id": canonical_student_id},
        {"_id": 0, "code": 1, "admit_audit_id": 1},
    )
    code_owned_by_us = not bool(pre_existing_code)
    try:
        await generate_and_publish_lucky_code(
            db, sl_publish, session_id,
            canonical_student_id, display_name,
            amount=entry_fee,
            log=L,
        )
    except Exception as exc:  # noqa: BLE001
        await _rollback_all(
            db, SL_ENTRIES, admission_id,
            session_id, canonical_student_id, prior_snapshot,
            linked_synthetic_id, L, reason=f"code_phase: {exc}",
        )
        raise HTTPException(
            500, "Lucky code generation failed. Admission rolled back.",
        ) from exc

    # ── D. Code provenance write + verification (Correction 5) ────────────
    # Only tag the code with admission provenance if WE created it. A
    # legitimate pre-existing code is left untouched.
    try:
        if code_owned_by_us:
            prov = {
                "admit_audit_id": admission_id,
                "admit_reference": normalized_ref,
                "admit_by":        teacher_identity,
                "admitted_at":     utcnow().isoformat(),
                "source":          "teacher_emergency_admit",
            }
            await db[COLLECTION_CODES].update_one(
                {"session_id": session_id, "student_id": canonical_student_id,
                 "$or": [{"admit_audit_id": {"$exists": False}},
                         {"admit_audit_id": admission_id}]},
                {"$set": prov},
            )
        verify_code = await db[COLLECTION_CODES].find_one(
            {"session_id": session_id, "student_id": canonical_student_id},
            {"_id": 0},
        )
        if code_owned_by_us and verify_code and \
                verify_code.get("admit_audit_id") != admission_id:
            raise RuntimeError(
                "code provenance not persisted by current admission",
            )
    except Exception as exc:  # noqa: BLE001
        await _rollback_all(
            db, SL_ENTRIES, admission_id,
            session_id, canonical_student_id, prior_snapshot,
            linked_synthetic_id, L, reason=f"provenance_phase: {exc}",
            also_rollback_code=code_owned_by_us,
        )
        raise HTTPException(
            500, "Code provenance write failed. Admission rolled back.",
        ) from exc
    if not verify_code or not verify_code.get("code"):
        await _rollback_all(
            db, SL_ENTRIES, admission_id,
            session_id, canonical_student_id, prior_snapshot,
            linked_synthetic_id, L, reason="code_verify_missing",
            also_rollback_code=code_owned_by_us,
        )
        raise HTTPException(500, "Lucky code missing after write.")

    # ── E. Final entry read-back ───────────────────────────────────────────
    verify_entry = await SL_ENTRIES.find_one(
        {"session_id": session_id, "student_id": canonical_student_id},
        {"_id": 0},
    )
    if not verify_entry:
        await _rollback_all(
            db, SL_ENTRIES, admission_id,
            session_id, canonical_student_id, prior_snapshot,
            linked_synthetic_id, L, reason="entry_verify_missing",
            also_rollback_code=code_owned_by_us,
        )
        raise HTTPException(500, "Entry missing after write.")

    # ── F. MANDATORY audit completion + read-back (Correction 3) ──────────
    final_code = verify_code["code"]
    try:
        await db[COLLECTION_ADMISSIONS].update_one(
            {"admission_id": admission_id},
            {"$set": {
                "status_after":   "admitted",
                "generated_code": final_code,
                "completed_at":   utcnow().isoformat(),
                "updated_at":     utcnow().isoformat(),
            }},
        )
        completed = await db[COLLECTION_ADMISSIONS].find_one(
            {"admission_id": admission_id}, {"_id": 0},
        )
    except Exception as exc:  # noqa: BLE001
        await _rollback_all(
            db, SL_ENTRIES, admission_id,
            session_id, canonical_student_id, prior_snapshot,
            linked_synthetic_id, L, reason=f"audit_complete_phase: {exc}",
            also_rollback_code=code_owned_by_us,
        )
        raise HTTPException(
            500, "Audit completion failed. Admission rolled back.",
        ) from exc
    if not _audit_completion_ok(
        completed, session_id, canonical_student_id, final_code,
        normalized_ref,
    ):
        await _rollback_all(
            db, SL_ENTRIES, admission_id,
            session_id, canonical_student_id, prior_snapshot,
            linked_synthetic_id, L, reason="audit_completion_verify_failed",
            also_rollback_code=code_owned_by_us,
        )
        raise HTTPException(500, "Audit read-back verification failed.")

    # ── G. Re-publish a pool_update so the UI converges ───────────────────
    snap = await _pool_snapshot(db, session_id)
    try:
        await sl_publish(session_id, {
            "type":         "pool_update",
            "pool_total":   snap["pool_total"],
            "player_count": snap["player_count"],
        })
    except Exception as pub_exc:  # noqa: BLE001
        L.warning("teacher_admit pool_update SSE failed: %s",
                  str(pub_exc)[:200])

    L.info(
        "teacher_admit OK: session=%s student=%s code=%s teacher=%s "
        "linked_synthetic=%s",
        session_id, canonical_student_id, final_code, teacher_identity,
        bool(linked_synthetic_id),
    )

    return TeacherAdmitResponse(
        session_id=session_id,
        student_id=canonical_student_id,
        display_name=display_name,
        lucky_code=final_code,
        entry_fee=int(verify_code.get("entry_fee") or entry_fee),
        pool_total=snap["pool_total"],
        player_count=snap["player_count"],
        admission_id=admission_id,
        admitted_at=str(completed.get("completed_at") or ""),
        idempotent_replay=False,
        linked_synthetic_entry=bool(linked_synthetic_id),
        participant={
            "studentid":    canonical_student_id,
            "student_id":   canonical_student_id,
            "clean_id":     canonical_student_id,
            "display_name": display_name,
            "name":         display_name,
        },
    )


# ──────────────────────────────────────────────────────────────────────────────
# Helpers used by the core flow
# ──────────────────────────────────────────────────────────────────────────────
def _admit_field_set(display_name, display_name_key, normalized_ref,
                     points_sent, transfer_time_iso, teacher_identity,
                     admission_id, source_override=None) -> dict:
    return {
        "display_name":     display_name,
        "display_name_key": display_name_key,
        "admit_source":     source_override or "teacher_emergency_admit",
        "admit_audit_id":   admission_id,
        "admit_reference":  normalized_ref,
        "admit_amount":     int(points_sent),
        "admit_time":       transfer_time_iso,
        "admit_by":         teacher_identity,
        "admit_at":         utcnow().isoformat(),
        "eligible":         True,
        "paid_entry":       True,
        "source":           source_override or "teacher_emergency_admit",
    }


async def _find_synthetic_candidate(SL_ENTRIES, session_id, display_name_key,
                                    canonical_student_id):
    """Find a row in this session with the same normalised display-name
    whose `student_id` looks synthetic. Reject ambiguous matches."""
    matches = []
    cur = SL_ENTRIES.find(
        {"session_id": session_id, "display_name_key": display_name_key},
        {"_id": 0},
    )
    async for row in cur:
        sid = row.get("student_id")
        if sid == canonical_student_id:
            # canonical row already exists — caller will pick the
            # canonical update path
            return None
        if _is_synthetic_id(sid):
            matches.append(row)
        else:
            # Non-synthetic row with the same display name belongs to a
            # different canonical student → block silently here; the
            # caller will hit the insert-collision path and raise 409.
            return None
    if len(matches) == 1:
        return matches[0]
    return None  # 0 or >1 → no safe link


async def _classify_prior_state(db, SL_ENTRIES, session_id,
                                canonical_student_id, display_name_key):
    """Decide ``status_before`` and capture a snapshot if we will mutate
    an existing row."""
    prior_canonical = await SL_ENTRIES.find_one(
        {"session_id": session_id, "student_id": canonical_student_id},
        {"_id": 0},
    )
    if prior_canonical:
        snap = _snapshot_entry(prior_canonical)
        prior_code = await db[COLLECTION_CODES].find_one(
            {"session_id": session_id, "student_id": canonical_student_id},
            {"_id": 0},
        )
        return ("fully_eligible" if prior_code else "entry_no_code"), snap

    # Look for a synthetic placeholder we may later link
    synth = await _find_synthetic_candidate(
        SL_ENTRIES, session_id, display_name_key, canonical_student_id,
    )
    if synth:
        snap = _snapshot_entry(synth)
        snap["_linked_synthetic"] = True
        return "synthetic_row_present", snap
    return "not_admitted", {}


async def _store_prior_snapshot(db, admission_id, snapshot):
    try:
        await db[COLLECTION_ADMISSIONS].update_one(
            {"admission_id": admission_id},
            {"$set": {"prior_entry_snapshot": snapshot,
                      "updated_at": utcnow().isoformat()}},
        )
    except Exception as exc:  # noqa: BLE001
        logger.warning("teacher_admit snapshot persist failed: %s",
                       str(exc)[:200])


async def _bump_attempt(db, admission_id, op_state: str):
    try:
        existing = await db[COLLECTION_ADMISSIONS].find_one(
            {"admission_id": admission_id},
            {"_id": 0, "attempts": 1},
        )
        attempts = int((existing or {}).get("attempts") or 0) + 1
        await db[COLLECTION_ADMISSIONS].update_one(
            {"admission_id": admission_id},
            {"$set": {"status_after": op_state,
                      "attempts":     attempts,
                      "updated_at":   utcnow().isoformat()}},
        )
    except Exception as exc:  # noqa: BLE001
        logger.warning("teacher_admit attempt bump failed: %s",
                       str(exc)[:200])


async def _mark_failed_retriable(db, admission_id, last_error):
    try:
        await db[COLLECTION_ADMISSIONS].update_one(
            {"admission_id": admission_id},
            {"$set": {"status_after": "failed_retriable",
                      "last_error":   str(last_error)[:240],
                      "updated_at":   utcnow().isoformat()}},
        )
    except Exception as exc:  # noqa: BLE001
        logger.warning("teacher_admit mark_failed_retriable failed: %s",
                       str(exc)[:200])


def _audit_completion_ok(completed, session_id, student_id, code,
                         normalized_ref) -> bool:
    if not completed:
        return False
    return (
        completed.get("status_after") == "admitted"
        and completed.get("generated_code") == code
        and completed.get("session_id") == session_id
        and completed.get("student_id") == student_id
        and completed.get("normalized_transfer_reference") == normalized_ref
        and bool(completed.get("completed_at"))
    )


# ──────────────────────────────────────────────────────────────────────────────
# Replay path
# ──────────────────────────────────────────────────────────────────────────────
async def _verify_and_replay(
    db, SL_ENTRIES, audit_row,
    session_id, canonical_student_id, display_name, entry_fee, L,
) -> TeacherAdmitResponse:
    code_doc = await db[COLLECTION_CODES].find_one(
        {"session_id": session_id, "student_id": canonical_student_id},
        {"_id": 0},
    )
    entry_doc = await SL_ENTRIES.find_one(
        {"session_id": session_id, "student_id": canonical_student_id},
        {"_id": 0},
    )
    if not code_doc or not entry_doc \
            or audit_row.get("generated_code") != (code_doc or {}).get("code"):
        L.error("teacher_admit replay INTEGRITY ERROR admission_id=%s",
                audit_row.get("admission_id"))
        raise HTTPException(
            500,
            "Idempotent replay integrity error: persisted state is "
            "incomplete or inconsistent. Manual review required.",
        )
    snap = await _pool_snapshot(db, session_id)
    return TeacherAdmitResponse(
        session_id=session_id,
        student_id=canonical_student_id,
        display_name=code_doc.get("display_name") or display_name,
        lucky_code=code_doc["code"],
        entry_fee=int(code_doc.get("entry_fee") or entry_fee),
        pool_total=snap["pool_total"],
        player_count=snap["player_count"],
        admission_id=audit_row["admission_id"],
        admitted_at=str(audit_row.get("completed_at") or ""),
        idempotent_replay=True,
        linked_synthetic_entry=bool(audit_row.get("linked_synthetic_entry")),
        participant={
            "studentid":    canonical_student_id,
            "student_id":   canonical_student_id,
            "clean_id":     canonical_student_id,
            "display_name": code_doc.get("display_name") or display_name,
            "name":         code_doc.get("display_name") or display_name,
        },
    )


# ──────────────────────────────────────────────────────────────────────────────
# Centralised rollback — restores prior snapshot OR deletes operation-owned row
# AND removes operation-owned lucky code AND marks the audit rolled_back.
# ──────────────────────────────────────────────────────────────────────────────
async def _rollback_all(
    db, SL_ENTRIES, admission_id,
    session_id, canonical_student_id, prior_snapshot,
    linked_synthetic_id, L, reason: str,
    also_rollback_code: bool = False,
) -> None:
    rollback_ok = True

    # 1. Roll back the code if it was created by this admission AND we
    # are asked to (only after code creation succeeded).
    if also_rollback_code:
        try:
            await db[COLLECTION_CODES].delete_one({
                "session_id": session_id,
                "student_id": canonical_student_id,
                "admit_audit_id": admission_id,
                "source": "teacher_emergency_admit",
            })
        except Exception as exc:  # noqa: BLE001
            rollback_ok = False
            L.error("teacher_admit code rollback failed: %s", exc)

    # 2. Roll back the entry row.
    try:
        if prior_snapshot and prior_snapshot.get("_existed_keys"):
            # We mutated an existing row — restore exact prior state.
            prior_student_id = prior_snapshot.get("student_id") \
                or linked_synthetic_id or canonical_student_id
            current_student_id = canonical_student_id \
                if not linked_synthetic_id else canonical_student_id
            # First switch the student_id back if we changed it via link
            if linked_synthetic_id and prior_student_id != current_student_id:
                await SL_ENTRIES.update_one(
                    {"session_id": session_id,
                     "student_id": current_student_id},
                    {"$set": {"student_id": prior_student_id}},
                )
                current_student_id = prior_student_id
            restored = await _restore_entry(
                SL_ENTRIES, session_id, prior_snapshot, current_student_id,
            )
            if not restored:
                rollback_ok = False
                L.error("teacher_admit entry restore FAILED admission_id=%s",
                        admission_id)
        else:
            # We created the row — delete only if we own it.
            await SL_ENTRIES.delete_one({
                "session_id":     session_id,
                "student_id":     canonical_student_id,
                "admit_audit_id": admission_id,
                "source":         "teacher_emergency_admit",
            })
    except Exception as exc:  # noqa: BLE001
        rollback_ok = False
        L.error("teacher_admit entry rollback failed: %s", exc)

    # 3. Mark the audit as rolled_back / failed_retriable.
    try:
        await db[COLLECTION_ADMISSIONS].update_one(
            {"admission_id": admission_id},
            {"$set": {
                "status_after": "rolled_back" if rollback_ok
                                else "rollback_failed_critical",
                "last_error":   str(reason)[:240],
                "updated_at":   utcnow().isoformat(),
            }},
        )
    except Exception as exc:  # noqa: BLE001
        L.error("teacher_admit audit mark-rollback failed: %s", exc)

    if not rollback_ok:
        raise HTTPException(
            500,
            "CRITICAL: rollback could not fully restore prior state. "
            "Manual operator review required.",
        )
