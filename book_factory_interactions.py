"""book_factory_interactions.py — Signature Smart Interactive Book, Checkpoint 1.

Pure, stdlib-only validation + composition for the nine premium interaction
block types. Self-contained (no Mongo, no network, no protected-module
imports) — mirrors book_factory_validator.py's proven contract exactly:

  validate_<type>(semantic) -> (canonical_block_or_None, warnings: list[str])

A `None` canonical result means "drop this one optional block, keep the rest
of the chapter" — the SAME graceful-degradation policy already proven for
vocabulary/MCQ/fillblank. Nothing here can fail a chapter; the chapter-level
orchestration (book_factory_jobs._run_chapter, unchanged in Checkpoint 1)
decides what to do with a dropped block, exactly as it already does for a
dropped MCQ or vocabulary item.

THREE EXPLICIT STAGES (per the locked correction):
  A. Gemini SEMANTIC shape   — whatever the (future) chapter prompt asks for;
                                untrusted, may be malformed, is never spread
                                into a canonical book.
  B. VALIDATED internal shape — the return value of validate_<type>(); every
                                field is whitelisted, bounded, and type-checked.
  C. CANONICAL Reader block  — book_factory_composer.py strips it to its
                                per-type key whitelist immediately before
                                export (Checkpoint 1 adds the whitelist
                                entries; composition/export wiring itself is
                                Checkpoint 5 per the approved checkpoint plan).

Stage B and Stage C are IDENTICAL in this module (validate_<type> already
returns only whitelisted keys) — book_factory_composer.py's per-type key
whitelist is a second, independent gate (defence in depth), not a second
transformation.

No Gemini prompt in this codebase requests these fields yet (Checkpoint 1 is
foundation-only); this module is fully exercised by unit tests with synthetic
semantic input.
"""
from __future__ import annotations

import re
import uuid
from typing import Any, Optional

import book_factory_validator as bfv

# ── canonical block-type set (NOT yet added to book_factory_validator's
# ALLOWED_BLOCK_TYPES / book_factory_composer's export whitelist — that wiring
# is Checkpoint 5; Checkpoint 1 validates in isolation only) ────────────────
INTERACTION_BLOCK_TYPES: frozenset[str] = frozenset({
    "vocabgrid", "pronunciation", "matchpairs", "sentencebuilder",
    "responsechoice", "branchdialog", "checkpoint", "mission", "reveal",
})

# ── shared bounds (immutable — no env override; these are content-safety
# ceilings, not tunable knobs) ──────────────────────────────────────────────
_MAX_SHORT = 160     # word / title / label-length fields
_MAX_MEDIUM = 400    # sentence / line / consequence-length fields
_MAX_LONG = 700       # goal / insight / teaser-length fields
_MAX_ID_LEN = 40

_MAX_VOCABGRID_ITEMS = 8          # backstop; CEFR range is the real cap
_MAX_MATCHPAIRS = 6
_MIN_MATCHPAIRS = 2
_MAX_SENTENCE_TOKENS = 12
_MIN_SENTENCE_TOKENS = 3
_MAX_RESPONSE_OPTIONS = 4
_MIN_RESPONSE_OPTIONS = 2
_MAX_BRANCH_NODES = 6
_MAX_BRANCH_DEPTH = 2              # root (depth 1) + one reply level (depth 2)
_MAX_BRANCH_CHOICES_PER_NODE = 2
_MAX_CHECKPOINT_ITEMS = 5
_MIN_CHECKPOINT_ITEMS = 1
_MAX_HINTS = 3


def _clip(s: Any, limit: int) -> str:
    return str(s or "").strip()[:limit]


def _stable_id(prefix: str, seen: set[str], hint: Optional[str] = None) -> str:
    """Server-side stable-ID generator (§LOCKED CORRECTION 3): array index is
    NEVER identity. Uses the author-proposed id if present+unique+bounded,
    otherwise mints a short deterministic-looking id that cannot collide
    within this call. Never raises."""
    candidate = _clip(hint, _MAX_ID_LEN)
    candidate = re.sub(r"[^a-zA-Z0-9_]", "", candidate)
    if candidate and candidate not in seen:
        seen.add(candidate)
        return candidate
    for _ in range(50):
        gen = f"{prefix}_{uuid.uuid4().hex[:8]}"
        if gen not in seen:
            seen.add(gen)
            return gen
    gen = f"{prefix}_{uuid.uuid4().hex[:12]}"
    seen.add(gen)
    return gen


def _bounded_hints(raw: Any) -> list[str]:
    if not isinstance(raw, list):
        return []
    out = []
    for h in raw:
        if isinstance(h, str) and h.strip():
            out.append(_clip(h, _MAX_MEDIUM))
        if len(out) >= _MAX_HINTS:
            break
    return out


# ── 1. vocabgrid — one block, N validated words (per-item graceful drop,
# identical policy to today's per-word vocabulary handling) ────────────────
def validate_vocabgrid(semantic: dict, *, vocab_hi: int = 5) -> tuple[Optional[dict], list[str]]:
    if not isinstance(semantic, dict):
        return None, ["vocabgrid_not_object"]
    warnings: list[str] = []
    seen_ids: set[str] = set()
    items: list[dict] = []
    cap = min(int(vocab_hi or 5), _MAX_VOCABGRID_ITEMS)
    for raw in (semantic.get("items") or [])[: cap * 2]:  # bounded scan window
        if len(items) >= cap:
            break
        item, item_warnings = bfv.validate_vocab_item(raw)
        warnings.extend(f"vocab_issue:{w}" for w in item_warnings)
        if item:
            item["id"] = _stable_id("vocab", seen_ids, raw.get("id") if isinstance(raw, dict) else None)
            items.append(item)
    if not items:
        return None, warnings + ["vocabgrid_empty_after_validation"]
    return {
        "type": "vocabgrid",
        "title": _clip(semantic.get("title"), _MAX_SHORT) or "Key vocabulary",
        "subtitle": _clip(semantic.get("subtitle"), _MAX_MEDIUM),
        "items": items,
    }, warnings


# ── 2. pronunciation ────────────────────────────────────────────────────────
def validate_pronunciation(semantic: dict) -> tuple[Optional[dict], list[str]]:
    if not isinstance(semantic, dict):
        return None, ["pronunciation_not_object"]
    warnings: list[str] = []
    target = _clip(semantic.get("targetText"), _MAX_MEDIUM)
    if not target:
        return None, ["pronunciation_missing_targetText"]

    ipa_out = ""
    ok, norm, reason = bfv.validate_ipa(semantic.get("ipa"))
    if ok:
        ipa_out = norm
    elif semantic.get("ipa"):
        warnings.append(f"pronunciation_ipa_rejected:{reason}")

    stress_words: list[str] = []
    body_norm = bfv.normalize_text(target)
    for w in (semantic.get("stressWords") or [])[:6]:
        if not isinstance(w, str) or not w.strip():
            continue
        if bfv.normalize_text(w) not in body_norm:
            warnings.append(f"pronunciation_stress_word_not_in_text:{_clip(w, 40)}")
            continue
        stress_words.append(_clip(w, 40))

    linking_notes = [
        _clip(n, _MAX_SHORT) for n in (semantic.get("linkingNotes") or [])[:4]
        if isinstance(n, str) and n.strip()
    ]

    return {
        "type": "pronunciation",
        "id": _stable_id("pron", set(), semantic.get("id")),
        "targetText": target,
        "ipa": ipa_out,
        "stressWords": stress_words,
        "linkingNotes": linking_notes,
        "tip": _clip(semantic.get("tip"), _MAX_MEDIUM),
    }, warnings


# ── 3. matchpairs ────────────────────────────────────────────────────────────
def validate_matchpairs(semantic: dict) -> tuple[Optional[dict], list[str]]:
    if not isinstance(semantic, dict):
        return None, ["matchpairs_not_object"]
    warnings: list[str] = []
    seen_ids: set[str] = set()
    pairs: list[dict] = []
    for raw in (semantic.get("pairs") or [])[: _MAX_MATCHPAIRS * 2]:
        if len(pairs) >= _MAX_MATCHPAIRS:
            break
        if not isinstance(raw, dict):
            warnings.append("matchpairs_item_not_object")
            continue
        prompt = _clip(raw.get("prompt"), _MAX_SHORT)
        answer = _clip(raw.get("answer"), _MAX_SHORT)
        if not prompt or not answer:
            warnings.append("matchpairs_item_missing_prompt_or_answer")
            continue
        pairs.append({
            "id": _stable_id("pair", seen_ids, raw.get("id")),
            "prompt": prompt, "answer": answer,
        })
    if len(pairs) < _MIN_MATCHPAIRS:
        return None, warnings + ["matchpairs_below_minimum"]
    return {
        "type": "matchpairs",
        "title": _clip(semantic.get("title"), _MAX_SHORT) or "Match the pairs",
        "pairs": pairs,
    }, warnings


# ── 4. sentencebuilder — tokens carry an explicit targetPosition, never
# implicit array-index identity (§LOCKED CORRECTION 3), so repeated words are
# handled correctly ─────────────────────────────────────────────────────────
def validate_sentencebuilder(semantic: dict) -> tuple[Optional[dict], list[str]]:
    if not isinstance(semantic, dict):
        return None, ["sentencebuilder_not_object"]
    warnings: list[str] = []
    target_sentence = _clip(semantic.get("targetSentence"), _MAX_MEDIUM)
    if not target_sentence:
        return None, ["sentencebuilder_missing_targetSentence"]

    raw_tokens = semantic.get("tokens")
    if not isinstance(raw_tokens, list) or not (_MIN_SENTENCE_TOKENS <= len(raw_tokens) <= _MAX_SENTENCE_TOKENS):
        return None, ["sentencebuilder_token_count_out_of_bounds"]

    seen_ids: set[str] = set()
    tokens: list[dict] = []
    for i, raw in enumerate(raw_tokens):
        text = raw.get("text") if isinstance(raw, dict) else (raw if isinstance(raw, str) else None)
        if not isinstance(text, str) or not text.strip():
            return None, ["sentencebuilder_token_missing_text"]
        hint = raw.get("id") if isinstance(raw, dict) else None
        tokens.append({
            "id": _stable_id("tok", seen_ids, hint),
            "text": _clip(text, 40),
            "targetPosition": i,
        })

    # Grounding check: the assembled token stream (in targetPosition order)
    # must reconstruct something close to targetSentence (normalized,
    # whitespace-insensitive) — proves tokens aren't fabricated nonsense.
    assembled = " ".join(t["text"] for t in sorted(tokens, key=lambda t: t["targetPosition"]))
    if bfv.normalize_text(assembled) != bfv.normalize_text(target_sentence):
        warnings.append("sentencebuilder_tokens_do_not_reconstruct_sentence")

    return {
        "type": "sentencebuilder",
        "id": _stable_id("sb", set(), semantic.get("id")),
        "targetSentence": target_sentence,
        "tokens": tokens,
        "hints": _bounded_hints(semantic.get("hints")),
        "explain": _clip(semantic.get("explain"), _MAX_MEDIUM),
    }, warnings


# ── 5. responsechoice ───────────────────────────────────────────────────────
def validate_responsechoice(semantic: dict) -> tuple[Optional[dict], list[str]]:
    if not isinstance(semantic, dict):
        return None, ["responsechoice_not_object"]
    warnings: list[str] = []
    situation = _clip(semantic.get("situation"), _MAX_MEDIUM)
    opening = _clip(semantic.get("openingLine"), _MAX_MEDIUM)
    if not situation or not opening:
        return None, ["responsechoice_missing_situation_or_opening"]

    seen_ids: set[str] = set()
    options: list[dict] = []
    for raw in (semantic.get("options") or [])[: _MAX_RESPONSE_OPTIONS * 2]:
        if len(options) >= _MAX_RESPONSE_OPTIONS:
            break
        if not isinstance(raw, dict):
            continue
        text = _clip(raw.get("text"), _MAX_MEDIUM)
        consequence = _clip(raw.get("consequence"), _MAX_MEDIUM)
        if not text or not consequence:
            warnings.append("responsechoice_option_missing_text_or_consequence")
            continue
        options.append({
            "id": _stable_id("opt", seen_ids, raw.get("id")),
            "text": text, "consequence": consequence,
            "recommended": bool(raw.get("recommended")) is True,
        })
    if len(options) < _MIN_RESPONSE_OPTIONS:
        return None, warnings + ["responsechoice_below_minimum_options"]

    return {
        "type": "responsechoice",
        "id": _stable_id("resp", set(), semantic.get("id")),
        "situation": situation,
        "openingLine": opening,
        "options": options,
        "coachingInsight": _clip(semantic.get("coachingInsight"), _MAX_MEDIUM),
    }, warnings


# ── 6. branchdialog — full graph validation (§LOCKED CORRECTION 4) ─────────
def validate_branchdialog(semantic: dict) -> tuple[Optional[dict], list[str]]:
    if not isinstance(semantic, dict):
        return None, ["branchdialog_not_object"]
    situation = _clip(semantic.get("situation"), _MAX_MEDIUM)
    raw_nodes = semantic.get("nodes")
    if not situation or not isinstance(raw_nodes, list) or not raw_nodes:
        return None, ["branchdialog_missing_situation_or_nodes"]
    if len(raw_nodes) > _MAX_BRANCH_NODES:
        return None, ["branchdialog_too_many_nodes"]

    # §LOCKED CORRECTION 4 fix: detect TRUE author-supplied duplicate node
    # ids BEFORE any stamping. _stable_id() silently renames a colliding
    # proposed id to something new — correct for a standalone item (vocab,
    # matchpairs), but WRONG here: a node id is REFERENCED by other nodes'
    # choices[].next, so silently renaming one "n0" would either break a
    # legitimate reference or mask a genuine authoring error. Duplicates are
    # therefore checked directly on the raw, author-supplied ids first.
    raw_id_values = [
        raw.get("id").strip() for raw in raw_nodes
        if isinstance(raw, dict) and isinstance(raw.get("id"), str) and raw.get("id").strip()
    ]
    if len(raw_id_values) != len(set(raw_id_values)):
        return None, ["branchdialog_duplicate_node_ids"]

    seen_ids: set[str] = set()
    nodes: dict[str, dict] = {}
    order: list[str] = []
    for raw in raw_nodes:
        if not isinstance(raw, dict):
            return None, ["branchdialog_node_not_object"]
        line = _clip(raw.get("line"), _MAX_MEDIUM)
        speaker = _clip(raw.get("speaker"), _MAX_SHORT)
        if not line:
            return None, ["branchdialog_node_missing_line"]
        node_id = _stable_id("n", seen_ids, raw.get("id"))
        raw_choices = raw.get("choices") if isinstance(raw.get("choices"), list) else []
        if len(raw_choices) > _MAX_BRANCH_CHOICES_PER_NODE:
            return None, ["branchdialog_too_many_choices_in_node"]
        node = {"id": node_id, "speaker": speaker, "line": line, "choices": raw_choices}
        nodes[node_id] = node
        order.append(node_id)

    root_id = order[0]

    # Resolve + validate choice targets, unreachability, cycles, depth — using
    # the FIRST node in author order as the single root (§LOCKED CORRECTION 4:
    # "exactly one valid root node").
    resolved_nodes: dict[str, dict] = {}
    for nid in order:
        node = nodes[nid]
        choice_ids: set[str] = set()
        choices_out = []
        for raw_choice in node["choices"]:
            if not isinstance(raw_choice, dict):
                return None, ["branchdialog_choice_not_object"]
            text = _clip(raw_choice.get("text"), _MAX_MEDIUM)
            next_id_hint = raw_choice.get("next")
            if not text or not isinstance(next_id_hint, str) or next_id_hint not in nodes:
                return None, ["branchdialog_choice_missing_text_or_unresolved_next"]
            choices_out.append({
                "id": _stable_id("c", choice_ids, raw_choice.get("id")),
                "text": text, "next": next_id_hint,
            })
        resolved_nodes[nid] = {
            "id": nid, "speaker": node["speaker"], "line": node["line"], "choices": choices_out,
        }

    # Cycle + depth + reachability check via BFS from root.
    visited: dict[str, int] = {root_id: 1}
    frontier = [root_id]
    while frontier:
        nxt = []
        for nid in frontier:
            depth = visited[nid]
            for ch in resolved_nodes[nid]["choices"]:
                target = ch["next"]
                if target in visited:
                    if visited[target] <= depth:
                        return None, ["branchdialog_cycle_detected"]
                    continue
                if depth + 1 > _MAX_BRANCH_DEPTH:
                    return None, ["branchdialog_exceeds_max_depth"]
                visited[target] = depth + 1
                nxt.append(target)
        frontier = nxt

    if len(visited) != len(resolved_nodes):
        return None, ["branchdialog_unreachable_node"]

    return {
        "type": "branchdialog",
        "id": _stable_id("branch", set(), semantic.get("id")),
        "situation": situation,
        "rootId": root_id,
        "nodes": [resolved_nodes[nid] for nid in order],
    }, []


# ── 7. checkpoint — items are semantically MCQ/fillblank, converted through
# the EXACT existing exercise contracts (§LOCKED CORRECTION 5). No second,
# incompatible MCQ format is ever created.
#
# Conversion documented explicitly:
#   semantic question       -> canonical text          (via bf_validator.validate_mcq)
#   semantic correctIndex   -> canonical answer value   (options[correctIndex], full text)
#   semantic evidenceQuote  -> VALIDATION-ONLY field, stripped before canonical export
#   semantic explain        -> canonical explain (unchanged)
#   fillblank items pass through bf_validator.validate_fillblank unchanged.
# ────────────────────────────────────────────────────────────────────────────
def validate_checkpoint(semantic: dict, *, chapter_text: str = "") -> tuple[Optional[dict], list[str]]:
    if not isinstance(semantic, dict):
        return None, ["checkpoint_not_object"]
    warnings: list[str] = []
    seen_ids: set[str] = set()
    items: list[dict] = []
    for raw in (semantic.get("items") or [])[: _MAX_CHECKPOINT_ITEMS * 2]:
        if len(items) >= _MAX_CHECKPOINT_ITEMS:
            break
        if not isinstance(raw, dict):
            warnings.append("checkpoint_item_not_object")
            continue
        kind = str(raw.get("kind") or "").strip().lower()
        item_id = _stable_id("chk", seen_ids, raw.get("id"))
        if kind == "mcq":
            ok, reason = bfv.validate_mcq(raw, chapter_text)
            if not ok:
                warnings.append(f"checkpoint_mcq_dropped:{reason}")
                continue
            options = list(raw.get("options") or [])
            answer = options[int(raw.get("correctIndex", 0))]
            items.append({
                "id": item_id, "kind": "mcq",
                "text": _clip(raw.get("question"), _MAX_MEDIUM),
                "options": [_clip(o, _MAX_SHORT) for o in options],
                "answer": answer,
                "explain": _clip(raw.get("explain"), _MAX_MEDIUM),
            })
        elif kind == "fillblank":
            ok, reason = bfv.validate_fillblank(raw)
            if not ok:
                warnings.append(f"checkpoint_fillblank_dropped:{reason}")
                continue
            items.append({
                "id": item_id, "kind": "fillblank",
                "text": _clip(raw.get("text"), _MAX_MEDIUM),
                "answer": _clip(raw.get("answer"), _MAX_SHORT),
                "explain": _clip(raw.get("explain"), _MAX_MEDIUM),
            })
        else:
            warnings.append(f"checkpoint_unknown_item_kind:{kind or 'missing'}")

    if len(items) < _MIN_CHECKPOINT_ITEMS:
        return None, warnings + ["checkpoint_empty_after_validation"]

    return {
        "type": "checkpoint",
        "title": _clip(semantic.get("title"), _MAX_SHORT) or "Quick check",
        "items": items,
    }, warnings


# ── 8. mission ───────────────────────────────────────────────────────────────
def validate_mission(semantic: dict) -> tuple[Optional[dict], list[str]]:
    if not isinstance(semantic, dict):
        return None, ["mission_not_object"]
    goal = _clip(semantic.get("goal"), _MAX_LONG)
    if not goal:
        return None, ["mission_missing_goal"]
    return {
        "type": "mission",
        "id": _stable_id("mission", set(), semantic.get("id")),
        "goal": goal,
        "rehearsalPrompt": _clip(semantic.get("rehearsalPrompt"), _MAX_MEDIUM),
        "reflectionPrompt": _clip(semantic.get("reflectionPrompt"), _MAX_MEDIUM),
    }, []


# ── 9. reveal ────────────────────────────────────────────────────────────────
def validate_reveal(semantic: dict) -> tuple[Optional[dict], list[str]]:
    if not isinstance(semantic, dict):
        return None, ["reveal_not_object"]
    teaser = _clip(semantic.get("teaser"), _MAX_MEDIUM)
    insight = _clip(semantic.get("insight"), _MAX_LONG)
    if not teaser or not insight:
        return None, ["reveal_missing_teaser_or_insight"]
    return {
        "type": "reveal",
        "id": _stable_id("reveal", set(), semantic.get("id")),
        "teaser": teaser,
        "insight": insight,
        "example": _clip(semantic.get("example"), _MAX_MEDIUM),
    }, []


VALIDATORS = {
    "vocabgrid": validate_vocabgrid,
    "pronunciation": validate_pronunciation,
    "matchpairs": validate_matchpairs,
    "sentencebuilder": validate_sentencebuilder,
    "responsechoice": validate_responsechoice,
    "branchdialog": validate_branchdialog,
    "checkpoint": validate_checkpoint,
    "mission": validate_mission,
    "reveal": validate_reveal,
}

# ── Checkpoint-1 canonical export whitelist (used by tests now; wired into
# book_factory_composer.py's _BLOCK_KEY_WHITELIST/ALLOWED_BLOCK_TYPES at
# Checkpoint 5, per the approved checkpoint plan — kept separate here so nothing
# in the live export path changes yet). ─────────────────────────────────────
INTERACTION_BLOCK_KEY_WHITELIST: dict[str, tuple[str, ...]] = {
    "vocabgrid": ("type", "title", "subtitle", "items"),
    "pronunciation": ("type", "id", "targetText", "ipa", "stressWords", "linkingNotes", "tip"),
    "matchpairs": ("type", "title", "pairs"),
    "sentencebuilder": ("type", "id", "targetSentence", "tokens", "hints", "explain"),
    "responsechoice": ("type", "id", "situation", "openingLine", "options", "coachingInsight"),
    "branchdialog": ("type", "id", "situation", "rootId", "nodes"),
    "checkpoint": ("type", "title", "items"),
    "mission": ("type", "id", "goal", "rehearsalPrompt", "reflectionPrompt"),
    "reveal": ("type", "id", "teaser", "insight", "example"),
}
