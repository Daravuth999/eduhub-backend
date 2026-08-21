"""
Friday Vault — individual mechanic tests.

test_speaking_lab_vault.py already covers the common grant path (flag
gating, idempotency, hard caps, admin config round-trip). This file
exercises the six mechanics' OWN distinguishing behavior individually:

  * Double Ticket / Multiplier / Box Boost — token-status reporting
    (get_vault_tokens_status), the substrate the Lucky Draw / Mystery Box
    integration reads.
  * Multiplier  — apply_vault_bonuses_to_draw: real amount adjustment on a
    prepared-but-not-finalized Lucky Draw, capped, idempotent, session-
    isolated, safely no-op once finalized.
  * Team Vault  — accumulation, threshold, exactly-once trigger, duplicate
    prevention under concurrency, session isolation, settlement record.
  * Risk & Reward — statistical win/lose distribution, capped either way.
  * Lucky Protection — always the top of the configured range, no downside.
  * Box Boost — best-of-N reroll via the REAL, unmodified
    _mbt_resolve_campaign_layout, proven against mystery_box_tools.py
    directly (not a reimplementation).
"""
from __future__ import annotations

import asyncio
import copy
import random

import pytest

import speaking_lab_vault as vault


# ── fake Mongo, extended with distinct() and a positional-array-update
# ($ operator matched via a dotted query key, e.g. "results.student_id")
# (Motor/pymongo shape) ─────────────────────────────────────────────────
def _match_leaf(actual, v):
    if isinstance(v, dict) and "$ne" in v:
        return actual != v["$ne"]
    if isinstance(v, dict) and "$in" in v:
        return actual in v["$in"]
    return actual == v


def _match(doc, query):
    for k, v in (query or {}).items():
        if "." in k:
            arr_field, sub = k.split(".", 1)
            arr = doc.get(arr_field)
            if isinstance(arr, list):
                if not any(
                    isinstance(elem, dict) and _match_leaf(elem.get(sub), v)
                    for elem in arr
                ):
                    return False
                continue
            if not _match_leaf(doc.get(k), v):
                return False
            continue
        if not _match_leaf(doc.get(k), v):
            return False
    return True


class _Result:
    def __init__(self, matched=0):
        self.matched_count = matched


class _Cursor:
    def __init__(self, docs):
        self._docs = list(docs)

    def sort(self, field, direction=1):
        self._docs.sort(key=lambda d: d.get(field) or "", reverse=(direction < 0))
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
    def __init__(self):
        self._docs: list[dict] = []
        self._lock = asyncio.Lock()

    async def create_index(self, *a, **k):
        return "idx"

    async def insert_one(self, doc):
        async with self._lock:
            self._docs.append(copy.deepcopy(doc))

    async def find_one(self, query, projection=None, sort=None):
        docs = [d for d in self._docs if _match(d, query)]
        if sort:
            for field, direction in reversed(sort):
                docs.sort(key=lambda d: d.get(field) or "", reverse=(direction < 0))
        return copy.deepcopy(docs[0]) if docs else None

    def find(self, query, projection=None):
        return _Cursor([copy.deepcopy(d) for d in self._docs if _match(d, query)])

    async def count_documents(self, query):
        return sum(1 for d in self._docs if _match(d, query))

    async def distinct(self, field, query=None):
        vals = {d.get(field) for d in self._docs if _match(d, query) and d.get(field) is not None}
        return sorted(vals)

    async def update_one(self, query, update, upsert=False):
        async with self._lock:
            target = next((d for d in self._docs if _match(d, query)), None)
            if target is None:
                if upsert:
                    nd = {k: v for k, v in query.items() if not isinstance(v, dict) and "." not in k}
                    nd.update(update.get("$setOnInsert", {}))
                    nd.update({k: v for k, v in update.get("$set", {}).items() if ".$." not in k})
                    self._docs.append(nd)
                    return _Result(matched=0)
                return _Result(matched=0)

            # Positional ($) array-element update: the array-element match
            # comes from the query's own dotted key (e.g. "results.student_id").
            arr_match_field = arr_match_val = None
            for k, v in query.items():
                if "." in k:
                    _, arr_match_field = k.split(".", 1)
                    arr_match_val = v
                    break

            for op, coerce in (("$set", lambda old, v: v), ("$inc", lambda old, v: (old or 0) + v)):
                for k, v in update.get(op, {}).items():
                    if ".$." in k:
                        field, sub = k.split(".$.", 1)
                        arr = target.get(field)
                        if isinstance(arr, list) and arr_match_field is not None:
                            for elem in arr:
                                if isinstance(elem, dict) and _match_leaf(elem.get(arr_match_field), arr_match_val):
                                    elem[sub] = coerce(elem.get(sub), v)
                    else:
                        target[k] = coerce(target.get(k), v)
            return _Result(matched=1)


class _FakeDB:
    def __init__(self):
        self._cols: dict[str, _FakeCollection] = {}

    def __getitem__(self, name):
        return self._cols.setdefault(name, _FakeCollection())


async def _grant(db, config, *, session_id, round_key, student_id, rule_type, credit_calls):
    """Directly seeds a GRANTED vault token row + fires the credit hook,
    bypassing the HTTP route (already covered elsewhere) so these tests
    can force a specific rule_type/session without depending on weekly
    rotation randomness."""
    amount, risk_outcome = vault._resolve_amount(rule_type, config)
    meta = vault.VAULT_RULE_TYPES[rule_type]
    if amount > 0:
        credit_calls.append((student_id, amount))
    await db[vault.GRANTS_COLLECTION].insert_one({
        "id": f"g-{session_id}-{round_key}-{student_id}",
        "session_id": session_id, "round_key": round_key,
        "student_id": student_id, "student_id_norm": student_id.strip().lower(),
        "student_name": student_id, "status": "granted",
        "rule_type": rule_type, "label": meta["label"], "reveal_line": meta["reveal_line"],
        "amount": amount, "risk_outcome": risk_outcome, "granted_at": vault._now_iso(),
    })
    return amount, risk_outcome


class _CreditRecorder:
    def __init__(self, ok=True):
        self.ok = ok
        self.calls: list[tuple[str, int]] = []

    async def __call__(self, *, student_clean_id, points, campaign_id, campaign_name):
        self.calls.append((student_clean_id, points))
        return {"ok": self.ok} if self.ok else {"ok": False, "error": "declined"}


# ═════════════════════════════════════════════════════════════════════════
# Token status reporting (Double Ticket / Multiplier / Box Boost substrate)
# ═════════════════════════════════════════════════════════════════════════
@pytest.mark.asyncio
async def test_token_status_groups_by_mechanic_and_session():
    db = _FakeDB()
    config = await vault._read_config(db)
    calls: list = []
    await _grant(db, config, session_id="s1", round_key="r1", student_id="stu001", rule_type="double_ticket", credit_calls=calls)
    await _grant(db, config, session_id="s1", round_key="r2", student_id="stu002", rule_type="multiplier", credit_calls=calls)
    await _grant(db, config, session_id="s1", round_key="r3", student_id="stu003", rule_type="box_boost", credit_calls=calls)
    # A different session's grants must never leak into s1's status.
    await _grant(db, config, session_id="s2", round_key="r1", student_id="stu999", rule_type="double_ticket", credit_calls=calls)

    status = await vault.get_vault_tokens_status(db, "s1")
    assert status["double_ticket_student_ids"] == ["stu001"]
    assert status["multiplier_student_ids"] == ["stu002"]
    assert status["box_boost_student_ids"] == ["stu003"]


# ═════════════════════════════════════════════════════════════════════════
# Multiplier — apply_vault_bonuses_to_draw
# ═════════════════════════════════════════════════════════════════════════
async def _seed_prepared_draw(db, session_id, draw_id, results):
    await db[vault.SESSIONS_COLLECTION].insert_one(
        {"session_id": session_id, "lucky_draw_prepared_draw_id": draw_id})
    await db[vault.DRAWS_COLLECTION].insert_one({
        "draw_id": draw_id, "session_id": session_id, "finalized": False,
        "results": results, "prepared_at": vault._now_iso(),
    })


@pytest.mark.asyncio
async def test_multiplier_boosts_only_token_holders_amount():
    db = _FakeDB()
    config = await vault._read_config(db)
    calls: list = []
    await _grant(db, config, session_id="s1", round_key="r1", student_id="stu001", rule_type="multiplier", credit_calls=calls)
    await _seed_prepared_draw(db, "s1", "draw-1", [
        {"student_id": "stu001", "amount": 100},
        {"student_id": "stu002", "amount": 100},
    ])

    res = await vault.apply_vault_bonuses_to_draw(db, "s1")
    assert res["applied"] is True
    assert res["boosted_count"] == 1

    draw = await db[vault.DRAWS_COLLECTION].find_one({"draw_id": "draw-1"})
    winners = {w["student_id"]: w["amount"] for w in draw["results"]}
    assert winners["stu001"] == 100 + round(100 * (config["multiplier"] - 1.0))
    assert winners["stu002"] == 100  # untouched — no token


@pytest.mark.asyncio
async def test_multiplier_bonus_never_exceeds_hard_cap():
    db = _FakeDB()
    # Hand-craft an out-of-range stored config to prove the READ path clamps it.
    await db[vault.SETTINGS_COLLECTION].insert_one({"_id": vault.CONFIG_DOC_ID, "multiplier": 999.0})
    config = await vault._read_config(db)
    assert config["multiplier"] <= vault.HARD_CAP_MULTIPLIER

    calls: list = []
    await _grant(db, config, session_id="s1", round_key="r1", student_id="stu001", rule_type="multiplier", credit_calls=calls)
    await _seed_prepared_draw(db, "s1", "draw-1", [{"student_id": "stu001", "amount": 100}])

    await vault.apply_vault_bonuses_to_draw(db, "s1")
    draw = await db[vault.DRAWS_COLLECTION].find_one({"draw_id": "draw-1"})
    boosted_amount = draw["results"][0]["amount"]
    assert boosted_amount <= 100 * vault.HARD_CAP_MULTIPLIER


@pytest.mark.asyncio
async def test_multiplier_apply_is_idempotent_never_double_boosts():
    db = _FakeDB()
    config = await vault._read_config(db)
    calls: list = []
    await _grant(db, config, session_id="s1", round_key="r1", student_id="stu001", rule_type="multiplier", credit_calls=calls)
    await _seed_prepared_draw(db, "s1", "draw-1", [{"student_id": "stu001", "amount": 100}])

    first = await vault.apply_vault_bonuses_to_draw(db, "s1")
    second = await vault.apply_vault_bonuses_to_draw(db, "s1")
    assert first["applied"] is True and first["boosted_count"] == 1
    assert second["applied"] is False  # already applied — no-op

    draw = await db[vault.DRAWS_COLLECTION].find_one({"draw_id": "draw-1"})
    expected_once = 100 + round(100 * (config["multiplier"] - 1.0))
    assert draw["results"][0]["amount"] == expected_once  # not boosted twice


@pytest.mark.asyncio
async def test_multiplier_never_touches_an_already_finalized_draw():
    db = _FakeDB()
    config = await vault._read_config(db)
    calls: list = []
    await _grant(db, config, session_id="s1", round_key="r1", student_id="stu001", rule_type="multiplier", credit_calls=calls)
    await db[vault.SESSIONS_COLLECTION].insert_one(
        {"session_id": "s1", "lucky_draw_prepared_draw_id": "draw-1"})
    await db[vault.DRAWS_COLLECTION].insert_one({
        "draw_id": "draw-1", "session_id": "s1", "finalized": True,  # ALREADY PAYING OUT
        "results": [{"student_id": "stu001", "amount": 100}],
    })

    res = await vault.apply_vault_bonuses_to_draw(db, "s1")
    assert res["applied"] is False
    draw = await db[vault.DRAWS_COLLECTION].find_one({"draw_id": "draw-1"})
    assert draw["results"][0]["amount"] == 100  # untouched


@pytest.mark.asyncio
async def test_multiplier_no_prepared_draw_is_a_clean_noop():
    db = _FakeDB()
    res = await vault.apply_vault_bonuses_to_draw(db, "no-such-session")
    assert res == {"applied": False, "reason": "no_prepared_draw"}


@pytest.mark.asyncio
async def test_multiplier_session_isolation():
    db = _FakeDB()
    config = await vault._read_config(db)
    calls: list = []
    await _grant(db, config, session_id="s1", round_key="r1", student_id="stu001", rule_type="multiplier", credit_calls=calls)
    await _seed_prepared_draw(db, "s1", "draw-1", [{"student_id": "stu001", "amount": 100}])
    await _seed_prepared_draw(db, "s2", "draw-2", [{"student_id": "stu001", "amount": 100}])

    await vault.apply_vault_bonuses_to_draw(db, "s1")
    draw2 = await db[vault.DRAWS_COLLECTION].find_one({"draw_id": "draw-2"})
    assert draw2["results"][0]["amount"] == 100  # s2's draw untouched by s1's token


# ═════════════════════════════════════════════════════════════════════════
# Team Vault — accumulation, threshold, trigger, duplicate prevention
# ═════════════════════════════════════════════════════════════════════════
@pytest.mark.asyncio
async def test_team_vault_does_not_trigger_below_threshold():
    db = _FakeDB()
    config = await vault._read_config(db)
    config["team_vault_threshold"] = 3
    credit = _CreditRecorder()
    calls: list = []
    await _grant(db, config, session_id="s1", round_key="r1", student_id="stu001", rule_type="team_vault", credit_calls=calls)
    await vault._maybe_trigger_team_vault(db, "s1", config, credit, log=__import__("logging").getLogger("t"))

    state = await db[vault.TEAM_COLLECTION].find_one({"_id": "s1"})
    assert not (state or {}).get("triggered")
    assert credit.calls == []


@pytest.mark.asyncio
async def test_team_vault_triggers_at_threshold_and_credits_every_ticketed_student():
    db = _FakeDB()
    config = await vault._read_config(db)
    config["team_vault_threshold"] = 2
    config["team_vault_bonus"] = 7
    credit = _CreditRecorder()
    calls: list = []
    await _grant(db, config, session_id="s1", round_key="r1", student_id="stu001", rule_type="team_vault", credit_calls=calls)
    await _grant(db, config, session_id="s1", round_key="r2", student_id="stu002", rule_type="team_vault", credit_calls=calls)
    # Whole-class roster comes from lucky codes, independent of who earned tokens.
    await db[vault.LUCKY_CODES_COLLECTION].insert_one({"session_id": "s1", "student_id": "stu001"})
    await db[vault.LUCKY_CODES_COLLECTION].insert_one({"session_id": "s1", "student_id": "stu002"})
    await db[vault.LUCKY_CODES_COLLECTION].insert_one({"session_id": "s1", "student_id": "stu003"})

    await vault._maybe_trigger_team_vault(db, "s1", config, credit, log=__import__("logging").getLogger("t"))

    assert sorted(sid for sid, _ in credit.calls) == ["stu001", "stu002", "stu003"]
    assert all(pts == 7 for _, pts in credit.calls)
    state = await db[vault.TEAM_COLLECTION].find_one({"_id": "s1"})
    assert state["triggered"] is True
    assert sorted(state["credited_student_ids"]) == ["stu001", "stu002", "stu003"]


@pytest.mark.asyncio
async def test_team_vault_never_triggers_twice_even_if_checked_repeatedly():
    db = _FakeDB()
    config = await vault._read_config(db)
    config["team_vault_threshold"] = 1
    credit = _CreditRecorder()
    calls: list = []
    await _grant(db, config, session_id="s1", round_key="r1", student_id="stu001", rule_type="team_vault", credit_calls=calls)
    await db[vault.LUCKY_CODES_COLLECTION].insert_one({"session_id": "s1", "student_id": "stu001"})

    log = __import__("logging").getLogger("t")
    await vault._maybe_trigger_team_vault(db, "s1", config, credit, log)
    await vault._maybe_trigger_team_vault(db, "s1", config, credit, log)
    await vault._maybe_trigger_team_vault(db, "s1", config, credit, log)

    assert len(credit.calls) == 1  # credited exactly once despite 3 checks


@pytest.mark.asyncio
async def test_team_vault_concurrent_checks_credit_exactly_once():
    db = _FakeDB()
    config = await vault._read_config(db)
    config["team_vault_threshold"] = 1
    credit = _CreditRecorder()
    calls: list = []
    await _grant(db, config, session_id="s1", round_key="r1", student_id="stu001", rule_type="team_vault", credit_calls=calls)
    await db[vault.LUCKY_CODES_COLLECTION].insert_one({"session_id": "s1", "student_id": "stu001"})
    log = __import__("logging").getLogger("t")

    await asyncio.gather(*[
        vault._maybe_trigger_team_vault(db, "s1", config, credit, log) for _ in range(5)
    ])
    assert len(credit.calls) == 1


@pytest.mark.asyncio
async def test_team_vault_session_isolation():
    db = _FakeDB()
    config = await vault._read_config(db)
    config["team_vault_threshold"] = 1
    credit = _CreditRecorder()
    calls: list = []
    await _grant(db, config, session_id="s1", round_key="r1", student_id="stu001", rule_type="team_vault", credit_calls=calls)
    await db[vault.LUCKY_CODES_COLLECTION].insert_one({"session_id": "s1", "student_id": "stu001"})
    log = __import__("logging").getLogger("t")

    await vault._maybe_trigger_team_vault(db, "s1", config, credit, log)
    state_s2 = await db[vault.TEAM_COLLECTION].find_one({"_id": "s2"})
    assert state_s2 is None  # s2 was never touched by s1's trigger


@pytest.mark.asyncio
async def test_team_vault_one_students_credit_failure_never_blocks_others():
    db = _FakeDB()
    config = await vault._read_config(db)
    config["team_vault_threshold"] = 1
    calls: list = []
    await _grant(db, config, session_id="s1", round_key="r1", student_id="stu001", rule_type="team_vault", credit_calls=calls)
    for sid in ("stu001", "stu002", "stu003"):
        await db[vault.LUCKY_CODES_COLLECTION].insert_one({"session_id": "s1", "student_id": sid})

    async def flaky_credit(*, student_clean_id, points, campaign_id, campaign_name):
        if student_clean_id == "stu002":
            raise RuntimeError("simulated treasury outage")
        return {"ok": True}

    log = __import__("logging").getLogger("t")
    await vault._maybe_trigger_team_vault(db, "s1", config, flaky_credit, log)
    state = await db[vault.TEAM_COLLECTION].find_one({"_id": "s1"})
    assert sorted(state["credited_student_ids"]) == ["stu001", "stu003"]
    assert state["failed_student_ids"] == ["stu002"]


# ═════════════════════════════════════════════════════════════════════════
# Risk & Reward — statistical win/lose, capped either way
# ═════════════════════════════════════════════════════════════════════════
def test_risk_reward_outcomes_are_capped_and_binary():
    config = {"base_min": 5, "base_max": 15, "multiplier": 1.5, "risk_win_probability": 0.5}
    seen = {"win": 0, "lose": 0}
    for _ in range(200):
        amount, outcome = vault._resolve_amount("risk_reward", config)
        assert outcome in ("win", "lose")
        if outcome == "win":
            assert 0 < amount <= config["base_max"] * 2
            seen["win"] += 1
        else:
            assert amount == 0
            seen["lose"] += 1
    # Over 200 trials at p=0.5, both outcomes must appear (astronomically
    # unlikely not to — proves the coin flip is genuinely two-sided).
    assert seen["win"] > 0 and seen["lose"] > 0


def test_risk_reward_probability_zero_never_wins():
    config = {"base_min": 5, "base_max": 15, "multiplier": 1.5, "risk_win_probability": 0.0}
    for _ in range(50):
        amount, outcome = vault._resolve_amount("risk_reward", config)
        assert outcome == "lose" and amount == 0


def test_risk_reward_probability_one_always_wins():
    config = {"base_min": 5, "base_max": 15, "multiplier": 1.5, "risk_win_probability": 1.0}
    for _ in range(50):
        amount, outcome = vault._resolve_amount("risk_reward", config)
        assert outcome == "win" and amount > 0


# ═════════════════════════════════════════════════════════════════════════
# Lucky Protection — always the top of the range, no downside variance
# ═════════════════════════════════════════════════════════════════════════
def test_lucky_protection_always_grants_the_top_of_the_range():
    config = {"base_min": 5, "base_max": 15, "multiplier": 1.5, "risk_win_probability": 0.5}
    for _ in range(50):
        amount, outcome = vault._resolve_amount("lucky_protection", config)
        assert amount == config["base_max"]
        assert outcome is None


# ═════════════════════════════════════════════════════════════════════════
# Box Boost — best-of-N reroll via the REAL, unmodified layout resolver
# ═════════════════════════════════════════════════════════════════════════
@pytest.mark.asyncio
async def test_box_boost_best_of_n_prefers_rarer_layout(monkeypatch):
    import pathlib
    import sys
    backend_dir = pathlib.Path(__file__).resolve().parent.parent
    if str(backend_dir) not in sys.path:
        sys.path.insert(0, str(backend_dir))
    import mystery_box_tools as mbt_module

    class _MBAdmin:
        email = "teacher@school.example"

    async def _require_admin():
        return _MBAdmin()

    async def _require_student():  # pragma: no cover
        return _MBAdmin()

    class _NoopPush:
        async def __call__(self, *a, **k):
            return (0, 0)

    class _NoopSubs:
        async def count_documents(self, query):
            return 0

    class _NoopHooks:
        credit_via_treasury = None
        issue_voucher_for_claim = None

    from fastapi import APIRouter

    db = _FakeDB()
    ns = mbt_module.register_mystery_box_routes(
        APIRouter(), db, _require_admin, _require_student,
        _NoopPush(), _NoopSubs(), _NoopHooks(),
    )

    await db["mystery_box_prize_templates"].insert_one(
        {"id": "p_common", "type": "points", "title": "Common", "rarity": "common", "enabled": True, "points": 5})
    await db["mystery_box_prize_templates"].insert_one(
        {"id": "p_legend", "type": "points", "title": "Legendary", "rarity": "legendary", "enabled": True, "points": 50})
    await db["speaking_lab_mystery_campaigns"].insert_one({
        "id": "camp-boost", "enabled": True, "box_count": 1,
        "prize_template_ids": ["p_common", "p_legend"], "weights": [],
    })

    # Force the underlying (UNMODIFIED) sampler's random.sample to return
    # "common" on the first two rolls and "legendary" on the third — proving
    # best-of-3 (boosted) surfaces the rarer roll, while a single
    # (non-boosted) call only ever sees the first, common roll.
    call_count = {"n": 0}

    def fake_sample(population, k):
        call_count["n"] += 1
        by_id = {p["id"]: p for p in population}
        return [by_id["p_common"] if call_count["n"] < 3 else by_id["p_legend"]]

    monkeypatch.setattr(random, "sample", fake_sample)

    RoundCreateIn = mbt_module._RoundCreateIn
    boosted_payload = RoundCreateIn(campaign_id="camp-boost", session_id="s1", boosted=True)
    boosted_res = await ns["mbt_create_round"](boosted_payload, admin=_MBAdmin())
    assert boosted_res["round"]["closed_boxes"][0]["rarity"] == "legendary"
    assert call_count["n"] == 3  # best-of-3 really rolled 3 times

    call_count["n"] = 0
    plain_payload = RoundCreateIn(campaign_id="camp-boost", session_id="s1", boosted=False)
    plain_res = await ns["mbt_create_round"](plain_payload, admin=_MBAdmin())
    assert call_count["n"] == 1  # non-boosted uses exactly the existing single roll
    assert plain_res["round"]["closed_boxes"][0]["rarity"] == "common"


@pytest.mark.asyncio
async def test_box_boost_defaults_off_identical_to_pre_vault_behavior():
    """A round-create call that never mentions `boosted` at all (every
    caller that existed before this feature) must behave byte-identically
    — one roll, no best-of-N."""
    import pathlib
    import sys
    backend_dir = pathlib.Path(__file__).resolve().parent.parent
    if str(backend_dir) not in sys.path:
        sys.path.insert(0, str(backend_dir))
    import mystery_box_tools as mbt_module
    from fastapi import APIRouter

    class _MBAdmin:
        email = "teacher@school.example"

    async def _require_admin():
        return _MBAdmin()

    async def _require_student():  # pragma: no cover
        return _MBAdmin()

    class _NoopPush:
        async def __call__(self, *a, **k):
            return (0, 0)

    class _NoopSubs:
        async def count_documents(self, query):
            return 0

    class _NoopHooks:
        credit_via_treasury = None
        issue_voucher_for_claim = None

    db = _FakeDB()
    ns = mbt_module.register_mystery_box_routes(
        APIRouter(), db, _require_admin, _require_student,
        _NoopPush(), _NoopSubs(), _NoopHooks(),
    )
    await db["mystery_box_prize_templates"].insert_one(
        {"id": "p_common", "type": "points", "title": "Common", "rarity": "common", "enabled": True, "points": 5})
    await db["speaking_lab_mystery_campaigns"].insert_one({
        "id": "camp-plain", "enabled": True, "box_count": 1,
        "prize_template_ids": ["p_common"], "weights": [],
    })

    RoundCreateIn = mbt_module._RoundCreateIn
    payload = RoundCreateIn.model_validate({"campaign_id": "camp-plain", "session_id": "s1"})
    assert payload.boosted is False  # new field defaults exactly as documented
    res = await ns["mbt_create_round"](payload, admin=_MBAdmin())
    assert res["round"]["box_count"] == 1
