"""voice_treasure_config_tools.py
================================
EduHub — Voice Treasure: configuration foundation (Phase 2).

Additive, isolated module. It DOES NOT touch and DOES NOT import:

  * ai_assistant_voice_tools.py      (adjacent AI Assistant Voice feature)
  * wallet_service.py                (treasury — wired in Phase 3, not here)
  * gemini_engine.py                 (AI Scene Builder)
  * payment / KHQR / CamRapidPay
  * login_reward / referral / voucher / mystery_box
  * service worker / manifest / push registration

It owns ONLY its own MongoDB collection: ``voice_treasure_config``.
No Voice Treasure missions/attempts/claims/entries exist yet — those are
later phases. This module is config + availability + a student-safe public
projection, nothing more.

Mounted onto the existing ``/api`` router by
``register_voice_treasure_config_routes(api, db, require_admin,
require_student)`` — the same four-argument signature every other EduHub
feature module uses.

  Admin endpoints (require_admin)
  -------------------------------
    GET  /api/admin/voice-treasure/config   → full config + effective master state
    PUT  /api/admin/voice-treasure/config   → validate + persist (merge)

  Student endpoint (require_student)
  ----------------------------------
    GET  /api/voice-treasure/config-public  → student-safe subset ONLY

Master environment switches are authoritative UPPER BOUNDS. Author Studio
can never turn ON something a master switch has turned OFF:

    VOICE_TREASURE_ENABLED=0                  (default: disabled)
    VOICE_TREASURE_POINTS_REWARD_ENABLED=0    (default: disabled)
    VOICE_TREASURE_IMAGE_GENERATION_ENABLED=0 (default: disabled)

Defensive by construction: if anything fails to load the feature is simply
unavailable; no existing route is affected.
"""
from __future__ import annotations

import logging
import os
from datetime import datetime, timezone
from typing import Any

log = logging.getLogger("eduhub.voice_treasure")

# --------------------------------------------------------------------------- #
# Storage                                                                     #
# --------------------------------------------------------------------------- #
VT_CONFIG_COLLECTION = "voice_treasure_config"
VT_CONFIG_DOC_ID = "vt_config"

# --------------------------------------------------------------------------- #
# Master environment switches (authoritative upper bounds)                    #
# Unset OR falsey  →  OFF. Feature is disabled by default, by design.         #
# --------------------------------------------------------------------------- #
_TRUEY = {"1", "true", "yes", "on"}


def _env_on(name: str) -> bool:
    return (os.environ.get(name) or "").strip().lower() in _TRUEY


def master_enabled() -> bool:
    return _env_on("VOICE_TREASURE_ENABLED")


def master_points_reward_enabled() -> bool:
    return _env_on("VOICE_TREASURE_POINTS_REWARD_ENABLED")


def master_image_generation_enabled() -> bool:
    return _env_on("VOICE_TREASURE_IMAGE_GENERATION_ENABLED")


# Real-value reward grants are DOUBLE-gated: an infra master env switch (below,
# default OFF) AND the Author Studio toggle. Both must be ON before a voucher or
# EduTalk pass is ever issued — mirroring the points-reward safety model.
def master_voucher_reward_enabled() -> bool:
    return _env_on("VOICE_TREASURE_VOUCHER_REWARD_ENABLED")


def master_edutalk_pass_reward_enabled() -> bool:
    return _env_on("VOICE_TREASURE_EDUTALK_PASS_REWARD_ENABLED")


# Image MODEL name comes from backend config only (never the frontend).
# The adapter (Phase 4) reads this; Phase 2 only stores/echoes it.
def env_image_model_default() -> str:
    return (os.environ.get("VOICE_TREASURE_IMAGE_MODEL") or "").strip()


# --------------------------------------------------------------------------- #
# Default configuration                                                       #
# Safe server-side defaults. Feature OFF, rewards conservative, voucher /     #
# EduTalk-Pass reward types HARD-disabled until their grant paths are wired.  #
# --------------------------------------------------------------------------- #
def default_config() -> dict[str, Any]:
    return {
        "access": {
            "enabled": False,
            "show_home_tile": False,
            "eligible_student_ids": [],      # empty + open_to_all=False ⇒ nobody
            "eligible_groups": [],
            "open_to_all": False,            # when True, all students eligible
            "suspended_student_ids": [],
            "daily_play_limit": 1,  # LOCKED to 1 for this release (one paid mission/student/day)
            "free_first_play": False,
        },
        "entry": {
            "entry_cost_points": 10,
            "minimum_balance_points": 0,
            "reopen_paid_entry_without_recharge": True,
            "technical_failure_policy": "preserve_entry",  # preserve_entry | refund | none
        },
        "images": {
            "image_generation_enabled": False,
            "image_model": env_image_model_default(),   # backend-config only
            "allowed_themes": [
                "daily_life", "school", "work", "travel", "public_places",
                "family_activities", "problem_solving", "nature", "celebrations",
            ],
            "blocked_themes": [],
            "difficulty_mode": "adaptive",   # beginner|intermediate|advanced|adaptive
            "personalization_enabled": True,
            "fallback_mission_enabled": True,
            "scene_overrides": {},   # admin per-scene overrides (enabled/prompt/...)
        },
        "speaking": {
            "minimum_recording_seconds": 5,
            "maximum_recording_seconds": 60,
            "maximum_recording_retries": 2,
            "audio_preview_enabled": True,
            "evaluation_categories": [
                "relevance", "visual_grounding", "detail",
                "organization", "understandable_language",
            ],
            "minimum_eligible_score": 60,    # 0..100
            "feedback_tone": "encouraging",  # encouraging|neutral|strict
        },
        "rewards": {
            "points_reward_enabled": False,
            "base_points_reward": 5,
            "maximum_points_reward": 50,
            "minimum_eligible_score": 60,        # overall 0..100 to earn points
            "high_score_bonus_threshold": 85,    # overall >= ⇒ bonus points
            "high_score_bonus_points": 5,
            "streak_reward_enabled": False,
            "streak_bonus_points": 2,            # per extra consecutive day
            "streak_bonus_max": 10,
            "first_voice_card_enabled": True,     # VT-owned collectible: allowed
            "daily_points_payout_cap": 100,
            "weekly_points_payout_cap": 500,
            # ── Book Voucher reward (issued via the existing Login-Reward
            #    coupon path; double-gated by VOICE_TREASURE_VOUCHER_REWARD_ENABLED) ──
            "voucher_reward_enabled": False,
            "voucher_minimum_score": 70,          # overall 0..100 to earn
            "voucher_source": "existing",         # "existing" | "auto"
            "voucher_existing_code": "",          # source=existing: link this coupon
            "voucher_discount_type": "percent",   # source=auto: "percent" | "amount"
            "voucher_discount_value": 0,          # source=auto: > 0 required
            "voucher_title": "Voice Treasure Voucher",
            "voucher_subtitle": "",
            "voucher_daily_cap": 1,               # max vouchers/day per student
            # ── EduTalk Pass reward (granted via the existing entitlement path;
            #    double-gated by VOICE_TREASURE_EDUTALK_PASS_REWARD_ENABLED) ──
            "edutalk_pass_reward_enabled": False,
            "edutalk_pass_minimum_score": 70,     # overall 0..100 to earn
            "edutalk_pass_feature": "edutalk_session",  # "edutalk_session" | "edutalk_voice"
            "edutalk_pass_quantity": 1,
            "edutalk_pass_expires_in_days": 30,
            "edutalk_pass_eligible_books": [],    # [] = all eligible books
            "edutalk_pass_daily_cap": 1,          # max passes/day per student
        },
        "safety": {
            "preserve_paid_entry_on_provider_failure": True,
            "allow_evaluation_retry": True,
            "manual_reconciliation_enabled": True,
        },
        "updated_at": None,
        "updated_by": None,
        "policy_version": 1,
    }


# Reward types are now integrated via the existing grant paths (Login-Reward
# coupon issuer + EduTalk entitlement granter). They are double-gated by their
# own master env switches (see apply_master_switch_ceiling) rather than being
# unconditionally force-disabled. Kept as an (empty) tuple for back-compat.
REWARD_TYPES_UNAVAILABLE: tuple[str, ...] = ()

# Allowed enum values for validated string fields.
_TECH_FAIL_POLICIES = {"preserve_entry", "refund", "none"}
_DIFFICULTY_MODES = {"beginner", "intermediate", "advanced", "adaptive"}
_FEEDBACK_TONES = {"encouraging", "neutral", "strict"}
_ALLOWED_EVAL_CATEGORIES = {
    "relevance", "visual_grounding", "detail",
    "organization", "understandable_language",
}


# --------------------------------------------------------------------------- #
# Helpers                                                                      #
# --------------------------------------------------------------------------- #
def _utcnow_iso() -> str:
    return datetime.now(timezone.utc).isoformat()


def _norm_id(value: Any) -> str:
    return str(value or "").strip().lower()


def _deep_merge(base: dict, patch: dict) -> dict:
    """One-level-deep merge: top-level groups merged field-by-field. Unknown
    keys in ``patch`` are ignored (defence against client pollution)."""
    out = {k: (dict(v) if isinstance(v, dict) else v) for k, v in base.items()}
    for group, fields in (patch or {}).items():
        if group not in base or not isinstance(base[group], dict):
            continue
        if not isinstance(fields, dict):
            continue
        merged = dict(out[group])
        for k, v in fields.items():
            if k in merged:               # only known fields survive
                merged[k] = v
        out[group] = merged
    return out


class VTValidationError(ValueError):
    """Raised when an admin config update fails validation."""


def validate_config(cfg: dict[str, Any]) -> None:
    """Raise VTValidationError on the first invalid field. Pure function —
    no I/O, fully unit-testable."""
    a, e, im, sp, rw = (
        cfg["access"], cfg["entry"], cfg["images"], cfg["speaking"], cfg["rewards"],
    )

    # ── Entry ──────────────────────────────────────────────────────────── #
    if int(e["entry_cost_points"]) < 0:
        raise VTValidationError("entry_cost_points must be >= 0")
    if int(e["minimum_balance_points"]) < 0:
        raise VTValidationError("minimum_balance_points must be >= 0")
    if e["technical_failure_policy"] not in _TECH_FAIL_POLICIES:
        raise VTValidationError("technical_failure_policy invalid")

    # ── Access / limits ───────────────────────────────────────────────── #
    if int(a["daily_play_limit"]) < 0:
        raise VTValidationError("daily_play_limit must be >= 0")
    # RELEASE LOCK: one paid mission per student per calendar day. Any saved
    # value above 1 is clamped to 1 (multi-play is a future release).
    if int(a["daily_play_limit"]) > 1:
        a["daily_play_limit"] = 1

    # ── Speaking / recording bounds ───────────────────────────────────── #
    mn = int(sp["minimum_recording_seconds"])
    mx = int(sp["maximum_recording_seconds"])
    if mn < 1:
        raise VTValidationError("minimum_recording_seconds must be >= 1")
    if mx <= mn:
        raise VTValidationError(
            "maximum_recording_seconds must be greater than minimum_recording_seconds"
        )
    if mx > 600:
        raise VTValidationError("maximum_recording_seconds must be <= 600")
    if int(sp["maximum_recording_retries"]) < 0:
        raise VTValidationError("maximum_recording_retries must be >= 0")
    score = int(sp["minimum_eligible_score"])
    if not (0 <= score <= 100):
        raise VTValidationError("minimum_eligible_score must be between 0 and 100")
    if sp["feedback_tone"] not in _FEEDBACK_TONES:
        raise VTValidationError("feedback_tone invalid")
    cats = sp.get("evaluation_categories") or []
    if not isinstance(cats, list) or not cats:
        raise VTValidationError("evaluation_categories must be a non-empty list")
    for c in cats:
        if c not in _ALLOWED_EVAL_CATEGORIES:
            raise VTValidationError(f"unknown evaluation category: {c}")

    # ── Images ─────────────────────────────────────────────────────────── #
    if im["difficulty_mode"] not in _DIFFICULTY_MODES:
        raise VTValidationError("difficulty_mode invalid")

    # ── Rewards / caps ─────────────────────────────────────────────────── #
    base_r = int(rw["base_points_reward"])
    max_r = int(rw["maximum_points_reward"])
    if base_r < 0:
        raise VTValidationError("base_points_reward must be >= 0")
    if max_r < 0:
        raise VTValidationError("maximum_points_reward must be >= 0")
    if max_r < base_r:
        raise VTValidationError(
            "maximum_points_reward must be >= base_points_reward"
        )
    if int(rw["daily_points_payout_cap"]) < 0:
        raise VTValidationError("daily_points_payout_cap must be >= 0")
    if int(rw["weekly_points_payout_cap"]) < 0:
        raise VTValidationError("weekly_points_payout_cap must be >= 0")
    if not (0 <= int(rw.get("minimum_eligible_score", 60)) <= 100):
        raise VTValidationError("rewards.minimum_eligible_score must be 0..100")
    if not (0 <= int(rw.get("high_score_bonus_threshold", 85)) <= 100):
        raise VTValidationError("high_score_bonus_threshold must be 0..100")
    if int(rw.get("high_score_bonus_points", 0)) < 0:
        raise VTValidationError("high_score_bonus_points must be >= 0")
    if int(rw.get("streak_bonus_points", 0)) < 0:
        raise VTValidationError("streak_bonus_points must be >= 0")
    if int(rw.get("streak_bonus_max", 0)) < 0:
        raise VTValidationError("streak_bonus_max must be >= 0")

    # ── Voucher reward ─────────────────────────────────────────────────── #
    if not (0 <= int(rw.get("voucher_minimum_score", 70)) <= 100):
        raise VTValidationError("voucher_minimum_score must be 0..100")
    if rw.get("voucher_source") not in {"existing", "auto"}:
        raise VTValidationError("voucher_source must be 'existing' or 'auto'")
    if rw.get("voucher_discount_type") not in {"percent", "amount"}:
        raise VTValidationError("voucher_discount_type must be 'percent' or 'amount'")
    if float(rw.get("voucher_discount_value", 0) or 0) < 0:
        raise VTValidationError("voucher_discount_value must be >= 0")
    if int(rw.get("voucher_daily_cap", 1)) < 0:
        raise VTValidationError("voucher_daily_cap must be >= 0")
    # NOTE: we intentionally do NOT hard-require voucher source config here.
    # validate_config runs BEFORE the master-switch ceiling, so an admin may
    # legitimately submit voucher_reward_enabled=True while the env master is
    # OFF (it is clamped to False on store). The grantor is defensive: an
    # unconfigured source simply yields no voucher (state "skipped"). Author
    # Studio surfaces a soft warning instead.

    # ── EduTalk Pass reward ────────────────────────────────────────────── #
    if not (0 <= int(rw.get("edutalk_pass_minimum_score", 70)) <= 100):
        raise VTValidationError("edutalk_pass_minimum_score must be 0..100")
    if rw.get("edutalk_pass_feature") not in {"edutalk_session", "edutalk_voice"}:
        raise VTValidationError("edutalk_pass_feature must be 'edutalk_session' or 'edutalk_voice'")
    if int(rw.get("edutalk_pass_quantity", 1)) < 1:
        raise VTValidationError("edutalk_pass_quantity must be >= 1")
    if int(rw.get("edutalk_pass_expires_in_days", 30)) < 1:
        raise VTValidationError("edutalk_pass_expires_in_days must be >= 1")
    if int(rw.get("edutalk_pass_daily_cap", 1)) < 0:
        raise VTValidationError("edutalk_pass_daily_cap must be >= 0")
    if not isinstance(rw.get("edutalk_pass_eligible_books", []), list):
        raise VTValidationError("edutalk_pass_eligible_books must be a list")


def apply_master_switch_ceiling(cfg: dict[str, Any]) -> dict[str, Any]:
    """Force-disable anything a master env switch has turned OFF, and
    force-disable reward types whose grant path is unavailable. Returns a
    NEW dict; never mutates the stored config in place at validation time."""
    out = {k: (dict(v) if isinstance(v, dict) else v) for k, v in cfg.items()}
    if not master_image_generation_enabled():
        out["images"]["image_generation_enabled"] = False
    if not master_points_reward_enabled():
        out["rewards"]["points_reward_enabled"] = False
    # Real-value reward grants: clamp to their infra master switch so an admin
    # toggle can never issue a voucher/pass while the env master is OFF.
    if not master_voucher_reward_enabled():
        out["rewards"]["voucher_reward_enabled"] = False
    if not master_edutalk_pass_reward_enabled():
        out["rewards"]["edutalk_pass_reward_enabled"] = False
    # Back-compat: force-disable any still-unverified reward types (empty now).
    for key in REWARD_TYPES_UNAVAILABLE:
        out["rewards"][key] = False
    return out


def _is_eligible(cfg: dict[str, Any], student_id: str, groups: list[str] | None) -> bool:
    a = cfg["access"]
    sid = _norm_id(student_id)
    if sid in {_norm_id(x) for x in (a.get("suspended_student_ids") or [])}:
        return False
    if a.get("open_to_all"):
        return True
    if sid in {_norm_id(x) for x in (a.get("eligible_student_ids") or [])}:
        return True
    grp = {_norm_id(x) for x in (groups or [])}
    if grp and grp.intersection({_norm_id(x) for x in (a.get("eligible_groups") or [])}):
        return True
    return False


def effective_state(cfg: dict[str, Any]) -> dict[str, Any]:
    """Master-switch-aware effective flags (student-independent)."""
    eff = apply_master_switch_ceiling(cfg)
    feature_on = master_enabled() and bool(eff["access"]["enabled"])
    return {
        "master_enabled": master_enabled(),
        "master_points_reward_enabled": master_points_reward_enabled(),
        "master_image_generation_enabled": master_image_generation_enabled(),
        "master_voucher_reward_enabled": master_voucher_reward_enabled(),
        "master_edutalk_pass_reward_enabled": master_edutalk_pass_reward_enabled(),
        "feature_available": feature_on,
        "show_home_tile": feature_on and bool(eff["access"]["show_home_tile"]),
        "image_generation_effective": bool(eff["images"]["image_generation_enabled"]),
        "points_reward_effective": bool(eff["rewards"]["points_reward_enabled"]),
        "voucher_reward_effective": bool(eff["rewards"]["voucher_reward_enabled"]),
        "edutalk_pass_reward_effective": bool(eff["rewards"]["edutalk_pass_reward_enabled"]),
    }


def public_projection(
    cfg: dict[str, Any], student_id: str, groups: list[str] | None = None
) -> dict[str, Any]:
    """Student-SAFE subset. NEVER leaks eligible lists, blocked themes,
    internal caps, image model, suspension lists, or private reward policy."""
    eff = apply_master_switch_ceiling(cfg)
    feature_on = master_enabled() and bool(eff["access"]["enabled"])
    eligible = feature_on and _is_eligible(cfg, student_id, groups)

    a, e, im, sp, rw = (
        eff["access"], eff["entry"], eff["images"], eff["speaking"], eff["rewards"],
    )
    return {
        "available": bool(eligible),
        # Tile only when the student is actually eligible.
        "show_home_tile": bool(eligible and a["show_home_tile"]),
        "entry": {
            "entry_cost_points": int(e["entry_cost_points"]),
            "minimum_balance_points": int(e["minimum_balance_points"]),
            "free_first_play": bool(a["free_first_play"]),
        },
        "limits": {
            "daily_play_limit": int(a["daily_play_limit"]),
        },
        "speaking": {
            "minimum_recording_seconds": int(sp["minimum_recording_seconds"]),
            "maximum_recording_seconds": int(sp["maximum_recording_seconds"]),
            "maximum_recording_retries": int(sp["maximum_recording_retries"]),
            "audio_preview_enabled": bool(sp["audio_preview_enabled"]),
            "evaluation_categories": list(sp["evaluation_categories"]),
            "feedback_tone": sp["feedback_tone"],
        },
        "images": {
            "difficulty_mode": im["difficulty_mode"],
            # NOTE: image_model, blocked_themes intentionally omitted.
        },
        "rewards": {
            # Only advertise reward types that are actually deliverable (post
            # master-switch ceiling — these reflect infra master AND admin).
            "points_reward_enabled": bool(rw["points_reward_enabled"]),
            "first_voice_card_enabled": bool(rw["first_voice_card_enabled"]),
            "voucher_reward_available": bool(rw["voucher_reward_enabled"]),
            "edutalk_pass_reward_available": bool(rw["edutalk_pass_reward_enabled"]),
        },
    }


# --------------------------------------------------------------------------- #
# Persistence                                                                  #
# --------------------------------------------------------------------------- #
async def ensure_voice_treasure_indexes(db) -> None:
    """Idempotent. Seeds the default config doc if absent. Safe to call on
    every startup; never resets an existing config."""
    col = db[VT_CONFIG_COLLECTION]
    existing = await col.find_one({"_id": VT_CONFIG_DOC_ID})
    if not existing:
        seed = default_config()
        seed["updated_at"] = _utcnow_iso()
        seed["updated_by"] = "system_default"
        try:
            await col.update_one(
                {"_id": VT_CONFIG_DOC_ID},
                {"$setOnInsert": {**seed, "_id": VT_CONFIG_DOC_ID}},
                upsert=True,
            )
        except Exception as exc:  # noqa: BLE001 — never fatal at startup
            log.warning("voice_treasure: seed config failed (non-fatal): %s", exc)


async def load_config(db) -> dict[str, Any]:
    """Return the stored config merged over current defaults so newly added
    fields always have a value even on an older stored doc."""
    col = db[VT_CONFIG_COLLECTION]
    doc = await col.find_one({"_id": VT_CONFIG_DOC_ID}, {"_id": 0})
    base = default_config()
    if not doc:
        return base
    merged = _deep_merge(base, doc)
    merged["updated_at"] = doc.get("updated_at")
    merged["updated_by"] = doc.get("updated_by")
    return merged


async def save_config(db, patch: dict[str, Any], *, updated_by: str) -> dict[str, Any]:
    """Validate then persist a merged config. Raises VTValidationError if the
    merged result is invalid. Master-switch ceiling is applied to what we
    STORE so a stored 'enabled' can never silently exceed a master OFF."""
    current = await load_config(db)
    merged = _deep_merge(current, patch)
    validate_config(merged)                       # raises on bad input
    merged = apply_master_switch_ceiling(merged)  # clamp to master switches
    merged["updated_at"] = _utcnow_iso()
    merged["updated_by"] = updated_by
    col = db[VT_CONFIG_COLLECTION]
    to_store = {k: v for k, v in merged.items()}
    await col.update_one(
        {"_id": VT_CONFIG_DOC_ID},
        {"$set": to_store},
        upsert=True,
    )
    return merged


# --------------------------------------------------------------------------- #
# Route registration                                                          #
# --------------------------------------------------------------------------- #
def register_voice_treasure_config_routes(
    api, db, require_admin, require_student
) -> None:
    """Mount the Phase 2 config routes. Same 4-arg signature as every other
    EduHub feature module. ``require_admin`` / ``require_student`` are the
    FastAPI dependencies from server.py — never re-imported here."""
    from fastapi import Depends, HTTPException

    def _student_groups(student) -> list[str]:
        # Best-effort: students may carry a group/class field under various
        # names across the schema. Never raises.
        for attr in ("groups", "group", "class_name", "class_id", "level"):
            val = getattr(student, attr, None)
            if isinstance(val, list):
                return val
            if isinstance(val, str) and val.strip():
                return [val.strip()]
        return []

    @api.get("/admin/voice-treasure/config")
    async def vt_admin_get_config(admin=Depends(require_admin)):
        cfg = await load_config(db)
        return {
            "config": cfg,
            "effective": effective_state(cfg),
            "reward_availability": {
                "points": True,
                "first_voice_card": True,
                # Available when their infra master switch is ON; the Author
                # Studio toggle is the second gate.
                "voucher": master_voucher_reward_enabled(),
                "edutalk_pass": master_edutalk_pass_reward_enabled(),
            },
        }

    @api.put("/admin/voice-treasure/config")
    async def vt_admin_put_config(payload: dict, admin=Depends(require_admin)):
        patch = payload.get("config") if isinstance(payload, dict) else None
        if not isinstance(patch, dict):
            raise HTTPException(status_code=400, detail="config object required")
        try:
            merged = await save_config(
                db, patch, updated_by=getattr(admin, "email", None)
                or getattr(admin, "user_id", "admin"),
            )
        except VTValidationError as exc:
            raise HTTPException(status_code=422, detail=str(exc))
        return {
            "config": merged,
            "effective": effective_state(merged),
            "saved": True,
        }

    @api.get("/voice-treasure/config-public")
    async def vt_public_config(student=Depends(require_student)):
        cfg = await load_config(db)
        return public_projection(
            cfg,
            student_id=getattr(student, "student_id", ""),
            groups=_student_groups(student),
        )

    # ── Bundled mission scene library (admin management) ──
    @api.get("/admin/voice-treasure/scenes")
    async def vt_admin_scenes(admin=Depends(require_admin)):
        import voice_treasure_scenes as vt_scenes
        cfg = await load_config(db)
        scenes = vt_scenes.effective_scenes(cfg)
        # Include grounding fields for admin visibility (never sent to students).
        out = []
        for s in scenes:
            base = vt_scenes.SCENES_BY_ID.get(s["scene_id"], {})
            out.append({
                "scene_id": s["scene_id"], "image_ref": s.get("image_ref"),
                "asset_file": s.get("asset_file"), "title": s.get("title"),
                "alt": s.get("alt"), "prompt": s.get("prompt"),
                "difficulty": s.get("difficulty"), "theme": s.get("theme"),
                "enabled": s.get("enabled", True),
                "keyword_hints": base.get("keyword_hints", []),
                "rubric_focus": base.get("rubric_focus", ""),
            })
        return {"scenes": out, "count": len(out)}

    @api.put("/admin/voice-treasure/scenes/{scene_id}")
    async def vt_admin_update_scene(scene_id: str, payload: dict, admin=Depends(require_admin)):
        """Persist a per-scene override (enabled/prompt/difficulty/theme) into
        the config under images.scene_overrides. Validated + saved through the
        normal config path (master-switch ceiling still applies)."""
        import voice_treasure_scenes as vt_scenes
        if scene_id not in vt_scenes.SCENES_BY_ID:
            raise HTTPException(status_code=404, detail="scene_not_found")
        body = payload.get("override") if isinstance(payload, dict) else None
        if not isinstance(body, dict):
            raise HTTPException(status_code=400, detail="override object required")
        allowed = {}
        if "enabled" in body:
            allowed["enabled"] = bool(body["enabled"])
        if isinstance(body.get("prompt"), str):
            allowed["prompt"] = body["prompt"].strip()[:400]
        if body.get("difficulty") in ("beginner", "intermediate", "advanced", "adaptive"):
            allowed["difficulty"] = body["difficulty"]
        if isinstance(body.get("theme"), str) and body["theme"].strip():
            allowed["theme"] = body["theme"].strip()
        cfg = await load_config(db)
        overrides = dict(((cfg.get("images") or {}).get("scene_overrides")) or {})
        cur = dict(overrides.get(scene_id, {}))
        cur.update(allowed)
        overrides[scene_id] = cur
        try:
            merged = await save_config(
                db, {"images": {"scene_overrides": overrides}},
                updated_by=getattr(admin, "email", None) or getattr(admin, "user_id", "admin"))
        except VTValidationError as exc:
            raise HTTPException(status_code=422, detail=str(exc))
        return {"saved": True, "scene_overrides": (merged.get("images") or {}).get("scene_overrides", {})}

    log.info("voice_treasure: config routes registered (Phase 2).")
