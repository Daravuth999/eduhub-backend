"""voice_treasure_points_adapter.py
===================================
Isolated GAS Points adapter for Voice Treasure (Phase 3).

Voice Treasure treats GAS as the authoritative Points store for v1. This
adapter is the ONLY place Voice Treasure talks to the GAS treasury. It
deliberately does NOT import anything from premium_ai_tools.py,
payment_bridge.py, wallet_service.py, or lucky_draw.py — it independently
re-implements the same proven, public GAS ``sendPoints`` / ``login`` HTTP
convention, reading the same environment variables those modules read:

    GAS_POINTS_LOGIN_URL    — GAS web-app endpoint
    SL_TREASURY_ID          — treasury wallet id (receiver for debits,
                              sender for reward credits); default "stu092"
    SL_TREASURY_PASSWORD    — treasury authorisation (reward credits only)

Security rules enforced here:
  * the STUDENT password is used ONLY to authorise a student→treasury debit
    or a balance read; it is never persisted, never returned, never logged;
  * the TREASURY password is used ONLY to authorise a treasury→student
    reward credit; never persisted/returned/logged;
  * every log line redacts credentials and provider payloads (we log keys +
    success flag + nonce only);
  * bounded timeouts on every call;
  * provider errors are normalised into short internal reason codes.

Outcome classification (drives the entry state machine in the caller):
  * "ok"        — GAS returned success:true. The transaction applied.
  * "rejected"  — GAS returned success:false with a message. DEFINITIVE
                  failure: no points moved. Safe to allow a new attempt.
  * "ambiguous" — timeout / network error / non-200 / unparseable body. We
                  DO NOT know whether points moved. Caller MUST route this
                  to manual reconciliation and MUST NOT auto-retry.

NOTE ON IDEMPOTENCY: the GAS pathway is not proven to honour a
caller-controlled idempotency key, so this adapter does NOT claim
exactly-once. It sends a ``nonce`` (required by the secured backend, ignored
by legacy) but the caller is responsible for at-most-once *local* initiation
via its own transaction record.
"""
from __future__ import annotations

import logging
import os
import secrets
import time
from typing import Any

import httpx

log = logging.getLogger("eduhub.voice_treasure.points")

# ── outcome constants ─────────────────────────────────────────────────────
OUTCOME_OK = "ok"
OUTCOME_REJECTED = "rejected"
OUTCOME_AMBIGUOUS = "ambiguous"

_BALANCE_TIMEOUT = httpx.Timeout(10.0, connect=5.0)
_DEBIT_TIMEOUT = httpx.Timeout(15.0, connect=6.0)


# ── configuration (read at call time so a redeploy/rotation is picked up) ──
def _gas_url() -> str:
    return (os.environ.get("GAS_POINTS_LOGIN_URL") or "").strip()


def _treasury_id() -> str:
    return (os.environ.get("SL_TREASURY_ID") or "stu092").strip()


def _treasury_password() -> str:
    return os.environ.get("SL_TREASURY_PASSWORD") or ""


def gas_debit_configured() -> bool:
    """Entry debits need only the GAS URL (student supplies their own pw)."""
    return bool(_gas_url())


def gas_credit_configured() -> bool:
    """Reward credits additionally need the treasury credential."""
    return bool(_gas_url() and _treasury_id() and _treasury_password())


def _new_nonce() -> str:
    return secrets.token_hex(12)


def _classify_response(status: int, body: Any) -> tuple[str, str]:
    """Map a GAS HTTP response to (outcome, reason_code). Never includes
    credentials. ``reason_code`` is operator-facing and student-safe."""
    if status != 200:
        return OUTCOME_AMBIGUOUS, f"http_{status}"
    if not isinstance(body, dict):
        return OUTCOME_AMBIGUOUS, "bad_json_shape"
    if body.get("success") is True:
        return OUTCOME_OK, ""
    # Explicit success:false ⇒ GAS definitively rejected; nothing moved.
    raw = body.get("message") or body.get("error") or "rejected"
    # Sanitise to a short token; never echo arbitrary provider text to users.
    reason = str(raw)[:60].replace(_treasury_password() or "\x00", "***") if _treasury_password() else str(raw)[:60]
    return OUTCOME_REJECTED, f"rejected_{reason}"


# --------------------------------------------------------------------------- #
# Public API                                                                  #
# --------------------------------------------------------------------------- #
async def get_authoritative_balance(
    student_clean_id: str, password: str
) -> tuple[int | None, str]:
    """Read the student's authoritative GAS balance via ``action=login``.

    Returns ``(points, reason)``. ``points`` is None on any failure;
    ``reason`` is a short safe code ("missing_password", "no_gas_url",
    "rejected_*", "ambiguous_*"). Tries POST then GET (legacy fallback),
    mirroring the proven public convention. The password is used once and
    never logged.
    """
    if not password:
        return None, "missing_password"
    url = _gas_url()
    if not url:
        return None, "no_gas_url"

    params = {
        "action": "login",
        "id": student_clean_id,
        "password": password,
        "t": str(int(time.time() * 1000)),
    }
    last = "ambiguous_unknown"
    try:
        async with httpx.AsyncClient(timeout=_BALANCE_TIMEOUT, follow_redirects=True) as cli:
            for method in ("post", "get"):
                try:
                    if method == "post":
                        r = await cli.post(url, data=params)
                    else:
                        r = await cli.get(url, params=params)
                    if r.status_code == 200:
                        try:
                            j = r.json()
                        except Exception:
                            last = f"{method}_bad_json"
                            continue
                        log.info(
                            "vt-points: balance %s keys=%s success=%s",
                            method.upper(),
                            sorted(j.keys()) if isinstance(j, dict) else type(j).__name__,
                            (j or {}).get("success") if isinstance(j, dict) else None,
                        )
                        if isinstance(j, dict) and j.get("success") is True and isinstance(
                            j.get("points"), (int, float)
                        ):
                            return int(j["points"]), ""
                        last = f"{method}_rejected"
                    else:
                        last = f"{method}_http_{r.status_code}"
                except Exception as exc:  # noqa: BLE001
                    last = f"{method}_network_{type(exc).__name__}"
    except Exception as exc:  # noqa: BLE001
        log.warning("vt-points: balance outer error: %s", type(exc).__name__)
        return None, f"ambiguous_outer_{type(exc).__name__}"
    return None, f"ambiguous_{last}"


async def debit_entry(
    student_clean_id: str, password: str, amount: int, *, nonce: str | None = None
) -> dict[str, Any]:
    """Debit the student via GAS ``sendPoints(student → treasury)``.

    The student's password authorises the move. Returns a dict:
        {outcome: "ok"|"rejected"|"ambiguous", reason: str, nonce: str}
    The caller MUST have created a local entry record first and MUST treat
    "ambiguous" as needs_manual_reconciliation (never auto-retry).
    """
    if not password:
        return {"outcome": OUTCOME_REJECTED, "reason": "missing_password", "nonce": nonce or ""}
    url = _gas_url()
    if not url:
        # No URL ⇒ we never even attempted ⇒ definitively nothing moved.
        return {"outcome": OUTCOME_REJECTED, "reason": "no_gas_url", "nonce": nonce or ""}
    if int(amount) <= 0:
        return {"outcome": OUTCOME_REJECTED, "reason": "non_positive_amount", "nonce": nonce or ""}

    n = nonce or _new_nonce()
    payload = {
        "action": "sendPoints",
        "id": student_clean_id,
        "password": password,
        "receiverId": _treasury_id(),
        "amount": str(int(amount)),
        "nonce": n,
    }
    try:
        async with httpx.AsyncClient(timeout=_DEBIT_TIMEOUT, follow_redirects=True) as cli:
            r = await cli.post(url, data=payload)
        try:
            body = r.json()
        except Exception:
            body = None
        log.info(
            "vt-points: debit POST status=%s keys=%s success=%s nonce=%s",
            r.status_code,
            sorted(body.keys()) if isinstance(body, dict) else type(body).__name__,
            (body or {}).get("success") if isinstance(body, dict) else None,
            n,
        )
        outcome, reason = _classify_response(r.status_code, body)
        return {"outcome": outcome, "reason": reason, "nonce": n}
    except (httpx.TimeoutException, httpx.TransportError) as exc:
        # Timeout / connection error AFTER we sent the request: we cannot
        # know if GAS applied the debit ⇒ AMBIGUOUS.
        log.warning("vt-points: debit ambiguous %s nonce=%s", type(exc).__name__, n)
        return {"outcome": OUTCOME_AMBIGUOUS, "reason": f"network_{type(exc).__name__}", "nonce": n}
    except Exception as exc:  # noqa: BLE001
        log.warning("vt-points: debit ambiguous-other %s nonce=%s", type(exc).__name__, n)
        return {"outcome": OUTCOME_AMBIGUOUS, "reason": f"error_{type(exc).__name__}", "nonce": n}


async def credit_reward(
    student_clean_id: str, amount: int, *, nonce: str | None = None
) -> dict[str, Any]:
    """Reward credit via GAS ``sendPoints(treasury → student)``. Uses the
    treasury credential (never the student's). Same outcome contract as
    debit_entry. (Reward payout itself is a later phase; provided now so the
    adapter contract is complete and unit-testable.)"""
    url = _gas_url()
    if not gas_credit_configured():
        return {"outcome": OUTCOME_REJECTED, "reason": "treasury_not_configured", "nonce": nonce or ""}
    if int(amount) <= 0:
        return {"outcome": OUTCOME_REJECTED, "reason": "non_positive_amount", "nonce": nonce or ""}
    n = nonce or _new_nonce()
    payload = {
        "action": "sendPoints",
        "id": _treasury_id(),
        "password": _treasury_password(),
        "receiverId": student_clean_id,
        "amount": str(int(amount)),
        "nonce": n,
    }
    try:
        async with httpx.AsyncClient(timeout=_DEBIT_TIMEOUT, follow_redirects=True) as cli:
            r = await cli.post(url, data=payload)
        try:
            body = r.json()
        except Exception:
            body = None
        log.info(
            "vt-points: credit POST status=%s keys=%s success=%s nonce=%s",
            r.status_code,
            sorted(body.keys()) if isinstance(body, dict) else type(body).__name__,
            (body or {}).get("success") if isinstance(body, dict) else None,
            n,
        )
        outcome, reason = _classify_response(r.status_code, body)
        return {"outcome": outcome, "reason": reason, "nonce": n}
    except (httpx.TimeoutException, httpx.TransportError) as exc:
        return {"outcome": OUTCOME_AMBIGUOUS, "reason": f"network_{type(exc).__name__}", "nonce": n}
    except Exception as exc:  # noqa: BLE001
        return {"outcome": OUTCOME_AMBIGUOUS, "reason": f"error_{type(exc).__name__}", "nonce": n}


async def reconciliation_balance_probe(
    student_clean_id: str, password: str
) -> dict[str, Any]:
    """ADVISORY ONLY. The GAS service exposes NO transaction-id status query,
    so an ambiguous ``sendPoints`` outcome can NOT be resolved automatically.
    The only signal available is a fresh authoritative balance read, which a
    human operator may compare against the entry's recorded ``points_before``
    while manually reconciling. Returns:
        {"ok": bool, "balance": int|None, "reason": str}
    This NEVER auto-resolves a reconciliation and is never called from the
    student debit path — ambiguous entries remain admin reconciliation cases.
    """
    bal, reason = await get_authoritative_balance(student_clean_id, password)
    return {"ok": bal is not None, "balance": bal, "reason": reason}
