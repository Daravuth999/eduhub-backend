"""sync_schema.py — Universal Synchronization Engine, canonical schema
(Phase 0 — Universal Synchronization Foundation).

Pure, stdlib-only, no Mongo/network — same purity discipline as
book_factory_interaction_planner.py and book_factory_narration.py. Defines
the ONE synchronization document shape agreed in
docs/proposals/universal-synchronization-engine-technical-spec.md §2 in the
frontend repo, and pure builder/validator functions over it. Nothing in this
module knows about a vendor, a book, or a chapter — see sync_provider.py for
the provider boundary and sync_studio_tools.py for the Mongo-backed routes
that reference this schema by `syncId`.

Confidence is a namespaced dict, never a single float (spec §2): every unit
carries `{"transcript": float|None, "alignment": float|None, ...}` so future
capability layers (translation, pronunciation — spec §13) can add a key
without a schema-shape change. A value of None means "this provider did not
supply this confidence type" — never fabricated as 1.0.

SYNC_VERSION is the schema-SHAPE version (spec §2's four-field versioning
model). Bump it only for a breaking shape change, never for a new provider
or a re-alignment — those are `providerVersion`/`alignmentVersion`, carried
per-document, not module-level.
"""
from __future__ import annotations

import uuid

SYNC_VERSION = 1

VALID_REVIEW_STATUSES = ("pending", "in_review", "approved", "rejected")

# Provider categories — capability, never vendor name (spec §3).
VALID_PROVIDER_CATEGORIES = ("speech_recognition", "alignment", "synthesis", "manual")

# Alignment lifecycle — separate from reviewStatus (§5's editorial workflow).
# A freshly-uploaded media asset has no words/sentences yet at all; it sits
# in "awaiting_provider" until a Speech Recognition/Alignment provider is
# selected and run (tech spec §12 — vendor deliberately not yet chosen).
# reviewStatus only becomes meaningful once alignmentStatus == "complete".
VALID_ALIGNMENT_STATUSES = ("awaiting_provider", "queued", "processing", "complete", "failed")

# Confidence key namespace shipped today. `translation`/`pronunciation` are
# reserved (spec §13) — a consumer that doesn't recognize a key ignores it,
# so reserving them here is documentation, not enforcement.
CONFIDENCE_KEYS_SHIPPED = ("transcript", "alignment")
CONFIDENCE_KEYS_RESERVED = ("translation", "pronunciation")


def new_sync_id() -> str:
    return "sync_" + uuid.uuid4().hex[:16]


def build_confidence(**kwargs) -> dict:
    """Build a namespaced confidence object. Unset keys are omitted, not
    defaulted to None-in-every-key — keeps documents compact. Example:
    build_confidence(transcript=0.95, alignment=0.93)."""
    return {k: v for k, v in kwargs.items() if v is not None}


def build_word(word: str, start: float, end: float, *, confidence: dict | None = None) -> dict:
    return {
        "word": word,
        "start": round(float(start), 3),
        "end": round(float(end), 3),
        "confidence": confidence or {},
    }


def build_sentence(sentence_id: str, words: list[dict], *, speaker_id: str | None = None,
                    confidence: dict | None = None) -> dict:
    """`start`/`end` are derived from the first/last word — words are the
    source of truth (spec §2), never independently specified."""
    out = {
        "id": sentence_id,
        "start": words[0]["start"] if words else 0.0,
        "end": words[-1]["end"] if words else 0.0,
        "confidence": confidence or {},
        "words": words,
    }
    if speaker_id is not None:
        out["speakerId"] = speaker_id
    return out


def build_paragraph(paragraph_id: str, sentences: list[dict], *, confidence: dict | None = None) -> dict:
    return {
        "id": paragraph_id,
        "start": sentences[0]["start"] if sentences else 0.0,
        "end": sentences[-1]["end"] if sentences else 0.0,
        "confidence": confidence or {},
        "sentences": sentences,
    }


def build_sync_document(
    *,
    media_ref: str,
    provider_category: str,
    provider_version: str,
    paragraphs: list[dict],
    generated_at: str,
    duration_sec: float,
    speakers: list[dict] | None = None,
    sync_id: str | None = None,
    review_status: str = "pending",
    alignment_status: str = "complete",
) -> dict:
    """Assemble a canonical sync document. Callers (providers, the review
    workflow) always go through this — never hand-build the dict — so
    SYNC_VERSION and defaulted fields stay centralized in one place.

    `alignment_status` defaults to "complete" because every EXISTING caller
    (ElevenLabsProvider, ScribeAlignmentProvider) already has real word data
    by the time it calls this. The native-upload path
    (sync_studio_tools.create_sync_from_upload) is the one caller that
    passes "awaiting_provider" explicitly, for a media asset with no
    alignment run yet."""
    if provider_category not in VALID_PROVIDER_CATEGORIES:
        raise ValueError(f"invalid provider_category: {provider_category!r}")
    if review_status not in VALID_REVIEW_STATUSES:
        raise ValueError(f"invalid review_status: {review_status!r}")
    if alignment_status not in VALID_ALIGNMENT_STATUSES:
        raise ValueError(f"invalid alignment_status: {alignment_status!r}")

    doc = {
        "syncId": sync_id or new_sync_id(),
        "mediaRef": media_ref,
        "syncVersion": SYNC_VERSION,
        "providerVersion": provider_version,
        "alignmentVersion": 1,
        "generatedAt": generated_at,
        "approvedAt": None,
        "durationSec": round(float(duration_sec), 3),
        "providerCategory": provider_category,
        "reviewStatus": review_status,
        "alignmentStatus": alignment_status,
        "paragraphs": paragraphs,
    }
    if speakers:
        doc["speakers"] = speakers
    return doc


def validate_sync_document(doc: dict) -> tuple[bool, list[str]]:
    """Structural validation only (shape, required fields, enum values) —
    never re-derives or corrects data. Returns (is_valid, error_messages)."""
    errors: list[str] = []
    if not isinstance(doc, dict):
        return False, ["document is not a dict"]

    for field in ("syncId", "mediaRef", "syncVersion", "providerCategory", "reviewStatus", "paragraphs"):
        if field not in doc:
            errors.append(f"missing required field: {field}")

    if doc.get("providerCategory") not in (*VALID_PROVIDER_CATEGORIES, None):
        errors.append(f"invalid providerCategory: {doc.get('providerCategory')!r}")
    if doc.get("reviewStatus") not in (*VALID_REVIEW_STATUSES, None):
        errors.append(f"invalid reviewStatus: {doc.get('reviewStatus')!r}")
    if doc.get("alignmentStatus") not in (*VALID_ALIGNMENT_STATUSES, None):
        errors.append(f"invalid alignmentStatus: {doc.get('alignmentStatus')!r}")

    paragraphs = doc.get("paragraphs")
    if isinstance(paragraphs, list):
        for p_idx, p in enumerate(paragraphs):
            if not isinstance(p, dict) or "sentences" not in p:
                errors.append(f"paragraphs[{p_idx}] missing sentences")
                continue
            for s_idx, s in enumerate(p.get("sentences") or []):
                if not isinstance(s, dict) or "words" not in s:
                    errors.append(f"paragraphs[{p_idx}].sentences[{s_idx}] missing words")
                    continue
                for w_idx, w in enumerate(s.get("words") or []):
                    if not isinstance(w, dict) or "word" not in w or "start" not in w or "end" not in w:
                        errors.append(
                            f"paragraphs[{p_idx}].sentences[{s_idx}].words[{w_idx}] "
                            "missing word/start/end"
                        )
    elif "paragraphs" in doc:
        errors.append("paragraphs must be a list")

    return (len(errors) == 0), errors


def is_servable_to_students(doc: dict) -> bool:
    """Publish gate (spec §5): approved, OR a synthesis-path document — TTS
    output is auto-approved because it was generated FROM already-approved
    text, preserving today's zero-review ElevenLabs behavior exactly.
    A document still awaiting alignment (freshly uploaded media with no
    provider run yet) is NEVER servable regardless of reviewStatus — it has
    no real words to show a student."""
    if not isinstance(doc, dict):
        return False
    if doc.get("alignmentStatus", "complete") != "complete":
        return False
    if doc.get("reviewStatus") == "approved":
        return True
    return doc.get("providerCategory") == "synthesis"
