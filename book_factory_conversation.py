"""book_factory_conversation.py — Book Factory (Phase 4) conversation-audio
line storage + dialog-line extraction.

Isolated, backend-only, self-contained (no server.py / book_factory_jobs.py
imports) — mirrors book_factory_image.py's pattern exactly: its own R2
upload helper under a dedicated key prefix (`conversation-lines/`), never
mixed with cover (`book-covers/`) or narration/manual-CVS audio (GridFS)
objects.

Why per-line audio needs its own persisted storage: true resumable,
non-duplicating conversation-audio automation means each ElevenLabs line
call happens in its OWN fenced request/response cycle (bounded, retryable,
resumable independently). The eventual assembly step (stitching every
line into one continuous MP3) may run in a LATER, separate request — so a
completed line's audio bytes must be durably stored somewhere fetchable by
that later request, not held only in the process memory of the request
that generated it.
"""
from __future__ import annotations

import logging
import os
import re
from typing import Optional

import httpx

log = logging.getLogger("eduhub.book_factory")


# ── R2 storage (isolated from server.py's audio uploader and from
#    book_factory_image.py's cover uploader — separate key prefix) ─────────
def _r2_config() -> Optional[dict[str, str]]:
    required = ["R2_ACCOUNT_ID", "R2_ACCESS_KEY_ID", "R2_SECRET_ACCESS_KEY",
                "R2_BUCKET_NAME", "R2_PUBLIC_URL"]
    cfg = {k: os.environ.get(k, "").strip() for k in required}
    return cfg if all(cfg.values()) else None


def storage_configured() -> bool:
    """Conversation-audio-automation readiness signal for the frontend."""
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


def _line_key(job_id: str, chapter_id: str, line_id: str, attempt_id: str) -> str:
    """Deterministic per-attempt key — same reasoning as book_factory_image's
    cover key: identity is (job, chapter, line, attempt), never a bare
    random UUID, so a retry within the SAME claimed attempt can prove an
    object already exists before re-paying for generation."""
    safe = lambda s: re.sub(r"[^A-Za-z0-9_-]", "_", s or "x")  # noqa: E731
    return (f"conversation-lines/{safe(job_id)}/{safe(chapter_id)}/"
            f"{safe(line_id)}/{safe(attempt_id)}.mp3")


async def _head_exists(cfg: dict, key: str) -> Optional[str]:
    """Return the public URL if `key` already exists on R2, else None. Never
    raises — treats any failure as "not found" so the normal upload path
    still runs (same convention as book_factory_image.py's cover HEAD-check)."""
    import asyncio as _asyncio
    try:
        def _do_head():
            s3 = _s3_client(cfg)
            s3.head_object(Bucket=cfg["R2_BUCKET_NAME"], Key=key)
        loop = _asyncio.get_event_loop()
        await loop.run_in_executor(None, _do_head)
        return f"{cfg['R2_PUBLIC_URL'].rstrip('/')}/{key}"
    except Exception:  # noqa: BLE001
        return None


async def store_line_audio(job_id: str, chapter_id: str, line_id: str,
                            attempt_id: str, audio_bytes: bytes) -> str:
    """Upload one conversation line's MP3 bytes to R2. Returns the public URL.

    HEAD-checks the deterministic (job, chapter, line, attempt) key first —
    if an earlier upload for this SAME attempt actually succeeded but the
    caller's retry loop re-invokes this function (e.g. because a later step
    in that same request raised), this returns the already-stored URL
    instead of uploading a duplicate object.

    Raises RuntimeError if R2 is not configured — conversation-audio
    automation is simply unavailable without it (same limitation as covers).
    Raises the underlying exception on an upload failure (S3 PUT is atomic —
    nothing is stored on failure, safe for the caller to retry the UPLOAD
    only, not the provider call — see book_factory_jobs._run_conversation_line's
    bounded in-process retry around this exact call).
    """
    cfg = _r2_config()
    if cfg is None:
        raise RuntimeError(
            "R2 is not configured — conversation-audio line storage is unavailable."
        )
    import asyncio as _asyncio
    key = _line_key(job_id, chapter_id, line_id, attempt_id)

    existing = await _head_exists(cfg, key)
    if existing:
        return existing

    def _do_upload():
        s3 = _s3_client(cfg)
        s3.put_object(
            Bucket=cfg["R2_BUCKET_NAME"], Key=key, Body=audio_bytes,
            ContentType="audio/mpeg",
            Metadata={"jobId": job_id, "chapterId": chapter_id, "lineId": line_id,
                      "attemptId": attempt_id},
        )

    loop = _asyncio.get_event_loop()
    await loop.run_in_executor(None, _do_upload)
    url = f"{cfg['R2_PUBLIC_URL'].rstrip('/')}/{key}"
    log.info("book_factory_conversation: stored line audio %s (%d bytes)", key, len(audio_bytes))
    return url


async def fetch_line_audio_bytes(url: str, *, timeout: float = 30.0) -> bytes:
    """Download a previously-stored line's MP3 bytes for assembly. Plain HTTP
    GET on the public R2 URL — no AWS SDK round-trip needed since the bucket
    serves public objects (same convention already used for audio/cover URLs
    elsewhere in this codebase)."""
    async with httpx.AsyncClient(timeout=timeout) as client:
        resp = await client.get(url)
        resp.raise_for_status()
        return resp.content


# ── dialog-line extraction (pure) ──────────────────────────────────────────
def extract_dialog_lines(blocks: list[dict]) -> list[dict]:
    """Return stable {lineId, blockIndex, speaker, text} entries for every
    dialog block in `blocks`, in array order. `blockIndex` is the ABSOLUTE
    index within `blocks` (matches the index the existing /conversation
    route expects for updating that exact block) — stable as long as no
    earlier block is inserted/removed/reordered before it. `lineId` is a
    position-derived stable identity ("ln0", "ln1", …) — the SAME dialog
    block always gets the SAME lineId across repeated calls as long as the
    blocks list itself hasn't changed (i.e. as long as the chapter has not
    been regenerated), which is exactly the condition under which a job's
    conversationAudio stage for that chapter is valid.
    """
    out = []
    n = 0
    for i, b in enumerate(blocks or []):
        if not isinstance(b, dict) or b.get("type") != "dialog":
            continue
        text = str(b.get("text") or "").strip()
        if not text:
            continue
        out.append({
            "lineId": f"ln{n}",
            "blockIndex": i,
            "speaker": str(b.get("speaker") or "").strip() or "Speaker",
            "text": text,
        })
        n += 1
    return out
