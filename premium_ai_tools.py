"""premium_ai_tools.py - EduHub Premium AI Utility System (Phase 1).

Isolated FastAPI module. Zero side-effects on import. Registers its routes
into the existing /api APIRouter via register_premium_ai_routes().

Phase 1 scope (approved):
  - Author Studio admin config (read / write / usage logs)
  - Student tools: Khmer Decoder + Executive Tone Upgrade
  - Secure server-side Gemini call (gemini-2.5-flash)
  - Point deduction via the existing GAS sendPoints route (student -> treasury)
  - Tier-based access enforcement (free / standard / premium / limited)
  - Append-only audit log in MongoDB

Strict safeguards enforced in this module:
  - The student password received in the request body is used ONCE to call
    GAS, then dropped. It is NEVER persisted (no MongoDB, no log line, no
    return value, no Gemini prompt).
  - Gemini is called BEFORE any GAS debit. If Gemini fails, no points are
    deducted.
  - If GAS debit fails AFTER a successful Gemini call, the response is a
    clear 502 - the call is NOT marked as success. This prevents the
    "Gemini ran but we lost the points" silent-failure mode.
  - The authenticated student session (require_student) is the identity
    source; the password is only authorisation for the GAS sendPoints call.

Env vars read (all already used elsewhere in this backend):
  GEMINI_API_KEY            - required; feature disabled when missing
  GEMINI_MODEL              - default "gemini-2.5-flash"
  GAS_POINTS_LOGIN_URL      - existing GAS PointsBackend URL
  SL_TREASURY_ID            - existing treasury wallet id (default "stu092")
"""
from __future__ import annotations

import asyncio
import json
import logging
import os
import re
import secrets
import time
from datetime import datetime, timezone
from typing import Any, Literal

import httpx
from fastapi import APIRouter, Depends, HTTPException
from pydantic import BaseModel, ConfigDict

log = logging.getLogger("eduhub.premium_ai")

# --------------------------------------------------------------------------- #
# Env-driven config (read at import time, like the rest of server.py)         #
# --------------------------------------------------------------------------- #
GEMINI_API_KEY = os.environ.get("GEMINI_API_KEY", "")
GEMINI_MODEL = os.environ.get("GEMINI_MODEL", "gemini-2.5-flash")

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

# Phase 1 implements decode-block + executive-upgrade. ask_book pricing is
# kept in the default config so the admin UI can already display it (greyed
# out / "Phase 2") without an additional migration when it lands.
DEFAULT_CONFIG: dict = {
    "enabled": True,
    "model": GEMINI_MODEL,
    "free_daily_uses": 0,
    "pricing": {
        "ask_book": 3,
        "khmer_decoder": 5,
        "executive_upgrade": 5,
    },
    "tier_rules": {
        "free": {
            "ask_book": "preview",
            "khmer_decoder": False,
            "executive_upgrade": False,
        },
        "standard": {
            "ask_book": True,
            "khmer_decoder": "paid",
            "executive_upgrade": "paid",
        },
        "premium": {
            "ask_book": True,
            "khmer_decoder": True,
            "executive_upgrade": True,
        },
        "limited": {
            "ask_book": True,
            "khmer_decoder": True,
            "executive_upgrade": True,
        },
    },
    "personality": {
        "tone": "professional",
        "system_instruction": (
            "You are EduHub's private English coach for Cambodian learners. "
            "Explain clearly, respectfully, and professionally with awareness "
            "of Khmer grammar habits."
        ),
    },
}

ToolName = Literal["khmer_decoder", "executive_upgrade", "ask_book"]


# --------------------------------------------------------------------------- #
# Pydantic payloads                                                           #
# --------------------------------------------------------------------------- #
class AdminConfigUpdate(BaseModel):
    model_config = ConfigDict(extra="ignore")
    enabled: bool | None = None
    free_daily_uses: int | None = None
    pricing: dict | None = None
    tier_rules: dict | None = None
    personality: dict | None = None


class StudentToolRequest(BaseModel):
    model_config = ConfigDict(extra="ignore")
    book_slug: str
    block_text: str
    block_id: str | None = ""
    # Used ONLY to call GAS sendPoints once. Never persisted, never logged,
    # never echoed back to the client, never sent to Gemini.
    password: str


# --------------------------------------------------------------------------- #
# Helpers                                                                     #
# --------------------------------------------------------------------------- #
def _derive_tier(price: int, explicit: str) -> str:
    """Server-side mirror of the frontend tier derivation in purchaseService.js."""
    t = (explicit or "").strip().lower()
    if t in ("free", "standard", "premium", "limited"):
        return t
    p = int(price or 0)
    if p <= 0:
        return "free"
    if p <= 100:
        return "standard"
    if p <= 500:
        return "premium"
    return "limited"


def _merge_config(stored: dict | None) -> dict:
    """Deep-merge stored config over DEFAULT_CONFIG so missing keys keep working
    even after partial admin updates or fresh DBs."""
    out = json.loads(json.dumps(DEFAULT_CONFIG))  # deep clone
    if not stored or not isinstance(stored, dict):
        return out
    for k, v in stored.items():
        if k.startswith("_"):
            continue
        if isinstance(v, dict) and isinstance(out.get(k), dict):
            # one level of merge - nested pricing / tier_rules / personality
            merged = dict(out[k])
            merged.update(v)
            out[k] = merged
        else:
            out[k] = v
    return out


def _tier_allows(config: dict, tier: str, tool: str) -> Any:
    rules = (config.get("tier_rules") or {}).get(tier, {}) or {}
    return rules.get(tool, False)


def _first_name(display_name: str, clean_id: str) -> str:
    raw = (display_name or "").strip() or (clean_id or "").strip() or "friend"
    parts = raw.split()
    return parts[0].capitalize() if parts else "friend"


def _strip_fences(text: str) -> str:
    cleaned = text.strip()
    cleaned = re.sub(r"^```(?:json)?\s*", "", cleaned, flags=re.IGNORECASE)
    cleaned = re.sub(r"\s*```$", "", cleaned)
    return cleaned.strip()


def _extract_json(text: str) -> dict:
    """Parse JSON from Gemini text, even when the model wraps it in prose.

    Strategy (in order):
      1. Direct parse of the stripped text (fast path — works when model obeys).
      2. Extract the first {...} block via regex (handles leading/trailing prose).
      3. Raise json.JSONDecodeError if both fail — caller logs and raises 502.
    """
    stripped = _strip_fences(text)

    # Fast path
    try:
        return json.loads(stripped)
    except json.JSONDecodeError:
        pass

    # Fallback: find the outermost { ... } in the response.
    # re.DOTALL so newlines inside the JSON object are matched.
    m = re.search(r"\{.*\}", stripped, re.DOTALL)
    if m:
        try:
            return json.loads(m.group(0))
        except json.JSONDecodeError:
            pass

    raise json.JSONDecodeError("No valid JSON object found", text, 0)


# Fallback model tried when the primary model returns 503 (overload).
# gemini-2.0-flash is lighter and typically less congested.
_GEMINI_FALLBACK_MODEL = "gemini-2.0-flash"


async def _post_gemini(model_name: str, api_key: str, payload: dict) -> httpx.Response:
    """Single Gemini POST. Returns the raw httpx.Response."""
    endpoint = (
        f"https://generativelanguage.googleapis.com/v1beta/models"
        f"/{model_name}:generateContent"
    )
    async with httpx.AsyncClient(timeout=30.0) as cli:
        return await cli.post(
            endpoint,
            params={"key": api_key},
            json=payload,
            headers={"Content-Type": "application/json"},
        )


# --------------------------------------------------------------------------- #
# Tiny internal Gemini REST helper (Phase 1 only; gemini_engine.py untouched) #
# --------------------------------------------------------------------------- #
async def _gemini_call(system_instruction: str, user_prompt: str) -> dict:
    """POST to Gemini generateContent and return the parsed JSON dict.

    Raises HTTPException(503) when GEMINI_API_KEY is missing.
    Raises HTTPException(502) on any network / API / JSON error.
    On any failure path: NO points are charged.

    Retry / fallback policy:
      - Primary model: GEMINI_MODEL (default gemini-2.5-flash)
      - On 503 (overload): retry once after 2 s, then try gemini-2.0-flash.
      - Invalid JSON from model: extract the first {...} block from the prose
        response before giving up (handles markdown-wrapped replies).
    """
    if not GEMINI_API_KEY:
        raise HTTPException(
            status_code=503,
            detail="AI tools are not configured on this server. Please contact admin.",
        )

    # Append a hard JSON reminder to the user prompt so the model never
    # switches to prose — this is the most reliable way to enforce JSON
    # output when responseMimeType is occasionally ignored by the model.
    json_enforced_prompt = (
        user_prompt
        + "\n\nIMPORTANT: Your entire response MUST be a single valid JSON object. "
        "No prose, no markdown, no explanation outside the JSON."
    )

    payload = {
        "systemInstruction": {"parts": [{"text": system_instruction}]},
        "contents": [{"role": "user", "parts": [{"text": json_enforced_prompt}]}],
        "generationConfig": {
            "temperature": 0.4,
            # 1200 tokens — enough for all 5 schema fields with room to spare.
            # 700 was causing mid-JSON truncation on longer student sentences.
            "maxOutputTokens": 1200,
            "responseMimeType": "application/json",
        },
    }

    # Attempt sequence: primary → primary retry → fallback model
    # Both 503 (overload) AND invalid JSON retry on the next model —
    # invalid JSON can be caused by the model switching to prose under load.
    attempts = [
        (GEMINI_MODEL, 0.0),             # immediate
        (GEMINI_MODEL, 2.0),             # retry after 2 s
        (_GEMINI_FALLBACK_MODEL, 0.0),   # fallback model, immediate
    ]

    last_status = 502
    last_detail = "AI service unreachable. No points were charged."

    for model_name, delay in attempts:
        if delay > 0:
            await asyncio.sleep(delay)

        try:
            r = await _post_gemini(model_name, GEMINI_API_KEY, payload)
        except httpx.HTTPError as exc:
            log.warning("premium_ai: Gemini network error (model=%s): %s", model_name, exc)
            last_detail = "AI service unreachable. No points were charged."
            continue

        if r.status_code == 503:
            log.warning(
                "premium_ai: Gemini 503 overload (model=%s), will retry: %s",
                model_name, r.text[:200],
            )
            last_status = 503
            last_detail = (
                "AI service is temporarily overloaded. Please try again in a moment. "
                "No points were charged."
            )
            continue

        if r.status_code != 200:
            log.warning(
                "premium_ai: Gemini HTTP %s (model=%s): %s",
                r.status_code, model_name, r.text[:200],
            )
            last_status = r.status_code
            last_detail = f"AI service error (HTTP {r.status_code}). No points were charged."
            # Non-503 errors (400, 429 etc.) won't improve with retry
            break

        # 200 OK — extract text from response
        try:
            data = r.json()
            text = data["candidates"][0]["content"]["parts"][0]["text"]
        except Exception as exc:  # noqa: BLE001
            log.warning(
                "premium_ai: Gemini response shape error (model=%s): %s",
                model_name, exc,
            )
            last_detail = "AI returned an unexpected response. No points were charged."
            # Shape errors can differ per model — try next
            continue

        # Parse JSON — with fallback extraction for markdown-wrapped responses.
        # On failure: continue to next attempt (different model may produce
        # clean JSON where this one truncated or wrapped in prose).
        try:
            result = _extract_json(text)
            if model_name != GEMINI_MODEL:
                log.info("premium_ai: succeeded with fallback model=%s", model_name)
            return result
        except json.JSONDecodeError:
            log.warning(
                "premium_ai: invalid JSON from Gemini (model=%s): %s",
                model_name, text[:300],
            )
            last_detail = "AI returned invalid response. No points were charged."
            # Continue to next attempt instead of breaking — a different model
            # or retry may produce valid JSON where this one truncated/wrapped.
            continue

    raise HTTPException(status_code=502, detail=last_detail)


# --------------------------------------------------------------------------- #
# GAS PointsBackend helpers (no schema / payment_bridge changes)              #
# --------------------------------------------------------------------------- #
async def _gas_get_balance(
    student_clean_id: str, password: str
) -> tuple[int | None, str]:
    """Read student's current balance via GAS ``?action=login``.

    Returns ``(points, error_reason)`` where ``points`` is the numeric
    balance on success or ``None`` on any failure. ``error_reason`` is a
    short, operator-facing string (e.g. ``"missing_password"``,
    ``"no_gas_url"``, ``"post_invalid"``, ``"get_invalid"``,
    ``"get_no_points_in_response"``, ``"get_rejected_<msg>"``,
    ``"post_status_<code>"``, ``"network_<type>"``) — NEVER contains the
    password.

    Mirrors the known-working ``_credit_revalidate_with_gas`` helper in
    ``server.py`` (line 1784): POST first, then GET fallback with a
    ``t=<ms>`` cache buster. The legacy GAS backend rejects ``POST login``
    with "Invalid POST action", so a POST-only implementation fails on
    legacy deployments — this dual-mode keeps us compatible with both
    upgraded (POST-secured) and legacy (GET-classic) backends.
    """
    if not password:
        return None, "missing_password"
    if not GAS_POINTS_LOGIN_URL:
        return None, "no_gas_url"

    last_reason = "unknown"
    try:
        async with httpx.AsyncClient(
            timeout=httpx.Timeout(10.0, connect=5.0),
            follow_redirects=True,
        ) as cli:
            # Attempt 1 - POST (preferred by upgraded backend)
            try:
                r1 = await cli.post(
                    GAS_POINTS_LOGIN_URL,
                    data={
                        "action": "login",
                        "id": student_clean_id,
                        "password": password,
                        "t": str(int(time.time() * 1000)),
                    },
                )
                if r1.status_code == 200:
                    try:
                        j1 = r1.json()
                        if isinstance(j1, dict):
                            log.info(
                                "premium_ai: balance POST keys=%s success=%s",
                                sorted(j1.keys()),
                                j1.get("success"),
                            )
                            if j1.get("success") is True and isinstance(
                                j1.get("points"), (int, float)
                            ):
                                return int(j1["points"]), ""
                            last_reason = "post_invalid"
                        else:
                            last_reason = "post_bad_json_shape"
                    except Exception:
                        last_reason = "post_bad_json"
                else:
                    last_reason = f"post_status_{r1.status_code}"
            except Exception as exc:
                last_reason = f"post_network_{type(exc).__name__}"

            # Attempt 2 - GET (legacy backend only accepts GET for login)
            try:
                r2 = await cli.get(
                    GAS_POINTS_LOGIN_URL,
                    params={
                        "action": "login",
                        "id": student_clean_id,
                        "password": password,
                        "t": str(int(time.time() * 1000)),
                    },
                )
                if r2.status_code == 200:
                    try:
                        j2 = r2.json()
                    except Exception:
                        return None, "get_bad_json"
                    if isinstance(j2, dict):
                        log.info(
                            "premium_ai: balance GET keys=%s success=%s",
                            sorted(j2.keys()),
                            j2.get("success"),
                        )
                        if j2.get("success") is True and isinstance(
                            j2.get("points"), (int, float)
                        ):
                            return int(j2["points"]), ""
                        # Legacy backend on bad creds returns success:false
                        err_field = j2.get("error") or j2.get("message") or ""
                        if err_field:
                            return None, f"get_rejected_{str(err_field)[:40]}"
                        return None, "get_no_points_in_response"
                    return None, "get_bad_json_shape"
                return None, f"get_status_{r2.status_code}"
            except Exception as exc:
                return None, f"get_network_{type(exc).__name__}"
    except Exception as exc:
        log.warning(
            "premium_ai: GAS balance outer error: %s", type(exc).__name__
        )
        return None, f"outer_{type(exc).__name__}"

    return None, last_reason


async def _gas_debit(
    student_clean_id: str, password: str, amount: int
) -> tuple[bool, str]:
    """Debit student via GAS ``sendPoints(student -> treasury)``.

    Mirrors the existing ``sl.grant`` (server.py line 4275) and the
    frontend's ``purchaseBook`` flow byte-for-byte: POST with a fresh
    ``nonce`` (required by the secured backend, ignored by legacy).
    """
    if not password:
        return False, "missing_password"
    if not GAS_POINTS_LOGIN_URL:
        return False, "no_gas_url"
    try:
        async with httpx.AsyncClient(
            timeout=httpx.Timeout(15.0, connect=6.0),
            follow_redirects=True,
        ) as cli:
            r = await cli.post(
                GAS_POINTS_LOGIN_URL,
                data={
                    "action": "sendPoints",
                    "id": student_clean_id,
                    "password": password,
                    "receiverId": TREASURY_ID,
                    "amount": str(amount),
                    "nonce": secrets.token_hex(12),
                },
            )
        if r.status_code != 200:
            return False, f"HTTP {r.status_code}"
        try:
            j = r.json()
        except Exception:
            return False, f"bad_json: {r.text[:120]}"
        log.info(
            "premium_ai: debit POST keys=%s success=%s",
            sorted(j.keys()) if isinstance(j, dict) else type(j).__name__,
            (j or {}).get("success") if isinstance(j, dict) else None,
        )
        if isinstance(j, dict) and j.get("success") is True:
            return True, ""
        msg = (
            (j or {}).get("message")
            or (j or {}).get("error")
            or "Server rejected the transaction"
        )
        return False, str(msg)[:200]
    except Exception as exc:
        return False, f"{type(exc).__name__}: {str(exc)[:160]}"


# --------------------------------------------------------------------------- #
# System instructions for each tool                                           #
# --------------------------------------------------------------------------- #
_KHMER_DECODER_SYSTEM = """You are EduHub's private English coach for Cambodian learners.
Decode a student's sentence by exposing the underlying Khmer thinking pattern, then offer two upgraded English versions.

Output STRICT JSON only. No markdown, no preamble.
Schema:
{
  "greeting": "Friendly one-line greeting using the student's first name.",
  "khmer_mindset": "1-2 sentences explaining the Khmer thinking pattern behind their sentence.",
  "natural_version": "Natural, conversational English version of the sentence.",
  "executive_version": "Polished, professional English version of the sentence.",
  "practice_line": "One short speaking-practice sentence the student can say aloud."
}

Be respectful. Never criticise. Always frame improvements as upgrades, not corrections."""

_EXECUTIVE_UPGRADE_SYSTEM = """You are EduHub's private executive English coach for Cambodian learners.
Rewrite a student's sentence into a confident, professional executive version suitable for business communication.

Output STRICT JSON only. No markdown, no preamble.
Schema:
{
  "greeting": "Friendly one-line greeting using the student's first name.",
  "executive_version": "The upgraded, professional executive version of the sentence.",
  "why_it_works": "1-2 short bullet points (joined by ' . ') explaining the upgrades made.",
  "practice_line": "One short speaking-practice sentence the student can say aloud in a professional setting."
}

Be respectful. Frame improvements as upgrades, not corrections. Keep the executive version concise (max 30 words)."""


# --------------------------------------------------------------------------- #
# Public registration function                                                #
# --------------------------------------------------------------------------- #
def register_premium_ai_routes(api: APIRouter, db, require_admin, require_student) -> None:
    """Attach all premium AI tool routes to the given APIRouter.

    Called by server.py exactly once, immediately before app.include_router(api).
    All routes are prefixed by the parent router's '/api' prefix.
    """
    ai_config_col = db["ai_tools_config"]
    ai_logs_col = db["ai_usage_logs"]
    books_col = db["books"]

    async def _load_config() -> dict:
        doc = await ai_config_col.find_one({"_id": CONFIG_DOC_ID})
        return _merge_config(doc)

    async def _save_config(updates: dict, admin_email: str) -> dict:
        allowed = {"enabled", "free_daily_uses", "pricing", "tier_rules", "personality"}
        set_doc: dict = {}
        for k in allowed:
            if k in updates and updates[k] is not None:
                set_doc[k] = updates[k]
        set_doc["_updated_at"] = datetime.now(timezone.utc).isoformat()
        set_doc["_updated_by"] = admin_email
        await ai_config_col.update_one(
            {"_id": CONFIG_DOC_ID},
            {"$set": set_doc},
            upsert=True,
        )
        return await _load_config()

    async def _resolve_book_tier(slug: str) -> str:
        doc = await books_col.find_one(
            {"slug": slug, "published": True},
            {"_id": 0, "tier": 1, "price": 1},
            sort=[("revision", -1)],
        )
        if not doc:
            return "free"
        return _derive_tier(int(doc.get("price") or 0), doc.get("tier") or "")

    async def _log_usage(
        student,
        tool: str,
        cost: int,
        status: str,
        book_slug: str,
        points_before: int | None = None,
        points_after: int | None = None,
        error: str | None = None,
    ) -> None:
        """Append-only audit log. Never stores password. Never stores AI output verbatim."""
        await ai_logs_col.insert_one({
            "student_id": getattr(student, "student_id", ""),
            "clean_id": getattr(student, "clean_id", ""),
            "student_name": getattr(student, "display_name", ""),
            "book_slug": book_slug,
            "tool": tool,
            "points_deducted": cost if status == "success" else 0,
            "points_before": points_before,
            "points_after": points_after,
            "status": status,
            "error": (error or "")[:200] if error else "",
            "created_at": datetime.now(timezone.utc).isoformat(),
        })

    # ----------------------- Admin routes ----------------------- #
    @api.get("/admin/ai-tools-config")
    async def admin_get_config(admin=Depends(require_admin)):
        return {"success": True, "config": await _load_config()}

    @api.put("/admin/ai-tools-config")
    async def admin_save_config(payload: AdminConfigUpdate, admin=Depends(require_admin)):
        cfg = await _save_config(
            payload.model_dump(exclude_unset=True), admin.email
        )
        return {"success": True, "config": cfg}

    @api.get("/admin/ai-tools-usage")
    async def admin_usage(limit: int = 100, skip: int = 0, admin=Depends(require_admin)):
        limit = max(1, min(int(limit or 100), 500))
        skip = max(0, int(skip or 0))
        total = await ai_logs_col.count_documents({})
        cursor = (
            ai_logs_col.find({}, {"_id": 0})
            .sort("created_at", -1)
            .skip(skip)
            .limit(limit)
        )
        items = [d async for d in cursor]
        return {"success": True, "total": total, "items": items}

    # ----------------------- Student routes ----------------------- #
    @api.get("/student/premium/ai-config")
    async def student_ai_config(student=Depends(require_student)):
        cfg = await _load_config()
        # Return only what the frontend needs. Never leak the system_instruction
        # (admin-only) or internal _updated_* fields.
        return {
            "success": True,
            "config": {
                "enabled": cfg.get("enabled", True),
                "pricing": cfg.get("pricing", {}),
                "tier_rules": cfg.get("tier_rules", {}),
                "tone": (cfg.get("personality") or {}).get("tone", "professional"),
            },
        }

    async def _run_premium_tool(
        *,
        tool: str,
        cfg_key: str,
        system_instruction: str,
        user_prompt: str,
        payload: StudentToolRequest,
        student,
    ) -> dict:
        # ── v1.2: safe debug logs (no password, no Gemini content) ──────── #
        log.info(
            "premium_ai: route=%s student_id=%s clean_id=%s book=%s",
            tool, student.student_id, student.clean_id, payload.book_slug,
        )

        # 1. Load config + check global enable
        cfg = await _load_config()
        if not cfg.get("enabled", True):
            raise HTTPException(
                status_code=503,
                detail="AI tools are temporarily disabled by the administrator.",
            )

        cost = max(0, int((cfg.get("pricing") or {}).get(cfg_key) or 0))

        # 2. Tier rule check
        tier = await _resolve_book_tier(payload.book_slug)
        allowed = _tier_allows(cfg, tier, cfg_key)
        if not allowed:
            raise HTTPException(
                status_code=403,
                detail=f"This AI tool is not available on {tier}-tier books.",
            )

        # 3. Validate text input
        text = (payload.block_text or "").strip()
        if not text:
            raise HTTPException(status_code=400, detail="No text was selected.")
        if len(text) > 2000:
            text = text[:2000]

        # 4. Pre-flight balance check (uses password but never persists it)
        log.info("premium_ai: balance check start clean_id=%s", student.clean_id)
        balance, reason = await _gas_get_balance(student.clean_id, payload.password)
        if balance is None:
            log.warning(
                "premium_ai: balance check FAILED clean_id=%s reason=%s",
                student.clean_id, reason,
            )
            # Surface a precise reason so the operator can debug without
            # exposing the password. The frontend already swallows the
            # backend detail string into its generic error card if needed.
            human = {
                "missing_password": "Please sign in again to use premium AI tools.",
                "no_gas_url": "Points service is not configured on the server.",
                "post_invalid": "Could not verify your point balance. Please try again.",
                "get_no_points_in_response": "Points service did not return a balance. Please try again.",
            }.get(reason, "Could not verify your point balance. Please try again.")
            raise HTTPException(
                status_code=502,
                detail=f"{human} (code: {reason})",
            )

        log.info(
            "premium_ai: balance check OK clean_id=%s balance=%s cost=%s",
            student.clean_id, balance, cost,
        )

        if balance < cost:
            await _log_usage(
                student, tool, cost, "insufficient_points", payload.book_slug,
                points_before=balance, points_after=balance,
                error=f"need {cost} have {balance}",
            )
            return {
                "success": False,
                "error": "insufficient_points",
                "required_points": cost,
                "points_remaining": balance,
                "message": f"You need {cost} points to use this premium AI tool.",
            }

        # 5. Call Gemini FIRST. If this fails -> NO points are debited.
        log.info("premium_ai: gemini call start tool=%s", tool)
        try:
            ai_result = await _gemini_call(system_instruction, user_prompt)
        except HTTPException as he:
            log.warning(
                "premium_ai: gemini FAILED tool=%s status=%s",
                tool, he.status_code,
            )
            await _log_usage(
                student, tool, cost, "ai_error", payload.book_slug,
                points_before=balance, points_after=balance,
                error="Gemini call failed",
            )
            raise
        log.info("premium_ai: gemini OK tool=%s", tool)

        # 6. Deduct points ONLY after Gemini success. Cost==0 -> skip GAS call.
        if cost > 0:
            log.info("premium_ai: debit start clean_id=%s amount=%s", student.clean_id, cost)
            debit_ok, debit_err = await _gas_debit(
                student.clean_id, payload.password, cost
            )
        else:
            debit_ok, debit_err = True, ""

        if not debit_ok:
            # Gemini succeeded but debit failed -> NOT a success. Surface clearly.
            log.warning(
                "premium_ai: debit FAILED clean_id=%s amount=%s err=%s",
                student.clean_id, cost, debit_err,
            )
            await _log_usage(
                student, tool, cost, "debit_failed", payload.book_slug,
                points_before=balance, points_after=balance,
                error=debit_err,
            )
            raise HTTPException(
                status_code=502,
                detail=(
                    "AI ran successfully but we could not charge the points. "
                    f"No points were taken. ({debit_err})"
                ),
            )

        log.info("premium_ai: debit OK clean_id=%s amount=%s", student.clean_id, cost)

        # 7. Re-read balance (best-effort) for the response card
        new_balance, _reason2 = await _gas_get_balance(student.clean_id, payload.password)
        if new_balance is None:
            new_balance = max(0, balance - cost)

        # 8. Audit log (NO password, NO Gemini output stored)
        await _log_usage(
            student, tool, cost, "success", payload.book_slug,
            points_before=balance, points_after=new_balance,
        )

        # 9. Return the result card to the frontend
        greeting_default = (
            f"Hi {_first_name(student.display_name, student.clean_id)},"
        )
        response: dict = {
            "success": True,
            "tool": tool,
            "points_deducted": cost,
            "points_remaining": new_balance,
            "greeting": str(ai_result.get("greeting") or greeting_default)[:300],
        }
        for k in (
            "khmer_mindset",
            "natural_version",
            "executive_version",
            "practice_line",
            "why_it_works",
        ):
            if k in ai_result:
                response[k] = str(ai_result[k])[:2000]
        return response

    @api.post("/student/premium/decode-block")
    async def student_decode_block(
        payload: StudentToolRequest, student=Depends(require_student)
    ):
        student_name = _first_name(student.display_name, student.clean_id)
        prompt = (
            f"Student first name: {student_name}\n"
            f"Student's sentence:\n\"\"\"{payload.block_text}\"\"\"\n\n"
            "Decode the underlying Khmer thinking pattern, give a natural English "
            "version, an executive English version, and a short practice line. "
            "Return JSON only."
        )
        return await _run_premium_tool(
            tool="khmer_decoder",
            cfg_key="khmer_decoder",
            system_instruction=_KHMER_DECODER_SYSTEM,
            user_prompt=prompt,
            payload=payload,
            student=student,
        )

    @api.post("/student/premium/executive-upgrade")
    async def student_executive_upgrade(
        payload: StudentToolRequest, student=Depends(require_student)
    ):
        student_name = _first_name(student.display_name, student.clean_id)
        prompt = (
            f"Student first name: {student_name}\n"
            f"Student's sentence:\n\"\"\"{payload.block_text}\"\"\"\n\n"
            "Rewrite this into a confident, professional executive English version. "
            "Explain why it works in 1-2 bullets joined by ' . '. Give one practice "
            "line. Return JSON only."
        )
        return await _run_premium_tool(
            tool="executive_upgrade",
            cfg_key="executive_upgrade",
            system_instruction=_EXECUTIVE_UPGRADE_SYSTEM,
            user_prompt=prompt,
            payload=payload,
            student=student,
        )

    log.info(
        "premium_ai_tools: routes registered (Phase 1 = decode-block + executive-upgrade)"
    )

