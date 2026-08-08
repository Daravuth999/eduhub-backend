"""tests/test_video_narration_routes.py
=========================================
Route-level tests for the Video AI Narration production engine's
visibility/enabled gate (video_narration_tools.py's narration_visible/
narration_enabled/_need_enabled), mirroring test_book_factory_routes.py's
established pattern exactly: FastAPI TestClient + fake admin dependency +
the in-memory fake DB from test_video_narration_tools.py.

Verifies the fail-closed contract explicitly required for this feature:
until VIDEO_NARRATION_ENABLED=true, every narration action route 503s
(never silently no-ops, never partially executes), while the status route
itself always reports the real flag state so Author Studio can decide
whether to even render the Voice Production stage.
"""
from __future__ import annotations

import pytest
from fastapi import APIRouter, FastAPI, HTTPException
from fastapi.testclient import TestClient

import video_narration_tools as vnt
from tests.test_video_narration_tools import _FakeDB, _lesson_getter, _sync_getter


async def _admin_dep():
    return {"email": "admin@test"}


def _make_client(db=None):
    app = FastAPI()
    api = APIRouter(prefix="/api")
    vnt.register_video_narration_routes(
        api, db or _FakeDB(), _admin_dep,
        lesson_getter=_lesson_getter, sync_getter=_sync_getter,
    )
    app.include_router(api)
    return TestClient(app)


@pytest.fixture(autouse=True)
def _clear_flags(monkeypatch):
    monkeypatch.delenv("VIDEO_NARRATION_VISIBLE", raising=False)
    monkeypatch.delenv("VIDEO_NARRATION_ENABLED", raising=False)
    monkeypatch.delenv("GEMINI_API_KEY", raising=False)
    monkeypatch.delenv("ELEVENLABS_API_KEY", raising=False)
    monkeypatch.delenv("R2_ACCOUNT_ID", raising=False)


# ── status accuracy across all four (visible, enabled) combos, matching
# Book Factory's own status-accuracy test exactly ─────────────────────────
@pytest.mark.parametrize("visible,enabled", [
    (False, False), (True, False), (False, True), (True, True),
])
def test_status_reports_flags_even_while_disabled(monkeypatch, visible, enabled):
    monkeypatch.setenv("VIDEO_NARRATION_VISIBLE", "true" if visible else "false")
    monkeypatch.setenv("VIDEO_NARRATION_ENABLED", "true" if enabled else "false")
    client = _make_client()
    r = client.get("/api/studio/video-factory/status")
    assert r.status_code == 200
    body = r.json()
    assert body == {
        "visible": visible, "enabled": enabled,
        "geminiReady": False, "elevenLabsReady": False, "storageReady": False,
        "music": {"supported": False, "reason": body["music"]["reason"]},
        "sfx": {"supported": True, "provider": "elevenlabs", "endpoint": "sound-generation"},
    }


def test_status_reports_provider_readiness_when_keys_present(monkeypatch):
    monkeypatch.setenv("GEMINI_API_KEY", "test-key")
    monkeypatch.setenv("ELEVENLABS_API_KEY", "test-key")
    for k in ("R2_ACCOUNT_ID", "R2_ACCESS_KEY_ID", "R2_SECRET_ACCESS_KEY", "R2_BUCKET_NAME", "R2_PUBLIC_URL"):
        monkeypatch.setenv(k, "x")
    client = _make_client()
    body = client.get("/api/studio/video-factory/status").json()
    assert body["geminiReady"] is True
    assert body["elevenLabsReady"] is True
    assert body["storageReady"] is True


# ── every action route 503s while disabled — never a silent no-op ─────────
@pytest.mark.parametrize("method,path", [
    ("get", "/api/studio/video/lessons/vid_1/narration"),
    ("post", "/api/studio/video/lessons/vid_1/narration/story-analysis/run"),
    ("post", "/api/studio/video/lessons/vid_1/narration/script-blueprint/run"),
    ("patch", "/api/studio/video/lessons/vid_1/narration/script-blueprint"),
    ("put", "/api/studio/video/lessons/vid_1/narration/voice-assignments"),
    ("post", "/api/studio/video/lessons/vid_1/narration/voice-production/sc_1/ln_1/generate"),
    ("post", "/api/studio/video/lessons/vid_1/narration/voice-production/sc_1/ln_1/reset"),
    ("post", "/api/studio/video/lessons/vid_1/narration/assemble"),
    ("post", "/api/studio/video/lessons/vid_1/narration/render"),
    ("post", "/api/studio/video/lessons/vid_1/narration/publish"),
    ("post", "/api/studio/video/lessons/vid_1/narration/unpublish"),
])
def test_every_narration_route_503s_while_disabled(monkeypatch, method, path):
    monkeypatch.setenv("VIDEO_NARRATION_ENABLED", "false")
    client = _make_client()
    kwargs = {"json": {}} if method in ("patch", "put") else {}
    r = getattr(client, method)(path, **kwargs)
    assert r.status_code == 503
    assert "disabled" in r.json()["detail"].lower()


def test_narration_status_route_works_once_enabled(monkeypatch):
    monkeypatch.setenv("VIDEO_NARRATION_ENABLED", "true")
    client = _make_client()
    r = client.get("/api/studio/video/lessons/vid_1/narration")
    assert r.status_code == 200
    assert r.json()["job"]["lessonId"] == "vid_1"


def test_status_route_never_gated_by_enabled_itself(monkeypatch):
    """The status route must always be readable (even while enabled=false)
    so Author Studio can decide whether to show the Voice Production stage
    at all — it must never itself 503."""
    monkeypatch.setenv("VIDEO_NARRATION_ENABLED", "false")
    client = _make_client()
    r = client.get("/api/studio/video-factory/status")
    assert r.status_code == 200
