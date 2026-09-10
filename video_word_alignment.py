"""video_word_alignment.py — real, MEASURED per-word timing for the Video
Library's original-upload transcript, merged onto Gemini's existing
sentence/speaker structure.

CONFIRMED STATE OF THE TWO PROVIDERS THIS BUILDS ON (read directly from
sync_provider.py before writing this module, not assumed):

  - ElevenLabsProvider.align() raises NotImplementedError outright — it
    wraps ElevenLabs' TTS-WITH-TIMESTAMPS endpoint, which only reports
    timing for audio IT JUST GENERATED from text it was given. It has no
    capability whatsoever to align pre-existing/uploaded audio and is
    genuinely not usable here, not merely "not yet wired up" as the
    prior-round brief characterized it.
  - ScribeAlignmentProvider (also in sync_provider.py) is a real,
    previously-unwired CANDIDATE that calls ElevenLabs Scribe's real
    speech-to-text endpoint. Its own docstring is explicit that this is
    NOT reference-conditioned forced alignment either: Scribe always
    performs full ASR from scratch and does not accept a transcript to
    align against. What it DOES provide, confirmed against ElevenLabs'
    own API reference: REAL, MEASURED per-word start/end timestamps from
    the actual audio waveform (not length-weighted interpolation) plus a
    genuine per-word confidence (from its logprob).

Neither existing provider is literally "forced alignment of a known
transcript." Given that, this module's honest, evidence-based design is:
run Scribe as a SECOND, independent transcription of the SAME audio
Gemini already transcribed, then MERGE the two by matching word tokens
(difflib.SequenceMatcher over normalized tokens — a standard technique
for comparing two independent transcriptions of the same speech, the
same class of algorithm word-error-rate tooling already uses elsewhere
in this repo — tools/run_sync_provider_validation.py). Wherever a
Gemini word and a Scribe word line up as the same token, the Gemini
word's start/end is REPLACED with Scribe's real, measured timing and its
confidence.alignment is set HONESTLY from Scribe's own per-word
confidence. Any Gemini word that doesn't have a matching Scribe word —
background noise, a second untranscribed speaker, off-script speech,
a genuine ASR disagreement — is left exactly as Gemini's own
length-weighted interpolation produced it, with confidence.alignment
staying None (unknown), never fabricated. This is real per-word
measurement where the evidence supports it, and an honest, unchanged
fallback everywhere it doesn't — never a guess dressed up as precision.

Gemini's sentence boundaries, speaker labels, and paragraph grouping are
NEVER touched here — only word.start/word.end/word.confidence within an
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

from sync_schema import build_confidence

logger = logging.getLogger("eduhub.video_word_alignment")

# Below this per-word alignment confidence, a word is treated as "not
# reliably real-timed" for the Teleprompter's confidence-tiered rendering
# even though it technically got a Scribe match — the honest "never show
# more precision than the data earns" rule applies at the confidence
# level, not just at the matched/unmatched level.
LOW_CONFIDENCE_ALIGNMENT = 0.5

_PUNCT_RE = re.compile(r"[^\w']+", re.UNICODE)


def _now_iso() -> str:
    return _dt.datetime.now(_dt.timezone.utc).strftime("%Y-%m-%dT%H:%M:%SZ")


def get_word_alignment_provider():
    """Returns a real ScribeAlignmentProvider if ELEVENLABS_API_KEY is
    configured in this environment, else None. A missing key is a valid,
    non-error resilience outcome (word alignment is skipped for this run,
    honestly marked as such — never retried or treated as a failure) —
    mirrors video_ai_provider.py's own per-module direct-env-read
    convention rather than sharing a client across modules."""
    api_key = os.environ.get("ELEVENLABS_API_KEY", "").strip()
    if not api_key:
        return None
    from sync_provider import ScribeAlignmentProvider  # local import — optional dependency path

    return ScribeAlignmentProvider(api_key)


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


def merge_real_word_timing(gemini_sync: dict, scribe_words: list[dict]) -> tuple[dict, dict]:
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
      meanAlignmentConfidence: mean of Scribe's own confidence for
        MATCHED words only — None if nothing matched.
      lowConfidenceWordCount: matched words whose confidence fell below
        LOW_CONFIDENCE_ALIGNMENT.
    """
    gemini_words = _flatten_words(gemini_sync)
    gemini_tokens = [_normalize_token(w.get("word", "")) for w in gemini_words]
    scribe_tokens = [_normalize_token(w.get("word", "")) for w in scribe_words]

    matcher = difflib.SequenceMatcher(a=gemini_tokens, b=scribe_tokens, autojunk=False)
    matched = 0
    confidences: list[float] = []
    for tag, i1, i2, j1, j2 in matcher.get_opcodes():
        if tag != "equal":
            continue  # insert/delete/replace blocks are real ASR disagreements — leave interpolated
        for offset in range(i2 - i1):
            g_word = gemini_words[i1 + offset]
            s_word = scribe_words[j1 + offset]
            real_start = float(s_word.get("start", g_word["start"]))
            real_end = float(s_word.get("end", g_word["end"]))
            if real_end < real_start:
                continue  # never persist an inverted span — keep the interpolated one
            align_conf = (s_word.get("confidence") or {}).get("transcript")
            g_word["start"] = round(real_start, 3)
            g_word["end"] = round(real_end, 3)
            g_word["confidence"] = build_confidence(
                transcript=(g_word.get("confidence") or {}).get("transcript"),
                alignment=align_conf,
            )
            matched += 1
            if align_conf is not None:
                confidences.append(align_conf)

    total = len(gemini_words)
    mean_conf = sum(confidences) / len(confidences) if confidences else None
    low_count = sum(1 for c in confidences if c < LOW_CONFIDENCE_ALIGNMENT)
    telemetry = {
        "status": "complete",
        "provider": "elevenlabs-scribe-v1",
        "totalWords": total,
        "matchedWords": matched,
        "matchRatio": round(matched / total, 4) if total else 0.0,
        "meanAlignmentConfidence": round(mean_conf, 4) if mean_conf is not None else None,
        "lowConfidenceWordCount": low_count,
        "attemptedAt": _now_iso(),
    }
    return gemini_sync, telemetry


async def run_word_alignment(media_bytes: bytes, transcript_text: str, gemini_sync: dict, *, provider) -> tuple[dict, dict]:
    """Orchestrates one real-alignment attempt for one pipeline run.
    NEVER raises — a transient provider failure (rate limit, timeout,
    HTTP error) or a missing provider (no API key configured) must never
    block the lesson's pipeline from completing with Gemini's existing
    interpolated timing (§1.5's resilience requirement). Returns
    (sync_doc, telemetry) — `sync_doc` is `gemini_sync` unchanged on any
    non-success path, so the caller can always just use the returned
    document without branching on status itself."""
    if provider is None:
        return gemini_sync, {
            "status": "skipped", "provider": None,
            "reason": "ELEVENLABS_API_KEY not configured — real alignment unavailable this run",
            "attemptedAt": _now_iso(),
        }
    try:
        result = await provider.align(media_bytes, transcript_text or None)
    except Exception as exc:  # noqa: BLE001 — a provider outage must never fail the lesson
        logger.warning("video_word_alignment: Scribe alignment failed, using interpolated timing: %s", exc)
        return gemini_sync, {
            "status": "failed",
            "provider": getattr(provider, "provider_version", None),
            "error": f"{type(exc).__name__}: {exc}",
            "attemptedAt": _now_iso(),
        }

    scribe_words = _flatten_words(result.get("sync") or {})
    if not scribe_words:
        return gemini_sync, {
            "status": "failed",
            "provider": getattr(provider, "provider_version", None),
            "error": "provider returned no words to align against",
            "attemptedAt": _now_iso(),
        }
    return merge_real_word_timing(gemini_sync, scribe_words)
