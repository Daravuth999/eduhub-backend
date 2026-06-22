"""voice_treasure_reward_tools.py
=================================
Voice Treasure — final milestone: reward economy, chest, First Voice Card,
progress, collection, and admin reconciliation.

Design guarantees
-----------------
* GAS-authoritative Points credit goes ONLY through voice_treasure_points_adapter
  (treasury → student). Entry debit and reward credit NEVER share a record:
  reward business key = ``vt-reward:{student_id}:{attempt_id}:points``.
* A frozen reward decision is persisted BEFORE any GAS call; later Author Studio
  changes never alter an already-decided attempt (the policy snapshot is stored
  on the record).
* At-most-once concurrent initiation per controlled GAS operation, via an atomic
  created→initiating claim. Duplicate taps / refresh / polling / direct-link
  recovery never credit twice. Status routes NEVER initiate GAS.
* Confirmed non-transfer failure may be explicitly retried with a new operation
  id. Ambiguous outcomes go to reconciliation, keep the chest sealed, and are
  NEVER auto-retried. Reconciliation success resumes local completion without a
  second GAS call. We do NOT claim exactly-once.
* Eligibility is computed only from the persisted backend evaluation + Author
  Studio settings; client-submitted scores/amounts are ignored.
* The First Voice Card is a VT-owned collectible (no GAS). DB duplicate ⇒
  already_owned; storage outage ⇒ storage_failed. If GAS credit succeeds but the
  card fails to persist, GAS is not called again — only the local card is retried.

Wording (verbatim, per spec):
  Voice Treasure provides at-most-once concurrent initiation per controlled GAS
  operation. Confirmed non-transfer outcomes may be explicitly retried;
  ambiguous outcomes require reconciliation.
"""
from __future__ import annotations

import logging
from datetime import datetime, timedelta, timezone
from typing import Any

import voice_treasure_config_tools as vt_cfg
import voice_treasure_entry_tools as vt_entry
import voice_treasure_attempt_tools as vt_attempt
import voice_treasure_points_adapter as vt_points

log = logging.getLogger("eduhub.voice_treasure.reward")

COLL_REWARDS = "voice_treasure_rewards"
COLL_COLLECTION = "voice_treasure_collection"

# Reward transaction states (separate from entry states)
R_CREATED = "created"
R_INITIATING = "initiating"
R_SUCCEEDED = "succeeded"
R_FAILED = "confirmed_failed"
R_RECONCILE = "needs_manual_reconciliation"
R_RETRYABLE = {R_FAILED}            # confirmed non-transfer ⇒ explicit retry ok
R_NEVER_AUTORETRY = {R_RECONCILE}

# Public chest states (derived; never trust client)
CHEST_INELIGIBLE = "ineligible"
CHEST_ELIGIBLE = "eligible_unclaimed"
CHEST_PROCESSING = "processing"
CHEST_RECONCILE = "reconciliation_required"
CHEST_COMPLETED = "completed"
CHEST_FAILED = "confirmed_failed"

# First Voice Card fulfillment states
CARD_NEW = "newly_granted"
CARD_OWNED = "already_owned"
CARD_FAILED = "storage_failed"
CARD_NONE = "not_eligible"

FIRST_VOICE_CARD_ID = "first_voice"


def _utcnow() -> datetime:
    return datetime.now(timezone.utc)


def _iso() -> str:
    return _utcnow().isoformat()


def _reward_key(sid: str, attempt_id: str) -> str:
    return f"vt-reward:{sid}:{attempt_id}:points"


def _card_key(sid: str) -> str:
    return f"vt-card:{sid}:{FIRST_VOICE_CARD_ID}"


# --------------------------------------------------------------------------- #
# Pure decision logic (unit-testable, no I/O)                                  #
# --------------------------------------------------------------------------- #
def compute_reward_decision(
    *, cfg: dict, attempt_result: dict, current_streak: int,
    paid_today_points: int, paid_week_points: int,
) -> dict[str, Any]:
    """Freeze a reward decision from the PERSISTED evaluation + policy. Pure.
    `paid_*_points` are points already CONFIRMED-credited in the window, used to
    enforce payout caps. Returns the frozen decision dict (never trusts client).
    """
    rw = cfg.get("rewards", {}) or {}
    points_enabled = bool(rw.get("points_reward_enabled"))
    card_enabled = bool(rw.get("first_voice_card_enabled"))
    streak_enabled = bool(rw.get("streak_reward_enabled"))

    overall = int((attempt_result or {}).get("overall", 0))
    min_score = int(rw.get("minimum_eligible_score", 60))
    base = int(rw.get("base_points_reward", 0))
    max_reward = int(rw.get("maximum_points_reward", 0))

    points_eligible = bool(points_enabled and overall >= min_score and base >= 0)

    base_points = base if points_eligible else 0

    # high-score bonus
    bonus = 0
    if points_eligible and overall >= int(rw.get("high_score_bonus_threshold", 101)):
        bonus += int(rw.get("high_score_bonus_points", 0))

    # streak bonus (per extra consecutive day, capped)
    streak_bonus = 0
    if points_eligible and streak_enabled and current_streak > 1:
        per = int(rw.get("streak_bonus_points", 0))
        cap = int(rw.get("streak_bonus_max", 0))
        streak_bonus = min(per * (current_streak - 1), cap)

    subtotal = base_points + bonus + streak_bonus
    subtotal = min(subtotal, max_reward) if max_reward > 0 else subtotal

    # payout caps (daily/weekly) — clamp to remaining headroom
    daily_cap = int(rw.get("daily_points_payout_cap", 0))
    weekly_cap = int(rw.get("weekly_points_payout_cap", 0))
    capped = subtotal
    cap_reason = None
    if daily_cap > 0:
        room = max(0, daily_cap - int(paid_today_points))
        if capped > room:
            capped, cap_reason = room, "daily_cap"
    if weekly_cap > 0:
        room = max(0, weekly_cap - int(paid_week_points))
        if capped > room:
            capped, cap_reason = room, "weekly_cap"

    total_points = max(0, int(capped))
    points_eligible = points_eligible and total_points > 0

    card_eligible = bool(card_enabled)  # uniqueness enforced at grant time

    # Real-value grants — earned by score threshold, independent of points caps.
    # One mission/day + per-attempt idempotency bounds these to one each per day.
    voucher_enabled = bool(rw.get("voucher_reward_enabled"))
    pass_enabled = bool(rw.get("edutalk_pass_reward_enabled"))
    voucher_eligible = bool(voucher_enabled and overall >= int(rw.get("voucher_minimum_score", 70)))
    pass_eligible = bool(pass_enabled and overall >= int(rw.get("edutalk_pass_minimum_score", 70)))

    any_reward = bool(points_eligible or card_eligible or voucher_eligible or pass_eligible)
    return {
        "eligible": any_reward,
        "points_eligible": points_eligible,
        "base_points": base_points,
        "high_score_bonus": bonus,
        "streak_bonus": streak_bonus,
        "total_points": total_points,
        "cap_reason": cap_reason,
        "card_eligible": card_eligible,
        "voucher_eligible": voucher_eligible,
        "pass_eligible": pass_eligible,
        "overall_score": overall,
        "min_score": min_score,
        "current_streak": int(current_streak),
        "policy_snapshot": {
            "points_reward_enabled": points_enabled,
            "base_points_reward": base,
            "maximum_points_reward": max_reward,
            "minimum_eligible_score": min_score,
            "high_score_bonus_threshold": int(rw.get("high_score_bonus_threshold", 0)),
            "high_score_bonus_points": int(rw.get("high_score_bonus_points", 0)),
            "streak_reward_enabled": streak_enabled,
            "streak_bonus_points": int(rw.get("streak_bonus_points", 0)),
            "streak_bonus_max": int(rw.get("streak_bonus_max", 0)),
            "first_voice_card_enabled": card_enabled,
            "daily_points_payout_cap": daily_cap,
            "weekly_points_payout_cap": weekly_cap,
            # Voucher / EduTalk Pass params consumed by the injected grantors.
            "voucher_reward_enabled": voucher_enabled,
            "voucher_minimum_score": int(rw.get("voucher_minimum_score", 70)),
            "voucher_source": rw.get("voucher_source", "existing"),
            "voucher_existing_code": rw.get("voucher_existing_code", ""),
            "voucher_discount_type": rw.get("voucher_discount_type", "percent"),
            "voucher_discount_value": rw.get("voucher_discount_value", 0),
            "voucher_title": rw.get("voucher_title", "Voice Treasure Voucher"),
            "voucher_subtitle": rw.get("voucher_subtitle", ""),
            "edutalk_pass_reward_enabled": pass_enabled,
            "edutalk_pass_minimum_score": int(rw.get("edutalk_pass_minimum_score", 70)),
            "edutalk_pass_feature": rw.get("edutalk_pass_feature", "edutalk_session"),
            "edutalk_pass_quantity": int(rw.get("edutalk_pass_quantity", 1)),
            "edutalk_pass_expires_in_days": int(rw.get("edutalk_pass_expires_in_days", 30)),
            "edutalk_pass_eligible_books": list(rw.get("edutalk_pass_eligible_books", []) or []),
        },
        "policy_version": int(cfg.get("policy_version", 1)),
        "decided_at": _iso(),
    }


def classify_chest_state(reward: dict | None, *, decision: dict | None = None) -> str:
    """Map a persisted reward record (and/or a frozen decision) to a public
    chest state. Pure; never reveals an opened chest unless truly completed."""
    if reward is None:
        if decision is not None and not decision.get("eligible"):
            return CHEST_INELIGIBLE
        return CHEST_ELIGIBLE if (decision is None or decision.get("eligible")) else CHEST_INELIGIBLE
    st = reward.get("state")
    if not reward.get("decision", {}).get("eligible", True):
        return CHEST_INELIGIBLE
    if st == R_SUCCEEDED:
        # completed only when local fulfillment is settled too
        return CHEST_COMPLETED if _fulfillment_settled(reward) else CHEST_PROCESSING
    if st == R_INITIATING:
        return CHEST_PROCESSING
    if st == R_RECONCILE:
        return CHEST_RECONCILE
    if st == R_FAILED:
        return CHEST_FAILED
    return CHEST_ELIGIBLE


def _fulfillment_settled(reward: dict) -> bool:
    f = reward.get("fulfillment", {}) or {}
    dec = reward.get("decision", {}) or {}
    points_ok = (not dec.get("points_eligible")) or bool(f.get("points_credited"))
    card_state = f.get("card_state", CARD_NONE)
    card_ok = card_state in (CARD_NEW, CARD_OWNED, CARD_NONE)
    voucher_ok = (not dec.get("voucher_eligible")) or f.get("voucher_state") in ("granted", "skipped")
    pass_ok = (not dec.get("pass_eligible")) or f.get("pass_state") in ("granted", "skipped")
    return points_ok and card_ok and voucher_ok and pass_ok


def _safe_voucher_discount_summary(snap: dict) -> str | None:
    """Pass A.1 — render a student-safe discount summary string from the
    persisted Author Studio voucher policy snapshot. We expose only what
    the Studio captured (discount type + value, configured voucher title).
    No provider payload, no internal stock/source ID, no auto-generated
    coupon code value. Returns None when nothing safe is configured."""
    try:
        dtype = (snap.get("voucher_discount_type") or "").strip()
        dval = snap.get("voucher_discount_value")
        if dtype == "percent" and dval not in (None, ""):
            return f"{int(dval)}% off"
        if dtype == "amount" and dval not in (None, ""):
            return f"${float(dval):g} off"
    except (TypeError, ValueError):
        return None
    return None


def _public_reward_view(reward: dict | None, decision: dict | None) -> dict[str, Any]:
    """Student-safe chest payload. Reveals confirmed reward ONLY when completed.
    Never invents a post-credit balance."""
    state = classify_chest_state(reward, decision=decision)
    out: dict[str, Any] = {"chest_state": state}
    if reward is None:
        if decision:
            out["preview"] = {
                "points_eligible": decision.get("points_eligible"),
                "total_points": decision.get("total_points"),
                "card_eligible": decision.get("card_eligible"),
            }
        return out
    out["attempt_id"] = reward.get("attempt_id")
    out["reward_id"] = reward.get("reward_id")
    if state == CHEST_RECONCILE:
        out["support_reference"] = reward.get("reward_id")
        out["message"] = ("We're confirming your reward with the points service. "
                          "Your chest stays sealed until it's verified — you were not charged again.")
    if state == CHEST_FAILED:
        out["retryable"] = True
        out["message"] = "The reward credit didn't go through. You can try claiming again."
    if state == CHEST_COMPLETED:
        f = reward.get("fulfillment", {}) or {}
        dec = reward.get("decision", {}) or {}
        snap = (dec.get("policy_snapshot") or {})
        # Pass A.1 — student-safe voucher / EduTalk Pass detail blocks for
        # the chest reveal. We populate them ONLY when fulfillment confirmed
        # `granted` and we expose ONLY already-approved student-visible
        # fields. We never expose internal voucher references, stock IDs,
        # provider payloads, admin-only source codes, or auto-generated
        # discount internals. The redemption code is included only if the
        # existing student-safe contract explicitly marked it visible
        # (`student_visible_code: True` on the fulfillment record). Expiry
        # appears only if the fulfillment itself recorded an authoritative
        # value.
        voucher_state = f.get("voucher_state") if dec.get("voucher_eligible") else None
        pass_state = f.get("pass_state") if dec.get("pass_eligible") else None
        voucher_detail = None
        if voucher_state == "granted":
            discount_summary = _safe_voucher_discount_summary(snap)
            voucher_detail = {
                "title": snap.get("voucher_title") or "Voice Treasure Voucher",
                "subtitle": snap.get("voucher_subtitle") or None,
                "discount_summary": discount_summary,
            }
            # Redemption code: only when the existing fulfillment record
            # marked it student-visible (the safe public contract).
            if f.get("student_visible_code") and f.get("voucher_code_public"):
                voucher_detail["redemption_code"] = f["voucher_code_public"]
            if f.get("voucher_expires_at"):
                voucher_detail["expires_at"] = f["voucher_expires_at"]
        pass_detail = None
        if pass_state == "granted":
            pass_detail = {
                "feature": snap.get("edutalk_pass_feature") or None,
                "quantity": int(snap.get("edutalk_pass_quantity") or 1),
            }
            if f.get("pass_expires_at"):
                pass_detail["expires_at"] = f["pass_expires_at"]
            scope = snap.get("edutalk_pass_eligible_books")
            if isinstance(scope, list) and scope:
                # Eligible scope is already student-safe (book slugs the
                # Author Studio configured); empty list means "all books"
                # and stays implicit.
                pass_detail["eligible_books"] = list(scope)
        out["reward"] = {
            "points_credited": int(f.get("credited_points", 0)) if dec.get("points_eligible") else 0,
            "base_points": dec.get("base_points", 0),
            "streak_bonus": dec.get("streak_bonus", 0),
            "high_score_bonus": dec.get("high_score_bonus", 0),
            "first_voice_card": f.get("card_state", CARD_NONE),
            # Bounded enum states for the chest UI to gate the reveal on.
            # Never expose pending / eligible / blocked / failed / absent as
            # won — VoiceTreasureChest renders rows ONLY when state ==
            # "granted".
            "voucher": voucher_state,
            "edutalk_pass": pass_state,
            "voucher_detail": voucher_detail,
            "edutalk_pass_detail": pass_detail,
            "edutalk_pass_feature": (
                snap.get("edutalk_pass_feature")
                if pass_state == "granted" else None
            ),
            "claimed_at": reward.get("completed_at"),
        }
        # Explicit balance contract — never leave it ambiguous and never invent
        # a post-credit balance. GAS sendPoints does not return a trusted
        # balance, so we signal the client to refresh from the authoritative
        # source unless a trusted balance was genuinely captured.
        if reward.get("trusted_balance") is not None:
            out["reward"]["balance_status"] = "trusted"
            out["reward"]["balance"] = reward["trusted_balance"]
        else:
            out["reward"]["balance_status"] = "refresh_required"
            out["reward"]["new_balance"] = None
    return out


# --------------------------------------------------------------------------- #
# Streak / progress (derived from authoritative records)                       #
# --------------------------------------------------------------------------- #
def compute_streaks(evaluated_dates: list[str]) -> dict[str, int]:
    """current + longest streak (consecutive calendar days) from the set of
    dates (YYYY-MM-DD) that have an evaluated attempt. Pure."""
    days = sorted({d for d in evaluated_dates if d})
    if not days:
        return {"current": 0, "longest": 0}
    as_dt = [datetime.strptime(d, "%Y-%m-%d").date() for d in days]
    longest = run = 1
    for i in range(1, len(as_dt)):
        if (as_dt[i] - as_dt[i - 1]).days == 1:
            run += 1
        else:
            run = 1
        longest = max(longest, run)
    # current streak: walk back from the latest day
    current = 1
    for i in range(len(as_dt) - 1, 0, -1):
        if (as_dt[i] - as_dt[i - 1]).days == 1:
            current += 1
        else:
            break
    today = _utcnow().date()
    if (today - as_dt[-1]).days > 1:
        current = 0  # streak broken (no play yesterday/today)
    return {"current": current, "longest": longest}


async def ensure_voice_treasure_reward_indexes(db) -> None:
    try:
        await db[COLL_REWARDS].create_index([("student_id", 1), ("state", 1)])
        await db[COLL_REWARDS].create_index([("student_id", 1), ("completed_at", -1)])
        await db[COLL_COLLECTION].create_index([("student_id", 1)])
    except Exception as exc:  # noqa: BLE001
        log.warning("voice_treasure: reward index ensure failed (non-fatal): %s", exc)


# --------------------------------------------------------------------------- #
# Local fulfillment helpers                                                    #
# --------------------------------------------------------------------------- #
async def _grant_first_voice_card(db, sid: str) -> str:
    """Idempotent, unique-per-student. Returns a CARD_* state."""
    key = _card_key(sid)
    try:
        existing = await db[COLL_COLLECTION].find_one({"_id": key}, {"_id": 0})
        if existing:
            return CARD_OWNED
        await db[COLL_COLLECTION].update_one(
            {"_id": key},
            {"$setOnInsert": {
                "_id": key, "student_id": sid, "card_id": FIRST_VOICE_CARD_ID,
                "name": "First Voice Card", "granted_at": _iso()}},
            upsert=True,
        )
        return CARD_NEW
    except Exception as exc:  # noqa: BLE001 — storage outage, NOT a logic failure
        log.warning("voice_treasure: card persist failed for %s: %s", sid, type(exc).__name__)
        return CARD_FAILED


async def _confirmed_points_in_window(db, sid: str, since_iso: str) -> int:
    total = 0
    try:
        cur = db[COLL_REWARDS].find(
            {"student_id": sid, "state": R_SUCCEEDED, "completed_at": {"$gte": since_iso}},
            {"_id": 0, "fulfillment": 1},
        )
        async for r in cur:
            total += int((r.get("fulfillment") or {}).get("credited_points", 0))
    except Exception:  # noqa: BLE001
        pass
    return total


COLL_PAYOUT_LEDGER = "voice_treasure_payout_ledger"


def _ledger_id(sid: str, window: str, period: str) -> str:
    return f"vt-payout:{sid}:{window}:{period}"


async def _reserve_payout(db, sid: str, amount: int, daily_cap: int, weekly_cap: int) -> bool:
    """Atomically reserve `amount` against the daily and weekly payout caps so
    concurrent claims cannot collectively exceed a cap. Uses conditional
    `$inc` with a literal ceiling (cap - amount) in the filter; if a window
    cannot be reserved, any partial reservation is rolled back. A cap of 0
    means 'no cap' for that window. Returns True on success."""
    if amount <= 0:
        return True
    now = _utcnow()
    today = now.date().isoformat()
    week = f"{now.isocalendar().year}-W{now.isocalendar().week:02d}"
    reserved: list[tuple[str, str]] = []
    try:
        for window, period, cap in (("daily", today, daily_cap), ("weekly", week, weekly_cap)):
            if cap and cap > 0:
                lid = _ledger_id(sid, window, period)
                # ensure the doc exists without counting toward the ceiling
                await db[COLL_PAYOUT_LEDGER].update_one(
                    {"_id": lid}, {"$setOnInsert": {"_id": lid, "student_id": sid,
                                   "window": window, "period": period, "reserved": 0}},
                    upsert=True)
                claimed = await db[COLL_PAYOUT_LEDGER].find_one_and_update(
                    {"_id": lid, "reserved": {"$lte": cap - amount}},
                    {"$inc": {"reserved": amount}, "$set": {"updated_at": _iso()}},
                )
                if not claimed:
                    raise _CapExceeded()
                reserved.append((lid, "daily" if window == "daily" else "weekly"))
        return True
    except _CapExceeded:
        for lid, _w in reserved:  # rollback partial reservation
            await db[COLL_PAYOUT_LEDGER].update_one({"_id": lid}, {"$inc": {"reserved": -amount}})
        return False
    except Exception:  # noqa: BLE001 — ledger failure must not silently overpay
        for lid, _w in reserved:
            await db[COLL_PAYOUT_LEDGER].update_one({"_id": lid}, {"$inc": {"reserved": -amount}})
        return False


async def _release_payout(db, sid: str, amount: int, daily_cap: int, weekly_cap: int) -> None:
    """Release a reservation when GAS definitively did NOT transfer (rejected).
    For ambiguous outcomes the reservation is intentionally kept (conservative:
    points may have moved, so we must not free headroom)."""
    if amount <= 0:
        return
    now = _utcnow()
    today = now.date().isoformat()
    week = f"{now.isocalendar().year}-W{now.isocalendar().week:02d}"
    for window, period, cap in (("daily", today, daily_cap), ("weekly", week, weekly_cap)):
        if cap and cap > 0:
            lid = _ledger_id(sid, window, period)
            try:
                # Decrement, but never below zero. If reserved < amount, clamp to 0.
                dec = await db[COLL_PAYOUT_LEDGER].find_one_and_update(
                    {"_id": lid, "reserved": {"$gte": amount}},
                    {"$inc": {"reserved": -amount}, "$set": {"updated_at": _iso()}},
                )
                if not dec:
                    await db[COLL_PAYOUT_LEDGER].update_one(
                        {"_id": lid}, {"$set": {"reserved": 0, "updated_at": _iso()}})
            except Exception:  # noqa: BLE001
                pass


class _CapExceeded(Exception):
    pass


def register_voice_treasure_reward_routes(
    api, db, require_admin, require_student, *, grantors=None
) -> None:
    from fastapi import Depends, HTTPException, Body

    # Injected real-value grant adapters (provided by server.py, which bridges
    # the exec()'d Login-Reward voucher issuer + EduTalk pass granter into this
    # imported module). Absent ⇒ those reward types simply never grant. Each is
    # an async callable: (*, student_clean_id, attempt_id, policy) -> dict|None.
    _grantors = grantors or {}

    def _sid(student) -> str:
        return str(getattr(student, "student_id", "") or "")

    def _clean(student) -> str:
        return str(getattr(student, "clean_id", "") or getattr(student, "student_id", "") or "")

    def _groups(student) -> list[str]:
        for attr in ("groups", "group", "class_name", "class_id", "level"):
            v = getattr(student, attr, None)
            if isinstance(v, list):
                return v
            if isinstance(v, str) and v.strip():
                return [v.strip()]
        return []

    async def _gate(student):
        cfg = await vt_cfg.load_config(db)
        pub = vt_cfg.public_projection(cfg, student_id=_sid(student), groups=_groups(student))
        if not pub.get("available"):
            raise HTTPException(status_code=403, detail="voice_treasure_unavailable")
        return cfg

    async def _evaluated_attempt(sid: str, attempt_id: str) -> dict:
        a = await db[vt_attempt.COLL_ATTEMPTS].find_one({"_id": attempt_id}, {"_id": 0})
        if not a or a.get("student_id") != sid:
            raise HTTPException(status_code=404, detail="attempt_not_found")
        return a

    async def _streak(sid: str) -> dict:
        dates = []
        try:
            cur = db[vt_attempt.COLL_ATTEMPTS].find(
                {"student_id": sid, "state": vt_attempt.A_EVALUATED}, {"_id": 0, "mission_date": 1})
            async for r in cur:
                if r.get("mission_date"):
                    dates.append(r["mission_date"])
        except Exception:  # noqa: BLE001
            pass
        return compute_streaks(dates)

    async def _freeze_decision(cfg: dict, sid: str, attempt: dict) -> dict:
        streak = await _streak(sid)
        today = _utcnow().date().isoformat()
        week_since = (_utcnow() - timedelta(days=7)).isoformat()
        paid_today = await _confirmed_points_in_window(db, sid, today)
        paid_week = await _confirmed_points_in_window(db, sid, week_since)
        return compute_reward_decision(
            cfg=cfg, attempt_result=attempt.get("result") or {},
            current_streak=streak["current"], paid_today_points=paid_today,
            paid_week_points=paid_week,
        )

    async def _run_local_fulfillment(reward_id: str, sid: str, decision: dict,
                                     credited_points: int) -> dict:
        """Grant all eligible LOCAL rewards (card / voucher / EduTalk pass) and
        return the fulfillment dict. Never calls GAS. Idempotent + retry-safe:

          • card    — idempotent upsert (uniqueness enforced at grant time)
          • voucher — the Login-Reward issuer is idempotent on (campaign, student)
          • pass    — the entitlement granter is NOT idempotent, so we atomically
                      claim the right to grant exactly once via the
                      `fulfillment.pass_granted` flag before calling it.
        """
        current = await db[COLL_REWARDS].find_one({"_id": reward_id}, {"_id": 0}) or {}
        prior = current.get("fulfillment") or {}
        clean_id = current.get("clean_id") or sid
        attempt_id = current.get("attempt_id") or ""
        snap = decision.get("policy_snapshot", {}) or {}

        # ── Card ────────────────────────────────────────────────────────────
        # Retry the grant unless it already reached a terminal-good state, so a
        # prior CARD_FAILED (storage outage) is re-attempted on the next claim.
        card_state = prior.get("card_state") or CARD_NONE
        if decision.get("card_eligible") and card_state not in (CARD_NEW, CARD_OWNED):
            card_state = await _grant_first_voice_card(db, sid)

        # ── Voucher (idempotent issuer — safe to retry) ─────────────────────
        # Re-check the live master switch so it acts as a kill-switch: if it is
        # OFF at claim time we never issue, but we mark "skipped" so the chest
        # still completes (we never leave it stuck on a withdrawn reward).
        voucher_granted = bool(prior.get("voucher_granted"))
        voucher_state = prior.get("voucher_state")
        g_v = _grantors.get("voucher")
        if decision.get("voucher_eligible") and not voucher_granted:
            if g_v and vt_cfg.master_voucher_reward_enabled():
                try:
                    res = await g_v(student_clean_id=clean_id, attempt_id=attempt_id, policy=snap)
                    voucher_granted = bool(res)
                    voucher_state = "granted" if res else "skipped"
                except Exception as exc:  # noqa: BLE001 — never block the chest
                    log.warning("voice_treasure: voucher grant failed: %s", type(exc).__name__)
                    voucher_state = "error"
            else:
                voucher_state = voucher_state or "skipped"  # master off / no bridge

        # ── EduTalk Pass (NOT idempotent — claim-before-grant) ──────────────
        pass_granted = bool(prior.get("pass_granted"))
        pass_state = prior.get("pass_state")
        g_p = _grantors.get("edutalk_pass")
        if decision.get("pass_eligible") and not pass_granted:
            if g_p and vt_cfg.master_edutalk_pass_reward_enabled():
                # Claim the exclusive right to grant via a TOP-LEVEL flag (a
                # nested fulfillment.* field is overwritten by the final $set
                # below, so it must not double as the atomic guard).
                won = await db[COLL_REWARDS].find_one_and_update(
                    {"_id": reward_id, "pass_grant_claimed": {"$ne": True}},
                    {"$set": {"pass_grant_claimed": True, "updated_at": _iso()}},
                )
                if won is not None:
                    try:
                        res = await g_p(student_clean_id=clean_id, attempt_id=attempt_id, policy=snap)
                        pass_granted = True
                        pass_state = "granted" if res else "skipped"
                    except Exception as exc:  # noqa: BLE001
                        log.warning("voice_treasure: pass grant failed: %s", type(exc).__name__)
                        # Release the claim so a later retry can attempt the grant.
                        await db[COLL_REWARDS].update_one(
                            {"_id": reward_id}, {"$set": {"pass_grant_claimed": False}})
                        pass_granted = False
                        pass_state = "error"
                else:
                    pass_granted = True
                    pass_state = pass_state or "granted"
            else:
                pass_state = pass_state or "skipped"  # master off / no bridge

        fulfillment = {
            "points_credited": credited_points > 0 or not decision.get("points_eligible"),
            "credited_points": int(credited_points),
            "card_state": card_state,
            "voucher_granted": voucher_granted,
            "voucher_state": voucher_state,
            "pass_granted": pass_granted,
            "pass_state": pass_state,
        }
        settled = (
            card_state in (CARD_NEW, CARD_OWNED, CARD_NONE)
            and (not decision.get("voucher_eligible") or voucher_state in ("granted", "skipped"))
            and (not decision.get("pass_eligible") or pass_state in ("granted", "skipped"))
        )
        patch = {"fulfillment": fulfillment, "updated_at": _iso()}
        if settled:
            patch["completed_at"] = _iso()
        await db[COLL_REWARDS].update_one({"_id": reward_id}, {"$set": patch})
        return fulfillment

    # ── POST /claim — initiates / advances (the ONLY GAS-initiating route) ──
    @api.post("/voice-treasure/claim")
    async def vt_claim(payload: dict = Body(default=None), student=Depends(require_student)):
        cfg = await _gate(student)
        sid = _sid(student)
        attempt_id = str((payload or {}).get("attempt_id") or "")
        if not attempt_id:
            raise HTTPException(status_code=400, detail="missing_attempt_id")
        attempt = await _evaluated_attempt(sid, attempt_id)
        if attempt.get("state") != vt_attempt.A_EVALUATED:
            raise HTTPException(status_code=409, detail="attempt_not_evaluated")

        rid = _reward_key(sid, attempt_id)
        reward = await db[COLL_REWARDS].find_one({"_id": rid}, {"_id": 0})

        # Idempotent terminal/short-circuit states (NO GAS)
        if reward:
            st = reward.get("state")
            if st == R_SUCCEEDED:
                # ensure local fulfillment settled (retry card only — never GAS)
                if not _fulfillment_settled(reward):
                    await _run_local_fulfillment(
                        rid, sid, reward.get("decision", {}),
                        int((reward.get("fulfillment") or {}).get("credited_points", 0)))
                    reward = await db[COLL_REWARDS].find_one({"_id": rid}, {"_id": 0})
                return {"chest": _public_reward_view(reward, reward.get("decision"))}
            if st == R_INITIATING:
                return {"chest": _public_reward_view(reward, reward.get("decision"))}
            if st == R_RECONCILE:
                return {"chest": _public_reward_view(reward, reward.get("decision"))}
            # confirmed_failed ⇒ explicit retry allowed (new op id below)

        # Freeze decision (only when first creating the record)
        if not reward:
            decision = await _freeze_decision(cfg, sid, attempt)
            seed = {
                "_id": rid, "reward_id": rid, "student_id": sid, "clean_id": _clean(student),
                "attempt_id": attempt_id, "entry_id": attempt.get("entry_id"),
                "evaluation_ref": {"attempt_id": attempt_id, "overall": (attempt.get("result") or {}).get("overall")},
                "decision": decision, "state": R_CREATED,
                "fulfillment": {
                    "points_credited": False, "credited_points": 0, "card_state": None,
                    "voucher_granted": False, "voucher_state": None,
                    "pass_granted": False, "pass_state": None,
                },
                "initiation_count": 0, "last_operation_id": None,
                "state_history": [{"state": R_CREATED, "at": _iso()}],
                "created_at": _iso(), "updated_at": _iso(),
            }
            await db[COLL_REWARDS].update_one({"_id": rid}, {"$setOnInsert": seed}, upsert=True)
            reward = await db[COLL_REWARDS].find_one({"_id": rid}, {"_id": 0})

        decision = reward.get("decision", {})
        if not decision.get("eligible"):
            return {"chest": _public_reward_view(reward, decision)}

        # If only the card is eligible (no points), settle locally without GAS.
        if not decision.get("points_eligible"):
            op_id = vt_points._new_nonce()
            claimed = await db[COLL_REWARDS].find_one_and_update(
                {"_id": rid, "state": {"$in": [R_CREATED, R_FAILED]}},
                {"$set": {"state": R_INITIATING, "last_operation_id": op_id,
                          "last_attempted_at": _iso(), "updated_at": _iso()},
                 "$inc": {"initiation_count": 1},
                 "$push": {"state_history": {"state": R_INITIATING, "at": _iso(), "op": op_id}}},
            )
            if not claimed:
                reward = await db[COLL_REWARDS].find_one({"_id": rid}, {"_id": 0})
                return {"chest": _public_reward_view(reward, decision)}
            await db[COLL_REWARDS].update_one(
                {"_id": rid}, {"$set": {"state": R_SUCCEEDED, "updated_at": _iso()},
                               "$push": {"state_history": {"state": R_SUCCEEDED, "at": _iso(), "op": op_id}}})
            await _run_local_fulfillment(rid, sid, decision, 0)
            reward = await db[COLL_REWARDS].find_one({"_id": rid}, {"_id": 0})
            return {"chest": _public_reward_view(reward, decision)}

        # Points path: enforce master switch at credit time.
        if not vt_cfg.master_points_reward_enabled():
            return {"chest": _public_reward_view(reward, decision)}

        # At-most-once concurrent initiation: atomic created|confirmed_failed → initiating.
        op_id = vt_points._new_nonce()
        claimed = await db[COLL_REWARDS].find_one_and_update(
            {"_id": rid, "state": {"$in": [R_CREATED, R_FAILED]}},
            {"$set": {"state": R_INITIATING, "last_operation_id": op_id,
                      "last_attempted_at": _iso(), "updated_at": _iso(), "last_failure_reason": None},
             "$inc": {"initiation_count": 1},
             "$push": {"state_history": {"state": R_INITIATING, "at": _iso(), "op": op_id}}},
        )
        if not claimed:
            reward = await db[COLL_REWARDS].find_one({"_id": rid}, {"_id": 0})
            return {"chest": _public_reward_view(reward, decision)}

        total = int(decision.get("total_points", 0))
        # F: atomically reserve cap headroom so concurrent claims can't exceed caps.
        snap = decision.get("policy_snapshot", {}) or {}
        daily_cap = int(snap.get("daily_points_payout_cap", 0))
        weekly_cap = int(snap.get("weekly_points_payout_cap", 0))
        reserved_ok = await _reserve_payout(db, sid, total, daily_cap, weekly_cap)
        if not reserved_ok:
            # No headroom: settle as a card-only / no-points completion rather
            # than crediting beyond the cap. Mark succeeded with 0 points.
            await db[COLL_REWARDS].update_one(
                {"_id": rid},
                {"$set": {"state": R_SUCCEEDED, "last_failure_reason": "payout_cap_reached",
                          "updated_at": _iso()},
                 "$push": {"state_history": {"state": R_SUCCEEDED, "at": _iso(), "op": "cap"}}})
            await _run_local_fulfillment(rid, sid, {**decision, "points_eligible": False}, 0)
            reward = await db[COLL_REWARDS].find_one({"_id": rid}, {"_id": 0})
            return {"chest": _public_reward_view(reward, decision)}

        result = await vt_points.credit_reward(_clean(student), total, nonce=op_id)
        outcome = result.get("outcome")

        if outcome == vt_points.OUTCOME_OK:
            await db[COLL_REWARDS].update_one(
                {"_id": rid},
                {"$set": {"state": R_SUCCEEDED, "updated_at": _iso()},
                 "$push": {"state_history": {"state": R_SUCCEEDED, "at": _iso(), "op": op_id}}})
            await _run_local_fulfillment(rid, sid, decision, total)
        elif outcome == vt_points.OUTCOME_REJECTED:
            await _release_payout(db, sid, total, daily_cap, weekly_cap)  # definitively no transfer
            await db[COLL_REWARDS].update_one(
                {"_id": rid},
                {"$set": {"state": R_FAILED, "last_failure_reason": result.get("reason"), "updated_at": _iso()},
                 "$push": {"state_history": {"state": R_FAILED, "at": _iso(), "op": op_id}}})
        else:  # AMBIGUOUS → reconciliation, sealed, never auto-retry; KEEP reservation
            await db[COLL_REWARDS].update_one(
                {"_id": rid},
                {"$set": {"state": R_RECONCILE, "last_failure_reason": result.get("reason"), "updated_at": _iso()},
                 "$push": {"state_history": {"state": R_RECONCILE, "at": _iso(), "op": op_id}}})

        reward = await db[COLL_REWARDS].find_one({"_id": rid}, {"_id": 0})
        return {"chest": _public_reward_view(reward, decision)}

    # ── GET /claim/{attempt_id} — STATUS ONLY (never initiates GAS) ──
    @api.get("/voice-treasure/claim/{attempt_id}")
    async def vt_claim_status(attempt_id: str, student=Depends(require_student)):
        sid = _sid(student)
        rid = _reward_key(sid, attempt_id)
        reward = await db[COLL_REWARDS].find_one({"_id": rid}, {"_id": 0})
        if reward is None:
            # Surface eligibility preview without creating a record or touching GAS.
            attempt = await db[vt_attempt.COLL_ATTEMPTS].find_one({"_id": attempt_id}, {"_id": 0})
            if not attempt or attempt.get("student_id") != sid:
                raise HTTPException(status_code=404, detail="attempt_not_found")
            if attempt.get("state") != vt_attempt.A_EVALUATED:
                return {"chest": {"chest_state": CHEST_INELIGIBLE}}
            cfg = await vt_cfg.load_config(db)
            decision = await _freeze_decision(cfg, sid, attempt)  # preview only; not persisted
            return {"chest": _public_reward_view(None, decision)}
        return {"chest": _public_reward_view(reward, reward.get("decision"))}

    # ── GET /rewards — recent confirmed rewards ──
    @api.get("/voice-treasure/rewards")
    async def vt_rewards(student=Depends(require_student)):
        sid = _sid(student)
        rows = []
        cur = db[COLL_REWARDS].find(
            {"student_id": sid, "state": R_SUCCEEDED}, {"_id": 0}).sort("completed_at", -1).limit(50)
        async for r in cur:
            f = r.get("fulfillment") or {}
            dec = r.get("decision") or {}
            snap = (dec.get("policy_snapshot") or {})
            # Pass A — surface CONFIRMED voucher / EduTalk Pass alongside
            # points + first voice card. Only fields already approved by the
            # student-safe contract are exposed: state is reported as a
            # bounded enum, and a public-facing TITLE is shown (never the
            # internal voucher code, never the existing-code reference, never
            # admin source identifiers, never provider payloads). The
            # Rewards UI renders these rows ONLY when state == "granted".
            voucher_state = f.get("voucher_state") if dec.get("voucher_eligible") else None
            pass_state = f.get("pass_state") if dec.get("pass_eligible") else None
            row = {
                "attempt_id": r.get("attempt_id"),
                "points_credited": int(f.get("credited_points", 0)) if dec.get("points_eligible") else 0,
                "first_voice_card": f.get("card_state", CARD_NONE),
                "claimed_at": r.get("completed_at"),
                "voucher": {
                    "state": voucher_state,        # granted | skipped | error | None
                    "title": snap.get("voucher_title") or "Voice Treasure Voucher"
                              if voucher_state == "granted" else None,
                } if voucher_state else None,
                "edutalk_pass": {
                    "state": pass_state,           # granted | skipped | error | None
                    "feature": snap.get("edutalk_pass_feature") if pass_state == "granted" else None,
                    "quantity": int(snap.get("edutalk_pass_quantity") or 1) if pass_state == "granted" else None,
                } if pass_state else None,
            }
            rows.append(row)
        return {"rewards": rows, "count": len(rows)}

    # ── GET /collection — collectibles owned ──
    @api.get("/voice-treasure/collection")
    async def vt_collection(student=Depends(require_student)):
        sid = _sid(student)
        items = []
        cur = db[COLL_COLLECTION].find({"student_id": sid}, {"_id": 0})
        async for c in cur:
            items.append({"card_id": c.get("card_id"), "name": c.get("name"),
                          "granted_at": c.get("granted_at")})
        return {
            "collectibles": items,
            "first_voice_card_owned": any(i["card_id"] == FIRST_VOICE_CARD_ID for i in items),
        }

    # ── GET /progress — derived from authoritative records ──
    @api.get("/voice-treasure/progress")
    async def vt_progress(student=Depends(require_student)):
        sid = _sid(student)
        # evaluated attempts
        eval_dates, missions_completed, recent = [], 0, []
        cur = db[vt_attempt.COLL_ATTEMPTS].find(
            {"student_id": sid, "state": vt_attempt.A_EVALUATED}, {"_id": 0}).sort("updated_at", -1)
        async for a in cur:
            missions_completed += 1
            if a.get("mission_date"):
                eval_dates.append(a["mission_date"])
            if len(recent) < 10:
                recent.append({"attempt_id": a.get("attempt_id"),
                               "overall": (a.get("result") or {}).get("overall"),
                               "at": a.get("updated_at")})
        streaks = compute_streaks(eval_dates)
        # points spent (confirmed paid entries)
        spent = 0
        cur = db[vt_entry.COLL_ENTRIES].find(
            {"student_id": sid, "state": vt_entry.S_SUCCEEDED}, {"_id": 0, "cost_points": 1})
        async for e in cur:
            spent += int(e.get("cost_points", 0))
        # confirmed points earned + recent rewards
        earned, recent_rewards = 0, []
        cur = db[COLL_REWARDS].find(
            {"student_id": sid, "state": R_SUCCEEDED}, {"_id": 0}).sort("completed_at", -1)
        async for r in cur:
            f = r.get("fulfillment") or {}
            dec = r.get("decision") or {}
            pts = int(f.get("credited_points", 0)) if dec.get("points_eligible") else 0
            earned += pts
            if len(recent_rewards) < 10:
                recent_rewards.append({"attempt_id": r.get("attempt_id"), "points": pts,
                                       "claimed_at": r.get("completed_at")})
        card = await db[COLL_COLLECTION].find_one({"_id": _card_key(sid)}, {"_id": 0})
        return {
            "missions_completed": missions_completed,
            "current_streak": streaks["current"],
            "longest_streak": streaks["longest"],
            "recent_attempts": recent,
            "points_spent": spent,
            "points_earned": earned,
            "first_voice_card_owned": bool(card),
            "recent_rewards": recent_rewards,
        }

    # ── Admin: reward claims, reconciliation queue, analytics, reconcile ──
    @api.get("/admin/voice-treasure/rewards")
    async def vt_admin_rewards(state: str | None = None, limit: int = 100, admin=Depends(require_admin)):
        q: dict[str, Any] = {}
        if state:
            q["state"] = state
        limit = max(1, min(int(limit or 100), 500))
        cur = db[COLL_REWARDS].find(q, {"_id": 0}).sort("updated_at", -1).limit(limit)
        rows = [r async for r in cur]
        return {"rewards": rows, "count": len(rows)}

    @api.get("/admin/voice-treasure/reconciliation-queue")
    async def vt_admin_reconcile_queue(admin=Depends(require_admin)):
        entries = [r async for r in db[vt_entry.COLL_ENTRIES].find(
            {"state": vt_entry.S_RECONCILE}, {"_id": 0}).sort("updated_at", -1).limit(200)]
        rewards = [r async for r in db[COLL_REWARDS].find(
            {"state": R_RECONCILE}, {"_id": 0}).sort("updated_at", -1).limit(200)]
        return {"entry_reconciliation": entries, "reward_reconciliation": rewards,
                "entry_count": len(entries), "reward_count": len(rewards)}

    @api.post("/admin/voice-treasure/rewards/{reward_id}/reconcile")
    async def vt_admin_reconcile(reward_id: str, payload: dict = Body(...), admin=Depends(require_admin)):
        """Explicit, auditable reconciliation resolution. resolved_success
        resumes LOCAL completion WITHOUT another GAS call and KEEPS the cap
        reservation consumed; resolved_failed marks confirmed_failed and RELEASES
        the cap reservation EXACTLY ONCE. The R_RECONCILE→terminal transition is
        atomic, so duplicate/concurrent reconciliations cannot release twice or
        modify a completed reward."""
        outcome = str((payload or {}).get("outcome") or "")
        evidence = str((payload or {}).get("evidence") or "").strip()
        actor = str(getattr(admin, "username", "") or getattr(admin, "user_id", "") or "admin")
        if outcome not in ("resolved_success", "resolved_failed"):
            raise HTTPException(status_code=400, detail="invalid_outcome")
        if not evidence:
            raise HTTPException(status_code=400, detail="evidence_required")
        reward = await db[COLL_REWARDS].find_one({"_id": reward_id}, {"_id": 0})
        if not reward:
            raise HTTPException(status_code=404, detail="reward_not_found")
        if reward.get("state") != R_RECONCILE:
            raise HTTPException(status_code=409, detail="not_in_reconciliation")

        audit = {"actor": actor, "evidence": evidence, "at": _iso(), "outcome": outcome}
        new_state = R_SUCCEEDED if outcome == "resolved_success" else R_FAILED
        # ATOMIC single-winner transition out of R_RECONCILE. Concurrent/duplicate
        # requests find the doc no longer in R_RECONCILE and lose the race.
        claimed = await db[COLL_REWARDS].find_one_and_update(
            {"_id": reward_id, "state": R_RECONCILE},
            {"$set": {"state": new_state, "reconciliation": audit, "reconciled": True,
                      "updated_at": _iso()},
             "$push": {"state_history": {"state": new_state, "at": _iso(), "op": "reconcile"}}},
        )
        if not claimed:
            # Lost the race (already reconciled by a concurrent/duplicate call).
            fresh = await db[COLL_REWARDS].find_one({"_id": reward_id}, {"_id": 0})
            return {"reward": fresh, "already_reconciled": True}

        dec = reward.get("decision", {}) or {}
        snap = dec.get("policy_snapshot", {}) or {}
        if outcome == "resolved_success":
            # reservation REMAINS consumed; resume local fulfillment, no GAS.
            await _run_local_fulfillment(
                reward_id, reward["student_id"], dec,
                int(dec.get("total_points", 0)) if dec.get("points_eligible") else 0)
        else:
            # resolved_failed ⇒ release the held reservation EXACTLY ONCE. The
            # atomic transition above guarantees we reach here only once.
            if dec.get("points_eligible"):
                await _release_payout(
                    db, reward["student_id"], int(dec.get("total_points", 0)),
                    int(snap.get("daily_points_payout_cap", 0)),
                    int(snap.get("weekly_points_payout_cap", 0)))
        fresh = await db[COLL_REWARDS].find_one({"_id": reward_id}, {"_id": 0})
        return {"reward": fresh}

    @api.get("/admin/voice-treasure/analytics")
    async def vt_admin_analytics(admin=Depends(require_admin)):
        async def _count(coll, q):
            try:
                return await db[coll].count_documents(q)
            except Exception:  # noqa: BLE001
                return 0
        missions = await _count(vt_entry.COLL_MISSIONS, {})
        entries_paid = await _count(vt_entry.COLL_ENTRIES, {"state": vt_entry.S_SUCCEEDED})
        attempts_sub = await _count(vt_attempt.COLL_ATTEMPTS, {})
        attempts_eval = await _count(vt_attempt.COLL_ATTEMPTS, {"state": vt_attempt.A_EVALUATED})
        entry_recon = await _count(vt_entry.COLL_ENTRIES, {"state": vt_entry.S_RECONCILE})
        reward_recon = await _count(COLL_REWARDS, {"state": R_RECONCILE})
        # reopen/replacement recovery actions (entries carry admin_actions[])
        reopen_count = replace_count = 0
        try:
            async for e in db[vt_entry.COLL_ENTRIES].find(
                    {"admin_actions": {"$exists": True}}, {"_id": 0, "admin_actions": 1}):
                for a in (e.get("admin_actions") or []):
                    if a.get("action") == "reopen":
                        reopen_count += 1
                    elif a.get("action") == "replace_mission":
                        replace_count += 1
        except Exception:  # noqa: BLE001
            pass
        provider_fail = (await _count(vt_attempt.COLL_ATTEMPTS, {"state": vt_attempt.A_FAILED})
                         + await _count(COLL_REWARDS, {"state": R_FAILED}))
        spent = earned = 0
        async for e in db[vt_entry.COLL_ENTRIES].find({"state": vt_entry.S_SUCCEEDED}, {"_id": 0, "cost_points": 1}):
            spent += int(e.get("cost_points", 0))
        async for r in db[COLL_REWARDS].find({"state": R_SUCCEEDED}, {"_id": 0, "fulfillment": 1, "decision": 1}):
            if (r.get("decision") or {}).get("points_eligible"):
                earned += int((r.get("fulfillment") or {}).get("credited_points", 0))
        return {
            "missions_offered": missions,
            "entries_paid": entries_paid,
            "attempts_submitted": attempts_sub,
            "attempts_evaluated": attempts_eval,
            "points_spent": spent,
            "points_rewarded": earned,
            "net_points_flow": earned - spent,
            "provider_failures": provider_fail,
            "reconciliation_required_entries": entry_recon,
            "reconciliation_required_rewards": reward_recon,
            "reopen_count": reopen_count,
            "replacement_count": replace_count,
        }

    log.info("voice_treasure: reward routes registered (final milestone).")
