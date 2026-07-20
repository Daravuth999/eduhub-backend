"""hero_artwork_tools.py — Hero Artwork upload + media library (Welcome
Experience Studio enhancement).

ISOLATED & ADDITIVE. Bolts onto the existing FastAPI app the same way every
other Author Studio module does (artwork_campaign_tools.py, book_factory_image.py):
one new file, `register_hero_artwork_routes(api, db, require_admin)` called
once from server.py inside a try/except.

WHAT THIS IS
────────────
A real file-upload + object-storage path for Hero Artwork — distinct from
the Artwork Campaign system (which is link-based: admins paste a URL to an
externally-hosted image for the full-width carousel below the Hero). Hero
Artwork composites INSIDE the Hero itself, so it needs actual admin-uploaded
transparent PNG/WebP/SVG assets, not a pasted link.

Reuses the SAME Cloudflare R2 storage pattern as book_factory_image.py and
ai_assistant_voice_tools.py — the same 5 env vars
(R2_ACCOUNT_ID/R2_ACCESS_KEY_ID/R2_SECRET_ACCESS_KEY/R2_BUCKET_NAME/
R2_PUBLIC_URL), same boto3 S3-compatible client shape — under an isolated
`hero-artwork/` key prefix. No new storage infrastructure introduced.

STORAGE
───────
Collection ``hero_artwork_assets`` (the "Media Library"):
  id            uuid hex (same convention as artwork_campaign_tools.py)
  url           public R2 URL
  contentType   image/png | image/webp | image/svg+xml | image/jpeg
  width/height  parsed from the file; null if parsing failed (informational
                only — the frontend must not depend on these being present)
  sizeBytes     original upload size
  uploadedBy    admin email
  uploadedAt    datetime

The experience_configs `appearance.heroArtwork` sub-object (written by the
existing generic PUT /experience-configs/{id} — no route change needed
here, `appearance` is already a free-form dict) references an asset by
`assetId` + denormalized `url` for fast render without a second fetch:
  { assetId, url, placement, customX, customY, scale, padding:
    {top,bottom,left,right}, layerOrder, allowOverflow, version }
`version` is bumped by the caller (WelcomeExperienceStudio) whenever the
asset actually changes — it's what the frontend's artwork cache uses to
decide whether to re-fetch/re-cache the image (see swrCache.js /
heroArtworkCache.js on the frontend), never generated here.

ROUTES (all `/api`-prefixed, all require_admin):
  POST   /hero-artwork/upload         multipart upload -> stores + returns asset
  GET    /hero-artwork/library        list assets, most recent first
  DELETE /hero-artwork/library/{id}   remove from R2 + the media library

Deleting a library asset does NOT touch any experience_configs document
that references it (same no-reference-checking convention as
artwork_campaign_tools.py's delete) — an admin who removes an asset that's
still referenced by a published Hero simply gets a broken image until they
pick a new one; this module does not attempt to guard against that.
"""
from __future__ import annotations

import logging
import re
import struct
import uuid
from datetime import datetime, timezone
from typing import Optional

from fastapi import Depends, HTTPException, UploadFile, File

log = logging.getLogger("eduhub.hero_artwork")

HARD_MAX_IMAGE_BYTES: int = 8 * 1024 * 1024  # 8 MB, matches book_factory_image.py

ALLOWED_CONTENT_TYPES = {
    "image/png": "png",
    "image/webp": "webp",
    "image/svg+xml": "svg",
    "image/jpeg": "jpg",
}


# ── validation ──────────────────────────────────────────────────────────────
def _sniff_ext(image_bytes: bytes, declared_content_type: str) -> str:
    """Magic-byte sniff for raster formats; SVG is XML text so it's detected
    by content instead. Raises HTTPException(400) on an unrecognized file —
    never trusts the client-declared Content-Type alone."""
    if image_bytes[:8] == b"\x89PNG\r\n\x1a\n":
        return "png"
    if image_bytes[:2] == b"\xff\xd8":
        return "jpg"
    if image_bytes[:4] == b"RIFF" and image_bytes[8:12] == b"WEBP":
        return "webp"
    head = image_bytes[:512].lstrip().lower()
    if head.startswith(b"<?xml") or head.startswith(b"<svg"):
        if b"<svg" in head:
            return "svg"
    raise HTTPException(
        status_code=400,
        detail=f"Unrecognized image format (declared {declared_content_type!r}). "
                "Supported: PNG, WebP, SVG, JPEG.",
    )


_EXT_TO_CONTENT_TYPE = {v: k for k, v in ALLOWED_CONTENT_TYPES.items()}


def _validate_image_bytes(image_bytes: bytes, declared_content_type: str) -> tuple[str, str]:
    """Returns (ext, canonical_content_type). Raises HTTPException(400) on
    any invalid input — empty, oversized, or unrecognized format."""
    if not image_bytes:
        raise HTTPException(status_code=400, detail="Uploaded file is empty.")
    if len(image_bytes) > HARD_MAX_IMAGE_BYTES:
        raise HTTPException(
            status_code=400,
            detail=f"File exceeds the {HARD_MAX_IMAGE_BYTES // (1024*1024)} MB limit.",
        )
    ext = _sniff_ext(image_bytes, declared_content_type)
    return ext, _EXT_TO_CONTENT_TYPE[ext]


# ── dimension parsing (best-effort — informational only, never blocks upload) ─
def _png_dimensions(b: bytes) -> Optional[tuple[int, int]]:
    try:
        if len(b) >= 24 and b[12:16] == b"IHDR":
            w, h = struct.unpack(">II", b[16:24])
            return (w, h)
    except Exception:  # noqa: BLE001
        pass
    return None


def _jpeg_dimensions(b: bytes) -> Optional[tuple[int, int]]:
    try:
        i = 2
        n = len(b)
        while i < n - 9:
            if b[i] != 0xFF:
                i += 1
                continue
            marker = b[i + 1]
            if marker in (0xC0, 0xC1, 0xC2, 0xC3, 0xC5, 0xC6, 0xC7,
                          0xC9, 0xCA, 0xCB, 0xCD, 0xCE, 0xCF):
                h, w = struct.unpack(">HH", b[i + 5:i + 9])
                return (w, h)
            if marker in (0xD8, 0x01) or 0xD0 <= marker <= 0xD7:
                i += 2
                continue
            seg_len = struct.unpack(">H", b[i + 2:i + 4])[0]
            i += 2 + seg_len
    except Exception:  # noqa: BLE001
        pass
    return None


def _webp_dimensions(b: bytes) -> Optional[tuple[int, int]]:
    try:
        if len(b) < 30 or b[:4] != b"RIFF" or b[8:12] != b"WEBP":
            return None
        chunk = b[12:16]
        if chunk == b"VP8X":
            w = 1 + (b[24] | (b[25] << 8) | (b[26] << 16))
            h = 1 + (b[27] | (b[28] << 8) | (b[29] << 16))
            return (w, h)
        if chunk == b"VP8L":
            bits = struct.unpack("<I", b[21:25])[0]
            w = 1 + (bits & 0x3FFF)
            h = 1 + ((bits >> 14) & 0x3FFF)
            return (w, h)
        if chunk == b"VP8 ":
            w = struct.unpack("<H", b[26:28])[0] & 0x3FFF
            h = struct.unpack("<H", b[28:30])[0] & 0x3FFF
            return (w, h)
    except Exception:  # noqa: BLE001
        pass
    return None


def _svg_dimensions(b: bytes) -> Optional[tuple[int, int]]:
    try:
        text = b[:2048].decode("utf-8", errors="ignore")
        w_m = re.search(r'width="([\d.]+)', text)
        h_m = re.search(r'height="([\d.]+)', text)
        if w_m and h_m:
            return (int(float(w_m.group(1))), int(float(h_m.group(1))))
        vb_m = re.search(r'viewBox="[\d.\-]+\s+[\d.\-]+\s+([\d.]+)\s+([\d.]+)"', text)
        if vb_m:
            return (int(float(vb_m.group(1))), int(float(vb_m.group(2))))
    except Exception:  # noqa: BLE001
        pass
    return None


def _parse_dimensions(ext: str, image_bytes: bytes) -> Optional[tuple[int, int]]:
    return {
        "png": _png_dimensions,
        "jpg": _jpeg_dimensions,
        "webp": _webp_dimensions,
        "svg": _svg_dimensions,
    }.get(ext, lambda _b: None)(image_bytes)


# ── R2 storage (isolated `hero-artwork/` prefix) ────────────────────────────
def _r2_config() -> Optional[dict]:
    import os
    required = ["R2_ACCOUNT_ID", "R2_ACCESS_KEY_ID", "R2_SECRET_ACCESS_KEY",
                "R2_BUCKET_NAME", "R2_PUBLIC_URL"]
    cfg = {k: os.environ.get(k, "").strip() for k in required}
    return cfg if all(cfg.values()) else None


def storage_configured() -> bool:
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


async def _upload_to_r2(image_bytes: bytes, key: str, content_type: str, metadata: dict) -> str:
    cfg = _r2_config()
    if cfg is None:
        raise HTTPException(
            status_code=503,
            detail="Artwork storage is not configured on the server (R2 env vars missing).",
        )
    try:
        import asyncio as _asyncio

        def _do_upload():
            s3 = _s3_client(cfg)
            s3.put_object(
                Bucket=cfg["R2_BUCKET_NAME"],
                Key=key,
                Body=image_bytes,
                ContentType=content_type,
                Metadata={str(k): str(v) for k, v in (metadata or {}).items()},
            )

        loop = _asyncio.get_event_loop()
        await loop.run_in_executor(None, _do_upload)
        url = f"{cfg['R2_PUBLIC_URL'].rstrip('/')}/{key}"
        log.info("hero_artwork: uploaded %s (%d bytes) url=%s", key, len(image_bytes), url)
        return url
    except HTTPException:
        raise
    except ImportError as exc:
        raise HTTPException(status_code=503, detail=f"boto3 not installed: {exc}") from exc
    except Exception as exc:  # noqa: BLE001
        raise HTTPException(
            status_code=502, detail=f"Artwork upload failed: {type(exc).__name__}: {exc}",
        ) from exc


async def _delete_from_r2(key: str) -> None:
    cfg = _r2_config()
    if cfg is None:
        return
    try:
        import asyncio as _asyncio

        def _do_delete():
            s3 = _s3_client(cfg)
            s3.delete_object(Bucket=cfg["R2_BUCKET_NAME"], Key=key)

        loop = _asyncio.get_event_loop()
        await loop.run_in_executor(None, _do_delete)
    except Exception as exc:  # noqa: BLE001 — best-effort; the library entry is still removed
        log.warning("hero_artwork: R2 delete failed for key=%s: %s", key, exc)


def _serialize(doc: dict) -> dict:
    return {
        "id": doc.get("id", ""),
        "url": doc.get("url", ""),
        "contentType": doc.get("contentType", ""),
        "width": doc.get("width"),
        "height": doc.get("height"),
        "sizeBytes": doc.get("sizeBytes", 0),
        "uploadedBy": doc.get("uploadedBy", ""),
        "uploadedAt": doc.get("uploadedAt").isoformat() if isinstance(doc.get("uploadedAt"), datetime) else doc.get("uploadedAt"),
    }


def register_hero_artwork_routes(api, db, require_admin) -> None:
    coll = db.hero_artwork_assets

    @api.post("/hero-artwork/upload")
    async def upload_hero_artwork(file: UploadFile = File(...), admin=Depends(require_admin)):
        raw = await file.read()
        ext, content_type = _validate_image_bytes(raw, file.content_type or "")
        dims = _parse_dimensions(ext, raw)

        asset_id = uuid.uuid4().hex
        key = f"hero-artwork/{asset_id}.{ext}"
        url = await _upload_to_r2(
            raw, key, content_type,
            {"assetId": asset_id, "uploadedBy": getattr(admin, "email", "admin")},
        )

        now = datetime.now(timezone.utc)
        doc = {
            "id": asset_id,
            "url": url,
            "r2Key": key,
            "contentType": content_type,
            "width": dims[0] if dims else None,
            "height": dims[1] if dims else None,
            "sizeBytes": len(raw),
            "uploadedBy": getattr(admin, "email", "admin"),
            "uploadedAt": now,
        }
        await coll.insert_one(dict(doc))
        log.info("hero_artwork: library asset %s created by %s", asset_id, doc["uploadedBy"])
        return {"ok": True, "asset": _serialize(doc)}

    @api.get("/hero-artwork/library")
    async def list_hero_artwork(admin=Depends(require_admin)):
        cursor = coll.find({}, {"_id": 0}).sort([("uploadedAt", -1)])
        items = await cursor.to_list(length=200)
        return {"ok": True, "assets": [_serialize(d) for d in items]}

    @api.delete("/hero-artwork/library/{asset_id}")
    async def delete_hero_artwork(asset_id: str, admin=Depends(require_admin)):
        doc = await coll.find_one({"id": asset_id})
        if not doc:
            raise HTTPException(status_code=404, detail="Artwork asset not found.")
        r2_key = doc.get("r2Key")
        if r2_key:
            await _delete_from_r2(r2_key)
        await coll.delete_one({"id": asset_id})
        log.info("hero_artwork: library asset %s deleted by %s", asset_id, getattr(admin, "email", "?"))
        return {"ok": True}

    log.info("hero_artwork_tools: routes registered (upload/library, storage_configured=%s)", storage_configured())
