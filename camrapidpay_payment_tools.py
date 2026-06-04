# ===========================================================================
# CamRapidPay Points Top Up - EduHub integration tools
#
# Loaded via exec() into server.py's namespace (same pattern as
# payment_bridge.py), so it shares: api, db, log, httpx, require_student,
# _complete_points_payment, _send_topup_push_once, datetime, timezone,
# timedelta, ObjectId.
#
# SECURITY / TRUTH MODEL (non-negotiable):
#   - The webhook is a WAKE-UP TRIGGER ONLY. It never credits from its body.
#   - The ONLY proof of payment is a server-to-server CamRapidPay status call
#     returning Success.
#   - All three trigger paths (webhook, polling, "I've paid") funnel through
#     verify_camrapidpay_payment_and_credit_once(reference).
#   - Crediting is guarded by an ATOMIC find_one_and_update flip so two
#     racing triggers can never both credit (provably once).
#   - Points/amount/currency come from the internal intent (source of truth),
#     never from the frontend or the webhook body.
# ===========================================================================

import os as _cam_os
import sys as _cam_sys
import secrets as _cam_secrets
from decimal import Decimal as _Decimal, InvalidOperation as _InvalidOperation

# Ensure the backend directory (which contains the payment_providers package)
# is importable regardless of the process working directory. This file is
# exec'd into server.py's namespace, so __file__ here is server.py; fall back
# to the current directory if needed.
_cam_pkg_dir = _cam_os.path.dirname(_cam_os.path.abspath(__file__)) if "__file__" in dir() else _cam_os.getcwd()
if _cam_pkg_dir and _cam_pkg_dir not in _cam_sys.path:
    _cam_sys.path.insert(0, _cam_pkg_dir)

from payment_providers import camrapidpay_provider as _cam

_CAM_LOG = log  # reuse server logger

# Dedicated collection for CamRapidPay intents (isolated from ABA intents).
_cam_intents = db["camrapidpay_intents"]
_cam_webhook_log = db["camrapidpay_webhook_log"]


def _cam_httpx_factory():
    """Return an httpx.AsyncClient context manager with safe timeouts."""
    return httpx.AsyncClient(
        timeout=httpx.Timeout(12.0, connect=6.0),
        follow_redirects=True,
    )


def _cam_now():
    return datetime.now(timezone.utc)


def _cam_amount_matches(expected, got) -> bool:
    """Safe decimal compare of two USD amounts (got may be a string)."""
    try:
        e = _Decimal(str(expected))
        g = _Decimal(str(got))
    except (_InvalidOperation, ValueError, TypeError):
        return False
    # Exact match to the cent; CamRapidPay echoes the amount we set.
    return abs(e - g) <= _Decimal("0.001")


async def _cam_load_package(pkg_id):
    """Look up a points package - the SERVER-SIDE source of truth."""
    try:
        doc = await db.payment_settings.find_one({"_id": ObjectId(pkg_id)})
    except Exception:  # noqa: BLE001
        doc = None
    return doc


# ---------------------------------------------------------------------------
# THE one-and-only credit function. Race-proof via atomic status flip.
# ---------------------------------------------------------------------------
async def verify_camrapidpay_payment_and_credit_once(reference: str) -> dict:
    """Verify a payment with CamRapidPay and credit points exactly once.

    Called by: webhook, status polling, and "I've paid - check now".
    Returns a dict describing the resulting state. Never raises.

    TRUTH MODEL (v1.4):
      - The ONLY thing that authorizes a credit is a server-to-server
        CamRapidPay status call returning Success. Webhook body is never
        trusted for crediting OR for blocking.
      - The atomic claim filter accepts pending / paid / expired (v1.4).
        "expired" is included so a legitimately paid intent that was marked
        expired locally before provider confirmation can still be credited
        once via the atomic gate. paid_not_credited is NOT claimable because
        we cannot prove a prior attempt did not already credit at GAS
        (_complete_points_payment is NOT reference-idempotent - Blocker 4).
      - Local expiry (now > expires_at) only marks "expired" when the
        provider does NOT say Success. A late SUCCESS still credits, because
        payment really happened for our unique reference (Blocker 3).
      - Webhook mismatch is audit-only and never moves status, so it can
        never block a real Success (Blocker 1 fix - enforced in the webhook
        handler; this function ignores webhook fields entirely).

    Flow:
      1. Load intent. If already credited -> idempotent no-op.
      2. If manual_review -> return immediately (human must resolve).
      3. If crediting -> return pending (sweep handles stale case).
      4. [expired falls through - v1.4] Server-to-server status check.
      5. If Success -> atomic claim (pending|paid|expired) -> credit once.
      6. If not Success and locally expired -> mark expired.
      7. Otherwise -> still pending.
    """
    intent = await _cam_intents.find_one({"reference": reference})
    if not intent:
        return {"ok": False, "status": "not_found", "credited": False}

    # Already done? Idempotent.
    if intent.get("status") == "credited" or intent.get("credited_at"):
        return {
            "ok": True, "status": "credited", "credited": True,
            "points_added": int(intent.get("base_points", 0)),
            "bonus_points": int(intent.get("bonus_points", 0)),
            "total_points": int(intent.get("total_points", 0)),
        }

    # manual_review: a human must resolve this intent. Auto-processing would
    # risk crediting an outcome that is already under investigation. Terminal.
    if intent.get("status") == "manual_review":
        return {"ok": True, "status": "manual_review", "credited": False}

    # crediting: the atomic claim is held (possibly by another concurrent
    # call or a mid-crash process). Do not call the status API again here;
    # the reconcile sweep handles stale crediting -> manual_review. Return a
    # safe non-blocking response so the caller knows to wait.
    if intent.get("status") == "crediting":
        return {"ok": True, "status": "pending", "credited": False}

    # v1.4 fix: do NOT treat local "expired" as a terminal state before
    # checking the provider. A student may have paid just before the 5-minute
    # window closed, but our local expiry sweep ran first. CamRapidPay is the
    # authority: if it returns Success for our reference, we credit once.
    # If it does NOT return Success and the intent is locally expired, the
    # existing expiry logic below marks it expired.
    # (Previously this block returned immediately for "expired", preventing
    #  any recovery for legitimately paid late intents - Blocker fixed here.)

    # ---- Server-to-server verification: the ONLY proof of payment ----
    status_res = await _cam.check_status(_cam_httpx_factory, reference)
    if not status_res.get("ok"):
        # Transport failure - do NOT change state, let caller / sweep retry.
        return {"ok": False, "status": intent.get("status", "pending"),
                "credited": False, "error": "status_unavailable"}

    prov_status = status_res.get("status")

    # Local expiry check (Blocker 3). Compute once.
    now = _cam_now()
    expired_locally = False
    try:
        exp_raw = intent.get("expires_at", "")
        if exp_raw:
            exp_dt = datetime.fromisoformat(exp_raw)
            if exp_dt.tzinfo is None:
                exp_dt = exp_dt.replace(tzinfo=timezone.utc)
            expired_locally = now > exp_dt
    except Exception:  # noqa: BLE001
        expired_locally = False

    # If the provider explicitly says Expired, OR (not Success AND locally
    # expired), mark expired and stop. A late SUCCESS still credits below.
    if prov_status == _cam.STATUS_EXPIRED or (prov_status != _cam.STATUS_SUCCESS and expired_locally):
        await _cam_intents.update_one(
            {"reference": reference, "status": {"$nin": ["credited"]}, "credited_at": None},
            {"$set": {"status": "expired", "updated_at": now.isoformat()}},
        )
        return {"ok": True, "status": "expired", "credited": False}

    if prov_status != _cam.STATUS_SUCCESS:
        # Still pending and not yet expired - keep waiting.
        return {"ok": True, "status": "pending", "credited": False}

    # ---- Payment verified Success. ATOMIC flip to claim the credit. ----
    # v1.3: only pending|paid are claimable. paid_not_credited is intentionally
    # NOT in this set - it is treated as unknown-outcome (Blocker 4 fix) and
    # must be resolved by a human via manual_review. Allowing claim of an
    # intent that a fake webhook may have nudged is still safe here, but ONLY
    # because we ourselves just verified Success server-to-server.
    # v1.4: include "expired" in the claim filter so a legitimately paid
    # intent that was marked expired locally before the provider confirmed
    # Success can still be credited once (atomic gate still prevents double).
    claimed = await _cam_intents.find_one_and_update(
        {"reference": reference,
         "status": {"$in": ["pending", "paid", "expired"]},
         "credited_at": None},
        {"$set": {"status": "crediting",
                  "verified_at": now.isoformat(),
                  "crediting_at": now.isoformat()}},  # v1.2: stale-recovery marker
    )
    if not claimed:
        # Someone else won the race (or already crediting/credited).
        fresh = await _cam_intents.find_one({"reference": reference})
        already = bool(fresh and (fresh.get("status") == "credited" or fresh.get("credited_at")))
        return {
            "ok": True,
            "status": "credited" if already else (fresh.get("status") if fresh else "pending"),
            "credited": already,
            "points_added": int(fresh.get("base_points", 0)) if fresh else 0,
            "bonus_points": int(fresh.get("bonus_points", 0)) if fresh else 0,
            "total_points": int(fresh.get("total_points", 0)) if fresh else 0,
        }

    # We are the sole winner. Credit via the EXISTING proven once-only path.
    student_id = claimed.get("student_id")
    pkg = {
        "label":        claimed.get("package_label", "KHQR Top-Up"),
        "points":       int(claimed.get("base_points", 0)),
        "bonus_points": int(claimed.get("bonus_points", 0)),
    }
    txn = {
        "transaction_id": claimed.get("reference"),   # stable idempotency base
        "apv":            "",
        "order_id":       claimed.get("reference"),
        "amount":         claimed.get("amount_khr", 0),
        "source":         "camrapidpay",
    }
    # v1.3 Blocker 4 fix: an EXCEPTION here is an UNKNOWN OUTCOME. We cannot
    # tell whether the exception happened before GAS was called (safe) or
    # AFTER GAS already credited (catastrophic if we retry). Because
    # _complete_points_payment is NOT reference-idempotent (it uses a fresh
    # random nonce and has no GAS-side dedup), automatic retry could double-
    # credit. Money-safety rule: unknown outcome MUST go to manual_review so a
    # human verifies the points history / GAS / payment logs and closes it
    # out. credited_at stays null. The atomic claim filter no longer accepts
    # manual_review, so this intent is locked from any auto-retry path.
    try:
        credit_res = await _complete_points_payment(db, student_id, txn, pkg)
    except Exception as _credit_exc:  # noqa: BLE001
        await _cam_intents.update_one(
            {"reference": reference, "credited_at": None},
            {"$set": {"status": "manual_review",
                      "error_message":
                          f"credit_exception_unknown_outcome:{type(_credit_exc).__name__}"[:200],
                      "updated_at": _cam_now().isoformat()}},
        )
        _CAM_LOG.error(
            "camrapidpay: credit raised %s ref=%s -> manual_review "
            "(UNKNOWN OUTCOME; do NOT auto-retry GAS - not reference-idempotent)",
            type(_credit_exc).__name__, reference,
        )
        return {"ok": False, "status": "manual_review", "credited": False}

    if credit_res.get("ok"):
        try:
            await _cam_intents.update_one(
                {"reference": reference},
                {"$set": {
                    "status":       "credited",
                    "credited_at":  _cam_now().isoformat(),
                    "points_added": pkg["points"] + pkg["bonus_points"],
                    "crediting_at": None,  # clear stale marker on success
                }},
            )
        except Exception as _mark_exc:  # noqa: BLE001
            # GAS credited but we could not mark "credited". Do NOT retry the
            # GAS call (not idempotent). The sweep will find this stuck
            # "crediting" intent and route it to manual_review for a human to
            # confirm the single GAS credit and close it out. Log loudly.
            _CAM_LOG.error(
                "camrapidpay: CREDIT SUCCEEDED but mark-credited FAILED ref=%s err=%s "
                "(sweep will route to manual_review; do NOT auto-retry GAS)",
                reference, type(_mark_exc).__name__,
            )
            return {"ok": True, "status": "crediting", "credited": True,
                    "points_added": pkg["points"], "bonus_points": pkg["bonus_points"],
                    "total_points": pkg["points"] + pkg["bonus_points"]}
        _CAM_LOG.info("camrapidpay: credited %s pts to %s ref=%s",
                      pkg["points"] + pkg["bonus_points"], student_id, reference)
        return {
            "ok": True, "status": "credited", "credited": True,
            "points_added": pkg["points"],
            "bonus_points": pkg["bonus_points"],
            "total_points": pkg["points"] + pkg["bonus_points"],
        }

    # v1.3 Blocker 4 fix: an ok:false return is ALSO an UNKNOWN OUTCOME
    # unless the helper can prove it failed pre-credit. Because
    # _complete_points_payment is not reference-idempotent and does not
    # distinguish pre-credit-validation failures from post-GAS-error failures
    # in its return value, we treat ok:false as unknown and route to
    # manual_review. The safer-default rule: only clearly pre-credit
    # validation failures may ever be paid_not_credited; we have no such
    # guarantee from this helper today, so we never set paid_not_credited
    # from this code path. credited_at stays null.
    await _cam_intents.update_one(
        {"reference": reference, "credited_at": None},
        {"$set": {"status": "manual_review",
                  "error_message":
                      f"credit_unknown_outcome:{str(credit_res.get('error', ''))[:160]}",
                  "updated_at": _cam_now().isoformat()}},
    )
    _CAM_LOG.error(
        "camrapidpay: verified but credit returned ok:false ref=%s err=%s -> manual_review "
        "(UNKNOWN OUTCOME; do NOT auto-retry GAS - not reference-idempotent)",
        reference, credit_res.get("error"),
    )
    return {"ok": False, "status": "manual_review", "credited": False}


# ---------------------------------------------------------------------------
# Endpoint 1: create intent  (authenticated student)
# ---------------------------------------------------------------------------
from pydantic import BaseModel as _CamPM


class _CamCreateIntent(_CamPM):
    package_id: str


@api.get("/payments/camrapidpay/config")
async def camrapidpay_config():
    """Lightweight config check — no invoice created, no DB write, no auth.

    Returns ``{"enabled": bool, "reason": str}`` so the frontend can show or
    hide the KHQR button without calling create-intent as a probe.

    NOTE on auth: this endpoint is intentionally PUBLIC. It returns only a
    boolean feature flag plus a coarse, non-sensitive reason code — no API
    keys, no callback URLs, no merchant IDs are exposed. Making it public
    eliminates a class of iOS Safari ITP / cross-site cookie failures that
    otherwise silently hides the KHQR button (frontend swallows 401 as
    ``enabled: false``).

    The ``reason`` codes are admin-friendly diagnostics, never secrets:
      * ``"ok"``                – feature is live
      * ``"flag_off"``          – ``CAMRAPIDPAY_ENABLED`` is not ``"true"``
      * ``"missing_api_key"``   – flag is on but ``CAMRAPIDPAY_API_KEY`` is empty
      * ``"missing_base_url"``  – flag is on but ``CAMRAPIDPAY_BASE_URL`` is empty
    """
    import os as _os_diag
    enabled = (_os_diag.environ.get("CAMRAPIDPAY_ENABLED", "false").strip().lower() == "true")
    api_key = _os_diag.environ.get("CAMRAPIDPAY_API_KEY", "").strip()
    base_url = _os_diag.environ.get("CAMRAPIDPAY_BASE_URL", "").strip()
    if not enabled:
        return {"enabled": False, "reason": "flag_off"}
    if not api_key:
        return {"enabled": False, "reason": "missing_api_key"}
    if not base_url:
        return {"enabled": False, "reason": "missing_base_url"}
    # Final sanity: ask the provider helper too (catches anything the helper
    # may add in the future). Still no secrets leaked.
    if not _cam.is_enabled():
        return {"enabled": False, "reason": "provider_disabled"}
    return {"enabled": True, "reason": "ok"}


@api.post("/payments/camrapidpay/create-intent")
async def camrapidpay_create_intent(payload: _CamCreateIntent, student=Depends(require_student)):
    """Create a CamRapidPay KHQR invoice for a points package.

    Student-facing UI labels this 'KHQR Payment'. Amount + points come from
    the package (server-side source of truth); the frontend only sends a
    package_id.
    """
    if not _cam.is_enabled():
        # Dormant - tell frontend to use the existing fallback.
        return {"success": False, "error": "khqr_unavailable", "fallback": True}

    pkg = await _cam_load_package(payload.package_id)
    if not pkg or not pkg.get("active", True):
        raise HTTPException(status_code=404, detail="Package not found")

    amount_khr = int(pkg.get("amount_khr", 0))
    base_points = int(pkg.get("points", 0))
    bonus_points = int(pkg.get("bonus_points", 0))
    total_points = base_points + bonus_points
    if amount_khr <= 0 or total_points <= 0:
        raise HTTPException(status_code=400, detail="Invalid package configuration")

    # CamRapidPay is invoiced in USD (the CamRapidPay Client Portal explicitly
    # asks for "Amount (USD)" and renders the checkout / KHQR invoice in USD).
    # Convert the package KHR price -> USD using a fixed configurable rate.
    #
    # v3 (USD gateway restore, 4000 rate):
    #   - Rate is read from CAMRAPIDPAY_USD_KHR_RATE (default 4000).
    #   - Default is 4000 (not 4100) per product owner instruction.
    #   - If the package has an explicit positive ``amount_usd`` field we
    #     prefer it (lets ops tune individual packages); otherwise we
    #     compute amount_usd = round(amount_khr / rate, 2).
    # Student-facing UI still displays the package in KHR / ៛ — only the
    # provider gateway leg is denominated in USD.
    try:
        _rate_raw = _cam_os.environ.get("CAMRAPIDPAY_USD_KHR_RATE", "4000").strip()
        _khr_per_usd = float(_rate_raw) if _rate_raw else 4000.0
        if _khr_per_usd <= 0:
            _khr_per_usd = 4000.0
    except (ValueError, TypeError):
        _khr_per_usd = 4000.0

    amount_usd_pkg = pkg.get("amount_usd")
    try:
        amount_usd_pkg = float(amount_usd_pkg) if amount_usd_pkg is not None else None
    except (ValueError, TypeError):
        amount_usd_pkg = None
    if amount_usd_pkg is not None and amount_usd_pkg > 0:
        amount_usd = round(amount_usd_pkg, 2)
    else:
        amount_usd = round(amount_khr / _khr_per_usd, 2)
    amount_usd = float(amount_usd)
    if amount_usd <= 0:
        raise HTTPException(status_code=400, detail="Invalid package amount")

    student_id = getattr(student, "clean_id", None) or getattr(student, "student_id", "")
    short_ts = _cam_now().strftime("%m%d%H%M%S")
    rand = _cam_secrets.token_hex(3)
    reference = f"POI-{student_id}-{short_ts}-{rand}"[:50]

    now = _cam_now()
    expires = now + timedelta(minutes=5)  # CamRapidPay expiry

    cfg = _cam.read_config()
    base_webhook = cfg.get("callback_url") or "https://eduhub-backend-td3a.onrender.com/api/payments/camrapidpay/webhook"
    secret = cfg.get("webhook_secret", "")
    webhook_url = f"{base_webhook}?token={secret}" if secret else base_webhook
    # Append the internal intent ID to the return URL so the frontend can
    # recover the pending intent after CamRapidPay redirects the student back.
    # The intent_id is not a secret - it is a MongoDB ObjectId used only as
    # a lookup key. Crediting is always decided by server-to-server status
    # check, never by the URL alone.
    _return_base = (cfg.get("return_url") or "").rstrip("/")
    # success_url is set after insert, so we build a placeholder here and
    # update it after insert. Use a sentinel to defer.
    success_url = _return_base  # will be updated below with intent id

    # Insert internal pending intent FIRST (so a fast webhook can find it).
    intent_doc = {
        "provider":            "camrapidpay",
        "student_id":          student_id,
        "package_id":          payload.package_id,
        "package_label":       pkg.get("label", "KHQR Top-Up"),
        "amount":              amount_usd,
        "amount_khr":          amount_khr,
        "currency":            "USD",
        "base_points":         base_points,
        "bonus_points":        bonus_points,
        "total_points":        total_points,
        "reference":           reference,
        "internal_order_id":   reference,
        "provider_invoice_id": "",
        "status":              "pending",
        "credited_at":         None,
        "created_at":          now.isoformat(),
        "expires_at":          expires.isoformat(),
        "raw_provider_response": {},
        "raw_webhook_payload": {},
        "idempotency_key":     reference,
        "error_message":       "",
    }
    ins = await _cam_intents.insert_one(intent_doc)

    # Call CamRapidPay to create the invoice.
    # Now that we have the inserted_id, build the final success_url.
    # CamRapidPay redirects the student's browser to this URL after payment.
    # The ?khqr_intent= param lets the frontend recover the pending intent
    # if the student's original tab was refreshed or closed.
    if _return_base:
        success_url = f"{_return_base}?khqr_intent={str(ins.inserted_id)}"
    else:
        success_url = ""

    created = await _cam.create_payment(
        _cam_httpx_factory, amount_usd, reference, success_url, webhook_url,
    )
    if not created.get("ok"):
        await _cam_intents.update_one(
            {"_id": ins.inserted_id},
            {"$set": {"status": "failed", "error_message": str(created.get("error", ""))[:200]}},
        )
        raise HTTPException(status_code=502, detail="Could not create KHQR payment. Please try again.")

    await _cam_intents.update_one(
        {"_id": ins.inserted_id},
        {"$set": {
            "provider_invoice_id":   created.get("bill_number", ""),
            "raw_provider_response": created.get("raw", {}),
        }},
    )

    return {
        "success":            True,
        "payment_intent_id":  str(ins.inserted_id),
        "provider":           "camrapidpay",
        "provider_invoice_id": created.get("bill_number", ""),
        "reference":          reference,
        # v3: ``amount`` remains the USD gateway amount (back-compat with any
        # existing consumer); ``amount_khr`` is what the student-facing
        # KHQR/Bakong screen renders. ``currency`` stays USD because that is
        # the currency the CamRapidPay invoice is denominated in.
        "amount":             amount_usd,
        "amount_khr":         amount_khr,
        "amount_usd":         amount_usd,
        "currency":           "USD",
        "payment_url":        created.get("payment_url", ""),
        "qr_code":            created.get("qr_code", ""),
        "expires_at":         expires.isoformat(),
        "base_points":        base_points,
        "bonus_points":       bonus_points,
        "total_points":       total_points,
    }


# ---------------------------------------------------------------------------
# Endpoint 2: webhook  (public + token filter; trigger only, never proof)
# ---------------------------------------------------------------------------
@api.post("/payments/camrapidpay/webhook")
async def camrapidpay_webhook(request: Request):
    """CamRapidPay payment notification. WAKE-UP TRIGGER ONLY.

    This endpoint NEVER credits from the webhook body. It records the raw
    payload, then calls the server-to-server verify-and-credit-once function,
    which is the only thing that can authorize a credit.
    """
    cfg = _cam.read_config()
    # Defense-in-depth token filter (NOT proof - just rejects random junk).
    if cfg and cfg.get("webhook_secret"):
        token = request.query_params.get("token", "")
        if token != cfg["webhook_secret"]:
            _CAM_LOG.warning("camrapidpay: webhook rejected - bad token")
            raise HTTPException(status_code=403, detail="forbidden")

    try:
        body = await request.json()
    except Exception:  # noqa: BLE001
        body = {}

    reference = str(body.get("reference", "")).strip()
    # Audit log every webhook regardless of outcome.
    try:
        await _cam_webhook_log.insert_one({
            "reference":   reference,
            "received_at": _cam_now().isoformat(),
            "payload":     body,
        })
    except Exception:  # noqa: BLE001
        pass

    if not reference:
        return {"received": True}

    # v1.1 Blocker 1 fix: the webhook body is AUDIT-ONLY. A webhook is
    # unsigned, so a fake/malformed one must NEVER move the intent's status
    # (it could otherwise push a real, payable intent into a blocked state
    # that the atomic credit gate refuses). We record the webhook and any
    # amount/currency discrepancy as plain audit FIELDS, then let the trusted
    # server-to-server status check decide everything.
    intent = await _cam_intents.find_one({"reference": reference})
    if intent:
        wh_amount = body.get("amount")
        wh_currency = str(body.get("currency", "USD")).upper()
        amount_ok = _cam_amount_matches(intent.get("amount", 0), wh_amount)
        currency_ok = (wh_currency == str(intent.get("currency", "USD")).upper())
        audit_set = {"raw_webhook_payload": body}
        if not (amount_ok and currency_ok):
            # Audit ONLY - does NOT change status, does NOT block crediting.
            audit_set["webhook_mismatch"] = True
            audit_set["webhook_mismatch_reason"] = (
                f"amount got={wh_amount} expected={intent.get('amount')} "
                f"currency got={wh_currency} expected={intent.get('currency')}"
            )[:200]
            _CAM_LOG.warning("camrapidpay: webhook mismatch (audit only) ref=%s", reference)
        else:
            audit_set["webhook_mismatch"] = False
        await _cam_intents.update_one(
            {"reference": reference},
            {"$set": audit_set},
        )

    # The webhook is only a WAKE-UP trigger. Crediting is decided solely by
    # the trusted server-to-server status check inside this function.
    await verify_camrapidpay_payment_and_credit_once(reference)
    return {"received": True}


# ---------------------------------------------------------------------------
# Endpoint 3: status  (authenticated student; can also credit after Success)
# ---------------------------------------------------------------------------
@api.get("/payments/camrapidpay/status/{payment_intent_id}")
async def camrapidpay_status(payment_intent_id: str, student=Depends(require_student)):
    """Student-facing status check. Credits once if verified Success."""
    try:
        intent = await _cam_intents.find_one({"_id": ObjectId(payment_intent_id)})
    except Exception:  # noqa: BLE001
        intent = None
    if not intent:
        raise HTTPException(status_code=404, detail="Payment not found")

    # Ownership: a student can only check their own intent.
    student_id = getattr(student, "clean_id", None) or getattr(student, "student_id", "")
    if intent.get("student_id") != student_id:
        raise HTTPException(status_code=403, detail="forbidden")

    # Already credited -> return immediately.
    if intent.get("status") == "credited" or intent.get("credited_at"):
        return {
            "success": True, "status": "credited", "credited": True,
            "points_added": int(intent.get("base_points", 0)),
            "bonus_points": int(intent.get("bonus_points", 0)),
            "total_points": int(intent.get("total_points", 0)),
        }

    # Otherwise verify (this may credit if CamRapidPay says Success).
    res = await verify_camrapidpay_payment_and_credit_once(intent.get("reference", ""))
    return {
        "success": True,
        "status":  res.get("status", "pending"),
        "credited": bool(res.get("credited")),
        "points_added": int(res.get("points_added", 0)),
        "bonus_points": int(res.get("bonus_points", 0)),
        "total_points": int(res.get("total_points", 0)),
    }


# ---------------------------------------------------------------------------
# Reconciliation sweep: catch lost webhooks AND lost client polls.
# Re-verifies still-pending intents inside their window. Registered as a
# background task on startup so no paid student is ever left uncredited.
# ---------------------------------------------------------------------------
# v1.2: how long an intent may sit in "crediting" before the sweep treats it
# as stale (a crash between the atomic flip and the terminal state).
_CAM_CREDITING_STALE_SECONDS = 180  # 3 minutes


async def _camrapidpay_recover_stale_crediting():
    """Route stale 'crediting' intents to manual_review. Never raises.

    A 'crediting' intent means we atomically claimed it and were about to (or
    did) call GAS sendPoints. Because _complete_points_payment is NOT
    idempotent for the same reference (it uses a random nonce, no
    reference-based dedup at GAS), we must NOT auto-retry a stale 'crediting'
    intent - a retry could double-credit if GAS actually succeeded before the
    crash. Instead we mark manual_review with credited_at still null so a human
    confirms whether the single GAS credit happened, then closes it out.
    """
    if not _cam.is_enabled():
        return
    now = _cam_now()
    cutoff = (now - timedelta(seconds=_CAM_CREDITING_STALE_SECONDS)).isoformat()
    try:
        cursor = _cam_intents.find({
            "provider": "camrapidpay",
            "status":   "crediting",
            "credited_at": None,
            "crediting_at": {"$lt": cutoff},
        }).limit(25)
        stale = [d.get("reference") async for d in cursor if d.get("reference")]
    except Exception:  # noqa: BLE001
        stale = []
    for ref in stale:
        try:
            # Atomic, conservative: only flip if still stuck and not credited.
            res = await _cam_intents.update_one(
                {"reference": ref, "status": "crediting", "credited_at": None},
                {"$set": {"status": "manual_review",
                          "error_message": "stale_crediting_recovered: needs human "
                                            "confirmation of single GAS credit (not auto-retried "
                                            "because GAS credit is not reference-idempotent)",
                          "updated_at": _cam_now().isoformat()}},
            )
            if getattr(res, "modified_count", 0):
                _CAM_LOG.error("camrapidpay: stale crediting ref=%s -> manual_review", ref)
        except Exception:  # noqa: BLE001
            pass


async def _camrapidpay_recover_legacy_paid_not_credited():
    """Route any pre-v1.3 paid_not_credited intents to manual_review. Never raises.

    Before v1.3, two unsafe code paths could leave intents in
    paid_not_credited (an exception inside _complete_points_payment, and an
    ok:false return). Both are now treated as UNKNOWN OUTCOMES and routed
    directly to manual_review at the moment of failure. Any rows still in
    paid_not_credited on disk are legacy pre-v1.3 rows that we cannot prove
    safe to auto-retry, because _complete_points_payment is not reference-
    idempotent. This sweep moves them to manual_review so a human verifies
    whether the prior attempt actually credited at GAS before closing them.
    """
    if not _cam.is_enabled():
        return
    try:
        cursor = _cam_intents.find({
            "provider": "camrapidpay",
            "status":   "paid_not_credited",
            "credited_at": None,
        }).limit(25)
        refs = [d.get("reference") async for d in cursor if d.get("reference")]
    except Exception:  # noqa: BLE001
        refs = []
    for ref in refs:
        try:
            res = await _cam_intents.update_one(
                {"reference": ref, "status": "paid_not_credited", "credited_at": None},
                {"$set": {"status": "manual_review",
                          "error_message": "legacy_paid_not_credited_unknown_outcome:"
                                            "needs human confirmation of single GAS credit "
                                            "(not auto-retried because GAS credit is not "
                                            "reference-idempotent)",
                          "updated_at": _cam_now().isoformat()}},
            )
            if getattr(res, "modified_count", 0):
                _CAM_LOG.error(
                    "camrapidpay: legacy paid_not_credited ref=%s -> manual_review "
                    "(v1.3 money-safety: UNKNOWN OUTCOME, no auto-retry)",
                    ref,
                )
        except Exception:  # noqa: BLE001
            pass


async def _camrapidpay_reconcile_once():
    """Re-verify pending intents, recover stale crediting, migrate legacy
    paid_not_credited. Never raises."""
    if not _cam.is_enabled():
        return
    now_iso = _cam_now().isoformat()
    # 1) Re-verify still-open intents within their window (lost webhook/poll).
    #    v1.3: paid_not_credited is no longer included here. It is treated as
    #    UNKNOWN OUTCOME and handled by step 3 below (legacy migration), not
    #    by a verify-and-retry call that could risk double-credit.
    try:
        cursor = _cam_intents.find({
            "provider": "camrapidpay",
            "status":   {"$in": ["pending", "paid"]},
            "expires_at": {"$gt": now_iso},
            "credited_at": None,
        }).limit(25)
        refs = [d.get("reference") async for d in cursor if d.get("reference")]
    except Exception:  # noqa: BLE001
        refs = []
    for ref in refs:
        try:
            await verify_camrapidpay_payment_and_credit_once(ref)
        except Exception:  # noqa: BLE001
            pass
    # 2) Recover stale 'crediting' intents (crash recovery) -> manual_review.
    await _camrapidpay_recover_stale_crediting()
    # 3) v1.3: migrate any legacy paid_not_credited rows -> manual_review.
    await _camrapidpay_recover_legacy_paid_not_credited()
