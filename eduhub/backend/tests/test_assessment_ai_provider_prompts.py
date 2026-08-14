"""tests/test_assessment_ai_provider_prompts.py — regression coverage for
the 2026-08 production incident: a real student submission on the live
"Long & Short Sound Listening Challenge" assessment scored 0/30 despite a
genuinely ~15/30-correct worksheet, with the extraction reporting high
confidence for every question (ruling out "nothing extracted" — see
test_assessment_tools.py's needs_review-vs-scored math). Code audit found
two real, provable gaps that this file guards against regressing:

  1. The submission-extraction prompt gave Gemini NO information about the
     assessment's actual answer vocabulary, so a fixed-choice assessment
     (like LONG/SHORT) had nothing anchoring Gemini's output to the exact
     words the answer key uses — a plausible source of a systematic,
     assessment-wide mismatch.
  2. The answer-key extraction prompt didn't guard against a document
     with a second "answer-like" column (this exact document's real IPA
     pronunciation column, e.g. /ʃiː/) being confused with the actual
     LONG/SHORT classification column.

Both are prompt-text changes only — nothing about scoring, the answer-key
data model, or the wallet/notification pipeline changed.
"""
from __future__ import annotations

import assessment_ai_provider as ai
from assessment_schema import normalize_extracted_answer_key

REAL_ANSWER_KEY_ITEMS = [
    {"no": 1, "prompt": "sheep", "answer": "LONG", "points": 0.5},
    {"no": 2, "prompt": "ship", "answer": "SHORT", "points": 0.5},
    {"no": 3, "prompt": "cheap", "answer": "LONG", "points": 0.5},
    {"no": 4, "prompt": "chip", "answer": "SHORT", "points": 0.5},
]


def test_vocabulary_hint_derives_the_fixed_choice_set_from_the_real_answer_key():
    questions = normalize_extracted_answer_key(REAL_ANSWER_KEY_ITEMS)
    hint = ai._answer_vocabulary_hint(questions)
    assert "LONG" in hint
    assert "SHORT" in hint
    assert "fixed set of choices" in hint


def test_vocabulary_hint_is_empty_for_a_free_response_assessment():
    # Every question has a DIFFERENT correct answer -> no small fixed
    # vocabulary exists to anchor Gemini to; must not fabricate one.
    free_response_questions = [
        {"qid": f"q{i}", "prompt": f"Question {i}", "correctAnswer": f"unique answer {i}", "points": 1.0}
        for i in range(1, 12)
    ]
    assert ai._answer_vocabulary_hint(free_response_questions) == ""


def test_submission_prompt_includes_the_vocabulary_hint_for_this_real_assessment():
    questions = normalize_extracted_answer_key(REAL_ANSWER_KEY_ITEMS)
    prompt = ai._submission_prompt(questions)
    assert "fixed set of choices: LONG, SHORT" in prompt
    assert "never the prompt word itself" in prompt


def test_answer_key_prompt_explicitly_guards_against_a_pronunciation_column():
    # This assessment's real teacher-key document has an IPA column
    # (e.g. /ʃiː/) sitting next to the LONG/SHORT classification column —
    # exactly the kind of distractor this guards against.
    assert "IPA" in ai._ANSWER_KEY_PROMPT or "phonetic transcription" in ai._ANSWER_KEY_PROMPT
    assert "never the answer" in ai._ANSWER_KEY_PROMPT or "NEVER the answer" in ai._ANSWER_KEY_PROMPT
