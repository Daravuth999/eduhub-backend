"""tests/test_video_scene_schema.py — pure schema/validation coverage for
the Video Library AI Production Engine's scene/story/script contracts.
Focus: malformed Gemini output must never reach production data (bounded,
validated, garbage rejected honestly rather than silently coerced into a
fake-looking success)."""
from __future__ import annotations

import video_scene_schema as vss


# ── StoryAnalysis ─────────────────────────────────────────────────────────
def test_build_scene_defaults_and_bounds():
    sc = vss.build_scene(start=1.2345, end=5.0, title="x" * 200, narrative_role="bogus")
    assert sc["start"] == 1.234 or sc["start"] == 1.235  # rounding
    assert len(sc["title"]) == 120
    assert sc["narrativeRole"] == "other"  # invalid role coerced, never trusted
    assert sc["sceneId"].startswith("sc_")


def test_build_scene_defaults_audio_observations_when_omitted():
    sc = vss.build_scene(start=0.0, end=1.0)
    assert sc["audioObservations"] == {"dialogue": "", "music": "", "ambience": "", "sfx": ""}


def test_build_scene_bounds_and_cleans_audio_observations():
    sc = vss.build_scene(start=0.0, end=1.0, audio_observations={
        "dialogue": "x" * 300, "music": "soft piano", "sfx": 42, "unexpected_key": "ignored",
    })
    assert len(sc["audioObservations"]["dialogue"]) == 200
    assert sc["audioObservations"]["music"] == "soft piano"
    assert sc["audioObservations"]["ambience"] == ""
    assert sc["audioObservations"]["sfx"] == "42"
    assert "unexpected_key" not in sc["audioObservations"]


def test_build_scene_handles_non_dict_audio_observations():
    sc = vss.build_scene(start=0.0, end=1.0, audio_observations="not a dict")
    assert sc["audioObservations"] == {"dialogue": "", "music": "", "ambience": "", "sfx": ""}


def test_normalize_story_analysis_parses_audio_observations_from_raw_scene():
    raw = {"scenes": [{
        "title": "with audio", "start": 0, "end": 5,
        "audioObservations": {"dialogue": "two speakers talking", "music": "", "ambience": "café noise", "sfx": ""},
    }]}
    result = vss.normalize_story_analysis(raw)
    scene = result["scenes"][0]
    assert scene["audioObservations"]["dialogue"] == "two speakers talking"
    assert scene["audioObservations"]["ambience"] == "café noise"


def test_normalize_story_analysis_defaults_audio_observations_when_missing_from_raw_scene():
    raw = {"scenes": [{"title": "no audio field", "start": 0, "end": 5}]}
    result = vss.normalize_story_analysis(raw)
    assert result["scenes"][0]["audioObservations"] == {"dialogue": "", "music": "", "ambience": "", "sfx": ""}


def test_build_scene_bounds_emotional_context():
    sc = vss.build_scene(start=0.0, end=1.0, emotional_context="x" * 500)
    assert len(sc["emotionalContext"]) == 400


def test_build_scene_defaults_emotional_context_to_empty_string():
    sc = vss.build_scene(start=0.0, end=1.0)
    assert sc["emotionalContext"] == ""


def test_normalize_story_analysis_parses_emotional_context_from_raw_scene():
    raw = {"scenes": [{
        "title": "reunion", "start": 0, "end": 5,
        "emotionalContext": "Emma is relieved to see her grandfather after months apart.",
    }]}
    result = vss.normalize_story_analysis(raw)
    assert result["scenes"][0]["emotionalContext"] == "Emma is relieved to see her grandfather after months apart."


def test_build_script_line_allows_a_rich_performance_direction_not_just_a_word():
    line = vss.build_script_line(
        speaker="Emma", text="Are you okay?",
        emotion="Gentle concern, natural conversational pace, a slight hesitation before asking.",
    )
    assert line["emotion"] == "Gentle concern, natural conversational pace, a slight hesitation before asking."


def test_build_script_line_bounds_emotion_at_300_chars():
    line = vss.build_script_line(speaker="Emma", text="Hi", emotion="x" * 500)
    assert len(line["emotion"]) == 300


def test_validate_story_analysis_rejects_duplicate_scene_ids():
    doc = vss.build_story_analysis(scenes=[
        vss.build_scene(scene_id="sc_1"),
        vss.build_scene(scene_id="sc_1"),
    ])
    ok, errors = vss.validate_story_analysis(doc)
    assert not ok
    assert any("duplicate" in e for e in errors)


def test_validate_story_analysis_rejects_missing_scene_id():
    doc = {"scenes": [{"title": "no id"}]}
    ok, errors = vss.validate_story_analysis(doc)
    assert not ok
    assert any("missing sceneId" in e for e in errors)


def test_validate_story_analysis_accepts_well_formed_doc():
    doc = vss.build_story_analysis(
        summary="A short story.",
        characters=[{"name": "Emma", "description": "the protagonist"}],
        scenes=[vss.build_scene(title="Opening", narrative_role="setup")],
        narrative_arc="setup -> resolution",
    )
    ok, errors = vss.validate_story_analysis(doc)
    assert ok, errors


def test_normalize_story_analysis_rejects_non_dict():
    assert vss.normalize_story_analysis([1, 2, 3]) is None
    assert vss.normalize_story_analysis("not json") is None
    assert vss.normalize_story_analysis(None) is None


def test_normalize_story_analysis_drops_malformed_scenes_keeps_valid_ones():
    raw = {
        "summary": "ok",
        "scenes": [
            {"title": "valid", "start": 0, "end": 5, "narrativeRole": "setup"},
            "not a dict",
            {"title": "bad timing", "start": "not-a-number", "end": 5},
            {"title": "unknown role", "start": 5, "end": 10, "narrativeRole": "nonsense"},
        ],
    }
    result = vss.normalize_story_analysis(raw)
    assert result is not None
    titles = [s["title"] for s in result["scenes"]]
    assert "valid" in titles
    assert "bad timing" not in titles  # unparseable timing dropped
    assert "unknown role" in titles  # kept, but role coerced
    unknown = next(s for s in result["scenes"] if s["title"] == "unknown role")
    assert unknown["narrativeRole"] == "other"


def test_normalize_story_analysis_bounds_character_and_scene_counts():
    raw = {"scenes": [{"title": f"s{i}", "start": i, "end": i + 1} for i in range(100)]}
    result = vss.normalize_story_analysis(raw)
    assert len(result["scenes"]) == 60  # hard cap


def test_normalize_story_analysis_accepts_string_character_list():
    raw = {"characters": ["Emma", "David", 42, ""]}
    result = vss.normalize_story_analysis(raw)
    names = [c["name"] for c in result["characters"]]
    assert names == ["Emma", "David"]  # non-string/empty entries dropped


def test_normalize_story_analysis_uses_injected_extract_json_for_text_response():
    calls = []

    def fake_extract(text):
        calls.append(text)
        return {"summary": "from text", "scenes": []}

    result = vss.normalize_story_analysis("raw model text", extract_json=fake_extract)
    assert calls == ["raw model text"]
    assert result["summary"] == "from text"


# ── ScriptBlueprint ───────────────────────────────────────────────────────
def test_validate_script_blueprint_rejects_unknown_scene_id():
    doc = vss.build_script_blueprint(scenes=[
        vss.build_scene_script(scene_id="sc_ghost", lines=[vss.build_script_line(speaker="Narrator", text="Hi")]),
    ])
    ok, errors = vss.validate_script_blueprint(doc, known_scene_ids={"sc_1"})
    assert not ok
    assert any("not in story analysis" in e for e in errors)


def test_validate_script_blueprint_rejects_line_missing_text_or_speaker():
    doc = vss.build_script_blueprint(scenes=[
        vss.build_scene_script(scene_id="sc_1", lines=[
            {"lineId": "ln_1", "speaker": "", "text": "hi"},
            {"lineId": "ln_2", "speaker": "Narrator", "text": ""},
        ]),
    ])
    ok, errors = vss.validate_script_blueprint(doc, known_scene_ids={"sc_1"})
    assert not ok
    assert any("missing speaker" in e for e in errors)
    assert any("missing text" in e for e in errors)


def test_validate_script_blueprint_accepts_well_formed_doc():
    doc = vss.build_script_blueprint(scenes=[
        vss.build_scene_script(scene_id="sc_1", lines=[
            vss.build_script_line(speaker="Narrator", text="Once upon a time."),
        ]),
    ])
    ok, errors = vss.validate_script_blueprint(doc, known_scene_ids={"sc_1"})
    assert ok, errors


def test_normalize_script_blueprint_drops_lines_referencing_unknown_scene():
    raw = {
        "scenes": [
            {"sceneId": "sc_1", "lines": [{"speaker": "Narrator", "text": "Scene one."}]},
            {"sceneId": "sc_ghost", "lines": [{"speaker": "Narrator", "text": "Should be dropped."}]},
        ],
    }
    result = vss.normalize_script_blueprint(raw, scene_ids_in_order=["sc_1", "sc_2"])
    scene_ids = [s["sceneId"] for s in result["scenes"]]
    assert scene_ids == ["sc_1", "sc_2"]  # every KNOWN scene present, in order
    assert result["scenes"][0]["lines"][0]["text"] == "Scene one."
    assert result["scenes"][1]["lines"] == []  # sc_2 had no Gemini output — honest empty, not fabricated


def test_normalize_script_blueprint_drops_lines_missing_speaker_or_text():
    raw = {"scenes": [{"sceneId": "sc_1", "lines": [
        {"speaker": "", "text": "no speaker"},
        {"speaker": "Narrator", "text": ""},
        {"speaker": "Narrator", "text": "kept"},
    ]}]}
    result = vss.normalize_script_blueprint(raw, scene_ids_in_order=["sc_1"])
    texts = [ln["text"] for ln in result["scenes"][0]["lines"]]
    assert texts == ["kept"]


def test_normalize_script_blueprint_rejects_non_dict():
    assert vss.normalize_script_blueprint([1, 2], scene_ids_in_order=["sc_1"]) is None


def test_normalize_script_blueprint_preserves_known_scene_order_regardless_of_gemini_order():
    raw = {"scenes": [
        {"sceneId": "sc_3", "lines": []},
        {"sceneId": "sc_1", "lines": []},
    ]}
    result = vss.normalize_script_blueprint(raw, scene_ids_in_order=["sc_1", "sc_2", "sc_3"])
    assert [s["sceneId"] for s in result["scenes"]] == ["sc_1", "sc_2", "sc_3"]
