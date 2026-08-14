"""
speaking_lab_wallet_migration.py — LOCAL dry-run wallet bootstrap + index
reconciliation tooling for the Speaking Lab Direct Join / WalletService
migration (NEVER RUN AGAINST PRODUCTION IN THIS DELIVERY).

Scope, deliberately narrow (per the approved target architecture):
  * This tool does NOT attempt to import or guess any student's "true"
    points balance from GAS. Phase 0 Gate A already proved GAS exposes no
    bulk balance export and no per-student balance readback safe enough to
    treat as authoritative — so this tool never invents an opening balance
    for anyone. Every wallet it creates starts at exactly 0.
  * Its only job is to report (dry-run) and, if explicitly confirmed,
    create MISSING `points_wallets` documents for active students who do
    not have one yet — the same zero-balance bootstrap that already
    happens lazily and idempotently inside `WalletService._ensure_wallet`
    on first real transaction. Running this tool ahead of time just makes
    the "who has no wallet yet" picture visible before any code path
    depends on it.
  * A companion index report lists which indexes each Speaking Lab /
    wallet collection currently has, without creating or dropping any of
    them. Applying is done by calling the SAME already-reviewed
    `ensure_*_indexes()` functions used at server startup — this tool
    never defines its own index specs, so there is no risk of drift
    between "what this tool creates" and "what the server creates".

Two-key safety gate for `--apply` (mirrors speaking_lab_feature_flags'
AND-gate pattern): the caller must pass BOTH `--apply` AND the exact
`--confirm` phrase. Missing either means nothing is written. There is no
default wiring anywhere in this codebase that invokes apply mode — it is
only reachable by a human running this file directly from a terminal.
"""

from __future__ import annotations

import argparse
import asyncio
import os
from typing import Any

import wallet_service as ws

CONFIRM_PHRASE = "I_UNDERSTAND_THIS_CREATES_ZERO_BALANCE_WALLETS_ONLY"

COLLECTION_STUDENTS = "students"


def _safe_norm_id(raw: Any) -> str | None:
    """Best-effort id normalization matching wallet_service's own
    `_norm_id`, but never raises — an unparsable id is reported as a
    skipped row rather than aborting the whole plan."""
    try:
        return ws._norm_id(raw)  # reuse the exact same normalization
    except Exception:
        return None


async def plan_wallet_bootstrap(db) -> dict:
    """Read-only. Reports, per active student, whether a `points_wallets`
    row already exists. Creates nothing. No PII beyond student ids."""
    total = 0
    present = 0
    skipped_unparsable = 0
    missing: list[str] = []
    cursor = db[COLLECTION_STUDENTS].find(
        {"is_active": {"$ne": False}},
        {"_id": 0, "student_id": 1, "clean_id": 1},
    )
    async for doc in cursor:
        total += 1
        raw_id = doc.get("clean_id") or doc.get("student_id")
        sid = _safe_norm_id(raw_id)
        if sid is None:
            skipped_unparsable += 1
            continue
        wallet = await db[ws.COLL_WALLETS].find_one(
            {"student_id": sid}, {"_id": 0, "student_id": 1})
        if wallet:
            present += 1
        else:
            missing.append(sid)
    return {
        "active_student_count": total,
        "wallets_present": present,
        "wallets_missing": len(missing),
        "skipped_unparsable_id": skipped_unparsable,
        "missing_student_ids_sample": missing[:50],
        "missing_list_truncated": len(missing) > 50,
    }


async def apply_wallet_bootstrap(db, *, confirm: str) -> dict:
    """Creates a zero-balance, active `points_wallets` row for every
    active student who is currently missing one. Never mutates the
    balance of an existing wallet (delegates to `_ensure_wallet`, which is
    itself idempotent and balance-preserving). Requires the exact
    confirmation phrase — this is not meant to be callable by accident
    from any automated path."""
    if confirm != CONFIRM_PHRASE:
        raise ValueError(
            "apply_wallet_bootstrap refused: confirm phrase did not match "
            "exactly. Nothing was written."
        )
    plan = await plan_wallet_bootstrap(db)
    svc = ws.WalletService(db)
    created = 0
    for sid in plan["missing_student_ids_sample"]:
        await svc._ensure_wallet(sid)
        created += 1
    # If the sample was truncated, re-plan and continue until nothing is
    # left missing — still one student at a time, still zero-balance only.
    while plan["missing_list_truncated"]:
        plan = await plan_wallet_bootstrap(db)
        if not plan["missing_student_ids_sample"]:
            break
        for sid in plan["missing_student_ids_sample"]:
            await svc._ensure_wallet(sid)
            created += 1
    return {"wallets_created": created}


# --------------------------------------------------------------------------- #
# Index reconciliation report — read-only listing, apply delegates entirely  #
# to the already-reviewed ensure_*_indexes() functions (no spec duplication).#
# --------------------------------------------------------------------------- #
INDEX_MANAGED_COLLECTIONS = {
    "points_wallets": "wallet_service.ensure_wallet_indexes",
    "points_transactions": "wallet_service.ensure_wallet_indexes",
    "speaking_lab_lucky_draws": "lucky_draw.ensure_lucky_draw_indexes",
    "speaking_lab_direct_joins": "speaking_lab_direct_join.ensure_direct_join_indexes",
    "speaking_lab_entries": "speaking_lab_direct_join.ensure_direct_join_indexes",
    "speaking_lab_lucky_codes": "speaking_lab_direct_join.ensure_direct_join_indexes",
}


async def plan_index_report(db) -> dict:
    """Read-only. Lists index names currently present on each managed
    collection, and which ensure_*_indexes() function owns that
    collection's required indexes. Creates nothing."""
    report: dict[str, dict] = {}
    for coll_name, owner in INDEX_MANAGED_COLLECTIONS.items():
        try:
            names = [idx["name"] async for idx in db[coll_name].list_indexes()]
        except Exception as exc:  # noqa: BLE001 — a missing collection is not fatal
            names = []
            report[coll_name] = {"owner": owner, "current_indexes": names,
                                 "error": str(exc)[:200]}
            continue
        report[coll_name] = {"owner": owner, "current_indexes": names}
    return report


async def apply_index_ensure(db, *, confirm: str) -> dict:
    """Calls the real, already-reviewed ensure_*_indexes() functions.
    Requires the exact confirmation phrase. This delivery never calls
    this function — it exists to be run manually, later, by a human who
    has independently reviewed this file."""
    if confirm != CONFIRM_PHRASE:
        raise ValueError(
            "apply_index_ensure refused: confirm phrase did not match "
            "exactly. Nothing was created."
        )
    import lucky_draw as ld
    import speaking_lab_direct_join as sldj
    await ws.ensure_wallet_indexes(db)
    await ld.ensure_lucky_draw_indexes(db)
    await sldj.ensure_direct_join_indexes(db)
    return await plan_index_report(db)


# --------------------------------------------------------------------------- #
# CLI entrypoint — dry-run by default. --apply requires --confirm exactly.   #
# --------------------------------------------------------------------------- #
async def _main_async(args: argparse.Namespace) -> None:
    import json
    from motor.motor_asyncio import AsyncIOMotorClient

    mongo_url = os.environ.get("MONGO_URL")
    db_name = os.environ.get("DB_NAME")
    if not mongo_url or not db_name:
        print("MONGO_URL and DB_NAME must both be set in the environment. "
              "Refusing to guess a connection target. Exiting without "
              "connecting.")
        return
    client = AsyncIOMotorClient(mongo_url)
    db = client[db_name]

    wallet_plan = await plan_wallet_bootstrap(db)
    index_plan = await plan_index_report(db)
    print(json.dumps({
        "mode": "dry_run",
        "wallet_bootstrap_plan": wallet_plan,
        "index_report": index_plan,
    }, indent=2, default=str))

    if not args.apply:
        print("\n--apply was not passed. No writes were made.")
        return
    if args.confirm != CONFIRM_PHRASE:
        print(f"\n--apply was passed but --confirm did not exactly match "
              f"the required phrase. Refusing to write anything.")
        return
    wallet_result = await apply_wallet_bootstrap(db, confirm=args.confirm)
    index_result = await apply_index_ensure(db, confirm=args.confirm)
    print(json.dumps({
        "mode": "applied",
        "wallet_bootstrap_result": wallet_result,
        "index_ensure_result": index_result,
    }, indent=2, default=str))


def main() -> None:
    parser = argparse.ArgumentParser(
        description="Speaking Lab wallet bootstrap + index dry-run tool. "
                    "Dry-run by default; --apply requires --confirm with "
                    f"the exact phrase {CONFIRM_PHRASE!r}.")
    parser.add_argument("--apply", action="store_true", default=False,
                       help="Actually write zero-balance wallets / create "
                            "indexes. Default: off (dry-run only).")
    parser.add_argument("--confirm", type=str, default="",
                       help="Must exactly equal the required confirm "
                            "phrase for --apply to take effect.")
    args = parser.parse_args()
    asyncio.run(_main_async(args))


if __name__ == "__main__":
    main()
