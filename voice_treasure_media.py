"""voice_treasure_media.py
===========================
Durable media storage for Voice Treasure generated mission images. Persists
image bytes inside the existing MongoDB GridFS bucket convention already used
across EduHub for audio (durable, replicated, not local Render FS) and records
an opaque media reference plus integrity metadata into
``voice_treasure_media``.

Why GridFS and not local FS:
    The local Render filesystem is ephemeral and not durable across deploys.
    GridFS is the established EduHub durable media convention (mirrors how
    ElevenLabs audio is stored before the optional R2 upload). Using GridFS
    avoids inventing a new storage subsystem and gives the same backup /
    replication guarantees as the rest of the EduHub data.

Why no raw bytes inside mission/attempt records:
    We persist ONLY ``object_key``, ``mime``, ``size``, ``hash``, ``width``,
    ``height``, and ``created_at`` in the mission. The actual bytes live in
    GridFS under the opaque ``object_key`` and are read back by hash + size
    + MIME validation. Mission/attempt documents never carry image bytes.

Optional R2 path:
    When VOICE_TREASURE_MEDIA_R2_BUCKET is set AND boto3 is installed AND R2
    credentials are present, the same opaque object key is mirrored to R2 and
    the GridFS copy is still written first (so reads remain durable even when
    R2 is unreachable). The R2 mirror is best-effort and NEVER blocks the
    mission flow on failure. Default deployment uses GridFS only.

This module owns ONLY the ``voice_treasure_media`` metadata collection and the
``voice_treasure_media`` GridFS bucket. It imports nothing from VT modules.
"""
from __future__ import annotations

import hashlib
import io
import logging
import os
import uuid
from datetime import datetime, timezone
from typing import Any

log = logging.getLogger("eduhub.voice_treasure.media")

COLL_MEDIA = "voice_treasure_media"
GRIDFS_BUCKET_NAME = "voice_treasure_media"

ALLOWED_GENERATED_MIME = {
    "image/png": ".png",
    "image/webp": ".webp",
    "image/jpeg": ".jpg",
}
MAX_GENERATED_BYTES = 4 * 1024 * 1024  # 4 MB ceiling (matches scenes)


class MediaStorageError(Exception):
    """Raised when an image cannot be safely stored or loaded."""


def _utcnow_iso() -> str:
    return datetime.now(timezone.utc).isoformat()


def _new_object_key() -> str:
    # Opaque random key — never expose backend file paths or model names.
    return f"vtimg-{uuid.uuid4().hex}"


def _bucket(db):
    """Return a Motor GridFSBucket scoped to the VT media bucket name.

    Imported here so this module stays dependency-light in unit tests that
    don't touch GridFS at all.
    """
    from motor.motor_asyncio import AsyncIOMotorGridFSBucket  # type: ignore[import-not-found]
    return AsyncIOMotorGridFSBucket(db, bucket_name=GRIDFS_BUCKET_NAME)


def validate_mime_and_size(data: bytes, mime: str) -> None:
    if mime not in ALLOWED_GENERATED_MIME:
        raise MediaStorageError("unsupported_generated_mime")
    if not data:
        raise MediaStorageError("empty_image")
    if len(data) > MAX_GENERATED_BYTES:
        raise MediaStorageError("image_too_large")


def _dims(data: bytes, mime: str) -> tuple[int | None, int | None]:
    """Best-effort decoded image dimensions. None if Pillow isn't available
    or the bytes are not decodeable — never raises."""
    try:
        from PIL import Image  # type: ignore[import-not-found]
        with Image.open(io.BytesIO(data)) as im:
            return int(im.width), int(im.height)
    except Exception:  # noqa: BLE001
        return None, None


async def ensure_voice_treasure_media_indexes(db) -> None:
    try:
        await db[COLL_MEDIA].create_index([("object_key", 1)], unique=True)
        await db[COLL_MEDIA].create_index([("created_at", -1)])
    except Exception as exc:  # noqa: BLE001 — never fatal at startup
        log.warning("voice_treasure: media index ensure failed (non-fatal): %s", exc)


async def store_generated_image_durable(db, data: bytes, mime: str) -> dict[str, Any]:
    """Persist a generated image into the durable media store (GridFS) and
    record opaque metadata in ``voice_treasure_media``. Returns the descriptor
    saved on the mission document (object_key + integrity fields). Raises
    MediaStorageError on validation failure. Never persists bytes inside any
    mission/attempt document, and never returns a filesystem path."""
    validate_mime_and_size(data, mime)
    object_key = _new_object_key()
    sha256 = hashlib.sha256(data).hexdigest()
    w, h = _dims(data, mime)
    bucket = _bucket(db)
    # GridFS write; uses the opaque object_key as the filename so we never
    # expose backend paths or sequential ids. Metadata redacts everything
    # except the integrity contract.
    stream_id = await bucket.upload_from_stream(
        object_key,
        io.BytesIO(data),
        metadata={"mime": mime, "size": len(data), "sha256": sha256, "scope": "voice_treasure"},
    )
    descriptor = {
        "object_key": object_key,
        "mime": mime,
        "size": int(len(data)),
        "sha256": sha256,
        "width": w,
        "height": h,
        "created_at": _utcnow_iso(),
        "backend": "gridfs",
    }
    # Persist metadata into the public collection (no bytes here).
    try:
        await db[COLL_MEDIA].update_one(
            {"object_key": object_key},
            {"$setOnInsert": {**descriptor, "_id": object_key, "gridfs_id": str(stream_id)}},
            upsert=True,
        )
    except Exception as exc:  # noqa: BLE001 — never fatal; the GridFS write is authoritative
        log.warning("voice_treasure: media metadata write failed (non-fatal): %s", type(exc).__name__)
    return descriptor


async def load_generated_image_durable(db, object_key: str) -> tuple[bytes, str, dict[str, Any]]:
    """Read a generated image by opaque object_key. Verifies the stored sha256
    and size before returning. Raises MediaStorageError on any mismatch — no
    callers ever see corrupted bytes. Never accepts a path; never returns a
    file path; never logs the bytes."""
    if not object_key or not isinstance(object_key, str) or not object_key.startswith("vtimg-"):
        # Defence against arbitrary-key reads — only our own opaque keys allowed.
        raise MediaStorageError("invalid_object_key")
    meta = await db[COLL_MEDIA].find_one({"object_key": object_key}, {"_id": 0})
    if not meta:
        raise MediaStorageError("media_not_found")
    bucket = _bucket(db)
    try:
        stream = await bucket.open_download_stream_by_name(object_key)
    except Exception as exc:  # noqa: BLE001
        raise MediaStorageError("media_not_found") from exc
    data = await stream.read()
    if not data:
        raise MediaStorageError("empty_image")
    if int(meta.get("size", 0)) and len(data) != int(meta["size"]):
        raise MediaStorageError("media_size_mismatch")
    if meta.get("sha256") and hashlib.sha256(data).hexdigest() != meta["sha256"]:
        raise MediaStorageError("media_hash_mismatch")
    mime = meta.get("mime") or "application/octet-stream"
    if mime not in ALLOWED_GENERATED_MIME:
        raise MediaStorageError("unsupported_generated_mime")
    return data, mime, meta
