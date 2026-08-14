"""tests/test_password_reset_requests.py — Milestone 4 (Authentication
Completion, Phase 1) verification.

No live MongoDB — mongomock-motor is not available in this environment
(see test_notification_center_ws_auth.py for the established pattern), so
this uses a tiny in-process fake collection/db that satisfies the subset
of Motor register_password_reset_routes actually calls: `find_one`,
`insert_one`, `update_one`, and `find(...).sort(...).to_list(...)`.

Exercises the real APIRouter + FastAPI + TestClient, mirroring the
established test_notification_center_ws_auth.py / test_eduhub_platform_config.py
pattern — this module is registered via register_X_routes(api, db, ...)
exactly like lucky_draw.py/eligibility.py, so (unlike the Student/User
routes still living directly in server.py) it CAN be tested end-to-end
without importing server.py itself.
"""
from __future__ import annotations

from datetime import datetime, timezone

import pytest
from fastapi import APIRouter, FastAPI
from fastapi.testclient import TestClient

from password_reset_requests import register_password_reset_routes


def _matches(doc_value, query_value):
    return doc_value == query_value


class _Cursor:
    def __init__(self, docs):
        self._docs = list(docs)

    def sort(self, field, direction=1):
        self._docs.sort(key=lambda d: d.get(field), reverse=(direction < 0))
        return self

    async def to_list(self, length=None):
        return list(self._docs[:length] if length else self._docs)


class _Coll:
    def __init__(self, docs=None):
        self._docs = list(docs or [])

    async def find_one(self, q, projection=None):
        for doc in self._docs:
            if all(_matches(doc.get(k), v) for k, v in q.items()):
                return dict(doc)
        return None

    def find(self, q=None, projection=None):
        q = q or {}
        matched = [d for d in self._docs if all(_matches(d.get(k), v) for k, v in q.items())]
        return _Cursor(matched)

    async def insert_one(self, doc):
        self._docs.append(dict(doc))
        return doc

    async def update_one(self, q, update):
        class _Result:
            matched_count = 0

        for doc in self._docs:
            if all(_matches(doc.get(k), v) for k, v in q.items()):
                doc.update(update.get("$set", {}))
                _Result.matched_count = 1
                break
        return _Result()


class _FakeDB:
    def __init__(self, students, requests=None):
        self.students = _Coll(students)
        self.password_reset_requests = _Coll(requests or [])


async def _admin_ok():
    return {"email": "teacher@test"}


def _make_client(students, requests=None, turnstile_result=True):
    db = _FakeDB(students, requests)
    app = FastAPI()
    api = APIRouter(prefix="/api")

    async def _verify_turnstile(token):
        return turnstile_result

    register_password_reset_routes(
        api, db,
        require_admin=_admin_ok,
        verify_turnstile=_verify_turnstile,
    )
    app.include_router(api)
    return TestClient(app), db


STUDENT = {
    "student_id": "stu001", "clean_id": "stu001",
    "display_name": "Test Student", "group": "A",
}


def test_forgot_password_missing_clean_id_is_rejected():
    client, _ = _make_client([STUDENT])
    r = client.post("/api/auth/student/forgot-password", json={"turnstile_token": "x"})
    assert r.status_code == 400


def test_forgot_password_bot_check_failure_is_rejected():
    client, db = _make_client([STUDENT], turnstile_result=False)
    r = client.post(
        "/api/auth/student/forgot-password",
        json={"clean_id": "stu001", "turnstile_token": "bad"},
    )
    assert r.status_code == 401
    assert db.password_reset_requests._docs == []


def test_forgot_password_unknown_clean_id_returns_generic_response_no_row():
    client, db = _make_client([STUDENT])
    r = client.post(
        "/api/auth/student/forgot-password",
        json={"clean_id": "nonexistent", "turnstile_token": "x"},
    )
    assert r.status_code == 200
    assert r.json()["ok"] is True
    # Never confirms/denies existence — same response as the known-ID case,
    # and critically, no queue row was created for a nonexistent student.
    assert db.password_reset_requests._docs == []


def test_forgot_password_known_clean_id_creates_pending_request():
    client, db = _make_client([STUDENT])
    r = client.post(
        "/api/auth/student/forgot-password",
        json={"clean_id": "stu001", "turnstile_token": "x"},
    )
    assert r.status_code == 200
    assert r.json()["ok"] is True
    assert len(db.password_reset_requests._docs) == 1
    row = db.password_reset_requests._docs[0]
    assert row["student_id"] == "stu001"
    assert row["clean_id"] == "stu001"
    assert row["display_name"] == "Test Student"
    assert row["status"] == "pending"
    assert row["resolved_at"] is None


def test_forgot_password_duplicate_pending_request_does_not_create_second_row():
    client, db = _make_client([STUDENT])
    client.post("/api/auth/student/forgot-password", json={"clean_id": "stu001", "turnstile_token": "x"})
    client.post("/api/auth/student/forgot-password", json={"clean_id": "stu001", "turnstile_token": "x"})
    assert len(db.password_reset_requests._docs) == 1


def test_forgot_password_response_identical_for_known_and_unknown_ids():
    client, _ = _make_client([STUDENT])
    r1 = client.post("/api/auth/student/forgot-password", json={"clean_id": "stu001", "turnstile_token": "x"})
    r2 = client.post("/api/auth/student/forgot-password", json={"clean_id": "nope", "turnstile_token": "x"})
    assert r1.json() == r2.json()


def test_teacher_list_returns_only_pending_newest_first():
    older = {
        "request_id": "prr_1", "student_id": "stu001", "clean_id": "stu001",
        "display_name": "A", "group": "A", "status": "pending",
        "requested_at": datetime(2026, 1, 1, tzinfo=timezone.utc), "resolved_at": None,
    }
    newer = {
        "request_id": "prr_2", "student_id": "stu002", "clean_id": "stu002",
        "display_name": "B", "group": "A", "status": "pending",
        "requested_at": datetime(2026, 2, 1, tzinfo=timezone.utc), "resolved_at": None,
    }
    resolved = {
        "request_id": "prr_3", "student_id": "stu003", "clean_id": "stu003",
        "display_name": "C", "group": "A", "status": "resolved",
        "requested_at": datetime(2026, 3, 1, tzinfo=timezone.utc), "resolved_at": datetime.now(timezone.utc),
    }
    client, _ = _make_client([STUDENT], requests=[older, newer, resolved])
    r = client.get("/api/teacher/password-reset-requests")
    assert r.status_code == 200
    ids = [row["request_id"] for row in r.json()["requests"]]
    assert ids == ["prr_2", "prr_1"]  # newest pending first, resolved excluded


def test_teacher_dismiss_marks_resolved():
    pending = {
        "request_id": "prr_1", "student_id": "stu001", "clean_id": "stu001",
        "display_name": "A", "group": "A", "status": "pending",
        "requested_at": datetime.now(timezone.utc), "resolved_at": None,
    }
    client, db = _make_client([STUDENT], requests=[pending])
    r = client.post("/api/teacher/password-reset-requests/prr_1/dismiss")
    assert r.status_code == 200
    assert db.password_reset_requests._docs[0]["status"] == "resolved"
    assert db.password_reset_requests._docs[0]["resolved_at"] is not None


def test_teacher_dismiss_unknown_request_id_returns_404():
    client, _ = _make_client([STUDENT])
    r = client.post("/api/teacher/password-reset-requests/nope/dismiss")
    assert r.status_code == 404


def test_after_dismiss_a_new_forgot_password_request_can_be_created_again():
    pending = {
        "request_id": "prr_1", "student_id": "stu001", "clean_id": "stu001",
        "display_name": "A", "group": "A", "status": "pending",
        "requested_at": datetime.now(timezone.utc), "resolved_at": None,
    }
    client, db = _make_client([STUDENT], requests=[pending])
    client.post("/api/teacher/password-reset-requests/prr_1/dismiss")
    client.post("/api/auth/student/forgot-password", json={"clean_id": "stu001", "turnstile_token": "x"})
    pending_rows = [d for d in db.password_reset_requests._docs if d["status"] == "pending"]
    assert len(pending_rows) == 1
    assert pending_rows[0]["request_id"] != "prr_1"
