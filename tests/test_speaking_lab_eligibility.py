"""
Speaking Lab V4 — Attendance-Assisted Auto Enrollment (Phase 1) tests
=============================================================================

Exercises the REAL production code (speaking_lab_eligibility.py) against
the SAME fake Mongo layer used by test_speaking_lab_direct_join.py
(imported, not duplicated), and reuses the REAL _perform_join /
_eligible_roster closures from speaking_lab_direct_join.py via its route
factory's returned hooks — this suite proves the V4 enrollment layer sits
on top of the unchanged Direct Join atomic core, never a second one.

Run from the backend folder:

    pytest -q tests/test_speaking_lab_eligibility.py --asyncio-mode=auto
"""
from __future__ import annotations

import pathlib
import sys
from datetime import datetime, timedelta, timezone

import pytest

BACKEND_DIR = pathlib.Path(__file__).resolve().parent.parent
TESTS_DIR = pathlib.Path(__file__).resolve().parent
for p in (BACKEND_DIR, TESTS_DIR):
    if str(p) not in sys.path:
        sys.path.insert(0, str(p))

import wallet_service as ws  # noqa: E402
import speaking_lab_direct_join as dj  # noqa: E402
import speaking_lab_eligibility as elig  # noqa: E402

from test_speaking_lab_direct_join import (  # noqa: E402
    _build_db, _seed_session, _seed_student, _seed_wallet, _norm, _Student,
    _noop_publish, _enable_direct_join, PushRecorder,
)


@pytest.fixture(autouse=True)
def _force_transactions_supported():
    """Autouse fixtures are file-scoped in pytest — this mirrors the
    identical fixture in test_speaking_lab_direct_join.py so the fake
    WalletService.transfer used here doesn't raise TransferNotAtomic."""
    prev = ws.MONGO_SUPPORTS_TRANSACTIONS
    ws.MONGO_SUPPORTS_TRANSACTIONS = True
    yield
    ws.MONGO_SUPPORTS_TRANSACTIONS = prev


class _Admin:
    def __init__(self, email="teacher@eduhub.test"):
        self.email = email
        self.is_admin = True


def _build_v4_client(db, *, push=None):
    from fastapi import APIRouter, FastAPI
    from fastapi.testclient import TestClient

    api = APIRouter(prefix="/api")

    async def _require_student_dyn():
        return _Student("unused")

    async def _require_admin_dyn():
        return _Admin()

    hooks = dj.register_speaking_lab_direct_join_routes(
        api, db, db.speaking_lab_sessions, db.speaking_lab_entries,
        push or _noop_publish, _require_student_dyn, _norm,
        push_notify=push, require_admin_dep=_require_admin_dyn,
    )
    elig.register_eligibility_routes(
        api, db, db.speaking_lab_sessions,
        hooks["eligible_roster"], hooks["perform_join"], _norm,
        require_admin_dep=_require_admin_dyn,
    )
    app = FastAPI()
    app.include_router(api)
    return TestClient(app)


async def _seed_attendance(db, student_id, *, status="present_full", hours_ago=1.0, class_id="c1"):
    checked_in_at = (datetime.now(timezone.utc) - timedelta(hours=hours_ago)).isoformat()
    await db["attendance_records"].insert_one({
        "student_id": _norm(student_id), "class_id": class_id,
        "status": status, "checked_in_at": checked_in_at,
    })


async def _setup_basic_session(db, *, fee=4, schedule="A"):
    await _seed_session(db, sid="s1", schedule=schedule, fee=fee, status="waiting")
    await _seed_wallet(db, "stu092", 0)
    await _enable_direct_join(db)


# ═════════════════════════════════════════════════════════════════════════════
# Eligibility classification
# ═════════════════════════════════════════════════════════════════════════════

@pytest.mark.asyncio
async def test_1_auto_eligible_when_roster_and_recent_attendance():
    db = _build_db()
    await _setup_basic_session(db)
    await _seed_student(db, "stupresent", group="A")
    await _seed_wallet(db, "stupresent", 10)
    await _seed_attendance(db, "stupresent", status="present_full", hours_ago=1)
    client = _build_v4_client(db)

    r = client.get("/api/speaking-lab/sessions/s1/eligibility")
    body = r.json()
    assert [e["student_id"] for e in body["auto_eligible"]] == ["stupresent"]
    assert body["needs_review"] == []


@pytest.mark.asyncio
async def test_2_needs_review_when_no_attendance_record():
    db = _build_db()
    await _setup_basic_session(db)
    await _seed_student(db, "stunosignal", group="A")
    await _seed_wallet(db, "stunosignal", 10)
    client = _build_v4_client(db)

    r = client.get("/api/speaking-lab/sessions/s1/eligibility")
    body = r.json()
    assert body["auto_eligible"] == []
    assert [e["student_id"] for e in body["needs_review"]] == ["stunosignal"]


@pytest.mark.asyncio
async def test_3_needs_review_when_attendance_is_stale():
    db = _build_db()
    await _setup_basic_session(db)
    await _seed_student(db, "stustale", group="A")
    await _seed_wallet(db, "stustale", 10)
    await _seed_attendance(db, "stustale", status="present_full", hours_ago=20)  # beyond 8h window
    client = _build_v4_client(db)

    r = client.get("/api/speaking-lab/sessions/s1/eligibility")
    body = r.json()
    assert body["auto_eligible"] == []
    assert [e["student_id"] for e in body["needs_review"]] == ["stustale"]


@pytest.mark.asyncio
async def test_4_partial_and_late_also_count_as_present():
    db = _build_db()
    await _setup_basic_session(db)
    await _seed_student(db, "stupartial", group="A")
    await _seed_wallet(db, "stupartial", 10)
    await _seed_attendance(db, "stupartial", status="present_partial", hours_ago=1)
    await _seed_student(db, "stulate", group="A")
    await _seed_wallet(db, "stulate", 10)
    await _seed_attendance(db, "stulate", status="late", hours_ago=1)
    client = _build_v4_client(db)

    r = client.get("/api/speaking-lab/sessions/s1/eligibility")
    ids = {e["student_id"] for e in r.json()["auto_eligible"]}
    assert ids == {"stupartial", "stulate"}


@pytest.mark.asyncio
async def test_5_absent_status_does_not_count_as_present():
    db = _build_db()
    await _setup_basic_session(db)
    await _seed_student(db, "stuabsent", group="A")
    await _seed_wallet(db, "stuabsent", 10)
    await _seed_attendance(db, "stuabsent", status="absent", hours_ago=1)
    client = _build_v4_client(db)

    r = client.get("/api/speaking-lab/sessions/s1/eligibility")
    body = r.json()
    assert body["auto_eligible"] == []
    assert [e["student_id"] for e in body["needs_review"]] == ["stuabsent"]


@pytest.mark.asyncio
async def test_6_excluded_when_not_on_schedule_roster():
    db = _build_db()
    await _setup_basic_session(db, schedule="A")
    await _seed_student(db, "stub1", group="B")  # wrong schedule
    await _seed_wallet(db, "stub1", 10)
    client = _build_v4_client(db)

    r = client.get("/api/speaking-lab/sessions/s1/eligibility")
    body = r.json()
    all_ids = {e["student_id"] for e in body["auto_eligible"] + body["needs_review"]}
    assert "stub1" not in all_ids
    assert body["excluded_count"] >= 1


# ═════════════════════════════════════════════════════════════════════════════
# Teacher review: approve / reject / approve-all / manual admit
# ═════════════════════════════════════════════════════════════════════════════

@pytest.mark.asyncio
async def test_7_approve_moves_needs_review_to_auto_eligible():
    db = _build_db()
    await _setup_basic_session(db)
    await _seed_student(db, "stureview", group="A")
    await _seed_wallet(db, "stureview", 10)
    client = _build_v4_client(db)

    r1 = client.get("/api/speaking-lab/sessions/s1/eligibility")
    assert [e["student_id"] for e in r1.json()["needs_review"]] == ["stureview"]

    r2 = client.post("/api/speaking-lab/sessions/s1/eligibility/decision",
                      json={"student_id": "stureview", "decision": "approve"})
    assert r2.status_code == 200

    r3 = client.get("/api/speaking-lab/sessions/s1/eligibility")
    body = r3.json()
    assert [e["student_id"] for e in body["auto_eligible"]] == ["stureview"]
    assert body["needs_review"] == []


@pytest.mark.asyncio
async def test_8_reject_removes_a_present_student_from_auto_eligible():
    db = _build_db()
    await _setup_basic_session(db)
    await _seed_student(db, "sturejected", group="A")
    await _seed_wallet(db, "sturejected", 10)
    await _seed_attendance(db, "sturejected", status="present_full", hours_ago=1)
    client = _build_v4_client(db)

    r1 = client.get("/api/speaking-lab/sessions/s1/eligibility")
    assert [e["student_id"] for e in r1.json()["auto_eligible"]] == ["sturejected"]

    client.post("/api/speaking-lab/sessions/s1/eligibility/decision",
                json={"student_id": "sturejected", "decision": "reject"})

    r2 = client.get("/api/speaking-lab/sessions/s1/eligibility")
    body = r2.json()
    all_ids = {e["student_id"] for e in body["auto_eligible"] + body["needs_review"]}
    assert "sturejected" not in all_ids
    assert "sturejected" in body["rejected"]


@pytest.mark.asyncio
async def test_9_approve_all_pending_bulk_approves_the_whole_review_list():
    db = _build_db()
    await _setup_basic_session(db)
    for sid in ("stu1", "stu2", "stu3"):
        await _seed_student(db, sid, group="A")
        await _seed_wallet(db, sid, 10)
    client = _build_v4_client(db)

    r1 = client.post("/api/speaking-lab/sessions/s1/eligibility/approve-all-pending")
    assert r1.json()["approved"] == 3

    r2 = client.get("/api/speaking-lab/sessions/s1/eligibility")
    body = r2.json()
    assert {e["student_id"] for e in body["auto_eligible"]} == {"stu1", "stu2", "stu3"}
    assert body["needs_review"] == []


@pytest.mark.asyncio
async def test_10_manual_admit_adds_an_excluded_student_to_the_reviewable_set():
    db = _build_db()
    await _setup_basic_session(db, schedule="A")
    await _seed_student(db, "stuoutside", group="B")  # not on the A roster
    await _seed_wallet(db, "stuoutside", 10)
    client = _build_v4_client(db)

    r1 = client.get("/api/speaking-lab/sessions/s1/eligibility")
    assert r1.json()["manual_admits"] == []

    client.post("/api/speaking-lab/sessions/s1/eligibility/decision",
                json={"student_id": "stuoutside", "decision": "manual_admit",
                      "display_name": "Outside Student"})

    r2 = client.get("/api/speaking-lab/sessions/s1/eligibility")
    body = r2.json()
    assert [e["student_id"] for e in body["manual_admits"]] == ["stuoutside"]


@pytest.mark.asyncio
async def test_11_clear_removes_a_previous_decision():
    db = _build_db()
    await _setup_basic_session(db)
    await _seed_student(db, "stuclear", group="A")
    await _seed_wallet(db, "stuclear", 10)
    client = _build_v4_client(db)

    client.post("/api/speaking-lab/sessions/s1/eligibility/decision",
                json={"student_id": "stuclear", "decision": "approve"})
    client.post("/api/speaking-lab/sessions/s1/eligibility/decision",
                json={"student_id": "stuclear", "decision": "clear"})

    r = client.get("/api/speaking-lab/sessions/s1/eligibility")
    assert [e["student_id"] for e in r.json()["needs_review"]] == ["stuclear"]


# ═════════════════════════════════════════════════════════════════════════════
# Confirm Participants (freeze) — exactly one ticket, idempotent, isolated
# ═════════════════════════════════════════════════════════════════════════════

@pytest.mark.asyncio
async def test_12_confirm_participants_generates_exactly_one_ticket_each():
    db = _build_db()
    await _setup_basic_session(db)
    for sid in ("stua1", "stua2", "stua3"):
        await _seed_student(db, sid, group="A")
        await _seed_wallet(db, sid, 10)
        await _seed_attendance(db, sid, status="present_full", hours_ago=1)
    client = _build_v4_client(db)

    r = client.post("/api/speaking-lab/sessions/s1/confirm-participants")
    assert r.status_code == 200
    body = r.json()
    assert body["participant_count"] == 3
    assert body["joined"] == 3
    assert body["already_frozen"] is False

    for sid in ("stua1", "stua2", "stua3"):
        join = await db[dj.COLLECTION_DIRECT_JOINS].find_one(
            {"session_id": "s1", "student_id": sid, "status": "committed"})
        assert join and join["lucky_code"]


@pytest.mark.asyncio
async def test_13_confirm_participants_freezes_and_replay_never_double_charges():
    db = _build_db()
    await _setup_basic_session(db)
    await _seed_student(db, "stufreeze", group="A")
    await _seed_wallet(db, "stufreeze", 10)
    await _seed_attendance(db, "stufreeze", status="present_full", hours_ago=1)
    client = _build_v4_client(db)

    r1 = client.post("/api/speaking-lab/sessions/s1/confirm-participants")
    assert r1.json()["joined"] == 1

    r2 = client.post("/api/speaking-lab/sessions/s1/confirm-participants")
    assert r2.json()["already_frozen"] is True

    wallet = await db[ws.COLL_WALLETS].find_one({"student_id": "stufreeze"})
    assert wallet["balance"] == 6  # charged exactly once


@pytest.mark.asyncio
async def test_14_decisions_are_blocked_after_freeze():
    db = _build_db()
    await _setup_basic_session(db)
    await _seed_student(db, "stulocked", group="A")
    await _seed_wallet(db, "stulocked", 10)
    client = _build_v4_client(db)

    client.post("/api/speaking-lab/sessions/s1/confirm-participants")

    r = client.post("/api/speaking-lab/sessions/s1/eligibility/decision",
                     json={"student_id": "stulocked", "decision": "approve"})
    assert r.status_code == 409
    assert r.json()["detail"]["error"] == "enrollment_frozen"

    r2 = client.post("/api/speaking-lab/sessions/s1/eligibility/approve-all-pending")
    assert r2.status_code == 409


@pytest.mark.asyncio
async def test_15_confirm_participants_isolates_per_student_failure():
    db = _build_db()
    await _seed_session(db, sid="s1", schedule="A", fee=50, status="waiting")
    await _seed_wallet(db, "stu092", 0)
    await _enable_direct_join(db)
    await _seed_student(db, "sturich", group="A")
    await _seed_wallet(db, "sturich", 100)
    await _seed_attendance(db, "sturich", status="present_full", hours_ago=1)
    await _seed_student(db, "stupoor", group="A")
    await _seed_wallet(db, "stupoor", 3)  # far below the 50 fee
    await _seed_attendance(db, "stupoor", status="present_full", hours_ago=1)
    client = _build_v4_client(db)

    r = client.post("/api/speaking-lab/sessions/s1/confirm-participants")
    body = r.json()
    assert body["participant_count"] == 2
    assert body["joined"] == 1
    assert len(body["failed"]) == 1
    assert body["failed"][0]["student_id"] == "stupoor"

    join = await db[dj.COLLECTION_DIRECT_JOINS].find_one(
        {"session_id": "s1", "student_id": "sturich", "status": "committed"})
    assert join and join["lucky_code"]


@pytest.mark.asyncio
async def test_16_confirm_participants_sends_the_lucky_code_push_per_student():
    db = _build_db()
    await _setup_basic_session(db)
    await _seed_student(db, "stupush", group="A")
    await _seed_wallet(db, "stupush", 10)
    await _seed_attendance(db, "stupush", status="present_full", hours_ago=1)
    push = PushRecorder(mode="sent")
    client = _build_v4_client(db, push=push)

    r = client.post("/api/speaking-lab/sessions/s1/confirm-participants")
    assert r.json()["joined"] == 1
    assert len(push.calls) == 1
    assert push.calls[0][0] == "stupush"


# ═════════════════════════════════════════════════════════════════════════════
# Readiness gate
# ═════════════════════════════════════════════════════════════════════════════

@pytest.mark.asyncio
async def test_17_readiness_not_ready_before_freeze():
    db = _build_db()
    await _setup_basic_session(db)
    client = _build_v4_client(db)

    r = client.get("/api/speaking-lab/sessions/s1/readiness")
    body = r.json()
    assert body["frozen"] is False
    assert body["ready"] is False


@pytest.mark.asyncio
async def test_18_readiness_ready_when_all_tickets_generated():
    db = _build_db()
    await _setup_basic_session(db)
    for sid in ("stua1", "stua2"):
        await _seed_student(db, sid, group="A")
        await _seed_wallet(db, sid, 10)
        await _seed_attendance(db, sid, status="present_full", hours_ago=1)
    client = _build_v4_client(db)

    client.post("/api/speaking-lab/sessions/s1/confirm-participants")
    r = client.get("/api/speaking-lab/sessions/s1/readiness")
    body = r.json()
    assert body["frozen"] is True
    assert body["eligible"] == 2
    assert body["tickets"] == 2
    assert body["ready"] is True


@pytest.mark.asyncio
async def test_19_readiness_blocks_when_ticket_count_falls_short():
    db = _build_db()
    await _seed_session(db, sid="s1", schedule="A", fee=50, status="waiting")
    await _seed_wallet(db, "stu092", 0)
    await _enable_direct_join(db)
    await _seed_student(db, "sturich", group="A")
    await _seed_wallet(db, "sturich", 100)
    await _seed_attendance(db, "sturich", status="present_full", hours_ago=1)
    await _seed_student(db, "stupoor", group="A")
    await _seed_wallet(db, "stupoor", 3)
    await _seed_attendance(db, "stupoor", status="present_full", hours_ago=1)
    client = _build_v4_client(db)

    client.post("/api/speaking-lab/sessions/s1/confirm-participants")
    r = client.get("/api/speaking-lab/sessions/s1/readiness")
    body = r.json()
    assert body["eligible"] == 2
    assert body["tickets"] == 1
    assert body["ready"] is False


@pytest.mark.asyncio
async def test_20_readiness_unaffected_by_roster_growth_after_freeze():
    """The bug this test exists to catch: readiness must read the
    DURABLE frozen participant list, never recompute live off the
    current roster — otherwise a student added after freeze would
    silently inflate 'eligible' and cause a false Cannot Start."""
    db = _build_db()
    await _setup_basic_session(db)
    await _seed_student(db, "stuoriginal", group="A")
    await _seed_wallet(db, "stuoriginal", 10)
    await _seed_attendance(db, "stuoriginal", status="present_full", hours_ago=1)
    client = _build_v4_client(db)

    r1 = client.post("/api/speaking-lab/sessions/s1/confirm-participants")
    assert r1.json()["participant_count"] == 1

    # A brand-new eligible student appears AFTER the freeze.
    await _seed_student(db, "stulate_addition", group="A")
    await _seed_wallet(db, "stulate_addition", 10)
    await _seed_attendance(db, "stulate_addition", status="present_full", hours_ago=1)

    r2 = client.get("/api/speaking-lab/sessions/s1/readiness")
    body = r2.json()
    assert body["eligible"] == 1  # unchanged — still the frozen count
    assert body["tickets"] == 1
    assert body["ready"] is True

    # A second confirm-participants call must also stay a pure replay —
    # never enroll the late addition.
    r3 = client.post("/api/speaking-lab/sessions/s1/confirm-participants")
    assert r3.json()["already_frozen"] is True
    late_join = await db[dj.COLLECTION_DIRECT_JOINS].find_one(
        {"session_id": "s1", "student_id": "stulate_addition"})
    assert late_join is None


@pytest.mark.asyncio
async def test_21_notifications_sent_count_reflects_push_delivery():
    db = _build_db()
    await _setup_basic_session(db)
    await _seed_student(db, "stunotify", group="A")
    await _seed_wallet(db, "stunotify", 10)
    await _seed_attendance(db, "stunotify", status="present_full", hours_ago=1)
    push = PushRecorder(mode="no_subscribers")  # tickets succeed, push doesn't
    client = _build_v4_client(db, push=push)

    client.post("/api/speaking-lab/sessions/s1/confirm-participants")
    r = client.get("/api/speaking-lab/sessions/s1/readiness")
    body = r.json()
    assert body["tickets"] == 1
    assert body["notifications_sent"] == 0  # honestly reflects no_subscribers


@pytest.mark.asyncio
async def test_22_eligibility_and_confirm_reject_a_non_admin_caller():
    """require_admin_dep is a mandatory parameter on the factory (no
    silent-skip path exists) — this proves the dependency it's wired to
    is actually ENFORCED per-request, not merely present."""
    db = _build_db()
    await _setup_basic_session(db)
    from fastapi import APIRouter, FastAPI, HTTPException
    from fastapi.testclient import TestClient

    api = APIRouter(prefix="/api")

    async def _require_student_dyn():
        return _Student("unused")

    async def _reject_non_admin():
        raise HTTPException(status_code=403, detail="Admin access required")

    hooks = dj.register_speaking_lab_direct_join_routes(
        api, db, db.speaking_lab_sessions, db.speaking_lab_entries,
        _noop_publish, _require_student_dyn, _norm,
        require_admin_dep=_reject_non_admin,
    )
    elig.register_eligibility_routes(
        api, db, db.speaking_lab_sessions,
        hooks["eligible_roster"], hooks["perform_join"], _norm,
        require_admin_dep=_reject_non_admin,
    )
    app = FastAPI()
    app.include_router(api)
    client = TestClient(app)

    r1 = client.get("/api/speaking-lab/sessions/s1/eligibility")
    assert r1.status_code == 403
    r2 = client.post("/api/speaking-lab/sessions/s1/confirm-participants")
    assert r2.status_code == 403
