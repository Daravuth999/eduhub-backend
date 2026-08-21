"""
speaking_lab_vault.py — The Friday Vault: an additive Phase-1 experience
layer for Speaking Lab (v1.0, dark by default).
=============================================================================

WHAT THIS IS
------------
One new beat wedged between an already-existing teacher Accept and the
already-existing Mystery Box reveal: after the teacher accepts a student's
spoken answer, the frontend calls ``POST .../vault/grant`` once. This
module resolves which "weekly mechanic" is active (a small, human-named
rule that rotates automatically, or an explicit admin override), computes
a small bonus-points amount according to that mechanic's rules, and grants
it through the SAME treasury-credit path Mystery Box's own "points" and
"consolation" prize types already use (``login_reward_hooks.credit_via_treasury``
— see mystery_box_tools.py's ``_mbt_grant_prize``). Nothing here creates a
second wallet, a second ledger, or a browser-only balance.

WHAT THIS IS NOT
----------------
  * NOT a modification of Mystery Box's box-layout weighting
    (``_mbt_resolve_campaign_layout`` in mystery_box_tools.py is never
    imported or touched by this module).
  * NOT a modification of the Lucky Draw (``_weighted_pick``,
    ``_normalize_split``, ``_run_draw`` in lucky_draw.py are never
    imported or touched by this module). Phase 2 is completely unaffected.
  * NOT a new financial primitive — the only money-moving call in this
    entire module is the existing ``credit_via_treasury`` hook, called at
    most once per (session, round, student).

SAFETY CONTRACT (mirrors speaking_lab_feature_flags.py's existing
financial-flag discipline exactly)
-----------------------------------------------------------------
  * Hard-off by default: gated by ``speaking_lab_feature_flags.vault_enabled``,
    the same AND-gate (env var + backend settings document) every other
    Speaking Lab financial flag uses. With the flag off, ``/vault/grant``
    returns ``{"enabled": false}`` immediately and credits nothing.
  * Idempotent: one grant per (session_id, round_key, student_id_norm),
    enforced by a unique index AND a find-before-write check — a retried
    or duplicated client call can never double-credit.
  * Every numeric knob an admin can configure (multiplier, base amount
    range) is clamped to a code-enforced hard ceiling
    (``HARD_CAP_MULTIPLIER`` / ``HARD_CAP_BASE_MAX``) regardless of what's
    stored in the settings document — a misconfiguration can never grant
    an unbounded amount.
  * Non-blocking by design: every exception in the grant path is caught
    and converted into ``{"enabled": true, "granted": false, "error": ...}``
    rather than a 500 — the frontend's contract (see VaultMoment.jsx) is
    to treat any non-success response as "skip the Vault, continue to
    Mystery Box exactly as today," never a blocked or frozen screen.
"""
from __future__ import annotations

import logging
import random
import uuid
from datetime import datetime, timezone
from typing import Any, Awaitable, Callable, Optional

from fastapi import APIRouter, Depends, HTTPException

import speaking_lab_feature_flags as flags

logger = logging.getLogger("eduhub.speaking_lab_vault")

# ── collections ──────────────────────────────────────────────────────────
SETTINGS_COLLECTION = "speaking_lab_settings"   # reuses the SAME flat-doc
CONFIG_DOC_ID = "vault_config"                  # collection speaking_lab
                                                 # feature_flags/settings
                                                 # already live in.
WEEKLY_COLLECTION = "speaking_lab_vault_weekly"
GRANTS_COLLECTION = "speaking_lab_vault_grants"

# ── code-defined capabilities (per CLAUDE.md: "code defines capabilities,
# Author Studio controls the experience") — the SET of possible weekly
# mechanics and their human-facing copy live here, in code. Author Studio
# only toggles which are in the rotation pool and tunes their numeric
# knobs; it can never invent a new mechanic type or exceed the hard caps
# below. ────────────────────────────────────────────────────────────────
VAULT_RULE_TYPES: dict[str, dict[str, str]] = {
    "double_ticket": {
        "label": "Double Spark",
        "reveal_line": "This vault's spark counts double tonight.",
    },
    "multiplier": {
        "label": "Vault Multiplier",
        "reveal_line": "This vault's spark is running hot — everything's amplified.",
    },
    "box_boost": {
        "label": "Mystery Box Boost",
        "reveal_line": "This vault's spark says your next box feels lucky.",
    },
    "team_vault": {
        "label": "Team Vault",
        "reveal_line": "This vault's spark feeds the whole class's shared vault.",
    },
    "risk_reward": {
        "label": "Risk & Reward",
        "reveal_line": "This vault's spark is a gamble — all or nothing.",
    },
    "lucky_protection": {
        "label": "Lucky Protection",
        "reveal_line": "This vault guarantees its strongest spark, no gamble.",
    },
}
DEFAULT_ENABLED_TYPES = list(VAULT_RULE_TYPES.keys())

HARD_CAP_MULTIPLIER = 3.0     # no configured multiplier can ever exceed 3x
HARD_CAP_BASE_MAX = 30        # no configured "base max" can ever exceed 30 pts
DEFAULT_BASE_MIN = 5
DEFAULT_BASE_MAX = 15
DEFAULT_MULTIPLIER = 1.5
DEFAULT_RISK_WIN_PROBABILITY = 0.5


def _now_iso() -> str:
    return datetime.now(timezone.utc).isoformat()


def _iso_week_key(now: Optional[datetime] = None) -> str:
    dt = now or datetime.now(timezone.utc)
    year, week, _ = dt.isocalendar()
    return f"{year}-W{week:02d}"


async def _read_config(db) -> dict:
    """Admin-tunable knobs, clamped to hard caps on every read so a stale
    or hand-edited document can never exceed the code-enforced ceiling."""
    doc = await db[SETTINGS_COLLECTION].find_one({"_id": CONFIG_DOC_ID}, {"_id": 0}) or {}
    enabled = [t for t in (doc.get("enabled_types") or DEFAULT_ENABLED_TYPES) if t in VAULT_RULE_TYPES]
    if not enabled:
        enabled = DEFAULT_ENABLED_TYPES
    rotation_mode = doc.get("rotation_mode") if doc.get("rotation_mode") in ("auto", "manual") else "auto"
    manual_rule_type = doc.get("manual_rule_type")
    if manual_rule_type not in VAULT_RULE_TYPES:
        manual_rule_type = None
    base_min = max(1, min(int(doc.get("base_min") or DEFAULT_BASE_MIN), HARD_CAP_BASE_MAX))
    base_max = max(base_min, min(int(doc.get("base_max") or DEFAULT_BASE_MAX), HARD_CAP_BASE_MAX))
    multiplier = max(1.0, min(float(doc.get("multiplier") or DEFAULT_MULTIPLIER), HARD_CAP_MULTIPLIER))
    risk_win_probability = max(0.0, min(float(doc.get("risk_win_probability") or DEFAULT_RISK_WIN_PROBABILITY), 1.0))
    return {
        "enabled_types": enabled,
        "rotation_mode": rotation_mode,
        "manual_rule_type": manual_rule_type,
        "base_min": base_min,
        "base_max": base_max,
        "multiplier": multiplier,
        "risk_win_probability": risk_win_probability,
    }


async def _resolve_weekly_rule(db, config: dict) -> str:
    """This week's active mechanic. Manual override wins if set; otherwise
    a deterministic, persisted-once-per-week pick from the enabled pool,
    avoiding an immediate repeat of last week's pick when possible. The
    choice is cached in WEEKLY_COLLECTION so every session and every
    student within the same ISO week sees the identical mechanic, and a
    page refresh never re-rolls it."""
    if config["rotation_mode"] == "manual" and config["manual_rule_type"]:
        return config["manual_rule_type"]

    week_key = _iso_week_key()
    existing = await db[WEEKLY_COLLECTION].find_one({"_id": week_key}, {"_id": 0})
    if existing and existing.get("rule_type") in config["enabled_types"]:
        return existing["rule_type"]

    pool = list(config["enabled_types"])
    prev = await db[WEEKLY_COLLECTION].find_one(
        {}, {"_id": 0, "rule_type": 1}, sort=[("decided_at", -1)],
    )
    prev_type = (prev or {}).get("rule_type")
    if prev_type and len(pool) > 1 and prev_type in pool:
        pool = [t for t in pool if t != prev_type] or list(config["enabled_types"])

    chosen = random.Random(week_key).choice(pool)
    await db[WEEKLY_COLLECTION].update_one(
        {"_id": week_key},
        {"$set": {"rule_type": chosen, "decided_at": _now_iso()}},
        upsert=True,
    )
    return chosen


def _resolve_amount(rule_type: str, config: dict) -> tuple[int, Optional[str]]:
    """Returns (amount, risk_outcome). risk_outcome is only set for the
    risk_reward mechanic ("win"/"lose"), for the reveal UI to narrate."""
    base = random.randint(config["base_min"], config["base_max"])
    if rule_type == "double_ticket":
        return base * 2, None
    if rule_type == "multiplier":
        return int(round(base * config["multiplier"])), None
    if rule_type == "lucky_protection":
        return config["base_max"], None  # always the top of the range, no downside
    if rule_type == "risk_reward":
        won = random.random() < config["risk_win_probability"]
        return (base * 2 if won else 0), ("win" if won else "lose")
    # box_boost / team_vault / default — flat base amount
    return base, None


def register_speaking_lab_vault_routes(
    api: APIRouter,
    db,
    require_admin_dep,
    credit_via_treasury: Optional[Callable[..., Awaitable[dict]]],
    push_notify: Optional[Callable[[str, str, str], Awaitable[Any]]] = None,
    log: Optional[logging.Logger] = None,
) -> None:
    """``credit_via_treasury`` and ``push_notify`` are the SAME hooks
    mystery_box_tools.py / speaking_lab_direct_join.py already use — no new
    grant path, no new push delivery path. Both are optional so a caller
    can register this module even if one hook is temporarily unavailable;
    the grant route degrades to a clean error response, never a 500."""
    L = log or logger

    async def _find_grant(session_id: str, round_key: str, student_id_norm: str) -> Optional[dict]:
        return await db[GRANTS_COLLECTION].find_one(
            {"session_id": session_id, "round_key": round_key, "student_id_norm": student_id_norm},
            {"_id": 0},
        )

    @api.post("/speaking-lab/sessions/{session_id}/vault/grant")
    async def post_vault_grant(
        session_id: str, body: dict, _admin=Depends(require_admin_dep),
    ) -> dict:
        try:
            enabled = await flags.vault_enabled(db)
        except Exception:  # noqa: BLE001 — a flag-read failure must fail closed, not 500
            enabled = False
        if not enabled:
            return {"enabled": False}

        student_id = str(body.get("student_id") or "").strip()
        student_name = body.get("student_name")
        round_key = str(body.get("round_key") or "").strip()
        if not student_id or not round_key:
            return {"enabled": True, "granted": False, "error": "student_id and round_key are required"}
        student_id_norm = student_id.strip().lower()

        # Idempotent replay: a granted row is returned as-is, never re-credited.
        existing = await _find_grant(session_id, round_key, student_id_norm)
        if existing and existing.get("status") == "granted":
            return {
                "enabled": True, "granted": True, "duplicate": True,
                "rule_type": existing["rule_type"], "label": existing["label"],
                "reveal_line": existing["reveal_line"], "amount": existing["amount"],
                "risk_outcome": existing.get("risk_outcome"),
            }
        if existing and existing.get("status") == "pending":
            raise HTTPException(status_code=409, detail="Vault grant already in progress for this round.")

        try:
            config = await _read_config(db)
            rule_type = await _resolve_weekly_rule(db, config)
            amount, risk_outcome = _resolve_amount(rule_type, config)
            meta = VAULT_RULE_TYPES[rule_type]
        except Exception as exc:  # noqa: BLE001 — never let a config problem block the round
            L.warning("speaking_lab_vault: rule resolution failed session_id=%s err=%s", session_id, exc)
            return {"enabled": True, "granted": False, "error": "vault configuration unavailable"}

        # Claim the (session, round, student) tuple before touching money —
        # same discipline as mystery_box_tools.py's reveal route and
        # lucky_draw.py's treasury-safety claim.
        pending_doc = {
            "session_id": session_id, "round_key": round_key,
            "student_id": student_id, "student_id_norm": student_id_norm,
            "student_name": student_name or student_id,
            "status": "pending", "rule_type": rule_type,
            "label": meta["label"], "reveal_line": meta["reveal_line"],
            "amount": amount, "risk_outcome": risk_outcome,
            "created_at": _now_iso(),
        }
        if existing and existing.get("status") == "failed":
            await db[GRANTS_COLLECTION].update_one(
                {"session_id": session_id, "round_key": round_key, "student_id_norm": student_id_norm},
                {"$set": pending_doc},
            )
        else:
            try:
                await db[GRANTS_COLLECTION].insert_one({**pending_doc, "id": str(uuid.uuid4())})
            except Exception:  # noqa: BLE001 — duplicate-key race: someone else just claimed it
                dup = await _find_grant(session_id, round_key, student_id_norm)
                if dup and dup.get("status") == "granted":
                    return {
                        "enabled": True, "granted": True, "duplicate": True,
                        "rule_type": dup["rule_type"], "label": dup["label"],
                        "reveal_line": dup["reveal_line"], "amount": dup["amount"],
                        "risk_outcome": dup.get("risk_outcome"),
                    }
                raise HTTPException(status_code=409, detail="Vault grant already in progress for this round.")

        if amount <= 0:
            # Risk & Reward "lose" outcome — nothing to credit, still a real,
            # authoritative, server-decided result, recorded as granted.
            await db[GRANTS_COLLECTION].update_one(
                {"session_id": session_id, "round_key": round_key, "student_id_norm": student_id_norm},
                {"$set": {"status": "granted", "granted_at": _now_iso()}},
            )
        elif not callable(credit_via_treasury):
            await db[GRANTS_COLLECTION].update_one(
                {"session_id": session_id, "round_key": round_key, "student_id_norm": student_id_norm},
                {"$set": {"status": "failed", "error": "treasury credit unavailable"}},
            )
            return {"enabled": True, "granted": False, "error": "treasury credit unavailable"}
        else:
            try:
                res = await credit_via_treasury(
                    student_clean_id=student_id, points=amount,
                    campaign_id=f"vault_{session_id}_{round_key}",
                    campaign_name=f"Friday Vault ({meta['label']})",
                )
                if not res.get("ok"):
                    raise RuntimeError(str(res.get("error") or "credit failed"))
            except Exception as exc:  # noqa: BLE001
                L.warning(
                    "speaking_lab_vault: credit failed session_id=%s student_id=%s err=%s",
                    session_id, student_id, exc,
                )
                await db[GRANTS_COLLECTION].update_one(
                    {"session_id": session_id, "round_key": round_key, "student_id_norm": student_id_norm},
                    {"$set": {"status": "failed", "error": str(exc)[:200]}},
                )
                return {"enabled": True, "granted": False, "error": "vault credit failed"}
            await db[GRANTS_COLLECTION].update_one(
                {"session_id": session_id, "round_key": round_key, "student_id_norm": student_id_norm},
                {"$set": {"status": "granted", "granted_at": _now_iso()}},
            )

        if callable(push_notify) and amount > 0:
            try:
                await push_notify(
                    student_id, "🔐 Friday Vault",
                    f"{meta['label']} — +{amount} pts",
                )
            except Exception:  # noqa: BLE001 — push is best-effort, never blocks the reveal
                pass

        return {
            "enabled": True, "granted": True,
            "rule_type": rule_type, "label": meta["label"],
            "reveal_line": meta["reveal_line"], "amount": amount,
            "risk_outcome": risk_outcome,
        }

    # ── Author Studio admin config (plain, human-readable — no enum-speak
    # reaches this response) ─────────────────────────────────────────────
    @api.get("/admin/speaking-lab/vault-config")
    async def get_vault_config(_admin=Depends(require_admin_dep)) -> dict:
        config = await _read_config(db)
        types = [
            {"type": t, "label": meta["label"], "enabled": t in config["enabled_types"]}
            for t, meta in VAULT_RULE_TYPES.items()
        ]
        this_week_rule = None
        try:
            this_week_rule = await _resolve_weekly_rule(db, config)
        except Exception:  # noqa: BLE001
            pass
        return {**config, "types": types, "this_week_rule_type": this_week_rule}

    @api.put("/admin/speaking-lab/vault-config")
    async def put_vault_config(body: dict, admin=Depends(require_admin_dep)) -> dict:
        enabled_types = [t for t in (body.get("enabled_types") or []) if t in VAULT_RULE_TYPES]
        doc = {
            "enabled_types": enabled_types or DEFAULT_ENABLED_TYPES,
            "rotation_mode": body.get("rotation_mode") if body.get("rotation_mode") in ("auto", "manual") else "auto",
            "manual_rule_type": body.get("manual_rule_type") if body.get("manual_rule_type") in VAULT_RULE_TYPES else None,
            "base_min": int(body.get("base_min") or DEFAULT_BASE_MIN),
            "base_max": int(body.get("base_max") or DEFAULT_BASE_MAX),
            "multiplier": float(body.get("multiplier") or DEFAULT_MULTIPLIER),
            "risk_win_probability": float(body.get("risk_win_probability") or DEFAULT_RISK_WIN_PROBABILITY),
            "updated_at": _now_iso(),
            "updated_by": getattr(admin, "email", "") or "",
        }
        await db[SETTINGS_COLLECTION].update_one(
            {"_id": CONFIG_DOC_ID}, {"$set": doc}, upsert=True,
        )
        return await get_vault_config(_admin=admin)  # returns the clamped, re-read result


async def ensure_speaking_lab_vault_indexes(db) -> None:
    """Unique index backstop for the grant idempotency claim above — safe
    to call on every startup, mirrors prize_pool.ensure_prize_pool_indexes."""
    await db[GRANTS_COLLECTION].create_index(
        [("session_id", 1), ("round_key", 1), ("student_id_norm", 1)],
        unique=True, name="vault_grant_unique",
    )
