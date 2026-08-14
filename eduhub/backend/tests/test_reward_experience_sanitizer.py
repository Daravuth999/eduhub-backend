"""Reward Experience Engine v1 — sanitiser + backward-compat tests.

Guards the ADDITIVE `experience` field on Login Reward campaigns:
  • campaigns without it behave exactly as before (None passthrough)
  • hostile / malformed payloads are clamped or dropped
  • the claim pipeline never sees anything unbounded
"""
from login_reward_tools import (
    _LRCCampaignIn,
    _lrc_sanitize_experience,
    _lrc_validate_payload,
)


def test_none_passthrough():
    assert _lrc_sanitize_experience(None) is None
    assert _lrc_sanitize_experience("nope") is None
    assert _lrc_sanitize_experience(123) is None


def test_defaults_for_empty_dict():
    out = _lrc_sanitize_experience({})
    assert out["environment"] == "classic"
    assert out["glass"] == "auto"
    assert out["reveal"] == "cinematic"
    assert out["decorations"] == []
    assert out["backdrop_blur"] == 10


def test_enum_whitelisting():
    out = _lrc_sanitize_experience({
        "environment": "evil_env", "glass": "<script>", "lighting": "xx",
        "reveal": "spin9000", "particles": "lasers", "popup_size": "huge",
    })
    assert out["environment"] == "classic"
    assert out["glass"] == "auto"
    assert out["lighting"] == "auto"
    assert out["reveal"] == "cinematic"
    assert out["particles"] == "auto"
    assert out["popup_size"] == "standard"


def test_numeric_clamps():
    out = _lrc_sanitize_experience({"backdrop_blur": 9999, "env_intensity": -5})
    assert out["backdrop_blur"] == 24
    assert out["env_intensity"] == 0


def test_ambient_color_validation():
    assert _lrc_sanitize_experience({"ambient_color": "#D4A843"})["ambient_color"] == "#D4A843"
    assert _lrc_sanitize_experience({"ambient_color": "javascript:x"})["ambient_color"] == ""
    assert _lrc_sanitize_experience({"ambient_color": "url(evil)"})["ambient_color"] == ""


def test_decorations_bounded_and_sanitized():
    decs = [{"kind": "builtin", "asset": "lotus", "x": 500, "size": 99999}] * 60
    out = _lrc_sanitize_experience({"decorations": decs})
    assert len(out["decorations"]) == 40
    d = out["decorations"][0]
    assert d["x"] == 100 and d["size"] == 400


def test_decoration_asset_id_whitelist():
    out = _lrc_sanitize_experience({"decorations": [
        {"kind": "builtin", "asset": "<img onerror=1>"},
        {"kind": "builtin", "asset": "lotus"},
    ]})
    assert len(out["decorations"]) == 1
    assert out["decorations"][0]["asset"] == "lotus"


def test_custom_decoration_url_guard():
    out = _lrc_sanitize_experience({"decorations": [
        {"kind": "custom", "url": "javascript:alert(1)"},
        {"kind": "custom", "url": "http://insecure.example/x.png"},
        {"kind": "custom", "url": "https://cdn.example.com/x.png"},
    ]})
    assert len(out["decorations"]) == 1
    assert out["decorations"][0]["url"].startswith("https://")


def test_payload_backward_compatible_without_experience():
    p = _LRCCampaignIn(name="legacy")
    doc = _lrc_validate_payload(p)
    assert doc["experience"] is None
    # legacy reward fields untouched
    assert doc["reward_points"] == 20
    assert doc["reward_kind"] == "points"


def test_payload_persists_sanitized_experience():
    p = _LRCCampaignIn(name="exp", experience={"environment": "morning_angkor", "backdrop_blur": 100})
    doc = _lrc_validate_payload(p)
    assert doc["experience"]["environment"] == "morning_angkor"
    assert doc["experience"]["backdrop_blur"] == 24


# ── V2 additions ─────────────────────────────────────────────────────────

def test_v2_defaults_and_version():
    out = _lrc_sanitize_experience({})
    assert out["version"] == 2
    assert out["glass_config"]["border"] == "auto"
    assert out["lighting_config"]["direction"] == "top"
    assert out["typography"]["title_font"] == "default"
    assert out["cta"]["style"] == "solid"


def test_v2_new_enums_accepted():
    out = _lrc_sanitize_experience({
        "environment": "modern_studio", "reveal": "slide",
        "particles": "mist", "lighting": "sunset",
    })
    assert out["environment"] == "modern_studio"
    assert out["reveal"] == "slide"
    assert out["particles"] == "mist"
    assert out["lighting"] == "sunset"


def test_v2_nested_configs_clamped_and_whitelisted():
    out = _lrc_sanitize_experience({
        "glass_config": {"frost": 999, "border": "<x>", "depth": -3, "reflection": False},
        "lighting_config": {"intensity": 7, "direction": "diagonal", "color": "url(x)"},
        "typography": {"title_font": "comic", "title_weight": 9999, "align": "justify"},
        "cta": {"style": "neon", "radius": 500, "animation": "explode"},
    })
    assert out["glass_config"]["frost"] == 40
    assert out["glass_config"]["border"] == "auto"
    assert out["glass_config"]["depth"] == 0
    assert out["glass_config"]["reflection"] is False
    assert out["lighting_config"]["intensity"] == 1
    assert out["lighting_config"]["direction"] == "top"
    assert out["lighting_config"]["color"] == ""
    assert out["typography"]["title_font"] == "default"
    assert out["typography"]["title_weight"] == 900
    assert out["typography"]["align"] == "center"
    assert out["cta"]["style"] == "solid"
    assert out["cta"]["radius"] == 40
    assert out["cta"]["animation"] == "shimmer"


def test_v2_decoration_fields():
    out = _lrc_sanitize_experience({"decorations": [{
        "kind": "builtin", "asset": "lotus", "name": "x" * 200,
        "group": "g" * 100, "visible": False, "anim": "warp",
        "anim_speed": 100, "shadow": 5,
    }]})
    d = out["decorations"][0]
    assert len(d["name"]) == 60
    assert len(d["group"]) == 40
    assert d["visible"] is False
    assert d["anim"] == "none"
    assert d["anim_speed"] == 4
    assert d["shadow"] == 1


def test_v1_config_upgrades_cleanly_to_v2():
    v1 = {"version": 1, "environment": "vip_luxury", "decorations": [
        {"kind": "builtin", "asset": "crown", "x": 50, "y": 10},
    ]}
    out = _lrc_sanitize_experience(v1)
    assert out["version"] == 2
    assert out["environment"] == "vip_luxury"
    d = out["decorations"][0]
    assert d["visible"] is True and d["anim"] == "none" and d["group"] == ""
