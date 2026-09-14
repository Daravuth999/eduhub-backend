"""tests/test_messaging_naive_datetime_fix.py
=================================================
Same root-cause bug as notification_center.py's Activity Center (see
test_notification_center_naive_datetime_fix.py's module docstring for
the full mechanism): this app's Motor client has no `tz_aware=True`, so
a `createdAt`/`lastMessageAt` value read back from a real message or
conversation document is a NAIVE datetime, even though it was written
as a proper UTC instant. messaging_tools.py's `_iso()` used to call a
bare `.isoformat()` on that naive value, which omits the timezone
suffix — the frontend's `new Date(...)` then parses it as LOCAL browser
time, silently adding the viewer's own UTC offset (7h for Cambodia) on
top of the real elapsed time. A message sent seconds ago would show as
"7h ago" the moment the thread/inbox re-fetched over REST (the realtime
WebSocket delivery path was unaffected — it serializes the freshly-
built aware value before it ever round-trips through Mongo).
"""
from __future__ import annotations

from datetime import datetime, timedelta, timezone

import messaging_tools as mt


def test_a_naive_datetime_gets_utc_offset_attached_not_omitted():
    naive_utc = datetime(2026, 9, 14, 4, 30, 0)
    assert mt._iso(naive_utc) == "2026-09-14T04:30:00+00:00"


def test_regression_a_message_sent_seconds_ago_is_never_misread_as_hours_old():
    """The exact reported symptom, applied to messaging: re-parsing the
    serialized string must show a near-zero gap against true UTC now,
    never ~7 hours (Cambodia's offset)."""
    true_utc_now = datetime.now(timezone.utc)
    naive_as_read_from_mongo = true_utc_now.replace(tzinfo=None)
    serialized = mt._iso(naive_as_read_from_mongo)
    reparsed = datetime.fromisoformat(serialized)
    assert reparsed.tzinfo is not None
    gap = abs((true_utc_now - reparsed).total_seconds())
    assert gap < 1, f"expected ~0s gap, got {gap}s"


def test_an_already_aware_datetime_is_preserved_not_double_shifted():
    """The realtime WS path sends a freshly-built aware value straight
    through — the fix must not double-convert it."""
    aware = datetime(2026, 9, 14, 4, 30, 0, tzinfo=timezone.utc)
    assert mt._iso(aware) == aware.isoformat()


def test_none_returns_none_not_a_crash():
    assert mt._iso(None) is None


def test_serialize_message_and_conversation_both_carry_an_explicit_utc_offset():
    """Both call sites of _iso() inside this module — message createdAt
    and conversation lastMessageAt/createdAt — must be fixed together."""
    msg_doc = {
        "_id": "m1", "conversationId": "c1", "senderId": "stu_alice",
        "kind": "text", "body": "hi", "clientMessageId": "x",
        "createdAt": datetime(2026, 9, 14, 4, 30, 0),  # naive, as-read-from-Mongo
    }
    msg = mt._serialize_message(msg_doc)
    assert msg["createdAt"] == "2026-09-14T04:30:00+00:00"

    convo_doc = {
        "_id": "c1", "kind": "dm", "participantIds": ["a", "b"],
        "createdAt": datetime(2026, 9, 14, 3, 0, 0),
        "lastMessageAt": datetime(2026, 9, 14, 4, 30, 0),
        "lastMessagePreview": "hi",
    }
    convo = mt._serialize_conversation(convo_doc)
    assert convo["createdAt"] == "2026-09-14T03:00:00+00:00"
    assert convo["lastMessageAt"] == "2026-09-14T04:30:00+00:00"
