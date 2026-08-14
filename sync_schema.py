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
                    confidence: dict | None = None, translation_km: str | None = None) -> dict:
    """`start`/`end` are derived from the first/last word — words are the
    source of truth (spec §2), never independently specified.

    `translation_km` is a purely additive, optional display field (a
    Video Library capability — see video_ai_provider.py's per-sentence
    Khmer translation) carrying NO timing of its own: it rides on the
    SAME sentence unit's existing start/end derived from the English
    words above, exactly like `speakerId`. Omitted entirely (not even a
    None-valued key) when not supplied, so every existing caller of this
    shared builder (Books/EduTalk sync consumers included) produces a
    byte-identical document to before this parameter existed."""
    out = {
        "id": sentence_id,
        "start": words[0]["start"] if words else 0.0,
        "end": words[-1]["end"] if words else 0.0,
        "confidence": confidence or {},
        "words": words,
    }
    if speaker_id is not None:
        out["speakerId"] = speaker_id
    if translation_km:
        out["translationKm"] = translation_km
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
    """Structural validation, PLUS the one timing invariant every consumer
    of this document silently assumes and never itself enforces:
    chronological order by array position.

    Root-cause context (2026-08, conversation-karaoke incident): the
    frontend's binary search (syncConsumption.js's binarySearchActiveIndex)
    documents "`units` must be sorted ascending by start and non-overlapping"
    as a PRECONDITION it does not itself check. video_ai_provider.segments_
    to_sync already defends its own producer path with a sort — but that
    fix lives at ONE producer, not at the schema boundary every producer's
    document must pass through before persistence. A second producer
    (video_narration_tools.assemble_narration_track, the AI-narrated
    conversation/storytelling path) had no equivalent guard: nothing here
    stopped a document whose sentence/word array position did not match its
    own `start` values from being persisted and served to students, at
    which point the frontend's lookup silently returns wrong results for
    the entire remainder of playback (see useSyncHighlight.js's own
    describeKaraokeDebugFrame docstring for the exact observed symptom —
    the highlight appears to "jump to the end" within seconds of Play).

    This check DETECTS the violation and rejects the document — it never
    reorders, drops, or renumbers anything itself (per this function's own
    "never re-derives or corrects data" contract, still honored: a caller
    that wants a corrected document must produce one honestly, e.g. via a
    real chronological sort at the point real timestamps are computed —
    see assemble_narration_track's per-line word sort, added alongside
    this check). A small tolerance (matching syncConsumption.js's own
    TOL=0.01 boundary discipline) avoids flagging float-rounding noise
    between two genuinely back-to-back units.

    Returns (is_valid, error_messages)."""
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

    TOL = 0.01
    prev_sentence_start = None

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
                s_start = s.get("start")
                if isinstance(s_start, (int, float)):
                    if prev_sentence_start is not None and s_start < prev_sentence_start - TOL:
                        errors.append(
                            f"paragraphs[{p_idx}].sentences[{s_idx}] out of chronological order: "
                            f"start={s_start} precedes an earlier sentence's start={prev_sentence_start}"
                        )
                    prev_sentence_start = s_start
                prev_word_start = None
                for w_idx, w in enumerate(s.get("words") or []):
                    if not isinstance(w, dict) or "word" not in w or "start" not in w or "end" not in w:
                        errors.append(
                            f"paragraphs[{p_idx}].sentences[{s_idx}].words[{w_idx}] "
                            "missing word/start/end"
                        )
                        continue
                    w_start = w.get("start")
                    if isinstance(w_start, (int, float)):
                        if prev_word_start is not None and w_start < prev_word_start - TOL:
                            errors.append(
                                f"paragraphs[{p_idx}].sentences[{s_idx}].words[{w_idx}] out of "
                                f"chronological order: start={w_start} precedes an earlier "
                                f"word's start={prev_word_start}"
                            )
                        prev_word_start = w_start
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
