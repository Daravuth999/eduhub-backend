"""tests/test_voice_treasure_attempt_concurrency.py
====================================================
v6 surgical-fix tests for the atomic compare-and-set claim in
``vt_submit_attempt``.

We construct the same in-memory fake DB the rest of the attempt suite uses
(``test_voice_treasure_attempt._DB``) extended with ``find_one_and_update``
semantics (the production code path now relies on Mongo's document-level
atomicity, which Mongo guarantees natively). The fakes in this test suite
execute serially under a single asyncio event loop — so "concurrent" here
means N submissions interleaved through the same loop. The behavioural
property we are asserting is that **exactly one** of those calls reaches
``vt_gemini.evaluate_speaking`` and that the losers see ``in_progress`` /
``already_evaluated`` without invoking the provider.

NO live provider call. The Gemini adapter is monkeypatched and counts
invocations.
"""
from __future__ import annotations

import asyncio
import copy

import pytest

import voice_treasure_config_tools as vt_cfg
import voice_treasure_entry_tools as vt_entry
import voice_treasure_gemini as vt_gemini
from voice_treasure_attempt_tools import (
    register_voice_treasure_attempt_routes,
    A_CREATED, A_EVALUATED, A_EVALUATING, A_FAILED, A_UNAVAILABLE,
    COLL_ATTEMPTS, _RETRYABLE, _attempt_key,
)

# Re-use the fakes already validated by test_voice_treasure_attempt.
from tests.test_voice_treasure_attempt import (  # type: ignore
    _DB, _Router, _Student, _Upload, _cfg, _seed_paid_entry, _aval, run,
)


@pytest.fixture(autouse=True)
def _env(monkeypatch):
    # Mirror the autouse env fixture from test_voice_treasure_attempt.py so
    # `available` returns True under the in-memory config projection.
    monkeypatch.setenv("VOICE_TREASURE_ENABLED", "1")
    yield


def _build_with_counter(monkeypatch, eval_outcome=("ok", None)):
    """Build the routes wired against an in-memory DB and count the number
    of times the Gemini adapter is called. This is the property under test."""
    db = _DB()
    router = _Router()
    register_voice_treasure_attempt_routes(
        router, db, require_admin=object(), require_student=object())
    monkeypatch.setattr(vt_cfg, "load_config",
                        lambda _db: _aval(copy.deepcopy(_cfg())))
    call_count = {"n": 0}

    async def fake_eval(**kw):
        call_count["n"] += 1
        kind, reason = eval_outcome
        if kind == "ok":
            return {"ok": True, "result": {
                "scores": {k: 70 for k in vt_gemini.EVAL_CATEGORIES},
                "overall": 70,
                "understanding_summary": "ok",
                "strongest_skill": "relevance",
                "next_improvement": "more detail",
                "coach_feedback": "good",
            }}
        return {"ok": False, "reason": reason}

    monkeypatch.setattr(vt_gemini, "evaluate_speaking", fake_eval)
    return db, router, call_count


def _post_submit(router, **kw):
    return router.routes[("POST", "/voice-treasure/submit-attempt")](**kw)


# ── 1. Two concurrent claims → exactly ONE provider call ─────────────────
def test_concurrent_claims_invoke_gemini_exactly_once(monkeypatch):
    db, router, calls = _build_with_counter(monkeypatch)
    ekey, _mid = _seed_paid_entry(db)

    async def go():
        return await asyncio.gather(
            _post_submit(router, entry_id=ekey, audio=_Upload(),
                         student=_Student()),
            _post_submit(router, entry_id=ekey, audio=_Upload(),
                         student=_Student()),
        )

    a, b = run(go())
    assert calls["n"] == 1, f"expected 1 Gemini call, got {calls['n']}"
    # Exactly one of the two responses must be the winner (evaluated) and
    # the other must be either in_progress or already_evaluated.
    winners = [r for r in (a, b) if r.get("attempt", {}).get("state") == A_EVALUATED]
    loser_flags = [r for r in (a, b) if r.get("in_progress") or r.get("already_evaluated")]
    assert len(winners) >= 1
    assert len(loser_flags) >= 1


# ── 2. Many concurrent claims → still exactly one provider call ──────────
@pytest.mark.parametrize("n", [4, 8, 16])
def test_high_fanout_claims_still_one_provider_call(monkeypatch, n):
    db, router, calls = _build_with_counter(monkeypatch)
    ekey, _mid = _seed_paid_entry(db)

    async def go():
        return await asyncio.gather(*[
            _post_submit(router, entry_id=ekey, audio=_Upload(),
                         student=_Student()) for _ in range(n)
        ])

    results = run(go())
    assert calls["n"] == 1, f"expected 1 Gemini call under fanout={n}, got {calls['n']}"
    assert any(r.get("attempt", {}).get("state") == A_EVALUATED for r in results)


# ── 3. Loser receives in_progress / already_evaluated (no Gemini) ────────
def test_loser_sees_in_progress_or_already_evaluated(monkeypatch):
    db, router, calls = _build_with_counter(monkeypatch)
    ekey, _mid = _seed_paid_entry(db)
    sid = "stu_alice"
    akey = _attempt_key(sid, ekey)

    # Pre-seed an attempt already in EVALUATING — the loser path.
    db[COLL_ATTEMPTS].docs[akey] = {
        "_id": akey, "attempt_id": akey, "student_id": sid,
        "entry_id": ekey, "state": A_EVALUATING, "submit_count": 1,
    }

    res = run(_post_submit(router, entry_id=ekey, audio=_Upload(),
                            student=_Student()))
    assert calls["n"] == 0, "Gemini must not be called when state is EVALUATING"
    assert res.get("in_progress") is True
    assert res["attempt"]["state"] == A_EVALUATING


# ── 4. Already-evaluated returns persisted result (no Gemini) ────────────
def test_already_evaluated_returns_persisted_result(monkeypatch):
    db, router, calls = _build_with_counter(monkeypatch)
    ekey, _mid = _seed_paid_entry(db)
    sid = "stu_alice"
    akey = _attempt_key(sid, ekey)

    persisted = {
        "scores": {k: 80 for k in vt_gemini.EVAL_CATEGORIES},
        "overall": 80,
        "understanding_summary": "persisted_summary",
        "strongest_skill": "relevance",
        "next_improvement": "persisted_next",
        "coach_feedback": "persisted_feedback",
    }
    db[COLL_ATTEMPTS].docs[akey] = {
        "_id": akey, "attempt_id": akey, "student_id": sid,
        "entry_id": ekey, "state": A_EVALUATED,
        "result": persisted, "submit_count": 1,
    }

    res = run(_post_submit(router, entry_id=ekey, audio=_Upload(),
                            student=_Student()))
    assert calls["n"] == 0, "Gemini must not be called when already evaluated"
    assert res.get("already_evaluated") is True
    # Persisted result is returned verbatim through the view.
    assert res["attempt"]["state"] == A_EVALUATED


# ── 5. Retryable failure can be re-claimed; exactly one Gemini call ─────
@pytest.mark.parametrize("retryable_state", [A_CREATED, A_FAILED, A_UNAVAILABLE])
def test_retryable_state_can_claim_once(monkeypatch, retryable_state):
    assert retryable_state in _RETRYABLE
    db, router, calls = _build_with_counter(monkeypatch)
    ekey, _mid = _seed_paid_entry(db)
    sid = "stu_alice"
    akey = _attempt_key(sid, ekey)
    db[COLL_ATTEMPTS].docs[akey] = {
        "_id": akey, "attempt_id": akey, "student_id": sid,
        "entry_id": ekey, "state": retryable_state, "submit_count": 1,
    }

    res = run(_post_submit(router, entry_id=ekey, audio=_Upload(),
                            student=_Student()))
    assert calls["n"] == 1, f"expected exactly 1 Gemini call from {retryable_state}, got {calls['n']}"
    assert res["attempt"]["state"] == A_EVALUATED


# ── 6. Non-retryable state cannot call Gemini ───────────────────────────
def test_non_retryable_state_rejects_without_gemini(monkeypatch):
    db, router, calls = _build_with_counter(monkeypatch)
    ekey, _mid = _seed_paid_entry(db)
    sid = "stu_alice"
    akey = _attempt_key(sid, ekey)
    # A locally-invented placeholder state representing an ambiguous /
    # manual-reconciliation outcome that is NOT in _RETRYABLE. We assert
    # the production code rejects without calling Gemini.
    db[COLL_ATTEMPTS].docs[akey] = {
        "_id": akey, "attempt_id": akey, "student_id": sid,
        "entry_id": ekey, "state": "needs_manual_reconciliation",
        "submit_count": 1,
    }

    with pytest.raises(Exception) as exc_info:
        run(_post_submit(router, entry_id=ekey, audio=_Upload(),
                          student=_Student()))
    # HTTPException 409 is the contract documented in the docstring.
    assert getattr(exc_info.value, "status_code", None) == 409
    assert calls["n"] == 0, "Gemini must not be called for a non-retryable state"


# ── 7. _RETRYABLE set boundary documented ───────────────────────────────
def test_retryable_set_excludes_evaluated_and_evaluating():
    assert A_EVALUATED not in _RETRYABLE
    assert A_EVALUATING not in _RETRYABLE
    # And includes the three states the contract documents.
    assert A_CREATED in _RETRYABLE
    assert A_FAILED in _RETRYABLE
    assert A_UNAVAILABLE in _RETRYABLE
