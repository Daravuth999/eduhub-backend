"""tests/test_attendance_rewards.py
=====================================
Smart Attendance — session-close behaviour: final status resolution, the
idempotent tier-multiplied wallet payout (running the same trigger twice must
not double-pay), absent miss-follow-up, and the predictive-nudge guardrails.

Reuses the in-memory fakes from test_attendance_checkin.py. The wallet is a
stub that mirrors wallet_service's idempotency-key contract; no real Mongo.
"""
from __future__ import annotations

from datetime import datetime, timedelta, timezone

import attendance_tools as att

try:  # pytest from repo root
    from tests.test_attendance_checkin import (
        _DB, _Router, _Admin, _Student, _call, _seed_class, _seed_open_session,
    )
except ImportError:  # pytest from tests/ dir
    from test_attendance_checkin import (  # type: ignore
        _DB, _Router, _Admin, _Student, _call, _seed_class, _seed_open_session,
    )


# ── stub wallet honouring the idempotency_key contract ───────────────────────
class _Wallet:
    def __init__(self):
        self.seen = {}     # idempotency_key -> amount
        self.calls = 0
        self.total = 0

    async def credit(self, student_id, amount, *, source, source_ref=None,
                     idempotency_key=None, clean_id=None, **kw):
        self.calls += 1
        if idempotency_key in self.seen:
            return {"ok": True, "duplicate": True}
        self.seen[idempotency_key] = amount
        self.total += amount
        return {"ok": True, "duplicate": False}


def _build_with_wallet():
    db = _DB()
    router = _Router()
    pushes = []
    wallet = _Wallet()

    async def fan_out(query, title, body, url):
        pushes.append({"query": query, "title": title, "body": body})
        return (len((query.get("studentId") or {}).get("$in", [])), 0)

    def build_q(target, ids, group):
        return {"target": target, "studentId": {"$in": list(ids or [])}}

    att.register_attendance_routes(
        router, db, require_admin=_Admin(), require_student=object(),
        current_student=None, fan_out_push=fan_out, build_target_query=build_q,
        norm_student_id=lambda v: str(v or "").strip().lower(), wallet=wallet,
    )
    return db, router, pushes, wallet


# ── finalize_status pure logic ───────────────────────────────────────────────
def test_finalize_absent_when_no_checkin():
    assert att.finalize_status(False, None, False, True) == att.ST_ABSENT


def test_finalize_partial_when_mid_session_missed():
    assert att.finalize_status(True, att.ST_PRESENT_FULL, False, True) == att.ST_PRESENT_PARTIAL


def test_finalize_full_when_mid_session_confirmed():
    assert att.finalize_status(True, att.ST_PRESENT_FULL, True, True) == att.ST_PRESENT_FULL


def test_finalize_full_when_mid_session_not_required():
    assert att.finalize_status(True, att.ST_PRESENT_FULL, False, False) == att.ST_PRESENT_FULL


def test_finalize_late_stays_late_regardless_of_mid_session():
    assert att.finalize_status(True, att.ST_LATE, False, True) == att.ST_LATE
    assert att.finalize_status(True, att.ST_LATE, True, True) == att.ST_LATE


# ── close session: reward idempotency ────────────────────────────────────────
def test_close_session_credits_once_and_is_idempotent():
    db, router, pushes, wallet = _build_with_wallet()
    _seed_class(db, roster=("stu_alice",))
    _seed_open_session(db)
    # Alice checks in and confirms mid-session ⇒ present_full
    _call(router, "POST", "/attendance/checkin",
          payload=att.CheckInIn(slug="abc123"), student=_Student("stu_alice"))
    _call(router, "POST", "/attendance/mid-session-confirm",
          payload=att.MidSessionIn(session_id="ses_1"), student=_Student("stu_alice"))

    r1 = _call(router, "POST", "/admin/attendance/sessions/{session_id}/close",
               session_id="ses_1", admin=_Admin())
    assert r1["present_count"] == 1
    assert r1["absent_count"] == 0
    # diamond multiplier (perfect record) × base 1 (P0 rebuild default) = 2
    first_total = wallet.total
    assert first_total == 2

    # Running the SAME trigger again must not double-pay.
    _call(router, "POST", "/admin/attendance/sessions/{session_id}/close",
          session_id="ses_1", admin=_Admin())
    assert wallet.total == first_total           # no double credit
    assert len(wallet.seen) == 1                 # single idempotency key


def test_close_marks_absent_and_fires_miss_followup():
    db, router, pushes, wallet = _build_with_wallet()
    _seed_class(db, roster=("stu_alice", "stu_bob"))
    _seed_open_session(db)
    # only Alice checks in
    _call(router, "POST", "/attendance/checkin",
          payload=att.CheckInIn(slug="abc123"), student=_Student("stu_alice"))

    res = _call(router, "POST", "/admin/attendance/sessions/{session_id}/close",
                session_id="ses_1", admin=_Admin())
    assert res["present_count"] == 1
    assert res["absent_count"] == 1
    assert res["miss_followup_sent"] >= 1
    # Bob's record is finalized as absent
    assert db[att.COLL_RECORDS].docs["ses_1:stu_bob"]["status"] == att.ST_ABSENT
    # a miss-followup push was fired
    assert any("students" == p["query"]["target"] for p in pushes)


# ── §1 REGRESSION: wallet credit must use student_id (UUID), not clean_id ────
# This is the test the original e2e suite lacked: it deliberately gives each
# student a clean_id that DIFFERS from its student_id. The buggy code credited
# the wallet under clean_id; every other reward feature + GET
# /student/points/history key on student_id, so those points would vanish.
class _RecordingWallet:
    """Wallet stub that records the EXACT identity each credit was filed under,
    plus the clean_id metadata, honouring the idempotency contract."""

    def __init__(self):
        self.seen = {}                       # idempotency_key -> amount
        self.credits = []                    # list of (student_id, clean_id, amount, idem)

    async def credit(self, student_id, amount, *, source, source_ref=None,
                     idempotency_key=None, clean_id=None, **kw):
        if idempotency_key in self.seen:
            return {"ok": True, "duplicate": True}
        self.seen[idempotency_key] = amount
        self.credits.append((student_id, clean_id, amount, idempotency_key))
        return {"ok": True, "duplicate": False}


def _build_with_recording_wallet():
    db = _DB()
    router = _Router()
    wallet = _RecordingWallet()

    async def fan_out(query, title, body, url):
        return (0, 0)

    def build_q(target, ids, group):
        return {"target": target, "studentId": {"$in": list(ids or [])}}

    att.register_attendance_routes(
        router, db, require_admin=_Admin(), require_student=object(),
        current_student=None, fan_out_push=fan_out, build_target_query=build_q,
        norm_student_id=lambda v: str(v or "").strip().lower(), wallet=wallet,
    )
    return db, router, wallet


def _seed_student_distinct(db, *, clean_id, student_id):
    """Seed a student whose clean_id and student_id are DIFFERENT strings."""
    db.students.docs[clean_id] = {
        "_id": clean_id, "student_id": student_id, "clean_id": clean_id,
        "display_name": clean_id.upper(),
    }


def test_close_credits_wallet_by_student_id_not_clean_id():
    db, router, wallet = _build_with_recording_wallet()
    # Two enrolled students, each with clean_id != student_id (the case the
    # original "stu_alice for both" fixture could never expose).
    _seed_student_distinct(db, clean_id="alice01", student_id="stu_aaa111aaa111")
    _seed_student_distinct(db, clean_id="bob02", student_id="stu_bbb222bbb222")
    db[att.COLL_CLASSES].docs["cls_x"] = {
        "_id": "cls_x", "class_id": "cls_x", "title_en": "English A1",
        "title_kh": "", "roster": ["alice01", "bob02"], "group": "",
    }
    _seed_open_session(db)

    # Both check in on time (records key on clean_id — unchanged bookkeeping).
    for cid in ("alice01", "bob02"):
        _call(router, "POST", "/attendance/checkin",
              payload=att.CheckInIn(slug="abc123"), student=_Student(cid))

    res = _call(router, "POST", "/admin/attendance/sessions/{session_id}/close",
                session_id="ses_1", admin=_Admin())
    assert res["present_count"] == 2
    assert res["rewards_credited"] == 2

    credited_primary = {c[0] for c in wallet.credits}
    credited_clean = {c[1] for c in wallet.credits}
    # The PRIMARY wallet identity must be the UUID-style student_id …
    assert credited_primary == {"stu_aaa111aaa111", "stu_bbb222bbb222"}
    # … and clean_id must be carried only as metadata.
    assert credited_clean == {"alice01", "bob02"}
    # The clean_id must NEVER be the primary wallet identity (the actual bug).
    assert "alice01" not in credited_primary
    assert "bob02" not in credited_primary
    # Idempotency keys are derived from the real student_id, not clean_id.
    idem_keys = {c[3] for c in wallet.credits}
    assert idem_keys == {
        "attendance:ses_1:stu_aaa111aaa111",
        "attendance:ses_1:stu_bbb222bbb222",
    }


def test_close_credit_internal_bookkeeping_still_uses_clean_id():
    # Records + streaks must keep keying on clean_id even after the §1 fix —
    # only the wallet call site changed.
    db, router, wallet = _build_with_recording_wallet()
    _seed_student_distinct(db, clean_id="carol03", student_id="stu_ccc333ccc333")
    db[att.COLL_CLASSES].docs["cls_x"] = {
        "_id": "cls_x", "class_id": "cls_x", "title_en": "English A1",
        "title_kh": "", "roster": ["carol03"], "group": "",
    }
    _seed_open_session(db)
    _call(router, "POST", "/attendance/checkin",
          payload=att.CheckInIn(slug="abc123"), student=_Student("carol03"))
    _call(router, "POST", "/admin/attendance/sessions/{session_id}/close",
          session_id="ses_1", admin=_Admin())
    # record + streak keyed on clean_id
    assert "ses_1:carol03" in db[att.COLL_RECORDS].docs
    assert any(d.get("student_id") == "carol03"
               for d in db[att.COLL_STREAKS].docs.values())
    # wallet credited under the real student_id
    assert wallet.credits[0][0] == "stu_ccc333ccc333"



# ── predictive at-risk nudge guardrails ──────────────────────────────────────
def _now():
    return datetime.now(timezone.utc)


def test_guardrail_allows_when_clear():
    assert att.nudge_guardrail_allows(_now(), None, False, None) is True


def test_guardrail_blocks_within_7_day_cap():
    recent = _now() - timedelta(days=3)
    assert att.nudge_guardrail_allows(_now(), recent, False, None) is False


def test_guardrail_allows_after_7_days():
    old = _now() - timedelta(days=8)
    assert att.nudge_guardrail_allows(_now(), old, False, None) is True


def test_guardrail_same_day_closing_soon_suppresses():
    assert att.nudge_guardrail_allows(_now(), None, True, None) is False


def test_guardrail_recent_absence_reason_suppresses():
    recent_reason = _now() - timedelta(hours=2)
    assert att.nudge_guardrail_allows(_now(), None, False, recent_reason) is False


def test_guardrail_old_absence_reason_does_not_suppress():
    old_reason = _now() - timedelta(hours=30)
    assert att.nudge_guardrail_allows(_now(), None, False, old_reason) is True


# ── at-risk nudge route honours the guardrails end-to-end ────────────────────
def test_at_risk_route_skips_guarded_students():
    db, router, pushes, wallet = _build_with_wallet()
    # one high-risk student who is eligible, one who was nudged 2 days ago
    db[att.COLL_STREAKS].docs["stu_alice"] = {
        "_id": "stu_alice", "student_id": "stu_alice", "risk_score": 80,
    }
    db[att.COLL_STREAKS].docs["stu_bob"] = {
        "_id": "stu_bob", "student_id": "stu_bob", "risk_score": 90,
        "last_at_risk_nudge_at": (_now() - timedelta(days=2)).isoformat(),
    }
    res = _call(router, "POST", "/admin/attendance/at-risk-nudge", admin=_Admin())
    assert res["candidates"] == 1            # only Alice is eligible
    assert db[att.COLL_STREAKS].docs["stu_alice"].get("last_at_risk_nudge_at")
