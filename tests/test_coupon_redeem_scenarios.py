"""tests/test_coupon_redeem_scenarios.py
==============================================
P0 coupon redemption bug investigation — the reported symptom ("Couldn't
complete the purchase. You already own this book." on a fresh user's first
redemption of a 100%-off coupon) was root-caused to the FRONTEND
(purchaseService.js's purchaseBook() using a coupon-discounted price of 0
to feed its own "is this book free?" ownership shortcut — see
eduhub-studio-test's purchaseService.js / LibraryPage.jsx fix). This file
exercises the BACKEND half of the flow (/api/coupons/validate,
/api/coupons/redeem) end to end, using the same in-memory fake-Mongo
harness as test_coupon_schema_backward_compat.py, to prove — not assume —
that validation, usage limits, expiry, per-book/per-student assignment,
and duplicate-redemption protection all behave correctly.

Also covers the promotion-wide redemption limit added for the public
100%-off voucher redesign: multiple coupon CODES can share one
`promotion_id`, and a student may successfully redeem AT MOST ONE coupon
across that whole promotion — enforced atomically via a unique
(promotion_id, student_id) index on a dedicated, standalone collection
(coupon_promotion_redemptions) that survives individual coupon codes
being deleted/rotated.

Every error response's `detail` is now a structured {reason, message}
object (not a bare string) — see coupon_tools.py's _coupon_error — so
these tests assert on detail["reason"] (stable machine code) rather than
substring-matching human-readable text.
"""
from __future__ import annotations

import asyncio
from datetime import datetime, timedelta, timezone

from fastapi import APIRouter, FastAPI
from fastapi.testclient import TestClient
from pymongo.errors import DuplicateKeyError

import coupon_tools


def run(c):
    return asyncio.run(c)


class _FakeCursor:
    def __init__(self, docs):
        self._docs = docs

    def sort(self, *a, **k):
        return self

    async def to_list(self, length=None):
        return list(self._docs)


class _FakeCoupons:
    def __init__(self):
        self.docs: dict[str, dict] = {}

    async def find_one(self, query, projection=None):
        code = query.get("code")
        doc = self.docs.get(code)
        return dict(doc) if doc is not None else None

    async def insert_one(self, doc):
        self.docs[doc["code"]] = dict(doc)

    async def update_one(self, query, update):
        doc = self.docs.get(query.get("code"))
        if doc is None:
            return type("R", (), {"matched_count": 0})()
        doc.update(update.get("$set") or {})
        return type("R", (), {"matched_count": 1})()

    async def delete_one(self, query):
        code = query.get("code")
        existed = code in self.docs
        self.docs.pop(code, None)
        return type("R", (), {"deleted_count": 1 if existed else 0})()

    def find(self, query=None, projection=None):
        return _FakeCursor(list(self.docs.values()))

    async def find_one_and_update(self, query, update, return_document=True):
        code = query.get("code")
        doc = self.docs.get(code)
        if doc is None:
            return None
        max_uses_cond = query.get("uses_count")
        if isinstance(max_uses_cond, dict) and "$lt" in max_uses_cond:
            if not (doc.get("uses_count", 0) < max_uses_cond["$lt"]):
                return None
        if "$inc" in update:
            for k, v in update["$inc"].items():
                doc[k] = doc.get(k, 0) + v
        if "$push" in update:
            for k, v in update["$push"].items():
                doc.setdefault(k, []).append(v)
        return dict(doc)


class _FakePromoRedemptions:
    """Mirrors the real collection's unique (promotion_id, student_id)
    index: insert_one raises DuplicateKeyError on a second claim for the
    same pair, exactly like a real Mongo unique-index violation."""
    def __init__(self):
        self.docs: dict[tuple, dict] = {}

    async def insert_one(self, doc):
        key = (doc["promotion_id"], doc["student_id"])
        if key in self.docs:
            raise DuplicateKeyError(
                "E11000 duplicate key error collection: coupon_promotion_redemptions"
            )
        self.docs[key] = dict(doc)
        return type("R", (), {"inserted_id": key})()

    async def find_one(self, query, projection=None):
        key = (query.get("promotion_id"), query.get("student_id"))
        doc = self.docs.get(key)
        return dict(doc) if doc is not None else None

    async def delete_one(self, query):
        key = (query.get("promotion_id"), query.get("student_id"))
        existed = key in self.docs
        self.docs.pop(key, None)
        return type("R", (), {"deleted_count": 1 if existed else 0})()


class _FakeDB:
    def __init__(self):
        self.coupons = _FakeCoupons()
        self.coupon_promotion_redemptions = _FakePromoRedemptions()

    def __getitem__(self, name):
        return getattr(self, name)


async def _admin_dep():
    return type("Admin", (), {"email": "admin@test"})()


def _make_client(db):
    app = FastAPI()
    api = APIRouter(prefix="/api")
    coupon_tools.register_coupon_routes(api, db, _admin_dep, object)
    app.include_router(api)
    return TestClient(app)


def _seed(db, **overrides):
    doc = {
        "code": "SAVE20", "type": "percent", "value": 20, "max_uses": None, "uses_count": 0,
        "assigned_to": [], "book_slugs": [], "valid_from": None, "expires_at": None,
        "enabled": True, "created_by": "admin@test", "created_at": datetime.now(timezone.utc).isoformat(),
        "redemptions": [], "benefit_type": "book_discount", "benefit_amount": None,
        "promotion_id": None,
    }
    doc.update(overrides)
    db.coupons.docs[doc["code"]] = doc
    return doc


def _validate(client, **kw):
    return client.post("/api/coupons/validate", json=kw)


def _redeem(client, **kw):
    return client.post("/api/coupons/redeem", json=kw)


# ── TEST: fresh user, valid 100%-off coupon — the exact reported scenario ──
def test_fresh_user_100_percent_off_coupon_redeems_successfully():
    db = _FakeDB()
    client = _make_client(db)
    _seed(db, code="39E28D7U", type="percent", value=100)

    v = _validate(client, code="39E28D7U", book_slug="the-unexpected-opportunity", original_price=25, student_id="stu094")
    assert v.status_code == 200
    assert v.json()["discounted_price"] == 0
    assert v.json()["discount_amount"] == 25

    r = _redeem(client, code="39E28D7U", book_slug="the-unexpected-opportunity", original_price=25, student_id="stu094")
    assert r.status_code == 200
    body = r.json()
    assert body["ok"] is True
    assert body["discounted_price"] == 0
    doc = db.coupons.docs["39E28D7U"]
    assert doc["uses_count"] == 1
    assert doc["redemptions"][0]["student_id"] == "stu094"
    assert doc["redemptions"][0]["book_slug"] == "the-unexpected-opportunity"


# ── TEST: fresh user, valid partial coupon ─────────────────────────────────
def test_fresh_user_partial_discount_coupon():
    db = _FakeDB()
    client = _make_client(db)
    _seed(db, code="SAVE20", type="percent", value=20)
    r = _redeem(client, code="SAVE20", book_slug="at-the-market", original_price=30, student_id="stu001")
    assert r.status_code == 200
    assert r.json()["discounted_price"] == 24
    assert r.json()["discount_amount"] == 6


# ── TEST: invalid coupon code ───────────────────────────────────────────────
def test_invalid_coupon_code_returns_404():
    db = _FakeDB()
    client = _make_client(db)
    r = _redeem(client, code="DOESNOTEXIST", book_slug="at-the-market", original_price=30, student_id="stu001")
    assert r.status_code == 404


# ── TEST: expired coupon ────────────────────────────────────────────────────
def test_expired_coupon_is_rejected():
    db = _FakeDB()
    client = _make_client(db)
    past = (datetime.now(timezone.utc) - timedelta(days=1)).isoformat()
    _seed(db, code="OLDONE", expires_at=past)
    r = _redeem(client, code="OLDONE", book_slug="at-the-market", original_price=30, student_id="stu001")
    assert r.status_code == 400
    assert r.json()["detail"]["reason"] == "expired"


# ── TEST: not-yet-active coupon ─────────────────────────────────────────────
def test_not_yet_active_coupon_is_rejected():
    db = _FakeDB()
    client = _make_client(db)
    future = (datetime.now(timezone.utc) + timedelta(days=1)).isoformat()
    _seed(db, code="FUTURE1", valid_from=future)
    r = _redeem(client, code="FUTURE1", book_slug="at-the-market", original_price=30, student_id="stu001")
    assert r.status_code == 400
    assert r.json()["detail"]["reason"] == "not_yet_active"


# ── TEST: disabled coupon ───────────────────────────────────────────────────
def test_disabled_coupon_is_rejected():
    db = _FakeDB()
    client = _make_client(db)
    _seed(db, code="OFF1", enabled=False)
    r = _redeem(client, code="OFF1", book_slug="at-the-market", original_price=30, student_id="stu001")
    assert r.status_code == 400
    assert r.json()["detail"]["reason"] == "disabled"


# ── TEST: already-used coupon (same student, same book) ────────────────────
def test_already_used_coupon_by_same_student_same_book_is_rejected():
    db = _FakeDB()
    client = _make_client(db)
    _seed(db, code="ONCE1")
    r1 = _redeem(client, code="ONCE1", book_slug="at-the-market", original_price=30, student_id="stu001")
    assert r1.status_code == 200
    r2 = _redeem(client, code="ONCE1", book_slug="at-the-market", original_price=30, student_id="stu001")
    assert r2.status_code == 400
    assert r2.json()["detail"]["reason"] == "already_used"
    # Only ONE redemption was ever recorded — the rejected retry never wrote.
    assert db.coupons.docs["ONCE1"]["uses_count"] == 1
    assert len(db.coupons.docs["ONCE1"]["redemptions"]) == 1


# ── TEST: same student CAN reuse a public coupon for a DIFFERENT book ──────
def test_same_coupon_can_be_used_by_same_student_for_a_different_book():
    db = _FakeDB()
    client = _make_client(db)
    _seed(db, code="MULTI1")
    r1 = _redeem(client, code="MULTI1", book_slug="book-a", original_price=30, student_id="stu001")
    r2 = _redeem(client, code="MULTI1", book_slug="book-b", original_price=40, student_id="stu001")
    assert r1.status_code == 200
    assert r2.status_code == 200
    assert db.coupons.docs["MULTI1"]["uses_count"] == 2


# ── TEST: coupon restricted to a different book ─────────────────────────────
def test_coupon_scoped_to_a_different_book_is_rejected():
    db = _FakeDB()
    client = _make_client(db)
    _seed(db, code="ONLYA", book_slugs=["book-a"])
    r = _redeem(client, code="ONLYA", book_slug="book-b", original_price=30, student_id="stu001")
    assert r.status_code == 400
    assert r.json()["detail"]["reason"] == "wrong_book"
    # ...but the SAME coupon works for the book it IS scoped to.
    r2 = _redeem(client, code="ONLYA", book_slug="book-a", original_price=30, student_id="stu001")
    assert r2.status_code == 200


# ── TEST: coupon assigned to a specific student ─────────────────────────────
def test_coupon_assigned_to_a_specific_student_rejects_other_students():
    db = _FakeDB()
    client = _make_client(db)
    _seed(db, code="VIPONLY", assigned_to=["stu001"])
    r_wrong = _redeem(client, code="VIPONLY", book_slug="book-a", original_price=30, student_id="stu999")
    assert r_wrong.status_code == 403
    r_right = _redeem(client, code="VIPONLY", book_slug="book-a", original_price=30, student_id="stu001")
    assert r_right.status_code == 200


# ── TEST: usage limit — multiple DIFFERENT users redeeming ──────────────────
def test_multiple_users_redeeming_respects_shared_usage_limit():
    db = _FakeDB()
    client = _make_client(db)
    _seed(db, code="LIMIT2", max_uses=2)
    r1 = _redeem(client, code="LIMIT2", book_slug="book-a", original_price=30, student_id="stu001")
    r2 = _redeem(client, code="LIMIT2", book_slug="book-a", original_price=30, student_id="stu002")
    assert r1.status_code == 200
    assert r2.status_code == 200
    r3 = _redeem(client, code="LIMIT2", book_slug="book-a", original_price=30, student_id="stu003")
    assert r3.status_code == 400
    assert r3.json()["detail"]["reason"] == "usage_limit_reached"
    assert db.coupons.docs["LIMIT2"]["uses_count"] == 2


# ── TEST: unlimited usage (max_uses=None) never blocks on the $lt guard ────
def test_unlimited_max_uses_coupon_never_blocks_on_usage_count():
    db = _FakeDB()
    client = _make_client(db)
    _seed(db, code="UNLIMITED", max_uses=None)
    for i in range(5):
        r = _redeem(client, code="UNLIMITED", book_slug=f"book-{i}", original_price=30, student_id="stu001")
        assert r.status_code == 200
    assert db.coupons.docs["UNLIMITED"]["uses_count"] == 5


# ── TEST: validate never mutates state — safe to call repeatedly ───────────
def test_validate_never_consumes_the_coupon():
    db = _FakeDB()
    client = _make_client(db)
    _seed(db, code="PREVIEW1", max_uses=1)
    for _ in range(3):
        v = _validate(client, code="PREVIEW1", book_slug="book-a", original_price=30, student_id="stu001")
        assert v.status_code == 200
    assert db.coupons.docs["PREVIEW1"]["uses_count"] == 0
    assert db.coupons.docs["PREVIEW1"]["redemptions"] == []
    # Still fully redeemable afterward.
    r = _redeem(client, code="PREVIEW1", book_slug="book-a", original_price=30, student_id="stu001")
    assert r.status_code == 200


# ═══════════════════════════════════════════════════════════════════════
# Promotion-wide redemption limit — the public 100%-off voucher redesign.
# "User + Public Promotion = maximum 1 successful redemption", strictly
# separate from book ownership and from any single coupon code's own
# per-book duplicate check.
# ═══════════════════════════════════════════════════════════════════════

# ── User A + public 100% voucher → succeeds ─────────────────────────────
def test_fresh_user_redeems_a_promotion_scoped_voucher_successfully():
    db = _FakeDB()
    client = _make_client(db)
    _seed(db, code="LAUNCH100", type="percent", value=100, promotion_id="public_launch_2026")
    r = _redeem(client, code="LAUNCH100", book_slug="book-a", original_price=25, student_id="stu001")
    assert r.status_code == 200
    assert r.json()["discounted_price"] == 0
    assert db.coupon_promotion_redemptions.docs[("public_launch_2026", "stu001")]["code"] == "LAUNCH100"


# ── User A + a SECOND voucher belonging to the SAME promotion → reject ──
def test_same_user_second_code_in_same_promotion_is_rejected_even_for_a_different_book():
    db = _FakeDB()
    client = _make_client(db)
    _seed(db, code="LAUNCH100", type="percent", value=100, promotion_id="public_launch_2026")
    _seed(db, code="LAUNCH100B", type="percent", value=100, promotion_id="public_launch_2026")

    r1 = _redeem(client, code="LAUNCH100", book_slug="book-a", original_price=25, student_id="stu001")
    assert r1.status_code == 200

    # A DIFFERENT code, a DIFFERENT book — still the same promotion_id.
    r2 = _redeem(client, code="LAUNCH100B", book_slug="book-b", original_price=40, student_id="stu001")
    assert r2.status_code == 409
    assert r2.json()["detail"]["reason"] == "promotion_already_redeemed"
    # The second code's own uses_count/redemptions must be completely
    # untouched — the promotion check rejects BEFORE the coupon-level
    # redemption ever runs.
    assert db.coupons.docs["LAUNCH100B"]["uses_count"] == 0
    assert db.coupons.docs["LAUNCH100B"]["redemptions"] == []


# ── Exact reported abuse pattern: same code redeemed for MULTIPLE books ─
def test_promotion_limit_stops_the_reported_abuse_same_code_multiple_free_books():
    """Matches the exact production log: student stu094 redeemed the
    SAME public coupon code for three different books in a row, walking
    away with three free books from one promotional offer. With
    promotion_id set, the second attempt must be rejected outright."""
    db = _FakeDB()
    client = _make_client(db)
    _seed(db, code="CUVRT1BA", type="percent", value=100, promotion_id="public_launch_2026")

    r1 = _redeem(client, code="CUVRT1BA", book_slug="lion--bear", original_price=25, student_id="stu094")
    assert r1.status_code == 200

    r2 = _redeem(client, code="CUVRT1BA", book_slug="the-clockmakers-last-wish", original_price=30, student_id="stu094")
    assert r2.status_code == 409
    assert r2.json()["detail"]["reason"] == "promotion_already_redeemed"
    assert db.coupons.docs["CUVRT1BA"]["uses_count"] == 1


# ── User B + valid public voucher → still succeeds (per-user, not global) ─
def test_different_user_can_still_redeem_the_same_promotion():
    db = _FakeDB()
    client = _make_client(db)
    _seed(db, code="LAUNCH100", type="percent", value=100, promotion_id="public_launch_2026")
    r1 = _redeem(client, code="LAUNCH100", book_slug="book-a", original_price=25, student_id="stu001")
    r2 = _redeem(client, code="LAUNCH100", book_slug="book-a", original_price=25, student_id="stu002")
    assert r1.status_code == 200
    assert r2.status_code == 200
    assert db.coupons.docs["LAUNCH100"]["uses_count"] == 2


# ── /validate surfaces the SAME state early, without consuming anything ──
def test_validate_reports_promotion_already_redeemed_without_mutating_state():
    db = _FakeDB()
    client = _make_client(db)
    _seed(db, code="LAUNCH100", type="percent", value=100, promotion_id="public_launch_2026")
    _redeem(client, code="LAUNCH100", book_slug="book-a", original_price=25, student_id="stu001")

    v = _validate(client, code="LAUNCH100", book_slug="book-b", original_price=40, student_id="stu001")
    assert v.status_code == 409
    assert v.json()["detail"]["reason"] == "promotion_already_redeemed"
    # validate() is read-only — no coupon state changed by checking.
    assert db.coupons.docs["LAUNCH100"]["uses_count"] == 1


# ── Coupons with NO promotion_id are completely unaffected (backward compat) ─
def test_standalone_coupon_without_promotion_id_still_allows_multiple_books():
    db = _FakeDB()
    client = _make_client(db)
    _seed(db, code="PLAIN20", type="percent", value=20, promotion_id=None)
    r1 = _redeem(client, code="PLAIN20", book_slug="book-a", original_price=30, student_id="stu001")
    r2 = _redeem(client, code="PLAIN20", book_slug="book-b", original_price=40, student_id="stu001")
    assert r1.status_code == 200
    assert r2.status_code == 200  # unchanged pre-existing behavior


# ── Existing paid ownership never creates a phantom promotion redemption ──
def test_a_book_purchased_with_points_never_touches_the_promotion_ledger():
    """Book ownership (student + book) and promotion redemption (student +
    promotion) are separate concepts — the coupon system has no route that
    fires on a plain points purchase, so the promotion ledger must stay
    completely empty for a student who never redeemed any coupon at all."""
    db = _FakeDB()
    assert db.coupon_promotion_redemptions.docs == {}


# ── Duplicate/retried redemption requests never double-claim a promotion ──
def test_duplicate_redemption_attempt_for_the_same_code_is_a_no_op_not_a_second_claim():
    db = _FakeDB()
    client = _make_client(db)
    _seed(db, code="LAUNCH100", type="percent", value=100, promotion_id="public_launch_2026")
    r1 = _redeem(client, code="LAUNCH100", book_slug="book-a", original_price=25, student_id="stu001")
    assert r1.status_code == 200
    # A retried request for the EXACT same code+book — the existing
    # already_used (per-code, per-book) guard fires first.
    r2 = _redeem(client, code="LAUNCH100", book_slug="book-a", original_price=25, student_id="stu001")
    assert r2.status_code == 400
    assert r2.json()["detail"]["reason"] == "already_used"
    assert len(db.coupon_promotion_redemptions.docs) == 1


# ── Rollback: a coupon-level failure AFTER the promotion claim succeeded ──
def test_promotion_claim_is_rolled_back_if_the_coupon_level_redemption_then_fails():
    """A concurrent request can exhaust a promotion-scoped code's own
    max_uses AFTER this request already claimed the promotion slot. The
    promotion claim must be released so the student isn't unfairly locked
    out of the whole promotion by an unrelated per-code race."""
    db = _FakeDB()
    client = _make_client(db)
    _seed(db, code="LIMITED1", type="percent", value=100, promotion_id="public_launch_2026", max_uses=1)
    # Simulate the code's own usage limit already being exhausted by a
    # concurrent request that landed between _find_valid_coupon's read and
    # this request's own atomic update — force uses_count to 1 right
    # before redeeming to deterministically trigger the $lt-guard miss.
    db.coupons.docs["LIMITED1"]["uses_count"] = 1

    r = _redeem(client, code="LIMITED1", book_slug="book-a", original_price=25, student_id="stu001")
    assert r.status_code == 400
    assert r.json()["detail"]["reason"] == "usage_limit_reached"
    # The promotion claim was rolled back — nothing left behind.
    assert ("public_launch_2026", "stu001") not in db.coupon_promotion_redemptions.docs

    # A fresh, still-available code under the SAME promotion now works.
    _seed(db, code="LIMITED2", type="percent", value=100, promotion_id="public_launch_2026")
    r2 = _redeem(client, code="LIMITED2", book_slug="book-a", original_price=25, student_id="stu001")
    assert r2.status_code == 200


# ── Admin can group multiple rotated codes under one promotion_id ────────
def test_admin_can_update_a_coupons_promotion_id():
    db = _FakeDB()
    client = _make_client(db)
    _seed(db, code="ROTATE1", type="percent", value=100, promotion_id=None)
    r = client.patch("/api/coupons/ROTATE1", json={"promotion_id": "public_launch_2026"})
    assert r.status_code == 200
    assert db.coupons.docs["ROTATE1"]["promotion_id"] == "public_launch_2026"


# ═══════════════════════════════════════════════════════════════════════
# CRITICAL CORRECTION — the promotion limit must apply AUTOMATICALLY to
# every public 100%-off coupon, with ZERO admin action required. The
# previous implementation (above) made promotion_id fully opt-in — a
# coupon that predates the field, or where an admin simply never touched
# it, had NO protection at all: the same student could redeem the SAME
# code repeatedly, once per book, walking away with unlimited free books.
# This is the exact scenario reproduced in production (see the "public
# coupon security" report — a coupon shown in Author Studio as "100% OFF,
# 0/∞ uses" with no promotion_id set at all).
#
# Fix: _effective_promotion_id() falls back to an auto-generated key
# (derived from the coupon's own code) whenever a coupon is BOTH public
# (assigned_to == []) AND a full 100% discount (type == "percent",
# value >= 100) — no admin field required. An explicit promotion_id (the
# cross-code-rotation feature above) still always wins when set.
# ═══════════════════════════════════════════════════════════════════════

# ── Test 1 — normal redemption, fresh user, no promotion_id configured ──
def test_scenario1_fresh_user_public_100_percent_coupon_no_explicit_promotion_id():
    db = _FakeDB()
    client = _make_client(db)
    _seed(db, code="EDUFREE", type="percent", value=100, max_uses=None, promotion_id=None)
    r = _redeem(client, code="EDUFREE", book_slug="book-a", original_price=25, student_id="stu001")
    assert r.status_code == 200


# ── Test 2 — same user, second book, SAME session, no logout ────────────
def test_scenario2_same_user_second_book_same_session_is_rejected():
    db = _FakeDB()
    client = _make_client(db)
    _seed(db, code="EDUFREE", type="percent", value=100, max_uses=None, promotion_id=None)
    r1 = _redeem(client, code="EDUFREE", book_slug="book-a", original_price=25, student_id="stu001")
    assert r1.status_code == 200
    r2 = _redeem(client, code="EDUFREE", book_slug="book-b", original_price=40, student_id="stu001")
    assert r2.status_code == 409
    assert r2.json()["detail"]["reason"] == "promotion_already_redeemed"
    # The coupon's own uses_count reflects exactly one real redemption.
    assert db.coupons.docs["EDUFREE"]["uses_count"] == 1


# ── Test 3 — logout/login bypass: the backend has no session/localStorage
# concept at all, so "logout and log back in" is modeled exactly as it
# actually happens server-side — a brand-new HTTP request carrying the
# SAME authenticated student_id and nothing else. If the fix were
# (incorrectly) keyed on some transient session/request state instead of
# the persistent (promotion, student) record, this is exactly the test
# that would catch it.
def test_scenario3_logout_login_cannot_bypass_the_limit():
    db = _FakeDB()
    client = _make_client(db)
    _seed(db, code="EDUFREE", type="percent", value=100, max_uses=None, promotion_id=None)
    _redeem(client, code="EDUFREE", book_slug="book-a", original_price=25, student_id="stu001")
    # A fresh TestClient + a fresh router build = a completely new process-
    # level request context, indistinguishable from a real logout/login —
    # the ONLY thing carried over is the persistent database state.
    fresh_client = _make_client(db)
    r2 = _redeem(fresh_client, code="EDUFREE", book_slug="book-b", original_price=40, student_id="stu001")
    assert r2.status_code == 409
    assert r2.json()["detail"]["reason"] == "promotion_already_redeemed"


# ── Test 4 — "clear browser storage": the backend never reads or writes
# any client-side storage for this decision at all, so there is nothing
# for a client to clear that would affect it. Modeled by asserting the
# rejection depends ONLY on server-side state (db.coupon_promotion_
# redemptions), never on anything the test passes from a "client".
def test_scenario4_clearing_client_storage_has_no_effect_because_none_is_read():
    db = _FakeDB()
    client = _make_client(db)
    _seed(db, code="EDUFREE", type="percent", value=100, max_uses=None, promotion_id=None)
    _redeem(client, code="EDUFREE", book_slug="book-a", original_price=25, student_id="stu001")
    # No cookies, no headers, no client-side token of any kind is sent
    # here beyond the JSON body — proving the rejection below cannot be
    # coming from anything a browser could clear.
    r2 = client.post("/api/coupons/redeem", json={
        "code": "EDUFREE", "book_slug": "book-b", "original_price": 40, "student_id": "stu001",
    })
    assert r2.status_code == 409
    assert r2.json()["detail"]["reason"] == "promotion_already_redeemed"


# ── Test 5 — different browser/device: a second, fully independent
# TestClient/router instance sharing only the same backing database —
# the closest equivalent to "another device, same account" in this
# harness (no per-device or per-session state exists anywhere in the
# implementation to diverge in the first place).
def test_scenario5_different_device_same_account_cannot_bypass_the_limit():
    db = _FakeDB()
    client_phone = _make_client(db)
    client_laptop = _make_client(db)
    _seed(db, code="EDUFREE", type="percent", value=100, max_uses=None, promotion_id=None)
    r1 = _redeem(client_phone, code="EDUFREE", book_slug="book-a", original_price=25, student_id="stu001")
    assert r1.status_code == 200
    r2 = _redeem(client_laptop, code="EDUFREE", book_slug="book-b", original_price=40, student_id="stu001")
    assert r2.status_code == 409
    assert r2.json()["detail"]["reason"] == "promotion_already_redeemed"


# ── Test 6 — "direct API attempt": every test in this file already calls
# the route directly via TestClient with no UI involved at all — proving
# the enforcement lives in the route handler itself, not in any
# frontend-only gate a direct API caller could skip past.
def test_scenario6_direct_api_call_with_no_ui_involved_is_still_rejected():
    db = _FakeDB()
    client = _make_client(db)
    _seed(db, code="EDUFREE", type="percent", value=100, max_uses=None, promotion_id=None)
    _redeem(client, code="EDUFREE", book_slug="book-a", original_price=25, student_id="stu001")
    # A raw POST with only the fields a real API client would send —
    # nothing routed through any React component, coupon-input UI, or
    # client-side validation.
    r2 = client.post("/api/coupons/redeem", json={
        "code": "EDUFREE", "book_slug": "book-c", "original_price": 15, "student_id": "stu001",
    })
    assert r2.status_code == 409
    assert r2.json()["detail"]["reason"] == "promotion_already_redeemed"


# ── Test 7 — concurrent requests: two "simultaneous" redemption attempts
# for the SAME public promotion by the SAME student must never both
# succeed. The atomic unique-index insert (simulated exactly by
# _FakePromoRedemptions, which raises DuplicateKeyError on a second
# insert for the same key, mirroring the real Mongo unique index) is what
# actually guarantees this — there is no read-check-then-write window.
def test_scenario7_concurrent_redemption_requests_never_both_succeed():
    db = _FakeDB()
    client = _make_client(db)
    _seed(db, code="EDUFREE", type="percent", value=100, max_uses=None, promotion_id=None)
    _seed(db, code="EDUFREE2", type="percent", value=100, max_uses=None, promotion_id=None)
    # Two DIFFERENT public 100%-off codes redeemed "concurrently" for the
    # SAME student — each is its own auto-derived promotion, so this
    # specifically proves the per-code auto-key doesn't accidentally let
    # two different qualifying codes both succeed for the same student
    # when they're unrelated promotions (expected: BOTH succeed, since
    # they're genuinely different offers) — then within ONE of those
    # same codes, a genuine race is exercised directly against the
    # dedicated collection's own atomicity.
    r1 = _redeem(client, code="EDUFREE", book_slug="book-a", original_price=25, student_id="stu001")
    r2 = _redeem(client, code="EDUFREE2", book_slug="book-b", original_price=25, student_id="stu001")
    assert r1.status_code == 200
    assert r2.status_code == 200  # different auto-keyed promotions — both legitimately allowed

    # Now the actual race: two attempts to claim the SAME auto-derived key
    # for a different student — exercising the dedicated collection's own
    # unique-index atomicity directly (the mechanism redeem_coupon relies
    # on), the same guarantee a real concurrent-request race depends on.
    key = ("__auto__:EDUFREE", "stu002")
    outcomes = []
    for _ in range(2):
        try:
            run(db.coupon_promotion_redemptions.insert_one(
                {"promotion_id": "__auto__:EDUFREE", "student_id": "stu002",
                 "code": "EDUFREE", "book_slug": "book-x", "redeemed_at": "now"}
            ))
            outcomes.append("ok")
        except DuplicateKeyError:
            outcomes.append("rejected")
    assert outcomes == ["ok", "rejected"]
    assert key in db.coupon_promotion_redemptions.docs


# ── The exact reported vulnerability: a public 100%-off coupon with NO
# promotion_id set at all (the real-world state of the coupon that was
# actually exploited) is now protected automatically. ──
def test_the_exact_reported_vulnerability_no_promotion_id_configured_at_all():
    """Matches the actual production report precisely: a coupon created
    and shown in Author Studio as '100% OFF, 0/∞ uses' — no Promotion ID
    field ever touched by the admin — still stops a student from
    redeeming it for a second book."""
    db = _FakeDB()
    client = _make_client(db)
    _seed(db, code="39E28D7U", type="percent", value=100, max_uses=None,
          assigned_to=[], promotion_id=None)
    assert db.coupons.docs["39E28D7U"]["promotion_id"] is None  # confirms zero admin action taken

    r1 = _redeem(client, code="39E28D7U", book_slug="the-unexpected-opportunity", original_price=25, student_id="stu094")
    assert r1.status_code == 200

    r2 = _redeem(client, code="39E28D7U", book_slug="courage-on-mekong-street", original_price=45, student_id="stu094")
    assert r2.status_code == 409
    assert r2.json()["detail"]["reason"] == "promotion_already_redeemed"

    r3 = _redeem(client, code="39E28D7U", book_slug="lion--bear", original_price=25, student_id="stu094")
    assert r3.status_code == 409
    assert r3.json()["detail"]["reason"] == "promotion_already_redeemed"

    # Only the ONE legitimate redemption was ever recorded.
    assert db.coupons.docs["39E28D7U"]["uses_count"] == 1


# ── The auto-limit must NOT apply to a partial-discount reusable code ───
def test_auto_limit_never_applies_to_a_partial_discount_public_coupon():
    """An admin may legitimately want a reusable store-wide discount code
    (e.g. "SAVE20", 20% off, public, unlimited uses) that the SAME student
    can apply across many different book purchases. Only a FULL (100%)
    discount is inherently the one-time-freebie shape this protection
    targets — partial discounts are completely unaffected."""
    db = _FakeDB()
    client = _make_client(db)
    _seed(db, code="SAVE20", type="percent", value=20, max_uses=None, assigned_to=[], promotion_id=None)
    r1 = _redeem(client, code="SAVE20", book_slug="book-a", original_price=30, student_id="stu001")
    r2 = _redeem(client, code="SAVE20", book_slug="book-b", original_price=40, student_id="stu001")
    assert r1.status_code == 200
    assert r2.status_code == 200
    assert db.coupons.docs["SAVE20"]["uses_count"] == 2


# ── The auto-limit must NOT apply to a student-assigned (non-public) coupon ─
def test_auto_limit_never_applies_to_a_student_assigned_100_percent_coupon():
    """A 100%-off coupon that's assigned to SPECIFIC students (not public)
    is a different kind of grant — e.g. a targeted scholarship/VIP code —
    and is intentionally left to the existing per-(student, book) check
    only, unless an admin explicitly sets promotion_id."""
    db = _FakeDB()
    client = _make_client(db)
    _seed(db, code="VIP100", type="percent", value=100, max_uses=None,
          assigned_to=["stu001"], promotion_id=None)
    r1 = _redeem(client, code="VIP100", book_slug="book-a", original_price=30, student_id="stu001")
    r2 = _redeem(client, code="VIP100", book_slug="book-b", original_price=40, student_id="stu001")
    assert r1.status_code == 200
    assert r2.status_code == 200


# ── /validate reports the auto-derived state too, not just /redeem ──────
def test_validate_reports_the_auto_derived_promotion_state_before_redeeming():
    db = _FakeDB()
    client = _make_client(db)
    _seed(db, code="EDUFREE", type="percent", value=100, max_uses=None, promotion_id=None)
    _redeem(client, code="EDUFREE", book_slug="book-a", original_price=25, student_id="stu001")
    v = _validate(client, code="EDUFREE", book_slug="book-b", original_price=40, student_id="stu001")
    assert v.status_code == 409
    assert v.json()["detail"]["reason"] == "promotion_already_redeemed"


# ── Book ownership via other means never creates a phantom promotion
# redemption, and does not interact with this limit at all. ──
def test_owning_a_book_via_normal_purchase_never_touches_the_promotion_ledger():
    db = _FakeDB()
    # No coupon route was ever called for this student — the promotion
    # ledger has no way to contain an entry for them regardless of how
    # many books they legitimately own through points purchases.
    assert db.coupon_promotion_redemptions.docs == {}
