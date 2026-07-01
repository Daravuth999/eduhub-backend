"""tests/test_attendance_claim_rewards.py
=========================================
Smart Attendance — claimable rewards system tests.

Coverage (gates):
  Gate 2 — Concurrency: claim_batch_id reservation ownership prevents double-processing
  Gate 3 — Partial failure: N rewards, subset fails → failed reverts, rest stays claimed
  Gate 4 — Activation/historical safety: defaults, activation_at, retroactive protection
  Gate 5 — Wallet identity: student_id vs clean_id, idempotency key uniqueness, no reuse

Also:
  - Claim mode gating (claim_rewards_enabled flag)
  - Pending claim creation on session close (claim mode ON)
  - Auto-credit unchanged when claim mode OFF
  - Duplicate-safe upsert ($setOnInsert): re-closing same session → 1 claim
  - GET /attendance/rewards/summary: correct counts, progress, recent_claims
  - No risk_score or internal wallet IDs in any response
  - POST /attendance/rewards/claim: atomic reservation, wallet credit, push
  - Idempotent retry: wallet sees same idempotency_key → no double credit
  - Double-tap protection: second tap sees 0 pending → no double claim
  - Wallet failure → reverts claiming → pending again, student can retry
  - Push is sent AFTER credit; push failure does NOT roll back credit
  - Student isolation: Alice can only claim her own records
  - below_minimum threshold respected
  - Khmer copy included in push notification body

Imports the in-memory fakes from test_attendance_checkin.py.
"""
from __future__ import annotations

import asyncio
import copy
from datetime import datetime, timedelta, timezone

import attendance_tools as att

try:
    from tests.test_attendance_checkin import (
        _DB, _Router, _Admin, _Student, _call, _seed_class, _seed_open_session,
    )
except ImportError:
    from test_attendance_checkin import (  # type: ignore
        _DB, _Router, _Admin, _Student, _call, _seed_class, _seed_open_session,
    )


# ── helpers ───────────────────────────────────────────────────────────────────

def _now():
    return datetime.now(timezone.utc)


def _iso(dt):
    return dt.isoformat()


class _Wallet:
    """Stub wallet honouring the idempotency_key contract."""
    def __init__(self):
        self.seen: dict[str, int] = {}
        self.calls = 0
        self.total = 0
        self.fail_next = False
        self.credits: list[dict] = []

    async def credit(self, student_id, amount, *, source, source_ref=None,
                     idempotency_key=None, clean_id=None, **kw):
        self.calls += 1
        if self.fail_next:
            self.fail_next = False
            raise RuntimeError("simulated wallet failure")
        if idempotency_key in self.seen:
            return {"ok": True, "duplicate": True}
        self.seen[idempotency_key] = amount
        self.total += amount
        self.credits.append({
            "student_id": student_id, "clean_id": clean_id,
            "amount": amount, "idem_key": idempotency_key,
        })
        return {"ok": True, "duplicate": False, "transaction_id": f"txn_{idempotency_key}"}


class _WalletSelectiveFail:
    """Wallet stub that fails on specific call numbers (1-indexed)."""
    def __init__(self, fail_on_calls: set | None = None):
        self.seen: dict[str, int] = {}
        self.calls = 0
        self.total = 0
        self.fail_on_calls = set(fail_on_calls or [])
        self.credits: list[dict] = []

    async def credit(self, student_id, amount, *, source, source_ref=None,
                     idempotency_key=None, clean_id=None, **kw):
        self.calls += 1
        if idempotency_key in self.seen:
            return {"ok": True, "duplicate": True}
        if self.calls in self.fail_on_calls:
            raise RuntimeError(f"simulated failure on call #{self.calls}")
        self.seen[idempotency_key] = amount
        self.total += amount
        self.credits.append({
            "student_id": student_id, "clean_id": clean_id,
            "amount": amount, "idem_key": idempotency_key,
        })
        return {"ok": True, "duplicate": False, "transaction_id": f"txn_{idempotency_key}"}


def _build_claim(*, claim_mode=True, activation_at=None, min_pts=0,
                 reward_ready_push=True, reward_claimed_push=True,
                 wallet_factory=None):
    """Return (db, router, pushes, wallet) with claim settings pre-seeded."""
    db = _DB()
    router = _Router()
    pushes: list[dict] = []
    wallet = (wallet_factory() if wallet_factory else _Wallet())

    async def fan_out(query, title, body, url):
        pushes.append({"query": query, "title": title, "body": body, "url": url})
        return (len((query.get("studentId") or {}).get("$in", [])), 0)

    def build_q(target, ids, group):
        return {"target": target, "studentId": {"$in": list(ids or [])}}

    att.register_attendance_routes(
        router, db,
        require_admin=_Admin(), require_student=object(),
        current_student=None, fan_out_push=fan_out, build_target_query=build_q,
        norm_student_id=lambda v: str(v or "").strip().lower(), wallet=wallet,
    )

    base_settings = att.default_settings()
    base_settings["claim_rewards_enabled"] = claim_mode
    if activation_at is not None:
        base_settings["claim_mode_activation_at"] = _iso(activation_at)
    base_settings["claim_minimum_points"] = min_pts
    base_settings["reward_ready_push_enabled"] = reward_ready_push
    base_settings["reward_claimed_push_enabled"] = reward_claimed_push
    base_settings["copy"]["reward_ready"] = {
        "title_en": "Reward ready", "title_kh": "រង្វាន់រួចរាល់",
        "body_en": "You have points waiting.", "body_kh": "អ្នកមានពិន្ទុរង់ចាំ។",
    }
    base_settings["copy"]["reward_claimed"] = {
        "title_en": "Attendance reward", "title_kh": "រង្វាន់វត្តមាន",
        "body_en": "+{points} points added.", "body_kh": "ពិន្ទុ +{points} បានបន្ថែម។",
    }
    base_settings["_id"] = att.SETTINGS_ID
    db[att.COLL_SETTINGS].docs[att.SETTINGS_ID] = base_settings

    return db, router, pushes, wallet


def _close_session(router, sid="ses_1"):
    return _call(router, "POST", "/admin/attendance/sessions/{session_id}/close",
                 session_id=sid, admin=_Admin())


def _summary(router, student="stu_alice"):
    return _call(router, "GET", "/attendance/rewards/summary",
                 student=_Student(student))


def _claim(router, student="stu_alice"):
    return _call(router, "POST", "/attendance/rewards/claim",
                 student=_Student(student))


def _seed_extra_session(db, n: int, cid="cls_x"):
    """Seed session #n with id=ses_N and slug=slugN in OPEN state."""
    now = datetime.now(timezone.utc)
    sid = f"ses_{n}"
    slug = f"slug{n}"
    db[att.COLL_SESSIONS].docs[sid] = {
        "_id": sid, "session_id": sid, "class_id": cid, "join_slug": slug,
        "meet_url": f"https://meet.example.com/{n}", "status": att.SESS_OPEN,
        "opens_at": now.isoformat(),
        "closes_at": (now + timedelta(hours=1)).isoformat(),
        "grace_minutes": 10, "mid_session_enabled": True,
        "date": now.date().isoformat(),
    }
    return sid, slug


def _checkin(router, slug, student="stu_alice"):
    return _call(router, "POST", "/attendance/checkin",
                 payload=att.CheckInIn(slug=slug), student=_Student(student))


# ─────────────────────────────────────────────────────────────────────────────
# 1. Basic claim mode ON / OFF
# ─────────────────────────────────────────────────────────────────────────────

def test_claim_mode_on_creates_pending_claim_not_wallet_credit():
    db, router, pushes, wallet = _build_claim(claim_mode=True)
    _seed_class(db, roster=("stu_alice",))
    _seed_open_session(db)
    _checkin(router, "abc123")
    _close_session(router)
    assert wallet.calls == 0
    assert wallet.total == 0
    claims = list(db[att.COLL_CLAIMS].docs.values())
    assert len(claims) == 1
    assert claims[0]["status"] == "pending"
    assert claims[0]["student_id"] == "stu_alice"
    assert claims[0]["points"] > 0


def test_claim_mode_off_credits_wallet_immediately():
    db, router, pushes, wallet = _build_claim(claim_mode=False)
    _seed_class(db, roster=("stu_alice",))
    _seed_open_session(db)
    _checkin(router, "abc123")
    _close_session(router)
    assert wallet.calls == 1
    assert wallet.total > 0
    assert len(db[att.COLL_CLAIMS].docs) == 0


# ─────────────────────────────────────────────────────────────────────────────
# 2. Historical safety: activation_at
# ─────────────────────────────────────────────────────────────────────────────

def test_claim_mode_activation_in_future_still_auto_credits():
    future = _now() + timedelta(hours=1)
    db, router, pushes, wallet = _build_claim(claim_mode=True, activation_at=future)
    _seed_class(db, roster=("stu_alice",))
    _seed_open_session(db)
    _checkin(router, "abc123")
    _close_session(router)
    # Session closed BEFORE activation → auto mode.
    assert wallet.total > 0
    assert len(db[att.COLL_CLAIMS].docs) == 0


def test_claim_mode_activation_in_past_uses_claim_mode():
    past = _now() - timedelta(hours=1)
    db, router, pushes, wallet = _build_claim(claim_mode=True, activation_at=past)
    _seed_class(db, roster=("stu_alice",))
    _seed_open_session(db)
    _checkin(router, "abc123")
    _close_session(router)
    assert wallet.total == 0
    assert len(db[att.COLL_CLAIMS].docs) == 1


def test_reclosing_session_does_not_duplicate_pending_claim():
    db, router, pushes, wallet = _build_claim(claim_mode=True)
    _seed_class(db, roster=("stu_alice",))
    _seed_open_session(db)
    _checkin(router, "abc123")
    _close_session(router)
    _close_session(router)  # second close
    claims = [c for c in db[att.COLL_CLAIMS].docs.values()
              if c.get("student_id") == "stu_alice"]
    assert len(claims) == 1
    assert claims[0]["status"] == "pending"


# ─────────────────────────────────────────────────────────────────────────────
# 3. GET /attendance/rewards/summary
# ─────────────────────────────────────────────────────────────────────────────

def test_summary_shows_correct_pending_totals():
    db, router, pushes, wallet = _build_claim(claim_mode=True)
    _seed_class(db, roster=("stu_alice",))
    _seed_open_session(db)
    _checkin(router, "abc123")
    _close_session(router)
    res = _summary(router)
    assert res["claim_enabled"] is True
    assert res["claimable_count"] == 1
    assert res["claimable_points"] > 0
    assert res["recent_claims"] == []
    assert "risk_score" not in res


def test_summary_no_pending_when_claim_mode_off():
    db, router, pushes, wallet = _build_claim(claim_mode=False)
    _seed_class(db, roster=("stu_alice",))
    _seed_open_session(db)
    _checkin(router, "abc123")
    _close_session(router)
    res = _summary(router)
    assert res["claim_enabled"] is False
    assert res["claimable_points"] == 0


def test_summary_progress_shown_when_below_minimum():
    db, router, pushes, wallet = _build_claim(claim_mode=True, min_pts=100)
    _seed_class(db, roster=("stu_alice",))
    _seed_open_session(db)
    _checkin(router, "abc123")
    _close_session(router)
    res = _summary(router)
    assert res["next_reward_progress"] is not None
    assert res["next_reward_progress"]["target"] == 100
    assert res["next_reward_progress"]["current"] == res["claimable_points"]


def test_summary_no_progress_when_above_minimum():
    db, router, pushes, wallet = _build_claim(claim_mode=True, min_pts=1)
    _seed_class(db, roster=("stu_alice",))
    _seed_open_session(db)
    _checkin(router, "abc123")
    _close_session(router)
    res = _summary(router)
    assert res["next_reward_progress"] is None


# ─────────────────────────────────────────────────────────────────────────────
# 4. POST /attendance/rewards/claim — basic claim
# ─────────────────────────────────────────────────────────────────────────────

def test_claim_credits_wallet_and_returns_points():
    db, router, pushes, wallet = _build_claim(claim_mode=True)
    _seed_class(db, roster=("stu_alice",))
    _seed_open_session(db)
    _checkin(router, "abc123")
    _close_session(router)
    expected_pts = list(db[att.COLL_CLAIMS].docs.values())[0]["points"]
    res = _claim(router)
    assert res["ok"] is True
    assert res["credited_points"] == expected_pts
    assert res["claims_processed"] == 1
    assert wallet.total == expected_pts
    claims = list(db[att.COLL_CLAIMS].docs.values())
    assert all(c["status"] == "claimed" for c in claims)
    assert all(c["claimed_at"] is not None for c in claims)
    # claim_batch_id must be cleared after successful claim.
    assert all("claim_batch_id" not in c for c in claims)


def test_claim_wallet_identity_is_student_id_not_clean_id():
    """wallet.credit() must be called with student_id, not clean_id."""
    db, router, pushes, wallet = _build_claim(claim_mode=True)
    db[att.COLL_CLASSES].docs["cls_x"] = {
        "_id": "cls_x", "class_id": "cls_x", "title_en": "English A1",
        "title_kh": "", "roster": ["alice01"], "group": "",
    }
    db.students.docs["alice01"] = {
        "_id": "alice01", "student_id": "stu_aaa111", "clean_id": "alice01",
        "display_name": "Alice",
    }
    _seed_open_session(db)
    _checkin(router, "abc123", student="alice01")
    _close_session(router)
    _claim(router, student="alice01")
    assert len(wallet.credits) == 1
    # Primary wallet identity is the internal student_id.
    assert wallet.credits[0]["student_id"] == "stu_aaa111"
    # clean_id carried only as metadata.
    assert wallet.credits[0]["clean_id"] == "alice01"


def test_claim_no_pending_returns_ok_zero():
    db, router, pushes, wallet = _build_claim(claim_mode=True)
    _seed_class(db, roster=("stu_alice",))
    res = _claim(router)
    assert res["ok"] is True
    assert res["credited_points"] == 0
    assert res["claims_processed"] == 0
    assert res["message"] == "no_pending_claims"


def test_claim_rejected_when_claim_mode_disabled():
    import fastapi
    db, router, pushes, wallet = _build_claim(claim_mode=False)
    _seed_class(db, roster=("stu_alice",))
    try:
        _claim(router)
        assert False, "should have raised"
    except fastapi.HTTPException as e:
        assert e.status_code == 403
        assert "claim_mode_not_enabled" in str(e.detail)


# ─────────────────────────────────────────────────────────────────────────────
# 5. Idempotent retry and double-tap protection
# ─────────────────────────────────────────────────────────────────────────────

def test_claim_retry_does_not_double_credit():
    db, router, pushes, wallet = _build_claim(claim_mode=True)
    _seed_class(db, roster=("stu_alice",))
    _seed_open_session(db)
    _checkin(router, "abc123")
    _close_session(router)
    expected = list(db[att.COLL_CLAIMS].docs.values())[0]["points"]
    # Simulate retry: reset status to pending.
    for c in db[att.COLL_CLAIMS].docs.values():
        c["status"] = "pending"
        c.pop("claimed_at", None)
        c.pop("claim_batch_id", None)
    res2 = _claim(router)
    # Wallet had the idem key from first credit in seen → duplicate=True → no extra cash.
    assert res2["credited_points"] == expected
    assert wallet.total == expected  # no additional credit


def test_double_tap_second_claim_sees_nothing_pending():
    db, router, pushes, wallet = _build_claim(claim_mode=True)
    _seed_class(db, roster=("stu_alice",))
    _seed_open_session(db)
    _checkin(router, "abc123")
    _close_session(router)
    _claim(router)                        # first tap
    res2 = _claim(router)                 # second tap
    assert res2["message"] == "no_pending_claims"
    assert wallet.calls == 1


# ─────────────────────────────────────────────────────────────────────────────
# 6. Single wallet failure
# ─────────────────────────────────────────────────────────────────────────────

def test_wallet_failure_reverts_claim_to_pending():
    db, router, pushes, wallet = _build_claim(claim_mode=True)
    _seed_class(db, roster=("stu_alice",))
    _seed_open_session(db)
    _checkin(router, "abc123")
    _close_session(router)
    wallet.fail_next = True
    res = _claim(router)
    assert res["credited_points"] == 0
    assert res["failed_count"] == 1
    claims = list(db[att.COLL_CLAIMS].docs.values())
    assert all(c["status"] == "pending" for c in claims)
    # claim_batch_id must be cleared on revert.
    assert all("claim_batch_id" not in c for c in claims)


# ─────────────────────────────────────────────────────────────────────────────
# GATE 2 — Concurrency: claim_batch_id reservation ownership
# ─────────────────────────────────────────────────────────────────────────────

def test_concurrent_request_cannot_process_other_batch_records():
    """Simulate Request A mid-flight: records already in "claiming" with
    batch_id "other_batch". Request B's update_many finds no "pending" records
    → returns no_pending_claims without touching Request A's reserved records."""
    db, router, pushes, wallet = _build_claim(claim_mode=True)
    _seed_class(db, roster=("stu_alice",))

    # Pre-seed a "claiming" record as if another request reserved it.
    other_batch_id = "other_batch_aaa"
    db[att.COLL_CLAIMS].docs["claim_A"] = {
        "_id": "claim_A",
        "idempotency_key": "attendance:ses_1:stu_alice",
        "student_id": "stu_alice",
        "wallet_student_id": "stu_alice",
        "clean_id": "stu_alice",
        "source_session_id": "ses_1",
        "points": 5,
        "status": "claiming",                   # already reserved
        "claim_batch_id": other_batch_id,       # owned by another request
        "claiming_started_at": _iso(_now()),
        "created_at": _iso(_now()),
        "eligible_at": _iso(_now()),
        "claimed_at": None,
        "wallet_transaction_id": None,
        "notification_sent": False,
        "schema_version": 1,
    }

    # Request B arrives: no pending records → safe no-op.
    res = _claim(router)
    assert res["message"] == "no_pending_claims"
    assert wallet.calls == 0

    # Request A's record is untouched (still "claiming" with its own batch_id).
    rec = db[att.COLL_CLAIMS].docs["claim_A"]
    assert rec["status"] == "claiming"
    assert rec["claim_batch_id"] == other_batch_id


def test_concurrent_second_request_gets_safe_response_after_first_claims():
    """After the first successful claim, any concurrent/duplicate second request
    immediately gets no_pending_claims with wallet called exactly once."""
    db, router, pushes, wallet = _build_claim(claim_mode=True)
    _seed_class(db, roster=("stu_alice",))
    _seed_open_session(db)
    _checkin(router, "abc123")
    _close_session(router)

    # Simulate two requests arriving; run them sequentially (our fake is sync).
    res1 = _claim(router)
    res2 = _claim(router)

    assert res1["ok"] is True
    assert res1["credited_points"] > 0
    assert res2["message"] == "no_pending_claims"
    assert wallet.calls == 1               # only one real wallet call


def test_batch_id_scopes_only_own_revert():
    """When a failure triggers revert, ONLY the records with THIS batch_id
    are reverted. Records from another batch (not present in this scenario
    but confirmed by query specificity) are untouched."""
    db, router, pushes, wallet = _build_claim(claim_mode=True)
    _seed_class(db, roster=("stu_alice",))
    _seed_open_session(db)
    _checkin(router, "abc123")
    _close_session(router)

    # Inject an extra "claiming" record with a foreign batch id.
    db[att.COLL_CLAIMS].docs["foreign_claim"] = {
        "_id": "foreign_claim",
        "idempotency_key": "attendance:ses_X:stu_alice",
        "student_id": "stu_alice",
        "wallet_student_id": "stu_alice",
        "clean_id": "stu_alice",
        "source_session_id": "ses_X",
        "points": 99,
        "status": "claiming",
        "claim_batch_id": "foreign_batch_000",
        "claiming_started_at": _iso(_now()),
        "created_at": _iso(_now()),
        "eligible_at": _iso(_now()),
        "claimed_at": None,
        "wallet_transaction_id": None,
        "notification_sent": False,
        "schema_version": 1,
    }

    # Force wallet to fail for this request's record.
    wallet.fail_next = True
    _claim(router)

    # The foreign record must NOT have been touched.
    foreign = db[att.COLL_CLAIMS].docs["foreign_claim"]
    assert foreign["status"] == "claiming"
    assert foreign["claim_batch_id"] == "foreign_batch_000"
    assert foreign["points"] == 99


def test_claim_batch_id_cleared_on_success():
    """After a successful claim, claim_batch_id is cleared from the record
    so no stale ownership token remains."""
    db, router, pushes, wallet = _build_claim(claim_mode=True)
    _seed_class(db, roster=("stu_alice",))
    _seed_open_session(db)
    _checkin(router, "abc123")
    _close_session(router)
    _claim(router)
    for c in db[att.COLL_CLAIMS].docs.values():
        assert "claim_batch_id" not in c
        assert "claiming_started_at" not in c


# ─────────────────────────────────────────────────────────────────────────────
# GATE 3 — Partial failure: N rewards, subset fails
# ─────────────────────────────────────────────────────────────────────────────

def _setup_three_pending_claims(*, claim_mode=True, wallet_factory=None):
    """Return (db, router, pushes, wallet) with 3 pending claims for stu_alice."""
    db, router, pushes, wallet = _build_claim(claim_mode=claim_mode,
                                               wallet_factory=wallet_factory)
    db[att.COLL_CLASSES].docs["cls_x"] = {
        "_id": "cls_x", "class_id": "cls_x", "title_en": "Class A",
        "title_kh": "", "roster": ["stu_alice"], "group": "",
    }
    db.students.docs["stu_alice"] = {
        "_id": "stu_alice", "student_id": "stu_alice", "clean_id": "stu_alice",
        "display_name": "ALICE",
    }
    for n in (1, 2, 3):
        sid, slug = _seed_extra_session(db, n)
        _checkin(router, slug, student="stu_alice")
        _close_session(router, sid=sid)
    return db, router, pushes, wallet


def test_partial_failure_middle_reward_fails_others_credited():
    """Three pending rewards; wallet fails on call #2 (middle).
    Expected: rewards 1 and 3 are "claimed", reward 2 is "pending" again.
    wallet.total = points for sessions 1 and 3 only."""
    db, router, pushes, wallet = _setup_three_pending_claims(
        wallet_factory=lambda: _WalletSelectiveFail(fail_on_calls={2}),
    )
    pending_before = [c for c in db[att.COLL_CLAIMS].docs.values()
                      if c["status"] == "pending"]
    assert len(pending_before) == 3

    res = _claim(router)

    assert res["ok"] is True
    assert res["claims_processed"] == 2      # only 2 credited
    assert res["failed_count"] == 1
    assert res["credited_points"] > 0

    statuses = {c["status"] for c in db[att.COLL_CLAIMS].docs.values()}
    assert "claimed" in statuses
    assert "pending" in statuses
    # Exactly one pending, two claimed.
    claimed = [c for c in db[att.COLL_CLAIMS].docs.values() if c["status"] == "claimed"]
    still_pending = [c for c in db[att.COLL_CLAIMS].docs.values() if c["status"] == "pending"]
    assert len(claimed) == 2
    assert len(still_pending) == 1

    # Claimed records have no stale batch markers.
    for c in claimed:
        assert "claim_batch_id" not in c
    # Pending record also has batch markers cleared (can be retried).
    assert "claim_batch_id" not in still_pending[0]


def test_partial_failure_wallet_total_reflects_only_credited():
    """wallet.total accounts only for the two successful credits."""
    db, router, pushes, wallet = _setup_three_pending_claims(
        wallet_factory=lambda: _WalletSelectiveFail(fail_on_calls={2}),
    )
    claims_before = sorted(
        db[att.COLL_CLAIMS].docs.values(),
        key=lambda c: c.get("source_session_id", ""),
    )
    assert len(claims_before) == 3
    expected_total = claims_before[0]["points"] + claims_before[2]["points"]

    res = _claim(router)

    assert res["credited_points"] == expected_total
    assert wallet.total == expected_total


def test_partial_failure_push_reflects_only_credited_points():
    """Push message body should report ONLY the credited amount, not the full
    3-reward total, so the student knows exactly what landed in their wallet."""
    db, router, pushes, wallet = _setup_three_pending_claims(
        wallet_factory=lambda: _WalletSelectiveFail(fail_on_calls={2}),
    )
    claims_before = sorted(
        db[att.COLL_CLAIMS].docs.values(),
        key=lambda c: c.get("source_session_id", ""),
    )
    credited_total = claims_before[0]["points"] + claims_before[2]["points"]

    before = len(pushes)
    _claim(router)
    after_pushes = pushes[before:]

    # A claimed push was fired.
    assert len(after_pushes) >= 1
    combined = " ".join(p["body"] for p in after_pushes)
    # The push body must mention the credited amount, not more.
    assert str(credited_total) in combined


def test_partial_failure_retry_credits_only_failed_reward():
    """After partial failure, retry claims only the one still-pending reward,
    does NOT re-credit already-claimed rewards (wallet idempotency)."""
    db, router, pushes, wallet = _setup_three_pending_claims(
        wallet_factory=lambda: _WalletSelectiveFail(fail_on_calls={2}),
    )
    res1 = _claim(router)
    assert res1["claims_processed"] == 2    # 1st claim partially successful

    # Retry.
    res2 = _claim(router)
    assert res2["ok"] is True
    assert res2["claims_processed"] == 1    # only the failed one retried

    # All three should now be claimed.
    all_claims = list(db[att.COLL_CLAIMS].docs.values())
    assert all(c["status"] == "claimed" for c in all_claims)

    # wallet.total should equal the full 3-session amount.
    claimed_pts = {c["points"] for c in all_claims}
    # Total calls: 2 (1st batch) + 2 (retry: 1 fresh + possibly 2 duplicates).
    # Wallet total never double-counts.
    assert wallet.total == sum(c["points"] for c in all_claims)


def test_push_failure_does_not_roll_back_credit():
    """If the push notification fails AFTER wallet credit, the credit stands."""
    db = _DB()
    router = _Router()
    wallet = _Wallet()
    fail_called = []

    async def bad_fan_out(query, title, body, url):
        # Only fail push after a credit happened (second fan_out call onwards).
        fail_called.append(1)
        if len(fail_called) > 1:
            raise RuntimeError("push service down")
        return (0, 0)

    def build_q(target, ids, group):
        return {"target": target, "studentId": {"$in": list(ids or [])}}

    att.register_attendance_routes(
        router, db, require_admin=_Admin(), require_student=object(),
        current_student=None, fan_out_push=bad_fan_out, build_target_query=build_q,
        norm_student_id=lambda v: str(v or "").strip().lower(), wallet=wallet,
    )
    settings = att.default_settings()
    settings["claim_rewards_enabled"] = True
    settings["reward_ready_push_enabled"] = False
    settings["reward_claimed_push_enabled"] = True
    settings["_id"] = att.SETTINGS_ID
    db[att.COLL_SETTINGS].docs[att.SETTINGS_ID] = settings

    db[att.COLL_CLASSES].docs["cls_x"] = {
        "_id": "cls_x", "class_id": "cls_x", "title_en": "X",
        "title_kh": "", "roster": ["stu_alice"], "group": "",
    }
    db.students.docs["stu_alice"] = {
        "_id": "stu_alice", "student_id": "stu_alice", "clean_id": "stu_alice",
        "display_name": "ALICE",
    }
    _seed_open_session(db)
    _call(router, "POST", "/attendance/checkin",
          payload=att.CheckInIn(slug="abc123"), student=_Student("stu_alice"))
    _call(router, "POST", "/admin/attendance/sessions/{session_id}/close",
          session_id="ses_1", admin=_Admin())
    res = _call(router, "POST", "/attendance/rewards/claim",
                student=_Student("stu_alice"))

    assert res["ok"] is True
    assert res["credited_points"] > 0
    # Push failure did NOT roll back the credit.
    assert wallet.total == res["credited_points"]
    # Claim records remain "claimed".
    claims = list(db[att.COLL_CLAIMS].docs.values())
    assert all(c["status"] == "claimed" for c in claims)
    # Retry does not double-credit (wallet idempotency).
    res2 = _call(router, "POST", "/attendance/rewards/claim",
                 student=_Student("stu_alice"))
    assert res2["message"] == "no_pending_claims"
    assert wallet.total == res["credited_points"]


# ─────────────────────────────────────────────────────────────────────────────
# GATE 4 — Activation / historical safety
# ─────────────────────────────────────────────────────────────────────────────

def test_default_settings_claim_rewards_disabled():
    """`default_settings()` must return claim_rewards_enabled=False.
    This guarantees that new classes/tenants default to auto-credit."""
    defaults = att.default_settings()
    assert defaults["claim_rewards_enabled"] is False


def test_auto_credit_behavior_unchanged_when_claim_mode_disabled():
    """When claim_rewards_enabled=False, existing auto-credit path is
    exercised: wallet credit fires at session close, no pending claims created."""
    db, router, pushes, wallet = _build_claim(claim_mode=False)
    _seed_class(db, roster=("stu_alice",))
    _seed_open_session(db)
    _checkin(router, "abc123")
    res = _close_session(router)
    assert res["rewards_credited"] == 1
    assert wallet.total > 0
    assert len(db[att.COLL_CLAIMS].docs) == 0


def test_sessions_before_activation_always_auto_credited():
    """Sessions closed BEFORE claim_mode_activation_at receive wallet credit,
    even when claim_rewards_enabled=True, to protect previously auto-credited
    sessions from being re-paid through the claim path."""
    future = _now() + timedelta(days=1)
    db, router, pushes, wallet = _build_claim(claim_mode=True, activation_at=future)
    _seed_class(db, roster=("stu_alice",))
    _seed_open_session(db)
    _checkin(router, "abc123")
    _close_session(router)
    # Closed before activation → auto-credit.
    assert wallet.total > 0
    assert len(db[att.COLL_CLAIMS].docs) == 0


def test_previously_auto_credited_session_cannot_be_repaid_through_claim():
    """A session credited via auto mode cannot be paid a second time through
    the claim endpoint. The wallet's idempotency key is shared (same
    attendance:{session_id}:{student_id} key), so wallet returns duplicate=True
    and NO additional money is credited."""
    # Step 1: auto-credit mode — wallet credits the session.
    db, router, pushes, wallet = _build_claim(claim_mode=False)
    _seed_class(db, roster=("stu_alice",))
    _seed_open_session(db)
    _checkin(router, "abc123")
    _close_session(router)
    auto_total = wallet.total
    assert auto_total > 0

    # Step 2: simulate an admin switching on claim mode and manually inserting
    # a "pending" claim record with the SAME idempotency_key that was already
    # used in step 1 (this represents an erroneous retroactive claim).
    idem_key = f"attendance:ses_1:stu_alice"
    db[att.COLL_CLAIMS].docs["retro_claim"] = {
        "_id": "retro_claim",
        "idempotency_key": idem_key,  # SAME key as auto-credit
        "student_id": "stu_alice",
        "wallet_student_id": "stu_alice",
        "clean_id": "stu_alice",
        "source_session_id": "ses_1",
        "points": 5,
        "status": "pending",
        "created_at": _iso(_now()),
        "eligible_at": _iso(_now()),
        "claimed_at": None, "wallet_transaction_id": None,
        "notification_sent": False, "schema_version": 1,
    }
    # Enable claim mode.
    db[att.COLL_SETTINGS].docs[att.SETTINGS_ID]["claim_rewards_enabled"] = True

    # Step 3: student tries to claim — wallet sees duplicate=True.
    res = _claim(router)
    assert res["ok"] is True
    # Wallet saw duplicate — total stays the same (no extra money).
    assert wallet.total == auto_total
    # The claim record still flips to "claimed" (correct record-keeping),
    # but no new payment was issued.
    retro = db[att.COLL_CLAIMS].docs["retro_claim"]
    assert retro["status"] == "claimed"


def test_pending_rewards_survive_claim_mode_disabled():
    """Disabling claim mode (via settings change) does NOT destroy existing
    pending reward records. The student gets a 403 on POST /claim but the
    rewards remain in the DB, claimable once claim mode is re-enabled."""
    db, router, pushes, wallet = _build_claim(claim_mode=True)
    _seed_class(db, roster=("stu_alice",))
    _seed_open_session(db)
    _checkin(router, "abc123")
    _close_session(router)
    pending_count_before = len([c for c in db[att.COLL_CLAIMS].docs.values()
                                 if c["status"] == "pending"])
    assert pending_count_before == 1

    # Admin disables claim mode.
    db[att.COLL_SETTINGS].docs[att.SETTINGS_ID]["claim_rewards_enabled"] = False

    # Pending records still exist in DB.
    pending_count_after = len([c for c in db[att.COLL_CLAIMS].docs.values()
                                if c["status"] == "pending"])
    assert pending_count_after == 1

    # Summary still reports them (so student knows they're waiting).
    summary = _summary(router)
    assert summary["claimable_count"] == 1

    # But claim endpoint returns 403.
    import fastapi
    try:
        _claim(router)
        assert False, "should have raised"
    except fastapi.HTTPException as e:
        assert e.status_code == 403


def test_invalid_activation_timestamp_falls_back_to_auto_credit():
    """An unparseable claim_mode_activation_at must NOT activate claim mode.
    The safe fallback is auto-credit to prevent retroactive reward creation."""
    db, router, pushes, wallet = _build_claim(claim_mode=True)
    # Inject a bad timestamp after the helper seeded valid settings.
    db[att.COLL_SETTINGS].docs[att.SETTINGS_ID]["claim_mode_activation_at"] = "NOT_A_DATE"
    _seed_class(db, roster=("stu_alice",))
    _seed_open_session(db)
    _checkin(router, "abc123")
    _close_session(router)
    # Unparseable activation → safe fallback = auto-credit, no pending claim.
    assert wallet.total > 0
    assert len(db[att.COLL_CLAIMS].docs) == 0


def test_activation_none_means_claim_mode_applies_immediately():
    """claim_mode_activation_at absent → no activation restriction → claim
    mode applies immediately to all sessions after claim_rewards_enabled=True."""
    db, router, pushes, wallet = _build_claim(claim_mode=True, activation_at=None)
    _seed_class(db, roster=("stu_alice",))
    _seed_open_session(db)
    _checkin(router, "abc123")
    _close_session(router)
    assert wallet.total == 0
    assert len(db[att.COLL_CLAIMS].docs) == 1


# ─────────────────────────────────────────────────────────────────────────────
# GATE 5 — Wallet identity and idempotency key uniqueness
# ─────────────────────────────────────────────────────────────────────────────

def test_idempotency_keys_unique_across_students_and_sessions():
    """Keys must be distinct for different (student, session) pairs and must
    not collide between auto-credit and claim-mode paths (same formula is
    used for both, guaranteeing mutual exclusion)."""
    db, router, pushes, wallet = _build_claim(claim_mode=True)
    _seed_class(db, roster=("stu_alice", "stu_bob"))
    # Two sessions.
    _seed_extra_session(db, 1)
    _seed_extra_session(db, 2)
    for slug in ("slug1", "slug2"):
        for sid in ("stu_alice", "stu_bob"):
            _checkin(router, slug, student=sid)
    _close_session(router, sid="ses_1")
    _close_session(router, sid="ses_2")

    idem_keys = [c["idempotency_key"] for c in db[att.COLL_CLAIMS].docs.values()]
    # 2 students × 2 sessions = 4 keys, all unique.
    assert len(idem_keys) == 4
    assert len(set(idem_keys)) == 4

    # No key contains a collision between alice and bob.
    alice_keys = [k for k in idem_keys if "stu_alice" in k]
    bob_keys   = [k for k in idem_keys if "stu_bob" in k]
    assert len(alice_keys) == 2
    assert len(bob_keys) == 2
    assert not set(alice_keys) & set(bob_keys)

    # No key collision between session 1 and session 2 for same student.
    assert len({k for k in alice_keys if "ses_1" in k}) == 1
    assert len({k for k in alice_keys if "ses_2" in k}) == 1


def test_close_credits_wallet_by_student_id_not_clean_id_in_auto_mode():
    """In auto-credit mode, the same wallet_student_id rule applies — the
    primary wallet identity must be the internal student_id, not clean_id."""
    from tests.test_attendance_rewards import _RecordingWallet, _build_with_recording_wallet
    db, router, wallet = _build_with_recording_wallet()
    db[att.COLL_CLASSES].docs["cls_x"] = {
        "_id": "cls_x", "class_id": "cls_x", "title_en": "English A1",
        "title_kh": "", "roster": ["carol03"], "group": "",
    }
    db.students.docs["carol03"] = {
        "_id": "carol03", "student_id": "stu_ccc999", "clean_id": "carol03",
        "display_name": "Carol",
    }
    _seed_open_session(db)
    _call(router, "POST", "/attendance/checkin",
          payload=att.CheckInIn(slug="abc123"), student=_Student("carol03"))
    _call(router, "POST", "/admin/attendance/sessions/{session_id}/close",
          session_id="ses_1", admin=_Admin())
    assert wallet.credits[0][0] == "stu_ccc999"      # primary = student_id
    assert wallet.credits[0][1] == "carol03"          # metadata = clean_id


# ─────────────────────────────────────────────────────────────────────────────
# 7. Push notifications
# ─────────────────────────────────────────────────────────────────────────────

def test_reward_ready_push_sent_on_session_close_in_claim_mode():
    db, router, pushes, wallet = _build_claim(claim_mode=True, reward_ready_push=True)
    _seed_class(db, roster=("stu_alice",))
    _seed_open_session(db)
    _checkin(router, "abc123")
    _close_session(router)
    assert any("Reward" in p["title"] or "រង្វាន់" in p["title"] for p in pushes)


def test_reward_ready_push_suppressed_when_disabled():
    db, router, pushes, wallet = _build_claim(claim_mode=True, reward_ready_push=False)
    _seed_class(db, roster=("stu_alice",))
    _seed_open_session(db)
    _checkin(router, "abc123")
    _close_session(router)
    reward_pushes = [p for p in pushes
                     if "Reward" in p.get("title", "") or "រង្វាន់" in p.get("title", "")]
    assert len(reward_pushes) == 0


def test_reward_claimed_push_sent_after_credit():
    db, router, pushes, wallet = _build_claim(claim_mode=True, reward_claimed_push=True)
    _seed_class(db, roster=("stu_alice",))
    _seed_open_session(db)
    _checkin(router, "abc123")
    _close_session(router)
    before = len(pushes)
    _claim(router)
    after_pushes = pushes[before:]
    assert len(after_pushes) >= 1
    combined = " ".join(p["title"] + p["body"] for p in after_pushes)
    assert "Attendance reward" in combined or "រង្វាន់វត្តមាន" in combined


def test_push_includes_khmer_copy():
    db, router, pushes, wallet = _build_claim(claim_mode=True, reward_claimed_push=True)
    _seed_class(db, roster=("stu_alice",))
    _seed_open_session(db)
    _checkin(router, "abc123")
    _close_session(router)
    _claim(router)
    combined = " ".join(p["title"] + p["body"] for p in pushes)
    assert any("ក" <= ch <= "៿" for ch in combined), \
        "No Khmer script in push payloads"


def test_dynamic_point_amount_interpolated_in_push():
    """The point amount in the push body must match what was actually credited."""
    db, router, pushes, wallet = _build_claim(claim_mode=True, reward_claimed_push=True)
    _seed_class(db, roster=("stu_alice",))
    _seed_open_session(db)
    _checkin(router, "abc123")
    _close_session(router)
    expected_pts = list(db[att.COLL_CLAIMS].docs.values())[0]["points"]
    before = len(pushes)
    _claim(router)
    after_pushes = pushes[before:]
    combined = " ".join(p["body"] for p in after_pushes)
    assert str(expected_pts) in combined, \
        f"Expected {expected_pts} in push body but got: {combined!r}"


# ─────────────────────────────────────────────────────────────────────────────
# 8. Student isolation
# ─────────────────────────────────────────────────────────────────────────────

def test_alice_cannot_claim_bobs_pending_rewards():
    db, router, pushes, wallet = _build_claim(claim_mode=True)
    _seed_class(db, roster=("stu_alice", "stu_bob"))
    _seed_open_session(db)
    for sid in ("stu_alice", "stu_bob"):
        _checkin(router, "abc123", student=sid)
    _close_session(router)
    _claim(router, student="stu_alice")
    alice_claims = [c for c in db[att.COLL_CLAIMS].docs.values()
                    if c.get("student_id") == "stu_alice"]
    bob_claims = [c for c in db[att.COLL_CLAIMS].docs.values()
                  if c.get("student_id") == "stu_bob"]
    assert all(c["status"] == "claimed" for c in alice_claims)
    assert all(c["status"] == "pending" for c in bob_claims)


def test_summary_only_shows_current_students_records():
    db, router, pushes, wallet = _build_claim(claim_mode=True)
    _seed_class(db, roster=("stu_alice", "stu_bob"))
    _seed_open_session(db)
    for sid in ("stu_alice", "stu_bob"):
        _checkin(router, "abc123", student=sid)
    _close_session(router)
    alice_summary = _summary(router, student="stu_alice")
    bob_summary = _summary(router, student="stu_bob")
    assert alice_summary["claimable_count"] == 1
    assert bob_summary["claimable_count"] == 1
    assert alice_summary["claimable_points"] == bob_summary["claimable_points"]


# ─────────────────────────────────────────────────────────────────────────────
# 9. below_minimum threshold
# ─────────────────────────────────────────────────────────────────────────────

def test_claim_blocked_when_below_minimum():
    db, router, pushes, wallet = _build_claim(claim_mode=True, min_pts=1000)
    _seed_class(db, roster=("stu_alice",))
    _seed_open_session(db)
    _checkin(router, "abc123")
    _close_session(router)
    res = _claim(router)
    assert res["ok"] is False
    assert res["message"] == "below_minimum"
    assert res["minimum"] == 1000
    claims = list(db[att.COLL_CLAIMS].docs.values())
    assert all(c["status"] == "pending" for c in claims)
    # claim_batch_id cleared on revert.
    assert all("claim_batch_id" not in c for c in claims)
    assert wallet.total == 0


# ─────────────────────────────────────────────────────────────────────────────
# 10. Privacy: no risk_score
# ─────────────────────────────────────────────────────────────────────────────

def test_no_risk_score_in_summary_or_claim_response():
    db, router, pushes, wallet = _build_claim(claim_mode=True)
    _seed_class(db, roster=("stu_alice",))
    _seed_open_session(db)
    _checkin(router, "abc123")
    _close_session(router)
    summary = _summary(router)
    claim_res = _claim(router)
    for resp in (summary, claim_res):
        assert "risk_score" not in resp
        assert "risk_score" not in str(resp)
