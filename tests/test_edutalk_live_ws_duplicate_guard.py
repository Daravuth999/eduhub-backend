"""tests/test_edutalk_live_ws_duplicate_guard.py — re-audit hardening
regression: the WS handler (`live_ws` inside register_edutalk_live_routes)
previously had ZERO single-socket-per-session_id enforcement. A second
WebSocket connection for the SAME already-bridged session_id (a stale
browser tab retrying, or a student opening the same reader tab twice)
could open a second concurrent Gemini bridge against a session that was
already reserved/charged once, with both bridges racing to finalize it.

Exercises the REAL route via a FastAPI TestClient end-to-end (not just the
`_run_live_bridge` helper directly), since the guard lives in `live_ws`
itself, one layer above `_run_live_bridge`.
"""
from __future__ import annotations

import json
import types

import pytest
from fastapi import APIRouter, FastAPI
from fastapi.testclient import TestClient

import edutalk_live_tools as elt


class FakeGeminiWS:
    """One legitimate setupComplete ack, then blocks — simulating a live,
    still-open Gemini bridge, exactly like a real in-progress session."""

    def __init__(self):
        self._recv_count = 0

    async def send(self, s):
        pass

    async def recv(self):
        self._recv_count += 1
        if self._recv_count == 1:
            return json.dumps({"setupComplete": {}})
        import asyncio
        await asyncio.sleep(3600)

    async def __aenter__(self):
        return self

    async def __aexit__(self, *exc):
        return False


class FakeSessCol:
    """Minimal Motor-like collection backing exactly one session doc."""

    def __init__(self, doc):
        self.doc = dict(doc)

    async def find_one(self, query):
        if query.get("session_id") == self.doc.get("session_id"):
            return dict(self.doc)
        return None

    async def update_one(self, flt, upd):
        for k, v in (upd.get("$set") or {}).items():
            self.doc[k] = v

        class _R:
            matched_count = 1
        return _R()

    def _matches(self, key, cond):
        val = self.doc.get(key)
        if isinstance(cond, dict):
            if "$ne" in cond:
                return val != cond["$ne"]
            if "$nin" in cond:
                return val not in cond["$nin"]
            if "$lt" in cond:
                return val is not None and val < cond["$lt"]
            return True
        return val == cond

    async def find_one_and_update(self, flt, upd):
        """Small subset of Mongo's atomic claim semantics — enough for
        _finalize_session's finalize-lock claim (and _do_refund's refund
        lock claim, unused by this file's tests but kept general)."""
        for k, v in flt.items():
            if k == "$or":
                if not any(
                    all(self._matches(kk, vv) for kk, vv in clause.items())
                    for clause in v
                ):
                    return None
                continue
            if not self._matches(k, v):
                return None
        for k, v in (upd.get("$set") or {}).items():
            self.doc[k] = v
        return dict(self.doc)


class _NullColl:
    """Stands in for every OTHER collection register_edutalk_live_routes
    opens (config/report/usage/nudge-log) — none of them are exercised by
    the duplicate-connection guard itself."""

    async def find_one(self, *a, **k):
        return None

    async def update_one(self, *a, **k):
        class _R:
            matched_count = 0
            upserted_id = None
        return _R()

    async def insert_one(self, *a, **k):
        class _R:
            inserted_id = "x"
        return _R()


class FakeDB:
    def __init__(self, sess_doc):
        self._sess = FakeSessCol(sess_doc)
        self._null = _NullColl()

    def __getitem__(self, name):
        if name == "edutalk_live_sessions":
            return self._sess
        return self._null


SESSION_ID = "sid-dup-guard"
TOKEN = "tok-dup-guard"


def _session_doc(**over):
    doc = {
        "_id": "oid-" + SESSION_ID,
        "session_id": SESSION_ID,
        "ws_token": TOKEN,
        "state": "pending_reserved",
        "clean_id": "stu1",
        "display_name": "Sok Dara",
        "system_instruction": "SYSTEM INSTRUCTION.",
        "explain_language": "en",
        "greeting_context": {
            "student_first_name": "Sok", "points_value": 10,
            "points_source": "gas_verified_post_reservation",
            "book_title": "Book", "book_slug": "book",
            "chapter_title": "Ch 1", "mode": "book_shadow",
            "explain_language": "en", "teacher_persona_enabled": False,
            "teacher_display_name": "Teacher", "mention_teacher_in_greeting": False,
        },
    }
    doc.update(over)
    return doc


@pytest.fixture
def client(monkeypatch):
    monkeypatch.setattr(elt, "GEMINI_API_KEY", "fake-key-for-test")
    monkeypatch.setattr(elt, "_WS_LIB_OK", True)
    monkeypatch.setattr(elt, "_reward_mod", None)
    monkeypatch.setattr(elt, "_REWARD_MOD_OK", False)
    # Force the heuristic (non-Gemini) report path — no real network call.
    monkeypatch.setattr(elt, "_post_gemini", None)
    monkeypatch.setattr(
        elt, "_ws_lib", types.SimpleNamespace(connect=lambda uri, **kw: FakeGeminiWS())
    )
    monkeypatch.setattr(elt, "_GEMINI_SETUP_RETRY_DELAY_S", 0)
    # Guarantee test isolation regardless of ordering/failures in other tests.
    elt._active_ws_sessions.discard(SESSION_ID)

    db = FakeDB(_session_doc())
    app = FastAPI()
    api = APIRouter(prefix="/api")
    elt.register_edutalk_live_routes(api, db, lambda: None, lambda: None)
    app.include_router(api)
    tc = TestClient(app)
    tc.fake_sess_col = db._sess  # test-only handle to mutate the session doc directly
    yield tc
    elt._active_ws_sessions.discard(SESSION_ID)


def _url():
    return f"/api/student/edutalk-live/ws/{SESSION_ID}?token={TOKEN}"


def test_second_connection_to_an_already_bridged_session_is_rejected(client):
    with client.websocket_connect(_url()) as ws_a:
        # Wait for the bridge to actually be running (sent only once Gemini
        # setup completes, deep inside _run_live_bridge — guarantees the
        # guard's add() already happened, since that runs BEFORE
        # _run_live_bridge is even called).
        first = ws_a.receive_json()
        assert first["type"] == "ready"
        assert SESSION_ID in elt._active_ws_sessions

        # A second connection attempt for the SAME session_id must be
        # rejected — the ORIGINAL bridge (ws_a) must be completely
        # unaffected by the attempt.
        with client.websocket_connect(_url()) as ws_b:
            msg = ws_b.receive_json()
            assert msg == {"type": "error", "reason": "duplicate_connection"}

        # Original connection is still alive and usable after the rejected
        # duplicate attempt.
        ws_a.send_text(json.dumps({"type": "end", "reason": "client_end"}))


def test_guard_releases_the_session_id_after_the_original_connection_closes(client):
    with client.websocket_connect(_url()) as ws_a:
        assert ws_a.receive_json()["type"] == "ready"
        ws_a.send_text(json.dumps({"type": "end", "reason": "client_end"}))

    # The finally-block discard() must have run — session_id is free again.
    assert SESSION_ID not in elt._active_ws_sessions

    # A fresh connection for the SAME session_id (e.g. a legitimate retry)
    # is NOT rejected by the DUPLICATE-CONNECTION GUARD once the guard's
    # own bookkeeping is clear — isolated from the (separate, pre-existing,
    # unrelated) terminal-state auth check by resetting the fake session
    # doc back to "pending_reserved" first, exactly as it would be for a
    # brand-new reservation. This proves the guard never permanently locks
    # out a session_id once its bridge actually ends.
    client.fake_sess_col.doc["state"] = "pending_reserved"
    client.fake_sess_col.doc["finalized"] = False

    with client.websocket_connect(_url()) as ws_a2:
        assert ws_a2.receive_json()["type"] == "ready"
        ws_a2.send_text(json.dumps({"type": "end", "reason": "client_end"}))
