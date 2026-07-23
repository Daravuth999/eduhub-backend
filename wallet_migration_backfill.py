"""
wallet_migration_backfill.py — LOCAL dry-run bulk wallet backfill tool for
the GAS -> Mongo points-wallet migration (Architecture Reconstruction
Phase 2, "wallet migration"). NEVER RUN WITH --apply AGAINST PRODUCTION
WITHOUT AN OPERATOR HAVING INDEPENDENTLY REVIEWED THE DRY-RUN REPORT FIRST.

Scope, deliberately narrow, mirroring speaking_lab_wallet_migration.py's
proven safety pattern (same two-key --apply/--confirm gate, same
MONGO_URL/DB_NAME-only connection resolution, same "never wired into
server.py" posture — there is no code path anywhere in this codebase that
invokes this script automatically):

  * This tool seeds db.points_wallets balances from a TRUSTED,
    operator-supplied snapshot file (CSV or JSON) of {student_id,
    clean_id, balance} rows — e.g. a manually verified export of the
    legacy Google Sheet's current point totals. It NEVER calls GAS and
    NEVER accepts or stores a legacy password: the balance a row states
    is the balance that gets written after a --apply run, so it must
    already be trustworthy before this tool ever sees it. This is
    exactly the "Phase 1.5 manual Sheet snapshot" path that
    wallet_service.py's own admin /api/teacher/migration/import-wallets
    route already supports (balance_source="manual_sheet_snapshot") —
    this script is a bulk CLI front-end for that SAME reviewed function
    (import_wallet_one_manual), not a new code path.
  * It reuses import_wallet_one_manual for every row (per-student status
    enum: would_import / imported / skipped_existing / invalid / failed)
    and wallet_seed_status for the post-run readiness summary, matching
    wallet_service.py's own phase_2_gate criteria — no logic is
    duplicated or reinvented here.
  * Reconciling a Mongo balance against the LIVE GAS balance (which does
    require a legacy password) is intentionally NOT done by this script.
    That already has its own reviewed, admin-only, auth-gated HTTP
    endpoint (POST /api/teacher/migration/balance-audit) — a bulk local
    CLI tool is the wrong place to also be handling per-student legacy
    passwords from a file on disk. Run the balance-audit endpoint
    separately (with an authenticated admin session) once every student
    who has a stored legacy_password is ready to be reconciled.

Two-key safety gate for --apply (identical pattern to
speaking_lab_wallet_migration.py's CONFIRM_PHRASE gate): the caller must
pass BOTH --apply AND the exact --confirm phrase. Missing either means
nothing is written. Dry-run (the default) always prints the full would-be
result first, real or not.

Run: cd eduhub-backend && python wallet_migration_backfill.py snapshot.csv
"""

from __future__ import annotations

import argparse
import asyncio
import csv
import json
import os
from pathlib import Path
from typing import Any

import wallet_service as ws

CONFIRM_PHRASE = "I_UNDERSTAND_THIS_WRITES_TRUSTED_SNAPSHOT_BALANCES"


class SnapshotError(ValueError):
    """Raised when the input snapshot file is malformed. Never partially
    processed — a bad file fails the whole run before anything is read
    from or written to Mongo."""


def load_snapshot_rows(path: str) -> list[dict[str, Any]]:
    """Parse a CSV or JSON snapshot file into a list of
    {student_id, clean_id, balance} dicts. Raises SnapshotError on any
    structural problem — never silently drops or guesses a row.

    CSV format: a header row with at least ``student_id`` and
    ``balance`` columns; ``clean_id`` is optional and defaults to
    ``student_id``.

    JSON format: a top-level list of objects with the same three keys.
    """
    p = Path(path)
    if not p.is_file():
        raise SnapshotError(f"snapshot file not found: {path}")

    if p.suffix.lower() == ".json":
        try:
            data = json.loads(p.read_text(encoding="utf-8"))
        except Exception as exc:  # noqa: BLE001
            raise SnapshotError(f"invalid JSON in {path}: {exc}") from exc
        if not isinstance(data, list):
            raise SnapshotError(f"{path}: top-level JSON must be a list")
        rows = data
    else:
        rows = []
        with p.open(encoding="utf-8-sig", newline="") as f:
            reader = csv.DictReader(f)
            if reader.fieldnames is None or "student_id" not in reader.fieldnames:
                raise SnapshotError(
                    f"{path}: CSV must have a header row including "
                    "'student_id' and 'balance' columns"
                )
            rows = list(reader)

    out: list[dict[str, Any]] = []
    for i, row in enumerate(rows):
        if not isinstance(row, dict):
            raise SnapshotError(f"row {i}: not an object/dict: {row!r}")
        sid = (row.get("student_id") or "").strip() if isinstance(row.get("student_id"), str) else row.get("student_id")
        if not sid:
            raise SnapshotError(f"row {i}: missing student_id")
        cid = row.get("clean_id") or sid
        raw_balance = row.get("balance")
        if raw_balance is None or raw_balance == "":
            raise SnapshotError(f"row {i} (student_id={sid!r}): missing balance")
        try:
            balance = float(raw_balance)
        except (TypeError, ValueError) as exc:
            raise SnapshotError(
                f"row {i} (student_id={sid!r}): balance must be numeric, got {raw_balance!r}"
            ) from exc
        out.append({"student_id": sid, "clean_id": cid, "balance": balance})
    return out


async def run_backfill(
    db,
    rows: list[dict[str, Any]],
    *,
    overwrite_existing: bool,
    dry_run: bool,
) -> dict[str, Any]:
    """Run import_wallet_one_manual for every row. Never raises on a
    single bad row — each row's own status/reason captures the outcome,
    matching the admin HTTP endpoint's own behaviour."""
    results = []
    for row in rows:
        try:
            out = await ws.import_wallet_one_manual(
                db,
                student_id=row["student_id"],
                clean_id=row["clean_id"],
                trusted_balance=row["balance"],
                overwrite_existing=overwrite_existing,
                dry_run=dry_run,
            )
        except ws.WalletError as exc:
            out = {
                "student_id": row["student_id"], "clean_id": row["clean_id"],
                "status": "invalid", "reason": exc.message,
            }
        results.append(out)
    summary: dict[str, int] = {}
    for r in results:
        summary[r["status"]] = summary.get(r["status"], 0) + 1
    return {"rows": results, "summary": summary}


def _phase_2_gate_ok(seed_status: dict[str, Any]) -> bool:
    return bool(seed_status.get("can_enable_shadow"))


async def _main_async(args: argparse.Namespace) -> None:
    from motor.motor_asyncio import AsyncIOMotorClient

    mongo_url = os.environ.get("MONGO_URL")
    db_name = os.environ.get("DB_NAME")
    if not mongo_url or not db_name:
        print("MONGO_URL and DB_NAME must both be set in the environment. "
              "Refusing to guess a connection target. Exiting without "
              "connecting.")
        return

    try:
        rows = load_snapshot_rows(args.snapshot)
    except SnapshotError as exc:
        print(f"Snapshot file rejected: {exc}\nNo database connection was made.")
        return
    print(f"Loaded {len(rows)} row(s) from {args.snapshot}.")

    client = AsyncIOMotorClient(mongo_url)
    db = client[db_name]

    dry_run = not (args.apply and args.confirm == CONFIRM_PHRASE)
    result = await run_backfill(
        db, rows, overwrite_existing=args.overwrite_existing, dry_run=dry_run,
    )
    seed_status = await ws.wallet_seed_status(db)
    print(json.dumps({
        "mode": "dry_run" if dry_run else "applied",
        "overwrite_existing": args.overwrite_existing,
        "backfill_summary": result["summary"],
        "wallet_seed_status": seed_status,
        "phase_2_gate_satisfied": _phase_2_gate_ok(seed_status),
        "rows": result["rows"],
    }, indent=2, default=str))

    if dry_run:
        if not args.apply:
            print("\n--apply was not passed. No writes were made.")
        else:
            print(f"\n--apply was passed but --confirm did not exactly match "
                  f"the required phrase {CONFIRM_PHRASE!r}. Refusing to "
                  "write anything.")
        return
    print("\nApplied. Re-run with --apply omitted at any time for a "
          "read-only status check.")


def main() -> None:
    parser = argparse.ArgumentParser(
        description="Bulk wallet backfill from a trusted balance snapshot "
                    "(CSV or JSON). Dry-run by default; --apply requires "
                    f"--confirm with the exact phrase {CONFIRM_PHRASE!r}.")
    parser.add_argument("snapshot", type=str,
                       help="Path to the snapshot file (.csv or .json) with "
                            "student_id, clean_id (optional), balance columns.")
    parser.add_argument("--apply", action="store_true", default=False,
                       help="Actually write wallet balances. Default: off "
                            "(dry-run only).")
    parser.add_argument("--confirm", type=str, default="",
                       help="Must exactly equal the required confirm "
                            "phrase for --apply to take effect.")
    parser.add_argument("--overwrite-existing", action="store_true", default=False,
                       help="Overwrite an existing wallet's balance instead "
                            "of skipping it. Default: off (skip existing).")
    args = parser.parse_args()
    asyncio.run(_main_async(args))


if __name__ == "__main__":
    main()
