"""tests/test_coupon_schema_backward_compat.py
=====================================================
Proves the additive benefit_type/benefit_amount schema extension in
server.py's create_coupon()/update_coupon() is strictly backward-compatible
with existing book-discount coupons, per the Checkpoint 1 authorization's
requirement: "unless a test proves the change is strictly backward-compatible".

server.py cannot be imported directly in this test environment (missing
pywebpush/MONGO_URL — a pre-existing constraint, confirmed by
`python -c "import server"` raising ModuleNotFoundError('pywebpush')).
Following the SAME verification approach already used elsewhere in this
codebase's test suite for isolated server.py route logic: the exact function
source is extracted (stable boundary markers — the next route's decorator)
and executed in a controlled namespace with fakes for its few free
variables (db, admin, HTTPException, datetime/timezone, log,
_generate_coupon_code). This exercises the REAL current server.py code,
not a re-implementation of it.
"""
from __future__ import annotations

import asyncio
import re
from datetime import datetime, timezone
from pathlib import Path

import pytest
from fastapi import HTTPException

SERVER_SRC = (Path(__file__).resolve().parent.parent / "server.py").read_text(encoding="utf-8")


def run(coro):
    return asyncio.run(coro)


def _extract(src: str, start_marker: str, end_marker: str) -> str:
    start = src.index(start_marker)
    end = src.index(end_marker, start)
    return src[start:end]


class _FakeAdmin:
    email = "admin@test"


class _FakeUpdateResult:
    def __init__(self, matched):
        self.matched_count = matched


class _FakeCoupons:
    def __init__(self):
        self.docs: dict[str, dict] = {}

    async def find_one(self, q):
        return self.docs.get(q.get("code"))

    async def insert_one(self, doc):
        self.docs[doc["code"]] = dict(doc)

    async def update_one(self, q, update):
        code = q.get("code")
        doc = self.docs.get(code)
        if doc is None:
            return _FakeUpdateResult(0)
        doc.update(update.get("$set") or {})
        return _FakeUpdateResult(1)


class _FakeDB:
    def __init__(self):
        self.coupons = _FakeCoupons()


class _FakeLog:
    def info(self, *a, **k):
        pass


def _load_create_coupon():
    src = _extract(SERVER_SRC, "async def create_coupon(", '@api.get("/coupons")')
    ns = {
        "HTTPException": HTTPException, "datetime": datetime, "timezone": timezone,
        "db": _FakeDB(), "log": _FakeLog(),
        "_generate_coupon_code": lambda: "AUTOGEN01",
        "Depends": lambda f: None, "require_admin": None, "User": object,
    }
    exec(compile(src, "server.py(create_coupon)", "exec"), ns)  # noqa: S102
    return ns["create_coupon"], ns["db"]


def _load_update_coupon(shared_db=None):
    src = _extract(SERVER_SRC, "async def update_coupon(", '@api.delete("/coupons/{code}")')
    ns = {
        "HTTPException": HTTPException, "db": shared_db or _FakeDB(), "log": _FakeLog(),
        "Depends": lambda f: None, "require_admin": None, "User": object,
    }
    exec(compile(src, "server.py(update_coupon)", "exec"), ns)  # noqa: S102
    return ns["update_coupon"], ns["db"]


# ── create_coupon: old-style (pre-existing) payload is untouched ──────────
def test_old_style_book_discount_payload_produces_identical_doc_shape():
    create_coupon, db = _load_create_coupon()
    old_payload = {"code": "SAVE20", "type": "percent", "value": 20, "max_uses": 5}
    result = run(create_coupon(old_payload, admin=_FakeAdmin()))
    doc = result["coupon"]
    # Every original field present with its original meaning, unchanged.
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
    create_coupon, _ = _load_create_coupon()
    with pytest.raises(HTTPException) as exc:
        run(create_coupon({"code": "BAD", "type": "invalid_type", "value": 10}, admin=_FakeAdmin()))
    assert exc.value.status_code == 400
    with pytest.raises(HTTPException):
        run(create_coupon({"code": "BAD2", "type": "percent", "value": 0}, admin=_FakeAdmin()))
    with pytest.raises(HTTPException):
        run(create_coupon({"code": "BAD3", "type": "percent", "value": 150}, admin=_FakeAdmin()))


def test_edutalk_points_coupon_creation_validates_benefit_amount_strictly():
    create_coupon, _ = _load_create_coupon()
    with pytest.raises(HTTPException):
        run(create_coupon({
            "code": "ET20", "type": "fixed", "value": 1,
            "benefit_type": "edutalk_points", "benefit_amount": -5,
        }, admin=_FakeAdmin()))
    with pytest.raises(HTTPException):
        run(create_coupon({
            "code": "ET20", "type": "fixed", "value": 1,
            "benefit_type": "edutalk_points", "benefit_amount": "20",
        }, admin=_FakeAdmin()))
    result = run(create_coupon({
        "code": "ET20", "type": "fixed", "value": 1,
        "benefit_type": "edutalk_points", "benefit_amount": 20,
    }, admin=_FakeAdmin()))
    assert result["coupon"]["benefit_type"] == "edutalk_points"
    assert result["coupon"]["benefit_amount"] == 20


def test_unknown_benefit_type_rejected_at_creation():
    create_coupon, _ = _load_create_coupon()
    with pytest.raises(HTTPException):
        run(create_coupon({"code": "X", "type": "fixed", "value": 1, "benefit_type": "free_lunch"},
                           admin=_FakeAdmin()))


# ── update_coupon: old fields still updatable exactly as before ───────────
def test_old_style_update_fields_still_work():
    db = _FakeDB()
    run(db.coupons.insert_one({"code": "SAVE20", "type": "percent", "value": 20,
                                "benefit_type": "book_discount", "benefit_amount": None}))
    update_coupon, _ = _load_update_coupon(shared_db=db)
    result = run(update_coupon("SAVE20", {"enabled": False, "max_uses": 10}, admin=_FakeAdmin()))
    assert result["ok"] is True
    assert db.coupons.docs["SAVE20"]["enabled"] is False
    assert db.coupons.docs["SAVE20"]["max_uses"] == 10
    # benefit_type/benefit_amount untouched by an update that never mentions them.
    assert db.coupons.docs["SAVE20"]["benefit_type"] == "book_discount"


def test_update_rejects_invalid_benefit_amount_when_switching_to_edutalk_points():
    db = _FakeDB()
    run(db.coupons.insert_one({"code": "SAVE20", "benefit_type": "book_discount", "benefit_amount": None}))
    update_coupon, _ = _load_update_coupon(shared_db=db)
    with pytest.raises(HTTPException):
        run(update_coupon("SAVE20", {"benefit_type": "edutalk_points", "benefit_amount": 0}, admin=_FakeAdmin()))
