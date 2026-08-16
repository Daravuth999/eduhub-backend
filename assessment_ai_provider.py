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
  GEMINI_API_KEY                  — provider key (absent => mock mode)
  ASSESSMENT_AI_MODEL                  — generateContent model (default: gemini-2.5-flash)
  ASSESSMENT_AI_API_VERSION            — API version for the flash/answer-key path
                                          (default: v1beta)
  ASSESSMENT_AI_SUBMISSION_MODEL       — generateContent model for physical-worksheet
                                          submission extraction (default: gemini-3.1-pro)
  ASSESSMENT_AI_SUBMISSION_API_VERSION — API version for the submission-extraction path
                                          (default: v1 — see DEFAULT_SUBMISSION_API_VERSION)
  ASSESSMENT_AI_MOCK                   — "1"/"true" forces mock mode even with a key
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


def _gen_url(model: str, api_version: str) -> str:
    return f"https://generativelanguage.googleapis.com/{api_version}/models/{model}:generateContent"


_FILES_UPLOAD_URL = "https://generativelanguage.googleapis.com/upload/v1beta/files"
_FILES_GET_URL = "https://generativelanguage.googleapis.com/v1beta/{name}"
_INLINE_MAX_BYTES = 15 * 1024 * 1024
_TIMEOUT = httpx.Timeout(120.0, connect=10.0)

DEFAULT_MODEL = "gemini-2.5-flash"
# Flash/answer-key path — Google's stable-but-evolving preview surface;
# every OTHER Gemini 2.x call site in this codebase (book_factory_gemini.py,
# gemini_engine.py, premium_ai_tools.py, voice_treasure_gemini.py, etc.)
# uses this same version, all confirmed still working.
DEFAULT_API_VERSION = "v1beta"

# Physical-worksheet answer recognition REQUIRES a Pro-tier vision model
# (2026-08 product direction) — never silently downgraded; the model
# actually used is persisted in the submission's extraction metadata.
#
# 2026-08-16 incident, part 1: "gemini-2.5-pro" started returning a real,
# logged Gemini error — {"code": 404, "status": "NOT_FOUND", "message":
# "This model models/gemini-2.5-pro is no longer available to new
# users..."} — confirming Google retired it (production Render log, not a
# guess). Replaced with "gemini-3.1-pro", confirmed via the account's own
# Google AI Studio quota/rate-limit list as a real, currently quota-tracked
# "Text-out models" entry named exactly "Gemini 3.1 Pro" — no "Preview"
# qualifier, unlike genuine previews in that same list ("Deep Research
# Pro Preview", "Computer Use Preview").
#
# 2026-08-16 incident, part 2: the corrected model id STILL 404'd —
# {"status": "NOT_FOUND", "message": "models/gemini-3.1-pro is not found
# for API version v1beta, or is not supported for generateContent..."}.
# Root cause: the API VERSION, not the model id. This codebase already has
# a LOCKED, tested precedent for exactly this — book_factory_image.py's
# "gemini-3.1-flash-image" (same 3.1 generation) is explicitly pinned to
# the stable "v1" endpoint, NOT "v1beta", per an explicit product decision
# with its own regression test locking the endpoint/model shape. Every
# OTHER Gemini call in this codebase that DOES use v1beta is on the 2.x
# generation (gemini-2.5-flash), which is unaffected. Submission
# extraction now uses v1 to match that established, working precedent —
# not a new guess, the same fix already proven for a sibling 3.1-model
# call site. Override via ASSESSMENT_AI_SUBMISSION_MODEL / ASSESSMENT_AI_
# SUBMISSION_API_VERSION without a redeploy if Google's naming or
# versioning policy shifts again — the improved provider_rejected error
# (see _gemini_http_error_detail) will say so explicitly instead of a
# bare "Gemini HTTP 404".
DEFAULT_SUBMISSION_MODEL = "gemini-3.1-pro"
DEFAULT_SUBMISSION_API_VERSION = "v1"
VERIFY_CONFIDENCE_THRESHOLD = 0.6
MAX_VERIFY_QIDS = 50


def _env(name: str) -> str:
    return (os.environ.get(name) or "").strip()


def _api_key() -> str:
    return _env("GEMINI_API_KEY")


def _model() -> str:
    return _env("ASSESSMENT_AI_MODEL") or DEFAULT_MODEL


def _api_version() -> str:
    return _env("ASSESSMENT_AI_API_VERSION") or DEFAULT_API_VERSION


def _submission_model() -> str:
    return _env("ASSESSMENT_AI_SUBMISSION_MODEL") or DEFAULT_SUBMISSION_MODEL


def _submission_api_version() -> str:
    return _env("ASSESSMENT_AI_SUBMISSION_API_VERSION") or DEFAULT_SUBMISSION_API_VERSION


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


def _gemini_http_error_detail(response) -> str:
    """Extracts the REAL provider-reported reason from a non-200 Gemini
    response body — never fabricated, never guessed. Gemini's REST API
    returns a structured {"error": {"code", "message", "status"}} object
    on failure (e.g. status=NOT_FOUND for a model id that doesn't exist
    or isn't enabled for this key, PERMISSION_DENIED, RESOURCE_EXHAUSTED
    for quota). Falls back to the raw response text (bounded) when the
    body isn't that shape, and to "" when nothing is extractable — a
    caller must never turn that into a fabricated explanation, only an
    honest bare HTTP status. Same isolated helper as video_ai_provider.
    py's _gemini_http_error_detail (duplicated, not imported, per this
    module's own no-shared-state convention)."""
    try:
        body = response.json()
    except Exception:  # noqa: BLE001
        text = (getattr(response, "text", "") or "").strip()
        return text[:300]
    error = body.get("error") if isinstance(body, dict) else None
    if isinstance(error, dict):
        status = str(error.get("status") or "").strip()
        message = str(error.get("message") or "").strip()
        if status and message:
            return f"{status}: {message}"
        return status or message
    text = (getattr(response, "text", "") or "").strip()
    return text[:300]


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
    "- \"answer\" is the SHORT classification/label a teacher would use to grade a "
    "student's response (e.g. \"LONG\"/\"SHORT\", \"True\"/\"False\", \"A\"/\"B\"/\"C\"/\"D\") — "
    "the single correct answer exactly as the key states it.\n"
    "- A row may ALSO contain a pronunciation guide, phonetic transcription (e.g. IPA "
    "symbols such as /ʃiː/), or other reference text. That reference text is NEVER "
    "the answer — use the short classification/label column instead, even if the "
    "reference text is positioned closer to \"answer\" in the layout.\n"
    "- Include every item. Do not summarize or skip rows.\n"
)


def _answer_key_prompt_for_text(raw_text: str) -> str:
    return _ANSWER_KEY_PROMPT + f"\nAnswer key text:\n\"\"\"\n{raw_text[:20000]}\n\"\"\"\n"


def _answer_vocabulary_hint(questions: list[dict]) -> str:
    """If this assessment's correct answers are drawn from a SMALL, fixed
    vocabulary (a classification/multiple-choice format like LONG vs
    SHORT, True vs False, A/B/C/D — the common case for a worksheet with
    printed answer choices), tell Gemini that vocabulary explicitly so it
    reports the student's marked CLASSIFICATION in the same words the
    answer key uses, rather than transcribing the prompt word itself or
    an unrelated column. Derived entirely from THIS assessment's own
    already-persisted correct answers — never a hardcoded word list — so
    it generalizes to any fixed-choice assessment, not just one specific
    one. Returns "" for a free-response assessment (many distinct
    answers), where no such vocabulary exists to anchor to."""
    values = sorted({str(q.get("correctAnswer") or "").strip() for q in questions if q.get("correctAnswer")})
    if not values or len(values) > 8:
        return ""
    joined = ", ".join(values)
    return (
        f"This assessment's answers are drawn from a fixed set of choices: {joined}. "
        "Report each answer as EXACTLY one of these words — the classification the "
        "student marked or circled — never the prompt word itself, never a "
        "pronunciation guide or phonetic transcription, and never any other text on "
        "the sheet.\n\n"
    )


def _submission_prompt(questions: list[dict]) -> str:
    numbered = "\n".join(
        f'- qid="{q.get("qid")}": "{q.get("prompt")}"' for q in questions[:200]
    )
    return (
        "You are reading a student's completed PHYSICAL answer sheet (a photo or scan "
        "of real paper) for a classroom assessment. Your ONLY job is to report what the "
        "student PHYSICALLY marked or wrote on the paper: circles, checkmarks, ticks, "
        "filled bubbles, handwritten words, underlines, crossed-out-then-replaced "
        "answers, pencil marks, pen marks — including faint, light, or partially erased "
        "marks. Account for photographed paper, scanned paper, skewed pages, shadows, "
        "low contrast, and multi-page documents.\n\n"
        "You must NOT infer or guess an answer from the question itself, from what "
        "would be academically correct, from the pattern of surrounding answers, or "
        "from any answer key. If the physical evidence for a question is unclear, "
        "report it as uncertain — never invent an answer.\n\n"
        f"Questions on this sheet:\n{numbered}\n\n"
        f"{_answer_vocabulary_hint(questions)}"
        "Output STRICT JSON only — no markdown, no commentary:\n"
        '{"answers": [\n'
        '  {"qid": "<exactly one of the qids above>", '
        '"answer": "<what the student physically marked/wrote, or \\"\\">", '
        '"answer_state": "<answered | blank | uncertain>", '
        '"confidence": <0.0-1.0, how certain this reading is>}\n'
        "]}\n"
        "Rules:\n"
        "- Output EXACTLY ONE entry for EVERY qid listed above, in the same order — "
        "even when a question is blank or unreadable. Never omit a qid, never invent a "
        "new qid, and never shift an answer from one question onto a neighboring one.\n"
        '- answer_state "answered": the student clearly marked/wrote this answer.\n'
        '- answer_state "blank": the question was genuinely left unanswered (answer must be "").\n'
        '- answer_state "uncertain": a mark may exist but cannot be read reliably — put '
        'your best literal reading in answer, or "" if none.\n'
    )


def _verification_prompt(questions: list[dict], suspect_qids: list[str]) -> str:
    by_qid = {str(q.get("qid")): q for q in questions}
    numbered = "\n".join(
        f'- qid="{qid}": "{by_qid.get(qid, {}).get("prompt", "")}"' for qid in suspect_qids
    )
    return (
        "You previously read a student's completed PHYSICAL answer sheet. A first pass "
        "could not reliably read the following specific questions. Re-inspect ONLY these "
        "questions on the attached paper, looking very carefully for faint marks, light "
        "pencil, partial circles, small checkmarks, or handwriting near each item.\n\n"
        "Report only what is physically on the paper. Do NOT infer an answer from the "
        "question, from other answers, or from what seems correct. If there is still no "
        "readable mark, keep it blank or uncertain honestly.\n\n"
        f"Questions to re-inspect:\n{numbered}\n\n"
        f"{_answer_vocabulary_hint(questions)}"
        "Output STRICT JSON only — no markdown, no commentary:\n"
        '{"answers": [\n'
        '  {"qid": "<exactly one of the qids above>", "answer": "<physical reading or \\"\\">", '
        '"answer_state": "<answered | blank | uncertain>", "confidence": <0.0-1.0>}\n'
        "]}\n"
        "- Output exactly one entry per qid above. Never invent a new qid.\n"
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


async def _call_gemini_json(prompt: str, *, media_part: dict | None = None,
                             model: str | None = None, api_version: str | None = None) -> dict:
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
    resolved_model = model or _model()
    resolved_version = api_version or _api_version()
    r = await _post(_gen_url(resolved_model, resolved_version), params={"key": api_key}, json=body)
    if r.status_code != 200:
        detail = _gemini_http_error_detail(r)
        log.warning("assessment-ai: HTTP %s | model=%s | api_version=%s | body=%s",
                    r.status_code, resolved_model, resolved_version, (r.text or "")[:400])
        # The real, provider-reported reason (e.g. "NOT_FOUND: models/foo is
        # not found" or "PERMISSION_DENIED: ... not enabled for this
        # project") must reach the caller — never collapsed down to a bare,
        # undiagnosable "Gemini HTTP 404" the way it used to be. Model +
        # api_version are both included so a future misconfiguration of
        # EITHER is immediately diagnosable from the persisted extractionError
        # alone, without needing Render log access.
        message = (f"Gemini HTTP {r.status_code} (model={resolved_model}, "
                    f"api_version={resolved_version})" + (f" — {detail}" if detail else ""))
        raise AssessmentAiError("provider_rejected", message)
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


def _suspect_qids(answers: list, questions: list[dict]) -> list[str]:
    """Qids worth a focused second look: missing from the first pass,
    reported uncertain, or answered with low confidence. High-confidence
    answered/blank readings are NOT wastefully reprocessed."""
    known = [str(q.get("qid")) for q in questions]
    by_qid = {}
    for a in answers or []:
        if isinstance(a, dict) and a.get("qid"):
            by_qid[str(a["qid"])] = a
    out: list[str] = []
    for qid in known:
        a = by_qid.get(qid)
        if a is None:
            out.append(qid)
            continue
        state = str(a.get("answer_state") or a.get("answerState") or "").strip().lower()
        try:
            conf = float(a.get("confidence"))
        except (TypeError, ValueError):
            conf = None
        if state == "uncertain" or (state == "answered" and conf is not None and conf < VERIFY_CONFIDENCE_THRESHOLD):
            out.append(qid)
    return out[:MAX_VERIFY_QIDS]


async def extract_submission_answers(media_bytes: bytes, content_type: str,
                                      questions: list[dict]) -> dict:
    """Extracts what a student physically marked/wrote from an uploaded
    worksheet photo/PDF using the configured Pro-tier model (see
    DEFAULT_SUBMISSION_MODEL), grounded against the
    assessment's own question prompts, with a focused second-pass
    verification of missing/uncertain/low-confidence questions only.
    Returns {"ok": True, "answers": [...], "engine": "gemini"|"mock",
    "model": <exact model used>, "verification": {...}|None} or
    {"ok": False, "reason": ...}. Never raises."""
    if not media_bytes:
        return {"ok": False, "reason": "empty_media"}
    if not questions:
        return {"ok": False, "reason": "no_questions"}
    if not ai_available():
        return {"ok": True, "answers": _mock_submission_answers(questions),
                "engine": "mock", "model": "mock", "verification": None}
    model = _submission_model()
    api_version = _submission_api_version()
    try:
        part = await _media_part(_api_key(), media_bytes, content_type or "application/octet-stream")
        data = await _call_gemini_json(_submission_prompt(questions), media_part=part,
                                        model=model, api_version=api_version)
        answers = data.get("answers")
        if not isinstance(answers, list):
            return {"ok": False, "reason": "bad_response: no answers array"}

        verification = None
        suspects = _suspect_qids(answers, questions)
        if suspects:
            verification = {"model": model, "checkedQids": suspects, "updatedQids": []}
            try:
                vdata = await _call_gemini_json(
                    _verification_prompt(questions, suspects), media_part=part,
                    model=model, api_version=api_version)
                vanswers = vdata.get("answers")
                if isinstance(vanswers, list):
                    suspect_set = set(suspects)
                    by_qid = {str(a.get("qid")): i for i, a in enumerate(answers)
                              if isinstance(a, dict) and a.get("qid")}
                    for va in vanswers:
                        if not isinstance(va, dict):
                            continue
                        qid = str(va.get("qid") or "")
                        if qid not in suspect_set:
                            continue  # verification may only touch the qids it was asked about
                        if qid in by_qid:
                            answers[by_qid[qid]] = va
                        else:
                            answers.append(va)
                        verification["updatedQids"].append(qid)
            except AssessmentAiError as exc:
                # Verification is best-effort: the audited first pass stands.
                verification["error"] = f"{exc.code}: {exc.message}" if exc.message else exc.code
                log.warning("assessment-ai: verification pass failed: %s", verification["error"])

        return {"ok": True, "answers": answers, "engine": "gemini",
                "model": model, "verification": verification}
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
    last one (reported uncertain) — clearly-labeled synthetic data so a
    caller can exercise the needs_review / teacher-correction / partial-
    credit paths offline."""
    out = []
    for q in questions[:-1] if len(questions) > 1 else questions:
        out.append({"qid": q.get("qid"), "answer": q.get("correctAnswer"),
                    "answer_state": "answered", "confidence": 0.92})
    if len(questions) > 1:
        out.append({"qid": questions[-1].get("qid"), "answer": "",
                    "answer_state": "uncertain", "confidence": 0.2})
    return out
