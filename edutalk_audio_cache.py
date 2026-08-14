"""edutalk_audio_cache.py — EduTalk Audio Cache + Per-Student Entitlement.

ISOLATED, ADDITIVE MODULE. Zero side-effects on import. Provides quota-aware
helpers used by `edutalk_tools.py /student/edutalk/speak` so that:

  1. Same student replaying the SAME generated EduTalk explanation audio
     does NOT pay again and does NOT trigger Gemini / ElevenLabs again.
  2. A new student still pays normally before access — but if the audio
     is safe-generic (not personalized) the existing R2 cached object is
     reused instead of regenerating with ElevenLabs / Gemini.
  3. Personalized audio (greeting, score-aware, student-name in script)
     is NEVER shared across students — cached only per-student.
  4. R2 / MongoDB growth is controlled via stable cache keys,
     deduplication at the R2 object level (key = content_hash.ext),
     lean metadata, and last_accessed_at tracking for a future cleanup
     janitor.  This module does NOT delete R2 objects automatically.

Collections (new, isolated, additive — no existing collection touched):
  • edutalk_audio_cache         — global cache of generated audio,
                                   keyed by content_hash.
  • edutalk_audio_entitlements  — per-student paid-or-replay entitlement
                                   record; unique (student_id, content_hash).

Hard contract:
  • DOES NOT modify, read, or write any pre-existing EduHub collection
    other than the two NEW ones listed above.
  • DOES NOT call ElevenLabs, Gemini, or any external service directly.
    R2 uploads use the existing _r2_config() credentials via the
    boto3 path already shipped in server.py.
  • Every helper is failure-safe: any error degrades to "no cache" so
    the existing edutalk_tools.py flow keeps working unchanged.
"""
from __future__ import annotations

import asyncio
import base64
import hashlib
import json
import logging
import os
import re
from datetime import datetime, timezone
from typing import Any
from uuid import uuid4

log = logging.getLogger("eduhub.edutalk.audio_cache")

# Collection names — NEW and isolated.
CACHE_COLLECTION = "edutalk_audio_cache"
ENTITLEMENT_COLLECTION = "edutalk_audio_entitlements"

# Hard caps so a malformed reply cannot poison the cache key.
_MAX_HASH_TEXT_CHARS = 3000

# How long to keep the entitlement metadata (informational only — no
# automatic cleanup is performed in this module).
ENTITLEMENT_RETENTION_DAYS_RECOMMENDED = 365

# Cache-eligible age — informational metadata for a future janitor.
CACHE_CLEANUP_ELIGIBLE_AFTER_DAYS_RECOMMENDED = 120

# Mime ↔ extension mapping for R2 object keys.
_EXT_BY_MIME = {
    "audio/mpeg": "mp3",
    "audio/mp3": "mp3",
    "audio/wav": "wav",
    "audio/x-wav": "wav",
    "audio/wave": "wav",
    "audio/webm": "webm",
    "audio/ogg": "ogg",
}


def _iso_now() -> str:
    return datetime.now(timezone.utc).isoformat()


def _ext_for_mime(mime: str) -> str:
    return _EXT_BY_MIME.get((mime or "").lower().split(";")[0].strip(), "mp3")


# --------------------------------------------------------------------------- #
# Hashing — stable cache key                                                  #
# --------------------------------------------------------------------------- #
_WS_RE = re.compile(r"\s+")


def _normalise_text(text: str) -> str:
    """Return a stable, hash-friendly form of `text`.

    * trims to _MAX_HASH_TEXT_CHARS so a runaway reply cannot create a
      hash that depends on noise outside the meaningful payload
    * collapses any whitespace run to a single space
    * lower-cases (so trivial capitalisation drift does not split the
      cache)
    """
    s = (text or "").strip()
    if len(s) > _MAX_HASH_TEXT_CHARS:
        s = s[:_MAX_HASH_TEXT_CHARS]
    s = _WS_RE.sub(" ", s)
    return s.lower()


def compute_content_hash(
    *,
    book_slug: str,
    chapter_idx: int,
    message_index: int,
    reply_text: str,
    audio_support_lang: str,
    voice_id: str,
    is_personalized: bool,
    student_id: str,
) -> str:
    """Return a SHA-256 hex digest that uniquely identifies an audio payload.

    When `is_personalized=True` the student_id is folded into the hash so
    that two students with byte-identical reply text never collide —
    personalized audio is per-student by construction.

    When `is_personalized=False` student_id is NOT in the hash, allowing
    the SAME R2 object to be reused across students (with a per-student
    entitlement record on top).
    """
    payload = {
        "v": 1,
        "book_slug": (book_slug or "").strip().lower(),
        "chapter_idx": int(chapter_idx) if chapter_idx is not None else -1,
        "message_index": int(message_index) if message_index is not None else 0,
        "reply": _normalise_text(reply_text),
        "lang": (audio_support_lang or "").strip().lower(),
        "voice": (voice_id or "").strip().lower(),
    }
    if is_personalized:
        # Personalised audio is hard-bound to one student — never share.
        payload["pers"] = (student_id or "").strip().lower()
    blob = json.dumps(payload, sort_keys=True, ensure_ascii=False).encode("utf-8")
    return hashlib.sha256(blob).hexdigest()


# --------------------------------------------------------------------------- #
# Personalization detection                                                   #
# --------------------------------------------------------------------------- #
_NAME_TOKEN_MIN = 3  # ignore very short names that would false-match


def detect_personalization(
    *,
    message_index: int,
    session: dict | None,
    reply_text: str,
    voice_script: str,
) -> bool:
    """Decide whether the audio about to be generated is personalised.

    Conservative defaults: when in doubt, mark personalised. This keeps
    one student's name / score / feedback from leaking into another
    student's replay even if the safe-generic rule mis-fires.
    """
    # 1) Greeting is always personalised (contains name, points, etc.).
    if int(message_index or 0) == 0:
        return True

    sess = session or {}

    # 2) Score-aware sessions inject monthly scores + teacher notes into
    #    the system instruction. Treat as personalised end-to-end.
    if sess.get("score_aware"):
        return True

    # 3) Student name substring check (case-insensitive). Both visible
    #    reply and voice script are inspected because Gemini may add
    #    "Hi <Name>" in the audio script even when the visible text
    #    does not echo the name.
    name = (sess.get("student_name") or "").strip()
    if len(name) >= _NAME_TOKEN_MIN:
        haystack = f"{reply_text or ''}\n{voice_script or ''}".lower()
        if name.lower() in haystack:
            return True

    # 4) Score-bearing phrases in the script — defensive.
    script_lc = (voice_script or "").lower()
    for needle in ("you scored", "your score", "ពិន្ទុរបស់", "ពិន្ទុរបស់អ្នក"):
        if needle in script_lc:
            return True

    return False


# --------------------------------------------------------------------------- #
# R2 upload — extension-aware variant of server._upload_audio_to_r2.          #
# --------------------------------------------------------------------------- #
def _r2_config() -> dict | None:
    required = (
        "R2_ACCOUNT_ID",
        "R2_ACCESS_KEY_ID",
        "R2_SECRET_ACCESS_KEY",
        "R2_BUCKET_NAME",
        "R2_PUBLIC_URL",
    )
    cfg = {k: os.environ.get(k, "").strip() for k in required}
    if all(cfg.values()):
        return cfg
    return None


async def upload_audio_to_r2(
    *,
    audio_bytes: bytes,
    object_key: str,
    content_type: str,
    metadata: dict | None = None,
) -> str | None:
    """Upload arbitrary audio bytes to R2 under a caller-supplied key.

    Returns the public R2 URL, or None on any failure. Never raises.
    Object key SHOULD be unique enough to be content-addressable
    (caller passes `content_hash.<ext>`).
    """
    cfg = _r2_config()
    if cfg is None:
        return None
    try:
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
                Key=object_key,
                Body=audio_bytes,
                ContentType=content_type or "audio/mpeg",
                Metadata={str(k): str(v) for k, v in (metadata or {}).items()},
            )

        loop = asyncio.get_event_loop()
        await loop.run_in_executor(None, _do_upload)
        url = f"{public_base}/{object_key}"
        log.info(
            "edutalk_audio_cache: r2 upload ok key=%s bytes=%d url=%s",
            object_key, len(audio_bytes), url,
        )
        return url
    except ImportError:
        log.warning("edutalk_audio_cache: boto3 missing — cache disabled.")
        return None
    except Exception as exc:  # noqa: BLE001
        log.warning(
            "edutalk_audio_cache: r2 upload failed key=%s %s: %s",
            object_key, type(exc).__name__, exc,
        )
        return None


async def fetch_audio_b64_from_r2(*, object_key: str) -> str | None:
    """Stream a cached R2 object back as base64 (for the legacy
    `audio_b64` response field).

    Never raises. Returns None when R2 is not configured, the key is
    missing, or boto3 is unavailable.
    """
    cfg = _r2_config()
    if cfg is None:
        return None
    try:
        import boto3  # type: ignore[import-not-found]
        from botocore.config import Config as _BotocoreConfig  # type: ignore[import-not-found]

        endpoint = f"https://{cfg['R2_ACCOUNT_ID']}.r2.cloudflarestorage.com"
        bucket = cfg["R2_BUCKET_NAME"]

        def _do_get() -> bytes:
            s3 = boto3.client(
                "s3",
                endpoint_url=endpoint,
                aws_access_key_id=cfg["R2_ACCESS_KEY_ID"],
                aws_secret_access_key=cfg["R2_SECRET_ACCESS_KEY"],
                region_name="auto",
                config=_BotocoreConfig(signature_version="s3v4"),
            )
            obj = s3.get_object(Bucket=bucket, Key=object_key)
            return obj["Body"].read()

        loop = asyncio.get_event_loop()
        raw = await loop.run_in_executor(None, _do_get)
        return base64.b64encode(raw).decode("ascii")
    except Exception as exc:  # noqa: BLE001
        log.warning(
            "edutalk_audio_cache: r2 fetch failed key=%s %s: %s",
            object_key, type(exc).__name__, exc,
        )
        return None


# --------------------------------------------------------------------------- #
# Mongo helpers                                                               #
# --------------------------------------------------------------------------- #
async def ensure_indexes(db) -> None:
    """Create idempotent indexes used by lookup / list calls.

    Failure-safe: any error is logged and swallowed — the rest of
    EduTalk keeps working without indexes (just slower lookups).
    """
    try:
        cache = db[CACHE_COLLECTION]
        ent = db[ENTITLEMENT_COLLECTION]
        await cache.create_index("content_hash", unique=True, name="ux_content_hash")
        await cache.create_index("last_accessed_at", name="ix_last_accessed")
        await ent.create_index(
            [("student_id", 1), ("content_hash", 1)],
            unique=True, name="ux_student_content",
        )
        await ent.create_index(
            [("student_id", 1), ("book_slug", 1), ("chapter_idx", 1)],
            name="ix_student_book_chapter",
        )
        await ent.create_index("last_accessed_at", name="ix_ent_last_accessed")
    except Exception as exc:  # noqa: BLE001
        log.warning(
            "edutalk_audio_cache: index creation failed (non-fatal): %s", exc,
        )


async def lookup_entitlement(db, *, student_id: str, content_hash: str) -> dict | None:
    """Return the entitlement doc when the student has already paid for
    this audio, else None."""
    try:
        return await db[ENTITLEMENT_COLLECTION].find_one({
            "student_id": student_id,
            "content_hash": content_hash,
        })
    except Exception as exc:  # noqa: BLE001
        log.warning("edutalk_audio_cache: lookup_entitlement failed: %s", exc)
        return None


async def lookup_cache(db, *, content_hash: str) -> dict | None:
    """Return the cache doc for `content_hash`, or None."""
    try:
        return await db[CACHE_COLLECTION].find_one({"content_hash": content_hash})
    except Exception as exc:  # noqa: BLE001
        log.warning("edutalk_audio_cache: lookup_cache failed: %s", exc)
        return None


async def insert_cache(
    db,
    *,
    content_hash: str,
    r2_object_key: str,
    r2_url: str,
    mime_type: str,
    script_text: str,
    is_personalized: bool,
    originator_student_id: str,
    book_slug: str,
    chapter_idx: int,
    audio_support_lang: str,
    voice_id: str,
    size_bytes: int,
) -> None:
    """Insert (or upsert) a global cache row.

    Uses upsert so the rare race where two students generate the same
    safe-generic audio simultaneously cannot produce a duplicate-key
    failure; the second write becomes a no-op.
    """
    try:
        now = _iso_now()
        doc = {
            "content_hash": content_hash,
            "r2_object_key": r2_object_key,
            "r2_url": r2_url,
            "mime_type": mime_type,
            "script_text": (script_text or "")[:2000],
            "is_personalized": bool(is_personalized),
            "originator_student_id": originator_student_id or "",
            "book_slug": book_slug or "",
            "chapter_idx": int(chapter_idx) if chapter_idx is not None else -1,
            "audio_support_lang": audio_support_lang or "",
            "voice_id": voice_id or "",
            "size_bytes": int(size_bytes or 0),
            "created_at": now,
            "last_accessed_at": now,
            "access_count": 1,
            # Future janitor hint — informational only, not enforced
            # in this module. A separate maintenance task may use this
            # to delete `is_personalized=False` rows whose
            # last_accessed_at is older than the recommended window.
            "cleanup_eligible_after_days": (
                CACHE_CLEANUP_ELIGIBLE_AFTER_DAYS_RECOMMENDED
            ),
        }
        await db[CACHE_COLLECTION].update_one(
            {"content_hash": content_hash},
            {"$setOnInsert": doc},
            upsert=True,
        )
    except Exception as exc:  # noqa: BLE001
        log.warning("edutalk_audio_cache: insert_cache failed: %s", exc)


async def grant_entitlement(
    db,
    *,
    student_id: str,
    content_hash: str,
    book_slug: str,
    chapter_idx: int,
    message_index: int,
    paid_points: int,
    session_id: str,
) -> None:
    """Record that `student_id` is entitled to replay `content_hash`.

    Idempotent via upsert on the unique (student_id, content_hash)
    index — a duplicate grant becomes a no-op.
    """
    try:
        now = _iso_now()
        await db[ENTITLEMENT_COLLECTION].update_one(
            {"student_id": student_id, "content_hash": content_hash},
            {
                "$setOnInsert": {
                    "entitlement_id": uuid4().hex,
                    "student_id": student_id,
                    "content_hash": content_hash,
                    "book_slug": book_slug or "",
                    "chapter_idx": int(chapter_idx) if chapter_idx is not None else -1,
                    "message_index": int(message_index or 0),
                    "paid_points": int(paid_points or 0),
                    "session_id": session_id or "",
                    "created_at": now,
                    "access_count": 1,
                    "last_accessed_at": now,
                },
            },
            upsert=True,
        )
    except Exception as exc:  # noqa: BLE001
        log.warning("edutalk_audio_cache: grant_entitlement failed: %s", exc)


async def bump_access(
    db,
    *,
    student_id: str | None,
    content_hash: str,
) -> None:
    """Update last_accessed_at + increment access_count on cache and
    (optionally) on the per-student entitlement.

    Used both on replay and on new-student cache-hit. Failure-safe.
    """
    now = _iso_now()
    try:
        await db[CACHE_COLLECTION].update_one(
            {"content_hash": content_hash},
            {"$set": {"last_accessed_at": now}, "$inc": {"access_count": 1}},
        )
    except Exception as exc:  # noqa: BLE001
        log.debug("edutalk_audio_cache: bump cache access failed: %s", exc)
    if not student_id:
        return
    try:
        await db[ENTITLEMENT_COLLECTION].update_one(
            {"student_id": student_id, "content_hash": content_hash},
            {"$set": {"last_accessed_at": now}, "$inc": {"access_count": 1}},
        )
    except Exception as exc:  # noqa: BLE001
        log.debug("edutalk_audio_cache: bump entitlement access failed: %s", exc)


async def list_session_entitlements(
    db, *, student_id: str, session_id: str,
) -> list[dict]:
    """Return the {message_index, audio_url, mime_type, script_text}
    list for every entitlement this student already holds within the
    given session, so the frontend can seed its replay map at panel
    mount.

    Joins entitlement → cache. Skips any rows whose cache record is
    missing (orphan entitlement after R2 lifecycle delete).
    """
    out: list[dict] = []
    try:
        cursor = db[ENTITLEMENT_COLLECTION].find(
            {"student_id": student_id, "session_id": session_id},
        ).sort("message_index", 1).limit(200)
        async for ent in cursor:
            ch = ent.get("content_hash")
            if not ch:
                continue
            cache = await db[CACHE_COLLECTION].find_one(
                {"content_hash": ch},
                {"r2_url": 1, "mime_type": 1, "script_text": 1, "_id": 0},
            )
            if not cache or not cache.get("r2_url"):
                continue
            out.append({
                "message_index": int(ent.get("message_index") or 0),
                "audio_url": cache["r2_url"],
                "mime_type": cache.get("mime_type") or "audio/mpeg",
                "script_text": cache.get("script_text") or "",
            })
    except Exception as exc:  # noqa: BLE001
        log.warning("edutalk_audio_cache: list_session_entitlements failed: %s", exc)
    return out


# Public helper so edutalk_tools.py can derive ext from mime without
# importing the private _EXT_BY_MIME dict.
def object_key_for(content_hash: str, mime_type: str) -> str:
    """Return the canonical R2 object key: `edutalk/audio/<hash>.<ext>`."""
    return f"edutalk/audio/{content_hash}.{_ext_for_mime(mime_type)}"
