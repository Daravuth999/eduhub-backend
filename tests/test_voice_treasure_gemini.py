"""tests/test_voice_treasure_gemini.py — fixture-only provider path tests.

NO live provider call. httpx is stubbed; we assert the REAL request shape and
response handling for image generation + multimodal evaluation. Live probe is
out of scope (no key/network) and is reported separately as NOT RUN.
"""
from __future__ import annotations

import asyncio
import base64

import pytest

import voice_treasure_gemini as g


def run(c): return asyncio.run(c)


class _Resp:
    def __init__(self, status, payload): self.status_code = status; self._p = payload
    def json(self): return self._p


class _Client:
    """Fake httpx.AsyncClient capturing the outgoing request."""
    last = {}

    def __init__(self, *a, **k): pass
    async def __aenter__(self): return self
    async def __aexit__(self, *a): return False
    async def post(self, url, params=None, json=None):
        _Client.last = {"url": url, "params": params, "json": json}
        return _Client._next


def _png_b64():
    return base64.b64encode(b"\x89PNG\r\n\x1a\nFAKEIMAGE").decode("ascii")


@pytest.fixture(autouse=True)
def _env(monkeypatch):
    monkeypatch.setenv("GEMINI_API_KEY", "test-key")
    monkeypatch.setenv("VOICE_TREASURE_IMAGE_MODEL", "test-image-model")
    monkeypatch.setenv("VOICE_TREASURE_IMAGE_GENERATION_ENABLED", "1")
    monkeypatch.setenv("VOICE_TREASURE_EVAL_MODEL", "test-eval-model")
    monkeypatch.setattr(g, "httpx", _fake_httpx())
    yield


def _fake_httpx():
    import types as _t
    m = _t.SimpleNamespace()
    m.AsyncClient = _Client
    m.Timeout = lambda *a, **k: None
    return m


# ── image generation ────────────────────────────────────────────────────────
def test_image_generation_disabled_returns_fallback(monkeypatch):
    monkeypatch.setenv("VOICE_TREASURE_IMAGE_GENERATION_ENABLED", "0")
    out = run(g.prepare_mission_image(theme="nature", difficulty="beginner"))
    assert out["outcome"] == g.IMG_FALLBACK
    assert out["image_ref"] == g.FALLBACK_IMAGE_REF


def test_image_generation_success_stores_and_returns_generated():
    _Client._next = _Resp(200, {"candidates": [{"content": {"parts": [
        {"inlineData": {"mimeType": "image/png", "data": _png_b64()}}]}}]})
    stored = {}
    def sink(ref, data, mime):
        stored.update(ref=ref, n=len(data), mime=mime); return f"generated/{ref}.png"
    out = run(g.prepare_mission_image(theme="nature", difficulty="beginner",
                                      store=sink, reference="vt-gen-x"))
    assert out["outcome"] == g.IMG_GENERATED
    assert out["image_kind"] == "generated"
    assert out["image_ref"] == "vt-gen-x"
    assert stored["mime"] == "image/png" and stored["n"] > 0
    # request actually carried a controlled prompt + image modality
    body = _Client.last["json"]
    assert body["generationConfig"]["responseModalities"] == ["IMAGE"]
    assert "children" in body["contents"][0]["parts"][0]["text"].lower() or \
           "illustration" in body["contents"][0]["parts"][0]["text"].lower()
    # no student identifiers in the prompt
    assert "stu_" not in str(body)


def test_image_generation_http_error_falls_back():
    _Client._next = _Resp(500, {})
    out = run(g.prepare_mission_image(theme="nature", difficulty="beginner",
                                      store=lambda *a: "x"))
    assert out["outcome"] == g.IMG_FAILED
    assert out["image_ref"] == g.FALLBACK_IMAGE_REF


def test_image_generation_bad_mime_falls_back():
    _Client._next = _Resp(200, {"candidates": [{"content": {"parts": [
        {"inlineData": {"mimeType": "image/gif", "data": _png_b64()}}]}}]})
    out = run(g.prepare_mission_image(theme="nature", difficulty="beginner",
                                      store=lambda *a: "x"))
    assert out["outcome"] == g.IMG_FAILED


def test_image_generation_oversize_falls_back():
    big = base64.b64encode(b"x" * (g.GEN_MAX_BYTES + 1)).decode("ascii")
    _Client._next = _Resp(200, {"candidates": [{"content": {"parts": [
        {"inlineData": {"mimeType": "image/png", "data": big}}]}}]})
    out = run(g.prepare_mission_image(theme="nature", difficulty="beginner",
                                      store=lambda *a: "x"))
    assert out["outcome"] == g.IMG_FAILED


# ── evaluation carries image + audio ────────────────────────────────────────
def test_evaluation_request_includes_image_and_audio():
    _Client._next = _Resp(200, {"candidates": [{"content": {"parts": [
        {"text": '{"scores":{"relevance":70,"visual_grounding":70,"detail":70,'
                 '"organization":70,"understandable_language":70},'
                 '"understanding_summary":"s","strongest_skill":"relevance",'
                 '"next_improvement":"n","coach_feedback":"c"}'}]}}]})
    out = run(g.evaluate_speaking(
        audio_bytes=b"AUDIO", audio_mime="audio/webm",
        mission_context="a balloon over hills",
        image_bytes=b"IMG", image_mime="image/png"))
    assert out["ok"] is True
    parts = _Client.last["json"]["contents"][0]["parts"]
    inline = [p for p in parts if "inline_data" in p or "inlineData" in p]
    mimes = [(p.get("inline_data") or p.get("inlineData"))["mime_type"] for p in inline]
    assert "image/png" in mimes and "audio/webm" in mimes  # both present
