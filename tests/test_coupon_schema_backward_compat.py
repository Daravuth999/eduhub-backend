"""tests/test_coupon_schema_backward_compat.py
=====================================================
Proves the additive benefit_type/benefit_amount schema extension in
coupon_tools.py's create_coupon()/update_coupon() is strictly
backward-compatible with existing book-discount coupons, per the
Checkpoint 1 authorization's requirement: "unless a test proves the change
is strictly backward-compatible".

Architecture Reconstruction Phase 1f: coupon_tools.py's routes used to live
inline in server.py and were exercised here by slicing raw source text out
of server.py and exec()'ing it in a fake namespace (server.py cannot be
imported directly in this test environment — missing pywebpush/MONGO_URL).
Now that the coupon system is its own importable module (registered via
``register_coupon_routes(api, db, require_admin, User)``, matching the
register_*_routes convention established for every other Phase 1 module),
this test drives the REAL routes end-to-end through a real APIRouter +
FastAPI + TestClient — the same pattern already used by
tests/test_edutalk_coupon_tools.py for the sibling coupon-adjacent module.
"""
from __future__ import annotations

from datetime import datetime, timedelta, timezone

import pytest
from fastapi import APIRouter, FastAPI, HTTPException
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


def _create(client, payload):
    return client.post("/api/coupons", json=payload)


def _update(client, code, payload):
    return client.patch(f"/api/coupons/{code}", json=payload)


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


# ── register_coupon_routes returns _generate_coupon_code for server.py ─────
def test_register_returns_generate_coupon_code_for_cross_module_use():
    db = _FakeDB()
    app = FastAPI()
    api = APIRouter(prefix="/api")
    gen = coupon_tools.register_coupon_routes(api, db, _admin_dep, object)
    code = gen()
    assert isinstance(code, str) and len(code) == 8
    assert code.isupper() or code.isdigit() or code.isalnum()


# ── create_coupon: old-style (pre-existing) payload is untouched ──────────
def test_old_style_book_discount_payload_produces_identical_doc_shape():
    db = _FakeDB()
    client = _make_client(db)
    resp = _create(client, {"code": "SAVE20", "type": "percent", "value": 20, "max_uses": 5})
    assert resp.status_code == 200
    doc = resp.json()["coupon"]
    assert doc["code"] == "SAVE20"
    assert doc["type"] == "percent"
    assert doc["value"] == 20
    assert doc["max_uses"] == 5
    assert doc["uses_count"] == 0
    assert doc["assigned_to"] == []
    assert doc["book_slugs"] == []
    assert doc["enabled"] is True
    assert doc["redemptions"] == []
    # New fields present with safe, non-breaking defaults.
    assert doc["benefit_type"] == "book_discount"
    assert doc["benefit_amount"] is None


def test_existing_type_value_validation_still_unconditional_and_unchanged():
    db = _FakeDB()
    client = _make_client(db)
    assert _create(client, {"code": "BAD", "type": "invalid_type", "value": 10}).status_code == 400
    assert _create(client, {"code": "BAD2", "type": "percent", "value": 0}).status_code == 400
    assert _create(client, {"code": "BAD3", "type": "percent", "value": 150}).status_code == 400


def test_edutalk_points_coupon_creation_validates_benefit_amount_strictly():
    # §Checkpoint 3 stabilization: no dummy type/value needed anymore — an
    # edutalk_points coupon is created WITHOUT any type/value keys at all.
    db = _FakeDB()
    client = _make_client(db)
    assert _create(client, {
        "code": "ET20", "benefit_type": "edutalk_points", "benefit_amount": -5,
    }).status_code == 400
    assert _create(client, {
        "code": "ET20", "benefit_type": "edutalk_points", "benefit_amount": "20",
    }).status_code == 400
    resp = _create(client, {
        "code": "ET20", "benefit_type": "edutalk_points", "benefit_amount": 20,
    })
    assert resp.status_code == 200
    coupon = resp.json()["coupon"]
    assert coupon["benefit_type"] == "edutalk_points"
    assert coupon["benefit_amount"] == 20
    # §Checkpoint 3 stabilization: no dummy discount values are ever stored —
    # type/value are genuinely None, not a fake "fixed"/1 pair, so nothing
    # downstream can mistake this for a real book-discount coupon.
    assert coupon["type"] is None
    assert coupon["value"] is None


def test_unknown_benefit_type_rejected_at_creation():
    db = _FakeDB()
    client = _make_client(db)
    resp = _create(client, {"code": "X", "type": "fixed", "value": 1, "benefit_type": "free_lunch"})
    assert resp.status_code == 400


# ── assigned_to normalization: edutalk_points only, book_discount untouched ─
def test_book_discount_assigned_to_never_normalized_at_creation():
    db = _FakeDB()
    client = _make_client(db)
    resp = _create(client, {
        "code": "SAVE20", "type": "percent", "value": 20,
        "assigned_to": ["  StuMixedCase ", "OTHER"],
    })
    assert resp.json()["coupon"]["assigned_to"] == ["  StuMixedCase ", "OTHER"]


def test_edutalk_points_assigned_to_normalized_at_creation():
    db = _FakeDB()
    client = _make_client(db)
    resp = _create(client, {
        "code": "ET20", "benefit_type": "edutalk_points", "benefit_amount": 20,
        "assigned_to": ["  StuMixedCase ", "OTHER"],
    })
    assert resp.json()["coupon"]["assigned_to"] == ["stumixedcase", "other"]


# ── update_coupon: old fields still updatable exactly as before ───────────
def test_old_style_update_fields_still_work():
    db = _FakeDB()
    _seed(db)
    client = _make_client(db)
    resp = _update(client, "SAVE20", {"enabled": False, "max_uses": 10})
    assert resp.status_code == 200
    assert db.coupons.docs["SAVE20"]["enabled"] is False
    assert db.coupons.docs["SAVE20"]["max_uses"] == 10
    # benefit_type/benefit_amount untouched by an update that never mentions them.
    assert db.coupons.docs["SAVE20"]["benefit_type"] == "book_discount"


def test_update_rejects_invalid_benefit_amount_when_switching_to_edutalk_points():
    db = _FakeDB()
    _seed(db)
    client = _make_client(db)
    resp = _update(client, "SAVE20", {"benefit_type": "edutalk_points", "benefit_amount": 0})
    assert resp.status_code == 400


def test_update_normalizes_assigned_to_for_an_existing_edutalk_points_coupon():
    # benefit_type is NOT in this update payload — the effective type must be
    # read from the coupon's EXISTING benefit_type, not assumed/omitted.
    db = _FakeDB()
    _seed(db, code="ET20", benefit_type="edutalk_points", benefit_amount=20)
    client = _make_client(db)
    resp = _update(client, "ET20", {"assigned_to": ["  Foo ", "BAR"]})
    assert resp.status_code == 200
    assert db.coupons.docs["ET20"]["assigned_to"] == ["foo", "bar"]


def test_update_never_normalizes_assigned_to_for_a_book_discount_coupon():
    db = _FakeDB()
    _seed(db)
    client = _make_client(db)
    resp = _update(client, "SAVE20", {"assigned_to": ["  Foo ", "BAR"]})
    assert resp.status_code == 200
    assert db.coupons.docs["SAVE20"]["assigned_to"] == ["  Foo ", "BAR"]


# ── validate/redeem: mandatory bidirectional isolation ─────────────────────
# §Checkpoint 3 stabilization: a Live Voice Coach coupon must never be usable
# as a book discount, and this must not silently crash (the pre-fix behavior
# would have raised a raw TypeError inside _calc_discount on a None value).
def test_book_discount_coupon_still_validates_exactly_as_before():
    db = _FakeDB()
    _seed(db)
    client = _make_client(db)
    resp = client.post("/api/coupons/validate", json={
        "code": "SAVE20", "book_slug": "some-book", "original_price": 1000, "student_id": "stu1",
    })
    assert resp.status_code == 200
    body = resp.json()
    assert body["coupon_type"] == "percent" and body["coupon_value"] == 20
    assert body["discounted_price"] == 800


def test_old_coupon_missing_benefit_type_entirely_still_validates():
    db = _FakeDB()
    _seed(db, code="LEGACY", type="fixed", value=5)
    del db.coupons.docs["LEGACY"]["benefit_type"]
    del db.coupons.docs["LEGACY"]["benefit_amount"]
    client = _make_client(db)
    resp = client.post("/api/coupons/validate", json={
        "code": "LEGACY", "book_slug": "some-book", "original_price": 100, "student_id": "stu1",
    })
    assert resp.status_code == 200
    assert resp.json()["code"] == "LEGACY"


def test_edutalk_live_coupon_cannot_be_redeemed_as_a_book_discount():
    db = _FakeDB()
    _seed(db, code="ETALK1", type=None, value=None, max_uses=1,
          assigned_to=["stu1"], benefit_type="edutalk_points", benefit_amount=20)
    client = _make_client(db)
    resp = client.post("/api/coupons/redeem", json={
        "code": "ETALK1", "book_slug": "some-book", "original_price": 100, "student_id": "stu1",
    })
    # Generic 404 — never leaks that the code exists for a different purpose.
    assert resp.status_code == 404
    assert "not found" in resp.json()["detail"].lower()


# ── smoke coverage for the routes not exercised above ──────────────────────
def test_redeem_is_atomic_and_increments_uses_count():
    db = _FakeDB()
    _seed(db, max_uses=1)
    client = _make_client(db)
    resp = client.post("/api/coupons/redeem", json={
        "code": "SAVE20", "book_slug": "book-a", "original_price": 1000, "student_id": "stu1",
    })
    assert resp.status_code == 200
    assert resp.json()["discounted_price"] == 800
    assert db.coupons.docs["SAVE20"]["uses_count"] == 1
    # Second redemption exceeds max_uses=1.
    resp2 = client.post("/api/coupons/redeem", json={
        "code": "SAVE20", "book_slug": "book-b", "original_price": 1000, "student_id": "stu2",
    })
    assert resp2.status_code == 400


def test_list_get_and_delete_coupon_routes():
    db = _FakeDB()
    _seed(db)
    client = _make_client(db)
    assert client.get("/api/coupons").json()["coupons"][0]["code"] == "SAVE20"
    assert client.get("/api/coupons/SAVE20").json()["coupon"]["code"] == "SAVE20"
    assert client.delete("/api/coupons/SAVE20").status_code == 200
    assert client.get("/api/coupons/SAVE20").status_code == 404
