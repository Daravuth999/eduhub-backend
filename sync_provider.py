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
