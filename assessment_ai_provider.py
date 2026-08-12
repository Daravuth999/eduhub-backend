"""assessment_ai_provider.py — Gemini-primary AI engine for the AI
Assessment / Quiz Submission Lab.

Self-contained, same isolation convention as video_ai_provider.py /
gemini_engine.py / voice_treasure_gemini.py: its own httpx calls against
generativelanguage.googleapis.com, its own GEMINI_API_KEY read, its own
strict-JSON prompts, normalize-at-the-boundary (assessment_schema.py's
normalize_* functions), never raises into a route. No shared state with
any other Gemini integration in this codebase.

Two capabilities, both "extract, never grade" (grading is assessment_
scoring.py's deterministic job):

  extract_answer_key(...)      — teacher uploads/pastes an answer key
                                  (image, PDF, or already-extracted plain
                                  text e.g. from a .docx) -> a structured
                                  question list for the teacher to review
                                  before publishing.
  extract_submission_answers() — student's uploaded worksheet photo/PDF,
                                  grounded with the assessment's OWN
                                  question prompts (so Gemini maps answers
                                  to known qids, never invents new ones) ->
                                  a structured per-question answer list.

Mock mode (no GEMINI_API_KEY, or ASSESSMENT_AI_MOCK=1) returns a clearly-
labeled deterministic response so both pipelines are exercisable in any
environment, matching video_ai_provider.py's MockVideoProvider precedent.

Env:
  GEMINI_API_KEY        — provider key (absent => mock mode)
  ASSESSMENT_AI_MODEL   — generateContent model (default: gemini-2.5-flash)
  ASSESSMENT_AI_MOCK    — "1"/"true" forces mock mode even with a key
"""
from __future__ import annotations

import base64
import json
import logging
import os
import re

import httpx

log = logging.getLogger("eduhub.assessment_ai")

_TRUEY = {"1", "true", "yes", "on"}
_GEN_URL = "https://generativelanguage.googleapis.com/v1beta/models/{model}:generateContent"
_FILES_UPLOAD_URL = "https://generativelanguage.googleapis.com/upload/v1beta/files"
_FILES_GET_URL = "https://generativelanguage.googleapis.com/v1beta/{name}"
_INLINE_MAX_BYTES = 15 * 1024 * 1024
_TIMEOUT = httpx.Timeout(120.0, connect=10.0)

DEFAULT_MODEL = "gemini-2.5-flash"


def _env(name: str) -> str:
    return (os.environ.get(name) or "").strip()


def _api_key() -> str:
    return _env("GEMINI_API_KEY")


def _model() -> str:
    return _env("ASSESSMENT_AI_MODEL") or DEFAULT_MODEL


def _mock_forced() -> bool:
    return _env("ASSESSMENT_AI_MOCK").lower() in _TRUEY


def ai_available() -> bool:
    return bool(_api_key()) and not _mock_forced()


def _extract_json(text: str):
    if not isinstance(text, str):
        return None
    m = re.search(r"[\[{].*[\]}]", text, re.DOTALL)
    if not m:
        return None
    try:
        return json.loads(m.group(0))
    except Exception:  # noqa: BLE001
        return None


def _candidate_text(payload: dict) -> str:
    try:
        parts = payload["candidates"][0]["content"]["parts"]
    except Exception:  # noqa: BLE001
        return ""
    return "".join(p.get("text", "") for p in parts if isinstance(p, dict))


def _response_diagnostics(payload) -> str:
    if not isinstance(payload, dict):
        return "response was not a JSON object"
    feedback = payload.get("promptFeedback")
    block_reason = feedback.get("blockReason") if isinstance(feedback, dict) else None
    if block_reason:
        return f"blockReason={block_reason}"
    candidates = payload.get("candidates")
    if not candidates:
        return "no candidates returned"
    first = candidates[0] if isinstance(candidates[0], dict) else {}
    finish_reason = first.get("finishReason")
    if finish_reason and finish_reason != "STOP":
        return f"finishReason={finish_reason}"
    return ""


class AssessmentAiError(Exception):
    def __init__(self, code: str, message: str = "") -> None:
        super().__init__(message or code)
        self.code = code
        self.message = message or code


_ANSWER_KEY_PROMPT = (
    "You are reading a teacher's answer key for a classroom assessment. "
    "Extract every question/item into STRICT JSON only — no markdown, no commentary:\n"
    '{"items": [\n'
    '  {"no": <int>, "prompt": "<the word/question text>", "answer": "<the correct answer>", "points": <number, optional>}\n'
    "]}\n"
    "Rules:\n"
    "- One item per question/row, in the order they appear.\n"
    "- \"prompt\" is what the student is shown (a word, a question, a sentence).\n"
    "- \"answer\" is the single correct answer exactly as the key states it.\n"
    "- Include every item. Do not summarize or skip rows.\n"
)


def _answer_key_prompt_for_text(raw_text: str) -> str:
    return _ANSWER_KEY_PROMPT + f"\nAnswer key text:\n\"\"\"\n{raw_text[:20000]}\n\"\"\"\n"


def _submission_prompt(questions: list[dict]) -> str:
    numbered = "\n".join(
        f'- qid="{q.get("qid")}": "{q.get("prompt")}"' for q in questions[:200]
    )
    return (
        "You are reading a student's completed answer sheet (a photo or scan) for a "
        "classroom assessment. Below is the exact list of questions on this sheet, "
        "identified by qid. For EACH qid, find what the student marked/wrote as their "
        "answer and report it. If a question was left blank or is illegible, omit it "
        "from the output rather than guessing.\n\n"
        f"Questions on this sheet:\n{numbered}\n\n"
        "Output STRICT JSON only — no markdown, no commentary:\n"
        '{"answers": [\n'
        '  {"qid": "<exactly one of the qids above>", "answer": "<what the student marked/wrote>", '
        '"confidence": <0.0-1.0, how legible/certain this reading is>}\n'
        "]}\n"
        "Rules:\n"
        "- qid MUST be copied exactly from the list above — never invent a new qid.\n"
        "- One entry per question the student actually answered.\n"
    )


async def _post(url: str, **kwargs) -> httpx.Response:
    async with httpx.AsyncClient(timeout=_TIMEOUT) as cli:
        return await cli.post(url, **kwargs)


async def _get(url: str, **kwargs) -> httpx.Response:
    async with httpx.AsyncClient(timeout=_TIMEOUT) as cli:
        return await cli.get(url, **kwargs)


async def _upload_to_files_api(api_key: str, media_bytes: bytes, content_type: str) -> str:
    import asyncio as _asyncio

    r = await _post(
        _FILES_UPLOAD_URL,
        params={"key": api_key},
        headers={
            "X-Goog-Upload-Protocol": "raw",
            "Content-Type": content_type or "application/octet-stream",
        },
        content=media_bytes,
    )
    if r.status_code != 200:
        raise AssessmentAiError("files_upload_failed", f"Gemini Files API HTTP {r.status_code}: {r.text[:300]}")
    info = (r.json() or {}).get("file") or {}
    uri, name, state = info.get("uri"), info.get("name"), info.get("state")
    if not uri:
        raise AssessmentAiError("files_upload_failed", "Files API returned no file uri")
    waited = 0.0
    while state == "PROCESSING" and waited < 120.0:
        await _asyncio.sleep(3.0)
        waited += 3.0
        g = await _get(_FILES_GET_URL.format(name=name), params={"key": api_key})
        if g.status_code == 200:
            state = (g.json() or {}).get("state")
    if state not in (None, "ACTIVE"):
        raise AssessmentAiError("files_processing_failed", f"Files API state: {state}")
    return uri


async def _media_part(api_key: str, media_bytes: bytes, content_type: str) -> dict:
    if len(media_bytes) <= _INLINE_MAX_BYTES:
        return {"inline_data": {
            "mime_type": content_type or "application/octet-stream",
            "data": base64.b64encode(media_bytes).decode("ascii"),
        }}
    uri = await _upload_to_files_api(api_key, media_bytes, content_type)
    return {"file_data": {"mime_type": content_type, "file_uri": uri}}


async def _call_gemini_json(prompt: str, *, media_part: dict | None = None) -> dict:
    """Shared call+parse path for both extraction capabilities. Returns the
    parsed JSON object (dict) on success. Raises AssessmentAiError with a
    real, non-fabricated reason on any provider or parse failure."""
    api_key = _api_key()
    parts = [{"text": prompt}]
    if media_part is not None:
        parts.append(media_part)
    body = {
        "contents": [{"role": "user", "parts": parts}],
        "generationConfig": {"temperature": 0.0, "responseMimeType": "application/json"},
    }
    r = await _post(_GEN_URL.format(model=_model()), params={"key": api_key}, json=body)
    if r.status_code != 200:
        log.warning("assessment-ai: HTTP %s | body=%s", r.status_code, (r.text or "")[:400])
        raise AssessmentAiError("provider_rejected", f"Gemini HTTP {r.status_code}")
    raw_payload = r.json()
    text = _candidate_text(raw_payload)
    data = _extract_json(text)
    if not isinstance(data, dict):
        diag = _response_diagnostics(raw_payload)
        detail = "Gemini returned no parsable JSON object" + (f" ({diag})" if diag else "")
        raise AssessmentAiError("bad_response", detail)
    return data


async def extract_answer_key(*, raw_text: str | None = None,
                              media_bytes: bytes | None = None,
                              content_type: str | None = None) -> dict:
    """Extracts a structured question list from a teacher's answer key.
    Exactly one of `raw_text` (e.g. text already pulled from a .docx) or
    `media_bytes`+`content_type` (image/PDF) must be supplied. Returns
    {"ok": True, "items": [...], "engine": "gemini"|"mock"} or
    {"ok": False, "reason": "<code>[: <detail>]"}. Never raises."""
    if not raw_text and not media_bytes:
        return {"ok": False, "reason": "no_input"}
    if not ai_available():
        return {"ok": True, "items": list(_MOCK_ANSWER_KEY_ITEMS), "engine": "mock"}
    try:
        if media_bytes:
            part = await _media_part(_api_key(), media_bytes, content_type or "application/octet-stream")
            data = await _call_gemini_json(_ANSWER_KEY_PROMPT, media_part=part)
        else:
            data = await _call_gemini_json(_answer_key_prompt_for_text(raw_text or ""))
        items = data.get("items")
        if not isinstance(items, list):
            return {"ok": False, "reason": "bad_response: no items array"}
        return {"ok": True, "items": items, "engine": "gemini"}
    except AssessmentAiError as exc:
        return {"ok": False, "reason": f"{exc.code}: {exc.message}" if exc.message else exc.code}
    except Exception as exc:  # noqa: BLE001
        log.exception("assessment-ai: extract_answer_key failed")
        return {"ok": False, "reason": f"unexpected_error: {exc}"}


async def extract_submission_answers(media_bytes: bytes, content_type: str,
                                      questions: list[dict]) -> dict:
    """Extracts what a student marked/wrote from an uploaded worksheet
    photo/PDF, grounded against the assessment's own question prompts.
    Returns {"ok": True, "answers": [...], "engine": "gemini"|"mock"} or
    {"ok": False, "reason": ...}. Never raises."""
    if not media_bytes:
        return {"ok": False, "reason": "empty_media"}
    if not questions:
        return {"ok": False, "reason": "no_questions"}
    if not ai_available():
        return {"ok": True, "answers": _mock_submission_answers(questions), "engine": "mock"}
    try:
        part = await _media_part(_api_key(), media_bytes, content_type or "application/octet-stream")
        data = await _call_gemini_json(_submission_prompt(questions), media_part=part)
        answers = data.get("answers")
        if not isinstance(answers, list):
            return {"ok": False, "reason": "bad_response: no answers array"}
        return {"ok": True, "answers": answers, "engine": "gemini"}
    except AssessmentAiError as exc:
        return {"ok": False, "reason": f"{exc.code}: {exc.message}" if exc.message else exc.code}
    except Exception as exc:  # noqa: BLE001
        log.exception("assessment-ai: extract_submission_answers failed")
        return {"ok": False, "reason": f"unexpected_error: {exc}"}


# ── Mock mode (no key required — pipeline always exercisable) ────────────
_MOCK_ANSWER_KEY_ITEMS = [
    {"no": 1, "prompt": "sheep", "answer": "LONG", "points": 0.5},
    {"no": 2, "prompt": "ship", "answer": "SHORT", "points": 0.5},
]


def _mock_submission_answers(questions: list[dict]) -> list[dict]:
    """Deterministic mock: 'answers' every question correctly except the
    last one (left blank) — clearly-labeled synthetic data so a caller can
    exercise the needs_review / partial-credit paths offline."""
    out = []
    for q in questions[:-1] if len(questions) > 1 else questions:
        out.append({"qid": q.get("qid"), "answer": q.get("correctAnswer"), "confidence": 0.92})
    return out
