"""tests/test_edutalk_live_report_bilingual.py — BUG 5 upgrade regression
coverage: EduTalk Live Coach reports now request/produce bilingual
(English + Khmer) explanatory fields (pronunciation_focus, mistake
explanation, coaching note, next mission, summary), on top of the
existing English-only fields which must be preserved byte-for-byte for
backward compatibility with LiveCoachReportCard.jsx.

No prior test file exercised _generate_report/_build_report_prompt/
_heuristic_report at all (a real coverage gap flagged during
investigation) — this file is net-new coverage, not a rewrite.
"""
from __future__ import annotations

from types import SimpleNamespace

import edutalk_live_tools as elt

EN_KM_PAIRS = [
    ("pronunciation_focus", "pronunciation_focus_km"),
    ("mistake_explanation", "mistake_explanation_km"),
    ("coaching_note", "coaching_note_km"),
    ("next_mission", "next_mission_km"),
    ("summary", "summary_km"),
]

TRANSCRIPT = [
    {"role": "student", "text": "I go to school yesterday."},
    {"role": "coach", "text": "Great effort! Let's fix the tense."},
    {"role": "student", "text": "I went to school yesterday and I very happy."},
]


def run(coro):
    import asyncio
    return asyncio.run(coro)


# ── prompt shape ─────────────────────────────────────────────────────────

def test_prompt_requests_every_bilingual_key():
    prompt = elt._build_report_prompt("Student: hello\nCoach: hi", "Book Shadow")
    for en_key, km_key in EN_KM_PAIRS:
        assert f'"{en_key}"' in prompt
        assert f'"{km_key}"' in prompt
    # Existing (pre-upgrade) keys must still be present, unrenamed.
    for legacy_key in ("confidence_score", "clarity_score", "corrected_sentences",
                       "best_sentence", "improved_sentence"):
        assert f'"{legacy_key}"' in prompt


# ── heuristic (offline) fallback ────────────────────────────────────────

def test_heuristic_report_includes_every_bilingual_field():
    report = elt._heuristic_report(TRANSCRIPT, "Book Shadow")
    for en_key, km_key in EN_KM_PAIRS:
        assert report.get(en_key)
        assert report.get(km_key)
    assert report["engine"] == "heuristic"


def test_heuristic_report_khmer_fields_are_actually_khmer_text():
    report = elt._heuristic_report(TRANSCRIPT, "Book Shadow")
    khmer_range = range(0x1780, 0x17FF)
    for _en_key, km_key in EN_KM_PAIRS:
        text = report[km_key]
        assert any(ord(ch) in khmer_range for ch in text), f"{km_key} has no Khmer characters: {text!r}"


# ── _generate_report — Gemini path ──────────────────────────────────────

def _fake_gemini_response(payload_dict, status_code=200):
    import json as _json

    async def fake_post_gemini(model, api_key, payload):
        text = _json.dumps(payload_dict)
        return SimpleNamespace(
            status_code=status_code,
            json=lambda: {"candidates": [{"content": {"parts": [{"text": text}]}}]},
        )
    return fake_post_gemini


def test_generate_report_uses_gemini_when_configured_and_tags_engine(monkeypatch):
    full = {
        "confidence_score": 80, "clarity_score": 75,
        "pronunciation_focus": "past tense -ed", "pronunciation_focus_km": "អតីតកាល -ed",
        "corrected_sentences": ["I go -> I went"],
        "best_sentence": "I went to school yesterday and I very happy.",
        "improved_sentence": "I went to school yesterday and I was very happy.",
        "mistake_explanation": "Missing 'was' before an adjective.",
        "mistake_explanation_km": "បាត់ 'was' មុនគុណនាម។",
        "coaching_note": "Practice 'was/were + adjective' patterns.",
        "coaching_note_km": "អនុវត្តទម្រង់ 'was/were + គុណនាម'។",
        "next_mission": "Say 5 sentences using 'was very happy'.",
        "next_mission_km": "និយាយ៥ប្រយោគប្រើ 'was very happy'។",
        "summary": "Good effort today!", "summary_km": "ការខិតខំល្អថ្ងៃនេះ!",
    }
    monkeypatch.setattr(elt, "_post_gemini", _fake_gemini_response(full))
    monkeypatch.setattr(elt, "GEMINI_API_KEY", "fake-key")

    report = run(elt._generate_report(TRANSCRIPT, "Book Shadow"))

    assert report["engine"] == "gemini"
    assert report["pronunciation_focus_km"] == "អតីតកាល -ed"
    assert report["confidence_score"] == 80


def test_generate_report_fills_missing_bilingual_fields_defensively(monkeypatch):
    # Gemini omits every new bilingual key (only returns the OLD schema) —
    # must not KeyError, must not silently render "undefined" on the client.
    partial = {
        "confidence_score": 70, "clarity_score": 65,
        "pronunciation_focus": "final consonants",
        "corrected_sentences": [], "best_sentence": "hello",
        "improved_sentence": "", "next_mission": "practice more", "summary": "nice job",
    }
    monkeypatch.setattr(elt, "_post_gemini", _fake_gemini_response(partial))
    monkeypatch.setattr(elt, "GEMINI_API_KEY", "fake-key")

    report = run(elt._generate_report(TRANSCRIPT, "Book Shadow"))

    assert report["engine"] == "gemini"
    # Km twin falls back to the English value rather than being absent/None.
    assert report["pronunciation_focus_km"] == "final consonants"
    assert report["next_mission_km"] == "practice more"
    assert report["summary_km"] == "nice job"
    # Entirely-new fields Gemini didn't return at all default to "", never a missing key.
    assert report["mistake_explanation"] == ""
    assert report["mistake_explanation_km"] == ""
    assert report["coaching_note"] == ""
    assert report["coaching_note_km"] == ""


def test_generate_report_falls_back_to_heuristic_on_gemini_http_error(monkeypatch):
    monkeypatch.setattr(elt, "_post_gemini", _fake_gemini_response({}, status_code=500))
    monkeypatch.setattr(elt, "GEMINI_API_KEY", "fake-key")

    report = run(elt._generate_report(TRANSCRIPT, "Book Shadow"))
    assert report["engine"] == "heuristic"
    assert report["summary_km"]


def test_generate_report_falls_back_to_heuristic_on_malformed_json(monkeypatch):
    async def fake_post_gemini(model, api_key, payload):
        return SimpleNamespace(
            status_code=200,
            json=lambda: {"candidates": [{"content": {"parts": [{"text": "not json"}]}}]},
        )
    monkeypatch.setattr(elt, "_post_gemini", fake_post_gemini)
    monkeypatch.setattr(elt, "GEMINI_API_KEY", "fake-key")

    report = run(elt._generate_report(TRANSCRIPT, "Book Shadow"))
    assert report["engine"] == "heuristic"


def test_generate_report_uses_heuristic_when_no_api_key_configured(monkeypatch):
    monkeypatch.setattr(elt, "GEMINI_API_KEY", "")
    report = run(elt._generate_report(TRANSCRIPT, "Book Shadow"))
    assert report["engine"] == "heuristic"


def test_generate_report_uses_heuristic_for_empty_transcript(monkeypatch):
    monkeypatch.setattr(elt, "GEMINI_API_KEY", "fake-key")
    report = run(elt._generate_report([], "Book Shadow"))
    assert report["engine"] == "heuristic"


def test_generate_report_clamps_scores_defensively(monkeypatch):
    out_of_range = {
        "confidence_score": 999, "clarity_score": -50,
        "pronunciation_focus": "x", "best_sentence": "y",
        "corrected_sentences": [], "improved_sentence": "", "next_mission": "z", "summary": "s",
    }
    monkeypatch.setattr(elt, "_post_gemini", _fake_gemini_response(out_of_range))
    monkeypatch.setattr(elt, "GEMINI_API_KEY", "fake-key")

    report = run(elt._generate_report(TRANSCRIPT, "Book Shadow"))
    assert 0 <= report["confidence_score"] <= 100
    assert 0 <= report["clarity_score"] <= 100
