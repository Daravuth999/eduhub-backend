"""
Schedule Assignment — persistent Schedule A/B roster split (v1.0)
==================================================================

Covers:
  * single + bulk schedule assignment endpoints on teacher_admission.py
    (writes the existing `students.group` field — no second source of
    truth, no changes to the shared generic PATCH /teacher/students/{id}
    endpoint used by Author Studio / the original PWA);
  * idempotency + audit trail;
  * the safety block against moving a student who already has an active
    entry/lucky code in another schedule's open session;
  * Missing Code Rescue respecting the persisted schedule assignment
    (unassigned / wrong-schedule candidates are never silently restored).

Run from the backend folder:

    cd backend
    pytest -q tests/test_schedule_assignment.py
"""

from __future__ import annotations

import pathlib
import sys

import pytest
from fastapi import APIRouter, FastAPI
from fastapi.testclient import TestClient

BACKEND_DIR = pathlib.Path(__file__).resolve().parent.parent
TESTS_DIR = pathlib.Path(__file__).resolve().parent
for _p in (BACKEND_DIR, TESTS_DIR):
    if str(_p) not in sys.path:
        sys.path.insert(0, str(_p))

import teacher_admission as ta  # noqa: E402

from test_teacher_admit import (  # noqa: E402
    _FakeDB, _norm_student_id, _fake_generate_and_publish, _sl_publish_fake,
    _run, _seed_session_sync, _seed_indexes_sync,
)
from test_missing_code_rescue import _FakeCredits  # noqa: E402

URL_ONE = "/api/speaking-lab/students/{sid}/schedule-assignment"
URL_BULK = "/api/speaking-lab/students/schedule-assignment/bulk"
URL_CAND = "/api/speaking-lab/sessions/{sid}/missing-code-candidates"
URL_RECOVER = "/api/speaking-lab/sessions/{sid}/recover-missing-code"


def _seed_student(db, *, sid="stu004", name="Channrachna Oum", group=""):
    doc = {"clean_id": sid, "student_id": sid, "display_name": name}
    if group:
        doc["group"] = group
    _run(db["students"].insert_one(doc))


def _make_app(db, credits=None, require_admin=None):
    api = APIRouter(prefix="/api")

    class _Admin:
        email = "teacher@school.example"
        user_id = "teacher_001"

    async def _default_require_admin():
        return _Admin()

    ta.register_teacher_admission_routes(
        api=api,
        db=db,
        SL_SESSIONS=db["speaking_lab_sessions"],
        SL_ENTRIES=db["speaking_lab_entries"],
        sl_publish=_sl_publish_fake,
        require_admin_dep=require_admin or _default_require_admin,
        norm_student_id=_norm_student_id,
        generate_and_publish_lucky_code=_fake_generate_and_publish,
        find_recent_treasury_credits=credits.find_recent if credits else None,
    )
    app = FastAPI()
    app.include_router(api)
    ta._force_index_health(True)
    ta._force_recovery_index_health(True)
    return app


@pytest.fixture
def db():
    d = _FakeDB()
    _seed_indexes_sync(d)
    _run(ta.ensure_missing_code_recovery_indexes(d))
    _run(ta.ensure_schedule_assignment_indexes(d))
    return d


@pytest.fixture
def client(db):
    return TestClient(_make_app(db))


# ═════════════════════════════════════════════════════════════════════════════
# 1-2. Assign an unassigned student to A / B
# ═════════════════════════════════════════════════════════════════════════════

def test_1_assign_unassigned_student_to_a(db, client):
    _seed_student(db, sid="stu004", group="")
    r = client.post(URL_ONE.format(sid="stu004"), json={"schedule": "A"})
    assert r.status_code == 200
    body = r.json()
    assert body["outcome"] == "updated"
    assert body["previous_schedule"] == ""
    assert body["new_schedule"] == "A"
    doc = db["students"]._docs[0]
    assert doc["group"] == "A"


def test_2_assign_unassigned_student_to_b(db, client):
    _seed_student(db, sid="stu010", group="")
    r = client.post(URL_ONE.format(sid="stu010"), json={"schedule": "b"})
    assert r.status_code == 200
    assert r.json()["new_schedule"] == "B"


# ═════════════════════════════════════════════════════════════════════════════
# 3. Bulk assignment
# ═════════════════════════════════════════════════════════════════════════════

def test_3_bulk_assign_students(db, client):
    _seed_student(db, sid="stu001", group="")
    _seed_student(db, sid="stu002", group="")
    _seed_student(db, sid="stu003", group="")
    r = client.post(URL_BULK, json={
        "student_ids": ["stu001", "stu002", "stu003"], "schedule": "A",
    })
    assert r.status_code == 200
    body = r.json()
    assert body["updated_count"] == 3
    assert body["skipped_count"] == 0
    for res in body["results"]:
        assert res["outcome"] == "updated"
        assert res["new_schedule"] == "A"


# ═════════════════════════════════════════════════════════════════════════════
# 4. Invalid schedule rejected
# ═════════════════════════════════════════════════════════════════════════════

def test_4_invalid_schedule_rejected(db, client):
    _seed_student(db, sid="stu004", group="")
    r = client.post(URL_ONE.format(sid="stu004"), json={"schedule": "C"})
    assert r.status_code == 422


def test_4b_invalid_schedule_rejected_bulk(db, client):
    _seed_student(db, sid="stu004", group="")
    r = client.post(URL_BULK, json={"student_ids": ["stu004"], "schedule": "Z"})
    assert r.status_code == 422


# ═════════════════════════════════════════════════════════════════════════════
# 5. Unauthorized caller rejected
# ═════════════════════════════════════════════════════════════════════════════

def test_5_unauthorized_caller_rejected(db):
    from fastapi import HTTPException

    async def _deny_admin():
        raise HTTPException(status_code=401, detail="Not authenticated")

    client = TestClient(_make_app(db, require_admin=_deny_admin))
    _seed_student(db, sid="stu004", group="")
    r = client.post(URL_ONE.format(sid="stu004"), json={"schedule": "A"})
    assert r.status_code == 401


# ═════════════════════════════════════════════════════════════════════════════
# 6-7. Idempotent + audited
# ═════════════════════════════════════════════════════════════════════════════

def test_6_repeated_update_is_idempotent(db, client):
    _seed_student(db, sid="stu004", group="")
    r1 = client.post(URL_ONE.format(sid="stu004"), json={"schedule": "A"})
    r2 = client.post(URL_ONE.format(sid="stu004"), json={"schedule": "A"})
    assert r1.json()["outcome"] == "updated"
    assert r2.json()["outcome"] == "unchanged"
    doc = db["students"]._docs[0]
    assert doc["group"] == "A"


def test_7_previous_and_new_values_audited(db, client):
    _seed_student(db, sid="stu004", group="")
    client.post(URL_ONE.format(sid="stu004"), json={"schedule": "A"})
    audits = [d for d in db["speaking_lab_schedule_assignments"]._docs
              if d["student_id"] == "stu004"]
    assert len(audits) == 1
    a = audits[0]
    assert a["previous_schedule"] == ""
    assert a["new_schedule"] == "A"
    assert a["authenticated_teacher"] == "teacher@school.example"
    assert a["changed_at"]

    # A second, real change (A -> B, with confirm) must also be audited.
    r = client.post(URL_ONE.format(sid="stu004"),
                     json={"schedule": "B", "confirm": True})
    assert r.json()["outcome"] == "updated"
    audits = [d for d in db["speaking_lab_schedule_assignments"]._docs
              if d["student_id"] == "stu004"]
    assert len(audits) == 2
    assert audits[1]["previous_schedule"] == "A"
    assert audits[1]["new_schedule"] == "B"


def test_7b_reassign_already_assigned_requires_confirm(db, client):
    _seed_student(db, sid="stu004", group="A")
    r = client.post(URL_ONE.format(sid="stu004"), json={"schedule": "B"})
    assert r.json()["outcome"] == "confirmation_required"
    doc = db["students"]._docs[0]
    assert doc["group"] == "A"  # unchanged

    r2 = client.post(URL_ONE.format(sid="stu004"),
                      json={"schedule": "B", "confirm": True})
    assert r2.json()["outcome"] == "updated"


# ═════════════════════════════════════════════════════════════════════════════
# 10. Missing Code Rescue blocks unassigned students
# ═════════════════════════════════════════════════════════════════════════════

def test_10_rescue_blocks_unassigned_student():
    db = _FakeDB()
    _run(ta.ensure_teacher_admission_indexes(db))
    _run(ta.ensure_missing_code_recovery_indexes(db))
    credits = _FakeCredits()
    client = TestClient(_make_app(db, credits=credits))
    _seed_session_sync(db, sid="s1", fee=4, schedule="A")
    _seed_student(db, sid="stu004", group="")  # unassigned
    credits.add(sender="stu004", amount=4, transfer_id="tid_sched_1")

    r = client.get(URL_CAND.format(sid="s1"))
    cand = r.json()["candidates"][0]
    assert cand["status"] == "manual_review_required"
    assert cand["reason"] == "schedule_assignment_required"
    assert cand["restorable"] is False

    r2 = client.post(URL_RECOVER.format(sid="s1"),
                      json={"student_id": "stu004", "teacher_confirmed": True})
    assert r2.json()["outcome"] == "manual_review_required"
    assert r2.json()["reason"] == "schedule_assignment_required"
    codes = [d for d in db["speaking_lab_lucky_codes"]._docs]
    assert codes == []


# ═════════════════════════════════════════════════════════════════════════════
# 11. Assign-to-current-schedule then refresh reclassifies the row
# ═════════════════════════════════════════════════════════════════════════════

def test_11_assign_to_current_schedule_then_refresh_makes_it_restorable():
    db = _FakeDB()
    _run(ta.ensure_teacher_admission_indexes(db))
    _run(ta.ensure_missing_code_recovery_indexes(db))
    _run(ta.ensure_schedule_assignment_indexes(db))
    credits = _FakeCredits()
    client = TestClient(_make_app(db, credits=credits))
    _seed_session_sync(db, sid="s1", fee=4, schedule="A")
    _seed_student(db, sid="stu004", group="")
    credits.add(sender="stu004", amount=4, transfer_id="tid_sched_2")

    before = client.get(URL_CAND.format(sid="s1")).json()["candidates"][0]
    assert before["reason"] == "schedule_assignment_required"

    assign = client.post(URL_ONE.format(sid="stu004"), json={"schedule": "A"})
    assert assign.json()["outcome"] == "updated"

    after = client.get(URL_CAND.format(sid="s1")).json()["candidates"][0]
    assert after["status"] == "review_required"
    assert after["restorable"] is True

    restore = client.post(URL_RECOVER.format(sid="s1"),
                           json={"student_id": "stu004", "teacher_confirmed": True})
    assert restore.json()["outcome"] == "restored"


# ═════════════════════════════════════════════════════════════════════════════
# 12. Opposite-schedule candidate is never silently restored
# ═════════════════════════════════════════════════════════════════════════════

def test_12_opposite_schedule_student_not_silently_restored():
    db = _FakeDB()
    _run(ta.ensure_teacher_admission_indexes(db))
    _run(ta.ensure_missing_code_recovery_indexes(db))
    credits = _FakeCredits()
    client = TestClient(_make_app(db, credits=credits))
    _seed_session_sync(db, sid="s1", fee=4, schedule="A")
    _seed_student(db, sid="stu004", group="B")
    credits.add(sender="stu004", amount=4, transfer_id="tid_sched_3")

    cand = client.get(URL_CAND.format(sid="s1")).json()["candidates"][0]
    assert cand["status"] == "manual_review_required"
    assert cand["reason"] == "wrong_schedule"
    assert cand["student_schedule"] == "B"
    assert cand["restorable"] is False

    r = client.post(URL_RECOVER.format(sid="s1"),
                     json={"student_id": "stu004", "teacher_confirmed": True})
    assert r.json()["outcome"] == "manual_review_required"
    assert r.json()["reason"] == "wrong_schedule"
    codes = [d for d in db["speaking_lab_lucky_codes"]._docs]
    assert codes == []


# ═════════════════════════════════════════════════════════════════════════════
# 13. Existing entry/code in another schedule blocks the move
# ═════════════════════════════════════════════════════════════════════════════

def test_13_active_entry_elsewhere_blocks_schedule_move(db, client):
    _seed_session_sync(db, sid="sB", fee=4, schedule="B")
    _seed_student(db, sid="stu004", group="B")
    _run(db["speaking_lab_entries"].insert_one({
        "session_id": "sB", "student_id": "stu004",
        "display_name": "Channrachna Oum", "display_name_key": "channrachna oum",
        "position": 1, "entered_at": "2026-01-01T00:00:00+00:00",
    }))
    r = client.post(URL_ONE.format(sid="stu004"),
                     json={"schedule": "A", "confirm": True})
    assert r.json()["outcome"] == "blocked_active_elsewhere"
    doc = db["students"]._docs[0]
    assert doc["group"] == "B"  # unchanged
