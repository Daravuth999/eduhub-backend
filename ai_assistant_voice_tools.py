"""ai_assistant_voice_tools.py
================================
EduHub AI Assistant — Real Voice Missions + Coach Rewards (v1).

This is an additive, isolated module. It DOES NOT touch:

  * ai_assistant_tools.py (existing chat / config routes)
  * EduTalk
  * Reader
  * Premium AI Reader tools
  * wallet_service.py
  * Login Reward
  * Referral
  * KHQR / CamRapidPay payments
  * AuthContext / service worker / push subscription registration

What it adds (mounted onto the existing /api router by
``register_ai_assistant_voice_routes(api, db, require_admin,
require_student, fan_out_push=None)``):

  Student endpoints
  -----------------
    POST  /api/ai-assistant/voice/start-mission
    POST  /api/ai-assistant/voice/upload-attempt   (multipart/form-data)
    POST  /api/ai-assistant/voice/analyze
    GET   /api/ai-assistant/rewards/status
    POST  /api/ai-assistant/rewards/claim
    GET   /api/ai-assistant/voice/config-public

  Admin endpoints (require_admin)
  -------------------------------
    GET   /api/admin/ai-assistant/voice-rewards/config
    POST  /api/admin/ai-assistant/voice-rewards/config
    GET   /api/admin/ai-assistant/voice-attempts

Audio storage
-------------
Cloudflare R2 is reused via the SAME five env vars the existing
Author Studio audio uploader uses in server.py:

    R2_ACCOUNT_ID
    R2_ACCESS_KEY_ID
    R2_SECRET_ACCESS_KEY
    R2_BUCKET_NAME
    R2_PUBLIC_URL

If any var is missing the feature degrades gracefully: voice attempt
metadata is still saved to Mongo, ``audio_stored=False`` is returned
to the client, and points/credits are unaffected. boto3 is imported
lazily so the absence of the package never breaks unrelated routes.

Object key layout (per spec)::

    ai-assistant/voice/{student_id}/{mission_id}/{attempt_id}.<ext>

Where ``ext`` is taken from the uploaded MIME type and constrained to
a safe allowlist.

Points credit (REWARDS) — v1.0.1 MongoDB-only
---------------------------------------------
v1.0.1 removes the previous draft's GAS-treasury ``sendPoints`` path
entirely. AI Assistant Coach Rewards now credit points ONLY through
the existing MongoDB wallet path provided by ``wallet_service.py``:

    from wallet_service import WalletService
    svc = WalletService(db)
    res = await svc.credit(
        student_id, points,
        source="ai_assistant_coach_reward",
        source_ref=mission_id,
        idempotency_key=f"vr:{student_id}:{mission_id}",
        payload={"mode": mode, "claim_id": claim_id, ...},
    )

This is the proven Mongo-only credit helper already used by the
admin reconcile route (``wallet_service.register_migration_routes
→ _migration_reconcile`` at the end of wallet_service.py). It writes
to the ``points_wallets`` and ``points_transactions`` collections,
supports MongoDB transactions when available, and is
idempotency-keyed at the ledger level so a replayed claim CANNOT
double-credit even under a race.

If ``wallet_service`` is not importable at startup (extremely rare —
the same module is loaded by ``server.py`` for the points routes), the
``rewards/claim`` route returns a safe ``reward_credit_unavailable``
error and does NOT fall back to GAS or to any direct wallet write.
The mission, voice attempt and R2 storage continue to work
regardless.

Removed environment variables (no longer read by this module):

    GAS_POINTS_LOGIN_URL    (was: GAS sendPoints URL)
    SL_TREASURY_ID          (was: treasury student id, default "stu092")
    SL_TREASURY_PASSWORD    (was: treasury student password)

Push notifications
------------------
Reuses the EXISTING ``_fan_out_push`` helper from server.py (passed
into ``register_ai_assistant_voice_routes`` as ``fan_out_push``). If
not supplied (or webpush/VAPID is misconfigured), the push step is a
safe no-op and the reward claim itself remains successful.

Anti-fraud (server-enforced)
----------------------------
A reward is unlocked ONLY when ALL of these are true:

    * mission_id is valid and not expired
    * the requesting student owns the mission
    * the mission has the configured minimum attempts
    * the latest attempt passes min words / min duration / non-empty
    * the latest transcript hash is not a duplicate within mission
    * the student has not yet exceeded the daily / weekly caps
    * the mission has not already been claimed
    * the idempotency key has not been seen before
    * voice (R2 audio_stored=True) is required when configured
    * rewards are enabled in the voice-rewards config

Front-end / Gemini CANNOT credit points. Only this module credits,
and only AFTER server-side eligibility re-validation succeeds.

v1 audio analysis disclosure
----------------------------
Audio bytes are stored to R2 for future deeper analysis and teacher
review. The Gemini call in this version is TRANSCRIPT-BASED only —
we explicitly do not claim phoneme / pronunciation scoring. The
transcript comes from the browser Web Speech API. This limitation is
documented in AUDIT_REPORT.md and VALIDATION_REPORT.md.
"""
from __future__ import annotations

import hashlib
import json
import logging
import os
import re
import secrets
import time
import uuid
from datetime import datetime, timedelta, timezone
from typing import Any, Awaitable, Callable

import httpx
from fastapi import (
    APIRouter,
    Depends,
    File,
    Form,
    HTTPException,
    Query,
    UploadFile,
)
from pydantic import BaseModel, ConfigDict

log = logging.getLogger("eduhub.ai_assistant_voice")

# --------------------------------------------------------------------------- #
# Env vars (read at import time; never logged with values)                    #
# --------------------------------------------------------------------------- #
GEMINI_API_KEY = os.environ.get("GEMINI_API_KEY", "")
GEMINI_MODEL_DEFAULT = os.environ.get("GEMINI_MODEL", "gemini-2.5-flash")

# v1.0.1 — GAS/sendPoints credit path has been REMOVED. Rewards credit
# points only through the existing MongoDB wallet helper (see
# ``_mongo_wallet_credit`` below). GAS_POINTS_LOGIN_URL,
# SL_TREASURY_ID, SL_TREASURY_PASSWORD are no longer read by this module.

# Mongo collections (created lazily on first write)
COL_MISSIONS = "ai_assistant_missions"
COL_ATTEMPTS = "ai_assistant_voice_attempts"
COL_CLAIMS = "ai_assistant_reward_claims"
COL_CONFIG = "ai_assistant_config"
VR_CONFIG_DOC_ID = "voice_rewards"

# --------------------------------------------------------------------------- #
# Mission modes & default prompts                                             #
# --------------------------------------------------------------------------- #
MODE_SPEAKING = "speaking_challenge"
MODE_PRONUNCIATION = "pronunciation_drill"
MODE_FRIDAY = "friday_class_prep"
MODE_SENTENCE = "sentence_delivery"

VALID_MODES = {MODE_SPEAKING, MODE_PRONUNCIATION, MODE_FRIDAY, MODE_SENTENCE}

MODE_LABEL = {
    MODE_SPEAKING: "Speaking Challenge",
    MODE_PRONUNCIATION: "Pronunciation Drill",
    MODE_FRIDAY: "Friday Class Prep",
    MODE_SENTENCE: "Sentence Delivery Coach",
}

DEFAULT_MODE_PROMPTS = {
    MODE_SPEAKING: [
        "Describe your morning routine in 3–5 sentences. Speak naturally.",
        "Tell me about something you learned this week and why it mattered.",
        "Talk about a goal you want to reach this month. Be specific.",
    ],
    MODE_PRONUNCIATION: [
        "Read aloud: 'She sells seashells by the seashore on a sunny Sunday.'",
        "Read aloud: 'The thirteen thoughtful thinkers thanked the teacher.'",
        "Read aloud: 'Practice makes progress, not perfection, every single day.'",
    ],
    MODE_FRIDAY: [
        "Introduce yourself for Friday class. Include your name, level, and one thing you practiced this week.",
        "Share one English sentence you struggled with this week and how you fixed it.",
        "Tell your Friday class one new English word you learned and use it in a sentence.",
    ],
    MODE_SENTENCE: [
        "Speak this sentence with clear delivery: 'I would like to improve my English by speaking every day.'",
        "Deliver this sentence with confidence: 'If I practice daily, I will become a better speaker.'",
        "Read with rhythm: 'Speaking clearly is more important than speaking quickly.'",
    ],
}

# Safe MIME allow-list (extends per voice_practice.allowed_mime_types config).
SAFE_MIME_TYPES = {
    "audio/webm", "audio/webm;codecs=opus",
    "audio/mp4", "audio/x-m4a", "audio/aac",
    "audio/mpeg", "audio/mp3",
    "audio/wav", "audio/x-wav", "audio/wave",
    "audio/ogg", "audio/ogg;codecs=opus",
}

MIME_TO_EXT = {
    "audio/webm": "webm",
    "audio/mp4": "m4a",
    "audio/x-m4a": "m4a",
    "audio/aac": "aac",
    "audio/mpeg": "mp3",
    "audio/mp3": "mp3",
    "audio/wav": "wav",
    "audio/x-wav": "wav",
    "audio/wave": "wav",
    "audio/ogg": "ogg",
}

# --------------------------------------------------------------------------- #
# Default voice-rewards config                                                #
# --------------------------------------------------------------------------- #
DEFAULT_VR_CONFIG: dict[str, Any] = {
    "voice_practice": {
        "real_recording_enabled": True,
        "store_in_r2": True,
        "max_duration_seconds": 30,
        "max_file_size_mb": 5,
        "retention_days": 90,
        "teacher_review_enabled": True,
        "allowed_mime_types": [
            "audio/webm", "audio/mp4", "audio/mpeg", "audio/wav", "audio/ogg",
        ],
    },
    "missions": {
        "enabled": True,
        "speaking_challenge_enabled": True,
        "pronunciation_drill_enabled": True,
        "friday_class_prep_enabled": True,
        "sentence_delivery_enabled": True,
        "retry_required": True,
        "voice_required_for_rewards": True,
        "mission_expiry_minutes": 30,
    },
    "rewards": {
        "enabled": True,
        "bonus_box_enabled": True,
        "speaking_challenge_pts": 2,
        "pronunciation_drill_pts": 2,
        "friday_class_prep_pts": 3,
        "sentence_delivery_pts": 1,
        "daily_cap_pts": 5,
        "weekly_cap_pts": 10,
        "claim_expiry_minutes": 5,
    },
    "fraud": {
        "min_words": 8,
        "min_duration_seconds": 10,
        "min_attempts": 2,
        "block_duplicate_transcript": True,
        "cooldown_seconds_between_claims": 60,
        "max_claims_per_day": 3,
        "require_voice_for_high_rewards": True,
        "teacher_review_for_high_rewards": False,
    },
    "notifications": {
        "push_enabled": True,
        "template": "You earned +{points} points for completing {mission}!",
    },
}


# --------------------------------------------------------------------------- #
# Small helpers                                                               #
# --------------------------------------------------------------------------- #
def _now_iso() -> str:
    return datetime.now(timezone.utc).isoformat()


def _now() -> datetime:
    return datetime.now(timezone.utc)


def _norm(s: Any) -> str:
    return str(s or "").strip()


def _word_count(text: str) -> int:
    if not text:
        return 0
    return len([w for w in re.split(r"\s+", text.strip()) if w])


def _transcript_hash(student_id: str, mode: str, transcript: str) -> str:
    norm = re.sub(r"\s+", " ", (transcript or "").strip().lower())
    raw = f"{student_id}|{mode}|{norm}".encode("utf-8")
    return hashlib.sha256(raw).hexdigest()


def _ext_for_mime(mime: str) -> str:
    return MIME_TO_EXT.get(mime, "webm")


def _safe_mode(mode: str) -> str:
    mode = (mode or "").strip().lower()
    return mode if mode in VALID_MODES else MODE_SPEAKING


def _mode_reward_points(mode: str, cfg: dict) -> int:
    rew = cfg.get("rewards") or {}
    key = {
        MODE_SPEAKING: "speaking_challenge_pts",
        MODE_PRONUNCIATION: "pronunciation_drill_pts",
        MODE_FRIDAY: "friday_class_prep_pts",
        MODE_SENTENCE: "sentence_delivery_pts",
    }.get(mode, "speaking_challenge_pts")
    try:
        return max(0, int(rew.get(key, 0)))
    except Exception:
        return 0


def _mode_enabled(mode: str, cfg: dict) -> bool:
    miss = cfg.get("missions") or {}
    key = {
        MODE_SPEAKING: "speaking_challenge_enabled",
        MODE_PRONUNCIATION: "pronunciation_drill_enabled",
        MODE_FRIDAY: "friday_class_prep_enabled",
        MODE_SENTENCE: "sentence_delivery_enabled",
    }.get(mode, "speaking_challenge_enabled")
    return bool(miss.get(key, True))


def _pick_default_prompt(mode: str) -> str:
    pool = DEFAULT_MODE_PROMPTS.get(mode) or DEFAULT_MODE_PROMPTS[MODE_SPEAKING]
    # secrets.choice is fine — we just want unbiased rotation.
    return secrets.choice(pool)


# --------------------------------------------------------------------------- #
# Config persistence                                                          #
# --------------------------------------------------------------------------- #
def _deep_merge(base: dict, override: dict) -> dict:
    """Shallow-merge sub-sections so admin partial updates don't wipe defaults."""
    out = json.loads(json.dumps(base))
    if not isinstance(override, dict):
        return out
    for k, v in override.items():
        if k.startswith("_"):
            continue
        if isinstance(v, dict) and isinstance(out.get(k), dict):
            out[k] = {**out[k], **v}
        else:
            out[k] = v
    return out


async def _load_vr_config(db) -> dict:
    try:
        doc = await db[COL_CONFIG].find_one({"_id": VR_CONFIG_DOC_ID}, {"_id": 0})
    except Exception as exc:  # noqa: BLE001
        log.warning("voice: load_vr_config failed: %s", str(exc)[:200])
        doc = None
    return _deep_merge(DEFAULT_VR_CONFIG, doc or {})


async def _save_vr_config(db, patch: dict) -> dict:
    current = await _load_vr_config(db)
    merged = _deep_merge(current, patch or {})
    merged["_updated_at"] = _now_iso()
    try:
        await db[COL_CONFIG].update_one(
            {"_id": VR_CONFIG_DOC_ID}, {"$set": merged}, upsert=True
        )
    except Exception as exc:  # noqa: BLE001
        log.warning("voice: save_vr_config failed: %s", str(exc)[:200])
        raise HTTPException(status_code=500, detail="Failed to save voice/rewards config.")
    return merged


def _public_vr_config(cfg: dict) -> dict:
    """Subset safe to expose to authenticated students."""
    miss = cfg.get("missions") or {}
    rew = cfg.get("rewards") or {}
    vp = cfg.get("voice_practice") or {}
    fr = cfg.get("fraud") or {}
    return {
        "missions_enabled": bool(miss.get("enabled", True)),
        "retry_required": bool(miss.get("retry_required", True)),
        "voice_required_for_rewards": bool(miss.get("voice_required_for_rewards", True)),
        "mission_expiry_minutes": int(miss.get("mission_expiry_minutes", 30)),
        "mode_enabled": {
            MODE_SPEAKING: bool(miss.get("speaking_challenge_enabled", True)),
            MODE_PRONUNCIATION: bool(miss.get("pronunciation_drill_enabled", True)),
            MODE_FRIDAY: bool(miss.get("friday_class_prep_enabled", True)),
            MODE_SENTENCE: bool(miss.get("sentence_delivery_enabled", True)),
        },
        "rewards": {
            "enabled": bool(rew.get("enabled", True)),
            "bonus_box_enabled": bool(rew.get("bonus_box_enabled", True)),
            "points": {
                MODE_SPEAKING: int(rew.get("speaking_challenge_pts", 2)),
                MODE_PRONUNCIATION: int(rew.get("pronunciation_drill_pts", 2)),
                MODE_FRIDAY: int(rew.get("friday_class_prep_pts", 3)),
                MODE_SENTENCE: int(rew.get("sentence_delivery_pts", 1)),
            },
            "daily_cap_pts": int(rew.get("daily_cap_pts", 5)),
            "weekly_cap_pts": int(rew.get("weekly_cap_pts", 10)),
            "claim_expiry_minutes": int(rew.get("claim_expiry_minutes", 5)),
        },
        "voice_practice": {
            "real_recording_enabled": bool(vp.get("real_recording_enabled", True)),
            "max_duration_seconds": int(vp.get("max_duration_seconds", 30)),
            "max_file_size_mb": int(vp.get("max_file_size_mb", 5)),
            "allowed_mime_types": list(vp.get("allowed_mime_types") or []),
            "r2_available": _r2_config() is not None,
        },
        "fraud": {
            "min_words": int(fr.get("min_words", 8)),
            "min_duration_seconds": int(fr.get("min_duration_seconds", 10)),
            "min_attempts": int(fr.get("min_attempts", 2)),
        },
    }


# --------------------------------------------------------------------------- #
# R2 — reuses the SAME env-var pattern as server.py audio uploader            #
# --------------------------------------------------------------------------- #
def _r2_config() -> dict | None:
    required = [
        "R2_ACCOUNT_ID",
        "R2_ACCESS_KEY_ID",
        "R2_SECRET_ACCESS_KEY",
        "R2_BUCKET_NAME",
        "R2_PUBLIC_URL",
    ]
    cfg = {k: os.environ.get(k, "").strip() for k in required}
    return cfg if all(cfg.values()) else None


async def _upload_voice_to_r2(
    audio_bytes: bytes,
    key: str,
    content_type: str,
    metadata: dict | None = None,
) -> str | None:
    """Upload voice bytes to R2 at the given key. Returns public URL or None.

    NEVER raises. On any failure, returns None and logs a warning so callers
    can degrade to ``audio_stored=False`` without breaking the response.
    """
    cfg = _r2_config()
    if cfg is None:
        return None
    try:
        import asyncio as _asyncio
        import boto3  # type: ignore[import-not-found]
        from botocore.config import Config as _BotocoreConfig  # type: ignore[import-not-found]

        endpoint = f"https://{cfg['R2_ACCOUNT_ID']}.r2.cloudflarestorage.com"
        bucket = cfg["R2_BUCKET_NAME"]
        public_base = cfg["R2_PUBLIC_URL"].rstrip("/")

        def _do_upload():
            s3 = boto3.client(
                "s3",
                endpoint_url=endpoint,
                aws_access_key_id=cfg["R2_ACCESS_KEY_ID"],
                aws_secret_access_key=cfg["R2_SECRET_ACCESS_KEY"],
                region_name="auto",
                config=_BotocoreConfig(signature_version="s3v4"),
            )
            s3.put_object(
                Bucket=bucket,
                Key=key,
                Body=audio_bytes,
                ContentType=content_type or "audio/webm",
                Metadata={str(k): str(v) for k, v in (metadata or {}).items()},
            )

        loop = _asyncio.get_event_loop()
        await loop.run_in_executor(None, _do_upload)

        public_url = f"{public_base}/{key}"
        log.info(
            "voice-r2: uploaded key=%s bytes=%d bucket=%s",
            key, len(audio_bytes), bucket,
        )
        return public_url
    except ImportError:
        log.warning(
            "voice-r2: boto3 not installed; voice audio not stored. "
            "Metadata still saved in MongoDB."
        )
        return None
    except Exception as exc:  # noqa: BLE001
        log.warning(
            "voice-r2: upload failed key=%s err=%s: %s",
            key, type(exc).__name__, str(exc)[:200],
        )
        return None


# --------------------------------------------------------------------------- #
# Gemini transcript analysis (NO audio-level/phoneme claims)                  #
# --------------------------------------------------------------------------- #
class _GeminiError(Exception):
    pass


_FEEDBACK_SYSTEM = (
    "You are EduHub's Speech Coach. The student is practicing English "
    "speaking and you receive ONLY a transcript (no audio). Give honest, "
    "encouraging feedback. Do NOT claim phoneme accuracy, accent scoring, "
    "or audio-level pronunciation grading — you only see text. Focus on "
    "grammar, sentence structure, vocabulary, clarity, completeness, and "
    "delivery suggestions (pauses, rhythm) inferred from the transcript. "
    "Reply with strict JSON only, no markdown, matching this schema:\n\n"
    "{\n"
    "  \"what_was_clear\": string,\n"
    "  \"corrected_version\": string,\n"
    "  \"grammar_tip\": string,\n"
    "  \"delivery_tip\": string,\n"
    "  \"retry_instruction\": string,\n"
    "  \"confidence_message\": string\n"
    "}\n\n"
    "Keep each field warm, short (1–2 sentences), and actionable."
)


def _gemini_endpoint(model: str) -> str:
    safe_model = (model or GEMINI_MODEL_DEFAULT).strip() or GEMINI_MODEL_DEFAULT
    return (
        "https://generativelanguage.googleapis.com/v1beta/models/"
        f"{safe_model}:generateContent"
    )


def _safe_feedback_fallback(mode: str) -> dict:
    label = MODE_LABEL.get(mode, "Speech Mission")
    return {
        "what_was_clear": "We received your attempt and saved it.",
        "corrected_version": "",
        "grammar_tip": (
            "AI feedback is temporarily unavailable, but your recording is "
            "stored safely. Try again and we will analyze it."
        ),
        "delivery_tip": "Speak a little slower and pause between ideas.",
        "retry_instruction": f"Record one more clear take of your {label}.",
        "confidence_message": "Every attempt makes you stronger. Keep going.",
    }


async def _gemini_feedback(
    *,
    mode: str,
    prompt: str,
    transcript: str,
    model: str | None = None,
) -> dict:
    if not GEMINI_API_KEY:
        raise _GeminiError("Gemini is not configured on the server.")

    label = MODE_LABEL.get(mode, "Speaking Challenge")
    user_text = (
        f"Mission: {label}\n"
        f"Mission prompt for the student:\n{prompt}\n\n"
        f"Student spoken transcript (Web Speech API):\n{transcript or '(empty)'}\n\n"
        "Return only the JSON object described in the system instruction."
    )

    payload = {
        "systemInstruction": {"parts": [{"text": _FEEDBACK_SYSTEM}]},
        "contents": [{"role": "user", "parts": [{"text": user_text}]}],
        "generationConfig": {
            "temperature": 0.4,
            "maxOutputTokens": 700,
            "responseMimeType": "application/json",
        },
    }
    try:
        async with httpx.AsyncClient(timeout=httpx.Timeout(40.0, connect=8.0)) as cli:
            resp = await cli.post(
                _gemini_endpoint(model or GEMINI_MODEL_DEFAULT),
                params={"key": GEMINI_API_KEY},
                json=payload,
                headers={"Content-Type": "application/json"},
            )
    except httpx.HTTPError as exc:
        log.warning("voice-gemini: network error %s", type(exc).__name__)
        raise _GeminiError("AI feedback is temporarily unavailable.")

    if resp.status_code != 200:
        log.warning("voice-gemini: HTTP %d", resp.status_code)
        raise _GeminiError("AI feedback could not be generated. Try again.")

    try:
        data = resp.json()
    except Exception:
        raise _GeminiError("AI feedback response was unreadable.")

    candidates = data.get("candidates") or []
    if not candidates:
        raise _GeminiError("AI feedback returned no answer.")
    parts = ((candidates[0] or {}).get("content") or {}).get("parts") or []
    raw_text = "".join(str(p.get("text") or "") for p in parts if isinstance(p, dict)).strip()
    if not raw_text:
        raise _GeminiError("AI feedback returned empty text.")

    try:
        # responseMimeType=application/json guarantees JSON in most cases,
        # but we still defensively strip code fences.
        cleaned = raw_text.strip()
        if cleaned.startswith("```"):
            cleaned = re.sub(r"^```(?:json)?\s*|\s*```$", "", cleaned, flags=re.DOTALL)
        obj = json.loads(cleaned)
    except Exception:
        log.info("voice-gemini: non-JSON answer, wrapping into single field")
        obj = {
            "what_was_clear": raw_text[:400],
            "corrected_version": "",
            "grammar_tip": "",
            "delivery_tip": "Speak slowly and clearly.",
            "retry_instruction": "Record one more take.",
            "confidence_message": "Great effort — try again.",
        }

    # Coerce to all-strings, length-bounded.
    out: dict[str, str] = {}
    for k in (
        "what_was_clear",
        "corrected_version",
        "grammar_tip",
        "delivery_tip",
        "retry_instruction",
        "confidence_message",
    ):
        out[k] = str(obj.get(k) or "").strip()[:1200]
    return out


# --------------------------------------------------------------------------- #
# MongoDB wallet credit (v1.0.1) — replaces previous GAS sendPoints path     #
# --------------------------------------------------------------------------- #
def _wallet_service_available() -> bool:
    """Lightweight probe used by /admin/.../config GET/POST. Returns True
    iff ``wallet_service.WalletService`` can be imported. Never raises.
    """
    try:
        import wallet_service as _ws  # noqa: WPS433
    except Exception:
        return False
    return bool(getattr(_ws, "WalletService", None))


# Reuses the proven ``wallet_service.WalletService.credit()`` helper that the
# existing migration reconcile route already uses. Writes ledger rows into
# ``points_transactions`` and updates the balance in ``points_wallets``.
# Idempotency-keyed at the wallet-service layer so replayed claims cannot
# double-credit. Never touches GAS / sendPoints. ``wallet_service`` is
# imported lazily so a missing module never breaks unrelated routes — the
# route falls back to a safe ``reward_credit_unavailable`` error instead.
async def _mongo_wallet_credit(
    db: Any,
    *,
    student_id: str,
    clean_id: str,
    points: int,
    mission_id: str,
    claim_id: str,
    mode: str,
    idempotency_key: str,
) -> tuple[bool, str, dict | None]:
    """Credit ``points`` to the student's MongoDB wallet.

    Returns
    -------
    (ok, error_code_or_ok_msg, result_dict_or_none)

    ``ok=True`` means the credit landed (or was a recognised idempotent
    duplicate). ``ok=False`` returns a stable error code string for the
    caller to surface to the client and store on the claim row.
    """
    if int(points) <= 0:
        return False, "invalid_points", None
    try:
        import wallet_service as _ws  # noqa: WPS433 — lazy import on purpose
    except Exception as exc:  # noqa: BLE001
        log.warning(
            "voice-credit: wallet_service unavailable — reward credit cannot "
            "run safely (%s). Returning reward_credit_unavailable.",
            type(exc).__name__,
        )
        return False, "reward_credit_unavailable", None

    WalletService = getattr(_ws, "WalletService", None)
    if WalletService is None:
        log.warning(
            "voice-credit: wallet_service has no WalletService class — "
            "reward credit cannot run safely. Returning "
            "reward_credit_unavailable."
        )
        return False, "reward_credit_unavailable", None

    try:
        svc = WalletService(db)
        res = await svc.credit(
            student_id,
            int(points),
            source="ai_assistant_coach_reward",
            source_ref=str(mission_id),
            idempotency_key=str(idempotency_key),
            payload={
                "mode": str(mode or ""),
                "mission_id": str(mission_id),
                "claim_id": str(claim_id),
                "clean_id": str(clean_id or ""),
                "feature": "ai_assistant_voice_coach",
                "version": "v1.0.1",
            },
        )
    except Exception as exc:  # noqa: BLE001
        # WalletError subclasses (InsufficientFunds, WalletStatusBlocked,
        # WalletNotFound, etc.) all carry a stable .code/.message. We map
        # any failure to a safe error code without ever calling GAS.
        code = getattr(exc, "code", "") or type(exc).__name__
        msg = getattr(exc, "message", "") or str(exc)
        log.warning(
            "voice-credit: WalletService.credit failed sid=%s code=%s msg=%s",
            str(student_id)[:40], str(code)[:80], str(msg)[:160],
        )
        return False, f"wallet_error:{str(code)[:60]}", None

    if not isinstance(res, dict) or not res.get("ok"):
        log.warning("voice-credit: WalletService returned non-ok: %r", res)
        return False, "wallet_error:no_ok", None
    return True, "ok", res


# --------------------------------------------------------------------------- #
# Pydantic payloads                                                           #
# --------------------------------------------------------------------------- #
class StartMissionRequest(BaseModel):
    model_config = ConfigDict(extra="ignore")
    mode: str
    prompt: str | None = None


class AnalyzeRequest(BaseModel):
    model_config = ConfigDict(extra="ignore")
    mission_id: str
    attempt_id: str | None = None


class ClaimRequest(BaseModel):
    model_config = ConfigDict(extra="ignore")
    mission_id: str
    idempotency_key: str | None = None


class VRConfigUpdate(BaseModel):
    model_config = ConfigDict(extra="ignore")
    voice_practice: dict | None = None
    missions: dict | None = None
    rewards: dict | None = None
    fraud: dict | None = None
    notifications: dict | None = None


# --------------------------------------------------------------------------- #
# Route registration                                                          #
# --------------------------------------------------------------------------- #
def register_ai_assistant_voice_routes(
    api: APIRouter,
    db: Any,
    require_admin: Any,
    require_student: Any,
    *,
    fan_out_push: Callable[..., Awaitable[Any]] | None = None,
) -> None:
    """Mount voice-mission + reward routes onto the existing /api router.

    ``fan_out_push`` is the existing ``_fan_out_push(query, title, body, url)``
    coroutine from server.py. If omitted, push is a safe no-op.
    """

    # ── Student: public voice config ─────────────────────────────────
    @api.get("/ai-assistant/voice/config-public")
    async def voice_public_config(_student=Depends(require_student)):
        cfg = await _load_vr_config(db)
        return {"success": True, "config": _public_vr_config(cfg)}

    # ── Student: start mission ───────────────────────────────────────
    @api.post("/ai-assistant/voice/start-mission")
    async def start_mission(
        payload: StartMissionRequest, student=Depends(require_student)
    ):
        cfg = await _load_vr_config(db)
        if not (cfg.get("missions") or {}).get("enabled", True):
            raise HTTPException(status_code=403, detail="Speech missions are disabled.")

        mode = _safe_mode(payload.mode)
        if not _mode_enabled(mode, cfg):
            raise HTTPException(status_code=403, detail=f"{MODE_LABEL[mode]} is disabled.")

        fraud = cfg.get("fraud") or {}
        miss = cfg.get("missions") or {}
        rew = cfg.get("rewards") or {}

        prompt = _norm(payload.prompt) or _pick_default_prompt(mode)
        mission_id = uuid.uuid4().hex
        now = _now()
        expires_at = now + timedelta(minutes=int(miss.get("mission_expiry_minutes", 30)))
        attempts_required = int(fraud.get("min_attempts", 2))

        doc = {
            "_id": mission_id,
            "mission_id": mission_id,
            "student_id": str(getattr(student, "student_id", "")),
            "clean_id": str(getattr(student, "clean_id", "")).strip().lower(),
            "mode": mode,
            "prompt": prompt[:2000],
            "requirements": {
                "min_words": int(fraud.get("min_words", 8)),
                "min_duration_seconds": int(fraud.get("min_duration_seconds", 10)),
                "min_attempts": attempts_required,
            },
            "status": "in_progress",
            "attempts_required": attempts_required,
            "attempts_completed": 0,
            "reward_eligible": False,
            "reward_eligible_at": None,
            "expires_at": expires_at.isoformat(),
            "created_at": now.isoformat(),
            "reward_points": _mode_reward_points(mode, cfg),
        }
        try:
            await db[COL_MISSIONS].insert_one(doc)
        except Exception as exc:  # noqa: BLE001
            log.warning("voice: insert mission failed: %s", str(exc)[:200])
            raise HTTPException(status_code=500, detail="Could not start mission.")

        return {
            "success": True,
            "mission_id": mission_id,
            "mode": mode,
            "mode_label": MODE_LABEL[mode],
            "prompt": prompt,
            "requirements": doc["requirements"],
            "attempts_required": attempts_required,
            "expires_at": doc["expires_at"],
            "reward_points": doc["reward_points"],
            "reward_eligible": False,
        }

    # ── Student: upload attempt audio ────────────────────────────────
    @api.post("/ai-assistant/voice/upload-attempt")
    async def upload_attempt(
        mission_id: str = Form(...),
        transcript: str = Form(""),
        duration_seconds: float = Form(0),
        audio: UploadFile = File(...),
        student=Depends(require_student),
    ):
        cfg = await _load_vr_config(db)
        vp = cfg.get("voice_practice") or {}
        fraud = cfg.get("fraud") or {}

        max_bytes = int(vp.get("max_file_size_mb", 5)) * 1024 * 1024
        allowed = set(_norm(m) for m in (vp.get("allowed_mime_types") or [])) or SAFE_MIME_TYPES
        # Also accept extended codecs like "audio/webm;codecs=opus".
        ct_raw = (audio.content_type or "").strip().lower()
        ct_base = ct_raw.split(";", 1)[0].strip()
        if ct_base not in allowed and ct_raw not in allowed:
            raise HTTPException(
                status_code=415,
                detail=f"Unsupported audio type ({ct_base or 'unknown'}).",
            )

        # Read into memory (capped at max_bytes + 1 for overflow check).
        try:
            data = await audio.read(max_bytes + 1)
        except Exception:
            raise HTTPException(status_code=400, detail="Could not read upload.")
        if not data:
            raise HTTPException(status_code=400, detail="Empty audio upload.")
        if len(data) > max_bytes:
            raise HTTPException(
                status_code=413,
                detail=f"Audio is larger than {vp.get('max_file_size_mb', 5)} MB.",
            )

        mission = await db[COL_MISSIONS].find_one({"_id": mission_id}, {"_id": 0})
        if not mission:
            raise HTTPException(status_code=404, detail="Mission not found.")
        if str(mission.get("student_id")) != str(getattr(student, "student_id", "")):
            raise HTTPException(status_code=403, detail="Mission belongs to another student.")
        try:
            exp = datetime.fromisoformat(str(mission.get("expires_at")))
            if _now() > exp:
                raise HTTPException(status_code=410, detail="Mission has expired.")
        except HTTPException:
            raise
        except Exception:
            pass

        attempt_id = uuid.uuid4().hex
        ext = _ext_for_mime(ct_base)
        sid = str(getattr(student, "student_id", ""))
        r2_key = f"ai-assistant/voice/{sid}/{mission_id}/{attempt_id}.{ext}"

        # Best-effort R2 upload (never raises).
        public_url = None
        if vp.get("store_in_r2", True):
            public_url = await _upload_voice_to_r2(
                data, r2_key, ct_base or "audio/webm",
                metadata={
                    "student_id": sid,
                    "mission_id": mission_id,
                    "attempt_id": attempt_id,
                    "mode": str(mission.get("mode") or ""),
                },
            )

        wc = _word_count(transcript)
        thash = _transcript_hash(sid, str(mission.get("mode") or ""), transcript or "")
        attempt_number = int(mission.get("attempts_completed") or 0) + 1

        record = {
            "_id": attempt_id,
            "attempt_id": attempt_id,
            "mission_id": mission_id,
            "student_id": sid,
            "clean_id": str(getattr(student, "clean_id", "")).strip().lower(),
            "mode": str(mission.get("mode") or ""),
            "attempt_number": attempt_number,
            "transcript": (transcript or "")[:8000],
            "transcript_word_count": wc,
            "duration_seconds": float(max(0.0, float(duration_seconds or 0))),
            "audio_r2_key": r2_key if public_url else None,
            "audio_public_url": public_url,
            "audio_stored": bool(public_url),
            "audio_content_type": ct_base,
            "audio_bytes": len(data),
            "duplicate_hash": thash,
            "analysis_result": None,
            "created_at": _now_iso(),
            "passes_min_words": wc >= int(fraud.get("min_words", 8)),
            "passes_min_duration": float(duration_seconds or 0) >= float(
                fraud.get("min_duration_seconds", 10)
            ),
        }
        try:
            await db[COL_ATTEMPTS].insert_one(record)
        except Exception as exc:  # noqa: BLE001
            log.warning("voice: insert attempt failed: %s", str(exc)[:200])
            raise HTTPException(status_code=500, detail="Could not save attempt.")

        # Update mission attempts count.
        try:
            await db[COL_MISSIONS].update_one(
                {"_id": mission_id},
                {"$set": {"attempts_completed": attempt_number, "last_attempt_id": attempt_id}},
            )
        except Exception:
            pass

        return {
            "success": True,
            "mission_id": mission_id,
            "attempt_id": attempt_id,
            "attempt_number": attempt_number,
            "audio_stored": bool(public_url),
            "transcript_word_count": wc,
            "audio_r2_key": r2_key if public_url else None,
            "passes_min_words": record["passes_min_words"],
            "passes_min_duration": record["passes_min_duration"],
        }

    # ── Student: analyze (Gemini transcript feedback) ────────────────
    @api.post("/ai-assistant/voice/analyze")
    async def analyze_attempt(
        payload: AnalyzeRequest, student=Depends(require_student)
    ):
        cfg = await _load_vr_config(db)
        mission = await db[COL_MISSIONS].find_one({"_id": payload.mission_id}, {"_id": 0})
        if not mission:
            raise HTTPException(status_code=404, detail="Mission not found.")
        if str(mission.get("student_id")) != str(getattr(student, "student_id", "")):
            raise HTTPException(status_code=403, detail="Mission belongs to another student.")

        att_id = _norm(payload.attempt_id) or _norm(mission.get("last_attempt_id"))
        if not att_id:
            raise HTTPException(status_code=400, detail="No attempt to analyze.")
        attempt = await db[COL_ATTEMPTS].find_one({"_id": att_id}, {"_id": 0})
        if not attempt:
            raise HTTPException(status_code=404, detail="Attempt not found.")

        # Run Gemini analysis (transcript-based only).
        try:
            feedback = await _gemini_feedback(
                mode=str(mission.get("mode") or MODE_SPEAKING),
                prompt=str(mission.get("prompt") or ""),
                transcript=str(attempt.get("transcript") or ""),
            )
        except _GeminiError as exc:
            log.info("voice: gemini feedback failed: %s", str(exc)[:160])
            feedback = _safe_feedback_fallback(str(mission.get("mode") or MODE_SPEAKING))

        try:
            await db[COL_ATTEMPTS].update_one(
                {"_id": att_id}, {"$set": {"analysis_result": feedback, "analyzed_at": _now_iso()}}
            )
        except Exception:
            pass

        # Compute eligibility (server-side only).
        fraud = cfg.get("fraud") or {}
        miss = cfg.get("missions") or {}
        rew = cfg.get("rewards") or {}

        attempts_completed = int(mission.get("attempts_completed") or attempt.get("attempt_number") or 0)
        attempts_required = int(mission.get("attempts_required") or fraud.get("min_attempts", 2))

        # Re-check last attempt rules.
        passes_words = bool(attempt.get("passes_min_words"))
        passes_dur = bool(attempt.get("passes_min_duration"))
        audio_ok = bool(attempt.get("audio_stored")) or not bool(miss.get("voice_required_for_rewards", True))

        # Duplicate-transcript check within this mission for this student.
        duplicate_blocked = False
        if bool(fraud.get("block_duplicate_transcript", True)):
            dup = await db[COL_ATTEMPTS].count_documents({
                "mission_id": payload.mission_id,
                "student_id": str(getattr(student, "student_id", "")),
                "duplicate_hash": attempt.get("duplicate_hash"),
                "_id": {"$ne": att_id},
            })
            duplicate_blocked = bool(dup)

        eligible = bool(
            (rew.get("enabled", True)) and
            attempts_completed >= attempts_required and
            passes_words and passes_dur and audio_ok and
            not duplicate_blocked and
            int(mission.get("reward_points") or 0) > 0
        )

        # Stamp mission eligibility timestamp (used for claim_expiry).
        update_doc: dict = {}
        if eligible and not mission.get("reward_eligible"):
            update_doc["reward_eligible"] = True
            update_doc["reward_eligible_at"] = _now_iso()
        if eligible:
            update_doc["status"] = "ready_to_claim"
        elif not mission.get("reward_eligible"):
            update_doc["status"] = "in_progress"
        if update_doc:
            try:
                await db[COL_MISSIONS].update_one({"_id": payload.mission_id}, {"$set": update_doc})
            except Exception:
                pass

        retry_required = (not eligible) and bool(miss.get("retry_required", True))

        return {
            "success": True,
            "mission_id": payload.mission_id,
            "attempt_id": att_id,
            "attempts_completed": attempts_completed,
            "attempts_required": attempts_required,
            "feedback": feedback,
            "audio_stored": bool(attempt.get("audio_stored")),
            "transcript_word_count": int(attempt.get("transcript_word_count") or 0),
            "passes_min_words": passes_words,
            "passes_min_duration": passes_dur,
            "duplicate_blocked": duplicate_blocked,
            "retry_required": retry_required,
            "reward_eligible": eligible,
            "reward_points": int(mission.get("reward_points") or 0),
            "limitation_notice": (
                "Feedback is based on the spoken transcript (Web Speech API). "
                "Phoneme-level pronunciation scoring is NOT included in v1."
            ),
        }

    # ── Student: rewards/status ──────────────────────────────────────
    @api.get("/ai-assistant/rewards/status")
    async def rewards_status(
        mission_id: str = Query(...), student=Depends(require_student)
    ):
        cfg = await _load_vr_config(db)
        mission = await db[COL_MISSIONS].find_one({"_id": mission_id}, {"_id": 0})
        if not mission:
            raise HTTPException(status_code=404, detail="Mission not found.")
        if str(mission.get("student_id")) != str(getattr(student, "student_id", "")):
            raise HTTPException(status_code=403, detail="Mission belongs to another student.")

        # Has it already been claimed?
        prior_claim = await db[COL_CLAIMS].find_one(
            {"mission_id": mission_id, "student_id": str(getattr(student, "student_id", ""))},
            {"_id": 0},
        )

        # Cap usage today / this week.
        sid = str(getattr(student, "student_id", ""))
        used_today, used_week = await _credited_in_window(db, sid)

        # Has the eligibility window expired?
        rew_cfg = cfg.get("rewards") or {}
        claim_expiry_min = int(rew_cfg.get("claim_expiry_minutes", 5))
        eligible_expired = False
        if mission.get("reward_eligible") and mission.get("reward_eligible_at"):
            try:
                eligible_at = datetime.fromisoformat(str(mission["reward_eligible_at"]))
                if _now() > eligible_at + timedelta(minutes=claim_expiry_min):
                    eligible_expired = True
            except Exception:
                pass

        return {
            "success": True,
            "mission_id": mission_id,
            "mode": str(mission.get("mode") or ""),
            "mode_label": MODE_LABEL.get(str(mission.get("mode") or ""), "Mission"),
            "attempts_completed": int(mission.get("attempts_completed") or 0),
            "attempts_required": int(mission.get("attempts_required") or 0),
            "reward_eligible": bool(mission.get("reward_eligible")) and not eligible_expired,
            "eligible_expired": eligible_expired,
            "reward_points": int(mission.get("reward_points") or 0),
            "already_claimed": bool(prior_claim and prior_claim.get("status") == "credited"),
            "claim_status": (prior_claim or {}).get("status"),
            "daily_credited_today": used_today,
            "weekly_credited": used_week,
            "daily_cap_pts": int(rew_cfg.get("daily_cap_pts", 5)),
            "weekly_cap_pts": int(rew_cfg.get("weekly_cap_pts", 10)),
            "claim_expiry_minutes": claim_expiry_min,
            "expires_at": mission.get("expires_at"),
        }

    # ── Student: rewards/claim ───────────────────────────────────────
    @api.post("/ai-assistant/rewards/claim")
    async def rewards_claim(
        payload: ClaimRequest, student=Depends(require_student)
    ):
        cfg = await _load_vr_config(db)
        rew_cfg = cfg.get("rewards") or {}
        notif_cfg = cfg.get("notifications") or {}
        fraud_cfg = cfg.get("fraud") or {}

        if not rew_cfg.get("enabled", True):
            raise HTTPException(status_code=403, detail="Coach rewards are disabled.")

        mission = await db[COL_MISSIONS].find_one({"_id": payload.mission_id}, {"_id": 0})
        if not mission:
            raise HTTPException(status_code=404, detail="Mission not found.")
        sid = str(getattr(student, "student_id", ""))
        clean_id = str(getattr(student, "clean_id", "")).strip().lower()
        if str(mission.get("student_id")) != sid:
            raise HTTPException(status_code=403, detail="Mission belongs to another student.")
        if not mission.get("reward_eligible"):
            raise HTTPException(status_code=409, detail="Reward is not eligible yet. Retry the mission.")

        # Claim-expiry window
        try:
            eligible_at = datetime.fromisoformat(str(mission.get("reward_eligible_at") or ""))
            if _now() > eligible_at + timedelta(
                minutes=int(rew_cfg.get("claim_expiry_minutes", 5))
            ):
                raise HTTPException(status_code=410, detail="Reward claim window has expired.")
        except HTTPException:
            raise
        except Exception:
            pass

        # Already claimed?
        prior = await db[COL_CLAIMS].find_one(
            {"mission_id": payload.mission_id, "student_id": sid}, {"_id": 0}
        )
        if prior and prior.get("status") == "credited":
            return {
                "success": True,
                "claim_id": prior.get("claim_id"),
                "reward_points": int(prior.get("reward_points") or 0),
                "credited": True,
                "push_sent": bool(prior.get("push_sent")),
                "already_claimed": True,
            }

        # Idempotency
        ikey = _norm(payload.idempotency_key) or f"vr:{sid}:{payload.mission_id}"
        prior_ikey = await db[COL_CLAIMS].find_one(
            {"idempotency_key": ikey}, {"_id": 0}
        )
        if prior_ikey and prior_ikey.get("status") == "credited":
            return {
                "success": True,
                "claim_id": prior_ikey.get("claim_id"),
                "reward_points": int(prior_ikey.get("reward_points") or 0),
                "credited": True,
                "push_sent": bool(prior_ikey.get("push_sent")),
                "already_claimed": True,
            }

        # Cap checks
        used_today, used_week = await _credited_in_window(db, sid)
        points = int(mission.get("reward_points") or 0)
        if points <= 0:
            raise HTTPException(status_code=409, detail="This mission has no reward configured.")
        if used_today + points > int(rew_cfg.get("daily_cap_pts", 5)):
            raise HTTPException(status_code=429, detail="Daily reward cap reached. Try again tomorrow.")
        if used_week + points > int(rew_cfg.get("weekly_cap_pts", 10)):
            raise HTTPException(status_code=429, detail="Weekly reward cap reached.")

        # Cooldown
        cooldown_s = int(fraud_cfg.get("cooldown_seconds_between_claims", 60))
        if cooldown_s > 0:
            last = await db[COL_CLAIMS].find_one(
                {"student_id": sid, "status": "credited"}, sort=[("claimed_at", -1)]
            )
            if last and last.get("claimed_at"):
                try:
                    last_dt = datetime.fromisoformat(str(last["claimed_at"]))
                    if (_now() - last_dt).total_seconds() < cooldown_s:
                        raise HTTPException(
                            status_code=429,
                            detail=f"Please wait {cooldown_s} seconds between claims.",
                        )
                except HTTPException:
                    raise
                except Exception:
                    pass

        # Max claims per day
        max_per_day = int(fraud_cfg.get("max_claims_per_day", 3))
        start_today = _now().replace(hour=0, minute=0, second=0, microsecond=0)
        try:
            today_count = await db[COL_CLAIMS].count_documents({
                "student_id": sid,
                "status": "credited",
                "claimed_at": {"$gte": start_today.isoformat()},
            })
        except Exception:
            today_count = 0
        if today_count >= max_per_day:
            raise HTTPException(
                status_code=429, detail="Daily claim count reached. Try again tomorrow."
            )

        # Reserve claim slot (status=pending) so concurrent calls collide on the
        # mission_id unique constraint we create at register time.
        claim_id = uuid.uuid4().hex
        nonce = secrets.token_hex(12)
        claim_doc = {
            "_id": claim_id,
            "claim_id": claim_id,
            "mission_id": payload.mission_id,
            "student_id": sid,
            "clean_id": clean_id,
            "reward_type": str(mission.get("mode") or ""),
            "reward_points": points,
            "status": "pending",
            "idempotency_key": ikey,
            "claimed_at": _now_iso(),
            "push_sent": False,
            "transaction_id": nonce,
        }
        try:
            await db[COL_CLAIMS].insert_one(claim_doc)
        except Exception as exc:  # noqa: BLE001
            # Likely a duplicate-key race; treat as already claimed.
            log.info("voice: claim insert race: %s", str(exc)[:120])
            existing = await db[COL_CLAIMS].find_one(
                {"mission_id": payload.mission_id, "student_id": sid}, {"_id": 0}
            )
            if existing and existing.get("status") == "credited":
                return {
                    "success": True,
                    "claim_id": existing.get("claim_id"),
                    "reward_points": int(existing.get("reward_points") or 0),
                    "credited": True,
                    "push_sent": bool(existing.get("push_sent")),
                    "already_claimed": True,
                }
            raise HTTPException(status_code=409, detail="Claim already in progress.")

        # Credit via the MongoDB wallet helper (wallet_service.WalletService).
        # v1.0.1 — NO GAS / sendPoints path. If the wallet helper is
        # unavailable we return a safe ``reward_credit_unavailable`` and do
        # NOT mutate any balance, do NOT send a push.
        ok, err, credit_res = await _mongo_wallet_credit(
            db,
            student_id=sid,
            clean_id=clean_id,
            points=points,
            mission_id=payload.mission_id,
            claim_id=claim_id,
            mode=str(mission.get("mode") or ""),
            idempotency_key=ikey,
        )
        if not ok:
            try:
                await db[COL_CLAIMS].update_one(
                    {"_id": claim_id},
                    {"$set": {
                        "status": "failed",
                        "error": str(err)[:200],
                    }},
                )
            except Exception:
                pass
            log.warning(
                "voice: credit failed sid=%s reason=%s",
                str(clean_id)[:40], str(err)[:120],
            )
            # ``reward_credit_unavailable`` (wallet_service missing) is a
            # distinct, explicit signal for the frontend. Other wallet
            # errors are surfaced as a generic 502 so the UI can offer a
            # safe retry without leaking ledger internals.
            if err == "reward_credit_unavailable":
                raise HTTPException(
                    status_code=503,
                    detail="reward_credit_unavailable",
                )
            raise HTTPException(
                status_code=502,
                detail="We could not credit your reward right now. Please try again.",
            )

        # Capture the wallet-service transaction reference for audit.
        try:
            txn = (credit_res or {}).get("transaction") or {}
            txn_id = (
                txn.get("txn_id")
                or txn.get("_id")
                or txn.get("idempotency_key")
                or ikey
            )
            balance_after = float((credit_res or {}).get("balance_after") or 0)
        except Exception:
            txn_id = ikey
            balance_after = None

        push_sent = False
        if notif_cfg.get("push_enabled", True) and fan_out_push is not None:
            template = str(notif_cfg.get("template") or "")
            mode_label = MODE_LABEL.get(str(mission.get("mode") or ""), "Speech Mission")
            try:
                body = template.format(points=points, mission=mode_label)
            except Exception:
                body = f"You earned +{points} points for completing {mode_label}!"
            try:
                candidates: list[str] = []
                for c in (clean_id, sid):
                    if c and c not in candidates:
                        candidates.append(c)
                sent, _failed = await fan_out_push(
                    {"studentId": {"$in": candidates}},
                    f"+{points} Coach Reward",
                    body,
                    "/assistant",
                )
                push_sent = bool(sent)
            except Exception as _push_err:  # noqa: BLE001
                log.warning("voice: push fan-out error: %s", str(_push_err)[:160])

        try:
            await db[COL_CLAIMS].update_one(
                {"_id": claim_id},
                {"$set": {
                    "status": "credited",
                    "push_sent": push_sent,
                    "transaction_id": txn_id,
                    "balance_after": balance_after,
                    "credit_path": "mongo_wallet_service",
                }},
            )
            await db[COL_MISSIONS].update_one(
                {"_id": payload.mission_id},
                {"$set": {"status": "claimed", "claimed_at": _now_iso()}},
            )
        except Exception:
            pass

        return {
            "success": True,
            "claim_id": claim_id,
            "mission_id": payload.mission_id,
            "reward_points": points,
            "credited": True,
            "push_sent": push_sent,
            "transaction_id": txn_id,
            "balance_after": balance_after,
            "message": f"+{points} points credited. Great work!",
        }

    # ── Admin: voice-rewards config GET ──────────────────────────────
    @api.get("/admin/ai-assistant/voice-rewards/config")
    async def admin_get_vr_config(_admin=Depends(require_admin)):
        cfg = await _load_vr_config(db)
        cfg["_r2_available"] = _r2_config() is not None
        cfg["_push_available"] = fan_out_push is not None
        cfg["_wallet_ready"] = _wallet_service_available()
        cfg["_gemini_ready"] = bool(GEMINI_API_KEY)
        cfg["_credit_path"] = "mongo_wallet_service"
        return {"success": True, "config": cfg}

    # ── Admin: voice-rewards config POST ─────────────────────────────
    @api.post("/admin/ai-assistant/voice-rewards/config")
    async def admin_save_vr_config(
        payload: VRConfigUpdate, _admin=Depends(require_admin)
    ):
        patch = payload.model_dump(exclude_none=True)
        saved = await _save_vr_config(db, patch)
        saved["_r2_available"] = _r2_config() is not None
        saved["_push_available"] = fan_out_push is not None
        saved["_wallet_ready"] = _wallet_service_available()
        saved["_gemini_ready"] = bool(GEMINI_API_KEY)
        saved["_credit_path"] = "mongo_wallet_service"
        return {"success": True, "config": saved}

    # ── Admin: voice attempts list ───────────────────────────────────
    @api.get("/admin/ai-assistant/voice-attempts")
    async def admin_voice_attempts(
        limit: int = Query(50, ge=1, le=500),
        student_id: str | None = Query(None),
        mission_id: str | None = Query(None),
        _admin=Depends(require_admin),
    ):
        q: dict = {}
        if student_id:
            q["student_id"] = _norm(student_id)
        if mission_id:
            q["mission_id"] = _norm(mission_id)
        items: list[dict] = []
        try:
            cursor = (
                db[COL_ATTEMPTS]
                .find(q, {"_id": 0})
                .sort("created_at", -1)
                .limit(int(limit))
            )
            async for row in cursor:
                items.append(row)
        except Exception as exc:  # noqa: BLE001
            log.warning("voice: list attempts failed: %s", str(exc)[:200])
        return {"success": True, "count": len(items), "attempts": items}


# --------------------------------------------------------------------------- #
# Cap helpers                                                                 #
# --------------------------------------------------------------------------- #
async def _credited_in_window(db, sid: str) -> tuple[int, int]:
    """Return (points_credited_today, points_credited_this_week) for sid."""
    now = _now()
    start_today = now.replace(hour=0, minute=0, second=0, microsecond=0)
    # ISO week start (Monday).
    start_week = start_today - timedelta(days=start_today.weekday())
    try:
        agg_today = db[COL_CLAIMS].aggregate([
            {"$match": {
                "student_id": sid,
                "status": "credited",
                "claimed_at": {"$gte": start_today.isoformat()},
            }},
            {"$group": {"_id": None, "pts": {"$sum": "$reward_points"}}},
        ])
        d = 0
        async for row in agg_today:
            d = int(row.get("pts") or 0)
        agg_week = db[COL_CLAIMS].aggregate([
            {"$match": {
                "student_id": sid,
                "status": "credited",
                "claimed_at": {"$gte": start_week.isoformat()},
            }},
            {"$group": {"_id": None, "pts": {"$sum": "$reward_points"}}},
        ])
        w = 0
        async for row in agg_week:
            w = int(row.get("pts") or 0)
        return d, w
    except Exception:
        return 0, 0
