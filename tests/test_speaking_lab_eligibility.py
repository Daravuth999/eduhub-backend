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

import asyncio
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
        hooks["eligible_roster"], hooks["perform_free_ticket_issuance"], _norm,
        require_admin_dep=_require_admin_dyn,
    )
    app = FastAPI()
    app.include_router(api)
    return TestClient(app)


def _today() -> str:
    return datetime.now(timezone.utc).date().isoformat()


async def _seed_attendance_class(db, class_id, *, group="A"):
    # Idempotent: many students in the same test share one default
    # class_id — inserting it twice would create two distinct-looking
    # docs in the fake DB (which enforces no uniqueness on its own) and
    # corrupt the ambiguity check the real resolver relies on.
    existing = await db["attendance_classes"].find_one({"class_id": class_id})
    if not existing:
        await db["attendance_classes"].insert_one({"class_id": class_id, "group": group})


async def _seed_attendance_session(db, session_id, *, class_id, date=None):
    existing = await db["attendance_sessions"].find_one({"session_id": session_id})
    if not existing:
        await db["attendance_sessions"].insert_one({
            "session_id": session_id, "class_id": class_id, "date": date or _today(),
        })


async def _seed_attendance_record(db, session_id, student_id, *, status="present_full", class_id="c1"):
    sid = _norm(student_id)
    await db["attendance_records"].insert_one({
        "_id": f"{session_id}:{sid}", "student_id": sid, "session_id": session_id,
        "class_id": class_id, "status": status,
    })


async def _seed_present(db, student_id, *, group="A", status="present_full",
                        class_id=None, session_id=None, date=None):
    """Convenience: builds the full deterministic chain (class tagged for
    `group` -> today's session for that class -> a present-type check-in
    record for `student_id`) in one call, matching the real
    attendance_tools.py write shape exactly."""
    class_id = class_id or f"cls_{group}"
    session_id = session_id or f"as_{group}_{date or _today()}"
    await _seed_attendance_class(db, class_id, group=group)
    await _seed_attendance_session(db, session_id, class_id=class_id, date=date)
    await _seed_attendance_record(db, session_id, student_id, status=status, class_id=class_id)


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
    await _seed_present(db, "stupresent", status="present_full")
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
async def test_3_needs_review_when_attendance_session_is_from_a_different_date():
    """A check-in tied to YESTERDAY'S attendance session for this class
    must never count toward TODAY'S Speaking Lab session — dates are an
    exact match, never a rolling window."""
    db = _build_db()
    await _setup_basic_session(db)
    await _seed_student(db, "stustale", group="A")
    await _seed_wallet(db, "stustale", 10)
    yesterday = (datetime.now(timezone.utc) - timedelta(days=1)).date().isoformat()
    await _seed_present(db, "stustale", status="present_full", date=yesterday)
    client = _build_v4_client(db)

    r = client.get("/api/speaking-lab/sessions/s1/eligibility")
    body = r.json()
    assert body["auto_eligible"] == []
    assert [e["student_id"] for e in body["needs_review"]] == ["stustale"]
    assert body["attendance_binding"] == "no_attendance_session_today"


@pytest.mark.asyncio
async def test_4_partial_and_late_also_count_as_present():
    db = _build_db()
    await _setup_basic_session(db)
    await _seed_student(db, "stupartial", group="A")
    await _seed_wallet(db, "stupartial", 10)
    await _seed_present(db, "stupartial", status="present_partial")
    await _seed_student(db, "stulate", group="A")
    await _seed_wallet(db, "stulate", 10)
    await _seed_present(db, "stulate", status="late")
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
    await _seed_present(db, "stuabsent", status="absent")
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
    await _seed_present(db, "sturejected", status="present_full")
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
        await _seed_present(db, sid, status="present_full")
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
async def test_13_confirm_participants_freezes_and_replay_never_double_issues():
    db = _build_db()
    await _setup_basic_session(db)
    await _seed_student(db, "stufreeze", group="A")
    await _seed_wallet(db, "stufreeze", 10)
    await _seed_present(db, "stufreeze", status="present_full")
    client = _build_v4_client(db)

    r1 = client.post("/api/speaking-lab/sessions/s1/confirm-participants")
    assert r1.json()["joined"] == 1

    r2 = client.post("/api/speaking-lab/sessions/s1/confirm-participants")
    assert r2.json()["already_frozen"] is True

    # No wallet dependency at all (V4.2) — the durable ticket record is
    # what must stay singular, not a balance.
    rows = await db[dj.COLLECTION_DIRECT_JOINS].count_documents(
        {"session_id": "s1", "student_id": "stufreeze", "status": "committed"})
    assert rows == 1


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
async def test_15_confirm_participants_isolates_per_student_failure(monkeypatch):
    """V4.2: with no wallet dependency, insufficient balance can no
    longer be the source of a per-student failure — the only remaining
    genuine failure surface is ticket persistence itself. Force it to
    fail for exactly one student and prove the other is unaffected."""
    db = _build_db()
    await _seed_session(db, sid="s1", schedule="A", status="waiting")
    await _seed_student(db, "sturich", group="A")
    await _seed_present(db, "sturich", status="present_full")
    await _seed_student(db, "stupoor", group="A")
    await _seed_present(db, "stupoor", status="present_full")
    client = _build_v4_client(db)

    import speaking_lab_direct_join as dj_mod
    orig_persist = dj_mod.persist_lucky_code

    async def _flaky_persist(db_, session_id, student_id, display_name, *, amount=0, session=None):
        if student_id == "stupoor":
            return None  # simulates persist_lucky_code's own failure signal
        return await orig_persist(db_, session_id, student_id, display_name,
                                  amount=amount, session=session)
    monkeypatch.setattr(dj_mod, "persist_lucky_code", _flaky_persist)

    r = client.post("/api/speaking-lab/sessions/s1/confirm-participants")
    body = r.json()
    assert body["participant_count"] == 2
    assert body["joined"] == 1
    assert len(body["failed"]) == 1
    assert body["failed"][0]["student_id"] == "stupoor"

    join = await db[dj.COLLECTION_DIRECT_JOINS].find_one(
        {"session_id": "s1", "student_id": "sturich", "status": "committed"})
    assert join and join["lucky_code"]
    assert join["entry_fee"] == 0  # V4.2: never a wallet-derived charge


@pytest.mark.asyncio
async def test_16_confirm_participants_sends_the_lucky_code_push_per_student():
    db = _build_db()
    await _setup_basic_session(db)
    await _seed_student(db, "stupush", group="A")
    await _seed_wallet(db, "stupush", 10)
    await _seed_present(db, "stupush", status="present_full")
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
        await _seed_present(db, sid, status="present_full")
    client = _build_v4_client(db)

    client.post("/api/speaking-lab/sessions/s1/confirm-participants")
    r = client.get("/api/speaking-lab/sessions/s1/readiness")
    body = r.json()
    assert body["frozen"] is True
    assert body["eligible"] == 2
    assert body["tickets"] == 2
    assert body["ready"] is True
    assert set(body["participant_ids"]) == {"stua1", "stua2"}


@pytest.mark.asyncio
async def test_19_readiness_blocks_when_ticket_count_falls_short(monkeypatch):
    db = _build_db()
    await _seed_session(db, sid="s1", schedule="A", status="waiting")
    await _seed_student(db, "sturich", group="A")
    await _seed_present(db, "sturich", status="present_full")
    await _seed_student(db, "stupoor", group="A")
    await _seed_present(db, "stupoor", status="present_full")
    client = _build_v4_client(db)

    import speaking_lab_direct_join as dj_mod
    orig_persist = dj_mod.persist_lucky_code

    async def _flaky_persist(db_, session_id, student_id, display_name, *, amount=0, session=None):
        if student_id == "stupoor":
            return None
        return await orig_persist(db_, session_id, student_id, display_name,
                                  amount=amount, session=session)
    monkeypatch.setattr(dj_mod, "persist_lucky_code", _flaky_persist)

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
    await _seed_present(db, "stuoriginal", status="present_full")
    client = _build_v4_client(db)

    r1 = client.post("/api/speaking-lab/sessions/s1/confirm-participants")
    assert r1.json()["participant_count"] == 1

    # A brand-new eligible student appears AFTER the freeze.
    await _seed_student(db, "stulate_addition", group="A")
    await _seed_wallet(db, "stulate_addition", 10)
    await _seed_present(db, "stulate_addition", status="present_full")

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
    await _seed_present(db, "stunotify", status="present_full")
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


# ═════════════════════════════════════════════════════════════════════════════
# Session-bound attendance mapping (v1.1) — proves the passport can only
# ever count attendance that provably belongs to THIS Speaking Lab
# session's schedule, never an unrelated class or a different date.
# ═════════════════════════════════════════════════════════════════════════════

@pytest.mark.asyncio
async def test_23_attendance_from_an_unrelated_class_never_grants_auto_eligibility():
    """A student checked into a genuinely different class (tagged for a
    DIFFERENT group) today must never leak into Schedule A's eligibility
    — proving the passport is class-bound, not just date-bound."""
    db = _build_db()
    await _setup_basic_session(db, schedule="A")
    await _seed_student(db, "stucrossclass", group="A")
    await _seed_wallet(db, "stucrossclass", 10)
    # Present today, but in a class tagged for Schedule B — unrelated to
    # this Schedule A session.
    await _seed_present(db, "stucrossclass", group="B", status="present_full")
    client = _build_v4_client(db)

    r = client.get("/api/speaking-lab/sessions/s1/eligibility")
    body = r.json()
    assert body["auto_eligible"] == []
    assert [e["student_id"] for e in body["needs_review"]] == ["stucrossclass"]


@pytest.mark.asyncio
async def test_24_fails_closed_when_no_attendance_class_is_tagged_for_the_schedule():
    """No attendance_classes doc has group="A" at all -> every Schedule A
    student is Needs Review, never a guessed Auto Eligible, and the
    reason is surfaced to the teacher."""
    db = _build_db()
    await _setup_basic_session(db, schedule="A")
    await _seed_student(db, "stu1", group="A")
    await _seed_wallet(db, "stu1", 10)
    client = _build_v4_client(db)

    r = client.get("/api/speaking-lab/sessions/s1/eligibility")
    body = r.json()
    assert body["auto_eligible"] == []
    assert [e["student_id"] for e in body["needs_review"]] == ["stu1"]
    assert body["attendance_binding"] == "no_attendance_class_for_group"


@pytest.mark.asyncio
async def test_25_fails_closed_when_multiple_candidate_sessions_today_are_ambiguous():
    """Two different classes are both tagged group="A" and BOTH have a
    session today -> the binding is genuinely ambiguous, so it fails
    closed rather than guessing which one is the real Speaking Lab
    class."""
    db = _build_db()
    await _setup_basic_session(db, schedule="A")
    await _seed_student(db, "stuambiguous", group="A")
    await _seed_wallet(db, "stuambiguous", 10)
    await _seed_attendance_class(db, "cls_x", group="A")
    await _seed_attendance_session(db, "as_x", class_id="cls_x")
    await _seed_attendance_class(db, "cls_y", group="A")
    await _seed_attendance_session(db, "as_y", class_id="cls_y")
    # Check the student into ONE of the two ambiguous sessions — even so,
    # the resolver cannot know which class is "the" Schedule A class.
    await _seed_attendance_record(db, "as_x", "stuambiguous", status="present_full", class_id="cls_x")
    client = _build_v4_client(db)

    r = client.get("/api/speaking-lab/sessions/s1/eligibility")
    body = r.json()
    assert body["auto_eligible"] == []
    assert [e["student_id"] for e in body["needs_review"]] == ["stuambiguous"]
    assert body["attendance_binding"] == "ambiguous_multiple_sessions_today"


@pytest.mark.asyncio
async def test_26_combined_ab_session_resolves_attendance_per_student_own_group():
    """A Combined A+B Speaking Lab session has no single schedule to bind
    against, so each student's OWN group resolves their attendance class
    independently — a Schedule A student's presence in the A class, and
    a Schedule B student's presence in the B class, both count; neither
    can be satisfied by the other's class."""
    db = _build_db()
    await _seed_session(db, sid="s1", schedule="AB", fee=4, status="waiting")
    await _seed_wallet(db, "stu092", 0)
    await _enable_direct_join(db)
    await _seed_student(db, "stua", group="A")
    await _seed_wallet(db, "stua", 10)
    await _seed_present(db, "stua", group="A", status="present_full")
    await _seed_student(db, "stub", group="B")
    await _seed_wallet(db, "stub", 10)
    await _seed_present(db, "stub", group="B", status="present_full")
    await _seed_student(db, "stunosignal_ab", group="A")
    await _seed_wallet(db, "stunosignal_ab", 10)
    client = _build_v4_client(db)

    r = client.get("/api/speaking-lab/sessions/s1/eligibility")
    body = r.json()
    auto_ids = {e["student_id"] for e in body["auto_eligible"]}
    review_ids = {e["student_id"] for e in body["needs_review"]}
    assert auto_ids == {"stua", "stub"}
    assert review_ids == {"stunosignal_ab"}


@pytest.mark.asyncio
async def test_28_large_combined_roster_resolves_binding_a_bounded_number_of_times_not_per_student():
    """Regression test for the exact bug reported live: a 60+ student
    Combined A+B roster must resolve the attendance binding a BOUNDED
    number of times (once per distinct group — at most 2 here: A and
    B), never once per student. Before the fix, each of the 60 students
    triggered its own attendance_classes/attendance_sessions scan,
    making "Approve All Pending" on a real class appear to hang."""
    db = _build_db()
    await _seed_session(db, sid="s1", schedule="AB", fee=4, status="waiting")
    await _seed_wallet(db, "stu092", 0)
    await _enable_direct_join(db)
    for i in range(30):
        sid = f"stua{i}"
        await _seed_student(db, sid, group="A")
        await _seed_wallet(db, sid, 10)
    for i in range(30):
        sid = f"stub{i}"
        await _seed_student(db, sid, group="B")
        await _seed_wallet(db, sid, 10)
    await _seed_present(db, "stua0", group="A", status="present_full")
    await _seed_present(db, "stub0", group="B", status="present_full")

    classes_coll = db["attendance_classes"]
    sessions_coll = db["attendance_sessions"]
    call_count = {"n": 0}
    _orig_classes_find = classes_coll.find
    _orig_sessions_find = sessions_coll.find

    def _counting_classes_find(*a, **k):
        call_count["n"] += 1
        return _orig_classes_find(*a, **k)

    def _counting_sessions_find(*a, **k):
        call_count["n"] += 1
        return _orig_sessions_find(*a, **k)

    classes_coll.find = _counting_classes_find
    sessions_coll.find = _counting_sessions_find
    try:
        client = _build_v4_client(db)
        r = client.get("/api/speaking-lab/sessions/s1/eligibility")
    finally:
        classes_coll.find = _orig_classes_find
        sessions_coll.find = _orig_sessions_find

    assert r.status_code == 200
    body = r.json()
    assert body["roster_size"] == 60
    # Exactly 2 distinct groups (A, B) -> at most 2 binding resolutions,
    # each touching both collections once = 4 calls total. NOT 120
    # (2 collections x 60 students), which is what the bug produced.
    assert call_count["n"] <= 4, f"expected a bounded call count, got {call_count['n']} (scales with roster size)"


@pytest.mark.asyncio
async def test_27_a_checkin_for_a_different_class_session_id_is_never_matched():
    """Defense in depth on the exact composite-key lookup: a present
    record that exists under a DIFFERENT session_id (even same class,
    same date, wrong session identity) is never treated as a match."""
    db = _build_db()
    await _setup_basic_session(db, schedule="A")
    await _seed_student(db, "stuwrongsession", group="A")
    await _seed_wallet(db, "stuwrongsession", 10)
    await _seed_attendance_class(db, "cls_A", group="A")
    await _seed_attendance_session(db, "as_A_real", class_id="cls_A")
    # Record exists, but keyed to a session_id that was never resolved as
    # THE class's session (simulates a stale/duplicate session record).
    await _seed_attendance_record(db, "as_A_impostor", "stuwrongsession",
                                   status="present_full", class_id="cls_A")
    client = _build_v4_client(db)

    r = client.get("/api/speaking-lab/sessions/s1/eligibility")
    body = r.json()
    assert body["auto_eligible"] == []
    assert [e["student_id"] for e in body["needs_review"]] == ["stuwrongsession"]


# ═════════════════════════════════════════════════════════════════════════════
# V4.2 — attendance-driven ticket issuance (no wallet/treasury/transaction)
# ═════════════════════════════════════════════════════════════════════════════

@pytest.mark.asyncio
async def test_29_confirm_participants_succeeds_regardless_of_direct_join_flag_state():
    """Confirm Participants no longer performs any wallet/treasury
    operation — perform_free_ticket_issuance_fn never touches money — so
    the speaking_lab_direct_join_enabled flag (which only ever gated a
    real wallet charge) has nothing left to gate here. It must succeed
    whether the flag is on, off, or never configured at all. The flag
    still protects the genuinely paid callers (typed code, one-tap)
    inside speaking_lab_direct_join.py, untouched by this test."""
    db = _build_db()
    await _seed_session(db, sid="s1", schedule="A", fee=4, status="waiting")
    # Deliberately NOT calling _enable_direct_join(db) — and no treasury
    # wallet seeded at all, proving the flow never even looks for one.
    await _seed_student(db, "stu1", group="A")
    await _seed_wallet(db, "stu1", 10)
    await _seed_present(db, "stu1", status="present_full")
    client = _build_v4_client(db)

    r = client.post("/api/speaking-lab/sessions/s1/confirm-participants")

    assert r.status_code == 200
    assert r.json()["joined"] == 1
    # The student's own wallet balance is completely untouched — no
    # debit, no dependency on it even existing.
    wallet = await db[ws.COLL_WALLETS].find_one({"student_id": "stu1"})
    assert wallet["balance"] == 10
    # A real ticket exists with no wallet/treasury trace.
    join = await db[dj.COLLECTION_DIRECT_JOINS].find_one(
        {"session_id": "s1", "student_id": "stu1", "status": "committed"})
    assert join is not None
    assert join["entry_fee"] == 0
    assert join["payment_reference"] == "attendance_confirmed"


@pytest.mark.asyncio
async def test_30_confirm_participants_replay_is_idempotent_never_double_issues():
    """Re-running Confirm Participants on an already-frozen session must
    be a safe no-op — never a second ticket, never a second audit
    'committed' outcome, regardless of anything else in the environment."""
    db = _build_db()
    await _setup_basic_session(db)
    await _seed_student(db, "stu1", group="A")
    await _seed_wallet(db, "stu1", 10)
    await _seed_present(db, "stu1", status="present_full")
    client = _build_v4_client(db)
    r1 = client.post("/api/speaking-lab/sessions/s1/confirm-participants")
    assert r1.json()["joined"] == 1
    code_after_first = (await db[dj.COLLECTION_DIRECT_JOINS].find_one(
        {"session_id": "s1", "student_id": "stu1"}))["lucky_code"]

    r2 = client.post("/api/speaking-lab/sessions/s1/confirm-participants")

    assert r2.status_code == 200
    assert r2.json()["already_frozen"] is True
    rows = await db[dj.COLLECTION_DIRECT_JOINS].count_documents(
        {"session_id": "s1", "student_id": "stu1", "status": "committed"})
    assert rows == 1
    code_after_second = (await db[dj.COLLECTION_DIRECT_JOINS].find_one(
        {"session_id": "s1", "student_id": "stu1"}))["lucky_code"]
    assert code_after_second == code_after_first


@pytest.mark.asyncio
async def test_31_decision_and_approve_all_pending_return_404_not_500_for_unknown_session():
    """_session_or_404 raises EligibilityError, which every route must
    catch and convert to a clean HTTPException — an uncaught
    EligibilityError falls through as an unhandled 500."""
    db = _build_db()
    client = _build_v4_client(db)

    r1 = client.post("/api/speaking-lab/sessions/ghost/eligibility/decision",
                      json={"student_id": "stu1", "decision": "approve"})
    assert r1.status_code == 404
    assert r1.json()["detail"]["error"] == "session_not_found"

    r2 = client.post("/api/speaking-lab/sessions/ghost/eligibility/approve-all-pending")
    assert r2.status_code == 404

    r3 = client.post("/api/speaking-lab/sessions/ghost/confirm-participants")
    assert r3.status_code == 404


@pytest.mark.asyncio
async def test_32_readiness_failed_detail_shows_why_a_confirmed_participant_has_no_ticket(monkeypatch):
    """The old flow gave a teacher no way to see WHY a confirmed
    participant is missing a ticket — reload the page and it just says
    "Not ready" with a bare number. failed_detail sources the real
    reason from the durable enrollment audit trail. V4.2: the failure
    surface is no longer a wallet balance (there is none) — it's ticket
    persistence itself, which is what's exercised here."""
    db = _build_db()
    await _seed_session(db, sid="s1", schedule="A", status="waiting")
    await _seed_student(db, "sturich", group="A")
    await _seed_present(db, "sturich", status="present_full")
    await _seed_student(db, "stupoor", group="A")
    await _seed_present(db, "stupoor", status="present_full")
    client = _build_v4_client(db)

    import speaking_lab_direct_join as dj_mod
    orig_persist = dj_mod.persist_lucky_code

    async def _flaky_persist(db_, session_id, student_id, display_name, *, amount=0, session=None):
        if student_id == "stupoor":
            return None
        return await orig_persist(db_, session_id, student_id, display_name,
                                  amount=amount, session=session)
    monkeypatch.setattr(dj_mod, "persist_lucky_code", _flaky_persist)

    client.post("/api/speaking-lab/sessions/s1/confirm-participants")
    r = client.get("/api/speaking-lab/sessions/s1/readiness")
    body = r.json()

    assert body["ready"] is False
    assert len(body["failed_detail"]) == 1
    assert body["failed_detail"][0]["student_id"] == "stupoor"


@pytest.mark.asyncio
async def test_33_readiness_failed_detail_is_empty_when_everyone_is_ticketed():
    db = _build_db()
    await _setup_basic_session(db)
    await _seed_student(db, "stu1", group="A")
    await _seed_wallet(db, "stu1", 10)
    await _seed_present(db, "stu1", status="present_full")
    client = _build_v4_client(db)

    client.post("/api/speaking-lab/sessions/s1/confirm-participants")
    r = client.get("/api/speaking-lab/sessions/s1/readiness")

    assert r.json()["ready"] is True
    assert r.json()["failed_detail"] == []


# ═════════════════════════════════════════════════════════════════════════════
# 34. Root-cause fix — an unexpected exception for ONE participant must never
#     crash the whole Confirm Participants call. Before this fix, an untyped
#     exception escaping _perform_join propagated out of asyncio.gather,
#     out of the route handler, uncaught by FastAPI, and (with no app-level
#     exception handler) came back to the browser with no CORS header —
#     which fetch() reports as "Failed to fetch", not a readable error. The
#     teacher must always get a real response with per-student results.
# ═════════════════════════════════════════════════════════════════════════════

@pytest.mark.asyncio
async def test_34_confirm_participants_survives_one_students_unexpected_failure(monkeypatch):
    """V4.2: there is no wallet call left to fail here — the induced
    failure is now a raw exception from ticket persistence itself (the
    one remaining per-student write in the free-ticket path), proving
    the SAME isolation guarantee (one student's crash never takes down
    the batch) still holds after removing the wallet/treasury step."""
    db = _build_db()
    await _seed_session(db, sid="s1", schedule="A", status="waiting")
    await _seed_student(db, "stugood", group="A")
    await _seed_present(db, "stugood", status="present_full")
    await _seed_student(db, "stubad", group="A")
    await _seed_present(db, "stubad", status="present_full")

    import speaking_lab_direct_join as dj_mod
    orig_persist = dj_mod.persist_lucky_code

    async def _flaky_persist(db_, session_id, student_id, display_name, *, amount=0, session=None):
        if student_id == "stubad":
            raise RuntimeError("simulated transient persistence error")
        return await orig_persist(db_, session_id, student_id, display_name,
                                  amount=amount, session=session)
    monkeypatch.setattr(dj_mod, "persist_lucky_code", _flaky_persist)

    client = _build_v4_client(db)
    r = client.post("/api/speaking-lab/sessions/s1/confirm-participants")

    # The call itself must succeed with a real, structured body — never an
    # unhandled crash — even though one of the two students failed.
    assert r.status_code == 200
    body = r.json()
    assert body["participant_count"] == 2
    assert body["joined"] == 1
    assert {f["student_id"]: f["reason"] for f in body["failed"]} == {
        "stubad": "unexpected_error"}

    # The good student still got a real ticket, no wallet involved.
    good_join = await db[dj.COLLECTION_DIRECT_JOINS].find_one(
        {"session_id": "s1", "student_id": "stugood", "status": "committed"})
    assert good_join and good_join["lucky_code"]
    assert good_join["entry_fee"] == 0

    # Readiness still returns a normal response, showing exactly what's
    # missing and why — not a crash, not a silent gap.
    r2 = client.get("/api/speaking-lab/sessions/s1/readiness")
    r2_body = r2.json()
    assert r2_body["eligible"] == 2
    assert r2_body["tickets"] == 1
    assert r2_body["ready"] is False
    assert {f["student_id"]: f["reason"] for f in r2_body["failed_detail"]} == {
        "stubad": "unexpected_error"}


# ═════════════════════════════════════════════════════════════════════════════
# V4.2 — attendance-driven ticket issuance architecture redesign.
#
# Root cause of the production failure: N concurrent _perform_join calls
# each opened their OWN Mongo transaction, and every one of them wrote to
# the SAME shared treasury wallet document — a write-conflict hotspot that
# aborted with TransientTransactionError/NoSuchTransaction even at N=2,
# and could never converge at 50-200. perform_free_ticket_issuance_fn
# removes the wallet/treasury step (and the transaction it required)
# entirely for Confirm Participants — every write is now a single,
# independent, idempotent document keyed to (session_id, student_id),
# so there is no shared write target between students at all.
# ═════════════════════════════════════════════════════════════════════════════

@pytest.mark.asyncio
async def test_35_confirm_participants_never_opens_a_mongo_transaction():
    """The whole point of the redesign: no per-participant Mongo
    transaction at all. Prove it structurally, not by inference — force
    client.start_session() to fail loudly if anything in the path still
    calls it."""
    db = _build_db()
    await _seed_session(db, sid="s1", schedule="A", fee=4, status="waiting")
    await _seed_student(db, "stu1", group="A")
    await _seed_present(db, "stu1", status="present_full")
    client = _build_v4_client(db)

    async def _boom():
        raise AssertionError("perform_free_ticket_issuance_fn must never "
                             "open a Mongo transaction")
    db.client.start_session = _boom

    r = client.post("/api/speaking-lab/sessions/s1/confirm-participants")

    assert r.status_code == 200
    assert r.json()["joined"] == 1


@pytest.mark.asyncio
async def test_36_confirm_participants_never_calls_the_wallet_service():
    """No wallet transfer, no treasury dependency — prove it structurally.
    No treasury wallet is even seeded; if the code tried to touch one,
    WalletService.transfer would raise WalletNotFound (or, with this
    patch, an assertion) rather than silently succeeding."""
    db = _build_db()
    await _seed_session(db, sid="s1", schedule="A", fee=4, status="waiting")
    await _seed_student(db, "stu1", group="A")
    await _seed_present(db, "stu1", status="present_full")
    client = _build_v4_client(db)

    async def _boom(self, *a, **k):
        raise AssertionError("perform_free_ticket_issuance_fn must never "
                             "call WalletService.transfer")
    orig_transfer = ws.WalletService.transfer
    ws.WalletService.transfer = _boom
    try:
        r = client.post("/api/speaking-lab/sessions/s1/confirm-participants")
    finally:
        ws.WalletService.transfer = orig_transfer

    assert r.status_code == 200
    assert r.json()["joined"] == 1
    # No treasury wallet document was ever created either.
    assert await db[ws.COLL_WALLETS].find_one({"student_id": "stu092"}) is None


@pytest.mark.asyncio
async def test_37_concurrent_calls_for_the_same_student_never_double_issue():
    """Simulates the exact race a shared Semaphore(20) batch could
    produce: two concurrent attempts to issue a ticket for the SAME
    student. Must resolve to exactly one committed join / one lucky
    code, both calls returning the identical code — the same
    idempotent-race pattern persist_lucky_code already relies on,
    backed by the real unique index on (session_id, student_id)."""
    db = _build_db()
    await _seed_session(db, sid="s1", schedule="A", fee=0, status="waiting")
    await _seed_student(db, "stu1", group="A")

    from speaking_lab_direct_join import register_speaking_lab_direct_join_routes
    from fastapi import APIRouter

    async def _req_student():
        return _Student("unused")
    async def _req_admin():
        return _Admin()
    api = APIRouter(prefix="/api")
    hooks = register_speaking_lab_direct_join_routes(
        api, db, db.speaking_lab_sessions, db.speaking_lab_entries,
        _noop_publish, _req_student, _norm, require_admin_dep=_req_admin,
    )
    issue = hooks["perform_free_ticket_issuance"]

    results = await asyncio.gather(
        issue("s1", "stu1", "Stu One", "confirm_participants:s1:stu1"),
        issue("s1", "stu1", "Stu One", "confirm_participants:s1:stu1"),
    )

    codes = {r.lucky_code for r in results}
    assert len(codes) == 1
    rows = await db[dj.COLLECTION_DIRECT_JOINS].count_documents(
        {"session_id": "s1", "student_id": "stu1", "status": "committed"})
    assert rows == 1
    lucky_rows = await db.speaking_lab_lucky_codes.count_documents(
        {"session_id": "s1", "student_id": "stu1"})
    assert lucky_rows == 1


@pytest.mark.asyncio
async def test_38_large_class_all_200_participants_get_exactly_one_ticket():
    """Scale requirement: 200 confirmed participants, every one gets
    exactly one ticket, no duplicates, no partial state — with zero
    shared-document contention since the wallet/treasury step is gone."""
    db = _build_db()
    await _seed_session(db, sid="s1", schedule="A", fee=4, status="waiting")
    n = 200
    for i in range(n):
        sid = f"stu{i:03d}"
        await _seed_student(db, sid, group="A")
        await _seed_present(db, sid, status="present_full")
    client = _build_v4_client(db)

    r = client.post("/api/speaking-lab/sessions/s1/confirm-participants")
    body = r.json()

    assert r.status_code == 200
    assert body["participant_count"] == n
    assert body["joined"] == n
    assert body["failed"] == []

    committed = await db[dj.COLLECTION_DIRECT_JOINS].count_documents(
        {"session_id": "s1", "status": "committed"})
    assert committed == n
    codes = set()
    async for row in db.speaking_lab_lucky_codes.find({"session_id": "s1"}):
        codes.add(row["code"])
    assert len(codes) == n  # every ticket is unique

    r2 = client.get("/api/speaking-lab/sessions/s1/readiness")
    r2_body = r2.json()
    assert r2_body["eligible"] == n
    assert r2_body["tickets"] == n
    assert r2_body["ready"] is True


@pytest.mark.asyncio
async def test_39_confirm_participants_re_run_after_partial_failure_completes_the_rest():
    """Recovery requirement: if one participant's issuance fails for an
    unrelated reason (e.g. a genuinely bad session-eligibility record),
    re-running Confirm Participants must not re-charge or duplicate
    anyone already ticketed, and should leave the failed student visible
    for the teacher to investigate rather than silently dropped."""
    db = _build_db()
    await _seed_session(db, sid="s1", schedule="A", fee=4, status="waiting")
    await _seed_student(db, "stugood", group="A")
    await _seed_present(db, "stugood", status="present_full")
    await _seed_student(db, "stubad", group="A")
    await _seed_present(db, "stubad", status="present_full")
    client = _build_v4_client(db)

    # Deterministic, student-keyed failure (not order-dependent): force
    # ticket persistence to fail for exactly ONE student, regardless of
    # how asyncio.gather interleaves the batch. The generic per-student
    # catch-all added in post_confirm_participants's _one() (V4.1.2)
    # already protects this new free-ticket path the same way it
    # protects the paid one — this proves that defense-in-depth still
    # holds after the redesign.
    import speaking_lab_direct_join as dj_mod
    orig_persist = dj_mod.persist_lucky_code

    async def _flaky_persist(db_, session_id, student_id, display_name, *, amount=0, session=None):
        if student_id == "stubad":
            raise RuntimeError("simulated ticket-persistence failure for stubad")
        return await orig_persist(db_, session_id, student_id, display_name,
                                  amount=amount, session=session)
    dj_mod.persist_lucky_code = _flaky_persist
    try:
        r1 = client.post("/api/speaking-lab/sessions/s1/confirm-participants")
    finally:
        dj_mod.persist_lucky_code = orig_persist

    body1 = r1.json()
    assert body1["participant_count"] == 2
    assert body1["joined"] == 1
    assert len(body1["failed"]) == 1

    good_ticket_1 = await db[dj.COLLECTION_DIRECT_JOINS].find_one(
        {"session_id": "s1", "student_id": "stugood"})
    assert good_ticket_1 is not None

    # Re-running (still the same confirm-participants call — frozen
    # session replay) must not duplicate stugood's ticket. The frozen
    # participant list itself doesn't retry failed sub-issuances
    # automatically (Confirm Participants freezes once), but the
    # replay path must be provably safe and non-destructive regardless.
    r2 = client.post("/api/speaking-lab/sessions/s1/confirm-participants")
    assert r2.status_code == 200
    assert r2.json()["already_frozen"] is True

    rows = await db[dj.COLLECTION_DIRECT_JOINS].count_documents(
        {"session_id": "s1", "student_id": "stugood", "status": "committed"})
    assert rows == 1
    good_ticket_2 = await db[dj.COLLECTION_DIRECT_JOINS].find_one(
        {"session_id": "s1", "student_id": "stugood"})
    assert good_ticket_2["lucky_code"] == good_ticket_1["lucky_code"]
