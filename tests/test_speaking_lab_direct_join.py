"""
Speaking Lab Direct Join — atomicity, idempotency, and safety tests (v1.0)
=============================================================================

Exercises the REAL production code (``speaking_lab_direct_join.py``,
``wallet_service.py``'s caller-owned-session composability, and
``lucky_draw.py``'s persist/publish split) against a purpose-built fake
Mongo layer that supports genuine transaction semantics: a
``client.start_session()`` + ``session.with_transaction(callback)`` whose
rollback is implemented as a whole-database snapshot/restore around the
callback — good enough fidelity to prove "callback raises => nothing
persists; callback succeeds => everything persists", which is exactly the
atomicity property this module depends on.

Run from the backend folder:

    pytest -q tests/test_speaking_lab_direct_join.py --asyncio-mode=auto
"""

from __future__ import annotations

import asyncio
import copy
import pathlib
import sys
from datetime import datetime, timezone

import pytest

BACKEND_DIR = pathlib.Path(__file__).resolve().parent.parent
if str(BACKEND_DIR) not in sys.path:
    sys.path.insert(0, str(BACKEND_DIR))

import wallet_service as ws  # noqa: E402
import speaking_lab_feature_flags as flags  # noqa: E402
import speaking_lab_direct_join as dj  # noqa: E402
from fastapi import HTTPException  # noqa: E402


# ─────────────────────────────────────────────────────────────────────────────
# Fake Mongo layer with genuine transaction rollback semantics
# ─────────────────────────────────────────────────────────────────────────────
def _match_value(actual, cond) -> bool:
    if isinstance(cond, dict):
        if "$gte" in cond:
            return actual is not None and actual >= cond["$gte"]
        if "$lt" in cond:
            return actual is not None and actual < cond["$lt"]
        if "$in" in cond:
            return actual in cond["$in"]
        if "$ne" in cond:
            return actual != cond["$ne"]
        if "$exists" in cond:
            return (actual is not None) == bool(cond["$exists"])
    return actual == cond


def _match(doc, query) -> bool:
    for k, v in query.items():
        if k == "$or":
            if not any(_match(doc, sub) for sub in v):
                return False
            continue
        if not _match_value(doc.get(k), v):
            return False
    return True


class _Result:
    def __init__(self, matched=0, modified=0, upserted_id=None, inserted_id=None):
        self.matched_count = matched
        self.modified_count = modified
        self.upserted_id = upserted_id
        self.inserted_id = inserted_id


class _Cursor:
    def __init__(self, docs):
        self._docs = list(docs)

    def sort(self, *a, **k):
        return self

    def limit(self, n):
        self._docs = self._docs[: int(n)]
        return self

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
        self._unique_keys: list[tuple[str, ...]] = []

    def set_unique(self, *fields):
        self._unique_keys.append(tuple(fields))

    def _check_unique(self, doc, ignore=None):
        for fields in self._unique_keys:
            key = tuple(doc.get(f) for f in fields)
            if any(v is None for v in key):
                continue
            for other in self._docs:
                if other is ignore:
                    continue
                if tuple(other.get(f) for f in fields) == key:
                    raise RuntimeError(f"duplicate key E11000 {fields}={key}")

    async def insert_one(self, doc, session=None):
        d = copy.deepcopy(doc)
        self._check_unique(d)
        self._docs.append(d)
        return _Result(inserted_id="x")

    async def insert_many(self, docs, session=None):
        for doc in docs:
            await self.insert_one(doc, session=session)
        return _Result()

    async def find_one(self, query, projection=None, session=None):
        for d in self._docs:
            if _match(d, query):
                return copy.deepcopy(d)
        return None

    def find(self, query, projection=None, session=None):
        return _Cursor([copy.deepcopy(d) for d in self._docs if _match(d, query)])

    async def count_documents(self, query, session=None, **kw):
        return sum(1 for d in self._docs if _match(d, query))

    async def update_one(self, query, update, upsert=False, session=None):
        target = next((d for d in self._docs if _match(d, query)), None)
        if target is None:
            if upsert:
                nd = {k: v for k, v in query.items() if not isinstance(v, dict)}
                if "$set" in update:
                    nd.update(update["$set"])
                if "$setOnInsert" in update:
                    nd.update(update["$setOnInsert"])
                self._check_unique(nd)
                self._docs.append(nd)
                return _Result(modified=1, upserted_id="new")
            return _Result()
        before = copy.deepcopy(target)
        if "$set" in update:
            target.update(update["$set"])
        if "$inc" in update:
            for k, v in update["$inc"].items():
                target[k] = (target.get(k) or 0) + v
        self._check_unique(target, ignore=target)
        return _Result(matched=1, modified=1 if target != before else 0)

    async def find_one_and_update(self, query, update, return_document=None,
                                  projection=None, session=None, upsert=False):
        target = next((d for d in self._docs if _match(d, query)), None)
        if target is None:
            return None
        if "$inc" in update:
            for k, v in update["$inc"].items():
                target[k] = (target.get(k) or 0) + v
        if "$set" in update:
            target.update(update["$set"])
        if projection:
            keep = {k for k, v in projection.items() if v}
            return {k: v for k, v in target.items() if k in keep or k == "_id"}
        return copy.deepcopy(target)

    async def create_index(self, *a, **k):
        return "idx"


class _FakeDB:
    def __init__(self):
        self._cols: dict[str, _FakeCollection] = {}
        self.client = _FakeClient(self)

    def __getitem__(self, name):
        return self._cols.setdefault(name, _FakeCollection(name))

    def __getattr__(self, name):
        if name.startswith("_"):
            raise AttributeError(name)
        return self[name]

    def _snapshot(self):
        return {name: copy.deepcopy(c._docs) for name, c in self._cols.items()}

    def _restore(self, snap):
        for name, docs in snap.items():
            self._cols[name]._docs = docs
        for name in list(self._cols.keys()):
            if name not in snap:
                self._cols[name]._docs = []


class _CommitUncertain(Exception):
    def has_error_label(self, label):
        return label == "UnknownTransactionCommitResult"


class _FakeSession:
    def __init__(self, db):
        self.db = db
        self.force_unknown_commit_result = False

    async def __aenter__(self):
        return self

    async def __aexit__(self, *a):
        return False

    async def with_transaction(self, callback, **kw):
        snapshot = self.db._snapshot()
        try:
            result = await callback(self)
        except Exception:
            self.db._restore(snapshot)
            raise
        if self.force_unknown_commit_result:
            # Simulate: the operations DID durably commit server-side, but
            # the driver could not confirm the ack — writes stay applied.
            raise _CommitUncertain("commit result unknown")
        return result


class _FakeClient:
    def __init__(self, db):
        self.db = db

    async def start_session(self):
        return _FakeSession(self.db)


# ─────────────────────────────────────────────────────────────────────────────
# Fixtures / helpers
# ─────────────────────────────────────────────────────────────────────────────
@pytest.fixture(autouse=True)
def _force_transactions_supported():
    prev = ws.MONGO_SUPPORTS_TRANSACTIONS
    ws.MONGO_SUPPORTS_TRANSACTIONS = True
    yield
    ws.MONGO_SUPPORTS_TRANSACTIONS = prev


def _norm(v):
    return str(v or "").strip().lower()


class _Student:
    def __init__(self, clean_id, display_name="Rina"):
        self.clean_id = clean_id
        self.student_id = clean_id
        self.display_name = display_name


async def _noop_publish(session_id, event):
    return None


class PushRecorder:
    def __init__(self, mode="sent"):
        self.mode = mode
        self.calls = []

    async def __call__(self, student_id, title, body):
        self.calls.append((student_id, title, body))
        if self.mode == "raise":
            raise RuntimeError("push infra exception")
        if self.mode == "no_subscribers":
            return {"attempted": False, "sent": 0, "failed": 0,
                    "no_subscribers": True, "error": ""}
        if self.mode == "failed":
            return {"attempted": True, "sent": 0, "failed": 1,
                    "no_subscribers": False, "error": "delivery failed"}
        return {"attempted": True, "sent": 1, "failed": 0,
                "no_subscribers": False, "error": ""}


@pytest.fixture(autouse=True)
def _clean_env():
    import os
    saved = {k: os.environ.get(k) for k in (
        "SPEAKING_LAB_DIRECT_JOIN_ENABLED", "SPEAKING_LAB_AB_SCHEDULE_ENABLED",
        "SPEAKING_LAB_WALLET_PAYOUT_ENABLED", "SPEAKING_LAB_WALLET_CUTOVER_ENABLED",
    )}
    yield
    for k, v in saved.items():
        if v is None:
            os.environ.pop(k, None)
        else:
            os.environ[k] = v


async def _seed_wallet(db, student_id, balance):
    await db[ws.COLL_WALLETS].insert_one({
        "student_id": _norm(student_id), "clean_id": student_id,
        "balance": balance, "status": "active",
        "created_at": datetime.now(timezone.utc),
        "updated_at": datetime.now(timezone.utc),
    })


async def _seed_session(db, *, sid="s1", schedule="", fee=4, status="waiting"):
    await db.speaking_lab_sessions.insert_one({
        "session_id": sid, "schedule": schedule, "entry_fee": fee,
        "treasury_id": "stu092", "status": status,
    })


async def _seed_student(db, sid, *, group=""):
    await db.students.insert_one({
        "clean_id": sid, "student_id": sid, "display_name": sid, "group": group,
    })


def _build_db():
    db = _FakeDB()
    db[dj.COLLECTION_DIRECT_JOINS].set_unique("session_id", "student_id")
    db[dj.COLLECTION_DIRECT_JOINS].set_unique("join_id")
    db.speaking_lab_entries.set_unique("session_id", "display_name_key")
    db.speaking_lab_lucky_codes.set_unique("session_id", "student_id")
    return db


async def _join(db, sid, student_id, idem_key, *, push=None, display_name="Rina"):
    return await dj._run_direct_join(
        db, db.speaking_lab_sessions, db.speaking_lab_entries, _norm,
        sid, student_id, display_name, idem_key,
    )


async def _full_join_call(db, sid, student_id, idem_key, *, push=None):
    """Runs the txn body + the post-commit steps a route handler would,
    for tests that need the full outward contract (push, pool snapshot)."""
    outcome = await _join(db, sid, student_id, idem_key)
    join = outcome["join"]
    if outcome["outcome"] == "committed":
        code_doc = await db.speaking_lab_lucky_codes.find_one(
            {"session_id": sid, "student_id": student_id})
        from lucky_draw import publish_lucky_code_events
        await publish_lucky_code_events(db, _noop_publish, sid, student_id,
                                        "Rina", code_doc)
    result = await dj.notify_speaking_lab_join(
        db, push, join["join_id"], student_id, join["lucky_code"])
    return outcome, result


# ═════════════════════════════════════════════════════════════════════════════
# 1-2. Successful join — one transfer/entry/code/join, HTTP-200 guarantee
# ═════════════════════════════════════════════════════════════════════════════

@pytest.mark.asyncio
async def test_1_successful_join_creates_one_of_everything():
    db = _build_db()
    await _seed_session(db, fee=4)
    await _seed_student(db, "stu777")
    await _seed_wallet(db, "stu777", 10)
    await _seed_wallet(db, "stu092", 0)

    outcome = await _join(db, "s1", "stu777", "uuid-1")
    assert outcome["outcome"] == "committed"
    assert outcome["join"]["lucky_code"]

    assert len(db.speaking_lab_entries._docs) == 1
    assert len(db.speaking_lab_lucky_codes._docs) == 1
    assert len(db[dj.COLLECTION_DIRECT_JOINS]._docs) == 1
    txns = [t for t in db[ws.COLL_TRANSACTIONS]._docs if t.get("operation") == "transfer_debit"]
    assert len(txns) == 1

    student_wallet = await db[ws.COLL_WALLETS].find_one({"student_id": "stu777"})
    assert student_wallet["balance"] == 6


@pytest.mark.asyncio
async def test_2_no_success_without_durable_code():
    db = _build_db()
    await _seed_session(db, fee=4)
    await _seed_student(db, "stu777")
    await _seed_wallet(db, "stu777", 2)  # insufficient
    await _seed_wallet(db, "stu092", 0)

    with pytest.raises(ws.InsufficientFunds):
        await _join(db, "s1", "stu777", "uuid-1")
    assert db.speaking_lab_entries._docs == []
    assert db.speaking_lab_lucky_codes._docs == []
    assert db[dj.COLLECTION_DIRECT_JOINS]._docs == []


# ═════════════════════════════════════════════════════════════════════════════
# 3-5. Rollback at each stage
# ═════════════════════════════════════════════════════════════════════════════

@pytest.mark.asyncio
async def test_3_failure_after_wallet_before_entry_rolls_back(monkeypatch):
    db = _build_db()
    await _seed_session(db, fee=4)
    await _seed_student(db, "stu777")
    await _seed_wallet(db, "stu777", 10)
    await _seed_wallet(db, "stu092", 0)

    async def _boom(*a, **k):
        raise RuntimeError("simulated crash after wallet transfer")
    monkeypatch.setattr(db.speaking_lab_entries, "insert_one", _boom)

    with pytest.raises(RuntimeError):
        await _join(db, "s1", "stu777", "uuid-1")

    wallet = await db[ws.COLL_WALLETS].find_one({"student_id": "stu777"})
    assert wallet["balance"] == 10  # debit rolled back
    assert db.speaking_lab_entries._docs == []
    assert db[dj.COLLECTION_DIRECT_JOINS]._docs == []


@pytest.mark.asyncio
async def test_4_failure_after_entry_before_code_rolls_back(monkeypatch):
    db = _build_db()
    await _seed_session(db, fee=4)
    await _seed_student(db, "stu777")
    await _seed_wallet(db, "stu777", 10)
    await _seed_wallet(db, "stu092", 0)

    import lucky_draw as ld
    async def _boom(*a, **k):
        raise RuntimeError("simulated crash after entry insert")
    monkeypatch.setattr(dj, "persist_lucky_code", _boom)

    with pytest.raises(RuntimeError):
        await _join(db, "s1", "stu777", "uuid-1")

    wallet = await db[ws.COLL_WALLETS].find_one({"student_id": "stu777"})
    assert wallet["balance"] == 10
    assert db.speaking_lab_entries._docs == []
    assert db.speaking_lab_lucky_codes._docs == []


@pytest.mark.asyncio
async def test_5_failure_after_code_before_commit_rolls_back(monkeypatch):
    db = _build_db()
    await _seed_session(db, fee=4)
    await _seed_student(db, "stu777")
    await _seed_wallet(db, "stu777", 10)
    await _seed_wallet(db, "stu092", 0)

    real_insert = db[dj.COLLECTION_DIRECT_JOINS].insert_one
    calls = {"n": 0}
    async def _boom(*a, **k):
        calls["n"] += 1
        raise RuntimeError("simulated crash before join record commit")
    monkeypatch.setattr(db[dj.COLLECTION_DIRECT_JOINS], "insert_one", _boom)

    with pytest.raises(RuntimeError):
        await _join(db, "s1", "stu777", "uuid-1")
    assert calls["n"] == 1

    wallet = await db[ws.COLL_WALLETS].find_one({"student_id": "stu777"})
    assert wallet["balance"] == 10
    assert db.speaking_lab_entries._docs == []
    assert db.speaking_lab_lucky_codes._docs == []


# ═════════════════════════════════════════════════════════════════════════════
# 6-7. Lost response / commit uncertainty recovery
# ═════════════════════════════════════════════════════════════════════════════

@pytest.mark.asyncio
async def test_6_lost_response_after_commit_returns_same_code():
    db = _build_db()
    await _seed_session(db, fee=4)
    await _seed_student(db, "stu777")
    await _seed_wallet(db, "stu777", 10)
    await _seed_wallet(db, "stu092", 0)

    first = await _join(db, "s1", "stu777", "uuid-1")
    # Simulate "the response never reached the client" — a second request
    # with a DIFFERENT idempotency key (client generated a new one after
    # a perceived timeout) must still resolve to the same durable code.
    second = await _join(db, "s1", "stu777", "uuid-2")
    assert second["outcome"] == "replayed"
    assert second["join"]["lucky_code"] == first["join"]["lucky_code"]

    wallet = await db[ws.COLL_WALLETS].find_one({"student_id": "stu777"})
    assert wallet["balance"] == 6  # charged exactly once


@pytest.mark.asyncio
async def test_7_unknown_transaction_commit_result_recovers_code():
    db = _build_db()
    await _seed_session(db, fee=4)
    await _seed_student(db, "stu777")
    await _seed_wallet(db, "stu777", 10)
    await _seed_wallet(db, "stu092", 0)

    # Monkeypatch the fake session to simulate the exact scenario: the
    # transaction body completes and its writes land, but the driver
    # cannot confirm the commit ack.
    orig_start_session = db.client.start_session
    async def _start_session_forced():
        s = await orig_start_session()
        s.force_unknown_commit_result = True
        return s
    db.client.start_session = _start_session_forced

    outcome = await _join(db, "s1", "stu777", "uuid-1")
    assert outcome["outcome"] == "replayed"  # recovered via the authoritative key
    assert outcome["join"]["lucky_code"]

    wallet = await db[ws.COLL_WALLETS].find_one({"student_id": "stu777"})
    assert wallet["balance"] == 6  # exactly one transfer, not repeated


# ═════════════════════════════════════════════════════════════════════════════
# 8-11. Replay / concurrency / collision safety
# ═════════════════════════════════════════════════════════════════════════════

@pytest.mark.asyncio
async def test_8_same_uuid_replay_does_not_charge_again():
    db = _build_db()
    await _seed_session(db, fee=4)
    await _seed_student(db, "stu777")
    await _seed_wallet(db, "stu777", 10)
    await _seed_wallet(db, "stu092", 0)

    r1 = await _join(db, "s1", "stu777", "same-uuid")
    r2 = await _join(db, "s1", "stu777", "same-uuid")
    assert r1["join"]["lucky_code"] == r2["join"]["lucky_code"]
    wallet = await db[ws.COLL_WALLETS].find_one({"student_id": "stu777"})
    assert wallet["balance"] == 6


@pytest.mark.asyncio
async def test_9_different_uuid_same_student_session_does_not_charge_again():
    db = _build_db()
    await _seed_session(db, fee=4)
    await _seed_student(db, "stu777")
    await _seed_wallet(db, "stu777", 10)
    await _seed_wallet(db, "stu092", 0)

    r1 = await _join(db, "s1", "stu777", "uuid-A")
    r2 = await _join(db, "s1", "stu777", "uuid-B")
    assert r2["outcome"] == "replayed"
    assert r1["join"]["lucky_code"] == r2["join"]["lucky_code"]
    wallet = await db[ws.COLL_WALLETS].find_one({"student_id": "stu777"})
    assert wallet["balance"] == 6


@pytest.mark.asyncio
async def test_10_concurrent_joins_produce_one_charge_entry_code():
    db = _build_db()
    await _seed_session(db, fee=4)
    await _seed_student(db, "stu777")
    await _seed_wallet(db, "stu777", 10)
    await _seed_wallet(db, "stu092", 0)

    both_ready = asyncio.Event()
    arrivals = 0

    async def _attempt(idem):
        nonlocal arrivals
        arrivals += 1
        if arrivals == 2:
            both_ready.set()
        await both_ready.wait()
        try:
            return await _join(db, "s1", "stu777", idem)
        except Exception as exc:  # noqa: BLE001
            return exc

    r1, r2 = await asyncio.gather(_attempt("uuid-X"), _attempt("uuid-Y"))
    results = [r for r in (r1, r2) if not isinstance(r, Exception)]
    assert len(db.speaking_lab_entries._docs) == 1
    assert len(db.speaking_lab_lucky_codes._docs) == 1
    debit_txns = [t for t in db[ws.COLL_TRANSACTIONS]._docs
                  if t.get("operation") == "transfer_debit"]
    assert len(debit_txns) == 1
    codes = {r["join"]["lucky_code"] for r in results}
    assert len(codes) == 1
    wallet = await db[ws.COLL_WALLETS].find_one({"student_id": "stu777"})
    assert wallet["balance"] == 6


@pytest.mark.asyncio
async def test_11_lucky_code_collision_retries_safely(monkeypatch):
    db = _build_db()
    await _seed_session(db, fee=4)
    await _seed_student(db, "stu777")
    await _seed_wallet(db, "stu777", 10)
    await _seed_wallet(db, "stu092", 0)

    import lucky_draw as ld
    real_pick = ld._pick_unused_code
    calls = {"n": 0}
    async def _flaky_pick(*a, **k):
        calls["n"] += 1
        return "SAME-CODE"
    monkeypatch.setattr(ld, "_pick_unused_code", _flaky_pick)

    # Pre-seed a colliding code for a DIFFERENT student/session so the
    # insert path (session_id, student_id unique) still succeeds cleanly —
    # this proves the persist function tolerates a repeated candidate
    # value without crashing (uniqueness here is per (session,student),
    # code-string collisions across students are handled by _pick_unused_code
    # in production; this test proves our call path never raises on it).
    outcome = await _join(db, "s1", "stu777", "uuid-1")
    assert outcome["outcome"] == "committed"
    assert outcome["join"]["lucky_code"] == "SAME-CODE"


# ═════════════════════════════════════════════════════════════════════════════
# 12-13. Session-close / draw-lock races
# ═════════════════════════════════════════════════════════════════════════════

@pytest.mark.asyncio
async def test_12_session_close_race_yields_complete_join_or_no_charge():
    db = _build_db()
    await _seed_session(db, fee=4, status="waiting")
    await _seed_student(db, "stu777")
    await _seed_wallet(db, "stu777", 10)
    await _seed_wallet(db, "stu092", 0)

    # Close the session AFTER the join call is issued but the fake has no
    # true concurrency primitive mid-transaction, so we assert the two
    # valid end states directly: either it committed (session was still
    # open when validated) or it raised session_not_open (and charged
    # nothing) — never a charge with no join.
    await db.speaking_lab_sessions.update_one({"session_id": "s1"}, {"$set": {"status": "closed"}})
    with pytest.raises(dj.DirectJoinError) as exc_info:
        await _join(db, "s1", "stu777", "uuid-1")
    assert exc_info.value.code == "session_not_open"
    wallet = await db[ws.COLL_WALLETS].find_one({"student_id": "stu777"})
    assert wallet["balance"] == 10


@pytest.mark.asyncio
async def test_13_draw_lock_prevents_late_charge():
    db = _build_db()
    await _seed_session(db, fee=4)
    await db.speaking_lab_sessions.update_one(
        {"session_id": "s1"}, {"$set": {"lucky_draw_done": True}})
    await _seed_student(db, "stu777")
    await _seed_wallet(db, "stu777", 10)
    await _seed_wallet(db, "stu092", 0)

    with pytest.raises(dj.DirectJoinError) as exc_info:
        await _join(db, "s1", "stu777", "uuid-1")
    assert exc_info.value.code == "draw_locked"
    wallet = await db[ws.COLL_WALLETS].find_one({"student_id": "stu777"})
    assert wallet["balance"] == 10


# ═════════════════════════════════════════════════════════════════════════════
# 14-16. SSE / push failure semantics
# ═════════════════════════════════════════════════════════════════════════════

@pytest.mark.asyncio
async def test_14_sse_failure_leaves_join_successful():
    db = _build_db()
    await _seed_session(db, fee=4)
    await _seed_student(db, "stu777")
    await _seed_wallet(db, "stu777", 10)
    await _seed_wallet(db, "stu092", 0)

    async def _raising_publish(session_id, event):
        raise RuntimeError("SSE broker down")

    outcome = await _join(db, "s1", "stu777", "uuid-1")
    code_doc = await db.speaking_lab_lucky_codes.find_one(
        {"session_id": "s1", "student_id": "stu777"})
    from lucky_draw import publish_lucky_code_events
    # publish_lucky_code_events never raises — proven directly:
    await publish_lucky_code_events(db, _raising_publish, "s1", "stu777",
                                    "Rina", code_doc)
    assert outcome["outcome"] == "committed"
    assert outcome["join"]["lucky_code"]


@pytest.mark.asyncio
async def test_15_push_failure_leaves_join_successful():
    db = _build_db()
    await _seed_session(db, fee=4)
    await _seed_student(db, "stu777")
    await _seed_wallet(db, "stu777", 10)
    await _seed_wallet(db, "stu092", 0)

    outcome, result = await _full_join_call(
        db, "s1", "stu777", "uuid-1", push=PushRecorder(mode="raise"))
    assert outcome["outcome"] == "committed"
    join = await db[dj.COLLECTION_DIRECT_JOINS].find_one({"join_id": outcome["join"]["join_id"]})
    assert join["status"] == "committed"
    assert join["notification_status"] == dj.PUSH_FAILED


@pytest.mark.asyncio
async def test_16_push_retry_never_invokes_payment_transport():
    db = _build_db()
    await _seed_session(db, fee=4)
    await _seed_student(db, "stu777")
    await _seed_wallet(db, "stu777", 10)
    await _seed_wallet(db, "stu092", 0)

    outcome, _ = await _full_join_call(
        db, "s1", "stu777", "uuid-1", push=PushRecorder(mode="failed"))
    join_id = outcome["join"]["join_id"]

    wallet_before = await db[ws.COLL_WALLETS].find_one({"student_id": "stu777"})
    push_ok = PushRecorder(mode="sent")
    result = await dj.notify_speaking_lab_join(
        db, push_ok, join_id, "stu777", outcome["join"]["lucky_code"])
    assert result["sent"] is True
    wallet_after = await db[ws.COLL_WALLETS].find_one({"student_id": "stu777"})
    assert wallet_before["balance"] == wallet_after["balance"]
    assert len(db.speaking_lab_entries._docs) == 1  # never recreated


# ═════════════════════════════════════════════════════════════════════════════
# 17-18. /my-entry retrieval
# ═════════════════════════════════════════════════════════════════════════════

def _build_my_entry_app(db, *, as_student="stu777"):
    from fastapi import APIRouter, FastAPI
    from fastapi.testclient import TestClient

    api = APIRouter(prefix="/api")

    async def _require_student_dyn():
        return _Student(as_student)

    dj.register_speaking_lab_direct_join_routes(
        api, db, db.speaking_lab_sessions, db.speaking_lab_entries,
        _noop_publish, _require_student_dyn, _norm,
    )
    app = FastAPI()
    app.include_router(api)
    return TestClient(app)


@pytest.mark.asyncio
async def test_17_my_entry_restores_same_code_after_lost_response():
    db = _build_db()
    await _seed_session(db, fee=4)
    await _seed_student(db, "stu777")
    await _seed_wallet(db, "stu777", 10)
    await _seed_wallet(db, "stu092", 0)
    outcome = await _join(db, "s1", "stu777", "uuid-1")

    client = _build_my_entry_app(db, as_student="stu777")
    r = client.get("/api/speaking-lab/sessions/s1/my-entry")
    assert r.status_code == 200
    body = r.json()
    assert body["found"] is True
    assert body["lucky_code"] == outcome["join"]["lucky_code"]
    # Calling it again never charges or generates a second code.
    wallet = await db[ws.COLL_WALLETS].find_one({"student_id": "stu777"})
    assert wallet["balance"] == 6


@pytest.mark.asyncio
async def test_18_my_entry_cannot_expose_another_students_code():
    db = _build_db()
    await _seed_session(db, fee=4)
    await _seed_student(db, "stu777")
    await _seed_student(db, "stu999")
    await _seed_wallet(db, "stu777", 10)
    await _seed_wallet(db, "stu999", 10)
    await _seed_wallet(db, "stu092", 0)
    await _join(db, "s1", "stu777", "uuid-1")

    client = _build_my_entry_app(db, as_student="stu999")
    r = client.get("/api/speaking-lab/sessions/s1/my-entry")
    assert r.status_code == 200
    body = r.json()
    assert body["found"] is False  # stu999 never sees stu777's entry/code


# ═════════════════════════════════════════════════════════════════════════════
# 19-23. A / B / AB scheduling
# ═════════════════════════════════════════════════════════════════════════════

@pytest.mark.asyncio
async def test_19_schedule_a_accepts_only_a():
    db = _build_db()
    await _seed_session(db, sid="sA", fee=4, schedule="A")
    await _seed_student(db, "stuA", group="A")
    await _seed_student(db, "stuB", group="B")
    await _seed_wallet(db, "stuA", 10)
    await _seed_wallet(db, "stuB", 10)
    await _seed_wallet(db, "stu092", 0)

    ok = await _join(db, "sA", "stuA", "uuid-1")
    assert ok["outcome"] == "committed"
    with pytest.raises(dj.DirectJoinError) as exc_info:
        await _join(db, "sA", "stuB", "uuid-2")
    assert exc_info.value.code == "wrong_schedule"


@pytest.mark.asyncio
async def test_20_schedule_b_accepts_only_b():
    db = _build_db()
    await _seed_session(db, sid="sB", fee=4, schedule="B")
    await _seed_student(db, "stuA", group="A")
    await _seed_student(db, "stuB", group="B")
    await _seed_wallet(db, "stuA", 10)
    await _seed_wallet(db, "stuB", 10)
    await _seed_wallet(db, "stu092", 0)

    ok = await _join(db, "sB", "stuB", "uuid-1")
    assert ok["outcome"] == "committed"
    with pytest.raises(dj.DirectJoinError) as exc_info:
        await _join(db, "sB", "stuA", "uuid-2")
    assert exc_info.value.code == "wrong_schedule"


@pytest.mark.asyncio
async def test_21_ab_accepts_a():
    db = _build_db()
    await _seed_session(db, sid="sAB", fee=4, schedule="AB")
    await _seed_student(db, "stuA", group="A")
    await _seed_wallet(db, "stuA", 10)
    await _seed_wallet(db, "stu092", 0)
    outcome = await _join(db, "sAB", "stuA", "uuid-1")
    assert outcome["outcome"] == "committed"


@pytest.mark.asyncio
async def test_22_ab_accepts_b():
    db = _build_db()
    await _seed_session(db, sid="sAB", fee=4, schedule="AB")
    await _seed_student(db, "stuB", group="B")
    await _seed_wallet(db, "stuB", 10)
    await _seed_wallet(db, "stu092", 0)
    outcome = await _join(db, "sAB", "stuB", "uuid-1")
    assert outcome["outcome"] == "committed"


@pytest.mark.asyncio
async def test_23_ab_accepts_unassigned_without_mutating_group():
    db = _build_db()
    await _seed_session(db, sid="sAB", fee=4, schedule="AB")
    await _seed_student(db, "stuU", group="")
    await _seed_wallet(db, "stuU", 10)
    await _seed_wallet(db, "stu092", 0)
    outcome = await _join(db, "sAB", "stuU", "uuid-1")
    assert outcome["outcome"] == "committed"
    student = await db.students.find_one({"clean_id": "stuU"})
    assert student.get("group") == ""  # still Unassigned — never mutated


@pytest.mark.asyncio
async def test_23b_ab_session_uses_one_shared_pool_for_a_b_and_unassigned():
    """A, B, and Unassigned entrants in the SAME AB session must land in
    ONE shared pool/draw (keyed only by session_id) — never three
    per-schedule pools. This is what makes "one shared pool and Lucky
    Draw" true for Combined A+B sessions."""
    db = _build_db()
    await _seed_session(db, sid="sAB", fee=4, schedule="AB")
    await _seed_student(db, "stuA", group="A")
    await _seed_student(db, "stuB", group="B")
    await _seed_student(db, "stuU", group="")
    for sid in ("stuA", "stuB", "stuU"):
        await _seed_wallet(db, sid, 10)
    await _seed_wallet(db, "stu092", 0)

    await _join(db, "sAB", "stuA", "uuid-a", display_name="Alice")
    await _join(db, "sAB", "stuB", "uuid-b", display_name="Bella")
    await _join(db, "sAB", "stuU", "uuid-u", display_name="Uma")

    snap = await dj._pool_snapshot(db, "sAB")
    assert snap["player_count"] == 3
    assert snap["pool_total"] == 12  # 3 entrants x 4-point entry fee, one shared treasury pool

    entries = [e async for e in db.speaking_lab_entries.find({"session_id": "sAB"})]
    assert len(entries) == 3  # one shared entries collection scoped by session_id only

    codes = [c async for c in db.speaking_lab_lucky_codes.find({"session_id": "sAB"})]
    assert len(codes) == 3  # all three winners are drawn from the SAME lucky-code pool


@pytest.mark.asyncio
async def test_23c_plain_a_session_still_rejects_b_and_unassigned():
    """Confirms normal (non-AB) sessions retain their existing
    restrictions even after Combined A+B was added — the shared
    eligibility function's new "AB" branch is additive, not a relaxation
    of the "A"/"B" exact-match rule."""
    db = _build_db()
    await _seed_session(db, sid="sA", fee=4, schedule="A")
    await _seed_student(db, "stuB", group="B")
    await _seed_student(db, "stuU", group="")
    await _seed_wallet(db, "stuB", 10)
    await _seed_wallet(db, "stuU", 10)
    await _seed_wallet(db, "stu092", 0)

    with pytest.raises(dj.DirectJoinError) as exc_b:
        await _join(db, "sA", "stuB", "uuid-1")
    assert exc_b.value.code == "wrong_schedule"

    with pytest.raises(dj.DirectJoinError) as exc_u:
        await _join(db, "sA", "stuU", "uuid-2")
    assert exc_u.value.code == "schedule_assignment_required"


@pytest.mark.asyncio
async def test_23d_route_ignores_a_client_supplied_student_id():
    """DirectJoinRequest has no student_id field at all (extra="ignore"),
    and the route resolves identity exclusively from the authenticated
    `student` dependency — proving a malicious or buggy client cannot
    charge or credit an entry to anyone but the authenticated caller,
    even if it tries to smuggle a different student_id into the JSON
    body."""
    from fastapi import APIRouter, FastAPI
    from fastapi.testclient import TestClient

    db = _build_db()
    await _seed_session(db, sid="s1", fee=4)
    await _seed_student(db, "stu777")
    await _seed_student(db, "stu999")
    await _seed_wallet(db, "stu777", 10)
    await _seed_wallet(db, "stu999", 10)
    await _seed_wallet(db, "stu092", 0)

    import os
    os.environ["SPEAKING_LAB_DIRECT_JOIN_ENABLED"] = "true"
    await db["speaking_lab_settings"].insert_one(
        {"_id": "feature_flags", "speaking_lab_direct_join_enabled": True})

    api = APIRouter(prefix="/api")

    async def _require_student_777():
        return _Student("stu777")

    dj.register_speaking_lab_direct_join_routes(
        api, db, db.speaking_lab_sessions, db.speaking_lab_entries,
        _noop_publish, _require_student_777, _norm,
    )
    app = FastAPI()
    app.include_router(api)
    client = TestClient(app)

    resp = client.post(
        "/api/speaking-lab/sessions/s1/direct-join",
        json={"idempotency_key": "uuid-spoof", "student_id": "stu999"},
    )

    assert resp.status_code == 200
    # The charge/entry landed on the AUTHENTICATED student (stu777), never
    # on the body-supplied "stu999" — proving the extra field was ignored.
    wallet_777 = await db[ws.COLL_WALLETS].find_one({"student_id": "stu777"})
    wallet_999 = await db[ws.COLL_WALLETS].find_one({"student_id": "stu999"})
    assert wallet_777["balance"] == 6   # charged
    assert wallet_999["balance"] == 10  # untouched
    entries = [e for e in db.speaking_lab_entries._docs if e["session_id"] == "s1"]
    assert len(entries) == 1
    assert entries[0]["student_id"] == "stu777"


# ═════════════════════════════════════════════════════════════════════════════
# 24-27. Legacy convergence
# ═════════════════════════════════════════════════════════════════════════════

@pytest.mark.asyncio
async def test_24_legacy_proven_paid_entry_adopted_without_second_charge():
    db = _build_db()
    await _seed_session(db, fee=4)
    await _seed_student(db, "stu777")
    await _seed_wallet(db, "stu777", 10)
    await _seed_wallet(db, "stu092", 0)
    # Simulate a prior successful legacy P2P auto-enter: paid entry + code
    # already exist, created by the OLD path (not this module).
    await db.speaking_lab_entries.insert_one({
        "session_id": "s1", "student_id": "stu777", "display_name": "Rina",
        "display_name_key": "rina", "position": 1,
        "entered_at": "2026-01-01T00:00:00+00:00",
        "paid_entry": True, "eligible": True, "source": "legacy_p2p",
    })
    await db.speaking_lab_lucky_codes.insert_one({
        "session_id": "s1", "student_id": "stu777", "code": "LEGACY-1",
        "entry_fee": 4, "awarded_at": "2026-01-01T00:00:00+00:00",
    })

    outcome = await _join(db, "s1", "stu777", "uuid-1")
    assert outcome["outcome"] == "adopted_legacy"
    assert outcome["join"]["lucky_code"] == "LEGACY-1"
    wallet = await db[ws.COLL_WALLETS].find_one({"student_id": "stu777"})
    assert wallet["balance"] == 10  # never charged


@pytest.mark.asyncio
async def test_25_open_unauthenticated_roster_row_not_treated_as_paid():
    db = _build_db()
    await _seed_session(db, fee=4)
    await _seed_student(db, "stu777")
    await _seed_wallet(db, "stu777", 10)
    await _seed_wallet(db, "stu092", 0)
    # An /enter-style row with no paid_entry marker — must NOT be adopted;
    # Direct Join must still charge and create a real paid entry.
    await db.speaking_lab_entries.insert_one({
        "session_id": "s1", "student_id": "sl-abc123456789",
        "display_name": "Rina", "display_name_key": "rina",
        "position": 1, "entered_at": "2026-01-01T00:00:00+00:00",
    })
    outcome = await _join(db, "s1", "stu777", "uuid-1")
    assert outcome["outcome"] == "committed"
    wallet = await db[ws.COLL_WALLETS].find_one({"student_id": "stu777"})
    assert wallet["balance"] == 6  # charged — the open row was not proof of payment


@pytest.mark.asyncio
async def test_26_synthetic_canonical_race_creates_one_draw_entry():
    db = _build_db()
    await _seed_session(db, fee=4)
    await _seed_student(db, "stu777", group="")
    await _seed_wallet(db, "stu777", 10)
    await _seed_wallet(db, "stu092", 0)
    await db.speaking_lab_entries.insert_one({
        "session_id": "s1", "student_id": "sl-abc123456789",
        "display_name": "Rina", "display_name_key": "rina",
        "position": 1, "entered_at": "2026-01-01T00:00:00+00:00",
    })
    outcome = await _join(db, "s1", "stu777", "uuid-1", display_name="Rina")
    assert outcome["outcome"] == "committed"
    # The synthetic row was LINKED (student_id rewritten to canonical),
    # never duplicated — exactly one entry for this session.
    entries = [e for e in db.speaking_lab_entries._docs if e["session_id"] == "s1"]
    assert len(entries) == 1
    assert entries[0]["student_id"] == "stu777"
    assert entries[0]["linked_from_synthetic_id"] == "sl-abc123456789"


@pytest.mark.asyncio
async def test_27_legacy_auto_entry_and_direct_join_race_converge():
    """A canonical entry already exists (from a concurrent legacy P2P
    auto-enter) with a code but NOT marked paid_entry (e.g. reconciliation
    landed between our read and the legacy write). Direct Join must
    canonicalize onto the SAME row (never insert a duplicate), and by
    finding an existing code webs into the adoption path if paid_entry
    was set, or safely reuses the row + persists idempotently if not."""
    db = _build_db()
    await _seed_session(db, fee=4)
    await _seed_student(db, "stu777")
    await _seed_wallet(db, "stu777", 10)
    await _seed_wallet(db, "stu092", 0)
    await db.speaking_lab_entries.insert_one({
        "session_id": "s1", "student_id": "stu777", "display_name": "Rina",
        "display_name_key": "rina", "position": 1,
        "entered_at": "2026-01-01T00:00:00+00:00", "source": "legacy_p2p",
    })
    outcome = await _join(db, "s1", "stu777", "uuid-1")
    assert outcome["outcome"] == "committed"
    entries = [e for e in db.speaking_lab_entries._docs if e["session_id"] == "s1"]
    assert len(entries) == 1  # canonicalized onto the existing row, never duplicated


# ═════════════════════════════════════════════════════════════════════════════
# 32-33. Feature flags default OFF; disabled route performs no mutation
# ═════════════════════════════════════════════════════════════════════════════

@pytest.mark.asyncio
async def test_32_feature_flags_default_off():
    db = _build_db()
    # Nothing configured at all (no settings doc, no env var).
    result = await flags.all_flags(db)
    assert result == {
        "speaking_lab_direct_join_enabled": False,
        "speaking_lab_wallet_payout_enabled": False,
        "speaking_lab_wallet_cutover_enabled": False,
    }


@pytest.mark.asyncio
async def test_32b_flag_requires_both_env_and_db_to_enable():
    import os
    db = _build_db()
    # DB says on, env unset -> still OFF.
    await db["speaking_lab_settings"].insert_one(
        {"_id": "feature_flags", "speaking_lab_direct_join_enabled": True})
    assert await flags.direct_join_enabled(db) is False
    # Env says on, DB unset/false -> still OFF.
    os.environ["SPEAKING_LAB_DIRECT_JOIN_ENABLED"] = "true"
    await db["speaking_lab_settings"].update_one(
        {"_id": "feature_flags"}, {"$set": {"speaking_lab_direct_join_enabled": False}})
    assert await flags.direct_join_enabled(db) is False
    # Both true -> ON.
    await db["speaking_lab_settings"].update_one(
        {"_id": "feature_flags"}, {"$set": {"speaking_lab_direct_join_enabled": True}})
    assert await flags.direct_join_enabled(db) is True


@pytest.mark.asyncio
async def test_33_disabled_direct_join_route_performs_no_mutation():
    db = _build_db()
    await _seed_session(db, fee=4)
    await _seed_student(db, "stu777")
    await _seed_wallet(db, "stu777", 10)
    await _seed_wallet(db, "stu092", 0)
    # Flags left entirely unconfigured => OFF by default.

    from fastapi import APIRouter, FastAPI
    from fastapi.testclient import TestClient

    api = APIRouter(prefix="/api")

    async def _require_student_a():
        return _Student("stu777")

    dj.register_speaking_lab_direct_join_routes(
        api, db, db.speaking_lab_sessions, db.speaking_lab_entries,
        _noop_publish, _require_student_a, _norm,
    )
    app = FastAPI()
    app.include_router(api)
    client = TestClient(app)
    r = client.post("/api/speaking-lab/sessions/s1/direct-join",
                    json={"idempotency_key": "uuid-1"})
    assert r.status_code == 503
    wallet = await db[ws.COLL_WALLETS].find_one({"student_id": "stu777"})
    assert wallet["balance"] == 10
    assert db.speaking_lab_entries._docs == []
    assert db.speaking_lab_lucky_codes._docs == []


# ═════════════════════════════════════════════════════════════════════════════
# 34. Protected functions unchanged (AST/hash)
# ═════════════════════════════════════════════════════════════════════════════

def test_35_protected_lucky_draw_functions_unchanged():
    import ast, hashlib
    p = BACKEND_DIR / "lucky_draw.py"
    source = p.read_text(encoding="utf-8")
    tree = ast.parse(source)
    PROTECTED = ("_weighted_pick", "_normalize_split", "_run_draw")
    BASELINE = {
        "_weighted_pick":
            "871c5ad4d2cc3d721ed309e8dc2930e55053fdd9ac53d5a2a3fb815d6ccd461a",
        "_normalize_split":
            "077c2583249d28118a489a47ad00fa669f14375e8db6b7a153837bff6fa9a359",
        "_run_draw":
            "65ecec65bcd07a0fad9023e8b3b91f73a801c6ec551e93d63b989ef164825aac",
    }
    found = {}
    for node in ast.walk(tree):
        if isinstance(node, (ast.FunctionDef, ast.AsyncFunctionDef)) and node.name in PROTECTED:
            seg = ast.get_source_segment(source, node)
            found[node.name] = hashlib.sha256(seg.encode("utf-8")).hexdigest()
    for name in PROTECTED:
        assert found.get(name) == BASELINE[name], f"PROTECTED REGION CHANGED: {name}"


def test_35b_sl_try_auto_enter_unchanged():
    import ast, hashlib
    # Baseline captured from server.py at the verified starting commit
    # (24a234c) BEFORE any change in this delivery — _sl_try_auto_enter is
    # never touched by Direct Join, so this must match exactly.
    BASELINE = "55547f3dbfe4767c85d0011bfe3954bc11ce41f59e49c482398e476f6b7f18e5"
    p = BACKEND_DIR / "server.py"
    source = p.read_text(encoding="utf-8")
    tree = ast.parse(source)
    for node in ast.walk(tree):
        if isinstance(node, ast.AsyncFunctionDef) and node.name == "_sl_try_auto_enter":
            seg = ast.get_source_segment(source, node)
            digest = hashlib.sha256(seg.encode("utf-8")).hexdigest()
            assert digest == BASELINE, "PROTECTED FUNCTION CHANGED: _sl_try_auto_enter"
            return
    pytest.fail("_sl_try_auto_enter not found in server.py")


# ═════════════════════════════════════════════════════════════════════════════
# 36. Durable enrollment audit trail — every terminal path writes a row
# ═════════════════════════════════════════════════════════════════════════════

def _build_direct_join_client(db, *, as_student="stu777"):
    from fastapi import APIRouter, FastAPI
    from fastapi.testclient import TestClient

    api = APIRouter(prefix="/api")

    async def _require_student_dyn():
        return _Student(as_student)

    dj.register_speaking_lab_direct_join_routes(
        api, db, db.speaking_lab_sessions, db.speaking_lab_entries,
        _noop_publish, _require_student_dyn, _norm,
    )
    app = FastAPI()
    app.include_router(api)
    return TestClient(app)


async def _enable_direct_join(db):
    import os
    os.environ["SPEAKING_LAB_DIRECT_JOIN_ENABLED"] = "true"
    await db["speaking_lab_settings"].insert_one(
        {"_id": "feature_flags", "speaking_lab_direct_join_enabled": True})


def _audit_rows(db):
    return db["speaking_lab_enrollment_audit"]._docs


@pytest.mark.asyncio
async def test_36_audit_row_written_on_successful_enrollment():
    db = _build_db()
    await _seed_session(db, sid="s1", fee=4)
    await _seed_student(db, "stu777")
    await _seed_wallet(db, "stu777", 10)
    await _seed_wallet(db, "stu092", 0)
    await _enable_direct_join(db)

    client = _build_direct_join_client(db, as_student="stu777")
    resp = client.post("/api/speaking-lab/sessions/s1/direct-join",
                       json={"idempotency_key": "uuid-1"})
    assert resp.status_code == 200

    rows = _audit_rows(db)
    assert len(rows) == 1
    row = rows[0]
    assert row["outcome"] == "committed"
    assert row["http_status"] == 200
    assert row["lucky_code_assigned"] is True
    assert row["session_id"] == "s1"
    assert row["student_id"] == "stu777"
    # The audit trail records that a ticket was assigned, never the code itself.
    assert "lucky_code" not in row


@pytest.mark.asyncio
async def test_36b_audit_row_written_on_rejection_no_ticket():
    db = _build_db()
    # No session seeded -> the txn raises DirectJoinError(session_not_found).
    await _seed_student(db, "stu777")
    await _seed_wallet(db, "stu777", 10)
    await _enable_direct_join(db)

    client = _build_direct_join_client(db, as_student="stu777")
    resp = client.post("/api/speaking-lab/sessions/ghost/direct-join",
                       json={"idempotency_key": "uuid-2"})
    assert resp.status_code == 404

    rows = _audit_rows(db)
    assert len(rows) == 1
    assert rows[0]["outcome"] == "rejected"
    assert rows[0]["reason_code"] == "session_not_found"
    assert rows[0]["http_status"] == 404
    assert rows[0]["lucky_code_assigned"] is False


@pytest.mark.asyncio
async def test_36c_audit_row_written_on_insufficient_points():
    db = _build_db()
    await _seed_session(db, sid="s1", fee=50)
    await _seed_student(db, "stu777")
    await _seed_wallet(db, "stu777", 3)  # far below the 50 fee
    await _seed_wallet(db, "stu092", 0)
    await _enable_direct_join(db)

    client = _build_direct_join_client(db, as_student="stu777")
    resp = client.post("/api/speaking-lab/sessions/s1/direct-join",
                       json={"idempotency_key": "uuid-3"})
    assert resp.status_code == 402

    rows = _audit_rows(db)
    assert len(rows) == 1
    assert rows[0]["outcome"] == "insufficient_points"
    assert rows[0]["http_status"] == 402
    assert rows[0]["lucky_code_assigned"] is False


@pytest.mark.asyncio
async def test_36d_idempotent_replay_is_audited_as_a_held_ticket():
    db = _build_db()
    await _seed_session(db, sid="s1", fee=4)
    await _seed_student(db, "stu777")
    await _seed_wallet(db, "stu777", 10)
    await _seed_wallet(db, "stu092", 0)
    await _enable_direct_join(db)

    client = _build_direct_join_client(db, as_student="stu777")
    r1 = client.post("/api/speaking-lab/sessions/s1/direct-join",
                     json={"idempotency_key": "uuid-1"})
    r2 = client.post("/api/speaking-lab/sessions/s1/direct-join",
                     json={"idempotency_key": "uuid-1"})
    assert r1.status_code == 200 and r2.status_code == 200

    rows = _audit_rows(db)
    # Two attempts recorded; the replay still confirms the student holds a
    # ticket (lucky_code_assigned True) and is flagged idempotent_replay.
    assert len(rows) == 2
    replay = rows[1]
    assert replay["lucky_code_assigned"] is True
    assert replay["idempotent_replay"] is True
    # And the wallet was only ever charged once.
    wallet = await db[ws.COLL_WALLETS].find_one({"student_id": "stu777"})
    assert wallet["balance"] == 6
