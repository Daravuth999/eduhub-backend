"""CamRapidPay KHQR provider for EduHub Points Top Up.

This module is the ONLY place that knows the CamRapidPay HTTP contract.
It is intentionally self-contained and side-effect free: it does NOT credit
points, write intents, or touch the wallet. It only talks to CamRapidPay and
returns normalized dicts. Crediting + idempotency live in
camrapidpay_payment_tools.py which reuses EduHub's existing once-only credit.

Security contract:
  - The API key is read ONLY from the CAMRAPIDPAY_API_KEY env var (Render).
  - The API key is NEVER logged, NEVER returned to the frontend, NEVER put in
    an exception message that could reach a client.
  - read_config() returns None unless CAMRAPIDPAY_ENABLED == "true" AND the
    key + base URL are present, so the provider is dormant by default.
  - Every network call has a timeout and never raises to the caller; it
    returns {"ok": False, "error": "<safe message>"} on any failure.
"""

import os as _os
import logging as _logging

_log = _logging.getLogger("eduhub.camrapidpay")

# CamRapidPay normalized status values.
STATUS_SUCCESS = "Success"
STATUS_PENDING = "Pending"
STATUS_EXPIRED = "Expired"
STATUS_UNKNOWN = "Unknown"


def read_config():
    """Return a config dict only when the provider is enabled and configured.

    Returns None when CAMRAPIDPAY_ENABLED is not "true" or required vars are
    missing, which keeps the provider completely dormant (fallback to ABA).
    """
    enabled = _os.environ.get("CAMRAPIDPAY_ENABLED", "false").strip().lower() == "true"
    if not enabled:
        return None
    api_key = _os.environ.get("CAMRAPIDPAY_API_KEY", "").strip()
    base_url = _os.environ.get("CAMRAPIDPAY_BASE_URL", "https://pay.camrapidpay.com").strip().rstrip("/")
    if not api_key or not base_url:
        return None
    return {
        "api_key":     api_key,
        "base_url":    base_url,
        "return_url":  _os.environ.get("CAMRAPIDPAY_RETURN_URL", "").strip(),
        "callback_url": _os.environ.get("CAMRAPIDPAY_CALLBACK_URL", "").strip(),
        "webhook_secret": _os.environ.get("CAMRAPIDPAY_WEBHOOK_SECRET", "").strip(),
    }


def is_enabled():
    """True when the provider is enabled and configured."""
    return read_config() is not None


def _normalize_status(raw_status):
    """Map any CamRapidPay status string to one of our STATUS_* constants."""
    s = (raw_status or "").strip().lower()
    if s in ("success", "paid", "completed"):
        return STATUS_SUCCESS
    if s in ("pending", "processing", "awaiting", "unpaid"):
        return STATUS_PENDING
    if s in ("expired", "timeout", "cancelled", "canceled"):
        return STATUS_EXPIRED
    return STATUS_UNKNOWN


async def create_payment(httpx_client_factory, amount, reference, success_url, webhook_url):
    """Create a CamRapidPay KHQR invoice.

    Args:
        httpx_client_factory: a zero-arg callable returning an httpx.AsyncClient
            context manager (passed in so we reuse server.py's httpx import).
        amount: int KHR amount (> 0), set server-side from the package (e.g. 5000, 10000).
        reference: unique reference (<= 50 chars).
        success_url: browser redirect URL (UX only, never proof).
        webhook_url: our webhook URL (may include ?token= filter).

    Returns dict:
        {"ok": True, "status", "payment_url", "qr_code", "bill_number",
         "amount", "merchant_name", "expires_in", "raw"}  on success
        {"ok": False, "error": "<safe message>"}  on any failure (never raises)
    """
    cfg = read_config()
    if cfg is None:
        return {"ok": False, "error": "provider_disabled"}
    if not amount or int(amount) <= 0:
        return {"ok": False, "error": "invalid_amount"}
    if not reference or len(reference) > 50:
        return {"ok": False, "error": "invalid_reference"}

    url = f"{cfg['base_url']}/api/v1/khqr/create-payments"
    body = {
        "api_key":   cfg["api_key"],
        "amount":    int(amount),     # KHR integer — NOT USD decimal
        "currency":  "KHR",           # explicit currency for KHQR generation
        "reference": reference,
        "webhook_url": webhook_url,
    }
    if success_url:
        body["success_url"] = success_url

    try:
        async with httpx_client_factory() as cli:
            r = await cli.post(
                url,
                json=body,
                headers={"Content-Type": "application/json", "Accept": "application/json"},
            )
        if r.status_code != 200:
            _log.warning("camrapidpay: create HTTP %s for ref=%s", r.status_code, reference)
            return {"ok": False, "error": f"http_{r.status_code}"}
        j = r.json()
        if not isinstance(j, dict) or j.get("success") is not True:
            # Do NOT echo provider message verbatim if it could contain the key;
            # CamRapidPay messages are generic, but stay safe.
            msg = str(j.get("message", "create_failed"))[:120] if isinstance(j, dict) else "create_failed"
            _log.warning("camrapidpay: create rejected ref=%s msg=%s", reference, msg)
            return {"ok": False, "error": msg}
        return {
            "ok":            True,
            "status":        _normalize_status(j.get("status")),
            "payment_url":   str(j.get("payment_url", "")),
            "qr_code":       str(j.get("qr_code", "")),
            "bill_number":   str(j.get("bill_number", "")),
            "amount":        j.get("amount"),
            "merchant_name": str(j.get("merchant_name", "")),
            "expires_in":    str(j.get("expires_in", "5 minutes")),
            "raw":           _sanitize_raw(j),
        }
    except Exception as exc:  # noqa: BLE001
        _log.warning("camrapidpay: create exception ref=%s type=%s", reference, type(exc).__name__)
        return {"ok": False, "error": "network_error"}


async def check_status(httpx_client_factory, reference):
    """Server-to-server status check. THE ONLY trusted proof of payment.

    Returns:
        {"ok": True, "status": STATUS_*, "raw": {...}}  on a reachable result
        {"ok": False, "error": "<safe>"}  on transport failure (NOT a deny)

    Note: CamRapidPay's status endpoint does not return amount/currency, so
    the caller must verify amount against the internal intent separately.
    """
    cfg = read_config()
    if cfg is None:
        return {"ok": False, "error": "provider_disabled"}
    if not reference:
        return {"ok": False, "error": "invalid_reference"}

    url = f"{cfg['base_url']}/check-transaction-api"
    try:
        async with httpx_client_factory() as cli:
            r = await cli.get(
                url,
                params={"api_key": cfg["api_key"], "reference": reference},
                headers={"Accept": "application/json"},
            )
        if r.status_code != 200:
            _log.warning("camrapidpay: status HTTP %s ref=%s", r.status_code, reference)
            return {"ok": False, "error": f"http_{r.status_code}"}
        j = r.json()
        if not isinstance(j, dict):
            return {"ok": False, "error": "bad_response"}
        # success:true + status:Success => paid. success:false => not completed.
        if j.get("success") is True:
            return {"ok": True, "status": _normalize_status(j.get("status")), "raw": _sanitize_raw(j)}
        # success:false means not found / not completed -> treat as pending,
        # NOT an error (the invoice may simply be unpaid yet).
        return {"ok": True, "status": STATUS_PENDING, "raw": _sanitize_raw(j)}
    except Exception as exc:  # noqa: BLE001
        _log.warning("camrapidpay: status exception ref=%s type=%s", reference, type(exc).__name__)
        return {"ok": False, "error": "network_error"}


def _sanitize_raw(j):
    """Return a copy of a provider response with any key-like field removed."""
    if not isinstance(j, dict):
        return {}
    safe = {}
    for k, v in j.items():
        if "api_key" in k.lower() or "secret" in k.lower() or "token" in k.lower():
            continue
        safe[k] = v
    return safe
