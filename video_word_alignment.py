"""video_word_alignment.py — real, MEASURED per-word timing for the Video
Library's original-upload transcript, merged onto Gemini's existing
sentence/speaker structure.

2026-09: ElevenLabs Scribe REMOVED from this feature (explicit project-owner
instruction). The prior round's design ran ElevenLabs Scribe as a second,
independent transcription of the same audio and merged its real per-word
timing onto Gemini's own sentence/speaker structure wherever the two
transcriptions agreed on a word. That provider wiring — the Scribe alignment
class, its ElevenLabs API-key env-var read, and every ElevenLabs-specific
docstring passage — has been deleted outright, not merely disabled: no
ElevenLabs import, credential lookup, or config reference remains anywhere
in this module. `get_word_alignment_provider()` now always returns None, so
every lesson runs with Gemini's own length-weighted interpolation only (identical
behavior to before real word alignment existed at all) until a replacement
provider is wired in the very next commit.

The merge/orchestration logic below (`merge_real_word_timing`,
`run_word_alignment`) is intentionally NOT ElevenLabs-specific — it already
took a generic `measured_words: list[{"word","start","end"}]` list and a
`provider_version` label, never anything Scribe-shaped — so it is kept
as-is, ready for whichever real provider replaces the removed one.

Gemini's sentence boundaries, speaker labels, and paragraph grouping are
NEVER touched here — only word.start/word.end within an EXISTING sentence
structure are ever modified. This module knows nothing about Mongo, the
pipeline, or a lesson id: it takes bytes and a sync document in, returns a
sync document and a telemetry dict out, mirroring video_render_tools.py's
own "bytes in, bytes/dict out, no side effects" discipline in this codebase.
"""
from __future__ import annotations

import datetime as _dt
import difflib
import logging
import re

from sync_schema import build_confidence

logger = logging.getLogger("eduhub.video_word_alignment")

_PUNCT_RE = re.compile(r"[^\w']+", re.UNICODE)


def _now_iso() -> str:
    return _dt.datetime.now(_dt.timezone.utc).strftime("%Y-%m-%dT%H:%M:%SZ")


def get_word_alignment_provider():
    """No real word-alignment provider is wired in this commit — ElevenLabs
    Scribe was removed outright per explicit project-owner instruction, and
    its Gemini-based replacement lands in the next commit. Always returning
    None here is a valid, non-error resilience outcome (word alignment is
    skipped for every run, honestly marked as such via run_word_alignment's
    "skipped" status) — every lesson still gets Gemini's own interpolated
    timing, identical to pipeline behavior before real word alignment
    existed at all."""
    return None


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


def merge_real_word_timing(gemini_sync: dict, measured_words: list[dict], *,
                            provider_version: str = "unknown") -> tuple[dict, dict]:
    """Mutates `gemini_sync`'s own word dicts in place (the pipeline always
    hands this a freshly-built document for this one run, never a
    previously-persisted one another reader might hold) and returns
    (gemini_sync, telemetry). Provider-agnostic by design: `measured_words`
    is a flat `[{"word","start","end"}, ...]` list from WHICHEVER second,
    independent transcription of the same audio a real provider supplies —
    nothing here assumes ElevenLabs Scribe or any other specific vendor.

    telemetry (persisted as the sync document's `wordAlignment` field,
    §1.8's admin-visible quality signal):
      status: "complete" — this function ran, whether or not anything
        matched (a lesson genuinely off-script in its entirety is still
        an honest "complete, 0 matched" result, not a failure).
      totalWords / matchedWords / matchRatio
    """
    gemini_words = _flatten_words(gemini_sync)
    gemini_tokens = [_normalize_token(w.get("word", "")) for w in gemini_words]
    measured_tokens = [_normalize_token(w.get("word", "")) for w in measured_words]

    matcher = difflib.SequenceMatcher(a=gemini_tokens, b=measured_tokens, autojunk=False)
    matched = 0
    for tag, i1, i2, j1, j2 in matcher.get_opcodes():
        if tag != "equal":
            continue  # insert/delete/replace blocks are real ASR disagreements — leave interpolated
        for offset in range(i2 - i1):
            g_word = gemini_words[i1 + offset]
            m_word = measured_words[j1 + offset]
            real_start = float(m_word.get("start", g_word["start"]))
            real_end = float(m_word.get("end", g_word["end"]))
            if real_end < real_start:
                continue  # never persist an inverted span — keep the interpolated one
            g_word["start"] = round(real_start, 3)
            g_word["end"] = round(real_end, 3)
            g_word["confidence"] = build_confidence(
                transcript=(g_word.get("confidence") or {}).get("transcript"),
            )
            matched += 1

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
    HTTP error) or a missing provider (get_word_alignment_provider()
    currently always returns None — see above) must never block the
    lesson's pipeline from completing with Gemini's existing interpolated
    timing (§1.5's resilience requirement). Returns (sync_doc, telemetry) —
    `sync_doc` is `gemini_sync` unchanged on any non-success path, so the
    caller can always just use the returned document without branching on
    status itself."""
    if provider is None:
        return gemini_sync, {
            "status": "skipped", "provider": None,
            "reason": "no word-alignment provider configured — real alignment unavailable this run",
            "attemptedAt": _now_iso(),
        }
    try:
        result = await provider.align(media_bytes, content_type)
    except Exception as exc:  # noqa: BLE001 — a provider outage must never fail the lesson
        logger.warning("video_word_alignment: alignment failed, using interpolated timing: %s", exc)
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
