"""tests/test_auth_session_ttl.py — Milestone 0 (Authentication Completion,
Phase 1) verification.

No live MongoDB — mongomock-motor is not available in this environment (see
test_notification_center_ws_auth.py for the established pattern), so this
uses a tiny in-process fake collection/db that satisfies the subset of
Motor the module under test actually calls: `db.command(...)`,
`coll.create_index(...)`, `coll.find(...)` (async iteration), and
`coll.delete_many(...)`.

Proves, without touching real session data:
  - ensure_ttl_index() issues the correct collMod, and falls back to a
    fresh create_index(expireAfterSeconds=...) if collMod fails (e.g. a
    brand-new deployment where the plain index doesn't exist yet).
  - cleanup_expired_sessions() removes ONLY rows that are already
    logically expired, using the identical string-or-Date tolerant
    comparison current_student()/current_user() already trust in
    server.py, and leaves every currently-valid session (string- or
    Date-typed alike) completely untouched.
"""
from __future__ import annotations

from datetime import datetime, timedelta, timezone

import pytest

from auth_session_ttl import cleanup_expired_sessions, ensure_ttl_index


class _DeleteResult:
    def __init__(self, deleted_count):
        self.deleted_count = deleted_count


class _Cursor:
    def __init__(self, docs):
        self._docs = list(docs)

    def __aiter__(self):
        self._iter = iter(self._docs)
        return self

    async def __anext__(self):
        try:
            return next(self._iter)
        except StopIteration:
            raise StopAsyncIteration


class _Coll:
    def __init__(self, docs=None, name="coll"):
        self._docs = list(docs or [])
        self.name = name
        self.create_index_calls = []
        self.deleted_ids = None

    def find(self, query=None, projection=None):
        return _Cursor(self._docs)

    async def create_index(self, field, **kwargs):
        self.create_index_calls.append((field, kwargs))
        return "idx"

    async def delete_many(self, query):
        ids = set(query["_id"]["$in"])
        self.deleted_ids = ids
        before = len(self._docs)
        self._docs = [d for d in self._docs if d["_id"] not in ids]
        return _DeleteResult(before - len(self._docs))


class _FakeDB:
    """`command()` succeeds by default (simulating a normal collMod);
    set `command_should_fail = True` to exercise the create_index fallback."""

    def __init__(self, collections: dict):
        self._collections = collections
        self.command_calls = []
        self.command_should_fail = False

    def __getitem__(self, name):
        return self._collections[name]

    async def command(self, *args, **kwargs):
        self.command_calls.append((args, kwargs))
        if self.command_should_fail:
            raise RuntimeError("simulated collMod failure (plain index doesn't exist yet)")
        return {"ok": 1}


# ─────────────────────────────────────────────────────────────────────────
# ensure_ttl_index
# ─────────────────────────────────────────────────────────────────────────

@pytest.mark.asyncio
async def test_ensure_ttl_index_issues_collmod_with_correct_shape():
    db = _FakeDB({"student_sessions": _Coll(name="student_sessions")})
    await ensure_ttl_index(db, "student_sessions")
    assert len(db.command_calls) == 1
    args, kwargs = db.command_calls[0]
    assert args[0] == "collMod"
    assert args[1] == "student_sessions"
    assert kwargs["index"] == {"keyPattern": {"expires_at": 1}, "expireAfterSeconds": 0}


@pytest.mark.asyncio
async def test_ensure_ttl_index_falls_back_to_create_index_when_collmod_fails():
    coll = _Coll(name="student_sessions")
    db = _FakeDB({"student_sessions": coll})
    db.command_should_fail = True
    await ensure_ttl_index(db, "student_sessions")
    assert len(coll.create_index_calls) == 1
    field, kwargs = coll.create_index_calls[0]
    assert field == "expires_at"
    assert kwargs == {"expireAfterSeconds": 0}


@pytest.mark.asyncio
async def test_ensure_ttl_index_never_raises_even_if_both_paths_fail():
    class _AlwaysFailsColl(_Coll):
        async def create_index(self, field, **kwargs):
            raise RuntimeError("simulated total failure")

    db = _FakeDB({"student_sessions": _AlwaysFailsColl(name="student_sessions")})
    db.command_should_fail = True
    # Must not raise — a startup-time index migration failure must never
    # crash the whole application.
    await ensure_ttl_index(db, "student_sessions")


# ─────────────────────────────────────────────────────────────────────────
# cleanup_expired_sessions
# ─────────────────────────────────────────────────────────────────────────

def _iso(dt):
    return dt.isoformat()


@pytest.mark.asyncio
async def test_cleanup_removes_only_already_expired_rows_string_and_date_alike():
    now = datetime.now(timezone.utc)
    past = now - timedelta(days=1)
    future = now + timedelta(days=1)

    student_sessions = _Coll([
        {"_id": "s-expired-string", "expires_at": _iso(past)},
        {"_id": "s-expired-date", "expires_at": past},
        {"_id": "s-valid-string", "expires_at": _iso(future)},
        {"_id": "s-valid-date", "expires_at": future},
        {"_id": "s-no-expiry-field"},
    ], name="student_sessions")
    user_sessions = _Coll([
        {"_id": "u-expired-string", "expires_at": _iso(past)},
        {"_id": "u-valid-date", "expires_at": future},
    ], name="user_sessions")

    db = _FakeDB({"student_sessions": student_sessions, "user_sessions": user_sessions})
    await cleanup_expired_sessions(db)

    remaining_student_ids = {d["_id"] for d in student_sessions._docs}
    assert remaining_student_ids == {"s-valid-string", "s-valid-date", "s-no-expiry-field"}

    remaining_user_ids = {d["_id"] for d in user_sessions._docs}
    assert remaining_user_ids == {"u-valid-date"}


@pytest.mark.asyncio
async def test_cleanup_is_a_no_op_when_nothing_is_expired():
    future = datetime.now(timezone.utc) + timedelta(days=1)
    student_sessions = _Coll([{"_id": "s1", "expires_at": future}], name="student_sessions")
    user_sessions = _Coll([{"_id": "u1", "expires_at": future}], name="user_sessions")
    db = _FakeDB({"student_sessions": student_sessions, "user_sessions": user_sessions})

    await cleanup_expired_sessions(db)

    assert student_sessions.deleted_ids is None
    assert user_sessions.deleted_ids is None
    assert len(student_sessions._docs) == 1
    assert len(user_sessions._docs) == 1


@pytest.mark.asyncio
async def test_cleanup_never_raises_if_a_collection_is_unreachable():
    class _BrokenColl(_Coll):
        def find(self, query=None, projection=None):
            raise RuntimeError("simulated connection error")

    db = _FakeDB({
        "student_sessions": _BrokenColl(name="student_sessions"),
        "user_sessions": _Coll([], name="user_sessions"),
    })
    # Must not raise — one broken collection must never prevent the other
    # from being cleaned up, and must never crash startup.
    await cleanup_expired_sessions(db)
