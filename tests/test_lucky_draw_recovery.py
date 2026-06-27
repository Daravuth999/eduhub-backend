"""
Speaking Lab Lucky Draw — v3 payout state machine & recovery tests.
====================================================================

These tests exercise the additive v3 payout machinery in ``lucky_draw.py``
(FIX 2–13) against a small in-memory Mongo-compatible fake that supports the
arrayFilters / positional ``results.$[w].field`` updates the atomic per-winner
claim relies on. A fake provider lets us drive deterministic outcomes and count
the exact number of provider calls (the core safety invariant).

Run from the backend folder:

    pytest -q tests/test_lucky_draw_recovery.py --asyncio-mode=auto
"""

from __future__ import annotations

import asyncio
import datetime as _dt
import pathlib
import sys

import pytest

BACKEND_DIR = pathlib.Path(__file__).resolve().parent.parent
if str(BACKEND_DIR) not in sys.path:
    sys.path.insert(0, str(BACKEND_DIR))

import lucky_draw as ld  # noqa: E402

# Capture the REAL provider function before any test monkeypatches the module
# global, so classification tests always exercise the genuine implementation.
_REAL_PROVIDER_TRANSFER = ld._provider_transfer


@pytest.fixture(autouse=True)
def _restore_provider_transfer():
    ld._provider_transfer = _REAL_PROVIDER_TRANSFER
    yield
    ld._provider_transfer = _REAL_PROVIDER_TRANSFER


# ─────────────────────────────────────────────────────────────────────────────
# Mongo-compatible fake supporting arrayFilters + positional updates
# ─────────────────────────────────────────────────────────────────────────────
def _match_value(actual, cond) -> bool:
    if isinstance(cond, dict):
        if "$ne" in cond:
            return actual != cond["$ne"]
        if "$in" in cond:
            return actual in cond["$in"]
        if "$exists" in cond:
            return (actual is not None) == bool(cond["$exists"])
        if "$gte" in cond:
            return actual is not None and actual >= cond["$gte"]
        if "$lt" in cond:
            return actual is not None and actual < cond["$lt"]
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


def _match_elem(elem, filters) -> bool:
    for filt in filters:
        for k, cond in filt.items():
            field = k.split(".", 1)[1] if "." in k else k
            if not _match_value(elem.get(field), cond):
                return False
    return True


class _Cursor:
    def __init__(self, docs):
        self._docs = docs

    def sort(self, field, direction=1):
        self._docs.sort(key=lambda d: d.get(field) or "",
                         reverse=(direction < 0))
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


class _Col:
    def __init__(self, name):
        self.name = name
        self._docs: list[dict] = []
        self._lock = asyncio.Lock()
        # Test fault-injection hook: callable(update) -> raise to simulate a
        # persistence failure on a specific write.
        self.fail_predicate = None

    async def create_index(self, *a, **k):
        return "idx"

    async def insert_one(self, doc):
        self._docs.append(_deep(doc))
        return type("R", (), {"inserted_id": "x"})()

    async def find_one(self, query, projection=None, sort=None):
        docs = [d for d in self._docs if _match(d, query)]
        if sort:
            for field, direction in reversed(sort):
                docs.sort(key=lambda d: d.get(field) or "",
                          reverse=(direction < 0))
        return _deep(docs[0]) if docs else None

    def find(self, query, projection=None):
        return _Cursor([_deep(d) for d in self._docs if _match(d, query)])

    async def count_documents(self, query):
        return sum(1 for d in self._docs if _match(d, query))

    async def update_one(self, query, update, array_filters=None, upsert=False):
        async with self._lock:
            if self.fail_predicate and self.fail_predicate(update):
                raise RuntimeError("injected persistence failure")
            target = next((d for d in self._docs if _match(d, query)), None)
            if target is None:
                if upsert:
                    nd = dict(query)
                    nd.update(update.get("$set", {}))
                    self._docs.append(nd)
                    return type("R", (), {"matched_count": 1,
                                          "modified_count": 1})()
                return type("R", (), {"matched_count": 0,
                                      "modified_count": 0})()
            changed = self._apply(target, update, array_filters or [])
            return type("R", (), {"matched_count": 1,
                                  "modified_count": 1 if changed else 0})()

    def _apply(self, doc, update, array_filters) -> bool:
        changed = False
        # Resolve matching array elements ONCE against the pre-update state
        # (MongoDB semantics) so multiple $set fields in a single update all
        # land on the same elements atomically.
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


def _deep(d):
    import copy
    return copy.deepcopy(d)


class _DB:
    def __init__(self):
        self._cols: dict[str, _Col] = {}

    def __getitem__(self, name):
        return self._cols.setdefault(name, _Col(name))

    def __getattr__(self, name):
        if name.startswith("_"):
            raise AttributeError(name)
        return self[name]


# ─────────────────────────────────────────────────────────────────────────────
# Fake provider + helpers
# ─────────────────────────────────────────────────────────────────────────────
class FakeProvider:
    """Counts provider calls and returns a configured outcome per call."""
    def __init__(self, outcome="paid", provider_reference="GASTX-1"):
        self.calls = 0
        self.outcome = outcome
        self.provider_reference = provider_reference

    async def __call__(self, gas_url, treasury_id, treasury_password,
                       receiver_clean_id, amount, *, use_mock,
                       stable_reference, attempt_id, log=None):
        self.calls += 1
        if self.outcome == "paid":
            return {"outcome": ld.TRANSFER_PAID, "provider_status": "success",
                    "provider_reference": self.provider_reference, "error": ""}
        if self.outcome == "failed_safe_to_retry":
            return {"outcome": ld.TRANSFER_FAILED_RETRY,
                    "provider_status": "connect_error",
                    "provider_reference": None, "error": "refused"}
        if self.outcome == "manual_review":
            return {"outcome": ld.TRANSFER_MANUAL,
                    "provider_status": "timeout_or_dropped",
                    "provider_reference": None, "error": "read timeout"}
        return {"outcome": ld.TRANSFER_MOCK, "provider_status": "mock",
                "provider_reference": None, "error": ""}


async def _noop_publish(session_id, event):
    return None


class PushRecorder:
    """Fake structured push callback (FIX 4 contract). `mode` controls the
    returned delivery result: 'sent' | 'no_subscribers' | 'failed' | 'raise'."""
    def __init__(self, fail=False, mode="sent"):
        self.calls = []
        self.mode = "raise" if fail else mode

    async def __call__(self, student_id, amount, code):
        self.calls.append((student_id, amount, code))
        if self.mode == "raise":
            raise RuntimeError("push infrastructure exception")
        if self.mode == "no_subscribers":
            return {"attempted": False, "sent": 0, "failed": 0,
                    "no_subscribers": True, "error": ""}
        if self.mode == "failed":
            return {"attempted": True, "sent": 0, "failed": 1,
                    "no_subscribers": False, "error": "delivery failed"}
        return {"attempted": True, "sent": 1, "failed": 0,
                "no_subscribers": False, "error": ""}


def _now_iso(offset_seconds=0):
    return (_dt.datetime.now(_dt.timezone.utc)
            + _dt.timedelta(seconds=offset_seconds)).isoformat()


async def _seed_prepared_draw(db, *, draw_id="draw-1", session_id="sess-1",
                              winners=None, prepared_offset=-300, mock=False):
    """Insert a session + a prepared (un-finalized) draw, mirroring what the
    protected `_run_draw` would persist (transfer_ok=None per winner)."""
    winners = winners or [
        {"student_id": "stuA", "display_name": "A", "code": "STAR-1",
         "amount": 50, "transfer_ok": None, "transfer_err": "",
         "was_slot_picked": False},
        {"student_id": "stuB", "display_name": "B", "code": "MOON-2",
         "amount": 30, "transfer_ok": None, "transfer_err": "",
         "was_slot_picked": False},
    ]
    await db.speaking_lab_sessions.insert_one({
        "session_id": session_id, "lucky_draw_done": True,
        "lucky_draw_prepared_draw_id": draw_id})
    await db.speaking_lab_lucky_draws.insert_one({
        "draw_id": draw_id, "session_id": session_id, "pool_total": 80,
        "num_winners": len(winners), "split": [50, 30, 20],
        "results": winners, "mock": mock, "finalized": False,
        "prepared_at": _now_iso(prepared_offset),
        "drawn_at": _now_iso(prepared_offset)})
    return draw_id, session_id


GAS = "https://gas.example/exec"
PW = "secret-treasury-pw"


async def _finalize(db, session_id, provider=None, push=None, mock_gas=False,
                    gas_url=GAS, pw=PW):
    if provider is not None:
        ld._provider_transfer = provider
    return await ld._finalize_draw(
        db, _noop_publish, session_id, gas_url, "stu092", pw, mock_gas,
        ld.logging.getLogger("test"), push_notify=push)


# ═════════════════════════════════════════════════════════════════════════════
# FIX 6 — provider outcome classification (real _provider_transfer)
# ═════════════════════════════════════════════════════════════════════════════
class _FakeResp:
    def __init__(self, status_code=200, payload=None, text=""):
        self.status_code = status_code
        self._payload = payload
        self.text = text

    def json(self):
        if self._payload is None:
            raise ValueError("no json")
        return self._payload


def _patch_httpx(monkeypatch, *, raise_exc=None, resp=None):
    class _FakeClient:
        def __init__(self, *a, **k):
            pass

        async def __aenter__(self):
            return self

        async def __aexit__(self, *a):
            return False

        async def post(self, url, data=None):
            if raise_exc is not None:
                raise raise_exc
            return resp
    monkeypatch.setattr(ld.httpx, "AsyncClient", _FakeClient)


@pytest.mark.asyncio
async def test_classify_missing_url_fails_closed():
    out = await ld._provider_transfer("", "t", PW, "stuA", 10, use_mock=False,
                                      stable_reference="r", attempt_id="a")
    assert out["outcome"] == ld.TRANSFER_FAILED_RETRY
    assert out["provider_status"] == "provider_not_configured"


@pytest.mark.asyncio
async def test_classify_missing_password_fails_closed():
    out = await ld._provider_transfer(GAS, "t", "", "stuA", 10, use_mock=False,
                                      stable_reference="r", attempt_id="a")
    assert out["outcome"] == ld.TRANSFER_FAILED_RETRY
    assert out["provider_status"] == "provider_not_configured"


@pytest.mark.asyncio
async def test_classify_explicit_mock():
    out = await ld._provider_transfer(GAS, "t", PW, "stuA", 10, use_mock=True,
                                      stable_reference="r", attempt_id="a")
    assert out["outcome"] == ld.TRANSFER_MOCK


@pytest.mark.asyncio
async def test_classify_connection_refused_is_safe_retry(monkeypatch):
    _patch_httpx(monkeypatch, raise_exc=ld.httpx.ConnectError("refused"))
    out = await ld._provider_transfer(GAS, "t", PW, "stuA", 10, use_mock=False,
                                      stable_reference="r", attempt_id="a")
    assert out["outcome"] == ld.TRANSFER_FAILED_RETRY


@pytest.mark.asyncio
async def test_classify_read_timeout_is_manual_review(monkeypatch):
    _patch_httpx(monkeypatch, raise_exc=ld.httpx.ReadTimeout("timeout"))
    out = await ld._provider_transfer(GAS, "t", PW, "stuA", 10, use_mock=False,
                                      stable_reference="r", attempt_id="a")
    assert out["outcome"] == ld.TRANSFER_MANUAL


@pytest.mark.asyncio
async def test_classify_invalid_json_is_manual_review(monkeypatch):
    _patch_httpx(monkeypatch, resp=_FakeResp(200, payload=None, text="<html>"))
    out = await ld._provider_transfer(GAS, "t", PW, "stuA", 10, use_mock=False,
                                      stable_reference="r", attempt_id="a")
    assert out["outcome"] == ld.TRANSFER_MANUAL


@pytest.mark.asyncio
async def test_classify_explicit_decline_is_safe_retry(monkeypatch):
    _patch_httpx(monkeypatch, resp=_FakeResp(200,
                 payload={"success": False, "message": "insufficient"}))
    out = await ld._provider_transfer(GAS, "t", PW, "stuA", 10, use_mock=False,
                                      stable_reference="r", attempt_id="a")
    assert out["outcome"] == ld.TRANSFER_FAILED_RETRY


@pytest.mark.asyncio
async def test_classify_success_is_paid(monkeypatch):
    _patch_httpx(monkeypatch, resp=_FakeResp(200,
                 payload={"success": True, "transactionId": "GASTX-9"}))
    out = await ld._provider_transfer(GAS, "t", PW, "stuA", 10, use_mock=False,
                                      stable_reference="r", attempt_id="a")
    assert out["outcome"] == ld.TRANSFER_PAID
    assert out["provider_reference"] == "GASTX-9"


@pytest.mark.asyncio
async def test_classify_http_500_is_manual_review(monkeypatch):
    _patch_httpx(monkeypatch, resp=_FakeResp(500, payload=None, text="err"))
    out = await ld._provider_transfer(GAS, "t", PW, "stuA", 10, use_mock=False,
                                      stable_reference="r", attempt_id="a")
    assert out["outcome"] == ld.TRANSFER_MANUAL


# ═════════════════════════════════════════════════════════════════════════════
# FIX 2 — fail closed on missing configuration
# ═════════════════════════════════════════════════════════════════════════════
@pytest.mark.asyncio
async def test_finalize_missing_url_blocks():
    db = _DB()
    _, sid = await _seed_prepared_draw(db)
    with pytest.raises(ld.HTTPException) as ei:
        await _finalize(db, sid, provider=FakeProvider(), gas_url="")
    assert ei.value.status_code == 503


@pytest.mark.asyncio
async def test_finalize_missing_password_blocks():
    db = _DB()
    _, sid = await _seed_prepared_draw(db)
    with pytest.raises(ld.HTTPException) as ei:
        await _finalize(db, sid, provider=FakeProvider(), pw="")
    assert ei.value.status_code == 503


@pytest.mark.asyncio
async def test_mock_mode_is_mock_not_paid():
    db = _DB()
    did, sid = await _seed_prepared_draw(db, mock=True)
    push = PushRecorder()
    prov = FakeProvider(outcome="mock")
    resp = await _finalize(db, sid, provider=prov, push=push, mock_gas=True)
    assert resp["payout_status"] == ld.PAYOUT_MOCK
    assert resp["mock_count"] == 2 and resp["paid_count"] == 0
    assert push.calls == []           # no success push in mock mode
    assert resp["payout_complete"] is True


# ═════════════════════════════════════════════════════════════════════════════
# FIX 5/7/8 — atomic claims, concurrency, provider-then-mongo-fail
# ═════════════════════════════════════════════════════════════════════════════
@pytest.mark.asyncio
async def test_finalize_pays_all_and_stable_reference_used():
    db = _DB()
    did, sid = await _seed_prepared_draw(db)
    prov = FakeProvider()
    push = PushRecorder()
    resp = await _finalize(db, sid, provider=prov, push=push)
    assert resp["payout_status"] == ld.PAYOUT_COMPLETED
    assert resp["paid_count"] == 2 and prov.calls == 2
    draw = await db.speaking_lab_lucky_draws.find_one({"draw_id": did})
    for w in draw["results"]:
        assert w["transfer_state"] == ld.TRANSFER_PAID
        assert w["transfer_reference"] == \
            ld._stable_reference(did, sid, w["student_id"])
        assert w["transfer_ok"] is True
    assert len(push.calls) == 2


@pytest.mark.asyncio
async def test_concurrent_finalize_one_provider_call_per_winner():
    db = _DB()
    did, sid = await _seed_prepared_draw(db)
    prov = FakeProvider()
    ld._provider_transfer = prov
    await asyncio.gather(_finalize(db, sid), _finalize(db, sid))
    # 2 winners → exactly 2 provider calls total, never 4.
    assert prov.calls == 2


@pytest.mark.asyncio
async def test_concurrent_retry_one_provider_call_per_winner():
    db = _DB()
    did, sid = await _seed_prepared_draw(db, winners=[
        {"student_id": "stuA", "display_name": "A", "code": "STAR-1",
         "amount": 50, "transfer_ok": None}])
    # First finalize fails-safe so the winner is failed_safe_to_retry.
    await _finalize(db, sid, provider=FakeProvider(outcome="failed_safe_to_retry"))
    prov = FakeProvider(outcome="paid")
    ld._provider_transfer = prov

    async def _retry():
        return await ld._retry_failed_payouts(
            db, _noop_publish, sid, GAS, "stu092", PW, False,
            ld.logging.getLogger("t"), push_notify=PushRecorder())
    await asyncio.gather(_retry(), _retry())
    # Two concurrent retries → exactly ONE provider call for the one winner.
    assert prov.calls == 1


@pytest.mark.asyncio
async def test_paid_winner_never_retried():
    db = _DB()
    did, sid = await _seed_prepared_draw(db)
    prov = FakeProvider()
    await _finalize(db, sid, provider=prov)
    assert prov.calls == 2
    # second finalize must not re-pay
    await _finalize(db, sid, provider=prov)
    assert prov.calls == 2


@pytest.mark.asyncio
async def test_provider_success_then_mongo_fail_no_resend():
    db = _DB()
    did, sid = await _seed_prepared_draw(db, winners=[
        {"student_id": "stuA", "display_name": "A", "code": "STAR-1",
         "amount": 50, "transfer_ok": None}])
    # Make the PAID-state persist fail exactly once.
    col = db.speaking_lab_lucky_draws

    def _fail(update):
        s = update.get("$set", {})
        return any(k.endswith("transfer_state") and v == ld.TRANSFER_PAID
                   for k, v in s.items())
    col.fail_predicate = _fail
    prov = FakeProvider()
    push = PushRecorder()
    resp = await _finalize(db, sid, provider=prov, push=push)
    assert prov.calls == 1
    draw = await col.find_one({"draw_id": did})
    assert draw["results"][0]["transfer_state"] == ld.TRANSFER_MANUAL
    assert draw["results"][0]["manual_review_reason"] == \
        "provider_paid_but_persist_failed"
    assert push.calls == []
    # Later automatic recovery / retry must NOT call the provider again.
    col.fail_predicate = None
    await _finalize(db, sid, provider=prov, push=push)
    assert prov.calls == 1
    await ld._retry_failed_payouts(db, _noop_publish, sid, GAS, "stu092", PW,
                                   False, ld.logging.getLogger("t"),
                                   push_notify=push)
    assert prov.calls == 1


@pytest.mark.asyncio
async def test_stale_in_progress_becomes_manual_review():
    db = _DB()
    did, sid = await _seed_prepared_draw(db, winners=[
        {"student_id": "stuA", "display_name": "A", "code": "STAR-1",
         "amount": 50, "transfer_state": ld.TRANSFER_IN_PROGRESS,
         "transfer_started_at": _now_iso(-9999), "transfer_ok": None}])
    prov = FakeProvider()
    resp = await _finalize(db, sid, provider=prov, push=PushRecorder())
    draw = await db.speaking_lab_lucky_draws.find_one({"draw_id": did})
    assert draw["results"][0]["transfer_state"] == ld.TRANSFER_MANUAL
    assert prov.calls == 0            # never sent for a stale in_progress


# ═════════════════════════════════════════════════════════════════════════════
# FIX 9 — safe retry endpoint behavior
# ═════════════════════════════════════════════════════════════════════════════
async def _finalize_with_failure(db, sid, push=None):
    prov = FakeProvider(outcome="failed_safe_to_retry")
    return await _finalize(db, sid, provider=prov, push=push)


@pytest.mark.asyncio
async def test_retry_only_failed_safe_to_retry():
    db = _DB()
    did, sid = await _seed_prepared_draw(db)
    await _finalize_with_failure(db, sid)
    # now retry with a provider that succeeds
    prov = FakeProvider(outcome="paid")
    ld._provider_transfer = prov
    push = PushRecorder()
    resp = await ld._retry_failed_payouts(db, _noop_publish, sid, GAS,
        "stu092", PW, False, ld.logging.getLogger("t"), push_notify=push)
    assert prov.calls == 2
    assert resp["retried_safe_failures"] == 2
    assert resp["paid_count"] == 2
    assert len(push.calls) == 2       # push fires after retry pays


@pytest.mark.asyncio
async def test_retry_does_not_touch_manual_review_without_override():
    db = _DB()
    did, sid = await _seed_prepared_draw(db)
    prov = FakeProvider(outcome="manual_review")
    await _finalize(db, sid, provider=prov)
    prov2 = FakeProvider(outcome="paid")
    ld._provider_transfer = prov2
    resp = await ld._retry_failed_payouts(db, _noop_publish, sid, GAS,
        "stu092", PW, False, ld.logging.getLogger("t"))
    assert prov2.calls == 0           # manual_review skipped without override
    assert resp["manual_review_count"] == 2


@pytest.mark.asyncio
async def test_manual_review_override_requires_reason():
    db = _DB()
    did, sid = await _seed_prepared_draw(db)
    await _finalize(db, sid, provider=FakeProvider(outcome="manual_review"))
    with pytest.raises(ld.HTTPException) as ei:
        await ld._retry_failed_payouts(db, _noop_publish, sid, GAS, "stu092",
            PW, False, ld.logging.getLogger("t"), confirm_not_paid=True,
            reason="")
    assert ei.value.status_code == 422


@pytest.mark.asyncio
async def test_manual_review_override_releases_with_student_specific_confirmation():
    # v5 (FIX 3): releasing a manual_review winner requires the EXACT
    # student_id. A confirm_not_paid + reason alone is NOT enough — that
    # would let one click release every uncertain winner in the draw.
    db = _DB()
    did, sid = await _seed_prepared_draw(db)
    await _finalize(db, sid, provider=FakeProvider(outcome="manual_review"))
    prov = FakeProvider(outcome="paid")
    ld._provider_transfer = prov
    # confirm_not_paid alone (no student_id) must be rejected.
    with pytest.raises(ld.HTTPException) as ei:
        await ld._retry_failed_payouts(db, _noop_publish, sid, GAS,
            "stu092", PW, False, ld.logging.getLogger("t"),
            confirm_not_paid=True,
            reason="Checked GAS ledger; no credit exists")
    assert ei.value.status_code == 422
    # With student_id supplied, only that student is released. stuB stays.
    resp = await ld._retry_failed_payouts(db, _noop_publish, sid, GAS,
        "stu092", PW, False, ld.logging.getLogger("t"),
        confirm_not_paid=True,
        reason="Checked GAS ledger; no credit exists for stuA",
        student_id="stuA")
    assert prov.calls == 1                       # ONLY stuA was reprocessed
    assert resp["released_manual_review"] == 1
    assert resp["override_used"] is True
    assert resp["student_id_targeted"] == "stuA"
    assert "warning" in resp
    # stuB remains manual_review.
    draw = await db.speaking_lab_lucky_draws.find_one({"draw_id": did})
    by_sid = {w["student_id"]: w for w in draw["results"]}
    assert by_sid["stuA"]["transfer_state"] == ld.TRANSFER_PAID
    assert by_sid["stuB"]["transfer_state"] == ld.TRANSFER_MANUAL


# ═════════════════════════════════════════════════════════════════════════════
# FIX 12 — push notification correctness
# ═════════════════════════════════════════════════════════════════════════════
@pytest.mark.asyncio
async def test_paid_sends_exactly_one_push_even_on_reprocess():
    db = _DB()
    did, sid = await _seed_prepared_draw(db, winners=[
        {"student_id": "stuA", "display_name": "A", "code": "STAR-1",
         "amount": 50, "transfer_ok": None}])
    push = PushRecorder()
    prov = FakeProvider()
    await _finalize(db, sid, provider=prov, push=push)
    await _finalize(db, sid, provider=prov, push=push)   # reprocess
    assert len(push.calls) == 1


@pytest.mark.asyncio
async def test_failure_sends_no_push():
    db = _DB()
    _, sid = await _seed_prepared_draw(db)
    push = PushRecorder()
    await _finalize(db, sid, provider=FakeProvider(outcome="failed_safe_to_retry"),
                    push=push)
    assert push.calls == []


@pytest.mark.asyncio
async def test_manual_review_sends_no_push():
    db = _DB()
    _, sid = await _seed_prepared_draw(db)
    push = PushRecorder()
    await _finalize(db, sid, provider=FakeProvider(outcome="manual_review"),
                    push=push)
    assert push.calls == []


@pytest.mark.asyncio
async def test_push_failure_does_not_resend_points():
    db = _DB()
    did, sid = await _seed_prepared_draw(db, winners=[
        {"student_id": "stuA", "display_name": "A", "code": "STAR-1",
         "amount": 50, "transfer_ok": None}])
    prov = FakeProvider()
    push = PushRecorder(fail=True)
    await _finalize(db, sid, provider=prov, push=push)
    draw = await db.speaking_lab_lucky_draws.find_one({"draw_id": did})
    w = draw["results"][0]
    assert w["transfer_state"] == ld.TRANSFER_PAID      # reward stays paid
    assert w["push_notification_state"] == ld.PUSH_FAILED
    assert prov.calls == 1
    # notification-only retry must NOT call the provider
    push2 = PushRecorder()
    await ld._retry_push_only(db, sid, ld.logging.getLogger("t"),
                              push_notify=push2)
    assert prov.calls == 1
    assert len(push2.calls) == 1


# ═════════════════════════════════════════════════════════════════════════════
# FIX 10/11 — background recovery + historical reconciliation
# ═════════════════════════════════════════════════════════════════════════════
@pytest.mark.asyncio
async def test_recovery_processes_abandoned_draw_after_grace():
    db = _DB()
    did, sid = await _seed_prepared_draw(db, prepared_offset=-300)  # 5 min old
    prov = FakeProvider()
    ld._provider_transfer = prov
    out = await ld.recover_abandoned_draws(
        db, _noop_publish, GAS, "stu092", PW, False,
        ld.logging.getLogger("t"), push_notify=PushRecorder())
    assert out["recovered"] == 1
    assert prov.calls == 2


@pytest.mark.asyncio
async def test_recovery_skips_fresh_draw_under_three_minutes():
    db = _DB()
    did, sid = await _seed_prepared_draw(db, prepared_offset=-30)   # 30s old
    prov = FakeProvider()
    ld._provider_transfer = prov
    out = await ld.recover_abandoned_draws(
        db, _noop_publish, GAS, "stu092", PW, False,
        ld.logging.getLogger("t"))
    assert out["recovered"] == 0
    assert prov.calls == 0


@pytest.mark.asyncio
async def test_recovery_skips_draw_over_24h():
    db = _DB()
    did, sid = await _seed_prepared_draw(db, prepared_offset=-(25 * 3600))
    prov = FakeProvider()
    ld._provider_transfer = prov
    out = await ld.recover_abandoned_draws(
        db, _noop_publish, GAS, "stu092", PW, False,
        ld.logging.getLogger("t"))
    assert out["recovered"] == 0
    assert prov.calls == 0


@pytest.mark.asyncio
async def test_recovery_skips_when_provider_not_configured():
    db = _DB()
    await _seed_prepared_draw(db, prepared_offset=-300)
    out = await ld.recover_abandoned_draws(
        db, _noop_publish, "", "stu092", PW, False,
        ld.logging.getLogger("t"))
    assert out.get("skipped_config") is True


@pytest.mark.asyncio
async def test_historical_recovery_requires_confirmation():
    db = _DB()
    _, sid = await _seed_prepared_draw(db, prepared_offset=-(25 * 3600))
    with pytest.raises(ld.HTTPException) as ei:
        await ld._reconcile_historical_draw(
            db, _noop_publish, sid, GAS, "stu092", PW, False,
            ld.logging.getLogger("t"), confirm_historical_recovery=False,
            reason="x")
    assert ei.value.status_code == 422


@pytest.mark.asyncio
async def test_historical_recovery_with_confirmation_does_not_resend_legacy_null():
    # v5 (FIX 4): historical reconciliation must NOT auto-resend a legacy
    # uncertain winner (transfer_ok=None, no transfer_state). The route may
    # only drain failed_safe_to_retry rows; manual_review rows require the
    # explicit STUDENT-SPECIFIC confirm_not_paid+student_id retry path.
    db = _DB()
    did, sid = await _seed_prepared_draw(db, prepared_offset=-(25 * 3600))
    prov = FakeProvider()
    ld._provider_transfer = prov
    resp = await ld._reconcile_historical_draw(
        db, _noop_publish, sid, GAS, "stu092", PW, False,
        ld.logging.getLogger("t"), confirm_historical_recovery=True,
        reason="Verified wallet history")
    assert resp["historical_reconciliation"] is True
    # v5: no winners auto-paid; both stay manual_review pending student-
    # specific confirmation by an admin.
    assert prov.calls == 0
    assert resp["paid_count"] == 0
    assert resp["manual_review_count"] == 2


# ═════════════════════════════════════════════════════════════════════════════
# FIX 3 — legacy mapping safety + winner identity preservation
# ═════════════════════════════════════════════════════════════════════════════
def test_legacy_true_maps_paid():
    assert ld._legacy_state_for_record({"transfer_ok": True}) == ld.TRANSFER_PAID


def test_legacy_false_not_safe_to_retry():
    # A legacy False is quarantined as manual_review, NOT failed_safe_to_retry.
    assert ld._legacy_state_for_record({"transfer_ok": False}) == \
        ld.TRANSFER_MANUAL


def test_legacy_null_maps_manual_review():
    # v5 (FIX 4): legacy `transfer_ok=None` (no transfer_state present) is
    # UNCERTAIN — never map to pending (which would let background recovery
    # silently re-pay an already-credited student). Always quarantine.
    assert ld._legacy_state_for_record({"transfer_ok": None}) == \
        ld.TRANSFER_MANUAL


@pytest.mark.asyncio
async def test_legacy_false_not_blindly_retried():
    db = _DB()
    did, sid = await _seed_prepared_draw(db, winners=[
        {"student_id": "stuA", "display_name": "A", "code": "STAR-1",
         "amount": 50, "transfer_ok": False, "transfer_err": "old"}])
    prov = FakeProvider()
    # finalize seeds it to manual_review (not retryable) and skips it.
    await _finalize(db, sid, provider=prov)
    assert prov.calls == 0
    # failed-only retry must not touch a manual_review legacy row.
    resp = await ld._retry_failed_payouts(db, _noop_publish, sid, GAS,
        "stu092", PW, False, ld.logging.getLogger("t"))
    assert prov.calls == 0


@pytest.mark.asyncio
async def test_winner_identity_amount_code_rank_order_unchanged():
    db = _DB()
    winners = [
        {"student_id": "stuA", "display_name": "A", "code": "STAR-1",
         "amount": 50, "transfer_ok": None},
        {"student_id": "stuB", "display_name": "B", "code": "MOON-2",
         "amount": 30, "transfer_ok": None},
        {"student_id": "stuC", "display_name": "C", "code": "FIRE-3",
         "amount": 0, "transfer_ok": None},
    ]
    did, sid = await _seed_prepared_draw(db, winners=winners)
    before = [(w["student_id"], w["amount"], w["code"]) for w in winners]
    await _finalize(db, sid, provider=FakeProvider())
    draw = await db.speaking_lab_lucky_draws.find_one({"draw_id": did})
    after = [(w["student_id"], w["amount"], w["code"]) for w in draw["results"]]
    assert before == after            # identity / amount / code / order intact


# ═════════════════════════════════════════════════════════════════════════════
# FIX 13 — truthful response contract
# ═════════════════════════════════════════════════════════════════════════════
@pytest.mark.asyncio
async def test_partial_payout_status_is_truthful():
    db = _DB()
    did, sid = await _seed_prepared_draw(db, winners=[
        {"student_id": "stuA", "display_name": "A", "code": "STAR-1",
         "amount": 50, "transfer_ok": None},
        {"student_id": "stuB", "display_name": "B", "code": "MOON-2",
         "amount": 30, "transfer_ok": None}])

    calls = {"n": 0}

    async def _mixed(*a, **k):
        calls["n"] += 1
        if calls["n"] == 1:
            return {"outcome": ld.TRANSFER_PAID, "provider_status": "success",
                    "provider_reference": "X", "error": ""}
        return {"outcome": ld.TRANSFER_FAILED_RETRY,
                "provider_status": "connect_error",
                "provider_reference": None, "error": "refused"}
    resp = await _finalize(db, sid, provider=_mixed)
    assert resp["payout_status"] == ld.PAYOUT_COMPLETED_WITH_FAILURES
    assert resp["paid_count"] == 1 and resp["safe_failure_count"] == 1
    assert resp["payout_complete"] is False
    assert resp["ok"] is True          # endpoint executed, but not all paid


# ═════════════════════════════════════════════════════════════════════════════
# v4 FIX 1 — stale seeding cannot overwrite an active state
# ═════════════════════════════════════════════════════════════════════════════
@pytest.mark.asyncio
async def test_v4_stale_seed_cannot_overwrite_in_progress():
    db = _DB()
    did, sid = await _seed_prepared_draw(db, winners=[
        {"student_id": "stuA", "display_name": "A", "code": "STAR-1",
         "amount": 50, "transfer_ok": None}])
    SL = db.speaking_lab_lucky_draws
    # Worker A: seed then claim → in_progress.
    # v5 (FIX 4): we are simulating the in-progress finalize path, so we
    # pass fresh_finalize=True (mirroring _finalize_draw).
    await ld._seed_results_states(SL, did, fresh_finalize=True)
    prov = FakeProvider()
    ld._provider_transfer = prov
    claimed = await ld._claim_winner_initial(
        SL, did, "stuA", ld._stable_reference(did, sid, "stuA"),
        "attempt-A", _now_iso())
    assert claimed is True
    # Worker B: runs seed again on a (now) live doc that is in_progress.
    await ld._seed_results_states(SL, did, fresh_finalize=True)
    draw = await SL.find_one({"draw_id": did})
    assert draw["results"][0]["transfer_state"] == ld.TRANSFER_IN_PROGRESS
    assert draw["results"][0]["transfer_attempt_id"] == "attempt-A"
    # Worker B tries to claim → cannot (already in_progress).
    claimed_b = await ld._claim_winner_initial(
        SL, did, "stuA", ld._stable_reference(did, sid, "stuA"),
        "attempt-B", _now_iso())
    assert claimed_b is False


# ═════════════════════════════════════════════════════════════════════════════
# v4 FIX 2 — finalized-but-unresolved draw recovered by background loop
# ═════════════════════════════════════════════════════════════════════════════
@pytest.mark.asyncio
async def test_v5_legacy_finalized_null_does_not_auto_resend():
    # v5 (FIX 4) — adversarial proof: a legacy finalized winner whose
    # `transfer_ok` is None and `transfer_state` is missing MUST be
    # quarantined as manual_review by background recovery. The provider
    # must NEVER be auto-called for such records.
    db = _DB()
    SL = db.speaking_lab_lucky_draws
    await db.speaking_lab_sessions.insert_one({"session_id": "sess-9"})
    # Legacy crash AFTER finalize claim, BEFORE any winner processing.
    await SL.insert_one({
        "draw_id": "draw-9", "session_id": "sess-9", "pool_total": 50,
        "num_winners": 1, "split": [50, 30, 20], "mock": False,
        "finalized": True, "payout_status": ld.PAYOUT_PROCESSING,
        "prepared_at": _now_iso(-300),
        "results": [{"student_id": "stuA", "display_name": "A",
                     "code": "STAR-1", "amount": 50, "transfer_ok": None}]})
    prov = FakeProvider()
    ld._provider_transfer = prov
    await ld.recover_abandoned_draws(
        db, _noop_publish, GAS, "stu092", PW, False,
        ld.logging.getLogger("t"), push_notify=PushRecorder())
    # v5 (FIX 4): the provider must NOT be called automatically.
    assert prov.calls == 0
    draw = await SL.find_one({"draw_id": "draw-9"})
    assert draw["results"][0]["transfer_state"] == ld.TRANSFER_MANUAL
    # Historical route without student-specific confirmation: still NO call.
    out = await ld._reconcile_historical_draw(
        db, _noop_publish, "sess-9", GAS, "stu092", PW, False,
        ld.logging.getLogger("t"), confirm_historical_recovery=True,
        reason="Verified wallet history")
    assert prov.calls == 0
    assert out["paid_count"] == 0


@pytest.mark.asyncio
async def test_v4_finalized_with_stale_in_progress_becomes_manual_no_resend():
    db = _DB()
    SL = db.speaking_lab_lucky_draws
    await db.speaking_lab_sessions.insert_one({"session_id": "sess-10"})
    # Crash AFTER provider call, BEFORE paid persistence → stale in_progress.
    await SL.insert_one({
        "draw_id": "draw-10", "session_id": "sess-10", "pool_total": 50,
        "num_winners": 1, "split": [50, 30, 20], "mock": False,
        "finalized": True, "payout_status": ld.PAYOUT_PROCESSING,
        "prepared_at": _now_iso(-300),
        "results": [{"student_id": "stuA", "display_name": "A", "code": "S1",
                     "amount": 50, "transfer_state": ld.TRANSFER_IN_PROGRESS,
                     "transfer_attempt_id": "att-x",
                     "transfer_started_at": _now_iso(-9999),
                     "transfer_ok": None}]})
    prov = FakeProvider()
    ld._provider_transfer = prov
    await ld.recover_abandoned_draws(
        db, _noop_publish, GAS, "stu092", PW, False,
        ld.logging.getLogger("t"), push_notify=PushRecorder())
    draw = await SL.find_one({"draw_id": "draw-10"})
    assert draw["results"][0]["transfer_state"] == ld.TRANSFER_MANUAL
    assert draw["results"][0]["manual_review_reason"] == \
        "stale_in_progress_provider_outcome_unknown"
    assert prov.calls == 0


# ═════════════════════════════════════════════════════════════════════════════
# v4 FIX 3 — strict provider-success validation
# ═════════════════════════════════════════════════════════════════════════════
SREF = "lucky_draw:draw-1:sess-1:stuA"


@pytest.mark.asyncio
async def test_v5_bare_success_is_paid(monkeypatch):
    # v5 (FIX 6): the production GAS `sendPoints` contract proven by
    # eduhub-backend-master callers (payment_bridge.py, voice_treasure_
    # points_adapter.py) does NOT echo `clientRef` and does NOT return a
    # transaction id. A bare `{"success": true}` with HTTP 200 is treated
    # as `paid`. Stable references are preserved internally for audit.
    _patch_httpx(monkeypatch, resp=_FakeResp(200, payload={"success": True}))
    out = await ld._provider_transfer(GAS, "t", PW, "stuA", 10, use_mock=False,
                                      stable_reference=SREF, attempt_id="a")
    assert out["outcome"] == ld.TRANSFER_PAID
    assert out["provider_status"] == "success"
    # Stable reference is the audit anchor when nothing else is echoed.
    assert SREF in str(out["provider_reference"])


@pytest.mark.asyncio
async def test_v5_ambiguous_response_is_manual_review(monkeypatch):
    # v5 (FIX 6): non-200 / invalid JSON / mismatched echo → manual_review.
    _patch_httpx(monkeypatch, resp=_FakeResp(500, payload=None, text="oops"))
    out = await ld._provider_transfer(GAS, "t", PW, "stuA", 10, use_mock=False,
                                      stable_reference=SREF, attempt_id="a")
    assert out["outcome"] == ld.TRANSFER_MANUAL
    assert out["provider_status"].startswith("http_")


@pytest.mark.asyncio
async def test_v4_success_with_provider_reference_is_paid(monkeypatch):
    _patch_httpx(monkeypatch, resp=_FakeResp(200, payload={
        "success": True, "transactionId": "GASTX-1",
        "receiverId": "stuA", "amount": 10}))
    out = await ld._provider_transfer(GAS, "t", PW, "stuA", 10, use_mock=False,
                                      stable_reference=SREF, attempt_id="a")
    assert out["outcome"] == ld.TRANSFER_PAID
    assert out["provider_reference"] == "GASTX-1"


@pytest.mark.asyncio
async def test_v4_success_with_echoed_clientref_is_paid(monkeypatch):
    _patch_httpx(monkeypatch, resp=_FakeResp(200, payload={
        "success": True, "clientRef": SREF}))
    out = await ld._provider_transfer(GAS, "t", PW, "stuA", 10, use_mock=False,
                                      stable_reference=SREF, attempt_id="a")
    assert out["outcome"] == ld.TRANSFER_PAID


@pytest.mark.asyncio
async def test_v4_success_wrong_recipient_is_manual(monkeypatch):
    _patch_httpx(monkeypatch, resp=_FakeResp(200, payload={
        "success": True, "transactionId": "T", "receiverId": "stuWRONG"}))
    out = await ld._provider_transfer(GAS, "t", PW, "stuA", 10, use_mock=False,
                                      stable_reference=SREF, attempt_id="a")
    assert out["outcome"] == ld.TRANSFER_MANUAL
    assert out["provider_status"] == "recipient_mismatch"


@pytest.mark.asyncio
async def test_v4_success_wrong_amount_is_manual(monkeypatch):
    _patch_httpx(monkeypatch, resp=_FakeResp(200, payload={
        "success": True, "transactionId": "T", "amount": 999}))
    out = await ld._provider_transfer(GAS, "t", PW, "stuA", 10, use_mock=False,
                                      stable_reference=SREF, attempt_id="a")
    assert out["outcome"] == ld.TRANSFER_MANUAL
    assert out["provider_status"] == "amount_mismatch"


@pytest.mark.asyncio
async def test_v4_success_mismatched_logical_reference_is_manual(monkeypatch):
    _patch_httpx(monkeypatch, resp=_FakeResp(200, payload={
        "success": True, "clientRef": "lucky_draw:OTHER:x:y"}))
    out = await ld._provider_transfer(GAS, "t", PW, "stuA", 10, use_mock=False,
                                      stable_reference=SREF, attempt_id="a")
    assert out["outcome"] == ld.TRANSFER_MANUAL
    assert out["provider_status"] == "logical_reference_mismatch"


# ═════════════════════════════════════════════════════════════════════════════
# v4 FIX 4 — push durability & truthfulness
# ═════════════════════════════════════════════════════════════════════════════
async def _seed_one_winner_draw(db):
    return await _seed_prepared_draw(db, winners=[
        {"student_id": "stuA", "display_name": "A", "code": "STAR-1",
         "amount": 50, "transfer_ok": None}])


@pytest.mark.asyncio
async def test_v4_paid_then_push_sent():
    db = _DB()
    did, sid = await _seed_one_winner_draw(db)
    push = PushRecorder(mode="sent")
    await _finalize(db, sid, provider=FakeProvider(), push=push)
    w = (await db.speaking_lab_lucky_draws.find_one({"draw_id": did}))["results"][0]
    assert w["transfer_state"] == ld.TRANSFER_PAID
    assert w["push_notification_state"] == ld.PUSH_SENT
    assert w["push_sent_count"] == 1
    assert len(push.calls) == 1


@pytest.mark.asyncio
async def test_v4_zero_subscribers_marks_no_subscribers_reward_paid():
    db = _DB()
    did, sid = await _seed_one_winner_draw(db)
    push = PushRecorder(mode="no_subscribers")
    await _finalize(db, sid, provider=FakeProvider(), push=push)
    w = (await db.speaking_lab_lucky_draws.find_one({"draw_id": did}))["results"][0]
    assert w["transfer_state"] == ld.TRANSFER_PAID         # reward stays paid
    assert w["push_notification_state"] == ld.PUSH_NO_SUBSCRIBERS
    assert len(push.calls) == 1


@pytest.mark.asyncio
async def test_v4_push_callback_exception_marks_failed_reward_paid():
    db = _DB()
    did, sid = await _seed_one_winner_draw(db)
    push = PushRecorder(fail=True)
    await _finalize(db, sid, provider=FakeProvider(), push=push)
    w = (await db.speaking_lab_lucky_draws.find_one({"draw_id": did}))["results"][0]
    assert w["transfer_state"] == ld.TRANSFER_PAID
    assert w["push_notification_state"] == ld.PUSH_FAILED


@pytest.mark.asyncio
async def test_v4_push_callback_failed_result_marks_failed():
    db = _DB()
    did, sid = await _seed_one_winner_draw(db)
    push = PushRecorder(mode="failed")
    await _finalize(db, sid, provider=FakeProvider(), push=push)
    w = (await db.speaking_lab_lucky_draws.find_one({"draw_id": did}))["results"][0]
    assert w["push_notification_state"] == ld.PUSH_FAILED


@pytest.mark.asyncio
async def test_v4_paid_state_persisted_before_push_called():
    db = _DB()
    did, sid = await _seed_one_winner_draw(db)
    SL = db.speaking_lab_lucky_draws
    observed = {}

    async def _push(student_id, amount, code):
        w = (await SL.find_one({"draw_id": did}))["results"][0]
        observed["state_at_push"] = w["transfer_state"]
        return {"attempted": True, "sent": 1, "failed": 0,
                "no_subscribers": False, "error": ""}
    await _finalize(db, sid, provider=FakeProvider(), push=_push)
    assert observed["state_at_push"] == ld.TRANSFER_PAID   # durable before push


@pytest.mark.asyncio
async def test_v4_cancellation_before_callback_not_marked_sent():
    db = _DB()
    did, sid = await _seed_one_winner_draw(db)
    # Pay first (no push), then drive push directly with a cancelling callback.
    await _finalize(db, sid, provider=FakeProvider(), push=None)
    SL = db.speaking_lab_lucky_draws

    async def _cancel_push(student_id, amount, code):
        raise asyncio.CancelledError()
    with pytest.raises(asyncio.CancelledError):
        await ld._send_winner_push_idempotent(
            SL, did, "stuA", 50, "STAR-1",
            ld._stable_reference(did, sid, "stuA"), _cancel_push,
            ld.logging.getLogger("t"))
    w = (await SL.find_one({"draw_id": did}))["results"][0]
    assert w["push_notification_state"] == ld.PUSH_SENDING   # never 'sent'


@pytest.mark.asyncio
async def test_v4_concurrent_push_retries_call_push_once():
    db = _DB()
    did, sid = await _seed_one_winner_draw(db)
    await _finalize(db, sid, provider=FakeProvider(), push=PushRecorder(mode="failed"))
    SL = db.speaking_lab_lucky_draws
    push = PushRecorder(mode="sent")
    ref = ld._stable_reference(did, sid, "stuA")

    async def _retry():
        await ld._send_winner_push_idempotent(
            SL, did, "stuA", 50, "STAR-1", ref, push, ld.logging.getLogger("t"))
    await asyncio.gather(_retry(), _retry())
    assert len(push.calls) == 1                              # exactly one call
    w = (await SL.find_one({"draw_id": did}))["results"][0]
    assert w["push_notification_state"] == ld.PUSH_SENT


@pytest.mark.asyncio
async def test_v4_notification_retry_never_calls_provider():
    db = _DB()
    did, sid = await _seed_one_winner_draw(db)
    prov = FakeProvider()
    await _finalize(db, sid, provider=prov, push=PushRecorder(mode="failed"))
    assert prov.calls == 1
    push = PushRecorder(mode="sent")
    await ld._retry_push_only(db, sid, ld.logging.getLogger("t"),
                              push_notify=push)
    assert prov.calls == 1                                   # GAS not called
    assert len(push.calls) == 1


@pytest.mark.asyncio
async def test_v4_reprocess_sent_no_duplicate_push():
    db = _DB()
    did, sid = await _seed_one_winner_draw(db)
    push = PushRecorder(mode="sent")
    await _finalize(db, sid, provider=FakeProvider(), push=push)
    await _finalize(db, sid, provider=FakeProvider(), push=push)
    assert len(push.calls) == 1


@pytest.mark.asyncio
async def test_v4_manual_review_and_mock_send_no_push():
    db = _DB()
    _, sid = await _seed_one_winner_draw(db)
    push = PushRecorder(mode="sent")
    await _finalize(db, sid, provider=FakeProvider(outcome="manual_review"),
                    push=push)
    assert push.calls == []
    db2 = _DB()
    _, sid2 = await _seed_prepared_draw(db2, mock=True, winners=[
        {"student_id": "stuA", "display_name": "A", "code": "S", "amount": 50,
         "transfer_ok": None}])
    push2 = PushRecorder(mode="sent")
    await _finalize(db2, sid2, provider=FakeProvider(outcome="mock"),
                    push=push2, mock_gas=True)
    assert push2.calls == []
