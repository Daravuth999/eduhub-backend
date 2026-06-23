"""edutalk_coach_reward_tools.py — EduTalk Live Coach SURPRISE REWARDS (Phase 1, corrected).

Independent-audit correction pass. The pre-correction draft is preserved by
``git diff`` against pristine; this file is the authoritative implementation
that the corrected cumulative patch contains. Locked behaviour:

  1. POINTS GRANT IS NOW IDEMPOTENT via a durable internal outbox
     (``edutalk_coach_rewards_grants``) keyed by a stable, offer-derived
     transaction identity:
         tx_id = f"edutalk-coach-reward:{offer_id}:points"
     Only one outbox row may exist for a tx_id (unique index). A claim is
     ``confirmed`` only after the outbox row is moved to ``confirmed``;
     duplicate or retry callers reuse the SAME tx_id and never produce a
     second dispatch.

  2. ONE OFFER PER SESSION is database-enforced. The offer document carries
     ``session_offer_key = f"{clean_id}:{session_id}"`` with a unique index
     so concurrent eligible evidence cannot create two offers.

  3. DAILY / MONTHLY CAPS ARE ATOMICALLY RESERVED. A reservation row is
     inserted into ``edutalk_coach_rewards_cap_reservations`` BEFORE the
     offer is created, with a stable
         reservation_key = f"{clean_id}:{period_key}:{offer_id}"
     and a hard slot lookup that counts active reservations. The slot is
     held until the offer is confirmed, expired, or terminal — never
     released while the provider outcome is still ambiguous.

  4. SERVER OWNS EXERCISE IDENTITY. Backend registers an authoritative
     ``edutalk_coach_rewards_exercises`` record. Evidence can only be
     evaluated for a server-issued exercise that belongs to the
     authenticated student and the active session.

  5. NO VISIBLE-MARKER PROTOCOL. Evidence is no longer transported via
     ``[[EDUHUB_EVIDENCE]]`` text. Coach output is never modified. The
     bridge invokes the reward module's ``evaluate_exercise`` directly
     against authoritative coach/student turn records.

  6. DISABLED = COMPLETELY DARK. The bridge checks
     ``coach_reward_runtime_active(...)`` BEFORE wiring any reward hook,
     declaring any exercise, or modifying the Gemini setup.

  7. INDEX CREATION USES STARTUP LIFECYCLE. ``setup_indexes(db)`` is an
     awaitable called from a FastAPI startup event registered in
     ``server.py``; there is no import-time ``create_task``.

  8. UNIMPLEMENTED REWARD TYPES (pass, achievement, voucher) cannot be
     enabled. The validator returns 400; the sanitiser forces False.

  9. ACTIVE-OFFER RECOVERY IS SESSION-BOUND. ``GET …/active`` requires
     ``?session_id=`` and verifies the offer belongs to that session.

 10. PERSONALIZED RECOGNITION snapshot is frozen on the offer at creation
     and reused for both pre-claim and post-claim announcements;
     announcements are idempotent (``offer_announced_at`` /
     ``claim_announced_at``).

 11. NOTIFICATIONS are idempotent with stable keys
         edutalk-coach-reward:{offer_id}:claim-started
         edutalk-coach-reward:{offer_id}:confirmed
     and reuse the existing ``_fan_out_push`` Web-Push fan-out without
     introducing a new provider.
"""

from __future__ import annotations

import asyncio
import hashlib
import json
import logging
import os
import re
import secrets
import time
from datetime import datetime, timedelta, timezone
from typing import Any, Callable, Optional

from fastapi import Depends, HTTPException, Query
from pydantic import BaseModel, ConfigDict, Field

log = logging.getLogger("eduhub.edutalk_coach_reward")

# --------------------------------------------------------------------------- #
# Module identity                                                             #
# --------------------------------------------------------------------------- #
POLICY_VERSION = "phase1.final-corrected.v1"
GRANT_ADAPTER_VERSION = "edutalk_coach_reward.wallet_service.points.v2.production"
CONFIG_SCHEMA_VERSION = 3

# ──────────────────────────────────────────────────────────────────────────
# Provider-boundary truth (audit 4.2).
# ──────────────────────────────────────────────────────────────────────────
# The existing ``_gas_treasury_credit`` upstream helper accepts NO
# caller-supplied idempotency identity: it generates a fresh internal
# ``secrets.token_hex(12)`` nonce on every invocation. Therefore the stable
# offer-derived ``tx_id`` cannot reach the provider, and the system is NOT
# provider-idempotent end-to-end.
#
# Audit-allowed fallback: real point granting is DISABLED by default and the
# system runs in "laboratory" mode. In laboratory mode:
#   * offers can still be created and claimed;
#   * the outbox dispatch records ``failed_terminal`` with reason
#     ``provider_idempotency_unavailable``;
#   * NO confirmed reward notification is sent;
#   * NO Gemini post-claim congratulation is sent;
#   * the student sees a truthful "Reward pipeline not ready" failure;
#   * the offer / claim / personalization / notification scaffolding is
#     fully exercised for future verification.
#
# An operator may set ``EDUTALK_COACH_REAL_GRANT_ENABLED=1`` ONLY after the
# upstream helper is extended to accept a caller-supplied stable nonce that
# reaches the provider (see NEXT_AGENT_HANDOVER.md). Until then this flag is
# refused at the validation boundary and the laboratory path is the only
# safe outcome.
# NOTE: ``REAL_GRANT_ENABLED`` itself is assigned LATER in this module — see
# below ``_env_flag`` definitions — to keep top-of-file constants free of
# forward references.

# Reuse the SAME existing authoritative treasury credit path the EduTalk
# Live Coach uses for refunds — that is the existing wallet/ledger

try:
    from edutalk_live_tools import _gas_treasury_credit as _gas_treasury_credit  # type: ignore
    _GRANT_HELPER_OK_GAS = True
except Exception:  # pragma: no cover
    _gas_treasury_credit = None  # type: ignore[assignment]
    _GRANT_HELPER_OK_GAS = False

try:
    from wallet_service import (  # type: ignore
        WalletService as _WalletService,
        WalletError as _WalletError,
        WalletNotFound as _WalletNotFound,
        WalletStatusBlocked as _WalletStatusBlocked,
        InsufficientFunds as _InsufficientFunds,
    )
    _WALLET_SERVICE_OK = True
except Exception:  # pragma: no cover
    _WalletService = None  # type: ignore[assignment]
    _WalletError = Exception  # type: ignore[misc,assignment]
    _WalletNotFound = Exception  # type: ignore[misc,assignment]
    _WalletStatusBlocked = Exception  # type: ignore[misc,assignment]
    _InsufficientFunds = Exception  # type: ignore[misc,assignment]
    _WALLET_SERVICE_OK = False

# Stable-nonce grant available when WalletService.credit() imported ok.
# WalletService.credit() accepts a caller-supplied idempotency_key and
# enforces uniqueness via sparse unique index on points_transactions.
# This IS the production provider-idempotency path — no external call.
_GRANT_HELPER_OK = _WALLET_SERVICE_OK


# Module-level reconciliation state — updated by background worker.
_RECON_STATE: dict[str, Any] = {
    "running": False, "last_run": None, "resolved": 0, "errors": 0,
}

# Module-level worker factory — registered by register_edutalk_coach_reward_routes.
_RECON_WORKER_FACTORY: Optional[Any] = None

def _env_flag(name: str, default: str = "0") -> bool:
    v = (os.environ.get(name) or default).strip().lower()
    return v in ("1", "true", "yes", "on")


ENV_REWARDS_ENABLED = _env_flag("EDUTALK_COACH_REWARDS_ENABLED", "0")
ENV_POINTS_ENABLED = _env_flag("EDUTALK_COACH_POINTS_REWARDS_ENABLED", "0")

# Provider-boundary truth flag — see top-of-file rationale.
REAL_GRANT_ENABLED = _env_flag("EDUTALK_COACH_REAL_GRANT_ENABLED", "0")

# --------------------------------------------------------------------------- #
# Stable provider idempotency key                                             #
# --------------------------------------------------------------------------- #
def _stable_provider_key(
    offer_id: str,
    clean_id: str,
    session_id: str,
    reward_kind: str,
    reward_amount: int,
) -> str:
    """Deterministic SHA-256 idempotency key for exactly one reward claim.

    Contract:
    * Same logical claim always produces the same key.
    * Different claims (different offer_id) produce different keys.
    * Retries reuse the exact same key — safe for WalletService.credit().
    * Process restart preserves the key — derived from immutable fields only.
    * No random nonce is generated; no external state is required.

    Used as:
    * idempotency_key argument to WalletService.credit()
    * Lookup key in points_transactions for reconciliation
    * Stored on the grant outbox row before the first provider call
    """
    canonical = (
        "edutalk-coach-reward:"
        f"{offer_id}:"
        f"{clean_id}:"
        f"{session_id}:"
        f"{reward_kind}:"
        f"{reward_amount}"
    )
    return hashlib.sha256(canonical.encode("utf-8")).hexdigest()


def _provider_grant_available() -> bool:
    """B1 (audit) — capability gate. A student-visible offer must be
    impossible while real granting is not actually possible end-to-end.

    Real granting is genuinely possible only when ALL of the following
    hold simultaneously:

      1. ``REAL_GRANT_ENABLED`` is True (operator has flipped the
         provider-boundary truth flag);
      2. either an injected ``_gas_treasury_credit_with_nonce`` callable
         is present in this module's globals (test/future-live injection),
         OR ``_GRANT_HELPER_OK`` is True AND ``_WalletService`` is not None
         (the built-in WalletService nonce path is available);
      3. (both conditions above are required for provider-side idempotency).

    When ANY required condition is False, no offer may be created, no
    ``reward_offer_available`` WS event may fire, no Gemini
    announcement may be queued, no claim-start notification may run,
    and ``rewards_active`` in the public status must be False.
    """
    if not REAL_GRANT_ENABLED:
        return False
    _injected = globals().get("_gas_treasury_credit_with_nonce")
    if callable(_injected):
        return True
    if _GRANT_HELPER_OK and _WalletService is not None:
        return True
    return False


# Specific DuplicateKeyError detector (audit 4.5). Cap reservation MUST
# distinguish a genuine duplicate-key collision from a write timeout or a
# database outage. The Motor / PyMongo driver raises
# ``pymongo.errors.DuplicateKeyError``; we import lazily so unit tests
# using a fake collection can still trigger the same code path via a
# raised exception whose ``str(exc)`` starts with ``DuplicateKey``.
try:
    from pymongo.errors import DuplicateKeyError as _DupKeyErr  # type: ignore
except Exception:  # pragma: no cover
    _DupKeyErr = None  # type: ignore[assignment]


def _is_duplicate_key(exc: BaseException) -> bool:
    if _DupKeyErr is not None and isinstance(exc, _DupKeyErr):
        return True
    msg = str(exc) or ""
    return msg.startswith("DuplicateKey") or "duplicate key" in msg.lower()


# --------------------------------------------------------------------------- #
# Defaults / allowlists                                                       #
# --------------------------------------------------------------------------- #
SAFE_POINT_VALUES: tuple[int, ...] = (5, 10, 15, 20)

SUPPORTED_EXERCISE_KINDS: tuple[str, ...] = (
    "repeat_after_coach",
    "correction_retry",
    "guided_short_answer",
    "book_shadow_sentence",
)

# Deterministic coach-turn classifier (audit 4.3). Only turns that match
# one of these task patterns become exercises. Greetings, encouragement,
# generic explanation, and ordinary conversation never become exercises.
# Patterns are intentionally conservative — when in doubt the classifier
# returns ``(None, None)`` and the bridge does NOT register an exercise.
_PAT_REPEAT = re.compile(
    r"\b(repeat\s+(after\s+me|this|the\s+sentence)|say\s+(after\s+me|this|"
    r"these\s+words)|please\s+say|now\s+say|shadow\s+(after\s+me|this)|"
    r"echo\s+(after\s+me|this))\b",
    re.IGNORECASE,
)
_PAT_CORRECTION = re.compile(
    r"\b(let'?s\s+try\s+(again|once\s+more)|try\s+(again|it\s+again|once\s+"
    r"more|that\s+(one\s+)?again)|actually\s+it'?s|the\s+correct\s+(way\s+"
    r"to\s+say\s+(it|that)|version|pronunciation)\s+is|instead\s+of\s+\w+,?"
    r"\s+say|let\s+me\s+correct|that'?s\s+not\s+quite\s+right)\b",
    re.IGNORECASE,
)
_PAT_GUIDED_QA = re.compile(
    r"\b(what\s+would\s+you\s+say|how\s+would\s+you\s+say|tell\s+me\s+"
    r"(about|how|what|why|when)|answer\s+(this|me|the\s+question)|"
    r"can\s+you\s+(say|tell\s+me|describe))\b",
    re.IGNORECASE,
)
_PAT_BOOK = re.compile(
    r"\b(from\s+(your|the)\s+(book|lesson|paragraph)|read\s+the\s+next\s+"
    r"sentence|the\s+next\s+line\s+says)\b",
    re.IGNORECASE,
)
# Strong "is this praise/greeting/explanation only" markers — when a turn
# matches these AND none of the task patterns above, the turn must NOT
# register an exercise (audit 4.3 explicit ban).
_PAT_CONVERSATION_ONLY = re.compile(
    r"^\s*(hi|hello|hey|good\s+(morning|afternoon|evening)|welcome|nice\s+"
    r"to\s+meet\s+you|great\s+job|well\s+done|excellent|amazing|perfect|"
    r"keep\s+going|that'?s\s+(great|wonderful|amazing)|you'?re\s+doing\s+"
    r"well|let\s+me\s+(tell\s+you|explain))",
    re.IGNORECASE,
)


def classify_coach_turn(text: str) -> tuple[str | None, str | None]:
    """Return ``(exercise_kind, correction_target)``.

    Only one of the four supported kinds may be returned; otherwise
    ``(None, None)`` and the caller MUST NOT register an exercise. The
    correction_target string is extracted only when the turn is classified
    as ``correction_retry`` — it carries the target phrase the student is
    expected to reproduce."""
    if not text:
        return None, None
    s = text.strip()
    if not s:
        return None, None
    # 1) Correction first (most specific — overrides repeat patterns).
    if _PAT_CORRECTION.search(s):
        # Extract the target sentence the coach asks the student to retry.
        # Heuristic: prefer a quoted segment, else the text after "say".
        target = ""
        m_quote = re.search(r'"([^"]{4,120})"', s)
        if m_quote:
            target = m_quote.group(1).strip()
        else:
            m_say = re.search(r"\bsay\b[^.?!]{2,120}", s, re.IGNORECASE)
            if m_say:
                target = m_say.group(0).split(None, 1)[-1].strip(" '\"")[:140]
        return "correction_retry", target or None
    if _PAT_REPEAT.search(s):
        return "repeat_after_coach", None
    if _PAT_BOOK.search(s):
        return "book_shadow_sentence", None
    if _PAT_GUIDED_QA.search(s):
        # B2 (audit) — guided_short_answer requires an EXPLICIT guided-QA
        # phrasing (``tell me about/how/what/why/when``, ``can you tell
        # me``, ``what would you say``, etc.). A bare trailing question
        # mark is no longer enough; ordinary conversational questions
        # (``How are you today?``, ``Are you ready?``, ``Do you like
        # this?``) must NOT register as exercises.
        if not _PAT_CONVERSATION_ONLY.match(s):
            return "guided_short_answer", None
    return None, None

DEFAULT_REWARD_CONFIG: dict[str, Any] = {
    "schema_version": CONFIG_SCHEMA_VERSION,
    # Feature status — Phase 1 corrected: ONLY ``points`` may be enabled.
    "enabled": False,
    "points_enabled": False,
    "pass_enabled": False,              # locked OFF (no adapter in Phase 1)
    "achievement_enabled": False,       # locked OFF (no adapter in Phase 1)
    "voucher_enabled": False,           # locked OFF (Phase 1 lock)
    # Performance eligibility.
    "min_successful_exercises": 3,
    "require_resolved_correction": True,
    "min_confidence": 0.70,
    "min_session_seconds": 45,
    "max_offers_per_session": 1,
    # Reward pool.
    "approved_point_values": [5, 10, 15],
    # Limits.
    "cooldown_seconds": 1800,
    "daily_cap_per_student": 1,
    "monthly_cap_per_student": 8,
    "offer_ttl_seconds": 300,
    # Student / Gemini wording.
    "button_label": "Your surprise is ready",
    "pre_claim_message": (
        "You followed the last exercises really well — a surprise is "
        "ready on your screen."
    ),
    "confirmed_message_template": (
        "Practice streak reward — you earned this through strong practice!"
    ),
    "gemini_pre_claim_template": (
        "EduHub verified that {student_name} completed "
        "{successful_exercise_count} distinct exercises and "
        "{recognized_practice} during {lesson_title}. A surprise reward "
        "button is now available. Tell {student_name} naturally and "
        "briefly that you noticed this specific effort and invite them to "
        "tap the surprise button on screen. Do not state the reward type "
        "or amount. Do not promise another reward. Do not say the reward "
        "came from you. Do not add facts not in this server event. "
        "Continue the current lesson naturally."
    ),
    "gemini_confirmed_template": (
        "EduHub confirmed {student_name}'s reward. Confirmed result: "
        "{confirmed_reward}. Recognized practice: completed "
        "{successful_exercise_count} exercises and {recognized_practice}. "
        "Congratulate {student_name} briefly and naturally. Mention the "
        "exact confirmed reward once. Connect it to the verified practice. "
        "Do not change the amount. Do not promise a future reward. Do not "
        "claim that you personally credited it. Continue the lesson "
        "afterwards."
    ),
}


# --------------------------------------------------------------------------- #
# Helpers                                                                     #
# --------------------------------------------------------------------------- #
def _now() -> datetime:
    return datetime.now(timezone.utc)


def _iso(dt: datetime | None = None) -> str:
    return (dt or _now()).isoformat()


def _today_key(dt: datetime | None = None) -> str:
    return (dt or _now()).strftime("%Y-%m-%d")


def _month_key(dt: datetime | None = None) -> str:
    return (dt or _now()).strftime("%Y-%m")


def _clamp_int(v: Any, lo: int, hi: int, default: int) -> int:
    try:
        return max(lo, min(int(v), hi))
    except Exception:
        return default


def _clamp_float(v: Any, lo: float, hi: float, default: float) -> float:
    try:
        return max(lo, min(float(v), hi))
    except Exception:
        return default


_FORBIDDEN_TEMPLATE_FRAGMENTS = (
    "ignore previous", "ignore the above", "system:", "<|", "|>",
    "override", "jailbreak", "reveal your", "you are now",
)
_ALLOWED_PLACEHOLDERS = (
    "{student_name}",
    "{lesson_title}",
    "{successful_exercise_count}",
    "{recognized_practice}",
    "{confirmed_reward}",
    "{offer_id}",
    "{reward_summary}",  # legacy alias of confirmed_reward
    "{amount}",
)


def _sanitise_template(value: Any, default: str, max_len: int = 320) -> str:
    if not isinstance(value, str):
        return default
    s = value.strip()
    if not s:
        return default
    s = "".join(ch for ch in s if ch == "\n" or ord(ch) >= 32)
    if len(s) > max_len:
        s = s[:max_len]
    low = s.lower()
    for bad in _FORBIDDEN_TEMPLATE_FRAGMENTS:
        if bad in low:
            return default
    for m in re.findall(r"\{[A-Za-z_]+\}", s):
        if m not in _ALLOWED_PLACEHOLDERS:
            return default
    return s


def _sanitise_label(value: Any, default: str, max_len: int = 60) -> str:
    if not isinstance(value, str):
        return default
    s = value.strip()
    if not s:
        return default
    s = "".join(ch for ch in s if ord(ch) >= 32)
    return s[:max_len] or default


def _safe_first_name(display_name: Any) -> str:
    """Extract a safe student first-name fallback for personalization. The
    backend never invents a name — when the source is empty or unsafe the
    caller falls back to neutral wording ("You handled those exercises…")."""
    if not isinstance(display_name, str):
        return ""
    s = display_name.strip().split()
    if not s:
        return ""
    first = re.sub(r"[^\w\u0E00-\u17FF\- ]", "", s[0])
    return first[:40]


# --------------------------------------------------------------------------- #
# Config sanitiser + validator                                                #
# --------------------------------------------------------------------------- #
def _sanitise_reward_config(raw: dict | None) -> dict[str, Any]:
    """Merge an admin payload onto DEFAULT_REWARD_CONFIG with strict clamping.

    Phase 1 corrected lock: pass / achievement / voucher are forced False.
    """
    out = json.loads(json.dumps(DEFAULT_REWARD_CONFIG))
    raw = raw or {}

    for k in ("enabled", "points_enabled", "require_resolved_correction"):
        if k in raw:
            out[k] = bool(raw[k])
    # ALL non-points reward toggles are forced OFF in Phase 1 corrected.
    out["pass_enabled"] = False
    out["achievement_enabled"] = False
    out["voucher_enabled"] = False

    out["min_successful_exercises"] = _clamp_int(
        raw.get("min_successful_exercises"), 1, 50,
        out["min_successful_exercises"])
    out["min_confidence"] = _clamp_float(
        raw.get("min_confidence"), 0.0, 1.0, out["min_confidence"])
    out["min_session_seconds"] = _clamp_int(
        raw.get("min_session_seconds"), 0, 3600, out["min_session_seconds"])
    out["max_offers_per_session"] = 1  # locked

    out["cooldown_seconds"] = _clamp_int(
        raw.get("cooldown_seconds"), 0, 30 * 24 * 3600,
        out["cooldown_seconds"])
    out["daily_cap_per_student"] = _clamp_int(
        raw.get("daily_cap_per_student"), 0, 50,
        out["daily_cap_per_student"])
    out["monthly_cap_per_student"] = _clamp_int(
        raw.get("monthly_cap_per_student"), 0, 500,
        out["monthly_cap_per_student"])
    out["offer_ttl_seconds"] = _clamp_int(
        raw.get("offer_ttl_seconds"), 30, 24 * 3600,
        out["offer_ttl_seconds"])

    raw_pts = raw.get("approved_point_values")
    if isinstance(raw_pts, list):
        cleaned: list[int] = []
        for v in raw_pts:
            try:
                iv = int(v)
            except Exception:
                continue
            if iv in SAFE_POINT_VALUES and iv not in cleaned:
                cleaned.append(iv)
        if cleaned:
            out["approved_point_values"] = sorted(cleaned)

    out["button_label"] = _sanitise_label(
        raw.get("button_label"), out["button_label"], max_len=40)
    out["pre_claim_message"] = _sanitise_template(
        raw.get("pre_claim_message"), out["pre_claim_message"], max_len=200)
    out["confirmed_message_template"] = _sanitise_template(
        raw.get("confirmed_message_template"),
        out["confirmed_message_template"], max_len=200)
    out["gemini_pre_claim_template"] = _sanitise_template(
        raw.get("gemini_pre_claim_template"),
        out["gemini_pre_claim_template"], max_len=520)
    out["gemini_confirmed_template"] = _sanitise_template(
        raw.get("gemini_confirmed_template"),
        out["gemini_confirmed_template"], max_len=520)

    out["schema_version"] = CONFIG_SCHEMA_VERSION
    return out


def _validate_config_update(raw: dict | None) -> tuple[bool, str]:
    if not isinstance(raw, dict):
        return False, "config must be an object"
    if raw.get("voucher_enabled") is True:
        return False, "Voucher rewards are not available in Phase 1"
    if raw.get("pass_enabled") is True:
        return False, "EduTalk pass rewards are not available in this release"
    if raw.get("achievement_enabled") is True:
        return False, "Achievement rewards are not available in this release"
    # Audit 4.2 — the upstream helper does not accept a caller-supplied
    # stable nonce, so the operator cannot enable real point granting
    # truthfully today. We reject the runtime-config attempt; the env-var
    # path is preserved only for future-extended environments.
    if raw.get("real_grant_enabled") is True:
        return False, (
            "Real point granting cannot be enabled — the upstream "
            "treasury helper does not yet accept a stable nonce."
        )
    pts = raw.get("approved_point_values")
    if isinstance(pts, list) and pts:
        for v in pts:
            try:
                iv = int(v)
            except Exception:
                return False, f"approved_point_values contains non-integer {v!r}"
            if iv not in SAFE_POINT_VALUES:
                return False, (
                    f"{iv} is not an approved safe point value "
                    f"(allowed: {sorted(SAFE_POINT_VALUES)})"
                )
    if "min_confidence" in raw:
        try:
            c = float(raw["min_confidence"])
        except Exception:
            return False, "min_confidence must be a number"
        if not (0.0 <= c <= 1.0):
            return False, "min_confidence must be in [0.0, 1.0]"
    for key, lo, hi in (
        ("daily_cap_per_student", 0, 50),
        ("monthly_cap_per_student", 0, 500),
        ("cooldown_seconds", 0, 30 * 24 * 3600),
        ("offer_ttl_seconds", 30, 24 * 3600),
        ("min_successful_exercises", 1, 50),
        ("min_session_seconds", 0, 3600),
    ):
        if key in raw:
            try:
                v = int(raw[key])
            except Exception:
                return False, f"{key} must be an integer"
            if not (lo <= v <= hi):
                return False, f"{key} must be in [{lo}, {hi}]"
    return True, ""


# --------------------------------------------------------------------------- #
# Per-session runtime context                                                 #
# --------------------------------------------------------------------------- #
class RewardSessionCtx:
    """Per-session coordinator. Lifetime = the WS bridge. Persists nothing."""

    def __init__(self, session_id: str, clean_id: str,
                 display_name: str = "",
                 gemini_inject_cb: Optional[Callable[[str], Any]] = None,
                 client_send_cb: Optional[Callable[[dict], Any]] = None) -> None:
        self.session_id = session_id
        self.clean_id = clean_id
        self.display_name = display_name
        self._gemini_inject_cb = gemini_inject_cb
        self._client_send_cb = client_send_cb
        # ── server-owned exercise lifecycle state ─────────────────────────
        # ``current_exercise_id`` is the most-recently-issued open exercise
        # for this session (one open at a time in Phase 1). ``exercise_seq``
        # is a monotonic counter used to derive deterministic exercise IDs.
        self.current_exercise_id: Optional[str] = None
        self.exercise_seq: int = 0
        self.evaluated_exercise_ids: set[str] = set()
        # In-memory buffers of the most recent coach + student turn text;
        # the reward module reads them when evaluating a closed exercise.
        self.last_coach_text: str = ""
        self.last_student_text: str = ""
        self._closed = False

    async def emit_to_client(self, payload: dict) -> bool:
        if self._closed or not self._client_send_cb:
            return False
        try:
            await self._client_send_cb(payload)
            return True
        except Exception as exc:  # noqa: BLE001
            log.debug("reward ctx: emit_to_client failed: %s", exc)
            return False

    async def inject_gemini_text(self, text: str) -> bool:
        """AUDIT 4.7 — announcement delivery must be truthful. Returns
        True only when the underlying Gemini-inject callback completed
        without raising. False means the announcement was NOT delivered
        and the caller should NOT mark a delivered_at."""
        if self._closed or not self._gemini_inject_cb or not text:
            return False
        try:
            await self._gemini_inject_cb(text)
            return True
        except Exception as exc:  # noqa: BLE001
            log.debug("reward ctx: inject_gemini_text failed: %s", exc)
            return False

    def close(self) -> None:
        self._closed = True


# --------------------------------------------------------------------------- #
# Finding 4 — live reward-ctx registry.                                       #
# Lets the REST layer find the live WebSocket coordinator for an active       #
# session so a delayed-confirmed reward (discovered by bounded polling AFTER  #
# an earlier pending claim) can route the Gemini congratulations through the  #
# same guarded, exactly-once lifecycle as the original confirmed announce.    #
# The registry is in-process only and never persists.                         #
# --------------------------------------------------------------------------- #
_LIVE_REWARD_CTXS: dict[str, "RewardSessionCtx"] = {}


def register_live_reward_ctx(session_id: str,
                             ctx: "RewardSessionCtx | None") -> None:
    """Register the live reward ctx for a session. Idempotent."""
    if not session_id or ctx is None:
        return
    _LIVE_REWARD_CTXS[str(session_id)] = ctx


def unregister_live_reward_ctx(session_id: str,
                               ctx: "RewardSessionCtx | None" = None) -> None:
    """Remove the live reward ctx for a session. Idempotent.

    Correction 1 (final) — identity-safe removal. When ``ctx`` is supplied
    we ONLY remove the registration if the currently-registered ctx IS the
    exact object being closed. A torn-down older socket must never evict a
    newer registration that re-used the same ``session_id`` (e.g. a fast
    reconnect that registered a fresh ctx before the old bridge's finally
    block ran). When ``ctx`` is None the legacy unconditional pop is kept
    for callers that do not track the object identity."""
    if not session_id:
        return
    key = str(session_id)
    if ctx is None:
        _LIVE_REWARD_CTXS.pop(key, None)
        return
    if _LIVE_REWARD_CTXS.get(key) is ctx:
        _LIVE_REWARD_CTXS.pop(key, None)


def get_live_reward_ctx(
        session_id: str) -> "RewardSessionCtx | None":
    """Return the live reward ctx for a session, or None if no live
    bridge currently owns it. Read-only."""
    if not session_id:
        return None
    return _LIVE_REWARD_CTXS.get(str(session_id))


# --------------------------------------------------------------------------- #
# Startup index lifecycle                                                     #
# --------------------------------------------------------------------------- #
async def setup_indexes(db) -> dict[str, Any]:
    """Awaitable index setup. Called from the FastAPI startup event.

    Returns ``{"ready": bool, "details": {...}}``. Reward operations fail
    closed (eligibility returns ``no_indexes``) when ``ready`` is False.
    """
    state: dict[str, Any] = {"errors": [], "created": []}
    try:
        # Unique outbox key — the heart of grant idempotency.
        await db["edutalk_coach_rewards_grants"].create_index(
            "tx_id", unique=True)
        # One offer per session — atomic constraint.
        await db["edutalk_coach_rewards_offers"].create_index(
            "session_offer_key", unique=True)
        # Cap reservations atomic slot.
        await db["edutalk_coach_rewards_cap_reservations"].create_index(
            "reservation_key", unique=True)
        # Atomic capacity buckets (Blocker D) — one row per
        # (student, period); ``_id`` is the bucket key so it is inherently
        # unique. Index declared for explicitness on real deployments.
        await db["edutalk_coach_rewards_cap_buckets"].create_index(
            "bucket_key", unique=True)
        # Stable notification key.
        await db["edutalk_coach_rewards_notifications"].create_index(
            "notif_key", unique=True)
        # Server-owned exercises.
        await db["edutalk_coach_rewards_exercises"].create_index(
            [("session_id", 1), ("exercise_id", 1)], unique=True)
        # Supporting non-unique indexes.
        await db["edutalk_coach_rewards_offers"].create_index(
            [("clean_id", 1), ("state", 1)])
        await db["edutalk_coach_rewards_offers"].create_index("expires_at")
        await db["edutalk_coach_rewards_audit"].create_index("ts")
        # Correction A1 — stable unique audit event key for the
        # ``grant_confirmed`` lifecycle event. The unique index lets
        # ``insert_one`` be the single durable proof of existence: a
        # ``DuplicateKey`` error is the only thing that can prove the
        # event already exists, so we never falsely treat an arbitrary
        # database failure as "already inserted".
        await db["edutalk_coach_rewards_audit"].create_index(
            "event_key", unique=True, sparse=True)
        await db["edutalk_coach_rewards_notifications"].create_index(
            [("clean_id", 1), ("ts", -1)])
        state["created"] = [
            "grants.tx_id", "offers.session_offer_key",
            "cap_reservations.reservation_key",
            "notifications.notif_key", "exercises.session+exercise",
            "audit.event_key",
        ]
    except Exception as exc:  # noqa: BLE001
        state["errors"].append(f"{type(exc).__name__}: {exc}")
        log.error("reward.setup_indexes failed: %s", exc)
        return {"ready": False, "details": state}
    INDEX_READY["ready"] = True
    INDEX_READY["details"] = state
    log.info("reward.setup_indexes OK: %s", state["created"])
    # Start the reconciliation background worker.
    if _RECON_WORKER_FACTORY is not None:
        try:
            loop = asyncio.get_event_loop()
            loop.create_task(_RECON_WORKER_FACTORY())
            log.info("reward: reconciliation worker scheduled")
        except RuntimeError:
            # No running event loop at startup (tests) — skip.
            pass
        except Exception as exc:  # noqa: BLE001
            log.warning("reward: could not start reconcile worker: %s", exc)
    # Blocker A + B — process-restart recovery. Schedule one-shot
    # post-startup sweeps of incomplete confirmed-grant finalizations and
    # cap reservations stuck in ``release_pending``. Both sweeps reuse
    # the registered service callables, so a process restart NEVER waits
    # for the periodic worker tick to discover incomplete lifecycle work.
    svc = get_services() or {}
    recover_finals = svc.get("recover_incomplete_finalizations")
    recover_caps = svc.get("recover_pending_cap_releases")
    try:
        loop = asyncio.get_event_loop()
        if callable(recover_finals):
            loop.create_task(recover_finals())
        if callable(recover_caps):
            loop.create_task(recover_caps())
    except RuntimeError:
        pass
    except Exception as exc:  # noqa: BLE001
        log.warning(
            "reward: startup recovery scheduling failed: %s", exc)
    return {"ready": True, "details": state}


# Module-level readiness flag — read by ``_evaluate_eligibility`` so a
# fresh deploy without indexes refuses to issue offers.
INDEX_READY: dict[str, Any] = {"ready": False, "details": {}}


def indexes_ready() -> bool:
    return bool(INDEX_READY.get("ready"))


# --------------------------------------------------------------------------- #
# Route registration                                                          #
# --------------------------------------------------------------------------- #
def register_edutalk_coach_reward_routes(
    api, db, require_admin, require_student,
) -> dict[str, Any]:
    cfg_col = db["edutalk_coach_rewards_config"]
    ex_col = db["edutalk_coach_rewards_exercises"]
    off_col = db["edutalk_coach_rewards_offers"]
    grant_col = db["edutalk_coach_rewards_grants"]
    cap_col = db["edutalk_coach_rewards_cap_reservations"]
    # Blocker D — atomic per-(student, period) capacity buckets. The
    # bucket holds a single ``active`` counter mutated only by provably
    # atomic compare-and-update operations so a cap can never be exceeded
    # and an eligible slot is never needlessly lost under concurrency.
    cap_bucket_col = db["edutalk_coach_rewards_cap_buckets"]
    audit_col = db["edutalk_coach_rewards_audit"]
    notif_col = db["edutalk_coach_rewards_notifications"]
    sess_col = db["edutalk_live_sessions"]  # READ-ONLY use

    _CFG_ID = "singleton"

    # ─────────────────────────── config I/O ────────────────────────────── #
    async def _load_config() -> dict[str, Any]:
        doc = await cfg_col.find_one({"_id": _CFG_ID})
        if not doc:
            return json.loads(json.dumps(DEFAULT_REWARD_CONFIG))
        return _sanitise_reward_config(doc.get("config") or {})

    async def _save_config(updates: dict, admin_email: str) -> dict[str, Any]:
        clean = _sanitise_reward_config(updates)
        prev = await cfg_col.find_one({"_id": _CFG_ID}) or {}
        prev_version = int(prev.get("version") or 0)
        new_version = prev_version + 1
        await cfg_col.update_one(
            {"_id": _CFG_ID},
            {"$set": {"config": clean, "version": new_version,
                      "updated_at": _iso(), "updated_by": admin_email[:120]}},
            upsert=True,
        )
        try:
            prev_cfg = prev.get("config") or {}
            changed = sorted([k for k in clean
                              if prev_cfg.get(k) != clean.get(k)])
            await audit_col.insert_one({
                "kind": "config_update", "ts": _iso(),
                "admin": admin_email[:120],
                "prev_version": prev_version, "new_version": new_version,
                "changed_fields": changed,
            })
        except Exception as exc:  # noqa: BLE001
            log.warning("reward: audit write failed: %s", exc)
        return clean

    def _public_status(cfg: dict) -> dict[str, Any]:
        return {
            "grant_helper_ok": bool(_GRANT_HELPER_OK),
            "policy_version": POLICY_VERSION,
            "grant_adapter_version": GRANT_ADAPTER_VERSION,
            "rewards_active": bool(
                indexes_ready() and cfg.get("enabled")
                and cfg.get("points_enabled")
                and _provider_grant_available()
            ),
            "indexes_ready": indexes_ready(),
            "voucher_available": False,
            "pass_available": False,
            "achievement_available": False,
            "provider_grant_available": _provider_grant_available(),
            "wallet_service_ok": bool(_WALLET_SERVICE_OK),
            "grant_adapter_version": GRANT_ADAPTER_VERSION,
            "reconcile_last_run": _RECON_STATE.get("last_run"),
            "reconcile_resolved": _RECON_STATE.get("resolved", 0),
        }

    # ─────────────────── server-owned exercise lifecycle ──────────────── #
    async def register_exercise(
        session_id: str, clean_id: str, ctx: RewardSessionCtx,
        instruction_text: str, exercise_kind: str | None = None,
    ) -> Optional[str]:
        """Backend issues the authoritative ``exercise_id`` ONLY when the
        coach turn classifies as a supported coach-directed task (audit
        4.3). Returns None for greetings, encouragement, explanation, or
        any conversation that does NOT match one of the four supported
        kinds. Also returns None when the master rewards feature is off
        or indexes are missing.

        For ``correction_retry`` the extracted correction target phrase
        is stored on the exercise so ``evaluate_exercise`` can decide
        ``correction_resolved`` against the actual target — never against
        a generic shared-word heuristic (audit 4.4).
        """
        if not indexes_ready():
            return None
        cfg = await _load_config()
        if not (cfg.get("enabled") and cfg.get("points_enabled")):
            return None
        classified, correction_target = classify_coach_turn(
            instruction_text or "")
        if classified is None:
            # Not a supported coach-directed task — do NOT register.
            return None
        # Caller-supplied kind is an advisory only; the classifier is
        # authoritative. If the caller supplied an unsupported kind, the
        # classification still drives the stored exercise_kind.
        kind = classified
        if exercise_kind and exercise_kind in SUPPORTED_EXERCISE_KINDS:
            # Trust the caller only when its kind matches the classifier
            # decision; otherwise the classifier wins.
            if exercise_kind == classified:
                kind = exercise_kind
        ctx.exercise_seq += 1
        exercise_id = f"ex_{session_id[-12:]}_{ctx.exercise_seq:04d}"
        # correction_required is set ONLY when the coach turn is itself a
        # correction instruction — it must come from the instruction, not
        # from a downstream shared-word heuristic (audit 4.4).
        correction_required = (kind == "correction_retry")
        doc = {
            "session_id": session_id,
            "exercise_id": exercise_id,
            "clean_id": clean_id,
            "kind": kind,
            "instruction_text": (instruction_text or "")[:280],
            "correction_target": (correction_target or "")[:140] or None,
            "correction_required": correction_required,
            "correction_resolved": False,
            "instruction_ts": _iso(),
            "response_ts": None,
            "response_text": None,
            "state": "open",
            "result": None,
            "consumed_by_offer": None,
            "created_at": _iso(),
        }
        try:
            await ex_col.insert_one(doc)
        except Exception as exc:  # noqa: BLE001
            log.debug("reward: exercise insert failed (dup?): %s", exc)
            return None
        ctx.current_exercise_id = exercise_id
        return exercise_id

    async def evaluate_exercise(
        session_id: str, clean_id: str, ctx: RewardSessionCtx,
        response_text: str,
    ) -> Optional[dict]:
        """Terminate the currently-open exercise based on observable
        student response. Backend owns the success decision; Gemini never
        decides eligibility.

        Phase 1 evaluation (deterministic, server-only):
          * response must arrive AFTER the instruction;
          * response text length ≥ 8 visible chars;
          * basic shared-token overlap with the instruction OR
            (for correction_retry) overlap with the CORRECTION TARGET
            specifically — not a generic shared-word heuristic;
          * ``correction_resolved`` is set ONLY when this exercise was
            registered as a ``correction_retry`` AND the student response
            demonstrably re-attempts the correction target (audit 4.4).
        """
        if not indexes_ready():
            return None
        cfg = await _load_config()
        if not (cfg.get("enabled") and cfg.get("points_enabled")):
            return None
        exid = ctx.current_exercise_id
        if not exid:
            return None
        if exid in ctx.evaluated_exercise_ids:
            return None
        doc = await ex_col.find_one(
            {"session_id": session_id, "exercise_id": exid,
             "clean_id": clean_id})
        if not doc or doc.get("state") != "open":
            return None
        resp = (response_text or "").strip()
        instruction = (doc.get("instruction_text") or "").strip()
        correction_target = (doc.get("correction_target") or "").strip()
        visible = re.sub(r"\s+", "", resp)
        if len(visible) < 8:
            await ex_col.update_one(
                {"session_id": session_id, "exercise_id": exid},
                {"$set": {"state": "terminal", "result": "ignored",
                          "response_ts": _iso(),
                          "response_text": resp[:280]}})
            ctx.evaluated_exercise_ids.add(exid)
            ctx.current_exercise_id = None
            return None

        # B3 (audit) — per-kind gating based on content-word coverage
        # (stopword-filtered) AND order/sequence similarity. The old
        # additive heuristic (``one shared word OR visible ≥ 16``) is
        # removed; a single shared content word can no longer pass any
        # exercise, and ``correction_resolved`` now requires ≥ 2 target
        # content tokens AND coverage ≥ 0.6.
        from difflib import SequenceMatcher

        _STOPWORDS = {"the", "and", "but", "for", "nor", "yet", "with",
                      "from", "into", "onto", "off", "out", "than", "this",
                      "that", "these", "those", "you", "your", "are", "was",
                      "were", "have", "has", "had", "not", "his", "her",
                      "its", "our", "their", "any", "all", "let", "lets",
                      "she", "him", "they", "them", "who", "what", "when",
                      "where", "why", "how", "can", "will", "would",
                      "should", "could", "may", "might", "did", "does",
                      "done", "got", "get", "say", "said", "tell"}

        def _content_words(s: str) -> set[str]:
            return {w.lower() for w in re.findall(r"[A-Za-z]{3,}", s)
                    if w.lower() not in _STOPWORDS}

        def _norm(s: str) -> str:
            return re.sub(r"\s+", " ",
                          re.sub(r"[^A-Za-z0-9 ]+", " ", (s or "").lower())
                          ).strip()

        def _target_phrase(kind: str, instr: str,
                           ct: str) -> str:
            """Return the phrase the student is expected to reproduce.
            For correction_retry prefer the classifier-extracted target.
            For repeat/book kinds prefer a quoted segment or the text
            after a colon, falling back to the instruction itself."""
            if ct:
                return ct.strip()
            s = (instr or "").strip()
            mq = re.search(r'"([^"]{3,140})"', s)
            if mq:
                return mq.group(1).strip()
            if ":" in s:
                tail = s.split(":", 1)[1].strip()
                if tail:
                    return tail
            ms = re.search(r"\bsay\b\s*[:,]?\s*(.{3,})", s, re.IGNORECASE)
            if ms:
                return ms.group(1).strip()
            return s

        kind = (doc.get("kind") or "guided_short_answer")
        target_text = _target_phrase(kind, instruction, correction_target)
        target_tokens = _content_words(target_text)
        response_tokens = _content_words(resp)
        shared = target_tokens & response_tokens
        coverage = (len(shared) / len(target_tokens)) if target_tokens else 0.0
        sim = SequenceMatcher(None, _norm(target_text), _norm(resp)).ratio()

        # Per-kind success gating.
        success = False
        if kind in ("repeat_after_coach", "book_shadow_sentence"):
            # Repetition tasks require strong target coverage AND order
            # similarity. A single shared content word must NOT pass.
            success = (
                len(shared) >= 2
                and coverage >= 0.6
                and sim >= 0.6
            )
        elif kind == "correction_retry":
            # Correction tasks: require ≥2 non-stopword target tokens
            # AND coverage ≥ 0.6, OR strong sequence similarity when the
            # extracted target is short.
            if target_tokens:
                success = (
                    len(shared) >= 2 and coverage >= 0.6
                ) or (coverage >= 0.6 and sim >= 0.6)
            else:
                # No extractable target phrase — fall back to instruction
                # overlap so the exercise lifecycle can still terminate
                # successfully when the response substantially mirrors
                # the corrective instruction.
                instr_tokens = _content_words(instruction)
                instr_shared = instr_tokens & response_tokens
                instr_cov = (len(instr_shared) / len(instr_tokens)
                             if instr_tokens else 0.0)
                success = (
                    len(instr_shared) >= 2 and instr_cov >= 0.6
                )
        elif kind == "guided_short_answer":
            # Open-ended task: require a non-trivial response (≥3 content
            # words). When the instruction carries a topic, also require
            # at least one topical overlap so an unrelated dump cannot
            # pass. Success must not require literally repeating the
            # question.
            if len(response_tokens) < 3:
                success = False
            else:
                instr_tokens = _content_words(instruction)
                topic_tokens = instr_tokens - {"please", "really"}
                if topic_tokens:
                    overlap = topic_tokens & response_tokens
                    success = bool(overlap) or sim >= 0.45
                else:
                    success = True
        else:  # pragma: no cover — defensive default
            success = False

        # Correction-resolved is independent of overall success — it
        # specifically asks whether the student re-attempted the
        # CORRECTION TARGET (audit 4.4). One-token overlap MUST NOT
        # resolve a correction.
        correction_resolved = False
        if doc.get("correction_required") and correction_target:
            ct_tokens = _content_words(correction_target)
            ct_shared = ct_tokens & response_tokens
            ct_cov = (len(ct_shared) / len(ct_tokens)) if ct_tokens else 0.0
            if len(ct_shared) >= 2 and ct_cov >= 0.6:
                correction_resolved = True

        meaningful = success
        # Confidence is derived from the same coverage/similarity
        # measures rather than a length bonus.
        confidence = round(min(0.95, 0.40 + 0.35 * coverage + 0.25 * sim), 2)
        if not success:
            # Failing the per-kind gate caps confidence below the
            # default threshold so the result is recorded as ``failed``.
            confidence = min(confidence, 0.50)
        min_conf = max(0.0, min(1.0, float(cfg.get("min_confidence", 0.7))))
        if (not success) or confidence < min_conf:
            await ex_col.update_one(
                {"session_id": session_id, "exercise_id": exid},
                {"$set": {"state": "terminal", "result": "failed",
                          "response_ts": _iso(),
                          "response_text": resp[:280],
                          "confidence": confidence}})
            ctx.evaluated_exercise_ids.add(exid)
            ctx.current_exercise_id = None
            return None
        result_doc = {
            "state": "terminal", "result": "successful",
            "response_ts": _iso(), "response_text": resp[:280],
            "confidence": confidence,
            # correction_resolved comes ONLY from this evaluation step;
            # correction_required was already set at registration time.
            "correction_resolved": correction_resolved,
            "meaningful_response": meaningful,
            "instruction_followed": True,
        }
        await ex_col.update_one(
            {"session_id": session_id, "exercise_id": exid},
            {"$set": result_doc})
        ctx.evaluated_exercise_ids.add(exid)
        ctx.current_exercise_id = None
        offer = await _create_offer_if_eligible(
            session_id, clean_id, ctx.display_name, cfg, ctx=ctx)
        if offer:
            await _emit_offer_available(offer, cfg, ctx)
        return result_doc

    # ─────────────────────── recognition snapshot ─────────────────────── #
    async def _build_recognition_snapshot(
        session_id: str, clean_id: str, display_name: str,
    ) -> dict[str, Any]:
        """Backend-authoritative summary used for the personalized
        announcements. Only validated facts — no inferred traits."""
        # Count of distinct successful exercises in this session.
        successful = await ex_col.count_documents({
            "session_id": session_id, "clean_id": clean_id,
            "state": "terminal", "result": "successful",
        })
        # Most recent resolved correction (if any).
        resolved = await ex_col.find_one(
            {"session_id": session_id, "clean_id": clean_id,
             "state": "terminal", "result": "successful",
             "correction_resolved": True},
            sort=[("response_ts", -1)])
        # Lesson title — best-effort from the live session record.
        session = await sess_col.find_one({"session_id": session_id})
        lesson_title = ""
        try:
            ctx_obj = (session or {}).get("context") or {}
            lesson_title = (ctx_obj.get("title")
                            or ctx_obj.get("lesson_title")
                            or session.get("lesson_title") if session else "")
        except Exception:
            lesson_title = ""
        first = _safe_first_name(display_name)
        recognized = (
            "corrected and repeated the target sentence successfully"
            if resolved else
            "completed a focused run of speaking practice"
        )
        snapshot = {
            "student_name": first,                  # may be ""
            "lesson_title": lesson_title or "your current lesson",
            "successful_exercise_count": int(successful),
            "recognized_practice": recognized,
        }
        return snapshot

    # ─────────────── eligibility (cap check is reservation-based) ─────── #
    async def _evaluate_eligibility(
        session_id: str, clean_id: str, cfg: dict, ctx: RewardSessionCtx | None,
    ) -> tuple[bool, str, dict]:
        snapshot: dict[str, Any] = {
            "policy_version": POLICY_VERSION, "evaluated_at": _iso(),
        }
        if not indexes_ready():
            return False, "indexes_not_ready", snapshot
        if not cfg.get("enabled"):
            return False, "master_disabled", snapshot
        if not cfg.get("points_enabled"):
            return False, "no_reward_type_enabled", snapshot
        # B1 (audit) — capability gate: fail closed BEFORE creating any
        # offer / WS event / Gemini announcement / claim-start notif when
        # the upstream stable-nonce provider is not actually available.
        if not _provider_grant_available():
            return False, "provider_unavailable", snapshot
        session = await sess_col.find_one({"session_id": session_id})
        if not session or session.get("clean_id") != clean_id:
            return False, "wrong_session", snapshot
        if session.get("state") not in ("pending_reserved", "active"):
            return False, "session_not_active", snapshot
        active_ts = session.get("active_ts")
        try:
            elapsed = (time.time() - float(active_ts)) if active_ts else 0
        except Exception:
            elapsed = 0
        snapshot["elapsed_seconds"] = int(elapsed)
        if elapsed < int(cfg.get("min_session_seconds", 45)):
            return False, "session_too_short", snapshot

        distinct_ids = await ex_col.distinct(
            "exercise_id",
            {"session_id": session_id, "clean_id": clean_id,
             "state": "terminal", "result": "successful",
             "consumed_by_offer": None})
        snapshot["distinct_exercises"] = len(distinct_ids)
        if len(distinct_ids) < int(cfg.get("min_successful_exercises", 3)):
            return False, "insufficient_exercises", snapshot

        if cfg.get("require_resolved_correction"):
            resolved = await ex_col.count_documents({
                "session_id": session_id, "clean_id": clean_id,
                "state": "terminal", "result": "successful",
                "correction_resolved": True, "consumed_by_offer": None,
            })
            if resolved < 1:
                return False, "no_resolved_correction", snapshot

        # One offer per session is also enforced by the unique
        # ``session_offer_key`` index, but a soft check here returns the
        # existing offer earlier and avoids a duplicate-key on every call.
        existing = await off_col.find_one({"session_id": session_id})
        if existing:
            return False, "session_offer_exists", snapshot

        cooldown = int(cfg.get("cooldown_seconds", 0))
        if cooldown > 0:
            cutoff = (_now() - timedelta(seconds=cooldown)).isoformat()
            recent = await off_col.find_one(
                {"clean_id": clean_id, "created_at": {"$gte": cutoff}})
            if recent:
                return False, "cooldown_active", snapshot

        # Soft cap check — the AUTHORITATIVE enforcement happens in
        # ``_reserve_cap_slot`` below (atomic insert + count).
        day_count = await cap_col.count_documents({
            "clean_id": clean_id, "period_kind": "day",
            "period_key": _today_key(), "state": {"$in": ["held", "confirmed"]},
        })
        if day_count >= int(cfg.get("daily_cap_per_student", 1)):
            return False, "daily_cap_reached", snapshot
        month_count = await cap_col.count_documents({
            "clean_id": clean_id, "period_kind": "month",
            "period_key": _month_key(),
            "state": {"$in": ["held", "confirmed"]},
        })
        if month_count >= int(cfg.get("monthly_cap_per_student", 8)):
            return False, "monthly_cap_reached", snapshot
        snapshot["distinct_exercise_ids"] = distinct_ids
        return True, "", snapshot

    def _bucket_key(clean_id: str, period_kind: str, period_key: str) -> str:
        return f"{clean_id}:{period_kind}:{period_key}"

    async def _reserve_cap_slot(
        clean_id: str, offer_id: str, period_kind: str, period_key: str,
        cap_value: int,
    ) -> bool:
        """Blocker D — provably atomic per-period capacity reservation.

        Replaces the previous insert-then-count-then-release-self design
        (which let two concurrent contenders both observe over-cap and
        both self-release, losing an eligible slot, or both pass before
        either counted, over-granting). The capacity is now governed by a
        single ``active`` counter on a per-(student, period) bucket
        document, claimed via a CONDITIONAL atomic increment:

            find_one_and_update({_id: bucket, active: {$lt: cap}},
                                {$inc: {active: 1}})

        Mongo applies the predicate + ``$inc`` as one atomic operation, so
        when one slot remains and two claims race, exactly ONE wins the
        increment and the other matches nothing. The winner then persists
        an idempotent reservation row; the loser fails cleanly. Every
        database error FAILS CLOSED (returns False) so eligibility refuses
        to create an offer. A reservation already held/confirmed by THIS
        offer returns True without taking a second slot (idempotent).
        """
        cap_value = int(cap_value)
        if cap_value <= 0:
            return False
        rkey = f"{clean_id}:{period_key}:{offer_id}"
        bkey = _bucket_key(clean_id, period_kind, period_key)
        # Ensure the bucket document exists (idempotent create).
        try:
            await cap_bucket_col.insert_one({
                "_id": bkey, "bucket_key": bkey, "clean_id": clean_id,
                "period_kind": period_kind, "period_key": period_key,
                "active": 0, "created_at": _iso(),
            })
        except Exception as exc:  # noqa: BLE001
            if not _is_duplicate_key(exc):
                log.error("reward: cap bucket create failed (%s %s): %s",
                          period_kind, period_key, exc)
                return False
        # Idempotency — this offer already owns a live slot in this period.
        try:
            existing = await cap_col.find_one({"reservation_key": rkey})
        except Exception as exc:  # noqa: BLE001
            log.error("reward: cap reservation read failed: %s", exc)
            return False
        if existing and existing.get("state") in ("held", "confirmed"):
            return True
        # Atomic compare-and-update — admit only while active < cap.
        try:
            won = await cap_bucket_col.find_one_and_update(
                {"_id": bkey, "active": {"$lt": cap_value}},
                {"$inc": {"active": 1}})
        except Exception as exc:  # noqa: BLE001
            log.error("reward: cap bucket reserve failed (%s %s): %s",
                      period_kind, period_key, exc)
            return False
        if not won:
            # Cap is full — clean, deterministic loss (no slot consumed).
            return False
        # We own a slot — persist the durable reservation row.
        try:
            await cap_col.insert_one({
                "reservation_key": rkey, "bucket_key": bkey,
                "clean_id": clean_id, "offer_id": offer_id,
                "period_kind": period_kind, "period_key": period_key,
                "state": "held", "created_at": _iso(),
            })
        except Exception as exc:  # noqa: BLE001
            # Persist failed AFTER taking the slot — roll the counter back
            # exactly once so the slot is not leaked, then fail closed
            # (unless this is our own duplicate, which means already held).
            try:
                await cap_bucket_col.update_one(
                    {"_id": bkey}, {"$inc": {"active": -1}})
            except Exception:
                pass
            if _is_duplicate_key(exc):
                return True
            log.error("reward: cap reservation persist failed (%s %s): %s",
                      period_kind, period_key, exc)
            return False
        return True

    # ───────────────────────── offer creation ─────────────────────────── #
    def _select_reward(cfg: dict) -> dict | None:
        if cfg.get("points_enabled"):
            pool = [v for v in cfg.get("approved_point_values") or []
                    if v in SAFE_POINT_VALUES]
            if pool:
                amount = sorted(pool)[0]
                return {"type": "points", "amount": int(amount),
                        "summary": f"{amount} EduHub Points"}
        return None

    async def _create_offer_if_eligible(
        session_id: str, clean_id: str, display_name: str, cfg: dict,
        ctx: RewardSessionCtx | None = None,
    ) -> dict | None:
        # B1 (audit) — belt-and-suspenders: refuse to create any offer if
        # provider is unavailable, even if the eligibility check is
        # somehow bypassed (defence in depth).
        if not _provider_grant_available():
            return None
        eligible, reason, snapshot = await _evaluate_eligibility(
            session_id, clean_id, cfg, ctx)
        if not eligible:
            log.debug("reward: not eligible sid=%s reason=%s",
                      session_id, reason)
            return None
        reward = _select_reward(cfg)
        if not reward:
            return None
        offer_id = "rwd_" + secrets.token_hex(10)
        now = _now()
        ttl = int(cfg.get("offer_ttl_seconds", 300))
        expires_at = now + timedelta(seconds=ttl)
        # Atomic per-period cap reservation. Both day + month must succeed.
        ok_day = await _reserve_cap_slot(
            clean_id, offer_id, "day", _today_key(now),
            int(cfg.get("daily_cap_per_student", 1)))
        if not ok_day:
            return None
        ok_month = await _reserve_cap_slot(
            clean_id, offer_id, "month", _month_key(now),
            int(cfg.get("monthly_cap_per_student", 8)))
        if not ok_month:
            await _release_caps_for_offer(offer_id, "month_cap_race")
            return None
        frozen_cfg = {
            "policy_version": POLICY_VERSION,
            "grant_adapter_version": GRANT_ADAPTER_VERSION,
            "config_schema_version": CONFIG_SCHEMA_VERSION,
            "points_enabled": True,
            "approved_point_values": list(cfg.get("approved_point_values") or []),
            "min_confidence": float(cfg.get("min_confidence", 0.7)),
            "min_successful_exercises": int(
                cfg.get("min_successful_exercises", 3)),
            "cooldown_seconds": int(cfg.get("cooldown_seconds", 0)),
            "daily_cap_per_student": int(cfg.get("daily_cap_per_student", 1)),
            "monthly_cap_per_student": int(cfg.get("monthly_cap_per_student", 8)),
            "offer_ttl_seconds": ttl,
            "confirmed_message_template": cfg.get("confirmed_message_template"),
            "gemini_pre_claim_template": cfg.get("gemini_pre_claim_template"),
            "gemini_confirmed_template": cfg.get("gemini_confirmed_template"),
            "button_label": cfg.get("button_label"),
            "pre_claim_message": cfg.get("pre_claim_message"),
        }
        # Stable grant identity — the heart of idempotent dispatch.
        tx_id = f"edutalk-coach-reward:{offer_id}:{reward['type']}"
        recognition = await _build_recognition_snapshot(
            session_id, clean_id, display_name)
        offer_doc = {
            "_id": offer_id,
            "offer_id": offer_id,
            "session_id": session_id,
            "session_offer_key": f"{clean_id}:{session_id}",
            "clean_id": clean_id,
            "display_name": (display_name or "")[:80],
            "reward_type": reward["type"],
            "reward_amount": int(reward.get("amount") or 0),
            "reward_spec": {k: v for k, v in reward.items() if k != "type"},
            "state": "claimable",
            "tx_id": tx_id,
            "created_at": now.isoformat(),
            "expires_at": expires_at.isoformat(),
            "config_snapshot": frozen_cfg,
            "decision_snapshot": snapshot,
            "recognition_snapshot": recognition,
            "evidence_exercise_ids": snapshot.get("distinct_exercise_ids", []),
            "claim_started_at": None,
            "claim_confirmed_at": None,
            "claim_day": None,
            "claim_month": None,
            "claim_result": None,
            # AUDIT 4.7 announcement delivery lifecycle.
            "offer_announcement_reserved_at": None,
            "offer_announcement_delivered_at": None,
            "offer_announcement_last_error": None,
            "claim_announcement_reserved_at": None,
            "claim_announcement_delivered_at": None,
            "claim_announcement_last_error": None,
            "notif_claim_started_sent": False,
            "notif_confirmed_sent": False,
        }
        try:
            await off_col.insert_one(offer_doc)
        except Exception as exc:  # noqa: BLE001
            # Unique ``session_offer_key`` collision — concurrent path
            # already created an offer for this session. Release the
            # reservations and return the existing offer.
            log.info("reward: concurrent offer collision sid=%s (%s)",
                     session_id, exc)
            await _release_caps_for_offer(offer_id, "session_offer_collision")
            existing = await off_col.find_one({"session_id": session_id})
            return existing
        # Consume the eligible exercises so they cannot stage a second offer.
        try:
            await ex_col.update_many(
                {"session_id": session_id, "clean_id": clean_id,
                 "result": "successful", "consumed_by_offer": None},
                {"$set": {"consumed_by_offer": offer_id}})
        except Exception as exc:  # noqa: BLE001
            log.debug("reward: consume exercises failed: %s", exc)
        try:
            await audit_col.insert_one({
                "kind": "offer_created", "ts": _iso(),
                "session_id": session_id, "clean_id": clean_id,
                "offer_id": offer_id, "reward_type": reward["type"],
                "tx_id": tx_id,
            })
        except Exception:
            pass
        return offer_doc

    async def _emit_offer_available(
        offer: dict, cfg: dict, ctx: RewardSessionCtx,
    ) -> None:
        """AUDIT 4.7 — announcement delivery has a real reserved →
        delivered lifecycle. ``offer_announcement_reserved_at`` is the
        atomic reservation; ``offer_announcement_delivered_at`` is set
        ONLY after both the WS emit AND the Gemini inject succeed. A
        failure records ``offer_announcement_last_error`` and clears the
        reservation so a safe retry can run on the next eligibility
        trigger or reconnect."""
        # B1 (audit) — capability gate: refuse to emit any WS event,
        # Gemini announcement, or claim-start scaffolding when the
        # upstream provider is not actually available. Defence in depth
        # in case a stale offer is somehow handed in.
        if not _provider_grant_available():
            return
        offer_id = offer["offer_id"]
        # Atomic reserve. Only one in-flight delivery attempt at a time.
        guard = await off_col.find_one_and_update(
            {"_id": offer_id,
             "offer_announcement_reserved_at": None,
             "offer_announcement_delivered_at": None},
            {"$set": {"offer_announcement_reserved_at": _iso()}})
        if not guard:
            # Already reserved or already delivered — nothing to do.
            return
        ws_ok = await ctx.emit_to_client({
            "type": "reward_offer_available",
            "offer_id": offer_id,
            "session_id": offer["session_id"],
            "expires_at": offer["expires_at"],
            "button_label": cfg.get(
                "button_label", DEFAULT_REWARD_CONFIG["button_label"]),
            "pre_claim_message": _render_student_pre_claim(offer, cfg),
        })
        recog = offer.get("recognition_snapshot") or {}
        template = cfg.get(
            "gemini_pre_claim_template",
            DEFAULT_REWARD_CONFIG["gemini_pre_claim_template"])
        text_for_gemini = _safe_format(template, {
            "student_name": recog.get("student_name") or "the student",
            "lesson_title": recog.get("lesson_title", "the lesson"),
            "successful_exercise_count": str(
                recog.get("successful_exercise_count", 0)),
            "recognized_practice": recog.get("recognized_practice",
                                             "completed today's practice"),
            "offer_id": offer_id,
            "confirmed_reward": "",
            "reward_summary": "",
            "amount": "",
        })
        gem_ok = await ctx.inject_gemini_text(text_for_gemini)
        if ws_ok and gem_ok:
            await off_col.update_one(
                {"_id": offer_id},
                {"$set": {"offer_announcement_delivered_at": _iso()}})
        else:
            # Clear the reservation so a future trigger can retry safely.
            await off_col.update_one(
                {"_id": offer_id},
                {"$set": {
                    "offer_announcement_reserved_at": None,
                    "offer_announcement_last_error": (
                        f"ws_ok={ws_ok};gem_ok={gem_ok}"),
                }})

    def _render_student_pre_claim(offer: dict, cfg: dict) -> str:
        recog = offer.get("recognition_snapshot") or {}
        first = recog.get("student_name") or ""
        text = cfg.get(
            "pre_claim_message", DEFAULT_REWARD_CONFIG["pre_claim_message"])
        if first:
            return f"{first}, {text}"
        return text

    def _safe_format(template: str, mapping: dict[str, str]) -> str:
        """Format using only allowed placeholders — never raises."""
        out = template
        for k, v in mapping.items():
            out = out.replace("{" + k + "}", str(v))
        return out

    # ───────────────── durable outbox grant (idempotent) ──────────────── #

    # ─────────── shared stable-grant-helper resolver ─────────────────── #
    def _resolve_stable_grant_helper():
        """Return the callable to use for provider credit operations.

        Resolution order (fail-closed):
          1. Module-globals injection: ``_gas_treasury_credit_with_nonce``
             set via ``globals()`` (test helper / future live helper).
          2. Built-in WalletService closure: the locally-defined
             ``_gas_treasury_credit_with_nonce`` async function, available
             only when ``_GRANT_HELPER_OK`` is True and ``_WalletService``
             is not None.
          3. None — no callable available; caller must fail-closed.

        Both dispatch and reconciliation call this resolver; neither
        may reference a credit callable from the other's local scope.
        Retries and reconciliation reuse the already-stored idempotency
        key — this resolver never generates a new one.
        """
        injected = globals().get("_gas_treasury_credit_with_nonce")
        if callable(injected):
            return injected
        if _GRANT_HELPER_OK and _WalletService is not None:
            return _gas_treasury_credit_with_nonce
        return None

    # ─────────────── stable-nonce wallet credit helper ───────────────── #
    async def _gas_treasury_credit_with_nonce(
        clean_id: str,
        amount: int,
        provider_idempotency_key: str,
    ) -> dict[str, Any]:
        """Stable-idempotency wallet credit via WalletService.credit().

        WalletService.credit() accepts a caller-supplied idempotency_key
        and enforces uniqueness via a sparse unique index on the
        points_transactions collection. This makes retries with the same
        key safe — duplicates are detected and returned as
        ok=True, duplicate=True without re-crediting.

        Outcome values (returned dict):
          "granted"               — confirmed credit (new or duplicate).
          "grant_unknown"         — ambiguous; may have reached provider.
          "grant_retryable"       — proven pre-send; safe to retry same key.
          "grant_terminal_failed" — permanent failure; do not retry.
        """
        if not _WALLET_SERVICE_OK or _WalletService is None:
            return {
                "outcome": "grant_terminal_failed",
                "provider_ref": None, "balance_after": None,
                "duplicate": False,
                "error": "wallet_service_unavailable",
            }
        try:
            svc = _WalletService(db)
            result = await svc.credit(
                clean_id,
                amount,
                source="edutalk_coach_reward",
                source_ref=provider_idempotency_key[:64],
                idempotency_key=provider_idempotency_key,
                payload={
                    "feature": "edutalk_coach_reward",
                    "idempotency_key_prefix": provider_idempotency_key[:16],
                },
                allow_status=False,
            )
            if result.get("ok"):
                txn = result.get("transaction") or {}
                provider_ref = (
                    str(txn.get("_id") or "") or provider_idempotency_key
                )
                return {
                    "outcome": "granted",
                    "provider_ref": provider_ref,
                    "balance_after": result.get("balance_after"),
                    "duplicate": bool(result.get("duplicate")),
                    "error": None,
                }
            # ok=False without exception — unexpected; treat conservatively.
            return {
                "outcome": "grant_terminal_failed",
                "provider_ref": None, "balance_after": None,
                "duplicate": False, "error": "credit_not_ok",
            }
        except _WalletStatusBlocked as exc:
            return {
                "outcome": "grant_terminal_failed",
                "provider_ref": None, "balance_after": None,
                "duplicate": False,
                "error": f"wallet_blocked:{type(exc).__name__}",
            }
        except _WalletNotFound as exc:
            return {
                "outcome": "grant_terminal_failed",
                "provider_ref": None, "balance_after": None,
                "duplicate": False,
                "error": f"wallet_not_found:{type(exc).__name__}",
            }
        except _WalletError as exc:
            code = getattr(exc, "code", "") or type(exc).__name__
            return {
                "outcome": "grant_terminal_failed",
                "provider_ref": None, "balance_after": None,
                "duplicate": False,
                "error": f"wallet_error:{code}",
            }
        except (OSError, ConnectionError, TimeoutError) as exc:
            # Transport — genuinely ambiguous after possible partial send.
            return {
                "outcome": "grant_unknown",
                "provider_ref": None, "balance_after": None,
                "duplicate": False,
                "error": f"transport:{type(exc).__name__}",
            }
        except Exception as exc:  # noqa: BLE001
            err_name = type(exc).__name__
            err_msg = str(exc)[:80]
            # Any unexpected exception is conservatively ambiguous — we
            # cannot be sure the credit did not partially apply.
            log.warning("reward: credit_with_nonce unexpected exc=%s msg=%s",
                        err_name, err_msg)
            return {
                "outcome": "grant_unknown",
                "provider_ref": None, "balance_after": None,
                "duplicate": False,
                "error": f"{err_name}:{err_msg}",
            }

    async def _lookup_grant_by_key(
        provider_idempotency_key: str,
    ) -> Optional[dict]:
        """Check whether a credit was already applied for this key.

        Queries points_transactions directly by idempotency_key (unique
        sparse index in WalletService). Returns the txn doc or None.
        Used by reconciliation to resolve grant_unknown claims without
        reissuing a credit.
        """
        try:
            txn = await db["points_transactions"].find_one(
                {"idempotency_key": provider_idempotency_key},
                {"_id": 1, "balance_after": 1, "status": 1, "operation": 1,
                 "source": 1, "created_at": 1},
            )
            return txn
        except Exception as exc:  # noqa: BLE001
            log.warning("reward: _lookup_grant_by_key failed: %s", exc)
            return None

    # ──────────── production durable grant dispatch (idempotent) ─────────── #
    async def _dispatch_grant(offer: dict) -> tuple[str, str, str]:
        """Run one durable, idempotent grant dispatch attempt.

        Grant outbox (grant_col) state machine:
          grant_prepared  → grant_dispatching → granted
                                              → grant_unknown       (ambiguous)
                                              → grant_retryable     (pre-send)
                                              → grant_terminal_failed

        Idempotency properties:
        * provider_idempotency_key is SHA-256 derived from immutable claim
          identity and STORED on the outbox row BEFORE the first provider call.
        * Retries reuse the exact same stored key.
        * Reconciliation uses the same stored key for ledger lookup.
        * WalletService.credit() enforces unique-key constraint internally.

        Returns (outcome, reason, provider_ref) where outcome is one of:
          "granted", "pending", "grant_retryable", "grant_terminal_failed".
        "pending" means reconciliation will resolve it asynchronously.
        """
        if offer.get("reward_type") != "points":
            return "grant_terminal_failed", "non_points_reward_unsupported", ""
        amount = int(offer.get("reward_amount") or 0)
        if amount <= 0:
            return "grant_terminal_failed", "non_positive_amount", ""

        offer_id = offer["offer_id"]
        clean_id = offer["clean_id"]
        session_id = offer.get("session_id") or ""
        reward_kind = offer.get("reward_type") or "points"

        # Compute the stable provider idempotency key BEFORE any provider call.
        provider_idempotency_key = _stable_provider_key(
            offer_id=offer_id,
            clean_id=clean_id,
            session_id=session_id,
            reward_kind=reward_kind,
            reward_amount=amount,
        )
        # Outbox identity (distinct from provider key for auditability).
        tx_id = offer.get("tx_id") or (
            f"edutalk-coach-reward:{offer_id}:points"
        )

        # ── Step 1: Upsert the grant outbox row (idempotent insert) ──────
        try:
            await grant_col.insert_one({
                "tx_id": tx_id,
                "offer_id": offer_id,
                "clean_id": clean_id,
                "amount": amount,
                "state": "grant_prepared",
                "provider_idempotency_key": provider_idempotency_key,
                "attempts": 0,
                "recon_attempts": 0,
                "created_at": _iso(),
                "last_error": None,
                "provider_ref": None,
                "confirmed_at": None,
                "failed_at": None,
            })
        except Exception as exc:  # noqa: BLE001
            if not _is_duplicate_key(exc):
                log.error("reward: grant outbox insert failed: %s", exc)
                return "grant_terminal_failed", "outbox_insert_failed", ""

        # ── Step 2: Read current grant state ─────────────────────────────
        row = await grant_col.find_one({"tx_id": tx_id})
        if not row:
            return "grant_terminal_failed", "outbox_row_missing", ""

        state = row.get("state")
        stored_key = (
            row.get("provider_idempotency_key") or provider_idempotency_key
        )

        # Terminal outcomes — return immediately.
        if state == "granted":
            return "granted", "", row.get("provider_ref") or tx_id
        if state == "grant_terminal_failed":
            return "grant_terminal_failed", row.get("last_error") or "", ""
        if state == "grant_dispatching":
            # Another dispatcher owns this outbox row.
            return "pending", "concurrent_dispatch", tx_id
        if state == "grant_unknown":
            # Must go to reconciliation — do not re-dispatch blind.
            return "pending", "grant_unknown_pending_reconcile", tx_id

        # ── Step 3: Capability gate + resolve the credit callable ────────
        # REAL_GRANT_ENABLED must be True for any dispatch attempt.
        if not REAL_GRANT_ENABLED:
            await grant_col.update_one(
                {"tx_id": tx_id,
                 "state": {"$in": ["grant_prepared", "grant_retryable"]}},
                {"$set": {
                    "state": "grant_terminal_failed",
                    "failed_at": _iso(),
                    "last_error": "real_grant_not_enabled",
                    "laboratory_mode": True,
                }})
            return "grant_terminal_failed", "real_grant_not_enabled", ""

        # Resolve the callable that will actually be invoked via the shared
        # resolver. _resolve_stable_grant_helper() checks module-globals
        # injection first (tests / future live helper) then falls back to
        # the built-in WalletService closure. Returns None when unavailable.
        _credit_fn_to_call = _resolve_stable_grant_helper()
        if _credit_fn_to_call is None:
            # Neither injected helper nor WalletService is available.
            await grant_col.update_one(
                {"tx_id": tx_id,
                 "state": {"$in": ["grant_prepared", "grant_retryable"]}},
                {"$set": {
                    "state": "grant_terminal_failed",
                    "failed_at": _iso(),
                    "last_error": "wallet_service_unavailable",
                }})
            return "grant_terminal_failed", "wallet_service_unavailable", ""

        # ── Step 4: Atomic lease — only one dispatcher at a time ─────────
        won = await grant_col.find_one_and_update(
            {"tx_id": tx_id,
             "state": {"$in": ["grant_prepared", "grant_retryable"]}},
            {"$set": {
                "state": "grant_dispatching",
                "dispatching_at": _iso(),
                "provider_idempotency_key": stored_key,
            },
             "$inc": {"attempts": 1}},
        )
        if not won:
            # State moved concurrently — re-read.
            fresh = await grant_col.find_one({"tx_id": tx_id})
            st2 = (fresh or {}).get("state")
            if st2 == "granted":
                return "granted", "", (fresh or {}).get("provider_ref") or tx_id
            if st2 == "grant_terminal_failed":
                return (
                    "grant_terminal_failed",
                    (fresh or {}).get("last_error") or "", ""
                )
            return "pending", "concurrent_dispatch", tx_id

        # ── Step 5: Dispatch to provider ──────────────────────────────────
        # stored_key is already persisted from Step 4 $set.
        # _credit_fn_to_call was resolved in Step 3.
        try:
            grant_result = await _credit_fn_to_call(
                clean_id, amount, stored_key,
            )
        except Exception as exc:  # noqa: BLE001
            grant_result = {
                "outcome": "grant_unknown",
                "error": f"wrapper_exc:{type(exc).__name__}",
                "provider_ref": None,
                "balance_after": None,
                "duplicate": False,
            }

        outcome = grant_result.get("outcome")
        provider_ref = grant_result.get("provider_ref") or ""
        err = grant_result.get("error") or ""

        # ── Step 6: Persist outcome ───────────────────────────────────────
        if outcome == "granted":
            bal_after = grant_result.get("balance_after")
            await grant_col.update_one(
                {"tx_id": tx_id},
                {"$set": {
                    "state": "granted",
                    "confirmed_at": _iso(),
                    "provider_ref": provider_ref,
                    "balance_after": bal_after,
                    "last_error": None,
                    "duplicate": bool(grant_result.get("duplicate")),
                }})
            return "granted", "", provider_ref

        if outcome == "grant_terminal_failed":
            await grant_col.update_one(
                {"tx_id": tx_id},
                {"$set": {
                    "state": "grant_terminal_failed",
                    "failed_at": _iso(),
                    "last_error": err,
                }})
            return "grant_terminal_failed", err, ""

        if outcome == "grant_retryable":
            await grant_col.update_one(
                {"tx_id": tx_id},
                {"$set": {
                    "state": "grant_retryable",
                    "last_error": err,
                    "retryable_at": _iso(),
                }})
            return "grant_retryable", err, ""

        # grant_unknown — ambiguous transport; must reconcile.
        await grant_col.update_one(
            {"tx_id": tx_id},
            {"$set": {
                "state": "grant_unknown",
                "last_error": err,
                "unknown_at": _iso(),
            }})
        return "pending", f"grant_unknown:{err}", tx_id


    # ──────────────────── reconciliation worker ───────────────────────── #
    async def _reconcile_one_grant(row: dict) -> str:
        """Attempt to resolve a single stale or ambiguous grant row.

        Uses points_transactions ledger lookup (via idempotency_key) to
        determine whether the credit actually landed without re-calling
        the provider. This is safe and idempotent — no duplicate credit risk.

        Returns one of: "resolved_granted", "resolved_terminal",
        "still_unknown", "skipped", "error".
        """
        tx_id = row.get("tx_id") or ""
        offer_id = row.get("offer_id") or ""
        stored_key = row.get("provider_idempotency_key") or ""
        state = row.get("state") or ""
        recon_attempts = int(row.get("recon_attempts") or 0)
        max_recon = 12  # bounded to prevent infinite reconcile cycles

        if recon_attempts >= max_recon:
            await grant_col.update_one(
                {"tx_id": tx_id},
                {"$set": {
                    "recon_exhausted": True,
                    "recon_exhausted_at": _iso(),
                }})
            return "skipped"

        # Atomic lease — only one reconciler processes this row at a time.
        now_iso = _iso()
        lease_until = (
            _now() + timedelta(seconds=120)).isoformat()
        leased = await grant_col.find_one_and_update(
            {"tx_id": tx_id, "state": state,
             "recon_exhausted": {"$ne": True},
             "recon_lease_until": {"$not": {"$gt": now_iso}}},
            {"$set": {"recon_lease_until": lease_until},
             "$inc": {"recon_attempts": 1}},
        )
        if not leased:
            return "skipped"  # Another reconciler owns it.

        if not stored_key:
            # Cannot reconcile without the idempotency key — terminal via
            # THE shared terminal finalizer (releases caps exactly once).
            await _finalize_terminal_grant(
                offer_id, reason="recon_no_idempotency_key",
                resolved_by="reconciliation")
            return "resolved_terminal"

        # ── Ledger lookup: did the credit actually land? ──────────────────
        txn = await _lookup_grant_by_key(stored_key)
        if txn is not None:
            # Found the credit in points_transactions — authoritative
            # confirmation. Record ledger metadata on the grant row, then
            # run THE shared confirmed-grant finalizer (Blocker A) so the
            # full lifecycle completes idempotently and identically to the
            # direct-dispatch path. No second provider call is made.
            provider_ref = str(txn.get("_id") or "") or stored_key
            bal = txn.get("balance_after")
            await grant_col.update_one(
                {"tx_id": tx_id},
                {"$set": {"balance_after": bal,
                          "recon_resolved_by": "ledger_lookup"}})
            await _finalize_confirmed_grant(
                offer_id, provider_ref=provider_ref,
                provider_idempotency_key=stored_key,
                confirmed_amount=int(row.get("amount") or 0),
                resolved_by="reconciliation")
            _RECON_STATE["resolved"] = int(_RECON_STATE.get("resolved") or 0) + 1
            return "resolved_granted"

        # Not in ledger yet.
        # For grant_retryable (proven pre-send) retry with the same key.
        # Use the shared resolver — _credit_fn_to_call is never borrowed
        # from _dispatch_grant's local scope.
        if state == "grant_retryable" and REAL_GRANT_ENABLED:
            _recon_credit_fn = _resolve_stable_grant_helper()
            if _recon_credit_fn is None:
                # Provider not available — release lease and come back later.
                await grant_col.update_one(
                    {"tx_id": tx_id},
                    {"$set": {"recon_lease_until": _iso()}})
                return "still_unknown"
            clean_id = row.get("clean_id") or ""
            amount = int(row.get("amount") or 0)
            if clean_id and amount > 0:
                try:
                    grant_result = await _recon_credit_fn(
                        clean_id, amount, stored_key,
                    )
                    r_outcome = grant_result.get("outcome")
                    if r_outcome == "granted":
                        provider_ref = (
                            grant_result.get("provider_ref") or stored_key
                        )
                        # Same-key retry confirmed → THE shared finalizer.
                        await grant_col.update_one(
                            {"tx_id": tx_id},
                            {"$set": {"recon_resolved_by": "recon_retry"}})
                        await _finalize_confirmed_grant(
                            offer_id, provider_ref=provider_ref,
                            provider_idempotency_key=stored_key,
                            confirmed_amount=amount,
                            resolved_by="reconciliation")
                        _RECON_STATE["resolved"] = (
                            int(_RECON_STATE.get("resolved") or 0) + 1)
                        return "resolved_granted"
                    if r_outcome == "grant_terminal_failed":
                        # Authoritative permanent failure → THE shared
                        # terminal finalizer (releases caps exactly once).
                        await _finalize_terminal_grant(
                            offer_id,
                            reason=(grant_result.get("error")
                                    or "recon_retry_terminal"),
                            resolved_by="reconciliation")
                        await grant_col.update_one(
                            {"tx_id": tx_id},
                            {"$set": {
                                "recon_resolved_by": "recon_retry_terminal"}})
                        return "resolved_terminal"
                except Exception as exc:  # noqa: BLE001
                    log.warning("reward: recon retry exc tx=%s: %s",
                                tx_id, exc)

        # Release lease so next cycle can try again.
        await grant_col.update_one(
            {"tx_id": tx_id},
            {"$set": {"recon_lease_until": _iso()}})
        return "still_unknown"

    async def _recover_incomplete_finalizations() -> dict[str, int]:
        """Blocker A — production entry point that rediscovers and resumes
        confirmed grants whose downstream lifecycle work is incomplete.

        A grant row in ``granted`` state means the provider authoritatively
        credited the wallet. The ancillary lifecycle (offer state,
        cap consumption, confirmed event, in-app notification, push
        attempt) is NOT proven complete merely because the grant row is
        granted. This scan finds those rows and routes them through THE
        SAME shared idempotent ``_finalize_confirmed_grant`` so each
        missing step is resumed exactly once. The provider is NEVER
        called. Safe to call repeatedly — every step is idempotent.

        Correction A4 — recovery completeness. Marker booleans on the
        offer document are OPTIMISTIC: they may have been set before
        the corresponding durable record was insertion-proven. To
        prevent a stuck lifecycle, this scanner determines
        completeness from DURABLE evidence:

          * confirmed grant row in ``granted`` state;
          * offer row in ``granted`` / ``confirmed`` state;
          * NO cap reservation still ``held`` for the offer;
          * a confirmed audit event durably present under the stable
            ``event_key`` (not just the ``confirmed_event_emitted``
            marker);
          * a confirmed in-app notification durably present under the
            stable ``notif_key`` (not just the
            ``notif_confirmed_sent`` marker);
          * a push attempt durably recorded
            (``delivery.push_state == "attempted"``).

        Any single missing piece keeps the lifecycle discoverable.
        The shared finalizer is idempotent: it re-attempts each
        missing step exactly once. Recovery itself is also harmless to
        re-run.

        Returns a counters dict ``{"scanned": n, "resumed": n}``.
        """
        scanned = 0
        resumed = 0
        try:
            cursor = grant_col.find({"state": "granted"})
            async for row in cursor:
                scanned += 1
                offer_id = row.get("offer_id") or ""
                if not offer_id:
                    continue
                offer = await off_col.find_one({"_id": offer_id})
                if not offer:
                    continue
                # ---- DURABLE-EVIDENCE COMPLETENESS CHECK ---- #
                offer_state = offer.get("state")
                needs_resume = offer_state not in (
                    "granted", "confirmed")
                if not needs_resume:
                    # Cap confirmation never ran.
                    held = await cap_col.find_one(
                        {"offer_id": offer_id, "state": "held"})
                    if held:
                        needs_resume = True
                if not needs_resume:
                    # Confirmed audit event durable existence.
                    event_key = (
                        f"edutalk-coach-reward:{offer_id}:"
                        f"grant_confirmed")
                    ev = await audit_col.find_one(
                        {"event_key": event_key})
                    if not ev:
                        needs_resume = True
                if not needs_resume:
                    # Confirmed notification durable existence.
                    nkey = (
                        f"edutalk-coach-reward:{offer_id}:confirmed")
                    notif = await notif_col.find_one(
                        {"notif_key": nkey})
                    if not notif:
                        needs_resume = True
                    else:
                        # Push attempt lifecycle — pending means
                        # recovery must drive it forward. Finding 2:
                        # ``attempting`` rows are also resumable so
                        # the truthful crash-recovery branch executes
                        # exactly once. ``attempt_unknown`` is
                        # terminal-ambiguous and is NOT retried (the
                        # wallet credit and confirmed notification
                        # are authoritative; only push delivery is
                        # ambiguous).
                        push_state = notif.get("push_state") or (
                            (notif.get("delivery") or {}).get(
                                "push_state"))
                        if push_state in (None, "pending",
                                          "attempting"):
                            needs_resume = True
                if not needs_resume:
                    continue
                try:
                    await _finalize_confirmed_grant(
                        offer_id,
                        provider_ref=row.get("provider_ref") or "",
                        provider_idempotency_key=(
                            row.get("provider_idempotency_key") or ""
                        ),
                        confirmed_amount=int(
                            row.get("confirmed_amount")
                            or offer.get("reward_amount") or 0
                        ),
                        resolved_by="incomplete_finalization_recovery",
                    )
                    resumed += 1
                except Exception as exc:  # noqa: BLE001
                    log.warning(
                        "reward: incomplete-finalization resume failed "
                        "oid=%s: %s", offer_id, exc)
        except Exception as exc:  # noqa: BLE001
            log.warning(
                "reward: incomplete-finalization scan error: %s", exc)
        return {"scanned": scanned, "resumed": resumed}

    async def _recover_pending_cap_releases() -> dict[str, int]:
        """Blocker B — production entry point that rediscovers and finishes
        incomplete cap releases.

        A reservation in ``release_pending`` state means the
        held→release_pending transition succeeded but the subsequent
        bucket decrement and final release_pending→released step did not
        provably complete. The bucket decrement is keyed by the
        reservation_key via ``decrement_log`` so re-applying it is
        provably idempotent: a retry sees the key already logged and does
        not double-decrement.

        Returns a counters dict {"scanned": n, "repaired": n}.
        """
        scanned = 0
        repaired = 0
        try:
            cursor = cap_col.find({"state": "release_pending"})
            async for r in cursor:
                scanned += 1
                rkey = r.get("reservation_key")
                if not rkey:
                    continue
                bkey = r.get("bucket_key") or _bucket_key(
                    r.get("clean_id") or "",
                    r.get("period_kind") or "",
                    r.get("period_key") or "",
                )
                ok = await _apply_bucket_decrement_idempotent(bkey, rkey)
                if not ok:
                    continue
                try:
                    await cap_col.update_one(
                        {"reservation_key": rkey,
                         "state": "release_pending"},
                        {"$set": {
                            "state": "released",
                            "released_at": _iso(),
                        }})
                    repaired += 1
                except Exception as exc:  # noqa: BLE001
                    log.warning(
                        "reward: pending-release final transition "
                        "failed key=%s: %s", rkey, exc)
        except Exception as exc:  # noqa: BLE001
            log.warning(
                "reward: pending-release scan error: %s", exc)
        return {"scanned": scanned, "repaired": repaired}

    async def _apply_bucket_decrement_idempotent(
        bkey: str, rkey: str,
    ) -> bool:
        """Blocker B — idempotent bucket decrement.

        Each successful decrement appends ``reservation_key`` to the
        bucket's ``decrement_log`` so a repeated apply is a no-op:

            find_one_and_update(
                {_id: bkey, decrement_log: {$ne: rkey}},
                {$inc: {active: -1}, $addToSet: {decrement_log: rkey}},
            )

        Returns True if the bucket is provably decremented exactly once
        for this key (either by this call OR a prior call). Returns False
        only on hard database error (fail closed)."""
        try:
            applied = await cap_bucket_col.find_one_and_update(
                {"_id": bkey, "decrement_log": {"$ne": rkey}},
                {"$inc": {"active": -1},
                 "$addToSet": {"decrement_log": rkey}},
            )
            if applied is not None:
                return True
            # Predicate did not match — either the bucket is missing OR
            # this reservation_key is already logged. The latter is the
            # success-after-retry case (idempotent). Distinguish by a
            # cheap read.
            existing = await cap_bucket_col.find_one({"_id": bkey})
            if existing is None:
                return False
            log_arr = existing.get("decrement_log") or []
            return rkey in log_arr
        except Exception as exc:  # noqa: BLE001
            log.debug("reward: bucket decrement idempotent err %s/%s: %s",
                      bkey, rkey, exc)
            return False

    async def _reconcile_grants_worker() -> None:
        """Background worker: resolve grant_unknown and grant_retryable
        claims. Runs every EDUTALK_REWARD_RECONCILE_SECONDS (default 180s).

        Safe to restart — atomic lease prevents two workers processing the
        same claim simultaneously. Bounded retry count prevents infinite loops.
        Does NOT issue new credits — only checks the ledger and retries safe
        pre-send failures.
        """
        reconcile_interval = max(
            60,
            int((os.environ.get("EDUTALK_REWARD_RECONCILE_SECONDS") or "180")),
        )
        stale_after_s = max(
            120,
            int((os.environ.get("EDUTALK_REWARD_STALE_DISPATCH_SECONDS") or "300")),
        )
        _RECON_STATE["running"] = True
        log.info("reward: reconcile worker started, interval=%ds", reconcile_interval)
        while True:
            try:
                await asyncio.sleep(reconcile_interval)
                stale_cutoff = (
                    _now() - timedelta(seconds=stale_after_s)).isoformat()

                resolved = 0
                still_unknown = 0
                errors = 0

                # Resolve grant_unknown and grant_retryable.
                cursor = grant_col.find(
                    {"state": {"$in": ["grant_unknown", "grant_retryable"]},
                     "recon_exhausted": {"$ne": True}},
                )
                async for row in cursor:
                    try:
                        r = await _reconcile_one_grant(row)
                        if r in ("resolved_granted", "resolved_terminal"):
                            resolved += 1
                        elif r == "still_unknown":
                            still_unknown += 1
                    except Exception as exc:  # noqa: BLE001
                        errors += 1
                        log.warning("reward: recon row err tx=%s: %s",
                                    row.get("tx_id"), exc)

                # Promote stale grant_dispatching to grant_unknown.
                stale_cur = grant_col.find(
                    {"state": "grant_dispatching",
                     "dispatching_at": {"$lt": stale_cutoff}},
                )
                async for row in stale_cur:
                    try:
                        await grant_col.update_one(
                            {"tx_id": row["tx_id"],
                             "state": "grant_dispatching"},
                            {"$set": {
                                "state": "grant_unknown",
                                "last_error": "stale_dispatching",
                                "unknown_at": _iso(),
                            }})
                    except Exception as exc:  # noqa: BLE001
                        log.warning("reward: stale dispatch err tx=%s: %s",
                                    row.get("tx_id"), exc)

                # Blocker A — sweep already-confirmed grants whose
                # downstream lifecycle (offer state, cap consumption,
                # confirmed event, notification, push) is incomplete and
                # resume them through the shared idempotent finalizer.
                try:
                    recov = await _recover_incomplete_finalizations()
                    resolved += int(recov.get("resumed") or 0)
                except Exception as exc:  # noqa: BLE001
                    errors += 1
                    log.warning(
                        "reward: incomplete-finalization sweep err: %s", exc)
                # Blocker B — sweep cap reservations stuck in
                # ``release_pending`` and finish the bucket decrement +
                # final release transition idempotently.
                try:
                    rep = await _recover_pending_cap_releases()
                    resolved += int(rep.get("repaired") or 0)
                except Exception as exc:  # noqa: BLE001
                    errors += 1
                    log.warning(
                        "reward: pending-release sweep err: %s", exc)

                _RECON_STATE["last_run"] = _iso()
                _RECON_STATE["errors"] = (
                    int(_RECON_STATE.get("errors") or 0) + errors)
                if resolved or still_unknown or errors:
                    log.info(
                        "reward: recon cycle resolved=%d unknown=%d err=%d",
                        resolved, still_unknown, errors)

            except asyncio.CancelledError:
                _RECON_STATE["running"] = False
                log.info("reward: reconcile worker cancelled")
                break
            except Exception as exc:  # noqa: BLE001
                log.warning("reward: reconcile worker error: %s", exc)

    async def _claim_offer(offer_id: str, clean_id: str,
                           via: str) -> dict[str, Any]:
        now = _now()
        existing = await off_col.find_one({"_id": offer_id})
        if not existing:
            raise HTTPException(status_code=404, detail="Offer not found")
        if existing.get("clean_id") != clean_id:
            raise HTTPException(status_code=403, detail="Offer not yours")
        # Blocker A — production entry-point recovery. A grant row in
        # ``granted`` state means the provider authoritatively credited
        # the wallet, even if the offer row, cap reservations, confirmed
        # event, notification, and push have not yet completed. Funnel
        # the repeated claim through the shared idempotent
        # finalizer to resume any missing step exactly once. The
        # finalizer NEVER calls the provider and NEVER re-credits.
        grant_row = await grant_col.find_one({"offer_id": offer_id})
        if (grant_row or {}).get("state") == "granted":
            merged = await _finalize_confirmed_grant(
                offer_id,
                provider_ref=(grant_row or {}).get("provider_ref") or "",
                provider_idempotency_key=(
                    (grant_row or {}).get("provider_idempotency_key") or ""
                ),
                confirmed_amount=int(
                    (grant_row or {}).get("confirmed_amount")
                    or existing.get("reward_amount") or 0
                ),
                resolved_by="repeated_claim",
            )
            if merged:
                return _safe_claim_result(merged, replayed=True)
        # AUDIT 4.6 — Already-confirmed replay (no grant row OR grant
        # not yet granted): return the original confirmed result. Do
        # NOT create a new claim-start notification.
        if existing.get("state") in ("granted", "confirmed"):
            return _safe_claim_result(existing, replayed=True)
        if existing.get("state") in ("expired", "grant_terminal_failed", "failed_terminal"):
            return _safe_claim_result(existing, replayed=True)
        try:
            exp = datetime.fromisoformat(existing["expires_at"])
        except Exception:
            exp = now
        if existing.get("state") == "claimable" and now >= exp:
            await off_col.update_one(
                {"_id": offer_id, "state": "claimable"},
                {"$set": {"state": "expired", "expired_at": _iso()}})
            await _release_caps_for_offer(offer_id, "expired")
            existing["state"] = "expired"
            # Expired ⇒ no claim-start notification fires (audit 4.6).
            return _safe_claim_result(existing, replayed=True)
        # claimable → claiming swap. ONLY after this atomic transition
        # (or a verified concurrent claiming-state replay) do we record
        # the claim-start notification.
        claimed = await off_col.find_one_and_update(
            {"_id": offer_id, "state": "claimable"},
            {"$set": {"state": "claim_reserved",
                      "claim_started_at": now.isoformat(),
                      "claim_via": via[:20]}})
        if not claimed:
            fresh = await off_col.find_one({"_id": offer_id})
            if fresh and fresh.get("state") in ("granted", "confirmed"):
                return _safe_claim_result(fresh, replayed=True)
            if fresh and fresh.get("state") in (
                    "expired", "grant_terminal_failed", "failed_terminal"):
                return _safe_claim_result(fresh, replayed=True)
            # Still ``claiming`` — this is a legitimate replay path; the
            # claim-start notification was already created by the winning
            # caller, so the unique notif_key gate makes our call here a
            # no-op. Re-run the outbox to surface the latest state.
            grant_state, reason, provider_ref = await _dispatch_grant(
                fresh or existing)
            await _create_claim_start_notification(fresh or existing)
            return _safe_claim_result_after_grant(
                fresh or existing, grant_state, reason, provider_ref,
                replayed=True)
        # We are the winning claim acceptor — create the claim-start
        # notification NOW (after expiry/ownership/state validation).
        await _create_claim_start_notification(claimed)
        grant_state, reason, provider_ref = await _dispatch_grant(claimed)
        result = await _finalize_claim(
            claimed, grant_state, reason, provider_ref)
        try:
            await audit_col.insert_one({
                "kind": "claim_attempt", "ts": _iso(),
                "offer_id": offer_id, "clean_id": clean_id, "via": via,
                "grant_state": grant_state,
                "reason": (reason or "")[:120],
            })
        except Exception:
            pass
        return result

    async def _finalize_confirmed_grant(
        offer_id: str,
        *,
        provider_ref: str = "",
        confirmed_amount: int | None = None,
        provider_idempotency_key: str = "",
        resolved_by: str = "dispatch",
        ctx: "RewardSessionCtx | None" = None,
    ) -> dict[str, Any]:
        """Blocker A — THE single, idempotent, RESUMABLE confirmed-grant
        finalizer. Every authoritative confirmed path funnels through here:
        immediate dispatch success; provider duplicate/already-processed
        confirmation; successful same-key retry reconciliation;
        ledger-confirmed reconciliation; provider-lookup-confirmed
        reconciliation; and restart recovery that discovers authoritative
        confirmation.

        It NEVER calls the provider/wallet — confirmation has already
        happened by the time it runs. It completes each lifecycle step
        exactly once using compare-and-set transitions and stable keys, so
        a re-entry after a partial ancillary failure resumes ONLY the
        missing work and never re-credits, never double-consumes caps,
        never emits a second confirmed event/notification/push. Returns the
        merged confirmed offer document.
        """
        offer = await off_col.find_one({"_id": offer_id})
        if not offer:
            return {}
        now = _now()
        grant = await grant_col.find_one({"offer_id": offer_id})
        tx_id = ((grant or {}).get("tx_id") or offer.get("tx_id")
                 or f"edutalk-coach-reward:{offer_id}:points")
        stored_key = (provider_idempotency_key
                      or (grant or {}).get("provider_idempotency_key") or "")
        ref = provider_ref or (grant or {}).get("provider_ref") or tx_id
        amount = (int(confirmed_amount) if confirmed_amount is not None
                  else int(offer.get("reward_amount") or 0))

        # (1) grant row → granted. Idempotent $set; stable confirmed_at;
        # records provider identity + clears last_error. No provider call.
        if grant is not None:
            g_set = {
                "state": "granted",
                "provider_idempotency_key": (
                    stored_key or grant.get("provider_idempotency_key")),
                "provider_reference": ref,
                "provider_ref": ref,
                "confirmed_amount": amount,
                "attempt_count": int(grant.get("attempts") or 0),
                "finalize_resolved_by": resolved_by,
                "last_error": None,
            }
            if not grant.get("confirmed_at"):
                g_set["confirmed_at"] = _iso()
            await grant_col.update_one({"tx_id": tx_id}, {"$set": g_set})

        # (2)+(3) offer row → granted + persisted claim_result. Stable
        # confirmed timestamp + claim_day/month so a re-entry never shifts.
        summary = ((offer.get("claim_result") or {}).get("reward_summary")
                   or (offer.get("reward_spec") or {}).get("summary")
                   or f"{amount} EduHub Points")
        confirmed_at = offer.get("claim_confirmed_at") or now.isoformat()
        existing_cr = offer.get("claim_result") or {}
        if existing_cr.get("ok"):
            claim_result = existing_cr
        else:
            claim_result = {
                "ok": True,
                "reward_type": offer.get("reward_type"),
                "reward_amount": amount,
                "reward_summary": summary,
                "grant_adapter_version": GRANT_ADAPTER_VERSION,
                "tx_id": offer.get("tx_id") or ref,
                "provider_reference": ref,
                "confirmed_at": confirmed_at,
                "resolved_by": resolved_by,
            }
        o_set = {
            "state": "granted",
            "claim_confirmed_at": confirmed_at,
            "claim_day": offer.get("claim_day") or _today_key(now),
            "claim_month": offer.get("claim_month") or _month_key(now),
            "provider_ref": ref,
            "claim_result": claim_result,
        }
        await off_col.update_one({"_id": offer_id}, {"$set": o_set})

        # (4)+(5) daily AND monthly cap reservations held→confirmed exactly
        # once. ``granted`` consumes capacity; the slot is NEVER released
        # here. Idempotent — a re-entry matches no remaining held rows.
        await cap_col.update_many(
            {"offer_id": offer_id, "state": "held"},
            {"$set": {"state": "confirmed", "confirmed_at": _iso()}})

        merged = {**offer, **o_set}

        # (6) ONE stable confirmed lifecycle/audit event.
        #
        # Correction A1 — crash-resumable ordering. The marker must
        # NEVER lead the durable event: if the marker is set BEFORE the
        # insert, a failed insert leaves a permanent false-positive
        # marker that recovery has no way to repair. Therefore:
        #
        #   1. attempt ``insert_one`` first, keyed by the stable unique
        #      ``event_key = "edutalk-coach-reward:{offer_id}:grant_confirmed"``;
        #   2. ONLY a concrete ``DuplicateKey`` error proves the event
        #      already exists — verify by loading the existing row;
        #   3. arbitrary database failures (non-duplicate) leave the
        #      marker UNSET so the periodic recovery re-attempts;
        #   4. only after durable event existence is proven do we
        #      idempotently set/repair ``confirmed_event_emitted=True``.
        event_key = (
            f"edutalk-coach-reward:{offer_id}:grant_confirmed")
        event_persisted = False
        try:
            await audit_col.insert_one({
                "event_key": event_key,
                "kind": "grant_confirmed", "ts": _iso(),
                "offer_id": offer_id, "tx_id": tx_id,
                "resolved_by": resolved_by, "reward_amount": amount,
            })
            event_persisted = True
        except Exception as exc:  # noqa: BLE001
            if _is_duplicate_key(exc):
                # Verify the existing row is durably present — only
                # then is the event provably "already inserted".
                existing = await audit_col.find_one(
                    {"event_key": event_key, "kind": "grant_confirmed"})
                if existing:
                    event_persisted = True
                else:
                    log.warning(
                        "reward: duplicate-key on audit insert for %s "
                        "but no existing event found; leaving "
                        "marker unset for recovery", event_key)
            else:
                log.warning(
                    "reward: audit insert error for %s (%s); leaving "
                    "marker unset for recovery", event_key, exc)
        if event_persisted:
            # Repair / set marker only after durable event existence is
            # proven. Recovery will detect marker/event disagreement
            # via this same path.
            await off_col.update_one(
                {"_id": offer_id,
                 "confirmed_event_emitted": {"$ne": True}},
                {"$set": {"confirmed_event_emitted": True,
                          "confirmed_event_at": _iso()}})

        # (7) ONE confirmed in-app notification + (9) ONE push attempt —
        # idempotent via the stable notif_key inside the helper.
        await _create_confirmed_notification(merged)

        # (8) confirmed WebSocket event — emitted at most once when a live
        # session ctx is present. A FAILED delivery clears the flag so a
        # later recovery/retry re-emits truthfully (Blocker F honesty).
        if ctx is not None:
            ws_flag = await off_col.find_one_and_update(
                {"_id": offer_id, "confirmed_ws_emitted": {"$ne": True}},
                {"$set": {"confirmed_ws_emitted": True}})
            if ws_flag:
                cfg = await _load_config()
                ok = await ctx.emit_to_client({
                    "type": "reward_claim_confirmed",
                    "offer_id": offer_id,
                    "reward_type": merged.get("reward_type"),
                    "reward_amount": amount,
                    "reward_summary": summary,
                    "confirmed_message": _render_student_confirmed(
                        merged, cfg),
                    "replayed": False,
                })
                if not ok:
                    await off_col.update_one(
                        {"_id": offer_id},
                        {"$set": {"confirmed_ws_emitted": False}})
        return merged

    async def _finalize_terminal_grant(
        offer_id: str,
        *,
        reason: str = "",
        resolved_by: str = "dispatch",
    ) -> dict[str, Any]:
        """Blocker B — THE single idempotent terminal-failure finalizer for
        an authoritative permanent provider failure. Sets BOTH the grant
        row and the offer row terminal, persists the terminal claim result,
        and releases the daily + monthly cap reservations exactly once.
        Recovery then returns terminal failure. It emits NO confirmed
        event, creates NO success notification, attempts NO success push,
        and shows NO success reveal."""
        offer = await off_col.find_one({"_id": offer_id})
        now = _now()
        grant = await grant_col.find_one({"offer_id": offer_id})
        tx_id = ((grant or {}).get("tx_id") or (offer or {}).get("tx_id")
                 or f"edutalk-coach-reward:{offer_id}:points")
        if grant is not None:
            g_set = {
                "state": "grant_terminal_failed",
                "last_error": (reason or grant.get("last_error") or "")[:160],
                "finalize_resolved_by": resolved_by,
            }
            if not grant.get("failed_at"):
                g_set["failed_at"] = _iso()
            await grant_col.update_one({"tx_id": tx_id}, {"$set": g_set})
        if offer is not None:
            existing_cr = offer.get("claim_result") or {}
            claim_result = (existing_cr if existing_cr.get("failed") else {
                "ok": False, "failed": True, "reason": (reason or "")[:120],
            })
            o_set = {
                "state": "grant_terminal_failed",
                "claim_failed_reason": (reason or "")[:120],
                "claim_failed_at": (
                    offer.get("claim_failed_at") or now.isoformat()),
                "claim_result": claim_result,
            }
            await off_col.update_one({"_id": offer_id}, {"$set": o_set})
        # Release held caps exactly once (decrements the period buckets).
        await _release_caps_for_offer(offer_id, "grant_terminal_failed")
        if offer is not None:
            return {**offer, "state": "grant_terminal_failed"}
        return {}

    async def _finalize_claim(
        claimed: dict, grant_state: str, reason: str, provider_ref: str,
    ) -> dict[str, Any]:
        offer_id = claimed["_id"]
        now = _now()
        if grant_state == "granted":
            # Route through THE shared confirmed-grant finalizer (Blocker A)
            # so direct dispatch success completes the identical idempotent
            # lifecycle as every reconciliation/recovery confirmed path.
            merged = await _finalize_confirmed_grant(
                offer_id, provider_ref=provider_ref, resolved_by="dispatch")
            return _safe_claim_result(merged or claimed, replayed=False)
        if grant_state in ("pending", "grant_retryable", "grant_unknown"):
            update = {
                "state": "pending_confirmation",
                "claim_pending_reason": (reason or "")[:120],
                "claim_pending_at": now.isoformat(),
                "claim_result": {
                    "ok": False, "pending": True,
                    "reason": (reason or "")[:120],
                },
            }
            await off_col.update_one({"_id": offer_id}, {"$set": update})
            return _safe_claim_result(
                {**claimed, **update}, replayed=False, pending_only=True)
        # grant_terminal_failed → THE shared terminal finalizer (Blocker B).
        merged = await _finalize_terminal_grant(
            offer_id, reason=reason, resolved_by="dispatch")
        return _safe_claim_result(
            merged or {**claimed, "state": "grant_terminal_failed"},
            replayed=False)

    def _safe_claim_result(offer: dict, *, replayed: bool,
                           pending_only: bool = False) -> dict[str, Any]:
        state = offer.get("state") or "claimable"
        if pending_only:
            return {
                "offer_id": offer.get("offer_id"),
                "state": "pending_confirmation",
                "replayed": True,
                "result": {"ok": False, "pending": True},
            }
        result: dict[str, Any] = {
            "offer_id": offer.get("offer_id"),
            "state": state,
            "replayed": bool(replayed),
            "reward_type": offer.get("reward_type"),
            "result": offer.get("claim_result") or {},
        }
        if state in ("granted", "confirmed"):
            result["reward_summary"] = (
                (offer.get("claim_result") or {}).get("reward_summary")
                or (offer.get("reward_spec") or {}).get("summary")
            )
            result["reward_amount"] = int(offer.get("reward_amount") or 0)
        return result

    def _safe_claim_result_after_grant(
        offer: dict, grant_state: str, reason: str, provider_ref: str,
        *, replayed: bool,
    ) -> dict[str, Any]:
        # Lightweight wrapper used by the duplicate-claim replay path.
        merged = dict(offer)
        if grant_state in ("granted", "confirmed"):
            merged["state"] = "granted"
            merged["claim_result"] = (offer.get("claim_result") or {}) or {
                "ok": True,
                "reward_type": offer.get("reward_type"),
                "reward_amount": int(offer.get("reward_amount") or 0),
                "reward_summary": (offer.get("reward_spec") or {}).get(
                    "summary", ""),
                "tx_id": provider_ref,
            }
        elif grant_state == "pending":
            return _safe_claim_result(offer, replayed=replayed,
                                      pending_only=True)
        return _safe_claim_result(merged, replayed=replayed)

    async def _release_caps_for_offer(offer_id: str, reason: str) -> None:
        """Blocker B — crash-safe, idempotent, retryable cap release.

        Old design (broken): held→released in one CAS, then $inc -1 on
        the bucket. A failure between the two steps left the bucket
        permanently over-counted (leaked capacity) because a retry found
        the reservation already released and skipped the decrement.

        New design (3-step, recoverable):
          (1) CAS held → release_pending     (release intent persisted)
          (2) atomic idempotent bucket decrement, keyed by
              ``reservation_key`` via ``decrement_log`` — a retry sees
              the key already logged and does not double-decrement.
          (3) CAS release_pending → released (final state)

        If step (2) or (3) fails, the reservation is left in
        ``release_pending``. The reconciliation worker scans for those
        rows and finishes both remaining steps idempotently
        (``_recover_pending_cap_releases``). ``already-confirmed`` rows
        are NEVER released; the predicate matches only ``state: held``."""
        try:
            held = [r async for r in cap_col.find(
                {"offer_id": offer_id, "state": "held"})]
        except Exception as exc:  # noqa: BLE001
            log.debug("reward: release_caps read failed for %s: %s",
                      offer_id, exc)
            return
        for r in held:
            rkey = r.get("reservation_key")
            if not rkey:
                continue
            bkey = r.get("bucket_key") or _bucket_key(
                r.get("clean_id") or "", r.get("period_kind") or "",
                r.get("period_key") or "")
            # (1) CAS held → release_pending. Only the first caller for a
            # given held row wins; a concurrent retry simply skips.
            try:
                moved = await cap_col.find_one_and_update(
                    {"reservation_key": rkey, "state": "held"},
                    {"$set": {"state": "release_pending",
                              "released_reason": reason,
                              "release_pending_at": _iso()}})
            except Exception as exc:  # noqa: BLE001
                log.debug("reward: release_caps stage1 failed %s: %s",
                          rkey, exc)
                continue
            if not moved:
                # Another path already moved past held — defer to it.
                continue
            # (2) Idempotent bucket decrement keyed by reservation_key.
            ok = await _apply_bucket_decrement_idempotent(bkey, rkey)
            if not ok:
                # Bucket decrement could not be confirmed — leave the
                # reservation in release_pending so the reconciliation
                # worker can finish it.
                continue
            # (3) Final transition.
            try:
                await cap_col.update_one(
                    {"reservation_key": rkey,
                     "state": "release_pending"},
                    {"$set": {
                        "state": "released",
                        "released_at": _iso(),
                    }})
            except Exception as exc:  # noqa: BLE001
                log.debug("reward: release_caps stage3 failed %s: %s",
                          rkey, exc)
                # Reconciliation will catch this row by state.

    # ────────────────────────── notifications ─────────────────────────── #
    async def _create_claim_start_notification(offer: dict) -> bool:
        """Idempotent claim-started notification. Stable key ensures no
        duplicate even under rapid retries. Push fan-out is best-effort
        and never affects the claim outcome."""
        offer_id = offer["offer_id"]
        notif_key = f"edutalk-coach-reward:{offer_id}:claim-started"
        recog = offer.get("recognition_snapshot") or {}
        first = recog.get("student_name") or ""
        title = "Your surprise is being confirmed"
        body = (
            f"{first}, your Live Voice Coach is confirming the reward you "
            f"earned through today's practice."
            if first else
            "Your Live Voice Coach is confirming the reward you earned "
            "through today's practice."
        )
        try:
            await notif_col.insert_one({
                "notif_key": notif_key, "ts": _iso(),
                "clean_id": offer["clean_id"], "offer_id": offer_id,
                "title": title, "body": body,
                "kind": "edutalk_coach_reward_claim_started",
                "read": False,
                "delivery": {"db": True, "push": "pending"},
            })
        except Exception:
            # Duplicate notif_key → idempotent return.
            return False
        await off_col.update_one(
            {"_id": offer_id},
            {"$set": {"notif_claim_started_sent": True}})
        await _push_fanout(offer["clean_id"], title, body, notif_key)
        return True

    async def _create_confirmed_notification(offer: dict) -> bool:
        offer_id = offer["offer_id"]
        if offer.get("state") not in ("granted", "confirmed"):
            return False
        notif_key = f"edutalk-coach-reward:{offer_id}:confirmed"
        recog = offer.get("recognition_snapshot") or {}
        first = recog.get("student_name") or ""
        summary = (
            (offer.get("claim_result") or {}).get("reward_summary")
            or (offer.get("reward_spec") or {}).get("summary")
            or f"{offer.get('reward_amount', 0)} EduHub Points"
        )
        title = "Your practice reward is confirmed"
        if first:
            body = (
                f"{first}, your {summary} are confirmed. Your coach "
                f"recognized how you completed the exercises and "
                f"{recog.get('recognized_practice','kept going')}."
            )
        else:
            body = (
                f"You earned {summary} through strong Live Voice Coach "
                f"practice."
            )
        # Correction A2 — crash-resumable confirmed-notification.
        #
        # The previous broad ``except: return False`` collapsed
        # ``DuplicateKey`` (genuine "already inserted") with arbitrary
        # database errors. That made it impossible for recovery to
        # converge after a crash between insert and marker update
        # (recovery would hit duplicate, return False, and the marker
        # would stay False forever).
        #
        # Correct lifecycle:
        #   1. attempt insert keyed by stable unique ``notif_key``;
        #   2. ONLY ``DuplicateKey`` proves the notification already
        #      exists — verify by loading the existing row;
        #   3. arbitrary database errors propagate UP via a False
        #      return AND leave the marker untouched so recovery
        #      re-attempts later;
        #   4. only after durable notification existence is proven,
        #      idempotently set/repair ``notif_confirmed_sent`` and
        #      attempt push (which itself records a durable
        #      ``delivery.push_state`` lifecycle — see Correction A3).
        notif_persisted = False
        try:
            await notif_col.insert_one({
                "notif_key": notif_key, "ts": _iso(),
                "clean_id": offer["clean_id"], "offer_id": offer_id,
                "title": title, "body": body,
                "kind": "edutalk_coach_reward_confirmed",
                "read": False,
                # Correction A3 — durable push lifecycle persisted as
                # a TOP-LEVEL field so a CAS query can match it without
                # relying on engine-specific dotted-path semantics.
                "push_state": "pending",
                "delivery": {"db": True, "push": "pending",
                             "push_state": "pending"},
            })
            notif_persisted = True
        except Exception as exc:  # noqa: BLE001
            if _is_duplicate_key(exc):
                existing = await notif_col.find_one(
                    {"notif_key": notif_key})
                if existing:
                    notif_persisted = True
                    # Ensure the durable push_state field is present
                    # on legacy rows so push lifecycle can converge.
                    if existing.get("push_state") is None:
                        await notif_col.update_one(
                            {"notif_key": notif_key},
                            {"$set": {"push_state": "pending",
                                      "delivery.push_state": "pending"}})
                else:
                    log.warning(
                        "reward: duplicate-key on notif insert for %s "
                        "but no existing notification found; leaving "
                        "marker unset for recovery", notif_key)
            else:
                log.warning(
                    "reward: notif insert error for %s (%s); leaving "
                    "marker unset for recovery", notif_key, exc)
                return False
        if not notif_persisted:
            return False
        # Repair / set marker idempotently. Recovery uses this same
        # path to converge marker/notification disagreement.
        await off_col.update_one(
            {"_id": offer_id},
            {"$set": {"notif_confirmed_sent": True}})
        # Push attempt is a separate durable lifecycle (Correction A3).
        await _attempt_push_once(
            offer["clean_id"], title, body, notif_key)
        return True

    async def _attempt_push_once(clean_id: str, title: str, body: str,
                                  notif_key: str) -> bool:
        """Correction A3 — durable, exactly-once push attempt lifecycle.

        The previous design relied on the ``notif_confirmed_sent``
        marker as an implicit "push was attempted" signal. That is
        unsound: after a crash between notification insertion and
        marker repair, push was never attempted, but a marker-only
        recovery would never re-attempt push.

        Correct lifecycle, persisted on the notification document
        (``delivery.push_state``):

            pending  → no push attempt has been started
            attempting → an attempt is in flight (durable lease)
            attempted  → an attempt has been completed (success or
                         non-retryable failure recorded). Push
                         delivery failure is NEVER allowed to undo the
                         wallet credit or the confirmed notification —
                         we honestly record the outcome.

        ``_attempt_push_once`` does the following atomically:

          * CAS ``push_state: pending → attempting`` on the durable
            notification row. If the CAS does not match (state is
            already ``attempting`` or ``attempted``), this caller is
            NOT the owner and returns immediately — no duplicate push.
          * Invoke ``_push_fanout`` exactly once. The fan-out helper
            itself records ``delivery.push`` and ``delivery.sent``
            counters on the notification row.
          * Mark ``push_state = "attempted"`` and persist a
            ``attempted_at`` timestamp regardless of the fan-out
            outcome. A failed attempt is durable: it is NOT retried
            automatically, because the wallet credit and in-app
            notification are already authoritative.

        Recovery (Correction A4) discovers ``push_state == "pending"``
        rows and routes them back through this same helper, so a
        crash between notification insertion and the very first push
        attempt converges exactly once. A crash that left the row in
        ``attempting`` is treated as authoritatively attempted (we do
        NOT retry the provider), but the next recovery cycle marks
        it ``attempted`` so the durable lifecycle terminates.
        """
        cas = await notif_col.find_one_and_update(
            {"notif_key": notif_key, "push_state": "pending"},
            {"$set": {"push_state": "attempting",
                      "delivery.push_state": "attempting",
                      "attempt_started_at": _iso()}})
        if not cas:
            # Either another caller owns this attempt right now, or it
            # has already been attempted. In either case this caller
            # does NOT issue another push — the lifecycle is durable.
            row = await notif_col.find_one({"notif_key": notif_key})
            if row and row.get("push_state") == "attempting":
                # Finding 2 — truthful crash recovery. The previous
                # implementation blindly promoted a stale ``attempting``
                # row to ``attempted``. That is dishonest: if the crash
                # happened BEFORE ``_push_fanout`` was invoked, the
                # push never actually executed, and the lifecycle must
                # safely retry. Use durable evidence to decide:
                #
                #   * ``fanout_invoked_at`` absent → crash happened
                #     BEFORE fan-out was even invoked. Safely return
                #     the row to ``pending`` so the bounded recovery
                #     loop attempts push exactly once.
                #   * ``fanout_invoked_at`` present, but no
                #     ``attempt_completed_at`` → crash happened AFTER
                #     fan-out was invoked but before completion was
                #     durably recorded. We cannot truthfully claim
                #     success and we cannot safely retry without risk
                #     of duplicate delivery. Record
                #     ``push_state == "attempt_unknown"`` (ambiguous).
                #     The wallet credit and the confirmed notification
                #     remain authoritative — only push delivery is
                #     ambiguous.
                fanout_at = row.get("fanout_invoked_at")
                completed_at = row.get("attempt_completed_at")
                if not fanout_at:
                    # Pre-fanout crash: safely return to pending so
                    # the bounded recovery loop drives the push once.
                    await notif_col.update_one(
                        {"notif_key": notif_key,
                         "push_state": "attempting"},
                        {"$set": {"push_state": "pending",
                                  "delivery.push_state": "pending",
                                  "attempt_reset_at": _iso(),
                                  "attempt_reset_reason":
                                  "pre_fanout_crash"}})
                elif not completed_at:
                    # Post-fanout, ambiguous outcome — cannot truthfully
                    # claim success and cannot safely retry.
                    await notif_col.update_one(
                        {"notif_key": notif_key,
                         "push_state": "attempting"},
                        {"$set": {
                            "push_state": "attempt_unknown",
                            "delivery.push_state": "attempt_unknown",
                            "attempt_unknown_at": _iso(),
                            "delivery.push":
                            (row.get("delivery") or {}).get(
                                "push") or "ambiguous"}})
                else:
                    # Completion was durably recorded; finalize cleanly.
                    await notif_col.update_one(
                        {"notif_key": notif_key,
                         "push_state": "attempting"},
                        {"$set": {"push_state": "attempted",
                                  "delivery.push_state": "attempted",
                                  "attempted_at": completed_at}})
            return False
        # Record durable evidence that fan-out IS about to be invoked.
        # Crash AFTER this update but BEFORE completion is the
        # "attempt_unknown" branch above.
        await notif_col.update_one(
            {"notif_key": notif_key},
            {"$set": {"fanout_invoked_at": _iso()}})
        try:
            await _push_fanout(clean_id, title, body, notif_key)
        finally:
            await notif_col.update_one(
                {"notif_key": notif_key},
                {"$set": {"push_state": "attempted",
                          "delivery.push_state": "attempted",
                          "attempt_completed_at": _iso(),
                          "attempted_at": _iso()}})
        return True

    async def _push_fanout(clean_id: str, title: str, body: str,
                            notif_key: str) -> None:
        """AUDIT 4.1 — push fan-out reuses BOTH the EXISTING
        ``_fan_out_push`` helper AND the EXISTING ``_build_target_query``
        student-target builder. ``_build_target_query("students",
        [clean_id], None)`` already implements case- and
        whitespace-tolerant matching on the ``studentId`` field — the
        same path every other reward / payment / login push uses.
        Failure to send is recorded on the notification row and never
        affects the reward claim outcome."""
        try:
            import server as _server_module  # type: ignore
            fan_out = getattr(_server_module, "_fan_out_push", None)
            target_builder = getattr(
                _server_module, "_build_target_query", None)
        except Exception:
            fan_out = globals().get("_fan_out_push")
            target_builder = globals().get("_build_target_query")
        if not fan_out:
            await notif_col.update_one(
                {"notif_key": notif_key},
                {"$set": {"delivery.push": "no_fan_out_helper"}})
            return
        # Build the AUTHORITATIVE student-target query. Fallback to a
        # constructed-by-hand equivalent ONLY if the helper is missing
        # (still queries ``studentId``, never ``clean_id``).
        if target_builder:
            try:
                query = target_builder("students", [clean_id], None)
            except Exception as exc:  # noqa: BLE001
                await notif_col.update_one(
                    {"notif_key": notif_key},
                    {"$set": {"delivery.push":
                              f"target_builder_err:{type(exc).__name__}"}})
                return
        else:
            # Same shape as the helper — case + whitespace tolerant.
            _esc = re.escape(clean_id.strip())
            query = {"studentId": {"$regex": rf"^\s*{_esc}\s*$",
                                   "$options": "i"}}
        try:
            sent, failed = await fan_out(query, title, body, "/")
            await notif_col.update_one(
                {"notif_key": notif_key},
                {"$set": {"delivery.push": "ok",
                          "delivery.sent": int(sent),
                          "delivery.failed": int(failed)}})
        except Exception as exc:  # noqa: BLE001
            await notif_col.update_one(
                {"notif_key": notif_key},
                {"$set": {"delivery.push": f"err:{type(exc).__name__}"}})

    # ────────────────────── WS dispatch + finalize ────────────────────── #
    async def handle_ws_claim_command(
        offer_id: str, session: dict, ctx: RewardSessionCtx,
    ) -> None:
        clean_id = session.get("clean_id") or ""
        await ctx.emit_to_client({
            "type": "reward_claim_pending", "offer_id": offer_id,
        })
        try:
            result = await _claim_offer(offer_id, clean_id, via="ws")
        except HTTPException as exc:
            await ctx.emit_to_client({
                "type": "reward_claim_failed", "offer_id": offer_id,
                "reason": exc.detail, "http_status": exc.status_code,
            })
            return
        except Exception as exc:  # noqa: BLE001
            log.warning("reward: ws claim error oid=%s: %s", offer_id, exc)
            await ctx.emit_to_client({
                "type": "reward_claim_failed", "offer_id": offer_id,
                "reason": "internal_error",
            })
            return
        state = result.get("state")
        if state in ("granted", "confirmed"):
            cfg = await _load_config()
            offer = await off_col.find_one({"_id": offer_id})
            confirmed_message = _render_student_confirmed(offer, cfg)
            await ctx.emit_to_client({
                "type": "reward_claim_confirmed",
                "offer_id": offer_id,
                "reward_type": result.get("reward_type"),
                "reward_amount": result.get("reward_amount"),
                "reward_summary": result.get("reward_summary"),
                "confirmed_message": confirmed_message,
                "replayed": bool(result.get("replayed")),
            })
            # Idempotent Gemini post-claim ack — fires once per offer
            # AND is marked delivered ONLY after the inject succeeds
            # (audit 4.7). On callback failure the reservation is cleared
            # so a future safe retry can run.
            if offer:
                guard = await off_col.find_one_and_update(
                    {"_id": offer_id,
                     "claim_announcement_reserved_at": None,
                     "claim_announcement_delivered_at": None},
                    {"$set": {"claim_announcement_reserved_at": _iso()}})
                if guard:
                    recog = offer.get("recognition_snapshot") or {}
                    template = (
                        (offer.get("config_snapshot") or {}).get(
                            "gemini_confirmed_template")
                        or cfg.get("gemini_confirmed_template",
                                   DEFAULT_REWARD_CONFIG[
                                       "gemini_confirmed_template"])
                    )
                    text = _safe_format(template, {
                        "student_name": recog.get("student_name")
                                         or "the student",
                        "lesson_title": recog.get("lesson_title",
                                                  "the lesson"),
                        "successful_exercise_count": str(recog.get(
                            "successful_exercise_count", 0)),
                        "recognized_practice": recog.get(
                            "recognized_practice", ""),
                        "confirmed_reward": result.get(
                            "reward_summary", ""),
                        "reward_summary": result.get("reward_summary", ""),
                        "amount": str(result.get("reward_amount", 0)),
                        "offer_id": offer_id,
                    })
                    delivered = await ctx.inject_gemini_text(text)
                    if delivered:
                        await off_col.update_one(
                            {"_id": offer_id},
                            {"$set": {"claim_announcement_delivered_at":
                                      _iso()}})
                    else:
                        await off_col.update_one(
                            {"_id": offer_id},
                            {"$set": {
                                "claim_announcement_reserved_at": None,
                                "claim_announcement_last_error":
                                    "inject_failed",
                            }})
        elif state == "pending_confirmation":
            await ctx.emit_to_client({
                "type": "reward_claim_pending",
                "offer_id": offer_id, "persistent": True,
            })
        else:
            await ctx.emit_to_client({
                "type": "reward_claim_failed", "offer_id": offer_id,
                "reason": state or "unknown",
            })

    def _render_student_confirmed(offer: dict | None, cfg: dict) -> str:
        if not offer:
            return cfg.get("confirmed_message_template",
                           DEFAULT_REWARD_CONFIG["confirmed_message_template"])
        recog = offer.get("recognition_snapshot") or {}
        first = recog.get("student_name") or ""
        template = (
            (offer.get("config_snapshot") or {}).get(
                "confirmed_message_template")
            or cfg.get("confirmed_message_template",
                       DEFAULT_REWARD_CONFIG["confirmed_message_template"])
        )
        if first:
            return f"{first}, {template}"
        return template

    # ─────────────────────────── REST routes ──────────────────────────── #
    @api.get("/admin/edutalk-live/rewards/config")
    async def admin_get_reward_config(admin=Depends(require_admin)):
        _ = admin
        cfg = await _load_config()
        return {
            "success": True, "config": cfg, "status": _public_status(cfg),
            "schema": {
                "safe_point_values": list(SAFE_POINT_VALUES),
                "supported_exercise_kinds": list(SUPPORTED_EXERCISE_KINDS),
                "allowed_personalization_placeholders": list(
                    _ALLOWED_PLACEHOLDERS),
                "policy_version": POLICY_VERSION,
                "grant_adapter_version": GRANT_ADAPTER_VERSION,
                "voucher_available": False,
                "pass_available": False,
                "achievement_available": False,
            },
        }

    @api.put("/admin/edutalk-live/rewards/config")
    async def admin_put_reward_config(
        payload: dict, admin=Depends(require_admin),
    ):
        body = payload.get("config", payload) if isinstance(payload, dict) else {}
        ok, reason = _validate_config_update(body)
        if not ok:
            raise HTTPException(status_code=400, detail=reason)
        admin_email = str(getattr(admin, "email", "")
                          or getattr(admin, "username", ""))
        cfg = await _save_config(body, admin_email)
        return {"success": True, "config": cfg,
                "status": _public_status(cfg)}

    @api.post("/edutalk/reward-offers/{offer_id}/claim")
    async def student_claim_offer_rest(
        offer_id: str, student=Depends(require_student),
    ):
        clean_id = str(getattr(student, "clean_id", ""))
        result = await _claim_offer(offer_id, clean_id, via="rest")
        return {"success": True, **result}

    @api.get("/edutalk/reward-offers/active")
    async def student_active_offer(
        session_id: str = Query(..., min_length=4, max_length=64),
        student=Depends(require_student),
    ):
        clean_id = str(getattr(student, "clean_id", ""))
        cfg = await _load_config()
        cutoff = _iso()
        # First check for a claimable (not yet claimed) offer.
        doc = await off_col.find_one({
            "clean_id": clean_id, "session_id": session_id,
            "state": "claimable", "expires_at": {"$gte": cutoff},
        })
        # Also surface already-processed offers so the client can restore
        # the confirmed / pending / terminal / expired state on recovery.
        if not doc:
            doc = await off_col.find_one({
                "clean_id": clean_id, "session_id": session_id,
                "state": {"$in": [
                    "granted", "confirmed", "pending_confirmation",
                    # Finding 1 — pre-confirmation lifecycle states
                    # are ALSO surfaced for the exact authenticated
                    # student + session so the bounded poll loop can
                    # observe the in-flight claim and keep going
                    # until the authoritative provider result lands.
                    "claim_reserved", "grant_dispatching",
                    "grant_terminal_failed", "failed_terminal", "expired",
                ]},
            })
        if not doc:
            return {"success": True, "offer": None}
        # Blocker E — enriched, session-bound recovery response. Carries
        # the authoritative persisted fields the client needs to restore
        # offered / pending / granted / terminal / expired states WITHOUT
        # reconstructing amounts from frontend defaults. Provider secrets
        # (idempotency keys, wallet credentials) are NEVER exposed.
        state = doc.get("state")
        # Finding 1 — normalize pre-confirmation lifecycle states to
        # ``pending_confirmation`` for the client. The internal state
        # machine still tracks the granular ``claim_reserved`` /
        # ``grant_dispatching`` values, but the recovery contract
        # exposes a single pollable state to keep the frontend logic
        # simple. The frontend helper also treats the raw values as
        # pollable as a defence-in-depth check.
        client_state = state
        if state in ("claim_reserved", "grant_dispatching"):
            client_state = "pending_confirmation"
        persisted = doc.get("claim_result") or None
        summary = (
            (persisted or {}).get("reward_summary")
            or (doc.get("reward_spec") or {}).get("summary")
            or f"{int(doc.get('reward_amount') or 0)} EduHub Points"
        )
        confirmed_message = None
        if state in ("granted", "confirmed"):
            confirmed_message = _render_student_confirmed(doc, cfg)
        return {"success": True, "offer": {
            "offer_id": doc["offer_id"],
            "claim_id": doc.get("offer_id"),
            "session_id": doc["session_id"],
            "state": client_state,
            "reward_type": doc.get("reward_type"),
            "reward_amount": int(doc.get("reward_amount") or 0),
            "reward_summary": summary,
            "summary": summary,
            "expires_at": doc.get("expires_at"),
            "button_label": cfg.get(
                "button_label", DEFAULT_REWARD_CONFIG["button_label"]),
            "pre_claim_message": _render_student_pre_claim(doc, cfg),
            "confirmed_message": confirmed_message,
            "persisted_claim_result": persisted,
        }}

    @api.get("/edutalk/reward-notifications")
    async def student_reward_notifications(
        student=Depends(require_student), limit: int = 10,
    ):
        clean_id = str(getattr(student, "clean_id", ""))
        limit = max(1, min(int(limit or 10), 50))
        cur = notif_col.find(
            {"clean_id": clean_id}, {"_id": 0},
        ).sort("ts", -1).limit(limit)
        rows = [r async for r in cur]
        return {"success": True, "notifications": rows}

    # ─────────── Finding 4 / Correction 1 — delayed-confirmed announce ─────── #
    async def _announce_confirmed_with_ctx(
            session_id: str, offer_id: str, clean_id: str,
            ctx: "RewardSessionCtx | None") -> dict:
        """Core delayed-confirmed Gemini announcement. The live coordinator
        ``ctx`` is supplied DIRECTLY by the caller — the live WebSocket
        bridge already owns the authenticated student's active Gemini
        context, so no in-process REST→registry lookup is required (and a
        REST request that lands on a different worker can therefore never
        miss the owning bridge).

        Strict guarantees (unchanged):
          * only the AUTHENTICATED student may announce their OWN offer;
          * the exact ``session_id`` on the offer must match the supplied
            session id;
          * the offer state must be ``granted`` or ``confirmed``;
          * the wallet provider is NEVER called;
          * the visual reveal is NEVER duplicated (the client reveal is
            driven solely by the recovered/confirmed offer state — this
            helper only injects Gemini voice text);
          * pending / unknown / terminal / expired never announce;
          * if no live ctx is available the helper returns
            ``delivered=False, reason="no_live_session"`` and leaves the
            reservation untouched so the next live reconnect can deliver
            it. We NEVER fabricate voice delivery.

        Reuses the SAME guarded lifecycle as the claim-time announcement
        (``claim_announcement_reserved_at`` /
        ``claim_announcement_delivered_at``) so it fires at most once per
        offer regardless of how many polls / reconnects discover it.

        Returns ``{"delivered": bool, "reason": str, "already": bool}``.
        """
        offer = await off_col.find_one({"_id": offer_id})
        if not offer:
            return {"delivered": False, "reason": "no_offer",
                    "already": False}
        if str(offer.get("clean_id") or "") != str(clean_id):
            return {"delivered": False, "reason": "wrong_owner",
                    "already": False}
        if str(offer.get("session_id") or "") != str(session_id):
            return {"delivered": False, "reason": "wrong_session",
                    "already": False}
        if offer.get("state") not in ("granted", "confirmed"):
            return {"delivered": False, "reason": "not_granted",
                    "already": False}
        if offer.get("claim_announcement_delivered_at"):
            # Already delivered (either at claim time or by an earlier
            # recovered-announce call). Strictly idempotent.
            return {"delivered": False, "reason": "already_delivered",
                    "already": True}
        if ctx is None:
            return {"delivered": False, "reason": "no_live_session",
                    "already": False, "retryable": True}
        # Correction A — truthful reservation state with owner + lease.
        # A live reservation that has NOT produced durable delivery
        # evidence must report ``in_progress`` (retryable) — NEVER
        # ``already_delivered``. ``already_delivered`` is reserved for a
        # persisted ``claim_announcement_delivered_at`` only. A stale
        # lease (an owner that crashed after reserving) is safely
        # reclaimable so an announcement is never blocked forever.
        lease_seconds = 30
        now = _iso()
        lease_until = _iso(_now() + timedelta(seconds=lease_seconds))
        reserved_at = offer.get("claim_announcement_reserved_at")
        lease_expires = offer.get("claim_announcement_lease_expires_at")
        stale = bool(reserved_at) and (not lease_expires or lease_expires < now)
        if reserved_at and not stale:
            # Another owner holds a live, unexpired reservation and has not
            # yet recorded durable delivery. Truthfully in progress.
            return {"delivered": False, "reason": "in_progress",
                    "already": False, "retryable": True}
        token = secrets.token_hex(16)
        # Atomic acquire / stale-reclaim: CAS on the EXACT reserved_at
        # value we read (None for a fresh acquire, or the stale timestamp
        # for a reclaim) AND on delivery still being absent. A concurrent
        # acquirer that wins first flips reserved_at, so the loser's CAS
        # fails and it reports in_progress (never a duplicate inject).
        guard = await off_col.find_one_and_update(
            {"_id": offer_id,
             "claim_announcement_reserved_at": reserved_at,
             "claim_announcement_delivered_at": None},
            {"$set": {"claim_announcement_reserved_at": now,
                      "claim_announcement_owner": token,
                      "claim_announcement_lease_expires_at": lease_until}})
        if not guard:
            # Lost the race, or delivery just landed between read and CAS —
            # truthfully in progress; the caller retries within its bounded
            # budget. We never fabricate already_delivered here.
            return {"delivered": False, "reason": "in_progress",
                    "already": False, "retryable": True}
        try:
            cfg = await _load_config()
            recog = offer.get("recognition_snapshot") or {}
            template = (
                (offer.get("config_snapshot") or {}).get(
                    "gemini_confirmed_template")
                or cfg.get("gemini_confirmed_template",
                           DEFAULT_REWARD_CONFIG[
                               "gemini_confirmed_template"])
            )
            persisted = offer.get("claim_result") or {}
            text = _safe_format(template, {
                "student_name": recog.get("student_name")
                                 or "the student",
                "lesson_title": recog.get("lesson_title", "the lesson"),
                "successful_exercise_count": str(recog.get(
                    "successful_exercise_count", 0)),
                "recognized_practice": recog.get(
                    "recognized_practice", ""),
                "confirmed_reward": persisted.get(
                    "reward_summary", "")
                or (offer.get("reward_spec") or {}).get("summary", ""),
                "reward_summary": persisted.get(
                    "reward_summary", "")
                or (offer.get("reward_spec") or {}).get("summary", ""),
                "amount": str(offer.get("reward_amount", 0)),
                "offer_id": offer_id,
            })
            delivered = await ctx.inject_gemini_text(text)
        except Exception as exc:  # noqa: BLE001
            log.warning("recovered announce: inject error: %s", exc)
            delivered = False
        if delivered:
            # Persist DURABLE delivery evidence (only if we still own the
            # lease) and clear the lease.
            await off_col.update_one(
                {"_id": offer_id, "claim_announcement_owner": token},
                {"$set": {"claim_announcement_delivered_at": _iso(),
                          "claim_announcement_lease_expires_at": None,
                          "claim_announcement_path":
                          "recovered_via_live_ws"}})
            return {"delivered": True, "reason": "ok", "already": False}
        # Inject failed — release OUR reservation (only if still ours) so a
        # later reconnect / bounded retry can truthfully deliver. This is a
        # retryable negative result, NOT a terminal rejection.
        await off_col.update_one(
            {"_id": offer_id, "claim_announcement_owner": token},
            {"$set": {"claim_announcement_reserved_at": None,
                      "claim_announcement_owner": None,
                      "claim_announcement_lease_expires_at": None,
                      "claim_announcement_last_error": "inject_failed"}})
        return {"delivered": False, "reason": "inject_failed",
                "already": False, "retryable": True}

    async def _announce_confirmed_recovered(
            session_id: str, offer_id: str, clean_id: str) -> dict:
        """Registry-backed compatibility wrapper. Resolves the live ctx
        for ``session_id`` from the in-process registry and delegates to
        the ctx-direct core. Retained for the internal recovery/reconcile
        surface and the focused test suite. The PRIMARY production path is
        the live-WebSocket handler ``handle_ws_announce_confirmed`` which
        passes the bridge-owned ctx directly and therefore does NOT depend
        on cross-worker registry visibility."""
        ctx = get_live_reward_ctx(session_id)
        return await _announce_confirmed_with_ctx(
            session_id, offer_id, clean_id, ctx)

    async def handle_ws_announce_confirmed(
            offer_id: str, claimed_session_id: str,
            session: dict, ctx: "RewardSessionCtx") -> dict:
        """Correction 1 (final) — strict live-WebSocket acknowledgement of
        a delayed-confirmed reward announcement.

        Invoked by the live coach WS bridge when the student's browser, on
        discovering an authoritative ``granted`` offer via bounded polling,
        sends ``{type:"announce_confirmed_reward", offer_id, session_id}``
        over the ALREADY-OPEN authenticated coach connection. Because the
        bridge owns the authenticated student, session and live Gemini
        context, the announcement is delivered through THIS connection's
        ctx directly — there is no REST→in-memory-registry hop that could
        miss the owning worker.

        Verifies:
          * the client-supplied session id matches the connection's exact
            active session id;
          * offer exists, is owned by this student, belongs to this exact
            session, and is granted/confirmed;
          * the announcement has not already been delivered;
          * the wallet/provider is NEVER invoked.

        Always sends a single ``reward_announce_ack`` frame back to the
        client carrying ``delivered`` / ``already_delivered`` so the client
        marks the offer locally completed ONLY on proven delivery, and
        leaves it retryable otherwise. Returns the same dict the ack frame
        is built from."""
        active_session_id = str(getattr(ctx, "session_id", "") or "")
        clean_id = str(session.get("clean_id") or "")
        if str(claimed_session_id or "") != active_session_id:
            res = {"delivered": False, "reason": "wrong_session",
                   "already": False}
        else:
            res = await _announce_confirmed_with_ctx(
                active_session_id, offer_id, clean_id, ctx)
        await ctx.emit_to_client({
            "type": "reward_announce_ack",
            "offer_id": offer_id,
            "delivered": bool(res.get("delivered")),
            "already_delivered": bool(res.get("already")),
            "retryable": bool(res.get("retryable")),
            "reason": res.get("reason"),
        })
        return res

    # ────────────────────── public bridge entrypoints ─────────────────── #
    async def coach_reward_runtime_active() -> bool:
        """Single gate consulted by the live bridge BEFORE any reward
        hook is wired. Returns True only when ALL required conditions hold:
        indexes ready, master + points flags enabled, AND the provider
        grant callable is actually available (provider capability gate)."""
        if not indexes_ready():
            return False
        cfg = await _load_config()
        return bool(
            cfg.get("enabled")
            and cfg.get("points_enabled")
            and _provider_grant_available()
        )

    # Register reconcile worker factory at module level.
    global _RECON_WORKER_FACTORY
    _RECON_WORKER_FACTORY = _reconcile_grants_worker

    @api.get("/admin/edutalk-live/rewards/grants/unresolved")
    async def admin_unresolved_grants(
        limit: int = 50,
        admin=Depends(require_admin),
    ):
        """Admin diagnostic: list unresolved grant outbox rows."""
        _ = admin
        limit = max(1, min(int(limit or 50), 200))
        cur = grant_col.find(
            {"state": {"$in": ["grant_unknown", "grant_retryable",
                                "grant_dispatching"]}},
            {"_id": 0, "tx_id": 1, "offer_id": 1, "clean_id": 1,
             "state": 1, "attempts": 1, "recon_attempts": 1,
             "last_error": 1, "created_at": 1, "recon_exhausted": 1},
        ).sort("created_at", -1).limit(limit)
        rows = [r async for r in cur]
        return {"success": True, "unresolved": rows, "count": len(rows),
                "reconcile_state": _RECON_STATE}

    # Register reconcile worker factory + services dict
    services: dict[str, Any] = {
        "coach_reward_runtime_active": coach_reward_runtime_active,
        "register_exercise": register_exercise,
        "evaluate_exercise": evaluate_exercise,
        "handle_ws_claim_command": handle_ws_claim_command,
        "load_config": _load_config,
        "claim_offer": _claim_offer,
        "RewardSessionCtx": RewardSessionCtx,
        "register_live_reward_ctx": register_live_reward_ctx,
        "unregister_live_reward_ctx": unregister_live_reward_ctx,
        "get_live_reward_ctx": get_live_reward_ctx,
        "announce_confirmed_recovered": _announce_confirmed_recovered,
        "announce_confirmed_with_ctx": _announce_confirmed_with_ctx,
        "handle_ws_announce_confirmed": handle_ws_announce_confirmed,
        "setup_indexes": setup_indexes,
        "reconcile_one_grant": _reconcile_one_grant,
        "reserve_cap_slot": _reserve_cap_slot,
        "release_caps_for_offer": _release_caps_for_offer,
        "finalize_confirmed_grant": _finalize_confirmed_grant,
        "finalize_terminal_grant": _finalize_terminal_grant,
        "dispatch_grant": _dispatch_grant,
        "create_offer_if_eligible": _create_offer_if_eligible,
        "recover_incomplete_finalizations": _recover_incomplete_finalizations,
        "recover_pending_cap_releases": _recover_pending_cap_releases,
        "apply_bucket_decrement_idempotent": _apply_bucket_decrement_idempotent,
        "active_offer_doc": None,
    }
    _set_services(services)
    return services


# --------------------------------------------------------------------------- #
# Registered-services accessor used by the WS bridge                          #
# --------------------------------------------------------------------------- #
REGISTERED_SERVICES: dict[str, Any] | None = None


def _set_services(services: dict[str, Any]) -> None:
    global REGISTERED_SERVICES
    REGISTERED_SERVICES = services


def get_services() -> dict[str, Any] | None:
    return REGISTERED_SERVICES


async def _call_reconcile_one(db: Any, row: dict) -> str:
    """Module-level entry point for tests: invoke _reconcile_one_grant for
    a single grant outbox row.

    The ``db`` parameter is accepted for API symmetry; reconciliation uses
    the collection references captured by register_edutalk_coach_reward_routes()
    and accessed through the registered service. This function must only be
    called after register_edutalk_coach_reward_routes() has been called.

    Returns the same values as _reconcile_one_grant:
      "resolved_granted", "resolved_terminal", "still_unknown",
      "skipped", or "error".
    """
    svc = get_services()
    if svc is None or "reconcile_one_grant" not in svc:
        raise RuntimeError(
            "_call_reconcile_one: register_edutalk_coach_reward_routes() "
            "must be called first to register the reconcile_one_grant service."
        )
    return await svc["reconcile_one_grant"](row)
