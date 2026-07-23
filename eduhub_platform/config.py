"""eduhub_platform/config.py — the one canonical 3-tier config resolver
(Architecture Reconstruction Phase 3, "configuration platform").

Package named `eduhub_platform` rather than architecture.md's literal
`platform/` — see eduhub_platform/__init__.py for why. Per that module's
own docstring, this package is home for "identity resolution today;
ledger/config/events/realtime/notify... in later phases" — identity.py
was Phase 1, wallet_service.py's ledger was Phase 2, this is the "config"
half of Phase 3.

The pattern this generalizes already exists and is proven in production
on the frontend: the Experience Configuration Platform's
resolveExperienceConfig.js resolves every teacher-configurable surface
with a FIXED priority — published (admin-set) -> legacy (inferred from
older data) -> default (hardcoded in code) — and that ordering is
documented there as "a migration compatibility guarantee." This module
is the SAME three-tier idea applied to backend feature flags, which
today are read as raw ``os.environ.get(...)`` calls scattered across
wallet_service.py / edutalk_live_tools.py / shadow_writer.py etc. — each
one independently reimplementing the same "true"/"1"/"yes" truthy-string
convention with no way to override a flag without a redeploy.

Resolution order (highest priority first), matching the frontend's
published -> legacy -> default naming exactly:

  1. published — an admin-settable override stored in the
     ``platform_config`` collection (one document per flag name, written
     via ``set_override`` / cleared via ``clear_override``). Lets an
     operator flip a flag at runtime without a redeploy.
  2. legacy — the environment variable of the same name (or an explicit
     ``env_var`` override), matching every existing ad-hoc flag read in
     this codebase today. Nothing is broken if this module is adopted
     incrementally: a flag with no ``platform_config`` document behaves
     EXACTLY as it did before this module existed.
  3. default — the hardcoded fallback the caller supplies.

This module takes ``db`` as an explicit parameter and never imports a
business-domain module (server, wallet_service, etc.) — it has no
business rules of its own, only the resolution mechanism, matching the
package's own one-way dependency contract (domain -> platform, never the
reverse; see .importlinter's "eduhub_platform must not import
business-domain modules" contract).

Collection: ``platform_config`` (owned exclusively by this module).
"""
from __future__ import annotations

import logging
import os
from datetime import datetime, timezone
from typing import Any

log = logging.getLogger("eduhub.platform_config")

COLL_CONFIG = "platform_config"

_TRUTHY = ("true", "1", "yes", "on")
_FALSY = ("false", "0", "no", "off")


async def ensure_config_indexes(db) -> None:
    """Idempotent. Safe to call on every startup. The collection is keyed
    by ``_id`` (the flag name) so no secondary index is required for
    point lookups; this index supports listing overrides by recency."""
    await db[COLL_CONFIG].create_index([("updated_at", -1)])
    log.info("platform_config: indexes ready")


async def resolve_flag(
    db,
    name: str,
    *,
    env_var: str | None = None,
    default: Any = None,
) -> tuple[Any, str]:
    """Resolve a config value through the three tiers.

    Returns ``(value, source)`` where ``source`` is one of
    ``"published"``, ``"legacy"``, or ``"default"`` — callers that need
    to explain WHY a flag has its current value (e.g. an admin status
    endpoint) can surface this directly, matching the frontend
    resolver's own transparency about which tier won.

    A Mongo lookup failure (connection issue, missing collection, etc.)
    NEVER raises out of this function — it degrades to the legacy/env
    tier, exactly as if no override existed. A config-platform hiccup
    must never be able to break whatever the caller is gating.
    """
    try:
        doc = await db[COLL_CONFIG].find_one({"_id": name}, {"_id": 0, "value": 1})
    except Exception as exc:  # noqa: BLE001
        log.warning("platform_config: lookup failed for %r (falling back): %s", name, exc)
        doc = None
    if doc is not None and "value" in doc:
        return doc["value"], "published"

    env_value = os.environ.get(env_var or name)
    if env_value is not None:
        return env_value, "legacy"

    return default, "default"


def _coerce_bool(value: Any, *, default: bool) -> bool:
    if isinstance(value, bool):
        return value
    if value is None:
        return default
    s = str(value).strip().lower()
    if s in _TRUTHY:
        return True
    if s in _FALSY:
        return False
    return default


async def resolve_bool_flag(
    db,
    name: str,
    *,
    env_var: str | None = None,
    default: bool = False,
) -> tuple[bool, str]:
    """Convenience wrapper for the extremely common boolean-flag case,
    using the SAME "true"/"1"/"yes"/"on" truthy-string convention every
    existing ad-hoc flag read in this codebase already uses (e.g.
    wallet_service.py's own ``USE_MONGO_POINTS_READ`` check) — adopting
    this module changes nothing about what counts as "on" for an
    existing flag.
    """
    raw, source = await resolve_flag(db, name, env_var=env_var, default=default)
    return _coerce_bool(raw, default=default), source


async def set_override(db, name: str, value: Any, *, updated_by: str = "") -> dict[str, Any]:
    """Admin-only: write a ``published`` override for ``name``. Takes
    priority over the environment variable immediately — no redeploy,
    no process restart."""
    now = datetime.now(timezone.utc).isoformat()
    doc = {
        "_id": name,
        "value": value,
        "updated_at": now,
        "updated_by": updated_by or "",
    }
    await db[COLL_CONFIG].update_one(
        {"_id": name}, {"$set": doc}, upsert=True,
    )
    return doc


async def clear_override(db, name: str) -> bool:
    """Admin-only: remove the ``published`` override for ``name``,
    reverting resolution to the legacy/env tier. Returns True if a
    document was actually removed."""
    result = await db[COLL_CONFIG].delete_one({"_id": name})
    return bool(getattr(result, "deleted_count", 0))


async def list_overrides(db) -> list[dict[str, Any]]:
    """Admin-only: list every currently-active ``published`` override,
    newest first. Read-only, no side effects."""
    cursor = db[COLL_CONFIG].find({}, {"_id": 1, "value": 1, "updated_at": 1, "updated_by": 1}) \
        .sort("updated_at", -1)
    return [doc async for doc in cursor]


__all__ = [
    "COLL_CONFIG",
    "ensure_config_indexes",
    "resolve_flag",
    "resolve_bool_flag",
    "set_override",
    "clear_override",
    "list_overrides",
]
