"""roleplay_tools.py — EduHub Coach Pack v3: AI Roleplay (Limited only, hard-capped).

Routes:
  POST /api/student/roleplay/start     debit + book-seeded session start
  POST /api/student/roleplay/message   per-message reply (cap-bounded)
  GET  /api/student/roleplay/sessions  history

Strict gates (ALL admin-tunable):
  - tier == limited_edition
  - roleplay_enabled True
  - sessions/day <= roleplay_sessions_per_day (default 2)
  - messages/session <= roleplay_msgs_per_session (default 20)
  - debit roleplay_session_cost (default 6) on session start
  - daily AI ceiling enforced separately on session start

Isolation:
  - Does NOT write to edutalk_audio_cache, edutalk_audio_entitlements,
    points_history (except via _gas_debit), wallets, payment collections.
  - Does NOT consume EduTalk reply quota.
"""
from __future__ import annotations

import logging
from uuid import uuid4

from fastapi import APIRouter, Depends, HTTPException

from coach_pack_shared import (
    COL_ROLEPLAY_SESSIONS, COL_ROLEPLAY_MESSAGES, COL_ROLEPLAY_DAILY,
    TIER_LIMITED, get_tier_block, get_flag, get_int,
    iso_now, today_str, call_gemini_json, audit_log,
    increment_daily_usage, get_daily_usage, _gas_helpers,
)
from student_learning_profile_tools import build_context_envelope, get_or_init_slp

log = logging.getLogger("eduhub.coach_pack.roleplay")

MAX_BODY_CHARS = 1200


def register_roleplay_routes(api: APIRouter, db, require_admin, require_student) -> None:
    _ = require_admin

    @api.post("/student/roleplay/start")
    async def roleplay_start(payload: dict, student=Depends(require_student)):
        if not isinstance(payload, dict):
            raise HTTPException(400, "Body must be JSON.")
        password = (payload.get("password") or "").strip()
        book_slug = (payload.get("book_slug") or "").strip()[:200]
        book_title = (payload.get("book_title") or "").strip()[:200]
        chapter_idx = int(payload.get("chapter_idx") or -1)
        chapter_theme = (payload.get("chapter_theme") or "").strip()[:240]
        scenario = (payload.get("scenario") or "").strip()[:240]

        tier = (getattr(student, "tier", None) or "standard").lower()
        if tier != TIER_LIMITED:
            raise HTTPException(423, "Roleplay is a Limited tier feature.")
        cfg = await get_tier_block(db, tier)
        if not get_flag(cfg, "roleplay_enabled", default=True):
            raise HTTPException(423, "Roleplay is currently disabled.")
        sess_cap = get_int(cfg, "roleplay_sessions_per_day", default=2, max_value=10)
        msg_cap = get_int(cfg, "roleplay_msgs_per_session", default=20, max_value=200)
        session_cost = get_int(cfg, "roleplay_session_cost", default=6, max_value=100)

        # Daily session cap.
        day = today_str()
        usage = await db[COL_ROLEPLAY_DAILY].find_one(
            {"student_id": student.clean_id, "day": day},
        ) or {"sessions": 0}
        if int(usage.get("sessions") or 0) >= sess_cap:
            return {"success": False, "error": "roleplay_daily_cap",
                    "message": "Great practice today. Come back tomorrow to continue your roleplay journey.",
                    "sessions_cap": sess_cap}

        # Daily AI ceiling check BEFORE debit.
        ai_ceiling = get_int(cfg, "daily_ai_point_ceiling", default=0, max_value=10000)
        ai_usage = await get_daily_usage(db, student.clean_id)
        if ai_ceiling <= 0 or ai_usage["total_points"] + session_cost > ai_ceiling:
            return {"success": False, "error": "daily_limit_reached",
                    "message": "You've completed a lot of AI practice today. "
                               "Come back tomorrow to continue your coach journey.",
                    "ceiling": ai_ceiling, "current_total": ai_usage["total_points"]}

        # Debit session cost.
        _gas_debit, _ = _gas_helpers()
        if session_cost > 0:
            if _gas_debit is None or not password:
                raise HTTPException(400, "password required.")
            ok, err = await _gas_debit(student.clean_id, password, session_cost)
            if not ok:
                err_lc = (err or "").lower()
                if "insufficient" in err_lc or "balance" in err_lc:
                    return {"success": False, "error": "insufficient_points",
                            "required_points": session_cost,
                            "message": "Not enough points to start Roleplay."}
                return {"success": False, "error": "internal_error",
                        "message": (err or "Could not start Roleplay.")[:160]}

        # Prepare session.
        env = await build_context_envelope(
            db, student=student, book_slug=book_slug, chapter_idx=chapter_idx,
        )
        session_id = uuid4().hex[:24]
        seed_prompt = _build_seed_prompt(env, book_title, chapter_theme, scenario)
        try:
            first_reply = await call_gemini_json(
                seed_prompt + _open_turn_prompt(), max_output_chars=2000,
            )
        except Exception as exc:  # noqa: BLE001
            # Refund + surface ai_unavailable.
            if session_cost > 0 and _gas_debit is not None:
                try:
                    await _gas_debit(student.clean_id, password, -session_cost)
                except Exception:  # noqa: BLE001
                    pass
            await audit_log(db, feature="roleplay", event="start_failed",
                            student_id=student.clean_id, error=str(exc)[:160])
            return {"success": False, "error": "ai_unavailable",
                    "message": "Try again in a moment — no points charged."}

        # Persist session + daily usage + AI ceiling increment + first message.
        try:
            await db[COL_ROLEPLAY_SESSIONS].insert_one({
                "session_id": session_id,
                "student_id": student.clean_id,
                "day": day,
                "tier": tier,
                "book_slug": book_slug,
                "book_title": book_title,
                "chapter_idx": chapter_idx,
                "chapter_theme": chapter_theme,
                "scenario": scenario,
                "msg_cap": msg_cap,
                "msg_count": 1,
                "closed": False,
                "created_at": iso_now(),
                "last_active_at": iso_now(),
                "seed": _seed_metadata(env),
            })
            await db[COL_ROLEPLAY_MESSAGES].insert_one({
                "session_id": session_id,
                "message_idx": 0,
                "role": "assistant",
                "content": str(first_reply.get("reply") or "")[:MAX_BODY_CHARS],
                "scene_note": str(first_reply.get("scene_note") or "")[:200],
                "created_at": iso_now(),
            })
            await db[COL_ROLEPLAY_DAILY].update_one(
                {"student_id": student.clean_id, "day": day},
                {"$inc": {"sessions": 1},
                 "$setOnInsert": {"created_at": iso_now()}},
                upsert=True,
            )
        except Exception as exc:  # noqa: BLE001
            log.warning("roleplay: persist failed: %s", exc)

        await increment_daily_usage(db, student.clean_id, session_cost)
        await audit_log(db, feature="roleplay", event="start_ok",
                        student_id=student.clean_id, cost=session_cost)

        return {
            "success": True,
            "session_id": session_id,
            "msg_cap": msg_cap,
            "sessions_cap": sess_cap,
            "points_charged": session_cost,
            "first_message": {
                "message_idx": 0,
                "role": "assistant",
                "content": str(first_reply.get("reply") or "")[:MAX_BODY_CHARS],
                "scene_note": str(first_reply.get("scene_note") or "")[:200],
            },
        }

    @api.post("/student/roleplay/message")
    async def roleplay_message(payload: dict, student=Depends(require_student)):
        if not isinstance(payload, dict):
            raise HTTPException(400, "Body must be JSON.")
        session_id = (payload.get("session_id") or "").strip()[:32]
        user_text = (payload.get("text") or "").strip()[:MAX_BODY_CHARS]
        if not session_id or not user_text:
            raise HTTPException(400, "session_id + text required.")

        sess = await db[COL_ROLEPLAY_SESSIONS].find_one({
            "session_id": session_id, "student_id": student.clean_id,
        })
        if not sess:
            raise HTTPException(404, "Session not found.")
        if sess.get("closed"):
            return {"success": False, "error": "session_closed",
                    "message": "Great practice today. Come back tomorrow."}
        msg_cap = int(sess.get("msg_cap") or 20)
        msg_count = int(sess.get("msg_count") or 0)
        if msg_count >= msg_cap:
            await db[COL_ROLEPLAY_SESSIONS].update_one(
                {"session_id": session_id},
                {"$set": {"closed": True, "closed_at": iso_now()}},
            )
            return {"success": False, "error": "session_cap_reached",
                    "message": "Great session! Come back tomorrow for more.",
                    "msg_cap": msg_cap}

        # Persist user message.
        next_idx = msg_count
        try:
            await db[COL_ROLEPLAY_MESSAGES].insert_one({
                "session_id": session_id,
                "message_idx": next_idx,
                "role": "user",
                "content": user_text,
                "created_at": iso_now(),
            })
        except Exception as exc:  # noqa: BLE001
            log.warning("roleplay: user msg insert failed: %s", exc)

        # Build reply prompt from last 8 turns.
        history: list[dict] = []
        try:
            cur = db[COL_ROLEPLAY_MESSAGES].find(
                {"session_id": session_id},
                {"_id": 0},
            ).sort("message_idx", 1)
            async for d in cur:
                history.append(d)
        except Exception as exc:  # noqa: BLE001
            log.debug("roleplay: history read failed: %s", exc)
        history = history[-8:]

        env_short = sess.get("seed") or {}
        prompt = _build_seed_prompt_from_meta(env_short, sess) + _reply_turn_prompt(history)
        try:
            reply = await call_gemini_json(prompt, max_output_chars=2000)
        except Exception as exc:  # noqa: BLE001
            await audit_log(db, feature="roleplay", event="message_failed",
                            student_id=student.clean_id, error=str(exc)[:160])
            return {"success": False, "error": "ai_unavailable",
                    "message": "Try again in a moment."}

        # Persist assistant reply.
        try:
            await db[COL_ROLEPLAY_MESSAGES].insert_one({
                "session_id": session_id,
                "message_idx": next_idx + 1,
                "role": "assistant",
                "content": str(reply.get("reply") or "")[:MAX_BODY_CHARS],
                "correction": str(reply.get("correction") or "")[:240],
                "created_at": iso_now(),
            })
            await db[COL_ROLEPLAY_SESSIONS].update_one(
                {"session_id": session_id},
                {"$inc": {"msg_count": 2},
                 "$set": {"last_active_at": iso_now()}},
            )
        except Exception as exc:  # noqa: BLE001
            log.warning("roleplay: assistant msg insert failed: %s", exc)

        return {
            "success": True,
            "message": {
                "message_idx": next_idx + 1,
                "role": "assistant",
                "content": str(reply.get("reply") or "")[:MAX_BODY_CHARS],
                "correction": str(reply.get("correction") or "")[:240],
            },
            "msg_count": msg_count + 2,
            "msg_cap": msg_cap,
        }

    @api.get("/student/roleplay/sessions")
    async def roleplay_sessions(limit: int = 10, student=Depends(require_student)):
        limit = max(1, min(int(limit or 10), 50))
        out: list[dict] = []
        try:
            cur = db[COL_ROLEPLAY_SESSIONS].find(
                {"student_id": student.clean_id},
                {"_id": 0, "seed": 0},
            ).sort("created_at", -1).limit(limit)
            async for d in cur:
                out.append(d)
        except Exception as exc:  # noqa: BLE001
            log.warning("roleplay: sessions list failed: %s", exc)
        return {"success": True, "items": out, "count": len(out)}

    log.info("coach_pack: Roleplay routes registered")


# --------------------------------------------------------------------------- #
# Prompt builders                                                             #
# --------------------------------------------------------------------------- #
def _seed_metadata(env: dict) -> dict:
    return {
        "implicit_level": env.get("implicit_level"),
        "language_pref": env.get("language_pref"),
        "recent_words": env.get("recent_words", [])[:10],
        "top_weaknesses": env.get("top_weaknesses", []),
        "student_name": env.get("student_name", ""),
    }


def _build_seed_prompt(env: dict, book_title: str, chapter_theme: str,
                       scenario: str) -> str:
    lband = env.get("implicit_level") or "beginner"
    lpref = env.get("language_pref") or "kh-en"
    words = env.get("recent_words", [])[:8]
    weak = env.get("top_weaknesses", [])
    return (
        "You are an EduHub English roleplay coach for a Cambodian learner. "
        "Stay strictly in character for the scene. Speak warmly, gently. "
        "Use plain English at the student's level. "
        "When the student saves a word recently, naturally weave it into the scene.\n\n"
        f"Book: {book_title}\nChapter theme: {chapter_theme}\nScenario: {scenario or 'Real-life conversation relevant to the chapter theme.'}\n"
        f"Student level: {lband}\nLanguage preference: {lpref}\n"
        f"Recent saved words: {words}\n"
        f"Top weaknesses (soft correct gently AFTER the student replies): {weak}\n\n"
        "Always return a JSON object only — no prose, no markdown.\n"
    )


def _build_seed_prompt_from_meta(meta: dict, sess: dict) -> str:
    return _build_seed_prompt(
        meta or {},
        sess.get("book_title") or "",
        sess.get("chapter_theme") or "",
        sess.get("scenario") or "",
    )


def _open_turn_prompt() -> str:
    return (
        "Open the scene with one short paragraph (2-3 sentences) that sets the scene "
        "and asks the student ONE simple question they can answer.\n"
        "Return JSON: {\"reply\": \"...\", \"scene_note\": \"1 line scene description\"}\n"
    )


def _reply_turn_prompt(history: list[dict]) -> str:
    lines = []
    for h in history:
        role = h.get("role", "user")
        c = (h.get("content") or "")[:300]
        lines.append(f"{role.upper()}: {c}")
    convo = "\n".join(lines)
    return (
        f"\nConversation so far:\n{convo}\n\n"
        "Continue the scene in character. Keep your reply to 1-3 sentences. "
        "Then, ONLY if the student's last reply had a clear grammar mistake, add a "
        "very gentle one-line correction in `correction` (otherwise leave empty).\n"
        "Return JSON: {\"reply\": \"...\", \"correction\": \"\"}\n"
    )
