"""
speaking_lab_wallet_payout.py — WalletService transport for Speaking Lab
Lucky Draw payouts (v2.0, dark by default).

This module is intentionally tiny. It does NOT duplicate any part of
`lucky_draw._process_winner`'s state machine (claim / persist / push /
retry / manual-review) — that machinery is reused completely unchanged.
This module supplies exactly one thing: an alternative implementation of
the "call the payout provider" step, with the EXACT SAME outcome contract
as `lucky_draw._provider_transfer`:

    {"outcome": "paid" | "failed_safe_to_retry" | "manual_review" | "mock",
     "provider_status": str, "provider_reference": str | None, "error": str}

`lucky_draw._select_transfer_outcome` (the transport-selection seam,
the ONLY place that imports this module) checks
`speaking_lab_feature_flags.wallet_payout_enabled(db)` and calls either
`_provider_transfer` (existing GAS path, byte-for-byte unchanged) or
`wallet_transfer_outcome` below. Gated OFF by default; flipping the flag
on has no effect anywhere else in the codebase — nothing else imports or
calls this module.
"""

from __future__ import annotations

import logging

import wallet_service as ws
import lucky_draw as ld

logger = logging.getLogger("eduhub.speaking_lab_wallet_payout")


async def wallet_transfer_outcome(
    db, treasury_id: str, student_id: str, amount: int, *,
    stable_reference: str, attempt_id: str,
) -> dict:
    """WalletService-backed replacement for `lucky_draw._provider_transfer`.
    Same outcome contract, same caller expectations — the state machine in
    `_process_winner` cannot tell which transport ran.

    A WalletService transfer either succeeds outright (paid) or raises a
    well-typed exception (InsufficientFunds / WalletStatusBlocked /
    WalletNotFound) — there is no GAS-style "uncertain network timeout"
    case for a local Mongo transaction, so a fresh attempt never needs to
    report manual_review on its own; an unexpected exception is still
    conservatively classified as manual_review, never silently retried."""
    svc = ws.WalletService(db)
    try:
        await svc.transfer(
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
