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


def _is_stage_dict(value) -> bool:
    return isinstance(value, dict) and "state" in value and "claimExpiresAt" in value


def _collect_stranded_stage_paths(node, prefix: str, now: str, out: list[str]) -> None:
    """Recursively finds every stage dict (storyAnalysis/scriptBlueprint/
    assembly/render, plus the dynamically-keyed voiceProduction.<scene>.
    lines.<line> and sfx.<scene> stages) sitting in claimed/provider_pending
    with an EXPIRED claimExpiresAt — proof the process that was running it
    is gone (a redeploy/crash/OOM kill: the in-process asyncio.wait_for
    watchdog dies WITH the process, so it never gets a chance to mark the
    stage failed). Walks generically rather than a hardcoded path list so
    it doesn't need updating every time a new stage type is added."""
    if not isinstance(node, dict):
        return
    if _is_stage_dict(node):
        if node.get("state") in (S_CLAIMED, S_PROVIDER_PENDING) \
                and node.get("claimExpiresAt") and node["claimExpiresAt"] < now:
            out.append(prefix)
        return
    for key, value in node.items():
        if isinstance(value, dict):
            _collect_stranded_stage_paths(value, f"{prefix}.{key}" if prefix else key, now, out)


async def _heal_stranded_stages(db, lesson_id: str, doc: dict) -> dict:
    """Self-heal on READ: without this, a stage stranded past its lease by
    a dead process stays claimed/provider_pending forever, because the
    ONLY existing demotion path (claim_stage's own lazy check) requires
    someone to call claim_stage again for that exact stage — and the
    Studio UI hides its Retry button for exactly those two "looks still
    active" states (see RETRYABLE_STATES in VoiceProductionPanel.jsx), so
    nothing ever calls it again. Demoting to unknown_outcome here means
    the very next poll (every ~2.5s) shows an honest, retryable state
    instead of an indefinite "Processing" with no way out. Never touches a
    genuinely fresh in-flight stage — only one whose own claimExpiresAt
    (refreshed by fence_provider to the caller's real outer watchdog
    bound) has already passed."""
    now = _now_iso()
    stale_paths: list[str] = []
    _collect_stranded_stage_paths(doc, "", now, stale_paths)
    if not stale_paths:
        return doc
    updates = {"updatedAt": now}
    for path in stale_paths:
        updates[f"{path}.state"] = S_UNKNOWN
        updates[f"{path}.lastError"] = (
            "Processing stalled — the server likely restarted mid-run. Safe to retry."
        )
    await db[COLL].update_one({"_id": lesson_id}, {"$set": updates})
    fresh = await db[COLL].find_one({"_id": lesson_id}, {"_id": 0})
    return fresh or doc


async def get_or_create_job(db, lesson_id: str) -> dict:
    """Fetch the lesson's production job, creating an empty one on first
    use. Never overwrites an existing job (idempotent)."""
    doc = await db[COLL].find_one({"_id": lesson_id}, {"_id": 0})
    if doc:
        return await _heal_stranded_stages(db, lesson_id, doc)
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
        "sfx": {},  # keyed by sceneId -> lazily-created stage doc, same pattern as voiceProduction
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
    # Additive backfill for jobs created before per-scene SFX generation
    # existed — an empty map is the correct "nothing generated yet" state.
    await db[COLL].update_one(
        {"_id": lesson_id, "sfx": {"$exists": False}},
        {"$set": {"sfx": {}}},
    )
    doc = await db[COLL].find_one({"_id": lesson_id}, {"_id": 0})
    return doc or fresh


async def claim_stage(db, doc_id: str, path: str, *, max_retries: int = MAX_RETRIES,
                       lease_s: int = CLAIM_LEASE_S) -> tuple[dict | None, str]:
    """Atomic compare-and-set claim for one stage. Demotes a stale
    provider_pending lease to unknown_outcome FIRST (never auto-reclaimed
    by THIS demotion step — an ambiguous in-flight provider call is never
    silently repeated), then wins if the stage is pending, an EXPIRED
    claimed lease, failed_retryable with attempts remaining, OR one of the
    two states an admin can explicitly retry from the Studio UI:
    failed_terminal and unknown_outcome (RETRY_ELIGIBLE /
    TERMINAL_RETRY_ELIGIBLE below name exactly these — this filter is what
    actually honors them). Both require a deliberate "Retry" click (this
    function is never called automatically for them), matching the
    "manual retry only" contract: unlike failed_retryable, there is no
    attempt-count ceiling here, since each click is a conscious admin
    decision, not an automatic loop.

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
            {f"{path}.state": S_FAILED_TERMINAL},
            {f"{path}.state": S_UNKNOWN},
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


async def fence_provider(db, doc_id: str, path: str, attempt: str, genver: int, *,
                          lease_s: int = CLAIM_LEASE_S) -> bool:
    """claimed → provider_pending, fenced on attemptId + generationVersion.
    The provider (Gemini/ElevenLabs) is called ONLY when this returns True
    — this is what makes a superseded/duplicate attempt structurally unable
    to spend money.

    Also REFRESHES claimExpiresAt to now + lease_s. CLAIM_LEASE_S (180s) is
    sized for the claim-to-fence handoff, not the provider call itself —
    without this refresh, claimExpiresAt would stay fixed at the ORIGINAL
    claim_stage() call's 180s deadline even while a legitimately slow but
    healthy provider call (e.g. render's ffmpeg mux, which can genuinely
    take several minutes) is still honestly in progress, making it
    indistinguishable from a crashed one to any staleness check. Callers
    should pass their own outer watchdog bound (e.g. video_narration_
    tools.STAGE_TIMEOUT_S) so "stale" means "even the in-process
    asyncio.wait_for watchdog would already have fired by now" — i.e.
    genuinely proof of a dead process, never a still-working one."""
    now = _now_iso()
    kwargs = {"return_document": ReturnDocument.AFTER} if ReturnDocument is not None else {}
    fenced = await db[COLL].find_one_and_update(
        {"_id": doc_id, f"{path}.attemptId": attempt, f"{path}.generationVersion": genver,
         f"{path}.state": S_CLAIMED},
        {"$set": {f"{path}.state": S_PROVIDER_PENDING, f"{path}.providerRequestStartedAt": now,
                  f"{path}.claimExpiresAt": _iso_in(lease_s), "updatedAt": now}},
        **kwargs,
    )
    return fenced is not None


async def complete_stage(db, doc_id: str, path: str, attempt: str, genver: int, result: dict) -> bool:
    """provider_pending → completed, fenced on attemptId + generationVersion.
    A superseded attempt or a stale generation version can never win —
    once another attempt has moved the stage on, this call is a silent
    no-op rather than corrupting a newer result.

    Also accepts the SAME attempt sitting in unknown_outcome: fence_
    provider's lease is deliberately set equal to the caller's own
    asyncio.wait_for bound (see its docstring), so the two clocks are
    approximately but not atomically synchronized. A poll-triggered self-
    heal sweep (_heal_stranded_stages) can observe claimExpiresAt as just
    expired and demote this exact attempt to unknown_outcome a moment
    before a genuinely still-running (not dead) provider call legitimately
    finishes and reaches this call — without this, that real, already-paid-
    for result would be silently discarded and the stage would report
    "stalled, safe to retry" for work that actually succeeded, and a retry
    would re-spend on it. The attemptId + generationVersion fence is what
    keeps this safe: a truly superseded/retried attempt has a different
    genver (claim_stage always increments it), so it's still correctly
    rejected here — only the exact same in-flight attempt racing its own
    self-heal demotion is let through."""
    now = _now_iso()
    kwargs = {"return_document": ReturnDocument.AFTER} if ReturnDocument is not None else {}
    done = await db[COLL].find_one_and_update(
        {"_id": doc_id, f"{path}.attemptId": attempt, f"{path}.generationVersion": genver,
         f"{path}.state": {"$in": [S_PROVIDER_PENDING, S_UNKNOWN]}},
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
