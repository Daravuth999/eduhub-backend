"""edutalk_tier_config_tools.py — EduHub EduTalk Phase 3.

Tier-aware AI feature config + Promotions engine.

Isolated FastAPI module. Zero side-effects on import. Registers its routes
into the existing /api APIRouter via register_tier_config_routes().

Phase 3 scope (this file ONLY):
  - Tier defaults CRUD (free / standard / premium / limited_edition)
  - Promotions CRUD (time-bounded discounts / overrides)
  - Pure resolver helpers exported for use by edutalk_tools.py

Hard isolation contract:
  - Reads/writes ONLY the two NEW collections created by this file:
      • edutalk_tier_config   (admin tier defaults, _id = "tier_defaults")
      • edutalk_promotions    (one document per promotion)
  - Does NOT touch ai_result_cache, ai_result_access, ai_tools_config,
    ai_usage_logs, books, students, payments, coupons, tuition, edutalk_config,
    edutalk_sessions, edutalk_messages, or any pre-existing collection.
  - Per-book override resolution (which lives in edutalk_config) is handled
    by edutalk_tools.py — this module only exports the pure helpers it needs.

Env vars read: NONE. Configuration is database-driven.
"""
from __future__ import annotations

import logging
from datetime import datetime, timezone
from typing import Any
from uuid import uuid4

from fastapi import APIRouter, Depends, HTTPException
from pydantic import BaseModel, ConfigDict, Field

log = logging.getLogger("eduhub.edutalk.tier_config")

# --------------------------------------------------------------------------- #
# Collection names — both NEW, isolated, additive.                            #
# --------------------------------------------------------------------------- #
MONGO_TIER_CONFIG_COLLECTION = "edutalk_tier_config"
MONGO_PROMOTIONS_COLLECTION = "edutalk_promotions"

TIER_CONFIG_DOC_ID = "tier_defaults"

VALID_TIERS = ("free", "standard", "premium", "limited_edition")

# --------------------------------------------------------------------------- #
# Defaults — applied automatically when the collection is empty.              #
# Matches the schema in SECTION 5 / BUILD 3 of the Phase 3 build prompt.      #
# --------------------------------------------------------------------------- #
DEFAULT_TIER_CONFIG: dict[str, dict[str, Any]] = {
    "free": {
        "khmer_decoder": True,
        "khmer_decoder_cost": 2,
        "executive_tone": False,
        "executive_tone_cost": 3,
        "edutalk_enabled": False,
        "edutalk_cost": 5,
        "edutalk_replies": 5,
        "score_aware": False,
        "voice_reply": False,
        "voice_cost": 1,
        "session_expiry_minutes": 30,
        "custom_persona": "",
        "custom_voice_id": "",
        "upgrade_prompt_kh": (
            "មុខងារនេះត្រូវការគណនី Premium ឬ Limited Edition។ "
            "សូមតម្លើងគណនីដើម្បីបន្ត។"
        ),
        "upgrade_prompt_en": (
            "This feature requires a Premium or Limited Edition book. "
            "Please upgrade to continue."
        ),
    },
    "standard": {
        "khmer_decoder": True,
        "khmer_decoder_cost": 2,
        "executive_tone": True,
        "executive_tone_cost": 3,
        "edutalk_enabled": True,
        "edutalk_cost": 5,
        "edutalk_replies": 5,
        "score_aware": False,
        "voice_reply": False,
        "voice_cost": 1,
        "session_expiry_minutes": 30,
        "custom_persona": "",
        "custom_voice_id": "",
        "upgrade_prompt_kh": "",
        "upgrade_prompt_en": "",
    },
    "premium": {
        "khmer_decoder": True,
        "khmer_decoder_cost": 2,
        "executive_tone": True,
        "executive_tone_cost": 3,
        "edutalk_enabled": True,
        "edutalk_cost": 8,
        "edutalk_replies": 8,
        "score_aware": True,
        "voice_reply": True,
        "voice_cost": 1,
        "session_expiry_minutes": 30,
        "custom_persona": "",
        "custom_voice_id": "",
        "upgrade_prompt_kh": "",
        "upgrade_prompt_en": "",
    },
    "limited_edition": {
        "khmer_decoder": True,
        "khmer_decoder_cost": 2,
        "executive_tone": True,
        "executive_tone_cost": 3,
        "edutalk_enabled": True,
        "edutalk_cost": 12,
        "edutalk_replies": 10,
        "score_aware": True,
        "voice_reply": True,
        "voice_cost": 1,
        "session_expiry_minutes": 60,
        "custom_persona": "",
        "custom_voice_id": "",
        "upgrade_prompt_kh": "",
        "upgrade_prompt_en": "",
    },
}

# Fields that are PURELY booleans
_BOOL_FIELDS = (
    "khmer_decoder", "executive_tone", "edutalk_enabled",
    "score_aware", "voice_reply",
)
# Fields that are integer point costs / counts (clamped 0..200)
_INT_FIELDS = (
    "khmer_decoder_cost", "executive_tone_cost", "edutalk_cost",
    "edutalk_replies", "voice_cost", "session_expiry_minutes",
)
# Fields that are strings (length-capped)
_STR_FIELDS = (
    "custom_persona", "custom_voice_id",
    "upgrade_prompt_kh", "upgrade_prompt_en",
)


# --------------------------------------------------------------------------- #
# Helpers — time + sanitisation                                               #
# --------------------------------------------------------------------------- #
def _now() -> datetime:
    return datetime.now(timezone.utc)


def _iso(dt: datetime) -> str:
    if dt.tzinfo is None:
        dt = dt.replace(tzinfo=timezone.utc)
    return dt.isoformat()


def _parse_iso(s: str | None) -> datetime | None:
    if not s:
        return None
    try:
        # tolerate both "Z" and "+00:00" suffixes
        cleaned = s.replace("Z", "+00:00") if isinstance(s, str) else s
        dt = datetime.fromisoformat(cleaned)
        if dt.tzinfo is None:
            dt = dt.replace(tzinfo=timezone.utc)
        return dt
    except Exception:  # noqa: BLE001
        return None


def _sanitise_tier_block(raw: dict | None) -> dict:
    """Clamp / coerce a tier-level config dict into safe defaults."""
    out: dict[str, Any] = {}
    if not isinstance(raw, dict):
        raw = {}
    for k in _BOOL_FIELDS:
        if k in raw:
            out[k] = bool(raw[k])
    for k in _INT_FIELDS:
        if k in raw:
            try:
                v = int(raw[k])
            except (TypeError, ValueError):
                continue
            if k == "session_expiry_minutes":
                v = max(5, min(v, 240))
            elif k.endswith("_replies"):
                v = max(1, min(v, 30))
            else:  # costs
                v = max(0, min(v, 200))
            out[k] = v
    for k in _STR_FIELDS:
        if k in raw:
            v = str(raw[k] or "").strip()
            if k == "custom_voice_id":
                v = v[:80]
            elif k.startswith("upgrade_prompt"):
                v = v[:500]
            else:
                v = v[:1500]
            out[k] = v
    # v1.4 — tier-level audio_support_lang (additive).
    # Allowed: "" (inherit global), "khmer", "english".  Any other
    # incoming value collapses to "" (inherit) so existing tiers stay
    # bit-for-bit identical until admin explicitly chooses a value.
    if "audio_support_lang" in raw:
        v_asl = str(raw["audio_support_lang"] or "").strip().lower()[:20]
        out["audio_support_lang"] = v_asl if v_asl in ("khmer", "english") else ""
    return out


def _merge_tier_config(stored: dict | None) -> dict[str, dict[str, Any]]:
    """Merge stored tier doc with defaults so missing keys never break."""
    out: dict[str, dict[str, Any]] = {}
    stored_tiers = stored.get("tiers") if isinstance(stored, dict) else None
    if not isinstance(stored_tiers, dict):
        stored_tiers = {}
    for tier in VALID_TIERS:
        base = dict(DEFAULT_TIER_CONFIG[tier])
        override = stored_tiers.get(tier) or {}
        if isinstance(override, dict):
            for k, v in override.items():
                if v is None:
                    continue
                base[k] = v
        out[tier] = base
    return out


# --------------------------------------------------------------------------- #
# Promotion model + sanitiser                                                 #
# --------------------------------------------------------------------------- #
VALID_PROMO_TARGETS = ("all", "tier", "book")
VALID_PROMO_FEATURES = (
    "edutalk_cost", "voice_cost", "edutalk_replies",
    "khmer_decoder_cost", "executive_tone_cost", "free_first_session",
)
VALID_PROMO_DISCOUNT_TYPES = ("fixed", "percent", "override")


class PromotionPayload(BaseModel):
    model_config = ConfigDict(extra="ignore")
    name: str = Field(..., min_length=1, max_length=120)
    active: bool = True
    target_type: str = Field("all", max_length=10)
    target_tier: str | None = Field(None, max_length=30)
    target_book_slug: str | None = Field(None, max_length=200)
    feature: str = Field(..., max_length=40)
    discount_type: str = Field(..., max_length=10)
    discount_value: float = 0
    start_at: str = Field("", max_length=40)
    end_at: str = Field("", max_length=40)
    show_banner: bool = True
    banner_text_en: str = Field("", max_length=240)
    banner_text_kh: str = Field("", max_length=240)


def _sanitise_promo(p: PromotionPayload, promo_id: str | None = None) -> dict:
    target_type = p.target_type if p.target_type in VALID_PROMO_TARGETS else "all"
    feature = p.feature if p.feature in VALID_PROMO_FEATURES else "edutalk_cost"
    discount_type = (
        p.discount_type if p.discount_type in VALID_PROMO_DISCOUNT_TYPES else "percent"
    )
    target_tier = (p.target_tier or "").strip()
    if target_type != "tier" or target_tier not in VALID_TIERS:
        target_tier = None
    target_book_slug = (p.target_book_slug or "").strip()[:200]
    if target_type != "book" or not target_book_slug:
        target_book_slug = None
    start_at = _parse_iso(p.start_at)
    end_at = _parse_iso(p.end_at)
    doc = {
        "promo_id": promo_id or uuid4().hex[:24],
        "name": p.name.strip()[:120],
        "active": bool(p.active),
        "target_type": target_type,
        "target_tier": target_tier,
        "target_book_slug": target_book_slug,
        "feature": feature,
        "discount_type": discount_type,
        "discount_value": max(0.0, min(float(p.discount_value or 0), 1000.0)),
        "start_at": _iso(start_at) if start_at else "",
        "end_at": _iso(end_at) if end_at else "",
        "show_banner": bool(p.show_banner),
        "banner_text_en": (p.banner_text_en or "").strip()[:240],
        "banner_text_kh": (p.banner_text_kh or "").strip()[:240],
    }
    return doc


# --------------------------------------------------------------------------- #
# Pure resolver helpers — exported for use by edutalk_tools.py                #
# --------------------------------------------------------------------------- #
async def load_tier_config(db) -> dict[str, dict[str, Any]]:
    """Load merged tier defaults. Auto-seeds defaults on first read.

    Reads ONLY edutalk_tier_config. Never touches any other collection.
    """
    col = db[MONGO_TIER_CONFIG_COLLECTION]
    doc = await col.find_one({"_id": TIER_CONFIG_DOC_ID})
    if not doc:
        # Auto-seed defaults on first read so admin UI has something to edit.
        try:
            await col.update_one(
                {"_id": TIER_CONFIG_DOC_ID},
                {"$set": {
                    "tiers": DEFAULT_TIER_CONFIG,
                    "seeded_at": _iso(_now()),
                }},
                upsert=True,
            )
        except Exception as exc:  # noqa: BLE001
            log.warning("edutalk_tier_config: seed write failed: %s", exc)
        return {t: dict(DEFAULT_TIER_CONFIG[t]) for t in VALID_TIERS}
    return _merge_tier_config(doc)


async def has_admin_saved_tier_config(db) -> bool:
    """Return True only when an admin has explicitly saved tier config via UI.

    Auto-seeded documents have `seeded_at` but NOT `updated_by`.
    Admin-saved documents always have `updated_by` (set by PUT route).
    This lets _resolve_effective_book_config distinguish between
    "admin chose these settings" vs "auto-seeded conservative defaults".
    """
    col = db[MONGO_TIER_CONFIG_COLLECTION]
    doc = await col.find_one(
        {"_id": TIER_CONFIG_DOC_ID},
        {"updated_by": 1},
    )
    return bool(doc and doc.get("updated_by"))


async def resolve_active_promotion(
    db,
    *,
    tier: str,
    book_slug: str,
    feature: str,
    now: datetime | None = None,
) -> dict | None:
    """Find the FIRST matching active promotion, if any.

    Match order: book-specific > tier-specific > all. Time-bounded.
    Reads ONLY edutalk_promotions. Never touches any other collection.
    """
    col = db[MONGO_PROMOTIONS_COLLECTION]
    now_dt = now or _now()
    now_iso = _iso(now_dt)
    # Pull a small set of candidate promos for this feature; filter in Python
    # so the ordering by target specificity (book > tier > all) is reliable.
    candidates: list[dict] = []
    async for d in col.find({
        "active": True,
        "feature": feature,
        "$or": [{"start_at": ""}, {"start_at": {"$lte": now_iso}}],
    }).limit(50):
        # Defensive end_at check (string ISO compare works because both are UTC)
        end_at = d.get("end_at") or ""
        if end_at and end_at < now_iso:
            continue
        candidates.append(d)
    if not candidates:
        return None
    # Bucket by specificity
    book_hits, tier_hits, all_hits = [], [], []
    norm_tier = (tier or "").strip().lower()
    norm_slug = (book_slug or "").strip()
    for d in candidates:
        tt = d.get("target_type") or "all"
        if tt == "book" and d.get("target_book_slug") == norm_slug:
            book_hits.append(d)
        elif tt == "tier" and d.get("target_tier") == norm_tier:
            tier_hits.append(d)
        elif tt == "all":
            all_hits.append(d)
    chosen = book_hits or tier_hits or all_hits
    if not chosen:
        return None
    # Most recent start_at wins within a bucket (stable, predictable).
    chosen.sort(key=lambda x: x.get("start_at") or "", reverse=True)
    return chosen[0]


def apply_promotion_to_cost(
    base_cost: int,
    promo: dict | None,
) -> int:
    """Return the post-promotion cost. Never below zero.

    Pure function — no DB, no IO. Safe to call inside hot paths.
    """
    if not promo:
        return max(0, int(base_cost))
    dtype = promo.get("discount_type")
    dval = float(promo.get("discount_value") or 0)
    base = max(0, int(base_cost))
    if dtype == "override":
        # Override: discount_value IS the final cost in points.
        return max(0, int(dval))
    if dtype == "fixed":
        return max(0, int(base - dval))
    if dtype == "percent":
        pct = max(0.0, min(dval, 100.0))
        return max(0, int(round(base * (1 - pct / 100.0))))
    return base


async def list_active_banners(
    db,
    *,
    tier: str,
    book_slug: str,
) -> list[dict]:
    """Return active banner promotions affecting this book (for the reader).

    Reads ONLY edutalk_promotions. Returns minimal student-safe banner fields.
    """
    col = db[MONGO_PROMOTIONS_COLLECTION]
    now_iso = _iso(_now())
    norm_tier = (tier or "").strip().lower()
    norm_slug = (book_slug or "").strip()
    out: list[dict] = []
    async for d in col.find({
        "active": True,
        "show_banner": True,
        "$or": [{"start_at": ""}, {"start_at": {"$lte": now_iso}}],
    }).limit(20):
        end_at = d.get("end_at") or ""
        if end_at and end_at < now_iso:
            continue
        tt = d.get("target_type") or "all"
        matches = (
            tt == "all"
            or (tt == "tier" and d.get("target_tier") == norm_tier)
            or (tt == "book" and d.get("target_book_slug") == norm_slug)
        )
        if not matches:
            continue
        out.append({
            "promo_id": d.get("promo_id", ""),
            "name": d.get("name", ""),
            "banner_text_en": d.get("banner_text_en", ""),
            "banner_text_kh": d.get("banner_text_kh", ""),
            "feature": d.get("feature", ""),
            "end_at": d.get("end_at", ""),
        })
    return out


# --------------------------------------------------------------------------- #
# Route registration                                                          #
# --------------------------------------------------------------------------- #
def register_tier_config_routes(api: APIRouter, db, require_admin, require_student) -> None:
    """Mount tier-config + promotions routes onto the existing /api APIRouter.

    `require_student` is accepted to keep the registration signature
    parallel to register_edutalk_routes / register_premium_ai_routes, even
    though all current routes here are admin-only. Future student-facing
    endpoints in this module would use it.
    """
    _ = require_student  # reserved for future student-facing reads
    tier_col = db[MONGO_TIER_CONFIG_COLLECTION]
    promo_col = db[MONGO_PROMOTIONS_COLLECTION]

    # -------------------- Tier defaults: GET / PUT --------------------
    @api.get("/admin/edutalk-tier-config")
    async def admin_get_tier_config(admin=Depends(require_admin)):
        _ = admin
        # Defensive: even if the Mongo read raises (network blip, transient
        # cluster error, doc shape mismatch), the Author Studio UI must
        # still receive a renderable payload. Falling back to in-memory
        # DEFAULT_TIER_CONFIG keeps the panel functional and lets the admin
        # save a fresh document — which then becomes the new source of truth.
        try:
            tiers = await load_tier_config(db)
            if not isinstance(tiers, dict) or not tiers:
                raise ValueError("load_tier_config returned empty mapping")
        except Exception as exc:  # noqa: BLE001
            log.warning(
                "edutalk_tier_config: load failed, returning defaults: %s", exc,
            )
            tiers = {t: dict(DEFAULT_TIER_CONFIG[t]) for t in VALID_TIERS}
        return {
            "success": True,
            "tiers": tiers,
            "valid_tiers": list(VALID_TIERS),
        }

    @api.put("/admin/edutalk-tier-config")
    async def admin_put_tier_config(payload: dict, admin=Depends(require_admin)):
        if not isinstance(payload, dict):
            raise HTTPException(status_code=400, detail="Body must be a JSON object.")
        incoming = payload.get("tiers") if "tiers" in payload else payload
        if not isinstance(incoming, dict):
            raise HTTPException(
                status_code=400,
                detail="Expected { tiers: { free: {...}, standard: {...}, ... } }.",
            )
        # Load current to preserve untouched tiers/keys.
        current = await load_tier_config(db)
        merged: dict[str, dict[str, Any]] = {}
        for tier in VALID_TIERS:
            base = dict(current.get(tier) or DEFAULT_TIER_CONFIG[tier])
            updates = _sanitise_tier_block(incoming.get(tier))
            base.update(updates)
            merged[tier] = base
        admin_email = str(getattr(admin, "email", "") or getattr(admin, "username", ""))
        await tier_col.update_one(
            {"_id": TIER_CONFIG_DOC_ID},
            {"$set": {
                "tiers": merged,
                "updated_at": _iso(_now()),
                "updated_by": admin_email[:200],
            }},
            upsert=True,
        )
        return {"success": True, "tiers": merged}

    # -------------------- Promotions: list / create / update / delete --
    @api.get("/admin/edutalk-promotions")
    async def admin_list_promotions(admin=Depends(require_admin)):
        _ = admin
        items: list[dict] = []
        async for d in promo_col.find({}).sort("created_at", -1).limit(200):
            d.pop("_id", None)
            items.append(d)
        return {"success": True, "promotions": items}

    @api.post("/admin/edutalk-promotions")
    async def admin_create_promotion(
        payload: PromotionPayload, admin=Depends(require_admin),
    ):
        doc = _sanitise_promo(payload)
        admin_email = str(getattr(admin, "email", "") or getattr(admin, "username", ""))
        doc["created_at"] = _iso(_now())
        doc["created_by"] = admin_email[:200]
        await promo_col.update_one(
            {"promo_id": doc["promo_id"]},
            {"$set": doc},
            upsert=True,
        )
        return {"success": True, "promotion": doc}

    @api.put("/admin/edutalk-promotions/{promo_id}")
    async def admin_update_promotion(
        promo_id: str, payload: PromotionPayload, admin=Depends(require_admin),
    ):
        existing = await promo_col.find_one({"promo_id": promo_id})
        if not existing:
            raise HTTPException(status_code=404, detail="Promotion not found.")
        doc = _sanitise_promo(payload, promo_id=promo_id)
        admin_email = str(getattr(admin, "email", "") or getattr(admin, "username", ""))
        doc["updated_at"] = _iso(_now())
        doc["updated_by"] = admin_email[:200]
        if "created_at" in existing:
            doc["created_at"] = existing["created_at"]
        await promo_col.update_one(
            {"promo_id": promo_id},
            {"$set": doc},
        )
        return {"success": True, "promotion": doc}

    @api.delete("/admin/edutalk-promotions/{promo_id}")
    async def admin_delete_promotion(promo_id: str, admin=Depends(require_admin)):
        _ = admin
        res = await promo_col.delete_one({"promo_id": promo_id})
        if res.deleted_count == 0:
            raise HTTPException(status_code=404, detail="Promotion not found.")
        return {"success": True, "deleted_promo_id": promo_id}

    log.info("edutalk_tier_config: routes registered (tier defaults + promotions)")
