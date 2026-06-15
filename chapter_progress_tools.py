"""chapter_progress_tools.py — EduHub Coach Pack v3.

Progress + Streak + Completion Celebration + Badges + Weekly Report + Continue card.

Routes:
  GET  /api/student/progress/{book_slug}
  POST /api/student/progress/complete-chapter
  GET  /api/student/badges
  GET  /api/student/weekly-report                (safe-disabled by default)
  GET  /api/student/continue-card                (single most-relevant next action)
"""
from __future__ import annotations

import logging
from uuid import uuid4

from fastapi import APIRouter, Depends, HTTPException

from coach_pack_shared import (
    COL_CHAPTER_PROGRESS, COL_BADGES, COL_VOCAB, COL_SENTENCES,
    TIER_LIMITED, get_tier_block, get_flag, get_int,
    iso_now, today_str, week_start_str,
)
from student_learning_profile_tools import (
    get_or_init_slp, update_slp, touch_active_day, build_context_envelope,
)

log = logging.getLogger("eduhub.coach_pack.progress")


def register_progress_routes(api: APIRouter, db, require_admin, require_student) -> None:
    _ = require_admin

    @api.get("/student/progress/{book_slug}")
    async def progress_get(book_slug: str, student=Depends(require_student)):
        book_slug = (book_slug or "").strip()[:200]
        items: list[dict] = []
        try:
            cur = db[COL_CHAPTER_PROGRESS].find(
                {"student_id": student.clean_id, "book_slug": book_slug},
                {"_id": 0},
            ).sort("chapter_idx", 1)
            async for d in cur:
                items.append(d)
        except Exception as exc:  # noqa: BLE001
            log.warning("progress: get failed: %s", exc)
        completed = [it for it in items if it.get("completed")]
        return {"success": True, "items": items, "completed_count": len(completed)}

    @api.post("/student/progress/complete-chapter")
    async def complete_chapter(payload: dict, student=Depends(require_student)):
        if not isinstance(payload, dict):
            raise HTTPException(400, "Body must be JSON.")
        book_slug = (payload.get("book_slug") or "").strip()[:200]
        chapter_idx = int(payload.get("chapter_idx") or -1)
        total_chapters = int(payload.get("total_chapters") or 0)
        if not book_slug or chapter_idx < 0:
            raise HTTPException(400, "book_slug + chapter_idx required.")

        # Compute deltas BEFORE update.
        try:
            existing = await db[COL_CHAPTER_PROGRESS].find_one({
                "student_id": student.clean_id, "book_slug": book_slug,
                "chapter_idx": chapter_idx,
            })
        except Exception:  # noqa: BLE001
            existing = None
        first_time = not (existing and existing.get("completed"))

        progress_pct = 0
        if total_chapters > 0:
            progress_pct = int(round((chapter_idx + 1) / total_chapters * 100))
            progress_pct = max(0, min(progress_pct, 100))

        # Upsert progress row.
        try:
            await db[COL_CHAPTER_PROGRESS].update_one(
                {"student_id": student.clean_id, "book_slug": book_slug,
                 "chapter_idx": chapter_idx},
                {
                    "$set": {
                        "completed": True,
                        "completed_at": iso_now(),
                        "last_active_at": iso_now(),
                        "progress_pct": progress_pct,
                        "total_chapters": total_chapters,
                    },
                    "$setOnInsert": {
                        "student_id": student.clean_id,
                        "book_slug": book_slug,
                        "chapter_idx": chapter_idx,
                        "created_at": iso_now(),
                    },
                    "$inc": {"open_count": 1} if first_time else {},
                },
                upsert=True,
            )
        except Exception as exc:  # noqa: BLE001
            log.warning("progress: complete failed: %s", exc)

        if first_time:
            await update_slp(db, student.clean_id, set_fields={
                "last_book_slug": book_slug,
                "last_chapter_idx": chapter_idx,
            }, inc_fields={"chapters_completed_total": 1})
        await touch_active_day(db, student.clean_id)

        # Chapter stats for the celebration card.
        words_saved = 0
        sentences_saved = 0
        try:
            words_saved = await db[COL_VOCAB].count_documents({
                "student_id": student.clean_id, "book_slug": book_slug,
                "chapter_idx": chapter_idx,
            })
            sentences_saved = await db[COL_SENTENCES].count_documents({
                "student_id": student.clean_id, "book_slug": book_slug,
                "chapter_idx": chapter_idx,
            })
        except Exception:  # noqa: BLE001
            pass

        slp = await get_or_init_slp(db, student.clean_id)
        tier = (getattr(student, "tier", None) or "standard").lower()
        cfg = await get_tier_block(db, tier)

        # Award badge on book completion (Limited tier only, when flag ON).
        badge = None
        if (
            tier == TIER_LIMITED
            and get_flag(cfg, "completion_badge_enabled", default=True)
            and total_chapters > 0
            and chapter_idx + 1 == total_chapters
            and first_time
        ):
            badge_id = uuid4().hex[:16]
            badge = {
                "badge_id": badge_id,
                "student_id": student.clean_id,
                "book_slug": book_slug,
                "earned_at": iso_now(),
                "kind": "book_complete_gold",
                "label": "Book Complete",
            }
            try:
                await db[COL_BADGES].update_one(
                    {"student_id": student.clean_id, "badge_id": badge_id},
                    {"$setOnInsert": badge},
                    upsert=True,
                )
            except Exception as exc:  # noqa: BLE001
                log.warning("progress: badge insert failed: %s", exc)

        return {
            "success": True,
            "first_time": first_time,
            "progress_pct": progress_pct,
            "streak_days": int(slp.get("streak_days") or 0),
            "words_saved_this_chapter": words_saved,
            "sentences_saved_this_chapter": sentences_saved,
            "tier": tier,
            "badge": badge,
        }

    @api.get("/student/badges")
    async def badges_list(student=Depends(require_student)):
        out: list[dict] = []
        try:
            cur = db[COL_BADGES].find(
                {"student_id": student.clean_id},
                {"_id": 0},
            ).sort("earned_at", -1).limit(60)
            async for d in cur:
                out.append(d)
        except Exception as exc:  # noqa: BLE001
            log.warning("progress: badges list failed: %s", exc)
        return {"success": True, "items": out, "count": len(out)}

    @api.get("/student/weekly-report")
    async def weekly_report(student=Depends(require_student)):
        tier = (getattr(student, "tier", None) or "standard").lower()
        cfg = await get_tier_block(db, tier)
        if not get_flag(cfg, "weekly_report_enabled", default=False):
            return {"success": True, "enabled": False,
                    "message": "Weekly Report unlocks once you have a week of activity.",
                    "report": None}
        # Pure SLP/aggregate read — no LLM call (per cost-control rule 7).
        slp = await get_or_init_slp(db, student.clean_id)
        try:
            words_this_week = await db[COL_VOCAB].count_documents({
                "student_id": student.clean_id,
                "created_at": {"$gte": week_start_str() + "T00:00:00+00:00"},
            })
            sentences_this_week = await db[COL_SENTENCES].count_documents({
                "student_id": student.clean_id,
                "created_at": {"$gte": week_start_str() + "T00:00:00+00:00"},
            })
            chapters_this_week = await db[COL_CHAPTER_PROGRESS].count_documents({
                "student_id": student.clean_id, "completed": True,
                "completed_at": {"$gte": week_start_str() + "T00:00:00+00:00"},
            })
        except Exception:  # noqa: BLE001
            words_this_week = sentences_this_week = chapters_this_week = 0
        return {
            "success": True, "enabled": True,
            "report": {
                "week_start": week_start_str(),
                "words_this_week": words_this_week,
                "sentences_this_week": sentences_this_week,
                "chapters_this_week": chapters_this_week,
                "streak_days": int(slp.get("streak_days") or 0),
                "encouragement": _encouragement_line(slp, words_this_week, chapters_this_week),
            },
        }

    @api.get("/student/continue-card")
    async def continue_card(student=Depends(require_student)):
        slp = await get_or_init_slp(db, student.clean_id)
        last_book = (slp.get("last_book_slug") or "").strip()
        last_chapter = int(slp.get("last_chapter_idx") or -1)
        tier = (getattr(student, "tier", None) or "standard").lower()
        if not last_book:
            return {
                "success": True,
                "primary": {"label": "Pick a book from your library", "action": "open_library"},
                "alternatives": [],
            }
        next_chapter = last_chapter + 1
        primary = {
            "label": f"Continue chapter {next_chapter + 1}",
            "action": "open_chapter",
            "book_slug": last_book,
            "chapter_idx": next_chapter,
        }
        alternatives: list[dict] = []
        if tier == TIER_LIMITED:
            alternatives = [
                {"label": "Review yesterday's saved words",
                 "action": "open_word_bank",
                 "book_slug": last_book},
                {"label": "Re-read your last chapter",
                 "action": "open_chapter",
                 "book_slug": last_book,
                 "chapter_idx": max(0, last_chapter)},
            ]
        return {"success": True, "primary": primary, "alternatives": alternatives}

    log.info("coach_pack: Progress routes registered")


def _encouragement_line(slp: dict, words_this_week: int, chapters_this_week: int) -> str:
    if chapters_this_week >= 3:
        return "Strong week — keep that momentum into next week."
    if words_this_week >= 10:
        return "Your word bank is growing fast. Review them on Sunday."
    if int(slp.get("streak_days") or 0) >= 5:
        return "Your streak is impressive. One more chapter this week?"
    return "Every chapter you finish counts. Tomorrow is a fresh start."
