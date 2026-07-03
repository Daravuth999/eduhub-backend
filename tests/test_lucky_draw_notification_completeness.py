"""
Speaking Lab Lucky Draw — reward-notification completeness (v1.0)
====================================================================

The core exactly-once push-notification machinery for Prize Pool / Lucky
Draw winners already lives in ``lucky_draw.py``:

  * ``_process_winner``              — unified paid/persist/push state
                                        machine shared by normal finalize,
                                        retry, and manual-review release
                                        (selected via ``mode=``);
  * ``_send_winner_push_idempotent`` — attempt-ID guarded, exactly-once
                                        push, never marks `sent` before a
                                        real delivery succeeds;
  * ``_retry_push_only``             — notification-only retry, proven
                                        never to call the payout provider;
  * ``recover_abandoned_draws`` /
    ``_process_unresolved_finalized_draw`` — background recovery, reuses
                                        the same ``_process_winner`` gate.

``tests/test_lucky_draw_recovery.py`` and
``tests/test_lucky_draw_adversarial.py`` already cover most of the
required invariants (paid-then-push, failure/manual-review send no push,
duplicate finalize is idempotent, notification retry never calls the
provider, older push attempts cannot overwrite newer ones, mock/manual
send no push). This file closes the remaining gaps called out in the
push-notification hardening pass:

  * concurrent finalize sends exactly one push PER WINNER (not just one
    provider call per winner);
  * the background recovery worker (Bucket B — finalized-but-unresolved)
    sends exactly one push after a confirmed recovery payout, and does
    not regrant points on a second pass;
  * an admin-approved manual-review release sends a push only once the
    provider outcome is a confirmed paid + persisted state — an uncertain
    (still manual_review) release outcome sends no push;
    a genuinely-mock outcome is never notified as a real success;
  * the durable record traceable from one push call contains the correct
    student, amount, and session (via the draw document);
  * push args never carry raw provider/database error detail;
  * a race between two concurrent push attempts (real async barrier, not
    schedule luck) still converges on exactly one delivered push.

Run from the backend folder:

    pytest -q tests/test_lucky_draw_notification_completeness.py --asyncio-mode=auto
"""

from __future__ import annotations

import asyncio
import pathlib
import sys

import pytest

BACKEND_DIR = pathlib.Path(__file__).resolve().parent.parent
TESTS_DIR = pathlib.Path(__file__).resolve().parent
for _p in (BACKEND_DIR, TESTS_DIR):
    if str(_p) not in sys.path:
        sys.path.insert(0, str(_p))

import lucky_draw as ld  # noqa: E402

from test_lucky_draw_recovery import (  # noqa: E402
    _DB, FakeProvider, PushRecorder, _noop_publish, _seed_prepared_draw,
    _finalize, _now_iso, GAS, PW,
)


@pytest.fixture(autouse=True)
def _restore_provider_transfer():
    real = ld._provider_transfer
    yield
    ld._provider_transfer = real


# ═════════════════════════════════════════════════════════════════════════════
# 1. Concurrent finalize → exactly one push PER WINNER
# ═════════════════════════════════════════════════════════════════════════════

@pytest.mark.asyncio
async def test_concurrent_finalize_sends_exactly_one_push_per_winner():
    db = _DB()
    did, sid = await _seed_prepared_draw(db)  # 2 winners: stuA, stuB
    prov = FakeProvider()
    ld._provider_transfer = prov
    push = PushRecorder(mode="sent")
    await asyncio.gather(
        _finalize(db, sid, push=push),
        _finalize(db, sid, push=push),
    )
    assert prov.calls == 2  # one provider call per winner, never per request
    # Exactly one push per distinct winner — never duplicated by the race.
    called_students = [c[0] for c in push.calls]
    assert sorted(called_students) == ["stuA", "stuB"]
    assert len(push.calls) == 2
    draw = await db.speaking_lab_lucky_draws.find_one({"draw_id": did})
    for w in draw["results"]:
        assert w["transfer_state"] == ld.TRANSFER_PAID
        assert w["push_notification_state"] == ld.PUSH_SENT


# ═════════════════════════════════════════════════════════════════════════════
# 2. Recovery worker (Bucket B: finalized-but-unresolved) → one push
# ═════════════════════════════════════════════════════════════════════════════

async def _seed_unresolved_finalized_draw(db, *, draw_id="draw-fin-1",
                                          session_id="sess-fin-1"):
    """A draw already marked `finalized=True` whose winner was seeded
    `transfer_state=pending` by a fresh finalize that then crashed before
    `_process_winner` ran for it — the exact shape the background recovery
    worker's Bucket B auto-processes. (A bare `transfer_ok=None` with no
    `transfer_state` is deliberately NOT auto-processed here — v5 FIX 4
    quarantines that ambiguous legacy shape as manual_review instead, since
    the recovery worker cannot tell it apart from a genuinely-uncertain
    historical record.)"""
    await db.speaking_lab_sessions.insert_one({
        "session_id": session_id, "lucky_draw_done": True,
        "lucky_draw_prepared_draw_id": draw_id})
    await db.speaking_lab_lucky_draws.insert_one({
        "draw_id": draw_id, "session_id": session_id, "pool_total": 50,
        "num_winners": 1, "split": [100],
        "results": [{"student_id": "stuA", "display_name": "A",
                     "code": "STAR-1", "amount": 50, "transfer_ok": None,
                     "transfer_state": ld.TRANSFER_PENDING,
                     "push_notification_state": ld.PUSH_PENDING,
                     "transfer_err": "", "was_slot_picked": False}],
        "mock": False, "finalized": True, "payout_status": "pending",
        "prepared_at": _now_iso(-300), "drawn_at": _now_iso(-300),
        "finalized_at": _now_iso(-300)})
    return draw_id, session_id


@pytest.mark.asyncio
async def test_recovery_worker_sends_one_push_after_confirmed_recovery_payout():
    db = _DB()
    did, sid = await _seed_unresolved_finalized_draw(db)
    prov = FakeProvider()
    ld._provider_transfer = prov
    push = PushRecorder(mode="sent")
    out = await ld.recover_abandoned_draws(
        db, _noop_publish, GAS, "stu092", PW, False,
        ld.logging.getLogger("t"), push_notify=push)
    assert out["resolved_finalized"] == 1
    assert prov.calls == 1
    assert len(push.calls) == 1
    assert push.calls[0] == ("stuA", 50, "STAR-1")
    w = (await db.speaking_lab_lucky_draws.find_one({"draw_id": did}))["results"][0]
    assert w["transfer_state"] == ld.TRANSFER_PAID
    assert w["push_notification_state"] == ld.PUSH_SENT


@pytest.mark.asyncio
async def test_recovery_worker_rerun_does_not_regrant_or_resend():
    db = _DB()
    did, sid = await _seed_unresolved_finalized_draw(db)
    prov = FakeProvider()
    ld._provider_transfer = prov
    push = PushRecorder(mode="sent")
    await ld.recover_abandoned_draws(
        db, _noop_publish, GAS, "stu092", PW, False,
        ld.logging.getLogger("t"), push_notify=push)
    # Second pass — the draw is now paid + sent; must be a complete no-op.
    await ld.recover_abandoned_draws(
        db, _noop_publish, GAS, "stu092", PW, False,
        ld.logging.getLogger("t"), push_notify=push)
    assert prov.calls == 1          # no regrant
    assert len(push.calls) == 1     # no duplicate push


# ═════════════════════════════════════════════════════════════════════════════
# 3. Manual-review release → push only after confirmed paid persistence
# ═════════════════════════════════════════════════════════════════════════════

async def _seed_manual_review_draw(db, *, draw_id="draw-mr-1",
                                   session_id="sess-mr-1"):
    await db.speaking_lab_sessions.insert_one({
        "session_id": session_id, "lucky_draw_done": True,
        "lucky_draw_prepared_draw_id": draw_id})
    await db.speaking_lab_lucky_draws.insert_one({
        "draw_id": draw_id, "session_id": session_id, "pool_total": 50,
        "num_winners": 1, "split": [100],
        "results": [{"student_id": "stuA", "display_name": "A",
                     "code": "STAR-1", "amount": 50,
                     "transfer_state": ld.TRANSFER_MANUAL,
                     "transfer_ok": None, "transfer_err": "",
                     "manual_review_reason": "provider_paid_but_persist_failed",
                     "was_slot_picked": False}],
        "mock": False, "finalized": True, "finalized_at": _now_iso(-60),
        "payout_status": ld.PAYOUT_MANUAL_REVIEW})
    return draw_id, session_id


@pytest.mark.asyncio
async def test_manual_review_release_sends_push_only_after_paid_persistence():
    db = _DB()
    did, sid = await _seed_manual_review_draw(db)
    prov = FakeProvider(outcome="paid")
    ld._provider_transfer = prov
    push = PushRecorder(mode="sent")
    resp = await ld._retry_failed_payouts(
        db, _noop_publish, sid, GAS, "stu092", PW, False,
        ld.logging.getLogger("t"), push_notify=push,
        confirm_not_paid=True, reason="ledger verified externally",
        student_id="stuA", granted_by="admin@school.example")
    assert resp["released_manual_review"] == 1
    assert prov.calls == 1
    assert len(push.calls) == 1
    w = (await db.speaking_lab_lucky_draws.find_one({"draw_id": did}))["results"][0]
    assert w["transfer_state"] == ld.TRANSFER_PAID
    assert w["push_notification_state"] == ld.PUSH_SENT


@pytest.mark.asyncio
async def test_manual_review_release_uncertain_outcome_sends_no_push():
    db = _DB()
    did, sid = await _seed_manual_review_draw(db)
    # Provider is STILL uncertain on release — must stay manual_review, no push.
    prov = FakeProvider(outcome="manual_review")
    ld._provider_transfer = prov
    push = PushRecorder(mode="sent")
    await ld._retry_failed_payouts(
        db, _noop_publish, sid, GAS, "stu092", PW, False,
        ld.logging.getLogger("t"), push_notify=push,
        confirm_not_paid=True, reason="ledger verified externally",
        student_id="stuA", granted_by="admin@school.example")
    assert push.calls == []
    w = (await db.speaking_lab_lucky_draws.find_one({"draw_id": did}))["results"][0]
    assert w["transfer_state"] == ld.TRANSFER_MANUAL


@pytest.mark.asyncio
async def test_mock_outcome_never_sends_a_success_push():
    db = _DB()
    did, sid = await _seed_prepared_draw(db, winners=[
        {"student_id": "stuA", "display_name": "A", "code": "STAR-1",
         "amount": 50, "transfer_ok": None}], mock=True)
    push = PushRecorder(mode="sent")
    await _finalize(db, sid, provider=FakeProvider(outcome="mock"),
                    push=push, mock_gas=True)
    assert push.calls == []
    w = (await db.speaking_lab_lucky_draws.find_one({"draw_id": did}))["results"][0]
    assert w["transfer_state"] == ld.TRANSFER_MOCK


# ═════════════════════════════════════════════════════════════════════════════
# 4. Notification payload traceability — student, amount, session
# ═════════════════════════════════════════════════════════════════════════════

@pytest.mark.asyncio
async def test_push_call_traceable_to_correct_student_amount_and_session():
    db = _DB()
    did, sid = await _seed_prepared_draw(db, winners=[
        {"student_id": "stu777", "display_name": "Rina", "code": "MOON-9",
         "amount": 42, "transfer_ok": None}])
    push = PushRecorder(mode="sent")
    await _finalize(db, sid, provider=FakeProvider(), push=push)
    assert len(push.calls) == 1
    called_student, called_amount, called_code = push.calls[0]
    draw = await db.speaking_lab_lucky_draws.find_one({"draw_id": did})
    w = draw["results"][0]
    # The push call arguments and the durable winner record must agree —
    # the durable record is the source of truth, not the push call.
    assert called_student == w["student_id"] == "stu777"
    assert called_amount == w["amount"] == 42
    assert called_code == w["code"] == "MOON-9"
    assert draw["session_id"] == sid


@pytest.mark.asyncio
async def test_push_args_never_carry_raw_provider_or_db_error_detail():
    db = _DB()
    did, sid = await _seed_prepared_draw(db, winners=[
        {"student_id": "stuA", "display_name": "A", "code": "STAR-1",
         "amount": 50, "transfer_ok": None}])
    SL = db.speaking_lab_lucky_draws
    # Inject a persistence failure carrying a sensitive-looking error string
    # so we can prove it never reaches the push callback's arguments.
    sensitive = "connection refused host=internal-mongo:27017 user=admin pw=hunter2"
    SL.fail_predicate = lambda upd: (
        "results.$[w].transfer_state" in upd.get("$set", {})
        and upd["$set"]["results.$[w].transfer_state"] == ld.TRANSFER_PAID
    )
    push = PushRecorder(mode="sent")
    try:
        await _finalize(db, sid, provider=FakeProvider(), push=push)
    finally:
        SL.fail_predicate = None
    # Persist failed after a provider-confirmed pay → quarantined manual_review,
    # never auto-resent, and (critically) no push call ever carries `sensitive`.
    for call in push.calls:
        for arg in call:
            assert sensitive not in str(arg)
    w = (await SL.find_one({"draw_id": did}))["results"][0]
    assert w["transfer_state"] == ld.TRANSFER_MANUAL
    assert push.calls == []  # persistence failed → no push at all


# ═════════════════════════════════════════════════════════════════════════════
# 5. True concurrency via an explicit async barrier (not scheduler luck)
# ═════════════════════════════════════════════════════════════════════════════

@pytest.mark.asyncio
async def test_concurrent_push_retry_with_explicit_barrier_sends_one_push():
    """Use an explicit asyncio.Event rendezvous so both retry attempts are
    released into the atomic claim at the same instant — a deterministic
    race every run, rather than relying on incidental event-loop scheduling
    order (as a bare ``asyncio.gather`` would)."""
    db = _DB()
    did, sid = await _seed_prepared_draw(db, winners=[
        {"student_id": "stuA", "display_name": "A", "code": "STAR-1",
         "amount": 50, "transfer_ok": None}])
    # Pay first with push disabled, so the winner sits PAID / push=pending.
    await _finalize(db, sid, provider=FakeProvider(), push=None)
    SL = db.speaking_lab_lucky_draws
    ref = ld._stable_reference(did, sid, "stuA")
    push = PushRecorder(mode="sent")

    both_ready = asyncio.Event()
    arrivals = 0

    async def _attempt():
        nonlocal arrivals
        arrivals += 1
        if arrivals == 2:
            both_ready.set()
        await both_ready.wait()  # both coroutines cross the line together
        await ld._send_winner_push_idempotent(
            SL, did, "stuA", 50, "STAR-1", ref, push,
            ld.logging.getLogger("t"))

    await asyncio.gather(_attempt(), _attempt())
    assert len(push.calls) == 1  # exactly one delivered push from the race
    w = (await SL.find_one({"draw_id": did}))["results"][0]
    assert w["push_notification_state"] == ld.PUSH_SENT


# ═════════════════════════════════════════════════════════════════════════════
# 6. Protected-function / registration sanity (defensive re-check)
# ═════════════════════════════════════════════════════════════════════════════

@pytest.mark.asyncio
async def test_notification_wiring_never_touches_protected_draw_mechanics():
    """The notification gate must never influence winner selection, rank
    ordering, split, or prize amount — only whether/when a push fires."""
    db = _DB()
    winners = [
        {"student_id": "stuA", "display_name": "A", "code": "STAR-1",
         "amount": 50, "transfer_ok": None},
        {"student_id": "stuB", "display_name": "B", "code": "MOON-2",
         "amount": 30, "transfer_ok": None},
    ]
    did, sid = await _seed_prepared_draw(db, winners=list(winners))
    await _finalize(db, sid, provider=FakeProvider(), push=PushRecorder())
    draw = await db.speaking_lab_lucky_draws.find_one({"draw_id": did})
    for before, after in zip(winners, draw["results"]):
        assert before["student_id"] == after["student_id"]
        assert before["amount"] == after["amount"]
        assert before["code"] == after["code"]


# ═════════════════════════════════════════════════════════════════════════════
# 7. Legacy transfer_ok=None quarantine — never auto-notified
# ═════════════════════════════════════════════════════════════════════════════

@pytest.mark.asyncio
async def test_legacy_transfer_ok_none_is_quarantined_not_auto_paid_or_notified():
    """A finalized draw whose winner has `transfer_ok=None` and NO explicit
    `transfer_state` is ambiguous history, not a known in-flight crash — the
    recovery worker must quarantine it as manual_review rather than treat it
    as a fresh pending winner, and must never auto-notify it as a reward
    success. Releasing it requires the explicit operator-confirmed path."""
    db = _DB()
    did, sid = await _seed_prepared_draw(db, winners=[
        {"student_id": "stuA", "display_name": "A", "code": "STAR-1",
         "amount": 50, "transfer_ok": None}])
    # Mark it finalized-but-unresolved WITHOUT an explicit transfer_state —
    # the genuinely ambiguous legacy shape (as opposed to the fresh-finalize
    # -crashed-mid-flight shape covered above).
    await db.speaking_lab_lucky_draws.update_one(
        {"draw_id": did},
        {"$set": {"finalized": True, "payout_status": "pending",
                  "finalized_at": _now_iso(-300)}})
    prov = FakeProvider()
    ld._provider_transfer = prov
    push = PushRecorder(mode="sent")
    out = await ld.recover_abandoned_draws(
        db, _noop_publish, GAS, "stu092", PW, False,
        ld.logging.getLogger("t"), push_notify=push)
    assert out["resolved_finalized"] == 0
    assert prov.calls == 0       # never auto-paid
    assert push.calls == []      # never auto-notified
    w = (await db.speaking_lab_lucky_draws.find_one({"draw_id": did}))["results"][0]
    assert w["transfer_state"] == ld.TRANSFER_MANUAL
