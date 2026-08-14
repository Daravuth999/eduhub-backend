"""voice_treasure_scenes.py
============================
Bundled mission scene library for Voice Treasure — the production-safe launch
path that makes the game fully playable WITHOUT Gemini image generation.

Eight curated scenes ship as static frontend WebP assets (keyed by scene_id).
This module is the authoritative server-side catalog: it holds the public
metadata (title, alt, prompt, difficulty, theme) AND the private grounding data
(keyword hints + rubric focus) used to ground evaluation. The raw image bytes
live in the frontend bundle; the backend keeps its own copy so the EXACT
bytes that were assigned to a mission can be sent to Gemini.

Admin can enable/disable scenes and override prompt text via the config
(`scene_overrides` in voice_treasure config); see `effective_scenes`.

Nothing here imports other VT modules, GAS, or the DB.
"""
from __future__ import annotations

import os
import random
from typing import Any

# ── Server-side asset resolution ──────────────────────────────────────────
# The backend keeps its OWN copy of the bundled scene assets so it can load
# the EXACT bytes that were assigned to a mission and send them to Gemini.
# As of v5, all eight bundled runtime assets are WebP — opaque, text-free,
# copyright-safe — and live both in the backend (voice_treasure_assets/
# scenes/) and in the frontend bundle. SVG is no longer used at runtime.

_ASSET_DIR = os.path.join(os.path.dirname(os.path.abspath(__file__)),
                          "voice_treasure_assets", "scenes")
# Where Author-Studio-generated images would land in a degraded local-FS
# storage mode (tests only). The production-durable path uses GridFS via
# voice_treasure_media.py — this directory is NOT consulted in production.
GENERATED_MEDIA_DIR = os.environ.get(
    "VOICE_TREASURE_MEDIA_DIR",
    os.path.join(os.path.dirname(os.path.abspath(__file__)), "voice_treasure_assets", "generated"),
)

ALLOWED_IMAGE_MIME = {
    "image/png": ".png",
    "image/webp": ".webp",
    "image/jpeg": ".jpg",
}
_EXT_TO_MIME = {v: k for k, v in ALLOWED_IMAGE_MIME.items()}
MAX_IMAGE_BYTES = 4 * 1024 * 1024  # 4 MB decoded ceiling


class SceneAssetError(Exception):
    """Raised when an assigned image cannot be safely resolved/validated."""

# image_ref is the stable asset key the frontend maps to a bundled WebP.
# asset_file is advisory (documents the bundled filename).
_SCENES: tuple[dict[str, Any], ...] = (
    {
        "scene_id": "balloon",
        "image_ref": "vt-scene-balloon",
        "asset_file": "scene_balloon.webp",
        "title": "Hot Air Balloon Over the Hills",
        "alt": "A colorful hot air balloon floating above green hills and a blue lake at sunrise.",
        "prompt": "Describe this picture in 2 sentences. What do you see in the sky and on the ground?",
        "difficulty": "beginner",
        "theme": "nature",
        "keyword_hints": ["balloon", "sky", "hills", "lake", "trees", "fly", "float", "colorful", "sunrise"],
        "rubric_focus": "Mentions the balloon, the sky, and the landscape (hills/lake/trees) and a sense of floating.",
    },
    {
        "scene_id": "picnic",
        "image_ref": "vt-scene-picnic",
        "asset_file": "scene_picnic.webp",
        "title": "Family Picnic in the Park",
        "alt": "A family sitting on a checkered blanket in a green park with a picnic basket and food.",
        "prompt": "Describe what the family is doing in this picture. What food and objects can you see?",
        "difficulty": "beginner",
        "theme": "family_activities",
        "keyword_hints": ["family", "picnic", "blanket", "basket", "park", "grass", "food", "tree", "eat", "together"],
        "rubric_focus": "Mentions the people/family, the picnic blanket and basket, food items, and the park setting.",
    },
    {
        "scene_id": "sciencefair",
        "image_ref": "vt-scene-sciencefair",
        "asset_file": "scene_sciencefair.webp",
        "title": "School Science Fair",
        "alt": "Children standing at display boards at a school science fair with a model volcano.",
        "prompt": "Describe this science fair. What are the children showing and how do they feel?",
        "difficulty": "intermediate",
        "theme": "school",
        "keyword_hints": ["science", "fair", "students", "project", "display", "volcano", "experiment", "school", "present", "learn"],
        "rubric_focus": "Mentions the students, the display boards/projects, the science theme, and an action like presenting.",
    },
    {
        "scene_id": "market",
        "image_ref": "vt-scene-market",
        "asset_file": "scene_market.webp",
        "title": "Outdoor Fruit Market",
        "alt": "An outdoor market with striped stalls selling colorful fruits and food.",
        "prompt": "Describe this market. What is being sold and what colors do you notice?",
        "difficulty": "intermediate",
        "theme": "public_places",
        "keyword_hints": ["market", "stall", "fruit", "food", "buy", "sell", "colorful", "people", "shopping", "vegetables"],
        "rubric_focus": "Mentions the market stalls, the fruit/food being sold, colors, and a buying/selling action.",
    },
    {
        "scene_id": "beach_cleanup",
        "image_ref": "vt-scene-beach-cleanup",
        "asset_file": "scene_beach_cleanup.webp",
        "title": "Beach Cleanup",
        "alt": "Students cleaning a sandy beach, collecting litter into a bag near the sea.",
        "prompt": "Describe what the students are doing at the beach and why it is helpful.",
        "difficulty": "intermediate",
        "theme": "problem_solving",
        "keyword_hints": ["beach", "clean", "students", "trash", "bag", "sea", "sand", "help", "environment", "litter"],
        "rubric_focus": "Mentions the students, the cleanup action, the litter/bag, the beach/sea, and the helpful purpose.",
    },
    {
        "scene_id": "library",
        "image_ref": "vt-scene-library",
        "asset_file": "scene_library.webp",
        "title": "Library Reading Corner",
        "alt": "Children reading books on a rug in a cozy library with tall bookshelves.",
        "prompt": "Describe this library scene. What are the children doing and what is around them?",
        "difficulty": "beginner",
        "theme": "school",
        "keyword_hints": ["library", "books", "read", "shelf", "children", "quiet", "rug", "story", "learn", "cozy"],
        "rubric_focus": "Mentions the children reading, the books and shelves, and the quiet library setting.",
    },
    {
        "scene_id": "zoo",
        "image_ref": "vt-scene-zoo",
        "asset_file": "scene_zoo.webp",
        "title": "A Day at the Zoo",
        "alt": "Children watching a giraffe and a duck pond at the zoo on a sunny day.",
        "prompt": "Describe this zoo scene. Which animals do you see and what are the children doing?",
        "difficulty": "intermediate",
        "theme": "nature",
        "keyword_hints": ["zoo", "giraffe", "animals", "children", "watch", "fence", "pond", "duck", "tall", "visit"],
        "rubric_focus": "Mentions the animals (giraffe/duck), the children watching, and the zoo enclosure/pond.",
    },
    {
        "scene_id": "birthday",
        "image_ref": "vt-scene-birthday",
        "asset_file": "scene_birthday.webp",
        "title": "Birthday Party",
        "alt": "A birthday party with a cake, balloons, bunting and two friends celebrating.",
        "prompt": "Describe this birthday party. What decorations and food can you see?",
        "difficulty": "advanced",
        "theme": "celebrations",
        "keyword_hints": ["birthday", "party", "cake", "balloons", "candle", "celebrate", "friends", "decorations", "happy", "café"],
        "rubric_focus": "Mentions the cake/candle, balloons and decorations, the people celebrating, and the happy mood.",
    },
)

SCENES_BY_ID: dict[str, dict[str, Any]] = {s["scene_id"]: s for s in _SCENES}
ALL_SCENE_IDS: tuple[str, ...] = tuple(s["scene_id"] for s in _SCENES)

# Public-safe fields (sent to students / used to render). Excludes grounding.
_PUBLIC_FIELDS = ("scene_id", "image_ref", "asset_file", "title", "alt", "prompt", "difficulty", "theme")


def public_scene(scene: dict[str, Any]) -> dict[str, Any]:
    return {k: scene.get(k) for k in _PUBLIC_FIELDS}


def grounding_context(scene: dict[str, Any]) -> str:
    """Build the evaluation grounding text from a scene's prompt + rubric +
    keyword hints. This is what the evaluator is told the picture contains."""
    hints = ", ".join(scene.get("keyword_hints", [])[:12])
    return (
        f"{scene.get('alt', '')} "
        f"Speaking task: {scene.get('prompt', '')} "
        f"A strong answer: {scene.get('rubric_focus', '')} "
        f"Relevant vocabulary the learner might use: {hints}."
    )


def _overrides_map(cfg: dict[str, Any] | None) -> dict[str, dict[str, Any]]:
    images = (cfg or {}).get("images", {}) or {}
    ov = images.get("scene_overrides") or {}
    return ov if isinstance(ov, dict) else {}


def effective_scenes(cfg: dict[str, Any] | None) -> list[dict[str, Any]]:
    """Apply admin overrides (enabled flag, prompt text, difficulty, theme) on
    top of the bundled defaults. Unknown override keys are ignored. A scene is
    enabled unless an override explicitly sets enabled=False. Also respects
    blocked_themes from the images config."""
    ov = _overrides_map(cfg)
    blocked = set((((cfg or {}).get("images") or {}).get("blocked_themes")) or [])
    out: list[dict[str, Any]] = []
    for s in _SCENES:
        o = ov.get(s["scene_id"], {}) if isinstance(ov.get(s["scene_id"]), dict) else {}
        merged = dict(s)
        if "prompt" in o and isinstance(o["prompt"], str) and o["prompt"].strip():
            merged["prompt"] = o["prompt"].strip()
        if o.get("difficulty"):
            merged["difficulty"] = o["difficulty"]
        if o.get("theme"):
            merged["theme"] = o["theme"]
        merged["enabled"] = bool(o.get("enabled", True)) and (merged["theme"] not in blocked)
        out.append(merged)
    return out


def enabled_scenes(cfg: dict[str, Any] | None) -> list[dict[str, Any]]:
    return [s for s in effective_scenes(cfg) if s.get("enabled", True)]


def assign_scene(
    cfg: dict[str, Any] | None,
    *,
    recent_scene_ids: list[str] | None = None,
    preferred_difficulty: str | None = None,
    rng: random.Random | None = None,
) -> dict[str, Any] | None:
    """Server-side rotation. Random from enabled scenes, avoiding an immediate
    repeat of the most recent scene for the same student when possible, and
    preferring the student's configured difficulty/level when data exists.
    Returns a scene dict (with grounding) or None if nothing is enabled."""
    pool = enabled_scenes(cfg)
    if not pool:
        return None
    r = rng or random
    recent = set(recent_scene_ids or [])

    # 1) prefer matching difficulty if requested and available
    candidates = pool
    if preferred_difficulty and preferred_difficulty not in ("adaptive", "", None):
        matched = [s for s in pool if s.get("difficulty") == preferred_difficulty]
        if matched:
            candidates = matched

    # 2) avoid immediate repeat of the last scene when alternatives exist
    non_repeat = [s for s in candidates if s["scene_id"] not in recent]
    if non_repeat:
        candidates = non_repeat

    return r.choice(candidates)


# ── Exact asset-byte loading for evaluation ───────────────────────────────
def _safe_join(base: str, name: str) -> str:
    """Join + ensure the result stays within `base` (no path traversal)."""
    base_abs = os.path.abspath(base)
    target = os.path.abspath(os.path.join(base_abs, name))
    if not (target == base_abs or target.startswith(base_abs + os.sep)):
        raise SceneAssetError("path_outside_asset_root")
    return target


def load_scene_image_bytes(scene_id: str) -> tuple[bytes, str]:
    """Load the EXACT bundled asset bytes for a scene_id, server-side.
    Returns (bytes, mime). Raises SceneAssetError on missing/invalid/oversized.
    The scene_id MUST be a known library scene (the caller resolves it from the
    authoritative mission, never from client input)."""
    scene = SCENES_BY_ID.get(scene_id)
    if not scene:
        raise SceneAssetError("unknown_scene")
    asset_file = scene.get("asset_file") or ""
    _, ext = os.path.splitext(asset_file)
    mime = _EXT_TO_MIME.get(ext.lower())
    if not mime or mime not in ALLOWED_IMAGE_MIME:
        raise SceneAssetError("unsupported_asset_mime")
    path = _safe_join(_ASSET_DIR, asset_file)
    if not os.path.isfile(path):
        raise SceneAssetError("asset_not_found")
    data = open(path, "rb").read()
    if not data:
        raise SceneAssetError("empty_asset")
    if len(data) > MAX_IMAGE_BYTES:
        raise SceneAssetError("asset_too_large")
    return data, mime


def store_generated_image(reference: str, data: bytes, mime: str) -> str:
    """Persist a generated image into the approved media store under an opaque
    reference. Returns the stored relative path. Validates MIME + size."""
    if mime not in ALLOWED_IMAGE_MIME:
        raise SceneAssetError("unsupported_generated_mime")
    if not data or len(data) > MAX_IMAGE_BYTES:
        raise SceneAssetError("generated_size_invalid")
    os.makedirs(GENERATED_MEDIA_DIR, exist_ok=True)
    ext = ALLOWED_IMAGE_MIME[mime]
    safe_ref = "".join(c for c in reference if c.isalnum() or c in ("-", "_"))
    if not safe_ref:
        raise SceneAssetError("invalid_reference")
    path = _safe_join(GENERATED_MEDIA_DIR, safe_ref + ext)
    with open(path, "wb") as f:
        f.write(data)
    return os.path.relpath(path, os.path.dirname(os.path.abspath(__file__)))


def load_generated_image_bytes(image_ref: str) -> tuple[bytes, str]:
    """Load a previously stored generated image by opaque reference."""
    safe_ref = "".join(c for c in (image_ref or "") if c.isalnum() or c in ("-", "_"))
    if not safe_ref:
        raise SceneAssetError("invalid_reference")
    for mime, ext in ALLOWED_IMAGE_MIME.items():
        path = _safe_join(GENERATED_MEDIA_DIR, safe_ref + ext)
        if os.path.isfile(path):
            data = open(path, "rb").read()
            if not data:
                raise SceneAssetError("empty_generated")
            if len(data) > MAX_IMAGE_BYTES:
                raise SceneAssetError("generated_too_large")
            return data, mime
    raise SceneAssetError("generated_not_found")
