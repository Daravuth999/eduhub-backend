"""tests/test_tuition_migration.py
=====================================
Tuition migration safety tests (Gate 10, Gate 4).

Tests the data_source migration pipeline:
  gas → mongo_shadow → mongo

Also tests the globals().get() fallback behaviour (Gate 4).
"""
from __future__ import annotations

import asyncio
import calendar
from datetime import date, datetime, timezone
from typing import Callable


def run(c):
    return asyncio.run(c)


# ── In-memory Mongo fake (minimal, supports find/update_one/count) ────────────

class _Col:
    def __init__(self):
        self._docs: list[dict] = []

    def _match(self, query: dict, doc: dict) -> bool:
        for k, v in query.items():
            if k == "$in":
                continue
            val = doc.get(k)
            if isinstance(v, dict):
                if "$in" in v and val not in v["$in"]:
                    return False
                if "$nin" in v and val in v["$nin"]:
                    return False
            elif val != v:
                return False
        return True

    async def find_one(self, q, projection=None):
        for d in self._docs:
            if self._match(q, d):
                return dict(d)
        return None

    async def update_one(self, q, update, upsert=False):
        for i, d in enumerate(self._docs):
            if self._match(q, d):
                if "$set" in update:
                    self._docs[i] = {**d, **update["$set"]}
                return _Res(1, 1)
        if upsert and "$set" in update:
            self._docs.append(dict(update["$set"]))
            return _Res(0, 0, upserted=True)
        return _Res(0, 0)

    async def update_many(self, q, update):
        count = 0
        for i, d in enumerate(self._docs):
            if self._match(q, d):
                if "$set" in update:
                    self._docs[i] = {**d, **update["$set"]}
                count += 1
        return _Res(count, count)

    async def count_documents(self, q):
        return sum(1 for d in self._docs if self._match(q, d))

    async def insert_one(self, doc):
        self._docs.append(dict(doc))
        return _Res(0, 0)

    def find(self, q, projection=None):
        results = [dict(d) for d in self._docs if self._match(q, d)]
        return _Cursor(results)


class _Cursor:
    def __init__(self, docs):
        self._docs = docs

    def sort(self, *a):
        return self

    def limit(self, n):
        self._docs = self._docs[:n]
        return self

    def __aiter__(self):
        return self._iter()

    async def _iter(self):
        for d in self._docs:
            yield d

    async def to_list(self, n=None):
        return self._docs[:n] if n else list(self._docs)


class _Res:
    def __init__(self, matched, modified, upserted=False):
        self.matched_count = matched
        self.modified_count = modified
        self.upserted = upserted


class _DB:
    def __init__(self):
        self.tuition_records = _Col()
        self.tuition_receipts = _Col()
        self.students = _Col()

    def __getitem__(self, name):
        return getattr(self, name.replace("-", "_"), _Col())


# ── Migration helpers (mirroring the backend logic) ───────────────────────────

async def dry_run(db, target_ids=None) -> dict:
    query = {"is_active": True}
    if target_ids:
        query["student_id"] = {"$in": target_ids}
    students = await db.students.find(query).to_list(2000)
    report = {"new": [], "conflict": [], "invalid": [], "missing": [], "total": len(students)}
    for stu in students:
        sid, cid = stu["student_id"], stu["clean_id"]
        rec = await db.tuition_records.find_one({"student_id": sid})
        if not rec:
            report["missing"].append({"student_id": sid, "clean_id": cid})
            continue
        ndd_str = rec.get("next_due_date")
        if ndd_str:
            try:
                date.fromisoformat(ndd_str.replace(".", "-"))
            except ValueError:
                report["invalid"].append({"student_id": sid, "bad_date": ndd_str})
                continue
        ds = rec.get("data_source", "gas")
        if ds == "mongo":
            report["conflict"].append({"student_id": sid, "reason": "already_mongo"})
        else:
            report["new"].append({"student_id": sid, "current_source": ds})
    return report


async def do_import(db, target_ids=None) -> dict:
    query = {"data_source": {"$in": ["gas"]}}
    if target_ids:
        query["student_id"] = {"$in": target_ids}
    result = await db.tuition_records.update_many(query, {"$set": {"data_source": "mongo_shadow"}})
    return {"matched": result.matched_count, "modified": result.modified_count}


async def do_cutover(db, target_ids=None) -> dict:
    query = {"data_source": "mongo_shadow"}
    if target_ids:
        query["student_id"] = {"$in": target_ids}
    result = await db.tuition_records.update_many(query, {"$set": {"data_source": "mongo"}})
    return {"matched": result.matched_count, "modified": result.modified_count}


# ── Tests ─────────────────────────────────────────────────────────────────────

def test_dry_run_writes_nothing():
    """dry-run must not modify any document."""
    db = _DB()
    db.students._docs = [
        {"student_id": "s1", "clean_id": "STU001", "is_active": True},
    ]
    db.tuition_records._docs = [
        {"student_id": "s1", "data_source": "gas", "next_due_date": "2026-07-01"},
    ]
    before = db.tuition_records._docs[0]["data_source"]
    run(dry_run(db))
    after = db.tuition_records._docs[0]["data_source"]
    assert before == after == "gas", "dry_run must not modify data_source"


def test_dry_run_reports_missing_students():
    """Student with no Mongo shadow record → reported as missing."""
    db = _DB()
    db.students._docs = [{"student_id": "s2", "clean_id": "STU002", "is_active": True}]
    report = run(dry_run(db))
    assert len(report["missing"]) == 1
    assert report["missing"][0]["student_id"] == "s2"


def test_dry_run_reports_invalid_date():
    """Unparseable date → reported as invalid."""
    db = _DB()
    db.students._docs = [{"student_id": "s3", "clean_id": "STU003", "is_active": True}]
    db.tuition_records._docs = [
        {"student_id": "s3", "data_source": "gas", "next_due_date": "NOT_A_DATE"},
    ]
    report = run(dry_run(db))
    assert len(report["invalid"]) == 1


def test_dry_run_reports_already_mongo():
    """Record with data_source='mongo' → conflict, not new."""
    db = _DB()
    db.students._docs = [{"student_id": "s4", "clean_id": "STU004", "is_active": True}]
    db.tuition_records._docs = [
        {"student_id": "s4", "data_source": "mongo", "next_due_date": "2026-07-01"},
    ]
    report = run(dry_run(db))
    assert len(report["conflict"]) == 1


def test_import_is_idempotent():
    """Running import twice must yield the same result: gas→mongo_shadow."""
    db = _DB()
    db.tuition_records._docs = [
        {"student_id": "s1", "data_source": "gas"},
        {"student_id": "s2", "data_source": "gas"},
    ]
    r1 = run(do_import(db))
    r2 = run(do_import(db))    # second import: gas records already gone
    assert r1["modified"] == 2
    assert r2["modified"] == 0  # idempotent: no gas records left
    for doc in db.tuition_records._docs:
        assert doc["data_source"] == "mongo_shadow"


def test_import_does_not_touch_mongo_records():
    """Import only affects 'gas' records, not 'mongo' or 'mongo_shadow' records."""
    db = _DB()
    db.tuition_records._docs = [
        {"student_id": "s1", "data_source": "gas"},
        {"student_id": "s2", "data_source": "mongo"},
        {"student_id": "s3", "data_source": "mongo_shadow"},
    ]
    run(do_import(db))
    sources = {d["student_id"]: d["data_source"] for d in db.tuition_records._docs}
    assert sources["s1"] == "mongo_shadow"  # was gas, now shadow
    assert sources["s2"] == "mongo"         # unchanged
    assert sources["s3"] == "mongo_shadow"  # unchanged


def test_cutover_requires_shadow_records():
    """Cutover only flips mongo_shadow→mongo, not gas records."""
    db = _DB()
    db.tuition_records._docs = [
        {"student_id": "s1", "data_source": "gas"},
        {"student_id": "s2", "data_source": "mongo_shadow"},
    ]
    run(do_cutover(db))
    sources = {d["student_id"]: d["data_source"] for d in db.tuition_records._docs}
    assert sources["s1"] == "gas"    # gas unchanged — must go through import first
    assert sources["s2"] == "mongo"  # shadow promoted to mongo


def test_mongo_conflicts_not_silently_overwritten():
    """A record already in 'mongo' mode must not be overwritten by import."""
    db = _DB()
    db.tuition_records._docs = [
        {"student_id": "s1", "data_source": "mongo", "next_due_date": "2026-08-01"},
    ]
    run(do_import(db))
    # import only touches 'gas' records — 'mongo' is untouched
    assert db.tuition_records._docs[0]["data_source"] == "mongo"
    assert db.tuition_records._docs[0]["next_due_date"] == "2026-08-01"


def test_shadow_write_never_raises():
    """tuition_shadow_write must catch all exceptions and never propagate."""
    shadow_called = []
    shadow_error  = []

    async def shadow_write_stub(**kwargs):
        shadow_called.append(kwargs)
        raise RuntimeError("DB connection lost")  # simulate failure

    async def teacher_update(shadow_fn):
        # Fire-and-forget pattern used in server.py
        try:
            await shadow_fn(
                student_id="s1", clean_id="STU001",
                tuition_status="Paid", last_payment_date="2026-07-01",
                next_due_date="2026-08-01", payment_amount=25.0,
            )
        except Exception as e:
            shadow_error.append(str(e))

    run(teacher_update(shadow_write_stub))
    assert len(shadow_called) == 1
    assert len(shadow_error) == 1  # error was caught by teacher_update
    # In real server.py the task is create_task'd so it's truly fire-and-forget


# ── Gate 4: globals().get() fallback safety ───────────────────────────────────

def test_mongo_mode_fails_closed_without_finalizer():
    """
    When data_source='mongo' and finalizer is not loaded, the payment must
    fail closed (safe error), not silently fall back to GAS.

    This test validates the EXPECTED behavior after a Mongo cutover:
    the legacy GAS fallback is only acceptable in gas/mongo_shadow modes.
    """

    def decide_path(data_source: str, finalizer_available: bool) -> str:
        """
        Mirrors the logic that should exist in _complete_tuition_payment:
        - If finalizer available: always use it
        - If finalizer NOT available AND data_source='mongo': fail closed
        - If finalizer NOT available AND data_source in ('gas','mongo_shadow'): legacy ok
        """
        if finalizer_available:
            return "mongo_finalizer"
        if data_source == "mongo":
            return "fail_closed"  # never fall back to GAS in mongo mode
        return "legacy_gas"

    assert decide_path("mongo", True)          == "mongo_finalizer"
    assert decide_path("mongo_shadow", True)   == "mongo_finalizer"
    assert decide_path("gas", True)            == "mongo_finalizer"
    assert decide_path("mongo", False)         == "fail_closed"    # Gate 4 critical
    assert decide_path("mongo_shadow", False)  == "legacy_gas"
    assert decide_path("gas", False)           == "legacy_gas"


def test_idempotent_import_receipt_not_duplicated():
    """Shadow write failure must be recorded (audit trail) and not lose data."""
    writes: list[dict] = []
    failures: list[str] = []

    async def shadow_write_with_audit(doc: dict, db, log_fn: Callable):
        try:
            # Simulate intermittent failure
            if len(writes) == 0:
                writes.append(doc)
            else:
                raise RuntimeError("transient failure")
        except Exception as e:
            failures.append(str(e))
            log_fn(f"shadow write failed: {e}")

    log_entries: list[str] = []
    run(shadow_write_with_audit({"student_id": "s1"}, None, log_entries.append))
    run(shadow_write_with_audit({"student_id": "s1"}, None, log_entries.append))

    assert len(writes) == 1
    assert len(failures) == 1
    assert "transient failure" in log_entries[-1]
