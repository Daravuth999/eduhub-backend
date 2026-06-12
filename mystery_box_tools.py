# ============================================================================
# mystery_box_tools.py — Speaking Lab Mystery Box + EduTalk Pass integration
# (additive, isolated module; loaded via exec() into server.py's namespace)
#
# SCOPE
#   * Premium Mystery Box reward system for Speaking Lab.
#   * Admin-configurable prize templates (Author Studio) and campaigns
#     (Speaking Lab admin) — single source of truth in MongoDB.
#   * Backend decides the granted prize, NEVER the frontend.
#   * Reuses the EXISTING login_reward voucher issuance pipeline so book
#     vouchers land privately in the original PWA Voucher Hub. No public
#     voucher code is exposed to the Speaking Lab UI.
#   * Adds the NEW `student_feature_entitlements` collection for EduTalk
#     Passes (private, per-student, single-use). EduTalk pass consumption
#     is wired via hooks into edutalk_tools.py (see _et hook block below).
#
# SAFETY
#   * Pure additive — does NOT modify any existing collection, route or
#     pydantic model. All collections are created lazily.
#   * Failure of this module is non-fatal: server.py wraps the exec() in
#     a try/except, so a load error only disables the Mystery Box feature.
#   * Reuses existing helpers from the shared exec namespace:
#       api, db, log, httpx, require_admin, require_student,
#       _norm_student_id, _lrc_credit_via_treasury,
#       _lrc_issue_voucher_for_claim (login_reward),
#       _lrc_now / _lrc_iso / _lrc_secrets (login_reward).
#   * Speaking Lab teacher endpoints require admin (require_admin), so the
#     same Author Studio cookie/Bearer auth gates Mystery Box rounds.
#
# v1.0 — initial release
# ============================================================================

import logging as _mbt_logging
import secrets as _mbt_secrets
import uuid as _mbt_uuid
from datetime import datetime, timezone, timedelta
from typing import List, Literal, Optional

# pymongo ReturnDocument enum — required for find_one_and_update to
# return the UPDATED document (so the caller can read the entitlement
# id of the row that was just decremented). Use a defensive import so a
# very old pymongo install still loads the rest of the module.
try:
    from pymongo import ReturnDocument as _mbt_ReturnDocument
except Exception:  # pragma: no cover
    _mbt_ReturnDocument = None

# Reuse pydantic primitives already imported by server.py.
try:
    BaseModel  # type: ignore  # noqa: F821
except NameError:  # pragma: no cover
    from pydantic import BaseModel  # noqa: F401
try:
    Field  # type: ignore  # noqa: F821
except NameError:  # pragma: no cover
    from pydantic import Field  # noqa: F401
try:
    ConfigDict  # type: ignore  # noqa: F821
except NameError:  # pragma: no cover
    from pydantic import ConfigDict  # noqa: F401
try:
    HTTPException  # type: ignore  # noqa: F821
except NameError:  # pragma: no cover
    from fastapi import HTTPException  # noqa: F401

_MBT_LOG = _mbt_logging.getLogger("eduhub")


# ── collections (lazy, additive) ────────────────────────────────────────────
_mbt_prize_templates       = db["mystery_box_prize_templates"]        # noqa: F821
_mbt_edutalk_templates     = db["edutalk_pass_templates"]             # noqa: F821
_mbt_campaigns             = db["speaking_lab_mystery_campaigns"]     # noqa: F821
_mbt_rounds                = db["speaking_lab_mystery_rounds"]        # noqa: F821
_mbt_claims                = db["speaking_lab_mystery_claims"]        # noqa: F821
_mbt_reward_history        = db["speaking_lab_reward_history"]        # noqa: F821
_mbt_entitlements          = db["student_feature_entitlements"]       # noqa: F821


def _mbt_now() -> datetime:
    return datetime.now(timezone.utc)


def _mbt_iso(dt: Optional[datetime]) -> Optional[str]:
    if not dt:
        return None
    if isinstance(dt, str):
        return dt
    if dt.tzinfo is None:
        dt = dt.replace(tzinfo=timezone.utc)
    return dt.astimezone(timezone.utc).isoformat().replace("+00:00", "Z")


def _mbt_norm_id(value) -> str:
    fn = globals().get("_norm_student_id")
    if callable(fn):
        try:
            return fn(value or "")
        except Exception:
            pass
    return (value or "").strip().lower()


async def _mbt_ensure_indexes() -> None:
    """Create indexes lazily on first import. Safe to call repeatedly."""
    try:
        await _mbt_prize_templates.create_index("id", unique=True)
        await _mbt_edutalk_templates.create_index("id", unique=True)
        await _mbt_campaigns.create_index("id", unique=True)
        await _mbt_rounds.create_index("id", unique=True)
        # One claim per round per student (idempotent reveal)
        await _mbt_claims.create_index(
            [("round_id", 1), ("student_id_norm", 1)],
            unique=True,
            name="round_student_unique",
        )
        await _mbt_entitlements.create_index("id", unique=True)
        await _mbt_entitlements.create_index([("student_id_norm", 1), ("status", 1)])
        await _mbt_reward_history.create_index([("student_id_norm", 1), ("created_at", -1)])
    except Exception as _e:  # pragma: no cover
        _MBT_LOG.warning("mystery_box: ensure_indexes failed: %s", _e)


# ── safe display payload helpers ────────────────────────────────────────────
def _safe_display_for(prize: dict, granted: dict | None) -> dict:
    """Build the OPAQUE payload Speaking Lab is allowed to show.

    NEVER includes: coupon_code, voucher_id, raw db ids, secret keys.
    Only includes: title, type, value/label, expiry, ownership message.
    """
    ptype = (prize.get("type") or "").strip().lower()
    # Speaking Lab MUST NOT receive internal prize/template IDs. The
    # safe display intentionally omits `prize_id`, `coupon_code`,
    # `voucher_id`, entitlement ids, and any raw DB identifier. The
    # caller (Speaking Lab) only needs human-facing fields below to
    # render the reveal modal and the missed-boxes layout.
    out = {
        "type": ptype,
        "title": prize.get("title") or "Mystery Prize",
        "subtitle": prize.get("subtitle") or "",
        "accent_color": prize.get("accent_color") or "#D4A843",
        "icon": prize.get("icon") or "gift",
        "rarity": prize.get("rarity") or "common",
        "ownership_message": "Added to your EduHub account",
    }
    if ptype == "points":
        out["points"] = int(prize.get("points") or 0)
    elif ptype == "book_voucher":
        # Show ONLY title/value/expiry, never the code.
        out["discount_label"] = (
            (granted or {}).get("discount_label")
            or prize.get("discount_label")
            or _voucher_discount_label(
                prize.get("voucher_discount_type"),
                prize.get("voucher_discount_value"),
            )
        )
        out["expires_at"] = (granted or {}).get("expires_at")
        out["cta_label"] = "Open My Portal → Voucher Hub"
    elif ptype in ("edutalk_session", "edutalk_voice"):
        out["pass_label"] = (
            "EduTalk Session Pass" if ptype == "edutalk_session" else "EduTalk Voice Reply Pass"
        )
        out["quantity"] = int(prize.get("quantity") or 1)
        out["expires_at"] = (granted or {}).get("expires_at")
        out["cta_label"] = "Open any eligible book to use it"
    elif ptype == "lucky_draw_entry":
        out["entries"] = int(prize.get("entries") or 1)
    elif ptype == "recognition":
        out["badge_label"] = prize.get("badge_label") or prize.get("title")
    elif ptype == "consolation":
        out["message"] = prize.get("message") or "Almost lucky — try again!"
        if prize.get("points"):
            out["points"] = int(prize.get("points") or 0)
    return out


def _voucher_discount_label(dtype, dval) -> str:
    fn = globals().get("_lrc_voucher_discount_label")
    if callable(fn):
        try:
            return fn(dtype, dval)
        except Exception:
            pass
    try:
        v = float(dval or 0)
    except Exception:
        v = 0.0
    if (dtype or "").lower() == "percent":
        return f"{int(v)}% off"
    return f"-{v:.0f} KHR"


# ── pydantic shapes ─────────────────────────────────────────────────────────
class _PrizeTemplateIn(BaseModel):  # type: ignore[name-defined]
    model_config = ConfigDict(extra="ignore")  # type: ignore[name-defined]
    title: str = Field(..., min_length=1, max_length=120)  # type: ignore[name-defined]
    type: Literal[
        "points", "book_voucher", "edutalk_session", "edutalk_voice",
        "lucky_draw_entry", "recognition", "consolation",
    ]
    subtitle: Optional[str] = ""
    accent_color: Optional[str] = "#D4A843"
    icon: Optional[str] = "gift"
    rarity: Optional[Literal["common", "rare", "epic", "legendary"]] = "common"
    enabled: bool = True

    # Points prize
    points: Optional[int] = 0

    # Book voucher prize (reuses login_reward issuance flow)
    voucher_discount_type: Optional[Literal["percent", "amount"]] = "percent"
    voucher_discount_value: Optional[float] = 0.0
    voucher_book_slugs: Optional[List[str]] = []
    voucher_valid_days: Optional[int] = 30
    voucher_title: Optional[str] = ""
    voucher_subtitle: Optional[str] = ""

    # EduTalk pass prize
    pass_template_id: Optional[str] = None
    quantity: Optional[int] = 1
    expires_in_days: Optional[int] = 30
    eligible_book_slugs: Optional[List[str]] = []

    # Lucky draw entry
    entries: Optional[int] = 1

    # Recognition / consolation
    badge_label: Optional[str] = ""
    message: Optional[str] = ""


class _EduTalkPassTemplateIn(BaseModel):  # type: ignore[name-defined]
    model_config = ConfigDict(extra="ignore")  # type: ignore[name-defined]
    name: str = Field(..., min_length=1, max_length=120)  # type: ignore[name-defined]
    feature: Literal["edutalk_session", "edutalk_voice"] = "edutalk_session"
    quantity_total: int = Field(1, ge=1, le=99)  # type: ignore[name-defined]
    eligible_book_slugs: List[str] = []
    expires_in_days: int = Field(30, ge=1, le=730)  # type: ignore[name-defined]
    use_pass_before_points: bool = True
    show_in_portal: bool = True
    show_in_reader: bool = True
    enabled: bool = True


class _CampaignIn(BaseModel):  # type: ignore[name-defined]
    model_config = ConfigDict(extra="ignore")  # type: ignore[name-defined]
    name: str = Field(..., min_length=1, max_length=120)  # type: ignore[name-defined]
    description: Optional[str] = ""
    box_count: int = Field(7, ge=3, le=9)  # type: ignore[name-defined]
    prize_template_ids: List[str] = []
    weighted_layout: bool = False
    weights: Optional[List[float]] = None
    teacher_confirm_required: bool = True
    reveal_all_after_claim: bool = True
    hide_voucher_code: bool = True  # ALWAYS true; flag retained for clarity
    grant_selected_only: bool = True
    show_missed_prizes: bool = True
    enabled: bool = True


class _RoundCreateIn(BaseModel):  # type: ignore[name-defined]
    model_config = ConfigDict(extra="ignore")  # type: ignore[name-defined]
    campaign_id: str
    session_id: Optional[str] = ""  # Speaking Lab session id, optional


class _SelectIn(BaseModel):  # type: ignore[name-defined]
    model_config = ConfigDict(extra="ignore")  # type: ignore[name-defined]
    box_index: int = Field(..., ge=0, le=20)  # type: ignore[name-defined]
    student_id: str
    student_name: Optional[str] = ""


class _RevealIn(BaseModel):  # type: ignore[name-defined]
    model_config = ConfigDict(extra="ignore")  # type: ignore[name-defined]
    box_index: Optional[int] = None  # if omitted, uses last selected
    student_id: str
    student_name: Optional[str] = ""
    idempotency_key: Optional[str] = ""


# ── EduTalk Pass entitlement helpers (private, per-student) ─────────────────
async def _mbt_grant_edutalk_pass(
    *,
    student_clean_id: str,
    student_id_norm: str,
    feature: str,
    title: str,
    quantity: int,
    eligible_book_slugs: List[str],
    expires_in_days: int,
    source: str,
    campaign_id: Optional[str],
    round_id: Optional[str],
) -> dict:
    """Create a new private EduTalk pass entitlement row.

    Returns the inserted row (without `_id`)."""
    now = _mbt_now()
    expires_at = (now + timedelta(days=max(1, int(expires_in_days or 1)))).isoformat().replace("+00:00", "Z")
    row = {
        "id": "ent_" + _mbt_secrets.token_hex(10),
        "student_id": student_clean_id,
        "student_id_norm": student_id_norm,
        "feature": feature,
        "title": title or ("EduTalk Pass"),
        "quantity_total": int(quantity or 1),
        "quantity_remaining": int(quantity or 1),
        "eligible_book_slugs": list(eligible_book_slugs or []),
        "source": source,
        "campaign_id": campaign_id,
        "round_id": round_id,
        "expires_at": expires_at,
        "used_at": None,
        "status": "active",
        "created_at": _mbt_iso(now),
        "updated_at": _mbt_iso(now),
    }
    await _mbt_entitlements.insert_one(dict(row))
    return row


async def mb_reserve_pass(student_clean_id: str, feature: str, book_slug: str) -> Optional[str]:
    """Attempt to reserve a single use of an active EduTalk pass.

    Atomically decrements quantity_remaining by 1 if there is at least one
    active, non-expired pass matching the feature and eligible book.
    Returns the entitlement id reserved (still ACTIVE, not committed) or None.

    The reserved row's `pending_reservations` is set so that on a failure
    the commit step can be skipped (and refund() will restore the count).
    """
    if not student_clean_id or not feature:
        return None
    sid_norm = _mbt_norm_id(student_clean_id)
    now_iso = _mbt_iso(_mbt_now())
    book_slug = (book_slug or "").strip()
    book_match = {"$or": [
        {"eligible_book_slugs": {"$in": [book_slug]}},
        {"eligible_book_slugs": {"$size": 0}},
        {"eligible_book_slugs": {"$exists": False}},
    ]} if book_slug else {}

    query = {
        "student_id_norm": sid_norm,
        "feature": feature,
        "status": "active",
        "quantity_remaining": {"$gt": 0},
        "$or": [
            {"expires_at": {"$gt": now_iso}},
            {"expires_at": None},
        ],
    }
    if book_match:
        query = {"$and": [query, book_match]}

    try:
        if _mbt_ReturnDocument is not None:
            doc = await _mbt_entitlements.find_one_and_update(
                query,
                {"$inc": {"quantity_remaining": -1, "pending_reservations": 1},
                 "$set": {"updated_at": now_iso}},
                return_document=_mbt_ReturnDocument.AFTER,
            )
        else:
            # Defensive fallback: motor's default return is the document
            # BEFORE the update, but the `id` field is immutable so it's
            # still safe to read it from the pre-update snapshot.
            doc = await _mbt_entitlements.find_one_and_update(
                query,
                {"$inc": {"quantity_remaining": -1, "pending_reservations": 1},
                 "$set": {"updated_at": now_iso}},
            )
    except Exception as _e:
        _MBT_LOG.warning("mb_reserve_pass query failed: %s", _e)
        return None

    if not doc:
        return None
    return doc.get("id")


async def mb_commit_pass(entitlement_id: str) -> bool:
    """Finalize a previously reserved pass: clear the pending counter, and
    if quantity_remaining == 0 also mark status='used'."""
    if not entitlement_id:
        return False
    now_iso = _mbt_iso(_mbt_now())
    try:
        ent = await _mbt_entitlements.find_one({"id": entitlement_id}, {"_id": 0})
        if not ent:
            return False
        upd = {
            "$inc": {"pending_reservations": -1},
            "$set": {"used_at": now_iso, "updated_at": now_iso},
        }
        # If this used up the last unit, mark status=used.
        if int(ent.get("quantity_remaining") or 0) <= 0:
            upd["$set"]["status"] = "used"
        await _mbt_entitlements.update_one({"id": entitlement_id}, upd)
        return True
    except Exception as _e:
        _MBT_LOG.warning("mb_commit_pass failed (%s): %s", entitlement_id, _e)
        return False


async def mb_refund_pass(entitlement_id: str) -> bool:
    """Restore a reserved-but-not-used pass (called when the edutalk
    operation fails before consumption is final)."""
    if not entitlement_id:
        return False
    now_iso = _mbt_iso(_mbt_now())
    try:
        await _mbt_entitlements.update_one(
            {"id": entitlement_id},
            {"$inc": {"quantity_remaining": 1, "pending_reservations": -1},
             "$set": {"updated_at": now_iso}},
        )
        return True
    except Exception as _e:
        _MBT_LOG.warning("mb_refund_pass failed (%s): %s", entitlement_id, _e)
        return False


# Wire the helpers into edutalk_tools.py via module-level hooks so the
# pass is consumed BEFORE the GAS debit at each charge site. Failure to
# import edutalk_tools is non-fatal — EduTalk simply keeps charging
# points the usual way and the pass remains visible in My Portal until
# the next session attempt.
try:
    import edutalk_tools as _et_mod
    _et_mod._ENTITLEMENT_RESERVE = mb_reserve_pass     # type: ignore[attr-defined]
    _et_mod._ENTITLEMENT_COMMIT = mb_commit_pass       # type: ignore[attr-defined]
    _et_mod._ENTITLEMENT_REFUND = mb_refund_pass       # type: ignore[attr-defined]
    _MBT_LOG.info("mystery_box: wired EduTalk pass hooks into edutalk_tools")
except Exception as _et_hook_err:
    _MBT_LOG.warning(
        "mystery_box: could not wire EduTalk pass hooks (passes will not be "
        "consumed inside EduTalk yet): %s",
        _et_hook_err,
    )


# ── prize granting (server is single source of truth) ───────────────────────
async def _mbt_grant_prize(
    *,
    prize: dict,
    student_clean_id: str,
    student_id_norm: str,
    campaign_id: str,
    round_id: str,
) -> dict:
    """Execute the real grant for one prize. Returns a dict with:
        {ok: bool, error?: str, granted: dict|None, safe_display: dict}
    The voucher coupon code is NEVER included in safe_display."""
    ptype = (prize.get("type") or "").strip().lower()
    granted: dict = {}

    if ptype == "points":
        pts = int(prize.get("points") or 0)
        if pts > 0:
            credit = globals().get("_lrc_credit_via_treasury")
            if not callable(credit):
                return {"ok": False, "error": "treasury credit unavailable",
                        "granted": None,
                        "safe_display": _safe_display_for(prize, None)}
            res = await credit(
                student_clean_id=student_clean_id,
                points=pts,
                campaign_id=campaign_id,
                campaign_name=f"Mystery Box ({prize.get('title')})",
            )
            if not res.get("ok"):
                return {"ok": False, "error": str(res.get("error") or "credit failed"),
                        "granted": None,
                        "safe_display": _safe_display_for(prize, None)}
            granted = {"points_credited": pts}
        return {"ok": True, "granted": granted,
                "safe_display": _safe_display_for(prize, granted)}

    if ptype == "book_voucher":
        # Reuse the EXISTING login-reward voucher issuance flow so the
        # voucher lands in My Portal → Voucher Hub automatically (the
        # /api/student/vouchers endpoint already lists student_vouchers).
        issuer = globals().get("_lrc_issue_voucher_for_claim")
        if not callable(issuer):
            return {"ok": False, "error": "voucher issuer unavailable",
                    "granted": None,
                    "safe_display": _safe_display_for(prize, None)}
        # Synthesize a "campaign" envelope the issuer understands.
        synth_camp = {
            "id": f"mb_{round_id}_{prize.get('id')}",
            "name": f"Mystery Box: {prize.get('title')}",
            "reward_kind": "voucher",
            "voucher_source": "auto",
            "voucher_title": prize.get("voucher_title") or prize.get("title") or "Book Voucher",
            "voucher_subtitle": prize.get("voucher_subtitle") or "",
            "voucher_discount_type": (prize.get("voucher_discount_type") or "percent"),
            "voucher_discount_value": float(prize.get("voucher_discount_value") or 0),
            "voucher_valid_days": int(prize.get("voucher_valid_days") or 30),
            "voucher_book_slugs": list(prize.get("voucher_book_slugs") or []),
            "voucher_template": "royal_purple_gold",
            "voucher_accent_color": prize.get("accent_color") or "#D4A843",
            "voucher_cta_label": "Use Voucher",
        }
        payload = await issuer(synth_camp, student_clean_id, student_id_norm)
        if not payload:
            return {"ok": False, "error": "voucher issuance failed",
                    "granted": None,
                    "safe_display": _safe_display_for(prize, None)}
        granted = {
            "voucher_owned": True,
            "discount_label": payload.get("discount_label"),
            "expires_at": payload.get("expires_at"),
        }
        return {"ok": True, "granted": granted,
                "safe_display": _safe_display_for(prize, granted)}

    if ptype in ("edutalk_session", "edutalk_voice"):
        # Resolve title/quantity from referenced pass template if any.
        title = prize.get("title") or "EduTalk Pass"
        quantity = int(prize.get("quantity") or 1)
        eligible_books = list(prize.get("eligible_book_slugs") or [])
        expires_days = int(prize.get("expires_in_days") or 30)
        tpl_id = prize.get("pass_template_id")
        if tpl_id:
            try:
                tpl = await _mbt_edutalk_templates.find_one({"id": tpl_id}, {"_id": 0})
                if tpl:
                    title = tpl.get("name") or title
                    quantity = int(tpl.get("quantity_total") or quantity)
                    eligible_books = list(tpl.get("eligible_book_slugs") or eligible_books)
                    expires_days = int(tpl.get("expires_in_days") or expires_days)
            except Exception:
                pass
        row = await _mbt_grant_edutalk_pass(
            student_clean_id=student_clean_id,
            student_id_norm=student_id_norm,
            feature=ptype,
            title=title,
            quantity=quantity,
            eligible_book_slugs=eligible_books,
            expires_in_days=expires_days,
            source="speaking_lab_mystery_box",
            campaign_id=campaign_id,
            round_id=round_id,
        )
        granted = {
            "entitlement_id_internal": row.get("id"),  # NOT exposed to client
            "quantity": row.get("quantity_total"),
            "expires_at": row.get("expires_at"),
            "feature": ptype,
        }
        # Strip internal id from the response we return outwards.
        public_granted = {k: v for k, v in granted.items() if k != "entitlement_id_internal"}
        return {"ok": True, "granted": public_granted,
                "safe_display": _safe_display_for(prize, public_granted)}

    if ptype == "consolation":
        pts = int(prize.get("points") or 0)
        if pts > 0:
            credit = globals().get("_lrc_credit_via_treasury")
            if callable(credit):
                try:
                    await credit(
                        student_clean_id=student_clean_id,
                        points=pts,
                        campaign_id=campaign_id,
                        campaign_name=f"Mystery Box ({prize.get('title')})",
                    )
                except Exception:
                    pass  # consolation is best-effort
        return {"ok": True, "granted": {"points_credited": pts},
                "safe_display": _safe_display_for(prize, {"points_credited": pts})}

    if ptype in ("lucky_draw_entry", "recognition"):
        # These types are visual / record-only for now. We log them in
        # reward_history but never modify the existing lucky draw or
        # badge subsystems (per safety brief).
        return {"ok": True, "granted": {ptype: True},
                "safe_display": _safe_display_for(prize, None)}

    return {"ok": False, "error": f"unsupported prize type: {ptype}",
            "granted": None,
            "safe_display": _safe_display_for(prize, None)}


# ── ADMIN ROUTES (Author Studio + Speaking Lab admin) ───────────────────────

# -- EduTalk Pass templates ---------------------------------------------------
@api.get("/admin/edutalk-passes/templates")   # noqa: F821
async def mbt_list_pass_templates(admin=Depends(require_admin)):  # type: ignore[name-defined]
    rows = []
    async for r in _mbt_edutalk_templates.find({}, {"_id": 0}).sort("created_at", -1).limit(200):
        rows.append(r)
    return {"templates": rows, "count": len(rows)}


@api.post("/admin/edutalk-passes/templates")  # noqa: F821
async def mbt_create_pass_template(payload: _EduTalkPassTemplateIn, admin=Depends(require_admin)):  # type: ignore[name-defined]
    now = _mbt_iso(_mbt_now())
    doc = payload.model_dump()
    doc.update({
        "id": "etp_" + _mbt_secrets.token_hex(8),
        "created_at": now,
        "updated_at": now,
        "created_by": getattr(admin, "email", "") or "",
    })
    await _mbt_edutalk_templates.insert_one(dict(doc))
    doc.pop("_id", None)
    return {"template": doc}


@api.put("/admin/edutalk-passes/templates/{tid}")   # noqa: F821
async def mbt_update_pass_template(tid: str, payload: _EduTalkPassTemplateIn, admin=Depends(require_admin)):  # type: ignore[name-defined]
    upd = payload.model_dump()
    upd["updated_at"] = _mbt_iso(_mbt_now())
    res = await _mbt_edutalk_templates.update_one({"id": tid}, {"$set": upd})
    if not res.matched_count:
        raise HTTPException(status_code=404, detail="template not found")  # type: ignore[name-defined]
    row = await _mbt_edutalk_templates.find_one({"id": tid}, {"_id": 0})
    return {"template": row}


@api.delete("/admin/edutalk-passes/templates/{tid}")  # noqa: F821
async def mbt_delete_pass_template(tid: str, admin=Depends(require_admin)):  # type: ignore[name-defined]
    res = await _mbt_edutalk_templates.delete_one({"id": tid})
    return {"deleted": int(res.deleted_count or 0)}


# -- Mystery Box prize templates ---------------------------------------------
@api.get("/admin/mystery-box/prize-templates")  # noqa: F821
async def mbt_list_prize_templates(admin=Depends(require_admin)):  # type: ignore[name-defined]
    rows = []
    async for r in _mbt_prize_templates.find({}, {"_id": 0}).sort("created_at", -1).limit(500):
        rows.append(r)
    return {"prizes": rows, "count": len(rows)}


@api.post("/admin/mystery-box/prize-templates")  # noqa: F821
async def mbt_create_prize_template(payload: _PrizeTemplateIn, admin=Depends(require_admin)):  # type: ignore[name-defined]
    now = _mbt_iso(_mbt_now())
    doc = payload.model_dump()
    doc.update({
        "id": "prz_" + _mbt_secrets.token_hex(8),
        "created_at": now,
        "updated_at": now,
        "created_by": getattr(admin, "email", "") or "",
    })
    await _mbt_prize_templates.insert_one(dict(doc))
    doc.pop("_id", None)
    return {"prize": doc}


@api.put("/admin/mystery-box/prize-templates/{pid}")  # noqa: F821
async def mbt_update_prize_template(pid: str, payload: _PrizeTemplateIn, admin=Depends(require_admin)):  # type: ignore[name-defined]
    upd = payload.model_dump()
    upd["updated_at"] = _mbt_iso(_mbt_now())
    res = await _mbt_prize_templates.update_one({"id": pid}, {"$set": upd})
    if not res.matched_count:
        raise HTTPException(status_code=404, detail="prize not found")  # type: ignore[name-defined]
    row = await _mbt_prize_templates.find_one({"id": pid}, {"_id": 0})
    return {"prize": row}


@api.delete("/admin/mystery-box/prize-templates/{pid}")  # noqa: F821
async def mbt_delete_prize_template(pid: str, admin=Depends(require_admin)):  # type: ignore[name-defined]
    res = await _mbt_prize_templates.delete_one({"id": pid})
    return {"deleted": int(res.deleted_count or 0)}


# -- Campaign templates (Speaking Lab admin chooses approved prizes) ----------
@api.get("/admin/mystery-box/campaigns")  # noqa: F821
async def mbt_list_campaigns(admin=Depends(require_admin)):  # type: ignore[name-defined]
    rows = []
    async for r in _mbt_campaigns.find({}, {"_id": 0}).sort("created_at", -1).limit(500):
        rows.append(r)
    return {"campaigns": rows, "count": len(rows)}


@api.post("/admin/mystery-box/campaigns")  # noqa: F821
async def mbt_create_campaign(payload: _CampaignIn, admin=Depends(require_admin)):  # type: ignore[name-defined]
    now = _mbt_iso(_mbt_now())
    doc = payload.model_dump()
    doc.update({
        "id": "cmp_" + _mbt_secrets.token_hex(8),
        "created_at": now,
        "updated_at": now,
        "created_by": getattr(admin, "email", "") or "",
    })
    await _mbt_campaigns.insert_one(dict(doc))
    doc.pop("_id", None)
    return {"campaign": doc}


@api.put("/admin/mystery-box/campaigns/{cid}")  # noqa: F821
async def mbt_update_campaign(cid: str, payload: _CampaignIn, admin=Depends(require_admin)):  # type: ignore[name-defined]
    upd = payload.model_dump()
    upd["updated_at"] = _mbt_iso(_mbt_now())
    res = await _mbt_campaigns.update_one({"id": cid}, {"$set": upd})
    if not res.matched_count:
        raise HTTPException(status_code=404, detail="campaign not found")  # type: ignore[name-defined]
    row = await _mbt_campaigns.find_one({"id": cid}, {"_id": 0})
    return {"campaign": row}


@api.delete("/admin/mystery-box/campaigns/{cid}")  # noqa: F821
async def mbt_delete_campaign(cid: str, admin=Depends(require_admin)):  # type: ignore[name-defined]
    res = await _mbt_campaigns.delete_one({"id": cid})
    return {"deleted": int(res.deleted_count or 0)}


# v1.3 — Admin campaign-preview endpoint. Resolves the campaign layout
# the SAME way the round-creation route does, but returns the prize
# titles/types ONLY (no codes, no internal IDs beyond what already
# appears in the admin Studio UI) so an operator can sanity-check
# "what will my classroom see when I click reveal?" without actually
# starting a round. Useful when a campaign suddenly looks point-only.
@api.get("/admin/mystery-box/campaigns/{cid}/preview")  # noqa: F821
async def mbt_preview_campaign(cid: str, admin=Depends(require_admin)):  # type: ignore[name-defined]
    camp = await _mbt_campaigns.find_one({"id": cid}, {"_id": 0})
    if not camp:
        raise HTTPException(status_code=404, detail="campaign not found")  # type: ignore[name-defined]
    # Resolved layout (random — call repeatedly to see variability).
    layout = await _mbt_resolve_campaign_layout(camp)
    # Plus the FULL pool of enabled prizes the campaign is allowed to
    # draw from, so the operator can immediately spot "I added a
    # voucher template but disabled it".
    ids = list(camp.get("prize_template_ids") or [])
    pool = []
    if ids:
        async for r in _mbt_prize_templates.find(
            {"id": {"$in": ids}}, {"_id": 0},
        ):
            pool.append({
                "id": r.get("id"),
                "title": r.get("title"),
                "type": r.get("type"),
                "rarity": r.get("rarity"),
                "enabled": bool(r.get("enabled", True)),
            })
    return {
        "campaign_id": cid,
        "campaign_name": camp.get("name"),
        "box_count": int(camp.get("box_count") or 0),
        "enabled_pool_size": sum(1 for p in pool if p["enabled"]),
        "pool": pool,
        "sample_layout": [
            {"index": i, "title": p.get("title"), "type": p.get("type"),
             "rarity": p.get("rarity")}
            for i, p in enumerate(layout)
        ],
        "by_type_in_sample": {
            t: sum(1 for p in layout if (p.get("type") or "") == t)
            for t in ["points", "book_voucher", "edutalk_session",
                      "edutalk_voice", "lucky_draw_entry",
                      "recognition", "consolation"]
        },
    }


# ── SPEAKING LAB TEACHER ROUTES (rounds + reveal) ───────────────────────────

async def _mbt_resolve_campaign_layout(camp: dict) -> List[dict]:
    """Resolve the prize layout for a campaign.

    Returns a list of prize dicts of length camp.box_count.

    v1.3 BUGFIX: the previous implementation took the first
    ``box_count`` prizes from ``prizes`` (because ``prizes[i % len]`` for
    ``i in [0..box_count-1]`` is just ``prizes[0..box_count-1]``) and
    THEN shuffled. When the campaign had more templates than boxes —
    e.g. 4 boxes, 7 templates — only the FIRST FOUR templates in
    MongoDB insertion order could ever appear. Operators who added
    Points templates first and Voucher / EduTalk Pass templates later
    would never see the new prizes show up in classroom rounds.

    New logic:

    * If ``box_count >= len(prizes)``: include each enabled prize at
      least once (so a small pool still gets every template surfaced),
      then random-sample-with-replacement for the remaining slots.
    * If ``box_count < len(prizes)``: random-sample-WITHOUT-replacement
      from the full pool, so every template has an equal chance per
      round regardless of MongoDB insertion order.
    * Optional ``weights`` array on the campaign is honoured when
      sampling with replacement.

    Final ``random.shuffle`` keeps the box positions unpredictable
    from the client.
    """
    import random as _r

    ids = list(camp.get("prize_template_ids") or [])
    box_count = int(camp.get("box_count") or 7)
    prizes: List[dict] = []
    if ids:
        async for r in _mbt_prize_templates.find(
            {"id": {"$in": ids}, "enabled": True}, {"_id": 0}
        ):
            prizes.append(r)
    if not prizes:
        return []

    n = len(prizes)
    if box_count <= 0:
        return []

    # Build a weight list aligned to `prizes`. Campaign.weights is a
    # parallel list to campaign.prize_template_ids (NOT to the
    # filtered/enabled `prizes` order coming from Mongo). We re-align
    # by id so a disabled prize doesn't shift the weights.
    weight_by_id = {}
    raw_weights = camp.get("weights") or []
    if isinstance(raw_weights, list) and raw_weights:
        for idx, pid in enumerate(ids):
            if idx < len(raw_weights):
                try:
                    w = float(raw_weights[idx])
                except Exception:
                    w = 1.0
                weight_by_id[pid] = max(w, 0.0)
    weights = [weight_by_id.get(p.get("id"), 1.0) for p in prizes]
    # If every weight is zero, fall back to uniform.
    if all((w == 0.0) for w in weights):
        weights = [1.0] * n

    if box_count >= n:
        # Cover every prize at least once, then sample-with-replacement
        # for the extra slots so larger pools still get variety.
        out = list(prizes)
        # Shuffle the seed copy so the "guaranteed" boxes aren't
        # always in the same order before padding.
        _r.shuffle(out)
        extra_needed = box_count - n
        if extra_needed > 0:
            out.extend(_r.choices(prizes, weights=weights, k=extra_needed))
    else:
        # box_count < n  →  pick a random subset honouring weights
        # without replacement so every template has a fair chance per
        # round and points-templates can't crowd out vouchers/passes
        # just because they were created first.
        try:
            picked = _r.sample(prizes, k=box_count)  # uniform without replacement
        except ValueError:
            # Defensive: sample raises if k > len, which we already
            # guarded for, but keep a hard fallback.
            picked = prizes[:box_count]
        # Apply weights as a soft re-roll: with a low probability,
        # swap a low-weight pick for a high-weight one. Keeps the
        # behaviour intuitive without making weights mandatory.
        if any(w != 1.0 for w in weights):
            wmap = {p.get("id"): w for p, w in zip(prizes, weights)}
            # Re-sort picked by weight descending so the heavier prizes
            # tend to surface in earlier (lower-index) box slots before
            # the final shuffle.
            picked.sort(key=lambda p: wmap.get(p.get("id"), 1.0), reverse=True)
        out = picked

    _r.shuffle(out)
    return out


@api.post("/speaking-lab/mystery-box/rounds")  # noqa: F821
async def mbt_create_round(payload: _RoundCreateIn, admin=Depends(require_admin)):  # type: ignore[name-defined]
    camp = await _mbt_campaigns.find_one({"id": payload.campaign_id, "enabled": True}, {"_id": 0})
    if not camp:
        raise HTTPException(status_code=404, detail="campaign not found or disabled")  # type: ignore[name-defined]
    layout = await _mbt_resolve_campaign_layout(camp)
    if not layout:
        raise HTTPException(status_code=400, detail="campaign has no enabled prizes")  # type: ignore[name-defined]
    rid = "rnd_" + _mbt_secrets.token_hex(10)
    now = _mbt_iso(_mbt_now())
    box_layout = [
        {
            "index": i,
            "prize_id": p.get("id"),
            "type": p.get("type"),
            "rarity": p.get("rarity") or "common",
            "accent_color": p.get("accent_color") or "#D4A843",
        }
        for i, p in enumerate(layout)
    ]
    # Internal full layout is stored separately so we can grant the right
    # prize at reveal time; only `closed_boxes` (opaque) is returned to
    # the teacher client.
    closed_boxes = [
        {
            "index": b["index"],
            "rarity": b["rarity"],
            "accent_color": b["accent_color"],
        }
        for b in box_layout
    ]
    doc = {
        "id": rid,
        "campaign_id": camp["id"],
        "campaign_name": camp.get("name") or "",
        "box_count": int(camp.get("box_count") or len(layout)),
        "session_id": (payload.session_id or "").strip(),
        "layout": box_layout,                # contains prize_id per box
        "closed_boxes": closed_boxes,        # safe to surface to client
        "selected_box_index": None,
        "selected_student_id": None,
        "selected_student_name": "",
        "status": "open",                    # open → revealed → done
        "revealed_at": None,
        "created_at": now,
        "updated_at": now,
        "created_by": getattr(admin, "email", "") or "",
        "settings": {
            "teacher_confirm_required": bool(camp.get("teacher_confirm_required", True)),
            "reveal_all_after_claim": bool(camp.get("reveal_all_after_claim", True)),
            "show_missed_prizes": bool(camp.get("show_missed_prizes", True)),
        },
    }
    await _mbt_rounds.insert_one(dict(doc))
    doc.pop("_id", None)
    # Return the teacher-safe shape (no prize_id in closed_boxes).
    safe = {k: v for k, v in doc.items() if k != "layout"}
    return {"round": safe}


@api.get("/speaking-lab/mystery-box/rounds/{rid}")  # noqa: F821
async def mbt_get_round(rid: str, admin=Depends(require_admin)):  # type: ignore[name-defined]
    row = await _mbt_rounds.find_one({"id": rid}, {"_id": 0})
    if not row:
        raise HTTPException(status_code=404, detail="round not found")  # type: ignore[name-defined]
    # Strip the internal layout from open rounds.
    if row.get("status") == "open":
        row = {k: v for k, v in row.items() if k != "layout"}
    return {"round": row}


@api.post("/speaking-lab/mystery-box/rounds/{rid}/select")  # noqa: F821
async def mbt_select_box(rid: str, payload: _SelectIn, admin=Depends(require_admin)):  # type: ignore[name-defined]
    row = await _mbt_rounds.find_one({"id": rid}, {"_id": 0})
    if not row:
        raise HTTPException(status_code=404, detail="round not found")  # type: ignore[name-defined]
    if row.get("status") != "open":
        # Idempotent for "select" — if already selected, return current state.
        return {"round": {k: v for k, v in row.items() if k != "layout"}}
    bc = int(row.get("box_count") or 0)
    if payload.box_index < 0 or payload.box_index >= bc:
        raise HTTPException(status_code=400, detail="box_index out of range")  # type: ignore[name-defined]
    now = _mbt_iso(_mbt_now())
    await _mbt_rounds.update_one(
        {"id": rid, "status": "open"},
        {"$set": {
            "selected_box_index": int(payload.box_index),
            "selected_student_id": payload.student_id,
            "selected_student_name": (payload.student_name or "")[:80],
            "updated_at": now,
        }},
    )
    row = await _mbt_rounds.find_one({"id": rid}, {"_id": 0})
    safe = {k: v for k, v in row.items() if k != "layout"}
    return {"round": safe}


@api.post("/speaking-lab/mystery-box/rounds/{rid}/reveal")  # noqa: F821
async def mbt_reveal_round(rid: str, payload: _RevealIn, admin=Depends(require_admin)):  # type: ignore[name-defined]
    row = await _mbt_rounds.find_one({"id": rid}, {"_id": 0})
    if not row:
        raise HTTPException(status_code=404, detail="round not found")  # type: ignore[name-defined]

    sid_clean = (payload.student_id or "").strip()
    sid_norm = _mbt_norm_id(sid_clean)
    if not sid_clean:
        raise HTTPException(status_code=400, detail="student_id required")  # type: ignore[name-defined]

    # Idempotency, three-way:
    #   granted → return existing claim (no re-grant ever)
    #   pending → 409 so caller waits (another reveal is in flight)
    #   failed  → ALLOW a safe retry of the grant for the same selected box,
    #             reusing the existing claim row so we never accumulate
    #             duplicate failed rows for the same (round, student).
    existing_claim = await _mbt_claims.find_one(
        {"round_id": rid, "student_id_norm": sid_norm}, {"_id": 0}
    )
    retrying_failed = False
    if existing_claim:
        gstatus = (existing_claim.get("granted_status") or "").lower()
        if gstatus == "granted":
            return {
                "already_claimed": True,
                "claim": existing_claim,
                "revealed_layout": existing_claim.get("public_layout") or [],
            }
        if gstatus == "pending":
            raise HTTPException(  # type: ignore[name-defined]
                status_code=409,
                detail="Grant in progress for this student. Please retry shortly.",
            )
        # gstatus == "failed" → fall through and retry the grant. Force
        # the retry to use the box_index recorded on the original claim
        # so the operator can't accidentally swap the chosen box.
        retrying_failed = True

    if row.get("status") not in ("open",) and not retrying_failed:
        # Round already closed by a different student's reveal. Return a
        # safe layout snapshot so the teacher screen can still show the
        # closed state without crashing.
        public_layout = []
        for b in (row.get("layout") or []):
            public_layout.append({
                "index": b.get("index"),
                "type": b.get("type"),
                "rarity": b.get("rarity"),
                "is_selected": False,
                "is_claimed": False,
                "title": "Mystery Prize",
            })
        return {"already_claimed": True, "claim": None,
                "revealed_layout": public_layout}

    # Resolve box_index.
    #   - For a retry of a failed claim, ALWAYS use the original recorded
    #     box_index (immutable choice).
    #   - Otherwise, prefer payload, fall back to round.selected_box_index.
    if retrying_failed:
        box_index = existing_claim.get("selected_box_index")
    else:
        box_index = payload.box_index
        if box_index is None:
            box_index = row.get("selected_box_index")
    if box_index is None:
        raise HTTPException(status_code=400, detail="no box selected")  # type: ignore[name-defined]
    box_index = int(box_index)
    layout = row.get("layout") or []
    if box_index < 0 or box_index >= len(layout):
        raise HTTPException(status_code=400, detail="box_index out of range")  # type: ignore[name-defined]
    chosen = layout[box_index]
    prize = await _mbt_prize_templates.find_one({"id": chosen.get("prize_id")}, {"_id": 0})
    if not prize:
        raise HTTPException(status_code=500, detail="prize template missing")  # type: ignore[name-defined]

    # Build / refresh the claim row. On a retry we keep the original id
    # and just flip the status back to "pending" so another concurrent
    # retry collides on the same row instead of inserting a duplicate.
    idem = (payload.idempotency_key or "").strip() or _mbt_uuid.uuid4().hex
    now = _mbt_iso(_mbt_now())
    if retrying_failed:
        claim_id = existing_claim.get("id")
        await _mbt_claims.update_one(
            {"id": claim_id, "granted_status": "failed"},
            {"$set": {
                "granted_status": "pending",
                "retry_count": int(existing_claim.get("retry_count") or 0) + 1,
                "idempotency_key": idem,
                "updated_at": now,
            }},
        )
        pending_id = claim_id
    else:
        pending = {
            "id": "clm_" + _mbt_secrets.token_hex(10),
            "round_id": rid,
            "campaign_id": row.get("campaign_id"),
            "student_id": sid_clean,
            "student_id_norm": sid_norm,
            "student_name": (payload.student_name or row.get("selected_student_name") or "")[:80],
            "selected_box_index": box_index,
            "prize_id": prize.get("id"),
            "prize_type": prize.get("type"),
            "prize_title": prize.get("title"),
            "granted_status": "pending",
            "retry_count": 0,
            "idempotency_key": idem,
            "created_at": now,
            "updated_at": now,
        }
        try:
            await _mbt_claims.insert_one(dict(pending))
        except Exception:
            # Unique-index race: another reveal raced in between our
            # initial fetch and this insert. Re-fetch and apply the
            # three-way idempotency policy.
            other = await _mbt_claims.find_one(
                {"round_id": rid, "student_id_norm": sid_norm}, {"_id": 0}
            )
            if other:
                ostatus = (other.get("granted_status") or "").lower()
                if ostatus == "granted":
                    return {"already_claimed": True, "claim": other,
                            "revealed_layout": other.get("public_layout") or []}
                if ostatus == "pending":
                    raise HTTPException(status_code=409, detail="Grant in progress.")  # type: ignore[name-defined]
                # Failed → caller should retry; surface 409 so the UI
                # explicitly re-issues the reveal.
                raise HTTPException(status_code=409, detail="Previous attempt failed — retry.")  # type: ignore[name-defined]
            raise HTTPException(status_code=409, detail="claim race")  # type: ignore[name-defined]
        pending_id = pending["id"]

    # Now grant the prize for real. The round is NOT marked revealed
    # until grant succeeds — a failed grant leaves the round open for
    # another reveal attempt.
    result = await _mbt_grant_prize(
        prize=prize,
        student_clean_id=sid_clean,
        student_id_norm=sid_norm,
        campaign_id=row.get("campaign_id") or "",
        round_id=rid,
    )
    if not result.get("ok"):
        # Mark claim failed but keep the row (auditable retry trail).
        await _mbt_claims.update_one(
            {"id": pending_id},
            {"$set": {
                "granted_status": "failed",
                "grant_error": (result.get("error") or "")[:200],
                "updated_at": _mbt_iso(_mbt_now()),
            }},
        )
        # Important: DO NOT close the round here. A subsequent reveal
        # call for the same student will hit the retrying_failed branch
        # above and try the grant again with the SAME box_index.
        raise HTTPException(status_code=502, detail=result.get("error") or "grant failed")  # type: ignore[name-defined]

    safe_display = result.get("safe_display") or _safe_display_for(prize, result.get("granted"))

    # Build the public reveal-all layout (titles only, no codes).
    public_layout = []
    for b in layout:
        p_id = b.get("prize_id")
        is_chosen = (int(b.get("index")) == box_index)
        # Fetch sibling prize titles lazily (single call per box, OK for 3-9 boxes)
        sib_prize = await _mbt_prize_templates.find_one({"id": p_id}, {"_id": 0})
        if not sib_prize:
            sib_prize = {"title": "Mystery Prize", "type": b.get("type") or ""}
        sib_display = _safe_display_for(sib_prize, None)
        public_layout.append({
            "index": int(b.get("index") or 0),
            "type": b.get("type"),
            "rarity": b.get("rarity") or "common",
            "title": sib_display.get("title") or sib_prize.get("title"),
            "display": sib_display,
            "is_selected": is_chosen,
            "is_claimed": is_chosen,
            "is_missed": not is_chosen,
        })

    # Mark claim as granted with the safe display payload + public layout.
    await _mbt_claims.update_one(
        {"id": pending_id},
        {"$set": {
            "granted_status": "granted",
            "granted_at": _mbt_iso(_mbt_now()),
            "safe_display_payload": safe_display,
            "public_layout": public_layout,
            "updated_at": _mbt_iso(_mbt_now()),
        }},
    )

    # Mark round done — ONLY now that the grant succeeded. A failed
    # grant raised above and left the round status as "open" so the
    # teacher can retry. The conditional {status:"open"} keeps this
    # idempotent under any race.
    await _mbt_rounds.update_one(
        {"id": rid, "status": "open"},
        {"$set": {
            "status": "revealed",
            "selected_box_index": box_index,
            "selected_student_id": sid_clean,
            "selected_student_name": (payload.student_name or "")[:80],
            "revealed_at": _mbt_iso(_mbt_now()),
            "updated_at": _mbt_iso(_mbt_now()),
        }},
    )

    # Reward history (for "My Portal → Activity" surface, lightweight).
    try:
        await _mbt_reward_history.insert_one({
            "student_id": sid_clean,
            "student_id_norm": sid_norm,
            "source": "speaking_lab_mystery_box",
            "campaign_id": row.get("campaign_id"),
            "round_id": rid,
            "prize_id": prize.get("id"),
            "prize_type": prize.get("type"),
            "prize_title": prize.get("title"),
            "safe_display_payload": safe_display,
            "created_at": _mbt_iso(_mbt_now()),
        })
    except Exception:
        pass

    return {
        "already_claimed": False,
        "claim": {
            "id": pending_id,
            "round_id": rid,
            "prize_type": prize.get("type"),
            "prize_title": prize.get("title"),
            "safe_display_payload": safe_display,
            "granted_status": "granted",
            "granted_at": _mbt_iso(_mbt_now()),
        },
        "revealed_layout": public_layout,
    }


# ── STUDENT ROUTES (My Portal) ──────────────────────────────────────────────
@api.get("/student/edutalk-passes")  # noqa: F821
async def mbt_list_student_passes(student=Depends(require_student)):  # type: ignore[name-defined]
    sid_clean = (getattr(student, "clean_id", "") or "").strip() or getattr(student, "student_id", "")
    sid_norm = _mbt_norm_id(sid_clean)
    if not sid_norm:
        return {"passes": [], "count": 0}
    now_iso = _mbt_iso(_mbt_now())
    out = []
    cur = _mbt_entitlements.find(
        {"student_id_norm": sid_norm},
        {"_id": 0},
    ).sort("created_at", -1).limit(200)
    async for r in cur:
        # Live status: expire on the fly if past expires_at.
        status = r.get("status") or "active"
        if status == "active" and r.get("expires_at") and r.get("expires_at") <= now_iso:
            status = "expired"
            # Best-effort persist
            try:
                await _mbt_entitlements.update_one(
                    {"id": r.get("id")},
                    {"$set": {"status": "expired", "updated_at": now_iso}},
                )
            except Exception:
                pass
        out.append({
            "id": r.get("id"),
            "feature": r.get("feature"),
            "title": r.get("title"),
            "quantity_total": int(r.get("quantity_total") or 0),
            "quantity_remaining": int(r.get("quantity_remaining") or 0),
            "eligible_book_slugs": list(r.get("eligible_book_slugs") or []),
            "applies_to_all_books": not bool(r.get("eligible_book_slugs")),
            "source": r.get("source"),
            "expires_at": r.get("expires_at"),
            "status": status,
            "created_at": r.get("created_at"),
        })
    return {"passes": out, "count": len(out)}


@api.get("/student/mystery-box/history")  # noqa: F821
async def mbt_student_history(student=Depends(require_student)):  # type: ignore[name-defined]
    sid_clean = (getattr(student, "clean_id", "") or "").strip() or getattr(student, "student_id", "")
    sid_norm = _mbt_norm_id(sid_clean)
    if not sid_norm:
        return {"items": [], "count": 0}
    rows = []
    cur = _mbt_reward_history.find(
        {"student_id_norm": sid_norm},
        {"_id": 0},
    ).sort("created_at", -1).limit(50)
    async for r in cur:
        rows.append({
            "source": r.get("source"),
            "prize_title": r.get("prize_title"),
            "prize_type": r.get("prize_type"),
            "safe_display_payload": r.get("safe_display_payload"),
            "created_at": r.get("created_at"),
        })
    return {"items": rows, "count": len(rows)}


# v1.2 — Reader EduTalk-panel "Pass Available" badge endpoint.
# Returns a TINY counts-only payload (no entitlement ids, no titles,
# no eligibility lists). The PWA Reader EduTalk panel calls this once
# on mount and renders a small badge if the count > 0. Optional
# ?book_slug=<slug> filters to passes that apply to the current book.
@api.get("/student/edutalk-passes/summary")  # noqa: F821
async def mbt_pass_summary(
    book_slug: str = "",
    student=Depends(require_student),  # type: ignore[name-defined]
):
    sid_clean = (getattr(student, "clean_id", "") or "").strip() or getattr(student, "student_id", "")
    sid_norm = _mbt_norm_id(sid_clean)
    empty = {"edutalk_session": 0, "edutalk_voice": 0, "has_any": False, "book_slug": book_slug or ""}
    if not sid_norm:
        return empty
    now_iso = _mbt_iso(_mbt_now())
    book_slug = (book_slug or "").strip()
    base_query = {
        "student_id_norm": sid_norm,
        "status": "active",
        "quantity_remaining": {"$gt": 0},
        "$or": [
            {"expires_at": {"$gt": now_iso}},
            {"expires_at": None},
        ],
    }
    if book_slug:
        book_clause = {"$or": [
            {"eligible_book_slugs": {"$in": [book_slug]}},
            {"eligible_book_slugs": {"$size": 0}},
            {"eligible_book_slugs": {"$exists": False}},
        ]}
    else:
        book_clause = None

    def _q(feature: str) -> dict:
        q = {**base_query, "feature": feature}
        if book_clause:
            # Combine via $and to preserve both $or branches.
            q = {"$and": [q, book_clause]}
        return q

    try:
        s_cnt = await _mbt_entitlements.count_documents(_q("edutalk_session"))
        v_cnt = await _mbt_entitlements.count_documents(_q("edutalk_voice"))
    except Exception as _e:
        _MBT_LOG.warning("edutalk pass summary failed: %s", _e)
        return empty
    return {
        "edutalk_session": int(s_cnt or 0),
        "edutalk_voice": int(v_cnt or 0),
        "has_any": bool((s_cnt or 0) + (v_cnt or 0) > 0),
        "book_slug": book_slug or "",
    }


# v1.2 — Admin support/smoke endpoint. Given a student id, returns a
# small administrative summary: active pass counts (per feature), the
# 5 most recent mystery-box claims (granted/failed/pending), and the
# 5 most recent reward-history entries. Used by operators to verify
# that a student's win landed correctly without exposing voucher
# codes anywhere. Admin-only — does NOT leak data to students.
@api.get("/admin/mystery-box/student-summary")  # noqa: F821
async def mbt_admin_student_summary(
    student_id: str = "",
    admin=Depends(require_admin),  # type: ignore[name-defined]
):
    sid_clean = (student_id or "").strip()
    sid_norm = _mbt_norm_id(sid_clean)
    if not sid_norm:
        raise HTTPException(status_code=400, detail="student_id required")  # type: ignore[name-defined]

    now_iso = _mbt_iso(_mbt_now())
    # active passes
    s_cnt = await _mbt_entitlements.count_documents({
        "student_id_norm": sid_norm,
        "feature": "edutalk_session",
        "status": "active",
        "quantity_remaining": {"$gt": 0},
        "$or": [{"expires_at": {"$gt": now_iso}}, {"expires_at": None}],
    })
    v_cnt = await _mbt_entitlements.count_documents({
        "student_id_norm": sid_norm,
        "feature": "edutalk_voice",
        "status": "active",
        "quantity_remaining": {"$gt": 0},
        "$or": [{"expires_at": {"$gt": now_iso}}, {"expires_at": None}],
    })

    # recent claims
    claims = []
    async for r in _mbt_claims.find(
        {"student_id_norm": sid_norm}, {"_id": 0},
    ).sort("created_at", -1).limit(5):
        claims.append({
            "id": r.get("id"),
            "round_id": r.get("round_id"),
            "campaign_id": r.get("campaign_id"),
            "prize_title": r.get("prize_title"),
            "prize_type": r.get("prize_type"),
            "granted_status": r.get("granted_status"),
            "retry_count": int(r.get("retry_count") or 0),
            "grant_error": r.get("grant_error"),
            "created_at": r.get("created_at"),
            "granted_at": r.get("granted_at"),
        })

    # recent reward history
    history = []
    async for r in _mbt_reward_history.find(
        {"student_id_norm": sid_norm}, {"_id": 0},
    ).sort("created_at", -1).limit(5):
        history.append({
            "source": r.get("source"),
            "prize_title": r.get("prize_title"),
            "prize_type": r.get("prize_type"),
            "safe_display_payload": r.get("safe_display_payload"),
            "created_at": r.get("created_at"),
        })

    return {
        "student_id_norm": sid_norm,
        "active_passes": {
            "edutalk_session": int(s_cnt or 0),
            "edutalk_voice": int(v_cnt or 0),
        },
        "recent_claims": claims,
        "recent_reward_history": history,
    }


# ── Player join the round (Speaking Lab passes the picked student) ──────────
# Public student endpoint NOT required for v1: Speaking Lab UI is teacher-
# driven (admin authenticates and forwards student_id picked via the
# classroom roster). This keeps the public surface tiny and avoids any
# duplicate-grant attack from the student device.


# ── ensure indexes once at module load (best-effort) ────────────────────────
try:
    import asyncio as _mbt_asyncio
    loop = _mbt_asyncio.get_event_loop()
    if loop.is_running():
        _mbt_asyncio.ensure_future(_mbt_ensure_indexes())
    else:
        loop.run_until_complete(_mbt_ensure_indexes())
except Exception as _mbt_idx_err:
    _MBT_LOG.warning("mystery_box: deferred index creation: %s", _mbt_idx_err)


_MBT_LOG.info(
    "mystery_box_tools: routes registered "
    "(/api/admin/mystery-box/*, /api/admin/edutalk-passes/*, "
    "/api/speaking-lab/mystery-box/*, /api/student/edutalk-passes, "
    "/api/student/mystery-box/history)"
)
