"""sync_reading_profiles.py — Universal Synchronization Engine, reading
profiles (Phase 0 — Universal Synchronization Foundation, tech spec §7).

Pure, stdlib-only, no Mongo/network — modeled directly on
book_factory_interaction_planner.py's TIER_INTERACTION_POLICY: a small,
named-preset dict resolved deterministically, never independently branching
Reader logic per book. Per tech spec §7's explicit caveat, a profile is
SUGAR OVER THE SAME GRANULAR CAPABILITY FLAGS, never a separate data model —
`resolve_reading_profile` always returns a flat capability-flag dict,
whether it came from a named preset, an override merge, or neither.
"""
from __future__ import annotations

DEFAULT_PROFILE = "reading"

READING_PROFILES: dict[str, dict] = {
    "reading": {
        "wordHighlight": True, "sentenceHighlight": False, "paragraphHighlight": False,
        "autoScroll": False, "replayControls": False, "speakerHighlight": False,
    },
    "storytelling": {
        "wordHighlight": True, "sentenceHighlight": True, "paragraphHighlight": True,
        "autoScroll": True, "replayControls": False, "speakerHighlight": False,
    },
    "shadowing": {
        "wordHighlight": True, "sentenceHighlight": True, "paragraphHighlight": False,
        "autoScroll": False, "replayControls": True, "speakerHighlight": False,
    },
    "conversation": {
        "wordHighlight": True, "sentenceHighlight": True, "paragraphHighlight": False,
        "autoScroll": False, "replayControls": True, "speakerHighlight": True,
    },
    "listening": {
        "wordHighlight": True, "sentenceHighlight": True, "paragraphHighlight": True,
        "autoScroll": True, "replayControls": True, "speakerHighlight": True,
    },
    "presentation": {
        "wordHighlight": False, "sentenceHighlight": True, "paragraphHighlight": True,
        "autoScroll": True, "replayControls": False, "speakerHighlight": False,
    },
    "pronunciation": {
        "wordHighlight": True, "sentenceHighlight": False, "paragraphHighlight": False,
        "autoScroll": False, "replayControls": True, "speakerHighlight": False,
    },
}

_CAPABILITY_KEYS = frozenset(READING_PROFILES[DEFAULT_PROFILE].keys())


def resolve_reading_profile(sync_profile: str | None, sync_overrides: dict | None = None) -> dict:
    """Resolve a book's `syncProfile` + optional `syncOverrides` (spec §7)
    into a flat capability-flag dict. An unknown profile name falls back to
    DEFAULT_PROFILE rather than raising — matches this codebase's existing
    "unknown tier falls back to the safest default" convention
    (book_factory_interaction_planner.py's `_normalized_tier`). Overrides
    are merged key-by-key; unrecognized override keys are ignored (never
    silently expand the capability surface with an unvalidated key)."""
    base = dict(READING_PROFILES.get(sync_profile or DEFAULT_PROFILE, READING_PROFILES[DEFAULT_PROFILE]))
    for key, value in (sync_overrides or {}).items():
        if key in _CAPABILITY_KEYS:
            base[key] = bool(value)
    return base
