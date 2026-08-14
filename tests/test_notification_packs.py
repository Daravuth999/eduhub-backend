"""tests/test_notification_packs.py
=====================================================
Notification Packs (architecture.md continuation: "Notification Packs
UI (push/event/reminder/reward templates)"). Covers notification_packs
.py's pure functions (CRUD/lifecycle, template rendering) against an
in-memory fake Mongo, plus the HTTP routes via a real APIRouter +
FastAPI + TestClient (matching the test_question_bank.py pattern
already established in this codebase).
"""
from __future__ import annotations

import pytest
from fastapi import APIRouter, FastAPI
from fastapi.testclient import TestClient

import notification_packs as npk


# ── fake Mongo (same shape as test_question_bank.py's _Coll/_Cursor) ────
class _Cursor:
    def __init__(self, docs):
        self._docs = list(docs)

    def sort(self, key, direction=None):
        self._docs = sorted(self._docs, key=lambda d: d.get(key) or "", reverse=True)
        return self

    def __aiter__(self):
        self._it = iter(self._docs)
        return self

    async def __anext__(self):
        try:
            return next(self._it)
        except StopIteration:
            raise StopAsyncIteration


class _Result:
    def __init__(self, **kw):
        for k, v in kw.items():
            setattr(self, k, v)


class _Coll:
    def __init__(self):
        self.docs: dict[str, dict] = {}

    async def insert_one(self, doc):
        self.docs[doc["_id"]] = dict(doc)
        return _Result(inserted_id=doc["_id"])

    async def find_one(self, query, projection=None):
        _id = query.get("_id")
        if _id is not None:
            doc = self.docs.get(_id)
            return dict(doc) if doc else None
        for d in self.docs.values():
            if all(d.get(k) == v for k, v in query.items()):
                return dict(d)
        return None

    async def update_one(self, query, update):
        _id = query.get("_id")
        target = self.docs.get(_id)
        if target is None:
            return _Result(matched_count=0)
        if "$set" in update:
            target.update(update["$set"])
        return _Result(matched_count=1)

    async def delete_one(self, query):
        _id = query.get("_id")
        if _id in self.docs:
            del self.docs[_id]
            return _Result(deleted_count=1)
        return _Result(deleted_count=0)

    def find(self, query=None, projection=None):
        query = query or {}
        return _Cursor([d for d in self.docs.values() if all(d.get(k) == v for k, v in query.items())])

    async def create_index(self, *a, **k):
        return None


class _FakeDB:
    def __init__(self):
        self.packs = _Coll()

    def __getitem__(self, name):
        assert name == npk.PACKS_COLL
        return self.packs


# ═════════════════════════════════════════════════════════════════════════
# Template rendering
# ═════════════════════════════════════════════════════════════════════════
def test_render_template_substitutes_known_placeholders():
    result = npk.render_template("Hi {studentName}, you got {points} points!", {"studentName": "Sok", "points": 50})
    assert result == "Hi Sok, you got 50 points!"


def test_render_template_leaves_unknown_placeholders_literal():
    result = npk.render_template("Hi {studentName}, from {source}!", {"studentName": "Sok"})
    assert result == "Hi Sok, from {source}!"


def test_render_pack_resolves_all_three_fields():
    pack = {
        "title_template": "Hi {studentName}!",
        "body_template": "You won {points} points.",
        "url_template": "/portal/{eventId}",
    }
    result = npk.render_pack(pack, {"studentName": "Sok", "points": 50, "eventId": "evt_1"})
    assert result == {"title": "Hi Sok!", "body": "You won 50 points.", "url": "/portal/evt_1"}


def test_render_pack_defaults_url_to_portal():
    pack = {"title_template": "Hi", "body_template": "Body", "url_template": ""}
    result = npk.render_pack(pack)
    assert result["url"] == "/portal"


# ═════════════════════════════════════════════════════════════════════════
# CRUD + lifecycle
# ═════════════════════════════════════════════════════════════════════════
@pytest.mark.asyncio
async def test_create_pack_defaults_to_draft():
    db = _FakeDB()
    pack = await npk.create_pack(
        db, name="Mystery Box Win", pack_type="reward",
        title_template="You won!", body_template="You got {points} points.",
        created_by="a",
    )
    assert pack["status"] == "draft"
    assert pack["version"] == 1
    assert pack["type"] == "reward"


@pytest.mark.asyncio
async def test_create_pack_rejects_invalid_type():
    db = _FakeDB()
    with pytest.raises(npk.NotificationPackError) as exc:
        await npk.create_pack(
            db, name="X", pack_type="banner", title_template="T", body_template="B", created_by="a",
        )
    assert exc.value.code == "invalid_type"


@pytest.mark.asyncio
async def test_create_pack_rejects_empty_name_or_templates():
    db = _FakeDB()
    with pytest.raises(npk.NotificationPackError) as exc:
        await npk.create_pack(db, name="  ", pack_type="push", title_template="T", body_template="B", created_by="a")
    assert exc.value.code == "invalid_name"

    with pytest.raises(npk.NotificationPackError) as exc:
        await npk.create_pack(db, name="X", pack_type="push", title_template="", body_template="B", created_by="a")
    assert exc.value.code == "invalid_title_template"

    with pytest.raises(npk.NotificationPackError) as exc:
        await npk.create_pack(db, name="X", pack_type="push", title_template="T", body_template="  ", created_by="a")
    assert exc.value.code == "invalid_body_template"


@pytest.mark.asyncio
async def test_update_pack_only_while_draft():
    db = _FakeDB()
    pack = await npk.create_pack(db, name="A", pack_type="push", title_template="T", body_template="B", created_by="a")
    updated = await npk.update_pack(db, pack["_id"], {"body_template": "New body"}, updated_by="a")
    assert updated["body_template"] == "New body"
    assert updated["version"] == 2

    await npk.publish_pack(db, pack["_id"], updated_by="a")
    with pytest.raises(npk.NotificationPackError) as exc:
        await npk.update_pack(db, pack["_id"], {"body_template": "X"}, updated_by="a")
    assert exc.value.code == "pack_not_editable"


@pytest.mark.asyncio
async def test_publish_unpublish_archive_lifecycle():
    db = _FakeDB()
    pack = await npk.create_pack(db, name="A", pack_type="event", title_template="T", body_template="B", created_by="a")
    published = await npk.publish_pack(db, pack["_id"], updated_by="a")
    assert published["status"] == "published"
    assert published["published_at"] is not None

    reverted = await npk.unpublish_pack(db, pack["_id"], updated_by="a")
    assert reverted["status"] == "draft"

    archived = await npk.archive_pack(db, pack["_id"], updated_by="a")
    assert archived["status"] == "archived"

    with pytest.raises(npk.NotificationPackError) as exc:
        await npk.publish_pack(db, pack["_id"], updated_by="a")
    assert exc.value.code == "pack_archived"


@pytest.mark.asyncio
async def test_delete_blocked_while_published():
    db = _FakeDB()
    pack = await npk.create_pack(db, name="A", pack_type="reminder", title_template="T", body_template="B", created_by="a")
    await npk.publish_pack(db, pack["_id"], updated_by="a")
    with pytest.raises(npk.NotificationPackError) as exc:
        await npk.delete_pack(db, pack["_id"])
    assert exc.value.code == "pack_published"

    await npk.unpublish_pack(db, pack["_id"], updated_by="a")
    deleted = await npk.delete_pack(db, pack["_id"])
    assert deleted is True
    assert await npk.get_pack(db, pack["_id"]) is None


@pytest.mark.asyncio
async def test_list_packs_filters_by_type_and_status():
    db = _FakeDB()
    p1 = await npk.create_pack(db, name="A", pack_type="push", title_template="T", body_template="B", created_by="a")
    p2 = await npk.create_pack(db, name="B", pack_type="reward", title_template="T", body_template="B", created_by="a")
    await npk.publish_pack(db, p2["_id"], updated_by="a")

    push_packs = await npk.list_packs(db, pack_type="push")
    assert [p["_id"] for p in push_packs] == [p1["_id"]]

    published = await npk.list_packs(db, status="published")
    assert [p["_id"] for p in published] == [p2["_id"]]


# ═════════════════════════════════════════════════════════════════════════
# HTTP routes — real APIRouter + FastAPI + TestClient
# ═════════════════════════════════════════════════════════════════════════
class _Admin:
    email = "admin@test"


async def _admin_dep():
    return _Admin()


def _make_client(db):
    app = FastAPI()
    api = APIRouter(prefix="/api")
    npk.register_notification_pack_routes(api, db, _admin_dep)
    app.include_router(api)
    return TestClient(app)


def test_create_list_get_routes():
    db = _FakeDB()
    client = _make_client(db)

    resp = client.post("/api/v1/notification-packs", json={
        "name": "Mystery Box Win", "type": "reward",
        "title_template": "You won!", "body_template": "You got {points} points.",
    })
    assert resp.status_code == 200
    pack_id = resp.json()["pack"]["_id"]

    assert client.get("/api/v1/notification-packs").json()["packs"][0]["_id"] == pack_id
    assert client.get(f"/api/v1/notification-packs/{pack_id}").status_code == 200
    assert client.get("/api/v1/notification-packs/pack_missing").status_code == 404


def test_publish_unpublish_archive_routes():
    db = _FakeDB()
    client = _make_client(db)
    pack_id = client.post("/api/v1/notification-packs", json={
        "name": "A", "type": "push", "title_template": "T", "body_template": "B",
    }).json()["pack"]["_id"]

    resp = client.post(f"/api/v1/notification-packs/{pack_id}/publish")
    assert resp.json()["pack"]["status"] == "published"

    resp = client.patch(f"/api/v1/notification-packs/{pack_id}", json={"body_template": "New"})
    assert resp.status_code == 400  # not editable while published

    resp = client.post(f"/api/v1/notification-packs/{pack_id}/unpublish")
    assert resp.json()["pack"]["status"] == "draft"

    resp = client.post(f"/api/v1/notification-packs/{pack_id}/archive")
    assert resp.json()["pack"]["status"] == "archived"


def test_preview_route_renders_placeholders():
    db = _FakeDB()
    client = _make_client(db)
    pack_id = client.post("/api/v1/notification-packs", json={
        "name": "A", "type": "reward",
        "title_template": "Hi {studentName}!", "body_template": "You got {points} points.",
    }).json()["pack"]["_id"]

    resp = client.post(f"/api/v1/notification-packs/{pack_id}/preview", json={
        "context": {"studentName": "Sok", "points": 50},
    })
    assert resp.json()["preview"] == {
        "title": "Hi Sok!", "body": "You got 50 points.", "url": "/portal",
    }


def test_delete_route_blocked_while_published():
    db = _FakeDB()
    client = _make_client(db)
    pack_id = client.post("/api/v1/notification-packs", json={
        "name": "A", "type": "push", "title_template": "T", "body_template": "B",
    }).json()["pack"]["_id"]
    client.post(f"/api/v1/notification-packs/{pack_id}/publish")

    resp = client.delete(f"/api/v1/notification-packs/{pack_id}")
    assert resp.status_code == 400

    client.post(f"/api/v1/notification-packs/{pack_id}/unpublish")
    resp = client.delete(f"/api/v1/notification-packs/{pack_id}")
    assert resp.status_code == 200
    assert resp.json()["deleted"] is True
