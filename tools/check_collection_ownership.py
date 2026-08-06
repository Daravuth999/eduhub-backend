#!/usr/bin/env python
"""tools/check_collection_ownership.py — MongoDB collection-ownership lint.

Architecture Reconstruction Phase 1e ("Collection Ownership" — "Each MongoDB
collection must have one owning module. Other modules may consume through
interfaces but should not write directly. Enforce this through architecture
and tooling where practical.").

The full backend has ~101 distinct collections and confirmed pre-existing
multi-module violations (e.g. `students` touched by 13 modules,
`points_wallets` touched by 4 despite wallet_service.py's own docstring
claiming exclusive ownership). Untangling those is real consolidation work
— a later phase, not this one. This script has two modes to match that:

  (no flags)  Report mode — lists every collection referenced by more than
              one file. Always exits 0. Informational: "here is today's
              real fan-out," not a blocking gate. Safe to run in CI as a
              visibility step.

  --strict    Enforcement mode — checks ONLY the collections in
              OWNED_COLLECTIONS below (each one a collection this Phase 1
              conversion pass gave a single, confirmed real owning module,
              by reading the code) against every file that references them.
              Fails (exit 1) if any of those collections is now touched by
              a file other than its declared owner (or the tests/ dir).
              This is a genuine, currently-passing regression gate — it
              does not require solving the pre-existing 101-collection
              problem, only guarding what Phase 1 already made clean. Grow
              OWNED_COLLECTIONS as more collections get consolidated.

Detection is a static regex scan for `db.<name>` and `db["<name>"]` /
`db['<name>']` — good enough for this codebase's actual usage (confirmed:
no dynamic `db[some_variable]` collection access patterns in the modules
this script's OWNED_COLLECTIONS covers), not a general-purpose Mongo query
analyzer.
"""
from __future__ import annotations

import argparse
import re
import sys
from pathlib import Path

BACKEND_DIR = Path(__file__).resolve().parent.parent

# Directories never scanned: virtualenvs, node deps, git internals, and the
# tests/ tree (fakes/mocks reference collection names too, which is not an
# ownership signal).
EXCLUDED_DIR_NAMES = {
    ".git", "node_modules", "__pycache__", "tests", "tools",
    "venv", ".venv", "env", ".env",
}

_ATTR_PATTERN = re.compile(r"\bdb\.([A-Za-z_][A-Za-z0-9_]*)\b")
_SUBSCRIPT_PATTERN = re.compile(r"""\bdb\[\s*["']([A-Za-z0-9_]+)["']\s*\]""")

# Collections this Phase 1 conversion pass confirmed have exactly one real
# owning module (verified by reading each module's own code, not guessed).
# Extend this as later phases consolidate more of the ~101 total collections.
OWNED_COLLECTIONS: dict[str, str] = {
    # login_reward_tools.py (Phase 1b/1c reward-chain hub)
    "login_reward_campaigns": "login_reward_tools.py",
    "login_reward_claims": "login_reward_tools.py",
    "student_vouchers": "login_reward_tools.py",
    # mystery_box_tools.py
    "mystery_box_prize_templates": "mystery_box_tools.py",
    "edutalk_pass_templates": "mystery_box_tools.py",
    "speaking_lab_mystery_campaigns": "mystery_box_tools.py",
    "speaking_lab_mystery_rounds": "mystery_box_tools.py",
    "speaking_lab_mystery_claims": "mystery_box_tools.py",
    "speaking_lab_reward_history": "mystery_box_tools.py",
    "student_feature_entitlements": "mystery_box_tools.py",
    # login_mystery_box_tools.py
    "login_mystery_campaigns": "login_mystery_box_tools.py",
    "login_mystery_claims": "login_mystery_box_tools.py",
    # referral_tools.py
    "referral_codes": "referral_tools.py",
    "referral_leads": "referral_tools.py",
    "referral_rewards": "referral_tools.py",
    "referral_config": "referral_tools.py",
    # camrapidpay_payment_tools.py
    "camrapidpay_intents": "camrapidpay_payment_tools.py",
    "camrapidpay_webhook_log": "camrapidpay_payment_tools.py",
    # payment_methods_config_tools.py
    "payment_method_settings": "payment_methods_config_tools.py",
    # tuition_tools.py
    "tuition_records": "tuition_tools.py",
    "tuition_payment_intents": "tuition_tools.py",
    "tuition_receipts": "tuition_tools.py",
    "tuition_config": "tuition_tools.py",
    "tuition_reminder_dismissals": "tuition_tools.py",
    # payment_bridge.py
    "payment_intents": "payment_bridge.py",
    "payment_transactions": "payment_bridge.py",
    "payment_settings": "payment_bridge.py",
    "payment_audit_log": "payment_bridge.py",
    # eduhub_platform/config.py (Architecture Reconstruction Phase 3)
    "platform_config": "config.py",
    "platform_config_audit": "config.py",
    # event_engine.py (Event Engine v1 — architecture.md Migration Phase 3)
    "event_templates": "event_engine.py",
    "events": "event_engine.py",
    # question_bank.py (Architecture Reconstruction continuation)
    "question_bank_items": "question_bank.py",
    # notification_packs.py (Architecture Reconstruction continuation)
    "notification_packs": "notification_packs.py",
    # prize_pool.py (Architecture Reconstruction continuation — Prize Pool Platform)
    "prize_pools": "prize_pool.py",
    # sync_studio_tools.py (Universal Synchronization Engine, Phase 0 foundation)
    "chapter_sync": "sync_studio_tools.py",
}

# Specific (collection, offending file) pairs that are a deliberate, reviewed
# exception rather than architecture debt — a genuine single owner exists and
# does full CRUD/lifecycle management, but exactly one sibling module has a
# narrow, intentional reason to also touch the collection. Documented here
# (and in the offending module's own code) instead of silently widening
# OWNED_COLLECTIONS to multiple "owners", which would make the guarantee
# dishonest. Add to this only with the same level of justification.
ACCEPTED_EXCEPTIONS: dict[str, set[str]] = {
    # camrapidpay_payment_tools.py's _cam_load_package reads payment_settings
    # (the amount->points price table) to price a top-up; it never writes to
    # the collection. payment_bridge.py remains the sole writer/lifecycle
    # owner. See payment_bridge.py's _payment_bridge_ensure_indexes docstring.
    "payment_settings": {"camrapidpay_payment_tools.py"},
    # voucher_reward_tools.py is a thin read surface over vouchers issued by
    # login_reward_tools.py; it normally reads/writes through the collection
    # handle login_reward_tools.py itself hands it via LoginRewardHooks
    # (login_reward_hooks.student_vouchers — the owner's own object, not a
    # separate connection). The `db["student_vouchers"]` branch only engages
    # if login_reward_hooks is None (login_reward_tools failed to load), an
    # already-degraded fallback path with no other collection owner to
    # delegate to. See voucher_reward_tools.py's module docstring.
    "student_vouchers": {"voucher_reward_tools.py"},
}


def _iter_py_files() -> list[Path]:
    out = []
    for path in BACKEND_DIR.rglob("*.py"):
        if any(part in EXCLUDED_DIR_NAMES for part in path.parts):
            continue
        out.append(path)
    return out


def _collections_in_file(path: Path) -> set[str]:
    try:
        text = path.read_text(encoding="utf-8", errors="ignore")
    except Exception:
        return set()
    found = set(_ATTR_PATTERN.findall(text)) | set(_SUBSCRIPT_PATTERN.findall(text))
    # `db.attribute` also matches non-collection attribute access on other
    # objects named `db` in unrelated scopes; harmless false positives here
    # only widen a collection's touching-file set, they never hide a real one.
    return found


def build_touch_map() -> dict[str, set[Path]]:
    touch_map: dict[str, set[Path]] = {}
    for path in _iter_py_files():
        for coll in _collections_in_file(path):
            touch_map.setdefault(coll, set()).add(path)
    return touch_map


def report_mode(touch_map: dict[str, set[Path]]) -> int:
    multi = {c: files for c, files in touch_map.items() if len(files) > 1}
    print(f"Scanned collections: {len(touch_map)} total, {len(multi)} touched by more than one file.\n")
    for coll in sorted(multi):
        rel = sorted(str(f.relative_to(BACKEND_DIR)) for f in multi[coll])
        owner = OWNED_COLLECTIONS.get(coll)
        tag = f" [OWNED by {owner}]" if owner else ""
        print(f"  {coll}{tag}: {', '.join(rel)}")
    print(
        "\nInformational only (exit 0). Multi-module access to an "
        "un-owned collection is pre-existing, tracked debt, not a new "
        "regression this run introduced. Run with --strict to enforce "
        "the collections that already have a confirmed single owner."
    )
    return 0


def strict_mode(touch_map: dict[str, set[Path]]) -> int:
    violations: list[str] = []
    accepted: list[str] = []
    for coll, owner_file in OWNED_COLLECTIONS.items():
        files = touch_map.get(coll, set())
        exceptions = ACCEPTED_EXCEPTIONS.get(coll, set())
        offenders = sorted(
            str(f.relative_to(BACKEND_DIR))
            for f in files
            if f.name != owner_file and f.name not in exceptions
        )
        accepted_offenders = sorted(
            str(f.relative_to(BACKEND_DIR))
            for f in files
            if f.name != owner_file and f.name in exceptions
        )
        if accepted_offenders:
            accepted.append(f"  {coll}: owned by {owner_file}, also touched by {', '.join(accepted_offenders)} (accepted exception)")
        if offenders:
            violations.append(
                f"  {coll}: owned by {owner_file}, also touched by {', '.join(offenders)}"
            )
    if violations:
        print("Collection-ownership violations (--strict):\n")
        print("\n".join(violations))
        print(
            f"\n{len(violations)} owned collection(s) touched outside their "
            "declared owner. Fix the extra access, or update "
            "OWNED_COLLECTIONS in tools/check_collection_ownership.py if "
            "the new module is now the legitimate sole owner instead."
        )
        return 1
    if accepted:
        print("Accepted exceptions (reviewed, documented, not failing the gate):\n")
        print("\n".join(accepted))
        print()
    print(f"OK — all {len(OWNED_COLLECTIONS)} owned collections are touched only by their declared owner (or a documented accepted exception).")
    return 0


def main() -> int:
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument(
        "--strict", action="store_true",
        help="Fail if any collection in OWNED_COLLECTIONS is touched outside its declared owner.",
    )
    args = parser.parse_args()

    touch_map = build_touch_map()
    if args.strict:
        return strict_mode(touch_map)
    return report_mode(touch_map)


if __name__ == "__main__":
    sys.exit(main())
