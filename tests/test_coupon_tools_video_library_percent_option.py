"""tests/test_coupon_tools_video_library_percent_option.py — §1 of the
Video Library coupons round: coupon_tools.py's create_coupon/update_coupon
now accept an optional `type` ("percent" | "points") for the
video_library_points benefit_type, mirroring book_discount's own
percent-over-100 validation verbatim. Covers creation validation for both
offer types, the default ("points") backward-compat path for every coupon
that predates this field, and confirms edutalk_points (a sibling
flat-points benefit_type) is completely unaffected.

Same in-memory fake-Mongo convention as tests/test_coupon_redeem_scenarios.py.
"""
from __future__ import annotations

from datetime import datetime, timezone

from fastapi import APIRouter, FastAPI
from fastapi.testclient import TestClient

import coupon_tools


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


class _FakeDB:
    def __init__(self):
        self.coupons = _FakeCoupons()

    def __getitem__(self, name):
        return getattr(self, name)


async def _admin_dep():
    return type("Admin", (), {"email": "admin@test"})()


def _make_client(db):
    app = FastAPI()
    api = APIRouter(prefix="/api")
    coupon_tools.register_coupon_routes(api, db, _admin_dep, object)
    app.include_router(api)
    return TestClient(app)


def _create(client, **payload):
    return client.post("/api/coupons", json=payload)


# ── percent offer type ──────────────────────────────────────────────────────
def test_video_library_percent_coupon_creates_successfully():
    db = _FakeDB()
    client = _make_client(db)
    resp = _create(client, code="VLPCT20", benefit_type="video_library_points", type="percent", value=20)
    assert resp.status_code == 200
    coupon = resp.json()["coupon"]
    assert coupon["type"] == "percent"
    assert coupon["value"] == 20
    assert coupon["benefit_amount"] is None
    assert coupon["benefit_type"] == "video_library_points"


def test_video_library_percent_coupon_at_the_100_boundary_is_allowed():
    db = _FakeDB()
    client = _make_client(db)
    resp = _create(client, code="VLFREE", benefit_type="video_library_points", type="percent", value=100)
    assert resp.status_code == 200
    assert resp.json()["coupon"]["value"] == 100


def test_video_library_percent_coupon_over_100_is_rejected():
    db = _FakeDB()
    client = _make_client(db)
    resp = _create(client, code="VLBAD", benefit_type="video_library_points", type="percent", value=101)
    assert resp.status_code == 400
    assert "cannot exceed 100" in resp.json()["detail"]
    assert "VLBAD" not in db.coupons.docs


def test_video_library_percent_coupon_zero_or_negative_value_is_rejected():
    db = _FakeDB()
    client = _make_client(db)
    for bad_value in (0, -5):
        resp = _create(client, code=f"VLZERO{bad_value}", benefit_type="video_library_points",
                        type="percent", value=bad_value)
        assert resp.status_code == 400
        assert "value must be > 0" in resp.json()["detail"]


# ── points offer type (default — backward compatible) ──────────────────────
def test_video_library_coupon_with_no_type_defaults_to_points_unchanged():
    db = _FakeDB()
    client = _make_client(db)
    resp = _create(client, code="VLPTS20", benefit_type="video_library_points", benefit_amount=20)
    assert resp.status_code == 200
    coupon = resp.json()["coupon"]
    assert coupon["type"] is None  # exactly the pre-existing shape, never "points" literally
    assert coupon["value"] is None
    assert coupon["benefit_amount"] == 20


def test_video_library_coupon_explicit_points_type_behaves_identically_to_omitted():
    db = _FakeDB()
    client = _make_client(db)
    resp = _create(client, code="VLPTS2", benefit_type="video_library_points", type="points", benefit_amount=30)
    assert resp.status_code == 200
    coupon = resp.json()["coupon"]
    assert coupon["type"] is None
    assert coupon["benefit_amount"] == 30


def test_video_library_points_coupon_still_requires_valid_benefit_amount():
    db = _FakeDB()
    client = _make_client(db)
    resp = _create(client, code="VLNOAMT", benefit_type="video_library_points")
    assert resp.status_code == 400
    assert "benefit_amount" in resp.json()["detail"]


def test_video_library_coupon_invalid_type_value_is_rejected():
    db = _FakeDB()
    client = _make_client(db)
    resp = _create(client, code="VLBADTYPE", benefit_type="video_library_points", type="fixed", value=10)
    assert resp.status_code == 400
    assert "percent" in resp.json()["detail"].lower() and "points" in resp.json()["detail"].lower()


# ── sibling benefit_type (edutalk_points) completely unaffected ────────────
def test_edutalk_points_coupon_has_no_percent_option_and_is_unaffected():
    db = _FakeDB()
    client = _make_client(db)
    resp = _create(client, code="ETLC10", benefit_type="edutalk_points", type="percent", value=50, benefit_amount=10)
    assert resp.status_code == 200
    coupon = resp.json()["coupon"]
    # `type`/`value` are silently ignored for edutalk_points — it is
    # flat-points-only, exactly as before this round.
    assert coupon["type"] is None
    assert coupon["value"] is None
    assert coupon["benefit_amount"] == 10


# ── update_coupon: switching offer type ─────────────────────────────────────
def _seed_points_coupon(db, code="VLUPD"):
    doc = {
        "code": code, "type": None, "value": None,
        "max_uses": None, "uses_count": 0, "assigned_to": [], "book_slugs": [],
        "valid_from": None, "expires_at": None, "enabled": True,
        "created_by": "admin@test", "created_at": datetime.now(timezone.utc).isoformat(),
        "redemptions": [], "benefit_type": "video_library_points", "benefit_amount": 15,
        "promotion_id": None,
    }
    db.coupons.docs[code] = doc
    return doc


def test_update_coupon_can_switch_a_points_coupon_to_percent():
    db = _FakeDB()
    client = _make_client(db)
    _seed_points_coupon(db)
    resp = client.patch("/api/coupons/VLUPD", json={"type": "percent", "value": 25})
    assert resp.status_code == 200
    assert db.coupons.docs["VLUPD"]["type"] == "percent"
    assert db.coupons.docs["VLUPD"]["value"] == 25


def test_update_coupon_rejects_percent_value_over_100():
    db = _FakeDB()
    client = _make_client(db)
    _seed_points_coupon(db)
    resp = client.patch("/api/coupons/VLUPD", json={"type": "percent", "value": 150})
    assert resp.status_code == 400
    assert db.coupons.docs["VLUPD"]["type"] is None  # untouched


def test_update_coupon_switching_benefit_type_to_video_library_points_still_requires_benefit_amount():
    db = _FakeDB()
    client = _make_client(db)
    doc = {
        "code": "VLSWITCH", "type": None, "value": None,
        "max_uses": None, "uses_count": 0, "assigned_to": [], "book_slugs": [],
        "valid_from": None, "expires_at": None, "enabled": True,
        "created_by": "admin@test", "created_at": datetime.now(timezone.utc).isoformat(),
        "redemptions": [], "benefit_type": "book_discount", "benefit_amount": None,
        "promotion_id": None,
    }
    db.coupons.docs["VLSWITCH"] = doc
    resp = client.patch("/api/coupons/VLSWITCH", json={"benefit_type": "video_library_points"})
    assert resp.status_code == 400
    assert "benefit_amount" in resp.json()["detail"]
