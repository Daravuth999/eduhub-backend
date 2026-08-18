"""attendance_tools.py
=====================
EduHub Smart Attendance — "Constellation Check-In" (additive, isolated).

Same style as voice_treasure_attempt_tools.py / login_reward_tools.py:
Pydantic models with ``model_config = ConfigDict(extra="ignore")`` and a
single ``register_attendance_routes(api, db, require_admin, require_student, ...)``
entry point wired into server.py alongside the other feature modules.

Scope & boundaries
------------------
* Lives entirely in NEW collections:
    attendance_classes, attendance_sessions, attendance_records,
    attendance_streaks, attendance_settings.
* Does NOT touch the legacy ``speaking_lab_attendance`` collection / routes.
* Interacts with protected modules ONLY through their public APIs, injected
  by server.py at registration time:
    - ``wallet`` (wallet_service.WalletService) for idempotent point credits.
    - ``fan_out_push`` / ``build_target_query`` for push (sender reused as-is).
    - ``norm_student_id`` for canonical id comparison.
* Reuses the existing ``require_student`` / ``cleanId`` login for identity —
  never Telegram / Google identity. No new auth path.

The mid-section "still here?", risk score, tiers, streaks and nudge
guardrails are implemented as PURE module-level functions so they are unit
testable without a database (see tests/test_attendance_*.py).
"""
from __future__ import annotations

import asyncio
import base64
import io
import logging
import os
import secrets
from datetime import datetime, timedelta, timezone
from typing import Any, Literal

import segno
from pydantic import BaseModel, ConfigDict, Field

from login_reward_tools import _lrc_campaign_status, lrc_get_campaign_public

log = logging.getLogger("eduhub.attendance")

# ── v2 rollout flag ──────────────────────────────────────────────────────
# AND-gated, fail-closed: BOTH an explicit env var AND a settings-doc toggle
# must be true, mirroring speaking_lab_feature_flags.py's two-switch pattern
# elsewhere in this codebase. Gates: the redesigned status model (no more
# punitive "Partial" from a missed mid-session tap — see finalize_status_v2),
# the monthly reward engine, and the new v2-only routes. With the flag off,
# every existing route/behavior is byte-for-byte unchanged.
V2_ENV_VAR = "ATTENDANCE_V2_ENABLED"


def _env_flag_on(name: str) -> bool:
    return (os.environ.get(name) or "").strip().lower() in {"1", "true", "yes", "on"}


def _v2_active(settings: dict) -> bool:
    if not _env_flag_on(V2_ENV_VAR):
        return False
    return bool(settings.get("v2_enabled"))

# ── collections ────────────────────────────────────────────────────────────
COLL_CLASSES = "attendance_classes"
COLL_SESSIONS = "attendance_sessions"
COLL_RECORDS = "attendance_records"
COLL_STREAKS = "attendance_streaks"
COLL_SETTINGS = "attendance_settings"
COLL_CLAIMS = "attendance_reward_claims"
SETTINGS_ID = "attendance_settings"

# ── attendance statuses ──────────────────────────────────────────────────────
ST_PRESENT_FULL = "present_full"
ST_PRESENT_PARTIAL = "present_partial"
ST_LATE = "late"
ST_ABSENT = "absent"
_PRESENT_STATES = {ST_PRESENT_FULL, ST_PRESENT_PARTIAL, ST_LATE}

# ── session lifecycle ────────────────────────────────────────────────────────
SESS_SCHEDULED = "scheduled"
SESS_OPEN = "open"
SESS_CLOSED = "closed"

# ── reliability tiers (ascending) ────────────────────────────────────────────
TIER_BRONZE = "bronze"
TIER_SILVER = "silver"
TIER_GOLD = "gold"
TIER_DIAMOND = "diamond"
TIER_ORDER = [TIER_BRONZE, TIER_SILVER, TIER_GOLD, TIER_DIAMOND]

# Rolling at-risk nudge cap (guardrail): at most one predictive nudge per
# student per this many days.
AT_RISK_NUDGE_COOLDOWN_DAYS = 7

# Miss reasons (non-punitive). Stored verbatim, never used to punish.
MISS_REASONS = {"sick", "conflict", "forgot"}


# ─────────────────────────────────────────────────────────────────────────────
# time helpers
# ─────────────────────────────────────────────────────────────────────────────
def _utcnow() -> datetime:
    return datetime.now(timezone.utc)


def _utcnow_iso() -> str:
    return _utcnow().isoformat()


def _parse_iso(value) -> datetime | None:
    if value is None:
        return None
    if isinstance(value, datetime):
        return value if value.tzinfo else value.replace(tzinfo=timezone.utc)
    if not isinstance(value, str):
        return None
    s = value.strip()
    if not s:
        return None
    try:
        if s.endswith("Z"):
            s = s[:-1] + "+00:00"
        dt = datetime.fromisoformat(s)
        return dt if dt.tzinfo else dt.replace(tzinfo=timezone.utc)
    except Exception:
        return None


def _iso(dt: datetime | None) -> str | None:
    if dt is None:
        return None
    if dt.tzinfo is None:
        dt = dt.replace(tzinfo=timezone.utc)
    return dt.astimezone(timezone.utc).isoformat()


# ─────────────────────────────────────────────────────────────────────────────
# PURE LOGIC — status, risk score, tiers, streaks, nudge guardrails.
# Kept free of any DB access so they can be unit-tested with known inputs.
# ─────────────────────────────────────────────────────────────────────────────
def compute_checkin_status(now: datetime, opens_at: datetime | None,
                           grace_deadline: datetime | None) -> str:
    """Status to assign at the MOMENT a student checks in (joins).

    * On time (at or before the grace deadline) → ``present_full`` (may later
      be downgraded to ``present_partial`` if the mid-session tap is missed).
    * After the grace deadline → ``late``.
    A student who never checks in is marked ``absent`` at session close (see
    ``finalize_status``); that is handled by the close pass, not here.
    """
    if grace_deadline is not None and now > grace_deadline:
        return ST_LATE
    return ST_PRESENT_FULL


def finalize_status(checked_in: bool, checkin_status: str | None,
                    mid_session_confirmed: bool,
                    mid_session_required: bool) -> str:
    """Resolve the FINAL status for a session at close time.

    * No check-in at all → ``absent``.
    * ``late`` stays ``late`` regardless of the mid-session tap.
    * ``present_full`` is downgraded to ``present_partial`` ONLY when the
      mid-session confirmation was required and was not tapped. Missing the
      tap never marks someone absent.
    """
    if not checked_in:
        return ST_ABSENT
    if checkin_status == ST_LATE:
        return ST_LATE
    if mid_session_required and not mid_session_confirmed:
        return ST_PRESENT_PARTIAL
    return checkin_status or ST_PRESENT_FULL


# ── v2 status model: attendance_status separated from verification_status ──
# Root-cause finding: `present_partial` above is produced by a missed
# mid-session "Still here?" tap — a UI confirmation that ships in the API
# but is never rendered by any current frontend component, so on-time
# students were structurally destined to be marked Partial through no
# fault of their own. v2 stops treating an unconfirmed tap as an
# attendance-status downgrade; verification becomes a separate, informational
# field that never determines whether a student looks like they attended.
def finalize_status_v2(checked_in: bool, checkin_status: str | None) -> str:
    """v2 attendance status — decided ONLY by check-in timing. Never
    downgraded by a missed mid-session confirmation."""
    if not checked_in:
        return ST_ABSENT
    return checkin_status or ST_PRESENT_FULL


def compute_verification_status(checked_in: bool, mid_session_confirmed: bool,
                                mid_session_required: bool) -> str:
    """v2 verification signal — informational only, never fed back into
    `status`. One of: not_applicable (never checked in), not_required
    (mid-session confirmation wasn't configured for this session),
    confirmed, pending."""
    if not checked_in:
        return "not_applicable"
    if not mid_session_required:
        return "not_required"
    return "confirmed" if mid_session_confirmed else "pending"


# ── v2 monthly analytics — pure, reusable by both the student summary route
# and the monthly-claim route's server-side re-verification. present_partial
# counts as attended (it is a verification gap, never a genuine absence —
# see the root-cause note above), matching admin_report()'s own existing
# attendance_pct definition so the two never disagree. ──────────────────────
def compute_monthly_stats(statuses: list[str]) -> dict:
    present = sum(1 for s in statuses if s == ST_PRESENT_FULL)
    partial = sum(1 for s in statuses if s == ST_PRESENT_PARTIAL)
    late = sum(1 for s in statuses if s == ST_LATE)
    absent = sum(1 for s in statuses if s == ST_ABSENT)
    attended = present + partial + late
    total = attended + absent
    return {
        "present": present, "partial": partial, "late": late, "absent": absent,
        "attended": attended, "total": total,
        "attendance_pct": round(100 * attended / total, 1) if total else 0.0,
    }


def compute_monthly_eligibility(stats: dict, threshold_pct: float) -> dict:
    """Pure eligibility decision — always recomputed server-side, never
    trusted from a client. threshold_pct is a fraction (0.85 == 85%).
    A month with no finalized sessions yet is never "eligible" — an
    undefined denominator must never look like a passing grade."""
    required_pct = round(float(threshold_pct or 0) * 100, 1)
    met = stats["total"] > 0 and stats["attendance_pct"] >= required_pct
    return {"required_pct": required_pct, "met": met}


def _shift_period(period: str, months_back: int) -> str:
    """"YYYY-MM" arithmetic without pulling in a calendar dependency —
    used to walk backwards N months for the student-facing monthly
    history list."""
    y, m = (int(x) for x in period.split("-"))
    total = (y * 12 + (m - 1)) - months_back
    return f"{total // 12:04d}-{total % 12 + 1:02d}"


def _clamp01(x: float) -> float:
    try:
        x = float(x)
    except Exception:
        return 0.0
    return 0.0 if x < 0 else 1.0 if x > 1 else x


def compute_risk_score(on_time_rate_5: float, on_time_rate_15: float,
                       miss_threshold_proximity: float,
                       skipped_confirmation_rate: float) -> int:
    """Weighted, rule-based, fully explainable risk score (0–100).

    Higher = MORE at risk. All four inputs are normalised 0..1.

      | signal                                   | weight |
      |------------------------------------------|--------|
      | (1 - on-time rate, last 5 sessions)      | 40%    |
      | (1 - on-time rate, last 15 sessions)     | 30%    |
      | proximity to the configured miss thresh. | 20%    |
      | rate of skipped mid-session confirmations| 10%    |

    On-time rates are inverted: a perfect on-time record contributes 0 risk
    from those signals, while never being on time contributes the full
    weight. No ML, no black box — every term is auditable on request.
    """
    ot5 = _clamp01(on_time_rate_5)
    ot15 = _clamp01(on_time_rate_15)
    prox = _clamp01(miss_threshold_proximity)
    skip = _clamp01(skipped_confirmation_rate)
    score = (
        0.40 * (1.0 - ot5)
        + 0.30 * (1.0 - ot15)
        + 0.20 * prox
        + 0.10 * skip
    ) * 100.0
    return int(round(score))


def risk_band(score: int, escalation_threshold: int) -> str:
    """Map a risk score to an action band.

    * score ≥ threshold (default 70) → ``high`` (proactive nudge + teacher
      "needs encouragement now" flag).
    * 40 ≤ score < threshold → ``monitored`` (no extra nudge).
    * score < 40 → ``standard`` (standard flow only).
    """
    if score >= int(escalation_threshold):
        return "high"
    if score >= 40:
        return "monitored"
    return "standard"


def compute_signals(statuses_5: list[str], statuses_15: list[str],
                    miss_threshold: int, recent_absences: int,
                    confirmations_offered: int, confirmations_skipped: int) -> dict:
    """Derive the four risk signals from raw session history.

    * on-time rate = fraction of sessions whose status is present_full or
      present_partial (joined on time). ``late`` and ``absent`` are not
      on-time.
    * miss-threshold proximity = recent_absences / miss_threshold, clamped.
    * skipped-confirmation rate = skipped / offered.
    """
    def _on_time_rate(rows: list[str]) -> float:
        if not rows:
            return 1.0  # no history yet ⇒ assume reliable (no risk)
        good = sum(1 for s in rows if s in (ST_PRESENT_FULL, ST_PRESENT_PARTIAL))
        return good / len(rows)

    prox = 0.0
    if miss_threshold and miss_threshold > 0:
        prox = _clamp01(recent_absences / float(miss_threshold))
    skip = 0.0
    if confirmations_offered and confirmations_offered > 0:
        skip = _clamp01(confirmations_skipped / float(confirmations_offered))
    return {
        "on_time_rate_5": _on_time_rate(statuses_5),
        "on_time_rate_15": _on_time_rate(statuses_15),
        "miss_threshold_proximity": prox,
        "skipped_confirmation_rate": skip,
    }


def compute_tier(attendance_rate: float, on_time_rate: float,
                 tiers: list[dict]) -> str:
    """Resolve the highest tier whose thresholds are BOTH satisfied.

    ``tiers`` is the settings list, each: {tier, min_attendance_rate,
    min_on_time_rate, multiplier}. Falling short of a tier only lowers the
    multiplier — it never restricts access to anything.
    """
    ar = _clamp01(attendance_rate)
    otr = _clamp01(on_time_rate)
    best = TIER_BRONZE
    best_rank = -1
    for t in tiers or []:
        name = (t.get("tier") or "").lower()
        if name not in TIER_ORDER:
            continue
        if ar >= float(t.get("min_attendance_rate") or 0) and \
           otr >= float(t.get("min_on_time_rate") or 0):
            rank = TIER_ORDER.index(name)
            if rank > best_rank:
                best_rank = rank
                best = name
    return best


def tier_multiplier(tier: str, tiers: list[dict]) -> float:
    for t in tiers or []:
        if (t.get("tier") or "").lower() == (tier or "").lower():
            try:
                return float(t.get("multiplier") or 1.0)
            except Exception:
                return 1.0
    return 1.0


def compute_streak(dated_statuses: list[tuple[str, str]]) -> tuple[int, int]:
    """Compute (current_streak, longest_streak) from chronological history.

    ``dated_statuses`` is a list of (date_iso, status) in ANY order; sorted
    here ascending by date. A "present" day (present_full / present_partial /
    late) extends the streak; ``absent`` breaks it. Current streak counts the
    trailing run of present days.
    """
    rows = sorted(dated_statuses, key=lambda r: r[0])
    longest = 0
    run = 0
    current = 0
    for _date, status in rows:
        if status in _PRESENT_STATES:
            run += 1
            longest = max(longest, run)
        else:
            run = 0
    # current streak = trailing run
    for _date, status in reversed(rows):
        if status in _PRESENT_STATES:
            current += 1
        else:
            break
    return current, longest


def nudge_guardrail_allows(now: datetime,
                           last_at_risk_nudge_at: datetime | None,
                           closing_soon_sent_today: bool,
                           last_absence_reason_at: datetime | None) -> bool:
    """Enforce the at-risk (predictive) nudge guardrails.

    Returns True ONLY when ALL hold:
      * No predictive nudge sent within the rolling 7-day window.
      * No closing-soon nudge was already sent to this student TODAY
        (a same-day closing-soon suppresses that day's predictive nudge).
      * No absence reason was logged within the last 24h (a recently-logged
        absence reason suppresses the next at-risk nudge).
    """
    if closing_soon_sent_today:
        return False
    if last_at_risk_nudge_at is not None:
        if now - last_at_risk_nudge_at < timedelta(days=AT_RISK_NUDGE_COOLDOWN_DAYS):
            return False
    if last_absence_reason_at is not None:
        if now - last_absence_reason_at < timedelta(hours=24):
            return False
    return True


# ─────────────────────────────────────────────────────────────────────────────
# default settings (EN/KH bilingual copy — KH defaults are DRAFTS pending a
# native-speaker review; the teacher can edit every field in Author Studio).
# ─────────────────────────────────────────────────────────────────────────────
def default_settings() -> dict:
    return {
        "_id": SETTINGS_ID,
        # v2 rollout — see V2_ENV_VAR / _v2_active() above. Both this AND the
        # env var must be true for v2 behavior to activate anywhere.
        "v2_enabled": False,
        # Monthly attendance reward (v2-only). Reuses the existing wallet-
        # backed credit + attendance_reward_claims idempotency machinery —
        # no new reward collection, no new claim mechanism.
        "monthly_reward_enabled": False,
        "monthly_reward_threshold_pct": 0.85,
        # The reward's real identity (name/points/availability) is never
        # duplicated into attendance's own config — this references an
        # existing Author Studio Login Reward campaign (login_reward_campaigns,
        # field "id") by id, fetched live at both summary-display and
        # claim time. None = admin hasn't attached a reward yet.
        "monthly_reward_campaign_id": None,
        "checkin_window_minutes": 90,
        "late_grace_minutes": 10,
        "mid_session_enabled": True,
        "mid_session_offset_minutes": 20,
        "shared_device_prompt_enabled": True,
        "miss_threshold": 3,
        "escalation_threshold": 70,
        "consecutive_absence_threshold": 2,
        # reward economy — base points credited per present session, scaled by
        # the student's reliability-tier multiplier.
        "base_attendance_points": 5,
        "reward_tiers": [
            {"tier": TIER_BRONZE, "min_attendance_rate": 0.0, "min_on_time_rate": 0.0, "multiplier": 1.0},
            {"tier": TIER_SILVER, "min_attendance_rate": 0.7, "min_on_time_rate": 0.6, "multiplier": 1.25},
            {"tier": TIER_GOLD, "min_attendance_rate": 0.85, "min_on_time_rate": 0.8, "multiplier": 1.5},
            {"tier": TIER_DIAMOND, "min_attendance_rate": 0.95, "min_on_time_rate": 0.9, "multiplier": 2.0},
        ],
        "notifications": {
            "live_now_enabled": True,
            "closing_soon_enabled": True,
            "closing_soon_offset_minutes": 15,
            "predictive_at_risk_enabled": True,
            "mid_session_push_enabled": True,
            "auto_open_enabled": True,
            "auto_close_enabled": True,
        },
        # Claim-mode reward settings. Defaults to False — existing auto-credit
        # behaviour is UNCHANGED until a teacher explicitly enables claim mode
        # and sets claim_mode_activation_at. Only sessions closed AFTER that
        # timestamp produce pending claims; older credits remain as-is.
        "claim_rewards_enabled": False,
        "claim_mode_activation_at": None,    # ISO timestamp or None
        "claim_minimum_points": 0,           # 0 = no minimum threshold
        "reward_ready_push_enabled": True,
        "reward_claimed_push_enabled": True,
        # bilingual nudge copy. KH reviewed and corrected below.
        "copy": {
            "live_now": {
                "title_en": "Class is live now",
                "title_kh": "ថ្នាក់រៀនកំពុងផ្សាយផ្ទាល់",
                "body_en": "Your class has started. Tap to join the Meet now.",
                "body_kh": "ថ្នាក់របស់អ្នកបានចាប់ផ្តើមហើយ។ ចុចដើម្បីចូលរួម Meet ឥឡូវនេះ។",
            },
            "closing_soon": {
                "title_en": "Check-in closing soon",
                "title_kh": "ការចុះឈ្មោះជិតបិទហើយ",
                "body_en": "You haven't joined yet. Check in before the window closes.",
                "body_kh": "អ្នកមិនទាន់បានចូលរួមនៅឡើយទេ។ សូមចុះឈ្មោះមុនពេលបិទ។",
            },
            "mid_session": {
                "title_en": "Still here?",
                "title_kh": "នៅទីនេះមែនទេ?",
                "body_en": "Tap once to confirm you're still in class.",
                "body_kh": "ចុចម្តងដើម្បីបញ្ជាក់ថាអ្នកនៅតែរៀន។",
            },
            # Corrected Khmer absence copy (replaces previous machine-translated draft).
            "miss_followup": {
                "title_en": "Absent today",
                "title_kh": "អវត្តមានថ្ងៃនេះ",
                "body_en": "You did not attend today's class. If there was a reason, please let your teacher know.",
                "body_kh": "អ្នកមិនបានចូលរៀនសម្រាប់ថ្ងៃនេះទេ។ ប្រសិនបើមានមូលហេតុ សូមជូនដំណឹងដល់គ្រូបង្រៀន។",
            },
            "at_risk": {
                "title_en": "A gentle reminder",
                "title_kh": "ការរំលឹកដ៏ស្និទ្ធស្នាល",
                "body_en": "Your next class is coming up. We'd love to see you there.",
                "body_kh": "ថ្នាក់បន្ទាប់របស់អ្នកជិតមកដល់ហើយ។ យើងរីករាយដែលបានឃើញអ្នកនៅទីនោះ។",
            },
            "miss_escalation": {
                "title_en": "We miss you in class",
                "title_kh": "យើងនឹករលឹកអ្នកនៅក្នុងថ្នាក់",
                "body_en": "You've missed several classes in a row. Tap to check your record and let your teacher know.",
                "body_kh": "អ្នកបានខកខានថ្នាក់ជាច្រើនជាប់គ្នា។ ចុចដើម្បីពិនិត្យការចូលរៀនរបស់អ្នក។",
            },
            "reward_ready": {
                "title_en": "Reward ready to claim",
                "title_kh": "រង្វាន់រួចរាល់សម្រាប់ទទួល",
                "body_en": "You have attendance reward points waiting. Tap to claim them now.",
                "body_kh": "អ្នកមានពិន្ទុរង្វាន់វត្តមានរង់ចាំទទួល។ ចុចដើម្បីទទួលឥឡូវនេះ។",
            },
            "reward_claimed": {
                "title_en": "Attendance reward",
                "title_kh": "រង្វាន់វត្តមាន",
                # {points} is substituted at send time.
                "body_en": "Congratulations! +{points} points have been added to your account.",
                "body_kh": "សូមអបអរសាទរ! ពិន្ទុ +{points} ត្រូវបានបញ្ចូលទៅគណនីរបស់អ្នកដោយជោគជ័យ។",
            },
            # Monthly Login-Rewards-campaign-backed reward (Phase 7/8) — distinct
            # from "reward_ready" above, which is the legacy per-session
            # base_attendance_points claim flow.
            "monthly_goal_reached": {
                "title_en": "Monthly goal reached",
                "title_kh": "សម្រេចបានគោលដៅប្រចាំខែ",
                "body_en": "You've qualified for your attendance reward this month.",
                "body_kh": "អ្នកបានមានលក្ខណៈសម្បត្តិគ្រប់គ្រាន់សម្រាប់រង្វាន់វត្តមានប្រចាំខែនេះ។",
            },
            "monthly_reward_ready": {
                "title_en": "Your attendance reward is ready",
                "title_kh": "រង្វាន់វត្តមានរបស់អ្នករួចរាល់ហើយ",
                "body_en": "Your attendance reward is ready to claim.",
                "body_kh": "រង្វាន់វត្តមានរបស់អ្នកអាចទទួលបានហើយ។",
            },
        },
        "updated_at": _utcnow_iso(),
    }


def _merge_settings(stored: dict | None) -> dict:
    base = default_settings()
    if not stored:
        return base
    out = dict(base)
    for k, v in stored.items():
        if k == "_id":
            continue
        if isinstance(v, dict) and isinstance(base.get(k), dict):
            merged = dict(base[k])
            merged.update(v)
            out[k] = merged
        else:
            out[k] = v
    return out


def _render_session_qr(payload_text: str) -> str:
    """Render `payload_text` (the full join URL, built client-side by the
    same origin logic AttendanceStudio.jsx's existing copyJoinLink() already
    uses) to a PNG data URI. Same segno usage as student_smart_login.py's
    _render_qr — already a hard backend dependency, no new library."""
    from fastapi import HTTPException
    try:
        qr = segno.make(payload_text, error="m")
        buf = io.BytesIO()
        qr.save(buf, kind="png", scale=8, border=2)
        return "data:image/png;base64," + base64.b64encode(buf.getvalue()).decode("ascii")
    except Exception as exc:  # noqa: BLE001
        raise HTTPException(status_code=500, detail="QR rendering failed") from exc


# ─────────────────────────────────────────────────────────────────────────────
# v2 monthly reward — reads the REAL Login Reward campaign an admin attaches
# to attendance in Settings, rather than inventing a duplicate reward
# config. Reads only — never calls login_reward_tools.py's audience
# eligibility or claim routes, since a campaign's normal audience gate
# (all/specific/exclude) has no relationship to an attendance-percentage
# rule. The underlying login-reward campaigns collection is read exclusively
# inside login_reward_tools.py via lrc_get_campaign_public(db, campaign_id)
# — this module goes through that accessor only, so the collection keeps a
# single real owner (see tools/check_collection_ownership.py --strict).
# ─────────────────────────────────────────────────────────────────────────────
CAMP_LIVE = "live"
CAMP_SCHEDULED = "scheduled"
CAMP_EXPIRED = "expired"
CAMP_DISABLED = "disabled"


async def _fetch_reward_campaign(db, campaign_id: str | None) -> dict | None:
    """Live-fetch the attached Login Reward campaign's real identity.
    Returns None if no campaign is attached, it no longer exists, or it
    doesn't carry a points component (voucher-only campaigns can't fund
    an attendance points reward). Never cached — the campaign's current
    name/points/status are authoritative every time this is called."""
    camp = await lrc_get_campaign_public(db, campaign_id)
    if not camp:
        return None
    points = int(camp.get("reward_points") or 0)
    if camp.get("reward_kind") == "voucher" or points <= 0:
        return None
    return {
        "campaign_id": campaign_id,
        "name": camp.get("reward_label") or camp.get("name") or "",
        "points": points,
        "status": camp["status"],
    }


def _derive_campaign_status(camp: dict, now: datetime | None = None) -> str:
    """Thin re-export of login_reward_tools._lrc_campaign_status — kept as a
    module-level name here (rather than inlined) because tests exercise it
    directly, matching the pure-function-import convention this codebase's
    other reward-chain siblings already use (e.g. mystery_box_tools.py's
    `from login_reward_tools import _lrc_voucher_discount_label`)."""
    return _lrc_campaign_status(camp, now)


# ─────────────────────────────────────────────────────────────────────────────
# pydantic payloads
# ─────────────────────────────────────────────────────────────────────────────
class ClassIn(BaseModel):
    model_config = ConfigDict(extra="ignore")
    title_en: str = "Untitled class"
    title_kh: str = ""
    teacher: str = ""
    recurrence: str = ""
    group: str = ""
    roster: list[str] = Field(default_factory=list)


class SessionIn(BaseModel):
    model_config = ConfigDict(extra="ignore")
    class_id: str
    date: str | None = None
    meet_url: str = ""
    opens_at: str | None = None
    closes_at: str | None = None
    grace_minutes: int | None = None
    mid_session_enabled: bool | None = None


class CheckInIn(BaseModel):
    model_config = ConfigDict(extra="ignore")
    slug: str
    as_student_id: str | None = None  # "not you?" re-attribution target


class MidSessionIn(BaseModel):
    model_config = ConfigDict(extra="ignore")
    session_id: str


class MissReasonIn(BaseModel):
    model_config = ConfigDict(extra="ignore")
    session_id: str
    reason: Literal["sick", "conflict", "forgot"]


class SettingsIn(BaseModel):
    model_config = ConfigDict(extra="ignore")
    settings: dict


# ─────────────────────────────────────────────────────────────────────────────
# indexes (idempotent, best-effort)
# ─────────────────────────────────────────────────────────────────────────────
async def ensure_attendance_indexes(db) -> None:
    try:
        await db[COLL_CLASSES].create_index("class_id", unique=True, sparse=True)
        await db[COLL_SESSIONS].create_index("session_id", unique=True, sparse=True)
        await db[COLL_SESSIONS].create_index("join_slug", unique=True, sparse=True)
        await db[COLL_SESSIONS].create_index([("class_id", 1), ("date", -1)])
        await db[COLL_SESSIONS].create_index([("status", 1), ("closes_at", 1)])
        await db[COLL_RECORDS].create_index(
            [("session_id", 1), ("student_id", 1)], unique=True,
            name="uniq_session_student",
        )
        await db[COLL_RECORDS].create_index("student_id")
        await db[COLL_RECORDS].create_index([("class_id", 1), ("checked_in_at", 1)])
        await db[COLL_STREAKS].create_index("student_id", unique=True, sparse=True)
        await db[COLL_CLAIMS].create_index([("student_id", 1), ("status", 1)])
        await db[COLL_CLAIMS].create_index("idempotency_key", unique=True, sparse=True)
        await db[COLL_CLAIMS].create_index("source_session_id")
        log.info("attendance: indexes ensured")
    except Exception as exc:  # noqa: BLE001
        log.warning("attendance: index ensure failed (non-fatal): %s", exc)


# ─────────────────────────────────────────────────────────────────────────────
# entry point
# ─────────────────────────────────────────────────────────────────────────────
def register_attendance_routes(api, db, require_admin, require_student, *,
                               current_student=None, fan_out_push=None,
                               build_target_query=None, norm_student_id=None,
                               wallet=None) -> None:
    from fastapi import Depends, HTTPException
    from fastapi.responses import RedirectResponse

    _norm = norm_student_id or (lambda v: (str(v or "")).strip().lower())

    # ── small DB helpers ─────────────────────────────────────────────────
    async def _load_settings() -> dict:
        stored = await db[COLL_SETTINGS].find_one({"_id": SETTINGS_ID})
        return _merge_settings(stored)

    def _sid(student) -> str:
        return _norm(getattr(student, "clean_id", "") or getattr(student, "student_id", ""))

    async def _class_roster(cls: dict) -> list[dict]:
        """Roster scoped to a class's ACTUAL enrolled students — never inferred
        from Telegram / Google. Resolves explicit roster ids first, else the
        class group."""
        ids = [_norm(x) for x in (cls.get("roster") or []) if x]
        query: dict = {}
        if ids:
            query = {"$or": [
                {"clean_id": {"$in": ids}},
                {"student_id": {"$in": ids}},
            ]}
        elif cls.get("group"):
            query = {"group": cls.get("group")}
        else:
            return []
        out = []
        cur = db.students.find(query, {"_id": 0, "student_id": 1, "clean_id": 1, "display_name": 1})
        async for s in cur:
            # ``student_id`` here is the human-facing clean_id used for ALL of
            # attendance's internal bookkeeping (records / streaks / roster
            # matching) — intentionally unchanged. ``wallet_student_id`` is the
            # internal UUID-style student_id assigned at signup (e.g.
            # "stu_a1b2c3d4e5f6"); it is the identity the points wallet/ledger
            # keys on, and is used ONLY at the wallet.credit() call site (§1),
            # never for attendance's own bookkeeping.
            out.append({
                "student_id": s.get("clean_id") or s.get("student_id"),
                "wallet_student_id": s.get("student_id") or s.get("clean_id"),
                "clean_id": s.get("clean_id") or s.get("student_id"),
                "display_name": s.get("display_name") or s.get("clean_id") or s.get("student_id"),
            })
        return out

    async def _all_rostered_students(class_id: str | None) -> list[dict]:
        """The population the monthly reward actually applies to — every
        student enrolled in the given class, or (unscoped) the union of every
        attendance-tracked class's roster, deduplicated by student_id. Never
        the raw students collection — an unenrolled account shouldn't count
        toward "students who qualify"."""
        if class_id:
            cls = await db[COLL_CLASSES].find_one({"class_id": class_id}, {"_id": 0})
            return await _class_roster(cls) if cls else []
        seen: dict[str, dict] = {}
        async for cls in db[COLL_CLASSES].find({}, {"_id": 0}):
            for s in await _class_roster(cls):
                seen.setdefault(s["student_id"], s)
        return list(seen.values())

    async def _record_id(session_id: str, sid: str) -> str:
        return f"{session_id}:{_norm(sid)}"

    async def _write_checkin(session: dict, sid: str, *, method: str,
                             attributed_via: str) -> dict:
        """Idempotently write/refresh an attendance_records row. Returns the
        record. Never raises on a benign duplicate."""
        now = _utcnow()
        settings = await _load_settings()
        opens_at = _parse_iso(session.get("opens_at"))
        grace_min = session.get("grace_minutes")
        if grace_min is None:
            grace_min = settings.get("late_grace_minutes", 10)
        grace_deadline = (opens_at + timedelta(minutes=int(grace_min))) if opens_at else None
        status = compute_checkin_status(now, opens_at, grace_deadline)
        rid = await _record_id(session["session_id"], sid)
        existing = await db[COLL_RECORDS].find_one({"_id": rid}, {"_id": 0})
        if existing and existing.get("checked_in_at"):
            return existing  # already checked in — idempotent
        doc = {
            "_id": rid,
            "student_id": _norm(sid),
            "session_id": session["session_id"],
            "class_id": session.get("class_id"),
            "status": status,
            "checkin_status": status,
            "checked_in_at": _iso(now),
            "mid_session_confirmed": False,
            "method": method,
            "attributed_via": attributed_via,
            "miss_reason": None,
            "finalized": False,
            "updated_at": _iso(now),
        }
        await db[COLL_RECORDS].update_one(
            {"_id": rid}, {"$set": doc}, upsert=True,
        )
        return doc

    # ── student: resolve a session by slug (no meet_url ever leaks here) ──
    async def _session_by_slug(slug: str) -> dict | None:
        return await db[COLL_SESSIONS].find_one({"join_slug": slug}, {"_id": 0})

    def _session_open(session: dict, now: datetime) -> bool:
        if session.get("status") == SESS_CLOSED:
            return False
        opens = _parse_iso(session.get("opens_at"))
        closes = _parse_iso(session.get("closes_at"))
        if opens and now < opens:
            return False
        if closes and now > closes:
            return False
        return True

    # ─────────────────────────────────────────────────────────────────────
    # STUDENT ROUTES
    # ─────────────────────────────────────────────────────────────────────

    # Convenience GET join link: redirects an authenticated student straight
    # into the Meet (best-effort check-in first). Degrades safely — if the
    # write fails the redirect to Meet still happens. Unidentified callers are
    # bounced to the in-app check-in page (picker + "not you?").
    if current_student is not None:
        @api.get("/attendance/join/{slug}")
        async def attendance_join(slug: str, student=Depends(current_student)):
            session = await _session_by_slug(slug)
            if not session or not session.get("meet_url"):
                # No safe Meet target — send to the in-app page to explain.
                return RedirectResponse(url=f"/attendance/j/{slug}", status_code=302)
            meet_url = session["meet_url"]
            if student is not None:
                try:
                    if _session_open(session, _utcnow()):
                        await _write_checkin(session, _sid(student),
                                             method="join_link",
                                             attributed_via="session_identity")
                except Exception as exc:  # noqa: BLE001 — never block class
                    log.warning("attendance: join check-in best-effort failed: %s", exc)
                return RedirectResponse(url=meet_url, status_code=302)
            # Not identified on this device → in-app picker page.
            return RedirectResponse(url=f"/attendance/j/{slug}", status_code=302)

    @api.get("/attendance/session/by-slug/{slug}")
    async def attendance_session_public(slug: str, student=Depends(require_student)):
        session = await _session_by_slug(slug)
        if not session:
            raise HTTPException(status_code=404, detail="session_not_found")
        cls = await db[COLL_CLASSES].find_one({"class_id": session.get("class_id")}, {"_id": 0})
        settings = await _load_settings()
        roster = await _class_roster(cls or {})
        sid = _sid(student)
        rid = await _record_id(session["session_id"], sid)
        rec = await db[COLL_RECORDS].find_one({"_id": rid}, {"_id": 0})
        # meet_url is NEVER returned to students here.
        return {
            "session_id": session["session_id"],
            "class_id": session.get("class_id"),
            "title_en": (cls or {}).get("title_en"),
            "title_kh": (cls or {}).get("title_kh"),
            "status": session.get("status"),
            "is_open": _session_open(session, _utcnow()),
            "opens_at": session.get("opens_at"),
            "closes_at": session.get("closes_at"),
            "already_checked_in": bool(rec and rec.get("checked_in_at")),
            "my_status": (rec or {}).get("status"),
            "shared_device_prompt_enabled": settings.get("shared_device_prompt_enabled", True),
            "roster": roster,
            "copy": settings.get("copy"),
        }

    @api.post("/attendance/checkin")
    async def attendance_checkin(payload: CheckInIn, student=Depends(require_student)):
        session = await _session_by_slug(payload.slug)
        if not session:
            raise HTTPException(status_code=404, detail="session_not_found")
        now = _utcnow()
        meet_url = session.get("meet_url") or ""
        is_open = _session_open(session, now)

        # Resolve attribution target. "not you?" re-attributes to a different
        # ENROLLED student (shared family device) — validated against the
        # class roster, never trusted blindly.
        target_sid = _sid(student)
        attributed_via = "session_identity"
        if payload.as_student_id:
            cls = await db[COLL_CLASSES].find_one({"class_id": session.get("class_id")}, {"_id": 0})
            roster_ids = {_norm(r["student_id"]) for r in await _class_roster(cls or {})}
            cand = _norm(payload.as_student_id)
            if cand not in roster_ids:
                raise HTTPException(status_code=400, detail="not_enrolled_in_class")
            target_sid = cand
            attributed_via = "shared_device_picker"

        record = None
        if is_open:
            try:
                record = await _write_checkin(
                    session, target_sid, method="checkin",
                    attributed_via=attributed_via,
                )
            except Exception as exc:  # noqa: BLE001 — tracking must never block class
                log.warning("attendance: checkin write failed (degrading): %s", exc)
                record = None
        else:
            log.info(
                "attendance: checkin outside open window — session=%s sid=%s "
                "status=%s opens=%s closes=%s now=%s",
                session.get("session_id"), target_sid, session.get("status"),
                session.get("opens_at"), session.get("closes_at"), _iso(now),
            )

        # Always surface the Meet URL so the student reaches class even if the
        # write failed (client retries, then "Join anyway").
        return {
            "ok": record is not None,
            "tracked": record is not None,
            "is_open": is_open,
            "status": (record or {}).get("status"),
            "session_id": session["session_id"],
            "student_id": target_sid,
            "attributed_via": attributed_via,
            "meet_url": meet_url,
        }

    @api.post("/attendance/mid-session-confirm")
    async def attendance_mid_confirm(payload: MidSessionIn, student=Depends(require_student)):
        rid = await _record_id(payload.session_id, _sid(student))
        res = await db[COLL_RECORDS].update_one(
            {"_id": rid, "checked_in_at": {"$ne": None}},
            {"$set": {"mid_session_confirmed": True, "updated_at": _utcnow_iso()}},
        )
        return {"ok": res.matched_count > 0}

    @api.post("/attendance/miss-reason")
    async def attendance_miss_reason(payload: MissReasonIn, student=Depends(require_student)):
        sid = _sid(student)
        rid = await _record_id(payload.session_id, sid)
        await db[COLL_RECORDS].update_one(
            {"_id": rid},
            {"$set": {"miss_reason": payload.reason, "updated_at": _utcnow_iso()},
             "$setOnInsert": {"student_id": sid, "session_id": payload.session_id,
                              "status": ST_ABSENT, "checked_in_at": None,
                              "mid_session_confirmed": False, "method": "miss_reason"}},
            upsert=True,
        )
        # A recently-logged absence reason suppresses the next at-risk nudge.
        await db[COLL_STREAKS].update_one(
            {"student_id": sid},
            {"$set": {"last_absence_reason_at": _utcnow_iso()},
             "$setOnInsert": {"student_id": sid}},
            upsert=True,
        )
        return {"ok": True, "reason": payload.reason}

    @api.get("/attendance/me")
    async def attendance_me(student=Depends(require_student)):
        sid = _sid(student)
        settings = await _load_settings()
        streak = await db[COLL_STREAKS].find_one({"student_id": sid}, {"_id": 0}) or {}
        cur = db[COLL_RECORDS].find(
            {"student_id": sid,
             "$or": [{"checked_in_at": {"$ne": None}}, {"finalized": True}]},
            {"_id": 0},
        ).sort("updated_at", -1).limit(90)
        records = [r async for r in cur]
        # Batch-load sessions and classes for enrichment.
        session_ids = list({r["session_id"] for r in records if r.get("session_id")})
        sessions_map: dict[str, dict] = {}
        if session_ids:
            scur = db[COLL_SESSIONS].find(
                {"session_id": {"$in": session_ids}},
                {"_id": 0, "session_id": 1, "date": 1, "opens_at": 1,
                 "class_id": 1, "grace_minutes": 1},
            )
            async for s in scur:
                sessions_map[s["session_id"]] = s
        class_ids = list({s["class_id"] for s in sessions_map.values() if s.get("class_id")})
        classes_map: dict[str, str] = {}
        if class_ids:
            ccur = db[COLL_CLASSES].find(
                {"class_id": {"$in": class_ids}},
                {"_id": 0, "class_id": 1, "title_en": 1, "title_kh": 1},
            )
            async for c in ccur:
                classes_map[c["class_id"]] = c
        grace_default = int(settings.get("late_grace_minutes") or 10)
        history = []
        for r in records:
            s = sessions_map.get(r.get("session_id") or "")
            cls = classes_map.get((s or {}).get("class_id") or "") or {}
            session_date = (
                (s or {}).get("date")
                or (s or {}).get("opens_at")
                or r.get("updated_at")
            )
            # Compute minutes_late for late check-ins.
            minutes_late = None
            if r.get("status") == ST_LATE and r.get("checked_in_at") and (s or {}).get("opens_at"):
                try:
                    opens = _parse_iso(s["opens_at"])
                    checkin = _parse_iso(r["checked_in_at"])
                    grace = int((s or {}).get("grace_minutes") or grace_default)
                    if opens and checkin:
                        diff = int((checkin - opens).total_seconds() / 60) - grace
                        if diff > 0:
                            minutes_late = diff
                except Exception:
                    pass
            history.append({
                "session_id": r.get("session_id"),
                "class_id": r.get("class_id"),
                "title_en": cls.get("title_en"),
                "title_kh": cls.get("title_kh"),
                "status": r.get("status"),
                "checked_in_at": r.get("checked_in_at"),
                "session_date": session_date,
                "session_start_at": (s or {}).get("opens_at"),
                "minutes_late": minutes_late,
                "mid_session_confirmed": r.get("mid_session_confirmed"),
                "miss_reason": r.get("miss_reason"),
                # v2-only field — absent/None on legacy records and whenever
                # v2 is off, since finalize_status() (the legacy path) never
                # writes it. Purely additive.
                "verification_status": r.get("verification_status"),
            })
        # Compute present/late/absent counts directly from history for the summary.
        present_count = sum(1 for h in history if h["status"] in (ST_PRESENT_FULL, ST_PRESENT_PARTIAL))
        late_count = sum(1 for h in history if h["status"] == ST_LATE)
        absent_count = sum(1 for h in history if h["status"] == ST_ABSENT)
        total_sessions = len(history)
        # risk_score is a PRIVATE teacher signal — never returned to the student.
        return {
            "student_id": sid,
            "display_name": getattr(student, "display_name", None),
            "current_streak": int(streak.get("current_streak") or 0),
            "longest_streak": int(streak.get("longest_streak") or 0),
            "reliability_tier": streak.get("reliability_tier") or TIER_BRONZE,
            "on_time_rate_rolling": streak.get("on_time_rate_rolling"),
            "attendance_rate": streak.get("attendance_rate"),
            "present_count": present_count,
            "late_count": late_count,
            "absent_count": absent_count,
            "total_sessions": total_sessions,
            "history": history,
        }

    @api.get("/attendance/live")
    async def attendance_live(student=Depends(require_student)):
        """Currently-open session for any class the student is enrolled in —
        powers the home-tile live state + in-app fallback Join Link."""
        sid = _sid(student)
        now = _utcnow()
        cur = db[COLL_SESSIONS].find({"status": SESS_OPEN}, {"_id": 0})
        async for session in cur:
            if not _session_open(session, now):
                continue
            cls = await db[COLL_CLASSES].find_one(
                {"class_id": session.get("class_id")}, {"_id": 0})
            roster_ids = {_norm(r["student_id"]) for r in await _class_roster(cls or {})}
            if sid in roster_ids:
                return {
                    "live": True,
                    "slug": session.get("join_slug"),
                    "session_id": session.get("session_id"),
                    "title_en": (cls or {}).get("title_en"),
                    "title_kh": (cls or {}).get("title_kh"),
                }
        return {"live": False}

    # ─────────────────────────────────────────────────────────────────────
    # STUDENT CLAIM ROUTES
    # ─────────────────────────────────────────────────────────────────────

    @api.get("/attendance/rewards/summary")
    async def attendance_rewards_summary(student=Depends(require_student)):
        """Return claimable reward state for the authenticated student.

        Never exposes risk_score, wallet IDs, or internal ledger references.
        """
        sid = _sid(student)
        settings = await _load_settings()
        claim_enabled = bool(settings.get("claim_rewards_enabled"))

        # Count pending claims for this student.
        pending_cursor = db[COLL_CLAIMS].find(
            {"student_id": sid, "status": "pending"},
            {"_id": 0, "points": 1, "source_session_id": 1, "created_at": 1},
        ).sort("created_at", -1)
        pending = [c async for c in pending_cursor]
        claimable_points = sum(c.get("points", 0) for c in pending)
        claimable_count = len(pending)

        # 5 most recent claimed rewards (confirmation history).
        recent_cursor = db[COLL_CLAIMS].find(
            {"student_id": sid, "status": "claimed"},
            {"_id": 0, "points": 1, "claimed_at": 1, "source_session_id": 1},
        ).sort("claimed_at", -1).limit(5)
        recent_claims = [c async for c in recent_cursor]

        # Progress toward next reward threshold (if configured).
        min_pts = int(settings.get("claim_minimum_points") or 0)
        next_reward_progress = None
        if min_pts > 0 and claimable_points < min_pts:
            next_reward_progress = {
                "current": claimable_points,
                "target": min_pts,
                "percent": round(claimable_points / min_pts * 100),
            }

        return {
            "claim_enabled": claim_enabled,
            "claimable_points": claimable_points,
            "claimable_count": claimable_count,
            "next_reward_progress": next_reward_progress,
            "recent_claims": recent_claims,
        }

    @api.post("/attendance/rewards/claim")
    async def attendance_rewards_claim(student=Depends(require_student)):
        """Atomically claim all pending attendance rewards for this student.

        Concurrency safety — reservation ownership token (claim_batch_id):
          Two simultaneous requests from the same student cannot process each
          other's records. The protocol is:

            pending
            → claiming with a unique claim_batch_id stamped by THIS request
            → fetch ONLY records owned by this request's claim_batch_id
            → wallet.credit() per claim (original idempotency_key, safe to retry)
            → claimed

          A second concurrent request's update_many finds nothing with
          status="pending" (all already "claiming") → modified_count=0 →
          returns no_pending_claims without touching any record.

          A process interruption mid-flight leaves records in "claiming" with
          a claim_batch_id. The student can retry: the next request sees
          modified_count=0 (still claiming), waits for the interrupted batch
          to be recovered, OR the recovery path explicitly reverts all
          records belonging to the interrupted batch back to "pending" so
          the retry can succeed (see error handling below).

        Other guarantees:
        - Student can only claim their own records (student_id scoped).
        - wallet.credit() uses the original idempotency_key → safe retry.
        - Partial failure: failed records revert to "pending", succeeded remain
          "claimed". No double-credit ever.
        - Push is sent AFTER wallet credit; push failure never rolls back credit.
        - risk_score is never included in any response field.
        """
        sid = _sid(student)
        settings = await _load_settings()

        if not settings.get("claim_rewards_enabled"):
            raise HTTPException(status_code=403, detail="claim_mode_not_enabled")

        min_pts = int(settings.get("claim_minimum_points") or 0)

        # Step 1 — Generate a unique ownership token for THIS request.
        # Concurrent requests each get a different batch_id; each can only
        # process the records it owns.
        claim_batch_id = secrets.token_hex(12)
        now_claim = _iso(_utcnow())

        # Atomically reserve pending records owned by this request only.
        # Any concurrent request that runs update_many AFTER this one will see
        # modified_count=0 (status is already "claiming", not "pending") and
        # return "no_pending_claims" immediately.
        reserve_result = await db[COLL_CLAIMS].update_many(
            {"student_id": sid, "status": "pending"},
            {"$set": {
                "status": "claiming",
                "claim_batch_id": claim_batch_id,
                "claiming_started_at": now_claim,
            }},
        )
        if reserve_result.modified_count == 0:
            return {"ok": True, "credited_points": 0, "claims_processed": 0,
                    "message": "no_pending_claims"}

        # Step 2 — Load ONLY the records this request reserved (own batch_id).
        # A concurrent request cannot see these records through claim_batch_id
        # scoping even if its own update_many partially interleaved.
        claiming_cursor = db[COLL_CLAIMS].find(
            {"student_id": sid, "status": "claiming", "claim_batch_id": claim_batch_id},
            {"_id": 0},
        )
        claiming = [c async for c in claiming_cursor]
        total_points = sum(c.get("points", 0) for c in claiming)

        if min_pts > 0 and total_points < min_pts:
            # Revert only THIS batch back to pending.
            await db[COLL_CLAIMS].update_many(
                {"student_id": sid, "status": "claiming",
                 "claim_batch_id": claim_batch_id},
                {"$set": {"status": "pending"},
                 "$unset": {"claim_batch_id": "", "claiming_started_at": ""}},
            )
            return {"ok": False, "credited_points": 0, "claims_processed": 0,
                    "message": "below_minimum", "minimum": min_pts,
                    "current": total_points}

        # Step 3 — Credit wallet once per claim this request owns.
        # Each claim carries its original idempotency_key from when it was
        # created in _do_close() — independent of claim_batch_id — so:
        #   • a retry after process interruption credits each claim exactly once
        #   • auto-credited sessions share the same key space and can never
        #     be re-paid through this path (wallet returns duplicate=True)
        credited_points = 0
        failed_idem_keys: list[str] = []
        if wallet is not None:
            for claim in claiming:
                idem_key = claim.get("idempotency_key") or (
                    f"attendance:{claim.get('source_session_id')}:{sid}")
                try:
                    result = await wallet.credit(
                        claim.get("wallet_student_id") or sid,
                        claim["points"],
                        source="attendance",
                        source_ref=claim.get("source_session_id"),
                        idempotency_key=idem_key,
                        clean_id=claim.get("clean_id"),
                    )
                    # Fresh credit OR idempotent duplicate both count as success.
                    if result.get("ok") or result.get("duplicate"):
                        credited_points += claim["points"]
                        now_str = _iso(_utcnow())
                        await db[COLL_CLAIMS].update_one(
                            {"idempotency_key": idem_key},
                            {"$set": {
                                "status": "claimed",
                                "claimed_at": now_str,
                                "wallet_transaction_id": result.get("transaction_id"),
                            },
                             "$unset": {"claim_batch_id": "",
                                        "claiming_started_at": ""}},
                        )
                    else:
                        failed_idem_keys.append(idem_key)
                except Exception as exc:  # noqa: BLE001
                    log.warning("attendance: claim wallet credit failed key=%s: %s",
                                idem_key, exc)
                    failed_idem_keys.append(idem_key)

        # Revert only THIS batch's failed records to pending.
        # Records from other batches (e.g. a concurrent request that partially
        # interleaved) are never touched.
        if failed_idem_keys:
            await db[COLL_CLAIMS].update_many(
                {"idempotency_key": {"$in": failed_idem_keys},
                 "claim_batch_id": claim_batch_id},
                {"$set": {"status": "pending"},
                 "$unset": {"claim_batch_id": "", "claiming_started_at": ""}},
            )

        # Step 4 — Push notification AFTER credit (failure here never rolls back).
        if credited_points > 0 and settings.get("reward_claimed_push_enabled", True):
            copy_block = (settings.get("copy") or {}).get("reward_claimed", {})
            raw_title = copy_block.get("title_en") or "Attendance reward"
            raw_title_kh = copy_block.get("title_kh") or "រង្វាន់វត្តមាន"
            raw_body = copy_block.get("body_en") or "+{points} points added to your account."
            raw_body_kh = copy_block.get("body_kh") or "ពិន្ទុ +{points} ត្រូវបានបញ្ចូលទៅគណនីរបស់អ្នក។"
            title = f"{raw_title} / {raw_title_kh}"
            body_en = raw_body.replace("{points}", str(credited_points))
            body_kh = raw_body_kh.replace("{points}", str(credited_points))
            body = f"{body_en} {body_kh}"
            try:
                if callable(fan_out_push) and callable(build_target_query):
                    query = build_target_query("students", [claim.get("clean_id") or sid
                                                            for claim in claiming], None)
                    await fan_out_push(query, title, body, "/attendance/me")
            except Exception as exc:  # noqa: BLE001
                log.warning("attendance: reward_claimed push failed: %s", exc)

        return {
            "ok": True,
            "credited_points": credited_points,
            "claims_processed": len(claiming) - len(failed_idem_keys),
            "failed_count": len(failed_idem_keys),
        }

    # ── v2: rollout status, monthly analytics, monthly reward claim ────────
    async def _student_monthly_statuses(sid: str, period: str, class_id: str | None) -> list[str]:
        sessions_q: dict = {"date": {"$regex": f"^{period}"}}
        if class_id:
            sessions_q["class_id"] = class_id
        session_ids = [
            s["session_id"]
            async for s in db[COLL_SESSIONS].find(sessions_q, {"_id": 0, "session_id": 1})
        ]
        if not session_ids:
            return []
        cur = db[COLL_RECORDS].find(
            {"session_id": {"$in": session_ids}, "student_id": sid},
            {"_id": 0, "status": 1},
        )
        return [r.get("status") async for r in cur if r.get("status")]

    @api.get("/attendance/v2-status")
    async def attendance_v2_status():
        """Unauthenticated, boolean-only — fail-closed status check the
        frontend uses to decide whether to render the v2 experience at all.
        Same {enabled} contract as this codebase's other feature-flagged
        status endpoints (e.g. getVideoLibraryCouponStatus)."""
        settings = await _load_settings()
        return {"enabled": _v2_active(settings)}

    @api.get("/attendance/monthly-summary")
    async def attendance_monthly_summary(
        month: str | None = None, class_id: str | None = None,
        student=Depends(require_student),
    ):
        settings = await _load_settings()
        if not _v2_active(settings):
            raise HTTPException(status_code=404, detail="not_available")
        sid = _sid(student)
        period = month or _utcnow().strftime("%Y-%m")
        statuses = await _student_monthly_statuses(sid, period, class_id)
        stats = compute_monthly_stats(statuses)
        threshold = float(settings.get("monthly_reward_threshold_pct") or 0.85)
        elig = compute_monthly_eligibility(stats, threshold)
        reward_enabled = bool(settings.get("monthly_reward_enabled"))

        # The reward's real name/points/status are ALWAYS live-fetched from
        # the attached Login Reward campaign — never a cached/copied value.
        campaign = await _fetch_reward_campaign(db, settings.get("monthly_reward_campaign_id")) \
            if reward_enabled else None
        already_claimed = False
        if reward_enabled:
            idem_key = f"attendance_monthly:{period}:{sid}"
            existing = await db[COLL_CLAIMS].find_one(
                {"idempotency_key": idem_key}, {"_id": 0, "status": 1})
            already_claimed = bool(existing and existing.get("status") == "claimed")

        can_claim = bool(
            reward_enabled and campaign and campaign["status"] == CAMP_LIVE
            and elig["met"] and not already_claimed
        )
        return {
            "period": period,
            "class_id": class_id,
            "stats": stats,
            "required_pct": elig["required_pct"],
            "eligible": elig["met"],
            "reward_enabled": reward_enabled,
            "reward_configured": campaign is not None,
            "reward_name": (campaign or {}).get("name"),
            "reward_points": (campaign or {}).get("points"),
            "reward_campaign_status": (campaign or {}).get("status"),
            "already_claimed": already_claimed,
            "can_claim": can_claim,
        }

    @api.get("/attendance/monthly-history")
    async def attendance_monthly_history(
        months: int = 6, class_id: str | None = None,
        student=Depends(require_student),
    ):
        """Past N months (current month first) of stats + eligibility — the
        Attendance History card's own data, kept separate from the recent
        per-session list. months is clamped to a sane range so a malformed
        client query can't force an unbounded scan."""
        settings = await _load_settings()
        if not _v2_active(settings):
            raise HTTPException(status_code=404, detail="not_available")
        sid = _sid(student)
        threshold = float(settings.get("monthly_reward_threshold_pct") or 0.85)
        current = _utcnow().strftime("%Y-%m")
        n = max(1, min(int(months), 12))
        out = []
        for back in range(n):
            period = _shift_period(current, back)
            statuses = await _student_monthly_statuses(sid, period, class_id)
            stats = compute_monthly_stats(statuses)
            elig = compute_monthly_eligibility(stats, threshold)
            out.append({
                "period": period,
                "stats": stats,
                "required_pct": elig["required_pct"],
                "eligible": elig["met"],
            })
        return {"months": out}

    @api.post("/attendance/rewards/monthly/claim")
    async def attendance_monthly_claim(payload: dict | None = None,
                                       student=Depends(require_student)):
        settings = await _load_settings()
        if not _v2_active(settings):
            raise HTTPException(status_code=404, detail="not_available")
        if not settings.get("monthly_reward_enabled"):
            raise HTTPException(status_code=403, detail="monthly_reward_disabled")
        sid = _sid(student)
        period = ((payload or {}).get("period") or "").strip() or _utcnow().strftime("%Y-%m")
        class_id = (payload or {}).get("class_id")

        idem_key = f"attendance_monthly:{period}:{sid}"
        existing = await db[COLL_CLAIMS].find_one({"idempotency_key": idem_key}, {"_id": 0})
        if existing and existing.get("status") == "claimed":
            return {
                "ok": True, "already_claimed": True,
                "points": existing.get("points", 0),
                "reward_name": existing.get("reward_name"),
            }

        # Re-verify eligibility fresh, server-side — the client's own summary
        # view is never trusted for the actual grant decision.
        statuses = await _student_monthly_statuses(sid, period, class_id)
        stats = compute_monthly_stats(statuses)
        threshold = float(settings.get("monthly_reward_threshold_pct") or 0.85)
        elig = compute_monthly_eligibility(stats, threshold)
        if not elig["met"]:
            raise HTTPException(status_code=403, detail="not_eligible")

        # Live-fetch the campaign fresh at claim time too — if the admin
        # changed the points/name (or disabled/expired it) since the
        # student last loaded the summary, THIS is the value that's
        # actually credited, never a stale client-held number.
        campaign = await _fetch_reward_campaign(db, settings.get("monthly_reward_campaign_id"))
        if not campaign:
            raise HTTPException(status_code=400, detail="no_reward_configured")
        if campaign["status"] != CAMP_LIVE:
            raise HTTPException(status_code=409, detail="reward_unavailable")
        points = campaign["points"]
        if points <= 0:
            raise HTTPException(status_code=400, detail="no_reward_configured")
        if wallet is None:
            raise HTTPException(status_code=503, detail="rewards_unavailable")

        student_doc = await db.students.find_one({"clean_id": sid}, {"_id": 0, "student_id": 1})
        wallet_sid = (student_doc or {}).get("student_id") or sid

        result = await wallet.credit(
            wallet_sid, points,
            source="attendance_monthly",
            source_ref=period,
            idempotency_key=idem_key,
            clean_id=sid,
        )
        await db[COLL_CLAIMS].update_one(
            {"idempotency_key": idem_key},
            {"$set": {
                "idempotency_key": idem_key,
                "student_id": sid,
                "wallet_student_id": wallet_sid,
                "clean_id": sid,
                "source_session_id": None,
                "source_period": period,
                "source_campaign_id": campaign["campaign_id"],
                "reward_name": campaign["name"],
                "points": points,
                "status": "claimed",
                "claimed_at": _utcnow_iso(),
                "wallet_transaction_id": result.get("transaction_id"),
            }},
            upsert=True,
        )

        # Congratulations push — fires ONLY here, after the credit above
        # actually succeeded, never at eligibility time (that's the separate
        # monthly_reward_ready push) and never on the already-claimed early
        # return above, so a retried/duplicate claim can never re-send it.
        # Reuses the SAME "reward_claimed" copy block + push flag the
        # legacy per-session claim flow already uses (§1265 above) rather
        # than inventing a second congratulations message.
        if settings.get("reward_claimed_push_enabled", True):
            copy_block = (settings.get("copy") or {}).get("reward_claimed", {})
            raw_title = copy_block.get("title_en") or "Attendance reward"
            raw_title_kh = copy_block.get("title_kh") or "រង្វាន់វត្តមាន"
            raw_body = copy_block.get("body_en") or "+{points} points added to your account."
            raw_body_kh = copy_block.get("body_kh") or "ពិន្ទុ +{points} ត្រូវបានបញ្ចូលទៅគណនីរបស់អ្នក។"
            title = f"{raw_title} / {raw_title_kh}"
            body = f"{raw_body.replace('{points}', str(points))} {raw_body_kh.replace('{points}', str(points))}"
            try:
                if callable(fan_out_push) and callable(build_target_query):
                    query = build_target_query("students", [sid], None)
                    await fan_out_push(query, title, body, "/attendance")
            except Exception as exc:  # noqa: BLE001
                log.warning("attendance: monthly reward_claimed push failed: %s", exc)

        return {"ok": True, "already_claimed": False, "points": points, "reward_name": campaign["name"]}

    # ─────────────────────────────────────────────────────────────────────
    # ADMIN ROUTES
    # ─────────────────────────────────────────────────────────────────────
    @api.get("/admin/attendance/settings")
    async def admin_get_settings(admin=Depends(require_admin)):
        return {"settings": await _load_settings()}

    @api.put("/admin/attendance/settings")
    async def admin_put_settings(payload: SettingsIn, admin=Depends(require_admin)):
        merged = _merge_settings(payload.settings)
        merged["_id"] = SETTINGS_ID
        merged["updated_at"] = _utcnow_iso()
        await db[COLL_SETTINGS].replace_one({"_id": SETTINGS_ID}, merged, upsert=True)
        return {"ok": True, "settings": merged}

    @api.get("/admin/attendance/classes")
    async def admin_list_classes(admin=Depends(require_admin)):
        cur = db[COLL_CLASSES].find({}, {"_id": 0}).sort("created_at", -1)
        return {"classes": [c async for c in cur]}

    @api.post("/admin/attendance/classes")
    async def admin_create_class(payload: ClassIn, admin=Depends(require_admin)):
        cid = "cls_" + secrets.token_hex(6)
        doc = {
            "class_id": cid,
            "title_en": payload.title_en.strip() or "Untitled class",
            "title_kh": payload.title_kh.strip(),
            "teacher": payload.teacher.strip(),
            "recurrence": payload.recurrence.strip(),
            "group": payload.group.strip(),
            "roster": [_norm(x) for x in payload.roster if x],
            "created_at": _utcnow_iso(),
        }
        await db[COLL_CLASSES].insert_one(doc)
        doc.pop("_id", None)
        return {"ok": True, "class": doc}

    @api.put("/admin/attendance/classes/{class_id}")
    async def admin_update_class(class_id: str, payload: ClassIn, admin=Depends(require_admin)):
        upd = {
            "title_en": payload.title_en.strip() or "Untitled class",
            "title_kh": payload.title_kh.strip(),
            "teacher": payload.teacher.strip(),
            "recurrence": payload.recurrence.strip(),
            "group": payload.group.strip(),
            "roster": [_norm(x) for x in payload.roster if x],
            "updated_at": _utcnow_iso(),
        }
        res = await db[COLL_CLASSES].update_one({"class_id": class_id}, {"$set": upd})
        if res.matched_count == 0:
            raise HTTPException(status_code=404, detail="class_not_found")
        return {"ok": True}

    @api.delete("/admin/attendance/classes/{class_id}")
    async def admin_delete_class(class_id: str, admin=Depends(require_admin)):
        await db[COLL_CLASSES].delete_one({"class_id": class_id})
        return {"ok": True}

    @api.get("/admin/attendance/sessions")
    async def admin_list_sessions(class_id: str | None = None, admin=Depends(require_admin)):
        q = {"class_id": class_id} if class_id else {}
        cur = db[COLL_SESSIONS].find(q, {"_id": 0}).sort("date", -1).limit(500)
        # meet_url IS returned to admins (teacher owns it); never to students.
        return {"sessions": [s async for s in cur]}

    @api.post("/admin/attendance/sessions")
    async def admin_create_session(payload: SessionIn, admin=Depends(require_admin)):
        cls = await db[COLL_CLASSES].find_one({"class_id": payload.class_id}, {"_id": 0})
        if not cls:
            raise HTTPException(status_code=404, detail="class_not_found")
        settings = await _load_settings()
        now = _utcnow()
        opens = _parse_iso(payload.opens_at) or now
        win = settings.get("checkin_window_minutes", 90)
        closes = _parse_iso(payload.closes_at) or (opens + timedelta(minutes=int(win)))
        sid = "ses_" + secrets.token_hex(6)
        slug = secrets.token_urlsafe(7)
        doc = {
            "session_id": sid,
            "class_id": payload.class_id,
            "date": (payload.date or opens.date().isoformat()),
            "meet_url": payload.meet_url.strip(),
            "join_slug": slug,
            "opens_at": _iso(opens),
            "closes_at": _iso(closes),
            "grace_minutes": (payload.grace_minutes if payload.grace_minutes is not None
                              else settings.get("late_grace_minutes", 10)),
            "mid_session_enabled": (payload.mid_session_enabled
                                    if payload.mid_session_enabled is not None
                                    else settings.get("mid_session_enabled", True)),
            "status": SESS_SCHEDULED,
            "created_at": _utcnow_iso(),
        }
        await db[COLL_SESSIONS].insert_one(doc)
        doc.pop("_id", None)
        return {"ok": True, "session": doc, "join_slug": slug}

    @api.put("/admin/attendance/sessions/{session_id}")
    async def admin_update_session(session_id: str, payload: SessionIn, admin=Depends(require_admin)):
        upd: dict = {"updated_at": _utcnow_iso()}
        if payload.meet_url is not None:
            upd["meet_url"] = payload.meet_url.strip()
        if payload.opens_at:
            upd["opens_at"] = _iso(_parse_iso(payload.opens_at))
        if payload.closes_at:
            upd["closes_at"] = _iso(_parse_iso(payload.closes_at))
        if payload.grace_minutes is not None:
            upd["grace_minutes"] = payload.grace_minutes
        if payload.mid_session_enabled is not None:
            upd["mid_session_enabled"] = payload.mid_session_enabled
        if payload.date:
            upd["date"] = payload.date
        res = await db[COLL_SESSIONS].update_one({"session_id": session_id}, {"$set": upd})
        if res.matched_count == 0:
            raise HTTPException(status_code=404, detail="session_not_found")
        return {"ok": True}

    @api.delete("/admin/attendance/sessions/{session_id}")
    async def admin_delete_session(session_id: str, admin=Depends(require_admin)):
        await db[COLL_SESSIONS].delete_one({"session_id": session_id})
        return {"ok": True}

    @api.get("/admin/attendance/sessions/{session_id}/qr")
    async def admin_session_qr(session_id: str, join_url: str, admin=Depends(require_admin)):
        """Renders a scannable QR of the session's join link. `join_url` is
        built client-side by AttendanceStudio.jsx using the SAME
        `${window.location.origin}/attendance/j/${slug}` logic
        copyJoinLink() already uses — the backend doesn't construct URLs for
        the frontend elsewhere in this module and shouldn't start guessing
        the deployed frontend's origin here. It's echoed back only to be
        encoded into a QR image; the mismatch check below ensures an admin's
        browser can't be tricked into rendering a QR for an unrelated URL
        through this session's own endpoint."""
        session = await db[COLL_SESSIONS].find_one({"session_id": session_id}, {"_id": 0})
        if not session:
            raise HTTPException(status_code=404, detail="session_not_found")
        if not session.get("join_slug") or session["join_slug"] not in join_url:
            raise HTTPException(status_code=400, detail="url_session_mismatch")
        return {"ok": True, "qr_png_data_uri": _render_session_qr(join_url)}

    async def _bilingual(copy_block: dict) -> tuple[str, str]:
        title = f"{copy_block.get('title_en','')} / {copy_block.get('title_kh','')}".strip(" /")
        body = f"{copy_block.get('body_en','')}\n{copy_block.get('body_kh','')}".strip()
        return title, body

    async def _push(target: str, ids: list[str], title: str, body: str, url: str) -> tuple[int, int]:
        if not callable(fan_out_push) or not callable(build_target_query):
            return 0, 0
        try:
            query = build_target_query(target, ids, None)
            return await fan_out_push(query, title, body, url)
        except Exception as exc:  # noqa: BLE001
            log.warning("attendance: push fan-out failed: %s", exc)
            return 0, 0

    async def _do_open(session: dict, now: datetime, settings: dict) -> int:
        """Open one session and fire live-now push. Returns push sent count."""
        session_id = session["session_id"]
        win = int(settings.get("checkin_window_minutes", 90))
        open_update: dict = {"status": SESS_OPEN, "opened_at": _iso(now)}
        closes_at = _parse_iso(session.get("closes_at"))
        if closes_at is None or closes_at <= now:
            open_update["opens_at"] = _iso(now)
            open_update["closes_at"] = _iso(now + timedelta(minutes=win))
            log.info("attendance: open %s — window reset to now+%dmin (was expires=%s)",
                     session_id, win, _iso(closes_at))
        await db[COLL_SESSIONS].update_one(
            {"session_id": session_id}, {"$set": open_update},
        )
        sent = 0
        if (settings.get("notifications") or {}).get("live_now_enabled"):
            cls = await db[COLL_CLASSES].find_one({"class_id": session.get("class_id")}, {"_id": 0})
            ids = [r["student_id"] for r in await _class_roster(cls or {})]
            title, body = await _bilingual((settings.get("copy") or {}).get("live_now", {}))
            sent, _ = await _push("students", ids, title, body,
                                  f"/attendance/j/{session.get('join_slug')}")
        return sent

    @api.post("/admin/attendance/sessions/{session_id}/open")
    async def admin_open_session(session_id: str, admin=Depends(require_admin)):
        session = await db[COLL_SESSIONS].find_one({"session_id": session_id}, {"_id": 0})
        if not session:
            raise HTTPException(status_code=404, detail="session_not_found")
        settings = await _load_settings()
        sent = await _do_open(session, _utcnow(), settings)
        return {"ok": True, "live_now_push_sent": sent}

    @api.post("/admin/attendance/sessions/{session_id}/closing-soon-nudge")
    async def admin_closing_soon(session_id: str, admin=Depends(require_admin)):
        session = await db[COLL_SESSIONS].find_one({"session_id": session_id}, {"_id": 0})
        if not session:
            raise HTTPException(status_code=404, detail="session_not_found")
        settings = await _load_settings()
        cls = await db[COLL_CLASSES].find_one({"class_id": session.get("class_id")}, {"_id": 0})
        roster = await _class_roster(cls or {})
        # only students with NO check-in yet
        checked = set()
        cur = db[COLL_RECORDS].find(
            {"session_id": session_id, "checked_in_at": {"$ne": None}},
            {"_id": 0, "student_id": 1})
        async for r in cur:
            checked.add(_norm(r.get("student_id")))
        pending = [r["student_id"] for r in roster if _norm(r["student_id"]) not in checked]
        title, body = await _bilingual((settings.get("copy") or {}).get("closing_soon", {}))
        sent, _ = await _push("session_pending_checkin", pending, title, body,
                              f"/attendance/j/{session.get('join_slug')}")
        # mark closing-soon sent TODAY for each pending student (guardrail input)
        today = _utcnow().date().isoformat()
        for pid in pending:
            await db[COLL_STREAKS].update_one(
                {"student_id": _norm(pid)},
                {"$set": {"closing_soon_last_date": today},
                 "$setOnInsert": {"student_id": _norm(pid)}},
                upsert=True,
            )
        return {"ok": True, "pending_count": len(pending), "sent": sent}

    async def _recompute_student(sid: str, settings: dict) -> dict:
        """Recompute streak + tier + risk score for one student from records."""
        sid = _norm(sid)
        cur = db[COLL_RECORDS].find({"student_id": sid}, {"_id": 0}).sort("checked_in_at", 1)
        rows = [r async for r in cur]
        # build dated statuses (use checked_in_at or session date proxy)
        dated = [((r.get("checked_in_at") or r.get("updated_at") or ""), r.get("status") or ST_ABSENT)
                 for r in rows]
        current, longest = compute_streak(dated)
        statuses = [r.get("status") or ST_ABSENT for r in rows]
        last5 = statuses[-5:]
        last15 = statuses[-15:]
        total = len(statuses)
        present = sum(1 for s in statuses if s in _PRESENT_STATES)
        on_time = sum(1 for s in statuses if s in (ST_PRESENT_FULL, ST_PRESENT_PARTIAL))
        attendance_rate = (present / total) if total else 1.0
        on_time_rate = (on_time / total) if total else 1.0
        # recent absences = trailing absents within last `miss_threshold*?`
        recent_absences = sum(1 for s in statuses[-15:] if s == ST_ABSENT)
        offered = sum(1 for r in rows if r.get("status") in (ST_PRESENT_FULL, ST_PRESENT_PARTIAL))
        skipped = sum(1 for r in rows if r.get("status") == ST_PRESENT_PARTIAL)
        signals = compute_signals(
            last5, last15, int(settings.get("miss_threshold") or 3),
            recent_absences, offered, skipped,
        )
        score = compute_risk_score(
            signals["on_time_rate_5"], signals["on_time_rate_15"],
            signals["miss_threshold_proximity"], signals["skipped_confirmation_rate"],
        )
        tier = compute_tier(attendance_rate, on_time_rate, settings.get("reward_tiers") or [])
        upd = {
            "student_id": sid,
            "current_streak": current,
            "longest_streak": longest,
            "reliability_tier": tier,
            "on_time_rate_rolling": round(on_time_rate, 4),
            "attendance_rate": round(attendance_rate, 4),
            "risk_score": score,
            "risk_band": risk_band(score, int(settings.get("escalation_threshold") or 70)),
            "signals": signals,
            "updated_at": _utcnow_iso(),
        }
        await db[COLL_STREAKS].update_one(
            {"student_id": sid}, {"$set": upd}, upsert=True,
        )
        return upd

    async def _do_close(session: dict, settings: dict) -> dict:
        """Core close logic — shared by HTTP route and heartbeat."""
        session_id = session["session_id"]
        mid_required = bool(session.get("mid_session_enabled", True)) and \
            bool((settings.get("notifications") or {}).get("mid_session_push_enabled", True))
        cls = await db[COLL_CLASSES].find_one({"class_id": session.get("class_id")}, {"_id": 0})
        roster = await _class_roster(cls or {})

        # 1) finalize every roster student's status.
        absentees: list[str] = []
        # Each entry is (roster_row, final_status). The whole roster row is kept
        # (not just its clean_id) so the reward-credit step (§1) can address the
        # wallet by the internal UUID student_id while every other bookkeeping
        # path keeps keying on clean_id.
        v2 = _v2_active(settings)
        present_students: list[tuple[dict, str]] = []
        for r in roster:
            sid = _norm(r["student_id"])
            rid = f"{session_id}:{sid}"
            rec = await db[COLL_RECORDS].find_one({"_id": rid}, {"_id": 0})
            checked = bool(rec and rec.get("checked_in_at"))
            confirmed = bool((rec or {}).get("mid_session_confirmed"))
            set_fields: dict = {
                "finalized": True, "updated_at": _utcnow_iso(),
                "student_id": sid, "session_id": session_id,
                "class_id": session.get("class_id"),
            }
            if v2:
                # v2: attendance_status is never downgraded by a missed
                # mid-session tap. verification_status carries that signal
                # separately and is purely informational.
                final = finalize_status_v2(checked, (rec or {}).get("checkin_status"))
                set_fields["status"] = final
                set_fields["verification_status"] = compute_verification_status(
                    checked, confirmed, mid_required,
                )
            else:
                # Legacy behavior — byte-for-byte unchanged when v2 is off.
                final = finalize_status(
                    checked, (rec or {}).get("checkin_status"), confirmed, mid_required,
                )
                set_fields["status"] = final
            await db[COLL_RECORDS].update_one(
                {"_id": rid},
                {"$set": set_fields,
                 "$setOnInsert": {"checked_in_at": (rec or {}).get("checked_in_at"),
                                  "mid_session_confirmed": confirmed}},
                upsert=True,
            )
            if final == ST_ABSENT:
                absentees.append(r["student_id"])
            else:
                present_students.append((r, final))

        await db[COLL_SESSIONS].update_one(
            {"session_id": session_id},
            {"$set": {"status": SESS_CLOSED, "closed_at": _utcnow_iso()}},
        )

        # 2) recompute streaks/tiers/risk per roster student.
        for r in roster:
            await _recompute_student(r["student_id"], settings)

        # 3) Reward processing for present students (tier multiplier).
        #
        # TWO modes controlled by settings["claim_rewards_enabled"]:
        #
        # AUTO mode (claim_rewards_enabled=False, the DEFAULT):
        #   Existing behaviour unchanged — wallet.credit() fires immediately on
        #   session close. Safe for all sessions credited before claim mode was
        #   ever activated.
        #
        # CLAIM mode (claim_rewards_enabled=True):
        #   Eligibility is calculated and stored as a PENDING claim in
        #   attendance_reward_claims. NO wallet credit happens yet. The student
        #   sees the pending balance and taps "Claim" when ready. Duplicate
        #   protection: each (session_id, student_id) pair has a unique
        #   idempotency_key; the claim record is created with $setOnInsert so
        #   re-running _do_close can never create two pending claims for the
        #   same session+student.
        #
        # Historical safety: sessions closed BEFORE claim_mode_activation_at
        # still use AUTO mode even when claim mode is now enabled, so previously
        # credited rewards can never be re-claimed.
        credited = 0
        pending_claims = 0
        base = int(settings.get("base_attendance_points") or 0)
        claim_mode = bool(settings.get("claim_rewards_enabled")) and base > 0
        activation_iso = settings.get("claim_mode_activation_at")
        now_close = _utcnow()
        # Determine whether claim mode applies to THIS session close.
        # Safe parsing rules:
        #   • activation_at absent/None → no restriction, claim mode applies.
        #   • activation_at valid ISO → claim mode only if now >= activation_at.
        #   • activation_at present but unparseable → block claim mode to
        #     prevent retroactive reward creation (safe fallback).
        if not activation_iso:
            # No activation restriction configured.
            use_claim_mode = claim_mode
        else:
            activation_dt = _parse_iso(activation_iso)
            if activation_dt is None:
                # Unparseable timestamp → refuse to activate (prevents retroactive
                # reward creation if someone sets a malformed value).
                use_claim_mode = False
                log.warning("attendance: claim_mode_activation_at is set but unparseable "
                            "(%r) — defaulting to auto-credit for session %s",
                            activation_iso, session_id)
            else:
                use_claim_mode = claim_mode and now_close >= activation_dt

        if base > 0:
            for roster_row, _final in present_students:
                clean_sid = roster_row["student_id"]
                wallet_sid = roster_row.get("wallet_student_id") or clean_sid
                streak = await db[COLL_STREAKS].find_one(
                    {"student_id": _norm(clean_sid)}, {"_id": 0}) or {}
                mult = tier_multiplier(streak.get("reliability_tier") or TIER_BRONZE,
                                       settings.get("reward_tiers") or [])
                amount = int(round(base * mult))
                if amount <= 0:
                    continue
                idem_key = f"attendance:{session_id}:{_norm(wallet_sid)}"
                if use_claim_mode:
                    # Store pending claim — no wallet credit yet.
                    try:
                        await db[COLL_CLAIMS].update_one(
                            {"idempotency_key": idem_key},
                            {"$setOnInsert": {
                                "idempotency_key": idem_key,
                                "student_id": _norm(clean_sid),
                                "wallet_student_id": wallet_sid,
                                "clean_id": clean_sid,
                                "source_session_id": session_id,
                                "points": amount,
                                "status": "pending",
                                "created_at": _iso(now_close),
                                "eligible_at": _iso(now_close),
                                "claimed_at": None,
                                "wallet_transaction_id": None,
                                "notification_sent": False,
                                "schema_version": 1,
                            }},
                            upsert=True,
                        )
                        pending_claims += 1
                    except Exception as exc:  # noqa: BLE001
                        log.warning("attendance: pending claim create failed sid=%s: %s",
                                    clean_sid, exc)
                else:
                    # AUTO mode: credit wallet immediately (existing behaviour).
                    if wallet is None:
                        continue
                    try:
                        await wallet.credit(
                            wallet_sid, amount,
                            source="attendance",
                            source_ref=session_id,
                            idempotency_key=idem_key,
                            clean_id=clean_sid,
                        )
                        credited += 1
                    except Exception as exc:  # noqa: BLE001
                        log.warning("attendance: reward credit failed sid=%s: %s", wallet_sid, exc)

        # Send reward-ready push when new pending claims were created.
        reward_ready_sent = 0
        if pending_claims > 0 and (settings.get("reward_ready_push_enabled", True)):
            ready_ids = [r["student_id"] for r, _ in present_students]
            title, body = await _bilingual(
                (settings.get("copy") or {}).get("reward_ready", {}))
            reward_ready_sent, _ = await _push(
                "students", ready_ids, title, body, "/attendance")

        # 4) miss follow-up push to absentees (non-punitive, with reason picker).
        miss_sent = 0
        if absentees:
            title, body = await _bilingual((settings.get("copy") or {}).get("miss_followup", {}))
            miss_sent, _ = await _push("students", absentees, title, body, "/attendance/me")

        # 5) consecutive absence escalation — fire for students who have hit
        #    N absences in a row (default 2). Separate from at-risk nudge.
        esc_threshold = int(settings.get("consecutive_absence_threshold") or 2)
        escalation_targets: list[str] = []
        for sid in absentees:
            n_sid = _norm(sid)
            recent = [r async for r in db[COLL_RECORDS].find(
                {"student_id": n_sid, "finalized": True},
                {"_id": 0, "status": 1},
            ).sort("updated_at", -1).limit(esc_threshold)]
            if len(recent) >= esc_threshold and all(
                r.get("status") == ST_ABSENT for r in recent
            ):
                escalation_targets.append(sid)
        esc_sent = 0
        if escalation_targets:
            title, body = await _bilingual(
                (settings.get("copy") or {}).get("miss_escalation", {}))
            esc_sent, _ = await _push(
                "students", escalation_targets, title, body, "/attendance/me")
            log.info("attendance: escalation push → %d students (session=%s)",
                     esc_sent, session_id)

        # 6) auto at-risk nudge — fires automatically on close for students
        #    whose risk score just crossed the threshold (7-day guardrail applies).
        atrisk_sent = 0
        if (settings.get("notifications") or {}).get("predictive_at_risk_enabled"):
            threshold = int(settings.get("escalation_threshold") or 70)
            now = _utcnow()
            today = now.date().isoformat()
            for r in roster:
                sid = _norm(r["student_id"])
                st = await db[COLL_STREAKS].find_one({"student_id": sid}, {"_id": 0}) or {}
                if (st.get("risk_score") or 0) >= threshold:
                    allowed = nudge_guardrail_allows(
                        now,
                        _parse_iso(st.get("last_at_risk_nudge_at")),
                        (st.get("closing_soon_last_date") == today),
                        _parse_iso(st.get("last_absence_reason_at")),
                    )
                    if allowed:
                        title, body = await _bilingual(
                            (settings.get("copy") or {}).get("at_risk", {}))
                        sent, _ = await _push(
                            "at_risk_score", [r["student_id"]], title, body, "/attendance/me")
                        atrisk_sent += sent
                        await db[COLL_STREAKS].update_one(
                            {"student_id": sid},
                            {"$set": {"last_at_risk_nudge_at": _utcnow_iso()}},
                        )

        # 7) Monthly goal-reached / monthly-reward-ready pushes. Distinct from
        # the per-session "reward_ready" push above (§3, the legacy
        # base_attendance_points claim flow) — this is about the MONTHLY
        # Login-Rewards-campaign-backed reward from Phase 7/8. Event-driven
        # like every other push in this function: it only re-evaluates a
        # roster student's monthly eligibility at session-close time, using
        # the SAME compute_monthly_stats/compute_monthly_eligibility pair
        # the student-facing summary/claim routes use — never a separate
        # estimate. Each of the two events is deduped once per student per
        # month via its own stored period-stamp (so re-closing a session, or
        # a later session closing after the goal was already reached, never
        # re-sends); they're tracked separately so attaching a campaign
        # AFTER a student already got the goal-reached push still lets the
        # separate reward-ready push fire on that student's next close.
        goal_sent = 0
        monthly_reward_ready_sent = 0
        if v2 and settings.get("monthly_reward_enabled"):
            period = _utcnow().strftime("%Y-%m")
            threshold = float(settings.get("monthly_reward_threshold_pct") or 0.85)
            campaign = await _fetch_reward_campaign(db, settings.get("monthly_reward_campaign_id"))
            goal_ids: list[str] = []
            ready_ids: list[str] = []
            for r in roster:
                sid = _norm(r["student_id"])
                streak = await db[COLL_STREAKS].find_one({"student_id": sid}, {"_id": 0}) or {}
                already_goal = streak.get("goal_reached_notified_period") == period
                already_reward = streak.get("reward_ready_notified_period") == period
                if already_goal and already_reward:
                    continue
                statuses = await _student_monthly_statuses(sid, period, None)
                elig = compute_monthly_eligibility(compute_monthly_stats(statuses), threshold)
                if not elig["met"]:
                    continue
                updates: dict = {}
                if not already_goal:
                    goal_ids.append(r["student_id"])
                    updates["goal_reached_notified_period"] = period
                if not already_reward and campaign and campaign["status"] == CAMP_LIVE:
                    ready_ids.append(r["student_id"])
                    updates["reward_ready_notified_period"] = period
                if updates:
                    await db[COLL_STREAKS].update_one(
                        {"student_id": sid},
                        {"$set": updates, "$setOnInsert": {"student_id": sid}},
                        upsert=True,
                    )
            if goal_ids:
                title, body = await _bilingual((settings.get("copy") or {}).get("monthly_goal_reached", {}))
                goal_sent, _ = await _push("students", goal_ids, title, body, "/attendance")
            if ready_ids:
                title, body = await _bilingual((settings.get("copy") or {}).get("monthly_reward_ready", {}))
                monthly_reward_ready_sent, _ = await _push("students", ready_ids, title, body, "/attendance")

        return {
            "ok": True,
            "present_count": len(present_students),
            "absent_count": len(absentees),
            "rewards_credited": credited,
            "miss_followup_sent": miss_sent,
            "escalation_sent": esc_sent,
            "at_risk_auto_sent": atrisk_sent,
            "goal_reached_sent": goal_sent,
            "monthly_reward_ready_sent": monthly_reward_ready_sent,
        }

    @api.post("/admin/attendance/sessions/{session_id}/close")
    async def admin_close_session(session_id: str, admin=Depends(require_admin)):
        session = await db[COLL_SESSIONS].find_one({"session_id": session_id}, {"_id": 0})
        if not session:
            raise HTTPException(status_code=404, detail="session_not_found")
        settings = await _load_settings()
        return await _do_close(session, settings)

    @api.post("/admin/attendance/at-risk-nudge")
    async def admin_at_risk_nudge(admin=Depends(require_admin)):
        """Fire predictive at-risk nudges, enforcing the guardrails."""
        settings = await _load_settings()
        if not (settings.get("notifications") or {}).get("predictive_at_risk_enabled"):
            return {"ok": True, "sent": 0, "reason": "disabled"}
        threshold = int(settings.get("escalation_threshold") or 70)
        now = _utcnow()
        today = now.date().isoformat()
        targets: list[str] = []
        cur = db[COLL_STREAKS].find({"risk_score": {"$gte": threshold}}, {"_id": 0})
        async for st in cur:
            sid = st.get("student_id")
            allowed = nudge_guardrail_allows(
                now,
                _parse_iso(st.get("last_at_risk_nudge_at")),
                (st.get("closing_soon_last_date") == today),
                _parse_iso(st.get("last_absence_reason_at")),
            )
            if allowed:
                targets.append(sid)
        sent = 0
        if targets:
            title, body = await _bilingual((settings.get("copy") or {}).get("at_risk", {}))
            sent, _ = await _push("at_risk_score", targets, title, body, "/attendance/me")
            for sid in targets:
                await db[COLL_STREAKS].update_one(
                    {"student_id": _norm(sid)},
                    {"$set": {"last_at_risk_nudge_at": _utcnow_iso()}},
                )
        return {"ok": True, "sent": sent, "candidates": len(targets)}

    @api.get("/admin/attendance/at-risk")
    async def admin_at_risk_list(admin=Depends(require_admin)):
        """Private teacher flag — students at/above the escalation threshold.
        Never a public list of any kind."""
        settings = await _load_settings()
        threshold = int(settings.get("escalation_threshold") or 70)
        cur = db[COLL_STREAKS].find({"risk_score": {"$gte": threshold}}, {"_id": 0}).sort("risk_score", -1)
        rows = [s async for s in cur]
        return {"threshold": threshold, "flag": "needs_encouragement_now", "students": rows}

    @api.get("/admin/attendance/report")
    async def admin_report(month: str | None = None, class_id: str | None = None,
                           admin=Depends(require_admin)):
        """Live monthly report — computed from attendance_records, never stored."""
        q: dict = {}
        if class_id:
            q["class_id"] = class_id
        # month filter on session date YYYY-MM
        sessions_q = dict(q)
        if month:
            sessions_q["date"] = {"$regex": f"^{month}"}
        scur = db[COLL_SESSIONS].find(sessions_q, {"_id": 0})
        session_ids = []
        by_date: dict[str, dict] = {}
        async for s in scur:
            session_ids.append(s["session_id"])
            d = s.get("date") or ""
            by_date.setdefault(d, {"date": d, "present": 0, "late": 0, "absent": 0, "partial": 0})
        if not session_ids:
            return {"month": month, "class_id": class_id, "per_student": [],
                    "per_class": {}, "by_date": [], "sessions": 0}
        rcur = db[COLL_RECORDS].find({"session_id": {"$in": session_ids}}, {"_id": 0})
        per_student: dict[str, dict] = {}
        totals = {"present_full": 0, "present_partial": 0, "late": 0, "absent": 0}
        records = [r async for r in rcur]
        # map session -> date
        sdmap = {}
        async for s in db[COLL_SESSIONS].find({"session_id": {"$in": session_ids}}, {"_id": 0}):
            sdmap[s["session_id"]] = s.get("date")
        for r in records:
            sid = r.get("student_id")
            status = r.get("status") or ST_ABSENT
            ps = per_student.setdefault(sid, {"student_id": sid, "present_full": 0,
                                               "present_partial": 0, "late": 0, "absent": 0})
            if status in ps:
                ps[status] += 1
            if status in totals:
                totals[status] += 1
            d = sdmap.get(r.get("session_id")) or ""
            bd = by_date.setdefault(d, {"date": d, "present": 0, "late": 0, "absent": 0, "partial": 0})
            if status == ST_PRESENT_FULL:
                bd["present"] += 1
            elif status == ST_PRESENT_PARTIAL:
                bd["partial"] += 1
            elif status == ST_LATE:
                bd["late"] += 1
            elif status == ST_ABSENT:
                bd["absent"] += 1
        # finalize per-student rates + tier/streak
        out_students = []
        for sid, ps in per_student.items():
            attended = ps["present_full"] + ps["present_partial"] + ps["late"]
            total = attended + ps["absent"]
            on_time = ps["present_full"] + ps["present_partial"]
            streak = await db[COLL_STREAKS].find_one({"student_id": sid}, {"_id": 0}) or {}
            out_students.append({
                **ps,
                "sessions": total,
                "attendance_pct": round(100 * attended / total, 1) if total else 0.0,
                "on_time_pct": round(100 * on_time / total, 1) if total else 0.0,
                "current_streak": int(streak.get("current_streak") or 0),
                "reliability_tier": streak.get("reliability_tier") or TIER_BRONZE,
                "risk_score": streak.get("risk_score"),
            })
        out_students.sort(key=lambda x: x["student_id"])
        return {
            "month": month,
            "class_id": class_id,
            "sessions": len(session_ids),
            "per_class": totals,
            "per_student": out_students,
            "by_date": sorted(by_date.values(), key=lambda x: x["date"]),
        }

    @api.get("/admin/attendance/monthly-reward/preview")
    async def admin_monthly_reward_preview(
        threshold_pct: float, month: str | None = None, class_id: str | None = None,
        admin=Depends(require_admin),
    ):
        """Live "N/M students currently qualify" preview for the Settings
        threshold slider — recomputed server-side from the SAME
        compute_monthly_stats/compute_monthly_eligibility pair the real
        per-student summary and claim routes use, never a separate estimate.
        Read-only; never called from the student-facing routes."""
        period = month or _utcnow().strftime("%Y-%m")
        roster = await _all_rostered_students(class_id)
        qualifying = 0
        for s in roster:
            statuses = await _student_monthly_statuses(s["student_id"], period, class_id)
            stats = compute_monthly_stats(statuses)
            if compute_monthly_eligibility(stats, threshold_pct)["met"]:
                qualifying += 1
        return {"period": period, "class_id": class_id, "qualifying": qualifying, "total": len(roster)}

    @api.get("/admin/attendance/sessions/{session_id}/roster")
    async def admin_session_roster(session_id: str, admin=Depends(require_admin)):
        """Real-time per-student roster for ONE session — name, check-in
        time, status — cross-joining the session's class roster against
        attendance_records. Distinct from admin_report(), which aggregates
        across a whole month and never carries display names or check-in
        times. A roster student with no record yet is "pending" while the
        session is still open, else "absent" — never invented as anything
        else."""
        session = await db[COLL_SESSIONS].find_one({"session_id": session_id}, {"_id": 0})
        if not session:
            raise HTTPException(status_code=404, detail="session_not_found")
        cls = await db[COLL_CLASSES].find_one({"class_id": session.get("class_id")}, {"_id": 0})
        roster = await _class_roster(cls) if cls else []
        records = {
            r["student_id"]: r
            async for r in db[COLL_RECORDS].find({"session_id": session_id}, {"_id": 0})
        }
        is_open = session.get("status") == SESS_OPEN
        rows = []
        for s in roster:
            rec = records.get(s["student_id"])
            if rec:
                status = rec.get("status") or ST_ABSENT
                checked_in_at = rec.get("checked_in_at")
            else:
                status = "pending" if is_open else ST_ABSENT
                checked_in_at = None
            rows.append({
                "student_id": s["student_id"],
                "display_name": s["display_name"],
                "status": status,
                "checked_in_at": checked_in_at,
            })
        rows.sort(key=lambda r: r["display_name"].lower())
        present = sum(1 for r in rows if r["status"] in (ST_PRESENT_FULL, ST_PRESENT_PARTIAL))
        late = sum(1 for r in rows if r["status"] == ST_LATE)
        checked_in = sum(1 for r in rows if r["status"] not in ("pending", ST_ABSENT))
        return {
            "session_id": session_id,
            "class_id": session.get("class_id"),
            "status": session.get("status"),
            "roster": rows,
            "total": len(rows),
            "checked_in": checked_in,
            "present": present,
            "late": late,
            "absent": sum(1 for r in rows if r["status"] == ST_ABSENT),
        }

    # ── Heartbeat — auto open/close sessions so teacher can focus on teaching ──

    async def _heartbeat_tick() -> None:
        now = _utcnow()
        settings = await _load_settings()
        notif = settings.get("notifications") or {}

        # Auto-open: scheduled sessions whose window has started.
        if notif.get("auto_open_enabled", True):
            to_open = [s async for s in db[COLL_SESSIONS].find(
                {"status": SESS_SCHEDULED,
                 "opens_at": {"$lte": _iso(now)},
                 "closes_at": {"$gt": _iso(now)}},
                {"_id": 0},
            )]
            for session in to_open:
                try:
                    await _do_open(session, now, settings)
                    log.info("attendance: auto-opened session %s", session["session_id"])
                except Exception as exc:  # noqa: BLE001
                    log.warning("attendance: auto-open %s failed: %s",
                                session.get("session_id"), exc)

        # Auto-close: open sessions whose window has expired.
        if notif.get("auto_close_enabled", True):
            to_close = [s async for s in db[COLL_SESSIONS].find(
                {"status": SESS_OPEN,
                 "closes_at": {"$lte": _iso(now)}},
                {"_id": 0},
            )]
            for session in to_close:
                try:
                    result = await _do_close(session, settings)
                    log.info("attendance: auto-closed session %s — %s",
                             session["session_id"], result)
                except Exception as exc:  # noqa: BLE001
                    log.warning("attendance: auto-close %s failed: %s",
                                session.get("session_id"), exc)

    async def _run_heartbeat() -> None:
        interval = 120  # seconds — checks every 2 min, well within the 1-min session granularity
        log.info("attendance: heartbeat started (interval=%ds)", interval)
        while True:
            try:
                await _heartbeat_tick()
            except Exception as exc:  # noqa: BLE001
                log.exception("attendance: heartbeat tick error: %s", exc)
            await asyncio.sleep(interval)

    def start_heartbeat() -> None:
        """Schedule the auto open/close heartbeat as an asyncio background task."""
        asyncio.create_task(_run_heartbeat(), name="attendance_heartbeat")
        log.info("attendance: heartbeat task scheduled")

    log.info("attendance: routes registered (Constellation Check-In).")
    return start_heartbeat
