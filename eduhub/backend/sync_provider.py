"""sync_provider.py — Universal Synchronization Engine, provider boundary
(Phase 0 — Universal Synchronization Foundation).

Defines the provider "interface" by convention (this codebase does not use
typing.Protocol/ABC elsewhere — register_*_routes modules take plain
injected functions instead, e.g. server.py's
`run_elevenlabs_for_chapter=run_elevenlabs_for_chapter`; providers here
follow the same duck-typed convention: `category`, `provider_version`,
async `synthesize(text, voice_id)`, async `align(audio_bytes, transcript)`,
each returning a dict shaped `{"sync": <sync_schema.py document>, ...}`.

Per tech spec §3, a provider is identified by CAPABILITY CATEGORY, never a
vendor name — nothing outside a provider implementation ever sees ElevenLabs
(or any future vendor) directly. `category` is one of
sync_schema.VALID_PROVIDER_CATEGORIES.

ElevenLabsProvider below wraps server.py's existing, already-shipping
`_elevenlabs_generate` (verified at server.py:505 — returns
`{audio_base64, word_timestamps}`) by RESHAPING its output into the
canonical schema at the boundary. It is injected the underlying function,
matching this codebase's existing DI convention, rather than importing
server.py directly (server.py imports its siblings, never the reverse —
importing it back would be circular).

No new vendor call is made anywhere in this module. `align()` on
ElevenLabsProvider deliberately raises NotImplementedError: ElevenLabs'
TTS-with-timestamps endpoint generates audio FROM text it already knows: it
has no capability to force-align arbitrary PRE-EXISTING/uploaded audio. A
Speech Recognition + Alignment provider for uploaded media requires a
separate, not-yet-chosen vendor (tech spec §12 — explicitly deferred,
requires its own cost/credential decision).
"""
from __future__ import annotations

import datetime as _dt
import math

from sync_schema import build_confidence, build_paragraph, build_sentence, build_sync_document, build_word


def _utc_now_iso() -> str:
    return _dt.datetime.now(_dt.timezone.utc).strftime("%Y-%m-%dT%H:%M:%SZ")


def reshape_elevenlabs_word_timestamps(word_timestamps: list[dict]) -> dict:
    """Pure reshape: server.py's existing `word_timestamps` list
    (`[{word, start, end}, ...]`, produced today by both
    `_elevenlabs_generate` and `_elevenlabs_generate_line`) into the
    canonical schema. A free function (not a method) so both
    ElevenLabsProvider.synthesize() and a backfill route in
    sync_studio_tools.py (adapting ALREADY-generated narration into a sync
    document, per tech spec §11's "thin adapter at read time") can call it
    without needing a live provider instance.
    """
    words = [
        build_word(
            w.get("word", ""), w.get("start", 0.0), w.get("end", 0.0),
            # transcript=1.0 is honest here, not fabricated: this is the
            # exact author-authored text ElevenLabs was told to speak, not a
            # speech-recognition guess. alignment=None because the
            # ElevenLabs API returns no alignment-quality score at all —
            # None is the honest "unknown", never defaulted to 1.0.
            confidence=build_confidence(transcript=1.0, alignment=None),
        )
        for w in (word_timestamps or [])
        if w.get("word")
    ]
    # Phase 0 does not attempt sentence/paragraph segmentation (that is
    # Phase 3 of the roadmap, per smart-books-engine-architecture-study
    # §10) — server.py's existing narration data carries no sentence
    # boundaries, so wrapping every word in one sentence/paragraph is the
    # accurate reflection of what data actually exists today, rather than
    # fabricating split points from punctuation guesses.
    sentence = build_sentence("s1", words)
    paragraph = build_paragraph("p1", [sentence])
    duration = words[-1]["end"] if words else 0.0
    return build_sync_document(
        media_ref="",  # filled in by the caller once the audio itself is stored (R2/GridFS)
        provider_category="synthesis",
        provider_version=ElevenLabsProvider.provider_version,
        paragraphs=[paragraph],
        generated_at=_utc_now_iso(),
        duration_sec=duration,
    )


class ElevenLabsProvider:
    """Reshaping adapter over the existing, working ElevenLabs TTS pipeline.
    Not a new vendor integration — every network call still happens inside
    the injected `elevenlabs_generate` function exactly as it does today."""

    category = "synthesis"
    provider_version = "elevenlabs-tts-with-timestamps"

    def __init__(self, elevenlabs_generate):
        if elevenlabs_generate is None:
            raise ValueError("ElevenLabsProvider requires elevenlabs_generate")
        self._generate = elevenlabs_generate

    async def synthesize(self, text: str, voice_id: str) -> dict:
        """Generate audio FROM text — what server.py's Book Factory
        narration path already does. Returns
        {"audio_base64": str, "sync": <canonical schema, sync_schema.py>}."""
        raw = await self._generate(text, voice_id)
        return {
            "audio_base64": raw.get("audio_base64", ""),
            "sync": reshape_elevenlabs_word_timestamps(raw.get("word_timestamps")),
        }

    async def align(self, audio_bytes: bytes, transcript: str | None = None) -> dict:
        raise NotImplementedError(
            "ElevenLabsProvider wraps the TTS-with-timestamps endpoint only "
            "and cannot force-align pre-existing/uploaded audio. Native "
            "audio/video upload requires a separate Speech Recognition + "
            "Alignment provider — vendor deliberately not yet chosen "
            "(tech spec §12)."
        )


def _group_by_speaker_turn(word_entries: list[tuple[dict, str | None]]) -> list[dict]:
    """Groups consecutive (word, speaker_id) entries sharing the same
    speaker into one sentence each. This is an HONEST turn-boundary
    segmentation built from Scribe's real diarization output — NOT a
    fabricated punctuation-based sentence split (Scribe's API returns no
    sentence boundaries at all, confirmed against its own reference).
    Single-speaker audio collapses to one sentence, matching Phase 0's
    existing no-segmentation behavior for ElevenLabs TTS output."""
    sentences: list[dict] = []
    current_words: list[dict] = []
    current_speaker: object = object()  # sentinel, unequal to any real id or None
    turn_index = 0

    def _flush():
        nonlocal turn_index
        if not current_words:
            return
        turn_index += 1
        sentences.append(build_sentence(f"s{turn_index}", list(current_words), speaker_id=current_speaker))

    for word, speaker_id in word_entries:
        if speaker_id != current_speaker and current_words:
            _flush()
            current_words = []
        current_speaker = speaker_id
        current_words.append(word)
    _flush()
    return sentences


class ScribeAlignmentProvider:
    """CANDIDATE implementation of the Speech Recognition + Alignment
    capability (tech spec §3) via ElevenLabs Scribe — confirmed against
    ElevenLabs' own API reference (POST
    https://api.elevenlabs.io/v1/speech-to-text, 2026-08-06). NOT
    registered or wired into any production route: this class exists so
    the real-audio validation required before any vendor coupling (tech
    spec §12, and the explicit "do not bypass validation" instruction it
    was written under) can actually be executed. Whether this becomes the
    production provider is decided entirely by that validation's results,
    run via tools/run_sync_provider_validation.py.

    Confirmed response shape: {"language_code", "language_probability",
    "text", "words": [{"text","start","end","type","speaker_id","logprob"}]}.
    Two real, confirmed capability gaps versus the SyncProvider interface's
    ideal — surfaced here, not hidden:
      1. Confidence arrives as `logprob` (a LOG-probability, range -inf..0),
         never a 0-1 score. Converted via math.exp(logprob) at the boundary
         so the canonical schema's confidence contract (0-1 float or None)
         never leaks a vendor-specific unit to any consumer.
      2. Scribe's endpoint always performs full speech recognition; it does
         NOT accept a reference transcript for forced alignment, so the
         `transcript` parameter (present for interface compatibility with
         a future forced-alignment-capable provider) is accepted but unused.
    """

    category = "speech_recognition"
    provider_version = "elevenlabs-scribe-v1"

    def __init__(self, api_key: str, *, model_id: str = "scribe_v1", http_post=None):
        if not api_key:
            raise ValueError("ScribeAlignmentProvider requires an ElevenLabs api_key")
        self._api_key = api_key
        self._model_id = model_id
        # Injectable for testing — no real network call in unit tests.
        # Defaults to a real httpx call, matching server.py's own
        # _elevenlabs_generate pattern (raw REST, no vendor SDK dependency).
        self._http_post = http_post or self._real_http_post

    async def _real_http_post(self, audio_bytes: bytes, language_code: str | None) -> dict:
        import httpx

        headers = {"xi-api-key": self._api_key}
        data = {
            "model_id": self._model_id,
            "timestamps_granularity": "word",
            "diarize": "true",
        }
        if language_code:
            data["language_code"] = language_code
        files = {"file": ("audio", audio_bytes)}
        async with httpx.AsyncClient(timeout=httpx.Timeout(120.0, connect=10.0)) as cli:
            r = await cli.post(
                "https://api.elevenlabs.io/v1/speech-to-text",
                headers=headers, data=data, files=files,
            )
            if r.status_code != 200:
                raise RuntimeError(f"ElevenLabs Scribe error {r.status_code}: {r.text[:300]}")
            return r.json()

    async def synthesize(self, text: str, voice_id: str) -> dict:
        raise NotImplementedError(
            "ScribeAlignmentProvider is speech-recognition/alignment only "
            "and has no text-to-speech capability."
        )

    async def align(self, audio_bytes: bytes, transcript: str | None = None, *, language_code: str | None = None) -> dict:
        raw = await self._http_post(audio_bytes, language_code)
        return {"raw": raw, "sync": self._reshape(raw)}

    def _reshape(self, raw: dict) -> dict:
        word_entries: list[tuple[dict, str | None]] = []
        for w in raw.get("words") or []:
            if w.get("type") != "word":
                continue  # skip "spacing"/"audio_event" entries — not text content
            logprob = w.get("logprob")
            transcript_confidence = math.exp(logprob) if isinstance(logprob, (int, float)) else None
            word_entries.append((
                build_word(
                    w.get("text", ""), w.get("start", 0.0), w.get("end", 0.0),
                    confidence=build_confidence(transcript=transcript_confidence, alignment=None),
                ),
                w.get("speaker_id"),
            ))

        sentences = _group_by_speaker_turn(word_entries)
        speaker_ids = sorted({sid for _, sid in word_entries if sid})
        speakers = [{"id": sid, "label": sid} for sid in speaker_ids] or None
        paragraph = build_paragraph("p1", sentences)
        all_words = [w for w, _ in word_entries]
        duration = all_words[-1]["end"] if all_words else 0.0

        return build_sync_document(
            media_ref="",
            provider_category=self.category,
            provider_version=self.provider_version,
            paragraphs=[paragraph],
            generated_at=_utc_now_iso(),
            duration_sec=duration,
            speakers=speakers,
        )
