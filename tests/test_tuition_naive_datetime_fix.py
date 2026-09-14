"""tests/test_tuition_naive_datetime_fix.py
================================================
Same root-cause bug as notification_center.py's Activity Center and
messaging_tools.py's message timestamps (see
test_notification_center_naive_datetime_fix.py's module docstring for
the full mechanism), but with a more severe symptom here: this app's
Motor client has no `tz_aware=True`, so `expires_at`/`created_at`/
`finalized_at` read back from a real tuition-intent document are NAIVE
datetimes even though they were written as proper UTC instants. A bare
`.isoformat()` on that naive value used to omit the timezone suffix —
and TuitionPaymentModal.jsx computes its live QR-payment countdown as
`new Date(intent.expires_at) - Date.now()`. A suffix-less string is
parsed as LOCAL browser time, so for a Cambodia (UTC+7) student the
countdown target landed ~7 hours in the past on every resume/poll,
clamping the diff to 0 and kicking the student out of an in-progress
payment that had NOT actually expired.

Fixed by `_ttn_iso()`: a naive datetime read from these collections is
ALWAYS a real UTC instant (a fact, not a guess, given how it's
written), so it's explicitly tagged `tzinfo=timezone.utc` before
`.isoformat()`.
"""
from __future__ import annotations

from datetime import datetime, timedelta, timezone

import tuition_tools as tt


def test_a_naive_datetime_gets_utc_offset_attached_not_omitted():
    naive_utc = datetime(2026, 9, 14, 4, 30, 0)
    assert tt._ttn_iso(naive_utc) == "2026-09-14T04:30:00+00:00"


def test_regression_a_payment_countdown_target_is_never_computed_as_already_passed():
    """The exact reported failure mode: an expires_at that is genuinely
    still in the future must never round-trip to something a Cambodia
    browser would read as already expired."""
    real_expiry = datetime.now(timezone.utc) + timedelta(minutes=5)
    naive_as_read_from_mongo = real_expiry.replace(tzinfo=None)
    serialized = tt._ttn_iso(naive_as_read_from_mongo)
    reparsed = datetime.fromisoformat(serialized)
    assert reparsed.tzinfo is not None, "must carry an explicit UTC offset, never ambiguous"
    # The reparsed instant must still be ~5 minutes in the future, not
    # ~6h55m in the past (which is what the Cambodia UTC+7 bug produced).
    seconds_until_expiry = (reparsed - datetime.now(timezone.utc)).total_seconds()
    assert seconds_until_expiry > 250, (
        f"expected ~300s remaining, got {seconds_until_expiry}s — "
        "a still-valid payment window must never appear already expired"
    )


def test_an_already_aware_datetime_is_preserved_not_double_shifted():
    aware = datetime(2026, 9, 14, 4, 30, 0, tzinfo=timezone.utc)
    assert tt._ttn_iso(aware) == aware.isoformat()


def test_a_non_datetime_value_passes_through_unchanged():
    """`_ttn_iso` is called on values that may already be plain strings
    (e.g. re-fetched after a prior serialization pass) — must not crash
    or mangle them."""
    assert tt._ttn_iso("2026-09-14T04:30:00+00:00") == "2026-09-14T04:30:00+00:00"
    assert tt._ttn_iso(None) is None
