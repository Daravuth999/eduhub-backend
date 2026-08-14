"""book_factory_interaction_planner.py — Signature Smart Interactive Book,
Checkpoint 1: deterministic tier/density policy + chapter interaction planner.

Pure, stdlib-only, no Mongo/network. This module decides WHICH optional
interaction types a chapter may request — Gemini never chooses freely, and a
chapter is never asked for all nine types "blindly" (per the locked
correction). Checkpoint 1 ships this as a standalone, fully-tested decision
function; wiring its output into the actual chapter prompt
(book_factory_gemini._chapter_prompt) is deferred to Checkpoint 5, so nothing
about live chapter generation changes yet.

Determinism: `plan_chapter_interactions` is a pure function of
(job_id, chapter_index, tier) — same inputs always produce the same plan, so
it is trivially unit-testable and reproducible for a crash-recovered retry,
without any true randomness or extra Gemini call.
"""
from __future__ import annotations

import hashlib

# ── weighted density model (§ weighted density model) ──────────────────────
# vocabgrid is baseline content (replaces the old per-word vocabulary
# section) and is NEVER counted against the optional-interaction budget.
INTERACTION_WEIGHTS: dict[str, int] = {
    "reveal": 1,
    "mission": 1,
    "pronunciation": 2,
    "matchpairs": 2,
    "responsechoice": 2,
    "sentencebuilder": 3,
    "checkpoint": 4,
    "branchdialog": 4,
}

_HEAVY_TYPES = frozenset(t for t, w in INTERACTION_WEIGHTS.items() if w >= 4)

# ── tier policy: allowed optional types + per-chapter density budget ───────
TIER_INTERACTION_POLICY: dict[str, dict] = {
    "free": {
        "allowedTypes": ("reveal", "mission"),
        "densityBudget": 1,
        "maxOptionalCount": 1,
        "vocabPresentation": "compact",
    },
    "standard": {
        "allowedTypes": ("pronunciation", "matchpairs", "checkpoint", "mission", "reveal"),
        "densityBudget": 4,
        "maxOptionalCount": 2,
        "vocabPresentation": "grid",
    },
    "premium": {
        "allowedTypes": (
            "pronunciation", "matchpairs", "sentencebuilder", "responsechoice",
            "branchdialog", "checkpoint", "mission", "reveal",
        ),
        "densityBudget": 8,
        "maxOptionalCount": 3,
        "vocabPresentation": "grid_layered",
    },
    "limited": {
        "allowedTypes": (
            "pronunciation", "matchpairs", "sentencebuilder", "responsechoice",
            "branchdialog", "checkpoint", "mission", "reveal",
        ),
        "densityBudget": 9,
        "maxOptionalCount": 4,
        "vocabPresentation": "grid_layered",
    },
}


def _normalized_tier(tier: str | None) -> str:
    t = (tier or "free").strip().lower()
    return t if t in TIER_INTERACTION_POLICY else "free"


def tier_policy(tier: str | None) -> dict:
    return TIER_INTERACTION_POLICY[_normalized_tier(tier)]


def _seed_int(job_id: str, chapter_index: int) -> int:
    digest = hashlib.sha256(f"{job_id}:{chapter_index}".encode("utf-8")).hexdigest()
    return int(digest[:8], 16)


def plan_chapter_interactions(
    *, tier: str | None, job_id: str, chapter_index: int,
    recent_type_history: list[str] | None = None,
) -> dict:
    """Deterministically select this chapter's optional interaction mix.

    Returns {"vocabIncluded": True, "types": [...]} — `types` is ordered,
    de-duplicated, respects the tier's density budget (no two heavy types in
    one chapter; total weight <= densityBudget; at most maxOptionalCount
    entries), and softly avoids repeating a type that appeared in the last two
    chapters when an alternative is available. Pure function of its inputs —
    same (job_id, chapter_index, tier) always yields the same plan.
    """
    policy = tier_policy(tier)
    allowed = list(policy["allowedTypes"])
    if not allowed:
        return {"vocabIncluded": True, "types": []}

    recent = set((recent_type_history or [])[-2:])
    seed = _seed_int(job_id, chapter_index)

    # Deterministic rotation: order candidates by a seeded, reproducible key
    # so different chapters/books get different-feeling mixes without any
    # true randomness (needed for crash-safe, testable regeneration).
    ranked = sorted(
        allowed,
        key=lambda t: (t in recent, (seed * (hash(t) & 0xFFFF)) % 997),
    )

    chosen: list[str] = []
    used_weight = 0
    has_heavy = False
    for t in ranked:
        if len(chosen) >= policy["maxOptionalCount"]:
            break
        w = INTERACTION_WEIGHTS.get(t, 1)
        is_heavy = t in _HEAVY_TYPES
        if is_heavy and has_heavy:
            continue  # never two heavy types in the same chapter
        if used_weight + w > policy["densityBudget"]:
            continue
        chosen.append(t)
        used_weight += w
        has_heavy = has_heavy or is_heavy

    return {"vocabIncluded": True, "types": chosen}


# ── bounded cross-chapter continuity bookkeeping ────────────────────────────
_MAX_LEARNING_TARGETS = 20
_PROMPT_RECENT_TARGETS = 10


def update_learning_targets(
    existing: list[dict] | None, new_terms: list[str], chapter_index: int,
) -> list[dict]:
    """Append newly-introduced terms (deduplicated), bounded to the most
    recent _MAX_LEARNING_TARGETS entries (oldest dropped first). Pure,
    deterministic — no Gemini call."""
    out = list(existing or [])
    seen = {t.get("term") for t in out if isinstance(t, dict)}
    for term in new_terms or []:
        term = (term or "").strip()
        if not term or term in seen:
            continue
        out.append({"term": term, "chapterIntroduced": chapter_index})
        seen.add(term)
    if len(out) > _MAX_LEARNING_TARGETS:
        out = out[-_MAX_LEARNING_TARGETS:]
    return out


def recent_learning_targets_for_prompt(targets: list[dict] | None) -> list[str]:
    """The bounded, most-recent term list a later chapter's prompt may reuse
    (Checkpoint 5 wires this into _chapter_prompt; Checkpoint 1 only builds
    and tests the bookkeeping)."""
    terms = [t.get("term") for t in (targets or []) if isinstance(t, dict) and t.get("term")]
    return terms[-_PROMPT_RECENT_TARGETS:]
