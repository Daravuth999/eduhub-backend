"""tests/test_voice_treasure_bilingual.py
=========================================
Bilingual evaluation policy + safe prompt-clause tests. Pure functions only;
no network, no DB, no provider calls. Live Khmer Gemini probing is NOT done
here (no production key in this verification environment).
"""
from __future__ import annotations

import pytest

import voice_treasure_config_tools as cfg
import voice_treasure_bilingual as vt_lang


def _base():
    c = cfg.default_config()
    # Touch the language block so we work with copies.
    c["language"] = dict(c["language"])
    return c


# ── Validation ─────────────────────────────────────────────────────────────
@pytest.mark.parametrize("rl", ["english", "khmer", "english_or_khmer", "mixed"])
def test_response_language_modes_validate(rl):
    c = _base()
    c["language"]["response_language"] = rl
    cfg.validate_config(c)  # no exception


@pytest.mark.parametrize("fl", ["english", "khmer", "match", "bilingual"])
def test_feedback_language_modes_validate(fl):
    c = _base()
    c["language"]["feedback_language"] = fl
    cfg.validate_config(c)


@pytest.mark.parametrize("il", ["english", "khmer", "bilingual"])
def test_instruction_language_modes_validate(il):
    c = _base()
    c["language"]["mission_instruction_language"] = il
    cfg.validate_config(c)


def test_response_language_invalid_value_rejected():
    c = _base()
    c["language"]["response_language"] = "spanish"
    with pytest.raises(cfg.VTValidationError):
        cfg.validate_config(c)


def test_feedback_language_invalid_value_rejected():
    c = _base()
    c["language"]["feedback_language"] = "klingon"
    with pytest.raises(cfg.VTValidationError):
        cfg.validate_config(c)


def test_template_text_length_bounded():
    c = _base()
    c["language"]["mission_instruction_text_en"] = "x" * 1000
    with pytest.raises(cfg.VTValidationError):
        cfg.validate_config(c)


def test_template_text_must_be_string():
    c = _base()
    c["language"]["mission_instruction_text_en"] = 123  # type: ignore[assignment]
    with pytest.raises(cfg.VTValidationError):
        cfg.validate_config(c)


# ── Policy resolution ──────────────────────────────────────────────────────
def test_policy_freezes_score_schema():
    c = _base()
    p = cfg.evaluation_language_policy(c)
    # The five normalized categories — and ONLY those — survive.
    assert set(p["score_categories"]) == {
        "relevance", "visual_grounding", "detail",
        "organization", "understandable_language",
    }


def test_policy_carries_response_and_feedback_modes():
    c = _base()
    c["language"]["response_language"] = "english_or_khmer"
    c["language"]["feedback_language"] = "match"
    p = cfg.evaluation_language_policy(c)
    assert p["response_language"] == "english_or_khmer"
    assert p["feedback_language"] == "match"


# ── Prompt-clause builder safety ───────────────────────────────────────────
@pytest.mark.parametrize("rl", ["english", "khmer", "english_or_khmer", "mixed"])
@pytest.mark.parametrize("fl", ["english", "khmer", "match", "bilingual"])
def test_clause_builds_for_every_mode_combo_and_never_leaks(rl, fl):
    c = _base()
    c["language"]["response_language"] = rl
    c["language"]["feedback_language"] = fl
    clause = vt_lang.build_evaluator_language_clause(
        cfg.evaluation_language_policy(c)
    )
    assert isinstance(clause, str) and clause
    # The frozen schema MUST be mentioned in every clause.
    for cat in ("relevance", "visual_grounding", "detail",
                "organization", "understandable_language"):
        assert cat in clause
    # Safety: no API keys, URLs, or internal model identifiers leak through.
    for forbidden in ("api_key", "apikey", "https://", "Bearer ",
                       "generativelanguage", "gemini-", "model="):
        assert forbidden.lower() not in clause.lower(), (
            f"clause leaked: {forbidden}"
        )


def test_instruction_text_bilingual_returns_both():
    c = _base()
    c["language"]["mission_instruction_language"] = "bilingual"
    out = vt_lang.resolve_instruction_text(
        cfg.evaluation_language_policy(c), c["language"]
    )
    assert out["lang"] == "en+km"
    assert out["primary"] and out["secondary"]


def test_instruction_text_khmer_returns_km_only():
    c = _base()
    c["language"]["mission_instruction_language"] = "khmer"
    out = vt_lang.resolve_instruction_text(
        cfg.evaluation_language_policy(c), c["language"]
    )
    assert out["lang"] == "km" and out["primary"]
    assert out["secondary"] == ""


def test_admin_override_text_used_when_provided():
    c = _base()
    c["language"]["mission_instruction_language"] = "english"
    c["language"]["mission_instruction_text_en"] = "Tell me about this scene."
    out = vt_lang.resolve_instruction_text(
        cfg.evaluation_language_policy(c), c["language"]
    )
    assert out["primary"] == "Tell me about this scene."


def test_unavailable_and_retry_localize():
    c = _base()
    c["language"]["feedback_language"] = "khmer"
    p = cfg.evaluation_language_policy(c)
    u = vt_lang.localize_unavailable_text(p, c["language"])
    r = vt_lang.localize_retry_text(p, c["language"])
    # Khmer Unicode block U+1780..U+17FF must be present.
    assert any("\u1780" <= ch <= "\u17ff" for ch in u)
    assert any("\u1780" <= ch <= "\u17ff" for ch in r)


def test_response_language_label_is_safe_string():
    c = _base()
    for rl in ("english", "khmer", "english_or_khmer", "mixed"):
        c["language"]["response_language"] = rl
        label = vt_lang.accepted_response_language_label(
            cfg.evaluation_language_policy(c)
        )
        assert isinstance(label, str) and label
        assert "<" not in label and "&" not in label   # no html injection


def test_evaluator_score_categories_are_immutable_across_languages():
    """Regardless of language combo, the score schema does not change."""
    c = _base()
    base_cats = set(cfg.evaluation_language_policy(c)["score_categories"])
    for rl in ("english", "khmer", "english_or_khmer", "mixed"):
        for fl in ("english", "khmer", "match", "bilingual"):
            c["language"]["response_language"] = rl
            c["language"]["feedback_language"] = fl
            assert set(cfg.evaluation_language_policy(c)["score_categories"]) == base_cats
