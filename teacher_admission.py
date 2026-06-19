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
from datetime import datetime, timezone
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
) -> None:
    L = log or logger

    # Per-process lock for the per-(session, ref) idempotency window. The
    # *durable* uniqueness contract is the Mongo unique index — this lock
    # only short-circuits the duplicate work locally so test
    # `asyncio.gather` does not double-write before the reservation lands.
    _serialize_lock = asyncio.Lock()

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

        # ── 4. Enrollment policy — FAIL CLOSED (Correction 8) ──────────────
        session_schedule = (sess.get("schedule") or "").strip().upper()
        student_schedule = (
            (student_doc.get("group") or student_doc.get("schedule") or "")
            .strip()
            .upper()
        )
        if session_schedule:
            if not student_schedule:
                raise HTTPException(
                    403,
                    {"detail": "student_enrollment_unverified",
                     "reason": "session requires a schedule/group but the "
                               "student has no verifiable enrollment metadata."},
                )
            if session_schedule != student_schedule:
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
                admin,
            )


# ──────────────────────────────────────────────────────────────────────────────
# Core admission flow (serialised inside the route)
# ──────────────────────────────────────────────────────────────────────────────
async def _admit_serialised(
    db, SL_ENTRIES, sl_publish, generate_and_publish_lucky_code, L,
    sess, session_id, entry_fee,
    body, normalized_ref, transfer_time_iso,
    canonical_student_id, display_name, display_name_key, admin,
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
