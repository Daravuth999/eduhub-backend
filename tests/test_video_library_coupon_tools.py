"""tests/test_video_library_coupon_tools.py
==============================================
Backend tests for Video Library coupon/voucher redemption
(video_library_coupon_tools.py). Self-contained in-memory fake Mongo (same
convention as test_edutalk_coupon_tools.py) — no real Mongo, no network, no
live GAS call anywhere (the treasury-credit HTTP call is monkeypatched).
"""
from __future__ import annotations

import copy
import re

import pytest
from fastapi import APIRouter, FastAPI
from fastapi.testclient import TestClient

import video_library_coupon_tools as vlc


# ── self-contained fake Mongo (same shape as test_edutalk_coupon_tools.py) ──
def _cmp(actual, cond):
    if isinstance(cond, dict):
        for op, v in cond.items():
            if op == "$ne":
                if actual == v:
                    return False
            elif op == "$lt":
                if not (actual is not None and actual < v):
                    return False
            else:
                return False
        return True
    return actual == cond


def _match_field(doc, key, cond):
    if "." in key:
        top, rest = key.split(".", 1)
        val = doc.get(top)
        if isinstance(val, list):
            if isinstance(cond, dict) and "$ne" in cond:
                target = cond["$ne"]
                return not any(isinstance(it, dict) and it.get(rest) == target for it in val)
            return any(isinstance(it, dict) and it.get(rest) == cond for it in val)
        return _cmp(val, cond)
    return _cmp(doc.get(key), cond)


def _match(doc, query):
    return all(_match_field(doc, k, v) for k, v in query.items())


_POSITIONAL_RE = re.compile(r"^([^.]+)\.\$\[([^\]]+)\]\.(.+)$")


def _apply(doc, update, array_filters=None):
    if "$push" in update:
        for k, v in update["$push"].items():
            doc.setdefault(k, []).append(copy.deepcopy(v))
    if "$inc" in update:
        for k, v in update["$inc"].items():
            _apply_path(doc, k, v, array_filters, "inc")
    if "$set" in update:
        for k, v in update["$set"].items():
            _apply_path(doc, k, v, array_filters, "set")


def _apply_path(doc, path, value, array_filters, op):
    m = _POSITIONAL_RE.match(path)
    if not m:
        doc[path] = value if op == "set" else (doc.get(path) or 0) + value
        return
    array_name, ident, subfield = m.groups()
    conditions = {}
    for af in (array_filters or []):
        for k, v in af.items():
            if k.startswith(ident + "."):
                conditions[k.split(".", 1)[1]] = v
    for item in (doc.get(array_name) or []):
        if all(item.get(ck) == cv for ck, cv in conditions.items()):
            if op == "set":
                item[subfield] = value
            else:
                item[subfield] = (item.get(subfield) or 0) + value


class _Coll:
    def __init__(self):
        self.docs: dict[str, dict] = {}

    async def find_one(self, q, projection=None):
        for d in self.docs.values():
            if _match(d, q):
                return copy.deepcopy(d)
        return None

    async def find_one_and_update(self, q, update, upsert=False, return_document=None):
        for d in self.docs.values():
            if _match(d, q):
                before = copy.deepcopy(d)
                _apply(d, update)
                return before
        return None

    async def update_one(self, q, update, upsert=False, array_filters=None):
        for d in self.docs.values():
            if _match(d, q):
                _apply(d, update, array_filters=array_filters)
                return


class _DB:
    def __init__(self):
        self._c: dict[str, _Coll] = {}

    def __getitem__(self, name):
        return self._c.setdefault(name, _Coll())

    def __getattr__(self, name):
        return self[name]


def _seed_coupon(db, **overrides):
    doc = {
        "code": "VIDLIB20", "type": "fixed", "value": 1,
        "benefit_type": vlc.BENEFIT_TYPE, "benefit_amount": 20,
        "max_uses": None, "uses_count": 0,
        "assigned_to": [], "book_slugs": [],
        "valid_from": None, "expires_at": None,
        "enabled": True, "redemptions": [],
    }
    doc.update(overrides)
    db["coupons"].docs[doc["code"]] = doc
    return doc


class _Student:
    def __init__(self, clean_id):
        self.clean_id = clean_id


async def _admin_dep():
    return {"email": "admin@test"}


def _student_dep(student_id="stu1"):
    async def dep():
        return _Student(student_id)
    return dep


def _make_client(db, student_id="stu1"):
    app = FastAPI()
    api = APIRouter(prefix="/api")
    vlc.register_video_library_coupon_routes(api, db, _admin_dep, _student_dep(student_id))
    app.include_router(api)
    return TestClient(app)


@pytest.fixture(autouse=True)
def _enable(monkeypatch):
    monkeypatch.setenv("VIDEO_LIBRARY_COUPON_REDEMPTION_ENABLED", "true")


@pytest.fixture(autouse=True)
def _default_credit_succeeds(monkeypatch):
    async def ok(student_clean_id, amount):
        return True, ""
    monkeypatch.setattr(vlc, "_credit_video_library_points", ok)


def _redeem(client, code, **extra):
    return client.post("/api/student/video-library/coupon/redeem", json={"code": code, **extra})


def _validate(client, code, **extra):
    return client.post("/api/student/video-library/coupon/validate", json={"code": code, **extra})


def _status(client):
    return client.get("/api/student/video-library/coupon/status")


# ── flag gating + status route ──────────────────────────────────────────────
def test_flag_default_false_disables_validate_and_redeem(monkeypatch):
    monkeypatch.setenv("VIDEO_LIBRARY_COUPON_REDEMPTION_ENABLED", "false")
    db = _DB()
    _seed_coupon(db)
    client = _make_client(db)
    assert _validate(client, "VIDLIB20").status_code == 503
    assert _redeem(client, "VIDLIB20").status_code == 503


def test_status_route_reflects_the_flag(monkeypatch):
    db = _DB()
    client = _make_client(db)
    assert _status(client).json() == {"enabled": True}
    monkeypatch.setenv("VIDEO_LIBRARY_COUPON_REDEMPTION_ENABLED", "false")
    assert _status(client).json() == {"enabled": False}


# ── isolation from other coupon types ───────────────────────────────────────
def test_wrong_benefit_type_rejected_with_specific_message():
    db = _DB()
    _seed_coupon(db, benefit_type="edutalk_points")  # a real coupon, wrong product
    client = _make_client(db)
    body = _validate(client, "VIDLIB20").json()
    assert body["state"] == "wrong_benefit_type"
    assert "not a video library voucher" in body["message"].lower()


def test_book_discount_coupon_never_usable_here():
    db = _DB()
    _seed_coupon(db, benefit_type="book_discount", benefit_amount=None)
    client = _make_client(db)
    body = _validate(client, "VIDLIB20").json()
    assert body["state"] == "wrong_benefit_type"


# ── basic validation states ─────────────────────────────────────────────────
def test_valid_coupon_preview_with_lowercase_input_normalization():
    db = _DB()
    _seed_coupon(db)
    client = _make_client(db)
    body = _validate(client, "vidlib20").json()
    assert body["ok"] is True
    assert body["state"] == "valid"
    assert body["benefit_amount"] == 20


def test_invalid_code_generic_message():
    db = _DB()
    client = _make_client(db)
    body = _validate(client, "NOSUCHCODE").json()
    assert body["ok"] is False
    assert "check it" in body["message"].lower()


def test_expired_code():
    db = _DB()
    _seed_coupon(db, expires_at="2000-01-01T00:00:00+00:00")
    client = _make_client(db)
    body = _validate(client, "VIDLIB20").json()
    assert body["state"] == "expired"


def test_disabled_code_message_distinct_from_already_redeemed():
    db = _DB()
    _seed_coupon(db, enabled=False)
    client = _make_client(db)
    body = _validate(client, "VIDLIB20").json()
    assert body["state"] == "disabled"
    assert "already" not in body["message"].lower()


def test_assigned_to_restriction_and_normalization():
    db = _DB()
    _seed_coupon(db, assigned_to=["  STU1 "])  # case + whitespace mismatch
    client = _make_client(db, student_id="stu1")
    body = _validate(client, "VIDLIB20").json()
    assert body["state"] == "valid"

    db2 = _DB()
    _seed_coupon(db2, assigned_to=["someone-else"])
    client2 = _make_client(db2, student_id="stu1")
    body2 = _validate(client2, "VIDLIB20").json()
    assert body2["state"] == "not_assigned"


# ── redeem happy path + real credit into the SHARED GAS points balance ─────
def test_successful_redeem_credits_points_and_records_ledger():
    db = _DB()
    _seed_coupon(db)
    client = _make_client(db)
    body = _redeem(client, "VIDLIB20").json()
    assert body["ok"] is True
    assert body["state"] == "credited"
    assert body["benefit_amount"] == 20
    stored = db["coupons"].docs["VIDLIB20"]
    assert stored["uses_count"] == 1
    entry = stored["redemptions"][0]
    assert entry["student_id"] == "stu1"
    assert entry["benefit_type"] == vlc.BENEFIT_TYPE
    assert entry["status"] == "credited"


def test_no_credit_call_on_invalid_code(monkeypatch):
    called = {"n": 0}
    async def spy(student_clean_id, amount):
        called["n"] += 1
        return True, ""
    monkeypatch.setattr(vlc, "_credit_video_library_points", spy)
    db = _DB()
    client = _make_client(db)
    _redeem(client, "NOSUCHCODE")
    assert called["n"] == 0


# ── limits ───────────────────────────────────────────────────────────────────
def test_global_max_uses_limit():
    db = _DB()
    _seed_coupon(db, max_uses=1, uses_count=1)
    client = _make_client(db)
    body = _redeem(client, "VIDLIB20").json()
    assert body["ok"] is False
    assert body["state"] == "global_limit_reached"


# ── concurrency: only one reservation is ever created ──────────────────────
def test_concurrent_double_redeem_only_one_reservation_created():
    db = _DB()
    _seed_coupon(db)
    client = _make_client(db)
    r1 = _redeem(client, "VIDLIB20").json()
    r2 = _redeem(client, "VIDLIB20").json()
    assert r1["ok"] is True and r2["ok"] is True
    stored = db["coupons"].docs["VIDLIB20"]
    assert len(stored["redemptions"]) == 1
    assert stored["uses_count"] == 1
    assert r1["credited_at"] == r2["credited_at"]


# ── idempotent retry ─────────────────────────────────────────────────────────
def test_idempotent_retry_after_success_never_recredits(monkeypatch):
    calls = {"n": 0}
    async def counting_credit(student_clean_id, amount):
        calls["n"] += 1
        return True, ""
    monkeypatch.setattr(vlc, "_credit_video_library_points", counting_credit)
    db = _DB()
    _seed_coupon(db)
    client = _make_client(db)
    first = _redeem(client, "VIDLIB20").json()
    second = _redeem(client, "VIDLIB20").json()
    assert first["credited_at"] == second["credited_at"]
    assert calls["n"] == 1


def test_validate_reports_already_redeemed_state():
    db = _DB()
    _seed_coupon(db)
    client = _make_client(db)
    _redeem(client, "VIDLIB20")
    body = _validate(client, "VIDLIB20").json()
    assert body["state"] == "already_redeemed"


# ── credit failure never permanently burns the code ─────────────────────────
def test_credit_failure_does_not_burn_code_and_message_is_friendly(monkeypatch):
    async def failing_credit(student_clean_id, amount):
        return False, "gas_http_500"
    monkeypatch.setattr(vlc, "_credit_video_library_points", failing_credit)
    db = _DB()
    _seed_coupon(db)
    client = _make_client(db)
    body = _redeem(client, "VIDLIB20").json()
    assert body["ok"] is False
    assert body["state"] == "credit_failed"
    assert "gas_http_500" not in body["message"]
    stored = db["coupons"].docs["VIDLIB20"]
    assert stored["uses_count"] == 1  # slot still reserved, retryable
    assert stored["redemptions"][0]["status"] == "credit_failed"


def test_retry_after_credit_failure_retries_only_the_credit_step(monkeypatch):
    attempts = {"n": 0}
    async def flaky_credit(student_clean_id, amount):
        attempts["n"] += 1
        if attempts["n"] == 1:
            return False, "gas_http_500"
        return True, ""
    monkeypatch.setattr(vlc, "_credit_video_library_points", flaky_credit)
    db = _DB()
    _seed_coupon(db)
    client = _make_client(db)
    first = _redeem(client, "VIDLIB20").json()
    assert first["state"] == "credit_failed"
    second = _redeem(client, "VIDLIB20").json()
    assert second["state"] == "credited"
    stored = db["coupons"].docs["VIDLIB20"]
    assert len(stored["redemptions"]) == 1
    assert stored["uses_count"] == 1


# ── no internal exposure ─────────────────────────────────────────────────────
def test_response_never_exposes_internal_fields():
    db = _DB()
    _seed_coupon(db)
    client = _make_client(db)
    body = _redeem(client, "VIDLIB20").json()
    assert "created_by" not in body
    assert "_id" not in body
    assert "redemptions" not in body


# ── code normalization ───────────────────────────────────────────────────────
def test_code_normalization_trims_and_uppercases():
    db = _DB()
    _seed_coupon(db)
    client = _make_client(db)
    body = _validate(client, "  vidlib20  ").json()
    assert body["state"] == "valid"


def test_unsafe_characters_rejected():
    db = _DB()
    _seed_coupon(db)
    client = _make_client(db)
    body = _validate(client, "VIDLIB20; DROP TABLE").json()
    assert body["ok"] is False


# ── server.py wiring (structural — reads source text directly, matching
#    this codebase's existing convention (e.g. test_wallet_migration_
#    backfill.py) for asserting on server.py without importing it, which
#    would require live env vars like MONGO_URL at module load time) ───────
def test_server_wires_registration_call_site_structurally():
    with open("server.py", encoding="utf-8") as f:
        src = f.read()
    assert "from video_library_coupon_tools import register_video_library_coupon_routes" in src
    assert "register_video_library_coupon_routes(api, db, require_admin, require_student)" in src
