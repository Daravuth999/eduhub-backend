"""tests/test_notification_center_ws_auth.py — regression test for the
production bug where a stale cached Bearer token (localStorage
`student_session_token`) shadowed a still-valid `student_session` cookie
and caused the Activity Center WebSocket to reject the handshake with
403/4401, even though the SAME request would have authenticated fine via
`current_student()` for a regular REST call.

No live MongoDB — mongomock-motor is not available in this environment
(see test_voice_treasure_media.py for the established pattern), so this
uses a tiny in-process fake collection that satisfies the subset of Motor
the module under test actually calls.
"""
from __future__ import annotations

from datetime import datetime, timedelta, timezone

import pytest
from fastapi import APIRouter, FastAPI
from fastapi.testclient import TestClient

import notification_center as nc


def _matches(doc_value, query_value):
    if isinstance(query_value, dict) and "$ne" in query_value:
        return doc_value != query_value["$ne"]
    return doc_value == query_value


class _Coll:
    def __init__(self, docs=None):
        self._docs = list(docs or [])

    async def find_one(self, q, projection=None):
        for doc in self._docs:
            if all(_matches(doc.get(k), v) for k, v in q.items()):
                return dict(doc)
        return None

    async def create_index(self, *a, **k):
        return "idx"


class _FakeDB:
    def __init__(self, sessions, students):
        self.student_sessions = _Coll(sessions)
        self.students = _Coll(students)
        self.activity_notifications = _Coll([])

    def __getitem__(self, name):
        return getattr(self, name)


def _make_client(sessions, students):
    db = _FakeDB(sessions, students)
    app = FastAPI()
    api = APIRouter(prefix="/api")
    nc.register_notification_center(api, app, db, None)
    app.include_router(api)
    return TestClient(app)


FUTURE = (datetime.now(timezone.utc) + timedelta(days=1)).isoformat()
STUDENT = {"student_id": "stu094", "clean_id": "stu094", "display_name": "Test", "is_active": True}


def test_valid_cookie_authenticates_even_when_query_token_is_stale():
    """The exact production scenario: ?token= is a session that no longer
    exists (e.g. rotated/expired), but the student_session cookie is a
    genuinely valid, current session. Before the fix, the WS handler picked
    `token` because it was non-empty and never even looked at the cookie —
    the connection was wrongly rejected. After the fix, both are tried
    independently and the valid cookie authenticates the connection."""
    sessions = [{"session_token": "COOKIE_VALID", "student_id": "stu094", "expires_at": FUTURE}]
    client = _make_client(sessions, [STUDENT])
    with client.websocket_connect(
        "/api/notifications/ws?token=STALE_NONEXISTENT_TOKEN",
        cookies={"student_session": "COOKIE_VALID"},
    ) as ws:
        msg = ws.receive_json()
        assert msg == {"type": "connected"}


def test_valid_query_token_authenticates_when_cookie_missing():
    """Reverse direction — no cookie at all (e.g. iOS Safari ITP evicted it),
    but the Bearer fallback token is valid. Must still work."""
    sessions = [{"session_token": "TOKEN_VALID", "student_id": "stu094", "expires_at": FUTURE}]
    client = _make_client(sessions, [STUDENT])
    with client.websocket_connect("/api/notifications/ws?token=TOKEN_VALID") as ws:
        msg = ws.receive_json()
        assert msg == {"type": "connected"}


def test_both_invalid_is_still_rejected():
    """Neither source resolves to a real session — must still be rejected,
    proving the fix didn't weaken auth."""
    client = _make_client([], [STUDENT])
    with pytest.raises(Exception):
        with client.websocket_connect(
            "/api/notifications/ws?token=NOPE",
            cookies={"student_session": "ALSO_NOPE"},
        ) as ws:
            ws.receive_json()


def test_expired_session_token_is_rejected_even_if_present():
    """An expired session must not authenticate, regardless of which slot
    (token vs cookie) it came from."""
    past = (datetime.now(timezone.utc) - timedelta(days=1)).isoformat()
    sessions = [{"session_token": "EXPIRED", "student_id": "stu094", "expires_at": past}]
    client = _make_client(sessions, [STUDENT])
    with pytest.raises(Exception):
        with client.websocket_connect("/api/notifications/ws?token=EXPIRED") as ws:
            ws.receive_json()


def test_inactive_student_is_rejected():
    sessions = [{"session_token": "TOK", "student_id": "stu094", "expires_at": FUTURE}]
    inactive = {**STUDENT, "is_active": False}
    client = _make_client(sessions, [inactive])
    with pytest.raises(Exception):
        with client.websocket_connect("/api/notifications/ws?token=TOK") as ws:
            ws.receive_json()
