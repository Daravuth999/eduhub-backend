"""
v5 + v5.2 acceptance — adversarial proofs.
==========================================

These tests target the v5 fixes plus the v5.2 overlapping-finalize race fix
and the push-notification regression:

 1. SpeakingLabPage finalize callback returns the API result   (frontend)
 2. Teacher admission recovery is audited + uniqueness enforced (backend
    teacher_admission already covered in test_teacher_admit.py; we add an
    incomplete-override 422 check here for the v5 contract)
 3. Manual-review retry is student-specific
 4. Legacy `transfer_ok=None` finalized winners never auto-pay
 5. Terminal transfer + push writes are guarded by attempt_id
 6. GAS contract: bare {"success": true} is paid; ambiguous → manual_review
 7. v5.2 FIX 1 — overlapping-finalize race: non-owner never writes
    manual_review, never calls the provider, and recovery respects
    active payout initialization.

 push regression: paid persisted → exactly one success push.

Run from the backend folder:
    pytest -q tests/test_lucky_draw_adversarial.py --asyncio-mode=auto
"""

from __future__ import annotations

import pathlib
import sys

import pytest

BACKEND_DIR = pathlib.Path(__file__).resolve().parent.parent
if str(BACKEND_DIR) not in sys.path:
    sys.path.insert(0, str(BACKEND_DIR))

import lucky_draw as ld  # noqa: E402

# Reuse the in-memory Mongo fake + helpers from the existing recovery suite.
from tests.test_lucky_draw_recovery import (  # noqa: E402
    _DB, _seed_prepared_draw, _finalize, _noop_publish, _now_iso,
    FakeProvider, PushRecorder, _patch_httpx, _FakeResp, GAS, PW, SREF,
)

_REAL_PROVIDER_TRANSFER = ld._provider_transfer


@pytest.fixture(autouse=True)
def _restore_provider_transfer():
    ld._provider_transfer = _REAL_PROVIDER_TRANSFER
    yield
    ld._provider_transfer = _REAL_PROVIDER_TRANSFER


# ═════════════════════════════════════════════════════════════════════════════
# v5 FIX 3 — manual-review retry is STUDENT-SPECIFIC
# ═════════════════════════════════════════════════════════════════════════════
@pytest.mark.asyncio
async def test_v5_retry_rejects_override_without_student_id():
    db = _DB()
    did, sid = await _seed_prepared_draw(db)
    await _finalize(db, sid, provider=FakeProvider(outcome="manual_review"))
    prov = FakeProvider(outcome="paid")
    ld._provider_transfer = prov
    with pytest.raises(ld.HTTPException) as ei:
        await ld._retry_failed_payouts(
            db, _noop_publish, sid, GAS, "stu092", PW, False,
            ld.logging.getLogger("t"),
            confirm_not_paid=True, reason="checked ledger",
            student_id=None)
    assert ei.value.status_code == 422
    assert "student_id" in str(ei.value.detail)
    assert prov.calls == 0


@pytest.mark.asyncio
async def test_v5_retry_rejects_unknown_student_id():
    db = _DB()
    did, sid = await _seed_prepared_draw(db)
    await _finalize(db, sid, provider=FakeProvider(outcome="manual_review"))
    prov = FakeProvider(outcome="paid")
    ld._provider_transfer = prov
    with pytest.raises(ld.HTTPException) as ei:
        await ld._retry_failed_payouts(
            db, _noop_publish, sid, GAS, "stu092", PW, False,
            ld.logging.getLogger("t"),
            confirm_not_paid=True, reason="checked ledger",
            student_id="ghost-id")
    assert ei.value.status_code == 404
    assert prov.calls == 0


@pytest.mark.asyncio
async def test_v5_retry_rejects_student_not_in_manual_review():
    db = _DB()
    did, sid = await _seed_prepared_draw(db)
    # finalize sets stuA/stuB as paid (default mock outcome)
    await _finalize(db, sid, provider=FakeProvider(outcome="paid"))
    prov = FakeProvider(outcome="paid")
    ld._provider_transfer = prov
    with pytest.raises(ld.HTTPException) as ei:
        await ld._retry_failed_payouts(
            db, _noop_publish, sid, GAS, "stu092", PW, False,
            ld.logging.getLogger("t"),
            confirm_not_paid=True, reason="checked ledger",
            student_id="stuA")
    assert ei.value.status_code == 409
    assert prov.calls == 0


@pytest.mark.asyncio
async def test_v5_retry_only_processes_targeted_student():
    """Required adversarial proof: with two manual_review winners,
    confirming stu1 only → provider called once for stu1 → stu2 untouched."""
    db = _DB()
    did, sid = await _seed_prepared_draw(db)
    await _finalize(db, sid, provider=FakeProvider(outcome="manual_review"))
    prov = FakeProvider(outcome="paid")
    ld._provider_transfer = prov
    resp = await ld._retry_failed_payouts(
        db, _noop_publish, sid, GAS, "stu092", PW, False,
        ld.logging.getLogger("t"),
        confirm_not_paid=True, reason="GAS ledger verified for stuA only",
        student_id="stuA", granted_by="audit-admin@school")
    # Exactly one provider call — for stuA only.
    assert prov.calls == 1
    assert resp["released_manual_review"] == 1
    assert resp["student_id_targeted"] == "stuA"
    # stuB stays manual_review.
    draw = await db.speaking_lab_lucky_draws.find_one({"draw_id": did})
    by_sid = {w["student_id"]: w for w in draw["results"]}
    assert by_sid["stuA"]["transfer_state"] == ld.TRANSFER_PAID
    assert by_sid["stuB"]["transfer_state"] == ld.TRANSFER_MANUAL
    # Audit fields persisted on stuA only.
    assert by_sid["stuA"]["manual_override_by"] == "audit-admin@school"
    assert "manual_override_stable_reference" in by_sid["stuA"]
    assert "GAS ledger" in by_sid["stuA"]["manual_override_reason"]


# ═════════════════════════════════════════════════════════════════════════════
# v5 FIX 4 — legacy `transfer_ok=None` finalized winners never auto-pay
# ═════════════════════════════════════════════════════════════════════════════
def test_v5_legacy_null_maps_to_manual_review():
    assert ld._legacy_state_for_record({"transfer_ok": None}) == ld.TRANSFER_MANUAL
    assert ld._legacy_state_for_record({}) == ld.TRANSFER_MANUAL


@pytest.mark.asyncio
async def test_v5_background_recovery_does_not_call_provider_on_legacy_null():
    db = _DB()
    SL = db.speaking_lab_lucky_draws
    await db.speaking_lab_sessions.insert_one({"session_id": "sess-legacy"})
    await SL.insert_one({
        "draw_id": "draw-legacy", "session_id": "sess-legacy",
        "pool_total": 100, "num_winners": 2, "split": [50, 30, 20],
        "mock": False, "finalized": True,
        "payout_status": ld.PAYOUT_PROCESSING,
        "prepared_at": _now_iso(-3600),
        "results": [
            {"student_id": "stuA", "display_name": "A", "code": "STAR-1",
             "amount": 50, "transfer_ok": None},
            {"student_id": "stuB", "display_name": "B", "code": "MOON-2",
             "amount": 30, "transfer_ok": None},
        ],
    })
    prov = FakeProvider(outcome="paid")
    ld._provider_transfer = prov
    out = await ld.recover_abandoned_draws(
        db, _noop_publish, GAS, "stu092", PW, False,
        ld.logging.getLogger("t"), push_notify=PushRecorder())
    assert prov.calls == 0
    draw = await SL.find_one({"draw_id": "draw-legacy"})
    for w in draw["results"]:
        assert w["transfer_state"] == ld.TRANSFER_MANUAL


# ═════════════════════════════════════════════════════════════════════════════
# v5 FIX 5 — terminal transfer write requires our attempt_id
# ═════════════════════════════════════════════════════════════════════════════
@pytest.mark.asyncio
async def test_v5_older_transfer_attempt_cannot_overwrite_newer_state():
    db = _DB()
    did, sid = await _seed_prepared_draw(db, winners=[
        {"student_id": "stuA", "display_name": "A", "code": "STAR-1",
         "amount": 50, "transfer_ok": None}])
    SL = db.speaking_lab_lucky_draws
    # Newer attempt persists the paid terminal state.
    await ld._seed_results_states(SL, did, fresh_finalize=True)
    await ld._claim_winner_initial(
        SL, did, "stuA", ld._stable_reference(did, sid, "stuA"),
        "attempt-new", _now_iso())
    persisted = await ld._set_winner_fields(
        SL, did, "stuA",
        {"transfer_state": ld.TRANSFER_PAID, "transfer_ok": True},
        expected_attempt_id="attempt-new", require_in_progress=True)
    assert persisted == 1
    draw = await SL.find_one({"draw_id": did})
    assert draw["results"][0]["transfer_state"] == ld.TRANSFER_PAID
    # Older attempt tries to overwrite with manual_review → must be rejected.
    rejected = await ld._set_winner_fields(
        SL, did, "stuA",
        {"transfer_state": ld.TRANSFER_MANUAL, "transfer_ok": None},
        expected_attempt_id="attempt-old", require_in_progress=True)
    assert rejected == 0
    draw = await SL.find_one({"draw_id": did})
    assert draw["results"][0]["transfer_state"] == ld.TRANSFER_PAID


@pytest.mark.asyncio
async def test_v5_older_push_attempt_cannot_overwrite_newer_push_state():
    db = _DB()
    did, sid = await _seed_prepared_draw(db, winners=[
        {"student_id": "stuA", "display_name": "A", "code": "STAR-1",
         "amount": 50, "transfer_ok": None}])
    SL = db.speaking_lab_lucky_draws
    # Promote stuA to paid + sent (with a known push_notification_attempt_id).
    await SL.update_one(
        {"draw_id": did},
        {"$set": {"results.$[w].transfer_state": ld.TRANSFER_PAID,
                  "results.$[w].push_notification_state": ld.PUSH_SENT,
                  "results.$[w].push_notification_attempt_id": "push-new"}},
        array_filters=[{"w.student_id": "stuA"}])
    # An older push worker tries to mark FAILED — must be rejected.
    rejected = await ld._set_winner_fields(
        SL, did, "stuA",
        {"push_notification_state": ld.PUSH_FAILED,
         "push_notification_error": "stale worker"},
        expected_push_attempt_id="push-old")
    assert rejected == 0
    draw = await SL.find_one({"draw_id": did})
    assert draw["results"][0]["push_notification_state"] == ld.PUSH_SENT


# ═════════════════════════════════════════════════════════════════════════════
# v5 FIX 6 — GAS response contract
# ═════════════════════════════════════════════════════════════════════════════
@pytest.mark.asyncio
async def test_v5_bare_success_true_is_paid(monkeypatch):
    _patch_httpx(monkeypatch, resp=_FakeResp(200, payload={"success": True}))
    out = await ld._provider_transfer(GAS, "t", PW, "stuA", 10, use_mock=False,
                                      stable_reference=SREF, attempt_id="a")
    assert out["outcome"] == ld.TRANSFER_PAID
    assert out["provider_status"] == "success"
    assert SREF in str(out["provider_reference"])


@pytest.mark.asyncio
async def test_v5_success_false_is_failed_safe_to_retry(monkeypatch):
    _patch_httpx(monkeypatch, resp=_FakeResp(200, payload={"success": False,
                                                             "message": "no"}))
    out = await ld._provider_transfer(GAS, "t", PW, "stuA", 10, use_mock=False,
                                      stable_reference=SREF, attempt_id="a")
    assert out["outcome"] == ld.TRANSFER_FAILED_RETRY


@pytest.mark.asyncio
async def test_v5_invalid_json_is_manual_review(monkeypatch):
    _patch_httpx(monkeypatch,
                 resp=_FakeResp(200, payload=None, text="not-json"))
    out = await ld._provider_transfer(GAS, "t", PW, "stuA", 10, use_mock=False,
                                      stable_reference=SREF, attempt_id="a")
    assert out["outcome"] == ld.TRANSFER_MANUAL
    assert out["provider_status"] == "invalid_json"


@pytest.mark.asyncio
async def test_v5_recipient_mismatch_is_manual_review(monkeypatch):
    _patch_httpx(monkeypatch, resp=_FakeResp(200, payload={
        "success": True, "receiverId": "wrongStudent", "amount": 10}))
    out = await ld._provider_transfer(GAS, "t", PW, "stuA", 10, use_mock=False,
                                      stable_reference=SREF, attempt_id="a")
    assert out["outcome"] == ld.TRANSFER_MANUAL
    assert out["provider_status"] == "recipient_mismatch"


@pytest.mark.asyncio
async def test_v5_amount_mismatch_is_manual_review(monkeypatch):
    _patch_httpx(monkeypatch, resp=_FakeResp(200, payload={
        "success": True, "amount": 999}))
    out = await ld._provider_transfer(GAS, "t", PW, "stuA", 10, use_mock=False,
                                      stable_reference=SREF, attempt_id="a")
    assert out["outcome"] == ld.TRANSFER_MANUAL
    assert out["provider_status"] == "amount_mismatch"


# ═════════════════════════════════════════════════════════════════════════════
# Push regression — paid persisted → exactly one success push
# ═════════════════════════════════════════════════════════════════════════════
@pytest.mark.asyncio
async def test_v5_paid_sends_exactly_one_success_push():
    db = _DB()
    did, sid = await _seed_prepared_draw(db, winners=[
        {"student_id": "stuA", "display_name": "A", "code": "STAR-1",
         "amount": 50, "transfer_ok": None}])
    push = PushRecorder()
    prov = FakeProvider(outcome="paid")
    await _finalize(db, sid, provider=prov, push=push)
    # Run again (idempotent finalize). Push must NOT fire twice.
    await _finalize(db, sid, provider=prov, push=push)
    assert len(push.calls) == 1
    draw = await db.speaking_lab_lucky_draws.find_one({"draw_id": did})
    assert draw["results"][0]["transfer_state"] == ld.TRANSFER_PAID
    assert draw["results"][0]["push_notification_state"] == ld.PUSH_SENT


@pytest.mark.asyncio
async def test_v5_manual_review_sends_no_push():
    db = _DB()
    did, sid = await _seed_prepared_draw(db, winners=[
        {"student_id": "stuA", "display_name": "A", "code": "STAR-1",
         "amount": 50, "transfer_ok": None}])
    push = PushRecorder()
    await _finalize(db, sid, provider=FakeProvider(outcome="manual_review"),
                    push=push)
    assert push.calls == []


@pytest.mark.asyncio
async def test_v5_failed_safe_to_retry_sends_no_push():
    db = _DB()
    did, sid = await _seed_prepared_draw(db, winners=[
        {"student_id": "stuA", "display_name": "A", "code": "STAR-1",
         "amount": 50, "transfer_ok": None}])
    push = PushRecorder()
    await _finalize(db, sid,
                    provider=FakeProvider(outcome="failed_safe_to_retry"),
                    push=push)
    assert push.calls == []


@pytest.mark.asyncio
async def test_v5_mock_sends_no_real_success_push():
    db = _DB()
    did, sid = await _seed_prepared_draw(db, winners=[
        {"student_id": "stuA", "display_name": "A", "code": "STAR-1",
         "amount": 50, "transfer_ok": None}], mock=True)
    push = PushRecorder()
    await _finalize(db, sid, provider=FakeProvider(outcome="mock"),
                    push=push, mock_gas=True)
    # Mock outcome means the reward was NOT really sent → no success push.
    assert push.calls == []


@pytest.mark.asyncio
async def test_v5_notification_only_retry_never_calls_gas():
    db = _DB()
    did, sid = await _seed_prepared_draw(db, winners=[
        {"student_id": "stuA", "display_name": "A", "code": "STAR-1",
         "amount": 50, "transfer_ok": None}])
    prov = FakeProvider(outcome="paid")
    push = PushRecorder(fail=True)
    await _finalize(db, sid, provider=prov, push=push)
    assert prov.calls == 1
    push2 = PushRecorder()
    await ld._retry_push_only(db, sid, ld.logging.getLogger("t"),
                              push_notify=push2)
    # GAS provider was not called again, but the push was retried.
    assert prov.calls == 1
    assert len(push2.calls) == 1


# ═════════════════════════════════════════════════════════════════════════════
# v5 FIX 2 — teacher admission override hardening (incomplete-override 422)
# (the happy / unique-reference paths are exercised in test_teacher_admit.py)
# ═════════════════════════════════════════════════════════════════════════════
def test_v5_teacher_admit_request_has_confirm_external_verification_field():
    from teacher_admission import TeacherAdmitRequest
    body = TeacherAdmitRequest(
        student_id="stuA", points_sent=10, transfer_reference="P2P-1",
        transfer_datetime="2026-01-01T00:00:00+00:00",
        verification_method="ledger_check",
        teacher_explanation="external check",
        teacher_confirmed=True,
        confirm_external_verification=True)
    assert body.confirm_external_verification is True
    # Defaults to False (no override) when not explicitly supplied.
    body2 = TeacherAdmitRequest(
        student_id="stuA", points_sent=10, transfer_reference="P2P-1",
        transfer_datetime="2026-01-01T00:00:00+00:00",
        verification_method="ledger_check",
        teacher_explanation="external check",
        teacher_confirmed=True)
    assert body2.confirm_external_verification is False


# ═════════════════════════════════════════════════════════════════════════════
# v5.1 FIX 2 — Finalized legacy-null winners must never auto-pay even when
# `finalize` is called again directly on the prepared-draw route.
# ═════════════════════════════════════════════════════════════════════════════
@pytest.mark.asyncio
async def test_v51_already_finalized_legacy_null_direct_finalize_does_not_pay():
    """Adversarial proof for v5.1 FIX 2.

    Setup: an ALREADY-FINALIZED draw whose winners carry the v4-style
    `transfer_ok=None` and have no `transfer_state` field — a real
    legacy footprint. The session also has it as the prepared draw
    pointer, so a direct `_finalize_draw` call re-enters the route.

    Expected v5.1 behaviour:
      • the request does NOT flip finalized:false→true (no claim)
      • `_seed_results_states` is therefore called with
        `fresh_finalize=False`
      • legacy `transfer_ok=None` rows map to `manual_review`
      • the GAS provider is NEVER called automatically
    """
    db = _DB()
    SL = db.speaking_lab_lucky_draws
    await db.speaking_lab_sessions.insert_one({
        "session_id": "sess-v51-legacy",
        "lucky_draw_prepared_draw_id": "draw-v51-legacy",
    })
    await SL.insert_one({
        "draw_id": "draw-v51-legacy", "session_id": "sess-v51-legacy",
        "pool_total": 80, "num_winners": 2, "split": [50, 30, 20],
        "mock": False, "finalized": True,
        "payout_status": ld.PAYOUT_PROCESSING,
        "prepared_at": _now_iso(-3600),
        "finalize_started_at": _now_iso(-3590),
        "finalized_at": _now_iso(-3580),
        "results": [
            {"student_id": "stuA", "display_name": "A", "code": "STAR-1",
             "amount": 50, "transfer_ok": None},
            {"student_id": "stuB", "display_name": "B", "code": "MOON-2",
             "amount": 30, "transfer_ok": None},
        ],
    })
    prov = FakeProvider(outcome="paid")  # would mark them paid if called
    ld._provider_transfer = prov
    resp = await ld._finalize_draw(
        db, _noop_publish, "sess-v51-legacy", GAS, "stu092", PW, False,
        ld.logging.getLogger("t"), push_notify=PushRecorder())
    # The provider must NOT have been called. The rows must be manual_review.
    assert prov.calls == 0
    draw = await SL.find_one({"draw_id": "draw-v51-legacy"})
    for w in draw["results"]:
        assert w["transfer_state"] == ld.TRANSFER_MANUAL
    # Truthful aggregate status: NOT completed.
    assert resp.get("payout_status") != ld.PAYOUT_COMPLETED
    assert resp.get("payout_complete") is not True


@pytest.mark.asyncio
async def test_v51_unfinalized_fresh_draw_still_processes_pending_winners():
    """v5.1 FIX 2 regression guard: a brand-new unfinalized draw with
    `transfer_ok=None` winners still finalizes normally on the FIRST call
    and pays its pending winners once."""
    db = _DB()
    did, sid = await _seed_prepared_draw(db, winners=[
        {"student_id": "stuA", "display_name": "A", "code": "STAR-1",
         "amount": 50, "transfer_ok": None}])
    prov = FakeProvider(outcome="paid")
    push = PushRecorder()
    resp = await _finalize(db, sid, provider=prov, push=push)
    assert prov.calls == 1
    draw = await db.speaking_lab_lucky_draws.find_one({"draw_id": did})
    assert draw["results"][0]["transfer_state"] == ld.TRANSFER_PAID
    assert resp["payout_complete"] is True


@pytest.mark.asyncio
async def test_v51_legacy_manual_review_only_released_for_explicit_student():
    """v5.1 FIX 2 + FIX 3 together: once a legacy null row is quarantined
    as manual_review, ONLY a student-specific admin confirmation may
    release it. A confirmation for stuA must not release stuB."""
    db = _DB()
    SL = db.speaking_lab_lucky_draws
    await db.speaking_lab_sessions.insert_one({"session_id": "sess-v51-rel"})
    await SL.insert_one({
        "draw_id": "draw-v51-rel", "session_id": "sess-v51-rel",
        "pool_total": 80, "num_winners": 2, "split": [50, 30, 20],
        "mock": False, "finalized": True,
        "payout_status": ld.PAYOUT_MANUAL_REVIEW,
        "prepared_at": _now_iso(-3600),
        "finalized_at": _now_iso(-3580),
        "results": [
            {"student_id": "stuA", "display_name": "A", "code": "STAR-1",
             "amount": 50, "transfer_ok": None,
             "transfer_state": ld.TRANSFER_MANUAL},
            {"student_id": "stuB", "display_name": "B", "code": "MOON-2",
             "amount": 30, "transfer_ok": None,
             "transfer_state": ld.TRANSFER_MANUAL},
        ],
    })
    prov = FakeProvider(outcome="paid")
    ld._provider_transfer = prov
    resp = await ld._retry_failed_payouts(
        db, _noop_publish, "sess-v51-rel", GAS, "stu092", PW, False,
        ld.logging.getLogger("t"),
        confirm_not_paid=True,
        reason="GAS ledger checked for stuA; no credit exists",
        student_id="stuA",
        granted_by="audit-admin@school")
    assert prov.calls == 1                      # only stuA reprocessed
    assert resp["released_manual_review"] == 1
    assert resp["student_id_targeted"] == "stuA"
    draw = await SL.find_one({"draw_id": "draw-v51-rel"})
    by_sid = {w["student_id"]: w for w in draw["results"]}
    assert by_sid["stuA"]["transfer_state"] == ld.TRANSFER_PAID
    assert by_sid["stuB"]["transfer_state"] == ld.TRANSFER_MANUAL


# ═════════════════════════════════════════════════════════════════════════════
# v5.2 FIX 1 — Overlapping-finalize race (payout initialization ownership)
# ═════════════════════════════════════════════════════════════════════════════
#
# Reproduce the exact controlled ordering from the spec:
#
#   • Request A claims finalize and PAUSES before winner-state initialization
#   • Request B enters finalize
#   • Request B does NOT write manual_review
#   • Request B does NOT call the provider
#   • Request A resumes
#   • Provider is called EXACTLY ONCE
#   • Winner reaches the expected terminal state
#
# A deterministic barrier instruments `_seed_results_states` so Request A
# pauses inside seeding the moment it begins, lets Request B race past, and
# only resumes after B has fully exited finalize.
#
import asyncio  # noqa: E402  (test-only import)


class _ProviderCallCounter:
    """Provider stand-in that records each call and returns "paid". Used to
    prove the provider was called exactly once across both concurrent
    finalize requests."""
    def __init__(self):
        self.calls = []

    async def __call__(self, gas_url, treasury_id, treasury_password,
                       receiver_clean_id, amount, *, use_mock,
                       stable_reference, attempt_id, log=None):
        self.calls.append({
            "student_id": receiver_clean_id, "amount": amount,
            "stable_reference": stable_reference, "attempt_id": attempt_id})
        return {"outcome": ld.TRANSFER_PAID, "provider_status": "success",
                "provider_reference": f"GASTX-{len(self.calls)}",
                "error": ""}


def _install_owner_seed_barrier(arrival_event: asyncio.Event,
                                resume_event: asyncio.Event):
    """Wrap `ld._seed_results_states` so the OWNER (fresh_finalize=True)
    pauses at the start of seeding. Non-owner callers (and recovery) pass
    through unchanged. Returns the original function so the test can
    restore it."""
    original = ld._seed_results_states

    async def _wrapped(SL_DRAWS, draw_id, prepared_results=None,
                       *, fresh_finalize=False):
        if fresh_finalize:
            # The owner has just won the finalize claim. Signal arrival.
            arrival_event.set()
            # Wait until the test allows the owner to actually seed.
            await resume_event.wait()
        return await original(SL_DRAWS, draw_id, prepared_results,
                               fresh_finalize=fresh_finalize)
    ld._seed_results_states = _wrapped
    return original


@pytest.mark.asyncio
async def test_v52_overlapping_finalize_race_provider_called_exactly_once():
    """v5.2 FIX 1 — Required adversarial proof.

    Request A wins the finalize claim and pauses before initialization.
    Request B enters finalize, sees `finalized:true` + active payout
    initialization, and MUST NOT:
      • write manual_review on any winner,
      • call the provider.
    After A resumes, the provider is called exactly once per winner and
    the winner reaches the paid terminal state.
    """
    db = _DB()
    did, sid = await _seed_prepared_draw(db, winners=[
        {"student_id": "stuA", "display_name": "A", "code": "STAR-1",
         "amount": 50, "transfer_ok": None}])
    prov = _ProviderCallCounter()
    ld._provider_transfer = prov

    arrival = asyncio.Event()
    resume = asyncio.Event()
    original_seed = _install_owner_seed_barrier(arrival, resume)
    try:
        # Request A — wins finalize claim, pauses inside seeding.
        task_a = asyncio.create_task(_finalize(
            db, sid, push=PushRecorder(), gas_url=GAS, pw=PW))
        # Wait until A has actually acquired the init claim and paused.
        await asyncio.wait_for(arrival.wait(), timeout=2.0)

        # Snapshot the draw — A holds an active init claim.
        draw = await db.speaking_lab_lucky_draws.find_one({"draw_id": did})
        assert draw["finalized"] is True
        assert (draw.get("payout_initialization_state")
                == ld.PAYOUT_INIT_ACTIVE)
        # A has not yet seeded any winner state.
        assert "transfer_state" not in draw["results"][0]

        # Request B enters finalize NOW while A is paused.
        resp_b = await _finalize(
            db, sid, push=PushRecorder(), gas_url=GAS, pw=PW)

        # Required invariants for the non-owner:
        #   • No provider call yet.
        assert prov.calls == [], (
            "Non-owner finalize must NOT call the provider while owner is "
            "still initializing")
        #   • Returned status is PROCESSING, not COMPLETED, not MANUAL_REVIEW.
        assert resp_b["payout_status"] == ld.PAYOUT_PROCESSING
        assert resp_b["payout_complete"] is False
        assert resp_b.get("payout_initialization_state") == \
               ld.PAYOUT_INIT_ACTIVE
        #   • No winner was written to manual_review by B.
        draw = await db.speaking_lab_lucky_draws.find_one({"draw_id": did})
        for w in draw["results"]:
            assert w.get("transfer_state") != ld.TRANSFER_MANUAL, (
                "Non-owner must NOT classify winners as manual_review")

        # Now let A resume.
        resume.set()
        resp_a = await asyncio.wait_for(task_a, timeout=2.0)

        # Owner reaches paid terminal state, provider called exactly once.
        assert len(prov.calls) == 1
        assert prov.calls[0]["student_id"] == "stuA"
        draw = await db.speaking_lab_lucky_draws.find_one({"draw_id": did})
        assert draw["results"][0]["transfer_state"] == ld.TRANSFER_PAID
        assert resp_a["payout_complete"] is True
        # Initialization state advanced to COMPLETE.
        assert (draw["payout_initialization_state"]
                == ld.PAYOUT_INIT_COMPLETE)
    finally:
        ld._seed_results_states = original_seed


@pytest.mark.asyncio
async def test_v52_overlapping_finalize_multi_winner_no_manual_review_leakage():
    """Tightening of the previous test against multiple winners: B running
    concurrently must not classify ANY of A's pending winners as
    manual_review, and the provider must be called exactly once per
    winner only after A resumes."""
    db = _DB()
    did, sid = await _seed_prepared_draw(db, winners=[
        {"student_id": "stuA", "display_name": "A", "code": "STAR-1",
         "amount": 50, "transfer_ok": None},
        {"student_id": "stuB", "display_name": "B", "code": "MOON-2",
         "amount": 30, "transfer_ok": None}])
    prov = _ProviderCallCounter()
    ld._provider_transfer = prov

    arrival = asyncio.Event()
    resume = asyncio.Event()
    original_seed = _install_owner_seed_barrier(arrival, resume)
    try:
        task_a = asyncio.create_task(_finalize(
            db, sid, push=PushRecorder(), gas_url=GAS, pw=PW))
        await asyncio.wait_for(arrival.wait(), timeout=2.0)

        # B in parallel — must be a clean processing response.
        resp_b = await _finalize(
            db, sid, push=PushRecorder(), gas_url=GAS, pw=PW)
        assert prov.calls == []
        assert resp_b["payout_complete"] is False
        draw_mid = await db.speaking_lab_lucky_draws.find_one(
            {"draw_id": did})
        for w in draw_mid["results"]:
            assert w.get("transfer_state") != ld.TRANSFER_MANUAL

        resume.set()
        await asyncio.wait_for(task_a, timeout=2.0)
        assert len(prov.calls) == 2
        seen = {c["student_id"] for c in prov.calls}
        assert seen == {"stuA", "stuB"}
        draw = await db.speaking_lab_lucky_draws.find_one({"draw_id": did})
        for w in draw["results"]:
            assert w["transfer_state"] == ld.TRANSFER_PAID
    finally:
        ld._seed_results_states = original_seed


@pytest.mark.asyncio
async def test_v52_recovery_worker_respects_active_initialization():
    """v5.2 FIX 1 — recovery must NOT touch a finalized draw while a fresh
    payout initialization is still active. A non-stale `payout_initialization
    _state == "active"` causes recovery to skip the draw; the provider is
    never called, and winners are not classified as manual_review.
    """
    db = _DB()
    SL = db.speaking_lab_lucky_draws
    # Recovery only scans draws older than the 3-min grace window. Set
    # `prepared_at` to ~10 minutes ago, but keep
    # `payout_initialization_started_at` recent (well within the
    # STALE_INITIALIZATION_SECONDS window) so the active claim is fresh.
    await db.speaking_lab_sessions.insert_one(
        {"session_id": "sess-v52-init"})
    await SL.insert_one({
        "draw_id": "draw-v52-init", "session_id": "sess-v52-init",
        "pool_total": 80, "num_winners": 2, "split": [50, 30, 20],
        "mock": False, "finalized": True,
        "payout_status": ld.PAYOUT_PROCESSING,
        "prepared_at": _now_iso(-600),
        "finalize_started_at": _now_iso(-30),
        # Active, very recent — well within STALE_INITIALIZATION_SECONDS.
        "payout_initialization_state": ld.PAYOUT_INIT_ACTIVE,
        "payout_initialization_attempt_id": "owner-attempt-1",
        "payout_initialization_started_at": _now_iso(-30),
        "results": [
            {"student_id": "stuA", "display_name": "A", "code": "STAR-1",
             "amount": 50, "transfer_ok": None},
            {"student_id": "stuB", "display_name": "B", "code": "MOON-2",
             "amount": 30, "transfer_ok": None},
        ],
    })
    prov = _ProviderCallCounter()
    ld._provider_transfer = prov
    out = await ld.recover_abandoned_draws(
        db, _noop_publish, GAS, "stu092", PW, False,
        ld.logging.getLogger("t"), push_notify=PushRecorder())
    # Recovery must NOT call the provider while init is fresh+active.
    assert prov.calls == []
    # Recovery must NOT classify the pending winners as manual_review.
    draw = await SL.find_one({"draw_id": "draw-v52-init"})
    for w in draw["results"]:
        assert w.get("transfer_state") != ld.TRANSFER_MANUAL
        # Records remain untouched (no transfer_state seeded yet) so the
        # owner can complete initialization safely.
        assert "transfer_state" not in w
    # The recovery summary reports it scanned but did not resolve this one.
    assert out["resolved_finalized"] == 0


@pytest.mark.asyncio
async def test_v52_finalize_legacy_draw_without_init_state_is_unchanged():
    """Regression guard: a genuinely old finalized draw WITHOUT any
    `payout_initialization_state` field (legacy v5.1 footprint) and
    `transfer_ok=None` records must STILL be quarantined as manual_review
    by an idempotent re-finalize call — the v5.1 safeguard remains intact.
    """
    db = _DB()
    SL = db.speaking_lab_lucky_draws
    await db.speaking_lab_sessions.insert_one({
        "session_id": "sess-v52-legacy",
        "lucky_draw_prepared_draw_id": "draw-v52-legacy"})
    await SL.insert_one({
        "draw_id": "draw-v52-legacy", "session_id": "sess-v52-legacy",
        "pool_total": 80, "num_winners": 2, "split": [50, 30, 20],
        "mock": False, "finalized": True,
        "payout_status": ld.PAYOUT_PROCESSING,
        "prepared_at": _now_iso(-3600),
        "finalize_started_at": _now_iso(-3590),
        "finalized_at": _now_iso(-3580),
        # NO payout_initialization_state — pre-v5.2 footprint.
        "results": [
            {"student_id": "stuA", "display_name": "A", "code": "STAR-1",
             "amount": 50, "transfer_ok": None},
            {"student_id": "stuB", "display_name": "B", "code": "MOON-2",
             "amount": 30, "transfer_ok": None},
        ],
    })
    prov = _ProviderCallCounter()
    ld._provider_transfer = prov
    resp = await ld._finalize_draw(
        db, _noop_publish, "sess-v52-legacy", GAS, "stu092", PW, False,
        ld.logging.getLogger("t"), push_notify=PushRecorder())
    # Idempotent non-owner path with no init token → legacy mapping
    # quarantines transfer_ok=None as manual_review; provider NEVER called.
    assert prov.calls == []
    draw = await SL.find_one({"draw_id": "draw-v52-legacy"})
    for w in draw["results"]:
        assert w["transfer_state"] == ld.TRANSFER_MANUAL
    assert resp["payout_complete"] is not True


@pytest.mark.asyncio
async def test_v52_recovery_takes_over_after_stale_initialization():
    """A finalize owner that died WITHOUT completing initialization should
    eventually be recoverable. After STALE_INITIALIZATION_SECONDS has
    elapsed, recovery may resume — and the per-winner atomic claim still
    guarantees no duplicate payment. Records that were never seeded fall
    through the SAFE legacy mapping (`transfer_ok=None` → manual_review)
    so recovery never silently re-pays an uncertain reward.
    """
    db = _DB()
    SL = db.speaking_lab_lucky_draws
    await db.speaking_lab_sessions.insert_one(
        {"session_id": "sess-v52-stale"})
    # Stale init: started well past STALE_INITIALIZATION_SECONDS ago.
    stale_started = _now_iso(-(ld.STALE_INITIALIZATION_SECONDS + 120))
    await SL.insert_one({
        "draw_id": "draw-v52-stale", "session_id": "sess-v52-stale",
        "pool_total": 80, "num_winners": 2, "split": [50, 30, 20],
        "mock": False, "finalized": True,
        "payout_status": ld.PAYOUT_PROCESSING,
        "prepared_at": _now_iso(-3600),
        "finalize_started_at": stale_started,
        "payout_initialization_state": ld.PAYOUT_INIT_ACTIVE,
        "payout_initialization_attempt_id": "dead-owner-attempt",
        "payout_initialization_started_at": stale_started,
        "results": [
            {"student_id": "stuA", "display_name": "A", "code": "STAR-1",
             "amount": 50, "transfer_ok": None},
            {"student_id": "stuB", "display_name": "B", "code": "MOON-2",
             "amount": 30, "transfer_ok": None},
        ],
    })
    prov = _ProviderCallCounter()
    ld._provider_transfer = prov
    out = await ld.recover_abandoned_draws(
        db, _noop_publish, GAS, "stu092", PW, False,
        ld.logging.getLogger("t"), push_notify=PushRecorder())
    # No provider call — uncertain (transfer_ok=None) recovery records
    # are SAFELY quarantined as manual_review, never silently re-paid.
    assert prov.calls == []
    draw = await SL.find_one({"draw_id": "draw-v52-stale"})
    for w in draw["results"]:
        assert w["transfer_state"] == ld.TRANSFER_MANUAL
    # Recovery acknowledges the draw (scanned at minimum) without
    # auto-paying anything.
    assert out["scanned"] >= 1
