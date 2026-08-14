"""tests/test_voice_treasure_reward.py
=======================================
Final milestone — backend tests for reward economy, GAS-authoritative credit,
chest state, First Voice Card, collection, progress, payout caps, and
reconciliation. Self-contained fakes; the GAS adapter is monkeypatched so no
network/credentials are used. Runnable under real pytest where deps import.
"""
from __future__ import annotations

import asyncio
import copy

import pytest

import voice_treasure_config_tools as vt_cfg
import voice_treasure_entry_tools as vt_entry
import voice_treasure_attempt_tools as vt_attempt
import voice_treasure_points_adapter as vt_points
import voice_treasure_reward_tools as vt_reward
from voice_treasure_reward_tools import (
    register_voice_treasure_reward_routes, compute_reward_decision,
    compute_streaks, classify_chest_state,
    R_SUCCEEDED, R_FAILED, R_RECONCILE, R_INITIATING, COLL_REWARDS, COLL_COLLECTION,
    CHEST_COMPLETED, CHEST_RECONCILE, CHEST_FAILED, CHEST_INELIGIBLE,
    CARD_NEW, CARD_OWNED, CARD_FAILED,
)


def run(c): return asyncio.run(c)


def _match(doc, q):
    for k, v in q.items():
        dv = doc.get(k)
        if isinstance(v, dict):
            if "$in" in v and dv not in v["$in"]:
                return False
            if "$ne" in v and dv == v["$ne"]:
                return False
            if "$gte" in v and not (dv is not None and dv >= v["$gte"]):
                return False
            if "$lte" in v and not (dv is not None and dv <= v["$lte"]):
                return False
            if "$lt" in v and not (dv is not None and dv < v["$lt"]):
                return False
            if not any(op in v for op in ("$in", "$ne", "$gte", "$lte", "$lt")) and dv != v:
                return False
        elif dv != v:
            return False
    return True


class _Cursor:
    def __init__(s, d): s._d = d
    def sort(s, f, d=1): s._d.sort(key=lambda x: x.get(f) or "", reverse=(d == -1)); return s
    def limit(s, n): s._d = s._d[:n]; return s
    def __aiter__(s):
        async def g():
            for x in s._d: yield x
        return g()


class _Coll:
    def __init__(s): s.docs = {}
    async def create_index(s, *a, **k): return None
    async def count_documents(s, q): return sum(1 for d in s.docs.values() if _match(d, q))
    async def find_one(s, q, p=None):
        for d in s.docs.values():
            if _match(d, q):
                o = copy.deepcopy(d); o.pop("_id", None) if (p and p.get("_id") == 0) else None; return o
        return None
    def _apply(s, doc, up):
        if "$setOnInsert" in up:
            for k, v in up["$setOnInsert"].items(): doc.setdefault(k, v)
        if "$set" in up: doc.update(up["$set"])
        if "$inc" in up:
            for k, v in up["$inc"].items(): doc[k] = (doc.get(k) or 0) + v
        if "$push" in up:
            for k, v in up["$push"].items(): doc.setdefault(k, []).append(v)
        return doc
    async def update_one(s, q, up, upsert=False):
        for d in s.docs.values():
            if _match(d, q): s._apply(d, up); return type("R", (), {"matched_count": 1})()
        if upsert:
            base = {"_id": q.get("_id")}; s._apply(base, up); s.docs[base["_id"]] = base
        return type("R", (), {"matched_count": 0})()
    async def find_one_and_update(s, q, up):
        for d in s.docs.values():
            if _match(d, q): s._apply(d, up); return copy.deepcopy(d)
        return None
    def find(s, q, p=None):
        out = []
        for d in s.docs.values():
            if _match(d, q):
                o = copy.deepcopy(d); o.pop("_id", None) if (p and p.get("_id") == 0) else None; out.append(o)
        return _Cursor(out)


class _DB:
    def __init__(s): s._c = {}
    def __getitem__(s, n): return s._c.setdefault(n, _Coll())


class _Router:
    def __init__(s): s.routes = {}
    def get(s, p):
        def d(fn): s.routes[("GET", p)] = fn; return fn
        return d
    def post(s, p):
        def d(fn): s.routes[("POST", p)] = fn; return fn
        return d


class _Student:
    def __init__(s, sid="stu_alice"): s.student_id = sid; s.clean_id = sid; s.groups = []


class _Admin:
    username = "admin1"


def _status(e): return getattr(e, "status_code", None)


@pytest.fixture(autouse=True)
def _env(monkeypatch):
    monkeypatch.setenv("VOICE_TREASURE_ENABLED", "1")
    monkeypatch.setenv("VOICE_TREASURE_POINTS_REWARD_ENABLED", "1")
    yield


def _cfg(points=True, card=True, base=10, minscore=60, daily_cap=100, weekly_cap=500, streak=False):
    c = vt_cfg.default_config()
    c["access"]["enabled"] = True
    c["access"]["open_to_all"] = True
    c["rewards"]["points_reward_enabled"] = points
    c["rewards"]["first_voice_card_enabled"] = card
    c["rewards"]["base_points_reward"] = base
    c["rewards"]["maximum_points_reward"] = 50
    c["rewards"]["minimum_eligible_score"] = minscore
    c["rewards"]["daily_points_payout_cap"] = daily_cap
    c["rewards"]["weekly_points_payout_cap"] = weekly_cap
    c["rewards"]["streak_reward_enabled"] = streak
    c["rewards"]["streak_bonus_points"] = 2
    c["rewards"]["streak_bonus_max"] = 10
    return c


def _aval(v):
    async def f(): return v
    return f()


def _build(monkeypatch, cfg=None, credit_outcome=("ok", None)):
    db = _DB(); router = _Router()
    register_voice_treasure_reward_routes(router, db, require_admin=_Admin(), require_student=object())
    cfg = cfg or _cfg()
    monkeypatch.setattr(vt_cfg, "load_config", lambda _db: _aval(copy.deepcopy(cfg)))

    async def fake_credit(clean, amount, *, nonce=None):
        kind, reason = credit_outcome
        if kind == "ok":
            return {"outcome": vt_points.OUTCOME_OK, "reason": "", "nonce": nonce}
        if kind == "rejected":
            return {"outcome": vt_points.OUTCOME_REJECTED, "reason": reason or "rejected_x", "nonce": nonce}
        return {"outcome": vt_points.OUTCOME_AMBIGUOUS, "reason": reason or "network_x", "nonce": nonce}
    monkeypatch.setattr(vt_points, "credit_reward", fake_credit)
    return db, router


def _seed_evaluated(db, sid="stu_alice", overall=80, aid="vt-attempt:stu_alice:e1"):
    date = vt_entry._today()
    db[vt_attempt.COLL_ATTEMPTS].docs[aid] = {
        "_id": aid, "attempt_id": aid, "student_id": sid, "entry_id": "e1",
        "mission_date": date, "state": vt_attempt.A_EVALUATED,
        "result": {"scores": {k: overall for k in ("relevance", "visual_grounding", "detail",
                   "organization", "understandable_language")}, "overall": overall},
        "updated_at": date,
    }
    db[vt_entry.COLL_ENTRIES].docs["e1"] = {
        "_id": "e1", "entry_id": "e1", "student_id": sid, "state": vt_entry.S_SUCCEEDED,
        "mission_date": date, "cost_points": 10,
    }
    return aid


def _call(router, m, p, **kw): return run(router.routes[(m, p)](**kw))


# ── pure decision logic ─────────────────────────────────────────────────────
def test_decision_ineligible_low_score():
    d = compute_reward_decision(cfg=_cfg(base=10, minscore=60), attempt_result={"overall": 40},
                                current_streak=1, paid_today_points=0, paid_week_points=0)
    assert d["points_eligible"] is False
    assert d["total_points"] == 0
    # card still eligible (VT-owned) ⇒ overall eligible True
    assert d["card_eligible"] is True


def test_decision_eligible_freezes_amounts():
    d = compute_reward_decision(cfg=_cfg(base=10, minscore=60), attempt_result={"overall": 90},
                                current_streak=1, paid_today_points=0, paid_week_points=0)
    assert d["points_eligible"] is True
    assert d["base_points"] == 10
    assert d["total_points"] >= 10
    assert "policy_snapshot" in d and "decided_at" in d


def test_decision_daily_cap_clamps():
    d = compute_reward_decision(cfg=_cfg(base=50, minscore=60, daily_cap=100),
                                attempt_result={"overall": 90}, current_streak=1,
                                paid_today_points=80, paid_week_points=80)
    assert d["total_points"] == 20  # only 20 headroom left today
    assert d["cap_reason"] == "daily_cap"


def test_streaks_pure():
    s = compute_streaks(["2026-06-19", "2026-06-20", "2026-06-21"])
    assert s["longest"] == 3


# ── claim flow ──────────────────────────────────────────────────────────────
def test_ineligible_attempt_cannot_claim(monkeypatch):
    db, router = _build(monkeypatch)
    # attempt not evaluated
    db[vt_attempt.COLL_ATTEMPTS].docs["a"] = {
        "_id": "a", "attempt_id": "a", "student_id": "stu_alice", "state": vt_attempt.A_FAILED}
    with pytest.raises(Exception) as ei:
        _call(router, "POST", "/voice-treasure/claim", payload={"attempt_id": "a"}, student=_Student())
    assert _status(ei.value) == 409


def test_client_cannot_alter_score_or_reward(monkeypatch):
    db, router = _build(monkeypatch)
    aid = _seed_evaluated(db, overall=80)
    # client tries to inject score + reward amount
    res = _call(router, "POST", "/voice-treasure/claim",
                payload={"attempt_id": aid, "overall": 100, "total_points": 9999}, student=_Student())
    rw = db[COLL_REWARDS].docs[vt_reward._reward_key("stu_alice", aid)]
    assert rw["decision"]["overall_score"] == 80     # from persisted attempt
    assert rw["decision"]["total_points"] <= 50      # policy max, not client value
    assert res["chest"]["chest_state"] == CHEST_COMPLETED


def test_successful_credit_completes_and_grants_card(monkeypatch):
    db, router = _build(monkeypatch, credit_outcome=("ok", None))
    aid = _seed_evaluated(db, overall=90)
    res = _call(router, "POST", "/voice-treasure/claim", payload={"attempt_id": aid}, student=_Student())
    assert res["chest"]["chest_state"] == CHEST_COMPLETED
    assert res["chest"]["reward"]["points_credited"] >= 10
    assert res["chest"]["reward"]["first_voice_card"] in (CARD_NEW, CARD_OWNED)
    assert db[COLL_COLLECTION].docs.get(vt_reward._card_key("stu_alice")) is not None


def test_duplicate_claim_does_not_double_credit(monkeypatch):
    calls = {"n": 0}
    db, router = _build(monkeypatch, credit_outcome=("ok", None))

    async def counting(clean, amount, *, nonce=None):
        calls["n"] += 1
        return {"outcome": vt_points.OUTCOME_OK, "reason": "", "nonce": nonce}
    monkeypatch.setattr(vt_points, "credit_reward", counting)
    aid = _seed_evaluated(db, overall=90)
    _call(router, "POST", "/voice-treasure/claim", payload={"attempt_id": aid}, student=_Student())
    _call(router, "POST", "/voice-treasure/claim", payload={"attempt_id": aid}, student=_Student())
    assert calls["n"] == 1


def test_confirmed_failure_then_explicit_retry(monkeypatch):
    db, router = _build(monkeypatch, credit_outcome=("rejected", "rejected_insufficient"))
    aid = _seed_evaluated(db, overall=90)
    r1 = _call(router, "POST", "/voice-treasure/claim", payload={"attempt_id": aid}, student=_Student())
    assert r1["chest"]["chest_state"] == CHEST_FAILED
    rid = vt_reward._reward_key("stu_alice", aid)
    assert db[COLL_REWARDS].docs[rid]["initiation_count"] == 1
    # explicit retry → success
    monkeypatch.setattr(vt_points, "credit_reward",
                        lambda c, a, *, nonce=None: _aval({"outcome": vt_points.OUTCOME_OK, "reason": "", "nonce": nonce}))
    r2 = _call(router, "POST", "/voice-treasure/claim", payload={"attempt_id": aid}, student=_Student())
    assert r2["chest"]["chest_state"] == CHEST_COMPLETED
    assert db[COLL_REWARDS].docs[rid]["initiation_count"] == 2


def test_ambiguous_enters_reconciliation_and_seals(monkeypatch):
    db, router = _build(monkeypatch, credit_outcome=("ambiguous", "network_Timeout"))
    aid = _seed_evaluated(db, overall=90)
    res = _call(router, "POST", "/voice-treasure/claim", payload={"attempt_id": aid}, student=_Student())
    assert res["chest"]["chest_state"] == CHEST_RECONCILE
    assert "reward" not in res["chest"]  # sealed; no reward revealed


def test_ambiguous_never_auto_retries(monkeypatch):
    calls = {"n": 0}
    db, router = _build(monkeypatch)

    async def amb(clean, amount, *, nonce=None):
        calls["n"] += 1
        return {"outcome": vt_points.OUTCOME_AMBIGUOUS, "reason": "network_x", "nonce": nonce}
    monkeypatch.setattr(vt_points, "credit_reward", amb)
    aid = _seed_evaluated(db, overall=90)
    _call(router, "POST", "/voice-treasure/claim", payload={"attempt_id": aid}, student=_Student())
    # subsequent claims must NOT initiate again
    _call(router, "POST", "/voice-treasure/claim", payload={"attempt_id": aid}, student=_Student())
    _call(router, "POST", "/voice-treasure/claim", payload={"attempt_id": aid}, student=_Student())
    assert calls["n"] == 1


def test_status_route_never_initiates(monkeypatch):
    calls = {"n": 0}
    db, router = _build(monkeypatch)

    async def cnt(clean, amount, *, nonce=None):
        calls["n"] += 1
        return {"outcome": vt_points.OUTCOME_OK, "reason": "", "nonce": nonce}
    monkeypatch.setattr(vt_points, "credit_reward", cnt)
    aid = _seed_evaluated(db, overall=90)
    _call(router, "GET", "/voice-treasure/claim/{attempt_id}", attempt_id=aid, student=_Student())
    assert calls["n"] == 0


def test_reconciliation_success_resumes_without_gas(monkeypatch):
    calls = {"n": 0}
    db, router = _build(monkeypatch, credit_outcome=("ambiguous", "network_x"))

    async def cnt(clean, amount, *, nonce=None):
        calls["n"] += 1
        return {"outcome": vt_points.OUTCOME_AMBIGUOUS, "reason": "network_x", "nonce": nonce}
    monkeypatch.setattr(vt_points, "credit_reward", cnt)
    aid = _seed_evaluated(db, overall=90)
    _call(router, "POST", "/voice-treasure/claim", payload={"attempt_id": aid}, student=_Student())
    assert calls["n"] == 1
    rid = vt_reward._reward_key("stu_alice", aid)
    out = _call(router, "POST", "/admin/voice-treasure/rewards/{reward_id}/reconcile",
                reward_id=rid, payload={"outcome": "resolved_success", "evidence": "GAS log shows transfer ok"},
                admin=_Admin())
    assert out["reward"]["state"] == R_SUCCEEDED
    assert calls["n"] == 1  # no second GAS call
    # local fulfillment ran (card granted)
    assert db[COLL_COLLECTION].docs.get(vt_reward._card_key("stu_alice")) is not None


def test_reconciliation_failure_completes_safely(monkeypatch):
    db, router = _build(monkeypatch, credit_outcome=("ambiguous", "network_x"))
    aid = _seed_evaluated(db, overall=90)
    _call(router, "POST", "/voice-treasure/claim", payload={"attempt_id": aid}, student=_Student())
    rid = vt_reward._reward_key("stu_alice", aid)
    out = _call(router, "POST", "/admin/voice-treasure/rewards/{reward_id}/reconcile",
                reward_id=rid, payload={"outcome": "resolved_failed", "evidence": "no transfer found"},
                admin=_Admin())
    assert out["reward"]["state"] == R_FAILED


# ── First Voice Card ────────────────────────────────────────────────────────
def test_card_newly_granted_then_already_owned(monkeypatch):
    db, router = _build(monkeypatch)
    s1 = run(vt_reward._grant_first_voice_card(db, "stu_alice"))
    s2 = run(vt_reward._grant_first_voice_card(db, "stu_alice"))
    assert s1 == CARD_NEW
    assert s2 == CARD_OWNED


def test_card_storage_failure(monkeypatch):
    db, router = _build(monkeypatch)

    class Boom(_Coll):
        async def find_one(s, q, p=None): raise RuntimeError("db down")
    db._c[COLL_COLLECTION] = Boom()
    st = run(vt_reward._grant_first_voice_card(db, "stu_alice"))
    assert st == CARD_FAILED


def test_gas_ok_card_fails_then_local_retry_no_recredit(monkeypatch):
    calls = {"n": 0}
    db, router = _build(monkeypatch)

    async def cnt(clean, amount, *, nonce=None):
        calls["n"] += 1
        return {"outcome": vt_points.OUTCOME_OK, "reason": "", "nonce": nonce}
    monkeypatch.setattr(vt_points, "credit_reward", cnt)
    aid = _seed_evaluated(db, overall=90)

    # card collection raises on first grant attempt (storage outage)
    class FlakyColl(_Coll):
        fail = True
        async def find_one(s, q, p=None):
            if s.fail and q.get("_id", "").startswith("vt-card:"):
                raise RuntimeError("db down")
            return await _Coll.find_one(s, q, p)
    db._c[COLL_COLLECTION] = FlakyColl()

    r1 = _call(router, "POST", "/voice-treasure/claim", payload={"attempt_id": aid}, student=_Student())
    assert calls["n"] == 1
    assert r1["chest"]["chest_state"] != CHEST_COMPLETED  # card not settled yet
    # storage recovers; re-claim retries ONLY local fulfillment
    db._c[COLL_COLLECTION].fail = False
    r2 = _call(router, "POST", "/voice-treasure/claim", payload={"attempt_id": aid}, student=_Student())
    assert calls["n"] == 1  # GAS not called again
    assert r2["chest"]["chest_state"] == CHEST_COMPLETED


# ── collection / progress ───────────────────────────────────────────────────
def test_collection_ownership(monkeypatch):
    db, router = _build(monkeypatch)
    run(vt_reward._grant_first_voice_card(db, "stu_alice"))
    res = _call(router, "GET", "/voice-treasure/collection", student=_Student())
    assert res["first_voice_card_owned"] is True


def test_progress_calculation(monkeypatch):
    db, router = _build(monkeypatch, credit_outcome=("ok", None))
    aid = _seed_evaluated(db, overall=90)
    _call(router, "POST", "/voice-treasure/claim", payload={"attempt_id": aid}, student=_Student())
    res = _call(router, "GET", "/voice-treasure/progress", student=_Student())
    assert res["missions_completed"] == 1
    assert res["points_spent"] == 10
    assert res["points_earned"] >= 10
    assert res["first_voice_card_owned"] is True


def test_payout_caps_enforced_end_to_end(monkeypatch):
    # base 50, daily cap 100; first claim credits 50, leaving headroom 50.
    db, router = _build(monkeypatch, cfg=_cfg(base=50, daily_cap=100), credit_outcome=("ok", None))
    a1 = _seed_evaluated(db, overall=90, aid="vt-attempt:stu_alice:e1")
    _call(router, "POST", "/voice-treasure/claim", payload={"attempt_id": a1}, student=_Student())
    # second evaluated attempt same day
    db[vt_attempt.COLL_ATTEMPTS].docs["a2"] = {
        "_id": "a2", "attempt_id": "a2", "student_id": "stu_alice", "entry_id": "e2",
        "mission_date": vt_entry._today(), "state": vt_attempt.A_EVALUATED,
        "result": {"overall": 90}, "updated_at": vt_entry._today()}
    r2 = _call(router, "POST", "/voice-treasure/claim", payload={"attempt_id": "a2"}, student=_Student())
    rid2 = vt_reward._reward_key("stu_alice", "a2")
    assert db[COLL_REWARDS].docs[rid2]["decision"]["total_points"] <= 50


def test_no_fabricated_balance(monkeypatch):
    db, router = _build(monkeypatch, credit_outcome=("ok", None))
    aid = _seed_evaluated(db, overall=90)
    res = _call(router, "POST", "/voice-treasure/claim", payload={"attempt_id": aid}, student=_Student())
    assert "balance" not in res["chest"]["reward"]  # GAS gave none ⇒ none invented


def test_credentials_never_persisted_or_returned(monkeypatch):
    db, router = _build(monkeypatch, credit_outcome=("ok", None))
    aid = _seed_evaluated(db, overall=90)
    res = _call(router, "POST", "/voice-treasure/claim", payload={"attempt_id": aid}, student=_Student())
    blob = str(res) + str(db[COLL_REWARDS].docs)
    for banned in ("password", "Password", "SL_TREASURY_PASSWORD", "treasury_password"):
        assert banned not in blob


def test_master_switch_off_blocks_credit(monkeypatch):
    monkeypatch.setenv("VOICE_TREASURE_POINTS_REWARD_ENABLED", "0")
    calls = {"n": 0}
    db, router = _build(monkeypatch)

    async def cnt(clean, amount, *, nonce=None):
        calls["n"] += 1
        return {"outcome": vt_points.OUTCOME_OK, "reason": "", "nonce": nonce}
    monkeypatch.setattr(vt_points, "credit_reward", cnt)
    aid = _seed_evaluated(db, overall=90)
    _call(router, "POST", "/voice-treasure/claim", payload={"attempt_id": aid}, student=_Student())
    assert calls["n"] == 0  # master ceiling blocks GAS credit


# ── final-pass additions: cap concurrency, balance contract ─────────────────
def test_concurrent_claims_cannot_exceed_daily_cap(monkeypatch):
    # base 60, daily cap 100. Two different evaluated attempts claimed "together":
    # only one full 60 fits; the second must be clamped to <=40 headroom or settle
    # without exceeding the cap. Total credited must be <= 100.
    db, router = _build(monkeypatch, cfg=_cfg(base=60, daily_cap=100), credit_outcome=("ok", None))
    credited = {"sum": 0}

    async def credit(clean, amount, *, nonce=None):
        credited["sum"] += int(amount)
        return {"outcome": vt_points.OUTCOME_OK, "reason": "", "nonce": nonce}
    monkeypatch.setattr(vt_points, "credit_reward", credit)

    a1 = _seed_evaluated(db, overall=90, aid="vt-attempt:stu_alice:e1")
    db[vt_attempt.COLL_ATTEMPTS].docs["a2"] = {
        "_id": "a2", "attempt_id": "a2", "student_id": "stu_alice", "entry_id": "e2",
        "mission_date": vt_entry._today(), "state": vt_attempt.A_EVALUATED,
        "result": {"overall": 90}, "updated_at": vt_entry._today()}
    _call(router, "POST", "/voice-treasure/claim", payload={"attempt_id": a1}, student=_Student())
    _call(router, "POST", "/voice-treasure/claim", payload={"attempt_id": "a2"}, student=_Student())
    assert credited["sum"] <= 100  # cap never exceeded


def test_completed_reward_has_explicit_balance_status(monkeypatch):
    db, router = _build(monkeypatch, credit_outcome=("ok", None))
    aid = _seed_evaluated(db, overall=90)
    res = _call(router, "POST", "/voice-treasure/claim", payload={"attempt_id": aid}, student=_Student())
    r = res["chest"]["reward"]
    # GAS returns no trusted balance ⇒ explicit refresh_required + new_balance None
    assert r["balance_status"] == "refresh_required"
    assert r["new_balance"] is None
    assert "balance" not in r


def test_rejected_release_frees_headroom_for_retry(monkeypatch):
    # base 60 daily cap 100; first claim rejected (no transfer) must release the
    # reservation so a later successful claim still has full headroom.
    db, router = _build(monkeypatch, cfg=_cfg(base=60, daily_cap=100), credit_outcome=("rejected", "rejected_x"))
    aid = _seed_evaluated(db, overall=90)
    r1 = _call(router, "POST", "/voice-treasure/claim", payload={"attempt_id": aid}, student=_Student())
    assert r1["chest"]["chest_state"] == CHEST_FAILED
    # ledger should be back to 0 reserved
    lid = vt_reward._ledger_id("stu_alice", "daily", __import__("datetime").datetime.now(__import__("datetime").timezone.utc).date().isoformat())
    led = db[vt_reward.COLL_PAYOUT_LEDGER].docs.get(lid)
    assert (led or {}).get("reserved", 0) == 0


# ── final pass: cap-reservation release on reconciliation ───────────────────
def _seed_ambiguous_reward(monkeypatch, base=40, daily_cap=100, db=None):
    """Drive a claim to AMBIGUOUS so a reservation is held, return (router, rid)."""
    db2, router = _build(monkeypatch, cfg=_cfg(base=base, daily_cap=daily_cap),
                         credit_outcome=("ambiguous", "network_x"))
    # copy seeded docs into db2 path is not needed; _build made its own db
    aid = _seed_evaluated(db2, overall=90)
    _call(router, "POST", "/voice-treasure/claim", payload={"attempt_id": aid}, student=_Student())
    rid = vt_reward._reward_key("stu_alice", aid)
    return db2, router, rid


def _daily_ledger(db, sid="stu_alice"):
    import datetime
    today = datetime.datetime.now(datetime.timezone.utc).date().isoformat()
    lid = vt_reward._ledger_id(sid, "daily", today)
    return db[vt_reward.COLL_PAYOUT_LEDGER].docs.get(lid, {})


def test_resolved_failed_releases_reservation_once(monkeypatch):
    db, router, rid = _seed_ambiguous_reward(monkeypatch)
    held = db[COLL_REWARDS].docs[rid]["decision"]["total_points"]
    assert _daily_ledger(db).get("reserved", 0) == held and held > 0  # held while ambiguous
    out = _call(router, "POST", "/admin/voice-treasure/rewards/{reward_id}/reconcile",
                reward_id=rid, payload={"outcome": "resolved_failed", "evidence": "no transfer"},
                admin=_Admin())
    assert out["reward"]["state"] == R_FAILED
    assert _daily_ledger(db).get("reserved", 0) == 0   # released exactly once


def test_resolved_success_keeps_reservation_consumed(monkeypatch):
    db, router, rid = _seed_ambiguous_reward(monkeypatch)
    held = db[COLL_REWARDS].docs[rid]["decision"]["total_points"]
    _call(router, "POST", "/admin/voice-treasure/rewards/{reward_id}/reconcile",
          reward_id=rid, payload={"outcome": "resolved_success", "evidence": "gas log ok"},
          admin=_Admin())
    assert _daily_ledger(db).get("reserved", 0) == held  # remains consumed


def test_duplicate_failed_resolution_does_not_release_twice(monkeypatch):
    db, router, rid = _seed_ambiguous_reward(monkeypatch)
    _call(router, "POST", "/admin/voice-treasure/rewards/{reward_id}/reconcile",
          reward_id=rid, payload={"outcome": "resolved_failed", "evidence": "no transfer"},
          admin=_Admin())
    # second (duplicate) resolution: not in reconciliation anymore → 409, no double release
    try:
        _call(router, "POST", "/admin/voice-treasure/rewards/{reward_id}/reconcile",
              reward_id=rid, payload={"outcome": "resolved_failed", "evidence": "again"},
              admin=_Admin())
    except Exception as e:
        assert getattr(e, "status_code", None) == 409
    assert _daily_ledger(db).get("reserved", 0) == 0   # still 0, not negative


def test_reserved_never_negative_after_release(monkeypatch):
    db, router, rid = _seed_ambiguous_reward(monkeypatch)
    _call(router, "POST", "/admin/voice-treasure/rewards/{reward_id}/reconcile",
          reward_id=rid, payload={"outcome": "resolved_failed", "evidence": "x"}, admin=_Admin())
    assert _daily_ledger(db).get("reserved", 0) >= 0


# ── Voucher / EduTalk Pass reward integration ───────────────────────────────
def _cfg_grants(voucher=True, vpass=True, vmin=70, pmin=70):
    c = _cfg(points=False, card=False)
    c["rewards"]["voucher_reward_enabled"] = voucher
    c["rewards"]["voucher_minimum_score"] = vmin
    c["rewards"]["voucher_source"] = "existing"
    c["rewards"]["voucher_existing_code"] = "VTBOOK10"
    c["rewards"]["edutalk_pass_reward_enabled"] = vpass
    c["rewards"]["edutalk_pass_minimum_score"] = pmin
    c["rewards"]["edutalk_pass_feature"] = "edutalk_session"
    return c


def _mk_grantors(counter):
    async def voucher(*, student_clean_id, attempt_id, policy):
        counter["voucher"] += 1
        return {"id": "sv_x", "coupon_code": "VTBOOK10"}

    async def epass(*, student_clean_id, attempt_id, policy):
        counter["pass"] += 1
        return {"id": "ent_x", "feature": policy.get("edutalk_pass_feature")}

    return {"voucher": voucher, "edutalk_pass": epass}


def _build_grants(monkeypatch, cfg, counter):
    db = _DB(); router = _Router()
    register_voice_treasure_reward_routes(
        router, db, require_admin=_Admin(), require_student=object(),
        grantors=_mk_grantors(counter))
    monkeypatch.setattr(vt_cfg, "load_config", lambda _db: _aval(copy.deepcopy(cfg)))
    return db, router


def test_decision_includes_voucher_and_pass_eligibility():
    cfg = _cfg_grants()
    d = compute_reward_decision(cfg=cfg, attempt_result={"overall": 80},
                                current_streak=1, paid_today_points=0, paid_week_points=0)
    assert d["voucher_eligible"] is True
    assert d["pass_eligible"] is True
    assert d["eligible"] is True
    below = compute_reward_decision(cfg=cfg, attempt_result={"overall": 50},
                                    current_streak=1, paid_today_points=0, paid_week_points=0)
    assert below["voucher_eligible"] is False
    assert below["pass_eligible"] is False
    assert below["eligible"] is False


def test_claim_grants_voucher_and_pass_exactly_once(monkeypatch):
    monkeypatch.setenv("VOICE_TREASURE_VOUCHER_REWARD_ENABLED", "1")
    monkeypatch.setenv("VOICE_TREASURE_EDUTALK_PASS_REWARD_ENABLED", "1")
    counter = {"voucher": 0, "pass": 0}
    db, router = _build_grants(monkeypatch, _cfg_grants(), counter)
    aid = "vt-attempt:stu_alice:e1"
    _seed_evaluated(db, overall=85, aid=aid)
    r1 = _call(router, "POST", "/voice-treasure/claim",
               payload={"attempt_id": aid}, student=_Student())
    assert r1["chest"]["chest_state"] == CHEST_COMPLETED
    rw = r1["chest"]["reward"]
    assert rw["voucher"] == "granted"
    assert rw["edutalk_pass"] == "granted"
    assert rw["edutalk_pass_feature"] == "edutalk_session"
    assert counter == {"voucher": 1, "pass": 1}
    # Re-claim must NOT re-grant (settled short-circuit + atomic pass guard).
    r2 = _call(router, "POST", "/voice-treasure/claim",
               payload={"attempt_id": aid}, student=_Student())
    assert r2["chest"]["chest_state"] == CHEST_COMPLETED
    assert counter == {"voucher": 1, "pass": 1}


def test_master_off_skips_grant_but_completes_chest(monkeypatch):
    # Voucher/pass env masters are unset ⇒ OFF ⇒ kill-switch: no grant issued,
    # but the chest still completes (never stuck on a withdrawn reward).
    counter = {"voucher": 0, "pass": 0}
    db, router = _build_grants(monkeypatch, _cfg_grants(), counter)
    aid = "vt-attempt:stu_alice:e1"
    _seed_evaluated(db, overall=85, aid=aid)
    r1 = _call(router, "POST", "/voice-treasure/claim",
               payload={"attempt_id": aid}, student=_Student())
    assert r1["chest"]["chest_state"] == CHEST_COMPLETED
    assert counter == {"voucher": 0, "pass": 0}
    assert r1["chest"]["reward"]["voucher"] == "skipped"
    assert r1["chest"]["reward"]["edutalk_pass"] == "skipped"
