"""tests/test_book_factory_routes.py
=====================================
Route-level tests: admin gating, fail-closed flag behaviour on every
generation route, accurate status while disabled, and the happy-path
create → step → export flow.  Uses FastAPI TestClient with a fake admin
dependency and the in-memory fake DB from test_book_factory_jobs.

NO real Gemini — book_factory_gemini is monkeypatched.
"""
from __future__ import annotations

import copy

import pytest
from fastapi import APIRouter, FastAPI, HTTPException
from fastapi.testclient import TestClient

import book_factory_gemini as bf_gemini
import book_factory_jobs as bfj
from tests.test_book_factory_jobs import _DB, _GOOD_CHAPTER


async def _admin_dep():
    return {"email": "admin@test"}


async def _nonadmin_dep():
    raise HTTPException(status_code=403, detail="Admin access required")


def _make_client(db=None, admin=True):
    app = FastAPI()
    api = APIRouter(prefix="/api")
    bfj.register_book_factory_routes(api, db or _DB(), _admin_dep if admin else _nonadmin_dep)
    app.include_router(api)
    return TestClient(app)


def _enable_all(monkeypatch):
    monkeypatch.setenv("BOOK_FACTORY_VISIBLE", "true")
    monkeypatch.setenv("BOOK_FACTORY_ENABLED", "true")
    monkeypatch.setenv("BOOK_FACTORY_GEMINI_ENABLED", "true")
    monkeypatch.setenv("GEMINI_API_KEY", "test-key")


# ── status accuracy across all four (visible, enabled) combos ─────────────
@pytest.mark.parametrize("visible,enabled", [
    (False, False), (True, False), (False, True), (True, True),
])
def test_status_reports_flags_even_while_disabled(monkeypatch, visible, enabled):
    monkeypatch.setenv("BOOK_FACTORY_VISIBLE", "true" if visible else "false")
    monkeypatch.setenv("BOOK_FACTORY_ENABLED", "true" if enabled else "false")
    monkeypatch.setenv("BOOK_FACTORY_GEMINI_ENABLED", "false")
    monkeypatch.delenv("GEMINI_API_KEY", raising=False)
    client = _make_client()
    r = client.get("/api/studio/book-factory/status")
    assert r.status_code == 200
    body = r.json()
    # Phase 2-4 additive flags default false regardless of the core
    # visible/enabled/geminiEnabled combination under test here.
    assert body == {
        "visible": visible, "enabled": enabled, "geminiEnabled": False,
        "coverEnabled": False, "coverProviderReady": False, "coverStorageReady": False,
        "narrationEnabled": False, "conversationAudioEnabled": False,
        "conversationAudioStorageReady": False,
        "directPublishEnabled": False,
    }


def test_status_gemini_enabled_requires_flag_and_key(monkeypatch):
    monkeypatch.setenv("BOOK_FACTORY_VISIBLE", "true")
    monkeypatch.setenv("BOOK_FACTORY_ENABLED", "true")
    monkeypatch.setenv("BOOK_FACTORY_GEMINI_ENABLED", "true")
    monkeypatch.delenv("GEMINI_API_KEY", raising=False)
    assert _make_client().get("/api/studio/book-factory/status").json()["geminiEnabled"] is False
    monkeypatch.setenv("GEMINI_API_KEY", "k")
    assert _make_client().get("/api/studio/book-factory/status").json()["geminiEnabled"] is True


# ── admin gating ────────────────────────────────────────────────────────────
@pytest.mark.parametrize("method,path", [
    ("get", "/api/studio/book-factory/status"),
    ("post", "/api/studio/book-factory/jobs"),
    ("get", "/api/studio/book-factory/jobs/x"),
    ("post", "/api/studio/book-factory/jobs/x/step"),
    ("post", "/api/studio/book-factory/jobs/x/chapters/c/retry"),
    ("get", "/api/studio/book-factory/jobs/x/export"),
])
def test_non_admin_rejected(monkeypatch, method, path):
    _enable_all(monkeypatch)
    client = _make_client(admin=False)
    r = getattr(client, method)(path) if method == "get" else getattr(client, method)(path, json={})
    assert r.status_code == 403


# ── fail-closed on every generation route ──────────────────────────────────
_GEN_ROUTES = [
    ("post", "/api/studio/book-factory/jobs", {"config": {"title": "T"}}),
    ("post", "/api/studio/book-factory/jobs/x/step", {"stage": "blueprint"}),
    ("post", "/api/studio/book-factory/jobs/x/chapters/c/retry", {}),
]


@pytest.mark.parametrize("method,path,body", _GEN_ROUTES)
def test_fail_closed_when_disabled(monkeypatch, method, path, body):
    _enable_all(monkeypatch)
    monkeypatch.setenv("BOOK_FACTORY_ENABLED", "false")
    r = getattr(_make_client(), method)(path, json=body)
    assert r.status_code == 503


@pytest.mark.parametrize("method,path,body", _GEN_ROUTES)
def test_fail_closed_when_gemini_flag_off(monkeypatch, method, path, body):
    _enable_all(monkeypatch)
    monkeypatch.setenv("BOOK_FACTORY_GEMINI_ENABLED", "false")
    r = getattr(_make_client(), method)(path, json=body)
    assert r.status_code == 503


@pytest.mark.parametrize("method,path,body", _GEN_ROUTES)
def test_fail_closed_when_key_missing(monkeypatch, method, path, body):
    _enable_all(monkeypatch)
    monkeypatch.delenv("GEMINI_API_KEY", raising=False)
    r = getattr(_make_client(), method)(path, json=body)
    assert r.status_code == 503


# ── happy path: create → blueprint → chapter → export ──────────────────────
def test_full_flow_export_is_unpublished_and_preserves_tier_price(monkeypatch):
    _enable_all(monkeypatch)

    async def fake_bp(config):
        return {"bookTitle": "B", "summary": "s", "chapters": [{"title": "One", "outline": "o"}]}

    async def fake_chapter(config, spec):
        return copy.deepcopy(_GOOD_CHAPTER)

    monkeypatch.setattr(bf_gemini, "generate_blueprint", fake_bp)
    monkeypatch.setattr(bf_gemini, "generate_chapter", fake_chapter)

    db = _DB()
    client = _make_client(db=db)

    r = client.post("/api/studio/book-factory/jobs",
                    json={"config": {"title": "B", "topic": "Daily life", "section": "story",
                                     "level": "A2", "pedagogyProfile": "general_english",
                                     "mode": "simple", "readingMinutes": 6,
                                     "minWordsPerChapter": 120, "maxWordsPerChapter": 320,
                                     "tier": "premium", "price": 333, "chapterCount": 1}})
    assert r.status_code == 200
    job_id = r.json()["job"]["jobId"]

    r = client.post(f"/api/studio/book-factory/jobs/{job_id}/step", json={"stage": "blueprint"})
    assert r.json()["result"]["status"] == "completed"
    order = r.json()["job"]["chapterOrder"]
    assert len(order) == 1

    # §HIGH 8: chapter generation is blocked until the blueprint is approved.
    cid = order[0]
    blocked = client.post(f"/api/studio/book-factory/jobs/{job_id}/step", json={"chapterId": cid})
    assert blocked.status_code == 409 and blocked.json()["detail"] == "blueprint_not_approved"

    ap = client.post(f"/api/studio/book-factory/jobs/{job_id}/approve")
    assert ap.status_code == 200 and ap.json()["job"]["blueprintApprovedAt"]

    r = client.post(f"/api/studio/book-factory/jobs/{job_id}/step", json={"chapterId": cid})
    assert r.json()["result"]["status"] == "completed"

    r = client.get(f"/api/studio/book-factory/jobs/{job_id}/export")
    book = r.json()["book"]
    assert book["published"] is False
    assert book["tier"] == "premium" and book["price"] == 333
    assert "evidenceQuote" not in repr(book)
    # only Phase 1 block types present
    for ch in book["chapters"]:
        for blk in ch["blocks"]:
            assert blk["type"] in {"heading", "paragraph", "quote", "markdown", "dialog", "mcq", "fillblank"}


def test_create_job_requires_valid_config(monkeypatch):
    _enable_all(monkeypatch)
    r = _make_client().post("/api/studio/book-factory/jobs", json={"config": {}})
    assert r.status_code == 422
