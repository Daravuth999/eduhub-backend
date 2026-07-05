"""book_factory_gemini.py — Book Factory (Phase 1) Gemini adapter.

Mirrors gemini_engine.py's proven pattern EXACTLY: raw `httpx` (no SDK), the
`GEMINI_API_KEY` environment variable, the `generateContent` REST endpoint,
and `responseMimeType: application/json`.  It imports nothing from
gemini_engine.py and never calls it (gemini_engine.py is on the protected
perimeter).

Phase 1 makes exactly ONE bounded call per blueprint and ONE bounded call per
chapter, PLUS at most ONE additional bounded invalid-JSON retry (§BLOCKER 3):
maximum TWO provider HTTP calls per generation version, never 3-6.  The call
count and the invalid-JSON-retry flag are reported to the caller through the
optional `budget` dict so orchestration can PERSIST them on the stage document.

Each call returns SEMANTIC JSON which book_factory_composer.py later turns into
canonical blocks.

Timeouts are named, environment-overridable constants.  The blueprint default
is 45s; chapter default 60s.
"""
from __future__ import annotations

import json
import logging
import os
from typing import Any, Optional

import httpx

log = logging.getLogger("eduhub.book_factory")


# ── §BLOCKER 2: provider transport exception classification ────────────────
class BFRetryableError(Exception):
    """Provider request proven NOT transmitted; auto-retry is safe."""


class BFUnknownOutcomeError(Exception):
    """Request may have been transmitted/processed; manual retry only."""


class BFTerminalError(Exception):
    """Permanent local error; no retry of any kind."""


class BFInvalidJSONError(ValueError):
    """A fulfilled (HTTP 200) response whose body / envelope / candidate text
    was not the required JSON shape.  Consumed by the bounded invalid-JSON
    retry; on the SECOND occurrence the adapter raises BFTerminalError."""


GEMINI_API_KEY = os.environ.get("GEMINI_API_KEY", "")
GEMINI_MODEL = os.environ.get("GEMINI_MODEL", "gemini-2.5-flash")
GEMINI_ENDPOINT = (
    "https://generativelanguage.googleapis.com/v1beta/models"
    f"/{GEMINI_MODEL}:generateContent"
)

# ── §PHASE B3: IMMUTABLE hard limits — env can only REDUCE, never raise ───────
# These define the absolute ceilings. Any env value above the hard limit is
# silently clamped; any non-numeric, missing, negative, zero, or Infinity value
# falls back to the documented safe default without crashing module import.
HARD_MAX_BLUEPRINT_TIMEOUT_S: float = 120.0   # max provider wait for blueprint
HARD_MAX_CHAPTER_TIMEOUT_S: float = 180.0     # max provider wait per chapter
HARD_MIN_TIMEOUT_S: float = 5.0               # minimum meaningful timeout
HARD_MAX_OUTPUT_TOKENS: int = 8192            # max tokens Gemini may emit
HARD_MIN_OUTPUT_TOKENS: int = 128             # minimum useful output
HARD_MAX_PROVIDER_CALLS: int = 2             # §HIGH 12: max HTTP calls per genver


def _env_int(name: str, default: int) -> int:
    """Read a non-negative int from the environment; return default on any failure."""
    try:
        v = int(os.environ.get(name, str(default)))
    except (TypeError, ValueError):
        return default
    return v if v >= 0 else default


def _env_float_clamped(name: str, default: float, hard_min: float, hard_max: float) -> float:
    """Read a float from the environment, clamped to [hard_min, hard_max].
    Returns `default` on any parse failure, including non-numeric, NaN, Infinity.
    Module import never raises on a bad env value (§PHASE B3)."""
    try:
        raw = os.environ.get(name, "")
        v = float(raw) if raw.strip() else default
    except (TypeError, ValueError):
        return default
    import math as _math
    if not _math.isfinite(v) or v <= 0:
        return default
    return max(hard_min, min(v, hard_max))


def _env_int_clamped(name: str, default: int, hard_min: int, hard_max: int) -> int:
    """Read an int from the environment, clamped to [hard_min, hard_max].
    Returns `default` on any parse failure (§PHASE B3)."""
    try:
        raw = os.environ.get(name, "")
        v = int(raw) if raw.strip() else default
    except (TypeError, ValueError):
        return default
    if v <= 0:
        return default
    return max(hard_min, min(v, hard_max))


# ── named, environment-overridable timeout constants ───────────────────────
# env can REDUCE below the default but never raise above the HARD maximum.
BLUEPRINT_TIMEOUT_S: float = _env_float_clamped(
    "BOOK_FACTORY_BLUEPRINT_TIMEOUT_S", 45.0, HARD_MIN_TIMEOUT_S, HARD_MAX_BLUEPRINT_TIMEOUT_S
)
CHAPTER_TIMEOUT_S: float = _env_float_clamped(
    "BOOK_FACTORY_CHAPTER_TIMEOUT_S", 60.0, HARD_MIN_TIMEOUT_S, HARD_MAX_CHAPTER_TIMEOUT_S
)


def effective_max_provider_calls() -> int:
    """§HIGH 12: the environment may only REDUCE the provider-call ceiling; it
    can never raise it above the immutable HARD_MAX_PROVIDER_CALLS."""
    return min(max(_env_int("BOOK_FACTORY_MAX_PROVIDER_CALLS", 2), 1), HARD_MAX_PROVIDER_CALLS)


MAX_PROVIDER_CALLS: int = effective_max_provider_calls()

_BLUEPRINT_MAX_TOKENS: int = _env_int_clamped(
    "BOOK_FACTORY_BLUEPRINT_MAX_TOKENS", 2048, HARD_MIN_OUTPUT_TOKENS, HARD_MAX_OUTPUT_TOKENS
)
_CHAPTER_MAX_TOKENS: int = _env_int_clamped(
    "BOOK_FACTORY_CHAPTER_MAX_TOKENS", 4096, HARD_MIN_OUTPUT_TOKENS, HARD_MAX_OUTPUT_TOKENS
)

_SYSTEM_INSTRUCTION = (
    "You are an expert ESL textbook author for English learners. "
    "You return ONLY valid JSON matching the requested schema. No Markdown "
    "fences, no commentary. You never invent image URLs, audio links, or media "
    "of any kind."
)


# ── §BLOCKER 1 / §HIGH 14: canonical pedagogy-profile prompt mapping ────────
# The SAME profile IDs are validated in book_factory_jobs.KNOWN_PEDAGOGY_PROFILES
# and offered by the frontend bookFactorySchema.PEDAGOGY_PROFILES.  Raw unknown
# IDs are never injected into a prompt — they are resolved through this mapping.
PEDAGOGY_PROFILES: dict[str, str] = {
    "general_english": (
        "General communicative English: balanced reading, everyday vocabulary, "
        "short dialogues and light speaking practice. Avoid grammar lectures."
    ),
    "daravuth_speaking_performance": (
        "Daravuth speaking & performance method. Emphasise: pronunciation "
        "(include IPA for genuinely difficult words where useful), word stress, "
        "sentence stress, linking and connected speech, and natural intonation. "
        "Build learner confidence through storytelling and performance, plus "
        "practical workplace communication. Do NOT give grammar lectures — teach "
        "through spoken models, prompts and performance."
    ),
    "pronunciation_focus": (
        "Pronunciation-focused: minimal pairs, word and sentence stress, IPA for "
        "difficult words, linking and connected speech, intonation drills. Avoid "
        "grammar lectures."
    ),
    "workplace_communication": (
        "Workplace communication: professional dialogues, meetings, email/phone "
        "register, polite requests and clarifications, confidence in speaking. "
        "Avoid grammar lectures."
    ),
    "storytelling_performance": (
        "Storytelling & performance: narrative arcs, expressive read-aloud, "
        "intonation and pacing for dramatic effect, confidence on stage. Avoid "
        "grammar lectures."
    ),
    "speaking_confidence": (
        "Speaking-confidence first: high-frequency functional language, fluency "
        "over accuracy, encouraging speaking prompts, low-anxiety practice. "
        "Avoid grammar lectures."
    ),
}


def pedagogy_description(profile_id: Optional[str]) -> str:
    """Resolve a known pedagogy profile ID to its prompt description. Unknown /
    missing IDs fall back to general_english (never injected raw)."""
    return PEDAGOGY_PROFILES.get(profile_id or "", PEDAGOGY_PROFILES["general_english"])


def is_gemini_key_present() -> bool:
    """True iff GEMINI_API_KEY is configured.  Reads the environment live so
    tests can toggle it per-case."""
    return bool(os.environ.get("GEMINI_API_KEY"))


def _model() -> str:
    return os.environ.get("GEMINI_MODEL", GEMINI_MODEL)


def _endpoint() -> str:
    return (
        "https://generativelanguage.googleapis.com/v1beta/models"
        f"/{_model()}:generateContent"
    )


async def _call_gemini_json(
    prompt: str,
    *,
    timeout: float,
    max_tokens: int,
    budget: Optional[dict] = None,
    max_calls: Optional[int] = None,
) -> dict[str, Any]:
    """POST to Gemini generateContent and return parsed JSON.

    §BLOCKER 3 — at most one bounded invalid-JSON retry.  A maximum of
    MAX_PROVIDER_CALLS (2) HTTP calls are ever made in a single invocation:
      * first malformed HTTP-200 response  → consume the one invalid-JSON retry;
      * second malformed HTTP-200 response → BFTerminalError (no more calls).

    `max_calls` lets the orchestration layer pass the REMAINING shared budget
    so a semantic-malformed-success retry (at the _run_chapter level) can
    borrow only its remaining slot without exceeding the global 2-call cap.
    Values above HARD_MAX_PROVIDER_CALLS are silently clamped down.

    When `budget` is a dict it is updated in place so the caller can PERSIST the
    real HTTP call count + whether the invalid-JSON retry was used:
        budget["providerCallCount"], budget["jsonRetryUsed"].

    Raises: BFRetryableError / BFUnknownOutcomeError / BFTerminalError.
    """
    if budget is not None:
        budget.setdefault("providerCallCount", 0)
        budget.setdefault("jsonRetryUsed", False)

    # §PHASE B3 / §BLOCKER 3: honour the caller's remaining-budget limit but
    # never exceed the hard maximum regardless of env or caller value.
    # `max_calls` is the REMAINING shared budget for THIS invocation (the
    # semantic-retry path passes 1 here when the first call already used 1 slot).
    effective_max = min(
        max_calls if max_calls is not None else MAX_PROVIDER_CALLS,
        MAX_PROVIDER_CALLS,
    )
    effective_max = max(effective_max, 1)  # always allow at least one attempt

    key = os.environ.get("GEMINI_API_KEY", "")
    if not key:
        # Missing key: httpx is never called → provably not transmitted.
        raise BFRetryableError("GEMINI_API_KEY is not set.")

    payload = {
        "systemInstruction": {"parts": [{"text": _SYSTEM_INSTRUCTION}]},
        "contents": [{"role": "user", "parts": [{"text": prompt}]}],
        "generationConfig": {
            "temperature": 0.7,
            "maxOutputTokens": max_tokens,
            "responseMimeType": "application/json",
        },
    }

    # §PHASE B1/PHASE B3: accumulate onto the shared budget counter rather than
    # overwriting it.  A second _call_gemini_json invocation (semantic retry)
    # receives budget["providerCallCount"]=1 already; adding delta keeps the
    # running total correct and prevents a third HTTP call appearing as call 1.
    budget_start = int(budget.get("providerCallCount") or 0) if budget is not None else 0

    calls = 0
    while True:
        calls += 1
        if budget is not None:
            budget["providerCallCount"] = budget_start + calls
        try:
            # §HIGH 11: BOTH a malformed HTTP-200 envelope (wrong-type
            # candidates/parts/text) AND unparseable candidate JSON raise
            # BFInvalidJSONError, so every malformed-success form flows through
            # the SAME bounded retry budget (max effective_max calls).
            text = await _gemini_http_once(payload, key, timeout)
            return _parse_json_text(text)
        except BFInvalidJSONError:
            if budget is not None:
                budget["jsonRetryUsed"] = True
            if calls >= effective_max:
                raise BFTerminalError(
                    "Gemini returned an unparseable/malformed success response "
                    f"(bounded malformed-response retry exhausted after "
                    f"{calls}/{effective_max} calls in this invocation)."
                )
            log.warning(
                "book_factory_gemini: malformed success, one bounded retry "
                "(extra provider call %d/%d)", calls + 1, effective_max,
            )
            continue


async def _gemini_http_once(payload: dict, key: str, timeout: float) -> str:
    """One HTTP round-trip. Classifies transport + HTTP-status outcomes into
    BFRetryableError / BFUnknownOutcomeError / BFTerminalError.
    Returns the raw candidate text (JSON parsing is done by the caller).
    A malformed HTTP-200 envelope raises BFInvalidJSONError (bounded retry)."""
    try:
        async with httpx.AsyncClient(timeout=timeout) as client:
            resp = await client.post(
                _endpoint(),
                params={"key": key},
                json=payload,
                headers={"Content-Type": "application/json"},
            )
    # ── retryable: request provably not (fully) transmitted ──
    except (httpx.ConnectError, httpx.ConnectTimeout, httpx.LocalProtocolError) as exc:
        raise BFRetryableError(f"pre-transmission failure: {type(exc).__name__}: {exc}") from exc
    # ── unknown outcome: request may have reached the provider ──
    except (httpx.WriteTimeout, httpx.WriteError, httpx.ReadTimeout,
            httpx.ReadError, httpx.RemoteProtocolError) as exc:
        raise BFUnknownOutcomeError(f"in-flight failure: {type(exc).__name__}: {exc}") from exc
    except httpx.TransportError as exc:  # any other transport error → unknown
        raise BFUnknownOutcomeError(f"transport failure: {type(exc).__name__}: {exc}") from exc

    status = resp.status_code
    if status == 200:
        try:
            data = resp.json()
        except Exception as exc:  # raw HTTP 200 body is not JSON at all
            raise BFInvalidJSONError(f"HTTP 200 body was not JSON: {exc}") from exc
        # §HIGH 11: validate every envelope layer's TYPE before touching it, so
        # a non-string candidate text (int / null / object) can never raise an
        # AttributeError that bypasses the bounded malformed-response budget.
        return _extract_candidate_text(data)
    if status == 429:
        raise BFRetryableError("Gemini rate-limited (HTTP 429), request not processed.")
    if 500 <= status <= 599:
        raise BFUnknownOutcomeError(f"Gemini server error (HTTP {status}), outcome unknown.")
    # Other 4xx: permanent client-side/request error → terminal, no retry.
    raise BFTerminalError(f"Gemini returned HTTP {status} (non-retryable).")


def _extract_candidate_text(data: Any) -> str:
    """§HIGH 11: pull the candidate text out of a Gemini HTTP-200 envelope,
    validating the TYPE of every layer. Any malformed shape — non-object
    envelope, missing/wrong-type candidates, missing/wrong-type content, parts,
    or a non-string text — raises BFInvalidJSONError so it flows through the
    SAME bounded malformed-response budget (never an AttributeError)."""
    if not isinstance(data, dict):
        raise BFInvalidJSONError("Gemini response envelope is not an object.")
    candidates = data.get("candidates")
    if not isinstance(candidates, list) or not candidates:
        raise BFInvalidJSONError("Gemini candidates missing or not a non-empty list.")
    cand0 = candidates[0]
    if not isinstance(cand0, dict):
        raise BFInvalidJSONError("Gemini candidate entry is not an object.")
    content = cand0.get("content")
    if not isinstance(content, dict):
        raise BFInvalidJSONError("Gemini candidate content missing or not an object.")
    parts = content.get("parts")
    if not isinstance(parts, list) or not parts:
        raise BFInvalidJSONError("Gemini candidate parts missing or not a non-empty list.")
    part0 = parts[0]
    if not isinstance(part0, dict):
        raise BFInvalidJSONError("Gemini candidate part is not an object.")
    text = part0.get("text")
    if not isinstance(text, str):
        raise BFInvalidJSONError("Gemini candidate text missing or not a string.")
    return text


def _parse_json_text(text: str) -> dict[str, Any]:
    """Parse a JSON object from Gemini text, tolerating accidental ```json
    fences.  Raises BFInvalidJSONError on failure (caller applies the bounded
    invalid-JSON retry)."""
    s = (text or "").strip()
    if s.startswith("```"):
        s = s.strip("`")
        if s[:4].lower() == "json":
            s = s[4:]
        s = s.strip()
    try:
        obj = json.loads(s)
    except json.JSONDecodeError as exc:
        raise BFInvalidJSONError(f"Gemini returned non-JSON: {exc}") from exc
    if not isinstance(obj, dict):
        raise BFInvalidJSONError("Gemini JSON root was not an object.")
    return obj


# ── prompts (§HIGH 14 — tier/pedagogy/targets materially reach the prompt) ──
def _blueprint_prompt(config: dict) -> str:
    title = config.get("title") or "Untitled"
    level = config.get("level") or "A2"
    section = config.get("section") or "story"
    chapters = int(config.get("chapterCount") or 5)
    topic = config.get("topic") or title
    review = bool(config.get("includeReviewChapter"))
    pedagogy = pedagogy_description(config.get("pedagogyProfile"))
    review_note = (
        f"After the {chapters} content chapters, append EXACTLY ONE extra review "
        "chapter titled 'Review' that revises the earlier chapters."
        if review else "Do NOT add a review chapter."
    )
    total = chapters + (1 if review else 0)
    return f"""Design a chapter-by-chapter blueprint for an English {section} book.

Book title: {title}
Topic/theme: {topic}
CEFR level: {level}
Number of content chapters: {chapters}
{review_note}

Pedagogy profile / instructional goals:
{pedagogy}

Return EXACTLY {total} chapter objects (no more, no fewer) in this JSON schema:
{{
  "bookTitle": "string",
  "summary": "1-2 sentence book description",
  "chapters": [
    {{ "title": "Chapter title", "objective": "what the learner can do after", "outline": "2-3 sentence outline" }}
  ]
}}

Return only valid JSON."""


def _chapter_prompt(config: dict, chapter_spec: dict) -> str:
    level = config.get("level") or "A2"
    title = chapter_spec.get("title") or "Chapter"
    outline = chapter_spec.get("outline") or ""
    objective = chapter_spec.get("objective") or ""
    pedagogy = pedagogy_description(config.get("pedagogyProfile"))

    def _num(key, default):
        v = config.get(key)
        return v if isinstance(v, int) and not isinstance(v, bool) else default

    min_words = _num("minWordsPerChapter", 120)
    max_words = _num("maxWordsPerChapter", 320)
    para_guidance = config.get("paragraphGuidance") or "short, learner-friendly paragraphs"
    dialogue_turns = _num("dialogueTurnsPerChapter", 4)
    vocab_n = _num("vocabularyPerChapter", 6)
    mcq_n = _num("mcqPerChapter", 3)
    fb_n = _num("fillblankPerChapter", 2)
    speak_n = _num("speakingPerChapter", 1)
    pron_depth = config.get("pronunciationDepth") or "standard"
    focused = (chapter_spec.get("focusedInstruction") or "").strip()
    review = bool(chapter_spec.get("isReview")) or (chapter_spec.get("title") or "").strip().lower() == "review"

    focus_note = f"\nFocused author instruction for this regeneration: {focused}" if focused else ""
    review_note = "\nThis is a REVIEW chapter: revise and consolidate earlier chapters." if review else ""

    return f"""Write one English lesson chapter as SEMANTIC JSON (no Reader blocks, no media).

Chapter title: {title}
Learning objective: {objective}
Outline: {outline}
CEFR level: {level}

Pedagogy profile / instructional goals:
{pedagogy}

Content targets (produce close to these amounts):
- Total prose {min_words}-{max_words} words across paragraphs.
- Paragraph guidance: {para_guidance}.
- Dialogue lines: about {dialogue_turns}.
- Vocabulary items: {vocab_n}.
- Multiple-choice questions: {mcq_n}.
- Fill-in-the-blank items: {fb_n}.
- Speaking-practice prompts: {speak_n}.
- Pronunciation depth: {pron_depth}.{review_note}{focus_note}

Rules:
- Every MCQ MUST include an exact "evidenceQuote": a short verbatim phrase copied
  word-for-word from your own paragraphs or dialogueLines that justifies the answer.
- Every fill-in-the-blank "text" MUST contain a blank marker: ___ or [blank].
- Do NOT invent any URLs, image references, or audio.

Return EXACTLY this JSON schema:
{{
  "title": "{title}",
  "paragraphs": ["short paragraph", "..."],
  "dialogueLines": [{{ "speaker": "Name", "text": "line" }}],
  "vocabulary": [{{ "word": "term", "meaning": "definition" }}],
  "pronunciationTargets": ["sound or word to practice"],
  "speakingPrompts": ["one speaking task"],
  "mcqs": [
    {{ "question": "...", "options": ["a","b","c"], "correctIndex": 0,
       "evidenceQuote": "verbatim phrase from the text above", "explain": "why" }}
  ],
  "fillblanks": [{{ "text": "I ___ to school.", "answer": "go", "explain": "" }}],
  "summary": "2-3 sentence recap"
}}

Return only valid JSON."""


# ── public async API (monkeypatched in tests) ─────────────────────────────
async def generate_blueprint(config: dict, *, budget: Optional[dict] = None) -> dict[str, Any]:
    return await _call_gemini_json(
        _blueprint_prompt(config),
        timeout=BLUEPRINT_TIMEOUT_S,
        max_tokens=_BLUEPRINT_MAX_TOKENS,
        budget=budget,
    )


async def generate_chapter(
    config: dict,
    chapter_spec: dict,
    *,
    budget: Optional[dict] = None,
    max_calls: Optional[int] = None,
) -> dict[str, Any]:
    # §PHASE B1: `max_calls` is forwarded so the semantic-malformed-retry path
    # in _run_chapter can limit this invocation to its remaining budget slot
    # (preventing a third HTTP call from being made).
    return await _call_gemini_json(
        _chapter_prompt(config, chapter_spec),
        timeout=CHAPTER_TIMEOUT_S,
        max_tokens=_CHAPTER_MAX_TOKENS,
        budget=budget,
        max_calls=max_calls,
    )


async def repair_mcq(mcq: dict, chapter_text: str) -> dict[str, Any]:
    # §BLOCKER B: in-stage MCQ repair is removed from Phase 1. The chapter
    # stage never calls a repair provider request. Signature retained so the
    # capability stays discoverable for Phase 2.
    raise NotImplementedError("MCQ repair deferred to Phase 2")
