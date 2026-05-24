"""gemini_engine.py — Isolated Gemini AI helper for EduHub AI Scene Builder.

This module is intentionally self-contained.
It does NOT touch the ElevenLabs pipeline, the book save logic,
the MongoDB schema, or any other existing EduHub module.

Called only from the POST /api/studio/books/{slug}/ai-scene route.

Responsibilities:
  1. Build the Gemini prompt from the author's request parameters.
  2. Call the Gemini REST API (no heavy SDK — just httpx, already in requirements).
  3. Parse and strictly validate the JSON response.
  4. Return a typed Python dict or raise a clear ValueError / RuntimeError.

The caller (server.py route) is responsible for:
  - Admin auth
  - Storing media (audio/image) into GridFS
  - Converting the validated payload to compatible EduHub blocks
  - Returning the preview to the frontend
  - NOT modifying the live book without explicit admin confirmation

Environment variables read here:
  GEMINI_API_KEY   — required for AI Scene Builder; feature is disabled if absent.
"""
from __future__ import annotations

import json
import logging
import os
import re
from typing import Any

import httpx

log = logging.getLogger("eduhub.gemini_engine")

# ── Config ─────────────────────────────────────────────────────────────────
GEMINI_API_KEY = os.environ.get("GEMINI_API_KEY", "")
GEMINI_MODEL   = os.environ.get("GEMINI_MODEL", "gemini-1.5-flash")
GEMINI_ENDPOINT = (
    "https://generativelanguage.googleapis.com/v1beta/models"
    f"/{GEMINI_MODEL}:generateContent"
)

# ── Required output schema ──────────────────────────────────────────────────
# All keys must be present; values may be empty strings but not absent.
_REQUIRED_KEYS: set[str] = {
    "title",
    "englishText",
    "optionalKhmerHelp",
    "audioScript",
    "imagePrompt",
    "speakingPrompt",
    "vocabulary",
    "comprehensionQuestion",
}

# ── Gemini system instruction ───────────────────────────────────────────────
_SYSTEM_INSTRUCTION = """\
You are EduHub's AI speaking-first story scene generator for Cambodian ESL students.

You must output only valid JSON matching the provided schema.
Do not include Markdown.
Do not include explanations.
Do not include comments.
Do not wrap JSON in code fences.

EduHub classroom philosophy:
The main goal is English speaking fluency, pronunciation confidence,
quick response ability, and real communication.
Do not make translation the center of the learning experience.
English must remain primary.
Khmer is optional support only.

Audience:
- Cambodian young English learners.
- English level must match the requested CEFR level.
- Use short, natural, speakable English sentences.
- Make the language easy to say aloud.
- Build confidence and speaking rhythm.
- Avoid difficult idioms unless naturally supported.
- Keep the scene warm, cinematic, classroom-safe, and speaking-friendly.

Khmer support:
- Provide Khmer only as optional helper text in optionalKhmerHelp.
- Khmer must be natural Cambodian Khmer.
- Khmer must support meaning only when students need help.
- Do not make Khmer longer or more dominant than the English.

Speaking focus:
- Include one short speaking prompt in speakingPrompt that encourages students to answer aloud.
- The speaking prompt should be simple, confidence-building, and useful for classroom interaction.

Image prompt (imagePrompt):
- Describe one clear scene only.
- Preserve character consistency.
- Keep it safe for children.
- Avoid text inside the image unless requested.
- Include mood, camera angle, lighting, character action, and environment.
- Style: premium 3D cartoon educational illustration.

Audio script (audioScript):
- Must be speakable aloud.
- May include simple emotion tags like [softly], [excited], [surprised], [whisper].
- Do not overuse emotion tags.
- Keep pronunciation-friendly pacing.

Vocabulary (vocabulary):
- Return a JSON array of objects: [{"word": "...", "meaning": "..."}]
- Maximum 5 vocabulary items.
- Choose the most useful words for A1-B1 learners.

Comprehension question (comprehensionQuestion):
- Return a JSON object: {"question": "...", "choices": ["...", "...", "..."], "answer": "..."}
- Multiple choice, 3 options, classroom-safe.

Return only the JSON object. No preamble, no trailing text."""

# ── Public API ──────────────────────────────────────────────────────────────

def is_enabled() -> bool:
    """Return True if the Gemini API key is configured."""
    return bool(GEMINI_API_KEY)


async def generate_scene(
    *,
    topic: str,
    level: str,          # "A1" | "A2" | "B1"
    style: str,          # "Adventure" | "Funny" | "Mystery" | "Emotional" | "Classroom"
    include_khmer: bool = False,
) -> dict[str, Any]:
    """Call Gemini and return a strictly validated scene dict.

    Raises:
        RuntimeError: if GEMINI_API_KEY is not set.
        ValueError: if Gemini returns invalid / incomplete JSON (after one retry).
        httpx.HTTPError: on network failure.
    """
    if not GEMINI_API_KEY:
        raise RuntimeError(
            "GEMINI_API_KEY is not set. "
            "Add it to Render environment variables to enable AI Scene Builder."
        )

    prompt = _build_prompt(topic=topic, level=level, style=style, include_khmer=include_khmer)

    # Attempt once, then retry once on JSON validation failure.
    last_exc: Exception | None = None
    for attempt in range(2):
        try:
            raw_json = await _call_gemini(prompt)
            validated = _validate(raw_json)
            return validated
        except (ValueError, json.JSONDecodeError) as exc:
            last_exc = exc
            log.warning(
                "gemini_engine: attempt %d JSON validation failed: %s",
                attempt + 1, exc,
            )
            if attempt == 0:
                continue  # retry once
            break
        except Exception:
            raise  # network errors, auth errors → propagate immediately

    raise ValueError(
        f"Gemini returned invalid JSON after 2 attempts. Last error: {last_exc}"
    )


# ── Internal helpers ─────────────────────────────────────────────────────────

def _build_prompt(*, topic: str, level: str, style: str, include_khmer: bool) -> str:
    khmer_note = (
        "Include natural Cambodian Khmer translation in optionalKhmerHelp."
        if include_khmer
        else "Set optionalKhmerHelp to an empty string."
    )

    return f"""\
Generate a speaking-friendly story scene for a Cambodian ESL classroom.

Topic: {topic}
CEFR Level: {level}
Scene style: {style}
{khmer_note}

Required JSON schema — return EXACTLY this structure:
{{
  "title": "Short scene title in English",
  "englishText": "2-4 short English sentences. Speakable. Natural. {level} level.",
  "optionalKhmerHelp": "Khmer translation or empty string",
  "audioScript": "Speakable narration with optional [emotion] tags",
  "imagePrompt": "Detailed scene description for 3D cartoon image generation",
  "speakingPrompt": "One short classroom speaking prompt for students",
  "vocabulary": [{{"word": "example", "meaning": "definition"}}],
  "comprehensionQuestion": {{"question": "...", "choices": ["A", "B", "C"], "answer": "A"}}
}}

Return only valid JSON. No Markdown. No explanations."""


async def _call_gemini(prompt: str) -> str:
    """POST to the Gemini generateContent REST endpoint and return the text."""
    payload = {
        "systemInstruction": {
            "parts": [{"text": _SYSTEM_INSTRUCTION}]
        },
        "contents": [
            {"role": "user", "parts": [{"text": prompt}]}
        ],
        "generationConfig": {
            "temperature": 0.7,
            "maxOutputTokens": 1200,
            "responseMimeType": "application/json",
        },
    }

    async with httpx.AsyncClient(timeout=45.0) as client:
        resp = await client.post(
            GEMINI_ENDPOINT,
            params={"key": GEMINI_API_KEY},
            json=payload,
            headers={"Content-Type": "application/json"},
        )

    if resp.status_code != 200:
        log.error(
            "gemini_engine: Gemini API error %d: %s",
            resp.status_code, resp.text[:300],
        )
        raise RuntimeError(
            f"Gemini API returned HTTP {resp.status_code}. "
            "Check GEMINI_API_KEY and model quota."
        )

    data = resp.json()
    # Extract the text from the first candidate
    try:
        text = data["candidates"][0]["content"]["parts"][0]["text"]
    except (KeyError, IndexError, TypeError) as exc:
        raise ValueError(
            f"Unexpected Gemini response shape: {exc}. Raw: {str(data)[:300]}"
        ) from exc

    return text


def _clean_json_text(raw: str) -> str:
    """Strip Markdown fences that Gemini sometimes adds despite instructions."""
    cleaned = raw.strip()
    # Remove ```json ... ``` or ``` ... ```
    cleaned = re.sub(r"^```(?:json)?\s*", "", cleaned, flags=re.IGNORECASE)
    cleaned = re.sub(r"\s*```$", "", cleaned)
    return cleaned.strip()


def _validate(raw: str) -> dict[str, Any]:
    """Parse and validate the Gemini JSON output.

    Raises ValueError with a clear message if validation fails.
    """
    cleaned = _clean_json_text(raw)

    try:
        data = json.loads(cleaned)
    except json.JSONDecodeError as exc:
        raise ValueError(f"JSON parse error: {exc}. Raw text: {cleaned[:200]}") from exc

    if not isinstance(data, dict):
        raise ValueError(f"Expected JSON object, got {type(data).__name__}")

    missing = _REQUIRED_KEYS - data.keys()
    if missing:
        raise ValueError(f"Gemini response missing required keys: {missing}")

    # Coerce vocabulary to list if needed
    vocab = data.get("vocabulary", [])
    if isinstance(vocab, str):
        try:
            vocab = json.loads(vocab)
        except Exception:
            vocab = []
    if not isinstance(vocab, list):
        vocab = []
    # Validate each vocab item
    vocab = [
        v for v in vocab
        if isinstance(v, dict) and "word" in v and "meaning" in v
    ]
    data["vocabulary"] = vocab

    # Coerce comprehensionQuestion to dict if needed
    cq = data.get("comprehensionQuestion", {})
    if isinstance(cq, str):
        try:
            cq = json.loads(cq)
        except Exception:
            cq = {}
    if not isinstance(cq, dict):
        cq = {}
    # Validate comprehension question shape
    if not all(k in cq for k in ("question", "choices", "answer")):
        cq = {}
    data["comprehensionQuestion"] = cq

    # Ensure all required string fields are strings
    for key in ("title", "englishText", "optionalKhmerHelp", "audioScript",
                 "imagePrompt", "speakingPrompt"):
        if not isinstance(data.get(key), str):
            data[key] = str(data.get(key, ""))

    # Safety: trim excessively long fields
    for key in ("englishText", "audioScript"):
        if len(data[key]) > 2000:
            data[key] = data[key][:2000]

    return data
