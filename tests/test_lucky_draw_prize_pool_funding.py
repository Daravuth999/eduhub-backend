"""tests/test_lucky_draw_prize_pool_funding.py
=====================================================
Funding-source migration (architecture continuation: "students no longer
contribute points to the pool through entry fees; administrators fund
the pool through the Prize Pool Platform").

Proves the SEAM lucky_draw.py added — `_resolve_pool_total` and
`_record_pool_distribution` — without touching (or needing to re-prove)
the settlement/payout/audit machinery lucky_draw_adversarial.py etc.
already cover in depth: winner selection, GAS transfer, atomic claims,
idempotency are all UNCHANGED and out of scope here.

Uses the SAME generic fake-Mongo-with-transactions harness as
test_prize_pool.py (auto-creating collections on demand via
`_FakeDB.__getitem__`), so the REAL wallet_service.WalletService and
prize_pool.py functions run genuinely, not mocked.
"""
from __future__ import annotations

import copy

import pytest

import lucky_draw as ld
import prize_pool as pp
import wallet_service as ws
from lucky_draw import LuckyDrawConfig


# ── fake Mongo (identical shape to test_prize_pool.py's own harness) ──────
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
        if isinstance(v, dict) and any(op in v for op in ("$in", "$ne", "$gte", "$lte", "$gt", "$lt", "$exists")):
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
            if "$exists" in v and (k in doc) != v["$exists"]:
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
        return _Result(inserted_id=d.get("_id") or d.get("student_id") or d.get("session_id"))

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
        if "$unset" in update:
            for k in update["$unset"]:
                target.pop(k, None)
        if "$inc" in update:
            for k, v in update["$inc"].items():
                target[k] = (target.get(k) or 0) + v
        return _Result(matched=1, modified=1)

    async def count_documents(self, query=None, session=None):
        query = query or {}
        return sum(1 for d in self._docs if _match(d, query))

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


async def _make_session(db, session_id="sl_1", entry_fee=0, prize_pool_id=None):
    doc = {"session_id": session_id, "entry_fee": entry_fee, "status": "active"}
    if prize_pool_id:
        doc["prize_pool_id"] = prize_pool_id
    await db["speaking_lab_sessions"].insert_one(doc)


async def _make_pool(db, *, name="Weekly Speaking Lab", funded=0, actor="admin@test"):
    pool = await pp.create_pool(db, name=name, owner_type="speaking_lab_session", created_by=actor)
    if funded:
        wallet_service = ws.WalletService(db)
        await pp.fund_pool(
            db, wallet_service, pool["_id"], amount=funded,
            idempotency_key=f"fund-{pool['_id']}-{funded}", actor=actor,
        )
    return pool


# ═════════════════════════════════════════════════════════════════════════
# _resolve_pool_total
# ═════════════════════════════════════════════════════════════════════════
@pytest.mark.asyncio
async def test_resolve_pool_total_falls_back_to_entry_fee_sum_when_unlinked():
    db = _FakeDB()
    await _make_session(db, session_id="sl_legacy")
    total = await ld._resolve_pool_total(db, "sl_legacy", 42)
    assert total == 42


@pytest.mark.asyncio
async def test_resolve_pool_total_uses_linked_pool_balance():
    db = _FakeDB()
    pool = await _make_pool(db, funded=500)
    await _make_session(db, session_id="sl_pooled", entry_fee=0, prize_pool_id=pool["_id"])
    # Legacy entry-fee sum would be 0 (nobody paid) — pool balance wins.
    total = await ld._resolve_pool_total(db, "sl_pooled", 0)
    assert total == 500


@pytest.mark.asyncio
async def test_resolve_pool_total_fails_safe_when_linked_pool_missing():
    db = _FakeDB()
    await _make_session(db, session_id="sl_broken", entry_fee=10, prize_pool_id="pool_does_not_exist")
    total = await ld._resolve_pool_total(db, "sl_broken", 10)
    assert total == 10  # falls back rather than raising


@pytest.mark.asyncio
async def test_resolve_pool_total_no_session_falls_back_to_entry_fee_sum():
    db = _FakeDB()
    total = await ld._resolve_pool_total(db, "sl_missing", 7)
    assert total == 7


# ═════════════════════════════════════════════════════════════════════════
# _record_pool_distribution
# ═════════════════════════════════════════════════════════════════════════
@pytest.mark.asyncio
async def test_record_pool_distribution_noop_when_session_unlinked():
    db = _FakeDB()
    await _make_session(db, session_id="sl_legacy2")
    await ld._record_pool_distribution(
        db, "sl_legacy2", [{"student_id": "stu1", "amount": 50, "transfer_ok": True}], actor="a",
    )
    # No pool ever created -> nothing to assert on balance; just prove no crash
    # and no phantom pool got created.
    assert db["prize_pools"]._docs == []


@pytest.mark.asyncio
async def test_record_pool_distribution_records_paid_winners_and_reduces_balance():
    db = _FakeDB()
    pool = await _make_pool(db, funded=300)
    await _make_session(db, session_id="sl_pooled2", prize_pool_id=pool["_id"])
    winners = [
        {"student_id": "stu1", "display_name": "Stu One", "amount": 100, "transfer_ok": True},
        {"student_id": "stu2", "display_name": "Stu Two", "amount": 50, "transfer_ok": True},
    ]
    await ld._record_pool_distribution(db, "sl_pooled2", winners, actor="teacher@test")

    wallet_service = ws.WalletService(db)
    balance = await pp.get_pool_balance(db, wallet_service, pool["_id"])
    assert balance == 150  # 300 - 100 - 50

    ledger = await pp.get_pool_ledger(db, wallet_service, pool["_id"])
    sources = {e["source"] for e in ledger}
    assert "prize_pool_distribution" in sources
    assert "prize_pool_admin_fund" in sources


@pytest.mark.asyncio
async def test_record_pool_distribution_skips_unpaid_or_zero_winners():
    db = _FakeDB()
    pool = await _make_pool(db, funded=300)
    await _make_session(db, session_id="sl_pooled3", prize_pool_id=pool["_id"])
    winners = [
        {"student_id": "stu1", "amount": 100, "transfer_ok": False},  # payout failed — never distribute
        {"student_id": "stu2", "amount": 0, "transfer_ok": True},     # zero amount — nothing to move
    ]
    await ld._record_pool_distribution(db, "sl_pooled3", winners, actor="a")

    wallet_service = ws.WalletService(db)
    balance = await pp.get_pool_balance(db, wallet_service, pool["_id"])
    assert balance == 300  # untouched


@pytest.mark.asyncio
async def test_record_pool_distribution_is_idempotent_per_student_session():
    db = _FakeDB()
    pool = await _make_pool(db, funded=300)
    await _make_session(db, session_id="sl_pooled4", prize_pool_id=pool["_id"])
    winners = [{"student_id": "stu1", "amount": 100, "transfer_ok": True}]

    await ld._record_pool_distribution(db, "sl_pooled4", winners, actor="a")
    await ld._record_pool_distribution(db, "sl_pooled4", winners, actor="a")  # simulate a retried finalize

    wallet_service = ws.WalletService(db)
    balance = await pp.get_pool_balance(db, wallet_service, pool["_id"])
    assert balance == 200  # only debited once, not 300 - 100 - 100


@pytest.mark.asyncio
async def test_record_pool_distribution_never_raises_on_empty_winners():
    db = _FakeDB()
    await ld._record_pool_distribution(db, "sl_whatever", [], actor="a")  # must not raise


# ═════════════════════════════════════════════════════════════════════════
# _run_draw — pool-funded session end-to-end (prepare phase only, no GAS)
# ═════════════════════════════════════════════════════════════════════════
async def _noop_publish(session_id, event):
    return None


@pytest.mark.asyncio
async def test_run_draw_uses_pool_balance_when_all_entry_fees_are_zero():
    """The exact scenario the funding-source migration exists for: students
    got lucky codes for free (entry_fee=0, unchanged join flow) and an
    admin funded the session's linked pool instead. Before this migration
    this would have hit 'Pool total is zero' and blocked the draw."""
    db = _FakeDB()
    pool = await _make_pool(db, funded=90)
    session_id = "sl_pooled5"
    await _make_session(db, session_id=session_id, entry_fee=0, prize_pool_id=pool["_id"])
    for i in range(3):
        await db["speaking_lab_lucky_codes"].insert_one({
            "session_id": session_id, "student_id": f"stu{i}", "display_name": f"Student {i}",
            "code": f"COD{i}", "entry_fee": 0, "awarded_at": "2026-01-01T00:00:00+00:00",
        })

    result = await ld._run_draw(
        db, _noop_publish, session_id, LuckyDrawConfig(),
        "", "", "", True, None, granted_by="admin@test",
    )
    assert result["pool_total"] == 90
    assert sum(w["amount"] for w in result["winners"]) <= 90
    assert sum(w["amount"] for w in result["winners"]) > 0


@pytest.mark.asyncio
async def test_run_draw_legacy_entry_fee_sessions_are_unaffected():
    """A session with NO prize_pool_id link behaves exactly as before —
    pool_total is the entry-fee sum, full stop."""
    db = _FakeDB()
    session_id = "sl_legacy3"
    await _make_session(db, session_id=session_id, entry_fee=10)
    for i in range(2):
        await db["speaking_lab_lucky_codes"].insert_one({
            "session_id": session_id, "student_id": f"stu{i}", "display_name": f"Student {i}",
            "code": f"LEG{i}", "entry_fee": 10, "awarded_at": "2026-01-01T00:00:00+00:00",
        })

    result = await ld._run_draw(
        db, _noop_publish, session_id, LuckyDrawConfig(),
        "", "", "", True, None, granted_by="admin@test",
    )
    assert result["pool_total"] == 20


@pytest.mark.asyncio
async def test_run_draw_still_blocks_zero_pool_for_unfunded_linked_pool():
    """A session linked to a pool that hasn't been funded yet still fails
    closed with the SAME "Pool total is zero" error — no silent fake payout."""
    from fastapi import HTTPException
    db = _FakeDB()
    pool = await _make_pool(db, funded=0)
    session_id = "sl_pooled6"
    await _make_session(db, session_id=session_id, entry_fee=0, prize_pool_id=pool["_id"])
    await db["speaking_lab_lucky_codes"].insert_one({
        "session_id": session_id, "student_id": "stu1", "display_name": "Stu One",
        "code": "ZZZ1", "entry_fee": 0, "awarded_at": "2026-01-01T00:00:00+00:00",
    })

    with pytest.raises(HTTPException) as exc:
        await ld._run_draw(
            db, _noop_publish, session_id, LuckyDrawConfig(),
            "", "", "", True, None, granted_by="admin@test",
        )
    assert exc.value.status_code == 400
    assert "zero" in exc.value.detail.lower()


# ═════════════════════════════════════════════════════════════════════════
# prize_pool.py — unlock / fund / link-session (the new admin capabilities)
# ═════════════════════════════════════════════════════════════════════════
@pytest.mark.asyncio
async def test_lock_then_unlock_pool_round_trip():
    db = _FakeDB()
    pool = await pp.create_pool(db, name="A", owner_type="speaking_lab_session", created_by="a")
    locked = await pp.lock_pool(db, pool["_id"], actor="a")
    assert locked["status"] == "locked"
    reopened = await pp.unlock_pool(db, pool["_id"], actor="a")
    assert reopened["status"] == "open"


@pytest.mark.asyncio
async def test_fund_pool_credits_without_debiting_any_wallet():
    db = _FakeDB()
    pool = await pp.create_pool(db, name="A", owner_type="speaking_lab_session", created_by="a")
    wallet_service = ws.WalletService(db)
    result = await pp.fund_pool(
        db, wallet_service, pool["_id"], amount=200,
        idempotency_key="fund-1", actor="admin@test", note="season budget",
    )
    assert result["ok"] is True
    balance = await pp.get_pool_balance(db, wallet_service, pool["_id"])
    assert balance == 200
    # No student wallet was touched — only the pool's own virtual wallet exists.
    assert db["points_wallets"]._docs == [
        {"student_id": pool["pool_wallet_id"], "balance": 200, "status": "active"},
    ] or len(db["points_wallets"]._docs) == 1


@pytest.mark.asyncio
async def test_fund_pool_rejects_when_not_open():
    db = _FakeDB()
    pool = await pp.create_pool(db, name="A", owner_type="speaking_lab_session", created_by="a")
    await pp.lock_pool(db, pool["_id"], actor="a")
    wallet_service = ws.WalletService(db)
    with pytest.raises(pp.PrizePoolError) as exc:
        await pp.fund_pool(db, wallet_service, pool["_id"], amount=50, idempotency_key="k", actor="a")
    assert exc.value.code == "pool_not_open"


@pytest.mark.asyncio
async def test_link_pool_to_session_stamps_prize_pool_id():
    db = _FakeDB()
    pool = await pp.create_pool(db, name="A", owner_type="speaking_lab_session", created_by="a")
    await _make_session(db, session_id="sl_link1")
    result = await pp.link_pool_to_session(db, pool["_id"], "sl_link1", actor="admin@test")
    assert result == {"pool_id": pool["_id"], "session_id": "sl_link1"}
    sess = await db["speaking_lab_sessions"].find_one({"session_id": "sl_link1"})
    assert sess["prize_pool_id"] == pool["_id"]


@pytest.mark.asyncio
async def test_link_pool_to_session_rejects_unknown_session():
    db = _FakeDB()
    pool = await pp.create_pool(db, name="A", owner_type="speaking_lab_session", created_by="a")
    with pytest.raises(pp.PrizePoolError) as exc:
        await pp.link_pool_to_session(db, pool["_id"], "sl_missing", actor="a")
    assert exc.value.code == "session_not_found"


@pytest.mark.asyncio
async def test_get_pool_for_session_returns_none_when_unlinked():
    db = _FakeDB()
    await _make_session(db, session_id="sl_unlinked")
    result = await pp.get_pool_for_session(db, "sl_unlinked")
    assert result is None


@pytest.mark.asyncio
async def test_get_pool_for_session_returns_linked_pool():
    db = _FakeDB()
    pool = await pp.create_pool(db, name="A", owner_type="speaking_lab_session", created_by="a")
    await _make_session(db, session_id="sl_linked2", prize_pool_id=pool["_id"])
    result = await pp.get_pool_for_session(db, "sl_linked2")
    assert result["_id"] == pool["_id"]


@pytest.mark.asyncio
async def test_link_pool_to_session_also_stamps_the_pool_side():
    db = _FakeDB()
    pool = await pp.create_pool(db, name="A", owner_type="speaking_lab_session", created_by="a")
    await _make_session(db, session_id="sl_bidir")
    await pp.link_pool_to_session(db, pool["_id"], "sl_bidir", actor="a")
    reloaded = await pp.get_pool(db, pool["_id"])
    assert reloaded["linked_session_id"] == "sl_bidir"


# ═════════════════════════════════════════════════════════════════════════
# Regression guard: Event Engine's auto-created companion pool must NEVER
# be auto-linked to a session — that would silently break the DEFAULT
# entry-fee funding model for every Event Engine event (the companion
# pool starts at balance 0, so _resolve_pool_total would return 0 instead
# of falling through to the entry-fee sum, and the draw would incorrectly
# fail "Pool total is zero" even though students genuinely paid).
# ═════════════════════════════════════════════════════════════════════════
@pytest.mark.asyncio
async def test_event_engine_entry_fee_event_is_not_broken_by_companion_pool():
    import event_engine as ee

    db = _FakeDB()
    tmpl = await ee.create_template(
        db, name="Weekly Speaking Lab", event_type="speaking_lab_session",
        content={"runtime_defaults": {"entry_fee": 10}}, created_by="admin@test",
    )
    await ee.publish_template(db, tmpl["_id"], updated_by="admin@test")
    event = await ee.create_event(db, template_id=tmpl["_id"], created_by="admin@test")
    assert event["prize_pool_id"] is not None  # companion pool exists...

    event = await ee.transition_event(db, db.speaking_lab_sessions, event["_id"], "scheduled", actor="a")
    event = await ee.transition_event(db, db.speaking_lab_sessions, event["_id"], "registration_open", actor="a")
    session_id = event["linked_session_id"]

    sess = await db.speaking_lab_sessions.find_one({"session_id": session_id})
    assert sess.get("prize_pool_id") is None  # ...but is NOT auto-linked to the session

    # Two students genuinely pay the entry fee (simulating the unchanged
    # speaking_lab_direct_join.py flow).
    for i in range(2):
        await db["speaking_lab_lucky_codes"].insert_one({
            "session_id": session_id, "student_id": f"stu{i}", "display_name": f"Student {i}",
            "code": f"ABC{i}", "entry_fee": 10, "awarded_at": "2026-01-01T00:00:00+00:00",
        })

    event = await ee.transition_event(db, db.speaking_lab_sessions, event["_id"], "live", actor="a")
    ctx = {"sl_publish": _noop_publish, "gas_url": "", "treasury_id": "", "treasury_password": "",
           "mock_gas": True, "log": None, "push_notify": None}
    event = await ee.transition_event(
        db, db.speaking_lab_sessions, event["_id"], "drawing", actor="admin@test", lucky_draw_ctx=ctx,
    )
    assert event["state"] == "drawing"  # did NOT fail "Pool total is zero"


@pytest.mark.asyncio
async def test_runtime_dashboard_reports_entry_fee_for_every_event_by_default():
    """Every event gets a companion pool at creation (event["prize_pool_id"]
    always set) — the dashboard must NOT mistake that for the session
    actually being funded by it. Only an explicit link changes the
    reported funding_source."""
    import event_engine as ee

    db = _FakeDB()
    tmpl = await ee.create_template(
        db, name="A", event_type="speaking_lab_session",
        content={"runtime_defaults": {"entry_fee": 10}}, created_by="a",
    )
    await ee.publish_template(db, tmpl["_id"], updated_by="a")
    event = await ee.create_event(db, template_id=tmpl["_id"], created_by="a")
    assert event["prize_pool_id"] is not None  # companion pool exists...
    event = await ee.transition_event(db, db.speaking_lab_sessions, event["_id"], "scheduled", actor="a")
    event = await ee.transition_event(db, db.speaking_lab_sessions, event["_id"], "registration_open", actor="a")

    dashboard = await ee.get_runtime_dashboard(db, db.speaking_lab_sessions, db.speaking_lab_entries)
    active = dashboard["active"][0]
    assert active["funding_source"] == "entry_fee"  # ...but is NOT reported as pool-funded
    assert active["prize_pool_balance"] is None


@pytest.mark.asyncio
async def test_runtime_dashboard_shows_live_prize_pool_balance_when_linked():
    import event_engine as ee

    db = _FakeDB()
    tmpl = await ee.create_template(
        db, name="A", event_type="speaking_lab_session",
        content={"runtime_defaults": {"entry_fee": 0}}, created_by="a",
    )
    await ee.publish_template(db, tmpl["_id"], updated_by="a")
    event = await ee.create_event(db, template_id=tmpl["_id"], created_by="a")
    event = await ee.transition_event(db, db.speaking_lab_sessions, event["_id"], "scheduled", actor="a")
    event = await ee.transition_event(db, db.speaking_lab_sessions, event["_id"], "registration_open", actor="a")

    wallet_service = ws.WalletService(db)
    await pp.fund_pool(
        db, wallet_service, event["prize_pool_id"], amount=300,
        idempotency_key="fund-dash-1", actor="admin@test",
    )
    await pp.link_pool_to_session(db, event["prize_pool_id"], event["linked_session_id"], actor="admin@test")

    dashboard = await ee.get_runtime_dashboard(db, db.speaking_lab_sessions, db.speaking_lab_entries)
    active = dashboard["active"][0]
    assert active["funding_source"] == "prize_pool"
    assert active["prize_pool_balance"] == 300
    assert active["estimated_prize_pool"] == 0  # entry_fee estimate still computed, just not the winning number


# ═════════════════════════════════════════════════════════════════════════
# Template Reward Pool — the single admin configuration action
# (set_template_reward_pool: create + fund + link, all automatic)
# ═════════════════════════════════════════════════════════════════════════
async def _published_template(db, *, name="Weekly Speaking Lab", entry_fee=0):
    import event_engine as ee
    tmpl = await ee.create_template(
        db, name=name, event_type="speaking_lab_session",
        content={"runtime_defaults": {"entry_fee": entry_fee}}, created_by="admin@test",
    )
    await ee.publish_template(db, tmpl["_id"], updated_by="admin@test")
    return tmpl


@pytest.mark.asyncio
async def test_set_template_reward_pool_creates_funds_and_stamps():
    import event_engine as ee
    db = _FakeDB()
    tmpl = await _published_template(db)
    result = await ee.set_template_reward_pool(
        db, tmpl["_id"], points=500, num_winners=3, split=[50, 30, 20], actor="admin@test",
    )
    assert result["balance"] == 500
    assert result["prize_policy"] == {"reward_pool_points": 500, "num_winners": 3, "split": [50, 30, 20]}

    reloaded = await ee.get_template(db, tmpl["_id"])
    assert reloaded["reward_pool_id"] == result["reward_pool_id"]
    pool = await pp.get_pool(db, result["reward_pool_id"])
    assert pool["owner_type"] == "event_template"
    assert pool["owner_ref"] == tmpl["_id"]
    assert pool["status"] == "open"


@pytest.mark.asyncio
async def test_set_template_reward_pool_top_up_semantics():
    """Re-saving the same number never double-funds; a higher number funds
    only the difference; a lower number never claws points back."""
    import event_engine as ee
    db = _FakeDB()
    tmpl = await _published_template(db)
    wallet_service = ws.WalletService(db)

    r1 = await ee.set_template_reward_pool(db, tmpl["_id"], points=500, actor="a")
    r2 = await ee.set_template_reward_pool(db, tmpl["_id"], points=500, actor="a")
    assert r2["balance"] == 500
    assert r2["reward_pool_id"] == r1["reward_pool_id"]  # same pool, not a second one

    r3 = await ee.set_template_reward_pool(db, tmpl["_id"], points=800, actor="a")
    assert r3["balance"] == 800

    r4 = await ee.set_template_reward_pool(db, tmpl["_id"], points=300, actor="a")
    assert r4["balance"] == 800  # never debits
    assert r4["prize_policy"]["reward_pool_points"] == 300  # but the configured target updates

    # Only two funding ledger entries exist (500, then +300 top-up)
    ledger = await pp.get_pool_ledger(db, wallet_service, r1["reward_pool_id"])
    fund_entries = [e for e in ledger if e.get("source") == "prize_pool_admin_fund"]
    assert len(fund_entries) == 2


@pytest.mark.asyncio
async def test_set_template_reward_pool_rejects_bad_input_and_archived():
    import event_engine as ee
    db = _FakeDB()
    tmpl = await _published_template(db)
    with pytest.raises(ee.EventEngineError) as exc:
        await ee.set_template_reward_pool(db, tmpl["_id"], points=-5, actor="a")
    assert exc.value.code == "invalid_points"
    with pytest.raises(ee.EventEngineError) as exc:
        await ee.set_template_reward_pool(db, tmpl["_id"], points=100, num_winners=9, actor="a")
    assert exc.value.code == "invalid_num_winners"

    await ee.archive_template(db, tmpl["_id"], updated_by="a")
    with pytest.raises(ee.EventEngineError) as exc:
        await ee.set_template_reward_pool(db, tmpl["_id"], points=100, actor="a")
    assert exc.value.code == "template_archived"


@pytest.mark.asyncio
async def test_new_session_from_reward_pool_template_auto_links_and_runtime_shows_pool():
    """The complete promised flow: admin saves Reward Pool 500 on the
    template -> teacher opens a session from it -> the Speaking Lab
    runtime pool endpoint immediately reports 500 with zero extra steps."""
    import event_engine as ee
    db = _FakeDB()
    tmpl = await _published_template(db)
    await ee.set_template_reward_pool(db, tmpl["_id"], points=500, num_winners=3, split=[50, 30, 20], actor="a")

    event = await ee.create_event(db, template_id=tmpl["_id"], created_by="teacher@test")
    event = await ee.transition_event(db, db.speaking_lab_sessions, event["_id"], "scheduled", actor="t")
    event = await ee.transition_event(db, db.speaking_lab_sessions, event["_id"], "registration_open", actor="t")

    reloaded_tmpl = await ee.get_template(db, tmpl["_id"])
    sess = await db.speaking_lab_sessions.find_one({"session_id": event["linked_session_id"]})
    assert sess["prize_pool_id"] == reloaded_tmpl["reward_pool_id"]  # auto-linked, no admin action

    # Speaking Lab runtime pool total = the configured Reward Pool
    total = await ld._resolve_pool_total(db, event["linked_session_id"], 0)
    assert total == 500

    dashboard = await ee.get_runtime_dashboard(db, db.speaking_lab_sessions, db.speaking_lab_entries)
    assert dashboard["active"][0]["prize_pool_balance"] == 500


@pytest.mark.asyncio
async def test_template_without_reward_pool_keeps_entry_fee_model():
    import event_engine as ee
    db = _FakeDB()
    tmpl = await _published_template(db, entry_fee=10)
    event = await ee.create_event(db, template_id=tmpl["_id"], created_by="t")
    event = await ee.transition_event(db, db.speaking_lab_sessions, event["_id"], "scheduled", actor="t")
    event = await ee.transition_event(db, db.speaking_lab_sessions, event["_id"], "registration_open", actor="t")
    sess = await db.speaking_lab_sessions.find_one({"session_id": event["linked_session_id"]})
    assert sess.get("prize_pool_id") is None
    assert await ld._resolve_pool_total(db, event["linked_session_id"], 30) == 30


@pytest.mark.asyncio
async def test_get_template_reward_pool_returns_policy_and_live_balance():
    import event_engine as ee
    db = _FakeDB()
    tmpl = await _published_template(db)
    before = await ee.get_template_reward_pool(db, tmpl["_id"])
    assert before == {"prize_policy": {}, "balance": None}

    await ee.set_template_reward_pool(db, tmpl["_id"], points=500, num_winners=2, split=[60, 40], actor="a")
    after = await ee.get_template_reward_pool(db, tmpl["_id"])
    assert after["balance"] == 500
    assert after["prize_policy"]["num_winners"] == 2


@pytest.mark.asyncio
async def test_dashboard_lucky_code_and_winner_counts():
    import event_engine as ee
    db = _FakeDB()
    tmpl = await _published_template(db)
    event = await ee.create_event(db, template_id=tmpl["_id"], created_by="t")
    event = await ee.transition_event(db, db.speaking_lab_sessions, event["_id"], "scheduled", actor="t")
    event = await ee.transition_event(db, db.speaking_lab_sessions, event["_id"], "registration_open", actor="t")
    sid = event["linked_session_id"]
    for i in range(4):
        await db.speaking_lab_lucky_codes.insert_one({
            "session_id": sid, "student_id": f"stu{i}", "code": f"C{i}", "entry_fee": 0,
        })
    await db.speaking_lab_lucky_draws.insert_one({
        "draw_id": "draw-1", "session_id": sid, "finalized": True,
        "results": [{"student_id": "stu0"}, {"student_id": "stu1"}],
    })
    dashboard = await ee.get_runtime_dashboard(db, db.speaking_lab_sessions, db.speaking_lab_entries)
    active = dashboard["active"][0]
    assert active["lucky_code_count"] == 4
    assert active["winner_count"] == 2
