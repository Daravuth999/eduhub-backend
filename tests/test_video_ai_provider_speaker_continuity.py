"""tests/test_video_ai_provider_speaker_continuity.py
=====================================================
Regression coverage for the 2026-09 Video Factory surgical bug-fix pass,
§2d/4c: Gemini's ASR prompt gave no guidance on HOW to keep a speaker
label consistent across a jump cut, camera-angle change, or a speaker who
returns after a silence — a plausible, evidence-grounded contributor to
reported "speaker synchronization" problems around cuts. No production
pipeline logs or error records were available to confirm how OFTEN this
actually manifests (see the investigation's own honesty requirement) —
this file proves only what's directly testable: the improved prompt text
is what's actually sent to Gemini, and the new quality-flagging heuristic
(assess_speaker_continuity_quality) behaves correctly against constructed
segment data with known problem patterns. It does NOT and cannot prove
Gemini's real-world diarization accuracy improved.
"""
from __future__ import annotations

import asyncio

import video_ai_provider as vap


def run(c):
    return asyncio.run(c)


class _FakeResponse:
    def __init__(self, status_code=200, payload=None):
        self.status_code = status_code
        self._payload = payload or {}
        self.text = ""

    def json(self):
        return self._payload


def _valid_asr_response():
    return _FakeResponse(200, {
        "candidates": [{"content": {"parts": [{"text": '{"language": "en", "segments": []}'}]}}],
    })


def test_asr_prompt_instructs_voice_based_not_scene_based_speaker_continuity():
    assert "VOICE" in vap._ASR_PROMPT
    assert "camera-angle" in vap._ASR_PROMPT or "camera angle" in vap._ASR_PROMPT.lower()
    assert "same speaker label" in vap._ASR_PROMPT.lower()


def test_align_actually_sends_the_improved_prompt_text_to_gemini(monkeypatch):
    captured = {}

    async def fake_post(url, params=None, json=None, **kwargs):
        captured["body"] = json
        return _valid_asr_response()

    monkeypatch.setenv("GEMINI_API_KEY", "test-key")
    provider = vap.GeminiVideoProvider(http_client=type("C", (), {"post": staticmethod(fake_post)})())
    run(provider.align(b"fake-audio-bytes", "audio/mpeg"))

    sent_text = captured["body"]["contents"][0]["parts"][0]["text"]
    assert sent_text == vap._ASR_PROMPT
    assert "VOICE" in sent_text
    assert "not evidence of a new speaker" in sent_text.lower()


def _sync_doc_for_speakers(speaker_ids):
    return {
        "paragraphs": [{
            "id": "p1",
            "sentences": [
                {"id": f"s{i}", "speakerId": sid, "words": [{"word": "x", "start": i, "end": i + 1}]}
                for i, sid in enumerate(speaker_ids)
            ],
        }],
    }


def test_returns_none_for_too_few_sentences_to_judge_honestly():
    assert vap.assess_speaker_continuity_quality(_sync_doc_for_speakers(["S1", "S2"])) is None


def test_returns_none_when_no_speaker_labels_exist_at_all():
    doc = _sync_doc_for_speakers([None, None, None, None, None])
    assert vap.assess_speaker_continuity_quality(doc) is None


def test_returns_none_for_a_normal_plausible_two_speaker_conversation():
    # A real back-and-forth: S1, S2, S1, S2, S1, S2 — no flickers (every
    # transition is a genuine, sustained turn change), only 2 speakers.
    doc = _sync_doc_for_speakers(["S1", "S2", "S1", "S2", "S1", "S2"])
    assert vap.assess_speaker_continuity_quality(doc) is None


def test_flags_a_single_sentence_speaker_flicker():
    # S1 S1 S2 S1 S1 — the lone "S2" at index 2 is sandwiched between S1
    # on both sides: the classic single-sentence diarization-confusion
    # signature this heuristic exists to catch. Repeated 3x to cross the
    # >=3 threshold (avoids over-flagging on a single incidental blip).
    doc = _sync_doc_for_speakers([
        "S1", "S1", "S2", "S1", "S1",
        "S3", "S1", "S1",
        "S2", "S1", "S1",
    ])
    note = vap.assess_speaker_continuity_quality(doc)
    assert note is not None
    assert "single-sentence speaker changes" in note
    assert "Sync Review Studio" in note


def test_flags_an_implausible_speaker_to_sentence_ratio():
    # 6 distinct speakers across only 9 sentences — more identities than a
    # short lesson plausibly needs.
    doc = _sync_doc_for_speakers(["S1", "S2", "S3", "S4", "S5", "S6", "S1", "S2", "S3"])
    note = vap.assess_speaker_continuity_quality(doc)
    assert note is not None
    assert "distinct speakers" in note


def test_never_fails_or_raises_on_a_malformed_sync_document():
    assert vap.assess_speaker_continuity_quality({}) is None
    assert vap.assess_speaker_continuity_quality({"paragraphs": []}) is None
    assert vap.assess_speaker_continuity_quality({"paragraphs": [{"sentences": []}]}) is None
