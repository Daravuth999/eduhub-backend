"""video_library_coupon_tools.py — Video Library coupon/voucher redemption.

Additive, fully isolated module — mirrors edutalk_coupon_tools.py's proven
template (same db.coupons collection, same benefit_type discrimination
field, same pending_credit -> credited state machine, same idempotent-retry
and concurrent-redemption handling) but with its OWN benefit_type value
("video_library_points") so it can never be confused with a book-discount
or Live Voice Coach coupon.

2026-09 (Video Library coupons round) — TWO changes from the prior design,
both re-verified against current code first, per this round's explicit
"do not guess" rule:

  1. PERCENT OFFER TYPE (§1). A video_library_points coupon now carries an
     optional `type` field: "percent" (discount a lesson's PRICE at
     purchase time — see video_library_tools.py's initiate_purchase,
     which imports find_valid_percent_coupon/apply_percent_discount/
     finalize_percent_coupon_use from this module) or "points" (default —
     the ORIGINAL flat-points-grant shape, unchanged for every coupon that
     predates this field). coupon_tools.py's create_coupon validates the
     percent-over-100 rule identically to its own book_discount branch.
     A percent-type coupon is NEVER accepted by this module's own
     validate/redeem routes below (`_find_video_library_coupon` returns
     "wrong_redemption_flow" for one) — it has no meaning outside a
     specific purchase's price, so it can only be applied there.

  2. RESTRICTED BALANCE, NOT THE SHARED GAS WALLET (§2). The prior-round
     lead claimed this credits "the SAME shared GAS points wallet
     (wallet_service.py)". Verified false on both counts: wallet_service.py
     is a DORMANT "Phase 1 Preflight" migration layer (its own docstring:
     "never activated... no live behavior changes unless an explicit phase
     flag is enabled") that this module never touched anyway — the actual
     prior mechanism was a raw GAS `sendPoints` HTTP treasury transfer
     (`_credit_video_library_points`, now REMOVED). A "points" coupon now
     credits video_library_restricted_points.py's brand-new, genuinely
     separate Mongo ledger instead — real, immediately spendable currency,
     but ONLY for Video Library purchases (video_library_tools.py's
     initiate_purchase spends it first, before touching the real GAS
     balance — see that module for the exact ordering). This is a strict
     simplification, not just a swap: crediting is now a single atomic
     Mongo write with no network call, so "credit_failed" (still handled,
     for defense-in-depth) should be far rarer than the old GAS-HTTP path
     ever was.

Never touches: server.py's book-discount `_find_valid_coupon`/
`_calc_discount`/`/api/coupons/*` routes, edutalk_coupon_tools.py, or
video_library_points_adapter.py's own debit-purchase code path.
"""
from __future__ import annotations

import logging
import os
import re
from datetime import datetime, timezone
from typing import Optional

from fastapi import APIRouter, Depends, HTTPException

import video_library_restricted_points as restricted_points

log = logging.getLogger("eduhub.video_library_coupon")

BENEFIT_TYPE = "video_library_points"
OFFER_TYPE_PERCENT = "percent"
OFFER_TYPE_POINTS = "points"


# --------------------------------------------------------------------------- #
# Feature flag — default false, self-contained.                              #
# --------------------------------------------------------------------------- #
def _flag(name: str, default: str = "false") -> bool:
    return (os.environ.get(name, default) or default).strip().lower() in ("1", "true", "yes", "on")


def coupon_redemption_enabled() -> bool:
    return _flag("VIDEO_LIBRARY_COUPON_REDEMPTION_ENABLED")


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


def _is_valid_percent_value(v) -> bool:
    return isinstance(v, (int, float)) and not isinstance(v, bool) and 0 < v <= 100


def _offer_type(doc: dict) -> str:
    """A coupon predating this field (`type` is None/absent) is the
    ORIGINAL "points" shape — never reinterpreted as anything else."""
    return doc.get("type") if doc.get("type") in (OFFER_TYPE_PERCENT, OFFER_TYPE_POINTS) else OFFER_TYPE_POINTS


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


def _coupon_time_window_ok(doc: dict) -> Optional[str]:
    """Shared expiry/valid_from check — returns a reason string on
    failure, None when the window is fine. Used by both the points
    validator below and the percent-purchase validator in
    video_library_tools.py's call path."""
    now = datetime.now(timezone.utc)
    vf = _parse_iso(doc.get("valid_from"))
    if vf and now < vf:
        return "not_yet_active"
    ex = _parse_iso(doc.get("expires_at"))
    if ex and now > ex:
        return "expired"
    return None


# --------------------------------------------------------------------------- #
# Parallel, independent validator — never shares code with, or modifies,      #
# server.py's _find_valid_coupon() or edutalk_coupon_tools.py's own           #
# validator. Returns (coupon_doc | None, reason_code). Never raises.          #
# Handles the "points" offer type ONLY — a "percent" coupon is rejected      #
# with "wrong_redemption_flow" (see find_valid_percent_coupon below for the  #
# purchase-time equivalent).                                                 #
# --------------------------------------------------------------------------- #
async def _find_video_library_coupon(db, code: str, student_id: str) -> tuple[dict | None, str]:
    doc = await db.coupons.find_one({"code": code}, {"_id": 0})
    if not doc:
        return None, "not_found"
    if (doc.get("benefit_type") or "book_discount") != BENEFIT_TYPE:
        return None, "wrong_benefit_type"
    if _offer_type(doc) == OFFER_TYPE_PERCENT:
        return None, "wrong_redemption_flow"
    if not _is_valid_benefit_amount(doc.get("benefit_amount")):
        return None, "invalid_benefit_amount"
    if not doc.get("enabled", True):
        return None, "disabled"
    window_reason = _coupon_time_window_ok(doc)
    if window_reason:
        return None, window_reason
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
    "wrong_redemption_flow": "This code is a purchase discount — apply it when buying a video lesson, not here.",
    "invalid_benefit_amount": "This code is not configured correctly. Please contact your teacher.",
    "disabled": "This code is not currently active.",
    "not_yet_active": "This code is not active yet.",
    "expired": "This code has expired.",
    "global_limit_reached": "This code has already reached its usage limit.",
    "not_assigned": "This code is not assigned to this account.",
    "flag_disabled": "Voucher redemption is not available right now.",
    "credit_failed": "Your code was accepted, but the points could not be applied yet. Please try again.",
}


# --------------------------------------------------------------------------- #
# §1/§2 — percent-type coupon: purchase-time lookup + discount application.  #
# Imported and called by video_library_tools.py's initiate_purchase; never   #
# reachable from this module's own validate/redeem routes (see              #
# _find_video_library_coupon's "wrong_redemption_flow" guard above).         #
# --------------------------------------------------------------------------- #
async def find_valid_percent_coupon(db, code: str, student_id: str) -> tuple[dict | None, str]:
    """Same shape of checks as _find_video_library_coupon, but for a
    "percent" offer type coupon, and WITHOUT the points-specific
    benefit_amount check (a percent coupon has no benefit_amount at all).
    A student may use a given percent code once (tracked in its own
    `redemptions` the same way points coupons are, keyed on `benefit_type`
    == BENEFIT_TYPE and a `code` field — the code itself IS the uniqueness
    scope, not any one lesson, since a percent voucher isn't tied to a
    specific lesson at creation time)."""
    doc = await db.coupons.find_one({"code": code}, {"_id": 0})
    if not doc:
        return None, "not_found"
    if (doc.get("benefit_type") or "book_discount") != BENEFIT_TYPE:
        return None, "wrong_benefit_type"
    if _offer_type(doc) != OFFER_TYPE_PERCENT:
        return None, "wrong_redemption_flow"
    if not _is_valid_percent_value(doc.get("value")):
        return None, "invalid_benefit_amount"
    if not doc.get("enabled", True):
        return None, "disabled"
    window_reason = _coupon_time_window_ok(doc)
    if window_reason:
        return None, window_reason
    assigned_to = doc.get("assigned_to") or []
    if assigned_to and _norm_sid(student_id) not in {_norm_sid(x) for x in assigned_to}:
        return None, "not_assigned"
    if _student_redemption(doc, student_id):
        return None, "already_used"
    max_uses = doc.get("max_uses")
    if max_uses is not None and doc.get("uses_count", 0) >= max_uses:
        return None, "global_limit_reached"
    return doc, ""


def apply_percent_discount(original_price: int, coupon: dict) -> int:
    """Identical formula to coupon_tools.py's own `_calc_discount` percent
    branch — deliberately copied verbatim (not imported: this module never
    depends on coupon_tools.py's internals, matching the established
    per-feature-isolation convention) so a Video Library percent coupon
    behaves exactly like a book-discount percent coupon."""
    value = float(coupon.get("value") or 0)
    discount = round(original_price * value / 100)
    return max(0, original_price - discount)


async def finalize_percent_coupon_use(db, code: str, student_id: str, *, lesson_id: str,
                                       original_price: int, discounted_price: int) -> None:
    """Records the percent coupon's use — called ONLY after the purchase
    it discounted has actually SUCCEEDED (video_library_tools.py's
    initiate_purchase). A coupon that discounted a purchase which then
    failed/needs reconciliation must NOT be marked used — see that
    module's outcome handling for exactly when this is (and isn't)
    called. Best-effort: a failure here never un-does an already-
    succeeded purchase (the discount was already applied to the amount
    actually charged); it only means the code could theoretically be
    reused, which is logged loudly for admin follow-up rather than
    silently swallowed."""
    now_iso = _now_iso()
    redemption = {
        "student_id": student_id, "benefit_type": BENEFIT_TYPE,
        "code": code, "lesson_id": lesson_id,
        "original_price": original_price, "discounted_price": discounted_price,
        "redeemed_at": now_iso,
    }
    try:
        await db.coupons.update_one(
            {"code": code},
            {"$push": {"redemptions": redemption}, "$inc": {"uses_count": 1}},
        )
    except Exception as exc:  # noqa: BLE001
        log.warning(
            "video_library_coupon: FAILED to record percent-coupon use — code=%s student=%s "
            "lesson=%s (purchase already succeeded; code may be reusable until fixed): %s",
            code, student_id, lesson_id, exc,
        )


# --------------------------------------------------------------------------- #
# §4 — Khmer/English bilingual push notification on successful redemption.   #
# Follows the established "points credited" bilingual convention (see       #
# server.py's Teacher Awards Points / Speaking Lab treasury pushes) — the    #
# closest real precedent, since this also credits a points-shaped balance.  #
# Individual words/phrases below reuse this codebase's own established      #
# Khmer vocabulary (ពិន្ទុ="points", បានបន្ថែម="added/credited") where a      #
# precedent exists; the "Video Library only" qualifier is new phrasing not  #
# reviewed by a native speaker — see this round's report for that caveat,   #
# stated honestly rather than presented as certified-correct.               #
# --------------------------------------------------------------------------- #
def _compose_redemption_notification(amount: int) -> tuple[str, str]:
    title = f"🎉 +{amount} ពិន្ទុវីដេអូបានបន្ថែម! / Video Points Credited!"
    body = (
        f"អ្នកទទួលបាន +{amount} ពិន្ទុ សម្រាប់តែការទិញនៅបណ្ណាល័យវីដេអូប៉ុណ្ណោះ ✨\n"
        f"You received +{amount} points — spendable only on Video Library purchases."
    )
    return title, body


async def _send_redemption_push(fan_out_push, student_id: str, amount: int, *, code: str) -> None:
    if not callable(fan_out_push):
        return
    title, body = _compose_redemption_notification(amount)
    try:
        await fan_out_push(
            {"studentId": student_id}, title=title, body=body, url="/library/video",
            category="vouchers", dedupe_key=f"video_library_coupon_credit:{code}:{student_id}",
        )
    except Exception as exc:  # noqa: BLE001 — a push failure must never affect the credit that already applied
        log.warning("video_library_coupon: push notification failed code=%s student=%s: %s",
                     code, student_id, exc)


# --------------------------------------------------------------------------- #
# §2 — restricted-balance credit. Replaces the removed GAS treasury call.    #
# --------------------------------------------------------------------------- #
async def _apply_credit_and_finalize(db, code: str, student_id: str, amount: int, *,
                                      fan_out_push=None) -> dict:
    now_iso = _now_iso()
    try:
        await restricted_points.credit(
            db, student_id, amount,
            source="video_library_coupon", source_ref=code,
            idempotency_key=f"video_library_coupon:{code}:{student_id}",
        )
        ok, reason = True, ""
    except Exception as exc:  # noqa: BLE001 — a ledger write failure must never surface as a raw 500
        ok, reason = False, f"restricted_credit_error_{type(exc).__name__}"
        log.warning("video_library_coupon: restricted credit failed code=%s student=%s reason=%s",
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
        await _send_redemption_push(fan_out_push, student_id, amount, code=code)
        return {"ok": True, "state": "credited", "benefit_amount": amount, "credited_at": now_iso}
    await db.coupons.update_one(
        {"code": code},
        {"$set": {"redemptions.$[elem].status": "credit_failed",
                  "redemptions.$[elem].credit_error": reason},
         "$inc": {"redemptions.$[elem].attempt_count": 1}},
        array_filters=array_filters,
    )
    return {"ok": False, "state": "credit_failed", "reason": reason}


async def _resolve_existing(db, code: str, student_id: str, existing: dict, *, fan_out_push=None) -> dict:
    if existing.get("status") == "credited":
        return {"ok": True, "state": "credited", "benefit_amount": existing.get("benefit_amount"),
                "credited_at": existing.get("credited_at")}
    amount = int(existing.get("benefit_amount") or 0)
    result = await _apply_credit_and_finalize(db, code, student_id, amount, fan_out_push=fan_out_push)
    if result["ok"]:
        return {"ok": True, "state": "credited", "benefit_amount": amount,
                "credited_at": result["credited_at"]}
    return {"ok": False, "state": "credit_failed",
            "message": _FRIENDLY_MESSAGES["credit_failed"]}


# --------------------------------------------------------------------------- #
# §3 — list the student's currently-available Video Library coupons.        #
# Read-only. Shows a coupon ONLY if it is real, currently redeemable, and    #
# not already used up by THIS student — never an expired/exhausted/         #
# already-redeemed-by-this-student coupon (same checks _find_video_library_ #
# coupon and find_valid_percent_coupon already enforce server-side, reused  #
# here rather than re-implemented).                                         #
# --------------------------------------------------------------------------- #
async def list_available_coupons(db, student_id: str) -> list[dict]:
    sid = _norm_sid(student_id)
    cursor = db.coupons.find({"benefit_type": BENEFIT_TYPE, "enabled": True}, {"_id": 0})
    out: list[dict] = []
    async for doc in cursor:
        offer = _offer_type(doc)
        if offer == OFFER_TYPE_POINTS:
            valid_doc, reason = await _find_video_library_coupon(db, doc.get("code", ""), sid)
            # _find_video_library_coupon's own "already redeemed" handling
            # is deliberately permissive when max_uses is unlimited (its
            # caller, the /redeem route, branches on _student_redemption
            # itself to show "already_redeemed" rather than rejecting) —
            # so a coupon this student has ALREADY credited would
            # otherwise still show here as "available". Checked
            # explicitly: this listing must never show a coupon the
            # student can't actually still use.
            existing = _student_redemption(valid_doc, sid) if valid_doc else None
            if existing and existing.get("status") == "credited":
                continue  # fully done — not "pending_credit"/"credit_failed", which are still retryable
        else:
            valid_doc, reason = await find_valid_percent_coupon(db, doc.get("code", ""), sid)
        if not valid_doc:
            continue
        entry = {
            "code": valid_doc.get("code"),
            "type": offer,
            "expiresAt": valid_doc.get("expires_at"),
        }
        if offer == OFFER_TYPE_POINTS:
            entry["benefitAmount"] = valid_doc.get("benefit_amount")
        else:
            entry["percentOff"] = valid_doc.get("value")
        out.append(entry)
    return out


def register_video_library_coupon_routes(api: APIRouter, db, require_admin, require_student,
                                          *, fan_out_push=None) -> None:
    _ = require_admin  # unused; kept for call-site symmetry with other register_*_routes

    def _need_flag():
        if not coupon_redemption_enabled():
            raise HTTPException(status_code=503, detail=_FRIENDLY_MESSAGES["flag_disabled"])

    @api.get("/student/video-library/coupon/status")
    async def video_library_coupon_status(student=Depends(require_student)):
        _ = student
        return {"enabled": coupon_redemption_enabled()}

    @api.get("/student/video-library/coupons")
    async def video_library_coupons_available(student=Depends(require_student)):
        """§3 — proactive listing of coupons the student can actually use
        right now, for the browse-page coupon panel. Distinct from
        /coupon/validate, which checks one specific code the student
        already has in hand."""
        if not coupon_redemption_enabled():
            return {"coupons": []}
        student_id = _norm_sid(getattr(student, "clean_id", ""))
        coupons = await list_available_coupons(db, student_id)
        return {"coupons": coupons}

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
                    return await _resolve_existing(db, code, student_id, existing, fan_out_push=fan_out_push)
            log.info("video_library_coupon: redeem rejected code=%s student=%s reason=%s",
                      code, student_id, reason)
            return {"ok": False, "state": reason or "not_found",
                    "message": _FRIENDLY_MESSAGES.get(reason, _FRIENDLY_MESSAGES["not_found"])}

        existing = _student_redemption(doc, student_id)
        if existing:
            return await _resolve_existing(db, code, student_id, existing, fan_out_push=fan_out_push)

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
                return await _resolve_existing(db, code, student_id, existing2, fan_out_push=fan_out_push)
            _, reason2 = await _find_video_library_coupon(db, code, student_id)
            log.info("video_library_coupon: redeem race-lost code=%s student=%s reason=%s",
                      code, student_id, reason2)
            return {"ok": False, "state": reason2 or "not_found",
                    "message": _FRIENDLY_MESSAGES.get(reason2, _FRIENDLY_MESSAGES["not_found"])}

        result = await _apply_credit_and_finalize(db, code, student_id, amount, fan_out_push=fan_out_push)
        if result["ok"]:
            return {"ok": True, "state": "credited", "benefit_amount": amount,
                    "credited_at": result["credited_at"]}
        return {"ok": False, "state": "credit_failed",
                "message": _FRIENDLY_MESSAGES["credit_failed"]}

    log.info("video_library_coupon_tools: routes registered (flag-gated, default off)")
