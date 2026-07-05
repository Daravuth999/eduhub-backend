"""book_factory_jobs.py — Book Factory (Phase 1) job engine + admin routes.

Owns: job CRUD, the stepper endpoint, the atomic-claim / attempt-fencing state
machine, blueprint approval, job resumption listing, chapter lock / unlock /
regenerate / cancel, the named concurrency constants, and route registration
via `register_book_factory_routes(api, db, require_admin)`.

Concurrency model — modelled on the proven atomic compare-and-set claim in
voice_treasure_attempt_tools.py / camrapidpay_payment_tools.py:

  * Each stage (the blueprint, and every chapter keyed by a stable chapterId)
    lives inside ONE job document as a map, so a single-document atomic
    `find_one_and_update` targets one stage via a dotted field path.
  * Only the caller that wins the atomic claim may call Gemini.
  * Every post-claim write is fenced on (attemptId + generationVersion +
    expected state), also on the AUTHENTICATED OWNER (§BLOCKER 1), and
    cancellation-sensitive writes require the job to NOT be cancelled
    (§BLOCKER 2) and the chapter to NOT be locked (§BLOCKER 3) — a superseded
    attempt, a stale generation version, a late completion/failure on a
    cancelled job, or a write into a locked chapter can never win.
  * A locked chapter can never be claimed (the lock lives in the claim filter).

This module calls Gemini ONLY through book_factory_gemini.py (monkeypatched in
tests) and composes/validates ONLY through book_factory_composer.py /
book_factory_validator.py.  It never writes to db.books.
"""
from __future__ import annotations

import hashlib
import inspect
import json
import logging
import math
import os
import re
import uuid
from datetime import datetime, timedelta, timezone

try:
    from pymongo import ReturnDocument
except Exception:  # pragma: no cover
    ReturnDocument = None  # type: ignore[assignment]

from fastapi import Depends, HTTPException

import book_factory_gemini as bf_gemini
from book_factory_gemini import (
    BFRetryableError, BFUnknownOutcomeError, BFTerminalError,
)
import book_factory_composer as bf_composer
import book_factory_validator as bf_validator
import book_factory_image as bf_image
import book_factory_narration as bf_narration
import book_factory_conversation as bf_conv

log = logging.getLogger("eduhub.book_factory")

COLL = "book_factory_jobs"


# ── §HIGH 12: IMMUTABLE hard safety ceilings/floors ─────────────────────────
# Environment settings may only REDUCE a ceiling, never raise it. Provider
# safety (chapters, provider calls, retries, lease) is hard-bounded here; the
# aggregate content ceilings (words/exercises) are documented in the correction
# package (old effective 100 exercises → new 300; words unchanged at 10000).
HARD_MAX_TOTAL_CHAPTERS = 20
HARD_MAX_RETRIES = 2
HARD_MAX_CLAIM_LEASE_S = 600           # a crashed stage cannot stay locked forever
CLAIM_LEASE_SAFETY_MARGIN_S = 30
HARD_MAX_TOTAL_WORDS = 10000           # unchanged from the prior package
HARD_MAX_TOTAL_EXERCISES = 300         # was an effective 100; raised + documented


def _env_int(name: str, default: int) -> int:
    """Read a non-negative int from the environment; fall back safely."""
    try:
        v = int(os.environ.get(name, str(default)))
    except (TypeError, ValueError):
        return default
    return v if v >= 0 else default


def _clamp_ceiling(env_name: str, default: int, hard_max: int, hard_min: int = 1) -> int:
    """effective = clamp(min(valid_env_value, hard_max), hard_min). The env can
    only REDUCE the ceiling below the hard maximum, never raise it."""
    return max(hard_min, min(_env_int(env_name, default), hard_max))


# Two retries AFTER the initial attempt → three total attempts before terminal.
MAX_RETRIES: int = _clamp_ceiling("BOOK_FACTORY_MAX_RETRIES", 2, HARD_MAX_RETRIES, hard_min=0)
# Hard bound on total persisted chapters (§BLOCKER 4 / §HIGH 12).
MAX_TOTAL_CHAPTERS: int = _clamp_ceiling("BOOK_FACTORY_MAX_TOTAL_CHAPTERS", 20, HARD_MAX_TOTAL_CHAPTERS)
# Recent-jobs listing cap (§HIGH 7).
JOBS_LIST_MAX: int = _clamp_ceiling("BOOK_FACTORY_JOBS_LIST_MAX", 50, 200)
# Recent-jobs recency window in seconds (§HIGH 7) — default 24h, hard-capped 7d.
JOBS_RECENT_WINDOW_S: int = _clamp_ceiling("BOOK_FACTORY_JOBS_RECENT_WINDOW_S", 86400, 7 * 86400)

BLUEPRINT_TIMEOUT_S = bf_gemini.BLUEPRINT_TIMEOUT_S
CHAPTER_TIMEOUT_S = bf_gemini.CHAPTER_TIMEOUT_S

# §HIGH 12: the claim lease MUST be >= the longest provider timeout + margin so
# an in-flight provider request can never outlive its lease; it is hard-capped
# so a crashed stage is always eventually reclaimable.
_PROVIDER_TIMEOUT_MAX = max(float(BLUEPRINT_TIMEOUT_S), float(CHAPTER_TIMEOUT_S))
_LEASE_FLOOR_S = int(_PROVIDER_TIMEOUT_MAX + CLAIM_LEASE_SAFETY_MARGIN_S)
CLAIM_LEASE_S: int = min(
    max(_env_int("BOOK_FACTORY_TEXT_CLAIM_LEASE_S", 90), _LEASE_FLOOR_S),
    HARD_MAX_CLAIM_LEASE_S,
)

# ── stage states ────────────────────────────────────────────────────────────
S_PENDING = "pending"
S_CLAIMED = "claimed"
S_PROVIDER_PENDING = "provider_pending"
S_COMPLETED = "completed"
S_FAILED_RETRYABLE = "failed_retryable"
S_FAILED_TERMINAL = "failed_terminal"
S_UNKNOWN = "unknown_outcome"

_RETRY_ELIGIBLE = (S_FAILED_RETRYABLE, S_UNKNOWN)  # terminal is NOT manually retryable
_JOB_CANCELLED = "cancelled"
# §BLOCKER 3: a lock may only be toggled when the chapter is in a STABLE state.
_LOCKABLE_STATES = (S_PENDING, S_COMPLETED, S_FAILED_TERMINAL, S_FAILED_RETRYABLE, S_UNKNOWN)


# ── §BLOCKER 1 / §HIGH 14: known constant sets (code-defined, not Mongo-editable) ─
# These IDs are IDENTICAL to the frontend bookFactorySchema.PEDAGOGY_PROFILES
# and to book_factory_gemini.PEDAGOGY_PROFILES (prompt-description mapping).
KNOWN_PEDAGOGY_PROFILES = frozenset({
    "general_english",
    "daravuth_speaking_performance",
    "pronunciation_focus",
    "workplace_communication",
    "storytelling_performance",
    "speaking_confidence",
})
# Recipe IDs (authoring defaults only; never affect wallet/ownership/publish).
KNOWN_RECIPE_IDS = frozenset({
    "a1_short_story", "a2_story_speaking", "b1_professional_convo",
    "standard_story_book", "premium_full_practice",
    "limited_edition_narrative", "exercise_review_book",
})
KNOWN_SECTIONS = frozenset({"story", "conversation", "exercise"})
KNOWN_LEVELS = frozenset({"A1", "A2", "B1", "B2"})
KNOWN_TIERS = frozenset({"free", "standard", "premium", "limited"})
KNOWN_MODES = frozenset({"smart", "simple", "precise"})
KNOWN_PRON_DEPTH = frozenset({"none", "light", "standard", "deep"})
KNOWN_PARAGRAPH_GUIDANCE = frozenset({"short", "balanced", "detailed"})


def _is_int(v) -> bool:
    # bool is a subclass of int — reject it explicitly.
    return isinstance(v, int) and not isinstance(v, bool)


def _expected_chapter_total(config: dict) -> int:
    """Approved expected chapter count computed BEFORE any provider call
    (§BLOCKER 4). chapterCount normal chapters + at most one review chapter."""
    cc = config.get("chapterCount")
    cc = cc if _is_int(cc) else 0
    review = 1 if bool(config.get("includeReviewChapter")) else 0
    return cc + review


def validate_book_factory_config(config: dict) -> list[str]:
    """§HIGH 9: complete, strict configuration validation. Returns a list of
    error strings (empty == valid). Called before any job document is created;
    a non-empty result must produce HTTP 422 with no job written.

    No silent coercion: "5"→5, True→1, 2.7→2 are all rejected. Required fields
    (mode, title, topic, price, readingMinutes, chapterCount, min/maxWords) must
    be explicitly supplied; NaN / Infinity price and numeric recipeId rejected.
    """
    e: list[str] = []
    if not isinstance(config, dict):
        return ["config must be an object"]

    def _str(key, *, required=False, maxlen=None):
        if key not in config or config[key] is None:
            if required:
                e.append(f"{key} is required")
            return
        v = config[key]
        if not isinstance(v, str):
            e.append(f"{key} must be a string")
            return
        if required and not v.strip():
            e.append(f"{key} must not be empty")
        if maxlen is not None and len(v) > maxlen:
            e.append(f"{key} exceeds {maxlen} characters")

    def _enum(key, allowed, *, required=True):
        if key not in config or config[key] is None:
            if required:
                e.append(f"{key} is required")
            return
        if config[key] not in allowed:
            e.append(f"{key} must be one of {sorted(allowed)}")

    def _int(key, lo, hi, *, required=False):
        if key not in config or config[key] is None:
            if required:
                e.append(f"{key} is required")
            return
        v = config[key]
        if not _is_int(v):
            e.append(f"{key} must be an integer")
            return
        if v < lo or v > hi:
            e.append(f"{key} must be between {lo} and {hi}")

    _str("title", required=True, maxlen=500)
    _str("subtitle", maxlen=300)
    _str("author", maxlen=200)
    _str("topic", required=True, maxlen=500)

    # §PHASE D2: presentation fields — string-only, bounded length; objects/arrays
    # and oversized values are rejected (a 1 M-char coverGradient cannot persist).
    _str("coverGradient", maxlen=200)
    _str("coverEmoji", maxlen=50)
    _str("accent", maxlen=100)

    # paragraphGuidance: approved enum OR bounded free text.
    pg = config.get("paragraphGuidance")
    if pg is not None:
        if not isinstance(pg, str):
            e.append("paragraphGuidance must be a string")
        elif len(pg) > 200:
            e.append("paragraphGuidance exceeds 200 characters")

    # §HIGH 9: mode is REQUIRED (smart | simple | precise).
    _enum("mode", KNOWN_MODES, required=True)
    _enum("section", KNOWN_SECTIONS)
    _enum("level", KNOWN_LEVELS)
    _enum("tier", KNOWN_TIERS)
    if "pronunciationDepth" in config:
        _enum("pronunciationDepth", KNOWN_PRON_DEPTH)
    _enum("pedagogyProfile", KNOWN_PEDAGOGY_PROFILES)

    # §HIGH 9: recipeId must be a string ("" = none) or an approved recipe ID.
    # Reject numbers/booleans/arrays/objects (recipeId=0 must NOT be accepted).
    if "recipeId" in config and config["recipeId"] is not None:
        rid = config["recipeId"]
        if not isinstance(rid, str):
            e.append("recipeId must be a string")
        elif rid and rid not in KNOWN_RECIPE_IDS:
            e.append("recipeId is not a known recipe")

    # §HIGH 9: price is REQUIRED, finite, non-negative; reject bool/NaN/Infinity.
    if "price" not in config or config.get("price") is None:
        e.append("price is required")
    else:
        price = config["price"]
        if isinstance(price, bool) or not isinstance(price, (int, float)):
            e.append("price must be a number")
        elif not math.isfinite(price):
            e.append("price must be a finite number")
        elif price < 0:
            e.append("price must be >= 0")

    if "includeReviewChapter" in config and not isinstance(config["includeReviewChapter"], bool):
        e.append("includeReviewChapter must be a boolean")

    # §HIGH 9: bounded integers, REQUIRED for the size-critical fields.
    _int("readingMinutes", 1, 180, required=True)
    _int("chapterCount", 1, MAX_TOTAL_CHAPTERS, required=True)
    _int("minWordsPerChapter", 50, 1000, required=True)
    _int("maxWordsPerChapter", 50, 1000, required=True)
    _int("dialogueTurnsPerChapter", 0, 20)
    _int("vocabularyPerChapter", 0, 20)
    _int("mcqPerChapter", 0, 10)
    _int("fillblankPerChapter", 0, 10)
    _int("speakingPerChapter", 0, 10)

    mn, mx = config.get("minWordsPerChapter"), config.get("maxWordsPerChapter")
    if _is_int(mn) and _is_int(mx) and mx < mn:
        e.append("maxWordsPerChapter must be >= minWordsPerChapter")

    # ── aggregate bounds (shared conceptually with the frontend mirror) ──
    cc = config.get("chapterCount")
    review = 1 if config.get("includeReviewChapter") is True else 0
    if _is_int(cc) and (cc + review) > MAX_TOTAL_CHAPTERS:
        e.append(f"chapterCount + review chapter must be <= {MAX_TOTAL_CHAPTERS}")
    # §PHASE D1: word-count ceiling uses (chapterCount + review) — totalChapterCount.
    if _is_int(cc) and _is_int(mx) and (cc + review) * mx > HARD_MAX_TOTAL_WORDS:
        e.append(
            f"totalChapterCount x maxWordsPerChapter exceeds {HARD_MAX_TOTAL_WORDS} "
            f"({cc + review} chapters × {mx} words = {(cc + review) * mx})"
        )

    def _n(key):
        v = config.get(key)
        return v if _is_int(v) else 0
    total = (cc + review) if _is_int(cc) else 0
    per_chapter_ex = _n("vocabularyPerChapter") + _n("mcqPerChapter") + _n("fillblankPerChapter") + _n("speakingPerChapter")
    if total and per_chapter_ex and total * per_chapter_ex > HARD_MAX_TOTAL_EXERCISES:
        e.append(
            "total chapters x (vocabulary+mcq+fillblank+speaking) per chapter "
            f"exceeds {HARD_MAX_TOTAL_EXERCISES}"
        )

    return e


# ── §HIGH 9: sanitized canonical config built before insert_one ─────────────
_CANONICAL_STR_DEFAULTS = {
    "title": "", "subtitle": "", "author": "Classroom Library", "topic": "",
    "section": "story", "level": "A2", "tier": "free", "mode": "smart",
    "recipeId": "", "paragraphGuidance": "balanced", "pronunciationDepth": "standard",
    "pedagogyProfile": "general_english", "coverEmoji": "\U0001F4D6",
    "coverGradient": "linear-gradient(155deg, #2a2140 0%, #4a3a6a 100%)",
    "accent": "#D4A843",
}
_CANONICAL_INT_DEFAULTS = {
    "readingMinutes": 6, "chapterCount": 5, "minWordsPerChapter": 120,
    "maxWordsPerChapter": 320, "dialogueTurnsPerChapter": 4,
    "vocabularyPerChapter": 6, "mcqPerChapter": 3, "fillblankPerChapter": 2,
    "speakingPerChapter": 1,
}


def build_canonical_config(config: dict) -> dict:
    """Construct ONE sanitized canonical configuration object from a validated
    input config. Every required field is either explicitly supplied or filled
    from a documented server-side default. Only known canonical fields survive;
    unknown keys are dropped so no unvalidated value reaches the job document.
    Must be called ONLY after validate_book_factory_config() returns []."""
    out: dict = {}
    for k, dflt in _CANONICAL_STR_DEFAULTS.items():
        v = config.get(k)
        out[k] = v if isinstance(v, str) else dflt
    for k, dflt in _CANONICAL_INT_DEFAULTS.items():
        v = config.get(k)
        out[k] = v if _is_int(v) else dflt
    out["includeReviewChapter"] = bool(config.get("includeReviewChapter"))
    price = config.get("price")
    out["price"] = price if (isinstance(price, (int, float)) and not isinstance(price, bool)
                             and math.isfinite(price) and price >= 0) else 0
    return out


def validate_blueprint_chapters(raw, expected: int) -> tuple[bool, str | None]:
    """§BLOCKER 4: validate a Gemini blueprint chapter list BEFORE persisting.
    Returns (ok, reason). The returned count must equal the approved expected
    count, never exceed MAX_TOTAL_CHAPTERS, and every entry must be well-formed
    with unique IDs/positions and bounded field lengths."""
    if not isinstance(raw, list) or not raw:
        return False, "blueprint_missing_chapters"
    if len(raw) > MAX_TOTAL_CHAPTERS:
        return False, "blueprint_too_many_chapters"
    if expected > 0 and len(raw) != expected:
        return False, f"blueprint_count_mismatch_expected_{expected}_got_{len(raw)}"
    seen_titles = 0
    for ch in raw:
        if not isinstance(ch, dict):
            return False, "blueprint_chapter_not_object"
        title = ch.get("title")
        if not isinstance(title, str) or not title.strip():
            return False, "blueprint_chapter_missing_title"
        if len(title) > 300:
            return False, "blueprint_chapter_title_too_long"
        obj = ch.get("objective")
        if obj is not None and (not isinstance(obj, str) or len(obj) > 2000):
            return False, "blueprint_chapter_bad_objective"
        out = ch.get("outline")
        if out is not None and (not isinstance(out, str) or len(out) > 4000):
            return False, "blueprint_chapter_bad_outline"
        seen_titles += 1
    return True, None


# ── time + id helpers ──────────────────────────────────────────────────────
def _now_iso() -> str:
    return datetime.now(timezone.utc).isoformat()


def _iso_in(seconds: int) -> str:
    return (datetime.now(timezone.utc) + timedelta(seconds=seconds)).isoformat()


def _mint_attempt() -> str:
    return "att_" + uuid.uuid4().hex[:12]


def _get_path(doc: dict, path: str) -> dict:
    cur = doc or {}
    for part in path.split("."):
        if not isinstance(cur, dict):
            return {}
        cur = cur.get(part, {})
    return cur if isinstance(cur, dict) else {}


def _admin_email(admin) -> str | None:
    if isinstance(admin, dict):
        return admin.get("email")
    return getattr(admin, "email", None)


def _owner_clause(owner: str | None) -> dict:
    """§BLOCKER 1: an owner filter fragment merged into every atomic transition.
    When owner is None (direct unit-test calls) no owner constraint is added;
    every ROUTE always supplies the authenticated admin identity."""
    return {"authoredBy": owner} if owner else {}


async def _call_provider(fn, *args, budget, max_calls=None):
    """Call a monkeypatchable Gemini adapter, threading the persisted-budget
    dict ONLY when the callable accepts it (real adapter). A test fake with a
    bare (config[, spec]) signature is called without the kwarg and counts as
    exactly one logical provider call.

    `max_calls` is forwarded when the callable accepts it; this allows the
    semantic-malformed-retry path to cap the second invocation to its remaining
    shared budget slot (§PHASE B1 persisted bounded policy).
    """
    try:
        params = inspect.signature(fn).parameters
    except (TypeError, ValueError):
        params = {}
    kwargs: dict = {}
    if "budget" in params:
        kwargs["budget"] = budget
    if max_calls is not None and "max_calls" in params:
        kwargs["max_calls"] = max_calls
    if kwargs:
        return await fn(*args, **kwargs)
    # Test fake with bare signature — count as exactly one logical call.
    result = await fn(*args)
    budget["providerCallCount"] = max(int(budget.get("providerCallCount") or 0) + 1, 1)
    return result


# ── feature-flag gating (read env live so tests can toggle per-case) ──────
def _flag(name: str) -> bool:
    return os.environ.get(name, "false").strip().lower() in ("1", "true", "yes", "on")


def factory_visible() -> bool:
    return _flag("BOOK_FACTORY_VISIBLE")


def factory_enabled() -> bool:
    return _flag("BOOK_FACTORY_ENABLED")


def factory_gemini_enabled() -> bool:
    return _flag("BOOK_FACTORY_GEMINI_ENABLED") and bf_gemini.is_gemini_key_present()


def generation_permitted() -> bool:
    """Fail-closed gate: enabled AND gemini-enabled AND key present."""
    return factory_enabled() and factory_gemini_enabled()


# ── Phase 2-4 optional-automation flags (all default false; independent of
# each other and of the core BOOK_FACTORY_ENABLED/GEMINI_ENABLED flags) ──────
def cover_generation_permitted() -> bool:
    return _flag("BOOK_FACTORY_COVER_ENABLED") and bf_image.is_enabled()


def narration_automation_permitted() -> bool:
    return _flag("BOOK_FACTORY_NARRATION_ENABLED")


def conversation_audio_automation_permitted() -> bool:
    return _flag("BOOK_FACTORY_CONVERSATION_AUDIO_ENABLED")


def conversation_audio_ready() -> bool:
    """Combined readiness: flag on AND per-line storage (R2) configured."""
    return conversation_audio_automation_permitted() and bf_conv.storage_configured()


def direct_publish_permitted() -> bool:
    return _flag("BOOK_FACTORY_DIRECT_PUBLISH_ENABLED")


def status_payload() -> dict:
    return {
        "visible": factory_visible(),
        "enabled": factory_enabled(),
        "geminiEnabled": factory_gemini_enabled(),
        "coverEnabled": cover_generation_permitted(),
        # §AMENDMENT 3: distinct readiness signals so the UI can explain WHY
        # cover generation is unavailable (flag off vs. no image key vs. no
        # R2 storage) instead of one opaque boolean.
        "coverProviderReady": bf_image.is_enabled(),
        "coverStorageReady": bf_image.storage_configured(),
        "narrationEnabled": narration_automation_permitted(),
        "conversationAudioEnabled": conversation_audio_automation_permitted(),
        "conversationAudioStorageReady": bf_conv.storage_configured(),
        "directPublishEnabled": direct_publish_permitted(),
    }


# ── indexes ────────────────────────────────────────────────────────────────
async def ensure_book_factory_indexes(db) -> None:
    """Idempotent index creation for the book_factory_jobs collection."""
    await db[COLL].create_index("jobId", unique=True)
    await db[COLL].create_index([("state", 1), ("updatedAt", -1)])
    await db[COLL].create_index([("authoredBy", 1), ("updatedAt", -1)])


# ── atomic claim / fencing primitives ──────────────────────────────────────
async def _claim_stage(db, job_id: str, path: str, owner: str | None = None):
    """Atomic compare-and-set claim for one stage (blueprint or a chapter).

    Fails to claim when the job is cancelled or the chapter is locked (both are
    enforced INSIDE the claim filter, not by a prior read). Demotes a stale
    `provider_pending` lease to `unknown_outcome` FIRST (never auto-reclaimed),
    then wins only if the stage is `pending`, an EXPIRED `claimed` lease, or
    `failed_retryable` with attempts remaining.

    Returns (claimed_doc | None, attemptId).  None means the claim was lost.
    """
    now = _now_iso()
    oc = _owner_clause(owner)

    # Stale provider_pending → unknown_outcome (NOT reclaimable).
    await db[COLL].update_one(
        {"_id": job_id, **oc,
         "state": {"$ne": _JOB_CANCELLED},
         f"{path}.state": S_PROVIDER_PENDING,
         f"{path}.claimExpiresAt": {"$lt": now}},
        {"$set": {f"{path}.state": S_UNKNOWN, "updatedAt": now}},
    )

    attempt = _mint_attempt()
    claim_filter = {
        "_id": job_id, **oc,
        "state": {"$ne": _JOB_CANCELLED},
        f"{path}.locked": {"$ne": True},
        "$or": [
            {f"{path}.state": S_PENDING},
            {f"{path}.state": S_CLAIMED, f"{path}.claimExpiresAt": {"$lt": now}},
            {f"{path}.state": S_FAILED_RETRYABLE,
             f"{path}.attemptCount": {"$lt": MAX_RETRIES + 1}},
        ],
    }
    claim_update = {
        "$set": {
            f"{path}.state": S_CLAIMED,
            f"{path}.attemptId": attempt,
            f"{path}.claimedAt": now,
            f"{path}.claimExpiresAt": _iso_in(CLAIM_LEASE_S),
            "updatedAt": now,
        },
        # generationVersion advances exactly ONCE here per claim (retry /
        # regenerate reset the stage but never $inc genver themselves).
        "$inc": {f"{path}.attemptCount": 1, f"{path}.generationVersion": 1},
    }
    kwargs = {}
    if ReturnDocument is not None:
        kwargs["return_document"] = ReturnDocument.AFTER
    claimed = await db[COLL].find_one_and_update(claim_filter, claim_update, **kwargs)
    return claimed, attempt


async def _fence_provider(db, job_id: str, path: str, attempt: str, genver: int,
                          owner: str | None = None) -> bool:
    """claimed → provider_pending, fenced on attemptId + generationVersion +
    owner + not-cancelled.  Gemini is called only when this returns True."""
    now = _now_iso()
    kwargs = {"return_document": ReturnDocument.AFTER} if ReturnDocument is not None else {}
    fenced = await db[COLL].find_one_and_update(
        {"_id": job_id, **_owner_clause(owner), "state": {"$ne": _JOB_CANCELLED},
         f"{path}.attemptId": attempt, f"{path}.generationVersion": genver,
         f"{path}.state": S_CLAIMED},
        {"$set": {f"{path}.state": S_PROVIDER_PENDING,
                  f"{path}.providerRequestStartedAt": now, "updatedAt": now}},
        **kwargs,
    )
    return fenced is not None


async def _complete_stage(db, job_id: str, path: str, attempt: str, genver: int,
                          fields: dict, owner: str | None = None) -> bool:
    """provider_pending → completed, fenced on attemptId + generationVersion +
    owner + the job NOT being cancelled (§BLOCKER 2) + the chapter NOT being
    locked (§BLOCKER 3).  A superseded attempt, a stale generation version, a
    late completion on a cancelled job, or a write into a chapter that became
    locked can never win."""
    now = _now_iso()
    setter = {f"{path}.{k}": v for k, v in fields.items()}
    setter[f"{path}.state"] = S_COMPLETED
    setter[f"{path}.completedAt"] = now
    setter["updatedAt"] = now
    kwargs = {"return_document": ReturnDocument.AFTER} if ReturnDocument is not None else {}
    done = await db[COLL].find_one_and_update(
        {"_id": job_id, **_owner_clause(owner), "state": {"$ne": _JOB_CANCELLED},
         f"{path}.attemptId": attempt, f"{path}.generationVersion": genver,
         f"{path}.locked": {"$ne": True},
         f"{path}.state": S_PROVIDER_PENDING},
        {"$set": setter},
        **kwargs,
    )
    return done is not None


async def _fail_stage(db, job_id: str, path: str, attempt: str, genver: int,
                      reason: str, extra: dict | None = None, owner: str | None = None) -> str | None:
    """Mark the current attempt failed_retryable (until the attempt budget is
    exhausted, then failed_terminal). Fenced on attemptId + generationVersion +
    owner + not-cancelled (§BLOCKER 2) + not-locked (§BLOCKER 3)."""
    now = _now_iso()
    doc = await db[COLL].find_one({"_id": job_id})
    attempt_count = int(_get_path(doc, path).get("attemptCount", 0))
    new_state = S_FAILED_TERMINAL if attempt_count >= MAX_RETRIES + 1 else S_FAILED_RETRYABLE
    setter = {f"{path}.state": new_state, f"{path}.lastError": reason, "updatedAt": now}
    for k, v in (extra or {}).items():
        setter[f"{path}.{k}"] = v
    kwargs = {"return_document": ReturnDocument.AFTER} if ReturnDocument is not None else {}
    done = await db[COLL].find_one_and_update(
        {"_id": job_id, **_owner_clause(owner), "state": {"$ne": _JOB_CANCELLED},
         f"{path}.attemptId": attempt, f"{path}.generationVersion": genver,
         f"{path}.locked": {"$ne": True},
         f"{path}.state": {"$in": [S_CLAIMED, S_PROVIDER_PENDING]}},
        {"$set": setter},
        **kwargs,
    )
    return new_state if done else None


async def _fail_terminal(db, job_id: str, path: str, attempt: str, genver: int,
                         reason: str, extra: dict | None = None, owner: str | None = None) -> str | None:
    """§BLOCKER 2: set state = failed_terminal UNCONDITIONALLY (bypassing the
    attempt-count classifier). Used for BFTerminalError and semantic-response
    failures that must never auto-retry. Fenced on attemptId + generationVersion
    + owner + not-cancelled + not-locked."""
    now = _now_iso()
    setter = {f"{path}.state": S_FAILED_TERMINAL, f"{path}.lastError": reason, "updatedAt": now}
    for k, v in (extra or {}).items():
        setter[f"{path}.{k}"] = v
    kwargs = {"return_document": ReturnDocument.AFTER} if ReturnDocument is not None else {}
    done = await db[COLL].find_one_and_update(
        {"_id": job_id, **_owner_clause(owner), "state": {"$ne": _JOB_CANCELLED},
         f"{path}.attemptId": attempt, f"{path}.generationVersion": genver,
         f"{path}.locked": {"$ne": True},
         f"{path}.state": {"$in": [S_CLAIMED, S_PROVIDER_PENDING]}},
        {"$set": setter},
        **kwargs,
    )
    return S_FAILED_TERMINAL if done else None


async def _fail_unknown(db, job_id: str, path: str, attempt: str, genver: int,
                        reason: str, extra: dict | None = None, owner: str | None = None) -> str | None:
    """§BLOCKER 2: set state = unknown_outcome (manual-retry-only) when the
    provider outcome is unknown. Fenced on attemptId + generationVersion +
    owner + not-cancelled + not-locked."""
    now = _now_iso()
    setter = {f"{path}.state": S_UNKNOWN, f"{path}.lastError": reason, "updatedAt": now}
    for k, v in (extra or {}).items():
        setter[f"{path}.{k}"] = v
    kwargs = {"return_document": ReturnDocument.AFTER} if ReturnDocument is not None else {}
    done = await db[COLL].find_one_and_update(
        {"_id": job_id, **_owner_clause(owner), "state": {"$ne": _JOB_CANCELLED},
         f"{path}.attemptId": attempt, f"{path}.generationVersion": genver,
         f"{path}.locked": {"$ne": True},
         f"{path}.state": {"$in": [S_CLAIMED, S_PROVIDER_PENDING]}},
        {"$set": setter},
        **kwargs,
    )
    return S_UNKNOWN if done else None


def _budget_extra(budget: dict) -> dict:
    return {
        "providerCallCount": int(budget.get("providerCallCount") or 0),
        "jsonRetryUsed": bool(budget.get("jsonRetryUsed")),
        "malformedRetryUsed": bool(budget.get("malformedRetryUsed")),
    }


# ── stage orchestration ────────────────────────────────────────────────────
async def _run_blueprint(db, job_id: str, owner: str | None = None) -> dict:
    path = "blueprint"
    claimed, attempt = await _claim_stage(db, job_id, path, owner=owner)
    if claimed is None:
        doc = await db[COLL].find_one({"_id": job_id})
        return {"status": "skipped", "reason": _get_path(doc, path).get("state")}
    genver = int(_get_path(claimed, path).get("generationVersion") or 0)

    if not await _fence_provider(db, job_id, path, attempt, genver, owner=owner):
        return {"status": "superseded"}

    config = claimed.get("config") or {}
    budget = {"providerCallCount": 0, "jsonRetryUsed": False}
    try:
        semantic = await _call_provider(bf_gemini.generate_blueprint, config, budget=budget)
    except BFTerminalError as exc:  # §BLOCKER 2: terminal is terminal — no retry
        st = await _fail_terminal(db, job_id, path, attempt, genver, f"{type(exc).__name__}: {exc}", _budget_extra(budget), owner=owner)
        return {"status": "failed", "state": st}
    except BFUnknownOutcomeError as exc:
        st = await _fail_unknown(db, job_id, path, attempt, genver, f"{type(exc).__name__}: {exc}", _budget_extra(budget), owner=owner)
        return {"status": "unknown", "state": st}
    except BFRetryableError as exc:
        st = await _fail_stage(db, job_id, path, attempt, genver, f"{type(exc).__name__}: {exc}", _budget_extra(budget), owner=owner)
        return {"status": "failed", "state": st}
    except Exception as exc:  # noqa: BLE001 — any other adapter fault is retryable
        st = await _fail_stage(db, job_id, path, attempt, genver, f"{type(exc).__name__}: {exc}", _budget_extra(budget), owner=owner)
        return {"status": "failed", "state": st}

    # §BLOCKER 4: bound + validate the returned chapter list BEFORE persisting.
    raw_chapters = semantic.get("chapters") if isinstance(semantic, dict) else None
    expected = _expected_chapter_total(config)
    ok, reason = validate_blueprint_chapters(raw_chapters, expected)
    if not ok:
        st = await _fail_stage(db, job_id, path, attempt, genver, reason, _budget_extra(budget), owner=owner)
        return {"status": "failed", "state": st, "reason": reason}

    chapters: dict[str, dict] = {}
    order: list[str] = []
    for i, ch in enumerate(raw_chapters):
        cid = "bf_ch_" + uuid.uuid4().hex[:8]
        is_review = bool(config.get("includeReviewChapter")) and i == len(raw_chapters) - 1
        chapters[cid] = {
            "chapterId": cid,
            "position": i,
            "title": (ch.get("title") or f"Chapter {i + 1}"),
            "objective": ch.get("objective") or "",
            "outline": ch.get("outline") or "",
            "isReview": is_review,
            "state": S_PENDING,
            "locked": False,
            "attemptId": None,
            "attemptCount": 0,
            "generationVersion": 0,
            "providerCallCount": 0,
            "jsonRetryUsed": False,
            "malformedRetryUsed": False,
            "focusedInstruction": "",
            "warnings": [],
        }
        order.append(cid)

    # §BLOCKER C: co-write blueprint completion + chapters + chapterOrder +
    # job state in ONE fenced Mongo operation.
    now = _now_iso()
    kwargs = {"return_document": ReturnDocument.AFTER} if ReturnDocument is not None else {}
    done = await db[COLL].find_one_and_update(
        {"_id": job_id, **_owner_clause(owner), "state": {"$ne": _JOB_CANCELLED},
         f"{path}.attemptId": attempt,
         f"{path}.generationVersion": genver,
         f"{path}.state": S_PROVIDER_PENDING},
        {"$set": {
            f"{path}.state": S_COMPLETED,
            f"{path}.completedAt": now,
            f"{path}.summary": semantic.get("summary", ""),
            f"{path}.providerCallCount": int(budget.get("providerCallCount") or 0),
            f"{path}.jsonRetryUsed": bool(budget.get("jsonRetryUsed")),
            "chapters": chapters,
            "chapterOrder": order,
            "state": "blueprint_ready",
            "updatedAt": now,
        }},
        **kwargs,
    )
    if done is None:
        return {"status": "superseded"}
    return {"status": "completed", "stage": "blueprint", "chapterOrder": order}


# ── Phase 2: optional AI cover-image stage ──────────────────────────────────
async def _run_cover(db, job_id: str, owner: str | None = None) -> dict:
    """Claim → fence → call the isolated image adapter → complete/fail.
    Uses the SAME generic primitives as _run_blueprint; a cover failure of any
    kind never touches blueprint/chapters and never blocks export."""
    path = "cover"
    claimed, attempt = await _claim_stage(db, job_id, path, owner=owner)
    if claimed is None:
        doc = await db[COLL].find_one({"_id": job_id})
        return {"status": "skipped", "reason": _get_path(doc, path).get("state")}
    genver = int(_get_path(claimed, path).get("generationVersion") or 0)

    if not await _fence_provider(db, job_id, path, attempt, genver, owner=owner):
        return {"status": "superseded"}

    config = claimed.get("config") or {}
    cover_kwargs = dict(
        title=str(config.get("title") or ""), topic=str(config.get("topic") or ""),
        section=str(config.get("section") or "story"), level=str(config.get("level") or "A2"),
        tier=str(config.get("tier") or "free"), accent=str(config.get("accent") or "#D4A843"),
    )
    try:
        gen = await bf_image.generate_cover_image_bytes(**cover_kwargs)
    except BFTerminalError as exc:
        st = await _fail_terminal(db, job_id, path, attempt, genver, f"{type(exc).__name__}: {exc}", owner=owner)
        return {"status": "failed", "state": st}
    except BFUnknownOutcomeError as exc:
        st = await _fail_unknown(db, job_id, path, attempt, genver, f"{type(exc).__name__}: {exc}", owner=owner)
        return {"status": "unknown", "state": st}
    except BFRetryableError as exc:
        st = await _fail_stage(db, job_id, path, attempt, genver, f"{type(exc).__name__}: {exc}", owner=owner)
        return {"status": "failed", "state": st}
    except Exception as exc:  # noqa: BLE001
        st = await _fail_stage(db, job_id, path, attempt, genver, f"{type(exc).__name__}: {exc}", owner=owner)
        return {"status": "failed", "state": st}

    # The image bytes now exist in memory — a storage failure below must
    # NEVER trigger a second paid Gemini call. Retry ONLY the upload, bounded,
    # reusing these SAME bytes (store_cover_image also HEAD-checks first, so
    # a retry after a PARTIAL failure — upload actually succeeded but the
    # response was lost — reuses the already-stored object instead of
    # re-uploading).
    url = None
    upload_exc: Exception | None = None
    for _ in range(3):
        try:
            url = await bf_image.store_cover_image(
                job_id=job_id, attempt_id=attempt, image_bytes=gen["image_bytes"],
                mime=gen["mimeType"], ext=gen["ext"], admin_email=owner or "",
                title=cover_kwargs["title"], section=cover_kwargs["section"],
                level=cover_kwargs["level"], tier=cover_kwargs["tier"],
            )
            upload_exc = None
            break
        except BFTerminalError as exc:
            st = await _fail_terminal(db, job_id, path, attempt, genver, f"{type(exc).__name__}: {exc}", owner=owner)
            return {"status": "failed", "state": st}
        except Exception as exc:  # noqa: BLE001 — retryable upload failure, same bytes
            upload_exc = exc
            continue
    if url is None:
        st = await _fail_stage(db, job_id, path, attempt, genver,
                               f"cover storage failed after retries: {upload_exc}", owner=owner)
        return {"status": "failed", "state": st}
    result = {"url": url, "mimeType": gen["mimeType"]}

    # The image is already safely stored on R2 at this point. A failure to
    # persist the completion in Mongo (transient write error, brief network
    # blip) must NEVER trigger a second paid Gemini call — retry ONLY the DB
    # write, bounded, reusing the SAME already-generated result.
    ok = False
    last_exc: Exception | None = None
    for db_attempt in range(3):
        try:
            ok = await _complete_stage(db, job_id, path, attempt, genver, {
                "coverImage": result["url"], "mimeType": result["mimeType"],
            }, owner=owner)
            break
        except Exception as exc:  # noqa: BLE001 — transient Mongo error, retry the write only
            last_exc = exc
            log.warning("book_factory: cover completion write failed (attempt %d/3): %s",
                        db_attempt + 1, exc)
            continue
    if not ok:
        if last_exc is not None:
            # The image IS stored at a deterministic, discoverable key
            # (book-covers/{job_id}/{attempt}.*); a subsequent manual
            # "Generate Cover" retry within this SAME unresolved attempt would
            # find and reuse it rather than paying for a new image. Report a
            # clear, non-silent failure rather than pretending success.
            return {"status": "failed", "state": "unknown_outcome",
                    "reason": f"cover generated and stored but completion write failed: {last_exc}",
                    "coverImage": result["url"]}
        return {"status": "superseded"}
    return {"status": "completed", "stage": "cover", "coverImage": result["url"]}


_NARRATION_STAGE_TEMPLATE = {
    "state": S_PENDING, "attemptId": None, "attemptCount": 0,
    "generationVersion": 0, "providerCallCount": 0,
    "voice": "", "revision": None, "wordCount": None,
}


async def _seed_stage_if_absent(db, job_id: str, path: str, template: dict, owner: str | None = None) -> None:
    """Lazily create a per-chapter stage sub-document the first time it is
    requested. Idempotent — a no-op if the sub-document already exists."""
    await db[COLL].update_one(
        {"_id": job_id, **_owner_clause(owner), f"{path}": {"$exists": False}},
        {"$set": {path: dict(template)}},
    )


class _NarrationHTTPOutcome:
    """Classifies an HTTPException raised by the extracted
    run_elevenlabs_for_chapter into the SAME conservative taxonomy used
    everywhere else (§AMENDMENT 4): proven-not-sent → retryable; anything
    ambiguous → unknown_outcome; a structural/config problem → terminal."""
    TERMINAL_STATUSES = {400, 404}
    RETRYABLE_STATUSES = {500, 502, 503}


async def _run_narration_chapter(
    db, job_id: str, chapter_id: str, saved_index: int, slug: str,
    voice_id: str, owner: str, run_elevenlabs_fn,
) -> dict:
    """Claim → fence → call the extracted ElevenLabs core function → complete
    or fail, using the SAME generic primitives as blueprint/chapter/cover
    stages, keyed by the chapter's STABLE chapterId."""
    path = f"narration.{chapter_id}"
    await _seed_stage_if_absent(db, job_id, path, _NARRATION_STAGE_TEMPLATE, owner=owner)

    claimed, attempt = await _claim_stage(db, job_id, path, owner=owner)
    if claimed is None:
        doc = await db[COLL].find_one({"_id": job_id})
        return {"status": "skipped", "reason": _get_path(doc, path).get("state")}
    genver = int(_get_path(claimed, path).get("generationVersion") or 0)

    if not await _fence_provider(db, job_id, path, attempt, genver, owner=owner):
        return {"status": "superseded"}

    try:
        result = await run_elevenlabs_fn(
            slug=slug, chapter_index=saved_index, raw_voice=voice_id,
            book_in=None,  # always re-fetch the CURRENT saved revision by slug
            admin_email=owner,
        )
    except HTTPException as exc:
        status = exc.status_code
        reason = f"HTTPException {status}: {exc.detail}"
        if status in _NarrationHTTPOutcome.TERMINAL_STATUSES:
            st = await _fail_terminal(db, job_id, path, attempt, genver, reason, owner=owner)
            return {"status": "failed", "state": st}
        if status in _NarrationHTTPOutcome.RETRYABLE_STATUSES:
            st = await _fail_stage(db, job_id, path, attempt, genver, reason, owner=owner)
            return {"status": "failed", "state": st}
        # Any other status is ambiguous — manual retry only, never silently
        # re-attempted (§AMENDMENT 4: do not classify everything as retryable).
        st = await _fail_unknown(db, job_id, path, attempt, genver, reason, owner=owner)
        return {"status": "unknown", "state": st}
    except Exception as exc:  # noqa: BLE001 — unclassified failure: safest default is unknown, not retryable
        st = await _fail_unknown(db, job_id, path, attempt, genver, f"{type(exc).__name__}: {exc}", owner=owner)
        return {"status": "unknown", "state": st}

    ok = await _complete_stage(db, job_id, path, attempt, genver, {
        "voice": result.get("voice", voice_id),
        "revision": result.get("revision"),
        "wordCount": result.get("wordCount"),
    }, owner=owner)
    if not ok:
        return {"status": "superseded"}
    return {"status": "completed", "chapterId": chapter_id, "revision": result.get("revision")}


# ── Phase 4: persisted line-level conversation-audio automation ────────────
_CONV_LINE_STAGE_TEMPLATE = {
    "state": S_PENDING, "attemptId": None, "attemptCount": 0,
    "generationVersion": 0, "providerCallCount": 0,
    "speaker": "", "text": "", "voiceId": "", "pauseAfter": 0.35,
    "audioUrl": "", "wordTimestamps": [], "duration": 0.0,
}
_CONV_ASSEMBLY_STAGE_TEMPLATE = {
    "state": S_PENDING, "attemptId": None, "attemptCount": 0,
    "generationVersion": 0, "audioUrl": "", "totalDuration": 0.0,
}


def init_conversation_audio_chapter(
    doc: dict, chapter_id: str, voice_assignments: dict, pause_after: float,
) -> dict | None:
    """Build (or safely update) the persisted line map for one chapter's
    dialog blocks. Returns the `$set` patch to apply, or None if the chapter
    has no dialog lines. Idempotent + resume-safe:
      * First call: seeds every line as pending with its assigned voice.
      * Later calls (e.g. the teacher tweaks a voice mapping, or a lost
        response is retried): a line already `completed` is NEVER reset —
        its stored audioUrl/timestamps/state are preserved untouched. Only
        `pending` / `failed_retryable` / `failed_terminal` / `unknown_outcome`
        lines pick up a new voiceId/pauseAfter, and only `text`/`speaker`
        stay in sync with the composed chapter (they never change unless the
        chapter itself is regenerated, which invalidates this whole map —
        see the caller's regeneration-detection check).
    """
    chapters = doc.get("chapters") or {}
    chapter = chapters.get(chapter_id)
    if not chapter:
        return None
    lines = bf_conv.extract_dialog_lines(chapter.get("blocks") or [])
    if not lines:
        return None

    existing = ((doc.get("conversationAudio") or {}).get(chapter_id) or {})
    existing_lines = existing.get("lines") or {}
    existing_line_order = existing.get("lineOrder") or []

    # Regeneration guard: if the persisted lineOrder no longer matches the
    # CURRENT composed dialog lines (different count/text), the chapter was
    # regenerated since this map was built — start a fresh map rather than
    # silently mixing stale completed audio with new text.
    stale = (
        existing_line_order
        and (len(existing_line_order) != len(lines)
             or any(existing_lines.get(l["lineId"], {}).get("text") != l["text"] for l in lines))
    )

    new_lines: dict[str, dict] = {}
    for l in lines:
        prior = {} if stale else existing_lines.get(l["lineId"], {})
        if prior.get("state") == S_COMPLETED:
            new_lines[l["lineId"]] = prior  # never touch a completed line
            continue
        voice_id = voice_assignments.get(l["speaker"]) or (prior.get("voiceId") or "")
        new_lines[l["lineId"]] = {
            **_CONV_LINE_STAGE_TEMPLATE,
            **{k: v for k, v in prior.items() if k in ("state", "attemptId", "attemptCount",
                                                        "generationVersion", "claimExpiresAt",
                                                        "lastError")},
            "speaker": l["speaker"], "text": l["text"], "blockIndex": l["blockIndex"],
            "voiceId": voice_id, "pauseAfter": float(pause_after),
        }

    return {
        "lines": new_lines,
        "lineOrder": [l["lineId"] for l in lines],
        "assembly": existing.get("assembly") or dict(_CONV_ASSEMBLY_STAGE_TEMPLATE),
    }


async def _run_conversation_line(
    db, job_id: str, chapter_id: str, line_id: str, owner: str, run_conversation_line_fn,
) -> dict:
    """Claim → fence → generate ONE line's audio → persist to R2 → complete.
    Same generic primitives as every other stage; keyed on the STABLE lineId
    (never an array position)."""
    path = f"conversationAudio.{chapter_id}.lines.{line_id}"
    claimed, attempt = await _claim_stage(db, job_id, path, owner=owner)
    if claimed is None:
        doc = await db[COLL].find_one({"_id": job_id})
        return {"status": "skipped", "reason": _get_path(doc, path).get("state")}
    genver = int(_get_path(claimed, path).get("generationVersion") or 0)

    if not await _fence_provider(db, job_id, path, attempt, genver, owner=owner):
        return {"status": "superseded"}

    spec = _get_path(claimed, path)
    try:
        result = await run_conversation_line_fn(
            text=spec.get("text") or "", voice_id=spec.get("voiceId") or "",
            emotion="neutral", acting_note_extra="", voice_settings=None,
        )
    except HTTPException as exc:
        status = exc.status_code
        reason = f"HTTPException {status}: {exc.detail}"
        if status in _NarrationHTTPOutcome.TERMINAL_STATUSES:
            st = await _fail_terminal(db, job_id, path, attempt, genver, reason, owner=owner)
            return {"status": "failed", "state": st}
        if status in _NarrationHTTPOutcome.RETRYABLE_STATUSES:
            st = await _fail_stage(db, job_id, path, attempt, genver, reason, owner=owner)
            return {"status": "failed", "state": st}
        st = await _fail_unknown(db, job_id, path, attempt, genver, reason, owner=owner)
        return {"status": "unknown", "state": st}
    except Exception as exc:  # noqa: BLE001 — unclassified: safest default is unknown
        st = await _fail_unknown(db, job_id, path, attempt, genver, f"{type(exc).__name__}: {exc}", owner=owner)
        return {"status": "unknown", "state": st}

    import base64 as _b64
    try:
        audio_bytes = _b64.b64decode(result.get("audio_base64") or "", validate=False)
        if not audio_bytes:
            raise ValueError("empty audio")
    except Exception as exc:  # noqa: BLE001 — malformed success, not retryable by re-calling Gemini/ElevenLabs
        st = await _fail_terminal(db, job_id, path, attempt, genver, f"empty_or_invalid_audio: {exc}", owner=owner)
        return {"status": "failed", "state": st}

    # Audio bytes already exist in memory — a storage failure must NEVER
    # trigger a second paid provider call. Retry ONLY the upload, bounded,
    # reusing these SAME bytes (store_line_audio also HEAD-checks first, so
    # a retry after a partial failure reuses the already-stored object).
    audio_url = None
    upload_exc: Exception | None = None
    for _ in range(3):
        try:
            audio_url = await bf_conv.store_line_audio(job_id, chapter_id, line_id, attempt, audio_bytes)
            upload_exc = None
            break
        except Exception as exc:  # noqa: BLE001
            upload_exc = exc
            continue
    if audio_url is None:
        st = await _fail_stage(db, job_id, path, attempt, genver,
                               f"storage_failed_after_retries: {upload_exc}", owner=owner)
        return {"status": "failed", "state": st}

    # Audio is safely stored — a completion-write failure must retry ONLY the
    # DB write, never re-generate (same pattern as the cover stage).
    ok = False
    last_exc: Exception | None = None
    for _ in range(3):
        try:
            ok = await _complete_stage(db, job_id, path, attempt, genver, {
                "audioUrl": audio_url,
                "wordTimestamps": result.get("word_timestamps") or [],
                "duration": float(result.get("duration") or 0.0),
            }, owner=owner)
            break
        except Exception as exc:  # noqa: BLE001
            last_exc = exc
            continue
    if not ok:
        if last_exc is not None:
            return {"status": "failed", "state": "unknown_outcome",
                    "reason": f"line audio stored but completion write failed: {last_exc}",
                    "audioUrl": audio_url}
        return {"status": "superseded"}
    return {"status": "completed", "lineId": line_id, "audioUrl": audio_url}


async def _run_conversation_assembly(
    db, job_id: str, chapter_id: str, saved_index: int, slug: str, owner: str, assemble_fn,
) -> dict:
    """Claim → fence → fetch every completed line's stored audio → stitch →
    save a new book revision → complete. Only invoked by the route AFTER it
    has verified every required line is `completed` — a stale/incomplete
    claim can still lose the race to a concurrent request via the generic
    fencing, but this function does not itself re-check completeness (the
    route's pre-check + the atomic claim together are sufficient: a stage
    that reached `pending`/`failed_retryable` can only be claimed once)."""
    path = f"conversationAudio.{chapter_id}.assembly"
    claimed, attempt = await _claim_stage(db, job_id, path, owner=owner)
    if claimed is None:
        doc = await db[COLL].find_one({"_id": job_id})
        return {"status": "skipped", "reason": _get_path(doc, path).get("state")}
    genver = int(_get_path(claimed, path).get("generationVersion") or 0)

    if not await _fence_provider(db, job_id, path, attempt, genver, owner=owner):
        return {"status": "superseded"}

    conv = (claimed.get("conversationAudio") or {}).get(chapter_id) or {}
    order = conv.get("lineOrder") or []
    lines_map = conv.get("lines") or {}

    line_audio_results = []
    try:
        for line_id in order:
            spec = lines_map.get(line_id) or {}
            if spec.get("state") != S_COMPLETED:
                raise ValueError(f"line {line_id} is not completed (state={spec.get('state')})")
            audio_bytes = await bf_conv.fetch_line_audio_bytes(spec["audioUrl"])
            line_audio_results.append({
                "blockIndex": spec.get("blockIndex"), "speaker": spec.get("speaker"),
                "audio_bytes": audio_bytes, "word_timestamps": spec.get("wordTimestamps") or [],
                "duration": spec.get("duration") or 0.0, "pauseAfter": spec.get("pauseAfter", 0.35),
            })
    except Exception as exc:  # noqa: BLE001 — fetch failure is retryable (nothing destructive happened)
        st = await _fail_stage(db, job_id, path, attempt, genver, f"{type(exc).__name__}: {exc}", owner=owner)
        return {"status": "failed", "state": st}

    try:
        result = await assemble_fn(
            slug=slug, chapter_index=saved_index, line_audio_results=line_audio_results, admin_email=owner,
        )
    except HTTPException as exc:
        status = exc.status_code
        reason = f"HTTPException {status}: {exc.detail}"
        if status in _NarrationHTTPOutcome.TERMINAL_STATUSES:
            st = await _fail_terminal(db, job_id, path, attempt, genver, reason, owner=owner)
            return {"status": "failed", "state": st}
        st = await _fail_stage(db, job_id, path, attempt, genver, reason, owner=owner)
        return {"status": "failed", "state": st}
    except Exception as exc:  # noqa: BLE001
        st = await _fail_stage(db, job_id, path, attempt, genver, f"{type(exc).__name__}: {exc}", owner=owner)
        return {"status": "failed", "state": st}

    ok = False
    last_exc: Exception | None = None
    for _ in range(3):
        try:
            ok = await _complete_stage(db, job_id, path, attempt, genver, {
                "audioUrl": result["audioUrl"], "totalDuration": result["totalDuration"],
            }, owner=owner)
            break
        except Exception as exc:  # noqa: BLE001
            last_exc = exc
            continue
    if not ok:
        if last_exc is not None:
            return {"status": "failed", "state": "unknown_outcome",
                    "reason": f"assembly saved but completion write failed: {last_exc}",
                    "audioUrl": result["audioUrl"], "revision": result.get("revision")}
        return {"status": "superseded"}
    return {"status": "completed", "audioUrl": result["audioUrl"], "revision": result.get("revision")}


async def _validate_and_compose(semantic: dict, level: str = "A2") -> tuple[list[dict], list[dict]]:
    """NO in-stage repair. Validate each MCQ once; on failure drop it and record
    an mcq_dropped warning. Validate fillblanks; on failure drop it and record a
    fillblank_dropped warning (§MEDIUM 14). Validate + CEFR-cap vocabulary
    (§PART C/D/E: IPA/Khmer validated per item, quantity backend-authoritative
    regardless of what Gemini returned). Then compose canonical blocks.
    Returns (blocks, warnings)."""
    chapter_text = bf_composer.build_chapter_full_text(semantic)
    warnings: list[dict] = []
    validated: list[dict] = []

    for mcq in semantic.get("mcqs") or []:
        ok, reason = bf_validator.validate_mcq(mcq, chapter_text)
        if ok:
            validated.append(mcq)
            continue
        warnings.append({
            "type": "mcq_dropped",
            "reason": reason,
            "question": (mcq.get("question") if isinstance(mcq, dict) else None),
        })

    # §MEDIUM 14: dropped fill-blanks are recorded as author-visible warnings
    # (the rest of the chapter is preserved; no re-call to Gemini).
    fillblanks: list[dict] = []
    for fb in semantic.get("fillblanks") or []:
        ok, reason = bf_validator.validate_fillblank(fb)
        if ok:
            fillblanks.append(fb)
            continue
        warnings.append({
            "type": "fillblank_dropped",
            "reason": reason,
            "text": (fb.get("text") if isinstance(fb, dict) else None),
        })

    # §PART C/D/E: vocabulary — IPA/Khmer validated per item (never fabricated;
    # a bad IPA or missing Khmer degrades gracefully rather than dropping the
    # whole word), and CEFR-scaled quantity is a HARD backend-authoritative
    # cap — Gemini returning more than the level supports never reaches export.
    _vocab_lo, vocab_hi = bf_validator.vocab_count_range(level)
    validated_vocab: list[dict] = []
    for v in semantic.get("vocabulary") or []:
        if len(validated_vocab) >= vocab_hi:
            break
        item, item_warnings = bf_validator.validate_vocab_item(v)
        for w in item_warnings:
            warnings.append({"type": "vocab_issue", "reason": w})
        if item:
            validated_vocab.append(item)

    blocks = bf_composer.compose_chapter_blocks(semantic, validated, fillblanks, validated_vocab)
    return blocks, warnings


async def _run_chapter(db, job_id: str, chapter_id: str, owner: str | None = None) -> dict:
    path = f"chapters.{chapter_id}"
    pre = await db[COLL].find_one({"_id": job_id, **_owner_clause(owner)})
    if not pre or chapter_id not in (pre.get("chapters") or {}):
        raise HTTPException(status_code=404, detail="Chapter not found in job")

    claimed, attempt = await _claim_stage(db, job_id, path, owner=owner)
    if claimed is None:
        doc = await db[COLL].find_one({"_id": job_id})
        return {"status": "skipped", "reason": _get_path(doc, path).get("state")}
    genver = int(_get_path(claimed, path).get("generationVersion") or 0)

    if not await _fence_provider(db, job_id, path, attempt, genver, owner=owner):
        return {"status": "superseded"}

    config = claimed.get("config") or {}
    spec = _get_path(claimed, path)
    budget = {"providerCallCount": 0, "jsonRetryUsed": False, "malformedRetryUsed": False}
    try:
        semantic = await _call_provider(bf_gemini.generate_chapter, config, spec, budget=budget)
    except BFTerminalError as exc:  # §BLOCKER 2
        st = await _fail_terminal(db, job_id, path, attempt, genver, f"{type(exc).__name__}: {exc}", _budget_extra(budget), owner=owner)
        return {"status": "failed", "state": st}
    except BFUnknownOutcomeError as exc:
        st = await _fail_unknown(db, job_id, path, attempt, genver, f"{type(exc).__name__}: {exc}", _budget_extra(budget), owner=owner)
        return {"status": "unknown", "state": st}
    except BFRetryableError as exc:
        st = await _fail_stage(db, job_id, path, attempt, genver, f"{type(exc).__name__}: {exc}", _budget_extra(budget), owner=owner)
        return {"status": "failed", "state": st}
    except Exception as exc:  # noqa: BLE001
        st = await _fail_stage(db, job_id, path, attempt, genver, f"{type(exc).__name__}: {exc}", _budget_extra(budget), owner=owner)
        return {"status": "failed", "state": st}

    if not isinstance(semantic, dict):
        st = await _fail_terminal(db, job_id, path, attempt, genver, "chapter_not_object", _budget_extra(budget), owner=owner)
        return {"status": "failed", "state": st}

    try:
        blocks, warnings = await _validate_and_compose(semantic, level=config.get("level") or "A2")
    except Exception as exc:  # noqa: BLE001
        st = await _fail_stage(db, job_id, path, attempt, genver, f"compose_error: {exc}", _budget_extra(budget), owner=owner)
        return {"status": "failed", "state": st}

    if not blocks:
        # §PHASE B1/B2: persisted bounded malformed-success retry policy.
        #
        # A valid-JSON response that produces zero canonical blocks (e.g. the
        # provider returned {"paragraphs": "a string"} or {}) is a
        # malformed-success.  Per spec: one persisted retry is allowed if the
        # 2-call shared budget has a remaining slot.
        #
        # "Persisted" = malformedRetryUsed written to DB BEFORE the second call
        # so a worker crash between the two calls leaves the chapter in a state
        # where the NEXT claim correctly detects budget-exhausted and fails
        # terminal rather than making a phantom third call.
        #
        # The shared budget is: total HTTP calls (JSON retries + semantic
        # retries) ≤ HARD_MAX_PROVIDER_CALLS (2).  max_calls=remaining is
        # forwarded to generate_chapter so the second invocation never exceeds
        # its single remaining slot even if it encounters invalid JSON.
        calls_so_far = int(budget.get("providerCallCount") or 0)
        max_total = bf_gemini.effective_max_provider_calls()
        # Crash-recovery: malformedRetryUsed persisted from a previous run
        # of _run_chapter on this same (attempt, genver) means we already
        # used the retry in that run — go straight to terminal.
        already_used = bool(spec.get("malformedRetryUsed"))
        if not already_used and calls_so_far < max_total:
            remaining = max_total - calls_so_far  # ≥ 1
            # Persist BEFORE the second HTTP call (crash safety).
            await db[COLL].update_one(
                {"_id": job_id, **_owner_clause(owner),
                 f"{path}.attemptId": attempt,
                 f"{path}.generationVersion": genver,
                 f"{path}.state": S_PROVIDER_PENDING},
                {"$set": {f"{path}.malformedRetryUsed": True,
                          "updatedAt": _now_iso()}},
            )
            budget["malformedRetryUsed"] = True
            try:
                semantic = await _call_provider(
                    bf_gemini.generate_chapter, config, spec,
                    budget=budget, max_calls=remaining)
            except BFTerminalError as exc:
                st = await _fail_terminal(db, job_id, path, attempt, genver, f"{type(exc).__name__}: {exc}", _budget_extra(budget), owner=owner)
                return {"status": "failed", "state": st}
            except BFUnknownOutcomeError as exc:
                st = await _fail_unknown(db, job_id, path, attempt, genver, f"{type(exc).__name__}: {exc}", _budget_extra(budget), owner=owner)
                return {"status": "unknown", "state": st}
            except BFRetryableError as exc:
                st = await _fail_stage(db, job_id, path, attempt, genver, f"{type(exc).__name__}: {exc}", _budget_extra(budget), owner=owner)
                return {"status": "failed", "state": st}
            except Exception as exc:  # noqa: BLE001
                st = await _fail_stage(db, job_id, path, attempt, genver, f"{type(exc).__name__}: {exc}", _budget_extra(budget), owner=owner)
                return {"status": "failed", "state": st}
            if not isinstance(semantic, dict):
                st = await _fail_terminal(db, job_id, path, attempt, genver, "chapter_not_object_retry", _budget_extra(budget), owner=owner)
                return {"status": "failed", "state": st}
            try:
                blocks, warnings = await _validate_and_compose(semantic, level=config.get("level") or "A2")
            except Exception as exc:  # noqa: BLE001
                st = await _fail_stage(db, job_id, path, attempt, genver, f"compose_error_retry: {exc}", _budget_extra(budget), owner=owner)
                return {"status": "failed", "state": st}
            if not blocks:
                # Both calls exhausted — terminal.
                st = await _fail_terminal(db, job_id, path, attempt, genver, "empty_canonical_blocks", _budget_extra(budget), owner=owner)
                return {"status": "failed", "state": st, "reason": "empty_canonical_blocks"}
            # else: second call produced valid blocks — fall through to complete.
        else:
            # Budget exhausted by JSON retries (calls_so_far >= max_total) OR
            # crash recovery (already_used=True from previous run of this claim).
            st = await _fail_terminal(db, job_id, path, attempt, genver, "empty_canonical_blocks", _budget_extra(budget), owner=owner)
            return {"status": "failed", "state": st, "reason": "empty_canonical_blocks"}

    title = semantic.get("title") or spec.get("title") or "Chapter"
    ok = await _complete_stage(db, job_id, path, attempt, genver, {
        "title": title,
        "blocks": blocks,
        "warnings": warnings,
        "providerCallCount": int(budget.get("providerCallCount") or 0),
        "jsonRetryUsed": bool(budget.get("jsonRetryUsed")),
        "malformedRetryUsed": bool(budget.get("malformedRetryUsed")),
    }, owner=owner)
    if not ok:
        return {"status": "superseded"}
    return {"status": "completed", "chapterId": chapter_id, "warnings": warnings}


# ── views ──────────────────────────────────────────────────────────────────
# ── §PART H/I: explicit, teacher-facing cover state ─────────────────────────
# The raw job.cover.state only ever holds the 7 generic stage states — it
# cannot distinguish "the feature is off" / "no key" / "no storage" from
# "claimed" (those preconditions are checked BEFORE a claim is even
# attempted). This computes the single, unambiguous state + message the
# teacher should see, covering all 9 documented states.
_COVER_STATE_MESSAGES = {
    "featureDisabled": "AI cover generation is not enabled.",
    "keyUnavailable": "Gemini image service is unavailable.",
    "storageUnavailable": "Cover storage is not configured — cover was generated but could not be stored.",
    "pending": "Cover has not been generated yet.",
    "providerPending": "Generating your cover…",
    "completed": "AI cover generated.",
    "retryableFailure": "Cover generation failed — you can retry.",
    "terminalFailure": "Cover generation failed and will not retry automatically.",
    "unknownOutcome": "Cover generation outcome is unknown — manual review required before retry.",
}
_COVER_RAW_STATE_MAP = {
    S_PENDING: "pending", S_CLAIMED: "pending", S_PROVIDER_PENDING: "providerPending",
    S_COMPLETED: "completed", S_FAILED_RETRYABLE: "retryableFailure",
    S_FAILED_TERMINAL: "terminalFailure", S_UNKNOWN: "unknownOutcome",
}


def cover_teacher_status(doc: dict) -> dict:
    """Returns {"state": one of the 9 documented states, "message": teacher-
    facing text, "usingFallback": "manual_url" | "stylized" | None}. Never
    raises; a missing/malformed job.cover is treated as "pending"."""
    # NOTE: cover_generation_permitted() conflates "flag off" with "key
    # missing" into one boolean — checked here individually so the three
    # distinct precondition states are never collapsed into "featureDisabled".
    if not _flag("BOOK_FACTORY_COVER_ENABLED"):
        state = "featureDisabled"
    elif not bf_image.is_enabled():
        state = "keyUnavailable"
    elif not bf_image.storage_configured():
        state = "storageUnavailable"
    else:
        raw = (doc.get("cover") or {}).get("state") or S_PENDING
        state = _COVER_RAW_STATE_MAP.get(raw, "pending")

    cover_image = (doc.get("cover") or {}).get("coverImage") or ""
    manual_url = (doc.get("config") or {}).get("coverImage") or ""
    using_fallback = None
    if not cover_image:
        using_fallback = "manual_url" if manual_url else "stylized"

    return {
        "state": state,
        "message": _COVER_STATE_MESSAGES.get(state, ""),
        "usingFallback": using_fallback,
    }


def _job_view(doc: dict) -> dict:
    """Studio-facing job view (progress UI). NOT the canonical export."""
    if not doc:
        return {}
    out = {k: v for k, v in doc.items() if k != "_id"}
    out["coverTeacherStatus"] = cover_teacher_status(doc)
    return out


# ── §PART B/G: chapter-balance diagnostics (advisory only — never blocks
# save/publish/export; the teacher decides whether to regenerate a chapter) ─
_TEXT_BEARING_TYPES = frozenset({"paragraph", "heading", "quote", "markdown", "dialog"})
_CHAPTER_BALANCE_TOLERANCE = 0.25  # ±25%, per the surgical-pass spec


def _chapter_word_count(blocks: list[dict]) -> int:
    total = 0
    for b in blocks or []:
        if not isinstance(b, dict) or b.get("type") not in _TEXT_BEARING_TYPES:
            continue
        total += len(str(b.get("text") or "").split())
    return total


def check_chapter_balance(chapters_map: dict, order: list[str]) -> list[dict]:
    """Compare each NON-review completed chapter's word count against the
    MEDIAN of its peers. Returns a list of advisory warning dicts (never
    raises, never blocks anything) for any chapter outside
    ±_CHAPTER_BALANCE_TOLERANCE of that median.

    Median (not mean) deliberately: a single disproportionately long outlier
    chapter would otherwise drag the mean far enough that the OTHER, actually
    well-balanced chapters also appear "too short by comparison" — the median
    stays anchored to the typical chapter regardless of one outlier.
    """
    counted = []
    for cid in order:
        ch = chapters_map.get(cid) or {}
        if ch.get("state") != S_COMPLETED or ch.get("isReview"):
            continue
        counted.append((cid, ch.get("title") or cid, _chapter_word_count(ch.get("blocks") or [])))
    if len(counted) < 2:
        return []  # nothing to compare a single chapter against
    word_counts = sorted(c[2] for c in counted)
    n = len(word_counts)
    mid = n // 2
    baseline = word_counts[mid] if n % 2 else (word_counts[mid - 1] + word_counts[mid]) / 2
    if baseline <= 0:
        return []
    warnings = []
    for cid, title, words in counted:
        deviation = (words - baseline) / baseline
        if abs(deviation) > _CHAPTER_BALANCE_TOLERANCE:
            warnings.append({
                "type": "chapter_length_imbalance",
                "chapterId": cid,
                "title": title,
                "words": words,
                "averageWords": round(baseline, 1),
                "deviationPct": round(deviation * 100, 1),
            })
    return warnings


def _compute_export(doc: dict) -> dict:
    """Build the canonical export book + chapterId→saved-index map from a job
    document. Single source of truth reused by /export AND /save-draft so the
    two can never drift (§AMENDMENT 2: the saved-index map is exactly the
    ordering /save-draft persists into db.books)."""
    order = doc.get("chapterOrder") or []
    chapters_map = doc.get("chapters") or {}
    ordered: list[dict] = []
    chapter_id_to_index: dict[str, int] = {}
    for cid in order:
        ch = chapters_map.get(cid)
        if ch and ch.get("state") == S_COMPLETED:
            chapter_id_to_index[cid] = len(ordered)
            ordered.append({"title": ch.get("title"), "blocks": ch.get("blocks") or []})
    # Phase 2: an AI-generated cover (if the stage completed) overrides the
    # config default coverImage; a never-run or failed cover stage leaves the
    # author's manually-configured coverImage untouched (falls back to
    # StylizedCover in the Reader when both are empty).
    config = dict(doc.get("config") or {})
    cover_url = (doc.get("cover") or {}).get("coverImage")
    if cover_url:
        config["coverImage"] = cover_url
    book = bf_composer.export_canonical_book(config, ordered)
    speakers = bf_composer.extract_speakers(ordered)
    return {
        "book": book,
        "completed": len(ordered),
        "total": len(order),
        "speakers": speakers,
        "chapterIdToSavedIndex": chapter_id_to_index,
        "chapterBalanceWarnings": check_chapter_balance(chapters_map, order),
    }


def _export_hash(book: dict) -> str:
    """Deterministic content hash of a canonical export — used to detect a
    genuinely unchanged resave (§AMENDMENT 2/10: a lost-response retry must
    recover the existing binding, not mint a duplicate revision)."""
    return hashlib.sha256(json.dumps(book, sort_keys=True, default=str).encode("utf-8")).hexdigest()


def _mint_bf_slug(title: str, job_id: str) -> str:
    """A deterministic-enough slug seed: title text + a job-id suffix that is
    NEVER shared by any other job, so a Book-Factory-authored book can never
    silently become a revision of an unrelated manually-authored book that
    happens to share a title. The actual character-cleaning (lowercasing,
    stripping invalid chars) is left to server.py's slugify() — this function
    only needs to guarantee the uniqueness-bearing suffix survives that pass."""
    base = (title or "untitled").strip()[:80]
    suffix = re.sub(r"[^a-zA-Z0-9]", "", job_id or "")[-10:] or uuid.uuid4().hex[:10]
    return f"{base}-bf-{suffix}"


def _job_summary(doc: dict) -> dict:
    """Compact summary for the recent-jobs listing (§HIGH 7)."""
    cfg = doc.get("config") or {}
    return {
        "jobId": doc.get("jobId"),
        "title": cfg.get("title"),
        "state": doc.get("state"),
        "createdAt": doc.get("createdAt"),
        "updatedAt": doc.get("updatedAt"),
        "chapterCount": len(doc.get("chapterOrder") or []),
        "blueprintApprovedAt": doc.get("blueprintApprovedAt"),
    }


# ── route registration ─────────────────────────────────────────────────────
def register_book_factory_routes(
    api, db, require_admin, *,
    save_book_revision=None, publish_book=None, run_elevenlabs_for_chapter=None,
    get_book_by_slug=None, run_conversation_line=None, assemble_conversation_for_chapter=None,
) -> None:
    """Register Book Factory admin routes onto the shared /api router.

    `save_book_revision(payload_dict, admin_email) -> {slug, revision, book}`,
    `publish_book(slug) -> {matched, modified}`,
    `run_elevenlabs_for_chapter(slug=, chapter_index=, raw_voice=, book_in=,
    admin_email=) -> {...}`, and `get_book_by_slug(slug) -> dict | None` are
    the SAME functions/reads the manual Studio Editor routes use (extracted in
    server.py) — injected here so Book Factory's save-draft/publish/narration
    automation reuses one implementation instead of a second one, and so this
    module NEVER touches db.books directly (read or write) — preserving its
    documented hard guarantee. If a caller omits any of them (e.g. an isolated
    test harness exercising only blueprint/chapter routes), the corresponding
    new route 503s instead of raising at import time.
    """

    def _need_generation():
        if not factory_enabled():
            raise HTTPException(status_code=503, detail="Book Factory is disabled.")
        if not factory_gemini_enabled():
            raise HTTPException(status_code=503, detail="Book Factory Gemini is disabled or no API key.")

    def _need_enabled():
        if not factory_enabled():
            raise HTTPException(status_code=503, detail="Book Factory is disabled.")

    async def _owned_or_404(job_id: str, email: str | None) -> dict:
        """§BLOCKER 1: fetch a job scoped to the authenticated admin. A job owned
        by another admin is indistinguishable from a missing job (404, no leak)."""
        doc = await db[COLL].find_one({"_id": job_id, **_owner_clause(email)})
        if not doc:
            raise HTTPException(status_code=404, detail="Job not found")
        return doc

    @api.get("/studio/book-factory/status")
    async def book_factory_status(admin=Depends(require_admin)):
        return status_payload()

    @api.get("/studio/book-factory/jobs")
    async def book_factory_list_jobs(limit: int = 20, admin=Depends(require_admin)):
        # §HIGH 7 fallback recovery: only the requesting admin's RECENT,
        # non-cancelled jobs (updated within JOBS_RECENT_WINDOW_S), newest first.
        _need_enabled()
        email = _admin_email(admin)
        n = max(1, min(int(limit or 20), JOBS_LIST_MAX))
        cutoff = _iso_in(-JOBS_RECENT_WINDOW_S)
        # §PHASE E2: exclude dismissed and cancelled jobs from recent listing.
        cursor = (db[COLL]
                  .find({"authoredBy": email,
                         "state": {"$ne": _JOB_CANCELLED},
                         "dismissedAt": None,
                         "updatedAt": {"$gt": cutoff}})
                  .sort("updatedAt", -1)
                  .limit(n))
        docs = await cursor.to_list(length=n)
        return {"success": True, "jobs": [_job_summary(d) for d in docs]}

    @api.post("/studio/book-factory/jobs")
    async def book_factory_create_job(payload: dict, admin=Depends(require_admin)):
        _need_generation()
        config = payload.get("config") if isinstance(payload, dict) else None
        if not isinstance(config, dict):
            raise HTTPException(status_code=400, detail="config object is required.")
        errors = validate_book_factory_config(config)
        if errors:
            # §HIGH 9: reject BEFORE any job document is created.
            raise HTTPException(status_code=422, detail={"errors": errors})
        # §HIGH 9: persist ONLY the sanitized canonical configuration.
        canonical = build_canonical_config(config)
        job_id = "bf_job_" + uuid.uuid4().hex[:10]
        now = _now_iso()
        doc = {
            "_id": job_id,
            "jobId": job_id,
            "kind": "book_factory_job",
            "config": canonical,
            "state": "created",
            "blueprint": {
                "state": S_PENDING, "attemptId": None,
                "attemptCount": 0, "generationVersion": 0,
                "providerCallCount": 0, "jsonRetryUsed": False,
            },
            "blueprintApprovedAt": None,
            "chapters": {},
            "chapterOrder": [],
            # Phase 2: optional AI cover-image stage — same shape as blueprint.
            # Independent of blueprint/chapters; a failed/skipped cover never
            # blocks export (export falls back to config.coverImage / "").
            "cover": {
                "state": S_PENDING, "attemptId": None,
                "attemptCount": 0, "generationVersion": 0,
                "providerCallCount": 0, "coverImage": "", "mimeType": "",
            },
            # Phase 3: optional per-chapter narration automation stage map,
            # keyed by the chapter's STABLE chapterId (never an array index —
            # see _run_narration_chapter). Lazily populated on first request
            # for that chapterId.
            "narration": {},
            # Phase 4 (reserved, NOT wired to a route this session — see the
            # module docstring "conversation audio automation" note): a
            # single chapter-level claim around the existing multi-call-per-
            # line /conversation route would be falsely idempotent (a crash
            # mid-chapter would either duplicate paid ElevenLabs calls on
            # retry or lose progress). Real automation needs persisted
            # line-level stages (conversationAudio.{chapterId}.lines.{lineId})
            # plus a separate assembly stage — deferred as its own build.
            # Zero-copy CVS *seeding* (frontend) does not depend on this.
            "conversationAudio": {},
            # §AMENDMENT 2: server-authoritative binding to the saved db.books
            # document — narration/publish operate on THIS binding, never on
            # a slug supplied freely by a client request.
            "savedBookSlug": None,
            "savedBookRevision": None,
            "savedBookOwner": None,
            "savedBookExportHash": None,
            "savedAt": None,
            # Maps each completed chapter's stable chapterId to its index in
            # the LAST SAVED book's `chapters` array (skips any chapter still
            # incomplete at save time) — rebuilt on every save-draft call.
            # Narration resolves chapterId → array index through THIS map,
            # never through the job's own position/order (which counts every
            # chapter, including ones never exported).
            "chapterIdToSavedIndex": {},
            "publishedAt": None,
            "publishedRevision": None,
            "warnings": [],
            "createdAt": now,
            "updatedAt": now,
            "authoredBy": _admin_email(admin),
            "dismissedAt": None,
        }
        await db[COLL].insert_one(doc)
        return {"success": True, "job": _job_view(doc)}

    @api.get("/studio/book-factory/jobs/{job_id}")
    async def book_factory_get_job(job_id: str, admin=Depends(require_admin)):
        _need_enabled()
        doc = await _owned_or_404(job_id, _admin_email(admin))
        return {"success": True, "job": _job_view(doc)}

    @api.post("/studio/book-factory/jobs/{job_id}/approve")
    async def book_factory_approve(job_id: str, admin=Depends(require_admin)):
        # §HIGH 8 + §BLOCKER 2: explicit, persisted, idempotent blueprint
        # approval that atomically requires owner + job.state=="blueprint_ready"
        # + blueprint.state=="completed" + blueprintApprovedAt absent + not
        # cancelled. A cancelled job can NEVER be approved back into an active
        # state.
        _need_enabled()
        email = _admin_email(admin)
        doc = await _owned_or_404(job_id, email)
        if doc.get("state") == _JOB_CANCELLED:
            raise HTTPException(status_code=409, detail="Job is cancelled.")
        if (doc.get("blueprint") or {}).get("state") != S_COMPLETED:
            raise HTTPException(status_code=409, detail="Blueprint is not ready for approval.")
        if doc.get("blueprintApprovedAt"):
            return {"success": True, "job": _job_view(doc)}  # idempotent
        now = _now_iso()
        kwargs = {"return_document": ReturnDocument.AFTER} if ReturnDocument is not None else {}
        done = await db[COLL].find_one_and_update(
            {"_id": job_id, **_owner_clause(email),
             "state": "blueprint_ready",
             "blueprint.state": S_COMPLETED, "blueprintApprovedAt": None},
            {"$set": {"blueprintApprovedAt": now, "state": "approved", "updatedAt": now}},
            **kwargs,
        )
        if done is None:
            raise HTTPException(status_code=409, detail="Blueprint is not ready for approval.")
        return {"success": True, "job": _job_view(done)}

    @api.post("/studio/book-factory/jobs/{job_id}/step")
    async def book_factory_step(job_id: str, payload: dict, admin=Depends(require_admin)):
        _need_generation()
        email = _admin_email(admin)
        doc = await _owned_or_404(job_id, email)
        if doc.get("state") == _JOB_CANCELLED:
            raise HTTPException(status_code=409, detail="Job is cancelled.")
        # §BLOCKER C: recovery for legacy malformed jobs.
        bp = doc.get("blueprint") or {}
        if bp.get("state") == S_COMPLETED and len(doc.get("chapters") or {}) == 0:
            await db[COLL].update_one(
                {"_id": job_id, **_owner_clause(email)},
                {"$set": {"blueprint.state": S_FAILED_TERMINAL,
                          "blueprint.lastError": "blueprint_atomicity_recovery",
                          "updatedAt": _now_iso()}},
            )
            raise HTTPException(status_code=409, detail="blueprint_atomicity_recovery")
        stage = (payload or {}).get("stage")
        chapter_id = (payload or {}).get("chapterId")
        if stage == "blueprint":
            result = await _run_blueprint(db, job_id, owner=email)
        elif chapter_id:
            # §HIGH 8: chapter generation is rejected until the blueprint is approved.
            if not doc.get("blueprintApprovedAt"):
                raise HTTPException(status_code=409, detail="blueprint_not_approved")
            result = await _run_chapter(db, job_id, chapter_id, owner=email)
        else:
            raise HTTPException(status_code=400, detail="Provide stage='blueprint' or chapterId.")
        latest = await db[COLL].find_one({"_id": job_id, **_owner_clause(email)})
        return {"success": True, "result": result, "job": _job_view(latest)}

    @api.post("/studio/book-factory/jobs/{job_id}/chapters/{chapter_id}/retry")
    async def book_factory_retry(job_id: str, chapter_id: str, admin=Depends(require_admin)):
        # §HIGH 10: single atomic fenced retry. Eligible only from
        # failed_retryable / unknown_outcome, matched on the CURRENT attemptId +
        # generationVersion so a stale request cannot win. generationVersion is
        # NOT incremented here — the subsequent claim's $inc handles it.
        _need_generation()
        email = _admin_email(admin)
        path = f"chapters.{chapter_id}"
        pre = await db[COLL].find_one({"_id": job_id, **_owner_clause(email)})
        if not pre or chapter_id not in (pre.get("chapters") or {}):
            raise HTTPException(status_code=404, detail="Chapter not found")
        spec = _get_path(pre, path)
        exp_attempt = spec.get("attemptId")
        exp_genver = spec.get("generationVersion")
        now = _now_iso()
        kwargs = {"return_document": ReturnDocument.AFTER} if ReturnDocument is not None else {}
        done = await db[COLL].find_one_and_update(
            {"_id": job_id, **_owner_clause(email),
             "state": {"$ne": _JOB_CANCELLED},
             f"{path}.chapterId": chapter_id,
             f"{path}.attemptId": exp_attempt,
             f"{path}.generationVersion": exp_genver,
             f"{path}.state": {"$in": list(_RETRY_ELIGIBLE)},
             f"{path}.locked": {"$ne": True}},
            {"$set": {f"{path}.state": S_PENDING,
                      f"{path}.lastError": None,
                      f"{path}.providerCallCount": 0,
                      f"{path}.jsonRetryUsed": False,
                      f"{path}.malformedRetryUsed": False,
                      "updatedAt": now}},
            **kwargs,
        )
        if done is None:
            cur = _get_path(pre, path).get("state")
            raise HTTPException(
                status_code=409,
                detail=f"Chapter state '{cur}' is not eligible for manual retry.",
            )
        return {"success": True, "job": _job_view(done)}

    @api.post("/studio/book-factory/jobs/{job_id}/chapters/{chapter_id}/lock")
    async def book_factory_lock(job_id: str, chapter_id: str, admin=Depends(require_admin)):
        return await _set_lock(db, job_id, chapter_id, True, owner=_admin_email(admin))

    @api.post("/studio/book-factory/jobs/{job_id}/chapters/{chapter_id}/unlock")
    async def book_factory_unlock(job_id: str, chapter_id: str, admin=Depends(require_admin)):
        return await _set_lock(db, job_id, chapter_id, False, owner=_admin_email(admin))

    @api.post("/studio/book-factory/jobs/{job_id}/chapters/{chapter_id}/regenerate")
    async def book_factory_regenerate(job_id: str, chapter_id: str, payload: dict = None, admin=Depends(require_admin)):
        # §HIGH 10: regenerate only a completed, unlocked chapter, atomically
        # matched on the current attemptId + generationVersion + owner + not
        # cancelled. Preserves chapterId + position, clears blocks/warnings,
        # resets the attempt lifecycle (the subsequent claim advances
        # generationVersion exactly once).
        _need_generation()
        email = _admin_email(admin)
        path = f"chapters.{chapter_id}"
        pre = await db[COLL].find_one({"_id": job_id, **_owner_clause(email)})
        if not pre or chapter_id not in (pre.get("chapters") or {}):
            raise HTTPException(status_code=404, detail="Chapter not found")
        spec = _get_path(pre, path)
        exp_attempt = spec.get("attemptId")
        exp_genver = spec.get("generationVersion")
        instruction = ""
        if isinstance(payload, dict):
            instruction = str(payload.get("focusedInstruction") or "")[:2000]
        now = _now_iso()
        kwargs = {"return_document": ReturnDocument.AFTER} if ReturnDocument is not None else {}
        done = await db[COLL].find_one_and_update(
            {"_id": job_id, **_owner_clause(email), "state": {"$ne": _JOB_CANCELLED},
             f"{path}.chapterId": chapter_id,
             f"{path}.attemptId": exp_attempt,
             f"{path}.generationVersion": exp_genver,
             f"{path}.state": S_COMPLETED,
             f"{path}.locked": {"$ne": True}},
            {"$set": {f"{path}.state": S_PENDING,
                      f"{path}.attemptId": None,
                      # §PHASE C1: reset the FULL attempt lifecycle so the regenerated
                      # generation starts with a fresh retry budget (attemptCount 0,
                      # no stale providerCallCount, no stale malformed-retry flag).
                      f"{path}.attemptCount": 0,
                      f"{path}.blocks": [],
                      f"{path}.warnings": [],
                      f"{path}.lastError": None,
                      f"{path}.focusedInstruction": instruction,
                      f"{path}.providerCallCount": 0,
                      f"{path}.jsonRetryUsed": False,
                      f"{path}.malformedRetryUsed": False,
                      "updatedAt": now}},
            **kwargs,
        )
        if done is None:
            cur = _get_path(pre, path).get("state")
            locked = _get_path(pre, path).get("locked")
            raise HTTPException(
                status_code=409,
                detail=f"Chapter (state '{cur}', locked={bool(locked)}) cannot be regenerated.",
            )
        return {"success": True, "job": _job_view(done)}

    @api.post("/studio/book-factory/jobs/{job_id}/cover/generate")
    async def book_factory_cover_generate(job_id: str, admin=Depends(require_admin)):
        # Phase 2: optional AI cover-image stage. Independent flag gate — a
        # teacher can generate chapters with COVER_ENABLED=false and this
        # route simply 503s; nothing else about the job is affected.
        _need_enabled()
        email = _admin_email(admin)
        if not cover_generation_permitted():
            raise HTTPException(status_code=503, detail="Book Factory cover generation is disabled or not configured.")
        await _owned_or_404(job_id, email)
        result = await _run_cover(db, job_id, owner=email)
        latest = await db[COLL].find_one({"_id": job_id, **_owner_clause(email)})
        return {"success": True, "result": result, "job": _job_view(latest)}

    @api.post("/studio/book-factory/jobs/{job_id}/cover/regenerate")
    async def book_factory_cover_regenerate(job_id: str, admin=Depends(require_admin)):
        # Reset a completed cover stage back to pending (mirrors chapter
        # regenerate). Fenced on the CURRENT attemptId + generationVersion so
        # a stale request can never clobber a newer generation.
        _need_enabled()
        email = _admin_email(admin)
        if not cover_generation_permitted():
            raise HTTPException(status_code=503, detail="Book Factory cover generation is disabled or not configured.")
        pre = await _owned_or_404(job_id, email)
        spec = pre.get("cover") or {}
        exp_attempt = spec.get("attemptId")
        exp_genver = spec.get("generationVersion")
        cur_state = spec.get("state")
        if cur_state not in (S_COMPLETED, S_FAILED_TERMINAL, S_FAILED_RETRYABLE, S_UNKNOWN):
            raise HTTPException(status_code=409, detail=f"Cover state '{cur_state}' cannot be regenerated right now.")
        now = _now_iso()
        kwargs = {"return_document": ReturnDocument.AFTER} if ReturnDocument is not None else {}
        done = await db[COLL].find_one_and_update(
            {"_id": job_id, **_owner_clause(email), "state": {"$ne": _JOB_CANCELLED},
             "cover.attemptId": exp_attempt, "cover.generationVersion": exp_genver,
             "cover.state": cur_state},
            {"$set": {"cover.state": S_PENDING, "cover.attemptId": None,
                      "cover.attemptCount": 0, "cover.coverImage": "", "cover.mimeType": "",
                      "updatedAt": now}},
            **kwargs,
        )
        if done is None:
            raise HTTPException(status_code=409, detail="Cover changed concurrently; regenerate rejected.")
        return {"success": True, "job": _job_view(done)}

    @api.post("/studio/book-factory/jobs/{job_id}/save-draft")
    async def book_factory_save_draft(job_id: str, admin=Depends(require_admin)):
        # §AMENDMENT 2 + 10: server-side, owner-bound, recoverable save. The
        # slug/revision binding lives on the JOB, never supplied by the
        # client — narration/publish read it from here, not from a request
        # body. A lost-response retry with unchanged content recovers the
        # existing binding instead of writing a duplicate revision; changed
        # content (e.g. a cover finished after the first save) writes a new
        # revision under the SAME already-bound slug.
        _need_enabled()
        if save_book_revision is None:
            raise HTTPException(status_code=503, detail="Save Draft is not wired on this server.")
        email = _admin_email(admin)
        doc = await _owned_or_404(job_id, email)
        if doc.get("state") == _JOB_CANCELLED:
            raise HTTPException(status_code=409, detail="Job is cancelled.")

        exp = _compute_export(doc)
        if exp["completed"] == 0:
            raise HTTPException(status_code=409, detail="No completed chapters to save yet.")
        new_hash = _export_hash(exp["book"])
        now = _now_iso()

        existing_slug = doc.get("savedBookSlug")

        if existing_slug:
            if doc.get("savedBookExportHash") == new_hash:
                # Idempotent recovery: identical content already saved under
                # this binding — do NOT write another revision.
                return {"success": True, "slug": existing_slug,
                        "revision": doc.get("savedBookRevision"),
                        "recovered": True, "job": _job_view(doc)}
            book_payload = dict(exp["book"])
            book_payload["slug"] = existing_slug
            book_payload["published"] = False
            result = await save_book_revision(book_payload, email)
            kwargs = {"return_document": ReturnDocument.AFTER} if ReturnDocument is not None else {}
            updated = await db[COLL].find_one_and_update(
                {"_id": job_id, **_owner_clause(email), "savedBookSlug": existing_slug},
                {"$set": {
                    "savedBookRevision": result["revision"],
                    "savedBookExportHash": new_hash,
                    "savedAt": now,
                    "chapterIdToSavedIndex": exp["chapterIdToSavedIndex"],
                    "updatedAt": now,
                }},
                **kwargs,
            )
            return {"success": True, "slug": existing_slug, "revision": result["revision"],
                    "recovered": False, "job": _job_view(updated or doc)}

        # First save for this job: atomically claim the "unbound" slot with a
        # freshly minted, collision-proof slug BEFORE calling save_book_revision,
        # so two concurrent save-draft requests can never mint two different
        # books for the same job.
        candidate_slug = _mint_bf_slug(exp["book"].get("title") or doc.get("config", {}).get("title"), job_id)
        kwargs = {"return_document": ReturnDocument.AFTER} if ReturnDocument is not None else {}
        claimed_bind = await db[COLL].find_one_and_update(
            {"_id": job_id, **_owner_clause(email), "state": {"$ne": _JOB_CANCELLED},
             "savedBookSlug": None},
            {"$set": {"savedBookSlug": candidate_slug, "savedBookOwner": email, "updatedAt": now}},
            **kwargs,
        )
        if claimed_bind is None:
            # Another concurrent request already bound a slug for this job —
            # re-read and fall through to the update-in-place path so we never
            # save the book twice under two different slugs.
            fresh = await db[COLL].find_one({"_id": job_id, **_owner_clause(email)})
            won_slug = (fresh or {}).get("savedBookSlug")
            if not won_slug:
                raise HTTPException(status_code=409, detail="Save Draft is in progress; try again.")
            book_payload = dict(exp["book"])
            book_payload["slug"] = won_slug
            book_payload["published"] = False
            result = await save_book_revision(book_payload, email)
            await db[COLL].update_one(
                {"_id": job_id, **_owner_clause(email), "savedBookSlug": won_slug},
                {"$set": {
                    "savedBookRevision": result["revision"], "savedBookExportHash": new_hash,
                    "savedAt": now, "chapterIdToSavedIndex": exp["chapterIdToSavedIndex"],
                    "updatedAt": now,
                }},
            )
            latest = await db[COLL].find_one({"_id": job_id, **_owner_clause(email)})
            return {"success": True, "slug": won_slug, "revision": result["revision"],
                    "recovered": False, "job": _job_view(latest)}

        book_payload = dict(exp["book"])
        book_payload["slug"] = candidate_slug
        book_payload["published"] = False
        result = await save_book_revision(book_payload, email)
        kwargs = {"return_document": ReturnDocument.AFTER} if ReturnDocument is not None else {}
        updated = await db[COLL].find_one_and_update(
            {"_id": job_id, **_owner_clause(email), "savedBookSlug": candidate_slug},
            {"$set": {
                "savedBookRevision": result["revision"], "savedBookExportHash": new_hash,
                "savedAt": now, "chapterIdToSavedIndex": exp["chapterIdToSavedIndex"],
                "updatedAt": now,
            }},
            **kwargs,
        )
        return {"success": True, "slug": candidate_slug, "revision": result["revision"],
                "recovered": False, "job": _job_view(updated or claimed_bind)}

    @api.post("/studio/book-factory/jobs/{job_id}/publish")
    async def book_factory_publish(job_id: str, admin=Depends(require_admin)):
        # §AMENDMENT 10: publish ALWAYS targets the server-bound slug — a
        # client can never pass an arbitrary slug in. Requires Save Draft to
        # have run at least once. Optional-stage completeness (cover /
        # narration) is never checked here — publishing without them is
        # always allowed (§AMENDMENT 11); the frontend surfaces an explicit
        # confirmation before calling this route.
        _need_enabled()
        if publish_book is None:
            raise HTTPException(status_code=503, detail="Publish is not wired on this server.")
        email = _admin_email(admin)
        doc = await _owned_or_404(job_id, email)
        slug = doc.get("savedBookSlug")
        if not slug:
            raise HTTPException(status_code=409, detail="Save Draft before publishing.")
        result = await publish_book(slug)
        now = _now_iso()
        kwargs = {"return_document": ReturnDocument.AFTER} if ReturnDocument is not None else {}
        updated = await db[COLL].find_one_and_update(
            {"_id": job_id, **_owner_clause(email)},
            {"$set": {"publishedAt": now, "publishedRevision": doc.get("savedBookRevision"),
                      "updatedAt": now}},
            **kwargs,
        )
        return {"success": True, "slug": slug, "publish": result, "job": _job_view(updated or doc)}

    @api.post("/studio/book-factory/jobs/{job_id}/narration/{chapter_id}")
    async def book_factory_narrate_chapter(
        job_id: str, chapter_id: str, payload: dict = None, admin=Depends(require_admin),
    ):
        # §AMENDMENT 1 + 6: chapterId is the identity, never an array index.
        # Resolved to the CURRENT saved-book position only immediately before
        # calling the legacy narration function. Progress is entirely
        # server-side (job.narration.{chapterId}) — a client refresh simply
        # re-reads this same job state, never trusts localStorage for "was
        # this paid call already made".
        _need_enabled()
        if not narration_automation_permitted():
            raise HTTPException(status_code=503, detail="Book Factory narration automation is disabled.")
        if run_elevenlabs_for_chapter is None:
            raise HTTPException(status_code=503, detail="Narration is not wired on this server.")
        email = _admin_email(admin)
        doc = await _owned_or_404(job_id, email)
        if doc.get("state") == _JOB_CANCELLED:
            raise HTTPException(status_code=409, detail="Job is cancelled.")
        if chapter_id not in (doc.get("chapterOrder") or []):
            raise HTTPException(status_code=404, detail="Chapter not found in this job's approved outline.")
        slug = doc.get("savedBookSlug")
        if not slug:
            raise HTTPException(status_code=409, detail="Save Draft before narrating.")
        saved_index = (doc.get("chapterIdToSavedIndex") or {}).get(chapter_id)
        if saved_index is None:
            raise HTTPException(
                status_code=409,
                detail="This chapter is not present in the last saved draft — Save Draft again first.",
            )

        voice_id = str((payload or {}).get("voice") or "")
        synced_words = bool((payload or {}).get("syncedWords"))
        if synced_words:
            # §AMENDMENT 7: transform runs on the SAVED revision and produces
            # its own new authoritative revision BEFORE narration is called —
            # never an inline flag mutating blocks inside the ElevenLabs call.
            # Naturally idempotent (see book_factory_narration.py) — a repeat
            # request with no remaining paragraph blocks is a no-op.
            if get_book_by_slug is None or save_book_revision is None:
                raise HTTPException(status_code=503, detail="Synced-words transform is not wired on this server.")
            book_now = await get_book_by_slug(slug)
            if book_now:
                new_chapters, changed = bf_narration.convert_paragraphs_to_transcript(
                    book_now.get("chapters") or []
                )
                if changed:
                    payload_dict = dict(book_now)
                    payload_dict["chapters"] = new_chapters
                    payload_dict["slug"] = slug
                    resave = await save_book_revision(payload_dict, email)
                    now2 = _now_iso()
                    await db[COLL].update_one(
                        {"_id": job_id, **_owner_clause(email), "savedBookSlug": slug},
                        {"$set": {"savedBookRevision": resave["revision"], "updatedAt": now2}},
                    )

        result = await _run_narration_chapter(
            db, job_id, chapter_id, saved_index, slug, voice_id, email,
            run_elevenlabs_for_chapter,
        )
        latest = await db[COLL].find_one({"_id": job_id, **_owner_clause(email)})
        return {"success": True, "result": result, "job": _job_view(latest)}

    def _conv_preflight(doc: dict, chapter_id: str) -> str:
        """Shared checks for every conversation-audio route: job not
        cancelled, chapterId known, saved-book binding present. Returns the
        bound slug or raises HTTPException."""
        if doc.get("state") == _JOB_CANCELLED:
            raise HTTPException(status_code=409, detail="Job is cancelled.")
        if chapter_id not in (doc.get("chapterOrder") or []):
            raise HTTPException(status_code=404, detail="Chapter not found in this job's approved outline.")
        slug = doc.get("savedBookSlug")
        if not slug:
            raise HTTPException(status_code=409, detail="Save Draft before generating conversation audio.")
        return slug

    @api.post("/studio/book-factory/jobs/{job_id}/conversation-audio/{chapter_id}/init")
    async def book_factory_conversation_init(
        job_id: str, chapter_id: str, payload: dict = None, admin=Depends(require_admin),
    ):
        # §PHASE E: idempotent / resume-safe seeding of the persisted
        # per-line map. Safe to call repeatedly — a completed line is NEVER
        # reset (see init_conversation_audio_chapter's docstring).
        _need_enabled()
        email = _admin_email(admin)
        if not conversation_audio_ready():
            raise HTTPException(status_code=503, detail="Conversation-audio automation is disabled or storage is not configured.")
        doc = await _owned_or_404(job_id, email)
        _conv_preflight(doc, chapter_id)
        voice_assignments = (payload or {}).get("voiceAssignments") or {}
        if not isinstance(voice_assignments, dict):
            raise HTTPException(status_code=400, detail="voiceAssignments must be an object.")
        pause_after = float((payload or {}).get("pauseAfter", 0.35) or 0.35)
        patch = init_conversation_audio_chapter(doc, chapter_id, voice_assignments, pause_after)
        if patch is None:
            raise HTTPException(status_code=409, detail="This chapter has no dialog lines.")
        now = _now_iso()
        kwargs = {"return_document": ReturnDocument.AFTER} if ReturnDocument is not None else {}
        updated = await db[COLL].find_one_and_update(
            {"_id": job_id, **_owner_clause(email)},
            {"$set": {f"conversationAudio.{chapter_id}": patch, "updatedAt": now}},
            **kwargs,
        )
        return {"success": True, "job": _job_view(updated or doc)}

    @api.post("/studio/book-factory/jobs/{job_id}/conversation-audio/{chapter_id}/lines/{line_id}/generate")
    async def book_factory_conversation_line_generate(
        job_id: str, chapter_id: str, line_id: str, admin=Depends(require_admin),
    ):
        _need_enabled()
        email = _admin_email(admin)
        if not conversation_audio_ready():
            raise HTTPException(status_code=503, detail="Conversation-audio automation is disabled or storage is not configured.")
        if run_conversation_line is None:
            raise HTTPException(status_code=503, detail="Conversation-audio generation is not wired on this server.")
        doc = await _owned_or_404(job_id, email)
        _conv_preflight(doc, chapter_id)
        conv = (doc.get("conversationAudio") or {}).get(chapter_id) or {}
        if line_id not in (conv.get("lines") or {}):
            raise HTTPException(status_code=404, detail="Line not found — call init first.")
        result = await _run_conversation_line(db, job_id, chapter_id, line_id, email, run_conversation_line)
        latest = await db[COLL].find_one({"_id": job_id, **_owner_clause(email)})
        return {"success": True, "result": result, "job": _job_view(latest)}

    @api.post("/studio/book-factory/jobs/{job_id}/conversation-audio/{chapter_id}/lines/{line_id}/retry")
    async def book_factory_conversation_line_retry(
        job_id: str, chapter_id: str, line_id: str, admin=Depends(require_admin),
    ):
        # Same eligibility rule as chapter retry: only failed_retryable /
        # unknown_outcome, fenced on the CURRENT attemptId + generationVersion
        # — never touches any other line in this chapter.
        _need_enabled()
        email = _admin_email(admin)
        path = f"conversationAudio.{chapter_id}.lines.{line_id}"
        pre = await db[COLL].find_one({"_id": job_id, **_owner_clause(email)})
        if not pre:
            raise HTTPException(status_code=404, detail="Job not found")
        spec = _get_path(pre, path)
        if not spec:
            raise HTTPException(status_code=404, detail="Line not found")
        exp_attempt = spec.get("attemptId")
        exp_genver = spec.get("generationVersion")
        now = _now_iso()
        kwargs = {"return_document": ReturnDocument.AFTER} if ReturnDocument is not None else {}
        done = await db[COLL].find_one_and_update(
            {"_id": job_id, **_owner_clause(email), "state": {"$ne": _JOB_CANCELLED},
             f"{path}.attemptId": exp_attempt, f"{path}.generationVersion": exp_genver,
             f"{path}.state": {"$in": list(_RETRY_ELIGIBLE)}},
            {"$set": {f"{path}.state": S_PENDING, f"{path}.lastError": None,
                      f"{path}.providerCallCount": 0, "updatedAt": now}},
            **kwargs,
        )
        if done is None:
            raise HTTPException(status_code=409, detail=f"Line state '{spec.get('state')}' is not eligible for manual retry.")
        return {"success": True, "job": _job_view(done)}

    @api.post("/studio/book-factory/jobs/{job_id}/conversation-audio/{chapter_id}/assemble")
    async def book_factory_conversation_assemble(
        job_id: str, chapter_id: str, admin=Depends(require_admin),
    ):
        # §PHASE E: pre-claim gate — assembly is only ATTEMPTED once every
        # required line reports completed. This is a pre-check (409 if not
        # ready) rather than a claimed-then-failed attempt, so an
        # in-progress chapter never burns an assembly attempt/generationVersion
        # merely because the teacher checked too early.
        _need_enabled()
        email = _admin_email(admin)
        if not conversation_audio_ready():
            raise HTTPException(status_code=503, detail="Conversation-audio automation is disabled or storage is not configured.")
        if assemble_conversation_for_chapter is None:
            raise HTTPException(status_code=503, detail="Conversation-audio assembly is not wired on this server.")
        doc = await _owned_or_404(job_id, email)
        slug = _conv_preflight(doc, chapter_id)
        saved_index = (doc.get("chapterIdToSavedIndex") or {}).get(chapter_id)
        if saved_index is None:
            raise HTTPException(status_code=409, detail="This chapter is not present in the last saved draft — Save Draft again first.")
        conv = (doc.get("conversationAudio") or {}).get(chapter_id) or {}
        order = conv.get("lineOrder") or []
        lines_map = conv.get("lines") or {}
        if not order:
            raise HTTPException(status_code=409, detail="No conversation lines initialized for this chapter — call init first.")
        incomplete = [lid for lid in order if (lines_map.get(lid) or {}).get("state") != S_COMPLETED]
        if incomplete:
            raise HTTPException(status_code=409, detail=f"{len(incomplete)} line(s) not yet completed.")
        result = await _run_conversation_assembly(
            db, job_id, chapter_id, saved_index, slug, email, assemble_conversation_for_chapter,
        )
        latest = await db[COLL].find_one({"_id": job_id, **_owner_clause(email)})
        return {"success": True, "result": result, "job": _job_view(latest)}

    @api.post("/studio/book-factory/jobs/{job_id}/cancel")
    async def book_factory_cancel(job_id: str, admin=Depends(require_admin)):
        # §BLOCKER 2: idempotent, TERMINAL cancellation scoped to the owner. It
        # blocks all future claims/approvals and any late in-flight completion
        # or failure (those are fenced on state != cancelled).
        _need_enabled()
        email = _admin_email(admin)
        now = _now_iso()
        kwargs = {"return_document": ReturnDocument.AFTER} if ReturnDocument is not None else {}
        done = await db[COLL].find_one_and_update(
            {"_id": job_id, **_owner_clause(email)},
            {"$set": {"state": _JOB_CANCELLED, "cancelledAt": now, "updatedAt": now}},
            **kwargs,
        )
        if done is None:
            raise HTTPException(status_code=404, detail="Job not found")
        return {"success": True, "job": _job_view(done)}

    @api.post("/studio/book-factory/jobs/{job_id}/dismiss")
    async def book_factory_dismiss(job_id: str, admin=Depends(require_admin)):
        # §PHASE E2: soft-dismiss — owner-scoped, atomic, idempotent.
        # Sets `dismissedAt` without changing `state`; dismissed jobs are
        # excluded from the recent listing but remain retrievable by direct
        # GET.  Cannot be undone via API (cancelled jobs stay dismissed too).
        _need_enabled()
        email = _admin_email(admin)
        now = _now_iso()
        kwargs = {"return_document": ReturnDocument.AFTER} if ReturnDocument is not None else {}
        done = await db[COLL].find_one_and_update(
            {"_id": job_id, **_owner_clause(email), "dismissedAt": None},
            {"$set": {"dismissedAt": now, "updatedAt": now}},
            **kwargs,
        )
        if done is None:
            # Either not found/not owned, or already dismissed — idempotent.
            doc = await db[COLL].find_one({"_id": job_id, **_owner_clause(email)})
            if doc is None:
                raise HTTPException(status_code=404, detail="Job not found")
            return {"success": True, "job": _job_view(doc)}
        return {"success": True, "job": _job_view(done)}

    @api.get("/studio/book-factory/jobs/{job_id}/export")
    async def book_factory_export(job_id: str, admin=Depends(require_admin)):
        _need_enabled()
        doc = await _owned_or_404(job_id, _admin_email(admin))
        exp = _compute_export(doc)
        return {"success": True, "book": exp["book"],
                "completedChapters": exp["completed"], "totalChapters": exp["total"],
                "incomplete": exp["completed"] < exp["total"],
                "cancelled": doc.get("state") == _JOB_CANCELLED,
                "speakers": exp["speakers"],
                "chapterBalanceWarnings": exp["chapterBalanceWarnings"]}

    log.info("book_factory: routes registered")


async def _set_lock(db, job_id: str, chapter_id: str, locked: bool, owner: str | None = None) -> dict:
    """§BLOCKER 3: lock / unlock a chapter atomically.

    A lock may SUCCEED only when the chapter is in a STABLE (non-active) state —
    never `claimed` or `provider_pending` — so an in-flight provider request is
    never silently invalidated by an unfenced lock. The transition is matched on
    owner + job ID + chapter ID + expected chapter state + expected
    generationVersion + the expected current lock value + job not cancelled, so
    an older attempt can never mutate a chapter that became locked, and a stale
    unlock (wrong generationVersion / lock value) is rejected with 409.
    """
    path = f"chapters.{chapter_id}"
    pre = await db[COLL].find_one({"_id": job_id, **_owner_clause(owner)})
    if not pre or chapter_id not in (pre.get("chapters") or {}):
        raise HTTPException(status_code=404, detail="Chapter not found")
    if pre.get("state") == _JOB_CANCELLED:
        raise HTTPException(status_code=409, detail="Job is cancelled.")
    spec = _get_path(pre, path)
    cur_state = spec.get("state")
    exp_genver = spec.get("generationVersion")
    exp_lock = bool(spec.get("locked"))

    if locked:
        # Locking is only permitted from a stable (non-active) chapter state.
        if cur_state not in _LOCKABLE_STATES:
            raise HTTPException(
                status_code=409,
                detail=f"Chapter state '{cur_state}' cannot be locked (must be stable).",
            )
        if exp_lock:  # already locked → idempotent
            return {"success": True, "job": _job_view(pre)}
    else:
        if not exp_lock:  # already unlocked → idempotent
            return {"success": True, "job": _job_view(pre)}

    now = _now_iso()
    kwargs = {"return_document": ReturnDocument.AFTER} if ReturnDocument is not None else {}
    done = await db[COLL].find_one_and_update(
        {"_id": job_id, **_owner_clause(owner), "state": {"$ne": _JOB_CANCELLED},
         f"{path}.chapterId": chapter_id,
         f"{path}.generationVersion": exp_genver,
         f"{path}.state": cur_state,
         f"{path}.locked": exp_lock},
        {"$set": {f"{path}.locked": bool(locked), "updatedAt": now}},
        **kwargs,
    )
    if done is None:
        raise HTTPException(status_code=409, detail="Chapter changed concurrently; lock rejected.")
    return {"success": True, "job": _job_view(done)}
