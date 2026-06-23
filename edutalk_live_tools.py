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
from datetime import datetime, timedelta, timezone
from typing import Any, Optional

import httpx
from fastapi import Depends, HTTPException, WebSocket, WebSocketDisconnect
from pydantic import BaseModel, ConfigDict, Field

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
        cfg = await _save_config(payload.get("config", payload), admin_email)
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

        system_instruction = _build_system_instruction(
            cfg=cfg, mode_key=mode_key, mode_cfg=mode_cfg,
            student_name=(display_name or "the student").split(" ")[0],
            points_balance=None,
            book_title=payload.book_title, chapter_title=payload.chapter_title,
            current_paragraph=payload.current_paragraph,
            reading_progress=payload.reading_progress,
            saved_words=payload.saved_words, previous_reports=prev_reports,
            explain_language=explain_language,
        )

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


def _build_greeting_kicker(session: dict) -> str:
    """v1.5 — Khmer-first greeting kicker for EduTalk Live Coach.

    Gemini Live with ``responseModalities=["AUDIO"]`` only emits audio after
    it receives a turn. Without a kicker the coach sits silent until the
    student talks. We inject a SHORT user-role turn that tells the coach
    to greet the student warmly in the student's chosen explanation
    language. The kicker text itself is never spoken back: it's
    interpreted by the model as a turn boundary that triggers an audio
    response which flows through the existing ``pump_gemini_to_client``
    path unchanged.

    v1.5 behaviour:
        * Default greeting language is KHMER (the vast majority of EduHub
          students are Khmer speakers).
        * The greeting uses the student's first name and — when a safe
          display hint is available — the student's current points
          balance. The hint is treated as DISPLAY-ONLY: if a malicious
          client passed a wrong value, only the greeting text is wrong;
          no money / debit / refund logic uses it.
        * The greeting explicitly states "this is English speaking
          practice from the book" and asks the student to confirm
          whether they want explanations in Khmer or English. The
          actual choice has already been sent via ``explain_language``;
          the confirmation question is a friendly UX touch so the
          student feels in control.
        * If the student chose English explanations, the kicker greets
          in English.
    """
    name = (session.get("display_name") or "").split(" ")[0] or "the student"
    book = (session.get("book_title") or "").strip()
    chapter = (session.get("chapter_title") or "").strip()
    mode = (session.get("mode") or "").strip()
    lang = (session.get("explain_language") or "km").strip().lower()
    if lang not in ("km", "en"):
        lang = "km"

    hint = session.get("points_balance_hint")
    try:
        hint_int = int(hint) if hint is not None else None
    except Exception:
        hint_int = None

    if lang == "km":
        # Khmer-first greeting. We give the model precise INSTRUCTIONS
        # in English (Gemini follows English instructions reliably) and
        # tell it to SPEAK the greeting in natural Khmer. We give the
        # model an exact Khmer template it can shorten naturally — this
        # avoids Unicode mojibake from over-creative paraphrasing.
        parts: list[str] = [
            "[SESSION_START]",
            "Greet the student NOW in natural Khmer (ភាសាខ្មែរ). Do not "
            "use English in the greeting except for proper nouns. Keep "
            "it warm, short (~3 short sentences), and personal.",
            f"The student's name is {name} — say hi using their name.",
        ]
        if hint_int is not None:
            parts.append(
                f"Tell them they currently have {hint_int} EduHub points "
                "in their account (mention the points casually, not as a "
                "sales pitch)."
            )
        if book and chapter:
            parts.append(
                f"Mention that today you will practise speaking English "
                f"together using the book \"{book}\" — chapter \"{chapter}\"."
            )
        elif book:
            parts.append(
                f"Mention that today you will practise speaking English "
                f"together using the book \"{book}\"."
            )
        else:
            parts.append(
                "Tell them today you will practise speaking English together."
            )
        if mode:
            parts.append(f"Frame the session as a '{mode}' practice.")
        parts.append(
            "Then ask in Khmer whether they want explanations in Khmer or "
            "in English. (Default in their UI was Khmer, so reassure them "
            "Khmer is fine.) Also remind them CLEARLY in Khmer that the "
            "practice sentences and their own speaking answers will still "
            "be in English. End with one short English practice sentence "
            "they can repeat to begin (taken from the current book "
            "context if possible, otherwise something simple like "
            "\"I am ready to practise.\")."
        )
        parts.append(
            "Do not lecture. Do not list rules. Speak NOW in Khmer."
        )
        return " ".join(parts)

    # explain_language == "en"
    parts = [
        "[SESSION_START]",
        f"Greet {name} warmly in ONE or TWO short sentences (max ~25 words).",
        f"Say hi using the name {name}.",
    ]
    if hint_int is not None:
        parts.append(
            f"Mention casually that they have {hint_int} EduHub points in "
            "their account."
        )
    if book and chapter:
        parts.append(
            f"Mention that you'll practise English speaking together "
            f"using \"{book}\" — chapter \"{chapter}\"."
        )
    elif book:
        parts.append(
            f"Mention the book \"{book}\" briefly and frame it as English "
            "speaking practice."
        )
    if mode:
        parts.append(f"Frame the session as a '{mode}' practice.")
    parts.append(
        "Then ask ONE easy opening English question (or give one short "
        "English practice sentence) to start the speaking practice. "
        "Remind them their speaking answers should be in English. "
        "Do not lecture. Do not list rules. Speak now."
    )
    return " ".join(parts)


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
            "generationConfig": {"responseModalities": ["AUDIO"]},
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

            # ── Phase 1 corrected: gate reward wiring on the authoritative
            # runtime-active check. When the master rewards feature is OFF
            # (or indexes failed at startup) NO reward hook is installed —
            # the bridge behaves exactly like the pristine implementation.
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

            # v1.4 — make the AI coach speak FIRST. Inject a single short
            # "user" turn that tells Gemini to greet the student warmly
            # using the book/chapter context already in system_instruction.
            # The kicker text itself is never spoken back to the student;
            # it's a turn-boundary trigger that produces an audio response
            # which flows through pump_gemini_to_client unchanged. Wrapped
            # in a try/except so a transient kicker failure NEVER aborts a
            # session that has already been paid for — the session simply
            # falls back to its previous behaviour (student speaks first).
            try:
                kicker = _build_greeting_kicker(session)
                await gem.send(json.dumps({
                    "clientContent": {
                        "turns": [{
                            "role": "user",
                            "parts": [{"text": kicker}],
                        }],
                        "turnComplete": True,
                    }
                }))
            except Exception:
                # Greeting is a polish layer, not a correctness gate.
                pass

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
                        session=session)

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
                                 session: dict | None = None) -> None:
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

    model_turn = server_content.get("modelTurn")
    if model_turn:
        await _ws_send(client_ws, {"type": "state", "value": "speaking"})
        for part in model_turn.get("parts", []):
            inline = part.get("inlineData")
            if inline and inline.get("data"):
                # Forward Gemini's 24 kHz PCM audio straight to the browser.
                await _ws_send(client_ws, {
                    "type": "audio",
                    "data": inline["data"],
                    "mimeType": inline.get("mimeType", "audio/pcm;rate=24000"),
                })
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
