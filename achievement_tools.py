"""achievement_tools.py — EduHub Achievement Center (Phase 1, Trophy Tiers).

100% additive module — same isolation convention as attendance_tools.py /
experience_config_tools.py. Registers student + admin routes, owns ONLY the
two collections below, and reads every metric from existing production
collections without ever writing to them.

Collections OWNED by this module:
  achievement_trophies   — the 5 seeded Trophy Tier configs (Author Studio
                           controls everything; seed values are inert:
                           enabled=False, zero requirements, zero reward).
  achievement_claims     — permanent one-per-(student,trophy) claim history,
                           enforced by a unique index (race-safe).

Collections READ (never written):
  points_transactions        lifetime points  (wallet_service ledger)
  attendance_records         attendance       (read-only, statuses only)
  book_interaction_progress  lessons completed
  chapter_progress           reading completed
  voice_treasure_attempts    speaking activities
  edutalk_sessions           speaking activities
  student_learning_profile   learning streak (streak_days)

Wallet crediting goes through the EXISTING wallet_service.WalletService.credit
(single source of truth) with an idempotency_key, so even a double-fired
request can never double-credit.
"""
from __future__ import annotations

import logging
import uuid
from datetime import datetime, timezone

from fastapi import Depends, HTTPException
from pymongo.errors import DuplicateKeyError

log = logging.getLogger("eduhub.achievements")

COLL_TROPHIES = "achievement_trophies"
COLL_CLAIMS = "achievement_claims"

# Attendance statuses that count as an attended session (mirrors
# attendance_tools.py ST_* constants — read-only consumption).
_ATTENDED_STATUSES = ("present_full", "present_partial", "late")

# Live-ambience presets available for reward.celebration_effect — must stay in
# sync with the frontend catalog (ambiencePresets.js). The backend only
# whitelists the id; all visual parameters live in the frontend preset.
CELEBRATION_EFFECTS = (
    "gold_dust", "silver_mist", "champagne_bubbles", "crystal_shimmer",
    "royal_velvet", "firefly_orbit", "halo_glow", "light_sweep",
    "ember_rise", "petal_drift", "starfield", "aurora_veil",
    "confetti_whisper", "laurel_spiral", "moonlight_pulse",
)
DEFAULT_CELEBRATION_EFFECT = "gold_dust"

REQUIREMENT_KEYS = (
    ("min_lifetime_points", "Lifetime Points", "lifetime_points"),
    ("min_attendance_sessions", "Attendance", "attendance_sessions"),
    ("min_lessons_completed", "Lessons Completed", "lessons_completed"),
    ("min_reading_completed", "Reading Completed", "reading_completed"),
    ("min_speaking_activities", "Speaking Activities", "speaking_activities"),
    ("min_streak_days", "Learning Streak (days)", "streak_days"),
)

# Seed records — engine only, NO business rules: everything disabled/zero
# until configured in Author Studio. Artwork references the 5 approved
# Trophy Tier assets shipped with the PWA.
SEED_TROPHIES = [
    {
        "trophy_id": "tier1",
        "name": "Trophy Tier 1",
        "display_order": 1,
        "artwork": "/assets/trophies/EduHub-Trophy-Tier1-First-MatteClay-Gold.png",
    },
    {
        "trophy_id": "tier2",
        "name": "Trophy Tier 2",
        "display_order": 2,
        "artwork": "/assets/trophies/EduHub-Trophy-Tier2-Second-MatteSilver-Laurel.png",
    },
    {
        "trophy_id": "tier3",
        "name": "Trophy Tier 3",
        "display_order": 3,
        "artwork": "/assets/trophies/EduHub-Trophy-Tier3-Third-Winged-Champagne.png",
    },
    {
        "trophy_id": "tier4",
        "name": "Trophy Tier 4",
        "display_order": 4,
        "artwork": "/assets/trophies/EduHub-Trophy-Tier4-Fourth-Platinum-Crystal.png",
    },
    {
        "trophy_id": "premium",
        "name": "Premium Achievement",
        "display_order": 5,
        "artwork": "/assets/trophies/EduHub-Trophy-Premium-Achievement-MarblePedestal.png",
    },
]


def _now_iso() -> str:
    return datetime.now(timezone.utc).isoformat()


def _default_requirements() -> dict:
    return {key: 0 for key, _label, _metric in REQUIREMENT_KEYS}


def _default_reward() -> dict:
    return {
        "type": "points",
        "points": 0,
        "claim_enabled": False,
        "one_time": True,
        "celebration_enabled": True,
        "celebration_effect": DEFAULT_CELEBRATION_EFFECT,
    }


def _seed_doc(seed: dict) -> dict:
    return {
        "trophy_id": seed["trophy_id"],
        "enabled": False,
        "display_order": seed["display_order"],
        "name": seed["name"],
        "artwork": seed["artwork"],
        "requirements": _default_requirements(),
        "reward": _default_reward(),
        "version": 1,
        "created_at": _now_iso(),
        "updated_at": _now_iso(),
    }


async def ensure_achievement_indexes(db) -> None:
    """Indexes + idempotent seed. Insert-only-if-missing: never overwrites
    an Author-Studio-edited trophy."""
    await db[COLL_TROPHIES].create_index("trophy_id", unique=True)
    await db[COLL_CLAIMS].create_index(
        [("student_id", 1), ("trophy_id", 1)], unique=True,
    )
    await db[COLL_CLAIMS].create_index([("claimed_at", -1)])
    for seed in SEED_TROPHIES:
        existing = await db[COLL_TROPHIES].find_one(
            {"trophy_id": seed["trophy_id"]}, {"_id": 1},
        )
        if existing:
            continue
        try:
            await db[COLL_TROPHIES].insert_one(_seed_doc(seed))
            log.info("achievements: seeded trophy %s", seed["trophy_id"])
        except DuplicateKeyError:
            pass  # concurrent startup race — another worker seeded it


def _student_ids(student) -> list[str]:
    """Both id forms — existing collections are split between
    student.student_id (wallets, voice treasure) and student.clean_id
    (attendance, SLP, chapter/interaction progress, edutalk)."""
    ids = []
    for value in (
        getattr(student, "student_id", "") or "",
        getattr(student, "clean_id", "") or "",
    ):
        v = str(value).strip()
        if v and v not in ids:
            ids.append(v)
    return ids


async def compute_metrics(db, student) -> dict:
    """Read-only production metrics. Every value comes from an existing
    collection; a failed read degrades to 0 (never fabricates upward)."""
    ids = _student_ids(student)
    metrics = {
        "lifetime_points": 0,
        "attendance_sessions": 0,
        "lessons_completed": 0,
        "reading_completed": 0,
        "speaking_activities": 0,
        "streak_days": 0,
    }
    if not ids:
        return metrics

    # Lifetime points — sum of every credit ever received in the
    # wallet_service ledger (credits + incoming transfers).
    try:
        pipeline = [
            {"$match": {"$or": [
                {"operation": "credit", "student_id": {"$in": ids}},
                {"operation": "transfer", "to_id": {"$in": ids}},
            ]}},
            {"$group": {"_id": None, "total": {"$sum": "$amount"}}},
        ]
        rows = await db["points_transactions"].aggregate(pipeline).to_list(1)
        if rows:
            metrics["lifetime_points"] = int(rows[0].get("total") or 0)
    except Exception as exc:  # noqa: BLE001
        log.warning("achievements: lifetime_points read failed: %s", exc)

    # Attendance — attended sessions (read-only; never touches records).
    try:
        metrics["attendance_sessions"] = await db["attendance_records"].count_documents(
            {"student_id": {"$in": ids}, "status": {"$in": list(_ATTENDED_STATUSES)}},
        )
    except Exception as exc:  # noqa: BLE001
        log.warning("achievements: attendance read failed: %s", exc)

    # Lessons completed — completed interactive lesson blocks.
    try:
        metrics["lessons_completed"] = await db["book_interaction_progress"].count_documents(
            {"studentId": {"$in": ids}, "completed": True},
        )
    except Exception as exc:  # noqa: BLE001
        log.warning("achievements: lessons read failed: %s", exc)

    # Reading completed — completed reading chapters.
    try:
        metrics["reading_completed"] = await db["chapter_progress"].count_documents(
            {"student_id": {"$in": ids}, "completed": True},
        )
    except Exception as exc:  # noqa: BLE001
        log.warning("achievements: reading read failed: %s", exc)

    # Speaking activities — Voice Treasure attempts + EduTalk sessions.
    try:
        vt = await db["voice_treasure_attempts"].count_documents(
            {"student_id": {"$in": ids}},
        )
        et = await db["edutalk_sessions"].count_documents(
            {"student_id": {"$in": ids}},
        )
        metrics["speaking_activities"] = int(vt) + int(et)
    except Exception as exc:  # noqa: BLE001
        log.warning("achievements: speaking read failed: %s", exc)

    # Learning streak — coach-pack SLP streak_days.
    try:
        slp = await db["student_learning_profile"].find_one(
            {"student_id": {"$in": ids}}, {"_id": 0, "streak_days": 1},
        )
        if slp:
            metrics["streak_days"] = int(slp.get("streak_days") or 0)
    except Exception as exc:  # noqa: BLE001
        log.warning("achievements: streak read failed: %s", exc)

    return metrics


def _evaluate(trophy: dict, metrics: dict) -> dict:
    """Requirement evaluation. A requirement is ACTIVE only when its
    configured value is > 0. A trophy can unlock only when it is enabled
    AND has at least one active requirement (all zeros = still awaiting
    Author Studio configuration) AND every active requirement is met."""
    reqs = trophy.get("requirements") or {}
    progress = []
    active = 0
    met = 0
    for key, label, metric_key in REQUIREMENT_KEYS:
        required = int(reqs.get(key) or 0)
        if required <= 0:
            continue
        active += 1
        current = int(metrics.get(metric_key) or 0)
        ok = current >= required
        if ok:
            met += 1
        progress.append({
            "key": key,
            "label": label,
            "current": current,
            "required": required,
            "remaining": max(0, required - current),
            "met": ok,
            "fraction": min(1.0, current / required) if required > 0 else 0.0,
        })
    needs_configuration = active == 0
    unlocked = bool(trophy.get("enabled")) and active > 0 and met == active
    return {
        "progress": progress,
        "unlocked": unlocked,
        "needs_configuration": needs_configuration,
    }


def _public_trophy(trophy: dict, evaluation: dict, claim: dict | None) -> dict:
    reward = trophy.get("reward") or {}
    claimed = bool(claim and claim.get("status") == "credited")
    unlocked = evaluation["unlocked"] or claimed
    return {
        "trophy_id": trophy["trophy_id"],
        "name": trophy.get("name") or trophy["trophy_id"],
        "artwork": trophy.get("artwork") or "",
        "display_order": int(trophy.get("display_order") or 0),
        "enabled": bool(trophy.get("enabled")),
        "requirements": trophy.get("requirements") or {},
        "reward": {
            "type": reward.get("type") or "points",
            "points": int(reward.get("points") or 0),
            "claim_enabled": bool(reward.get("claim_enabled")),
            "celebration_enabled": bool(reward.get("celebration_enabled", True)),
            "celebration_effect": (
                reward.get("celebration_effect")
                if reward.get("celebration_effect") in CELEBRATION_EFFECTS
                else DEFAULT_CELEBRATION_EFFECT
            ),
        },
        "progress": evaluation["progress"],
        "needs_configuration": evaluation["needs_configuration"],
        "unlocked": unlocked,
        "claimed": claimed,
        "claimable": (
            unlocked
            and not claimed
            and bool(reward.get("claim_enabled"))
            and int(reward.get("points") or 0) > 0
        ),
        "claimed_at": (claim or {}).get("claimed_at"),
    }


def register_achievement_routes(api, db, require_student, require_admin, wallet=None):
    """Mount /api/achievements/* (student) and /api/admin/achievements/*
    (admin). `wallet` is a wallet_service.WalletService instance owned by
    server.py — claims are disabled (503) when it is unavailable."""

    trophies_coll = db[COLL_TROPHIES]
    claims_coll = db[COLL_CLAIMS]

    async def _load_trophies() -> list[dict]:
        cur = trophies_coll.find({}, {"_id": 0}).sort("display_order", 1)
        return [t async for t in cur]

    async def _claims_for(student) -> dict[str, dict]:
        ids = _student_ids(student)
        out: dict[str, dict] = {}
        cur = claims_coll.find({"student_id": {"$in": ids}}, {"_id": 0})
        async for c in cur:
            out[c["trophy_id"]] = c
        return out

    # ------------------------------------------------------------------ #
    # Student routes                                                     #
    # ------------------------------------------------------------------ #
    @api.get("/achievements/me")
    async def achievements_me(student=Depends(require_student)):
        trophies = await _load_trophies()
        metrics = await compute_metrics(db, student)
        claims = await _claims_for(student)

        items = []
        for t in trophies:
            evaluation = _evaluate(t, metrics)
            items.append(_public_trophy(t, evaluation, claims.get(t["trophy_id"])))

        unlocked_items = [i for i in items if i["unlocked"]]
        claimed_count = sum(1 for i in items if i["claimed"])
        current = unlocked_items[-1] if unlocked_items else None
        next_trophy = next((i for i in items if not i["unlocked"]), None)

        return {
            "summary": {
                "unlocked_count": len(unlocked_items),
                "claimed_count": claimed_count,
                "total": len(items),
                "next_trophy": (
                    {"trophy_id": next_trophy["trophy_id"], "name": next_trophy["name"]}
                    if next_trophy else None
                ),
            },
            "metrics": metrics,
            "current_trophy_id": current["trophy_id"] if current else None,
            "next_trophy_id": next_trophy["trophy_id"] if next_trophy else None,
            "trophies": items,
        }

    @api.post("/achievements/claim")
    async def achievements_claim(payload: dict, student=Depends(require_student)):
        if wallet is None:
            raise HTTPException(503, "Reward crediting is temporarily unavailable.")
        trophy_id = str((payload or {}).get("trophy_id") or "").strip()
        if not trophy_id:
            raise HTTPException(400, "trophy_id is required")

        trophy = await trophies_coll.find_one({"trophy_id": trophy_id}, {"_id": 0})
        if not trophy:
            raise HTTPException(404, "Trophy not found")
        reward = trophy.get("reward") or {}
        points = int(reward.get("points") or 0)
        if not trophy.get("enabled"):
            raise HTTPException(403, "This trophy is not active.")
        if not reward.get("claim_enabled") or points <= 0:
            raise HTTPException(403, "This reward is not claimable yet.")

        # Server-side re-verification against live production metrics.
        metrics = await compute_metrics(db, student)
        evaluation = _evaluate(trophy, metrics)
        if not evaluation["unlocked"]:
            raise HTTPException(403, "Trophy requirements are not met.")

        sid = str(getattr(student, "student_id", "") or "").strip()
        clean_id = str(getattr(student, "clean_id", "") or "").strip()
        claim_key = f"achievement:{trophy_id}:{sid}"
        claim_doc = {
            "claim_id": uuid.uuid4().hex,
            "student_id": sid,
            "clean_id": clean_id,
            "trophy_id": trophy_id,
            "trophy_name": trophy.get("name"),
            "trophy_version": int(trophy.get("version") or 1),
            "points": points,
            "status": "pending",
            "claimed_at": _now_iso(),
        }
        # Unique (student_id, trophy_id) index makes this the atomic
        # "only one claim ever" gate — safe under concurrent requests.
        try:
            await claims_coll.insert_one(dict(claim_doc))
        except DuplicateKeyError:
            raise HTTPException(409, "Reward already claimed.")

        try:
            result = await wallet.credit(
                sid,
                points,
                source="achievement_reward",
                source_ref=trophy_id,
                idempotency_key=claim_key,
                clean_id=clean_id or None,
                payload={"trophy_id": trophy_id, "trophy_name": trophy.get("name")},
            )
        except BaseException as exc:
            # Roll back the pending claim so the student can retry. Caught
            # as BaseException (not just Exception) — an in-flight request
            # cancelled by a client disconnect raises asyncio.CancelledError,
            # which does NOT subclass Exception. Without this, a mundane
            # network drop mid-claim would leave a permanently-"pending"
            # claim doc that the unique index then blocks forever, with the
            # student never credited and no way to retry.
            await claims_coll.delete_one(
                {"claim_id": claim_doc["claim_id"], "status": "pending"},
            )
            if not isinstance(exc, Exception):
                raise
            log.error("achievements: wallet credit failed for %s/%s: %s",
                      sid, trophy_id, exc)
            raise HTTPException(502, "Reward credit failed. Please try again.")

        balance_after = float((result or {}).get("balance_after") or 0)
        # The credit above already happened — a failure here must never
        # surface as an error response to the student (they WERE paid).
        # Finalizing to "credited" is best-effort bookkeeping; on failure we
        # log CRITICAL with the exact ids needed for manual reconciliation
        # instead of letting the claim doc silently strand at "pending"
        # forever (which would also make every retry hit the unique index
        # as a 409, with no path back to "credited").
        try:
            await claims_coll.update_one(
                {"claim_id": claim_doc["claim_id"]},
                {"$set": {
                    "status": "credited",
                    "balance_after": balance_after,
                    "credited_at": _now_iso(),
                }},
            )
        except Exception as exc:  # noqa: BLE001
            log.critical(
                "achievements: claim %s credited (student=%s trophy=%s) but "
                "finalize write failed — manual reconciliation needed: %s",
                claim_doc["claim_id"], sid, trophy_id, exc,
            )
        return {
            "ok": True,
            "trophy_id": trophy_id,
            "points": points,
            "balance_after": balance_after,
            "celebration": bool(reward.get("celebration_enabled", True)),
        }

    # ------------------------------------------------------------------ #
    # Admin routes (Author Studio)                                       #
    # ------------------------------------------------------------------ #
    @api.get("/admin/achievements/trophies")
    async def admin_list_trophies(admin=Depends(require_admin)):
        return {"trophies": await _load_trophies()}

    @api.put("/admin/achievements/trophies/{trophy_id}")
    async def admin_update_trophy(
        trophy_id: str, payload: dict, admin=Depends(require_admin),
    ):
        existing = await trophies_coll.find_one({"trophy_id": trophy_id}, {"_id": 0})
        if not existing:
            raise HTTPException(404, "Trophy not found")
        if not isinstance(payload, dict):
            raise HTTPException(400, "Body must be JSON")

        updates: dict = {}
        if "enabled" in payload:
            updates["enabled"] = bool(payload["enabled"])
        if "display_order" in payload:
            updates["display_order"] = max(0, int(payload["display_order"] or 0))
        if "name" in payload:
            name = str(payload["name"] or "").strip()[:120]
            if name:
                updates["name"] = name
        if "artwork" in payload:
            updates["artwork"] = str(payload["artwork"] or "").strip()[:500]

        if isinstance(payload.get("requirements"), dict):
            reqs = dict(existing.get("requirements") or _default_requirements())
            for key, _label, _metric in REQUIREMENT_KEYS:
                if key in payload["requirements"]:
                    try:
                        reqs[key] = max(0, int(payload["requirements"][key] or 0))
                    except (TypeError, ValueError):
                        raise HTTPException(400, f"requirements.{key} must be a number")
            updates["requirements"] = reqs

        if isinstance(payload.get("reward"), dict):
            reward = dict(existing.get("reward") or _default_reward())
            rp = payload["reward"]
            if "type" in rp:
                rtype = str(rp["type"] or "points").strip().lower()
                if rtype != "points":
                    raise HTTPException(400, "Only 'points' rewards are supported in Phase 1")
                reward["type"] = rtype
            if "points" in rp:
                try:
                    reward["points"] = max(0, int(rp["points"] or 0))
                except (TypeError, ValueError):
                    raise HTTPException(400, "reward.points must be a number")
            for flag in ("claim_enabled", "one_time", "celebration_enabled"):
                if flag in rp:
                    reward[flag] = bool(rp[flag])
            if "celebration_effect" in rp:
                effect = str(rp["celebration_effect"] or "").strip()
                if effect not in CELEBRATION_EFFECTS:
                    raise HTTPException(
                        400,
                        f"reward.celebration_effect must be one of: {', '.join(CELEBRATION_EFFECTS)}",
                    )
                reward["celebration_effect"] = effect
            updates["reward"] = reward

        if not updates:
            raise HTTPException(400, "No editable fields supplied")

        updates["updated_at"] = _now_iso()
        await trophies_coll.update_one(
            {"trophy_id": trophy_id},
            {"$set": updates, "$inc": {"version": 1}},
        )
        doc = await trophies_coll.find_one({"trophy_id": trophy_id}, {"_id": 0})
        return {"ok": True, "trophy": doc}

    @api.get("/admin/achievements/claims")
    async def admin_list_claims(limit: int = 50, admin=Depends(require_admin)):
        limit_safe = max(1, min(int(limit), 200))
        cur = claims_coll.find({}, {"_id": 0}).sort("claimed_at", -1).limit(limit_safe)
        rows = [c async for c in cur]
        return {"claims": rows, "count": len(rows)}

    # ------------------------------------------------------------------ #
    # Haptics global switch (read-only for students)                     #
    # ------------------------------------------------------------------ #
    @api.get("/achievements/haptics")
    async def achievements_haptics(student=Depends(require_student)):
        """Effective value of the HAPTICS_ENABLED platform-config flag
        (published override > env var > default ON). Admins manage it from
        Author Studio -> Platform Config -> flag name HAPTICS_ENABLED.
        Resolver failure degrades to enabled — haptics are harmless."""
        try:
            from eduhub_platform.config import resolve_bool_flag
            enabled, source = await resolve_bool_flag(db, "HAPTICS_ENABLED", default=True)
        except Exception as exc:  # noqa: BLE001
            log.warning("achievements: haptics flag resolve failed: %s", exc)
            enabled, source = True, "default"
        return {"enabled": bool(enabled), "source": source}

    log.info("achievement_tools: routes registered (Achievement Center Phase 1)")
