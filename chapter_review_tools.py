"""chapter_review_tools.py — EduHub Coach Pack v3: Personalised Chapter Review.

Routes:
  POST /api/student/chapter-review/generate     paid; cached + entitlement
  GET  /api/student/chapter-review/replay       free replay (entitlement)
"""
from __future__ import annotations

import logging

from fastapi import APIRouter, Depends, HTTPException

from coach_pack_shared import (
    COL_REVIEW_CACHE, COL_REVIEWS,
    TIER_LIMITED, get_tier_block, get_flag, get_int,
    content_hash, iso_now, paid_action, call_gemini_json,
    level_band, lang_pref,
)
from student_learning_profile_tools import build_context_envelope, get_or_init_slp

log = logging.getLogger("eduhub.coach_pack.review")


def register_chapter_review_routes(api: APIRouter, db, require_admin, require_student) -> None:
    _ = require_admin

    @api.post("/student/chapter-review/generate")
    async def review_generate(payload: dict, student=Depends(require_student)):
        if not isinstance(payload, dict):
            raise HTTPException(400, "Body must be JSON.")
        book_slug = (payload.get("book_slug") or "").strip()[:200]
        chapter_idx = int(payload.get("chapter_idx") or -1)
        chapter_text = (payload.get("chapter_text") or "").strip()[:6000]
        password = (payload.get("password") or "").strip()
        if not book_slug or chapter_idx < 0:
            raise HTTPException(400, "book_slug + chapter_idx required.")

        tier = (getattr(student, "tier", None) or "standard").lower()
        cfg = await get_tier_block(db, tier)
        if not get_flag(cfg, "chapter_review_enabled", default=False):
            raise HTTPException(423, "Chapter Review locked on this tier.")
        cost = get_int(cfg, "chapter_review_cost", default=3, max_value=50)
        sections_count = get_int(cfg, "chapter_review_sections", default=2, max_value=8)
        include_teacher = get_flag(cfg, "teacher_feedback_enabled", default=False)
        if cost > 0 and not password:
            raise HTTPException(400, "password required for paid action.")

        slp = await get_or_init_slp(db, student.clean_id)
        lband = level_band(slp)
        lpref = lang_pref(slp)
        ch = content_hash(
            feature="chapter_review",
            parts={"book_slug": book_slug, "chapter_idx": chapter_idx,
                   "level_band": lband, "lang_pref": lpref,
                   "sections": sections_count, "teacher": include_teacher},
            personalised_for=None,
        )

        async def _llm():
            env = await build_context_envelope(
                db, student=student, book_slug=book_slug, chapter_idx=chapter_idx,
                paragraph=chapter_text[:2000],
            )
            prompt = _build_review_prompt(chapter_text, env, sections_count, include_teacher)
            data = await call_gemini_json(prompt, max_output_chars=6000)
            return {
                "summary": str(data.get("summary") or "")[:600],
                "sections": (data.get("sections") or [])[:sections_count],
                "key_vocab": (data.get("key_vocab") or [])[:8],
                "teacher_note": str(data.get("teacher_note") or "")[:240] if include_teacher else "",
                "delta_commentary": str(data.get("delta_commentary") or "")[:240] if tier == TIER_LIMITED else "",
            }

        return await paid_action(
            db=db, student=student, password=password,
            feature_key="chapter_review", cost=cost, tier_cfg=cfg,
            ceiling_check=True,
            cache_col=COL_REVIEW_CACHE, ent_col=COL_REVIEWS, ch=ch,
            is_personalized=False,
            cache_meta={"book_slug": book_slug, "chapter_idx": chapter_idx,
                        "level_band": lband, "lang_pref": lpref,
                        "sections_count": sections_count},
            ent_meta={"book_slug": book_slug, "chapter_idx": chapter_idx},
            llm_call=_llm,
        )

    @api.get("/student/chapter-review/replay")
    async def review_replay(content_hash_q: str = "", student=Depends(require_student)):
        ch = (content_hash_q or "").strip()
        if not ch:
            raise HTTPException(400, "content_hash_q required.")
        # Confirm entitlement first.
        ent = await db[COL_REVIEWS].find_one(
            {"student_id": student.clean_id, "content_hash": ch},
        )
        if not ent:
            raise HTTPException(403, "Replay entitlement not found.")
        cache = await db[COL_REVIEW_CACHE].find_one({"content_hash": ch})
        if not cache or cache.get("payload") is None:
            raise HTTPException(404, "Cached review not found.")
        return {"success": True, "from": "entitlement_replay",
                "payload": cache["payload"], "points_charged": 0}

    log.info("coach_pack: Chapter Review routes registered")


def _build_review_prompt(chapter_text: str, env: dict, sections_count: int,
                         include_teacher: bool) -> str:
    lband = env.get("implicit_level", "beginner")
    lpref = env.get("language_pref", "kh-en")
    weak = env.get("top_weaknesses", [])
    base_sections = [
        "main_idea", "key_points", "vocabulary", "grammar_focus",
        "comprehension_questions", "real_world_application",
    ]
    keep = base_sections[:max(1, sections_count)]
    return (
        "You are an EduHub English chapter coach for Cambodian learners. "
        "Return a JSON object only — no markdown.\n"
        f"\nChapter text:\n\"\"\"\n{chapter_text[:4000]}\n\"\"\"\n"
        f"\nStudent level: {lband}\nLanguage preference: {lpref}\nWeaknesses: {weak}\n"
        f"\nReturn JSON shape:\n"
        "{\n"
        '  "summary": "2-3 sentences",\n'
        '  "sections": [\n'
        + ",\n".join(f'    {{"key":"{k}","title":"...","body":"..."}}' for k in keep)
        + "\n  ],\n"
        '  "key_vocab": [{"word":"...","khmer":"..."}, ...],\n'
        + ('  "teacher_note": "1 short personalised line",\n' if include_teacher else "")
        + '  "delta_commentary": "1 short line comparing to last chapter"\n'
        "}\n"
    )
