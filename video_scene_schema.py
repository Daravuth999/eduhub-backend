"""video_scene_schema.py — canonical scene / whole-story analysis / script
blueprint schema for the Video Library's AI Production Engine.

Pure, stdlib-only, no Mongo/network — same purity discipline as
sync_schema.py and video_schema.py. Nothing here knows about Gemini,
ElevenLabs, or Mongo; it only defines the shape of the data those systems
produce/consume and bounds/validates untrusted model output before it is
ever persisted, exactly mirroring video_ai_provider.py's existing
normalize_learning() bounded-contract discipline.

Two distinct artifacts, matching the product's two production modes:

  StoryAnalysis (Mode A) — Gemini's whole-video understanding: scene
      boundaries, characters, and narrative structure, grounded in the
      FULL video (not scene-by-scene in isolation) so a later scene's
      narration can reference earlier context.

  ScriptBlueprint (Mode B) — Gemini's drafted scene-by-scene narration/
      dialogue script, grounded in the StoryAnalysis above. This is a
      DRAFT only: the administrator reviews and edits it before any
      ElevenLabs voice generation happens (see video_narration_tools.py).

Neither schema stores or implies a "correct" answer — a scene missing a
field, or a script with zero lines, is valid and handled honestly
throughout the pipeline (never fabricated to look complete).
"""
from __future__ import annotations

import uuid

NARRATIVE_ROLES = ("setup", "development", "conflict", "climax", "resolution", "other")


def new_scene_id() -> str:
    return "sc_" + uuid.uuid4().hex[:8]


def new_line_id() -> str:
    return "ln_" + uuid.uuid4().hex[:8]


def _s(v, limit=400) -> str:
    return str(v)[:limit] if isinstance(v, (str, int, float)) else ""


def _str_list(v, limit=30, item_limit=60) -> list[str]:
    if not isinstance(v, list):
        return []
    return [_s(x, item_limit) for x in v if _s(x, item_limit)][:limit]


# Free-text per-scene observations of what Gemini heard in the ORIGINAL
# audio track — item 5's "can Gemini understand/classify existing audio"
# question, answered honestly: this is Gemini DESCRIBING content it
# perceives (a real multimodal-understanding capability), never a claim
# that those layers can be technically SEPARATED into stems — that is a
# distinct, unimplemented capability (see video_render_tools.py's
# treatment-mode docstring). An empty string means "nothing observed",
# not "silence confirmed" — Gemini's confidence here is descriptive, not
# a guaranteed detector.
AUDIO_OBSERVATION_KEYS = ("dialogue", "music", "ambience", "sfx")


def _clean_audio_observations(v) -> dict:
    if not isinstance(v, dict):
        v = {}
    return {k: _s(v.get(k), 200) for k in AUDIO_OBSERVATION_KEYS}


# ── StoryAnalysis (Mode A) ────────────────────────────────────────────────
def _clean_visual_events(raw) -> list[dict]:
    """Optional, sparse list — Gemini reports a visual event ONLY when it
    can confidently point to one; an empty list is the correct, honest
    output for a scene with no distinct visual beat worth calling out, not
    a sign of missing data. Never fabricated: each entry must carry its
    own timestamp, since a description with no timestamp isn't a usable
    production input (see video_narration_tools.py's scene-anchoring,
    which needs a real number to place anything against)."""
    if not isinstance(raw, list):
        return []
    out: list[dict] = []
    for item in raw[:20]:
        if not isinstance(item, dict):
            continue
        try:
            ts = float(item.get("timestamp"))
        except (TypeError, ValueError):
            continue
        desc = str(item.get("description") or "").strip()[:200]
        if not desc or ts < 0:
            continue
        out.append({"timestamp": round(ts, 3), "description": desc})
    return out


def build_scene(
    *,
    scene_id: str | None = None,
    start: float = 0.0,
    end: float = 0.0,
    title: str = "",
    description: str = "",
    characters: list[str] | None = None,
    speakers: list[str] | None = None,
    narrative_role: str = "other",
    confidence: float | None = None,
    audio_observations: dict | None = None,
    emotional_context: str = "",
    visual_events: list[dict] | None = None,
) -> dict:
    return {
        "sceneId": scene_id or new_scene_id(),
        "start": round(float(start), 3),
        "end": round(float(end), 3),
        "title": str(title or "")[:120],
        "description": str(description or "")[:600],
        "characters": [str(c)[:60] for c in (characters or []) if str(c).strip()][:20],
        "speakers": [str(s)[:20] for s in (speakers or []) if str(s).strip()][:20],
        "narrativeRole": narrative_role if narrative_role in NARRATIVE_ROLES else "other",
        "confidence": confidence,
        "audioObservations": _clean_audio_observations(audio_observations),
        # Who feels what and why, and how characters relate in this scene —
        # feeds the script-drafting prompt so performance direction is
        # grounded in real scene context rather than a generic mood label.
        "emotionalContext": str(emotional_context or "")[:400],
        # Sparse, optional, real-timestamped visual beats within the scene
        # (e.g. "12.4s — Daniel closes the laptop") — informational
        # production context for Author Studio and future SFX/performance
        # anchoring; never required, never guessed when Gemini reports none.
        "visualEvents": _clean_visual_events(visual_events),
    }


def build_story_analysis(
    *,
    summary: str = "",
    characters: list[dict] | None = None,
    scenes: list[dict] | None = None,
    narrative_arc: str = "",
    generated_at: str = "",
    engine: str = "",
) -> dict:
    return {
        "summary": str(summary or "")[:1500],
        "characters": characters or [],
        "scenes": scenes or [],
        "narrativeArc": str(narrative_arc or "")[:1500],
        "generatedAt": generated_at,
        "engine": engine,
    }


def validate_story_analysis(doc: dict) -> tuple[bool, list[str]]:
    errors: list[str] = []
    if not isinstance(doc, dict):
        return False, ["document is not a dict"]
    scenes = doc.get("scenes")
    if not isinstance(scenes, list):
        errors.append("scenes must be a list")
    else:
        seen_ids = set()
        for i, sc in enumerate(scenes):
            if not isinstance(sc, dict) or not sc.get("sceneId"):
                errors.append(f"scenes[{i}] missing sceneId")
                continue
            if sc["sceneId"] in seen_ids:
                errors.append(f"scenes[{i}] duplicate sceneId {sc['sceneId']!r}")
            seen_ids.add(sc["sceneId"])
            if sc.get("narrativeRole") not in NARRATIVE_ROLES:
                errors.append(f"scenes[{i}] invalid narrativeRole {sc.get('narrativeRole')!r}")
    characters = doc.get("characters")
    if characters is not None and not isinstance(characters, list):
        errors.append("characters must be a list")
    return (len(errors) == 0), errors


def normalize_story_analysis(raw, *, extract_json=None) -> dict | None:
    """Coerce raw Gemini JSON into the bounded StoryAnalysis contract.
    Malformed/garbage input never reaches production data — returns None
    rather than persisting a half-formed or attacker-controlled structure.
    `extract_json` lets callers reuse video_ai_provider._extract_json for a
    raw text response; when `raw` is already a dict, it's used as-is."""
    data = extract_json(raw) if isinstance(raw, str) and extract_json else raw
    if not isinstance(data, dict):
        return None

    raw_scenes = data.get("scenes")
    scenes: list[dict] = []
    if isinstance(raw_scenes, list):
        for item in raw_scenes[:60]:
            if not isinstance(item, dict):
                continue
            try:
                start = max(0.0, float(item.get("start", 0) or 0))
                end = max(start, float(item.get("end", start) or start))
            except (TypeError, ValueError):
                continue
            role = _s(item.get("narrativeRole"), 20).lower()
            scenes.append(build_scene(
                start=start, end=end,
                title=_s(item.get("title"), 120),
                description=_s(item.get("description"), 600),
                characters=_str_list(item.get("characters"), 20, 60),
                speakers=_str_list(item.get("speakers"), 20, 20),
                narrative_role=role if role in NARRATIVE_ROLES else "other",
                confidence=(
                    float(item["confidence"])
                    if isinstance(item.get("confidence"), (int, float)) else None
                ),
                audio_observations=item.get("audioObservations"),
                emotional_context=_s(item.get("emotionalContext"), 400),
                visual_events=item.get("visualEvents"),
            ))

    raw_characters = data.get("characters")
    characters: list[dict] = []
    if isinstance(raw_characters, list):
        for item in raw_characters[:30]:
            if isinstance(item, dict) and _s(item.get("name"), 60):
                characters.append({
                    "name": _s(item.get("name"), 60),
                    "description": _s(item.get("description"), 300),
                })
            elif isinstance(item, str) and item.strip():
                characters.append({"name": _s(item, 60), "description": ""})

    return build_story_analysis(
        summary=_s(data.get("summary"), 1500),
        characters=characters,
        scenes=scenes,
        narrative_arc=_s(data.get("narrativeArc"), 1500),
    )


# ── ScriptBlueprint (Mode B) ──────────────────────────────────────────────
# `emotion` is the line's full PERFORMANCE DIRECTION — natural-language
# context (pace, warmth, hesitation, restraint, relationship to the
# listener, why the line is being said). This full note is production data
# only: it is shown in Author Studio and used to derive a short delivery
# cue for ElevenLabs (video_narration_tools._short_acting_cue +
# elevenlabs_generate_line's real eleven_v3 bracket-instruction mechanism,
# `f"[{cue}] {text}"` — not a new/invented ElevenLabs capability). It must
# NEVER reach the student-facing sync document / transcript / karaoke —
# elevenlabs_generate_line strips the bracket's own word_timestamps
# entries before they can become sync_schema words. Bounded at 300 chars:
# enough for a real directorial note, not so much that a bad Gemini
# response can dominate the line's own text.
def build_script_line(
    *, line_id: str | None = None, speaker: str = "", text: str = "", emotion: str = "",
) -> dict:
    return {
        "lineId": line_id or new_line_id(),
        "speaker": str(speaker or "")[:60],
        "text": str(text or "")[:600],
        "emotion": str(emotion or "")[:300],
    }


def build_scene_script(*, scene_id: str, lines: list[dict] | None = None) -> dict:
    return {"sceneId": scene_id, "lines": lines or []}


def build_script_blueprint(*, scenes: list[dict] | None = None, generated_at: str = "", engine: str = "") -> dict:
    return {"scenes": scenes or [], "generatedAt": generated_at, "engine": engine}


def validate_script_blueprint(doc: dict, *, known_scene_ids: set[str] | None = None) -> tuple[bool, list[str]]:
    errors: list[str] = []
    if not isinstance(doc, dict):
        return False, ["document is not a dict"]
    scenes = doc.get("scenes")
    if not isinstance(scenes, list):
        return False, ["scenes must be a list"]
    for i, sc in enumerate(scenes):
        if not isinstance(sc, dict) or not sc.get("sceneId"):
            errors.append(f"scenes[{i}] missing sceneId")
            continue
        if known_scene_ids is not None and sc["sceneId"] not in known_scene_ids:
            errors.append(f"scenes[{i}] sceneId {sc['sceneId']!r} not in story analysis")
        lines = sc.get("lines")
        if not isinstance(lines, list):
            errors.append(f"scenes[{i}] lines must be a list")
            continue
        seen_line_ids = set()
        for j, ln in enumerate(lines):
            if not isinstance(ln, dict) or not ln.get("lineId"):
                errors.append(f"scenes[{i}].lines[{j}] missing lineId")
                continue
            if ln["lineId"] in seen_line_ids:
                errors.append(f"scenes[{i}].lines[{j}] duplicate lineId {ln['lineId']!r}")
            seen_line_ids.add(ln["lineId"])
            if not str(ln.get("speaker") or "").strip():
                errors.append(f"scenes[{i}].lines[{j}] missing speaker")
            if not str(ln.get("text") or "").strip():
                errors.append(f"scenes[{i}].lines[{j}] missing text")
    return (len(errors) == 0), errors


def normalize_script_blueprint(raw, scene_ids_in_order: list[str], *, extract_json=None) -> dict | None:
    """Coerce raw Gemini JSON into the bounded ScriptBlueprint contract,
    keyed to the REAL scene ids from the already-approved story analysis
    (Gemini is asked to reference scenes by id, but any scene it invents
    that doesn't match a known id is dropped rather than trusted). Returns
    None for genuinely unusable input — an empty-but-valid blueprint is
    different from a malformed one and is still returned as such."""
    data = extract_json(raw) if isinstance(raw, str) and extract_json else raw
    if not isinstance(data, dict):
        return None
    known_ids = set(scene_ids_in_order)

    raw_scenes = data.get("scenes")
    scenes: list[dict] = []
    if isinstance(raw_scenes, list):
        for item in raw_scenes[:60]:
            if not isinstance(item, dict):
                continue
            scene_id = _s(item.get("sceneId"), 20)
            if scene_id not in known_ids:
                continue
            raw_lines = item.get("lines")
            lines: list[dict] = []
            if isinstance(raw_lines, list):
                for ln in raw_lines[:100]:
                    if not isinstance(ln, dict):
                        continue
                    speaker = _s(ln.get("speaker"), 60)
                    text = _s(ln.get("text"), 600)
                    if not speaker or not text:
                        continue
                    lines.append(build_script_line(
                        speaker=speaker, text=text, emotion=_s(ln.get("emotion"), 40),
                    ))
            scenes.append(build_scene_script(scene_id=scene_id, lines=lines))

    # Preserve the original scene order (Gemini's own ordering is not
    # trusted) and ensure every known scene has an entry, even if empty —
    # the script editor UI shows every scene, never silently drops one
    # Gemini forgot to write.
    by_id = {sc["sceneId"]: sc for sc in scenes}
    ordered = [by_id.get(sid) or build_scene_script(scene_id=sid) for sid in scene_ids_in_order]
    return build_script_blueprint(scenes=ordered)
