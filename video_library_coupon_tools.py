"""video_library_coupon_tools.py — Video Library coupon/voucher redemption.

Additive, fully isolated module — mirrors edutalk_coupon_tools.py's proven
template exactly (same db.coupons collection, same benefit_type/
benefit_amount discrimination fields, same pending_credit -> credited state
machine, same idempotent-retry and concurrent-redemption handling) but with
its OWN benefit_type value ("video_library_points") so it can never be
confused with a book-discount or Live Voice Coach coupon, and its OWN
private treasury-credit copy so no feature module ever depends on another's
internals — matching this codebase's own established per-feature-isolation
convention (see video_library_points_adapter.py's own docstring for the
identical rationale on the debit side).

Why "video_library_points" credits the SAME shared GAS points balance
(not a separate Video Library ledger): video_library_points_adapter.py's
own docstring confirms Video Library lesson PURCHASES already debit that
one authoritative GAS balance (`debit_purchase`) — there is no separate
Video Library points ledger to credit into. A coupon that credits GAS
points therefore gives the student real, immediately spendable currency
for buying more video lessons, exactly mirroring how the existing EduTalk
points coupon works for its own product.

Never touches: server.py's book-discount `_find_valid_coupon`/
`_calc_discount`/`/api/coupons/*` routes, edutalk_coupon_tools.py, or
video_library_points_adapter.py's own debit-purchase code path.
"""
from __future__ import annotations

import logging
import os
import re
import secrets
from datetime import datetime, timezone

import httpx
from fastapi import APIRouter, Depends, HTTPException

log = logging.getLogger("eduhub.video_library_coupon")

BENEFIT_TYPE = "video_library_points"


# --------------------------------------------------------------------------- #
# Feature flag — default false, self-contained.                              #
# --------------------------------------------------------------------------- #
def _flag(name: str, default: str = "false") -> bool:
    return (os.environ.get(name, default) or default).strip().lower() in ("1", "true", "yes", "on")


def coupon_redemption_enabled() -> bool:
    return _flag("VIDEO_LIBRARY_COUPON_REDEMPTION_ENABLED")


# --------------------------------------------------------------------------- #
# Treasury credit — a private, self-contained copy of the SAME proven GAS     #
# sendPoints treasury->student transfer edutalk_coupon_tools.py,              #
# edutalk_live_tools.py, and login_reward_tools.py already use. Server-side   #
# treasury credentials only — the student's own password is never required   #
# or stored. Returns (ok, sanitized_reason_code). Never raises.               #
# --------------------------------------------------------------------------- #
GAS_POINTS_LOGIN_URL = os.environ.get(
    "GAS_POINTS_LOGIN_URL",
    "https://script.google.com/macros/s/AKfycbzRktKyql2I_FbPESNRpCrFDlse-qNd9_Opv9si-g-j2lcanOUPP49IzcyA59lFqVycdA/exec",
)
SL_TREASURY_ID = os.environ.get("SL_TREASURY_ID", "stu092")
SL_TREASURY_PASSWORD = os.environ.get("SL_TREASURY_PASSWORD", "")


async def _credit_video_library_points(student_clean_id: str, amount: int) -> tuple[bool, str]:
    if amount <= 0:
        return True, "nothing_to_credit"
    if not SL_TREASURY_PASSWORD:
        return False, "treasury_password_not_configured"
    if not GAS_POINTS_LOGIN_URL:
        return False, "gas_url_not_configured"
    payload = {
        "action": "sendPoints",
        "id": SL_TREASURY_ID,
        "password": SL_TREASURY_PASSWORD,
        "receiverId": student_clean_id,
        "amount": str(int(amount)),
        "nonce": secrets.token_hex(12),
    }
    try:
        async with httpx.AsyncClient(
            timeout=httpx.Timeout(12.0, connect=6.0), follow_redirects=True,
        ) as cli:
            r = await cli.post(GAS_POINTS_LOGIN_URL, data=payload)
        if r.status_code != 200:
            return False, f"gas_http_{r.status_code}"
        try:
            j = r.json()
        except Exception:
            return False, "gas_non_json"
        if isinstance(j, dict) and j.get("success") is True:
            return True, ""
        return False, "gas_rejected"
    except Exception as exc:  # noqa: BLE001
        return False, f"transport_{type(exc).__name__}"


# --------------------------------------------------------------------------- #
# Code normalization + strict benefit validation                             #
# --------------------------------------------------------------------------- #
_MAX_CODE_LEN = 32
_SAFE_CODE_RE = re.compile(r"^[A-Z0-9]+$")
_MIN_BENEFIT_AMOUNT = 1
_MAX_BENEFIT_AMOUNT = 1000


def normalize_code(raw: str) -> str:
    s = (raw or "").strip().upper()[:_MAX_CODE_LEN]
    if not _SAFE_CODE_RE.match(s):
        return ""
    return s


def _is_valid_benefit_amount(v) -> bool:
    if not isinstance(v, int) or isinstance(v, bool):
        return False
    return _MIN_BENEFIT_AMOUNT <= v <= _MAX_BENEFIT_AMOUNT


def _norm_sid(value) -> str:
    if value is None:
        return ""
    return str(value).strip().lower()


def _now_iso() -> str:
    return datetime.now(timezone.utc).isoformat()


def _parse_iso(v):
    if not v:
        return None
    dt = datetime.fromisoformat(v) if isinstance(v, str) else v
    if dt.tzinfo is None:
        dt = dt.replace(tzinfo=timezone.utc)
    return dt


# --------------------------------------------------------------------------- #
# Parallel, independent validator — never shares code with, or modifies,      #
# server.py's _find_valid_coupon() or edutalk_coupon_tools.py's own           #
# validator. Returns (coupon_doc | None, reason_code). Never raises.          #
# --------------------------------------------------------------------------- #
async def _find_video_library_coupon(db, code: str, student_id: str) -> tuple[dict | None, str]:
    doc = await db.coupons.find_one({"code": code}, {"_id": 0})
    if not doc:
        return None, "not_found"
    if (doc.get("benefit_type") or "book_discount") != BENEFIT_TYPE:
        return None, "wrong_benefit_type"
    if not _is_valid_benefit_amount(doc.get("benefit_amount")):
        return None, "invalid_benefit_amount"
    if not doc.get("enabled", True):
        return None, "disabled"
    now = datetime.now(timezone.utc)
    vf = _parse_iso(doc.get("valid_from"))
    if vf and now < vf:
        return None, "not_yet_active"
    ex = _parse_iso(doc.get("expires_at"))
    if ex and now > ex:
        return None, "expired"
    assigned_to = doc.get("assigned_to") or []
    if assigned_to and _norm_sid(student_id) not in {_norm_sid(x) for x in assigned_to}:
        return None, "not_assigned"
    max_uses = doc.get("max_uses")
    already_redeemed = _student_redemption(doc, student_id)
    if max_uses is not None and doc.get("uses_count", 0) >= max_uses and not already_redeemed:
        return None, "global_limit_reached"
    return doc, ""


def _student_redemption(doc: dict, student_id: str) -> dict | None:
    for r in (doc.get("redemptions") or []):
        if r.get("student_id") == student_id and r.get("benefit_type") == BENEFIT_TYPE:
            return r
    return None


_FRIENDLY_MESSAGES = {
    "not_found": "This code could not be used. Please check it and try again.",
    "wrong_benefit_type": "This code is not a Video Library voucher.",
    "invalid_benefit_amount": "This code is not configured correctly. Please contact your teacher.",
    "disabled": "This code is not currently active.",
    "not_yet_active": "This code is not active yet.",
    "expired": "This code has expired.",
    "global_limit_reached": "This code has already reached its usage limit.",
    "not_assigned": "This code is not assigned to this account.",
    "flag_disabled": "Voucher redemption is not available right now.",
    "credit_failed": "Your code was accepted, but the points could not be applied yet. Please try again.",
}


async def _apply_credit_and_finalize(db, code: str, student_id: str, amount: int) -> dict:
    ok, reason = await _credit_video_library_points(student_id, amount)
    now_iso = _now_iso()
    if not ok:
        log.info("video_library_coupon: credit failed code=%s student=%s reason=%s",
                  code, student_id, reason)
    array_filters = [{"elem.student_id": student_id, "elem.benefit_type": BENEFIT_TYPE}]
    if ok:
        await db.coupons.update_one(
            {"code": code},
            {"$set": {"redemptions.$[elem].status": "credited",
                      "redemptions.$[elem].credited_at": now_iso,
                      "redemptions.$[elem].credit_error": None}},
            array_filters=array_filters,
        )
        return {"ok": True, "state": "credited", "benefit_amount": amount, "credited_at": now_iso}
    await db.coupons.update_one(
        {"code": code},
        {"$set": {"redemptions.$[elem].status": "credit_failed",
                  "redemptions.$[elem].credit_error": reason},
         "$inc": {"redemptions.$[elem].attempt_count": 1}},
        array_filters=array_filters,
    )
    return {"ok": False, "state": "credit_failed", "reason": reason}


async def _resolve_existing(db, code: str, student_id: str, existing: dict) -> dict:
    if existing.get("status") == "credited":
        return {"ok": True, "state": "credited", "benefit_amount": existing.get("benefit_amount"),
                "credited_at": existing.get("credited_at")}
    amount = int(existing.get("benefit_amount") or 0)
    result = await _apply_credit_and_finalize(db, code, student_id, amount)
    if result["ok"]:
        return {"ok": True, "state": "credited", "benefit_amount": amount,
                "credited_at": result["credited_at"]}
    return {"ok": False, "state": "credit_failed",
            "message": _FRIENDLY_MESSAGES["credit_failed"]}


def register_video_library_coupon_routes(api: APIRouter, db, require_admin, require_student) -> None:
    _ = require_admin  # unused; kept for call-site symmetry with other register_*_routes

    def _need_flag():
        if not coupon_redemption_enabled():
            raise HTTPException(status_code=503, detail=_FRIENDLY_MESSAGES["flag_disabled"])

    @api.get("/student/video-library/coupon/status")
    async def video_library_coupon_status(student=Depends(require_student)):
        _ = student
        return {"enabled": coupon_redemption_enabled()}

    @api.post("/student/video-library/coupon/validate")
    async def video_library_coupon_validate(payload: dict, student=Depends(require_student)):
        _need_flag()
        student_id = _norm_sid(getattr(student, "clean_id", ""))
        code = normalize_code((payload or {}).get("code") or "")
        if not code:
            return {"ok": False, "state": "not_found", "message": _FRIENDLY_MESSAGES["not_found"]}
        doc, reason = await _find_video_library_coupon(db, code, student_id)
        if not doc:
            log.info("video_library_coupon: validate rejected code=%s student=%s reason=%s",
                      code, student_id, reason)
            return {"ok": False, "state": reason or "not_found",
                    "message": _FRIENDLY_MESSAGES.get(reason, _FRIENDLY_MESSAGES["not_found"])}
        existing = _student_redemption(doc, student_id)
        if existing and existing.get("status") == "credited":
            return {"ok": True, "state": "already_redeemed", "benefit_amount": existing.get("benefit_amount"),
                    "credited_at": existing.get("credited_at")}
        if existing and existing.get("status") in ("pending_credit", "credit_failed"):
            return {"ok": True, "state": "pending_retry", "benefit_amount": existing.get("benefit_amount")}
        return {"ok": True, "state": "valid", "benefit_amount": doc.get("benefit_amount"), "code": code}

    @api.post("/student/video-library/coupon/redeem")
    async def video_library_coupon_redeem(payload: dict, student=Depends(require_student)):
        _need_flag()
        student_id = _norm_sid(getattr(student, "clean_id", ""))
        code = normalize_code((payload or {}).get("code") or "")
        if not code:
            return {"ok": False, "state": "not_found", "message": _FRIENDLY_MESSAGES["not_found"]}

        doc, reason = await _find_video_library_coupon(db, code, student_id)
        if not doc:
            if reason == "global_limit_reached":
                stale = await db.coupons.find_one({"code": code}, {"_id": 0})
                existing = _student_redemption(stale, student_id) if stale else None
                if existing:
                    return await _resolve_existing(db, code, student_id, existing)
            log.info("video_library_coupon: redeem rejected code=%s student=%s reason=%s",
                      code, student_id, reason)
            return {"ok": False, "state": reason or "not_found",
                    "message": _FRIENDLY_MESSAGES.get(reason, _FRIENDLY_MESSAGES["not_found"])}

        existing = _student_redemption(doc, student_id)
        if existing:
            return await _resolve_existing(db, code, student_id, existing)

        amount = int(doc.get("benefit_amount"))
        max_uses = doc.get("max_uses")
        now_iso = _now_iso()
        filter_q: dict = {
            "code": code, "benefit_type": BENEFIT_TYPE, "enabled": True,
            "redemptions.student_id": {"$ne": student_id},
        }
        if max_uses is not None:
            filter_q["uses_count"] = {"$lt": max_uses}
        reservation = {
            "student_id": student_id, "benefit_type": BENEFIT_TYPE,
            "benefit_amount": amount, "status": "pending_credit",
            "redeemed_at": now_iso, "credited_at": None,
            "credit_error": None, "attempt_count": 0,
        }
        won = await db.coupons.find_one_and_update(
            filter_q,
            {"$push": {"redemptions": reservation}, "$inc": {"uses_count": 1}},
        )
        if won is None:
            stale = await db.coupons.find_one({"code": code}, {"_id": 0})
            existing2 = _student_redemption(stale, student_id) if stale else None
            if existing2:
                return await _resolve_existing(db, code, student_id, existing2)
            _, reason2 = await _find_video_library_coupon(db, code, student_id)
            log.info("video_library_coupon: redeem race-lost code=%s student=%s reason=%s",
                      code, student_id, reason2)
            return {"ok": False, "state": reason2 or "not_found",
                    "message": _FRIENDLY_MESSAGES.get(reason2, _FRIENDLY_MESSAGES["not_found"])}

        result = await _apply_credit_and_finalize(db, code, student_id, amount)
        if result["ok"]:
            return {"ok": True, "state": "credited", "benefit_amount": amount,
                    "credited_at": result["credited_at"]}
        return {"ok": False, "state": "credit_failed",
                "message": _FRIENDLY_MESSAGES["credit_failed"]}

    log.info("video_library_coupon_tools: routes registered (flag-gated, default off)")
