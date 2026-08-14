"""tests/test_voice_treasure_scenes.py — bundled scene library (pure)."""
import random

import voice_treasure_scenes as s


def test_eight_scenes_present():
    assert len(s.ALL_SCENE_IDS) == 8
    assert len(set(s.ALL_SCENE_IDS)) == 8  # unique


def test_each_scene_has_required_fields():
    for sc in s.SCENES_BY_ID.values():
        for f in ("scene_id", "image_ref", "asset_file", "title", "alt",
                  "prompt", "difficulty", "theme", "keyword_hints", "rubric_focus"):
            assert sc.get(f), f"{sc['scene_id']} missing {f}"
        assert sc["difficulty"] in ("beginner", "intermediate", "advanced")


def test_public_scene_excludes_grounding():
    pub = s.public_scene(s.SCENES_BY_ID["zoo"])
    assert "rubric_focus" not in pub
    assert "keyword_hints" not in pub
    assert pub["image_ref"] == "vt-scene-zoo"


def test_grounding_context_includes_rubric_and_hints():
    ctx = s.grounding_context(s.SCENES_BY_ID["picnic"]).lower()
    assert "picnic" in ctx and "strong answer" in ctx


def test_disable_via_override():
    cfg = {"images": {"scene_overrides": {"zoo": {"enabled": False}}}}
    ids = [x["scene_id"] for x in s.enabled_scenes(cfg)]
    assert "zoo" not in ids and len(ids) == 7


def test_blocked_theme_excludes_scene():
    cfg = {"images": {"blocked_themes": ["celebrations"]}}
    ids = [x["scene_id"] for x in s.enabled_scenes(cfg)]
    assert "birthday" not in ids  # birthday is theme=celebrations


def test_prompt_override_applies():
    cfg = {"images": {"scene_overrides": {"balloon": {"prompt": "Custom prompt?"}}}}
    sc = next(x for x in s.effective_scenes(cfg) if x["scene_id"] == "balloon")
    assert sc["prompt"] == "Custom prompt?"


def test_assign_avoids_recent_repeat():
    cfg = {"images": {}}
    r = random.Random(42)
    # with only the recent one excluded, never returns it across many draws
    seen = set()
    for _ in range(50):
        sc = s.assign_scene(cfg, recent_scene_ids=["balloon"], rng=r)
        seen.add(sc["scene_id"])
    assert "balloon" not in seen


def test_assign_prefers_difficulty():
    cfg = {"images": {}}
    r = random.Random(7)
    for _ in range(20):
        sc = s.assign_scene(cfg, preferred_difficulty="advanced", rng=r)
        assert sc["difficulty"] == "advanced"  # only birthday is advanced


def test_assign_none_when_all_disabled():
    cfg = {"images": {"scene_overrides": {sid: {"enabled": False} for sid in s.ALL_SCENE_IDS}}}
    assert s.assign_scene(cfg) is None
