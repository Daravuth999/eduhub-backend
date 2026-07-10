"""
Tests for speaking_lab_wallet_payout.py — the LOCAL DARK WalletService
payout transport for Speaking Lab Lucky Draw.

This module is NEVER wired into the live route registration (confirmed by
grep in test_25_never_imported_by_server below) and is gated behind
speaking_lab_feature_flags.wallet_payout_enabled (always False in
production). These tests exercise the REAL production
speaking_lab_wallet_payout.py / lucky_draw.py / wallet_service.py code
against a fake Mongo harness that supports both array_filters (needed by
lucky_draw's per-winner claim helpers) and caller-owned sessions (needed
by wallet_service.transfer).
"""
import ast
import copy
import hashlib
import os

import pytest

import lucky_draw as ld
import wallet_service as ws
import speaking_lab_wallet_payout as swp


# ─────────────────────────────────────────────────────────────────────────────
# Fake Mongo harness: array_filters (lucky_draw winner claims) + sessions
# (wallet_service transfer), whole-DB snapshot/restore for rollback proof.
# ─────────────────────────────────────────────────────────────────────────────
def _match(doc, query):
    for k, v in query.items():
        if k in ("$and", "$or"):
            continue
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


def _match_elem(elem, array_filters):
    if not array_filters:
        return True
    af = array_filters[0]
    for k, v in af.items():
        _, field = k.split(".", 1)
        actual = elem.get(field)
        if isinstance(v, dict) and any(op in v for op in ("$in", "$ne", "$gte", "$lte", "$gt", "$lt")):
            if "$in" in v and actual not in v["$in"]:
                return False
            if "$ne" in v and actual == v["$ne"]:
                return False
            if "$gte" in v and not ((actual if actual is not None else "") >= v["$gte"]):
                return False
            if "$lte" in v and not ((actual if actual is not None else "") <= v["$lte"]):
                return False
            if "$gt" in v and not ((actual if actual is not None else "") > v["$gt"]):
                return False
            if "$lt" in v and not ((actual if actual is not None else "") < v["$lt"]):
                return False
        elif actual != v:
            return False
    return True


class _Result:
    def __init__(self, matched=0, modified=0, inserted_id=None, upserted_id=None):
        self.matched_count = matched
        self.modified_count = modified
        self.inserted_id = inserted_id
        self.upserted_id = upserted_id


class _Cursor:
    def __init__(self, docs):
        self._docs = docs

    def sort(self, field, direction=1):
        self._docs.sort(key=lambda d: d.get(field) or "", reverse=(direction < 0))
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


class _FakeCollection:
    def __init__(self, name):
        self.name = name
        self._docs: list[dict] = []
        self.fail_predicate = None  # callable(update) -> bool, injected failure

    async def create_index(self, *a, **k):
        return "idx"

    async def insert_one(self, doc, session=None):
        d = copy.deepcopy(doc)
        self._docs.append(d)
        return _Result(inserted_id="x")

    async def insert_many(self, docs, session=None):
        for doc in docs:
            await self.insert_one(doc, session=session)
        return _Result()

    async def find_one(self, query, projection=None, session=None, sort=None):
        docs = [d for d in self._docs if _match(d, query)]
        if sort:
            for field, direction in reversed(sort):
                docs.sort(key=lambda d: d.get(field) or "", reverse=(direction < 0))
        return copy.deepcopy(docs[0]) if docs else None

    def find(self, query, projection=None, session=None):
        return _Cursor([copy.deepcopy(d) for d in self._docs if _match(d, query)])

    async def count_documents(self, query, session=None, **kw):
        return sum(1 for d in self._docs if _match(d, query))

    async def update_one(self, query, update, array_filters=None, upsert=False, session=None):
        if self.fail_predicate and self.fail_predicate(update):
            raise RuntimeError("injected persistence failure")
        target = next((d for d in self._docs if _match(d, query)), None)
        if target is None:
            if upsert:
                nd = {k: v for k, v in query.items() if not isinstance(v, dict)}
                nd.update(update.get("$set", {}))
                self._docs.append(nd)
                return _Result(matched=1, modified=1, upserted_id="new")
            return _Result()
        before = copy.deepcopy(target)
        changed = self._apply(target, update, array_filters or [])
        return _Result(matched=1, modified=1 if changed else 0)

    async def find_one_and_update(self, query, update, return_document=None,
                                  projection=None, session=None, upsert=False,
                                  array_filters=None):
        target = next((d for d in self._docs if _match(d, query)), None)
        if target is None:
            if upsert:
                nd = {k: v for k, v in query.items() if not isinstance(v, dict)}
                nd.update(update.get("$set", {}))
                nd.update(update.get("$setOnInsert", {}))
                self._docs.append(nd)
                target = nd
            else:
                return None
        self._apply(target, update, array_filters or [])
        if projection:
            keep = {k for k, v in projection.items() if v}
            return {k: v for k, v in target.items() if k in keep or k == "_id"}
        return copy.deepcopy(target)

    def _apply(self, doc, update, array_filters) -> bool:
        changed = False
        matched_ids: dict[str, set] = {}
        for op, fields in update.items():
            for key in fields:
                if ".$[" in key:
                    arr_field = key.split(".$[", 1)[0]
                    if arr_field not in matched_ids:
                        ids = set()
                        for i, elem in enumerate(doc.get(arr_field, [])):
                            if _match_elem(elem, array_filters):
                                ids.add(i)
                        matched_ids[arr_field] = ids
        for op, fields in update.items():
            for key, val in fields.items():
                if ".$[" in key:
                    arr_field = key.split(".$[", 1)[0]
                    sub = key.rsplit(".", 1)[1]
                    for i in matched_ids.get(arr_field, set()):
                        elem = doc[arr_field][i]
                        if op == "$set":
                            if elem.get(sub) != val:
                                elem[sub] = val
                                changed = True
                        elif op == "$inc":
                            elem[sub] = (elem.get(sub) or 0) + val
                            changed = True
                else:
                    if op == "$set":
                        if doc.get(key) != val:
                            doc[key] = val
                            changed = True
                    elif op == "$inc":
                        doc[key] = (doc.get(key) or 0) + val
                        changed = True
        return changed


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


class _FakeSession:
    def __init__(self, db):
        self.db = db

    async def __aenter__(self):
        return self

    async def __aexit__(self, *a):
        return False

    async def with_transaction(self, callback, **kw):
        snapshot = self.db._snapshot()
        try:
            return await callback(self)
        except Exception:
            self.db._restore(snapshot)
            raise


class _FakeClient:
    def __init__(self, db):
        self.db = db

    async def start_session(self):
        return _FakeSession(self.db)


@pytest.fixture(autouse=True)
def _force_transactions_supported():
    prev = ws.MONGO_SUPPORTS_TRANSACTIONS
    ws.MONGO_SUPPORTS_TRANSACTIONS = True
    yield
    ws.MONGO_SUPPORTS_TRANSACTIONS = prev


@pytest.fixture(autouse=True)
def _clean_env():
    saved = os.environ.get("SPEAKING_LAB_WALLET_PAYOUT_ENABLED")
    yield
    if saved is None:
        os.environ.pop("SPEAKING_LAB_WALLET_PAYOUT_ENABLED", None)
    else:
        os.environ["SPEAKING_LAB_WALLET_PAYOUT_ENABLED"] = saved


TREASURY = "stu092"


async def _seed_wallet(db, student_id, balance):
    await db["points_wallets"].insert_one({
        "student_id": student_id, "balance": balance, "status": "active",
    })


async def _seed_prepared_draw(db, *, draw_id="draw-1", session_id="sess-1", winners=None):
    winners = winners or [{
        "student_id": "stuA", "display_name": "A", "code": "STAR-1", "amount": 50,
        "transfer_state": ld.TRANSFER_PENDING, "transfer_ok": None, "transfer_err": "",
        "transfer_attempt_id": "", "transfer_reference": "", "transfer_retry_count": 0,
        "push_notification_state": None, "push_notification_attempt_id": "",
    }]
    await db["speaking_lab_draws"].insert_one({
        "draw_id": draw_id, "session_id": session_id, "results": winners,
    })
    return draw_id


def _build_db():
    return _FakeDB()


class PushRecorder:
    def __init__(self, mode="sent"):
        self.mode = mode
        self.calls = []

    async def __call__(self, student_id, amount, code):
        self.calls.append((student_id, amount, code))
        if self.mode == "raise":
            raise RuntimeError("push infra exception")
        if self.mode == "no_subscribers":
            return {"attempted": False, "sent": 0, "failed": 0, "no_subscribers": True, "error": ""}
        if self.mode == "failed":
            return {"attempted": True, "sent": 0, "failed": 1, "no_subscribers": False, "error": "delivery failed"}
        return {"attempted": True, "sent": 1, "failed": 0, "no_subscribers": False, "error": ""}


def _winner(draw, student_id):
    for w in draw["results"]:
        if w["student_id"] == student_id:
            return w
    return None


# ─────────────────────────────────────────────────────────────────────────────
# 1. Successful wallet payout: exactly one transfer, wallet balances correct,
#    winner marked paid, push sent exactly once.
# ─────────────────────────────────────────────────────────────────────────────
@pytest.mark.asyncio
async def test_1_successful_payout_moves_funds_and_marks_paid():
    db = _build_db()
    await _seed_wallet(db, TREASURY, 1000)
    await _seed_wallet(db, "stua", 0)
    draw_id = await _seed_prepared_draw(db)
    push = PushRecorder()

    result = await swp.process_winner_wallet_transport(
        db, db["speaking_lab_draws"], None, "sess-1", draw_id, 0,
        {"student_id": "stuA", "code": "STAR-1", "amount": 50},
        TREASURY, False, None, push, mode="initial",
    )

    assert result["transfer_state"] == ld.TRANSFER_PAID
    assert result["transfer_ok"] is True
    assert result["transfer_transport"] == "wallet"

    treasury_wallet = await db["points_wallets"].find_one({"student_id": TREASURY})
    student_wallet = await db["points_wallets"].find_one({"student_id": "stua"})
    assert treasury_wallet["balance"] == 950
    assert student_wallet["balance"] == 50

    txns = [d for d in db["points_transactions"]._docs]
    assert len(txns) == 2  # debit leg + credit leg of the transfer
    assert push.calls == [("stuA", 50, "STAR-1")]


# ─────────────────────────────────────────────────────────────────────────────
# 2. Insufficient treasury funds -> failed_safe_to_retry, NO wallet mutation.
# ─────────────────────────────────────────────────────────────────────────────
@pytest.mark.asyncio
async def test_2_insufficient_treasury_funds_is_retryable_no_mutation():
    db = _build_db()
    await _seed_wallet(db, TREASURY, 10)  # not enough for a 50-point payout
    await _seed_wallet(db, "stua", 0)
    draw_id = await _seed_prepared_draw(db)
    push = PushRecorder()

    result = await swp.process_winner_wallet_transport(
        db, db["speaking_lab_draws"], None, "sess-1", draw_id, 0,
        {"student_id": "stuA", "code": "STAR-1", "amount": 50},
        TREASURY, False, None, push, mode="initial",
    )

    assert result["transfer_state"] == ld.TRANSFER_FAILED_RETRY
    assert result["transfer_ok"] is False
    treasury_wallet = await db["points_wallets"].find_one({"student_id": TREASURY})
    student_wallet = await db["points_wallets"].find_one({"student_id": "stua"})
    assert treasury_wallet["balance"] == 10
    assert student_wallet["balance"] == 0
    assert push.calls == []  # never paid -> push never attempted


# ─────────────────────────────────────────────────────────────────────────────
# 3. Retry after failed_safe_to_retry succeeds once treasury is topped up.
# ─────────────────────────────────────────────────────────────────────────────
@pytest.mark.asyncio
async def test_3_retry_succeeds_after_treasury_topped_up():
    db = _build_db()
    await _seed_wallet(db, TREASURY, 10)
    await _seed_wallet(db, "stua", 0)
    draw_id = await _seed_prepared_draw(db)
    push = PushRecorder()

    await swp.process_winner_wallet_transport(
        db, db["speaking_lab_draws"], None, "sess-1", draw_id, 0,
        {"student_id": "stuA", "code": "STAR-1", "amount": 50},
        TREASURY, False, None, push, mode="initial",
    )
    await db["points_wallets"].update_one(
        {"student_id": TREASURY}, {"$set": {"balance": 1000}})  # top-up

    result = await swp.process_winner_wallet_transport(
        db, db["speaking_lab_draws"], None, "sess-1", draw_id, 0,
        {"student_id": "stuA", "code": "STAR-1", "amount": 50},
        TREASURY, False, None, push, mode="retry",
    )

    assert result["transfer_state"] == ld.TRANSFER_PAID
    student_wallet = await db["points_wallets"].find_one({"student_id": "stua"})
    assert student_wallet["balance"] == 50
    assert push.calls == [("stuA", 50, "STAR-1")]


# ─────────────────────────────────────────────────────────────────────────────
# 4. Same idempotency key never charges twice even if called again in the
#    "initial" mode after already paid (claim guard rejects; no re-transfer).
# ─────────────────────────────────────────────────────────────────────────────
@pytest.mark.asyncio
async def test_4_double_initial_call_never_double_charges():
    db = _build_db()
    await _seed_wallet(db, TREASURY, 1000)
    await _seed_wallet(db, "stua", 0)
    draw_id = await _seed_prepared_draw(db)
    push = PushRecorder()

    await swp.process_winner_wallet_transport(
        db, db["speaking_lab_draws"], None, "sess-1", draw_id, 0,
        {"student_id": "stuA", "code": "STAR-1", "amount": 50},
        TREASURY, False, None, push, mode="initial",
    )
    result2 = await swp.process_winner_wallet_transport(
        db, db["speaking_lab_draws"], None, "sess-1", draw_id, 0,
        {"student_id": "stuA", "code": "STAR-1", "amount": 50},
        TREASURY, False, None, push, mode="initial",  # not a valid retry state
    )

    assert result2["transfer_state"] == ld.TRANSFER_PAID  # unchanged, already paid
    student_wallet = await db["points_wallets"].find_one({"student_id": "stua"})
    assert student_wallet["balance"] == 50  # still only paid once
    assert len(push.calls) == 1  # push not re-sent


# ─────────────────────────────────────────────────────────────────────────────
# 5. use_mock=True never touches WalletService at all.
# ─────────────────────────────────────────────────────────────────────────────
@pytest.mark.asyncio
async def test_5_mock_mode_never_calls_wallet():
    db = _build_db()
    await _seed_wallet(db, TREASURY, 1000)
    await _seed_wallet(db, "stua", 0)
    draw_id = await _seed_prepared_draw(db)
    push = PushRecorder()

    result = await swp.process_winner_wallet_transport(
        db, db["speaking_lab_draws"], None, "sess-1", draw_id, 0,
        {"student_id": "stuA", "code": "STAR-1", "amount": 50},
        TREASURY, True, None, push, mode="initial",
    )

    assert result["transfer_state"] == ld.TRANSFER_MOCK
    treasury_wallet = await db["points_wallets"].find_one({"student_id": TREASURY})
    assert treasury_wallet["balance"] == 1000  # untouched


# ─────────────────────────────────────────────────────────────────────────────
# 6. Unexpected wallet exception is conservatively quarantined as manual_review,
#    never silently marked paid.
# ─────────────────────────────────────────────────────────────────────────────
@pytest.mark.asyncio
async def test_6_unexpected_wallet_error_is_manual_review(monkeypatch):
    db = _build_db()
    await _seed_wallet(db, TREASURY, 1000)
    await _seed_wallet(db, "stua", 0)
    draw_id = await _seed_prepared_draw(db)
    push = PushRecorder()

    async def _boom(*a, **k):
        raise RuntimeError("simulated unexpected wallet failure")

    monkeypatch.setattr(ws.WalletService, "transfer", _boom)

    result = await swp.process_winner_wallet_transport(
        db, db["speaking_lab_draws"], None, "sess-1", draw_id, 0,
        {"student_id": "stuA", "code": "STAR-1", "amount": 50},
        TREASURY, False, None, push, mode="initial",
    )

    assert result["transfer_state"] == ld.TRANSFER_MANUAL
    assert push.calls == []


# ─────────────────────────────────────────────────────────────────────────────
# 7. Manual-release path: operator override from manual_review re-attempts
#    and can succeed.
# ─────────────────────────────────────────────────────────────────────────────
@pytest.mark.asyncio
async def test_7_manual_release_retries_and_succeeds(monkeypatch):
    db = _build_db()
    await _seed_wallet(db, TREASURY, 1000)
    await _seed_wallet(db, "stua", 0)
    draw_id = await _seed_prepared_draw(db)
    push = PushRecorder()

    async def _boom(*a, **k):
        raise RuntimeError("simulated unexpected wallet failure")

    monkeypatch.setattr(ws.WalletService, "transfer", _boom)
    await swp.process_winner_wallet_transport(
        db, db["speaking_lab_draws"], None, "sess-1", draw_id, 0,
        {"student_id": "stuA", "code": "STAR-1", "amount": 50},
        TREASURY, False, None, push, mode="initial",
    )
    monkeypatch.undo()

    result = await swp.process_winner_wallet_transport(
        db, db["speaking_lab_draws"], None, "sess-1", draw_id, 0,
        {"student_id": "stuA", "code": "STAR-1", "amount": 50},
        TREASURY, False, None, push, mode="manual_release",
    )

    assert result["transfer_state"] == ld.TRANSFER_PAID
    student_wallet = await db["points_wallets"].find_one({"student_id": "stua"})
    assert student_wallet["balance"] == 50


# ─────────────────────────────────────────────────────────────────────────────
# 8. Feature flag defaults OFF (env var absent / false) — the module itself
#    performs no gating (gating belongs to the caller/route), but confirm the
#    flags module agrees this transport must stay disabled by default.
# ─────────────────────────────────────────────────────────────────────────────
@pytest.mark.asyncio
async def test_8_wallet_payout_flag_defaults_off():
    import speaking_lab_feature_flags as flags
    db = _build_db()
    os.environ.pop("SPEAKING_LAB_WALLET_PAYOUT_ENABLED", None)
    assert await flags.wallet_payout_enabled(db) is False
    os.environ["SPEAKING_LAB_WALLET_PAYOUT_ENABLED"] = "true"
    assert await flags.wallet_payout_enabled(db) is False  # DB doc still missing -> AND-gate off


# ─────────────────────────────────────────────────────────────────────────────
# 9. Concurrency: two simultaneous "initial" claims on the same winner ->
#    exactly one wallet transfer executes.
# ─────────────────────────────────────────────────────────────────────────────
@pytest.mark.asyncio
async def test_9_concurrent_initial_claims_yield_exactly_one_transfer():
    import asyncio
    db = _build_db()
    await _seed_wallet(db, TREASURY, 1000)
    await _seed_wallet(db, "stua", 0)
    draw_id = await _seed_prepared_draw(db)
    push = PushRecorder()
    barrier = asyncio.Event()
    arrived = {"n": 0}

    orig_claim = ld._claim_winner_initial

    async def _gated_claim(*a, **k):
        arrived["n"] += 1
        if arrived["n"] == 1:
            await barrier.wait()
        else:
            barrier.set()
        return await orig_claim(*a, **k)

    import unittest.mock as _mock
    with _mock.patch.object(ld, "_claim_winner_initial", _gated_claim):
        r1, r2 = await asyncio.gather(
            swp.process_winner_wallet_transport(
                db, db["speaking_lab_draws"], None, "sess-1", draw_id, 0,
                {"student_id": "stuA", "code": "STAR-1", "amount": 50},
                TREASURY, False, None, push, mode="initial"),
            swp.process_winner_wallet_transport(
                db, db["speaking_lab_draws"], None, "sess-1", draw_id, 0,
                {"student_id": "stuA", "code": "STAR-1", "amount": 50},
                TREASURY, False, None, push, mode="initial"),
        )

    treasury_wallet = await db["points_wallets"].find_one({"student_id": TREASURY})
    assert treasury_wallet["balance"] == 950  # exactly one 50-point payout
    txns = db["points_transactions"]._docs
    assert len(txns) == 2  # one transfer = one debit + one credit leg


# ─────────────────────────────────────────────────────────────────────────────
# 10. This module is never imported by server.py's live route registration —
#     it is a dark, standalone module with zero production wiring.
# ─────────────────────────────────────────────────────────────────────────────
def test_10_never_wired_into_server_py():
    with open("server.py", encoding="utf-8") as f:
        src = f.read()
    assert "speaking_lab_wallet_payout" not in src


# ─────────────────────────────────────────────────────────────────────────────
# 11. Protected function _process_winner (the LIVE GAS payout path) and its
#     module-level constants are completely untouched by this addition.
# ─────────────────────────────────────────────────────────────────────────────
def _hash_function_source(path, func_name):
    with open(path, encoding="utf-8") as f:
        src = f.read()
    tree = ast.parse(src)
    for node in ast.walk(tree):
        if isinstance(node, (ast.FunctionDef, ast.AsyncFunctionDef)) and node.name == func_name:
            segment = ast.get_source_segment(src, node)
            return hashlib.sha256(segment.encode("utf-8")).hexdigest()
    raise AssertionError(f"function {func_name} not found in {path}")


_PROCESS_WINNER_BASELINE_SHA256 = (
    "1fbfdc04aeca92137dbe3bd006ffcc20b2861e5ad78aadf10774786b96de0ebe"
)


def test_11_process_winner_unchanged():
    # Baseline captured from lucky_draw.py's real _process_winner (the LIVE
    # GAS payout path, with its 6 call sites) at the moment
    # speaking_lab_wallet_payout.py was written — proves the new dark module
    # made zero edits to it.
    digest = _hash_function_source("lucky_draw.py", "_process_winner")
    assert digest == _PROCESS_WINNER_BASELINE_SHA256
