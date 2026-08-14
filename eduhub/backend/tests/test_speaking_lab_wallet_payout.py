"""
Tests for speaking_lab_wallet_payout.py and lucky_draw._select_transfer_outcome
— the transport-selection seam that lets `_process_winner`'s existing,
UNCHANGED state machine (claim / persist / push / retry / manual-review)
call either the live GAS transfer or a WalletService transfer, gated
behind speaking_lab_wallet_payout_enabled (AND-gated env + DB doc, off by
default).

speaking_lab_wallet_payout.py is intentionally tiny — it does NOT
duplicate `_process_winner`'s state machine. These tests exercise the
REAL production `_process_winner` (all 6 of its real call sites reuse it
unmodified) through a fake Mongo harness that supports both array_filters
(lucky_draw's per-winner claim helpers) and caller-owned sessions
(wallet_service.transfer).
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
    keys = ("SPEAKING_LAB_WALLET_PAYOUT_ENABLED",)
    saved = {k: os.environ.get(k) for k in keys}
    yield
    for k, v in saved.items():
        if v is None:
            os.environ.pop(k, None)
        else:
            os.environ[k] = v


TREASURY = "stu092"


async def _seed_wallet(db, student_id, balance):
    await db["points_wallets"].insert_one({
        "student_id": student_id, "balance": balance, "status": "active",
    })


async def _enable_wallet_payout(db):
    os.environ["SPEAKING_LAB_WALLET_PAYOUT_ENABLED"] = "true"
    await db["speaking_lab_settings"].insert_one({
        "_id": "feature_flags", "speaking_lab_wallet_payout_enabled": True,
    })


async def _seed_prepared_draw(db, *, draw_id="draw-1", session_id="sess-1", winners=None):
    winners = winners or [{
        "student_id": "stua", "display_name": "A", "code": "STAR-1", "amount": 50,
        "transfer_state": ld.TRANSFER_PENDING, "transfer_ok": None, "transfer_err": "",
        "transfer_attempt_id": "", "transfer_reference": "", "transfer_retry_count": 0,
        "push_notification_state": None, "push_notification_attempt_id": "",
    }]
    await db["speaking_lab_lucky_draws"].insert_one({
        "draw_id": draw_id, "session_id": session_id, "results": winners, "finalized": True,
        "finalized_at": "2026-01-01T00:00:00+00:00",
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


async def _process_winner(db, SL_DRAWS, session_id, draw_id, rec, push, *, mode,
                           use_mock=False, treasury=TREASURY):
    """Thin wrapper around the REAL, unmodified _process_winner so every
    test below exercises the actual production state machine, not a
    reimplementation."""
    return await ld._process_winner(
        db, SL_DRAWS, None, session_id, draw_id, 0, rec,
        "https://gas.example.test", treasury, "irrelevant-legacy-password",
        use_mock, None, push, mode=mode,
    )


def _winner(draw, student_id):
    for w in draw["results"]:
        if w["student_id"] == student_id:
            return w
    return None


# ═════════════════════════════════════════════════════════════════════════
# Part A — wallet_transfer_outcome() unit tests (the pure transport function)
# ═════════════════════════════════════════════════════════════════════════
@pytest.mark.asyncio
async def test_a1_successful_transfer_outcome_moves_funds():
    db = _build_db()
    await _seed_wallet(db, TREASURY, 1000)
    await _seed_wallet(db, "stua", 0)

    result = await swp.wallet_transfer_outcome(
        db, TREASURY, "stua", 50, stable_reference="ref1", attempt_id="a1")

    assert result["outcome"] == ld.TRANSFER_PAID
    treasury_wallet = await db["points_wallets"].find_one({"student_id": TREASURY})
    student_wallet = await db["points_wallets"].find_one({"student_id": "stua"})
    assert treasury_wallet["balance"] == 950
    assert student_wallet["balance"] == 50


@pytest.mark.asyncio
async def test_a2_insufficient_funds_outcome_no_mutation():
    db = _build_db()
    await _seed_wallet(db, TREASURY, 10)
    await _seed_wallet(db, "stua", 0)

    result = await swp.wallet_transfer_outcome(
        db, TREASURY, "stua", 50, stable_reference="ref1", attempt_id="a1")

    assert result["outcome"] == ld.TRANSFER_FAILED_RETRY
    treasury_wallet = await db["points_wallets"].find_one({"student_id": TREASURY})
    assert treasury_wallet["balance"] == 10


@pytest.mark.asyncio
async def test_a3_unexpected_error_is_manual_review(monkeypatch):
    db = _build_db()
    await _seed_wallet(db, TREASURY, 1000)
    await _seed_wallet(db, "stua", 0)

    async def _boom(*a, **k):
        raise RuntimeError("simulated unexpected wallet failure")

    monkeypatch.setattr(ws.WalletService, "transfer", _boom)
    result = await swp.wallet_transfer_outcome(
        db, TREASURY, "stua", 50, stable_reference="ref1", attempt_id="a1")

    assert result["outcome"] == ld.TRANSFER_MANUAL


# ═════════════════════════════════════════════════════════════════════════
# Part B — the transport-selection seam (lucky_draw._select_transfer_outcome)
# ═════════════════════════════════════════════════════════════════════════
@pytest.mark.asyncio
async def test_b1_flag_off_calls_provider_transfer_with_identical_args(monkeypatch):
    """Flag OFF (default): the seam must call _provider_transfer with the
    EXACT SAME arguments it always did — proving byte-for-byte parity with
    pre-existing GAS behavior. WalletService is never touched."""
    db = _build_db()
    calls = []

    async def _fake_provider_transfer(gas_url, treasury_id, treasury_password,
                                       receiver_clean_id, amount, *, use_mock,
                                       stable_reference, attempt_id, log=None):
        calls.append((gas_url, treasury_id, treasury_password, receiver_clean_id,
                      amount, use_mock, stable_reference, attempt_id))
        return {"outcome": ld.TRANSFER_PAID, "provider_status": "success",
                "provider_reference": "GASTX-1", "error": ""}

    monkeypatch.setattr(ld, "_provider_transfer", _fake_provider_transfer)
    wallet_calls = []
    orig_wallet_transfer = swp.wallet_transfer_outcome

    async def _spy_wallet_transfer(*a, **k):
        wallet_calls.append((a, k))
        return await orig_wallet_transfer(*a, **k)

    monkeypatch.setattr(swp, "wallet_transfer_outcome", _spy_wallet_transfer)

    result = await ld._select_transfer_outcome(
        db, "https://gas.example.test", TREASURY, "pw", "stua", 50,
        use_mock=False, stable_reference="ref-x", attempt_id="att-x", log=None,
    )

    assert result["outcome"] == ld.TRANSFER_PAID
    assert calls == [("https://gas.example.test", TREASURY, "pw", "stua", 50,
                      False, "ref-x", "att-x")]
    assert wallet_calls == []  # WalletService transport never invoked


@pytest.mark.asyncio
async def test_b2_flag_on_calls_wallet_transfer_outcome_instead(monkeypatch):
    db = _build_db()
    await _enable_wallet_payout(db)
    await _seed_wallet(db, TREASURY, 1000)
    await _seed_wallet(db, "stua", 0)

    provider_calls = []

    async def _fake_provider_transfer(*a, **k):
        provider_calls.append((a, k))
        raise AssertionError("GAS provider must not be called while flag is on")

    monkeypatch.setattr(ld, "_provider_transfer", _fake_provider_transfer)

    result = await ld._select_transfer_outcome(
        db, "https://gas.example.test", TREASURY, "pw", "stua", 50,
        use_mock=False, stable_reference="ref-y", attempt_id="att-y", log=None,
    )

    assert result["outcome"] == ld.TRANSFER_PAID
    assert provider_calls == []
    treasury_wallet = await db["points_wallets"].find_one({"student_id": TREASURY})
    assert treasury_wallet["balance"] == 950


@pytest.mark.asyncio
async def test_b3_flag_check_error_fails_safe_to_gas(monkeypatch):
    """If the flag lookup itself errors, the seam must default OFF (GAS
    path) — never silently fall through to moving real wallet funds."""
    db = _build_db()

    async def _boom_flag_check(*a, **k):
        raise RuntimeError("settings collection unreachable")

    import speaking_lab_feature_flags as flags
    monkeypatch.setattr(flags, "wallet_payout_enabled", _boom_flag_check)

    provider_calls = []

    async def _fake_provider_transfer(*a, **k):
        provider_calls.append((a, k))
        return {"outcome": ld.TRANSFER_PAID, "provider_status": "success",
                "provider_reference": "GASTX-1", "error": ""}

    monkeypatch.setattr(ld, "_provider_transfer", _fake_provider_transfer)

    result = await ld._select_transfer_outcome(
        db, "https://gas.example.test", TREASURY, "pw", "stua", 50,
        use_mock=False, stable_reference="ref-z", attempt_id="att-z", log=None,
    )

    assert result["outcome"] == ld.TRANSFER_PAID
    assert len(provider_calls) == 1  # fell back to GAS, not wallet


# ═════════════════════════════════════════════════════════════════════════
# Part C — full _process_winner state machine with the wallet flag ON
# ═════════════════════════════════════════════════════════════════════════
@pytest.mark.asyncio
async def test_c1_normal_finalize_uses_wallet_transport():
    db = _build_db()
    await _enable_wallet_payout(db)
    await _seed_wallet(db, TREASURY, 1000)
    await _seed_wallet(db, "stua", 0)
    draw_id = await _seed_prepared_draw(db)
    push = PushRecorder()
    SL_DRAWS = db["speaking_lab_lucky_draws"]

    result = await _process_winner(
        db, SL_DRAWS, "sess-1", draw_id,
        {"student_id": "stua", "code": "STAR-1", "amount": 50}, push, mode="initial",
    )

    assert result["transfer_state"] == ld.TRANSFER_PAID
    assert result["transfer_provider_status"] == "wallet_transfer_ok"
    student_wallet = await db["points_wallets"].find_one({"student_id": "stua"})
    treasury_wallet = await db["points_wallets"].find_one({"student_id": TREASURY})
    assert student_wallet["balance"] == 50
    assert treasury_wallet["balance"] == 950
    assert push.calls == [("stua", 50, "STAR-1")]


@pytest.mark.asyncio
async def test_c2_retry_uses_wallet_transport_safely():
    db = _build_db()
    await _enable_wallet_payout(db)
    await _seed_wallet(db, TREASURY, 10)  # insufficient at first
    await _seed_wallet(db, "stua", 0)
    draw_id = await _seed_prepared_draw(db)
    push = PushRecorder()
    SL_DRAWS = db["speaking_lab_lucky_draws"]

    first = await _process_winner(
        db, SL_DRAWS, "sess-1", draw_id,
        {"student_id": "stua", "code": "STAR-1", "amount": 50}, push, mode="initial",
    )
    assert first["transfer_state"] == ld.TRANSFER_FAILED_RETRY

    await db["points_wallets"].update_one(
        {"student_id": TREASURY}, {"$set": {"balance": 1000}})

    second = await _process_winner(
        db, SL_DRAWS, "sess-1", draw_id,
        {"student_id": "stua", "code": "STAR-1", "amount": 50}, push, mode="retry",
    )

    assert second["transfer_state"] == ld.TRANSFER_PAID
    student_wallet = await db["points_wallets"].find_one({"student_id": "stua"})
    assert student_wallet["balance"] == 50  # paid exactly once overall


@pytest.mark.asyncio
async def test_c3_manual_release_uses_wallet_transport(monkeypatch):
    db = _build_db()
    await _enable_wallet_payout(db)
    await _seed_wallet(db, TREASURY, 1000)
    await _seed_wallet(db, "stua", 0)
    draw_id = await _seed_prepared_draw(db)
    push = PushRecorder()
    SL_DRAWS = db["speaking_lab_lucky_draws"]

    async def _boom(*a, **k):
        raise RuntimeError("simulated unexpected wallet failure")

    monkeypatch.setattr(ws.WalletService, "transfer", _boom)
    first = await _process_winner(
        db, SL_DRAWS, "sess-1", draw_id,
        {"student_id": "stua", "code": "STAR-1", "amount": 50}, push, mode="initial",
    )
    assert first["transfer_state"] == ld.TRANSFER_MANUAL
    monkeypatch.undo()

    second = await _process_winner(
        db, SL_DRAWS, "sess-1", draw_id,
        {"student_id": "stua", "code": "STAR-1", "amount": 50}, push, mode="manual_release",
    )

    assert second["transfer_state"] == ld.TRANSFER_PAID
    student_wallet = await db["points_wallets"].find_one({"student_id": "stua"})
    assert student_wallet["balance"] == 50


@pytest.mark.asyncio
async def test_c4_recovery_worker_reuses_same_state_machine():
    """The browser-abandoned recovery path calls _process_winner with
    mode="retry" exactly like any other retry — proving it shares the
    identical seam rather than a parallel code path."""
    db = _build_db()
    await _enable_wallet_payout(db)
    await _seed_wallet(db, TREASURY, 1000)
    await _seed_wallet(db, "stua", 0)
    draw_id = await _seed_prepared_draw(db, winners=[{
        "student_id": "stua", "display_name": "A", "code": "STAR-1", "amount": 50,
        "transfer_state": ld.TRANSFER_FAILED_RETRY, "transfer_ok": False, "transfer_err": "",
        "transfer_attempt_id": "stale-attempt", "transfer_reference": "", "transfer_retry_count": 1,
        "push_notification_state": None, "push_notification_attempt_id": "",
    }])
    push = PushRecorder()
    SL_DRAWS = db["speaking_lab_lucky_draws"]

    result = await _process_winner(
        db, SL_DRAWS, "sess-1", draw_id,
        {"student_id": "stua", "code": "STAR-1", "amount": 50}, push, mode="retry",
    )

    assert result["transfer_state"] == ld.TRANSFER_PAID
    student_wallet = await db["points_wallets"].find_one({"student_id": "stua"})
    assert student_wallet["balance"] == 50


@pytest.mark.asyncio
async def test_c5_attempt_ownership_terminal_write_guard_intact():
    """A stale attempt id must never overwrite a newer terminal result —
    this guard lives in _set_winner_fields (untouched) and must still
    function through the wallet transport path."""
    db = _build_db()
    await _enable_wallet_payout(db)
    await _seed_wallet(db, TREASURY, 1000)
    await _seed_wallet(db, "stua", 0)
    draw_id = await _seed_prepared_draw(db)
    push = PushRecorder()
    SL_DRAWS = db["speaking_lab_lucky_draws"]

    await _process_winner(
        db, SL_DRAWS, "sess-1", draw_id,
        {"student_id": "stua", "code": "STAR-1", "amount": 50}, push, mode="initial",
    )
    # A delayed write from an old (already-superseded) attempt id must be
    # rejected by _set_winner_fields's guard — simulate directly.
    modified = await ld._set_winner_fields(
        SL_DRAWS, draw_id, "stua",
        {"transfer_state": ld.TRANSFER_FAILED_RETRY},
        expected_attempt_id="some-other-stale-attempt-id",
        require_in_progress=True,
    )
    assert modified == 0
    fresh = await SL_DRAWS.find_one({"draw_id": draw_id})
    assert _winner(fresh, "stua")["transfer_state"] == ld.TRANSFER_PAID  # unchanged


@pytest.mark.asyncio
async def test_c6_notification_only_retry_never_invokes_wallet_service(monkeypatch):
    """_retry_push_only (FIX 12) must never call the payout transport at
    all, wallet or GAS — it only ever resends the push for an
    already-paid winner."""
    db = _build_db()
    await _enable_wallet_payout(db)
    await _seed_wallet(db, TREASURY, 1000)
    await _seed_wallet(db, "stua", 0)
    draw_id = await _seed_prepared_draw(db, winners=[{
        "student_id": "stua", "display_name": "A", "code": "STAR-1", "amount": 50,
        "transfer_state": ld.TRANSFER_PAID, "transfer_ok": True, "transfer_err": "",
        "transfer_attempt_id": "prior-attempt", "transfer_reference": "ref-prior",
        "transfer_retry_count": 0,
        "push_notification_state": ld.PUSH_FAILED, "push_notification_attempt_id": "",
    }])
    push = PushRecorder()

    wallet_calls = []
    orig = swp.wallet_transfer_outcome

    async def _spy(*a, **k):
        wallet_calls.append((a, k))
        return await orig(*a, **k)

    monkeypatch.setattr(swp, "wallet_transfer_outcome", _spy)

    result = await ld._retry_push_only(db, "sess-1", None, push_notify=push)

    assert result["push_retry_candidates"] == 1
    assert push.calls == [("stua", 50, "STAR-1")]
    assert wallet_calls == []  # never touched WalletService
    treasury_wallet = await db["points_wallets"].find_one({"student_id": TREASURY})
    assert treasury_wallet["balance"] == 1000  # balance untouched by a push-only retry


@pytest.mark.asyncio
async def test_c7_concurrent_finalize_and_recovery_no_duplicate_credit():
    import asyncio
    import unittest.mock as _mock

    db = _build_db()
    await _enable_wallet_payout(db)
    await _seed_wallet(db, TREASURY, 1000)
    await _seed_wallet(db, "stua", 0)
    draw_id = await _seed_prepared_draw(db)
    push = PushRecorder()
    SL_DRAWS = db["speaking_lab_lucky_draws"]

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

    with _mock.patch.object(ld, "_claim_winner_initial", _gated_claim):
        await asyncio.gather(
            _process_winner(db, SL_DRAWS, "sess-1", draw_id,
                           {"student_id": "stua", "code": "STAR-1", "amount": 50},
                           push, mode="initial"),
            _process_winner(db, SL_DRAWS, "sess-1", draw_id,
                           {"student_id": "stua", "code": "STAR-1", "amount": 50},
                           push, mode="initial"),
        )

    treasury_wallet = await db["points_wallets"].find_one({"student_id": TREASURY})
    assert treasury_wallet["balance"] == 950  # exactly one 50-point payout
    txns = db["points_transactions"]._docs
    assert len(txns) == 2  # one transfer = one debit + one credit leg


# ═════════════════════════════════════════════════════════════════════════
# Part D — flag defaults, scope, and protected-function integrity
# ═════════════════════════════════════════════════════════════════════════
@pytest.mark.asyncio
async def test_d1_wallet_payout_flag_defaults_off():
    import speaking_lab_feature_flags as flags
    db = _build_db()
    os.environ.pop("SPEAKING_LAB_WALLET_PAYOUT_ENABLED", None)
    assert await flags.wallet_payout_enabled(db) is False
    os.environ["SPEAKING_LAB_WALLET_PAYOUT_ENABLED"] = "true"
    assert await flags.wallet_payout_enabled(db) is False  # DB doc still missing -> AND-gate off


def test_d2_not_referenced_by_server_py():
    """server.py never references this module directly — it is only ever
    reachable through lucky_draw._select_transfer_outcome, which itself
    is only exercised when the AND-gated flag is explicitly turned on."""
    with open("server.py", encoding="utf-8") as f:
        src = f.read()
    assert "speaking_lab_wallet_payout" not in src


def _hash_function_source(path, func_name):
    with open(path, encoding="utf-8") as f:
        src = f.read()
    tree = ast.parse(src)
    for node in ast.walk(tree):
        if isinstance(node, (ast.FunctionDef, ast.AsyncFunctionDef)) and node.name == func_name:
            segment = ast.get_source_segment(src, node)
            return hashlib.sha256(segment.encode("utf-8")).hexdigest()
    raise AssertionError(f"function {func_name} not found in {path}")


# _run_draw baseline updated (funding-source migration): only the pool_total
# computation changed (may now read a linked Prize Pool's live balance) —
# see lucky_draw.py's module docstring.
_PROTECTED_BASELINES = {
    "_weighted_pick": "871c5ad4d2cc3d721ed309e8dc2930e55053fdd9ac53d5a2a3fb815d6ccd461a",
    "_normalize_split": "077c2583249d28118a489a47ad00fa669f14375e8db6b7a153837bff6fa9a359",
    "_run_draw": "e3d47271833cc42038d40fee312000afc6ecf43b04c6c53d6de23f0a185068ca",
}


@pytest.mark.parametrize("func_name,baseline", _PROTECTED_BASELINES.items())
def test_d3_protected_functions_unchanged(func_name, baseline):
    digest = _hash_function_source("lucky_draw.py", func_name)
    assert digest == baseline
