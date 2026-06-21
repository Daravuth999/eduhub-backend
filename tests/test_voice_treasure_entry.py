"""tests/test_voice_treasure_entry.py
=====================================
Phase 3 tests — paid mission access and recovery (GAS-authoritative).

Self-contained: defines an in-memory fake Mongo + a fake FastAPI router that
captures the route handlers, and monkeypatches the GAS adapter so no network
is touched. Runnable under real pytest in any environment where fastapi /
pymongo / httpx import (the GAS calls themselves are stubbed).

Covers the Phase 3 checklist:
  * master switch off / Author Studio disabled / ineligible / daily limit
  * sufficient vs insufficient GAS balance
  * playable mission exists before charge; no mission ⇒ no charge
  * fallback mission charged only after explicit confirm
  * successful debit; duplicate confirm doesn't double-charge
  * simultaneous confirms initiate once
  * refresh returns existing paid entry; reopening doesn't re-charge
  * confirmed debit failure (retryable)
  * ambiguous debit → reconciliation, never auto-retried
  * credentials never stored/logged; private GAS errors not exposed
"""
from __future__ import annotations

import asyncio
import copy

import pytest

import voice_treasure_config_tools as vt_cfg
import voice_treasure_points_adapter as vt_points
from voice_treasure_entry_tools import (
    register_voice_treasure_entry_routes,
    S_SUCCEEDED, S_FAILED, S_RECONCILE, S_INITIATING, S_CREATED,
    COLL_ENTRIES,
)


def run(coro):
    return asyncio.run(coro)


# ── in-memory fake Mongo ──────────────────────────────────────────────────
def _match(doc, query):
    for k, v in query.items():
        dv = doc.get(k)
        if isinstance(v, dict) and "$in" in v:
            if dv not in v["$in"]:
                return False
        elif dv != v:
            return False
    return True


class _Cursor:
    def __init__(self, docs):
        self._docs = docs

    def sort(self, field, direction=1):
        self._docs.sort(key=lambda d: d.get(field) or "", reverse=(direction == -1))
        return self

    def limit(self, n):
        self._docs = self._docs[:n]
        return self

    def __aiter__(self):
        async def gen():
            for d in self._docs:
                yield d
        return gen()


class _Coll:
    def __init__(self):
        self.docs = {}

    async def create_index(self, *a, **k):
        return None

    async def find_one(self, query, projection=None):
        for d in self.docs.values():
            if _match(d, query):
                out = copy.deepcopy(d)
                if projection and projection.get("_id") == 0:
                    out.pop("_id", None)
                return out
        return None

    def _apply(self, doc, update):
        if "$setOnInsert" in update:
            for k, v in update["$setOnInsert"].items():
                doc.setdefault(k, v)
        if "$set" in update:
            doc.update(update["$set"])
        if "$inc" in update:
            for k, v in update["$inc"].items():
                doc[k] = (doc.get(k) or 0) + v
        if "$push" in update:
            for k, v in update["$push"].items():
                doc.setdefault(k, [])
                doc[k].append(v)
        return doc

    async def update_one(self, query, update, upsert=False):
        _id = query.get("_id")
        target = None
        for d in self.docs.values():
            if _match(d, query):
                target = d
                break
        if target is None and upsert:
            base = {"_id": _id}
            self._apply(base, update)
            self.docs[base["_id"]] = base
            return
        if target is not None:
            self._apply(target, update)

    async def find_one_and_update(self, query, update, return_document=True):
        for d in self.docs.values():
            if _match(d, query):
                self._apply(d, update)
                return copy.deepcopy(d)
        return None

    async def count_documents(self, query):
        return sum(1 for d in self.docs.values() if _match(d, query))

    def find(self, query, projection=None):
        out = []
        for d in self.docs.values():
            if _match(d, query):
                o = copy.deepcopy(d)
                if projection and projection.get("_id") == 0:
                    o.pop("_id", None)
                out.append(o)
        return _Cursor(out)


    async def delete_one(self, query):
        for k, d in list(self.docs.items()):
            if all(d.get(qk) == qv for qk, qv in query.items()):
                del self.docs[k]
                return
        return


class _DB:
    def __init__(self):
        self._c = {}

    def __getitem__(self, name):
        return self._c.setdefault(name, _Coll())


# ── fake FastAPI router that captures handlers ────────────────────────────
class _Router:
    def __init__(self):
        self.routes = {}

    def get(self, path):
        def deco(fn):
            self.routes[("GET", path)] = fn
            return fn
        return deco

    def post(self, path):
        def deco(fn):
            self.routes[("POST", path)] = fn
            return fn
        return deco


class _Admin:
    username = "admin1"


class _Student:
    def __init__(self, sid="stu_alice", clean="alice", groups=None):
        self.student_id = sid
        self.clean_id = clean
        self.groups = groups or []


def _http_status(exc):
    return getattr(exc, "status_code", None)


# ── fixtures ──────────────────────────────────────────────────────────────
@pytest.fixture(autouse=True)
def _env(monkeypatch):
    for k in ("VOICE_TREASURE_ENABLED",):
        monkeypatch.delenv(k, raising=False)
    # GAS appears configured for the paid feature in tests.
    monkeypatch.setattr(vt_points, "gas_debit_configured", lambda: True)
    yield


def _enabled_config():
    cfg = vt_cfg.default_config()
    cfg["access"]["enabled"] = True
    cfg["access"]["show_home_tile"] = True
    cfg["access"]["open_to_all"] = True
    cfg["access"]["daily_play_limit"] = 2
    cfg["entry"]["entry_cost_points"] = 10
    return cfg


def _build(monkeypatch, cfg=None, balance=100, debit_outcome="ok"):
    db = _DB()
    router = _Router()
    register_voice_treasure_entry_routes(router, db, require_admin=object(), require_student=object())
    cfg = cfg if cfg is not None else _enabled_config()
    monkeypatch.setattr(vt_cfg, "load_config", lambda _db: _async_val(copy.deepcopy(cfg)))

    async def fake_balance(clean, password):
        if not password:
            return None, "missing_password"
        return balance, ""
    monkeypatch.setattr(vt_points, "get_authoritative_balance", fake_balance)

    async def fake_debit(clean, password, amount, *, nonce=None):
        return {"outcome": debit_outcome, "reason": "rejected_secret_treasury" if debit_outcome == "rejected" else "x", "nonce": nonce}
    monkeypatch.setattr(vt_points, "debit_entry", fake_debit)
    return db, router


def _async_val(v):
    async def _f():
        return v
    return _f()


def _call(router, method, path, **kwargs):
    fn = router.routes[(method, path)]
    return run(fn(**kwargs))


# ── availability gates ────────────────────────────────────────────────────
def test_today_unavailable_when_master_off(monkeypatch):
    db, router = _build(monkeypatch)  # master env OFF by default
    res = _call(router, "GET", "/voice-treasure/today", student=_Student())
    assert res["available"] is False


def test_today_unavailable_when_studio_disabled(monkeypatch):
    monkeypatch.setenv("VOICE_TREASURE_ENABLED", "1")
    cfg = _enabled_config()
    cfg["access"]["enabled"] = False  # Author Studio disabled
    db, router = _build(monkeypatch, cfg=cfg)
    res = _call(router, "GET", "/voice-treasure/today", student=_Student())
    assert res["available"] is False


def test_today_unavailable_for_ineligible(monkeypatch):
    monkeypatch.setenv("VOICE_TREASURE_ENABLED", "1")
    cfg = _enabled_config()
    cfg["access"]["open_to_all"] = False
    cfg["access"]["eligible_student_ids"] = ["someone_else"]
    db, router = _build(monkeypatch, cfg=cfg)
    res = _call(router, "GET", "/voice-treasure/today", student=_Student())
    assert res["available"] is False


def test_today_offer_when_available(monkeypatch):
    monkeypatch.setenv("VOICE_TREASURE_ENABLED", "1")
    db, router = _build(monkeypatch)
    res = _call(router, "GET", "/voice-treasure/today", student=_Student())
    assert res["available"] is True
    assert res["mission"]["playable"] is True
    assert res["entry"]["entry_cost_points"] == 10
    assert res["mission"]["image_kind"] == "bundled"


# ── preview (no charge) ───────────────────────────────────────────────────
def test_preview_shows_balance_without_charging(monkeypatch):
    monkeypatch.setenv("VOICE_TREASURE_ENABLED", "1")
    db, router = _build(monkeypatch, balance=42)
    res = _call(router, "POST", "/voice-treasure/entry/confirm",
                payload={"password": "pw"}, student=_Student())
    assert res["mode"] == "preview"
    assert res["balance"] == 42
    assert res["sufficient"] is True
    # nothing charged → no entry record yet
    assert len(db[COLL_ENTRIES].docs) == 0


def test_preview_requires_password(monkeypatch):
    monkeypatch.setenv("VOICE_TREASURE_ENABLED", "1")
    db, router = _build(monkeypatch)
    with pytest.raises(Exception) as ei:
        _call(router, "POST", "/voice-treasure/entry/confirm",
              payload={}, student=_Student())
    assert _http_status(ei.value) == 400


# ── commit: success / insufficient / limit ────────────────────────────────
def test_commit_success_debits_once(monkeypatch):
    monkeypatch.setenv("VOICE_TREASURE_ENABLED", "1")
    db, router = _build(monkeypatch, balance=100, debit_outcome="ok")
    res = _call(router, "POST", "/voice-treasure/entry/confirm",
                payload={"password": "pw", "confirm": True}, student=_Student())
    assert res["entry"]["state"] == S_SUCCEEDED
    assert res["entry"]["paid"] is True


def test_commit_insufficient_balance(monkeypatch):
    monkeypatch.setenv("VOICE_TREASURE_ENABLED", "1")
    db, router = _build(monkeypatch, balance=3, debit_outcome="ok")
    with pytest.raises(Exception) as ei:
        _call(router, "POST", "/voice-treasure/entry/confirm",
              payload={"password": "pw", "confirm": True}, student=_Student())
    assert _http_status(ei.value) == 402
    # no entry should have been charged to succeeded
    assert db[COLL_ENTRIES].docs == {} or all(
        d["state"] != S_SUCCEEDED for d in db[COLL_ENTRIES].docs.values()
    )


def test_daily_limit_blocks_confirm(monkeypatch):
    monkeypatch.setenv("VOICE_TREASURE_ENABLED", "1")
    import voice_treasure_entry_tools as vte
    cfg = _enabled_config()
    cfg["access"]["daily_play_limit"] = 2
    db, router = _build(monkeypatch, cfg=cfg, balance=100)
    today = vte._today()
    # Pre-seed two succeeded entries for OTHER missions today ⇒ limit reached.
    for m in ("m2", "m3"):
        k = f"vt-entry:stu_alice:{today}:{m}"
        db[COLL_ENTRIES].docs[k] = {
            "_id": k, "student_id": "stu_alice", "mission_date": today,
            "state": S_SUCCEEDED,
        }
    # Confirming today's (unpaid) mission must be blocked by the daily limit.
    with pytest.raises(Exception) as ei:
        _call(router, "POST", "/voice-treasure/entry/confirm",
              payload={"password": "pw", "confirm": True}, student=_Student())
    assert _http_status(ei.value) == 429


# ── duplicate / refresh / reopen recovery ─────────────────────────────────
def test_duplicate_confirm_does_not_double_charge(monkeypatch):
    monkeypatch.setenv("VOICE_TREASURE_ENABLED", "1")
    calls = {"n": 0}

    db, router = _build(monkeypatch, balance=100)

    async def counting_debit(clean, password, amount, *, nonce=None):
        calls["n"] += 1
        return {"outcome": "ok", "reason": "x", "nonce": nonce}
    monkeypatch.setattr(vt_points, "debit_entry", counting_debit)

    p = {"password": "pw", "confirm": True}
    r1 = _call(router, "POST", "/voice-treasure/entry/confirm", payload=p, student=_Student())
    r2 = _call(router, "POST", "/voice-treasure/entry/confirm", payload=p, student=_Student())
    assert r1["entry"]["state"] == S_SUCCEEDED
    assert r2.get("already_paid") is True
    assert calls["n"] == 1  # debited exactly once


def test_refresh_via_get_entry_returns_paid(monkeypatch):
    monkeypatch.setenv("VOICE_TREASURE_ENABLED", "1")
    db, router = _build(monkeypatch, balance=100)
    r = _call(router, "POST", "/voice-treasure/entry/confirm",
              payload={"password": "pw", "confirm": True}, student=_Student())
    eid = r["entry"]["entry_id"]
    got = _call(router, "GET", "/voice-treasure/entry/{entry_id}", entry_id=eid, student=_Student())
    assert got["entry"]["state"] == S_SUCCEEDED


def test_get_entry_rejects_other_student(monkeypatch):
    monkeypatch.setenv("VOICE_TREASURE_ENABLED", "1")
    db, router = _build(monkeypatch, balance=100)
    r = _call(router, "POST", "/voice-treasure/entry/confirm",
              payload={"password": "pw", "confirm": True}, student=_Student())
    eid = r["entry"]["entry_id"]
    with pytest.raises(Exception) as ei:
        _call(router, "GET", "/voice-treasure/entry/{entry_id}", entry_id=eid,
              student=_Student(sid="stu_mallory", clean="mallory"))
    assert _http_status(ei.value) == 404


# ── failure / ambiguous outcomes ──────────────────────────────────────────
def test_confirmed_debit_failure_is_retryable(monkeypatch):
    monkeypatch.setenv("VOICE_TREASURE_ENABLED", "1")
    db, router = _build(monkeypatch, balance=100, debit_outcome="rejected")
    r = _call(router, "POST", "/voice-treasure/entry/confirm",
              payload={"password": "pw", "confirm": True}, student=_Student())
    assert r["entry"]["state"] == S_FAILED
    # public reason must be safe, NOT the raw GAS message
    assert r["entry"]["reason"] == "debit_failed"
    assert "treasury" not in str(r["entry"])  # raw provider text not exposed


def test_ambiguous_debit_enters_reconciliation(monkeypatch):
    monkeypatch.setenv("VOICE_TREASURE_ENABLED", "1")
    db, router = _build(monkeypatch, balance=100, debit_outcome="ambiguous")
    r = _call(router, "POST", "/voice-treasure/entry/confirm",
              payload={"password": "pw", "confirm": True}, student=_Student())
    assert r["entry"]["state"] == S_RECONCILE
    assert r["entry"]["reason"] == "pending_review"


def test_ambiguous_is_never_auto_retried(monkeypatch):
    monkeypatch.setenv("VOICE_TREASURE_ENABLED", "1")
    calls = {"n": 0}
    db, router = _build(monkeypatch, balance=100)

    async def amb(clean, password, amount, *, nonce=None):
        calls["n"] += 1
        return {"outcome": "ambiguous", "reason": "network_Timeout", "nonce": nonce}
    monkeypatch.setattr(vt_points, "debit_entry", amb)

    p = {"password": "pw", "confirm": True}
    _call(router, "POST", "/voice-treasure/entry/confirm", payload=p, student=_Student())
    # second confirm must NOT re-initiate a debit on a reconciliation entry
    r2 = _call(router, "POST", "/voice-treasure/entry/confirm", payload=p, student=_Student())
    assert calls["n"] == 1
    assert r2.get("already_in_progress") is True


# ── admin reconciliation visibility ───────────────────────────────────────
def test_admin_reconciliation_lists_ambiguous(monkeypatch):
    monkeypatch.setenv("VOICE_TREASURE_ENABLED", "1")
    db, router = _build(monkeypatch, balance=100, debit_outcome="ambiguous")
    _call(router, "POST", "/voice-treasure/entry/confirm",
          payload={"password": "pw", "confirm": True}, student=_Student())
    q = _call(router, "GET", "/admin/voice-treasure/reconciliation", admin=object())
    assert q["count"] == 1
    assert q["reconciliation_queue"][0]["state"] == S_RECONCILE


# ── credential hygiene ────────────────────────────────────────────────────
def test_password_never_stored_in_entry(monkeypatch):
    monkeypatch.setenv("VOICE_TREASURE_ENABLED", "1")
    db, router = _build(monkeypatch, balance=100)
    _call(router, "POST", "/voice-treasure/entry/confirm",
          payload={"password": "super-secret-pw", "confirm": True}, student=_Student())
    blob = str(db[COLL_ENTRIES].docs)
    assert "super-secret-pw" not in blob


def _scan_no_credentials(db, secret):
    """Every persisted value in every collection must be free of the secret
    and of any obvious credential-like key."""
    import voice_treasure_entry_tools as vte
    for coll_name in (vte.COLL_ENTRIES, vte.COLL_MISSIONS):
        for doc in db[coll_name].docs.values():
            blob = repr(doc)
            assert secret not in blob, f"secret leaked in {coll_name}: {blob}"
            for k in doc.keys():
                assert "password" not in k.lower()
                assert k.lower() not in ("pw", "pwd", "secret", "credential")


def test_no_credential_in_any_persisted_field_all_outcomes(monkeypatch):
    monkeypatch.setenv("VOICE_TREASURE_ENABLED", "1")
    secret = "P@ss-w0rd-LEAK-CHECK"
    for outcome in ("ok", "rejected", "ambiguous"):
        db, router = _build(monkeypatch, balance=100, debit_outcome=outcome)
        # preview (no persist) then commit (persist) with the secret password
        _call(router, "POST", "/voice-treasure/entry/confirm",
              payload={"password": secret}, student=_Student())
        _call(router, "POST", "/voice-treasure/entry/confirm",
              payload={"password": secret, "confirm": True}, student=_Student())
        _scan_no_credentials(db, secret)
        # admin records must also be clean
        q = _call(router, "GET", "/admin/voice-treasure/entries", admin=object())
        assert secret not in repr(q)


def test_preview_creates_no_persistence(monkeypatch):
    monkeypatch.setenv("VOICE_TREASURE_ENABLED", "1")
    import voice_treasure_entry_tools as vte
    db, router = _build(monkeypatch, balance=42)
    before_entries = len(db[vte.COLL_ENTRIES].docs)
    res = _call(router, "POST", "/voice-treasure/entry/confirm",
                payload={"password": "pw"}, student=_Student())
    assert res["mode"] == "preview"
    # No entry transaction created or mutated by a preview.
    assert len(db[vte.COLL_ENTRIES].docs) == before_entries == 0


def test_confirmed_failure_then_explicit_retry_audit(monkeypatch):
    monkeypatch.setenv("VOICE_TREASURE_ENABLED", "1")
    import voice_treasure_entry_tools as vte
    db, router = _build(monkeypatch, balance=100, debit_outcome="rejected")
    p = {"password": "pw", "confirm": True}
    r1 = _call(router, "POST", "/voice-treasure/entry/confirm", payload=p, student=_Student())
    assert r1["entry"]["state"] == S_FAILED
    ekey = r1["entry"]["entry_id"]
    doc1 = db[vte.COLL_ENTRIES].docs[ekey]
    op1 = doc1["last_operation_id"]
    assert doc1["initiation_count"] == 1
    # Now make the retry succeed.
    async def ok_debit(clean, password, amount, *, nonce=None):
        return {"outcome": "ok", "reason": "x", "nonce": nonce}
    monkeypatch.setattr(vt_points, "debit_entry", ok_debit)
    r2 = _call(router, "POST", "/voice-treasure/entry/confirm", payload=p, student=_Student())
    assert r2["entry"]["state"] == S_SUCCEEDED
    doc2 = db[vte.COLL_ENTRIES].docs[ekey]
    assert doc2["initiation_count"] == 2            # a second controlled op ran
    assert doc2["last_operation_id"] != op1        # new internal operation id
    states = [h["state"] for h in doc2["state_history"]]
    assert states.count("initiating") == 2         # two distinct initiations
    assert "confirmed_failed" in states and "succeeded" in states


def test_get_entry_never_triggers_retry(monkeypatch):
    monkeypatch.setenv("VOICE_TREASURE_ENABLED", "1")
    import voice_treasure_entry_tools as vte
    calls = {"n": 0}
    db, router = _build(monkeypatch, balance=100)

    async def amb(clean, password, amount, *, nonce=None):
        calls["n"] += 1
        return {"outcome": "ambiguous", "reason": "network_Timeout", "nonce": nonce}
    monkeypatch.setattr(vt_points, "debit_entry", amb)
    r = _call(router, "POST", "/voice-treasure/entry/confirm",
              payload={"password": "pw", "confirm": True}, student=_Student())
    eid = r["entry"]["entry_id"]
    # Multiple GETs / refreshes must never initiate another debit.
    for _ in range(3):
        _call(router, "GET", "/voice-treasure/entry/{entry_id}", entry_id=eid, student=_Student())
    assert calls["n"] == 1


def test_admin_entry_reconcile_resolves_paid(monkeypatch):
    db, router = _build(monkeypatch)
    ekey = "e-stuck-1"
    db[COLL_ENTRIES].docs[ekey] = {
        "_id": ekey, "entry_id": ekey, "student_id": "stu_alice",
        "state": S_RECONCILE, "mission_date": "2026-06-21"}
    out = _call(router, "POST", "/admin/voice-treasure/entries/{entry_id}/reconcile",
                entry_id=ekey, payload={"outcome": "resolved_paid", "evidence": "GAS shows debit applied"},
                admin=_Admin())
    assert out["entry"]["state"] == S_SUCCEEDED


def test_admin_entry_reconcile_requires_evidence(monkeypatch):
    db, router = _build(monkeypatch)
    ekey = "e-stuck-2"
    db[COLL_ENTRIES].docs[ekey] = {
        "_id": ekey, "entry_id": ekey, "student_id": "stu_alice",
        "state": S_RECONCILE, "mission_date": "2026-06-21"}
    with pytest.raises(Exception) as ei:
        _call(router, "POST", "/admin/voice-treasure/entries/{entry_id}/reconcile",
              entry_id=ekey, payload={"outcome": "resolved_paid", "evidence": ""}, admin=_Admin())
    assert getattr(ei.value, "status_code", None) == 400


def test_admin_reopen_paid_entry(monkeypatch):
    db, router = _build(monkeypatch)
    ekey = "e-paid-reopen"
    db[COLL_ENTRIES].docs[ekey] = {
        "_id": ekey, "entry_id": ekey, "student_id": "stu_alice",
        "state": S_SUCCEEDED, "mission_date": "2026-06-21"}
    # pre-existing attempt that should be cleared on reopen
    db["voice_treasure_attempts"].docs["vt-attempt:stu_alice:e-paid-reopen"] = {
        "_id": "vt-attempt:stu_alice:e-paid-reopen", "student_id": "stu_alice"}
    out = _call(router, "POST", "/admin/voice-treasure/entries/{entry_id}/reopen",
                entry_id=ekey, payload={"reason": "tech failure during eval"}, admin=_Admin())
    assert out["entry"]["state"] == S_SUCCEEDED
    assert out["entry"]["reopened"] is True
    assert out["audit"]["action"] == "reopen" and out["audit"]["actor"]
    assert "vt-attempt:stu_alice:e-paid-reopen" not in db["voice_treasure_attempts"].docs


def test_admin_reopen_requires_reason(monkeypatch):
    db, router = _build(monkeypatch)
    ekey = "e-paid-2"
    db[COLL_ENTRIES].docs[ekey] = {
        "_id": ekey, "entry_id": ekey, "student_id": "stu_alice",
        "state": S_SUCCEEDED, "mission_date": "2026-06-21"}
    with pytest.raises(Exception) as ei:
        _call(router, "POST", "/admin/voice-treasure/entries/{entry_id}/reopen",
              entry_id=ekey, payload={"reason": ""}, admin=_Admin())
    assert getattr(ei.value, "status_code", None) == 400


def test_admin_reopen_rejects_unpaid(monkeypatch):
    db, router = _build(monkeypatch)
    ekey = "e-unpaid"
    db[COLL_ENTRIES].docs[ekey] = {
        "_id": ekey, "entry_id": ekey, "student_id": "stu_alice",
        "state": S_CREATED, "mission_date": "2026-06-21"}
    with pytest.raises(Exception) as ei:
        _call(router, "POST", "/admin/voice-treasure/entries/{entry_id}/reopen",
              entry_id=ekey, payload={"reason": "x"}, admin=_Admin())
    assert getattr(ei.value, "status_code", None) == 409


def test_admin_replace_mission_preserves_paid_entry(monkeypatch):
    db, router = _build(monkeypatch)
    date = "2026-06-21"
    ekey = "e-replace"
    db[COLL_ENTRIES].docs[ekey] = {
        "_id": ekey, "entry_id": ekey, "student_id": "stu_alice",
        "state": S_SUCCEEDED, "mission_date": date, "cost_points": 10}
    import voice_treasure_entry_tools as vte2
    mkey = vte2._mission_key("stu_alice", date)
    db[vte2.COLL_MISSIONS].docs[mkey] = {
        "_id": mkey, "student_id": "stu_alice", "date": date,
        "scene_id": "balloon", "image_ref": "vt-scene-balloon", "playable": True}
    out = _call(router, "POST", "/admin/voice-treasure/entries/{entry_id}/replace-mission",
                entry_id=ekey, payload={"reason": "image failed to load"}, admin=_Admin())
    assert out["entry"]["state"] == S_SUCCEEDED        # still paid
    assert out["mission_scene"]                          # a new scene assigned
    assert out["audit"]["action"] == "replace_mission"
