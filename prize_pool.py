"""prize_pool.py — the Prize Pool Platform (architecture continuation:
"reusable Prize Pools... one pool, multiple consumers, live
synchronization, every deduction updates one ledger").

WHY THIS DOES NOT INTRODUCE A SECOND LEDGER
────────────────────────────────────────────
A Prize Pool is NOT a new money store. Each pool gets its own virtual
wallet id (``pool_<pool_id>``) inside the EXISTING ``points_wallets``/
``points_transactions`` collections — the SAME collections every
student wallet already lives in. Contributing to a pool and
distributing from it are both plain ``WalletService.transfer()`` calls
(completely unchanged, same atomic two-sided transfer, same
idempotency-key replay protection). This module never reads or writes
a balance directly — ``get_pool_balance``/``get_pool_ledger`` are both
thin reads through the SAME wallet_service functions every other
caller uses. "One ledger" is enforced structurally, not by convention.

WHY THIS IS A NEW PRIMITIVE, NOT A LUCKY DRAW / MYSTERY BOX REWRITE
────────────────────────────────────────────────────────────────────
lucky_draw.py and mystery_box_tools.py are each production-hardened,
self-contained reward systems with their own payout state machines —
per the approved architecture's own safeguard ("preserve existing
business logic... wrap them, generalize them, reuse them, do NOT
rewrite stable logic"), migrating their SETTLEMENT/PAYOUT logic onto
this primitive is real, separate work, not attempted here. This module
is for NEW consumers (Weekly Rewards, Tournament, Promotion, Top-up
Campaign, Referral Campaign, Seasonal Events) that don't have an
existing reward mechanism to preserve.

FUNDING-SOURCE WIRING (architecture continuation — "students never
deposit points into the pool; administrators fund it"): lucky_draw.py's
own pool-total computation (`_resolve_pool_total`) now OPTIONALLY reads
a session's live pool balance through `get_pool_balance` when an admin
has linked one via `link_pool_to_session`/`fund_pool` below — but
lucky_draw.py's winner selection, draw state machine, GAS transfer, and
per-winner atomic payout claims are completely untouched. This module
never calls into lucky_draw.py; the dependency runs one way only
(lucky_draw.py reads a balance from here, and best-effort records a
`distribute()` per paid winner after ITS OWN unmodified finalize
succeeds) — see lucky_draw.py's `_resolve_pool_total`/
`_record_pool_distribution` for the actual seam.

DATA MODEL
──────────
``prize_pools`` — pool metadata only (no money fields — those are
always derived live from the wallet ledger):
    _id, name, owner_type, owner_ref, status (open|locked|settled|
    cancelled), pool_wallet_id, created_by, created_at, updated_at,
    settled_at

``owner_type`` is a free-form string (documented, not a hard enum —
matching experience_config_tools.py's own "never require a schema
migration for a new type" convention). Known values today: "event",
"weekly_reward", "tournament", "promotion", "topup_campaign",
"referral_campaign", "seasonal_event", "speaking_lab_session".

FUNDING: two ways points enter a pool.
  * ``fund_pool`` — a pure one-sided WalletService.credit() into the
    pool's virtual wallet, no counterparty debited. This is THE
    administrator-funding path ("administrators decide how many points
    are available for rewards" — nobody's wallet is drawn down to make
    it happen, same convention login-reward/treasury grants already use
    for minting points onto a wallet).
  * ``contribute`` — the original two-sided WalletService.transfer()
    from a student's own wallet (kept, unchanged, for any consumer that
    genuinely wants a student-funded pool — Lucky Draw's NEW funding
    model does not use this path).

SESSION LINKING: ``link_pool_to_session`` stamps ``prize_pool_id`` onto
a ``speaking_lab_sessions`` document — the field lucky_draw.py's
``_resolve_pool_total`` reads. This module never reads or writes
``speaking_lab_lucky_codes``/draw state; it only ever touches the one
``prize_pool_id`` field on the session doc, and only via this explicit
admin action.
"""
from __future__ import annotations

import logging
import uuid
from datetime import datetime, timezone
from typing import Any, Optional

logger = logging.getLogger("eduhub.prize_pool")

COLL_POOLS = "prize_pools"

POOL_STATUSES = ("open", "locked", "settled", "cancelled")
_ALLOWED_TRANSITIONS: dict[str, set[str]] = {
    "open": {"locked", "cancelled"},
    "locked": {"open", "settled", "cancelled"},
}


class PrizePoolError(Exception):
    def __init__(self, code: str, message: str = "", http_status: int = 400) -> None:
        super().__init__(message or code)
        self.code = code
        self.message = message or code
        self.http_status = http_status


def _now_iso() -> str:
    return datetime.now(timezone.utc).isoformat()


def pool_wallet_id(pool_id: str) -> str:
    """The virtual wallet id a pool's funds live under — a plain
    points_wallets/points_transactions row, same as any student's."""
    return f"pool_{pool_id}"


async def create_pool(
    db, *, name: str, owner_type: str, owner_ref: str = "", created_by: str,
) -> dict:
    name = (name or "").strip()
    if not name:
        raise PrizePoolError("invalid_name", "name is required")
    owner_type = (owner_type or "").strip()
    if not owner_type:
        raise PrizePoolError("invalid_owner_type", "owner_type is required")
    now = _now_iso()
    pool_id = f"pool_{uuid.uuid4().hex[:16]}"
    doc = {
        "_id": pool_id,
        "name": name,
        "owner_type": owner_type,
        "owner_ref": owner_ref or "",
        "status": "open",
        "pool_wallet_id": pool_wallet_id(pool_id),
        "created_by": created_by,
        "created_at": now,
        "updated_at": now,
        "settled_at": None,
        # Bidirectional with speaking_lab_sessions.prize_pool_id (see
        # link_pool_to_session) — lets Author Studio show "this pool funds
        # session X" directly on the pool row, not only "this session is
        # funded by pool Y" on the session/event row.
        "linked_session_id": None,
    }
    await db[COLL_POOLS].insert_one(doc)
    return doc


async def get_pool(db, pool_id: str) -> Optional[dict]:
    return await db[COLL_POOLS].find_one({"_id": pool_id})


async def list_pools(
    db, *, owner_type: Optional[str] = None, status: Optional[str] = None,
) -> list[dict]:
    query: dict = {}
    if owner_type:
        query["owner_type"] = owner_type
    if status:
        query["status"] = status
    cursor = db[COLL_POOLS].find(query, {}).sort("created_at", -1)
    return [doc async for doc in cursor]


async def _transition(db, pool_id: str, to_status: str, *, actor: str) -> dict:
    pool = await get_pool(db, pool_id)
    if not pool:
        raise PrizePoolError("pool_not_found", http_status=404)
    current = pool["status"]
    allowed = _ALLOWED_TRANSITIONS.get(current, set())
    if to_status not in allowed:
        raise PrizePoolError(
            "invalid_transition",
            f"cannot move from {current!r} to {to_status!r} (allowed: {sorted(allowed) or 'none'})",
        )
    now = _now_iso()
    changes: dict[str, Any] = {"status": to_status, "updated_at": now, "updated_by": actor}
    if to_status == "settled":
        changes["settled_at"] = now
    await db[COLL_POOLS].update_one({"_id": pool_id}, {"$set": changes})
    return await get_pool(db, pool_id)


async def lock_pool(db, pool_id: str, *, actor: str) -> dict:
    """No more contributions accepted; distributions can still happen —
    the normal "registration closed, about to draw/distribute" moment."""
    return await _transition(db, pool_id, "locked", actor=actor)


async def settle_pool(db, pool_id: str, *, actor: str) -> dict:
    """Terminal — bookkeeping only. Does not force zero balance; a
    consumer may intentionally leave a rollover balance (e.g. Lucky
    Draw's own rollover semantics), which is visible via
    get_pool_balance either way."""
    return await _transition(db, pool_id, "settled", actor=actor)


async def cancel_pool(db, pool_id: str, *, actor: str) -> dict:
    return await _transition(db, pool_id, "cancelled", actor=actor)


async def unlock_pool(db, pool_id: str, *, actor: str) -> dict:
    """Reopen a locked pool for further admin funding — e.g. a teacher
    needs another session's worth of rewards from the same season pool.
    Distributions already recorded are untouched; this only flips status."""
    return await _transition(db, pool_id, "open", actor=actor)


async def fund_pool(
    db, wallet_service, pool_id: str, *, amount: int,
    idempotency_key: str, actor: str = "", note: str = "",
) -> dict:
    """Administrator funding — the ONLY way points enter a pool under the
    Lucky Draw funding-source migration ("students never deposit points
    into the pool; administrators decide how many points are available
    for rewards"). A pure ONE-SIDED WalletService.credit() — no student
    or other wallet is debited to make this happen; the admin's decision
    to fund a pool IS the source, same convention treasury/login-reward
    grants already use for minting points onto a wallet. Only allowed
    while "open" (matches lock semantics for contribute())."""
    pool = await get_pool(db, pool_id)
    if not pool:
        raise PrizePoolError("pool_not_found", http_status=404)
    if pool["status"] != "open":
        raise PrizePoolError(
            "pool_not_open",
            f"Pool is {pool['status']!r}; funding is only accepted while open.",
        )
    return await wallet_service.credit(
        pool["pool_wallet_id"], amount,
        source="prize_pool_admin_fund", source_ref=pool_id,
        idempotency_key=idempotency_key,
        payload={"pool_name": pool["name"], "actor": actor, "note": note},
    )


async def link_pool_to_session(db, pool_id: str, session_id: str, *, actor: str = "") -> dict:
    """Associate a pool with a Speaking Lab session — stamps
    ``prize_pool_id`` onto the session's own ``speaking_lab_sessions``
    document (the field lucky_draw.py's ``_resolve_pool_total`` reads)
    AND ``linked_session_id`` back onto the pool doc itself, so Author
    Studio can show "this pool funds session X" directly on the Prize
    Pools screen without a second lookup. Re-linking a session to a
    different pool simply overwrites both sides; nothing about the
    previous pool's own state changes (its own ``linked_session_id`` is
    left stale/informational — a pool can only usefully fund one session
    at a time in practice, but this module does not enforce that)."""
    pool = await get_pool(db, pool_id)
    if not pool:
        raise PrizePoolError("pool_not_found", http_status=404)
    session_id = (session_id or "").strip()
    if not session_id:
        raise PrizePoolError("invalid_session_id", "session_id is required")
    result = await db.speaking_lab_sessions.update_one(
        {"session_id": session_id},
        {"$set": {"prize_pool_id": pool_id, "prize_pool_linked_by": actor,
                   "prize_pool_linked_at": _now_iso()}},
    )
    if getattr(result, "matched_count", 0) == 0:
        raise PrizePoolError("session_not_found", "Speaking Lab session not found", http_status=404)
    await db[COLL_POOLS].update_one(
        {"_id": pool_id},
        {"$set": {"linked_session_id": session_id, "updated_at": _now_iso()}},
    )
    return {"pool_id": pool_id, "session_id": session_id}


async def get_pool_for_session(db, session_id: str) -> Optional[dict]:
    """The pool currently funding a Speaking Lab session, or None if the
    session still relies on the legacy entry-fee-summed pool."""
    sess = await db.speaking_lab_sessions.find_one(
        {"session_id": session_id}, {"_id": 0, "prize_pool_id": 1},
    )
    pool_id = (sess or {}).get("prize_pool_id")
    if not pool_id:
        return None
    return await get_pool(db, pool_id)


async def contribute(
    db, wallet_service, pool_id: str, *, student_id: str, amount: int,
    idempotency_key: str, actor: str = "",
) -> dict:
    """A student pays into the pool — a plain WalletService.transfer()
    from the student's wallet to the pool's virtual wallet. Only
    allowed while the pool is "open"."""
    pool = await get_pool(db, pool_id)
    if not pool:
        raise PrizePoolError("pool_not_found", http_status=404)
    if pool["status"] != "open":
        raise PrizePoolError(
            "pool_not_open",
            f"Pool is {pool['status']!r}; contributions are only accepted while open.",
        )
    return await wallet_service.transfer(
        student_id, pool["pool_wallet_id"], amount,
        source="prize_pool_contribution", source_ref=pool_id,
        idempotency_key=idempotency_key,
        payload={"pool_name": pool["name"], "actor": actor},
    )


async def distribute(
    db, wallet_service, pool_id: str, *, student_id: str, amount: int,
    idempotency_key: str, actor: str = "", reason: str = "",
) -> dict:
    """Pay a winner out of the pool — a plain WalletService.transfer()
    from the pool's virtual wallet to the student's wallet. Allowed
    while "open" or "locked" (settling happens after distributions);
    blocked once settled/cancelled."""
    pool = await get_pool(db, pool_id)
    if not pool:
        raise PrizePoolError("pool_not_found", http_status=404)
    if pool["status"] not in ("open", "locked"):
        raise PrizePoolError(
            "pool_not_distributable",
            f"Pool is {pool['status']!r}; distributions require open or locked.",
        )
    return await wallet_service.transfer(
        pool["pool_wallet_id"], student_id, amount,
        source="prize_pool_distribution", source_ref=pool_id,
        idempotency_key=idempotency_key,
        payload={"pool_name": pool["name"], "actor": actor, "reason": reason},
    )


async def get_pool_balance(db, wallet_service, pool_id: str) -> float:
    """Live, derived — never a stored/duplicated total."""
    pool = await get_pool(db, pool_id)
    if not pool:
        raise PrizePoolError("pool_not_found", http_status=404)
    return await wallet_service.get_balance(pool["pool_wallet_id"])


async def get_pool_ledger(db, wallet_service, pool_id: str, *, limit: int = 100) -> list[dict]:
    """The pool's full transaction history IS wallet_service.history()
    for its virtual wallet — the same points_transactions collection
    every student's history already comes from. No separate pool
    ledger collection exists."""
    pool = await get_pool(db, pool_id)
    if not pool:
        raise PrizePoolError("pool_not_found", http_status=404)
    return await wallet_service.history(pool["pool_wallet_id"], limit=limit)


# ─────────────────────────────────────────────────────────────────────────
# Routes — reusable across any consumer (Event Engine, Author Studio, a
# future Weekly Rewards/Tournament module, etc.)
# ─────────────────────────────────────────────────────────────────────────
def register_prize_pool_routes(api, db, wallet_service, require_admin) -> None:
    """Mounts /api/v1/prize-pools* onto the existing FastAPI router.
    Admin-only today — a consumer-specific student-facing action (e.g.
    "pay your entry fee into this event's pool") stays owned by that
    consumer's own route (e.g. event_engine.py's register_participant),
    which may call contribute()/distribute() directly as a Python
    function without going through these admin HTTP routes at all."""
    from fastapi import Body, Depends, HTTPException

    def _raise(exc: PrizePoolError):
        raise HTTPException(status_code=exc.http_status, detail=exc.message)

    @api.post("/v1/prize-pools")
    async def create_pool_route(payload: dict = Body(...), admin=Depends(require_admin)):
        try:
            doc = await create_pool(
                db, name=payload.get("name", ""), owner_type=payload.get("owner_type", ""),
                owner_ref=payload.get("owner_ref", ""), created_by=getattr(admin, "email", ""),
            )
        except PrizePoolError as exc:
            _raise(exc)
        return {"ok": True, "pool": doc}

    @api.get("/v1/prize-pools")
    async def list_pools_route(owner_type: str = "", status: str = "", admin=Depends(require_admin)):
        docs = await list_pools(db, owner_type=owner_type or None, status=status or None)
        return {"pools": docs}

    @api.get("/v1/prize-pools/{pool_id}")
    async def get_pool_route(pool_id: str, admin=Depends(require_admin)):
        doc = await get_pool(db, pool_id)
        if not doc:
            raise HTTPException(status_code=404, detail="pool not found")
        return {"pool": doc}

    @api.get("/v1/prize-pools/{pool_id}/balance")
    async def get_pool_balance_route(pool_id: str, admin=Depends(require_admin)):
        try:
            balance = await get_pool_balance(db, wallet_service, pool_id)
        except PrizePoolError as exc:
            _raise(exc)
        return {"pool_id": pool_id, "balance": balance}

    @api.get("/v1/prize-pools/{pool_id}/ledger")
    async def get_pool_ledger_route(pool_id: str, limit: int = 100, admin=Depends(require_admin)):
        try:
            entries = await get_pool_ledger(db, wallet_service, pool_id, limit=limit)
        except PrizePoolError as exc:
            _raise(exc)
        return {"pool_id": pool_id, "entries": entries}

    @api.post("/v1/prize-pools/{pool_id}/contribute")
    async def contribute_route(pool_id: str, payload: dict = Body(...), admin=Depends(require_admin)):
        from wallet_service import InsufficientFunds, WalletError
        try:
            result = await contribute(
                db, wallet_service, pool_id,
                student_id=payload.get("student_id", ""),
                amount=payload.get("amount", 0),
                idempotency_key=payload.get("idempotency_key", ""),
                actor=getattr(admin, "email", ""),
            )
        except PrizePoolError as exc:
            _raise(exc)
        except InsufficientFunds as exc:
            raise HTTPException(status_code=402, detail=exc.message)
        except WalletError as exc:
            raise HTTPException(status_code=409, detail=exc.message)
        return {"ok": True, "result": result}

    @api.post("/v1/prize-pools/{pool_id}/distribute")
    async def distribute_route(pool_id: str, payload: dict = Body(...), admin=Depends(require_admin)):
        from wallet_service import InsufficientFunds, WalletError
        try:
            result = await distribute(
                db, wallet_service, pool_id,
                student_id=payload.get("student_id", ""),
                amount=payload.get("amount", 0),
                idempotency_key=payload.get("idempotency_key", ""),
                actor=getattr(admin, "email", ""),
                reason=payload.get("reason", ""),
            )
        except PrizePoolError as exc:
            _raise(exc)
        except InsufficientFunds as exc:
            raise HTTPException(status_code=402, detail=exc.message)
        except WalletError as exc:
            raise HTTPException(status_code=409, detail=exc.message)
        return {"ok": True, "result": result}

    @api.post("/v1/prize-pools/{pool_id}/fund")
    async def fund_pool_route(pool_id: str, payload: dict = Body(...), admin=Depends(require_admin)):
        from wallet_service import WalletError
        try:
            result = await fund_pool(
                db, wallet_service, pool_id,
                amount=payload.get("amount", 0),
                idempotency_key=payload.get("idempotency_key", ""),
                actor=getattr(admin, "email", ""),
                note=payload.get("note", ""),
            )
        except PrizePoolError as exc:
            _raise(exc)
        except WalletError as exc:
            raise HTTPException(status_code=409, detail=exc.message)
        return {"ok": True, "result": result}

    @api.post("/v1/prize-pools/{pool_id}/link-session")
    async def link_pool_to_session_route(pool_id: str, payload: dict = Body(...), admin=Depends(require_admin)):
        try:
            result = await link_pool_to_session(
                db, pool_id, payload.get("session_id", ""),
                actor=getattr(admin, "email", ""),
            )
        except PrizePoolError as exc:
            _raise(exc)
        return {"ok": True, "result": result}

    @api.get("/v1/prize-pools/by-session/{session_id}")
    async def get_pool_for_session_route(session_id: str, admin=Depends(require_admin)):
        doc = await get_pool_for_session(db, session_id)
        return {"pool": doc}

    @api.post("/v1/prize-pools/{pool_id}/lock")
    async def lock_pool_route(pool_id: str, admin=Depends(require_admin)):
        try:
            doc = await lock_pool(db, pool_id, actor=getattr(admin, "email", ""))
        except PrizePoolError as exc:
            _raise(exc)
        return {"ok": True, "pool": doc}

    @api.post("/v1/prize-pools/{pool_id}/unlock")
    async def unlock_pool_route(pool_id: str, admin=Depends(require_admin)):
        try:
            doc = await unlock_pool(db, pool_id, actor=getattr(admin, "email", ""))
        except PrizePoolError as exc:
            _raise(exc)
        return {"ok": True, "pool": doc}

    @api.post("/v1/prize-pools/{pool_id}/settle")
    async def settle_pool_route(pool_id: str, admin=Depends(require_admin)):
        try:
            doc = await settle_pool(db, pool_id, actor=getattr(admin, "email", ""))
        except PrizePoolError as exc:
            _raise(exc)
        return {"ok": True, "pool": doc}

    @api.post("/v1/prize-pools/{pool_id}/cancel")
    async def cancel_pool_route(pool_id: str, admin=Depends(require_admin)):
        try:
            doc = await cancel_pool(db, pool_id, actor=getattr(admin, "email", ""))
        except PrizePoolError as exc:
            _raise(exc)
        return {"ok": True, "pool": doc}

    logger.info("prize_pool: routes registered (/api/v1/prize-pools*)")


async def ensure_prize_pool_indexes(db) -> None:
    await db[COLL_POOLS].create_index("owner_type")
    await db[COLL_POOLS].create_index("status")
    await db[COLL_POOLS].create_index([("owner_type", 1), ("owner_ref", 1)])
    logger.info("prize_pool: indexes ready")


__all__ = [
    "COLL_POOLS",
    "POOL_STATUSES",
    "PrizePoolError",
    "pool_wallet_id",
    "create_pool",
    "get_pool",
    "list_pools",
    "lock_pool",
    "unlock_pool",
    "settle_pool",
    "cancel_pool",
    "fund_pool",
    "link_pool_to_session",
    "get_pool_for_session",
    "contribute",
    "distribute",
    "get_pool_balance",
    "get_pool_ledger",
    "register_prize_pool_routes",
    "ensure_prize_pool_indexes",
]
