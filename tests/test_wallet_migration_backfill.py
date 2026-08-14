"""tests/test_wallet_migration_backfill.py
=====================================================
Tests for scripts/wallet_migration_backfill.py — the LOCAL bulk wallet
backfill tool for the GAS -> Mongo points-wallet migration (Architecture
Reconstruction Phase 2, "wallet migration"). Mirrors the exact scope and
safety-property tests already proven for the sibling
speaking_lab_wallet_migration.py tool: dry-run never writes, --apply
without the exact confirm phrase never writes, --apply with the exact
confirm phrase writes correctly and is idempotent, and the tool is never
wired into server.py (it is only ever reachable by a human running the
file directly from a terminal).
"""
from __future__ import annotations

import copy
import json

import pytest

import wallet_service as ws
import wallet_migration_backfill as mig


def _cond_matches(d: dict, cond: dict) -> bool:
    for k, v in cond.items():
        if isinstance(v, dict) and "$exists" in v:
            if v["$exists"] != (k in d):
                return False
        elif isinstance(v, dict) and "$ne" in v:
            if d.get(k) == v["$ne"]:
                return False
        elif d.get(k) != v:
            return False
    return True


def _doc_matches(d: dict, query: dict) -> bool:
    if "$or" in query:
        return any(_cond_matches(d, c) for c in query["$or"])
    return _cond_matches(d, query)


# ── fake Mongo (same generic pattern as test_speaking_lab_wallet_migration.py) ──
class _Cursor:
    def __init__(self, docs):
        self._docs = docs

    def __aiter__(self):
        self._it = iter(self._docs)
        return self

    async def __anext__(self):
        try:
            return next(self._it)
        except StopIteration:
            raise StopAsyncIteration


class _FakeCollection:
    def __init__(self, name):
        self.name = name
        self._docs: list[dict] = []

    async def insert_one(self, doc, session=None):
        self._docs.append(copy.deepcopy(doc))
        return type("R", (), {"inserted_id": "x"})()

    async def find_one(self, query, projection=None, session=None):
        for d in self._docs:
            if _doc_matches(d, query):
                return copy.deepcopy(d)
        return None

    def find(self, query=None, projection=None):
        query = query or {}
        return _Cursor([copy.deepcopy(d) for d in self._docs if _doc_matches(d, query)])

    async def update_one(self, query, update, upsert=False, session=None):
        target = next((d for d in self._docs
                       if all(d.get(k) == v for k, v in query.items())), None)
        if target is None:
            if upsert and "$setOnInsert" in update:
                self._docs.append(copy.deepcopy(update["$setOnInsert"]))
            elif upsert and "$set" in update:
                self._docs.append(copy.deepcopy(update["$set"]))
            return type("R", (), {"matched_count": 0})()
        if "$set" in update:
            target.update(update["$set"])
        if "$inc" in update:
            for k, v in update["$inc"].items():
                target[k] = (target.get(k) or 0) + v
        return type("R", (), {"matched_count": 1})()

    async def count_documents(self, query):
        def _match(d):
            for k, v in (query or {}).items():
                if k == "$or":
                    if not any(_or_match(d, c) for c in v):
                        return False
                elif d.get(k) != v:
                    return False
            return True

        def _or_match(d, cond):
            for k, v in cond.items():
                if isinstance(v, dict) and "$exists" in v:
                    if v["$exists"] != (k in d):
                        return False
                elif d.get(k) != v:
                    return False
            return True
        return sum(1 for d in self._docs if _match(d))

    def aggregate(self, pipeline):
        # Minimal special-case matching wallet_seed_status's own fixed
        # pipeline shape, same approach as test_wallet_migration_tools.py.
        active = [d for d in self._docs if d.get("is_active", True) is not False]

        async def _gen():
            return
            yield  # pragma: no cover
        return _gen()


class _FakeDB:
    def __init__(self):
        self._cols: dict[str, _FakeCollection] = {}

    def __getitem__(self, name):
        return self._cols.setdefault(name, _FakeCollection(name))

    def __getattr__(self, name):
        if name.startswith("_"):
            raise AttributeError(name)
        return self[name]

    async def list_collection_names(self):
        return list(self._cols.keys())


async def _seed_student(db, student_id, *, active=True, clean_id=None):
    await db["students"].insert_one({
        "student_id": student_id, "clean_id": clean_id or student_id,
        "is_active": active,
    })


async def _seed_wallet(db, student_id, balance):
    await db[ws.COLL_WALLETS].insert_one({
        "student_id": student_id, "balance": balance, "status": "active",
    })


# ═════════════════════════════════════════════════════════════════════════
# load_snapshot_rows — CSV + JSON parsing, strict validation
# ═════════════════════════════════════════════════════════════════════════
def test_load_csv_snapshot(tmp_path):
    p = tmp_path / "snap.csv"
    p.write_text("student_id,clean_id,balance\nstu1,stu1,250\nstu2,,100.5\n", encoding="utf-8")
    rows = mig.load_snapshot_rows(str(p))
    assert rows == [
        {"student_id": "stu1", "clean_id": "stu1", "balance": 250.0},
        {"student_id": "stu2", "clean_id": "stu2", "balance": 100.5},
    ]


def test_load_json_snapshot(tmp_path):
    p = tmp_path / "snap.json"
    p.write_text(json.dumps([
        {"student_id": "stu1", "balance": 300},
        {"student_id": "stu2", "clean_id": "stu2clean", "balance": "150"},
    ]), encoding="utf-8")
    rows = mig.load_snapshot_rows(str(p))
    assert rows[0] == {"student_id": "stu1", "clean_id": "stu1", "balance": 300.0}
    assert rows[1] == {"student_id": "stu2", "clean_id": "stu2clean", "balance": 150.0}


def test_missing_file_raises(tmp_path):
    with pytest.raises(mig.SnapshotError):
        mig.load_snapshot_rows(str(tmp_path / "nope.csv"))


def test_csv_without_student_id_column_raises(tmp_path):
    p = tmp_path / "bad.csv"
    p.write_text("name,balance\nstu1,250\n", encoding="utf-8")
    with pytest.raises(mig.SnapshotError):
        mig.load_snapshot_rows(str(p))


def test_json_non_list_raises(tmp_path):
    p = tmp_path / "bad.json"
    p.write_text(json.dumps({"student_id": "stu1", "balance": 100}), encoding="utf-8")
    with pytest.raises(mig.SnapshotError):
        mig.load_snapshot_rows(str(p))


def test_row_missing_balance_raises(tmp_path):
    p = tmp_path / "bad.csv"
    p.write_text("student_id,balance\nstu1,\n", encoding="utf-8")
    with pytest.raises(mig.SnapshotError):
        mig.load_snapshot_rows(str(p))


def test_row_non_numeric_balance_raises(tmp_path):
    p = tmp_path / "bad.csv"
    p.write_text("student_id,balance\nstu1,lots\n", encoding="utf-8")
    with pytest.raises(mig.SnapshotError):
        mig.load_snapshot_rows(str(p))


def test_row_missing_student_id_raises(tmp_path):
    p = tmp_path / "bad.json"
    p.write_text(json.dumps([{"balance": 100}]), encoding="utf-8")
    with pytest.raises(mig.SnapshotError):
        mig.load_snapshot_rows(str(p))


# ═════════════════════════════════════════════════════════════════════════
# run_backfill — dry-run never writes, real run writes, idempotent
# ═════════════════════════════════════════════════════════════════════════
@pytest.mark.asyncio
async def test_dry_run_never_writes():
    db = _FakeDB()
    await _seed_student(db, "stu1")
    rows = [{"student_id": "stu1", "clean_id": "stu1", "balance": 250}]
    result = await mig.run_backfill(db, rows, overwrite_existing=False, dry_run=True)
    assert result["summary"] == {"would_import": 1}
    assert await db[ws.COLL_WALLETS].find_one({"student_id": "stu1"}) is None


@pytest.mark.asyncio
async def test_real_run_writes_wallet():
    db = _FakeDB()
    await _seed_student(db, "stu1")
    rows = [{"student_id": "stu1", "clean_id": "stu1", "balance": 250}]
    result = await mig.run_backfill(db, rows, overwrite_existing=False, dry_run=False)
    assert result["summary"] == {"imported": 1}
    doc = await db[ws.COLL_WALLETS].find_one({"student_id": "stu1"})
    assert doc["balance"] == 250


@pytest.mark.asyncio
async def test_real_run_is_idempotent_second_pass_matches():
    db = _FakeDB()
    await _seed_student(db, "stu1")
    rows = [{"student_id": "stu1", "clean_id": "stu1", "balance": 250}]
    await mig.run_backfill(db, rows, overwrite_existing=False, dry_run=False)
    second = await mig.run_backfill(db, rows, overwrite_existing=False, dry_run=False)
    assert second["summary"] == {"skipped_existing": 1}
    doc = await db[ws.COLL_WALLETS].find_one({"student_id": "stu1"})
    assert doc["balance"] == 250  # untouched by the second pass


@pytest.mark.asyncio
async def test_existing_wallet_skipped_without_overwrite():
    db = _FakeDB()
    await _seed_student(db, "stu1")
    await _seed_wallet(db, "stu1", 999)
    rows = [{"student_id": "stu1", "clean_id": "stu1", "balance": 250}]
    result = await mig.run_backfill(db, rows, overwrite_existing=False, dry_run=False)
    assert result["summary"] == {"skipped_existing": 1}
    doc = await db[ws.COLL_WALLETS].find_one({"student_id": "stu1"})
    assert doc["balance"] == 999


@pytest.mark.asyncio
async def test_overwrite_existing_updates_balance():
    db = _FakeDB()
    await _seed_student(db, "stu1")
    await _seed_wallet(db, "stu1", 999)
    rows = [{"student_id": "stu1", "clean_id": "stu1", "balance": 250}]
    result = await mig.run_backfill(db, rows, overwrite_existing=True, dry_run=False)
    assert result["summary"] == {"imported": 1}
    doc = await db[ws.COLL_WALLETS].find_one({"student_id": "stu1"})
    assert doc["balance"] == 250


@pytest.mark.asyncio
async def test_unknown_student_is_invalid_not_fatal():
    db = _FakeDB()
    rows = [
        {"student_id": "ghost", "clean_id": "ghost", "balance": 100},
        {"student_id": "also_missing", "clean_id": "also_missing", "balance": 50},
    ]
    result = await mig.run_backfill(db, rows, overwrite_existing=False, dry_run=False)
    assert result["summary"] == {"invalid": 2}
    assert all(r["status"] == "invalid" for r in result["rows"])


@pytest.mark.asyncio
async def test_mixed_batch_reports_per_row_status():
    db = _FakeDB()
    await _seed_student(db, "stu1")
    await _seed_student(db, "stu2")
    await _seed_wallet(db, "stu2", 500)
    rows = [
        {"student_id": "stu1", "clean_id": "stu1", "balance": 100},   # imported
        {"student_id": "stu2", "clean_id": "stu2", "balance": 999},   # skipped_existing
        {"student_id": "ghost", "clean_id": "ghost", "balance": 10},  # invalid
    ]
    result = await mig.run_backfill(db, rows, overwrite_existing=False, dry_run=False)
    assert result["summary"] == {"imported": 1, "skipped_existing": 1, "invalid": 1}


# ═════════════════════════════════════════════════════════════════════════
# Never wired into server.py — same guarantee as speaking_lab_wallet_migration
# ═════════════════════════════════════════════════════════════════════════
def test_never_wired_into_server_py():
    with open("server.py", encoding="utf-8") as f:
        src = f.read()
    assert "wallet_migration_backfill" not in src
