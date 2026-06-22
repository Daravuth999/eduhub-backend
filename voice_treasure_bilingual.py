"""voice_treasure_bilingual.py
==============================
Server-authoritative bilingual (English / Khmer) helpers for Voice Treasure
evaluation. Pure functions only — no I/O, no GAS, no DB, no provider calls.

Responsibilities:
  * Translate a validated language policy into a SAFE, BOUNDED prompt fragment
    consumed by ``voice_treasure_gemini.evaluate_speaking`` when it builds the
    final controlled prompt.
  * Decide which response languages are ACCEPTED for a given attempt.
  * Decide which feedback language(s) the model is asked to render.
  * Decide which mission-instruction language is shown to the student.
  * Provide fallback templates (English) for any admin-overridable text.

Hard guarantees:
  * No client input EVER reaches the prompt fragment (callers pass the
    persisted server-side policy only).
  * No score schema is mutated — language affects accepted RESPONSE +
    feedback rendering, NOT what is scored.
  * No provider keys, raw API URLs, or internal system prompts are returned
    to students by any helper here.
  * Template strings are length-bounded by the config validator before
    reaching this module.

This module is imported by tests and by ``voice_treasure_gemini`` only.
"""
from __future__ import annotations

from typing import Any

# Sentinel sets must match voice_treasure_config_tools._{RESPONSE,FEEDBACK,
# INSTRUCTION}_LANGUAGES. Re-declared here so this module stays import-light.
RESPONSE_LANGUAGES = {"english", "khmer", "english_or_khmer", "mixed"}
FEEDBACK_LANGUAGES = {"english", "khmer", "match", "bilingual"}
INSTRUCTION_LANGUAGES = {"english", "khmer", "bilingual"}

# Static fallbacks. Admin overrides override these per-config.
_FALLBACK_INSTRUCTION_EN = "Describe the picture in two or three sentences."
_FALLBACK_INSTRUCTION_KM = "ពិពណ៌នារូបភាពនេះក្នុងពីរទៅបីប្រយោគ។"
_FALLBACK_GUIDANCE_EN = "Speak clearly. Look at the picture as you describe it."
_FALLBACK_GUIDANCE_KM = "សូមនិយាយឲ្យច្បាស់។ មើលរូបភាពពេលអ្នកពិពណ៌នា។"
_FALLBACK_UNAVAILABLE_EN = (
    "Evaluation is temporarily unavailable. Your entry is preserved — "
    "please try again shortly."
)
_FALLBACK_UNAVAILABLE_KM = (
    "ការវាយតម្លៃមិនអាចប្រើបាននៅពេលនេះ។ ការចូលប្រកួតរបស់អ្នកនៅរក្សា — "
    "សូមព្យាយាមម្ដងទៀតក្នុងពេលឆាប់ៗ។"
)
_FALLBACK_RETRY_EN = "You can try again. We won't charge you again."
_FALLBACK_RETRY_KM = "អ្នកអាចព្យាយាមម្ដងទៀត។ យើងនឹងមិនគិតថ្លៃអ្នកម្ដងទៀតទេ។"


def _pick(text: str, fallback: str) -> str:
    """Return ``text`` if it is non-empty after stripping, else ``fallback``.
    Length is already bounded by the config validator (_TEMPLATE_MAX_LEN).
    """
    t = (text or "").strip()
    return t if t else fallback


def resolve_instruction_text(policy: dict[str, Any], lang_cfg: dict[str, Any]) -> dict[str, str]:
    """Return the student-facing mission instruction in the configured
    language. ``policy`` is the output of
    ``voice_treasure_config_tools.evaluation_language_policy`` and ``lang_cfg``
    is the persisted language config block (admin overrides).
    """
    mode = policy.get("mission_instruction_language", "english")
    en = _pick(lang_cfg.get("mission_instruction_text_en"), _FALLBACK_INSTRUCTION_EN)
    km = _pick(lang_cfg.get("mission_instruction_text_km"), _FALLBACK_INSTRUCTION_KM)
    if mode == "khmer":
        return {"primary": km, "secondary": "", "lang": "km"}
    if mode == "bilingual":
        return {"primary": en, "secondary": km, "lang": "en+km"}
    return {"primary": en, "secondary": "", "lang": "en"}


def accepted_response_language_label(policy: dict[str, Any]) -> str:
    """Short, student-safe label for the response-language gate. Never
    surfaces internal prompt fragments."""
    return {
        "english": "English",
        "khmer": "Khmer",
        "english_or_khmer": "English or Khmer",
        "mixed": "English and Khmer (mixed)",
    }.get(policy.get("response_language", "english"), "English")


def build_evaluator_language_clause(policy: dict[str, Any]) -> str:
    """Build the bounded language clause appended to the evaluator's
    controlled prompt. Returns a short, safe string with NO secrets, NO
    URLs, NO keys, NO model identifiers — only language policy.
    """
    rl = policy.get("response_language", "english")
    fl = policy.get("feedback_language", "english")

    # Accepted response language
    accepted = {
        "english": "The student response should be evaluated as English.",
        "khmer": "The student response should be evaluated as Khmer (ភាសាខ្មែរ).",
        "english_or_khmer": (
            "The student response may be in English OR Khmer. Detect the "
            "primary language and evaluate accordingly."
        ),
        "mixed": (
            "The student response may freely mix English and Khmer. Evaluate "
            "the response as bilingual; do not penalize code-switching."
        ),
    }[rl]

    # Feedback rendering
    feedback = {
        "english": "Write the coaching feedback in English only.",
        "khmer": "Write the coaching feedback in Khmer (ភាសាខ្មែរ) only.",
        "match": (
            "Write the coaching feedback in the SAME language the student "
            "predominantly used."
        ),
        "bilingual": (
            "Write the coaching feedback BILINGUALLY: a short English "
            "sentence, then the same point in Khmer (ភាសាខ្មែរ)."
        ),
    }[fl]

    # The score schema is FROZEN — explicitly listed so the model cannot
    # silently emit invented categories.
    cats = ", ".join(sorted(policy.get("score_categories") or []))
    schema = (
        f"Emit numeric 0..100 scores for EXACTLY these categories: {cats}. "
        "Do not invent additional score categories."
    )
    return f"{accepted} {feedback} {schema}"


def localize_unavailable_text(policy: dict[str, Any], lang_cfg: dict[str, Any]) -> str:
    fl = policy.get("feedback_language", "english")
    en = _pick(lang_cfg.get("evaluation_unavailable_text_en"), _FALLBACK_UNAVAILABLE_EN)
    km = _pick(lang_cfg.get("evaluation_unavailable_text_km"), _FALLBACK_UNAVAILABLE_KM)
    if fl == "khmer":
        return km
    if fl == "bilingual":
        return f"{en} / {km}"
    return en


def localize_retry_text(policy: dict[str, Any], lang_cfg: dict[str, Any]) -> str:
    fl = policy.get("feedback_language", "english")
    en = _pick(lang_cfg.get("retry_message_text_en"), _FALLBACK_RETRY_EN)
    km = _pick(lang_cfg.get("retry_message_text_km"), _FALLBACK_RETRY_KM)
    if fl == "khmer":
        return km
    if fl == "bilingual":
        return f"{en} / {km}"
    return en
