"""tests/test_book_factory_conversation_automation.py
=======================================================
Phase E: persisted line-level conversation-audio automation. NO real
ElevenLabs / R2 calls — every provider and storage seam is monkeypatched.

Covers the locked requirements:
  - zero-copy dialog -> persisted per-line stages (stable lineId, never index)
  - speaker detection feeds voice assignment at init
  - two concurrent claims on the same line: only one wins
  - resume skips already-completed lines, never re-pays for them
  - retrying one failed line never touches any other line
  - unknown-outcome / terminal / retryable classification (not "everything retryable")
  - assembly is blocked until every required line is completed
  - assembly reuses stored line audio — never re-calls the provider
  - a line storage failure never triggers a second paid provider call
  - the existing all-at-once /conversation route is completely unaffected
"""
from __future__ import annotations

import copy

import pytest
from fastapi import APIRouter, FastAPI, HTTPException
from fastapi.testclient import TestClient

import book_factory_conversation as bf_conv
import book_factory_gemini as bf_gemini
import book_factory_jobs as bfj
from book_factory_jobs import S_COMPLETED, S_FAILED_RETRYABLE, S_PENDING, _claim_stage
from tests.test_book_factory_jobs import _DB, _GOOD_CHAPTER


def _admin_dep_for(email):
    async def _dep():
        return {"email": email}
    return _dep


_MULTI_DIALOG_CHAPTER = {
    "title": "Chapter 1",
    "paragraphs": ["An intro paragraph."],
    "dialogueLines": [
        {"speaker": "Dara", "text": "Good morning, how are you?"},
        {"speaker": "Maya", "text": "I am well, thank you!"},
        {"speaker": "Dara", "text": "Great, let's begin the lesson."},
    ],
    "vocabulary": [], "pronunciationTargets": [], "speakingPrompts": [],
    "mcqs": [], "fillblanks": [], "summary": "",
}


class _FakeBookStore:
    def __init__(self):
        self.revisions: dict[str, list[dict]] = {}
        self.save_calls = 0
        self.conversation_line_calls: list[dict] = []
        self.assembly_calls: list[dict] = []

    async def save_book_revision(self, payload_dict: dict, admin_email: str) -> dict:
        self.save_calls += 1
        slug = payload_dict.get("slug") or "untitled"
        revs = self.revisions.setdefault(slug, [])
        next_rev = len(revs) + 1
        doc = {**payload_dict, "slug": slug, "revision": next_rev, "_authoredBy": admin_email,
               "published": bool(payload_dict.get("published", False))}
        revs.append(doc)
        return {"success": True, "slug": slug, "revision": next_rev, "book": doc}

    async def publish_book(self, slug: str) -> dict:
        revs = self.revisions.get(slug) or []
        for r in revs:
            r["published"] = True
        return {"success": True, "matched": len(revs), "modified": len(revs)}

    async def get_book_by_slug(self, slug: str):
        revs = self.revisions.get(slug) or []
        return copy.deepcopy(revs[-1]) if revs else None

    async def run_elevenlabs_for_chapter(self, **kwargs):
        raise NotImplementedError("not exercised in these tests")

    async def run_conversation_line(self, *, text, voice_id, emotion="neutral",
                                     acting_note_extra="", voice_settings=None):
        self.conversation_line_calls.append({"text": text, "voiceId": voice_id})
        return {"audio_base64": "ZmFrZS1hdWRpby1ieXRlcw==",  # b"fake-audio-bytes"
                "word_timestamps": [{"word": w, "start": i * 0.3, "end": i * 0.3 + 0.25}
                                     for i, w in enumerate(text.split())],
                "duration": 0.3 * max(1, len(text.split()))}

    async def assemble_conversation_for_chapter(self, *, slug, chapter_index, line_audio_results, admin_email):
        self.assembly_calls.append({"slug": slug, "chapterIndex": chapter_index,
                                    "lineCount": len(line_audio_results)})
        book = await self.get_book_by_slug(slug)
        chapters = book.get("chapters", [])
        chapter = chapters[chapter_index]
        blocks = list(chapter.get("blocks", []))
        blocks = [b for b in blocks if not b.get("_conversation_audio")]
        blocks.append({"type": "audio", "text": "https://x/assembled.mp3", "_conversation_audio": True})
        chapters[chapter_index] = {**chapter, "blocks": blocks}
        result = await self.save_book_revision({**book, "chapters": chapters, "slug": slug}, admin_email)
        return {"audioUrl": "https://x/assembled.mp3", "audioId": "aud1",
                "totalDuration": sum(r.get("duration", 0) for r in line_audio_results),
                "revision": result["revision"]}


def _make_client(db=None, email="admin-a@test", store=None):
    app = FastAPI()
    api = APIRouter(prefix="/api")
    store = store or _FakeBookStore()

    # Dynamic-lookup wrappers: a test's `monkeypatch.setattr(store, "run_conversation_line", ...)`
    # must take effect on the NEXT call even though registration happens
    # up-front — a directly-bound method reference captured here would freeze
    # the ORIGINAL implementation forever, silently ignoring the override.
    async def _run_conversation_line(**kwargs):
        return await store.run_conversation_line(**kwargs)

    async def _assemble_conversation_for_chapter(**kwargs):
        return await store.assemble_conversation_for_chapter(**kwargs)

    bfj.register_book_factory_routes(
        api, db or _DB(), _admin_dep_for(email),
        save_book_revision=store.save_book_revision,
        publish_book=store.publish_book,
        run_elevenlabs_for_chapter=store.run_elevenlabs_for_chapter,
        get_book_by_slug=store.get_book_by_slug,
        run_conversation_line=_run_conversation_line,
        assemble_conversation_for_chapter=_assemble_conversation_for_chapter,
    )
    app.include_router(api)
    return TestClient(app), store


def _enable_all(monkeypatch, conversation=True, storage_ready=True):
    monkeypatch.setenv("BOOK_FACTORY_VISIBLE", "true")
    monkeypatch.setenv("BOOK_FACTORY_ENABLED", "true")
    monkeypatch.setenv("BOOK_FACTORY_GEMINI_ENABLED", "true")
    monkeypatch.setenv("GEMINI_API_KEY", "test-key")
    if conversation:
        monkeypatch.setenv("BOOK_FACTORY_CONVERSATION_AUDIO_ENABLED", "true")
    monkeypatch.setattr(bf_conv, "storage_configured", lambda: storage_ready)


@pytest.fixture(autouse=True)
def _fake_gemini_text(monkeypatch):
    async def fake_bp(config):
        return {"bookTitle": "B", "summary": "s", "chapters": [{"title": "One", "outline": "o"}]}

    async def fake_chapter(config, spec):
        return copy.deepcopy(_MULTI_DIALOG_CHAPTER)

    monkeypatch.setattr(bf_gemini, "generate_blueprint", fake_bp)
    monkeypatch.setattr(bf_gemini, "generate_chapter", fake_chapter)


@pytest.fixture(autouse=True)
def _default_line_storage_succeeds(monkeypatch):
    """R2 is never actually configured in this test environment — default
    every test to a successful, unique-per-call fake upload so "happy path"
    tests don't have to remember to mock storage. Failure-path tests
    override this within their own test body (monkeypatch applies last-write-wins)."""
    counter = {"n": 0}

    async def fake_store(job_id, chapter_id, line_id, attempt_id, audio_bytes):
        counter["n"] += 1
        return f"https://x/{chapter_id}/{line_id}/{counter['n']}.mp3"

    monkeypatch.setattr(bf_conv, "store_line_audio", fake_store)


def _complete_dialog_job_and_save(client):
    r = client.post("/api/studio/book-factory/jobs",
                    json={"config": {"title": "Dialogue Book", "topic": "Daily life", "section": "conversation",
                                     "level": "A2", "pedagogyProfile": "general_english",
                                     "mode": "simple", "readingMinutes": 6,
                                     "minWordsPerChapter": 50, "maxWordsPerChapter": 320,
                                     "tier": "free", "price": 0, "chapterCount": 1}})
    job_id = r.json()["job"]["jobId"]
    r = client.post(f"/api/studio/book-factory/jobs/{job_id}/step", json={"stage": "blueprint"})
    cid = r.json()["job"]["chapterOrder"][0]
    client.post(f"/api/studio/book-factory/jobs/{job_id}/approve")
    r = client.post(f"/api/studio/book-factory/jobs/{job_id}/step", json={"chapterId": cid})
    assert r.json()["result"]["status"] == "completed"
    saved = client.post(f"/api/studio/book-factory/jobs/{job_id}/save-draft").json()
    return job_id, cid, saved["slug"]


# ── flag gating ─────────────────────────────────────────────────────────────
def test_conversation_audio_disabled_by_default(monkeypatch):
    _enable_all(monkeypatch, conversation=False)
    client, _store = _make_client()
    job_id, cid, _slug = _complete_dialog_job_and_save(client)
    r = client.post(f"/api/studio/book-factory/jobs/{job_id}/conversation-audio/{cid}/init",
                    json={"voiceAssignments": {"Dara": "v1", "Maya": "v2"}})
    assert r.status_code == 503


def test_conversation_audio_requires_storage_configured(monkeypatch):
    _enable_all(monkeypatch, conversation=True, storage_ready=False)
    client, _store = _make_client()
    job_id, cid, _slug = _complete_dialog_job_and_save(client)
    r = client.post(f"/api/studio/book-factory/jobs/{job_id}/conversation-audio/{cid}/init",
                    json={"voiceAssignments": {"Dara": "v1", "Maya": "v2"}})
    assert r.status_code == 503


def test_all_flags_default_false(monkeypatch):
    for k in ("BOOK_FACTORY_COVER_ENABLED", "BOOK_FACTORY_NARRATION_ENABLED",
              "BOOK_FACTORY_CONVERSATION_AUDIO_ENABLED", "BOOK_FACTORY_DIRECT_PUBLISH_ENABLED"):
        monkeypatch.delenv(k, raising=False)
    assert bfj.cover_generation_permitted() is False
    assert bfj.narration_automation_permitted() is False
    assert bfj.conversation_audio_automation_permitted() is False
    assert bfj.direct_publish_permitted() is False


# ── init: speaker detection + voice assignment, stable lineId ──────────────
def test_init_seeds_one_line_per_dialog_block_with_assigned_voice(monkeypatch):
    _enable_all(monkeypatch)
    client, _store = _make_client()
    job_id, cid, slug = _complete_dialog_job_and_save(client)

    r = client.post(f"/api/studio/book-factory/jobs/{job_id}/conversation-audio/{cid}/init",
                    json={"voiceAssignments": {"Dara": "voiceD", "Maya": "voiceM"}})
    assert r.status_code == 200
    conv = r.json()["job"]["conversationAudio"][cid]
    assert len(conv["lineOrder"]) == 3
    lines = conv["lines"]
    assert lines[conv["lineOrder"][0]]["speaker"] == "Dara"
    assert lines[conv["lineOrder"][0]]["voiceId"] == "voiceD"
    assert lines[conv["lineOrder"][1]]["speaker"] == "Maya"
    assert lines[conv["lineOrder"][1]]["voiceId"] == "voiceM"
    assert all(l["state"] == S_PENDING for l in lines.values())


def test_init_requires_saved_draft_first(monkeypatch):
    _enable_all(monkeypatch)
    client, _store = _make_client()
    r = client.post("/api/studio/book-factory/jobs",
                    json={"config": {"title": "T", "topic": "t", "section": "conversation", "level": "A2",
                                     "pedagogyProfile": "general_english", "mode": "simple",
                                     "readingMinutes": 6, "minWordsPerChapter": 50, "maxWordsPerChapter": 320,
                                     "tier": "free", "price": 0, "chapterCount": 1}})
    job_id = r.json()["job"]["jobId"]
    r = client.post(f"/api/studio/book-factory/jobs/{job_id}/step", json={"stage": "blueprint"})
    cid = r.json()["job"]["chapterOrder"][0]
    client.post(f"/api/studio/book-factory/jobs/{job_id}/approve")
    client.post(f"/api/studio/book-factory/jobs/{job_id}/step", json={"chapterId": cid})
    r = client.post(f"/api/studio/book-factory/jobs/{job_id}/conversation-audio/{cid}/init",
                    json={"voiceAssignments": {}})
    assert r.status_code == 409


# ── concurrency: same lineId, only one claim wins ──────────────────────────
def _seed_conversation_job(db, line_states=None):
    """Hand-seed a job doc with a conversationAudio map, mirroring _seed_job's
    style in test_book_factory_jobs.py, for a focused primitive-level test."""
    import asyncio
    line_states = line_states or {"ln0": S_PENDING, "ln1": S_PENDING}
    lines = {
        lid: {"state": st, "attemptId": None, "attemptCount": 0, "generationVersion": 0,
              "speaker": "Dara" if lid == "ln0" else "Maya", "text": "hi", "voiceId": "v1",
              "pauseAfter": 0.35, "blockIndex": i}
        for i, (lid, st) in enumerate(line_states.items())
    }
    job = {
        "_id": "jobX", "jobId": "jobX", "config": {"title": "T"}, "state": "blueprint_ready",
        "authoredBy": "admin-a@test", "savedBookSlug": "slug1",
        "conversationAudio": {"chA": {"lines": lines, "lineOrder": list(line_states.keys()),
                                       "assembly": {"state": S_PENDING, "attemptId": None,
                                                   "attemptCount": 0, "generationVersion": 0}}},
        "chapterOrder": [], "chapters": {}, "warnings": [], "createdAt": "x", "updatedAt": "x",
    }
    asyncio.run(db[bfj.COLL].insert_one(job))


def test_two_concurrent_claims_on_same_line_only_one_wins():
    db = _DB()
    _seed_conversation_job(db)
    path = "conversationAudio.chA.lines.ln0"
    import asyncio
    won1, _a1 = asyncio.run(_claim_stage(db, "jobX", path))
    won2, _a2 = asyncio.run(_claim_stage(db, "jobX", path))
    assert won1 is not None
    assert won2 is None  # lease still valid — second caller loses


# ── resume: completed lines are never regenerated ──────────────────────────
def test_generating_an_already_completed_line_is_skipped_no_duplicate_provider_call(monkeypatch):
    _enable_all(monkeypatch)
    client, store = _make_client()
    job_id, cid, slug = _complete_dialog_job_and_save(client)
    client.post(f"/api/studio/book-factory/jobs/{job_id}/conversation-audio/{cid}/init",
               json={"voiceAssignments": {"Dara": "v1", "Maya": "v2"}})
    line_id = client.get(f"/api/studio/book-factory/jobs/{job_id}").json()["job"]["conversationAudio"][cid]["lineOrder"][0]

    r1 = client.post(f"/api/studio/book-factory/jobs/{job_id}/conversation-audio/{cid}/lines/{line_id}/generate")
    assert r1.json()["result"]["status"] == "completed"
    assert len(store.conversation_line_calls) == 1

    r2 = client.post(f"/api/studio/book-factory/jobs/{job_id}/conversation-audio/{cid}/lines/{line_id}/generate")
    assert r2.json()["result"]["status"] == "skipped"
    assert len(store.conversation_line_calls) == 1  # NOT called again — no duplicate paid call


def test_re_init_never_resets_a_completed_line(monkeypatch):
    _enable_all(monkeypatch)
    client, store = _make_client()
    job_id, cid, slug = _complete_dialog_job_and_save(client)
    client.post(f"/api/studio/book-factory/jobs/{job_id}/conversation-audio/{cid}/init",
               json={"voiceAssignments": {"Dara": "v1", "Maya": "v2"}})
    job = client.get(f"/api/studio/book-factory/jobs/{job_id}").json()["job"]
    line_id = job["conversationAudio"][cid]["lineOrder"][0]
    client.post(f"/api/studio/book-factory/jobs/{job_id}/conversation-audio/{cid}/lines/{line_id}/generate")

    # Teacher tweaks the voice for the OTHER speaker and re-inits.
    r = client.post(f"/api/studio/book-factory/jobs/{job_id}/conversation-audio/{cid}/init",
                    json={"voiceAssignments": {"Dara": "v1", "Maya": "v2-changed"}})
    conv = r.json()["job"]["conversationAudio"][cid]
    assert conv["lines"][line_id]["state"] == S_COMPLETED
    assert conv["lines"][line_id]["voiceId"] == "v1"  # untouched, not reset to some new value


# ── retry: only the targeted line is affected ──────────────────────────────
def test_retry_failed_line_never_touches_other_lines(monkeypatch):
    _enable_all(monkeypatch)
    client, store = _make_client()
    job_id, cid, slug = _complete_dialog_job_and_save(client)
    client.post(f"/api/studio/book-factory/jobs/{job_id}/conversation-audio/{cid}/init",
               json={"voiceAssignments": {"Dara": "v1", "Maya": "v2"}})
    job = client.get(f"/api/studio/book-factory/jobs/{job_id}").json()["job"]
    order = job["conversationAudio"][cid]["lineOrder"]
    line0, line1 = order[0], order[1]

    async def flaky_line(*, text, voice_id, **kw):
        raise HTTPException(status_code=500, detail="upstream 500")
    monkeypatch.setattr(store, "run_conversation_line", flaky_line)

    r = client.post(f"/api/studio/book-factory/jobs/{job_id}/conversation-audio/{cid}/lines/{line0}/generate")
    assert r.json()["result"]["state"] == S_FAILED_RETRYABLE

    retry = client.post(f"/api/studio/book-factory/jobs/{job_id}/conversation-audio/{cid}/lines/{line0}/retry")
    assert retry.status_code == 200
    conv = retry.json()["job"]["conversationAudio"][cid]
    assert conv["lines"][line0]["state"] == S_PENDING
    assert conv["lines"][line1]["state"] == S_PENDING  # never touched — was already pending, still is


def test_retry_rejects_a_line_that_is_not_eligible(monkeypatch):
    _enable_all(monkeypatch)
    client, store = _make_client()
    job_id, cid, slug = _complete_dialog_job_and_save(client)
    client.post(f"/api/studio/book-factory/jobs/{job_id}/conversation-audio/{cid}/init",
               json={"voiceAssignments": {"Dara": "v1", "Maya": "v2"}})
    line_id = client.get(f"/api/studio/book-factory/jobs/{job_id}").json()["job"]["conversationAudio"][cid]["lineOrder"][0]
    r = client.post(f"/api/studio/book-factory/jobs/{job_id}/conversation-audio/{cid}/lines/{line_id}/retry")
    assert r.status_code == 409  # still pending — not retry-eligible


# ── error classification: not everything is retryable ──────────────────────
def test_terminal_status_400_is_not_retryable(monkeypatch):
    _enable_all(monkeypatch)
    client, store = _make_client()
    job_id, cid, slug = _complete_dialog_job_and_save(client)
    client.post(f"/api/studio/book-factory/jobs/{job_id}/conversation-audio/{cid}/init",
               json={"voiceAssignments": {"Dara": "v1", "Maya": "v2"}})
    line_id = client.get(f"/api/studio/book-factory/jobs/{job_id}").json()["job"]["conversationAudio"][cid]["lineOrder"][0]

    async def bad_request(*, text, voice_id, **kw):
        raise HTTPException(status_code=400, detail="bad line text")
    monkeypatch.setattr(store, "run_conversation_line", bad_request)

    r = client.post(f"/api/studio/book-factory/jobs/{job_id}/conversation-audio/{cid}/lines/{line_id}/generate")
    assert r.json()["result"]["state"] == "failed_terminal"
    retry = client.post(f"/api/studio/book-factory/jobs/{job_id}/conversation-audio/{cid}/lines/{line_id}/retry")
    assert retry.status_code == 409  # terminal is NOT manually retryable


def test_unclassified_exception_is_unknown_outcome_not_silently_retryable(monkeypatch):
    _enable_all(monkeypatch)
    client, store = _make_client()
    job_id, cid, slug = _complete_dialog_job_and_save(client)
    client.post(f"/api/studio/book-factory/jobs/{job_id}/conversation-audio/{cid}/init",
               json={"voiceAssignments": {"Dara": "v1", "Maya": "v2"}})
    line_id = client.get(f"/api/studio/book-factory/jobs/{job_id}").json()["job"]["conversationAudio"][cid]["lineOrder"][0]

    async def weird_failure(*, text, voice_id, **kw):
        raise ValueError("totally unexpected")
    monkeypatch.setattr(store, "run_conversation_line", weird_failure)

    r = client.post(f"/api/studio/book-factory/jobs/{job_id}/conversation-audio/{cid}/lines/{line_id}/generate")
    assert r.json()["result"]["state"] == "unknown_outcome"


def test_line_storage_failure_does_not_repeat_the_paid_provider_call(monkeypatch):
    _enable_all(monkeypatch)
    client, store = _make_client()
    job_id, cid, slug = _complete_dialog_job_and_save(client)
    client.post(f"/api/studio/book-factory/jobs/{job_id}/conversation-audio/{cid}/init",
               json={"voiceAssignments": {"Dara": "v1", "Maya": "v2"}})
    line_id = client.get(f"/api/studio/book-factory/jobs/{job_id}").json()["job"]["conversationAudio"][cid]["lineOrder"][0]

    attempts = {"n": 0}
    async def flaky_store(job_id_, chapter_id_, line_id_, attempt_id_, audio_bytes):
        attempts["n"] += 1
        if attempts["n"] < 2:
            raise ConnectionError("transient R2 blip")
        return "https://x/line0.mp3"
    monkeypatch.setattr(bf_conv, "store_line_audio", flaky_store)

    r = client.post(f"/api/studio/book-factory/jobs/{job_id}/conversation-audio/{cid}/lines/{line_id}/generate")
    assert r.json()["result"]["status"] == "completed"
    assert len(store.conversation_line_calls) == 1  # provider paid for exactly once
    assert attempts["n"] == 2  # upload retried once, then succeeded


# ── assembly: gated on completeness, reuses stored audio ───────────────────
def test_assembly_blocked_until_every_line_is_completed(monkeypatch):
    _enable_all(monkeypatch)
    client, store = _make_client()
    job_id, cid, slug = _complete_dialog_job_and_save(client)
    client.post(f"/api/studio/book-factory/jobs/{job_id}/conversation-audio/{cid}/init",
               json={"voiceAssignments": {"Dara": "v1", "Maya": "v2"}})
    job = client.get(f"/api/studio/book-factory/jobs/{job_id}").json()["job"]
    line0 = job["conversationAudio"][cid]["lineOrder"][0]
    client.post(f"/api/studio/book-factory/jobs/{job_id}/conversation-audio/{cid}/lines/{line0}/generate")

    r = client.post(f"/api/studio/book-factory/jobs/{job_id}/conversation-audio/{cid}/assemble")
    assert r.status_code == 409
    assert len(store.assembly_calls) == 0


def test_assembly_succeeds_after_all_lines_complete_and_saves_a_revision(monkeypatch):
    _enable_all(monkeypatch)
    client, store = _make_client()
    job_id, cid, slug = _complete_dialog_job_and_save(client)
    client.post(f"/api/studio/book-factory/jobs/{job_id}/conversation-audio/{cid}/init",
               json={"voiceAssignments": {"Dara": "v1", "Maya": "v2"}})
    job = client.get(f"/api/studio/book-factory/jobs/{job_id}").json()["job"]
    order = job["conversationAudio"][cid]["lineOrder"]

    async def fake_fetch(url, **kw):
        return b"stitched-fake-bytes"
    monkeypatch.setattr(bf_conv, "fetch_line_audio_bytes", fake_fetch)

    for lid in order:
        r = client.post(f"/api/studio/book-factory/jobs/{job_id}/conversation-audio/{cid}/lines/{lid}/generate")
        assert r.json()["result"]["status"] == "completed"

    rev_before = len(store.revisions[slug])
    r = client.post(f"/api/studio/book-factory/jobs/{job_id}/conversation-audio/{cid}/assemble")
    assert r.status_code == 200
    assert r.json()["result"]["status"] == "completed"
    assert len(store.assembly_calls) == 1
    assert store.assembly_calls[0]["lineCount"] == len(order)
    assert len(store.revisions[slug]) == rev_before + 1  # exactly one new revision
    # assembly must NOT call the per-line provider again
    assert len(store.conversation_line_calls) == len(order)


def test_assembly_is_not_re_run_once_completed(monkeypatch):
    _enable_all(monkeypatch)
    client, store = _make_client()
    job_id, cid, slug = _complete_dialog_job_and_save(client)
    client.post(f"/api/studio/book-factory/jobs/{job_id}/conversation-audio/{cid}/init",
               json={"voiceAssignments": {"Dara": "v1", "Maya": "v2"}})
    job = client.get(f"/api/studio/book-factory/jobs/{job_id}").json()["job"]
    order = job["conversationAudio"][cid]["lineOrder"]

    async def fake_fetch(url, **kw):
        return b"stitched-fake-bytes"
    monkeypatch.setattr(bf_conv, "fetch_line_audio_bytes", fake_fetch)
    for lid in order:
        client.post(f"/api/studio/book-factory/jobs/{job_id}/conversation-audio/{cid}/lines/{lid}/generate")

    client.post(f"/api/studio/book-factory/jobs/{job_id}/conversation-audio/{cid}/assemble")
    r2 = client.post(f"/api/studio/book-factory/jobs/{job_id}/conversation-audio/{cid}/assemble")
    assert r2.json()["result"]["status"] == "skipped"
    assert len(store.assembly_calls) == 1  # not assembled twice


# ── regression: existing manual all-at-once route is untouched ────────────
# server.py cannot be imported in this test process (it eagerly requires the
# full production dependency/env set — pywebpush, MONGO_URL, etc. — which
# this test environment intentionally does not provide). Verified instead by
# source inspection, the same convention already used elsewhere in this repo
# for structural-only checks (see src/studio/__tests__/conversationVoiceStudio
# on the frontend side).
def test_manual_conversation_route_and_function_are_structurally_untouched():
    import pathlib
    src = pathlib.Path(__file__).resolve().parent.parent.joinpath("server.py").read_text(encoding="utf-8")
    # The original route + its extracted core function still exist, unrenamed.
    assert "async def run_conversation_for_chapter(" in src
    assert '@api.post("/studio/books/{slug}/conversation")' in src
    assert "async def studio_conversation_generate(" in src
    # The NEW Phase E sibling functions are additive, not replacements.
    assert "async def run_conversation_line(" in src
    assert "async def assemble_conversation_for_chapter(" in src
    # The thin wrapper route still delegates to the untouched core function.
    assert "return await run_conversation_for_chapter(" in src
