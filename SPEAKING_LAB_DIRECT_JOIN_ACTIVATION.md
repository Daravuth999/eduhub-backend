# Speaking Lab Direct Join — Activation Guide

**Status as of this document: IMPLEMENTED LOCALLY — READY FOR INDEPENDENT AUDIT.**
Nothing described here has been deployed, pushed to a shared branch, or
activated against production. Every financial code path is hard-disabled
by default and requires a human to flip both an environment variable AND
a database document field before it does anything.

This document is the single place that explains: what was built, what
state it's in right now, and the exact sequence a human operator must
follow to turn any of it on — in an order that lets them stop and verify
at every step.

---

## 1. What this delivery contains

| Component | File | Purpose |
|---|---|---|
| Wallet session composability | `wallet_service.py` | Lets a caller pass its own Mongo session into `credit()` / `debit()` / `transfer()` so multiple writes commit atomically together. Zero change to any existing caller (session omitted = old behavior, unchanged). |
| Lucky code persist/publish split | `lucky_draw.py` | Separates the pure Mongo write (`persist_lucky_code`) from the post-commit SSE broadcast (`publish_lucky_code_events`), so a caller can put the write inside its own transaction. `generate_and_publish_lucky_code`'s existing public contract is unchanged. |
| Shared schedule eligibility | `teacher_admission.py` | `session_schedule_eligibility()` now understands a session-level `"AB"` value (admits A, B, and unassigned students) in addition to the existing `"A"`/`"B"` exact-match behavior. Reused by both Missing Code Rescue and Direct Join. |
| Feature flags | `speaking_lab_feature_flags.py` | Four AND-gated flags (env var **and** `speaking_lab_settings` DB doc field must both be true). Missing either means OFF. |
| Direct Join core | `speaking_lab_direct_join.py` | The atomic "tap to join" flow: one Mongo transaction that validates eligibility, charges the student via `WalletService.transfer()`, creates/links the pool entry, and persists the lucky code — all committed together or none of it. |
| Dark wallet payout transport | `speaking_lab_wallet_payout.py` + `lucky_draw._select_transfer_outcome` | A minimal transport-selection seam inside `_process_winner`'s ONE payout-provider call site. `speaking_lab_wallet_payout.wallet_transfer_outcome()` is a WalletService-backed drop-in replacement for `_provider_transfer`, with the identical outcome contract — `_process_winner`'s claim / persist / push / retry / manual-review state machine is completely unaware of which transport ran. **Never referenced by server.py**; only reachable through `_select_transfer_outcome`, which defaults to the existing GAS path whenever `speaking_lab_wallet_payout_enabled` is off (including if the flag check itself errors). |
| Migration / index tooling | `speaking_lab_wallet_migration.py` | A CLI, dry-run by default, that reports (never writes) which active students lack a `points_wallets` row and which indexes exist. `--apply` requires an exact confirmation phrase and only ever creates **zero-balance** wallets — it never guesses or imports an opening balance from anywhere. |
| Server wiring | `server.py` | Registers the Direct Join routes, the read-only `/speaking-lab/feature-flags` status route, and the `schedule` field (`"A"`/`"B"`/`"AB"`) on session creation. All additive; no existing route's behavior changed. |
| PWA student UI | `eduhub-studio-test` → `JoinPrizePool.tsx` + `speakingLabApi.ts` | An isolated, **not wired into any existing route**, component that calls `/direct-join` and `/my-entry`. Degrades cleanly (friendly message, no crash) while the backend flag is off. |
| Teacher UI | `speaking-lab-game (Live)` → `ScheduleSelector.jsx`, `LiveRosterGate.jsx` | A "Combined A+B" schedule button with a live "Not enabled" badge sourced from the new read-only flags route, and a friendly disabled-state message if a teacher tries to start an AB session before it's turned on. |

Everything above ships with its own test suite. See §5 for exact counts.

---

## 2. What is deliberately NOT done

- No production Mongo balance migration has been run or even attempted.
  Phase 0 evidence (Gate A) proved GAS exposes no bulk balance export and
  no safe per-student balance readback — so this delivery never invents
  or imports an opening balance for anyone. Every wallet the tooling can
  create starts at exactly 0.
- No feature flag has been turned on anywhere, including locally in a
  committed `.env`.
- No production index has been created by this delivery.
- No existing consumer of `WalletService`, `lucky_draw.py`, or
  `teacher_admission.py` had its behavior changed — every extension is
  strictly additive (new optional parameters, new functions, new routes).
- The protected functions `_weighted_pick`, `_normalize_split`,
  `_run_draw`, and `_sl_try_auto_enter` are byte-for-byte unchanged (see
  §4). `_process_winner` (the live GAS payout path) is NOT one of these
  four — it now contains a one-line change (see §3a) that routes its
  single payout-provider call through a transport-selection seam. Its
  claim / persist / push / retry / manual-review state machine is
  otherwise identical, and all six of its call sites needed zero changes.

---

## 3. Activation sequence (in order — do not skip steps)

Each step is independently reversible: unset the env var or the DB field
and the system falls back to the exact prior behavior instantly, because
every new code path is gated by the same AND-gate check on every request.

### Step 0 — Prerequisite: production wallet parity evidence

Before touching any flag, run the read-only diagnostic that Phase 0 of
this project already prepared and audited (see prior "Speaking Lab Wallet
Diagnostic v2" — read-only, bounded, no PII, no test writes) against
production, from a Render Shell. Confirm:

- `points_wallets` balances are self-consistent with `points_transactions`
  history (no drift).
- The proportion of active students who already have a wallet row.
- Whatever gap exists is understood and accepted (this delivery's
  migration tool only ever bootstraps missing wallets at **zero** — it
  does not attempt to reconcile a nonzero "true" balance from GAS).

### Step 1 — Wallet bootstrap dry-run (no production access required to prepare; requires Render Shell to execute against prod)

```
py speaking_lab_wallet_migration.py
```

With `MONGO_URL` / `DB_NAME` pointed at the target database and no
`--apply` flag, this only **prints** a JSON report: how many active
students are missing a `points_wallets` row, and which indexes already
exist on each managed collection. Nothing is written. Review the report.

### Step 2 — Wallet bootstrap + index apply (optional, explicit)

```
py speaking_lab_wallet_migration.py --apply --confirm I_UNDERSTAND_THIS_CREATES_ZERO_BALANCE_WALLETS_ONLY
```

This creates zero-balance `points_wallets` rows for any active student
who doesn't have one yet (idempotent — safe to re-run), and calls the
same `ensure_wallet_indexes()` / `ensure_lucky_draw_indexes()` /
`ensure_direct_join_indexes()` functions the server already calls at
startup (no separate index spec to drift). Skipping this step is fine —
`WalletService._ensure_wallet()` bootstraps a wallet lazily on first real
use anyway; this step just makes the "who's missing one" picture visible
ahead of time.

### Step 3 — Turn on Direct Join for a single pilot session

1. Set `SPEAKING_LAB_DIRECT_JOIN_ENABLED=true` in the environment.
2. Insert (or update) the `speaking_lab_settings` document with
   `{"_id": "feature_flags", "speaking_lab_direct_join_enabled": true}`.
3. Confirm activation by calling `GET /api/speaking-lab/feature-flags`
   (teacher/admin auth) — `speaking_lab_direct_join_enabled` should now
   read `true`.
4. Run one real class session using the new "Join Prize Pool" PWA
   component (not yet linked into student navigation — mount it
   explicitly for the pilot, e.g. behind a direct URL or a temporary
   nav entry) and confirm: the join is atomic, the lucky code appears,
   `/my-entry` reflects it after a refresh, and the push notification
   arrives exactly once.
5. If anything looks wrong, unset either the env var or the DB field —
   Direct Join immediately 503s again and the legacy P2P + reconciliation
   flow keeps working exactly as it did before this delivery (nothing
   about the legacy path was changed).

### Step 4 — Combined A+B scheduling (independent of Step 3)

1. Set `SPEAKING_LAB_AB_SCHEDULE_ENABLED=true` (env) and the matching
   `speaking_lab_ab_schedule_enabled: true` DB field.
2. The teacher app's "Combined A+B" button will stop showing "Not
   enabled" (it polls the same flags route) and session creation with
   `schedule="AB"` will succeed instead of 403ing.

### Step 5 — Dark wallet payout transport for Lucky Draw (only after Steps 1–4 have run cleanly for a while)

This is the highest-risk flag — it changes how a REAL Lucky Draw payout
moves money. Unlike the other flags, this one IS wired all the way
through to `_process_winner`'s real payout call (via the
`_select_transfer_outcome` seam in `lucky_draw.py`) — turning it on in
production would take effect immediately on the next winner processed.
Do not enable it until:

- Direct Join has been live and stable for multiple sessions (proves
  `WalletService.transfer()` behaves correctly under real load).
- A human has independently reviewed `speaking_lab_wallet_payout.py` and
  `lucky_draw._select_transfer_outcome` line by line — they have never
  run against production, only against the fake Mongo harness in
  `tests/test_speaking_lab_wallet_payout.py`.
- Rollback is a single flag flip: unset `SPEAKING_LAB_WALLET_PAYOUT_ENABLED`
  (or its DB doc field) and the very next `_process_winner` call reverts
  to the byte-for-byte-original `_provider_transfer` (GAS) call — nothing
  to undo in Mongo, no code to revert. If the flag lookup itself ever
  errors, the seam fails safe to the GAS path automatically (see
  `test_b3_flag_check_error_fails_safe_to_gas`).
- Every one of `_process_winner`'s 6 real call sites (finalize, retry
  endpoint, manual-release endpoint, browser-abandoned recovery, etc.)
  is covered for free — none of them needed to change, because the seam
  lives inside `_process_winner` itself, not at its call sites.

### Step 6 — Full wallet cutover (`SPEAKING_LAB_WALLET_CUTOVER_ENABLED`)

Reserved for a future phase where the PWA's balance display itself
switches from GAS to Mongo as the primary read path. Not implemented in
this delivery beyond the flag existing. Do not enable.

---

## 4. Protected-function integrity — how to re-verify

Every test file that touches Lucky Draw or Direct Join includes an
AST-parse + SHA-256 hash check against a baseline captured before this
delivery's changes were written. To re-run these checks independently at
any time:

```
py -m pytest tests/test_speaking_lab_direct_join.py -k unchanged -q
py -m pytest tests/test_speaking_lab_wallet_payout.py -k "protected_functions" -q
```

Baselines for the four functions the spec requires to remain
byte-for-byte unchanged:

| Function | File | SHA-256 |
|---|---|---|
| `_weighted_pick` | `lucky_draw.py` | `871c5ad4d2cc3d721ed309e8dc2930e55053fdd9ac53d5a2a3fb815d6ccd461a` |
| `_normalize_split` | `lucky_draw.py` | `077c2583249d28118a489a47ad00fa669f14375e8db6b7a153837bff6fa9a359` |
| `_run_draw` | `lucky_draw.py` | `65ecec65bcd07a0fad9023e8b3b91f73a801c6ec551e93d63b989ef164825aac` |
| `_sl_try_auto_enter` | `server.py` | `55547f3dbfe4767c85d0011bfe3954bc11ce41f59e49c482398e476f6b7f18e5` |

If any of these hashes ever change, the corresponding test fails loudly —
that is the point. A future change to one of these functions is not
forbidden forever, it just means the baseline needs a deliberate,
reviewed update (re-run the same `py -c` AST-hash snippet used to
generate the table above and replace the value, in its own commit, with
its own explanation).

`_process_winner` is deliberately NOT in the table above — it is not one
of the four protected functions, and this delivery intentionally changed
it (one line: the payout-provider call now goes through
`_select_transfer_outcome`). For traceability, the before/after hashes of
`_process_winner` and the new `_select_transfer_outcome` seam function
are recorded here (not as a pass/fail gate, just as an audit record):

| Function | File | SHA-256 (before this delivery) | SHA-256 (after) |
|---|---|---|---|
| `_process_winner` | `lucky_draw.py` | `1fbfdc04aeca92137dbe3bd006ffcc20b2861e5ad78aadf10774786b96de0ebe` | `53aa9f4c4e4ce9cf74c0a5d74b3c2433fdb1d0f0ea93407248fdde13a3b77693` |
| `_select_transfer_outcome` (new) | `lucky_draw.py` | *(did not exist)* | `3fb8f2af3001e081c2bdcabdd0631c0b2c3df5d4e9ad4fff1d8cc03a0662923b` |

---

## 5. Test coverage added by this delivery

- `tests/test_speaking_lab_direct_join.py` — 32 tests (atomic join,
  rollback on every failure stage, replay/idempotency, concurrency,
  legacy convergence, feature-flag gating, protected-function hashes).
- `tests/test_speaking_lab_wallet_payout.py` — 11 tests (successful
  payout, insufficient funds, retry, mock mode, manual review,
  concurrency, never-wired-into-server check, `_process_winner` hash).
- `tests/test_speaking_lab_wallet_migration.py` — 11 tests (dry-run
  reporting, confirm-phrase gating, zero-balance-only guarantee,
  idempotency, index report, never-wired-into-server check).
- `tests/test_speaking_lab_feature_flags_route.py` — 4 tests (AND-gate
  behavior for the new read-only status route).
- PWA (`eduhub-studio-test`): `JoinPrizePool.test.tsx` (6 tests),
  `speakingLabApi.test.ts` (3 tests).
- Teacher app (`speaking-lab-game (Live)`): `ScheduleSelector.test.jsx`
  (6 tests), `LiveRosterGate.test.jsx` (3 tests).

Full backend regression at the time of writing: **1594 passed, 0
failed** (`py -m pytest -q` from the `eduhub-backend` repo root).

---

## 6. Rollback

Every flag in this delivery is AND-gated (env var **and** DB field).
Removing or falsifying either one — in either order — instantly reverts
the corresponding behavior to what it was before this delivery, with no
data cleanup required:

- Direct Join off → `/direct-join` and `/my-entry` return 503;
  no mutation ever happened for sessions created while it was off.
- Combined A+B off → session creation with `schedule="AB"` 403s again;
  existing A/B-only sessions are entirely unaffected (they never used
  `"AB"`).
- Dark wallet payout — not wired into any route, so there is nothing to
  roll back; the flag being on or off currently has zero effect.
- Wallet cutover — same as above, reserved/unused.

No destructive migration was ever run, so there is no "undo a migration"
step required at any point in this plan.
