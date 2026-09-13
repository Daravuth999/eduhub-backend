"""r2_object_store.py — shared Cloudflare R2 upload/dedup/delete helper.

DELIBERATE DEVIATION from this codebase's own R2-client-per-module
isolation convention (documented in sync_studio_tools.py's
`_upload_media_to_r2` docstring, and independently duplicated again in
assessment_tools.py): those modules each hand-roll an identical
content-hash-dedup HEAD-then-PUT upload function, on the stated
rationale that no module should import another's R2 client. For the
messaging feature (in-app-messaging round), the product owner
explicitly asked for this specific technique to be extracted into a
genuinely shared module rather than copy-pasted a third time — see the
messaging feature's own audit report for that instruction.

This module does NOT touch or import from sync_studio_tools.py /
assessment_tools.py — neither existing per-module copy is modified or
migrated to call this. It exists purely as new, shared infrastructure
for NEW callers (messaging_tools.py's voice/image attachments today);
existing callers keep their own proven, independently-tested
implementations exactly as they are. A future consolidation of the
older copies onto this module is a separate, deliberate decision this
change does not make unilaterally.

Same technique as the existing per-module copies:
  * upload key is content-addressed (sha256 of the raw bytes) so two
    uploads of identical bytes collapse to one stored object;
  * HEAD-before-PUT — skips the actual PUT when that exact content is
    already stored;
  * never raises — returns None on any failure (env vars absent,
    boto3 missing, network error), matching every existing R2 call
    site's graceful-degradation contract.

Load-shape note (explicitly requested verification, not assumed): the
existing per-module implementations were proven for large, occasional,
single-admin uploads (native audio/video masters, one file at a time).
Messaging's real load shape is different — many SMALL, POTENTIALLY
CONCURRENT uploads (voice notes), from students on classroom Wi-Fi that
may be weak/high-latency. This module does not add any new concurrency
coordination beyond what the existing pattern already has
(`loop.run_in_executor` offloads the blocking boto3 call, permitting
concurrent async invocations with no added lock/semaphore) — the
content-addressed HEAD-then-PUT sequence is safe under concurrency
for the SAME reason it already is in the existing copies (idempotent
by content hash; two concurrent uploads of the same bytes either both
skip via HEAD or one wins the PUT race harmlessly, since S3-compatible
PUT of identical content to the same key is not corrupting). What this
module does NOT solve, and no existing R2 code in this repo solves
either: a genuinely flaky classroom connection dropping mid-upload.
`upload_bytes` is one HTTP request done from a `run_in_executor`
thread — a dropped connection surfaces as a boto3 exception, caught
here, returning None (graceful "upload failed" to the caller), which
the caller must surface as a real, honest "voice message failed to
send" state (never silently drop it, never fabricate success). No load
testing against real weak-connection conditions was performed or is
possible in this environment — this is a documented limitation, not a
verified guarantee.
"""
from __future__ import annotations

import asyncio
import hashlib
import logging
import os

logger = logging.getLogger("eduhub.r2_object_store")


def r2_config() -> dict | None:
    """Same required-env-vars contract as sync_studio_tools.py's
    `_r2_config` / assessment_tools.py's equivalent — returns None
    (never raises) when R2 isn't configured, so a caller can fall back
    or fail the individual request honestly."""
    required = ["R2_ACCOUNT_ID", "R2_ACCESS_KEY_ID", "R2_SECRET_ACCESS_KEY", "R2_BUCKET_NAME", "R2_PUBLIC_URL"]
    cfg = {k: os.environ.get(k, "").strip() for k in required}
    return cfg if all(cfg.values()) else None


def _r2_client(cfg: dict, endpoint: str):
    import boto3
    from botocore.config import Config as _BotocoreConfig

    return boto3.client(
        "s3", endpoint_url=endpoint,
        aws_access_key_id=cfg["R2_ACCESS_KEY_ID"],
        aws_secret_access_key=cfg["R2_SECRET_ACCESS_KEY"],
        region_name="auto",
        config=_BotocoreConfig(signature_version="s3v4"),
    )


def content_hash_key(raw: bytes, *, prefix: str, ext: str) -> str:
    """`{prefix}/{sha256}.{ext}` — the same content-addressing scheme
    sync_studio_tools.py uses for its own uploads. `ext` should not
    include the leading dot."""
    digest = hashlib.sha256(raw).hexdigest()
    ext = (ext or "").lstrip(".")
    return f"{prefix.strip('/')}/{digest}.{ext}" if ext else f"{prefix.strip('/')}/{digest}"


async def upload_bytes(
    raw: bytes, key: str, content_type: str, metadata: dict | None = None,
    *, endpoint_override: str | None = None,
) -> str | None:
    """Upload `raw` to R2 at the content-addressed `key`. Returns the
    public URL on success (including the "already stored" case), None
    on any failure or when R2 isn't configured. NEVER raises.

    `endpoint_override` exists only for tests, exactly like the
    existing per-module copies — no production call site sets it."""
    cfg = r2_config()
    if cfg is None:
        return None
    try:
        from botocore.exceptions import ClientError

        endpoint = endpoint_override or f"https://{cfg['R2_ACCOUNT_ID']}.r2.cloudflarestorage.com"

        def _do_upload() -> bool:
            s3 = _r2_client(cfg, endpoint)
            try:
                s3.head_object(Bucket=cfg["R2_BUCKET_NAME"], Key=key)
                return True  # content-addressed object already stored — nothing to do
            except ClientError as exc:
                code = str((exc.response or {}).get("Error", {}).get("Code") or "")
                if code not in ("404", "NoSuchKey", "NotFound"):
                    raise
            s3.put_object(
                Bucket=cfg["R2_BUCKET_NAME"], Key=key, Body=raw, ContentType=content_type,
                Metadata={str(k): str(v) for k, v in (metadata or {}).items()},
            )
            return False

        loop = asyncio.get_event_loop()
        already_existed = await loop.run_in_executor(None, _do_upload)
        url = f"{cfg['R2_PUBLIC_URL'].rstrip('/')}/{key}"
        if already_existed:
            logger.info("r2_object_store: content-addressed object already exists, skipped upload key=%s", key)
        else:
            logger.info("r2_object_store: uploaded %s (%d bytes) url=%s", key, len(raw), url)
        return url
    except Exception:  # noqa: BLE001
        logger.exception("r2_object_store: upload failed for key=%s", key)
        return None


async def delete_object(key: str) -> bool:
    """Best-effort delete of a stored object by key. Returns True on
    confirmed deletion (including "already gone"), False when R2 isn't
    configured or the delete genuinely failed. NEVER raises — matches
    every existing R2 delete call site's contract (sync_studio_tools.py's
    `delete_media_object`)."""
    cfg = r2_config()
    if cfg is None:
        return False
    try:
        endpoint = f"https://{cfg['R2_ACCOUNT_ID']}.r2.cloudflarestorage.com"

        def _do_delete() -> None:
            s3 = _r2_client(cfg, endpoint)
            s3.delete_object(Bucket=cfg["R2_BUCKET_NAME"], Key=key)

        loop = asyncio.get_event_loop()
        await loop.run_in_executor(None, _do_delete)
        return True
    except Exception:  # noqa: BLE001
        logger.exception("r2_object_store: delete failed for key=%s", key)
        return False
