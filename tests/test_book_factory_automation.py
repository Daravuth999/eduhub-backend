"""tests/test_book_factory_automation.py
==========================================
Phase 2-4 automation tests: AI cover generation, server-side save-draft/
publish binding, chapterId-keyed narration automation, and the synced-words
transform. NO real Gemini image / ElevenLabs / R2 calls — every provider and
storage seam is monkeypatched.

Covers the required test list from the "FINAL ARCHITECTURE AMENDMENTS":
  - narration uses chapterId, not array position
  - another admin's saved book cannot be linked/narrated
  - title collision does not revise an unrelated book (deterministic slug)
  - a lost/idempotent save-draft response recovers rather than duplicating
  - a deterministic cover object is reused instead of re-calling Gemini after
    a transient completion-write failure
  - storage failure does not automatically repeat a Gemini image call
  - synced-words transform is idempotent and preserves word coverage/order
  - all new flags default false (covered in test_book_factory_routes.py)
"""
from __future__ import annotations

import copy

import pytest
from fastapi import APIRouter, FastAPI, HTTPException
from fastapi.testclient import TestClient

import book_factory_gemini as bf_gemini
import book_factory_image as bf_image
import book_factory_jobs as bfj
import book_factory_narration as bf_narration
from book_factory_jobs import BFRetryableError, BFTerminalError, BFUnknownOutcomeError
from tests.test_book_factory_jobs import _DB, _GOOD_CHAPTER


def _admin_dep_for(email):
    async def _dep():
        return {"email": email}
    return _dep


class _FakeBookStore:
    """Minimal in-memory stand-in for db.books, driven through the SAME
    injected callables server.py provides in production (save_book_revision /
    publish_book / get_book_by_slug / run_elevenlabs_for_chapter) — proves
    book_factory_jobs.py never needs direct db.books access."""

    def __init__(self):
        self.revisions: dict[str, list[dict]] = {}
        self.save_calls = 0
        self.publish_calls = []
        self.narrate_calls = []

    async def save_book_revision(self, payload_dict: dict, admin_email: str) -> dict:
        self.save_calls += 1
        slug = payload_dict.get("slug") or "untitled"
        revs = self.revisions.setdefault(slug, [])
        next_rev = len(revs) + 1
        doc = {**payload_dict, "slug": slug, "revision": next_rev,
               "_authoredBy": admin_email, "published": bool(payload_dict.get("published", False))}
        revs.append(doc)
        return {"success": True, "slug": slug, "revision": next_rev, "book": doc}

    async def publish_book(self, slug: str) -> dict:
        self.publish_calls.append(slug)
        revs = self.revisions.get(slug) or []
        for r in revs:
            r["published"] = True
        return {"success": True, "matched": len(revs), "modified": len(revs)}

    async def get_book_by_slug(self, slug: str):
        revs = self.revisions.get(slug) or []
        return copy.deepcopy(revs[-1]) if revs else None

    async def run_elevenlabs_for_chapter(self, *, slug, chapter_index, raw_voice,
                                          book_in, admin_email):
        self.narrate_calls.append({"slug": slug, "chapterIndex": chapter_index, "voice": raw_voice})
        book = book_in or await self.get_book_by_slug(slug)
        if not book:
            raise HTTPException(status_code=404, detail="Book not found.")
        chapters = book.get("chapters", [])
        if chapter_index >= len(chapters):
            raise HTTPException(status_code=400, detail="Chapter index out of range.")
        # simulate the real route: append an audio block + bump revision
        new_chapters = copy.deepcopy(chapters)
        new_chapters[chapter_index]["blocks"].append({"type": "audio", "text": "https://x/a.mp3"})
        payload = {**book, "chapters": new_chapters, "slug": slug}
        result = await self.save_book_revision(payload, admin_email)
        return {"success": True, "slug": slug, "chapterIndex": chapter_index,
                "wordCount": 12, "revision": result["revision"], "voice": raw_voice or "default"}


def _make_client(db=None, email="admin-a@test", store=None):
    app = FastAPI()
    api = APIRouter(prefix="/api")
    store = store or _FakeBookStore()
    bfj.register_book_factory_routes(
        api, db or _DB(), _admin_dep_for(email),
        save_book_revision=store.save_book_revision,
        publish_book=store.publish_book,
        run_elevenlabs_for_chapter=store.run_elevenlabs_for_chapter,
        get_book_by_slug=store.get_book_by_slug,
    )
    app.include_router(api)
    return TestClient(app), store


def _enable_all(monkeypatch):
    monkeypatch.setenv("BOOK_FACTORY_VISIBLE", "true")
    monkeypatch.setenv("BOOK_FACTORY_ENABLED", "true")
    monkeypatch.setenv("BOOK_FACTORY_GEMINI_ENABLED", "true")
    monkeypatch.setenv("GEMINI_API_KEY", "test-key")


def _complete_one_chapter_job(client, title="B", price=333, tier="premium"):
    r = client.post("/api/studio/book-factory/jobs",
                    json={"config": {"title": title, "topic": "Daily life", "section": "story",
                                     "level": "A2", "pedagogyProfile": "general_english",
                                     "mode": "simple", "readingMinutes": 6,
                                     "minWordsPerChapter": 120, "maxWordsPerChapter": 320,
                                     "tier": tier, "price": price, "chapterCount": 1}})
    assert r.status_code == 200, r.text
    job_id = r.json()["job"]["jobId"]
    r = client.post(f"/api/studio/book-factory/jobs/{job_id}/step", json={"stage": "blueprint"})
    cid = r.json()["job"]["chapterOrder"][0]
    client.post(f"/api/studio/book-factory/jobs/{job_id}/approve")
    r = client.post(f"/api/studio/book-factory/jobs/{job_id}/step", json={"chapterId": cid})
    assert r.json()["result"]["status"] == "completed"
    return job_id, cid


@pytest.fixture(autouse=True)
def _fake_gemini_text(monkeypatch):
    async def fake_bp(config):
        return {"bookTitle": "B", "summary": "s", "chapters": [{"title": "One", "outline": "o"}]}

    async def fake_chapter(config, spec):
        return copy.deepcopy(_GOOD_CHAPTER)

    monkeypatch.setattr(bf_gemini, "generate_blueprint", fake_bp)
    monkeypatch.setattr(bf_gemini, "generate_chapter", fake_chapter)


# ── Save-draft: deterministic slug, idempotent recovery, no duplication ────
def test_save_draft_mints_a_bound_slug_and_persists_it(monkeypatch):
    _enable_all(monkeypatch)
    client, store = _make_client()
    job_id, _cid = _complete_one_chapter_job(client)

    r = client.post(f"/api/studio/book-factory/jobs/{job_id}/save-draft")
    assert r.status_code == 200, r.text
    body = r.json()
    assert body["slug"]
    assert body["revision"] == 1
    assert store.save_calls == 1
    assert store.revisions[body["slug"]][0]["published"] is False


def test_two_jobs_with_the_same_title_never_collide(monkeypatch):
    _enable_all(monkeypatch)
    client, store = _make_client()
    job_id_a, _ = _complete_one_chapter_job(client, title="Same Title")
    job_id_b, _ = _complete_one_chapter_job(client, title="Same Title")

    ra = client.post(f"/api/studio/book-factory/jobs/{job_id_a}/save-draft").json()
    rb = client.post(f"/api/studio/book-factory/jobs/{job_id_b}/save-draft").json()
    assert ra["slug"] != rb["slug"]
    # neither book "revises" the other — each has exactly its own revision 1
    assert len(store.revisions[ra["slug"]]) == 1
    assert len(store.revisions[rb["slug"]]) == 1


def test_repeat_save_draft_with_unchanged_content_recovers_not_duplicates(monkeypatch):
    _enable_all(monkeypatch)
    client, store = _make_client()
    job_id, _cid = _complete_one_chapter_job(client)

    r1 = client.post(f"/api/studio/book-factory/jobs/{job_id}/save-draft").json()
    assert store.save_calls == 1
    # Simulate a lost HTTP response: client retries the exact same request.
    r2 = client.post(f"/api/studio/book-factory/jobs/{job_id}/save-draft").json()
    assert r2["recovered"] is True
    assert r2["slug"] == r1["slug"]
    assert r2["revision"] == r1["revision"]
    assert store.save_calls == 1  # no duplicate revision written
    assert len(store.revisions[r1["slug"]]) == 1


def test_save_draft_after_cover_completes_creates_new_revision_under_same_slug(monkeypatch):
    _enable_all(monkeypatch)
    monkeypatch.setenv("BOOK_FACTORY_COVER_ENABLED", "true")
    monkeypatch.setattr(bf_image, "is_enabled", lambda: True)

    async def fake_cover(**kwargs):
        return {"url": "https://covers/x.png", "mimeType": "image/png"}
    monkeypatch.setattr(bf_image, "generate_and_store_cover", fake_cover)

    client, store = _make_client()
    job_id, _cid = _complete_one_chapter_job(client)
    r1 = client.post(f"/api/studio/book-factory/jobs/{job_id}/save-draft").json()

    cov = client.post(f"/api/studio/book-factory/jobs/{job_id}/cover/generate")
    assert cov.json()["result"]["status"] == "completed"

    r2 = client.post(f"/api/studio/book-factory/jobs/{job_id}/save-draft").json()
    assert r2["recovered"] is False
    assert r2["slug"] == r1["slug"]
    assert r2["revision"] == 2
    assert store.revisions[r1["slug"]][-1]["coverImage"] == "https://covers/x.png"


# ── Publish: server-bound slug only, requires a prior save ────────────────
def test_publish_requires_save_draft_first(monkeypatch):
    _enable_all(monkeypatch)
    client, _store = _make_client()
    job_id, _cid = _complete_one_chapter_job(client)
    r = client.post(f"/api/studio/book-factory/jobs/{job_id}/publish")
    assert r.status_code == 409


def test_publish_uses_the_server_bound_slug(monkeypatch):
    _enable_all(monkeypatch)
    client, store = _make_client()
    job_id, _cid = _complete_one_chapter_job(client)
    saved = client.post(f"/api/studio/book-factory/jobs/{job_id}/save-draft").json()
    r = client.post(f"/api/studio/book-factory/jobs/{job_id}/publish")
    assert r.status_code == 200
    assert store.publish_calls == [saved["slug"]]
    assert store.revisions[saved["slug"]][-1]["published"] is True


# ── Narration: chapterId identity, ownership, saved-binding requirement ────
def test_narration_requires_save_draft_first(monkeypatch):
    _enable_all(monkeypatch)
    monkeypatch.setenv("BOOK_FACTORY_NARRATION_ENABLED", "true")
    client, _store = _make_client()
    job_id, cid = _complete_one_chapter_job(client)
    r = client.post(f"/api/studio/book-factory/jobs/{job_id}/narration/{cid}", json={"voice": "v"})
    assert r.status_code == 409


def test_narration_rejects_unknown_chapter_id(monkeypatch):
    _enable_all(monkeypatch)
    monkeypatch.setenv("BOOK_FACTORY_NARRATION_ENABLED", "true")
    client, _store = _make_client()
    job_id, _cid = _complete_one_chapter_job(client)
    client.post(f"/api/studio/book-factory/jobs/{job_id}/save-draft")
    r = client.post(f"/api/studio/book-factory/jobs/{job_id}/narration/not_a_real_chapter_id",
                    json={"voice": "v"})
    assert r.status_code == 404


def test_narration_resolves_chapter_id_to_saved_index_not_job_position(monkeypatch):
    """The job's internal chapter `position` and the SAVED book's array index
    can diverge (e.g. an earlier chapter failed and was excluded from export).
    Narration must resolve through chapterIdToSavedIndex, not `position`."""
    _enable_all(monkeypatch)
    monkeypatch.setenv("BOOK_FACTORY_NARRATION_ENABLED", "true")
    client, store = _make_client()

    # Build a 2-chapter job where chapter 0 fails permanently, so only
    # chapter 1 (job position=1) survives into the saved book at index 0.
    async def fake_bp_two(config):
        return {"bookTitle": "B", "summary": "s",
                "chapters": [{"title": "One", "outline": "o"}, {"title": "Two", "outline": "o2"}]}
    monkeypatch.setattr(bf_gemini, "generate_blueprint", fake_bp_two)

    r = client.post("/api/studio/book-factory/jobs",
                    json={"config": {"title": "Two Chapters", "topic": "t", "section": "story",
                                     "level": "A2", "pedagogyProfile": "general_english",
                                     "mode": "simple", "readingMinutes": 6,
                                     "minWordsPerChapter": 120, "maxWordsPerChapter": 320,
                                     "tier": "free", "price": 0, "chapterCount": 2}})
    job_id = r.json()["job"]["jobId"]
    r = client.post(f"/api/studio/book-factory/jobs/{job_id}/step", json={"stage": "blueprint"})
    order = r.json()["job"]["chapterOrder"]
    assert len(order) == 2
    client.post(f"/api/studio/book-factory/jobs/{job_id}/approve")

    # Chapter 0 (position 0) fails terminally: force empty blocks forever.
    async def fake_chapter_fails(config, spec):
        return {"title": spec.get("title"), "paragraphs": "not-a-list"}  # composes to zero blocks
    bf_gemini.generate_chapter = fake_chapter_fails  # type: ignore
    client.post(f"/api/studio/book-factory/jobs/{job_id}/step", json={"chapterId": order[0]})
    client.post(f"/api/studio/book-factory/jobs/{job_id}/step", json={"chapterId": order[0]})  # exhaust retry

    # Chapter 1 (position 1) succeeds normally.
    async def fake_chapter_ok(config, spec):
        return copy.deepcopy(_GOOD_CHAPTER)
    bf_gemini.generate_chapter = fake_chapter_ok  # type: ignore
    r = client.post(f"/api/studio/book-factory/jobs/{job_id}/step", json={"chapterId": order[1]})
    assert r.json()["result"]["status"] == "completed"

    saved = client.post(f"/api/studio/book-factory/jobs/{job_id}/save-draft").json()
    assert saved["job"]["chapterIdToSavedIndex"][order[1]] == 0  # only survivor → saved index 0

    r = client.post(f"/api/studio/book-factory/jobs/{job_id}/narration/{order[1]}", json={"voice": "v1"})
    assert r.json()["result"]["status"] == "completed"
    assert store.narrate_calls[-1]["chapterIndex"] == 0  # resolved via the map, not job position (1)


def test_another_admins_job_cannot_be_narrated(monkeypatch):
    _enable_all(monkeypatch)
    monkeypatch.setenv("BOOK_FACTORY_NARRATION_ENABLED", "true")
    db = _DB()
    client_a, store = _make_client(db=db, email="admin-a@test", store=_FakeBookStore())
    job_id, cid = _complete_one_chapter_job(client_a)
    client_a.post(f"/api/studio/book-factory/jobs/{job_id}/save-draft")

    client_b, _store_b = _make_client(db=db, email="admin-b@test", store=store)
    r = client_b.post(f"/api/studio/book-factory/jobs/{job_id}/narration/{cid}", json={"voice": "v"})
    assert r.status_code == 404  # owner-scoped: indistinguishable from "not found"


def test_narration_disabled_by_default(monkeypatch):
    _enable_all(monkeypatch)
    client, _store = _make_client()
    job_id, cid = _complete_one_chapter_job(client)
    client.post(f"/api/studio/book-factory/jobs/{job_id}/save-draft")
    r = client.post(f"/api/studio/book-factory/jobs/{job_id}/narration/{cid}", json={"voice": "v"})
    assert r.status_code == 503


# ── Cover: idempotency, storage-failure isolation, error classification ────
def test_cover_disabled_by_default(monkeypatch):
    _enable_all(monkeypatch)
    client, _store = _make_client()
    job_id, _cid = _complete_one_chapter_job(client)
    r = client.post(f"/api/studio/book-factory/jobs/{job_id}/cover/generate")
    assert r.status_code == 503


def test_cover_success_completes_stage_and_export_uses_it(monkeypatch):
    _enable_all(monkeypatch)
    monkeypatch.setenv("BOOK_FACTORY_COVER_ENABLED", "true")
    monkeypatch.setattr(bf_image, "is_enabled", lambda: True)
    calls = {"n": 0}

    async def fake_cover(**kwargs):
        calls["n"] += 1
        return {"url": "https://covers/y.png", "mimeType": "image/png"}
    monkeypatch.setattr(bf_image, "generate_and_store_cover", fake_cover)

    client, _store = _make_client()
    job_id, _cid = _complete_one_chapter_job(client)
    r = client.post(f"/api/studio/book-factory/jobs/{job_id}/cover/generate")
    assert r.json()["result"]["status"] == "completed"
    assert calls["n"] == 1

    exp = client.get(f"/api/studio/book-factory/jobs/{job_id}/export").json()
    assert exp["book"]["coverImage"] == "https://covers/y.png"


def test_cover_storage_failure_does_not_get_silently_retried_as_success(monkeypatch):
    _enable_all(monkeypatch)
    monkeypatch.setenv("BOOK_FACTORY_COVER_ENABLED", "true")
    monkeypatch.setattr(bf_image, "is_enabled", lambda: True)

    async def failing_cover(**kwargs):
        raise BFTerminalError("R2 is not configured — cover-image storage is unavailable.")
    monkeypatch.setattr(bf_image, "generate_and_store_cover", failing_cover)

    client, _store = _make_client()
    job_id, _cid = _complete_one_chapter_job(client)
    r = client.post(f"/api/studio/book-factory/jobs/{job_id}/cover/generate")
    result = r.json()["result"]
    assert result["status"] == "failed"
    assert result["state"] == "failed_terminal"
    # A failed cover never blocks export — book still exports with no cover URL.
    exp = client.get(f"/api/studio/book-factory/jobs/{job_id}/export").json()
    assert exp["book"]["coverImage"] == ""


def test_cover_completion_write_failure_does_not_trigger_a_second_gemini_call(monkeypatch):
    """§AMENDMENT 3: image succeeds, but persisting completion fails once —
    must retry ONLY the DB write, never call Gemini again."""
    _enable_all(monkeypatch)
    monkeypatch.setenv("BOOK_FACTORY_COVER_ENABLED", "true")
    monkeypatch.setattr(bf_image, "is_enabled", lambda: True)
    calls = {"n": 0}

    async def fake_cover(**kwargs):
        calls["n"] += 1
        return {"url": "https://covers/z.png", "mimeType": "image/png"}
    monkeypatch.setattr(bf_image, "generate_and_store_cover", fake_cover)

    client, _store = _make_client()
    job_id, _cid = _complete_one_chapter_job(client)  # uses the REAL _complete_stage

    real_complete_stage = bfj._complete_stage
    attempts = {"n": 0}

    async def flaky_complete_stage(*a, **kw):
        attempts["n"] += 1
        if attempts["n"] == 1:
            raise ConnectionError("transient mongo blip")
        return await real_complete_stage(*a, **kw)
    monkeypatch.setattr(bfj, "_complete_stage", flaky_complete_stage)

    r = client.post(f"/api/studio/book-factory/jobs/{job_id}/cover/generate")
    assert r.json()["result"]["status"] == "completed"
    assert calls["n"] == 1          # Gemini called exactly once despite the DB blip
    assert attempts["n"] == 2       # completion write retried once, then succeeded


def test_cover_terminal_and_unknown_classification(monkeypatch):
    _enable_all(monkeypatch)
    monkeypatch.setenv("BOOK_FACTORY_COVER_ENABLED", "true")
    monkeypatch.setattr(bf_image, "is_enabled", lambda: True)

    async def unknown_cover(**kwargs):
        raise BFUnknownOutcomeError("ambiguous 5xx")
    monkeypatch.setattr(bf_image, "generate_and_store_cover", unknown_cover)

    client, _store = _make_client()
    job_id, _cid = _complete_one_chapter_job(client)
    r = client.post(f"/api/studio/book-factory/jobs/{job_id}/cover/generate")
    assert r.json()["result"]["state"] == "unknown_outcome"


# ── Synced-words transform: coverage, idempotency, ordering ────────────────
def test_synced_words_converts_only_paragraph_blocks_preserving_order_and_text():
    chapters = [{
        "title": "Ch1",
        "blocks": [
            {"type": "heading", "text": "Intro"},
            {"type": "paragraph", "text": "First sentence."},
            {"type": "quote", "text": "A quote."},
            {"type": "paragraph", "text": "Second sentence."},
            {"type": "mcq", "text": "Q?", "options": ["a", "b"], "answer": "a"},
        ],
    }]
    new_chapters, changed = bf_narration.convert_paragraphs_to_transcript(chapters)
    assert changed is True
    types = [b["type"] for b in new_chapters[0]["blocks"]]
    assert types == ["heading", "transcript", "quote", "transcript", "mcq"]
    # every original word survives exactly once, in order, nothing duplicated
    texts = [b["text"] for b in new_chapters[0]["blocks"]]
    assert texts == ["Intro", "First sentence.", "A quote.", "Second sentence.", "Q?"]
    assert new_chapters[0]["blocks"][1]["_bfTranscriptFromParagraph"] is True
    # original input untouched
    assert chapters[0]["blocks"][1]["type"] == "paragraph"


def test_synced_words_transform_is_idempotent():
    chapters = [{"title": "Ch1", "blocks": [{"type": "paragraph", "text": "Hi."}]}]
    once, changed1 = bf_narration.convert_paragraphs_to_transcript(chapters)
    twice, changed2 = bf_narration.convert_paragraphs_to_transcript(once)
    assert changed1 is True
    assert changed2 is False  # no paragraph blocks left → no-op
    assert once == twice


def test_synced_words_applied_before_narration_produces_new_revision(monkeypatch):
    _enable_all(monkeypatch)
    monkeypatch.setenv("BOOK_FACTORY_NARRATION_ENABLED", "true")
    client, store = _make_client()
    job_id, cid = _complete_one_chapter_job(client)
    saved = client.post(f"/api/studio/book-factory/jobs/{job_id}/save-draft").json()
    slug = saved["slug"]
    assert store.revisions[slug][-1]["chapters"][0]["blocks"][0]["type"] == "paragraph"

    r = client.post(f"/api/studio/book-factory/jobs/{job_id}/narration/{cid}",
                    json={"voice": "v1", "syncedWords": True})
    assert r.json()["result"]["status"] == "completed"
    # two extra revisions: one from the synced-words resave, one from narration
    assert len(store.revisions[slug]) == 3
    assert store.revisions[slug][1]["chapters"][0]["blocks"][0]["type"] == "transcript"
