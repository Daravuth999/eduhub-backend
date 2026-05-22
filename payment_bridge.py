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
    """Find the best matching open payment intent for a transaction.

    Returns (intent_doc, confidence_score, match_reason).
    confidence_score:
        --- 80 --- HIGH   --- auto-complete
        40-79 --- MEDIUM --- needs_review
        < 40  --- LOW   --- unmatched
    """
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
    label:          str
    amount_khr:     int    # Khmer Riel amount
    points:         int    # points awarded
    bonus_points:   int = 0
    min_purchase:   int = 0
    max_purchase:   int = 0
    active:         bool = True
    notes:          str | None = None
    payment_link:   str | None = None

class PointsPackagePatch(_PM):
    label:          str | None = None
    amount_khr:     int | None = None
    points:         int | None = None
    bonus_points:   int | None = None
    min_purchase:   int | None = None
    max_purchase:   int | None = None
    active:         bool | None = None
    notes:          str | None = None
    payment_link:   str | None = None


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
                title="--- Tuition Payment Confirmed",
                body=(
                    f"Your payment of ${txn.get('amount', 0):.2f} was received. "
                    "Tuition status updated to Paid."
                ),
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
        # Push notification
        asyncio.create_task(
            _fan_out_push(
                {"studentId": clean_id},
                title=f"+{points_to_credit} Points Credited!",
                body=(
                    f"Your payment of ${txn.get('amount', 0):.2f} was received. "
                    f"{points_to_credit} points have been added to your account."
                ),
                url="/portal/me",
            )
        )
        log.info("payment_bridge: points auto-credited %d pts to %s (trx=%s)",
                 points_to_credit, clean_id, txn.get("transaction_id"))
        return {"ok": True, "clean_id": clean_id, "points_credited": points_to_credit}
    else:
        log.warning("payment_bridge: GAS points transfer failed for %s: %s", clean_id, gas_error)
        return {"ok": False, "error": gas_error}


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
        # Mark intent as completed
        if result.get("ok"):
            await db.payment_intents.update_one(
                {"_id": intent["_id"]},
                {"$set": {"status": "completed", "transaction_id": txn_id}},
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

    ref_code = f"{payload.type.upper()[:3]}-{payload.student_id}-{datetime.now(timezone.utc).strftime('%Y%m%d%H%M')}"
    now_str  = datetime.now(timezone.utc).isoformat()

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
        "expires_at":     (datetime.now(timezone.utc) + timedelta(hours=6)).isoformat(),
    }
    result = await db.payment_intents.insert_one(doc)
    return {
        "ok":             True,
        "intent_id":      str(result.inserted_id),
        "reference_code": ref_code,
        "expires_at":     doc["expires_at"],
    }


@api.get("/payments/intents/{intent_id}/status")
async def get_payment_intent_status(intent_id: str):
    """Public - student polls this to check if their payment was confirmed."""
    try:
        doc = await db.payment_intents.find_one({"_id": ObjectId(intent_id)})
    except Exception:
        raise HTTPException(status_code=400, detail="Invalid intent_id")
    if not doc:
        raise HTTPException(status_code=404, detail="Intent not found")
    return {"ok": True, "status": doc.get("status", "pending"), "intent_id": intent_id}


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
async def receive_telegram_webhook(payload: TelegramWebhookPayload):
    """Receive a raw PayWay Telegram notification message.

    Intended to be called by a Telegram bot or forwarder automation.
    Optionally protected via PAYMENT_WEBHOOK_SECRET header check if
    PAYMENT_WEBHOOK_SECRET env var is set.

    Does NOT require admin auth so that the forwarder bot can call it
    without a session cookie.
    """
    webhook_secret = os.environ.get("PAYMENT_WEBHOOK_SECRET", "")
    if webhook_secret:
        provided = payload.secret or ""
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
    intent_type  = payload.intent_type or "tuition"

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
    await db.payment_transactions.update_one(
        {"_id": ObjectId(txn_id)},
        {"$set": {
            "status":            final_status,
            "matched_student_id": student_id,
            "manually_approved": True,
            "approved_by":       admin.email,
            "approved_at":       now_str,
            "completion_result": result,
            "admin_note":        payload.note,
            "updated_at":        now_str,
        }},
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
    """Public read-only endpoint - returns active packages only. No auth required."""
    docs = await db.payment_settings.find({"active": True}).sort("amount_khr", 1).to_list(100)
    for d in docs:
        d["_id"] = str(d["_id"])
    return {"ok": True, "packages": docs}


@api.get("/payments/settings/points-packages")
async def list_points_packages(admin: User = Depends(require_admin)):
    """List all points conversion packages."""
    docs = await db.payment_settings.find({}).sort("amount_khr", 1).to_list(100)
    for d in docs:
        d["_id"] = str(d["_id"])
    return {"ok": True, "packages": docs}


@api.post("/payments/settings/points-packages")
async def create_points_package(
    payload: PointsPackageCreate,
    admin: User = Depends(require_admin),
):
    """Create a new points conversion package."""
    now_str = datetime.now(timezone.utc).isoformat()
    doc = {
        **payload.model_dump(),
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
    """Update a points package (partial update)."""
    try:
        oid = ObjectId(pkg_id)
    except Exception:
        raise HTTPException(status_code=400, detail="Invalid pkg_id")

    updates = {k: v for k, v in payload.model_dump().items() if v is not None}
    if not updates:
        raise HTTPException(status_code=400, detail="No fields to update")
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
