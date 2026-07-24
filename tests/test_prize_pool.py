"""tests/test_prize_pool.py
=====================================================
Prize Pool Platform (architecture continuation: "reusable Prize Pools...
one pool, multiple consumers, every deduction updates one ledger").

Deliberately uses the REAL wallet_service.WalletService (not a mock) —
including its genuine atomic transfer() path — against a fake Mongo
harness that supports caller-owned/self-managed sessions
(client.start_session().with_transaction(...)), the same harness shape
test_speaking_lab_wallet_payout.py already proved out for exercising
transfer(). This proves prize_pool.py's contribute()/distribute()
compose correctly with the UNCHANGED wallet transfer machinery rather
than reinventing money movement — "one ledger", not a second one.
"""
from __future__ import annotations

import copy

import pytest
from fastapi import APIRouter, FastAPI
from fastapi.testclient import TestClient

import prize_pool as pp
import wallet_service as ws


# ── generic fake Mongo collection/db/session (equality queries only —
# prize_pool.py never needs array_filters or comparison operators) ──────
class _Result:
    def __init__(self, matched=0, modified=0, inserted_id=None):
        self.matched_count = matched
        self.modified_count = modified
        self.inserted_id = inserted_id


class _Cursor:
    def __init__(self, docs):
        self._docs = docs

    def sort(self, field, direction=1):
        self._docs = sorted(self._docs, key=lambda d: d.get(field) or "", reverse=(direction < 0))
        return self

    def limit(self, n):
        self._docs = self._docs[:n]
        return self

    def __aiter__(self):
        self._it = iter(self._docs)
        return self

    async def __anext__(self):
        try:
            return next(self._it)
        except StopIteration:
            raise StopAsyncIteration


def _match(doc, query):
    for k, v in query.items():
        if isinstance(v, dict) and any(op in v for op in ("$in", "$ne", "$gte", "$lte", "$gt", "$lt")):
            actual = doc.get(k)
            if "$in" in v and actual not in v["$in"]:
                return False
            if "$ne" in v and actual == v["$ne"]:
                return False
            if "$gte" in v and not ((actual if actual is not None else 0) >= v["$gte"]):
                return False
            if "$lte" in v and not ((actual if actual is not None else 0) <= v["$lte"]):
                return False
            if "$gt" in v and not ((actual if actual is not None else 0) > v["$gt"]):
                return False
            if "$lt" in v and not ((actual if actual is not None else 0) < v["$lt"]):
                return False
        elif doc.get(k) != v:
            return False
    return True


class _FakeCollection:
    def __init__(self):
        self._docs: list[dict] = []

    async def create_index(self, *a, **k):
        return "idx"

    async def insert_one(self, doc, session=None):
        d = copy.deepcopy(doc)
        self._docs.append(d)
        return _Result(inserted_id=d.get("_id") or d.get("student_id"))

    async def insert_many(self, docs, session=None):
        for doc in docs:
            await self.insert_one(doc, session=session)
        return _Result()

    async def find_one(self, query, projection=None, session=None):
        for d in self._docs:
            if _match(d, query):
                return copy.deepcopy(d)
        return None

    def find(self, query=None, projection=None, session=None):
        query = query or {}
        return _Cursor([copy.deepcopy(d) for d in self._docs if _match(d, query)])

    async def update_one(self, query, update, upsert=False, session=None):
        target = next((d for d in self._docs if _match(d, query)), None)
        if target is None:
            if upsert:
                nd = {k: v for k, v in query.items()}
                nd.update(update.get("$set", {}))
                self._docs.append(nd)
                return _Result(matched=1, modified=1)
            return _Result()
        if "$set" in update:
            target.update(update["$set"])
        if "$inc" in update:
            for k, v in update["$inc"].items():
                target[k] = (target.get(k) or 0) + v
        return _Result(matched=1, modified=1)

    async def find_one_and_update(self, query, update, return_document=None,
                                   projection=None, session=None, upsert=False):
        target = next((d for d in self._docs if _match(d, query)), None)
        if target is None:
            if upsert:
                nd = dict(query)
                nd.update(update.get("$set", {}))
                nd.update(update.get("$setOnInsert", {}))
                self._docs.append(nd)
                target = nd
            else:
                return None
        if "$set" in update:
            target.update(update["$set"])
        if "$inc" in update:
            for k, v in update["$inc"].items():
                target[k] = (target.get(k) or 0) + v
        return copy.deepcopy(target)


class _FakeSession:
    def __init__(self, db):
        self.db = db

    async def __aenter__(self):
        return self

    async def __aexit__(self, *a):
        return False

    async def with_transaction(self, callback, **kw):
        snapshot = {name: copy.deepcopy(c._docs) for name, c in self.db._cols.items()}
        try:
            return await callback(self)
        except Exception:
            for name, docs in snapshot.items():
                self.db._cols[name]._docs = docs
            raise


class _FakeClient:
    def __init__(self, db):
        self.db = db

    async def start_session(self):
        return _FakeSession(self.db)


class _FakeDB:
    def __init__(self):
        self._cols: dict[str, _FakeCollection] = {}
        self.client = _FakeClient(self)

    def __getitem__(self, name):
        return self._cols.setdefault(name, _FakeCollection())

    def __getattr__(self, name):
        if name.startswith("_"):
            raise AttributeError(name)
        return self[name]


@pytest.fixture(autouse=True)
def _force_transactions_supported():
    prev = ws.MONGO_SUPPORTS_TRANSACTIONS
    ws.MONGO_SUPPORTS_TRANSACTIONS = True
    yield
    ws.MONGO_SUPPORTS_TRANSACTIONS = prev


async def _seed_wallet(db, student_id, balance):
    await db[ws.COLL_WALLETS].insert_one({
        "student_id": student_id, "balance": balance, "status": "active",
    })


def _seed_wallet_sync(db, student_id, balance):
    """For sync (non-async) test functions seeding state before a
    TestClient call — avoids nesting a second event loop via
    run_until_complete inside pytest-asyncio's own loop."""
    db[ws.COLL_WALLETS]._docs.append({
        "student_id": student_id, "balance": balance, "status": "active",
    })


def _wallet(db):
    return ws.WalletService(db)


# ═════════════════════════════════════════════════════════════════════════
# CRUD + lifecycle
# ═════════════════════════════════════════════════════════════════════════
@pytest.mark.asyncio
async def test_create_pool_defaults_to_open():
    db = _FakeDB()
    pool = await pp.create_pool(db, name="Weekly Rewards", owner_type="weekly_reward", created_by="admin@test")
    assert pool["status"] == "open"
    assert pool["_id"].startswith("pool_")
    assert pool["pool_wallet_id"] == pp.pool_wallet_id(pool["_id"])


@pytest.mark.asyncio
async def test_create_pool_rejects_empty_name_or_owner_type():
    db = _FakeDB()
    with pytest.raises(pp.PrizePoolError) as exc:
        await pp.create_pool(db, name="  ", owner_type="tournament", created_by="a")
    assert exc.value.code == "invalid_name"

    with pytest.raises(pp.PrizePoolError) as exc:
        await pp.create_pool(db, name="X", owner_type="", created_by="a")
    assert exc.value.code == "invalid_owner_type"


@pytest.mark.asyncio
async def test_list_pools_filters_by_owner_type_and_status():
    db = _FakeDB()
    p1 = await pp.create_pool(db, name="A", owner_type="tournament", created_by="a")
    p2 = await pp.create_pool(db, name="B", owner_type="weekly_reward", created_by="a")
    await pp.lock_pool(db, p2["_id"], actor="a")

    tournaments = await pp.list_pools(db, owner_type="tournament")
    assert [p["_id"] for p in tournaments] == [p1["_id"]]

    locked = await pp.list_pools(db, status="locked")
    assert [p["_id"] for p in locked] == [p2["_id"]]


@pytest.mark.asyncio
async def test_lock_settle_lifecycle():
    db = _FakeDB()
    pool = await pp.create_pool(db, name="A", owner_type="tournament", created_by="a")
    locked = await pp.lock_pool(db, pool["_id"], actor="a")
    assert locked["status"] == "locked"

    settled = await pp.settle_pool(db, pool["_id"], actor="a")
    assert settled["status"] == "settled"
    assert settled["settled_at"] is not None


@pytest.mark.asyncio
async def test_cancel_from_open_or_locked():
    db = _FakeDB()
    pool = await pp.create_pool(db, name="A", owner_type="tournament", created_by="a")
    cancelled = await pp.cancel_pool(db, pool["_id"], actor="a")
    assert cancelled["status"] == "cancelled"

    pool2 = await pp.create_pool(db, name="B", owner_type="tournament", created_by="a")
    await pp.lock_pool(db, pool2["_id"], actor="a")
    cancelled2 = await pp.cancel_pool(db, pool2["_id"], actor="a")
    assert cancelled2["status"] == "cancelled"


@pytest.mark.asyncio
async def test_invalid_transition_rejected():
    db = _FakeDB()
    pool = await pp.create_pool(db, name="A", owner_type="tournament", created_by="a")
    with pytest.raises(pp.PrizePoolError) as exc:
        await pp.settle_pool(db, pool["_id"], actor="a")  # can't settle directly from open
    assert exc.value.code == "invalid_transition"


@pytest.mark.asyncio
async def test_transition_on_unknown_pool_raises_404():
    db = _FakeDB()
    with pytest.raises(pp.PrizePoolError) as exc:
        await pp.lock_pool(db, "pool_missing", actor="a")
    assert exc.value.http_status == 404


# ═════════════════════════════════════════════════════════════════════════
# contribute / distribute — real WalletService.transfer(), one ledger
# ═════════════════════════════════════════════════════════════════════════
@pytest.mark.asyncio
async def test_contribute_moves_real_wallet_balance_into_pool():
    db = _FakeDB()
    wallet = _wallet(db)
    await _seed_wallet(db, "stu1", 100)
    pool = await pp.create_pool(db, name="A", owner_type="tournament", created_by="a")

    result = await pp.contribute(db, wallet, pool["_id"], student_id="stu1", amount=30, idempotency_key="k1")
    assert result["ok"] is True
    assert await wallet.get_balance("stu1") == 70
    assert await pp.get_pool_balance(db, wallet, pool["_id"]) == 30


@pytest.mark.asyncio
async def test_contribute_is_idempotent():
    db = _FakeDB()
    wallet = _wallet(db)
    await _seed_wallet(db, "stu1", 100)
    pool = await pp.create_pool(db, name="A", owner_type="tournament", created_by="a")

    await pp.contribute(db, wallet, pool["_id"], student_id="stu1", amount=30, idempotency_key="k1")
    await pp.contribute(db, wallet, pool["_id"], student_id="stu1", amount=30, idempotency_key="k1")
    assert await wallet.get_balance("stu1") == 70  # only charged once


@pytest.mark.asyncio
async def test_contribute_rejects_insufficient_funds():
    db = _FakeDB()
    wallet = _wallet(db)
    await _seed_wallet(db, "stu1", 10)
    pool = await pp.create_pool(db, name="A", owner_type="tournament", created_by="a")
    with pytest.raises(ws.InsufficientFunds):
        await pp.contribute(db, wallet, pool["_id"], student_id="stu1", amount=30, idempotency_key="k1")


@pytest.mark.asyncio
async def test_contribute_blocked_once_pool_is_not_open():
    db = _FakeDB()
    wallet = _wallet(db)
    await _seed_wallet(db, "stu1", 100)
    pool = await pp.create_pool(db, name="A", owner_type="tournament", created_by="a")
    await pp.lock_pool(db, pool["_id"], actor="a")

    with pytest.raises(pp.PrizePoolError) as exc:
        await pp.contribute(db, wallet, pool["_id"], student_id="stu1", amount=30, idempotency_key="k1")
    assert exc.value.code == "pool_not_open"


@pytest.mark.asyncio
async def test_distribute_pays_winner_from_pool():
    db = _FakeDB()
    wallet = _wallet(db)
    await _seed_wallet(db, "stu1", 100)
    await _seed_wallet(db, "stu2", 0)
    pool = await pp.create_pool(db, name="A", owner_type="tournament", created_by="a")
    await pp.contribute(db, wallet, pool["_id"], student_id="stu1", amount=50, idempotency_key="k1")

    result = await pp.distribute(db, wallet, pool["_id"], student_id="stu2", amount=50, idempotency_key="k2", reason="1st place")
    assert result["ok"] is True
    assert await wallet.get_balance("stu2") == 50
    assert await pp.get_pool_balance(db, wallet, pool["_id"]) == 0


@pytest.mark.asyncio
async def test_distribute_allowed_while_locked_blocked_once_settled():
    db = _FakeDB()
    wallet = _wallet(db)
    await _seed_wallet(db, "stu1", 100)
    await _seed_wallet(db, "stu2", 0)
    pool = await pp.create_pool(db, name="A", owner_type="tournament", created_by="a")
    await pp.contribute(db, wallet, pool["_id"], student_id="stu1", amount=50, idempotency_key="k1")
    await pp.lock_pool(db, pool["_id"], actor="a")

    # allowed while locked
    await pp.distribute(db, wallet, pool["_id"], student_id="stu2", amount=50, idempotency_key="k2")
    await pp.settle_pool(db, pool["_id"], actor="a")

    with pytest.raises(pp.PrizePoolError) as exc:
        await pp.distribute(db, wallet, pool["_id"], student_id="stu2", amount=1, idempotency_key="k3")
    assert exc.value.code == "pool_not_distributable"


@pytest.mark.asyncio
async def test_get_pool_ledger_reflects_contributions_and_distributions():
    db = _FakeDB()
    wallet = _wallet(db)
    await _seed_wallet(db, "stu1", 100)
    await _seed_wallet(db, "stu2", 0)
    pool = await pp.create_pool(db, name="A", owner_type="tournament", created_by="a")
    await pp.contribute(db, wallet, pool["_id"], student_id="stu1", amount=40, idempotency_key="k1")
    await pp.distribute(db, wallet, pool["_id"], student_id="stu2", amount=15, idempotency_key="k2")

    entries = await pp.get_pool_ledger(db, wallet, pool["_id"])
    sources = sorted(e["source"] for e in entries)
    assert sources == ["prize_pool_contribution", "prize_pool_distribution"]


# ═════════════════════════════════════════════════════════════════════════
# HTTP routes — real APIRouter + FastAPI + TestClient
# ═════════════════════════════════════════════════════════════════════════
class _Admin:
    email = "admin@test"


async def _admin_dep():
    return _Admin()


def _make_client(db, wallet):
    app = FastAPI()
    api = APIRouter(prefix="/api")
    pp.register_prize_pool_routes(api, db, wallet, _admin_dep)
    app.include_router(api)
    return TestClient(app)


def test_create_list_get_routes():
    db = _FakeDB()
    wallet = _wallet(db)
    client = _make_client(db, wallet)

    resp = client.post("/api/v1/prize-pools", json={"name": "Tournament A", "owner_type": "tournament"})
    assert resp.status_code == 200
    pool_id = resp.json()["pool"]["_id"]

    assert client.get("/api/v1/prize-pools").json()["pools"][0]["_id"] == pool_id
    assert client.get(f"/api/v1/prize-pools/{pool_id}").status_code == 200
    assert client.get("/api/v1/prize-pools/pool_missing").status_code == 404


def test_contribute_and_distribute_routes():
    db = _FakeDB()
    wallet = _wallet(db)
    _seed_wallet_sync(db, "stu1", 100)
    _seed_wallet_sync(db, "stu2", 0)
    client = _make_client(db, wallet)

    pool_id = client.post("/api/v1/prize-pools", json={"name": "A", "owner_type": "tournament"}).json()["pool"]["_id"]

    resp = client.post(f"/api/v1/prize-pools/{pool_id}/contribute", json={
        "student_id": "stu1", "amount": 40, "idempotency_key": "k1",
    })
    assert resp.status_code == 200

    resp = client.get(f"/api/v1/prize-pools/{pool_id}/balance")
    assert resp.json()["balance"] == 40

    resp = client.post(f"/api/v1/prize-pools/{pool_id}/distribute", json={
        "student_id": "stu2", "amount": 40, "idempotency_key": "k2", "reason": "winner",
    })
    assert resp.status_code == 200

    resp = client.get(f"/api/v1/prize-pools/{pool_id}/ledger")
    assert len(resp.json()["entries"]) == 2


def test_contribute_route_returns_402_on_insufficient_funds():
    db = _FakeDB()
    wallet = _wallet(db)
    _seed_wallet_sync(db, "stu1", 5)
    client = _make_client(db, wallet)
    pool_id = client.post("/api/v1/prize-pools", json={"name": "A", "owner_type": "tournament"}).json()["pool"]["_id"]

    resp = client.post(f"/api/v1/prize-pools/{pool_id}/contribute", json={
        "student_id": "stu1", "amount": 50, "idempotency_key": "k1",
    })
    assert resp.status_code == 402


def test_lock_settle_routes():
    db = _FakeDB()
    wallet = _wallet(db)
    client = _make_client(db, wallet)
    pool_id = client.post("/api/v1/prize-pools", json={"name": "A", "owner_type": "tournament"}).json()["pool"]["_id"]

    resp = client.post(f"/api/v1/prize-pools/{pool_id}/lock")
    assert resp.json()["pool"]["status"] == "locked"

    resp = client.post(f"/api/v1/prize-pools/{pool_id}/settle")
    assert resp.json()["pool"]["status"] == "settled"
