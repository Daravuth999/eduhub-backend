"""chapter_quiz_tools.py — EduHub Coach Pack v3: Adaptive Mini Quiz.

Routes:
  POST /api/student/quiz/start    returns N items selected from cached pool
  POST /api/student/quiz/submit   records attempt, returns feedback
  POST /api/student/quiz/retry    paid retry using free-retry-count first
"""
from __future__ import annotations

import logging
import random
from uuid import uuid4

from fastapi import APIRouter, Depends, HTTPException

from coach_pack_shared import (
    COL_QUIZZES, COL_QUIZ_ATTEMPTS,
    TIER_LIMITED, get_tier_block, get_flag, get_int,
    content_hash, iso_now, paid_action, call_gemini_json,
    level_band, lang_pref,
)
from student_learning_profile_tools import build_context_envelope, get_or_init_slp

log = logging.getLogger("eduhub.coach_pack.quiz")


def register_quiz_routes(api: APIRouter, db, require_admin, require_student) -> None:
    _ = require_admin

    @api.post("/student/quiz/start")
    async def quiz_start(payload: dict, student=Depends(require_student)):
        if not isinstance(payload, dict):
            raise HTTPException(400, "Body must be JSON.")
        book_slug = (payload.get("book_slug") or "").strip()[:200]
        chapter_idx = int(payload.get("chapter_idx") or -1)
        chapter_text = (payload.get("chapter_text") or "").strip()[:4000]
        password = (payload.get("password") or "").strip()
        if not book_slug or chapter_idx < 0:
            raise HTTPException(400, "book_slug + chapter_idx required.")

        tier = (getattr(student, "tier", None) or "standard").lower()
        cfg = await get_tier_block(db, tier)
        if not get_flag(cfg, "mini_quiz_enabled", default=False):
            raise HTTPException(423, "Mini Quiz locked on this tier.")
        cost = get_int(cfg, "mini_quiz_cost", default=3, max_value=50)
        n_items = get_int(cfg, "mini_quiz_items", default=3, max_value=10)
        if cost > 0 and not password:
            raise HTTPException(400, "password required.")

        slp = await get_or_init_slp(db, student.clean_id)
        lband = level_band(slp)
        lpref = lang_pref(slp)

        # Pool cache key shared across all students at same band.
        pool_ch = content_hash(
            feature="quiz_pool",
            parts={"book_slug": book_slug, "chapter_idx": chapter_idx,
                   "level_band": lband, "lang_pref": lpref},
            personalised_for=None,
        )

        async def _llm():
            env = await build_context_envelope(
                db, student=student, book_slug=book_slug, chapter_idx=chapter_idx,
                paragraph=chapter_text[:1500],
            )
            prompt = _build_quiz_prompt(chapter_text, env, n_items * 2)
            data = await call_gemini_json(prompt, max_output_chars=5000)
            items = data.get("items") or []
            # Defensive bound + shape clean-up.
            clean: list[dict] = []
            for it in items[:n_items * 2 + 4]:
                if not isinstance(it, dict):
                    continue
                q = (str(it.get("question") or "")).strip()
                choices = it.get("choices") or []
                ans = it.get("answer")
                if not q or not isinstance(choices, list) or len(choices) < 2:
                    continue
                clean.append({
                    "question": q[:240],
                    "choices": [str(c)[:120] for c in choices[:5]],
                    "answer": ans,
                    "explanation": str(it.get("explanation") or "")[:240],
                    "weakness_tag": str(it.get("weakness_tag") or "")[:40],
                })
            return {"items": clean}

        # paid_action wraps the generation; first generator pays, subsequent
        # generators hit the shared cache.
        result = await paid_action(
            db=db, student=student, password=password,
            feature_key="quiz_pool", cost=cost, tier_cfg=cfg,
            ceiling_check=True,
            cache_col=COL_QUIZZES, ent_col=None, ch=pool_ch,
            is_personalized=False,
            cache_meta={"book_slug": book_slug, "chapter_idx": chapter_idx,
                        "level_band": lband, "lang_pref": lpref},
            ent_meta=None,
            llm_call=_llm,
        )
        if not result.get("success"):
            return result
        pool = (result.get("payload") or {}).get("items") or []
        if not pool:
            return {"success": False, "error": "ai_unavailable",
                    "message": "Quiz unavailable today. Try again later."}

        # SLP-weighted selection: prefer items whose weakness_tag matches a
        # top weakness; otherwise random subset.
        weak = set((env := await build_context_envelope(
            db, student=student, book_slug=book_slug, chapter_idx=chapter_idx,
        )).get("top_weaknesses") or [])
        prioritised = [it for it in pool if (it.get("weakness_tag") or "") in weak]
        rest = [it for it in pool if (it.get("weakness_tag") or "") not in weak]
        random.shuffle(prioritised)
        random.shuffle(rest)
        selected = (prioritised + rest)[:n_items]

        quiz_id = uuid4().hex[:16]
        return {
            "success": True, "from": result.get("from"),
            "points_charged": result.get("points_charged", 0),
            "quiz_id": quiz_id, "items": selected,
            "content_hash": pool_ch,
            "n_items": len(selected),
        }

    @api.post("/student/quiz/submit")
    async def quiz_submit(payload: dict, student=Depends(require_student)):
        if not isinstance(payload, dict):
            raise HTTPException(400, "Body must be JSON.")
        quiz_id = (payload.get("quiz_id") or "").strip()[:32]
        if not quiz_id:
            raise HTTPException(400, "quiz_id required.")
        answers = payload.get("answers") or []
        items = payload.get("items") or []
        if not isinstance(answers, list) or not isinstance(items, list):
            raise HTTPException(400, "answers/items must be lists.")
        correct = 0
        details: list[dict] = []
        for i, it in enumerate(items[:10]):
            if not isinstance(it, dict):
                continue
            ans = answers[i] if i < len(answers) else None
            true_ans = it.get("answer")
            ok = (str(ans).strip().lower() == str(true_ans).strip().lower()) if true_ans is not None else False
            if ok:
                correct += 1
            details.append({
                "i": i, "correct": ok,
                "explanation": str(it.get("explanation") or "")[:240],
                "weakness_tag": str(it.get("weakness_tag") or "")[:40],
            })
        score_pct = int(round(correct / max(1, len(items)) * 100))
        try:
            await db[COL_QUIZ_ATTEMPTS].update_one(
                {"student_id": student.clean_id, "quiz_id": quiz_id, "attempt_idx": int(payload.get("attempt_idx") or 1)},
                {"$setOnInsert": {
                    "student_id": student.clean_id,
                    "quiz_id": quiz_id,
                    "attempt_idx": int(payload.get("attempt_idx") or 1),
                    "score_pct": score_pct,
                    "correct": correct,
                    "total": len(items),
                    "details": details,
                    "created_at": iso_now(),
                }},
                upsert=True,
            )
        except Exception as exc:  # noqa: BLE001
            log.warning("quiz: submit failed: %s", exc)
        return {"success": True, "score_pct": score_pct, "correct": correct,
                "total": len(items), "details": details}

    @api.post("/student/quiz/retry")
    async def quiz_retry(payload: dict, student=Depends(require_student)):
        if not isinstance(payload, dict):
            raise HTTPException(400, "Body must be JSON.")
        quiz_id = (payload.get("quiz_id") or "").strip()[:32]
        if not quiz_id:
            raise HTTPException(400, "quiz_id required.")
        tier = (getattr(student, "tier", None) or "standard").lower()
        cfg = await get_tier_block(db, tier)
        free_retries = get_int(cfg, "mini_quiz_free_retries", default=0, max_value=10)
        try:
            attempts = await db[COL_QUIZ_ATTEMPTS].count_documents({
                "student_id": student.clean_id, "quiz_id": quiz_id,
            })
        except Exception:  # noqa: BLE001
            attempts = 0
        # First N attempts beyond attempt 1 are free.
        if attempts <= free_retries:
            return {"success": True, "free_retry": True,
                    "next_attempt_idx": attempts + 1}
        # Beyond free retries — caller must restart via /quiz/start (paid).
        return {"success": False, "error": "retries_exhausted",
                "message": "Free retries used. Start a new quiz to continue.",
                "free_retries": free_retries}

    log.info("coach_pack: Quiz routes registered")


def _build_quiz_prompt(chapter_text: str, env: dict, n_items: int) -> str:
    lband = env.get("implicit_level", "beginner")
    lpref = env.get("language_pref", "kh-en")
    return (
        "You are an EduHub English quiz writer for Cambodian learners. "
        "Return a JSON object only — no prose, no markdown.\n"
        f"\nChapter text:\n\"\"\"\n{chapter_text[:3000]}\n\"\"\"\n"
        f"\nStudent level: {lband}\nLanguage: {lpref}\n"
        f"\nWrite {n_items} multiple-choice items mixed across grammar, vocabulary, "
        "comprehension, and tone. Each item must include a single correct answer.\n"
        "\nReturn JSON shape:\n"
        "{\n"
        '  "items": [\n'
        '    {\n'
        '      "question": "...",\n'
        '      "choices": ["A", "B", "C", "D"],\n'
        '      "answer": "A",\n'
        '      "explanation": "1 short line",\n'
        '      "weakness_tag": "grammar"  // grammar|vocabulary|comprehension|tone|pronunciation\n'
        '    }\n'
        "  ]\n"
        "}\n"
    )
