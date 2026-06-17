# ============================================================================
# login_mystery_box_tools.py — EduHub Login Mystery Box Rewards (v1.0)
#
# Premium "4 mystery boxes after login" reward system for the EduHub PWA.
# Loaded via exec() into server.py's namespace (same pattern as
# login_reward_tools.py and mystery_box_tools.py), so it shares:
#   api, db, log, httpx, require_admin, require_student,
#   _norm_student_id, SL_TREASURY_ID, SL_TREASURY_PASSWORD,
#   _fan_out_push, datetime, timezone, timedelta,
#   BaseModel, ConfigDict, Field, HTTPException, Depends, JSONResponse.
#
# It also REUSES helpers already loaded by login_reward_tools.py and
# mystery_box_tools.py earlier in the boot sequence:
#   _lrc_credit_via_treasury          (points credit via existing treasury)
#   _lrc_voucher_discount_label       (voucher label helper)
#   _lrc_safe_artwork_url             (artwork URL allow-list)
#   _lrc_iso / _lrc_now / _lrc_secrets / _lrc_parse_iso
#   _mbt_grant_edutalk_pass           (EduTalk pass entitlement issuer)
#   _mbt_norm_id / _mbt_iso / _mbt_now
#
# Endpoints registered (all under existing /api router):
#
#   STUDENT (require_student):
#     GET  /api/student/login-mystery/status
#     POST /api/student/login-mystery/select   { box_index }
#     GET  /api/student/login-mystery/history
#
#   ADMIN  (require_admin — existing Author Studio admin auth):
#     GET    /api/admin/login-mystery/campaigns
#     POST   /api/admin/login-mystery/campaigns
#     GET    /api/admin/login-mystery/campaigns/{id}
#     PUT    /api/admin/login-mystery/campaigns/{id}
#     DELETE /api/admin/login-mystery/campaigns/{id}
#     GET    /api/admin/login-mystery/claims
#     GET    /api/admin/login-mystery/analytics
#
# Collections (all NEW, additive — never touches existing collections):
#   * login_mystery_campaigns   — admin-configured campaigns
#   * login_mystery_claims      — per-student per-window claim rows
#
# Fairness / anti-abuse:
#   * 4 box outcomes are GENERATED SERVER-SIDE on first /status call and
#     PERSISTED in a "preview" claim row (locked outcomes).
#   * /select only accepts a box_index 0..3 and credits ONLY the selected
#     reward; all 4 stored outcomes are then revealed.
#   * Unique compound index (campaign_id, student_id_norm, eligibility_window)
#     prevents double claims for the same window.
#
# Safety perimeter:
#   * Pure additive — never modifies payment/wallet core, EduTalk audio
#     cache, login rewards, voucher core, Speaking Lab Mystery Box,
#     payment providers, AuthContext or service worker.
#   * Reuses existing services: points via _lrc_credit_via_treasury,
#     vouchers via the SAME db.coupons + _lrc_student_vouchers shape used
#     by login_reward_tools, EduTalk passes via _mbt_grant_edutalk_pass.
#   * Module load failure is non-fatal (server.py wraps the load in
#     try/except). Only Login Mystery Box is disabled on load failure.
# ============================================================================

import secrets as _lmb_secrets
import random as _lmb_random
import string as _lmb_string
from typing import List, Literal, Optional

# JSONResponse is already imported by server.py; reuse from the shared namespace.
try:
    JSONResponse  # type: ignore  # noqa: F821
except NameError:  # pragma: no cover
    from fastapi.responses import JSONResponse  # noqa: F401

# Pydantic primitives — reuse from shared namespace with defensive fallback.
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
try:
    Depends  # type: ignore  # noqa: F821
except NameError:  # pragma: no cover
    from fastapi import Depends  # noqa: F401


_LMB_LOG = log  # reuse server logger  # type: ignore[name-defined]  # noqa: F821

# Fixed box count for v1 (problem statement requirement).
_LMB_BOX_COUNT = 4

# ── Collections (lazy, additive) ────────────────────────────────────────────
_lmb_campaigns = db["login_mystery_campaigns"]   # noqa: F821
_lmb_claims    = db["login_mystery_claims"]      # noqa: F821


# ── helpers ─────────────────────────────────────────────────────────────────
def _lmb_now():
    # Prefer the shared helper from login_reward_tools (already loaded).
    fn = globals().get("_lrc_now")
    if callable(fn):
        return fn()
    return datetime.now(timezone.utc)  # noqa: F821


def _lmb_iso(dt) -> Optional[str]:
    fn = globals().get("_lrc_iso")
    if callable(fn):
        return fn(dt)
    if dt is None:
        return None
    if dt.tzinfo is None:
        dt = dt.replace(tzinfo=timezone.utc)  # noqa: F821
    return dt.astimezone(timezone.utc).isoformat().replace("+00:00", "Z")  # noqa: F821


def _lmb_parse_iso(value):
    fn = globals().get("_lrc_parse_iso")
    if callable(fn):
        return fn(value)
    if not value or not isinstance(value, str):
        return None
    try:
        s = value.strip()
        if s.endswith("Z"):
            s = s[:-1] + "+00:00"
        d = datetime.fromisoformat(s)  # noqa: F821
        if d.tzinfo is None:
            d = d.replace(tzinfo=timezone.utc)  # noqa: F821
        return d
    except Exception:
        return None


def _lmb_norm_id(value) -> str:
    fn = globals().get("_norm_student_id")
    if callable(fn):
        try:
            return fn(value or "")
        except Exception:
            pass
    return (value or "").strip().lower()


# ── reward pool item / campaign models ──────────────────────────────────────
class _LMBRewardItemIn(BaseModel):
    model_config = ConfigDict(extra="ignore")

    # Identity / display
    label: str = Field(default="Reward", max_length=80)
    description: Optional[str] = Field(default="", max_length=240)
    rarity: Literal["common", "rare", "epic", "legendary"] = "common"
    accent_color: Optional[str] = "#D4A843"
    icon: Optional[str] = "gift"   # frontend illustration key
    enabled: bool = True

    # Probability weight (simple integer weight; backend normalises).
    weight: int = Field(default=10, ge=0, le=10_000)

    # Reward type — only backend-supported types.
    #   points          → credit `points` to wallet via _lrc_credit_via_treasury
    #   voucher         → mint a coupon + student_vouchers row (login-reward shape)
    #   edutalk_session → grant edutalk_session pass via _mbt_grant_edutalk_pass
    #   edutalk_voice   → grant edutalk_voice pass via _mbt_grant_edutalk_pass
    reward_type: Literal[
        "points", "voucher", "edutalk_session", "edutalk_voice"
    ] = "points"

    # ── points ────────────────────────────────────────────────────────────
    points: int = Field(default=0, ge=0, le=10_000_000)

    # ── voucher (same shape as login_reward_tools voucher config) ─────────
    voucher_discount_type: Literal["percent", "fixed"] = "percent"
    voucher_discount_value: float = 0
    voucher_max_uses: Optional[int] = 1
    voucher_valid_days: Optional[int] = 30
    voucher_book_slugs: Optional[List[str]] = None
    voucher_title: Optional[str] = "Book Voucher"
    voucher_subtitle: Optional[str] = ""
    voucher_template: Optional[str] = "royal_purple_gold"
    voucher_accent_color: Optional[str] = "#D4A843"

    # ── edutalk pass ─────────────────────────────────────────────────────
    edutalk_quantity: int = Field(default=1, ge=1, le=100)
    edutalk_expires_in_days: int = Field(default=30, ge=1, le=365)
    edutalk_eligible_book_slugs: Optional[List[str]] = None
    edutalk_title: Optional[str] = "EduTalk Pass"


class _LMBCampaignIn(BaseModel):
    model_config = ConfigDict(extra="ignore")

    # Identity / lifecycle
    name: str = Field(default="Login Mystery Box", max_length=120)
    description: Optional[str] = Field(default="", max_length=600)
    enabled: bool = False
    priority: int = 0

    start_at: Optional[str] = None
    end_at: Optional[str] = None
    timezone: Optional[str] = "Asia/Phnom_Penh"

    # Frequency / eligibility window
    #   once_per_campaign → one claim per student for the entire campaign
    #   once_per_day      → one claim per UTC day per student
    claim_frequency: Literal["once_per_campaign", "once_per_day"] = "once_per_day"

    # Audience (mirrors login_reward_tools)
    audience_type: Literal["all", "specific_students", "exclude_only"] = "all"
    include_student_ids: Optional[List[str]] = None
    exclude_student_ids: Optional[List[str]] = None

    # UI / messaging
    title: str = Field(default="Mystery Reward", max_length=120)
    subtitle: str = Field(default="Pick a box to reveal your reward!", max_length=240)
    cta_text: str = Field(default="Open Box", max_length=60)
    success_message: str = Field(
        default="Reward claimed! Great pick!",
        max_length=240,
    )
    post_claim_message: str = Field(
        default="See what was inside the other boxes...",
        max_length=240,
    )
    accent_color: Optional[str] = "#D4A843"
    reveal_remaining: bool = True   # auto-open the 3 other boxes after claim
    animation_theme: Literal["royal_gold", "treasure_chest", "neon_burst"] = "royal_gold"

    # Reward pool (always normalised to >=1 active items at validation time).
    reward_pool: List[_LMBRewardItemIn] = Field(default_factory=list)


# ── voucher artwork allow-list ──────────────────────────────────────────────
def _lmb_safe_artwork_url(value) -> str:
    fn = globals().get("_lrc_safe_artwork_url")
    if callable(fn):
        try:
            return fn(value) or ""
        except Exception:
            return ""
    return ""


# ── validation ──────────────────────────────────────────────────────────────
def _lmb_validate_payload(p: _LMBCampaignIn) -> dict:
    """Validate the admin-supplied campaign payload and normalise it for
    persistence. Raises HTTPException on configuration errors so the
    Author Studio surfaces a clean message."""
    data = p.model_dump()

    # Date range sanity
    start = _lmb_parse_iso(data.get("start_at"))
    end = _lmb_parse_iso(data.get("end_at"))
    if start and end and end <= start:
        raise HTTPException(status_code=400, detail="end_at must be after start_at")  # noqa: F821

    # Reward pool — keep enabled items with weight > 0 and a runnable reward.
    pool_in = list(data.get("reward_pool") or [])
    if not pool_in:
        raise HTTPException(status_code=400, detail="reward_pool must have at least 1 item")  # noqa: F821

    cleaned: list[dict] = []
    for idx, item in enumerate(pool_in):
        if not item.get("enabled", True):
            continue
        w = int(item.get("weight") or 0)
        if w <= 0:
            continue
        rtype = item.get("reward_type") or "points"
        item = dict(item)  # copy
        item["weight"] = w
        item["reward_type"] = rtype
        if rtype == "points":
            pts = int(item.get("points") or 0)
            if pts <= 0:
                raise HTTPException(
                    status_code=400,
                    detail=f"reward_pool[{idx}]: points must be > 0",
                )
        elif rtype == "voucher":
            try:
                dv = float(item.get("voucher_discount_value") or 0)
            except Exception:
                dv = 0.0
            if dv <= 0:
                raise HTTPException(
                    status_code=400,
                    detail=f"reward_pool[{idx}]: voucher_discount_value must be > 0",
                )
        elif rtype in ("edutalk_session", "edutalk_voice"):
            q = int(item.get("edutalk_quantity") or 0)
            if q <= 0:
                raise HTTPException(
                    status_code=400,
                    detail=f"reward_pool[{idx}]: edutalk_quantity must be > 0",
                )
        cleaned.append(item)

    if not cleaned:
        raise HTTPException(
            status_code=400,
            detail="reward_pool has no active items with weight > 0",
        )

    data["reward_pool"] = cleaned
    return data


# ── indexes ─────────────────────────────────────────────────────────────────
async def _lmb_ensure_indexes() -> None:
    try:
        await _lmb_campaigns.create_index("id", unique=True, sparse=True)
        await _lmb_campaigns.create_index("enabled")
        await _lmb_campaigns.create_index([("start_at", 1), ("end_at", 1)])
        # Critical: one claim row per (campaign, student, eligibility window).
        await _lmb_claims.create_index(
            [("campaign_id", 1), ("student_id_norm", 1), ("eligibility_window", 1)],
            unique=True,
            name="uniq_lmb_campaign_student_window",
        )
        await _lmb_claims.create_index("student_id_norm")
        await _lmb_claims.create_index("campaign_id")
        await _lmb_claims.create_index("status")
        await _lmb_claims.create_index("claimed_at")
        _LMB_LOG.info("login_mystery_box: indexes ensured")
    except Exception as _e:
        _LMB_LOG.warning("login_mystery_box: startup index ensure failed: %s", _e)


@app.on_event("startup")  # type: ignore[name-defined]  # noqa: F821
async def _lmb_startup_indexes():
    await _lmb_ensure_indexes()


# ── eligibility ─────────────────────────────────────────────────────────────
def _lmb_status(camp: dict, now=None) -> str:
    """Derived UI status: disabled | scheduled | live | expired."""
    if not camp.get("enabled"):
        return "disabled"
    now = now or _lmb_now()
    start = _lmb_parse_iso(camp.get("start_at"))
    end = _lmb_parse_iso(camp.get("end_at"))
    if start and now < start:
        return "scheduled"
    if end and now > end:
        return "expired"
    return "live"


def _lmb_eligible(camp: dict, sid_norm: str) -> bool:
    aud = (camp.get("audience_type") or "all").lower()
    include = [_lmb_norm_id(x) for x in (camp.get("include_student_ids") or []) if x]
    exclude = [_lmb_norm_id(x) for x in (camp.get("exclude_student_ids") or []) if x]
    if sid_norm in exclude:
        return False
    if aud == "all":
        return True
    if aud == "specific_students":
        return sid_norm in include
    if aud == "exclude_only":
        return sid_norm not in exclude
    return False


def _lmb_eligibility_window(camp: dict, now=None) -> str:
    """Build the deterministic window key used by the unique index."""
    freq = (camp.get("claim_frequency") or "once_per_day").lower()
    if freq == "once_per_campaign":
        return "campaign"
    now = now or _lmb_now()
    # UTC calendar day. Predictable & matches points_history `created_at`.
    return now.strftime("%Y-%m-%d")


# ── serializer ──────────────────────────────────────────────────────────────
def _lmb_serialize_campaign(camp: dict, *, with_status: bool = True) -> dict:
    if not camp:
        return camp
    out = dict(camp)
    out.pop("_id", None)
    if "id" not in out and "campaign_id" in out:
        out["id"] = out["campaign_id"]
    for k in ("start_at", "end_at", "created_at", "updated_at"):
        v = out.get(k)
        if isinstance(v, datetime):  # noqa: F821
            out[k] = _lmb_iso(v)
    if with_status:
        out["status"] = _lmb_status(out)
    return out


def _lmb_public_campaign_view(camp: dict, *, total_boxes: int = _LMB_BOX_COUNT) -> dict:
    """Strip internal fields before returning to the student."""
    out = _lmb_serialize_campaign(camp)
    for k in (
        "include_student_ids", "exclude_student_ids",
        "audience_type", "priority", "reward_pool",
    ):
        out.pop(k, None)
    out["box_count"] = total_boxes
    return out


def _lmb_public_reward_view(reward: dict, *, hidden: bool = False) -> dict:
    """Display-safe reward summary for the student popup.

    `hidden=True` returns a placeholder (used while boxes are still face-down
    pre-selection — never expose stored outcomes until the student picks).
    """
    if hidden:
        return {
            "label": "???",
            "rarity": "common",
            "reward_type": "mystery",
            "icon": "mystery",
            "accent_color": "#D4A843",
            "display_value": "???",
        }
    rtype = reward.get("reward_type") or "points"
    display_value = ""
    if rtype == "points":
        display_value = f"+{int(reward.get('points') or 0)} pts"
    elif rtype == "voucher":
        dv = reward.get("voucher_discount_value")
        dtype = reward.get("voucher_discount_type") or "percent"
        fn = globals().get("_lrc_voucher_discount_label")
        if callable(fn):
            try:
                display_value = fn(dtype, dv) or "Voucher"
            except Exception:
                display_value = "Voucher"
        else:
            display_value = "Voucher"
    elif rtype in ("edutalk_session", "edutalk_voice"):
        q = int(reward.get("edutalk_quantity") or 1)
        display_value = f"{q}× EduTalk {'voice' if rtype == 'edutalk_voice' else 'session'}"
    return {
        "label": reward.get("label") or "Reward",
        "description": reward.get("description") or "",
        "rarity": reward.get("rarity") or "common",
        "reward_type": rtype,
        "icon": reward.get("icon") or "gift",
        "accent_color": reward.get("accent_color") or "#D4A843",
        "display_value": display_value,
    }


# ── reward pool sampling (server-side, weighted, with-replacement) ──────────
def _lmb_pick_box_outcomes(pool: list[dict], count: int = _LMB_BOX_COUNT) -> list[dict]:
    """Pick `count` reward items from the active pool with weighted random.

    Returns a list of `count` minimal reward snapshots (the same dict
    shape stored in the campaign reward_pool, but stripped of internal
    metadata so the persisted claim row stays compact).
    """
    rng = _lmb_random.SystemRandom()
    # Filter once defensively (validation already trimmed).
    active = [
        r for r in pool
        if r.get("enabled", True) and int(r.get("weight") or 0) > 0
    ]
    if not active:
        return []
    weights = [int(r.get("weight") or 0) for r in active]
    picks = rng.choices(active, weights=weights, k=count)
    out: list[dict] = []
    for r in picks:
        out.append(dict(r))  # shallow copy so the claim row owns its snapshot
    return out


# ── crediting (reuse existing services) ────────────────────────────────────
async def _lmb_credit_points(*, student_clean_id: str, points: int,
                             campaign_id: str, campaign_name: str,
                             claim_id: str) -> dict:
    """Credit points via the EXISTING login-reward treasury pipeline.
    Returns the same shape as _lrc_credit_via_treasury so the caller can
    introspect failures cleanly."""
    fn = globals().get("_lrc_credit_via_treasury")
    if not callable(fn):
        return {"ok": False, "error": "_lrc_credit_via_treasury unavailable"}
    return await fn(
        student_clean_id=student_clean_id,
        points=int(points),
        campaign_id=campaign_id,
        campaign_name=f"Login Mystery Box · {campaign_name}",
    )


async def _lmb_mirror_points_ledger(*, clean_id: str, wallet_to_id: str,
                                    points: int, campaign_id: str,
                                    campaign_name: str, claim_id: str,
                                    finalize_iso: str) -> None:
    """Write a confirmed Mongo ledger row so the points credit shows up
    in My Portal immediately. Idempotent on idempotency_key. Failure is
    non-fatal — the GAS credit has already succeeded."""
    try:
        idem = f"login_mystery_box:{claim_id}"
        await db.points_transactions.update_one(  # noqa: F821
            {"idempotency_key": idem},
            {
                "$setOnInsert": {
                    "idempotency_key": idem,
                    "from_id":         "treasury",
                    "to_id":           wallet_to_id,
                    "student_id":      wallet_to_id,
                    "clean_id":        clean_id,
                    "amount":          int(points),
                    "type":            "credit",
                    "operation":       "credit",
                    "delta":           int(points),
                    "source":          "login_mystery_box",
                    "source_ref":      campaign_id,
                    "status":          "confirmed",
                    "created_at":      finalize_iso,
                    "payload": {
                        "campaign_id":   campaign_id,
                        "campaign_name": campaign_name,
                        "clean_id":      clean_id,
                        "claim_id":      claim_id,
                    },
                },
            },
            upsert=True,
        )
    except Exception as _e:
        _LMB_LOG.warning(
            "login_mystery_box: ledger mirror failed (non-fatal) claim=%s err=%s",
            claim_id, _e,
        )


async def _lmb_issue_voucher(*, reward: dict, sid_clean: str, sid_norm: str,
                             campaign: dict, claim_id: str) -> Optional[dict]:
    """Mint a single-use coupon + student_vouchers row using the EXACT
    same shape login_reward_tools uses. We do this inline (instead of
    calling _lrc_issue_voucher_for_claim) because that helper is keyed on
    a campaign-level voucher config, whereas our voucher is per-box.

    Returns the composed voucher payload (matches login-reward shape) or
    None on failure."""
    # Reuse the helpers loaded by login_reward_tools.
    gen_code = globals().get("_lrc_gen_coupon_code")
    label_fn = globals().get("_lrc_voucher_discount_label")
    compose = globals().get("_lrc_compose_voucher_payload")
    student_vouchers = globals().get("_lrc_student_vouchers")

    if not (callable(gen_code) and callable(compose) and student_vouchers is not None):
        _LMB_LOG.warning("login_mystery_box: voucher issuer missing (login_reward_tools not loaded)")
        return None

    dtype = (reward.get("voucher_discount_type") or "percent").strip().lower()
    try:
        dval = float(reward.get("voucher_discount_value") or 0)
    except Exception:
        dval = 0.0
    if dval <= 0:
        return None

    # Generate a unique coupon code using the existing generator + retry loop.
    code = gen_code(8)
    for _ in range(6):
        if not await db.coupons.find_one({"code": code}, {"_id": 0}):  # noqa: F821
            break
        code = gen_code(8)
    else:
        _LMB_LOG.error("login_mystery_box: could not mint unique coupon claim=%s", claim_id)
        return None

    now = _lmb_now()
    now_iso = _lmb_iso(now)

    # Expiry: voucher_valid_days → campaign end_at → none.
    exp_iso = None
    vdays = reward.get("voucher_valid_days")
    if vdays:
        try:
            exp_iso = _lmb_iso(now + timedelta(days=int(vdays)))  # noqa: F821
        except Exception:
            exp_iso = None
    if not exp_iso:
        d = _lmb_parse_iso(campaign.get("end_at"))
        exp_iso = _lmb_iso(d) if d else None

    book_slugs = list(reward.get("voucher_book_slugs") or [])
    try:
        max_uses = int(reward.get("voucher_max_uses") or 1)
    except Exception:
        max_uses = 1
    if max_uses < 1:
        max_uses = 1

    coupon_doc = {
        "code": code,
        "type": dtype,
        "value": dval,
        "max_uses": max_uses,
        "uses_count": 0,
        "assigned_to": [],
        "book_slugs": book_slugs,
        "valid_from": now_iso,
        "expires_at": exp_iso,
        "enabled": True,
        "created_by": "login_mystery_box",
        "created_at": now_iso,
        "redemptions": [],
        "source": "login_mystery_box_voucher",
        "campaign_id": campaign.get("id") or campaign.get("campaign_id"),
    }
    try:
        await db.coupons.insert_one(coupon_doc)  # noqa: F821
    except Exception as _e:
        _LMB_LOG.warning("login_mystery_box: coupon insert failed claim=%s err=%s", claim_id, _e)
        return None

    label = label_fn(dtype, dval) if callable(label_fn) else f"{dtype} {dval}"

    row = {
        "id": "lmbv_" + _lmb_secrets.token_hex(8),
        "campaign_id": campaign.get("id") or campaign.get("campaign_id"),
        "campaign_name": campaign.get("name") or "",
        "student_id": sid_clean,
        "student_id_norm": sid_norm,
        "coupon_code": code,
        "reward_kind": "voucher",
        "title": reward.get("voucher_title") or "Book Voucher",
        "subtitle": reward.get("voucher_subtitle") or "",
        "discount_label": label,
        "discount_type": dtype,
        "discount_value": dval,
        "template": reward.get("voucher_template") or "royal_purple_gold",
        "accent_color": reward.get("voucher_accent_color") or "#D4A843",
        "artwork_url": "",
        "cta_label": "Use Voucher",
        "eligible_books": book_slugs,
        "applies_to_all_books": not bool(book_slugs),
        "expires_at": exp_iso,
        "valid_from": now_iso,
        "claimed_at": now_iso,
        "used_at": None,
        "redeemed_book_slug": None,
        "status": "active",
        "source": "login_mystery_box_voucher",
        "claim_id": claim_id,
    }
    try:
        await student_vouchers.insert_one(row)
    except Exception as _e:
        _LMB_LOG.warning("login_mystery_box: student_vouchers insert failed claim=%s err=%s", claim_id, _e)
        # The coupon row exists; surface the code so the student isn't lost.
    try:
        return await compose(row)
    except Exception:
        # Best-effort raw view.
        return {
            "voucher_id": row["id"],
            "coupon_code": code,
            "discount_label": label,
            "expires_at": exp_iso,
            "title": row["title"],
        }


async def _lmb_grant_edutalk(*, reward: dict, sid_clean: str, sid_norm: str,
                             campaign_id: str, claim_id: str) -> Optional[dict]:
    """Issue an EduTalk pass entitlement by reusing the existing
    _mbt_grant_edutalk_pass helper (Speaking Lab Mystery Box pattern)."""
    fn = globals().get("_mbt_grant_edutalk_pass")
    if not callable(fn):
        _LMB_LOG.warning("login_mystery_box: _mbt_grant_edutalk_pass unavailable")
        return None
    rtype = reward.get("reward_type") or "edutalk_session"
    try:
        row = await fn(
            student_clean_id=sid_clean,
            student_id_norm=sid_norm,
            feature=rtype,
            title=reward.get("edutalk_title") or "EduTalk Pass",
            quantity=int(reward.get("edutalk_quantity") or 1),
            eligible_book_slugs=list(reward.get("edutalk_eligible_book_slugs") or []),
            expires_in_days=int(reward.get("edutalk_expires_in_days") or 30),
            source="login_mystery_box",
            campaign_id=campaign_id,
            round_id=claim_id,
        )
    except Exception as _e:
        _LMB_LOG.warning("login_mystery_box: edutalk pass grant failed claim=%s err=%s", claim_id, _e)
        return None
    return {
        "quantity": row.get("quantity_total"),
        "expires_at": row.get("expires_at"),
        "feature": rtype,
        "title": row.get("title"),
    }


# ── pick the highest-priority eligible campaign for a student ───────────────
async def _lmb_pick_active(sid_norm: str) -> Optional[dict]:
    now = _lmb_now()
    cur = _lmb_campaigns.find({"enabled": True}, {"_id": 0}).sort(
        [("priority", -1), ("created_at", -1)]
    )
    async for doc in cur:
        start = _lmb_parse_iso(doc.get("start_at"))
        end = _lmb_parse_iso(doc.get("end_at"))
        if start and now < start:
            continue
        if end and now > end:
            continue
        if not _lmb_eligible(doc, sid_norm):
            continue
        return doc
    return None


# ============================================================================
# ADMIN ROUTES
# ============================================================================
@api.get("/admin/login-mystery/campaigns")  # noqa: F821
async def lmb_admin_list_campaigns(admin=Depends(require_admin)):  # type: ignore[name-defined]  # noqa: F821
    rows = []
    async for r in _lmb_campaigns.find({}, {"_id": 0}).sort("created_at", -1).limit(200):
        rows.append(_lmb_serialize_campaign(r))
    return {"campaigns": rows, "count": len(rows)}


@api.post("/admin/login-mystery/campaigns")  # noqa: F821
async def lmb_admin_create_campaign(
    payload: _LMBCampaignIn,
    admin=Depends(require_admin),  # type: ignore[name-defined]  # noqa: F821
):
    data = _lmb_validate_payload(payload)
    now_iso = _lmb_iso(_lmb_now())
    cid = "lmb_" + _lmb_secrets.token_hex(6)
    doc = {
        "id": cid,
        "campaign_id": cid,
        **data,
        "created_at": now_iso,
        "updated_at": now_iso,
        "created_by": getattr(admin, "email", "") or "",
    }
    await _lmb_campaigns.insert_one(doc)
    _LMB_LOG.info(
        "login_mystery_box: created %s by %s enabled=%s",
        cid, doc["created_by"], doc.get("enabled"),
    )
    return {"success": True, "campaign": _lmb_serialize_campaign(doc)}


@api.get("/admin/login-mystery/campaigns/{campaign_id}")  # noqa: F821
async def lmb_admin_get_campaign(
    campaign_id: str,
    admin=Depends(require_admin),  # type: ignore[name-defined]  # noqa: F821
):
    doc = await _lmb_campaigns.find_one({"id": campaign_id}, {"_id": 0})
    if not doc:
        raise HTTPException(status_code=404, detail="Campaign not found")  # noqa: F821
    return {"campaign": _lmb_serialize_campaign(doc)}


@api.put("/admin/login-mystery/campaigns/{campaign_id}")  # noqa: F821
async def lmb_admin_update_campaign(
    campaign_id: str,
    payload: _LMBCampaignIn,
    admin=Depends(require_admin),  # type: ignore[name-defined]  # noqa: F821
):
    existing = await _lmb_campaigns.find_one({"id": campaign_id}, {"_id": 0})
    if not existing:
        raise HTTPException(status_code=404, detail="Campaign not found")  # noqa: F821
    data = _lmb_validate_payload(payload)
    data["updated_at"] = _lmb_iso(_lmb_now())
    await _lmb_campaigns.update_one({"id": campaign_id}, {"$set": data})
    doc = await _lmb_campaigns.find_one({"id": campaign_id}, {"_id": 0})
    _LMB_LOG.info(
        "login_mystery_box: updated %s by %s enabled=%s",
        campaign_id, getattr(admin, "email", ""), data.get("enabled"),
    )
    return {"success": True, "campaign": _lmb_serialize_campaign(doc)}


@api.delete("/admin/login-mystery/campaigns/{campaign_id}")  # noqa: F821
async def lmb_admin_delete_campaign(
    campaign_id: str,
    admin=Depends(require_admin),  # type: ignore[name-defined]  # noqa: F821
):
    res = await _lmb_campaigns.delete_one({"id": campaign_id})
    if res.deleted_count == 0:
        raise HTTPException(status_code=404, detail="Campaign not found")  # noqa: F821
    _LMB_LOG.info("login_mystery_box: deleted %s by %s", campaign_id, getattr(admin, "email", ""))
    return {"success": True, "deleted": campaign_id}


@api.get("/admin/login-mystery/claims")  # noqa: F821
async def lmb_admin_list_claims(
    campaign_id: Optional[str] = None,
    limit: int = 200,
    admin=Depends(require_admin),  # type: ignore[name-defined]  # noqa: F821
):
    q: dict = {}
    if campaign_id:
        q["campaign_id"] = campaign_id
    try:
        limit = max(1, min(1000, int(limit)))
    except Exception:
        limit = 200
    rows = []
    async for r in _lmb_claims.find(q, {"_id": 0}).sort("claimed_at", -1).limit(limit):
        rows.append(r)
    return {"claims": rows, "count": len(rows)}


@api.get("/admin/login-mystery/analytics")  # noqa: F821
async def lmb_admin_analytics(
    campaign_id: Optional[str] = None,
    admin=Depends(require_admin),  # type: ignore[name-defined]  # noqa: F821
):
    """Aggregate analytics for the admin dashboard. Reads from
    login_mystery_claims only — never touches the live wallet/voucher tables."""
    match: dict = {"status": "credited"}
    if campaign_id:
        match["campaign_id"] = campaign_id

    total_claims = await _lmb_claims.count_documents(match)

    # Totals & per-box / per-type aggregations.
    pipe = [
        {"$match": match},
        {"$group": {
            "_id": None,
            "total_claims":           {"$sum": 1},
            "points_issued":          {"$sum": {"$ifNull": ["$selected.points", 0]}},
            "vouchers_issued":        {"$sum": {
                "$cond": [
                    {"$eq": ["$selected.reward_type", "voucher"]}, 1, 0,
                ]
            }},
            "edutalk_sessions_issued": {"$sum": {
                "$cond": [
                    {"$eq": ["$selected.reward_type", "edutalk_session"]}, 1, 0,
                ]
            }},
            "edutalk_voice_issued":   {"$sum": {
                "$cond": [
                    {"$eq": ["$selected.reward_type", "edutalk_voice"]}, 1, 0,
                ]
            }},
        }},
    ]
    totals = {"total_claims": 0, "points_issued": 0, "vouchers_issued": 0,
              "edutalk_sessions_issued": 0, "edutalk_voice_issued": 0}
    async for row in _lmb_claims.aggregate(pipe):
        totals = {
            "total_claims":            int(row.get("total_claims") or 0),
            "points_issued":           int(row.get("points_issued") or 0),
            "vouchers_issued":         int(row.get("vouchers_issued") or 0),
            "edutalk_sessions_issued": int(row.get("edutalk_sessions_issued") or 0),
            "edutalk_voice_issued":    int(row.get("edutalk_voice_issued") or 0),
        }
        break

    # Most-selected box position.
    box_pipe = [
        {"$match": match},
        {"$group": {"_id": "$selected_box_index", "count": {"$sum": 1}}},
        {"$sort": {"_id": 1}},
    ]
    box_distribution = []
    async for row in _lmb_claims.aggregate(box_pipe):
        box_distribution.append({
            "box_index": int(row.get("_id") or 0),
            "count": int(row.get("count") or 0),
        })

    # Reward distribution (label + type).
    reward_pipe = [
        {"$match": match},
        {"$group": {
            "_id": {
                "label": "$selected.label",
                "type":  "$selected.reward_type",
            },
            "count": {"$sum": 1},
        }},
        {"$sort": {"count": -1}},
        {"$limit": 30},
    ]
    reward_distribution = []
    async for row in _lmb_claims.aggregate(reward_pipe):
        rid = row.get("_id") or {}
        reward_distribution.append({
            "label": rid.get("label") or "Reward",
            "reward_type": rid.get("type") or "points",
            "count": int(row.get("count") or 0),
        })

    # Recent claims preview.
    recent = []
    async for r in _lmb_claims.find(
        match, {"_id": 0, "student_id": 1, "campaign_id": 1, "campaign_name": 1,
                "selected": 1, "selected_box_index": 1, "claimed_at": 1, "credited_at": 1}
    ).sort("claimed_at", -1).limit(25):
        recent.append(r)

    # Campaign status snapshot.
    camp_status = None
    if campaign_id:
        cd = await _lmb_campaigns.find_one({"id": campaign_id}, {"_id": 0})
        if cd:
            camp_status = {
                "id": cd.get("id"),
                "name": cd.get("name"),
                "status": _lmb_status(cd),
                "enabled": bool(cd.get("enabled")),
                "start_at": cd.get("start_at"),
                "end_at": cd.get("end_at"),
            }

    return {
        "total_claims": total_claims,
        "totals": totals,
        "box_distribution": box_distribution,
        "reward_distribution": reward_distribution,
        "recent_claims": recent,
        "campaign_status": camp_status,
    }


# ============================================================================
# STUDENT ROUTES
# ============================================================================
def _lmb_compose_student_status_response(
    *, eligible: bool, reason: str = "", campaign: Optional[dict] = None,
    boxes: Optional[list] = None, claim_id: str = "",
    selected_index: Optional[int] = None,
    selected_reward: Optional[dict] = None,
    revealed: Optional[list] = None,
    already_claimed: bool = False,
    voucher: Optional[dict] = None,
    edutalk_pass: Optional[dict] = None,
) -> dict:
    return {
        "eligible": bool(eligible),
        "reason": reason or "",
        "already_claimed": bool(already_claimed),
        "campaign": _lmb_public_campaign_view(campaign) if campaign else None,
        "claim_id": claim_id or "",
        "boxes": boxes or [],
        "selected_box_index": selected_index,
        "selected_reward": selected_reward,
        "revealed_rewards": revealed or [],
        "voucher": voucher,
        "edutalk_pass": edutalk_pass,
        "box_count": _LMB_BOX_COUNT,
    }


@api.get("/student/login-mystery/status")  # noqa: F821
async def lmb_student_status(
    student=Depends(require_student),  # type: ignore[name-defined]  # noqa: F821
):
    """Return the student's current Login Mystery Box state.

    If an active eligible campaign exists and the student has NOT yet
    claimed for the current eligibility window, this endpoint will
    atomically LOCK the 4 box outcomes on the server (via an upsert into
    login_mystery_claims with status="preview") and return the 4 face-down
    placeholder boxes plus a claim_id. The actual prize contents are
    NEVER returned at this stage — only after /select.

    If a credited claim already exists for the current window, returns
    `already_claimed=true` plus the revealed selected reward + the 3
    other-box outcomes so the UI can show the post-claim recap.
    """
    sid_clean = (getattr(student, "clean_id", "") or "").strip() or getattr(student, "student_id", "")
    sid_norm = _lmb_norm_id(sid_clean)
    if not sid_norm:
        return _lmb_compose_student_status_response(eligible=False, reason="no_student_id")

    camp = await _lmb_pick_active(sid_norm)
    if not camp:
        return _lmb_compose_student_status_response(eligible=False, reason="no_active_campaign")

    campaign_id = camp.get("id")
    window = _lmb_eligibility_window(camp)

    # Already credited for this window?
    existing = await _lmb_claims.find_one(
        {"campaign_id": campaign_id, "student_id_norm": sid_norm,
         "eligibility_window": window},
        {"_id": 0},
    )
    if existing and (existing.get("status") or "") == "credited":
        revealed = [
            _lmb_public_reward_view(b)
            for b in (existing.get("box_outcomes") or [])
        ]
        return _lmb_compose_student_status_response(
            eligible=False,
            already_claimed=True,
            reason="already_claimed",
            campaign=camp,
            claim_id=existing.get("id", ""),
            boxes=[{"box_index": i, "status": "revealed"} for i in range(_LMB_BOX_COUNT)],
            selected_index=existing.get("selected_box_index"),
            selected_reward=_lmb_public_reward_view(existing.get("selected") or {}),
            revealed=revealed,
            voucher=existing.get("voucher_payload"),
            edutalk_pass=existing.get("edutalk_payload"),
        )

    # No credited claim yet. Lock outcomes via idempotent upsert.
    now_iso = _lmb_iso(_lmb_now())
    if existing and (existing.get("status") or "") == "preview" and existing.get("box_outcomes"):
        # Reuse the already-generated outcomes (same student refreshed).
        claim_id = existing.get("id") or ("lmbcl_" + _lmb_secrets.token_hex(8))
        outcomes = existing.get("box_outcomes") or []
    else:
        outcomes = _lmb_pick_box_outcomes(camp.get("reward_pool") or [], _LMB_BOX_COUNT)
        if len(outcomes) < _LMB_BOX_COUNT:
            _LMB_LOG.warning(
                "login_mystery_box: outcomes shorter than expected campaign=%s got=%d",
                campaign_id, len(outcomes),
            )
            return _lmb_compose_student_status_response(
                eligible=False, reason="reward_pool_misconfigured", campaign=camp,
            )
        claim_id = "lmbcl_" + _lmb_secrets.token_hex(8)
        preview_doc = {
            "id": claim_id,
            "campaign_id": campaign_id,
            "campaign_name": camp.get("name") or "",
            "student_id": sid_clean,
            "student_id_norm": sid_norm,
            "eligibility_window": window,
            "box_outcomes": outcomes,
            "selected_box_index": None,
            "selected": None,
            "status": "preview",
            "created_at": now_iso,
            "updated_at": now_iso,
            "claimed_at": None,
            "credited_at": None,
        }
        try:
            await _lmb_claims.insert_one(preview_doc)
        except Exception:
            # Concurrent race — re-read the winning row and reuse its outcomes.
            existing = await _lmb_claims.find_one(
                {"campaign_id": campaign_id, "student_id_norm": sid_norm,
                 "eligibility_window": window},
                {"_id": 0},
            )
            if not existing:
                _LMB_LOG.warning(
                    "login_mystery_box: race with no readable doc student=%s campaign=%s",
                    sid_clean, campaign_id,
                )
                return _lmb_compose_student_status_response(
                    eligible=False, reason="claim_race", campaign=camp,
                )
            if (existing.get("status") or "") == "credited":
                # Race winner already claimed — switch to recap branch.
                revealed = [
                    _lmb_public_reward_view(b)
                    for b in (existing.get("box_outcomes") or [])
                ]
                return _lmb_compose_student_status_response(
                    eligible=False, already_claimed=True,
                    reason="already_claimed", campaign=camp,
                    claim_id=existing.get("id", ""),
                    boxes=[{"box_index": i, "status": "revealed"} for i in range(_LMB_BOX_COUNT)],
                    selected_index=existing.get("selected_box_index"),
                    selected_reward=_lmb_public_reward_view(existing.get("selected") or {}),
                    revealed=revealed,
                    voucher=existing.get("voucher_payload"),
                    edutalk_pass=existing.get("edutalk_payload"),
                )
            claim_id = existing.get("id") or claim_id
            outcomes = existing.get("box_outcomes") or outcomes

    boxes_public = [
        {"box_index": i, "status": "locked",
         "reward_preview": _lmb_public_reward_view({}, hidden=True)}
        for i in range(_LMB_BOX_COUNT)
    ]
    return _lmb_compose_student_status_response(
        eligible=True, campaign=camp, claim_id=claim_id, boxes=boxes_public,
    )


class _LMBSelectPayload(BaseModel):
    model_config = ConfigDict(extra="ignore")
    box_index: int = Field(..., ge=0, le=_LMB_BOX_COUNT - 1)
    claim_id: Optional[str] = None  # cross-check; backend is source of truth


@api.post("/student/login-mystery/select")  # noqa: F821
async def lmb_student_select(
    payload: _LMBSelectPayload,
    student=Depends(require_student),  # type: ignore[name-defined]  # noqa: F821
):
    """Student picks one of the 4 boxes. Backend credits ONLY the selected
    reward and returns all 4 revealed outcomes (selected + 3 others)."""
    sid_clean = (getattr(student, "clean_id", "") or "").strip() or getattr(student, "student_id", "")
    sid_norm = _lmb_norm_id(sid_clean)
    if not sid_norm:
        raise HTTPException(status_code=400, detail="No student identity")  # noqa: F821

    camp = await _lmb_pick_active(sid_norm)
    if not camp:
        raise HTTPException(status_code=400, detail="No active mystery box campaign")  # noqa: F821

    campaign_id = camp.get("id")
    window = _lmb_eligibility_window(camp)

    claim = await _lmb_claims.find_one(
        {"campaign_id": campaign_id, "student_id_norm": sid_norm,
         "eligibility_window": window},
        {"_id": 0},
    )
    if not claim:
        raise HTTPException(status_code=400, detail="Open the boxes first (status not initialised).")  # noqa: F821

    status_now = (claim.get("status") or "").lower()
    if status_now == "credited":
        # Idempotent re-reveal — never credits again.
        revealed = [
            _lmb_public_reward_view(b)
            for b in (claim.get("box_outcomes") or [])
        ]
        return {
            "success": True,
            "duplicate": True,
            "already_claimed": True,
            "claim_id": claim.get("id"),
            "selected_box_index": claim.get("selected_box_index"),
            "selected_reward": _lmb_public_reward_view(claim.get("selected") or {}),
            "revealed_rewards": revealed,
            "success_message": camp.get("success_message") or "Reward already credited.",
            "post_claim_message": camp.get("post_claim_message") or "",
            "voucher": claim.get("voucher_payload"),
            "edutalk_pass": claim.get("edutalk_payload"),
        }
    if status_now != "preview":
        raise HTTPException(status_code=409, detail=f"Claim in unexpected state: {status_now or 'unknown'}")  # noqa: F821

    box_idx = int(payload.box_index)
    outcomes = list(claim.get("box_outcomes") or [])
    if box_idx < 0 or box_idx >= len(outcomes):
        raise HTTPException(status_code=400, detail="Invalid box_index")  # noqa: F821

    selected = outcomes[box_idx]
    rtype = (selected.get("reward_type") or "points").lower()

    # ── atomic ownership grab: only one caller per claim may finalise.
    attempt_id = _lmb_secrets.token_hex(12)
    now_iso = _lmb_iso(_lmb_now())
    acquired = await _lmb_claims.find_one_and_update(
        {
            "id": claim.get("id"),
            "status": "preview",
        },
        {
            "$set": {
                "status": "pending",
                "selected_box_index": box_idx,
                "selected": selected,
                "claimed_at": now_iso,
                "attempt_id": attempt_id,
                "updated_at": now_iso,
            },
        },
    )
    if acquired is None:
        # Lost the race — re-read and respond idempotently.
        latest = await _lmb_claims.find_one({"id": claim.get("id")}, {"_id": 0})
        if latest and (latest.get("status") or "") == "credited":
            revealed = [
                _lmb_public_reward_view(b)
                for b in (latest.get("box_outcomes") or [])
            ]
            return {
                "success": True,
                "duplicate": True,
                "already_claimed": True,
                "claim_id": latest.get("id"),
                "selected_box_index": latest.get("selected_box_index"),
                "selected_reward": _lmb_public_reward_view(latest.get("selected") or {}),
                "revealed_rewards": revealed,
                "success_message": camp.get("success_message") or "Reward already credited.",
                "post_claim_message": camp.get("post_claim_message") or "",
                "voucher": latest.get("voucher_payload"),
                "edutalk_pass": latest.get("edutalk_payload"),
            }
        raise HTTPException(status_code=409, detail="Claim already in flight")  # noqa: F821

    # ── credit only the selected reward ────────────────────────────────
    voucher_payload = None
    edutalk_payload = None
    credit_error: Optional[str] = None

    try:
        if rtype == "points":
            pts = int(selected.get("points") or 0)
            if pts <= 0:
                credit_error = "points reward misconfigured (amount<=0)"
            else:
                credit = await _lmb_credit_points(
                    student_clean_id=sid_clean,
                    points=pts,
                    campaign_id=campaign_id,
                    campaign_name=camp.get("name") or "",
                    claim_id=claim.get("id"),
                )
                if not credit.get("ok"):
                    credit_error = str(credit.get("error") or "credit_failed")[:300]
                else:
                    # Mirror into Mongo ledger (My Portal source-of-truth).
                    wallet_to_id = (
                        getattr(student, "student_id", "")
                        or _lmb_norm_id(sid_clean)
                        or sid_clean
                    )
                    await _lmb_mirror_points_ledger(
                        clean_id=sid_clean,
                        wallet_to_id=wallet_to_id,
                        points=pts,
                        campaign_id=campaign_id,
                        campaign_name=camp.get("name") or "",
                        claim_id=claim.get("id"),
                        finalize_iso=now_iso,
                    )
        elif rtype == "voucher":
            voucher_payload = await _lmb_issue_voucher(
                reward=selected, sid_clean=sid_clean, sid_norm=sid_norm,
                campaign=camp, claim_id=claim.get("id"),
            )
            if not voucher_payload:
                credit_error = "voucher_issue_failed"
        elif rtype in ("edutalk_session", "edutalk_voice"):
            edutalk_payload = await _lmb_grant_edutalk(
                reward=selected, sid_clean=sid_clean, sid_norm=sid_norm,
                campaign_id=campaign_id, claim_id=claim.get("id"),
            )
            if not edutalk_payload:
                credit_error = "edutalk_pass_grant_failed"
        else:
            credit_error = f"unsupported reward_type: {rtype}"
    except Exception as _e:
        credit_error = f"credit_exception: {str(_e)[:200]}"

    if credit_error:
        try:
            await _lmb_claims.update_one(
                {"id": claim.get("id"), "attempt_id": attempt_id, "status": "pending"},
                {"$set": {
                    "status": "failed",
                    "failed_at": _lmb_iso(_lmb_now()),
                    "error": credit_error,
                    "updated_at": _lmb_iso(_lmb_now()),
                }},
            )
        except Exception as _ue:
            _LMB_LOG.warning("login_mystery_box: mark-failed update error: %s", _ue)
        _LMB_LOG.warning(
            "login_mystery_box: credit failed student=%s campaign=%s err=%s",
            sid_clean, campaign_id, credit_error,
        )
        raise HTTPException(status_code=502, detail=f"Reward credit failed: {credit_error}")  # noqa: F821

    # ── finalize ────────────────────────────────────────────────────────
    finalize_iso = _lmb_iso(_lmb_now())
    set_doc = {
        "status": "credited",
        "credited_at": finalize_iso,
        "updated_at": finalize_iso,
    }
    if voucher_payload:
        set_doc["voucher_payload"] = voucher_payload
    if edutalk_payload:
        set_doc["edutalk_payload"] = edutalk_payload

    finalized = await _lmb_claims.update_one(
        {"id": claim.get("id"), "attempt_id": attempt_id, "status": "pending"},
        {"$set": set_doc},
    )
    if finalized.modified_count == 0:
        # Someone finalised already — re-read and respond from the truth.
        latest = await _lmb_claims.find_one({"id": claim.get("id")}, {"_id": 0})
        if latest and (latest.get("status") or "") == "credited":
            revealed = [
                _lmb_public_reward_view(b)
                for b in (latest.get("box_outcomes") or [])
            ]
            return {
                "success": True,
                "duplicate": True,
                "already_claimed": True,
                "claim_id": latest.get("id"),
                "selected_box_index": latest.get("selected_box_index"),
                "selected_reward": _lmb_public_reward_view(latest.get("selected") or {}),
                "revealed_rewards": revealed,
                "success_message": camp.get("success_message") or "Reward already credited.",
                "post_claim_message": camp.get("post_claim_message") or "",
                "voucher": latest.get("voucher_payload"),
                "edutalk_pass": latest.get("edutalk_payload"),
            }

    # ── celebration push (best-effort) ─────────────────────────────────
    try:
        fan_out = globals().get("_fan_out_push")
        if callable(fan_out):
            push_candidates = []
            for _c in (
                sid_clean,
                _lmb_norm_id(sid_clean),
                getattr(student, "student_id", "") or "",
            ):
                if _c and _c not in push_candidates:
                    push_candidates.append(_c)
            if push_candidates:
                rtitle = ""
                if rtype == "points":
                    rtitle = f"+{int(selected.get('points') or 0)} pts"
                elif rtype == "voucher":
                    rtitle = "Book Voucher"
                else:
                    rtitle = selected.get("edutalk_title") or "EduTalk Pass"
                await fan_out(
                    {"studentId": {"$in": push_candidates}},
                    title=f"🎁 Mystery Box · {rtitle}",
                    body=(camp.get("success_message") or "Reward claimed!"),
                    url="/portal",
                )
    except Exception as _pe:
        _LMB_LOG.warning("login_mystery_box: push failed (non-fatal): %s", _pe)

    revealed_rewards = [_lmb_public_reward_view(b) for b in outcomes]

    _LMB_LOG.info(
        "login_mystery_box: credited student=%s campaign=%s box=%d type=%s",
        sid_clean, campaign_id, box_idx, rtype,
    )

    return {
        "success": True,
        "duplicate": False,
        "claim_id": claim.get("id"),
        "selected_box_index": box_idx,
        "selected_reward": _lmb_public_reward_view(selected),
        "revealed_rewards": revealed_rewards,
        "success_message": camp.get("success_message") or "Reward claimed!",
        "post_claim_message": camp.get("post_claim_message") or "",
        "reveal_remaining": bool(camp.get("reveal_remaining", True)),
        "voucher": voucher_payload,
        "edutalk_pass": edutalk_payload,
    }


@api.get("/student/login-mystery/history")  # noqa: F821
async def lmb_student_history(
    limit: int = 20,
    student=Depends(require_student),  # type: ignore[name-defined]  # noqa: F821
):
    sid_clean = (getattr(student, "clean_id", "") or "").strip() or getattr(student, "student_id", "")
    sid_norm = _lmb_norm_id(sid_clean)
    if not sid_norm:
        return {"history": [], "count": 0}
    try:
        limit = max(1, min(50, int(limit)))
    except Exception:
        limit = 20

    rows = []
    cur = _lmb_claims.find(
        {"student_id_norm": sid_norm, "status": "credited"},
        {"_id": 0, "id": 1, "campaign_id": 1, "campaign_name": 1,
         "selected_box_index": 1, "selected": 1, "box_outcomes": 1,
         "claimed_at": 1, "credited_at": 1},
    ).sort("credited_at", -1).limit(limit)
    async for r in cur:
        rows.append({
            "claim_id": r.get("id"),
            "campaign_id": r.get("campaign_id"),
            "campaign_name": r.get("campaign_name") or "",
            "selected_box_index": r.get("selected_box_index"),
            "selected_reward": _lmb_public_reward_view(r.get("selected") or {}),
            "revealed_rewards": [
                _lmb_public_reward_view(b) for b in (r.get("box_outcomes") or [])
            ],
            "claimed_at": r.get("claimed_at"),
            "credited_at": r.get("credited_at"),
        })
    return {"history": rows, "count": len(rows)}


_LMB_LOG.info("login_mystery_box: routes registered (admin + student)")
