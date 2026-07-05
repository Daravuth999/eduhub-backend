"""tests/test_book_factory_jobs.py
==================================
Concurrency / state-machine tests for the Book Factory job engine.

Self-contained: an in-memory fake Mongo collection implements exactly the
operators the production code relies on (dotted-path queries + updates, $or,
$lt, $in, $set, $inc, $push) with the document-level atomicity that real
Mongo guarantees natively.  The async test loop runs serially, so "concurrent"
here means N calls interleaved through the same loop — which is the precise
property the atomic claim depends on.

NO network / NO real Gemini: book_factory_gemini is monkeypatched and counts
invocations.
"""
from __future__ import annotations

import asyncio
import copy

import pytest

import book_factory_gemini as bf_gemini
import book_factory_jobs as bfj
from book_factory_jobs import (
    S_PENDING, S_CLAIMED, S_PROVIDER_PENDING, S_COMPLETED,
    S_FAILED_RETRYABLE, S_FAILED_TERMINAL, S_UNKNOWN, MAX_RETRIES, COLL,
    _claim_stage, _fence_provider, _complete_stage, _run_blueprint, _run_chapter,
)


def run(coro):
    return asyncio.run(coro)


# ── fake mongo ─────────────────────────────────────────────────────────────
def _dig(doc, path):
    cur = doc
    for part in path.split("."):
        if not isinstance(cur, dict):
            return None
        cur = cur.get(part)
    return cur


def _set_path(doc, path, value):
    parts = path.split(".")
    cur = doc
    for p in parts[:-1]:
        cur = cur.setdefault(p, {})
    cur[parts[-1]] = value


def _cmp(actual, cond):
    if isinstance(cond, dict):
        for op, v in cond.items():
            if op == "$lt":
                if not (actual is not None and actual < v):
                    return False
            elif op == "$gt":
                if not (actual is not None and actual > v):
                    return False
            elif op == "$in":
                if actual not in v:
                    return False
            elif op == "$lte":
                if not (actual is not None and actual <= v):
                    return False
            elif op == "$ne":
                if actual == v:
                    return False
            elif op == "$nin":
                if actual in v:
                    return False
            elif op == "$exists":
                if bool(v) != (actual is not None):
                    return False
            else:
                return False
        return True
    return actual == cond


def _match(doc, query):
    for k, v in query.items():
        if k == "$or":
            if not any(_match(doc, sub) for sub in v):
                return False
            continue
        actual = doc.get("_id") if k == "_id" else _dig(doc, k)
        if not _cmp(actual, v):
            return False
    return True


def _apply(doc, update):
    if "$setOnInsert" in update:
        for k, val in update["$setOnInsert"].items():
            if _dig(doc, k) is None:
                _set_path(doc, k, val)
    if "$set" in update:
        for k, val in update["$set"].items():
            _set_path(doc, k, val)
    if "$inc" in update:
        for k, val in update["$inc"].items():
            _set_path(doc, k, (_dig(doc, k) or 0) + val)
    if "$push" in update:
        for k, val in update["$push"].items():
            arr = _dig(doc, k)
            if not isinstance(arr, list):
                arr = []
                _set_path(doc, k, arr)
            arr.append(val)
    return doc


class _Coll:
    def __init__(self):
        self.docs = {}

    async def create_index(self, *a, **k):
        return None

    async def insert_one(self, doc):
        self.docs[doc["_id"]] = copy.deepcopy(doc)

    async def find_one(self, q, p=None):
        for d in self.docs.values():
            if _match(d, q):
                return copy.deepcopy(d)
        return None

    async def update_one(self, q, up, upsert=False):
        for d in self.docs.values():
            if _match(d, q):
                _apply(d, up)
                return
        if upsert:
            base = {"_id": q.get("_id")}
            _apply(base, up)
            self.docs[base["_id"]] = base

    async def find_one_and_update(self, q, up, projection=None, return_document=None):
        for d in self.docs.values():
            if _match(d, q):
                _apply(d, up)
                return copy.deepcopy(d)
        return None

    def find(self, q):
        return _Cursor([copy.deepcopy(d) for d in self.docs.values() if _match(d, q)])


class _Cursor:
    def __init__(self, rows):
        self._rows = rows

    def sort(self, field, direction=1):
        self._rows.sort(key=lambda d: d.get(field) or "", reverse=(direction < 0))
        return self

    def limit(self, n):
        self._rows = self._rows[:n]
        return self

    async def to_list(self, length=None):
        return self._rows if length is None else self._rows[:length]


class _DB:
    def __init__(self):
        self._c = {}

    def __getitem__(self, name):
        return self._c.setdefault(name, _Coll())


# ── helpers ────────────────────────────────────────────────────────────────
def _seed_job(db, chapter_state=S_PENDING, attempt_count=0, expires="2099-01-01T00:00:00+00:00",
              authored_by="admin-a@test"):
    cid = "bf_ch_test01"
    job = {
        "_id": "job1", "jobId": "job1", "config": {"title": "T", "tier": "premium", "price": 250},
        "state": "blueprint_ready",
        "authoredBy": authored_by,
        "blueprint": {"state": S_COMPLETED, "attemptId": "b1", "attemptCount": 1, "generationVersion": 1},
        "chapters": {
            cid: {
                "chapterId": cid, "position": 0, "title": "Chapter 1",
                "objective": "", "outline": "outline",
                "state": chapter_state, "locked": False,
                "attemptId": "att_seed" if chapter_state != S_PENDING else None,
                "attemptCount": attempt_count, "generationVersion": attempt_count,
                "claimExpiresAt": expires, "warnings": [],
            }
        },
        "chapterOrder": [cid], "warnings": [], "createdAt": "x", "updatedAt": "x",
    }
    run(db[COLL].insert_one(job))
    return cid


_GOOD_CHAPTER = {
    "title": "Chapter 1",
    "paragraphs": ["The cat sat on the warm mat by the door."],
    "dialogueLines": [{"speaker": "Dara", "text": "Hello, how are you today?"}],
    "vocabulary": [{"word": "mat", "meaning": "a small rug"}],
    "pronunciationTargets": ["cat"],
    "speakingPrompts": ["Describe your pet."],
    "mcqs": [{
        "question": "Where did the cat sit?",
        "options": ["on the mat", "on the roof", "in the car"],
        "correctIndex": 0,
        "evidenceQuote": "The cat sat on the warm mat",
        "explain": "Stated in the text.",
    }],
    "fillblanks": [{"text": "The cat sat on the ___.", "answer": "mat", "explain": ""}],
    "summary": "A cat sat on a mat.",
}


@pytest.fixture()
def db():
    return _DB()


# ── tests ──────────────────────────────────────────────────────────────────
def test_two_concurrent_claims_only_one_wins(db):
    cid = _seed_job(db)
    path = f"chapters.{cid}"
    won1, a1 = run(_claim_stage(db, "job1", path))
    won2, a2 = run(_claim_stage(db, "job1", path))
    assert won1 is not None
    assert won2 is None  # lease still valid → second caller loses


def test_step_calls_gemini_exactly_once(db, monkeypatch):
    cid = _seed_job(db)
    calls = {"n": 0}

    async def fake_chapter(config, spec):
        calls["n"] += 1
        return copy.deepcopy(_GOOD_CHAPTER)

    monkeypatch.setattr(bf_gemini, "generate_chapter", fake_chapter)
    r1 = run(_run_chapter(db, "job1", cid))
    r2 = run(_run_chapter(db, "job1", cid))  # already completed → skipped
    assert calls["n"] == 1
    assert r1["status"] == "completed"
    assert r2["status"] == "skipped"


def test_expired_claimed_is_reclaimable(db):
    cid = _seed_job(db, chapter_state=S_CLAIMED, expires="2000-01-01T00:00:00+00:00")
    path = f"chapters.{cid}"
    won, attempt = run(_claim_stage(db, "job1", path))
    assert won is not None
    assert _dig(won, f"{path}.state") == S_CLAIMED
    assert _dig(won, f"{path}.attemptId") == attempt


def test_superseded_attempt_cannot_call_provider(db):
    cid = _seed_job(db)
    path = f"chapters.{cid}"
    run(_claim_stage(db, "job1", path))  # current attempt is now X
    # A stale caller holding a superseded attemptId tries to enter provider.
    ok = run(_fence_provider(db, "job1", path, "att_superseded", 1))
    assert ok is False


def test_superseded_attempt_cannot_overwrite_newer_result(db):
    cid = _seed_job(db)
    path = f"chapters.{cid}"
    # Newer attempt has completed.
    coll = db[COLL]
    run(coll.update_one({"_id": "job1"}, {"$set": {
        f"{path}.state": S_COMPLETED, f"{path}.attemptId": "att_new",
        f"{path}.blocks": [{"type": "paragraph", "text": "NEW"}],
    }}))
    ok = run(_complete_stage(db, "job1", path, "att_old", 0,
                             {"blocks": [{"type": "paragraph", "text": "OLD"}]}))
    assert ok is False
    doc = run(coll.find_one({"_id": "job1"}))
    assert _dig(doc, f"{path}.blocks")[0]["text"] == "NEW"


def test_stale_provider_pending_becomes_unknown(db):
    cid = _seed_job(db, chapter_state=S_PROVIDER_PENDING, expires="2000-01-01T00:00:00+00:00")
    path = f"chapters.{cid}"
    won, _ = run(_claim_stage(db, "job1", path))
    assert won is None  # not reclaimable
    doc = run(db[COLL].find_one({"_id": "job1"}))
    assert _dig(doc, f"{path}.state") == S_UNKNOWN


def test_unknown_outcome_never_auto_retries(db, monkeypatch):
    cid = _seed_job(db, chapter_state=S_UNKNOWN)
    calls = {"n": 0}

    async def fake_chapter(config, spec):
        calls["n"] += 1
        return copy.deepcopy(_GOOD_CHAPTER)

    monkeypatch.setattr(bf_gemini, "generate_chapter", fake_chapter)
    r = run(_run_chapter(db, "job1", cid))
    assert calls["n"] == 0
    assert r["status"] == "skipped"
    assert r["reason"] == S_UNKNOWN


def test_retry_budget_is_three_attempts_then_terminal(db, monkeypatch):
    cid = _seed_job(db)
    calls = {"n": 0}

    async def boom(config, spec):
        calls["n"] += 1
        raise RuntimeError("gemini down")

    monkeypatch.setattr(bf_gemini, "generate_chapter", boom)
    path = f"chapters.{cid}"
    states = []
    for _ in range(6):  # more than the budget; extras must be no-ops
        run(_run_chapter(db, "job1", cid))
        doc = run(db[COLL].find_one({"_id": "job1"}))
        states.append(_dig(doc, f"{path}.state"))
    assert calls["n"] == MAX_RETRIES + 1 == 3
    assert states[-1] == S_FAILED_TERMINAL


def test_blueprint_builds_chapter_map(db, monkeypatch):
    run(db[COLL].insert_one({
        "_id": "j2", "jobId": "j2", "config": {"title": "Book", "chapterCount": 2},
        "state": "created",
        "blueprint": {"state": S_PENDING, "attemptId": None, "attemptCount": 0, "generationVersion": 0},
        "chapters": {}, "chapterOrder": [], "warnings": [],
        "createdAt": "x", "updatedAt": "x",
    }))

    async def fake_bp(config):
        return {"bookTitle": "Book", "summary": "s",
                "chapters": [{"title": "One", "outline": "o1"}, {"title": "Two", "outline": "o2"}]}

    monkeypatch.setattr(bf_gemini, "generate_blueprint", fake_bp)
    r = run(_run_blueprint(db, "j2"))
    assert r["status"] == "completed"
    doc = run(db[COLL].find_one({"_id": "j2"}))
    assert len(doc["chapterOrder"]) == 2
    assert all(doc["chapters"][c]["state"] == S_PENDING for c in doc["chapterOrder"])


def test_chapter_composes_canonical_blocks_with_exercises(db, monkeypatch):
    cid = _seed_job(db)

    async def fake_chapter(config, spec):
        return copy.deepcopy(_GOOD_CHAPTER)

    monkeypatch.setattr(bf_gemini, "generate_chapter", fake_chapter)
    run(_run_chapter(db, "job1", cid))
    doc = run(db[COLL].find_one({"_id": "job1"}))
    blocks = doc["chapters"][cid]["blocks"]
    types = [b["type"] for b in blocks]
    assert "paragraph" in types and "dialog" in types and "mcq" in types and "fillblank" in types
    mcq = next(b for b in blocks if b["type"] == "mcq")
    assert "evidenceQuote" not in mcq          # stripped before composition
    assert mcq["answer"] == "on the mat"        # full correct option text


def test_invalid_mcq_repaired_then_dropped(db, monkeypatch):
    cid = _seed_job(db)
    bad = copy.deepcopy(_GOOD_CHAPTER)
    bad["mcqs"] = [{
        "question": "Bad?", "options": ["x", "y"], "correctIndex": 0,
        "evidenceQuote": "this phrase is nowhere in the chapter at all",
    }]

    async def fake_chapter(config, spec):
        return copy.deepcopy(bad)

    async def fake_repair(mcq, chapter_text):
        # repair still cites a non-existent quote → must be dropped
        return {"question": "Bad?", "options": ["x", "y"], "correctIndex": 0,
                "evidenceQuote": "still not present anywhere"}

    monkeypatch.setattr(bf_gemini, "generate_chapter", fake_chapter)
    monkeypatch.setattr(bf_gemini, "repair_mcq", fake_repair)
    run(_run_chapter(db, "job1", cid))
    doc = run(db[COLL].find_one({"_id": "job1"}))
    blocks = doc["chapters"][cid]["blocks"]
    assert not any(b["type"] == "mcq" for b in blocks)   # dropped
    assert any(w["type"] == "mcq_dropped" for w in doc["chapters"][cid]["warnings"])
