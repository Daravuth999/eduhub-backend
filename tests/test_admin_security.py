"""tests/test_admin_security.py — Force All Users to Sign Out.

No live MongoDB — a tiny in-process fake collection/db, matching the
established pattern from test_student_smart_login.py. `require_admin` is
injected (the real register_admin_security_routes(api, db, ...) explicit-DI
signature makes this possible without touching server.py), so these tests
exercise the REAL admin_security.py route logic end to end through a real
FastAPI TestClient.
"""
from __future__ import annotations

from fastapi import APIRouter, FastAPI, HTTPException
from fastapi.testclient import TestClient

from admin_security import register_admin_security_routes


class _Coll:
    def __init__(self, docs=None):
        self._docs = list(docs or [])

    async def find_one(self, q, projection=None):
        for doc in self._docs:
            if all(doc.get(k) == v for k, v in q.items()):
                return dict(doc)
        return None

    async def insert_one(self, doc):
        self._docs.append(dict(doc))

    async def delete_many(self, q):
        class _Result:
            deleted_count = 0

        if not q:
            _Result.deleted_count = len(self._docs)
            self._docs = []
            return _Result()
        keep = []
        removed = 0
        for doc in self._docs:
            if all(doc.get(k) == v for k, v in q.items()):
                removed += 1
            else:
                keep.append(doc)
        self._docs = keep
        _Result.deleted_count = removed
        return _Result()

    def __len__(self):
        return len(self._docs)


class _FakeDB:
    def __init__(self, student_sessions=None, user_sessions=None, students=None, credentials=None):
        self.student_sessions = _Coll(student_sessions)
        self.user_sessions = _Coll(user_sessions)
        self.students = _Coll(students)
        self.student_smart_login_credentials = _Coll(credentials)


class _FakeAdmin:
    email = "teacher@example.com"
    is_admin = True


def _make_client(db=None, admin_ok=True):
    db = db or _FakeDB()
    app = FastAPI()
    api = APIRouter(prefix="/api")

    async def _fake_require_admin():
        if not admin_ok:
            raise HTTPException(status_code=403, detail="Admin access required")
        return _FakeAdmin()

    register_admin_security_routes(api, db, require_admin=_fake_require_admin)
    app.include_router(api)
    return TestClient(app), db


def _seed_db():
    return _FakeDB(
        student_sessions=[
            {"student_id": "stu001", "session_token": "tok-a", "created_at": "2026-08-01T00:00:00+00:00"},
            {"student_id": "stu002", "session_token": "tok-b", "created_at": "2026-08-01T00:00:00+00:00"},
        ],
        user_sessions=[
            {"user_id": "teacher1", "session_token": "tok-c", "created_at": "2026-08-01T00:00:00+00:00"},
        ],
        students=[
            {"student_id": "stu001", "clean_id": "stu001", "display_name": "Dalita", "is_active": True},
            {"student_id": "stu002", "clean_id": "stu002", "display_name": "Sopheak", "is_active": True},
        ],
        credentials=[
            {"student_id": "stu001", "credential_lookup": "hash-a", "created_at": "2026-08-01T00:00:00+00:00"},
        ],
    )


def test_force_logout_all_deletes_every_student_session():
    db = _seed_db()
    client, db = _make_client(db)
    r = client.post("/api/admin/security/force-logout-all")
    assert r.status_code == 200
    assert len(db.student_sessions) == 0


def test_force_logout_all_deletes_every_admin_session():
    db = _seed_db()
    client, db = _make_client(db)
    r = client.post("/api/admin/security/force-logout-all")
    assert r.status_code == 200
    assert len(db.user_sessions) == 0


def test_force_logout_all_returns_accurate_counts():
    db = _seed_db()
    client, db = _make_client(db)
    r = client.post("/api/admin/security/force-logout-all")
    body = r.json()
    assert body["ok"] is True
    assert body["student_sessions_invalidated"] == 2
    assert body["admin_sessions_invalidated"] == 1
    assert body["total_invalidated"] == 3


def test_previously_valid_session_token_no_longer_present_after_force_logout():
    db = _seed_db()
    client, db = _make_client(db)
    client.post("/api/admin/security/force-logout-all")
    # This is the exact lookup current_student()/current_user() perform —
    # a miss here means the next authenticated request 401s, which is the
    # entire security guarantee this feature provides.
    import asyncio
    found = asyncio.run(db.student_sessions.find_one({"session_token": "tok-a"}))
    assert found is None


def test_student_accounts_remain_intact_after_force_logout():
    db = _seed_db()
    client, db = _make_client(db)
    client.post("/api/admin/security/force-logout-all")
    assert len(db.students) == 2


def test_smart_login_credentials_remain_valid_after_force_logout():
    db = _seed_db()
    client, db = _make_client(db)
    client.post("/api/admin/security/force-logout-all")
    assert len(db.student_smart_login_credentials) == 1


def test_new_session_can_be_issued_after_force_logout():
    """Simulates a student re-authenticating (e.g. via Smart Login QR)
    immediately after a global sign-out — the collection must still work
    normally for fresh inserts."""
    db = _seed_db()
    client, db = _make_client(db)
    client.post("/api/admin/security/force-logout-all")
    import asyncio
    asyncio.run(
        db.student_sessions.insert_one(
            {"student_id": "stu001", "session_token": "tok-fresh", "created_at": "2026-08-17T00:00:00+00:00"}
        )
    )
    assert len(db.student_sessions) == 1


def test_force_logout_all_requires_admin_authorization():
    db = _seed_db()
    client, db = _make_client(db, admin_ok=False)
    r = client.post("/api/admin/security/force-logout-all")
    assert r.status_code == 403
    # Nothing invalidated — the guard ran before the handler body.
    assert len(db.student_sessions) == 2
    assert len(db.user_sessions) == 1


def test_force_logout_all_is_safe_to_call_with_no_active_sessions():
    client, db = _make_client(_FakeDB())
    r = client.post("/api/admin/security/force-logout-all")
    assert r.status_code == 200
    body = r.json()
    assert body["total_invalidated"] == 0
