"""tests/test_book_factory_phase1_complete.py
=============================================
Phase 1 completion coverage for the NEW blockers/highs that the prior package
left open:

  * BLOCKER 1 — frontend defaultConfig shape accepted; pedagogy ID agreement.
  * BLOCKER 2 — BFTerminalError → failed_terminal at ORCHESTRATION level; a
    terminal / unknown stage never triggers a further provider call.
  * BLOCKER 3 — persisted providerCallCount / jsonRetryUsed; at most TWO
    provider calls for a generation version (never 3-6).
  * BLOCKER 4 — bounded blueprint chapter output (count/shape) before persist.
  * HIGH 5   — bool-as-int rejection + aggregate bounds.
  * HIGH 7   — concurrent claim/retry, stale attempt/genver, cancellation,
    lock enforcement, genver increments exactly once.
  * HIGH 8   — real, persisted, idempotent blueprint approval.
  * HIGH 9   — admin-scoped recent-jobs listing + resumption retrieval.
  * HIGH 10  — lock / unlock / regenerate / focused instruction / cancel.
  * HIGH 14  — tier/pedagogy materially reach the prompt.

Executes production code (no reimplementation). No network / no real Gemini.
"""
from __future__ import annotations

import asyncio
import copy

import pytest
from fastapi import APIRouter, FastAPI, HTTPException
from fastapi.testclient import TestClient

import book_factory_gemini as bf_gemini
import book_factory_jobs as bfj
from book_factory_gemini import BFTerminalError, BFUnknownOutcomeError, BFRetryableError
from book_factory_jobs import (
    S_PENDING, S_CLAIMED, S_COMPLETED, S_FAILED_RETRYABLE, S_FAILED_TERMINAL,
    S_UNKNOWN, COLL, _run_chapter, _run_blueprint, _claim_stage,
    validate_book_factory_config, validate_blueprint_chapters,
)
from tests.test_book_factory_jobs import _DB, run, _dig, _seed_job, _GOOD_CHAPTER


# ── frontend defaultConfig shape (mirrors bookFactorySchema.defaultConfig, with
#     required title/topic filled as the UI would before submit) ──────────────
FRONTEND_DEFAULT_CONFIG = {
    "mode": "smart",
    "recipeId": "",
    "title": "My English Adventures",
    "subtitle": "",
    "author": "Classroom Library",
    "topic": "Daily life in a Cambodian town",
    "section": "story",
    "level": "A2",
    "tier": "free",
    "price": 0,
    "readingMinutes": 6,
    "chapterCount": 5,
    "includeReviewChapter": False,
    "minWordsPerChapter": 120,
    "maxWordsPerChapter": 320,
    "paragraphGuidance": "balanced",
    "dialogueTurnsPerChapter": 4,
    "vocabularyPerChapter": 6,
    "mcqPerChapter": 3,
    "fillblankPerChapter": 2,
    "speakingPerChapter": 1,
    "pronunciationDepth": "standard",
    "pedagogyProfile": "general_english",
    "coverEmoji": "\U0001F4D6",
    "coverGradient": "linear-gradient(155deg, #2a2140 0%, #4a3a6a 100%)",
    "accent": "#D4A843",
}


# ── route harness ────────────────────────────────────────────────────────────
async def _admin_dep():
    return {"email": "admin-a@test"}


async def _admin_b_dep():
    return {"email": "admin-b@test"}


def _make_client(db, admin=_admin_dep):
    app = FastAPI()
    api = APIRouter(prefix="/api")
    bfj.register_book_factory_routes(api, db, admin)
    app.include_router(api)
    return TestClient(app)


def _enable_all(monkeypatch):
    monkeypatch.setenv("BOOK_FACTORY_VISIBLE", "true")
    monkeypatch.setenv("BOOK_FACTORY_ENABLED", "true")
    monkeypatch.setenv("BOOK_FACTORY_GEMINI_ENABLED", "true")
    monkeypatch.setenv("GEMINI_API_KEY", "test-key")


@pytest.fixture()
def db():
    return _DB()


# ══════════════════════════════ BLOCKER 1 ════════════════════════════════════
def test_frontend_default_config_shape_accepted():
    # The actual frontend default shape must NOT produce validation errors.
    assert validate_book_factory_config(dict(FRONTEND_DEFAULT_CONFIG)) == []


def test_default_config_creates_job_via_route(monkeypatch, db):
    _enable_all(monkeypatch)
    client = _make_client(db)
    r = client.post("/api/studio/book-factory/jobs", json={"config": dict(FRONTEND_DEFAULT_CONFIG)})
    assert r.status_code == 200
    assert r.json()["job"]["config"]["pedagogyProfile"] == "general_english"


@pytest.mark.parametrize("profile", sorted(bfj.KNOWN_PEDAGOGY_PROFILES))
def test_all_known_pedagogy_profiles_accepted(profile):
    cfg = dict(FRONTEND_DEFAULT_CONFIG, pedagogyProfile=profile)
    assert validate_book_factory_config(cfg) == []


def test_required_profiles_present_and_agree_with_gemini():
    required = {
        "general_english", "daravuth_speaking_performance", "pronunciation_focus",
        "workplace_communication", "storytelling_performance", "speaking_confidence",
    }
    assert required <= bfj.KNOWN_PEDAGOGY_PROFILES
    # Backend prompt-description mapping covers exactly the same IDs.
    assert set(bf_gemini.PEDAGOGY_PROFILES) == bfj.KNOWN_PEDAGOGY_PROFILES


def test_unknown_pedagogy_profile_rejected():
    assert validate_book_factory_config(dict(FRONTEND_DEFAULT_CONFIG, pedagogyProfile="cambodia-esl-v1")) != []


# ══════════════════════════════ BLOCKER 2 ════════════════════════════════════
def test_terminal_error_becomes_failed_terminal_orchestration(db, monkeypatch):
    cid = _seed_job(db)
    calls = {"n": 0}

    async def boom(config, spec):
        calls["n"] += 1
        raise BFTerminalError("HTTP 400 non-retryable")

    monkeypatch.setattr(bf_gemini, "generate_chapter", boom)
    run(_run_chapter(db, "job1", cid))
    assert _dig(run(db[COLL].find_one({"_id": "job1"})), f"chapters.{cid}.state") == S_FAILED_TERMINAL
    # A second /step must NOT auto-claim a terminal stage → provider count unchanged.
    run(_run_chapter(db, "job1", cid))
    assert calls["n"] == 1


def test_terminal_blueprint_becomes_failed_terminal(db, monkeypatch):
    run(db[COLL].insert_one({
        "_id": "jb", "jobId": "jb", "config": {"title": "B", "chapterCount": 1},
        "state": "created",
        "blueprint": {"state": S_PENDING, "attemptId": None, "attemptCount": 0, "generationVersion": 0},
        "chapters": {}, "chapterOrder": [], "warnings": [], "createdAt": "x", "updatedAt": "x",
    }))
    calls = {"n": 0}

    async def boom(config):
        calls["n"] += 1
        raise BFTerminalError("HTTP 400")

    monkeypatch.setattr(bf_gemini, "generate_blueprint", boom)
    run(_run_blueprint(db, "jb"))
    assert _dig(run(db[COLL].find_one({"_id": "jb"})), "blueprint.state") == S_FAILED_TERMINAL
    run(_run_blueprint(db, "jb"))
    assert calls["n"] == 1  # terminal blueprint never auto-retries


# ══════════════════════════════ BLOCKER 3 ════════════════════════════════════
def test_persisted_provider_call_count_success(db, monkeypatch):
    cid = _seed_job(db)

    async def ok(config, spec, *, budget=None):
        if budget is not None:
            budget["providerCallCount"] = 1
        return copy.deepcopy(_GOOD_CHAPTER)

    monkeypatch.setattr(bf_gemini, "generate_chapter", ok)
    run(_run_chapter(db, "job1", cid))
    ch = _dig(run(db[COLL].find_one({"_id": "job1"})), f"chapters.{cid}")
    assert ch["providerCallCount"] == 1 and ch["jsonRetryUsed"] is False


def test_invalid_json_max_two_calls_then_terminal_and_persisted(db, monkeypatch):
    # Drive the REAL adapter through the orchestration with a fake transport
    # that always returns non-JSON: exactly 2 HTTP calls, then failed_terminal.
    _seed_job  # noqa
    run(db[COLL].insert_one({
        "_id": "jj", "jobId": "jj", "config": {"title": "B", "chapterCount": 1,
                                               "pedagogyProfile": "general_english"},
        "state": "created",
        "blueprint": {"state": S_PENDING, "attemptId": None, "attemptCount": 0, "generationVersion": 0},
        "chapters": {}, "chapterOrder": [], "warnings": [], "createdAt": "x", "updatedAt": "x",
    }))
    http_calls = {"n": 0}

    async def bad_http(payload, key, timeout):
        http_calls["n"] += 1
        return "not json at all"

    monkeypatch.setenv("GEMINI_API_KEY", "k")
    monkeypatch.setattr(bf_gemini, "_gemini_http_once", bad_http)
    run(_run_blueprint(db, "jj"))
    bp = _dig(run(db[COLL].find_one({"_id": "jj"})), "blueprint")
    assert http_calls["n"] == 2                 # never 3-6
    assert bp["state"] == S_FAILED_TERMINAL      # BLOCKER 2 keeps it terminal
    assert bp["providerCallCount"] == 2 and bp["jsonRetryUsed"] is True

    # A later automatic /step must NOT start a fresh invalid-JSON cycle.
    run(_run_blueprint(db, "jj"))
    assert http_calls["n"] == 2


# ══════════════════════════════ BLOCKER 4 ════════════════════════════════════
def _seed_created(db, jid, chapter_count, review=False):
    run(db[COLL].insert_one({
        "_id": jid, "jobId": jid,
        "config": {"title": "B", "chapterCount": chapter_count, "includeReviewChapter": review,
                   "pedagogyProfile": "general_english"},
        "state": "created",
        "blueprint": {"state": S_PENDING, "attemptId": None, "attemptCount": 0, "generationVersion": 0},
        "chapters": {}, "chapterOrder": [], "warnings": [], "createdAt": "x", "updatedAt": "x",
    }))


def _bp_returning(n):
    async def fake_bp(config):
        return {"summary": "s", "chapters": [{"title": f"C{i}", "outline": "o"} for i in range(n)]}
    return fake_bp


@pytest.mark.parametrize("configured,returned,review,expect_ok", [
    (1, 1000, False, False),   # unbounded generation attempt → rejected
    (4, 3, False, False),      # too few
    (4, 5, False, False),      # too many
    (4, 4, False, True),       # exact
    (4, 5, True, True),        # 4 + review = 5 accepted
    (1, 1, False, True),
])
def test_blueprint_chapter_count_bounds(db, monkeypatch, configured, returned, review, expect_ok):
    _seed_created(db, "jc", configured, review)
    monkeypatch.setattr(bf_gemini, "generate_blueprint", _bp_returning(returned))
    run(_run_blueprint(db, "jc"))
    doc = run(db[COLL].find_one({"_id": "jc"}))
    if expect_ok:
        assert doc["blueprint"]["state"] == S_COMPLETED
        assert len(doc["chapterOrder"]) == returned
        assert len(doc["chapters"]) <= bfj.MAX_TOTAL_CHAPTERS
    else:
        # No partial/oversized chapter map is ever persisted.
        assert doc["chapters"] == {} and doc["chapterOrder"] == []
        assert doc["blueprint"]["state"] in (S_FAILED_RETRYABLE, S_FAILED_TERMINAL)


def test_requested_total_over_max_rejected_at_creation(monkeypatch, db):
    _enable_all(monkeypatch)
    client = _make_client(db)
    r = client.post("/api/studio/book-factory/jobs",
                    json={"config": dict(FRONTEND_DEFAULT_CONFIG, chapterCount=20, includeReviewChapter=True)})
    assert r.status_code == 422


def test_duplicate_chapter_shapes_rejected():
    ok, _ = validate_blueprint_chapters([{"title": "A"}, {"title": ""}], 2)
    assert ok is False
    ok, _ = validate_blueprint_chapters([{"title": "A"}, {"not_title": "x"}], 2)
    assert ok is False


# ══════════════════════════════ HIGH 5 ═══════════════════════════════════════
@pytest.mark.parametrize("field", ["chapterCount", "readingMinutes", "mcqPerChapter",
                                    "minWordsPerChapter", "vocabularyPerChapter"])
def test_bool_rejected_as_integer(field):
    cfg = dict(FRONTEND_DEFAULT_CONFIG)
    cfg[field] = True
    assert validate_book_factory_config(cfg) != []


def test_string_int_rejected():
    assert validate_book_factory_config(dict(FRONTEND_DEFAULT_CONFIG, chapterCount="5")) != []


def test_aggregate_exercise_bound_includes_vocab_and_speaking():
    cfg = dict(FRONTEND_DEFAULT_CONFIG, chapterCount=20, includeReviewChapter=False,
               vocabularyPerChapter=15, mcqPerChapter=0, fillblankPerChapter=0, speakingPerChapter=0,
               minWordsPerChapter=50, maxWordsPerChapter=100)
    # 20 * 15 = 300 → at the documented boundary (<=300 ok)
    assert validate_book_factory_config(cfg) == []
    cfg2 = dict(cfg, vocabularyPerChapter=20)  # 20 * 20 = 400 > 300
    assert validate_book_factory_config(cfg2) != []
    # speaking still counts toward the aggregate: 20 * (10 + 10) = 400 > 300
    cfg3 = dict(cfg, vocabularyPerChapter=10, speakingPerChapter=10)
    assert validate_book_factory_config(cfg3) != []


# ══════════════════════════════ HIGH 7 ═══════════════════════════════════════
def test_concurrent_claims_only_one_wins(db):
    cid = _seed_job(db)
    path = f"chapters.{cid}"

    async def both():
        return await asyncio.gather(_claim_stage(db, "job1", path), _claim_stage(db, "job1", path))

    (c1, _), (c2, _) = run(both())
    winners = [c for c in (c1, c2) if c is not None]
    assert len(winners) == 1


def test_concurrent_retry_only_one_succeeds(monkeypatch, db):
    _enable_all(monkeypatch)
    cid = _seed_job(db, chapter_state=S_FAILED_RETRYABLE, attempt_count=1)
    client = _make_client(db)
    r1 = client.post(f"/api/studio/book-factory/jobs/job1/chapters/{cid}/retry")
    r2 = client.post(f"/api/studio/book-factory/jobs/job1/chapters/{cid}/retry")
    codes = sorted([r1.status_code, r2.status_code])
    assert codes == [200, 409]  # exactly one retry wins; the other is ineligible


def test_locked_chapter_cannot_be_claimed(db):
    cid = _seed_job(db)
    run(db[COLL].update_one({"_id": "job1"}, {"$set": {f"chapters.{cid}.locked": True}}))
    won, _ = run(_claim_stage(db, "job1", f"chapters.{cid}"))
    assert won is None


def test_cancelled_job_blocks_claim_and_late_completion(db, monkeypatch):
    cid = _seed_job(db)
    run(db[COLL].update_one({"_id": "job1"}, {"$set": {"state": "cancelled"}}))
    calls = {"n": 0}

    async def fake_chapter(config, spec):
        calls["n"] += 1
        return copy.deepcopy(_GOOD_CHAPTER)

    monkeypatch.setattr(bf_gemini, "generate_chapter", fake_chapter)
    r = run(_run_chapter(db, "job1", cid))
    assert r["status"] == "skipped" and calls["n"] == 0
    assert _dig(run(db[COLL].find_one({"_id": "job1"})), f"chapters.{cid}.state") == S_PENDING


def test_genver_increments_exactly_once_per_retry(monkeypatch, db):
    _enable_all(monkeypatch)
    cid = _seed_job(db, chapter_state=S_FAILED_RETRYABLE, attempt_count=1)
    before = _dig(run(db[COLL].find_one({"_id": "job1"})), f"chapters.{cid}.generationVersion")
    client = _make_client(db)
    assert client.post(f"/api/studio/book-factory/jobs/job1/chapters/{cid}/retry").status_code == 200

    async def ok(config, spec):
        return copy.deepcopy(_GOOD_CHAPTER)

    monkeypatch.setattr(bf_gemini, "generate_chapter", ok)
    run(_run_chapter(db, "job1", cid))
    after = _dig(run(db[COLL].find_one({"_id": "job1"})), f"chapters.{cid}.generationVersion")
    assert after == before + 1  # retry does NOT $inc; the single claim does, exactly once


# ══════════════════════════════ HIGH 8 ═══════════════════════════════════════
def _create_and_blueprint(client, monkeypatch, chapters=1):
    async def fake_bp(config):
        return {"summary": "s", "chapters": [{"title": f"C{i}", "outline": "o"} for i in range(chapters)]}
    monkeypatch.setattr(bf_gemini, "generate_blueprint", fake_bp)
    monkeypatch.setattr(bf_gemini, "generate_chapter", lambda c, s: copy.deepcopy(_GOOD_CHAPTER))
    r = client.post("/api/studio/book-factory/jobs", json={"config": dict(FRONTEND_DEFAULT_CONFIG, chapterCount=chapters)})
    jid = r.json()["job"]["jobId"]
    client.post(f"/api/studio/book-factory/jobs/{jid}/step", json={"stage": "blueprint"})
    return jid


def test_blueprint_stops_for_review_and_chapter_blocked(monkeypatch, db):
    _enable_all(monkeypatch)
    client = _make_client(db)
    jid = _create_and_blueprint(client, monkeypatch)
    doc = run(db[COLL].find_one({"_id": jid}))
    assert doc["state"] == "blueprint_ready" and doc["blueprintApprovedAt"] is None
    cid = doc["chapterOrder"][0]
    blocked = client.post(f"/api/studio/book-factory/jobs/{jid}/step", json={"chapterId": cid})
    assert blocked.status_code == 409 and blocked.json()["detail"] == "blueprint_not_approved"


def test_approval_is_persisted_and_idempotent(monkeypatch, db):
    _enable_all(monkeypatch)
    client = _make_client(db)
    jid = _create_and_blueprint(client, monkeypatch)
    a1 = client.post(f"/api/studio/book-factory/jobs/{jid}/approve")
    a2 = client.post(f"/api/studio/book-factory/jobs/{jid}/approve")
    assert a1.status_code == 200 and a2.status_code == 200
    assert a1.json()["job"]["blueprintApprovedAt"] == a2.json()["job"]["blueprintApprovedAt"]


# ══════════════════════════════ HIGH 9 ═══════════════════════════════════════
def test_recent_jobs_ownership_isolation(monkeypatch):
    _enable_all(monkeypatch)
    shared = _DB()
    client_a = _make_client(shared, _admin_dep)      # admin-a@test
    client_b = _make_client(shared, _admin_b_dep)    # admin-b@test
    ja = client_a.post("/api/studio/book-factory/jobs", json={"config": dict(FRONTEND_DEFAULT_CONFIG)}).json()["job"]["jobId"]
    client_b.post("/api/studio/book-factory/jobs", json={"config": dict(FRONTEND_DEFAULT_CONFIG)})
    listing_a = client_a.get("/api/studio/book-factory/jobs").json()["jobs"]
    ids_a = {j["jobId"] for j in listing_a}
    assert ja in ids_a
    # admin-b must never see admin-a's job
    listing_b = client_b.get("/api/studio/book-factory/jobs").json()["jobs"]
    assert ja not in {j["jobId"] for j in listing_b}


def test_job_resumption_retrieval(monkeypatch, db):
    _enable_all(monkeypatch)
    client = _make_client(db)
    jid = client.post("/api/studio/book-factory/jobs", json={"config": dict(FRONTEND_DEFAULT_CONFIG)}).json()["job"]["jobId"]
    got = client.get(f"/api/studio/book-factory/jobs/{jid}")
    assert got.status_code == 200 and got.json()["job"]["jobId"] == jid


# ══════════════════════════════ HIGH 10 ══════════════════════════════════════
def test_lock_unlock_and_locked_blocks_regenerate(monkeypatch, db):
    _enable_all(monkeypatch)
    cid = _seed_job(db, chapter_state=S_COMPLETED, attempt_count=1)
    client = _make_client(db)
    assert client.post(f"/api/studio/book-factory/jobs/job1/chapters/{cid}/lock").status_code == 200
    assert _dig(run(db[COLL].find_one({"_id": "job1"})), f"chapters.{cid}.locked") is True
    # locked completed chapter cannot be regenerated
    assert client.post(f"/api/studio/book-factory/jobs/job1/chapters/{cid}/regenerate").status_code == 409
    assert client.post(f"/api/studio/book-factory/jobs/job1/chapters/{cid}/unlock").status_code == 200
    assert _dig(run(db[COLL].find_one({"_id": "job1"})), f"chapters.{cid}.locked") is False


def test_regenerate_resets_completed_chapter_with_focus(monkeypatch, db):
    _enable_all(monkeypatch)
    cid = _seed_job(db, chapter_state=S_COMPLETED, attempt_count=1)
    run(db[COLL].update_one({"_id": "job1"}, {"$set": {f"chapters.{cid}.blocks": [{"type": "paragraph", "text": "OLD"}]}}))
    client = _make_client(db)
    r = client.post(f"/api/studio/book-factory/jobs/job1/chapters/{cid}/regenerate",
                    json={"focusedInstruction": "more dialogue"})
    assert r.status_code == 200
    ch = _dig(run(db[COLL].find_one({"_id": "job1"})), f"chapters.{cid}")
    assert ch["state"] == S_PENDING and ch["blocks"] == [] and ch["focusedInstruction"] == "more dialogue"
    assert ch["position"] == 0 and ch["chapterId"] == cid  # preserved


def test_regenerate_rejects_non_completed(monkeypatch, db):
    _enable_all(monkeypatch)
    cid = _seed_job(db, chapter_state=S_PENDING)
    client = _make_client(db)
    assert client.post(f"/api/studio/book-factory/jobs/job1/chapters/{cid}/regenerate").status_code == 409


def test_cancel_is_idempotent_and_blocks_step(monkeypatch, db):
    _enable_all(monkeypatch)
    cid = _seed_job(db)
    client = _make_client(db)
    assert client.post("/api/studio/book-factory/jobs/job1/cancel").status_code == 200
    assert client.post("/api/studio/book-factory/jobs/job1/cancel").status_code == 200  # idempotent
    step = client.post("/api/studio/book-factory/jobs/job1/step", json={"chapterId": cid})
    assert step.status_code == 409


# ══════════════════════════════ HIGH 14 ══════════════════════════════════════
def test_pedagogy_and_targets_reach_chapter_prompt():
    cfg = dict(FRONTEND_DEFAULT_CONFIG, pedagogyProfile="daravuth_speaking_performance",
               mcqPerChapter=3, minWordsPerChapter=150, maxWordsPerChapter=300)
    prompt = bf_gemini._chapter_prompt(cfg, {"title": "Ch", "outline": "o", "objective": "obj"})
    assert "IPA" in prompt or "pronunciation" in prompt.lower()
    assert "150" in prompt and "300" in prompt
    assert "Multiple-choice questions: 3" in prompt


def test_focused_instruction_reaches_prompt():
    prompt = bf_gemini._chapter_prompt(dict(FRONTEND_DEFAULT_CONFIG),
                                       {"title": "Ch", "focusedInstruction": "add more workplace vocab"})
    assert "add more workplace vocab" in prompt


def test_blueprint_prompt_includes_review_and_pedagogy():
    prompt = bf_gemini._blueprint_prompt(dict(FRONTEND_DEFAULT_CONFIG, includeReviewChapter=True,
                                              pedagogyProfile="workplace_communication"))
    assert "review chapter" in prompt.lower() and "workplace" in prompt.lower()


def test_unknown_profile_never_injected_raw():
    # pedagogy_description falls back to general_english for an unknown ID.
    desc = bf_gemini.pedagogy_description("totally-unknown")
    assert desc == bf_gemini.PEDAGOGY_PROFILES["general_english"]


# ══════════════════════════════ export integrity ═════════════════════════════
def test_export_strips_metadata_forces_unpublished_preserves_tier_price(monkeypatch, db):
    _enable_all(monkeypatch)
    client = _make_client(db)
    jid = _create_and_blueprint(client, monkeypatch)

    async def ok(config, spec):
        return copy.deepcopy(_GOOD_CHAPTER)

    monkeypatch.setattr(bf_gemini, "generate_chapter", ok)
    client.post(f"/api/studio/book-factory/jobs/{jid}/approve")
    doc = run(db[COLL].find_one({"_id": jid}))
    cid = doc["chapterOrder"][0]
    # set a distinctive tier/price on the stored config
    run(db[COLL].update_one({"_id": jid}, {"$set": {"config.tier": "premium", "config.price": 321}}))
    client.post(f"/api/studio/book-factory/jobs/{jid}/step", json={"chapterId": cid})
    book = client.get(f"/api/studio/book-factory/jobs/{jid}/export").json()["book"]
    assert book["published"] is False
    assert book["tier"] == "premium" and book["price"] == 321
    blob = repr(book)
    for leak in ("chapterId", "evidenceQuote", "generationVersion", "attemptId",
                 "providerCallCount", "state", "locked", "jsonRetryUsed"):
        assert leak not in blob
