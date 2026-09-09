"""tests/test_coupon_redeem_scenarios.py
==============================================
P0 coupon redemption bug investigation — the reported symptom ("Couldn't
complete the purchase. You already own this book." on a fresh user's first
redemption of a 100%-off coupon) was root-caused to the FRONTEND
(purchaseService.js's purchaseBook() using a coupon-discounted price of 0
to feed its own "is this book free?" ownership shortcut — see
eduhub-studio-test's purchaseService.js / LibraryPage.jsx fix). This file
exercises the BACKEND half of the flow (/api/coupons/validate,
/api/coupons/redeem) end to end, using the same in-memory fake-Mongo
harness as test_coupon_schema_backward_compat.py, to prove — not assume —
that validation, usage limits, expiry, per-book/per-student assignment,
and duplicate-redemption protection all behave correctly and were never
the source of the bug.
"""
from __future__ import annotations

from datetime import datetime, timedelta, timezone

from fastapi import APIRouter, FastAPI
from fastapi.testclient import TestClient

import coupon_tools


class _FakeCursor:
    def __init__(self, docs):
        self._docs = docs

    def sort(self, *a, **k):
        return self

    async def to_list(self, length=None):
        return list(self._docs)


class _FakeCoupons:
    def __init__(self):
        self.docs: dict[str, dict] = {}

    async def find_one(self, query, projection=None):
        code = query.get("code")
        doc = self.docs.get(code)
        return dict(doc) if doc is not None else None

    async def insert_one(self, doc):
        self.docs[doc["code"]] = dict(doc)

    async def update_one(self, query, update):
        doc = self.docs.get(query.get("code"))
        if doc is None:
            return type("R", (), {"matched_count": 0})()
        doc.update(update.get("$set") or {})
        return type("R", (), {"matched_count": 1})()

    async def delete_one(self, query):
        code = query.get("code")
        existed = code in self.docs
        self.docs.pop(code, None)
        return type("R", (), {"deleted_count": 1 if existed else 0})()

    def find(self, query=None, projection=None):
        return _FakeCursor(list(self.docs.values()))

    async def find_one_and_update(self, query, update, return_document=True):
        code = query.get("code")
        doc = self.docs.get(code)
        if doc is None:
            return None
        max_uses_cond = query.get("uses_count")
        if isinstance(max_uses_cond, dict) and "$lt" in max_uses_cond:
            if not (doc.get("uses_count", 0) < max_uses_cond["$lt"]):
                return None
        if "$inc" in update:
            for k, v in update["$inc"].items():
                doc[k] = doc.get(k, 0) + v
        if "$push" in update:
            for k, v in update["$push"].items():
                doc.setdefault(k, []).append(v)
        return dict(doc)


class _FakeDB:
    def __init__(self):
        self.coupons = _FakeCoupons()


async def _admin_dep():
    return type("Admin", (), {"email": "admin@test"})()


def _make_client(db):
    app = FastAPI()
    api = APIRouter(prefix="/api")
    coupon_tools.register_coupon_routes(api, db, _admin_dep, object)
    app.include_router(api)
    return TestClient(app)


def _seed(db, **overrides):
    doc = {
        "code": "SAVE20", "type": "percent", "value": 20, "max_uses": None, "uses_count": 0,
        "assigned_to": [], "book_slugs": [], "valid_from": None, "expires_at": None,
        "enabled": True, "created_by": "admin@test", "created_at": datetime.now(timezone.utc).isoformat(),
        "redemptions": [], "benefit_type": "book_discount", "benefit_amount": None,
    }
    doc.update(overrides)
    db.coupons.docs[doc["code"]] = doc
    return doc


def _validate(client, **kw):
    return client.post("/api/coupons/validate", json=kw)


def _redeem(client, **kw):
    return client.post("/api/coupons/redeem", json=kw)


# ── TEST: fresh user, valid 100%-off coupon — the exact reported scenario ──
def test_fresh_user_100_percent_off_coupon_redeems_successfully():
    db = _FakeDB()
    client = _make_client(db)
    _seed(db, code="39E28D7U", type="percent", value=100)

    v = _validate(client, code="39E28D7U", book_slug="the-unexpected-opportunity", original_price=25, student_id="stu094")
    assert v.status_code == 200
    assert v.json()["discounted_price"] == 0
    assert v.json()["discount_amount"] == 25

    r = _redeem(client, code="39E28D7U", book_slug="the-unexpected-opportunity", original_price=25, student_id="stu094")
    assert r.status_code == 200
    body = r.json()
    assert body["ok"] is True
    assert body["discounted_price"] == 0
    doc = db.coupons.docs["39E28D7U"]
    assert doc["uses_count"] == 1
    assert doc["redemptions"][0]["student_id"] == "stu094"
    assert doc["redemptions"][0]["book_slug"] == "the-unexpected-opportunity"


# ── TEST: fresh user, valid partial coupon ─────────────────────────────────
def test_fresh_user_partial_discount_coupon():
    db = _FakeDB()
    client = _make_client(db)
    _seed(db, code="SAVE20", type="percent", value=20)
    r = _redeem(client, code="SAVE20", book_slug="at-the-market", original_price=30, student_id="stu001")
    assert r.status_code == 200
    assert r.json()["discounted_price"] == 24
    assert r.json()["discount_amount"] == 6


# ── TEST: invalid coupon code ───────────────────────────────────────────────
def test_invalid_coupon_code_returns_404():
    db = _FakeDB()
    client = _make_client(db)
    r = _redeem(client, code="DOESNOTEXIST", book_slug="at-the-market", original_price=30, student_id="stu001")
    assert r.status_code == 404


# ── TEST: expired coupon ────────────────────────────────────────────────────
def test_expired_coupon_is_rejected():
    db = _FakeDB()
    client = _make_client(db)
    past = (datetime.now(timezone.utc) - timedelta(days=1)).isoformat()
    _seed(db, code="OLDONE", expires_at=past)
    r = _redeem(client, code="OLDONE", book_slug="at-the-market", original_price=30, student_id="stu001")
    assert r.status_code == 400
    assert "expired" in r.json()["detail"].lower()


# ── TEST: not-yet-active coupon ─────────────────────────────────────────────
def test_not_yet_active_coupon_is_rejected():
    db = _FakeDB()
    client = _make_client(db)
    future = (datetime.now(timezone.utc) + timedelta(days=1)).isoformat()
    _seed(db, code="FUTURE1", valid_from=future)
    r = _redeem(client, code="FUTURE1", book_slug="at-the-market", original_price=30, student_id="stu001")
    assert r.status_code == 400
    assert "not yet active" in r.json()["detail"].lower()


# ── TEST: disabled coupon ───────────────────────────────────────────────────
def test_disabled_coupon_is_rejected():
    db = _FakeDB()
    client = _make_client(db)
    _seed(db, code="OFF1", enabled=False)
    r = _redeem(client, code="OFF1", book_slug="at-the-market", original_price=30, student_id="stu001")
    assert r.status_code == 400
    assert "disabled" in r.json()["detail"].lower()


# ── TEST: already-used coupon (same student, same book) ────────────────────
def test_already_used_coupon_by_same_student_same_book_is_rejected():
    db = _FakeDB()
    client = _make_client(db)
    _seed(db, code="ONCE1")
    r1 = _redeem(client, code="ONCE1", book_slug="at-the-market", original_price=30, student_id="stu001")
    assert r1.status_code == 200
    r2 = _redeem(client, code="ONCE1", book_slug="at-the-market", original_price=30, student_id="stu001")
    assert r2.status_code == 400
    assert "already used" in r2.json()["detail"].lower()
    # Only ONE redemption was ever recorded — the rejected retry never wrote.
    assert db.coupons.docs["ONCE1"]["uses_count"] == 1
    assert len(db.coupons.docs["ONCE1"]["redemptions"]) == 1


# ── TEST: same student CAN reuse a public coupon for a DIFFERENT book ──────
def test_same_coupon_can_be_used_by_same_student_for_a_different_book():
    db = _FakeDB()
    client = _make_client(db)
    _seed(db, code="MULTI1")
    r1 = _redeem(client, code="MULTI1", book_slug="book-a", original_price=30, student_id="stu001")
    r2 = _redeem(client, code="MULTI1", book_slug="book-b", original_price=40, student_id="stu001")
    assert r1.status_code == 200
    assert r2.status_code == 200
    assert db.coupons.docs["MULTI1"]["uses_count"] == 2


# ── TEST: coupon restricted to a different book ─────────────────────────────
def test_coupon_scoped_to_a_different_book_is_rejected():
    db = _FakeDB()
    client = _make_client(db)
    _seed(db, code="ONLYA", book_slugs=["book-a"])
    r = _redeem(client, code="ONLYA", book_slug="book-b", original_price=30, student_id="stu001")
    assert r.status_code == 400
    assert "cannot be used for this book" in r.json()["detail"].lower()
    # ...but the SAME coupon works for the book it IS scoped to.
    r2 = _redeem(client, code="ONLYA", book_slug="book-a", original_price=30, student_id="stu001")
    assert r2.status_code == 200


# ── TEST: coupon assigned to a specific student ─────────────────────────────
def test_coupon_assigned_to_a_specific_student_rejects_other_students():
    db = _FakeDB()
    client = _make_client(db)
    _seed(db, code="VIPONLY", assigned_to=["stu001"])
    r_wrong = _redeem(client, code="VIPONLY", book_slug="book-a", original_price=30, student_id="stu999")
    assert r_wrong.status_code == 403
    r_right = _redeem(client, code="VIPONLY", book_slug="book-a", original_price=30, student_id="stu001")
    assert r_right.status_code == 200


# ── TEST: usage limit — multiple DIFFERENT users redeeming ──────────────────
def test_multiple_users_redeeming_respects_shared_usage_limit():
    db = _FakeDB()
    client = _make_client(db)
    _seed(db, code="LIMIT2", max_uses=2)
    r1 = _redeem(client, code="LIMIT2", book_slug="book-a", original_price=30, student_id="stu001")
    r2 = _redeem(client, code="LIMIT2", book_slug="book-a", original_price=30, student_id="stu002")
    assert r1.status_code == 200
    assert r2.status_code == 200
    r3 = _redeem(client, code="LIMIT2", book_slug="book-a", original_price=30, student_id="stu003")
    assert r3.status_code == 400
    assert "usage limit" in r3.json()["detail"].lower()
    assert db.coupons.docs["LIMIT2"]["uses_count"] == 2


# ── TEST: unlimited usage (max_uses=None) never blocks on the $lt guard ────
def test_unlimited_max_uses_coupon_never_blocks_on_usage_count():
    db = _FakeDB()
    client = _make_client(db)
    _seed(db, code="UNLIMITED", max_uses=None)
    for i in range(5):
        r = _redeem(client, code="UNLIMITED", book_slug=f"book-{i}", original_price=30, student_id="stu001")
        assert r.status_code == 200
    assert db.coupons.docs["UNLIMITED"]["uses_count"] == 5


# ── TEST: validate never mutates state — safe to call repeatedly ───────────
def test_validate_never_consumes_the_coupon():
    db = _FakeDB()
    client = _make_client(db)
    _seed(db, code="PREVIEW1", max_uses=1)
    for _ in range(3):
        v = _validate(client, code="PREVIEW1", book_slug="book-a", original_price=30, student_id="stu001")
        assert v.status_code == 200
    assert db.coupons.docs["PREVIEW1"]["uses_count"] == 0
    assert db.coupons.docs["PREVIEW1"]["redemptions"] == []
    # Still fully redeemable afterward.
    r = _redeem(client, code="PREVIEW1", book_slug="book-a", original_price=30, student_id="stu001")
    assert r.status_code == 200
