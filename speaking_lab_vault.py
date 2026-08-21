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
  * NOT a modification of Mystery Box's box-layout weighting function —
    ``_mbt_resolve_campaign_layout`` in mystery_box_tools.py is never
    changed. "Mystery Box Boost" (see ``mbt_create_round``'s optional
    ``boosted`` flag, additive/default-off) calls that SAME unmodified
    function multiple times and keeps the best roll — a wrapper, not a
    rewrite.
  * NOT a modification of the Lucky Draw's protected, hash-tested core —
    ``_weighted_pick``, ``_normalize_split``, ``_run_draw`` in
    lucky_draw.py are never imported, called, or edited by this module.
    "Multiplier" (``apply_vault_bonuses_to_draw`` below) instead adjusts
    the stored ``amount`` on a PREPARED-BUT-NOT-YET-FINALIZED
    ``speaking_lab_lucky_draws`` document — a plain, guarded, idempotent
    update on data those protected functions already produced, applied
    strictly before ``_finalize_draw`` (also untouched) ever reads it.
    Who wins and the base split are entirely decided by the unmodified
    protected functions; this module can only add a capped bonus on top,
    and only to a draw that hasn't started paying out yet.
  * NOT a new financial primitive — every money-moving call in this
    module is either the existing ``credit_via_treasury`` hook (base
    grants, Team Vault's class bonus) or a bounded, idempotent adjustment
    to an existing, not-yet-paid Lucky Draw amount (Multiplier) that
    still settles through the existing, unmodified payout pipeline.

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
TEAM_COLLECTION = "speaking_lab_vault_team_state"   # one doc per session_id
SESSIONS_COLLECTION = "speaking_lab_sessions"       # read-only here
LUCKY_CODES_COLLECTION = "speaking_lab_lucky_codes"  # read-only here
DRAWS_COLLECTION = "speaking_lab_lucky_draws"       # read + guarded write here

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
HARD_CAP_TEAM_THRESHOLD = 20  # never require more than 20 tokens to trigger
HARD_CAP_TEAM_BONUS = 20      # never credit more than 20 pts/student on trigger
DEFAULT_BASE_MIN = 5
DEFAULT_BASE_MAX = 15
DEFAULT_MULTIPLIER = 1.5
DEFAULT_RISK_WIN_PROBABILITY = 0.5
DEFAULT_TEAM_VAULT_THRESHOLD = 3
DEFAULT_TEAM_VAULT_BONUS = 5


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
    team_vault_threshold = max(1, min(int(doc.get("team_vault_threshold") or DEFAULT_TEAM_VAULT_THRESHOLD), HARD_CAP_TEAM_THRESHOLD))
    team_vault_bonus = max(1, min(int(doc.get("team_vault_bonus") or DEFAULT_TEAM_VAULT_BONUS), HARD_CAP_TEAM_BONUS))
    return {
        "enabled_types": enabled,
        "rotation_mode": rotation_mode,
        "manual_rule_type": manual_rule_type,
        "base_min": base_min,
        "base_max": base_max,
        "multiplier": multiplier,
        "risk_win_probability": risk_win_probability,
        "team_vault_threshold": team_vault_threshold,
        "team_vault_bonus": team_vault_bonus,
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


async def get_vault_tokens_status(db, session_id: str) -> dict:
    """Read-only summary of this session's active tokens, grouped by
    mechanic — the single source the frontend/teacher-console consults to
    know which students hold which effect. Never mutates anything."""
    session_id = (session_id or "").strip()
    by_type: dict[str, list[str]] = {}
    cursor = db[GRANTS_COLLECTION].find(
        {"session_id": session_id, "status": "granted"},
        {"_id": 0, "rule_type": 1, "student_id": 1},
    )
    async for row in cursor:
        by_type.setdefault(row.get("rule_type"), []).append(row.get("student_id"))

    config = await _read_config(db)
    team_state = await db[TEAM_COLLECTION].find_one({"_id": session_id}, {"_id": 0})
    team_count = len(set(by_type.get("team_vault", [])))
    return {
        "double_ticket_student_ids": sorted(set(by_type.get("double_ticket", []))),
        "multiplier_student_ids": sorted(set(by_type.get("multiplier", []))),
        "box_boost_student_ids": sorted(set(by_type.get("box_boost", []))),
        "team_vault": {
            "count": team_count,
            "threshold": config["team_vault_threshold"],
            "bonus_amount": config["team_vault_bonus"],
            "triggered": bool((team_state or {}).get("triggered")),
            "credited_student_ids": list((team_state or {}).get("credited_student_ids") or []),
        },
    }


async def _maybe_trigger_team_vault(
    db, session_id: str, config: dict,
    credit_via_treasury: Optional[Callable[..., Awaitable[dict]]],
    log: logging.Logger,
) -> bool:
    """Returns True only for the single caller whose grant actually
    crossed the threshold and fired the class bonus (so post_vault_grant
    can tell THAT student's own reveal "you just filled the Team Vault!").
    Every other caller — below threshold, or arriving after another
    request already won the claim — returns False.

    Fires AT MOST ONCE per session, the moment the team_vault grant
    count reaches the configured threshold. Credits every student who
    currently holds a lucky code for this session a flat, capped bonus
    via the SAME credit_via_treasury path every other grant in this
    module uses — no new financial primitive, no pool/session-linkage
    dependency (works whether or not a Prize Pool is linked).

    Duplicate-safe: the doc is first guaranteed to exist via an upsert
    keyed ONLY on _id (never risks a duplicate-key error), then the
    actual "did I win the trigger" claim is a plain conditional
    update_one keyed on {_id, triggered: {$ne: True}} — identical
    discipline to lucky_draw.py's own `lucky_draw_done` claim. A second
    concurrent grant crossing the threshold at the same instant simply
    loses the claim (matched_count == 0) and does nothing further."""
    threshold = config["team_vault_threshold"]
    count = await db[GRANTS_COLLECTION].count_documents(
        {"session_id": session_id, "rule_type": "team_vault", "status": "granted"},
    )
    if count < threshold:
        return False

    await db[TEAM_COLLECTION].update_one(
        {"_id": session_id},
        {"$setOnInsert": {"_id": session_id, "created_at": _now_iso()}},
        upsert=True,
    )
    claim = await db[TEAM_COLLECTION].update_one(
        {"_id": session_id, "triggered": {"$ne": True}},
        {"$set": {"triggered": True, "triggered_at": _now_iso(), "count_at_trigger": count}},
    )
    if getattr(claim, "matched_count", 0) == 0:
        return False  # already triggered by an earlier grant — no-op, no double credit

    student_ids = await db[LUCKY_CODES_COLLECTION].distinct("student_id", {"session_id": session_id})
    bonus = config["team_vault_bonus"]
    credited: list[str] = []
    failed: list[str] = []
    if callable(credit_via_treasury) and bonus > 0:
        for sid in student_ids:
            try:
                res = await credit_via_treasury(
                    student_clean_id=sid, points=bonus,
                    campaign_id=f"vault_team_{session_id}",
                    campaign_name="Friday Vault (Team Vault bonus)",
                )
                (credited if res.get("ok") else failed).append(sid)
            except Exception as exc:  # noqa: BLE001 — one student's failure never blocks the rest
                log.warning(
                    "speaking_lab_vault: team vault credit failed session_id=%s student_id=%s err=%s",
                    session_id, sid, exc,
                )
                failed.append(sid)
    await db[TEAM_COLLECTION].update_one(
        {"_id": session_id},
        {"$set": {
            "bonus_amount": bonus,
            "credited_student_ids": credited,
            "failed_student_ids": failed,
            "settled_at": _now_iso(),
        }},
    )
    return True


async def apply_vault_bonuses_to_draw(db, session_id: str, config: Optional[dict] = None) -> dict:
    """Applies any active "multiplier" vault tokens to the CURRENTLY
    PREPARED (not yet finalized) Lucky Draw for this session, by
    incrementing the affected winners' stored ``amount`` — the exact
    field ``_process_winner`` (unmodified) reads when it eventually pays
    each winner. Must be called between the draw being prepared
    (POST .../lucky-draw) and finalized (POST .../lucky-draw/finalize);
    SpeakingLabPage.jsx's handleLuckyDrawBegin does so automatically.

    Idempotent (an atomic top-level claim guards the whole operation —
    at most one caller ever applies bonuses for a given draw_id) and
    fails safely closed: if the draw is already finalized, or a
    concurrent caller already claimed the application, this is a no-op
    that changes nothing. Base winner selection and the base split
    amount (both computed exclusively by the protected, hash-tested
    _weighted_pick / _normalize_split / _run_draw) are NEVER read from
    or written to by anything other than this bounded `$inc`."""
    session_id = (session_id or "").strip()
    sess = await db[SESSIONS_COLLECTION].find_one(
        {"session_id": session_id}, {"_id": 0, "lucky_draw_prepared_draw_id": 1},
    )
    draw_id = (sess or {}).get("lucky_draw_prepared_draw_id")
    if not draw_id:
        draw = await db[DRAWS_COLLECTION].find_one(
            {"session_id": session_id, "finalized": {"$ne": True}},
            {"_id": 0}, sort=[("prepared_at", -1)],
        )
        draw_id = (draw or {}).get("draw_id")
    if not draw_id:
        return {"applied": False, "reason": "no_prepared_draw"}

    claim = await db[DRAWS_COLLECTION].update_one(
        {"draw_id": draw_id, "finalized": {"$ne": True}, "vault_bonuses_applied": {"$ne": True}},
        {"$set": {"vault_bonuses_applied": True, "vault_bonuses_applied_at": _now_iso()}},
    )
    if getattr(claim, "matched_count", 0) == 0:
        return {"applied": False, "reason": "already_applied_or_finalized", "draw_id": draw_id}

    if config is None:
        config = await _read_config(db)
    multiplier_ids = {
        str(s or "").strip().lower()
        for s in await db[GRANTS_COLLECTION].distinct(
            "student_id_norm", {"session_id": session_id, "rule_type": "multiplier", "status": "granted"},
        )
    }
    draw = await db[DRAWS_COLLECTION].find_one({"draw_id": draw_id}, {"_id": 0})
    boosted = 0
    if multiplier_ids:
        for w in (draw or {}).get("results") or []:
            sid = w.get("student_id")
            if str(sid or "").strip().lower() not in multiplier_ids:
                continue
            base_amount = int(w.get("amount") or 0)
            bonus = int(round(base_amount * (config["multiplier"] - 1.0)))
            if bonus <= 0:
                continue
            await db[DRAWS_COLLECTION].update_one(
                {"draw_id": draw_id, "finalized": {"$ne": True}, "results.student_id": sid},
                {"$inc": {"results.$.amount": bonus}},
            )
            boosted += 1
        if boosted:
            draw = await db[DRAWS_COLLECTION].find_one({"draw_id": draw_id}, {"_id": 0})
    return {
        "applied": True, "boosted_count": boosted, "draw_id": draw_id,
        "winners": (draw or {}).get("results") or [],
    }


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

        team_vault_triggered = False
        if rule_type == "team_vault":
            # Best-effort, never lets a threshold-check/credit problem fail
            # THIS student's own already-successful grant.
            try:
                team_vault_triggered = await _maybe_trigger_team_vault(
                    db, session_id, config, credit_via_treasury, L,
                )
            except Exception as exc:  # noqa: BLE001
                L.warning(
                    "speaking_lab_vault: team vault trigger check failed session_id=%s err=%s",
                    session_id, exc,
                )

        return {
            "enabled": True, "granted": True,
            "rule_type": rule_type, "label": meta["label"],
            "reveal_line": meta["reveal_line"], "amount": amount,
            "risk_outcome": risk_outcome,
            # True only for the ONE student whose grant actually crossed
            # the Team Vault threshold and fired the class-wide bonus.
            "team_vault_triggered": team_vault_triggered,
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
        enabled_db = False
        try:
            enabled_db = await flags.get_vault_db_flag(db)
        except Exception:  # noqa: BLE001
            pass
        env_flag_set = flags.vault_env_flag_set()
        return {
            **config, "types": types, "this_week_rule_type": this_week_rule,
            # "enabled" is the plain, admin-facing toggle — the DB half of
            # the AND-gate. "env_flag_set" is read-only (infra-controlled);
            # "fully_enabled" is what actually governs live behavior — both
            # must be true. Author Studio surfaces all three so the toggle
            # is never misleadingly "on" when it can't actually run yet.
            "enabled": enabled_db,
            "env_flag_set": env_flag_set,
            "fully_enabled": enabled_db and env_flag_set,
        }

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
            "team_vault_threshold": int(body.get("team_vault_threshold") or DEFAULT_TEAM_VAULT_THRESHOLD),
            "team_vault_bonus": int(body.get("team_vault_bonus") or DEFAULT_TEAM_VAULT_BONUS),
            "updated_at": _now_iso(),
            "updated_by": getattr(admin, "email", "") or "",
        }
        await db[SETTINGS_COLLECTION].update_one(
            {"_id": CONFIG_DOC_ID}, {"$set": doc}, upsert=True,
        )
        if "enabled" in body:
            try:
                await flags.set_vault_db_flag(db, bool(body.get("enabled")))
            except Exception as exc:  # noqa: BLE001 — config save must not fail on this
                L.warning("speaking_lab_vault: failed to persist enabled toggle: %s", exc)
        return await get_vault_config(_admin=admin)  # returns the clamped, re-read result

    # ── Read-only token status (who currently holds which mechanic) + the
    # Multiplier settlement hook, called by the frontend between preparing
    # and finalizing a Lucky Draw. ────────────────────────────────────────
    @api.get("/speaking-lab/sessions/{session_id}/vault/tokens")
    async def get_vault_tokens(session_id: str, _admin=Depends(require_admin_dep)) -> dict:
        return await get_vault_tokens_status(db, session_id)

    @api.post("/speaking-lab/sessions/{session_id}/vault/apply-lucky-draw-bonuses")
    async def post_apply_lucky_draw_bonuses(session_id: str, _admin=Depends(require_admin_dep)) -> dict:
        try:
            enabled = await flags.vault_enabled(db)
        except Exception:  # noqa: BLE001
            enabled = False
        if not enabled:
            return {"applied": False, "reason": "disabled"}
        try:
            return await apply_vault_bonuses_to_draw(db, session_id)
        except Exception as exc:  # noqa: BLE001 — never blocks the Lucky Draw cinematic
            L.warning(
                "speaking_lab_vault: apply-lucky-draw-bonuses failed session_id=%s err=%s",
                session_id, exc,
            )
            return {"applied": False, "reason": "error"}


async def ensure_speaking_lab_vault_indexes(db) -> None:
    """Unique index backstop for the grant idempotency claim above — safe
    to call on every startup, mirrors prize_pool.ensure_prize_pool_indexes."""
    await db[GRANTS_COLLECTION].create_index(
        [("session_id", 1), ("round_key", 1), ("student_id_norm", 1)],
        unique=True, name="vault_grant_unique",
    )
