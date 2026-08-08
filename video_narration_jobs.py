"""video_narration_jobs.py — Video Library AI Narration production job
engine: atomic-claim / attempt-fencing stage primitives, generalized from
the exact proven pattern already shipping in book_factory_jobs.py (claim →
fence → complete/fail, attemptId + generationVersion + lease + owner
fencing, so a superseded attempt or a stale generation can never win).

This is a REIMPLEMENTATION of that pattern in a new, Video-specific,
product-agnostic module — not an import from book_factory_jobs.py. Two
reasons:
  1. book_factory_jobs.py's primitives are hard-wired to a single
     module-level collection constant (COLL = "book_factory_jobs"); making
     them collection-parameterized would mean modifying a 2400-line file
     used by every Book Factory stage, for a change whose entire benefit
     accrues to Video. Reimplementing the same proven design here carries
     zero risk to Books.
  2. Product isolation: "new Video functionality must live in new
     Video-specific modules" — this module never imports from or writes
     to any book_factory_*.py collection.

Collection: `video_narration_jobs`, owned exclusively by this module
(registered in tools/check_collection_ownership.py). One document per
lesson (`_id == lessonId`) — Video Library already has a natural 1:1
lesson:production-job relationship, so (unlike Book Factory's separate
jobId) no extra identifier is needed.

Stage document shape (embedded at a dotted path inside the job document,
e.g. "storyAnalysis" or "voiceProduction.sc1.lines.ln0"):
    {
        "state": "pending" | "claimed" | "provider_pending" | "completed"
                 | "failed_retryable" | "failed_terminal" | "unknown_outcome",
        "attemptId": str | None,
        "attemptCount": int,
        "generationVersion": int,
        "claimedAt": iso | None,
        "claimExpiresAt": iso | None,
        "completedAt": iso | None,
        "lastError": str | None,
        "result": <stage-specific payload, set only on completion>,
    }

Cost-safety guarantee this engine provides for free to every stage that
uses it: a stage in "completed" is never re-claimable (the claim filter's
$or only matches pending / expired-claimed / retry-eligible-failed) — so
a retry after a downstream failure NEVER re-pays for already-successful
upstream work. This is the mechanism behind "Scene 3 ElevenLabs failed →
retry Scene 3 only, never Scenes 1/2/4 or Gemini again."
"""
from __future__ import annotations

import uuid
from datetime import datetime, timedelta, timezone

try:
    from pymongo import ReturnDocument
except Exception:  # pragma: no cover
    ReturnDocument = None  # type: ignore[assignment]

COLL = "video_narration_jobs"

# ── stage states (identical vocabulary to book_factory_jobs.py's proven set) ─
S_PENDING = "pending"
S_CLAIMED = "claimed"
S_PROVIDER_PENDING = "provider_pending"
S_COMPLETED = "completed"
S_FAILED_RETRYABLE = "failed_retryable"
S_FAILED_TERMINAL = "failed_terminal"
S_UNKNOWN = "unknown_outcome"

RETRY_ELIGIBLE = (S_FAILED_RETRYABLE, S_UNKNOWN)
TERMINAL_RETRY_ELIGIBLE = (S_FAILED_TERMINAL, S_UNKNOWN)

MAX_RETRIES = 2                # two retries after the initial attempt
CLAIM_LEASE_S = 180            # a crashed stage is reclaimable after this


def new_stage() -> dict:
    """A fresh, never-attempted stage record."""
    return {
        "state": S_PENDING,
        "attemptId": None,
        "attemptCount": 0,
        "generationVersion": 0,
        "claimedAt": None,
        "claimExpiresAt": None,
        "completedAt": None,
        "lastError": None,
        "result": None,
    }


def _now_iso() -> str:
    return datetime.now(timezone.utc).isoformat()


def _iso_in(seconds: int) -> str:
    return (datetime.now(timezone.utc) + timedelta(seconds=seconds)).isoformat()


def _mint_attempt() -> str:
    return "vatt_" + uuid.uuid4().hex[:12]


def get_path(doc: dict, path: str) -> dict:
    cur = doc or {}
    for part in path.split("."):
        if not isinstance(cur, dict):
            return {}
        cur = cur.get(part, {})
    return cur if isinstance(cur, dict) else {}


async def ensure_video_narration_job_indexes(db) -> None:
    await db[COLL].create_index("lessonId", unique=True)


async def get_or_create_job(db, lesson_id: str) -> dict:
    """Fetch the lesson's production job, creating an empty one on first
    use. Never overwrites an existing job (idempotent)."""
    doc = await db[COLL].find_one({"_id": lesson_id}, {"_id": 0})
    if doc:
        return doc
    now = _now_iso()
    fresh = {
        "_id": lesson_id,
        "lessonId": lesson_id,
        "storyAnalysis": new_stage(),
        "scriptBlueprint": new_stage(),
        "voiceAssignments": {},
        "voiceProduction": {},
        "assembly": new_stage(),
        "render": new_stage(),
        "sourceAudioTreatment": "mute",
        "published": False,
        "createdAt": now,
        "updatedAt": now,
    }
    await db[COLL].update_one(
        {"_id": lesson_id},
        {"$setOnInsert": fresh},
        upsert=True,
    )
    # Additive backfill for jobs created before the "render" stage existed —
    # never overwrites anything, matches this codebase's "old rows/routes
    # are preserved, additive-only" convention (see CLAUDE.md).
    await db[COLL].update_one(
        {"_id": lesson_id, "render": {"$exists": False}},
        {"$set": {"render": new_stage()}},
    )
    # Additive backfill for jobs created before sourceAudioTreatment existed
    # — defaults to "mute", the exact prior (pre-treatment) render behavior,
    # so no existing job's render output changes silently.
    await db[COLL].update_one(
        {"_id": lesson_id, "sourceAudioTreatment": {"$exists": False}},
        {"$set": {"sourceAudioTreatment": "mute"}},
    )
    doc = await db[COLL].find_one({"_id": lesson_id}, {"_id": 0})
    return doc or fresh


async def claim_stage(db, doc_id: str, path: str, *, max_retries: int = MAX_RETRIES,
                       lease_s: int = CLAIM_LEASE_S) -> tuple[dict | None, str]:
    """Atomic compare-and-set claim for one stage. Demotes a stale
    provider_pending lease to unknown_outcome FIRST (never auto-reclaimed
    — manual retry only, so an ambiguous in-flight provider call is never
    silently repeated), then wins only if the stage is pending, an EXPIRED
    claimed lease, or failed_retryable with attempts remaining.

    Returns (claimed_job_doc | None, attemptId). None means the claim was
    lost — the caller must not proceed (someone else is already working
    this stage, or it's already completed)."""
    now = _now_iso()

    await db[COLL].update_one(
        {"_id": doc_id, f"{path}.state": S_PROVIDER_PENDING,
         f"{path}.claimExpiresAt": {"$lt": now}},
        {"$set": {f"{path}.state": S_UNKNOWN, "updatedAt": now}},
    )

    attempt = _mint_attempt()
    claim_filter = {
        "_id": doc_id,
        "$or": [
            {f"{path}.state": S_PENDING},
            {f"{path}.state": S_CLAIMED, f"{path}.claimExpiresAt": {"$lt": now}},
            {f"{path}.state": S_FAILED_RETRYABLE,
             f"{path}.attemptCount": {"$lt": max_retries + 1}},
        ],
    }
    claim_update = {
        "$set": {
            f"{path}.state": S_CLAIMED,
            f"{path}.attemptId": attempt,
            f"{path}.claimedAt": now,
            f"{path}.claimExpiresAt": _iso_in(lease_s),
            "updatedAt": now,
        },
        "$inc": {f"{path}.attemptCount": 1, f"{path}.generationVersion": 1},
    }
    kwargs = {"return_document": ReturnDocument.AFTER} if ReturnDocument is not None else {}
    claimed = await db[COLL].find_one_and_update(claim_filter, claim_update, **kwargs)
    return claimed, attempt


async def fence_provider(db, doc_id: str, path: str, attempt: str, genver: int) -> bool:
    """claimed → provider_pending, fenced on attemptId + generationVersion.
    The provider (Gemini/ElevenLabs) is called ONLY when this returns True
    — this is what makes a superseded/duplicate attempt structurally unable
    to spend money."""
    now = _now_iso()
    kwargs = {"return_document": ReturnDocument.AFTER} if ReturnDocument is not None else {}
    fenced = await db[COLL].find_one_and_update(
        {"_id": doc_id, f"{path}.attemptId": attempt, f"{path}.generationVersion": genver,
         f"{path}.state": S_CLAIMED},
        {"$set": {f"{path}.state": S_PROVIDER_PENDING, f"{path}.providerRequestStartedAt": now,
                  "updatedAt": now}},
        **kwargs,
    )
    return fenced is not None


async def complete_stage(db, doc_id: str, path: str, attempt: str, genver: int, result: dict) -> bool:
    """provider_pending → completed, fenced on attemptId + generationVersion.
    A superseded attempt or a stale generation version can never win —
    once another attempt has moved the stage on, this call is a silent
    no-op rather than corrupting a newer result."""
    now = _now_iso()
    kwargs = {"return_document": ReturnDocument.AFTER} if ReturnDocument is not None else {}
    done = await db[COLL].find_one_and_update(
        {"_id": doc_id, f"{path}.attemptId": attempt, f"{path}.generationVersion": genver,
         f"{path}.state": S_PROVIDER_PENDING},
        {"$set": {
            f"{path}.state": S_COMPLETED,
            f"{path}.result": result,
            f"{path}.completedAt": now,
            f"{path}.lastError": None,
            "updatedAt": now,
        }},
        **kwargs,
    )
    return done is not None


async def fail_stage(db, doc_id: str, path: str, attempt: str, genver: int, reason: str,
                      *, max_retries: int = MAX_RETRIES) -> str | None:
    """Mark the current attempt failed_retryable, or failed_terminal once
    the attempt budget is exhausted. Fenced on attemptId + generationVersion."""
    now = _now_iso()
    doc = await db[COLL].find_one({"_id": doc_id})
    attempt_count = int(get_path(doc, path).get("attemptCount", 0))
    new_state = S_FAILED_TERMINAL if attempt_count >= max_retries + 1 else S_FAILED_RETRYABLE
    kwargs = {"return_document": ReturnDocument.AFTER} if ReturnDocument is not None else {}
    done = await db[COLL].find_one_and_update(
        {"_id": doc_id, f"{path}.attemptId": attempt, f"{path}.generationVersion": genver,
         f"{path}.state": {"$in": [S_CLAIMED, S_PROVIDER_PENDING]}},
        {"$set": {f"{path}.state": new_state, f"{path}.lastError": reason, "updatedAt": now}},
        **kwargs,
    )
    return new_state if done else None


async def fail_terminal(db, doc_id: str, path: str, attempt: str, genver: int, reason: str) -> str | None:
    """Set state = failed_terminal UNCONDITIONALLY — for errors that must
    never auto-retry (e.g. a malformed response that will never self-heal)."""
    now = _now_iso()
    kwargs = {"return_document": ReturnDocument.AFTER} if ReturnDocument is not None else {}
    done = await db[COLL].find_one_and_update(
        {"_id": doc_id, f"{path}.attemptId": attempt, f"{path}.generationVersion": genver,
         f"{path}.state": {"$in": [S_CLAIMED, S_PROVIDER_PENDING]}},
        {"$set": {f"{path}.state": S_FAILED_TERMINAL, f"{path}.lastError": reason, "updatedAt": now}},
        **kwargs,
    )
    return S_FAILED_TERMINAL if done else None


async def fail_unknown(db, doc_id: str, path: str, attempt: str, genver: int, reason: str) -> str | None:
    """Set state = unknown_outcome (manual-retry-only) when the provider's
    actual outcome could not be determined (e.g. a network timeout after
    the request was already sent) — never auto-retried, since the call may
    already have succeeded and billed."""
    now = _now_iso()
    kwargs = {"return_document": ReturnDocument.AFTER} if ReturnDocument is not None else {}
    done = await db[COLL].find_one_and_update(
        {"_id": doc_id, f"{path}.attemptId": attempt, f"{path}.generationVersion": genver,
         f"{path}.state": {"$in": [S_CLAIMED, S_PROVIDER_PENDING]}},
        {"$set": {f"{path}.state": S_UNKNOWN, f"{path}.lastError": reason, "updatedAt": now}},
        **kwargs,
    )
    return S_UNKNOWN if done else None
