"""book_factory_image.py — Book Factory (Phase 2) Gemini cover-image adapter.

Isolated, backend-only. Mirrors book_factory_gemini.py's proven pattern: raw
`httpx` (no SDK), an environment-configured API key, the `generateContent`
REST endpoint, and the SAME BFRetryableError / BFUnknownOutcomeError /
BFTerminalError exception taxonomy (imported, never redefined) so the job
orchestrator in book_factory_jobs.py can classify failures identically to a
text stage.

Model / endpoint (LOCKED per explicit product decision): the stable Generate
Content model id "gemini-3.1-flash-image" served under the stable "v1" API
version — NOT the Interactions API (different endpoint/schema/parser, out of
scope for this adapter) and NOT a "-preview"-suffixed model id. Both are
read from BOOK_FACTORY_COVER_MODEL / BOOK_FACTORY_COVER_API_VERSION so either
can be corrected via a Render env var alone if Google's naming or version
policy shifts again — no code change required either way. Neither variable
needs to be SET in Render for the defaults to be correct.

Storage: uploads the generated PNG/JPEG bytes to Cloudflare R2 under an
isolated `book-covers/` key prefix (never mixed with the existing
`elevenlabs`/audio objects) and returns ONLY the public URL + mimeType. Raw
base64 image data is never returned to the caller and never persisted in any
book/job document field — only the final stable URL.

This module does not import server.py or book_factory_jobs.py (no circular
imports); it is called BY book_factory_jobs.py's `_run_cover` orchestration.
"""
from __future__ import annotations

import logging
import os
import re
from typing import Any, Optional

import httpx

from book_factory_gemini import BFRetryableError, BFTerminalError, BFUnknownOutcomeError

log = logging.getLogger("eduhub.book_factory")


# ── config ──────────────────────────────────────────────────────────────────
def _image_api_key() -> str:
    """Prefer a dedicated image-capable key; fall back to the shared text key.
    Reads live so tests can toggle per-case."""
    return os.environ.get("GEMINI_IMAGE_API_KEY", "") or os.environ.get("GEMINI_API_KEY", "")


def is_enabled() -> bool:
    """True iff an image-capable Gemini key is configured."""
    return bool(_image_api_key())


def _model() -> str:
    return os.environ.get("BOOK_FACTORY_COVER_MODEL", "gemini-3.1-flash-image")


def _api_version() -> str:
    """Stable "v1" — see the LOCKED decision note in the module docstring."""
    return os.environ.get("BOOK_FACTORY_COVER_API_VERSION", "v1")


def _endpoint() -> str:
    return f"https://generativelanguage.googleapis.com/{_api_version()}/models/{_model()}:generateContent"


HARD_MAX_COVER_TIMEOUT_S: float = 90.0
HARD_MIN_COVER_TIMEOUT_S: float = 10.0
HARD_MAX_IMAGE_BYTES: int = 8 * 1024 * 1024  # 8 MB ceiling on a returned image


def _env_float_clamped(name: str, default: float, lo: float, hi: float) -> float:
    try:
        raw = os.environ.get(name, "")
        v = float(raw) if raw.strip() else default
    except (TypeError, ValueError):
        return default
    import math as _math
    if not _math.isfinite(v) or v <= 0:
        return default
    return max(lo, min(v, hi))


COVER_TIMEOUT_S: float = _env_float_clamped(
    "BOOK_FACTORY_COVER_TIMEOUT_S", 45.0, HARD_MIN_COVER_TIMEOUT_S, HARD_MAX_COVER_TIMEOUT_S
)

_MAX_PROMPT_FIELD_LEN = 300


def _sanitize(text: str) -> str:
    """Bound length and strip control characters before they reach a prompt."""
    s = (text or "").strip()
    s = re.sub(r"[\x00-\x08\x0b\x0c\x0e-\x1f]", "", s)  # strip control chars, keep \n\t
    return s[:_MAX_PROMPT_FIELD_LEN]


def _build_cover_prompt(*, title: str, topic: str, section: str, level: str, tier: str, accent: str) -> str:
    title_s = _sanitize(title) or "Untitled"
    topic_s = _sanitize(topic) or title_s
    section_s = _sanitize(section) or "story"
    level_s = _sanitize(level) or "A2"
    tier_s = _sanitize(tier) or "free"
    accent_s = _sanitize(accent) or "#D4A843"

    quality_note = {
        "premium": "Premium, richly detailed, painterly illustration quality.",
        "limited": "Prestige limited-edition illustration quality, ornate detail.",
        "standard": "Clean, polished, professional illustration quality.",
    }.get(tier_s, "Clean, friendly, professional illustration quality.")

    return (
        "Design a portrait-orientation book cover ILLUSTRATION for an English-learning "
        f"{section_s} book titled \"{title_s}\".\n"
        f"Topic/theme: {topic_s}\n"
        f"CEFR learner level: {level_s} (visual tone must feel age/level appropriate — "
        "simple and warm for beginners, more sophisticated for advanced levels).\n"
        f"{quality_note}\n"
        f"Incorporate the accent color {accent_s} tastefully into the palette.\n"
        "Composition rules:\n"
        "- Portrait book-cover proportions (taller than wide).\n"
        "- Leave the upper third visually calmer so a title can be legible if overlaid later.\n"
        "- Do NOT render any text, letters, words, logos, or watermarks in the image.\n"
        "- Do NOT include any real brand names, real people, or copyrighted characters.\n"
        "- Safe, classroom-appropriate, no violence, no frightening imagery.\n"
        "Style: single clear illustrated scene, no collage, no border frame."
    )


# ── Gemini image call ───────────────────────────────────────────────────────
async def _call_gemini_image(prompt: str, *, timeout: float) -> dict[str, str]:
    """POST to Gemini generateContent with IMAGE response modality.

    Returns {"data_b64": str, "mimeType": str}. Raises BFRetryableError /
    BFUnknownOutcomeError / BFTerminalError — classification mirrors
    book_factory_gemini._gemini_http_once exactly.
    """
    key = _image_api_key()
    if not key:
        raise BFRetryableError("No image-capable Gemini API key is configured.")

    # LOCKED request shape (Generate Content API, not Interactions): explicitly
    # requesting a portrait aspect ratio is far more reliable than relying on
    # prose instructions alone — books need a portrait cover, not whatever
    # orientation the model defaults to. "2:3" is in the model's supported
    # aspect-ratio list. imageSize is env-overridable to bound cost.
    payload = {
        "contents": [{"role": "user", "parts": [{"text": prompt}]}],
        "generationConfig": {
            "responseModalities": ["IMAGE"],
            "responseFormat": {
                "image": {
                    "aspectRatio": "2:3",
                    "imageSize": os.environ.get("BOOK_FACTORY_COVER_IMAGE_SIZE", "1K"),
                },
            },
        },
    }

    try:
        async with httpx.AsyncClient(timeout=timeout) as client:
            resp = await client.post(
                _endpoint(),
                params={"key": key},
                json=payload,
                headers={"Content-Type": "application/json"},
            )
    except (httpx.ConnectError, httpx.ConnectTimeout, httpx.LocalProtocolError) as exc:
        raise BFRetryableError(f"pre-transmission failure: {type(exc).__name__}: {exc}") from exc
    except (httpx.WriteTimeout, httpx.WriteError, httpx.ReadTimeout,
            httpx.ReadError, httpx.RemoteProtocolError) as exc:
        raise BFUnknownOutcomeError(f"in-flight failure: {type(exc).__name__}: {exc}") from exc
    except httpx.TransportError as exc:
        raise BFUnknownOutcomeError(f"transport failure: {type(exc).__name__}: {exc}") from exc

    status = resp.status_code
    if status == 429:
        raise BFRetryableError("Gemini rate-limited (HTTP 429), request not processed.")
    if 500 <= status <= 599:
        raise BFUnknownOutcomeError(f"Gemini server error (HTTP {status}), outcome unknown.")
    if status != 200:
        raise BFTerminalError(f"Gemini returned HTTP {status} (non-retryable).")

    try:
        data = resp.json()
    except Exception as exc:  # noqa: BLE001
        raise BFTerminalError(f"HTTP 200 body was not JSON: {exc}") from exc

    return _extract_image_part(data)


def _extract_image_part(data: Any) -> dict[str, str]:
    """Pull the first inlineData image part out of a generateContent envelope.
    Any malformed shape (missing candidates/parts, no image part) is a
    BFTerminalError — a text-only or empty response is not a transient fault,
    it means the model declined to produce an image for this prompt."""
    if not isinstance(data, dict):
        raise BFTerminalError("Gemini response envelope is not an object.")
    candidates = data.get("candidates")
    if not isinstance(candidates, list) or not candidates:
        raise BFTerminalError("Gemini candidates missing or empty (no image returned).")
    cand0 = candidates[0]
    content = cand0.get("content") if isinstance(cand0, dict) else None
    parts = content.get("parts") if isinstance(content, dict) else None
    if not isinstance(parts, list):
        raise BFTerminalError("Gemini candidate has no content parts.")
    for part in parts:
        if not isinstance(part, dict):
            continue
        inline = part.get("inlineData") or part.get("inline_data")
        if isinstance(inline, dict):
            b64 = inline.get("data")
            mime = inline.get("mimeType") or inline.get("mime_type") or "image/png"
            if isinstance(b64, str) and b64.strip():
                return {"data_b64": b64.strip(), "mimeType": str(mime)}
    raise BFTerminalError("Gemini response contained no image part (text-only or empty).")


def _validate_image_bytes(image_bytes: bytes, mime: str) -> str:
    """Validate size + magic bytes. Returns a safe file extension.
    Raises BFTerminalError on any invalid result."""
    if not image_bytes:
        raise BFTerminalError("Decoded image is empty.")
    if len(image_bytes) > HARD_MAX_IMAGE_BYTES:
        raise BFTerminalError(f"Decoded image exceeds {HARD_MAX_IMAGE_BYTES} bytes.")
    if image_bytes[:8] == b"\x89PNG\r\n\x1a\n":
        return "png"
    if image_bytes[:2] == b"\xff\xd8":
        return "jpg"
    if image_bytes[:4] == b"RIFF" and image_bytes[8:12] == b"WEBP":
        return "webp"
    raise BFTerminalError(f"Decoded image is not a recognized PNG/JPEG/WEBP (mime={mime!r}).")


# ── R2 storage (isolated from server.py's audio uploader) ──────────────────
def _r2_config() -> Optional[dict[str, str]]:
    required = ["R2_ACCOUNT_ID", "R2_ACCESS_KEY_ID", "R2_SECRET_ACCESS_KEY",
                "R2_BUCKET_NAME", "R2_PUBLIC_URL"]
    cfg = {k: os.environ.get(k, "").strip() for k in required}
    return cfg if all(cfg.values()) else None


def storage_configured() -> bool:
    """Cover-readiness signal for the frontend: is R2 reachable in principle
    (all env vars present)? Does not make a network call."""
    return _r2_config() is not None


def _s3_client(cfg: dict):
    import boto3
    from botocore.config import Config as _BotocoreConfig
    endpoint = f"https://{cfg['R2_ACCOUNT_ID']}.r2.cloudflarestorage.com"
    return boto3.client(
        "s3",
        endpoint_url=endpoint,
        aws_access_key_id=cfg["R2_ACCESS_KEY_ID"],
        aws_secret_access_key=cfg["R2_SECRET_ACCESS_KEY"],
        region_name="auto",
        config=_BotocoreConfig(signature_version="s3v4"),
    )


def _deterministic_key(job_id: str, attempt_id: str, ext: str) -> str:
    """A cover object's identity is (jobId, attemptId) — NOT a bare random
    UUID — so a retry that reaches this same claimed attempt again (e.g. an
    in-process retry after a transient DB write failure, see
    _upload_and_reuse_cover below) can prove whether the object already
    exists instead of re-calling the paid Gemini endpoint."""
    safe_job = re.sub(r"[^A-Za-z0-9_-]", "_", job_id or "job")
    safe_attempt = re.sub(r"[^A-Za-z0-9_-]", "_", attempt_id or "attempt")
    return f"book-covers/{safe_job}/{safe_attempt}.{ext}"


async def _head_exists(cfg: dict, key: str) -> Optional[str]:
    """Return the public URL if `key` already exists on R2, else None.
    Never raises — a HEAD failure (network blip, missing object) is treated
    as "not found" so the normal generate path still runs."""
    import asyncio as _asyncio
    try:
        def _do_head():
            s3 = _s3_client(cfg)
            s3.head_object(Bucket=cfg["R2_BUCKET_NAME"], Key=key)
        loop = _asyncio.get_event_loop()
        await loop.run_in_executor(None, _do_head)
        return f"{cfg['R2_PUBLIC_URL'].rstrip('/')}/{key}"
    except Exception:  # noqa: BLE001 — any failure means "treat as not found"
        return None


async def _upload_cover_to_r2(image_bytes: bytes, key: str, mime: str, metadata: dict) -> str:
    """Upload cover image bytes to Cloudflare R2 at the given deterministic key.

    Raises BFTerminalError if R2 is not configured (no fallback storage exists
    for images — cover generation is simply unavailable without R2).
    Raises BFRetryableError on an upload failure (S3 PUT is atomic — a thrown
    exception means nothing was stored, safe to retry without a fresh Gemini call
    since the caller retries the upload itself using the SAME already-generated
    bytes, not by regenerating the image).
    """
    cfg = _r2_config()
    if cfg is None:
        raise BFTerminalError(
            "R2 is not configured (R2_ACCOUNT_ID/R2_ACCESS_KEY_ID/R2_SECRET_ACCESS_KEY/"
            "R2_BUCKET_NAME/R2_PUBLIC_URL) — cover-image storage is unavailable."
        )
    try:
        import asyncio as _asyncio

        def _do_upload():
            s3 = _s3_client(cfg)
            s3.put_object(
                Bucket=cfg["R2_BUCKET_NAME"],
                Key=key,
                Body=image_bytes,
                ContentType=mime,
                Metadata={str(k): str(v) for k, v in (metadata or {}).items()},
            )

        loop = _asyncio.get_event_loop()
        await loop.run_in_executor(None, _do_upload)
        url = f"{cfg['R2_PUBLIC_URL'].rstrip('/')}/{key}"
        log.info("book_factory_image: uploaded %s (%d bytes) url=%s", key, len(image_bytes), url)
        return url
    except BFTerminalError:
        raise
    except ImportError as exc:
        raise BFTerminalError(f"boto3 not installed: {exc}") from exc
    except Exception as exc:  # noqa: BLE001 — S3 PUT is atomic, safe to retry
        raise BFRetryableError(f"R2 cover upload failed: {type(exc).__name__}: {exc}") from exc


# ── public API (monkeypatched in tests) ────────────────────────────────────
async def generate_cover_image_bytes(*, title: str, topic: str, section: str,
                                      level: str, tier: str, accent: str) -> dict:
    """Call Gemini ONLY — no storage. Returns {"image_bytes": bytes,
    "mimeType": str, "ext": str}. Raises BFRetryableError /
    BFUnknownOutcomeError / BFTerminalError.

    Kept separate from storage so a caller (book_factory_jobs._run_cover) can
    retry JUST the upload step after a storage failure without ever paying
    for a second Gemini call — the image bytes already exist in memory.
    """
    prompt = _build_cover_prompt(
        title=title, topic=topic, section=section, level=level, tier=tier, accent=accent,
    )
    result = await _call_gemini_image(prompt, timeout=COVER_TIMEOUT_S)

    import base64 as _b64
    try:
        image_bytes = _b64.b64decode(result["data_b64"], validate=False)
    except Exception as exc:  # noqa: BLE001
        raise BFTerminalError(f"Cover image base64 decode failed: {exc}") from exc

    ext = _validate_image_bytes(image_bytes, result["mimeType"])
    return {"image_bytes": image_bytes, "mimeType": result["mimeType"], "ext": ext}


async def store_cover_image(*, job_id: str, attempt_id: str, image_bytes: bytes,
                             mime: str, ext: str, title: str = "", section: str = "",
                             level: str = "", tier: str = "", admin_email: str = "") -> str:
    """Upload already-generated cover bytes to R2 at the deterministic
    (jobId, attemptId) key. HEAD-checks first so a caller retrying THIS
    function after a transient upload failure (same bytes, same attempt)
    never double-uploads. Raises BFTerminalError if R2 is not configured,
    BFRetryableError on an upload failure (safe to retry — nothing partial
    is left behind)."""
    cfg = _r2_config()
    if cfg is None:
        raise BFTerminalError("R2 is not configured — cover-image storage is unavailable.")
    key = _deterministic_key(job_id, attempt_id, ext)
    existing = await _head_exists(cfg, key)
    if existing:
        log.info("book_factory_image: reusing already-stored cover for attempt=%s", attempt_id)
        return existing
    return await _upload_cover_to_r2(
        image_bytes, key, mime,
        {"jobId": job_id, "attemptId": attempt_id, "title": title, "section": section,
         "level": level, "tier": tier, "created_by": admin_email},
    )


async def generate_and_store_cover(*, job_id: str, attempt_id: str,
                                    title: str, topic: str, section: str,
                                    level: str, tier: str, accent: str,
                                    admin_email: str = "") -> dict[str, str]:
    """Convenience wrapper combining generate + store in one call. Used
    directly only where the caller does not need to retry the upload
    independently of the Gemini call — the job orchestrator (_run_cover)
    calls the two split functions directly instead so a storage failure
    never triggers a second paid Gemini call.
    """
    gen = await generate_cover_image_bytes(
        title=title, topic=topic, section=section, level=level, tier=tier, accent=accent,
    )
    url = await store_cover_image(
        job_id=job_id, attempt_id=attempt_id, image_bytes=gen["image_bytes"],
        mime=gen["mimeType"], ext=gen["ext"], title=title, section=section,
        level=level, tier=tier, admin_email=admin_email,
    )
    return {"url": url, "mimeType": gen["mimeType"]}
