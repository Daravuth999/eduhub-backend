"""
lucky_draw.py — Speaking Lab Lucky Draw season-long prize pool.

ADDITIVE ONLY. This module exposes:

  • register_lucky_draw_routes(api, db, sl_publish, gas_url, treasury_id,
                               treasury_password, *, log=None, mock_gas=False,
                               require_admin=None)
        Mounts 4 new endpoints on the existing `api` router:
            POST /api/speaking-lab/sessions/{id}/pool-entry
            GET  /api/speaking-lab/sessions/{id}/pool
            POST /api/speaking-lab/sessions/{id}/lucky-draw
            GET  /api/speaking-lab/sessions/{id}/lucky-codes

  • generate_and_publish_lucky_code(db, sl_publish, session_id, student_id,
                                    display_name, *, amount=0, log=None)
        Generate a unique 4-char lucky code for this (session_id, student_id),
        persist it, and broadcast TWO SSE events:
            • {type: "lucky_code", student_id, display_name, code,
               entry_fee, pool_total, player_count}
            • {type: "pool_update", pool_total, player_count}
        Idempotent — re-calling for the same (session_id, student_id) returns
        the existing code without double-counting the pool.

NO existing function in server.py is modified. The integration points are:
   1. Add `from lucky_draw import register_lucky_draw_routes,
                                   generate_and_publish_lucky_code`
      to server.py imports.
   2. Right before `app.include_router(api)`, call
      `register_lucky_draw_routes(api, db, _sl_publish, GAS_POINTS_LOGIN_URL,
       SL_TREASURY_ID, SL_TREASURY_PASSWORD,
       log=log, require_admin=require_admin)`.
   3. Inside `_sl_try_auto_enter`, immediately after the existing
      `await _sl_publish(session_id, {"type": "entry", ...})` line, add:
        `await generate_and_publish_lucky_code(db, _sl_publish,
            session_id, sender_id, display_name, amount=amount, log=log)`

That's it. All persisted state lives in two new Mongo collections:
   • speaking_lab_lucky_codes   { session_id, student_id, code, display_name,
                                  entry_fee, awarded_at }
   • speaking_lab_lucky_draws   audit row of each draw

GAS calls
---------
For each winner we call GAS sendPoints(treasury -> winner) using the same
shape as `sl_grant_points` in server.py. Pass `mock_gas=True` (or set env
LUCKY_DRAW_MOCK_GAS=1) to skip the GAS call and simulate success — used in
local dev / tests.

Weighted draw
-------------
Players who were NEVER picked by the slot machine during the session get a
2× weight (the "smart diversity" rule). The slot-picked set comes from the
session document's "slot_picks" field if present, otherwise no penalty
applies.  Pool is split per the session's settings doc.
"""

from __future__ import annotations

import asyncio
import logging
import os
import random
import secrets
import string
import uuid
from datetime import datetime, timezone
from typing import Awaitable, Callable, Iterable, Optional

import httpx
from fastapi import APIRouter, Depends, HTTPException, Path, Request
from pydantic import BaseModel, ConfigDict, Field


# ---------------------------------------------------------------------------
# Lucky code generator — [WORD]-[DIGIT 1-9]. 16 words × 9 digits = 144 codes.
# ---------------------------------------------------------------------------

_LUCKY_WORDS = (
    # nature
    "STAR", "MOON", "FIRE", "WAVE", "WIND", "RAIN", "LEAF", "GOLD",
    # action
    "BOLT", "RUSH", "GLOW", "LEAP", "DASH", "ZOOM",
    # power
    "KING", "NOVA",
)
_LUCKY_DIGITS = tuple(str(n) for n in range(1, 10))  # "1".."9"

LUCKY_CODE_POOL_SIZE = len(_LUCKY_WORDS) * len(_LUCKY_DIGITS)  # 144


def _all_codes() -> list[str]:
    return [f"{w}-{d}" for w in _LUCKY_WORDS for d in _LUCKY_DIGITS]


async def _pick_unused_code(db, session_id: str) -> str:
    """Return a code not yet used in this session. O(1) expected; falls back
    to suffix if the whole 144-pool is exhausted (very large class)."""
    used_cursor = db.speaking_lab_lucky_codes.find(
        {"session_id": session_id}, {"_id": 0, "code": 1},
    )
    used: set[str] = set()
    async for row in used_cursor:
        c = row.get("code")
        if c:
            used.add(c)
    candidates = [c for c in _all_codes() if c not in used]
    if candidates:
        return random.choice(candidates)
    # Pool exhausted — append a short random suffix to keep generating uniquely.
    base = random.choice(_all_codes())
    suffix = "".join(random.choices(string.ascii_uppercase + string.digits, k=2))
    return f"{base}{suffix}"


# ---------------------------------------------------------------------------
# Pydantic models
# ---------------------------------------------------------------------------

class PoolEntryBody(BaseModel):
    """Body for POST /sessions/{id}/pool-entry. All fields optional except
    student_id — the typical caller is the P2P auto-enter hook, which has
    the sender id and display name in hand. Direct callers (e.g. a manual
    "force entry" admin button) may also POST here."""
    model_config = ConfigDict(extra="ignore")
    student_id: str = Field(..., min_length=1, max_length=128)
    display_name: Optional[str] = Field(default=None, max_length=128)
    entry_fee: int = Field(default=0, ge=0, le=100000)


class LuckyDrawConfig(BaseModel):
    """Optional override sent by the teacher with POST /lucky-draw. Falls
    back to the session's settings doc, then to the defaults."""
    model_config = ConfigDict(extra="ignore")
    num_winners: Optional[int] = Field(default=None, ge=1, le=3)
    split: Optional[list[int]] = None        # e.g. [50, 30, 20] — percentages
    slot_picks: Optional[list[str]] = None    # student_ids picked by slot during session
    mock: Optional[bool] = None               # force mock GAS for this draw only


DEFAULT_SPLIT = [50, 30, 20]
DEFAULT_NUM_WINNERS = 3


# ---------------------------------------------------------------------------
# Helpers used by both the SSE hook and the HTTP endpoints
# ---------------------------------------------------------------------------

async def _pool_state(db, session_id: str) -> dict:
    """Return {pool_total, player_count, entry_fee_sum} for a session."""
    cursor = db.speaking_lab_lucky_codes.find(
        {"session_id": session_id}, {"_id": 0, "entry_fee": 1},
    )
    total = 0
    count = 0
    async for row in cursor:
        total += int(row.get("entry_fee") or 0)
        count += 1
    return {"pool_total": total, "player_count": count}


async def generate_and_publish_lucky_code(
    db,
    sl_publish: Callable[[str, dict], Awaitable[None]],
    session_id: str,
    student_id: str,
    display_name: str,
    *,
    amount: int = 0,
    log: Optional[logging.Logger] = None,
) -> Optional[dict]:
    """Public helper for `_sl_try_auto_enter` to call. Idempotent.

    Returns the lucky code doc (or None on error — never raises into the
    caller, since this is fire-and-forget)."""
    try:
        # Deduplicate
        existing = await db.speaking_lab_lucky_codes.find_one(
            {"session_id": session_id, "student_id": student_id}, {"_id": 0},
        )
        if existing:
            return existing

        code = await _pick_unused_code(db, session_id)
        awarded_at = datetime.now(timezone.utc).isoformat()
        doc = {
            "session_id":  session_id,
            "student_id":  student_id,
            "display_name": display_name,
            "code":         code,
            "entry_fee":    int(amount or 0),
            "awarded_at":   awarded_at,
        }
        try:
            await db.speaking_lab_lucky_codes.insert_one(dict(doc))
        except Exception as exc:
            # Most likely a unique-index race — fetch the winning insert.
            if log:
                log.info("lucky_draw: insert race for %s/%s: %s",
                         session_id, student_id, str(exc)[:120])
            existing = await db.speaking_lab_lucky_codes.find_one(
                {"session_id": session_id, "student_id": student_id}, {"_id": 0},
            )
            return existing

        # Pool snapshot (after this entry)
        state = await _pool_state(db, session_id)

        # SSE: detailed code reveal (drives LuckyCodeSplash on the teacher screen)
        await sl_publish(session_id, {
            "type":         "lucky_code",
            "student_id":   student_id,
            "display_name": display_name,
            "code":         code,
            "entry_fee":    int(amount or 0),
            "pool_total":   state["pool_total"],
            "player_count": state["player_count"],
            "awarded_at":   awarded_at,
        })
        # SSE: lightweight ticker update (drives PoolTicker)
        await sl_publish(session_id, {
            "type":         "pool_update",
            "pool_total":   state["pool_total"],
            "player_count": state["player_count"],
        })

        if log:
            log.info("lucky_draw: %s got code %s in %s (pool=%d, n=%d)",
                     display_name, code, session_id,
                     state["pool_total"], state["player_count"])
        return doc
    except Exception as exc:  # noqa: BLE001
        if log:
            log.warning("lucky_draw: generate_and_publish error: %s", str(exc)[:200])
        return None


# ---------------------------------------------------------------------------
# Weighted draw
# ---------------------------------------------------------------------------

def _weighted_pick(
    candidates: list[dict], slot_picked: set[str], k: int,
) -> list[dict]:
    """Return k distinct picks. Each candidate has 2× weight if their
    student_id is NOT in slot_picked, else weight 1."""
    pool = list(candidates)
    chosen: list[dict] = []
    while pool and len(chosen) < k:
        weights = [2 if (c.get("student_id") not in slot_picked) else 1 for c in pool]
        idx = random.choices(range(len(pool)), weights=weights, k=1)[0]
        chosen.append(pool.pop(idx))
    return chosen


def _normalize_split(split: list[int], num_winners: int, pool_total: int) -> list[int]:
    """Trim/pad split to num_winners and convert to integer point amounts that
    sum to <= pool_total."""
    parts = list(split)[:num_winners]
    while len(parts) < num_winners:
        parts.append(0)
    s = sum(parts)
    if s <= 0:
        # Even split
        each = pool_total // num_winners
        amounts = [each] * num_winners
        amounts[0] += pool_total - sum(amounts)
        return amounts
    amounts = [(pool_total * p) // s for p in parts]
    # Distribute remainder to the first winner
    remainder = pool_total - sum(amounts)
    if amounts:
        amounts[0] += remainder
    return amounts


# ---------------------------------------------------------------------------
# GAS treasury transfer (sendPoints) — same shape as sl_grant_points
# ---------------------------------------------------------------------------

async def _gas_send_points(
    gas_url: str,
    treasury_id: str,
    treasury_password: str,
    receiver_clean_id: str,
    amount: int,
    *,
    mock: bool,
    log: Optional[logging.Logger] = None,
) -> tuple[bool, str]:
    if mock or not gas_url or not treasury_password:
        if log:
            log.info("lucky_draw[MOCK]: would send %d pts to %s",
                     amount, receiver_clean_id)
        return True, "mock"
    payload = {
        "action":     "sendPoints",
        "id":         treasury_id,
        "password":   treasury_password,
        "receiverId": receiver_clean_id,
        "amount":     str(amount),
        "nonce":      secrets.token_hex(12),
    }
    try:
        async with httpx.AsyncClient(
            timeout=httpx.Timeout(12.0, connect=6.0),
            follow_redirects=True,
        ) as cli:
            r = await cli.post(gas_url, data=payload)
            if r.status_code != 200:
                return False, f"HTTP {r.status_code}"
            try:
                j = r.json()
            except Exception:
                return False, r.text[:200]
            if isinstance(j, dict) and j.get("success") is True:
                return True, "ok"
            return False, str(j.get("message") or j.get("error") or j)[:200]
    except Exception as exc:  # noqa: BLE001
        return False, str(exc)[:200]


# ---------------------------------------------------------------------------
# Route registration
# ---------------------------------------------------------------------------

def register_lucky_draw_routes(
    api: APIRouter,
    db,
    sl_publish: Callable[[str, dict], Awaitable[None]],
    gas_url: str,
    treasury_id: str,
    treasury_password: str,
    *,
    log: Optional[logging.Logger] = None,
    mock_gas: Optional[bool] = None,
    require_admin: Optional[Callable] = None,
    push_notify: Optional[Callable[[str, int, str], Awaitable[None]]] = None,
) -> None:
    """Mount the four /api/speaking-lab/sessions/{id}/... endpoints onto the
    existing `api` router. Safe to call once at server.py startup."""

    log = log or logging.getLogger("lucky_draw")
    if mock_gas is None:
        mock_gas = os.environ.get("LUCKY_DRAW_MOCK_GAS", "").lower() in ("1", "true", "yes")

    # If the caller passed require_admin (e.g. eduhub's FastAPI dependency),
    # use it; otherwise admit any caller (dev mode).
    admin_dep = Depends(require_admin) if require_admin else None

    def _admin(_admin=admin_dep):
        # No-op shim so the function signature stays consistent.
        return _admin

    SL_SESSIONS = db.speaking_lab_sessions
    SL_LUCKY    = db.speaking_lab_lucky_codes

    # ---- POST /pool-entry  (open — usually invoked internally) -----------
    @api.post("/speaking-lab/sessions/{session_id}/pool-entry")
    async def lucky_pool_entry(
        body: PoolEntryBody,
        session_id: str = Path(..., min_length=1, max_length=128),
    ):
        sess = await SL_SESSIONS.find_one({"session_id": session_id}, {"_id": 0})
        if not sess:
            raise HTTPException(status_code=404, detail="Session not found")
        display_name = (body.display_name or body.student_id).strip()
        amount = int(body.entry_fee or sess.get("entry_fee") or 0)

        doc = await generate_and_publish_lucky_code(
            db, sl_publish, session_id, body.student_id,
            display_name, amount=amount, log=log,
        )
        if not doc:
            raise HTTPException(status_code=500, detail="failed to assign lucky code")
        state = await _pool_state(db, session_id)
        return {
            "ok":           True,
            "session_id":   session_id,
            "student_id":   body.student_id,
            "display_name": doc.get("display_name", display_name),
            "code":         doc.get("code"),
            "entry_fee":    int(doc.get("entry_fee") or 0),
            "pool_total":   state["pool_total"],
            "player_count": state["player_count"],
        }

    # ---- GET /pool  (admin) ---------------------------------------------
    if require_admin:
        @api.get("/speaking-lab/sessions/{session_id}/pool")
        async def lucky_pool_get(session_id: str, admin=Depends(require_admin)):
            return await _pool_payload(
                SL_SESSIONS, SL_LUCKY, session_id,
                db=db, sl_publish=sl_publish, log=log,
            )
        @api.get("/speaking-lab/sessions/{session_id}/lucky-codes")
        async def lucky_codes_get(session_id: str, admin=Depends(require_admin)):
            return await _codes_payload(SL_SESSIONS, SL_LUCKY, session_id)
        @api.post("/speaking-lab/sessions/{session_id}/lucky-draw")
        async def lucky_draw_post(
            session_id: str,
            config: LuckyDrawConfig,
            admin=Depends(require_admin),
        ):
            return await _run_draw(
                db, sl_publish, session_id, config, gas_url, treasury_id,
                treasury_password, mock_gas, log,
                granted_by=getattr(admin, "email", "admin"),
                push_notify=push_notify,
            )
        # Phase 4 (treasury-safety + UI suspense): the original
        # POST /lucky-draw is now PREPARE-only — it locks the draw and
        # picks winners but does NOT transfer GAS or send winner pushes.
        # The cinematic on the teacher's screen plays, and only after the
        # final reveal does the client POST /lucky-draw/finalize, which
        # is idempotent: a separate atomic flag (`finalized=True` on the
        # `speaking_lab_lucky_draws` doc) guarantees the GAS transfers
        # and winner pushes happen exactly once.
        @api.post("/speaking-lab/sessions/{session_id}/lucky-draw/finalize")
        async def lucky_draw_finalize_post(
            session_id: str,
            admin=Depends(require_admin),
        ):
            return await _finalize_draw(
                db, sl_publish, session_id, gas_url, treasury_id,
                treasury_password, mock_gas, log,
                push_notify=push_notify,
            )
    else:
        # Dev mode — admit any caller
        @api.get("/speaking-lab/sessions/{session_id}/pool")
        async def lucky_pool_get_dev(session_id: str):
            return await _pool_payload(
                SL_SESSIONS, SL_LUCKY, session_id,
                db=db, sl_publish=sl_publish, log=log,
            )
        @api.get("/speaking-lab/sessions/{session_id}/lucky-codes")
        async def lucky_codes_get_dev(session_id: str):
            return await _codes_payload(SL_SESSIONS, SL_LUCKY, session_id)
        @api.post("/speaking-lab/sessions/{session_id}/lucky-draw")
        async def lucky_draw_post_dev(session_id: str, config: LuckyDrawConfig):
            return await _run_draw(
                db, sl_publish, session_id, config, gas_url, treasury_id,
                treasury_password, mock_gas, log,
                granted_by="dev",
                push_notify=push_notify,
            )
        # Same finalize route in dev mode (no admin gate).
        @api.post("/speaking-lab/sessions/{session_id}/lucky-draw/finalize")
        async def lucky_draw_finalize_post_dev(session_id: str):
            return await _finalize_draw(
                db, sl_publish, session_id, gas_url, treasury_id,
                treasury_password, mock_gas, log,
                push_notify=push_notify,
            )


async def _pool_payload(
    SL_SESSIONS, SL_LUCKY, session_id: str,
    *, db=None, sl_publish=None, log: Optional[logging.Logger] = None,
) -> dict:
    sess = await SL_SESSIONS.find_one({"session_id": session_id}, {"_id": 0})
    if not sess:
        raise HTTPException(status_code=404, detail="Session not found")

    # ── Safety-net repair: regenerate lucky codes for paid roster entries
    # that are missing one. This fixes the bug where a student paid the
    # entry fee (and therefore appears in `speaking_lab_entries`) but their
    # `speaking_lab_lucky_codes` doc was never created — usually because
    # the original `_sl_try_auto_enter` call hit a transient error or the
    # process was killed mid-flight. We repair every fetch so the pool UI
    # self-heals without operator action. Never raises into the caller.
    if db is not None and sl_publish is not None and not sess.get("lucky_draw_done"):
        try:
            entry_ids: list[str] = []
            entry_names: dict[str, str] = {}
            async for r in db.speaking_lab_entries.find(
                {"session_id": session_id},
                {"_id": 0, "student_id": 1, "display_name": 1},
            ):
                sid = (r.get("student_id") or "").strip()
                if sid and not sid.startswith("sl-"):
                    entry_ids.append(sid)
                    dn = r.get("display_name")
                    if dn:
                        entry_names[sid] = dn
            if entry_ids:
                have_codes: set[str] = set()
                async for r in SL_LUCKY.find(
                    {"session_id": session_id,
                     "student_id": {"$in": entry_ids}},
                    {"_id": 0, "student_id": 1},
                ):
                    sid = (r.get("student_id") or "").strip()
                    if sid:
                        have_codes.add(sid)
                missing = [s for s in entry_ids if s not in have_codes]
                if missing:
                    fee = int(sess.get("entry_fee") or 0)
                    for sid in missing:
                        try:
                            await generate_and_publish_lucky_code(
                                db, sl_publish, session_id, sid,
                                entry_names.get(sid, sid),
                                amount=fee, log=log,
                            )
                        except Exception as exc:  # noqa: BLE001
                            if log:
                                log.warning(
                                    "lucky_draw: pool repair failed for %s/%s: %s",
                                    session_id, sid, str(exc)[:200],
                                )
                    if log:
                        log.info(
                            "lucky_draw: pool repair generated %d code(s) "
                            "for session %s", len(missing), session_id,
                        )
        except Exception as exc:  # noqa: BLE001
            if log:
                log.warning(
                    "lucky_draw: pool repair scan error: %s",
                    str(exc)[:200],
                )

    codes_cursor = SL_LUCKY.find(
        {"session_id": session_id}, {"_id": 0},
    ).sort("awarded_at", 1)
    codes: list[dict] = []
    total = 0
    async for row in codes_cursor:
        codes.append({
            "student_id":   row.get("student_id"),
            "display_name": row.get("display_name"),
            "code":         row.get("code"),
            "entry_fee":    int(row.get("entry_fee") or 0),
            "awarded_at":   row.get("awarded_at"),
        })
        total += int(row.get("entry_fee") or 0)
    return {
        "session_id":     session_id,
        "pool_total":     total,
        "player_count":   len(codes),
        "entry_fee":      int(sess.get("entry_fee") or 0),
        "lucky_codes":    [{"code": c["code"], "display_name": c["display_name"]}
                            for c in codes],
        "drawn":          bool(sess.get("lucky_draw_done")),
    }


async def _codes_payload(SL_SESSIONS, SL_LUCKY, session_id: str) -> dict:
    sess = await SL_SESSIONS.find_one({"session_id": session_id}, {"_id": 0})
    if not sess:
        raise HTTPException(status_code=404, detail="Session not found")
    cursor = SL_LUCKY.find({"session_id": session_id}, {"_id": 0}).sort("awarded_at", 1)
    rows: list[dict] = []
    async for r in cursor:
        rows.append({
            "student_id":   r.get("student_id"),
            "display_name": r.get("display_name"),
            "code":         r.get("code"),
            "awarded_at":   r.get("awarded_at"),
        })
    return {"session_id": session_id, "codes": rows}


async def _run_draw(
    db, sl_publish, session_id: str, config: LuckyDrawConfig,
    gas_url: str, treasury_id: str, treasury_password: str,
    mock_gas: bool, log: logging.Logger, *, granted_by: str,
    push_notify: Optional[Callable[[str, int, str], Awaitable[None]]] = None,
) -> dict:
    SL_SESSIONS = db.speaking_lab_sessions
    SL_LUCKY    = db.speaking_lab_lucky_codes
    SL_DRAWS    = db.speaking_lab_lucky_draws
    SL_SETTINGS = db.speaking_lab_settings

    sess = await SL_SESSIONS.find_one({"session_id": session_id}, {"_id": 0})
    if not sess:
        raise HTTPException(status_code=404, detail="Session not found")

    # ── TREASURY-SAFETY CLAIM ───────────────────────────────────────────
    # Atomically flip `lucky_draw_done` to True at the very start, BEFORE
    # building candidates or sending any GAS payout. Only one concurrent
    # request can win this update; all others see matched_count == 0 and
    # get a clean 409. This is the single guard that prevents the
    # treasury double-payout bug (stu092 paying repeated winnings).
    #
    # Conditions:
    #   • lucky_draw_done is not True
    #   • optional belt-and-braces: no draw is currently in-flight by
    #     another worker (we don't have a separate flag; the not-equal-
    #     True check above is sufficient because we set it to True here).
    claim_started_at = datetime.now(timezone.utc).isoformat()
    claim = await SL_SESSIONS.update_one(
        {"session_id": session_id, "lucky_draw_done": {"$ne": True}},
        {"$set": {
            "lucky_draw_done":        True,
            "lucky_draw_started_at":  claim_started_at,
            "lucky_draw_granted_by":  granted_by,
        }},
    )
    if claim.matched_count == 0:
        # Either already drawn, or another request claimed it first.
        # Idempotent 409 — same response shape as before.
        raise HTTPException(status_code=409,
                            detail="Lucky draw already run for this session")

    # If we ever reach a GAS transfer, we must NEVER release the claim,
    # even on unexpected errors. Tracks the half-way point.
    payout_started = False

    async def _release_claim(reason: str) -> None:
        """Safely release the claim — ONLY callable before any GAS
        transfer started. We use a guarded update so we never undo a
        completed draw."""
        try:
            await SL_SESSIONS.update_one(
                {"session_id": session_id,
                 "lucky_draw_started_at": claim_started_at,
                 "lucky_draw_at": {"$exists": False}},
                {"$set":   {"lucky_draw_done": False},
                 "$unset": {"lucky_draw_started_at": "",
                            "lucky_draw_granted_by": ""}},
            )
            if log:
                log.info("lucky_draw: claim released for %s (%s)",
                         session_id, reason)
        except Exception as exc:  # noqa: BLE001
            if log:
                log.warning("lucky_draw: claim release error %s/%s: %s",
                            session_id, reason, str(exc)[:200])

    try:
        # Build candidate list (now claim is locked).
        candidates: list[dict] = []
        async for r in SL_LUCKY.find({"session_id": session_id}, {"_id": 0}):
            candidates.append({
                "student_id":   r.get("student_id"),
                "display_name": r.get("display_name"),
                "code":         r.get("code"),
                "entry_fee":    int(r.get("entry_fee") or 0),
            })
        if not candidates:
            # Safe to release: no GAS transfer started yet.
            await _release_claim("empty_pool")
            raise HTTPException(status_code=400,
                                detail="No lucky codes — pool is empty")

        pool_total = sum(c["entry_fee"] for c in candidates)
        if pool_total <= 0:
            await _release_claim("zero_pool_total")
            raise HTTPException(status_code=400, detail="Pool total is zero")

        # Resolve settings (config override > session > settings doc > defaults)
        settings_doc = await SL_SETTINGS.find_one({"_id": "settings"}, {"_id": 0}) or {}
        num_winners = (
            config.num_winners
            or int(settings_doc.get("luckyDrawWinners") or 0)
            or DEFAULT_NUM_WINNERS
        )
        num_winners = max(1, min(3, int(num_winners)))
        split = (
            config.split
            or settings_doc.get("luckyDrawSplit")
            or DEFAULT_SPLIT
        )
        # Clamp candidates if fewer than winners
        num_winners = min(num_winners, len(candidates))

        # Slot-picked set (passed in by client OR stored on session)
        slot_picked: set[str] = set()
        if config.slot_picks:
            slot_picked = set(config.slot_picks)
        elif isinstance(sess.get("slot_picks"), list):
            slot_picked = set(sess["slot_picks"])

        winners = _weighted_pick(candidates, slot_picked, num_winners)
        amounts = _normalize_split(list(split), num_winners, pool_total)

        # ── PREPARE-ONLY phase. Do NOT touch GAS, do NOT push, do NOT
        # emit `draw_winner` / `draw_complete` SSE events yet. Those
        # side-effects are deferred to `_finalize_draw`, which the
        # frontend invokes ONLY after the full cinematic reveal has
        # finished on the teacher's screen. This prevents the
        # early-push bug (winners' phones used to buzz before the
        # teacher had stopped the last ticket block).
        #
        # Treasury safety is unchanged: the atomic `lucky_draw_done`
        # claim above guarantees this prepare block runs at most once
        # per session, so the winner list + amounts are locked in
        # before the cinematic begins.
        payout_started = False  # GAS not invoked here at all.
        use_mock = bool(config.mock) or mock_gas
        results: list[dict] = []
        for w, amt in zip(winners, amounts):
            results.append({
                "student_id":      w["student_id"],
                "display_name":    w["display_name"],
                "code":            w["code"],
                "amount":          amt,
                # `transfer_ok` left None — finalize will fill it in.
                "transfer_ok":     None,
                "transfer_err":    "",
                "was_slot_picked": w["student_id"] in slot_picked,
            })

        # Persist the audit row in a NOT-yet-finalized state. The
        # `finalized` flag is the second-stage idempotency guard: only
        # one `_finalize_draw` call can flip it to True, so GAS
        # transfers + winner pushes also happen exactly once.
        now_iso = datetime.now(timezone.utc).isoformat()
        draw_id = f"draw-{uuid.uuid4().hex[:12]}"
        await SL_DRAWS.insert_one({
            "draw_id":      draw_id,
            "session_id":   session_id,
            "pool_total":   pool_total,
            "num_winners":  num_winners,
            "split":        list(split),
            "results":      list(results),
            "slot_picks":   list(slot_picked),
            "granted_by":   granted_by,
            "mock":         use_mock,
            "drawn_at":     now_iso,
            "finalized":    False,    # set True atomically in finalize
            "prepared_at":  now_iso,
        })
        # Stamp the latest prepared `draw_id` on the session so finalize
        # can find it without an extra query parameter from the client.
        await SL_SESSIONS.update_one(
            {"session_id": session_id},
            {"$set": {"lucky_draw_prepared_draw_id": draw_id}},
        )

        return {
            "ok":          True,
            "session_id":  session_id,
            "draw_id":     draw_id,
            "pool_total":  pool_total,
            "num_winners": num_winners,
            "split":       list(split),
            "winners":     results,
            "mock":        use_mock,
            "drawn_at":    now_iso,
            # New field — tells the frontend that a separate finalize
            # call is required after the cinematic reveal.
            "finalized":   False,
            "requires_finalize": True,
        }
    except HTTPException:
        # Already handled — claim released above if applicable. Re-raise.
        raise
    except Exception as exc:  # noqa: BLE001
        # Unexpected failure. If we never started a GAS transfer we can
        # safely release the claim so the teacher can retry. Once any
        # GAS call has been issued (`payout_started=True`) we MUST keep
        # the claim — a partial draw must never be re-paid.
        if not payout_started:
            await _release_claim(f"pre_payout_exception:{type(exc).__name__}")
        if log:
            log.exception("lucky_draw: unhandled error in _run_draw: %s",
                          str(exc)[:200])
        raise


async def _finalize_draw(
    db, sl_publish, session_id: str,
    gas_url: str, treasury_id: str, treasury_password: str,
    mock_gas: bool, log: logging.Logger,
    *,
    push_notify: Optional[Callable[[str, int, str], Awaitable[None]]] = None,
) -> dict:
    """
    Phase 4: commit the previously-prepared draw.

    `_run_draw` only LOCKS the winners and persists the plan. It does
    NOT transfer GAS points and does NOT push to the winners. This
    function performs both, idempotently.

    Idempotency model:
      • Each prepared draw lives in `speaking_lab_lucky_draws` with
        `finalized=False`.
      • We claim it with an atomic `update_one(..., finalized:{$ne:True},
        ...->finalized=True)`. Only ONE concurrent caller can win that
        flip; every other caller sees `matched_count == 0` and we
        return the already-finalized record (200 OK, no payout, no
        push). This is exactly the same pattern as the start-of-draw
        atomic claim — same safety guarantee, different document.
      • If finalize is called BEFORE prepare (no draw record found):
        return 404. The frontend never does this; it's a safety check
        against stray clients.

    Safety re-statement:
      • Atomic claim at draw start → exactly one prepare per session.
      • Atomic finalize flip → exactly one set of GAS transfers per
        prepared draw.
      • Together: exactly one payout per session, no double-pay,
        even under refresh/retry/concurrent admin tabs.
    """
    SL_SESSIONS = db.speaking_lab_sessions
    SL_DRAWS    = db.speaking_lab_lucky_draws

    sess = await SL_SESSIONS.find_one({"session_id": session_id}, {"_id": 0})
    if not sess:
        raise HTTPException(status_code=404, detail="Session not found")

    # Locate the prepared draw. We prefer the `lucky_draw_prepared_draw_id`
    # pointer set by `_run_draw`, but fall back to the most recent
    # un-finalized draw for this session so that a draw prepared by an
    # older build (without the pointer) can still be finalized.
    prepared_id = sess.get("lucky_draw_prepared_draw_id")
    draw_doc = None
    if prepared_id:
        draw_doc = await SL_DRAWS.find_one(
            {"draw_id": prepared_id, "session_id": session_id},
            {"_id": 0},
        )
    if not draw_doc:
        draw_doc = await SL_DRAWS.find_one(
            {"session_id": session_id, "finalized": {"$ne": True}},
            {"_id": 0}, sort=[("prepared_at", -1)],
        )
    if not draw_doc:
        # Either no draw was ever prepared, or it's already finalized.
        # If a finalized record exists, return it idempotently.
        existing = await SL_DRAWS.find_one(
            {"session_id": session_id, "finalized": True},
            {"_id": 0}, sort=[("finalized_at", -1)],
        )
        if existing:
            return {
                "ok":          True,
                "session_id":  session_id,
                "draw_id":     existing.get("draw_id"),
                "pool_total":  existing.get("pool_total"),
                "num_winners": existing.get("num_winners"),
                "split":       existing.get("split"),
                "winners":     existing.get("results", []),
                "mock":        existing.get("mock"),
                "drawn_at":    existing.get("drawn_at"),
                "finalized":   True,
                "already_finalized": True,
            }
        raise HTTPException(
            status_code=404,
            detail="No prepared draw found for this session",
        )

    draw_id = draw_doc["draw_id"]

    # ── ATOMIC FINALIZE CLAIM ─────────────────────────────────────────
    finalized_started_at = datetime.now(timezone.utc).isoformat()
    claim = await SL_DRAWS.update_one(
        {"draw_id": draw_id, "finalized": {"$ne": True}},
        {"$set": {
            "finalized":              True,
            "finalize_started_at":    finalized_started_at,
        }},
    )
    if claim.matched_count == 0:
        # Already finalized by an earlier call (refresh, retry,
        # concurrent tab). Return the existing finalized record —
        # idempotent 200, no payout, no push.
        existing = await SL_DRAWS.find_one({"draw_id": draw_id}, {"_id": 0})
        if log:
            log.info("lucky_draw: finalize idempotent hit for %s/%s",
                     session_id, draw_id)
        return {
            "ok":          True,
            "session_id":  session_id,
            "draw_id":     draw_id,
            "pool_total":  existing.get("pool_total") if existing else None,
            "num_winners": existing.get("num_winners") if existing else None,
            "split":       existing.get("split") if existing else None,
            "winners":     (existing or {}).get("results", []),
            "mock":        (existing or {}).get("mock"),
            "drawn_at":    (existing or {}).get("drawn_at"),
            "finalized":   True,
            "already_finalized": True,
        }

    # We won the claim. Execute GAS transfers + pushes for each winner.
    prepared_results = list(draw_doc.get("results") or [])
    use_mock = bool(draw_doc.get("mock") or mock_gas)
    final_results: list[dict] = []
    for rec in prepared_results:
        student_id   = rec.get("student_id")
        display_name = rec.get("display_name")
        code         = rec.get("code") or ""
        amount       = int(rec.get("amount") or 0)
        ok, err = await _gas_send_points(
            gas_url, treasury_id, treasury_password,
            student_id, amount, mock=use_mock, log=log,
        )
        merged = {
            **rec,
            "transfer_ok":  ok,
            "transfer_err": "" if ok else err,
        }
        final_results.append(merged)

        # SSE for the teacher screen (post-reveal — the cinematic is
        # already complete by now, so this event is mostly audit; the
        # frontend already painted winners from the prepare response).
        try:
            await sl_publish(session_id, {
                "type":  "draw_winner",
                **merged,
            })
        except Exception as exc:  # noqa: BLE001
            if log:
                log.warning("lucky_draw: sl_publish error: %s",
                            str(exc)[:200])

        # Winner push — fire-and-forget so a slow webpush never blocks
        # the rest of finalize.
        if ok and push_notify is not None:
            try:
                asyncio.create_task(
                    push_notify(student_id, amount, code)
                )
            except Exception as exc:  # noqa: BLE001
                if log:
                    log.warning(
                        "lucky_draw push schedule error: %s",
                        str(exc)[:200],
                    )

    # Persist final results back onto the draw doc + stamp session.
    finalized_at = datetime.now(timezone.utc).isoformat()
    await SL_DRAWS.update_one(
        {"draw_id": draw_id},
        {"$set": {
            "results":      list(final_results),
            "finalized_at": finalized_at,
        }},
    )
    await SL_SESSIONS.update_one(
        {"session_id": session_id},
        {"$set": {"lucky_draw_at": finalized_at}},
    )

    try:
        await sl_publish(session_id, {
            "type":        "draw_complete",
            "pool_total":  draw_doc.get("pool_total"),
            "num_winners": draw_doc.get("num_winners"),
            "results":     list(final_results),
        })
    except Exception as exc:  # noqa: BLE001
        if log:
            log.warning("lucky_draw: sl_publish draw_complete error: %s",
                        str(exc)[:200])

    return {
        "ok":          True,
        "session_id":  session_id,
        "draw_id":     draw_id,
        "pool_total":  draw_doc.get("pool_total"),
        "num_winners": draw_doc.get("num_winners"),
        "split":       draw_doc.get("split"),
        "winners":     final_results,
        "mock":        use_mock,
        "drawn_at":    draw_doc.get("drawn_at"),
        "finalized":   True,
        "finalized_at": finalized_at,
        "already_finalized": False,
    }


# ---------------------------------------------------------------------------
# Optional: helper to ensure the Mongo indexes exist. Call once at startup.
# ---------------------------------------------------------------------------

async def ensure_lucky_draw_indexes(db) -> None:
    await db.speaking_lab_lucky_codes.create_index(
        [("session_id", 1), ("student_id", 1)], unique=True,
    )
    await db.speaking_lab_lucky_codes.create_index(
        [("session_id", 1), ("code", 1)], unique=True,
    )
    await db.speaking_lab_lucky_draws.create_index("session_id")
    await db.speaking_lab_lucky_draws.create_index("drawn_at")
    # Phase 4: support the finalize-idempotency lookup.
    await db.speaking_lab_lucky_draws.create_index("draw_id", unique=True)
