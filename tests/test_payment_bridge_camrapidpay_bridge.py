"""tests/test_payment_bridge_camrapidpay_bridge.py
====================================================
Hybrid verification restore (Aug 2026) — payment_bridge.py side.

payment_bridge.py's existing, already-production-proven ABA/Bakong
Telegram-notification pipeline (_process_transaction) now offers itself as
a second, independent confirmation source for a CamRapidPay-created intent
when its own payment_intents matching finds nothing. This file tests that
integration point in isolation: the wiring via the late_binds dict, and
that the existing ABA-intent matching/scoring/dispatch path is completely
unaffected (the bridge is only ever consulted as a fallback, never
competes with or overrides an ABA match).

The deep money-safety logic itself (matching against camrapidpay_intents,
the atomic single-credit claim, the "credited only once regardless of
which source arrives first" guarantee) is already covered end-to-end in
tests/test_camrapidpay_verification.py -- this file only proves
payment_bridge.py forwards to it correctly and never interferes with the
pre-existing ABA path. Uses the same in-memory-fake + real-endpoint style
already established by test_book_factory_routes.py /
test_camrapidpay_verification.py -- no real database, no real Telegram/GAS
network calls.
"""
from __future__ import annotations

import asyncio

import pytest
from fastapi import APIRouter
from bson import ObjectId

import payment_bridge as pb_module


def run(c):
    return asyncio.run(c)


# ── In-memory fake Mongo (same shape/semantics as test_camrapidpay_verification) ──

def _matches(doc: dict, filt: dict) -> bool:
    for key, cond in filt.items():
        val = doc.get(key)
        if isinstance(cond, dict):
            for op, opval in cond.items():
                if op == "$in" and val not in opval:
                    return False
                if op == "$gte" and not (val is not None and val >= opval):
                    return False
        else:
            if val != cond:
                return False
    return True


class _FakeInsertResult:
    def __init__(self, inserted_id):
        self.inserted_id = inserted_id


class _FakeCursor:
    def __init__(self, docs):
        self._docs = docs

    def sort(self, *a, **kw):
        return self

    async def to_list(self, n):
        return list(self._docs[:n])


class FakeCollection:
    def __init__(self):
        self._docs: dict = {}

    async def create_index(self, *a, **kw):
        return None

    async def insert_one(self, doc):
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
        for _id, doc in self._docs.items():
            if _matches(doc, filt):
                if "$set" in update:
                    doc.update(update["$set"])
                break

    def find(self, filt):
        return _FakeCursor([dict(d) for d in self._docs.values() if _matches(d, filt)])


class FakeDB:
    def __init__(self):
        self.payment_intents = FakeCollection()
        self.payment_transactions = FakeCollection()
        self.payment_settings = FakeCollection()
        self.payment_audit_log = FakeCollection()
        self.students = FakeCollection()

    def __getitem__(self, name):
        return getattr(self, name)


# ── Harness ────────────────────────────────────────────────────────────────

class _FakeUser:
    pass


async def _require_admin_stub():
    return _FakeUser()


async def _fan_out_push_stub(*a, **kw):
    return (0, 0)


async def _update_tuition_in_gas_stub(**kw):
    return {"ok": True}


def _make_api(db, late_binds=None):
    api = APIRouter(prefix="/api")
    binds = late_binds if late_binds is not None else {}
    # sl_treasury_password deliberately EMPTY: _complete_points_payment's
    # existing (untouched) guard clause short-circuits before any real GAS
    # network call when it's falsy ("SL_TREASURY_PASSWORD not configured").
    # None of these tests need a successful ABA-path credit to succeed --
    # only that the right code path was CHOSEN -- so this keeps every test
    # here fully offline, matching this repo's own no-real-network-calls
    # testing convention.
    complete_points_payment, ensure_indexes = pb_module.register_payment_bridge_routes(
        api, db, _require_admin_stub, _FakeUser,
        _fan_out_push_stub, _update_tuition_in_gas_stub,
        "treasury_id", "", "https://example.invalid/gas",
        binds,
    )
    return api, complete_points_payment


def _find_endpoint(api: APIRouter, path: str):
    for route in api.routes:
        if route.path == path:
            return route.endpoint
    raise AssertionError(f"route not registered: {path}")


PAYWAY_MESSAGE = (
    "$0.50 paid by Some Student on Aug 5, 3:54PM via Bakong at Eduhub Studio. "
    "Trx. ID: 58778590821, APV: 782862"
)


async def _ingest_and_drain(webhook_ep, message=PAYWAY_MESSAGE):
    """Post a Telegram notification through the real route, then drain the
    fire-and-forget _process_transaction task it schedules (matches the
    real production wiring: asyncio.create_task, not awaited inline) so the
    test can assert on its result deterministically instead of racing it."""
    payload = pb_module.TelegramWebhookPayload(message=message)
    result = await webhook_ep(payload, request=_FakeRequest())
    # Drain any tasks _ingest_parsed_transaction fired via asyncio.create_task
    # -- MUST exclude the current task itself (asyncio.all_tasks() includes
    # the running coroutine's own wrapper task; gathering it would deadlock
    # a task awaiting its own completion).
    await asyncio.sleep(0)
    current = asyncio.current_task()
    pending = [t for t in asyncio.all_tasks() if t is not current and not t.done()]
    if pending:
        await asyncio.gather(*pending)
    return result


class _FakeRequest:
    headers: dict = {}


# ── Tests ─────────────────────────────────────────────────────────────────

def test_no_camrapidpay_bridge_wired_falls_back_to_existing_unmatched_behavior(monkeypatch):
    """When late_binds has no bridge (e.g. CamRapidPay flag is off, or this
    is a deploy window before camrapidpay_payment_tools.py registers), the
    existing 'unmatched' outcome for a notification with no ABA intent match
    must be completely unchanged -- no crash, no new behavior."""
    monkeypatch.delenv("PAYMENT_WEBHOOK_SECRET", raising=False)
    db = FakeDB()
    api, _ = _make_api(db, late_binds={})
    webhook_ep = _find_endpoint(api, "/api/payments/telegram-webhook")

    run(_ingest_and_drain(webhook_ep))

    stored = [d for d in db.payment_transactions._docs.values()][0]
    assert stored["status"] == "unmatched"


def test_camrapidpay_bridge_no_match_leaves_existing_unmatched_behavior_unchanged(monkeypatch):
    """The bridge IS wired but reports no_match (e.g. the amount doesn't
    correspond to any CamRapidPay intent either) -- the transaction must
    still end up 'unmatched', not silently swallowed."""
    monkeypatch.delenv("PAYMENT_WEBHOOK_SECRET", raising=False)
    db = FakeDB()
    calls = []

    async def _bridge_no_match(txn):
        calls.append(txn)
        return {"status": "no_match", "credited": False, "reference": None}

    api, _ = _make_api(db, late_binds={"camrapidpay_verify_via_bank_notification": _bridge_no_match})
    webhook_ep = _find_endpoint(api, "/api/payments/telegram-webhook")

    run(_ingest_and_drain(webhook_ep))

    assert len(calls) == 1, "the bridge must be consulted when the ABA path finds nothing"
    stored = [d for d in db.payment_transactions._docs.values()][0]
    assert stored["status"] == "unmatched"


def test_camrapidpay_bridge_credited_marks_transaction_completed(monkeypatch):
    """A CamRapidPay-created intent the bridge successfully credits must
    surface as 'completed' on the payment_transactions record, with the
    matched reference recorded for audit."""
    monkeypatch.delenv("PAYMENT_WEBHOOK_SECRET", raising=False)
    db = FakeDB()

    async def _bridge_credits(txn):
        assert txn["transaction_id"] == "58778590821"
        assert txn["apv"] == "782862"
        return {"status": "credited", "credited": True,
                "reference": "EDUHUB-0805085341-3XXXXX", "points_added": 55}

    api, _ = _make_api(db, late_binds={"camrapidpay_verify_via_bank_notification": _bridge_credits})
    webhook_ep = _find_endpoint(api, "/api/payments/telegram-webhook")

    run(_ingest_and_drain(webhook_ep))

    stored = [d for d in db.payment_transactions._docs.values()][0]
    assert stored["status"] == "completed"
    assert stored["matched_camrapidpay_reference"] == "EDUHUB-0805085341-3XXXXX"
    assert stored["match_confidence"] == "high"


def test_camrapidpay_bridge_ambiguous_marks_needs_review_not_completed(monkeypatch):
    """An ambiguous bridge match (multiple same-amount CamRapidPay intents)
    must never be silently treated as completed -- needs_review, matching
    the ABA path's own 'never guess' discipline."""
    monkeypatch.delenv("PAYMENT_WEBHOOK_SECRET", raising=False)
    db = FakeDB()

    async def _bridge_ambiguous(txn):
        return {"status": "ambiguous", "credited": False, "reference": None}

    api, _ = _make_api(db, late_binds={"camrapidpay_verify_via_bank_notification": _bridge_ambiguous})
    webhook_ep = _find_endpoint(api, "/api/payments/telegram-webhook")

    run(_ingest_and_drain(webhook_ep))

    stored = [d for d in db.payment_transactions._docs.values()][0]
    assert stored["status"] == "needs_review"
    assert stored["completion_result"]["status"] == "ambiguous"


def test_existing_aba_intent_match_takes_priority_bridge_never_called(monkeypatch):
    """The single most important non-regression: when the notification DOES
    match an existing ABA payment_intents record, the CamRapidPay bridge
    must NEVER be consulted at all -- the pre-existing ABA matching,
    scoring, and dispatch path is completely untouched."""
    monkeypatch.delenv("PAYMENT_WEBHOOK_SECRET", raising=False)
    db = FakeDB()
    run(db.payment_intents.insert_one({
        "type": "points", "student_id": "stu001", "status": "pending",
        "amount_khr": 2000, "amount": 2000, "pkg_id": "pkg1",
        "created_at": "2026-08-05T00:00:00+00:00",
        "expires_at": "2026-12-31T00:00:00+00:00",
    }))
    run(db.payment_settings.insert_one({
        "_id": ObjectId(), "amount_khr": 2000, "active": True,
        "points": 50, "bonus_points": 0, "label": "Starter",
    }))
    run(db.students.insert_one({"student_id": "stu001", "clean_id": "STU001"}))

    bridge_calls = []

    async def _bridge_should_never_be_called(txn):
        bridge_calls.append(txn)
        return {"status": "no_match", "credited": False, "reference": None}

    api, _ = _make_api(db, late_binds={"camrapidpay_verify_via_bank_notification": _bridge_should_never_be_called})
    webhook_ep = _find_endpoint(api, "/api/payments/telegram-webhook")

    # _find_best_intent's existing (untouched) strict-match compares the
    # notification's raw amount directly against amount_khr -- no USD/KHR
    # conversion -- so the notification must be KHR-denominated to match
    # the seeded 2000 KHR intent, exactly like real ABA/PayWay KHR
    # notifications already do in production.
    khr_message = (
        "2,000 KHR paid by Some Student on Aug 5, 3:54PM via ABA at Eduhub Studio. "
        "Trx. ID: 58778590822, APV: 782863"
    )
    run(_ingest_and_drain(webhook_ep, message=khr_message))

    assert bridge_calls == [], "the CamRapidPay bridge must never be consulted when an ABA intent already matched"
