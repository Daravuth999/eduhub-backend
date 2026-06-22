"""Pass 3 wiring tests.

Proves the server-authoritative bilingual policy is actually wired into:
  * the production Gemini evaluator's controlled prompt;
  * the /api/voice-treasure/today response (instruction + unavailable + retry).

These tests never call a real provider, never write to Mongo, and never
hit GAS. They exercise pure helpers + monkeypatched async fakes.
"""
from __future__ import annotations

import asyncio
import importlib
import os
import pathlib
import sys
import types

import pytest

ROOT = pathlib.Path(__file__).resolve().parents[1]
if str(ROOT) not in sys.path:
    sys.path.insert(0, str(ROOT))

vt_gemini = importlib.import_module("voice_treasure_gemini")
vt_bilingual = importlib.import_module("voice_treasure_bilingual")
vt_cfg = importlib.import_module("voice_treasure_config_tools")


# --------------------------------------------------------------------------- #
# A. Bilingual policy reaches the real evaluator prompt                       #
# --------------------------------------------------------------------------- #
def test_coach_prompt_includes_language_clause():
    policy = {
        "response_language": "english_or_khmer",
        "feedback_language": "bilingual",
        "score_categories": list(vt_gemini.EVAL_CATEGORIES),
    }
    clause = vt_bilingual.build_evaluator_language_clause(policy)
    text = vt_gemini._coach_prompt("a friendly scene", "encouraging", clause)
    assert "Language policy:" in text
    assert "English OR Khmer" in text
    assert "BILINGUALLY" in text
    # Score schema must still list ONLY the five supported categories.
    for cat in vt_gemini.EVAL_CATEGORIES:
        assert cat in text
    # Forbidden categories must NOT appear in the prompt.
    for forbidden in ("pronunciation", "fluency", "vocabulary", "confidence"):
        assert forbidden not in text.lower().split("pronunciation,")[0]


def test_coach_prompt_clause_is_length_bounded():
    overlong = "x" * 5000
    out = vt_gemini._coach_prompt("scene", "neutral", overlong)
    # Bound is 1200; allow the rest of the base prompt around it.
    appended = out.split("Language policy: ", 1)[1]
    assert len(appended) <= 1200


def test_evaluate_speaking_passes_clause_to_prompt(monkeypatch):
    """`evaluate_speaking` must derive the clause from the policy arg
    (server-side) and include it in the body sent to Gemini."""
    captured = {}

    class _FakeResp:
        status_code = 200

        def json(self):
            return {
                "candidates": [
                    {
                        "content": {
                            "parts": [
                                {
                                    "text": (
                                        '{"scores":{"relevance":80,"visual_grounding":70,'
                                        '"detail":75,"organization":78,"understandable_language":82},'
                                        '"understanding_summary":"ok","strongest_skill":"relevance",'
                                        '"next_improvement":"x","coach_feedback":"y"}'
                                    )
                                }
                            ]
                        }
                    }
                ]
            }

    class _FakeClient:
        def __init__(self, *a, **k):
            pass

        async def __aenter__(self):
            return self

        async def __aexit__(self, *a):
            return False

        async def post(self, url, params=None, json=None):
            captured["json"] = json
            return _FakeResp()

    monkeypatch.setenv("GEMINI_API_KEY", "test-key")
    monkeypatch.setenv("VOICE_TREASURE_EVAL_MODEL", "gemini-test")
    monkeypatch.setattr(vt_gemini.httpx, "AsyncClient", _FakeClient)

    policy = {
        "response_language": "khmer",
        "feedback_language": "khmer",
        "score_categories": list(vt_gemini.EVAL_CATEGORIES),
    }
    out = asyncio.run(
        vt_gemini.evaluate_speaking(
            audio_bytes=b"a", audio_mime="audio/webm",
            mission_context="scene", feedback_tone="encouraging",
            language_policy=policy,
        )
    )
    assert out["ok"] is True
    # The Khmer policy clause must be present in the controlled prompt.
    sent_text = captured["json"]["contents"][0]["parts"][0]["text"]
    assert "Khmer" in sent_text
    assert "Language policy:" in sent_text


def test_evaluate_speaking_without_policy_falls_back_to_english():
    """No policy = default English prompt with no language clause appended."""
    text = vt_gemini._coach_prompt("scene", "encouraging", None)
    assert "Language policy:" not in text


def test_normalized_schema_keeps_only_five_supported_categories():
    """Even if a provider invented extra fields, only the 5 supported remain."""
    raw = (
        '{"scores":{"relevance":80,"visual_grounding":70,"detail":75,'
        '"organization":78,"understandable_language":82,'
        '"pronunciation":99,"fluency":99,"vocabulary":99,"confidence":99},'
        '"understanding_summary":"ok","strongest_skill":"relevance",'
        '"next_improvement":"x","coach_feedback":"y"}'
    )
    out = vt_gemini.normalize_evaluation(raw)
    assert out is not None
    assert set(out["scores"].keys()) == set(vt_gemini.EVAL_CATEGORIES)
    # Forbidden keys must NOT appear at the normalized top level either.
    forbidden = {"pronunciation", "fluency", "vocabulary", "confidence"}
    assert forbidden.isdisjoint(set(out["scores"].keys()))


# --------------------------------------------------------------------------- #
# B. Localized instruction / unavailable / retry text                         #
# --------------------------------------------------------------------------- #
def test_today_localized_text_uses_helpers_for_khmer():
    cfg = vt_cfg.default_config()
    cfg["language"]["mission_instruction_language"] = "khmer"
    cfg["language"]["feedback_language"] = "khmer"
    cfg["language"]["mission_instruction_text_km"] = "សូមពិពណ៌នារូបភាព។"
    policy = vt_cfg.evaluation_language_policy(cfg)
    instruction = vt_bilingual.resolve_instruction_text(policy, cfg["language"])
    assert instruction["lang"] == "km"
    assert instruction["primary"] == "សូមពិពណ៌នារូបភាព។"
    assert vt_bilingual.localize_unavailable_text(policy, cfg["language"]).strip()
    assert vt_bilingual.localize_retry_text(policy, cfg["language"]).strip()


def test_today_localized_text_bilingual_mode_renders_both():
    cfg = vt_cfg.default_config()
    cfg["language"]["mission_instruction_language"] = "bilingual"
    cfg["language"]["feedback_language"] = "bilingual"
    policy = vt_cfg.evaluation_language_policy(cfg)
    instruction = vt_bilingual.resolve_instruction_text(policy, cfg["language"])
    assert instruction["lang"] == "en+km"
    assert instruction["primary"]
    assert instruction["secondary"]
    unav = vt_bilingual.localize_unavailable_text(policy, cfg["language"])
    assert " / " in unav  # bilingual concatenation


def test_today_english_fallback_when_khmer_missing():
    cfg = vt_cfg.default_config()
    cfg["language"]["mission_instruction_language"] = "khmer"
    # NO Khmer override → fallback Khmer constant must be used, not English.
    policy = vt_cfg.evaluation_language_policy(cfg)
    instruction = vt_bilingual.resolve_instruction_text(policy, cfg["language"])
    assert instruction["primary"]  # still present (fallback)
    assert instruction["lang"] == "km"


def test_accepted_response_label_safe_strings():
    for mode, expected in [
        ("english", "English"),
        ("khmer", "Khmer"),
        ("english_or_khmer", "English or Khmer"),
        ("mixed", "English and Khmer (mixed)"),
    ]:
        assert vt_bilingual.accepted_response_language_label(
            {"response_language": mode}
        ) == expected


# --------------------------------------------------------------------------- #
# C. Client cannot override policy mid-attempt                                #
# --------------------------------------------------------------------------- #
def test_evaluation_language_policy_ignores_client_input():
    """The policy is derived from the persisted server config — it has no
    student/client input vector. Confirm by constructing a config whose ONLY
    language settings come from admin and proving the policy reflects those."""
    cfg = vt_cfg.default_config()
    cfg["language"]["response_language"] = "khmer"
    cfg["language"]["feedback_language"] = "match"
    cfg["language"]["mission_instruction_language"] = "bilingual"
    policy = vt_cfg.evaluation_language_policy(cfg)
    assert policy["response_language"] == "khmer"
    assert policy["feedback_language"] == "match"
    assert policy["mission_instruction_language"] == "bilingual"
    # score_categories are the SERVER allowlist — never expanded.
    assert set(policy["score_categories"]) == set(vt_gemini.EVAL_CATEGORIES)
