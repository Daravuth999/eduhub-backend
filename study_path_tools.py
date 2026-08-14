"""study_path_tools.py — EduHub Coach Pack v3: Personal Study Path.

Limited tier only. Safe-disabled by default via `study_path_enabled` flag.

Routes:
  GET  /api/student/study-path           current week's plan (read)
  POST /api/student/study-path/recompute Limited, weekly cap, paid
"""
from __future__ import annotations

import logging

from fastapi import APIRouter, Depends, HTTPException

from coach_pack_shared import (
    COL_STUDY_PATHS,
    TIER_LIMITED, get_tier_block, get_flag, get_int,
    content_hash, iso_now, week_start_str, paid_action, call_gemini_json,
    level_band, lang_pref,
)
from student_learning_profile_tools import build_context_envelope, get_or_init_slp

log = logging.getLogger("eduhub.coach_pack.study_path")


def register_study_path_routes(api: APIRouter, db, require_admin, require_student) -> None:
    _ = require_admin

    @api.get("/student/study-path")
    async def study_path_get(student=Depends(require_student)):
        tier = (getattr(student, "tier", None) or "standard").lower()
        cfg = await get_tier_block(db, tier)
        if not get_flag(cfg, "study_path_enabled", default=False):
            return {"success": True, "enabled": False,
                    "message": "Study Path will unlock soon.",
                    "plan": None}
        if tier != TIER_LIMITED:
            return {"success": True, "enabled": False,
                    "message": "Study Path is a Limited tier feature.",
                    "plan": None}
        doc = None
        try:
            doc = await db[COL_STUDY_PATHS].find_one(
                {"student_id": student.clean_id, "week_start": week_start_str()},
                {"_id": 0},
            )
        except Exception as exc:  # noqa: BLE001
            log.warning("study_path: read failed: %s", exc)
        return {"success": True, "enabled": True, "plan": doc}

    @api.post("/student/study-path/recompute")
    async def study_path_recompute(payload: dict, student=Depends(require_student)):
        if not isinstance(payload, dict):
            raise HTTPException(400, "Body must be JSON.")
        password = (payload.get("password") or "").strip()
        tier = (getattr(student, "tier", None) or "standard").lower()
        if tier != TIER_LIMITED:
            raise HTTPException(423, "Study Path is Limited only.")
        cfg = await get_tier_block(db, tier)
        if not get_flag(cfg, "study_path_enabled", default=False):
            raise HTTPException(423, "Study Path disabled by admin.")
        cost = get_int(cfg, "study_path_cost", default=4, max_value=50)
        if cost > 0 and not password:
            raise HTTPException(400, "password required.")

        slp = await get_or_init_slp(db, student.clean_id)
        lband = level_band(slp)
        lpref = lang_pref(slp)
        ch = content_hash(
            feature="study_path",
            parts={"week_start": week_start_str(), "level_band": lband, "lang_pref": lpref},
            personalised_for=student.clean_id,
        )

        async def _llm():
            env = await build_context_envelope(
                db, student=student, book_slug=slp.get("last_book_slug") or "",
            )
            prompt = (
                "You are a personal English coach. Build a 7-day study plan. "
                "Return a JSON object only.\n\n"
                f"Student level: {lband}\nLanguage: {lpref}\n"
                f"Streak: {env.get('streak_days')} days\n"
                f"Words saved: {env.get('words_saved_total')}\n"
                f"Top weaknesses: {env.get('top_weaknesses', [])}\n"
                f"Recent words: {env.get('recent_words', [])[:6]}\n\n"
                "Return:\n"
                "{\n"
                '  "days": [\n'
                '    {"day":"Mon","focus":"...","tasks":["1 short task","1 short task"]},\n'
                '    ... 7 entries ...\n'
                '  ],\n'
                '  "encouragement": "1 friendly line"\n'
                "}\n"
            )
            data = await call_gemini_json(prompt, max_output_chars=4000)
            return {
                "week_start": week_start_str(),
                "days": [d for d in (data.get("days") or [])[:7] if isinstance(d, dict)],
                "encouragement": str(data.get("encouragement") or "")[:200],
            }

        return await paid_action(
            db=db, student=student, password=password,
            feature_key="study_path", cost=cost, tier_cfg=cfg,
            ceiling_check=True,
            cache_col=COL_STUDY_PATHS, ent_col=None, ch=ch,
            is_personalized=True,
            cache_meta={"student_id": student.clean_id, "week_start": week_start_str()},
            ent_meta=None,
            llm_call=_llm,
        )

    log.info("coach_pack: Study Path routes registered")
