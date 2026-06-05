# ---------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------
# SMART PAYMENT BRIDGE --- v1.0
# Semi-automatic ABA PayWay Telegram notification processor.
#
# Collections added (NEW --- never touches existing collections):
#   payment_intents       --- pending payment intents (tuition / points purchase)
#   payment_transactions  --- every raw Telegram notification received
#   payment_settings      --- points-rate packages (admin-configurable)
#   payment_audit_log     --- admin approve/reject/manual actions
#
# Endpoints (ALL NEW --- zero existing routes touched):
#   POST /api/payments/intents
#   GET  /api/payments/intents/{intent_id}
#   POST /api/payments/telegram-webhook
#   POST /api/payments/parse-manual          --- fallback: admin pastes message
#   GET  /api/payments/transactions
#   POST /api/payments/transactions/{id}/approve
#   POST /api/payments/transactions/{id}/reject
#   GET  /api/payments/settings/points-packages
#   POST /api/payments/settings/points-packages
#   PATCH /api/payments/settings/points-packages/{pkg_id}
#   DELETE /api/payments/settings/points-packages/{pkg_id}
#   GET  /api/payments/dashboard
#   GET  /api/students/{student_id}/payment-history
#
# Architecture:
#   QR payment --- Telegram bot notification --- POST /telegram-webhook
#   Backend parses amount, payer, trx_id, apv, timestamp
#   Deduplication via (trx_id, apv) unique index
#   Match against open payment_intents (student ID + amount + time window)
#   High confidence  --- auto-complete (update tuition OR credit points via GAS)
#   Medium confidence --- status "review"
#   Low confidence   --- status "unmatched"
#   All transactions stored permanently; admin can approve/reject from Studio
#
# Matching algorithm:
#   Score = (amount_match -- 50) + (student_id_in_ref -- 30) + (time_window -- 20)
#   --- 80  --- HIGH  --- auto-complete
#   40-79 --- MEDIUM --- needs_review
#   < 40  --- LOW   --- unmatched
# ---------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------

import re as _pay_re
import secrets as _pay_secrets
from datetime import datetime, timezone, timedelta
from bson import ObjectId

# ------ Telegram message parser ---------------------------------------------------------------------------------------------------------------------------------------------

_TRX_PATTERN = _pay_re.compile(
    r"([\d,]+(?:\.\d+)?)\s*(?:USD|KHR)?\s*paid\s+by\s+"
    r"([^\(]+?)(?:\s*\([^\)]*\))?\s+on\s+"
    r"([A-Za-z]+\s+\d+,?\s*\d{1,2}:\d{2}\s*[APap][Mm])\s+"
    r"via\s+(.+?)\s+at\s+(.+?)\.\s*Trx\.\s*ID:\s*(\d+),?\s*APV:\s*(\d+)",
    _pay_re.IGNORECASE | _pay_re.DOTALL,
)

_KHR_PATTERN = _TRX_PATTERN

_KHR_PATTERN = _TRX_PATTERN


def _parse_payway_message(text: str) -> dict | None:
    """Parse an ABA PayWay Telegram notification message.

    Handles both USD ($1.00) and KHR (5000---) formats.
    Returns a dict of extracted fields or None if message doesn't match.
    """

    # Detect currency from raw message before regex parsing
    raw_text = (text or "").strip()
    raw_upper = raw_text.upper()
    if "KHR" in raw_upper:
        detected_currency = "KHR"
    elif "$" in raw_text or "USD" in raw_upper:
        detected_currency = "USD"
    else:
        detected_currency = "KHR"
    text = (text or "").strip()

    for pattern, currency in [(_TRX_PATTERN, "USD"), (_KHR_PATTERN, "KHR")]:
        m = pattern.search(text)
        if m:
            amount_str = m.group(1).replace(",", "")
            return {
                "amount":         float(amount_str),
                "currency":       detected_currency,
                "payer_name":     m.group(2).strip(),
                "payer_account":  "",
                "paid_at_raw":    m.group(3).strip(),
                "payment_method": m.group(4).strip() if m.lastindex >= 5 else "ABA PAY",
                "merchant":       m.group(5).strip(),
                "transaction_id": m.group(6).strip(),
                "apv":            m.group(7).strip(),
                "raw_message":    text,
            }
    return None


# ------ Matching logic ------------------------------------------------------------------------------------------------------------------------------------------------------------------------

async def _find_best_intent(db, txn: dict) -> tuple[dict | None, int, str]:
    """Find the safest matching payment intent for a transaction.

    PRODUCTION-SAFE STRICT SINGLE-MATCH ALGORITHM:
    - Only match unexpired pending intents (expires_at > now)
    - Match by exact KHR amount
    - AUTO-CREDIT only if exactly ONE unexpired intent matches
    - If ZERO matches: unmatched -> needs_review
    - If MULTIPLE matches: ambiguous -> needs_review (never guess)
    - This prevents cross-student mis-credit when 2 students pay same amount simultaneously

    Returns (intent_doc, confidence_score, match_reason).
    """
    now = datetime.now(timezone.utc)
    txn_amount = float(txn.get("amount", 0))

    # Query ONLY unexpired pending intents
    all_pending = await db.payment_intents.find(
        {"status": "pending"}
    ).sort("created_at", 1).to_list(500)

    # Filter: must be unexpired AND exact amount match
    unexpired_matches = []
    for intent in all_pending:
        # Check not expired
        expires_at_str = intent.get("expires_at", "")
        if expires_at_str:
            try:
                exp = datetime.fromisoformat(expires_at_str)
                if exp.tzinfo is None:
                    exp = exp.replace(tzinfo=timezone.utc)
                if exp < now:
                    continue  # expired - skip
            except Exception:
                pass

        # Check exact KHR amount match
        intent_khr = float(intent.get("amount_khr", 0) or intent.get("amount", 0))
        if intent_khr > 0 and abs(intent_khr - txn_amount) < 1:
            unexpired_matches.append(intent)

    # Auto-expire any pending intents that are past their expires_at
    # This cleans up stale sessions from previous logins/refreshes
    for intent in all_pending:
        exp_str = intent.get("expires_at", "")
        if exp_str:
            try:
                exp = datetime.fromisoformat(exp_str)
                if exp.tzinfo is None:
                    exp = exp.replace(tzinfo=timezone.utc)
                if exp < now:
                    await db.payment_intents.update_one(
                        {"_id": intent["_id"], "status": "pending"},
                        {"$set": {"status": "expired", "expired_reason": "session_timeout"}}
                    )
            except Exception:
                pass

    log.info("match_strict: txn_amount=%.0f unexpired_exact_matches=%d",
             txn_amount, len(unexpired_matches))

    if len(unexpired_matches) == 0:
        return None, 0, "no_unexpired_intent_for_amount"

    if len(unexpired_matches) == 1:
        # SAFE: exactly one student waiting for this exact amount
        intent = unexpired_matches[0]
        log.info("match_strict: SAFE single match -> student=%s intent=%s",
                 intent.get("student_id"), str(intent.get("_id")))
        return intent, 80, "single_unexpired_exact_amount"

    # UNSAFE: multiple students waiting for same amount - do not guess
    log.warning("match_strict: AMBIGUOUS %d intents for amount=%.0f -> needs_review",
                len(unexpired_matches), txn_amount)
    # Return the oldest intent at low confidence -> needs_review
    return unexpired_matches[0], 40, f"ambiguous_{len(unexpired_matches)}_intents_same_amount"

async def _find_best_intent_UNUSED(db, txn: dict) -> tuple[dict | None, int, str]:
    """DEPRECATED - kept for reference only"""
    now = datetime.now(timezone.utc)
    window_start = now - timedelta(hours=6)  # 6-hour window

    # Query open intents created in the last 6 hours
    open_intents = await db.payment_intents.find(
        {
            "status":     "pending",
            "created_at": {"$gte": window_start.isoformat()},
        }
    ).to_list(100)

    best_score = 0
    best_intent = None
    best_reason = "no_match"

    for intent in open_intents:
        score = 0
        reasons = []

        # Amount match (most important --- 50 pts)
        intent_amount = float(intent.get("amount", 0))
        txn_amount = float(txn.get("amount", 0))
        # Also check KHR amount stored directly
        intent_khr = float(intent.get("amount_khr", 0))
        log.info("match_debug: intent_id=%s intent_amount=%s intent_khr=%s txn_amount=%s", str(intent.get("_id")), intent_amount, intent_khr, txn_amount)
        txn_matches = (intent_amount > 0 and abs(intent_amount - txn_amount) < 0.01) or \
                      (intent_khr > 0 and abs(intent_khr - txn_amount) < 1)
        if txn_matches:
            score += 50
            reasons.append("amount_exact")
        elif intent_amount > 0 and abs(intent_amount - txn_amount) / max(intent_amount,1) < 0.5:
            score += 35
            reasons.append("amount_near")

        # Student ID or reference in payer_name / payer_account (30 pts)
        student_id = (intent.get("student_id") or "").lower()
        ref_code   = (intent.get("reference_code") or "").lower()
        payer_name = (txn.get("payer_name") or "").lower()
        payer_acct = (txn.get("payer_account") or "").lower()
        raw_msg    = (txn.get("raw_message") or "").lower()

        if student_id and student_id in raw_msg:
            score += 30
            reasons.append("student_id_in_message")
        if ref_code and ref_code in raw_msg:
            score += 30
            reasons.append("ref_code_in_message")

        # Time window match --- intent created before payment (20 pts)
        intent_created = intent.get("created_at", "")
        if intent_created:
            try:
                ic = datetime.fromisoformat(intent_created)
                if ic.tzinfo is None:
                    ic = ic.replace(tzinfo=timezone.utc)
                # Payment should come AFTER intent creation, within 6 hours
                if timedelta(0) <= (now - ic) <= timedelta(hours=6):
                    score += 20
                    reasons.append("time_window_ok")
            except Exception:
                pass

        if score > best_score:
            best_score = score
            best_intent = intent
            best_reason = ",".join(reasons)

    return best_intent, best_score, best_reason


# ------ Pydantic models for payments ------------------------------------------------------------------------------------------------------------------------------

from pydantic import BaseModel as _PM

class PaymentIntentCreate(_PM):
    type:       str           # "tuition" | "points"
    student_id: str
    amount:     float         # amount (KHR or USD)
    amount_khr: int | None = None  # explicit KHR amount for matching
    currency:   str = "USD"
    pkg_id:     str | None = None   # for points purchase: package id

class TelegramWebhookPayload(_PM):
    message: str              # raw Telegram message text
    secret: str | None = None  # X-Payment-Secret forwarded by listener

class ManualParsePayload(_PM):
    message: str              # admin pastes the notification

class TransactionApprovePayload(_PM):
    intent_type: str | None = None  # override: "tuition" | "points"
    student_id:  str | None = None  # override: assign to this student
    note:        str | None = None

class TransactionRejectPayload(_PM):
    reason: str | None = None

class PointsPackageCreate(_PM):
    label:               str
    # v4 (USD packages): amount_usd is the PRIMARY price. amount_khr is kept
    # optional + auto-derived for backward compatibility with the ABA / manual
    # matching path which still keys on amount_khr. If neither is supplied,
    # the create endpoint rejects the request.
    amount_usd:          float | None = None
    amount_khr:          int   | None = None
    points:              int
    bonus_points:        int = 0
    min_purchase:        int = 0
    max_purchase:        int = 0
    active:              bool = True
    notes:               str | None = None
    payment_link:        str | None = None
    discount_pct:        int = 0
    discount_label:      str | None = None
    discount_active:     bool = False
    discount_expires_at: str | None = None
    payment_link:   str | None = None

class PointsPackagePatch(_PM):
    label:               str | None = None
    amount_usd:          float | None = None
    amount_khr:          int   | None = None
    points:              int | None = None
    discount_pct:        int | None = None
    discount_label:      str | None = None
    discount_active:     bool | None = None
    discount_expires_at: str | None = None
    bonus_points:   int | None = None
    min_purchase:   int | None = None
    max_purchase:   int | None = None
    active:         bool | None = None
    notes:          str | None = None
    payment_link:   str | None = None


# v4 (USD packages) — single source of truth for KHR<->USD on payment packages.
# Default rate is 4000 KHR / 1 USD (NOT 4100); identical to the CamRapidPay
# gateway rate used by camrapidpay_payment_tools.py. The env var is shared so
# operators only have to tune one place.
import os as _v4_pkg_os

def _v4_pkg_rate() -> float:
    """Return the active KHR-per-USD rate (defaults to 4000.0)."""
    try:
        raw = _v4_pkg_os.environ.get("CAMRAPIDPAY_USD_KHR_RATE", "4000").strip()
        r = float(raw) if raw else 4000.0
        return r if r > 0 else 4000.0
    except (ValueError, TypeError):
        return 4000.0


def _v4_normalize_pkg_amounts(d: dict) -> dict:
    """Ensure a package doc has BOTH `amount_usd` (float) and `amount_khr` (int).

    - If amount_usd is missing/<=0 but amount_khr is present, derive
      amount_usd = round(amount_khr / rate, 2).
    - If amount_khr is missing/<=0 but amount_usd is present, derive
      amount_khr = round(amount_usd * rate).
    - If both are present, keep them as authored (admin may have priced a
      package slightly off-rate intentionally — we never silently rewrite).
    Mutates and returns ``d``. Safe to call on a Mongo document or a
    pydantic .model_dump() dict. Never raises.
    """
    rate = _v4_pkg_rate()
    try:
        usd = d.get("amount_usd")
        usd = float(usd) if usd is not None else None
    except (ValueError, TypeError):
        usd = None
    try:
        khr = d.get("amount_khr")
        khr = int(khr) if khr is not None else None
    except (ValueError, TypeError):
        khr = None
    if (usd is None or usd <= 0) and (khr is not None and khr > 0):
        usd = round(khr / rate, 2)
    if (khr is None or khr <= 0) and (usd is not None and usd > 0):
        khr = int(round(usd * rate))
    if usd is not None:
        d["amount_usd"] = float(usd)
    if khr is not None:
        d["amount_khr"] = int(khr)
    return d


# ------ Internal helpers ------------------------------------------------------------------------------------------------------------------------------------------------------------------

async def _complete_tuition_payment(db, student_id: str, txn: dict) -> dict:
    """Auto-complete a tuition payment --- reuses the same GAS call as teacher_update_tuition."""
    import calendar as _cal
    from datetime import date as _date

    def _fmt(d):
        return d.strftime("%Y.%m.%d")

    def _add_one_month(d):
        month = d.month % 12 + 1
        year  = d.year + (1 if d.month == 12 else 0)
        day   = min(d.day, _cal.monthrange(year, month)[1])
        return _date(year, month, day)

    doc = await db.students.find_one(
        {"$or": [{"student_id": student_id}, {"clean_id": student_id}]},
        {"_id": 0, "clean_id": 1, "display_name": 1},
    )
    if not doc:
        return {"ok": False, "error": f"Student {student_id} not found in MongoDB"}

    clean_id = doc["clean_id"]
    today    = _date.today()

    gas_ok = False
    gas_error = "unknown"
    try:
        result = await _update_tuition_in_gas(
            clean_id=clean_id,
            tuition_status="Paid",
            last_payment_date=_fmt(today),
            next_due_date=_fmt(_add_one_month(today)),
            payment_amount=str(round(txn.get("amount", 0), 2)),
        )
        gas_ok = result.get("ok") is True
    except RuntimeError as exc:
        gas_error = str(exc)

    if gas_ok:
        # Fire push notification (fire-and-forget)
        asyncio.create_task(
            _fan_out_push(
                {"studentId": clean_id},
                title="Tuition Payment Confirmed",
                body=f"Payment of {int(txn.get('amount', 0)):,} KHR received. Tuition status updated to Paid.",
                url="/portal/me",
            )
        )
        log.info("payment_bridge: tuition auto-completed for %s (trx=%s)",
                 clean_id, txn.get("transaction_id"))
        return {"ok": True, "clean_id": clean_id}
    else:
        log.warning("payment_bridge: GAS tuition update failed for %s: %s",
                    clean_id, gas_error)
        return {"ok": False, "error": gas_error}


async def _complete_points_payment(db, student_id: str, txn: dict, pkg: dict | None) -> dict:
    """Auto-complete a points purchase --- reuses the GAS sendPoints flow (treasury --- student)."""
    if not pkg:
        return {"ok": False, "error": "No points package found for this transaction"}

    points_to_credit = int(pkg.get("points", 0)) + int(pkg.get("bonus_points", 0))
    if points_to_credit <= 0:
        return {"ok": False, "error": "Package awards 0 points"}

    if not SL_TREASURY_PASSWORD:
        return {"ok": False, "error": "SL_TREASURY_PASSWORD not configured on Render"}

    stu_doc = await db.students.find_one(
        {"$or": [{"student_id": student_id}, {"clean_id": student_id}]},
        {"clean_id": 1, "display_name": 1, "_id": 0},
    )
    if not stu_doc:
        return {"ok": False, "error": f"Student {student_id} not found"}

    clean_id = stu_doc["clean_id"]

    nonce = _pay_secrets.token_hex(12)
    gas_payload = {
        "action":     "sendPoints",
        "id":         SL_TREASURY_ID,
        "password":   SL_TREASURY_PASSWORD,
        "receiverId": clean_id,
        "amount":     str(points_to_credit),
        "nonce":      nonce,
    }
    gas_ok = False
    gas_error = "unknown"
    try:
        async with httpx.AsyncClient(timeout=httpx.Timeout(12.0, connect=6.0), follow_redirects=True) as cli:
            r = await cli.post(GAS_POINTS_LOGIN_URL, data=gas_payload)
            if r.status_code == 200:
                j = r.json()
                if isinstance(j, dict) and j.get("success") is True:
                    gas_ok = True
                else:
                    gas_error = str(j.get("message") or j.get("error") or j)[:200]
            else:
                gas_error = f"HTTP {r.status_code}"
    except Exception as exc:
        gas_error = str(exc)[:200]

    if gas_ok:
        # Phase 2 shadow credit — non-fatal, fire-and-forget.
        # Idempotency key uses stable payment identifiers only.
        # Never use a random nonce — unstable across retries.
        try:
            _trx_id = str(txn.get("transaction_id") or "").strip()
            _apv    = str(txn.get("apv") or "").strip()
            _ord_id = str(txn.get("order_id") or txn.get("tran_id") or "").strip()
            if _trx_id and _apv:
                _p2_ikey = f"shadow:credit:payment:{_trx_id}:{_apv}"
            elif _trx_id:
                _p2_ikey = f"shadow:credit:payment:{_trx_id}"
            elif _ord_id:
                _p2_ikey = f"shadow:credit:payment:ord:{_ord_id}"
            else:
                # No stable ID — skip shadow write and log warning
                _p2_ikey = None
                import logging as _logging
                _logging.getLogger("eduhub.payment_bridge").warning(
                    "payment_bridge: shadow credit skipped — no stable "
                    "idempotency identifier for clean_id=%s", clean_id
                )
            if _p2_ikey:
                from shadow_writer import shadow_credit as _sw_credit
                import asyncio as _asyncio
                _asyncio.create_task(_sw_credit(
                    student_clean_id=clean_id,
                    student_mongo_id="",
                    amount=points_to_credit,
                    source="payment_bridge",
                    idempotency_key=_p2_ikey,
                ))
        except Exception as _sw_exc:  # noqa: BLE001
            import logging as _logging
            _logging.getLogger("eduhub.payment_bridge").warning(
                "payment_bridge: shadow credit hook error (non-fatal): %s",
                str(_sw_exc)[:200],
            )
        # Audit
        await db.points_history.insert_one({
            "student_id":  clean_id,
            "from":        SL_TREASURY_ID,
            "to":          clean_id,
            "delta":       points_to_credit,
            "source":      "payment-bridge-points-purchase",
            "description": f"Points purchase --- {pkg.get('label', '')} via ABA PayWay",
            "granted_by":  "payment_bridge",
            "created_at":  datetime.now(timezone.utc).isoformat(),
        })
        # Idempotent Top-Up push (guards against webhook retries / double-process)
        await _send_topup_push_once(
            txn=txn,
            student_id=clean_id,
            amount_khr=int(txn.get("amount", 0)),
            points_credited=points_to_credit,
            package_label=(pkg.get("label") if pkg else "Top-Up") or "Top-Up",
            trigger="auto",
        )
        log.info("payment_bridge: points auto-credited %d pts to %s (trx=%s)",
                 points_to_credit, clean_id, txn.get("transaction_id"))

        # ── Referral System v1 (additive, non-fatal post-success hook) ──
        # Runs AFTER points have already been credited and the top-up push
        # has been sent. Looks up any pending referral lead linked to this
        # student and credits the referrer if all admin-config conditions
        # pass. The hook is idempotent and double-credit safe (see
        # referral_tools._ref_qualify_and_reward). Never raises.
        try:
            _ref_hook = globals().get("_referral_on_points_purchase_success")
            if _ref_hook:
                _ref_txn_id = str(txn.get("transaction_id") or "").strip()
                _ref_apv    = str(txn.get("apv") or "").strip()
                _ref_ord    = str(txn.get("order_id") or txn.get("tran_id") or "").strip()
                _ref_amt_usd = float(
                    (pkg or {}).get("amount_usd")
                    or txn.get("amount_usd")
                    or 0
                )
                _ref_reference = _ref_txn_id or _ref_ord or _ref_apv or "unknown"
                await _ref_hook(
                    clean_id=clean_id,
                    amount_usd=_ref_amt_usd,
                    payment_reference=_ref_reference,
                )
        except Exception as _ref_hook_exc:  # noqa: BLE001
            log.warning(
                "payment_bridge: referral post-success hook error (non-fatal): %s",
                str(_ref_hook_exc)[:200],
            )

        return {"ok": True, "clean_id": clean_id, "points_credited": points_to_credit}
    else:
        log.warning("payment_bridge: GAS points transfer failed for %s: %s", clean_id, gas_error)
        return {"ok": False, "error": gas_error}


async def _send_topup_push_once(
    *,
    txn: dict,
    student_id: str,
    amount_khr: int,
    points_credited: int,
    package_label: str = "Top-Up",
    trigger: str = "auto",
) -> bool:
    """Idempotently fire the ✅ Top-Up Successful Web Push exactly once per
    payment_transactions row.

    Guarantees:
        * Only sends when student_id and points_credited > 0.
        * Skips silently if the txn already has `push_sent_at` set (so
          duplicate Telegram webhooks / manual approvals after auto-credit /
          retries can never trigger a second buzz on the user's phone).
        * Writes `push_sent_at`, `push_status`, `push_trigger`,
          `credited_points` on the transaction row so the audit trail and
          dashboard stay correct.
        * NEVER raises   push failure is logged and stamped, the payment is
          NOT reversed and points credit is NOT undone.
    """
    if not student_id or points_credited <= 0:
        return False

    txn_oid = txn.get("_id") if isinstance(txn, dict) else None
    now_str = datetime.now(timezone.utc).isoformat()

    # Idempotency check against the live row (not the stale dict argument)
    if txn_oid is not None:
        fresh = await db.payment_transactions.find_one(
            {"_id": txn_oid}, {"push_sent_at": 1, "push_status": 1}
        )
        if fresh and fresh.get("push_sent_at"):
            log.info(
                "topup_push: SKIPPED already-sent txn=%s student=%s trigger=%s",
                str(txn_oid), student_id, trigger,
            )
            return False

    title_en = "✅ Top-Up Successful"
    body_en = (
        f"Your {package_label} payment of {amount_khr:,}៛ was detected. "
        f"+{points_credited} PTS has been credited to your account."
    )

    # Stamp BEFORE firing so concurrent retries cannot race to send twice.
    push_status = "queued"
    push_error: str | None = None
    if txn_oid is not None:
        await db.payment_transactions.update_one(
            {"_id": txn_oid, "push_sent_at": {"$in": [None, ""]}},
            {"$set": {
                "push_sent_at":   now_str,
                "push_status":    push_status,
                "push_trigger":   trigger,
                "credited_points": int(points_credited),
                "updated_at":     now_str,
            }},
            upsert=False,
        )

    # Fire the push   never let push noise propagate.
    try:
        sent, failed = await _fan_out_push(
            {"studentId": student_id},
            title=title_en,
            body=body_en,
            url="/portal/me",
        )
        push_status = "sent" if sent and sent > 0 else "no_subscribers"
        log.info(
            "topup_push: trigger=%s student=%s sent=%s failed=%s txn=%s",
            trigger, student_id, sent, failed, str(txn_oid) if txn_oid else "-",
        )
    except Exception as exc:
        push_status = "failed"
        push_error = str(exc)[:200]
        log.warning(
            "topup_push: FAILED student=%s trigger=%s err=%s   credit NOT reversed",
            student_id, trigger, push_error,
        )

    if txn_oid is not None:
        await db.payment_transactions.update_one(
            {"_id": txn_oid},
            {"$set": {
                "push_status": push_status,
                **({"push_error": push_error} if push_error else {}),
                "updated_at": datetime.now(timezone.utc).isoformat(),
            }},
        )
    return push_status == "sent"


async def _process_transaction(db, txn_id: str) -> dict:
    """Core matching + dispatch logic. Called after a transaction is stored.

    Returns a status string: "completed", "needs_review", "unmatched".
    """
    txn_doc = await db.payment_transactions.find_one({"_id": ObjectId(txn_id)})
    if not txn_doc:
        return {"status": "error", "error": "Transaction not found"}

    intent, score, reason = await _find_best_intent(db, txn_doc)

    if score >= 50 and intent:
        confidence = "high"
        new_status  = "auto_processing"
    elif score >= 40 and intent:
        confidence = "medium"
        new_status  = "needs_review"
    else:
        confidence = "low"
        new_status  = "unmatched"

    update_fields = {
        "match_confidence": confidence,
        "match_score":      score,
        "match_reason":     reason,
        "matched_intent_id": str(intent["_id"]) if intent else None,
        "matched_student_id": intent.get("student_id") if intent else None,
        "matched_intent_type": intent.get("type", "points") if intent else None,
        "status":           new_status,
        "updated_at":       datetime.now(timezone.utc).isoformat(),
    }
    await db.payment_transactions.update_one(
        {"_id": ObjectId(txn_id)},
        {"$set": update_fields},
    )

    if confidence == "high" and intent:
        student_id   = intent.get("student_id", "")
        intent_type  = intent.get("type", "tuition")

        if intent_type == "tuition":
            result = await _complete_tuition_payment(db, student_id, txn_doc)
        elif intent_type == "points":
            pkg_id = intent.get("pkg_id")
            pkg = None
            if pkg_id:
                pkg = await db.payment_settings.find_one({"_id": ObjectId(pkg_id)})
            if not pkg:
                # Fall back: find active package matching amount
                khr_amount = txn_doc.get("amount", 0)
                if txn_doc.get("currency") == "USD":
                    # approximate USD --- KHR for package lookup
                    khr_amount = int(float(txn_doc.get("amount", 0)) * 4100)
                pkg = await db.payment_settings.find_one({"amount_khr": khr_amount, "active": True})
            result = await _complete_points_payment(db, student_id, txn_doc, pkg)
        else:
            result = {"ok": False, "error": f"Unknown intent type: {intent_type}"}

        final_status = "completed" if result.get("ok") else "needs_review"
        await db.payment_transactions.update_one(
            {"_id": ObjectId(txn_id)},
            {"$set": {
                "status":       final_status,
                "completion_result": result,
                "completed_at": datetime.now(timezone.utc).isoformat() if result.get("ok") else None,
            }},
        )
        # Mark intent as completed (with rich audit fields so the student
        # modal can auto-close on its next poll).
        if result.get("ok"):
            now_iso = datetime.now(timezone.utc).isoformat()
            await db.payment_intents.update_one(
                {"_id": intent["_id"]},
                {"$set": {
                    "status":           "completed",
                    "transaction_id":   txn_id,
                    "matched_txn_id":   txn_id,
                    "credited_points":  int(result.get("points_credited") or 0),
                    "completed_at":     now_iso,
                    "manual_approved":  False,
                }},
            )
        return {"status": final_status, "result": result}

    return {"status": new_status, "score": score}


# ------ Routes ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------

# --- Payment Intents ---

@api.post("/payments/intents")
async def create_payment_intent(
    payload: PaymentIntentCreate,
    request: Request,
):
    """Generate a payment intent so the system can match the incoming payment.

    Called by the PWA before the student scans the QR code.
    Returns a unique reference code to show to the student.
    Works for both enrolled students (tuition) and app users (points purchase).
    Does NOT require admin auth --- any authenticated student can create an intent.
    """
    if payload.type not in ("tuition", "points"):
        raise HTTPException(status_code=400, detail="type must be 'tuition' or 'points'")
    if not payload.student_id:
        raise HTTPException(status_code=400, detail="student_id is required")
    if payload.amount <= 0:
        raise HTTPException(status_code=400, detail="amount must be > 0")

    ref_code = f"{payload.type.upper()[:3]}-{payload.student_id}-{datetime.now(timezone.utc).strftime('%Y%m%d%H%M%S')}"
    now      = datetime.now(timezone.utc)
    now_str  = now.isoformat()
    expires  = now + timedelta(minutes=3)

    # ── Lane lock (cross-student safety) ─────────────────────────────────
    # If a DIFFERENT student already holds a live pending points intent for
    # the same KHR amount, refuse to open a second lane. This guarantees
    # that when the Telegram notification arrives the strict single-match
    # algorithm in _find_best_intent has exactly one candidate -> no chance
    # of crediting the wrong student (the original stu094->stu093 bug).
    if payload.type == "points":
        intent_amount_khr = int(payload.amount_khr or int(payload.amount))
        if intent_amount_khr > 0:
            busy = await db.payment_intents.find_one({
                "type":       "points",
                "status":     "pending",
                "amount_khr": intent_amount_khr,
                "student_id": {"$ne": payload.student_id},
                "expires_at": {"$gt": now_str},
            })
            if busy:
                # Compute retry seconds from the busy intent's expires_at
                retry_after = 60
                try:
                    busy_exp = datetime.fromisoformat(busy.get("expires_at", ""))
                    if busy_exp.tzinfo is None:
                        busy_exp = busy_exp.replace(tzinfo=timezone.utc)
                    retry_after = max(5, int((busy_exp - now).total_seconds()))
                except Exception:
                    pass
                log.warning(
                    "payment_bridge: lane_busy student=%s amount_khr=%s held_by=%s retry=%ss",
                    payload.student_id, intent_amount_khr,
                    busy.get("student_id"), retry_after,
                )
                raise HTTPException(
                    status_code=423,
                    detail={
                        "ok": False,
                        "reason": "lane_busy",
                        "message": "Payment session is currently preparing for another learner. Please try again in a moment.",
                        "retry_after_seconds": retry_after,
                    },
                )

    # Lane lock: expire all previous PENDING top-up intents for this student
    # This prevents the same student from having multiple active intents
    if payload.type == "points":
        await db.payment_intents.update_many(
            {"student_id": payload.student_id, "type": "points", "status": "pending"},
            {"$set": {"status": "expired", "expired_reason": "superseded_by_new_intent"}}
        )
        log.info("payment_bridge: expired old pending intents for student=%s", payload.student_id)

    doc = {
        "type":           payload.type,
        "student_id":     payload.student_id,
        "amount":         payload.amount,
        "amount_khr":     payload.amount_khr or int(payload.amount),
        "currency":       payload.currency,
        "pkg_id":         payload.pkg_id,
        "reference_code": ref_code,
        "status":         "pending",
        "created_at":     now_str,
        "expires_at":     expires.isoformat(),
        "session_minutes": 3,
    }
    result = await db.payment_intents.insert_one(doc)
    log.info("payment_bridge: intent created id=%s student=%s amount_khr=%s expires=%s",
             str(result.inserted_id), payload.student_id, doc["amount_khr"], expires.isoformat())
    return {
        "ok":             True,
        "intent_id":      str(result.inserted_id),
        "reference_code": ref_code,
        "expires_at":     expires.isoformat(),
        "session_seconds": 180,
    }


@api.get("/payments/intents/{intent_id}/status")
async def get_payment_intent_status(intent_id: str):
    """Public — student modal polls this every 3 seconds.

    Returns a rich, terminal-aware payload so the frontend can:
      * close automatically on `completed` / `completed_manual`
      * show needs_review / expired states with a manual close button
      * never poll forever
    """
    try:
        oid = ObjectId(intent_id)
    except Exception:
        raise HTTPException(status_code=400, detail="Invalid intent_id")
    doc = await db.payment_intents.find_one({"_id": oid})
    if not doc:
        raise HTTPException(status_code=404, detail="Intent not found")

    now = datetime.now(timezone.utc)
    status = doc.get("status") or "pending"

    # Auto-promote pending -> expired if past expires_at (best-effort).
    if status == "pending":
        exp_str = doc.get("expires_at") or ""
        if exp_str:
            try:
                exp = datetime.fromisoformat(exp_str)
                if exp.tzinfo is None:
                    exp = exp.replace(tzinfo=timezone.utc)
                if exp < now:
                    await db.payment_intents.update_one(
                        {"_id": oid, "status": "pending"},
                        {"$set": {"status": "expired",
                                  "expired_reason": "session_timeout"}}
                    )
                    status = "expired"
                    doc["status"] = "expired"
            except Exception:
                pass

    # ── Try to surface a linked completed transaction even if the intent
    # itself was never written by the auto-credit / manual-approval paths.
    # This makes the student modal close after Author Studio manual approval
    # whenever the related intent record was missed.
    completed_at = doc.get("completed_at")
    transaction_id = doc.get("transaction_id")
    credited_points = doc.get("credited_points")
    matched_student_id = doc.get("student_id")
    manual_approved = bool(doc.get("manual_approved"))

    intent_id_str = str(oid)
    if status in ("pending", "expired"):
        # 1) Look for a completed txn that already records this intent.
        linked = await db.payment_transactions.find_one(
            {
                "$or": [
                    {"matched_intent_id": intent_id_str},
                    {"matched_intent_id": oid},
                ],
                "status": "completed",
            }
        )
        # 2) Otherwise look for a manual-approved txn for the same
        #    student + amount within a 10-minute window AND created
        #    AFTER the intent itself (so an older completed txn from
        #    a previous attempt cannot accidentally heal a fresh intent).
        if not linked:
            try:
                window_start_dt = now - timedelta(minutes=10)
                intent_created = doc.get("created_at") or ""
                lower_bound = window_start_dt.isoformat()
                if intent_created:
                    # Use the later of (intent.created_at, now-10min).
                    try:
                        ic = datetime.fromisoformat(intent_created)
                        if ic.tzinfo is None:
                            ic = ic.replace(tzinfo=timezone.utc)
                        if ic > window_start_dt:
                            lower_bound = ic.isoformat()
                    except Exception:
                        pass
                amount_khr = doc.get("amount_khr") or doc.get("amount") or 0
                cand = await db.payment_transactions.find_one(
                    {
                        "matched_student_id": doc.get("student_id"),
                        "status": "completed",
                        "amount": amount_khr,
                        "updated_at": {"$gte": lower_bound},
                    },
                    sort=[("updated_at", -1)],
                )
                if cand:
                    linked = cand
            except Exception:
                pass

        if linked:
            # Heal the intent record so subsequent polls are O(1).
            credited_points = (
                (linked.get("completion_result") or {}).get("points_credited")
                or doc.get("credited_points")
                or 0
            )
            new_status = "completed_manual" if linked.get("manually_approved") else "completed"
            update_payload = {
                "status":            new_status,
                "transaction_id":    str(linked.get("_id")),
                "matched_txn_id":    str(linked.get("_id")),
                "credited_points":   int(credited_points or 0),
                "manual_approved":   bool(linked.get("manually_approved")),
                "completed_at":      linked.get("completed_at") or now.isoformat(),
            }
            await db.payment_intents.update_one({"_id": oid}, {"$set": update_payload})
            status = new_status
            completed_at = update_payload["completed_at"]
            transaction_id = update_payload["transaction_id"]
            manual_approved = update_payload["manual_approved"]

    # Friendly message per terminal state.
    msg_map = {
        "pending":          "Waiting for payment confirmation.",
        "completed":        "Payment confirmed. Points credited.",
        "completed_manual": "Payment confirmed by reviewer. Points credited.",
        "needs_review":     "Payment is under review. If you already paid, points will be credited shortly.",
        "expired":          "Payment session expired. If you already paid, it will be reviewed shortly.",
    }

    return {
        "ok":                 True,
        "intent_id":          intent_id_str,
        "status":             status,
        "credited_points":    int(credited_points or 0),
        "transaction_id":     transaction_id,
        "matched_student_id": matched_student_id,
        "completed_at":       completed_at,
        "manual_approved":    manual_approved,
        "expires_at":         doc.get("expires_at"),
        "amount_khr":         doc.get("amount_khr") or doc.get("amount"),
        "currency":           doc.get("currency") or "KHR",
        "reference_code":     doc.get("reference_code"),
        "message":            msg_map.get(status, "Status updated."),
    }


@api.get("/payments/intents/{intent_id}")
async def get_payment_intent(intent_id: str, admin: User = Depends(require_admin)):
    """Get a payment intent by ID (admin only)."""
    try:
        doc = await db.payment_intents.find_one({"_id": ObjectId(intent_id)})
    except Exception:
        raise HTTPException(status_code=400, detail="Invalid intent_id")
    if not doc:
        raise HTTPException(status_code=404, detail="Intent not found")
    doc["_id"] = str(doc["_id"])
    return doc


# --- Telegram Webhook (automatic ingestion) ---

@api.post("/payments/telegram-webhook")
async def receive_telegram_webhook(payload: TelegramWebhookPayload, request: Request):
    """Receive a raw PayWay Telegram notification message.

    Intended to be called by a Telegram bot or forwarder automation.
    Optionally protected via PAYMENT_WEBHOOK_SECRET env var, accepted as
    either the JSON body field `secret` OR the `X-Payment-Secret` header.

    Does NOT require admin auth so that the forwarder bot can call it
    without a session cookie.
    """
    webhook_secret = os.environ.get("PAYMENT_WEBHOOK_SECRET", "")
    if webhook_secret:
        provided = (
            payload.secret
            or request.headers.get("x-payment-secret")
            or request.headers.get("X-Payment-Secret")
            or ""
        )
        if not _pay_secrets.compare_digest(provided, webhook_secret):
            log.warning("payment_bridge: webhook rejected - bad secret")
            raise HTTPException(status_code=403, detail="Invalid webhook secret")
    parsed = _parse_payway_message(payload.message)
    if not parsed:
        raise HTTPException(
            status_code=422,
            detail="Could not parse payment notification. Check the message format.",
        )

    return await _ingest_parsed_transaction(parsed)


# --- Manual paste (admin fallback) ---

@api.post("/payments/parse-manual")
async def parse_manual_notification(
    payload: ManualParsePayload,
    admin: User = Depends(require_admin),
):
    """Admin pastes a PayWay notification message --- parse and store.

    This is the fallback when Telegram automation is unavailable.
    """
    parsed = _parse_payway_message(payload.message)
    if not parsed:
        raise HTTPException(
            status_code=422,
            detail="Could not extract payment details from this message. "
                   "Expected format: '$X.XX paid by Name (*NNN) on Month DD, HH:MM PM "
                   "via ABA KHQR at Merchant. Trx. ID: NNNNN, APV: NNNNNN.'",
        )
    return await _ingest_parsed_transaction(parsed)


async def _ingest_parsed_transaction(parsed: dict) -> dict:
    """Store a parsed transaction and trigger matching.

    Deduplication: (transaction_id, apv) composite unique key.
    If already stored, returns the existing record.
    """
    trx_id = parsed.get("transaction_id", "")
    apv    = parsed.get("apv", "")

    existing = await db.payment_transactions.find_one(
        {"transaction_id": trx_id, "apv": apv}
    )
    if existing:
        return {
            "ok":         True,
            "duplicate":  True,
            "txn_id":     str(existing["_id"]),
            "status":     existing.get("status", "unknown"),
            "message":    "Transaction already recorded (duplicate blocked).",
        }

    now_str = datetime.now(timezone.utc).isoformat()
    doc = {
        **parsed,
        "status":     "received",
        "created_at": now_str,
        "updated_at": now_str,
        "match_confidence": None,
        "match_score":      None,
        "matched_intent_id": None,
        "matched_student_id": None,
    }
    result = await db.payment_transactions.insert_one(doc)
    txn_id_str = str(result.inserted_id)

    # Run matching asynchronously (fire-and-forget so webhook returns fast)
    asyncio.create_task(_process_transaction(db, txn_id_str))

    log.info(
        "payment_bridge: received trx_id=%s apv=%s amount=%s %s from %s",
        trx_id, apv, parsed.get("amount"), parsed.get("currency"), parsed.get("payer_name"),
    )
    return {
        "ok":      True,
        "txn_id":  txn_id_str,
        "parsed":  {k: v for k, v in parsed.items() if k != "raw_message"},
        "message": "Transaction received. Matching in progress.",
    }


# --- Transaction listing and manual review ---

@api.get("/payments/transactions")
async def list_transactions(
    status: str | None = None,
    limit: int = 50,
    admin: User = Depends(require_admin),
):
    """List payment transactions. Filter by status for the review queue."""
    query = {}
    if status:
        query["status"] = status
    cursor = db.payment_transactions.find(query, {"raw_message": 0}).sort("created_at", -1).limit(limit)
    docs = await cursor.to_list(limit)
    for d in docs:
        d["_id"] = str(d["_id"])
    return {"ok": True, "transactions": docs, "count": len(docs)}


@api.post("/payments/transactions/{txn_id}/approve")
async def approve_transaction(
    txn_id: str,
    payload: TransactionApprovePayload,
    admin: User = Depends(require_admin),
):
    """Admin manually approves / assigns a transaction that couldn't be auto-matched."""
    try:
        doc = await db.payment_transactions.find_one({"_id": ObjectId(txn_id)})
    except Exception:
        raise HTTPException(status_code=400, detail="Invalid txn_id")
    if not doc:
        raise HTTPException(status_code=404, detail="Transaction not found")

    if doc.get("status") == "completed":
        raise HTTPException(status_code=409, detail="Transaction already completed")

    student_id   = payload.student_id or doc.get("matched_student_id", "")
    # Default to "points" for payment bridge transactions; admin can override
    matched_intent_id = doc.get("matched_intent_id")
    default_type = "tuition"
    if matched_intent_id:
        try:
            from bson import ObjectId as _OID
            mi = await db.payment_intents.find_one({"_id": _OID(matched_intent_id)})
            if mi:
                default_type = mi.get("type", "tuition")
                if not payload.student_id:
                    student_id = mi.get("student_id", student_id)
        except Exception:
            pass
    intent_type  = payload.intent_type or default_type

    if not student_id:
        raise HTTPException(status_code=400, detail="student_id required for manual approval")

    if intent_type == "tuition":
        result = await _complete_tuition_payment(db, student_id, doc)
    elif intent_type == "points":
        # For manual approve, find the package by amount
        amount_khr = int(doc.get("amount", 0))  # amount stored as raw KHR
        pkg = await db.payment_settings.find_one({"amount_khr": amount_khr, "active": True})
        result = await _complete_points_payment(db, student_id, doc, pkg)
    else:
        raise HTTPException(status_code=400, detail="intent_type must be 'tuition' or 'points'")

    now_str = datetime.now(timezone.utc).isoformat()
    final_status = "completed" if result.get("ok") else "needs_review"
    points_credited = int((result.get("points_credited") if isinstance(result, dict) else 0) or 0)
    await db.payment_transactions.update_one(
        {"_id": ObjectId(txn_id)},
        {"$set": {
            "status":            final_status,
            "matched_student_id": student_id,
            "matched_intent_type": intent_type,
            "credited_points":   points_credited,
            "manually_approved": True,
            "approved_by":       admin.email,
            "approved_at":       now_str,
            "completion_result": result,
            "admin_note":        payload.note,
            "completed_at":      now_str if result.get("ok") else None,
            "updated_at":        now_str,
        }},
    )

    # ── Sync the related payment_intent so the student's modal can close ──
    # First try the intent already linked on the txn; if missing, find the
    # newest pending/expired points intent for this student + amount within
    # the last 10 minutes (the modal's window of interest).
    intent_to_close = None
    if matched_intent_id:
        try:
            intent_to_close = await db.payment_intents.find_one(
                {"_id": ObjectId(matched_intent_id)}
            )
        except Exception:
            intent_to_close = None
    if intent_to_close is None and result.get("ok") and intent_type == "points":
        try:
            window_start = (datetime.now(timezone.utc) - timedelta(minutes=10)).isoformat()
            amount_khr = int(doc.get("amount", 0))
            intent_to_close = await db.payment_intents.find_one(
                {
                    "student_id": student_id,
                    "type":       "points",
                    "amount_khr": amount_khr,
                    "status":     {"$in": ["pending", "expired"]},
                    "created_at": {"$gte": window_start},
                },
                sort=[("created_at", -1)],
            )
        except Exception:
            intent_to_close = None
    if intent_to_close is not None and result.get("ok"):
        await db.payment_intents.update_one(
            {"_id": intent_to_close["_id"]},
            {"$set": {
                "status":           "completed_manual",
                "transaction_id":   txn_id,
                "matched_txn_id":   txn_id,
                "credited_points":  points_credited,
                "manual_approved":  True,
                "completed_at":     now_str,
                "approved_by":      admin.email,
            }},
        )
        log.info(
            "payment_bridge: manual approval closed intent=%s student=%s pts=%d",
            str(intent_to_close["_id"]), student_id, points_credited,
        )

    # ── Idempotent ✅ Top-Up Successful push (manual trigger) ──
    if result.get("ok") and intent_type == "points":
        # Re-fetch the txn so the helper sees the freshly stamped row.
        txn_doc = await db.payment_transactions.find_one({"_id": ObjectId(txn_id)})
        pkg_label = "Top-Up"
        try:
            amount_khr = int(doc.get("amount", 0))
            pkg = await db.payment_settings.find_one(
                {"amount_khr": amount_khr, "active": True}
            )
            if pkg and pkg.get("label"):
                pkg_label = pkg.get("label")
        except Exception:
            pass
        await _send_topup_push_once(
            txn=txn_doc or doc,
            student_id=student_id,
            amount_khr=int(doc.get("amount", 0)),
            points_credited=points_credited,
            package_label=pkg_label,
            trigger="manual",
        )

    # Audit log
    await db.payment_audit_log.insert_one({
        "action":     "approve",
        "txn_id":     txn_id,
        "student_id": student_id,
        "type":       intent_type,
        "result":     result,
        "by":         admin.email,
        "note":       payload.note,
        "at":         now_str,
    })
    if not result.get("ok"):
        raise HTTPException(status_code=502, detail=f"Approval failed: {result.get('error')}")
    return {"ok": True, "status": final_status, "result": result}


@api.post("/payments/transactions/{txn_id}/reject")
async def reject_transaction(
    txn_id: str,
    payload: TransactionRejectPayload,
    admin: User = Depends(require_admin),
):
    """Admin rejects / marks a transaction as duplicate or irrelevant."""
    try:
        doc = await db.payment_transactions.find_one({"_id": ObjectId(txn_id)})
    except Exception:
        raise HTTPException(status_code=400, detail="Invalid txn_id")
    if not doc:
        raise HTTPException(status_code=404, detail="Transaction not found")

    now_str = datetime.now(timezone.utc).isoformat()
    await db.payment_transactions.update_one(
        {"_id": ObjectId(txn_id)},
        {"$set": {
            "status":       "rejected",
            "rejected_by":  admin.email,
            "rejected_at":  now_str,
            "reject_reason": payload.reason,
            "updated_at":   now_str,
        }},
    )
    await db.payment_audit_log.insert_one({
        "action": "reject",
        "txn_id": txn_id,
        "reason": payload.reason,
        "by":     admin.email,
        "at":     now_str,
    })
    return {"ok": True, "status": "rejected"}


# --- Points packages (conversion rate settings) ---

@api.get("/payments/packages/public")
async def list_points_packages_public():
    """Public read-only endpoint - returns active packages only. No auth required.

    v4 (USD packages):
      - Every returned package is normalised so BOTH ``amount_usd`` (float)
        and ``amount_khr`` (int) are present, regardless of which the admin
        authored. Frontend modal renders USD; ABA/manual matching still uses
        amount_khr.
      - Sort is performed in Python on the normalised amount_usd to keep
        legacy KHR-only docs and new USD-only docs in the same order.
    """
    from datetime import datetime, timezone as _tz
    now = datetime.now(_tz.utc)
    docs = await db.payment_settings.find({"active": True}).to_list(100)
    for d in docs:
        d["_id"] = str(d["_id"])
        _v4_normalize_pkg_amounts(d)
        pct = int(d.get("discount_pct", 0) or 0)
        on  = bool(d.get("discount_active", False))
        exp = d.get("discount_expires_at")
        if exp:
            try:
                e = datetime.fromisoformat(exp)
                if e.tzinfo is None: e = e.replace(tzinfo=_tz.utc)
                if e < now: on = False
            except Exception: pass
        orig_khr = int(d.get("amount_khr", 0) or 0)
        orig_usd = float(d.get("amount_usd", 0) or 0.0)
        if on and pct > 0:
            d["discount_active_live"] = True
            # KHR-side legacy fields kept for any existing consumer.
            d["discounted_amount_khr"] = max(100, int(orig_khr * (1 - pct / 100))) if orig_khr else 0
            d["original_amount_khr"]   = orig_khr
            # USD-side discounted fields for the v4 USD-native modal.
            d["discounted_amount_usd"] = round(orig_usd * (1 - pct / 100), 2) if orig_usd > 0 else 0.0
            d["original_amount_usd"]   = orig_usd
        else:
            d["discount_active_live"] = False
            d["discounted_amount_khr"] = orig_khr
            d["original_amount_khr"]   = orig_khr
            d["discounted_amount_usd"] = orig_usd
            d["original_amount_usd"]   = orig_usd
    docs.sort(key=lambda x: (float(x.get("amount_usd") or 0.0), int(x.get("amount_khr") or 0)))
    return {"ok": True, "packages": docs}


@api.get("/payments/settings/points-packages")
async def list_points_packages(admin: User = Depends(require_admin)):
    """List all points conversion packages.

    v4 (USD packages): every doc is normalised so both ``amount_usd`` and
    ``amount_khr`` are present in the admin payload, and the list is sorted
    by USD. Author Studio renders the USD field.
    """
    docs = await db.payment_settings.find({}).to_list(100)
    for d in docs:
        d["_id"] = str(d["_id"])
        _v4_normalize_pkg_amounts(d)
    docs.sort(key=lambda x: (float(x.get("amount_usd") or 0.0), int(x.get("amount_khr") or 0)))
    return {"ok": True, "packages": docs}


@api.post("/payments/settings/points-packages")
async def create_points_package(
    payload: PointsPackageCreate,
    admin: User = Depends(require_admin),
):
    """Create a new points conversion package.

    v4 (USD packages): admin may submit ``amount_usd`` (preferred),
    ``amount_khr`` (legacy), or both. The missing field is auto-derived using
    the shared CamRapidPay rate (default 4000 KHR / 1 USD) so the ABA /
    manual matching path which still keys on amount_khr keeps working.
    """
    raw = payload.model_dump()
    _v4_normalize_pkg_amounts(raw)
    if not (raw.get("amount_usd") and raw.get("amount_usd") > 0):
        raise HTTPException(
            status_code=400,
            detail="amount_usd or amount_khr must be provided and positive",
        )
    now_str = datetime.now(timezone.utc).isoformat()
    doc = {
        **raw,
        "created_by": admin.email,
        "created_at": now_str,
        "updated_at": now_str,
    }
    result = await db.payment_settings.insert_one(doc)
    return {"ok": True, "pkg_id": str(result.inserted_id)}


@api.patch("/payments/settings/points-packages/{pkg_id}")
async def update_points_package(
    pkg_id: str,
    payload: PointsPackagePatch,
    admin: User = Depends(require_admin),
):
    """Update a points package (partial update).

    v4 (USD packages): if the admin updates only one of ``amount_usd`` /
    ``amount_khr``, derive the other from the active rate before saving so
    the two fields never drift out of sync on disk.
    """
    try:
        oid = ObjectId(pkg_id)
    except Exception:
        raise HTTPException(status_code=400, detail="Invalid pkg_id")

    # Use exclude_unset to keep False/0 values but skip truly unset fields
    updates = {k: v for k, v in payload.model_dump(exclude_unset=True).items()}
    if not updates:
        raise HTTPException(status_code=400, detail="No fields to update")

    # v4: cross-derive amount_khr / amount_usd if only one was edited.
    if ("amount_usd" in updates) ^ ("amount_khr" in updates):
        _v4_normalize_pkg_amounts(updates)

    updates["updated_at"] = datetime.now(timezone.utc).isoformat()
    updates["updated_by"] = admin.email

    result = await db.payment_settings.update_one({"_id": oid}, {"$set": updates})
    if result.matched_count == 0:
        raise HTTPException(status_code=404, detail="Package not found")
    return {"ok": True}


@api.delete("/payments/settings/points-packages/{pkg_id}")
async def delete_points_package(
    pkg_id: str,
    admin: User = Depends(require_admin),
):
    """Delete a points package."""
    try:
        oid = ObjectId(pkg_id)
    except Exception:
        raise HTTPException(status_code=400, detail="Invalid pkg_id")
    result = await db.payment_settings.delete_one({"_id": oid})
    if result.deleted_count == 0:
        raise HTTPException(status_code=404, detail="Package not found")
    return {"ok": True}


# --- Dashboard stats ---

@api.get("/payments/dashboard")
async def payments_dashboard(admin: User = Depends(require_admin)):
    """Summary stats for the payment dashboard in Author Studio."""
    now = datetime.now(timezone.utc)
    today_start = now.replace(hour=0, minute=0, second=0, microsecond=0).isoformat()

    total_today     = await db.payment_transactions.count_documents({"created_at": {"$gte": today_start}})
    pending         = await db.payment_transactions.count_documents({"status": {"$in": ["received", "auto_processing"]}})
    needs_review    = await db.payment_transactions.count_documents({"status": "needs_review"})
    completed       = await db.payment_transactions.count_documents({"status": "completed"})
    rejected        = await db.payment_transactions.count_documents({"status": "rejected"})
    unmatched       = await db.payment_transactions.count_documents({"status": "unmatched"})

    # Completed today by type
    completed_tuition = await db.payment_transactions.count_documents({
        "status": "completed",
        "matched_intent_id": {"$ne": None},
        "completed_at": {"$gte": today_start},
    })

    recent = await db.payment_transactions.find(
        {}, {"raw_message": 0}
    ).sort("created_at", -1).limit(10).to_list(10)
    for d in recent:
        d["_id"] = str(d["_id"])

    return {
        "ok": True,
        "stats": {
            "total_today":         total_today,
            "pending":             pending,
            "needs_review":        needs_review,
            "completed":           completed,
            "completed_today":     completed_tuition,
            "rejected":            rejected,
            "unmatched":           unmatched,
        },
        "recent_transactions": recent,
    }


# --- Student payment history ---

@api.get("/students/{student_id}/payment-history")
async def student_payment_history(
    student_id: str,
    admin: User = Depends(require_admin),
):
    """Get all payment transactions matched to a student."""
    docs = await db.payment_transactions.find(
        {"matched_student_id": student_id},
        {"raw_message": 0},
    ).sort("created_at", -1).to_list(50)
    for d in docs:
        d["_id"] = str(d["_id"])
    return {"ok": True, "history": docs, "student_id": student_id}
