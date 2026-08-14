# Guest Content Boundary — Architecture Note

**Written:** as part of the "Read Before You Sign In" guest reading experience implementation.
**Why this note exists:** while implementing guest access to the Library/Reader, we discovered that `GET /api/books` and `GET /api/books/{slug}` (`eduhub-backend/server.py`) already returned full chapter content to *any* caller regardless of price, and that this backend has no book-ownership/purchase/license/membership/entitlement concept anywhere. Introducing a real guest content boundary therefore changed our understanding of the backend, and the user asked for this reasoning documented while it's fresh — specifically, why the boundary is deliberately **not** an entitlement system, and what would need to change if EduHub later introduces real paid ownership.

## Where the boundary lives

`eduhub-backend/guest_content_boundary.py` — one pure, dependency-free function:

```python
def apply_guest_content_boundary(book: dict, is_guest: bool) -> dict:
    ...
```

Called from exactly two places, both in `server.py`:

- `GET /api/books` (`list_books`)
- `GET /api/books/{slug}` (`get_book`)

Both routes now take `student: Student | None = Depends(current_student)` — the **existing** optional-auth dependency (already used elsewhere in this backend, e.g. the attendance join-link route), not a new auth mechanism. `is_guest = student is None`.

## What it checks, and why

The boundary keys on **`price`**, not `tier`. This was a real correction made during implementation: `tier` (`free`/`standard`/`premium`/`limited`) was verified against `ReaderPage.jsx` to be **decorative only** — it drives reading-mode visual treatment (drop-caps, paper grain, two-page spread) and is explicitly commented in that file as intentionally decoupled from pricing ("the previous `price > 0` coupling has been removed"). The actual, already-established "does this book cost points" gate — used today by the authenticated-student purchase flow (`isUnlocked()` in `LibraryPage.jsx` / `ReaderPage.jsx`) — is `price`. The guest boundary reuses that exact same field and meaning: a book with no price is free to everyone regardless of its tier badge; a priced book shows catalog metadata (title, cover, level, badge) but not `chapters`/`content` to an unauthenticated caller.

## Why this is NOT an entitlement system

Deliberately, on the user's explicit instruction:

- No ownership, purchase, license, membership, or access-grant collection was introduced.
- No new field was added to the book schema.
- No change to authenticated-student behavior: a logged-in student sees full content for every book at every price, exactly as before this boundary existed (the existing `isUnlocked()`/purchase-modal flow, unrelated to this boundary, is what governs whether *they* can read a priced book — untouched by this work).
- The boundary answers exactly one question — "is the caller authenticated at all?" — not "is this specific student entitled to this specific book?" Those are different problems, and conflating them would have meant designing a shortcut version of a real entitlement system instead of a genuine architectural boundary.

## What would need to change for real paid ownership / subscriptions

If EduHub later introduces genuine per-student entitlements (purchases, subscriptions, teacher-assigned access, etc.), the integration point is unchanged: `apply_guest_content_boundary`'s single `is_guest` check in `list_books`/`get_book` would be replaced by a real per-student grant lookup (e.g., `has_entitlement(student_id, book_slug)`), most likely as a new, separate module (an "entitlement" collection/service) called from the exact same two call sites. Nothing else in this boundary — its call sites, the `current_student` dependency, or the frontend's `ReaderPage.jsx`/`LibraryPage.jsx` consumption of the resulting content shape — would need to change; the guest-only concept and a future entitlement concept are independent by design, and this isolation is what makes that future migration additive rather than a rewrite.
