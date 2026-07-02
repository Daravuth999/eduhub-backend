"""
tuition_tools.py — EduHub Tuition Pay (MongoDB-backed billing, KHQR, rewards, receipts)

Loaded via exec() into server.py namespace. Inherits globals: api, db, log,
httpx, require_student, require_admin, _fan_out_push, _update_tuition_in_gas,
_WALLET_SERVICE_AVAILABLE, wallet_service.

MongoDB collections:
  tuition_records          — per-student billing state mirror / shadow
  tuition_payment_intents  — KHQR tuition payment intents
  tuition_receipts         — immutable receipt archive (never deleted)

Migration data_source field (per record):
  "gas"          — source of truth is GAS only (default for existing students)
  "mongo_shadow" — writes go to both GAS and Mongo; Mongo mirrors GAS
  "mongo"        — Mongo is sole source of truth; GAS writes disabled

Billing anchor rule:
  ALWAYS advance from the SCHEDULED next_due_date, never from today.
  If overdue: advance from the old due date (keeps billing day stable).
  If no prior record: advance from today (first payment).

Cambodia timezone: Asia/Phnom_Penh (UTC+7) for local date semantics.
"""

import secrets as _ttn_secrets
import calendar as _ttn_cal
import os as _ttn_os
import re as _ttn_re
import asyncio as _ttn_asyncio
from datetime import datetime, date, timezone, timedelta

_TTN_LOG = log.getChild("tuition")  # noqa: F821 — `log` injected by exec()

# ── Collection names ──────────────────────────────────────────────────────────
_TTN_COLL_RECORDS  = "tuition_records"
_TTN_COLL_INTENTS  = "tuition_payment_intents"
_TTN_COLL_RECEIPTS = "tuition_receipts"

# ── Config ────────────────────────────────────────────────────────────────────
# Cambodia UTC+7
_TTN_KH_TZ = timezone(timedelta(hours=7))

# Points credited per USD paid (configurable via env, default 10 pts per $1)
_TTN_POINTS_PER_USD = float(_ttn_os.environ.get("TUITION_POINTS_PER_USD", "10"))

# KHQR payment intent TTL in minutes
_TTN_INTENT_TTL_MIN = int(_ttn_os.environ.get("TUITION_INTENT_TTL_MINUTES", "10"))

# Backend public URL (for webhook URL construction)
_TTN_BACKEND_URL = _ttn_os.environ.get(
    "PUBLIC_BACKEND_URL", "https://eduhub-backend-td3a.onrender.com"
).rstrip("/")


# ── Date helpers ──────────────────────────────────────────────────────────────

def _ttn_utcnow() -> datetime:
    return datetime.now(timezone.utc)


def _ttn_today_kh() -> date:
    return datetime.now(_TTN_KH_TZ).date()


def _ttn_parse_date(s) -> date | None:
    """Parse YYYY.MM.DD, YYYY-MM-DD, or ISO timestamp → date. Never raises."""
    if not s:
        return None
    m = _ttn_re.match(r"^(\d{4})[.\-](\d{2})[.\-](\d{2})", str(s).strip())
    if not m:
        return None
    try:
        return date(int(m[1]), int(m[2]), int(m[3]))
    except ValueError:
        return None


def _ttn_fmt_date(d: date) -> str:
    """Format date as YYYY.MM.DD — matches GAS sheet format."""
    return d.strftime("%Y.%m.%d")


def _ttn_advance_billing(current_ndd: date | None, today: date) -> date:
    """
    Billing anchor algorithm.

    Advance from the SCHEDULED due date (current_ndd), not from today.
    - If current_ndd exists (even if overdue): add one month to it.
      This keeps the billing day stable (e.g. always the 15th).
    - If no prior record: advance from today (first payment).
    """
    base = current_ndd if current_ndd else today
    month = base.month % 12 + 1
    year  = base.year + (1 if base.month == 12 else 0)
    day   = min(base.day, _ttn_cal.monthrange(year, month)[1])
    return date(year, month, day)


def _ttn_reward_points(amount_usd: float) -> int:
    """Wallet reward points for a tuition payment. 0 if reward is disabled."""
    if _TTN_POINTS_PER_USD <= 0 or amount_usd <= 0:
        return 0
    return max(0, round(amount_usd * _TTN_POINTS_PER_USD))


def _ttn_compute_payment_action(
    rec: dict,
    global_config: dict,
    active_intent: "dict | None",
    today: "date",
    available_methods: "list[str]",
) -> "tuple[str, str | None]":
    """
    Backend-authoritative payment eligibility decision.

    Returns (payment_action, block_reason).
    payment_action is one of:
      pay_now        — overdue, unpaid, or paid+cycle-expired (new cycle)
      pay_early      — paid current cycle, advance-payment enabled globally
      resume_payment — active pending/verifying/finalizing intent
      under_review   — active manual_review intent
      unavailable    — paid current cycle with no advance; or no payment methods
      disabled       — feature or account-level disable

    Priority order: feature gate → account gate → active intent → methods → billing.
    """
    # 1. Global feature disabled
    if not global_config.get("enabled", True):
        return ("disabled", "feature_disabled")

    # 2. Per-student payment disabled
    if rec.get("payment_enabled") is False:
        return ("disabled", "account_disabled")

    # 3. Active intent state blocks or redirects
    if active_intent:
        intent_status = active_intent.get("status", "")
        if intent_status in ("pending", "verifying", "finalizing"):
            return ("resume_payment", None)
        if intent_status == "manual_review":
            return ("under_review", "manual_review")
        # completed or expired → fall through (no longer blocking)

    # 4. No payment methods configured/enabled
    if not available_methods:
        return ("unavailable", "no_payment_methods")

    # 5. Billing cycle check
    status = (rec.get("tuition_status") or "").strip().lower()
    ndd = _ttn_parse_date(rec.get("next_due_date"))
    days_until_due = (ndd - today).days if ndd is not None else None

    # Paid AND current cycle not yet expired
    paid_current_cycle = (
        status == "paid"
        and days_until_due is not None
        and days_until_due >= 0
    )
    if paid_current_cycle:
        if global_config.get("allow_advance_payment", False):
            return ("pay_early", None)
        return ("unavailable", "paid_current_cycle")

    # Overdue, unpaid, or paid+cycle-expired (new cycle open) → student may pay
    return ("pay_now", None)


def _ttn_make_reference() -> str:
    """Generate a CamRapidPay-safe reference string: TUITION-{ts}-{rand}."""
    short_ts = datetime.now(_TTN_KH_TZ).strftime("%m%d%H%M%S")
    rand = _ttn_secrets.token_hex(3).upper()
    ref = f"TUITION-{short_ts}-{rand}"
    ref = _ttn_re.sub(r"[^A-Z0-9-]+", "-", ref.upper())
    ref = _ttn_re.sub(r"-+", "-", ref).strip("-")[:50]
    return ref


def _ttn_httpx_factory():
    """Zero-arg factory for httpx AsyncClient used by CamRapidPay provider."""
    return httpx.AsyncClient(  # noqa: F821 — httpx injected by exec()
        timeout=httpx.Timeout(30.0, connect=10.0), follow_redirects=True
    )


# ── Core finalizer (called by payment_bridge._complete_tuition_payment) ───────

async def tuition_finalize_payment(
    student_id: str,
    clean_id: str,
    amount_usd: float,
    amount_khr: int,
    method: str,
    reference: str,
    intent_id: str | None = None,
) -> dict:
    """
    Finalize a confirmed tuition payment. Replaces _complete_tuition_payment().

    - Advances billing anchor correctly (from scheduled due date, not today)
    - Writes to MongoDB tuition_records (and GAS in shadow/gas mode)
    - Creates immutable receipt in tuition_receipts
    - Credits wallet reward points (idempotent via wallet_service)
    - Fires Khmer push notification
    - Updates intent status to "completed"

    Returns {"ok": True, "receipt_id": ..., "new_due_date": ..., "reward_points": ...}
    Never raises — returns {"ok": False, "error": ...} on any failure.
    """
    today = _ttn_today_kh()

    try:
        # 1. Get current next_due_date from Mongo record (or intent doc)
        rec = await db[_TTN_COLL_RECORDS].find_one({"student_id": student_id})  # noqa: F821
        current_ndd_str = rec.get("next_due_date") if rec else None

        if not current_ndd_str and intent_id:
            intent_doc = await db[_TTN_COLL_INTENTS].find_one({"intent_id": intent_id})
            if intent_doc:
                current_ndd_str = intent_doc.get("current_ndd")

        current_ndd = _ttn_parse_date(current_ndd_str)
        new_due_date = _ttn_advance_billing(current_ndd, today)
        new_due_str  = _ttn_fmt_date(new_due_date)
        today_str    = _ttn_fmt_date(today)

        # 2. Compute reward points
        reward_pts = _ttn_reward_points(amount_usd)

        # 3. Create immutable receipt
        receipt_id = "rcpt_" + _ttn_secrets.token_hex(12)
        now = _ttn_utcnow()
        receipt_doc = {
            "receipt_id":       receipt_id,
            "student_id":       student_id,
            "clean_id":         clean_id,
            "amount_usd":       round(float(amount_usd), 2),
            "amount_khr":       int(amount_khr),
            "method":           method,
            "reference":        reference,
            "tuition_status":   "Paid",
            "prev_due_date":    current_ndd_str,
            "new_due_date":     new_due_str,
            "billing_anchor_day": new_due_date.day,
            "reward_points":    reward_pts,
            "reward_status":    "processing" if reward_pts > 0 else None,
            "confirmed_at":     now,
            "acknowledged_at":  None,
            "intent_id":        intent_id,
        }
        await db[_TTN_COLL_RECEIPTS].insert_one(receipt_doc)

        # 4. Upsert Mongo tuition record
        data_source = rec.get("data_source", "mongo_shadow") if rec else "mongo_shadow"
        await db[_TTN_COLL_RECORDS].update_one(
            {"student_id": student_id},
            {"$set": {
                "student_id":       student_id,
                "clean_id":         clean_id,
                "tuition_status":   "Paid",
                "last_payment_date": today_str,
                "next_due_date":    new_due_str,
                "payment_amount":   round(float(amount_usd), 2),
                "data_source":      data_source,
                "updated_at":       now,
                "updated_by":       "payment",
                "last_receipt_id":  receipt_id,
            }},
            upsert=True,
        )

        # 5. GAS shadow write (fire-and-forget if GAS fails — Mongo already written)
        if data_source in ("gas", "mongo_shadow"):
            try:
                await _update_tuition_in_gas(  # noqa: F821 — injected by exec()
                    clean_id=clean_id,
                    tuition_status="Paid",
                    last_payment_date=today_str,
                    next_due_date=new_due_str,
                    payment_amount=str(round(amount_usd, 2)),
                )
            except Exception as _gas_exc:
                _TTN_LOG.warning(
                    "tuition_finalize: GAS shadow write failed (Mongo written): %s", _gas_exc
                )

        # 6. Update intent status to "completed"
        if intent_id:
            await db[_TTN_COLL_INTENTS].update_one(
                {"intent_id": intent_id},
                {"$set": {
                    "status":       "completed",
                    "finalized_at": now,
                    "receipt_id":   receipt_id,
                    "reward_points": reward_pts,
                    "new_due_date": new_due_str,
                }},
            )

        # 7. Credit wallet reward (idempotent via wallet_service)
        if reward_pts > 0 and _WALLET_SERVICE_AVAILABLE and wallet_service is not None:  # noqa: F821
            try:
                _ttn_ws = wallet_service.WalletService(db)
                await _ttn_ws.credit(
                    student_id=student_id,
                    amount=reward_pts,
                    source="tuition_payment",
                    source_ref=receipt_id,
                    idempotency_key=f"tuition:{student_id}:{receipt_id}",
                    payload={"amount_usd": amount_usd, "method": method, "receipt_id": receipt_id},
                    clean_id=clean_id,
                )
                await db[_TTN_COLL_RECEIPTS].update_one(  # noqa: F821
                    {"receipt_id": receipt_id},
                    {"$set": {"reward_status": "credited"}},
                )
            except Exception as _wal_exc:
                _TTN_LOG.warning(
                    "tuition_finalize: wallet reward failed (receipt still issued): %s", _wal_exc
                )

        # 8. Push notification
        try:
            _ttn_asyncio.create_task(
                _fan_out_push(  # noqa: F821 — injected by exec()
                    {"studentId": clean_id},
                    title="ការបង់ថ្លៃសិក្សាបានបញ្ជាក់",
                    body=(
                        f"ការបង់ប្រាក់ ${amount_usd:.2f} ត្រូវបានទទួល។ "
                        f"ថ្ងៃបង់ប្រាក់បន្ទាប់: {new_due_str}。"
                    ),
                    url=f"/portal?tuition=receipt&rid={receipt_id}",
                )
            )
        except Exception as _push_exc:
            _TTN_LOG.warning("tuition_finalize: push failed (non-fatal): %s", _push_exc)

        _TTN_LOG.info(
            "tuition_finalize_payment: ok student=%s method=%s usd=%.2f "
            "new_due=%s receipt=%s reward=%d",
            clean_id, method, amount_usd, new_due_str, receipt_id, reward_pts,
        )
        return {
            "ok":           True,
            "receipt_id":   receipt_id,
            "new_due_date": new_due_str,
            "reward_points": reward_pts,
            "clean_id":     clean_id,
        }

    except Exception as exc:
        _TTN_LOG.error(
            "tuition_finalize_payment: unhandled error student=%s: %s", student_id, exc
        )
        return {"ok": False, "error": str(exc)}


# ── Shadow writer (called fire-and-forget from teacher_update_tuition) ────────

async def tuition_shadow_write(
    student_id: str,
    clean_id: str,
    tuition_status,
    last_payment_date,
    next_due_date,
    payment_amount,
) -> None:
    """
    Mirror a teacher GAS write into MongoDB tuition_records.
    Called via asyncio.create_task() from teacher_update_tuition after GAS success.
    Never raises.
    """
    try:
        now = _ttn_utcnow()
        patch: dict = {
            "student_id":  student_id,
            "clean_id":    clean_id,
            "data_source": "mongo_shadow",
            "updated_at":  now,
            "updated_by":  "teacher",
        }
        if tuition_status is not None:
            patch["tuition_status"] = tuition_status
        if last_payment_date is not None:
            patch["last_payment_date"] = last_payment_date
        if next_due_date is not None:
            patch["next_due_date"] = next_due_date
        if payment_amount is not None:
            try:
                patch["payment_amount"] = float(payment_amount)
            except (TypeError, ValueError):
                pass

        await db[_TTN_COLL_RECORDS].update_one(  # noqa: F821
            {"student_id": student_id},
            {"$set": patch},
            upsert=True,
        )
        _TTN_LOG.debug(
            "tuition_shadow_write: ok student=%s status=%s next_due=%s",
            student_id, tuition_status, next_due_date,
        )
    except Exception as exc:
        _TTN_LOG.warning("tuition_shadow_write: failed (non-fatal): %s", exc)


# ── Student API routes ────────────────────────────────────────────────────────

@api.get("/student/tuition")  # noqa: F821
async def student_tuition_record(student=Depends(require_student)):  # noqa: F821
    """
    Return this student's tuition record with backend-authoritative eligibility contract.

    Response always includes:
      payment_action       — pay_now | pay_early | resume_payment | under_review |
                             unavailable | disabled
      payment_block_reason — null or a machine-readable reason string
      can_pay              — True when payment_action is pay_now
      can_pay_ahead        — True when payment_action is pay_early
      active_intent        — safe summary of any blocking intent, or null
      available_payment_methods — list of enabled methods (e.g. ["khqr"])
      feature_enabled      — global tuition feature flag
      reward_points        — reward preview for this student's payment amount
    """
    rec = await db[_TTN_COLL_RECORDS].find_one(  # noqa: F821
        {"student_id": student.student_id},
        {"_id": 0},
    )
    gas_only = not bool(rec)
    if gas_only:
        # No MongoDB shadow record yet — student is GAS-only.
        # Compute payment_action from global config + active intent only.
        # Billing fields are absent; the frontend falls back to GAS student prop.
        # Shadow records are created when a teacher runs tuition_shadow_write().
        rec = {}

    today = _ttn_today_kh()
    global_config = await _ttn_get_global_config()

    # Fetch any active (blocking) intent — completed/expired do not block
    active_intent_doc = await db[_TTN_COLL_INTENTS].find_one(  # noqa: F821
        {
            "student_id": student.student_id,
            "status": {"$in": ["pending", "verifying", "finalizing", "manual_review"]},
        },
        {"_id": 0, "qr_payload": 0},
        sort=[("created_at", -1)],
    )

    # Available payment methods
    available_methods: list = []
    try:
        from payment_providers import camrapidpay_provider as _crp
        if _crp.is_enabled():
            available_methods = ["khqr"]
    except Exception:
        pass

    payment_action, block_reason = _ttn_compute_payment_action(
        rec, global_config, active_intent_doc, today, available_methods
    )

    # Safe active-intent summary (no QR data, no internal provider state)
    active_intent_safe = None
    if active_intent_doc and active_intent_doc.get("status") in (
        "pending", "verifying", "finalizing", "manual_review"
    ):
        exp = active_intent_doc.get("expires_at")
        active_intent_safe = {
            "intent_id":  active_intent_doc.get("intent_id"),
            "status":     active_intent_doc.get("status"),
            "amount_usd": active_intent_doc.get("amount_usd"),
            "amount_khr": active_intent_doc.get("amount_khr"),
            "expires_at": exp.isoformat() if isinstance(exp, datetime) else exp,
        }

    # Reward preview
    payment_amount = float(rec.get("payment_amount") or 0)
    per_usd = float(
        rec.get("per_student_points_per_usd")
        or global_config.get("default_points_per_usd")
        or _TTN_POINTS_PER_USD
    )
    reward_preview = max(0, round(payment_amount * per_usd)) if payment_amount > 0 else 0

    if isinstance(rec.get("updated_at"), datetime):
        rec["updated_at"] = rec["updated_at"].isoformat()

    return {
        **rec,
        "ok": True,
        "gas_only":                   gas_only,
        "feature_enabled":            global_config.get("enabled", True),
        "payment_action":             payment_action,
        "payment_block_reason":       block_reason,
        "can_pay":                    payment_action == "pay_now",
        "can_pay_ahead":              payment_action == "pay_early",
        "active_intent":              active_intent_safe,
        "available_payment_methods":  available_methods,
        "reward_points":              reward_preview,
        # Backward-compat shims — frontend migrating away from these:
        "pending_intent_id":          (active_intent_safe or {}).get("intent_id"),
        "intent_status":              (active_intent_safe or {}).get("status"),
    }


@api.get("/student/tuition/receipt/{receipt_id}")
async def student_tuition_receipt(
    receipt_id: str,
    student=Depends(require_student),  # noqa: F821
):
    """Return an immutable tuition receipt (student sees own receipts only)."""
    rec = await db[_TTN_COLL_RECEIPTS].find_one(  # noqa: F821
        {"receipt_id": receipt_id, "student_id": student.student_id},
        {"_id": 0},
    )
    if not rec:
        raise HTTPException(status_code=404, detail="Receipt not found")  # noqa: F821
    for k in ("confirmed_at", "acknowledged_at"):
        if isinstance(rec.get(k), datetime):
            rec[k] = rec[k].isoformat()
    return rec


@api.post("/student/tuition/receipt/{receipt_id}/acknowledge")
async def acknowledge_tuition_receipt(
    receipt_id: str,
    student=Depends(require_student),  # noqa: F821
):
    """Student confirms they have seen a receipt."""
    result = await db[_TTN_COLL_RECEIPTS].update_one(  # noqa: F821
        {
            "receipt_id":      receipt_id,
            "student_id":      student.student_id,
            "acknowledged_at": None,
        },
        {"$set": {"acknowledged_at": _ttn_utcnow()}},
    )
    if result.matched_count == 0:
        return {"ok": True, "already_acknowledged": True}
    return {"ok": True, "acknowledged": True}


@api.post("/student/tuition/intent")
async def create_tuition_intent(
    payload: dict,
    student=Depends(require_student),  # noqa: F821
):
    """
    Create a KHQR tuition payment intent.

    Body: { method: "khqr", amount_khr: int, amount_usd: float, current_ndd?: str }
    Returns: { intent_id, reference, qr_image, qr_payload, amount_khr, amount_usd,
               expires_at, method, payment_url }
    """
    method = (payload.get("method") or "khqr").strip().lower()
    if method != "khqr":
        raise HTTPException(status_code=400, detail="Only 'khqr' method supported for tuition")  # noqa: F821

    try:
        amount_khr = int(payload.get("amount_khr", 0))
        amount_usd = float(payload.get("amount_usd", 0.0))
    except (TypeError, ValueError):
        raise HTTPException(status_code=400, detail="amount_khr (int) and amount_usd (float) required")  # noqa: F821

    if amount_khr <= 0 or amount_usd <= 0:
        raise HTTPException(status_code=400, detail="Amount must be positive")  # noqa: F821

    current_ndd: str | None = (payload.get("current_ndd") or "").strip() or None

    # ── Server-side eligibility revalidation (forged frontend state is rejected) ──
    global_config = await _ttn_get_global_config()
    if not global_config.get("enabled", True):
        raise HTTPException(  # noqa: F821
            status_code=403,
            detail={"code": "TUITION_DISABLED", "message": "Tuition payment is currently disabled."},
        )

    ttn_rec = await db[_TTN_COLL_RECORDS].find_one({"student_id": student.student_id})  # noqa: F821
    if not ttn_rec:
        raise HTTPException(  # noqa: F821
            status_code=403,
            detail={"code": "TUITION_NO_RECORD", "message": "No tuition record found for this account."},
        )
    if ttn_rec.get("payment_enabled") is False:
        raise HTTPException(  # noqa: F821
            status_code=403,
            detail={"code": "TUITION_ACCOUNT_DISABLED", "message": "Tuition payment is disabled for this account."},
        )

    # Block duplicate intent creation
    blocking_intent = await db[_TTN_COLL_INTENTS].find_one(  # noqa: F821
        {
            "student_id": student.student_id,
            "status": {"$in": ["pending", "verifying", "finalizing", "manual_review"]},
        },
    )
    if blocking_intent:
        bi_status = blocking_intent.get("status")
        if bi_status == "manual_review":
            raise HTTPException(  # noqa: F821
                status_code=409,
                detail={"code": "TUITION_MANUAL_REVIEW", "message": "Payment is under manual review."},
            )
        raise HTTPException(  # noqa: F821
            status_code=409,
            detail={
                "code": "INTENT_ACTIVE",
                "intent_id": blocking_intent["intent_id"],
                "status": bi_status,
                "message": "An active payment intent already exists. Resume it instead.",
            },
        )

    # Billing eligibility: reject if paid for the current cycle and advance is not enabled
    today_check = _ttn_today_kh()
    ttn_ndd = _ttn_parse_date(ttn_rec.get("next_due_date"))
    days_check = (ttn_ndd - today_check).days if ttn_ndd is not None else None
    ttn_status = (ttn_rec.get("tuition_status") or "").strip().lower()
    if ttn_status == "paid" and days_check is not None and days_check >= 0:
        if not global_config.get("allow_advance_payment", False):
            raise HTTPException(  # noqa: F821
                status_code=403,
                detail={
                    "code": "TUITION_PAID_CURRENT_CYCLE",
                    "message": "Tuition is already paid for the current billing cycle.",
                },
            )

    # ── CamRapidPay KHQR invoice creation ─────────────────────────────────
    try:
        from payment_providers import camrapidpay_provider as _ttn_crp
    except Exception:
        raise HTTPException(status_code=503, detail="KHQR provider module unavailable")  # noqa: F821

    if not _ttn_crp.is_enabled():
        raise HTTPException(  # noqa: F821
            status_code=503,
            detail="KHQR payment provider not configured on this server",
        )

    reference    = _ttn_make_reference()
    webhook_url  = f"{_TTN_BACKEND_URL}/api/payments/tuition/khqr/webhook"
    success_url  = _TTN_BACKEND_URL.replace("api.", "").rstrip("/")  # front-end root
    now          = _ttn_utcnow()
    expires_at   = now + timedelta(minutes=_TTN_INTENT_TTL_MIN)

    created = await _ttn_crp.create_payment(
        _ttn_httpx_factory, amount_usd, reference, success_url, webhook_url,
    )

    if not created.get("ok"):
        _TTN_LOG.warning(
            "create_tuition_intent: provider rejected student=%s ref=%s err=%s",
            student.clean_id, reference, created.get("error"),
        )
        raise HTTPException(  # noqa: F821
            status_code=502,
            detail=f"Payment provider unavailable: {created.get('error', 'unknown')}",
        )

    # QR code data (EMV payload or raw qr_code string from provider)
    qr_payload = created.get("qr_code") or ""
    payment_url = created.get("payment_url") or ""

    # Build base64 QR image
    qr_image = ""
    if qr_payload:
        try:
            import io as _qr_io
            import base64 as _qr_b64
            import segno as _qr_segno
            qr = _qr_segno.make(qr_payload, error="m")
            buf = _qr_io.BytesIO()
            qr.save(buf, kind="png", scale=8, border=2)
            qr_image = "data:image/png;base64," + _qr_b64.b64encode(buf.getvalue()).decode("ascii")
        except Exception as _qr_exc:
            _TTN_LOG.warning("create_tuition_intent: QR render failed: %s", _qr_exc)

    # ── Persist intent ──────────────────────────────────────────────────────
    intent_id = "tui_" + _ttn_secrets.token_hex(12)
    intent_doc = {
        "intent_id":      intent_id,
        "student_id":     student.student_id,
        "clean_id":       student.clean_id,
        "method":         method,
        "amount_usd":     round(amount_usd, 2),
        "amount_khr":     amount_khr,
        "status":         "pending",
        "reference":      reference,
        "khqr_reference": reference,
        "qr_payload":     qr_payload,
        "payment_url":    payment_url,
        "current_ndd":    current_ndd,
        "created_at":     now,
        "expires_at":     expires_at,
        "finalized_at":   None,
        "receipt_id":     None,
        "reward_points":  None,
        "new_due_date":   None,
    }
    await db[_TTN_COLL_INTENTS].insert_one(intent_doc)  # noqa: F821

    _TTN_LOG.info(
        "create_tuition_intent: created student=%s intent=%s ref=%s usd=%.2f",
        student.clean_id, intent_id, reference, amount_usd,
    )

    return {
        "ok":         True,
        "intent_id":  intent_id,
        "reference":  reference,
        "qr_image":   qr_image,
        "qr_payload": qr_payload,
        "payment_url": payment_url,
        "amount_khr": amount_khr,
        "amount_usd": round(amount_usd, 2),
        "expires_at": expires_at.isoformat(),
        "method":     method,
    }


@api.get("/student/tuition/intent/{intent_id}")
async def poll_tuition_intent(
    intent_id: str,
    student=Depends(require_student),  # noqa: F821
):
    """
    Poll tuition payment intent. Triggers server-to-server CamRapidPay check
    when status is still pending.

    Returns the current intent document (minus large qr_payload field).
    """
    intent = await db[_TTN_COLL_INTENTS].find_one(  # noqa: F821
        {"intent_id": intent_id, "student_id": student.student_id},
        {"_id": 0, "qr_payload": 0},
    )
    if not intent:
        raise HTTPException(status_code=404, detail="Intent not found")  # noqa: F821

    status = intent.get("status", "pending")

    # Only attempt verification when still pending
    if status == "pending":
        reference = intent.get("khqr_reference") or intent.get("reference", "")
        if reference:
            try:
                from payment_providers import camrapidpay_provider as _ttn_crp2
                if _ttn_crp2.is_enabled():
                    verify = await _ttn_crp2.check_status(_ttn_httpx_factory, reference)
                    provider_status = verify.get("status")

                    if provider_status == _ttn_crp2.STATUS_SUCCESS:
                        # Atomic ownership flip — prevent double-finalization
                        claimed = await db[_TTN_COLL_INTENTS].find_one_and_update(  # noqa: F821
                            {"intent_id": intent_id, "status": "pending"},
                            {"$set": {"status": "finalizing"}},
                            return_document=True,
                        )
                        if claimed:
                            fin = await tuition_finalize_payment(
                                student_id=intent["student_id"],
                                clean_id=intent.get("clean_id", ""),
                                amount_usd=intent["amount_usd"],
                                amount_khr=intent["amount_khr"],
                                method=intent["method"],
                                reference=reference,
                                intent_id=intent_id,
                            )
                            if fin.get("ok"):
                                status = "completed"
                            else:
                                # Revert so next poll retries
                                await db[_TTN_COLL_INTENTS].update_one(  # noqa: F821
                                    {"intent_id": intent_id, "status": "finalizing"},
                                    {"$set": {"status": "pending"}},
                                )

                    elif provider_status in (_ttn_crp2.STATUS_EXPIRED, _ttn_crp2.STATUS_UNKNOWN):
                        now_utc = _ttn_utcnow()
                        exp = intent.get("expires_at")
                        if isinstance(exp, str):
                            try:
                                exp = datetime.fromisoformat(exp)
                            except ValueError:
                                exp = None
                        if exp and now_utc > exp.replace(tzinfo=timezone.utc) if exp.tzinfo is None else now_utc > exp:
                            await db[_TTN_COLL_INTENTS].update_one(  # noqa: F821
                                {"intent_id": intent_id, "status": "pending"},
                                {"$set": {"status": "expired"}},
                            )
                            status = "expired"

            except Exception as _poll_exc:
                _TTN_LOG.warning(
                    "poll_tuition_intent: verify error intent=%s: %s", intent_id, _poll_exc
                )

    # Re-fetch to pick up any finalization updates
    fresh = await db[_TTN_COLL_INTENTS].find_one(  # noqa: F821
        {"intent_id": intent_id},
        {"_id": 0, "qr_payload": 0},
    )
    if fresh:
        for k in ("created_at", "expires_at", "finalized_at"):
            v = fresh.get(k)
            if isinstance(v, datetime):
                fresh[k] = v.isoformat()
        return fresh

    return {"intent_id": intent_id, "status": status}


@api.post("/payments/tuition/khqr/webhook")
async def tuition_khqr_webhook(payload: dict):
    """
    CamRapidPay wake-up webhook for tuition payments.

    Webhook body is NEVER trusted for finalization (truth model: server-to-server only).
    We use it solely as a trigger to attempt finalization for matching pending intents.
    Returns 200 immediately so CamRapidPay does not retry.
    """
    reference = (
        payload.get("reference") or payload.get("ref") or payload.get("bill_number") or ""
    ).strip()
    _TTN_LOG.info("tuition_khqr_webhook: wake-up ref=%s", reference[:40] or "<empty>")

    if reference:
        try:
            intent = await db[_TTN_COLL_INTENTS].find_one(  # noqa: F821
                {"khqr_reference": reference, "status": "pending"},
                {"_id": 0},
            )
            if intent:
                from payment_providers import camrapidpay_provider as _ttn_crp3
                if _ttn_crp3.is_enabled():
                    verify = await _ttn_crp3.check_status(_ttn_httpx_factory, reference)
                    if verify.get("status") == _ttn_crp3.STATUS_SUCCESS:
                        claimed = await db[_TTN_COLL_INTENTS].find_one_and_update(  # noqa: F821
                            {"intent_id": intent["intent_id"], "status": "pending"},
                            {"$set": {"status": "finalizing"}},
                            return_document=True,
                        )
                        if claimed:
                            _ttn_asyncio.create_task(
                                tuition_finalize_payment(
                                    student_id=intent["student_id"],
                                    clean_id=intent.get("clean_id", ""),
                                    amount_usd=intent["amount_usd"],
                                    amount_khr=intent["amount_khr"],
                                    method=intent["method"],
                                    reference=reference,
                                    intent_id=intent["intent_id"],
                                )
                            )
        except Exception as _wh_exc:
            _TTN_LOG.warning("tuition_khqr_webhook: error ref=%s: %s", reference[:40], _wh_exc)

    return {"ok": True}


# ── Admin/teacher API routes ──────────────────────────────────────────────────

@api.get("/admin/tuition/dashboard")
async def admin_tuition_dashboard(
    limit: int = 500,
    admin=Depends(require_admin),  # noqa: F821
):
    """Return all Mongo tuition records for teacher dashboard (Mongo-backed panel)."""
    limit = min(limit, 1000)
    cursor = db[_TTN_COLL_RECORDS].find({}, {"_id": 0}).sort("updated_at", -1).limit(limit)  # noqa: F821
    records = []
    async for doc in cursor:
        if isinstance(doc.get("updated_at"), datetime):
            doc["updated_at"] = doc["updated_at"].isoformat()
        records.append(doc)
    return {"ok": True, "records": records, "count": len(records)}


@api.get("/admin/tuition/receipts")
async def admin_tuition_receipts(
    limit: int = 50,
    admin=Depends(require_admin),  # noqa: F821
):
    """Return recent immutable tuition receipts."""
    limit = min(limit, 200)
    cursor = db[_TTN_COLL_RECEIPTS].find({}, {"_id": 0}).sort("confirmed_at", -1).limit(limit)  # noqa: F821
    receipts = []
    async for doc in cursor:
        for k in ("confirmed_at", "acknowledged_at"):
            if isinstance(doc.get(k), datetime):
                doc[k] = doc[k].isoformat()
        receipts.append(doc)
    return {"ok": True, "receipts": receipts, "count": len(receipts)}


@api.get("/admin/tuition/migration-status")
async def admin_tuition_migration_status(admin=Depends(require_admin)):  # noqa: F821
    """Migration monitoring: breakdown of data_source stages."""
    pipeline = [{"$group": {"_id": "$data_source", "count": {"$sum": 1}}}]
    stages: dict = {}
    async for row in db[_TTN_COLL_RECORDS].aggregate(pipeline):  # noqa: F821
        stages[row["_id"] or "unknown"] = row["count"]
    mongo_count = sum(stages.values())
    total_active = await db.students.count_documents({"is_active": True})  # noqa: F821
    return {
        "ok":                    True,
        "stages":                stages,
        "mongo_records":         mongo_count,
        "total_active_students": total_active,
        "gas_only_estimated":    max(0, total_active - mongo_count),
    }


@api.post("/admin/tuition/setup-indexes")
async def admin_tuition_setup_indexes(admin=Depends(require_admin)):  # noqa: F821
    """Create MongoDB indexes for all tuition collections. Idempotent."""
    results: dict = {}
    try:
        await db[_TTN_COLL_RECORDS].create_index([("student_id", 1)], unique=True, background=True)  # noqa: F821
        await db[_TTN_COLL_RECORDS].create_index([("clean_id", 1)], background=True)
        await db[_TTN_COLL_RECORDS].create_index([("next_due_date", 1)], background=True)
        results[_TTN_COLL_RECORDS] = "ok"
    except Exception as exc:
        results[_TTN_COLL_RECORDS] = str(exc)
    try:
        await db[_TTN_COLL_INTENTS].create_index([("intent_id", 1)], unique=True, background=True)  # noqa: F821
        await db[_TTN_COLL_INTENTS].create_index([("student_id", 1), ("status", 1)], background=True)
        await db[_TTN_COLL_INTENTS].create_index([("khqr_reference", 1)], background=True)
        await db[_TTN_COLL_INTENTS].create_index([("expires_at", 1)], background=True)
        results[_TTN_COLL_INTENTS] = "ok"
    except Exception as exc:
        results[_TTN_COLL_INTENTS] = str(exc)
    try:
        await db[_TTN_COLL_RECEIPTS].create_index([("receipt_id", 1)], unique=True, background=True)  # noqa: F821
        await db[_TTN_COLL_RECEIPTS].create_index(
            [("student_id", 1), ("confirmed_at", -1)], background=True
        )
        results[_TTN_COLL_RECEIPTS] = "ok"
    except Exception as exc:
        results[_TTN_COLL_RECEIPTS] = str(exc)

    _TTN_LOG.info("admin_tuition_setup_indexes: %s", results)
    return {"ok": True, "indexes": results}



# ── 4th collection: global config + reminder config ───────────────────────────
_TTN_COLL_CONFIG      = "tuition_config"
_TTN_COLL_DISMISSALS  = "tuition_reminder_dismissals"


# ── Multi-month billing anchor ────────────────────────────────────────────────

def _ttn_advance_billing_n(current_ndd: date | None, today: date, months: int = 1) -> date:
    """Advance billing anchor by N months. Preserves anchor day across all months."""
    if months < 1:
        months = 1
    base = current_ndd if current_ndd else today
    for _ in range(months):
        m = base.month % 12 + 1
        y = base.year + (1 if base.month == 12 else 0)
        d = min(base.day, _ttn_cal.monthrange(y, m)[1])
        base = date(y, m, d)
    return base


def _ttn_is_late(current_ndd: date | None, today: date) -> bool:
    """Return True when payment is made after the scheduled due date."""
    if current_ndd is None:
        return False   # first payment is never "late"
    return today > current_ndd


# ── Config helpers ────────────────────────────────────────────────────────────

async def _ttn_get_global_config() -> dict:
    """Return global tuition config doc, with safe defaults if not yet set."""
    doc = await db[_TTN_COLL_CONFIG].find_one({"type": "global_config"})  # noqa: F821
    return doc or {
        "type": "global_config",
        "enabled": True,
        "default_points_per_usd": _TTN_POINTS_PER_USD,
        "payment_confirmed_push": True,
        "reward_push": True,
        "late_cutoff_days": 0,
        "allow_advance_payment": False,
    }


async def _ttn_get_reminder_config() -> dict:
    """Return reminder overlay config doc, with safe defaults."""
    doc = await db[_TTN_COLL_CONFIG].find_one({"type": "reminder_config"})  # noqa: F821
    return doc or {
        "type": "reminder_config",
        "enabled": True,
        "title_km": "ថ្លៃសិក្សានឹងផុតកំណត់",
        "title_en": "Tuition Due",
        "body_km":  "សូមបង់ថ្លៃសិក្សារបស់អ្នកដើម្បីរក្សាការចូលរៀន",
        "body_en":  "Please pay your tuition to keep your learning access",
        "cta_km":   "បង់ប្រាក់",
        "cta_en":   "Pay Now",
        "audience": "all",           # all | overdue | due_soon | selected
        "selected_clean_ids": [],    # used when audience="selected"
        "due_window_days": 7,        # show when ≤ N days until due
        "dismiss_hours": 6,
        "dismiss_strategy": "session",  # session | server
        "frequency": "once_per_day",    # always | once_per_day | once_per_week
        "style": "fullscreen",          # fullscreen | banner
    }


# ── Student-facing reminder endpoint (server controls all eligibility) ────────

@api.get("/tuition/reminder/me")  # noqa: F821
async def tuition_reminder_me(student=Depends(require_student)):  # noqa: F821
    """
    Returns the server-controlled overlay payload for this student, or {"show": false}.

    The frontend MUST NOT derive eligibility from raw tuition data.
    All targeting, window calculation, and frequency logic lives here.
    """
    cfg = await _ttn_get_reminder_config()
    if not cfg.get("enabled", True):
        return {"show": False, "reason": "disabled"}

    # Fetch student tuition record
    rec = await db[_TTN_COLL_RECORDS].find_one({"student_id": student.student_id}, {"_id": 0})  # noqa: F821
    if not rec:
        return {"show": False, "reason": "no_record"}

    status = (rec.get("tuition_status") or "").lower()
    if status == "paid":
        return {"show": False, "reason": "paid"}

    # Audience filter
    audience = cfg.get("audience", "all")
    today = _ttn_today_kh()
    ndd   = _ttn_parse_date(rec.get("next_due_date"))
    days  = (ndd - today).days if ndd else None

    if audience == "selected":
        allowed = cfg.get("selected_clean_ids") or []
        if student.clean_id not in allowed:
            return {"show": False, "reason": "not_selected"}
    elif audience == "overdue":
        if days is None or days >= 0:
            return {"show": False, "reason": "not_overdue"}
    elif audience == "due_soon":
        window = int(cfg.get("due_window_days", 7))
        if days is None or days < 0 or days > window:
            return {"show": False, "reason": "outside_window"}
    else:  # "all" — show to overdue and due-soon
        window = int(cfg.get("due_window_days", 7))
        if days is not None and days > window:
            return {"show": False, "reason": "outside_window"}

    # Server-side dismiss check (for server dismiss strategy)
    if cfg.get("dismiss_strategy") == "server":
        dismiss_hours = int(cfg.get("dismiss_hours", 6))
        cutoff = datetime.now(timezone.utc) - timedelta(hours=dismiss_hours)
        dismissed = await db[_TTN_COLL_DISMISSALS].find_one(  # noqa: F821
            {"student_id": student.student_id, "dismissed_at": {"$gte": cutoff}},
        )
        if dismissed:
            return {"show": False, "reason": "dismissed"}

    is_overdue = days is not None and days < 0

    return {
        "show":          True,
        "is_overdue":    is_overdue,
        "days":          days,
        "next_due_date": rec.get("next_due_date"),
        "payment_amount": rec.get("payment_amount"),
        "title_km":      cfg.get("title_km"),
        "title_en":      cfg.get("title_en"),
        "body_km":       cfg.get("body_km"),
        "body_en":       cfg.get("body_en"),
        "cta_km":        cfg.get("cta_km"),
        "cta_en":        cfg.get("cta_en"),
        "style":         cfg.get("style", "fullscreen"),
        "dismiss_hours": cfg.get("dismiss_hours", 6),
        "dismiss_strategy": cfg.get("dismiss_strategy", "session"),
    }


@api.post("/tuition/reminder/dismiss")  # noqa: F821
async def tuition_reminder_dismiss(student=Depends(require_student)):  # noqa: F821
    """Store a server-side dismissal (used when dismiss_strategy='server')."""
    now = _ttn_utcnow()
    await db[_TTN_COLL_DISMISSALS].update_one(  # noqa: F821
        {"student_id": student.student_id},
        {"$set": {"student_id": student.student_id, "dismissed_at": now}},
        upsert=True,
    )
    return {"ok": True}


# ── Student receipt list (for Portal history / unacknowledged check) ──────────

@api.get("/student/tuition/receipts")  # noqa: F821
async def student_tuition_receipts(
    limit: int = 10,
    student=Depends(require_student),  # noqa: F821
):
    """Return this student's tuition receipts (newest first)."""
    limit = min(limit, 50)
    cursor = db[_TTN_COLL_RECEIPTS].find(  # noqa: F821
        {"student_id": student.student_id},
        {"_id": 0},
    ).sort("confirmed_at", -1).limit(limit)
    docs = []
    async for doc in cursor:
        for k in ("confirmed_at", "acknowledged_at"):
            if isinstance(doc.get(k), datetime):
                doc[k] = doc[k].isoformat()
        docs.append(doc)
    return {"ok": True, "receipts": docs, "count": len(docs)}


@api.get("/student/tuition/unacknowledged")  # noqa: F821
async def student_tuition_unacknowledged(student=Depends(require_student)):  # noqa: F821
    """Return the most recent unacknowledged receipt, if any."""
    rec = await db[_TTN_COLL_RECEIPTS].find_one(  # noqa: F821
        {"student_id": student.student_id, "acknowledged_at": None},
        {"_id": 0},
        sort=[("confirmed_at", -1)],
    )
    if not rec:
        return {"ok": True, "pending": None}
    for k in ("confirmed_at", "acknowledged_at"):
        if isinstance(rec.get(k), datetime):
            rec[k] = rec[k].isoformat()
    return {"ok": True, "pending": rec}


# ── Admin: global config ──────────────────────────────────────────────────────

@api.get("/admin/tuition/config")  # noqa: F821
async def admin_tuition_get_config(admin=Depends(require_admin)):  # noqa: F821
    """Return global tuition config (enabled, points, push toggles)."""
    cfg = await _ttn_get_global_config()
    cfg.pop("_id", None)
    return {"ok": True, "config": cfg}


@api.put("/admin/tuition/config")  # noqa: F821
async def admin_tuition_set_config(payload: dict, admin=Depends(require_admin)):  # noqa: F821
    """Update global tuition config. Allowed fields only."""
    allowed = {
        "enabled", "default_points_per_usd",
        "payment_confirmed_push", "reward_push", "late_cutoff_days",
        "allow_advance_payment",
    }
    updates = {k: v for k, v in payload.items() if k in allowed}
    if not updates:
        raise HTTPException(status_code=400, detail="No valid config fields provided")  # noqa: F821
    updates["updated_at"] = _ttn_utcnow()
    await db[_TTN_COLL_CONFIG].update_one(  # noqa: F821
        {"type": "global_config"},
        {"$set": {"type": "global_config", **updates}},
        upsert=True,
    )
    return {"ok": True}


# ── Admin: reminder config ────────────────────────────────────────────────────

@api.get("/admin/tuition/reminder/config")  # noqa: F821
async def admin_reminder_get_config(admin=Depends(require_admin)):  # noqa: F821
    cfg = await _ttn_get_reminder_config()
    cfg.pop("_id", None)
    return {"ok": True, "config": cfg}


@api.put("/admin/tuition/reminder/config")  # noqa: F821
async def admin_reminder_set_config(payload: dict, admin=Depends(require_admin)):  # noqa: F821
    allowed = {
        "enabled", "title_km", "title_en", "body_km", "body_en",
        "cta_km", "cta_en", "audience", "selected_clean_ids",
        "due_window_days", "dismiss_hours", "dismiss_strategy",
        "frequency", "style",
    }
    updates = {k: v for k, v in payload.items() if k in allowed}
    if not updates:
        raise HTTPException(status_code=400, detail="No valid config fields provided")  # noqa: F821
    updates["updated_at"] = _ttn_utcnow()
    await db[_TTN_COLL_CONFIG].update_one(  # noqa: F821
        {"type": "reminder_config"},
        {"$set": {"type": "reminder_config", **updates}},
        upsert=True,
    )
    return {"ok": True}


# ── Admin: tuition accounts (account list + per-student edit) ─────────────────

@api.get("/admin/tuition/accounts")  # noqa: F821
async def admin_tuition_accounts(
    limit: int = 500,
    data_source: str | None = None,
    admin=Depends(require_admin),  # noqa: F821
):
    """List all Mongo tuition accounts with editable fields."""
    limit = min(limit, 1000)
    query = {}
    if data_source:
        query["data_source"] = data_source
    cursor = db[_TTN_COLL_RECORDS].find(query, {"_id": 0}).sort("clean_id", 1).limit(limit)  # noqa: F821
    records = []
    async for doc in cursor:
        for k in ("updated_at",):
            if isinstance(doc.get(k), datetime):
                doc[k] = doc[k].isoformat()
        records.append(doc)
    return {"ok": True, "records": records, "count": len(records)}


@api.patch("/admin/tuition/accounts/{student_id}")  # noqa: F821
async def admin_tuition_patch_account(
    student_id: str,
    payload: dict,
    admin=Depends(require_admin),  # noqa: F821
):
    """
    Update a tuition account's editable fields.
    Allowed: payment_amount, next_due_date, tuition_status, data_source,
             per_student_points_per_usd, payment_enabled.
    """
    allowed = {
        "payment_amount", "next_due_date", "tuition_status",
        "data_source", "per_student_points_per_usd", "payment_enabled",
    }
    updates = {k: v for k, v in payload.items() if k in allowed}
    if not updates:
        raise HTTPException(status_code=400, detail="No valid fields")  # noqa: F821
    # Validate data_source
    if "data_source" in updates and updates["data_source"] not in ("gas", "mongo_shadow", "mongo"):
        raise HTTPException(status_code=400, detail="data_source must be gas|mongo_shadow|mongo")  # noqa: F821
    # Validate tuition_status
    if "tuition_status" in updates and updates["tuition_status"] not in ("Paid", "Unpaid", "Pending"):
        raise HTTPException(status_code=400, detail="tuition_status must be Paid|Unpaid|Pending")  # noqa: F821
    updates["updated_at"] = _ttn_utcnow()
    updates["updated_by"] = "admin"
    result = await db[_TTN_COLL_RECORDS].update_one(  # noqa: F821
        {"student_id": student_id},
        {"$set": updates},
    )
    if result.matched_count == 0:
        raise HTTPException(status_code=404, detail="Tuition record not found")  # noqa: F821
    return {"ok": True}


# ── Admin: manual payment recording ──────────────────────────────────────────

@api.post("/admin/tuition/manual-payment")  # noqa: F821
async def admin_manual_payment(
    payload: dict,
    admin=Depends(require_admin),  # noqa: F821
):
    """
    Manually record a tuition payment on behalf of a student.

    Body: {
        student_id: str,       # MongoDB student UUID
        amount_usd: float,
        amount_khr: int,
        method: str,           # e.g. "cash" | "bank_transfer" | "khqr"
        reference: str,
        months_covered: int,   # default 1; advances billing anchor N times
        note: str | None,
    }
    """
    student_id    = (payload.get("student_id") or "").strip()
    amount_usd    = float(payload.get("amount_usd", 0))
    amount_khr    = int(payload.get("amount_khr", 0))
    method        = (payload.get("method") or "cash").strip()
    reference     = (payload.get("reference") or "").strip()
    months        = max(1, int(payload.get("months_covered", 1)))
    note          = (payload.get("note") or "").strip() or None

    if not student_id:
        raise HTTPException(status_code=400, detail="student_id required")  # noqa: F821
    if amount_usd <= 0:
        raise HTTPException(status_code=400, detail="amount_usd must be positive")  # noqa: F821

    # Validate student exists
    stu = await db.students.find_one(  # noqa: F821
        {"student_id": student_id}, {"_id": 0, "student_id": 1, "clean_id": 1}
    )
    if not stu:
        raise HTTPException(status_code=404, detail=f"Student {student_id!r} not found")  # noqa: F821
    clean_id = stu["clean_id"]

    # Idempotency: if reference already has a receipt, return it
    if reference:
        existing = await db[_TTN_COLL_RECEIPTS].find_one({"reference": reference, "student_id": student_id})  # noqa: F821
        if existing:
            return {
                "ok": True, "duplicate": True,
                "receipt_id": existing["receipt_id"],
                "message": "Already recorded (duplicate reference).",
            }

    today = _ttn_today_kh()

    # Get current ndd
    rec = await db[_TTN_COLL_RECORDS].find_one({"student_id": student_id})  # noqa: F821
    current_ndd = _ttn_parse_date(rec.get("next_due_date") if rec else None)
    new_due_date = _ttn_advance_billing_n(current_ndd, today, months)
    new_due_str  = _ttn_fmt_date(new_due_date)
    today_str    = _ttn_fmt_date(today)

    # Reward: manual payments never earn reward (admin-recorded)
    reward_pts = 0

    receipt_id = "rcpt_" + _ttn_secrets.token_hex(12)
    now = _ttn_utcnow()
    receipt_doc = {
        "receipt_id":       receipt_id,
        "student_id":       student_id,
        "clean_id":         clean_id,
        "amount_usd":       round(amount_usd, 2),
        "amount_khr":       amount_khr,
        "method":           method,
        "reference":        reference or f"MANUAL-{receipt_id}",
        "tuition_status":   "Paid",
        "prev_due_date":    _ttn_fmt_date(current_ndd) if current_ndd else None,
        "new_due_date":     new_due_str,
        "billing_anchor_day": new_due_date.day,
        "reward_points":    reward_pts,
        "reward_status":    None,
        "months_covered":   months,
        "note":             note,
        "confirmed_at":     now,
        "acknowledged_at":  None,
        "recorded_by":      "admin",
        "intent_id":        None,
    }
    await db[_TTN_COLL_RECEIPTS].insert_one(receipt_doc)  # noqa: F821

    data_source = rec.get("data_source", "mongo_shadow") if rec else "mongo_shadow"
    await db[_TTN_COLL_RECORDS].update_one(  # noqa: F821
        {"student_id": student_id},
        {"$set": {
            "student_id":       student_id,
            "clean_id":         clean_id,
            "tuition_status":   "Paid",
            "last_payment_date": today_str,
            "next_due_date":    new_due_str,
            "payment_amount":   round(amount_usd, 2),
            "data_source":      data_source,
            "updated_at":       now,
            "updated_by":       "admin",
            "last_receipt_id":  receipt_id,
        }},
        upsert=True,
    )

    if data_source in ("gas", "mongo_shadow"):
        try:
            await _update_tuition_in_gas(  # noqa: F821
                clean_id=clean_id,
                tuition_status="Paid",
                last_payment_date=today_str,
                next_due_date=new_due_str,
                payment_amount=str(round(amount_usd, 2)),
            )
        except Exception as e:
            _TTN_LOG.warning("admin_manual_payment: GAS shadow failed: %s", e)

    _TTN_LOG.info(
        "admin_manual_payment: student=%s months=%d new_due=%s receipt=%s admin=%s",
        clean_id, months, new_due_str, receipt_id, "admin",
    )
    return {
        "ok":           True,
        "receipt_id":   receipt_id,
        "new_due_date": new_due_str,
        "months_covered": months,
        "clean_id":     clean_id,
    }


# ── Admin: migration (dry-run → import → cutover) ────────────────────────────

@api.post("/admin/tuition/migration/dry-run")  # noqa: F821
async def admin_migration_dry_run(
    payload: dict,
    admin=Depends(require_admin),  # noqa: F821
):
    """
    Analyze potential GAS→Mongo import without writing anything.
    Returns per-student analysis: new, conflict, invalid, missing.
    Payload: { student_ids?: [str] }  — empty = analyze all active students
    """
    from bson import ObjectId as _OID
    target_ids = payload.get("student_ids") or []
    if target_ids:
        query: dict = {"student_id": {"$in": target_ids}, "is_active": True}
    else:
        query = {"is_active": True}

    students = await db.students.find(query, {"student_id": 1, "clean_id": 1, "_id": 0}).to_list(2000)  # noqa: F821
    report = {"new": [], "conflict": [], "invalid": [], "missing": [], "total": len(students)}

    for stu in students:
        sid = stu["student_id"]
        cid = stu["clean_id"]
        rec = await db[_TTN_COLL_RECORDS].find_one({"student_id": sid}, {"_id": 0})  # noqa: F821

        if not rec:
            report["missing"].append({"student_id": sid, "clean_id": cid, "reason": "no_mongo_shadow_record"})
            continue

        ndd_str = rec.get("next_due_date")
        ndd = _ttn_parse_date(ndd_str)
        if ndd_str and not ndd:
            report["invalid"].append({"student_id": sid, "clean_id": cid, "bad_date": ndd_str})
            continue

        ds = rec.get("data_source", "gas")
        if ds == "mongo":
            # Already migrated
            report["conflict"].append({
                "student_id": sid, "clean_id": cid,
                "reason": "already_mongo", "data_source": ds,
            })
        else:
            report["new"].append({
                "student_id": sid, "clean_id": cid,
                "current_source": ds,
                "next_due_date": ndd_str,
                "tuition_status": rec.get("tuition_status"),
                "payment_amount": rec.get("payment_amount"),
            })

    return {"ok": True, "dry_run": True, "report": report}


@api.post("/admin/tuition/migration/import")  # noqa: F821
async def admin_migration_import(
    payload: dict,
    admin=Depends(require_admin),  # noqa: F821
):
    """
    Flip qualifying records from gas/mongo_shadow → mongo_shadow (idempotent).
    Does NOT flip to full "mongo" mode — that requires explicit cutover.
    Payload: { student_ids?: [str] }
    """
    target_ids = payload.get("student_ids") or []
    query: dict = {"data_source": {"$in": ["gas"]}}
    if target_ids:
        query["student_id"] = {"$in": target_ids}

    now = _ttn_utcnow()
    result = await db[_TTN_COLL_RECORDS].update_many(  # noqa: F821
        query,
        {"$set": {"data_source": "mongo_shadow", "shadow_imported_at": now}},
    )
    _TTN_LOG.info(
        "admin_migration_import: matched=%d modified=%d",
        result.matched_count, result.modified_count,
    )
    return {
        "ok": True,
        "matched": result.matched_count,
        "modified": result.modified_count,
    }


@api.post("/admin/tuition/cutover")  # noqa: F821
async def admin_tuition_cutover(
    payload: dict,
    admin=Depends(require_admin),  # noqa: F821
):
    """
    Explicit Mongo cutover: flip selected (or all) records from mongo_shadow → mongo.

    After cutover: GAS writes are disabled for those students.
    Includes rollback warning when any mongo-primary receipts already exist.

    Payload: {
        student_ids?: [str],    # empty = all mongo_shadow records
        confirm: bool           # must be true to proceed
    }
    """
    if not payload.get("confirm"):
        # Return pre-flight info without writing
        shadow_count = await db[_TTN_COLL_RECORDS].count_documents({"data_source": "mongo_shadow"})  # noqa: F821
        mongo_count  = await db[_TTN_COLL_RECORDS].count_documents({"data_source": "mongo"})  # noqa: F821
        receipt_count = await db[_TTN_COLL_RECEIPTS].count_documents({})  # noqa: F821
        return {
            "ok": True,
            "confirm_required": True,
            "shadow_records_eligible": shadow_count,
            "already_mongo_records": mongo_count,
            "total_receipts": receipt_count,
            "rollback_warning": mongo_count > 0 or receipt_count > 0,
            "message": "Pass confirm=true to proceed.",
        }

    target_ids = payload.get("student_ids") or []
    query: dict = {"data_source": "mongo_shadow"}
    if target_ids:
        query["student_id"] = {"$in": target_ids}

    now = _ttn_utcnow()
    result = await db[_TTN_COLL_RECORDS].update_many(  # noqa: F821
        query,
        {"$set": {"data_source": "mongo", "cutover_at": now, "cutover_by": "admin"}},
    )
    _TTN_LOG.info(
        "admin_tuition_cutover: matched=%d modified=%d",
        result.matched_count, result.modified_count,
    )
    return {
        "ok": True,
        "matched": result.matched_count,
        "modified": result.modified_count,
        "cutover_at": now.isoformat(),
    }


_TTN_LOG.info(
    "tuition_tools: loaded — collections=%s/%s/%s/%s points_per_usd=%.1f intent_ttl_min=%d",
    _TTN_COLL_RECORDS, _TTN_COLL_INTENTS, _TTN_COLL_RECEIPTS, _TTN_COLL_CONFIG,
    _TTN_POINTS_PER_USD, _TTN_INTENT_TTL_MIN,
)
