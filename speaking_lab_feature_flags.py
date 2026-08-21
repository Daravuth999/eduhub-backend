"""
speaking_lab_feature_flags.py — hard-off-by-default flags for the Speaking
Lab Direct Join reconstruction (v1.0)
=============================================================================

Every flag here gates FINANCIALLY ACTIVE or otherwise production-sensitive
behavior (real wallet debits, real payout transport, schedule semantics).
The safety contract is:

  * missing configuration ALWAYS means OFF — there is no code path where an
    absent env var or absent settings document is treated as "on";
  * the two are ANDed, not ORed: an operator must flip BOTH an explicit
    environment variable AND a backend-owned settings document to enable
    anything. Flipping only one is a no-op. This is deliberate — it means
    no single fat-fingered edit (a stray `true` in one place) can activate
    a financial feature; two independent, deliberate actions are required;
  * the frontend can never override any of this — every gated route
    re-checks the LIVE backend value on every request, never trusting a
    client-supplied flag/state.

This module is intentionally dependency-free (only `os` + Motor's db
handle) so it can be imported by any Speaking Lab module without risk of
circular imports.
"""

from __future__ import annotations

import os
from typing import Optional

# ── settings document layout ────────────────────────────────────────────────
SETTINGS_COLLECTION = "speaking_lab_settings"
SETTINGS_DOC_ID = "feature_flags"

_TRUTHY = {"1", "true", "yes", "on"}


def _env_flag(name: str) -> Optional[bool]:
    """Returns True/False if the env var is explicitly set to a recognised
    value, or None if unset/unrecognised (treated as "not explicitly on"
    by every caller in this module)."""
    raw = os.environ.get(name)
    if raw is None:
        return None
    return raw.strip().lower() in _TRUTHY


async def _db_flag(db, field: str) -> bool:
    """Read one boolean field from the backend-owned settings document.
    Missing document or missing field => False. Never raises — a database
    hiccup while reading a feature flag must fail closed, not 500."""
    try:
        doc = await db[SETTINGS_COLLECTION].find_one(
            {"_id": SETTINGS_DOC_ID}, {"_id": 0},
        )
    except Exception:  # noqa: BLE001
        return False
    return bool((doc or {}).get(field, False))


async def _flag(db, env_name: str, db_field: str) -> bool:
    """AND-gate: True only when BOTH the environment variable is explicitly
    truthy AND the backend settings document also has the field set true."""
    env_val = _env_flag(env_name)
    if env_val is not True:
        return False
    return await _db_flag(db, db_field)


# ── the three mandatory hard-off financial flags ────────────────────────────
async def direct_join_enabled(db) -> bool:
    """speaking_lab_direct_join_enabled — gates POST .../direct-join
    actually performing a wallet transfer + entry + code. When False, the
    route returns a safe, explicit "disabled" response and mutates
    nothing."""
    return await _flag(
        db, "SPEAKING_LAB_DIRECT_JOIN_ENABLED", "speaking_lab_direct_join_enabled",
    )


async def wallet_payout_enabled(db) -> bool:
    """speaking_lab_wallet_payout_enabled — gates the LOCAL, dark
    WalletService-based Lucky Draw payout transport. Production default
    stays on the existing GAS transport regardless of this flag until an
    explicit, separately-approved cutover."""
    return await _flag(
        db, "SPEAKING_LAB_WALLET_PAYOUT_ENABLED", "speaking_lab_wallet_payout_enabled",
    )


async def wallet_cutover_enabled(db) -> bool:
    """speaking_lab_wallet_cutover_enabled — the single "point of no
    return" flag for treating Mongo as the authoritative ledger in
    production (removing the GAS balance fallback). Never enabled by this
    delivery; exists only so the future activation procedure has a named,
    auditable switch."""
    return await _flag(
        db, "SPEAKING_LAB_WALLET_CUTOVER_ENABLED", "speaking_lab_wallet_cutover_enabled",
    )


async def vault_enabled(db) -> bool:
    """speaking_lab_vault_enabled — gates the Friday Vault experience layer
    (speaking_lab_vault.py). When False, POST .../vault/grant returns a
    safe, explicit "disabled" response and credits nothing; the frontend
    skips the Vault entirely and proceeds straight to the existing Mystery
    Box flow, exactly as it did before this feature existed."""
    return await _flag(
        db, "SPEAKING_LAB_VAULT_ENABLED", "speaking_lab_vault_enabled",
    )


def vault_env_flag_set() -> bool:
    """Read-only: is the ops-controlled half of the AND-gate set in THIS
    environment? Author Studio can toggle the DB half (see
    speaking_lab_vault.py's vault-config panel) but can never set this —
    it's an infrastructure-level switch, flipped once per environment by
    whoever manages deployment config, never from a web UI. Exposed so
    the admin panel can honestly show "also needs an infra flag" instead
    of a toggle that silently does nothing."""
    return _env_flag("SPEAKING_LAB_VAULT_ENABLED") is True


async def get_vault_db_flag(db) -> bool:
    """The admin-editable half only — NOT the full AND-gated decision.
    Callers that need to know whether the feature actually runs must use
    vault_enabled(db), which requires both halves."""
    return await _db_flag(db, "speaking_lab_vault_enabled")


async def set_vault_db_flag(db, value: bool) -> None:
    """Author Studio's Friday Vault "Enabled" toggle writes here. This is
    deliberately only HALF of the AND-gate — flipping it alone does
    nothing in an environment where the ops env var isn't also set,
    preserving the "two independent, deliberate actions" safety
    contract documented at the top of this module."""
    await db[SETTINGS_COLLECTION].update_one(
        {"_id": SETTINGS_DOC_ID},
        {"$set": {"speaking_lab_vault_enabled": bool(value)}},
        upsert=True,
    )


async def all_flags(db) -> dict:
    """Snapshot of every flag's live value — used by tests and the
    activation runbook, never by product logic (each gate re-checks its
    own flag independently so there's no risk of a stale snapshot being
    used to make a decision).

    Combined A+B scheduling is NOT one of these flags — it's a standard,
    permanent session mode (see server.py's sl_create_session), not a
    financially-gated feature. A stale `SPEAKING_LAB_AB_SCHEDULE_ENABLED`
    env var or `speaking_lab_ab_schedule_enabled` DB field from an earlier
    revision is simply ignored; nothing here reads it."""
    return {
        "speaking_lab_direct_join_enabled": await direct_join_enabled(db),
        "speaking_lab_wallet_payout_enabled": await wallet_payout_enabled(db),
        "speaking_lab_wallet_cutover_enabled": await wallet_cutover_enabled(db),
        "speaking_lab_vault_enabled": await vault_enabled(db),
    }
