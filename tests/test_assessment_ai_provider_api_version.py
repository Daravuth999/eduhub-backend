"""tests/test_assessment_ai_provider_api_version.py — regression coverage
for the 2026-08-16 "model name fixed, still 404s" incident.

After correcting the retired "gemini-2.5-pro" model id to "gemini-3.1-pro"
(see test_assessment_ai_provider_error_detail.py / the corrected reason
message), submission extraction STILL failed:
  {"code": 404, "status": "NOT_FOUND", "message": "models/gemini-3.1-pro
   is not found for API version v1beta, or is not supported for
   generateContent..."}

Root cause: the API VERSION, not the model id. assessment_ai_provider.py
hardcoded every generateContent call to "v1beta". Gemini's 3.x-generation
models require the stable "v1" endpoint — this codebase already has a
LOCKED, tested precedent for exactly this (book_factory_image.py's
"gemini-3.1-flash-image", pinned to "v1" per an explicit product decision).
Every OTHER Gemini call in this file that stays on "v1beta" is on the 2.x
generation (gemini-2.5-flash), unaffected.

This file proves:
  1. The submission-extraction path now targets "v1", not "v1beta".
  2. The answer-key/flash path is UNCHANGED — still "v1beta" (never touch
     what's confirmed working).
  3. The exact real failure condition reproduces (v1beta -> 404 for a 3.x
     model) AND the corrected configuration succeeds end-to-end: real
     student submission -> extraction succeeds -> answers extracted ->
     reaches the caller ready for scoring/teacher-review, never requiring
     the student to resubmit.
"""
from __future__ import annotations

import asyncio

import assessment_ai_provider as ai


def run(c):
    return asyncio.run(c)


class _FakeResponse:
    def __init__(self, status_code, payload=None, text=""):
        self.status_code = status_code
        self._payload = payload
        self.text = text

    def json(self):
        if self._payload is None:
            raise ValueError("no json body")
        return self._payload


def _questions():
    return [
        {"qid": "q1", "prompt": "sheep", "correctAnswer": "LONG"},
        {"qid": "q2", "prompt": "ship", "correctAnswer": "SHORT"},
    ]


def test_gen_url_builds_the_correct_endpoint_per_api_version():
    assert ai._gen_url("gemini-2.5-flash", "v1beta") == (
        "https://generativelanguage.googleapis.com/v1beta/models/gemini-2.5-flash:generateContent"
    )
    assert ai._gen_url("gemini-3.1-pro", "v1") == (
        "https://generativelanguage.googleapis.com/v1/models/gemini-3.1-pro:generateContent"
    )


def test_submission_path_defaults_to_v1_answer_key_path_stays_v1beta():
    """The exact single source of truth this incident needed: the
    Pro-tier/submission path and the Flash/answer-key path must resolve to
    DIFFERENT api versions by default — changing one must never silently
    move the other."""
    assert ai.DEFAULT_API_VERSION == "v1beta"
    assert ai.DEFAULT_SUBMISSION_API_VERSION == "v1"
    assert ai._api_version() == "v1beta"
    assert ai._submission_api_version() == "v1"


def test_submission_api_version_is_env_overridable_independent_of_flash(monkeypatch):
    monkeypatch.setenv("ASSESSMENT_AI_SUBMISSION_API_VERSION", "v1alpha")
    assert ai._submission_api_version() == "v1alpha"
    assert ai._api_version() == "v1beta"  # untouched by the override above


def test_call_gemini_json_uses_v1beta_by_default_matching_the_flash_path(monkeypatch):
    calls = []

    async def fake_post(url, **kwargs):
        calls.append(url)
        return _FakeResponse(200, {"candidates": [{"content": {"parts": [{"text": "{}"}]}}]})

    monkeypatch.setenv("GEMINI_API_KEY", "test-key")
    monkeypatch.setattr(ai, "_post", fake_post)
    run(ai._call_gemini_json("prompt", model="gemini-2.5-flash"))
    assert calls[0] == ai._gen_url("gemini-2.5-flash", "v1beta")


def test_submission_extraction_reproduces_the_real_incident_and_the_fix(monkeypatch):
    """The exact failure condition from production, reproduced and then
    proven fixed in one test:
      - A fake Gemini backend that genuinely only serves gemini-3.1-pro
        under "v1" — exactly Google's real, documented behavior for this
        model generation — and 404s any "v1beta" request for it (this is
        what "unsupported model -> provider rejects -> clear extraction
        failure" looked like before this fix).
      - assessment_ai_provider.py must now request "v1" for the submission
        path, so the SAME fake backend returns a real, valid extraction —
        proving "real supported model -> generateContent -> successful
        extraction -> structured answers -> scoring continues" without any
        change to the student's submission record."""
    calls = []
    real_answers = [
        {"qid": "q1", "answer": "LONG", "answer_state": "answered", "confidence": 0.95},
        {"qid": "q2", "answer": "SHORT", "answer_state": "answered", "confidence": 0.95},
    ]

    async def fake_post(url, **kwargs):
        calls.append(url)
        if "/v1beta/" in url:
            # Faithful to the real Google response for a 3.x-generation
            # model requested under v1beta.
            return _FakeResponse(404, {
                "error": {"code": 404, "status": "NOT_FOUND",
                          "message": f"model is not found for API version v1beta ({url})"},
            })
        assert "/v1/" in url and "/v1beta/" not in url
        return _FakeResponse(200, {
            "candidates": [{"content": {"parts": [{"text": '{"answers": ' + str(real_answers).replace("'", '"') + '}'}]}}],
        })

    async def fake_media_part(api_key, media_bytes, content_type):
        return {"inline_data": {"mime_type": content_type, "data": "ZmFrZQ=="}}

    monkeypatch.setenv("GEMINI_API_KEY", "test-key")
    monkeypatch.delenv("ASSESSMENT_AI_MOCK", raising=False)
    monkeypatch.setattr(ai, "_post", fake_post)
    monkeypatch.setattr(ai, "_media_part", fake_media_part)

    result = run(ai.extract_submission_answers(b"bytes", "image/jpeg", _questions()))

    # The fix: extraction succeeds because the code requested "v1", not
    # "v1beta", for this Pro-tier model — never hit the 404 branch at all.
    assert result["ok"] is True
    assert result["answers"] == real_answers
    assert result["model"] == ai.DEFAULT_SUBMISSION_MODEL
    assert all("/v1beta/" not in u for u in calls), (
        "submission extraction must never request the v1beta endpoint for "
        f"the 3.x-generation model — calls were: {calls}"
    )
    assert all("/v1/models/" in u for u in calls)


def test_submission_extraction_still_fails_honestly_if_forced_back_to_v1beta(monkeypatch):
    """Guards against silently reintroducing the bug: if api_version is
    (mis)configured back to v1beta for the submission path, the failure
    must still be reported honestly (never silently swallowed or
    misattributed) — proving this test suite would actually catch a
    regression, not just assert the current wiring is present."""
    monkeypatch.setenv("GEMINI_API_KEY", "test-key")
    monkeypatch.setenv("ASSESSMENT_AI_SUBMISSION_API_VERSION", "v1beta")
    monkeypatch.delenv("ASSESSMENT_AI_MOCK", raising=False)

    async def fake_post(url, **kwargs):
        assert "/v1beta/" in url
        return _FakeResponse(404, {
            "error": {"code": 404, "status": "NOT_FOUND",
                      "message": "models/gemini-3.1-pro is not found for API version v1beta, "
                                 "or is not supported for generateContent."},
        })

    async def fake_media_part(api_key, media_bytes, content_type):
        return {"inline_data": {"mime_type": content_type, "data": "ZmFrZQ=="}}

    monkeypatch.setattr(ai, "_post", fake_post)
    monkeypatch.setattr(ai, "_media_part", fake_media_part)

    result = run(ai.extract_submission_answers(b"bytes", "image/jpeg", _questions()))
    assert result["ok"] is False
    assert "NOT_FOUND" in result["reason"]
    assert "api_version=v1beta" in result["reason"]
