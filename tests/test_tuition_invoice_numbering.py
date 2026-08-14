"""tests/test_tuition_invoice_numbering.py
=====================================
Sequential invoice numbering (Persistent Tuition Receipt Engine, C1).

Tests the atomic-counter pattern used by _ttn_next_invoice_number in
tuition_tools.py: `find_one_and_update({_id}, {$inc: seq}, upsert=True,
return_document=True)`. Copied inline against an in-memory fake collection
that mirrors MongoDB's atomicity guarantee for a single find_one_and_update
call (no partial reads possible between two concurrent increments), per
this codebase's established test convention (see test_tuition_concurrency.py).
"""
from __future__ import annotations

import asyncio


def run(c):
    return asyncio.run(c)


class _FakeCounters:
    """In-memory stand-in for the tuition_invoice_counters collection.
    A single asyncio task runs at a time between awaits (cooperative
    scheduling) — this fake's find_one_and_update body does the read+write
    with no `await` in between, exactly mirroring how MongoDB's real
    find_one_and_update is a single atomic server-side operation."""
    def __init__(self):
        self._docs: dict[str, dict] = {}

    async def find_one_and_update(self, filt, update, upsert=False, return_document=True):
        _id = filt["_id"]
        doc = self._docs.get(_id)
        if doc is None:
            if not upsert:
                return None
            doc = {"_id": _id, "seq": 0}
        inc = update["$inc"]["seq"]
        doc = {**doc, "seq": doc["seq"] + inc}
        self._docs[_id] = doc
        return dict(doc)


async def _next_invoice_number(counters: _FakeCounters, year: int) -> str:
    counter_id = f"invoice_{year}"
    doc = await counters.find_one_and_update(
        {"_id": counter_id}, {"$inc": {"seq": 1}}, upsert=True, return_document=True,
    )
    return f"INV-{year}-{doc['seq']:06d}"


def test_sequential_numbers_within_a_year():
    counters = _FakeCounters()
    numbers = run(_gather_sequential(counters, 2026, 3))
    assert numbers == ["INV-2026-000001", "INV-2026-000002", "INV-2026-000003"]


async def _gather_sequential(counters, year, n):
    return [await _next_invoice_number(counters, year) for _ in range(n)]


def test_year_rollover_starts_fresh():
    counters = _FakeCounters()
    run(_gather_sequential(counters, 2026, 5))
    first_2027 = run(_next_invoice_number(counters, 2027))
    assert first_2027 == "INV-2027-000001"
    # 2026's counter is untouched by 2027 activity
    next_2026 = run(_next_invoice_number(counters, 2026))
    assert next_2026 == "INV-2026-000006"


def test_concurrent_calls_never_duplicate_a_number():
    counters = _FakeCounters()

    async def _race():
        return await asyncio.gather(*[_next_invoice_number(counters, 2026) for _ in range(50)])

    numbers = run(_race())
    assert len(numbers) == len(set(numbers)) == 50
    assert sorted(numbers) == [f"INV-2026-{i:06d}" for i in range(1, 51)]


def test_admin_manual_payment_duplicate_reference_never_burns_a_second_number():
    """Mirrors the real guard in admin_manual_payment (tuition_tools.py):
    a replayed request with the same `reference` returns the EXISTING
    receipt/invoice_number without minting a new one — invoice numbering
    must sit after that idempotency check, never before it."""
    counters = _FakeCounters()
    existing_receipts: dict[str, dict] = {}

    async def _admin_manual_payment(reference: str):
        # Idempotency check FIRST (mirrors tuition_tools.py:1293-1298)
        existing = existing_receipts.get(reference)
        if existing:
            return existing["invoice_number"]
        invoice_number = await _next_invoice_number(counters, 2026)
        existing_receipts[reference] = {"invoice_number": invoice_number}
        return invoice_number

    first = run(_admin_manual_payment("REF-1"))
    replay = run(_admin_manual_payment("REF-1"))
    other = run(_admin_manual_payment("REF-2"))

    assert first == replay == "INV-2026-000001"
    assert other == "INV-2026-000002"
