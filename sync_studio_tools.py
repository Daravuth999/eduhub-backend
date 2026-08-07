"""sync_studio_tools.py — Universal Synchronization Engine, Mongo-backed
routes (Phase 0 foundation + native media upload).

Implements the storage strategy and API contracts from
docs/proposals/universal-synchronization-engine-technical-spec.md §9/§10 in
the frontend repo. Collection: `chapter_sync`, owned exclusively by this
module (registered in tools/check_collection_ownership.py's
OWNED_COLLECTIONS) — primary-keyed by `syncId` per the schema's Media
Independence principle (spec §4): a sync document's identity is the media
asset, not a book/chapter. `slug`/`chapterIndex`/`blockIndex` on the stored
Mongo document are a STORAGE-LAYER convenience binding (secondary index for
"what does this chapter currently point to") — they are NOT part of the
canonical schema itself (sync_schema.py never mentions a book or chapter).

Two ways a sync document is created, both implemented here:
  1. `create_sync_from_chapter_block` — backfills from ALREADY-GENERATED
     ElevenLabs `wordTimestamps` (the "thin adapter at read time" spec §11
     describes). No new provider call.
  2. `create_sync_from_upload` — a NATIVE audio/video upload from an admin.
     Stores the real media (R2-first, GridFS-fallback, same
     graceful-degradation discipline as server.py's `_upload_audio_to_r2` —
     never hero_artwork_tools.py's R2-or-nothing pattern, which this
     project's own architecture study flags as a real risk for new media
     types) and creates a sync document with `alignmentStatus:
     "awaiting_provider"`. NO Speech Recognition/Alignment provider is
     called here — that vendor is deliberately not yet chosen (tech spec
     §12); this is honest, complete infrastructure work that does not wait
     on that decision, per the explicit "continue provider-neutral
     implementation" instruction it was built under.

Review-workflow scope, deliberately: `reviewStatus` transitions and speaker
relabeling are implemented and tested. Transcript-text editing with
nearest-neighbor word-boundary re-keying (spec §5) is NOT implemented in
this pass — it is real Review Studio UI/algorithm work for a follow-up
commit, not something to fake here. `editedTranscript` in the review
payload is accepted and stored as a pending note only.

IMPORTANT (Python 3.14 FastAPI multipart fix): `UploadFile`/`File`/`Form`
are imported at MODULE level below, not inside `register_sync_studio_
routes`. A prior incident in this codebase confirmed that importing them
lazily inside a sibling module's registration function causes a per-request
500 under Python 3.14's stricter ForwardRef resolution — hero_artwork_
tools.py (this repo's only other multipart-upload sibling module) already
established the module-level-import fix; this module follows the same
pattern.
"""
from __future__ import annotations

import asyncio
import datetime as _dt
import io
import logging
import os
import re
import uuid

from fastapi import Body, Depends, File, Form, HTTPException, Request, UploadFile
from fastapi.responses import Response, StreamingResponse
from motor.motor_asyncio import AsyncIOMotorGridFSBucket

from sync_provider import reshape_elevenlabs_word_timestamps
from sync_schema import (
    VALID_REVIEW_STATUSES,
    build_paragraph,
    build_sync_document,
    is_servable_to_students,
    validate_sync_document,
)

logger = logging.getLogger("eduhub.sync_studio")

CHAPTER_SYNC_COLL = "chapter_sync"
MEDIA_GRIDFS_BUCKET = "sync_media"

# reviewStatus transition graph (spec §5): pending -> in_review -> approved |
# rejected; rejected -> in_review allows a re-submit loop after a provider
# re-run. approved is terminal via this endpoint (no un-approve here).
_ALLOWED_TRANSITIONS: dict[str, set[str]] = {
    "pending": {"in_review"},
    "in_review": {"approved", "rejected"},
    "rejected": {"in_review"},
    "approved": set(),
}

# Native upload — capability whitelist (audio + video). No image types:
# cover art already has its own path (coverImage/Book Factory image stage).
ALLOWED_MEDIA_CONTENT_TYPES: dict[str, str] = {
    "audio/mpeg": "mp3",
    "audio/mp3": "mp3",
    "audio/wav": "wav",
    "audio/x-wav": "wav",
    "audio/mp4": "m4a",
    "audio/x-m4a": "m4a",
    "video/mp4": "mp4",
    "video/webm": "webm",
    "video/quicktime": "mov",
}
HARD_MAX_MEDIA_BYTES = 300 * 1024 * 1024  # 300 MB — generous for a chapter-length video

_RANGE_RE = re.compile(r"^\s*bytes=(\d*)-(\d*)\s*$", re.IGNORECASE)


class SyncStudioError(Exception):
    def __init__(self, code: str, message: str = "", http_status: int = 400) -> None:
        super().__init__(message or code)
        self.code = code
        self.message = message or code
        self.http_status = http_status


async def ensure_sync_studio_indexes(db) -> None:
    await db[CHAPTER_SYNC_COLL].create_index("syncId", unique=True)
    await db[CHAPTER_SYNC_COLL].create_index([("slug", 1), ("chapterIndex", 1)])
    logger.info("sync_studio_tools: indexes ready")


async def create_sync_from_chapter_block(
    db, *, slug: str, chapter_index: int, block_index: int, get_book_by_slug,
) -> dict:
    """Backfill a canonical sync document from an ALREADY-GENERATED
    ElevenLabs `transcript` block's `wordTimestamps` — no new provider call,
    no new vendor. Raises SyncStudioError on any not-found/invalid input."""
    book = await get_book_by_slug(slug)
    if not book:
        raise SyncStudioError("book_not_found", f"no book for slug={slug!r}", 404)

    chapters = book.get("chapters") or []
    if not (0 <= chapter_index < len(chapters)):
        raise SyncStudioError("chapter_not_found", f"chapterIndex {chapter_index} out of range", 404)

    blocks = (chapters[chapter_index] or {}).get("blocks") or []
    if not (0 <= block_index < len(blocks)):
        raise SyncStudioError("block_not_found", f"blockIndex {block_index} out of range", 404)

    block = blocks[block_index] or {}
    word_timestamps = block.get("wordTimestamps")
    if not word_timestamps:
        raise SyncStudioError(
            "no_word_timestamps",
            "this block has no existing wordTimestamps to adapt — run ElevenLabs "
            "narration for this chapter first (Book Factory / Studio narration flow)",
            400,
        )

    doc = reshape_elevenlabs_word_timestamps(word_timestamps)
    doc["mediaRef"] = block.get("audioUrl") or ""
    doc["slug"] = slug
    doc["chapterIndex"] = chapter_index
    doc["blockIndex"] = block_index

    ok, errors = validate_sync_document(doc)
    if not ok:
        # Would indicate a bug in reshape_elevenlabs_word_timestamps itself,
        # not bad input — surfaced loudly rather than silently stored.
        raise SyncStudioError("invalid_sync_document", "; ".join(errors), 500)

    await db[CHAPTER_SYNC_COLL].insert_one(dict(doc))
    doc.pop("_id", None)
    return doc


def _r2_config() -> dict | None:
    required = ["R2_ACCOUNT_ID", "R2_ACCESS_KEY_ID", "R2_SECRET_ACCESS_KEY", "R2_BUCKET_NAME", "R2_PUBLIC_URL"]
    cfg = {k: os.environ.get(k, "").strip() for k in required}
    return cfg if all(cfg.values()) else None


async def _upload_media_to_r2(raw: bytes, key: str, content_type: str, metadata: dict) -> str | None:
    """R2 upload for native media uploads. NEVER raises — returns None on
    any failure (env vars absent, boto3 missing, network error) so the
    caller falls back to GridFS transparently, matching server.py's own
    `_upload_audio_to_r2` graceful-degradation pattern. Deliberately NOT
    hero_artwork_tools.py's R2-or-nothing pattern — this project's own
    architecture study (§8, Risks) flags that pattern as a real failure
    mode for a future media pipeline without a GridFS-style fallback."""
    cfg = _r2_config()
    if cfg is None:
        return None
    try:
        import boto3
        from botocore.config import Config as _BotocoreConfig

        endpoint = f"https://{cfg['R2_ACCOUNT_ID']}.r2.cloudflarestorage.com"

        def _do_upload():
            s3 = boto3.client(
                "s3", endpoint_url=endpoint,
                aws_access_key_id=cfg["R2_ACCESS_KEY_ID"],
                aws_secret_access_key=cfg["R2_SECRET_ACCESS_KEY"],
                region_name="auto",
                config=_BotocoreConfig(signature_version="s3v4"),
            )
            s3.put_object(
                Bucket=cfg["R2_BUCKET_NAME"], Key=key, Body=raw, ContentType=content_type,
                Metadata={str(k): str(v) for k, v in (metadata or {}).items()},
            )

        loop = asyncio.get_event_loop()
        await loop.run_in_executor(None, _do_upload)
        url = f"{cfg['R2_PUBLIC_URL'].rstrip('/')}/{key}"
        logger.info("sync_studio_tools: uploaded %s (%d bytes) url=%s", key, len(raw), url)
        return url
    except Exception as exc:  # noqa: BLE001
        logger.warning("sync_studio_tools: R2 upload failed for key=%s (%s) — falling back to GridFS", key, exc)
        return None


def _validate_media_upload(raw: bytes, declared_content_type: str) -> tuple[str, str]:
    content_type = (declared_content_type or "").split(";")[0].strip().lower()
    ext = ALLOWED_MEDIA_CONTENT_TYPES.get(content_type)
    if not ext:
        raise SyncStudioError(
            "unsupported_media_type",
            f"unsupported content type: {declared_content_type!r}. "
            f"Allowed: {sorted(set(ALLOWED_MEDIA_CONTENT_TYPES))}",
            415,
        )
    if not raw:
        raise SyncStudioError("empty_file", "uploaded file is empty", 400)
    if len(raw) > HARD_MAX_MEDIA_BYTES:
        raise SyncStudioError(
            "file_too_large",
            f"file is {len(raw)} bytes, exceeds the {HARD_MAX_MEDIA_BYTES}-byte limit",
            413,
        )
    return ext, content_type


async def create_sync_from_upload(
    db, *, raw: bytes, declared_content_type: str, media_bucket,
    slug: str | None = None, chapter_index: int | None = None,
    owner_ref: str | None = None, uploaded_by: str = "",
) -> dict:
    """Native media upload — accepts audio OR video identically (tech spec's
    "treat audio and video the same post-ingestion" principle), stores it,
    and creates a sync document with `alignmentStatus: "awaiting_provider"`.
    No Speech Recognition/Alignment provider is called here. This is a
    complete, real, useful unit on its own: the media is genuinely stored
    and referenced; only transcription/alignment is deferred, honestly.

    `slug`/`chapter_index` are the Books-specific binding (optional — Media
    Independence, spec §4: a sync document's identity is the media asset,
    not any particular owner). `owner_ref` is a free-form alternative
    binding string for non-Books callers (e.g. Video Library passes
    `f"video_lesson:{lesson_id}"`) so OTHER products can reuse this exact
    storage/schema path without this module knowing anything about videos —
    it only ever stores whatever reference string the caller gives it."""
    ext, content_type = _validate_media_upload(raw, declared_content_type)

    media_id = uuid.uuid4().hex
    path_hint = owner_ref or (f"{slug}/{chapter_index}" if slug is not None else "unbound")
    key = f"sync-media/{path_hint}/{media_id}.{ext}"
    metadata = {"uploadedBy": uploaded_by}
    if slug is not None:
        metadata["slug"] = slug
        metadata["chapterIndex"] = str(chapter_index)
    if owner_ref:
        metadata["ownerRef"] = owner_ref

    media_ref = await _upload_media_to_r2(raw, key, content_type, metadata)
    if not media_ref:
        filename = f"{media_id}.{ext}"
        try:
            await media_bucket.upload_from_stream(
                filename, io.BytesIO(raw),
                metadata={**metadata, "contentType": content_type},
            )
        except Exception as exc:  # noqa: BLE001
            raise SyncStudioError(
                "storage_failed", f"failed to store media: {type(exc).__name__}: {exc}", 500,
            ) from exc
        media_ref = f"gridfs://{MEDIA_GRIDFS_BUCKET}/{filename}"

    doc = build_sync_document(
        media_ref=media_ref,
        provider_category="manual",
        provider_version="native-upload",
        paragraphs=[build_paragraph("p1", [])],
        generated_at=_dt.datetime.now(_dt.timezone.utc).strftime("%Y-%m-%dT%H:%M:%SZ"),
        duration_sec=0.0,
        alignment_status="awaiting_provider",
    )
    if slug is not None:
        doc["slug"] = slug
        doc["chapterIndex"] = chapter_index
    if owner_ref:
        doc["ownerRef"] = owner_ref
    doc["contentType"] = content_type

    ok, errors = validate_sync_document(doc)
    if not ok:
        raise SyncStudioError("invalid_sync_document", "; ".join(errors), 500)

    await db[CHAPTER_SYNC_COLL].insert_one(dict(doc))
    doc.pop("_id", None)
    return doc


async def stream_sync_media(media_bucket, filename: str, request: Request):
    """GridFS streaming with real Range support, generalizing server.py's
    proven `studio_audio_stream` fix (2026-05, iOS Safari scrubbing) to
    read the actual content-type from upload-time metadata instead of
    hardcoding audio/mpeg — this bucket also carries video. R2-stored media
    needs no equivalent route: Cloudflare serves those URLs (and their own
    Range support) directly."""
    try:
        gridout = await media_bucket.open_download_stream_by_name(filename)
    except Exception:
        raise HTTPException(status_code=404, detail="Media not found.")

    content_type = (gridout.metadata or {}).get("contentType", "application/octet-stream")
    total_size = int(getattr(gridout, "length", 0) or 0)
    range_header = request.headers.get("range") or request.headers.get("Range")

    async def _range_iter(start: int, end: int):
        try:
            await gridout.seek(start)
        except Exception:
            try:
                gridout.seek(start)
            except Exception:
                pass
        remaining = end - start + 1
        chunk_size = 64 * 1024
        while remaining > 0:
            data = await gridout.read(min(chunk_size, remaining))
            if not data:
                break
            yield data
            remaining -= len(data)

    if not range_header or total_size <= 0:
        async def _full_iter():
            chunk_size = 64 * 1024
            while True:
                data = await gridout.read(chunk_size)
                if not data:
                    break
                yield data

        headers = {"Cache-Control": "public, max-age=31536000, immutable", "Accept-Ranges": "bytes"}
        if total_size > 0:
            headers["Content-Length"] = str(total_size)
        return StreamingResponse(_full_iter(), media_type=content_type, headers=headers)

    m = _RANGE_RE.match(range_header)
    if not m:
        return StreamingResponse(
            _range_iter(0, total_size - 1), media_type=content_type,
            headers={
                "Cache-Control": "public, max-age=31536000, immutable",
                "Accept-Ranges": "bytes", "Content-Length": str(total_size),
            },
        )

    start_s, end_s = m.group(1), m.group(2)
    if start_s == "" and end_s == "":
        return Response(status_code=416, headers={"Content-Range": f"bytes */{total_size}"})
    if start_s == "":
        suffix = int(end_s)
        if suffix <= 0:
            return Response(status_code=416, headers={"Content-Range": f"bytes */{total_size}"})
        start = max(0, total_size - suffix)
        end = total_size - 1
    else:
        start = int(start_s)
        end = int(end_s) if end_s else total_size - 1
    if start >= total_size or start < 0 or end < start:
        return Response(status_code=416, headers={"Content-Range": f"bytes */{total_size}"})
    end = min(end, total_size - 1)
    length = end - start + 1

    return StreamingResponse(
        _range_iter(start, end), status_code=206, media_type=content_type,
        headers={
            "Cache-Control": "public, max-age=31536000, immutable",
            "Accept-Ranges": "bytes",
            "Content-Range": f"bytes {start}-{end}/{total_size}",
            "Content-Length": str(length),
        },
    )


async def get_sync_document(db, sync_id: str) -> dict | None:
    return await db[CHAPTER_SYNC_COLL].find_one({"syncId": sync_id}, {"_id": 0})


async def get_current_chapter_sync(db, slug: str, chapter_index: int) -> dict | None:
    """Most-recently-generated sync document currently bound to this
    chapter. Multiple sync documents may exist for the same chapter over
    time (re-generation) — the binding is "latest wins", not a hard
    1:1 foreign key, matching spec §4's reuse/replacement model."""
    return await db[CHAPTER_SYNC_COLL].find_one(
        {"slug": slug, "chapterIndex": chapter_index},
        {"_id": 0},
        sort=[("generatedAt", -1)],
    )


async def transition_review_status(
    db, sync_id: str, *, new_status: str, speaker_relabels: dict | None = None,
    edited_transcript: str | None = None,
) -> dict:
    doc = await get_sync_document(db, sync_id)
    if not doc:
        raise SyncStudioError("sync_not_found", f"no sync document for syncId={sync_id!r}", 404)

    if new_status not in VALID_REVIEW_STATUSES:
        raise SyncStudioError("invalid_status", f"invalid reviewStatus: {new_status!r}", 400)

    current = doc.get("reviewStatus", "pending")
    if new_status != current and new_status not in _ALLOWED_TRANSITIONS.get(current, set()):
        raise SyncStudioError(
            "invalid_transition",
            f"cannot transition reviewStatus from {current!r} to {new_status!r}",
            409,
        )

    updates: dict = {"reviewStatus": new_status}
    if new_status == "approved" and not doc.get("approvedAt"):
        updates["approvedAt"] = _dt.datetime.now(_dt.timezone.utc).strftime("%Y-%m-%dT%H:%M:%SZ")

    if speaker_relabels:
        speakers = doc.get("speakers") or []
        relabeled = [
            {**s, "label": speaker_relabels.get(s.get("id"), s.get("label"))}
            for s in speakers
        ]
        updates["speakers"] = relabeled

    if edited_transcript is not None:
        # NOT re-keyed to word boundaries in this pass (see module docstring)
        # — stored as a pending author note so it is visible, not silently
        # dropped, and so a follow-up commit has a real field to act on.
        updates["pendingTranscriptEdit"] = edited_transcript

    await db[CHAPTER_SYNC_COLL].update_one({"syncId": sync_id}, {"$set": updates})
    doc.update(updates)
    return doc


# ── Alignment lifecycle (Video Library pipeline writes through here — the
#    chapter_sync collection stays exclusively owned by this module) ───────
async def mark_alignment_processing(db, sync_id: str) -> None:
    await db[CHAPTER_SYNC_COLL].update_one(
        {"syncId": sync_id}, {"$set": {"alignmentStatus": "processing"}},
    )


async def mark_alignment_failed(db, sync_id: str) -> None:
    await db[CHAPTER_SYNC_COLL].update_one(
        {"syncId": sync_id}, {"$set": {"alignmentStatus": "failed"}},
    )


async def apply_alignment_result(db, sync_id: str, aligned: dict) -> dict:
    """Apply a provider's alignment output (a canonical sync fragment —
    paragraphs/speakers/duration/provider identity) onto an EXISTING sync
    document (the one create_sync_from_upload made at upload time). The
    document keeps its syncId/mediaRef/ownerRef; alignmentVersion is bumped
    so re-runs are visible as versions, never silent overwrites."""
    doc = await get_sync_document(db, sync_id)
    if not doc:
        raise SyncStudioError("sync_not_found", f"no sync document for syncId={sync_id!r}", 404)

    updates = {
        "paragraphs": aligned.get("paragraphs") or [],
        "durationSec": aligned.get("durationSec", 0.0),
        "providerCategory": aligned.get("providerCategory", "speech_recognition"),
        "providerVersion": aligned.get("providerVersion", ""),
        "generatedAt": aligned.get("generatedAt", ""),
        "alignmentStatus": "complete",
        "alignmentVersion": int(doc.get("alignmentVersion", 1)) + 1,
        "reviewStatus": "pending",
        "approvedAt": None,
    }
    if aligned.get("speakers"):
        updates["speakers"] = aligned["speakers"]

    merged = {**doc, **updates}
    ok, errors = validate_sync_document(merged)
    if not ok:
        raise SyncStudioError("invalid_sync_document", "; ".join(errors), 500)
    await db[CHAPTER_SYNC_COLL].update_one({"syncId": sync_id}, {"$set": updates})
    return merged


async def suggest_speaker_labels(db, sync_id: str, labels: dict) -> None:
    """AI-suggested speaker labels (Gemini analysis) — stored as suggestions
    only; the Review Studio's explicit rename is what changes real labels."""
    await db[CHAPTER_SYNC_COLL].update_one(
        {"syncId": sync_id}, {"$set": {"speakerLabelSuggestions": {
            str(k)[:20]: str(v)[:60] for k, v in (labels or {}).items()
        }}},
    )


# ── Synchronization Review Studio — structural edit operations ───────────
def _distribute_words_evenly(text: str, start: float, end: float) -> list[dict]:
    """Length-weighted retiming of replacement text across a fixed span —
    the sentence keeps its measured boundaries; only its interior words are
    re-keyed. confidence.alignment stays absent (estimated, never 1.0)."""
    tokens = [t for t in (text or "").split() if t]
    if not tokens:
        return []
    span = max(0.0, float(end) - float(start))
    weights = [len(t) + 1 for t in tokens]
    total = sum(weights) or 1
    out, cursor = [], float(start)
    for tok, w in zip(tokens, weights):
        dur = span * (w / total)
        out.append({"word": tok, "start": round(cursor, 3), "end": round(cursor + dur, 3), "confidence": {}})
        cursor += dur
    if out:
        out[-1]["end"] = round(float(end), 3)
    return out


def _recompute_bounds(paragraphs: list[dict]) -> list[dict]:
    """Drop empty sentences/paragraphs and re-derive start/end from words —
    words remain the single source of truth (spec §2)."""
    cleaned: list[dict] = []
    for p in paragraphs:
        sentences = []
        for s in p.get("sentences") or []:
            words = s.get("words") or []
            if not words:
                continue
            s = {**s, "start": words[0]["start"], "end": words[-1]["end"]}
            sentences.append(s)
        if sentences:
            cleaned.append({**p, "sentences": sentences,
                            "start": sentences[0]["start"], "end": sentences[-1]["end"]})
    return cleaned


def _apply_one_edit(doc: dict, op: dict) -> None:
    """Apply a single review edit in place. Raises SyncStudioError on any
    out-of-range reference — the whole batch is rejected, never half-applied
    (caller works on a copy)."""
    kind = op.get("op")
    paragraphs = doc.get("paragraphs") or []

    def _sentence(p_idx: int, s_idx: int) -> dict:
        try:
            return paragraphs[int(p_idx)]["sentences"][int(s_idx)]
        except (IndexError, KeyError, TypeError, ValueError):
            raise SyncStudioError("bad_reference", f"no sentence at p={p_idx} s={s_idx}", 400)

    if kind == "edit_word":
        s = _sentence(op.get("p"), op.get("s"))
        try:
            word = s["words"][int(op.get("w"))]
        except (IndexError, TypeError, ValueError):
            raise SyncStudioError("bad_reference", f"no word at w={op.get('w')}", 400)
        new_text = str(op.get("word") or "").strip()
        if not new_text:
            raise SyncStudioError("empty_word", "word text cannot be empty", 400)
        word["word"] = new_text[:80]

    elif kind == "set_word_timing":
        s = _sentence(op.get("p"), op.get("s"))
        try:
            word = s["words"][int(op.get("w"))]
        except (IndexError, TypeError, ValueError):
            raise SyncStudioError("bad_reference", f"no word at w={op.get('w')}", 400)
        start = round(float(op.get("start", word["start"])), 3)
        end = round(float(op.get("end", word["end"])), 3)
        if start < 0 or end < start:
            raise SyncStudioError("bad_timing", "end must be >= start >= 0", 400)
        word["start"], word["end"] = start, end

    elif kind == "replace_sentence_text":
        s = _sentence(op.get("p"), op.get("s"))
        text = str(op.get("text") or "").strip()
        if not text:
            raise SyncStudioError("empty_sentence", "sentence text cannot be empty", 400)
        s["words"] = _distribute_words_evenly(text[:2000], s["start"], s["end"])

    elif kind == "split_sentence":
        p_idx, s_idx = int(op.get("p", -1)), int(op.get("s", -1))
        s = _sentence(p_idx, s_idx)
        at = int(op.get("at", 0))
        words = s.get("words") or []
        if not (0 < at < len(words)):
            raise SyncStudioError("bad_split", f"split index {at} out of range", 400)
        left, right = words[:at], words[at:]
        s["words"] = left
        new_sentence = {
            "id": f"{s.get('id', 's')}x{uuid.uuid4().hex[:6]}",
            "start": right[0]["start"], "end": right[-1]["end"],
            "confidence": dict(s.get("confidence") or {}),
            "words": right,
        }
        if "speakerId" in s:
            new_sentence["speakerId"] = s["speakerId"]
        paragraphs[p_idx]["sentences"].insert(s_idx + 1, new_sentence)

    elif kind == "merge_sentences":
        p_idx, s_idx = int(op.get("p", -1)), int(op.get("s", -1))
        _sentence(p_idx, s_idx)
        sentences = paragraphs[p_idx]["sentences"]
        if s_idx + 1 >= len(sentences):
            raise SyncStudioError("bad_merge", "no following sentence to merge into", 400)
        sentences[s_idx]["words"] = (sentences[s_idx].get("words") or []) + (sentences[s_idx + 1].get("words") or [])
        del sentences[s_idx + 1]

    elif kind == "set_sentence_speaker":
        s = _sentence(op.get("p"), op.get("s"))
        speaker_id = str(op.get("speakerId") or "").strip()
        if speaker_id:
            s["speakerId"] = speaker_id[:20]
            speakers = doc.setdefault("speakers", [])
            if not any(sp.get("id") == s["speakerId"] for sp in speakers):
                speakers.append({"id": s["speakerId"], "label": s["speakerId"]})
        else:
            s.pop("speakerId", None)

    elif kind == "rename_speaker":
        speaker_id = str(op.get("id") or "")
        label = str(op.get("label") or "").strip()
        if not label:
            raise SyncStudioError("empty_label", "speaker label cannot be empty", 400)
        speakers = doc.get("speakers") or []
        for sp in speakers:
            if sp.get("id") == speaker_id:
                sp["label"] = label[:60]
                break
        else:
            raise SyncStudioError("bad_reference", f"no speaker {speaker_id!r}", 400)

    else:
        raise SyncStudioError("unknown_op", f"unknown edit op: {kind!r}", 400)


async def apply_sync_edits(db, sync_id: str, operations: list[dict]) -> dict:
    """Synchronization Review Studio batch edit. All-or-nothing: operations
    are applied to an in-memory copy, validated, then persisted in one
    update. The FIRST edit snapshots `originalParagraphs`/`originalSpeakers`
    for the compare-original-vs-edited view; every edit bumps
    alignmentVersion and moves an approved/pending document to `in_review`
    (an edited approval is no longer an approval)."""
    import copy

    doc = await get_sync_document(db, sync_id)
    if not doc:
        raise SyncStudioError("sync_not_found", f"no sync document for syncId={sync_id!r}", 404)
    if doc.get("alignmentStatus") != "complete":
        raise SyncStudioError("not_aligned", "run the processing pipeline before editing", 409)
    if not isinstance(operations, list) or not operations:
        raise SyncStudioError("no_operations", "operations list is required", 400)
    if len(operations) > 200:
        raise SyncStudioError("too_many_operations", "max 200 operations per batch", 400)

    working = copy.deepcopy(doc)
    for op in operations:
        if not isinstance(op, dict):
            raise SyncStudioError("bad_operation", "each operation must be an object", 400)
        _apply_one_edit(working, op)

    working["paragraphs"] = _recompute_bounds(working.get("paragraphs") or [])
    ok, errors = validate_sync_document(working)
    if not ok:
        raise SyncStudioError("invalid_sync_document", "; ".join(errors), 400)

    updates = {
        "paragraphs": working["paragraphs"],
        "alignmentVersion": int(doc.get("alignmentVersion", 1)) + 1,
        "reviewStatus": "in_review",
        "approvedAt": None,
    }
    if "speakers" in working:
        updates["speakers"] = working["speakers"]
    if "originalParagraphs" not in doc:
        updates["originalParagraphs"] = doc.get("paragraphs") or []
        updates["originalSpeakers"] = doc.get("speakers") or []
    await db[CHAPTER_SYNC_COLL].update_one({"syncId": sync_id}, {"$set": updates})
    return {**doc, **updates}


def register_sync_studio_routes(api, db, require_admin, current_student, get_book_by_slug) -> None:
    """Mounts the Universal Synchronization Engine routes. Matches
    notification_packs.py's register_*_routes(api, db, require_admin)
    convention, extended with `current_student` (optional-auth, matching
    the existing GET /books/{slug} pattern) and `get_book_by_slug` (a
    read-only adapter — see server.py's `_bf_get_book_by_slug` for the
    established precedent of injecting this rather than importing db.books
    logic directly into a sibling module).

    `media_bucket` is created here, not injected — AsyncIOMotorGridFSBucket
    only needs a db handle at construction time (the same pattern server.py
    itself uses for `audio_bucket`, created at module scope before any
    request loop runs)."""
    media_bucket = AsyncIOMotorGridFSBucket(db, bucket_name=MEDIA_GRIDFS_BUCKET)

    def _raise(exc: SyncStudioError):
        raise HTTPException(status_code=exc.http_status, detail=exc.message)

    @api.post("/studio/sync/from-chapter")
    async def from_chapter_route(payload: dict = Body(...), _admin=Depends(require_admin)):
        try:
            doc = await create_sync_from_chapter_block(
                db,
                slug=payload.get("slug", ""),
                chapter_index=int(payload.get("chapterIndex", -1)),
                block_index=int(payload.get("blockIndex", -1)),
                get_book_by_slug=get_book_by_slug,
            )
        except SyncStudioError as exc:
            _raise(exc)
        return {"ok": True, "sync": doc}

    @api.post("/studio/sync/upload")
    async def upload_route(
        slug: str = Form(...),
        chapterIndex: int = Form(...),
        file: UploadFile = File(...),
        admin=Depends(require_admin),
    ):
        raw = await file.read()
        try:
            doc = await create_sync_from_upload(
                db, slug=slug, chapter_index=chapterIndex, raw=raw,
                declared_content_type=file.content_type or "",
                media_bucket=media_bucket, uploaded_by=getattr(admin, "email", ""),
            )
        except SyncStudioError as exc:
            _raise(exc)
        return {"ok": True, "sync": doc}

    @api.get("/sync/media/{filename}")
    async def media_stream_route(filename: str, request: Request):
        return await stream_sync_media(media_bucket, filename, request)

    @api.get("/studio/sync/{sync_id}")
    async def studio_get_sync_route(sync_id: str, _admin=Depends(require_admin)):
        doc = await get_sync_document(db, sync_id)
        if not doc:
            raise HTTPException(status_code=404, detail="sync document not found")
        return {"sync": doc}

    @api.post("/studio/sync/{sync_id}/review")
    async def review_route(sync_id: str, payload: dict = Body(...), _admin=Depends(require_admin)):
        try:
            doc = await transition_review_status(
                db, sync_id,
                new_status=payload.get("reviewStatus", ""),
                speaker_relabels=payload.get("speakerRelabels"),
                edited_transcript=payload.get("editedTranscript"),
            )
        except SyncStudioError as exc:
            _raise(exc)
        return {"ok": True, "sync": doc}

    @api.post("/studio/sync/{sync_id}/edit")
    async def edit_sync_route(sync_id: str, payload: dict = Body(...), _admin=Depends(require_admin)):
        try:
            doc = await apply_sync_edits(db, sync_id, payload.get("operations") or [])
        except SyncStudioError as exc:
            _raise(exc)
        return {"ok": True, "sync": doc}

    @api.get("/sync/{sync_id}")
    async def public_get_sync_route(sync_id: str, student=Depends(current_student)):
        doc = await get_sync_document(db, sync_id)
        if not doc or not is_servable_to_students(doc):
            raise HTTPException(status_code=404, detail="sync document not found")
        return {"sync": doc}

    @api.get("/books/{slug}/chapters/{chapter_index}/sync")
    async def chapter_sync_route(slug: str, chapter_index: int, student=Depends(current_student)):
        doc = await get_current_chapter_sync(db, slug, chapter_index)
        if not doc or not is_servable_to_students(doc):
            raise HTTPException(status_code=404, detail="sync document not found")
        return {"sync": doc}

    logger.info("sync_studio_tools: routes registered (/api/sync*, /api/studio/sync*)")
