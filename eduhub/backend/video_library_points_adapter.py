"""video_library_points_adapter.py
===================================
Isolated GAS Points adapter for Video Library purchases.

Per explicit product direction: Video Library must NOT use the legacy
Google Sheets / Google Forms book-unlock mechanism, and ownership must be
backend-verified end to end. GAS remains the authoritative POINTS BALANCE
store for the whole platform today (confirmed: wallet_service.py's own
general-points migration is still "Phase 1 preflight", read-only/audit —
see its module docstring), so spending real EduHub Points still means a
real GAS `sendPoints` call. The difference from the legacy book mechanism
is WHO calls it and WHO records the result: here, the BACKEND makes the
call and the BACKEND's own MongoDB record is the sole proof of ownership —
never a client-reported "success", never a Google Form, never localStorage.

This module deliberately does NOT import anything from
voice_treasure_points_adapter.py, premium_ai_tools.py, payment_bridge.py,
or wallet_service.py — it independently re-implements the same proven,
public GAS `sendPoints`/`login` HTTP convention those modules already use,
reading the same environment variables:

    GAS_POINTS_LOGIN_URL    — GAS web-app endpoint
    SL_TREASURY_ID          — treasury wallet id (receiver for debits);
                              default "stu092"

This mirrors this codebase's own established convention (see
voice_treasure_points_adapter.py's identical docstring rationale): each
feature gets its OWN isolated adapter and its OWN audit boundary, rather
than a shared points client multiple features could accidentally couple
through.

Security rules enforced here (identical to the Voice Treasure precedent):
  * the STUDENT password authorises a student→treasury debit or balance
    read ONLY; it is never persisted, never returned, never logged;
  * every log line redacts credentials and provider payloads (keys +
    success flag + nonce only);
  * bounded timeouts on every call.

Outcome classification (drives the purchase state machine in
video_library_tools.py):
  * "ok"        — GAS returned success:true. The transaction applied.
  * "rejected"  — GAS returned success:false. DEFINITIVE failure: no
                  points moved. Safe to allow a new attempt.
  * "ambiguous" — timeout / network error / non-200 / unparseable body. We
                  DO NOT know whether points moved. Caller MUST route this
                  to admin reconciliation and MUST NOT auto-retry.
"""
from __future__ import annotations

import os
import secrets
import time
from typing import Any

import httpx

OUTCOME_OK = "ok"
OUTCOME_REJECTED = "rejected"
OUTCOME_AMBIGUOUS = "ambiguous"

_BALANCE_TIMEOUT = httpx.Timeout(10.0, connect=5.0)
_DEBIT_TIMEOUT = httpx.Timeout(15.0, connect=6.0)


def _gas_url() -> str:
    return (os.environ.get("GAS_POINTS_LOGIN_URL") or "").strip()


def _treasury_id() -> str:
    return (os.environ.get("SL_TREASURY_ID") or "stu092").strip()


def gas_debit_configured() -> bool:
    return bool(_gas_url())


def _new_nonce() -> str:
    return secrets.token_hex(12)


def _classify_response(status: int, body: Any) -> tuple[str, str]:
    if status != 200:
        return OUTCOME_AMBIGUOUS, f"http_{status}"
    if not isinstance(body, dict):
        return OUTCOME_AMBIGUOUS, "bad_json_shape"
    if body.get("success") is True:
        return OUTCOME_OK, ""
    reason = str(body.get("message") or body.get("error") or "rejected")[:60]
    return OUTCOME_REJECTED, f"rejected_{reason}"


async def get_authoritative_balance(student_clean_id: str, password: str) -> tuple[int | None, str]:
    """Read the student's authoritative GAS balance via `action=login`.
    Returns (points, reason). points is None on any failure."""
    if not password:
        return None, "missing_password"
    url = _gas_url()
    if not url:
        return None, "no_gas_url"

    params = {
        "action": "login", "id": student_clean_id, "password": password,
        "t": str(int(time.time() * 1000)),
    }
    last = "ambiguous_unknown"
    try:
        async with httpx.AsyncClient(timeout=_BALANCE_TIMEOUT, follow_redirects=True) as cli:
            for method in ("post", "get"):
                try:
                    r = await (cli.post(url, data=params) if method == "post" else cli.get(url, params=params))
                    if r.status_code == 200:
                        try:
                            j = r.json()
                        except Exception:
                            last = f"{method}_bad_json"
                            continue
                        if isinstance(j, dict) and j.get("success") is True and isinstance(j.get("points"), (int, float)):
                            return int(j["points"]), ""
                        last = f"{method}_rejected"
                    else:
                        last = f"{method}_http_{r.status_code}"
                except Exception as exc:  # noqa: BLE001
                    last = f"{method}_network_{type(exc).__name__}"
    except Exception as exc:  # noqa: BLE001
        return None, f"ambiguous_outer_{type(exc).__name__}"
    return None, f"ambiguous_{last}"


async def debit_purchase(
    student_clean_id: str, password: str, amount: int, *, nonce: str | None = None,
) -> dict[str, Any]:
    """Debit the student via GAS `sendPoints(student -> treasury)` for a
    video lesson purchase. The caller (video_library_tools.py) MUST have
    created a local purchase record first and MUST treat "ambiguous" as
    needs_manual_reconciliation — never auto-retry."""
    if not password:
        return {"outcome": OUTCOME_REJECTED, "reason": "missing_password", "nonce": nonce or ""}
    url = _gas_url()
    if not url:
        return {"outcome": OUTCOME_REJECTED, "reason": "no_gas_url", "nonce": nonce or ""}
    if int(amount) <= 0:
        return {"outcome": OUTCOME_REJECTED, "reason": "non_positive_amount", "nonce": nonce or ""}

    n = nonce or _new_nonce()
    payload = {
        "action": "sendPoints", "id": student_clean_id, "password": password,
        "receiverId": _treasury_id(), "amount": str(int(amount)), "nonce": n,
    }
    try:
        async with httpx.AsyncClient(timeout=_DEBIT_TIMEOUT, follow_redirects=True) as cli:
            r = await cli.post(url, data=payload)
        try:
            body = r.json()
        except Exception:
            body = None
        outcome, reason = _classify_response(r.status_code, body)
        return {"outcome": outcome, "reason": reason, "nonce": n}
    except (httpx.TimeoutException, httpx.TransportError) as exc:
        return {"outcome": OUTCOME_AMBIGUOUS, "reason": f"network_{type(exc).__name__}", "nonce": n}
    except Exception as exc:  # noqa: BLE001
        return {"outcome": OUTCOME_AMBIGUOUS, "reason": f"error_{type(exc).__name__}", "nonce": n}


async def reconciliation_balance_probe(student_clean_id: str, password: str) -> dict[str, Any]:
    """ADVISORY ONLY, admin reconcile flow. GAS exposes no transaction-id
    status query — a fresh balance read is the only signal a human operator
    can compare against the purchase's recorded pre-debit balance. Never
    called from the student purchase path; never auto-resolves anything."""
    bal, reason = await get_authoritative_balance(student_clean_id, password)
    return {"ok": bal is not None, "balance": bal, "reason": reason}
