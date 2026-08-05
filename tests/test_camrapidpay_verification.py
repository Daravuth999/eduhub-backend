"""tests/test_camrapidpay_verification.py
============================================
Production-incident regression suite (Aug 2026): automatic KHQR top-up via
CamRapidPay stopped detecting completed payments (see the incident report --
`verify_camrapidpay_payment_and_credit_once()` silently stayed "pending"
forever whenever `check_status()` didn't report Success, with zero log
trace). This file:

  1. Locks in the diagnostics fix (every non-credit outcome must now log a
     reference + normalized status + reason -- future incidents must be
     diagnosable from logs alone).
  2. Regression-tests the full detection/credit pipeline end-to-end using
     an in-memory fake Mongo collection and a monkeypatched provider layer
     (no real CamRapidPay calls, no real database) across the exact matrix
     requested for this incident: $0.50 / $1.00 amounts, duplicate webhook,
     delayed webhook, polling-only, webhook-only, expired, cancelled, and
     concurrent/simultaneous payments.
  3. Proves the pre-existing money-safety invariants (atomic single-credit
     gate, idempotent re-check, unknown-outcome -> manual_review) are
     UNCHANGED by the diagnostics-only fix.

Uses the same in-memory-fake + direct-endpoint-call style already
established by test_book_factory_routes.py / test_tuition_concurrency.py --
no real database, no real HTTP server, no real provider network calls.
"""
from __future__ import annotations

import asyncio
import logging
from datetime import datetime, timezone, timedelta
from types import SimpleNamespace

import pytest
from fastapi import APIRouter
from bson import ObjectId

import camrapidpay_payment_tools as cam_tools
import payment_providers.camrapidpay_provider as cam_provider


def run(c):
    return asyncio.run(c)


# ── In-memory fake Mongo collection ──────────────────────────────────────────
# Supports exactly the operations camrapidpay_payment_tools.py issues:
# find_one, insert_one, update_one, find_one_and_update, find(...).limit(n)
# with async iteration, create_index (no-op). Matches pymongo semantics
# closely enough for this module's own query shapes ($in, $nin, $gt, $lt,
# None-equality, plain equality).

def _matches(doc: dict, filt: dict) -> bool:
    for key, cond in filt.items():
        val = doc.get(key)
        if isinstance(cond, dict):
            for op, opval in cond.items():
                if op == "$in" and val not in opval:
                    return False
                if op == "$nin" and val in opval:
                    return False
                if op == "$gt" and not (val is not None and val > opval):
                    return False
                if op == "$lt" and not (val is not None and val < opval):
                    return False
        else:
            if val != cond:
                return False
    return True


class _FakeInsertResult:
    def __init__(self, inserted_id):
        self.inserted_id = inserted_id


class _FakeUpdateResult:
    def __init__(self, modified_count):
        self.modified_count = modified_count


class _FakeCursor:
    def __init__(self, docs):
        self._docs = docs

    def limit(self, n):
        self._docs = self._docs[:n]
        return self

    def __aiter__(self):
        self._iter = iter(list(self._docs))
        return self

    async def __anext__(self):
        try:
            return next(self._iter)
        except StopIteration:
            raise StopAsyncIteration


class FakeCollection:
    def __init__(self):
        self._docs: dict = {}
        self._seq = 0

    async def create_index(self, *args, **kwargs):
        return None

    async def insert_one(self, doc):
        self._seq += 1
        _id = doc.get("_id") or ObjectId()
        stored = dict(doc)
        stored["_id"] = _id
        self._docs[_id] = stored
        return _FakeInsertResult(_id)

    async def find_one(self, filt):
        for doc in self._docs.values():
            if _matches(doc, filt):
                return dict(doc)
        return None

    async def update_one(self, filt, update):
        modified = 0
        for _id, doc in self._docs.items():
            if _matches(doc, filt):
                if "$set" in update:
                    doc.update(update["$set"])
                modified += 1
                break  # update_one: only the first match
        return _FakeUpdateResult(modified)

    async def find_one_and_update(self, filt, update):
        for _id, doc in self._docs.items():
            if _matches(doc, filt):
                before = dict(doc)  # pymongo default: return_document=BEFORE
                if "$set" in update:
                    doc.update(update["$set"])
                return before
        return None

    def find(self, filt):
        matched = [dict(d) for d in self._docs.values() if _matches(d, filt)]
        return _FakeCursor(matched)


class FakeDB:
    def __init__(self):
        self.camrapidpay_intents = FakeCollection()
        self.camrapidpay_webhook_log = FakeCollection()
        self.payment_settings = FakeCollection()

    def __getitem__(self, name):
        return getattr(self, name)


# ── Test harness ──────────────────────────────────────────────────────────────

def _student_dep(clean_id: str):
    async def _dep():
        return SimpleNamespace(clean_id=clean_id, student_id=clean_id)
    return _dep


def _find_endpoint(api: APIRouter, path: str):
    for route in api.routes:
        if route.path == path:
            return route.endpoint
    raise AssertionError(f"route not registered: {path}")


class _CompletePaymentStub:
    """Stands in for payment_bridge._complete_points_payment. Records every
    call so tests can assert exactly-once crediting; `outcome` controls
    success/failure/exception behavior per test."""

    def __init__(self, outcome="ok"):
        self.outcome = outcome
        self.calls: list[dict] = []

    async def __call__(self, db, student_id, txn, pkg):
        self.calls.append({"student_id": student_id, "txn": dict(txn), "pkg": dict(pkg or {})})
        if self.outcome == "raise":
            raise RuntimeError("simulated GAS failure")
        if self.outcome == "fail":
            return {"ok": False, "error": "simulated_gas_rejection"}
        return {"ok": True}


def _make_api(db, student_clean_id="stu001", credit_outcome="ok"):
    api = APIRouter(prefix="/api")
    completer = _CompletePaymentStub(outcome=credit_outcome)
    cam_tools.register_camrapidpay_payment_routes(
        api, db, _student_dep(student_clean_id), completer,
    )
    return api, completer


def _seed_intent(db: FakeDB, *, reference, amount_usd=0.5, amount_khr=2000,
                  status="pending", student_id="stu001", expires_in_min=5,
                  base_points=50, bonus_points=5, credited_at=None):
    now = datetime.now(timezone.utc)
    doc = {
        "provider": "camrapidpay",
        "student_id": student_id,
        "package_id": "pkg1",
        "package_label": "KHQR Top-Up",
        "amount": amount_usd,
        "amount_khr": amount_khr,
        "currency": "USD",
        "base_points": base_points,
        "bonus_points": bonus_points,
        "total_points": base_points + bonus_points,
        "reference": reference,
        "internal_order_id": reference,
        "provider_invoice_id": "bill_1",
        "status": status,
        "credited_at": credited_at,
        "created_at": now.isoformat(),
        "expires_at": (now + timedelta(minutes=expires_in_min)).isoformat(),
        "raw_provider_response": {},
        "raw_webhook_payload": {},
        "idempotency_key": reference,
        "error_message": "",
    }
    run(db.camrapidpay_intents.insert_one(doc))
    return doc


def _enable_camrapidpay(monkeypatch):
    monkeypatch.setenv("CAMRAPIDPAY_ENABLED", "true")
    monkeypatch.setenv("CAMRAPIDPAY_API_KEY", "test-key-000000")
    monkeypatch.setenv("CAMRAPIDPAY_BASE_URL", "https://fake.camrapidpay.test")


def _patch_check_status(monkeypatch, result_by_ref: dict | None = None, default=None):
    """Monkeypatch the provider's check_status. `result_by_ref` maps
    reference -> the dict check_status should return for it; `default` is
    used for any reference not in the map."""
    async def _fake_check_status(_factory, reference):
        if result_by_ref and reference in result_by_ref:
            return result_by_ref[reference]
        if default is not None:
            return default
        return {"ok": True, "status": cam_provider.STATUS_PENDING, "raw": {}}
    monkeypatch.setattr(cam_provider, "check_status", _fake_check_status)


# ── 1. Diagnostics fix: every non-credit outcome now logs ────────────────────

def test_check_status_not_ok_is_now_logged(monkeypatch, caplog):
    """The transport-failure branch in verify_...() used to be silent."""
    db = FakeDB()
    _enable_camrapidpay(monkeypatch)
    ref = "EDUHUB-TEST-001"
    _seed_intent(db, reference=ref)
    api, completer = _make_api(db)
    endpoint = _find_endpoint(api, "/api/payments/camrapidpay/status/{payment_intent_id}")
    intent = run(db.camrapidpay_intents.find_one({"reference": ref}))

    _patch_check_status(monkeypatch, default={"ok": False, "error": "network_error"})

    with caplog.at_level(logging.WARNING, logger="eduhub"):
        result = run(endpoint(str(intent["_id"]), student=SimpleNamespace(clean_id="stu001")))

    assert result["credited"] is False
    assert any("check_status not ok" in r.message and ref in r.message for r in caplog.records), (
        "the transport-failure branch must log the reference and reason now"
    )
    assert completer.calls == [], "must never credit on a transport failure"


def test_still_pending_outcome_is_now_logged(monkeypatch, caplog):
    """The 'still pending, keep waiting' branch used to be silent -- this is
    the exact branch that made the real incident undiagnosable from logs."""
    db = FakeDB()
    _enable_camrapidpay(monkeypatch)
    ref = "EDUHUB-TEST-002"
    _seed_intent(db, reference=ref)
    api, completer = _make_api(db)
    endpoint = _find_endpoint(api, "/api/payments/camrapidpay/status/{payment_intent_id}")
    intent = run(db.camrapidpay_intents.find_one({"reference": ref}))

    _patch_check_status(monkeypatch, default={"ok": True, "status": cam_provider.STATUS_PENDING, "raw": {}})

    with caplog.at_level(logging.INFO, logger="eduhub"):
        result = run(endpoint(str(intent["_id"]), student=SimpleNamespace(clean_id="stu001")))

    assert result["status"] == "pending"
    assert any(
        "still pending" in r.message and ref in r.message and "provider_status" in r.message
        for r in caplog.records
    ), "a real success:false / non-Success outcome must now be traceable in logs"
    assert completer.calls == []


def test_provider_check_status_logs_raw_response_on_success(monkeypatch, caplog):
    """check_status() itself must now log what the provider actually said,
    even on a clean Success -- this is what would have caught the real
    incident's provider contract drift immediately."""
    db = FakeDB()  # unused directly; testing camrapidpay_provider in isolation
    monkeypatch.setenv("CAMRAPIDPAY_ENABLED", "true")
    monkeypatch.setenv("CAMRAPIDPAY_API_KEY", "test-key-000000")
    monkeypatch.setenv("CAMRAPIDPAY_BASE_URL", "https://fake.camrapidpay.test")

    class _FakeResp:
        status_code = 200
        def json(self):
            return {"success": True, "status": "Success", "amount": 0.5}
        text = "{}"

    class _FakeClient:
        async def __aenter__(self): return self
        async def __aexit__(self, *a): return False
        async def post(self, *a, **kw): return _FakeResp()
        async def get(self, *a, **kw): return _FakeResp()

    with caplog.at_level(logging.INFO, logger="eduhub.camrapidpay"):
        res = run(cam_provider.check_status(lambda: _FakeClient(), "EDUHUB-TEST-003"))

    assert res == {"ok": True, "status": cam_provider.STATUS_SUCCESS, "raw": {"success": True, "status": "Success", "amount": 0.5}}
    assert any("EDUHUB-TEST-003" in r.message and "normalized=Success" in r.message for r in caplog.records)


def test_provider_check_status_logs_raw_response_when_provider_says_not_success(monkeypatch, caplog):
    """This is the single most important new log line for this incident:
    a real success:false response for a reference that was actually paid
    must now leave a trace instead of vanishing silently."""
    monkeypatch.setenv("CAMRAPIDPAY_ENABLED", "true")
    monkeypatch.setenv("CAMRAPIDPAY_API_KEY", "test-key-000000")
    monkeypatch.setenv("CAMRAPIDPAY_BASE_URL", "https://fake.camrapidpay.test")

    class _FakeResp:
        status_code = 200
        def json(self):
            return {"success": False, "message": "not found or unpaid"}
        text = "{}"

    class _FakeClient:
        async def __aenter__(self): return self
        async def __aexit__(self, *a): return False
        async def post(self, *a, **kw): return _FakeResp()
        async def get(self, *a, **kw): return _FakeResp()

    with caplog.at_level(logging.INFO, logger="eduhub.camrapidpay"):
        res = run(cam_provider.check_status(lambda: _FakeClient(), "EDUHUB-TEST-004"))

    assert res["ok"] is True
    assert res["status"] == cam_provider.STATUS_PENDING
    assert any("EDUHUB-TEST-004" in r.message and "success=false" in r.message for r in caplog.records)


# ── 2. Regression matrix ──────────────────────────────────────────────────────

@pytest.mark.parametrize("amount_usd,base_points", [(0.5, 50), (1.0, 100)])
def test_successful_payment_credits_exactly_once_at_various_amounts(monkeypatch, amount_usd, base_points):
    """$0.50 and $1.00 top-ups: Success -> credited exactly once, correct
    points, status flips to 'credited'."""
    db = FakeDB()
    _enable_camrapidpay(monkeypatch)
    ref = f"EDUHUB-AMT-{int(amount_usd * 100)}"
    _seed_intent(db, reference=ref, amount_usd=amount_usd, base_points=base_points, bonus_points=0)
    api, completer = _make_api(db)
    endpoint = _find_endpoint(api, "/api/payments/camrapidpay/status/{payment_intent_id}")
    intent = run(db.camrapidpay_intents.find_one({"reference": ref}))

    _patch_check_status(monkeypatch, default={"ok": True, "status": cam_provider.STATUS_SUCCESS, "raw": {}})

    result = run(endpoint(str(intent["_id"]), student=SimpleNamespace(clean_id="stu001")))

    assert result["credited"] is True
    assert result["status"] == "credited"
    assert result["points_added"] == base_points
    assert len(completer.calls) == 1
    stored = run(db.camrapidpay_intents.find_one({"reference": ref}))
    assert stored["status"] == "credited"
    assert stored["credited_at"] is not None


def test_polling_only_detects_success(monkeypatch):
    """No webhook ever arrives -- client polling alone must still detect
    and credit a completed payment."""
    db = FakeDB()
    _enable_camrapidpay(monkeypatch)
    ref = "EDUHUB-POLL-ONLY"
    _seed_intent(db, reference=ref)
    api, completer = _make_api(db)
    status_ep = _find_endpoint(api, "/api/payments/camrapidpay/status/{payment_intent_id}")
    intent = run(db.camrapidpay_intents.find_one({"reference": ref}))

    _patch_check_status(monkeypatch, default={"ok": True, "status": cam_provider.STATUS_PENDING, "raw": {}})
    r1 = run(status_ep(str(intent["_id"]), student=SimpleNamespace(clean_id="stu001")))
    assert r1["status"] == "pending" and r1["credited"] is False

    _patch_check_status(monkeypatch, default={"ok": True, "status": cam_provider.STATUS_SUCCESS, "raw": {}})
    r2 = run(status_ep(str(intent["_id"]), student=SimpleNamespace(clean_id="stu001")))
    assert r2["credited"] is True
    assert len(completer.calls) == 1


def test_webhook_only_detects_and_credits(monkeypatch):
    """Client never polls -- the webhook's wake-up call alone must trigger
    the server-to-server verify-and-credit."""
    db = FakeDB()
    _enable_camrapidpay(monkeypatch)
    ref = "EDUHUB-WEBHOOK-ONLY"
    _seed_intent(db, reference=ref)
    api, completer = _make_api(db)
    webhook_ep = _find_endpoint(api, "/api/payments/camrapidpay/webhook")

    _patch_check_status(monkeypatch, default={"ok": True, "status": cam_provider.STATUS_SUCCESS, "raw": {}})

    fake_request = SimpleNamespace(
        query_params={},
        json=lambda: _async_return({"reference": ref, "amount": 0.5, "currency": "USD"}),
    )
    run(webhook_ep(fake_request))

    assert len(completer.calls) == 1
    stored = run(db.camrapidpay_intents.find_one({"reference": ref}))
    assert stored["status"] == "credited"


def _async_return(value):
    async def _inner():
        return value
    return _inner()


def test_webhook_amount_mismatch_is_audit_only_and_never_blocks_credit(monkeypatch):
    """A webhook whose body amount/currency doesn't match the intent must be
    flagged for audit but must NEVER prevent the trusted server-to-server
    check from crediting -- this is the exact 'webhook mismatch (audit
    only)' log line seen in the real incident."""
    db = FakeDB()
    _enable_camrapidpay(monkeypatch)
    ref = "EDUHUB-MISMATCH"
    _seed_intent(db, reference=ref, amount_usd=0.5)
    api, completer = _make_api(db)
    webhook_ep = _find_endpoint(api, "/api/payments/camrapidpay/webhook")

    _patch_check_status(monkeypatch, default={"ok": True, "status": cam_provider.STATUS_SUCCESS, "raw": {}})

    # Webhook reports a DIFFERENT amount/currency than the intent (e.g. KHR
    # vs USD) -- must be recorded as a mismatch but still credit, because
    # crediting is decided ONLY by check_status(), never by webhook fields.
    fake_request = SimpleNamespace(
        query_params={},
        json=lambda: _async_return({"reference": ref, "amount": 2000, "currency": "KHR"}),
    )
    run(webhook_ep(fake_request))

    stored = run(db.camrapidpay_intents.find_one({"reference": ref}))
    assert stored["webhook_mismatch"] is True
    assert "amount got=2000" in stored["webhook_mismatch_reason"]
    assert stored["status"] == "credited", "a mismatched webhook must still credit via the trusted status check"
    assert len(completer.calls) == 1


def test_duplicate_webhook_credits_only_once(monkeypatch):
    """The same webhook (or a retried delivery) arriving twice must not
    double-credit -- the atomic claim gate must hold across both calls."""
    db = FakeDB()
    _enable_camrapidpay(monkeypatch)
    ref = "EDUHUB-DUP-WEBHOOK"
    _seed_intent(db, reference=ref)
    api, completer = _make_api(db)
    webhook_ep = _find_endpoint(api, "/api/payments/camrapidpay/webhook")

    _patch_check_status(monkeypatch, default={"ok": True, "status": cam_provider.STATUS_SUCCESS, "raw": {}})

    for _ in range(2):
        fake_request = SimpleNamespace(
            query_params={},
            json=lambda: _async_return({"reference": ref, "amount": 0.5, "currency": "USD"}),
        )
        run(webhook_ep(fake_request))

    assert len(completer.calls) == 1, "duplicate webhook delivery must never double-credit"


def test_delayed_webhook_after_local_expiry_still_credits(monkeypatch):
    """A webhook that arrives after the 5-minute local window closed, for a
    payment CamRapidPay confirms as genuinely Success, must still credit
    (Blocker 3: local expiry never overrides a real late Success)."""
    db = FakeDB()
    _enable_camrapidpay(monkeypatch)
    ref = "EDUHUB-DELAYED"
    _seed_intent(db, reference=ref, expires_in_min=-1)  # already expired locally
    api, completer = _make_api(db)
    webhook_ep = _find_endpoint(api, "/api/payments/camrapidpay/webhook")

    _patch_check_status(monkeypatch, default={"ok": True, "status": cam_provider.STATUS_SUCCESS, "raw": {}})

    fake_request = SimpleNamespace(
        query_params={},
        json=lambda: _async_return({"reference": ref, "amount": 0.5, "currency": "USD"}),
    )
    run(webhook_ep(fake_request))

    stored = run(db.camrapidpay_intents.find_one({"reference": ref}))
    assert stored["status"] == "credited"
    assert len(completer.calls) == 1


def test_expired_payment_marks_expired_and_never_credits(monkeypatch):
    """Locally expired AND the provider does not confirm Success -> expired,
    never credited."""
    db = FakeDB()
    _enable_camrapidpay(monkeypatch)
    ref = "EDUHUB-EXPIRED"
    _seed_intent(db, reference=ref, expires_in_min=-1)
    api, completer = _make_api(db)
    status_ep = _find_endpoint(api, "/api/payments/camrapidpay/status/{payment_intent_id}")
    intent = run(db.camrapidpay_intents.find_one({"reference": ref}))

    _patch_check_status(monkeypatch, default={"ok": True, "status": cam_provider.STATUS_PENDING, "raw": {}})

    result = run(status_ep(str(intent["_id"]), student=SimpleNamespace(clean_id="stu001")))

    assert result["status"] == "expired"
    assert result["credited"] is False
    assert completer.calls == []
    stored = run(db.camrapidpay_intents.find_one({"reference": ref}))
    assert stored["status"] == "expired"


def test_cancelled_payment_normalizes_to_expired_and_never_credits(monkeypatch):
    """CamRapidPay reporting a cancelled transaction must never credit."""
    db = FakeDB()
    _enable_camrapidpay(monkeypatch)
    ref = "EDUHUB-CANCELLED"
    _seed_intent(db, reference=ref)
    api, completer = _make_api(db)
    status_ep = _find_endpoint(api, "/api/payments/camrapidpay/status/{payment_intent_id}")
    intent = run(db.camrapidpay_intents.find_one({"reference": ref}))

    _patch_check_status(monkeypatch, default={"ok": True, "status": cam_provider.STATUS_EXPIRED, "raw": {}})

    result = run(status_ep(str(intent["_id"]), student=SimpleNamespace(clean_id="stu001")))

    assert result["credited"] is False
    assert result["status"] == "expired"
    assert completer.calls == []


def test_multiple_simultaneous_payments_credit_independently(monkeypatch):
    """Two different students' concurrent top-ups must both credit,
    independently, with the correct amount routed to the correct student."""
    db = FakeDB()
    _enable_camrapidpay(monkeypatch)
    ref_a, ref_b = "EDUHUB-MULTI-A", "EDUHUB-MULTI-B"
    _seed_intent(db, reference=ref_a, student_id="stu_a", base_points=50, bonus_points=0)
    _seed_intent(db, reference=ref_b, student_id="stu_b", base_points=100, bonus_points=10)
    api, completer = _make_api(db)
    status_ep = _find_endpoint(api, "/api/payments/camrapidpay/status/{payment_intent_id}")
    intent_a = run(db.camrapidpay_intents.find_one({"reference": ref_a}))
    intent_b = run(db.camrapidpay_intents.find_one({"reference": ref_b}))

    _patch_check_status(monkeypatch, default={"ok": True, "status": cam_provider.STATUS_SUCCESS, "raw": {}})

    async def both():
        return await asyncio.gather(
            status_ep(str(intent_a["_id"]), student=SimpleNamespace(clean_id="stu_a")),
            status_ep(str(intent_b["_id"]), student=SimpleNamespace(clean_id="stu_b")),
        )

    r_a, r_b = run(both())
    assert r_a["credited"] is True and r_a["points_added"] == 50
    # points_added is BASE points only; bonus_points is reported separately
    # (matches verify_camrapidpay_payment_and_credit_once's existing contract).
    assert r_b["credited"] is True and r_b["points_added"] == 100 and r_b["bonus_points"] == 10
    assert len(completer.calls) == 2
    students_credited = {c["student_id"] for c in completer.calls}
    assert students_credited == {"stu_a", "stu_b"}


def test_concurrent_double_check_on_same_reference_credits_only_once(monkeypatch):
    """Preserve the atomic single-credit gate: two simultaneous verify calls
    for the SAME reference (e.g. a poll and a webhook landing at the same
    instant) must credit exactly once."""
    db = FakeDB()
    _enable_camrapidpay(monkeypatch)
    ref = "EDUHUB-RACE"
    _seed_intent(db, reference=ref)
    api, completer = _make_api(db)
    status_ep = _find_endpoint(api, "/api/payments/camrapidpay/status/{payment_intent_id}")
    intent = run(db.camrapidpay_intents.find_one({"reference": ref}))

    _patch_check_status(monkeypatch, default={"ok": True, "status": cam_provider.STATUS_SUCCESS, "raw": {}})

    async def race():
        return await asyncio.gather(
            status_ep(str(intent["_id"]), student=SimpleNamespace(clean_id="stu001")),
            status_ep(str(intent["_id"]), student=SimpleNamespace(clean_id="stu001")),
        )

    results = run(race())
    credited_count = sum(1 for r in results if r["credited"])
    assert credited_count == 2, "idempotent: BOTH calls report credited (one won the race, one saw already-credited)"
    assert len(completer.calls) == 1, "but the actual GAS credit call must have fired exactly once"


def test_unknown_credit_outcome_routes_to_manual_review_not_silent_loss(monkeypatch):
    """If the credit call itself fails after a verified Success, money-safety
    rule: never auto-retry (not idempotent at GAS) -- go to manual_review."""
    db = FakeDB()
    _enable_camrapidpay(monkeypatch)
    ref = "EDUHUB-UNKNOWN-OUTCOME"
    _seed_intent(db, reference=ref)
    api, completer = _make_api(db, credit_outcome="raise")
    status_ep = _find_endpoint(api, "/api/payments/camrapidpay/status/{payment_intent_id}")
    intent = run(db.camrapidpay_intents.find_one({"reference": ref}))

    _patch_check_status(monkeypatch, default={"ok": True, "status": cam_provider.STATUS_SUCCESS, "raw": {}})

    result = run(status_ep(str(intent["_id"]), student=SimpleNamespace(clean_id="stu001")))

    assert result["credited"] is False
    assert result["status"] == "manual_review"
    stored = run(db.camrapidpay_intents.find_one({"reference": ref}))
    assert stored["status"] == "manual_review"
    assert stored["credited_at"] is None
