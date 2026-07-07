"""tests/test_edutalk_coupon_tools.py
==========================================
Checkpoint 1 backend foundation tests for EduTalk Live Voice Coach coupon
redemption (edutalk_coupon_tools.py). Self-contained in-memory fake Mongo
(supports $ne/$lt on dotted array-subdocument fields and $[identifier]
positional array_filters updates) — no real Mongo, no network, no live GAS
call anywhere (the treasury-credit HTTP call is monkeypatched throughout).
"""
from __future__ import annotations

import copy
import inspect
import re

import pytest
from fastapi import APIRouter, FastAPI, HTTPException
from fastapi.testclient import TestClient

import edutalk_coupon_tools as ect


# ── self-contained fake Mongo ────────────────────────────────────────────────
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
        if upsert:
            base = {}
            for k, v in q.items():
                if "." not in k and not isinstance(v, dict):
                    base[k] = v
            _apply(base, update, array_filters=array_filters)
            self.docs[base.get("code", str(len(self.docs)))] = base


class _DB:
    def __init__(self):
        self._c: dict[str, _Coll] = {}

    def __getitem__(self, name):
        return self._c.setdefault(name, _Coll())

    def __getattr__(self, name):
        return self[name]


def _seed_coupon(db, **overrides):
    doc = {
        "code": "EDUTALK20", "type": "fixed", "value": 1,
        "benefit_type": "edutalk_points", "benefit_amount": 20,
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
    ect.register_edutalk_coupon_routes(api, db, _admin_dep, _student_dep(student_id))
    app.include_router(api)
    return TestClient(app)


@pytest.fixture(autouse=True)
def _enable(monkeypatch):
    monkeypatch.setenv("EDUTALK_COUPON_REDEMPTION_ENABLED", "true")


@pytest.fixture(autouse=True)
def _default_credit_succeeds(monkeypatch):
    async def ok(student_clean_id, amount):
        return True, ""
    monkeypatch.setattr(ect, "_credit_edutalk_points", ok)


def _redeem(client, code, **extra):
    return client.post("/api/student/edutalk-live/coupon/redeem", json={"code": code, **extra})


def _validate(client, code, **extra):
    return client.post("/api/student/edutalk-live/coupon/validate", json={"code": code, **extra})


# ── 1. flag gating ───────────────────────────────────────────────────────────
def test_flag_default_false_disables_both_routes(monkeypatch):
    monkeypatch.setenv("EDUTALK_COUPON_REDEMPTION_ENABLED", "false")
    db = _DB()
    _seed_coupon(db)
    client = _make_client(db)
    assert _validate(client, "EDUTALK20").status_code == 503
    assert _redeem(client, "EDUTALK20").status_code == 503


def test_config_field_wired_structurally():
    import edutalk_live_tools as elt
    src = inspect.getsource(elt)
    assert '"couponRedemptionEnabled"' in src
    assert "EDUTALK_COUPON_REDEMPTION_ENABLED" in src


# ── 2. valid preview / basic validation ─────────────────────────────────────
def test_valid_coupon_preview():
    db = _DB()
    _seed_coupon(db)
    client = _make_client(db)
    r = _validate(client, "edutalk20")  # lowercase — normalization
    body = r.json()
    assert body["ok"] is True
    assert body["state"] == "valid"
    assert body["benefit_amount"] == 20


def test_invalid_code():
    db = _DB()
    client = _make_client(db)
    r = _validate(client, "NOSUCHCODE")
    body = r.json()
    assert body["ok"] is False
    assert "check it" in body["message"].lower()


def test_expired_code():
    db = _DB()
    _seed_coupon(db, expires_at="2000-01-01T00:00:00+00:00")
    client = _make_client(db)
    body = _validate(client, "EDUTALK20").json()
    assert body["state"] == "expired"
    assert "expired" in body["message"].lower()


def test_disabled_code():
    db = _DB()
    _seed_coupon(db, enabled=False)
    client = _make_client(db)
    body = _validate(client, "EDUTALK20").json()
    assert body["state"] == "disabled"


def test_wrong_benefit_type_rejected():
    db = _DB()
    _seed_coupon(db, benefit_type="book_discount")
    client = _make_client(db)
    body = _validate(client, "EDUTALK20").json()
    assert body["ok"] is False
    assert body["state"] == "wrong_benefit_type"


def test_missing_benefit_amount_rejected():
    db = _DB()
    _seed_coupon(db, benefit_amount=None)
    client = _make_client(db)
    body = _validate(client, "EDUTALK20").json()
    assert body["state"] == "invalid_benefit_amount"


@pytest.mark.parametrize("bad", [-5, 0, 1.5, "20", True])
def test_negative_zero_noninteger_benefit_rejected(bad):
    db = _DB()
    _seed_coupon(db, benefit_amount=bad)
    client = _make_client(db)
    body = _validate(client, "EDUTALK20").json()
    assert body["state"] == "invalid_benefit_amount"


def test_assigned_to_restriction():
    db = _DB()
    _seed_coupon(db, assigned_to=["someone-else"])
    client = _make_client(db, student_id="stu1")
    body = _validate(client, "EDUTALK20").json()
    assert body["state"] == "not_assigned"


def test_assigned_to_allows_the_assigned_student():
    db = _DB()
    _seed_coupon(db, assigned_to=["stu1"])
    client = _make_client(db, student_id="stu1")
    body = _validate(client, "EDUTALK20").json()
    assert body["state"] == "valid"


# ── 2b. assigned_to normalization — case/whitespace mismatch protection ─────
def test_assigned_to_matches_despite_case_and_whitespace_mismatch():
    """A Live Voice Coach Coupon's assigned_to is free-typed by an admin
    (CouponStudio's CSV field has no normalization). Without normalized
    comparison, "  STU1 " stored vs a clean_id of "stu1" would silently
    reject with not_assigned — this proves the fix."""
    db = _DB()
    _seed_coupon(db, assigned_to=["  STU1 "])
    client = _make_client(db, student_id="stu1")
    body = _validate(client, "EDUTALK20").json()
    assert body["state"] == "valid"


def test_assigned_to_still_rejects_a_genuinely_different_student():
    db = _DB()
    _seed_coupon(db, assigned_to=["STU2"])
    client = _make_client(db, student_id="stu1")
    body = _validate(client, "EDUTALK20").json()
    assert body["state"] == "not_assigned"


# ── 2c. safe server-log-only diagnostics ────────────────────────────────────
def test_rejection_reason_is_logged_server_side_but_not_in_client_response(caplog):
    import logging
    db = _DB()
    _seed_coupon(db, assigned_to=["someone-else"])
    client = _make_client(db, student_id="stu1")
    with caplog.at_level(logging.INFO, logger="eduhub.edutalk_coupon"):
        body = _validate(client, "EDUTALK20").json()
    assert body["state"] == "not_assigned"
    assert "not_assigned" not in body["message"]  # client message stays generic
    assert any("reason=not_assigned" in r.message for r in caplog.records)


def test_redeem_rejection_reason_is_also_logged(caplog):
    import logging
    db = _DB()
    _seed_coupon(db, enabled=False)
    client = _make_client(db, student_id="stu1")
    with caplog.at_level(logging.INFO, logger="eduhub.edutalk_coupon"):
        body = _redeem(client, "EDUTALK20").json()
    assert body["state"] == "disabled"
    assert any("reason=disabled" in r.message for r in caplog.records)


# ── 3. redeem: happy path + credit + ledger ─────────────────────────────────
def test_successful_redeem_sets_credited_and_records_ledger():
    db = _DB()
    _seed_coupon(db)
    client = _make_client(db)
    r = _redeem(client, "EDUTALK20")
    body = r.json()
    assert body["ok"] is True
    assert body["state"] == "credited"
    assert body["benefit_amount"] == 20
    stored = db["coupons"].docs["EDUTALK20"]
    assert stored["uses_count"] == 1
    entry = stored["redemptions"][0]
    assert entry["student_id"] == "stu1"
    assert entry["status"] == "credited"
    assert entry["benefit_amount"] == 20
    assert entry["credited_at"]


def test_no_benefit_applied_on_invalid_code(monkeypatch):
    called = {"n": 0}
    async def spy(student_clean_id, amount):
        called["n"] += 1
        return True, ""
    monkeypatch.setattr(ect, "_credit_edutalk_points", spy)
    db = _DB()
    client = _make_client(db)
    _redeem(client, "NOSUCHCODE")
    assert called["n"] == 0


def test_no_benefit_applied_on_expired_code(monkeypatch):
    called = {"n": 0}
    async def spy(student_clean_id, amount):
        called["n"] += 1
        return True, ""
    monkeypatch.setattr(ect, "_credit_edutalk_points", spy)
    db = _DB()
    _seed_coupon(db, expires_at="2000-01-01T00:00:00+00:00")
    client = _make_client(db)
    _redeem(client, "EDUTALK20")
    assert called["n"] == 0


# ── 4. limits ────────────────────────────────────────────────────────────────
def test_global_max_uses_limit():
    db = _DB()
    _seed_coupon(db, max_uses=1, uses_count=1)
    client = _make_client(db)
    body = _redeem(client, "EDUTALK20").json()
    assert body["ok"] is False
    assert body["state"] == "limit_reached"


def test_per_student_redemption_guard_second_student_blocked_by_global_limit():
    db = _DB()
    _seed_coupon(db, max_uses=1)
    client_a = _make_client(db, student_id="stu-a")
    client_b = _make_client(db, student_id="stu-b")
    assert _redeem(client_a, "EDUTALK20").json()["ok"] is True
    body_b = _redeem(client_b, "EDUTALK20").json()
    assert body_b["ok"] is False
    assert body_b["state"] == "limit_reached"


# ── 5. concurrency: only one reservation is ever created ──────────────────
def test_concurrent_double_redeem_only_one_reservation_created():
    db = _DB()
    _seed_coupon(db)
    client = _make_client(db)
    r1 = _redeem(client, "EDUTALK20").json()
    r2 = _redeem(client, "EDUTALK20").json()  # "double click"
    assert r1["ok"] is True and r2["ok"] is True
    stored = db["coupons"].docs["EDUTALK20"]
    assert len(stored["redemptions"]) == 1          # never a second reservation
    assert stored["uses_count"] == 1                 # never double-incremented
    assert r1["credited_at"] == r2["credited_at"]    # same receipt returned


# ── 6. idempotent retry after success ───────────────────────────────────────
def test_idempotent_retry_after_success_returns_same_receipt(monkeypatch):
    calls = {"n": 0}
    async def counting_credit(student_clean_id, amount):
        calls["n"] += 1
        return True, ""
    monkeypatch.setattr(ect, "_credit_edutalk_points", counting_credit)
    db = _DB()
    _seed_coupon(db)
    client = _make_client(db)
    first = _redeem(client, "EDUTALK20").json()
    second = _redeem(client, "EDUTALK20").json()
    assert first["state"] == "credited" and second["state"] == "credited"
    assert first["credited_at"] == second["credited_at"]
    assert calls["n"] == 1  # credit is NEVER re-attempted once status == credited


def test_validate_reports_already_credited_state():
    db = _DB()
    _seed_coupon(db)
    client = _make_client(db)
    _redeem(client, "EDUTALK20")
    body = _validate(client, "EDUTALK20").json()
    assert body["state"] == "already_credited"


# ── 7. credit failure never permanently burns the code ─────────────────────
def test_credit_failure_does_not_burn_code_and_message_is_friendly(monkeypatch):
    async def failing_credit(student_clean_id, amount):
        return False, "gas_http_500"
    monkeypatch.setattr(ect, "_credit_edutalk_points", failing_credit)
    db = _DB()
    _seed_coupon(db)
    client = _make_client(db)
    r = _redeem(client, "EDUTALK20")
    body = r.json()
    assert body["ok"] is False
    assert body["state"] == "credit_failed"
    assert "try again" in body["message"].lower()
    assert "gas_http_500" not in body["message"]  # never a raw backend reason
    stored = db["coupons"].docs["EDUTALK20"]
    assert stored["uses_count"] == 1                       # reservation still holds the slot
    entry = stored["redemptions"][0]
    assert entry["status"] == "credit_failed"
    assert entry["credit_error"] == "gas_http_500"          # sanitized reason stored locally for admins


def test_retry_after_credit_failure_retries_only_the_credit_step(monkeypatch):
    attempts = {"n": 0}
    async def flaky_credit(student_clean_id, amount):
        attempts["n"] += 1
        if attempts["n"] == 1:
            return False, "gas_http_500"
        return True, ""
    monkeypatch.setattr(ect, "_credit_edutalk_points", flaky_credit)
    db = _DB()
    _seed_coupon(db)
    client = _make_client(db)
    first = _redeem(client, "EDUTALK20").json()
    assert first["state"] == "credit_failed"
    second = _redeem(client, "EDUTALK20").json()
    assert second["state"] == "credited"
    stored = db["coupons"].docs["EDUTALK20"]
    assert len(stored["redemptions"]) == 1     # retry never pushed a second entry
    assert stored["uses_count"] == 1            # retry never re-consumed a use
    assert attempts["n"] == 2


# ── 8. sanitized errors / no internal exposure ──────────────────────────────
def test_response_never_exposes_internal_fields():
    db = _DB()
    _seed_coupon(db)
    client = _make_client(db)
    body = _redeem(client, "EDUTALK20").json()
    assert "created_by" not in body
    assert "_id" not in body
    assert "redemptions" not in body


# ── 9. code normalization ───────────────────────────────────────────────────
def test_code_normalization_trims_and_uppercases():
    db = _DB()
    _seed_coupon(db)
    client = _make_client(db)
    body = _validate(client, "  edutalk20  ").json()
    assert body["state"] == "valid"


def test_unsafe_characters_rejected():
    db = _DB()
    _seed_coupon(db)
    client = _make_client(db)
    body = _validate(client, "EDUTALK20; DROP TABLE").json()
    assert body["ok"] is False
