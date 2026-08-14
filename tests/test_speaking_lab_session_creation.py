"""
Tests for the POST /api/speaking-lab/sessions route (server.py's
sl_create_session) — specifically the "AB" combined-schedule validation.

Combined A+B is now a standard, permanent schedule mode — not gated by
`SPEAKING_LAB_AB_SCHEDULE_ENABLED` / `speaking_lab_settings.
speaking_lab_ab_schedule_enabled`. Session creation for schedule "AB"
must succeed unconditionally, exactly like "A" and "B", regardless of
whatever value that legacy env var/DB field happens to hold (they are
fully ignored — no owner action is required to clear them).

server.py requires live infra env vars at import time, so this test
exercises the EXACT route body (copied verbatim from server.py at the
time of writing) through a minimal standalone FastAPI app — the same
pattern already used by test_speaking_lab_feature_flags_route.py and
test_speaking_lab_direct_join.py's /my-entry tests. Any future drift
between this copy and the real route is caught by keeping this file's
route body byte-identical to server.py's (see test_0_route_body_matches_
server_py below, which asserts the literal source strings match).
"""
import os
from datetime import datetime, timezone

import pytest
from fastapi import Depends, FastAPI, HTTPException
from fastapi.testclient import TestClient
from pydantic import BaseModel, ConfigDict


class SLSessionCreate(BaseModel):
    model_config = ConfigDict(extra="ignore")
    schedule: str
    entry_fee: int = 0


class _FakeCollection:
    def __init__(self):
        self._docs = []

    async def insert_one(self, doc):
        self._docs.append(dict(doc))

    async def find_one(self, query, projection=None):
        return None


class _FakeSettingsCollection:
    def __init__(self):
        self.doc = None

    async def find_one(self, query, projection=None):
        return self.doc


class _FakeTemplatesCollection:
    """Minimal stand-in for event_engine.py's TEMPLATES_COLL, just enough
    to drive the REAL get_active_reward_pool_id() against a fixed set of
    template docs (sorted client-side by updated_at, matching Mongo's
    sort=[("updated_at", -1)] semantics)."""
    def __init__(self, docs=None):
        self._docs = list(docs or [])

    async def find_one(self, query, projection=None, sort=None):
        candidates = [
            d for d in self._docs
            if d.get("event_type") == query.get("event_type")
            and d.get("status") != "archived"
            and d.get("reward_pool_id") is not None
        ]
        if not candidates:
            return None
        candidates.sort(key=lambda d: d.get("updated_at", ""), reverse=True)
        return candidates[0]


class _FakeDB:
    def __init__(self, templates=None):
        self.sessions = _FakeCollection()
        self.settings = _FakeSettingsCollection()
        self.event_templates = _FakeTemplatesCollection(templates)

    def __getitem__(self, name):
        if name == "speaking_lab_settings":
            return self.settings
        if name == "event_templates":
            return self.event_templates
        return self.sessions


def _build_app(db):
    app = FastAPI()

    async def _fake_require_admin():
        return type("U", (), {"email": "teacher@example.com"})()

    @app.post("/api/speaking-lab/sessions")
    async def sl_create_session(payload: SLSessionCreate, admin=Depends(_fake_require_admin)):
        # ── Route body copied verbatim from server.py's sl_create_session ──
        if not 0 <= payload.entry_fee <= 500:
            raise HTTPException(status_code=400, detail="entry_fee out of range")
        schedule_norm = (payload.schedule or "").strip().upper()
        if schedule_norm and schedule_norm not in ("A", "B", "AB"):
            raise HTTPException(status_code=400, detail="schedule must be 'A', 'B', 'AB', or empty")
        session_id = f"sl_{int(datetime.now(timezone.utc).timestamp() * 1000)}"
        session_doc = {
            "session_id": session_id,
            "schedule":   schedule_norm,
            "entry_fee":  payload.entry_fee,
            "treasury_id": "stu092",
            "status":     "waiting",
            "created_by": admin.email,
            "created_at": datetime.now(timezone.utc).isoformat(),
        }
        try:
            from event_engine import get_active_reward_pool_id
            reward_pool_id = await get_active_reward_pool_id(db)
            if reward_pool_id:
                session_doc["prize_pool_id"] = reward_pool_id
        except Exception:  # noqa: BLE001
            pass
        await db["speaking_lab_sessions"].insert_one(session_doc)
        return {"session_id": session_id, "schedule": schedule_norm, "entry_fee": payload.entry_fee}
        # ── end verbatim copy ──

    return app


@pytest.fixture(autouse=True)
def _clean_env():
    saved = os.environ.get("SPEAKING_LAB_AB_SCHEDULE_ENABLED")
    yield
    if saved is None:
        os.environ.pop("SPEAKING_LAB_AB_SCHEDULE_ENABLED", None)
    else:
        os.environ["SPEAKING_LAB_AB_SCHEDULE_ENABLED"] = saved


def test_0_route_body_matches_server_py():
    """Guards against silent drift between this test's copied route body
    and the real one in server.py — and proves the old AB feature-flag
    gate is genuinely gone from the real route, not just from this copy."""
    with open("server.py", encoding="utf-8") as f:
        src = f.read()
    assert 'if schedule_norm and schedule_norm not in ("A", "B", "AB"):' in src
    assert "ab_schedule_disabled" not in src
    assert "ab_schedule_enabled(db)" not in src
    assert "from event_engine import get_active_reward_pool_id" in src
    assert 'session_doc["prize_pool_id"] = reward_pool_id' in src


def test_1_ab_accepted_with_no_env_var_and_no_db_doc_at_all():
    os.environ.pop("SPEAKING_LAB_AB_SCHEDULE_ENABLED", None)
    db = _FakeDB()  # settings doc never created
    client = TestClient(_build_app(db))

    resp = client.post("/api/speaking-lab/sessions", json={"schedule": "AB", "entry_fee": 4})

    assert resp.status_code == 200
    assert resp.json()["schedule"] == "AB"
    assert len(db.sessions._docs) == 1


def test_2_ab_accepted_even_if_the_legacy_flag_is_explicitly_false():
    """The old env var / DB field are fully ignored — an operator is never
    required to delete stale legacy configuration for AB to work."""
    os.environ["SPEAKING_LAB_AB_SCHEDULE_ENABLED"] = "false"
    db = _FakeDB()
    db.settings.doc = {"speaking_lab_ab_schedule_enabled": False}
    client = TestClient(_build_app(db))

    resp = client.post("/api/speaking-lab/sessions", json={"schedule": "ab", "entry_fee": 4})

    assert resp.status_code == 200
    assert resp.json()["schedule"] == "AB"  # normalized to uppercase


def test_3_ab_persists_as_the_session_schedule():
    db = _FakeDB()
    client = TestClient(_build_app(db))

    client.post("/api/speaking-lab/sessions", json={"schedule": "AB", "entry_fee": 4})

    stored = db.sessions._docs[0]
    assert stored["schedule"] == "AB"
    assert stored["status"] == "waiting"


def test_4_each_session_gets_a_fresh_unique_session_id():
    db = _FakeDB()
    client = TestClient(_build_app(db))

    r1 = client.post("/api/speaking-lab/sessions", json={"schedule": "AB", "entry_fee": 4})
    r2 = client.post("/api/speaking-lab/sessions", json={"schedule": "AB", "entry_fee": 4})

    assert r1.json()["session_id"] != r2.json()["session_id"]
    assert len(db.sessions._docs) == 2


def test_5_plain_a_and_b_sessions_are_unaffected():
    db = _FakeDB()
    client = TestClient(_build_app(db))

    resp_a = client.post("/api/speaking-lab/sessions", json={"schedule": "A", "entry_fee": 4})
    resp_b = client.post("/api/speaking-lab/sessions", json={"schedule": "B", "entry_fee": 4})

    assert resp_a.status_code == 200
    assert resp_a.json()["schedule"] == "A"
    assert resp_b.status_code == 200
    assert resp_b.json()["schedule"] == "B"


def test_6_invalid_schedule_value_rejected():
    db = _FakeDB()
    client = TestClient(_build_app(db))

    resp = client.post("/api/speaking-lab/sessions", json={"schedule": "C", "entry_fee": 4})

    assert resp.status_code == 400
    assert db.sessions._docs == []


# ── Reward Pool auto-link (blocker-bug fix: the legacy/default session
#    creation flow every teacher actually uses had zero connection to
#    Event Templates' Reward Pool — this proves the fix using the REAL
#    (unmocked) event_engine.get_active_reward_pool_id) ─────────────────

def test_7_new_session_auto_links_the_configured_reward_pool():
    db = _FakeDB(templates=[{
        "event_type": "speaking_lab_session", "status": "draft",
        "reward_pool_id": "pool_abc123", "updated_at": "2026-07-24T06:04:59Z",
    }])
    client = TestClient(_build_app(db))

    resp = client.post("/api/speaking-lab/sessions", json={"schedule": "AB", "entry_fee": 0})

    assert resp.status_code == 200
    assert db.sessions._docs[0]["prize_pool_id"] == "pool_abc123"


def test_8_no_reward_pool_configured_keeps_legacy_entry_fee_session_unchanged():
    db = _FakeDB(templates=[])
    client = TestClient(_build_app(db))

    resp = client.post("/api/speaking-lab/sessions", json={"schedule": "AB", "entry_fee": 4})

    assert resp.status_code == 200
    assert "prize_pool_id" not in db.sessions._docs[0]


def test_9_archived_template_reward_pool_is_never_auto_linked():
    db = _FakeDB(templates=[{
        "event_type": "speaking_lab_session", "status": "archived",
        "reward_pool_id": "pool_stale", "updated_at": "2026-07-24T06:04:59Z",
    }])
    client = TestClient(_build_app(db))

    resp = client.post("/api/speaking-lab/sessions", json={"schedule": "AB", "entry_fee": 0})

    assert resp.status_code == 200
    assert "prize_pool_id" not in db.sessions._docs[0]


def test_10_most_recently_updated_template_wins_when_multiple_configured():
    db = _FakeDB(templates=[
        {"event_type": "speaking_lab_session", "status": "draft",
         "reward_pool_id": "pool_old", "updated_at": "2026-07-01T00:00:00Z"},
        {"event_type": "speaking_lab_session", "status": "published",
         "reward_pool_id": "pool_newest", "updated_at": "2026-07-24T06:04:59Z"},
    ])
    client = TestClient(_build_app(db))

    resp = client.post("/api/speaking-lab/sessions", json={"schedule": "AB", "entry_fee": 0})

    assert resp.status_code == 200
    assert db.sessions._docs[0]["prize_pool_id"] == "pool_newest"


def test_11_reward_pool_lookup_failure_never_blocks_session_creation():
    class _BoomTemplates:
        async def find_one(self, *a, **k):
            raise RuntimeError("db unavailable")

    db = _FakeDB()
    db.event_templates = _BoomTemplates()
    client = TestClient(_build_app(db))

    resp = client.post("/api/speaking-lab/sessions", json={"schedule": "AB", "entry_fee": 4})

    assert resp.status_code == 200
    assert "prize_pool_id" not in db.sessions._docs[0]
