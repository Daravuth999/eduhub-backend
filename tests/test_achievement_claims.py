"""tests/test_achievement_claims.py
====================================
Achievement Center (Phase 1, Trophy Tiers) — claim-flow safety tests.

Self-contained in-memory fakes (same approach as
tests/test_attendance_checkin.py); runnable under real pytest. Reuses the
shared _Router/_Student/_Admin/_call fakes from test_attendance_checkin.py,
but supplies its own claims-collection fake so it can enforce the real
(student_id, trophy_id) UNIQUE index behavior (DuplicateKeyError on a
concurrent second claim) — the shared _Coll fake has no concept of a
secondary unique index.

Coverage:
  - Unlocked + claim_enabled + points>0 -> claim succeeds, wallet credited
    exactly once, claim doc ends up "credited".
  - Concurrent double-claim: second insert_one hits the unique index ->
    409, wallet.credit() called only once total.
  - Requirements not (yet) met -> 403, no claim doc, no credit — server
    recomputes from real metrics, never trusts a client-supplied signal.
  - Disabled trophy / claim not enabled -> 403 before any DB write.
  - Wallet credit failure -> pending claim rolled back (deleted) so the
    student can retry; retry then succeeds.
  - Client-cancellation-style failure (a BaseException that is NOT an
    Exception, e.g. asyncio.CancelledError) during wallet.credit() still
    rolls back the pending claim instead of leaking it forever.
  - Finalize-write failure AFTER a successful wallet credit does not turn
    into a 500 for the student (the money already moved) — this is the
    audit fix in achievement_tools.py's achievements_claim.
"""
from __future__ import annotations

import asyncio
import copy

import pytest
from pymongo.errors import DuplicateKeyError

import achievement_tools as ach

try:
    from tests.test_attendance_checkin import _Router, _Student, _Admin, _call
except ImportError:
    from test_attendance_checkin import _Router, _Student, _Admin, _call  # type: ignore


def run(c):
    return asyncio.run(c)


# ── minimal fakes ─────────────────────────────────────────────────────────

class _SimpleColl:
    """Generic collection fake (no secondary unique index enforcement) —
    used for trophies and every read-only metric-source collection."""

    def __init__(self):
        self.docs = {}
        self._auto = 0

    async def find_one(self, q, p=None):
        for d in self.docs.values():
            if all(d.get(k) == v for k, v in q.items() if not isinstance(v, dict)):
                o = copy.deepcopy(d)
                if p and p.get("_id") == 0:
                    o.pop("_id", None)
                return o
        return None

    async def count_documents(self, q):
        return 0

    async def aggregate(self, pipeline):
        class _Cur:
            async def to_list(self, n):
                return []
        return _Cur()

    async def insert_one(self, doc):
        key = doc.get("trophy_id") or f"auto{self._auto}"
        self._auto += 1
        self.docs[key] = copy.deepcopy(doc)
        return type("R", (), {"inserted_id": key})()

    async def update_one(self, q, up, upsert=False):
        for d in self.docs.values():
            if all(d.get(k) == v for k, v in q.items() if not isinstance(v, dict)):
                if "$set" in up:
                    d.update(up["$set"])
                if "$inc" in up:
                    for k, v in up["$inc"].items():
                        d[k] = (d.get(k) or 0) + v
                return type("R", (), {"matched_count": 1})()
        return type("R", (), {"matched_count": 0})()

    def find(self, q, p=None):
        out = [copy.deepcopy(d) for d in self.docs.values()]
        if p and p.get("_id") == 0:
            for o in out:
                o.pop("_id", None)

        class _Cursor:
            def __init__(self, d):
                self._d = d

            def sort(self, f, d=1):
                self._d.sort(key=lambda x: x.get(f) or 0, reverse=(d == -1))
                return self

            def limit(self, n):
                self._d = self._d[:n]
                return self

            def __aiter__(self):
                async def g():
                    for x in self._d:
                        yield x
                return g()
        return _Cursor(out)

    async def create_index(self, *a, **k):
        return None


class _ClaimsColl(_SimpleColl):
    """Enforces the real unique (student_id, trophy_id) index — the actual
    race-safety mechanism achievement_tools.py depends on."""

    async def insert_one(self, doc):
        key = (doc["student_id"], doc["trophy_id"])
        if key in self.docs:
            raise DuplicateKeyError("duplicate key: student_id_1_trophy_id_1")
        self.docs[key] = copy.deepcopy(doc)
        return type("R", (), {"inserted_id": doc["claim_id"]})()

    async def update_one(self, q, up, upsert=False):
        for d in self.docs.values():
            if d.get("claim_id") == q.get("claim_id"):
                if q.get("status") and d.get("status") != q["status"]:
                    continue
                if "$set" in up:
                    d.update(up["$set"])
                return type("R", (), {"matched_count": 1})()
        return type("R", (), {"matched_count": 0})()

    async def delete_one(self, q):
        for k, d in list(self.docs.items()):
            if d.get("claim_id") == q.get("claim_id") and d.get("status") == q.get("status"):
                del self.docs[k]
                return type("R", (), {"deleted_count": 1})()
        return type("R", (), {"deleted_count": 0})()

    def find(self, q, p=None):
        ids = (q.get("student_id") or {}).get("$in") if isinstance(q.get("student_id"), dict) else None
        out = []
        for d in self.docs.values():
            if ids is not None and d.get("student_id") not in ids:
                continue
            o = copy.deepcopy(d)
            if p and p.get("_id") == 0:
                o.pop("_id", None)
            out.append(o)

        class _Cursor:
            def __init__(self, d):
                self._d = d

            def sort(self, f, d=1):
                self._d.sort(key=lambda x: x.get(f) or "", reverse=(d == -1))
                return self

            def limit(self, n):
                self._d = self._d[:n]
                return self

            def __aiter__(self):
                async def g():
                    for x in self._d:
                        yield x
                return g()
        return _Cursor(out)


class _DB:
    def __init__(self):
        self._c = {"achievement_trophies": _SimpleColl(), "achievement_claims": _ClaimsColl()}

    def __getitem__(self, name):
        return self._c.setdefault(name, _SimpleColl())


class _Wallet:
    """Honors the idempotency_key contract exactly like wallet_service."""

    def __init__(self):
        self.seen = {}
        self.calls = 0
        self.fail_mode = None  # None | "exception" | "cancelled"
        self.finalize_should_fail = False  # test hook, unused by wallet itself

    async def credit(self, student_id, amount, *, source, source_ref=None,
                      idempotency_key=None, clean_id=None, **kw):
        self.calls += 1
        if self.fail_mode == "exception":
            raise RuntimeError("simulated wallet failure")
        if self.fail_mode == "cancelled":
            raise asyncio.CancelledError()
        if idempotency_key in self.seen:
            return {"ok": True, "duplicate": True, "balance_after": self.seen[idempotency_key]}
        balance = amount
        self.seen[idempotency_key] = balance
        return {"ok": True, "duplicate": False, "balance_after": balance}


def _build(wallet=None):
    db = _DB()
    router = _Router()
    ach.register_achievement_routes(router, db, lambda: None, lambda: None, wallet=wallet)
    return db, router


def _seed_trophy(db, *, trophy_id="tier1", enabled=True, points=50,
                  claim_enabled=True, requirement=1):
    db["achievement_trophies"].docs[trophy_id] = {
        "trophy_id": trophy_id,
        "name": "Trophy Tier 1",
        "display_order": 1,
        "artwork": "/assets/trophies/x.png",
        "enabled": enabled,
        "requirements": {**ach._default_requirements(), "min_lifetime_points": requirement},
        "reward": {**ach._default_reward(), "points": points, "claim_enabled": claim_enabled},
        "version": 1,
    }


def _patch_metrics(monkeypatch, value):
    async def fake_compute_metrics(db, student):
        return {
            "lifetime_points": value, "attendance_sessions": 0,
            "lessons_completed": 0, "reading_completed": 0,
            "speaking_activities": 0, "streak_days": 0,
        }
    monkeypatch.setattr(ach, "compute_metrics", fake_compute_metrics)


# ── tests ─────────────────────────────────────────────────────────────────

def test_claim_succeeds_and_credits_wallet_once(monkeypatch):
    wallet = _Wallet()
    db, router = _build(wallet)
    _seed_trophy(db)
    _patch_metrics(monkeypatch, 100)
    student = _Student("stu_alice")

    res = _call(router, "POST", "/achievements/claim", payload={"trophy_id": "tier1"}, student=student)
    assert res["ok"] is True
    assert res["points"] == 50
    assert wallet.calls == 1
    claim = db["achievement_claims"].docs[("stu_alice", "tier1")]
    assert claim["status"] == "credited"


def test_concurrent_double_claim_only_credits_once(monkeypatch):
    wallet = _Wallet()
    db, router = _build(wallet)
    _seed_trophy(db)
    _patch_metrics(monkeypatch, 100)
    student = _Student("stu_alice")

    _call(router, "POST", "/achievements/claim", payload={"trophy_id": "tier1"}, student=student)
    with pytest.raises(Exception) as exc_info:
        _call(router, "POST", "/achievements/claim", payload={"trophy_id": "tier1"}, student=student)
    assert getattr(exc_info.value, "status_code", None) == 409
    assert wallet.calls == 1  # second attempt never reached the wallet


def test_requirements_not_met_blocks_claim_server_side(monkeypatch):
    wallet = _Wallet()
    db, router = _build(wallet)
    _seed_trophy(db, requirement=1000)  # far above the fake metric below
    _patch_metrics(monkeypatch, 5)
    student = _Student("stu_bob")

    with pytest.raises(Exception) as exc_info:
        _call(router, "POST", "/achievements/claim", payload={"trophy_id": "tier1"}, student=student)
    assert getattr(exc_info.value, "status_code", None) == 403
    assert wallet.calls == 0
    assert ("stu_bob", "tier1") not in db["achievement_claims"].docs


def test_disabled_trophy_blocks_claim(monkeypatch):
    wallet = _Wallet()
    db, router = _build(wallet)
    _seed_trophy(db, enabled=False)
    _patch_metrics(monkeypatch, 100)
    student = _Student("stu_carl")

    with pytest.raises(Exception) as exc_info:
        _call(router, "POST", "/achievements/claim", payload={"trophy_id": "tier1"}, student=student)
    assert getattr(exc_info.value, "status_code", None) == 403
    assert wallet.calls == 0


def test_wallet_failure_rolls_back_pending_claim_for_retry(monkeypatch):
    wallet = _Wallet()
    wallet.fail_mode = "exception"
    db, router = _build(wallet)
    _seed_trophy(db)
    _patch_metrics(monkeypatch, 100)
    student = _Student("stu_dana")

    with pytest.raises(Exception) as exc_info:
        _call(router, "POST", "/achievements/claim", payload={"trophy_id": "tier1"}, student=student)
    assert getattr(exc_info.value, "status_code", None) == 502
    assert ("stu_dana", "tier1") not in db["achievement_claims"].docs  # rolled back

    # Retry succeeds now that the wallet is healthy again.
    wallet.fail_mode = None
    res = _call(router, "POST", "/achievements/claim", payload={"trophy_id": "tier1"}, student=student)
    assert res["ok"] is True
    assert wallet.calls == 2


def test_cancelled_request_during_credit_still_rolls_back(monkeypatch):
    """Regression test for the audit fix: a cancelled in-flight request
    (asyncio.CancelledError, which is a BaseException but NOT an Exception)
    must still clean up the pending claim instead of leaking a permanent
    "pending" row that the unique index would then block forever."""
    wallet = _Wallet()
    wallet.fail_mode = "cancelled"
    db, router = _build(wallet)
    _seed_trophy(db)
    _patch_metrics(monkeypatch, 100)
    student = _Student("stu_erin")

    with pytest.raises(asyncio.CancelledError):
        _call(router, "POST", "/achievements/claim", payload={"trophy_id": "tier1"}, student=student)

    # The pending claim must have been rolled back, not left stranded.
    assert ("stu_erin", "tier1") not in db["achievement_claims"].docs

    # Retry with a healthy wallet succeeds — no stuck 409 lockout.
    wallet.fail_mode = None
    res = _call(router, "POST", "/achievements/claim", payload={"trophy_id": "tier1"}, student=student)
    assert res["ok"] is True


def test_finalize_write_failure_after_credit_does_not_error_the_request(monkeypatch):
    """Regression test for the audit fix: if the credit succeeds but the
    final "$set status=credited" write throws, the student must still get
    a success response (the money already moved) — not a 500 that implies
    the claim failed when it actually didn't."""
    wallet = _Wallet()
    db, router = _build(wallet)
    _seed_trophy(db)
    _patch_metrics(monkeypatch, 100)
    student = _Student("stu_finn")

    claims_coll = db["achievement_claims"]
    real_update_one = claims_coll.update_one

    async def failing_update_one(q, up, upsert=False):
        raise RuntimeError("simulated transient mongo error")

    claims_coll.update_one = failing_update_one

    res = _call(router, "POST", "/achievements/claim", payload={"trophy_id": "tier1"}, student=student)
    assert res["ok"] is True
    assert res["points"] == 50
    assert wallet.calls == 1  # credited exactly once despite the finalize failure

    # Restore the real update_one and confirm the claim doc is still
    # present (stuck at "pending" — the documented, logged residual state)
    # and, crucially, that the unique index still blocks a second credit.
    claims_coll.update_one = real_update_one
    with pytest.raises(Exception) as exc_info:
        _call(router, "POST", "/achievements/claim", payload={"trophy_id": "tier1"}, student=student)
    assert getattr(exc_info.value, "status_code", None) == 409
    assert wallet.calls == 1  # never double-credited
