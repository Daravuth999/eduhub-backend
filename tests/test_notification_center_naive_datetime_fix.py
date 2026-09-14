"""tests/test_notification_center_naive_datetime_fix.py
==========================================================
Real bug, reported directly by a user: Activity Center items that had
JUST happened were showing as "7h ago" — the exact magnitude of
Cambodia's UTC+7 offset.

Root cause: this app's single Motor client (server.py, `AsyncIOMotorClient
(MONGO_URL)`) has no `tz_aware=True`, so every datetime PyMongo hands back
after reading a document is NAIVE — even though it was written as a
proper UTC instant via `datetime.now(timezone.utc)` (BSON dates are
always UTC internally; PyMongo just doesn't reattach tzinfo unless
asked). notification_center.py's `_serialize()` used to call a bare
`created.isoformat()` on that naive value, which OMITS the timezone
suffix entirely (e.g. "2026-09-14T04:30:00" instead of
"...+00:00"). The frontend's `new Date(...)` then parses a
suffix-less string as LOCAL browser time — for a student in Cambodia
(UTC+7) this silently added 7 hours to every elapsed-time calculation,
making "just happened" read as "7h ago".

Fixed by `_dt_to_iso_utc()`: a naive datetime read from this collection
is ALWAYS a real UTC instant (a fact, not a guess, given how it's
written), so it's explicitly tagged `tzinfo=timezone.utc` before
`.isoformat()` — guaranteeing every `createdAt` the frontend receives
carries an explicit, unambiguous UTC offset.
"""
from __future__ import annotations

from datetime import datetime, timedelta, timezone

import notification_center as nc


# ── _dt_to_iso_utc — the actual fix ──────────────────────────────────────────
def test_a_naive_datetime_gets_utc_offset_attached_not_omitted():
    """This is exactly what PyMongo hands back on a real read (no
    tz_aware=True on the client) — a naive value that IS a UTC instant
    but carries no marker saying so."""
    naive_utc = datetime(2026, 9, 14, 4, 30, 0)
    result = nc._dt_to_iso_utc(naive_utc)
    assert result == "2026-09-14T04:30:00+00:00"
    assert "+00:00" in result


def test_regression_a_naive_timestamp_from_seconds_ago_is_never_misread_as_hours_old():
    """The exact reported symptom: something that JUST happened must
    never produce a timestamp a Cambodia-timezone (UTC+7) browser would
    misinterpret. The frontend parses this string with `new Date(...)`,
    which respects an explicit UTC offset regardless of the viewer's own
    timezone — so re-parsing this string in Python and comparing it
    against a true UTC "now" must show a near-zero gap, not ~7 hours."""
    true_utc_now = datetime.now(timezone.utc)
    # Simulate exactly what a real Mongo read hands back: the same instant,
    # but with tzinfo stripped (as Motor does without tz_aware=True).
    naive_as_read_from_mongo = true_utc_now.replace(tzinfo=None)
    serialized = nc._dt_to_iso_utc(naive_as_read_from_mongo)
    reparsed = datetime.fromisoformat(serialized)
    assert reparsed.tzinfo is not None, "must carry an explicit UTC offset, never ambiguous"
    gap = abs((true_utc_now - reparsed).total_seconds())
    assert gap < 1, f"expected ~0s gap, got {gap}s (this magnitude of drift is the Cambodia UTC+7 bug)"


def test_an_already_aware_datetime_is_preserved_correctly_not_double_shifted():
    """The realtime WebSocket path already sends a freshly-built
    datetime.now(timezone.utc) value straight through (never round-
    tripped through Mongo first) — the fix must not double-convert an
    already-aware value into a different instant."""
    aware = datetime(2026, 9, 14, 4, 30, 0, tzinfo=timezone.utc)
    assert nc._dt_to_iso_utc(aware) == aware.isoformat()


def test_an_aware_non_utc_datetime_is_normalized_to_utc_not_left_as_is():
    kh_tz = timezone(timedelta(hours=7))
    aware_kh = datetime(2026, 9, 14, 11, 30, 0, tzinfo=kh_tz)  # 04:30 UTC
    result = nc._dt_to_iso_utc(aware_kh)
    assert result == "2026-09-14T04:30:00+00:00"


def test_a_missing_or_non_datetime_value_returns_an_honest_empty_string_not_a_crash():
    assert nc._dt_to_iso_utc(None) == ""
    assert nc._dt_to_iso_utc("") == ""


# ── _serialize — the actual end-to-end path GET /notifications uses ─────────
def test_serialize_produces_a_createdAt_with_an_explicit_utc_offset_from_a_naive_doc_field():
    """Mirrors a real Mongo document exactly as Motor would hand it back
    without tz_aware=True: `createdAt` is a naive datetime."""
    doc = {
        "_id": "abc123", "title": "t", "body": "b", "url": "/",
        "category": "attendance", "priority": "normal", "read": False,
        "studentId": "stu_alice",
        "createdAt": datetime(2026, 9, 14, 4, 30, 0),  # naive — as-read-from-Mongo
    }
    item = nc._serialize(doc)
    assert item["createdAt"] == "2026-09-14T04:30:00+00:00"
    # Regression guard against the original bug shape: a bare isoformat()
    # on a naive datetime never contains a "+" or "Z" offset marker.
    assert "+" in item["createdAt"] or item["createdAt"].endswith("Z")
