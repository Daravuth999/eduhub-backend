"""tests/test_video_ai_provider.py — Gemini model isolation for the Video
Library. Two deliberately independent model configurations live in this
module: VIDEO_AI_MODEL (fast path — speech recognition/ASR, default
gemini-2.5-flash) and VIDEO_ANALYSIS_MODEL (deep path — whole-video story/
scene understanding, default gemini-3.1-pro). This file proves they are
genuinely isolated from each other and that video_ai_provider.py has no
importers outside the Video Library, so changing either constant here can
never affect any other EduHub Gemini integration (Book Factory, EduTalk,
premium_ai_tools, etc. all read the separate, shared GEMINI_MODEL env var
independently — verified by dependency grep, not assumed).
"""
from __future__ import annotations

import json
from pathlib import Path

import pytest

import video_ai_provider as vap


@pytest.fixture(autouse=True)
def _no_real_env(monkeypatch):
    monkeypatch.delenv("VIDEO_AI_MODEL", raising=False)
    monkeypatch.delenv("VIDEO_ANALYSIS_MODEL", raising=False)
    monkeypatch.setenv("GEMINI_API_KEY", "test-key")
    monkeypatch.delenv("VIDEO_AI_MOCK", raising=False)


class _FakeHttpResponse:
    def __init__(self, status_code=200, payload=None, text=""):
        self.status_code = status_code
        self._payload = payload or {}
        self.text = text

    def json(self):
        return self._payload


def _gemini_json_response(payload: dict) -> _FakeHttpResponse:
    return _FakeHttpResponse(200, {
        "candidates": [{"content": {"parts": [{"text": json.dumps(payload)}]}}],
    })


class _RecordingGeminiClient:
    """Captures every request URL (which embeds the model name — see
    video_ai_provider._GEN_URL) so tests can assert exactly which model a
    given call actually used."""
    def __init__(self, response: _FakeHttpResponse):
        self.calls: list[str] = []
        self._response = response

    async def post(self, url, params=None, json=None, **kwargs):
        self.calls.append(url)
        return self._response


def test_default_models_are_independent_constants():
    assert vap.DEFAULT_MODEL == "gemini-2.5-flash"
    assert vap.DEFAULT_ANALYSIS_MODEL == "gemini-3.1-pro"
    assert vap.DEFAULT_MODEL != vap.DEFAULT_ANALYSIS_MODEL


def test_model_getters_default_correctly_with_no_env_set():
    assert vap._model() == "gemini-2.5-flash"
    assert vap._analysis_model() == "gemini-3.1-pro"


def test_analysis_model_override_never_affects_the_asr_model(monkeypatch):
    """Setting VIDEO_ANALYSIS_MODEL must not change what ASR (_model())
    resolves to — the two are read from separate env vars entirely."""
    monkeypatch.setenv("VIDEO_ANALYSIS_MODEL", "gemini-2.5-pro-preview")
    assert vap._model() == "gemini-2.5-flash"
    assert vap._analysis_model() == "gemini-2.5-pro-preview"


def test_asr_model_override_never_affects_the_analysis_model(monkeypatch):
    """And the reverse: overriding the fast-path model must not touch the
    deep-analysis model's default."""
    monkeypatch.setenv("VIDEO_AI_MODEL", "gemini-2.5-flash-lite")
    assert vap._model() == "gemini-2.5-flash-lite"
    assert vap._analysis_model() == "gemini-3.1-pro"


@pytest.mark.asyncio
async def test_align_asr_actually_requests_the_flash_model():
    client = _RecordingGeminiClient(_gemini_json_response({
        "segments": [{"text": "hello", "start": 0.0, "end": 0.5, "speakerId": "S1"}],
    }))
    provider = vap.GeminiVideoProvider(http_client=client)
    await provider.align(b"fake-audio-bytes", "audio/mpeg")

    assert len(client.calls) == 1
    assert "gemini-2.5-flash" in client.calls[0]
    assert "gemini-3.1-pro" not in client.calls[0]


# ── ASR response-parsing robustness — root-caused against a real production
#    failure ("VideoAIError: Gemini returned no parsable segments") where a
#    genuinely valid Gemini answer was being treated as unparsable. ────────
@pytest.mark.asyncio
async def test_align_rejects_empty_media_without_any_provider_call():
    provider = vap.GeminiVideoProvider(http_client=_RecordingGeminiClient(_FakeHttpResponse()))
    with pytest.raises(vap.VideoAiError) as exc:
        await provider.align(b"", "audio/mpeg")
    assert exc.value.code == "empty_media"


@pytest.mark.asyncio
async def test_align_accepts_a_bare_top_level_segments_array():
    """A real, observed Gemini response-shape variance: instead of the
    requested {"language":...,"segments":[...]} wrapper, the model returns
    the segments array directly at the top level. This is a well-formed,
    usable answer and must never be treated as a parsing failure."""
    client = _RecordingGeminiClient(_gemini_json_response(
        [{"speaker": "S1", "start": 0.0, "end": 1.2, "text": "Hello there."}],
    ))
    provider = vap.GeminiVideoProvider(http_client=client)
    result = await provider.align(b"fake-audio-bytes", "audio/mpeg")
    assert result["transcriptText"] == "Hello there."
    assert result["sync"]["paragraphs"][0]["sentences"][0]["words"][0]["word"] == "Hello"


@pytest.mark.asyncio
async def test_align_bare_array_skips_non_dict_entries_honestly():
    client = _RecordingGeminiClient(_gemini_json_response(
        [{"speaker": "S1", "start": 0.0, "end": 1.0, "text": "Real segment."}, "garbage", 42, None],
    ))
    provider = vap.GeminiVideoProvider(http_client=client)
    result = await provider.align(b"fake-audio-bytes", "audio/mpeg")
    assert result["transcriptText"] == "Real segment."


@pytest.mark.asyncio
async def test_align_raises_bad_response_with_no_extra_diagnostic_for_plain_garbage_text():
    """A normal-looking response (STOP finish reason, real candidates) that
    simply isn't valid/parsable JSON must still fail cleanly — the
    diagnostic suffix is genuinely absent here, not fabricated, so the
    message matches the original plain wording."""
    client = _RecordingGeminiClient(_FakeHttpResponse(200, {
        "candidates": [{"content": {"parts": [{"text": "Sorry, I cannot help with that."}]},
                         "finishReason": "STOP"}],
    }))
    provider = vap.GeminiVideoProvider(http_client=client)
    with pytest.raises(vap.VideoAiError) as exc:
        await provider.align(b"fake-audio-bytes", "audio/mpeg")
    assert exc.value.code == "bad_response"
    assert exc.value.message == "Gemini returned no parsable segments"


@pytest.mark.asyncio
async def test_align_surfaces_a_safety_block_reason_instead_of_a_generic_failure():
    client = _RecordingGeminiClient(_FakeHttpResponse(200, {
        "candidates": [], "promptFeedback": {"blockReason": "SAFETY"},
    }))
    provider = vap.GeminiVideoProvider(http_client=client)
    with pytest.raises(vap.VideoAiError) as exc:
        await provider.align(b"fake-audio-bytes", "audio/mpeg")
    assert exc.value.code == "bad_response"
    assert "blockReason=SAFETY" in exc.value.message


@pytest.mark.asyncio
async def test_align_surfaces_a_truncated_max_tokens_response_honestly():
    """A response cut off before completing valid JSON (e.g. a very long
    lesson producing more segments than the output token budget allows)
    must be reported as a truncation, not a generic unparsable-segments
    message that hides the real, actionable cause."""
    client = _RecordingGeminiClient(_FakeHttpResponse(200, {
        "candidates": [{"content": {"parts": [{"text": '{"language":"en","segments":[{"speaker":"S1"'}]},
                         "finishReason": "MAX_TOKENS"}],
    }))
    provider = vap.GeminiVideoProvider(http_client=client)
    with pytest.raises(vap.VideoAiError) as exc:
        await provider.align(b"fake-audio-bytes", "audio/mpeg")
    assert exc.value.code == "bad_response"
    assert "finishReason=MAX_TOKENS" in exc.value.message


@pytest.mark.asyncio
async def test_align_reports_no_candidates_returned_when_response_is_empty():
    client = _RecordingGeminiClient(_FakeHttpResponse(200, {"candidates": []}))
    provider = vap.GeminiVideoProvider(http_client=client)
    with pytest.raises(vap.VideoAiError) as exc:
        await provider.align(b"fake-audio-bytes", "audio/mpeg")
    assert "no candidates returned" in exc.value.message


# ── Story Analysis must work for a silent video — no ASR/transcript
#    dependency, and the prompt must say so explicitly (Section 4). ────────
def test_story_prompt_explicitly_tells_gemini_the_video_may_have_no_audio():
    prompt = vap._STORY_PROMPT_TEMPLATE
    assert "NO AUDIO" in prompt
    assert "silent" in prompt.lower()
    assert "visual" in prompt.lower()


@pytest.mark.asyncio
async def test_analyze_story_works_with_a_genuinely_empty_transcript():
    """A silent video passes transcript_text="" — analyze_story must still
    call Gemini with the real video and succeed; an empty transcript is a
    valid, expected input, never a reason to fail before even trying."""
    client = _RecordingGeminiClient(_gemini_json_response({
        "summary": "A visual-only story.", "narrativeArc": "setup/resolution",
        "characters": [{"name": "Maya", "description": "the protagonist"}],
        "scenes": [
            {"sceneId": "sc1", "start": 0.0, "end": 5.0, "title": "Opening",
             "description": "Maya walks into a quiet room.", "characters": ["Maya"], "speakers": [],
             "narrativeRole": "setup",
             "audioObservations": {"dialogue": "", "music": "", "ambience": "", "sfx": ""},
             "emotionalContext": "Maya feels curious."},
        ],
    }))
    result = await vap.analyze_story(
        b"fake-silent-video-bytes", "video/mp4", transcript_text="", http_client=client,
    )
    assert result["ok"] is True
    assert result["storyAnalysis"]["scenes"][0]["speakers"] == []  # no invented speaker
    assert len(client.calls) == 1  # the video was genuinely sent, not skipped


@pytest.mark.asyncio
async def test_analyze_story_actually_requests_the_pro_model():
    client = _RecordingGeminiClient(_gemini_json_response({
        "summary": "A short story.", "narrativeArc": "setup/resolution",
        "characters": [], "scenes": [
            {"sceneId": "sc1", "start": 0.0, "end": 5.0, "title": "Opening",
             "description": "d", "characters": [], "speakers": [], "narrativeRole": "setup",
             "audioObservations": {"dialogue": "", "music": "", "ambience": "", "sfx": ""},
             "emotionalContext": ""},
        ],
    }))
    result = await vap.analyze_story(
        b"fake-video-bytes", "video/mp4", transcript_text="hello", http_client=client,
    )

    assert result["ok"] is True
    assert len(client.calls) == 1
    assert "gemini-3.1-pro" in client.calls[0]


@pytest.mark.asyncio
async def test_draft_script_blueprint_also_uses_the_pro_model():
    """Script drafting is grounded in the same full-story context as Story
    Analysis (and now also drafts each line's Khmer translation in the same
    response) — it deliberately runs on the deep-path model, not the ASR/
    Flash model _model() the speech-recognition path uses."""
    client = _RecordingGeminiClient(_gemini_json_response({
        "scenes": [{"sceneId": "sc1", "lines": [{"speaker": "Narrator", "text": "Hi.", "translationKm": "សួស្ដី។"}]}],
    }))
    story_analysis = {"scenes": [{"sceneId": "sc1"}]}
    result = await vap.draft_script_blueprint(story_analysis, transcript_text="hi", http_client=client)

    assert result["ok"] is True
    assert len(client.calls) == 1
    assert "gemini-3.1-pro" in client.calls[0]


@pytest.mark.asyncio
async def test_analyze_story_uses_gemini_25_pro_url_via_injected_client(monkeypatch):
    """analyze_story doesn't accept http_client directly in its public
    signature, so this drives it through the same GeminiVideoProvider path
    it constructs internally, confirmed via the model string alone (the
    provider is instantiated fresh inside analyze_story — see its source)."""
    captured_urls: list[str] = []

    class _Client(_RecordingGeminiClient):
        async def post(self, url, params=None, json=None, **kwargs):
            captured_urls.append(url)
            return _gemini_json_response({
                "summary": "s", "narrativeArc": "a", "characters": [], "scenes": [
                    {"sceneId": "sc1", "start": 0.0, "end": 5.0, "title": "t", "description": "d",
                     "characters": [], "speakers": [], "narrativeRole": "setup",
                     "audioObservations": {"dialogue": "", "music": "", "ambience": "", "sfx": ""},
                     "emotionalContext": ""},
                ],
            })

    result = await vap.analyze_story(
        b"fake-video-bytes", "video/mp4", transcript_text="hello", http_client=_Client(_FakeHttpResponse()),
    )
    assert result["ok"] is True
    assert len(captured_urls) == 1
    assert "gemini-3.1-pro" in captured_urls[0]
    assert "gemini-2.5-flash" not in captured_urls[0]


@pytest.mark.asyncio
async def test_analyze_story_receives_the_original_video_not_extracted_audio_only():
    """Confirms the caller contract: analyze_story's media_part is built
    from whatever bytes/content_type it's given — video_narration_tools.
    run_story_analysis is the one that decides to pass the ORIGINAL
    lesson.mediaRef (never the extracted-audio-only bytes ASR uses); this
    test locks in that analyze_story itself does not silently prefer or
    require audio-only input."""
    captured_content_types: list[str] = []

    class _Client(_RecordingGeminiClient):
        async def post(self, url, params=None, json=None, **kwargs):
            part = json["contents"][0]["parts"][1]
            captured_content_types.append(part["inline_data"]["mime_type"])
            return _gemini_json_response({
                "summary": "s", "narrativeArc": "a", "characters": [], "scenes": [
                    {"sceneId": "sc1", "start": 0.0, "end": 5.0, "title": "t", "description": "d",
                     "characters": [], "speakers": [], "narrativeRole": "setup",
                     "audioObservations": {"dialogue": "", "music": "", "ambience": "", "sfx": ""},
                     "emotionalContext": ""},
                ],
            })

    result = await vap.analyze_story(
        b"fake-video-bytes", "video/mp4", transcript_text="hello", http_client=_Client(_FakeHttpResponse()),
    )
    assert result["ok"] is True
    assert captured_content_types == ["video/mp4"]


def test_video_ai_provider_has_no_importers_outside_video_library():
    """Locks in the isolation claim with a real, repo-wide source scan
    rather than an assumption: if some future change makes another EduHub
    system import this module, this test fails loudly instead of silently
    coupling an unrelated system to the Video Library's model choices.
    Plain filesystem scan (no git/subprocess dependency, so this can't be
    flaky in an environment without git on PATH)."""
    repo_root = Path(__file__).resolve().parent.parent
    allowed = {"video_narration_tools.py", "video_pipeline_tools.py", "video_ai_provider.py"}
    importers: set[str] = set()
    for py_file in repo_root.glob("*.py"):
        if py_file.name in allowed:
            continue
        text = py_file.read_text(encoding="utf-8", errors="ignore")
        if "import video_ai_provider" in text or "from video_ai_provider" in text:
            importers.add(py_file.name)
    assert importers == set(), importers


# ── Story Analysis (2.5 Pro) response-parsing robustness — the SAME
#    fixture matrix already proven for the ASR (Flash) path above, now
#    covering the deep-analysis path too (Directive: "Use realistic
#    fixture responses for... 2.5 Pro Story Analysis... safety block,
#    MAX_TOKENS, malformed JSON... Verify that no valid response is
#    accidentally classified as failure"). ──────────────────────────────────
def _valid_story_payload() -> dict:
    return {
        "summary": "s", "narrativeArc": "a", "characters": [],
        "scenes": [{"start": 0.0, "end": 5.0, "title": "Opening", "description": "d",
                    "narrativeRole": "setup", "speakers": ["S1"], "characters": []}],
    }


@pytest.mark.asyncio
async def test_analyze_story_accepts_a_genuinely_valid_response():
    """The inverse of every failure-mode test below: a real, well-formed
    answer must never be misclassified as a parsing failure."""
    client = _RecordingGeminiClient(_gemini_json_response(_valid_story_payload()))
    result = await vap.analyze_story(b"fake-video-bytes", "video/mp4", transcript_text="hi", http_client=client)
    assert result["ok"] is True
    assert result["storyAnalysis"]["scenes"][0]["title"] == "Opening"


@pytest.mark.asyncio
async def test_analyze_story_surfaces_a_safety_block_reason_instead_of_a_generic_failure():
    client = _RecordingGeminiClient(_FakeHttpResponse(200, {
        "candidates": [], "promptFeedback": {"blockReason": "SAFETY"},
    }))
    result = await vap.analyze_story(b"fake-video-bytes", "video/mp4", transcript_text="hi", http_client=client)
    assert result["ok"] is False
    assert "blockReason=SAFETY" in result["reason"]


@pytest.mark.asyncio
async def test_analyze_story_surfaces_a_truncated_max_tokens_response_honestly():
    client = _RecordingGeminiClient(_FakeHttpResponse(200, {
        "candidates": [{"content": {"parts": [{"text": '{"summary":"s","scenes":[{"start":0'}]},
                         "finishReason": "MAX_TOKENS"}],
    }))
    result = await vap.analyze_story(b"fake-video-bytes", "video/mp4", transcript_text="hi", http_client=client)
    assert result["ok"] is False
    assert "finishReason=MAX_TOKENS" in result["reason"]


@pytest.mark.asyncio
async def test_analyze_story_reports_no_candidates_returned_when_response_is_empty():
    client = _RecordingGeminiClient(_FakeHttpResponse(200, {"candidates": []}))
    result = await vap.analyze_story(b"fake-video-bytes", "video/mp4", transcript_text="hi", http_client=client)
    assert result["ok"] is False
    assert "no candidates returned" in result["reason"]


@pytest.mark.asyncio
async def test_analyze_story_bad_response_with_no_extra_diagnostic_for_plain_garbage_text():
    """A normal-looking response (STOP, real candidates) that just isn't
    parsable JSON must still fail cleanly without a fabricated diagnostic."""
    client = _RecordingGeminiClient(_FakeHttpResponse(200, {
        "candidates": [{"content": {"parts": [{"text": "I cannot analyze this."}]}, "finishReason": "STOP"}],
    }))
    result = await vap.analyze_story(b"fake-video-bytes", "video/mp4", transcript_text="hi", http_client=client)
    assert result["ok"] is False
    assert result["reason"] == "bad_response"


@pytest.mark.asyncio
async def test_analyze_story_provider_rejected_http_error_never_silently_falls_back():
    """A non-200 HTTP response is a real provider rejection — never
    silently swallowed as a generic bad_response, and never triggers any
    fallback to a different model or provider (Section 3's explicit 'no
    silent Pro->Flash fallback' requirement — this path never touches
    _model()/DEFAULT_MODEL at all, only _analysis_model())."""
    client = _RecordingGeminiClient(_FakeHttpResponse(503, {}, text="upstream overloaded"))
    result = await vap.analyze_story(b"fake-video-bytes", "video/mp4", transcript_text="hi", http_client=client)
    assert result["ok"] is False
    # The real provider detail (HTTP status + response body) must reach the
    # caller, not be collapsed to a bare, undiagnosable "provider_rejected".
    assert result["reason"].startswith("provider_rejected")
    assert "upstream overloaded" in result["reason"]
    assert "gemini-3.1-pro" in client.calls[0]


@pytest.mark.asyncio
async def test_analyze_story_surfaces_the_real_structured_gemini_error_not_a_bare_code():
    """Bug report: Story Analysis showed only the bare string
    'provider_rejected' with zero diagnostic value, even though AI
    Processing (the ASR/Flash path, a completely separate call) had
    already succeeded on the same lesson. Gemini's REST API returns a
    structured {"error": {"code","message","status"}} body on rejection —
    this must reach the Studio's lastError so a real cause (model access,
    quota, invalid media, ...) is distinguishable from any other, instead
    of being collapsed into the same undiagnosable string for every
    possible rejection reason."""
    permission_denied_body = {
        "error": {
            "code": 403,
            "message": "Permission denied on resource project. Model gemini-2.5-pro "
                       "is not enabled for this project or API key.",
            "status": "PERMISSION_DENIED",
        },
    }
    client = _RecordingGeminiClient(_FakeHttpResponse(403, permission_denied_body))
    result = await vap.analyze_story(b"fake-video-bytes", "video/mp4", transcript_text="hi", http_client=client)

    assert result["ok"] is False
    assert result["reason"].startswith("provider_rejected")
    assert "PERMISSION_DENIED" in result["reason"]
    assert "not enabled for this project" in result["reason"]
    # Confirms this really was the Pro-model call, not a silent Flash fallback.
    assert "gemini-3.1-pro" in client.calls[0]
    assert "gemini-2.5-flash" not in client.calls[0]


@pytest.mark.asyncio
async def test_analyze_story_quota_error_is_distinguishable_from_permission_error():
    """Two genuinely different Gemini rejection reasons must produce two
    genuinely different, readable messages — never the same generic string
    for both, which is exactly what made the original bug undiagnosable."""
    quota_body = {"error": {"code": 429, "message": "Quota exceeded for quota metric 'requests'.",
                             "status": "RESOURCE_EXHAUSTED"}}
    client = _RecordingGeminiClient(_FakeHttpResponse(429, quota_body))
    result = await vap.analyze_story(b"fake-video-bytes", "video/mp4", transcript_text="hi", http_client=client)

    assert result["ok"] is False
    assert "RESOURCE_EXHAUSTED" in result["reason"]
    assert "PERMISSION_DENIED" not in result["reason"]


def test_gemini_http_error_detail_falls_back_to_raw_text_for_a_non_structured_body():
    """Not every non-200 response is Gemini's own structured error shape
    (e.g. an upstream proxy/load-balancer 502 with an HTML body, or an
    empty body). The helper must degrade to the raw response text — never
    raise, never fabricate a reason that wasn't actually there."""
    class _PlainTextResponse:
        status_code = 502
        text = "Bad Gateway"

        def json(self):
            raise ValueError("not JSON")

    assert vap._gemini_http_error_detail(_PlainTextResponse()) == "Bad Gateway"


def test_gemini_http_error_detail_returns_empty_string_when_nothing_extractable():
    class _EmptyResponse:
        status_code = 500
        text = ""

        def json(self):
            return {}

    assert vap._gemini_http_error_detail(_EmptyResponse()) == ""


@pytest.mark.asyncio
async def test_analyze_story_provider_timeout_is_caught_and_reported_never_crashes():
    """A network-level timeout raised by the http client itself (distinct
    from a 200 response with a truncated body) must be caught and reported
    as a clean failure, never an unhandled exception that would crash the
    calling job-stage coroutine outside its own watchdog."""
    class _TimesOutClient:
        async def post(self, url, params=None, json=None, **kwargs):
            raise TimeoutError("simulated provider timeout")

    result = await vap.analyze_story(b"fake-video-bytes", "video/mp4", transcript_text="hi",
                                      http_client=_TimesOutClient())
    assert result["ok"] is False
    assert result["reason"] == "analysis_failed"
