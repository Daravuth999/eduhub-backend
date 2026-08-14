"""tests/test_student_avatar.py — Premium Student Profile & Settings
milestone verification.

No live MongoDB and no live R2/S3 — this uses a tiny in-process fake
collection/db (matching the established pattern from
test_password_reset_requests.py) plus monkeypatched _upload_to_r2/
_delete_from_r2 (network-free). _validate_image_bytes itself is NOT
mocked — it's the real function imported from hero_artwork_tools.py, so
these tests exercise the actual magic-byte/size validation this module
reuses rather than duplicates.

Exercises the real APIRouter + FastAPI + TestClient, since
student_avatar.py follows the register_X_routes(api, db, ...) convention
(like password_reset_requests.py) rather than living inline in
server.py — this makes it independently testable end-to-end.
"""
from __future__ import annotations

import pytest
from fastapi import APIRouter, FastAPI
from fastapi.testclient import TestClient

import student_avatar
from student_avatar import register_student_avatar_routes

PNG_BYTES = b"\x89PNG\r\n\x1a\n" + b"\x00" * 32


def _matches(doc_value, query_value):
    return doc_value == query_value


class _Coll:
    def __init__(self, docs=None):
        self._docs = list(docs or [])

    async def find_one(self, q, projection=None):
        for doc in self._docs:
            if all(_matches(doc.get(k), v) for k, v in q.items()):
                return dict(doc)
        return None

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
    def __init__(self, students):
        self.students = _Coll(students)


class _FakeStudent:
    student_id = "stu001"


async def _fake_require_student():
    return _FakeStudent()


def _make_client(students, upload_side_effect=None, monkeypatch=None):
    db = _FakeDB(students)
    app = FastAPI()
    api = APIRouter(prefix="/api")

    uploaded = {"calls": []}
    deleted = {"calls": []}

    async def _fake_upload_to_r2(image_bytes, key, content_type, metadata):
        uploaded["calls"].append({"key": key, "content_type": content_type, "metadata": metadata})
        if upload_side_effect:
            upload_side_effect()
        return f"https://cdn.example.com/{key}"

    async def _fake_delete_from_r2(key):
        deleted["calls"].append(key)

    monkeypatch.setattr(student_avatar, "_upload_to_r2", _fake_upload_to_r2)
    monkeypatch.setattr(student_avatar, "_delete_from_r2", _fake_delete_from_r2)

    register_student_avatar_routes(api, db, require_student=_fake_require_student)
    app.include_router(api)
    return TestClient(app), db, uploaded, deleted


def test_upload_valid_png_stores_url_and_key(monkeypatch):
    client, db, uploaded, _ = _make_client([{"student_id": "stu001"}], monkeypatch=monkeypatch)
    r = client.post(
        "/api/auth/student/avatar",
        files={"file": ("me.png", PNG_BYTES, "image/png")},
    )
    assert r.status_code == 200
    body = r.json()
    assert body["ok"] is True
    assert body["avatar_url"].startswith("https://cdn.example.com/avatars/stu001_")
    assert body["avatar_url"].endswith(".png")

    doc = db.students._docs[0]
    assert doc["avatar_url"] == body["avatar_url"]
    assert doc["avatar_r2_key"].startswith("avatars/stu001_")
    assert len(uploaded["calls"]) == 1
    assert uploaded["calls"][0]["metadata"] == {"studentId": "stu001"}


def test_upload_invalid_bytes_rejected_before_any_upload_call(monkeypatch):
    client, db, uploaded, _ = _make_client([{"student_id": "stu001"}], monkeypatch=monkeypatch)
    r = client.post(
        "/api/auth/student/avatar",
        files={"file": ("me.txt", b"not an image", "text/plain")},
    )
    assert r.status_code == 400
    assert uploaded["calls"] == []
    assert db.students._docs[0].get("avatar_url") is None


def test_upload_replacing_an_existing_avatar_deletes_the_old_r2_object(monkeypatch):
    client, db, uploaded, deleted = _make_client(
        [{"student_id": "stu001", "avatar_url": "https://cdn.example.com/avatars/stu001_old.png",
          "avatar_r2_key": "avatars/stu001_old.png"}],
        monkeypatch=monkeypatch,
    )
    r = client.post(
        "/api/auth/student/avatar",
        files={"file": ("new.png", PNG_BYTES, "image/png")},
    )
    assert r.status_code == 200
    new_key = db.students._docs[0]["avatar_r2_key"]
    assert new_key != "avatars/stu001_old.png"
    assert deleted["calls"] == ["avatars/stu001_old.png"]


def test_delete_clears_fields_and_removes_r2_object(monkeypatch):
    client, db, _, deleted = _make_client(
        [{"student_id": "stu001", "avatar_url": "https://cdn.example.com/avatars/stu001_x.png",
          "avatar_r2_key": "avatars/stu001_x.png"}],
        monkeypatch=monkeypatch,
    )
    r = client.delete("/api/auth/student/avatar")
    assert r.status_code == 200
    assert r.json() == {"ok": True}
    assert db.students._docs[0]["avatar_url"] == ""
    assert db.students._docs[0]["avatar_r2_key"] == ""
    assert deleted["calls"] == ["avatars/stu001_x.png"]


def test_delete_with_no_prior_avatar_is_a_safe_no_op(monkeypatch):
    client, db, _, deleted = _make_client([{"student_id": "stu001"}], monkeypatch=monkeypatch)
    r = client.delete("/api/auth/student/avatar")
    assert r.status_code == 200
    assert deleted["calls"] == []


def test_oversized_file_rejected(monkeypatch):
    client, db, uploaded, _ = _make_client([{"student_id": "stu001"}], monkeypatch=monkeypatch)
    oversized = b"\x89PNG\r\n\x1a\n" + (b"\x00" * (8 * 1024 * 1024 + 1))
    r = client.post(
        "/api/auth/student/avatar",
        files={"file": ("big.png", oversized, "image/png")},
    )
    assert r.status_code == 400
    assert uploaded["calls"] == []
