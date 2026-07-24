"""tests/test_experience_config_admin_crud.py — Phase 3 coverage for the
Experience Configuration Platform's admin management surface (Author
Studio's "Welcome Experience Studio" backs onto these routes):

  GET/POST   /experience-configs
  GET/PUT    /experience-configs/{id}
  POST       /experience-configs/{id}/publish
  POST       /experience-configs/{id}/unpublish
  POST       /experience-configs/{id}/duplicate
  DELETE     /experience-configs/{id}

Covers: admin gating, draft/published lifecycle transitions, version bump
on update, (experienceType,key) uniqueness on create/duplicate, and the
published-delete-requires-force safety guard. Also proves the Phase 1
public /active route and these Phase 3 admin routes agree with each
other (publish here -> visible there; unpublish here -> invisible there).

No live MongoDB — self-contained fake collection, following the
established in-process fake pattern (test_notification_center_ws_auth.py)
and the require_admin-as-injected-dependency pattern
(tests/test_schedule_assignment.py:58-78).
"""
from __future__ import annotations

from types import SimpleNamespace

from fastapi import APIRouter, FastAPI, HTTPException
from fastapi.testclient import TestClient

import experience_config_tools as ect


class _Cursor:
    def __init__(self, docs):
        self._docs = list(docs)

    def sort(self, spec):
        for field, direction in reversed(spec):
            self._docs.sort(key=lambda d: d.get(field) or 0, reverse=(direction == -1))
        return self

    async def to_list(self, length=None):
        return list(self._docs)

    def __aiter__(self):
        self._i = 0
        return self

    async def __anext__(self):
        if self._i >= len(self._docs):
            raise StopAsyncIteration
        d = self._docs[self._i]
        self._i += 1
        return d


class _Coll:
    def __init__(self, docs=None):
        self._docs = list(docs or [])

    def find(self, q=None, projection=None):
        q = q or {}
        return _Cursor([d for d in self._docs if all(d.get(k) == v for k, v in q.items())])

    async def find_one(self, q):
        q = q or {}
        for d in self._docs:
            if all(d.get(k) == v for k, v in q.items()):
                return dict(d)
        return None

    async def insert_one(self, doc):
        self._docs.append(dict(doc))
        return SimpleNamespace(inserted_id=doc.get("id"))

    async def update_one(self, q, update):
        for i, d in enumerate(self._docs):
            if all(d.get(k) == v for k, v in q.items()):
                self._docs[i] = {**d, **update.get("$set", {})}
                return SimpleNamespace(matched_count=1)
        return SimpleNamespace(matched_count=0)

    async def delete_one(self, q):
        before = len(self._docs)
        self._docs = [d for d in self._docs if not all(d.get(k) == v for k, v in q.items())]
        return SimpleNamespace(deleted_count=before - len(self._docs))

    async def create_index(self, *a, **k):
        return "idx"


class _FakeDB:
    def __init__(self, docs=None):
        self.experience_configs = _Coll(docs)

    def __getitem__(self, name):
        return getattr(self, name)


class _Admin:
    email = "admin@school.example"


async def _allow_admin():
    return _Admin()


async def _deny_admin():
    raise HTTPException(status_code=401, detail="Not authenticated")


def _make_client(docs=None, require_admin=_allow_admin):
    db = _FakeDB(docs)
    app = FastAPI()
    api = APIRouter(prefix="/api")
    ect.register_experience_config_routes(api, app, db, require_admin)
    app.include_router(api)
    return TestClient(app), db


# ── admin gating ────────────────────────────────────────────────────────────

def test_list_requires_admin():
    client, _ = _make_client(require_admin=_deny_admin)
    resp = client.get("/api/experience-configs")
    assert resp.status_code == 401


def test_create_requires_admin():
    client, _ = _make_client(require_admin=_deny_admin)
    resp = client.post("/api/experience-configs", json={"experienceType": "welcome_dashboard"})
    assert resp.status_code == 401


def test_delete_requires_admin():
    client, _ = _make_client(require_admin=_deny_admin)
    resp = client.delete("/api/experience-configs/whatever")
    assert resp.status_code == 401


# ── auto_publish_experience_config (system-authored, e.g. event_engine.py's
#    automatic Winner Showcase) ───────────────────────────────────────────
import asyncio


def test_auto_publish_creates_and_publishes_a_new_config():
    db = _FakeDB()
    doc = asyncio.run(ect.auto_publish_experience_config(
        db, experience_type="winner_showcase", key="evt_1",
        content={"champion": {"student_id": "stu1"}}, created_by="event_engine:teacher@test",
    ))
    assert doc["status"] == "published"
    assert doc["experienceType"] == "winner_showcase"
    assert doc["key"] == "evt_1"
    assert doc["content"]["champion"]["student_id"] == "stu1"
    assert doc["version"] == 1
    assert doc["createdBy"] == "event_engine:teacher@test"


def test_auto_publish_is_idempotent_per_key_and_bumps_version():
    db = _FakeDB()
    first = asyncio.run(ect.auto_publish_experience_config(
        db, experience_type="winner_showcase", key="evt_1", content={"champion": "A"},
    ))
    second = asyncio.run(ect.auto_publish_experience_config(
        db, experience_type="winner_showcase", key="evt_1", content={"champion": "B"},
    ))
    assert second["id"] == first["id"]
    assert second["version"] == 2
    assert second["content"]["champion"] == "B"
    assert second["status"] == "published"


def test_auto_publish_is_visible_through_the_public_active_route():
    client, db = _make_client()
    asyncio.run(ect.auto_publish_experience_config(
        db, experience_type="winner_showcase", key="evt_1", content={"champion": "A"},
    ))
    resp = client.get("/api/experience-configs/active?type=winner_showcase")
    assert resp.status_code == 200
    assert resp.json()["config"]["content"]["champion"] == "A"


def test_auto_publish_respects_custom_active_window():
    client, db = _make_client()
    past = "2020-01-01T00:00:00+00:00"
    asyncio.run(ect.auto_publish_experience_config(
        db, experience_type="winner_showcase", key="evt_expired", content={"champion": "Old"},
        active_window={"startsAt": None, "endsAt": past, "recurringAnnual": False},
    ))
    resp = client.get("/api/experience-configs/active?type=winner_showcase")
    assert resp.json()["config"] is None  # past its own endsAt -> not active


def test_active_list_route_returns_every_currently_active_instance():
    client, db = _make_client()
    asyncio.run(ect.auto_publish_experience_config(
        db, experience_type="winner_showcase", key="evt_1", content={"champion": "A"},
    ))
    asyncio.run(ect.auto_publish_experience_config(
        db, experience_type="winner_showcase", key="evt_2", content={"champion": "B"},
    ))
    past = "2020-01-01T00:00:00+00:00"
    asyncio.run(ect.auto_publish_experience_config(
        db, experience_type="winner_showcase", key="evt_expired", content={"champion": "Old"},
        active_window={"startsAt": None, "endsAt": past, "recurringAnnual": False},
    ))
    resp = client.get("/api/experience-configs/active-list?type=winner_showcase")
    assert resp.status_code == 200
    champions = {c["content"]["champion"] for c in resp.json()["configs"]}
    assert champions == {"A", "B"}  # the expired one is excluded


def test_active_list_route_returns_empty_list_when_nothing_published():
    client, _ = _make_client()
    resp = client.get("/api/experience-configs/active-list?type=winner_showcase")
    assert resp.status_code == 200
    assert resp.json()["configs"] == []


def test_active_list_falls_back_to_latest_when_all_have_expired():
    """No gap: if every published winner_showcase's activeWindow has
    lapsed (e.g. a slower-than-usual week between Speaking Lab sessions),
    the PWA must still see the most recent one rather than a blank list —
    replacement only happens when something NEWER is published, never
    purely from a timer."""
    client, db = _make_client()
    older_past = "2020-01-01T00:00:00+00:00"
    newer_past = "2021-06-15T00:00:00+00:00"
    asyncio.run(ect.auto_publish_experience_config(
        db, experience_type="winner_showcase", key="evt_older", content={"champion": "Older"},
        active_window={"startsAt": None, "endsAt": older_past, "recurringAnnual": False},
    ))
    asyncio.run(ect.auto_publish_experience_config(
        db, experience_type="winner_showcase", key="evt_newer", content={"champion": "Newer"},
        active_window={"startsAt": None, "endsAt": newer_past, "recurringAnnual": False},
    ))

    resp = client.get("/api/experience-configs/active-list?type=winner_showcase")

    assert resp.status_code == 200
    configs = resp.json()["configs"]
    assert len(configs) == 1
    assert configs[0]["content"]["champion"] == "Newer"


def test_active_list_prefers_currently_active_over_the_expired_fallback():
    """The fallback only kicks in when NOTHING is currently active — a
    genuinely active showcase must never be shadowed by an older expired
    one, and the newest active one wins."""
    client, db = _make_client()
    past = "2020-01-01T00:00:00+00:00"
    asyncio.run(ect.auto_publish_experience_config(
        db, experience_type="winner_showcase", key="evt_expired", content={"champion": "Old"},
        active_window={"startsAt": None, "endsAt": past, "recurringAnnual": False},
    ))
    asyncio.run(ect.auto_publish_experience_config(
        db, experience_type="winner_showcase", key="evt_live", content={"champion": "Current"},
    ))

    resp = client.get("/api/experience-configs/active-list?type=winner_showcase")

    assert resp.status_code == 200
    configs = resp.json()["configs"]
    assert len(configs) == 1
    assert configs[0]["content"]["champion"] == "Current"


# ── create ───────────────────────────────────────────────────────────────

def test_create_draft_config():
    client, _ = _make_client()
    resp = client.post(
        "/api/experience-configs",
        json={"experienceType": "welcome_dashboard", "content": {"title": "Hi"}},
    )
    assert resp.status_code == 200
    cfg = resp.json()["config"]
    assert cfg["status"] == "draft"
    assert cfg["version"] == 1
    assert cfg["content"]["title"] == "Hi"
    assert cfg["key"] == "default"
    assert cfg["createdBy"] == "admin@school.example"
    assert cfg["id"]


def test_create_requires_experience_type():
    client, _ = _make_client()
    resp = client.post("/api/experience-configs", json={"content": {"title": "Hi"}})
    assert resp.status_code == 400


def test_create_duplicate_key_conflicts():
    client, _ = _make_client()
    payload = {"experienceType": "welcome_dashboard", "key": "seasonal"}
    r1 = client.post("/api/experience-configs", json=payload)
    assert r1.status_code == 200
    r2 = client.post("/api/experience-configs", json=payload)
    assert r2.status_code == 409


# ── list / get ───────────────────────────────────────────────────────────

def test_list_includes_drafts_unlike_the_public_active_route():
    client, _ = _make_client()
    client.post("/api/experience-configs", json={"experienceType": "welcome_dashboard"})
    resp = client.get("/api/experience-configs")
    assert resp.status_code == 200
    configs = resp.json()["configs"]
    assert len(configs) == 1
    assert configs[0]["status"] == "draft"


def test_list_filters_by_type():
    client, _ = _make_client()
    client.post("/api/experience-configs", json={"experienceType": "welcome_dashboard"})
    client.post("/api/experience-configs", json={"experienceType": "digital_books_hero"})
    resp = client.get("/api/experience-configs?type=digital_books_hero")
    configs = resp.json()["configs"]
    assert len(configs) == 1
    assert configs[0]["experienceType"] == "digital_books_hero"


def test_get_by_id():
    client, _ = _make_client()
    created = client.post("/api/experience-configs", json={"experienceType": "welcome_dashboard"}).json()["config"]
    resp = client.get(f"/api/experience-configs/{created['id']}")
    assert resp.status_code == 200
    assert resp.json()["config"]["id"] == created["id"]


def test_get_missing_id_is_404():
    client, _ = _make_client()
    resp = client.get("/api/experience-configs/does-not-exist")
    assert resp.status_code == 404


# ── update ───────────────────────────────────────────────────────────────

def test_update_bumps_version_and_preserves_status():
    client, _ = _make_client()
    created = client.post("/api/experience-configs", json={"experienceType": "welcome_dashboard"}).json()["config"]
    resp = client.put(
        f"/api/experience-configs/{created['id']}",
        json={"content": {"title": "Updated"}},
    )
    assert resp.status_code == 200
    cfg = resp.json()["config"]
    assert cfg["version"] == 2
    assert cfg["content"]["title"] == "Updated"
    assert cfg["status"] == "draft"  # update never touches status


def test_update_missing_id_is_404():
    client, _ = _make_client()
    resp = client.put("/api/experience-configs/nope", json={"content": {}})
    assert resp.status_code == 404


# ── publish / unpublish lifecycle, cross-checked against the public route ──

def test_publish_makes_config_visible_on_public_active_route():
    client, _ = _make_client()
    created = client.post(
        "/api/experience-configs",
        json={"experienceType": "welcome_dashboard", "content": {"title": "Live now"}},
    ).json()["config"]

    before = client.get("/api/experience-configs/active?type=welcome_dashboard")
    assert before.json() == {"config": None}

    pub = client.post(f"/api/experience-configs/{created['id']}/publish")
    assert pub.status_code == 200
    assert pub.json()["config"]["status"] == "published"

    after = client.get("/api/experience-configs/active?type=welcome_dashboard")
    assert after.json()["config"]["content"]["title"] == "Live now"


def test_unpublish_removes_config_from_public_active_route():
    client, _ = _make_client()
    created = client.post("/api/experience-configs", json={"experienceType": "welcome_dashboard"}).json()["config"]
    client.post(f"/api/experience-configs/{created['id']}/publish")

    unpub = client.post(f"/api/experience-configs/{created['id']}/unpublish")
    assert unpub.status_code == 200
    assert unpub.json()["config"]["status"] == "draft"

    after = client.get("/api/experience-configs/active?type=welcome_dashboard")
    assert after.json() == {"config": None}


# ── duplicate ────────────────────────────────────────────────────────────

def test_duplicate_creates_new_draft_with_new_id_and_copied_content():
    client, _ = _make_client()
    created = client.post(
        "/api/experience-configs",
        json={"experienceType": "welcome_dashboard", "content": {"title": "Original"}},
    ).json()["config"]
    client.post(f"/api/experience-configs/{created['id']}/publish")

    dup = client.post(f"/api/experience-configs/{created['id']}/duplicate")
    assert dup.status_code == 200
    clone = dup.json()["config"]
    assert clone["id"] != created["id"]
    assert clone["status"] == "draft"  # duplicating a published config never auto-publishes the clone
    assert clone["version"] == 1
    assert clone["content"]["title"] == "Original"
    assert clone["key"] != created["key"]  # auto-suffixed to avoid the unique-key conflict


def test_duplicate_with_explicit_conflicting_key_is_rejected():
    client, _ = _make_client()
    created = client.post(
        "/api/experience-configs",
        json={"experienceType": "welcome_dashboard", "key": "default"},
    ).json()["config"]
    resp = client.post(f"/api/experience-configs/{created['id']}/duplicate", json={"key": "default"})
    assert resp.status_code == 409


# ── delete ───────────────────────────────────────────────────────────────

def test_delete_draft_succeeds():
    client, _ = _make_client()
    created = client.post("/api/experience-configs", json={"experienceType": "welcome_dashboard"}).json()["config"]
    resp = client.delete(f"/api/experience-configs/{created['id']}")
    assert resp.status_code == 200
    assert client.get(f"/api/experience-configs/{created['id']}").status_code == 404


def test_delete_published_without_force_is_rejected():
    client, _ = _make_client()
    created = client.post("/api/experience-configs", json={"experienceType": "welcome_dashboard"}).json()["config"]
    client.post(f"/api/experience-configs/{created['id']}/publish")
    resp = client.delete(f"/api/experience-configs/{created['id']}")
    assert resp.status_code == 409


def test_delete_published_with_force_succeeds():
    client, _ = _make_client()
    created = client.post("/api/experience-configs", json={"experienceType": "welcome_dashboard"}).json()["config"]
    client.post(f"/api/experience-configs/{created['id']}/publish")
    resp = client.delete(f"/api/experience-configs/{created['id']}?force=true")
    assert resp.status_code == 200


# ── Phase 1 compatibility: omitting require_admin keeps read-only behavior ─

def test_admin_routes_absent_when_require_admin_omitted():
    """The public /active route must keep working with zero admin wiring —
    this is what protects any caller still using the Phase 1 3-arg call
    signature (register_experience_config_routes(api, app, db))."""
    db = _FakeDB()
    app = FastAPI()
    api = APIRouter(prefix="/api")
    ect.register_experience_config_routes(api, app, db)  # no require_admin
    app.include_router(api)
    client = TestClient(app)

    resp = client.get("/api/experience-configs/active?type=welcome_dashboard")
    assert resp.status_code == 200
    assert resp.json() == {"config": None}

    # The admin list route was never registered at all.
    resp2 = client.get("/api/experience-configs")
    assert resp2.status_code == 404
