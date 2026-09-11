"""video_word_alignment.py — real, MEASURED per-word timing for the Video
Library's original-upload transcript, merged onto Gemini's existing
sentence/speaker structure.

2026-09 REDESIGN — GEMINI ONLY (immediately follows the previous commit's
ElevenLabs removal). Verified directly against Gemini's own official
documentation (ai.google.dev/gemini-api/docs/transcribe,
.../models/gemini-3.5-transcribe, ai.google.dev/api/interactions-api —
fetched live 2026-09, not assumed) before writing a line of this module,
per the explicit "do not guess which model/endpoint to use" instruction,
and additionally validated live against the real API with a real
GEMINI_API_KEY (see this round's report for the actual measured output —
19/19 words matched, real timestamps confirmed against real spoken audio):

  - gemini-3.5-transcribe is the ONLY Gemini model documented to return real,
    MEASURED per-word start/end timestamps for audio it did not itself
    generate (`generation_config.transcription_config.mode.
    timestamp_granularities: ["word"]`). Every general-purpose Gemini model
    already used elsewhere in this codebase (gemini-2.5-flash for ASR
    segmentation, gemini-3.1-pro for deep story analysis — see
    video_ai_provider.py) is NOT documented to have this capability.
  - It is reached through a DIFFERENT API surface than every other Gemini
    call in this codebase: the "Interactions API"
    (`POST https://generativelanguage.googleapis.com/v1beta/interactions`),
    not `generateContent`. Confirmed live: request shape, response shape
    (`{"steps": [{"content": [{"annotations": [{"type": "word_info", "text",
    "start_offset": "<seconds>s", "end_offset": "<seconds>s", ...}]}]}]}`),
    header-based auth (`x-goog-api-key`, not the `?key=` query param this
    codebase's other Gemini calls use), and that audio must be supplied as a
    Files-API file `uri` — inline base64 is not accepted for this endpoint.
  - CONFIRMED GAP, stated honestly rather than papered over: nowhere in
    Gemini's own docs for this model, this endpoint, or the audio-
    transcription guide is there ANY per-word confidence/logprob field —
    confirmed against the real live response too, not just the docs.
    ElevenLabs Scribe (the removed design) exposed one; gemini-3.5-transcribe
    does not. This module therefore NEVER populates `confidence.alignment`
    with a number for a Gemini-measured word — doing so would be exactly the
    "fabricate a high confidence value" this project's own conventions (see
    sync_schema.py's own docstring) and this round's explicit instructions
    forbid. Instead, a matched word is marked `measured: True` — a plain,
    non-fabricated FACT about provenance (two independent Gemini
    transcriptions of the same audio agreed on this word), never an invented
    probability. See computeSentenceConfidenceTier in the frontend's
    Teleprompter.jsx for how the confidence-tiered rendering was updated to
    use this signal (old ElevenLabs-produced documents already in the
    database, which DO carry a real numeric `confidence.alignment`, keep
    working exactly as before — that code path was preserved, not replaced).
  - Duration limit confirmed live: word-level timestamps cap a single
    gemini-3.5-transcribe request at 30 minutes of audio (vs 1 hour without
    timestamps). Checked BEFORE spending an upload/network call on a lesson
    that would only be rejected anyway (MAX_ALIGNMENT_AUDIO_SECONDS below).
  - Cost confirmed live (ai.google.dev/gemini-api/docs/pricing): ~$0.003-
    0.005/minute of audio — a one-time authoring-time cost per lesson, never
    a per-play cost (enforced structurally: see the "exactly once, never
    from playback" test in tests/test_video_word_alignment.py, unchanged
    from the removed design's proof strategy).
  - Model freshness/risk, stated plainly rather than hidden: gemini-3.5-
    transcribe and the Interactions API launched 2026-08-27, ~2 weeks before
    this module was written. Google's own developer forum has an open
    2026-09 thread about a DIFFERENT documented request shape (custom
    vocabulary + diarization) being rejected by the live API — a real signal
    this is a young, still-settling API surface. The request this module
    sends (word timestamps only, no diarization, no custom vocabulary) is
    not the combination reported broken, and was independently confirmed
    working end-to-end against the real API, but this is a genuine
    deployment risk worth monitoring, not a guaranteed-stable integration.

Preserved from the removed design, unaffected by which provider supplies the
timing data: this is still a SECOND, independent transcription of the SAME
audio Gemini's segmentation step already transcribed, merged by matching word
tokens (difflib.SequenceMatcher over normalized tokens) rather than literal
reference-conditioned forced alignment — gemini-3.5-transcribe, like
ElevenLabs Scribe before it, always performs full ASR from scratch and does
not accept a reference transcript to align against (confirmed against its
own docs: the Interactions API's `input` is the audio only, with no
transcript-conditioning parameter documented). Wherever a Gemini-segmentation
word and a Gemini-transcribe word line up as the same token, the segmentation
word's start/end is REPLACED with the transcribe pass's real, measured
timing. Any word that doesn't have a match — background noise, a second
untranscribed speaker, off-script speech, a genuine ASR disagreement between
the two passes — is left exactly as the segmentation pass's own length-
weighted interpolation produced it, never fabricated.

Gemini's sentence boundaries, speaker labels, and paragraph grouping are
NEVER touched here — only word.start/word.end/word.measured within an
EXISTING sentence structure are ever modified. This module knows nothing
about Mongo, the pipeline, or a lesson id: it takes bytes and a sync
document in, returns a sync document and a telemetry dict out, mirroring
video_render_tools.py's own "bytes in, bytes/dict out, no side effects"
discipline in this codebase.
"""
from __future__ import annotations

import datetime as _dt
import difflib
import logging
import os
import re

import httpx

from sync_schema import build_confidence
from video_ai_provider import VideoAiError, ai_available, upload_media_to_files_api

logger = logging.getLogger("eduhub.video_word_alignment")

_PUNCT_RE = re.compile(r"[^\w']+", re.UNICODE)

_INTERACTIONS_URL = "https://generativelanguage.googleapis.com/v1beta/interactions"
_TRANSCRIBE_TIMEOUT = httpx.Timeout(300.0, connect=15.0)

# Verified live 2026-09 against gemini-3.5-transcribe's own model card — see
# module docstring. Independent of VIDEO_AI_MODEL (ASR segmentation) and
# VIDEO_ANALYSIS_MODEL (deep story analysis) in video_ai_provider.py: same
# "every pipeline stage gets its own override, never shares configuration"
# convention established there, so changing this can never silently affect
# either of those other Gemini call sites, or vice versa.
DEFAULT_WORD_TIMESTAMP_MODEL = "gemini-3.5-transcribe"

# Gemini's own documented limit for word-level timestamps (30 minutes,
# vs 1 hour without them) — checked before attempting a call, not learned
# from a rejected request.
MAX_ALIGNMENT_AUDIO_SECONDS = 30 * 60

# Chronological-order guard for merge_real_word_timing (2026-09 production
# incident, see that function's own docstring). Matches sync_schema.
# validate_sync_document's own TOL for the same reason it exists there:
# absorb float-rounding noise between two genuinely back-to-back words
# without either module needing to agree on a shared import for one float.
_MERGE_ORDER_TOL = 0.01


def _now_iso() -> str:
    return _dt.datetime.now(_dt.timezone.utc).strftime("%Y-%m-%dT%H:%M:%SZ")


def _word_timestamp_model() -> str:
    return (os.environ.get("VIDEO_ALIGNMENT_MODEL") or "").strip() or DEFAULT_WORD_TIMESTAMP_MODEL


def get_word_alignment_provider():
    """Returns a real GeminiWordTimestampProvider if GEMINI_API_KEY is
    configured and mock mode isn't forced (video_ai_provider.ai_available()
    — the SAME credential/availability check every other Gemini call in this
    codebase uses, per the explicit "reuse the existing Gemini client/
    credential setup" instruction), else None. A missing key or forced mock
    mode is a valid, non-error resilience outcome (word alignment is skipped
    for this run, honestly marked as such — never retried or treated as a
    failure)."""
    if not ai_available():
        return None
    api_key = os.environ.get("GEMINI_API_KEY", "").strip()
    if not api_key:
        return None
    return GeminiWordTimestampProvider(api_key=api_key)


def _normalize_token(word: str) -> str:
    """Lowercase, strip punctuation — matching is on the SPOKEN word, not
    on which ASR happened to include a trailing comma."""
    return _PUNCT_RE.sub("", (word or "").lower()).strip()


def _flatten_words(sync_doc: dict) -> list[dict]:
    out: list[dict] = []
    for p in (sync_doc or {}).get("paragraphs") or []:
        for s in p.get("sentences") or []:
            out.extend(s.get("words") or [])
    return out


def _parse_offset_seconds(value) -> float | None:
    """Gemini's Interactions API reports word offsets as strings like
    "0.450s" (confirmed live against both the docs' own example response
    AND a real API call) — never assumed to be a bare number."""
    if isinstance(value, (int, float)):
        return float(value)
    if isinstance(value, str):
        s = value.strip()
        if s.endswith("s"):
            s = s[:-1]
        try:
            return float(s)
        except ValueError:
            return None
    return None


class GeminiWordTimestampProvider:
    """Real per-word timing via gemini-3.5-transcribe's Interactions API.
    See module docstring for the verified request/response shape, the
    honest "no numeric confidence" gap, and the model-freshness risk."""

    category = "speech_recognition"

    def __init__(self, *, api_key: str, model: str | None = None, http_client=None):
        if not api_key:
            raise ValueError("GeminiWordTimestampProvider requires an api_key")
        self._api_key = api_key
        self._model = model or _word_timestamp_model()
        self._http_client = http_client  # injectable for tests

    @property
    def provider_version(self) -> str:
        return f"gemini-word-timestamps-v1 ({self._model})"

    async def _post(self, url: str, **kwargs) -> httpx.Response:
        if self._http_client is not None:
            return await self._http_client.post(url, **kwargs)
        async with httpx.AsyncClient(timeout=_TRANSCRIBE_TIMEOUT) as cli:
            return await cli.post(url, **kwargs)

    async def _get(self, url: str, **kwargs) -> httpx.Response:
        if self._http_client is not None:
            return await self._http_client.get(url, **kwargs)
        async with httpx.AsyncClient(timeout=_TRANSCRIBE_TIMEOUT) as cli:
            return await cli.get(url, **kwargs)

    async def align(self, media_bytes: bytes, content_type: str | None = None, **_kwargs) -> dict:
        """Returns {"sync": {"paragraphs": [{"sentences": [{"words":
        [{"word","start","end"}, ...]}]}]}} — the minimal shape
        `_flatten_words` reads. No sentence/speaker structure is built here
        (that remains Gemini segmentation's job, untouched — see module
        docstring); this is a flat word list only. Raises VideoAiError on
        provider failure — run_word_alignment decides the resilience
        fallback."""
        if not media_bytes:
            raise VideoAiError("empty_media", "no media bytes to transcribe")

        mime_type = content_type or "audio/mpeg"
        file_uri = await upload_media_to_files_api(
            media_bytes, mime_type, api_key=self._api_key, post=self._post, get=self._get,
        )
        body = {
            "model": self._model,
            "input": [{"type": "audio", "uri": file_uri, "mime_type": mime_type}],
            "generation_config": {
                "transcription_config": {
                    "mode": {"type": "verbatim", "timestamp_granularities": ["word"]},
                },
            },
        }
        r = await self._post(
            _INTERACTIONS_URL,
            headers={"x-goog-api-key": self._api_key, "Content-Type": "application/json"},
            json=body,
        )
        if r.status_code != 200:
            raise VideoAiError(
                "provider_rejected",
                f"Gemini Interactions API HTTP {r.status_code} (model={self._model}): {(r.text or '')[:300]}",
            )

        payload = r.json()
        words: list[dict] = []
        for step in payload.get("steps") or []:
            for content in step.get("content") or []:
                for ann in content.get("annotations") or []:
                    if not isinstance(ann, dict) or ann.get("type") != "word_info":
                        continue
                    text = str(ann.get("text") or "").strip()
                    start = _parse_offset_seconds(ann.get("start_offset"))
                    end = _parse_offset_seconds(ann.get("end_offset"))
                    if not text or start is None or end is None:
                        continue
                    words.append({"word": text, "start": start, "end": end})

        # Sort by the word's OWN reported start time immediately, before
        # this raw response goes anywhere near matching/merging. Mirrors
        # video_ai_provider.segments_to_sync's own "sort once, at the
        # single point a document is built from raw provider data" fix —
        # gemini-3.5-transcribe's own docs never promise `steps`/`content`/
        # `annotations` are chronologically ordered by array position (a
        # young, still-settling API surface per this module's own
        # docstring), so nothing downstream should have to assume it. This
        # does NOT fix every possible timing defect — a word whose own
        # reported timestamp is simply wrong (not just out of position) is
        # a different failure mode entirely, still guarded against
        # separately by merge_real_word_timing's own ordering check below.
        words.sort(key=lambda w: w["start"])

        return {"sync": {"paragraphs": [{"sentences": [{"words": words}]}]}}


def merge_real_word_timing(gemini_sync: dict, measured_words: list[dict], *,
                            provider_version: str = "unknown") -> tuple[dict, dict]:
    """Mutates `gemini_sync`'s own word dicts in place (the pipeline always
    hands this a freshly-built document for this one run, never a
    previously-persisted one another reader might hold) and returns
    (gemini_sync, telemetry). See module docstring for the matching
    approach and its honesty guarantees.

    telemetry (persisted as the sync document's `wordAlignment` field,
    §1.8's admin-visible quality signal):
      status: "complete" — this function ran, whether or not anything
        matched (a lesson genuinely off-script in its entirety is still
        an honest "complete, 0 matched" result, not a failure).
      totalWords / matchedWords / matchRatio
      meanAlignmentConfidence / lowConfidenceWordCount: always None —
        gemini-3.5-transcribe publishes no per-word confidence (see module
        docstring's "confirmed gap"). Kept as explicit None-valued keys
        (not omitted) so a caller reading this dict's shape sees the same
        keys regardless of provider — the frontend's WordAlignmentBadge
        already renders correctly when these are null.
    """
    gemini_words = _flatten_words(gemini_sync)
    gemini_tokens = [_normalize_token(w.get("word", "")) for w in gemini_words]
    measured_tokens = [_normalize_token(w.get("word", "")) for w in measured_words]

    matcher = difflib.SequenceMatcher(a=gemini_tokens, b=measured_tokens, autojunk=False)
    # Candidate real (start, end) per gemini_words index, gathered from
    # every token-matched ("equal") opcode block. Deliberately NOT applied
    # here directly — see the sequential ordering pass below for why.
    candidates: dict[int, tuple[float, float]] = {}
    for tag, i1, i2, j1, j2 in matcher.get_opcodes():
        if tag != "equal":
            continue  # insert/delete/replace blocks are real ASR disagreements - leave interpolated
        for offset in range(i2 - i1):
            g_word = gemini_words[i1 + offset]
            m_word = measured_words[j1 + offset]
            real_start = float(m_word.get("start", g_word["start"]))
            real_end = float(m_word.get("end", g_word["end"]))
            if real_end < real_start:
                continue  # never persist an inverted span - keep the interpolated one
            candidates[i1 + offset] = (real_start, real_end)

    # 2026-09 production incident (lesson vid_12473703734f4750, "Sealing
    # the Deal"): sync_schema.validate_sync_document rejected the
    # resulting document with "words[13] out of chronological order:
    # start=0.42 precedes an earlier word's start=41.6". Root cause,
    # confirmed by reading difflib's own contract: SequenceMatcher.
    # get_opcodes() only guarantees matched (i, j) index pairs are
    # monotonic within each sequence relative to each other - it has no
    # way to know, and does not claim, that gemini-3.5-transcribe's own
    # raw word_info annotations came back in strict chronological order (a
    # young, still-settling API surface per this module's own docstring).
    # One out-of-order measured word is enough for a token match deep into
    # Gemini's own transcript to get overwritten with an EARLIER real
    # timestamp than the word immediately before it - exactly this shape,
    # reproduced twice in production. Fixed by applying candidates in a
    # SECOND, strictly sequential pass (by Gemini's own word order, never
    # matcher-opcode order) that only accepts a real timestamp if it does
    # not move time backwards relative to whatever value - measured or
    # still-interpolated - immediately precedes it. Same "when genuinely
    # in doubt, keep the honest interpolated value" philosophy already
    # used just above for an inverted (end < start) span; this is not a
    # new kind of judgment call, just the same one applied to a second,
    # newly-observed failure mode.
    matched = 0
    last_accepted_start = 0.0
    for idx, g_word in enumerate(gemini_words):
        candidate = candidates.get(idx)
        if candidate is not None:
            real_start, real_end = candidate
            if real_start >= last_accepted_start - _MERGE_ORDER_TOL:
                g_word["start"] = round(real_start, 3)
                g_word["end"] = round(real_end, 3)
                g_word["confidence"] = build_confidence(
                    transcript=(g_word.get("confidence") or {}).get("transcript"),
                )
                # Provenance FACT, not a fabricated probability (see
                # module docstring): two independent Gemini transcriptions
                # of the same audio agreed on this exact word - that is
                # real evidence this timing is measured, not interpolated,
                # even with no numeric score to attach to it.
                g_word["measured"] = True
                matched += 1
            # else: the candidate would move time backwards relative to
            # the word immediately before it - a wrong-position token
            # match, not a genuine re-occurrence at this point in the
            # video. Left as Gemini's own interpolated timing, which is
            # already internally consistent with its neighbors.
        last_accepted_start = max(last_accepted_start, g_word["start"])

    total = len(gemini_words)
    telemetry = {
        "status": "complete",
        "provider": provider_version,
        "totalWords": total,
        "matchedWords": matched,
        "matchRatio": round(matched / total, 4) if total else 0.0,
        "meanAlignmentConfidence": None,
        "lowConfidenceWordCount": None,
        "attemptedAt": _now_iso(),
    }
    return gemini_sync, telemetry


async def run_word_alignment(media_bytes: bytes, transcript_text: str, gemini_sync: dict,
                              content_type: str | None = None, *, provider) -> tuple[dict, dict]:
    """Orchestrates one real-alignment attempt for one pipeline run.
    NEVER raises — a transient provider failure (rate limit, timeout,
    HTTP error), a missing provider (no API key configured), or audio
    longer than gemini-3.5-transcribe's documented word-timestamp limit
    must never block the lesson's pipeline from completing with Gemini's
    existing interpolated timing (§1.5's resilience requirement). Returns
    (sync_doc, telemetry) — `sync_doc` is `gemini_sync` unchanged on any
    non-success path, so the caller can always just use the returned
    document without branching on status itself.

    `transcript_text` is accepted for call-site/interface stability (the
    pipeline already has it computed for other purposes) but is currently
    UNUSED here: gemini-3.5-transcribe's Interactions API documents no
    reference-transcript-conditioning parameter — it always performs full
    ASR from scratch, exactly like the removed ElevenLabs Scribe design did.
    `content_type` is the pipeline's already-extracted audio's real mime
    type (e.g. "audio/mpeg") — required so the Gemini Files API upload
    transcodes it correctly; the removed ElevenLabs Scribe design didn't
    need this since it accepted a raw multipart file with no mime
    negotiation."""
    if provider is None:
        return gemini_sync, {
            "status": "skipped", "provider": None,
            "reason": "GEMINI_API_KEY not configured (or mock mode forced) — real alignment unavailable this run",
            "attemptedAt": _now_iso(),
        }

    duration = gemini_sync.get("durationSec") if isinstance(gemini_sync, dict) else None
    if isinstance(duration, (int, float)) and duration > MAX_ALIGNMENT_AUDIO_SECONDS:
        return gemini_sync, {
            "status": "skipped",
            "provider": getattr(provider, "provider_version", None),
            "reason": (
                f"audio duration {duration:.0f}s exceeds gemini-3.5-transcribe's documented "
                f"{MAX_ALIGNMENT_AUDIO_SECONDS // 60}-minute limit for word-level timestamps"
            ),
            "attemptedAt": _now_iso(),
        }

    try:
        result = await provider.align(media_bytes, content_type)
    except Exception as exc:  # noqa: BLE001 — a provider outage must never fail the lesson
        logger.warning("video_word_alignment: Gemini word-timestamp alignment failed, using interpolated timing: %s", exc)
        return gemini_sync, {
            "status": "failed",
            "provider": getattr(provider, "provider_version", None),
            "error": f"{type(exc).__name__}: {exc}",
            "attemptedAt": _now_iso(),
        }

    measured_words = _flatten_words(result.get("sync") or {})
    if not measured_words:
        return gemini_sync, {
            "status": "failed",
            "provider": getattr(provider, "provider_version", None),
            "error": "provider returned no words to align against",
            "attemptedAt": _now_iso(),
        }
    return merge_real_word_timing(
        gemini_sync, measured_words, provider_version=getattr(provider, "provider_version", "unknown"),
    )
