"""weakness_map_tools.py — EduHub Coach Pack v3: Weakness Map.

Routes:
  GET  /api/student/weakness-map           static aggregate (Premium+)
  POST /api/student/weakness-map/diagnose  Limited, weekly, cached

This feature is safe-disabled by default via `weakness_map_enabled` flag.
"""
from __future__ import annotations

import logging

from fastapi import APIRouter, Depends, HTTPException

from coach_pack_shared import (
    COL_WEAKNESS_CACHE, COL_QUIZ_ATTEMPTS,
    TIER_LIMITED, get_tier_block, get_flag, get_int,
    content_hash, iso_now, week_start_str, paid_action, call_gemini_json,
    level_band, lang_pref,
)
from student_learning_profile_tools import build_context_envelope, get_or_init_slp

log = logging.getLogger("eduhub.coach_pack.weakness")


async def _aggregate_weaknesses(db, student_id: str) -> dict[str, int]:
    out = {"grammar": 0, "vocabulary": 0, "comprehension": 0,
           "tone": 0, "pronunciation": 0}
    try:
        cur = db[COL_QUIZ_ATTEMPTS].find(
            {"student_id": student_id},
            {"details": 1, "_id": 0},
        ).sort("created_at", -1).limit(20)
        async for d in cur:
            for det in (d.get("details") or [])[:10]:
                if det.get("correct"):
                    continue
                tag = (det.get("weakness_tag") or "").strip().lower()
                if tag in out:
                    out[tag] += 1
    except Exception as exc:  # noqa: BLE001
        log.debug("weakness: aggregate failed: %s", exc)
    return out


def register_weakness_routes(api: APIRouter, db, require_admin, require_student) -> None:
    _ = require_admin

    @api.get("/student/weakness-map")
    async def weakness_map(student=Depends(require_student)):
        tier = (getattr(student, "tier", None) or "standard").lower()
        cfg = await get_tier_block(db, tier)
        if not get_flag(cfg, "weakness_map_enabled", default=False):
            return {"success": True, "enabled": False,
                    "message": "Weakness Map will unlock after more reading data.",
                    "dials": {}}
        dials = await _aggregate_weaknesses(db, student.clean_id)
        return {"success": True, "enabled": True, "dials": dials,
                "tier": tier}

    @api.post("/student/weakness-map/diagnose")
    async def weakness_diagnose(payload: dict, student=Depends(require_student)):
        if not isinstance(payload, dict):
            raise HTTPException(400, "Body must be JSON.")
        password = (payload.get("password") or "").strip()
        tier = (getattr(student, "tier", None) or "standard").lower()
        if tier != TIER_LIMITED:
            raise HTTPException(423, "Weekly Diagnosis is a Limited tier feature.")
        cfg = await get_tier_block(db, tier)
        if not get_flag(cfg, "weakness_map_enabled", default=False):
            raise HTTPException(423, "Weakness Map disabled by admin.")
        cost = get_int(cfg, "weakness_diagnosis_cost", default=4, max_value=50)
        if cost > 0 and not password:
            raise HTTPException(400, "password required.")

        slp = await get_or_init_slp(db, student.clean_id)
        lband = level_band(slp)
        lpref = lang_pref(slp)
        ch = content_hash(
            feature="weakness_diagnosis",
            parts={"week_start": week_start_str(), "level_band": lband, "lang_pref": lpref},
            personalised_for=student.clean_id,
        )

        async def _llm():
            dials = await _aggregate_weaknesses(db, student.clean_id)
            env = await build_context_envelope(
                db, student=student, book_slug=slp.get("last_book_slug") or "",
            )
            prompt = (
                "You are a personal English coach. Return a JSON object only.\n"
                f"Student level: {lband}\nLanguage: {lpref}\n"
                f"Weakness dials (count of wrong answers in last 20 attempts): {dials}\n"
                f"Top weaknesses: {env.get('top_weaknesses', [])}\n"
                f"Recent saved words: {env.get('recent_words', [])[:8]}\n\n"
                "Return:\n"
                "{\n"
                '  "diagnosis": "2-3 sentence diagnosis in friendly tone",\n'
                '  "priority": "grammar|vocabulary|comprehension|tone|pronunciation",\n'
                '  "next_actions": ["1 short action", "1 short action", "1 short action"]\n'
                "}\n"
            )
            data = await call_gemini_json(prompt)
            return {
                "diagnosis": str(data.get("diagnosis") or "")[:600],
                "priority": str(data.get("priority") or "grammar")[:32],
                "next_actions": [str(x)[:140] for x in (data.get("next_actions") or [])[:5]],
                "dials": dials,
                "week_start": week_start_str(),
            }

        return await paid_action(
            db=db, student=student, password=password,
            feature_key="weakness_diagnosis", cost=cost, tier_cfg=cfg,
            ceiling_check=True,
            cache_col=COL_WEAKNESS_CACHE, ent_col=None, ch=ch,
            is_personalized=True,
            cache_meta={"week_start": week_start_str(), "student_id": student.clean_id},
            ent_meta=None,
            llm_call=_llm,
        )

    log.info("coach_pack: Weakness Map routes registered")
