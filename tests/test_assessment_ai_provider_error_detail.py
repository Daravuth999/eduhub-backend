"""tests/test_assessment_ai_provider_error_detail.py — regression coverage
for a real support report: a student's uploaded test sheet failed to
extract and the ONLY diagnostic visible anywhere was "404" — the bare
HTTP status, with zero indication of WHY Gemini rejected the call (a
nonexistent/renamed model id, a permission issue, an invalid request).

Code audit found assessment_ai_provider.py's _call_gemini_json() threw
away Gemini's own structured {"error": {"code","message","status"}}
response body on any non-200 and kept only the bare status code — the
exact bug video_ai_provider.py already fixed for the video pipeline
(_gemini_http_error_detail), never ported over to the assessment
pipeline. This file proves the real provider-reported reason now
survives all the way to extract_submission_answers()'s "reason" field
for the two failure shapes actually seen in production: a structured
Gemini error body, and (for the one AssessmentAiError-message the caller
never reads: files_upload_failed) a plain-text body.
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
    return [{"qid": "q1", "prompt": "sheep", "correctAnswer": "LONG"}]


def test_error_detail_extracts_structured_gemini_error_body():
    body = {"error": {"code": 404, "status": "NOT_FOUND",
                       "message": "models/gemini-2.5-pro is not found for API version v1beta"}}
    detail = ai._gemini_http_error_detail(_FakeResponse(404, body))
    assert detail == "NOT_FOUND: models/gemini-2.5-pro is not found for API version v1beta"


def test_error_detail_falls_back_to_raw_text_when_body_is_not_the_error_shape():
    detail = ai._gemini_http_error_detail(_FakeResponse(500, {"unexpected": "shape"}, text="upstream blew up"))
    assert detail == "" or "unexpected" not in detail  # never fabricates from an unrelated shape
    detail2 = ai._gemini_http_error_detail(_FakeResponse(500, None, text="upstream blew up"))
    assert detail2 == "upstream blew up"


def test_call_gemini_json_404_surfaces_the_real_reason_not_a_bare_status(monkeypatch):
    body = {"error": {"code": 404, "status": "NOT_FOUND",
                       "message": "models/gemini-2.5-pro is not found for API version v1beta, "
                                  "or is not supported for generateContent."}}

    async def fake_post(url, **kwargs):
        return _FakeResponse(404, body)

    monkeypatch.setenv("GEMINI_API_KEY", "test-key")
    monkeypatch.setattr(ai, "_post", fake_post)

    try:
        run(ai._call_gemini_json("prompt text"))
        assert False, "expected AssessmentAiError"
    except ai.AssessmentAiError as exc:
        assert exc.code == "provider_rejected"
        assert "Gemini HTTP 404" in exc.message
        assert "NOT_FOUND" in exc.message
        assert "models/gemini-2.5-pro is not found" in exc.message


def test_extract_submission_answers_reason_includes_the_real_gemini_error(monkeypatch):
    body = {"error": {"code": 404, "status": "NOT_FOUND",
                       "message": "models/gemini-2.5-pro is not found for API version v1beta."}}

    async def fake_post(url, **kwargs):
        return _FakeResponse(404, body)

    async def fake_media_part(api_key, media_bytes, content_type):
        return {"inline_data": {"mime_type": content_type, "data": "ZmFrZQ=="}}

    monkeypatch.setenv("GEMINI_API_KEY", "test-key")
    monkeypatch.delenv("ASSESSMENT_AI_MOCK", raising=False)
    monkeypatch.setattr(ai, "_post", fake_post)
    monkeypatch.setattr(ai, "_media_part", fake_media_part)

    result = run(ai.extract_submission_answers(b"bytes", "image/jpeg", _questions()))
    assert result["ok"] is False
    # A teacher/admin reading this in Author Studio (or the honest
    # extractionError surfaced to the student) must see WHY — not just
    # that Gemini said 404.
    assert result["reason"] == (
        "provider_rejected: Gemini HTTP 404 — "
        "NOT_FOUND: models/gemini-2.5-pro is not found for API version v1beta."
    )
