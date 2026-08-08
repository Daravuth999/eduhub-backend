"""tests/test_video_narration_jobs.py — the generic AI-narration job-stage
engine (claim/fence/complete/fail), reimplemented from book_factory_jobs.py's
proven pattern for Video Library. Covers atomic claims, attempt/generation
fencing (a superseded attempt can never win), retry-until-terminal
classification, stale provider_pending reclaim-as-unknown, and — the core
cost-safety guarantee — that a completed stage is never re-claimable, so a
downstream failure can never trigger re-payment for upstream work.
"""
from __future__ import annotations

import asyncio

import pytest

import video_narration_jobs as jobs


def _match(doc: dict, query: dict) -> bool:
    for k, v in query.items():
        if k == "$or":
            if not any(_match(doc, sub) for sub in v):
                return False
            continue
        if isinstance(v, dict) and "$lt" in v:
            actual = _get_dotted(doc, k)
            if actual is None or not (actual < v["$lt"]):
                return False
            continue
        if isinstance(v, dict) and "$in" in v:
            if _get_dotted(doc, k) not in v["$in"]:
                return False
            continue
        if _get_dotted(doc, k) != v:
            return False
    return True


def _get_dotted(doc: dict, path: str):
    cur = doc
    for part in path.split("."):
        if not isinstance(cur, dict):
            return None
        cur = cur.get(part)
    return cur


def _set_dotted(doc: dict, path: str, value) -> None:
    parts = path.split(".")
    cur = doc
    for part in parts[:-1]:
        cur = cur.setdefault(part, {})
    cur[parts[-1]] = value


def _inc_dotted(doc: dict, path: str, amount: int) -> None:
    cur = _get_dotted(doc, path) or 0
    _set_dotted(doc, path, cur + amount)


class _Coll:
    def __init__(self):
        self.docs: dict = {}

    async def create_index(self, *a, **k):
        return None

    async def find_one(self, query, projection=None):
        for doc in self.docs.values():
            if _match(doc, query):
                out = dict(doc)
                if projection and projection.get("_id") == 0:
                    out.pop("_id", None)
                return out
        return None

    async def update_one(self, query, update, upsert=False):
        for doc in self.docs.values():
            if _match(doc, query):
                if "$set" in update:
                    for k, v in update["$set"].items():
                        _set_dotted(doc, k, v)
                return None
        if upsert and "$setOnInsert" in update:
            new_doc = dict(update["$setOnInsert"])
            self.docs[new_doc["_id"]] = new_doc
        return None

    async def find_one_and_update(self, query, update, **kwargs):
        for doc in self.docs.values():
            if _match(doc, query):
                if "$set" in update:
                    for k, v in update["$set"].items():
                        _set_dotted(doc, k, v)
                if "$inc" in update:
                    for k, v in update["$inc"].items():
                        _inc_dotted(doc, k, v)
                return dict(doc)
        return None


class _FakeDB:
    def __init__(self):
        self.video_narration_jobs = _Coll()

    def __getitem__(self, name):
        assert name == jobs.COLL
        return self.video_narration_jobs


@pytest.mark.asyncio
async def test_get_or_create_job_seeds_all_stages_pending():
    db = _FakeDB()
    doc = await jobs.get_or_create_job(db, "vid_1")
    assert doc["storyAnalysis"]["state"] == jobs.S_PENDING
    assert doc["scriptBlueprint"]["state"] == jobs.S_PENDING
    assert doc["voiceAssignments"] == {}
    assert doc["published"] is False


@pytest.mark.asyncio
async def test_get_or_create_job_is_idempotent():
    db = _FakeDB()
    first = await jobs.get_or_create_job(db, "vid_1")
    assert "vid_1" in db.video_narration_jobs.docs  # sanity: doc exists
    _set_dotted(db.video_narration_jobs.docs["vid_1"], "storyAnalysis.state", jobs.S_COMPLETED)
    second = await jobs.get_or_create_job(db, "vid_1")
    assert second["storyAnalysis"]["state"] == jobs.S_COMPLETED  # not reset


@pytest.mark.asyncio
async def test_claim_stage_wins_on_pending():
    db = _FakeDB()
    await jobs.get_or_create_job(db, "vid_1")
    claimed, attempt = await jobs.claim_stage(db, "vid_1", "storyAnalysis")
    assert claimed is not None
    assert claimed["storyAnalysis"]["state"] == jobs.S_CLAIMED
    assert claimed["storyAnalysis"]["attemptId"] == attempt
    assert claimed["storyAnalysis"]["generationVersion"] == 1


@pytest.mark.asyncio
async def test_claim_stage_loses_when_already_claimed_and_not_expired():
    db = _FakeDB()
    await jobs.get_or_create_job(db, "vid_1")
    await jobs.claim_stage(db, "vid_1", "storyAnalysis")
    claimed2, _ = await jobs.claim_stage(db, "vid_1", "storyAnalysis")
    assert claimed2 is None


@pytest.mark.asyncio
async def test_full_success_cycle_claim_fence_complete():
    db = _FakeDB()
    await jobs.get_or_create_job(db, "vid_1")
    claimed, attempt = await jobs.claim_stage(db, "vid_1", "storyAnalysis")
    genver = claimed["storyAnalysis"]["generationVersion"]

    fenced = await jobs.fence_provider(db, "vid_1", "storyAnalysis", attempt, genver)
    assert fenced is True

    ok = await jobs.complete_stage(db, "vid_1", "storyAnalysis", attempt, genver, {"scenes": []})
    assert ok is True

    doc = await db.video_narration_jobs.find_one({"_id": "vid_1"})
    assert doc["storyAnalysis"]["state"] == jobs.S_COMPLETED
    assert doc["storyAnalysis"]["result"] == {"scenes": []}


@pytest.mark.asyncio
async def test_completed_stage_is_never_reclaimable_cost_safety():
    """The core cost-control guarantee: once a stage succeeds, no later
    retry (triggered by a DIFFERENT stage failing) can ever re-claim it
    and re-pay for the same work."""
    db = _FakeDB()
    await jobs.get_or_create_job(db, "vid_1")
    claimed, attempt = await jobs.claim_stage(db, "vid_1", "storyAnalysis")
    genver = claimed["storyAnalysis"]["generationVersion"]
    await jobs.fence_provider(db, "vid_1", "storyAnalysis", attempt, genver)
    await jobs.complete_stage(db, "vid_1", "storyAnalysis", attempt, genver, {"scenes": ["s1"]})

    reclaim, _ = await jobs.claim_stage(db, "vid_1", "storyAnalysis")
    assert reclaim is None
    doc = await db.video_narration_jobs.find_one({"_id": "vid_1"})
    assert doc["storyAnalysis"]["result"] == {"scenes": ["s1"]}  # untouched


@pytest.mark.asyncio
async def test_scene_level_retry_never_touches_sibling_scenes():
    """Scene 1/2/4 completed, Scene 3 fails — retrying Scene 3 must never
    re-claim or alter Scenes 1, 2, or 4."""
    db = _FakeDB()
    await jobs.get_or_create_job(db, "vid_1")
    for scene in ("sc1", "sc2", "sc4"):
        path = f"voiceProduction.{scene}.lines.ln0"
        _set_dotted(db.video_narration_jobs.docs["vid_1"], path, jobs.new_stage())
        claimed, attempt = await jobs.claim_stage(db, "vid_1", path)
        genver = _get_dotted(claimed, path)["generationVersion"]
        await jobs.fence_provider(db, "vid_1", path, attempt, genver)
        await jobs.complete_stage(db, "vid_1", path, attempt, genver, {"audioUrl": f"{scene}.mp3"})

    sc3_path = "voiceProduction.sc3.lines.ln0"
    _set_dotted(db.video_narration_jobs.docs["vid_1"], sc3_path, jobs.new_stage())
    claimed, attempt = await jobs.claim_stage(db, "vid_1", sc3_path)
    genver = _get_dotted(claimed, sc3_path)["generationVersion"]
    await jobs.fence_provider(db, "vid_1", sc3_path, attempt, genver)
    await jobs.fail_stage(db, "vid_1", sc3_path, attempt, genver, "elevenlabs_5xx")

    # Retry scene 3 only.
    claimed2, attempt2 = await jobs.claim_stage(db, "vid_1", sc3_path)
    assert claimed2 is not None
    genver2 = _get_dotted(claimed2, sc3_path)["generationVersion"]
    await jobs.fence_provider(db, "vid_1", sc3_path, attempt2, genver2)
    await jobs.complete_stage(db, "vid_1", sc3_path, attempt2, genver2, {"audioUrl": "sc3.mp3"})

    doc = await db.video_narration_jobs.find_one({"_id": "vid_1"})
    for scene in ("sc1", "sc2", "sc4"):
        path = f"voiceProduction.{scene}.lines.ln0"
        assert _get_dotted(doc, path)["state"] == jobs.S_COMPLETED
        assert _get_dotted(doc, path)["result"] == {"audioUrl": f"{scene}.mp3"}
        assert _get_dotted(doc, path)["attemptCount"] == 1  # never re-claimed
    assert _get_dotted(doc, sc3_path)["state"] == jobs.S_COMPLETED
    assert _get_dotted(doc, sc3_path)["result"] == {"audioUrl": "sc3.mp3"}


@pytest.mark.asyncio
async def test_fail_stage_becomes_retryable_then_terminal_after_budget_exhausted():
    db = _FakeDB()
    await jobs.get_or_create_job(db, "vid_1")
    for _ in range(jobs.MAX_RETRIES + 1):
        claimed, attempt = await jobs.claim_stage(db, "vid_1", "storyAnalysis")
        assert claimed is not None, "should still be claimable within the retry budget"
        genver = claimed["storyAnalysis"]["generationVersion"]
        await jobs.fence_provider(db, "vid_1", "storyAnalysis", attempt, genver)
        new_state = await jobs.fail_stage(db, "vid_1", "storyAnalysis", attempt, genver, "boom")

    assert new_state == jobs.S_FAILED_TERMINAL
    reclaim, _ = await jobs.claim_stage(db, "vid_1", "storyAnalysis")
    assert reclaim is None  # terminal is never auto-retryable


@pytest.mark.asyncio
async def test_fenced_completion_rejects_superseded_attempt():
    """A late completion from an OLD attempt must never overwrite a newer
    attempt's state (attemptId + generationVersion fencing)."""
    db = _FakeDB()
    await jobs.get_or_create_job(db, "vid_1")
    claimed1, attempt1 = await jobs.claim_stage(db, "vid_1", "storyAnalysis")
    genver1 = claimed1["storyAnalysis"]["generationVersion"]
    await jobs.fence_provider(db, "vid_1", "storyAnalysis", attempt1, genver1)
    # Simulate attempt1 being abandoned (lease not renewed) and reclaimed —
    # here we just force-fail it and let a second claim happen.
    await jobs.fail_stage(db, "vid_1", "storyAnalysis", attempt1, genver1, "timeout")
    claimed2, attempt2 = await jobs.claim_stage(db, "vid_1", "storyAnalysis")
    genver2 = claimed2["storyAnalysis"]["generationVersion"]
    await jobs.fence_provider(db, "vid_1", "storyAnalysis", attempt2, genver2)

    # The stale attempt1 tries to complete AFTER attempt2 has already claimed.
    stale_ok = await jobs.complete_stage(db, "vid_1", "storyAnalysis", attempt1, genver1, {"scenes": ["stale"]})
    assert stale_ok is False

    ok2 = await jobs.complete_stage(db, "vid_1", "storyAnalysis", attempt2, genver2, {"scenes": ["fresh"]})
    assert ok2 is True
    doc = await db.video_narration_jobs.find_one({"_id": "vid_1"})
    assert doc["storyAnalysis"]["result"] == {"scenes": ["fresh"]}


@pytest.mark.asyncio
async def test_concurrent_claims_only_one_wins():
    db = _FakeDB()
    await jobs.get_or_create_job(db, "vid_1")
    results = await asyncio.gather(*[jobs.claim_stage(db, "vid_1", "storyAnalysis") for _ in range(5)])
    wins = [r for r, _ in results if r is not None]
    assert len(wins) == 1


@pytest.mark.asyncio
async def test_fail_unknown_is_never_auto_retryable():
    db = _FakeDB()
    await jobs.get_or_create_job(db, "vid_1")
    claimed, attempt = await jobs.claim_stage(db, "vid_1", "storyAnalysis")
    genver = claimed["storyAnalysis"]["generationVersion"]
    await jobs.fence_provider(db, "vid_1", "storyAnalysis", attempt, genver)
    state = await jobs.fail_unknown(db, "vid_1", "storyAnalysis", attempt, genver, "network timeout mid-request")
    assert state == jobs.S_UNKNOWN
    reclaim, _ = await jobs.claim_stage(db, "vid_1", "storyAnalysis")
    assert reclaim is None
