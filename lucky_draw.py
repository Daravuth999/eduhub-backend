"""
lucky_draw.py — Speaking Lab Lucky Draw season-long prize pool.

ADDITIVE ONLY. This module exposes:

  • register_lucky_draw_routes(api, db, sl_publish, gas_url, treasury_id,
                               treasury_password, *, log=None, mock_gas=False,
                               require_admin=None)
        Mounts 4 new endpoints on the existing `api` router:
            POST /api/speaking-lab/sessions/{id}/pool-entry
            GET  /api/speaking-lab/sessions/{id}/pool
            POST /api/speaking-lab/sessions/{id}/lucky-draw
            GET  /api/speaking-lab/sessions/{id}/lucky-codes

  • generate_and_publish_lucky_code(db, sl_publish, session_id, student_id,
                                    display_name, *, amount=0, log=None)
        Generate a unique 4-char lucky code for this (session_id, student_id),
        persist it, and broadcast TWO SSE events:
            • {type: "lucky_code", student_id, display_name, code,
               entry_fee, pool_total, player_count}
            • {type: "pool_update", pool_total, player_count}
        Idempotent — re-calling for the same (session_id, student_id) returns
        the existing code without double-counting the pool.

NO existing function in server.py is modified. The integration points are:
   1. Add `from lucky_draw import register_lucky_draw_routes,
                                   generate_and_publish_lucky_code`
      to server.py imports.
   2. Right before `app.include_router(api)`, call
      `register_lucky_draw_routes(api, db, _sl_publish, GAS_POINTS_LOGIN_URL,
       SL_TREASURY_ID, SL_TREASURY_PASSWORD,
       log=log, require_admin=require_admin)`.
   3. Inside `_sl_try_auto_enter`, immediately after the existing
      `await _sl_publish(session_id, {"type": "entry", ...})` line, add:
        `await generate_and_publish_lucky_code(db, _sl_publish,
            session_id, sender_id, display_name, amount=amount, log=log)`

That's it. All persisted state lives in two new Mongo collections:
   • speaking_lab_lucky_codes   { session_id, student_id, code, display_name,
                                  entry_fee, awarded_at }
   • speaking_lab_lucky_draws   audit row of each draw

GAS calls
---------
For each winner we call GAS sendPoints(treasury -> winner) using the same
shape as `sl_grant_points` in server.py. Pass `mock_gas=True` (or set env
LUCKY_DRAW_MOCK_GAS=1) to skip the GAS call and simulate success — used in
local dev / tests.

Weighted draw
-------------
Players who were NEVER picked by the slot machine during the session get a
2× weight (the "smart diversity" rule). The slot-picked set comes from the
session document's "slot_picks" field if present, otherwise no penalty
applies.  Pool is split per the session's settings doc.
"""

from __future__ import annotations

import asyncio
import logging
import os
import random
import secrets
import string
import uuid
from datetime import datetime, timezone, timedelta
from typing import Awaitable, Callable, Iterable, Optional

import httpx
from fastapi import APIRouter, Depends, HTTPException, Path, Request
from pydantic import BaseModel, ConfigDict, Field


# ---------------------------------------------------------------------------
# Lucky code generator — [WORD]-[DIGIT 1-9]. 16 words × 9 digits = 144 codes.
# ---------------------------------------------------------------------------

_LUCKY_WORDS = (
    # nature
    "STAR", "MOON", "FIRE", "WAVE", "WIND", "RAIN", "LEAF", "GOLD",
    # action
    "BOLT", "RUSH", "GLOW", "LEAP", "DASH", "ZOOM",
    # power
    "KING", "NOVA",
)
_LUCKY_DIGITS = tuple(str(n) for n in range(1, 10))  # "1".."9"

LUCKY_CODE_POOL_SIZE = len(_LUCKY_WORDS) * len(_LUCKY_DIGITS)  # 144


def _all_codes() -> list[str]:
    return [f"{w}-{d}" for w in _LUCKY_WORDS for d in _LUCKY_DIGITS]


async def _pick_unused_code(db, session_id: str) -> str:
    """Return a code not yet used in this session. O(1) expected; falls back
    to suffix if the whole 144-pool is exhausted (very large class)."""
    used_cursor = db.speaking_lab_lucky_codes.find(
        {"session_id": session_id}, {"_id": 0, "code": 1},
    )
    used: set[str] = set()
    async for row in used_cursor:
        c = row.get("code")
        if c:
            used.add(c)
    candidates = [c for c in _all_codes() if c not in used]
    if candidates:
        return random.choice(candidates)
    # Pool exhausted — append a short random suffix to keep generating uniquely.
    base = random.choice(_all_codes())
    suffix = "".join(random.choices(string.ascii_uppercase + string.digits, k=2))
    return f"{base}{suffix}"


# ---------------------------------------------------------------------------
# Pydantic models
# ---------------------------------------------------------------------------

class PoolEntryBody(BaseModel):
    """Body for POST /sessions/{id}/pool-entry. All fields optional except
    student_id — the typical caller is the P2P auto-enter hook, which has
    the sender id and display name in hand. Direct callers (e.g. a manual
    "force entry" admin button) may also POST here."""
    model_config = ConfigDict(extra="ignore")
    student_id: str = Field(..., min_length=1, max_length=128)
    display_name: Optional[str] = Field(default=None, max_length=128)
    entry_fee: int = Field(default=0, ge=0, le=100000)


class LuckyDrawConfig(BaseModel):
    """Optional override sent by the teacher with POST /lucky-draw. Falls
    back to the session's settings doc, then to the defaults."""
    model_config = ConfigDict(extra="ignore")
    num_winners: Optional[int] = Field(default=None, ge=1, le=3)
    split: Optional[list[int]] = None        # e.g. [50, 30, 20] — percentages
    slot_picks: Optional[list[str]] = None    # student_ids picked by slot during session
    mock: Optional[bool] = None               # force mock GAS for this draw only


class RetryFailedBody(BaseModel):
    """Body for POST /lucky-draw/retry-failed (FIX 9 + v5 FIX 3).

    v5 (FIX 3): the retry endpoint is now STUDENT-SPECIFIC. A single admin
    confirmation may only release ONE manual_review winner. The exact
    `student_id` is required for any manual override; without it, only
    `failed_safe_to_retry` winners are processed (and even then a
    `student_id` may be supplied to scope the retry to one student).

    Empty body still retries every `failed_safe_to_retry` winner in the
    draw (this is the pre-existing "drain safe failures" behaviour and
    NEVER releases manual_review winners). Operators releasing a
    manual_review winner MUST supply all of:
        student_id        — exact target winner
        confirm_not_paid  — True
        reason            — non-empty explanation
    """
    model_config = ConfigDict(extra="ignore")
    confirm_not_paid: bool = False
    reason: Optional[str] = Field(default=None, max_length=1024)
    # v5 (FIX 3): exact student selector. Required when `confirm_not_paid`
    # is True; optional otherwise (then the safe-failure drain applies).
    student_id: Optional[str] = Field(default=None, min_length=1, max_length=128)


class HistoricalReconcileBody(BaseModel):
    """Body for POST /lucky-draw/reconcile-historical (FIX 11)."""
    model_config = ConfigDict(extra="ignore")
    confirm_historical_recovery: bool = False
    reason: Optional[str] = Field(default=None, max_length=1024)


DEFAULT_SPLIT = [50, 30, 20]
DEFAULT_NUM_WINNERS = 3


# ---------------------------------------------------------------------------
# v3 PAYOUT STATE MACHINE (FIX 2–8, 13)
# ---------------------------------------------------------------------------
# Per-winner transfer states (persisted in
# speaking_lab_lucky_draws.results[].transfer_state). Legacy boolean
# `transfer_ok` is preserved alongside for backward compatibility.
TRANSFER_PENDING       = "pending"
TRANSFER_IN_PROGRESS   = "in_progress"
TRANSFER_PAID          = "paid"
TRANSFER_FAILED_RETRY  = "failed_safe_to_retry"
TRANSFER_MANUAL        = "manual_review"
TRANSFER_MOCK          = "mock"

# Draw-level aggregate payout status (FIX 13).
PAYOUT_PROCESSING              = "processing"
PAYOUT_COMPLETED               = "completed"
PAYOUT_COMPLETED_WITH_FAILURES = "completed_with_failures"
PAYOUT_MANUAL_REVIEW           = "manual_review"
PAYOUT_MOCK                    = "mock"

# Push notification states (FIX 12).
PUSH_PENDING = "pending"
PUSH_SENT    = "sent"
PUSH_FAILED  = "failed"
# v4 (FIX 4): added intermediate + zero-subscriber states for truthful delivery.
PUSH_SENDING        = "sending"
PUSH_NO_SUBSCRIBERS = "no_subscribers"
# An in_progress/sending push older than this is considered stale.
PUSH_STALE_SECONDS = 120

# Browser-abandoned recovery windows (FIX 10/11).
RECOVERY_GRACE_SECONDS  = 3 * 60      # never auto-finalize draws younger than this
RECOVERY_MAX_AGE_SECONDS = 24 * 60 * 60  # never auto-process draws older than this
RECOVERY_BATCH_LIMIT    = 20
RECOVERY_INTERVAL_SECONDS = 60


# Provider-configuration outcomes (FIX 2).
def _payout_config_state(gas_url: str, treasury_password: str,
                         use_mock: bool) -> str:
    """Return one of: 'mock', 'provider_not_configured', 'ok'.

    A MISSING configuration is NEVER silently treated as a successful
    mock payment. Mock mode is only entered when explicitly requested.
    """
    if use_mock:
        return "mock"
    if not gas_url:
        return "provider_not_configured"
    if not treasury_password:
        return "provider_not_configured"
    return "ok"


def _stable_reference(draw_id: str, session_id: str, student_id: str) -> str:
    """One stable logical reference per reward obligation (FIX 4).

    Reused across initial payout, safe retry, shadow ledger, audit logs,
    push deduplication and reconciliation. A retry uses a fresh
    `transfer_attempt_id` but NEVER a new reward identity.
    """
    return f"lucky_draw:{draw_id}:{session_id}:{student_id}"


def _legacy_state_for_record(rec: dict) -> str:
    """Map a legacy/in-flight winner record to a v3 transfer_state when one
    is not already present (FIX 3 legacy mapping; v5 FIX 4 tightening).

      transfer_ok == True                        -> paid
      transfer_ok == False (no proven pre-send)  -> manual_review
      transfer_ok is None/missing                -> manual_review  (v5 FIX 4)

    v5 (FIX 4): a legacy finalized winner with `transfer_ok is None` and
    `transfer_state` missing is UNCERTAIN — the provider outcome was never
    persisted. It MUST be quarantined as manual_review so background
    recovery never auto-resends points and historical reconciliation never
    re-calls the provider without an explicit student-specific operator
    confirmation. Mapping such legacy records to `pending` (the v4 default)
    would let recovery silently re-pay them.

    NOTE: a legacy `transfer_ok == False` is also NOT blindly mapped to
    failed_safe_to_retry — the original boolean does not prove the send
    never credited the student, so it stays manual_review.
    """
    state = rec.get("transfer_state")
    if state in (TRANSFER_PENDING, TRANSFER_IN_PROGRESS, TRANSFER_PAID,
                 TRANSFER_FAILED_RETRY, TRANSFER_MANUAL, TRANSFER_MOCK):
        return state
    ok = rec.get("transfer_ok")
    if ok is True:
        return TRANSFER_PAID
    if ok is False:
        return TRANSFER_MANUAL
    # v5 (FIX 4): None / missing → manual_review (never pending).
    return TRANSFER_MANUAL


def _aggregate_payout_status(results: list[dict], *, use_mock: bool) -> str:
    """Compute the draw-level payout_status from per-winner states (FIX 13)."""
    if use_mock:
        return PAYOUT_MOCK
    states = [_legacy_state_for_record(r) for r in results]
    if any(s == TRANSFER_IN_PROGRESS for s in states):
        return PAYOUT_PROCESSING
    if any(s == TRANSFER_MANUAL for s in states):
        return PAYOUT_MANUAL_REVIEW
    if any(s == TRANSFER_FAILED_RETRY for s in states):
        return PAYOUT_COMPLETED_WITH_FAILURES
    if states and all(s == TRANSFER_PAID for s in states):
        return PAYOUT_COMPLETED
    if any(s == TRANSFER_PENDING for s in states):
        return PAYOUT_PROCESSING
    return PAYOUT_COMPLETED


def _payout_counts(results: list[dict]) -> dict:
    """Per-state tallies for a truthful response (FIX 13)."""
    counts = {
        "paid_count": 0, "safe_failure_count": 0, "manual_review_count": 0,
        "pending_count": 0, "in_progress_count": 0, "mock_count": 0,
    }
    for r in results:
        st = _legacy_state_for_record(r)
        if st == TRANSFER_PAID:
            counts["paid_count"] += 1
        elif st == TRANSFER_FAILED_RETRY:
            counts["safe_failure_count"] += 1
        elif st == TRANSFER_MANUAL:
            counts["manual_review_count"] += 1
        elif st == TRANSFER_PENDING:
            counts["pending_count"] += 1
        elif st == TRANSFER_IN_PROGRESS:
            counts["in_progress_count"] += 1
        elif st == TRANSFER_MOCK:
            counts["mock_count"] += 1
    return counts


# ---------------------------------------------------------------------------
# Helpers used by both the SSE hook and the HTTP endpoints
# ---------------------------------------------------------------------------

async def _pool_state(db, session_id: str) -> dict:
    """Return {pool_total, player_count, entry_fee_sum} for a session."""
    cursor = db.speaking_lab_lucky_codes.find(
        {"session_id": session_id}, {"_id": 0, "entry_fee": 1},
    )
    total = 0
    count = 0
    async for row in cursor:
        total += int(row.get("entry_fee") or 0)
        count += 1
    return {"pool_total": total, "player_count": count}


async def generate_and_publish_lucky_code(
    db,
    sl_publish: Callable[[str, dict], Awaitable[None]],
    session_id: str,
    student_id: str,
    display_name: str,
    *,
    amount: int = 0,
    log: Optional[logging.Logger] = None,
) -> Optional[dict]:
    """Public helper for `_sl_try_auto_enter` to call. Idempotent.

    Returns the lucky code doc (or None on error — never raises into the
    caller, since this is fire-and-forget)."""
    try:
        # Deduplicate
        existing = await db.speaking_lab_lucky_codes.find_one(
            {"session_id": session_id, "student_id": student_id}, {"_id": 0},
        )
        if existing:
            return existing

        code = await _pick_unused_code(db, session_id)
        awarded_at = datetime.now(timezone.utc).isoformat()
        doc = {
            "session_id":  session_id,
            "student_id":  student_id,
            "display_name": display_name,
            "code":         code,
            "entry_fee":    int(amount or 0),
            "awarded_at":   awarded_at,
        }
        try:
            await db.speaking_lab_lucky_codes.insert_one(dict(doc))
        except Exception as exc:
            # Most likely a unique-index race — fetch the winning insert.
            if log:
                log.info("lucky_draw: insert race for %s/%s: %s",
                         session_id, student_id, str(exc)[:120])
            existing = await db.speaking_lab_lucky_codes.find_one(
                {"session_id": session_id, "student_id": student_id}, {"_id": 0},
            )
            return existing

        # Pool snapshot (after this entry)
        state = await _pool_state(db, session_id)

        # SSE: detailed code reveal (drives LuckyCodeSplash on the teacher screen)
        await sl_publish(session_id, {
            "type":         "lucky_code",
            "student_id":   student_id,
            "display_name": display_name,
            "code":         code,
            "entry_fee":    int(amount or 0),
            "pool_total":   state["pool_total"],
            "player_count": state["player_count"],
            "awarded_at":   awarded_at,
        })
        # SSE: lightweight ticker update (drives PoolTicker)
        await sl_publish(session_id, {
            "type":         "pool_update",
            "pool_total":   state["pool_total"],
            "player_count": state["player_count"],
        })

        if log:
            log.info("lucky_draw: %s got code %s in %s (pool=%d, n=%d)",
                     display_name, code, session_id,
                     state["pool_total"], state["player_count"])
        return doc
    except Exception as exc:  # noqa: BLE001
        if log:
            log.warning("lucky_draw: generate_and_publish error: %s", str(exc)[:200])
        return None


# ---------------------------------------------------------------------------
# Weighted draw
# ---------------------------------------------------------------------------

def _weighted_pick(
    candidates: list[dict], slot_picked: set[str], k: int,
) -> list[dict]:
    """Return k distinct picks. Each candidate has 2× weight if their
    student_id is NOT in slot_picked, else weight 1."""
    pool = list(candidates)
    chosen: list[dict] = []
    while pool and len(chosen) < k:
        weights = [2 if (c.get("student_id") not in slot_picked) else 1 for c in pool]
        idx = random.choices(range(len(pool)), weights=weights, k=1)[0]
        chosen.append(pool.pop(idx))
    return chosen


def _normalize_split(split: list[int], num_winners: int, pool_total: int) -> list[int]:
    """Trim/pad split to num_winners and convert to integer point amounts that
    sum to <= pool_total."""
    parts = list(split)[:num_winners]
    while len(parts) < num_winners:
        parts.append(0)
    s = sum(parts)
    if s <= 0:
        # Even split
        each = pool_total // num_winners
        amounts = [each] * num_winners
        amounts[0] += pool_total - sum(amounts)
        return amounts
    amounts = [(pool_total * p) // s for p in parts]
    # Distribute remainder to the first winner
    remainder = pool_total - sum(amounts)
    if amounts:
        amounts[0] += remainder
    return amounts


# ---------------------------------------------------------------------------
# GAS treasury transfer (sendPoints) — same shape as sl_grant_points
# ---------------------------------------------------------------------------

async def _gas_send_points(
    gas_url: str,
    treasury_id: str,
    treasury_password: str,
    receiver_clean_id: str,
    amount: int,
    *,
    mock: bool,
    log: Optional[logging.Logger] = None,
) -> tuple[bool, str]:
    if mock or not gas_url or not treasury_password:
        if log:
            log.info("lucky_draw[MOCK]: would send %d pts to %s",
                     amount, receiver_clean_id)
        return True, "mock"
    payload = {
        "action":     "sendPoints",
        "id":         treasury_id,
        "password":   treasury_password,
        "receiverId": receiver_clean_id,
        "amount":     str(amount),
        "nonce":      secrets.token_hex(12),
    }
    try:
        async with httpx.AsyncClient(
            timeout=httpx.Timeout(12.0, connect=6.0),
            follow_redirects=True,
        ) as cli:
            r = await cli.post(gas_url, data=payload)
            if r.status_code != 200:
                return False, f"HTTP {r.status_code}"
            try:
                j = r.json()
            except Exception:
                return False, r.text[:200]
            if isinstance(j, dict) and j.get("success") is True:
                return True, "ok"
            return False, str(j.get("message") or j.get("error") or j)[:200]
    except Exception as exc:  # noqa: BLE001
        return False, str(exc)[:200]


# ---------------------------------------------------------------------------
# v3 classified provider transfer (FIX 6)
# ---------------------------------------------------------------------------
# Returns a structured outcome dict instead of an ambiguous boolean:
#   {
#     "outcome": "paid" | "failed_safe_to_retry" | "manual_review" | "mock",
#     "provider_status": str,
#     "provider_reference": str | None,
#     "error": str,
#   }
#
# Classification contract:
#   paid                 -> provider EXPLICITLY confirmed success (200 +
#                           success:true). Provider reference captured where
#                           available.
#   failed_safe_to_retry -> PROVEN no-send / no-credit: missing config, local
#                           validation/serialisation failure, DNS failure or
#                           connection refused BEFORE the request left us, or
#                           an explicit provider response proving no transfer
#                           occurred (200 + success:false).
#   manual_review        -> UNCERTAIN: read timeout, connection dropped after
#                           send may have started, invalid/ambiguous response,
#                           unknown HTTP status. NEVER auto-retried.
#   mock                 -> explicit development mock mode only.
async def _provider_transfer(
    gas_url: str,
    treasury_id: str,
    treasury_password: str,
    receiver_clean_id: str,
    amount: int,
    *,
    use_mock: bool,
    stable_reference: str,
    attempt_id: str,
    log: Optional[logging.Logger] = None,
) -> dict:
    cfg = _payout_config_state(gas_url, treasury_password, use_mock)
    if cfg == "mock":
        if log:
            log.info("lucky_draw[MOCK]: would send %d pts to %s (ref=%s)",
                     amount, receiver_clean_id, stable_reference)
        return {"outcome": TRANSFER_MOCK, "provider_status": "mock",
                "provider_reference": None, "error": ""}
    if cfg == "provider_not_configured":
        # Proven no-send: we never contacted the provider.
        return {"outcome": TRANSFER_FAILED_RETRY,
                "provider_status": "provider_not_configured",
                "provider_reference": None,
                "error": "provider_not_configured"}

    # Local validation (proven no-send).
    if not receiver_clean_id or amount <= 0:
        return {"outcome": TRANSFER_FAILED_RETRY,
                "provider_status": "local_validation_failed",
                "provider_reference": None,
                "error": "invalid receiver or amount"}

    # NOTE (FIX 4): GAS sendPoints offers NO provider-enforced idempotency
    # keyed on a stable client reference — it only accepts receiverId/amount
    # plus a per-request `nonce` (best-effort 5-min anti-replay). We send the
    # stable logical reference as an informational `clientRef` for forensic
    # correlation only; it does NOT guarantee dedup at the provider. Concurrency
    # is therefore guarded by MongoDB atomic claims, and uncertain outcomes are
    # quarantined as manual_review.
    payload = {
        "action":     "sendPoints",
        "id":         treasury_id,
        "password":   treasury_password,
        "receiverId": receiver_clean_id,
        "amount":     str(amount),
        "nonce":      secrets.token_hex(12),
        "clientRef":  stable_reference,
        "attemptId":  attempt_id,
    }
    try:
        async with httpx.AsyncClient(
            timeout=httpx.Timeout(12.0, connect=6.0),
            follow_redirects=True,
        ) as cli:
            r = await cli.post(gas_url, data=payload)
    except (httpx.ConnectError, httpx.ConnectTimeout) as exc:
        # Failure BEFORE the request was transmitted (DNS / refused / connect
        # timeout) — proven no-send.
        return {"outcome": TRANSFER_FAILED_RETRY,
                "provider_status": "connect_error",
                "provider_reference": None,
                "error": str(exc)[:200]}
    except (httpx.ReadTimeout, httpx.WriteTimeout, httpx.PoolTimeout,
            httpx.RemoteProtocolError) as exc:
        # The request may have been sent / partially processed — UNCERTAIN.
        return {"outcome": TRANSFER_MANUAL,
                "provider_status": "timeout_or_dropped",
                "provider_reference": None,
                "error": str(exc)[:200]}
    except Exception as exc:  # noqa: BLE001 — unknown transport outcome
        return {"outcome": TRANSFER_MANUAL,
                "provider_status": "unknown_transport_error",
                "provider_reference": None,
                "error": str(exc)[:200]}

    if r.status_code != 200:
        # We got an HTTP response but a non-200 is an unknown payment outcome.
        return {"outcome": TRANSFER_MANUAL,
                "provider_status": f"http_{r.status_code}",
                "provider_reference": None,
                "error": (r.text or "")[:200]}
    try:
        j = r.json()
    except Exception:
        # Ambiguous / invalid provider response — UNCERTAIN.
        return {"outcome": TRANSFER_MANUAL,
                "provider_status": "invalid_json",
                "provider_reference": None,
                "error": (r.text or "")[:200]}
    if isinstance(j, dict) and j.get("success") is True:
        # ── v5 (FIX 6): GAS response contract.
        # The active GAS `sendPoints` integration does NOT echo `clientRef`
        # and does NOT return a stable transaction id. Existing production-
        # compatible callers (`payment_bridge.py`, `voice_treasure_points_
        # adapter.py`) treat `{"success": true}` from a 200 response as a
        # successful credit and rely on caller-side stable references +
        # MongoDB atomic claims for dedup. We mirror that contract here:
        #
        #   • 200 + {"success": true}                  → paid
        #   • 200 + {"success": true, "amount": X}     → recipient/amount
        #                                                  validated when echoed;
        #                                                  contradiction → manual_review
        #   • 200 + {"success": true, "clientRef": …}  → validated when echoed;
        #                                                  contradiction → manual_review
        #   • 200 + {"success": false}                  → failed_safe_to_retry
        #   • non-200 / timeout / invalid JSON          → manual_review
        #
        # The stable logical reference is sent in the request body as
        # `clientRef` for forensic correlation only; uncertain outcomes are
        # still quarantined and resolved by operator confirmation.
        provider_ref = (
            j.get("transactionId") or j.get("transaction_id")
            or j.get("txnId") or j.get("transferId")
            or j.get("ref") or j.get("reference") or None
        )
        echoed_ref = j.get("clientRef") or j.get("client_ref") or None
        # Contradiction checks (only when the provider echoes the field).
        echoed_recipient = (
            j.get("receiverId") or j.get("recipientId")
            or j.get("recipient") or j.get("to") or None
        )
        if echoed_recipient is not None and \
                str(echoed_recipient) != str(receiver_clean_id):
            return {"outcome": TRANSFER_MANUAL,
                    "provider_status": "recipient_mismatch",
                    "provider_reference": provider_ref,
                    "error": f"recipient echo {echoed_recipient!r} != "
                             f"{receiver_clean_id!r}"}
        if "amount" in j:
            try:
                if int(j.get("amount")) != int(amount):
                    return {"outcome": TRANSFER_MANUAL,
                            "provider_status": "amount_mismatch",
                            "provider_reference": provider_ref,
                            "error": f"amount echo {j.get('amount')!r} != "
                                     f"{amount!r}"}
            except (TypeError, ValueError):
                return {"outcome": TRANSFER_MANUAL,
                        "provider_status": "amount_unparseable",
                        "provider_reference": provider_ref,
                        "error": str(j.get("amount"))[:80]}
        if echoed_ref is not None and str(echoed_ref) != str(stable_reference):
            return {"outcome": TRANSFER_MANUAL,
                    "provider_status": "logical_reference_mismatch",
                    "provider_reference": provider_ref,
                    "error": f"clientRef echo {echoed_ref!r} != "
                             f"{stable_reference!r}"}
        # v5 (FIX 6): bare `{"success": true}` is accepted as paid (matches
        # the existing production GAS contract proven by payment_bridge.py /
        # voice_treasure_points_adapter.py). Stable reference is preserved
        # for audit even when the provider does not echo it.
        return {"outcome": TRANSFER_PAID, "provider_status": "success",
                "provider_reference": provider_ref
                or (f"clientRef:{stable_reference}" if echoed_ref else stable_reference),
                "error": ""}
    if isinstance(j, dict) and j.get("success") is False:
        # Explicit provider response proving NO transfer occurred.
        return {"outcome": TRANSFER_FAILED_RETRY,
                "provider_status": "provider_declined",
                "provider_reference": None,
                "error": str(j.get("message") or j.get("error") or j)[:200]}
    # Neither explicit success nor explicit decline — ambiguous.
    return {"outcome": TRANSFER_MANUAL,
            "provider_status": "ambiguous_response",
            "provider_reference": None,
            "error": str(j)[:200]}


# ---------------------------------------------------------------------------
# Route registration
# ---------------------------------------------------------------------------

def register_lucky_draw_routes(
    api: APIRouter,
    db,
    sl_publish: Callable[[str, dict], Awaitable[None]],
    gas_url: str,
    treasury_id: str,
    treasury_password: str,
    *,
    log: Optional[logging.Logger] = None,
    mock_gas: Optional[bool] = None,
    require_admin: Optional[Callable] = None,
    push_notify: Optional[Callable[[str, int, str], Awaitable[None]]] = None,
) -> None:
    """Mount the four /api/speaking-lab/sessions/{id}/... endpoints onto the
    existing `api` router. Safe to call once at server.py startup."""

    log = log or logging.getLogger("lucky_draw")
    if mock_gas is None:
        mock_gas = os.environ.get("LUCKY_DRAW_MOCK_GAS", "").lower() in ("1", "true", "yes")

    # ── FIX 2: payout-configuration startup warning (non-blocking) ────────
    _cfg = _payout_config_state(gas_url, treasury_password, bool(mock_gas))
    if _cfg == "mock":
        log.warning("lucky_draw: PAYOUT MOCK MODE enabled — no real points "
                    "will be sent and no reward-success pushes will fire.")
    elif _cfg == "provider_not_configured":
        log.warning("lucky_draw: PAYOUT PROVIDER NOT CONFIGURED "
                    "(missing GAS URL or treasury password). Lucky-draw "
                    "payouts will fail closed; winners will NOT be marked "
                    "paid and no reward pushes will be sent. Unrelated "
                    "backend operation is unaffected.")

    # If the caller passed require_admin (e.g. eduhub's FastAPI dependency),
    # use it; otherwise admit any caller (dev mode).
    admin_dep = Depends(require_admin) if require_admin else None

    def _admin(_admin=admin_dep):
        # No-op shim so the function signature stays consistent.
        return _admin

    SL_SESSIONS = db.speaking_lab_sessions
    SL_LUCKY    = db.speaking_lab_lucky_codes

    # ---- POST /pool-entry  (open — usually invoked internally) -----------
    @api.post("/speaking-lab/sessions/{session_id}/pool-entry")
    async def lucky_pool_entry(
        body: PoolEntryBody,
        session_id: str = Path(..., min_length=1, max_length=128),
    ):
        sess = await SL_SESSIONS.find_one({"session_id": session_id}, {"_id": 0})
        if not sess:
            raise HTTPException(status_code=404, detail="Session not found")
        display_name = (body.display_name or body.student_id).strip()
        amount = int(body.entry_fee or sess.get("entry_fee") or 0)

        doc = await generate_and_publish_lucky_code(
            db, sl_publish, session_id, body.student_id,
            display_name, amount=amount, log=log,
        )
        if not doc:
            raise HTTPException(status_code=500, detail="failed to assign lucky code")
        state = await _pool_state(db, session_id)
        return {
            "ok":           True,
            "session_id":   session_id,
            "student_id":   body.student_id,
            "display_name": doc.get("display_name", display_name),
            "code":         doc.get("code"),
            "entry_fee":    int(doc.get("entry_fee") or 0),
            "pool_total":   state["pool_total"],
            "player_count": state["player_count"],
        }

    # ---- GET /pool  (admin) ---------------------------------------------
    if require_admin:
        @api.get("/speaking-lab/sessions/{session_id}/pool")
        async def lucky_pool_get(session_id: str, admin=Depends(require_admin)):
            return await _pool_payload(
                SL_SESSIONS, SL_LUCKY, session_id,
                db=db, sl_publish=sl_publish, log=log,
            )
        @api.get("/speaking-lab/sessions/{session_id}/lucky-codes")
        async def lucky_codes_get(session_id: str, admin=Depends(require_admin)):
            return await _codes_payload(SL_SESSIONS, SL_LUCKY, session_id)
        @api.post("/speaking-lab/sessions/{session_id}/lucky-draw")
        async def lucky_draw_post(
            session_id: str,
            config: LuckyDrawConfig,
            admin=Depends(require_admin),
        ):
            return await _run_draw(
                db, sl_publish, session_id, config, gas_url, treasury_id,
                treasury_password, mock_gas, log,
                granted_by=getattr(admin, "email", "admin"),
                push_notify=push_notify,
            )
        # Phase 4 (treasury-safety + UI suspense): the original
        # POST /lucky-draw is now PREPARE-only — it locks the draw and
        # picks winners but does NOT transfer GAS or send winner pushes.
        # The cinematic on the teacher's screen plays, and only after the
        # final reveal does the client POST /lucky-draw/finalize, which
        # is idempotent: a separate atomic flag (`finalized=True` on the
        # `speaking_lab_lucky_draws` doc) guarantees the GAS transfers
        # and winner pushes happen exactly once.
        @api.post("/speaking-lab/sessions/{session_id}/lucky-draw/finalize")
        async def lucky_draw_finalize_post(
            session_id: str,
            admin=Depends(require_admin),
        ):
            return await _finalize_draw(
                db, sl_publish, session_id, gas_url, treasury_id,
                treasury_password, mock_gas, log,
                push_notify=push_notify,
            )

        # ── FIX 9: safe retry of failed payouts (admin-only) ─────────────
        @api.post("/speaking-lab/sessions/{session_id}/lucky-draw/retry-failed")
        async def lucky_draw_retry_failed(
            session_id: str,
            body: RetryFailedBody = RetryFailedBody(),
            admin=Depends(require_admin),
        ):
            return await _retry_failed_payouts(
                db, sl_publish, session_id, gas_url, treasury_id,
                treasury_password, mock_gas, log,
                push_notify=push_notify,
                confirm_not_paid=bool(body.confirm_not_paid),
                reason=body.reason or "",
                student_id=(body.student_id or "").strip() or None,
                granted_by=getattr(admin, "email", "admin"),
            )

        # ── FIX 11: explicit historical reconciliation (admin-only) ──────
        @api.post("/speaking-lab/sessions/{session_id}/lucky-draw/reconcile-historical")
        async def lucky_draw_reconcile_historical(
            session_id: str,
            body: HistoricalReconcileBody = HistoricalReconcileBody(),
            admin=Depends(require_admin),
        ):
            return await _reconcile_historical_draw(
                db, sl_publish, session_id, gas_url, treasury_id,
                treasury_password, mock_gas, log,
                push_notify=push_notify,
                confirm_historical_recovery=bool(body.confirm_historical_recovery),
                reason=body.reason or "",
                granted_by=getattr(admin, "email", "admin"),
            )

        # ── FIX 12: notification-only retry (admin-only, never calls GAS) ─
        @api.post("/speaking-lab/sessions/{session_id}/lucky-draw/retry-push")
        async def lucky_draw_retry_push(
            session_id: str,
            admin=Depends(require_admin),
        ):
            return await _retry_push_only(
                db, session_id, log, push_notify=push_notify)
    else:
        # Dev mode — admit any caller
        @api.get("/speaking-lab/sessions/{session_id}/pool")
        async def lucky_pool_get_dev(session_id: str):
            return await _pool_payload(
                SL_SESSIONS, SL_LUCKY, session_id,
                db=db, sl_publish=sl_publish, log=log,
            )
        @api.get("/speaking-lab/sessions/{session_id}/lucky-codes")
        async def lucky_codes_get_dev(session_id: str):
            return await _codes_payload(SL_SESSIONS, SL_LUCKY, session_id)
        @api.post("/speaking-lab/sessions/{session_id}/lucky-draw")
        async def lucky_draw_post_dev(session_id: str, config: LuckyDrawConfig):
            return await _run_draw(
                db, sl_publish, session_id, config, gas_url, treasury_id,
                treasury_password, mock_gas, log,
                granted_by="dev",
                push_notify=push_notify,
            )
        # Same finalize route in dev mode (no admin gate).
        @api.post("/speaking-lab/sessions/{session_id}/lucky-draw/finalize")
        async def lucky_draw_finalize_post_dev(session_id: str):
            return await _finalize_draw(
                db, sl_publish, session_id, gas_url, treasury_id,
                treasury_password, mock_gas, log,
                push_notify=push_notify,
            )


async def _pool_payload(
    SL_SESSIONS, SL_LUCKY, session_id: str,
    *, db=None, sl_publish=None, log: Optional[logging.Logger] = None,
) -> dict:
    sess = await SL_SESSIONS.find_one({"session_id": session_id}, {"_id": 0})
    if not sess:
        raise HTTPException(status_code=404, detail="Session not found")

    # ── Safety-net repair: regenerate lucky codes for paid roster entries
    # that are missing one. This fixes the bug where a student paid the
    # entry fee (and therefore appears in `speaking_lab_entries`) but their
    # `speaking_lab_lucky_codes` doc was never created — usually because
    # the original `_sl_try_auto_enter` call hit a transient error or the
    # process was killed mid-flight. We repair every fetch so the pool UI
    # self-heals without operator action. Never raises into the caller.
    if db is not None and sl_publish is not None and not sess.get("lucky_draw_done"):
        try:
            entry_ids: list[str] = []
            entry_names: dict[str, str] = {}
            async for r in db.speaking_lab_entries.find(
                {"session_id": session_id},
                {"_id": 0, "student_id": 1, "display_name": 1},
            ):
                sid = (r.get("student_id") or "").strip()
                if sid and not sid.startswith("sl-"):
                    entry_ids.append(sid)
                    dn = r.get("display_name")
                    if dn:
                        entry_names[sid] = dn
            if entry_ids:
                have_codes: set[str] = set()
                async for r in SL_LUCKY.find(
                    {"session_id": session_id,
                     "student_id": {"$in": entry_ids}},
                    {"_id": 0, "student_id": 1},
                ):
                    sid = (r.get("student_id") or "").strip()
                    if sid:
                        have_codes.add(sid)
                missing = [s for s in entry_ids if s not in have_codes]
                if missing:
                    fee = int(sess.get("entry_fee") or 0)
                    for sid in missing:
                        try:
                            await generate_and_publish_lucky_code(
                                db, sl_publish, session_id, sid,
                                entry_names.get(sid, sid),
                                amount=fee, log=log,
                            )
                        except Exception as exc:  # noqa: BLE001
                            if log:
                                log.warning(
                                    "lucky_draw: pool repair failed for %s/%s: %s",
                                    session_id, sid, str(exc)[:200],
                                )
                    if log:
                        log.info(
                            "lucky_draw: pool repair generated %d code(s) "
                            "for session %s", len(missing), session_id,
                        )
        except Exception as exc:  # noqa: BLE001
            if log:
                log.warning(
                    "lucky_draw: pool repair scan error: %s",
                    str(exc)[:200],
                )

    codes_cursor = SL_LUCKY.find(
        {"session_id": session_id}, {"_id": 0},
    ).sort("awarded_at", 1)
    codes: list[dict] = []
    total = 0
    async for row in codes_cursor:
        codes.append({
            "student_id":   row.get("student_id"),
            "display_name": row.get("display_name"),
            "code":         row.get("code"),
            "entry_fee":    int(row.get("entry_fee") or 0),
            "awarded_at":   row.get("awarded_at"),
        })
        total += int(row.get("entry_fee") or 0)
    return {
        "session_id":     session_id,
        "pool_total":     total,
        "player_count":   len(codes),
        "entry_fee":      int(sess.get("entry_fee") or 0),
        "lucky_codes":    [{"code": c["code"], "display_name": c["display_name"]}
                            for c in codes],
        "drawn":          bool(sess.get("lucky_draw_done")),
    }


async def _codes_payload(SL_SESSIONS, SL_LUCKY, session_id: str) -> dict:
    sess = await SL_SESSIONS.find_one({"session_id": session_id}, {"_id": 0})
    if not sess:
        raise HTTPException(status_code=404, detail="Session not found")
    cursor = SL_LUCKY.find({"session_id": session_id}, {"_id": 0}).sort("awarded_at", 1)
    rows: list[dict] = []
    async for r in cursor:
        rows.append({
            "student_id":   r.get("student_id"),
            "display_name": r.get("display_name"),
            "code":         r.get("code"),
            "awarded_at":   r.get("awarded_at"),
        })
    return {"session_id": session_id, "codes": rows}


async def _run_draw(
    db, sl_publish, session_id: str, config: LuckyDrawConfig,
    gas_url: str, treasury_id: str, treasury_password: str,
    mock_gas: bool, log: logging.Logger, *, granted_by: str,
    push_notify: Optional[Callable[[str, int, str], Awaitable[None]]] = None,
) -> dict:
    SL_SESSIONS = db.speaking_lab_sessions
    SL_LUCKY    = db.speaking_lab_lucky_codes
    SL_DRAWS    = db.speaking_lab_lucky_draws
    SL_SETTINGS = db.speaking_lab_settings

    sess = await SL_SESSIONS.find_one({"session_id": session_id}, {"_id": 0})
    if not sess:
        raise HTTPException(status_code=404, detail="Session not found")

    # ── TREASURY-SAFETY CLAIM ───────────────────────────────────────────
    # Atomically flip `lucky_draw_done` to True at the very start, BEFORE
    # building candidates or sending any GAS payout. Only one concurrent
    # request can win this update; all others see matched_count == 0 and
    # get a clean 409. This is the single guard that prevents the
    # treasury double-payout bug (stu092 paying repeated winnings).
    #
    # Conditions:
    #   • lucky_draw_done is not True
    #   • optional belt-and-braces: no draw is currently in-flight by
    #     another worker (we don't have a separate flag; the not-equal-
    #     True check above is sufficient because we set it to True here).
    claim_started_at = datetime.now(timezone.utc).isoformat()
    claim = await SL_SESSIONS.update_one(
        {"session_id": session_id, "lucky_draw_done": {"$ne": True}},
        {"$set": {
            "lucky_draw_done":        True,
            "lucky_draw_started_at":  claim_started_at,
            "lucky_draw_granted_by":  granted_by,
        }},
    )
    if claim.matched_count == 0:
        # Either already drawn, or another request claimed it first.
        # Idempotent 409 — same response shape as before.
        raise HTTPException(status_code=409,
                            detail="Lucky draw already run for this session")

    # If we ever reach a GAS transfer, we must NEVER release the claim,
    # even on unexpected errors. Tracks the half-way point.
    payout_started = False

    async def _release_claim(reason: str) -> None:
        """Safely release the claim — ONLY callable before any GAS
        transfer started. We use a guarded update so we never undo a
        completed draw."""
        try:
            await SL_SESSIONS.update_one(
                {"session_id": session_id,
                 "lucky_draw_started_at": claim_started_at,
                 "lucky_draw_at": {"$exists": False}},
                {"$set":   {"lucky_draw_done": False},
                 "$unset": {"lucky_draw_started_at": "",
                            "lucky_draw_granted_by": ""}},
            )
            if log:
                log.info("lucky_draw: claim released for %s (%s)",
                         session_id, reason)
        except Exception as exc:  # noqa: BLE001
            if log:
                log.warning("lucky_draw: claim release error %s/%s: %s",
                            session_id, reason, str(exc)[:200])

    try:
        # Build candidate list (now claim is locked).
        candidates: list[dict] = []
        async for r in SL_LUCKY.find({"session_id": session_id}, {"_id": 0}):
            candidates.append({
                "student_id":   r.get("student_id"),
                "display_name": r.get("display_name"),
                "code":         r.get("code"),
                "entry_fee":    int(r.get("entry_fee") or 0),
            })
        if not candidates:
            # Safe to release: no GAS transfer started yet.
            await _release_claim("empty_pool")
            raise HTTPException(status_code=400,
                                detail="No lucky codes — pool is empty")

        pool_total = sum(c["entry_fee"] for c in candidates)
        if pool_total <= 0:
            await _release_claim("zero_pool_total")
            raise HTTPException(status_code=400, detail="Pool total is zero")

        # Resolve settings (config override > session > settings doc > defaults)
        settings_doc = await SL_SETTINGS.find_one({"_id": "settings"}, {"_id": 0}) or {}
        num_winners = (
            config.num_winners
            or int(settings_doc.get("luckyDrawWinners") or 0)
            or DEFAULT_NUM_WINNERS
        )
        num_winners = max(1, min(3, int(num_winners)))
        split = (
            config.split
            or settings_doc.get("luckyDrawSplit")
            or DEFAULT_SPLIT
        )
        # Clamp candidates if fewer than winners
        num_winners = min(num_winners, len(candidates))

        # Slot-picked set (passed in by client OR stored on session)
        slot_picked: set[str] = set()
        if config.slot_picks:
            slot_picked = set(config.slot_picks)
        elif isinstance(sess.get("slot_picks"), list):
            slot_picked = set(sess["slot_picks"])

        winners = _weighted_pick(candidates, slot_picked, num_winners)
        amounts = _normalize_split(list(split), num_winners, pool_total)

        # ── PREPARE-ONLY phase. Do NOT touch GAS, do NOT push, do NOT
        # emit `draw_winner` / `draw_complete` SSE events yet. Those
        # side-effects are deferred to `_finalize_draw`, which the
        # frontend invokes ONLY after the full cinematic reveal has
        # finished on the teacher's screen. This prevents the
        # early-push bug (winners' phones used to buzz before the
        # teacher had stopped the last ticket block).
        #
        # Treasury safety is unchanged: the atomic `lucky_draw_done`
        # claim above guarantees this prepare block runs at most once
        # per session, so the winner list + amounts are locked in
        # before the cinematic begins.
        payout_started = False  # GAS not invoked here at all.
        use_mock = bool(config.mock) or mock_gas
        results: list[dict] = []
        for w, amt in zip(winners, amounts):
            results.append({
                "student_id":      w["student_id"],
                "display_name":    w["display_name"],
                "code":            w["code"],
                "amount":          amt,
                # `transfer_ok` left None — finalize will fill it in.
                "transfer_ok":     None,
                "transfer_err":    "",
                "was_slot_picked": w["student_id"] in slot_picked,
            })

        # Persist the audit row in a NOT-yet-finalized state. The
        # `finalized` flag is the second-stage idempotency guard: only
        # one `_finalize_draw` call can flip it to True, so GAS
        # transfers + winner pushes also happen exactly once.
        now_iso = datetime.now(timezone.utc).isoformat()
        draw_id = f"draw-{uuid.uuid4().hex[:12]}"
        await SL_DRAWS.insert_one({
            "draw_id":      draw_id,
            "session_id":   session_id,
            "pool_total":   pool_total,
            "num_winners":  num_winners,
            "split":        list(split),
            "results":      list(results),
            "slot_picks":   list(slot_picked),
            "granted_by":   granted_by,
            "mock":         use_mock,
            "drawn_at":     now_iso,
            "finalized":    False,    # set True atomically in finalize
            "prepared_at":  now_iso,
        })
        # Stamp the latest prepared `draw_id` on the session so finalize
        # can find it without an extra query parameter from the client.
        await SL_SESSIONS.update_one(
            {"session_id": session_id},
            {"$set": {"lucky_draw_prepared_draw_id": draw_id}},
        )

        return {
            "ok":          True,
            "session_id":  session_id,
            "draw_id":     draw_id,
            "pool_total":  pool_total,
            "num_winners": num_winners,
            "split":       list(split),
            "winners":     results,
            "mock":        use_mock,
            "drawn_at":    now_iso,
            # New field — tells the frontend that a separate finalize
            # call is required after the cinematic reveal.
            "finalized":   False,
            "requires_finalize": True,
        }
    except HTTPException:
        # Already handled — claim released above if applicable. Re-raise.
        raise
    except Exception as exc:  # noqa: BLE001
        # Unexpected failure. If we never started a GAS transfer we can
        # safely release the claim so the teacher can retry. Once any
        # GAS call has been issued (`payout_started=True`) we MUST keep
        # the claim — a partial draw must never be re-paid.
        if not payout_started:
            await _release_claim(f"pre_payout_exception:{type(exc).__name__}")
        if log:
            log.exception("lucky_draw: unhandled error in _run_draw: %s",
                          str(exc)[:200])
        raise


# ---------------------------------------------------------------------------
# v3 per-winner atomic claim + processing (FIX 5, 6, 7, 8, 12)
# ---------------------------------------------------------------------------

async def _claim_winner_initial(SL_DRAWS, draw_id: str, student_id: str,
                                stable_ref: str, attempt_id: str,
                                now_iso: str) -> bool:
    """Atomically claim a winner for the FIRST payout attempt.

    Allowed source state: pending. Flips it to in_progress and stamps the
    attempt id + stable reference. Returns True iff THIS caller won the claim
    (i.e. the matching `results[]` element was modified from pending). The
    conditional array-filter guarantees only one concurrent request / task /
    worker / instance can claim a given winner — an in-memory lock is NOT used.
    """
    res = await SL_DRAWS.update_one(
        {"draw_id": draw_id},
        {"$set": {
            "results.$[w].transfer_state":        TRANSFER_IN_PROGRESS,
            "results.$[w].transfer_attempt_id":   attempt_id,
            "results.$[w].transfer_started_at":   now_iso,
            "results.$[w].transfer_reference":    stable_ref,
        }},
        array_filters=[{"w.student_id": student_id,
                        "w.transfer_state": TRANSFER_PENDING}],
    )
    return getattr(res, "modified_count", 0) == 1


async def _claim_winner_retry(SL_DRAWS, draw_id: str, student_id: str,
                              stable_ref: str, attempt_id: str,
                              now_iso: str) -> bool:
    """Atomically claim a winner for a SAFE RETRY.

    Allowed source state: failed_safe_to_retry. Increments the retry counter
    and assigns a NEW attempt id (but reuses the stable logical reference —
    a retry never creates a new reward identity)."""
    res = await SL_DRAWS.update_one(
        {"draw_id": draw_id},
        {"$set": {
            "results.$[w].transfer_state":      TRANSFER_IN_PROGRESS,
            "results.$[w].transfer_attempt_id": attempt_id,
            "results.$[w].transfer_started_at": now_iso,
            "results.$[w].transfer_reference":  stable_ref,
        },
         "$inc": {"results.$[w].transfer_retry_count": 1}},
        array_filters=[{"w.student_id": student_id,
                        "w.transfer_state": TRANSFER_FAILED_RETRY}],
    )
    return getattr(res, "modified_count", 0) == 1


async def _claim_winner_manual_release(SL_DRAWS, draw_id: str, student_id: str,
                                       stable_ref: str, attempt_id: str,
                                       now_iso: str) -> bool:
    """Operator-confirmed release of a manual_review winner (FIX 9 override).
    Allowed source state: manual_review."""
    res = await SL_DRAWS.update_one(
        {"draw_id": draw_id},
        {"$set": {
            "results.$[w].transfer_state":      TRANSFER_IN_PROGRESS,
            "results.$[w].transfer_attempt_id": attempt_id,
            "results.$[w].transfer_started_at": now_iso,
            "results.$[w].transfer_reference":  stable_ref,
        },
         "$inc": {"results.$[w].transfer_retry_count": 1}},
        array_filters=[{"w.student_id": student_id,
                        "w.transfer_state": TRANSFER_MANUAL}],
    )
    return getattr(res, "modified_count", 0) == 1


async def _set_winner_fields(SL_DRAWS, draw_id: str, student_id: str,
                             fields: dict,
                             *,
                             expected_attempt_id: Optional[str] = None,
                             expected_push_attempt_id: Optional[str] = None,
                             require_in_progress: bool = False) -> int:
    """Persist a set of fields onto ONE winner's results[] element.

    v5 (FIX 5) — attempt-ID guarded terminal writes:
      • `expected_attempt_id` — when provided, the update is filtered on
        `w.transfer_attempt_id == expected_attempt_id`, so a delayed older
        worker cannot overwrite the terminal result of a newer attempt.
      • `require_in_progress` — when True, the update additionally requires
        `w.transfer_state == TRANSFER_IN_PROGRESS`. This is the canonical
        guard for terminal TRANSFER state writes (paid / failed_safe_to_retry
        / manual_review / mock).
      • `expected_push_attempt_id` — same protection for push notification
        terminal writes (filters on `w.push_notification_attempt_id`).

    Returns the Mongo `modified_count`. A return of 0 means the guard
    rejected the write (the row already advanced past this attempt) — the
    caller MUST treat that as "another worker won" and not retry blindly.
    """
    payload = {f"results.$[w].{k}": v for k, v in fields.items()}
    array_filter: dict = {"w.student_id": student_id}
    if expected_attempt_id is not None:
        array_filter["w.transfer_attempt_id"] = expected_attempt_id
    if require_in_progress:
        array_filter["w.transfer_state"] = TRANSFER_IN_PROGRESS
    if expected_push_attempt_id is not None:
        array_filter["w.push_notification_attempt_id"] = expected_push_attempt_id
    res = await SL_DRAWS.update_one(
        {"draw_id": draw_id},
        {"$set": payload},
        array_filters=[array_filter],
    )
    return getattr(res, "modified_count", 0)


async def _send_winner_push_idempotent(
    SL_DRAWS, draw_id: str, student_id: str, amount: int, code: str,
    stable_ref: str, push_notify, log,
) -> None:
    """Send the reward-success push truthfully and EXACTLY ONCE (FIX 4 v4).

    Ordering: the reward is already PAID + durable before this runs. We then:
      1. atomically claim the push slot (pending/failed/no_subscribers/stale
         sending → sending). Only the winning worker calls the callback.
      2. call the existing push callback and inspect its REAL structured result.
      3. persist sent / no_subscribers / failed accordingly.

    A success push is recorded ONLY when at least one delivery actually
    succeeded. Zero active subscribers → no_subscribers (NOT sent). A failure
    or exception → failed; the reward stays paid. Cancellation before the
    callback completes leaves the state at `sending` (never sent) so a
    notification-only retry can recover it. Never calls GAS.
    """
    if push_notify is None:
        return
    attempt_id = uuid.uuid4().hex
    now = datetime.now(timezone.utc)
    now_iso = now.isoformat()
    stale_cut = (now - timedelta(seconds=PUSH_STALE_SECONDS)).isoformat()
    # Atomic claim: only when paid, not already sent, and the push slot is in a
    # claimable state (pending / failed / no_subscribers / missing / a stale
    # `sending`). Two concurrent retries → exactly one wins this update.
    res = await SL_DRAWS.update_one(
        {"draw_id": draw_id},
        {"$set": {"results.$[w].push_notification_state": PUSH_SENDING,
                  "results.$[w].push_notification_attempt_id": attempt_id,
                  "results.$[w].push_notification_started_at": now_iso}},
        array_filters=[{
            "w.student_id": student_id,
            "w.transfer_state": TRANSFER_PAID,
            "w.push_notification_state": {
                "$in": [None, PUSH_PENDING, PUSH_FAILED, PUSH_NO_SUBSCRIBERS]},
        }],
    )
    if getattr(res, "modified_count", 0) != 1:
        # Not paid, already sent, currently sending (claimed elsewhere), or a
        # non-stale sending — try the stale-sending recovery path instead.
        res2 = await SL_DRAWS.update_one(
            {"draw_id": draw_id},
            {"$set": {"results.$[w].push_notification_state": PUSH_SENDING,
                      "results.$[w].push_notification_attempt_id": attempt_id,
                      "results.$[w].push_notification_started_at": now_iso}},
            array_filters=[{
                "w.student_id": student_id,
                "w.transfer_state": TRANSFER_PAID,
                "w.push_notification_state": PUSH_SENDING,
                "w.push_notification_started_at": {"$lt": stale_cut},
            }],
        )
        if getattr(res2, "modified_count", 0) != 1:
            return  # cannot claim — do not duplicate
    try:
        result = await push_notify(student_id, amount, code)
    except asyncio.CancelledError:
        # Leave state at `sending`; never mark sent on cancellation.
        raise
    except Exception as exc:  # noqa: BLE001 — callback should not raise, but be safe
        # v5 (FIX 5): guard terminal push write on our push_notification_attempt_id.
        await _set_winner_fields(SL_DRAWS, draw_id, student_id, {
            "push_notification_state": PUSH_FAILED,
            "push_notification_error": str(exc)[:200]},
            expected_push_attempt_id=attempt_id)
        if log:
            log.warning("lucky_draw: reward push raised (reward stays paid) "
                        "ref=%s err=%s", stable_ref, str(exc)[:200])
        return
    # Interpret the structured callback result (FIX 4 contract).
    if not isinstance(result, dict):
        result = {"attempted": True, "sent": 0, "failed": 0,
                  "no_subscribers": False,
                  "error": "non-structured callback result"}
    sent = int(result.get("sent") or 0)
    failed = int(result.get("failed") or 0)
    no_subs = bool(result.get("no_subscribers"))
    err = str(result.get("error") or "")
    if sent >= 1:
        # v5 (FIX 5): guard terminal push write on our attempt id.
        await _set_winner_fields(SL_DRAWS, draw_id, student_id, {
            "push_notification_state": PUSH_SENT,
            "push_notified_at": datetime.now(timezone.utc).isoformat(),
            "push_sent_count": sent, "push_failed_count": failed,
            "push_notification_error": ""},
            expected_push_attempt_id=attempt_id)
        if log:
            log.info("lucky_draw: reward push sent (n=%d) ref=%s", sent,
                     stable_ref)
    elif no_subs:
        await _set_winner_fields(SL_DRAWS, draw_id, student_id, {
            "push_notification_state": PUSH_NO_SUBSCRIBERS,
            "push_sent_count": 0, "push_failed_count": failed,
            "push_notification_error": ""},
            expected_push_attempt_id=attempt_id)
        if log:
            log.info("lucky_draw: reward push had no subscribers ref=%s",
                     stable_ref)
    else:
        await _set_winner_fields(SL_DRAWS, draw_id, student_id, {
            "push_notification_state": PUSH_FAILED,
            "push_sent_count": sent, "push_failed_count": failed,
            "push_notification_error": err or "delivery failed"},
            expected_push_attempt_id=attempt_id)
        if log:
            log.warning("lucky_draw: reward push FAILED (reward stays paid) "
                        "ref=%s err=%s", stable_ref, err)


async def _process_winner(
    db, SL_DRAWS, sl_publish, session_id: str, draw_id: str, rank: int,
    rec: dict, gas_url: str, treasury_id: str, treasury_password: str,
    use_mock: bool, log, push_notify, *, mode: str,
) -> dict:
    """Process ONE winner through the atomic state machine.

    `mode` ∈ {"initial", "retry", "manual_release"} selects the allowed
    source state for the atomic claim. Returns the winner's updated record.

    Never calls the provider for a winner already paid / in_progress /
    manual_review / mock. The boundary in FIX 7 (provider success then Mongo
    persist failure) is handled explicitly: the winner is left in
    manual_review and is NEVER released into automatic retry.
    """
    student_id   = rec.get("student_id")
    display_name = rec.get("display_name")
    code         = rec.get("code") or ""
    amount       = int(rec.get("amount") or 0)
    stable_ref   = _stable_reference(draw_id, session_id, student_id)
    attempt_id   = uuid.uuid4().hex
    now_iso      = datetime.now(timezone.utc).isoformat()

    # ── 1. Atomic per-winner claim ────────────────────────────────────────
    if mode == "initial":
        claimed = await _claim_winner_initial(
            SL_DRAWS, draw_id, student_id, stable_ref, attempt_id, now_iso)
    elif mode == "retry":
        claimed = await _claim_winner_retry(
            SL_DRAWS, draw_id, student_id, stable_ref, attempt_id, now_iso)
    elif mode == "manual_release":
        claimed = await _claim_winner_manual_release(
            SL_DRAWS, draw_id, student_id, stable_ref, attempt_id, now_iso)
    else:
        claimed = False

    if not claimed:
        # Could not claim — winner is paid / in_progress / manual_review /
        # mock / pending-not-eligible-for-this-mode. Return current snapshot;
        # NEVER call the provider.
        fresh = await SL_DRAWS.find_one({"draw_id": draw_id}, {"_id": 0})
        for w in (fresh or {}).get("results", []):
            if w.get("student_id") == student_id:
                return dict(w)
        return dict(rec)

    # ── 2. We own the claim — call the provider ───────────────────────────
    outcome = await _provider_transfer(
        gas_url, treasury_id, treasury_password, student_id, amount,
        use_mock=use_mock, stable_reference=stable_ref, attempt_id=attempt_id,
        log=log,
    )
    completed_at = datetime.now(timezone.utc).isoformat()
    result_state = outcome["outcome"]

    if result_state == TRANSFER_PAID:
        # ── FIX 7: provider confirmed — persist paid durably. If the Mongo
        # write itself fails, the winner must NOT be reset to retryable and
        # MUST NOT be auto-resent. Quarantine as manual_review.
        # v5 (FIX 5): filter on (transfer_attempt_id == our attempt_id) AND
        # transfer_state == in_progress so a delayed older worker cannot
        # overwrite a newer attempt's terminal state.
        try:
            persisted = await _set_winner_fields(SL_DRAWS, draw_id, student_id, {
                "transfer_state":           TRANSFER_PAID,
                "transfer_ok":              True,
                "transfer_err":             "",
                "transfer_completed_at":    completed_at,
                "transfer_provider_status": outcome["provider_status"],
                "transfer_provider_reference": outcome["provider_reference"],
                "transfer_last_error":      "",
                "manual_review_reason":     "",
            }, expected_attempt_id=attempt_id, require_in_progress=True)
            if persisted != 1:
                raise RuntimeError(
                    "paid-state update modified 0 documents — newer attempt "
                    "may have superseded this one")
        except Exception as exc:  # noqa: BLE001
            if log:
                log.critical(
                    "lucky_draw: CRITICAL reconciliation — provider PAID but "
                    "Mongo persist failed (or attempt superseded) ref=%s "
                    "err=%s — quarantining as manual_review (no resend)",
                    stable_ref, str(exc)[:200])
            # Best-effort quarantine; still guarded on attempt id so we
            # never clobber a newer worker.
            try:
                await _set_winner_fields(SL_DRAWS, draw_id, student_id, {
                    "transfer_state":       TRANSFER_MANUAL,
                    "transfer_ok":          None,
                    "manual_review_reason": "provider_paid_but_persist_failed",
                    "transfer_provider_status": outcome["provider_status"],
                    "transfer_provider_reference": outcome["provider_reference"],
                }, expected_attempt_id=attempt_id, require_in_progress=True)
            except Exception:  # noqa: BLE001
                pass
        else:
            # Paid + durable → send the success push exactly once.
            await _send_winner_push_idempotent(
                SL_DRAWS, draw_id, student_id, amount, code, stable_ref,
                push_notify, log)
            # Shadow credit — non-fatal, fire-and-forget (parity with legacy).
            try:
                _ld_ikey = f"shadow:credit:{stable_ref}"
                from shadow_writer import shadow_credit as _sw_credit
                import asyncio as _asyncio
                _asyncio.create_task(_sw_credit(
                    student_clean_id=student_id, student_mongo_id="",
                    amount=amount, source="lucky_draw",
                    idempotency_key=_ld_ikey,
                ))
            except Exception as _sw_exc:  # noqa: BLE001
                if log:
                    log.warning("lucky_draw: shadow credit hook error "
                                "(non-fatal): %s", str(_sw_exc)[:200])

    elif result_state == TRANSFER_FAILED_RETRY:
        # v5 (FIX 5): guard terminal write on our attempt id + in_progress.
        await _set_winner_fields(SL_DRAWS, draw_id, student_id, {
            "transfer_state":           TRANSFER_FAILED_RETRY,
            "transfer_ok":              False,
            "transfer_err":             outcome["error"],
            "transfer_last_error":      outcome["error"],
            "transfer_provider_status": outcome["provider_status"],
            "transfer_completed_at":    completed_at,
        }, expected_attempt_id=attempt_id, require_in_progress=True)

    elif result_state == TRANSFER_MOCK:
        # v5 (FIX 5): guard terminal write on our attempt id + in_progress.
        await _set_winner_fields(SL_DRAWS, draw_id, student_id, {
            "transfer_state":           TRANSFER_MOCK,
            "transfer_ok":              None,
            "transfer_err":             "",
            "transfer_provider_status": "mock",
            "transfer_completed_at":    completed_at,
        }, expected_attempt_id=attempt_id, require_in_progress=True)

    else:  # manual_review
        # v5 (FIX 5): guard terminal write on our attempt id + in_progress.
        await _set_winner_fields(SL_DRAWS, draw_id, student_id, {
            "transfer_state":           TRANSFER_MANUAL,
            "transfer_ok":              None,
            "transfer_last_error":      outcome["error"],
            "manual_review_reason":     outcome["provider_status"],
            "transfer_provider_status": outcome["provider_status"],
            "transfer_completed_at":    completed_at,
        }, expected_attempt_id=attempt_id, require_in_progress=True)

    # Read back the persisted winner record.
    fresh = await SL_DRAWS.find_one({"draw_id": draw_id}, {"_id": 0})
    merged = dict(rec)
    for w in (fresh or {}).get("results", []):
        if w.get("student_id") == student_id:
            merged = dict(w)
            break

    # SSE audit event (post-reveal). Best-effort.
    try:
        await sl_publish(session_id, {"type": "draw_winner", **merged})
    except Exception as exc:  # noqa: BLE001
        if log:
            log.warning("lucky_draw: sl_publish error: %s", str(exc)[:200])
    return merged


STALE_IN_PROGRESS_SECONDS = 120  # an in_progress older than this is uncertain

# v5.2 (FIX 1) — payout-initialization ownership coordination
# ---------------------------------------------------------------------------
# Only the request that owns the fresh `finalized:false → true` claim may
# seed missing per-winner states as `pending`. A non-owner request entering
# `_finalize_draw` during active initialization MUST NOT classify
# uninitialized winners (transfer_ok=null, transfer_state missing) as legacy
# `manual_review`; it must briefly reload/wait or return processing.
#
# These constants tune that handshake:
PAYOUT_INIT_ACTIVE   = "active"
PAYOUT_INIT_COMPLETE = "complete"
# Time after which an "active" initialization claim is treated as stale and
# may be safely re-entered. Per-winner atomic claims still guarantee no
# duplicate provider call, so this is bounded but not strictly necessary
# for correctness.
STALE_INITIALIZATION_SECONDS = 5 * 60
# Non-owner wait budget while initialization is active (small, deterministic).
INIT_WAIT_TOTAL_SECONDS = 2.5
INIT_WAIT_POLL_SECONDS  = 0.1


async def _quarantine_stale_in_progress(SL_DRAWS, draw_id: str) -> None:
    """FIX 6: a winner stuck in_progress (process crashed after the atomic
    claim but before the outcome was persisted) is an UNCERTAIN outcome — the
    provider may or may not have credited the student. Move it to
    manual_review; never auto-retry it."""
    now = datetime.now(timezone.utc)
    draw = await SL_DRAWS.find_one({"draw_id": draw_id}, {"_id": 0})
    for w in (draw or {}).get("results", []):
        if w.get("transfer_state") != TRANSFER_IN_PROGRESS:
            continue
        started = _parse_iso(w.get("transfer_started_at"))
        if started is None or (now - started).total_seconds() >= \
                STALE_IN_PROGRESS_SECONDS:
            await _set_winner_fields(SL_DRAWS, draw_id, w.get("student_id"), {
                "transfer_state":       TRANSFER_MANUAL,
                "transfer_ok":          None,
                "manual_review_reason":
                    "stale_in_progress_provider_outcome_unknown",
            })


async def _seed_results_states(SL_DRAWS, draw_id: str,
                               prepared_results: list[dict] = None,
                               *, fresh_finalize: bool = False) -> None:
    """Atomically + NON-DESTRUCTIVELY initialize per-winner state (FIX 1 v4).

    A winner is initialized ONLY when ALL of these are true (enforced by the
    conditional arrayFilters, evaluated by MongoDB against the live document):
        transfer_state is missing
        AND transfer_attempt_id is missing

    It therefore can NEVER overwrite an active state (pending / in_progress /
    paid / failed_safe_to_retry / manual_review / mock), even if a concurrent
    worker has already claimed the winner. No full-array replacement from a
    (possibly stale) snapshot is performed: the mapped value is derived from the
    AUTHORITATIVE live element, not from the caller-supplied snapshot.

    If a provider attempt id is already present but no terminal state exists,
    the outcome is uncertain and the winner is initialized to manual_review.

    v5 (FIX 4): a brand-new (fresh) finalize seeds `pending` for winners with
    `transfer_ok=None` (the normal "process me once" state). A legacy
    finalized draw (called via recovery / historical reconciliation) seeds
    `manual_review` instead — `_legacy_state_for_record` defaults to
    `manual_review` for `transfer_ok=None` so background workers can never
    auto-resend points without explicit operator confirmation. The caller
    indicates the fresh case via `fresh_finalize=True`.
    """
    draw = await SL_DRAWS.find_one({"draw_id": draw_id}, {"_id": 0})
    for rec in (draw or {}).get("results", []):
        if rec.get("transfer_state"):
            continue  # already has a state — never touch
        student_id = rec.get("student_id")
        if rec.get("transfer_attempt_id"):
            # A provider attempt is known but no terminal state → uncertain.
            mapped = TRANSFER_MANUAL
            await SL_DRAWS.update_one(
                {"draw_id": draw_id},
                {"$set": {
                    "results.$[w].transfer_state": mapped,
                    "results.$[w].manual_review_reason":
                        "attempt_without_terminal_state",
                    "results.$[w].push_notification_state":
                        rec.get("push_notification_state") or PUSH_PENDING}},
                array_filters=[{"w.student_id": student_id,
                                "w.transfer_state": {"$exists": False}}],
            )
            continue
        # v5 (FIX 4): fresh finalize seeds pending; legacy recovery defers
        # to `_legacy_state_for_record` (None → manual_review).
        if fresh_finalize and rec.get("transfer_ok") is None:
            mapped = TRANSFER_PENDING
        else:
            mapped = _legacy_state_for_record(rec)  # true→paid, false→manual, null→manual (v5)
        # Conditional: initialize ONLY when state AND attempt id are both absent.
        await SL_DRAWS.update_one(
            {"draw_id": draw_id},
            {"$set": {
                "results.$[w].transfer_state": mapped,
                "results.$[w].transfer_retry_count":
                    int(rec.get("transfer_retry_count") or 0),
                "results.$[w].push_notification_state":
                    rec.get("push_notification_state") or PUSH_PENDING}},
            array_filters=[{
                "w.student_id": student_id,
                "w.transfer_state": {"$exists": False},
                "w.transfer_attempt_id": {"$exists": False}}],
        )


def _finalize_response(session_id, draw_doc, results, use_mock) -> dict:
    """Build a TRUTHFUL finalize/retry response (FIX 13)."""
    status_ = _aggregate_payout_status(results, use_mock=use_mock)
    counts = _payout_counts(results)
    payout_complete = status_ in (PAYOUT_COMPLETED, PAYOUT_MOCK)
    return {
        "ok":            True,
        "session_id":    session_id,
        "draw_id":       draw_doc.get("draw_id"),
        "pool_total":    draw_doc.get("pool_total"),
        "num_winners":   draw_doc.get("num_winners"),
        "split":         draw_doc.get("split"),
        "winners":       results,
        "mock":          use_mock,
        "drawn_at":      draw_doc.get("drawn_at"),
        "finalized":     True,
        "payout_complete": payout_complete,
        "payout_status": status_,
        **counts,
    }


async def _finalize_draw(
    db, sl_publish, session_id: str,
    gas_url: str, treasury_id: str, treasury_password: str,
    mock_gas: bool, log: logging.Logger,
    *,
    push_notify: Optional[Callable[[str, int, str], Awaitable[None]]] = None,
) -> dict:
    """
    Commit the previously-prepared draw through the per-winner atomic
    state machine (FIX 8). Winner selection / amounts / ranks / codes are
    NEVER changed here — only payout processing and payout status.

    Safety model:
      • Atomic `lucky_draw_done` claim in `_run_draw` → exactly one prepare.
      • Atomic finalize flip (`finalized=False`→`True`) → exactly one entry
        into payout processing per prepared draw.
      • Per-winner atomic claims (pending→in_progress) → each winner is sent
        to the provider at most once; paid / in_progress / manual_review /
        mock winners are never (re)sent.
      • Fail-closed when payout configuration is invalid (FIX 2).
    """
    SL_SESSIONS = db.speaking_lab_sessions
    SL_DRAWS    = db.speaking_lab_lucky_draws

    sess = await SL_SESSIONS.find_one({"session_id": session_id}, {"_id": 0})
    if not sess:
        raise HTTPException(status_code=404, detail="Session not found")

    prepared_id = sess.get("lucky_draw_prepared_draw_id")
    draw_doc = None
    if prepared_id:
        draw_doc = await SL_DRAWS.find_one(
            {"draw_id": prepared_id, "session_id": session_id}, {"_id": 0})
    if not draw_doc:
        draw_doc = await SL_DRAWS.find_one(
            {"session_id": session_id, "finalized": {"$ne": True}},
            {"_id": 0}, sort=[("prepared_at", -1)])
    if not draw_doc:
        existing = await SL_DRAWS.find_one(
            {"session_id": session_id, "finalized": True},
            {"_id": 0}, sort=[("finalized_at", -1)])
        if existing:
            res = list(existing.get("results", []))
            return _finalize_response(session_id, existing, res,
                                      bool(existing.get("mock")))
        raise HTTPException(status_code=404,
                            detail="No prepared draw found for this session")

    draw_id = draw_doc["draw_id"]
    use_mock = bool(draw_doc.get("mock") or mock_gas)

    # ── FIX 2: fail closed on missing payout configuration ────────────────
    cfg = _payout_config_state(gas_url, treasury_password, use_mock)
    if cfg == "provider_not_configured":
        if log:
            log.warning("lucky_draw: finalize blocked — payout provider not "
                        "configured (session=%s draw=%s)", session_id, draw_id)
        # Do NOT auto-finalize or mark winners paid while config is invalid.
        await SL_DRAWS.update_one(
            {"draw_id": draw_id},
            {"$set": {"payout_status": PAYOUT_MANUAL_REVIEW,
                      "payout_updated_at":
                          datetime.now(timezone.utc).isoformat()}})
        raise HTTPException(
            status_code=503,
            detail={"error": "provider_not_configured",
                    "message": "Payout provider is not configured; refusing "
                               "to finalize. No winners were paid."})

    # ── ATOMIC FINALIZE CLAIM ─────────────────────────────────────────────
    # v5.2 (FIX 1): the finalize claim also acquires a payout-initialization
    # claim — only the request that wins this flip may seed missing winner
    # states. A second concurrent request that sees `finalized:true` and
    # `payout_initialization_state == "active"` must NOT call
    # `_seed_results_states` (which would classify legitimate fresh
    # `transfer_ok=None` rows as `manual_review`) and must NOT call the
    # provider — it briefly waits for completion or returns processing.
    finalized_started_at = datetime.now(timezone.utc).isoformat()
    initialization_attempt_id = uuid.uuid4().hex
    claim = await SL_DRAWS.update_one(
        {"draw_id": draw_id, "finalized": {"$ne": True}},
        {"$set": {"finalized": True,
                  "finalize_started_at": finalized_started_at,
                  "payout_status": PAYOUT_PROCESSING,
                  "payout_updated_at": finalized_started_at,
                  # v5.2 (FIX 1): initialization-ownership token.
                  "payout_initialization_state": PAYOUT_INIT_ACTIVE,
                  "payout_initialization_attempt_id":
                      initialization_attempt_id,
                  "payout_initialization_started_at":
                      finalized_started_at}})
    # v5.1 (FIX 2): `fresh_finalize` is true ONLY when THIS request actually
    # performed the finalized:false → finalized:true transition. A re-entrant
    # finalize call on an already-finalized draw (matched_count==0) MUST NOT
    # treat legacy `transfer_ok=None` records as fresh pending — those rows
    # must remain quarantined as manual_review, the seed legacy mapping.
    this_request_claimed_finalize = (getattr(claim, "matched_count", 0) > 0)
    if not this_request_claimed_finalize:
        # ── v5.2 (FIX 1): non-owner path ──────────────────────────────────
        # Already finalized by an earlier call. If THAT earlier call is
        # still actively initializing (active claim, not stale), we MUST
        # NOT seed/quarantine here. Doing so would classify a legitimate
        # fresh `transfer_ok=None` winner as `manual_review` and the
        # provider would never be called.
        existing = await SL_DRAWS.find_one({"draw_id": draw_id}, {"_id": 0})
        draw_doc = existing or draw_doc
        init_state = (existing or {}).get("payout_initialization_state")
        init_started_at = (existing or {}).get(
            "payout_initialization_started_at")
        if init_state == PAYOUT_INIT_ACTIVE:
            # Brief deterministic wait for the owner to complete init.
            poll_n = max(1, int(round(
                INIT_WAIT_TOTAL_SECONDS / INIT_WAIT_POLL_SECONDS)))
            for _ in range(poll_n):
                await asyncio.sleep(INIT_WAIT_POLL_SECONDS)
                refreshed = await SL_DRAWS.find_one(
                    {"draw_id": draw_id}, {"_id": 0})
                rstate = (refreshed or {}).get(
                    "payout_initialization_state")
                if rstate != PAYOUT_INIT_ACTIVE:
                    existing = refreshed or existing
                    draw_doc = existing or draw_doc
                    init_state = rstate
                    break
            else:
                # Still active after the bounded wait. Check stale window:
                # per-winner atomic claims protect against duplicate
                # provider calls, but the spec asks us to NEVER write
                # `manual_review` or call the provider while a fresh
                # initialization is still active.
                started_dt = _parse_iso(init_started_at)
                is_stale = (
                    started_dt is not None
                    and (datetime.now(timezone.utc)
                         - started_dt).total_seconds()
                        >= STALE_INITIALIZATION_SECONDS)
                if not is_stale:
                    # Return the truthful in-progress snapshot WITHOUT
                    # touching seeding or the provider.
                    refreshed = await SL_DRAWS.find_one(
                        {"draw_id": draw_id}, {"_id": 0}) or existing
                    results_now = list((refreshed or {}).get("results")
                                       or [])
                    resp = {
                        "ok":              True,
                        "session_id":      session_id,
                        "draw_id":         draw_id,
                        "pool_total":      (refreshed or {}).get(
                            "pool_total"),
                        "num_winners":     (refreshed or {}).get(
                            "num_winners"),
                        "split":           (refreshed or {}).get("split"),
                        "winners":         results_now,
                        "mock":            use_mock,
                        "drawn_at":        (refreshed or {}).get(
                            "drawn_at"),
                        "finalized":       True,
                        "payout_complete": False,
                        "payout_status":   PAYOUT_PROCESSING,
                        "paid_count":           0,
                        "safe_failure_count":   0,
                        "manual_review_count":  0,
                        "pending_count":        len(results_now),
                        "in_progress_count":    0,
                        "mock_count":           0,
                        # v5.2 (FIX 1): signal that another worker owns init.
                        "payout_initialization_state": PAYOUT_INIT_ACTIVE,
                    }
                    if log:
                        log.info(
                            "lucky_draw: finalize non-owner returning "
                            "processing (init active) %s/%s",
                            session_id, draw_id)
                    return resp
                # Stale init → fall through into the safe legacy path
                # below. Per-winner atomic claims still prevent any
                # duplicate provider call. The non-owner does NOT take
                # ownership; it just safely processes what it can.
        if log:
            log.info("lucky_draw: finalize idempotent hit for %s/%s",
                     session_id, draw_id)

    # ── v5.2 (FIX 1): seed + quarantine only the init OWNER ───────────────
    # The owner (this_request_claimed_finalize==True) MUST seed missing
    # winner states as `pending` (fresh_finalize=True). After seeding, mark
    # initialization complete so non-owners and recovery may safely proceed.
    #
    # A non-owner that fell through here did so because initialization was
    # already complete (or stale). For the "complete" case, seeding is a
    # no-op (every record already has a transfer_state). For the "stale"
    # case, the per-winner atomic claims still prevent duplicate provider
    # calls; we run the legacy `_seed_results_states` (fresh_finalize=False)
    # so any record with `transfer_ok=None` remains quarantined as
    # `manual_review` — never silently auto-paid.
    if this_request_claimed_finalize:
        await _seed_results_states(
            SL_DRAWS, draw_id, list(draw_doc.get("results") or []),
            fresh_finalize=True)
        await _quarantine_stale_in_progress(SL_DRAWS, draw_id)
        # Mark initialization complete BEFORE provider calls, so any
        # waiting non-owner / recovery may safely resume. Guarded by our
        # attempt id so a delayed older claim cannot reset state.
        await SL_DRAWS.update_one(
            {"draw_id": draw_id,
             "payout_initialization_attempt_id":
                 initialization_attempt_id},
            {"$set": {"payout_initialization_state": PAYOUT_INIT_COMPLETE,
                      "payout_initialization_completed_at":
                          datetime.now(timezone.utc).isoformat()}})
    else:
        # Idempotent / stale-init non-owner path. Use the safe legacy
        # mapping so genuinely-legacy `transfer_ok=None` rows stay
        # quarantined; never reseed them as fresh `pending`.
        await _seed_results_states(
            SL_DRAWS, draw_id, list(draw_doc.get("results") or []),
            fresh_finalize=False)
        await _quarantine_stale_in_progress(SL_DRAWS, draw_id)

    # Re-read after seeding for an accurate working set.
    draw_doc = await SL_DRAWS.find_one({"draw_id": draw_id}, {"_id": 0}) \
        or draw_doc
    prepared_results = list(draw_doc.get("results") or [])

    # ── Process winners — independent failures do not stop the loop ───────
    final_results: list[dict] = []
    for rank, rec in enumerate(prepared_results):
        merged = await _process_winner(
            db, SL_DRAWS, sl_publish, session_id, draw_id, rank, rec,
            gas_url, treasury_id, treasury_password, use_mock, log,
            push_notify, mode="initial")
        final_results.append(merged)

    finalized_at = datetime.now(timezone.utc).isoformat()
    payout_status = _aggregate_payout_status(final_results, use_mock=use_mock)
    await SL_DRAWS.update_one(
        {"draw_id": draw_id},
        {"$set": {"finalized_at": finalized_at,
                  "payout_status": payout_status,
                  "payout_updated_at": finalized_at}})
    await SL_SESSIONS.update_one(
        {"session_id": session_id},
        {"$set": {"lucky_draw_at": finalized_at}})

    try:
        await sl_publish(session_id, {
            "type": "draw_complete",
            "pool_total": draw_doc.get("pool_total"),
            "num_winners": draw_doc.get("num_winners"),
            "payout_status": payout_status,
            "results": list(final_results)})
    except Exception as exc:  # noqa: BLE001
        if log:
            log.warning("lucky_draw: sl_publish draw_complete error: %s",
                        str(exc)[:200])

    resp = _finalize_response(session_id, draw_doc, final_results, use_mock)
    resp["finalized_at"] = finalized_at
    return resp


# ---------------------------------------------------------------------------
# v3 safe retry of failed payouts (FIX 9)
# ---------------------------------------------------------------------------

async def _retry_failed_payouts(
    db, sl_publish, session_id: str,
    gas_url: str, treasury_id: str, treasury_password: str,
    mock_gas: bool, log: logging.Logger, *,
    push_notify=None,
    confirm_not_paid: bool = False,
    reason: str = "",
    student_id: Optional[str] = None,
    granted_by: str = "admin",
) -> dict:
    """Admin-only retry.

    v5 (FIX 3) — STUDENT-SPECIFIC:
      • If `confirm_not_paid=True`, an exact `student_id` MUST be supplied
        and only THAT winner is processed. Releasing every manual_review
        winner from one confirmation is forbidden.
      • If `student_id` is supplied without `confirm_not_paid`, only that
        student's `failed_safe_to_retry` row is retried.
      • Without either, all `failed_safe_to_retry` rows in the draw are
        drained (the original pre-v5 behaviour, never touches manual_review).

    Never retries paid / in_progress / mock / ordinary pending winners.
    Audit (admin identity + student_id + reason + draw_id + stable
    payment reference) is logged for every manual override release.
    """
    SL_DRAWS = db.speaking_lab_lucky_draws
    draw_doc = await SL_DRAWS.find_one(
        {"session_id": session_id, "finalized": True},
        {"_id": 0}, sort=[("finalized_at", -1)])
    if not draw_doc:
        raise HTTPException(status_code=404,
                            detail="No finalized draw found for this session")
    draw_id = draw_doc["draw_id"]
    use_mock = bool(draw_doc.get("mock") or mock_gas)

    cfg = _payout_config_state(gas_url, treasury_password, use_mock)
    if cfg == "provider_not_configured":
        raise HTTPException(
            status_code=503,
            detail={"error": "provider_not_configured",
                    "message": "Payout provider is not configured; refusing "
                               "to retry."})

    override_used = bool(confirm_not_paid)
    target_sid = (student_id or "").strip() or None
    if override_used and not (reason or "").strip():
        raise HTTPException(
            status_code=422,
            detail="confirm_not_paid override requires a non-empty reason.")
    if override_used and not target_sid:
        # v5 (FIX 3): explicit student selector is REQUIRED for any
        # manual_review release. Reject ambiguous overrides.
        raise HTTPException(
            status_code=422,
            detail="confirm_not_paid override requires an exact student_id.")

    results = list(draw_doc.get("results") or [])

    # v5 (FIX 3) — pre-flight validation when a specific student is targeted.
    target_rec = None
    if target_sid is not None:
        target_rec = next(
            (r for r in results if r.get("student_id") == target_sid), None)
        if target_rec is None:
            raise HTTPException(
                status_code=404,
                detail={"error": "student_not_in_draw",
                        "student_id": target_sid,
                        "draw_id": draw_id})
        target_state = _legacy_state_for_record(target_rec)
        if override_used and target_state != TRANSFER_MANUAL:
            # The student exists but is NOT in manual_review — refuse.
            raise HTTPException(
                status_code=409,
                detail={"error": "student_not_in_manual_review",
                        "student_id": target_sid,
                        "current_state": target_state})
        if (not override_used) and target_state != TRANSFER_FAILED_RETRY:
            raise HTTPException(
                status_code=409,
                detail={"error": "student_not_in_failed_safe_to_retry",
                        "student_id": target_sid,
                        "current_state": target_state})

    final_results: list[dict] = []
    retried_safe = 0
    released_manual = 0
    for rank, rec in enumerate(results):
        sid = rec.get("student_id")
        state = _legacy_state_for_record(rec)
        # v5 (FIX 3): if a student selector was provided, ONLY touch that one.
        if target_sid is not None and sid != target_sid:
            final_results.append(dict(rec))
            continue

        if state == TRANSFER_FAILED_RETRY:
            merged = await _process_winner(
                db, SL_DRAWS, sl_publish, session_id, draw_id, rank, rec,
                gas_url, treasury_id, treasury_password, use_mock, log,
                push_notify, mode="retry")
            retried_safe += 1
            final_results.append(merged)
        elif state == TRANSFER_MANUAL and override_used:
            # v5 (FIX 3): operator has documented authoritative-ledger
            # verification FOR THIS EXACT STUDENT. Audit identity, target
            # student id, reason, draw id, and the stable payment reference.
            stable_ref = _stable_reference(draw_id, session_id, sid)
            if log:
                log.warning(
                    "lucky_draw: MANUAL-REVIEW OVERRIDE release "
                    "student=%s draw=%s ref=%s by=%s reason=%s",
                    sid, draw_id, stable_ref, granted_by, reason[:200])
            await SL_DRAWS.update_one(
                {"draw_id": draw_id},
                {"$set": {"results.$[w].manual_override_by":      granted_by,
                          "results.$[w].manual_override_reason":  reason[:500],
                          "results.$[w].manual_override_at":
                              datetime.now(timezone.utc).isoformat(),
                          "results.$[w].manual_override_stable_reference":
                              stable_ref}},
                array_filters=[{"w.student_id": sid}])
            merged = await _process_winner(
                db, SL_DRAWS, sl_publish, session_id, draw_id, rank, rec,
                gas_url, treasury_id, treasury_password, use_mock, log,
                push_notify, mode="manual_release")
            released_manual += 1
            final_results.append(merged)
        else:
            final_results.append(dict(rec))

    now_iso = datetime.now(timezone.utc).isoformat()
    payout_status = _aggregate_payout_status(final_results, use_mock=use_mock)
    await SL_DRAWS.update_one(
        {"draw_id": draw_id},
        {"$set": {"payout_status": payout_status, "payout_updated_at": now_iso}})

    resp = _finalize_response(session_id, draw_doc, final_results, use_mock)
    resp["retried_safe_failures"] = retried_safe
    resp["released_manual_review"] = released_manual
    resp["override_used"] = override_used
    resp["student_id_targeted"] = target_sid
    if override_used:
        resp["warning"] = ("OPERATOR CONFIRMATION USED to release a single "
                           "manual_review winner. Authoritative GAS ledger "
                           "verification is the operator's responsibility.")
    return resp


# ---------------------------------------------------------------------------
# v3 notification-only retry (FIX 12) — never calls the provider
# ---------------------------------------------------------------------------

async def _retry_push_only(
    db, session_id: str, log: logging.Logger, *, push_notify=None,
) -> dict:
    """Re-send reward push for PAID winners whose push failed. Never calls the
    payout provider. Reward paid-state is never changed."""
    SL_DRAWS = db.speaking_lab_lucky_draws
    draw_doc = await SL_DRAWS.find_one(
        {"session_id": session_id, "finalized": True},
        {"_id": 0}, sort=[("finalized_at", -1)])
    if not draw_doc:
        raise HTTPException(status_code=404,
                            detail="No finalized draw found for this session")
    draw_id = draw_doc["draw_id"]
    resent = 0
    for rec in list(draw_doc.get("results") or []):
        if _legacy_state_for_record(rec) != TRANSFER_PAID:
            continue
        pstate = rec.get("push_notification_state")
        if pstate == PUSH_SENT:
            continue
        # Retry only failed / no_subscribers / pending / stale-sending. Never GAS.
        if pstate == PUSH_SENDING:
            started = _parse_iso(rec.get("push_notification_started_at"))
            now = datetime.now(timezone.utc)
            if started is not None and \
                    (now - started).total_seconds() < PUSH_STALE_SECONDS:
                continue  # actively sending elsewhere — skip
        student_id = rec.get("student_id")
        amount = int(rec.get("amount") or 0)
        code = rec.get("code") or ""
        stable_ref = _stable_reference(draw_id, session_id, student_id)
        await _send_winner_push_idempotent(
            SL_DRAWS, draw_id, student_id, amount, code, stable_ref,
            push_notify, log)
        resent += 1
    fresh = await SL_DRAWS.find_one({"draw_id": draw_id}, {"_id": 0}) or draw_doc
    return {"ok": True, "session_id": session_id, "draw_id": draw_id,
            "push_retry_candidates": resent,
            "winners": list(fresh.get("results", []))}


# ---------------------------------------------------------------------------
# v3 browser-abandoned draw recovery (FIX 10) + historical reconciliation (FIX 11)
# ---------------------------------------------------------------------------

def _parse_iso(ts: Optional[str]) -> Optional[datetime]:
    if not ts:
        return None
    try:
        s = ts.replace("Z", "+00:00") if str(ts).endswith("Z") else str(ts)
        dt = datetime.fromisoformat(s)
        if dt.tzinfo is None:
            dt = dt.replace(tzinfo=timezone.utc)
        return dt.astimezone(timezone.utc)
    except Exception:  # noqa: BLE001
        return None


async def _process_unresolved_finalized_draw(
    db, sl_publish, draw, gas_url, treasury_id, treasury_password,
    mock_gas, log, push_notify,
) -> bool:
    """Recover a FINALIZED draw whose payout is unresolved (FIX 2): a crash
    after the `finalized=true` claim but before/within winner processing.

    Automatically processes ONLY `pending` winners that have NO provider
    attempt id. Stale `in_progress` winners are quarantined to manual_review
    (never resent). Never touches paid / mock / manual_review, and never
    auto-retries failed_safe_to_retry (that is the explicit retry policy).

    v5.2 (FIX 1): if a fresh payout initialization is still ACTIVE (i.e. an
    online finalize owner is still seeding winner states), the recovery
    worker MUST NOT touch this draw — seeding it as legacy would classify
    fresh `transfer_ok=None` winners as `manual_review` and starve the
    owner's payout. We skip during active+recent initialization. A
    genuinely-stale initialization (older than STALE_INITIALIZATION_SECONDS)
    falls through and recovery proceeds with the safe legacy mapping;
    per-winner atomic claims still prevent any duplicate provider call.
    """
    SL_DRAWS = db.speaking_lab_lucky_draws
    draw_id = draw["draw_id"]
    session_id = draw.get("session_id")
    use_mock = bool(draw.get("mock") or mock_gas)
    # ── v5.2 (FIX 1): respect active initialization ownership ─────────────
    init_state = draw.get("payout_initialization_state")
    if init_state == PAYOUT_INIT_ACTIVE:
        started_dt = _parse_iso(draw.get("payout_initialization_started_at"))
        is_stale = (
            started_dt is not None
            and (datetime.now(timezone.utc)
                 - started_dt).total_seconds()
                >= STALE_INITIALIZATION_SECONDS)
        if not is_stale:
            if log:
                log.info("lucky_draw recovery: skipping %s — fresh payout "
                         "initialization is active", draw_id)
            return False
    await _seed_results_states(SL_DRAWS, draw_id)
    await _quarantine_stale_in_progress(SL_DRAWS, draw_id)
    fresh = await SL_DRAWS.find_one({"draw_id": draw_id}, {"_id": 0}) or draw
    final_results: list[dict] = []
    acted = False
    for rank, rec in enumerate(list(fresh.get("results") or [])):
        state = _legacy_state_for_record(rec)
        if state == TRANSFER_PENDING and not rec.get("transfer_attempt_id"):
            merged = await _process_winner(
                db, SL_DRAWS, sl_publish, session_id, draw_id, rank, rec,
                gas_url, treasury_id, treasury_password, use_mock, log,
                push_notify, mode="initial")
            acted = True
            final_results.append(merged)
        else:
            final_results.append(dict(rec))
    now_iso = datetime.now(timezone.utc).isoformat()
    payout_status = _aggregate_payout_status(final_results, use_mock=use_mock)
    await SL_DRAWS.update_one(
        {"draw_id": draw_id},
        {"$set": {"payout_status": payout_status, "payout_updated_at": now_iso}})
    return acted


async def recover_abandoned_draws(
    db, sl_publish, gas_url: str, treasury_id: str, treasury_password: str,
    mock_gas: bool, log: logging.Logger, *, push_notify=None,
) -> dict:
    """One bounded recovery pass (called every ~60s by the background loop).

    Recovers TWO buckets (FIX 2/7), each within the 3-min..24h age window and
    only when payout configuration is valid:

      A. Prepared-but-unfinalized draws (`finalized != true`) → `_finalize_draw`.
      B. Finalized-but-UNRESOLVED draws (`payout_status` in processing/pending/
         completed_with_failures, or a `pending` winner remains) →
         `_process_unresolved_finalized_draw`.

    Automatically processes only `pending` winners with no provider attempt;
    `failed_safe_to_retry` only via the retry policy; never resends
    in_progress / manual_review / paid / mock. Per-draw failures are caught so
    later cycles continue. Safe across multiple instances (atomic claims).
    """
    SL_DRAWS = db.speaking_lab_lucky_draws
    cfg = _payout_config_state(gas_url, treasury_password, bool(mock_gas))
    if cfg == "provider_not_configured":
        if log:
            log.warning("lucky_draw recovery: skipped — provider not configured")
        return {"scanned": 0, "recovered": 0, "resolved_finalized": 0,
                "skipped_config": True}

    now = datetime.now(timezone.utc)
    recovered = 0
    resolved_finalized = 0
    scanned = 0

    def _in_window(draw) -> bool:
        prepared = _parse_iso(draw.get("prepared_at") or draw.get("drawn_at"))
        if prepared is None:
            return False
        age = (now - prepared).total_seconds()
        return RECOVERY_GRACE_SECONDS <= age <= RECOVERY_MAX_AGE_SECONDS

    # ── Bucket A: prepared-but-unfinalized ────────────────────────────────
    cursor = SL_DRAWS.find(
        {"finalized": {"$ne": True}}, {"_id": 0},
    ).sort("prepared_at", 1).limit(RECOVERY_BATCH_LIMIT)
    async for draw in cursor:
        scanned += 1
        if not _in_window(draw):
            continue
        session_id = draw.get("session_id")
        try:
            await _finalize_draw(
                db, sl_publish, session_id, gas_url, treasury_id,
                treasury_password, mock_gas, log, push_notify=push_notify)
            recovered += 1
            if log:
                log.info("lucky_draw recovery: finalized abandoned draw %s "
                         "(session=%s)", draw.get("draw_id"), session_id)
        except HTTPException:
            continue
        except Exception as exc:  # noqa: BLE001
            if log:
                log.warning("lucky_draw recovery: error finalizing %s: %s",
                            draw.get("draw_id"), str(exc)[:200])
            continue

    # ── Bucket B: finalized-but-unresolved ────────────────────────────────
    cursor2 = SL_DRAWS.find(
        {"finalized": True,
         "payout_status": {"$in": [PAYOUT_PROCESSING, "pending",
                                   PAYOUT_COMPLETED_WITH_FAILURES]}},
        {"_id": 0},
    ).sort("prepared_at", 1).limit(RECOVERY_BATCH_LIMIT)
    async for draw in cursor2:
        scanned += 1
        if not _in_window(draw):
            continue
        try:
            acted = await _process_unresolved_finalized_draw(
                db, sl_publish, draw, gas_url, treasury_id, treasury_password,
                mock_gas, log, push_notify)
            if acted:
                resolved_finalized += 1
                if log:
                    log.info("lucky_draw recovery: resolved finalized draw %s",
                             draw.get("draw_id"))
        except Exception as exc:  # noqa: BLE001
            if log:
                log.warning("lucky_draw recovery: error resolving %s: %s",
                            draw.get("draw_id"), str(exc)[:200])
            continue

    return {"scanned": scanned, "recovered": recovered,
            "resolved_finalized": resolved_finalized, "skipped_config": False}


async def _reconcile_historical_draw(
    db, sl_publish, session_id: str,
    gas_url: str, treasury_id: str, treasury_password: str,
    mock_gas: bool, log: logging.Logger, *,
    push_notify=None, confirm_historical_recovery: bool = False,
    reason: str = "", granted_by: str = "admin",
) -> dict:
    """Admin-only explicit reconciliation of an OLD (>24h) draw (FIX 11).

    Requires confirm_historical_recovery=True + non-empty reason. Preserves
    winner list / amount / rank / code, reuses the same state machine and
    stable references, and refuses uncertain (manual_review) winners unless
    the operator also passes the confirm override semantics. Never runs
    automatically just because a deployment occurred.
    """
    if not confirm_historical_recovery:
        raise HTTPException(
            status_code=422,
            detail="Historical reconciliation requires "
                   "confirm_historical_recovery=true.")
    if not (reason or "").strip():
        raise HTTPException(
            status_code=422,
            detail="Historical reconciliation requires a non-empty reason.")
    cfg = _payout_config_state(gas_url, treasury_password, bool(mock_gas))
    if cfg == "provider_not_configured":
        raise HTTPException(
            status_code=503,
            detail={"error": "provider_not_configured",
                    "message": "Payout provider is not configured."})

    SL_DRAWS = db.speaking_lab_lucky_draws
    draw_doc = await SL_DRAWS.find_one(
        {"session_id": session_id}, {"_id": 0},
        sort=[("prepared_at", -1)])
    if not draw_doc:
        raise HTTPException(status_code=404,
                            detail="No draw found for this session")
    draw_id = draw_doc["draw_id"]
    use_mock = bool(draw_doc.get("mock") or mock_gas)
    if log:
        log.warning("lucky_draw HISTORICAL reconciliation draw=%s by=%s "
                    "reason=%s", draw_id, granted_by, reason[:200])

    # Make sure it is finalized (claim) so per-winner processing is allowed.
    await SL_DRAWS.update_one(
        {"draw_id": draw_id, "finalized": {"$ne": True}},
        {"$set": {"finalized": True,
                  "finalize_started_at":
                      datetime.now(timezone.utc).isoformat()}})
    await _seed_results_states(SL_DRAWS, draw_id,
                               list(draw_doc.get("results") or []))
    draw_doc = await SL_DRAWS.find_one({"draw_id": draw_id}, {"_id": 0}) \
        or draw_doc

    final_results: list[dict] = []
    for rank, rec in enumerate(list(draw_doc.get("results") or [])):
        state = _legacy_state_for_record(rec)
        if state == TRANSFER_PENDING:
            merged = await _process_winner(
                db, SL_DRAWS, sl_publish, session_id, draw_id, rank, rec,
                gas_url, treasury_id, treasury_password, use_mock, log,
                push_notify, mode="initial")
        elif state == TRANSFER_FAILED_RETRY:
            merged = await _process_winner(
                db, SL_DRAWS, sl_publish, session_id, draw_id, rank, rec,
                gas_url, treasury_id, treasury_password, use_mock, log,
                push_notify, mode="retry")
        elif state == TRANSFER_MANUAL:
            # Refuse uncertain winners — operator must confirm separately via
            # the retry-failed override route after ledger verification.
            merged = dict(rec)
        else:
            merged = dict(rec)
        final_results.append(merged)

    now_iso = datetime.now(timezone.utc).isoformat()
    payout_status = _aggregate_payout_status(final_results, use_mock=use_mock)
    await SL_DRAWS.update_one(
        {"draw_id": draw_id},
        {"$set": {"payout_status": payout_status, "payout_updated_at": now_iso,
                  "historical_reconciled_by": granted_by,
                  "historical_reconciled_reason": reason[:500],
                  "historical_reconciled_at": now_iso}})
    resp = _finalize_response(session_id, draw_doc, final_results, use_mock)
    resp["historical_reconciliation"] = True
    return resp


# ---------------------------------------------------------------------------
# Optional: helper to ensure the Mongo indexes exist. Call once at startup.
# ---------------------------------------------------------------------------

async def ensure_lucky_draw_indexes(db) -> None:
    await db.speaking_lab_lucky_codes.create_index(
        [("session_id", 1), ("student_id", 1)], unique=True,
    )
    await db.speaking_lab_lucky_codes.create_index(
        [("session_id", 1), ("code", 1)], unique=True,
    )
    await db.speaking_lab_lucky_draws.create_index("session_id")
    await db.speaking_lab_lucky_draws.create_index("drawn_at")
    # Phase 4: support the finalize-idempotency lookup.
    await db.speaking_lab_lucky_draws.create_index("draw_id", unique=True)
    # v3: support the browser-abandoned recovery scan (FIX 10).
    await db.speaking_lab_lucky_draws.create_index([("finalized", 1),
                                                    ("prepared_at", 1)])
