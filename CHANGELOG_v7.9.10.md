# v7.9.10 — Library purchase ownership fix (Jan 2026)

## Bug
Students who purchased a paid book had real points debited from the
server, but:
  • the card kept showing the "X pts" price chip instead of "✓ Owned"
  • re-opening the book redirected back to /library

## Root cause
`isUnlocked()` in `src/eduhub/pages/library/books/purchaseService.js`
was hardened in v7.9.8 to consult ONLY the cross-device unlocks cache
(`eduhub_unlocks_cache_v1`). That cache is only populated by
`recordUnlock()` in `unlocksService.js`, which short-circuits when
`REACT_APP_UNLOCK_FORM_URL` / entry IDs aren't configured (the default
in `.env.example`). In every deployment without the optional Google
Form, every successful purchase therefore left no trace `isUnlocked()`
could find, so ownership UI never updated.

## Fix
Restore the local-ledger fallback for paid books, BUT only trust
ledger entries our own `purchaseBook()` wrote with `mode === "server"`
(stamp left after a confirmed server-side `sendPoints` debit).
Free-mode entries are still excluded as defense-in-depth, and the
cross-device cache + Portal `UnlockedBooks` column remain the
authoritative cross-device sources when configured.

Verified with 7 unit cases:
  ✓ free book                                → unlocked
  ✓ paid + no ownership                      → locked
  ✓ paid + server-mode ledger entry          → unlocked  ← THE FIX
  ✓ paid + free-mode ledger entry (forge)    → locked
  ✓ paid + cross-device cache                → unlocked
  ✓ paid + Portal `UnlockedBooks` column     → unlocked
  ✓ paid + ledger has unrelated slug         → locked

## Files changed
  • src/eduhub/pages/library/books/purchaseService.js
        — `isUnlocked()` body (~10 line change + doc-comment)
        — no change to call sites; signature unchanged
