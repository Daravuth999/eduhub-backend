"""tests/test_video_library_coupon_percent_and_listing.py — §1's purchase-
time percent-coupon lookup/discount/finalize functions and §3's "list my
available coupons" endpoint (video_library_coupon_tools.py), plus §4's
notification-composer pure functions. Unit-level, direct-function tests —
the full purchase-integration path (restricted-first ordering + percent
discount + notification firing together) is covered separately in
tests/test_video_library_restricted_spend_ordering.py and
tests/test_video_library.py.
"""
from __future__ import annotations

from datetime import datetime, timedelta, timezone

import pytest

import video_library_coupon_tools as vlc


class _Coll:
    def __init__(self):
        self.docs: dict[str, dict] = {}

    async def find_one(self, query, projection=None):
        code = query.get("code")
        if code is not None:
            doc = self.docs.get(code)
            return dict(doc) if doc else None
        for d in self.docs.values():
            return dict(d)
        return None

    async def update_one(self, query, update):
        doc = self.docs.get(query.get("code"))
        if doc is None:
            return
        if "$push" in update:
            for k, v in update["$push"].items():
                doc.setdefault(k, []).append(v)
        if "$inc" in update:
            for k, v in update["$inc"].items():
                doc[k] = doc.get(k, 0) + v

    def find(self, query=None, projection=None):
        query = query or {}
        docs = [d for d in self.docs.values() if all(d.get(k) == v for k, v in query.items())]

        class _Cur:
            def __init__(self, docs):
                self._docs = docs

            def __aiter__(self):
                self._it = iter(self._docs)
                return self

            async def __anext__(self):
                try:
                    return dict(next(self._it))
                except StopIteration:
                    raise StopAsyncIteration

        return _Cur(docs)


class _DB:
    def __init__(self):
        self.coupons = _Coll()


def _seed(db, code, **overrides):
    doc = {
        "code": code, "type": "percent", "value": 25,
        "benefit_type": vlc.BENEFIT_TYPE, "benefit_amount": None,
        "max_uses": None, "uses_count": 0, "assigned_to": [], "book_slugs": [],
        "valid_from": None, "expires_at": None, "enabled": True, "redemptions": [],
    }
    doc.update(overrides)
    db.coupons.docs[code] = doc
    return doc


# ── find_valid_percent_coupon ────────────────────────────────────────────────
@pytest.mark.asyncio
async def test_find_valid_percent_coupon_happy_path():
    db = _DB()
    _seed(db, "SAVE25", value=25)
    doc, reason = await vlc.find_valid_percent_coupon(db, "SAVE25", "stu1")
    assert doc is not None and reason == ""


@pytest.mark.asyncio
async def test_find_valid_percent_coupon_rejects_a_points_type_coupon():
    db = _DB()
    _seed(db, "PTS20", type=None, value=None, benefit_amount=20)
    doc, reason = await vlc.find_valid_percent_coupon(db, "PTS20", "stu1")
    assert doc is None and reason == "wrong_redemption_flow"


@pytest.mark.asyncio
async def test_find_valid_percent_coupon_rejects_already_used_by_this_student():
    db = _DB()
    _seed(db, "ONCE", value=10, redemptions=[
        {"student_id": "stu1", "benefit_type": vlc.BENEFIT_TYPE, "code": "ONCE"},
    ])
    doc, reason = await vlc.find_valid_percent_coupon(db, "ONCE", "stu1")
    assert doc is None and reason == "already_used"
    # a DIFFERENT student can still use it
    doc2, reason2 = await vlc.find_valid_percent_coupon(db, "ONCE", "stu2")
    assert doc2 is not None and reason2 == ""


@pytest.mark.asyncio
async def test_find_valid_percent_coupon_rejects_expired():
    db = _DB()
    _seed(db, "OLD", value=10, expires_at=(datetime.now(timezone.utc) - timedelta(days=1)).isoformat())
    doc, reason = await vlc.find_valid_percent_coupon(db, "OLD", "stu1")
    assert doc is None and reason == "expired"


@pytest.mark.asyncio
async def test_find_valid_percent_coupon_rejects_invalid_percent_value():
    db = _DB()
    _seed(db, "BADVAL", value=0)
    doc, reason = await vlc.find_valid_percent_coupon(db, "BADVAL", "stu1")
    assert doc is None and reason == "invalid_benefit_amount"


@pytest.mark.asyncio
async def test_find_valid_percent_coupon_rejects_not_assigned():
    db = _DB()
    _seed(db, "ASSIGNED", value=10, assigned_to=["someone-else"])
    doc, reason = await vlc.find_valid_percent_coupon(db, "ASSIGNED", "stu1")
    assert doc is None and reason == "not_assigned"


# ── apply_percent_discount — identical formula to coupon_tools._calc_discount ─
def test_apply_percent_discount_matches_coupon_tools_formula():
    coupon = {"value": 25}
    assert vlc.apply_percent_discount(100, coupon) == 75
    assert vlc.apply_percent_discount(50, coupon) == 38  # round(50 * 0.75) == 38 (round-half-to-even)


def test_apply_percent_discount_100_percent_never_goes_negative():
    coupon = {"value": 100}
    assert vlc.apply_percent_discount(50, coupon) == 0


def test_apply_percent_discount_never_negative_even_for_a_bogus_over_100_value():
    coupon = {"value": 150}  # defense-in-depth — creation-time validation should have caught this
    assert vlc.apply_percent_discount(50, coupon) == 0


# ── finalize_percent_coupon_use ─────────────────────────────────────────────
@pytest.mark.asyncio
async def test_finalize_percent_coupon_use_records_redemption_and_increments_uses():
    db = _DB()
    _seed(db, "SAVE25", value=25)
    await vlc.finalize_percent_coupon_use(
        db, "SAVE25", "stu1", lesson_id="vid_1", original_price=100, discounted_price=75,
    )
    doc = db.coupons.docs["SAVE25"]
    assert doc["uses_count"] == 1
    assert doc["redemptions"][0] == {
        "student_id": "stu1", "benefit_type": vlc.BENEFIT_TYPE, "code": "SAVE25", "lesson_id": "vid_1",
        "original_price": 100, "discounted_price": 75,
        "redeemed_at": doc["redemptions"][0]["redeemed_at"],
    }


@pytest.mark.asyncio
async def test_finalize_percent_coupon_use_never_raises_on_a_db_error():
    class _BrokenColl(_Coll):
        async def update_one(self, query, update):
            raise RuntimeError("simulated db outage")

    db = _DB()
    db.coupons = _BrokenColl()
    # Must not raise — a failure here must never look like the PURCHASE
    # itself failed (it already succeeded by the time this is called).
    await vlc.finalize_percent_coupon_use(
        db, "SAVE25", "stu1", lesson_id="vid_1", original_price=100, discounted_price=75,
    )


# ── §3 list_available_coupons ───────────────────────────────────────────────
@pytest.mark.asyncio
async def test_list_available_coupons_includes_both_percent_and_points_types():
    db = _DB()
    _seed(db, "SAVE25", type="percent", value=25)
    _seed(db, "PTS20", type=None, value=None, benefit_amount=20)
    coupons = await vlc.list_available_coupons(db, "stu1")
    by_code = {c["code"]: c for c in coupons}
    assert by_code["SAVE25"] == {"code": "SAVE25", "type": "percent", "expiresAt": None, "percentOff": 25}
    assert by_code["PTS20"] == {"code": "PTS20", "type": "points", "expiresAt": None, "benefitAmount": 20}


@pytest.mark.asyncio
async def test_list_available_coupons_excludes_expired():
    db = _DB()
    _seed(db, "EXPIRED", value=10, expires_at=(datetime.now(timezone.utc) - timedelta(days=1)).isoformat())
    assert await vlc.list_available_coupons(db, "stu1") == []


@pytest.mark.asyncio
async def test_list_available_coupons_excludes_already_redeemed_points_coupon():
    db = _DB()
    _seed(db, "USEDPTS", type=None, value=None, benefit_amount=20, redemptions=[
        {"student_id": "stu1", "benefit_type": vlc.BENEFIT_TYPE, "status": "credited"},
    ])
    assert await vlc.list_available_coupons(db, "stu1") == []


@pytest.mark.asyncio
async def test_list_available_coupons_excludes_already_used_percent_coupon_for_this_student():
    db = _DB()
    _seed(db, "USEDPCT", type="percent", value=10, redemptions=[
        {"student_id": "stu1", "benefit_type": vlc.BENEFIT_TYPE, "code": "USEDPCT"},
    ])
    assert await vlc.list_available_coupons(db, "stu1") == []
    # still shows for a different student
    assert len(await vlc.list_available_coupons(db, "stu2")) == 1


@pytest.mark.asyncio
async def test_list_available_coupons_excludes_disabled_and_not_assigned():
    db = _DB()
    _seed(db, "DISABLED", value=10, enabled=False)
    _seed(db, "NOTMINE", value=10, assigned_to=["someone-else"])
    assert await vlc.list_available_coupons(db, "stu1") == []


@pytest.mark.asyncio
async def test_list_available_coupons_ignores_non_video_library_coupons():
    db = _DB()
    _seed(db, "BOOK10", benefit_type="book_discount", type="percent", value=10)
    _seed(db, "ETLC5", benefit_type="edutalk_points", type=None, value=None, benefit_amount=5)
    assert await vlc.list_available_coupons(db, "stu1") == []


# ── §4 notification content — real Khmer script, real established vocabulary ─
def test_redemption_notification_is_bilingual_and_uses_the_real_amount():
    title, body = vlc._compose_redemption_notification(20)
    assert "20" in title and "20" in body
    assert "ពិន្ទុ" in body  # established codebase vocabulary for "points"
    assert "Video Points Credited" in title
    assert "points" in body.lower()  # English half present too
