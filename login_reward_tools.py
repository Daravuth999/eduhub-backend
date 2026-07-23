# ===========================================================================
# login_reward_tools.py - EduHub Login Reward Campaign system
#
# Registered via register_login_reward_routes(api, db, require_student,
# require_admin, Student, User, fan_out_push, gas_points_login_url,
# sl_treasury_id, sl_treasury_password, build_target_query,
# generate_coupon_code) from server.py (normal import, explicit DI — matches
# the established register_*_routes convention; Architecture Reconstruction
# Phase 1, item 2).
#
# This module is the HUB of the "reward chain" — voucher_reward_tools.py,
# mystery_box_tools.py, and login_mystery_box_tools.py (all load AFTER this
# module) previously read 10 of its names via globals().get(...): _lrc_now,
# _lrc_iso, _lrc_parse_iso, _lrc_safe_artwork_url, _lrc_voucher_discount_label
# (all PURE — no db/api dependency, so those siblings now just
# `from login_reward_tools import <name>` directly, a real import, since
# this is a real module now), plus _lrc_credit_via_treasury,
# _lrc_issue_voucher_for_claim, _lrc_compose_voucher_payload,
# _lrc_gen_coupon_code, _lrc_student_vouchers (the db-bound ones, which
# only exist once register_login_reward_routes() has run — those are
# returned from the register call as a small namespace, see
# ``LoginRewardHooks`` below, and passed as an explicit parameter to the
# three siblings' own register calls).
#
# Feature (additive only, never touches existing modules):
#   * Admin (Author Studio) CRUD for login-reward campaigns.
#   * Student-facing endpoints to fetch the active eligible campaign and
#     to claim its reward once.
#   * Atomic single-claim guard via a unique compound index
#     (campaign_id + student_id_norm) on `login_reward_claims`.
#   * Points crediting reuses the SAME treasury -> student GAS sendPoints
#     pipeline that `/api/points/grant` already uses, so the wallet
#     migration flags and existing crediting behaviour are untouched.
#
# Design principles (per surgery brief):
#   * Backend is the source of truth: reward_points, audience and claim
#     state are NEVER trusted from the client - only campaign_id is.
#   * No new auth system - reuses require_admin / require_student.
#   * Default new campaigns are DISABLED to prevent accidental go-live.
# ===========================================================================

import logging as _lrc_logging
import re as _lrc_re
import secrets as _lrc_secrets
from dataclasses import dataclass
from datetime import datetime, timezone, timedelta
from typing import Literal

import httpx
from fastapi import Depends, HTTPException
from fastapi.responses import JSONResponse
from pydantic import BaseModel, ConfigDict, Field

from eduhub_platform.identity import resolve as _norm_student_id

_LRC_LOG = _lrc_logging.getLogger("eduhub")

# Stale-pending takeover threshold: if a pending claim row is older than
# this many seconds, the NEXT caller can atomically take it over and retry.
# This protects students against a server interruption between the pending
# insert and the GAS credit step. Conservative default 90s — slightly above
# the GAS sendPoints timeout (12s + overhead) so genuine in-flight callers
# are never preempted.
_LRC_STALE_PENDING_SECONDS = 90


# ── pure helpers (no db/api dependency — importable directly by siblings) ──
def _lrc_now():
    return datetime.now(timezone.utc)


def _lrc_iso(dt: datetime) -> str:
    if dt.tzinfo is None:
        dt = dt.replace(tzinfo=timezone.utc)
    return dt.astimezone(timezone.utc).isoformat().replace("+00:00", "Z")


def _lrc_parse_iso(value) -> datetime | None:
    if value is None:
        return None
    if isinstance(value, datetime):
        return value if value.tzinfo else value.replace(tzinfo=timezone.utc)
    if not isinstance(value, str):
        return None
    s = value.strip()
    if not s:
        return None
    # Accept Z suffix and offset variants
    try:
        if s.endswith("Z"):
            s = s[:-1] + "+00:00"
        dt = datetime.fromisoformat(s)
        if dt.tzinfo is None:
            dt = dt.replace(tzinfo=timezone.utc)
        return dt
    except Exception:
        return None


def _lrc_norm_id_list(values) -> list[str]:
    """Normalize a list/string of student IDs into a clean list of lowercased
    canonical IDs. Tolerant of CSV strings, arrays, mixed-case inputs and
    accidental whitespace / zero-width chars."""
    if not values:
        return []
    if isinstance(values, str):
        parts = _lrc_re.split(r"[,\s]+", values)
    elif isinstance(values, (list, tuple, set)):
        parts = []
        for v in values:
            if isinstance(v, str):
                parts.extend(_lrc_re.split(r"[,\s]+", v))
            elif v is not None:
                parts.append(str(v))
    else:
        return []
    out: list[str] = []
    seen: set[str] = set()
    for p in parts:
        n = _norm_student_id(p)
        if n and n not in seen:
            seen.add(n)
            out.append(n)
    return out


def _lrc_campaign_status(camp: dict, now: datetime | None = None) -> str:
    """Compute a derived status for UI display only.
    Returns one of: disabled | scheduled | live | expired.
    """
    if not camp.get("enabled"):
        return "disabled"
    now = now or _lrc_now()
    start = _lrc_parse_iso(camp.get("start_at"))
    end   = _lrc_parse_iso(camp.get("end_at"))
    if start and now < start:
        return "scheduled"
    if end and now > end:
        return "expired"
    return "live"


def _lrc_eligible(camp: dict, student_norm_id: str) -> bool:
    aud = (camp.get("audience_type") or "all").lower()
    include = camp.get("include_student_ids") or []
    exclude = camp.get("exclude_student_ids") or []
    inc_norm = {_norm_student_id(x) for x in include if x}
    exc_norm = {_norm_student_id(x) for x in exclude if x}
    if student_norm_id in exc_norm:
        return False
    if aud == "all":
        return True
    if aud in ("specific_students", "specific", "include"):
        return student_norm_id in inc_norm
    if aud == "exclude_only":
        # everyone except excluded
        return student_norm_id not in exc_norm
    return False


def _lrc_serialize(camp: dict, *, with_status: bool = True) -> dict:
    if not camp:
        return camp
    out = dict(camp)
    out.pop("_id", None)
    # ensure id field exists
    if "id" not in out and "campaign_id" in out:
        out["id"] = out["campaign_id"]
    # ISO out datetimes
    for k in ("start_at", "end_at", "created_at", "updated_at"):
        v = out.get(k)
        if isinstance(v, datetime):
            out[k] = _lrc_iso(v)
    if with_status:
        out["status"] = _lrc_campaign_status(out)
    return out


# ── pydantic models ─────────────────────────────────────────────────────────
class _LRCCampaignIn(BaseModel):
    model_config = ConfigDict(extra="ignore")
    name: str = Field(default="Untitled campaign")
    enabled: bool = False
    notes: str | None = ""
    priority: int = 0

    start_at: str | None = None
    end_at: str | None = None
    timezone: str | None = "Asia/Phnom_Penh"

    reward_type: Literal["fixed"] = "fixed"
    reward_points: int = 20
    reward_label: str | None = ""

    audience_type: Literal["all", "specific_students", "exclude_only"] = "all"
    include_student_ids: list[str] | str | None = None
    exclude_student_ids: list[str] | str | None = None

    artwork_url: str | None = ""
    title: str = "Welcome back!"
    subtitle: str = "Claim your surprise learning points today."
    cta_text: str = "Claim Reward"
    success_message: str = "Your reward has been credited!"
    accent_color: str | None = "#D4A843"

    dismiss_mode: Literal["next_login", "after_24h", "never"] = "next_login"
    claim_limit_per_student: int = 1

    # ── Premium animation upgrade v1 (additive, all optional, safe defaults) ──
    # Visual-only UI fields. These do NOT influence the claim pipeline,
    # points-credit logic, idempotency, push, audience eligibility, or any
    # other server-side rule. They are persisted exactly as supplied and
    # echoed back through _lrc_serialize so the frontend popup / studio
    # preview can react to admin choices.
    animation_enabled: bool = True
    particle_intensity: Literal["subtle", "premium", "celebration"] = "premium"
    countdown_enabled: bool = False
    countdown_mode: Literal["none", "campaign_end", "expires_after_open"] = "none"
    countdown_seconds: int | None = None
    countdown_label: str | None = ""
    urgency_text: str | None = ""

    # ── Reward-kind integration v1.0.2 (additive, default-compatible) ─────
    # A campaign can reward Points, a Book Voucher, or BOTH. Existing
    # campaigns (and any client that omits these fields) default to
    # reward_kind="points", which keeps the legacy points-only behaviour
    # byte-identical: the points pipeline below is unchanged for "points".
    #   • "points"          → credit points only (legacy path).
    #   • "voucher"          → issue a Book Voucher only; reward_points is
    #                          NOT required and is forced to 0 so the
    #                          treasury credit path is never invoked.
    #   • "points_voucher"   → credit points (legacy path) AND issue a
    #                          Book Voucher as a best-effort follow-up.
    reward_kind: Literal["points", "voucher", "points_voucher"] = "points"

    # Voucher configuration. Only consumed when reward_kind includes a
    # voucher. The voucher is materialised as a real coupon in db.coupons
    # using the EXISTING coupon schema (uses_count / redemptions / max_uses
    # / type / value / assigned_to / book_slugs / valid_from / expires_at /
    # enabled) and redeemed through the EXISTING /api/coupons flow.
    voucher_discount_type: Literal["percent", "fixed"] = "percent"
    voucher_discount_value: float = 0
    voucher_max_uses: int | None = 1          # per issued coupon; None = unlimited
    voucher_valid_days: int | None = None     # expiry = claim time + N days
    voucher_expires_at: str | None = None     # optional explicit ISO override
    voucher_book_slugs: list[str] | str | None = None   # [] / empty = all books
    voucher_title: str | None = "Book Voucher"
    voucher_subtitle: str | None = ""
    voucher_discount_label: str | None = ""   # auto-derived when blank
    voucher_template: str | None = "royal_purple_gold"
    voucher_accent_color: str | None = "#D4A843"
    voucher_artwork_url: str | None = ""
    voucher_cta_label: str | None = "Use Voucher"

    # Reward-kind v1.0.3 — coupon source. "auto" mints a fresh unique
    # single-use coupon per student on claim (default, unchanged). "existing"
    # links an admin-provided coupon code that already exists in db.coupons;
    # no new coupon is minted and the existing coupon's own config (discount,
    # max_uses, expiry, assignment) governs redemption.
    voucher_source: Literal["auto", "existing"] = "auto"
    voucher_existing_code: str | None = ""

    # ── Smart Push Notification per-campaign config v1 (additive, all optional) ──
    # Persists the admin's push notification settings for THIS campaign so the
    # Author Studio can offer a "Send Push Now" action and the settings survive
    # page reloads. Sending itself reuses the EXISTING /api/push/* fan-out
    # infrastructure — these fields ONLY describe what the admin wants to send.
    # Existing campaigns without these fields keep working unchanged because
    # the model is `extra="ignore"` and every field below has a safe default.
    #
    #   push_enabled  — gate. False means the editor's push section is hidden
    #                   on the campaign card and no auto-send ever happens.
    #   push_title    — notification title (admin-editable before sending).
    #   push_body     — notification body (admin-editable before sending).
    #   push_target   — who receives the manual "Send Now" push:
    #                     "eligible_unclaimed" → students who match the
    #                       campaign's audience AND have NOT yet credited.
    #                     "all_subscribers"    → every push subscription.
    push_enabled: bool = False
    push_title: str | None = ""
    push_body: str | None = ""
    push_target: Literal["eligible_unclaimed", "all_subscribers"] = "eligible_unclaimed"


class _LRCPushSendNowIn(BaseModel):
    model_config = ConfigDict(extra="ignore")
    # All three fields are OPTIONAL overrides. When omitted, the values
    # persisted on the campaign (push_title / push_body / push_target)
    # are used. An admin who wants to send a one-off with different copy
    # can supply these without mutating the saved settings.
    title: str | None = None
    body: str | None = None
    target: Literal["eligible_unclaimed", "all_subscribers"] | None = None
    url: str | None = None


# Built-in premium voucher templates (gradient identifiers shared with the
# student VoucherHub / popup reveal). Anything outside this set falls back
# to the first entry so a typo can never produce an unstyled card.
_LRC_VOUCHER_TEMPLATES = (
    "royal_purple_gold",
    "ocean_blue_glass",
    "emerald_learning_pass",
    "black_diamond_premium",
    "warm_ivory_gift_card",
    "festival_celebration",
)


def _lrc_safe_artwork_url(value) -> str:
    """Strict allow-list for admin-supplied voucher artwork URLs.

    Mirrors the client-side `safeArtworkUrl` guard. Allows only https://…
    or app-relative /paths. Rejects http://, javascript:, data:, blob:,
    file:, about:, vbscript:, protocol-relative //host, any control char /
    whitespace / quote / angle bracket / backtick, embedded <svg/<script,
    and anything over 1000 chars. Returns "" on any failure so the caller
    falls back to the built-in template gradient. Rendering is ALWAYS via
    <img src=…> — never dangerouslySetInnerHTML.
    """
    raw = ("" if value is None else str(value)).strip()
    if not raw or len(raw) > 1000:
        return ""
    for ch in raw:
        o = ord(ch)
        if o < 0x20 or ch in " \t\r\n\"'`<>":
            return ""
    low = raw.lower()
    for bad in ("javascript:", "data:", "vbscript:", "file:", "blob:", "about:", "http://"):
        if low.startswith(bad):
            return ""
    if "<svg" in low or "<script" in low:
        return ""
    if raw.startswith("//"):
        return ""
    if not (raw.startswith("https://") or raw.startswith("/")):
        return ""
    return raw


def _lrc_voucher_discount_label(dtype: str, value) -> str:
    """Human label for a voucher discount, e.g. '20% off' / '10 pts off'."""
    try:
        v = float(value)
    except Exception:
        return ""
    vi = int(v) if float(v).is_integer() else v
    if (dtype or "").lower() == "percent":
        return f"{vi}% off"
    return f"{vi} pts off"


def _lrc_validate_voucher_fields(p: "_LRCCampaignIn") -> dict:
    """Validate + normalise the voucher reward sub-config. Raises
    HTTPException(400) on invalid input. Returns a Mongo-ready sub-dict
    of voucher_* fields (always present so reads are uniform)."""
    # Coupon source (v1.0.3). "existing" links an admin-provided coupon that
    # already lives in db.coupons; that coupon's own discount/limits/expiry
    # govern redemption, so the campaign discount fields are NOT required.
    source = (p.voucher_source or "auto").strip().lower()
    if source not in ("auto", "existing"):
        source = "auto"
    existing_code = (p.voucher_existing_code or "").strip().upper()
    if source == "existing" and not existing_code:
        raise HTTPException(status_code=400, detail="Select an existing coupon code, or use auto-create.")

    dtype = (p.voucher_discount_type or "percent").strip().lower()
    if dtype not in ("percent", "fixed"):
        raise HTTPException(status_code=400, detail="voucher_discount_type must be 'percent' or 'fixed'")
    try:
        dval = float(p.voucher_discount_value or 0)
    except Exception:
        raise HTTPException(status_code=400, detail="voucher_discount_value must be a number")
    if source == "auto":
        # Auto-create mints a new coupon, so a valid discount IS required.
        if dval <= 0:
            raise HTTPException(status_code=400, detail="voucher_discount_value must be > 0")
        if dtype == "percent" and dval > 100:
            raise HTTPException(status_code=400, detail="voucher percent discount cannot exceed 100")
    else:
        # Existing coupon owns the real discount; campaign value is advisory.
        if dval < 0:
            dval = 0.0
        if dtype == "percent" and dval > 100:
            dval = 100.0

    max_uses = p.voucher_max_uses
    if max_uses in (None, "", 0):
        max_uses = None
    else:
        try:
            max_uses = int(max_uses)
        except Exception:
            raise HTTPException(status_code=400, detail="voucher_max_uses must be an integer or null")
        if max_uses < 1:
            max_uses = 1

    valid_days = p.voucher_valid_days
    if valid_days in (None, "", 0):
        valid_days = None
    else:
        try:
            valid_days = int(valid_days)
        except Exception:
            raise HTTPException(status_code=400, detail="voucher_valid_days must be an integer or null")
        if valid_days < 1:
            valid_days = None

    expires_override = (p.voucher_expires_at or "").strip() or None
    if expires_override and not _lrc_parse_iso(expires_override):
        raise HTTPException(status_code=400, detail="voucher_expires_at must be an ISO datetime or null")

    book_slugs = _lrc_norm_id_list(p.voucher_book_slugs)

    template = (p.voucher_template or "royal_purple_gold").strip().lower()
    if template not in _LRC_VOUCHER_TEMPLATES:
        template = _LRC_VOUCHER_TEMPLATES[0]

    accent = (p.voucher_accent_color or "#D4A843").strip() or "#D4A843"
    artwork = _lrc_safe_artwork_url(p.voucher_artwork_url)

    title = (p.voucher_title or "Book Voucher").strip()[:80] or "Book Voucher"
    subtitle = (p.voucher_subtitle or "").strip()[:140]
    cta = (p.voucher_cta_label or "Use Voucher").strip()[:40] or "Use Voucher"
    label = (p.voucher_discount_label or "").strip()[:60] or _lrc_voucher_discount_label(dtype, dval)

    return {
        "voucher_discount_type": dtype,
        "voucher_discount_value": dval,
        "voucher_max_uses": max_uses,
        "voucher_valid_days": valid_days,
        "voucher_expires_at": expires_override,
        "voucher_book_slugs": book_slugs,
        "voucher_title": title,
        "voucher_subtitle": subtitle,
        "voucher_discount_label": label,
        "voucher_template": template,
        "voucher_accent_color": accent,
        "voucher_artwork_url": artwork,
        "voucher_cta_label": cta,
        "voucher_source": source,
        "voucher_existing_code": existing_code,
    }


def _lrc_validate_payload(p: _LRCCampaignIn) -> dict:
    """Convert + validate an inbound campaign body into a Mongo-ready dict."""
    name = (p.name or "").strip() or "Untitled campaign"
    if len(name) > 200:
        raise HTTPException(status_code=400, detail="Name too long (max 200 chars)")

    # ── Reward-kind aware validation (v1.0.2) ─────────────────────────────
    # Default "points" preserves the exact legacy contract (1..1000 required).
    # "voucher" is a voucher-only campaign: points are NOT required and are
    # forced to 0 so the treasury/points pipeline is never entered for it.
    # "points_voucher" requires valid points AND a valid voucher config.
    reward_kind = (p.reward_kind or "points").strip().lower()
    if reward_kind not in ("points", "voucher", "points_voucher"):
        reward_kind = "points"

    points = int(p.reward_points or 0)
    if reward_kind == "voucher":
        # Voucher-only: never award points. Clamp silently to 0 instead of
        # rejecting, so an admin who leaves the legacy default 20 in the
        # points box can still save a voucher-only campaign.
        points = 0
    else:
        if points <= 0:
            raise HTTPException(status_code=400, detail="reward_points must be > 0")
        if points > 1000:
            raise HTTPException(status_code=400, detail="reward_points must be <= 1000")

    # Validate the voucher sub-config only when the campaign issues a voucher.
    voucher_fields: dict
    if reward_kind in ("voucher", "points_voucher"):
        voucher_fields = _lrc_validate_voucher_fields(p)
    else:
        # Persist inert defaults so every campaign doc has a uniform shape
        # and an admin can switch a points campaign to a voucher later.
        voucher_fields = {
            "voucher_discount_type": (p.voucher_discount_type or "percent"),
            "voucher_discount_value": float(p.voucher_discount_value or 0),
            "voucher_max_uses": (int(p.voucher_max_uses) if p.voucher_max_uses else None),
            "voucher_valid_days": (int(p.voucher_valid_days) if p.voucher_valid_days else None),
            "voucher_expires_at": ((p.voucher_expires_at or "").strip() or None),
            "voucher_book_slugs": _lrc_norm_id_list(p.voucher_book_slugs),
            "voucher_title": (p.voucher_title or "Book Voucher").strip()[:80] or "Book Voucher",
            "voucher_subtitle": (p.voucher_subtitle or "").strip()[:140],
            "voucher_discount_label": (p.voucher_discount_label or "").strip()[:60],
            "voucher_template": ((p.voucher_template or "royal_purple_gold").strip().lower()
                                 if (p.voucher_template or "royal_purple_gold").strip().lower() in _LRC_VOUCHER_TEMPLATES
                                 else _LRC_VOUCHER_TEMPLATES[0]),
            "voucher_accent_color": (p.voucher_accent_color or "#D4A843").strip() or "#D4A843",
            "voucher_artwork_url": _lrc_safe_artwork_url(p.voucher_artwork_url),
            "voucher_cta_label": (p.voucher_cta_label or "Use Voucher").strip()[:40] or "Use Voucher",
            "voucher_source": ((p.voucher_source or "auto").strip().lower() if (p.voucher_source or "auto").strip().lower() in ("auto", "existing") else "auto"),
            "voucher_existing_code": (p.voucher_existing_code or "").strip().upper(),
        }

    start_dt = _lrc_parse_iso(p.start_at) or _lrc_now()
    end_dt   = _lrc_parse_iso(p.end_at) or (start_dt + timedelta(days=7))
    if end_dt <= start_dt:
        raise HTTPException(
            status_code=400,
            detail="end_at must be strictly after start_at",
        )

    title    = (p.title or "Welcome back!").strip()
    subtitle = (p.subtitle or "").strip()
    cta_text = (p.cta_text or "Claim Reward").strip() or "Claim Reward"
    success_message = (p.success_message or "Your reward has been credited!").strip()
    artwork_url = (p.artwork_url or "").strip()
    accent_color = (p.accent_color or "#D4A843").strip() or "#D4A843"

    aud = (p.audience_type or "all").lower()
    include = _lrc_norm_id_list(p.include_student_ids)
    exclude = _lrc_norm_id_list(p.exclude_student_ids)
    if aud == "specific_students" and not include:
        raise HTTPException(
            status_code=400,
            detail="audience_type=specific_students requires include_student_ids",
        )

    claim_limit = int(p.claim_limit_per_student or 1)
    if claim_limit < 1:
        claim_limit = 1
    if claim_limit > 1:
        # Phase 1 enforces a single claim per student per campaign.
        claim_limit = 1

    # ── Premium animation upgrade v1 — sanitise optional UI fields ──────
    # These fields never influence claim eligibility or crediting; they
    # are pure visual instructions for the React popup. Defensive bounds
    # keep accidentally-huge values from bloating the document.
    animation_enabled = bool(p.animation_enabled) if p.animation_enabled is not None else True
    particle_intensity = (p.particle_intensity or "premium").strip().lower()
    if particle_intensity not in ("subtle", "premium", "celebration"):
        particle_intensity = "premium"
    countdown_enabled = bool(p.countdown_enabled) if p.countdown_enabled is not None else False
    countdown_mode = (p.countdown_mode or "none").strip().lower()
    if countdown_mode not in ("none", "campaign_end", "expires_after_open"):
        countdown_mode = "none"
    # countdown_seconds: only relevant for "expires_after_open". Allow
    # 5..86400 (5 sec to 24 h). Anything outside falls back to None so the
    # popup uses a safe default / hides the timer.
    raw_secs = p.countdown_seconds
    if raw_secs is None or raw_secs == "":
        countdown_seconds = None
    else:
        try:
            countdown_seconds = int(raw_secs)
        except Exception:
            countdown_seconds = None
        if countdown_seconds is not None:
            if countdown_seconds < 5:
                countdown_seconds = None
            elif countdown_seconds > 86400:
                countdown_seconds = 86400
    countdown_label = (p.countdown_label or "").strip()[:80]
    urgency_text = (p.urgency_text or "").strip()[:140]

    # ── Smart Push Notification v1 — sanitise optional admin fields ────
    # These fields persist what the admin wants to send when they click
    # "Send Push Now" in the campaign editor. They never trigger an
    # automatic send and never influence claim/credit logic.
    push_enabled = bool(p.push_enabled) if p.push_enabled is not None else False
    push_title = (p.push_title or "").strip()[:120]
    push_body = (p.push_body or "").strip()[:500]
    push_target = (p.push_target or "eligible_unclaimed").strip().lower()
    if push_target not in ("eligible_unclaimed", "all_subscribers"):
        push_target = "eligible_unclaimed"

    return {
        "name": name,
        "enabled": bool(p.enabled),
        "notes": (p.notes or "").strip(),
        "priority": int(p.priority or 0),
        "start_at": _lrc_iso(start_dt),
        "end_at": _lrc_iso(end_dt),
        "timezone": (p.timezone or "Asia/Phnom_Penh").strip() or "Asia/Phnom_Penh",
        "reward_type": "fixed",
        "reward_kind": reward_kind,
        "reward_points": points,
        "reward_label": (p.reward_label or "").strip(),
        "audience_type": aud,
        "include_student_ids": include,
        "exclude_student_ids": exclude,
        "artwork_url": artwork_url,
        "title": title,
        "subtitle": subtitle,
        "cta_text": cta_text,
        "success_message": success_message,
        "accent_color": accent_color,
        "dismiss_mode": (p.dismiss_mode or "next_login"),
        "claim_limit_per_student": claim_limit,
        # Premium animation v1 — additive UI hints (visual only).
        "animation_enabled": animation_enabled,
        "particle_intensity": particle_intensity,
        "countdown_enabled": countdown_enabled,
        "countdown_mode": countdown_mode,
        "countdown_seconds": countdown_seconds,
        "countdown_label": countdown_label,
        "urgency_text": urgency_text,
        # Reward-kind voucher sub-config v1.0.2 (additive).
        **voucher_fields,
        # Smart Push Notification v1 (additive, all admin-only, never sent
        # to students by the existing /api/rewards/login-campaigns/active
        # public-view stripper).
        "push_enabled": push_enabled,
        "push_title": push_title,
        "push_body": push_body,
        "push_target": push_target,
    }


def _lrc_public_view(camp: dict) -> dict:
    """Strip internal fields before returning to students."""
    out = _lrc_serialize(camp)

    # Reward-kind v1.0.2 — expose the kind and a DISPLAY-ONLY voucher preview
    # so the pre-claim popup can render a "+ Book Voucher" teaser without the
    # actual coupon code (which only exists after a successful claim). The
    # raw voucher config (max_uses, exact book slugs list, valid_days) stays
    # server-side.
    reward_kind = (out.get("reward_kind") or "points").strip().lower()
    out["reward_kind"] = reward_kind
    if reward_kind in ("voucher", "points_voucher"):
        slugs = list(out.get("voucher_book_slugs") or [])
        out["voucher_preview"] = {
            "title": out.get("voucher_title") or "Book Voucher",
            "subtitle": out.get("voucher_subtitle") or "",
            "discount_label": out.get("voucher_discount_label")
                or _lrc_voucher_discount_label(out.get("voucher_discount_type"), out.get("voucher_discount_value")),
            "template": out.get("voucher_template") or "royal_purple_gold",
            "accent_color": out.get("voucher_accent_color") or "#D4A843",
            "artwork_url": _lrc_safe_artwork_url(out.get("voucher_artwork_url")),
            "cta_label": out.get("voucher_cta_label") or "Use Voucher",
            "applies_to_all_books": not bool(slugs),
            "eligible_book_count": len(slugs),
        }

    for k in (
        "include_student_ids", "exclude_student_ids", "notes",
        "created_by", "audience_type", "priority", "claim_limit_per_student",
        # raw voucher config — not for the client
        "voucher_discount_type", "voucher_discount_value", "voucher_max_uses",
        "voucher_valid_days", "voucher_expires_at", "voucher_book_slugs",
        "voucher_title", "voucher_subtitle", "voucher_discount_label",
        "voucher_template", "voucher_accent_color", "voucher_artwork_url",
        "voucher_cta_label", "voucher_source", "voucher_existing_code",
        # Smart Push Notification v1 — admin-only fields, never leaked to students.
        "push_enabled", "push_title", "push_body", "push_target",
    ):
        out.pop(k, None)
    # v1.2 — surface the student's per-campaign claim state in stable,
    # public-friendly field names so the popup can show "pending" / "failed"
    # hints without making a second API call.
    cs = out.pop("_claim_status", None)
    cr = out.pop("_claim_retry_count", None)
    if cs:
        out["claim_status"] = cs
        if cs in ("pending", "stale_pending"):
            out["retry_after_seconds"] = 3
        if cr is not None:
            out["claim_retry_count"] = int(cr)
    return out


def _lrc_voucher_status(row: dict, coupon: dict | None) -> str:
    """Live status, reading the EXISTING coupon's `uses_count` (NOT `uses`)."""
    if (row.get("status") or "") == "used" or row.get("used_at"):
        return "used"
    if not coupon or not coupon.get("enabled", True):
        return "unavailable"
    exp = _lrc_parse_iso(coupon.get("expires_at"))
    if exp and _lrc_now() > exp:
        return "expired"
    mu = coupon.get("max_uses")
    if mu is not None and int(coupon.get("uses_count") or 0) >= int(mu):
        # A single-use personal voucher that has been redeemed reads as
        # "used" (not "sold out"), even if the redemptions-id backfill missed.
        return "used" if int(mu) == 1 else "exhausted"
    return "active"


@dataclass(frozen=True)
class LoginRewardHooks:
    """db-bound functions/objects from login_reward_tools.py that the reward
    chain siblings (voucher_reward_tools.py, mystery_box_tools.py,
    login_mystery_box_tools.py) consume. The PURE helpers above (_lrc_now,
    _lrc_iso, _lrc_parse_iso, _lrc_safe_artwork_url, _lrc_voucher_discount_label)
    do NOT need this — those siblings import them directly from this module.
    """
    credit_via_treasury: object
    issue_voucher_for_claim: object
    compose_voucher_payload: object
    gen_coupon_code: object
    student_vouchers: object
    ensure_indexes: object


def register_login_reward_routes(
    api, db, require_student, require_admin, Student, User,
    fan_out_push, gas_points_login_url, sl_treasury_id, sl_treasury_password,
    build_target_query, generate_coupon_code,
) -> LoginRewardHooks:
    """Register the Login Reward Campaign routes onto ``api``.

    Explicit-DI replacement for the previous ``exec()``-into-server-namespace
    loading. Behaviour is identical: same routes, same claim state machine,
    same idempotency/duplicate-credit guards, same voucher issuance rules.
    Returns a ``LoginRewardHooks`` namespace for the reward-chain siblings.
    """
    _lrc_campaigns = db["login_reward_campaigns"]
    _lrc_claims    = db["login_reward_claims"]
    # Reward-kind v1.0.2 — single source of truth for issued vouchers (NEVER
    # localStorage). One row per (campaign_id, student_id_norm). The coupon
    # itself lives in the existing db.coupons collection.
    _lrc_student_vouchers = db["student_vouchers"]

    # ── indexes (idempotent, best-effort, called from server.py's startup) ──
    async def _lrc_ensure_indexes() -> None:
        try:
            await _lrc_campaigns.create_index("id", unique=True, sparse=True)
            await _lrc_campaigns.create_index("enabled")
            await _lrc_campaigns.create_index([("start_at", 1), ("end_at", 1)])
            # The critical single-claim guard.
            await _lrc_claims.create_index(
                [("campaign_id", 1), ("student_id_norm", 1)],
                unique=True,
                name="uniq_campaign_student",
            )
            await _lrc_claims.create_index("student_id_norm")
            await _lrc_claims.create_index("campaign_id")
            # Reward-kind v1.0.2 — one voucher per student per campaign (the
            # crucial double-issue guard). Plus lookup indexes for the hub.
            await _lrc_student_vouchers.create_index(
                [("campaign_id", 1), ("student_id_norm", 1)],
                unique=True,
                name="uniq_voucher_campaign_student",
            )
            await _lrc_student_vouchers.create_index("student_id_norm")
            await _lrc_student_vouchers.create_index("coupon_code")
            _LRC_LOG.info("login_reward_tools: indexes ensured")
        except Exception as _e:
            _LRC_LOG.warning("login_reward_tools: startup index ensure failed: %s", _e)

    # ── admin routes ────────────────────────────────────────────────────────
    @api.get("/admin/rewards/login-campaigns")
    async def lrc_admin_list(admin: User = Depends(require_admin)):
        cur = _lrc_campaigns.find({}, {"_id": 0}).sort([("priority", -1), ("created_at", -1)])
        out = []
        async for doc in cur:
            out.append(_lrc_serialize(doc))
        return {"campaigns": out, "count": len(out)}

    @api.post("/admin/rewards/login-campaigns")
    async def lrc_admin_create(
        payload: _LRCCampaignIn,
        admin: User = Depends(require_admin),
    ):
        data = _lrc_validate_payload(payload)
        now_iso = _lrc_iso(_lrc_now())
        cid = "lrc_" + _lrc_secrets.token_hex(6)
        doc = {
            "id": cid,
            "campaign_id": cid,
            **data,
            "created_at": now_iso,
            "updated_at": now_iso,
            "created_by": getattr(admin, "email", "") or "",
        }
        await _lrc_campaigns.insert_one(doc)
        _LRC_LOG.info("login_reward: created %s by %s enabled=%s", cid, doc["created_by"], doc["enabled"])
        return {"success": True, "campaign": _lrc_serialize(doc)}

    @api.get("/admin/rewards/login-campaigns/{campaign_id}")
    async def lrc_admin_get(
        campaign_id: str,
        admin: User = Depends(require_admin),
    ):
        doc = await _lrc_campaigns.find_one({"id": campaign_id}, {"_id": 0})
        if not doc:
            raise HTTPException(status_code=404, detail="Campaign not found")
        return {"campaign": _lrc_serialize(doc)}

    @api.put("/admin/rewards/login-campaigns/{campaign_id}")
    async def lrc_admin_update(
        campaign_id: str,
        payload: _LRCCampaignIn,
        admin: User = Depends(require_admin),
    ):
        existing = await _lrc_campaigns.find_one({"id": campaign_id}, {"_id": 0})
        if not existing:
            raise HTTPException(status_code=404, detail="Campaign not found")
        data = _lrc_validate_payload(payload)
        data["updated_at"] = _lrc_iso(_lrc_now())
        await _lrc_campaigns.update_one({"id": campaign_id}, {"$set": data})
        doc = await _lrc_campaigns.find_one({"id": campaign_id}, {"_id": 0})
        _LRC_LOG.info(
            "login_reward: updated %s by %s enabled=%s",
            campaign_id, getattr(admin, "email", ""), data.get("enabled"),
        )
        return {"success": True, "campaign": _lrc_serialize(doc)}

    @api.delete("/admin/rewards/login-campaigns/{campaign_id}")
    async def lrc_admin_delete(
        campaign_id: str,
        admin: User = Depends(require_admin),
    ):
        res = await _lrc_campaigns.delete_one({"id": campaign_id})
        if res.deleted_count == 0:
            raise HTTPException(status_code=404, detail="Campaign not found")
        _LRC_LOG.info("login_reward: deleted %s by %s", campaign_id, getattr(admin, "email", ""))
        return {"success": True, "deleted": campaign_id}

    @api.get("/admin/rewards/login-campaigns/{campaign_id}/claims")
    async def lrc_admin_claims(
        campaign_id: str,
        admin: User = Depends(require_admin),
    ):
        cur = _lrc_claims.find({"campaign_id": campaign_id}, {"_id": 0}).sort("claimed_at", -1).limit(500)
        out = [doc async for doc in cur]
        return {"campaign_id": campaign_id, "count": len(out), "claims": out}

    # ── Smart Push Notification v1 — admin-triggered manual "Send Now" ─────
    # Reuses the EXISTING push infrastructure (push_subscriptions,
    # fan_out_push, push_history). No automatic / scheduled / background
    # send — admin must press the button.
    # Deferred (see KNOWN_LIMITATIONS.md):
    #   * auto-send on campaign create/update
    #   * scheduled send when campaign becomes live
    #   * background per-eligibility-window push job
    @api.post("/admin/rewards/login-campaigns/{campaign_id}/push/send-now")
    async def lrc_admin_push_send_now(
        campaign_id: str,
        payload: _LRCPushSendNowIn,
        admin: User = Depends(require_admin),
    ):
        """Send a push notification for THIS campaign right now (admin action).

        Targets either every push subscriber (`all_subscribers`) or only the
        students who match the campaign's audience AND have NOT yet credited
        a claim for this campaign (`eligible_unclaimed`).

        Idempotency: there is no DB-level lock on sending the same campaign
        twice (push is a notification, not a credit). The frontend Studio
        SHOULD show a confirmation modal before calling this endpoint to
        avoid accidental duplicate spam. Each call writes a row to
        `push_history` so duplicates are auditable.

        This endpoint NEVER credits points, vouchers, or EduTalk passes.
        Claim/credit logic is untouched.
        """
        doc = await _lrc_campaigns.find_one({"id": campaign_id}, {"_id": 0})
        if not doc:
            raise HTTPException(status_code=404, detail="Campaign not found")

        if not callable(fan_out_push):
            raise HTTPException(
                status_code=500,
                detail="_fan_out_push helper not loaded (push infrastructure unavailable)",
            )

        title = (payload.title if payload.title is not None else (doc.get("push_title") or "")).strip()
        body  = (payload.body  if payload.body  is not None else (doc.get("push_body")  or "")).strip()
        target = (payload.target or doc.get("push_target") or "eligible_unclaimed").strip().lower()
        if target not in ("eligible_unclaimed", "all_subscribers"):
            target = "eligible_unclaimed"
        url = (payload.url or "/").strip() or "/"

        if not title or not body:
            raise HTTPException(
                status_code=400,
                detail="Push title and body must both be non-empty (set them in the campaign editor or in the request body).",
            )

        # Build the push_subscriptions query.
        if target == "all_subscribers":
            subs_query: dict = {}
        else:
            # eligible_unclaimed = (audience matches) AND (no credited claim row).
            # We resolve this by enumerating push_subscriptions and intersecting
            # in-memory because eligibility is computed by _lrc_eligible (which
            # honours include/exclude lists). The subscriber set is small enough
            # in production for this to be fine; if it ever grows we can swap
            # to a precomputed audience cache.
            credited_cur = _lrc_claims.find(
                {"campaign_id": campaign_id, "status": "credited"},
                {"_id": 0, "student_id_norm": 1},
            )
            credited_norm = {
                (c.get("student_id_norm") or "").strip()
                async for c in credited_cur
            }
            sub_ids: list[str] = []
            seen_norm: set[str] = set()
            sub_cur = db.push_subscriptions.find({}, {"_id": 0, "studentId": 1})
            async for sub in sub_cur:
                sid_raw = (sub.get("studentId") or "").strip()
                if not sid_raw:
                    continue
                sid_norm = _norm_student_id(sid_raw)
                if not sid_norm or sid_norm in seen_norm:
                    continue
                seen_norm.add(sid_norm)
                if sid_norm in credited_norm:
                    continue
                if not _lrc_eligible(doc, sid_norm):
                    continue
                sub_ids.append(sid_raw)
            if not sub_ids:
                return {
                    "sent": 0, "failed": 0, "target": target,
                    "matched_subscribers": 0,
                    "reason": "no_eligible_unclaimed_subscribers",
                }
            # Reuse the existing _build_target_query("students", ...) shape.
            if callable(build_target_query):
                subs_query = build_target_query("students", sub_ids, None)
            else:
                subs_query = {"studentId": {"$in": sub_ids}}

        try:
            sent, failed = await fan_out_push(subs_query, title, body, url)
        except Exception as exc:
            raise HTTPException(status_code=500, detail=f"push fan-out failed: {exc}")

        # Audit row in the EXISTING push_history collection (admin-triggered).
        try:
            await db.push_history.insert_one({
                "title": title,
                "body": body,
                "url": url,
                "target": "students" if target == "eligible_unclaimed" else "everyone",
                "studentIds": [],
                "group": "",
                "sentBy": getattr(admin, "email", "") or "",
                "sentAt": _lrc_now(),
                "sent": sent,
                "failed": failed,
                "source": "login_reward_campaign",
                "campaign_id": campaign_id,
                "campaign_name": doc.get("name") or "",
                "push_target_mode": target,
            })
        except Exception as exc:
            _LRC_LOG.warning("login_reward: push_history insert failed: %s", exc)

        _LRC_LOG.info(
            "login_reward: push send-now campaign=%s target=%s sent=%s failed=%s by=%s",
            campaign_id, target, sent, failed, getattr(admin, "email", ""),
        )
        return {"sent": sent, "failed": failed, "target": target}

    # ── student-facing helpers ──────────────────────────────────────────────
    async def _lrc_pick_active_for_student(student_norm_id: str) -> dict | None:
        """Return the highest-priority enabled+live campaign that the given
        student is eligible for AND has not yet claimed. None if nothing fits."""
        now = _lrc_now()
        cur = _lrc_campaigns.find(
            {"enabled": True},
            {"_id": 0},
        ).sort([("priority", -1), ("created_at", -1)])

        candidates: list[dict] = []
        async for doc in cur:
            start = _lrc_parse_iso(doc.get("start_at"))
            end = _lrc_parse_iso(doc.get("end_at"))
            if start and now < start:
                continue
            if end and now > end:
                continue
            if not _lrc_eligible(doc, student_norm_id):
                continue
            candidates.append(doc)

        if not candidates:
            return None

        # v1.2 — hide a campaign ONLY if a TRULY credited claim row exists for
        # this student. pending / failed / stale-pending rows must NOT hide the
        # campaign, so the student can still see the popup and finish/retry
        # after a refresh, crash recovery, or GAS outage.
        cids = [c["id"] for c in candidates if c.get("id")]
        credited_set: set[str] = set()
        claim_state_by_cid: dict[str, dict] = {}
        if cids:
            claim_cur = _lrc_claims.find(
                {"campaign_id": {"$in": cids}, "student_id_norm": student_norm_id},
                {"_id": 0, "campaign_id": 1, "status": 1, "claimed_at": 1, "failed_at": 1, "error": 1, "retry_count": 1},
            )
            async for cl in claim_cur:
                st = (cl.get("status") or "").lower()
                cid = cl.get("campaign_id")
                if not cid:
                    continue
                if st == "credited":
                    credited_set.add(cid)
                # Track the latest non-credited claim per campaign for metadata.
                claim_state_by_cid[cid] = cl

        for c in candidates:
            cid = c.get("id")
            if cid in credited_set:
                continue
            # Annotate the campaign with the student's current claim state so the
            # student endpoint can surface "pending"/"failed" UI hints without
            # leaking internal fields. The annotation is intentionally minimal.
            cl = claim_state_by_cid.get(cid)
            if cl:
                st = (cl.get("status") or "").lower()
                if st in ("pending", "failed"):
                    # Decide whether the pending row is stale enough to be safely retried.
                    claimed_at = _lrc_parse_iso(cl.get("claimed_at"))
                    stale_threshold = now - timedelta(seconds=_LRC_STALE_PENDING_SECONDS)
                    claim_status = st
                    if st == "pending" and claimed_at and claimed_at < stale_threshold:
                        claim_status = "stale_pending"
                    c = {**c, "_claim_status": claim_status, "_claim_retry_count": int(cl.get("retry_count") or 0)}
            return c
        return None

    @api.get("/rewards/login-campaigns/active")
    async def lrc_student_active(student: Student = Depends(require_student)):
        sid_norm = _norm_student_id(getattr(student, "clean_id", "") or getattr(student, "student_id", ""))
        if not sid_norm:
            return {"campaign": None, "reason": "no_student_id"}
        camp = await _lrc_pick_active_for_student(sid_norm)
        if not camp:
            return {"campaign": None}
        return {"campaign": _lrc_public_view(camp)}

    # ── claim flow ───────────────────────────────────────────────────────────
    async def _lrc_credit_via_treasury(*, student_clean_id: str, points: int,
                                       campaign_id: str, campaign_name: str) -> dict:
        """Reuse the EXACT same GAS-treasury-sendPoints path used by
        /api/points/grant. Returns {ok: bool, error?: str}.

        We do NOT touch the wallet migration flags. Source of truth for
        students remains GAS, exactly as production today.
        """
        if not sl_treasury_password:
            return {"ok": False, "error": "SL_TREASURY_PASSWORD not configured"}
        if not gas_points_login_url:
            return {"ok": False, "error": "GAS_POINTS_LOGIN_URL not configured"}

        nonce = _lrc_secrets.token_hex(12)
        gas_payload = {
            "action":     "sendPoints",
            "id":         sl_treasury_id,
            "password":   sl_treasury_password,
            "receiverId": student_clean_id,
            "amount":     str(int(points)),
            "nonce":      nonce,
        }
        try:
            async with httpx.AsyncClient(
                timeout=httpx.Timeout(12.0, connect=6.0),
                follow_redirects=True,
            ) as cli:
                r = await cli.post(gas_points_login_url, data=gas_payload)
            if r.status_code != 200:
                return {"ok": False, "error": f"GAS HTTP {r.status_code}"}
            try:
                j = r.json()
            except Exception:
                return {"ok": False, "error": "GAS returned non-JSON"}
            if isinstance(j, dict) and j.get("success") is True:
                return {"ok": True, "gas": j}
            return {
                "ok": False,
                "error": str((j or {}).get("message") or (j or {}).get("error") or j)[:200],
            }
        except Exception as exc:
            return {"ok": False, "error": str(exc)[:200]}

    # ── voucher issuance (reward-kind v1.0.2) ───────────────────────────────
    # A voucher is materialised as a REAL coupon in the existing db.coupons
    # collection (exact existing schema) plus a row in student_vouchers (the
    # single source of truth for ownership — never localStorage). Redemption
    # happens through the EXISTING /api/coupons/validate + /api/coupons/redeem
    # flow, which is left completely untouched.
    def _lrc_gen_coupon_code(length: int = 8) -> str:
        if callable(generate_coupon_code):
            return generate_coupon_code(length)
        import string as _s
        return "".join(_lrc_secrets.choice(_s.ascii_uppercase + _s.digits) for _ in range(length))

    async def _lrc_compose_voucher_payload(row: dict) -> dict:
        """Build a student-facing voucher object from a student_vouchers row,
        reading live discount/expiry/status from the linked coupon."""
        coupon = None
        code = (row.get("coupon_code") or "")
        if code:
            try:
                coupon = await db.coupons.find_one({"code": code}, {"_id": 0})
            except Exception:
                coupon = None
        coupon = coupon or {}
        slugs = list(coupon.get("book_slugs") or row.get("eligible_books") or [])
        dtype = coupon.get("type") or row.get("discount_type") or "percent"
        dval = coupon.get("value") if coupon.get("value") is not None else row.get("discount_value")
        return {
            "voucher_id": row.get("id") or "",
            "campaign_id": row.get("campaign_id"),
            "campaign_name": row.get("campaign_name") or "",
            "coupon_code": code,
            "reward_kind": row.get("reward_kind") or "voucher",
            "title": row.get("title") or "Book Voucher",
            "subtitle": row.get("subtitle") or "",
            "discount_label": row.get("discount_label") or _lrc_voucher_discount_label(dtype, dval),
            "discount_type": dtype,
            "discount_value": dval,
            "expires_at": coupon.get("expires_at") or row.get("expires_at"),
            "valid_from": coupon.get("valid_from") or row.get("valid_from"),
            "status": _lrc_voucher_status(row, coupon if coupon else None),
            "eligible_books": slugs,
            "book_slugs": slugs,
            "applies_to_all_books": not bool(slugs),
            "template_style": row.get("template") or "royal_purple_gold",
            "artwork_url": _lrc_safe_artwork_url(row.get("artwork_url")),
            "artwork_mode": ("custom_url" if _lrc_safe_artwork_url(row.get("artwork_url")) else "template"),
            "accent_color": row.get("accent_color") or "#D4A843",
            "cta_label": row.get("cta_label") or "Use Voucher",
            "claimed_at": row.get("claimed_at"),
            "used_at": row.get("used_at"),
            "redeemed_book_slug": row.get("redeemed_book_slug"),
        }

    async def _lrc_issue_voucher_for_claim(camp: dict, sid_clean: str, sid_norm: str) -> dict | None:
        """Idempotently issue (or return) the Book Voucher for a claimed campaign.

        Safe to call multiple times: one coupon + one student_vouchers row per
        (campaign, student). Returns the composed voucher payload, or None if
        the campaign has no voucher discount configured (defensive)."""
        campaign_id = camp.get("id") or camp.get("campaign_id")
        if not campaign_id:
            return None

        # Already issued? Return it (idempotent).
        existing = await _lrc_student_vouchers.find_one(
            {"campaign_id": campaign_id, "student_id_norm": sid_norm}, {"_id": 0}
        )
        if existing:
            return await _lrc_compose_voucher_payload(existing)

        now = _lrc_now()
        now_iso = _lrc_iso(now)
        source = (camp.get("voucher_source") or "auto").strip().lower()

        # ── "existing" source (v1.0.3): link an admin-provided coupon that ──────
        # already exists in db.coupons. We do NOT mint a new coupon and we do NOT
        # modify the existing one — its own discount / max_uses / expiry / assigned_to
        # govern redemption. We only record a student_vouchers row that points at it,
        # so the same code is shared across recipients (first-come within the
        # coupon's own usage limits). The blocking redeem in the Library guarantees
        # an exhausted/disabled coupon cannot grant a discounted unlock.
        if source == "existing":
            code = (camp.get("voucher_existing_code") or "").strip().upper()
            if not code:
                _LRC_LOG.warning("login_reward: existing-coupon source but no code campaign=%s", campaign_id)
                return None
            coupon = None
            try:
                coupon = await db.coupons.find_one({"code": code}, {"_id": 0})
            except Exception:
                coupon = None
            if not coupon:
                _LRC_LOG.warning("login_reward: existing coupon %s not found campaign=%s", code, campaign_id)
                return None
            c_slugs = list(coupon.get("book_slugs") or [])
            c_label = (camp.get("voucher_discount_label") or "").strip() or _lrc_voucher_discount_label(
                coupon.get("type"), coupon.get("value")
            )
            row = {
                "id": "sv_" + _lrc_secrets.token_hex(8),
                "campaign_id": campaign_id,
                "campaign_name": camp.get("name") or "",
                "student_id": sid_clean,
                "student_id_norm": sid_norm,
                "coupon_code": code,
                "reward_kind": (camp.get("reward_kind") or "voucher"),
                "title": camp.get("voucher_title") or "Book Voucher",
                "subtitle": camp.get("voucher_subtitle") or "",
                "discount_label": c_label,
                "discount_type": coupon.get("type") or "percent",
                "discount_value": coupon.get("value"),
                "template": camp.get("voucher_template") or "royal_purple_gold",
                "accent_color": camp.get("voucher_accent_color") or "#D4A843",
                "artwork_url": _lrc_safe_artwork_url(camp.get("voucher_artwork_url")),
                "cta_label": camp.get("voucher_cta_label") or "Use Voucher",
                "eligible_books": c_slugs,
                "applies_to_all_books": not bool(c_slugs),
                "expires_at": coupon.get("expires_at"),
                "valid_from": coupon.get("valid_from") or now_iso,
                "claimed_at": now_iso,
                "used_at": None,
                "redeemed_book_slug": None,
                "status": "active",
                "source": "login_reward_voucher_existing",
            }
            try:
                await _lrc_student_vouchers.insert_one(row)
            except Exception:
                winner = await _lrc_student_vouchers.find_one(
                    {"campaign_id": campaign_id, "student_id_norm": sid_norm}, {"_id": 0}
                )
                if winner:
                    return await _lrc_compose_voucher_payload(winner)
                return None
            _LRC_LOG.info("login_reward: linked existing coupon %s to %s campaign=%s", code, sid_clean, campaign_id)
            return await _lrc_compose_voucher_payload(row)

        # ── "auto" source (default): mint a fresh unique single-use coupon. ─────
        dtype = (camp.get("voucher_discount_type") or "percent").strip().lower()
        try:
            dval = float(camp.get("voucher_discount_value") or 0)
        except Exception:
            dval = 0.0
        if dval <= 0:
            _LRC_LOG.warning("login_reward: voucher discount not configured for campaign=%s", campaign_id)
            return None

        # Generate a unique coupon code using the EXISTING generator.
        code = _lrc_gen_coupon_code(8)
        for _ in range(6):
            if not await db.coupons.find_one({"code": code}, {"_id": 0}):
                break
            code = _lrc_gen_coupon_code(8)
        else:
            _LRC_LOG.error("login_reward: could not generate unique coupon code campaign=%s", campaign_id)
            return None

        now = _lrc_now()
        now_iso = _lrc_iso(now)

        # Expiry precedence: explicit override → valid_days → campaign end_at → none.
        exp_iso = None
        if camp.get("voucher_expires_at"):
            d = _lrc_parse_iso(camp.get("voucher_expires_at"))
            exp_iso = _lrc_iso(d) if d else None
        elif camp.get("voucher_valid_days"):
            try:
                exp_iso = _lrc_iso(now + timedelta(days=int(camp.get("voucher_valid_days"))))
            except Exception:
                exp_iso = None
        else:
            d = _lrc_parse_iso(camp.get("end_at"))
            exp_iso = _lrc_iso(d) if d else None

        book_slugs = list(camp.get("voucher_book_slugs") or [])
        raw_max = camp.get("voucher_max_uses")
        try:
            max_uses = int(raw_max) if raw_max not in (None, "", 0) else 1
        except Exception:
            max_uses = 1
        if max_uses < 1:
            max_uses = 1

        # Coupon document — EXACT existing coupon schema (uses_count / redemptions
        # / max_uses / type / value / assigned_to / book_slugs / valid_from /
        # expires_at / enabled). assigned_to is intentionally [] (public): the
        # code is single-use and only revealed to its owner, which avoids any
        # redeem-time identity mismatch locking the owner out of their own reward.
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
            "created_by": "login_reward",
            "created_at": now_iso,
            "redemptions": [],
            # additive provenance fields (ignored by the existing coupon flow)
            "source": "login_reward_voucher",
            "campaign_id": campaign_id,
        }
        try:
            await db.coupons.insert_one(coupon_doc)
        except Exception as _ce:
            _LRC_LOG.warning("login_reward: coupon insert failed campaign=%s err=%s", campaign_id, _ce)
            return None

        label = (camp.get("voucher_discount_label") or "").strip() or _lrc_voucher_discount_label(dtype, dval)
        row = {
            "id": "sv_" + _lrc_secrets.token_hex(8),
            "campaign_id": campaign_id,
            "campaign_name": camp.get("name") or "",
            "student_id": sid_clean,
            "student_id_norm": sid_norm,
            "coupon_code": code,
            "reward_kind": (camp.get("reward_kind") or "voucher"),
            "title": camp.get("voucher_title") or "Book Voucher",
            "subtitle": camp.get("voucher_subtitle") or "",
            "discount_label": label,
            "discount_type": dtype,
            "discount_value": dval,
            "template": camp.get("voucher_template") or "royal_purple_gold",
            "accent_color": camp.get("voucher_accent_color") or "#D4A843",
            "artwork_url": _lrc_safe_artwork_url(camp.get("voucher_artwork_url")),
            "cta_label": camp.get("voucher_cta_label") or "Use Voucher",
            "eligible_books": book_slugs,
            "applies_to_all_books": not bool(book_slugs),
            "expires_at": exp_iso,
            "valid_from": now_iso,
            "claimed_at": now_iso,
            "used_at": None,
            "redeemed_book_slug": None,
            "status": "active",
            "source": "login_reward_voucher",
        }
        try:
            await _lrc_student_vouchers.insert_one(row)
        except Exception:
            # Lost the unique-index race with a concurrent claim. The winner's row
            # is authoritative; our just-created coupon becomes a harmless orphan
            # (single-use, never revealed). Return the existing voucher.
            winner = await _lrc_student_vouchers.find_one(
                {"campaign_id": campaign_id, "student_id_norm": sid_norm}, {"_id": 0}
            )
            if winner:
                return await _lrc_compose_voucher_payload(winner)
            return None

        _LRC_LOG.info("login_reward: issued voucher %s to %s campaign=%s", code, sid_clean, campaign_id)
        return await _lrc_compose_voucher_payload(row)

    # ── celebration push (best-effort, never blocks the claim) ──────────────
    async def _lrc_send_celebration_push(*, student_clean_id: str, student_raw_id: str,
                                         points: int, campaign_name: str) -> None:
        """Fire a celebratory OS push to the student's registered devices.

        Best-effort only: any failure is swallowed so a missing VAPID config or
        a network blip never breaks the claim response. Reuses the EXISTING
        `_fan_out_push` helper (the same one /api/points/grant uses for credit
        push), so this adds no new push infrastructure.
        """
        try:
            push_candidates: list[str] = []
            for _c in (
                student_clean_id,
                _norm_student_id(student_clean_id),
                student_raw_id,
                _norm_student_id(student_raw_id),
            ):
                if _c and _c not in push_candidates:
                    push_candidates.append(_c)
            if not push_candidates:
                return
            await fan_out_push(
                {"studentId": {"$in": push_candidates}},
                title=f"🎉 +{points} ពិន្ទុបានបន្ថែម! / Reward Claimed!",
                body=(
                    f"អ្នកទទួលបាន +{points} ពិន្ទុ ✨\n"
                    f"+{points} pts · {campaign_name or 'Login reward'}"
                ),
                url="/portal",
            )
        except Exception as _err:
            _LRC_LOG.warning("login_reward: celebration push error: %s", _err)

    @api.post("/rewards/login-campaigns/{campaign_id}/claim")
    async def lrc_student_claim(
        campaign_id: str,
        student: Student = Depends(require_student),
    ):
        """Claim a login-reward campaign with strong duplicate-safety semantics.

        State machine on `login_reward_claims` (one doc per campaign_id+student):
            (none)    → insert {status:"pending"} (this caller owns the credit attempt)
            pending   → another caller is mid-flight; return HTTP 202 "still processing"
                        UNLESS the row is older than _LRC_STALE_PENDING_SECONDS,
                        in which case this caller atomically takes ownership.
            failed    → previous credit attempt failed; this caller atomically
                        re-acquires the row (status flip + new attempt_id) and
                        retries the credit. No duplicate row, no duplicate credit.
            credited  → return HTTP 200 with already_claimed=true.

        The unique compound index (campaign_id + student_id_norm) keeps every
        state transition single-rowed. Duplicate-concurrent callers that try
        to take a fresh pending row will lose the find_one_and_update race and
        get the 202 path.
        """
        sid_clean = (getattr(student, "clean_id", "") or "").strip() or getattr(student, "student_id", "")
        sid_norm = _norm_student_id(sid_clean)
        if not sid_norm:
            raise HTTPException(status_code=400, detail="No student identity")

        camp = await _lrc_campaigns.find_one({"id": campaign_id}, {"_id": 0})
        if not camp:
            raise HTTPException(status_code=404, detail="Campaign not found")

        if not camp.get("enabled"):
            raise HTTPException(status_code=400, detail="Campaign is disabled")

        now = _lrc_now()
        start = _lrc_parse_iso(camp.get("start_at"))
        end = _lrc_parse_iso(camp.get("end_at"))
        if start and now < start:
            raise HTTPException(status_code=400, detail="Campaign has not started yet")
        if end and now > end:
            raise HTTPException(status_code=400, detail="Campaign has ended")

        if not _lrc_eligible(camp, sid_norm):
            raise HTTPException(status_code=403, detail="Not eligible for this campaign")

        # ── Reward-kind branch (v1.0.2) ───────────────────────────────────────
        # Voucher-ONLY campaigns never enter the points/treasury pipeline below.
        # We write a single idempotent "credited" claim row (so the campaign is
        # correctly hidden after claim by _lrc_pick_active_for_student) and issue
        # the Book Voucher. reward_points is irrelevant here. The existing
        # points-only and points+voucher paths fall through unchanged.
        reward_kind = (camp.get("reward_kind") or "points").strip().lower()
        if reward_kind == "voucher":
            v_now_iso = _lrc_iso(_lrc_now())
            v_claim_doc = {
                "campaign_id": campaign_id,
                "student_id": sid_clean,
                "student_id_norm": sid_norm,
                "points_awarded": 0,
                "claimed_at": v_now_iso,
                "credited_at": v_now_iso,
                "status": "credited",
                "attempt_id": _lrc_secrets.token_hex(12),
                "retry_count": 0,
                "source": "login_reward_voucher_only",
                "campaign_name": camp.get("name") or "",
                "reward_kind": "voucher",
            }
            try:
                await _lrc_claims.insert_one(v_claim_doc)
            except Exception:
                # Duplicate-key → the student already claimed; idempotent re-issue.
                pass
            voucher = None
            try:
                voucher = await _lrc_issue_voucher_for_claim(camp, sid_clean, sid_norm)
            except Exception as _ve:
                _LRC_LOG.warning("login_reward: voucher-only issue failed campaign=%s err=%s", campaign_id, _ve)
            return {
                "success": True,
                "duplicate": False,
                "status": "credited",
                "reward_kind": "voucher",
                "points_awarded": 0,
                "campaign_id": campaign_id,
                "claimed_at": v_now_iso,
                "success_message": camp.get("success_message") or "Your voucher is ready!",
                "voucher": voucher,
            }

        points = int(camp.get("reward_points") or 0)
        if points <= 0:
            raise HTTPException(status_code=400, detail="Reward not configured")

        # ── duplicate-safe ownership acquisition ──────────────────────────────
        # An attempt_id binds THIS handler invocation to its row. Only the caller
        # that wrote attempt_id is allowed to flip the row to "credited"/"failed".
        attempt_id = _lrc_secrets.token_hex(12)
        now_iso = _lrc_iso(now)
        stale_threshold_iso = _lrc_iso(now - timedelta(seconds=_LRC_STALE_PENDING_SECONDS))

        # Step 1 — try to acquire (or re-acquire) the row atomically.
        # Match either:
        #   (a) status == "failed"  — previous attempt failed, safe to retry
        #   (b) status == "pending" AND claimed_at < stale_threshold — orphaned in-flight
        acquired = await _lrc_claims.find_one_and_update(
            {
                "campaign_id": campaign_id,
                "student_id_norm": sid_norm,
                "$or": [
                    {"status": "failed"},
                    {"status": "pending", "claimed_at": {"$lt": stale_threshold_iso}},
                ],
            },
            {
                "$set": {
                    "status": "pending",
                    "attempt_id": attempt_id,
                    "claimed_at": now_iso,
                    "points_awarded": points,
                    "campaign_name": camp.get("name") or "",
                    "treasury_wallet_id": _norm_student_id(sl_treasury_id),
                    "source": "login_reward_campaign",
                },
                "$inc": {"retry_count": 1},
                "$unset": {"failed_at": "", "error": ""},
            },
            return_document=True,  # return the updated doc
        )

        if acquired is None:
            # Step 2 — no failed/stale row to take over. Try a fresh insert.
            claim_doc = {
                "campaign_id": campaign_id,
                "student_id": sid_clean,
                "student_id_norm": sid_norm,
                "points_awarded": points,
                "claimed_at": now_iso,
                "status": "pending",
                "attempt_id": attempt_id,
                "retry_count": 0,
                "source": "login_reward_campaign",
                "treasury_wallet_id": _norm_student_id(sl_treasury_id),
                "campaign_name": camp.get("name") or "",
            }
            try:
                await _lrc_claims.insert_one(claim_doc)
            except Exception:
                # Duplicate-key — an existing claim is either fresh-pending or credited.
                existing = await _lrc_claims.find_one(
                    {"campaign_id": campaign_id, "student_id_norm": sid_norm},
                    {"_id": 0},
                )
                if not existing:
                    # Lost the race AND lost the read — surface a clean retry hint.
                    _LRC_LOG.warning(
                        "login_reward: claim race with no readable doc student=%s campaign=%s",
                        sid_clean, campaign_id,
                    )
                    raise HTTPException(status_code=409, detail="Claim conflict, please try again")
                ex_status = (existing.get("status") or "").lower()
                if ex_status == "credited":
                    _resp_ac = {
                        "success": True,
                        "duplicate": True,
                        "already_claimed": True,
                        "status": "credited",
                        "points_awarded": int(existing.get("points_awarded") or points),
                        "claimed_at": existing.get("credited_at") or existing.get("claimed_at"),
                        "campaign_id": campaign_id,
                        "success_message": camp.get("success_message") or "Reward already credited.",
                    }
                    # points_voucher: re-surface the (already-issued) voucher so a
                    # refresh/re-claim still reveals it. Idempotent + best-effort.
                    if reward_kind == "points_voucher":
                        try:
                            _resp_ac["reward_kind"] = "points_voucher"
                            _resp_ac["voucher"] = await _lrc_issue_voucher_for_claim(camp, sid_clean, sid_norm)
                        except Exception as _ve:
                            _LRC_LOG.warning("login_reward: voucher re-surface failed campaign=%s err=%s", campaign_id, _ve)
                    return _resp_ac
                if ex_status == "pending":
                    # Another in-flight caller still owns the row. Tell client to retry shortly.
                    _LRC_LOG.info(
                        "login_reward: pending in-flight student=%s campaign=%s",
                        sid_clean, campaign_id,
                    )
                    return JSONResponse(
                        status_code=202,
                        content={
                            "success": False,
                            "status": "pending",
                            "campaign_id": campaign_id,
                            "detail": "Reward claim is still processing. Please try again shortly.",
                            "retry_after_seconds": 3,
                        },
                    )
                # Any other status (defensive) — refuse and surface for inspection.
                _LRC_LOG.warning(
                    "login_reward: unexpected claim status student=%s campaign=%s status=%s",
                    sid_clean, campaign_id, ex_status,
                )
                raise HTTPException(status_code=409, detail=f"Claim in unexpected state: {ex_status or 'unknown'}")

        # ── At this point THIS handler owns the credit attempt. attempt_id is
        #    the proof of ownership for the finalising update.

        credit = await _lrc_credit_via_treasury(
            student_clean_id=sid_clean,
            points=points,
            campaign_id=campaign_id,
            campaign_name=camp.get("name") or "",
        )

        if not credit.get("ok"):
            # Mark the claim as failed (do NOT delete — keep audit trail and
            # allow safe retry via the failed-acquisition branch above). The
            # attempt_id filter ensures we only mutate OUR row.
            try:
                await _lrc_claims.update_one(
                    {
                        "campaign_id": campaign_id,
                        "student_id_norm": sid_norm,
                        "attempt_id": attempt_id,
                        "status": "pending",
                    },
                    {
                        "$set": {
                            "status": "failed",
                            "failed_at": _lrc_iso(_lrc_now()),
                            "error": str(credit.get("error") or "unknown")[:300],
                        },
                    },
                )
            except Exception as _mfe:
                _LRC_LOG.warning("login_reward: mark-failed update error: %s", _mfe)
            _LRC_LOG.warning(
                "login_reward: GAS credit failed for %s campaign=%s err=%s",
                sid_clean, campaign_id, credit.get("error"),
            )
            raise HTTPException(
                status_code=502,
                detail=f"Points credit failed: {credit.get('error') or 'unknown'}",
            )

        # ── finalize: ONLY OUR attempt may flip pending → credited ──────────
        finalize_iso = _lrc_iso(_lrc_now())
        finalized = await _lrc_claims.update_one(
            {
                "campaign_id": campaign_id,
                "student_id_norm": sid_norm,
                "attempt_id": attempt_id,
                "status": "pending",
            },
            {
                "$set": {
                    "status": "credited",
                    "credited_at": finalize_iso,
                },
            },
        )

        if finalized.modified_count == 0:
            # Someone else (a concurrent retry that found us stale) raced and
            # already finalised. We've therefore caused a SECOND GAS credit on
            # this student — record a duplicate-credit warning row so operators
            # can reconcile. This should be statistically impossible unless the
            # stale-pending threshold is misconfigured to be very small.
            _LRC_LOG.error(
                "login_reward: finalize lost race — possible duplicate credit "
                "student=%s campaign=%s attempt=%s points=%d",
                sid_clean, campaign_id, attempt_id, points,
            )
            try:
                await db.login_reward_claims.update_one(
                    {"campaign_id": campaign_id, "student_id_norm": sid_norm},
                    {
                        "$push": {
                            "duplicate_credit_warnings": {
                                "attempt_id": attempt_id,
                                "points": points,
                                "at": finalize_iso,
                                "gas": credit.get("gas") or {},
                            }
                        }
                    },
                )
            except Exception:
                pass
            # Still return success because GAS DID credit the student, so the
            # client truth matches the wallet. The dup warning row is for ops.
            return {
                "success": True,
                "duplicate": False,
                "status": "credited",
                "points_awarded": points,
                "campaign_id": campaign_id,
                "claimed_at": finalize_iso,
                "success_message": camp.get("success_message") or "Reward credited.",
                "warning": "duplicate_credit_race",
            }

        # Best-effort audit row in the EXISTING points_history collection.
        try:
            await db.points_history.insert_one({
                "student_id":         sid_clean,
                "from":               sl_treasury_id,
                "to":                 sid_clean,
                "delta":              points,
                "source":             "login_reward",
                "description":        f"Login reward · {camp.get('name') or campaign_id}",
                "granted_by":         "login_reward_campaign",
                "created_at":         finalize_iso,
                "senderStudentId":    sl_treasury_id,
                "recipientStudentId": sid_clean,
                "amount":             points,
                "display_sender":     "Treasury",
                "campaign_id":        campaign_id,
            })
        except Exception as _ph_err:
            _LRC_LOG.warning("login_reward: points_history insert failed: %s", _ph_err)

        # ── v1 (eduhub_portal_latest_bonus_glass_rewards_ui_v1) ──────────────
        # Write a CONFIRMED row to the canonical Mongo ledger so the
        # /api/student/points/latest endpoint and the My Portal Rewards box
        # surface this reward as "Login reward · +N pts" — instead of the
        # current incorrect "No confirmed reward yet" state observed in
        # production. This is the missing source-of-truth piece:
        #   • The GAS credit has already succeeded above (`credit.get("ok")`).
        #   • The claim row is already finalised as `status: credited` so
        #     no concurrent caller can produce a second credit.
        #   • The ledger row is idempotent: a stable `idempotency_key`
        #     keyed by `campaign_id + student_id_norm` collapses any retry
        #     (browser refresh, network jitter, the "already_claimed"
        #     branch) onto the SAME row via `$setOnInsert`. No duplicate
        #     ledger record, no duplicate points.
        #   • Failure is non-fatal — the wallet credit itself is owned by
        #     GAS and the existing claim guard, so a ledger insert error
        #     can never affect the student's actual balance or the success
        #     response of this endpoint.
        try:
            _wallet_to_id = (
                getattr(student, "student_id", "")
                or _norm_student_id(sid_clean)
                or sid_clean
            )
            _ledger_idem = f"login_reward:{campaign_id}:{sid_norm}"
            await db.points_transactions.update_one(
                {"idempotency_key": _ledger_idem},
                {
                    "$setOnInsert": {
                        "idempotency_key": _ledger_idem,
                        "from_id":         "treasury",
                        "to_id":           _wallet_to_id,
                        "student_id":      _wallet_to_id,
                        "clean_id":        sid_clean,
                        "amount":          int(points),
                        "type":            "credit",
                        "operation":       "credit",
                        "delta":           int(points),
                        "source":          "login_reward",
                        "source_ref":      campaign_id,
                        "status":          "confirmed",
                        "created_at":      finalize_iso,
                        "payload": {
                            "campaign_id":   campaign_id,
                            "campaign_name": camp.get("name") or "",
                            "clean_id":      sid_clean,
                            "attempt_id":    attempt_id,
                        },
                    },
                },
                upsert=True,
            )
        except Exception as _ledger_err:
            _LRC_LOG.warning(
                "login_reward: points_transactions confirmed insert failed (non-fatal): %s",
                _ledger_err,
            )

        # ── celebration push (best-effort, never raises into the response) ──
        try:
            await _lrc_send_celebration_push(
                student_clean_id=sid_clean,
                student_raw_id=getattr(student, "student_id", "") or sid_clean,
                points=points,
                campaign_name=camp.get("name") or "Login reward",
            )
        except Exception as _push_err:
            _LRC_LOG.warning("login_reward: celebration push failed: %s", _push_err)

        _LRC_LOG.info(
            "login_reward: credited student=%s campaign=%s points=%d attempt=%s",
            sid_clean, campaign_id, points, attempt_id,
        )

        _resp_ok = {
            "success": True,
            "duplicate": False,
            "status": "credited",
            "points_awarded": points,
            "campaign_id": campaign_id,
            "claimed_at": finalize_iso,
            "success_message": camp.get("success_message") or "Reward credited.",
        }
        # points_voucher: issue the Book Voucher as a best-effort follow-up AFTER
        # the points credit has fully succeeded. Never raises into the response —
        # the points credit is already finalised and owned by the claim guard, so
        # a voucher hiccup can't affect the wallet or the success status.
        if reward_kind == "points_voucher":
            try:
                _resp_ok["reward_kind"] = "points_voucher"
                _resp_ok["voucher"] = await _lrc_issue_voucher_for_claim(camp, sid_clean, sid_norm)
            except Exception as _ve:
                _LRC_LOG.warning("login_reward: points_voucher issue failed campaign=%s err=%s", campaign_id, _ve)
        return _resp_ok

    return LoginRewardHooks(
        credit_via_treasury=_lrc_credit_via_treasury,
        issue_voucher_for_claim=_lrc_issue_voucher_for_claim,
        compose_voucher_payload=_lrc_compose_voucher_payload,
        gen_coupon_code=_lrc_gen_coupon_code,
        student_vouchers=_lrc_student_vouchers,
        ensure_indexes=_lrc_ensure_indexes,
    )
