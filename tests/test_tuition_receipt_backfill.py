"""tests/test_tuition_receipt_backfill.py
=====================================
Persistent Tuition Receipt Engine — one-time invoice-number backfill for
receipts that predate the feature (POST /admin/tuition/receipts/backfill-
invoice-numbers in tuition_tools.py). Copied-inline in-memory fake, per
this codebase's established test convention.
"""
from __future__ import annotations

import asyncio


def run(c):
    return asyncio.run(c)


class _FakeReceiptsColl:
    def __init__(self, docs):
        self._docs = {d["receipt_id"]: dict(d) for d in docs}

    def find(self, query, proj=None):
        # This fake only needs to support the one query shape the real
        # backfill route uses: {"invoice_number": {"$exists": False}}.
        matches = [d for d in self._docs.values() if "invoice_number" not in d]
        return _FakeCursor(sorted(matches, key=lambda d: d["confirmed_at"]))

    async def update_one(self, filt, update):
        rid = filt["receipt_id"]
        doc = self._docs.get(rid)
        modified = 0
        if doc is not None and "invoice_number" not in doc and filt.get("invoice_number", {}).get("$exists") is False:
            doc.update(update["$set"])
            modified = 1
        return _Result(modified)


class _Result:
    def __init__(self, modified_count):
        self.modified_count = modified_count


class _FakeCursor:
    def __init__(self, items):
        self._items = items
    def sort(self, *a, **kw):
        return self
    def __aiter__(self):
        return self._gen()
    async def _gen(self):
        for item in self._items:
            yield item


class _FakeCounters:
    def __init__(self):
        self._docs = {}
    async def find_one_and_update(self, filt, update, upsert=False, return_document=True):
        _id = filt["_id"]
        doc = self._docs.get(_id, {"_id": _id, "seq": 0})
        doc = {**doc, "seq": doc["seq"] + update["$inc"]["seq"]}
        self._docs[_id] = doc
        return dict(doc)


async def _next_invoice_number(counters, year=2026):
    doc = await counters.find_one_and_update(
        {"_id": f"invoice_{year}"}, {"$inc": {"seq": 1}}, upsert=True, return_document=True,
    )
    return f"INV-{year}-{doc['seq']:06d}"


async def _backfill(receipts: _FakeReceiptsColl, counters: _FakeCounters) -> int:
    cursor = receipts.find({"invoice_number": {"$exists": False}}).sort("confirmed_at", 1)
    assigned = 0
    async for doc in cursor:
        invoice_number = await _next_invoice_number(counters)
        result = await receipts.update_one(
            {"receipt_id": doc["receipt_id"], "invoice_number": {"$exists": False}},
            {"$set": {"invoice_number": invoice_number}},
        )
        if result.modified_count:
            assigned += 1
    return assigned


def _receipt(rid, confirmed_at, **overrides):
    doc = {"receipt_id": rid, "confirmed_at": confirmed_at}
    doc.update(overrides)
    return doc


def test_backfill_assigns_numbers_chronologically_oldest_first():
    receipts = _FakeReceiptsColl([
        _receipt("rcpt_c", "2026-08-03"),
        _receipt("rcpt_a", "2026-08-01"),
        _receipt("rcpt_b", "2026-08-02"),
    ])
    counters = _FakeCounters()
    assigned = run(_backfill(receipts, counters))
    assert assigned == 3
    assert receipts._docs["rcpt_a"]["invoice_number"] == "INV-2026-000001"
    assert receipts._docs["rcpt_b"]["invoice_number"] == "INV-2026-000002"
    assert receipts._docs["rcpt_c"]["invoice_number"] == "INV-2026-000003"


def test_backfill_is_idempotent_running_twice_never_reassigns():
    receipts = _FakeReceiptsColl([_receipt("rcpt_a", "2026-08-01")])
    counters = _FakeCounters()
    run(_backfill(receipts, counters))
    first_number = receipts._docs["rcpt_a"]["invoice_number"]

    second_run_assigned = run(_backfill(receipts, counters))
    assert second_run_assigned == 0
    assert receipts._docs["rcpt_a"]["invoice_number"] == first_number


def test_receipts_that_already_have_invoice_number_are_skipped():
    receipts = _FakeReceiptsColl([
        _receipt("rcpt_already", "2026-08-01", invoice_number="INV-2025-000099"),
        _receipt("rcpt_new", "2026-08-02"),
    ])
    counters = _FakeCounters()
    assigned = run(_backfill(receipts, counters))
    assert assigned == 1
    assert receipts._docs["rcpt_already"]["invoice_number"] == "INV-2025-000099"
    assert receipts._docs["rcpt_new"]["invoice_number"] == "INV-2026-000001"
