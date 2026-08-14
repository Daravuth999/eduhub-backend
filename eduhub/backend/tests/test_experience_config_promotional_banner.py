"""tests/test_experience_config_promotional_banner.py — Promotion
Experience Studio directive (Phase 1-5).

The Phase 0 architecture audit's headline finding was that
`KNOWN_EXPERIENCE_TYPES` already reserves `"promotional_banner"` and that
the generic Experience Configuration Platform needs ZERO backend schema
changes to support it — `experienceType` is stored as a plain string, never
validated against an enum. This file proves that claim with the exact same
generic CRUD/lifecycle routes every other experience type (welcome_dashboard,
achievement_top_earner) already uses, rather than assuming it.

No live MongoDB — same in-process fake collection pattern as
test_experience_config_admin_crud.py.
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


def _make_client(docs=None):
    db = _FakeDB(docs)
    app = FastAPI()
    api = APIRouter(prefix="/api")
    ect.register_experience_config_routes(api, app, db, _allow_admin)
    app.include_router(api)
    return TestClient(app), db


def test_promotional_banner_is_a_documented_known_type():
    assert "promotional_banner" in ect.KNOWN_EXPERIENCE_TYPES


def test_create_draft_promotional_banner_config():
    client, _ = _make_client()
    resp = client.post(
        "/api/experience-configs",
        json={
            "experienceType": "promotional_banner",
            "content": {"visible": True, "textLayers": [{"id": "l1", "role": "headline", "content": "Back to School"}]},
            "appearance": {"syncMode": "followTheme"},
        },
    )
    assert resp.status_code == 200
    cfg = resp.json()["config"]
    assert cfg["experienceType"] == "promotional_banner"
    assert cfg["status"] == "draft"
    assert cfg["version"] == 1
    assert cfg["content"]["textLayers"][0]["content"] == "Back to School"


def test_draft_promotional_banner_is_not_publicly_active():
    client, _ = _make_client()
    client.post("/api/experience-configs", json={"experienceType": "promotional_banner"})
    resp = client.get("/api/experience-configs/active", params={"type": "promotional_banner"})
    assert resp.status_code == 200
    assert resp.json()["config"] is None


def test_publish_makes_promotional_banner_publicly_active():
    client, _ = _make_client()
    create = client.post("/api/experience-configs", json={"experienceType": "promotional_banner"})
    config_id = create.json()["config"]["id"]

    publish = client.post(f"/api/experience-configs/{config_id}/publish")
    assert publish.status_code == 200
    assert publish.json()["config"]["status"] == "published"

    active = client.get("/api/experience-configs/active", params={"type": "promotional_banner"})
    assert active.status_code == 200
    assert active.json()["config"]["id"] == config_id


def test_unpublish_removes_it_from_the_public_active_route():
    client, _ = _make_client()
    create = client.post("/api/experience-configs", json={"experienceType": "promotional_banner"})
    config_id = create.json()["config"]["id"]
    client.post(f"/api/experience-configs/{config_id}/publish")

    client.post(f"/api/experience-configs/{config_id}/unpublish")
    active = client.get("/api/experience-configs/active", params={"type": "promotional_banner"})
    assert active.json()["config"] is None


def test_duplicate_promotional_banner_clones_as_a_new_draft():
    client, _ = _make_client()
    create = client.post(
        "/api/experience-configs",
        json={"experienceType": "promotional_banner", "key": "seasonal", "content": {"visible": True}},
    )
    config_id = create.json()["config"]["id"]
    client.post(f"/api/experience-configs/{config_id}/publish")

    dup = client.post(f"/api/experience-configs/{config_id}/duplicate")
    assert dup.status_code == 200
    dup_cfg = dup.json()["config"]
    assert dup_cfg["id"] != config_id
    assert dup_cfg["status"] == "draft"
    assert dup_cfg["experienceType"] == "promotional_banner"


def test_promotional_banner_and_welcome_dashboard_configs_never_leak_across_types():
    client, _ = _make_client()
    client.post("/api/experience-configs", json={"experienceType": "promotional_banner"})
    client.post("/api/experience-configs", json={"experienceType": "welcome_dashboard"})

    resp = client.get("/api/experience-configs", params={"type": "promotional_banner"})
    configs = resp.json()["configs"]
    assert len(configs) == 1
    assert configs[0]["experienceType"] == "promotional_banner"


def test_recurring_annual_scheduling_works_for_promotional_banner_unmodified():
    """The recurringAnnual field (added this repo's session for Achievement)
    is generic over experienceType — proves it round-trips for Promotion
    too with zero additional backend code."""
    client, _ = _make_client()
    create = client.post(
        "/api/experience-configs",
        json={
            "experienceType": "promotional_banner",
            "activeWindow": {"startsAt": "2026-12-20T00:00:00Z", "endsAt": "2027-01-05T00:00:00Z", "recurringAnnual": True},
        },
    )
    cfg = create.json()["config"]
    assert cfg["activeWindow"]["recurringAnnual"] is True
