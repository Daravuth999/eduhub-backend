"""
Tests for speaking_lab_wallet_migration.py — the LOCAL dry-run wallet
bootstrap + index reconciliation tool. Proves: dry-run never writes;
--apply without the exact confirm phrase never writes; apply only ever
creates ZERO-BALANCE wallets (never invents an opening balance); apply is
idempotent; existing wallets/balances are never touched.
"""
import copy

import pytest

import wallet_service as ws
import speaking_lab_wallet_migration as mig


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


class _IndexCursor:
    def __init__(self, names):
        self._names = names

    def __aiter__(self):
        self._it = iter(self._names)
        return self

    async def __anext__(self):
        try:
            n = next(self._it)
        except StopIteration:
            raise StopAsyncIteration
        return {"name": n}


class _FakeCollection:
    def __init__(self, name):
        self.name = name
        self._docs: list[dict] = []
        self._index_names = ["_id_"]

    async def create_index(self, keys, unique=False, **kw):
        if isinstance(keys, str):
            name = f"{keys}_1"
        else:
            name = "_".join(f"{k}_{v}" for k, v in keys)
        if name not in self._index_names:
            self._index_names.append(name)
        return name

    def list_indexes(self):
        return _IndexCursor(list(self._index_names))

    async def insert_one(self, doc, session=None):
        self._docs.append(copy.deepcopy(doc))
        return type("R", (), {"inserted_id": "x"})()

    async def find_one(self, query, projection=None, session=None):
        for d in self._docs:
            if all(d.get(k) == v for k, v in query.items()):
                return copy.deepcopy(d)
        return None

    def find(self, query, projection=None):
        def _match(d):
            for k, v in query.items():
                if isinstance(v, dict) and "$ne" in v:
                    if d.get(k) == v["$ne"]:
                        return False
                elif d.get(k) != v:
                    return False
            return True
        return _Cursor([copy.deepcopy(d) for d in self._docs if _match(d)])

    async def update_one(self, query, update, session=None):
        target = next((d for d in self._docs
                       if all(d.get(k) == v for k, v in query.items())), None)
        if target is None:
            return type("R", (), {"modified_count": 0})()
        if "$set" in update:
            target.update(update["$set"])
        if "$inc" in update:
            for k, v in update["$inc"].items():
                target[k] = (target.get(k) or 0) + v
        return type("R", (), {"modified_count": 1})()


class _FakeDB:
    def __init__(self):
        self._cols: dict[str, _FakeCollection] = {}

    def __getitem__(self, name):
        return self._cols.setdefault(name, _FakeCollection(name))

    def __getattr__(self, name):
        if name.startswith("_"):
            raise AttributeError(name)
        return self[name]


async def _seed_student(db, student_id, *, active=True, clean_id=None):
    await db["students"].insert_one({
        "student_id": student_id, "clean_id": clean_id or student_id,
        "is_active": active,
    })


async def _seed_wallet(db, student_id, balance):
    await db[ws.COLL_WALLETS].insert_one({
        "student_id": student_id, "balance": balance, "status": "active",
    })


@pytest.mark.asyncio
async def test_1_plan_reports_missing_and_present_wallets_without_writing():
    db = _FakeDB()
    await _seed_student(db, "stuA")
    await _seed_student(db, "stuB")
    await _seed_wallet(db, "stua", 40)  # stuA already has a wallet

    plan = await mig.plan_wallet_bootstrap(db)

    assert plan["active_student_count"] == 2
    assert plan["wallets_present"] == 1
    assert plan["wallets_missing"] == 1
    assert plan["missing_student_ids_sample"] == ["stub"]
    # Dry-run: no wallet was created for stuB, and stuA's balance is untouched.
    assert await db[ws.COLL_WALLETS].find_one({"student_id": "stub"}) is None
    stua_wallet = await db[ws.COLL_WALLETS].find_one({"student_id": "stua"})
    assert stua_wallet["balance"] == 40


@pytest.mark.asyncio
async def test_2_inactive_students_excluded_from_plan():
    db = _FakeDB()
    await _seed_student(db, "stuActive", active=True)
    await _seed_student(db, "stuGone", active=False)

    plan = await mig.plan_wallet_bootstrap(db)

    assert plan["active_student_count"] == 1
    assert plan["missing_student_ids_sample"] == ["stuactive"]


@pytest.mark.asyncio
async def test_3_apply_without_confirm_phrase_raises_and_writes_nothing():
    db = _FakeDB()
    await _seed_student(db, "stuA")

    with pytest.raises(ValueError):
        await mig.apply_wallet_bootstrap(db, confirm="wrong phrase")

    assert await db[ws.COLL_WALLETS].find_one({"student_id": "stua"}) is None


@pytest.mark.asyncio
async def test_4_apply_with_correct_confirm_creates_zero_balance_wallets_only():
    db = _FakeDB()
    await _seed_student(db, "stuA")
    await _seed_student(db, "stuB")

    result = await mig.apply_wallet_bootstrap(db, confirm=mig.CONFIRM_PHRASE)

    assert result["wallets_created"] == 2
    wa = await db[ws.COLL_WALLETS].find_one({"student_id": "stua"})
    wb = await db[ws.COLL_WALLETS].find_one({"student_id": "stub"})
    assert wa["balance"] == 0
    assert wb["balance"] == 0
    assert wa["status"] == "active"


@pytest.mark.asyncio
async def test_5_apply_never_touches_an_existing_wallets_balance():
    db = _FakeDB()
    await _seed_student(db, "stuA")
    await _seed_wallet(db, "stua", 777)  # a real, nonzero balance already exists

    result = await mig.apply_wallet_bootstrap(db, confirm=mig.CONFIRM_PHRASE)

    assert result["wallets_created"] == 0  # nothing missing — nothing created
    wa = await db[ws.COLL_WALLETS].find_one({"student_id": "stua"})
    assert wa["balance"] == 777  # untouched


@pytest.mark.asyncio
async def test_6_apply_is_idempotent():
    db = _FakeDB()
    await _seed_student(db, "stuA")

    r1 = await mig.apply_wallet_bootstrap(db, confirm=mig.CONFIRM_PHRASE)
    r2 = await mig.apply_wallet_bootstrap(db, confirm=mig.CONFIRM_PHRASE)

    assert r1["wallets_created"] == 1
    assert r2["wallets_created"] == 0  # already bootstrapped, nothing left missing


@pytest.mark.asyncio
async def test_7_index_report_is_read_only_and_lists_owners():
    db = _FakeDB()
    report = await mig.plan_index_report(db)

    assert "points_wallets" in report
    assert report["points_wallets"]["owner"] == "wallet_service.ensure_wallet_indexes"
    assert "speaking_lab_lucky_draws" in report
    # Read-only: listing indexes must not have created any collection docs.
    assert db["points_wallets"]._docs == []


@pytest.mark.asyncio
async def test_8_index_ensure_without_confirm_raises_and_creates_nothing():
    db = _FakeDB()
    with pytest.raises(ValueError):
        await mig.apply_index_ensure(db, confirm="nope")
    assert db["points_wallets"]._index_names == ["_id_"]


@pytest.mark.asyncio
async def test_9_index_ensure_with_confirm_calls_real_ensure_functions():
    db = _FakeDB()
    result = await mig.apply_index_ensure(db, confirm=mig.CONFIRM_PHRASE)
    # The real ensure_wallet_indexes() must have actually run against our
    # fake collection (proves we called the production function, not a
    # reimplementation) — it creates more than just the default _id_ index.
    assert len(db[ws.COLL_WALLETS]._index_names) > 1
    assert "speaking_lab_lucky_draws" in result


def test_10_unparsable_ids_are_skipped_not_fatal():
    assert mig._safe_norm_id(None) is None
    assert mig._safe_norm_id("") is None
    assert mig._safe_norm_id("valid_id") == "valid_id"


@pytest.mark.asyncio
async def test_11_never_wired_into_server_py():
    with open("server.py", encoding="utf-8") as f:
        src = f.read()
    assert "speaking_lab_wallet_migration" not in src
