"""tests/test_edutalk_live_topup_nudge.py
=========================================
Focused backend tests for the EduTalk Live Coach *Smart Top-Up Nudge*
(Phase 1) — an additive feature in ``edutalk_live_tools.py``.

Self-contained in-memory fakes (no network, no real Mongo, no Gemini key).
The fakes execute serially under a single asyncio event loop — exactly the
property the production atomic ``find_one_and_update`` claim relies on (Mongo
guarantees document-level atomicity natively). "Concurrent" here therefore
means N coroutines interleaved through one loop, mirroring the existing
``tests/test_voice_treasure_attempt_concurrency.py`` approach.

Covers (per the feature spec, section 12):
  * weekly-cap helper: race (one slot, two sessions, exactly one wins),
    idempotent same-session retry, rolling-window correctness across a
    calendar boundary (NOT a fixed-bucket approximation);
  * Stage 1 preview: flag-off shows NO numbers (balance_unavailable_for_preview),
    flag-on shows real numbers, per-mode eligibility;
  * Stage 2/3: pre-reservation balance not double-subtracted; Stage-3-only
    authorization only when Stage 2 did not qualify; never double-counts;
    settled balance read fresh; a refund above threshold suppresses the pill;
  * Gemini instruction: present only when authorized, and NEVER contains a
    numeric balance;
  * admin validation rejects invalid input (no silent clamping).
"""
from __future__ import annotations

import asyncio
import copy

import pytest

import edutalk_live_tools as elt
from edutalk_live_tools import (
    register_edutalk_live_routes,
    _consume_topup_nudge_slot,
    _topup_preview_for_mode,
    _validate_topup_nudge_fields,
    _topup_settlement_reason,
    _build_system_instruction,
    _topup_nudge_event_key,
    StartSessionRequest,
    EndSessionRequest,
    TOPUP_NUDGE_WINDOW_SECONDS,
    _TOPUP_NUDGE_INSTRUCTION_LINE,
)
from datetime import datetime, timedelta, timezone
import time


def run(coro):
    return asyncio.run(coro)


def _now():
    return datetime.now(timezone.utc)


# --------------------------------------------------------------------------- #
# In-memory Mongo-ish fakes (operators: $set/$setOnInsert/$unset/$inc, and    #
# query ops $ne/$in/$nin/$lt/$gte/$exists plus top-level $or).                #
# --------------------------------------------------------------------------- #
def _match_op(dv, cond):
    if isinstance(cond, dict):
        for op, val in cond.items():
            if op == "$ne":
                if dv == val:
                    return False
            elif op == "$in":
                if dv not in val:
                    return False
            elif op == "$nin":
                if dv in val:
                    return False
            elif op == "$lt":
                if not (dv is not None and dv < val):
                    return False
            elif op == "$lte":
                if not (dv is not None and dv <= val):
                    return False
            elif op == "$gt":
                if not (dv is not None and dv > val):
                    return False
            elif op == "$gte":
                if not (dv is not None and dv >= val):
                    return False
            elif op == "$exists":
                if (dv is not None) != bool(val):
                    return False
            else:
                return False
        return True
    return dv == cond


def _match(doc, query):
    for k, v in query.items():
        if k == "$or":
            if not any(_match(doc, sub) for sub in v):
                return False
            continue
        if not _match_op(doc.get(k), v):
            return False
    return True


class _Cursor:
    def __init__(self, docs):
        self._docs = docs

    def sort(self, f, d=1):
        self._docs.sort(key=lambda x: x.get(f) or "", reverse=(d == -1))
        return self

    def limit(self, n):
        self._docs = self._docs[:n]
        return self

    async def to_list(self, length=None):
        return self._docs[: (length or len(self._docs))]

    def __aiter__(self):
        async def gen():
            for d in self._docs:
                yield d
        return gen()


class _Coll:
    _counter = 0

    def __init__(self):
        self.docs = []

    async def create_index(self, *a, **k):
        return None

    def _apply(self, doc, up):
        if "$setOnInsert" in up:
            for k, v in up["$setOnInsert"].items():
                doc.setdefault(k, v)
        if "$set" in up:
            for k, v in up["$set"].items():
                doc[k] = v
        if "$inc" in up:
            for k, v in up["$inc"].items():
                doc[k] = (doc.get(k) or 0) + v
        if "$unset" in up:
            for k in up["$unset"].keys():
                doc.pop(k, None)
        return doc

    async def find_one(self, q, p=None):
        for d in self.docs:
            if _match(d, q):
                o = copy.deepcopy(d)
                if p and p.get("_id") == 0:
                    o.pop("_id", None)
                return o
        return None

    async def insert_one(self, doc):
        _Coll._counter += 1
        if "_id" not in doc:
            doc["_id"] = f"oid{_Coll._counter}"
        self.docs.append(copy.deepcopy(doc))
        return type("R", (), {"inserted_id": doc["_id"]})()

    async def update_one(self, q, up, upsert=False):
        for d in self.docs:
            if _match(d, q):
                self._apply(d, up)
                return type("R", (), {"matched_count": 1, "modified_count": 1})()
        if upsert:
            base = {}
            # seed equality fields from the query (e.g. clean_id / session_id)
            for k, v in q.items():
                if not isinstance(v, dict) and k != "$or":
                    base[k] = v
            _Coll._counter += 1
            base.setdefault("_id", f"oid{_Coll._counter}")
            self._apply(base, up)
            self.docs.append(base)
        return type("R", (), {"matched_count": 0, "modified_count": 0})()

    async def find_one_and_update(self, q, up, projection=None,
                                  return_document=None):
        # Locate the candidate under the filter.
        target = None
        for d in self.docs:
            if _match(d, q):
                target = d
                break
        # BUG B fix (TEST FILE ONLY — production locking code unchanged): a
        # deliberate interleaving point BETWEEN matching the filter and
        # applying the update, so two genuinely concurrent callers interleave
        # at exactly the spot a racy lock would corrupt state. The
        # re-validation below preserves MongoDB's ATOMIC find-and-modify
        # contract (a concurrent caller may have claimed the lock while we were
        # suspended). This makes the race test a faithful exercise of the
        # production claim-then-act lock rather than lucky scheduling.
        await asyncio.sleep(0)
        if target is None or not _match(target, q):
            return None
        before = copy.deepcopy(target)
        self._apply(target, up)
        out = before if (return_document is not None and
                         str(return_document).upper().endswith("BEFORE")) \
            else copy.deepcopy(target)
        if projection and projection.get("_id") == 0:
            out.pop("_id", None)
        return out

    def find(self, q, p=None):
        out = []
        for d in self.docs:
            if _match(d, q):
                o = copy.deepcopy(d)
                if p and p.get("_id") == 0:
                    o.pop("_id", None)
                out.append(o)
        return _Cursor(out)

    async def count_documents(self, q):
        return sum(1 for d in self.docs if _match(d, q))


class _DB:
    def __init__(self):
        self._c = {}

    def __getitem__(self, n):
        return self._c.setdefault(n, _Coll())


class _Router:
    def __init__(self):
        self.routes = {}

    def get(self, p):
        def deco(fn):
            self.routes[("GET", p)] = fn
            return fn
        return deco

    def post(self, p):
        def deco(fn):
            self.routes[("POST", p)] = fn
            return fn
        return deco

    def put(self, p):
        def deco(fn):
            self.routes[("PUT", p)] = fn
            return fn
        return deco

    def websocket(self, p):
        def deco(fn):
            self.routes[("WS", p)] = fn
            return fn
        return deco


class _Student:
    def __init__(self, sid="stu_alice", clean="alice"):
        self.student_id = sid
        self.clean_id = clean
        self.display_name = "Alice Example"


class _Admin:
    email = "admin@example.com"
    username = "admin"


class _DummyLoop:
    """Disposes background coroutines cleanly so _ensure_background never
    spawns the forever reconcile loop during tests."""
    def create_task(self, coro):
        try:
            coro.close()
        except Exception:
            pass
        return None


# --------------------------------------------------------------------------- #
# Section: admin validation — REJECT invalid input (no silent clamping).      #
# --------------------------------------------------------------------------- #
def test_validation_accepts_good_and_rejects_bad():
    assert _validate_topup_nudge_fields(
        {"topup_nudge_enabled": True, "topup_nudge_threshold": 15,
         "topup_nudge_max_per_week": 3}) == (True, "")
    assert _validate_topup_nudge_fields(
        {"topup_nudge_threshold": -1})[1] == "threshold_invalid"
    assert _validate_topup_nudge_fields(
        {"topup_nudge_threshold": 1.5})[1] == "threshold_invalid"
    assert _validate_topup_nudge_fields(
        {"topup_nudge_threshold": "abc"})[1] == "threshold_invalid"
    assert _validate_topup_nudge_fields(
        {"topup_nudge_max_per_week": -2})[1] == "weekly_cap_invalid"
    assert _validate_topup_nudge_fields(
        {"topup_nudge_max_per_week": 2.7})[1] == "weekly_cap_invalid"
    # integral float is accepted (coerced), e.g. 15.0
    assert _validate_topup_nudge_fields(
        {"topup_nudge_threshold": 15.0}) == (True, "")


# --------------------------------------------------------------------------- #
# Section: Stage 1 preview (pure).                                            #
# --------------------------------------------------------------------------- #
def test_preview_flag_off_shows_no_numbers():
    p = _topup_preview_for_mode(
        enabled=True, flag_on=False, balance=None, mode_cost=15,
        threshold=15, weekly_cap_available=True)
    assert p["enabled"] is False
    assert p["reason"] == "balance_unavailable_for_preview"
    # No numeric fields leak in the degraded state.
    for k in ("verified_current_balance", "mode_cost",
              "projected_post_reservation_balance"):
        assert k not in p


def test_preview_flag_on_eligible_and_not_eligible():
    eligible = _topup_preview_for_mode(
        enabled=True, flag_on=True, balance=30, mode_cost=15,
        threshold=15, weekly_cap_available=True)
    assert eligible["enabled"] is True and eligible["eligible"] is True
    assert eligible["reason"] == "projected_balance_at_or_below_threshold"
    assert eligible["verified_current_balance"] == 30
    assert eligible["projected_post_reservation_balance"] == 15
    # The backend computes projected; the frontend must NOT recompute.
    not_eligible = _topup_preview_for_mode(
        enabled=True, flag_on=True, balance=100, mode_cost=15,
        threshold=15, weekly_cap_available=True)
    assert not_eligible["eligible"] is False
    assert not_eligible["reason"] == "balance_above_threshold"


def test_preview_disabled_config():
    p = _topup_preview_for_mode(
        enabled=False, flag_on=True, balance=30, mode_cost=15,
        threshold=15, weekly_cap_available=True)
    assert p["reason"] == "config_disabled" and p["eligible"] is False


# --------------------------------------------------------------------------- #
# Section: weekly cap helper — RACE, IDEMPOTENCY, ROLLING WINDOW.             #
# --------------------------------------------------------------------------- #
def test_cap_race_one_slot_exactly_one_wins():
    """One slot remains → two different sessions call the helper concurrently
    → exactly one appends, the other gets weekly_cap_reached → the stored count
    never exceeds the cap.

    NOTE (BUG B fix): _Coll.find_one_and_update now yields (await
    asyncio.sleep(0)) BETWEEN matching the filter and applying the update, and
    re-validates the filter after the yield (preserving MongoDB's atomic
    find-and-modify contract). The two gathered coroutines therefore genuinely
    interleave at the claim point — this proves the production claim-then-act
    lock is correct under real interleaving, not merely lucky scheduling."""
    col = _Coll()

    async def scenario():
        cap = 1
        r1, r2 = await asyncio.gather(
            _consume_topup_nudge_slot(
                col, clean_id="alice", session_id="sessA",
                authorization_source="session_start", cap=cap),
            _consume_topup_nudge_slot(
                col, clean_id="alice", session_id="sessB",
                authorization_source="session_start", cap=cap),
        )
        return r1, r2

    r1, r2 = run(scenario())
    reasons = sorted([r1["reason"], r2["reason"]])
    assert reasons == ["authorized", "weekly_cap_reached"]
    # Stored count never exceeds the cap.
    doc = col.docs[0]
    assert len(doc["authorizations"]) == 1


def test_cap_idempotent_same_session_retry():
    col = _Coll()

    async def scenario():
        a = await _consume_topup_nudge_slot(
            col, clean_id="bob", session_id="sX",
            authorization_source="session_start", cap=3)
        b = await _consume_topup_nudge_slot(
            col, clean_id="bob", session_id="sX",
            authorization_source="session_start", cap=3)
        return a, b

    a, b = run(scenario())
    assert a["reason"] == "authorized"
    assert b["reason"] == "idempotent"
    # Retrying the same session_id never increments twice.
    assert len(col.docs[0]["authorizations"]) == 1
    assert b["record"]["event_key"] == _topup_nudge_event_key("bob", "sX")


def test_cap_rolling_window_across_calendar_boundary():
    """A fixed calendar bucket would let entries on either side of a boundary
    both count. We assert the CONTINUOUS now-7d window prunes an 8-day-old
    record so a fresh authorization is allowed even at cap=1."""
    col = _Coll()
    now = _now()
    old_ts = (now - timedelta(seconds=TOPUP_NUDGE_WINDOW_SECONDS + 3600)).isoformat()
    # Pre-seed a cap doc with one record that is OUTSIDE the rolling window.
    col.docs.append({
        "_id": "oid_seed", "clean_id": "carol",
        "nudge_lock_state": "idle",
        "authorizations": [{
            "event_key": _topup_nudge_event_key("carol", "oldsess"),
            "clean_id": "carol", "session_id": "oldsess",
            "authorization_source": "session_start", "authorized_at": old_ts,
        }],
    })

    async def scenario():
        return await _consume_topup_nudge_slot(
            col, clean_id="carol", session_id="newsess",
            authorization_source="session_start", cap=1, now=now)

    res = run(scenario())
    # The 8-day-old record is pruned, so the new one is authorized under cap=1.
    assert res["reason"] == "authorized"
    kept = col.docs[0]["authorizations"]
    assert len(kept) == 1
    assert kept[0]["session_id"] == "newsess"


def test_cap_disabled_when_cap_zero():
    col = _Coll()

    async def scenario():
        return await _consume_topup_nudge_slot(
            col, clean_id="dan", session_id="s1",
            authorization_source="session_start", cap=0)

    res = run(scenario())
    assert res["reason"] == "cap_disabled"
    assert res["record"] is None


# --------------------------------------------------------------------------- #
# Section: Gemini instruction line — present only when authorized, NO number. #
# --------------------------------------------------------------------------- #
def _si_kwargs(**over):
    base = dict(
        cfg={"focus_areas": ["pronunciation"]},
        mode_key="book_shadow", mode_cfg={"label": "Book Shadow"},
        student_name="Alice", points_balance=None,
        book_title="", chapter_title="", current_paragraph="",
        reading_progress="", saved_words=[], previous_reports=[],
        explain_language="en",
    )
    base.update(over)
    return base


def test_gemini_line_present_only_when_authorized():
    without = _build_system_instruction(**_si_kwargs(voice_authorized=False))
    assert _TOPUP_NUDGE_INSTRUCTION_LINE not in without
    with_line = _build_system_instruction(**_si_kwargs(voice_authorized=True))
    assert _TOPUP_NUDGE_INSTRUCTION_LINE in with_line


def test_gemini_nudge_line_contains_no_digit():
    assert not any(ch.isdigit() for ch in _TOPUP_NUDGE_INSTRUCTION_LINE)
    # And when injected with points_balance None (the start-path value), the
    # nudge line itself never introduces a number.
    line_only = _build_system_instruction(**_si_kwargs(voice_authorized=True))
    # The nudge sentence must not contain digits.
    assert _TOPUP_NUDGE_INSTRUCTION_LINE in line_only
    assert not any(ch.isdigit() for ch in _TOPUP_NUDGE_INSTRUCTION_LINE)


def test_settlement_reason_mapping():
    assert _topup_settlement_reason("completed_charged") == "completed_charged"
    assert _topup_settlement_reason("cancelled_partial") == "early_refund"
    assert _topup_settlement_reason("failed_refunded") == "failed_refunded"
    assert _topup_settlement_reason("expired") == "expired"


# --------------------------------------------------------------------------- #
# Section: Stage 2/3 integration through the registered route closures.       #
# --------------------------------------------------------------------------- #
def _build_routes(monkeypatch, *, threshold=15, cap=3, mode_cost=15):
    db = _DB()
    router = _Router()
    register_edutalk_live_routes(
        router, db, require_admin=object(), require_student=object())

    # Seed an ENABLED config with the nudge on. _load_config sanitises it.
    db["edutalk_live_config"].docs.append({
        "_id": "singleton",
        "config": {
            "enabled": True,
            "min_useful_seconds": 20,
            "free_trial_sessions": 0,           # force a PAID session
            "daily_session_limit": 10,
            "topup_nudge_enabled": True,
            "topup_nudge_threshold": threshold,
            "topup_nudge_max_per_week": cap,
            "modes": {"book_shadow": {"enabled": True, "label": "Book Shadow",
                                      "cost_points": mode_cost,
                                      "duration_seconds": 180}},
            "tier_rules": {"standard": {"enabled": True}},
        },
    })

    # All operator gates green; no real Gemini/WS/treasury needed.
    monkeypatch.setattr(elt, "_public_status", lambda: {
        "gemini_configured": True, "points_helpers_ok": True,
        "websockets_lib_ok": True, "refund_path_ok": True,
        "live_model": "test"})
    # Background loop disposal.
    monkeypatch.setattr(elt.asyncio, "get_event_loop", lambda: _DummyLoop())
    return db, router


async def _gas_bal_const(value):
    async def _f(clean_id, password):
        return value, ""
    return _f


def test_stage2_authorizes_and_does_not_double_subtract(monkeypatch):
    db, router = _build_routes(monkeypatch, threshold=15, cap=3, mode_cost=15)

    # Pre-reservation GAS balance = 30; reserve succeeds.
    async def gas_bal(clean_id, password):
        return 30, ""

    async def gas_debit(clean_id, password, amount):
        return True, ""
    monkeypatch.setattr(elt, "_gas_get_balance", gas_bal)
    monkeypatch.setattr(elt, "_gas_debit", gas_debit)

    start = router.routes[("POST", "/student/edutalk-live/session/start")]
    payload = StartSessionRequest(mode="book_shadow", password="pw",
                                  book_tier="standard")
    res = run(start(payload, student=_Student()))
    sid = res["session_id"]

    sess = run(db["edutalk_live_sessions"].find_one({"session_id": sid}))
    tn = sess["topup_nudge"]["authorization"]
    # post_reservation_balance = bal(30) - charged(15) = 15 — NOT
    # double-subtracted (would be 0 if re-subtracted).
    assert tn["balance_before_reservation"] == 30
    assert tn["points_reserved"] == 15
    assert tn["post_reservation_balance"] == 15
    assert tn["voice_authorized"] is True
    # Gemini system instruction got the single nudge line.
    assert _TOPUP_NUDGE_INSTRUCTION_LINE in sess["system_instruction"]
    # Exactly one cap slot consumed.
    capdoc = run(db[elt.TOPUP_NUDGE_LOG_COLLECTION].find_one(
        {"clean_id": "alice"}))
    assert len(capdoc["authorizations"]) == 1


def test_stage2_not_authorized_when_above_threshold(monkeypatch):
    db, router = _build_routes(monkeypatch, threshold=15, cap=3, mode_cost=15)

    async def gas_bal(clean_id, password):
        return 100, ""   # 100 - 15 = 85 > 15 → not eligible

    async def gas_debit(clean_id, password, amount):
        return True, ""
    monkeypatch.setattr(elt, "_gas_get_balance", gas_bal)
    monkeypatch.setattr(elt, "_gas_debit", gas_debit)

    start = router.routes[("POST", "/student/edutalk-live/session/start")]
    res = run(start(StartSessionRequest(mode="book_shadow", password="pw",
                                        book_tier="standard"),
                    student=_Student()))
    sid = res["session_id"]
    sess = run(db["edutalk_live_sessions"].find_one({"session_id": sid}))
    assert "topup_nudge" not in sess
    assert _TOPUP_NUDGE_INSTRUCTION_LINE not in sess["system_instruction"]
    # No cap slot consumed.
    capdoc = run(db[elt.TOPUP_NUDGE_LOG_COLLECTION].find_one(
        {"clean_id": "alice"}))
    assert capdoc is None or len(capdoc.get("authorizations", [])) == 0


def _finalize_completed(db, router, sid, settled_values, monkeypatch):
    """Drive a completed finalization through the REST end route, with the
    settled-balance read returning the next value from settled_values."""
    seq = list(settled_values)

    async def wallet_read(_db, _student_id):
        v = seq.pop(0)
        if v is None:
            return None, False
        return v, True
    monkeypatch.setattr(elt, "_wallet_balance_via_public_method", wallet_read)

    # Simulate the session became active long enough to "complete".
    run(db["edutalk_live_sessions"].update_one(
        {"session_id": sid},
        {"$set": {"active_ts": __import__("time").time() - 60,
                  "state": "active"}}))
    end = router.routes[("POST", "/student/edutalk-live/session/end")]
    return run(end(EndSessionRequest(session_id=sid, reason="client_end"),
                   student=_Student()))


def test_stage3_reuses_stage2_no_extra_slot(monkeypatch):
    db, router = _build_routes(monkeypatch, threshold=15, cap=3, mode_cost=15)

    async def gas_bal(clean_id, password):
        return 30, ""

    async def gas_debit(clean_id, password, amount):
        return True, ""
    monkeypatch.setattr(elt, "_gas_get_balance", gas_bal)
    monkeypatch.setattr(elt, "_gas_debit", gas_debit)

    start = router.routes[("POST", "/student/edutalk-live/session/start")]
    res = run(start(StartSessionRequest(mode="book_shadow", password="pw",
                                        book_tier="standard"),
                    student=_Student()))
    sid = res["session_id"]

    # Settled balance still at/under threshold → report eligible, reuse Stage 2.
    _finalize_completed(db, router, sid, [12], monkeypatch)
    sess = run(db["edutalk_live_sessions"].find_one({"session_id": sid}))
    fin = sess["topup_nudge"]["finalization"]
    assert fin["settled_balance"] == 12
    assert fin["report_eligible"] is True
    assert fin["reason"] == "balance_at_or_below_threshold_after_settlement"
    # No EXTRA slot consumed (still exactly one).
    capdoc = run(db[elt.TOPUP_NUDGE_LOG_COLLECTION].find_one(
        {"clean_id": "alice"}))
    assert len(capdoc["authorizations"]) == 1

    # The report-pill endpoint renders only from the finalization.
    nudge_ep = router.routes[("GET", "/student/edutalk-live/topup-nudge/{session_id}")]
    out = run(nudge_ep(sid, student=_Student()))
    assert out["report_eligible"] is True
    assert out["finalization"]["settled_balance"] == 12


def test_stage3_refund_above_threshold_suppresses_pill(monkeypatch):
    db, router = _build_routes(monkeypatch, threshold=15, cap=3, mode_cost=15)

    async def gas_bal(clean_id, password):
        return 30, ""

    async def gas_debit(clean_id, password, amount):
        return True, ""

    async def treasury_credit(clean_id, amount):
        return True, ""
    monkeypatch.setattr(elt, "_gas_get_balance", gas_bal)
    monkeypatch.setattr(elt, "_gas_debit", gas_debit)
    monkeypatch.setattr(elt, "_gas_treasury_credit", treasury_credit)

    start = router.routes[("POST", "/student/edutalk-live/session/start")]
    res = run(start(StartSessionRequest(mode="book_shadow", password="pw",
                                        book_tier="standard"),
                    student=_Student()))
    sid = res["session_id"]
    # Stage 2 authorized (voice). Now a refund pushes the settled balance ABOVE
    # threshold → the report pill is suppressed even after Stage-2 auth.

    seq = [27]

    async def wallet_read(_db, _student_id):
        return seq.pop(0), True
    monkeypatch.setattr(elt, "_wallet_balance_via_public_method", wallet_read)

    # Early cancel (< min_useful) → cancelled_partial (refund).
    run(db["edutalk_live_sessions"].update_one(
        {"session_id": sid},
        {"$set": {"active_ts": __import__("time").time() - 2,
                  "state": "active"}}))
    end = router.routes[("POST", "/student/edutalk-live/session/end")]
    run(end(EndSessionRequest(session_id=sid, reason="client_cancel"),
            student=_Student()))

    sess = run(db["edutalk_live_sessions"].find_one({"session_id": sid}))
    fin = sess["topup_nudge"]["finalization"]
    assert fin["settlement_reason"] == "early_refund"
    assert fin["report_eligible"] is False
    assert fin["reason"] == "balance_above_threshold_after_settlement"
    # The voice authorization still stands (Gemini already ran), but the pill
    # is suppressed.
    assert sess["topup_nudge"]["authorization"]["voice_authorized"] is True


def test_stage3_only_authorization_when_stage2_did_not_qualify(monkeypatch):
    db, router = _build_routes(monkeypatch, threshold=15, cap=3, mode_cost=15)

    # Start-time balance HIGH → Stage 2 does NOT authorize.
    async def gas_bal(clean_id, password):
        return 100, ""

    async def gas_debit(clean_id, password, amount):
        return True, ""
    monkeypatch.setattr(elt, "_gas_get_balance", gas_bal)
    monkeypatch.setattr(elt, "_gas_debit", gas_debit)

    start = router.routes[("POST", "/student/edutalk-live/session/start")]
    res = run(start(StartSessionRequest(mode="book_shadow", password="pw",
                                        book_tier="standard"),
                    student=_Student()))
    sid = res["session_id"]
    sess = run(db["edutalk_live_sessions"].find_one({"session_id": sid}))
    assert "topup_nudge" not in sess   # Stage 2 did not authorize

    # Another device drained the wallet → settled balance now UNDER threshold.
    _finalize_completed(db, router, sid, [10], monkeypatch)
    sess = run(db["edutalk_live_sessions"].find_one({"session_id": sid}))
    tn = sess["topup_nudge"]
    assert tn["finalization"]["report_eligible"] is True
    # Stage-3-only: report authorized, voice NOT (Gemini already ran).
    assert tn["report_authorized"] is True
    assert tn["authorization"]["voice_authorized"] is False
    # Exactly one slot consumed (the post_settlement one).
    capdoc = run(db[elt.TOPUP_NUDGE_LOG_COLLECTION].find_one(
        {"clean_id": "alice"}))
    assert len(capdoc["authorizations"]) == 1
    assert capdoc["authorizations"][0]["authorization_source"] == "post_settlement"


def test_stage3_only_suppressed_when_cap_reached(monkeypatch):
    # cap=0 → no post-settlement slot available → pill suppressed.
    db, router = _build_routes(monkeypatch, threshold=15, cap=0, mode_cost=15)

    async def gas_bal(clean_id, password):
        return 100, ""

    async def gas_debit(clean_id, password, amount):
        return True, ""
    monkeypatch.setattr(elt, "_gas_get_balance", gas_bal)
    monkeypatch.setattr(elt, "_gas_debit", gas_debit)

    start = router.routes[("POST", "/student/edutalk-live/session/start")]
    res = run(start(StartSessionRequest(mode="book_shadow", password="pw",
                                        book_tier="standard"),
                    student=_Student()))
    sid = res["session_id"]
    _finalize_completed(db, router, sid, [10], monkeypatch)
    sess = run(db["edutalk_live_sessions"].find_one({"session_id": sid}))
    fin = sess["topup_nudge"]["finalization"]
    assert fin["report_eligible"] is False
    assert fin["reason"] == "weekly_cap_reached"


def test_stage1_config_endpoint_flag_off_no_numbers(monkeypatch):
    db, router = _build_routes(monkeypatch, threshold=15, cap=3, mode_cost=15)
    monkeypatch.delenv("USE_MONGO_POINTS_READ", raising=False)  # default off
    cfg_ep = router.routes[("GET", "/student/edutalk-live/config")]
    out = run(cfg_ep(student=_Student()))
    previews = out["topup_nudge_previews_by_mode"]
    assert "book_shadow" in previews
    assert previews["book_shadow"]["reason"] == "balance_unavailable_for_preview"
    assert "verified_current_balance" not in previews["book_shadow"]


def test_stage1_config_endpoint_flag_on_real_numbers(monkeypatch):
    db, router = _build_routes(monkeypatch, threshold=15, cap=3, mode_cost=15)
    monkeypatch.setenv("USE_MONGO_POINTS_READ", "true")

    async def wallet_read(_db, _student_id):
        return 20, True
    monkeypatch.setattr(elt, "_wallet_balance_via_public_method", wallet_read)

    cfg_ep = router.routes[("GET", "/student/edutalk-live/config")]
    out = run(cfg_ep(student=_Student()))
    pv = out["topup_nudge_previews_by_mode"]["book_shadow"]
    assert pv["enabled"] is True
    assert pv["verified_current_balance"] == 20
    assert pv["projected_post_reservation_balance"] == 5
    assert pv["eligible"] is True
    assert pv["reason"] == "projected_balance_at_or_below_threshold"


def test_stage1_config_exposes_admin_threshold_for_client_fallback(monkeypatch):
    # v2.1 blocker: the student config endpoint MUST surface the admin
    # threshold so the client-side fallback uses it (admin 50) instead of the
    # hardcoded default 15 that suppressed the start pill in production.
    db, router = _build_routes(monkeypatch, threshold=50, cap=3, mode_cost=15)
    monkeypatch.delenv("USE_MONGO_POINTS_READ", raising=False)  # preview off
    cfg_ep = router.routes[("GET", "/student/edutalk-live/config")]
    out = run(cfg_ep(student=_Student()))

    # (a) the admin threshold is exposed (the fix), not silently defaulted.
    assert out["topup_nudge_enabled"] is True
    assert out["topup_nudge_threshold"] == 50
    # (b) backend preview is balance-gated (the exact reported case).
    pv = out["topup_nudge_previews_by_mode"]["book_shadow"]
    assert pv["reason"] == "balance_unavailable_for_preview"

    # (c) exact case mirrors EduTalkLiveCoach.jsx clientFallbackPreview:
    #         projected = balance - cost ; eligible = projected <= threshold
    balance, cost = 40, 15
    threshold = out["topup_nudge_threshold"]            # 50 from the response
    projected = balance - cost                          # 25
    assert (projected <= threshold) is True             # 25 <= 50 -> pill SHOWS
    # Regression guard: the old hardcoded default would have HIDDEN the pill.
    assert (projected <= 15) is False                   # 25 <= 15 -> hidden (bug)


def test_stage1_config_exposes_cap_status_for_client_fallback(monkeypatch):
    # v2.2 blocker: the student config endpoint MUST surface the weekly-cap
    # status at the top level. The client-side fallback (used when the
    # backend preview reason is balance_unavailable_for_preview) needs the
    # cap state to gate the pill — the per-mode preview alone is not enough
    # because the unavailable-preview branch carries no weekly_cap_available
    # field.
    db, router = _build_routes(monkeypatch, threshold=50, cap=3, mode_cost=15)
    monkeypatch.delenv("USE_MONGO_POINTS_READ", raising=False)  # preview off
    cfg_ep = router.routes[("GET", "/student/edutalk-live/config")]
    out = run(cfg_ep(student=_Student()))
    # Cap available (no slots consumed), reason "ok".
    assert out["topup_nudge_cap_available"] is True
    assert out["topup_nudge_cap_reason"] == "ok"
    # And the preview is still balance-gated (numeric figures not exposed).
    pv = out["topup_nudge_previews_by_mode"]["book_shadow"]
    assert pv["reason"] == "balance_unavailable_for_preview"


def test_stage1_config_cap_exhausted_blocks_fallback(monkeypatch):
    # v2.2 blocker: when the weekly cap is exhausted, the config MUST report
    # cap_available=false (reason weekly_cap_reached) so the client fallback
    # suppresses the pill — preserving server-side cap enforcement.
    db, router = _build_routes(monkeypatch, threshold=50, cap=1, mode_cost=15)
    monkeypatch.delenv("USE_MONGO_POINTS_READ", raising=False)  # preview off
    # Seed an authorization within the rolling window → cap is full.
    run(db[elt.TOPUP_NUDGE_LOG_COLLECTION].insert_one({
        "clean_id": "alice",
        "authorizations": [{
            "event_key": "alice-prior-session",
            "clean_id": "alice", "session_id": "prior",
            "authorization_source": "voice_pre_session",
            "authorized_at": _now().isoformat(),
        }],
        "nudge_lock_state": "idle",
    }))
    cfg_ep = router.routes[("GET", "/student/edutalk-live/config")]
    out = run(cfg_ep(student=_Student()))
    assert out["topup_nudge_cap_available"] is False
    assert out["topup_nudge_cap_reason"] == "weekly_cap_reached"


def test_stage1_config_cap_disabled_when_cap_zero(monkeypatch):
    # cap = 0 → reason "cap_disabled" (admin has not enabled the weekly cap).
    db, router = _build_routes(monkeypatch, threshold=50, cap=0, mode_cost=15)
    monkeypatch.delenv("USE_MONGO_POINTS_READ", raising=False)
    cfg_ep = router.routes[("GET", "/student/edutalk-live/config")]
    out = run(cfg_ep(student=_Student()))
    assert out["topup_nudge_cap_available"] is False
    assert out["topup_nudge_cap_reason"] == "cap_disabled"


def test_stage1_config_cap_fields_absent_features_off(monkeypatch):
    # Feature disabled → cap_available=false, reason=feature_disabled, and the
    # threshold is gated to 0 (existing v2.1 invariant remains).
    db, router = _build_routes(monkeypatch, threshold=50, cap=3, mode_cost=15)
    # Disable the nudge after seeding (in-memory _Coll has no dot-notation
    # support, so replace the embedded config dict in place).
    seeded = db["edutalk_live_config"].docs[0]
    seeded["config"]["topup_nudge_enabled"] = False
    monkeypatch.delenv("USE_MONGO_POINTS_READ", raising=False)
    cfg_ep = router.routes[("GET", "/student/edutalk-live/config")]
    out = run(cfg_ep(student=_Student()))
    assert out["topup_nudge_enabled"] is False
    assert out["topup_nudge_threshold"] == 0
    assert out["topup_nudge_cap_available"] is False
    assert out["topup_nudge_cap_reason"] == "feature_disabled"


def test_stage1_loading_config_never_writes_cap_event(monkeypatch):
    db, router = _build_routes(monkeypatch, threshold=15, cap=3, mode_cost=15)
    monkeypatch.setenv("USE_MONGO_POINTS_READ", "true")

    async def wallet_read(_db, _student_id):
        return 20, True
    monkeypatch.setattr(elt, "_wallet_balance_via_public_method", wallet_read)
    cfg_ep = router.routes[("GET", "/student/edutalk-live/config")]
    run(cfg_ep(student=_Student()))
    run(cfg_ep(student=_Student()))
    # Stage 1 must NEVER consume / create a cap slot.
    capdoc = run(db[elt.TOPUP_NUDGE_LOG_COLLECTION].find_one(
        {"clean_id": "alice"}))
    assert capdoc is None or len(capdoc.get("authorizations", [])) == 0


def test_admin_put_rejects_invalid_threshold(monkeypatch):
    db, router = _build_routes(monkeypatch)
    put = router.routes[("PUT", "/admin/edutalk-live/config")]
    with pytest.raises(Exception) as ei:
        run(put({"config": {"topup_nudge_threshold": -5}}, admin=_Admin()))
    # FastAPI HTTPException carries status_code + detail.
    exc = ei.value
    assert getattr(exc, "status_code", None) == 400
    assert getattr(exc, "detail", "") == "threshold_invalid"



# --------------------------------------------------------------------------- #
# Section: BUG-A regression — UNMOCKED real wallet reads at BOTH call sites.   #
# These tests do NOT monkeypatch _wallet_balance_via_public_method. They seed  #
# a real wallet document in the same `points_wallets` collection WalletService #
# reads, then drive the REAL endpoints — so the call-site identifier itself is #
# exercised (the prior bug passed `student_id` which resolved to "" and made   #
# _norm_id raise, silently yielding None). With the fix (clean_id) the real    #
# balance flows through.                                                       #
# --------------------------------------------------------------------------- #
def _seed_real_wallet(db, clean_id, balance):
    """Seed a wallet via the same points_wallets collection WalletService reads
    (student_id field carries the clean_id in this system's migrated wallets)."""
    run(db["points_wallets"].insert_one({
        "student_id": clean_id, "clean_id": clean_id,
        "balance": balance, "status": "active",
    }))


def test_stage1_unmocked_real_wallet_read(monkeypatch):
    db, router = _build_routes(monkeypatch, threshold=15, cap=3, mode_cost=15)
    monkeypatch.setenv("USE_MONGO_POINTS_READ", "true")
    # Real wallet = 20. NOTE: no monkeypatch of _wallet_balance_via_public_method.
    _seed_real_wallet(db, "alice", 20)

    cfg_ep = router.routes[("GET", "/student/edutalk-live/config")]
    out = run(cfg_ep(student=_Student()))
    pv = out["topup_nudge_previews_by_mode"]["book_shadow"]
    # Proves the Stage 1 CALL SITE passes the correct identifier (clean_id):
    # the real seeded balance flows through, not None.
    assert pv["enabled"] is True
    assert pv["verified_current_balance"] == 20
    assert pv["projected_post_reservation_balance"] == 5
    assert pv["eligible"] is True
    assert pv["reason"] == "projected_balance_at_or_below_threshold"


def test_stage3_unmocked_real_wallet_settled_balance(monkeypatch):
    db, router = _build_routes(monkeypatch, threshold=15, cap=3, mode_cost=15)

    async def gas_bal(clean_id, password):
        return 30, ""

    async def gas_debit(clean_id, password, amount):
        return True, ""
    monkeypatch.setattr(elt, "_gas_get_balance", gas_bal)
    monkeypatch.setattr(elt, "_gas_debit", gas_debit)
    # Real settled wallet = 12. NOTE: the wallet-read function is NOT mocked.
    _seed_real_wallet(db, "alice", 12)

    start = router.routes[("POST", "/student/edutalk-live/session/start")]
    res = run(start(StartSessionRequest(mode="book_shadow", password="pw",
                                        book_tier="standard"),
                    student=_Student()))
    sid = res["session_id"]

    # Complete the session (>= min_useful) WITHOUT mocking the wallet read.
    run(db["edutalk_live_sessions"].update_one(
        {"session_id": sid},
        {"$set": {"active_ts": time.time() - 60, "state": "active"}}))
    end = router.routes[("POST", "/student/edutalk-live/session/end")]
    run(end(EndSessionRequest(session_id=sid, reason="client_end"),
            student=_Student()))

    sess = run(db["edutalk_live_sessions"].find_one({"session_id": sid}))
    fin = sess["topup_nudge"]["finalization"]
    # Proves the Stage 3 CALL SITE reads the REAL wallet via clean_id.
    assert fin["settled_balance"] == 12
    assert fin["report_eligible"] is True
    assert fin["reason"] == "balance_at_or_below_threshold_after_settlement"

    # And the report-pill endpoint surfaces that real finalized balance.
    nudge_ep = router.routes[
        ("GET", "/student/edutalk-live/topup-nudge/{session_id}")]
    out = run(nudge_ep(sid, student=_Student()))
    assert out["finalization"]["settled_balance"] == 12
