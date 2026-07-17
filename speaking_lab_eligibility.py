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
   applied only within the roster: does this student have a RECENT
   attendance_records entry (default: last 8 hours) with a present-type
   status (present_full / present_partial / late)? If yes -> AUTO
   ELIGIBLE. If no record at all, or the record is stale -> NEEDS REVIEW.
   This is deliberately NOT a rigid 1:1 binding to one specific
   attendance class/session (the two systems have no such binding today
   — see the architecture review) — it is a class-agnostic "did this
   student prove presence recently" signal, which is what lets the
   teacher trust auto-eligibility for the common case while still
   reviewing genuine exceptions (attendance sync delay, different class,
   partial attendance).
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
from datetime import datetime, timedelta, timezone
from typing import Any, Awaitable, Callable, Optional

from fastapi import APIRouter, Depends, HTTPException
from pydantic import BaseModel, ConfigDict

logger = logging.getLogger("eduhub.speaking_lab_eligibility")

COLLECTION_OVERRIDES = "speaking_lab_eligibility_overrides"
COLLECTION_ATTENDANCE_RECORDS = "attendance_records"
COLLECTION_DIRECT_JOINS = "speaking_lab_direct_joins"

# Attendance Passport recency window — a student's most recent present-type
# check-in must fall within this many hours to count as an automatic
# eligibility signal. Deliberately generous (covers same-day, any class)
# rather than a rigid same-session binding, since no such binding exists
# between the Attendance system and Speaking Lab today.
ATTENDANCE_PASSPORT_WINDOW_HOURS = 8

PRESENT_STATUSES = {"present_full", "present_partial", "late"}

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


class ReadinessResponse(BaseModel):
    ok: bool = True
    session_id: str
    frozen: bool
    eligible: int
    tickets: int
    notifications_sent: int
    ready: bool


# ──────────────────────────────────────────────────────────────────────────────
# Attendance Passport — read-only, class-agnostic recency check
# ──────────────────────────────────────────────────────────────────────────────
async def _has_attendance_passport(
    db, canonical_student_id: str, *, window_hours: int = ATTENDANCE_PASSPORT_WINDOW_HOURS,
) -> bool:
    cutoff = (utcnow() - timedelta(hours=window_hours)).isoformat()
    rec = await db[COLLECTION_ATTENDANCE_RECORDS].find_one(
        {
            "student_id": canonical_student_id,
            "status": {"$in": list(PRESENT_STATUSES)},
            "checked_in_at": {"$gte": cutoff},
        },
        {"_id": 0, "student_id": 1},
    )
    return rec is not None


# ──────────────────────────────────────────────────────────────────────────────
# Route factory
# ──────────────────────────────────────────────────────────────────────────────
def register_eligibility_routes(
    api: APIRouter,
    db,
    SL_SESSIONS,
    eligible_roster_fn: Callable[[dict], Awaitable[list[dict]]],
    perform_join_fn: Callable[[str, str, str, str], Awaitable[Any]],
    norm_student_id: Callable[[Any], str],
    require_admin_dep,
    log: Optional[logging.Logger] = None,
) -> None:
    """``eligible_roster_fn`` and ``perform_join_fn`` are the SAME closures
    speaking_lab_direct_join.py's route factory returns — this module
    never re-implements schedule eligibility or the atomic join core."""
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

        auto_eligible: list[dict] = []
        needs_review: list[dict] = []
        roster_ids = {e["student_id"] for e in roster}

        for entry in roster:
            sid = entry["student_id"]
            ov = overrides.get(sid)
            if ov and ov["decision"] == DECISION_REJECT:
                continue  # explicitly excluded by teacher, drop from both lists
            has_passport = await _has_attendance_passport(db, sid)
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

        return {
            "session_id": session_id,
            "roster_size": len(roster),
            "auto_eligible": auto_eligible,
            "needs_review": needs_review,
            "excluded_count": None,  # filled by caller (needs total student count)
            "manual_admits": manual_admits,
            "rejected": rejected,
            "frozen": bool(sess.get("enrollment_frozen_at")),
        }

    async def _final_participant_ids(session_id: str) -> list[dict]:
        """The frozen set: every auto-eligible + manually-admitted student,
        minus none (rejects are already excluded by _classify)."""
        c = await _classify(session_id)
        combined = {e["student_id"]: e for e in c["auto_eligible"]}
        for e in c["manual_admits"]:
            combined.setdefault(e["student_id"], e)
        return list(combined.values())

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
        sess = await _session_or_404(session_id)
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
        sess = await _session_or_404(session_id)
        if sess.get("enrollment_frozen_at"):
            raise HTTPException(
                status_code=409,
                detail={"error": "enrollment_frozen", "message": "Participants are already confirmed."},
            )
        c = await _classify(session_id)
        now_iso = utcnow().isoformat()
        decided_by = getattr(admin, "email", "") or ""
        approved = 0
        for entry in c["needs_review"]:
            await db[COLLECTION_OVERRIDES].update_one(
                {"session_id": session_id, "student_id": entry["student_id"]},
                {"$set": {
                    "session_id": session_id, "student_id": entry["student_id"],
                    "decision": DECISION_APPROVE, "display_name": entry["display_name"],
                    "decided_by": decided_by, "decided_at": now_iso,
                }},
                upsert=True,
            )
            approved += 1
        return {"ok": True, "session_id": session_id, "approved": approved}

    @api.post(
        "/speaking-lab/sessions/{session_id}/confirm-participants",
        response_model=ConfirmParticipantsResponse,
        summary="V4: freeze the participant list and generate every ticket (admin)",
    )
    async def post_confirm_participants(
        session_id: str, admin=Depends(require_admin_dep), max_concurrency: int = 20,
    ) -> ConfirmParticipantsResponse:
        sess = await _session_or_404(session_id)
        if sess.get("enrollment_frozen_at"):
            # Idempotent replay — never re-enroll, never regenerate. Report
            # the durable, originally-frozen state.
            r = await _readiness(session_id)
            return ConfirmParticipantsResponse(
                session_id=session_id, already_frozen=True,
                participant_count=r["eligible"], joined=0,
                already_had_ticket=r["tickets"], failed=[],
            )

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
                idem_key = f"confirm_participants:{session_id}:{entry['student_id']}"
                try:
                    result = await perform_join_fn(
                        session_id, entry["student_id"], entry["display_name"], idem_key,
                    )
                    if getattr(result, "idempotent_replay", False):
                        counters["already_had_ticket"] += 1
                    else:
                        counters["joined"] += 1
                except HTTPException as exc:
                    detail = exc.detail
                    reason = (detail.get("error") if isinstance(detail, dict) else None) or "error"
                    failed.append({"student_id": entry["student_id"], "reason": reason})

        await asyncio.gather(*(_one(e) for e in participants))

        return ConfirmParticipantsResponse(
            session_id=session_id,
            participant_count=len(participants),
            joined=counters["joined"],
            already_had_ticket=counters["already_had_ticket"],
            failed=failed,
        )

    async def _readiness(session_id: str) -> dict:
        sess = await _session_or_404(session_id)
        frozen = bool(sess.get("enrollment_frozen_at"))
        if not frozen:
            return {"session_id": session_id, "frozen": False,
                    "eligible": 0, "tickets": 0, "notifications_sent": 0, "ready": False}
        # The durable, frozen-at-confirm-time list — NEVER recomputed from
        # live roster/override state, so a post-freeze roster change can
        # never move this number.
        participants = sess.get("enrollment_frozen_participants") or []
        participant_ids = [e["student_id"] for e in participants]
        eligible = len(participant_ids)
        tickets = await db[COLLECTION_DIRECT_JOINS].count_documents(
            {"session_id": session_id, "status": "committed",
             "student_id": {"$in": participant_ids or [""]}},
        )
        notifications_sent = await db[COLLECTION_DIRECT_JOINS].count_documents(
            {"session_id": session_id, "status": "committed",
             "notification_status": "sent",
             "student_id": {"$in": participant_ids or [""]}},
        )
        return {
            "session_id": session_id, "frozen": True,
            "eligible": eligible, "tickets": tickets,
            "notifications_sent": notifications_sent,
            "ready": eligible > 0 and tickets == eligible,
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
