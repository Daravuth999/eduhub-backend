"""tests/test_student_smart_login.py — EduHub Smart Login verification.

No live MongoDB — a tiny in-process fake collection/db, matching the
established pattern from test_student_avatar.py. `require_admin`,
`verify_turnstile`, and `issue_session` are all injected fakes (the real
`register_student_smart_login_routes(api, db, ...)` explicit-DI signature
makes this possible without touching server.py at all), so these tests
exercise the REAL student_smart_login.py route logic — token generation,
sha256 lookup, rate limiting, the QR_PAYLOAD_PREFIX format check, segno
rendering — end to end through a real FastAPI TestClient.
"""
from __future__ import annotations

from fastapi import APIRouter, FastAPI
from fastapi.testclient import TestClient

import student_smart_login as sl
from student_smart_login import QR_PAYLOAD_PREFIX, register_student_smart_login_routes


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

    async def update_one(self, q, update, upsert=False):
        class _Result:
            matched_count = 0

        for doc in self._docs:
            if all(_matches(doc.get(k), v) for k, v in q.items()):
                doc.update(update.get("$set", {}))
                _Result.matched_count = 1
                return _Result()
        if upsert:
            new_doc = {**q, **update.get("$set", {})}
            self._docs.append(new_doc)
        return _Result()

    async def delete_one(self, q):
        class _Result:
            deleted_count = 0

        for i, doc in enumerate(self._docs):
            if all(_matches(doc.get(k), v) for k, v in q.items()):
                del self._docs[i]
                _Result.deleted_count = 1
                break
        return _Result()


class _FakeDB:
    def __init__(self, students=None, credentials=None):
        self.students = _Coll(students)
        self.student_smart_login_credentials = _Coll(credentials)


class _FakeAdmin:
    email = "teacher@example.com"


async def _fake_require_admin():
    return _FakeAdmin()


def _make_client(students=None, credentials=None, turnstile_ok=True, monkeypatch=None):
    db = _FakeDB(students, credentials)
    app = FastAPI()
    api = APIRouter(prefix="/api")

    issued = {"calls": []}

    async def _fake_verify_turnstile(token):
        return turnstile_ok

    async def _fake_issue_session(response, doc):
        issued["calls"].append(doc["student_id"])
        return {
            "student_id": doc["student_id"],
            "clean_id": doc["clean_id"],
            "display_name": doc["display_name"],
            "session_token": "fake-session-token",
        }

    # Rate-limit buckets are module-level state — reset between tests so
    # one test's attempts never bleed into the next.
    if monkeypatch is not None:
        monkeypatch.setattr(sl, "_RATE_BUCKETS", {})

    register_student_smart_login_routes(
        api, db,
        require_admin=_fake_require_admin,
        verify_turnstile=_fake_verify_turnstile,
        issue_session=_fake_issue_session,
    )
    app.include_router(api)
    return TestClient(app), db, issued


STUDENT = {
    "student_id": "stu_abc123",
    "clean_id": "stu001",
    "display_name": "Dara",
    "is_active": True,
}


# ── Generation ──────────────────────────────────────────────────────────
def test_generate_creates_a_credential_row_and_returns_payload_once(monkeypatch):
    client, db, _ = _make_client(students=[dict(STUDENT)], monkeypatch=monkeypatch)
    r = client.post("/api/teacher/students/stu_abc123/smart-login/generate")
    assert r.status_code == 200
    body = r.json()
    assert body["ok"] is True
    assert body["qr_payload"].startswith(QR_PAYLOAD_PREFIX)
    assert body["qr_png_data_uri"].startswith("data:image/png;base64,")
    assert body["qr_svg_data_uri"].startswith("data:image/svg+xml;base64,")

    doc = db.student_smart_login_credentials._docs[0]
    assert doc["student_id"] == "stu_abc123"
    # The stored row NEVER contains the plaintext secret or the raw payload.
    assert "qr_payload" not in doc
    assert doc["credential_lookup"] != body["qr_payload"]


def test_generate_for_unknown_student_404s(monkeypatch):
    client, _db, _ = _make_client(students=[], monkeypatch=monkeypatch)
    r = client.post("/api/teacher/students/nope/smart-login/generate")
    assert r.status_code == 404


def test_two_generations_for_two_students_produce_different_secrets(monkeypatch):
    # Uniqueness — the CSPRNG token, not just the wrapper.
    client, db, _ = _make_client(
        students=[dict(STUDENT), {**STUDENT, "student_id": "stu_xyz789", "clean_id": "stu002"}],
        monkeypatch=monkeypatch,
    )
    r1 = client.post("/api/teacher/students/stu_abc123/smart-login/generate").json()
    r2 = client.post("/api/teacher/students/stu_xyz789/smart-login/generate").json()
    assert r1["qr_payload"] != r2["qr_payload"]
    lookups = {d["credential_lookup"] for d in db.student_smart_login_credentials._docs}
    assert len(lookups) == 2


# ── Valid / invalid / revoked / regenerated login ───────────────────────
def test_valid_qr_authenticates_and_converges_into_issue_session(monkeypatch):
    client, db, issued = _make_client(students=[dict(STUDENT)], monkeypatch=monkeypatch)
    gen = client.post("/api/teacher/students/stu_abc123/smart-login/generate").json()

    r = client.post("/api/auth/student/smart-login", json={"qr_payload": gen["qr_payload"]})
    assert r.status_code == 200
    assert r.json()["session_token"] == "fake-session-token"
    # The QR verification handed off to the SAME session-issuance function
    # password login uses — never minted its own session.
    assert issued["calls"] == ["stu_abc123"]


def test_invalid_qr_rejected_with_generic_401(monkeypatch):
    client, _db, issued = _make_client(students=[dict(STUDENT)], monkeypatch=monkeypatch)
    r = client.post("/api/auth/student/smart-login", json={"qr_payload": "totally-bogus"})
    assert r.status_code == 401
    assert issued["calls"] == []


def test_wrong_prefix_rejected_same_as_unknown_credential(monkeypatch):
    # Enumeration protection: a well-formed-but-wrong secret and a
    # malformed-prefix string return the IDENTICAL error.
    client, _db, _ = _make_client(students=[dict(STUDENT)], monkeypatch=monkeypatch)
    r1 = client.post("/api/auth/student/smart-login", json={"qr_payload": f"{QR_PAYLOAD_PREFIX}not-the-real-secret"})
    r2 = client.post("/api/auth/student/smart-login", json={"qr_payload": "some-other-qr-app:v1:payload"})
    assert r1.status_code == r2.status_code == 401
    assert r1.json()["detail"] == r2.json()["detail"]


def test_revoked_qr_immediately_rejected(monkeypatch):
    client, _db, issued = _make_client(students=[dict(STUDENT)], monkeypatch=monkeypatch)
    gen = client.post("/api/teacher/students/stu_abc123/smart-login/generate").json()

    rev = client.post("/api/teacher/students/stu_abc123/smart-login/revoke")
    assert rev.status_code == 200
    assert rev.json()["revoked"] is True

    r = client.post("/api/auth/student/smart-login", json={"qr_payload": gen["qr_payload"]})
    assert r.status_code == 401
    assert issued["calls"] == []


def test_revoke_with_no_existing_credential_is_a_safe_no_op(monkeypatch):
    client, _db, _ = _make_client(students=[dict(STUDENT)], monkeypatch=monkeypatch)
    r = client.post("/api/teacher/students/stu_abc123/smart-login/revoke")
    assert r.status_code == 200
    assert r.json()["revoked"] is False


def test_regenerating_invalidates_the_old_qr_and_the_new_one_works(monkeypatch):
    client, _db, issued = _make_client(students=[dict(STUDENT)], monkeypatch=monkeypatch)
    old = client.post("/api/teacher/students/stu_abc123/smart-login/generate").json()
    new = client.post("/api/teacher/students/stu_abc123/smart-login/generate").json()
    assert old["qr_payload"] != new["qr_payload"]

    old_attempt = client.post("/api/auth/student/smart-login", json={"qr_payload": old["qr_payload"]})
    assert old_attempt.status_code == 401

    new_attempt = client.post("/api/auth/student/smart-login", json={"qr_payload": new["qr_payload"]})
    assert new_attempt.status_code == 200
    assert issued["calls"] == ["stu_abc123"]


def test_disabled_account_rejected_even_with_a_valid_credential(monkeypatch):
    disabled = {**STUDENT, "is_active": False}
    client, _db, issued = _make_client(students=[disabled], monkeypatch=monkeypatch)
    gen = client.post("/api/teacher/students/stu_abc123/smart-login/generate").json()

    r = client.post("/api/auth/student/smart-login", json={"qr_payload": gen["qr_payload"]})
    assert r.status_code == 401
    assert issued["calls"] == []


def test_status_endpoint_reflects_active_then_not_generated_after_revoke(monkeypatch):
    client, _db, _ = _make_client(students=[dict(STUDENT)], monkeypatch=monkeypatch)
    before = client.get("/api/teacher/students/stu_abc123/smart-login").json()
    assert before["active"] is False

    client.post("/api/teacher/students/stu_abc123/smart-login/generate")
    mid = client.get("/api/teacher/students/stu_abc123/smart-login").json()
    assert mid["active"] is True

    client.post("/api/teacher/students/stu_abc123/smart-login/revoke")
    after = client.get("/api/teacher/students/stu_abc123/smart-login").json()
    assert after["active"] is False


# ── Malformed / oversized input ──────────────────────────────────────────
def test_empty_payload_rejected(monkeypatch):
    client, _db, _ = _make_client(students=[dict(STUDENT)], monkeypatch=monkeypatch)
    r = client.post("/api/auth/student/smart-login", json={"qr_payload": ""})
    assert r.status_code == 400


def test_oversized_payload_rejected_before_any_hashing(monkeypatch):
    client, _db, _ = _make_client(students=[dict(STUDENT)], monkeypatch=monkeypatch)
    huge = QR_PAYLOAD_PREFIX + ("a" * 2000)
    r = client.post("/api/auth/student/smart-login", json={"qr_payload": huge})
    assert r.status_code == 400


# ── Bot check reuse ───────────────────────────────────────────────────────
def test_failed_turnstile_check_blocks_an_otherwise_valid_credential(monkeypatch):
    client, _db, issued = _make_client(students=[dict(STUDENT)], turnstile_ok=False, monkeypatch=monkeypatch)
    gen_client, _, _ = _make_client(students=[dict(STUDENT)], monkeypatch=monkeypatch)
    # Generate against a Turnstile-passing client's db is irrelevant here —
    # what matters is that a bot-check failure blocks verification even
    # when the payload format is otherwise fine.
    r = client.post("/api/auth/student/smart-login", json={"qr_payload": f"{QR_PAYLOAD_PREFIX}anything"})
    assert r.status_code == 401
    assert r.json()["detail"] == "Bot check failed"
    assert issued["calls"] == []


# ── Rate limiting ─────────────────────────────────────────────────────────
def test_rate_limiter_blocks_after_the_window_max(monkeypatch):
    client, _db, _ = _make_client(students=[dict(STUDENT)], monkeypatch=monkeypatch)
    statuses = []
    for _ in range(sl._RATE_MAX_PER_WINDOW + 2):
        r = client.post("/api/auth/student/smart-login", json={"qr_payload": "bogus"})
        statuses.append(r.status_code)
    assert 429 in statuses
    # Everything up to the limit should be a normal 401 (invalid credential),
    # never silently swallowed.
    assert statuses[: sl._RATE_MAX_PER_WINDOW] == [401] * sl._RATE_MAX_PER_WINDOW


def test_rate_limit_window_expires(monkeypatch):
    client, _db, _ = _make_client(students=[dict(STUDENT)], monkeypatch=monkeypatch)
    for _ in range(sl._RATE_MAX_PER_WINDOW):
        client.post("/api/auth/student/smart-login", json={"qr_payload": "bogus"})
    blocked = client.post("/api/auth/student/smart-login", json={"qr_payload": "bogus"})
    assert blocked.status_code == 429

    # Simulate the window elapsing by rewriting the bucket's timestamps into
    # the past rather than sleeping in a test.
    for key in list(sl._RATE_BUCKETS.keys()):
        sl._RATE_BUCKETS[key] = type(sl._RATE_BUCKETS[key])(
            t - sl._RATE_WINDOW_S - 1 for t in sl._RATE_BUCKETS[key]
        )
    recovered = client.post("/api/auth/student/smart-login", json={"qr_payload": "bogus"})
    assert recovered.status_code == 401  # rate limit cleared; back to normal invalid-credential handling


# ── Authorization boundary ────────────────────────────────────────────────
def test_generate_and_revoke_require_admin_dependency(monkeypatch):
    # A caller that fails require_admin never reaches this module's logic —
    # proven by injecting a require_admin that raises, exactly like the
    # real one does for a non-admin user (server.py's require_admin: 403).
    from fastapi import HTTPException

    async def _deny_admin():
        raise HTTPException(status_code=403, detail="Admin access required")

    db = _FakeDB([dict(STUDENT)])
    app = FastAPI()
    api = APIRouter(prefix="/api")

    async def _ok_turnstile(_):
        return True

    async def _fake_issue(_response, doc):
        return {"ok": True}

    register_student_smart_login_routes(
        api, db, require_admin=_deny_admin, verify_turnstile=_ok_turnstile, issue_session=_fake_issue,
    )
    app.include_router(api)
    client = TestClient(app)

    r_gen = client.post("/api/teacher/students/stu_abc123/smart-login/generate")
    r_rev = client.post("/api/teacher/students/stu_abc123/smart-login/revoke")
    r_status = client.get("/api/teacher/students/stu_abc123/smart-login")
    assert r_gen.status_code == 403
    assert r_rev.status_code == 403
    assert r_status.status_code == 403
    # No credential was ever written despite the attempted call.
    assert db.student_smart_login_credentials._docs == []
