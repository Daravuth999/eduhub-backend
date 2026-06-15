"""coach_pack_shared.py — EduHub Coach Pack v3 shared gateway.

ISOLATED, ADDITIVE MODULE. Zero side-effects on import.

Provides the single gate sequence every Coach Pack AI feature obeys:
  auth → tier → flag → entitlement → cache → daily_cap → cost → debit → LLM

Every Coach Pack module routes its Gemini calls through `paid_action(...)`
below so the v3 cost-control contract is enforced in one place, not nine.

Hard isolation contract:
  - Does NOT touch payment_*, wallet_*, ABA / KHQR / CamRapidPay.
  - Does NOT touch edutalk_audio_cache writes (read-only reuse of compute_content_hash).
  - Does NOT touch points_history writes directly — debits/refunds via _gas_debit
    (same helper EduTalk + Premium AI already use, imported lazily).
  - Failure-safe: any single failure short-circuits cleanly with no LLM hit
    and (where relevant) refunds the student.
"""
from __future__ import annotations

import asyncio
import hashlib
import json
import logging
import os
import re
from datetime import datetime, timezone, date
from typing import Any, Awaitable, Callable
from uuid import uuid4

log = logging.getLogger("eduhub.coach_pack.shared")

# --------------------------------------------------------------------------- #
# Collection names — all NEW, additive, isolated.                             #
# --------------------------------------------------------------------------- #
COL_SLP = "student_learning_profile"
COL_VOCAB = "student_vocab"
COL_VOCAB_CACHE = "vocab_example_cache"
COL_SENTENCES = "student_sentences"
COL_SENT_CACHE = "sentence_rewrite_cache"
COL_CHAPTER_PROGRESS = "chapter_progress"
COL_REVIEWS = "chapter_reviews"
COL_REVIEW_CACHE = "chapter_review_cache"
COL_QUIZZES = "chapter_quizzes"
COL_QUIZ_ATTEMPTS = "quiz_attempts"
COL_ROLEPLAY_SESSIONS = "roleplay_sessions"
COL_ROLEPLAY_MESSAGES = "roleplay_messages"
COL_ROLEPLAY_DAILY = "student_roleplay_daily_usage"
COL_STUDY_PATHS = "study_paths"
COL_BADGES = "student_badges"
COL_DAILY_AI = "student_daily_ai_usage"
COL_BRIEFING_CACHE = "coach_briefing_cache"
COL_WEAKNESS_CACHE = "weakness_diagnosis_cache"
COL_AUDIT_LOG = "coach_pack_audit_log"

# Tier names — match edutalk_tier_config_tools.VALID_TIERS.
TIER_FREE = "free"
TIER_STANDARD = "standard"
TIER_PREMIUM = "premium"
TIER_LIMITED = "limited_edition"
VALID_COACH_TIERS = (TIER_FREE, TIER_STANDARD, TIER_PREMIUM, TIER_LIMITED)


# --------------------------------------------------------------------------- #
# Helpers — time, hashing, normalisation                                      #
# --------------------------------------------------------------------------- #
def now() -> datetime:
    return datetime.now(timezone.utc)


def iso_now() -> str:
    return now().isoformat()


def today_str() -> str:
    return date.today().isoformat()


def week_start_str() -> str:
    """ISO Monday-of-the-week date string (UTC)."""
    d = date.today()
    monday = d.fromordinal(d.toordinal() - d.weekday())
    return monday.isoformat()


_WS = re.compile(r"\s+")


def normalise_text(text: str, max_chars: int = 2000) -> str:
    s = (text or "").strip()
    if len(s) > max_chars:
        s = s[:max_chars]
    return _WS.sub(" ", s).lower()


def content_hash(*, feature: str, parts: dict[str, Any], personalised_for: str | None = None) -> str:
    """Stable content-hash for a Coach Pack cache row.

    `personalised_for` (student_id) is folded into the hash ONLY when the
    output is personalised — same pattern as edutalk_audio_cache.compute_content_hash.
    """
    payload: dict[str, Any] = {"v": 1, "feature": feature}
    for k in sorted(parts.keys()):
        v = parts[k]
        if isinstance(v, str):
            payload[k] = normalise_text(v, max_chars=3000)
        else:
            payload[k] = v
    if personalised_for:
        payload["pers"] = (personalised_for or "").strip().lower()
    blob = json.dumps(payload, sort_keys=True, ensure_ascii=False).encode("utf-8")
    return hashlib.sha256(blob).hexdigest()


def level_band(slp: dict | None) -> str:
    """Coarse student level band — used as part of cache keys."""
    if not slp:
        return "beginner"
    lvl = (slp.get("implicit_level") or "").strip().lower()
    if lvl in ("beginner", "intermediate", "advanced"):
        return lvl
    return "beginner"


def lang_pref(slp: dict | None) -> str:
    """Khmer / English preference, defaulting to khmer-english bilingual."""
    if not slp:
        return "kh-en"
    v = (slp.get("language_pref") or "").strip().lower()
    if v in ("kh", "khmer"):
        return "kh"
    if v in ("en", "english"):
        return "en"
    return "kh-en"


# --------------------------------------------------------------------------- #
# Lazy imports — never raise on module load.                                  #
# --------------------------------------------------------------------------- #
def _gas_helpers():
    """Return (_gas_debit, _gas_get_balance) or (None, None)."""
    try:
        from server import _gas_debit, _gas_get_balance  # type: ignore
        return _gas_debit, _gas_get_balance
    except Exception:  # noqa: BLE001
        return None, None


def _gemini_call_fn():
    """Return gemini_engine._call_gemini or None when Gemini disabled."""
    try:
        from gemini_engine import _call_gemini, is_enabled  # type: ignore
        if not is_enabled():
            return None
        return _call_gemini
    except Exception:  # noqa: BLE001
        return None


def _tier_loader():
    try:
        from edutalk_tier_config_tools import load_tier_config  # type: ignore
        return load_tier_config
    except Exception:  # noqa: BLE001
        return None


# --------------------------------------------------------------------------- #
# Tier-config + flag helpers                                                  #
# --------------------------------------------------------------------------- #
async def get_tier_block(db, tier: str) -> dict[str, Any]:
    """Return the merged tier block for `tier` (always populated).

    On any failure returns the in-memory DEFAULT_TIER_CONFIG to keep
    behaviour predictable for the caller. Coach Pack flags missing
    from the stored doc fall back to safe-OFF / safe-LOW via
    `get_flag()` / `get_int()` below.
    """
    loader = _tier_loader()
    if loader is None:
        return {}
    try:
        merged = await loader(db)
        block = merged.get(tier) or merged.get(TIER_STANDARD) or {}
        return dict(block)
    except Exception as exc:  # noqa: BLE001
        log.warning("coach_pack: get_tier_block failed: %s", exc)
        return {}


def get_flag(cfg: dict, key: str, default: bool = False) -> bool:
    v = cfg.get(key)
    return bool(v) if v is not None else default


def get_int(cfg: dict, key: str, default: int = 0, *, max_value: int = 1_000_000) -> int:
    v = cfg.get(key)
    try:
        n = int(v) if v is not None else default
    except (TypeError, ValueError):
        n = default
    return max(0, min(n, max_value))


# --------------------------------------------------------------------------- #
# Daily AI ceiling                                                            #
# --------------------------------------------------------------------------- #
async def get_daily_usage(db, student_id: str) -> dict[str, Any]:
    doc = await db[COL_DAILY_AI].find_one(
        {"student_id": student_id, "day": today_str()},
    )
    return doc or {"student_id": student_id, "day": today_str(), "total_points": 0, "calls": 0}


async def increment_daily_usage(db, student_id: str, points: int) -> None:
    try:
        await db[COL_DAILY_AI].update_one(
            {"student_id": student_id, "day": today_str()},
            {
                "$inc": {"total_points": int(points), "calls": 1},
                "$set": {"last_updated_at": iso_now()},
                "$setOnInsert": {
                    "student_id": student_id,
                    "day": today_str(),
                    "created_at": iso_now(),
                },
            },
            upsert=True,
        )
    except Exception as exc:  # noqa: BLE001
        log.warning("coach_pack: increment_daily_usage failed: %s", exc)


# --------------------------------------------------------------------------- #
# Cache + entitlement (text-shape, mirrors v9.6 audio entitlement contract)   #
# --------------------------------------------------------------------------- #
async def lookup_text_cache(db, *, cache_col: str, ch: str) -> dict | None:
    try:
        return await db[cache_col].find_one({"content_hash": ch})
    except Exception as exc:  # noqa: BLE001
        log.debug("coach_pack: lookup_text_cache failed: %s", exc)
        return None


async def upsert_text_cache(
    db, *, cache_col: str, ch: str, payload: dict, meta: dict,
) -> None:
    try:
        doc = {
            "content_hash": ch,
            "payload": payload,
            "is_personalized": bool(meta.get("is_personalized", False)),
            "created_at": iso_now(),
            "last_accessed_at": iso_now(),
            "access_count": 1,
            **{k: v for k, v in meta.items() if k != "is_personalized"},
        }
        await db[cache_col].update_one(
            {"content_hash": ch}, {"$setOnInsert": doc}, upsert=True,
        )
    except Exception as exc:  # noqa: BLE001
        log.warning("coach_pack: upsert_text_cache failed: %s", exc)


async def lookup_text_entitlement(db, *, ent_col: str, student_id: str, ch: str) -> dict | None:
    try:
        return await db[ent_col].find_one({"student_id": student_id, "content_hash": ch})
    except Exception as exc:  # noqa: BLE001
        log.debug("coach_pack: lookup_text_entitlement failed: %s", exc)
        return None


async def grant_text_entitlement(
    db, *, ent_col: str, student_id: str, ch: str, paid_points: int, meta: dict,
) -> None:
    try:
        doc = {
            "entitlement_id": uuid4().hex,
            "student_id": student_id,
            "content_hash": ch,
            "paid_points": int(paid_points or 0),
            "created_at": iso_now(),
            "last_accessed_at": iso_now(),
            "access_count": 1,
            **meta,
        }
        await db[ent_col].update_one(
            {"student_id": student_id, "content_hash": ch},
            {"$setOnInsert": doc},
            upsert=True,
        )
    except Exception as exc:  # noqa: BLE001
        log.warning("coach_pack: grant_text_entitlement failed: %s", exc)


async def bump_text_access(db, *, cache_col: str, ent_col: str, student_id: str, ch: str) -> None:
    n = iso_now()
    try:
        await db[cache_col].update_one(
            {"content_hash": ch},
            {"$set": {"last_accessed_at": n}, "$inc": {"access_count": 1}},
        )
    except Exception as exc:  # noqa: BLE001
        log.debug("coach_pack: bump cache failed: %s", exc)
    try:
        await db[ent_col].update_one(
            {"student_id": student_id, "content_hash": ch},
            {"$set": {"last_accessed_at": n}, "$inc": {"access_count": 1}},
        )
    except Exception as exc:  # noqa: BLE001
        log.debug("coach_pack: bump entitlement failed: %s", exc)


# --------------------------------------------------------------------------- #
# Audit log (failure-safe, fire-and-forget)                                   #
# --------------------------------------------------------------------------- #
async def audit_log(db, *, feature: str, event: str, student_id: str = "", **extras: Any) -> None:
    try:
        await db[COL_AUDIT_LOG].insert_one({
            "feature": feature,
            "event": event,
            "student_id": student_id,
            "created_at": iso_now(),
            **{k: v for k, v in extras.items() if v is not None},
        })
    except Exception as exc:  # noqa: BLE001
        log.debug("coach_pack: audit_log failed (non-fatal): %s", exc)


# --------------------------------------------------------------------------- #
# THE gate sequence — paid_action()                                           #
# --------------------------------------------------------------------------- #
async def paid_action(
    *,
    db,
    student,                         # Student object with .clean_id
    password: str,                   # required only when cost > 0
    feature_key: str,                # e.g. "word_example", "chapter_review"
    cost: int,                       # post-tier-config cost in points
    tier_cfg: dict,                  # already-loaded tier block
    ceiling_check: bool,             # True for every paid AI action
    cache_col: str | None,           # None for non-cacheable actions
    ent_col: str | None,             # None for non-entitlement actions
    ch: str | None,                  # content_hash; None for non-cacheable
    is_personalized: bool,           # affects cache reuse across students
    cache_meta: dict | None,         # extra metadata stored with cache row
    ent_meta: dict | None,           # extra metadata stored with entitlement
    llm_call: Callable[[], Awaitable[dict]],  # MUST be no-arg async
    refund_reason: str | None = None,
) -> dict[str, Any]:
    """Run the canonical 8-step Coach Pack gate.

    Returns one of:
      {success: True,  from: "entitlement_replay", payload, points_charged: 0}
      {success: True,  from: "cache_hit",          payload, points_charged: cost}
      {success: True,  from: "fresh",              payload, points_charged: cost}
      {success: False, error: "feature_disabled" | "daily_limit_reached"
                              | "insufficient_points" | "ai_unavailable"
                              | "internal_error", message}
    """
    student_id = student.clean_id

    # 3. Entitlement replay (free for same student) — only if ch + ent_col provided.
    if ch and ent_col and cache_col:
        ent = await lookup_text_entitlement(db, ent_col=ent_col, student_id=student_id, ch=ch)
        if ent:
            cached = await lookup_text_cache(db, cache_col=cache_col, ch=ch)
            if cached and cached.get("payload") is not None:
                await bump_text_access(
                    db, cache_col=cache_col, ent_col=ent_col,
                    student_id=student_id, ch=ch,
                )
                return {
                    "success": True, "from": "entitlement_replay",
                    "payload": cached["payload"], "points_charged": 0,
                }

    # 4. Shared cache hit (non-personalised outputs only).
    cached_doc = None
    if ch and cache_col and not is_personalized:
        cached_doc = await lookup_text_cache(db, cache_col=cache_col, ch=ch)

    # 5. Daily AI ceiling (BEFORE any LLM call, BEFORE debit).
    if ceiling_check:
        ceiling = get_int(tier_cfg, "daily_ai_point_ceiling", default=0, max_value=10000)
        usage = await get_daily_usage(db, student_id)
        if ceiling <= 0 or usage["total_points"] + cost > ceiling:
            await audit_log(
                db, feature=feature_key, event="daily_limit_reached",
                student_id=student_id, cost=cost,
                current_total=usage["total_points"], ceiling=ceiling,
            )
            return {
                "success": False, "error": "daily_limit_reached",
                "message": (
                    "You've completed a lot of AI practice today. "
                    "Come back tomorrow to continue your coach journey."
                ),
                "ceiling": ceiling,
                "current_total": usage["total_points"],
            }

    # 6. Cost check + debit.
    _gas_debit, _ = _gas_helpers()
    if cost > 0:
        if _gas_debit is None:
            return {
                "success": False, "error": "internal_error",
                "message": "Points service unavailable. Please retry shortly.",
            }
        debit_ok, debit_err = await _gas_debit(student.clean_id, password, cost)
        if not debit_ok:
            err_lc = (debit_err or "").lower()
            if "insufficient" in err_lc or "not enough" in err_lc or "balance" in err_lc:
                return {
                    "success": False, "error": "insufficient_points",
                    "message": "You don't have enough points to use this feature.",
                    "required_points": cost,
                }
            return {
                "success": False, "error": "internal_error",
                "message": (debit_err or "Could not charge points.")[:160],
            }

    # 7a. Cache-hit short-circuit (after debit so the ledger is consistent).
    if cached_doc and cached_doc.get("payload") is not None:
        if ch and ent_col:
            await grant_text_entitlement(
                db, ent_col=ent_col, student_id=student_id, ch=ch,
                paid_points=cost, meta=ent_meta or {},
            )
            await bump_text_access(
                db, cache_col=cache_col, ent_col=ent_col,
                student_id=student_id, ch=ch,
            )
        if ceiling_check:
            await increment_daily_usage(db, student_id, cost)
        await audit_log(
            db, feature=feature_key, event="cache_hit",
            student_id=student_id, cost=cost, content_hash=ch or "",
        )
        return {
            "success": True, "from": "cache_hit",
            "payload": cached_doc["payload"], "points_charged": cost,
        }

    # 7b. LLM call (timeout-bounded, refund on failure).
    try:
        payload = await asyncio.wait_for(llm_call(), timeout=20)
    except Exception as exc:  # noqa: BLE001
        # Refund.
        if cost > 0 and _gas_debit is not None:
            try:
                await _gas_debit(student.clean_id, password, -cost)
            except Exception:  # noqa: BLE001
                pass
        await audit_log(
            db, feature=feature_key, event="llm_failed",
            student_id=student_id, cost=cost,
            error=type(exc).__name__, message=str(exc)[:160],
        )
        log.warning("coach_pack: %s LLM failed: %s", feature_key, exc)
        return {
            "success": False, "error": "ai_unavailable",
            "message": "Try again in a moment — no points charged.",
        }

    if not isinstance(payload, dict):
        # Defensive — every llm_call must return a JSON-shaped dict.
        if cost > 0 and _gas_debit is not None:
            try:
                await _gas_debit(student.clean_id, password, -cost)
            except Exception:  # noqa: BLE001
                pass
        return {
            "success": False, "error": "ai_unavailable",
            "message": "Try again in a moment — no points charged.",
        }

    # 8. Persist cache + entitlement + daily usage.
    if ch and cache_col:
        await upsert_text_cache(
            db, cache_col=cache_col, ch=ch, payload=payload,
            meta={"is_personalized": is_personalized, **(cache_meta or {})},
        )
    if ch and ent_col:
        await grant_text_entitlement(
            db, ent_col=ent_col, student_id=student_id, ch=ch,
            paid_points=cost, meta=ent_meta or {},
        )
    if ceiling_check:
        await increment_daily_usage(db, student_id, cost)
    await audit_log(
        db, feature=feature_key, event="fresh",
        student_id=student_id, cost=cost, content_hash=ch or "",
    )
    return {"success": True, "from": "fresh", "payload": payload, "points_charged": cost}


# --------------------------------------------------------------------------- #
# Gemini JSON-mode helper — every Coach Pack LLM call uses this.              #
# --------------------------------------------------------------------------- #
async def call_gemini_json(prompt: str, *, max_output_chars: int = 4000) -> dict:
    """Call Gemini via the existing gemini_engine helper, parse a JSON
    object out of the response, return the dict. Raises on any failure.
    """
    fn = _gemini_call_fn()
    if fn is None:
        raise RuntimeError("Gemini disabled or unavailable")
    raw = await fn(prompt)
    if not isinstance(raw, str):
        raise RuntimeError("Gemini returned non-string")
    text = raw.strip()
    if len(text) > max_output_chars:
        text = text[:max_output_chars]
    # Strip code-fence wrappers if present.
    if text.startswith("```"):
        text = text.strip("`")
        if text.lower().startswith("json"):
            text = text[4:]
    # Find first { ... } block.
    start = text.find("{")
    end = text.rfind("}")
    if start < 0 or end < 0 or end <= start:
        raise RuntimeError("Gemini response had no JSON object")
    try:
        return json.loads(text[start:end + 1])
    except Exception as exc:
        raise RuntimeError(f"Gemini JSON parse failed: {exc}") from exc


# --------------------------------------------------------------------------- #
# Idempotent indexes for every Coach Pack collection                          #
# --------------------------------------------------------------------------- #
async def ensure_coach_pack_indexes(db) -> None:
    """Create all Coach Pack indexes. Failure-safe."""
    plans: list[tuple[str, list, dict]] = [
        (COL_SLP, [("student_id", 1)], {"unique": True, "name": "ux_student_id"}),
        (COL_SLP, [("updated_at", -1)], {"name": "ix_updated_at"}),
        (COL_VOCAB, [("student_id", 1), ("word", 1), ("book_slug", 1)],
            {"unique": True, "name": "ux_student_word_book"}),
        (COL_VOCAB, [("student_id", 1), ("last_accessed_at", -1)],
            {"name": "ix_student_last_accessed"}),
        (COL_VOCAB_CACHE, [("content_hash", 1)], {"unique": True, "name": "ux_content_hash"}),
        (COL_SENTENCES, [("student_id", 1), ("sentence_hash", 1)],
            {"unique": True, "name": "ux_student_sentence_hash"}),
        (COL_SENTENCES, [("tomorrow_review_at", 1)], {"name": "ix_tomorrow_review_at"}),
        (COL_SENT_CACHE, [("content_hash", 1)], {"unique": True, "name": "ux_content_hash"}),
        (COL_CHAPTER_PROGRESS, [("student_id", 1), ("book_slug", 1), ("chapter_idx", 1)],
            {"unique": True, "name": "ux_student_book_chapter"}),
        (COL_CHAPTER_PROGRESS, [("student_id", 1), ("last_active_at", -1)],
            {"name": "ix_student_last_active"}),
        (COL_REVIEWS, [("student_id", 1), ("book_slug", 1), ("chapter_idx", 1)],
            {"name": "ix_student_book_chapter"}),
        (COL_REVIEWS, [("student_id", 1), ("content_hash", 1)],
            {"unique": True, "name": "ux_student_review_ent"}),
        (COL_REVIEW_CACHE, [("content_hash", 1)], {"unique": True, "name": "ux_content_hash"}),
        (COL_QUIZZES, [("book_slug", 1), ("chapter_idx", 1), ("level_band", 1), ("lang_pref", 1)],
            {"unique": True, "name": "ux_quiz_hash"}),
        (COL_QUIZ_ATTEMPTS, [("student_id", 1), ("quiz_id", 1), ("attempt_idx", 1)],
            {"unique": True, "name": "ux_student_quiz_attempt"}),
        (COL_QUIZ_ATTEMPTS, [("student_id", 1), ("created_at", -1)],
            {"name": "ix_student_created_at"}),
        (COL_ROLEPLAY_SESSIONS, [("session_id", 1)], {"unique": True, "name": "ux_session_id"}),
        (COL_ROLEPLAY_SESSIONS, [("student_id", 1), ("day", 1)], {"name": "ix_student_day"}),
        (COL_ROLEPLAY_MESSAGES, [("session_id", 1), ("message_idx", 1)],
            {"unique": True, "name": "ux_session_message"}),
        (COL_ROLEPLAY_DAILY, [("student_id", 1), ("day", 1)],
            {"unique": True, "name": "ux_student_day"}),
        (COL_STUDY_PATHS, [("student_id", 1), ("week_start", 1)],
            {"unique": True, "name": "ux_student_week_start"}),
        (COL_BADGES, [("student_id", 1), ("badge_id", 1)],
            {"unique": True, "name": "ux_student_badge_id"}),
        (COL_BADGES, [("student_id", 1), ("earned_at", -1)],
            {"name": "ix_student_earned_at"}),
        (COL_DAILY_AI, [("student_id", 1), ("day", 1)],
            {"unique": True, "name": "ux_student_day"}),
        (COL_BRIEFING_CACHE, [("student_id", 1), ("book_slug", 1), ("week_start", 1)],
            {"unique": True, "name": "ux_briefing_key"}),
        (COL_WEAKNESS_CACHE, [("student_id", 1), ("week_start", 1)],
            {"unique": True, "name": "ux_student_week_start"}),
        (COL_AUDIT_LOG, [("created_at", -1)], {"name": "ix_created_at"}),
        (COL_AUDIT_LOG, [("student_id", 1), ("created_at", -1)],
            {"name": "ix_student_created_at"}),
    ]
    for col_name, keys, opts in plans:
        try:
            await db[col_name].create_index(keys, **opts)
        except Exception as exc:  # noqa: BLE001
            log.warning("coach_pack: index %s.%s failed (non-fatal): %s",
                        col_name, opts.get("name", "?"), exc)
    log.info("coach_pack: indexes ready (%d plans)", len(plans))
