"""tests/test_video_library_restricted_points.py — the new, genuinely
separate Video-Library-only spendable points ledger (§2 of the coupon
round). Exercises credit/debit/idempotency/insufficient-funds against an
in-memory fake Mongo (same hand-rolled-fake convention as
tests/test_wallet_migration_tools.py — never a live Mongo connection).
"""
from __future__ import annotations

import pytest

import video_library_restricted_points as vlrp


class _Result:
    def __init__(self, **kw):
        for k, v in kw.items():
            setattr(self, k, v)


class _FakeWalletsColl:
    """Supports exactly what video_library_restricted_points.py needs:
    find_one, find_one_and_update with a $gte balance guard AND upsert
    (unlike test_wallet_migration_tools.py's fake, which never upserts on
    find_one_and_update — this module's credit() relies on that)."""

    def __init__(self):
        self.docs: dict[str, dict] = {}

    async def find_one(self, query, projection=None):
        sid = query.get("student_id")
        doc = self.docs.get(sid)
        return dict(doc) if doc is not None else None

    async def find_one_and_update(self, filt, update, upsert=False, return_document=None, projection=None):
        sid = filt.get("student_id")
        existing = self.docs.get(sid)
        if existing is None:
            if not upsert:
                return None
            if "balance" in filt:  # a debit guard can never create-on-miss
                return None
            existing = {}
            if "$setOnInsert" in update:
                existing.update(update["$setOnInsert"])
            existing["student_id"] = sid
            existing.setdefault("balance", 0)
            self.docs[sid] = existing
        else:
            if "balance" in filt:
                cond = filt["balance"]
                if isinstance(cond, dict) and "$gte" in cond:
                    if int(existing.get("balance") or 0) < cond["$gte"]:
                        return None
        if "$inc" in update:
            for k, v in update["$inc"].items():
                existing[k] = existing.get(k, 0) + v
        if "$set" in update:
            existing.update(update["$set"])
        return dict(existing)

    async def create_index(self, *a, **k):
        return None


class _FakeTxnsColl:
    def __init__(self):
        self.rows: list[dict] = []

    async def find_one(self, query, projection=None):
        key = query.get("idempotency_key")
        for d in self.rows:
            if d.get("idempotency_key") == key:
                return dict(d)
        return None

    async def insert_one(self, doc):
        self.rows.append(dict(doc))
        return _Result(inserted_id=len(self.rows))

    def find(self, query=None, projection=None):
        query = query or {}
        rows = [d for d in self.rows if all(d.get(k) == v for k, v in query.items())]

        class _Cur:
            def __init__(self, docs):
                self._docs = docs

            def sort(self, *a, **k):
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

        return _Cur(rows)

    async def create_index(self, *a, **k):
        return None


class _FakeDB:
    def __init__(self):
        self._colls = {
            vlrp.COLL_WALLETS: _FakeWalletsColl(),
            vlrp.COLL_TRANSACTIONS: _FakeTxnsColl(),
        }

    def __getitem__(self, name):
        return self._colls[name]


@pytest.fixture
def db():
    return _FakeDB()


# ── basic credit/debit/balance ──────────────────────────────────────────────
@pytest.mark.asyncio
async def test_credit_creates_wallet_and_increments_balance(db):
    result = await vlrp.credit(db, "stu001", 20, source="video_library_coupon", source_ref="CODE1")
    assert result == {"ok": True, "duplicate": False, "balance_after": 20}
    assert await vlrp.get_balance(db, "stu001") == 20


@pytest.mark.asyncio
async def test_get_balance_is_zero_for_unknown_student(db):
    assert await vlrp.get_balance(db, "nobody") == 0


@pytest.mark.asyncio
async def test_multiple_credits_accumulate(db):
    await vlrp.credit(db, "stu001", 20, source="video_library_coupon", source_ref="A")
    await vlrp.credit(db, "stu001", 15, source="video_library_coupon", source_ref="B")
    assert await vlrp.get_balance(db, "stu001") == 35


@pytest.mark.asyncio
async def test_debit_reduces_balance(db):
    await vlrp.credit(db, "stu001", 50, source="video_library_coupon")
    result = await vlrp.debit(db, "stu001", 30, source="video_purchase", source_ref="lesson1")
    assert result == {"ok": True, "duplicate": False, "balance_after": 20}
    assert await vlrp.get_balance(db, "stu001") == 20


@pytest.mark.asyncio
async def test_debit_more_than_balance_raises_insufficient_funds_and_leaves_balance_untouched(db):
    await vlrp.credit(db, "stu001", 10, source="video_library_coupon")
    with pytest.raises(vlrp.InsufficientRestrictedFunds) as exc:
        await vlrp.debit(db, "stu001", 11, source="video_purchase")
    assert exc.value.balance == 10
    assert exc.value.needed == 11
    assert await vlrp.get_balance(db, "stu001") == 10  # untouched


@pytest.mark.asyncio
async def test_debit_with_no_wallet_at_all_raises_insufficient_funds(db):
    with pytest.raises(vlrp.InsufficientRestrictedFunds):
        await vlrp.debit(db, "stu_never_credited", 5, source="video_purchase")


# ── idempotency (replay safety, matching wallet_service.py's guarantee) ────
@pytest.mark.asyncio
async def test_credit_idempotency_key_prevents_double_credit(db):
    key = "coupon-redeem:CODE1:stu001"
    r1 = await vlrp.credit(db, "stu001", 20, source="video_library_coupon", idempotency_key=key)
    r2 = await vlrp.credit(db, "stu001", 20, source="video_library_coupon", idempotency_key=key)
    assert r1["duplicate"] is False
    assert r2["duplicate"] is True
    assert await vlrp.get_balance(db, "stu001") == 20  # NOT 40


@pytest.mark.asyncio
async def test_debit_idempotency_key_prevents_double_debit(db):
    await vlrp.credit(db, "stu001", 50, source="video_library_coupon")
    key = "purchase:stu001::lesson1:attempt1:restricted-debit"
    r1 = await vlrp.debit(db, "stu001", 30, source="video_purchase", idempotency_key=key)
    r2 = await vlrp.debit(db, "stu001", 30, source="video_purchase", idempotency_key=key)
    assert r1["duplicate"] is False
    assert r2["duplicate"] is True
    assert await vlrp.get_balance(db, "stu001") == 20  # NOT -10 / NOT double-spent


# ── validation ──────────────────────────────────────────────────────────────
@pytest.mark.asyncio
async def test_credit_rejects_non_positive_amount(db):
    with pytest.raises(vlrp.RestrictedPointsError):
        await vlrp.credit(db, "stu001", 0, source="x")
    with pytest.raises(vlrp.RestrictedPointsError):
        await vlrp.credit(db, "stu001", -5, source="x")


@pytest.mark.asyncio
async def test_credit_rejects_non_int_amount(db):
    with pytest.raises(vlrp.RestrictedPointsError):
        await vlrp.credit(db, "stu001", 5.5, source="x")


# ── isolation from the shared GAS/wallet_service world ─────────────────────
def test_module_never_imports_wallet_service_or_gas_client():
    """§2.3 (strictly additive to the shared wallet): this module must have
    ZERO coupling to wallet_service.py's dormant Mongo collections or to
    any GAS HTTP client — checked against this module's own source text
    for actual imports/collection-name usage, not its explanatory prose
    (the module docstring intentionally discusses wallet_service.py to
    document why this is a separate module — that's documentation, not
    coupling)."""
    import ast
    from pathlib import Path
    source = Path(vlrp.__file__).read_text(encoding="utf-8")
    tree = ast.parse(source, filename=vlrp.__file__)
    imported_names = set()
    for node in ast.walk(tree):
        if isinstance(node, ast.Import):
            imported_names.update(a.name for a in node.names)
        if isinstance(node, ast.ImportFrom) and node.module:
            imported_names.add(node.module)
    assert "wallet_service" not in imported_names
    assert "httpx" not in imported_names  # no GAS HTTP call of any kind
    assert "\"points_wallets\"" not in source  # wallet_service.py's own collection name, as a code literal
    assert "'points_wallets'" not in source
