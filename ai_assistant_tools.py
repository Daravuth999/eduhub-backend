"""ai_assistant_tools.py — EduHub AI Assistant (Personal English Coach).

Isolated FastAPI module that powers the rebuilt AI Assistant page as a
premium, general-purpose personal English coach driven by Gemini 2.5 Flash.

Strict design rules (audit-friendly):

  * Self-contained. Zero side-effects on import. Registers its routes only
    when ``register_ai_assistant_routes(api, db, require_admin, require_student)``
    is called from server.py during startup.
  * Distinct from EduTalk. The AI Assistant is a general English coach,
    NOT an in-book tutor. Book-specific questions are gently redirected
    back to EduTalk by an opt-in redirect helper.
  * Distinct from Premium AI Reader tools. No tier rules, no block
    caching, no entitlement system. Just chat.
  * GEMINI_API_KEY is read from the backend environment only. The key is
    never sent to the frontend and never logged. If the key is missing,
    the chat endpoint returns a clean error and NO points are deducted.
  * Points are charged ONLY after Gemini returns a valid answer. Failures
    (missing key, provider 5xx, network error, empty completion) leave
    the student wallet untouched.
  * Voice input is handled client-side via Web Speech API. This module
    never receives audio. It only receives text.
  * Admin endpoints reuse the existing ``require_admin`` dependency from
    server.py. Student endpoints reuse the existing ``require_student``.

Endpoints registered on the existing /api APIRouter:

    GET  /api/admin/ai-assistant/config         (admin)
    POST /api/admin/ai-assistant/config         (admin)
    POST /api/admin/ai-assistant/test           (admin, no points deducted)
    GET  /api/ai-assistant/config-public        (student, safe subset)
    POST /api/ai-assistant/chat                 (student, points-aware)

Env vars read (all already used elsewhere in this backend):

    GEMINI_API_KEY            required for the feature; absence = friendly error
    GEMINI_MODEL              default "gemini-2.5-flash"
    GAS_POINTS_LOGIN_URL      existing GAS PointsBackend URL (debit helper)
    SL_TREASURY_ID            existing treasury wallet id (default "stu092")
"""
from __future__ import annotations

import json
import logging
import os
import re
import secrets
import time
from datetime import datetime, timezone
from typing import Any

import httpx
from fastapi import APIRouter, Depends, HTTPException
from pydantic import BaseModel, ConfigDict

log = logging.getLogger("eduhub.ai_assistant")

# --------------------------------------------------------------------------- #
# Env config (read at import; never logged)                                   #
# --------------------------------------------------------------------------- #
GEMINI_API_KEY = os.environ.get("GEMINI_API_KEY", "")
GEMINI_MODEL_DEFAULT = os.environ.get("GEMINI_MODEL", "gemini-2.5-flash")

GAS_POINTS_LOGIN_URL = os.environ.get(
    "GAS_POINTS_LOGIN_URL",
    "https://script.google.com/macros/s/AKfycbzRktKyql2I_FbPESNRpCrFDlse-qNd9_Opv9si-g-j2lcanOUPP49IzcyA59lFqVycdA/exec",
)
TREASURY_ID = (
    os.environ.get("SL_TREASURY_ID")
    or os.environ.get("REACT_APP_LIBRARY_TREASURY_ID")
    or "stu092"
)

CONFIG_DOC_ID = "default"
CONFIG_COLLECTION = "ai_assistant_config"
USAGE_COLLECTION = "ai_assistant_usage"

# Default coach system prompt — kept short on purpose. The model is
# instructed to behave like a friendly, structured English coach.
DEFAULT_SYSTEM_PROMPT = (
    "You are EduHub's personal English coach for Cambodian learners. "
    "You are NOT an in-book tutor. You answer general English questions "
    "about grammar, speaking, writing, vocabulary, pronunciation, IELTS, "
    "and daily English study habits.\n\n"
    "Answer using this structure when useful:\n"
    "1) Direct answer.\n"
    "2) Simple explanation in plain English.\n"
    "3) Two short examples.\n"
    "4) One practice task the student can try right now.\n"
    "5) One short follow-up question to keep them engaged.\n\n"
    "Keep answers warm, concise, and confidence-building. Prefer short "
    "sentences. Use Markdown sparingly: short headings, bold key terms, "
    "and bullet lists for steps. Do not invent EduHub book content."
)

DEFAULT_REDIRECT_MESSAGE = (
    "This sounds related to your book lesson. EduTalk is designed to help "
    "inside books. Please open the book and ask EduTalk there."
)

DEFAULT_CONFIG: dict = {
    "enabled": True,
    "model": GEMINI_MODEL_DEFAULT,
    "cost_points": 5,                      # default cost per successful answer
    "voice_input_enabled": True,
    "khmer_support_enabled": True,
    "system_prompt": DEFAULT_SYSTEM_PROMPT,
    "temperature": 0.6,
    "max_output_tokens": 800,
    "book_redirect_enabled": True,
    "book_redirect_message": DEFAULT_REDIRECT_MESSAGE,
    "modes": [
        "General",
        "Grammar",
        "Speaking",
        "Writing",
        "Vocabulary",
        "Pronunciation",
        "IELTS",
    ],
    "suggestions": [
        "Correct my sentence",
        "Give me a 5-minute speaking exercise",
        "Explain present perfect",
        "Help me improve pronunciation",
        "Give me useful daily conversation vocabulary",
        "Check my writing",
    ],
}


# --------------------------------------------------------------------------- #
# Pydantic payloads                                                           #
# --------------------------------------------------------------------------- #
class AdminConfigUpdate(BaseModel):
    model_config = ConfigDict(extra="ignore")
    enabled: bool | None = None
    model: str | None = None
    cost_points: int | None = None
    voice_input_enabled: bool | None = None
    khmer_support_enabled: bool | None = None
    system_prompt: str | None = None
    temperature: float | None = None
    max_output_tokens: int | None = None
    book_redirect_enabled: bool | None = None
    book_redirect_message: str | None = None
    modes: list[str] | None = None
    suggestions: list[str] | None = None


class AdminTestRequest(BaseModel):
    model_config = ConfigDict(extra="ignore")
    prompt: str
    model: str | None = None
    temperature: float | None = None
    max_output_tokens: int | None = None
    system_prompt: str | None = None


class StudentChatRequest(BaseModel):
    model_config = ConfigDict(extra="ignore")
    message: str
    mode: str | None = "General"
    history: list[dict] | None = None  # [{role: "user"|"assistant", content: str}]
    # Used ONCE to call GAS sendPoints AFTER Gemini succeeds. Never persisted,
    # never echoed back, never sent to Gemini. Mirrors the existing premium AI
    # flow so the wallet system is reused, not rewritten.
    password: str | None = ""


# --------------------------------------------------------------------------- #
# Config helpers                                                              #
# --------------------------------------------------------------------------- #
def _public_config(cfg: dict) -> dict:
    """Return the subset of config that is safe to expose to students."""
    return {
        "enabled": bool(cfg.get("enabled", True)),
        "model": str(cfg.get("model") or GEMINI_MODEL_DEFAULT),
        "cost_points": int(cfg.get("cost_points") or 0),
        "voice_input_enabled": bool(cfg.get("voice_input_enabled", True)),
        "khmer_support_enabled": bool(cfg.get("khmer_support_enabled", True)),
        "book_redirect_enabled": bool(cfg.get("book_redirect_enabled", True)),
        "book_redirect_message": str(
            cfg.get("book_redirect_message") or DEFAULT_REDIRECT_MESSAGE
        ),
        "modes": list(cfg.get("modes") or DEFAULT_CONFIG["modes"]),
        "suggestions": list(cfg.get("suggestions") or DEFAULT_CONFIG["suggestions"]),
        "provider_ready": bool(GEMINI_API_KEY),
    }


def _merge_config(stored: dict | None) -> dict:
    out = json.loads(json.dumps(DEFAULT_CONFIG))
    if not stored or not isinstance(stored, dict):
        return out
    for k, v in stored.items():
        if k.startswith("_"):
            continue
        out[k] = v
    # Defensive type coercion — guard against partial admin edits.
    try:
        out["cost_points"] = max(0, int(out.get("cost_points") or 0))
    except Exception:
        out["cost_points"] = DEFAULT_CONFIG["cost_points"]
    try:
        t = float(out.get("temperature"))
        out["temperature"] = max(0.0, min(2.0, t))
    except Exception:
        out["temperature"] = DEFAULT_CONFIG["temperature"]
    try:
        out["max_output_tokens"] = max(64, min(4096, int(out.get("max_output_tokens") or 0)))
    except Exception:
        out["max_output_tokens"] = DEFAULT_CONFIG["max_output_tokens"]
    return out


async def _load_config(db) -> dict:
    try:
        doc = await db[CONFIG_COLLECTION].find_one({"_id": CONFIG_DOC_ID}, {"_id": 0})
    except Exception as exc:  # noqa: BLE001
        log.warning("ai_assistant: load_config failed: %s", str(exc)[:200])
        doc = None
    return _merge_config(doc)


async def _save_config(db, patch: dict) -> dict:
    current = await _load_config(db)
    for k, v in (patch or {}).items():
        if v is None:
            continue
        current[k] = v
    current = _merge_config(current)
    current["_updated_at"] = datetime.now(timezone.utc).isoformat()
    try:
        await db[CONFIG_COLLECTION].update_one(
            {"_id": CONFIG_DOC_ID},
            {"$set": current},
            upsert=True,
        )
    except Exception as exc:  # noqa: BLE001
        log.warning("ai_assistant: save_config failed: %s", str(exc)[:200])
        raise HTTPException(status_code=500, detail="Failed to save AI Assistant config.")
    return current


# --------------------------------------------------------------------------- #
# Book-specific question heuristic                                            #
# --------------------------------------------------------------------------- #
_BOOK_REDIRECT_PATTERNS = (
    r"\bthis (book|chapter|page|story|lesson|passage|paragraph)\b",
    r"\bthe (book|chapter|page|story|passage)\b",
    r"\bwhat does this (sentence|word|line|paragraph) mean\b",
    r"\bin (the|my) book\b",
    r"\bexercise (\d+|number)\b",
    r"\bquestion (\d+|number)\b",
)


def _looks_like_book_question(text: str) -> bool:
    if not text:
        return False
    low = text.lower()
    for pat in _BOOK_REDIRECT_PATTERNS:
        if re.search(pat, low):
            return True
    return False


# --------------------------------------------------------------------------- #
# Gemini provider (httpx, no SDK)                                             #
# --------------------------------------------------------------------------- #
class GeminiProviderError(Exception):
    """Raised when Gemini fails. Caller MUST NOT deduct points on this."""


def _gemini_endpoint(model: str) -> str:
    safe_model = (model or GEMINI_MODEL_DEFAULT).strip() or GEMINI_MODEL_DEFAULT
    return (
        "https://generativelanguage.googleapis.com/v1beta/models/"
        f"{safe_model}:generateContent"
    )


def _build_contents(history: list[dict] | None, user_message: str) -> list[dict]:
    """Convert a thin chat history to Gemini's `contents` shape."""
    out: list[dict] = []
    if history:
        for turn in history[-12:]:
            role = (turn.get("role") or "").lower()
            text = str(turn.get("content") or "").strip()
            if not text:
                continue
            if role in ("user", "student"):
                out.append({"role": "user", "parts": [{"text": text}]})
            elif role in ("assistant", "bot", "model"):
                out.append({"role": "model", "parts": [{"text": text}]})
    out.append({"role": "user", "parts": [{"text": user_message}]})
    return out


async def _call_gemini(
    *,
    model: str,
    system_prompt: str,
    contents: list[dict],
    temperature: float,
    max_output_tokens: int,
) -> str:
    """POST to Gemini and return the first candidate text.

    Raises GeminiProviderError with a friendly message on any failure.
    Never raises with the raw API key or raw upstream response body to
    the caller — only operator-safe summaries are logged.
    """
    if not GEMINI_API_KEY:
        raise GeminiProviderError(
            "AI Assistant is not configured on the server. "
            "Please ask your teacher to set GEMINI_API_KEY."
        )

    payload = {
        "systemInstruction": {"parts": [{"text": system_prompt}]},
        "contents": contents,
        "generationConfig": {
            "temperature": max(0.0, min(2.0, float(temperature))),
            "maxOutputTokens": max(64, min(4096, int(max_output_tokens))),
        },
    }

    try:
        async with httpx.AsyncClient(timeout=httpx.Timeout(45.0, connect=8.0)) as cli:
            resp = await cli.post(
                _gemini_endpoint(model),
                params={"key": GEMINI_API_KEY},
                json=payload,
                headers={"Content-Type": "application/json"},
            )
    except httpx.HTTPError as exc:
        log.warning("ai_assistant: Gemini network error: %s", type(exc).__name__)
        raise GeminiProviderError(
            "The AI service is temporarily unreachable. Please try again."
        )

    if resp.status_code == 429:
        log.warning("ai_assistant: Gemini rate-limited (429)")
        raise GeminiProviderError(
            "The AI is busy right now. Please try again in a moment."
        )
    if resp.status_code >= 500:
        log.warning("ai_assistant: Gemini upstream %d", resp.status_code)
        raise GeminiProviderError(
            "The AI service is temporarily unavailable. Please try again."
        )
    if resp.status_code == 400:
        log.warning("ai_assistant: Gemini 400 — bad request shape")
        raise GeminiProviderError(
            "Your question could not be processed. Please rephrase and try again."
        )
    if resp.status_code in (401, 403):
        log.warning("ai_assistant: Gemini auth error %d", resp.status_code)
        raise GeminiProviderError(
            "AI Assistant is not configured correctly on the server. "
            "Please ask your teacher to verify the Gemini API key."
        )
    if resp.status_code != 200:
        log.warning("ai_assistant: Gemini unexpected status %d", resp.status_code)
        raise GeminiProviderError("The AI could not respond. Please try again.")

    try:
        data = resp.json()
    except Exception:
        raise GeminiProviderError("The AI returned an unreadable response.")

    candidates = data.get("candidates") or []
    if not candidates:
        # Safety filter triggers usually yield empty candidates with a finish reason.
        log.info("ai_assistant: Gemini returned 0 candidates")
        raise GeminiProviderError(
            "The AI couldn't generate a safe answer for that question. "
            "Please rephrase or ask a different question."
        )

    first = candidates[0] or {}
    parts = ((first.get("content") or {}).get("parts")) or []
    text_chunks = [str(p.get("text") or "") for p in parts if isinstance(p, dict)]
    text = "".join(text_chunks).strip()
    if not text:
        raise GeminiProviderError(
            "The AI returned an empty answer. Please try again."
        )
    return text


# --------------------------------------------------------------------------- #
# Wallet helpers — DELEGATE to the existing premium AI GAS helpers.           #
# We do NOT rewrite the wallet. We import the same helpers Premium AI uses    #
# so a single update path covers both features.                               #
# --------------------------------------------------------------------------- #
async def _wallet_get_balance(student_clean_id: str, password: str) -> tuple[int | None, str]:
    try:
        from premium_ai_tools import _gas_get_balance  # type: ignore
    except Exception as exc:  # noqa: BLE001
        log.warning("ai_assistant: premium_ai_tools.balance import failed: %s", exc)
        return None, "wallet_helper_unavailable"
    return await _gas_get_balance(student_clean_id, password)


async def _wallet_debit(
    student_clean_id: str, password: str, amount: int
) -> tuple[bool, str]:
    try:
        from premium_ai_tools import _gas_debit  # type: ignore
    except Exception as exc:  # noqa: BLE001
        log.warning("ai_assistant: premium_ai_tools.debit import failed: %s", exc)
        return False, "wallet_helper_unavailable"
    return await _gas_debit(
        student_clean_id, password, amount,
        gas_nonce=secrets.token_hex(12),
    )


# --------------------------------------------------------------------------- #
# Audit log (best-effort, never blocks the response)                          #
# --------------------------------------------------------------------------- #
async def _log_usage(db, *, student_id: str, status: str, cost: int, mode: str) -> None:
    try:
        await db[USAGE_COLLECTION].insert_one({
            "student_id": student_id,
            "status": status,
            "cost": int(cost or 0),
            "mode": str(mode or "General")[:32],
            "created_at": datetime.now(timezone.utc).isoformat(),
        })
    except Exception:  # noqa: BLE001
        # Never let logging break the student response.
        pass


# --------------------------------------------------------------------------- #
# Route registration                                                          #
# --------------------------------------------------------------------------- #
def register_ai_assistant_routes(
    api: APIRouter,
    db: Any,
    require_admin: Any,
    require_student: Any,
) -> None:
    """Mount /api/admin/ai-assistant/* and /api/ai-assistant/* on the
    existing FastAPI router. Called once from server.py during startup.

    require_admin / require_student come from server.py — never imported
    here, to avoid circular imports.
    """

    # ── Admin: read config ────────────────────────────────────────────
    @api.get("/admin/ai-assistant/config")
    async def admin_get_ai_assistant_config(_admin=Depends(require_admin)):
        cfg = await _load_config(db)
        # Surface (but never return) the key — only a boolean readiness flag.
        cfg["provider_ready"] = bool(GEMINI_API_KEY)
        cfg["default_model"] = GEMINI_MODEL_DEFAULT
        return {"success": True, "config": cfg}

    # ── Admin: save config ────────────────────────────────────────────
    @api.post("/admin/ai-assistant/config")
    async def admin_save_ai_assistant_config(
        payload: AdminConfigUpdate,
        _admin=Depends(require_admin),
    ):
        patch = payload.model_dump(exclude_none=True)
        # Sanitise lists to plain strings (defensive).
        if "modes" in patch:
            patch["modes"] = [str(m).strip()[:32] for m in (patch["modes"] or []) if str(m).strip()]
        if "suggestions" in patch:
            patch["suggestions"] = [
                str(s).strip()[:140] for s in (patch["suggestions"] or []) if str(s).strip()
            ]
        saved = await _save_config(db, patch)
        saved["provider_ready"] = bool(GEMINI_API_KEY)
        saved["default_model"] = GEMINI_MODEL_DEFAULT
        return {"success": True, "config": saved}

    # ── Admin: test prompt (no points deducted) ───────────────────────
    @api.post("/admin/ai-assistant/test")
    async def admin_test_ai_assistant(
        payload: AdminTestRequest,
        _admin=Depends(require_admin),
    ):
        cfg = await _load_config(db)
        prompt = (payload.prompt or "").strip()
        if not prompt:
            raise HTTPException(status_code=400, detail="prompt is required")

        if not GEMINI_API_KEY:
            return {
                "success": False,
                "reason": "no_api_key",
                "message": (
                    "GEMINI_API_KEY is not configured on the server. "
                    "Set it in Render environment variables, then redeploy."
                ),
            }

        try:
            answer = await _call_gemini(
                model=str(payload.model or cfg.get("model") or GEMINI_MODEL_DEFAULT),
                system_prompt=str(payload.system_prompt or cfg.get("system_prompt") or DEFAULT_SYSTEM_PROMPT),
                contents=[{"role": "user", "parts": [{"text": prompt}]}],
                temperature=float(
                    payload.temperature
                    if payload.temperature is not None
                    else cfg.get("temperature") or 0.6
                ),
                max_output_tokens=int(
                    payload.max_output_tokens
                    if payload.max_output_tokens is not None
                    else cfg.get("max_output_tokens") or 800
                ),
            )
        except GeminiProviderError as exc:
            return {"success": False, "reason": "provider_error", "message": str(exc)}

        return {
            "success": True,
            "model": str(payload.model or cfg.get("model") or GEMINI_MODEL_DEFAULT),
            "answer": answer,
            "note": "Test prompts do not deduct student points.",
        }

    # ── Student: public config (cost + flags, no key) ─────────────────
    @api.get("/ai-assistant/config-public")
    async def public_ai_assistant_config(_student=Depends(require_student)):
        cfg = await _load_config(db)
        return {"success": True, "config": _public_config(cfg)}

    # ── Student: chat ─────────────────────────────────────────────────
    @api.post("/ai-assistant/chat")
    async def student_ai_assistant_chat(
        payload: StudentChatRequest,
        student=Depends(require_student),
    ):
        cfg = await _load_config(db)

        if not cfg.get("enabled", True):
            return {
                "success": False,
                "reason": "disabled",
                "message": "AI Assistant is currently disabled by your teacher.",
            }

        message = (payload.message or "").strip()
        if not message:
            raise HTTPException(status_code=400, detail="message is required")
        if len(message) > 4000:
            message = message[:4000]

        # ── Book redirect guard (kept separate from EduTalk) ─────────
        if cfg.get("book_redirect_enabled", True) and _looks_like_book_question(message):
            redirect_msg = str(
                cfg.get("book_redirect_message") or DEFAULT_REDIRECT_MESSAGE
            )
            await _log_usage(
                db, student_id=str(student.student_id),
                status="redirected", cost=0, mode=str(payload.mode or "General"),
            )
            return {
                "success": True,
                "redirect_to_edutalk": True,
                "reply": redirect_msg,
                "points_deducted": 0,
                "cost_points": int(cfg.get("cost_points") or 0),
            }

        cost = max(0, int(cfg.get("cost_points") or 0))
        clean_id = str(getattr(student, "clean_id", "") or "").strip().lower()
        password = (payload.password or "").strip()

        # ── Pre-flight balance check (only if charging is enabled) ───
        if cost > 0:
            if not password:
                return {
                    "success": False,
                    "reason": "missing_password",
                    "message": (
                        "Please sign in again so your wallet can be checked."
                    ),
                }
            balance, why = await _wallet_get_balance(clean_id, password)
            if balance is None:
                log.info("ai_assistant: balance check failed reason=%s", why or "unknown")
                return {
                    "success": False,
                    "reason": "wallet_unavailable",
                    "message": (
                        "We couldn't read your wallet right now. Please try again."
                    ),
                }
            if balance < cost:
                await _log_usage(
                    db, student_id=str(student.student_id),
                    status="insufficient", cost=0, mode=str(payload.mode or "General"),
                )
                return {
                    "success": False,
                    "reason": "insufficient_points",
                    "message": (
                        f"You need {cost} points to ask the AI Assistant, "
                        f"but you currently have {balance}. "
                        "Top up your wallet to keep chatting."
                    ),
                    "balance": int(balance),
                    "cost_points": cost,
                }

        # ── Compose system prompt with mode + optional khmer support ─
        base_sp = str(cfg.get("system_prompt") or DEFAULT_SYSTEM_PROMPT)
        mode = str(payload.mode or "General").strip() or "General"
        sp_parts = [base_sp]
        if mode and mode.lower() != "general":
            sp_parts.append(f"Focus area for this conversation: {mode}.")
        if cfg.get("khmer_support_enabled", True):
            sp_parts.append(
                "If the student writes Khmer or asks for a Khmer hint, you may "
                "add ONE short Khmer line at the end as a helper. Keep English "
                "the primary language of your answer."
            )
        else:
            sp_parts.append("Reply only in English.")

        sp_parts.append(
            "Do NOT answer questions that are about a specific EduHub book "
            "passage, chapter, page, or exercise. For those, kindly say: "
            f"\"{cfg.get('book_redirect_message') or DEFAULT_REDIRECT_MESSAGE}\""
        )
        system_prompt = "\n\n".join(sp_parts)

        contents = _build_contents(payload.history, message)

        # ── Call Gemini BEFORE any debit ─────────────────────────────
        try:
            answer = await _call_gemini(
                model=str(cfg.get("model") or GEMINI_MODEL_DEFAULT),
                system_prompt=system_prompt,
                contents=contents,
                temperature=float(cfg.get("temperature") or 0.6),
                max_output_tokens=int(cfg.get("max_output_tokens") or 800),
            )
        except GeminiProviderError as exc:
            await _log_usage(
                db, student_id=str(student.student_id),
                status="provider_error", cost=0, mode=mode,
            )
            return {
                "success": False,
                "reason": "provider_error",
                "message": str(exc),
                "points_deducted": 0,
            }

        # ── Debit AFTER successful Gemini call ───────────────────────
        debited = False
        debit_reason = ""
        if cost > 0:
            debited, debit_reason = await _wallet_debit(clean_id, password, cost)
            if not debited:
                # Gemini ran but we could not bill. Return the answer but
                # warn the student so support can reconcile. We do NOT
                # silently swallow this — it's a known operator concern.
                log.warning(
                    "ai_assistant: debit failed AFTER Gemini reason=%s student=%s",
                    debit_reason[:60], clean_id[:40],
                )
                await _log_usage(
                    db, student_id=str(student.student_id),
                    status="debit_failed", cost=0, mode=mode,
                )
                return {
                    "success": True,
                    "reply": answer,
                    "points_deducted": 0,
                    "cost_points": cost,
                    "warning": (
                        "Your answer is ready, but we couldn't charge your "
                        "wallet just now. Please refresh and try once more."
                    ),
                }

        await _log_usage(
            db, student_id=str(student.student_id),
            status="success", cost=cost if debited else 0, mode=mode,
        )

        return {
            "success": True,
            "reply": answer,
            "model": str(cfg.get("model") or GEMINI_MODEL_DEFAULT),
            "points_deducted": cost if debited else 0,
            "cost_points": cost,
        }
