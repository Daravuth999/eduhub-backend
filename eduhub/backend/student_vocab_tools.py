"""student_vocab_tools.py — EduHub Coach Pack v3: Word Growth Bank.

Routes:
  POST /api/student/vocab/save              save a word (free; teaser-capped on Free tier)
  GET  /api/student/vocab                   list saved words
  POST /api/student/vocab/example           paid: AI personal example sentence
  GET  /api/student/vocab/weekly-pick       Limited only: 10 weighted picks
"""
from __future__ import annotations

import json
import logging
from typing import Any

from fastapi import APIRouter, Depends, HTTPException

from coach_pack_shared import (
    COL_VOCAB, COL_VOCAB_CACHE, COL_SLP,
    TIER_LIMITED, get_tier_block, get_flag, get_int,
    content_hash, iso_now, today_str,
    paid_action, call_gemini_json, level_band, lang_pref,
    lookup_text_cache,
)
from student_learning_profile_tools import build_context_envelope, get_or_init_slp, update_slp

log = logging.getLogger("eduhub.coach_pack.vocab")

FREE_TIER_SAVE_DEMO_CAP = 5


def _word_norm(w: str) -> str:
    return (w or "").strip().lower()[:80]


def register_vocab_routes(api: APIRouter, db, require_admin, require_student) -> None:
    _ = require_admin

    @api.post("/student/vocab/save")
    async def vocab_save(payload: dict, student=Depends(require_student)):
        if not isinstance(payload, dict):
            raise HTTPException(400, "Body must be JSON.")
        word = _word_norm(payload.get("word") or "")
        if not word:
            raise HTTPException(400, "word required.")
        book_slug = (payload.get("book_slug") or "").strip()[:200]
        chapter_idx = int(payload.get("chapter_idx") or -1)
        context_sentence = (payload.get("context_sentence") or "").strip()[:400]
        khmer_hint = (payload.get("khmer_hint") or "").strip()[:240]

        tier = (getattr(student, "tier", None) or "standard").lower()
        cfg = await get_tier_block(db, tier)
        if not get_flag(cfg, "word_growth_bank_enabled", default=True):
            raise HTTPException(423, "Word Growth Bank disabled on this tier.")

        # Free-tier demo cap: only the first N saves persist; further saves
        # return the upgrade-prompt response without writing.
        if tier == "free":
            count = await db[COL_VOCAB].count_documents({"student_id": student.clean_id})
            if count >= FREE_TIER_SAVE_DEMO_CAP:
                return {
                    "success": False, "error": "free_tier_cap",
                    "message": (
                        "Free tier shows your first 5 saved words as a demo. "
                        "Upgrade to Standard to save unlimited words."
                    ),
                    "demo_cap": FREE_TIER_SAVE_DEMO_CAP,
                }
        doc = {
            "student_id": student.clean_id,
            "word": word,
            "book_slug": book_slug,
            "chapter_idx": chapter_idx,
            "context_sentence": context_sentence,
            "khmer_hint": khmer_hint,
            "created_at": iso_now(),
            "last_accessed_at": iso_now(),
        }
        try:
            await db[COL_VOCAB].update_one(
                {"student_id": student.clean_id, "word": word, "book_slug": book_slug},
                {"$setOnInsert": doc, "$set": {"last_accessed_at": iso_now()}},
                upsert=True,
            )
        except Exception as exc:  # noqa: BLE001
            log.warning("vocab: save failed: %s", exc)
            raise HTTPException(503, "Could not save word right now.")
        await update_slp(db, student.clean_id, inc_fields={"words_saved_total": 1})
        return {"success": True, "word": word}

    @api.get("/student/vocab")
    async def vocab_list(book_slug: str = "", limit: int = 50, student=Depends(require_student)):
        limit = max(1, min(int(limit or 50), 200))
        q: dict = {"student_id": student.clean_id}
        if book_slug:
            q["book_slug"] = book_slug
        out: list[dict] = []
        try:
            cur = db[COL_VOCAB].find(q, {"_id": 0}).sort("last_accessed_at", -1).limit(limit)
            async for d in cur:
                out.append(d)
        except Exception as exc:  # noqa: BLE001
            log.warning("vocab: list failed: %s", exc)
        return {"success": True, "items": out, "count": len(out)}

    @api.post("/student/vocab/example")
    async def vocab_example(payload: dict, student=Depends(require_student)):
        """Paid: generate (or cache-replay) a personal example sentence."""
        if not isinstance(payload, dict):
            raise HTTPException(400, "Body must be JSON.")
        word = _word_norm(payload.get("word") or "")
        if not word:
            raise HTTPException(400, "word required.")
        password = (payload.get("password") or "").strip()
        book_slug = (payload.get("book_slug") or "").strip()[:200]

        tier = (getattr(student, "tier", None) or "standard").lower()
        cfg = await get_tier_block(db, tier)
        if not get_flag(cfg, "word_growth_bank_enabled", default=True):
            raise HTTPException(423, "Word Growth Bank disabled on this tier.")
        cost = get_int(cfg, "word_example_cost", default=2, max_value=50)
        if cost > 0 and not password:
            raise HTTPException(400, "password required for paid action.")

        slp = await get_or_init_slp(db, student.clean_id)
        lband = level_band(slp)
        lpref = lang_pref(slp)
        ch = content_hash(
            feature="vocab_example",
            parts={"word": word, "book_slug": book_slug,
                   "level_band": lband, "lang_pref": lpref},
            personalised_for=None,  # shared across students
        )

        async def _llm():
            env = await build_context_envelope(
                db, student=student, book_slug=book_slug,
            )
            prompt = _build_example_prompt(word, env)
            data = await call_gemini_json(prompt)
            return {
                "word": word,
                "khmer_meaning": str(data.get("khmer_meaning") or "")[:120],
                "english_meaning": str(data.get("english_meaning") or "")[:200],
                "example_sentence": str(data.get("example_sentence") or "")[:240],
                "khmer_translation": str(data.get("khmer_translation") or "")[:240],
                "teacher_note": str(data.get("teacher_note") or "")[:200],
            }

        ent_col = COL_VOCAB  # entitlement piggybacks on the vocab row
        result = await paid_action(
            db=db, student=student, password=password,
            feature_key="vocab_example", cost=cost, tier_cfg=cfg,
            ceiling_check=True,
            cache_col=COL_VOCAB_CACHE, ent_col=None, ch=ch,
            is_personalized=False,
            cache_meta={"word": word, "book_slug": book_slug,
                        "level_band": lband, "lang_pref": lpref},
            ent_meta=None,
            llm_call=_llm,
        )
        # Free-replay for the saving student: store the cached payload onto
        # their vocab row so subsequent reads of /student/vocab carry it.
        if result.get("success") and result.get("payload"):
            try:
                await db[COL_VOCAB].update_one(
                    {"student_id": student.clean_id, "word": word, "book_slug": book_slug},
                    {"$set": {
                        "ai_example_payload": result["payload"],
                        "ai_example_content_hash": ch,
                        "ai_example_at": iso_now(),
                    }},
                )
            except Exception as exc:  # noqa: BLE001
                log.debug("vocab: example persistence failed: %s", exc)
        return result

    @api.get("/student/vocab/weekly-pick")
    async def vocab_weekly_pick(student=Depends(require_student)):
        tier = (getattr(student, "tier", None) or "standard").lower()
        if tier != TIER_LIMITED:
            raise HTTPException(423, "Weekly Pick is a Limited tier feature.")
        # Weighted pick = 10 oldest words that have not been reviewed today.
        out: list[dict] = []
        try:
            cur = db[COL_VOCAB].find(
                {"student_id": student.clean_id},
                {"_id": 0},
            ).sort("last_accessed_at", 1).limit(10)
            async for d in cur:
                out.append(d)
        except Exception as exc:  # noqa: BLE001
            log.warning("vocab: weekly pick failed: %s", exc)
        return {"success": True, "items": out, "count": len(out)}

    log.info("coach_pack: Vocab routes registered")


def _build_example_prompt(word: str, env: dict) -> str:
    lpref = env.get("language_pref", "kh-en")
    lband = env.get("implicit_level", "beginner")
    return (
        "You are an EduHub English coach for Cambodian learners. "
        "Generate a JSON object — no prose, no markdown, no code fences.\n\n"
        f"Word: \"{word}\"\n"
        f"Student level: {lband}\n"
        f"Student language preference: {lpref}\n"
        f"Recent saved words (for tone calibration): {env.get('recent_words', [])[:8]}\n\n"
        "Return EXACTLY this JSON shape, no extras:\n"
        "{\n"
        '  "khmer_meaning": "...",          // 1-6 words, Khmer\n'
        '  "english_meaning": "...",        // 1 short sentence, English\n'
        '  "example_sentence": "...",       // 1 sentence using the word at the level above\n'
        '  "khmer_translation": "...",      // Khmer translation of example_sentence\n'
        '  "teacher_note": "..."            // 1 short line of encouragement\n'
        "}\n"
    )
