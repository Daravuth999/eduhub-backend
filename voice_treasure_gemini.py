"""voice_treasure_gemini.py
===========================
Isolated Gemini provider adapter for Voice Treasure (Core Game milestone).

Two responsibilities, both fully gated and OFF by default:

  1. Mission image preparation — controlled, with an approved fallback.
  2. Speaking evaluation — Gemini multimodal (image-context + audio) →
     a STRICTLY normalized result.

It imports nothing from gemini_engine.py / premium_ai_tools.py and never
hard-codes a live model name. Model names come only from backend config /
environment:

    GEMINI_API_KEY                       — provider key (no key ⇒ unavailable)
    VOICE_TREASURE_IMAGE_MODEL           — image model (empty ⇒ fallback)
    VOICE_TREASURE_EVAL_MODEL            — eval model (empty ⇒ unavailable)
    VOICE_TREASURE_IMAGE_GENERATION_ENABLED=0  — master image gate (default off)

Image outcomes:   "generated" | "fallback" | "unavailable" | "failed"
Eval outcomes:    ok=True with normalized scores, or ok=False with a safe
                  reason ("evaluation_unavailable", "evaluation_failed",
                  "provider_rejected"). NEVER fabricates scores.

NORMALIZED EVALUATION CONTRACT — the ONLY fields ever returned:
    scores: relevance, visual_grounding, detail, organization,
            understandable_language        (each int 0..100)
    understanding_summary, strongest_skill, next_improvement, coach_feedback
    overall (int 0..100, derived from the five scores)
Any other key the model emits (pronunciation, fluency, vocabulary, pauses,
confidence, acoustic, …) is DROPPED.
"""
from __future__ import annotations

import base64
import json
import logging
import os
import re
from typing import Any

import httpx

log = logging.getLogger("eduhub.voice_treasure.gemini")

FALLBACK_IMAGE_REF = "vt-fallback-default"

# Image outcomes
IMG_GENERATED = "generated"
IMG_FALLBACK = "fallback"
IMG_UNAVAILABLE = "unavailable"
IMG_FAILED = "failed"

# Evaluation contract — fixed
EVAL_CATEGORIES = (
    "relevance", "visual_grounding", "detail",
    "organization", "understandable_language",
)
EVAL_TEXT_FIELDS = (
    "understanding_summary", "strongest_skill", "next_improvement", "coach_feedback",
)

_TRUEY = {"1", "true", "yes", "on"}
_GEN_URL = "https://generativelanguage.googleapis.com/v1beta/models/{model}:generateContent"
_TIMEOUT = httpx.Timeout(45.0, connect=8.0)


def _env(name: str) -> str:
    return (os.environ.get(name) or "").strip()


def _api_key() -> str:
    return _env("GEMINI_API_KEY")


def _image_master_on() -> bool:
    return (os.environ.get("VOICE_TREASURE_IMAGE_GENERATION_ENABLED") or "").strip().lower() in _TRUEY


def image_generation_available(image_model: str | None = None) -> bool:
    model = (image_model or _env("VOICE_TREASURE_IMAGE_MODEL"))
    return bool(_image_master_on() and _api_key() and model)


def evaluation_available(eval_model: str | None = None) -> bool:
    model = (eval_model or _env("VOICE_TREASURE_EVAL_MODEL"))
    return bool(_api_key() and model)


# --------------------------------------------------------------------------- #
# Mission image                                                                #
# --------------------------------------------------------------------------- #
# Approved theme allowlist for controlled image-generation prompts.
APPROVED_IMAGE_THEMES = {
    "nature", "family_activities", "school", "public_places",
    "problem_solving", "celebrations",
}
# Image generation endpoint (Gemini image-capable model via generateContent).
_IMG_URL = "https://generativelanguage.googleapis.com/v1beta/models/{model}:generateContent"
# Provider output MIME allowlist + decoded-size ceiling for generated images.
GEN_ALLOWED_MIME = {"image/png", "image/webp", "image/jpeg"}
GEN_MAX_BYTES = 4 * 1024 * 1024


def _img_prompt(theme: str, difficulty: str) -> str:
    """Controlled prompt template. No student identifiers. Approved theme only."""
    safe_theme = theme if theme in APPROVED_IMAGE_THEMES else "school"
    level = {"beginner": "very simple and clear",
             "intermediate": "moderately detailed",
             "advanced": "richly detailed"}.get(difficulty, "clear")
    return (
        "Create an original, friendly, colorful cartoon illustration for a "
        f"children's English-learning game. Theme: {safe_theme}. Make it "
        f"{level}, with several clearly recognizable objects, people doing an "
        "activity, and an opaque background. No text, no logos, no watermarks, "
        "no real or copyrighted characters. Age-appropriate and easy to describe."
    )


async def prepare_mission_image(
    *, theme: str, difficulty: str, image_model: str | None = None,
    store=None, reference: str | None = None,
) -> dict[str, Any]:
    """Mission-image descriptor. Default path is the approved bundled fallback.
    When the master switch + key + model are present, performs a REAL provider
    request, validates the response MIME + size, stores the bytes via `store`
    (a callable(reference, bytes, mime) -> stored_ref), and returns a
    'generated' descriptor with an OPAQUE reference. Any failure falls back to
    the bundled mission WITHOUT raising (play never blocked, no double charge).

    `store` defaults to voice_treasure_scenes.store_generated_image when omitted
    (injected by the caller to keep this module dependency-free in tests).
    """
    if not image_generation_available(image_model):
        return {
            "outcome": IMG_FALLBACK, "image_kind": "fallback",
            "image_ref": FALLBACK_IMAGE_REF, "reason": "image_generation_disabled",
        }

    model = (image_model or _env("VOICE_TREASURE_IMAGE_MODEL"))
    key = _api_key()
    ref = reference or "vt-gen-image"
    body = {
        "contents": [{"role": "user", "parts": [{"text": _img_prompt(theme, difficulty)}]}],
        "generationConfig": {"responseModalities": ["IMAGE"]},
    }
    url = _IMG_URL.format(model=model)
    try:
        async with httpx.AsyncClient(timeout=_TIMEOUT) as cli:
            r = await cli.post(url, params={"key": key}, json=body)
        if r.status_code != 200:
            log.warning("vt-gemini: image-gen HTTP %s", r.status_code)  # no key/payload logged
            return _img_fallback("provider_rejected")
        inline = _extract_inline_image(r.json())
        if not inline:
            return _img_fallback("no_image_in_response")
        mime, raw_b64 = inline
        if mime not in GEN_ALLOWED_MIME:
            return _img_fallback("unsupported_output_mime")
        try:
            data = base64.b64decode(raw_b64, validate=True)
        except Exception:  # noqa: BLE001
            return _img_fallback("bad_image_encoding")
        if not data or len(data) > GEN_MAX_BYTES:
            return _img_fallback("output_size_invalid")
        # store via injected callable (or default store)
        sink = store
        if sink is None:
            import voice_treasure_scenes as _vts
            sink = _vts.store_generated_image
        try:
            stored_ref = sink(ref, data, mime)
        except Exception as exc:  # noqa: BLE001
            log.warning("vt-gemini: generated image store failed: %s", type(exc).__name__)
            return _img_fallback("store_failed")
        return {
            "outcome": IMG_GENERATED, "image_kind": "generated",
            "image_ref": ref, "stored_path": stored_ref, "image_mime": mime,
            "reason": None,
        }
    except Exception as exc:  # noqa: BLE001 — sanitized; never leak provider detail
        log.warning("vt-gemini: image-gen error %s", type(exc).__name__)
        return _img_fallback("generation_error")


def _img_fallback(reason: str) -> dict[str, Any]:
    return {
        "outcome": IMG_FAILED, "image_kind": "fallback",
        "image_ref": FALLBACK_IMAGE_REF, "reason": reason,
    }


def _extract_inline_image(payload: Any) -> tuple[str, str] | None:
    """Pull (mime, base64) from a generateContent image response. Tolerates the
    inline_data / inlineData spellings."""
    try:
        parts = payload["candidates"][0]["content"]["parts"]
    except Exception:  # noqa: BLE001
        return None
    for p in parts:
        blob = p.get("inline_data") or p.get("inlineData")
        if isinstance(blob, dict):
            mime = blob.get("mime_type") or blob.get("mimeType")
            data = blob.get("data")
            if mime and data:
                return mime, data
    return None


# Fixed, approved textual description of the fallback scene. Used to ground the
# evaluation when no generated image bytes exist.
FALLBACK_IMAGE_CONTEXT = (
    "A bright outdoor scene: a hot-air balloon rising over green hills at "
    "sunrise, with a calm lake, a few trees, and small figures of people "
    "watching from the ground."
)


def mission_context_for(image_ref: str, generated_context: str | None = None) -> str:
    if image_ref == FALLBACK_IMAGE_REF or not generated_context:
        return FALLBACK_IMAGE_CONTEXT
    return generated_context


# --------------------------------------------------------------------------- #
# Evaluation                                                                   #
# --------------------------------------------------------------------------- #
def _coach_prompt(mission_context: str, feedback_tone: str) -> str:
    tone = {"encouraging": "warm and encouraging", "neutral": "neutral and factual",
            "strict": "direct and rigorous"}.get(feedback_tone, "warm and encouraging")
    cats = ", ".join(EVAL_CATEGORIES)
    return (
        "You are an English speaking coach. A student listened to / looked at a "
        "picture and recorded a spoken description. The picture shows: "
        f"{mission_context}\n\n"
        "Evaluate ONLY the attached audio against the picture. Output STRICT "
        "JSON, no markdown, with EXACTLY these keys and nothing else:\n"
        "{\n"
        f'  "scores": {{ {", ".join(f3 + ": <int 0-100>" for f3 in EVAL_CATEGORIES)} }},\n'
        '  "understanding_summary": "<one sentence: what the student understood>",\n'
        '  "strongest_skill": "<one of: ' + cats + '>",\n'
        '  "next_improvement": "<one concrete, specific improvement>",\n'
        '  "coach_feedback": "<2-3 ' + tone + ' sentences, personalized>"\n'
        "}\n"
        "Do NOT include pronunciation, fluency, vocabulary, pause, confidence, "
        "or any acoustic measures. Score only the five listed categories."
    )


def normalize_evaluation(raw: Any) -> dict[str, Any] | None:
    """Coerce a model response into the fixed contract. Returns None if the
    payload cannot yield the required shape. DROPS every non-contract field."""
    data = raw
    if isinstance(raw, str):
        # tolerate ```json fences / surrounding text
        m = re.search(r"\{.*\}", raw, re.DOTALL)
        if not m:
            return None
        try:
            data = json.loads(m.group(0))
        except Exception:
            return None
    if not isinstance(data, dict):
        return None
    rs = data.get("scores")
    if not isinstance(rs, dict):
        return None

    def clamp(v) -> int | None:
        try:
            return max(0, min(100, int(round(float(v)))))
        except Exception:
            return None

    scores: dict[str, int] = {}
    for cat in EVAL_CATEGORIES:
        c = clamp(rs.get(cat))
        if c is None:
            return None  # all five required
        scores[cat] = c

    def text(field, default=""):
        v = data.get(field)
        return str(v)[:600] if isinstance(v, (str, int, float)) else default

    strongest = text("strongest_skill")
    if strongest not in EVAL_CATEGORIES:
        # snap to the highest-scoring category rather than trust free text
        strongest = max(scores, key=scores.get)

    overall = int(round(sum(scores.values()) / len(scores)))
    return {
        "scores": scores,                         # exactly the five
        "understanding_summary": text("understanding_summary"),
        "strongest_skill": strongest,
        "next_improvement": text("next_improvement"),
        "coach_feedback": text("coach_feedback"),
        "overall": overall,
    }


async def evaluate_speaking(
    *,
    audio_bytes: bytes,
    audio_mime: str,
    mission_context: str,
    feedback_tone: str = "encouraging",
    image_bytes: bytes | None = None,
    image_mime: str | None = None,
    eval_model: str | None = None,
) -> dict[str, Any]:
    """Run Gemini multimodal evaluation. Returns:
        {"ok": True, "result": <normalized contract>}
        {"ok": False, "reason": "evaluation_unavailable"|"evaluation_failed"|"provider_rejected"}
    Never fabricates scores; never raises; never logs audio or keys.
    """
    model = (eval_model or _env("VOICE_TREASURE_EVAL_MODEL"))
    key = _api_key()
    if not (key and model):
        return {"ok": False, "reason": "evaluation_unavailable"}
    if not audio_bytes:
        return {"ok": False, "reason": "evaluation_failed"}

    parts: list[dict[str, Any]] = [{"text": _coach_prompt(mission_context, feedback_tone)}]
    if image_bytes and image_mime:
        parts.append({"inline_data": {"mime_type": image_mime,
                                      "data": base64.b64encode(image_bytes).decode("ascii")}})
    parts.append({"inline_data": {"mime_type": audio_mime,
                                  "data": base64.b64encode(audio_bytes).decode("ascii")}})
    body = {
        "contents": [{"role": "user", "parts": parts}],
        "generationConfig": {"temperature": 0.4, "responseMimeType": "application/json"},
    }
    url = _GEN_URL.format(model=model)
    try:
        async with httpx.AsyncClient(timeout=_TIMEOUT) as cli:
            r = await cli.post(url, params={"key": key}, json=body)
        if r.status_code != 200:
            log.warning("vt-gemini: eval HTTP %s", r.status_code)
            return {"ok": False, "reason": "provider_rejected"}
        j = r.json()
        text = (
            j.get("candidates", [{}])[0]
            .get("content", {})
            .get("parts", [{}])[0]
            .get("text", "")
        )
        norm = normalize_evaluation(text)
        if norm is None:
            return {"ok": False, "reason": "evaluation_failed"}
        return {"ok": True, "result": norm}
    except Exception as exc:  # noqa: BLE001
        log.warning("vt-gemini: eval error %s", type(exc).__name__)
        return {"ok": False, "reason": "evaluation_failed"}
