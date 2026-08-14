"""student_learning_profile_tools.py — EduHub Coach Pack v3.

Single source of truth for student learning state. Every other Coach Pack
module reads from / writes deltas to the `student_learning_profile`
collection through the helpers in this file.

Hard isolation contract:
  - Touches ONLY `student_learning_profile`, `chapter_progress`,
    `coach_briefing_cache` (read), `student_vocab` (read), `student_sentences` (read).
  - Does NOT modify payment / wallet / auth collections.
"""
from __future__ import annotations

import logging
from typing import Any

from fastapi import APIRouter, Depends, HTTPException

from coach_pack_shared import (
    COL_SLP, COL_VOCAB, COL_SENTENCES, COL_CHAPTER_PROGRESS,
    iso_now, week_start_str, today_str,
)

log = logging.getLogger("eduhub.coach_pack.slp")


# --------------------------------------------------------------------------- #
# SLP shape (defensive defaults — every key has a sensible fallback).         #
# --------------------------------------------------------------------------- #
def _empty_slp(student_id: str) -> dict[str, Any]:
    return {
        "student_id": student_id,
        "implicit_level": "beginner",        # beginner | intermediate | advanced
        "language_pref": "kh-en",             # kh | en | kh-en
        "words_saved_total": 0,
        "sentences_saved_total": 0,
        "chapters_completed_total": 0,
        "streak_days": 0,
        "last_active_day": "",                # YYYY-MM-DD
        "books_active": [],                   # list[str] book_slug
        "weaknesses": {                       # 5-dial rolling map
            "grammar": 0, "vocabulary": 0, "comprehension": 0,
            "tone": 0, "pronunciation": 0,
        },
        "last_book_slug": "",
        "last_chapter_idx": -1,
        "created_at": iso_now(),
        "updated_at": iso_now(),
    }


async def get_or_init_slp(db, student_id: str) -> dict[str, Any]:
    doc = await db[COL_SLP].find_one({"student_id": student_id})
    if doc:
        # Defensive merge for any missing keys (forward-compatible).
        base = _empty_slp(student_id)
        for k, v in (doc or {}).items():
            if k == "_id":
                continue
            base[k] = v
        return base
    seed = _empty_slp(student_id)
    try:
        await db[COL_SLP].update_one(
            {"student_id": student_id},
            {"$setOnInsert": seed},
            upsert=True,
        )
    except Exception as exc:  # noqa: BLE001
        log.warning("slp: seed insert failed: %s", exc)
    return seed


async def update_slp(db, student_id: str, *, set_fields: dict | None = None,
                     inc_fields: dict | None = None) -> None:
    update: dict[str, Any] = {}
    s = dict(set_fields or {})
    s["updated_at"] = iso_now()
    update["$set"] = s
    if inc_fields:
        update["$inc"] = {k: int(v) for k, v in inc_fields.items()}
    try:
        await db[COL_SLP].update_one(
            {"student_id": student_id}, update, upsert=True,
        )
    except Exception as exc:  # noqa: BLE001
        log.warning("slp: update failed: %s", exc)


async def touch_active_day(db, student_id: str) -> None:
    """Update last_active_day and streak counter.

    Streak rules:
      - same day: no change.
      - consecutive day: streak += 1.
      - skipped 1+ day: reset to 1.
    """
    slp = await get_or_init_slp(db, student_id)
    today = today_str()
    last = (slp.get("last_active_day") or "").strip()
    if last == today:
        return
    new_streak = 1
    if last:
        try:
            from datetime import date as _date
            ly, lm, ld = (int(x) for x in last.split("-"))
            ty, tm, td = (int(x) for x in today.split("-"))
            ldate = _date(ly, lm, ld)
            tdate = _date(ty, tm, td)
            if (tdate.toordinal() - ldate.toordinal()) == 1:
                new_streak = int(slp.get("streak_days") or 0) + 1
        except Exception:  # noqa: BLE001
            new_streak = 1
    await update_slp(db, student_id, set_fields={
        "last_active_day": today,
        "streak_days": new_streak,
    })


# --------------------------------------------------------------------------- #
# Context Envelope — read-only snapshot every AI feature uses                 #
# --------------------------------------------------------------------------- #
async def build_context_envelope(
    db, *, student, book_slug: str, chapter_idx: int = -1, paragraph: str = "",
) -> dict[str, Any]:
    """Return a compact dict every Coach Pack LLM prompt can interpolate.

    Heavy reads are bounded (last 30 saved words, last 10 saved sentences).
    Failure-safe: any single read failure degrades to an empty list.
    """
    slp = await get_or_init_slp(db, student.clean_id)
    # Recent vocab.
    recent_words: list[str] = []
    try:
        cur = db[COL_VOCAB].find(
            {"student_id": student.clean_id},
            {"word": 1, "_id": 0},
        ).sort("last_accessed_at", -1).limit(30)
        async for d in cur:
            w = (d.get("word") or "").strip()
            if w:
                recent_words.append(w)
    except Exception as exc:  # noqa: BLE001
        log.debug("slp: recent words failed: %s", exc)
    # Recent sentences.
    recent_sentences: list[str] = []
    try:
        cur = db[COL_SENTENCES].find(
            {"student_id": student.clean_id},
            {"sentence_text": 1, "_id": 0},
        ).sort("created_at", -1).limit(10)
        async for d in cur:
            s = (d.get("sentence_text") or "").strip()
            if s:
                recent_sentences.append(s[:240])
    except Exception as exc:  # noqa: BLE001
        log.debug("slp: recent sentences failed: %s", exc)
    # Progress on this book.
    progress = None
    try:
        progress = await db[COL_CHAPTER_PROGRESS].find_one(
            {"student_id": student.clean_id, "book_slug": book_slug},
            sort=[("last_active_at", -1)],
        )
    except Exception as exc:  # noqa: BLE001
        log.debug("slp: progress lookup failed: %s", exc)

    weaknesses = slp.get("weaknesses") or {}
    top3 = sorted(weaknesses.items(), key=lambda kv: -int(kv[1] or 0))[:3]
    return {
        "student_name": (student.full_name if getattr(student, "full_name", None) else "")[:60],
        "implicit_level": slp.get("implicit_level") or "beginner",
        "language_pref": slp.get("language_pref") or "kh-en",
        "streak_days": int(slp.get("streak_days") or 0),
        "words_saved_total": int(slp.get("words_saved_total") or 0),
        "sentences_saved_total": int(slp.get("sentences_saved_total") or 0),
        "chapters_completed_total": int(slp.get("chapters_completed_total") or 0),
        "recent_words": recent_words,
        "recent_sentences": recent_sentences,
        "top_weaknesses": [k for k, _ in top3 if int(weaknesses.get(k) or 0) > 0],
        "book_slug": book_slug,
        "chapter_idx": int(chapter_idx) if chapter_idx is not None else -1,
        "paragraph": (paragraph or "")[:1200],
        "progress_pct": int((progress or {}).get("progress_pct") or 0),
        "week_start": week_start_str(),
    }


# --------------------------------------------------------------------------- #
# Route registration                                                          #
# --------------------------------------------------------------------------- #
def register_slp_routes(api: APIRouter, db, require_admin, require_student) -> None:
    _ = require_admin

    @api.get("/student/slp")
    async def student_get_slp(student=Depends(require_student)):
        slp = await get_or_init_slp(db, student.clean_id)
        slp.pop("_id", None)
        return {"success": True, "slp": slp}

    @api.post("/student/slp/touch")
    async def student_touch_active(
        payload: dict | None = None, student=Depends(require_student),
    ):
        _ = payload
        await touch_active_day(db, student.clean_id)
        slp = await get_or_init_slp(db, student.clean_id)
        return {"success": True, "streak_days": int(slp.get("streak_days") or 0),
                "last_active_day": slp.get("last_active_day") or ""}

    @api.post("/student/coach-briefing")
    async def student_coach_briefing(payload: dict, student=Depends(require_student)):
        if not isinstance(payload, dict):
            raise HTTPException(400, "Body must be JSON.")
        book_slug = (payload.get("book_slug") or "").strip()
        chapter_idx = int(payload.get("chapter_idx") or -1)
        env = await build_context_envelope(
            db, student=student, book_slug=book_slug, chapter_idx=chapter_idx,
        )
        # Deterministic template — no LLM call here. Premium tier can opt-in
        # to a Gemini-greeting overlay via a separate paid path (not on book
        # open).
        student_name = env["student_name"] or "student"
        progress_pct = env["progress_pct"]
        words_total = env["words_saved_total"]
        streak = env["streak_days"]
        lines: list[str] = []
        if progress_pct > 0:
            lines.append(f"Welcome back {student_name}.")
            lines.append(f"You're {progress_pct}% through this book.")
        else:
            lines.append(f"Welcome to this book, {student_name}.")
        if words_total > 0:
            lines.append(f"You've saved {words_total} words across your library.")
        if streak >= 2:
            lines.append(f"Streak: {streak} days strong.")
        if chapter_idx >= 0:
            lines.append(f"Today: chapter {chapter_idx + 1}.")
        return {
            "success": True,
            "briefing": " ".join(lines)[:480],
            "envelope": env,
        }

    log.info("coach_pack: SLP routes registered")
