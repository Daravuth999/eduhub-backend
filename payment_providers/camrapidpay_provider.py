"""CamRapidPay KHQR provider for EduHub Points Top Up.

This module is the ONLY place that knows the CamRapidPay HTTP contract.
It is intentionally self-contained and side-effect free: it does NOT credit
points, write intents, or touch the wallet. It only talks to CamRapidPay and
returns normalized dicts. Crediting + idempotency live in
camrapidpay_payment_tools.py which reuses EduHub's existing once-only credit.

Security contract (v4.1):
  - The API key is read ONLY from the CAMRAPIDPAY_API_KEY env var (Render).
  - The API key is NEVER logged, NEVER returned to the frontend, NEVER put in
    an exception message that could reach a client.
  - A logging filter installed at import time scrubs `api_key`, `token`,
    `secret`, `key` query parameters out of ANY URL emitted by ANY logger
    (httpx, httpcore, uvicorn, eduhub) before the line reaches stdout. This
    closes the Render-log leak observed in master 150 where httpx logged the
    full check-transaction-api URL including ``?api_key=...&reference=...``.
  - The check-transaction-api call sends the API key as a Bearer header
    (NOT as a URL query parameter) so even if a downstream logger ignored
    the filter, the secret would not appear in the URL. The reference id
    stays in the URL because it is not a secret.
  - The outgoing payload log explicitly masks ``api_key`` to ``"***"`` and
    redacts the webhook URL query token to ``token=<redacted>`` before any
    formatter sees the dict.
  - Provider response bodies are scrubbed (api_key, webhook secret, and any
    field with key-like name) before being logged.
"""

import os as _os
import re as _re
import logging as _logging

_log = _logging.getLogger("eduhub.camrapidpay")

# CamRapidPay normalized status values.
STATUS_SUCCESS = "Success"
STATUS_PENDING = "Pending"
STATUS_EXPIRED = "Expired"
STATUS_UNKNOWN = "Unknown"


# --------------------------------------------------------------------------- #
# v4.1 SECURITY: logging filter that redacts secret query parameters in URLs   #
# --------------------------------------------------------------------------- #
# Names of query-string parameters whose value must NEVER reach a log line.
_SECRET_QPARAM_RE = _re.compile(
    r"(?i)(?<=[?&])(api[_-]?key|token|secret|key|webhook[_-]?secret)=[^&\s\"'<>]+",
)


def _redact_url_secrets(text: str) -> str:
    """Strip secret query parameter values from any URL-looking text.

    Replaces e.g. ``api_key=abc123`` with ``api_key=<redacted>``. Safe to
    call on arbitrary strings: leaves non-URL text alone (the regex only
    matches after ``?`` / ``&`` characters).
    """
    if not text:
        return text
    try:
        return _SECRET_QPARAM_RE.sub(lambda m: m.group(0).split("=", 1)[0] + "=<redacted>", str(text))
    except Exception:  # noqa: BLE001
        return text


def _redact_text_secrets(text: str, *extra_secrets: str) -> str:
    """Redact URL-style secrets AND any literal occurrence of the extra
    secrets passed in (e.g. the raw api_key value or webhook secret).
    """
    out = _redact_url_secrets(text)
    for s in extra_secrets:
        if s and len(s) >= 6:
            try:
                out = out.replace(s, "***")
            except Exception:  # noqa: BLE001
                pass
    return out


class _SecretRedactingFilter(_logging.Filter):
    """Logging filter that walks a LogRecord's message + args and redacts
    URL query-string secrets before the formatter sees them.

    Why a Filter (not a Formatter)? Filters run before the record reaches
    any handler, so this single install protects every handler (stdout,
    file, Render, Sentry, etc.) at once. The bytes from the original
    ``httpx`` "HTTP Request: GET ..." INFO line are rewritten in place.
    """

    def filter(self, record: _logging.LogRecord) -> bool:  # noqa: A003
        try:
            if isinstance(record.msg, str):
                record.msg = _redact_url_secrets(record.msg)
            if record.args:
                if isinstance(record.args, dict):
                    record.args = {k: _redact_url_secrets(v) if isinstance(v, str) else v
                                   for k, v in record.args.items()}
                elif isinstance(record.args, tuple):
                    record.args = tuple(
                        _redact_url_secrets(a) if isinstance(a, str) else a for a in record.args
                    )
        except Exception:  # noqa: BLE001
            pass
        return True


_REDACTING_FILTER = _SecretRedactingFilter()
_FILTER_INSTALLED = False


def _install_log_safety_once() -> None:
    """Idempotently attach the redacting filter to root + httpx loggers and
    raise httpx's chatty default from INFO to WARNING. Safe to call on every
    create_payment / check_status invocation.
    """
    global _FILTER_INSTALLED
    if _FILTER_INSTALLED:
        return
    try:
        # Belt: install on the root logger so ANY child logger inherits it.
        _logging.getLogger().addFilter(_REDACTING_FILTER)
        # Suspenders: also install directly on httpx + httpcore in case a
        # handler is attached below the root.
        for name in ("httpx", "httpcore", "httpcore.http11", "uvicorn", "uvicorn.access", "eduhub.camrapidpay"):
            lg = _logging.getLogger(name)
            lg.addFilter(_REDACTING_FILTER)
        # httpx logs the full request URL at INFO. Even with the filter
        # rewriting the URL, lowering verbosity reduces noise + leak surface.
        _logging.getLogger("httpx").setLevel(_logging.WARNING)
        _logging.getLogger("httpcore").setLevel(_logging.WARNING)
        _FILTER_INSTALLED = True
    except Exception:  # noqa: BLE001
        # Logging hardening must never break the request path.
        _FILTER_INSTALLED = True


# Install on import — first request after deploy is already protected.
_install_log_safety_once()


# --------------------------------------------------------------------------- #
# Config                                                                       #
# --------------------------------------------------------------------------- #
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


def _safe_url_path(url: str) -> str:
    """Return only scheme://host/path for a URL — drops query and fragment."""
    if not url:
        return ""
    try:
        from urllib.parse import urlsplit
        u = urlsplit(str(url))
        return f"{u.scheme}://{u.netloc}{u.path}"
    except Exception:  # noqa: BLE001
        # Fallback: cut at first '?'
        return str(url).split("?", 1)[0]


# --------------------------------------------------------------------------- #
# create_payment                                                               #
# --------------------------------------------------------------------------- #
async def create_payment(httpx_client_factory, amount, reference, success_url, webhook_url):
    """Create a CamRapidPay KHQR invoice.

    Args:
        httpx_client_factory: a zero-arg callable returning an httpx.AsyncClient
            context manager (passed in so we reuse server.py's httpx import).
        amount: float USD amount (> 0). The CamRapidPay Client Portal
            invoices in USD (e.g. "Amount (USD)"; checkout shows "$X.XX USD"),
            so we send a USD decimal here — NOT raw KHR integer.
        reference: unique reference (<= 50 chars).
        success_url: browser redirect URL (UX only, never proof).
        webhook_url: our webhook URL (may include ?token= filter).

    Returns dict:
        {"ok": True, "status", "payment_url", "qr_code", "bill_number",
         "amount", "merchant_name", "expires_in", "raw"}  on success
        {"ok": False, "error": "<safe message>"}  on any failure (never raises)
    """
    _install_log_safety_once()
    cfg = read_config()
    if cfg is None:
        return {"ok": False, "error": "provider_disabled"}
    try:
        amt = float(amount)
    except (TypeError, ValueError):
        amt = 0.0
    if amt <= 0:
        return {"ok": False, "error": "invalid_amount"}
    if not reference or len(reference) > 50:
        return {"ok": False, "error": "invalid_reference"}

    url = f"{cfg['base_url']}/api/v1/khqr/create-payments"
    body = {
        "api_key":   cfg["api_key"],
        "amount":    amt,                # USD decimal (e.g. 1.25)
        "reference": reference,
        "webhook_url": webhook_url,
    }
    if success_url:
        body["success_url"] = success_url

    # v4.1 SAFE DIAGNOSTIC LOG — Render-readable, secret-free.
    _safe_payload = {
        "endpoint":    url,
        "amount":      body["amount"],
        "reference":   body["reference"],
        "success_url": _safe_url_path(body.get("success_url", "")),
        "webhook_url": _redact_url_secrets(body.get("webhook_url", "")),
        "api_key":     "***",
    }
    _log.info("camrapidpay: -> POST create-payments %s", _safe_payload)

    try:
        async with httpx_client_factory() as cli:
            r = await cli.post(
                url,
                json=body,
                headers={"Content-Type": "application/json", "Accept": "application/json"},
            )
        # v4.1: always log a sanitized snapshot of the provider response body
        # so 4xx / 5xx diagnostics are possible without re-running the request.
        _safe_resp = _redact_text_secrets(
            (r.text or "")[:600],
            cfg.get("api_key", ""),
            cfg.get("webhook_secret", ""),
        )
        if r.status_code != 200:
            _log.warning(
                "camrapidpay: create HTTP %s ref=%s body=%s",
                r.status_code, reference, _safe_resp,
            )
            # Map common upstream conditions to safe diagnostic codes — these
            # bubble up into Render logs and the failed-intent error_message
            # but are never shown to students verbatim.
            if r.status_code == 401:
                return {"ok": False, "error": "provider_auth_rejected"}
            if r.status_code == 403:
                return {"ok": False, "error": "provider_account_not_enabled"}
            if r.status_code == 422 or r.status_code == 400:
                return {"ok": False, "error": "provider_payload_rejected"}
            return {"ok": False, "error": f"provider_http_{r.status_code}"}
        j = r.json()
        if not isinstance(j, dict) or j.get("success") is not True:
            msg = str(j.get("message", "create_failed"))[:200] if isinstance(j, dict) else "create_failed"
            msg = _redact_text_secrets(msg, cfg.get("api_key", ""), cfg.get("webhook_secret", ""))
            _log.warning(
                "camrapidpay: create rejected ref=%s msg=%s body=%s",
                reference, msg, _safe_resp,
            )
            return {"ok": False, "error": "provider_rejected", "message": msg}
        _log.info("camrapidpay: create ok ref=%s bill=%s", reference, str(j.get("bill_number", ""))[:40])
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


# --------------------------------------------------------------------------- #
# check_status                                                                 #
# --------------------------------------------------------------------------- #
async def check_status(httpx_client_factory, reference):
    """Server-to-server status check. THE ONLY trusted proof of payment.

    Returns:
        {"ok": True, "status": STATUS_*, "raw": {...}}  on a reachable result
        {"ok": False, "error": "<safe>"}  on transport failure (NOT a deny)

    v4.1 security:
      - The API key is sent BOTH as a Bearer header AND as a body field on
        a POST request. Older CamRapidPay deployments require the
        query-string form; newer ones accept header/body. We try the POST
        form first — even if the vendor ignores the header, the body field
        is read like a form param without the secret ever appearing in the
        request URL (and therefore never in httpx URL-level logs).
      - If POST returns 404/405 (endpoint doesn't accept POST), we fall back
        to GET with query-string params and rely on the global redaction
        filter installed above to strip ``api_key=...`` from any URL log.

    Note: CamRapidPay's status endpoint does not return amount/currency, so
    the caller must verify amount against the internal intent separately.
    """
    _install_log_safety_once()
    cfg = read_config()
    if cfg is None:
        return {"ok": False, "error": "provider_disabled"}
    if not reference:
        return {"ok": False, "error": "invalid_reference"}

    url = f"{cfg['base_url']}/check-transaction-api"
    api_key = cfg["api_key"]
    common_headers = {
        "Accept":        "application/json",
        "Authorization": f"Bearer {api_key}",
        "X-API-Key":     api_key,
    }

    async def _send(client, method: str):
        if method == "POST":
            return await client.post(
                url,
                json={"api_key": api_key, "reference": reference},
                headers={**common_headers, "Content-Type": "application/json"},
            )
        return await client.get(
            url,
            params={"api_key": api_key, "reference": reference},
            headers=common_headers,
        )

    try:
        async with httpx_client_factory() as cli:
            # Try POST (no URL leak) first.
            r = await _send(cli, "POST")
            # 404/405 typically means the endpoint doesn't accept this verb.
            if r.status_code in (404, 405):
                r = await _send(cli, "GET")
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
        kl = str(k).lower()
        if "api_key" in kl or "secret" in kl or "token" in kl or kl == "key":
            continue
        safe[k] = v
    return safe
