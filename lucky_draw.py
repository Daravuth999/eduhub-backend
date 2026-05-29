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
            return await _pool_payload(SL_SESSIONS, SL_LUCKY, session_id)
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
    else:
        # Dev mode — admit any caller
        @api.get("/speaking-lab/sessions/{session_id}/pool")
        async def lucky_pool_get_dev(session_id: str):
            return await _pool_payload(SL_SESSIONS, SL_LUCKY, session_id)
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


async def _pool_payload(SL_SESSIONS, SL_LUCKY, session_id: str) -> dict:
    sess = await SL_SESSIONS.find_one({"session_id": session_id}, {"_id": 0})
    if not sess:
        raise HTTPException(status_code=404, detail="Session not found")
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
    if sess.get("lucky_draw_done"):
        raise HTTPException(status_code=409,
                            detail="Lucky draw already run for this session")

    # Build candidate list
    candidates: list[dict] = []
    async for r in SL_LUCKY.find({"session_id": session_id}, {"_id": 0}):
        candidates.append({
            "student_id":   r.get("student_id"),
            "display_name": r.get("display_name"),
            "code":         r.get("code"),
            "entry_fee":    int(r.get("entry_fee") or 0),
        })
    if not candidates:
        raise HTTPException(status_code=400, detail="No lucky codes — pool is empty")

    pool_total = sum(c["entry_fee"] for c in candidates)
    if pool_total <= 0:
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

    # Execute GAS transfers + collect results
    results: list[dict] = []
    use_mock = bool(config.mock) or mock_gas
    for w, amt in zip(winners, amounts):
        ok, err = await _gas_send_points(
            gas_url, treasury_id, treasury_password,
            w["student_id"], amt, mock=use_mock, log=log,
        )
        rec = {
            "student_id":   w["student_id"],
            "display_name": w["display_name"],
            "code":         w["code"],
            "amount":       amt,
            "transfer_ok":  ok,
            "transfer_err": "" if ok else err,
            "was_slot_picked": w["student_id"] in slot_picked,
        }
        results.append(rec)
        # SSE per winner (drives LuckyDraw cinematic on teacher screen)
        await sl_publish(session_id, {
            "type":         "draw_winner",
            **rec,
        })

        # Phase 3: notify the winner's phone via Web Push as soon as
        # the GAS transfer succeeds. Never block the draw loop on push
        # — fire-and-forget so a slow webpush doesn't delay the next
        # winner's SSE event. The push helper is best-effort and never
        # raises.
        if ok and push_notify is not None:
            try:
                asyncio.create_task(
                    push_notify(w["student_id"], amt, w.get("code") or "")
                )
            except Exception as exc:  # noqa: BLE001
                log.warning("lucky_draw push schedule error: %s", str(exc)[:200])

    # Persist audit row + flip session flag (atomic-ish)
    now_iso = datetime.now(timezone.utc).isoformat()
    await SL_DRAWS.insert_one({
        "draw_id":      f"draw-{uuid.uuid4().hex[:12]}",
        "session_id":   session_id,
        "pool_total":   pool_total,
        "num_winners":  num_winners,
        "split":        list(split),
        "results":      list(results),
        "slot_picks":   list(slot_picked),
        "granted_by":   granted_by,
        "mock":         use_mock,
        "drawn_at":     now_iso,
    })
    await SL_SESSIONS.update_one(
        {"session_id": session_id},
        {"$set": {"lucky_draw_done": True, "lucky_draw_at": now_iso}},
    )

    # Broadcast the closing summary event
    await sl_publish(session_id, {
        "type":        "draw_complete",
        "pool_total":  pool_total,
        "num_winners": num_winners,
        "results":     list(results),
    })

    return {
        "ok":          True,
        "session_id":  session_id,
        "pool_total":  pool_total,
        "num_winners": num_winners,
        "split":       list(split),
        "winners":     results,
        "mock":        use_mock,
        "drawn_at":    now_iso,
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
