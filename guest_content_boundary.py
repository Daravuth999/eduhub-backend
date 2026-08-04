"""guest_content_boundary.py — the guest-only public book-content boundary.

NOT an entitlement system. There is no book-ownership/purchase/license/
membership concept anywhere in this backend today. Scope is guest-only, on
purpose: this is deliberately the ONLY place unauthenticated visibility is
decided, kept in its own pure, dependency-free module so a future real
entitlement system (per-student grants) can replace the single `is_guest`
check below without touching `server.py`'s route bodies or anything else
that already works today.

Gated on `price`, not `tier`. Verified against the frontend reader
(ReaderPage.jsx): "tier" (free/standard/premium/limited) is explicitly
decorative-only — it drives reading-mode visual treatment (drop-caps,
paper grain, two-page spread) and is documented in that file as
"intentionally NOT affected" by pricing. The actual, established "does
this book cost points" gate — used today for the authenticated-student
purchase flow (`isUnlocked()` in LibraryPage.jsx/ReaderPage.jsx) — is
`price`. A guest sees full content for any book with no price (free to
everyone, regardless of its tier badge); a priced book requires the exact
same purchase an authenticated student would need, so a guest never sees
its content — same field, same meaning, no new concept invented.
"""
from __future__ import annotations


def apply_guest_content_boundary(book: dict, is_guest: bool) -> dict:
    if not is_guest:
        return book
    try:
        price = float(book.get("price") or 0)
    except (TypeError, ValueError):
        price = 0
    if price <= 0:
        return book
    stripped = dict(book)
    stripped.pop("chapters", None)
    stripped.pop("content", None)
    return stripped
