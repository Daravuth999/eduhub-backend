"""tests/test_book_factory_chapter_hotfix.py
=================================================
EMERGENCY SURGICAL HOTFIX regression tests: optional-enrichment defects
(IPA/Khmer/vocab-item/MCQ/fillblank) must never fail an otherwise-valid
chapter, a genuinely malformed/empty whole-chapter response is still bounded
to exactly 2 provider calls before failed_terminal, a later /step can never
create a 3rd provider call, and an explicit teacher-confirmed "Retry Chapter"
action can recover a failed_terminal chapter without touching any other
chapter. NO real Gemini/network — book_factory_gemini.generate_chapter is
monkeypatched with bare (config, spec) fakes throughout (see _call_provider's
documented bare-signature convention in book_factory_jobs.py).
"""
from __future__ import annotations

import copy

import pytest
from fastapi import APIRouter, FastAPI, HTTPException
from fastapi.testclient import TestClient

import book_factory_gemini as bf_gemini
import book_factory_jobs as bfj
from book_factory_jobs import (
    S_COMPLETED, S_FAILED_TERMINAL, S_PENDING, _run_chapter,
)
from tests.test_book_factory_jobs import _DB, _dig, _seed_job, COLL


def run(coro):
    import asyncio
    return asyncio.run(coro)


_BASE_GOOD = {
    "title": "Chapter 1",
    "paragraphs": ["The team met on Monday to discuss the new project plan."],
    "dialogueLines": [{"speaker": "Dara", "text": "Can we push the deadline back a week?"}],
    "vocabulary": [],
    "pronunciationTargets": [],
    "speakingPrompts": [],
    "mcqs": [],
    "fillblanks": [],
    "summary": "The team discussed the project plan.",
}


def _good_with(**overrides):
    doc = copy.deepcopy(_BASE_GOOD)
    doc.update(overrides)
    return doc


@pytest.fixture()
def db():
    return _DB()


# ── 1. valid paragraphs + invalid IPA → completes, IPA omitted, warned ─────
def test_1_invalid_ipa_completes_with_warning_one_call(db, monkeypatch):
    cid = _seed_job(db)
    chapter = _good_with(vocabulary=[{
        "word": "deadline", "definitionEnglish": "the time by which something must be done",
        "ipa": "deadline",  # plain spelling, not real IPA → rejected
    }])
    calls = {"n": 0}

    async def fake_chapter(config, spec):
        calls["n"] += 1
        return copy.deepcopy(chapter)

    monkeypatch.setattr(bf_gemini, "generate_chapter", fake_chapter)
    r = run(_run_chapter(db, "job1", cid))
    assert r["status"] == "completed"
    assert calls["n"] == 1
    doc = run(db[COLL].find_one({"_id": "job1"}))
    ch = doc["chapters"][cid]
    assert ch["state"] == S_COMPLETED
    assert ch["providerCallCount"] == 1
    assert any(w["type"] == "vocab_issue" and "vocab_ipa_rejected" in (w.get("reason") or "")
               for w in ch["warnings"])
    vocab_blocks = [b for b in ch["blocks"] if b["type"] == "markdown" and "deadline" in b["text"]]
    assert vocab_blocks and "IPA" not in vocab_blocks[0]["text"]
    assert "the time by which something must be done" in vocab_blocks[0]["text"]


# ── 2. valid paragraphs + missing Khmer → completes, English vocab kept ────
def test_2_missing_khmer_completes_with_warning_one_call(db, monkeypatch):
    cid = _seed_job(db)
    chapter = _good_with(vocabulary=[{
        "word": "reallocate", "definitionEnglish": "to assign resources differently",
    }])  # no explanationKhmer at all
    calls = {"n": 0}

    async def fake_chapter(config, spec):
        calls["n"] += 1
        return copy.deepcopy(chapter)

    monkeypatch.setattr(bf_gemini, "generate_chapter", fake_chapter)
    r = run(_run_chapter(db, "job1", cid))
    assert r["status"] == "completed"
    assert calls["n"] == 1
    doc = run(db[COLL].find_one({"_id": "job1"}))
    ch = doc["chapters"][cid]
    assert ch["state"] == S_COMPLETED
    assert ch["providerCallCount"] == 1
    assert any(w["type"] == "vocab_issue" and "vocab_khmer_missing:" in (w.get("reason") or "")
               for w in ch["warnings"])
    vocab_blocks = [b for b in ch["blocks"] if b["type"] == "markdown" and "reallocate" in b["text"]]
    assert vocab_blocks and "assign resources differently" in vocab_blocks[0]["text"]


# ── 3. some malformed vocabulary entries dropped, valid retained ───────────
def test_3_malformed_vocab_item_dropped_valid_retained(db, monkeypatch):
    cid = _seed_job(db)
    chapter = _good_with(vocabulary=[
        {"word": "escalate", "definitionEnglish": "to raise an issue to a higher level"},
        {"word": "", "definitionEnglish": "missing word field"},  # unusable → dropped
    ])

    async def fake_chapter(config, spec):
        return copy.deepcopy(chapter)

    monkeypatch.setattr(bf_gemini, "generate_chapter", fake_chapter)
    r = run(_run_chapter(db, "job1", cid))
    assert r["status"] == "completed"
    doc = run(db[COLL].find_one({"_id": "job1"}))
    ch = doc["chapters"][cid]
    vocab_blocks = [b for b in ch["blocks"] if b["type"] == "markdown" and "📘" in b["text"]]
    assert len(vocab_blocks) == 1
    assert "escalate" in vocab_blocks[0]["text"]
    assert any(w.get("reason") == "vocab_missing_or_invalid_word" for w in ch["warnings"])


# ── 4. too many vocabulary entries clamped to CEFR (A2 default: 4-5) ───────
def test_4_excess_vocab_clamped_to_cefr_max(db, monkeypatch):
    cid = _seed_job(db)
    vocab = [{"word": f"word{i}", "definitionEnglish": f"meaning {i}"} for i in range(8)]
    chapter = _good_with(vocabulary=vocab)

    async def fake_chapter(config, spec):
        return copy.deepcopy(chapter)

    monkeypatch.setattr(bf_gemini, "generate_chapter", fake_chapter)
    r = run(_run_chapter(db, "job1", cid))
    assert r["status"] == "completed"
    doc = run(db[COLL].find_one({"_id": "job1"}))
    ch = doc["chapters"][cid]
    vocab_blocks = [b for b in ch["blocks"] if b["type"] == "markdown" and "📘" in b["text"]]
    assert len(vocab_blocks) == 5  # A2 CEFR ceiling (vocab_count_range("A2") == (4, 5))


# ── 5. invalid MCQ / fillblank dropped, chapter completes ──────────────────
def test_5_invalid_exercises_dropped_chapter_completes(db, monkeypatch):
    cid = _seed_job(db)
    text = "The team met on Monday to discuss the new project plan."
    chapter = _good_with(
        paragraphs=[text],
        mcqs=[
            {"question": "Q ok", "options": ["a", "b"], "correctIndex": 0,
             "evidenceQuote": "team met on Monday", "explain": ""},
            {"question": "Q bad", "options": ["a", "b"], "correctIndex": 0,
             "evidenceQuote": "this text never appears anywhere"},
        ],
        fillblanks=[
            {"text": "The team ___ on Monday.", "answer": "met", "explain": ""},
            {"text": "no blank marker here", "answer": "x"},
        ],
    )

    async def fake_chapter(config, spec):
        return copy.deepcopy(chapter)

    monkeypatch.setattr(bf_gemini, "generate_chapter", fake_chapter)
    r = run(_run_chapter(db, "job1", cid))
    assert r["status"] == "completed"
    doc = run(db[COLL].find_one({"_id": "job1"}))
    ch = doc["chapters"][cid]
    mcqs = [b for b in ch["blocks"] if b["type"] == "mcq"]
    fbs = [b for b in ch["blocks"] if b["type"] == "fillblank"]
    assert len(mcqs) == 1 and mcqs[0]["text"] == "Q ok"
    assert len(fbs) == 1 and fbs[0]["answer"] == "met"
    assert any(w["type"] == "mcq_dropped" for w in ch["warnings"])
    assert any(w["type"] == "fillblank_dropped" for w in ch["warnings"])


# ── 6. genuinely empty/malformed whole chapter: 2 calls then terminal ──────
def test_6_empty_semantic_content_consumes_two_calls_then_terminal(db, monkeypatch):
    cid = _seed_job(db)
    calls = {"n": 0}

    async def fake_empty(config, spec):
        calls["n"] += 1
        return {}  # valid JSON, zero usable content on both attempts

    monkeypatch.setattr(bf_gemini, "generate_chapter", fake_empty)
    r = run(_run_chapter(db, "job1", cid))
    assert calls["n"] == 2
    assert r["status"] == "failed"
    assert r["reason"] == "empty_canonical_blocks"
    doc = run(db[COLL].find_one({"_id": "job1"}))
    ch = doc["chapters"][cid]
    assert ch["state"] == S_FAILED_TERMINAL
    assert ch["providerCallCount"] == 2
    # §HOTFIX diagnostics: sanitized shape info persisted, no raw content.
    assert ch.get("diagnostics", {}).get("isObject") is True
    assert ch["diagnostics"]["topLevelKeys"] == []


# ── 7. a later /step can never create provider call 3 ──────────────────────
def test_7_later_step_cannot_create_third_provider_call(db, monkeypatch):
    cid = _seed_job(db)
    calls = {"n": 0}

    async def fake_empty(config, spec):
        calls["n"] += 1
        return {}

    monkeypatch.setattr(bf_gemini, "generate_chapter", fake_empty)
    run(_run_chapter(db, "job1", cid))
    assert calls["n"] == 2
    r2 = run(_run_chapter(db, "job1", cid))  # terminal chapters are not claimable
    assert r2["status"] == "skipped"
    assert calls["n"] == 2  # unchanged — no phantom 3rd call


# ── 8. explicit Retry Chapter recovery for a failed_terminal chapter ───────
async def _admin_dep():
    return {"email": "admin-a@test"}


def _make_client(db):
    app = FastAPI()
    api = APIRouter(prefix="/api")
    bfj.register_book_factory_routes(api, db, _admin_dep)
    app.include_router(api)
    return TestClient(app)


def _enable(monkeypatch):
    monkeypatch.setenv("BOOK_FACTORY_ENABLED", "true")
    monkeypatch.setenv("BOOK_FACTORY_GEMINI_ENABLED", "true")
    monkeypatch.setenv("GEMINI_API_KEY", "test-key")


def test_8_retry_failed_resets_only_target_chapter(db, monkeypatch):
    _enable(monkeypatch)
    cid = _seed_job(db)
    # A second, already-completed chapter must remain untouched.
    other_cid = "bf_ch_other"
    doc = run(db[COLL].find_one({"_id": "job1"}))
    doc["chapters"][other_cid] = {
        "chapterId": other_cid, "position": 1, "title": "Chapter 2",
        "state": S_COMPLETED, "locked": False, "attemptId": "att_x",
        "attemptCount": 1, "generationVersion": 1,
        "blocks": [{"type": "paragraph", "text": "Untouched content."}],
        "warnings": [],
    }
    doc["chapterOrder"].append(other_cid)
    db[COLL].docs["job1"] = doc

    async def fake_empty(config, spec):
        return {}

    monkeypatch.setattr(bf_gemini, "generate_chapter", fake_empty)
    run(_run_chapter(db, "job1", cid))
    pre = run(db[COLL].find_one({"_id": "job1"}))
    assert pre["chapters"][cid]["state"] == S_FAILED_TERMINAL

    client = _make_client(db)
    resp = client.post(f"/api/studio/book-factory/jobs/job1/chapters/{cid}/retry-failed")
    assert resp.status_code == 200
    job = resp.json()["job"]
    assert job["chapters"][cid]["state"] == S_PENDING
    assert job["chapters"][cid]["attemptCount"] == 0
    assert job["chapters"][cid]["providerCallCount"] == 0
    assert job["chapters"][cid]["blocks"] == []
    assert job["chapters"][cid]["lastError"] is None
    # The OTHER chapter (already completed) is completely untouched.
    assert job["chapters"][other_cid]["state"] == S_COMPLETED
    assert job["chapters"][other_cid]["blocks"][0]["text"] == "Untouched content."

    # Fresh retry allowance: a subsequent good generation now completes.
    async def fake_good(config, spec):
        return copy.deepcopy(_good_with())

    monkeypatch.setattr(bf_gemini, "generate_chapter", fake_good)
    r = run(_run_chapter(db, "job1", cid))
    assert r["status"] == "completed"


def test_8b_retry_failed_rejects_completed_chapter(db, monkeypatch):
    _enable(monkeypatch)
    cid = _seed_job(db, chapter_state=S_COMPLETED)
    client = _make_client(db)
    resp = client.post(f"/api/studio/book-factory/jobs/job1/chapters/{cid}/retry-failed")
    assert resp.status_code == 409


def test_8c_retry_failed_requires_admin(monkeypatch):
    _enable(monkeypatch)
    db = _DB()
    cid = _seed_job(db)

    async def deny():
        raise HTTPException(status_code=403, detail="Admin access required")

    app = FastAPI()
    api = APIRouter(prefix="/api")
    bfj.register_book_factory_routes(api, db, deny)
    app.include_router(api)
    client = TestClient(app)
    resp = client.post(f"/api/studio/book-factory/jobs/job1/chapters/{cid}/retry-failed")
    assert resp.status_code == 403


def test_8d_retry_failed_is_owner_scoped(db, monkeypatch):
    _enable(monkeypatch)
    cid = _seed_job(db, authored_by="owner-a@test")

    async def other_admin():
        return {"email": "owner-b@test"}

    app = FastAPI()
    api = APIRouter(prefix="/api")
    bfj.register_book_factory_routes(api, db, other_admin)
    app.include_router(api)
    client = TestClient(app)
    resp = client.post(f"/api/studio/book-factory/jobs/job1/chapters/{cid}/retry-failed")
    assert resp.status_code == 404  # another admin's job is invisible, not 403


# ── 9. nine-chapter mixed-result simulation ────────────────────────────────
def _seed_multi_chapter_job(db, n=9):
    chapters = {}
    order = []
    for i in range(n):
        cid = f"bf_ch_{i}"
        chapters[cid] = {
            "chapterId": cid, "position": i, "title": f"Chapter {i}",
            "objective": "", "outline": "outline",
            "state": S_PENDING, "locked": False, "attemptId": None,
            "attemptCount": 0, "generationVersion": 0,
            "claimExpiresAt": "2099-01-01T00:00:00+00:00", "warnings": [],
        }
        order.append(cid)
    job = {
        "_id": "jobM", "jobId": "jobM", "config": {"title": "T", "tier": "premium", "price": 0},
        "state": "blueprint_ready", "authoredBy": "admin-a@test",
        "blueprint": {"state": S_COMPLETED, "attemptId": "b1", "attemptCount": 1, "generationVersion": 1},
        "chapters": chapters, "chapterOrder": order, "warnings": [],
        "createdAt": "x", "updatedAt": "x",
    }
    run(db[COLL].insert_one(job))
    return order


def test_9_nine_chapter_mixed_enrichment_defects_never_terminal(db, monkeypatch):
    order = _seed_multi_chapter_job(db, 9)
    # Chapter index 4 (the ONLY genuinely malformed one) always returns {}.
    # Every other chapter has valid core content but multiple enrichment
    # defects (bad IPA, missing Khmer, one bad MCQ) — none of these eight
    # may become failed_terminal.
    bad_index = 4

    async def fake_chapter(config, spec):
        title = spec.get("title") or ""
        idx = int(title.split()[-1]) if title.split() and title.split()[-1].isdigit() else -1
        if idx == bad_index:
            return {}
        return _good_with(
            title=title,
            vocabulary=[
                {"word": "outcome", "definitionEnglish": "a result", "ipa": "outcome"},
                {"word": "insight", "definitionEnglish": "understanding"},  # no Khmer
            ],
            mcqs=[{"question": "bad", "options": ["a", "b"], "correctIndex": 0,
                   "evidenceQuote": "not present anywhere in this chapter text"}],
        )

    monkeypatch.setattr(bf_gemini, "generate_chapter", fake_chapter)
    for cid in order:
        run(_run_chapter(db, "jobM", cid))

    doc = run(db[COLL].find_one({"_id": "jobM"}))
    states = {cid: doc["chapters"][cid]["state"] for cid in order}
    bad_cid = order[bad_index]
    good_cids = [c for c in order if c != bad_cid]

    assert states[bad_cid] == S_FAILED_TERMINAL
    for c in good_cids:
        assert states[c] == S_COMPLETED, f"{c} should complete despite enrichment defects, got {states[c]}"
        assert doc["chapters"][c]["warnings"], "enrichment defects should still be recorded as warnings"

    # Provider-call bound: 8 good chapters * 1 call + 1 bad chapter * 2 calls = 10.
    provider_calls = sum(doc["chapters"][c].get("providerCallCount", 0) for c in order)
    assert provider_calls == 8 * 1 + 1 * 2
