"""tests/test_book_factory_image.py
====================================
Unit tests for the Gemini cover-image adapter's actual HTTP request shape —
NOT covered by test_book_factory_automation.py, which mocks
generate_cover_image_bytes/store_cover_image entirely at the orchestration
level and never exercises the real endpoint/model/payload construction.

LOCKED decision (per explicit product instruction): the stable Generate
Content API — "v1" + "gemini-3.1-flash-image" (no "-preview" suffix), NOT the
Interactions API (different endpoint/schema/parser — out of scope). Both
remain env-overridable so either can be corrected without a code change if
Google's naming/versioning shifts again. NO live network call anywhere in
this file — httpx.AsyncClient.post is monkeypatched throughout.
"""
from __future__ import annotations

import asyncio
import base64

import pytest

import book_factory_image as bf_image
from book_factory_jobs import BFRetryableError, BFTerminalError, BFUnknownOutcomeError


def run(coro):
    return asyncio.run(coro)


# A minimal valid 1x1 PNG, base64-encoded.
_TINY_PNG_B64 = base64.b64encode(
    bytes.fromhex(
        "89504e470d0a1a0a0000000d494844520000000100000001080600000"
        "01f15c4890000000a49444154789c6360000002000155a2415d000000"
        "0049454e44ae426082"
    )
).decode("ascii")


class _FakeResponse:
    def __init__(self, status_code, json_body=None, text=""):
        self.status_code = status_code
        self._json = json_body or {}
        self.text = text

    def json(self):
        return self._json


class _FakeAsyncClient:
    """Captures the exact request made to the Gemini endpoint."""
    last_url = None
    last_params = None
    last_json = None
    response = None

    def __init__(self, *a, **kw):
        pass

    async def __aenter__(self):
        return self

    async def __aexit__(self, *a):
        return False

    async def post(self, url, params=None, json=None, headers=None):
        _FakeAsyncClient.last_url = url
        _FakeAsyncClient.last_params = params
        _FakeAsyncClient.last_json = json
        return _FakeAsyncClient.response


@pytest.fixture(autouse=True)
def _clean_env(monkeypatch):
    monkeypatch.setenv("GEMINI_IMAGE_API_KEY", "test-image-key")
    monkeypatch.delenv("BOOK_FACTORY_COVER_MODEL", raising=False)
    monkeypatch.delenv("BOOK_FACTORY_COVER_API_VERSION", raising=False)
    monkeypatch.delenv("BOOK_FACTORY_COVER_IMAGE_SIZE", raising=False)


def test_default_api_version_is_v1():
    assert bf_image._api_version() == "v1"


def test_default_model_is_gemini_3_1_flash_image_no_preview_suffix():
    assert bf_image._model() == "gemini-3.1-flash-image"
    assert "preview" not in bf_image._model()


def test_default_endpoint_ends_with_documented_path():
    assert bf_image._endpoint().endswith("/v1/models/gemini-3.1-flash-image:generateContent")
    assert bf_image._endpoint() == "https://generativelanguage.googleapis.com/v1/models/gemini-3.1-flash-image:generateContent"


def test_endpoint_and_model_are_env_overridable(monkeypatch):
    monkeypatch.setenv("BOOK_FACTORY_COVER_API_VERSION", "v1beta")
    monkeypatch.setenv("BOOK_FACTORY_COVER_MODEL", "some-future-model")
    assert bf_image._endpoint() == "https://generativelanguage.googleapis.com/v1beta/models/some-future-model:generateContent"


def test_no_env_vars_required_for_correct_defaults(monkeypatch):
    """Neither BOOK_FACTORY_COVER_API_VERSION nor BOOK_FACTORY_COVER_MODEL
    needs to be set in Render — the hardcoded defaults are already correct."""
    monkeypatch.delenv("BOOK_FACTORY_COVER_API_VERSION", raising=False)
    monkeypatch.delenv("BOOK_FACTORY_COVER_MODEL", raising=False)
    assert bf_image._endpoint() == "https://generativelanguage.googleapis.com/v1/models/gemini-3.1-flash-image:generateContent"


def test_request_payload_matches_documented_generate_content_shape(monkeypatch):
    monkeypatch.setattr(bf_image.httpx, "AsyncClient", _FakeAsyncClient)
    _FakeAsyncClient.response = _FakeResponse(200, {
        "candidates": [{"content": {"parts": [
            {"inlineData": {"data": _TINY_PNG_B64, "mimeType": "image/png"}}
        ]}}]
    })

    run(bf_image._call_gemini_image("a test prompt", timeout=5.0))

    body = _FakeAsyncClient.last_json
    assert "responseModalities" in body["generationConfig"]
    assert body["generationConfig"]["responseModalities"] == ["IMAGE"]
    assert body["generationConfig"]["responseFormat"]["image"]["aspectRatio"] == "2:3"
    assert body["generationConfig"]["responseFormat"]["image"]["imageSize"] == "1K"
    assert _FakeAsyncClient.last_params == {"key": "test-image-key"}
    assert _FakeAsyncClient.last_url == "https://generativelanguage.googleapis.com/v1/models/gemini-3.1-flash-image:generateContent"
    assert _FakeAsyncClient.last_url.endswith("/v1/models/gemini-3.1-flash-image:generateContent")


def test_image_size_env_overridable(monkeypatch):
    monkeypatch.setattr(bf_image.httpx, "AsyncClient", _FakeAsyncClient)
    monkeypatch.setenv("BOOK_FACTORY_COVER_IMAGE_SIZE", "2K")
    _FakeAsyncClient.response = _FakeResponse(200, {
        "candidates": [{"content": {"parts": [
            {"inlineData": {"data": _TINY_PNG_B64, "mimeType": "image/png"}}
        ]}}]
    })
    run(bf_image._call_gemini_image("prompt", timeout=5.0))
    assert _FakeAsyncClient.last_json["generationConfig"]["responseFormat"]["image"]["imageSize"] == "2K"


def test_404_is_classified_terminal_not_silently_swallowed(monkeypatch):
    """A wrong model id or API version produces a 404 — it must surface as a
    clear, visible terminal failure (job.cover.lastError), never a silent no-op."""
    monkeypatch.setattr(bf_image.httpx, "AsyncClient", _FakeAsyncClient)
    _FakeAsyncClient.response = _FakeResponse(404, text="model not found")
    with pytest.raises(BFTerminalError, match="404"):
        run(bf_image._call_gemini_image("prompt", timeout=5.0))


def test_missing_key_is_retryable_not_terminal(monkeypatch):
    monkeypatch.delenv("GEMINI_IMAGE_API_KEY", raising=False)
    monkeypatch.delenv("GEMINI_API_KEY", raising=False)
    with pytest.raises(BFRetryableError):
        run(bf_image._call_gemini_image("prompt", timeout=5.0))


def test_5xx_is_unknown_outcome(monkeypatch):
    monkeypatch.setattr(bf_image.httpx, "AsyncClient", _FakeAsyncClient)
    _FakeAsyncClient.response = _FakeResponse(503, text="overloaded")
    with pytest.raises(BFUnknownOutcomeError):
        run(bf_image._call_gemini_image("prompt", timeout=5.0))


def test_valid_png_bytes_extracted_and_validated(monkeypatch):
    monkeypatch.setattr(bf_image.httpx, "AsyncClient", _FakeAsyncClient)
    _FakeAsyncClient.response = _FakeResponse(200, {
        "candidates": [{"content": {"parts": [
            {"inlineData": {"data": _TINY_PNG_B64, "mimeType": "image/png"}}
        ]}}]
    })
    result = run(bf_image.generate_cover_image_bytes(
        title="T", topic="t", section="story", level="A2", tier="free", accent="#fff",
    ))
    assert result["ext"] == "png"
    assert result["mimeType"] == "image/png"
    assert result["image_bytes"][:8] == b"\x89PNG\r\n\x1a\n"


def test_text_only_response_is_terminal_not_silently_accepted(monkeypatch):
    """A response with no inlineData part (model declined to draw an image)
    must be a clear terminal failure, never treated as success with empty data."""
    monkeypatch.setattr(bf_image.httpx, "AsyncClient", _FakeAsyncClient)
    _FakeAsyncClient.response = _FakeResponse(200, {
        "candidates": [{"content": {"parts": [{"text": "I cannot draw that."}]}}]
    })
    with pytest.raises(BFTerminalError, match="no image part"):
        run(bf_image._call_gemini_image("prompt", timeout=5.0))
