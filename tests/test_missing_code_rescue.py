"""
Missing Code Rescue — human-reviewed recovery for "paid but no code" (v1.0)
============================================================================

These tests exercise the new endpoints added to ``teacher_admission.py``:

  * GET  /speaking-lab/sessions/{id}/missing-code-candidates
  * POST /speaking-lab/sessions/{id}/recover-missing-code
  * POST /speaking-lab/sessions/{id}/recover-missing-codes/bulk

Design constraint under test: ``push_credit_log`` (surfaced here via the
injected ``find_recent_treasury_credits`` callable) is a CLIENT-SUBMITTED
signal, NOT authoritative payment proof. Nothing in this module may claim
"verified payment" — every restore requires an explicit per-student teacher
confirmation, and the response vocabulary must never use the word
"verified" for a candidate's payment status.

Run from the backend folder:

    cd backend
    pytest -q tests/test_missing_code_rescue.py
"""

from __future__ import annotations

import asyncio
import pathlib
import sys

import pytest
from fastapi import APIRouter, FastAPI
from fastapi.testclient import TestClient
from httpx import AsyncClient, ASGITransport

BACKEND_DIR = pathlib.Path(__file__).resolve().parent.parent
TESTS_DIR = pathlib.Path(__file__).resolve().parent
for _p in (BACKEND_DIR, TESTS_DIR):
    if str(_p) not in sys.path:
        sys.path.insert(0, str(_p))

import teacher_admission as ta  # noqa: E402

# Reuse the exact fake-DB / fake-code-generator machinery from the existing
# teacher-admit test suite so both test modules stay behaviourally identical.
from test_teacher_admit import (  # noqa: E402
    _FakeDB, _norm_student_id, _fake_generate_and_publish, _sl_publish_fake,
    _run, _seed_session_sync, _seed_student_sync, _seed_indexes_sync,
    PUBLISHED,
)


# ──────────────────────────────────────────────────────────────────────────────
# Fake push_credit_log signal source
# ──────────────────────────────────────────────────────────────────────────────
class _FakeCredits:
    def __init__(self):
        self.rows: list[dict] = []

    def add(self, *, sender, recipient="stu092", amount=10,
            transfer_id="tid1", created_at="2026-01-01T00:00:00+00:00"):
        self.rows.append({
            "senderStudentId": sender, "recipientStudentId": recipient,
            "amount": amount, "transferId": transfer_id,
            "createdAt": created_at,
        })
        return self

    async def find_recent(self, *, treasury_id, since):
        treasury_norm = _norm_student_id(treasury_id or "stu092")
        matched = [
            r for r in self.rows
            if _norm_student_id(r.get("recipientStudentId") or "") == treasury_norm
        ]
        # Mirror Mongo's `.sort("createdAt", -1)`: most-recently-added first.
        return list(reversed(matched))


URL_CAND = "/api/speaking-lab/sessions/{sid}/missing-code-candidates"
URL_ONE = "/api/speaking-lab/sessions/{sid}/recover-missing-code"
URL_BULK = "/api/speaking-lab/sessions/{sid}/recover-missing-codes/bulk"


def _make_app(db, credits=None, set_index_ok=True, set_recovery_index_ok=True):
    api = APIRouter(prefix="/api")
    PUBLISHED.clear()

    class _Admin:
        email = "teacher@school.example"
        user_id = "teacher_001"

    async def _require_admin():
        return _Admin()

    find_credits = credits.find_recent if credits is not None else None

    ta.register_teacher_admission_routes(
        api=api,
        db=db,
        SL_SESSIONS=db["speaking_lab_sessions"],
        SL_ENTRIES=db["speaking_lab_entries"],
        sl_publish=_sl_publish_fake,
        require_admin_dep=_require_admin,
        norm_student_id=_norm_student_id,
        generate_and_publish_lucky_code=_fake_generate_and_publish,
        find_recent_treasury_credits=find_credits,
    )
    app = FastAPI()
    app.include_router(api)
    ta._force_index_health(set_index_ok)
    ta._force_recovery_index_health(set_recovery_index_ok)
    return app


@pytest.fixture
def db():
    d = _FakeDB()
    _seed_indexes_sync(d)
    _run(ta.ensure_missing_code_recovery_indexes(d))
    return d


@pytest.fixture
def credits():
    return _FakeCredits()


@pytest.fixture
def app(db, credits):
    return _make_app(db, credits)


@pytest.fixture
def client(app):
    return TestClient(app)


# ═════════════════════════════════════════════════════════════════════════════
# 1. Candidate listing
# ═════════════════════════════════════════════════════════════════════════════

def test_1_paid_student_no_entry_no_code_is_candidate(db, client, credits):
    _seed_session_sync(db, sid="s1", fee=4, schedule="")
    _seed_student_sync(db, sid="stu004", name="Channrachna Oum", group="")
    credits.add(sender="stu004", amount=4, transfer_id="tid_a")
    r = client.get(URL_CAND.format(sid="s1"))
    assert r.status_code == 200
    body = r.json()
    assert body["restorable_count"] == 1
    cand = body["candidates"][0]
    assert cand["student_id"] == "stu004"
    assert cand["status"] == "review_required"
    assert cand["restorable"] is True
    assert cand["current_status"] == "no_entry_no_code"
    # Never claim verification.
    assert "verified" not in cand["status"].lower()


def test_2_student_without_signal_excluded(db, client, credits):
    _seed_session_sync(db, sid="s1", fee=4, schedule="")
    _seed_student_sync(db, sid="stu004", name="Channrachna Oum", group="")
    # No push_credit_log rows added at all.
    r = client.get(URL_CAND.format(sid="s1"))
    assert r.status_code == 200
    assert r.json()["candidates"] == []


def test_3_wrong_amount_not_restorable(db, client, credits):
    _seed_session_sync(db, sid="s1", fee=4, schedule="")
    _seed_student_sync(db, sid="stu004", group="")
    credits.add(sender="stu004", amount=7, transfer_id="tid_b")
    r = client.get(URL_CAND.format(sid="s1"))
    cand = r.json()["candidates"][0]
    assert cand["status"] == "manual_review_required"
    assert cand["reason"] == "amount_mismatch"
    assert cand["restorable"] is False


def test_4_wrong_treasury_excluded(db, client, credits):
    _seed_session_sync(db, sid="s1", fee=4, schedule="")
    _seed_student_sync(db, sid="stu004", group="")
    credits.add(sender="stu004", amount=4, recipient="stu999", transfer_id="tid_c")
    r = client.get(URL_CAND.format(sid="s1"))
    assert r.json()["candidates"] == []


def test_5_missing_reference_not_restorable(db, client, credits):
    _seed_session_sync(db, sid="s1", fee=4, schedule="")
    _seed_student_sync(db, sid="stu004", group="")
    credits.add(sender="stu004", amount=4, transfer_id="")
    r = client.get(URL_CAND.format(sid="s1"))
    cand = r.json()["candidates"][0]
    assert cand["status"] == "manual_review_required"
    assert cand["reason"] == "missing_transfer_reference"


def test_6_already_has_code_excluded_from_restorable(db, client, credits):
    _seed_session_sync(db, sid="s1", fee=4, schedule="")
    _seed_student_sync(db, sid="stu004", group="")
    _run(db["speaking_lab_entries"].insert_one({
        "session_id": "s1", "student_id": "stu004",
        "display_name": "X", "display_name_key": "x",
        "position": 1, "entered_at": "2026-01-01T00:00:00+00:00",
    }))
    _run(db["speaking_lab_lucky_codes"].insert_one({
        "session_id": "s1", "student_id": "stu004", "code": "WORD-0001",
        "entry_fee": 4, "awarded_at": "2026-01-01T00:00:00+00:00",
    }))
    credits.add(sender="stu004", amount=4, transfer_id="tid_d")
    r = client.get(URL_CAND.format(sid="s1"))
    cand = r.json()["candidates"][0]
    assert cand["status"] == "already_has_code"
    assert cand["current_status"] == "has_entry_and_code"
    assert cand["restorable"] is False


def test_7_partial_state_entry_only_is_restorable(db, client, credits):
    """A student with a pool entry but no code (partial repair case) must
    still surface as restorable — Missing Code Rescue repairs the code
    only, without duplicating the entry."""
    _seed_session_sync(db, sid="s1", fee=4, schedule="")
    _seed_student_sync(db, sid="stu004", group="")
    _run(db["speaking_lab_entries"].insert_one({
        "session_id": "s1", "student_id": "stu004",
        "display_name": "X", "display_name_key": "x",
        "position": 1, "entered_at": "2026-01-01T00:00:00+00:00",
    }))
    credits.add(sender="stu004", amount=4, transfer_id="tid_e")
    r = client.get(URL_CAND.format(sid="s1"))
    cand = r.json()["candidates"][0]
    assert cand["current_status"] == "has_entry_no_code"
    assert cand["status"] == "review_required"
    assert cand["restorable"] is True


def test_8_candidates_unavailable_when_signal_source_not_configured(db):
    app = _make_app(db, credits=None)
    client = TestClient(app)
    _seed_session_sync(db, sid="s1", fee=4, schedule="")
    r = client.get(URL_CAND.format(sid="s1"))
    assert r.status_code == 503
    assert "verified" not in str(r.json()).lower()


def test_9_recovery_index_unhealthy_fails_closed(db, credits):
    app = _make_app(db, credits, set_recovery_index_ok=False)
    client = TestClient(app)
    _seed_session_sync(db, sid="s1", fee=4, schedule="")
    _seed_student_sync(db, sid="stu004", group="")
    credits.add(sender="stu004", amount=4, transfer_id="tid_f")
    r = client.post(URL_ONE.format(sid="s1"),
                     json={"student_id": "stu004", "teacher_confirmed": True})
    assert r.status_code == 503


# ═════════════════════════════════════════════════════════════════════════════
# 2. Single recovery — requires explicit confirmation, creates exactly once
# ═════════════════════════════════════════════════════════════════════════════

def test_10_teacher_confirmation_required(db, client, credits):
    _seed_session_sync(db, sid="s1", fee=4, schedule="")
    _seed_student_sync(db, sid="stu004", group="")
    credits.add(sender="stu004", amount=4, transfer_id="tid_g")
    r = client.post(URL_ONE.format(sid="s1"),
                     json={"student_id": "stu004", "teacher_confirmed": False})
    assert r.status_code == 422


def test_11_locked_session_rejected(db, client, credits):
    _seed_session_sync(db, sid="s1", fee=4, schedule="", lucky_draw_done=True)
    _seed_student_sync(db, sid="stu004", group="")
    credits.add(sender="stu004", amount=4, transfer_id="tid_h")
    r = client.post(URL_ONE.format(sid="s1"),
                     json={"student_id": "stu004", "teacher_confirmed": True})
    assert r.status_code == 409


def test_12_restore_creates_exactly_one_entry_and_code(db, client, credits):
    _seed_session_sync(db, sid="s1", fee=4, schedule="")
    _seed_student_sync(db, sid="stu004", name="Channrachna Oum", group="")
    credits.add(sender="stu004", amount=4, transfer_id="tid_i")
    r = client.post(URL_ONE.format(sid="s1"),
                     json={"student_id": "stu004", "teacher_confirmed": True})
    assert r.status_code == 200
    body = r.json()
    assert body["outcome"] == "restored"
    assert body["lucky_code"]

    entries = [d for d in db["speaking_lab_entries"]._docs
               if d["session_id"] == "s1" and d["student_id"] == "stu004"]
    codes = [d for d in db["speaking_lab_lucky_codes"]._docs
             if d["session_id"] == "s1" and d["student_id"] == "stu004"]
    assert len(entries) == 1
    assert len(codes) == 1

    recoveries = [d for d in db["speaking_lab_missing_code_recoveries"]._docs
                  if d["session_id"] == "s1" and d["student_id"] == "stu004"]
    assert len(recoveries) == 1
    audit = recoveries[0]
    assert audit["status"] == "restored"
    assert audit["authenticated_teacher"] == "teacher@school.example"
    assert audit["teacher_confirmed"] is True
    assert audit["normalized_source_reference"] == "tid_i"
    assert audit["source_record"] == "push_credit_log"
    assert audit["completed_at"]


def test_13_repeated_restore_is_idempotent(db, client, credits):
    _seed_session_sync(db, sid="s1", fee=4, schedule="")
    _seed_student_sync(db, sid="stu004", group="")
    credits.add(sender="stu004", amount=4, transfer_id="tid_j")
    r1 = client.post(URL_ONE.format(sid="s1"),
                      json={"student_id": "stu004", "teacher_confirmed": True})
    r2 = client.post(URL_ONE.format(sid="s1"),
                      json={"student_id": "stu004", "teacher_confirmed": True})
    assert r1.json()["lucky_code"] == r2.json()["lucky_code"]
    # Once entry+code exist, the classifier reports the (correct, more
    # primary) "already_has_code" state rather than re-deriving it from the
    # recovery audit row — either way the repeat call is a no-op replay.
    assert r2.json()["outcome"] == "skipped"
    assert r2.json()["reason"] == "already_has_code"
    codes = [d for d in db["speaking_lab_lucky_codes"]._docs
             if d["session_id"] == "s1" and d["student_id"] == "stu004"]
    assert len(codes) == 1


def test_14_already_has_code_is_skipped_not_error(db, client, credits):
    _seed_session_sync(db, sid="s1", fee=4, schedule="")
    _seed_student_sync(db, sid="stu004", group="")
    _run(db["speaking_lab_entries"].insert_one({
        "session_id": "s1", "student_id": "stu004",
        "display_name": "X", "display_name_key": "x",
        "position": 1, "entered_at": "2026-01-01T00:00:00+00:00",
    }))
    _run(db["speaking_lab_lucky_codes"].insert_one({
        "session_id": "s1", "student_id": "stu004", "code": "WORD-9999",
        "entry_fee": 4, "awarded_at": "2026-01-01T00:00:00+00:00",
    }))
    credits.add(sender="stu004", amount=4, transfer_id="tid_k")
    r = client.post(URL_ONE.format(sid="s1"),
                     json={"student_id": "stu004", "teacher_confirmed": True})
    assert r.json()["outcome"] == "skipped"
    assert r.json()["reason"] == "already_has_code"


def test_15_amount_mismatch_returns_manual_review_not_restore(db, client, credits):
    _seed_session_sync(db, sid="s1", fee=4, schedule="")
    _seed_student_sync(db, sid="stu004", group="")
    credits.add(sender="stu004", amount=99, transfer_id="tid_l")
    r = client.post(URL_ONE.format(sid="s1"),
                     json={"student_id": "stu004", "teacher_confirmed": True})
    assert r.json()["outcome"] == "manual_review_required"
    assert r.json()["reason"] == "amount_mismatch"
    codes = [d for d in db["speaking_lab_lucky_codes"]._docs if d["student_id"] == "stu004"]
    assert codes == []


def test_16_reference_already_consumed_by_another_recovery_rejected(db, client, credits):
    _seed_session_sync(db, sid="s1", fee=4, schedule="")
    _seed_session_sync(db, sid="s2", fee=4, schedule="")
    _seed_student_sync(db, sid="stu004", group="")
    credits.add(sender="stu004", amount=4, transfer_id="tid_m")
    r1 = client.post(URL_ONE.format(sid="s1"),
                      json={"student_id": "stu004", "teacher_confirmed": True})
    assert r1.json()["outcome"] == "restored"
    # Same real-world transfer reference cannot fund a second session.
    r2 = client.post(URL_ONE.format(sid="s2"),
                      json={"student_id": "stu004", "teacher_confirmed": True})
    assert r2.json()["outcome"] == "manual_review_required"
    assert r2.json()["reason"] == "reference_already_consumed"


def test_17_reference_already_consumed_by_legacy_teacher_admit(db, client, credits):
    """A reference the OLD teacher-admit flow already used for THIS
    session/student must not be double-spent by the new recovery path."""
    _seed_session_sync(db, sid="s1", fee=4, schedule="")
    _seed_student_sync(db, sid="stu004", name="Alice", group="")
    _run(db["speaking_lab_teacher_admissions"].insert_one({
        "admission_id": "adm1", "session_id": "s1", "student_id": "stu004",
        "normalized_transfer_reference": "tid_n",
        "status_after": "admitted", "generated_code": "WORD-1111",
    }))
    credits.add(sender="stu004", amount=4, transfer_id="tid_n")
    r = client.get(URL_CAND.format(sid="s1"))
    cand = r.json()["candidates"][0]
    assert cand["status"] == "manual_review_required"
    assert cand["reason"] == "reference_already_consumed"


def test_18_no_wallet_or_students_collection_mutated(db, client, credits):
    _seed_session_sync(db, sid="s1", fee=4, schedule="")
    _seed_student_sync(db, sid="stu004", name="Alice", group="")
    before = [dict(d) for d in db["students"]._docs]
    credits.add(sender="stu004", amount=4, transfer_id="tid_o")
    client.post(URL_ONE.format(sid="s1"),
                json={"student_id": "stu004", "teacher_confirmed": True})
    after = [dict(d) for d in db["students"]._docs]
    assert before == after


# ═════════════════════════════════════════════════════════════════════════════
# 3. Bulk recovery
# ═════════════════════════════════════════════════════════════════════════════

def test_19_bulk_restores_valid_and_skips_invalid_independently(db, client, credits):
    _seed_session_sync(db, sid="s1", fee=4, schedule="")
    _seed_student_sync(db, sid="stu001", group="")
    _seed_student_sync(db, sid="stu002", group="")
    credits.add(sender="stu001", amount=4, transfer_id="tid_p1")
    credits.add(sender="stu002", amount=99, transfer_id="tid_p2")  # bad amount
    r = client.post(
        URL_BULK.format(sid="s1"),
        json={"student_ids": ["stu001", "stu002"], "teacher_confirmed": True},
    )
    body = r.json()
    assert body["restored_count"] == 1
    assert body["skipped_count"] == 1
    outcomes = {res["student_id"]: res["outcome"] for res in body["results"]}
    assert outcomes["stu001"] == "restored"
    assert outcomes["stu002"] == "manual_review_required"


def test_20_bulk_requires_confirmation(db, client, credits):
    _seed_session_sync(db, sid="s1", fee=4, schedule="")
    _seed_student_sync(db, sid="stu001", group="")
    credits.add(sender="stu001", amount=4, transfer_id="tid_q")
    r = client.post(
        URL_BULK.format(sid="s1"),
        json={"student_ids": ["stu001"], "teacher_confirmed": False},
    )
    assert r.status_code == 422


# ═════════════════════════════════════════════════════════════════════════════
# 4. Concurrency
# ═════════════════════════════════════════════════════════════════════════════

@pytest.mark.asyncio
async def test_21_concurrent_identical_restores_create_exactly_one(db, credits):
    _seed_session_sync(db, sid="s1", fee=4, schedule="")
    _seed_student_sync(db, sid="stu004", group="")
    credits.add(sender="stu004", amount=4, transfer_id="tid_r")
    app = _make_app(db, credits)
    transport = ASGITransport(app=app)
    async with AsyncClient(transport=transport, base_url="http://t") as ac:
        results = await asyncio.gather(*[
            ac.post(URL_ONE.format(sid="s1"),
                    json={"student_id": "stu004", "teacher_confirmed": True})
            for _ in range(5)
        ])
    codes = {r.json()["lucky_code"] for r in results if r.status_code == 200}
    assert len(codes) == 1
    entries = [d for d in db["speaking_lab_entries"]._docs
               if d["session_id"] == "s1" and d["student_id"] == "stu004"]
    lucky = [d for d in db["speaking_lab_lucky_codes"]._docs
             if d["session_id"] == "s1" and d["student_id"] == "stu004"]
    assert len(entries) == 1
    assert len(lucky) == 1


# ═════════════════════════════════════════════════════════════════════════════
# 5. Wording guard — never claim "verified payment"
# ═════════════════════════════════════════════════════════════════════════════

def test_22_no_status_ever_claims_verification(db, client, credits):
    _seed_session_sync(db, sid="s1", fee=4, schedule="")
    _seed_student_sync(db, sid="stu004", group="")
    credits.add(sender="stu004", amount=4, transfer_id="tid_s")
    cand_body = client.get(URL_CAND.format(sid="s1")).json()
    restore_body = client.post(
        URL_ONE.format(sid="s1"),
        json={"student_id": "stu004", "teacher_confirmed": True},
    ).json()
    blob = str(cand_body) + str(restore_body)
    assert "verified" not in blob.lower()
