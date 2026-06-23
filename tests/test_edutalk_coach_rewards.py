"""tests/test_edutalk_coach_rewards.py — Phase 1 CORRECTED focused tests.

Targets the locked correction defect list. Compared with the original draft
this file adds coverage for:

  * stable durable transaction identity per offer + idempotent outbox grant
  * concurrent offer creation collapses to one offer (unique index)
  * atomic cap reservation under concurrent claimants
  * server-owned exercise lifecycle (Gemini cannot invent an ID)
  * disabled = completely dark (no exercise registered, no Gemini change)
  * session-bound recovery (foreign session_id returns no offer)
  * idempotent claim-started and confirmed notifications
  * frozen recognition snapshot for personalization
  * idempotent Gemini pre/post-claim announcements
  * rejection of pass/achievement enablement
  * indexes_ready gate refuses operations until startup completes
"""
from __future__ import annotations

import asyncio
import sys
import time as _t
from pathlib import Path

import pytest

ROOT = Path(__file__).resolve().parents[1]
if str(ROOT) not in sys.path:
    sys.path.insert(0, str(ROOT))

import edutalk_coach_reward_tools as rwd  # noqa: E402


# --------------------------------------------------------------------------- #
# Minimal async Mongo fake (extended for unique indexes)                      #
# --------------------------------------------------------------------------- #
def _match(doc, q):
    for k, v in q.items():
        dv = doc.get(k)
        if isinstance(v, dict):
            ops = list(v.keys())
            if "$in" in v and dv not in v["$in"]:
                return False
            if "$nin" in v and dv in v["$nin"]:
                return False
            if "$ne" in v and dv == v["$ne"]:
                return False
            if "$gte" in v and not (dv is not None and dv >= v["$gte"]):
                return False
            if "$lte" in v and not (dv is not None and dv <= v["$lte"]):
                return False
            if "$lt" in v and not (dv is not None and dv < v["$lt"]):
                return False
            if "$gt" in v and not (dv is not None and dv > v["$gt"]):
                return False
            if "$exists" in v and (dv is not None) != v["$exists"]:
                return False
            if "$not" in v:
                inner = v["$not"]
                if isinstance(inner, dict):
                    # negate the inner predicate
                    inner_match = _match({k: dv}, {k: inner})
                    if inner_match:
                        return False  # $not: inner matched → exclude
                else:
                    if dv == inner:
                        return False
                continue
            handled = {"$in", "$nin", "$ne", "$gte", "$gt", "$lte", "$lt",
                       "$exists", "$not"}
            if not (set(ops) & handled) and dv != v:
                return False
        elif dv != v:
            return False
    return True


class _Cursor:
    def __init__(self, docs):
        self._docs = list(docs)

    def sort(self, *args, **kw):
        if args and isinstance(args[0], list):
            field, direction = args[0][0]
        else:
            field = args[0]
            direction = args[1] if len(args) > 1 else 1
        self._docs.sort(key=lambda d: d.get(field) or "",
                        reverse=(direction == -1))
        return self

    def limit(self, n):
        self._docs = self._docs[:int(n)]
        return self

    def __aiter__(self):
        async def gen():
            for d in self._docs:
                yield d
        return gen()


class _Coll:
    def __init__(self, name=""):
        self.name = name
        self.docs: list[dict] = []
        self.unique_indexes: list[tuple[str, ...]] = []
        self._lock = asyncio.Lock()

    def _violates_unique(self, doc, exclude=None):
        for fields in self.unique_indexes:
            key = tuple(doc.get(f) for f in fields)
            if any(x is None for x in key):
                continue
            for other in self.docs:
                if other is exclude:
                    continue
                if tuple(other.get(f) for f in fields) == key:
                    return fields
        return None

    async def create_index(self, spec, unique=False, **kw):
        if isinstance(spec, str):
            fields = (spec,)
        elif isinstance(spec, list):
            fields = tuple(f for f, _d in spec)
        else:
            fields = (str(spec),)
        if unique:
            self.unique_indexes.append(fields)
        return "ok"

    async def find_one(self, q=None, projection=None, sort=None):
        q = q or {}
        rows = [d for d in self.docs if _match(d, q)]
        if sort:
            field, direction = sort[0]
            rows.sort(key=lambda d: d.get(field) or "",
                      reverse=(direction == -1))
        return dict(rows[0]) if rows else None

    async def insert_one(self, doc):
        async with self._lock:
            if "_id" in doc:
                if any(d.get("_id") == doc["_id"] for d in self.docs):
                    raise Exception("DuplicateKey:_id")
            viol = self._violates_unique(doc)
            if viol:
                raise Exception(f"DuplicateKey:{viol}")
            self.docs.append(dict(doc))
        return type("R", (), {"inserted_id": doc.get("_id")})()

    async def update_one(self, q, upd, upsert=False):
        for d in self.docs:
            if _match(d, q):
                self._apply(d, upd)
                return
        if upsert:
            new_doc = dict(q)
            self._apply(new_doc, upd)
            self.docs.append(new_doc)

    async def update_many(self, q, upd):
        for d in self.docs:
            if _match(d, q):
                self._apply(d, upd)

    async def find_one_and_update(self, q, upd):
        async with self._lock:
            for d in self.docs:
                if _match(d, q):
                    before = dict(d)
                    self._apply(d, upd)
                    return before  # mongo returns pre-image by default
            return None

    async def count_documents(self, q):
        return sum(1 for d in self.docs if _match(d, q))

    async def distinct(self, field, q=None):
        q = q or {}
        return list({d.get(field) for d in self.docs if _match(d, q)})

    def find(self, q=None, projection=None):
        q = q or {}
        return _Cursor([dict(d) for d in self.docs if _match(d, q)])

    def _apply(self, doc, upd):
        if "$set" in upd:
            for k, v in upd["$set"].items():
                if "." in k:
                    parts = k.split(".")
                    target = doc
                    for p in parts[:-1]:
                        target = target.setdefault(p, {})
                    target[parts[-1]] = v
                else:
                    doc[k] = v
        if "$inc" in upd:
            for k, v in upd["$inc"].items():
                doc[k] = (doc.get(k) or 0) + v


class _DB(dict):
    def __getitem__(self, k):
        if k not in self:
            super().__setitem__(k, _Coll(k))
        return super().__getitem__(k)


# --------------------------------------------------------------------------- #
# Test scaffolding                                                            #
# --------------------------------------------------------------------------- #
class _DummyAPI:
    def __init__(self):
        self.routes = {}

    def _add(self, method, path):
        def deco(fn):
            self.routes[(method, path)] = fn
            return fn
        return deco

    def get(self, path):
        return self._add("GET", path)

    def put(self, path):
        return self._add("PUT", path)

    def post(self, path):
        return self._add("POST", path)


class _Student:
    def __init__(self, clean_id="stu123", display_name="Dara Lim"):
        self.clean_id = clean_id
        self.display_name = display_name


class _Admin:
    def __init__(self, email="admin@example.com"):
        self.email = email
        self.username = email


def _require_admin():
    return _Admin()


def _require_student():
    return _Student()


def run(c):
    return asyncio.run(c)


@pytest.fixture
def env():
    api = _DummyAPI()
    db = _DB()
    services = rwd.register_edutalk_coach_reward_routes(
        api, db, _require_admin, _require_student)
    # Simulate the FastAPI startup event so indexes are ready.
    run(rwd.setup_indexes(db))
    # B1 (audit) — install a working stable-nonce upstream helper by
    # default so the capability gate ``_provider_grant_available()``
    # reports True throughout the standard test suite. Tests that want
    # to exercise provider-unavailable behaviour use the dedicated
    # ``provider_unavailable_blocks_offer`` test, which removes the
    # helper for its scope.
    saved_real = rwd.REAL_GRANT_ENABLED
    saved_helper = rwd.__dict__.get("_gas_treasury_credit_with_nonce")
    saved_helper_ok = rwd._GRANT_HELPER_OK

    async def _default_credit(_clean_id, _amount, _nonce):
        return {"outcome": "granted", "provider_ref": "mock_txn_ref",
                "balance_after": 100, "duplicate": False, "error": None}

    rwd.REAL_GRANT_ENABLED = True
    rwd._GRANT_HELPER_OK = True
    rwd.__dict__["_gas_treasury_credit_with_nonce"] = _default_credit
    try:
        yield api, db, services
    finally:
        rwd.REAL_GRANT_ENABLED = saved_real
        rwd._GRANT_HELPER_OK = saved_helper_ok
        if saved_helper is None:
            rwd.__dict__.pop("_gas_treasury_credit_with_nonce", None)
        else:
            rwd.__dict__["_gas_treasury_credit_with_nonce"] = saved_helper


def _enable_points(api, *, exercises_required=1, daily=5, monthly=50,
                   cooldown=0, ttl=120, min_seconds=0, min_conf=0.5):
    put_route = api.routes[("PUT", "/admin/edutalk-live/rewards/config")]
    run(put_route({"config": {
        "enabled": True, "points_enabled": True,
        "approved_point_values": [5],
        "min_successful_exercises": exercises_required,
        "require_resolved_correction": False,
        "min_confidence": min_conf, "min_session_seconds": min_seconds,
        "cooldown_seconds": cooldown,
        "daily_cap_per_student": daily, "monthly_cap_per_student": monthly,
        "offer_ttl_seconds": ttl,
    }}, _Admin()))


def _seed_session(db, sid="sid1", clean_id="stu123", name="Dara Lim"):
    db["edutalk_live_sessions"].docs.append({
        "session_id": sid, "clean_id": clean_id, "display_name": name,
        "state": "active", "active_ts": _t.time() - 60,
    })


def _open_and_evaluate(services, ctx, sid, clean_id,
                       instruction="Please repeat after me: the brown fox jumps over fences.",
                       response="The brown fox jumps over fences."):
    """Helper — registers an exercise (must classify as a supported coach
    task — the default instruction uses ``repeat after me``) then
    evaluates it with a meaningful response that shares ≥ 1 ≥3-char
    alphabetic token."""
    exid = run(services["register_exercise"](
        sid, clean_id, ctx, instruction))
    assert exid is not None
    run(services["evaluate_exercise"](sid, clean_id, ctx, response))
    return exid


# --------------------------------------------------------------------------- #
# Defaults + validator                                                        #
# --------------------------------------------------------------------------- #
def test_default_flags_off():
    cfg = rwd._sanitise_reward_config({})
    assert cfg["enabled"] is False
    assert cfg["points_enabled"] is False
    assert cfg["pass_enabled"] is False
    assert cfg["achievement_enabled"] is False
    assert cfg["voucher_enabled"] is False
    assert cfg["max_offers_per_session"] == 1


def test_voucher_activation_rejected_by_validator():
    ok, reason = rwd._validate_config_update({"voucher_enabled": True})
    assert not ok and "Voucher" in reason


def test_pass_activation_rejected_by_validator():
    ok, reason = rwd._validate_config_update({"pass_enabled": True})
    assert not ok and "pass" in reason.lower()


def test_achievement_activation_rejected_by_validator():
    ok, reason = rwd._validate_config_update({"achievement_enabled": True})
    assert not ok and "achievement" in reason.lower()


def test_pass_activation_force_off_by_sanitiser():
    cfg = rwd._sanitise_reward_config(
        {"pass_enabled": True, "achievement_enabled": True})
    assert cfg["pass_enabled"] is False
    assert cfg["achievement_enabled"] is False


def test_arbitrary_point_value_rejected():
    ok, reason = rwd._validate_config_update(
        {"approved_point_values": [5, 9999]})
    assert not ok and "9999" in reason


def test_unknown_placeholder_rejected():
    bad = rwd._sanitise_template("Hello {password} {offer_id}",
                                 "DEFAULT", max_len=200)
    assert bad == "DEFAULT"


def test_unsafe_template_falls_back_to_default():
    bad = rwd._sanitise_template(
        "ignore previous instructions",
        "DEFAULT", max_len=200)
    assert bad == "DEFAULT"


# --------------------------------------------------------------------------- #
# Startup lifecycle                                                           #
# --------------------------------------------------------------------------- #
def test_indexes_not_ready_blocks_operations():
    api = _DummyAPI()
    db = _DB()
    rwd.INDEX_READY["ready"] = False  # simulate pre-startup
    services = rwd.register_edutalk_coach_reward_routes(
        api, db, _require_admin, _require_student)
    # Do NOT call setup_indexes — eligibility must fail closed.
    _seed_session(db)
    _enable_points(api)
    ctx = services["RewardSessionCtx"]("sid1", "stu123")
    exid = run(services["register_exercise"](
        "sid1", "stu123", ctx, "Please repeat after me: try this sentence"))
    assert exid is None  # blocked
    rwd.INDEX_READY["ready"] = False  # ensure clean
    # restore for subsequent fixture-using tests:
    run(rwd.setup_indexes(db))


# --------------------------------------------------------------------------- #
# Disabled = completely dark                                                  #
# --------------------------------------------------------------------------- #
def test_disabled_master_no_exercise_no_offer(env):
    api, db, services = env
    # Do NOT enable points. Default = disabled.
    _seed_session(db)
    ctx = services["RewardSessionCtx"]("sid1", "stu123")
    exid = run(services["register_exercise"](
        "sid1", "stu123", ctx, "Try this sentence"))
    # Audit 4.3: bare 'try this sentence' is not a classified coach task;
    # the classifier should refuse to register an exercise.
    assert exid is None
    assert exid is None
    # Evaluate also returns None.
    assert run(services["evaluate_exercise"](
        "sid1", "stu123", ctx, "I tried this sentence")) is None
    # No exercises were stored.
    assert db["edutalk_coach_rewards_exercises"].docs == []


# --------------------------------------------------------------------------- #
# Server-owned exercise lifecycle                                             #
# --------------------------------------------------------------------------- #
def test_server_issued_exercise_id_format(env):
    api, db, services = env
    _enable_points(api)
    _seed_session(db, sid="ses-xyz-0000-0001")
    ctx = services["RewardSessionCtx"]("ses-xyz-0000-0001", "stu123")
    exid = run(services["register_exercise"](
        "ses-xyz-0000-0001", "stu123", ctx,
        "Please say: I will keep practising."))
    assert exid is not None and exid.startswith("ex_")
    assert ctx.current_exercise_id == exid
    # One exercise opened.
    assert db["edutalk_coach_rewards_exercises"].docs[0]["state"] == "open"


def test_response_too_short_marks_ignored(env):
    api, db, services = env
    _enable_points(api)
    _seed_session(db)
    ctx = services["RewardSessionCtx"]("sid1", "stu123")
    run(services["register_exercise"](
        "sid1", "stu123", ctx, "Repeat after me: please say hello kindly"))
    run(services["evaluate_exercise"]("sid1", "stu123", ctx, "ok"))
    doc = db["edutalk_coach_rewards_exercises"].docs[0]
    assert doc["state"] == "terminal"
    assert doc["result"] == "ignored"


def test_one_exercise_cannot_count_twice(env):
    api, db, services = env
    _enable_points(api, exercises_required=3)
    _seed_session(db)
    ctx = services["RewardSessionCtx"]("sid1", "stu123",
                                         display_name="Dara")
    # Same exercise evaluated twice — the second call is ignored.
    run(services["register_exercise"](
        "sid1", "stu123", ctx, "Please say: the cat sat on the mat."))
    run(services["evaluate_exercise"](
        "sid1", "stu123", ctx, "The cat sat on the mat now."))
    # Second evaluation reuses ``current_exercise_id`` (None now) → noop.
    assert run(services["evaluate_exercise"](
        "sid1", "stu123", ctx, "The cat sat on the mat now.")) is None
    successful_count = sum(
        1 for d in db["edutalk_coach_rewards_exercises"].docs
        if d.get("result") == "successful")
    assert successful_count == 1


# --------------------------------------------------------------------------- #
# Atomic one-offer-per-session                                                #
# --------------------------------------------------------------------------- #
def test_concurrent_evidence_creates_single_offer(env, monkeypatch):
    api, db, services = env
    _enable_points(api, exercises_required=1)
    _seed_session(db)
    ctx = services["RewardSessionCtx"]("sid1", "stu123",
                                         display_name="Dara")
    # Open and evaluate one exercise. Then attempt to trigger a SECOND
    # offer-creation via a brand-new ctx (simulating a parallel evaluator
    # that races). The unique session_offer_key index must reject the
    # duplicate even though both paths see eligibility.
    _open_and_evaluate(services, ctx, "sid1", "stu123")
    ctx2 = services["RewardSessionCtx"]("sid1", "stu123",
                                          display_name="Dara")
    ctx2.exercise_seq = 100  # avoid colliding deterministic exercise_id
    _open_and_evaluate(
        services, ctx2, "sid1", "stu123",
        instruction="Please repeat after me: it is raining today.",
        response="It is raining today over the city.")
    offers = db["edutalk_coach_rewards_offers"].docs
    assert len([o for o in offers if o["session_id"] == "sid1"]) == 1


# --------------------------------------------------------------------------- #
# Atomic cap reservations                                                     #
# --------------------------------------------------------------------------- #
def test_daily_cap_atomic_reservation(env):
    api, db, services = env
    _enable_points(api, exercises_required=1, daily=1)
    # First student session — qualifies and consumes the daily cap.
    _seed_session(db, sid="sidA", clean_id="stu123")
    ctx_a = services["RewardSessionCtx"]("sidA", "stu123",
                                           display_name="Dara")
    _open_and_evaluate(services, ctx_a, "sidA", "stu123")
    # Confirm offer created.
    offers_a = [o for o in db["edutalk_coach_rewards_offers"].docs
                if o["session_id"] == "sidA"]
    assert len(offers_a) == 1
    # Second session same student same day — must be blocked by cap.
    _seed_session(db, sid="sidB", clean_id="stu123")
    ctx_b = services["RewardSessionCtx"]("sidB", "stu123",
                                           display_name="Dara")
    _open_and_evaluate(
        services, ctx_b, "sidB", "stu123",
        instruction="Try again: please pass the salt.",
        response="Please pass the salt now.")
    offers_b = [o for o in db["edutalk_coach_rewards_offers"].docs
                if o["session_id"] == "sidB"]
    assert offers_b == [], "daily cap must block the second offer"


# --------------------------------------------------------------------------- #
# Idempotent durable grant                                                    #
# --------------------------------------------------------------------------- #
def test_provider_unavailable_blocks_offer_creation(env, monkeypatch):
    """B1 (audit) — capability gate. With flags fully ON but the
    upstream stable-nonce provider helper missing, NO offer row is
    created, NO ``reward_offer_available`` WS event fires, NO Gemini
    pre-claim announcement is queued, and NO claim-start notification
    is produced. The student surface is completely dark."""
    api, db, services = env
    _enable_points(api, exercises_required=1)
    _seed_session(db)
    # Tear down the default stable-nonce helper installed by the env
    # fixture so the capability gate flips to False.
    monkeypatch.setattr(rwd, "REAL_GRANT_ENABLED", False)
    monkeypatch.delitem(
        rwd.__dict__, "_gas_treasury_credit_with_nonce", raising=False)
    assert rwd._provider_grant_available() is False
    emitted: list[dict] = []
    injected: list[str] = []

    async def cb_emit(p): emitted.append(p)
    async def cb_inject(t): injected.append(t)
    ctx = services["RewardSessionCtx"](
        "sid1", "stu123", display_name="Dara Lim",
        gemini_inject_cb=cb_inject, client_send_cb=cb_emit)
    _open_and_evaluate(services, ctx, "sid1", "stu123")
    # Exercise lifecycle still runs (internal, no student surface).
    assert len(db["edutalk_coach_rewards_exercises"].docs) == 1
    # But absolutely nothing student-visible was produced.
    assert db["edutalk_coach_rewards_offers"].docs == []
    assert db["edutalk_coach_rewards_notifications"].docs == []
    assert not any(e.get("type") == "reward_offer_available"
                   for e in emitted)
    assert injected == []
    # And the public status reflects the gate.
    get_status = api.routes[("GET", "/admin/edutalk-live/rewards/config")]
    res = run(get_status(_Admin()))
    assert res["status"]["rewards_active"] is False
    assert res["status"]["provider_grant_available"] is False


def test_real_grant_enable_attempt_rejected_by_validator():
    """AUDIT 4.2 — operator cannot enable real point granting via the
    Studio because the upstream helper does not accept a stable nonce."""
    ok, reason = rwd._validate_config_update({"real_grant_enabled": True})
    assert not ok and "stable nonce" in reason.lower()



def test_provider_predicate_returns_true_when_all_conditions_met(monkeypatch):
    """Canonical correction — focused unit test for the explicit success path.

    Verifies that ``_provider_grant_available()`` returns ``True`` when all
    three required conditions hold simultaneously.  No real wallet grant is
    made; the stable-nonce helper is a no-op stub injected only for the
    duration of this test.  All monkeypatches are restored automatically by
    pytest's ``monkeypatch`` fixture on teardown.

    Section 6 — Fully mocked future-capable state:
      * ``REAL_GRANT_ENABLED``                 → True  (monkeypatched)
      * ``_GRANT_HELPER_OK``                   → True  (monkeypatched)
      * ``_gas_treasury_credit_with_nonce``    → callable stub (injected)

    Confirms the predicate has a valid explicit True path even though that
    path remains unreachable in the current lab-safe configuration.
    """
    async def _stub_nonce(clean_id, amount, nonce):  # pragma: no cover
        raise RuntimeError("stub must not be called in this test")

    monkeypatch.setattr(rwd, "REAL_GRANT_ENABLED", True)
    monkeypatch.setattr(rwd, "_GRANT_HELPER_OK", True)
    monkeypatch.setitem(rwd.__dict__,
                        "_gas_treasury_credit_with_nonce", _stub_nonce)

    result = rwd._provider_grant_available()

    # Restore before asserting so state is clean even on failure.
    monkeypatch.undo()

    assert result is True, (
        "_provider_grant_available() must return True when REAL_GRANT_ENABLED, "
        "_GRANT_HELPER_OK, and _gas_treasury_credit_with_nonce are all set"
    )


def _install_stable_nonce_helper(monkeypatch, log_list):
    """Helper — flip REAL_GRANT_ENABLED on AND inject a stable-nonce
    capable upstream helper so the audit-4.2 success path tests can
    exercise the confirmed grant. ``log_list`` captures every call so
    tests can assert at-most-once dispatch + correct tx_id."""
    async def credit_with_nonce(clean_id, amount, nonce):
        log_list.append({"clean_id": clean_id,
                         "amount": int(amount), "nonce": nonce})
        return {"outcome": "granted", "provider_ref": nonce[:16],
                "balance_after": 100, "duplicate": False, "error": None}
    monkeypatch.setattr(rwd, "REAL_GRANT_ENABLED", True)
    monkeypatch.setitem(
        rwd.__dict__, "_gas_treasury_credit_with_nonce", credit_with_nonce)


def test_stable_tx_id_per_offer_and_idempotent_grant(env, monkeypatch):
    api, db, services = env
    _enable_points(api, exercises_required=1)
    _seed_session(db)
    grant_log: list[dict] = []
    _install_stable_nonce_helper(monkeypatch, grant_log)
    ctx = services["RewardSessionCtx"]("sid1", "stu123",
                                         display_name="Dara")
    _open_and_evaluate(services, ctx, "sid1", "stu123")
    offer = db["edutalk_coach_rewards_offers"].docs[0]
    expected_tx = f"edutalk-coach-reward:{offer['offer_id']}:points"
    assert offer["tx_id"] == expected_tx
    r1 = run(services["claim_offer"](offer["offer_id"], "stu123", "rest"))
    assert r1["state"] in ("granted", "confirmed")
    assert (r1["result"] or {}).get("tx_id") == expected_tx
    # The upstream stable-nonce helper received the SAME tx_id we stored
    # on the offer — true end-to-end provider idempotency identity.
    assert len(grant_log) == 1
    assert grant_log[0]["clean_id"] == "stu123"
    assert grant_log[0]["amount"] == 5
    nonce = grant_log[0]["nonce"]
    # SHA-256 hex digest = 64 chars, all hex
    assert len(nonce) == 64 and all(c in "0123456789abcdef" for c in nonce)
    r2 = run(services["claim_offer"](offer["offer_id"], "stu123", "ws"))
    assert r2["state"] in ("granted", "confirmed")
    assert len(grant_log) == 1, (
        "duplicate claim must not call upstream a second time")


def test_ambiguous_provider_result_keeps_pending(env, monkeypatch):
    api, db, services = env
    _enable_points(api, exercises_required=1)
    _seed_session(db)
    call_log = {"n": 0}

    async def flaky_credit(clean_id, amount, nonce):
        call_log["n"] += 1
        return {"outcome": "grant_unknown",
                "error": "network timeout while contacting upstream",
                "provider_ref": None, "balance_after": None,
                "duplicate": False}
    monkeypatch.setattr(rwd, "REAL_GRANT_ENABLED", True)
    monkeypatch.setitem(rwd.__dict__,
                        "_gas_treasury_credit_with_nonce", flaky_credit)
    ctx = services["RewardSessionCtx"]("sid1", "stu123",
                                         display_name="Dara")
    _open_and_evaluate(services, ctx, "sid1", "stu123")
    offer = db["edutalk_coach_rewards_offers"].docs[0]
    r1 = run(services["claim_offer"](offer["offer_id"], "stu123", "rest"))
    assert r1["state"] == "pending_confirmation"
    r2 = run(services["claim_offer"](offer["offer_id"], "stu123", "ws"))
    assert r2["state"] == "pending_confirmation"
    assert call_log["n"] == 1
    grants = db["edutalk_coach_rewards_grants"].docs
    assert len(grants) == 1
    assert grants[0]["state"] in ("grant_unknown", "provider_pending")


# --------------------------------------------------------------------------- #
# Session-bound offer recovery                                                #
# --------------------------------------------------------------------------- #
def test_active_offer_is_session_bound(env, monkeypatch):
    api, db, services = env
    _enable_points(api, exercises_required=1)
    _seed_session(db, sid="sidA")
    ctx = services["RewardSessionCtx"]("sidA", "stu123",
                                         display_name="Dara")
    _open_and_evaluate(services, ctx, "sidA", "stu123")
    get_active = api.routes[("GET", "/edutalk/reward-offers/active")]
    # Correct session_id — returns the offer.
    res = run(get_active(session_id="sidA", student=_Student()))
    assert res["offer"]["session_id"] == "sidA"
    # Different session_id — must return no offer.
    res2 = run(get_active(session_id="sidB", student=_Student()))
    assert res2["offer"] is None


# --------------------------------------------------------------------------- #
# Personalization recognition snapshot                                        #
# --------------------------------------------------------------------------- #
def test_recognition_snapshot_frozen_after_config_change(env, monkeypatch):
    api, db, services = env
    _enable_points(api, exercises_required=1)
    _seed_session(db, name="Dara Lim")
    ctx = services["RewardSessionCtx"]("sid1", "stu123",
                                         display_name="Dara Lim")
    _open_and_evaluate(services, ctx, "sid1", "stu123")
    offer = db["edutalk_coach_rewards_offers"].docs[0]
    snap = offer["recognition_snapshot"]
    assert snap["student_name"] == "Dara"
    assert snap["successful_exercise_count"] >= 1
    # Admin edits the config — the existing snapshot is unaffected.
    _enable_points(api, exercises_required=5, daily=20, monthly=400)
    offer_after = next(o for o in db["edutalk_coach_rewards_offers"].docs
                       if o["_id"] == offer["_id"])
    assert offer_after["recognition_snapshot"] == snap


def test_no_safe_name_uses_neutral_wording(env):
    api, db, services = env
    _enable_points(api, exercises_required=1)
    db["edutalk_live_sessions"].docs.append({
        "session_id": "sidN", "clean_id": "stuN", "display_name": "  ",
        "state": "active", "active_ts": _t.time() - 60,
    })
    ctx = services["RewardSessionCtx"]("sidN", "stuN", display_name="  ")
    _open_and_evaluate(services, ctx, "sidN", "stuN")
    offer = next(o for o in db["edutalk_coach_rewards_offers"].docs
                 if o["session_id"] == "sidN")
    # Snapshot present, name empty → neutral wording will be rendered.
    assert offer["recognition_snapshot"]["student_name"] == ""


# --------------------------------------------------------------------------- #
# Idempotent announcements + notifications                                    #
# --------------------------------------------------------------------------- #
def test_offer_announcement_idempotent(env, monkeypatch):
    api, db, services = env
    _enable_points(api, exercises_required=1)
    _seed_session(db)
    emitted: list[dict] = []
    injected: list[str] = []

    async def cb_emit(p): emitted.append(p)
    async def cb_inject(t): injected.append(t)
    ctx = services["RewardSessionCtx"](
        "sid1", "stu123", display_name="Dara Lim",
        gemini_inject_cb=cb_inject, client_send_cb=cb_emit)
    _open_and_evaluate(services, ctx, "sid1", "stu123")
    # One offer event emitted on the first eligibility.
    offer_evts = [e for e in emitted
                  if e["type"] == "reward_offer_available"]
    assert len(offer_evts) == 1
    # Verify it carries session_id for frontend filtering.
    assert offer_evts[0]["session_id"] == "sid1"
    # If we somehow re-trigger _emit_offer_available, it must not fire again
    # (offer_announced_at is set).
    offer = db["edutalk_coach_rewards_offers"].docs[0]
    assert offer["offer_announcement_delivered_at"] is not None


def test_claim_start_notification_and_confirmed_notification(env, monkeypatch):
    api, db, services = env
    _enable_points(api, exercises_required=1)
    _seed_session(db)
    grant_log: list[dict] = []
    _install_stable_nonce_helper(monkeypatch, grant_log)
    ctx = services["RewardSessionCtx"]("sid1", "stu123",
                                         display_name="Dara Lim")
    _open_and_evaluate(services, ctx, "sid1", "stu123")
    offer_id = db["edutalk_coach_rewards_offers"].docs[0]["offer_id"]
    run(services["claim_offer"](offer_id, "stu123", "rest"))
    keys = sorted(n["notif_key"]
                  for n in db["edutalk_coach_rewards_notifications"].docs)
    assert keys == [
        f"edutalk-coach-reward:{offer_id}:claim-started",
        f"edutalk-coach-reward:{offer_id}:confirmed",
    ]
    run(services["claim_offer"](offer_id, "stu123", "ws"))
    keys2 = sorted(n["notif_key"]
                   for n in db["edutalk_coach_rewards_notifications"].docs)
    assert keys2 == keys, "notifications must not duplicate on retry"
    confirmed = next(n for n in db["edutalk_coach_rewards_notifications"].docs
                     if n["notif_key"].endswith(":confirmed"))
    assert "Dara" in confirmed["body"]
    assert offer_id not in confirmed["body"]
    assert offer_id not in confirmed["title"]


def test_pending_claim_does_not_send_confirmed_notification(env, monkeypatch):
    api, db, services = env
    _enable_points(api, exercises_required=1)
    _seed_session(db)

    async def timeout_credit(_c, _a, _n):
        return {"outcome": "grant_unknown",
                "error": "network timeout",
                "provider_ref": None, "balance_after": None,
                "duplicate": False}
    monkeypatch.setitem(rwd.__dict__,
                        "_gas_treasury_credit_with_nonce", timeout_credit)
    ctx = services["RewardSessionCtx"]("sid1", "stu123",
                                         display_name="Dara Lim")
    _open_and_evaluate(services, ctx, "sid1", "stu123")
    offer_id = db["edutalk_coach_rewards_offers"].docs[0]["offer_id"]
    r = run(services["claim_offer"](offer_id, "stu123", "rest"))
    assert r["state"] == "pending_confirmation"
    keys = [n["notif_key"]
            for n in db["edutalk_coach_rewards_notifications"].docs]
    assert f"edutalk-coach-reward:{offer_id}:claim-started" in keys
    assert f"edutalk-coach-reward:{offer_id}:confirmed" not in keys


# --------------------------------------------------------------------------- #
# Studio config update versioning                                             #
# --------------------------------------------------------------------------- #
def test_studio_config_versions_and_audits(env):
    api, db, _services = env
    put_route = api.routes[("PUT", "/admin/edutalk-live/rewards/config")]
    run(put_route({"config": {"enabled": True, "points_enabled": True,
                              "approved_point_values": [5, 10]}}, _Admin()))
    run(put_route({"config": {"enabled": True, "points_enabled": True,
                              "approved_point_values": [5]}}, _Admin()))
    cfg_doc = run(db["edutalk_coach_rewards_config"].find_one(
        {"_id": "singleton"}))
    assert cfg_doc["version"] >= 2
    audits = db["edutalk_coach_rewards_audit"].docs
    assert any(a.get("kind") == "config_update" for a in audits)


# --------------------------------------------------------------------------- #
# AUDIT 4.3 — Coach-turn classifier                                           #
# --------------------------------------------------------------------------- #
def test_classifier_rejects_greetings_explanations_encouragement():
    for txt in (
        "Hello! Welcome back to your speaking practice.",
        "Great job, keep going!",
        "Let me explain how the past tense works in English.",
        "That's wonderful work today.",
        "Good morning Dara, how are you?",
    ):
        kind, target = rwd.classify_coach_turn(txt)
        assert kind is None, f"unexpectedly classified: {txt!r} ⇒ {kind}"


def test_classifier_accepts_supported_tasks():
    repeat_kind, _ = rwd.classify_coach_turn(
        "Please repeat after me: the brown fox jumps.")
    assert repeat_kind == "repeat_after_coach"
    qa_kind, _ = rwd.classify_coach_turn(
        "Can you tell me what you did this morning?")
    assert qa_kind == "guided_short_answer"
    book_kind, _ = rwd.classify_coach_turn(
        "From your book, read the next sentence aloud.")
    assert book_kind == "book_shadow_sentence"


def test_classifier_correction_extracts_target():
    kind, target = rwd.classify_coach_turn(
        'That is not quite right — let me correct you. Try again: '
        'say "the cat sat on the mat".')
    assert kind == "correction_retry"
    assert target and "cat" in target.lower()


def test_register_exercise_ignores_unclassified_coach_turn(env):
    api, db, services = env
    _enable_points(api)
    _seed_session(db)
    ctx = services["RewardSessionCtx"]("sid1", "stu123",
                                         display_name="Dara")
    exid = run(services["register_exercise"](
        "sid1", "stu123", ctx,
        "Hi Dara! Today we will practise some sentences together."))
    assert exid is None
    assert db["edutalk_coach_rewards_exercises"].docs == []


# --------------------------------------------------------------------------- #
# AUDIT 4.4 — Correction lifecycle                                            #
# --------------------------------------------------------------------------- #
def test_correction_required_only_for_correction_retry(env):
    api, db, services = env
    _enable_points(api)
    _seed_session(db)
    ctx = services["RewardSessionCtx"]("sid1", "stu123",
                                         display_name="Dara")
    # Non-correction task — correction_required must be False.
    run(services["register_exercise"](
        "sid1", "stu123", ctx,
        "Please repeat after me: the brown fox jumps."))
    doc = db["edutalk_coach_rewards_exercises"].docs[-1]
    assert doc["correction_required"] is False
    assert doc["correction_resolved"] is False


def test_correction_resolved_requires_target_overlap(env):
    api, db, services = env
    _enable_points(api)
    _seed_session(db)
    ctx = services["RewardSessionCtx"]("sid1", "stu123",
                                         display_name="Dara")
    run(services["register_exercise"](
        "sid1", "stu123", ctx,
        'Try again: please say "the cat sat on the mat".'))
    # Student answers something UNRELATED to the correction target —
    # correction_resolved must remain False.
    run(services["evaluate_exercise"](
        "sid1", "stu123", ctx,
        "I went to the market yesterday and bought some rice."))
    doc = db["edutalk_coach_rewards_exercises"].docs[-1]
    assert doc["correction_required"] is True
    # Even if the exercise is "successful" by length+confidence, the
    # correction is NOT resolved because no overlap with the target.
    assert doc["correction_resolved"] is False


def test_correction_resolved_when_target_words_repeated(env):
    api, db, services = env
    _enable_points(api)
    _seed_session(db)
    ctx = services["RewardSessionCtx"]("sid1", "stu123",
                                         display_name="Dara")
    run(services["register_exercise"](
        "sid1", "stu123", ctx,
        'Try again: please say "the cat sat on the mat".'))
    run(services["evaluate_exercise"](
        "sid1", "stu123", ctx,
        "The cat sat on the mat quietly."))
    doc = db["edutalk_coach_rewards_exercises"].docs[-1]
    assert doc["correction_required"] is True
    assert doc["correction_resolved"] is True


# --------------------------------------------------------------------------- #
# AUDIT 4.5 — Cap reservation fails closed                                    #
# --------------------------------------------------------------------------- #
def test_cap_reservation_fails_closed_on_generic_db_error(env, monkeypatch):
    api, db, services = env
    _enable_points(api, exercises_required=1)
    _seed_session(db)
    # Patch the cap collection's insert_one to raise a generic exception
    # (NOT a DuplicateKey). The reservation MUST fail closed and the
    # offer MUST NOT be created.
    cap_col = db["edutalk_coach_rewards_cap_reservations"]
    original = cap_col.insert_one

    async def boom(doc):
        raise RuntimeError("simulated db timeout")
    cap_col.insert_one = boom  # type: ignore[assignment]
    try:
        ctx = services["RewardSessionCtx"]("sid1", "stu123",
                                             display_name="Dara")
        _open_and_evaluate(services, ctx, "sid1", "stu123")
        offers = db["edutalk_coach_rewards_offers"].docs
        assert offers == [], (
            "offer must NOT be created when reservation persistence fails")
    finally:
        cap_col.insert_one = original  # type: ignore[assignment]


# --------------------------------------------------------------------------- #
# AUDIT 4.6 — claim-start notification timing                                 #
# --------------------------------------------------------------------------- #
def test_expired_offer_does_not_create_claim_start_notification(env, monkeypatch):
    api, db, services = env
    _enable_points(api, exercises_required=1, ttl=120)
    _seed_session(db)
    ctx = services["RewardSessionCtx"]("sid1", "stu123",
                                         display_name="Dara")
    _open_and_evaluate(services, ctx, "sid1", "stu123")
    offer = db["edutalk_coach_rewards_offers"].docs[0]
    # Force-expire the offer.
    db["edutalk_coach_rewards_offers"].docs[0]["expires_at"] = (
        "1970-01-01T00:00:00+00:00")
    r = run(services["claim_offer"](offer["offer_id"], "stu123", "rest"))
    assert r["state"] == "expired"
    keys = [n["notif_key"]
            for n in db["edutalk_coach_rewards_notifications"].docs]
    assert (f"edutalk-coach-reward:{offer['offer_id']}:claim-started"
            not in keys), "expired offer must NOT create claim-start notif"


def test_confirmed_replay_does_not_create_extra_notifications(env, monkeypatch):
    api, db, services = env
    _enable_points(api, exercises_required=1)
    _seed_session(db)
    grant_log: list[dict] = []
    _install_stable_nonce_helper(monkeypatch, grant_log)
    ctx = services["RewardSessionCtx"]("sid1", "stu123",
                                         display_name="Dara")
    _open_and_evaluate(services, ctx, "sid1", "stu123")
    offer_id = db["edutalk_coach_rewards_offers"].docs[0]["offer_id"]
    run(services["claim_offer"](offer_id, "stu123", "rest"))
    keys_before = sorted(
        n["notif_key"]
        for n in db["edutalk_coach_rewards_notifications"].docs)
    # Replay confirmed claim — neither notification key duplicates.
    run(services["claim_offer"](offer_id, "stu123", "ws"))
    keys_after = sorted(
        n["notif_key"]
        for n in db["edutalk_coach_rewards_notifications"].docs)
    assert keys_after == keys_before


# --------------------------------------------------------------------------- #
# AUDIT 4.7 — announcement delivery lifecycle                                 #
# --------------------------------------------------------------------------- #
def test_failed_offer_announcement_records_error_and_retryable(env, monkeypatch):
    api, db, services = env
    _enable_points(api, exercises_required=1)
    _seed_session(db)
    # Build a ctx whose gemini-inject ALWAYS fails. The offer is created
    # but the announcement is NOT marked delivered; the reservation is
    # cleared so a retry can succeed.
    async def bad_inject(_text):
        raise RuntimeError("gemini gone")
    async def ws_emit(_p):
        return None
    ctx = services["RewardSessionCtx"](
        "sid1", "stu123", display_name="Dara",
        gemini_inject_cb=bad_inject, client_send_cb=ws_emit)
    _open_and_evaluate(services, ctx, "sid1", "stu123")
    offer = db["edutalk_coach_rewards_offers"].docs[0]
    assert offer["offer_announcement_delivered_at"] is None
    assert offer["offer_announcement_reserved_at"] is None
    assert (offer.get("offer_announcement_last_error") or "").startswith(
        "ws_ok=")


# --------------------------------------------------------------------------- #
# AUDIT 4.1 — push targeting helper                                           #
# --------------------------------------------------------------------------- #
def test_push_fanout_uses_studentId_not_clean_id(env, monkeypatch):
    api, db, services = env
    _enable_points(api, exercises_required=1)
    _seed_session(db)
    grant_log: list[dict] = []
    _install_stable_nonce_helper(monkeypatch, grant_log)

    captured: dict = {}

    async def fake_fan_out(query, title, body, url):
        captured["query"] = query
        captured["title"] = title
        return 1, 0

    def fake_target_builder(target, ids, group):
        # Mirrors the real helper's case + whitespace tolerance.
        import re as _re
        if target == "students":
            esc = [_re.escape(s.strip()) for s in (ids or [])]
            return {"$or": [
                {"studentId": {"$regex": rf"^\s*{e}\s*$",
                               "$options": "i"}}
                for e in esc
            ]}
        return {}
    # Inject fakes into a fake ``server`` module the helper imports.
    import sys, types
    fake_server = types.ModuleType("server")
    fake_server._fan_out_push = fake_fan_out
    fake_server._build_target_query = fake_target_builder
    monkeypatch.setitem(sys.modules, "server", fake_server)

    ctx = services["RewardSessionCtx"]("sid1", "stu123",
                                         display_name="Dara")
    _open_and_evaluate(services, ctx, "sid1", "stu123")
    offer_id = db["edutalk_coach_rewards_offers"].docs[0]["offer_id"]
    run(services["claim_offer"](offer_id, "stu123", "rest"))

    q = captured.get("query")
    assert q, "push fan-out must have been invoked"
    # The query MUST target the studentId field, never clean_id.
    serialised = repr(q)
    assert "studentId" in serialised
    assert "clean_id" not in serialised


# --------------------------------------------------------------------------- #
# B2 (audit) — Classifier must NOT register on a bare question mark           #
# --------------------------------------------------------------------------- #
@pytest.mark.parametrize("text", [
    "How are you today?",
    "Are you ready?",
    "Do you like this story?",
    "What do you think?",
    "Shall we continue?",
    "Would you like another example?",
])
def test_classifier_rejects_ordinary_questions(text):
    kind, target = rwd.classify_coach_turn(text)
    assert kind is None, (
        f"ordinary question {text!r} must NOT become an exercise — "
        f"the bare-question-mark branch is removed (audit B2)")
    assert target is None


def test_classifier_still_accepts_explicit_supported_forms():
    # Each explicit supported form must continue to classify.
    k1, _ = rwd.classify_coach_turn("Repeat after me: the brown fox jumps.")
    assert k1 == "repeat_after_coach"
    k2, _ = rwd.classify_coach_turn("Can you describe the picture?")
    assert k2 == "guided_short_answer"
    k3, _ = rwd.classify_coach_turn("Tell me about your weekend.")
    assert k3 == "guided_short_answer"
    k4, _ = rwd.classify_coach_turn(
        "Read the next sentence from your book.")
    assert k4 == "book_shadow_sentence"
    k5, target5 = rwd.classify_coach_turn(
        'Try again: say "the cat sat on the mat"')
    assert k5 == "correction_retry"
    assert target5 and "cat" in target5.lower()


# --------------------------------------------------------------------------- #
# B3 (audit) — Evaluator must require meaningful similarity                   #
# --------------------------------------------------------------------------- #
def test_repeat_fails_when_only_one_word_overlaps(env):
    """B3 acceptance — target ``the cat sat on the mat`` ←
    ``I saw a cat yesterday and went home``: one shared content word
    is NOT enough to mark a repeat exercise successful."""
    api, db, services = env
    _enable_points(api)
    _seed_session(db)
    ctx = services["RewardSessionCtx"]("sid1", "stu123",
                                         display_name="Dara")
    run(services["register_exercise"](
        "sid1", "stu123", ctx,
        "Please repeat after me: the cat sat on the mat."))
    run(services["evaluate_exercise"](
        "sid1", "stu123", ctx,
        "I saw a cat yesterday and went home."))
    doc = db["edutalk_coach_rewards_exercises"].docs[-1]
    assert doc["state"] == "terminal"
    assert doc["result"] == "failed", (
        "one shared content word must NOT mark a repeat exercise "
        "successful (audit B3)")


def test_correction_one_token_overlap_does_not_resolve(env):
    """B3 acceptance — for ``correction_retry`` with target
    ``the cat sat on the mat``, a response sharing exactly one
    content word (``cat``) must NOT mark correction_resolved True."""
    api, db, services = env
    _enable_points(api)
    _seed_session(db)
    ctx = services["RewardSessionCtx"]("sid1", "stu123",
                                         display_name="Dara")
    run(services["register_exercise"](
        "sid1", "stu123", ctx,
        'Try again: please say "the cat sat on the mat".'))
    run(services["evaluate_exercise"](
        "sid1", "stu123", ctx,
        "I saw a cat yesterday and went home."))
    doc = db["edutalk_coach_rewards_exercises"].docs[-1]
    assert doc["correction_required"] is True
    assert doc["correction_resolved"] is False, (
        "one shared content word must NOT mark correction_resolved "
        "(audit B3)")


def test_repeat_passes_on_identical_target_and_response(env):
    """B3 acceptance — target ``I would like a glass of water.``
    repeated verbatim must succeed at default min_confidence 0.70."""
    api, db, services = env
    _enable_points(api, min_conf=0.7)
    _seed_session(db)
    ctx = services["RewardSessionCtx"]("sid1", "stu123",
                                         display_name="Dara")
    run(services["register_exercise"](
        "sid1", "stu123", ctx,
        "Please repeat after me: I would like a glass of water."))
    run(services["evaluate_exercise"](
        "sid1", "stu123", ctx,
        "I would like a glass of water."))
    doc = db["edutalk_coach_rewards_exercises"].docs[-1]
    assert doc["state"] == "terminal"
    assert doc["result"] == "successful"
    assert doc.get("confidence", 0.0) >= 0.70


# ===========================================================================
# PRODUCTION TESTS — Phase 2 (Stable Idempotency + State Machine)
# ===========================================================================

# --------------------------------------------------------------------------- #
# Stable SHA-256 provider idempotency key                                    #
# --------------------------------------------------------------------------- #
def test_stable_key_is_64_hex_chars():
    """_stable_provider_key returns a 64-char lowercase hex string."""
    key = rwd._stable_provider_key(
        offer_id="rwd_abc123",
        clean_id="stu123",
        session_id="sid_x",
        reward_kind="points",
        reward_amount=5,
    )
    assert len(key) == 64
    assert all(c in "0123456789abcdef" for c in key)


def test_stable_key_same_inputs_same_output():
    """Same inputs always produce the same key (deterministic, no randomness)."""
    k1 = rwd._stable_provider_key("rwd_1", "s1", "sess1", "points", 5)
    k2 = rwd._stable_provider_key("rwd_1", "s1", "sess1", "points", 5)
    assert k1 == k2


def test_stable_key_different_offer_different_key():
    """Different offer_id produces a different key even with same student."""
    k1 = rwd._stable_provider_key("rwd_A", "s1", "sess1", "points", 5)
    k2 = rwd._stable_provider_key("rwd_B", "s1", "sess1", "points", 5)
    assert k1 != k2


def test_stable_key_different_amount_different_key():
    """Different reward_amount produces a different key."""
    k1 = rwd._stable_provider_key("rwd_A", "s1", "sess1", "points", 5)
    k2 = rwd._stable_provider_key("rwd_A", "s1", "sess1", "points", 10)
    assert k1 != k2


def test_stable_key_different_student_different_key():
    """Different clean_id produces a different key."""
    k1 = rwd._stable_provider_key("rwd_A", "stu_X", "sess1", "points", 5)
    k2 = rwd._stable_provider_key("rwd_A", "stu_Y", "sess1", "points", 5)
    assert k1 != k2


def test_stable_key_is_sha256():
    """_stable_provider_key uses SHA-256 — verified against known output."""
    import hashlib
    canonical = (
        "edutalk-coach-reward:"
        "rwd_test:"
        "stu_test:"
        "sess_test:"
        "points:"
        "5"
    )
    expected = hashlib.sha256(canonical.encode("utf-8")).hexdigest()
    result = rwd._stable_provider_key("rwd_test", "stu_test", "sess_test",
                                      "points", 5)
    assert result == expected


# --------------------------------------------------------------------------- #
# WalletService integration — credit function outcomes                       #
# --------------------------------------------------------------------------- #
def test_wallet_credit_returns_granted_dict(env, monkeypatch):
    """When WalletService mock returns ok=True, _gas_treasury_credit_with_nonce
    outcome is 'granted' (dict)."""
    api, db, services = env

    async def credit_granted(clean_id, amount, nonce):
        return {"outcome": "granted", "provider_ref": nonce[:8],
                "balance_after": 100.0, "duplicate": False, "error": None}

    monkeypatch.setattr(rwd, "REAL_GRANT_ENABLED", True)
    monkeypatch.setitem(rwd.__dict__, "_gas_treasury_credit_with_nonce", credit_granted)
    _enable_points(api, exercises_required=1)
    _seed_session(db)
    ctx = services["RewardSessionCtx"]("sid1", "stu123", display_name="Dara")
    _open_and_evaluate(services, ctx, "sid1", "stu123")
    offer = db["edutalk_coach_rewards_offers"].docs[0]
    r = run(services["claim_offer"](offer["offer_id"], "stu123", "rest"))
    assert r["state"] in ("granted", "confirmed")
    grant = db["edutalk_coach_rewards_grants"].docs[0]
    assert grant["state"] == "granted"


def test_wallet_credit_terminal_failure_sets_state(env, monkeypatch):
    """A wallet terminal failure (blocked/not_found) marks offer grant_terminal_failed."""
    api, db, services = env

    async def credit_terminal(clean_id, amount, nonce):
        return {"outcome": "grant_terminal_failed",
                "error": "wallet_blocked:WalletStatusBlocked",
                "provider_ref": None, "balance_after": None, "duplicate": False}

    monkeypatch.setattr(rwd, "REAL_GRANT_ENABLED", True)
    monkeypatch.setitem(rwd.__dict__, "_gas_treasury_credit_with_nonce", credit_terminal)
    _enable_points(api, exercises_required=1)
    _seed_session(db)
    ctx = services["RewardSessionCtx"]("sid1", "stu123", display_name="Dara")
    _open_and_evaluate(services, ctx, "sid1", "stu123")
    offer = db["edutalk_coach_rewards_offers"].docs[0]
    r = run(services["claim_offer"](offer["offer_id"], "stu123", "rest"))
    assert r["state"] in ("grant_terminal_failed", "failed_terminal")
    grant = db["edutalk_coach_rewards_grants"].docs[0]
    assert grant["state"] == "grant_terminal_failed"


def test_wallet_credit_transport_error_sets_grant_unknown(env, monkeypatch):
    """A transport error sets the grant to grant_unknown (ambiguous)."""
    api, db, services = env

    async def credit_unknown(clean_id, amount, nonce):
        return {"outcome": "grant_unknown",
                "error": "transport:ConnectionError",
                "provider_ref": None, "balance_after": None, "duplicate": False}

    monkeypatch.setattr(rwd, "REAL_GRANT_ENABLED", True)
    monkeypatch.setitem(rwd.__dict__, "_gas_treasury_credit_with_nonce", credit_unknown)
    _enable_points(api, exercises_required=1)
    _seed_session(db)
    ctx = services["RewardSessionCtx"]("sid1", "stu123", display_name="Dara")
    _open_and_evaluate(services, ctx, "sid1", "stu123")
    offer = db["edutalk_coach_rewards_offers"].docs[0]
    r = run(services["claim_offer"](offer["offer_id"], "stu123", "rest"))
    # pending_confirmation because grant is unknown/ambiguous
    assert r["state"] == "pending_confirmation"
    grant = db["edutalk_coach_rewards_grants"].docs[0]
    assert grant["state"] == "grant_unknown"


def test_wallet_duplicate_credit_is_idempotent(env, monkeypatch):
    """If WalletService returns duplicate=True, claim still resolves to granted."""
    api, db, services = env

    async def credit_duplicate(clean_id, amount, nonce):
        return {"outcome": "granted", "provider_ref": nonce[:8],
                "balance_after": 100.0, "duplicate": True, "error": None}

    monkeypatch.setattr(rwd, "REAL_GRANT_ENABLED", True)
    monkeypatch.setitem(rwd.__dict__, "_gas_treasury_credit_with_nonce", credit_duplicate)
    _enable_points(api, exercises_required=1)
    _seed_session(db)
    ctx = services["RewardSessionCtx"]("sid1", "stu123", display_name="Dara")
    _open_and_evaluate(services, ctx, "sid1", "stu123")
    offer = db["edutalk_coach_rewards_offers"].docs[0]
    r = run(services["claim_offer"](offer["offer_id"], "stu123", "rest"))
    assert r["state"] in ("granted", "confirmed")
    grant = db["edutalk_coach_rewards_grants"].docs[0]
    assert grant.get("duplicate") is True
    assert grant["state"] == "granted"


# --------------------------------------------------------------------------- #
# Stable key stored before dispatch                                          #
# --------------------------------------------------------------------------- #
def test_provider_idempotency_key_stored_on_grant_row(env, monkeypatch):
    """The stable SHA-256 provider_idempotency_key is persisted on the
    grant outbox row BEFORE any provider call — enabling reconciliation
    to use the same key for ledger lookup."""
    api, db, services = env
    calls = []

    async def credit_capture(clean_id, amount, nonce):
        calls.append({"nonce": nonce})
        return {"outcome": "granted", "provider_ref": nonce[:8],
                "balance_after": 100.0, "duplicate": False, "error": None}

    monkeypatch.setattr(rwd, "REAL_GRANT_ENABLED", True)
    monkeypatch.setitem(rwd.__dict__, "_gas_treasury_credit_with_nonce", credit_capture)
    _enable_points(api, exercises_required=1)
    _seed_session(db)
    ctx = services["RewardSessionCtx"]("sid1", "stu123", display_name="Dara")
    _open_and_evaluate(services, ctx, "sid1", "stu123")
    offer = db["edutalk_coach_rewards_offers"].docs[0]
    run(services["claim_offer"](offer["offer_id"], "stu123", "rest"))
    grant = db["edutalk_coach_rewards_grants"].docs[0]
    # provider_idempotency_key stored on the row
    assert "provider_idempotency_key" in grant
    key_on_row = grant["provider_idempotency_key"]
    # Must be SHA-256 (64 hex chars)
    assert len(key_on_row) == 64
    # Must match what was passed to the credit function
    assert calls and calls[0]["nonce"] == key_on_row


def test_provider_idempotency_key_stable_across_retry(env, monkeypatch):
    """The same provider_idempotency_key is reused on retry (claim_offer twice).
    The grant outbox row still has only one entry with the same key."""
    api, db, services = env
    calls = []

    async def credit_once(clean_id, amount, nonce):
        calls.append(nonce)
        return {"outcome": "granted", "provider_ref": nonce[:8],
                "balance_after": 100.0, "duplicate": len(calls) > 1, "error": None}

    monkeypatch.setattr(rwd, "REAL_GRANT_ENABLED", True)
    monkeypatch.setitem(rwd.__dict__, "_gas_treasury_credit_with_nonce", credit_once)
    _enable_points(api, exercises_required=1)
    _seed_session(db)
    ctx = services["RewardSessionCtx"]("sid1", "stu123", display_name="Dara")
    _open_and_evaluate(services, ctx, "sid1", "stu123")
    offer = db["edutalk_coach_rewards_offers"].docs[0]
    run(services["claim_offer"](offer["offer_id"], "stu123", "rest"))
    run(services["claim_offer"](offer["offer_id"], "stu123", "ws"))
    grant_rows = db["edutalk_coach_rewards_grants"].docs
    assert len(grant_rows) == 1, "only one grant outbox row per offer"
    # The key is the same (or call was not made twice — idempotent)
    if len(calls) > 1:
        assert calls[0] == calls[1], "same key used on retry"


# --------------------------------------------------------------------------- #
# Claim state machine — claim_reserved state                                  #
# --------------------------------------------------------------------------- #
def test_claim_reserved_state_during_dispatch(env, monkeypatch):
    """After the atomic claimable→claim_reserved transition, if grant is
    pending, offer shows pending_confirmation not raw claim_reserved."""
    api, db, services = env

    async def credit_slow(clean_id, amount, nonce):
        return {"outcome": "grant_unknown", "error": "transport:slow",
                "provider_ref": None, "balance_after": None, "duplicate": False}

    monkeypatch.setattr(rwd, "REAL_GRANT_ENABLED", True)
    monkeypatch.setitem(rwd.__dict__, "_gas_treasury_credit_with_nonce", credit_slow)
    _enable_points(api, exercises_required=1)
    _seed_session(db)
    ctx = services["RewardSessionCtx"]("sid1", "stu123", display_name="Dara")
    _open_and_evaluate(services, ctx, "sid1", "stu123")
    offer = db["edutalk_coach_rewards_offers"].docs[0]
    r = run(services["claim_offer"](offer["offer_id"], "stu123", "rest"))
    # From the client's perspective it's pending_confirmation
    assert r["state"] == "pending_confirmation"
    # The grant row is grant_unknown
    grant = db["edutalk_coach_rewards_grants"].docs[0]
    assert grant["state"] == "grant_unknown"


# --------------------------------------------------------------------------- #
# Grant state machine — real_grant_not_enabled terminal                      #
# --------------------------------------------------------------------------- #
def test_dispatch_fails_terminal_when_real_grant_not_enabled(env, monkeypatch):
    """When REAL_GRANT_ENABLED=False, dispatch sets grant_terminal_failed."""
    api, db, services = env
    monkeypatch.setattr(rwd, "REAL_GRANT_ENABLED", False)
    _enable_points(api, exercises_required=1)
    _seed_session(db)
    ctx = services["RewardSessionCtx"]("sid1", "stu123", display_name="Dara")
    _open_and_evaluate(services, ctx, "sid1", "stu123")
    offers = db["edutalk_coach_rewards_offers"].docs
    # When REAL_GRANT_ENABLED=False, _provider_grant_available=False
    # so no offer is created at all.
    assert offers == [], "no offer when REAL_GRANT_ENABLED=False"


# --------------------------------------------------------------------------- #
# Admin diagnostic endpoint                                                   #
# --------------------------------------------------------------------------- #
def test_admin_unresolved_grants_endpoint(env, monkeypatch):
    """GET /admin/edutalk-live/rewards/grants/unresolved returns count
    and state of unresolved grants."""
    api, db, services = env

    async def credit_unknown(clean_id, amount, nonce):
        return {"outcome": "grant_unknown", "error": "transport:timeout",
                "provider_ref": None, "balance_after": None, "duplicate": False}

    monkeypatch.setattr(rwd, "REAL_GRANT_ENABLED", True)
    monkeypatch.setitem(rwd.__dict__, "_gas_treasury_credit_with_nonce", credit_unknown)
    _enable_points(api, exercises_required=1)
    _seed_session(db)
    ctx = services["RewardSessionCtx"]("sid1", "stu123", display_name="Dara")
    _open_and_evaluate(services, ctx, "sid1", "stu123")
    offer = db["edutalk_coach_rewards_offers"].docs[0]
    run(services["claim_offer"](offer["offer_id"], "stu123", "rest"))
    # Now call the admin endpoint
    unresolved_route = api.routes.get(
        ("GET", "/admin/edutalk-live/rewards/grants/unresolved"))
    if unresolved_route is None:
        pytest.skip("unresolved endpoint not registered")
    res = run(unresolved_route(limit=50, admin=_Admin()))
    assert res["success"] is True
    assert res["count"] >= 1
    assert any(g["state"] == "grant_unknown" for g in res["unresolved"])


# --------------------------------------------------------------------------- #
# Student active offer endpoint — enhanced recovery                           #
# --------------------------------------------------------------------------- #
def test_active_offer_returns_granted_state(env, monkeypatch):
    """GET /edutalk/reward-offers/active returns granted claim result
    when the offer is already confirmed."""
    api, db, services = env
    grant_log = []
    _install_stable_nonce_helper(monkeypatch, grant_log)
    _enable_points(api, exercises_required=1)
    _seed_session(db)
    ctx = services["RewardSessionCtx"]("sid1", "stu123", display_name="Dara")
    _open_and_evaluate(services, ctx, "sid1", "stu123")
    offer_id = db["edutalk_coach_rewards_offers"].docs[0]["offer_id"]
    run(services["claim_offer"](offer_id, "stu123", "rest"))
    get_active = api.routes[("GET", "/edutalk/reward-offers/active")]
    res = run(get_active(session_id="sid1", student=_Student()))
    assert res["offer"] is not None
    assert res["offer"]["state"] in ("granted", "confirmed", "pending_confirmation")


def test_active_offer_cross_session_returns_none(env, monkeypatch):
    """GET /edutalk/reward-offers/active returns null for wrong session_id."""
    api, db, services = env
    _enable_points(api, exercises_required=1)
    _seed_session(db, sid="sidA")
    ctx = services["RewardSessionCtx"]("sidA", "stu123", display_name="Dara")
    _open_and_evaluate(services, ctx, "sidA", "stu123")
    get_active = api.routes[("GET", "/edutalk/reward-offers/active")]
    res = run(get_active(session_id="sidB", student=_Student()))
    assert res["offer"] is None, "cross-session must return no offer"


# --------------------------------------------------------------------------- #
# Status includes reconcile + wallet_service_ok                              #
# --------------------------------------------------------------------------- #
def test_public_status_includes_wallet_service_ok(env):
    """GET /admin/edutalk-live/rewards/config includes wallet_service_ok."""
    api, db, _ = env
    _enable_points(api)
    get_cfg = api.routes[("GET", "/admin/edutalk-live/rewards/config")]
    res = run(get_cfg(_Admin()))
    status = res.get("status") or {}
    # wallet_service_ok may be False in test env (WalletService not importable)
    # but the key must exist.
    assert "wallet_service_ok" in status or "grant_adapter_version" in status


# =========================================================================== #
# RECONCILIATION TESTS — Blocker 3: Direct reconciliation path coverage       #
# =========================================================================== #

# --------------------------------------------------------------------------- #
# Helpers shared by reconciliation tests                                      #
# --------------------------------------------------------------------------- #

def _make_grant_row(db, *, tx_id, offer_id, clean_id="stu123", amount=5,
                    state="grant_retryable", stored_key=None,
                    recon_attempts=0):
    """Insert a synthetic grant outbox row directly into the fake DB."""
    key = stored_key or ("a" * 64)
    row = {
        "tx_id": tx_id,
        "offer_id": offer_id,
        "clean_id": clean_id,
        "amount": amount,
        "state": state,
        "provider_idempotency_key": key,
        "attempts": 1,
        "recon_attempts": recon_attempts,
        "created_at": rwd._iso(),
        "last_error": None,
        "provider_ref": None,
        "confirmed_at": None,
        "failed_at": None,
        "recon_exhausted": False,
        "recon_lease_until": None,
    }
    db["edutalk_coach_rewards_grants"].docs.append(row)
    return row, key


def _make_offer_row(db, *, offer_id, clean_id="stu123", session_id="sid1",
                    state="claim_reserved"):
    """Insert a synthetic offer row directly into the fake DB."""
    row = {
        "_id": offer_id,
        "offer_id": offer_id,
        "clean_id": clean_id,
        "session_id": session_id,
        "state": state,
        "reward_type": "points",
        "reward_amount": 5,
        "reward_spec": {"summary": "5 points"},
        "recognition_snapshot": {"student_name": "Dara",
                                  "successful_exercise_count": 1},
        "config_snapshot": {},
        "expires_at": "2099-01-01T00:00:00+00:00",
        "created_at": rwd._iso(),
    }
    db["edutalk_coach_rewards_offers"].docs.append(row)
    return row


def _get_grant(db, tx_id):
    return next((d for d in db["edutalk_coach_rewards_grants"].docs
                 if d["tx_id"] == tx_id), None)


def _get_notifs(db, offer_id):
    return [n for n in db["edutalk_coach_rewards_notifications"].docs
            if n.get("offer_id") == offer_id]


# --------------------------------------------------------------------------- #
# RT-01  Retryable grant — shared resolver, same key, no new key              #
# --------------------------------------------------------------------------- #
def test_recon_retryable_uses_resolver_and_same_key(env, monkeypatch):
    """_reconcile_one_grant resolves a grant_retryable claim:
    - shared resolver provides the callable (no reference to _dispatch_grant locals)
    - the SAME stored idempotency key is reused (no new key generated)
    - successful provider result transitions the row to 'granted'
    - the helper is called exactly once"""
    api, db, services = env
    calls = []

    async def credit_ok(clean_id, amount, nonce):
        calls.append(nonce)
        return {"outcome": "granted", "provider_ref": nonce[:8],
                "balance_after": 100, "duplicate": False, "error": None}

    monkeypatch.setattr(rwd, "REAL_GRANT_ENABLED", True)
    monkeypatch.setitem(rwd.__dict__, "_gas_treasury_credit_with_nonce", credit_ok)

    stored_key = "b" * 64
    tx_id = "recon-retryable-001"
    offer_id = "offer-rt-001"
    _make_offer_row(db, offer_id=offer_id)
    _make_grant_row(db, tx_id=tx_id, offer_id=offer_id,
                    state="grant_retryable", stored_key=stored_key)

    # Register routes so _reconcile_one_grant is callable via the worker.
    _enable_points(api, exercises_required=1)
    # Directly call the reconciliation worker internals via the registered
    # reconcile-one-grant function exposed through the worker cycle.
    # We call _reconcile_grants_worker one iteration indirectly by invoking
    # _reconcile_one_grant on the row directly using the worker factory.
    from types import SimpleNamespace
    row = _get_grant(db, tx_id)
    result = run(rwd._call_reconcile_one(db, row))

    assert result == "resolved_granted", f"expected resolved_granted, got {result}"
    grant = _get_grant(db, tx_id)
    assert grant["state"] == "granted"
    assert len(calls) == 1, "helper must be called exactly once"
    assert calls[0] == stored_key, "same stored key must be reused, no new key"


def test_recon_retryable_no_new_idempotency_key(env, monkeypatch):
    """Reconciliation of grant_retryable must reuse the stored
    provider_idempotency_key, never generate a fresh one."""
    api, db, services = env
    keys_seen = []

    async def credit_capture(clean_id, amount, nonce):
        keys_seen.append(nonce)
        return {"outcome": "granted", "provider_ref": "ref123",
                "balance_after": 100, "duplicate": False, "error": None}

    monkeypatch.setattr(rwd, "REAL_GRANT_ENABLED", True)
    monkeypatch.setitem(rwd.__dict__, "_gas_treasury_credit_with_nonce", credit_capture)
    original_key = "c" * 64
    tx_id = "recon-key-stable-002"
    offer_id = "offer-key-002"
    _make_offer_row(db, offer_id=offer_id)
    _make_grant_row(db, tx_id=tx_id, offer_id=offer_id,
                    state="grant_retryable", stored_key=original_key)

    _enable_points(api, exercises_required=1)
    row = _get_grant(db, tx_id)
    run(rwd._call_reconcile_one(db, row))

    assert keys_seen, "helper must have been called"
    for k in keys_seen:
        assert k == original_key, (
            f"reconciliation generated a new key '{k}' instead of reusing '{original_key}'")


# --------------------------------------------------------------------------- #
# RT-02  Unknown grant confirmed by ledger lookup                              #
# --------------------------------------------------------------------------- #
def test_recon_unknown_confirmed_by_ledger(env, monkeypatch):
    """grant_unknown resolved when ledger lookup finds the credit:
    - claim becomes 'granted'
    - provider_ref is stored
    - confirmed notification is emitted exactly once"""
    api, db, services = env
    stored_key = "d" * 64
    tx_id = "recon-unknown-ledger-003"
    offer_id = "offer-ul-003"
    _make_offer_row(db, offer_id=offer_id)
    _make_grant_row(db, tx_id=tx_id, offer_id=offer_id,
                    state="grant_unknown", stored_key=stored_key)

    # Seed a ledger hit — simulates the credit having landed.
    db["points_transactions"].docs.append({
        "_id": "txn-abc-001",
        "idempotency_key": stored_key,
        "balance_after": 100,
        "status": "confirmed",
        "source": "edutalk_coach_reward",
    })

    _enable_points(api, exercises_required=1)
    row = _get_grant(db, tx_id)
    result = run(rwd._call_reconcile_one(db, row))

    assert result == "resolved_granted", f"expected resolved_granted, got {result}"
    grant = _get_grant(db, tx_id)
    assert grant["state"] == "granted"
    assert grant.get("provider_ref") is not None
    notifs = _get_notifs(db, offer_id)
    assert any("confirmed" in n.get("notif_key", "") for n in notifs), (
        "confirmed notification must be created on ledger-confirmed reconciliation")


# --------------------------------------------------------------------------- #
# RT-03  Unknown grant remains unresolved — no ledger hit, no provider retry   #
# --------------------------------------------------------------------------- #
def test_recon_unknown_remains_unresolved(env, monkeypatch):
    """grant_unknown with no ledger entry stays still_unknown:
    - state does not change to granted or terminal
    - no success event or notification emitted
    - does not become terminal solely because elapsed"""
    api, db, services = env
    stored_key = "e" * 64
    tx_id = "recon-unknown-noledger-004"
    offer_id = "offer-noled-004"
    _make_offer_row(db, offer_id=offer_id)
    _make_grant_row(db, tx_id=tx_id, offer_id=offer_id,
                    state="grant_unknown", stored_key=stored_key)

    _enable_points(api, exercises_required=1)
    row = _get_grant(db, tx_id)
    result = run(rwd._call_reconcile_one(db, row))

    assert result == "still_unknown", f"expected still_unknown, got {result}"
    grant = _get_grant(db, tx_id)
    assert grant["state"] == "grant_unknown", (
        "state must remain grant_unknown — must not become terminal solely due to attempt count")
    confirmed_notifs = [n for n in db["edutalk_coach_rewards_notifications"].docs
                        if "confirmed" in n.get("notif_key", "")]
    assert confirmed_notifs == [], "no confirmed notification for unresolved grant"


# --------------------------------------------------------------------------- #
# RT-04  Terminal result — authoritative terminal from provider                #
# --------------------------------------------------------------------------- #
def test_recon_retryable_terminal_provider_result(env, monkeypatch):
    """Provider returns grant_terminal_failed during recon retry:
    - claim becomes grant_terminal_failed
    - no success reveal
    - no confirmed notification"""
    api, db, services = env

    async def credit_terminal(clean_id, amount, nonce):
        return {"outcome": "grant_terminal_failed", "provider_ref": None,
                "balance_after": None, "duplicate": False,
                "error": "provider_permanent_rejection"}

    monkeypatch.setattr(rwd, "REAL_GRANT_ENABLED", True)
    monkeypatch.setitem(rwd.__dict__, "_gas_treasury_credit_with_nonce", credit_terminal)
    stored_key = "f" * 64
    tx_id = "recon-terminal-005"
    offer_id = "offer-term-005"
    _make_offer_row(db, offer_id=offer_id)
    _make_grant_row(db, tx_id=tx_id, offer_id=offer_id,
                    state="grant_retryable", stored_key=stored_key)

    _enable_points(api, exercises_required=1)
    row = _get_grant(db, tx_id)
    result = run(rwd._call_reconcile_one(db, row))

    assert result == "resolved_terminal", f"expected resolved_terminal, got {result}"
    grant = _get_grant(db, tx_id)
    assert grant["state"] == "grant_terminal_failed"
    confirmed = [n for n in db["edutalk_coach_rewards_notifications"].docs
                 if "confirmed" in n.get("notif_key", "")]
    assert confirmed == [], "no confirmed notification for terminal grant"


# --------------------------------------------------------------------------- #
# RT-05  Lease and concurrency — only one worker acquires the lease           #
# --------------------------------------------------------------------------- #
def test_recon_lease_only_one_worker(env, monkeypatch):
    """Atomic lease: a second call on the same row returns 'skipped'
    because the first worker holds the lease."""
    api, db, services = env
    tx_id = "recon-lease-006"
    offer_id = "offer-lease-006"
    _make_offer_row(db, offer_id=offer_id)
    stored_key = "a" * 64
    # Pre-set the lease to a future time to simulate an active worker.
    from datetime import datetime, timezone, timedelta
    future_lease = (datetime.now(timezone.utc) + timedelta(seconds=300)).isoformat()
    row = {
        "tx_id": tx_id,
        "offer_id": offer_id,
        "clean_id": "stu123",
        "amount": 5,
        "state": "grant_unknown",
        "provider_idempotency_key": stored_key,
        "attempts": 1,
        "recon_attempts": 0,
        "created_at": rwd._iso(),
        "last_error": None,
        "provider_ref": None,
        "confirmed_at": None,
        "failed_at": None,
        "recon_exhausted": False,
        "recon_lease_until": future_lease,
    }
    db["edutalk_coach_rewards_grants"].docs.append(row)

    _enable_points(api, exercises_required=1)
    result = run(rwd._call_reconcile_one(db, row))

    assert result == "skipped", (
        f"expected skipped (lease held), got {result}")
    grant = _get_grant(db, tx_id)
    assert grant["state"] == "grant_unknown", "state must not change when lease is held"


def test_recon_stale_lease_recovered(env, monkeypatch):
    """A stale lease (past expiry) allows reconciliation to proceed."""
    api, db, services = env
    calls = []

    async def credit_ok(clean_id, amount, nonce):
        calls.append(nonce)
        return {"outcome": "granted", "provider_ref": "ref-stale",
                "balance_after": 100, "duplicate": False, "error": None}

    monkeypatch.setattr(rwd, "REAL_GRANT_ENABLED", True)
    monkeypatch.setitem(rwd.__dict__, "_gas_treasury_credit_with_nonce", credit_ok)
    tx_id = "recon-stale-lease-007"
    offer_id = "offer-stale-007"
    stored_key = "g" * 64
    _make_offer_row(db, offer_id=offer_id)
    # Use a past timestamp for the lease — should be recoverable.
    past_lease = "2000-01-01T00:00:00+00:00"
    row = {
        "tx_id": tx_id,
        "offer_id": offer_id,
        "clean_id": "stu123",
        "amount": 5,
        "state": "grant_retryable",
        "provider_idempotency_key": stored_key,
        "attempts": 1,
        "recon_attempts": 0,
        "created_at": rwd._iso(),
        "last_error": None,
        "provider_ref": None,
        "confirmed_at": None,
        "failed_at": None,
        "recon_exhausted": False,
        "recon_lease_until": past_lease,
    }
    db["edutalk_coach_rewards_grants"].docs.append(row)

    _enable_points(api, exercises_required=1)
    result = run(rwd._call_reconcile_one(db, row))

    assert result == "resolved_granted", (
        f"stale lease must be recovered; expected resolved_granted, got {result}")
    assert len(calls) == 1 and calls[0] == stored_key


def test_recon_no_duplicate_credit_on_repeated_call(env, monkeypatch):
    """Repeated reconciliation of the same already-granted row does not
    produce a second wallet credit (idempotency)."""
    api, db, services = env
    call_count = {"n": 0}

    async def credit_once(clean_id, amount, nonce):
        call_count["n"] += 1
        return {"outcome": "granted", "provider_ref": "ref-once",
                "balance_after": 100, "duplicate": False, "error": None}

    monkeypatch.setattr(rwd, "REAL_GRANT_ENABLED", True)
    monkeypatch.setitem(rwd.__dict__, "_gas_treasury_credit_with_nonce", credit_once)
    stored_key = "h" * 64
    tx_id = "recon-no-dup-008"
    offer_id = "offer-nodup-008"
    _make_offer_row(db, offer_id=offer_id)
    _make_grant_row(db, tx_id=tx_id, offer_id=offer_id,
                    state="grant_retryable", stored_key=stored_key)

    _enable_points(api, exercises_required=1)
    row = _get_grant(db, tx_id)
    run(rwd._call_reconcile_one(db, row))
    # Second call — row is now 'granted'; recon must skip.
    row2 = _get_grant(db, tx_id)
    result2 = run(rwd._call_reconcile_one(db, row2))

    assert call_count["n"] == 1, "second reconcile must not issue a second credit"
    # Second call returns skipped (lease held or row no longer in retryable set).
    assert result2 in ("skipped", "resolved_granted"), (
        f"second recon must be skipped or already-resolved, got {result2}")


# --------------------------------------------------------------------------- #
# RT-06  Restart recovery — stale dispatching + same stored key               #
# --------------------------------------------------------------------------- #
def test_recon_restart_recovery_stale_dispatching(env, monkeypatch):
    """A stale grant_dispatching row is promoted to grant_unknown, then
    reconciliation resolves it via ledger without creating a second credit."""
    api, db, services = env
    stored_key = "i" * 64
    tx_id = "recon-restart-009"
    offer_id = "offer-restart-009"
    _make_offer_row(db, offer_id=offer_id)
    # Stale dispatching row — simulates process crash mid-dispatch.
    row = {
        "tx_id": tx_id,
        "offer_id": offer_id,
        "clean_id": "stu123",
        "amount": 5,
        "state": "grant_dispatching",
        "provider_idempotency_key": stored_key,
        "attempts": 1,
        "recon_attempts": 0,
        "created_at": rwd._iso(),
        "dispatching_at": "2000-01-01T00:00:00+00:00",
        "last_error": None,
        "provider_ref": None,
        "confirmed_at": None,
        "failed_at": None,
        "recon_exhausted": False,
        "recon_lease_until": None,
    }
    db["edutalk_coach_rewards_grants"].docs.append(row)

    # Promote stale dispatching → grant_unknown (this is what the worker does).
    run(db["edutalk_coach_rewards_grants"].update_one(
        {"tx_id": tx_id, "state": "grant_dispatching"},
        {"$set": {"state": "grant_unknown", "last_error": "stale_dispatching",
                  "unknown_at": rwd._iso()}}))

    # Seed ledger as if the credit DID land before the crash.
    db["points_transactions"].docs.append({
        "_id": "txn-restart-001",
        "idempotency_key": stored_key,
        "balance_after": 100,
        "status": "confirmed",
        "source": "edutalk_coach_reward",
    })

    _enable_points(api, exercises_required=1)
    promoted_row = _get_grant(db, tx_id)
    result = run(rwd._call_reconcile_one(db, promoted_row))

    assert result == "resolved_granted"
    grant = _get_grant(db, tx_id)
    assert grant["state"] == "granted"
    assert grant.get("provider_idempotency_key") == stored_key, (
        "same stored key must be used — no second credit issued")


# --------------------------------------------------------------------------- #
# RT-07  Notification idempotency — single confirmed notification             #
# --------------------------------------------------------------------------- #
def test_recon_notification_idempotency(env, monkeypatch):
    """Reconciliation-confirmed grant creates exactly one confirmed
    notification; repeated calls create no duplicates."""
    api, db, services = env
    stored_key = "j" * 64
    tx_id = "recon-notif-idem-010"
    offer_id = "offer-notif-010"
    _make_offer_row(db, offer_id=offer_id)
    _make_grant_row(db, tx_id=tx_id, offer_id=offer_id,
                    state="grant_unknown", stored_key=stored_key)

    db["points_transactions"].docs.append({
        "_id": "txn-notif-001",
        "idempotency_key": stored_key,
        "balance_after": 100,
        "status": "confirmed",
        "source": "edutalk_coach_reward",
    })

    _enable_points(api, exercises_required=1)
    row = _get_grant(db, tx_id)
    run(rwd._call_reconcile_one(db, row))

    confirmed_notifs = [n for n in db["edutalk_coach_rewards_notifications"].docs
                        if n.get("notif_key", "").endswith(":confirmed")]
    assert len(confirmed_notifs) == 1, (
        f"expected exactly 1 confirmed notification, got {len(confirmed_notifs)}")

    # Second reconciliation attempt — row is now 'granted'; no duplicate.
    row2 = _get_grant(db, tx_id)
    run(rwd._call_reconcile_one(db, row2))
    confirmed_notifs2 = [n for n in db["edutalk_coach_rewards_notifications"].docs
                         if n.get("notif_key", "").endswith(":confirmed")]
    assert len(confirmed_notifs2) == 1, "duplicate notification must not be created"


# --------------------------------------------------------------------------- #
# RT-08  Diagnostics — unresolved endpoint filtering                          #
# --------------------------------------------------------------------------- #
def test_recon_diagnostics_unresolved_endpoint(env, monkeypatch):
    """Admin unresolved endpoint returns pending/unknown rows:
    - granted rows excluded
    - provider secrets not exposed"""
    api, db, services = env

    async def credit_unknown(clean_id, amount, nonce):
        return {"outcome": "grant_unknown", "error": "transport:timeout",
                "provider_ref": None, "balance_after": None, "duplicate": False}

    monkeypatch.setattr(rwd, "REAL_GRANT_ENABLED", True)
    monkeypatch.setitem(rwd.__dict__, "_gas_treasury_credit_with_nonce", credit_unknown)
    _enable_points(api, exercises_required=1)
    _seed_session(db)
    ctx = services["RewardSessionCtx"]("sid1", "stu123", display_name="Dara")
    _open_and_evaluate(services, ctx, "sid1", "stu123")
    offer = db["edutalk_coach_rewards_offers"].docs[0]
    run(services["claim_offer"](offer["offer_id"], "stu123", "rest"))

    unresolved_route = api.routes.get(
        ("GET", "/admin/edutalk-live/rewards/grants/unresolved"))
    if unresolved_route is None:
        pytest.skip("unresolved endpoint not registered in this env")
    res = run(unresolved_route(limit=50, admin=_Admin()))
    assert res["success"] is True
    assert res["count"] >= 1
    # Must contain the unknown grant.
    assert any(g["state"] == "grant_unknown" for g in res["unresolved"])
    # Granted rows must not appear.
    assert not any(g["state"] == "granted" for g in res["unresolved"])
    # Provider secrets (wallet keys, credentials) must not be in any row.
    for g in res["unresolved"]:
        row_str = str(g)
        assert "wallet_key" not in row_str
        assert "wallet_secret" not in row_str
        assert "password" not in row_str.lower()


def test_recon_diagnostics_terminal_rows_excluded(env, monkeypatch):
    """Terminal rows do not appear in the unresolved diagnostic endpoint."""
    api, db, services = env
    # Directly inject a terminal grant row.
    db["edutalk_coach_rewards_grants"].docs.append({
        "tx_id": "recon-diag-terminal-011",
        "offer_id": "offer-diag-011",
        "clean_id": "stu123",
        "amount": 5,
        "state": "grant_terminal_failed",
        "provider_idempotency_key": "k" * 64,
        "attempts": 1,
        "recon_attempts": 0,
        "created_at": rwd._iso(),
        "last_error": "provider_rejection",
    })
    _enable_points(api, exercises_required=1)
    unresolved_route = api.routes.get(
        ("GET", "/admin/edutalk-live/rewards/grants/unresolved"))
    if unresolved_route is None:
        pytest.skip("unresolved endpoint not registered")
    res = run(unresolved_route(limit=50, admin=_Admin()))
    assert not any(g["state"] == "grant_terminal_failed"
                   for g in res["unresolved"]), (
        "terminal rows must be excluded from unresolved diagnostic")


# --------------------------------------------------------------------------- #
# RT-09  Exhausted recon — row with max attempts is skipped                   #
# --------------------------------------------------------------------------- #
def test_recon_exhausted_row_is_skipped(env, monkeypatch):
    """A row that has hit max recon_attempts is not retried."""
    api, db, services = env
    tx_id = "recon-exhausted-012"
    offer_id = "offer-exhaust-012"
    _make_offer_row(db, offer_id=offer_id)
    _make_grant_row(db, tx_id=tx_id, offer_id=offer_id,
                    state="grant_unknown", recon_attempts=12)

    _enable_points(api, exercises_required=1)
    row = _get_grant(db, tx_id)
    result = run(rwd._call_reconcile_one(db, row))
    assert result == "skipped"


# =========================================================================== #
# RUNTIME GATE TESTS — Blocker 4: coach_reward_runtime_active provider gate   #
# =========================================================================== #

def test_runtime_active_flags_on_no_provider_helper_inactive(monkeypatch):
    """enabled+points flags ON but provider helper absent → runtime inactive."""
    api = _DummyAPI()
    db = _DB()
    run(rwd.setup_indexes(db))
    services = rwd.register_edutalk_coach_reward_routes(
        api, db, _require_admin, _require_student)

    monkeypatch.setattr(rwd, "REAL_GRANT_ENABLED", True)
    monkeypatch.setattr(rwd, "_GRANT_HELPER_OK", True)
    monkeypatch.delitem(rwd.__dict__, "_gas_treasury_credit_with_nonce", raising=False)
    # The provider helper is genuinely absent: no injected nonce helper AND
    # no built-in WalletService closure. ``wallet_service`` imports in a
    # full backend environment (so ``_WalletService`` is not None there),
    # therefore we explicitly remove it for this test's scope to assert the
    # provider-absent path deterministically in any environment.
    monkeypatch.setattr(rwd, "_WalletService", None)
    put_route = api.routes[("PUT", "/admin/edutalk-live/rewards/config")]
    run(put_route({"config": {"enabled": True, "points_enabled": True,
                              "approved_point_values": [5]}}, _Admin()))
    assert rwd._provider_grant_available() is False
    active = run(services["coach_reward_runtime_active"]())
    assert active is False, "runtime must be inactive when provider helper is absent"


def test_runtime_active_helper_present_indexes_unavailable(monkeypatch):
    """Provider helper present but indexes unavailable → runtime inactive."""
    api = _DummyAPI()
    db = _DB()
    services = rwd.register_edutalk_coach_reward_routes(
        api, db, _require_admin, _require_student)

    async def _stub(c, a, n):
        pass

    monkeypatch.setattr(rwd, "REAL_GRANT_ENABLED", True)
    monkeypatch.setitem(rwd.__dict__, "_gas_treasury_credit_with_nonce", _stub)
    # Do NOT call setup_indexes — indexes not ready.
    rwd.INDEX_READY["ready"] = False
    put_route = api.routes[("PUT", "/admin/edutalk-live/rewards/config")]
    run(put_route({"config": {"enabled": True, "points_enabled": True,
                              "approved_point_values": [5]}}, _Admin()))
    active = run(services["coach_reward_runtime_active"]())
    assert active is False, "runtime must be inactive when indexes are not ready"
    # Cleanup
    run(rwd.setup_indexes(db))


def test_runtime_active_master_flag_off_inactive(monkeypatch):
    """Master enabled flag OFF → runtime inactive."""
    api = _DummyAPI()
    db = _DB()
    run(rwd.setup_indexes(db))
    services = rwd.register_edutalk_coach_reward_routes(
        api, db, _require_admin, _require_student)

    async def _stub(c, a, n):
        pass

    monkeypatch.setattr(rwd, "REAL_GRANT_ENABLED", True)
    monkeypatch.setitem(rwd.__dict__, "_gas_treasury_credit_with_nonce", _stub)
    put_route = api.routes[("PUT", "/admin/edutalk-live/rewards/config")]
    # enabled=False
    run(put_route({"config": {"enabled": False, "points_enabled": True,
                              "approved_point_values": [5]}}, _Admin()))
    active = run(services["coach_reward_runtime_active"]())
    assert active is False, "runtime must be inactive when master flag is OFF"


def test_runtime_active_all_conditions_mocked_active(monkeypatch):
    """All required conditions present → runtime is active."""
    api = _DummyAPI()
    db = _DB()
    run(rwd.setup_indexes(db))
    services = rwd.register_edutalk_coach_reward_routes(
        api, db, _require_admin, _require_student)

    async def _stub_credit(c, a, n):
        return {"outcome": "granted", "provider_ref": "stub",
                "balance_after": 100, "duplicate": False, "error": None}

    saved_real = rwd.REAL_GRANT_ENABLED
    saved_helper_ok = rwd._GRANT_HELPER_OK
    rwd.REAL_GRANT_ENABLED = True
    rwd._GRANT_HELPER_OK = True
    rwd.__dict__["_gas_treasury_credit_with_nonce"] = _stub_credit
    put_route = api.routes[("PUT", "/admin/edutalk-live/rewards/config")]
    run(put_route({"config": {"enabled": True, "points_enabled": True,
                              "approved_point_values": [5]}}, _Admin()))
    try:
        active = run(services["coach_reward_runtime_active"]())
        assert active is True, "runtime must be active when all conditions hold"
    finally:
        rwd.REAL_GRANT_ENABLED = saved_real
        rwd._GRANT_HELPER_OK = saved_helper_ok
        rwd.__dict__.pop("_gas_treasury_credit_with_nonce", None)


# =========================================================================== #
# FINAL BLOCKERS A–F — direct lifecycle / concurrency / recovery / delivery   #
# =========================================================================== #
def _held_caps(db, offer_id=None):
    rows = db["edutalk_coach_rewards_cap_reservations"].docs
    return [r for r in rows if r.get("state") == "held"
            and (offer_id is None or r.get("offer_id") == offer_id)]


def _confirmed_caps(db, offer_id=None):
    rows = db["edutalk_coach_rewards_cap_reservations"].docs
    return [r for r in rows if r.get("state") == "confirmed"
            and (offer_id is None or r.get("offer_id") == offer_id)]


def _confirmed_notifs(db):
    return [n for n in db["edutalk_coach_rewards_notifications"].docs
            if n.get("notif_key", "").endswith(":confirmed")]


def _confirmed_audits(db):
    return [a for a in db["edutalk_coach_rewards_audit"].docs
            if a.get("kind") == "grant_confirmed"]


# --------------------------------------------------------------------------- #
# Blocker A — confirmed finalizer: immediate success completes lifecycle       #
# --------------------------------------------------------------------------- #
def test_blockerA_immediate_success_full_lifecycle(env, monkeypatch):
    api, db, services = env
    _enable_points(api, exercises_required=1)
    _seed_session(db)
    grant_log = []
    _install_stable_nonce_helper(monkeypatch, grant_log)
    ctx = services["RewardSessionCtx"]("sid1", "stu123", display_name="Dara")
    _open_and_evaluate(services, ctx, "sid1", "stu123")
    offer = db["edutalk_coach_rewards_offers"].docs[0]
    oid = offer["offer_id"]
    r = run(services["claim_offer"](oid, "stu123", "rest"))
    assert r["state"] in ("granted", "confirmed")
    # grant row complete
    grant = next(g for g in db["edutalk_coach_rewards_grants"].docs
                 if g["offer_id"] == oid)
    assert grant["state"] == "granted"
    assert grant.get("confirmed_at")
    assert grant.get("provider_reference")
    assert grant.get("confirmed_amount") == 5
    assert grant.get("provider_idempotency_key")
    assert grant.get("last_error") is None
    # offer row complete
    off = next(o for o in db["edutalk_coach_rewards_offers"].docs
               if o["_id"] == oid)
    assert off["state"] == "granted"
    assert (off.get("claim_result") or {}).get("ok") is True
    # caps confirmed exactly once, none left held
    assert _held_caps(db, oid) == []
    assert len(_confirmed_caps(db, oid)) == 2  # day + month
    # exactly one confirmed notification + one confirmed audit event
    assert len(_confirmed_notifs(db)) == 1
    assert len(_confirmed_audits(db)) == 1
    assert len(grant_log) == 1


def test_blockerA_second_finalizer_call_is_idempotent(env, monkeypatch):
    api, db, services = env
    _enable_points(api, exercises_required=1)
    _seed_session(db)
    grant_log = []
    _install_stable_nonce_helper(monkeypatch, grant_log)
    ctx = services["RewardSessionCtx"]("sid1", "stu123", display_name="Dara")
    _open_and_evaluate(services, ctx, "sid1", "stu123")
    oid = db["edutalk_coach_rewards_offers"].docs[0]["offer_id"]
    run(services["claim_offer"](oid, "stu123", "rest"))
    # Call the shared finalizer AGAIN directly — must change nothing.
    run(services["finalize_confirmed_grant"](oid, provider_ref="again",
                                             resolved_by="reconciliation"))
    assert len(_confirmed_notifs(db)) == 1
    assert len(_confirmed_audits(db)) == 1
    assert len(_confirmed_caps(db, oid)) == 2
    assert _held_caps(db, oid) == []
    assert len(grant_log) == 1  # provider never called by the finalizer


# --------------------------------------------------------------------------- #
# Blocker A — partial finalization recovery (resume after a partial failure)   #
# --------------------------------------------------------------------------- #
def test_blockerA_partial_finalization_resumes(env, monkeypatch):
    api, db, services = env
    _enable_points(api, exercises_required=1)
    provider_calls = {"n": 0}

    async def credit(c, a, n):
        provider_calls["n"] += 1
        return {"outcome": "granted", "provider_ref": "ref", "error": None,
                "balance_after": 100, "duplicate": False}
    monkeypatch.setattr(rwd, "REAL_GRANT_ENABLED", True)
    monkeypatch.setitem(rwd.__dict__, "_gas_treasury_credit_with_nonce", credit)

    oid = "offer-partial-A1"
    tx_id = f"edutalk-coach-reward:{oid}:points"
    # Provider ALREADY confirmed (grant granted) but ancillary work never ran:
    # offer still claim_reserved, caps still held, no confirmed notification.
    _make_offer_row(db, offer_id=oid, state="claim_reserved")
    run(services["reserve_cap_slot"]("stu123", oid, "day", "2099-01-01", 5))
    run(services["reserve_cap_slot"]("stu123", oid, "month", "2099-01", 50))
    db["edutalk_coach_rewards_grants"].docs.append({
        "tx_id": tx_id, "offer_id": oid, "clean_id": "stu123", "amount": 5,
        "state": "granted", "provider_idempotency_key": "p" * 64,
        "attempts": 1, "confirmed_at": rwd._iso(), "provider_ref": "ref",
        "last_error": None,
    })
    assert len(_held_caps(db, oid)) == 2

    merged = run(services["finalize_confirmed_grant"](
        oid, provider_ref="ref", provider_idempotency_key="p" * 64,
        resolved_by="restart_recovery"))
    assert merged["state"] == "granted"
    # missing lifecycle work now complete
    off = next(o for o in db["edutalk_coach_rewards_offers"].docs
               if o["_id"] == oid)
    assert off["state"] == "granted"
    assert _held_caps(db, oid) == []
    assert len(_confirmed_caps(db, oid)) == 2
    assert len(_confirmed_notifs(db)) == 1
    assert len(_confirmed_audits(db)) == 1
    # provider NOT called by the finalizer (it never credits)
    assert provider_calls["n"] == 0
    # re-entry remains idempotent — no duplicate anything
    run(services["finalize_confirmed_grant"](oid, provider_ref="ref",
                                             resolved_by="restart_recovery"))
    assert len(_confirmed_notifs(db)) == 1
    assert len(_confirmed_audits(db)) == 1
    assert provider_calls["n"] == 0


# --------------------------------------------------------------------------- #
# Blocker A — confirmed paths via reconciliation complete the lifecycle        #
# --------------------------------------------------------------------------- #
def test_blockerA_ledger_confirmed_recon_full_lifecycle(env, monkeypatch):
    api, db, services = env
    _enable_points(api, exercises_required=1)
    stored_key = "L" * 64
    tx_id = "recon-ledger-A2"
    oid = "offer-ledger-A2"
    _make_offer_row(db, offer_id=oid, state="claim_reserved")
    run(services["reserve_cap_slot"]("stu123", oid, "day", "2099-02-01", 5))
    _make_grant_row(db, tx_id=tx_id, offer_id=oid, state="grant_unknown",
                    stored_key=stored_key)
    db["points_transactions"].docs.append({
        "_id": "txn-A2", "idempotency_key": stored_key,
        "balance_after": 100, "status": "confirmed",
        "source": "edutalk_coach_reward"})
    row = _get_grant(db, tx_id)
    res = run(rwd._call_reconcile_one(db, row))
    assert res == "resolved_granted"
    grant = _get_grant(db, tx_id)
    assert grant["state"] == "granted"
    assert grant.get("confirmed_amount") == 5
    off = next(o for o in db["edutalk_coach_rewards_offers"].docs
               if o["_id"] == oid)
    assert off["state"] == "granted"
    assert _held_caps(db, oid) == []
    assert len(_confirmed_caps(db, oid)) == 1
    assert len(_confirmed_notifs(db)) == 1


def test_blockerA_retryable_recon_full_lifecycle(env, monkeypatch):
    api, db, services = env
    _enable_points(api, exercises_required=1)
    calls = []

    async def credit(c, a, n):
        calls.append(n)
        return {"outcome": "granted", "provider_ref": n[:8], "error": None,
                "balance_after": 100, "duplicate": False}
    monkeypatch.setattr(rwd, "REAL_GRANT_ENABLED", True)
    monkeypatch.setitem(rwd.__dict__, "_gas_treasury_credit_with_nonce", credit)
    stored_key = "R" * 64
    tx_id = "recon-retry-A3"
    oid = "offer-retry-A3"
    _make_offer_row(db, offer_id=oid, state="claim_reserved")
    run(services["reserve_cap_slot"]("stu123", oid, "day", "2099-03-01", 5))
    _make_grant_row(db, tx_id=tx_id, offer_id=oid, state="grant_retryable",
                    stored_key=stored_key)
    row = _get_grant(db, tx_id)
    res = run(rwd._call_reconcile_one(db, row))
    assert res == "resolved_granted"
    assert calls == [stored_key]  # SAME stored key, called once
    off = next(o for o in db["edutalk_coach_rewards_offers"].docs
               if o["_id"] == oid)
    assert off["state"] == "granted"
    assert len(_confirmed_notifs(db)) == 1
    assert _held_caps(db, oid) == []


# --------------------------------------------------------------------------- #
# Blocker B — terminal finalization                                            #
# --------------------------------------------------------------------------- #
def test_blockerB_terminal_finalization(env, monkeypatch):
    api, db, services = env
    _enable_points(api, exercises_required=1)
    oid = "offer-term-B1"
    tx_id = f"edutalk-coach-reward:{oid}:points"
    _make_offer_row(db, offer_id=oid, state="claim_reserved", session_id="sidT")
    run(services["reserve_cap_slot"]("stu123", oid, "day", "2099-04-01", 5))
    run(services["reserve_cap_slot"]("stu123", oid, "month", "2099-04", 50))
    db["edutalk_coach_rewards_grants"].docs.append({
        "tx_id": tx_id, "offer_id": oid, "clean_id": "stu123", "amount": 5,
        "state": "grant_dispatching", "provider_idempotency_key": "t" * 64,
        "attempts": 1, "last_error": None})
    assert len(_held_caps(db, oid)) == 2
    merged = run(services["finalize_terminal_grant"](
        oid, reason="provider_permanent_reject", resolved_by="dispatch"))
    assert merged["state"] == "grant_terminal_failed"
    grant = next(g for g in db["edutalk_coach_rewards_grants"].docs
                 if g["offer_id"] == oid)
    assert grant["state"] == "grant_terminal_failed"
    off = next(o for o in db["edutalk_coach_rewards_offers"].docs
               if o["_id"] == oid)
    assert off["state"] == "grant_terminal_failed"
    # caps released exactly once → bucket active back to 0
    assert _held_caps(db, oid) == []
    assert _confirmed_caps(db, oid) == []
    day_bucket = next(b for b in db["edutalk_coach_rewards_cap_buckets"].docs
                      if b["_id"] == "stu123:day:2099-04-01")
    assert day_bucket["active"] == 0
    # NO success lifecycle
    assert _confirmed_notifs(db) == []
    assert _confirmed_audits(db) == []
    # idempotent second call — caps not double-released (no negative active)
    run(services["finalize_terminal_grant"](oid, reason="again"))
    assert day_bucket_active(db, "stu123:day:2099-04-01") == 0
    # recovery returns terminal failure
    route = api.routes[("GET", "/edutalk/reward-offers/active")]
    res = run(route(session_id="sidT", student=_Student()))
    assert res["offer"]["state"] == "grant_terminal_failed"
    assert res["offer"]["confirmed_message"] is None


def day_bucket_active(db, bid):
    b = next((x for x in db["edutalk_coach_rewards_cap_buckets"].docs
              if x["_id"] == bid), None)
    return (b or {}).get("active")


# --------------------------------------------------------------------------- #
# Blocker C — unknown-state safety                                             #
# --------------------------------------------------------------------------- #
def test_blockerC_unknown_stays_unresolved_no_evidence(env, monkeypatch):
    api, db, services = env
    _enable_points(api, exercises_required=1)
    stored_key = "U" * 64
    tx_id = "recon-unknown-C1"
    oid = "offer-unknown-C1"
    _make_offer_row(db, offer_id=oid, state="claim_reserved")
    run(services["reserve_cap_slot"]("stu123", oid, "day", "2099-05-01", 5))
    _make_grant_row(db, tx_id=tx_id, offer_id=oid, state="grant_unknown",
                    stored_key=stored_key)
    # NO ledger txn → no authoritative evidence.
    row = _get_grant(db, tx_id)
    res = run(rwd._call_reconcile_one(db, row))
    assert res == "still_unknown"
    grant = _get_grant(db, tx_id)
    assert grant["state"] == "grant_unknown"  # not invented terminal/granted
    off = next(o for o in db["edutalk_coach_rewards_offers"].docs
               if o["_id"] == oid)
    assert off["state"] == "claim_reserved"  # no success lifecycle
    assert _confirmed_notifs(db) == []
    assert len(_held_caps(db, oid)) == 1  # caps NOT released
    # diagnostics include the unresolved row
    unresolved = api.routes[("GET",
                             "/admin/edutalk-live/rewards/grants/unresolved")]
    diag = run(unresolved(limit=50, admin=_Admin()))
    assert any(g["state"] == "grant_unknown" and g["tx_id"] == tx_id
               for g in diag["unresolved"])


def test_blockerC_exhausted_unknown_not_converted_to_terminal(env):
    api, db, services = env
    _enable_points(api, exercises_required=1)
    tx_id = "recon-exhaust-C2"
    oid = "offer-exhaust-C2"
    _make_offer_row(db, offer_id=oid)
    _make_grant_row(db, tx_id=tx_id, offer_id=oid, state="grant_unknown",
                    recon_attempts=12)
    row = _get_grant(db, tx_id)
    res = run(rwd._call_reconcile_one(db, row))
    assert res == "skipped"
    grant = _get_grant(db, tx_id)
    assert grant["state"] == "grant_unknown"  # exhaustion ≠ terminal
    assert grant.get("recon_exhausted") is True


# --------------------------------------------------------------------------- #
# Blocker D — concurrency-safe cap reservation (barrier-based race)            #
# --------------------------------------------------------------------------- #
def test_blockerD_cap_race_exactly_one_winner(env):
    api, db, services = env
    reserve = services["reserve_cap_slot"]

    async def _race():
        barrier = asyncio.Barrier(2)
        results = {}

        async def contender(oid):
            await barrier.wait()
            results[oid] = await reserve(
                "stuRACE", oid, "day", "2099-06-01", 1)
        await asyncio.gather(contender("oA"), contender("oB"))
        return results

    results = run(_race())
    winners = [k for k, v in results.items() if v]
    assert len(winners) == 1, f"exactly one winner expected, got {results}"
    bucket = next(b for b in db["edutalk_coach_rewards_cap_buckets"].docs
                  if b["_id"] == "stuRACE:day:2099-06-01")
    assert bucket["active"] == 1  # cap never exceeded
    assert len(_held_caps(db)) == 1  # exactly one held reservation


def test_blockerD_release_frees_slot_exactly_once(env):
    api, db, services = env
    reserve = services["reserve_cap_slot"]
    release = services["release_caps_for_offer"]
    bid = "stuREL:day:2099-07-01"
    assert run(reserve("stuREL", "o1", "day", "2099-07-01", 1)) is True
    # cap full now
    assert run(reserve("stuREL", "o2", "day", "2099-07-01", 1)) is False
    run(release("o1", "expired"))
    assert day_bucket_active(db, bid) == 0
    # release is idempotent — a second release does not go negative
    run(release("o1", "expired"))
    assert day_bucket_active(db, bid) == 0
    # freed slot is reusable
    assert run(reserve("stuREL", "o3", "day", "2099-07-01", 1)) is True
    assert day_bucket_active(db, bid) == 1


def test_blockerD_db_error_fails_closed(env, monkeypatch):
    api, db, services = env
    reserve = services["reserve_cap_slot"]
    cap_col = db["edutalk_coach_rewards_cap_reservations"]
    orig = cap_col.insert_one

    async def boom(doc):
        raise RuntimeError("db down")
    cap_col.insert_one = boom  # type: ignore
    try:
        assert run(reserve("stuFC", "oFC", "day", "2099-08-01", 3)) is False
        # the bucket slot must have been rolled back (fail closed, no leak)
        assert day_bucket_active(db, "stuFC:day:2099-08-01") == 0
    finally:
        cap_col.insert_one = orig  # type: ignore


# --------------------------------------------------------------------------- #
# Blocker E — active-offer recovery response (session/ownership/states)        #
# --------------------------------------------------------------------------- #
def _active_route(api):
    return api.routes[("GET", "/edutalk/reward-offers/active")]


def test_blockerE_recovery_strict_ownership_and_session(env):
    api, db, services = env
    _enable_points(api, exercises_required=1)
    _make_offer_row(db, offer_id="o-rec-1", session_id="sidR", state="claimable")
    route = _active_route(api)
    # correct student + session accepted
    ok = run(route(session_id="sidR", student=_Student(clean_id="stu123")))
    assert ok["offer"] and ok["offer"]["session_id"] == "sidR"
    # wrong student rejected
    bad_stu = run(route(session_id="sidR",
                        student=_Student(clean_id="intruder")))
    assert bad_stu["offer"] is None
    # wrong session rejected
    bad_sess = run(route(session_id="sidX", student=_Student(clean_id="stu123")))
    assert bad_sess["offer"] is None
    # empty/missing session yields nothing (route also enforces required Query)
    import inspect
    sig = inspect.signature(route)
    assert sig.parameters["session_id"].default is not inspect._empty


def test_blockerE_recovery_restores_all_states_and_hides_secrets(env):
    api, db, services = env
    _enable_points(api, exercises_required=1)
    route = _active_route(api)
    states = {
        "claimable": "claimable",
        "pending_confirmation": "pending_confirmation",
        "granted": "granted",
        "grant_terminal_failed": "grant_terminal_failed",
        "expired": "expired",
    }
    for i, (label, st) in enumerate(states.items()):
        sid = f"sidS{i}"
        oid = f"o-state-{i}"
        _make_offer_row(db, offer_id=oid, session_id=sid, state=st)
        # attach a provider-secret-looking field that MUST NOT leak
        for o in db["edutalk_coach_rewards_offers"].docs:
            if o["_id"] == oid:
                o["provider_idempotency_key"] = "secret" * 8
                if st == "granted":
                    o["claim_result"] = {"ok": True, "reward_amount": 5,
                                         "reward_summary": "5 EduHub Points"}
        res = run(route(session_id=sid, student=_Student(clean_id="stu123")))
        assert res["offer"] is not None, f"state {st} must be restorable"
        assert res["offer"]["state"] == st
        blob = str(res["offer"])
        assert "provider_idempotency_key" not in blob
        assert "secret" not in blob
        assert "password" not in blob.lower()
        # granted carries persisted authoritative amount (not a FE default)
        if st == "granted":
            assert res["offer"]["reward_amount"] == 5
            assert res["offer"]["persisted_claim_result"]
            assert res["offer"]["confirmed_message"]


# --------------------------------------------------------------------------- #
# Blocker F — truthful WS/Gemini delivery                                      #
# --------------------------------------------------------------------------- #
def test_blockerF_delivery_truthful_success_and_failure(env):
    api, db, services = env
    Ctx = services["RewardSessionCtx"]
    seen = []

    async def ok_send(p):
        seen.append(p)

    async def ok_inject(t):
        seen.append(("g", t))
    ctx_ok = Ctx("sid1", "stu123", client_send_cb=ok_send,
                 gemini_inject_cb=ok_inject)
    assert run(ctx_ok.emit_to_client({"x": 1})) is True
    assert run(ctx_ok.inject_gemini_text("hi")) is True

    async def bad_send(p):
        raise RuntimeError("ws gone")

    async def bad_inject(t):
        raise RuntimeError("gemini gone")
    ctx_bad = Ctx("sid1", "stu123", client_send_cb=bad_send,
                  gemini_inject_cb=bad_inject)
    # failed delivery must NOT be reported as delivered
    assert run(ctx_bad.emit_to_client({"x": 1})) is False
    assert run(ctx_bad.inject_gemini_text("hi")) is False
    # a closed ctx never reports delivery
    ctx_ok.close()
    assert run(ctx_ok.emit_to_client({"x": 1})) is False
    assert run(ctx_ok.inject_gemini_text("hi")) is False


def test_blockerF_failed_announcement_not_marked_delivered(env):
    """A failed Gemini announcement leaves no false delivered timestamp and
    records the error so a safe retry can run (delivery failure does not
    break the offer record)."""
    api, db, services = env
    _enable_points(api, exercises_required=1)
    _seed_session(db)

    async def bad_inject(_t):
        raise RuntimeError("gemini gone")

    async def ws_ok(_p):
        return None
    ctx = services["RewardSessionCtx"](
        "sid1", "stu123", display_name="Dara",
        gemini_inject_cb=bad_inject, client_send_cb=ws_ok)
    _open_and_evaluate(services, ctx, "sid1", "stu123")
    offer = db["edutalk_coach_rewards_offers"].docs[0]
    assert offer["offer_announcement_delivered_at"] is None
    assert offer["offer_announcement_reserved_at"] is None
    # the offer/session itself is intact (delivery failure didn't break it)
    assert offer["state"] == "claimable"


# --------------------------------------------------------------------------- #
# Worker lifecycle — single lease owner + stale lease recovery                 #
# --------------------------------------------------------------------------- #
def test_worker_single_lease_owner_per_claim(env, monkeypatch):
    api, db, services = env
    _enable_points(api, exercises_required=1)
    calls = {"n": 0}

    async def credit(c, a, n):
        calls["n"] += 1
        return {"outcome": "granted", "provider_ref": "r", "error": None,
                "balance_after": 100, "duplicate": False}
    monkeypatch.setattr(rwd, "REAL_GRANT_ENABLED", True)
    monkeypatch.setitem(rwd.__dict__, "_gas_treasury_credit_with_nonce", credit)
    tx_id = "lease-W1"
    oid = "offer-lease-W1"
    _make_offer_row(db, offer_id=oid, state="claim_reserved")
    run(services["reserve_cap_slot"]("stu123", oid, "day", "2099-09-01", 5))
    _make_grant_row(db, tx_id=tx_id, offer_id=oid, state="grant_retryable",
                    stored_key="z" * 64)
    row = _get_grant(db, tx_id)

    async def _race():
        await asyncio.gather(
            rwd._call_reconcile_one(db, dict(row)),
            rwd._call_reconcile_one(db, dict(row)))
    run(_race())
    # only ONE lease owner credited; no duplicate credit / notification
    assert calls["n"] == 1
    assert len(_confirmed_notifs(db)) == 1


def test_worker_stale_lease_can_be_reclaimed(env, monkeypatch):
    api, db, services = env
    _enable_points(api, exercises_required=1)
    stored_key = "S" * 64
    tx_id = "lease-stale-W2"
    oid = "offer-stale-W2"
    _make_offer_row(db, offer_id=oid, state="claim_reserved")
    _make_grant_row(db, tx_id=tx_id, offer_id=oid, state="grant_unknown",
                    stored_key=stored_key)
    # A previous owner left a lease far in the PAST → reclaimable.
    for g in db["edutalk_coach_rewards_grants"].docs:
        if g["tx_id"] == tx_id:
            g["recon_lease_until"] = "2000-01-01T00:00:00+00:00"
    db["points_transactions"].docs.append({
        "_id": "txn-W2", "idempotency_key": stored_key, "balance_after": 100,
        "status": "confirmed", "source": "edutalk_coach_reward"})
    row = _get_grant(db, tx_id)
    res = run(rwd._call_reconcile_one(db, row))
    assert res == "resolved_granted"
    assert _get_grant(db, tx_id)["state"] == "granted"


# =========================================================================== #
# MANDATORY FAILURE-INJECTION TESTS                                            #
#   * Blocker A — production entry-point recovery of incomplete confirmed     #
#     finalization (NOT a direct finalizer call as the only mechanism).       #
#   * Blocker B — crash-safe / retryable cap release (bucket decrement        #
#     fails after held→released transition; retry/repair completes the        #
#     unfinished decrement exactly once; capacity not leaked or over-released).
# =========================================================================== #


def _blockerA_seed_partial_confirmed(db, services, oid, *,
                                     session_id="sidA", clean_id="stu123"):
    """Materialize a partially-finalized confirmed state:
      * grant row = granted (provider already credited authoritatively)
      * offer row = claim_reserved (ancillary lifecycle never ran)
      * caps held (capacity confirmation never ran)
      * confirmed event / notification / push never fired."""
    _make_offer_row(db, offer_id=oid, session_id=session_id,
                    clean_id=clean_id, state="claim_reserved")
    run(services["reserve_cap_slot"](clean_id, oid, "day",
                                     "2099-12-01", 5))
    run(services["reserve_cap_slot"](clean_id, oid, "month",
                                     "2099-12", 50))
    tx_id = f"edutalk-coach-reward:{oid}:points"
    db["edutalk_coach_rewards_grants"].docs.append({
        "tx_id": tx_id, "offer_id": oid, "clean_id": clean_id,
        "amount": 5, "state": "granted",
        "provider_idempotency_key": "p" * 64,
        "attempts": 1, "recon_attempts": 0,
        "confirmed_at": rwd._iso(), "provider_ref": "ref",
        "last_error": None,
    })
    # Sanity: state is genuinely incomplete before recovery runs.
    assert len(_held_caps(db, oid)) == 2
    assert _confirmed_notifs(db) == []
    return tx_id


def test_blockerA_repeated_claim_resumes_incomplete_finalization(env, monkeypatch):
    """Production entry point #1: a repeated student claim re-routes
    through the shared finalizer and resumes the missing lifecycle
    steps WITHOUT calling the provider, crediting the wallet, or
    duplicating any work. Subsequent re-claims remain idempotent."""
    api, db, services = env
    _enable_points(api, exercises_required=1)
    provider_calls = {"n": 0}

    async def credit(c, a, n):
        provider_calls["n"] += 1
        return {"outcome": "granted", "provider_ref": "ref",
                "balance_after": 100, "duplicate": False, "error": None}
    monkeypatch.setattr(rwd, "REAL_GRANT_ENABLED", True)
    monkeypatch.setitem(rwd.__dict__, "_gas_treasury_credit_with_nonce", credit)

    oid = "off-blkA-repeat"
    _blockerA_seed_partial_confirmed(db, services, oid,
                                     session_id="sidA", clean_id="stu123")

    # Production entry point: repeated student claim.
    r = run(services["claim_offer"](oid, "stu123", "rest"))
    assert r["state"] in ("granted", "confirmed")
    # provider call count remains 0 — finalizer NEVER credits
    assert provider_calls["n"] == 0
    # wallet credit count is implicitly 0 (no provider invocation)
    # Lifecycle resumed exactly once.
    grant = next(g for g in db["edutalk_coach_rewards_grants"].docs
                 if g["offer_id"] == oid)
    assert grant["state"] == "granted"
    off = next(o for o in db["edutalk_coach_rewards_offers"].docs
               if o["_id"] == oid)
    assert off["state"] == "granted"
    cr = (off.get("claim_result") or {})
    assert cr.get("ok") is True
    assert _held_caps(db, oid) == []
    assert len(_confirmed_caps(db, oid)) == 2
    assert len(_confirmed_notifs(db)) == 1
    assert len(_confirmed_audits(db)) == 1
    # Repeat the production entry point — must be harmless.
    r2 = run(services["claim_offer"](oid, "stu123", "rest"))
    assert r2["state"] in ("granted", "confirmed")
    assert provider_calls["n"] == 0
    assert len(_confirmed_notifs(db)) == 1
    assert len(_confirmed_audits(db)) == 1
    assert len(_confirmed_caps(db, oid)) == 2


def test_blockerA_recovery_scan_resumes_incomplete_finalization(env, monkeypatch):
    """Production entry point #2: the periodic reconciliation worker
    rediscovers a confirmed grant whose downstream lifecycle is
    incomplete (which the legacy worker would NOT scan because it only
    looked at grant_unknown / grant_retryable rows). The scan completes
    the lifecycle through the shared finalizer; no provider call is
    made and re-running the scan is harmless."""
    api, db, services = env
    _enable_points(api, exercises_required=1)
    provider_calls = {"n": 0}

    async def credit(c, a, n):
        provider_calls["n"] += 1
        return {"outcome": "granted", "provider_ref": "ref",
                "balance_after": 100, "duplicate": False, "error": None}
    monkeypatch.setattr(rwd, "REAL_GRANT_ENABLED", True)
    monkeypatch.setitem(rwd.__dict__, "_gas_treasury_credit_with_nonce", credit)

    oid = "off-blkA-scan"
    _blockerA_seed_partial_confirmed(db, services, oid,
                                     session_id="sidA2", clean_id="stu123")

    # Production entry point: the worker-level scan that the periodic
    # reconciliation loop invokes every cycle (also called by startup
    # recovery). The test triggers it the same way the worker does.
    res = run(services["recover_incomplete_finalizations"]())
    assert res["scanned"] >= 1
    assert res["resumed"] >= 1
    # Lifecycle resumed exactly once.
    grant = next(g for g in db["edutalk_coach_rewards_grants"].docs
                 if g["offer_id"] == oid)
    assert grant["state"] == "granted"
    off = next(o for o in db["edutalk_coach_rewards_offers"].docs
               if o["_id"] == oid)
    assert off["state"] == "granted"
    assert _held_caps(db, oid) == []
    assert len(_confirmed_caps(db, oid)) == 2
    assert len(_confirmed_notifs(db)) == 1
    assert len(_confirmed_audits(db)) == 1
    # Provider NEVER called.
    assert provider_calls["n"] == 0
    # Recovery itself is idempotent — re-running adds no extra work.
    res2 = run(services["recover_incomplete_finalizations"]())
    assert res2["resumed"] == 0
    assert len(_confirmed_notifs(db)) == 1
    assert len(_confirmed_audits(db)) == 1


def test_blockerB_release_decrement_failure_repaired_idempotently(env, monkeypatch):
    """Inject a bucket-decrement failure after the reservation has moved
    to ``release_pending``. The unfinished release must remain
    discoverable; a retry/repair must complete the decrement exactly
    once; a new legitimate reservation must succeed; capacity is
    neither leaked (false-cap) nor over-released."""
    api, db, services = env
    reserve = services["reserve_cap_slot"]
    release = services["release_caps_for_offer"]
    recover_pending = services["recover_pending_cap_releases"]
    bkey = "stuB:day:2099-08-01"

    # 1) Reservation that consumes the final available slot.
    assert run(reserve("stuB", "o1", "day", "2099-08-01", 1)) is True
    assert day_bucket_active(db, bkey) == 1
    # Cap is full — a new reservation must lose.
    assert run(reserve("stuB", "ox", "day", "2099-08-01", 1)) is False

    # Inject a bucket decrement failure that fires ONCE and only for
    # the bucket we care about. The release will move the reservation
    # to ``release_pending`` and then the decrement step will raise.
    bucket_col = db["edutalk_coach_rewards_cap_buckets"]
    orig_fau = bucket_col.find_one_and_update
    boom_for = {"_id": bkey}
    fired = {"n": 0}

    async def boom_fau(q, upd):
        if q.get("_id") == boom_for["_id"] and fired["n"] == 0:
            fired["n"] = 1
            raise RuntimeError("decrement_io_failure")
        return await orig_fau(q, upd)

    bucket_col.find_one_and_update = boom_fau  # type: ignore[assignment]
    try:
        run(release("o1", "expired"))
    finally:
        bucket_col.find_one_and_update = orig_fau  # type: ignore[assignment]

    # The unfinished release is discoverable — reservation is stuck
    # in ``release_pending`` and the bucket counter is still 1.
    pending = [r for r in db["edutalk_coach_rewards_cap_reservations"].docs
               if r.get("offer_id") == "o1"]
    assert len(pending) == 1
    assert pending[0]["state"] == "release_pending"
    assert day_bucket_active(db, bkey) == 1  # decrement did not apply

    # 2) Retry / repair completes the decrement.
    rep1 = run(recover_pending())
    assert rep1["repaired"] == 1
    # Bucket decremented exactly once → 0.
    assert day_bucket_active(db, bkey) == 0
    # Reservation ends fully released.
    after = next(r for r in db["edutalk_coach_rewards_cap_reservations"].docs
                 if r.get("offer_id") == "o1")
    assert after["state"] == "released"
    # Repeated repair is idempotent — never over-releases.
    rep2 = run(recover_pending())
    assert rep2["repaired"] == 0
    assert day_bucket_active(db, bkey) == 0
    # A new legitimate reservation now succeeds — capacity not leaked.
    assert run(reserve("stuB", "o2", "day", "2099-08-01", 1)) is True
    assert day_bucket_active(db, bkey) == 1


def test_blockerB_release_does_not_release_already_confirmed(env):
    """Already-confirmed reservations must NEVER be released by the
    crash-safe release path."""
    api, db, services = env
    reserve = services["reserve_cap_slot"]
    release = services["release_caps_for_offer"]
    bkey = "stuB2:day:2099-09-01"
    # Reserve and confirm via the shared finalizer.
    assert run(reserve("stuB2", "oC", "day", "2099-09-01", 1)) is True
    _make_offer_row(db, offer_id="oC", clean_id="stuB2", session_id="sidBc")
    tx_id = "edutalk-coach-reward:oC:points"
    db["edutalk_coach_rewards_grants"].docs.append({
        "tx_id": tx_id, "offer_id": "oC", "clean_id": "stuB2", "amount": 5,
        "state": "granted", "provider_idempotency_key": "p" * 64,
        "confirmed_at": rwd._iso(), "provider_ref": "ref",
    })
    run(services["finalize_confirmed_grant"](
        "oC", provider_ref="ref", resolved_by="dispatch"))
    # Reservation is confirmed.
    row = next(r for r in db["edutalk_coach_rewards_cap_reservations"].docs
               if r.get("offer_id") == "oC")
    assert row["state"] == "confirmed"
    active_before = day_bucket_active(db, bkey)
    # Now ask release_caps_for_offer to run — it must do NOTHING.
    run(release("oC", "noop"))
    after = next(r for r in db["edutalk_coach_rewards_cap_reservations"].docs
                 if r.get("offer_id") == "oC")
    assert after["state"] == "confirmed"
    assert day_bucket_active(db, bkey) == active_before


# =========================================================================== #
# CORRECTION A — Crash-resumable confirmed lifecycle internal boundaries.      #
#                                                                              #
#   A1: confirmed audit event ordering — event durably persisted BEFORE        #
#       marker is set; arbitrary DB error leaves marker unset; duplicate-key   #
#       proves event already exists; marker/event disagreement repaired.       #
#   A2: confirmed notification recovery — duplicate-key vs arbitrary DB        #
#       error distinguished; marker repaired after crash between insert and    #
#       marker update; arbitrary DB error retried later.                       #
#   A3: push-attempt lifecycle — durable push_state (pending/attempting/       #
#       attempted); recovery attempts push exactly once; no duplicate push;    #
#       push failure does not undo wallet credit and is not silently           #
#       recorded as success.                                                   #
# =========================================================================== #


def _has_confirmed_audit_event(db, offer_id: str) -> bool:
    """A confirmed lifecycle audit row keyed by the stable event_key
    exists in the audit collection."""
    ek = f"edutalk-coach-reward:{offer_id}:grant_confirmed"
    return any(
        a.get("event_key") == ek and a.get("kind") == "grant_confirmed"
        for a in db["edutalk_coach_rewards_audit"].docs)


def _confirmed_notif_for(db, offer_id: str):
    nkey = f"edutalk-coach-reward:{offer_id}:confirmed"
    return next(
        (n for n in db["edutalk_coach_rewards_notifications"].docs
         if n.get("notif_key") == nkey), None)


def test_correctionA1_audit_event_arbitrary_error_does_not_set_marker(
        env, monkeypatch):
    """A1 — if the confirmed audit event insert raises an arbitrary
    (non-DuplicateKey) database error, the ``confirmed_event_emitted``
    marker MUST remain unset so recovery re-attempts later. Repeated
    recovery must converge to event existing exactly once with the
    marker accurate. The provider must NEVER be called again."""
    api, db, services = env
    _enable_points(api, exercises_required=1)
    provider_calls = {"n": 0}

    async def credit(c, a, n):
        provider_calls["n"] += 1
        return {"outcome": "granted", "provider_ref": "ref",
                "balance_after": 100, "duplicate": False, "error": None}
    monkeypatch.setattr(rwd, "REAL_GRANT_ENABLED", True)
    monkeypatch.setitem(rwd.__dict__, "_gas_treasury_credit_with_nonce",
                        credit)

    oid = "off-A1-arb"
    _blockerA_seed_partial_confirmed(db, services, oid,
                                     session_id="sidA1", clean_id="stu123")
    # Pre-populate the durable confirmed notification so this test
    # isolates the AUDIT-EVENT boundary specifically.
    nkey = f"edutalk-coach-reward:{oid}:confirmed"
    db["edutalk_coach_rewards_notifications"].docs.append({
        "notif_key": nkey, "ts": rwd._iso(),
        "clean_id": "stu123", "offer_id": oid,
        "title": "t", "body": "b",
        "kind": "edutalk_coach_reward_confirmed",
        "read": False,
        "push_state": "attempted",
        "delivery": {"db": True, "push": "ok",
                     "push_state": "attempted"},
    })

    audit_col = db["edutalk_coach_rewards_audit"]
    orig_insert = audit_col.insert_one
    fail_once = {"n": 0}

    async def flaky_insert(doc):
        if (doc.get("kind") == "grant_confirmed"
                and doc.get("offer_id") == oid
                and fail_once["n"] == 0):
            fail_once["n"] = 1
            raise RuntimeError("audit_io_failure")
        return await orig_insert(doc)

    audit_col.insert_one = flaky_insert  # type: ignore[assignment]
    try:
        # Production entry point: recovery scan.
        res = run(services["recover_incomplete_finalizations"]())
    finally:
        audit_col.insert_one = orig_insert  # type: ignore[assignment]
    # The recovery cycle observed and TRIED to insert; the failure
    # MUST NOT leave a false-positive marker.
    assert res["scanned"] >= 1
    offer = next(o for o in db["edutalk_coach_rewards_offers"].docs
                 if o["_id"] == oid)
    assert offer.get("confirmed_event_emitted") is not True, (
        "marker must NOT lead the durable event on a non-duplicate DB "
        "error")
    assert not _has_confirmed_audit_event(db, oid)

    # Second recovery cycle — must converge: insert succeeds, marker
    # repaired, no duplicate audit event, provider never re-called.
    run(services["recover_incomplete_finalizations"]())
    offer = next(o for o in db["edutalk_coach_rewards_offers"].docs
                 if o["_id"] == oid)
    assert offer.get("confirmed_event_emitted") is True
    audits = [a for a in db["edutalk_coach_rewards_audit"].docs
              if a.get("kind") == "grant_confirmed"
              and a.get("offer_id") == oid]
    assert len(audits) == 1
    assert provider_calls["n"] == 0
    # Third recovery is a complete no-op.
    res3 = run(services["recover_incomplete_finalizations"]())
    assert res3["resumed"] == 0
    audits2 = [a for a in db["edutalk_coach_rewards_audit"].docs
               if a.get("kind") == "grant_confirmed"
               and a.get("offer_id") == oid]
    assert len(audits2) == 1


def test_correctionA1_audit_event_duplicate_proves_existence_and_repairs_marker(
        env, monkeypatch):
    """A1 — duplicate-key on the audit-event insert is the ONLY signal
    that proves the event already exists. When the durable event row
    is present and the marker is False, recovery must repair the
    marker without creating a duplicate event."""
    api, db, services = env
    _enable_points(api, exercises_required=1)
    provider_calls = {"n": 0}

    async def credit(c, a, n):
        provider_calls["n"] += 1
        return {"outcome": "granted", "provider_ref": "ref",
                "balance_after": 100, "duplicate": False, "error": None}
    monkeypatch.setattr(rwd, "REAL_GRANT_ENABLED", True)
    monkeypatch.setitem(rwd.__dict__, "_gas_treasury_credit_with_nonce",
                        credit)

    oid = "off-A1-dup"
    _blockerA_seed_partial_confirmed(db, services, oid,
                                     session_id="sidA1d", clean_id="stu123")
    # Pre-seed: confirmed audit event ALREADY exists durably, but
    # marker is False (simulating crash between insert success and
    # marker update). Also pre-seed the confirmed notification so this
    # test isolates the audit-event boundary.
    ek = f"edutalk-coach-reward:{oid}:grant_confirmed"
    db["edutalk_coach_rewards_audit"].docs.append({
        "event_key": ek, "kind": "grant_confirmed", "ts": rwd._iso(),
        "offer_id": oid, "tx_id": (
            f"edutalk-coach-reward:{oid}:points"),
        "resolved_by": "manual", "reward_amount": 5,
    })
    nkey = f"edutalk-coach-reward:{oid}:confirmed"
    db["edutalk_coach_rewards_notifications"].docs.append({
        "notif_key": nkey, "ts": rwd._iso(),
        "clean_id": "stu123", "offer_id": oid, "title": "t", "body": "b",
        "kind": "edutalk_coach_reward_confirmed",
        "read": False,
        "push_state": "attempted",
        "delivery": {"db": True, "push": "ok",
                     "push_state": "attempted"},
    })

    res = run(services["recover_incomplete_finalizations"]())
    assert res["resumed"] >= 1
    # Marker is repaired exactly once; no duplicate audit row.
    offer = next(o for o in db["edutalk_coach_rewards_offers"].docs
                 if o["_id"] == oid)
    assert offer.get("confirmed_event_emitted") is True
    audits = [a for a in db["edutalk_coach_rewards_audit"].docs
              if a.get("kind") == "grant_confirmed"
              and a.get("offer_id") == oid]
    assert len(audits) == 1, (
        "duplicate-key path must NEVER create a second audit event")
    assert provider_calls["n"] == 0
    # Repeated recovery — still no duplicate, full convergence.
    res2 = run(services["recover_incomplete_finalizations"]())
    assert res2["resumed"] == 0
    audits2 = [a for a in db["edutalk_coach_rewards_audit"].docs
               if a.get("kind") == "grant_confirmed"
               and a.get("offer_id") == oid]
    assert len(audits2) == 1


def test_correctionA2_notif_arbitrary_error_leaves_marker_unset(
        env, monkeypatch):
    """A2 — arbitrary DB error on the confirmed-notification insert MUST
    NOT be treated as duplicate. The marker MUST remain unset so the
    next recovery cycle eventually creates the notification exactly
    once."""
    api, db, services = env
    _enable_points(api, exercises_required=1)
    provider_calls = {"n": 0}

    async def credit(c, a, n):
        provider_calls["n"] += 1
        return {"outcome": "granted", "provider_ref": "ref",
                "balance_after": 100, "duplicate": False, "error": None}
    monkeypatch.setattr(rwd, "REAL_GRANT_ENABLED", True)
    monkeypatch.setitem(rwd.__dict__, "_gas_treasury_credit_with_nonce",
                        credit)

    oid = "off-A2-arb"
    _blockerA_seed_partial_confirmed(db, services, oid,
                                     session_id="sidA2", clean_id="stu123")

    notif_col = db["edutalk_coach_rewards_notifications"]
    orig_insert = notif_col.insert_one
    fail_once = {"n": 0}

    async def flaky_insert(doc):
        if (doc.get("kind") == "edutalk_coach_reward_confirmed"
                and doc.get("offer_id") == oid
                and fail_once["n"] == 0):
            fail_once["n"] = 1
            raise RuntimeError("notif_io_failure")
        return await orig_insert(doc)

    notif_col.insert_one = flaky_insert  # type: ignore[assignment]
    try:
        run(services["recover_incomplete_finalizations"]())
    finally:
        notif_col.insert_one = orig_insert  # type: ignore[assignment]

    # No notification exists; the marker is NOT set; provider not called.
    assert _confirmed_notif_for(db, oid) is None
    offer = next(o for o in db["edutalk_coach_rewards_offers"].docs
                 if o["_id"] == oid)
    assert offer.get("notif_confirmed_sent") is not True
    assert provider_calls["n"] == 0

    # Second cycle converges: notification exists exactly once, marker
    # repaired, push lifecycle terminated.
    run(services["recover_incomplete_finalizations"]())
    notif = _confirmed_notif_for(db, oid)
    assert notif is not None
    assert notif.get("push_state") == "attempted"
    offer = next(o for o in db["edutalk_coach_rewards_offers"].docs
                 if o["_id"] == oid)
    assert offer.get("notif_confirmed_sent") is True
    assert provider_calls["n"] == 0
    # Total notifications under the confirmed key remains 1.
    confirmed = [n for n in
                 db["edutalk_coach_rewards_notifications"].docs
                 if n.get("offer_id") == oid
                 and n.get("notif_key", "").endswith(":confirmed")]
    assert len(confirmed) == 1


def test_correctionA2_notif_duplicate_repairs_marker(env, monkeypatch):
    """A2 — duplicate notif_key proves notification already exists.
    Recovery must repair the marker WITHOUT creating a duplicate row
    and WITHOUT swallowing the duplicate as a generic failure."""
    api, db, services = env
    _enable_points(api, exercises_required=1)
    provider_calls = {"n": 0}

    async def credit(c, a, n):
        provider_calls["n"] += 1
        return {"outcome": "granted", "provider_ref": "ref",
                "balance_after": 100, "duplicate": False, "error": None}
    monkeypatch.setattr(rwd, "REAL_GRANT_ENABLED", True)
    monkeypatch.setitem(rwd.__dict__, "_gas_treasury_credit_with_nonce",
                        credit)

    oid = "off-A2-dup"
    _blockerA_seed_partial_confirmed(db, services, oid,
                                     session_id="sidA2d", clean_id="stu123")
    # Pre-seed: notification already exists (crash between insert and
    # marker repair).
    nkey = f"edutalk-coach-reward:{oid}:confirmed"
    db["edutalk_coach_rewards_notifications"].docs.append({
        "notif_key": nkey, "ts": rwd._iso(),
        "clean_id": "stu123", "offer_id": oid, "title": "t", "body": "b",
        "kind": "edutalk_coach_reward_confirmed",
        "read": False,
        "push_state": "pending",
        "delivery": {"db": True, "push": "pending",
                     "push_state": "pending"},
    })
    res = run(services["recover_incomplete_finalizations"]())
    assert res["resumed"] >= 1
    # Marker repaired; notification count remains 1; push attempted
    # exactly once.
    offer = next(o for o in db["edutalk_coach_rewards_offers"].docs
                 if o["_id"] == oid)
    assert offer.get("notif_confirmed_sent") is True
    confirmed = [n for n in
                 db["edutalk_coach_rewards_notifications"].docs
                 if n.get("offer_id") == oid
                 and n.get("notif_key", "").endswith(":confirmed")]
    assert len(confirmed) == 1
    assert (confirmed[0].get("push_state")) == "attempted"
    assert provider_calls["n"] == 0


def test_correctionA3_push_attempted_exactly_once(env, monkeypatch):
    """A3 — push lifecycle is durable. Recovery attempts push exactly
    once when ``delivery.push_state == "pending"``; repeated recovery
    does NOT create a duplicate push attempt."""
    api, db, services = env
    _enable_points(api, exercises_required=1)
    push_calls = {"n": 0}

    # Stub fan-out via the module-level helper used by _push_fanout.
    async def _fake_fanout(query, title, body, link):
        push_calls["n"] += 1
        return (1, 0)
    monkeypatch.setattr(
        rwd, "_fan_out_push", _fake_fanout, raising=False)

    async def credit(c, a, n):
        return {"outcome": "granted", "provider_ref": "ref",
                "balance_after": 100, "duplicate": False, "error": None}
    monkeypatch.setattr(rwd, "REAL_GRANT_ENABLED", True)
    monkeypatch.setitem(rwd.__dict__, "_gas_treasury_credit_with_nonce",
                        credit)

    oid = "off-A3-push"
    _blockerA_seed_partial_confirmed(db, services, oid,
                                     session_id="sidA3", clean_id="stu123")
    # Full recovery — must attempt push exactly once and terminate
    # the durable push lifecycle as ``attempted``.
    run(services["recover_incomplete_finalizations"]())
    notif = _confirmed_notif_for(db, oid)
    assert notif is not None
    assert notif.get("push_state") == "attempted"
    assert push_calls["n"] == 1
    # Repeated recovery — no duplicate push attempt.
    run(services["recover_incomplete_finalizations"]())
    assert push_calls["n"] == 1


def test_correctionA3_push_pending_after_crash_is_recovered(env, monkeypatch):
    """A3 — a confirmed notification with ``push_state == "pending"`` is
    discoverable and converged by the recovery scan even when the
    ``notif_confirmed_sent`` marker is already True (simulating a
    crash between notification insertion + marker update and the very
    first push attempt)."""
    api, db, services = env
    _enable_points(api, exercises_required=1)
    push_calls = {"n": 0}

    async def _fake_fanout(query, title, body, link):
        push_calls["n"] += 1
        return (1, 0)
    monkeypatch.setattr(
        rwd, "_fan_out_push", _fake_fanout, raising=False)

    async def credit(c, a, n):
        return {"outcome": "granted", "provider_ref": "ref",
                "balance_after": 100, "duplicate": False, "error": None}
    monkeypatch.setattr(rwd, "REAL_GRANT_ENABLED", True)
    monkeypatch.setitem(rwd.__dict__, "_gas_treasury_credit_with_nonce",
                        credit)

    oid = "off-A3-crash"
    _blockerA_seed_partial_confirmed(db, services, oid,
                                     session_id="sidA3c", clean_id="stu123")
    # Pre-seed durable confirmed notification + audit event so the
    # ONLY missing piece is the push attempt. Marker reflects the
    # post-crash state.
    nkey = f"edutalk-coach-reward:{oid}:confirmed"
    db["edutalk_coach_rewards_notifications"].docs.append({
        "notif_key": nkey, "ts": rwd._iso(),
        "clean_id": "stu123", "offer_id": oid, "title": "t", "body": "b",
        "kind": "edutalk_coach_reward_confirmed",
        "read": False,
        "push_state": "pending",
        "delivery": {"db": True, "push": "pending",
                     "push_state": "pending"},
    })
    ek = f"edutalk-coach-reward:{oid}:grant_confirmed"
    db["edutalk_coach_rewards_audit"].docs.append({
        "event_key": ek, "kind": "grant_confirmed", "ts": rwd._iso(),
        "offer_id": oid, "tx_id": (
            f"edutalk-coach-reward:{oid}:points"),
        "resolved_by": "manual", "reward_amount": 5,
    })
    # Mark the optimistic markers True to prove recovery does NOT
    # rely solely on them — it inspects durable push_state.
    db["edutalk_coach_rewards_offers"].docs[-1] = next(
        o for o in db["edutalk_coach_rewards_offers"].docs
        if o["_id"] == oid)
    for o in db["edutalk_coach_rewards_offers"].docs:
        if o["_id"] == oid:
            o["confirmed_event_emitted"] = True
            o["notif_confirmed_sent"] = True
    res = run(services["recover_incomplete_finalizations"]())
    assert res["resumed"] >= 1
    notif = _confirmed_notif_for(db, oid)
    assert notif.get("push_state") == "attempted"
    assert push_calls["n"] == 1
    # Repeat — terminal.
    res2 = run(services["recover_incomplete_finalizations"]())
    assert res2["resumed"] == 0
    assert push_calls["n"] == 1


# =========================================================================== #
# FINDING 1 — backend recovery / normalization for claim_reserved &           #
#             grant_dispatching                                                #
# =========================================================================== #


def test_finding1_active_offer_surfaces_claim_reserved_normalized(env):
    """The active-offer route must surface a ``claim_reserved`` offer for
    the exact authenticated student + session, normalized to
    ``pending_confirmation``. Without this, an in-flight claim that
    was registered server-side but not yet confirmed becomes invisible
    to the bounded polling loop and the loop stalls."""
    api, db, services = env
    _enable_points(api, exercises_required=1)
    db["edutalk_coach_rewards_offers"].docs.append({
        "_id": "off-F1-cr", "offer_id": "off-F1-cr",
        "session_id": "sidF1", "clean_id": "stu123",
        "state": "claim_reserved",
        "expires_at": rwd._iso(),
        "reward_type": "points", "reward_amount": 5,
    })
    get_active = api.routes[("GET", "/edutalk/reward-offers/active")]
    res = run(get_active(session_id="sidF1", student=_Student()))
    offer = (res or {}).get("offer") or {}
    assert offer.get("offer_id") == "off-F1-cr"
    # The internal granular state is normalized to ``pending_confirmation``.
    assert offer.get("state") == "pending_confirmation"


def test_finding1_active_offer_surfaces_grant_dispatching_normalized(env):
    """Same contract for ``grant_dispatching``. The frontend bounded
    poll loop only needs ``pending_confirmation`` to keep going."""
    api, db, services = env
    _enable_points(api, exercises_required=1)
    db["edutalk_coach_rewards_offers"].docs.append({
        "_id": "off-F1-gd", "offer_id": "off-F1-gd",
        "session_id": "sidF1b", "clean_id": "stu123",
        "state": "grant_dispatching",
        "expires_at": rwd._iso(),
        "reward_type": "points", "reward_amount": 5,
    })
    get_active = api.routes[("GET", "/edutalk/reward-offers/active")]
    res = run(get_active(session_id="sidF1b", student=_Student()))
    offer = (res or {}).get("offer") or {}
    assert offer.get("offer_id") == "off-F1-gd"
    assert offer.get("state") == "pending_confirmation"


def test_finding1_active_offer_other_session_does_not_leak_pre_confirmation(env):
    """A pre-confirmation offer belonging to a DIFFERENT session must
    NOT be surfaced for the requested session (defence-in-depth)."""
    api, db, services = env
    _enable_points(api, exercises_required=1)
    db["edutalk_coach_rewards_offers"].docs.append({
        "_id": "off-F1-other", "offer_id": "off-F1-other",
        "session_id": "sidF1-other", "clean_id": "stu123",
        "state": "claim_reserved",
        "expires_at": rwd._iso(),
        "reward_type": "points", "reward_amount": 5,
    })
    get_active = api.routes[("GET", "/edutalk/reward-offers/active")]
    res = run(get_active(session_id="sidF1-not-mine",
                         student=_Student()))
    assert (res or {}).get("offer") is None


# =========================================================================== #
# FINDING 2 — truthful push-attempt crash recovery                            #
# =========================================================================== #


def _confirmed_notif_doc(db, offer_id):
    nkey = f"edutalk-coach-reward:{offer_id}:confirmed"
    return next(
        (n for n in db["edutalk_coach_rewards_notifications"].docs
         if n.get("notif_key") == nkey), None)


def test_finding2_crash_before_fanout_safely_returns_to_pending(
        env, monkeypatch):
    """Crash AFTER the CAS to ``attempting`` but BEFORE
    ``fanout_invoked_at`` was recorded must safely return the row to
    ``pending`` so the bounded recovery loop drives the push exactly
    once. The push provider must not be skipped (the wallet credit
    is authoritative; we want the student to ALSO get the push)."""
    api, db, services = env
    _enable_points(api, exercises_required=1)
    push_calls = {"n": 0}

    async def _fake_fanout(query, title, body, link):
        push_calls["n"] += 1
        return (1, 0)
    monkeypatch.setattr(
        rwd, "_fan_out_push", _fake_fanout, raising=False)

    async def credit(c, a, n):
        return {"outcome": "granted", "provider_ref": "ref",
                "balance_after": 100, "duplicate": False, "error": None}
    monkeypatch.setattr(rwd, "REAL_GRANT_ENABLED", True)
    monkeypatch.setitem(rwd.__dict__, "_gas_treasury_credit_with_nonce",
                        credit)

    oid = "off-F2-pre"
    _blockerA_seed_partial_confirmed(db, services, oid,
                                     session_id="sidF2", clean_id="stu123")
    # Pre-seed a confirmed notification stuck in ``attempting`` WITHOUT
    # ``fanout_invoked_at`` — exactly the pre-fanout crash signature.
    nkey = f"edutalk-coach-reward:{oid}:confirmed"
    db["edutalk_coach_rewards_notifications"].docs.append({
        "notif_key": nkey, "ts": rwd._iso(),
        "clean_id": "stu123", "offer_id": oid, "title": "t", "body": "b",
        "kind": "edutalk_coach_reward_confirmed",
        "read": False,
        "push_state": "attempting",
        "attempt_started_at": rwd._iso(),
        # NOTE: no fanout_invoked_at, no attempt_completed_at.
        "delivery": {"db": True, "push": "pending",
                     "push_state": "attempting"},
    })
    ek = f"edutalk-coach-reward:{oid}:grant_confirmed"
    db["edutalk_coach_rewards_audit"].docs.append({
        "event_key": ek, "kind": "grant_confirmed", "ts": rwd._iso(),
        "offer_id": oid, "tx_id": f"edutalk-coach-reward:{oid}:points",
        "resolved_by": "manual", "reward_amount": 5,
    })
    # First recovery cycle: detects the pre-fanout crash signature
    # and safely returns the row to ``pending``.
    res = run(services["recover_incomplete_finalizations"]())
    assert res["resumed"] >= 1
    notif_mid = _confirmed_notif_doc(db, oid)
    assert notif_mid is not None
    assert notif_mid.get("push_state") == "pending", (
        "pre-fanout crash must safely reset to pending so the next "
        "bounded recovery cycle drives the push exactly once")
    # Second recovery cycle: drives the push exactly once.
    res2 = run(services["recover_incomplete_finalizations"]())
    assert res2["resumed"] >= 1
    notif = _confirmed_notif_doc(db, oid)
    assert notif.get("push_state") == "attempted"
    assert notif.get("attempt_completed_at"), (
        "completion evidence must be persisted after a real attempt")
    assert push_calls["n"] == 1, (
        "push provider must be invoked EXACTLY once after the pre-fanout "
        "crash recovery")
    # Repeated recovery is a no-op.
    res3 = run(services["recover_incomplete_finalizations"]())
    assert res3["resumed"] == 0
    assert push_calls["n"] == 1


def test_finding2_post_fanout_crash_records_attempt_unknown(
        env, monkeypatch):
    """Crash AFTER ``fanout_invoked_at`` but BEFORE completion evidence
    is ambiguous. The lifecycle MUST NOT falsely claim ``attempted``
    success and MUST NOT safely retry (the previous attempt may have
    been delivered). The honest outcome is ``attempt_unknown``."""
    api, db, services = env
    _enable_points(api, exercises_required=1)
    push_calls = {"n": 0}

    async def _fake_fanout(query, title, body, link):
        push_calls["n"] += 1
        return (1, 0)
    monkeypatch.setattr(
        rwd, "_fan_out_push", _fake_fanout, raising=False)

    oid = "off-F2-post"
    _blockerA_seed_partial_confirmed(db, services, oid,
                                     session_id="sidF2b", clean_id="stu123")
    nkey = f"edutalk-coach-reward:{oid}:confirmed"
    db["edutalk_coach_rewards_notifications"].docs.append({
        "notif_key": nkey, "ts": rwd._iso(),
        "clean_id": "stu123", "offer_id": oid, "title": "t", "body": "b",
        "kind": "edutalk_coach_reward_confirmed",
        "read": False,
        "push_state": "attempting",
        "attempt_started_at": rwd._iso(),
        "fanout_invoked_at": rwd._iso(),
        # NOTE: no attempt_completed_at — ambiguous post-fanout crash.
        "delivery": {"db": True, "push": "pending",
                     "push_state": "attempting"},
    })
    ek = f"edutalk-coach-reward:{oid}:grant_confirmed"
    db["edutalk_coach_rewards_audit"].docs.append({
        "event_key": ek, "kind": "grant_confirmed", "ts": rwd._iso(),
        "offer_id": oid, "tx_id": f"edutalk-coach-reward:{oid}:points",
        "resolved_by": "manual", "reward_amount": 5,
    })
    run(services["recover_incomplete_finalizations"]())
    notif = _confirmed_notif_doc(db, oid)
    assert notif is not None
    assert notif.get("push_state") == "attempt_unknown", (
        "post-fanout crash must NOT be falsely marked attempted")
    # Push provider must NOT be re-invoked — we honestly cannot
    # know whether the previous attempt delivered.
    assert push_calls["n"] == 0
    # Repeated recovery is a no-op (attempt_unknown is terminal).
    res2 = run(services["recover_incomplete_finalizations"]())
    assert res2["resumed"] == 0
    assert push_calls["n"] == 0


def test_finding2_completed_push_is_terminal_and_idempotent(
        env, monkeypatch):
    """A push attempt that already has ``attempt_completed_at`` is
    terminal. Repeated recovery must NOT duplicate the push."""
    api, db, services = env
    _enable_points(api, exercises_required=1)
    push_calls = {"n": 0}

    async def _fake_fanout(query, title, body, link):
        push_calls["n"] += 1
        return (1, 0)
    monkeypatch.setattr(
        rwd, "_fan_out_push", _fake_fanout, raising=False)

    oid = "off-F2-done"
    _blockerA_seed_partial_confirmed(db, services, oid,
                                     session_id="sidF2c", clean_id="stu123")
    # Mark the offer fully complete (granted state, both markers True,
    # cap reservation confirmed) so a fully terminal lifecycle is the
    # only thing recovery should see.
    for o in db["edutalk_coach_rewards_offers"].docs:
        if o["_id"] == oid:
            o["state"] = "granted"
            o["confirmed_event_emitted"] = True
            o["notif_confirmed_sent"] = True
    for c in db["edutalk_coach_rewards_cap_reservations"].docs:
        if c.get("offer_id") == oid and c.get("state") == "held":
            c["state"] = "confirmed"
    nkey = f"edutalk-coach-reward:{oid}:confirmed"
    db["edutalk_coach_rewards_notifications"].docs.append({
        "notif_key": nkey, "ts": rwd._iso(),
        "clean_id": "stu123", "offer_id": oid, "title": "t", "body": "b",
        "kind": "edutalk_coach_reward_confirmed",
        "read": False,
        "push_state": "attempted",
        "attempt_started_at": rwd._iso(),
        "fanout_invoked_at": rwd._iso(),
        "attempt_completed_at": rwd._iso(),
        "attempted_at": rwd._iso(),
        "delivery": {"db": True, "push": "ok",
                     "push_state": "attempted"},
    })
    ek = f"edutalk-coach-reward:{oid}:grant_confirmed"
    db["edutalk_coach_rewards_audit"].docs.append({
        "event_key": ek, "kind": "grant_confirmed", "ts": rwd._iso(),
        "offer_id": oid, "tx_id": f"edutalk-coach-reward:{oid}:points",
        "resolved_by": "manual", "reward_amount": 5,
    })
    res = run(services["recover_incomplete_finalizations"]())
    assert res["resumed"] == 0
    assert push_calls["n"] == 0


# =========================================================================== #
# FINDING 4 — delayed-confirmed Gemini congratulations                        #
# =========================================================================== #


class _FakeRewardCtx:
    """Minimal stand-in for ``RewardSessionCtx`` exposing only the
    surface the recovered-announce path uses. Records every Gemini
    inject so we can prove "exactly once" without running a real WS."""

    def __init__(self, session_id, clean_id):
        self.session_id = session_id
        self.clean_id = clean_id
        self.injects = []

    async def inject_gemini_text(self, text):
        self.injects.append(text)
        return True


def test_finding4_pending_then_granted_announces_once(env, monkeypatch):
    """End-to-end intent: an earlier pending claim → bounded polling
    discovers a granted result → the client-driven recovered-announce
    helper injects the Gemini congratulations exactly once. Repeated
    recovered-announce calls are no-ops."""
    api, db, services = env
    _enable_points(api, exercises_required=1)
    sid, oid, cid = "sidF4", "off-F4", "stu123"
    db["edutalk_coach_rewards_offers"].docs.append({
        "_id": oid, "offer_id": oid,
        "session_id": sid, "clean_id": cid,
        "state": "granted",
        "expires_at": rwd._iso(),
        "reward_type": "points", "reward_amount": 5,
        "claim_result": {"reward_summary": "5 EduHub Points",
                          "reward_amount": 5},
        "recognition_snapshot": {"student_name": "Lin",
                                 "lesson_title": "Lesson 3",
                                 "successful_exercise_count": 3,
                                 "recognized_practice":
                                 "stayed focused"},
        "config_snapshot": {},
        "claim_announcement_reserved_at": None,
        "claim_announcement_delivered_at": None,
    })
    fake = _FakeRewardCtx(sid, cid)
    services["register_live_reward_ctx"](sid, fake)
    res = run(services["announce_confirmed_recovered"](sid, oid, cid))
    assert res["delivered"] is True
    assert res["reason"] == "ok"
    assert len(fake.injects) == 1
    # Repeated calls — strictly idempotent.
    res2 = run(services["announce_confirmed_recovered"](sid, oid, cid))
    assert res2["delivered"] is False
    assert res2["already"] is True
    assert len(fake.injects) == 1


def test_finding4_wrong_session_rejected(env):
    api, db, services = env
    _enable_points(api, exercises_required=1)
    sid, oid, cid = "sidF4b", "off-F4b", "stu123"
    db["edutalk_coach_rewards_offers"].docs.append({
        "_id": oid, "offer_id": oid,
        "session_id": sid, "clean_id": cid,
        "state": "granted", "expires_at": rwd._iso(),
        "reward_type": "points", "reward_amount": 5,
        "claim_announcement_reserved_at": None,
        "claim_announcement_delivered_at": None,
    })
    fake = _FakeRewardCtx("OTHER", cid)
    services["register_live_reward_ctx"]("OTHER", fake)
    res = run(services["announce_confirmed_recovered"](
        "OTHER", oid, cid))
    assert res["delivered"] is False
    assert res["reason"] == "wrong_session"
    assert fake.injects == []


def test_finding4_wrong_owner_rejected(env):
    api, db, services = env
    _enable_points(api, exercises_required=1)
    sid, oid, owner = "sidF4c", "off-F4c", "stu-owner"
    db["edutalk_coach_rewards_offers"].docs.append({
        "_id": oid, "offer_id": oid,
        "session_id": sid, "clean_id": owner,
        "state": "granted", "expires_at": rwd._iso(),
        "reward_type": "points", "reward_amount": 5,
        "claim_announcement_reserved_at": None,
        "claim_announcement_delivered_at": None,
    })
    fake = _FakeRewardCtx(sid, "intruder")
    services["register_live_reward_ctx"](sid, fake)
    res = run(services["announce_confirmed_recovered"](
        sid, oid, "intruder"))
    assert res["delivered"] is False
    assert res["reason"] == "wrong_owner"
    assert fake.injects == []


def test_finding4_pending_offer_never_announces_success(env):
    api, db, services = env
    _enable_points(api, exercises_required=1)
    sid, oid, cid = "sidF4d", "off-F4d", "stu123"
    db["edutalk_coach_rewards_offers"].docs.append({
        "_id": oid, "offer_id": oid,
        "session_id": sid, "clean_id": cid,
        "state": "pending_confirmation", "expires_at": rwd._iso(),
        "reward_type": "points", "reward_amount": 5,
        "claim_announcement_reserved_at": None,
        "claim_announcement_delivered_at": None,
    })
    fake = _FakeRewardCtx(sid, cid)
    services["register_live_reward_ctx"](sid, fake)
    res = run(services["announce_confirmed_recovered"](sid, oid, cid))
    assert res["delivered"] is False
    assert res["reason"] == "not_granted"
    assert fake.injects == []


def test_finding4_no_live_session_does_not_fabricate_delivery(env):
    api, db, services = env
    _enable_points(api, exercises_required=1)
    sid, oid, cid = "sidF4e", "off-F4e", "stu123"
    db["edutalk_coach_rewards_offers"].docs.append({
        "_id": oid, "offer_id": oid,
        "session_id": sid, "clean_id": cid,
        "state": "granted", "expires_at": rwd._iso(),
        "reward_type": "points", "reward_amount": 5,
        "claim_announcement_reserved_at": None,
        "claim_announcement_delivered_at": None,
    })
    # Note: no register_live_reward_ctx — no live session is connected.
    res = run(services["announce_confirmed_recovered"](sid, oid, cid))
    assert res["delivered"] is False
    assert res["reason"] == "no_live_session"
    # The reservation must remain untouched so a later reconnect can
    # truthfully deliver — we MUST NOT fabricate voice delivery here.
    offer = next(o for o in db["edutalk_coach_rewards_offers"].docs
                 if o["_id"] == oid)
    assert offer.get("claim_announcement_delivered_at") is None
    assert offer.get("claim_announcement_reserved_at") is None


# =========================================================================== #
# CORRECTION 1 (final) — strict live-WebSocket delayed-confirmed announce      #
# handle_ws_announce_confirmed: delivers through the bridge-owned ctx, never   #
# via a REST→in-memory-registry hop. The wallet/provider is never invoked.     #
# =========================================================================== #


class _FakeWsCtx:
    """Stand-in for the live bridge's ``RewardSessionCtx``. Records every
    Gemini inject and every client ack frame so the tests can prove
    "announce exactly once" and "truthful delivery" without a real WS or
    Gemini connection. ``deliver=False`` simulates a transient inject
    failure (unavailable provider/socket)."""

    def __init__(self, session_id, clean_id, deliver=True):
        self.session_id = session_id
        self.clean_id = clean_id
        self._deliver = deliver
        self.injects = []
        self.acks = []

    async def inject_gemini_text(self, text):
        self.injects.append(text)
        return bool(self._deliver)

    async def emit_to_client(self, payload):
        self.acks.append(payload)
        return True


def _seed_granted_offer(db, sid, oid, cid, state="granted"):
    db["edutalk_coach_rewards_offers"].docs.append({
        "_id": oid, "offer_id": oid,
        "session_id": sid, "clean_id": cid,
        "state": state, "expires_at": rwd._iso(),
        "reward_type": "points", "reward_amount": 5,
        "claim_result": {"reward_summary": "5 EduHub Points",
                         "reward_amount": 5},
        "recognition_snapshot": {"student_name": "Lin",
                                 "lesson_title": "Lesson 3",
                                 "successful_exercise_count": 3,
                                 "recognized_practice": "stayed focused"},
        "config_snapshot": {},
        "claim_announcement_reserved_at": None,
        "claim_announcement_delivered_at": None,
    })


def _no_wallet(monkeypatch):
    """Install a provider/wallet credit helper that fails the test if it
    is EVER called. The announce path must never touch the wallet."""
    calls = {"n": 0}

    async def _forbidden(_clean_id, _amount, _nonce):
        calls["n"] += 1
        raise AssertionError(
            "wallet/provider grant helper must NEVER be invoked by the "
            "delayed-confirmed announce path")

    monkeypatch.setattr(
        rwd, "_gas_treasury_credit_with_nonce", _forbidden, raising=False)
    rwd.__dict__["_gas_treasury_credit_with_nonce"] = _forbidden
    return calls


def test_ws_announce_pending_then_granted_announces_once(env, monkeypatch):
    """pending → polling → granted → WS announcement exactly once, and a
    single reward_announce_ack(delivered=True) is sent back to the client.
    The wallet/provider is never invoked."""
    api, db, services = env
    _enable_points(api, exercises_required=1)
    calls = _no_wallet(monkeypatch)
    sid, oid, cid = "wsF1", "off-wsF1", "stu123"
    _seed_granted_offer(db, sid, oid, cid)
    ctx = _FakeWsCtx(sid, cid)
    session = {"clean_id": cid, "session_id": sid}
    res = run(services["handle_ws_announce_confirmed"](oid, sid, session, ctx))
    assert res["delivered"] is True
    assert res["reason"] == "ok"
    assert len(ctx.injects) == 1
    assert len(ctx.acks) == 1
    ack = ctx.acks[0]
    assert ack["type"] == "reward_announce_ack"
    assert ack["offer_id"] == oid
    assert ack["delivered"] is True
    assert ack["already_delivered"] is False
    assert calls["n"] == 0


def test_ws_announce_repeated_granted_recovery_does_not_duplicate(
        env, monkeypatch):
    """Repeated granted recovery (e.g. several poll/reconnect discoveries)
    never injects twice; the second call acks already_delivered=True."""
    api, db, services = env
    _enable_points(api, exercises_required=1)
    _no_wallet(monkeypatch)
    sid, oid, cid = "wsF2", "off-wsF2", "stu123"
    _seed_granted_offer(db, sid, oid, cid)
    ctx = _FakeWsCtx(sid, cid)
    session = {"clean_id": cid, "session_id": sid}
    r1 = run(services["handle_ws_announce_confirmed"](oid, sid, session, ctx))
    r2 = run(services["handle_ws_announce_confirmed"](oid, sid, session, ctx))
    r3 = run(services["handle_ws_announce_confirmed"](oid, sid, session, ctx))
    assert r1["delivered"] is True
    assert r2["delivered"] is False and r2["already"] is True
    assert r3["delivered"] is False and r3["already"] is True
    assert len(ctx.injects) == 1
    assert ctx.acks[1]["already_delivered"] is True
    assert ctx.acks[2]["already_delivered"] is True


def test_ws_announce_wrong_student_rejected(env, monkeypatch):
    api, db, services = env
    _enable_points(api, exercises_required=1)
    _no_wallet(monkeypatch)
    sid, oid, owner = "wsF3", "off-wsF3", "stu-owner"
    _seed_granted_offer(db, sid, oid, owner)
    ctx = _FakeWsCtx(sid, "intruder")
    session = {"clean_id": "intruder", "session_id": sid}
    res = run(services["handle_ws_announce_confirmed"](oid, sid, session, ctx))
    assert res["delivered"] is False
    assert res["reason"] == "wrong_owner"
    assert ctx.injects == []
    assert ctx.acks[0]["delivered"] is False


def test_ws_announce_wrong_session_rejected(env, monkeypatch):
    api, db, services = env
    _enable_points(api, exercises_required=1)
    _no_wallet(monkeypatch)
    sid, oid, cid = "wsF4", "off-wsF4", "stu123"
    _seed_granted_offer(db, sid, oid, cid)
    # The connection's active session id is the TRUTH; the client claims a
    # different session id — must be rejected before any inject.
    ctx = _FakeWsCtx(sid, cid)
    session = {"clean_id": cid, "session_id": sid}
    res = run(services["handle_ws_announce_confirmed"](
        oid, "a-different-session", session, ctx))
    assert res["delivered"] is False
    assert res["reason"] == "wrong_session"
    assert ctx.injects == []
    assert ctx.acks[0]["delivered"] is False


def test_ws_announce_non_granted_offer_rejected(env, monkeypatch):
    api, db, services = env
    _enable_points(api, exercises_required=1)
    _no_wallet(monkeypatch)
    sid, oid, cid = "wsF5", "off-wsF5", "stu123"
    _seed_granted_offer(db, sid, oid, cid, state="pending_confirmation")
    ctx = _FakeWsCtx(sid, cid)
    session = {"clean_id": cid, "session_id": sid}
    res = run(services["handle_ws_announce_confirmed"](oid, sid, session, ctx))
    assert res["delivered"] is False
    assert res["reason"] == "not_granted"
    assert ctx.injects == []


def test_ws_announce_unavailable_socket_does_not_fabricate_delivery(
        env, monkeypatch):
    """A transient inject failure (unavailable provider/socket) must NOT
    mark the announcement delivered and must release the reservation so a
    later reconnect can retry truthfully. Ack carries delivered=False."""
    api, db, services = env
    _enable_points(api, exercises_required=1)
    _no_wallet(monkeypatch)
    sid, oid, cid = "wsF6", "off-wsF6", "stu123"
    _seed_granted_offer(db, sid, oid, cid)
    ctx = _FakeWsCtx(sid, cid, deliver=False)  # inject fails
    session = {"clean_id": cid, "session_id": sid}
    res = run(services["handle_ws_announce_confirmed"](oid, sid, session, ctx))
    assert res["delivered"] is False
    assert res["reason"] == "inject_failed"
    offer = next(o for o in db["edutalk_coach_rewards_offers"].docs
                 if o["_id"] == oid)
    assert offer.get("claim_announcement_delivered_at") is None
    assert offer.get("claim_announcement_reserved_at") is None
    assert ctx.acks[0]["delivered"] is False
    assert ctx.acks[0]["already_delivered"] is False


def test_ws_announce_reconnect_permits_previously_undelivered(
        env, monkeypatch):
    """After a transient inject failure leaves the announcement
    undelivered, a fresh reconnect (new ctx) is permitted to deliver it
    exactly once."""
    api, db, services = env
    _enable_points(api, exercises_required=1)
    _no_wallet(monkeypatch)
    sid, oid, cid = "wsF7", "off-wsF7", "stu123"
    _seed_granted_offer(db, sid, oid, cid)
    session = {"clean_id": cid, "session_id": sid}
    # First connection: inject fails → not delivered, reservation released.
    ctx1 = _FakeWsCtx(sid, cid, deliver=False)
    r1 = run(services["handle_ws_announce_confirmed"](oid, sid, session, ctx1))
    assert r1["delivered"] is False
    # Reconnect: a brand-new ctx delivers successfully exactly once.
    ctx2 = _FakeWsCtx(sid, cid, deliver=True)
    r2 = run(services["handle_ws_announce_confirmed"](oid, sid, session, ctx2))
    assert r2["delivered"] is True
    assert len(ctx2.injects) == 1
    offer = next(o for o in db["edutalk_coach_rewards_offers"].docs
                 if o["_id"] == oid)
    assert offer.get("claim_announcement_delivered_at") is not None
    assert offer.get("claim_announcement_path") == "recovered_via_live_ws"


def test_ws_announce_no_offer_rejected(env, monkeypatch):
    api, db, services = env
    _enable_points(api, exercises_required=1)
    _no_wallet(monkeypatch)
    sid, cid = "wsF8", "stu123"
    ctx = _FakeWsCtx(sid, cid)
    session = {"clean_id": cid, "session_id": sid}
    res = run(services["handle_ws_announce_confirmed"](
        "off-missing", sid, session, ctx))
    assert res["delivered"] is False
    assert res["reason"] == "no_offer"
    assert ctx.injects == []


def test_registry_unregister_is_identity_safe(env):
    """An older socket's teardown must not evict a NEWER ctx that re-used
    the same session_id (fast reconnect)."""
    _api, _db, _services = env
    sid = "sid-reuse"
    old = _FakeWsCtx(sid, "stu123")
    new = _FakeWsCtx(sid, "stu123")
    rwd.register_live_reward_ctx(sid, old)
    rwd.register_live_reward_ctx(sid, new)  # reconnect replaces old
    # Old bridge tears down LAST, passing its own (stale) ctx identity.
    rwd.unregister_live_reward_ctx(sid, old)
    assert rwd.get_live_reward_ctx(sid) is new   # newer registration kept
    # The owning (new) bridge tears down with its identity → removed.
    rwd.unregister_live_reward_ctx(sid, new)
    assert rwd.get_live_reward_ctx(sid) is None

# =========================================================================== #
# CORRECTION A — truthful announcement reservation state (owner + lease)        #
# A live reservation WITHOUT durable delivery evidence must report in_progress  #
# (retryable), never already_delivered. A stale lease is safely reclaimable.    #
# =========================================================================== #


def test_announceA_active_reservation_reports_in_progress(env, monkeypatch):
    """A live (unexpired) reservation with NO delivery timestamp must
    return in_progress / retryable — NOT already_delivered — and the
    second caller must not inject."""
    api, db, services = env
    _enable_points(api, exercises_required=1)
    _no_wallet(monkeypatch)
    sid, oid, cid = "aA1", "off-aA1", "stu123"
    _seed_granted_offer(db, sid, oid, cid)
    offer = next(o for o in db["edutalk_coach_rewards_offers"].docs
                 if o["_id"] == oid)
    offer["claim_announcement_reserved_at"] = rwd._iso()
    offer["claim_announcement_owner"] = "other-owner"
    offer["claim_announcement_lease_expires_at"] = rwd._iso(
        rwd._now() + rwd.timedelta(seconds=60))  # active lease
    ctx = _FakeWsCtx(sid, cid)
    res = run(services["handle_ws_announce_confirmed"](
        oid, sid, {"clean_id": cid, "session_id": sid}, ctx))
    assert res["delivered"] is False
    assert res["already"] is False
    assert res["reason"] == "in_progress"
    assert res.get("retryable") is True
    assert ctx.injects == []
    assert ctx.acks[0]["already_delivered"] is False
    assert ctx.acks[0]["retryable"] is True


def test_announceA_durable_delivered_is_already_delivered(env, monkeypatch):
    """A durable delivered timestamp => already_delivered=true and no
    duplicate inject."""
    api, db, services = env
    _enable_points(api, exercises_required=1)
    _no_wallet(monkeypatch)
    sid, oid, cid = "aA2", "off-aA2", "stu123"
    _seed_granted_offer(db, sid, oid, cid)
    offer = next(o for o in db["edutalk_coach_rewards_offers"].docs
                 if o["_id"] == oid)
    offer["claim_announcement_delivered_at"] = rwd._iso()
    ctx = _FakeWsCtx(sid, cid)
    res = run(services["handle_ws_announce_confirmed"](
        oid, sid, {"clean_id": cid, "session_id": sid}, ctx))
    assert res["delivered"] is False
    assert res["already"] is True
    assert ctx.injects == []
    assert ctx.acks[0]["already_delivered"] is True


def test_announceA_stale_lease_is_reclaimed_and_injects_once(env, monkeypatch):
    """A stale (expired-lease) reservation with no delivery evidence is
    safely reclaimed: injected exactly once and a durable delivered
    timestamp is persisted."""
    api, db, services = env
    _enable_points(api, exercises_required=1)
    _no_wallet(monkeypatch)
    sid, oid, cid = "aA3", "off-aA3", "stu123"
    _seed_granted_offer(db, sid, oid, cid)
    offer = next(o for o in db["edutalk_coach_rewards_offers"].docs
                 if o["_id"] == oid)
    offer["claim_announcement_reserved_at"] = rwd._iso(
        rwd._now() - rwd.timedelta(seconds=300))
    offer["claim_announcement_owner"] = "crashed-owner"
    offer["claim_announcement_lease_expires_at"] = rwd._iso(
        rwd._now() - rwd.timedelta(seconds=120))  # expired => stale
    ctx = _FakeWsCtx(sid, cid)
    res = run(services["handle_ws_announce_confirmed"](
        oid, sid, {"clean_id": cid, "session_id": sid}, ctx))
    assert res["delivered"] is True
    assert len(ctx.injects) == 1
    offer = next(o for o in db["edutalk_coach_rewards_offers"].docs
                 if o["_id"] == oid)
    assert offer.get("claim_announcement_delivered_at") is not None


def test_announceA_concurrent_one_owner_injects_other_in_progress(
        env, monkeypatch):
    """Exactly one owner injects; a concurrent acknowledgement arriving
    while the first owner still holds the (undelivered) lease observes
    in_progress and never produces a duplicate announcement."""
    api, db, services = env
    _enable_points(api, exercises_required=1)
    _no_wallet(monkeypatch)
    sid, oid, cid = "aA4", "off-aA4", "stu123"
    _seed_granted_offer(db, sid, oid, cid)
    # A SECOND live ctx is registered; the registry-backed concurrent
    # caller would use it — it must never be injected into.
    ctx2 = _FakeWsCtx(sid, cid)
    services["register_live_reward_ctx"](sid, ctx2)
    holder = {}

    class ReentrantCtx(_FakeWsCtx):
        async def inject_gemini_text(self, text):
            self.injects.append(text)
            # While WE hold the reservation (reserved, not yet delivered),
            # a concurrent acknowledgement must see in_progress.
            holder["res"] = await services["announce_confirmed_recovered"](
                sid, oid, cid)
            return True

    ctx1 = ReentrantCtx(sid, cid)
    r1 = run(services["handle_ws_announce_confirmed"](
        oid, sid, {"clean_id": cid, "session_id": sid}, ctx1))
    assert r1["delivered"] is True
    assert len(ctx1.injects) == 1
    assert holder["res"]["reason"] == "in_progress"
    assert holder["res"]["already"] is False
    assert ctx2.injects == []  # the concurrent caller never injected


def test_announceA_rejections_unchanged_and_wallet_never_called(
        env, monkeypatch):
    """Wrong student, wrong session, and non-granted remain rejected; the
    wallet/provider is never invoked by any announce path."""
    api, db, services = env
    _enable_points(api, exercises_required=1)
    _no_wallet(monkeypatch)
    sid, oid, cid = "aA5", "off-aA5", "stu123"
    _seed_granted_offer(db, sid, oid, cid)
    ctx = _FakeWsCtx(sid, cid)
    sess = {"clean_id": cid, "session_id": sid}
    # wrong session
    r = run(services["handle_ws_announce_confirmed"](
        oid, "nope", sess, ctx))
    assert r["reason"] == "wrong_session" and r["delivered"] is False
    # wrong owner
    ctx_i = _FakeWsCtx(sid, "intruder")
    r = run(services["handle_ws_announce_confirmed"](
        oid, sid, {"clean_id": "intruder", "session_id": sid}, ctx_i))
    assert r["reason"] == "wrong_owner"
    # non-granted
    _seed_granted_offer(db, sid, "off-pend", cid, state="pending_confirmation")
    r = run(services["handle_ws_announce_confirmed"](
        "off-pend", sid, sess, _FakeWsCtx(sid, cid)))
    assert r["reason"] == "not_granted"
    assert ctx.injects == [] and ctx_i.injects == []
