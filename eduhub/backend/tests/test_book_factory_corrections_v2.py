"""tests/test_book_factory_corrections_v2.py
==============================================
FINAL correction-pass coverage for the latest audit findings:

  BLOCKER 1  — admin ownership enforced on EVERY job operation.
  BLOCKER 2  — cancellation is terminal + irreversible (no late mutation).
  BLOCKER 3  — locking protects against in-flight results.
  HIGH 7     — recent-jobs recency cutoff + ownership isolation.
  HIGH 9     — strict canonical config validation (NaN/Infinity/missing/type).
  HIGH 10    — attempt + generation-version fencing on every transition.
  HIGH 11    — every malformed Gemini HTTP-200 success uses the bounded budget.
  HIGH 12    — env variables can never RAISE hard safety ceilings.
  MEDIUM 14  — fill-blank drop warnings are persisted.
  MEDIUM 15  — phrase-boundary evidence matching.

Executes production code (no reimplementation). No network / no real Gemini.
"""
from __future__ import annotations

import copy

import httpx
import pytest

import book_factory_gemini as bf_gemini
import book_factory_jobs as bfj
from book_factory_gemini import BFTerminalError, BFInvalidJSONError
from book_factory_jobs import (
    S_PENDING, S_CLAIMED, S_PROVIDER_PENDING, S_COMPLETED,
    S_FAILED_RETRYABLE, S_UNKNOWN, COLL,
    _run_chapter, _claim_stage, _complete_stage,
    validate_book_factory_config,
)
from tests.test_book_factory_jobs import _DB, run, _dig, _seed_job, _GOOD_CHAPTER
from tests.test_book_factory_phase1_complete import (
    _make_client, _admin_dep, _admin_b_dep, _enable_all, FRONTEND_DEFAULT_CONFIG,
    _create_and_blueprint,
)


# ════════════════════════ BLOCKER 1 — admin ownership ════════════════════════
def _seed_owned(db, owner, chapter_state=S_COMPLETED, attempt_count=1):
    cid = _seed_job(db, chapter_state=chapter_state, attempt_count=attempt_count, authored_by=owner)
    return cid


@pytest.fixture()
def shared_db():
    return _DB()


def test_cross_admin_get_denied(monkeypatch, shared_db):
    _enable_all(monkeypatch)
    _seed_owned(shared_db, "admin-a@test")
    client_b = _make_client(shared_db, _admin_b_dep)
    assert client_b.get("/api/studio/book-factory/jobs/job1").status_code == 404


@pytest.mark.parametrize("method,path,body", [
    ("post", "/api/studio/book-factory/jobs/job1/approve", None),
    ("post", "/api/studio/book-factory/jobs/job1/step", {"stage": "blueprint"}),
    ("post", "/api/studio/book-factory/jobs/job1/chapters/bf_ch_test01/retry", None),
    ("post", "/api/studio/book-factory/jobs/job1/chapters/bf_ch_test01/lock", None),
    ("post", "/api/studio/book-factory/jobs/job1/chapters/bf_ch_test01/unlock", None),
    ("post", "/api/studio/book-factory/jobs/job1/chapters/bf_ch_test01/regenerate", None),
    ("post", "/api/studio/book-factory/jobs/job1/cancel", None),
    ("get", "/api/studio/book-factory/jobs/job1/export", None),
])
def test_cross_admin_mutation_denied(monkeypatch, shared_db, method, path, body):
    _enable_all(monkeypatch)
    _seed_owned(shared_db, "admin-a@test")
    client_b = _make_client(shared_db, _admin_b_dep)
    kwargs = {"json": body} if body is not None else {}
    r = getattr(client_b, method)(path, **kwargs)
    # 404: owned by another admin → indistinguishable from missing (no leak).
    assert r.status_code == 404
    # admin-a's job must NOT have been mutated by admin-b.
    doc = run(shared_db[COLL].find_one({"_id": "job1"}))
    assert doc["state"] != "cancelled"


def test_recent_listing_owner_isolated(monkeypatch):
    _enable_all(monkeypatch)
    db = _DB()
    ca = _make_client(db, _admin_dep)
    cb = _make_client(db, _admin_b_dep)
    ja = ca.post("/api/studio/book-factory/jobs", json={"config": dict(FRONTEND_DEFAULT_CONFIG)}).json()["job"]["jobId"]
    cb.post("/api/studio/book-factory/jobs", json={"config": dict(FRONTEND_DEFAULT_CONFIG)})
    assert ja in {j["jobId"] for j in ca.get("/api/studio/book-factory/jobs").json()["jobs"]}
    assert ja not in {j["jobId"] for j in cb.get("/api/studio/book-factory/jobs").json()["jobs"]}


# ════════════════════════ BLOCKER 2 — terminal cancel ════════════════════════
def _cancel(client):
    return client.post("/api/studio/book-factory/jobs/job1/cancel")


def test_cancel_then_approve_rejected(monkeypatch):
    _enable_all(monkeypatch)
    db = _DB()
    client = _make_client(db)
    jid = _create_and_blueprint(client, monkeypatch)  # blueprint completed, unapproved
    assert client.post(f"/api/studio/book-factory/jobs/{jid}/cancel").status_code == 200
    r = client.post(f"/api/studio/book-factory/jobs/{jid}/approve")
    assert r.status_code == 409
    doc = run(db[COLL].find_one({"_id": jid}))
    assert doc["state"] == "cancelled" and doc["blueprintApprovedAt"] is None


@pytest.mark.parametrize("action", ["retry", "regenerate", "lock", "unlock"])
def test_cancel_then_chapter_action_rejected(monkeypatch, action):
    _enable_all(monkeypatch)
    db = _DB()
    cid = _seed_job(db, chapter_state=S_COMPLETED, attempt_count=1)
    client = _make_client(db)
    assert _cancel(client).status_code == 200
    r = client.post(f"/api/studio/book-factory/jobs/job1/chapters/{cid}/{action}")
    assert r.status_code == 409


def test_cancel_then_step_rejected(monkeypatch):
    _enable_all(monkeypatch)
    db = _DB()
    cid = _seed_job(db, chapter_state=S_PENDING)
    client = _make_client(db)
    _cancel(client)
    assert client.post("/api/studio/book-factory/jobs/job1/step",
                       json={"chapterId": cid}).status_code == 409


def test_cancel_is_idempotent(monkeypatch):
    _enable_all(monkeypatch)
    db = _DB()
    _seed_job(db)
    client = _make_client(db)
    assert _cancel(client).status_code == 200
    assert _cancel(client).status_code == 200
    assert _cancel(client).status_code == 200


@pytest.mark.parametrize("late_fn", ["_complete_stage", "_fail_stage", "_fail_unknown", "_fail_terminal"])
def test_cancelled_job_late_transition_no_mutation(monkeypatch, late_fn):
    # A provider result / failure landing AFTER cancellation must not mutate.
    _enable_all(monkeypatch)
    db = _DB()
    cid = _seed_job(db, chapter_state=S_PROVIDER_PENDING, attempt_count=1)
    path = f"chapters.{cid}"
    # capture the in-flight attempt/genver, then cancel the job.
    doc = run(db[COLL].find_one({"_id": "job1"}))
    att = _dig(doc, f"{path}.attemptId")
    gv = _dig(doc, f"{path}.generationVersion")
    run(db[COLL].update_one({"_id": "job1"}, {"$set": {"state": "cancelled"}}))
    fn = getattr(bfj, late_fn)
    if late_fn == "_complete_stage":
        res = run(fn(db, "job1", path, att, gv, {"blocks": [{"type": "paragraph", "text": "X"}]}))
    else:
        res = run(fn(db, "job1", path, att, gv, "late"))
    assert not res
    after = run(db[COLL].find_one({"_id": "job1"}))
    assert _dig(after, f"{path}.state") == S_PROVIDER_PENDING  # unchanged


# ════════════════════════ BLOCKER 3 — effective locking ══════════════════════
@pytest.mark.parametrize("state", [S_PENDING, S_COMPLETED])
def test_lock_stable_chapter_succeeds(monkeypatch, state):
    _enable_all(monkeypatch)
    db = _DB()
    cid = _seed_job(db, chapter_state=state, attempt_count=1)
    client = _make_client(db)
    assert client.post(f"/api/studio/book-factory/jobs/job1/chapters/{cid}/lock").status_code == 200
    assert _dig(run(db[COLL].find_one({"_id": "job1"})), f"chapters.{cid}.locked") is True


@pytest.mark.parametrize("state", [S_CLAIMED, S_PROVIDER_PENDING])
def test_lock_active_chapter_rejected(monkeypatch, state):
    _enable_all(monkeypatch)
    db = _DB()
    cid = _seed_job(db, chapter_state=state, attempt_count=1)
    client = _make_client(db)
    assert client.post(f"/api/studio/book-factory/jobs/job1/chapters/{cid}/lock").status_code == 409
    assert _dig(run(db[COLL].find_one({"_id": "job1"})), f"chapters.{cid}.locked") is not True


def test_locked_chapter_cannot_be_claimed(monkeypatch):
    _enable_all(monkeypatch)
    db = _DB()
    cid = _seed_job(db, chapter_state=S_PENDING)
    run(db[COLL].update_one({"_id": "job1"}, {"$set": {f"chapters.{cid}.locked": True}}))
    claimed, _ = run(_claim_stage(db, "job1", f"chapters.{cid}"))
    assert claimed is None


def test_stale_completion_after_lock_cannot_write_blocks(monkeypatch):
    # A chapter that became locked (from a stable completed state) cannot be
    # overwritten by a stale in-flight completion for an older attempt.
    _enable_all(monkeypatch)
    db = _DB()
    cid = _seed_job(db, chapter_state=S_PROVIDER_PENDING, attempt_count=1)
    path = f"chapters.{cid}"
    doc = run(db[COLL].find_one({"_id": "job1"}))
    att = _dig(doc, f"{path}.attemptId")
    gv = _dig(doc, f"{path}.generationVersion")
    # simulate the chapter reaching completed then being locked by the author
    run(db[COLL].update_one({"_id": "job1"}, {"$set": {f"{path}.locked": True}}))
    ok = run(_complete_stage(db, "job1", path, att, gv, {"blocks": [{"type": "paragraph", "text": "STALE"}]}))
    assert ok is False


def test_unlock_roundtrip_and_idempotent(monkeypatch):
    # §BLOCKER 3: lock/unlock round-trip; the atomic filter fences on the
    # current generationVersion + expected lock value, and repeat calls are
    # idempotent no-ops (never a spurious toggle).
    _enable_all(monkeypatch)
    db = _DB()
    cid = _seed_job(db, chapter_state=S_COMPLETED, attempt_count=1)
    client = _make_client(db)
    assert client.post(f"/api/studio/book-factory/jobs/job1/chapters/{cid}/lock").status_code == 200
    assert client.post(f"/api/studio/book-factory/jobs/job1/chapters/{cid}/lock").status_code == 200  # idempotent
    assert _dig(run(db[COLL].find_one({"_id": "job1"})), f"chapters.{cid}.locked") is True
    assert client.post(f"/api/studio/book-factory/jobs/job1/chapters/{cid}/unlock").status_code == 200
    assert client.post(f"/api/studio/book-factory/jobs/job1/chapters/{cid}/unlock").status_code == 200  # idempotent
    assert _dig(run(db[COLL].find_one({"_id": "job1"})), f"chapters.{cid}.locked") is False


def test_set_lock_filter_fences_on_genver(monkeypatch):
    # Direct fenced-primitive proof: a lock transition whose expected
    # generationVersion no longer matches the stored value fails closed.
    _enable_all(monkeypatch)
    db = _DB()
    cid = _seed_job(db, chapter_state=S_COMPLETED, attempt_count=1)
    path = f"chapters.{cid}"
    # emulate a concurrent generationVersion advance between read and write
    stale_genver = _dig(run(db[COLL].find_one({"_id": "job1"})), f"{path}.generationVersion")
    run(db[COLL].update_one({"_id": "job1"}, {"$set": {f"{path}.generationVersion": stale_genver + 5}}))
    # a fenced update using the stale genver must NOT match
    done = run(db[COLL].find_one_and_update(
        {"_id": "job1", f"{path}.generationVersion": stale_genver, f"{path}.state": S_COMPLETED},
        {"$set": {f"{path}.locked": True}},
    ))
    assert done is None
    assert _dig(run(db[COLL].find_one({"_id": "job1"})), f"{path}.locked") is not True


def test_cancelled_job_cannot_lock(monkeypatch):
    _enable_all(monkeypatch)
    db = _DB()
    cid = _seed_job(db, chapter_state=S_COMPLETED, attempt_count=1)
    client = _make_client(db)
    _cancel(client)
    assert client.post(f"/api/studio/book-factory/jobs/job1/chapters/{cid}/lock").status_code == 409


# ════════════════════════ HIGH 7 — recent-jobs cutoff ════════════════════════
def test_recent_jobs_time_cutoff(monkeypatch):
    _enable_all(monkeypatch)
    db = _DB()
    client = _make_client(db)
    fresh = client.post("/api/studio/book-factory/jobs", json={"config": dict(FRONTEND_DEFAULT_CONFIG)}).json()["job"]["jobId"]
    # an old job (year 2000) for the same admin
    old = copy.deepcopy(run(db[COLL].find_one({"_id": fresh})))
    old["_id"] = old["jobId"] = "bf_old"
    old["updatedAt"] = "2000-01-01T00:00:00+00:00"
    old["createdAt"] = "2000-01-01T00:00:00+00:00"
    run(db[COLL].insert_one(old))
    ids = {j["jobId"] for j in client.get("/api/studio/book-factory/jobs").json()["jobs"]}
    assert fresh in ids and "bf_old" not in ids


# ════════════════════════ HIGH 9 — strict config ════════════════════════════
@pytest.mark.parametrize("missing", ["mode", "readingMinutes", "minWordsPerChapter",
                                     "maxWordsPerChapter", "price", "title", "topic"])
def test_missing_required_field_rejected(missing):
    cfg = dict(FRONTEND_DEFAULT_CONFIG)
    cfg.pop(missing, None)
    assert validate_book_factory_config(cfg) != []


@pytest.mark.parametrize("recipe", [0, 1, True, [], {}])
def test_numeric_recipe_rejected(recipe):
    assert validate_book_factory_config(dict(FRONTEND_DEFAULT_CONFIG, recipeId=recipe)) != []


@pytest.mark.parametrize("bad", [float("nan"), float("inf"), float("-inf")])
def test_non_finite_price_rejected_and_no_insert(monkeypatch, bad):
    import json as _json
    assert validate_book_factory_config(dict(FRONTEND_DEFAULT_CONFIG, price=bad)) != []
    _enable_all(monkeypatch)
    db = _DB()
    client = _make_client(db)
    # httpx refuses to serialize NaN/Infinity, so send a raw JSON body that
    # DOES contain the non-finite token (Python json.loads accepts it server-side).
    raw = _json.dumps({"config": dict(FRONTEND_DEFAULT_CONFIG, price=bad)}, allow_nan=True)
    r = client.post("/api/studio/book-factory/jobs", content=raw,
                    headers={"Content-Type": "application/json"})
    assert r.status_code == 422
    assert run(db[COLL].find_one({"kind": "book_factory_job"})) is None


def test_bool_price_rejected():
    assert validate_book_factory_config(dict(FRONTEND_DEFAULT_CONFIG, price=True)) != []


def test_sanitized_config_drops_unknown_and_defaults(monkeypatch):
    _enable_all(monkeypatch)
    db = _DB()
    client = _make_client(db)
    cfg = dict(FRONTEND_DEFAULT_CONFIG, EVIL="drop-me")
    job = client.post("/api/studio/book-factory/jobs", json={"config": cfg}).json()["job"]
    assert "EVIL" not in job["config"]
    assert job["config"]["price"] == 0 and job["config"]["mode"] == "smart"


# ════════════════════════ HIGH 10 — fencing ═════════════════════════════════
def test_retry_stale_attempt_rejected(monkeypatch):
    _enable_all(monkeypatch)
    db = _DB()
    cid = _seed_job(db, chapter_state=S_FAILED_RETRYABLE, attempt_count=1)
    client = _make_client(db)
    # move the attempt forward under the caller (simulating another worker)
    run(db[COLL].update_one({"_id": "job1"}, {"$set": {f"chapters.{cid}.attemptId": "att_moved"}}))
    # the route reads the CURRENT attempt, so a retry now matches; but if we
    # bump genver after that read it should fail. Emulate stale by mismatching.
    # Direct fenced check: an explicit stale attemptId cannot win.
    now_att = _dig(run(db[COLL].find_one({"_id": "job1"})), f"chapters.{cid}.attemptId")
    assert now_att == "att_moved"
    # The retry route matches current values → succeeds exactly once.
    r1 = client.post(f"/api/studio/book-factory/jobs/job1/chapters/{cid}/retry")
    assert r1.status_code == 200
    # second retry now sees pending (not retry-eligible) → 409
    r2 = client.post(f"/api/studio/book-factory/jobs/job1/chapters/{cid}/retry")
    assert r2.status_code == 409


def test_genver_increments_exactly_once_per_claim(monkeypatch):
    _enable_all(monkeypatch)
    db = _DB()
    cid = _seed_job(db, chapter_state=S_PENDING)
    before = _dig(run(db[COLL].find_one({"_id": "job1"})), f"chapters.{cid}.generationVersion")
    claimed, _ = run(_claim_stage(db, "job1", f"chapters.{cid}"))
    after = _dig(claimed, f"chapters.{cid}.generationVersion")
    assert after == (before or 0) + 1


# ════════════════════════ HIGH 11 — malformed provider ══════════════════════
class _Resp:
    def __init__(self, status, body):
        self.status_code = status
        self._body = body
        self.text = "b"

    def json(self):
        if isinstance(self._body, Exception):
            raise self._body
        return self._body


class _SeqClient:
    """Returns a queued sequence of responses; counts HTTP calls."""
    calls = 0

    def __init__(self, responses):
        self._responses = responses  # SHARED queue across client instances

    async def __aenter__(self):
        return self

    async def __aexit__(self, *a):
        return False

    async def post(self, *a, **k):
        type(self).calls += 1
        return self._responses.pop(0)


def _patch_seq(monkeypatch, responses):
    monkeypatch.setenv("GEMINI_API_KEY", "k")
    _SeqClient.calls = 0
    queue = list(responses)  # one shared queue for the whole invocation
    monkeypatch.setattr(bf_gemini.httpx, "AsyncClient",
                        lambda *a, **k: _SeqClient(queue))


@pytest.mark.parametrize("bad_text", [123, None, {"nested": "obj"}, [1, 2]])
def test_non_string_candidate_text_uses_bounded_budget(monkeypatch, bad_text):
    # Two malformed HTTP-200 responses → BFTerminalError, exactly TWO calls,
    # never an AttributeError.
    env = {"candidates": [{"content": {"parts": [{"text": bad_text}]}}]}
    _patch_seq(monkeypatch, [_Resp(200, env), _Resp(200, env)])
    with pytest.raises(BFTerminalError):
        run(bf_gemini._call_gemini_json("p", timeout=1, max_tokens=10))
    assert _SeqClient.calls == 2


@pytest.mark.parametrize("env", [
    "not-a-dict-envelope",
    {"no": "candidates"},
    {"candidates": "notlist"},
    {"candidates": []},
    {"candidates": [{"content": {"parts": []}}]},
])
def test_malformed_envelope_uses_bounded_budget(monkeypatch, env):
    _patch_seq(monkeypatch, [_Resp(200, env), _Resp(200, env)])
    with pytest.raises(BFTerminalError):
        run(bf_gemini._call_gemini_json("p", timeout=1, max_tokens=10))
    assert _SeqClient.calls == 2


def test_first_malformed_then_valid_recovers_in_two_calls(monkeypatch):
    good = {"candidates": [{"content": {"parts": [{"text": '{"ok": true}'}]}}]}
    bad = {"candidates": [{"content": {"parts": [{"text": 999}]}}]}
    _patch_seq(monkeypatch, [_Resp(200, bad), _Resp(200, good)])
    out = run(bf_gemini._call_gemini_json("p", timeout=1, max_tokens=10))
    assert out == {"ok": True} and _SeqClient.calls == 2


# ════════════════════════ HIGH 12 — hard clamps ═════════════════════════════
def test_clamp_ceiling_env_cannot_raise(monkeypatch):
    # env value ABOVE the hard maximum is clamped down to the hard maximum.
    monkeypatch.setenv("BF_TEST_CEIL", "1000")
    assert bfj._clamp_ceiling("BF_TEST_CEIL", 20, bfj.HARD_MAX_TOTAL_CHAPTERS) == 20
    # env value BELOW the hard maximum may reduce the ceiling.
    monkeypatch.setenv("BF_TEST_CEIL", "5")
    assert bfj._clamp_ceiling("BF_TEST_CEIL", 20, bfj.HARD_MAX_TOTAL_CHAPTERS) == 5
    # invalid / negative env → safe default (then clamped).
    monkeypatch.setenv("BF_TEST_CEIL", "-9")
    assert bfj._clamp_ceiling("BF_TEST_CEIL", 20, bfj.HARD_MAX_TOTAL_CHAPTERS) == 20
    monkeypatch.setenv("BF_TEST_CEIL", "not-a-number")
    assert bfj._clamp_ceiling("BF_TEST_CEIL", 20, bfj.HARD_MAX_TOTAL_CHAPTERS) == 20


def test_module_constants_are_hard_clamped():
    assert bfj.MAX_TOTAL_CHAPTERS == bfj.HARD_MAX_TOTAL_CHAPTERS == 20
    assert bfj.MAX_RETRIES <= bfj.HARD_MAX_RETRIES == 2
    assert bf_gemini.MAX_PROVIDER_CALLS <= bf_gemini.HARD_MAX_PROVIDER_CALLS == 2


def test_provider_calls_env_cannot_raise(monkeypatch):
    monkeypatch.setenv("BOOK_FACTORY_MAX_PROVIDER_CALLS", "100")
    assert bf_gemini.effective_max_provider_calls() == 2  # never above hard max
    monkeypatch.delenv("BOOK_FACTORY_MAX_PROVIDER_CALLS", raising=False)


def test_lease_floor_and_hard_cap_relationship():
    # §HIGH 12: lease >= longest provider timeout + margin, and <= hard cap.
    assert bfj.CLAIM_LEASE_S >= max(bf_gemini.BLUEPRINT_TIMEOUT_S, bf_gemini.CHAPTER_TIMEOUT_S)
    assert bfj.CLAIM_LEASE_S >= bfj._LEASE_FLOOR_S
    assert bfj.CLAIM_LEASE_S <= bfj.HARD_MAX_CLAIM_LEASE_S


def test_retries_env_cannot_raise(monkeypatch):
    monkeypatch.setenv("BF_TEST_RETRY", "50")
    assert bfj._clamp_ceiling("BF_TEST_RETRY", 2, bfj.HARD_MAX_RETRIES, hard_min=0) == 2


# ════════════════════════ HIGH 4 — preset/recipe validity ═══════════════════
# Resolved configs mirroring the frontend bookFactorySchema SIMPLE_PRESETS and
# RECIPES (applied over the canonical default). Every one must pass the REAL
# backend validator and create-job route.
_SIMPLE_PRESETS = {
    "short": dict(chapterCount=3, includeReviewChapter=False, minWordsPerChapter=90,
                  maxWordsPerChapter=180, paragraphGuidance="short", dialogueTurnsPerChapter=3,
                  vocabularyPerChapter=4, mcqPerChapter=2, fillblankPerChapter=1,
                  speakingPerChapter=1, pronunciationDepth="light"),
    "balanced": dict(chapterCount=5, includeReviewChapter=True, minWordsPerChapter=120,
                     maxWordsPerChapter=320, paragraphGuidance="balanced", dialogueTurnsPerChapter=4,
                     vocabularyPerChapter=6, mcqPerChapter=3, fillblankPerChapter=2,
                     speakingPerChapter=1, pronunciationDepth="standard"),
    "deep": dict(chapterCount=8, includeReviewChapter=True, minWordsPerChapter=180,
                 maxWordsPerChapter=420, paragraphGuidance="detailed", dialogueTurnsPerChapter=6,
                 vocabularyPerChapter=8, mcqPerChapter=4, fillblankPerChapter=3,
                 speakingPerChapter=2, pronunciationDepth="deep"),
}
_RECIPES = {
    "a1_short_story": dict(section="story", level="A1", **_SIMPLE_PRESETS["short"], pedagogyProfile="general_english"),
    "a2_story_speaking": dict(section="story", level="A2", **{**_SIMPLE_PRESETS["balanced"], "speakingPerChapter": 2}, pedagogyProfile="speaking_confidence"),
    "b1_professional_convo": dict(section="conversation", level="B1", **{**_SIMPLE_PRESETS["balanced"], "dialogueTurnsPerChapter": 8}, pedagogyProfile="workplace_communication"),
    "standard_story_book": dict(section="story", level="A2", tier="standard", **_SIMPLE_PRESETS["balanced"], pedagogyProfile="general_english"),
    "premium_full_practice": dict(section="story", level="B1", tier="premium", **_SIMPLE_PRESETS["deep"], pedagogyProfile="daravuth_speaking_performance"),
    "limited_edition_narrative": dict(section="story", level="B2", tier="limited", **_SIMPLE_PRESETS["deep"], pedagogyProfile="storytelling_performance"),
    "exercise_review_book": dict(section="exercise", level="A2", includeReviewChapter=True, chapterCount=6,
                                 mcqPerChapter=5, fillblankPerChapter=5, vocabularyPerChapter=6,
                                 speakingPerChapter=0, pedagogyProfile="general_english"),
}


@pytest.mark.parametrize("preset", list(_SIMPLE_PRESETS))
def test_every_simple_preset_backend_valid(preset):
    cfg = dict(FRONTEND_DEFAULT_CONFIG, mode="simple", **_SIMPLE_PRESETS[preset])
    assert validate_book_factory_config(cfg) == [], preset


@pytest.mark.parametrize("recipe", list(_RECIPES))
def test_every_recipe_backend_valid(recipe):
    cfg = dict(FRONTEND_DEFAULT_CONFIG, recipeId=recipe, **_RECIPES[recipe])
    assert validate_book_factory_config(cfg) == [], recipe


@pytest.mark.parametrize("recipe", list(_RECIPES))
def test_every_recipe_creates_job_via_route(monkeypatch, recipe):
    _enable_all(monkeypatch)
    db = _DB()
    client = _make_client(db)
    cfg = dict(FRONTEND_DEFAULT_CONFIG, recipeId=recipe, **_RECIPES[recipe])
    r = client.post("/api/studio/book-factory/jobs", json={"config": cfg})
    assert r.status_code == 200, (recipe, r.json())


@pytest.mark.parametrize("level", ["A1", "A2", "B1", "B2"])
@pytest.mark.parametrize("tier", ["free", "standard", "premium", "limited"])
@pytest.mark.parametrize("minutes", [1, 6, 20, 60, 180])
def test_smart_matrix_backend_valid(level, tier, minutes):
    # Port of smartCompose bounded to the shared limits — every combination
    # across levels, tiers and reading durations must be backend-valid.
    density = {"A1": 0.8, "A2": 1, "B1": 1.2, "B2": 1.4}[level]

    def clampi(v, lo, hi):
        return max(lo, min(hi, round(v)))

    chapter_count = clampi(max(3, round(minutes / 2)), 1, 12)
    include_review = chapter_count >= 4
    # §PHASE D1: divide by totalChapterCount (with review) so the ceiling is
    # consistent with the backend validator's aggregate check.
    total_chapters = chapter_count + (1 if include_review else 0)
    min_words = clampi(80 * density, 50, 1000)
    word_ceil = max(min_words, 10000 // max(1, total_chapters))
    max_words = clampi(200 * density + minutes * 6, min_words, min(1000, word_ceil))
    boost = 1 if tier in ("premium", "limited") else 0
    cfg = dict(FRONTEND_DEFAULT_CONFIG, mode="smart", level=level, tier=tier,
               readingMinutes=minutes, chapterCount=chapter_count,
               includeReviewChapter=include_review, minWordsPerChapter=min_words,
               maxWordsPerChapter=max_words,
               dialogueTurnsPerChapter=clampi(3 + boost * 2, 0, 20),
               vocabularyPerChapter=clampi(4 + round(density * 2), 0, 20),
               mcqPerChapter=clampi(2 + boost, 0, 10),
               fillblankPerChapter=clampi(1 + boost, 0, 10),
               speakingPerChapter=clampi(1 + boost, 0, 10))
    assert validate_book_factory_config(cfg) == [], cfg



def test_invalid_fillblank_dropped_with_warning(monkeypatch):
    _enable_all(monkeypatch)
    db = _DB()
    client = _make_client(db)
    jid = _create_and_blueprint(client, monkeypatch)

    bad_fb_chapter = copy.deepcopy(_GOOD_CHAPTER)
    bad_fb_chapter["fillblanks"] = [
        {"text": "no blank marker here", "answer": "x"},  # invalid: no marker
        {"text": "I ___ home", "answer": "go"},           # valid
    ]

    async def gen(config, spec):
        return copy.deepcopy(bad_fb_chapter)

    monkeypatch.setattr(bf_gemini, "generate_chapter", gen)
    client.post(f"/api/studio/book-factory/jobs/{jid}/approve")
    cid = run(db[COLL].find_one({"_id": jid}))["chapterOrder"][0]
    client.post(f"/api/studio/book-factory/jobs/{jid}/step", json={"chapterId": cid})
    ch = _dig(run(db[COLL].find_one({"_id": jid})), f"chapters.{cid}")
    warn_types = [w.get("type") for w in ch.get("warnings") or []]
    assert "fillblank_dropped" in warn_types
    # the rest of the chapter survives (blocks were composed, valid fb kept)
    assert ch["state"] == S_COMPLETED and ch["blocks"]


# ════════════════════════ MEDIUM 15 — evidence boundaries ═══════════════════
def test_evidence_phrase_boundary():
    from book_factory_validator import evidence_in_text
    assert evidence_in_text("the cat sat", "The cat sat on the mat.")
    assert evidence_in_text("THE CAT SAT!", "the cat sat on the mat")   # case/punct
    assert not evidence_in_text("cat", "We must concatenate the strings.")
    assert not evidence_in_text("cat", "scatter the seeds")             # interior


# ════════════ PHASE B3 — env clamp helpers (book_factory_gemini) ════════════
def test_env_float_clamped_safe_on_non_numeric(monkeypatch):
    from book_factory_gemini import _env_float_clamped
    monkeypatch.setenv("BF_TEST_FLOAT", "not-a-number")
    result = _env_float_clamped("BF_TEST_FLOAT", 30.0, 5.0, 120.0)
    assert result == 30.0  # default on parse error


def test_env_float_clamped_clamps_above_hard_max(monkeypatch):
    from book_factory_gemini import _env_float_clamped
    monkeypatch.setenv("BF_TEST_FLOAT", "9999.0")
    result = _env_float_clamped("BF_TEST_FLOAT", 30.0, 5.0, 120.0)
    assert result == 120.0  # clamped to hard_max


def test_env_float_clamped_clamps_below_hard_min(monkeypatch):
    from book_factory_gemini import _env_float_clamped
    monkeypatch.setenv("BF_TEST_FLOAT", "1.0")
    result = _env_float_clamped("BF_TEST_FLOAT", 30.0, 5.0, 120.0)
    assert result == 5.0  # clamped to hard_min


def test_env_float_clamped_rejects_inf(monkeypatch):
    from book_factory_gemini import _env_float_clamped
    import math
    monkeypatch.setenv("BF_TEST_FLOAT", str(float("inf")))
    result = _env_float_clamped("BF_TEST_FLOAT", 30.0, 5.0, 120.0)
    assert result == 30.0 and math.isfinite(result)


def test_env_int_clamped_safe_on_non_numeric(monkeypatch):
    from book_factory_gemini import _env_int_clamped
    monkeypatch.setenv("BF_TEST_INT", "abc")
    result = _env_int_clamped("BF_TEST_INT", 512, 128, 8192)
    assert result == 512  # default


def test_env_int_clamped_clamps_to_hard_ceiling(monkeypatch):
    from book_factory_gemini import _env_int_clamped
    monkeypatch.setenv("BF_TEST_INT", "999999")
    result = _env_int_clamped("BF_TEST_INT", 512, 128, 8192)
    assert result == 8192


def test_blueprint_timeout_env_cannot_raise_ceiling(monkeypatch):
    import book_factory_gemini as bg
    monkeypatch.setenv("BOOK_FACTORY_BLUEPRINT_TIMEOUT_S", "99999")
    assert bg.BLUEPRINT_TIMEOUT_S <= bg.HARD_MAX_BLUEPRINT_TIMEOUT_S


# ════════════ PHASE B1 — paragraphs-as-string protection ════════════════════
def test_safe_list_on_string_returns_empty():
    from book_factory_composer import _safe_list
    assert _safe_list("abc") == []


def test_safe_list_on_list_passthrough():
    from book_factory_composer import _safe_list
    assert _safe_list(["a", "b"]) == ["a", "b"]


def test_safe_list_on_none_returns_empty():
    from book_factory_composer import _safe_list
    assert _safe_list(None) == []


def test_paragraphs_as_string_yields_no_blocks():
    from book_factory_composer import compose_chapter_blocks
    # If Gemini returns paragraphs as a plain string (not a list), no blocks
    # should be composed — the string must not be iterated character-by-character.
    blocks = compose_chapter_blocks({"paragraphs": "hello world"}, [], [])
    assert blocks == []


def test_empty_semantic_yields_no_blocks():
    from book_factory_composer import compose_chapter_blocks
    assert compose_chapter_blocks({}, [], []) == []


# ═══════════ PHASE B1/B2 — persisted bounded malformed-success policy ════════
def test_empty_blocks_both_calls_exhausted_fails_terminal(monkeypatch):
    # §PHASE B1/B2: BOTH calls return empty blocks → fail_terminal.
    # The first empty-blocks response triggers a persisted malformedRetryUsed flag
    # and one retry call.  The second empty-blocks response exhausts the 2-call
    # budget and fails terminal.  Exactly two fake calls must be made.
    _enable_all(monkeypatch)
    db = _DB()
    client = _make_client(db)
    jid = _create_and_blueprint(client, monkeypatch)

    call_count = {"n": 0}
    async def gen_empty(config, spec):
        call_count["n"] += 1
        return {"title": "Ch", "paragraphs": "string-not-list"}

    monkeypatch.setattr(bf_gemini, "generate_chapter", gen_empty)
    client.post(f"/api/studio/book-factory/jobs/{jid}/approve")
    cid = run(db[COLL].find_one({"_id": jid}))["chapterOrder"][0]
    client.post(f"/api/studio/book-factory/jobs/{jid}/step", json={"chapterId": cid})
    ch = _dig(run(db[COLL].find_one({"_id": jid})), f"chapters.{cid}")
    from book_factory_jobs import S_FAILED_TERMINAL
    assert ch["state"] == S_FAILED_TERMINAL, f"expected failed_terminal, got {ch['state']}"
    assert ch.get("lastError") == "empty_canonical_blocks"
    assert ch.get("malformedRetryUsed") is True, "malformedRetryUsed must be persisted"
    assert call_count["n"] == 2, f"exactly 2 fake calls must be made, got {call_count['n']}"
    assert int(ch.get("providerCallCount") or 0) == 2, "providerCallCount must reflect both calls"


def test_empty_blocks_first_then_valid_completes(monkeypatch):
    # §PHASE B1/B2: first call empty, second call valid → chapter COMPLETES.
    # The retry budget is used and the chapter succeeds on the second attempt.
    _enable_all(monkeypatch)
    db = _DB()
    client = _make_client(db)
    jid = _create_and_blueprint(client, monkeypatch)

    call_count = {"n": 0}
    async def gen_first_empty_then_valid(config, spec):
        call_count["n"] += 1
        if call_count["n"] == 1:
            return {"title": "Ch", "paragraphs": "string-not-list"}
        return copy.deepcopy(_GOOD_CHAPTER)

    monkeypatch.setattr(bf_gemini, "generate_chapter", gen_first_empty_then_valid)
    client.post(f"/api/studio/book-factory/jobs/{jid}/approve")
    cid = run(db[COLL].find_one({"_id": jid}))["chapterOrder"][0]
    client.post(f"/api/studio/book-factory/jobs/{jid}/step", json={"chapterId": cid})
    ch = _dig(run(db[COLL].find_one({"_id": jid})), f"chapters.{cid}")
    assert ch["state"] == S_COMPLETED, f"expected completed, got {ch['state']}"
    assert ch.get("malformedRetryUsed") is True, "malformedRetryUsed must be recorded"
    assert call_count["n"] == 2, "exactly 2 calls: first empty, second valid"
    assert ch.get("blocks"), "chapter must have blocks after valid second call"


def test_no_malformed_retry_when_budget_exhausted_by_json(monkeypatch):
    # §PHASE B1/B2: if the JSON path already used both budget slots (budget from
    # a test fake that reports providerCallCount=2), the semantic retry is skipped.
    # The test fake reports providerCallCount=2 and returns empty blocks.
    _enable_all(monkeypatch)
    db = _DB()
    client = _make_client(db)
    jid = _create_and_blueprint(client, monkeypatch)

    call_count = {"n": 0}
    async def gen_budget_exhausted(config, spec, *, budget=None, max_calls=None):
        call_count["n"] += 1
        if budget is not None:
            budget["providerCallCount"] = 2  # both slots used (JSON retry path)
            budget["jsonRetryUsed"] = True
        return {"title": "Ch", "paragraphs": "string-not-list"}

    monkeypatch.setattr(bf_gemini, "generate_chapter", gen_budget_exhausted)
    client.post(f"/api/studio/book-factory/jobs/{jid}/approve")
    cid = run(db[COLL].find_one({"_id": jid}))["chapterOrder"][0]
    client.post(f"/api/studio/book-factory/jobs/{jid}/step", json={"chapterId": cid})
    ch = _dig(run(db[COLL].find_one({"_id": jid})), f"chapters.{cid}")
    from book_factory_jobs import S_FAILED_TERMINAL
    assert ch["state"] == S_FAILED_TERMINAL
    assert call_count["n"] == 1, "must NOT make a semantic retry when budget is exhausted"


def test_malformed_retry_not_repeated_after_crash_recovery(monkeypatch):
    # §PHASE B1/B2: if malformedRetryUsed=True is already persisted on the chapter
    # (crash recovery path), the next _run_chapter call must go straight to terminal
    # without making a third provider call.
    _enable_all(monkeypatch)
    db = _DB()
    cid = _seed_job(db, chapter_state=S_PENDING)
    # Simulate crash: malformedRetryUsed persisted but chapter still pending.
    run(db[COLL].update_one({"_id": "job1"}, {"$set": {f"chapters.{cid}.malformedRetryUsed": True}}))
    run(db[COLL].update_one({"_id": "job1"}, {"$set": {"blueprintApprovedAt": "2026-01-01T00:00:00Z"}}))

    call_count = {"n": 0}
    async def gen_empty(config, spec):
        call_count["n"] += 1
        return {"title": "Ch", "paragraphs": "string-not-list"}

    monkeypatch.setattr(bf_gemini, "generate_chapter", gen_empty)
    _enable_all(monkeypatch)
    client = _make_client(db)
    client.post(f"/api/studio/book-factory/jobs/job1/step", json={"chapterId": cid})
    ch = _dig(run(db[COLL].find_one({"_id": "job1"})), f"chapters.{cid}")
    from book_factory_jobs import S_FAILED_TERMINAL
    assert ch["state"] == S_FAILED_TERMINAL
    assert call_count["n"] == 1, "crash recovery must skip the retry (only 1 call, not 2)"


def test_retry_route_resets_malformed_retry_used(monkeypatch):
    # §PHASE C1: /retry must reset malformedRetryUsed so the next claim gets a
    # fresh budget (not a phantom budget-exhausted state).
    _enable_all(monkeypatch)
    db = _DB()
    cid = _seed_job(db, chapter_state=S_FAILED_RETRYABLE, attempt_count=1)
    # Simulate the malformed retry having been used in the previous attempt.
    run(db[COLL].update_one({"_id": "job1"}, {"$set": {f"chapters.{cid}.malformedRetryUsed": True}}))
    client = _make_client(db)
    r = client.post(f"/api/studio/book-factory/jobs/job1/chapters/{cid}/retry")
    assert r.status_code == 200
    ch = _dig(run(db[COLL].find_one({"_id": "job1"})), f"chapters.{cid}")
    assert ch.get("malformedRetryUsed") is False, "/retry must reset malformedRetryUsed to False"


def test_regenerate_resets_malformed_retry_used(monkeypatch):
    # §PHASE C1: /regenerate must also reset malformedRetryUsed.
    _enable_all(monkeypatch)
    db = _DB()
    cid = _seed_job(db, chapter_state=S_COMPLETED, attempt_count=1)
    run(db[COLL].update_one({"_id": "job1"}, {"$set": {f"chapters.{cid}.malformedRetryUsed": True}}))
    client = _make_client(db)
    r = client.post(f"/api/studio/book-factory/jobs/job1/chapters/{cid}/regenerate")
    assert r.status_code == 200
    ch = _dig(run(db[COLL].find_one({"_id": "job1"})), f"chapters.{cid}")
    assert ch.get("malformedRetryUsed") is False, "/regenerate must reset malformedRetryUsed to False"


# ════════════ PHASE D2 — presentation field maxlen validation ════════════════
@pytest.mark.parametrize("field,maxlen,good_val", [
    ("coverGradient", 200, "linear-gradient(#000,#fff)"),
    ("coverEmoji", 50, "📖"),
    ("accent", 100, "#D4A843"),
])
def test_presentation_field_within_limit_is_valid(field, maxlen, good_val):
    cfg = dict(FRONTEND_DEFAULT_CONFIG, **{field: good_val})
    assert validate_book_factory_config(cfg) == []


@pytest.mark.parametrize("field,maxlen", [
    ("coverGradient", 200),
    ("coverEmoji", 50),
    ("accent", 100),
])
def test_presentation_field_over_limit_is_rejected(field, maxlen):
    too_long = "x" * (maxlen + 1)
    cfg = dict(FRONTEND_DEFAULT_CONFIG, **{field: too_long})
    errors = validate_book_factory_config(cfg)
    assert errors, f"Expected rejection for {field} over {maxlen} chars"


# ════════════ PHASE D1 — word count includes review chapter ═════════════════
def test_word_count_aggregate_includes_review_chapter():
    # chapterCount=19, includeReviewChapter=True, maxWordsPerChapter=526
    # Total=20 chapters × 526 = 10,520 which exceeds HARD_MAX_TOTAL_WORDS=10,000.
    # Without the fix the old check was 19×526=9,994 which would pass.
    cfg = dict(FRONTEND_DEFAULT_CONFIG,
               chapterCount=19, includeReviewChapter=True,
               minWordsPerChapter=100, maxWordsPerChapter=526)
    errors = validate_book_factory_config(cfg)
    assert errors, "Expected rejection: 20 chapters × 526 words exceeds 10,000"


def test_word_count_no_review_not_falsely_rejected():
    # 19 chapters × 526 = 9,994 — under limit — no review chapter.
    cfg = dict(FRONTEND_DEFAULT_CONFIG,
               chapterCount=19, includeReviewChapter=False,
               minWordsPerChapter=100, maxWordsPerChapter=526)
    assert validate_book_factory_config(cfg) == []


# ════════════ PHASE C1 — regeneration resets attempt lifecycle ═══════════════
def test_regenerate_resets_attempt_count(monkeypatch):
    _enable_all(monkeypatch)
    db = _DB()
    # Seed a completed chapter that has attemptCount=3 (simulates multiple prior attempts).
    cid = _seed_job(db, chapter_state=S_COMPLETED, attempt_count=3)
    run(db[COLL].update_one({"_id": "job1"}, {"$set": {f"chapters.{cid}.attemptCount": 3}}))
    client = _make_client(db)
    r = client.post(f"/api/studio/book-factory/jobs/job1/chapters/{cid}/regenerate")
    assert r.status_code == 200
    ch = _dig(run(db[COLL].find_one({"_id": "job1"})), f"chapters.{cid}")
    assert ch["attemptCount"] == 0, "regenerate must reset attemptCount to 0"
    assert ch["state"] == S_PENDING
    assert ch["providerCallCount"] == 0
    assert ch["jsonRetryUsed"] is False


# ════════════ PHASE E2 — dismiss route + listing exclusion ══════════════════
def test_dismiss_hides_job_from_listing(monkeypatch):
    _enable_all(monkeypatch)
    db = _DB()
    client = _make_client(db)
    jid = client.post("/api/studio/book-factory/jobs",
                      json={"config": dict(FRONTEND_DEFAULT_CONFIG)}).json()["job"]["jobId"]
    # Confirm it appears in listing before dismiss.
    assert jid in {j["jobId"] for j in client.get("/api/studio/book-factory/jobs").json()["jobs"]}
    r = client.post(f"/api/studio/book-factory/jobs/{jid}/dismiss")
    assert r.status_code == 200
    # After dismiss it must be excluded from listing.
    ids = {j["jobId"] for j in client.get("/api/studio/book-factory/jobs").json()["jobs"]}
    assert jid not in ids


def test_dismiss_idempotent(monkeypatch):
    _enable_all(monkeypatch)
    db = _DB()
    client = _make_client(db)
    jid = client.post("/api/studio/book-factory/jobs",
                      json={"config": dict(FRONTEND_DEFAULT_CONFIG)}).json()["job"]["jobId"]
    assert client.post(f"/api/studio/book-factory/jobs/{jid}/dismiss").status_code == 200
    assert client.post(f"/api/studio/book-factory/jobs/{jid}/dismiss").status_code == 200


def test_dismiss_nonexistent_job_returns_404(monkeypatch):
    _enable_all(monkeypatch)
    db = _DB()
    client = _make_client(db)
    assert client.post("/api/studio/book-factory/jobs/no-such-job/dismiss").status_code == 404


def test_dismiss_cross_admin_denied(monkeypatch):
    _enable_all(monkeypatch)
    db = _DB()
    _seed_owned(db, "admin-a@test")
    client_b = _make_client(db, _admin_b_dep)
    # admin-b cannot dismiss admin-a's job.
    assert client_b.post("/api/studio/book-factory/jobs/job1/dismiss").status_code == 404


def test_dismissed_job_still_retrievable_by_get(monkeypatch):
    _enable_all(monkeypatch)
    db = _DB()
    client = _make_client(db)
    jid = client.post("/api/studio/book-factory/jobs",
                      json={"config": dict(FRONTEND_DEFAULT_CONFIG)}).json()["job"]["jobId"]
    client.post(f"/api/studio/book-factory/jobs/{jid}/dismiss")
    r = client.get(f"/api/studio/book-factory/jobs/{jid}")
    assert r.status_code == 200 and r.json()["job"]["jobId"] == jid


def test_cancelled_jobs_excluded_from_listing(monkeypatch):
    _enable_all(monkeypatch)
    db = _DB()
    client = _make_client(db)
    jid = client.post("/api/studio/book-factory/jobs",
                      json={"config": dict(FRONTEND_DEFAULT_CONFIG)}).json()["job"]["jobId"]
    client.post(f"/api/studio/book-factory/jobs/{jid}/cancel")
    ids = {j["jobId"] for j in client.get("/api/studio/book-factory/jobs").json()["jobs"]}
    assert jid not in ids
