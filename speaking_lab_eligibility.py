"""
speaking_lab_eligibility.py — Speaking Lab V4: Attendance-Assisted Auto
Enrollment (Phase 1: the enrollment layer only)
=============================================================================

Replaces the student-driven "enter a code, tap join" model with a
teacher-driven one for large classes: the teacher reviews a short
exception list, presses Confirm Participants once, and every confirmed
student is enrolled and ticketed atomically through the SAME
``_perform_join`` core Direct Join already uses — no second enrollment
system, no change to the Lucky Draw / winner-selection / treasury /
reward-distribution code at all.

Eligibility engine (hybrid — attendance ASSISTS, teacher decides)
-------------------------------------------------------------------
1. Schedule eligibility (existing, reused unchanged via the injected
   ``eligible_roster_fn`` from speaking_lab_direct_join.py) is the FIRST
   gate: a student not on the session's schedule roster is EXCLUDED and
   never appears in the reviewable list at all — unless the teacher uses
   Manual Admit, an explicit escape hatch.
2. Attendance Passport (this module, read-only) is the SECOND signal,
   applied only within the roster — DETERMINISTIC and SESSION-BOUND
   (v1.1, replacing an earlier class-agnostic recency check that could
   not prove which class an attendance record came from):
     a. Resolve the ONE attendance_classes doc whose ``group`` field
        equals the schedule ("A"/"B") the roster came from — for a
        Combined "AB" Speaking Lab session, or a student with no
        Speaking Lab schedule, this falls back to the STUDENT'S OWN
        ``students.group``, mirroring the same substitution
        session_schedule_eligibility already applies elsewhere.
     b. Resolve the ONE attendance_sessions doc for that class dated
        TODAY (server UTC date — Speaking Lab sessions are created
        live, same-day, so "today" is the only unambiguous anchor).
     c. A student counts as AUTO ELIGIBLE only if their
        attendance_records entry for THAT EXACT session_id (an O(1)
        lookup on the composite ``{session_id}:{student_id}`` key
        attendance_tools.py already writes) has a present-type status.
   If step (a) or (b) cannot be resolved to EXACTLY ONE match — no
   attendance class tagged for this group, no session today, or
   multiple candidate sessions today — the resolution FAILS CLOSED:
   every student in that group lands in NEEDS REVIEW, never a false
   AUTO ELIGIBLE. This never scans other classes, other dates, or a
   rolling time window, so a check-in from an unrelated class or a
   stale prior day can never leak into this session's eligibility.
3. The teacher has final authority over both buckets via per-student
   overrides (approve / reject / manual_admit), always reviewable and
   reversible until the session is frozen.

Confirm Participants (freeze)
------------------------------
One idempotent action: compute the final participant set (auto-eligible
minus rejected, plus approved needs-review, plus manually-admitted),
set ``enrollment_frozen_at`` on the session (blocks further roster/
override mutation), then run the SAME ``_perform_join`` used everywhere
else in Direct Join, once per participant, bounded concurrency — one
independent atomic transaction per student, so one student's failure
never blocks anyone else's ticket. Calling it again after freeze is a
safe no-op replay (returns the existing readiness snapshot; no
re-enrollment, no duplicate tickets — ``_perform_join``'s own
idempotent-replay guarantee covers this even without the freeze flag).

No new ticket format, no new push mechanism: ticket generation
(``_pick_unused_code`` — unique, random, auditable) and push delivery
(``notify_speaking_lab_join`` inside ``_perform_join``) are reused
completely unchanged. Readiness is read live off the same durable
records those already write.
"""
from __future__ import annotations

import asyncio
import logging
import uuid
from datetime import datetime, timezone
from typing import Any, Awaitable, Callable, Optional

from fastapi import APIRouter, Depends, HTTPException
from pydantic import BaseModel, ConfigDict

import speaking_lab_enrollment_audit as enroll_audit

logger = logging.getLogger("eduhub.speaking_lab_eligibility")

COLLECTION_OVERRIDES = "speaking_lab_eligibility_overrides"
COLLECTION_ATTENDANCE_RECORDS = "attendance_records"
COLLECTION_ATTENDANCE_CLASSES = "attendance_classes"
COLLECTION_ATTENDANCE_SESSIONS = "attendance_sessions"
COLLECTION_DIRECT_JOINS = "speaking_lab_direct_joins"

PRESENT_STATUSES = {"present_full", "present_partial", "late"}

# Attendance-binding resolution outcomes surfaced to the teacher so a
# roster full of Needs Review has an explicit, honest reason rather than
# looking like a bug.
BINDING_NOT_BINDABLE = "not_bindable"
BINDING_NO_CLASS = "no_attendance_class_for_group"
BINDING_NO_SESSION_TODAY = "no_attendance_session_today"
BINDING_AMBIGUOUS = "ambiguous_multiple_sessions_today"
BINDING_RESOLVED = "resolved"

DECISION_APPROVE = "approve"
DECISION_REJECT = "reject"
DECISION_MANUAL_ADMIT = "manual_admit"
DECISION_CLEAR = "clear"
VALID_DECISIONS = {DECISION_APPROVE, DECISION_REJECT, DECISION_MANUAL_ADMIT, DECISION_CLEAR}


def utcnow() -> datetime:
    return datetime.now(timezone.utc)


class EligibilityError(Exception):
    def __init__(self, code: str, message: str = "", http_status: int = 409):
        self.code = code
        self.message = message or code
        self.http_status = http_status
        super().__init__(self.message)


# ──────────────────────────────────────────────────────────────────────────────
# Indexes
# ──────────────────────────────────────────────────────────────────────────────
async def ensure_eligibility_indexes(db) -> bool:
    try:
        await db[COLLECTION_OVERRIDES].create_index(
            [("session_id", 1), ("student_id", 1)],
            unique=True, name="uq_eligibility_override_session_student",
        )
        logger.info("speaking_lab_eligibility: indexes ensured")
        return True
    except Exception as exc:  # noqa: BLE001
        logger.warning("speaking_lab_eligibility: index ensure failed: %s", exc)
        return False


# ──────────────────────────────────────────────────────────────────────────────
# Response models
# ──────────────────────────────────────────────────────────────────────────────
class EligibilityStudent(BaseModel):
    student_id: str
    display_name: str


class EligibilityResponse(BaseModel):
    ok: bool = True
    session_id: str
    roster_size: int
    auto_eligible: list[EligibilityStudent] = []
    needs_review: list[EligibilityStudent] = []
    excluded_count: int
    manual_admits: list[EligibilityStudent] = []
    rejected: list[str] = []
    frozen: bool = False
    # Why the attendance passport did/didn't resolve for this session's
    # schedule — "resolved", or a fail-closed reason (no tagged class, no
    # session today, ambiguous). None for AB/blank-schedule sessions,
    # which resolve per-student instead of once for the whole roster.
    attendance_binding: Optional[str] = None


class DecisionResponse(BaseModel):
    ok: bool = True
    session_id: str
    student_id: str
    decision: str


class ConfirmParticipantsResponse(BaseModel):
    ok: bool = True
    session_id: str
    frozen: bool = True
    already_frozen: bool = False
    participant_count: int
    joined: int
    already_had_ticket: int
    failed: list[dict] = []


class RetryFailedResponse(BaseModel):
    """Recovery Mode (V4.3): result of retrying only the currently-missing
    participants. Reuses the exact same idempotent
    ``perform_free_ticket_issuance_fn`` Confirm Participants itself calls —
    no parallel ticket-issuance path, no new duplicate-protection logic."""
    ok: bool = True
    session_id: str
    attempted: int
    recovered: int
    already_had_ticket: int
    still_failed: list[dict] = []


class ReadinessResponse(BaseModel):
    ok: bool = True
    session_id: str
    frozen: bool
    eligible: int
    tickets: int
    notifications_sent: int
    ready: bool
    # Recovery Mode (V4.3) — additive, never replaces `ready`. `ready`
    # keeps its original strict "every confirmed participant has a
    # ticket" meaning so nothing that already depends on it changes
    # behaviour. `playable` is the new, deliberately more permissive
    # signal a teacher-app "Start Session" action should actually gate
    # on: the session is playable the moment AT LEAST ONE participant has
    # a ticket, so 2 failures out of 40 no longer block the other 38.
    # Safe because the Lucky Draw's own entrant pool is built from
    # `speaking_lab_lucky_codes` rows (i.e. who actually has a ticket),
    # never from `enrollment_frozen_participants` — a student without a
    # ticket was never going to be a draw entrant either way.
    playable: bool = False
    failed_count: int = 0
    # The durable, frozen-at-confirm-time participant set (never
    # recomputed from live roster state) — the exact student IDs a
    # teacher-app "Start Session" action should hand off to the game.
    # Empty before freeze.
    participant_ids: list[str] = []
    # Why a confirmed participant is missing a ticket, sourced from the
    # durable enrollment audit trail (never a guess) — empty when ready.
    failed_detail: list[dict] = []


# ──────────────────────────────────────────────────────────────────────────────
# Attendance Passport — read-only, DETERMINISTIC, session-bound resolution.
#
# Never scans across classes or dates and never uses a rolling time
# window. A student can only ever be AUTO ELIGIBLE via an attendance
# record that provably belongs to (a) a class tagged for this exact
# schedule group and (b) that class's session dated today. Any ambiguity
# (no tagged class, no session today, more than one candidate session)
# fails CLOSED to Needs Review — it never guesses, and it never lets an
# unrelated class's check-in count.
# ──────────────────────────────────────────────────────────────────────────────
async def _resolve_attendance_session_id(
    db, group: str, *, today: str,
) -> tuple[Optional[str], str]:
    group_norm = (group or "").strip().upper()
    if group_norm not in ("A", "B"):
        return None, BINDING_NOT_BINDABLE

    class_ids: list[str] = []
    cur = db[COLLECTION_ATTENDANCE_CLASSES].find(
        {"group": group_norm}, {"_id": 0, "class_id": 1})
    async for c in cur:
        cid = c.get("class_id")
        if cid:
            class_ids.append(cid)
    if not class_ids:
        return None, BINDING_NO_CLASS

    session_ids: list[str] = []
    cur2 = db[COLLECTION_ATTENDANCE_SESSIONS].find(
        {"class_id": {"$in": class_ids}, "date": today},
        {"_id": 0, "session_id": 1})
    async for s in cur2:
        sid = s.get("session_id")
        if sid:
            session_ids.append(sid)
    if not session_ids:
        return None, BINDING_NO_SESSION_TODAY
    if len(session_ids) > 1:
        return None, BINDING_AMBIGUOUS
    return session_ids[0], BINDING_RESOLVED


async def _bulk_student_groups(db, student_ids: list[str]) -> dict[str, str]:
    """One round trip for every roster student's group, instead of one
    query per student — the same clean_id/student_id/group/schedule
    lookup pattern used elsewhere in this codebase (e.g.
    speaking_lab_direct_join.py's per-student resolution), batched via
    $in for an entire roster at once."""
    out = {sid: "" for sid in student_ids}
    if not student_ids:
        return out
    cur = db.students.find(
        {"$or": [{"clean_id": {"$in": student_ids}}, {"student_id": {"$in": student_ids}}]},
        {"_id": 0, "clean_id": 1, "student_id": 1, "group": 1, "schedule": 1},
    )
    async for doc in cur:
        key = doc.get("clean_id") or doc.get("student_id")
        if key in out:
            out[key] = doc.get("group") or doc.get("schedule") or ""
    return out


async def _bulk_attendance_passports(
    db, sess: dict, roster: list[dict],
) -> tuple[dict[str, tuple[bool, str]], dict[str, tuple[Optional[str], str]]]:
    """Batched, cached equivalent of checking each roster student's
    attendance passport one at a time. A single roster of 500 students
    resolves in a small constant number of round trips — one group
    lookup, one binding resolution PER DISTINCT GROUP (at most a
    handful: "A", "B", unassigned — never per student), and one batched
    attendance_records lookup — instead of up to 4 sequential round
    trips PER STUDENT, which made a 60+ student Combined A+B roster
    (identical binding recomputed redundantly for every single student)
    take many seconds and made "Approve All Pending" appear to hang.
    Same fail-closed semantics and reason codes throughout."""
    student_ids = [e["student_id"] for e in roster]
    if not student_ids:
        return {}, {}

    schedule = (sess.get("schedule") or "").strip().upper()
    today = utcnow().date().isoformat()

    if schedule in ("A", "B"):
        group_by_student = {sid: schedule for sid in student_ids}
    else:
        group_by_student = await _bulk_student_groups(db, student_ids)

    binding_cache: dict[str, tuple[Optional[str], str]] = {}
    for group in set(group_by_student.values()):
        binding_cache[group] = await _resolve_attendance_session_id(db, group, today=today)

    wanted_ids: list[str] = []
    id_to_student: dict[str, str] = {}
    for sid in student_ids:
        session_id, _reason = binding_cache.get(group_by_student.get(sid, ""), (None, BINDING_NOT_BINDABLE))
        if session_id:
            composite = f"{session_id}:{sid}"
            wanted_ids.append(composite)
            id_to_student[composite] = sid

    status_by_student: dict[str, str] = {}
    if wanted_ids:
        cur = db[COLLECTION_ATTENDANCE_RECORDS].find(
            {"_id": {"$in": wanted_ids}}, {"_id": 1, "status": 1})
        async for row in cur:
            sid = id_to_student.get(row["_id"])
            if sid:
                status_by_student[sid] = row.get("status")

    result: dict[str, tuple[bool, str]] = {}
    for sid in student_ids:
        session_id, reason = binding_cache.get(group_by_student.get(sid, ""), (None, BINDING_NOT_BINDABLE))
        if not session_id:
            result[sid] = (False, reason)
            continue
        status = status_by_student.get(sid)
        if status is None:
            result[sid] = (False, "no_checkin_for_session")
        elif status not in PRESENT_STATUSES:
            result[sid] = (False, "checked_in_but_not_present")
        else:
            result[sid] = (True, BINDING_RESOLVED)
    return result, binding_cache


# ──────────────────────────────────────────────────────────────────────────────
# Route factory
# ──────────────────────────────────────────────────────────────────────────────
def register_eligibility_routes(
    api: APIRouter,
    db,
    SL_SESSIONS,
    eligible_roster_fn: Callable[[dict], Awaitable[list[dict]]],
    perform_free_ticket_issuance_fn: Callable[[str, str, str, str], Awaitable[Any]],
    norm_student_id: Callable[[Any], str],
    require_admin_dep,
    log: Optional[logging.Logger] = None,
) -> None:
    """``eligible_roster_fn`` and ``perform_free_ticket_issuance_fn`` are
    SAME closures speaking_lab_direct_join.py's route factory returns —
    this module never re-implements schedule eligibility or ticket
    issuance. ``perform_free_ticket_issuance_fn`` (V4.2) is the
    attendance-driven, no-wallet, no-transaction sibling of
    ``_perform_join`` — Confirm Participants never touches a wallet,
    treasury, or Mongo multi-document transaction; the paid
    ``_perform_join`` core stays completely separate and unused here."""
    L = log or logger

    async def _session_or_404(session_id: str) -> dict:
        sess = await SL_SESSIONS.find_one({"session_id": session_id})
        if not sess:
            raise EligibilityError("session_not_found", http_status=404)
        return sess

    async def _overrides_for(session_id: str) -> dict[str, dict]:
        out: dict[str, dict] = {}
        cur = db[COLLECTION_OVERRIDES].find({"session_id": session_id})
        async for row in cur:
            out[row["student_id"]] = row
        return out

    async def _classify(session_id: str) -> dict:
        sess = await _session_or_404(session_id)
        roster = await eligible_roster_fn(sess)
        overrides = await _overrides_for(session_id)
        # Batched: one small constant number of round trips for the
        # WHOLE roster, never one per student — see _bulk_attendance_passports.
        passports, binding_cache = await _bulk_attendance_passports(db, sess, roster)

        auto_eligible: list[dict] = []
        needs_review: list[dict] = []
        roster_ids = {e["student_id"] for e in roster}

        for entry in roster:
            sid = entry["student_id"]
            ov = overrides.get(sid)
            if ov and ov["decision"] == DECISION_REJECT:
                continue  # explicitly excluded by teacher, drop from both lists
            has_passport, _reason = passports.get(sid, (False, BINDING_NOT_BINDABLE))
            if has_passport or (ov and ov["decision"] == DECISION_APPROVE):
                auto_eligible.append(entry)
            else:
                needs_review.append(entry)

        manual_admits = [
            {"student_id": sid, "display_name": ov.get("display_name") or sid}
            for sid, ov in overrides.items()
            if ov["decision"] == DECISION_MANUAL_ADMIT and sid not in roster_ids
        ]
        rejected = [sid for sid, ov in overrides.items() if ov["decision"] == DECISION_REJECT]

        # Diagnostic only for the fixed (A/B) case — an AB/blank-schedule
        # session resolves per-student (each may have a different
        # group), so no single note applies.
        schedule_norm = (sess.get("schedule") or "").strip().upper()
        binding_note = None
        if schedule_norm in ("A", "B") and schedule_norm in binding_cache:
            _resolved_session_id, binding_note = binding_cache[schedule_norm]
            if binding_note == BINDING_RESOLVED:
                binding_note = None

        return {
            "session_id": session_id,
            "roster_size": len(roster),
            "auto_eligible": auto_eligible,
            "needs_review": needs_review,
            "excluded_count": None,  # filled by caller (needs total student count)
            "manual_admits": manual_admits,
            "rejected": rejected,
            "frozen": bool(sess.get("enrollment_frozen_at")),
            "attendance_binding": binding_note,
        }

    async def _final_participant_ids(session_id: str) -> list[dict]:
        """The frozen set: every auto-eligible + manually-admitted student,
        minus none (rejects are already excluded by _classify)."""
        c = await _classify(session_id)
        combined = {e["student_id"]: e for e in c["auto_eligible"]}
        for e in c["manual_admits"]:
            combined.setdefault(e["student_id"], e)
        return list(combined.values())

    async def _attempt_ticket_issuance(
        session_id: str, entry: dict, idem_prefix: str,
    ) -> tuple[str, Optional[dict]]:
        """Single source of truth for "try to issue one student's ticket and
        classify the outcome" — used by BOTH Confirm Participants (first
        pass, every frozen participant) and Retry Failed (recovery pass,
        only the currently-missing ones). Always calls the SAME
        ``perform_free_ticket_issuance_fn`` Direct Join already exposes;
        never a parallel issuance path. Returns
        ``("joined" | "already_had_ticket" | "failed", failure_detail)``.
        """
        idem_key = f"{idem_prefix}:{session_id}:{entry['student_id']}"
        try:
            result = await perform_free_ticket_issuance_fn(
                session_id, entry["student_id"], entry["display_name"], idem_key,
            )
            if getattr(result, "idempotent_replay", False):
                return "already_had_ticket", None
            return "joined", None
        except HTTPException as exc:
            detail = exc.detail
            reason = (detail.get("error") if isinstance(detail, dict) else None) or "error"
            return "failed", {"student_id": entry["student_id"], "reason": reason}
        except Exception as exc:  # noqa: BLE001
            # Defense in depth: perform_join_fn now converts every exception
            # type it knows about into HTTPException (see
            # speaking_lab_direct_join.py's _perform_join), but this
            # one-student failure must NEVER be allowed to blow up
            # asyncio.gather and take down the whole batch response for
            # every OTHER student in it — the teacher must always get a
            # readiness result, not an opaque "Failed to fetch".
            L.error(
                "speaking_lab_eligibility: ticket issuance unexpected failure "
                "session_id=%s student_id=%s idem_prefix=%s err=%s",
                session_id, entry["student_id"], idem_prefix, exc, exc_info=True,
            )
            await enroll_audit.record_enrollment_attempt(
                db, session_id=session_id, student_id=entry["student_id"],
                idempotency_key=idem_key, outcome="unexpected_error",
                reason_code="unexpected_error", http_status=500,
                lucky_code_assigned=False, log=L)
            return "failed", {"student_id": entry["student_id"], "reason": "unexpected_error"}

    @api.get(
        "/speaking-lab/sessions/{session_id}/eligibility",
        response_model=EligibilityResponse,
        summary="V4: attendance-assisted eligibility classification (admin)",
    )
    async def get_eligibility(
        session_id: str, _admin=Depends(require_admin_dep),
    ) -> EligibilityResponse:
        try:
            c = await _classify(session_id)
        except EligibilityError as exc:
            raise HTTPException(
                status_code=exc.http_status,
                detail={"error": exc.code, "message": exc.message},
            ) from exc
        total_students = await db.students.count_documents({})
        excluded = max(0, total_students - c["roster_size"])
        return EligibilityResponse(**{**c, "excluded_count": excluded})

    @api.post(
        "/speaking-lab/sessions/{session_id}/eligibility/decision",
        response_model=DecisionResponse,
        summary="V4: teacher approve/reject/manual-admit/clear one student (admin)",
    )
    async def post_decision(
        session_id: str, body: dict, admin=Depends(require_admin_dep),
    ) -> DecisionResponse:
        student_id = norm_student_id(body.get("student_id"))
        decision = str(body.get("decision") or "").strip().lower()
        if not student_id:
            raise HTTPException(status_code=422, detail="student_id is required")
        if decision not in VALID_DECISIONS:
            raise HTTPException(status_code=422, detail=f"decision must be one of {sorted(VALID_DECISIONS)}")
        try:
            sess = await _session_or_404(session_id)
        except EligibilityError as exc:
            raise HTTPException(
                status_code=exc.http_status,
                detail={"error": exc.code, "message": exc.message},
            ) from exc
        if sess.get("enrollment_frozen_at"):
            raise HTTPException(
                status_code=409,
                detail={"error": "enrollment_frozen", "message": "Participants are already confirmed."},
            )
        if decision == DECISION_CLEAR:
            await db[COLLECTION_OVERRIDES].delete_one(
                {"session_id": session_id, "student_id": student_id})
        else:
            display_name = str(body.get("display_name") or student_id)
            now_iso = utcnow().isoformat()
            await db[COLLECTION_OVERRIDES].update_one(
                {"session_id": session_id, "student_id": student_id},
                {"$set": {
                    "session_id": session_id, "student_id": student_id,
                    "decision": decision, "display_name": display_name,
                    "decided_by": getattr(admin, "email", "") or "",
                    "decided_at": now_iso,
                }},
                upsert=True,
            )
        return DecisionResponse(session_id=session_id, student_id=student_id, decision=decision)

    @api.post(
        "/speaking-lab/sessions/{session_id}/eligibility/approve-all-pending",
        summary="V4: bulk-approve every current Needs Review student (admin)",
    )
    async def post_approve_all_pending(
        session_id: str, admin=Depends(require_admin_dep),
    ) -> dict:
        try:
            sess = await _session_or_404(session_id)
        except EligibilityError as exc:
            raise HTTPException(
                status_code=exc.http_status,
                detail={"error": exc.code, "message": exc.message},
            ) from exc
        if sess.get("enrollment_frozen_at"):
            raise HTTPException(
                status_code=409,
                detail={"error": "enrollment_frozen", "message": "Participants are already confirmed."},
            )
        c = await _classify(session_id)
        now_iso = utcnow().isoformat()
        decided_by = getattr(admin, "email", "") or ""

        # Bounded concurrency, same pattern as enroll_all_eligible /
        # confirm_participants — a large Needs Review list (dozens to
        # hundreds of students) writes its overrides concurrently
        # instead of one sequential round trip per student.
        sem = asyncio.Semaphore(20)

        async def _approve_one(entry: dict) -> None:
            async with sem:
                await db[COLLECTION_OVERRIDES].update_one(
                    {"session_id": session_id, "student_id": entry["student_id"]},
                    {"$set": {
                        "session_id": session_id, "student_id": entry["student_id"],
                        "decision": DECISION_APPROVE, "display_name": entry["display_name"],
                        "decided_by": decided_by, "decided_at": now_iso,
                    }},
                    upsert=True,
                )

        await asyncio.gather(*(_approve_one(e) for e in c["needs_review"]))
        return {"ok": True, "session_id": session_id, "approved": len(c["needs_review"])}

    @api.post(
        "/speaking-lab/sessions/{session_id}/confirm-participants",
        response_model=ConfirmParticipantsResponse,
        summary="V4: freeze the participant list and generate every ticket (admin)",
    )
    async def post_confirm_participants(
        session_id: str, admin=Depends(require_admin_dep), max_concurrency: int = 20,
    ) -> ConfirmParticipantsResponse:
        try:
            sess = await _session_or_404(session_id)
        except EligibilityError as exc:
            raise HTTPException(
                status_code=exc.http_status,
                detail={"error": exc.code, "message": exc.message},
            ) from exc
        if sess.get("enrollment_frozen_at"):
            # Idempotent replay — never re-enroll, never regenerate. Purely
            # read-only, so it's safe regardless of the CURRENT flag state
            # (nothing is charged here). Report the durable, originally-
            # frozen state.
            r = await _readiness(session_id)
            return ConfirmParticipantsResponse(
                session_id=session_id, already_frozen=True,
                participant_count=r["eligible"], joined=0,
                already_had_ticket=r["tickets"], failed=[],
            )

        # NOTE (V4.2): this used to re-check speaking_lab_direct_join_enabled
        # here, because confirming participants used to trigger a real
        # per-student wallet charge via _perform_join. It no longer does —
        # perform_free_ticket_issuance_fn performs no wallet/treasury
        # operation at all, so there is no financial action left for that
        # flag to gate. Keeping the check would only block free ticket
        # issuance for no reason (and reproduce the exact "Direct Join is
        # not enabled yet" confusion this flag was never meant to cause
        # for a non-financial flow). The flag still gates the genuinely
        # paid callers (typed code, one-tap) inside speaking_lab_direct_join.py.

        # Computed and stored ONCE, here, at the moment of freeze. Every
        # later read (readiness, a replayed confirm call) uses this stored
        # list — never recomputed from live roster/override state — so a
        # student added to the roster after freeze can never silently
        # inflate the eligible count or cause a false readiness mismatch.
        participants = await _final_participant_ids(session_id)
        await SL_SESSIONS.update_one(
            {"session_id": session_id},
            {"$set": {
                "enrollment_frozen_at": utcnow().isoformat(),
                "enrollment_frozen_by": getattr(admin, "email", "") or "",
                "enrollment_frozen_participants": participants,
            }},
        )

        sem = asyncio.Semaphore(max_concurrency)
        counters = {"joined": 0, "already_had_ticket": 0}
        failed: list[dict] = []

        async def _one(entry: dict) -> None:
            async with sem:
                outcome, detail = await _attempt_ticket_issuance(
                    session_id, entry, "confirm_participants")
                if outcome == "failed":
                    failed.append(detail)
                else:
                    counters[outcome] += 1

        await asyncio.gather(*(_one(e) for e in participants))

        return ConfirmParticipantsResponse(
            session_id=session_id,
            participant_count=len(participants),
            joined=counters["joined"],
            already_had_ticket=counters["already_had_ticket"],
            failed=failed,
        )

    async def _ticketed_ids_for(session_id: str, participant_ids: list[str]) -> set[str]:
        """Same "who already has a committed ticket" query `_readiness` uses
        — the single source of truth both readiness display and Retry
        Failed's "only retry the actually-missing ones" logic read from."""
        ids: set[str] = set()
        cur = db[COLLECTION_DIRECT_JOINS].find(
            {"session_id": session_id, "status": "committed",
             "student_id": {"$in": participant_ids or [""]}},
            {"_id": 0, "student_id": 1},
        )
        async for row in cur:
            ids.add(row["student_id"])
        return ids

    @api.post(
        "/speaking-lab/sessions/{session_id}/confirm-participants/retry-failed",
        response_model=RetryFailedResponse,
        summary="V4.3 Recovery Mode: retry ticket issuance for currently-missing participants only (admin)",
    )
    async def post_retry_failed_participants(
        session_id: str, body: dict | None = None,
        admin=Depends(require_admin_dep), max_concurrency: int = 20,
    ) -> RetryFailedResponse:
        """Recovery Mode. Never re-issues an already-ticketed student (every
        call re-reads the CURRENT committed-ticket set first), never
        regenerates a Lucky Code for one that exists (``persist_lucky_code``
        / ``_perform_free_ticket_issuance`` are themselves idempotent —
        this endpoint adds no new duplicate-protection layer, it just calls
        the same reusable issuance path again for a narrower set of
        students). Safe to call repeatedly, safe after a page refresh or a
        server restart: all state this reads and writes is durable Mongo
        state, nothing in memory.

        ``body.student_ids`` (optional) — retry only these specific
        students ("Retry Individual Student"); omitted or empty ->
        retry every currently-missing participant ("Retry All Failed").
        Ids outside the frozen participant set, or that already have a
        ticket, are silently ignored rather than erroring — the caller may
        be retrying a stale UI snapshot.
        """
        try:
            sess = await _session_or_404(session_id)
        except EligibilityError as exc:
            raise HTTPException(
                status_code=exc.http_status,
                detail={"error": exc.code, "message": exc.message},
            ) from exc
        if not sess.get("enrollment_frozen_at"):
            raise HTTPException(
                status_code=409,
                detail={"error": "not_frozen", "message": "Confirm Participants has not run yet."},
            )

        participants: list[dict] = sess.get("enrollment_frozen_participants") or []
        participant_ids = [e["student_id"] for e in participants]
        ticketed = await _ticketed_ids_for(session_id, participant_ids)
        missing = [e for e in participants if e["student_id"] not in ticketed]

        requested = (body or {}).get("student_ids") if body else None
        if requested:
            requested_set = {norm_student_id(sid) for sid in requested}
            missing = [e for e in missing if e["student_id"] in requested_set]

        if not missing:
            return RetryFailedResponse(
                session_id=session_id, attempted=0, recovered=0,
                already_had_ticket=0, still_failed=[],
            )

        sem = asyncio.Semaphore(max_concurrency)
        counters = {"joined": 0, "already_had_ticket": 0}
        still_failed: list[dict] = []

        async def _one(entry: dict) -> None:
            async with sem:
                outcome, detail = await _attempt_ticket_issuance(
                    session_id, entry, "retry_failed_participants")
                if outcome == "failed":
                    still_failed.append(detail)
                else:
                    counters[outcome] += 1

        await asyncio.gather(*(_one(e) for e in missing))

        return RetryFailedResponse(
            session_id=session_id,
            attempted=len(missing),
            recovered=counters["joined"],
            already_had_ticket=counters["already_had_ticket"],
            still_failed=still_failed,
        )

    async def _readiness(session_id: str) -> dict:
        sess = await _session_or_404(session_id)
        frozen = bool(sess.get("enrollment_frozen_at"))
        if not frozen:
            return {"session_id": session_id, "frozen": False,
                    "eligible": 0, "tickets": 0, "notifications_sent": 0, "ready": False,
                    "participant_ids": [], "failed_detail": []}
        # The durable, frozen-at-confirm-time list — NEVER recomputed from
        # live roster/override state, so a post-freeze roster change can
        # never move this number.
        participants = sess.get("enrollment_frozen_participants") or []
        participant_ids = [e["student_id"] for e in participants]
        eligible = len(participant_ids)

        ticketed_ids = await _ticketed_ids_for(session_id, participant_ids)
        tickets = len(ticketed_ids)

        notifications_sent = await db[COLLECTION_DIRECT_JOINS].count_documents(
            {"session_id": session_id, "status": "committed",
             "notification_status": "sent",
             "student_id": {"$in": participant_ids or [""]}},
        )

        # Why each confirmed-but-unticketed participant failed, sourced
        # from the durable, always-fails-open enrollment audit trail —
        # never a guess, and never blocks readiness itself if this read
        # fails (a diagnostic nicety, not load-bearing).
        missing_ids = [sid for sid in participant_ids if sid not in ticketed_ids]
        failed_detail: list[dict] = []
        if missing_ids:
            try:
                latest_reason: dict[str, str] = {}
                audit_cur = db[enroll_audit.COLLECTION_ENROLLMENT_AUDIT].find(
                    {"session_id": session_id, "student_id": {"$in": missing_ids}},
                    {"_id": 0, "student_id": 1, "reason_code": 1, "ts": 1},
                ).sort("ts", 1)
                async for row in audit_cur:
                    latest_reason[row["student_id"]] = row.get("reason_code") or "unknown"
                failed_detail = [
                    {"student_id": sid, "reason": latest_reason.get(sid, "no_attempt_recorded")}
                    for sid in missing_ids
                ]
            except Exception:  # noqa: BLE001
                failed_detail = [{"student_id": sid, "reason": "unknown"} for sid in missing_ids]

        return {
            "session_id": session_id, "frozen": True,
            "eligible": eligible, "tickets": tickets,
            "notifications_sent": notifications_sent,
            "ready": eligible > 0 and tickets == eligible,
            # Recovery Mode (V4.3) — see ReadinessResponse.playable docstring.
            "playable": eligible > 0 and tickets > 0,
            "failed_count": len(missing_ids),
            "participant_ids": participant_ids,
            "failed_detail": failed_detail,
        }

    @api.get(
        "/speaking-lab/sessions/{session_id}/readiness",
        response_model=ReadinessResponse,
        summary="V4: Eligible vs Tickets vs Notifications — blocks game start on mismatch (admin)",
    )
    async def get_readiness(
        session_id: str, _admin=Depends(require_admin_dep),
    ) -> ReadinessResponse:
        try:
            r = await _readiness(session_id)
        except EligibilityError as exc:
            raise HTTPException(
                status_code=exc.http_status,
                detail={"error": exc.code, "message": exc.message},
            ) from exc
        return ReadinessResponse(**r)
