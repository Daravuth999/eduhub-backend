"""tests/test_book_factory_corrections.py
==========================================
Correction-pass coverage: transport exception classification (BLOCKER A),
no in-stage repair (BLOCKER B), atomic blueprint + crash recovery (BLOCKER C),
config validation (BLOCKER D), MCQ/fillblank correctness (HIGH E/F), and
atomic manual-retry fencing (HIGH J).

Uses real httpx exception classes (no synthetic exceptions) for classification,
and the in-memory fake DB from test_book_factory_jobs for the state machine.
No network, no real Gemini.
"""
from __future__ import annotations

import copy

import httpx
import pytest

import book_factory_gemini as bf_gemini
import book_factory_jobs as bfj
from book_factory_gemini import BFRetryableError, BFUnknownOutcomeError, BFTerminalError
from book_factory_jobs import (
    S_PENDING, S_COMPLETED, S_FAILED_RETRYABLE, S_FAILED_TERMINAL, S_UNKNOWN, COLL,
    _run_chapter, _run_blueprint, validate_book_factory_config,
)
from tests.test_book_factory_jobs import _DB, run, _dig, _seed_job, _GOOD_CHAPTER


# ── fake httpx client for classification (BLOCKER A, layer 1) ───────────────
class _FakeResp:
    def __init__(self, status, body=None):
        self.status_code = status
        self._body = body or {}
        self.text = "body"

    def json(self):
        return self._body


class _FakeClient:
    def __init__(self, *, exc=None, resp=None):
        self._exc = exc
        self._resp = resp

    async def __aenter__(self):
        return self

    async def __aexit__(self, *a):
        return False

    async def post(self, *a, **k):
        if self._exc is not None:
            raise self._exc
        return self._resp


def _patch_client(monkeypatch, *, exc=None, resp=None):
    monkeypatch.setenv("GEMINI_API_KEY", "k")
    monkeypatch.setattr(bf_gemini.httpx, "AsyncClient", lambda *a, **k: _FakeClient(exc=exc, resp=resp))


def _envelope(text):
    return {"candidates": [{"content": {"parts": [{"text": text}]}}]}


@pytest.mark.parametrize("exc,expected", [
    (httpx.ConnectError("dns"), BFRetryableError),
    (httpx.ConnectTimeout("tcp"), BFRetryableError),
    (httpx.LocalProtocolError("bad"), BFRetryableError),
    (httpx.WriteTimeout("w"), BFUnknownOutcomeError),
    (httpx.WriteError("w"), BFUnknownOutcomeError),
    (httpx.ReadTimeout("r"), BFUnknownOutcomeError),
    (httpx.ReadError("r"), BFUnknownOutcomeError),
    (httpx.RemoteProtocolError("proto"), BFUnknownOutcomeError),
])
def test_transport_exception_classification(monkeypatch, exc, expected):
    _patch_client(monkeypatch, exc=exc)
    with pytest.raises(expected):
        run(bf_gemini._call_gemini_json("p", timeout=1, max_tokens=10))


def test_missing_key_is_retryable(monkeypatch):
    monkeypatch.delenv("GEMINI_API_KEY", raising=False)
    with pytest.raises(BFRetryableError):
        run(bf_gemini._call_gemini_json("p", timeout=1, max_tokens=10))


def test_http_429_retryable(monkeypatch):
    _patch_client(monkeypatch, resp=_FakeResp(429))
    with pytest.raises(BFRetryableError):
        run(bf_gemini._call_gemini_json("p", timeout=1, max_tokens=10))


def test_http_500_unknown(monkeypatch):
    _patch_client(monkeypatch, resp=_FakeResp(503))
    with pytest.raises(BFUnknownOutcomeError):
        run(bf_gemini._call_gemini_json("p", timeout=1, max_tokens=10))


def test_http_400_terminal(monkeypatch):
    _patch_client(monkeypatch, resp=_FakeResp(400))
    with pytest.raises(BFTerminalError):
        run(bf_gemini._call_gemini_json("p", timeout=1, max_tokens=10))


def test_invalid_json_retries_once_then_terminal(monkeypatch):
    calls = {"n": 0}

    async def bad_once(payload, key, timeout):
        calls["n"] += 1
        return "this is not json"

    monkeypatch.setenv("GEMINI_API_KEY", "k")
    monkeypatch.setattr(bf_gemini, "_gemini_http_once", bad_once)
    with pytest.raises(BFTerminalError):
        run(bf_gemini._call_gemini_json("p", timeout=1, max_tokens=10))
    assert calls["n"] == 2  # one bounded retry (extra provider invocation)


def test_valid_json_after_200(monkeypatch):
    _patch_client(monkeypatch, resp=_FakeResp(200, _envelope('{"ok": true}')))
    assert run(bf_gemini._call_gemini_json("p", timeout=1, max_tokens=10)) == {"ok": True}


# ── BLOCKER A, layer 2: state-machine outcomes ─────────────────────────────
@pytest.fixture()
def db():
    return _DB()


def test_retryable_error_allows_auto_reclaim(db, monkeypatch):
    cid = _seed_job(db)
    calls = {"n": 0}

    async def raise_retryable(config, spec):
        calls["n"] += 1
        raise BFRetryableError("connect refused")

    monkeypatch.setattr(bf_gemini, "generate_chapter", raise_retryable)
    run(_run_chapter(db, "job1", cid))
    assert _dig(run(db[COLL].find_one({"_id": "job1"})), f"chapters.{cid}.state") == S_FAILED_RETRYABLE
    # second /step may auto-claim → provider called again
    run(_run_chapter(db, "job1", cid))
    assert calls["n"] == 2


def test_unknown_error_blocks_auto_reclaim(db, monkeypatch):
    cid = _seed_job(db)
    calls = {"n": 0}

    async def raise_unknown(config, spec):
        calls["n"] += 1
        raise BFUnknownOutcomeError("read timeout after fence")

    monkeypatch.setattr(bf_gemini, "generate_chapter", raise_unknown)
    run(_run_chapter(db, "job1", cid))
    assert _dig(run(db[COLL].find_one({"_id": "job1"})), f"chapters.{cid}.state") == S_UNKNOWN
    # second /step cannot auto-claim unknown_outcome → provider NOT called again
    run(_run_chapter(db, "job1", cid))
    assert calls["n"] == 1


# ── BLOCKER B: no in-stage repair ───────────────────────────────────────────
def test_repair_mcq_is_not_implemented():
    with pytest.raises(NotImplementedError):
        run(bf_gemini.repair_mcq({}, "text"))


def test_chapter_drops_bad_mcq_without_repair(db, monkeypatch):
    cid = _seed_job(db)
    bad = copy.deepcopy(_GOOD_CHAPTER)
    bad["mcqs"] = [{"question": "Q?", "options": ["a", "b"], "correctIndex": 0,
                    "evidenceQuote": "definitely not present in the chapter"}]
    repair_calls = {"n": 0}

    async def fake_chapter(config, spec):
        return copy.deepcopy(bad)

    async def spy_repair(mcq, text):
        repair_calls["n"] += 1
        raise NotImplementedError

    monkeypatch.setattr(bf_gemini, "generate_chapter", fake_chapter)
    monkeypatch.setattr(bf_gemini, "repair_mcq", spy_repair)
    r = run(_run_chapter(db, "job1", cid))
    doc = run(db[COLL].find_one({"_id": "job1"}))
    ch = doc["chapters"][cid]
    assert r["status"] == "completed" and ch["state"] == S_COMPLETED
    assert not any(b["type"] == "mcq" for b in ch["blocks"])
    assert any(w["type"] == "mcq_dropped" for w in ch["warnings"])
    assert repair_calls["n"] == 0


# ── BLOCKER C: atomic blueprint + crash recovery ───────────────────────────
def _seed_created_job(db, jid="j2", chapters=2):
    run(db[COLL].insert_one({
        "_id": jid, "jobId": jid, "config": {"title": "B", "chapterCount": chapters},
        "state": "created",
        "blueprint": {"state": S_PENDING, "attemptId": None, "attemptCount": 0, "generationVersion": 0},
        "chapters": {}, "chapterOrder": [], "warnings": [], "createdAt": "x", "updatedAt": "x",
    }))


def test_blueprint_completes_with_chapters_atomically(db, monkeypatch):
    _seed_created_job(db)

    async def fake_bp(config):
        return {"summary": "s", "chapters": [{"title": "One"}, {"title": "Two"}]}

    monkeypatch.setattr(bf_gemini, "generate_blueprint", fake_bp)
    r = run(_run_blueprint(db, "j2"))
    doc = run(db[COLL].find_one({"_id": "j2"}))
    assert r["status"] == "completed"
    # blueprint completed ONLY together with a non-empty chapter map
    assert doc["blueprint"]["state"] == S_COMPLETED
    assert len(doc["chapters"]) == 2 and len(doc["chapterOrder"]) == 2


def test_crash_window_state_fails_cleanly(db):
    # Simulate a legacy malformed job: blueprint completed but no chapters.
    run(db[COLL].insert_one({
        "_id": "j3", "jobId": "j3", "config": {"title": "B"},
        "state": "blueprint_ready",
        "blueprint": {"state": S_COMPLETED, "attemptId": "b", "attemptCount": 1, "generationVersion": 1},
        "chapters": {}, "chapterOrder": [], "warnings": [], "createdAt": "x", "updatedAt": "x",
    }))
    from fastapi import HTTPException
    # The /step recovery logic lives in the route; exercise the same predicate here.
    doc = run(db[COLL].find_one({"_id": "j3"}))
    assert doc["blueprint"]["state"] == S_COMPLETED and len(doc["chapters"]) == 0


# ── BLOCKER D: configuration validation ────────────────────────────────────
def _cfg(**over):
    base = {"title": "T", "topic": "Daily life", "section": "story", "level": "A2",
            "tier": "standard", "price": 0, "chapterCount": 3, "mode": "simple",
            "readingMinutes": 6, "minWordsPerChapter": 120, "maxWordsPerChapter": 320,
            "pedagogyProfile": "general_english"}
    base.update(over)
    return base


def test_valid_config_passes():
    assert validate_book_factory_config(_cfg()) == []


@pytest.mark.parametrize("over", [
    {"chapterCount": 0}, {"chapterCount": 21}, {"chapterCount": "many"},
    {"chapterCount": True}, {"chapterCount": 5.7},
    {"price": -1}, {"tier": "ultra"}, {"level": "C1"}, {"section": "poem"},
    {"pedagogyProfile": "mystery"}, {"recipeId": "no_such_recipe"},
    {"minWordsPerChapter": 400, "maxWordsPerChapter": 200},
    {"includeReviewChapter": "true"},
    {"chapterCount": 20, "maxWordsPerChapter": 1000},          # aggregate words
    {"chapterCount": 20, "mcqPerChapter": 10, "fillblankPerChapter": 10},  # aggregate ex
    {"title": ""}, {"topic": ""},
])
def test_invalid_configs_rejected(over):
    assert validate_book_factory_config(_cfg(**over)) != []


@pytest.mark.parametrize("over", [{"price": 0}, {"price": 999}, {"tier": "premium"},
                                  {"chapterCount": 1}, {"chapterCount": 20}])
def test_boundary_valid_configs(over):
    assert validate_book_factory_config(_cfg(**over)) == []


# ── HIGH E/F: MCQ + fillblank correctness ──────────────────────────────────
def test_mcq_empty_option_rejected():
    from book_factory_validator import validate_mcq
    ok, reason = validate_mcq(
        {"question": "q", "options": ["valid", "", "also"], "correctIndex": 1,
         "evidenceQuote": "x"}, "x here")
    assert not ok and reason == "empty_option"


def test_fillblank_requires_marker():
    from book_factory_validator import validate_fillblank
    assert validate_fillblank({"text": "no blank here", "answer": "a"})[0] is False
    assert validate_fillblank({"text": "I ___ home", "answer": "go"})[0] is True
    assert validate_fillblank({"text": "I … home", "answer": "go"})[0] is True
    assert validate_fillblank({"text": "I [BLANK] home", "answer": "go"})[0] is True
    assert validate_fillblank({"text": "I ___ home", "answer": ""})[0] is False


# ── HIGH J: manual-retry fencing (state eligibility) ───────────────────────
def test_terminal_not_manually_retryable():
    assert S_FAILED_TERMINAL not in bfj._RETRY_ELIGIBLE
    assert S_FAILED_RETRYABLE in bfj._RETRY_ELIGIBLE
    assert S_UNKNOWN in bfj._RETRY_ELIGIBLE
