"""tests/test_public_books_guest_boundary.py
===============================================
Guest-only public book-content boundary — see guest_content_boundary.py.

This is NOT an entitlement system test. There is no ownership/purchase/
license/membership concept anywhere in this backend. The only behavior
under test is: an unauthenticated caller sees full chapter content for a
book with no price, and no chapter/content for a priced book, while an
authenticated student sees full content for every book regardless of
price, unchanged from before this boundary existed (their own purchase
flow, `isUnlocked()`, is untouched and lives elsewhere).

Gated on `price`, not `tier` — `tier` (free/standard/premium/limited) was
verified (ReaderPage.jsx) to be decorative-only (reading-mode visual
treatment), explicitly decoupled from pricing/entitlement in this
codebase. `price` is the real, already-established "does this book cost
points" field.

Deliberately does NOT import server.py — that module is a ~7800-line
FastAPI app with real Motor client construction and many other modules'
import-time side effects, and importing it directly inside a pytest run
collides with unrelated test files that build their own separate fakes for
those same modules (confirmed while writing this test — combining an
`import server` test with tests/test_edutalk_coach_rewards.py caused three
unrelated failures that do not occur when either file runs alone). The
guest boundary logic itself is a pure, dependency-free function living in
its own module specifically so it can be tested in full isolation, exactly
like this.

server.py's list_books()/get_book() route wiring (Depends(current_student),
_clean_book, this function) is verified separately by direct interpreter
import + signature inspection, and by manual network-response verification
during the browser smoke test.
"""
from __future__ import annotations

from guest_content_boundary import apply_guest_content_boundary


def _book(price, tier="premium"):
    """`tier` defaults to "premium" (not "free") specifically to prove the
    boundary does NOT key off tier — only `price` should matter."""
    return {
        "slug": "x",
        "title": "Title",
        "tier": tier,
        "price": price,
        "published": True,
        "chapters": [{"title": "Chapter 1", "blocks": [{"type": "paragraph", "text": "real content"}]}],
        "content": "legacy real content field",
    }


def test_guest_sees_full_content_for_zero_price_book():
    out = apply_guest_content_boundary(_book(price=0), is_guest=True)
    assert out["chapters"]
    assert out["content"] == "legacy real content field"


def test_guest_sees_full_content_for_missing_price():
    book = _book(price=0)
    del book["price"]
    out = apply_guest_content_boundary(book, is_guest=True)
    assert out["chapters"]


def test_guest_sees_stripped_content_for_priced_book():
    out = apply_guest_content_boundary(_book(price=200), is_guest=True)
    assert "chapters" not in out
    assert "content" not in out
    # Everything else (catalog metadata) is untouched.
    assert out["title"] == "Title"
    assert out["price"] == 200


def test_tier_badge_never_affects_the_boundary():
    """The core regression guard for the price-vs-tier correction: a
    tier="free"-badged but priced book must still be stripped for guests,
    and a tier="premium"-badged but zero-price book must still be shown in
    full — tier is purely decorative and must never gate content."""
    priced_but_free_badge = apply_guest_content_boundary(_book(price=150, tier="free"), is_guest=True)
    assert "chapters" not in priced_but_free_badge

    zero_price_but_premium_badge = apply_guest_content_boundary(_book(price=0, tier="premium"), is_guest=True)
    assert zero_price_but_premium_badge["chapters"]


def test_authenticated_caller_sees_full_content_regardless_of_price():
    """The regression guard: is_guest=False must behave identically to
    this function never existing, for every price."""
    for price in (0, 1, 200, 999):
        out = apply_guest_content_boundary(_book(price=price), is_guest=False)
        assert out["chapters"], price
        assert out["content"] == "legacy real content field", price


def test_does_not_mutate_the_input_book_dict():
    original = _book(price=200)
    snapshot = dict(original)
    apply_guest_content_boundary(original, is_guest=True)
    assert original == snapshot


def test_negative_or_malformed_price_treated_as_free():
    """Defensive: a malformed/negative price should never accidentally
    strip content it shouldn't (fail toward showing free content, never
    toward silently leaking a paid book — the -1 case would only matter if
    it were treated as "> 0", which it must not be)."""
    out = apply_guest_content_boundary(_book(price="not-a-number"), is_guest=True)
    assert out["chapters"]
    out2 = apply_guest_content_boundary(_book(price=-5), is_guest=True)
    assert out2["chapters"]
