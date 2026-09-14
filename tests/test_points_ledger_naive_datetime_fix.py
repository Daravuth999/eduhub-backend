"""tests/test_points_ledger_naive_datetime_fix.py
======================================================
Same root-cause bug as notification_center.py's Activity Center (see
test_notification_center_naive_datetime_fix.py's module docstring for
the full mechanism): this app's Motor client has no `tz_aware=True`, so
a `created_at` value read back from a real points_transactions document
is a NAIVE datetime, even though it was written as a proper UTC
instant. `_coerce_iso()` used to call `.isoformat()` on that naive
value with no tzinfo check at all, omitting the timezone suffix — and
the frontend's `ledgerRelativeTime()` (transactionsApi.ts) parses it as
LOCAL browser time, silently adding the viewer's own UTC offset (7h for
Cambodia) on top of the real elapsed time. A points credit that just
happened would show as "7h ago" on the student's Points Activity feed
and Latest Reward card the moment they re-fetched over REST.
"""
from __future__ import annotations

from datetime import datetime, timedelta, timezone

import points_ledger_api as pla


def test_a_naive_datetime_gets_utc_offset_attached_not_omitted():
    naive_utc = datetime(2026, 9, 14, 4, 30, 0)
    assert pla._coerce_iso(naive_utc) == "2026-09-14T04:30:00+00:00"


def test_regression_a_points_credit_from_seconds_ago_is_never_misread_as_hours_old():
    true_utc_now = datetime.now(timezone.utc)
    naive_as_read_from_mongo = true_utc_now.replace(tzinfo=None)
    serialized = pla._coerce_iso(naive_as_read_from_mongo)
    reparsed = datetime.fromisoformat(serialized)
    assert reparsed.tzinfo is not None, "must carry an explicit UTC offset, never ambiguous"
    gap = abs((true_utc_now - reparsed).total_seconds())
    assert gap < 1, f"expected ~0s gap, got {gap}s (this magnitude of drift is the Cambodia UTC+7 bug)"


def test_an_already_aware_datetime_is_preserved_not_double_shifted():
    aware = datetime(2026, 9, 14, 4, 30, 0, tzinfo=timezone.utc)
    assert pla._coerce_iso(aware) == aware.isoformat()


def test_a_string_value_passes_through_unchanged():
    assert pla._coerce_iso("2026-09-14T04:30:00+00:00") == "2026-09-14T04:30:00+00:00"


def test_none_returns_none_not_a_crash():
    assert pla._coerce_iso(None) is None
