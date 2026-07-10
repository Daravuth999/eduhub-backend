"""
tests/test_speaking_lab_join_preview.py

Tests for GET /api/speaking-lab/sessions/{session_or_code}/join-preview —
a read-only, authenticated endpoint that lets the PWA validate a session
BEFORE showing a join CTA, distinguishing:

  - an invalid/nonexistent code (404 session_not_found), from
  - a valid session that isn't open for entry ("closed"), from
  - a valid, open session ("waiting" | "active"),

and reports whether the calling student already has a confirmed entry.

This closes a real gap in `/my-entry`: that route never validates that
the session itself exists — it only ever reports the CALLING student's
own entry, so an invalid code silently looks identical to "valid
session, not joined yet" (`found: false`). See test_speaking_lab_
direct_join.py's `test_17_*`/`test_18_*` for /my-entry's own coverage,
which is unchanged by this addition.
"""
from __future__ import annotations

import copy
import os
import pathlib
import sys

import pytest

BACKEND_DIR = pathlib.Path(__file__).resolve().parent.parent
if str(BACKEND_DIR) not in sys.path:
    sys.path.insert(0, str(BACKEND_DIR))

import speaking_lab_direct_join as dj  # noqa: E402


# ─────────────────────────────────────────────────────────────────────────────
# Minimal fake Mongo layer — pure reads only, no transaction support needed.
# ─────────────────────────────────────────────────────────────────────────────
def _match(doc, query) -> bool:
    for k, v in query.items():
        if doc.get(k) != v:
            return False
    return True


class _Cursor:
    def __init__(self, docs):
        self._it = iter(docs)

    def __aiter__(self):
        return self

    async def __anext__(self):
        try:
            return next(self._it)
        except StopIteration:
            raise StopAsyncIteration


class _FakeCollection:
    def __init__(self):
        self._docs: list[dict] = []

    async def insert_one(self, doc, session=None):
        self._docs.append(copy.deepcopy(doc))

    async def find_one(self, query, projection=None, session=None):
        for d in self._docs:
            if _match(d, query):
                return copy.deepcopy(d)
        return None

    def find(self, query, projection=None, session=None):
        return _Cursor([copy.deepcopy(d) for d in self._docs if _match(d, query)])


class _FakeDB:
    def __init__(self):
        self._cols: dict[str, _FakeCollection] = {}

    def __getitem__(self, name):
        return self._cols.setdefault(name, _FakeCollection())

    def __getattr__(self, name):
        if name.startswith("_"):
            raise AttributeError(name)
        return self[name]


def _norm(v):
    return str(v or "").strip().lower()


class _Student:
    def __init__(self, clean_id):
        self.clean_id = clean_id
        self.student_id = clean_id
        self.display_name = clean_id


async def _noop_publish(session_id, event):
    return None


def _build_app(db, *, as_student="stu777"):
    from fastapi import APIRouter, FastAPI
    from fastapi.testclient import TestClient

    api = APIRouter(prefix="/api")

    async def _require_student_dyn():
        return _Student(as_student)

    dj.register_speaking_lab_direct_join_routes(
        api, db, db.speaking_lab_sessions, db.speaking_lab_entries,
        _noop_publish, _require_student_dyn, _norm,
    )
    app = FastAPI()
    app.include_router(api)
    return TestClient(app)


async def _seed_session(db, *, sid="s1", schedule="", fee=4, status="waiting", **extra):
    doc = {"session_id": sid, "schedule": schedule, "entry_fee": fee,
           "treasury_id": "stu092", "status": status}
    doc.update(extra)
    await db.speaking_lab_sessions.insert_one(doc)


@pytest.fixture(autouse=True)
def _clean_env():
    saved = os.environ.get("SPEAKING_LAB_DIRECT_JOIN_ENABLED")
    yield
    if saved is None:
        os.environ.pop("SPEAKING_LAB_DIRECT_JOIN_ENABLED", None)
    else:
        os.environ["SPEAKING_LAB_DIRECT_JOIN_ENABLED"] = saved


@pytest.mark.asyncio
async def test_1_invalid_code_returns_404_session_not_found():
    db = _FakeDB()
    client = _build_app(db)

    r = client.get("/api/speaking-lab/sessions/does_not_exist/join-preview")

    assert r.status_code == 404
    assert r.json()["detail"]["error"] == "session_not_found"


@pytest.mark.asyncio
async def test_2_waiting_session_reports_status_waiting():
    db = _FakeDB()
    await _seed_session(db, sid="s1", schedule="A", fee=4, status="waiting")
    client = _build_app(db)

    r = client.get("/api/speaking-lab/sessions/s1/join-preview")

    assert r.status_code == 200
    body = r.json()
    assert body["status"] == "waiting"
    assert body["schedule"] == "A"
    assert body["entry_fee"] == 4
    assert body["session_id"] == "s1"
    assert body["session_code"] == "s1"
    assert body["existing_entry"] is None


@pytest.mark.asyncio
async def test_3_active_session_reports_status_active():
    db = _FakeDB()
    await _seed_session(db, sid="s1", status="active")
    client = _build_app(db)

    r = client.get("/api/speaking-lab/sessions/s1/join-preview")

    assert r.json()["status"] == "active"


@pytest.mark.asyncio
async def test_4_draw_completed_session_reports_closed():
    db = _FakeDB()
    await _seed_session(db, sid="s1", status="active", lucky_draw_done=True)
    client = _build_app(db)

    r = client.get("/api/speaking-lab/sessions/s1/join-preview")

    assert r.json()["status"] == "closed"


@pytest.mark.asyncio
async def test_5_draw_prepared_session_reports_closed():
    db = _FakeDB()
    await _seed_session(db, sid="s1", status="active", lucky_draw_prepared_draw_id="d1")
    client = _build_app(db)

    r = client.get("/api/speaking-lab/sessions/s1/join-preview")

    assert r.json()["status"] == "closed"


@pytest.mark.asyncio
async def test_6_unrecognized_status_value_fails_safe_to_closed():
    db = _FakeDB()
    await _seed_session(db, sid="s1", status="some_future_status")
    client = _build_app(db)

    r = client.get("/api/speaking-lab/sessions/s1/join-preview")

    assert r.json()["status"] == "closed"


@pytest.mark.asyncio
async def test_7_direct_join_enabled_reported_accurately_when_off():
    db = _FakeDB()
    await _seed_session(db, sid="s1")
    client = _build_app(db)

    r = client.get("/api/speaking-lab/sessions/s1/join-preview")

    assert r.json()["direct_join_enabled"] is False


@pytest.mark.asyncio
async def test_8_direct_join_enabled_reported_accurately_when_on():
    os.environ["SPEAKING_LAB_DIRECT_JOIN_ENABLED"] = "true"
    db = _FakeDB()
    await db.speaking_lab_settings.insert_one(
        {"_id": "feature_flags", "speaking_lab_direct_join_enabled": True})
    await _seed_session(db, sid="s1")
    client = _build_app(db)

    r = client.get("/api/speaking-lab/sessions/s1/join-preview")

    assert r.json()["direct_join_enabled"] is True


@pytest.mark.asyncio
async def test_9_existing_committed_join_is_reported():
    db = _FakeDB()
    await _seed_session(db, sid="s1")
    await db.speaking_lab_direct_joins.insert_one(
        {"session_id": "s1", "student_id": "stu777", "status": "committed",
         "lucky_code": "STAR-1"})
    client = _build_app(db, as_student="stu777")

    r = client.get("/api/speaking-lab/sessions/s1/join-preview")

    assert r.json()["existing_entry"] == {"lucky_code": "STAR-1", "status": "confirmed"}


@pytest.mark.asyncio
async def test_10_legacy_paid_entry_is_reported():
    db = _FakeDB()
    await _seed_session(db, sid="s1")
    await db.speaking_lab_entries.insert_one(
        {"session_id": "s1", "student_id": "stu777", "paid_entry": True})
    await db[dj.COLLECTION_CODES].insert_one(
        {"session_id": "s1", "student_id": "stu777", "code": "MOON-2"})
    client = _build_app(db, as_student="stu777")

    r = client.get("/api/speaking-lab/sessions/s1/join-preview")

    assert r.json()["existing_entry"] == {"lucky_code": "MOON-2", "status": "confirmed"}


@pytest.mark.asyncio
async def test_11_another_students_entry_is_never_exposed():
    db = _FakeDB()
    await _seed_session(db, sid="s1")
    await db.speaking_lab_direct_joins.insert_one(
        {"session_id": "s1", "student_id": "stu999", "status": "committed",
         "lucky_code": "OTHER-1"})
    client = _build_app(db, as_student="stu777")

    r = client.get("/api/speaking-lab/sessions/s1/join-preview")

    assert r.json()["existing_entry"] is None


@pytest.mark.asyncio
async def test_12_never_mutates_any_collection():
    db = _FakeDB()
    await _seed_session(db, sid="s1")
    before_sessions = copy.deepcopy(db.speaking_lab_sessions._docs)
    client = _build_app(db, as_student="stu777")

    client.get("/api/speaking-lab/sessions/s1/join-preview")

    assert db.speaking_lab_sessions._docs == before_sessions
    assert db.speaking_lab_direct_joins._docs == []
    assert db[dj.COLLECTION_CODES]._docs == []
    assert db.speaking_lab_entries._docs == []


@pytest.mark.asyncio
async def test_13_unauthenticated_request_is_rejected():
    from fastapi import APIRouter, FastAPI, HTTPException
    from fastapi.testclient import TestClient

    db = _FakeDB()
    api = APIRouter(prefix="/api")

    async def _require_student_dyn():
        raise HTTPException(status_code=401, detail="Not authenticated")

    dj.register_speaking_lab_direct_join_routes(
        api, db, db.speaking_lab_sessions, db.speaking_lab_entries,
        _noop_publish, _require_student_dyn, _norm,
    )
    app = FastAPI()
    app.include_router(api)
    client = TestClient(app)

    r = client.get("/api/speaking-lab/sessions/s1/join-preview")

    assert r.status_code == 401
