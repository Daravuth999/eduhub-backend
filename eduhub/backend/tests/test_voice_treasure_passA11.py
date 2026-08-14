"""VT Pass A.1.1 — hardened frozen-snapshot enum validation.

The Pass A.1 audit found that stored snapshot values were defaulted but
not enum-validated. The resolver now clamps every selector to its
approved enum and falls back safely. Each test below pins one bucket of
the seven required cases.
"""
from __future__ import annotations

import pytest

import voice_treasure_attempt_tools as vt_attempt
import voice_treasure_config_tools as vt_cfg


def _attempt_with_snapshot(snap):
    return {"attempt_id": "a", "state": "evaluated",
            "language_policy_snapshot": snap}


def _current_cfg():
    return vt_cfg.default_config()


# 1. Valid snapshot — passes through unchanged.
@pytest.mark.parametrize("snap", [
    {"response_language": "english", "feedback_language": "english",
     "instruction_language": "english"},
    {"response_language": "khmer", "feedback_language": "khmer",
     "instruction_language": "khmer"},
    {"response_language": "english_or_khmer", "feedback_language": "bilingual",
     "instruction_language": "bilingual"},
    {"response_language": "mixed", "feedback_language": "match",
     "instruction_language": "english"},
])
def test_valid_snapshot_passes_through(snap):
    out = vt_attempt._resolve_attempt_language_policy(
        _attempt_with_snapshot(snap), _current_cfg())
    assert out == snap


# 2. Missing keys — each missing selector falls back to english; the
#    present selectors are unchanged.
def test_snapshot_missing_keys_fall_back_to_english():
    snap = {"feedback_language": "khmer"}
    out = vt_attempt._resolve_attempt_language_policy(
        _attempt_with_snapshot(snap), _current_cfg())
    assert out == {
        "response_language": "english",
        "feedback_language": "khmer",
        "instruction_language": "english",
    }


# 3. Invalid response_language enum value.
@pytest.mark.parametrize("bad", ["pirate", "EN", "english_or_french", "", None, 42, []])
def test_invalid_response_language_falls_back(bad):
    snap = {"response_language": bad,
            "feedback_language": "khmer",
            "instruction_language": "khmer"}
    out = vt_attempt._resolve_attempt_language_policy(
        _attempt_with_snapshot(snap), _current_cfg())
    assert out["response_language"] == "english"
    # Other valid selectors stay intact.
    assert out["feedback_language"] == "khmer"
    assert out["instruction_language"] == "khmer"


# 4. Invalid feedback_language enum value.
@pytest.mark.parametrize("bad", ["pidgin", "MATCH", "smart", "", None, 0])
def test_invalid_feedback_language_falls_back(bad):
    snap = {"response_language": "khmer",
            "feedback_language": bad,
            "instruction_language": "khmer"}
    out = vt_attempt._resolve_attempt_language_policy(
        _attempt_with_snapshot(snap), _current_cfg())
    assert out["feedback_language"] == "english"
    assert out["response_language"] == "khmer"
    assert out["instruction_language"] == "khmer"


# 5. Invalid instruction_language enum value.
@pytest.mark.parametrize("bad", ["english_or_khmer", "match", "mixed", "", None, []])
def test_invalid_instruction_language_falls_back(bad):
    # NB: english_or_khmer/match/mixed are valid for OTHER selectors but
    # not for instruction_language. The clamp must reject them per-key.
    snap = {"response_language": "english",
            "feedback_language": "match",
            "instruction_language": bad}
    out = vt_attempt._resolve_attempt_language_policy(
        _attempt_with_snapshot(snap), _current_cfg())
    assert out["instruction_language"] == "english"
    assert out["response_language"] == "english"
    assert out["feedback_language"] == "match"


# 6. Fully corrupted snapshot — every selector falls back to english.
@pytest.mark.parametrize("snap", [
    {"response_language": None, "feedback_language": None, "instruction_language": None},
    {"response_language": "abc", "feedback_language": "xyz", "instruction_language": "qq"},
    {"response_language": 1, "feedback_language": {}, "instruction_language": []},
    {},  # entirely empty
    {"random_unknown_field": "leak"},  # extraneous-only
])
def test_fully_corrupted_snapshot_falls_back_to_english(snap):
    out = vt_attempt._resolve_attempt_language_policy(
        _attempt_with_snapshot(snap), _current_cfg())
    assert out == {
        "response_language": "english",
        "feedback_language": "english",
        "instruction_language": "english",
    }


# 7. Legacy attempt without a snapshot — uses the current resolved policy,
#    but every returned selector is still clamped to its enum.
def test_legacy_attempt_without_snapshot_uses_current_policy_clamped():
    attempt = {"attempt_id": "legacy", "state": "evaluated"}  # no snapshot
    cfg = _current_cfg()
    # Force a current cfg whose mission_instruction_language is valid but
    # whose feedback_language is corrupted (simulates a manual DB write):
    cfg["language"]["feedback_language"] = "garbage"
    cfg["language"]["mission_instruction_language"] = "khmer"
    out = vt_attempt._resolve_attempt_language_policy(attempt, cfg)
    # feedback corrupted -> english fallback; instruction passes through.
    assert out["feedback_language"] == "english"
    assert out["instruction_language"] == "khmer"
    # response_language defaults to english in default_config.
    assert out["response_language"] in vt_attempt._POLICY_ENUMS["response_language"]


# Extra invariants the audit asks us to pin.
def test_resolver_only_returns_three_approved_keys():
    """Even with a snapshot that includes extra fields, the resolver must
    return exactly the three approved selectors. No internal prompts,
    templates, keys, or model settings can be exposed."""
    snap = {
        "response_language": "english",
        "feedback_language": "english",
        "instruction_language": "english",
        "system_prompt": "LEAK",
        "evaluation_unavailable_text_en": "LEAK",
        "model_provider": "LEAK",
        "secret_key": "LEAK",
    }
    out = vt_attempt._resolve_attempt_language_policy(
        _attempt_with_snapshot(snap), _current_cfg())
    assert set(out.keys()) == {
        "response_language", "feedback_language", "instruction_language",
    }


def test_clamp_helper_is_per_key():
    """`bilingual` is valid for feedback_language and instruction_language
    but NOT for response_language. The clamp must validate per-key."""
    assert vt_attempt._clamp_policy_selector("response_language", "bilingual") == "english"
    assert vt_attempt._clamp_policy_selector("feedback_language", "bilingual") == "bilingual"
    assert vt_attempt._clamp_policy_selector("instruction_language", "bilingual") == "bilingual"


def test_resolver_signature_still_blocks_client_input():
    """Defense in depth: the resolver accepts only (attempt_doc, cfg).
    There is no path for a student client to supply a snapshot."""
    import inspect
    sig = inspect.signature(vt_attempt._resolve_attempt_language_policy)
    assert list(sig.parameters.keys()) == ["a", "cfg"]
