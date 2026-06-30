"""edutalk_live_tools.py — EduTalk Live Coach (admin: "Live Voice Coach Beta").

A NEW, fully isolated, additive feature that adds a real-time voice-to-voice
AI speaking coach to EduHub, powered by the Gemini Live API.

Student-facing brand : "EduTalk Live Coach"
Admin-facing brand   : "Live Voice Coach Beta"

This module is deliberately self-contained. It is registered onto the existing
``/api`` router by ``register_edutalk_live_routes(api, db, require_admin,
require_student)`` from server.py (one additive call). It NEVER imports or
mutates:

  * the existing EduTalk text/audio assistant (edutalk_tools.py)
  * the EduTalk audio replay / cache / entitlement logic
  * book narration audio
  * payment / wallet top-up / ABA / KHQR / CamRapidPay
  * Author Studio auth

Points safety
-------------
The Live Coach uses an isolated *reservation / finalization* model built ONLY
on top of the same read-only GAS points helpers EduTalk already uses
(``_gas_get_balance`` / ``_gas_debit`` from premium_ai_tools.py). Points are:

  1. RESERVED (debited) atomically when a session starts.
  2. REFUNDED automatically if the live connection never produced a useful
     interaction (failed / cancelled-early).
  3. FINALIZED (kept) when the session completed normally.

Every charge / refund is idempotent (guarded by a per-session flag + an
atomic Mongo ``find_one_and_update``) so a student can NEVER be double
charged and a refund can NEVER fire twice.

Architecture
------------
Student mic → frontend WS → THIS backend WS → Gemini Live API → back.
The Gemini API key stays backend-only (env ``GEMINI_API_KEY``). The frontend
only ever talks to the EduHub backend WebSocket.

Collections (all new, prefixed ``edutalk_live_*``):
  * edutalk_live_config       (singleton admin config, _id="singleton")
  * edutalk_live_sessions     (one doc per session, holds state machine)
  * edutalk_live_reports      (one doc per saved report)
  * edutalk_live_usage_logs   (append-only audit log)
"""

from __future__ import annotations

import asyncio
import base64
import json
import logging
import os
import secrets
import time
import unicodedata
from datetime import datetime, timedelta, timezone
from typing import Any, Optional

import httpx
from fastapi import Depends, HTTPException, WebSocket, WebSocketDisconnect
from pydantic import BaseModel, ConfigDict, Field, field_validator

log = logging.getLogger("eduhub.edutalk_live")

# --------------------------------------------------------------------------- #
# Optional reward module integration (Phase 1 SURPRISE REWARDS).              #
# Imported lazily and safely — if the module is missing the Live Coach        #
# bridge degrades to its previous behaviour with NO reward hooks running.     #
# --------------------------------------------------------------------------- #
try:
    import edutalk_coach_reward_tools as _reward_mod  # type: ignore
    _REWARD_MOD_OK = True
except Exception:  # pragma: no cover
    _reward_mod = None  # type: ignore[assignment]
    _REWARD_MOD_OK = False

# --------------------------------------------------------------------------- #
# Environment (backend-only secrets)                                          #
# --------------------------------------------------------------------------- #
GEMINI_API_KEY = os.environ.get("GEMINI_API_KEY", "")
# Live API model — defaults to Gemini 3.1 Flash Live (current low-latency
# audio-to-audio Live model). Override with GEMINI_LIVE_MODEL without touching
# code when Google rotates model names.
GEMINI_LIVE_MODEL = os.environ.get(
    "GEMINI_LIVE_MODEL", "gemini-3.1-flash-live-preview"
)
# Voice used for Gemini Live audio output. Without an explicit voice the
# model silently falls back to text; this env var makes it overridable.
# Valid names: Puck, Charon, Kore, Fenrir, Aoede (see Gemini Live API docs).
GEMINI_LIVE_VOICE = os.environ.get("GEMINI_LIVE_VOICE", "Puck")
# Text model used ONLY for generating the post-session speaking report.
GEMINI_REPORT_MODEL = os.environ.get("GEMINI_MODEL", "gemini-2.5-flash")

# Points / treasury — the SAME officially-supported GAS sendPoints path the
# rest of the app uses. Reservation = student → treasury (debit). Refund =
# treasury → student (credit). NO negative debit, NO stored student password.
GAS_POINTS_LOGIN_URL = os.environ.get(
    "GAS_POINTS_LOGIN_URL",
    "https://script.google.com/macros/s/AKfycbzRktKyql2I_FbPESNRpCrFDlse-qNd9_Opv9si-g-j2lcanOUPP49IzcyA59lFqVycdA/exec",
)
SL_TREASURY_ID = os.environ.get("SL_TREASURY_ID", "stu092")
SL_TREASURY_PASSWORD = os.environ.get("SL_TREASURY_PASSWORD", "")

_GEMINI_LIVE_HOST = "generativelanguage.googleapis.com"
_GEMINI_LIVE_PATH = (
    "/ws/google.ai.generativelanguage.v1beta.GenerativeService."
    "BidiGenerateContent"
)

# Real-time audio formats mandated by the Live API docs.
_INPUT_AUDIO_MIME = "audio/pcm;rate=16000"   # student mic → Gemini (16 kHz)
# Gemini returns 24 kHz PCM; the frontend plays it back at 24 kHz.

# --------------------------------------------------------------------------- #
# Optional dependency: `websockets` (backend → Gemini bridge).                #
# uvicorn[standard] already ships it; if absent the feature degrades to       #
# "live_unavailable" WITHOUT crashing anything else in the app.               #
# --------------------------------------------------------------------------- #
try:
    import websockets as _ws_lib  # type: ignore
    _WS_LIB_OK = True
except Exception:  # pragma: no cover
    _ws_lib = None  # type: ignore
    _WS_LIB_OK = False

# --------------------------------------------------------------------------- #
# Read-only reuse of the SAME GAS points helpers EduTalk already uses.        #
# These are pure async HTTP wrappers around the GAS PointsBackend — importing #
# them runs no side-effects. If the import fails the feature degrades safely. #
# --------------------------------------------------------------------------- #
try:
    from premium_ai_tools import (  # type: ignore[import-not-found]
        _gas_debit as _gas_debit,
        _gas_get_balance as _gas_get_balance,
        _post_gemini as _post_gemini,
    )
    _POINTS_HELPERS_OK = True
except Exception:  # pragma: no cover
    _gas_debit = None  # type: ignore[assignment]
    _gas_get_balance = None  # type: ignore[assignment]
    _post_gemini = None  # type: ignore[assignment]
    _POINTS_HELPERS_OK = False


# --------------------------------------------------------------------------- #
# Time helpers                                                                #
# --------------------------------------------------------------------------- #
def _now() -> datetime:
    return datetime.now(timezone.utc)


def _iso(dt: datetime | None = None) -> str:
    return (dt or _now()).isoformat()


def _today_key() -> str:
    return _now().strftime("%Y-%m-%d")


# --------------------------------------------------------------------------- #
# Canonical end-reason → outcome mapper.                                       #
# SHARED by BOTH the WebSocket bridge and the REST /session/end fallback so    #
# finalization is always consistent. An unknown reason NEVER defaults to       #
# "completed" — it is treated as "cancelled" (which still honours the          #
# min_useful_seconds refund rule).                                             #
# --------------------------------------------------------------------------- #
_COMPLETED_REASONS = {
    "client_end", "time_up", "normal", "complete", "completed", "finish",
}
_FAILED_REASONS = {
    "mic_failed", "mic_denied", "bridge_error", "live_unavailable",
    "gemini_setup_failed", "mic_error",
}
_CANCELLED_REASONS = {
    "client_cancel", "early_cancel", "user_cancel", "ws_close",
    "ws_disconnect", "ws_error", "gemini_closed",
}


def _map_end_reason(reason: str) -> str:
    """Map a raw end reason to a finalization outcome
    (one of "completed" | "cancelled" | "failed"). Prefix-tolerant so
    "bridge_error:TimeoutError" still maps to "failed"."""
    r = (reason or "").strip()
    base = r.split(":", 1)[0]
    if base in _FAILED_REASONS:
        return "failed"
    if base in _CANCELLED_REASONS:
        return "cancelled"
    if base in _COMPLETED_REASONS:
        return "completed"
    # Unknown reason must NOT be treated as a clean completion.
    return "cancelled"


# --------------------------------------------------------------------------- #
# Default admin config                                                        #
# --------------------------------------------------------------------------- #
VALID_TIERS = ("free", "standard", "premium", "limited")

DEFAULT_CONFIG: dict[str, Any] = {
    "enabled": False,
    "beta_enabled": True,
    "free_trial_seconds": 60,
    "free_trial_sessions": 1,
    "daily_session_limit": 3,
    "max_session_seconds": 300,
    "default_language_mode": "english_with_khmer_support",
    "save_transcript": True,
    "save_audio": False,           # raw audio OFF by default
    "save_report": True,
    "student_can_view_report": True,
    "teacher_can_view_reports": True,
    # Minimum seconds of useful interaction before a completed session keeps
    # its charge. Below this, an early-ended session is auto-refunded.
    "min_useful_seconds": 20,
    # ── Phase 1 Smart Top-Up Nudge (additive; default OFF) ──────────────────
    # With topup_nudge_enabled false this feature produces ZERO visible /
    # behavioural change. threshold = the post-reservation / settled balance
    # at or below which a (non-numeric) nudge is authorized; max_per_week =
    # per student, across all their sessions, rolling 7 days.
    "topup_nudge_enabled": False,
    "topup_nudge_threshold": 15,
    "topup_nudge_max_per_week": 3,
    # ── Phase 1 Teacher Daravuth persona (additive; DARK by default) ─────────
    # The master gate `teacher_persona_enabled` defaults False → ZERO behaviour
    # change. When false, neither the system-instruction block nor any greeting
    # mention is produced; the name/mention values are retained but inert.
    "teacher_persona_enabled": False,
    "teacher_display_name": "Teacher Daravuth",
    "mention_teacher_in_greeting": True,
    "teacher_method": "friendly_beginner",
    "correction_style": "finish_then_correct",
    "focus_areas": ["pronunciation", "confidence", "natural_flow"],
    "modes": {
        "book_shadow": {
            "enabled": True,
            "label": "Book Shadow Coach",
            "cost_points": 15,
            "duration_seconds": 240,
        },
        "pronunciation_dna": {
            "enabled": True,
            "label": "Pronunciation DNA Coach",
            "cost_points": 10,
            "duration_seconds": 180,
        },
        "confidence_ladder": {
            "enabled": True,
            "label": "Confidence Ladder",
            "cost_points": 15,
            "duration_seconds": 240,
        },
        "friday_challenge_prep": {
            "enabled": True,
            "label": "Friday Speaking Challenge Prep",
            "cost_points": 15,
            "duration_seconds": 240,
        },
        "professional_roleplay": {
            "enabled": True,
            "label": "Professional Roleplay",
            "cost_points": 20,
            "duration_seconds": 300,
        },
        "saved_words_drill": {
            "enabled": True,
            "label": "Saved Words Speaking Drill",
            "cost_points": 10,
            "duration_seconds": 180,
        },
    },
    "tier_rules": {
        "free": {"enabled": True, "trial_only": True},
        "standard": {"enabled": True},
        "premium": {"enabled": True, "discount_percent": 20},
        "limited": {"enabled": True, "free_sessions_per_book": 1},
    },
    "book_context": {
        "use_book_title": True,
        "use_chapter_title": True,
        "use_current_paragraph": True,
        "use_saved_words": True,
        "use_reading_progress": True,
        "use_previous_reports": True,
    },
}

# Human-facing copy for teacher methods / correction styles (used by the
# prompt builder). Kept server-side so the coach voice persona cannot be
# tampered with from the client.
_TEACHER_METHODS = {
    "friendly_beginner": "a warm, friendly beginner-friendly coach who keeps "
    "things simple and encouraging",
    "pronunciation_first": "a pronunciation-first coach who pays close "
    "attention to sounds, mouth movement and final consonants",
    "confidence_first": "a confidence-first coach who builds the student's "
    "courage to keep speaking without fear of mistakes",
    "professional_english": "a professional English coach preparing the "
    "student for real-world and workplace conversations",
    "khmer_support": "a bilingual coach who explains in simple Khmer only "
    "when the student is stuck, but pushes English speaking",
    "friday_trainer": "an energetic Friday Speaking Challenge trainer who "
    "rehearses the student for the weekly classroom speaking challenge",
}

_CORRECTION_STYLES = {
    "every_sentence": "Correct the student gently after every sentence.",
    "finish_then_correct": "Let the student finish their thought, then give "
    "one short, focused correction.",
    "gentle": "Use very gentle, encouraging correction — never discourage.",
    "intensive": "Use intensive correction — catch every meaningful error, "
    "but stay kind.",
}

_LANGUAGE_MODES = {
    "english_only": "Speak only in English.",
    "english_with_khmer_support": "Speak mainly in English. Use a short Khmer "
    "phrase only when the student is clearly stuck.",
    "bilingual_after_correction": "Speak in English, then add a one-line "
    "Khmer explanation right after each correction.",
}


# --------------------------------------------------------------------------- #
# Pydantic request models                                                     #
# --------------------------------------------------------------------------- #
class StartSessionRequest(BaseModel):
    model_config = ConfigDict(extra="ignore")
    mode: str = Field(..., min_length=1, max_length=60)
    password: str = Field(..., min_length=1, max_length=200)
    # Book context (all optional — the coach personalises with whatever is
    # available). Sent by the Reader; the backend re-validates nothing here
    # because this is context only, never billing input.
    book_slug: str = Field("", max_length=200)
    book_title: str = Field("", max_length=300)
    book_tier: str = Field("free", max_length=30)
    chapter_idx: Optional[int] = None
    chapter_title: str = Field("", max_length=300)
    current_paragraph: str = Field("", max_length=2000)
    reading_progress: str = Field("", max_length=200)
    saved_words: list[str] = Field(default_factory=list)
    # v1.5 — Khmer-Guided English Practice.
    #   explain_language    : the student's PREFERRED language for the
    #                         coach's explanations / corrections / tips.
    #                         Practice sentences and the student's own
    #                         speaking remain English regardless. Accepted
    #                         values: "km" (default) or "en"; anything else
    #                         is coerced to "km" server-side.
    #   points_balance_hint : OPTIONAL display hint, used only in the
    #                         opening greeting text the coach speaks. It
    #                         is NEVER read by the billing / reserve /
    #                         refund paths — those always go through the
    #                         GAS balance source of truth. A malicious
    #                         client passing a huge value here has zero
    #                         effect on debits, charges, or refunds.
    explain_language: str = Field("km", max_length=4)
    points_balance_hint: Optional[int] = Field(None, ge=0, le=10_000_000)
    # Idempotency guard against a rapid double-tap on "Start".
    client_idempotency_key: str = Field("", max_length=80)


class EndSessionRequest(BaseModel):
    model_config = ConfigDict(extra="ignore")
    session_id: str = Field(..., min_length=1, max_length=80)
    reason: str = Field("client_end", max_length=60)
    # Optional transcript captured client-side as a fallback if the WS bridge
    # did not persist it (never used for billing).
    transcript: list[dict] = Field(default_factory=list)


# Phase 0B — allowlists shared by the visibility endpoint (mirrored by the
# frontend liveCoachTopupNudgeLogic.js NUDGE_* maps). Module-level so they are
# importable by tests.
NUDGE_DIAGNOSTIC_REASONS = frozenset({
    "eligible", "config_disabled", "feature_unavailable", "threshold_invalid",
    "balance_temporarily_unavailable", "balance_above_threshold",
    "weekly_cap_reached", "cap_disabled", "cap_lock_unavailable",
    "reservation_not_completed", "pending", "snoozed",
})
NUDGE_BALANCE_SOURCES = frozenset({
    "mongo_wallet", "mongo_wallet_unavailable",
    "client_display_snapshot_required", "client_display_snapshot",
    "gas_verified_pre_reservation", "gas_verified_post_reservation",
    "unavailable",
})
MAX_VISIBILITY_DECISIONS = 100


class TopupVisibilityRequest(BaseModel):
    """Phase 0B — bounded request for the Top-Up pill VISIBILITY decision log.
    Diagnostics ONLY: this endpoint never alters eligibility, cap, wallet,
    payment, or session charging. Unknown fields are ignored; reason/source are
    validated against the allowlists."""
    model_config = ConfigDict(extra="ignore")
    phase: str = Field(..., pattern="^(start|report)$")
    session_id: Optional[str] = Field(None, max_length=80)
    mode: Optional[str] = Field(None, max_length=40)
    pill_shown: bool = Field(...)
    reason: str = Field(..., max_length=48)
    balance_source: str = Field(..., max_length=48)
    client_event_id: str = Field(..., min_length=1, max_length=120)

    @field_validator("reason")
    @classmethod
    def _reason_allowed(cls, v: str) -> str:
        if v not in NUDGE_DIAGNOSTIC_REASONS:
            raise ValueError("invalid_reason")
        return v

    @field_validator("balance_source")
    @classmethod
    def _source_allowed(cls, v: str) -> str:
        if v not in NUDGE_BALANCE_SOURCES:
            raise ValueError("invalid_balance_source")
        return v


# --------------------------------------------------------------------------- #
# Config sanitiser (admin PUT)                                                #
# --------------------------------------------------------------------------- #
def _clamp_int(v: Any, lo: int, hi: int, default: int) -> int:
    try:
        return max(lo, min(int(v), hi))
    except Exception:
        return default


def _sanitise_config(raw: dict | None) -> dict[str, Any]:
    """Merge an admin payload onto DEFAULT_CONFIG with safe clamping. Only
    known keys are accepted; unknown keys are dropped."""
    out = json.loads(json.dumps(DEFAULT_CONFIG))  # deep copy
    raw = raw or {}

    for k in (
        "enabled", "beta_enabled", "save_transcript", "save_audio",
        "save_report", "student_can_view_report", "teacher_can_view_reports",
    ):
        if k in raw:
            out[k] = bool(raw[k])

    out["free_trial_seconds"] = _clamp_int(
        raw.get("free_trial_seconds", out["free_trial_seconds"]), 0, 600, 60)
    out["free_trial_sessions"] = _clamp_int(
        raw.get("free_trial_sessions", out["free_trial_sessions"]), 0, 20, 1)
    out["daily_session_limit"] = _clamp_int(
        raw.get("daily_session_limit", out["daily_session_limit"]), 0, 50, 3)
    out["max_session_seconds"] = _clamp_int(
        raw.get("max_session_seconds", out["max_session_seconds"]), 30, 1800, 300)
    out["min_useful_seconds"] = _clamp_int(
        raw.get("min_useful_seconds", out["min_useful_seconds"]), 0, 300, 20)

    # ── Phase 1 Smart Top-Up Nudge. The admin PUT route REJECTS invalid
    # input up-front via _validate_topup_nudge_fields() (no silent clamping);
    # here we only pass valid values through (defensive defaults otherwise).
    if "topup_nudge_enabled" in raw:
        out["topup_nudge_enabled"] = bool(raw["topup_nudge_enabled"])
    _tn_thr = _topup_strict_int(raw.get("topup_nudge_threshold"))
    if _tn_thr is not None and 0 <= _tn_thr <= 100000:
        out["topup_nudge_threshold"] = _tn_thr
    _tn_cap = _topup_strict_int(raw.get("topup_nudge_max_per_week"))
    if _tn_cap is not None and 0 <= _tn_cap <= 1000:
        out["topup_nudge_max_per_week"] = _tn_cap

    # ── Phase 1 Teacher Daravuth persona. The admin PUT route REJECTS invalid
    # input up-front via _validate_teacher_persona_fields() (no silent
    # clamping). Here we pass valid values through and PRESERVE saved
    # name/mention values even while the master gate is off, so toggling the
    # gate back on restores them (never deleted).
    if "teacher_persona_enabled" in raw:
        out["teacher_persona_enabled"] = bool(raw["teacher_persona_enabled"])
    if "mention_teacher_in_greeting" in raw:
        out["mention_teacher_in_greeting"] = bool(raw["mention_teacher_in_greeting"])
    _tname = raw.get("teacher_display_name")
    if isinstance(_tname, str):
        _name_ok, _ = _teacher_name_ok(_tname)
        if _name_ok:
            out["teacher_display_name"] = _tname.strip()

    lm = str(raw.get("default_language_mode", out["default_language_mode"]))
    if lm in _LANGUAGE_MODES:
        out["default_language_mode"] = lm

    tm = str(raw.get("teacher_method", out["teacher_method"]))
    if tm in _TEACHER_METHODS:
        out["teacher_method"] = tm

    cs = str(raw.get("correction_style", out["correction_style"]))
    if cs in _CORRECTION_STYLES:
        out["correction_style"] = cs

    if isinstance(raw.get("focus_areas"), list):
        out["focus_areas"] = [str(x)[:40] for x in raw["focus_areas"]][:12]

    # Modes
    if isinstance(raw.get("modes"), dict):
        for mkey, mval in raw["modes"].items():
            if mkey in out["modes"] and isinstance(mval, dict):
                base = out["modes"][mkey]
                if "enabled" in mval:
                    base["enabled"] = bool(mval["enabled"])
                base["cost_points"] = _clamp_int(
                    mval.get("cost_points", base["cost_points"]), 0, 1000,
                    base["cost_points"])
                base["duration_seconds"] = _clamp_int(
                    mval.get("duration_seconds", base["duration_seconds"]),
                    30, 1800, base["duration_seconds"])
                if "label" in mval:
                    base["label"] = str(mval["label"])[:60]

    # Tier rules
    if isinstance(raw.get("tier_rules"), dict):
        for tkey, tval in raw["tier_rules"].items():
            if tkey in out["tier_rules"] and isinstance(tval, dict):
                base = out["tier_rules"][tkey]
                if "enabled" in tval:
                    base["enabled"] = bool(tval["enabled"])
                if "trial_only" in tval:
                    base["trial_only"] = bool(tval["trial_only"])
                if "discount_percent" in tval:
                    base["discount_percent"] = _clamp_int(
                        tval["discount_percent"], 0, 100,
                        base.get("discount_percent", 0))
                if "free_sessions_per_book" in tval:
                    base["free_sessions_per_book"] = _clamp_int(
                        tval["free_sessions_per_book"], 0, 50,
                        base.get("free_sessions_per_book", 0))

    # Book context flags
    if isinstance(raw.get("book_context"), dict):
        for ck, cv in raw["book_context"].items():
            if ck in out["book_context"]:
                out["book_context"][ck] = bool(cv)

    return out


def _public_status() -> dict[str, Any]:
    """Operator-facing readiness flags (never leak the key itself)."""
    return {
        "gemini_configured": bool(GEMINI_API_KEY),
        "points_helpers_ok": bool(_POINTS_HELPERS_OK),
        "websockets_lib_ok": bool(_WS_LIB_OK),
        # Refund readiness: a treasury credit can only run when the treasury
        # password + GAS URL are configured. Surfaced so admins can see why a
        # refund might be deferred to reconciliation.
        "refund_path_ok": bool(SL_TREASURY_PASSWORD and GAS_POINTS_LOGIN_URL),
        "live_model": GEMINI_LIVE_MODEL,
    }


# --------------------------------------------------------------------------- #
# Verified refund path: treasury → student credit (NO negative debit).        #
# Mirrors the exact GAS sendPoints treasury-credit path used by Login Rewards #
# / Mystery Box (_lrc_credit_via_treasury). Uses the server-side treasury     #
# credentials — the student's password is NEVER required or stored for a      #
# refund. Returns (ok, error_reason). Never raises.                           #
# --------------------------------------------------------------------------- #
async def _gas_treasury_credit(student_clean_id: str, amount: int) -> tuple[bool, str]:
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
        return False, str((j or {}).get("message") or (j or {}).get("error") or "rejected")[:160]
    except Exception as exc:  # noqa: BLE001
        return False, f"{type(exc).__name__}"


# --------------------------------------------------------------------------- #
# System-instruction (coach persona) builder                                  #
# --------------------------------------------------------------------------- #
def _build_system_instruction(
    *, cfg: dict, mode_key: str, mode_cfg: dict,
    student_name: str, points_balance: int | None,
    book_title: str, chapter_title: str, current_paragraph: str,
    reading_progress: str, saved_words: list[str],
    previous_reports: list[dict],
    explain_language: str = "km",
    voice_authorized: bool = False,
) -> str:
    bc = cfg.get("book_context", {})
    method = _TEACHER_METHODS.get(
        cfg.get("teacher_method", "friendly_beginner"),
        _TEACHER_METHODS["friendly_beginner"])
    correction = _CORRECTION_STYLES.get(
        cfg.get("correction_style", "finish_then_correct"),
        _CORRECTION_STYLES["finish_then_correct"])
    language = _LANGUAGE_MODES.get(
        cfg.get("default_language_mode", "english_with_khmer_support"),
        _LANGUAGE_MODES["english_with_khmer_support"])
    focus = ", ".join(cfg.get("focus_areas") or []) or "pronunciation, confidence"

    mode_label = mode_cfg.get("label", mode_key)

    lines: list[str] = []
    lines.append(
        f"You are EduTalk Live Coach, {student_name}'s PRIVATE EduHub speaking "
        f"coach. You are {method}. You are NOT a generic chatbot — you are part "
        f"of EduHub, the student's English school. Never say you are Gemini or "
        f"a Google product; you are the EduTalk Live Coach."
    )
    lines.append(
        f"This is a '{mode_label}' live speaking session. Keep it focused on "
        f"speaking practice, not long lectures. Speak naturally and warmly, "
        f"like a real teacher on a call."
    )
    lines.append(f"Coaching focus areas for this session: {focus}.")
    lines.append(correction)
    lines.append(language)

    # v1.5 — Khmer-Guided English Practice pillar.
    #
    # Core product rule the user explicitly locked: "Khmer guidance,
    # English practice." The student CHOOSES the explanation language at
    # session start; explanations / tips / corrections follow that
    # choice, but every practice sentence the student must say and every
    # answer the student must speak remain English. Without this rule
    # the model tends to slip into full-Khmer conversation once it sees
    # Khmer in the kicker, which would defeat the speaking-practice
    # learning goal.
    _lang = (explain_language or "km").strip().lower()
    if _lang not in ("km", "en"):
        _lang = "km"
    if _lang == "km":
        lines.append(
            "LANGUAGE RULE (Khmer-guided English practice): The student "
            "is a Khmer speaker. Explain meaning, grammar tips, "
            "pronunciation tips (rhythm, ending sounds, linking, mouth / "
            "tongue position), mistakes and encouragement IN KHMER. "
            "However, every practice sentence you ask the student to "
            "repeat, every model sentence you demonstrate, every reading "
            "drill, and every example answer MUST be in ENGLISH. The "
            "student's own speaking answers must also be in ENGLISH. "
            "Never let the student switch the practice to Khmer — gently "
            "ask them to try the English version again. Keep Khmer "
            "sentences short and natural; do not lecture. Use simple "
            "Khmer that a learner can understand."
        )
    else:
        lines.append(
            "LANGUAGE RULE: The student chose ENGLISH explanations. "
            "Explain in simple, clear English (a learner can follow). "
            "Practice sentences, model sentences, and the student's own "
            "speaking answers are also in English. Keep explanations "
            "short and warm; this is a speaking practice, not a lecture."
        )

    if points_balance is not None:
        lines.append(
            f"{student_name} currently has {points_balance} EduHub points and "
            f"chose to spend points on this private coaching session, so make it "
            f"feel valuable and personal."
        )

    # Book context
    if bc.get("use_book_title") and book_title:
        lines.append(f"The student is reading the EduHub book: \"{book_title}\".")
    if bc.get("use_chapter_title") and chapter_title:
        lines.append(f"Current chapter: \"{chapter_title}\".")
    if bc.get("use_current_paragraph") and current_paragraph:
        snippet = current_paragraph.strip()[:900]
        lines.append(
            "Here is the paragraph the student is currently reading. Use it as "
            f"the basis for shadowing / practice:\n\"\"\"\n{snippet}\n\"\"\""
        )
    if bc.get("use_reading_progress") and reading_progress:
        lines.append(f"Reading progress: {reading_progress}.")
    if bc.get("use_saved_words") and saved_words:
        words = ", ".join(str(w)[:40] for w in saved_words[:25])
        lines.append(f"The student's saved vocabulary words: {words}. Weave a "
                     f"few of these into the practice naturally.")
    if bc.get("use_previous_reports") and previous_reports:
        try:
            last = previous_reports[0]
            prev_focus = last.get("pronunciation_focus") or last.get("next_mission")
            if prev_focus:
                lines.append(
                    f"Last session's improvement focus was: {prev_focus}. "
                    f"Check if the student improved on it."
                )
        except Exception:
            pass

    # Mode-specific behaviour
    mode_hint = {
        "book_shadow": "Have the student shadow (repeat after you) sentences "
        "from their current paragraph, then correct pronunciation.",
        "pronunciation_dna": "Drill specific sounds, mouth movement and final "
        "consonants. Pick 3-4 tricky words and perfect them.",
        "confidence_ladder": "Start with very easy sentences and gradually "
        "raise difficulty, praising every attempt to build confidence.",
        "friday_challenge_prep": "Rehearse the student for a classroom Friday "
        "speaking challenge: a short spoken presentation with Q&A.",
        "professional_roleplay": "Role-play a realistic professional scenario "
        "(interview, meeting, customer call) and coach natural wording.",
        "saved_words_drill": "Drill the student's saved vocabulary words in "
        "real spoken sentences until they sound natural.",
    }.get(mode_key, "")
    if mode_hint:
        lines.append(mode_hint)

    # ── Phase 1 Smart Top-Up Nudge — the SINGLE authorized line. Added ONLY
    # when voice_authorized. It NEVER contains a numeric balance (exact
    # figures appear only in the Stage 1 preview and the Stage 3 report,
    # never spoken). No WebSocket injection, no deterministic-delivery claim.
    if voice_authorized:
        lines.append(_TOPUP_NUDGE_INSTRUCTION_LINE)

    # ── Phase 1 Teacher Daravuth persona — DELIMITED stewardship block, added
    # ONLY when the master gate (`teacher_persona_enabled`) is on. Defaults
    # dark → zero behaviour change. The coach never impersonates the teacher
    # and never fabricates a teacher quote/request (no `teacher_note` exists in
    # this phase, so no quote path is added). The name is re-validated here
    # defensively and falls back to a neutral label if somehow unsafe.
    if cfg.get("teacher_persona_enabled"):
        _raw_name = str(cfg.get("teacher_display_name") or "").strip()
        _name_ok, _ = _teacher_name_ok(_raw_name)
        teacher_name = _raw_name if _name_ok else "your EduHub teacher"
        tlines = [
            "<<TEACHER_PERSONA>>",
            f"You are EduTalk Live Coach, an AI speaking coach supporting "
            f"{student_name}'s learning under the guidance of their teacher, "
            f"{teacher_name}. You are NOT {teacher_name}; you are the AI coach "
            f"that helps the student practise between classes.",
            "Never claim the teacher said, asked, requested, or instructed "
            "anything specific. You have no message or quote from the teacher.",
        ]
        if bool(cfg.get("mention_teacher_in_greeting")):
            tlines.append(
                f"At the very start of the session ONLY, you may mention "
                f"{teacher_name} once, naturally and briefly (for example, "
                f"that you are helping the student practise for "
                f"{teacher_name}'s class). Do not mention the teacher again "
                f"after the greeting.")
        else:
            tlines.append(
                "Do not mention the teacher by name during this session.")
        tlines.append("<<END_TEACHER_PERSONA>>")
        lines.append("\n".join(tlines))

    # NOTE: The Phase 1 corrected build does NOT inject any reward-evidence
    # protocol into the Gemini system instruction. When rewards are enabled
    # the backend evaluates server-owned exercises against authoritative
    # coach + student turn data (see edutalk_coach_reward_tools.py).
    # Therefore the Gemini prompt remains identical to the original
    # pristine implementation whether rewards are enabled or disabled.

    lines.append(
        "Keep your turns short so the student does most of the talking. End the "
        "session with one clear 'next practice mission'."
    )
    return "\n".join(lines)


def _build_report_prompt(transcript_text: str, mode_label: str) -> str:
    return (
        "You are EduTalk Live Coach producing a short JSON speaking report for "
        f"a '{mode_label}' session. Based ONLY on the conversation transcript "
        "below, return STRICT JSON (no markdown, no prose) with exactly these "
        "keys:\n"
        "{\n"
        '  "confidence_score": <int 0-100>,\n'
        '  "clarity_score": <int 0-100>,\n'
        '  "pronunciation_focus": "<one short phrase>",\n'
        '  "corrected_sentences": ["<up to 3 short before->after items>"],\n'
        '  "best_sentence": "<the student\'s best spoken sentence>",\n'
        '  "improved_sentence": "<one student sentence rewritten better>",\n'
        '  "next_mission": "<one concrete next practice mission>",\n'
        '  "summary": "<2 sentence encouraging summary>"\n'
        "}\n\n"
        "TRANSCRIPT:\n" + transcript_text[:6000]
    )


def _heuristic_report(transcript: list[dict], mode_label: str) -> dict:
    """Offline fallback report when Gemini text generation is unavailable."""
    student_turns = [t for t in transcript if t.get("role") == "student"]
    spoke = len(student_turns)
    best = ""
    for t in reversed(student_turns):
        txt = (t.get("text") or "").strip()
        if len(txt.split()) >= 3:
            best = txt
            break
    base = min(95, 50 + spoke * 5)
    return {
        "confidence_score": base,
        "clarity_score": max(40, base - 5),
        "pronunciation_focus": "clear final sounds",
        "corrected_sentences": [],
        "best_sentence": best,
        "improved_sentence": "",
        "next_mission": "Practice speaking 3 full sentences out loud daily.",
        "summary": (
            f"You completed a {mode_label} session and kept speaking — great "
            "effort! Keep practicing to build fluency and confidence."
        ),
        "engine": "heuristic",
    }


async def _generate_report(transcript: list[dict], mode_label: str) -> dict:
    """Generate a speaking report from the transcript. Uses the same Gemini
    REST helper Premium AI / EduTalk use; falls back to a heuristic report so
    the student ALWAYS gets a report card even if the LLM call fails."""
    if not transcript:
        return _heuristic_report(transcript, mode_label)
    if not (_post_gemini and GEMINI_API_KEY):
        return _heuristic_report(transcript, mode_label)

    lines = []
    for t in transcript:
        role = "Student" if t.get("role") == "student" else "Coach"
        txt = (t.get("text") or "").strip()
        if txt:
            lines.append(f"{role}: {txt}")
    transcript_text = "\n".join(lines)
    if not transcript_text.strip():
        return _heuristic_report(transcript, mode_label)

    prompt = _build_report_prompt(transcript_text, mode_label)
    payload = {
        "contents": [{"role": "user", "parts": [{"text": prompt}]}],
        "generationConfig": {"temperature": 0.4, "responseMimeType": "application/json"},
    }
    try:
        resp = await _post_gemini(GEMINI_REPORT_MODEL, GEMINI_API_KEY, payload)
        if resp.status_code != 200:
            log.warning("live: report gemini HTTP %s", resp.status_code)
            return _heuristic_report(transcript, mode_label)
        data = resp.json()
        text = (
            data.get("candidates", [{}])[0]
            .get("content", {})
            .get("parts", [{}])[0]
            .get("text", "")
        )
        report = json.loads(text)
        report["engine"] = "gemini"
        # Clamp scores defensively.
        for k in ("confidence_score", "clarity_score"):
            report[k] = _clamp_int(report.get(k, 60), 0, 100, 60)
        return report
    except Exception as exc:  # noqa: BLE001
        log.warning("live: report generation failed: %s", exc)
        return _heuristic_report(transcript, mode_label)


# =========================================================================== #
# Phase 1 — EduTalk Live Coach "Smart Top-Up Nudge" (ADDITIVE, default OFF).  #
# --------------------------------------------------------------------------- #
# This block is a self-contained, additive extension. With                     #
# ``topup_nudge_enabled`` false it produces ZERO behavioural change. It        #
# introduces NO new session-extension, continuation, pause/resume,            #
# live-payment, payment-provider, wallet-crediting, or Surprise Reward code   #
# path. It only:                                                              #
#   * exposes a read-only, mode-specific PREVIEW (Stage 1),                    #
#   * records an immutable AUTHORIZATION after the EXISTING reservation        #
#     succeeds (Stage 2),                                                      #
#   * records a FINALIZATION after _finalize_session settles (Stage 3),        #
#   * adds ONE non-numeric line to the Gemini system instruction.             #
# Stage 2 and Stage 3 share ONE concurrency-safe weekly-cap helper.           #
# =========================================================================== #

# Optional, READ-ONLY reuse of the existing pure-Mongo wallet read methods.
# We NEVER mutate the wallet, never touch GAS, never store a password. If the
# import fails the preview/finalization balance simply degrades to
# "wallet_unavailable" without affecting anything else.
try:
    from wallet_service import WalletService as _WalletService  # type: ignore
    _WALLET_SERVICE_OK = True
except Exception:  # pragma: no cover
    _WalletService = None  # type: ignore[assignment]
    _WALLET_SERVICE_OK = False

# ONE new narrow collection (this module's existing ``edutalk_live_*`` naming
# convention). Holds exactly one cap document per ``clean_id``; that document
# carries the rolling array of recent authorization records used for the
# weekly-cap accounting AND the concurrency-safe claim lock.
TOPUP_NUDGE_LOG_COLLECTION = "edutalk_live_topup_nudge_log"

# Rolling window is a CONTINUOUS 7 x 24h, evaluated as ``now - 7d .. now``
# (never a fixed calendar bucket).
TOPUP_NUDGE_WINDOW_SECONDS = 7 * 24 * 60 * 60

# Stale-lock recovery threshold for the cap document's claim lock — mirrors the
# crash-recovery semantics of ``_do_refund``'s ``_REFUND_STALE_SECONDS``.
_TOPUP_NUDGE_LOCK_STALE_SECONDS = 30
# Bounded spin to let a real-Mongo lock loser re-evaluate after the winner
# releases (so a true race resolves to weekly_cap_reached, not a lock error).
_TOPUP_NUDGE_LOCK_RETRIES = 12
_TOPUP_NUDGE_LOCK_RETRY_SLEEP = 0.05

# The SINGLE Gemini instruction line for an authorized nudge. It contains NO
# numeric balance under any condition (a session-start figure can be
# contradicted by the settled figure before the model's closing remark).
_TOPUP_NUDGE_INSTRUCTION_LINE = (
    "Near the natural end of this session, and only once, warmly mention "
    "that the student may want to top up for a future practice session. "
    "Keep it brief, informational, and non-urgent. Do not interrupt an "
    "exercise or correction. Do not say or imply that topping up extends "
    "or adds time to the current session."
)


def _topup_strict_int(value: Any) -> Optional[int]:
    """Return an int ONLY for genuinely integral input (rejects 1.5, "x",
    None, bools-as-numbers handled explicitly). Used so admin validation can
    REJECT bad input instead of silently clamping it."""
    if isinstance(value, bool):
        return None
    if isinstance(value, int):
        return value
    if isinstance(value, float):
        return int(value) if value.is_integer() else None
    if isinstance(value, str):
        s = value.strip()
        try:
            f = float(s)
        except Exception:
            return None
        return int(f) if f.is_integer() else None
    return None


def _validate_topup_nudge_fields(raw: dict | None) -> tuple[bool, str]:
    """Validate ONLY the three Smart Top-Up Nudge admin fields. REJECTS
    invalid input (no silent clamping) with feature-specific reason codes.
    Returns (ok, reason_code). reason_code is "" on success."""
    raw = raw or {}
    if "topup_nudge_enabled" in raw and not isinstance(
            raw["topup_nudge_enabled"], bool):
        return False, "config_disabled"
    if "topup_nudge_threshold" in raw:
        thr = _topup_strict_int(raw["topup_nudge_threshold"])
        if thr is None or thr < 0 or thr > 100000:
            return False, "threshold_invalid"
    if "topup_nudge_max_per_week" in raw:
        cap = _topup_strict_int(raw["topup_nudge_max_per_week"])
        if cap is None or cap < 0 or cap > 1000:
            return False, "weekly_cap_invalid"
    return True, ""


# Phase 1 — Teacher Daravuth display-name character policy. Allow Unicode
# letters + combining marks (so Khmer ្ stacking marks pass), plus a SMALL
# punctuation allowlist. Everything else (digits, braces/brackets, prompt
# delimiters, control characters, tabs, line breaks, other punctuation) is
# rejected to keep the name safe to interpolate into a Gemini instruction.
_TEACHER_NAME_ALLOWED_PUNCT = frozenset({
    " ",         # space
    ".",         # period
    "'",         # straight apostrophe (U+0027)
    "\u2019",    # right single quotation mark
    "-",         # hyphen-minus (U+002D)
    "\u2011",    # non-breaking hyphen
})


def _teacher_name_ok(name: Any) -> tuple[bool, str]:
    """Validate a teacher display name. Returns (ok, reason_code)."""
    if not isinstance(name, str):
        return False, "teacher_name_invalid"
    trimmed = name.strip()
    if len(trimmed) < 1:
        return False, "teacher_name_empty"
    if len(trimmed) > 80:
        return False, "teacher_name_too_long"
    for ch in trimmed:
        if ch in _TEACHER_NAME_ALLOWED_PUNCT:
            continue
        cat = unicodedata.category(ch)
        # Letters (L*) and combining marks (M*) are allowed — this covers Khmer
        # consonants, vowels and the coeng (្) stacking marks.
        if cat and cat[0] in ("L", "M"):
            continue
        return False, "teacher_name_invalid_char"
    return True, ""


def _validate_teacher_persona_fields(raw: dict | None) -> tuple[bool, str]:
    """Phase 1 — validate ONLY the three teacher-persona admin fields. REJECTS
    invalid input (no silent clamping) with stable feature-specific reason
    codes. Booleans must be actual booleans. Returns (ok, reason_code)."""
    raw = raw or {}
    if "teacher_persona_enabled" in raw and not isinstance(
            raw["teacher_persona_enabled"], bool):
        return False, "teacher_persona_enabled_invalid"
    if "mention_teacher_in_greeting" in raw and not isinstance(
            raw["mention_teacher_in_greeting"], bool):
        return False, "mention_teacher_invalid"
    if "teacher_display_name" in raw:
        ok, reason = _teacher_name_ok(raw["teacher_display_name"])
        if not ok:
            return False, reason
    return True, ""


def _topup_nudge_event_key(clean_id: str, session_id: str) -> str:
    """Stable idempotency key: clean_id + session_id + the feature tag."""
    return f"{clean_id}{session_id}live_coach_topup_nudge"


def _topup_parse_iso(value: Any) -> Optional[datetime]:
    try:
        dt = datetime.fromisoformat(str(value))
        if dt.tzinfo is None:
            dt = dt.replace(tzinfo=timezone.utc)
        return dt
    except Exception:
        return None


def _topup_records_in_window(records: list, window_start: datetime) -> list:
    """Prune to the records whose authorized_at is within the rolling window
    (>= window_start). Records without a parseable timestamp are dropped."""
    out = []
    for r in records or []:
        ts = _topup_parse_iso((r or {}).get("authorized_at"))
        if ts is not None and ts >= window_start:
            out.append(r)
    return out


def _topup_preview_for_mode(
    *, enabled: bool, flag_on: bool, balance: Optional[int],
    mode_cost: int, threshold: int, weekly_cap_available: bool,
    cap_reason: str | None = None,
) -> dict:
    """PURE per-mode preview. The frontend selects the matching entry on mode
    change and NEVER recomputes balance-minus-cost itself.

    Flag-aware balance source (USE_MONGO_POINTS_READ):
      * flag OFF (today's default): no numeric fields, reason
        ``balance_unavailable_for_preview`` (an accepted degraded state, not a
        defect — Stage 2/3 are unaffected).
      * flag ON: real numbers from the public WalletService read.

    Phase 0B (additive, observability only): every branch ALSO returns a
    normalized ``diagnostic_reason`` (allowlist) and a truthful
    ``balance_source`` (allowlist).

    Bug 3 (v2 correction): the legacy ``eligible`` field now FAILS CLOSED when
    the read-only weekly cap is exhausted/disabled (``weekly_cap_reached`` /
    ``cap_disabled``), matching ``diagnostic_reason``. This is preview
    visibility only — it NEVER changes ``_consume_topup_nudge_slot`` cap
    consumption timing, authorization semantics, or atomic locking. All numeric
    fields are preserved for the existing frontend/tests.
    """
    if not enabled:
        return {"enabled": False, "eligible": False, "reason": "config_disabled",
                "diagnostic_reason": "config_disabled",
                "balance_source": "unavailable"}
    if threshold is None or threshold < 0:
        return {"enabled": False, "eligible": False, "reason": "threshold_invalid",
                "diagnostic_reason": "threshold_invalid",
                "balance_source": "unavailable"}
    if not flag_on:
        # USE_MONGO_POINTS_READ off → no server numeric preview; the client
        # display snapshot path is required. Accepted degraded state.
        return {"enabled": False, "eligible": False,
                "reason": "balance_unavailable_for_preview",
                "diagnostic_reason": "balance_temporarily_unavailable",
                "balance_source": "client_display_snapshot_required"}
    if balance is None:
        return {"enabled": False, "eligible": False, "reason": "wallet_unavailable",
                "diagnostic_reason": "balance_temporarily_unavailable",
                "balance_source": "mongo_wallet_unavailable"}
    projected = int(balance) - int(mode_cost)
    balance_eligible = projected <= int(threshold)
    # Normalized diagnostic: fail closed on cap exhaustion/disabled regardless
    # of the projected balance (preview visibility only).
    if cap_reason == "weekly_cap_reached" or (
            cap_reason is None and not weekly_cap_available):
        diagnostic_reason = "weekly_cap_reached"
    elif cap_reason == "cap_disabled":
        diagnostic_reason = "cap_disabled"
    elif balance_eligible:
        diagnostic_reason = "eligible"
    else:
        diagnostic_reason = "balance_above_threshold"
    # Bug 3 (v2 correction) — the legacy ``eligible`` field MUST now fail closed
    # whenever the read-only weekly cap blocks the nudge. This is preview
    # visibility only: it NEVER changes ``_consume_topup_nudge_slot`` cap
    # consumption timing, authorization semantics, or atomic locking. A nudge
    # that the cap will block must not be advertised as eligible.
    cap_blocks = diagnostic_reason in ("weekly_cap_reached", "cap_disabled")
    eligible = bool(balance_eligible and not cap_blocks)
    # V3 item 6 — restore the full legacy ``reason`` contract from pristine
    # 241. ``reason`` is derived from ``projected`` vs ``threshold`` ALONE
    # (six pristine values) and MUST NEVER be set to a cap-specific
    # diagnostic string. The cap-blocked signal lives in ``diagnostic_reason``
    # (``weekly_cap_reached`` / ``cap_disabled``) and ``eligible`` (``False``)
    # — already set above. This restores legacy parity with pristine 241
    # while keeping the v2 fail-closed ``eligible`` correction intact.
    if balance_eligible:
        reason = "projected_balance_at_or_below_threshold"
    else:
        reason = "balance_above_threshold"
    return {
        "enabled": True,
        "eligible": eligible,
        "reason": reason,
        "diagnostic_reason": diagnostic_reason,
        "balance_source": "mongo_wallet",
        "verified_current_balance": int(balance),
        "mode_cost": int(mode_cost),
        "projected_post_reservation_balance": int(projected),
        "threshold": int(threshold),
        "weekly_cap_available": bool(weekly_cap_available),
    }


def _topup_settlement_reason(final_state: str) -> str:
    """Map a finalized session state to a settlement reason."""
    return {
        "completed_charged": "completed_charged",
        "cancelled_partial": "early_refund",
        "failed_refunded": "failed_refunded",
        "expired": "expired",
    }.get(final_state or "", final_state or "unknown")


async def _wallet_balance_via_public_method(
    db, student_id: str,
) -> tuple[Optional[int], bool]:
    """Read the student's authoritative wallet balance via the EXISTING public
    WalletService read method (``get_wallet``) — NO wallet internals touched,
    NO GAS, NO password. Returns (balance_int|None, available_bool).

    The caller invokes this EXACTLY ONCE per stage. It works regardless of the
    ``USE_MONGO_POINTS_READ`` flag (the flag only gates the student-facing
    route, not this pure-Mongo read method).

    When WalletService is importable (motor/pymongo available — production),
    the public ``get_wallet`` method is used unchanged. When WalletService is
    NOT importable (test environments without motor/pymongo), a direct
    ``points_wallets`` collection read replicates the identical logic: same
    normalization, same status guard, same balance extraction. This keeps the
    test contract intact without touching any protected files."""
    if not student_id:
        return None, False
    # Normalise: strip + lowercase, reject empty / overlong (mirrors _norm_id).
    sid = student_id.strip().lower()
    if not sid or len(sid) > 64:
        return None, False
    try:
        if _WALLET_SERVICE_OK:
            # Production path — use the fully-audited WalletService.
            svc = _WalletService(db)
            wallet = await svc.get_wallet(sid)  # one public read
        else:
            # Fallback path — WalletService unavailable (motor/pymongo absent).
            # Direct read from the same ``points_wallets`` collection, applying
            # the identical status + balance guards as WalletService.get_wallet.
            wallet = await db["points_wallets"].find_one(
                {"student_id": sid}, {"_id": 0}
            )
        if not wallet:
            return None, False
        status = wallet.get("status")
        if status is not None and status != "active":
            return None, False
        bal = wallet.get("balance")
        if bal is None:
            return None, False
        return int(round(float(bal))), True
    except Exception:
        return None, False


async def _topup_cap_availability(
    col, *, clean_id: str, cap: int, now: datetime | None = None,
) -> bool:
    """READ-ONLY check of whether the student has a weekly-cap slot available.
    NEVER writes — Stage 1 (preview) must never consume a cap slot."""
    available, _reason = await _topup_cap_status(
        col, clean_id=clean_id, cap=cap, now=now)
    return available


async def _topup_cap_status(
    col, *, clean_id: str, cap: int, now: datetime | None = None,
) -> tuple[bool, str]:
    """READ-ONLY weekly-cap status. Returns ``(available, reason)`` where
    ``reason`` is one of:

      * ``"cap_disabled"`` — cap is zero/None (the admin has not enabled it);
      * ``"weekly_cap_reached"`` — the student has consumed the rolling-week
        cap and no slot is available;
      * ``"ok"`` — a slot is available.

    NEVER writes (Stage 1 / config preview must never consume a slot)."""
    if cap is None or cap <= 0:
        return False, "cap_disabled"
    now = now or _now()
    window_start = now - timedelta(seconds=TOPUP_NUDGE_WINDOW_SECONDS)
    try:
        doc = await col.find_one({"clean_id": clean_id})
    except Exception:
        # Treat a transient read error as "no slot" to keep the pill suppressed
        # rather than surfacing a false-positive offer. Stage 2/3 unaffected.
        return False, "weekly_cap_reached"
    used = len(_topup_records_in_window((doc or {}).get("authorizations"),
                                        window_start))
    if used < int(cap):
        return True, "ok"
    return False, "weekly_cap_reached"


async def _consume_topup_nudge_slot(
    col, *, clean_id: str, session_id: str, authorization_source: str,
    cap: int, now: datetime | None = None,
) -> dict:
    """CONCURRENCY-SAFE rolling 7x24h weekly-cap claim — shared by Stage 2
    (session_start) and Stage 3 (post_settlement).

    Mirrors ``_do_refund``'s proven atomic CLAIM-then-act lock
    (``find_one_and_update`` with stale-lock recovery) instead of a racy
    count-then-insert. Sequence (all under the claimed lock):
      1. atomically claim a short-lived lock on the student's cap document;
      2. load the recent authorization records;
      3. idempotent retry — an entry for this session_id (same event_key)
         returns unchanged (no re-count, no re-append);
      4. prune entries older than 7x24h, check the remaining count vs cap;
      5. if under cap append a new record + save; if at cap leave unchanged;
      6. release the lock;
      7. return the result.

    Returns {"record": <record|None>, "reason": <code>, "count": <int>}.
    reason in {"authorized","idempotent","weekly_cap_reached","cap_disabled",
    "lock_unavailable"}.
    """
    now = now or _now()
    event_key = _topup_nudge_event_key(clean_id, session_id)
    if cap is None or cap <= 0:
        return {"record": None, "reason": "cap_disabled", "count": 0}

    # Ensure the per-student cap document exists (idempotent; safe under
    # concurrent creation thanks to the unique clean_id index + setOnInsert).
    try:
        await col.update_one(
            {"clean_id": clean_id},
            {"$setOnInsert": {"clean_id": clean_id, "authorizations": [],
                              "nudge_lock_state": "idle"}},
            upsert=True,
        )
    except Exception:
        # A concurrent upsert may collide on the unique index — that is fine,
        # the document now exists either way.
        pass

    stale_cutoff = (now - timedelta(
        seconds=_TOPUP_NUDGE_LOCK_STALE_SECONDS)).isoformat()

    claimed = None
    for _attempt in range(_TOPUP_NUDGE_LOCK_RETRIES):
        # ── ATOMIC CAP LOCK ── (claim-then-act; never count-then-insert)
        claimed = await col.find_one_and_update(
            {"clean_id": clean_id,
             "$or": [
                 {"nudge_lock_state": {"$ne": "locked"}},
                 # reclaim a STALE processing lock (crash recovery)
                 {"nudge_lock_state": "locked",
                  "nudge_lock_at": {"$lt": stale_cutoff}},
             ]},
            {"$set": {"nudge_lock_state": "locked",
                      "nudge_lock_at": now.isoformat()}},
        )
        if claimed is not None:
            break
        # Another caller holds a fresh lock — wait briefly and re-evaluate so a
        # true race loser still sees the up-to-date (possibly full) count.
        await asyncio.sleep(_TOPUP_NUDGE_LOCK_RETRY_SLEEP)
    if claimed is None:
        return {"record": None, "reason": "lock_unavailable", "count": 0}

    authorizations = list((claimed or {}).get("authorizations") or [])

    # (3) Idempotent retry — return the existing record unchanged.
    for rec in authorizations:
        if (rec or {}).get("event_key") == event_key:
            await _topup_release_lock(col, clean_id)
            window_start = now - timedelta(seconds=TOPUP_NUDGE_WINDOW_SECONDS)
            return {"record": rec, "reason": "idempotent",
                    "count": len(_topup_records_in_window(authorizations,
                                                          window_start))}

    # (4) Prune to the rolling window, then check the count.
    window_start = now - timedelta(seconds=TOPUP_NUDGE_WINDOW_SECONDS)
    kept = _topup_records_in_window(authorizations, window_start)

    if len(kept) >= int(cap):
        # At cap — persist the pruned array (keeps the doc bounded) + release.
        await col.update_one(
            {"clean_id": clean_id},
            {"$set": {"authorizations": kept, "nudge_lock_state": "idle"},
             "$unset": {"nudge_lock_at": ""}})
        return {"record": None, "reason": "weekly_cap_reached",
                "count": len(kept)}

    # (5) Under cap — append the new record and save atomically + release.
    record = {
        "event_key": event_key,
        "clean_id": clean_id,
        "session_id": session_id,
        "authorization_source": authorization_source,
        "authorized_at": now.isoformat(),
    }
    kept.append(record)
    await col.update_one(
        {"clean_id": clean_id},
        {"$set": {"authorizations": kept, "nudge_lock_state": "idle"},
         "$unset": {"nudge_lock_at": ""}})
    return {"record": record, "reason": "authorized", "count": len(kept)}


async def _topup_release_lock(col, clean_id: str) -> None:
    try:
        await col.update_one(
            {"clean_id": clean_id},
            {"$set": {"nudge_lock_state": "idle"},
             "$unset": {"nudge_lock_at": ""}})
    except Exception:  # pragma: no cover
        pass



# =========================================================================== #
# Route registration                                                          #
# =========================================================================== #
def register_edutalk_live_routes(api, db, require_admin, require_student) -> None:
    """Attach all EduTalk Live Coach routes onto the existing ``/api`` router.

    Mirrors the registration contract used by every other EduHub feature
    module (register_*_routes(api, db, require_admin, require_student)).
    """
    cfg_col = db["edutalk_live_config"]
    sess_col = db["edutalk_live_sessions"]
    report_col = db["edutalk_live_reports"]
    usage_col = db["edutalk_live_usage_logs"]
    # Phase 1 Smart Top-Up Nudge — the ONE new narrow collection (cap log).
    nudge_col = db[TOPUP_NUDGE_LOG_COLLECTION]

    _CFG_ID = "singleton"

    # ----------------------------- config I/O ----------------------------- #
    async def _load_config() -> dict[str, Any]:
        doc = await cfg_col.find_one({"_id": _CFG_ID})
        if not doc:
            return json.loads(json.dumps(DEFAULT_CONFIG))
        merged = _sanitise_config(doc.get("config") or {})
        return merged

    async def _save_config(updates: dict, admin_email: str) -> dict[str, Any]:
        clean = _sanitise_config(updates)
        await cfg_col.update_one(
            {"_id": _CFG_ID},
            {"$set": {
                "config": clean,
                "updated_at": _iso(),
                "updated_by": admin_email[:120],
            }},
            upsert=True,
        )
        return clean

    async def _log_usage(student, action: str, status: str, points: int,
                         mode: str = "", session_id: str = "",
                         error_reason: str = "") -> None:
        try:
            await usage_col.insert_one({
                "ts": _iso(),
                "day": _today_key(),
                "student_id": str(getattr(student, "clean_id", ""))[:60],
                "display_name": str(getattr(student, "display_name", ""))[:80],
                "action": action,
                "status": status,
                "points": int(points),
                "mode": mode[:60],
                "session_id": session_id[:80],
                "error_reason": error_reason[:200],
            })
        except Exception as exc:  # noqa: BLE001
            log.warning("live: usage log write failed: %s", exc)

    # --------------------- points reserve / refund ------------------------ #
    async def _reserve_points(clean_id: str, password: str, amount: int) -> tuple[bool, str]:
        """Reserve points by debiting student → treasury (positive amount).

        The password is used transiently for this one GAS call and is NEVER
        stored on the session. Returns (ok, error)."""
        if amount <= 0:
            return True, ""
        if _gas_debit is None:
            return False, "points_helper_unavailable"
        try:
            ok, err = await _gas_debit(clean_id, password, amount)
            return ok, err
        except Exception as exc:  # noqa: BLE001
            return False, f"{type(exc).__name__}"

    # Stale-lock threshold: a refund stuck in "refund_processing" longer than
    # this (e.g. a crash mid-credit) becomes reclaimable by reconciliation.
    _REFUND_STALE_SECONDS = 120

    async def _do_refund(session_id: str, clean_id: str, amount: int,
                         reason: str) -> bool:
        """Verified refund via treasury → student credit (NO negative debit,
        NO stored password).

        Concurrency-safe: an atomic ``find_one_and_update`` CLAIMS an exclusive
        ``refund_processing`` lock before the network credit runs, so a
        scheduled/manual reconcile can NEVER double-credit while a refund is
        already in progress. A fresh in-progress refund is never re-claimed; a
        STALE (>_REFUND_STALE_SECONDS) processing lock can be reclaimed so a
        crashed refund still recovers.

        ``refunded`` is set True ONLY after the credit actually succeeds. On
        failure the session is left ``refund_state='refund_failed'`` (amount
        preserved) for reconciliation to retry.
        """
        if amount <= 0:
            await sess_col.update_one(
                {"session_id": session_id},
                {"$set": {"refunded": True, "refund_state": "refunded",
                          "refund_amount": 0}})
            return True

        now = _now()
        stale_cutoff = (now - timedelta(seconds=_REFUND_STALE_SECONDS)).isoformat()
        # ── ATOMIC REFUND LOCK ──
        claimed = await sess_col.find_one_and_update(
            {"session_id": session_id,
             "refunded": {"$ne": True},
             "$or": [
                 {"refund_state": {"$nin": ["refund_processing", "refunded"]}},
                 # allow reclaiming a STALE processing lock (crash recovery)
                 {"refund_state": "refund_processing",
                  "refund_processing_at": {"$lt": stale_cutoff}},
             ]},
            {"$set": {"refund_state": "refund_processing",
                      "refund_reason": reason[:80],
                      "refund_amount": amount,
                      "refund_processing_at": now.isoformat()}},
        )
        if not claimed:
            # Another path holds a fresh lock, or it is already refunded.
            return False

        ok, err = await _gas_treasury_credit(clean_id, amount)
        if ok:
            await sess_col.update_one(
                {"session_id": session_id},
                {"$set": {"refunded": True, "refund_state": "refunded",
                          "refunded_at": _iso()},
                 "$unset": {"refund_error": "", "refund_processing_at": ""}})
            log.info("live: refunded %d pts sid=%s reason=%s",
                     amount, session_id, reason)
        else:
            await sess_col.update_one(
                {"session_id": session_id},
                {"$set": {"refunded": False, "refund_state": "refund_failed",
                          "refund_error": err[:160],
                          "refund_failed_at": _iso()},
                 "$unset": {"refund_processing_at": ""}})
            log.error("live: refund FAILED sid=%s err=%s (queued for reconcile)",
                      session_id, err)
        return ok

    async def _finalize_topup_nudge(session: dict, final_state: str,
                                    cfg: dict) -> None:
        """Phase 1 Smart Top-Up Nudge — STAGE 3 FINALIZATION.

        Writes the finalization record the report pill renders from (ONLY
        from this finalized balance — never the session-start figure). It
        either reuses an existing Stage 2 authorization (consuming NO extra
        weekly slot) or, when Stage 2 never qualified and the settled balance
        is now at/under threshold, attempts ONE idempotent report-only
        authorization through the SAME Section 3 helper
        (authorization_source="post_settlement"). With the feature disabled it
        writes nothing (zero change)."""
        if not bool(cfg.get("topup_nudge_enabled")):
            return
        clean_id = session.get("clean_id", "")
        session_id = session.get("session_id")
        threshold = int(cfg.get("topup_nudge_threshold", 0))
        cap = int(cfg.get("topup_nudge_max_per_week", 0))
        existing_tn = session.get("topup_nudge") or {}
        already_authorized = bool(
            (existing_tn.get("authorization") or {}).get("voice_authorized"))
        settlement_reason = _topup_settlement_reason(final_state)

        # Read the SETTLED balance EXACTLY ONCE via the public WalletService
        # method, keyed by this file's established identifier ``clean_id``
        # (works regardless of USE_MONGO_POINTS_READ).
        # Bug 1b: the authoritative GAS balance is not readable at finalize
        # without the student password (deliberately never stored — see
        # INVESTIGATION_REPORT.md). This Mongo read returns None for GAS-only
        # students; report-pill eligibility therefore falls back to a frontend
        # client estimate when reason == "wallet_unavailable".
        settled_balance, bal_ok = await _wallet_balance_via_public_method(
            db, clean_id)

        fin = {
            "settled_balance": settled_balance if bal_ok else None,
            "settlement_reason": settlement_reason,
            "finalized_at": _iso(),
        }
        report_authorized = False

        if final_state in ("failed_refunded", "expired"):
            # No kept reservation → nothing to nudge about.
            fin.update({"report_eligible": False,
                        "reason": "reservation_not_completed"})
        elif not bal_ok:
            fin.update({"report_eligible": False, "reason": "wallet_unavailable"})
        elif already_authorized:
            # Reuse Stage 2 — consume NO additional weekly slot. A refund that
            # pushed the balance back above threshold suppresses the pill.
            if settled_balance <= threshold:
                fin.update({"report_eligible": True,
                            "reason": "balance_at_or_below_threshold_after_settlement"})
                report_authorized = True
            else:
                fin.update({"report_eligible": False,
                            "reason": "balance_above_threshold_after_settlement"})
        else:
            # Stage 2 did NOT authorize. Attempt ONE report-only authorization
            # only when the settled balance is now at/under threshold.
            if settled_balance <= threshold:
                slot = await _consume_topup_nudge_slot(
                    nudge_col, clean_id=clean_id, session_id=session_id,
                    authorization_source="post_settlement", cap=cap)
                if slot["reason"] in ("authorized", "idempotent"):
                    fin.update({"report_eligible": True,
                                "reason": "balance_at_or_below_threshold_after_settlement"})
                    report_authorized = True
                else:
                    # Cap reached → suppress the report pill.
                    fin.update({"report_eligible": False,
                                "reason": "weekly_cap_reached"})
            else:
                fin.update({"report_eligible": False,
                            "reason": "balance_above_threshold_after_settlement"})

        # ── Phase 0B (additive, observability only) — normalized report
        # diagnostics. The legacy ``reason`` above is preserved unchanged; we
        # ADD a normalized ``diagnostic_reason`` (allowlist) and a truthful
        # ``balance_source`` so the report-pill decision is auditable. This
        # never alters eligibility, cap, wallet, or settlement.
        fin["balance_source"] = (
            "mongo_wallet" if bal_ok else "mongo_wallet_unavailable")
        _report_diag_map = {
            "reservation_not_completed": "reservation_not_completed",
            "wallet_unavailable": "balance_temporarily_unavailable",
            "balance_at_or_below_threshold_after_settlement": "eligible",
            "balance_above_threshold_after_settlement": "balance_above_threshold",
            "weekly_cap_reached": "weekly_cap_reached",
        }
        fin["diagnostic_reason"] = _report_diag_map.get(
            fin.get("reason"), "pending")

        tn = dict(existing_tn)
        tn.setdefault("event_key", _topup_nudge_event_key(clean_id, session_id))
        tn.setdefault("clean_id", clean_id)
        tn.setdefault("session_id", session_id)
        tn["finalization"] = fin
        tn["report_authorized"] = report_authorized
        if report_authorized and not already_authorized:
            # Stage-3-only authorization: Gemini already ran; only the report
            # pill reflects it (voice_authorized stays false).
            auth = dict(tn.get("authorization") or {})
            auth["voice_authorized"] = False
            auth["report_authorized"] = True
            tn["authorization"] = auth
            tn.setdefault("authorization_source", "post_settlement")
        await sess_col.update_one(
            {"session_id": session_id}, {"$set": {"topup_nudge": tn}})


    async def _finalize_session(session_id: str, *, outcome: str,
                                transcript: list[dict] | None = None,
                                error_reason: str = "") -> dict:
        """Idempotently move a session to a terminal state.

        Atomicity contract: the terminal-state decision is made first, then a
        single atomic ``find_one_and_update`` CLAIMS an exclusive finalize lock
        (``finalized=True``) BEFORE any refund / charge side-effect runs. Only
        the path that wins the claim performs the refund + report, so a refund
        or final charge can never run twice even if the WS-close path and the
        REST /session/end path race.

        outcome ∈ {"completed", "failed", "cancelled"}.
        """
        session = await sess_col.find_one({"session_id": session_id})
        if not session:
            raise HTTPException(status_code=404, detail="Session not found")

        terminal = ("completed_charged", "failed_refunded",
                    "cancelled_partial", "expired")
        if session.get("finalized") or session.get("state") in terminal:
            report = await report_col.find_one(
                {"session_id": session_id}, {"_id": 0})
            return {"session": _safe_session(session), "report": report}

        cfg = await _load_config()
        try:
            elapsed = max(0, int(time.time() - float(session.get("active_ts") or time.time())))
        except Exception:
            elapsed = 0
        used_transcript = transcript or session.get("transcript") or []
        became_active = bool(session.get("active_ts"))
        min_useful = int(cfg.get("min_useful_seconds", 20))

        # Decide terminal intent BEFORE any side-effect.
        if outcome == "failed" or not became_active:
            final_state, do_refund = "failed_refunded", True
        elif outcome == "cancelled" and elapsed < min_useful:
            final_state, do_refund = "cancelled_partial", True
        else:
            final_state, do_refund = "completed_charged", False

        # ── ATOMIC CLAIM FIRST ── lock the session into a transient
        # "finalizing" state so exactly one caller runs the side-effects below.
        claimed = await sess_col.find_one_and_update(
            {"_id": session["_id"], "finalized": {"$ne": True}},
            {"$set": {
                "finalized": True,
                "state": "finalizing",
                "ended_at": _iso(),
                "elapsed_seconds": elapsed,
                "end_reason": (error_reason or outcome)[:80],
            }},
        )
        if not claimed:
            session = await sess_col.find_one({"session_id": session_id})
            report = await report_col.find_one(
                {"session_id": session_id}, {"_id": 0})
            return {"session": _safe_session(session or {}), "report": report}

        reserved_amount = int(session.get("charged_amount") or 0)

        # Side-effect: refund (we exclusively hold the finalize lock).
        # final_charged is HONEST: it is only 0 when the refund ACTUALLY
        # succeeded. If the refund is still pending/failed, the student is still
        # down the reserved points (surfaced to the UI as refund_pending /
        # refund_failed) and reconciliation will retry the credit.
        if do_refund:
            refund_ok = await _do_refund(
                session_id, session.get("clean_id", ""), reserved_amount,
                error_reason or outcome)
            charged_final = 0 if refund_ok else reserved_amount
        else:
            charged_final = reserved_amount

        # Commit the real terminal state + the net charge.
        await sess_col.update_one(
            {"session_id": session_id},
            {"$set": {"state": final_state, "final_charged": charged_final}})
        session = await sess_col.find_one({"session_id": session_id})

        # Generate + persist report (only when the session was real).
        if final_state == "completed_charged" and cfg.get("save_report", True):
            mode_cfg = (cfg.get("modes") or {}).get(session.get("mode"), {})
            mode_label = mode_cfg.get("label", session.get("mode", "Session"))
            report = await _generate_report(used_transcript, mode_label)
            report_doc = {
                "session_id": session_id,
                "student_id": session.get("clean_id"),
                "display_name": session.get("display_name"),
                "mode": session.get("mode"),
                "mode_label": mode_label,
                "book_slug": session.get("book_slug"),
                "book_title": session.get("book_title"),
                "duration_seconds": elapsed,
                "points_charged": charged_final,
                "created_at": _iso(),
                **report,
            }
            if cfg.get("save_transcript", True):
                report_doc["transcript"] = used_transcript[:200]
            try:
                await report_col.update_one(
                    {"session_id": session_id},
                    {"$set": report_doc}, upsert=True)
            except Exception as exc:  # noqa: BLE001
                log.warning("live: report persist failed: %s", exc)

        await _log_usage(
            _FakeStudent(session.get("clean_id"), session.get("display_name")),
            "session_finalize", final_state, charged_final,
            mode=session.get("mode", ""), session_id=session_id,
            error_reason=error_reason)

        # ── Phase 1 Smart Top-Up Nudge — STAGE 3 FINALIZATION ──
        # Runs once (only the finalize-claim winner reaches here). The EXISTING
        # debit/refund logic above is unchanged; this only reads the settled
        # balance once and writes the report-pill finalization record.
        try:
            await _finalize_topup_nudge(session, final_state, cfg)
        except Exception as exc:  # noqa: BLE001
            log.warning("live: topup nudge stage3 failed (non-fatal): %s", exc)

        stored_report = await report_col.find_one(
            {"session_id": session_id}, {"_id": 0})
        return {"session": _safe_session(session), "report": stored_report}

    # ------------------- reconciliation / expiry sweep -------------------- #
    async def _reconcile(*, max_pending_minutes: int = 15) -> dict:
        """Expire stale reservations and RETRY failed refunds.

        Safe to call repeatedly (idempotent via the finalize lock + refund
        flags). Returns a small summary for the admin endpoint.
        """
        cutoff = (_now() - timedelta(minutes=max_pending_minutes)).isoformat()
        expired = 0
        retried = 0
        # 1. Stale reserving/pending_reserved/active sessions that never
        #    finalized (e.g. the WS never connected, or a crash mid-start).
        stale_cur = sess_col.find({
            "finalized": {"$ne": True},
            "state": {"$in": ["reserving", "pending_reserved", "active", "finalizing"]},
            "created_at": {"$lt": cutoff},
        })
        async for s in stale_cur:
            try:
                await _finalize_session(
                    s["session_id"], outcome="failed",
                    error_reason="expired_reconcile")
                expired += 1
            except Exception as exc:  # noqa: BLE001
                log.warning("live: reconcile expire failed sid=%s: %s",
                            s.get("session_id"), exc)
        # 2. Retry refunds that FAILED, or that are STALE pending/processing.
        #    A FRESH in-progress refund (recent refund_processing_at) is NOT
        #    retried here — _do_refund's lock would reject it anyway, but we
        #    also avoid even attempting it to prevent needless contention.
        proc_cutoff = (_now() - timedelta(seconds=_REFUND_STALE_SECONDS)).isoformat()
        retry_cur = sess_col.find({
            "refunded": {"$ne": True},
            "$or": [
                {"refund_state": "refund_failed"},
                {"refund_state": {"$in": ["refund_pending", "refund_processing"]},
                 "refund_processing_at": {"$lt": proc_cutoff}},
                # legacy/edge: pending with no processing timestamp at all.
                {"refund_state": "refund_pending",
                 "refund_processing_at": {"$exists": False}},
            ],
        })
        async for s in retry_cur:
            amount = int(s.get("charged_amount") or 0)
            ok = await _do_refund(
                s["session_id"], s.get("clean_id", ""), amount,
                "reconcile_retry")
            if ok:
                retried += 1
        return {"expired": expired, "refunds_retried": retried}

    async def _sweep_student_stale(clean_id: str) -> None:
        """Opportunistic, best-effort: expire THIS student's own stale
        reservations so a crashed prior session never permanently blocks a
        new start. Never raises."""
        cutoff = (_now() - timedelta(minutes=15)).isoformat()
        try:
            cur = sess_col.find({
                "clean_id": clean_id,
                "finalized": {"$ne": True},
                "state": {"$in": ["reserving", "pending_reserved", "active", "finalizing"]},
                "created_at": {"$lt": cutoff},
            })
            async for s in cur:
                await _finalize_session(
                    s["session_id"], outcome="failed",
                    error_reason="expired_on_new_start")
        except Exception as exc:  # noqa: BLE001
            log.warning("live: student stale sweep failed: %s", exc)

    # ----------------- indexes + background reconciliation ---------------- #
    _bg_state = {"started": False}
    _RECONCILE_SECONDS = max(
        60, int(os.environ.get("EDUTALK_LIVE_RECONCILE_SECONDS", "300") or 300))

    async def _ensure_indexes() -> None:
        """Create the indexes for the new live collections (idempotent)."""
        try:
            await sess_col.create_index("session_id", unique=True)
            await sess_col.create_index([("clean_id", 1), ("state", 1)])
            await sess_col.create_index("created_at")
            await sess_col.create_index([("refund_state", 1), ("refunded", 1)])
            await sess_col.create_index([("clean_id", 1), ("day", 1)])
            await report_col.create_index("session_id", unique=True)
            await report_col.create_index([("student_id", 1), ("created_at", -1)])
            await usage_col.create_index("ts")
            await usage_col.create_index([("student_id", 1), ("ts", -1)])
            # Phase 1 Smart Top-Up Nudge — one cap document per student.
            await nudge_col.create_index("clean_id", unique=True)
            log.info("edutalk_live: indexes ensured")
        except Exception as exc:  # noqa: BLE001
            log.warning("live: ensure_indexes failed (non-fatal): %s", exc)

    async def _reconcile_loop() -> None:
        """Scheduled background reconciliation — expires stale reservations and
        retries failed refunds every EDUTALK_LIVE_RECONCILE_SECONDS (default
        300s). Runs for the lifetime of the process."""
        while True:
            try:
                await asyncio.sleep(_RECONCILE_SECONDS)
                summary = await _reconcile()
                if summary.get("expired") or summary.get("refunds_retried"):
                    log.info("edutalk_live: scheduled reconcile %s", summary)
            except asyncio.CancelledError:
                break
            except Exception as exc:  # noqa: BLE001
                log.warning("live: scheduled reconcile error: %s", exc)

    def _ensure_background() -> None:
        """Lazily bootstrap indexes + the scheduled reconcile loop on the first
        request (the event loop is guaranteed running here). Starts exactly
        once for the process. This avoids touching server.py's startup hooks
        while still giving automatic, scheduled reconciliation."""
        if _bg_state["started"]:
            return
        _bg_state["started"] = True
        try:
            loop = asyncio.get_event_loop()
            loop.create_task(_ensure_indexes())
            loop.create_task(_reconcile_loop())
            log.info(
                "edutalk_live: background reconcile started (every %ss)",
                _RECONCILE_SECONDS)
        except Exception as exc:  # noqa: BLE001
            _bg_state["started"] = False
            log.warning("live: could not start background tasks: %s", exc)

    # --------------------------- admin routes ----------------------------- #
    @api.get("/admin/edutalk-live/config")
    async def admin_get_live_config(admin=Depends(require_admin)):
        _ = admin
        _ensure_background()
        cfg = await _load_config()
        return {"success": True, "config": cfg, "status": _public_status()}

    @api.put("/admin/edutalk-live/config")
    async def admin_put_live_config(payload: dict, admin=Depends(require_admin)):
        admin_email = str(getattr(admin, "email", "") or getattr(admin, "username", ""))
        incoming = payload.get("config", payload)
        # Phase 1 Smart Top-Up Nudge — REJECT invalid input (no silent
        # clamping), mirroring edutalkLiveRewardSchema.js's reject pattern and
        # using feature-specific reason codes.
        ok, reason = _validate_topup_nudge_fields(
            incoming if isinstance(incoming, dict) else {})
        if not ok:
            raise HTTPException(status_code=400, detail=reason)
        # Phase 1 Teacher Daravuth persona — REJECT invalid input BEFORE save
        # (no silent clamping), with stable feature-specific reason codes.
        ok_t, reason_t = _validate_teacher_persona_fields(
            incoming if isinstance(incoming, dict) else {})
        if not ok_t:
            raise HTTPException(status_code=400, detail=reason_t)
        cfg = await _save_config(incoming, admin_email)
        return {"success": True, "config": cfg, "status": _public_status()}

    @api.get("/admin/edutalk-live/usage")
    async def admin_get_usage(admin=Depends(require_admin), limit: int = 100):
        _ = admin
        limit = max(1, min(int(limit or 100), 500))
        cur = usage_col.find({}, {"_id": 0}).sort("ts", -1).limit(limit)
        rows = [r async for r in cur]
        return {"success": True, "usage": rows}

    @api.get("/admin/edutalk-live/reports")
    async def admin_get_reports(admin=Depends(require_admin), limit: int = 100):
        _ = admin
        cfg = await _load_config()
        if not cfg.get("teacher_can_view_reports", True):
            return {"success": True, "reports": [], "disabled": True}
        limit = max(1, min(int(limit or 100), 500))
        cur = report_col.find({}, {"_id": 0, "transcript": 0}).sort(
            "created_at", -1).limit(limit)
        rows = [r async for r in cur]
        return {"success": True, "reports": rows}

    @api.post("/admin/edutalk-live/reconcile")
    async def admin_reconcile(admin=Depends(require_admin)):
        """Expire stale reservations + retry any failed refunds. Idempotent and
        safe to call any time (also runs opportunistically on session start)."""
        _ = admin
        summary = await _reconcile()
        # Surface how many refunds are still outstanding for visibility.
        outstanding = await sess_col.count_documents({
            "refund_state": {"$in": ["refund_failed", "refund_pending"]},
            "refunded": {"$ne": True},
        })
        return {"success": True, **summary, "refunds_outstanding": outstanding,
                "status": _public_status()}

    # ----------------------- per-student helpers -------------------------- #
    async def _trial_status(clean_id: str, cfg: dict, tier_rule: dict) -> dict:
        """Authoritative, per-student free-trial availability. Counts the
        student's own consumed trials against the configured allowance."""
        allowance = int(cfg.get("free_trial_sessions", 0))
        if allowance <= 0:
            return {"available": False, "remaining": 0, "consumed": 0}
        consumed = await sess_col.count_documents({
            "clean_id": clean_id, "is_trial": True,
            "state": {"$in": ["completed_charged", "cancelled_partial", "expired"]},
        })
        remaining = max(0, allowance - consumed)
        return {"available": remaining > 0, "remaining": remaining,
                "consumed": consumed}

    async def _limited_free_status(clean_id: str, book_slug: str, tier: str,
                                   tier_rule: dict) -> dict:
        """Limited-edition tier: N free sessions per book (config-driven).
        Counts the student's prior completed limited sessions for this book."""
        if tier != "limited":
            return {"eligible": False, "remaining": 0}
        per_book = int(tier_rule.get("free_sessions_per_book", 0))
        if per_book <= 0 or not book_slug:
            return {"eligible": False, "remaining": 0}
        used = await sess_col.count_documents({
            "clean_id": clean_id, "tier": "limited", "book_slug": book_slug,
            "limited_free": True,
            "state": {"$in": ["completed_charged", "cancelled_partial", "expired"]},
        })
        remaining = max(0, per_book - used)
        return {"eligible": remaining > 0, "remaining": remaining}

    # -------------------------- student routes ---------------------------- #
    @api.get("/student/edutalk-live/config")
    async def student_get_config(student=Depends(require_student)):
        _ensure_background()
        clean_id = str(getattr(student, "clean_id", ""))
        cfg = await _load_config()
        st = _public_status()
        feature_live = (
            bool(cfg.get("enabled"))
            and st["gemini_configured"]
            and st["points_helpers_ok"]
            and st["websockets_lib_ok"]
        )
        # Expose only the student-safe slice of the config.
        modes_out = []
        for mkey, m in (cfg.get("modes") or {}).items():
            if m.get("enabled"):
                modes_out.append({
                    "key": mkey,
                    "label": m.get("label", mkey),
                    "cost_points": int(m.get("cost_points", 0)),
                    "duration_seconds": int(m.get("duration_seconds", 0)),
                })
        # AUTHORITATIVE per-student trial availability (backend decides — the
        # UI must not guess). Computed against the student's own consumed trials.
        trial = await _trial_status(clean_id, cfg, {}) if feature_live else {
            "available": False, "remaining": 0, "consumed": 0}

        # ── Phase 1 Smart Top-Up Nudge — STAGE 1: read-only, mode-specific
        # PREVIEW. Never consumes a weekly slot, never written to storage,
        # never reaches Gemini. Keyed by the SAME stable mode key as
        # ``modes_out``. The frontend selects the matching entry on mode
        # change and never recomputes balance-minus-cost itself.
        topup_previews: dict[str, Any] = {}
        nudge_enabled = bool(cfg.get("topup_nudge_enabled"))
        # v2.2 blocker fix: surface weekly-cap availability AT THE TOP LEVEL
        # of the config response so the frontend client-side fallback (which
        # runs when the backend preview reason is ``balance_unavailable_for_preview``)
        # can gate the pill on the real cap state. The per-mode preview only
        # carries ``weekly_cap_available`` when numeric figures are available;
        # the client fallback path needs the cap status independently.
        cap_available = False
        cap_reason = "feature_disabled"
        if feature_live and nudge_enabled:
            threshold = int(cfg.get("topup_nudge_threshold", 0))
            cap = int(cfg.get("topup_nudge_max_per_week", 0))
            # Migration-aware balance source. USE_MONGO_POINTS_READ gates the
            # student-facing balance read (default OFF = GAS source of truth →
            # NO numeric preview; ON = Mongo authoritative via the public
            # WalletService method). Stage 2/3 are unaffected by this flag.
            _flag = (os.environ.get("USE_MONGO_POINTS_READ") or "").strip().lower()
            flag_on = _flag in ("true", "1", "yes")
            preview_balance = None
            if flag_on:
                preview_balance, _bal_ok = await _wallet_balance_via_public_method(
                    db, clean_id)
                if not _bal_ok:
                    preview_balance = None
            # Read-only weekly-cap availability (NEVER consumes a slot).
            cap_available, cap_reason = await _topup_cap_status(
                nudge_col, clean_id=clean_id, cap=cap)
            for m in modes_out:
                topup_previews[m["key"]] = _topup_preview_for_mode(
                    enabled=True, flag_on=flag_on, balance=preview_balance,
                    mode_cost=int(m["cost_points"]), threshold=threshold,
                    weekly_cap_available=cap_available, cap_reason=cap_reason)

        return {
            "success": True,
            "available": feature_live,
            "beta": bool(cfg.get("beta_enabled")),
            "reason": "" if feature_live else "not_available",
            "modes": modes_out,
            "free_trial_seconds": int(cfg.get("free_trial_seconds", 0)),
            "free_trial_sessions": int(cfg.get("free_trial_sessions", 0)),
            "free_trial_available": bool(trial["available"]),
            "free_trial_remaining": int(trial["remaining"]),
            "daily_session_limit": int(cfg.get("daily_session_limit", 0)),
            "max_session_seconds": int(cfg.get("max_session_seconds", 300)),
            "language_mode": cfg.get("default_language_mode"),
            # Phase 1 Smart Top-Up Nudge — empty {} when disabled (zero change).
            "topup_nudge_enabled": nudge_enabled,
            # Admin threshold the client fallback compares against when the
            # backend preview is balance-gated. Exposed (non-secret) ONLY when
            # the nudge is enabled, so a disabled feature stays zero-change.
            "topup_nudge_threshold": int(cfg.get("topup_nudge_threshold", 0)) if nudge_enabled else 0,
            # v2.2 blocker fix — safe (non-secret) weekly-cap status so the
            # client-side fallback (used when the backend preview is
            # balance-gated) can suppress the pill once the cap is exhausted.
            # Always false when the feature is disabled / not live. The actual
            # numeric count is NEVER exposed — only a boolean and a reason.
            "topup_nudge_cap_available": bool(cap_available),
            "topup_nudge_cap_reason": cap_reason,
            "topup_nudge_previews_by_mode": topup_previews,
        }

    @api.post("/student/edutalk-live/session/start")
    async def student_start_session(
        payload: StartSessionRequest, student=Depends(require_student),
    ):
        clean_id = str(getattr(student, "clean_id", ""))
        display_name = str(getattr(student, "display_name", ""))
        cfg = await _load_config()
        st = _public_status()

        # 1. Master gates.
        if not cfg.get("enabled"):
            raise HTTPException(status_code=403, detail="Live Coach is disabled")
        if not st["gemini_configured"]:
            raise HTTPException(status_code=503, detail="Gemini not configured")
        if not st["points_helpers_ok"]:
            raise HTTPException(status_code=503, detail="Points system unavailable")
        if not st["websockets_lib_ok"]:
            raise HTTPException(status_code=503, detail="Live bridge unavailable")

        # 2. Mode validation.
        mode_key = payload.mode
        mode_cfg = (cfg.get("modes") or {}).get(mode_key)
        if not mode_cfg or not mode_cfg.get("enabled"):
            raise HTTPException(status_code=400, detail="Mode not available")

        # 3. Tier access (resolved from the book tier the Reader sent).
        tier = (payload.book_tier or "free").strip().lower()
        if tier not in VALID_TIERS:
            tier = "free"
        tier_rule = (cfg.get("tier_rules") or {}).get(tier, {})
        if not tier_rule.get("enabled", True):
            raise HTTPException(status_code=403, detail="Not available for your tier")

        # 0. Opportunistic reconciliation — expire THIS student's crashed/stale
        # reservations so a previous failure never permanently blocks a start.
        await _sweep_student_stale(clean_id)

        # 4. Idempotency — block a rapid double-start for the same student.
        #    Only a NON-expired live session blocks (stale ones were swept above).
        recent_cutoff = (_now() - timedelta(minutes=15)).isoformat()
        existing = await sess_col.find_one({
            "clean_id": clean_id,
            "finalized": {"$ne": True},
            "state": {"$in": ["pending_reserved", "active"]},
            "created_at": {"$gte": recent_cutoff},
        })
        if existing:
            # Return the live session instead of charging again.
            return {
                "success": True, "resumed": True,
                **_start_response(existing, cfg),
            }
        if payload.client_idempotency_key:
            dup = await sess_col.find_one({
                "clean_id": clean_id,
                "client_idempotency_key": payload.client_idempotency_key,
            })
            if dup:
                return {"success": True, "resumed": True,
                        **_start_response(dup, cfg)}

        # 5. Daily session limit (count today's chargeable sessions).
        daily_limit = int(cfg.get("daily_session_limit", 0))
        if daily_limit > 0:
            used_today = await sess_col.count_documents({
                "clean_id": clean_id,
                "day": _today_key(),
                "state": {"$in": ["completed_charged", "active", "pending_reserved", "finalizing"]},
            })
            if used_today >= daily_limit:
                raise HTTPException(status_code=429, detail="Daily limit reached")

        # 6. Pricing: free-trial → limited-free-per-book → tier-discounted cost.
        base_cost = int(mode_cfg.get("cost_points", 0))
        duration = int(mode_cfg.get("duration_seconds", cfg.get("max_session_seconds", 300)))
        duration = min(duration, int(cfg.get("max_session_seconds", 300)))

        trial = await _trial_status(clean_id, cfg, tier_rule)
        trial_only = bool(tier_rule.get("trial_only", False))
        limited = await _limited_free_status(clean_id, payload.book_slug, tier, tier_rule)

        is_trial = bool(trial["available"])
        limited_free = bool(limited["eligible"]) and not is_trial

        if not is_trial and not limited_free and trial_only:
            # Trial-only tier (e.g. free) with the trial allowance exhausted.
            raise HTTPException(status_code=403,
                                detail="Free trial used. Upgrade to continue.")

        discount = int(tier_rule.get("discount_percent", 0))
        if is_trial or limited_free:
            cost = 0
        else:
            cost = max(0, round(base_cost * (100 - discount) / 100))
        if is_trial:
            duration = min(duration, int(cfg.get("free_trial_seconds", 60)) or duration)

        # 6b. SAFETY: never charge points we cannot refund. If the treasury
        # refund path is not configured, only zero-cost (trial / limited-free)
        # sessions are allowed — paid sessions are blocked.
        if cost > 0 and not st.get("refund_path_ok"):
            raise HTTPException(
                status_code=503,
                detail="Paid Live Coach sessions are temporarily unavailable "
                       "(refunds not configured). Please try again later.")

        # ── Order of operations (points safety) ──
        # (5) PERSIST the session record BEFORE any money moves, then
        # (7) balance check, (8) debit, then atomically flip to
        # pending_reserved. If the post-debit flip fails (6) we immediately
        # refund the debit via the treasury credit path and log a CRITICAL
        # recoverable error — points are never silently lost.
        session_id = secrets.token_hex(12)
        ws_token = secrets.token_urlsafe(24)

        # Resolve recent reports for personalisation.
        prev_reports = []
        if cfg.get("book_context", {}).get("use_previous_reports"):
            cur = report_col.find(
                {"student_id": clean_id},
                {"_id": 0, "pronunciation_focus": 1, "next_mission": 1},
            ).sort("created_at", -1).limit(2)
            prev_reports = [r async for r in cur]

        # v1.5 — sanitize the optional language preference + points hint.
        # The hint is DISPLAY-ONLY for the greeting; never read by billing.
        explain_language = (payload.explain_language or "km").strip().lower()
        if explain_language not in ("km", "en"):
            explain_language = "km"
        points_hint = payload.points_balance_hint
        if points_hint is not None:
            try:
                points_hint = max(0, min(int(points_hint), 10_000_000))
            except Exception:
                points_hint = None

        # Captured as kwargs so the SAME builder can be re-invoked with
        # voice_authorized=True after a successful Stage 2 authorization
        # (the nudge line is added BY _build_system_instruction).
        _si_kwargs = dict(
            cfg=cfg, mode_key=mode_key, mode_cfg=mode_cfg,
            student_name=(display_name or "the student").split(" ")[0],
            points_balance=None,
            book_title=payload.book_title, chapter_title=payload.chapter_title,
            current_paragraph=payload.current_paragraph,
            reading_progress=payload.reading_progress,
            saved_words=payload.saved_words, previous_reports=prev_reports,
            explain_language=explain_language,
        )
        system_instruction = _build_system_instruction(**_si_kwargs)

        now = _now()
        doc = {
            "session_id": session_id,
            "ws_token": ws_token,
            "clean_id": clean_id,
            "display_name": display_name,
            # NOTE: the student password is intentionally NEVER stored. The
            # reserve debit uses it transiently; refunds use the server-side
            # treasury credit path (no student password needed).
            "mode": mode_key,
            "tier": tier,
            "is_trial": is_trial,
            "limited_free": limited_free,
            # Created in a transient "reserving" state BEFORE the debit. Only
            # flipped to "pending_reserved" after the debit succeeds.
            "state": "reserving",
            "charged_amount": 0,
            "reserved_intent": cost,
            "refunded": False,
            "refund_state": "none",
            "finalized": False,
            "book_slug": payload.book_slug,
            "book_title": payload.book_title,
            "chapter_idx": payload.chapter_idx,
            "chapter_title": payload.chapter_title,
            "duration_seconds": duration,
            "system_instruction": system_instruction,
            "client_idempotency_key": payload.client_idempotency_key,
            # v1.5 — used by the greeting kicker only. NEVER touched by
            # billing / reserve / refund / finalize logic.
            "explain_language": explain_language,
            "points_balance_hint": points_hint,
            "transcript": [],
            "day": _today_key(),
            "created_at": now.isoformat(),
            "expires_at": (now + timedelta(minutes=15)).isoformat(),
        }

        # (5) Persist BEFORE debiting.
        try:
            await sess_col.insert_one(doc)
        except Exception as exc:  # noqa: BLE001
            log.error("live: session persist failed pre-debit: %s", exc)
            raise HTTPException(status_code=500,
                                detail="Could not start session")

        # (7) Balance check (source of truth = GAS, same as EduTalk).
        if cost > 0:
            bal, berr = await _gas_get_balance(clean_id, payload.password)
            if bal is None or bal < cost:
                await sess_col.update_one(
                    {"session_id": session_id},
                    {"$set": {"state": "expired", "finalized": True,
                              "end_reason": "insufficient_or_unverified_balance",
                              "ended_at": _iso()}})
                if bal is None:
                    raise HTTPException(status_code=502,
                                        detail="Could not verify points balance")
                raise HTTPException(status_code=402, detail="Not enough points")

        # (8) RESERVE (debit) points.
        charged = 0
        if cost > 0:
            ok, err = await _reserve_points(clean_id, payload.password, cost)
            if not ok:
                await sess_col.update_one(
                    {"session_id": session_id},
                    {"$set": {"state": "expired", "finalized": True,
                              "end_reason": "reserve_failed", "ended_at": _iso()}})
                await _log_usage(student, "session_start", "reserve_failed",
                                 0, mode=mode_key, session_id=session_id,
                                 error_reason=err)
                raise HTTPException(status_code=402,
                                    detail="Could not reserve points")
            charged = cost

            # (6) Persist the successful charge. If THIS fails, the student was
            # debited but the session can't proceed → refund immediately.
            try:
                res = await sess_col.update_one(
                    {"session_id": session_id, "finalized": {"$ne": True}},
                    {"$set": {"state": "pending_reserved",
                              "charged_amount": charged}})
                if res.matched_count == 0:
                    raise RuntimeError("session_vanished_or_finalized")
            except Exception as exc:  # noqa: BLE001
                refund_ok, refund_err = await _gas_treasury_credit(clean_id, charged)
                log.critical(
                    "live: CRITICAL post-debit persist failed sid=%s charged=%d "
                    "exc=%s immediate_refund_ok=%s refund_err=%s",
                    session_id, charged, exc, refund_ok, refund_err)
                try:
                    await sess_col.update_one(
                        {"session_id": session_id},
                        {"$set": {
                            "state": "failed_refunded" if refund_ok else "finalizing",
                            "finalized": True,
                            "charged_amount": charged,
                            "final_charged": 0 if refund_ok else charged,
                            "refunded": bool(refund_ok),
                            "refund_state": "refunded" if refund_ok else "refund_failed",
                            "refund_amount": charged,
                            "refund_error": "" if refund_ok else str(refund_err)[:160],
                            "end_reason": "post_debit_persist_failed",
                            "ended_at": _iso()}})
                except Exception:
                    pass
                await _log_usage(student, "session_start",
                                 "post_debit_persist_failed",
                                 0 if refund_ok else charged, mode=mode_key,
                                 session_id=session_id, error_reason=str(exc)[:120])
                raise HTTPException(
                    status_code=500,
                    detail="Could not start session"
                    + (" (points refunded)" if refund_ok else
                       " (refund queued — please contact support if not returned)"))
        else:
            await sess_col.update_one(
                {"session_id": session_id, "finalized": {"$ne": True}},
                {"$set": {"state": "pending_reserved"}})

        doc["state"] = "pending_reserved"
        doc["charged_amount"] = charged

        # ── Phase 0A — server-owned greeting context snapshot. ADDITIVE and
        # DISPLAY-ONLY: it is NEVER read by debit/reserve/refund/finalize. It
        # captures the four greeting facts at start so the greeting script is
        # built from server truth (not a re-fetch). For a paid session the
        # points figure is `bal - charged` (post-reservation, GAS-verified);
        # otherwise the existing validated client display hint is used; if
        # neither exists the points category is explicitly "unavailable".
        try:
            _g_points = None
            _g_points_source = "unavailable"
            if charged > 0 and bal is not None:
                _g_points = int(bal) - int(charged)
                _g_points_source = "gas_verified_post_reservation"
            elif points_hint is not None:
                _g_points = int(points_hint)
                _g_points_source = "client_display_hint"
            greeting_context = {
                "student_first_name": (display_name or "").split(" ")[0] or "",
                "points_value": _g_points,
                "points_source": _g_points_source,
                "book_title": payload.book_title or "",
                "book_slug": payload.book_slug or "",
                "chapter_title": payload.chapter_title or "",
                "mode": mode_key,
                "explain_language": explain_language,
                # Phase 1 (Bug 5) — teacher persona facts captured at start so
                # the single validated greeting script (not a second path) owns
                # the at-most-once natural teacher mention.
                "teacher_persona_enabled": bool(cfg.get("teacher_persona_enabled")),
                "teacher_display_name": str(cfg.get("teacher_display_name") or ""),
                "mention_teacher_in_greeting": bool(
                    cfg.get("mention_teacher_in_greeting")),
            }
            doc["greeting_context"] = greeting_context
            await sess_col.update_one(
                {"session_id": session_id},
                {"$set": {"greeting_context": greeting_context}})
        except Exception as exc:  # noqa: BLE001
            log.warning("live: greeting context snapshot failed: %s", exc)

        # ── Phase 1 Smart Top-Up Nudge — STAGE 2 AUTHORIZATION ──
        # Created ONLY after the EXISTING reservation succeeded. Reuses `bal`
        # (the pre-reservation balance captured at step 7) and `charged`
        # (step 8) — NEVER re-fetched or re-subtracted. Eligible only when the
        # post-reservation balance is at/under threshold AND a weekly-cap slot
        # is available via the shared, concurrency-safe Section 3 helper. On
        # success ONE non-numeric line is added to Gemini's system instruction.
        # Wrapped so an additive-feature failure NEVER affects billing/session.
        if charged > 0 and bool(cfg.get("topup_nudge_enabled")):
            try:
                threshold = int(cfg.get("topup_nudge_threshold", 0))
                post_reservation_balance = int(bal) - int(charged)
                if threshold >= 0 and post_reservation_balance <= threshold:
                    cap = int(cfg.get("topup_nudge_max_per_week", 0))
                    slot = await _consume_topup_nudge_slot(
                        nudge_col, clean_id=clean_id, session_id=session_id,
                        authorization_source="session_start", cap=cap)
                    if slot["reason"] in ("authorized", "idempotent"):
                        auth_block = {
                            "balance_before_reservation": int(bal),
                            "points_reserved": int(charged),
                            "post_reservation_balance": post_reservation_balance,
                            "threshold": threshold,
                            "voice_authorized": True,
                            "authorized_at": _iso(),
                        }
                        await sess_col.update_one(
                            {"session_id": session_id},
                            {"$set": {"topup_nudge": {
                                "event_key": _topup_nudge_event_key(
                                    clean_id, session_id),
                                "clean_id": clean_id,
                                "session_id": session_id,
                                "authorization_source": "session_start",
                                "authorization": auth_block,
                            }}})
                        # Add the SINGLE non-numeric nudge line to Gemini's
                        # system instruction (rebuilt via the same builder).
                        new_si = _build_system_instruction(
                            **_si_kwargs, voice_authorized=True)
                        await sess_col.update_one(
                            {"session_id": session_id},
                            {"$set": {"system_instruction": new_si}})
            except Exception as exc:  # noqa: BLE001
                log.warning(
                    "live: topup nudge stage2 failed (non-fatal): %s", exc)

        await _log_usage(student, "session_start", "pending_reserved", charged,
                         mode=mode_key, session_id=session_id)

        return {"success": True, "resumed": False, **_start_response(doc, cfg)}

    @api.post("/student/edutalk-live/session/end")
    async def student_end_session(
        payload: EndSessionRequest, student=Depends(require_student),
    ):
        clean_id = str(getattr(student, "clean_id", ""))
        session = await sess_col.find_one({"session_id": payload.session_id})
        if not session or session.get("clean_id") != clean_id:
            raise HTTPException(status_code=404, detail="Session not found")
        # Use the SAME shared end-reason mapper as the WebSocket bridge so the
        # REST fallback never defaults a non-completion reason to "completed".
        if not session.get("active_ts"):
            # Never became active → full refund regardless of reason.
            outcome = "failed"
        else:
            outcome = _map_end_reason(payload.reason)
        result = await _finalize_session(
            payload.session_id, outcome=outcome,
            transcript=payload.transcript or None,
            error_reason=payload.reason)
        return {"success": True, **result}

    @api.get("/student/edutalk-live/history")
    async def student_history(student=Depends(require_student), limit: int = 20):
        clean_id = str(getattr(student, "clean_id", ""))
        limit = max(1, min(int(limit or 20), 100))
        cur = report_col.find(
            {"student_id": clean_id},
            {"_id": 0, "transcript": 0},
        ).sort("created_at", -1).limit(limit)
        rows = [r async for r in cur]
        return {"success": True, "history": rows}

    @api.get("/student/edutalk-live/report/{session_id}")
    async def student_report(session_id: str, student=Depends(require_student)):
        clean_id = str(getattr(student, "clean_id", ""))
        cfg = await _load_config()
        if not cfg.get("student_can_view_report", True):
            raise HTTPException(status_code=403, detail="Reports are disabled")
        report = await report_col.find_one(
            {"session_id": session_id, "student_id": clean_id}, {"_id": 0})
        if not report:
            raise HTTPException(status_code=404, detail="Report not found")
        return {"success": True, "report": report}

    @api.get("/student/edutalk-live/topup-nudge/{session_id}")
    async def student_topup_nudge(session_id: str,
                                  student=Depends(require_student)):
        """Phase 1 Smart Top-Up Nudge — report-pill data for ONE session.

        Returns ONLY the Stage 3 ``finalization`` block (the report pill
        renders solely from the finalized balance — never Stage 1/Stage 2
        numbers, never the session-start balance). Owned by the requesting
        student. Safe to call before finalization completes (returns
        report_eligible=false until the record is written)."""
        clean_id = str(getattr(student, "clean_id", ""))
        cfg = await _load_config()
        if not bool(cfg.get("topup_nudge_enabled")):
            return {"success": True, "enabled": False, "report_eligible": False,
                    "reason": "config_disabled", "finalization": None}
        session = await sess_col.find_one(
            {"session_id": session_id, "clean_id": clean_id})
        if not session:
            raise HTTPException(status_code=404, detail="Session not found")
        tn = session.get("topup_nudge") or {}
        fin = tn.get("finalization")
        return {
            "success": True,
            "enabled": True,
            "session_id": session_id,
            "report_eligible": bool((fin or {}).get("report_eligible")),
            "reason": (fin or {}).get("reason", "pending"),
            "finalization": fin,
        }

    @api.post("/student/edutalk-live/topup-nudge/visibility")
    async def student_topup_nudge_visibility(
            payload: TopupVisibilityRequest,
            student=Depends(require_student)):
        """Phase 0B — record ONE normalized Top-Up pill VISIBILITY decision.

        DIAGNOSTICS ONLY. This endpoint NEVER alters eligibility, cap, wallet,
        payment, or session charging — it appends a bounded
        ``pill_visibility_decision`` row to the student's EXISTING unique
        ``edutalk_live_topup_nudge_log`` document (one document per student, so
        we append to a ``visibility_decisions`` array rather than insert new
        documents that would violate the unique index). Only the newest
        ``MAX_VISIBILITY_DECISIONS`` rows are kept via ``$push/$each/$slice``.
        Validated allowlists already guarantee no internal strings are stored.
        """
        clean_id = str(getattr(student, "clean_id", ""))
        if not clean_id:
            raise HTTPException(status_code=401, detail="Unauthenticated")
        event = {
            "event_type": "pill_visibility_decision",
            "clean_id": clean_id,
            "session_id": payload.session_id or "",
            "phase": payload.phase,
            "mode": payload.mode or "",
            "pill_shown": bool(payload.pill_shown),
            "reason": payload.reason,
            "balance_source": payload.balance_source,
            "client_event_id": payload.client_event_id,
            "client_reported": True,
            "timestamp": _iso(),
        }
        try:
            await nudge_col.update_one(
                {"clean_id": clean_id},
                {
                    "$setOnInsert": {"clean_id": clean_id},
                    "$push": {"visibility_decisions": {
                        "$each": [event],
                        "$slice": -MAX_VISIBILITY_DECISIONS,
                    }},
                },
                upsert=True,
            )
        except Exception as exc:  # noqa: BLE001
            # Diagnostics must never break the client; report a soft failure.
            log.warning("live: topup visibility log failed: %s", exc)
            return {"success": False, "recorded": False}
        return {"success": True, "recorded": True}

    # ----------------------------- WebSocket ------------------------------ #
    @api.websocket("/student/edutalk-live/ws/{session_id}")
    async def live_ws(websocket: WebSocket, session_id: str):
        await websocket.accept()
        token = websocket.query_params.get("token", "")
        session = await sess_col.find_one({"session_id": session_id})

        # Auth + state validation.
        if (not session or not token or session.get("ws_token") != token
                or session.get("state") not in ("pending_reserved", "active")):
            await _ws_send(websocket, {"type": "error", "reason": "invalid_session"})
            await websocket.close()
            return

        cfg = await _load_config()
        st = _public_status()
        if not (st["gemini_configured"] and st["websockets_lib_ok"]):
            await _ws_send(websocket, {"type": "error", "reason": "live_unavailable"})
            await _finalize_session(session_id, outcome="failed",
                                    error_reason="live_unavailable")
            await websocket.close()
            return

        duration = int(session.get("duration_seconds")
                       or cfg.get("max_session_seconds", 300))
        try:
            await _run_live_bridge(
                websocket, session, duration, sess_col,
                finalize=_finalize_session)
        except WebSocketDisconnect:
            await _finalize_session(session_id, outcome="cancelled",
                                    error_reason="ws_disconnect")
        except Exception as exc:  # noqa: BLE001
            log.warning("live: ws bridge error sid=%s exc=%s", session_id, exc)
            try:
                await _ws_send(websocket, {"type": "error", "reason": "bridge_error"})
            except Exception:
                pass
            await _finalize_session(session_id, outcome="failed",
                                    error_reason=f"bridge_error:{type(exc).__name__}")
        finally:
            try:
                await websocket.close()
            except Exception:
                pass

    log.info("edutalk_live_tools: routes registered (Live Voice Coach Beta)")


# --------------------------------------------------------------------------- #
# Small helpers used by the route closures                                    #
# --------------------------------------------------------------------------- #
class _FakeStudent:
    """Minimal duck-typed student for usage logging from background paths."""
    def __init__(self, clean_id: str, display_name: str) -> None:
        self.clean_id = clean_id or ""
        self.display_name = display_name or ""


def _safe_session(session: dict) -> dict:
    """Strip backend-only secrets (e.g. the cached password) from a session
    doc before it is ever returned to a client."""
    if not session:
        return {}
    out = {k: v for k, v in session.items()
           if k not in ("_password", "ws_token", "system_instruction", "_id")}
    return out


def _build_greeting_kicker(session: dict, greeting_script: str | None = None) -> str:
    """v2 (Bug 5) — turn-boundary kicker that EMBEDS the validated server-built
    greeting script exactly once.

    Gemini Live with ``responseModalities=["AUDIO"]`` only emits audio after
    it receives a turn. Without a kicker the coach sits silent until the
    student talks. This kicker is a SHORT user-role turn-boundary instruction
    that tells the coach to SPEAK the provided validated greeting script.

    Bug 5 contract:
        * The validated server-built ``greeting_script`` (from
          ``_build_greeting_script`` + field assertion / safe fallback) is the
          SINGLE factual source for the spoken greeting.
        * This function does NOT independently re-derive the student name,
          points, book, chapter, or teacher mention. Those facts live ONLY in
          the embedded script, so the validated input reaches ``gem.send``
          exactly once.
        * Honest limitation preserved: embedding the script guarantees the
          validated INPUT to Gemini, not verified spoken OUTPUT.

    If ``greeting_script`` is omitted (defensive), it is built + validated here
    from the same server-owned snapshot so the kicker still carries the four
    factual categories exactly once.
    """
    lang = (session.get("explain_language") or "km").strip().lower()
    if lang not in ("km", "en"):
        lang = "km"

    script = (greeting_script or "").strip()
    if not script:
        built, ctx = _build_greeting_script(session)
        ok, _missing = _assert_greeting_fields(built, ctx)
        script = built if ok else _safe_fallback_greeting_script(ctx)

    if lang == "km":
        instruction = (
            "[SESSION_START] Greet the student NOW by speaking the greeting "
            "below in natural, warm Khmer (ភាសាខ្មែរ). Keep every fact exactly "
            "as written — the student's name, their points, the book and "
            "chapter, and the teacher if named. Do not add, remove, or invent "
            "any fact. You may keep proper nouns (names, the book title) in "
            "their original form. Speak it as ONE short, friendly spoken "
            "greeting (about three short sentences), then warmly invite the "
            "student to begin practising speaking English (their own answers "
            "stay in English). Do not read this instruction aloud."
        )
    else:
        instruction = (
            "[SESSION_START] Greet the student NOW by speaking the greeting "
            "below warmly in natural English. Keep every fact exactly as "
            "written — the student's name, their points, the book and chapter, "
            "and the teacher if named. Do not add, remove, or invent any fact. "
            "Speak it as ONE short, friendly spoken greeting, then warmly "
            "invite the student to begin practising speaking English. Do not "
            "read this instruction aloud."
        )
    # The script is embedded EXACTLY ONCE after the instruction marker.
    return f"{instruction}\n\nGREETING SCRIPT:\n{script}"


def _build_validated_greeting_payload(session: dict) -> tuple[dict, str, dict]:
    """Bug 5 — build the SINGLE Gemini greeting turn payload that carries the
    validated greeting script exactly once.

    Returns ``(payload, validated_script, context)`` where ``payload`` is the
    exact ``clientContent`` dict that ``_run_live_bridge`` passes to
    ``gem.send``. The validated script is built once via
    ``_build_greeting_script``, field-asserted, and (only on failure) replaced
    by the safe fallback — then embedded by ``_build_greeting_kicker`` without
    any second re-derivation path.
    """
    g_script, g_context = _build_greeting_script(session)
    ok, _missing = _assert_greeting_fields(g_script, g_context)
    if not ok:
        g_script = _safe_fallback_greeting_script(g_context)
    kicker = _build_greeting_kicker(session, g_script)
    payload = {
        "clientContent": {
            "turns": [{"role": "user", "parts": [{"text": kicker}]}],
            "turnComplete": True,
        }
    }
    return payload, g_script, g_context


# --------------------------------------------------------------------------- #
# Phase 0A — server-owned greeting facts + attempt-scoped lifecycle.           #
#                                                                              #
# These are ADDITIVE. `_build_greeting_kicker` above remains the Gemini turn   #
# trigger/wrapper (unchanged). The helpers below build the FACTUAL server-side #
# script used for a mandatory field assertion + telemetry, and drive an        #
# attempt-scoped greeting state machine over the existing WS frames. None of    #
# this verifies spoken audio output — it only guarantees the server emitted    #
# truthful greeting facts and lifecycle events the frontend gate relies on.    #
# --------------------------------------------------------------------------- #

# Allowlists mirrored by the frontend (liveCoachTopupNudgeLogic.js).
GREETING_POINTS_UNAVAILABLE_PHRASE = (
    "your current points balance could not be confirmed right now"
)


def _humanize_slug(slug: str | None) -> str:
    s = (slug or "").replace("-", " ").replace("_", " ").strip()
    return s.title() if s else ""


def _make_greeting_attempt_id() -> str:
    """Unguessable per-attempt id (hex). Distinct from session/ws tokens."""
    return secrets.token_hex(12)


def _resolve_greeting_context(session: dict | None) -> dict:
    """Resolve the four factual greeting categories from the server-owned
    snapshot persisted at session start, falling back to live session fields
    for resumed sessions that predate the snapshot. Uses EXISTING data only —
    never a fabricated points value."""
    session = session or {}
    snap = session.get("greeting_context") or {}

    name = str(snap.get("student_first_name") or "").strip()
    if not name:
        name = ((session.get("display_name") or "").split(" ")[0] or "").strip()
    student_label = name or "there"

    points_value = snap.get("points_value", None)
    points_source = str(snap.get("points_source") or "unavailable")
    if points_value is None and points_source == "unavailable":
        hint = session.get("points_balance_hint")
        if hint is not None:
            try:
                points_value = int(hint)
                points_source = "client_display_hint"
            except Exception:
                points_value = None
                points_source = "unavailable"

    book_title = str(snap.get("book_title") or session.get("book_title") or "").strip()
    book_slug = str(snap.get("book_slug") or session.get("book_slug") or "").strip()
    if book_title:
        book_label = book_title
    elif book_slug:
        book_label = _humanize_slug(book_slug) or "your current EduHub book"
    else:
        book_label = "your current EduHub book"

    chapter_title = str(
        snap.get("chapter_title") or session.get("chapter_title") or "").strip()
    chapter_label = chapter_title if chapter_title else "your current chapter"

    # Phase 1 (Bug 5) — teacher persona facts from the server-owned snapshot.
    # The single validated greeting script owns the AT-MOST-ONCE natural
    # teacher mention; the kicker never re-derives it. Resumed sessions that
    # predate the snapshot simply carry no teacher mention (honest limitation).
    teacher_persona_enabled = bool(snap.get("teacher_persona_enabled"))
    mention_teacher = bool(snap.get("mention_teacher_in_greeting"))
    teacher_name_raw = str(snap.get("teacher_display_name") or "").strip()
    teacher_name_ok = False
    if teacher_name_raw:
        teacher_name_ok, _ = _teacher_name_ok(teacher_name_raw)
    teacher_mention = bool(
        teacher_persona_enabled and mention_teacher and teacher_name_ok)
    teacher_name = teacher_name_raw if teacher_name_ok else ""

    return {
        "student_label": student_label,
        "points_value": points_value,
        "points_source": points_source,
        "book_label": book_label,
        "chapter_label": chapter_label,
        "teacher_mention": teacher_mention,
        "teacher_name": teacher_name,
    }


def _greeting_points_phrase(points_value) -> str:
    if points_value is not None:
        return f"You currently have {int(points_value)} EduHub points"
    return f"For now, {GREETING_POINTS_UNAVAILABLE_PHRASE}"


def _build_greeting_script(session: dict | None):
    """Build the deterministic FACTUAL greeting script (separate from the
    Gemini instruction wrapper). Always contains the four factual categories:
    student name, points (real number OR explicit unavailable phrase), book
    label, chapter label. Returns (script, context)."""
    ctx = _resolve_greeting_context(session)
    parts = [
        f"Hi {ctx['student_label']}!",
        _greeting_points_phrase(ctx["points_value"]) + ".",
        f"Today we will practise speaking English together using "
        f"{ctx['book_label']}.",
        f"We are on {ctx['chapter_label']}.",
    ]
    # Phase 1 (Bug 5) — at-most-once natural teacher mention. The validated
    # script is the SOLE owner of the spoken teacher mention; the kicker embeds
    # this script verbatim and never re-derives the teacher name in a second
    # path. (The system instruction may separately name the teacher as policy.)
    if ctx.get("teacher_mention") and ctx.get("teacher_name"):
        parts.append(
            f"We are practising for {ctx['teacher_name']}'s class today.")
    return " ".join(parts), ctx


def _assert_greeting_fields(script: str | None, context: dict | None):
    """Mandatory script-field assertion. Returns (ok, missing). Verifies the
    server-built script text contains the four factual categories. Does NOT
    claim spoken-output verification."""
    missing: list[str] = []
    s = script or ""
    ctx = context or {}

    label = str(ctx.get("student_label") or "")
    if label and label not in s:
        missing.append("student_name")

    pv = ctx.get("points_value")
    if pv is not None:
        if str(int(pv)) not in s:
            missing.append("points")
    else:
        if GREETING_POINTS_UNAVAILABLE_PHRASE not in s:
            missing.append("points")

    bl = str(ctx.get("book_label") or "")
    if bl and bl not in s:
        missing.append("book")

    cl = str(ctx.get("chapter_label") or "")
    if cl and cl not in s:
        missing.append("chapter")

    return (len(missing) == 0, missing)


def _safe_fallback_greeting_script(context: dict | None) -> str:
    """Minimal safe factual greeting used when the primary script fails the
    field assertion. Still contains all four factual categories."""
    ctx = context or {}
    label = ctx.get("student_label") or "there"
    book = ctx.get("book_label") or "your current EduHub book"
    chapter = ctx.get("chapter_label") or "your current chapter"
    out = (
        f"Hi {label}! {_greeting_points_phrase(ctx.get('points_value'))}. "
        f"Today we will practise speaking English together using {book}. "
        f"We are on {chapter}."
    )
    # Mirror the at-most-once teacher mention so the safe fallback still carries
    # the single natural teacher reference when the persona is enabled.
    if ctx.get("teacher_mention") and ctx.get("teacher_name"):
        out += f" We are practising for {ctx['teacher_name']}'s class today."
    return out


async def _send_greeting_state(client_ws: WebSocket, attempt_id: str,
                               state: str, *, reason: str | None = None) -> None:
    """Emit one attempt-scoped greeting_state frame to the browser."""
    frame = {
        "type": "greeting_state",
        "value": state,
        "greeting_attempt_id": attempt_id,
        "ts": _iso(),
    }
    if reason:
        frame["reason"] = reason
    await _ws_send(client_ws, frame)


async def _persist_greeting_state(sess_col, session_id: str, state: str, *,
                                  attempt_id: str | None = None,
                                  reason: str | None = None,
                                  extra: dict | None = None) -> None:
    """Persist greeting lifecycle markers. Best-effort: a persistence failure
    must never break the paid live session."""
    if sess_col is None or not session_id:
        return
    upd: dict = {"greeting_state": state, f"greeting_state_at.{state}": _iso()}
    if attempt_id is not None:
        upd["greeting_attempt_id"] = attempt_id
    if reason is not None:
        upd["greeting_fallback_reason"] = reason
    if extra:
        upd.update(extra)
    try:
        await sess_col.update_one({"session_id": session_id}, {"$set": upd})
    except Exception:
        pass


async def _emit_greeting_requested(client_ws: WebSocket, sess_col,
                                   session_id: str, attempt_id: str) -> None:
    """On a SUCCESSFUL kicker send: emit the authoritative
    `greeting_state=requested` frame AND the legacy `coach_greeting_sent`
    compatibility frame (now carrying the attempt id), and persist the
    requested marker."""
    await _send_greeting_state(client_ws, attempt_id, "requested")
    # Legacy compatibility frame — the new frontend treats it only as
    # "requested" and never arms the mic from it.
    await _ws_send(client_ws, {
        "type": "coach_greeting_sent",
        "greeting_attempt_id": attempt_id,
    })
    await _persist_greeting_state(
        sess_col, session_id, "requested", attempt_id=attempt_id)


async def _emit_greeting_failed(client_ws: WebSocket, sess_col,
                                session_id: str, attempt_id: str, *,
                                reason: str = "kicker_send_failed") -> None:
    """On a FAILED kicker send: emit + persist `failed`. The paid session
    bridge MUST continue (the frontend enters a controlled fallback)."""
    await _send_greeting_state(client_ws, attempt_id, "failed", reason=reason)
    await _persist_greeting_state(
        sess_col, session_id, "failed", attempt_id=attempt_id, reason=reason)


def _greeting_completed_ack(session: dict | None) -> dict | None:
    """Bug 6 — reconnect skip contract. Return the persisted COMPLETED greeting
    acknowledgement for a prior attempt, or ``None``.

    A greeting may be skipped on reconnect ONLY when the session carries a
    persisted CLIENT acknowledgement proving interaction already began:
      * ``greeting_client_ack_at.playback_complete`` (playback finished), or
      * ``greeting_mic_armed_at`` / ``greeting_client_ack_at.mic_armed`` (mic
        armed through the explicit arm path).

    A prior ``requested`` / ``first_audio`` / ``turn_complete`` WITHOUT a client
    acknowledgement is INCOMPLETE — it must restart with a fresh attempt id and
    a normal greeting (handled by the caller returning ``None`` here).

    Returns ``{"attempt_id": <id>, "via": "mic_armed"|"playback_complete"}``.
    """
    session = session or {}
    ack_at = session.get("greeting_client_ack_at")
    ack_at = ack_at if isinstance(ack_at, dict) else {}
    has_mic = bool(session.get("greeting_mic_armed_at")) or bool(
        ack_at.get("mic_armed"))
    has_playback = bool(ack_at.get("playback_complete"))
    if not (has_mic or has_playback):
        return None
    aid = str(session.get("greeting_attempt_id") or "")
    if not aid:
        return None
    return {"attempt_id": aid,
            "via": "mic_armed" if has_mic else "playback_complete"}


async def _emit_greeting_skipped(client_ws: WebSocket, sess_col,
                                 session_id: str, attempt_id: str, *,
                                 reason: str = "already_completed") -> None:
    """Bug 6 — emit + persist the explicit reconnect-skip frame. The frame
    carries BOTH ``attempt_id`` (the addendum contract) and
    ``greeting_attempt_id`` (existing frontend convention) with the same
    persisted completed-attempt id so the frontend adopts the authoritative
    id, cancels watchdogs, and arms the mic once through the skip path —
    never via a timeout."""
    frame = {
        "type": "greeting_state",
        "value": "skipped",
        "greeting_attempt_id": attempt_id,
        "attempt_id": attempt_id,
        "reason": reason,
        "ts": _iso(),
    }
    await _ws_send(client_ws, frame)
    await _persist_greeting_state(
        sess_col, session_id, "skipped", attempt_id=attempt_id, reason=reason)


_GREETING_CLIENT_ACK_VALUES = frozenset(
    {"playback_complete", "mic_armed", "fallback_requested"})


async def _handle_greeting_client_ack(frame: dict, greeting_ctx: dict | None,
                                      client_ws: WebSocket, sess_col,
                                      session_id: str) -> None:
    """Handle a client `greeting_client_ack` frame. Mismatched attempt ids are
    ignored. Matching acks are persisted. A matching `fallback_requested` marks
    the attempt cancelled (so later greeting audio is suppressed) and returns an
    attempt-scoped `greeting_state=cancelled`. A failing ack NEVER terminates
    the paid session.

    V3 item 3 — allowlist greeting acknowledgements. The ``value`` MUST be one
    of the three legitimate lifecycle ACKs; any other value (empty, unknown,
    containing a Mongo path delimiter ``.``, or starting with ``$``) is
    silently dropped BEFORE any Mongo field path is constructed. ``trigger``
    and ``reason`` are bounded to 128 characters; ``client_ts`` is validated
    as ISO 8601 (a malformed value is dropped — the frame is not written)."""
    if greeting_ctx is None:
        return
    aid = str(frame.get("greeting_attempt_id") or "")
    if not aid or aid != str(greeting_ctx.get("attempt_id") or ""):
        return  # ignore mismatched attempt ids
    value = str(frame.get("value") or "")
    # V3 item 3 — strict allowlist BEFORE any string formatting into a Mongo
    # field path. Empty / unknown / dotted / ``$``-prefixed values are dropped
    # silently (no write, no cancel, no greeting-state change).
    if value not in _GREETING_CLIENT_ACK_VALUES:
        return
    if "." in value or value.startswith("$"):
        return
    # V3 item 3 — validate client_ts as parseable ISO 8601; reject (no write)
    # if not. ``_iso()`` is substituted only when the client omitted the field
    # entirely.
    client_ts_raw = frame.get("client_ts")
    if client_ts_raw is None:
        client_ts = _iso()
    else:
        try:
            datetime.fromisoformat(str(client_ts_raw).replace("Z", "+00:00"))
        except Exception:
            return
        client_ts = str(client_ts_raw)
    # V3 item 3 — bound trigger/reason to a reasonable length. Truncate (not
    # reject) so a long but well-formed trigger does not silently lose the
    # whole ack.
    extra = {f"greeting_client_ack_at.{value}": client_ts}
    if value == "mic_armed":
        extra["greeting_mic_armed_at"] = client_ts
        trig = frame.get("trigger")
        if trig:
            extra["greeting_mic_armed_trigger"] = str(trig)[:128]
    if value == "fallback_requested":
        greeting_ctx["cancelled"] = True
        reason = str(frame.get("reason") or "fallback_requested")[:128]
        await _persist_greeting_state(
            sess_col, session_id, "cancelled", attempt_id=aid, reason=reason,
            extra=extra)
        await _send_greeting_state(client_ws, aid, "cancelled", reason=reason)
        return
    # playback_complete / mic_armed → persist only.
    if sess_col is not None and session_id:
        try:
            await sess_col.update_one(
                {"session_id": session_id}, {"$set": extra})
        except Exception:
            pass



def _start_response(session: dict, cfg: dict) -> dict:
    mode_cfg = (cfg.get("modes") or {}).get(session.get("mode"), {})
    return {
        "session_id": session.get("session_id"),
        "ws_token": session.get("ws_token"),
        "ws_path": f"/api/student/edutalk-live/ws/{session.get('session_id')}",
        "mode": session.get("mode"),
        "mode_label": mode_cfg.get("label", session.get("mode")),
        "is_trial": bool(session.get("is_trial")),
        "cost_points": int(session.get("charged_amount") or 0),
        "duration_seconds": int(session.get("duration_seconds") or 0),
        # Audio formats the frontend must honour.
        "input_sample_rate": 16000,
        "output_sample_rate": 24000,
    }


async def _ws_send(ws: WebSocket, obj: dict) -> None:
    await ws.send_text(json.dumps(obj))


# --------------------------------------------------------------------------- #
# The live bridge: EduHub WS  ⇄  Gemini Live WS                               #
# --------------------------------------------------------------------------- #
async def _run_live_bridge(client_ws: WebSocket, session: dict,
                           duration: int, sess_col, *, finalize) -> None:
    """Bidirectional relay between the student's browser WebSocket and the
    Gemini Live API. Accumulates a text transcript for the report.

    Client → backend frames (JSON text):
        {"type":"audio","data":"<base64 PCM16 16kHz>"}
        {"type":"text","data":"<typed text>"}
        {"type":"end"}
    Backend → client frames (JSON text):
        {"type":"ready"}
        {"type":"audio","data":"<base64 PCM16 24kHz>"}
        {"type":"transcript","role":"student|coach","text":"..."}
        {"type":"state","value":"listening|thinking|speaking"}
        {"type":"turn_complete"}
        {"type":"error","reason":"..."}
        {"type":"closed"}
    """
    session_id = session["session_id"]
    uri = (
        f"wss://{_GEMINI_LIVE_HOST}{_GEMINI_LIVE_PATH}?key={GEMINI_API_KEY}"
    )
    setup_msg = {
        "setup": {
            "model": f"models/{GEMINI_LIVE_MODEL}",
            "generationConfig": {
                "responseModalities": ["AUDIO"],
                "speechConfig": {
                    "voiceConfig": {
                        "prebuiltVoiceConfig": {
                            "voiceName": GEMINI_LIVE_VOICE,
                        }
                    }
                },
            },
            "systemInstruction": {
                "parts": [{"text": session.get("system_instruction", "")}]
            },
            "inputAudioTranscription": {},
            "outputAudioTranscription": {},
        }
    }

    transcript: list[dict] = []
    deadline = time.time() + max(30, duration)

    # ── Phase 1 SURPRISE REWARDS: optional per-session reward context.
    # Safe-degrade: if the reward module is missing or fails to wire, the
    # bridge runs exactly as before with no reward events emitted.
    reward_ctx = None
    reward_services = None
    if _REWARD_MOD_OK and _reward_mod is not None:
        try:
            reward_services = _reward_mod.get_services()
        except Exception:
            reward_services = None

    try:
        async with _ws_lib.connect(uri, max_size=None) as gem:
            await gem.send(json.dumps(setup_msg))
            # Wait for setup ack.
            try:
                raw = await asyncio.wait_for(gem.recv(), timeout=15)
                _ = raw  # setupComplete frame
            except Exception as exc:
                raise RuntimeError(f"gemini_setup_failed:{type(exc).__name__}")

            # Mark active + record start timestamp (idempotent).
            await sess_col.update_one(
                {"session_id": session_id, "active_ts": {"$exists": False}},
                {"$set": {"state": "active", "active_ts": time.time(),
                          "active_at": _iso()}},
            )
            await _ws_send(client_ws, {"type": "ready"})
            await _ws_send(client_ws, {"type": "state", "value": "listening"})

            # v1.4 — make the AI coach speak FIRST. Inject a single short
            # "user" turn that tells Gemini to greet the student warmly
            # using the book/chapter context already in system_instruction.
            # The kicker text itself is never spoken back to the student;
            # it's a turn-boundary trigger that produces an audio response
            # which flows through pump_gemini_to_client unchanged. Wrapped
            # in a try/except so a transient kicker failure NEVER aborts a
            # session that has already been paid for — the session simply
            # falls back to its previous behaviour (student speaks first).
            #
            # Phase 0A — attempt-scoped greeting lifecycle. We allocate an
            # unguessable greeting_attempt_id, build the FACTUAL server script
            # (separate from the Gemini wrapper) and assert it carries the four
            # factual categories (falling back to a minimal safe script if not).
            # On a successful kicker send we emit `greeting_state=requested`
            # plus the legacy compatibility frame; on failure we emit
            # `greeting_state=failed` and CONTINUE the paid session.
            #
            # V3 item 5 — deterministic `ready` boundary. The greeting
            # request/skip block runs IMMEDIATELY after `ready` /
            # `state=listening`, BEFORE the reward-runtime check and reward
            # context construction below. The greeting block depends only on
            # ``session``, ``sess_col``, ``gem``, and ``client_ws`` — it does
            # not need ``reward_ctx`` or ``reward_services`` — so this is a
            # reorder of a self-contained block. A slow / hung reward-runtime
            # check can therefore no longer push the greeting request past
            # the client's 5-second request watchdog and trigger a spurious
            # ``request_timeout`` fallback.
            greeting_attempt_id = _make_greeting_attempt_id()
            greeting_ctx = {
                "attempt_id": greeting_attempt_id,
                "first_audio_seen": False,
                "turn_complete": False,
                "cancelled": False,
            }
            # ── Bug 6 — reconnect skip contract. If THIS session already has a
            # persisted CLIENT acknowledgement that interaction began
            # (mic_armed / playback_complete), the greeting was completed on a
            # prior connection. Skip replay: adopt the persisted attempt id,
            # mark the local greeting boundary already complete (so no greeting
            # audio/turn handling or duplicate kicker runs and the first real
            # turn drives rewards unchanged), and emit the explicit skipped
            # frame. NEVER send a new kicker or `requested`.
            #
            # V3 item 4 — fresh reconnect completion read. Immediately before
            # the skip decision, read the four authoritative fields from
            # ``sess_col`` so an ack persisted by the client AFTER bridge
            # entry but BEFORE this decision runs is observed. The read
            # follows this file's existing dominant pattern (``find_one``
            # with no projection argument). On any exception / timeout /
            # ``None`` return we fail soft to the original ``session``
            # snapshot — never block or fail the connection.
            try:
                _fresh = await sess_col.find_one(
                    {"session_id": session_id})
                if _fresh:
                    _ack_at = _fresh.get("greeting_client_ack_at")
                    _fresh_for_ack = {
                        "greeting_client_ack_at": (
                            _ack_at if isinstance(_ack_at, dict) else {}),
                        "greeting_mic_armed_at":
                            _fresh.get("greeting_mic_armed_at"),
                        "greeting_attempt_id":
                            _fresh.get("greeting_attempt_id"),
                    }
                else:
                    _fresh_for_ack = session
            except Exception:
                _fresh_for_ack = session
            completed_ack = _greeting_completed_ack(_fresh_for_ack)
            if completed_ack is not None:
                greeting_attempt_id = completed_ack["attempt_id"]
                greeting_ctx["attempt_id"] = greeting_attempt_id
                greeting_ctx["turn_complete"] = True
                greeting_ctx["cancelled"] = True
                try:
                    await _emit_greeting_skipped(
                        client_ws, sess_col, session_id, greeting_attempt_id,
                        reason="already_completed")
                except Exception:  # noqa: BLE001
                    pass
            else:
                try:
                    payload, g_script, _g_ctx = (
                        _build_validated_greeting_payload(session))
                    await sess_col.update_one(
                        {"session_id": session_id},
                        {"$set": {"greeting_script": g_script,
                                  "greeting_attempt_id": greeting_attempt_id}})
                except Exception as exc:  # noqa: BLE001
                    payload = None
                    log.warning(
                        "live: greeting script build failed sid=%s exc=%s",
                        session_id, exc)

                kicker_sent = False
                try:
                    if payload is None:
                        # Defensive: build a minimal valid payload so the
                        # validated script still reaches gem.send exactly once.
                        payload = {
                            "clientContent": {
                                "turns": [{"role": "user", "parts": [{
                                    "text": _build_greeting_kicker(session)}]}],
                                "turnComplete": True,
                            }
                        }
                    await gem.send(json.dumps(payload))
                    kicker_sent = True
                except Exception:
                    # Greeting is a polish layer, not a correctness gate.
                    kicker_sent = False
                try:
                    if kicker_sent:
                        await _emit_greeting_requested(
                            client_ws, sess_col, session_id,
                            greeting_attempt_id)
                    else:
                        await _emit_greeting_failed(
                            client_ws, sess_col, session_id,
                            greeting_attempt_id, reason="kicker_send_failed")
                except Exception:
                    pass

            # ── Phase 1 corrected: gate reward wiring on the authoritative
            # runtime-active check. When the master rewards feature is OFF
            # (or indexes failed at startup) NO reward hook is installed —
            # the bridge behaves exactly like the pristine implementation.
            #
            # V3 item 5 — Surprise Rewards initialization runs unchanged in
            # behaviour and arguments, only LATER in execution order (after
            # the greeting block above). The ``coach_reward_runtime_active``
            # check, ``RewardSessionCtx`` construction, and
            # ``register_live_reward_ctx`` call are byte-identical.
            if reward_services is not None:
                try:
                    runtime_active = await reward_services[
                        "coach_reward_runtime_active"]()
                except Exception:
                    runtime_active = False
            else:
                runtime_active = False

            if runtime_active and reward_services is not None:
                async def _client_send_cb(payload: dict):
                    # Blocker F — TRUTHFUL delivery. Do NOT swallow the send
                    # failure; let it propagate to
                    # ``RewardSessionCtx.emit_to_client`` which records the
                    # event as NOT delivered (returns False). The only
                    # caller is the reward layer, which fails soft, so a
                    # reward-delivery failure never aborts the paid live
                    # session, microphone, audio, or billing.
                    await _ws_send(client_ws, payload)

                async def _gemini_inject_cb(text: str):
                    if not text:
                        return
                    # Blocker F — TRUTHFUL delivery. A failed Gemini inject
                    # must propagate so ``inject_gemini_text`` returns False
                    # and the announcement is NOT marked delivered. It is
                    # caught by the reward layer and never breaks the live
                    # session.
                    await gem.send(json.dumps({
                        "clientContent": {
                            "turns": [{"role": "user",
                                       "parts": [{"text": text}]}],
                            "turnComplete": True,
                        }
                    }))

                try:
                    reward_ctx = reward_services["RewardSessionCtx"](
                        session_id=session_id,
                        clean_id=session.get("clean_id") or "",
                        display_name=session.get("display_name") or "",
                        gemini_inject_cb=_gemini_inject_cb,
                        client_send_cb=_client_send_cb,
                    )
                    # Finding 4 — make this live ctx discoverable from
                    # the REST layer so a delayed-confirmed reward
                    # (discovered by bounded polling after an earlier
                    # pending claim) can route its Gemini
                    # congratulations through the same guarded
                    # exactly-once announcement lifecycle. Cleaned up
                    # in the finally block when the WS bridge tears
                    # down.
                    try:
                        reward_services["register_live_reward_ctx"](
                            session_id, reward_ctx)
                    except Exception:
                        pass
                except Exception:
                    reward_ctx = None

            # Tracks WHY/HOW the session ended so finalization can choose the
            # correct outcome (completed vs cancelled vs failed) instead of
            # always assuming "completed". Mutated by whichever pump returns.
            # Outcomes are derived from the SHARED module-level _map_end_reason
            # mapper used by the REST /session/end path too.
            end_state = {"outcome": "completed", "reason": "normal"}

            def _set_end(reason: str) -> None:
                end_state["reason"] = reason
                end_state["outcome"] = _map_end_reason(reason)

            async def pump_client_to_gemini():
                while True:
                    if time.time() > deadline:
                        _set_end("time_up")
                        await _ws_send(client_ws, {"type": "time_up"})
                        return
                    try:
                        raw = await asyncio.wait_for(
                            client_ws.receive_text(), timeout=1.0)
                    except asyncio.TimeoutError:
                        continue
                    except WebSocketDisconnect:
                        _set_end("ws_disconnect")
                        return
                    try:
                        frame = json.loads(raw)
                    except Exception:
                        continue
                    ftype = frame.get("type")
                    if ftype == "greeting_client_ack":
                        # Phase 0A — greeting lifecycle acknowledgements. Handled
                        # BEFORE any forwarding so a control frame can never be
                        # relayed to Gemini. Mismatched attempt ids are ignored;
                        # a matching fallback marks the attempt cancelled and
                        # returns greeting_state=cancelled. NEVER ends the paid
                        # session.
                        try:
                            await _handle_greeting_client_ack(
                                frame, greeting_ctx, client_ws, sess_col,
                                session_id)
                        except Exception as exc:  # noqa: BLE001
                            log.debug("greeting: client ack failed: %s", exc)
                        continue
                    if ftype == "audio":
                        await gem.send(json.dumps({
                            "realtimeInput": {
                                "audio": {
                                    "data": frame.get("data", ""),
                                    "mimeType": _INPUT_AUDIO_MIME,
                                }
                            }
                        }))
                    elif ftype == "text":
                        await gem.send(json.dumps({
                            "clientContent": {
                                "turns": [{
                                    "role": "user",
                                    "parts": [{"text": frame.get("data", "")}],
                                }],
                                "turnComplete": True,
                            }
                        }))
                    elif ftype == "end":
                        _set_end(frame.get("reason", "client_end"))
                        return
                    elif ftype == "claim_reward":
                        # Phase 1 SURPRISE REWARDS: WebSocket claim command.
                        # Calls the SAME claim service the REST route uses
                        # (no duplicate grant logic). Failures are surfaced
                        # via reward_claim_failed and never end the live
                        # session.
                        offer_id = str(frame.get("offer_id") or "")[:64]
                        if (offer_id and reward_ctx is not None
                                and reward_services is not None):
                            try:
                                await reward_services[
                                    "handle_ws_claim_command"](
                                    offer_id, session, reward_ctx)
                            except Exception as exc:  # noqa: BLE001
                                log.warning(
                                    "reward: ws claim error: %s", exc)
                    elif ftype == "announce_confirmed_reward":
                        # Correction 1 (final) — strict live-WebSocket
                        # acknowledgement of a delayed-confirmed reward
                        # announcement. The browser sends this over the
                        # ALREADY-OPEN authenticated coach connection after
                        # bounded polling discovers an authoritative granted
                        # offer. The bridge owns the authenticated student,
                        # session and live Gemini context, so the handler
                        # delivers (or truthfully declines) through THIS
                        # connection's ctx directly — no REST→registry hop.
                        # A single reward_announce_ack frame is always sent
                        # back so the client marks the offer completed ONLY
                        # on proven delivery and keeps it retryable
                        # otherwise. Never ends the live session.
                        offer_id = str(frame.get("offer_id") or "")[:64]
                        claimed_sid = str(
                            frame.get("session_id") or "")[:128]
                        if (offer_id and reward_ctx is not None
                                and reward_services is not None):
                            try:
                                await reward_services[
                                    "handle_ws_announce_confirmed"](
                                    offer_id, claimed_sid, session,
                                    reward_ctx)
                            except Exception as exc:  # noqa: BLE001
                                log.warning(
                                    "reward: ws announce error: %s", exc)

            async def pump_gemini_to_client():
                while True:
                    if time.time() > deadline:
                        _set_end("time_up")
                        return
                    try:
                        raw = await asyncio.wait_for(gem.recv(), timeout=1.0)
                    except asyncio.TimeoutError:
                        continue
                    except Exception:
                        # Gemini closed the socket. Treated as a cancel so the
                        # min_useful_seconds refund rule applies (a too-short
                        # drop refunds; a long-enough session keeps its charge).
                        _set_end("gemini_closed")
                        return
                    try:
                        msg = json.loads(raw)
                    except Exception:
                        continue
                    await _handle_gemini_message(
                        msg, client_ws, transcript,
                        reward_ctx=reward_ctx,
                        reward_services=reward_services,
                        session=session,
                        greeting_ctx=greeting_ctx,
                        sess_col=sess_col,
                        session_id=session_id)

            done, pending = await asyncio.wait(
                {asyncio.create_task(pump_client_to_gemini()),
                 asyncio.create_task(pump_gemini_to_client())},
                return_when=asyncio.FIRST_COMPLETED,
            )
            for t in pending:
                t.cancel()

        # Persist accumulated transcript before finalizing.
        if transcript:
            await sess_col.update_one(
                {"session_id": session_id},
                {"$set": {"transcript": transcript[:300]}})

        await _ws_send(client_ws, {"type": "closed"})
        # Finalize with the ACTUAL outcome — the min_useful_seconds + became
        # _active rules inside _finalize_session decide refund vs charge.
        result = await finalize(session_id, outcome=end_state["outcome"],
                                transcript=transcript,
                                error_reason=end_state["reason"])
        fsession = (result or {}).get("session") or {}
        # Surface the honest charge + refund status to the client so the UI can
        # show refund_pending / refund_failed clearly.
        await _ws_send(client_ws, {
            "type": "report",
            "report": (result or {}).get("report"),
            "charged": int(fsession.get("final_charged") or 0),
            "refund_state": fsession.get("refund_state"),
            "session_state": fsession.get("state"),
        })
    except RuntimeError as exc:
        # Gemini failed to come up — refund (failed) so the student is not charged.
        await _ws_send(client_ws, {"type": "error", "reason": str(exc)})
        await finalize(session_id, outcome="failed", error_reason=str(exc))
    finally:
        # Correction 1 (final) — drop the live reward ctx from the
        # registry so a later recovery call cannot fire a Gemini
        # announcement into a torn-down bridge. Identity-safe: a fast
        # reconnect that registered a NEWER ctx under the same session_id
        # must not be evicted by this older bridge's teardown.
        try:
            if reward_services is not None:
                reward_services["unregister_live_reward_ctx"](
                    session_id, reward_ctx)
        except Exception:
            pass
        try:
            if reward_ctx is not None:
                reward_ctx.close()
        except Exception:
            pass


async def _handle_gemini_message(msg: dict, client_ws: WebSocket,
                                 transcript: list[dict],
                                 *, reward_ctx=None, reward_services=None,
                                 session: dict | None = None,
                                 greeting_ctx: dict | None = None,
                                 sess_col=None,
                                 session_id: str | None = None) -> None:
    """Translate a Gemini Live server message into client frames + transcript.

    Phase 1 corrected SURPRISE REWARDS: coach output is NEVER modified.
    Instead the bridge buffers the latest coach text / latest student
    input transcript and the reward module owns:

      * opening an exercise (when a coach turn completes);
      * evaluating an exercise (when student input transcription arrives);
      * deciding whether the cumulative state qualifies for an offer.

    Nothing reward-related runs unless ``reward_services`` is wired AND
    the reward runtime is currently active (the bridge gates this at
    setup time so a disabled feature has no effect here).
    """
    server_content = msg.get("serverContent")
    if not server_content:
        return

    def _buffer_coach(text: str) -> None:
        if reward_ctx is not None and text:
            reward_ctx.last_coach_text = (
                (reward_ctx.last_coach_text + " " + text).strip()[-1024:]
            )

    def _buffer_student(text: str) -> None:
        if reward_ctx is not None and text:
            reward_ctx.last_student_text = (
                (reward_ctx.last_student_text + " " + text).strip()[-1024:]
            )

    # Input (student) transcription. Buffer the latest student text so the
    # reward module can evaluate the open exercise when the turn completes.
    in_tx = server_content.get("inputTranscription")
    if in_tx and in_tx.get("text"):
        transcript.append({"role": "student", "text": in_tx["text"],
                           "ts": _iso()})
        await _ws_send(client_ws, {"type": "transcript", "role": "student",
                                   "text": in_tx["text"]})
        _buffer_student(in_tx["text"])

    # Output (coach) transcription. Coach text is forwarded UNMODIFIED —
    # the corrected Phase 1 build does not embed any control markers in
    # the model's response stream.
    out_tx = server_content.get("outputTranscription")
    if out_tx and out_tx.get("text"):
        transcript.append({"role": "coach", "text": out_tx["text"],
                           "ts": _iso()})
        await _ws_send(client_ws, {"type": "transcript", "role": "coach",
                                   "text": out_tx["text"]})
        _buffer_coach(out_tx["text"])

    # Resolve the session id for greeting persistence (works without it too).
    _sid = session_id or (session.get("session_id") if session else "") or ""
    _greeting_active = (
        greeting_ctx is not None and not greeting_ctx.get("turn_complete"))

    model_turn = server_content.get("modelTurn")
    if model_turn:
        await _ws_send(client_ws, {"type": "state", "value": "speaking"})
        for part in model_turn.get("parts", []):
            inline = part.get("inlineData")
            if inline and inline.get("data"):
                # Phase 0A — while a greeting attempt is pending, suppress audio
                # if the attempt was cancelled (controlled fallback) so late
                # greeting audio never plays over the armed mic.
                if _greeting_active and greeting_ctx.get("cancelled"):
                    continue
                audio_frame = {
                    "type": "audio",
                    "data": inline["data"],
                    "mimeType": inline.get("mimeType", "audio/pcm;rate=24000"),
                }
                # Tag greeting audio with the attempt id and emit `first_audio`
                # exactly once for the attempt.
                if _greeting_active:
                    aid = greeting_ctx.get("attempt_id")
                    audio_frame["greeting_attempt_id"] = aid
                    if not greeting_ctx.get("first_audio_seen"):
                        greeting_ctx["first_audio_seen"] = True
                        await _send_greeting_state(client_ws, aid, "first_audio")
                        await _persist_greeting_state(
                            sess_col, _sid, "first_audio", attempt_id=aid)
                # Forward Gemini's 24 kHz PCM audio straight to the browser.
                await _ws_send(client_ws, audio_frame)
            txt = part.get("text")
            if txt:
                transcript.append({"role": "coach", "text": txt,
                                   "ts": _iso()})
                await _ws_send(client_ws, {"type": "transcript",
                                           "role": "coach", "text": txt})
                _buffer_coach(txt)

    if server_content.get("turnComplete"):
        await _ws_send(client_ws, {"type": "turn_complete"})
        await _ws_send(client_ws, {"type": "state", "value": "listening"})
        # ── Phase 0A — greeting turn boundary. The FIRST turn completion while
        # a greeting attempt is pending is the greeting turn. We emit a PARALLEL
        # attempt-scoped greeting_state=turn_complete (in addition to the generic
        # frame above, which stays for legacy compatibility) and must NOT run the
        # Surprise Reward hooks for this greeting turn.
        if greeting_ctx is not None and not greeting_ctx.get("turn_complete"):
            greeting_ctx["turn_complete"] = True
            if not greeting_ctx.get("cancelled"):
                aid = greeting_ctx.get("attempt_id")
                await _send_greeting_state(client_ws, aid, "turn_complete")
                await _persist_greeting_state(
                    sess_col, _sid, "turn_complete", attempt_id=aid)
            return  # greeting turn never registers/evaluates a reward exercise
        # ── Phase 1 corrected reward hooks. The bridge ONLY calls these
        # when ``reward_services`` is wired AND the runtime-active gate
        # passed at session start.
        if (reward_services is not None and reward_ctx is not None
                and session is not None):
            sid = session.get("session_id") or ""
            clean_id = session.get("clean_id") or ""
            # 1) Evaluate any open exercise against the latest student
            #    response. The reward module owns the success decision.
            if reward_ctx.current_exercise_id and reward_ctx.last_student_text:
                try:
                    await reward_services["evaluate_exercise"](
                        sid, clean_id, reward_ctx,
                        reward_ctx.last_student_text)
                except Exception as exc:  # noqa: BLE001
                    log.debug("reward: evaluate_exercise failed: %s", exc)
                reward_ctx.last_student_text = ""
            # 2) Open a new exercise from the just-completed coach turn so
            #    the next student response has a server-issued exercise to
            #    evaluate against.
            if reward_ctx.last_coach_text:
                try:
                    await reward_services["register_exercise"](
                        sid, clean_id, reward_ctx,
                        reward_ctx.last_coach_text)
                except Exception as exc:  # noqa: BLE001
                    log.debug("reward: register_exercise failed: %s", exc)
                reward_ctx.last_coach_text = ""
