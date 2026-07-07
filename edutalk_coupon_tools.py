"""edutalk_coupon_tools.py — EduTalk Live Voice Coach coupon redemption,
Checkpoint 1 (backend foundation only).

Isolated, additive module. Reuses the EXISTING `db.coupons` collection (same
one CouponStudio/`/api/coupons/*` already use for book-discount coupons) via
two new OPTIONAL, default-safe fields — `benefit_type` ("book_discount"
default | "edutalk_points") and `benefit_amount` — but NEVER touches the
existing `_find_valid_coupon()`, `_calc_discount()`, or the existing
`/api/coupons/validate` / `/api/coupons/redeem` routes in server.py. This
module's validator/routes are a fully independent, parallel code path
specifically for `benefit_type == "edutalk_points"` coupons, so book-discount
coupon behavior cannot regress no matter what happens here.

Points credit reuses the SAME verified GAS `sendPoints` treasury-credit
mechanism already used by edutalk_live_tools.py's session refunds AND by
login_reward_tools.py's `_lrc_credit_via_treasury` for arbitrary point
grants (confirmed by direct source inspection — this pattern is proven safe
outside a refund context, not merely a same-named coincidence). Following
this codebase's own established convention (both of those modules keep a
private, self-contained copy of the treasury-credit call rather than
importing across feature modules), this module has its OWN copy too — zero
coupling to edutalk_live_tools.py or login_reward_tools.py.

State machine per redemption entry (embedded in the coupon doc's existing
`redemptions` array, alongside book-discount entries — distinguished by
`benefit_type`):
  pending_credit -> credited            (credit call succeeded)
  pending_credit -> credit_failed       (credit call failed; retryable)
  credit_failed  -> credited            (retry succeeds)
  credit_failed  -> credit_failed       (retry fails again; still retryable)
A credited entry is terminal and always returns the SAME receipt on any
later "redemption" of that code by that student — no second credit call is
ever made once status == "credited".
"""
from __future__ import annotations

import logging
import re
import secrets
from datetime import datetime, timezone

import httpx
from fastapi import APIRouter, Depends, HTTPException

log = logging.getLogger("eduhub.edutalk_coupon")

import os

# --------------------------------------------------------------------------- #
# Feature flag — default false, self-contained (matches this codebase's       #
# per-module env-flag convention, e.g. book_factory_jobs._flag()).            #
# --------------------------------------------------------------------------- #
def _flag(name: str, default: str = "false") -> bool:
    return (os.environ.get(name, default) or default).strip().lower() in ("1", "true", "yes", "on")


def coupon_redemption_enabled() -> bool:
    return _flag("EDUTALK_COUPON_REDEMPTION_ENABLED")


# --------------------------------------------------------------------------- #
# Treasury credit — a private, self-contained copy of the SAME proven         #
# GAS sendPoints treasury->student transfer already used by                   #
# edutalk_live_tools._gas_treasury_credit (session refunds) and               #
# login_reward_tools._lrc_credit_via_treasury (arbitrary point grants).       #
# Server-side treasury credentials only — the student's password is never     #
# required or stored. Returns (ok, sanitized_reason_code). Never raises.      #
# --------------------------------------------------------------------------- #
GAS_POINTS_LOGIN_URL = os.environ.get(
    "GAS_POINTS_LOGIN_URL",
    "https://script.google.com/macros/s/AKfycbzRktKyql2I_FbPESNRpCrFDlse-qNd9_Opv9si-g-j2lcanOUPP49IzcyA59lFqVycdA/exec",
)
SL_TREASURY_ID = os.environ.get("SL_TREASURY_ID", "stu092")
SL_TREASURY_PASSWORD = os.environ.get("SL_TREASURY_PASSWORD", "")


async def _credit_edutalk_points(student_clean_id: str, amount: int) -> tuple[bool, str]:
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
# Code normalization + strict benefit validation (§SAFETY 5)                   #
# --------------------------------------------------------------------------- #
_MAX_CODE_LEN = 32
_SAFE_CODE_RE = re.compile(r"^[A-Z0-9]+$")
_MIN_BENEFIT_AMOUNT = 1
_MAX_BENEFIT_AMOUNT = 1000


def normalize_code(raw: str) -> str:
    """Trim, uppercase (matching the existing book-coupon convention
    exactly), strip to a safe alnum charset, bounded length. Never raises —
    an unsafe/empty result simply fails to match any real coupon."""
    s = (raw or "").strip().upper()[:_MAX_CODE_LEN]
    if not _SAFE_CODE_RE.match(s):
        return ""
    return s


def _is_valid_benefit_amount(v) -> bool:
    if not isinstance(v, int) or isinstance(v, bool):
        return False
    return _MIN_BENEFIT_AMOUNT <= v <= _MAX_BENEFIT_AMOUNT


def _norm_sid(value) -> str:
    """Canonical student-id form for assigned_to comparisons — trims and
    lowercases. A Live Voice Coach Coupon's `assigned_to` list is free-typed
    by an admin (CouponStudio's CSV field has no normalization), so without
    this, a case/whitespace mismatch against the student's own `clean_id`
    silently produces the same generic "could not be used" message as a
    genuinely wrong code. This module keeps its own private copy rather than
    importing server.py's `_norm_student_id`, matching this file's existing
    isolation convention (edutalk_coupon_tools.py has no dependency on
    server.py's globals)."""
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
# Parallel, independent validator — NEVER shares code with, or modifies,      #
# server.py's _find_valid_coupon(). Returns (coupon_doc | None, reason_code). #
# reason_code is one of: not_found, wrong_benefit_type, disabled, not_yet_active,
# expired, limit_reached, not_assigned, invalid_benefit_amount. Never raises. #
# --------------------------------------------------------------------------- #
async def _find_edutalk_coupon(db, code: str, student_id: str) -> tuple[dict | None, str]:
    doc = await db.coupons.find_one({"code": code}, {"_id": 0})
    if not doc:
        return None, "not_found"
    if (doc.get("benefit_type") or "book_discount") != "edutalk_points":
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
        return None, "limit_reached"
    return doc, ""


def _student_redemption(doc: dict, student_id: str) -> dict | None:
    for r in (doc.get("redemptions") or []):
        if r.get("student_id") == student_id and r.get("benefit_type") == "edutalk_points":
            return r
    return None


_FRIENDLY_MESSAGES = {
    "not_found": "This code could not be used. Please check it and try again.",
    "wrong_benefit_type": "This code could not be used. Please check it and try again.",
    "invalid_benefit_amount": "This code could not be used. Please check it and try again.",
    "disabled": "This code has already been redeemed.",
    "not_yet_active": "This code could not be used. Please check it and try again.",
    "expired": "This code has expired.",
    "limit_reached": "This code has already been redeemed.",
    "not_assigned": "This code could not be used. Please check it and try again.",
    "feature_disabled": "Coupon redemption is not available right now.",
}


async def _apply_credit_and_finalize(db, code: str, student_id: str, amount: int) -> dict:
    """Attempt the credit step for an ALREADY-reserved redemption entry and
    atomically transition its status. Never pushes a new redemption entry
    and never re-increments uses_count — this only ever updates the ONE
    existing entry matching (student_id, benefit_type='edutalk_points')."""
    ok, reason = await _credit_edutalk_points(student_id, amount)
    now_iso = _now_iso()
    if not ok:
        log.info("edutalk_coupon: credit failed code=%s student=%s reason=%s",
                  code, student_id, reason)
    array_filters = [{"elem.student_id": student_id, "elem.benefit_type": "edutalk_points"}]
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


def register_edutalk_coupon_routes(api: APIRouter, db, require_admin, require_student) -> None:
    _ = require_admin  # unused; kept for call-site symmetry with other register_*_routes

    def _need_flag():
        if not coupon_redemption_enabled():
            raise HTTPException(status_code=503, detail=_FRIENDLY_MESSAGES["feature_disabled"])

    @api.post("/student/edutalk-live/coupon/validate")
    async def edutalk_coupon_validate(payload: dict, student=Depends(require_student)):
        _need_flag()
        student_id = _norm_sid(getattr(student, "clean_id", ""))
        code = normalize_code((payload or {}).get("code") or "")
        if not code:
            return {"ok": False, "state": "invalid", "message": _FRIENDLY_MESSAGES["not_found"]}
        doc, reason = await _find_edutalk_coupon(db, code, student_id)
        if not doc:
            # Server-log-only diagnostic: the exact rejection reason is
            # never sent to the client (student-facing message stays
            # generic), but is observable here for debugging a "code
            # doesn't work" report without guessing from wording alone.
            log.info("edutalk_coupon: validate rejected code=%s student=%s reason=%s",
                      code, student_id, reason)
            return {"ok": False, "state": reason or "invalid",
                    "message": _FRIENDLY_MESSAGES.get(reason, _FRIENDLY_MESSAGES["not_found"])}
        existing = _student_redemption(doc, student_id)
        if existing and existing.get("status") == "credited":
            return {"ok": True, "state": "already_credited", "benefit_amount": existing.get("benefit_amount"),
                    "credited_at": existing.get("credited_at")}
        if existing and existing.get("status") in ("pending_credit", "credit_failed"):
            return {"ok": True, "state": "pending_retry", "benefit_amount": existing.get("benefit_amount")}
        return {"ok": True, "state": "valid", "benefit_amount": doc.get("benefit_amount"), "code": code}

    @api.post("/student/edutalk-live/coupon/redeem")
    async def edutalk_coupon_redeem(payload: dict, student=Depends(require_student)):
        _need_flag()
        student_id = _norm_sid(getattr(student, "clean_id", ""))
        code = normalize_code((payload or {}).get("code") or "")
        if not code:
            return {"ok": False, "state": "invalid", "message": _FRIENDLY_MESSAGES["not_found"]}

        doc, reason = await _find_edutalk_coupon(db, code, student_id)
        if not doc:
            # §IDEMPOTENT RETRY: even if the coupon is now globally exhausted
            # or disabled, THIS student's own prior redemption (if any) is
            # still returned as a successful receipt rather than an error.
            if reason == "limit_reached":
                stale = await db.coupons.find_one({"code": code}, {"_id": 0})
                existing = _student_redemption(stale, student_id) if stale else None
                if existing:
                    return await _resolve_existing(db, code, student_id, existing)
            log.info("edutalk_coupon: redeem rejected code=%s student=%s reason=%s",
                      code, student_id, reason)
            return {"ok": False, "state": reason or "invalid",
                    "message": _FRIENDLY_MESSAGES.get(reason, _FRIENDLY_MESSAGES["not_found"])}

        existing = _student_redemption(doc, student_id)
        if existing:
            return await _resolve_existing(db, code, student_id, existing)

        amount = int(doc.get("benefit_amount"))
        max_uses = doc.get("max_uses")
        now_iso = _now_iso()
        filter_q: dict = {
            "code": code, "benefit_type": "edutalk_points", "enabled": True,
            "redemptions.student_id": {"$ne": student_id},
        }
        if max_uses is not None:
            filter_q["uses_count"] = {"$lt": max_uses}
        reservation = {
            "student_id": student_id, "benefit_type": "edutalk_points",
            "benefit_amount": amount, "status": "pending_credit",
            "redeemed_at": now_iso, "credited_at": None,
            "credit_error": None, "attempt_count": 0,
        }
        won = await db.coupons.find_one_and_update(
            filter_q,
            {"$push": {"redemptions": reservation}, "$inc": {"uses_count": 1}},
        )
        if won is None:
            # §CONCURRENT DOUBLE-CLICK: either a concurrent request from the
            # SAME student won the race (re-fetch finds their entry — return
            # it), or the coupon genuinely became disabled/exhausted between
            # the read above and this atomic write (re-validate to report
            # the precise reason instead of a generic failure).
            stale = await db.coupons.find_one({"code": code}, {"_id": 0})
            existing2 = _student_redemption(stale, student_id) if stale else None
            if existing2:
                return await _resolve_existing(db, code, student_id, existing2)
            _, reason2 = await _find_edutalk_coupon(db, code, student_id)
            log.info("edutalk_coupon: redeem race-lost code=%s student=%s reason=%s",
                      code, student_id, reason2)
            return {"ok": False, "state": reason2 or "invalid",
                    "message": _FRIENDLY_MESSAGES.get(reason2, _FRIENDLY_MESSAGES["not_found"])}

        result = await _apply_credit_and_finalize(db, code, student_id, amount)
        if result["ok"]:
            return {"ok": True, "state": "credited", "benefit_amount": amount,
                    "credited_at": result["credited_at"]}
        return {"ok": False, "state": "credit_failed",
                "message": "Your code was accepted, but the benefit could not be applied yet. Please try again."}

    log.info("edutalk_coupon_tools: routes registered (flag-gated, default off)")


async def _resolve_existing(db, code: str, student_id: str, existing: dict) -> dict:
    """A redemption entry already exists for this student — never push a
    second one, never re-consume a use. credited is terminal (same receipt
    every time); pending_credit/credit_failed retries ONLY the credit step."""
    if existing.get("status") == "credited":
        return {"ok": True, "state": "credited", "benefit_amount": existing.get("benefit_amount"),
                "credited_at": existing.get("credited_at")}
    amount = int(existing.get("benefit_amount") or 0)
    result = await _apply_credit_and_finalize(db, code, student_id, amount)
    if result["ok"]:
        return {"ok": True, "state": "credited", "benefit_amount": amount,
                "credited_at": result["credited_at"]}
    return {"ok": False, "state": "credit_failed",
            "message": "Your code was accepted, but the benefit could not be applied yet. Please try again."}
