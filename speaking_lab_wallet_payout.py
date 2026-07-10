"""
speaking_lab_wallet_payout.py — LOCAL DARK WalletService payout transport
for Speaking Lab Lucky Draw (v1.0, NEVER ACTIVATED IN PRODUCTION)
=============================================================================

This module is a COMPLETE, SEPARATE, PARALLEL implementation of the winner
payout transport — it does NOT modify ``lucky_draw.py``'s existing
``_process_winner`` or any of its six call sites, and it is never imported
or wired into the live route registration. Its only purpose in this
delivery is to PROVE the WalletService-based architecture is buildable
while guaranteeing ZERO risk to the production GAS-based payout path,
which remains completely untouched.

Gated by ``speaking_lab_feature_flags.wallet_payout_enabled`` — always
False in production until an explicit, separately-approved cutover. This
module is not called from any registered route in this delivery.

Reuses (imports, never duplicates the logic of):
  * the exact atomic per-winner claim helpers already proven for the GAS
    path (``_claim_winner_initial`` / ``_claim_winner_retry`` /
    ``_claim_winner_manual_release`` / ``_set_winner_fields``);
  * the exact exactly-once push notification helper
    (``_send_winner_push_idempotent``);
  * the exact transfer-state constants and stable-reference scheme
    (``_stable_reference``, ``TRANSFER_PAID`` etc.);
  * ``_aggregate_payout_status``.

None of these are among the protected functions (``_weighted_pick``,
``_normalize_split``, ``_run_draw``, ``_sl_try_auto_enter``) — winner
SELECTION, ranking, and prize AMOUNTS are computed entirely upstream of
this module (by ``_run_draw``, untouched) and simply passed through
unchanged; this module only ever changes HOW a winner's already-decided
amount is transported to their account.
"""

from __future__ import annotations

import logging
from datetime import datetime, timezone
from typing import Optional

import wallet_service as ws
import lucky_draw as ld

logger = logging.getLogger("eduhub.speaking_lab_wallet_payout")


async def _wallet_transfer_outcome(
    db, treasury_id: str, student_id: str, amount: int, *,
    stable_reference: str, attempt_id: str,
) -> dict:
    """Mirrors `_provider_transfer`'s exact structured-outcome contract
    (lucky_draw.py) but executes via WalletService instead of GAS:

        {"outcome": "paid" | "failed_safe_to_retry" | "manual_review" | "mock",
         "provider_status": str, "provider_reference": str | None, "error": str}

    A WalletService transfer either succeeds outright (paid) or raises a
    well-typed exception (InsufficientFunds / WalletStatusBlocked /
    WalletNotFound / TransferNotAtomic) — there is no GAS-style "uncertain
    network timeout" case for a local Mongo transaction, so this transport
    never needs to report `manual_review` for a fresh attempt. It is kept
    in the return contract only for state-machine symmetry with the GAS
    path (e.g. an unexpected exception is still conservatively classified
    as manual_review, never silently retried)."""
    svc = ws.WalletService(db)
    try:
        result = await svc.transfer(
            treasury_id, student_id, amount,
            source="speaking_lab_lucky_draw_payout_wallet",
            source_ref=stable_reference,
            idempotency_key=stable_reference,
        )
        return {
            "outcome": ld.TRANSFER_PAID,
            "provider_status": "wallet_transfer_ok",
            "provider_reference": stable_reference,
            "error": "",
        }
    except ws.InsufficientFunds as exc:
        # Treasury underfunded — a real, provable failure, safe to retry
        # once the treasury is topped up. Never silently resent blindly.
        return {
            "outcome": ld.TRANSFER_FAILED_RETRY,
            "provider_status": "insufficient_treasury_funds",
            "provider_reference": None,
            "error": str(exc)[:200],
        }
    except ws.WalletStatusBlocked as exc:
        return {
            "outcome": ld.TRANSFER_FAILED_RETRY,
            "provider_status": "wallet_status_blocked",
            "provider_reference": None,
            "error": str(exc)[:200],
        }
    except Exception as exc:  # noqa: BLE001 — never assume success on the unexpected
        logger.warning(
            "speaking_lab_wallet_payout: unexpected transfer error ref=%s err=%s",
            stable_reference, str(exc)[:200],
        )
        return {
            "outcome": ld.TRANSFER_MANUAL,
            "provider_status": "unexpected_error",
            "provider_reference": None,
            "error": str(exc)[:200],
        }


async def process_winner_wallet_transport(
    db, SL_DRAWS, sl_publish, session_id, draw_id, rank, rec,
    treasury_id: str, use_mock: bool, log, push_notify, *, mode: str,
) -> dict:
    """LOCAL DARK counterpart to `lucky_draw._process_winner`, using
    WalletService instead of GAS for the transfer step. Never imported by
    server.py's live route registration in this delivery — exists to be
    tested standalone and to prove the architecture, per the explicit
    "do not activate" instruction.

    Mirrors `_process_winner`'s exact atomic-claim -> transfer ->
    persist -> push structure so its safety properties (attempt
    ownership, exactly-once payout, manual-review quarantine,
    notification-only retry) are preserved by construction, not by
    coincidence."""
    import uuid as _uuid

    student_id = rec.get("student_id")
    code = rec.get("code") or ""
    amount = int(rec.get("amount") or 0)
    stable_ref = ld._stable_reference(draw_id, session_id, student_id)
    attempt_id = _uuid.uuid4().hex
    now_iso = datetime.now(timezone.utc).isoformat()

    if mode == "initial":
        claimed = await ld._claim_winner_initial(
            SL_DRAWS, draw_id, student_id, stable_ref, attempt_id, now_iso)
    elif mode == "retry":
        claimed = await ld._claim_winner_retry(
            SL_DRAWS, draw_id, student_id, stable_ref, attempt_id, now_iso)
    elif mode == "manual_release":
        claimed = await ld._claim_winner_manual_release(
            SL_DRAWS, draw_id, student_id, stable_ref, attempt_id, now_iso)
    else:
        claimed = False

    if not claimed:
        fresh = await SL_DRAWS.find_one({"draw_id": draw_id}, {"_id": 0})
        for w in (fresh or {}).get("results", []):
            if w.get("student_id") == student_id:
                return dict(w)
        return dict(rec)

    if use_mock:
        outcome = {"outcome": ld.TRANSFER_MOCK, "provider_status": "mock",
                  "provider_reference": None, "error": ""}
    else:
        outcome = await _wallet_transfer_outcome(
            db, treasury_id, student_id, amount,
            stable_reference=stable_ref, attempt_id=attempt_id,
        )
    completed_at = datetime.now(timezone.utc).isoformat()
    result_state = outcome["outcome"]

    if result_state == ld.TRANSFER_PAID:
        try:
            persisted = await ld._set_winner_fields(SL_DRAWS, draw_id, student_id, {
                "transfer_state":           ld.TRANSFER_PAID,
                "transfer_ok":              True,
                "transfer_err":             "",
                "transfer_completed_at":    completed_at,
                "transfer_provider_status": outcome["provider_status"],
                "transfer_provider_reference": outcome["provider_reference"],
                "transfer_last_error":      "",
                "manual_review_reason":     "",
                "transfer_transport":       "wallet",
            }, expected_attempt_id=attempt_id, require_in_progress=True)
            if persisted != 1:
                raise RuntimeError(
                    "paid-state update modified 0 documents — newer attempt "
                    "may have superseded this one")
        except Exception as exc:  # noqa: BLE001
            if log:
                log.critical(
                    "speaking_lab_wallet_payout: CRITICAL — wallet transfer "
                    "PAID but Mongo persist failed ref=%s err=%s",
                    stable_ref, str(exc)[:200])
            try:
                await ld._set_winner_fields(SL_DRAWS, draw_id, student_id, {
                    "transfer_state":       ld.TRANSFER_MANUAL,
                    "transfer_ok":          None,
                    "manual_review_reason": "wallet_paid_but_persist_failed",
                    "transfer_provider_status": outcome["provider_status"],
                }, expected_attempt_id=attempt_id, require_in_progress=True)
            except Exception:  # noqa: BLE001
                pass
        else:
            await ld._send_winner_push_idempotent(
                SL_DRAWS, draw_id, student_id, amount, code, stable_ref,
                push_notify, log)
    elif result_state == ld.TRANSFER_FAILED_RETRY:
        await ld._set_winner_fields(SL_DRAWS, draw_id, student_id, {
            "transfer_state":           ld.TRANSFER_FAILED_RETRY,
            "transfer_ok":              False,
            "transfer_last_error":      outcome["error"],
            "transfer_provider_status": outcome["provider_status"],
        }, expected_attempt_id=attempt_id, require_in_progress=True)
    elif result_state == ld.TRANSFER_MOCK:
        await ld._set_winner_fields(SL_DRAWS, draw_id, student_id, {
            "transfer_state":           ld.TRANSFER_MOCK,
            "transfer_ok":              True,
            "transfer_provider_status": "mock",
        }, expected_attempt_id=attempt_id, require_in_progress=True)
    else:  # manual_review
        await ld._set_winner_fields(SL_DRAWS, draw_id, student_id, {
            "transfer_state":           ld.TRANSFER_MANUAL,
            "transfer_ok":              None,
            "manual_review_reason":     outcome["provider_status"],
            "transfer_last_error":      outcome["error"],
        }, expected_attempt_id=attempt_id, require_in_progress=True)

    fresh = await SL_DRAWS.find_one({"draw_id": draw_id}, {"_id": 0})
    for w in (fresh or {}).get("results", []):
        if w.get("student_id") == student_id:
            return dict(w)
    return dict(rec)
