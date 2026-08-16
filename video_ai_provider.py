"""video_ai_provider.py — Gemini-primary AI engine for the Video Library.

Per explicit product direction (2026-06): Gemini is the PRIMARY AI engine
for this product — speech recognition AND educational analysis. This module
extends the existing Gemini REST integration pattern established by
voice_treasure_gemini.py (raw httpx against generativelanguage.googleapis.com,
GEMINI_API_KEY from env, strict-JSON prompts, normalize-at-the-boundary,
never raise into a route) rather than introducing a second AI ecosystem.

Provider neutrality is preserved: both providers here expose the SAME
duck-typed surface sync_provider.py established (`category`,
`provider_version`, async `align(media_bytes, content_type)` returning
`{"sync": <sync_schema.py canonical document>, "transcriptText": str}`), so
a future specialized ASR vendor can replace GeminiVideoProvider behind the
Universal Synchronization Engine without touching the Video Library.

Two providers:
  GeminiVideoProvider — real Gemini multimodal transcription (audio & video,
      inline for small files, Files API for large ones). Word-level timing
      is derived by length-weighted interpolation inside each Gemini
      sentence segment span — documented honestly in `provider_version`
      ("interp"), with word confidence.alignment left None (unknown), never
      fabricated as 1.0.
  MockVideoProvider — deterministic offline provider used automatically when
      GEMINI_API_KEY is absent (or VIDEO_AI_MOCK=1), so the complete
      pipeline is exercisable in any environment. Its output is clearly
      marked (`provider_version: "mock-asr-v1"`).

Educational analysis (`analyze_transcript`) follows the same pattern: real
Gemini when available, deterministic bounded mock otherwise.

Env:
  GEMINI_API_KEY       — provider key (absent ⇒ mock mode)
  VIDEO_AI_MODEL       — generateContent model for FAST paths: speech
                         recognition (align) and text-only educational
                         analysis (default: gemini-2.5-flash)
  VIDEO_ANALYSIS_MODEL — generateContent model for the DEEP whole-video
                         story/scene understanding path only (analyze_story
                         / analyze_story_raw — default: gemini-3.1-pro)
  VIDEO_AI_MOCK        — "1"/"true" forces mock mode even with a key (testing)

Two deliberately separate model configurations (2026-08 product direction):
speech recognition needs to be fast and cheap (it runs on every upload,
often on long media) — Flash. Whole-story scene/character/emotion
understanding is a single per-lesson call that directly drives narration
performance quality, so it warrants the stronger model. This ONLY affects
this module (video_pipeline_tools.py / video_narration_tools.py are its
only importers — verified, not assumed) via a video-library-specific env
var; it shares no configuration with GEMINI_MODEL, which is what every
OTHER EduHub Gemini integration (Book Factory, EduTalk, the AI Assistant,
premium_ai_tools, etc.) reads independently. Changing either model
constant here cannot affect any of those other systems.
"""
from __future__ import annotations

import base64
import json
import logging
import os
import re
from typing import Any

import httpx

from sync_schema import (
    build_confidence,
    build_paragraph,
    build_sentence,
    build_sync_document,
    build_word,
)
from video_scene_schema import normalize_script_blueprint, normalize_story_analysis

log = logging.getLogger("eduhub.video_ai")

_TRUEY = {"1", "true", "yes", "on"}


def _gen_url(model: str, api_version: str) -> str:
    return f"https://generativelanguage.googleapis.com/{api_version}/models/{model}:generateContent"


_FILES_UPLOAD_URL = "https://generativelanguage.googleapis.com/upload/v1beta/files"
_FILES_GET_URL = "https://generativelanguage.googleapis.com/v1beta/{name}"
_INLINE_MAX_BYTES = 15 * 1024 * 1024  # above this, use the Gemini Files API
_ALIGN_TIMEOUT = httpx.Timeout(480.0, connect=15.0)
_ANALYZE_TIMEOUT = httpx.Timeout(120.0, connect=10.0)

DEFAULT_MODEL = "gemini-2.5-flash"
# Speech recognition / text-only analysis path — every OTHER Gemini 2.x
# call site in this codebase uses this same version, all confirmed still
# working.
DEFAULT_API_VERSION = "v1beta"

# Deep whole-video story/scene analysis ONLY — never used for speech
# recognition or any other Gemini call in this module. See the module
# docstring's "Two deliberately separate model configurations" note.
#
# 2026-08-16, part 1: "gemini-2.5-pro" is the same retired model id
# confirmed dead in production for assessment_ai_provider.py's submission
# extraction (real Render log: {"code": 404, "status": "NOT_FOUND",
# "message": "This model models/gemini-2.5-pro is no longer available to
# new users..."}). The retirement is at the model-id/account level, not
# per call site, so it applies here identically (same GEMINI_API_KEY, same
# generateContent endpoint). Replaced with "gemini-3.1-pro" to match that
# fix. Override via VIDEO_ANALYSIS_MODEL without a redeploy if needed.
#
# 2026-08-16, part 2: the corrected model id STILL 404'd — {"status":
# "NOT_FOUND", "message": "models/gemini-3.1-pro is not found for API
# version v1beta, or is not supported for generateContent..."}. Root cause
# was the API VERSION, not the model id — this codebase already has a
# LOCKED, tested precedent for exactly this: book_factory_image.py's
# "gemini-3.1-flash-image" (same 3.1 generation) is explicitly pinned to
# the stable "v1" endpoint per an explicit product decision, with its own
# regression test locking the endpoint/model shape. The deep-analysis path
# now uses v1 to match that established, working precedent. Override via
# VIDEO_ANALYSIS_API_VERSION without a redeploy if Google's versioning
# policy shifts again.
DEFAULT_ANALYSIS_MODEL = "gemini-3.1-pro"
DEFAULT_ANALYSIS_API_VERSION = "v1"


def _env(name: str) -> str:
    return (os.environ.get(name) or "").strip()


def _api_key() -> str:
    return _env("GEMINI_API_KEY")


def _model() -> str:
    return _env("VIDEO_AI_MODEL") or DEFAULT_MODEL


def _api_version() -> str:
    return _env("VIDEO_AI_API_VERSION") or DEFAULT_API_VERSION


def _analysis_model() -> str:
    """Model for GeminiVideoProvider.analyze_story_raw ONLY — deliberately
    independent of _model()/VIDEO_AI_MODEL (speech recognition) so a future
    change to either never silently affects the other."""
    return _env("VIDEO_ANALYSIS_MODEL") or DEFAULT_ANALYSIS_MODEL


def _analysis_api_version() -> str:
    """API version for the deep-analysis path ONLY — deliberately
    independent of _api_version()/VIDEO_AI_API_VERSION (speech
    recognition), same reasoning as _analysis_model()."""
    return _env("VIDEO_ANALYSIS_API_VERSION") or DEFAULT_ANALYSIS_API_VERSION


def _mock_forced() -> bool:
    return _env("VIDEO_AI_MOCK").lower() in _TRUEY


def ai_available() -> bool:
    return bool(_api_key()) and not _mock_forced()


# ── shared timing helpers ────────────────────────────────────────────────
def parse_time_sec(value: Any) -> float:
    """Coerce a Gemini-supplied time into seconds. Accepts numbers, numeric
    strings, and "MM:SS(.ms)" / "HH:MM:SS" strings (Gemini occasionally
    answers in clock notation despite instructions)."""
    if isinstance(value, (int, float)):
        return max(0.0, float(value))
    if isinstance(value, str):
        s = value.strip()
        if re.fullmatch(r"\d+(\.\d+)?", s):
            return max(0.0, float(s))
        m = re.fullmatch(r"(?:(\d+):)?(\d{1,2}):(\d{1,2}(?:\.\d+)?)", s)
        if m:
            h = int(m.group(1) or 0)
            return max(0.0, h * 3600 + int(m.group(2)) * 60 + float(m.group(3)))
    return 0.0


def distribute_words(text: str, start: float, end: float) -> list[dict]:
    """Length-weighted interpolation of word timings across [start, end].
    Honest estimation, not measurement — confidence.alignment stays None."""
    tokens = [t for t in (text or "").split() if t]
    if not tokens:
        return []
    span = max(0.0, float(end) - float(start))
    weights = [len(t) + 1 for t in tokens]
    total = sum(weights) or 1
    words: list[dict] = []
    cursor = float(start)
    for tok, w in zip(tokens, weights):
        dur = span * (w / total)
        words.append(build_word(
            tok, cursor, cursor + dur,
            confidence=build_confidence(transcript=None, alignment=None),
        ))
        cursor += dur
    if words:
        words[-1]["end"] = round(float(end), 3)
    return words


def segments_to_sync(segments: list[dict], *, provider_category: str,
                     provider_version: str, generated_at: str) -> dict:
    """Build a canonical sync document from sentence segments
    (`{speaker, start, end, text}`). Paragraph boundaries: a speaker change
    or a silence gap > 2.0s starts a new paragraph — an honest structural
    grouping derived from real timing/diarization data.

    Root-cause fix for a real karaoke defect: the ASR prompt instructs
    Gemini to return segments "in chronological order", but that is a
    REQUEST, not a guarantee — a multimodal transcription of a longer/
    complex video can genuinely come back with one segment out of order.
    Every downstream consumer (this function's own paragraph-boundary
    logic, and the frontend's syncConsumption.js binary search, which
    documents "`units` must be sorted ascending by start" as a precondition
    it does not itself enforce) silently assumes chronological order. If
    Gemini violates it, the LAST array entry is not the chronologically
    last sentence, so build_paragraph/build_sentence's own "last item's end
    is the document's end" logic produces a document whose real final
    timestamp is wrong (too early) — which is exactly what made the
    student-facing karaoke highlight appear to "jump to the end" almost
    immediately: the frontend's own "have we reached the end" check
    (`timeSec >= last.end`) starts firing as soon as playback passes that
    one out-of-place segment's small end time, and never recovers for the
    rest of the video. Sorting by the segment's OWN reported start time
    here — once, at the single point every sync document is built from raw
    provider segments — makes every downstream consumer's chronological-
    order assumption actually true, instead of merely hoped for."""
    sentences_by_para: list[list[dict]] = []
    current: list[dict] = []
    prev_speaker: object = object()
    prev_end = 0.0
    s_idx = 0
    speaker_ids: list[str] = []

    ordered_segments = sorted(
        (seg for seg in segments if isinstance(seg, dict)),
        key=lambda seg: parse_time_sec(seg.get("start")),
    )

    for seg in ordered_segments:
        text = str(seg.get("text") or "").strip()
        if not text:
            continue
        start = parse_time_sec(seg.get("start"))
        end = max(start, parse_time_sec(seg.get("end")))
        speaker = str(seg.get("speaker") or "").strip() or None
        if speaker and speaker not in speaker_ids:
            speaker_ids.append(speaker)
        words = distribute_words(text, start, end)
        if not words:
            continue
        s_idx += 1
        sentence = build_sentence(f"s{s_idx}", words, speaker_id=speaker)
        if current and (speaker != prev_speaker or (start - prev_end) > 2.0):
            sentences_by_para.append(current)
            current = []
        current.append(sentence)
        prev_speaker = speaker
        prev_end = end
    if current:
        sentences_by_para.append(current)

    paragraphs = [
        build_paragraph(f"p{i + 1}", sents)
        for i, sents in enumerate(sentences_by_para)
    ] or [build_paragraph("p1", [])]

    duration = paragraphs[-1]["end"] if sentences_by_para else 0.0
    speakers = [{"id": sid, "label": sid} for sid in speaker_ids] or None
    return build_sync_document(
        media_ref="",
        provider_category=provider_category,
        provider_version=provider_version,
        paragraphs=paragraphs,
        generated_at=generated_at,
        duration_sec=duration,
        speakers=speakers,
    )


def _extract_json(text: str) -> Any:
    if not isinstance(text, str):
        return None
    m = re.search(r"[\[{].*[\]}]", text, re.DOTALL)
    if not m:
        return None
    try:
        return json.loads(m.group(0))
    except Exception:  # noqa: BLE001
        return None


def _candidate_text(payload: dict) -> str:
    try:
        parts = payload["candidates"][0]["content"]["parts"]
    except Exception:  # noqa: BLE001
        return ""
    return "".join(p.get("text", "") for p in parts if isinstance(p, dict))


def _response_diagnostics(payload: Any) -> str:
    """Extracts REAL, Gemini-reported reasons a response produced no usable
    text — never fabricated — so a downstream parse failure is actually
    diagnosable instead of a bare, indistinguishable "no parsable segments"
    that could equally mean a safety block, a truncated (MAX_TOKENS)
    response, or a genuinely malformed reply. Returns "" when the payload
    carries no extra diagnostic signal beyond a normal-looking response."""
    if not isinstance(payload, dict):
        return "response was not a JSON object"
    feedback = payload.get("promptFeedback")
    block_reason = feedback.get("blockReason") if isinstance(feedback, dict) else None
    if block_reason:
        return f"blockReason={block_reason}"
    candidates = payload.get("candidates")
    if not candidates:
        return "no candidates returned"
    first = candidates[0] if isinstance(candidates[0], dict) else {}
    finish_reason = first.get("finishReason")
    if finish_reason and finish_reason != "STOP":
        return f"finishReason={finish_reason}"
    return ""


def _gemini_http_error_detail(response) -> str:
    """Extracts the REAL provider-reported reason from a non-200 Gemini
    response body — never fabricated, never guessed. Distinct from
    _response_diagnostics above (which reads a 200-but-unusable response's
    promptFeedback/finishReason): a non-200 HTTP status carries a
    different body shape entirely — Gemini's REST API returns a structured
    {"error": {"code", "message", "status"}} object on failure (e.g.
    status=PERMISSION_DENIED for a model the API key can't access,
    RESOURCE_EXHAUSTED for quota, INVALID_ARGUMENT for a bad/expired media
    reference). Falls back to the raw response text (bounded) when the
    body isn't that shape, and to "" when nothing is extractable — a
    caller must never turn that into a fabricated explanation, only an
    honest bare HTTP status."""
    try:
        body = response.json()
    except Exception:  # noqa: BLE001
        text = (getattr(response, "text", "") or "").strip()
        return text[:300]
    error = body.get("error") if isinstance(body, dict) else None
    if isinstance(error, dict):
        status = str(error.get("status") or "").strip()
        message = str(error.get("message") or "").strip()
        if status and message:
            return f"{status}: {message}"
        return status or message
    text = (getattr(response, "text", "") or "").strip()
    return text[:300]


class VideoAiError(Exception):
    def __init__(self, code: str, message: str = "") -> None:
        super().__init__(message or code)
        self.code = code
        self.message = message or code


# ── Gemini provider ──────────────────────────────────────────────────────
_ASR_PROMPT = (
    "You are a professional transcription engine for an English-learning "
    "platform. Transcribe the attached media EXACTLY as spoken.\n"
    "Output STRICT JSON only — no markdown, no commentary:\n"
    '{"language": "<ISO code>", "segments": [\n'
    '  {"speaker": "S1", "start": <seconds as number>, "end": <seconds as number>, "text": "<one sentence>"}\n'
    "]}\n"
    "Rules:\n"
    "- One segment per natural spoken sentence, in chronological order.\n"
    "- start/end are SECONDS from the beginning of the media, as numbers (e.g. 12.4), never clock strings.\n"
    "- If there are multiple speakers, label them consistently S1, S2, S3…; if one speaker, use S1 for every segment.\n"
    "- Include every spoken word. Do not summarize, translate, or censor.\n"
    "- If the media contains no speech, return {\"language\": \"en\", \"segments\": []}."
)


_STORY_PROMPT_TEMPLATE = (
    "You are a professional story analyst for an English-learning video "
    "platform. You have the FULL video attached, plus its already-"
    "transcribed dialogue below (if any) for speaker-id reference. Analyze "
    "the WHOLE story as one continuous narrative — never analyze isolated "
    "fragments in isolation from what came before.\n"
    "IMPORTANT: the video may contain NO AUDIO AT ALL — no dialogue, "
    "narration, music, or sound effects. This is a normal, fully supported "
    "case, not an error. Do NOT depend on dialogue, transcript, narration, "
    "music, or sound effects to understand the story — analyze the visual "
    "footage directly: character actions, facial expressions, body "
    "language, environment, objects, and how the scene visually changes. "
    "If the transcript below is empty, that means the source is silent or "
    "has no speech — proceed with visual-only analysis; leave "
    "audioObservations fields empty rather than inventing sounds, and "
    "leave a scene's speakers empty rather than inventing a speaker.\n"
    "Output STRICT JSON only — no markdown, with EXACTLY these keys:\n"
    "{{\n"
    '  "summary": "<2-4 sentence overview of the whole story>",\n'
    '  "narrativeArc": "<1-2 sentences: setup / development / conflict / resolution>",\n'
    '  "characters": [{{"name": "<name or role>", "description": "<who they are>"}}],\n'
    '  "scenes": [\n'
    '    {{"start": <seconds as number>, "end": <seconds as number>, '
    '"title": "<short title>", "description": "<1-2 sentences>", '
    '"characters": ["<name>"], "speakers": ["<speaker id from the transcript, e.g. S1>"], '
    '"narrativeRole": "<one of setup,development,conflict,climax,resolution,other>", '
    '"audioObservations": {{"dialogue": "<what speech you hear, or empty>", '
    '"music": "<any music you hear, or empty>", "ambience": "<background/room tone, or empty>", '
    '"sfx": "<any sound effects, or empty>"}}, '
    '"emotionalContext": "<who feels what and why in this scene, and how the characters relate '
    'to each other here — 1 sentence, or empty if purely factual/narration>", '
    '"visualEvents": [{{"timestamp": <seconds as number, within this scene\'s start/end>, '
    '"description": "<one short, concrete visual beat you can actually see, e.g. '
    '\'Daniel closes the laptop\'>"}}]}}\n'
    "  ]\n"
    "}}\n"
    "Rules:\n"
    "- Scenes must be in chronological order and together cover the whole video.\n"
    "- Reuse the EXACT SAME speaker ids (S1, S2, ...) the transcript below uses.\n"
    "- A scene with no dialogue (pure narration/action) is still valid — leave speakers empty.\n"
    "- audioObservations describes what you HEAR in the ORIGINAL audio track of this scene — "
    "this is your own listening description, not a claim that those sounds can be isolated. "
    "Leave any field \"\" if you don't notice that layer.\n"
    "- visualEvents is OPTIONAL and SPARSE: include an entry only for a visual beat you can "
    "confidently point to a specific moment for (a character's specific action, a clear scene-"
    "changing event). An empty array is the correct answer for a scene with no such distinct "
    "beat — never invent one to fill the list, and never guess a timestamp you are not confident "
    "about.\n\n"
    "Lesson title: {title}\n\n"
    "Transcript (reference only — analyze the actual attached video, not just this text; "
    "empty means no speech was detected — analyze the video visually):\n{transcript}"
)

_SCRIPT_PROMPT_TEMPLATE = (
    "You are a professional narration/dialogue scriptwriter AND a professional "
    "Khmer translator preparing bilingual materials for Cambodian English "
    "learners. Below is a whole-story analysis of "
    "a lesson video (already understood scene-by-scene, in order) and its "
    "original transcript for reference. Draft a scene-by-scene narration/"
    "dialogue SCRIPT that a voice actor will read aloud over this video.\n"
    "Output STRICT JSON only — no markdown:\n"
    '{{"scenes": [\n'
    '  {{"sceneId": "<EXACT sceneId from the story analysis below>", "lines": [\n'
    '    {{"speaker": "<\'Narrator\' or a character name from the story analysis>", '
    '"text": "<one line to be voiced>", '
    '"emotion": "<a short PERFORMANCE DIRECTION for the voice actor — natural language, '
    "not a single mood word. Describe pace, warmth/restraint, hesitation, and WHY the "
    "line is said given the scene's emotional/relationship context, e.g. "
    '\'Gentle concern, natural conversational pace, a slight hesitation before asking\'>", '
    '"translationKm": "<natural Khmer translation of THIS EXACT line\'s "text" — see the '
    'KHMER TRANSLATION REQUIREMENTS below>"}}\n'
    "  ]}}\n"
    "]}}\n"
    "Rules:\n"
    "- Use the EXACT sceneId values from the story analysis — do not invent new ones.\n"
    "- Every scene must appear, even if its lines array is empty.\n"
    "- Write natural, concise lines appropriate for the CEFR level implied by the transcript.\n"
    "- A later scene's narration MAY reference what happened in earlier scenes — you have the "
    "whole story below, not just this one scene.\n"
    "- 'Narrator' is always a valid speaker for scene-setting/description lines.\n"
    "- Ground each line's performance direction in the scene's actual emotionalContext/"
    "relationships, not a generic label — two lines with the same one-word mood should still "
    "get different, specific direction if the context differs.\n\n"
    "KHMER TRANSLATION REQUIREMENTS (translationKm) — read carefully:\n"
    "- Translate the INTENDED MEANING of the line you just wrote, in its scene/story context, "
    "never word-by-word — you have the whole story analysis below, use it.\n"
    "- Preserve character names and important terminology as-is or with a natural Khmer "
    "rendering — never invent or omit meaning.\n"
    "- Use natural, everyday Cambodian Khmer, not overly formal literary Khmer, unless the "
    "scene's own tone is formal.\n"
    "- Keep the translation concise enough to read comfortably on one phone screen line — a "
    "short line should stay a short Khmer sentence.\n"
    "- translationKm must translate the exact \"text\" you wrote for that same line, never a "
    "different or paraphrased version of it.\n\n"
    "Lesson title: {title}\n\n"
    "Story analysis (JSON):\n{story_json}\n\n"
    "Original transcript (reference only):\n{transcript}"
)


def _mock_story_analysis(transcript_text: str) -> dict:
    """Deterministic offline stand-in — same discipline as _mock_learning:
    clearly a stub (single generic scene), never pretends to be real
    visual/narrative understanding."""
    from video_scene_schema import build_scene, build_story_analysis
    return build_story_analysis(
        summary="Offline mock story analysis — enable Gemini for real scene/character understanding.",
        characters=[{"name": "S1", "description": "(mock — speaker from transcript)"}],
        scenes=[build_scene(
            start=0.0, end=0.0, title="Full lesson (mock — not scene-split)",
            description="Mock mode does not perform real visual scene detection.",
            speakers=["S1"], narrative_role="other",
            audio_observations={
                "dialogue": "(mock — enable Gemini for real audio observations)",
                "music": "", "ambience": "", "sfx": "",
            },
            emotional_context="(mock mode — enable Gemini for real emotional/relationship context)",
        )],
        narrative_arc="(mock mode — enable Gemini for a real narrative arc)",
        engine="mock",
    )


def _mock_script_blueprint(scene_ids_in_order: list[str]) -> dict:
    from video_scene_schema import build_scene_script, build_script_blueprint, build_script_line
    scenes = [
        build_scene_script(scene_id=sid, lines=[
            build_script_line(
                speaker="Narrator", text="(mock — enable Gemini for a real drafted script)",
                emotion="(mock mode — enable Gemini for real performance direction)",
            ),
        ])
        for sid in scene_ids_in_order
    ]
    return build_script_blueprint(scenes=scenes, engine="mock")


async def analyze_story(media_bytes: bytes, content_type: str, *, transcript_text: str,
                         title: str = "", http_client=None) -> dict:
    """Mode A whole-story Gemini analysis. Returns
        {"ok": True, "storyAnalysis": <contract>, "engine": "gemini"|"mock"}
        {"ok": False, "reason": ...}
    Never raises. No fallback to any other AI provider — if Gemini is
    unavailable and mock mode is not forced by env, real production calls
    will simply return {"ok": False, "reason": "no_api_key"} rather than
    silently substituting a different vendor."""
    if not media_bytes:
        return {"ok": False, "reason": "empty_media"}
    if not ai_available():
        return {"ok": True, "storyAnalysis": _mock_story_analysis(transcript_text), "engine": "mock"}
    try:
        # Deep story/scene understanding gets its OWN model (gemini-3.1-pro
        # by default, see _analysis_model()) — a separate GeminiVideoProvider
        # instance from whatever get_video_ai_provider() hands the ASR path,
        # constructed fresh right here so the override can never leak into
        # any other call site.
        provider = GeminiVideoProvider(http_client=http_client, model=_analysis_model(),
                                        api_version=_analysis_api_version())
        raw_text, raw_payload = await provider.analyze_story_raw(
            media_bytes, content_type, transcript_text=transcript_text, title=title,
        )
        analysis = normalize_story_analysis(raw_text, extract_json=_extract_json)
        if analysis is None:
            # Same diagnosability as align()'s ASR path: a safety block or a
            # MAX_TOKENS truncation must never look identical to a genuinely
            # malformed reply — surface the REAL Gemini-reported reason
            # (never fabricated) instead of a bare, indistinguishable
            # "bad_response" that the Studio's Story Analysis lastError
            # would otherwise show for every failure mode alike.
            diag = _response_diagnostics(raw_payload)
            log.warning("video-ai: story analysis unparsable | model=%s | %s | text_tail=%r",
                        _analysis_model(), diag or "no diagnostic", raw_text[-300:])
            reason = "bad_response" + (f" ({diag})" if diag else "")
            return {"ok": False, "reason": reason}
        import datetime as _dt
        analysis["generatedAt"] = _dt.datetime.now(_dt.timezone.utc).strftime("%Y-%m-%dT%H:%M:%SZ")
        analysis["engine"] = "gemini"
        return {"ok": True, "storyAnalysis": analysis, "engine": "gemini"}
    except VideoAiError as exc:
        # exc.message carries the real, provider-reported detail (see
        # analyze_story_raw's non-200 branch) — surfacing only exc.code
        # here used to collapse every distinct rejection reason (quota,
        # permission, invalid media, safety block...) down to the same
        # bare, undiagnosable "provider_rejected" string in the Studio UI.
        reason = exc.code
        if exc.message and exc.message != exc.code:
            reason = f"{exc.code}: {exc.message}"
        return {"ok": False, "reason": reason}
    except Exception as exc:  # noqa: BLE001
        log.warning("video-ai: story analysis error %s", type(exc).__name__)
        return {"ok": False, "reason": "analysis_failed"}


async def draft_script_blueprint(story_analysis: dict, *, transcript_text: str = "",
                                  title: str = "", http_client=None) -> dict:
    """Mode B script blueprint draft, GROUNDED in the whole-story analysis
    (never scene-by-scene in isolation — Gemini sees every scene at once,
    so a later scene's narration can reference earlier ones). Returns
        {"ok": True, "scriptBlueprint": <contract>, "engine": "gemini"|"mock"}
        {"ok": False, "reason": ...}
    Never raises. No fallback to any other AI provider."""
    scenes = (story_analysis or {}).get("scenes") or []
    scene_ids = [sc["sceneId"] for sc in scenes if isinstance(sc, dict) and sc.get("sceneId")]
    if not scene_ids:
        return {"ok": False, "reason": "no_scenes"}

    if not ai_available():
        return {"ok": True, "scriptBlueprint": _mock_script_blueprint(scene_ids), "engine": "mock"}

    try:
        prompt = _SCRIPT_PROMPT_TEMPLATE.format(
            title=title or "Untitled lesson",
            story_json=json.dumps(story_analysis)[:20000],
            transcript=(transcript_text or "")[:16000],
        )
        body = {
            "contents": [{"role": "user", "parts": [{"text": prompt}]}],
            "generationConfig": {"temperature": 0.4, "responseMimeType": "application/json"},
        }
        # Deep-path model (gemini-3.1-pro by default, see _analysis_model),
        # the SAME override used for the whole-video Story Analysis call
        # above — script drafting is grounded in that same full-story
        # context (and now also drafts the line's Khmer translation in the
        # same response), so it gets the same model quality. This is a
        # deliberate move OFF the ASR/Flash model (_model()) for this call
        # specifically; the ASR speech-recognition path itself is untouched.
        blueprint_url = _gen_url(_analysis_model(), _analysis_api_version())
        if http_client is not None:
            r = await http_client.post(blueprint_url, params={"key": _api_key()}, json=body)
        else:
            async with httpx.AsyncClient(timeout=_ANALYZE_TIMEOUT) as cli:
                r = await cli.post(blueprint_url, params={"key": _api_key()}, json=body)
        if r.status_code != 200:
            detail = _gemini_http_error_detail(r)
            log.warning("video-ai: script-blueprint HTTP %s | model=%s | api_version=%s | body=%s",
                        r.status_code, _analysis_model(), _analysis_api_version(), (r.text or "")[:300])
            reason = "provider_rejected" + (f": Gemini HTTP {r.status_code} — {detail}" if detail else f": Gemini HTTP {r.status_code}")
            return {"ok": False, "reason": reason}
        blueprint = normalize_script_blueprint(
            _candidate_text(r.json()), scene_ids, extract_json=_extract_json,
        )
        if blueprint is None:
            return {"ok": False, "reason": "bad_response"}
        blueprint["engine"] = "gemini"
        return {"ok": True, "scriptBlueprint": blueprint, "engine": "gemini"}
    except Exception as exc:  # noqa: BLE001
        log.warning("video-ai: script blueprint error %s", type(exc).__name__)
        return {"ok": False, "reason": "draft_failed"}


class GeminiVideoProvider:
    """Speech Recognition capability via Gemini multimodal understanding —
    the Video Library's primary engine per product direction."""

    category = "speech_recognition"

    def __init__(self, *, api_key: str | None = None, model: str | None = None,
                 api_version: str | None = None, http_client=None):
        self._api_key = api_key or _api_key()
        self._model = model or _model()
        # Defaults to the ASR/speech-recognition version (v1beta) — callers
        # constructing this provider for the deep-analysis path pass
        # api_version=_analysis_api_version() explicitly (see analyze_story).
        self._api_version = api_version or _api_version()
        self._http_client = http_client  # injectable for tests
        if not self._api_key:
            raise VideoAiError("no_api_key", "GEMINI_API_KEY is not configured")

    @property
    def provider_version(self) -> str:
        return f"gemini-video-asr-v1 ({self._model}, word-interp)"

    async def _post(self, url: str, **kwargs) -> httpx.Response:
        if self._http_client is not None:
            return await self._http_client.post(url, **kwargs)
        async with httpx.AsyncClient(timeout=_ALIGN_TIMEOUT) as cli:
            return await cli.post(url, **kwargs)

    async def _get(self, url: str, **kwargs) -> httpx.Response:
        if self._http_client is not None:
            return await self._http_client.get(url, **kwargs)
        async with httpx.AsyncClient(timeout=_ALIGN_TIMEOUT) as cli:
            return await cli.get(url, **kwargs)

    async def _upload_to_files_api(self, media_bytes: bytes, content_type: str) -> str:
        """Gemini Files API raw upload — required for media above the inline
        limit. Returns the file URI once the file reaches ACTIVE state."""
        import asyncio as _asyncio

        r = await self._post(
            _FILES_UPLOAD_URL,
            params={"key": self._api_key},
            headers={
                "X-Goog-Upload-Protocol": "raw",
                "Content-Type": content_type or "application/octet-stream",
            },
            content=media_bytes,
        )
        if r.status_code != 200:
            raise VideoAiError("files_upload_failed", f"Gemini Files API HTTP {r.status_code}: {r.text[:300]}")
        info = (r.json() or {}).get("file") or {}
        uri, name, state = info.get("uri"), info.get("name"), info.get("state")
        if not uri:
            raise VideoAiError("files_upload_failed", "Files API returned no file uri")
        waited = 0.0
        while state == "PROCESSING" and waited < 120.0:
            await _asyncio.sleep(3.0)
            waited += 3.0
            g = await self._get(_FILES_GET_URL.format(name=name), params={"key": self._api_key})
            if g.status_code == 200:
                state = (g.json() or {}).get("state")
        if state not in (None, "ACTIVE"):
            raise VideoAiError("files_processing_failed", f"Files API state: {state}")
        return uri

    async def _media_part(self, media_bytes: bytes, content_type: str) -> dict:
        """Shared inline-vs-Files-API branching used by every media-grounded
        Gemini call this provider makes (ASR, whole-story analysis)."""
        if len(media_bytes) <= _INLINE_MAX_BYTES:
            return {"inline_data": {
                "mime_type": content_type or "application/octet-stream",
                "data": base64.b64encode(media_bytes).decode("ascii"),
            }}
        uri = await self._upload_to_files_api(media_bytes, content_type)
        return {"file_data": {"mime_type": content_type, "file_uri": uri}}

    async def align(self, media_bytes: bytes, content_type: str = "audio/mpeg") -> dict:
        """Transcribe + segment the media into the canonical sync schema.
        Returns {"sync": <canonical doc>, "transcriptText": str}. Raises
        VideoAiError on provider failure — the pipeline decides retry/fail."""
        if not media_bytes:
            raise VideoAiError("empty_media", "no media bytes to transcribe")

        media_part = await self._media_part(media_bytes, content_type)

        body = {
            "contents": [{"role": "user", "parts": [{"text": _ASR_PROMPT}, media_part]}],
            "generationConfig": {"temperature": 0.0, "responseMimeType": "application/json"},
        }
        r = await self._post(
            _gen_url(self._model, self._api_version),
            params={"key": self._api_key}, json=body,
        )
        if r.status_code != 200:
            log.warning("video-ai: ASR HTTP %s | model=%s | api_version=%s | mime=%s | body=%s",
                        r.status_code, self._model, self._api_version, content_type, (r.text or "")[:400])
            raise VideoAiError("provider_rejected",
                                f"Gemini HTTP {r.status_code} (model={self._model}, "
                                f"api_version={self._api_version})")

        raw_payload = r.json()
        text = _candidate_text(raw_payload)
        data = _extract_json(text)
        if isinstance(data, dict):
            segments = data.get("segments")
        elif isinstance(data, list):
            # Gemini sometimes returns the segments array directly at the
            # top level instead of wrapped in {"language":...,"segments":
            # [...]}. This is a real, observed response-shape variance
            # (not a hypothetical one) — a well-formed answer must not be
            # treated as a parsing failure just because it skipped the
            # wrapper object the prompt asked for.
            segments = [s for s in data if isinstance(s, dict)]
        else:
            segments = None
        if segments is None:
            diag = _response_diagnostics(raw_payload)
            log.warning("video-ai: ASR unparsable | model=%s mime=%s | %s | text_tail=%r",
                        self._model, content_type, diag or "no diagnostic", text[-300:])
            detail = "Gemini returned no parsable segments" + (f" ({diag})" if diag else "")
            raise VideoAiError("bad_response", detail)

        import datetime as _dt
        sync = segments_to_sync(
            segments, provider_category=self.category,
            provider_version=self.provider_version,
            generated_at=_dt.datetime.now(_dt.timezone.utc).strftime("%Y-%m-%dT%H:%M:%SZ"),
        )
        transcript = " ".join(
            str(s.get("text") or "").strip() for s in segments if str(s.get("text") or "").strip()
        )
        return {"sync": sync, "transcriptText": transcript}

    async def analyze_story_raw(self, media_bytes: bytes, content_type: str, *,
                                 transcript_text: str, title: str = "") -> tuple[str, dict]:
        """Whole-video story understanding (Mode A): the SAME uploaded
        media Gemini already transcribed, re-sent with the already-computed
        transcript as grounding context, so scene/character detection is
        genuinely visual+narrative understanding of the full video — never
        scene-by-scene in isolation. Returns (raw model text, raw response
        payload) — the caller normalizes the text via video_scene_schema.
        normalize_story_analysis, and can compute _response_diagnostics
        against the payload on a parse failure (a safety block or a
        MAX_TOKENS truncation must never look like an indistinguishable
        "bad response" — see align()'s identical pattern). Raises
        VideoAiError on provider failure."""
        if not media_bytes:
            raise VideoAiError("empty_media", "no media bytes to analyze")
        media_part = await self._media_part(media_bytes, content_type)
        prompt = _STORY_PROMPT_TEMPLATE.format(
            title=title or "Untitled lesson", transcript=(transcript_text or "")[:24000],
        )
        body = {
            "contents": [{"role": "user", "parts": [{"text": prompt}, media_part]}],
            "generationConfig": {"temperature": 0.2, "responseMimeType": "application/json"},
        }
        r = await self._post(
            _gen_url(self._model, self._api_version),
            params={"key": self._api_key}, json=body,
        )
        if r.status_code != 200:
            detail = _gemini_http_error_detail(r)
            log.warning("video-ai: story-analysis HTTP %s | model=%s | api_version=%s | body=%s",
                        r.status_code, self._model, self._api_version, (r.text or "")[:400])
            # The real, provider-reported reason (e.g. "PERMISSION_DENIED:
            # ... model is not enabled for this project") reaches the
            # Studio's lastError field via this message — never collapsed
            # down to a bare "provider_rejected" the way it used to be.
            # Model + api_version are both included so a future
            # misconfiguration of EITHER is immediately diagnosable.
            message = (f"Gemini HTTP {r.status_code} (model={self._model}, "
                        f"api_version={self._api_version})" + (f" — {detail}" if detail else ""))
            raise VideoAiError("provider_rejected", message)
        raw_payload = r.json()
        return _candidate_text(raw_payload), raw_payload


# ── Mock provider (no key required — pipeline always exercisable) ────────
_MOCK_SEGMENTS = [
    {"speaker": "S1", "start": 0.0, "end": 4.2,
     "text": "Welcome to this English lesson, and thank you for joining me today."},
    {"speaker": "S1", "start": 4.2, "end": 9.1,
     "text": "In this video we are going to practice everyday conversation skills."},
    {"speaker": "S2", "start": 9.6, "end": 13.4,
     "text": "That sounds great, could you give us a simple example first?"},
    {"speaker": "S1", "start": 13.4, "end": 18.9,
     "text": "Of course, imagine you walk into a coffee shop and want to order a drink."},
    {"speaker": "S2", "start": 19.3, "end": 23.0,
     "text": "I would say, hello, could I have a small coffee to go, please?"},
    {"speaker": "S1", "start": 23.0, "end": 27.8,
     "text": "Perfect, that is polite, natural, and exactly how native speakers order."},
]


class MockVideoProvider:
    """Deterministic offline stand-in used when GEMINI_API_KEY is absent.
    Clearly marked in provider_version — never pretends to be real ASR."""

    category = "speech_recognition"
    provider_version = "mock-asr-v1"

    async def align(self, media_bytes: bytes, content_type: str = "audio/mpeg") -> dict:
        import datetime as _dt
        sync = segments_to_sync(
            _MOCK_SEGMENTS, provider_category=self.category,
            provider_version=self.provider_version,
            generated_at=_dt.datetime.now(_dt.timezone.utc).strftime("%Y-%m-%dT%H:%M:%SZ"),
        )
        transcript = " ".join(s["text"] for s in _MOCK_SEGMENTS)
        return {"sync": sync, "transcriptText": transcript}


def get_video_ai_provider():
    """Provider selection — the ONE place mock-vs-real is decided."""
    if ai_available():
        return GeminiVideoProvider()
    return MockVideoProvider()


# ── Educational analysis (Gemini enrichment) ─────────────────────────────
# Bilingual (Khmer) learning layer — a Video Library capability, additive
# to the existing English-only `learning` contract and the shared
# sync_schema.py document. Generated in this SAME Gemini call (never a
# second, per-sentence request — cost-safe, per product direction) by
# giving Gemini the REAL, already-timed sentence units (id + English text)
# from the sync document and requiring it to return a translation keyed by
# THAT exact id — never positional matching, which would silently
# mismatch if Gemini's own sentence splitting differs from the ASR
# alignment's. See normalize_sentence_translations for the sanitization
# boundary and video_pipeline_tools.py for how a malformed/absent
# translation can never sink the English lesson.
MAX_TRANSLATION_SENTENCES = 200        # bounds prompt size and Gemini output on a very long lesson
MAX_TRANSLATION_CHARS = 500            # a mobile teleprompter line, not a paragraph


def sentences_from_sync_document(sync_doc: dict | None) -> list[dict]:
    """Real sentence units (id + English text, reconstructed from the
    already-aligned words — never re-derived timing) from a sync_schema.py
    document, for handing to Gemini as translation input. Pure, no I/O."""
    out: list[dict] = []
    if not isinstance(sync_doc, dict):
        return out
    for paragraph in sync_doc.get("paragraphs") or []:
        if not isinstance(paragraph, dict):
            continue
        for sentence in paragraph.get("sentences") or []:
            if not isinstance(sentence, dict):
                continue
            sid = sentence.get("id")
            text = " ".join(str(w.get("word", "")) for w in (sentence.get("words") or []) if isinstance(w, dict)).strip()
            if sid and text:
                out.append({"id": str(sid), "text": text})
            if len(out) >= MAX_TRANSLATION_SENTENCES:
                return out
    return out


def normalize_sentence_translations(raw: Any, valid_sentence_ids: set[str]) -> list[dict]:
    """Sanitization boundary for Gemini's per-sentence Khmer output (Video
    Library Directive §19's exact hazards): drops any entry whose
    sentenceId doesn't correspond to a REAL sentence in THIS lesson's own
    sync document (never trust an id Gemini invented or mis-copied), bounds
    translation length so a runaway response can't blow up a mobile
    teleprompter line, and returns [] — never raises — for anything
    malformed, so a translation failure can never destroy the English
    lesson (see analyze_transcript's docstring)."""
    if not isinstance(raw, list):
        return []
    out: list[dict] = []
    seen: set[str] = set()
    for item in raw:
        if not isinstance(item, dict):
            continue
        sid = str(item.get("sentenceId") or "").strip()
        km = str(item.get("translationKm") or "").strip()
        if not sid or not km or sid not in valid_sentence_ids or sid in seen:
            continue
        seen.add(sid)
        out.append({"sentenceId": sid, "translationKm": km[:MAX_TRANSLATION_CHARS]})
        if len(out) >= MAX_TRANSLATION_SENTENCES:
            break
    return out


_ANALYSIS_PROMPT_TEMPLATE = (
    "You are an expert English-language curriculum designer AND a professional "
    "Khmer translator preparing bilingual materials for Cambodian English "
    "learners. Analyze the following lesson transcript for adult English "
    "learners and output STRICT JSON only — no markdown, with EXACTLY these keys:\n"
    "{{\n"
    '  "cefrLevel": "<one of A1,A2,B1,B2,C1,C2>",\n'
    '  "summary": "<2-3 sentence learning summary>",\n'
    '  "description": "<1-2 sentence catalog description for students>",\n'
    '  "learningObjectives": ["<objective>", "..."],\n'
    '  "vocabulary": [{{"word": "<word>", "definition": "<simple definition>", '
    '"example": "<example sentence>", "meaningKm": "<natural Khmer meaning, not a literal '
    'word-for-word translation of the English definition>", '
    '"usageKm": "<short Khmer note on how/when a Cambodian learner would use this word>"}}],\n'
    '  "difficultWords": ["<word>", "..."],\n'
    '  "phrasalVerbs": [{{"phrase": "<phrasal verb>", "meaning": "<meaning>"}}],\n'
    '  "idioms": [{{"phrase": "<idiom>", "meaning": "<meaning>"}}],\n'
    '  "keyExpressions": ["<useful expression>", "..."],\n'
    '  "grammarPoints": [{{"point": "<grammar structure>", "explanation": "<short explanation>", '
    '"explanationKm": "<the SAME grammar point explained in natural Khmer, genuinely useful to a '
    'Cambodian learner — not a mechanical translation of the English explanation>"}}],\n'
    '  "conversationType": "<one of conversation,storytelling,monologue,interview>",\n'
    '  "estimatedStudyMinutes": <integer>,\n'
    '  "speakerLabels": {{"S1": "<suggested role label, e.g. Teacher>", "S2": "<...>"}},\n'
    '  "sentenceTranslations": [{{"sentenceId": "<id from the sentence list below, copied exactly>", '
    '"translationKm": "<natural Khmer translation>"}}]\n'
    "}}\n"
    "Only include items that genuinely appear in the transcript — empty "
    "lists are correct when a category is absent. Keep definitions simple "
    "enough for the estimated CEFR level.\n\n"
    "KHMER TRANSLATION REQUIREMENTS (sentenceTranslations) — read carefully:\n"
    "- Translate the INTENDED MEANING of each full sentence in its story context, "
    "never word-by-word. Read the whole transcript first so context (who is "
    "speaking, what already happened) shapes each sentence's translation.\n"
    "- Preserve character names and important terminology as-is or with a "
    "natural Khmer rendering — never invent or omit meaning.\n"
    "- Use natural, everyday Cambodian Khmer, not overly formal literary Khmer, "
    "unless the transcript's own tone is formal.\n"
    "- Keep each translation concise enough to read comfortably on one phone "
    "screen line — a short lesson sentence should stay a short Khmer sentence.\n"
    "- You MUST return exactly one entry per sentence id listed below, using "
    "the id EXACTLY as given — never invent an id, never skip one, never "
    "reorder or merge sentences.\n"
    "- If a 'sentence' is not real spoken content (silence, a sound effect "
    "marker), still return your best natural short Khmer rendering rather "
    "than an empty string.\n\n"
    "Sentences to translate (id: English text):\n{sentences_block}\n\n"
    "Lesson title: {title}\n\nTranscript:\n{transcript}"
)

CEFR_SET = {"A1", "A2", "B1", "B2", "C1", "C2"}
CONVERSATION_TYPES = {"conversation", "storytelling", "monologue", "interview"}


def normalize_learning(raw: Any) -> dict | None:
    """Coerce a model response into the bounded learning contract. Drops
    every non-contract field; bounds every list/string. None = unusable."""
    data = _extract_json(raw) if isinstance(raw, str) else raw
    if not isinstance(data, dict):
        return None

    def s(v, limit=400):
        return str(v)[:limit] if isinstance(v, (str, int, float)) else ""

    def str_list(v, limit=20):
        if not isinstance(v, list):
            return []
        return [s(x, 200) for x in v if s(x, 200)][:limit]

    def pair_list(v, k1, k2, limit=15, k3=None):
        if not isinstance(v, list):
            return []
        out = []
        for item in v:
            if isinstance(item, dict) and s(item.get(k1)):
                entry = {k1: s(item.get(k1), 120), k2: s(item.get(k2), 300)}
                if k3:
                    # Khmer explanation is a genuinely useful learner aid, not a
                    # required field — an empty string when Gemini omits it is
                    # honest (the frontend must show "unavailable", never
                    # fabricate one), never a reason to drop the whole item.
                    entry[k3] = s(item.get(k3), 400)
                out.append(entry)
        return out[:limit]

    vocab = []
    if isinstance(data.get("vocabulary"), list):
        for item in data["vocabulary"]:
            if isinstance(item, dict) and s(item.get("word")):
                vocab.append({
                    "word": s(item.get("word"), 80),
                    "definition": s(item.get("definition"), 300),
                    "example": s(item.get("example"), 300),
                    "meaningKm": s(item.get("meaningKm"), 300),
                    "usageKm": s(item.get("usageKm"), 300),
                })
    cefr = s(data.get("cefrLevel"), 4).upper()
    ctype = s(data.get("conversationType"), 20).lower()
    try:
        study = max(0, min(600, int(data.get("estimatedStudyMinutes") or 0)))
    except Exception:  # noqa: BLE001
        study = 0
    labels = data.get("speakerLabels")
    speaker_labels = (
        {s(k, 20): s(v, 60) for k, v in labels.items() if s(k, 20) and s(v, 60)}
        if isinstance(labels, dict) else {}
    )
    return {
        "cefrLevel": cefr if cefr in CEFR_SET else None,
        "summary": s(data.get("summary"), 800),
        "description": s(data.get("description"), 500),
        "learningObjectives": str_list(data.get("learningObjectives")),
        "vocabulary": vocab[:25],
        "difficultWords": str_list(data.get("difficultWords")),
        "phrasalVerbs": pair_list(data.get("phrasalVerbs"), "phrase", "meaning"),
        "idioms": pair_list(data.get("idioms"), "phrase", "meaning"),
        "keyExpressions": str_list(data.get("keyExpressions")),
        "grammarPoints": pair_list(data.get("grammarPoints"), "point", "explanation", k3="explanationKm"),
        "conversationType": ctype if ctype in CONVERSATION_TYPES else None,
        "estimatedStudyMinutes": study,
        "speakerLabels": speaker_labels,
    }


def _mock_learning(transcript: str) -> dict:
    words = [re.sub(r"[^a-zA-Z'-]", "", w).lower() for w in (transcript or "").split()]
    long_words = sorted({w for w in words if len(w) >= 8})[:8]
    return normalize_learning({
        "cefrLevel": "A2",
        "summary": "This lesson practices polite everyday conversation, including how to "
                   "order in a coffee shop with natural, native-like phrasing.",
        "description": "Practice real everyday English conversation with simple, polite requests.",
        "learningObjectives": [
            "Order food and drinks politely",
            "Use 'could I have…' for polite requests",
            "Follow a natural two-speaker conversation",
        ],
        "vocabulary": [
            {"word": w, "definition": "(generated offline — enable Gemini for real definitions)", "example": ""}
            for w in long_words
        ],
        "difficultWords": long_words,
        "phrasalVerbs": [],
        "idioms": [],
        "keyExpressions": ["Could I have… please?", "To go"],
        "grammarPoints": [{"point": "Polite modals", "explanation": "'Could' softens a request."}],
        "conversationType": "conversation",
        "estimatedStudyMinutes": 10,
        "speakerLabels": {"S1": "Teacher", "S2": "Student"},
    })


async def analyze_transcript(transcript: str, *, sentences: list[dict] | None = None,
                              title: str = "", http_client=None) -> dict:
    """Gemini educational enrichment — English learning content AND, in the
    SAME call (cost-safe, never a second per-sentence request), a Khmer
    translation for each real sentence unit. `sentences` is the sync
    document's own `[{"id", "text"}, ...]` (see sentences_from_sync_
    document) — omit it (or pass []) to skip translation generation
    entirely (e.g. no sync document yet) while still getting the English
    `learning` contract exactly as before this parameter existed.

    Returns {"ok": True, "learning": <contract>, "sentenceTranslations":
    [{"sentenceId", "translationKm"}, ...], "engine": "gemini"|"mock"} or
    {"ok": False, "reason": ...}. Never raises — enrichment failure must
    never sink the whole pipeline, and a malformed/missing translation
    specifically must never take the English `learning` content down with
    it (video_pipeline_tools.py only ever treats `sentenceTranslations` as
    optional, best-effort enrichment)."""
    text = (transcript or "").strip()
    if not text:
        return {"ok": False, "reason": "empty_transcript"}

    valid_sentence_ids = {s["id"] for s in (sentences or []) if isinstance(s, dict) and s.get("id")}

    if not ai_available():
        return {"ok": True, "learning": _mock_learning(text), "sentenceTranslations": [], "engine": "mock"}

    sentences_block = "\n".join(f"{s['id']}: {s['text']}" for s in (sentences or []) if s.get("id") and s.get("text"))
    prompt = _ANALYSIS_PROMPT_TEMPLATE.format(
        title=title or "Untitled lesson", transcript=text[:24000],
        sentences_block=sentences_block or "(no sentence-level translation requested for this call)",
    )
    body = {
        "contents": [{"role": "user", "parts": [{"text": prompt}]}],
        "generationConfig": {"temperature": 0.3, "responseMimeType": "application/json"},
    }
    try:
        analysis_url = _gen_url(_model(), _api_version())
        if http_client is not None:
            r = await http_client.post(analysis_url, params={"key": _api_key()}, json=body)
        else:
            async with httpx.AsyncClient(timeout=_ANALYZE_TIMEOUT) as cli:
                r = await cli.post(analysis_url, params={"key": _api_key()}, json=body)
        if r.status_code != 200:
            log.warning("video-ai: analysis HTTP %s | model=%s | api_version=%s | body=%s",
                        r.status_code, _model(), _api_version(), (r.text or "")[:300])
            return {"ok": False, "reason": "provider_rejected"}
        raw_data = _extract_json(_candidate_text(r.json()))
        learning = normalize_learning(raw_data)
        if learning is None:
            return {"ok": False, "reason": "bad_response"}
        translations = normalize_sentence_translations(
            (raw_data or {}).get("sentenceTranslations") if isinstance(raw_data, dict) else None,
            valid_sentence_ids,
        )
        return {"ok": True, "learning": learning, "sentenceTranslations": translations, "engine": "gemini"}
    except Exception as exc:  # noqa: BLE001
        log.warning("video-ai: analysis error %s", type(exc).__name__)
        return {"ok": False, "reason": "analysis_failed"}
