"""speaking_lab_topic_questions.py — Automated Topic-Based Question
Generation for Speaking Lab Group Mode.

ADDITIVE ONLY, isolated module — same convention as gemini_engine.py,
question_bank.py, lucky_draw.py. Does not touch _finalize_draw,
_weighted_pick, or anything else already documented as protected
elsewhere in this codebase.

WHY THIS EXISTS
───────────────
Group Mode's "Discussion Topic" has always been a plain string passed to
GroupDiscussionCard.jsx — historically a random pick from the flat static
question bank (db.speaking_lab_settings, "beginner"/"intermediate"
arrays; see the still-untouched /speaking-lab/questions routes). This
module lets a group instead CHOOSE a topic CATEGORY (Daily Routine,
Sports, ...) and get back a real, freshly-relevant discussion question —
with zero manual admin input, ever: no one tags questions by topic, no
one reviews output before a class hears it. That trade-off is deliberate
(see the build directive this module implements) — automated validation
checks SHAPE and SAFETY constraints, never "is this a good question."

ARCHITECTURE (mirrors gemini_engine.py's structure — the closer analog:
one-shot structured generation from a single input param, not the
multi-field coach_pack_shared.py shape):
  1. is_enabled() / generate_question(topic=...) — Gemini call, strict
     JSON schema validation, one retry on invalid JSON, same
     GEMINI_API_KEY / GEMINI_MODEL env vars gemini_engine.py already reads
     (no second Gemini client, no second env var).
  2. Collection `speaking_lab_topic_question_pool` — a small, dedicated
     pool of pre-generated, unconsumed questions per topic. Not modeled
     on experience_config_tools.py (that platform is for timed BANNER
     content, not a consumable pool) and not modeled on Mystery Box's
     claims collection as-is (that's one resolved prize per claim, a
     different shape) — closest in IDEMPOTENCY spirit only: an atomic
     find_one_and_update claims exactly one row, the same primitive
     mystery_box_tools.py uses for its own reservation decrement.
  3. claim_or_generate_question() — the three-tier fallback that makes
     "instant" hold even when Gemini is unavailable or the background
     refill hasn't caught up: atomic pool claim → inline on-demand
     generation → the existing static question bank (any question, since
     that bank has no topic concept).
  4. refill_pool() — background top-up, called from an external-cron-
     triggered HTTP endpoint (POST .../topic-questions/refill-due),
     following the EXACT auth pattern server.py's own
     POST /push/schedule/run-due already established
     (x-cron-secret header OR super-admin) rather than introducing a
     second scheduling mechanism or a second secret. No in-process
     scheduler (APScheduler or similar) exists anywhere in this backend
     and none is introduced here.

Registering the refill-due endpoint on an actual recurring schedule is a
hosting-platform cron-config change, outside this codebase's own commit —
see this module's own register function docstring and the build report.
"""
from __future__ import annotations

import json
import logging
import os
import random
import re
import uuid
from datetime import datetime, timezone
from typing import Any, Awaitable, Callable, Optional

import httpx
from fastapi import APIRouter, Depends, Header, HTTPException, Path, Request

try:
    from pymongo import ReturnDocument as _ReturnDocument
except Exception:  # pragma: no cover — defensive, same guard mystery_box_tools.py uses
    _ReturnDocument = None

log = logging.getLogger("eduhub.speaking_lab_topic_questions")

# ── Config — SAME env vars gemini_engine.py reads, no second client ────────
GEMINI_API_KEY = os.environ.get("GEMINI_API_KEY", "")
GEMINI_MODEL = os.environ.get("GEMINI_MODEL", "gemini-2.5-flash")
GEMINI_ENDPOINT = (
    "https://generativelanguage.googleapis.com/v1beta/models"
    f"/{GEMINI_MODEL}:generateContent"
)
CRON_SECRET = os.environ.get("CRON_SECRET", "")

# ── Product decision: sensible defaults ship with the code — no admin ──────
# setup required before this works. Admin editing of this list is a
# fast-follow, not required for v1 (see build directive §B).
DEFAULT_TOPICS = [
    "Daily Routine", "Sports", "Problem & Solution", "Travel", "School", "Family",
]

POOL_COLL = "speaking_lab_topic_question_pool"
REFILL_THRESHOLD = 5  # below this many unused rows for a topic, top up
REFILL_TARGET = 8     # target unused-row count per topic after a refill

_REQUIRED_KEYS: set[str] = {"text"}

# ── Gemini system instruction — adapted from gemini_engine.py's own ────────
# "story scene" framing to a single discussion question, same tone/safety
# constraints (Cambodian ESL, classroom-safe, speaking-first).
_SYSTEM_INSTRUCTION = """\
You are EduHub's discussion-question generator for a Cambodian ESL \
speaking classroom (Speaking Lab, Group Mode).

You must output only valid JSON matching the provided schema.
Do not include Markdown.
Do not include explanations.
Do not include comments.
Do not wrap JSON in code fences.

EduHub classroom philosophy:
The goal is spoken English fluency and real communication, not written
grammar drills or translation exercises. English must remain primary.

Audience:
- A small mixed-level group of Cambodian young English learners,
  discussing together — NOT a single beginner or a single intermediate
  student. One question must serve the WHOLE group at once.
- Phrase it simply enough that a beginner can attempt an answer, while
  leaving clear room for an intermediate student to elaborate further —
  do not write two separate questions or a beginner/intermediate split.
- Use short, natural, speakable English. Avoid difficult idioms.
- Keep it warm, classroom-safe, and age-appropriate for school students.
- Never touch sensitive, political, romantic, violent, or otherwise
  classroom-inappropriate subject matter.

Output:
- Exactly one clear, speakable English discussion question related to
  the given topic category.
- The question should invite a short spoken opinion, experience, or
  story — something a group can actually TALK about, not a single-word
  trivia answer.

Return only the JSON object. No preamble, no trailing text."""


def is_enabled() -> bool:
    """Return True if the Gemini API key is configured — mirrors
    gemini_engine.is_enabled()."""
    return bool(GEMINI_API_KEY)


def _build_prompt(*, topic: str) -> str:
    return f"""\
Generate ONE speaking-discussion question for a Cambodian ESL classroom \
Group Mode session.

Topic category: {topic}

Required JSON schema — return EXACTLY this structure:
{{
  "text": "One clear, speakable English discussion question about this topic, simple enough for a beginner to attempt and open enough for an intermediate student to elaborate."
}}

Return only valid JSON. No Markdown. No explanations."""


async def _call_gemini(prompt: str) -> str:
    """POST to the Gemini generateContent REST endpoint and return the
    text — same request shape as gemini_engine._call_gemini."""
    payload = {
        "systemInstruction": {"parts": [{"text": _SYSTEM_INSTRUCTION}]},
        "contents": [{"role": "user", "parts": [{"text": prompt}]}],
        "generationConfig": {
            "temperature": 0.8,
            "maxOutputTokens": 200,
            "responseMimeType": "application/json",
        },
    }

    async with httpx.AsyncClient(timeout=30.0) as client:
        resp = await client.post(
            GEMINI_ENDPOINT,
            params={"key": GEMINI_API_KEY},
            json=payload,
            headers={"Content-Type": "application/json"},
        )

    if resp.status_code != 200:
        log.error(
            "speaking_lab_topic_questions: Gemini API error %d: %s",
            resp.status_code, resp.text[:300],
        )
        raise RuntimeError(
            f"Gemini API returned HTTP {resp.status_code}. "
            "Check GEMINI_API_KEY and model quota."
        )

    data = resp.json()
    try:
        text = data["candidates"][0]["content"]["parts"][0]["text"]
    except (KeyError, IndexError, TypeError) as exc:
        raise ValueError(
            f"Unexpected Gemini response shape: {exc}. Raw: {str(data)[:300]}"
        ) from exc

    return text


def _clean_json_text(raw: str) -> str:
    """Strip Markdown fences Gemini sometimes adds despite instructions —
    same helper as gemini_engine._clean_json_text (duplicated rather than
    imported: gemini_engine.py's helpers are private/module-internal, and
    this module must stay self-contained per its own isolation contract)."""
    cleaned = raw.strip()
    cleaned = re.sub(r"^```(?:json)?\s*", "", cleaned, flags=re.IGNORECASE)
    cleaned = re.sub(r"\s*```$", "", cleaned)
    return cleaned.strip()


def _validate(raw: str) -> dict[str, Any]:
    """Parse and strictly validate the Gemini JSON output. Raises
    ValueError with a clear message on any shape/safety failure — never
    returns a partially-valid guess (per the build directive's explicit
    "raise clearly on failure" instruction)."""
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

    text = data.get("text")
    if not isinstance(text, str) or not text.strip():
        raise ValueError("Gemini response 'text' must be a non-empty string")
    text = text.strip()

    # Safety: a single discussion question should never be an essay: cap
    # length and reject anything that looks like it accidentally returned
    # multiple questions or leaked instructions.
    if len(text) > 300:
        text = text[:300]
    if text.count("?") > 2:
        raise ValueError("Gemini response looks like more than one question")

    return {"text": text}


async def generate_question(*, topic: str) -> dict[str, Any]:
    """Call Gemini and return a strictly validated {"text": ...} dict.

    Raises:
        RuntimeError: if GEMINI_API_KEY is not set, or on network/auth failure.
        ValueError: if Gemini returns invalid JSON after one retry.
    """
    if not GEMINI_API_KEY:
        raise RuntimeError(
            "GEMINI_API_KEY is not set. Topic-based question generation is disabled."
        )

    prompt = _build_prompt(topic=topic)

    last_exc: Exception | None = None
    for attempt in range(2):
        try:
            raw_text = await _call_gemini(prompt)
            return _validate(raw_text)
        except (ValueError, json.JSONDecodeError) as exc:
            last_exc = exc
            log.warning(
                "speaking_lab_topic_questions: attempt %d JSON validation "
                "failed for topic=%s: %s", attempt + 1, topic, exc,
            )
            if attempt == 0:
                continue  # retry once
            break
        except Exception:
            raise  # network/auth errors propagate immediately, no retry

    raise ValueError(
        f"Gemini returned invalid JSON after 2 attempts for topic={topic!r}. "
        f"Last error: {last_exc}"
    )


# ── Pool + fallback ─────────────────────────────────────────────────────

async def ensure_topic_question_indexes(db) -> None:
    await db[POOL_COLL].create_index([("topic", 1), ("status", 1)])


def _new_pool_id() -> str:
    return f"tq_{uuid.uuid4().hex[:16]}"


async def _draw_from_static_bank(db) -> Optional[str]:
    """The existing static question bank — the SAME flat doc
    fetchQuestions()/pickTopic() already read on the frontend
    (db.speaking_lab_settings, _id="questions", {"beginner":[...],
    "intermediate":[...]}). No topic concept there, so any question will
    do — this is only ever reached when Gemini is disabled or has failed,
    as the last-resort guarantee that a group is never blocked."""
    doc = await db.speaking_lab_settings.find_one({"_id": "questions"})
    if not doc:
        return None
    all_q = [*(doc.get("beginner") or []), *(doc.get("intermediate") or [])]
    all_q = [q for q in all_q if isinstance(q, str) and q.strip()]
    if not all_q:
        return None
    return random.choice(all_q)


async def claim_or_generate_question(db, *, topic: str, session_id: str) -> dict[str, Any]:
    """Three-tier fallback (build directive C1 step 3):
      1. Atomically claim one unused pool row for this topic
         (find_one_and_update — the concurrency-safety step: two groups
         picking the same topic at the same instant can never get the
         same row, since MongoDB's find_one_and_update is a single atomic
         server-side operation).
      2. If none available, generate one inline, right here in the
         request — the safety net that keeps "instant" true even if the
         background refill hasn't caught up.
      3. If Gemini is disabled or inline generation also fails, fall back
         to the existing static question bank (any question) so the
         group is NEVER blocked.

    Returns {"text": ..., "topic": ..., "source": "pool"|"generated"|"fallback_bank"}.
    """
    coll = db[POOL_COLL]
    now = datetime.now(timezone.utc)
    update = {"$set": {
        "status": "used", "used_at": now, "used_by_group_session_id": session_id,
    }}
    kwargs: dict[str, Any] = {}
    if _ReturnDocument is not None:
        kwargs["return_document"] = _ReturnDocument.AFTER

    try:
        claimed = await coll.find_one_and_update(
            {"topic": topic, "status": "unused"}, update, **kwargs,
        )
    except Exception as exc:  # noqa: BLE001 — never let a query error block the group
        log.warning("speaking_lab_topic_questions: pool claim failed for topic=%s: %s", topic, exc)
        claimed = None

    if claimed:
        # Defensive fallback for a driver that returns the PRE-update
        # snapshot (mystery_box_tools.py documents the same motor
        # quirk) — the field we read (`text`) is immutable either way.
        return {"text": claimed["text"], "topic": topic, "source": "pool"}

    if is_enabled():
        try:
            generated = await generate_question(topic=topic)
            doc = {
                "_id": _new_pool_id(),
                "topic": topic,
                "text": generated["text"],
                "status": "used",
                "created_at": now,
                "used_at": now,
                "used_by_group_session_id": session_id,
            }
            await coll.insert_one(doc)
            return {"text": generated["text"], "topic": topic, "source": "generated"}
        except Exception as exc:  # noqa: BLE001 — fall through to the static bank
            log.warning(
                "speaking_lab_topic_questions: inline generation failed for "
                "topic=%s: %s", topic, exc,
            )

    fallback_text = await _draw_from_static_bank(db)
    if fallback_text:
        return {"text": fallback_text, "topic": topic, "source": "fallback_bank"}

    # Absolute last resort — matches the frontend's own pickTopic()
    # fallback string, so a group is never blocked even with an empty
    # static bank.
    return {"text": "Discuss pronunciation strategies", "topic": topic, "source": "fallback_bank"}


async def refill_pool(db) -> dict[str, Any]:
    """For each DEFAULT_TOPICS entry, top up to REFILL_TARGET unused rows
    if currently below REFILL_THRESHOLD. Stops generating for a topic on
    the first failure that attempt (Gemini disabled/erroring) rather than
    retrying in a hot loop — the next scheduled run tries again."""
    coll = db[POOL_COLL]
    results: dict[str, Any] = {}
    for topic in DEFAULT_TOPICS:
        count = await coll.count_documents({"topic": topic, "status": "unused"})
        if count >= REFILL_THRESHOLD:
            results[topic] = {"before": count, "generated": 0}
            continue

        need = REFILL_TARGET - count
        generated = 0
        if is_enabled():
            for _ in range(need):
                try:
                    q = await generate_question(topic=topic)
                except Exception as exc:  # noqa: BLE001
                    log.warning(
                        "speaking_lab_topic_questions: refill generation "
                        "failed for topic=%s: %s", topic, exc,
                    )
                    break
                await coll.insert_one({
                    "_id": _new_pool_id(),
                    "topic": topic,
                    "text": q["text"],
                    "status": "unused",
                    "created_at": datetime.now(timezone.utc),
                    "used_at": None,
                    "used_by_group_session_id": None,
                })
                generated += 1
        results[topic] = {"before": count, "generated": generated}
    return results


# ── Routes ──────────────────────────────────────────────────────────────

def register_topic_question_routes(
    api: APIRouter,
    db,
    require_admin: Callable,
    *,
    current_user: Optional[Callable] = None,
    is_super_admin: Optional[Callable[[Any], bool]] = None,
) -> None:
    """Mounts:
      GET  /speaking-lab/topic-questions/topics
      POST /speaking-lab/sessions/{session_id}/topic-questions/draw
      POST /speaking-lab/topic-questions/refill-due

    The refill-due endpoint follows the EXACT auth pattern already
    established by server.py's POST /push/schedule/run-due (x-cron-secret
    header OR super-admin), reusing the same CRON_SECRET env var — no
    second secret. `current_user`/`is_super_admin` are accepted as
    parameters (same dependency-injection convention every other
    register_*_routes function already uses for require_admin) rather
    than importing server.py's internals directly, which would create a
    circular import.

    IMPORTANT — outside this codebase's own commit: registering this
    endpoint on an actual recurring schedule (e.g. every 15-30 minutes)
    is a hosting-platform cron-config change, not something this module
    can do by itself. See this feature's build report.
    """

    @api.get("/speaking-lab/topic-questions/topics")
    async def list_topics(admin=Depends(require_admin)):
        return {"topics": DEFAULT_TOPICS}

    @api.post("/speaking-lab/sessions/{session_id}/topic-questions/draw")
    async def draw_topic_question(
        payload: dict,
        session_id: str = Path(..., min_length=1, max_length=128),
        admin=Depends(require_admin),
    ):
        topic = str((payload or {}).get("topic") or "").strip()
        if not topic:
            raise HTTPException(status_code=400, detail="topic is required")
        result = await claim_or_generate_question(db, topic=topic, session_id=session_id)
        return result

    if current_user is not None:
        @api.post("/speaking-lab/topic-questions/refill-due")
        async def topic_questions_refill_due(
            request: Request,
            x_cron_secret: str | None = Header(default=None, alias="x-cron-secret"),
            user=Depends(current_user),
        ):
            is_admin = bool(is_super_admin(user)) if (user and is_super_admin) else False
            secret_ok = bool(CRON_SECRET) and x_cron_secret == CRON_SECRET
            if not (is_admin or secret_ok):
                raise HTTPException(status_code=403, detail="forbidden")

            results = await refill_pool(db)
            return {"ok": True, "topics": results}

    log.info("speaking_lab_topic_questions: routes registered")
