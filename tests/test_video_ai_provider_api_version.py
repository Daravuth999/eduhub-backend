"""tests/test_video_ai_provider_api_version.py — regression coverage for
the same 2026-08-16 "model name fixed, still 404s" incident as
tests/test_assessment_ai_provider_api_version.py, applied to the Video
Library's whole-story analysis path (analyze_story / GeminiVideoProvider.
analyze_story_raw), which uses the identical "gemini-3.1-pro" model and
was fixed with the identical root cause: the deep-analysis path must
request the stable "v1" endpoint, not "v1beta" — the ASR/speech-
recognition path (gemini-2.5-flash) is unaffected and stays on "v1beta".
"""
from __future__ import annotations

import asyncio
import json

import video_ai_provider as vap


def run(c):
    return asyncio.run(c)


class _FakeHttpResponse:
    def __init__(self, status_code=200, payload=None, text=""):
        self.status_code = status_code
        self._payload = payload or {}
        self.text = text

    def json(self):
        return self._payload


_VALID_STORY_TEXT = json.dumps({
    "summary": "s", "narrativeArc": "a", "characters": [],
    "scenes": [{"start": 0.0, "end": 5.0, "title": "Opening", "description": "d",
                "narrativeRole": "setup", "speakers": ["S1"], "characters": []}],
})


class _RoutingGeminiClient:
    """A fake Gemini backend that discriminates by API version in the
    URL — exactly Google's real, documented behavior for a 3.x-generation
    model: only serves it under "v1", 404s any "v1beta" request for it.
    This is the harness needed to prove the fix, not just assert the
    current wiring is present."""

    def __init__(self):
        self.calls: list[str] = []

    async def post(self, url, params=None, json=None, **kwargs):
        self.calls.append(url)
        if "/v1beta/" in url:
            return _FakeHttpResponse(404, {
                "error": {"code": 404, "status": "NOT_FOUND",
                          "message": f"model is not found for API version v1beta ({url})"},
            })
        assert "/v1/" in url and "/v1beta/" not in url
        return _FakeHttpResponse(200, {
            "candidates": [{"content": {"parts": [{"text": _VALID_STORY_TEXT}]}}],
        })


def test_gen_url_builds_the_correct_endpoint_per_api_version():
    assert vap._gen_url("gemini-2.5-flash", "v1beta") == (
        "https://generativelanguage.googleapis.com/v1beta/models/gemini-2.5-flash:generateContent"
    )
    assert vap._gen_url("gemini-3.1-pro", "v1") == (
        "https://generativelanguage.googleapis.com/v1/models/gemini-3.1-pro:generateContent"
    )


def test_analysis_path_defaults_to_v1_asr_path_stays_v1beta(monkeypatch):
    monkeypatch.setenv("GEMINI_API_KEY", "test-key")
    assert vap.DEFAULT_API_VERSION == "v1beta"
    assert vap.DEFAULT_ANALYSIS_API_VERSION == "v1"
    assert vap._api_version() == "v1beta"
    assert vap._analysis_api_version() == "v1"


def test_analysis_api_version_is_env_overridable_independent_of_asr(monkeypatch):
    monkeypatch.setenv("GEMINI_API_KEY", "test-key")
    monkeypatch.setenv("VIDEO_ANALYSIS_API_VERSION", "v1alpha")
    assert vap._analysis_api_version() == "v1alpha"
    assert vap._api_version() == "v1beta"  # untouched by the override above


def test_align_asr_path_requests_v1beta_by_default(monkeypatch):
    """The speech-recognition path is confirmed still working in
    production — must never move off v1beta as a side effect of this fix."""
    monkeypatch.setenv("GEMINI_API_KEY", "test-key")
    client = _RoutingGeminiClient()
    # Force the ASR call down the v1 branch response shape it doesn't
    # expect, to prove definitively which URL it actually requested rather
    # than inferring it from a coincidentally-successful parse.
    provider = vap.GeminiVideoProvider(http_client=client)
    try:
        run(provider.align(b"fake-audio-bytes", "audio/mpeg"))
    except Exception:
        pass  # response shape mismatch is expected/irrelevant here
    assert len(client.calls) == 1
    assert "/v1beta/" in client.calls[0]
    assert "/v1/models/" not in client.calls[0]


def test_story_analysis_reproduces_the_real_incident_and_the_fix(monkeypatch):
    """The exact failure condition from production, reproduced and then
    proven fixed: a fake Gemini backend that only serves gemini-3.1-pro
    under "v1" (Google's real behavior for this model generation) and
    404s any "v1beta" request for it — this is what "unsupported model ->
    provider rejects -> clear extraction failure" looked like before this
    fix. video_ai_provider.py must now request "v1" for analyze_story, so
    the SAME fake backend returns a real, valid response."""
    monkeypatch.setenv("GEMINI_API_KEY", "test-key")
    client = _RoutingGeminiClient()

    result = run(vap.analyze_story(b"fake-video-bytes", "video/mp4",
                                     transcript_text="hello world", http_client=client))

    assert result["ok"] is True
    assert result["storyAnalysis"]["scenes"][0]["title"] == "Opening"
    assert all("/v1beta/" not in u for u in client.calls), (
        "whole-story analysis must never request the v1beta endpoint for "
        f"the 3.x-generation model — calls were: {client.calls}"
    )
    assert all("/v1/models/" in u for u in client.calls)


def test_story_analysis_still_fails_honestly_if_forced_back_to_v1beta(monkeypatch):
    """Guards against silently reintroducing the bug."""
    monkeypatch.setenv("GEMINI_API_KEY", "test-key")
    monkeypatch.setenv("VIDEO_ANALYSIS_API_VERSION", "v1beta")
    client = _RoutingGeminiClient()

    result = run(vap.analyze_story(b"fake-video-bytes", "video/mp4",
                                     transcript_text="hello world", http_client=client))

    assert result["ok"] is False
    assert "NOT_FOUND" in result["reason"]
    assert "api_version=v1beta" in result["reason"]
