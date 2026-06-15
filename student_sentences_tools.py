"""student_sentences_tools.py — EduHub Coach Pack v3: Hard Sentences Coach.

Routes:
  POST /api/student/sentences/save
  GET  /api/student/sentences
  POST /api/student/sentences/rewrite         paid: Khmer + grammar + your-rewrite
  GET  /api/student/sentences/tomorrow-review Limited only
"""
from __future__ import annotations

import hashlib
import logging

from fastapi import APIRouter, Depends, HTTPException

from coach_pack_shared import (
    COL_SENTENCES, COL_SENT_CACHE,
    TIER_LIMITED, get_tier_block, get_flag, get_int,
    content_hash, iso_now, today_str, normalise_text,
    paid_action, call_gemini_json, level_band, lang_pref,
)
from student_learning_profile_tools import build_context_envelope, get_or_init_slp, update_slp

log = logging.getLogger("eduhub.coach_pack.sentences")


def _sentence_hash(text: str) -> str:
    return hashlib.sha256(normalise_text(text, 1200).encode("utf-8")).hexdigest()[:32]


def register_sentences_routes(api: APIRouter, db, require_admin, require_student) -> None:
    _ = require_admin

    @api.post("/student/sentences/save")
    async def sentences_save(payload: dict, student=Depends(require_student)):
        if not isinstance(payload, dict):
            raise HTTPException(400, "Body must be JSON.")
        text = (payload.get("sentence_text") or "").strip()
        if not text or len(text) < 6:
            raise HTTPException(400, "sentence_text too short.")
        text = text[:1200]
        book_slug = (payload.get("book_slug") or "").strip()[:200]
        chapter_idx = int(payload.get("chapter_idx") or -1)
        why_hard = (payload.get("why_hard") or "").strip()[:240]

        tier = (getattr(student, "tier", None) or "standard").lower()
        cfg = await get_tier_block(db, tier)
        if not get_flag(cfg, "hard_sentences_enabled", default=True):
            raise HTTPException(423, "Hard Sentences disabled on this tier.")

        s_hash = _sentence_hash(text)
        doc = {
            "student_id": student.clean_id,
            "sentence_hash": s_hash,
            "sentence_text": text,
            "book_slug": book_slug,
            "chapter_idx": chapter_idx,
            "why_hard": why_hard,
            "created_at": iso_now(),
            "last_accessed_at": iso_now(),
            "tomorrow_review_at": "",  # set on tier == limited only
        }
        if tier == TIER_LIMITED:
            doc["tomorrow_review_at"] = today_str()
        try:
            await db[COL_SENTENCES].update_one(
                {"student_id": student.clean_id, "sentence_hash": s_hash},
                {"$setOnInsert": doc, "$set": {"last_accessed_at": iso_now()}},
                upsert=True,
            )
        except Exception as exc:  # noqa: BLE001
            log.warning("sentences: save failed: %s", exc)
            raise HTTPException(503, "Could not save sentence right now.")
        await update_slp(db, student.clean_id, inc_fields={"sentences_saved_total": 1})
        return {"success": True, "sentence_hash": s_hash}

    @api.get("/student/sentences")
    async def sentences_list(book_slug: str = "", limit: int = 50,
                             student=Depends(require_student)):
        limit = max(1, min(int(limit or 50), 200))
        q: dict = {"student_id": student.clean_id}
        if book_slug:
            q["book_slug"] = book_slug
        out: list[dict] = []
        try:
            cur = db[COL_SENTENCES].find(q, {"_id": 0}).sort("created_at", -1).limit(limit)
            async for d in cur:
                out.append(d)
        except Exception as exc:  # noqa: BLE001
            log.warning("sentences: list failed: %s", exc)
        return {"success": True, "items": out, "count": len(out)}

    @api.post("/student/sentences/rewrite")
    async def sentences_rewrite(payload: dict, student=Depends(require_student)):
        if not isinstance(payload, dict):
            raise HTTPException(400, "Body must be JSON.")
        text = (payload.get("sentence_text") or "").strip()[:1200]
        if not text:
            raise HTTPException(400, "sentence_text required.")
        password = (payload.get("password") or "").strip()
        book_slug = (payload.get("book_slug") or "").strip()[:200]
        chapter_idx = int(payload.get("chapter_idx") or -1)

        tier = (getattr(student, "tier", None) or "standard").lower()
        cfg = await get_tier_block(db, tier)
        if not get_flag(cfg, "hard_sentences_enabled", default=True):
            raise HTTPException(423, "Hard Sentences disabled on this tier.")
        cost = get_int(cfg, "sentence_rewrite_cost", default=2, max_value=50)
        if cost > 0 and not password:
            raise HTTPException(400, "password required for paid action.")

        slp = await get_or_init_slp(db, student.clean_id)
        lband = level_band(slp)
        lpref = lang_pref(slp)
        s_hash = _sentence_hash(text)
        # Full rewrite payload depth depends on tier: Premium+ unlocks grammar.
        include_grammar = tier in ("premium", TIER_LIMITED)
        include_teacher = get_flag(cfg, "teacher_feedback_enabled", default=False)
        ch = content_hash(
            feature="sentence_rewrite",
            parts={"s": s_hash, "book_slug": book_slug, "chapter_idx": chapter_idx,
                   "level_band": lband, "lang_pref": lpref,
                   "g": include_grammar, "t": include_teacher},
            personalised_for=None,
        )

        async def _llm():
            env = await build_context_envelope(
                db, student=student, book_slug=book_slug,
                chapter_idx=chapter_idx, paragraph=text,
            )
            prompt = _build_rewrite_prompt(text, env, include_grammar, include_teacher)
            data = await call_gemini_json(prompt)
            return {
                "sentence_text": text,
                "khmer_translation": str(data.get("khmer_translation") or "")[:400],
                "easy_rewrite": str(data.get("easy_rewrite") or "")[:400],
                "grammar_panel": data.get("grammar_panel") or {} if include_grammar else {},
                "your_rewrite_prompt": str(data.get("your_rewrite_prompt") or "")[:200] if include_grammar else "",
                "teacher_note": str(data.get("teacher_note") or "")[:200] if include_teacher else "",
            }

        return await paid_action(
            db=db, student=student, password=password,
            feature_key="sentence_rewrite", cost=cost, tier_cfg=cfg,
            ceiling_check=True,
            cache_col=COL_SENT_CACHE, ent_col=None, ch=ch,
            is_personalized=False,
            cache_meta={"sentence_hash": s_hash, "level_band": lband, "lang_pref": lpref},
            ent_meta=None,
            llm_call=_llm,
        )

    @api.get("/student/sentences/tomorrow-review")
    async def tomorrow_review(student=Depends(require_student)):
        tier = (getattr(student, "tier", None) or "standard").lower()
        if tier != TIER_LIMITED:
            raise HTTPException(423, "Tomorrow Review is a Limited tier feature.")
        out: list[dict] = []
        try:
            cur = db[COL_SENTENCES].find(
                {"student_id": student.clean_id,
                 "tomorrow_review_at": {"$ne": "", "$lt": today_str()}},
                {"_id": 0},
            ).sort("tomorrow_review_at", -1).limit(20)
            async for d in cur:
                out.append(d)
        except Exception as exc:  # noqa: BLE001
            log.warning("sentences: tomorrow-review failed: %s", exc)
        return {"success": True, "items": out, "count": len(out)}

    log.info("coach_pack: Sentences routes registered")


def _build_rewrite_prompt(text: str, env: dict, include_grammar: bool,
                          include_teacher: bool) -> str:
    lpref = env.get("language_pref", "kh-en")
    lband = env.get("implicit_level", "beginner")
    parts = [
        "You are an EduHub English coach for Cambodian learners. "
        "Return a JSON object only — no prose, no markdown, no code fences.\n",
        f"Sentence: \"{text}\"",
        f"Student level: {lband}",
        f"Student language preference: {lpref}",
        f"Top weaknesses: {env.get('top_weaknesses', [])}",
        "",
        "Return EXACTLY this JSON shape:",
        "{",
        '  "khmer_translation": "...",',
        '  "easy_rewrite": "..."',
    ]
    if include_grammar:
        parts.append(",")
        parts.append('  "grammar_panel": {"subject":"...","verb":"...","tense":"...","note":"..."},')
        parts.append('  "your_rewrite_prompt": "Try rewriting this sentence using ..."')
    if include_teacher:
        parts.append(",")
        parts.append('  "teacher_note": "..."  // one short line of personalised encouragement')
    parts.append("}")
    return "\n".join(parts)
