"""auth_session_ttl.py — Milestone 0 (Authentication Completion, Phase 1).

Storage-hygiene only. `current_student()`/`current_user()` in server.py
already tolerate either a string or a native BSON Date `expires_at` value
on read (both call `datetime.fromisoformat(x) if isinstance(x, str) else x`
before comparing), so nothing here changes login, session-validation, or
logout behaviour — this module only affects whether MongoDB itself ever
physically removes an already-expired session row.

Background: `expires_at` was historically written as an ISO-8601 string
(`.isoformat()`). MongoDB's TTL monitor only evaluates BSON Date-typed
values — a TTL index on a string field is accepted without error but never
deletes anything, which is worse than no index at all if left undiscovered.
server.py's session-insert call sites were updated (this same milestone) to
store a native `datetime` going forward; this module converts the existing
plain index into a real TTL index and removes the backlog of already-
expired string-typed rows left over from before that change.
"""
from __future__ import annotations

import logging
from datetime import datetime, timezone

log = logging.getLogger("eduhub")


async def ensure_ttl_index(db, collection_name: str, field: str = "expires_at", seconds: int = 0):
    """Convert an existing plain index on `field` into a genuine TTL index
    via collMod (metadata-only — no rebuild, no downtime, no lock). Safe to
    call on every startup: if the index is already a TTL index with this
    value, Mongo just re-applies the same setting. Falls back to creating a
    fresh TTL index directly if the plain index doesn't exist yet (e.g. a
    brand new deployment with no prior index to convert)."""
    try:
        await db.command(
            "collMod",
            collection_name,
            index={"keyPattern": {field: 1}, "expireAfterSeconds": seconds},
        )
    except Exception as exc:  # noqa: BLE001
        log.warning(
            "collMod TTL on %s.%s failed (%s) — creating fresh TTL index",
            collection_name, field, exc,
        )
        try:
            await db[collection_name].create_index(field, expireAfterSeconds=seconds)
        except Exception as exc2:  # noqa: BLE001
            log.warning(
                "fresh TTL index creation on %s.%s also failed: %s",
                collection_name, field, exc2,
            )


async def cleanup_expired_sessions(db, collections=("student_sessions", "user_sessions")):
    """One-time-in-effect (safe to repeat every startup) removal of sessions
    that are ALREADY logically expired. These carry zero security risk —
    current_student()/current_user() already reject them at read time
    regardless of whether the row still physically exists — but many
    predate this migration and store expires_at as an ISO string, which
    MongoDB's TTL monitor cannot see and would never clean up on its own.
    Uses the exact same expiry comparison current_student()/current_user()
    already trust — never removes a row the app hasn't already been
    treating as invalid."""
    now = datetime.now(timezone.utc)
    for name in collections:
        coll = db[name]
        try:
            expired_ids = []
            async for doc in coll.find({}, {"_id": 1, "expires_at": 1}):
                exp = doc.get("expires_at")
                if not exp:
                    continue
                exp_dt = datetime.fromisoformat(exp) if isinstance(exp, str) else exp
                if exp_dt.tzinfo is None:
                    exp_dt = exp_dt.replace(tzinfo=timezone.utc)
                if now > exp_dt:
                    expired_ids.append(doc["_id"])
            if expired_ids:
                result = await coll.delete_many({"_id": {"$in": expired_ids}})
                log.info(
                    "session cleanup: removed %d already-expired row(s) from %s",
                    result.deleted_count, name,
                )
        except Exception as exc:  # noqa: BLE001
            log.warning("session cleanup failed for %s: %s", name, exc)
