"""tests/test_eduhub_platform_config.py
=====================================================
Architecture Reconstruction Phase 3 ("configuration platform").
eduhub_platform/config.py generalizes the proven published -> legacy ->
default resolution pattern (already live on the frontend's Experience
Configuration Platform) into a reusable backend primitive. These tests
prove the three-tier priority, the never-raises-on-DB-failure guarantee,
the boolean-flag truthy-string convention, and the admin override
CRUD (set/clear/list) — all against a fake Mongo, no real connection.
"""
from __future__ import annotations

import pytest

import eduhub_platform.config as cfg


class _Result:
    def __init__(self, **kw):
        for k, v in kw.items():
            setattr(self, k, v)


class _FakeCursor:
    def __init__(self, docs):
        self._docs = list(docs)

    def sort(self, key="updated_at", direction=-1):
        self._docs = sorted(self._docs, key=lambda d: d.get(key) or "", reverse=(direction == -1))
        return self

    def limit(self, n):
        self._docs = self._docs[:n]
        return self

    def __aiter__(self):
        self._it = iter(self._docs)
        return self

    async def __anext__(self):
        try:
            return next(self._it)
        except StopIteration:
            raise StopAsyncIteration


class _FakeConfigCollection:
    def __init__(self):
        self.docs: dict[str, dict] = {}
        self.raise_on_find = False

    async def find_one(self, query, projection=None):
        if self.raise_on_find:
            raise ConnectionError("simulated Mongo outage")
        _id = query.get("_id")
        doc = self.docs.get(_id)
        return dict(doc) if doc is not None else None

    async def update_one(self, query, update, upsert=False):
        _id = query.get("_id")
        if "$set" in update:
            self.docs[_id] = dict(update["$set"])
        return _Result(matched_count=1)

    async def delete_one(self, query):
        _id = query.get("_id")
        existed = _id in self.docs
        self.docs.pop(_id, None)
        return _Result(deleted_count=1 if existed else 0)

    def find(self, query=None, projection=None):
        return _FakeCursor(list(self.docs.values()))

    async def create_index(self, *a, **k):
        return None


class _FakeAuditCollection:
    def __init__(self):
        self.docs: list[dict] = []

    async def insert_one(self, doc):
        self.docs.append(dict(doc))
        return _Result(inserted_id=len(self.docs))

    def find(self, query=None, projection=None):
        query = query or {}
        rows = [d for d in self.docs if all(d.get(k) == v for k, v in query.items())]
        return _FakeCursor(rows)

    async def create_index(self, *a, **k):
        return None


class _FakeDB:
    def __init__(self):
        self._config = _FakeConfigCollection()
        self._audit = _FakeAuditCollection()

    def __getitem__(self, name):
        if name == cfg.COLL_CONFIG:
            return self._config
        if name == cfg.COLL_CONFIG_AUDIT:
            return self._audit
        raise AssertionError(f"unexpected collection: {name}")


pytestmark = []


# ═════════════════════════════════════════════════════════════════════════
# resolve_flag — three-tier priority
# ═════════════════════════════════════════════════════════════════════════
@pytest.mark.asyncio
async def test_falls_back_to_default_when_nothing_set():
    db = _FakeDB()
    value, source = await cfg.resolve_flag(db, "SOME_FLAG", default="fallback")
    assert value == "fallback"
    assert source == "default"


@pytest.mark.asyncio
async def test_env_var_wins_over_default(monkeypatch):
    monkeypatch.setenv("SOME_FLAG", "from_env")
    db = _FakeDB()
    value, source = await cfg.resolve_flag(db, "SOME_FLAG", default="fallback")
    assert value == "from_env"
    assert source == "legacy"


@pytest.mark.asyncio
async def test_published_override_wins_over_env(monkeypatch):
    monkeypatch.setenv("SOME_FLAG", "from_env")
    db = _FakeDB()
    await cfg.set_override(db, "SOME_FLAG", "from_admin")
    value, source = await cfg.resolve_flag(db, "SOME_FLAG", default="fallback")
    assert value == "from_admin"
    assert source == "published"


@pytest.mark.asyncio
async def test_explicit_env_var_name_used_instead_of_flag_name(monkeypatch):
    monkeypatch.setenv("REAL_ENV_NAME", "yes-real")
    db = _FakeDB()
    value, source = await cfg.resolve_flag(
        db, "logical_flag_name", env_var="REAL_ENV_NAME", default="no",
    )
    assert value == "yes-real"
    assert source == "legacy"


@pytest.mark.asyncio
async def test_db_lookup_failure_degrades_to_legacy_never_raises(monkeypatch):
    monkeypatch.setenv("SOME_FLAG", "from_env")
    db = _FakeDB()
    db._config.raise_on_find = True
    value, source = await cfg.resolve_flag(db, "SOME_FLAG", default="fallback")
    assert value == "from_env"
    assert source == "legacy"


@pytest.mark.asyncio
async def test_db_lookup_failure_degrades_to_default_when_no_env(monkeypatch):
    monkeypatch.delenv("SOME_FLAG", raising=False)
    db = _FakeDB()
    db._config.raise_on_find = True
    value, source = await cfg.resolve_flag(db, "SOME_FLAG", default="fallback")
    assert value == "fallback"
    assert source == "default"


# ═════════════════════════════════════════════════════════════════════════
# resolve_bool_flag — truthy-string convention matches existing ad-hoc reads
# ═════════════════════════════════════════════════════════════════════════
@pytest.mark.asyncio
@pytest.mark.parametrize("raw,expected", [
    ("true", True), ("True", True), ("1", True), ("yes", True), ("on", True),
    ("false", False), ("0", False), ("no", False), ("off", False),
])
async def test_bool_flag_truthy_strings(monkeypatch, raw, expected):
    monkeypatch.setenv("BOOL_FLAG", raw)
    db = _FakeDB()
    value, source = await cfg.resolve_bool_flag(db, "BOOL_FLAG", default=False)
    assert value is expected
    assert source == "legacy"


@pytest.mark.asyncio
async def test_bool_flag_unrecognized_string_falls_back_to_default(monkeypatch):
    monkeypatch.setenv("BOOL_FLAG", "maybe")
    db = _FakeDB()
    value, _ = await cfg.resolve_bool_flag(db, "BOOL_FLAG", default=True)
    assert value is True


@pytest.mark.asyncio
async def test_bool_flag_default_when_unset():
    db = _FakeDB()
    value, source = await cfg.resolve_bool_flag(db, "UNSET_BOOL_FLAG", default=True)
    assert value is True
    assert source == "default"


@pytest.mark.asyncio
async def test_bool_flag_published_override_accepts_real_bool():
    db = _FakeDB()
    await cfg.set_override(db, "BOOL_FLAG", True)
    value, source = await cfg.resolve_bool_flag(db, "BOOL_FLAG", default=False)
    assert value is True
    assert source == "published"


# ═════════════════════════════════════════════════════════════════════════
# set_override / clear_override / list_overrides — admin CRUD
# ═════════════════════════════════════════════════════════════════════════
@pytest.mark.asyncio
async def test_set_override_then_clear_reverts_to_legacy(monkeypatch):
    monkeypatch.setenv("SOME_FLAG", "from_env")
    db = _FakeDB()
    await cfg.set_override(db, "SOME_FLAG", "from_admin")
    value, source = await cfg.resolve_flag(db, "SOME_FLAG", default="fallback")
    assert source == "published"

    cleared = await cfg.clear_override(db, "SOME_FLAG")
    assert cleared is True
    value, source = await cfg.resolve_flag(db, "SOME_FLAG", default="fallback")
    assert value == "from_env"
    assert source == "legacy"


@pytest.mark.asyncio
async def test_clear_override_on_nonexistent_flag_returns_false():
    db = _FakeDB()
    assert await cfg.clear_override(db, "NEVER_SET") is False


@pytest.mark.asyncio
async def test_list_overrides_returns_all_active_overrides():
    db = _FakeDB()
    await cfg.set_override(db, "FLAG_A", "1", updated_by="admin@test")
    await cfg.set_override(db, "FLAG_B", "on", updated_by="admin@test")
    overrides = await cfg.list_overrides(db)
    names = {o["_id"] for o in overrides}
    assert names == {"FLAG_A", "FLAG_B"}
    assert all(o["updated_by"] == "admin@test" for o in overrides)


@pytest.mark.asyncio
async def test_ensure_config_indexes_is_idempotent_and_safe():
    db = _FakeDB()
    await cfg.ensure_config_indexes(db)
    await cfg.ensure_config_indexes(db)  # second call must not raise


# ═════════════════════════════════════════════════════════════════════════
# Version tracking + audit history (Author Studio's "Platform Configuration"
# screen requirements: version display, audit history)
# ═════════════════════════════════════════════════════════════════════════
@pytest.mark.asyncio
async def test_set_override_increments_version_each_call():
    db = _FakeDB()
    first = await cfg.set_override(db, "FLAG_A", "1", updated_by="admin@test")
    assert first["version"] == 1
    second = await cfg.set_override(db, "FLAG_A", "0", updated_by="admin@test")
    assert second["version"] == 2


@pytest.mark.asyncio
async def test_list_overrides_includes_version():
    db = _FakeDB()
    await cfg.set_override(db, "FLAG_A", "1", updated_by="admin@test")
    await cfg.set_override(db, "FLAG_A", "0", updated_by="admin@test")
    overrides = await cfg.list_overrides(db)
    assert overrides[0]["version"] == 2


@pytest.mark.asyncio
async def test_set_override_records_audit_entry_with_old_and_new_value():
    db = _FakeDB()
    await cfg.set_override(db, "FLAG_A", "1", updated_by="admin@test")
    await cfg.set_override(db, "FLAG_A", "0", updated_by="admin2@test")
    history = await cfg.get_audit_history(db, "FLAG_A")
    assert len(history) == 2
    # newest first
    assert history[0]["action"] == "set"
    assert history[0]["old_value"] == "1"
    assert history[0]["new_value"] == "0"
    assert history[0]["by"] == "admin2@test"
    assert history[1]["old_value"] is None
    assert history[1]["new_value"] == "1"


@pytest.mark.asyncio
async def test_clear_override_records_audit_entry_only_when_something_cleared():
    db = _FakeDB()
    # Clearing a flag that was never set records nothing.
    cleared = await cfg.clear_override(db, "NEVER_SET", updated_by="admin@test")
    assert cleared is False
    assert await cfg.get_audit_history(db, "NEVER_SET") == []

    await cfg.set_override(db, "FLAG_A", "1", updated_by="admin@test")
    await cfg.clear_override(db, "FLAG_A", updated_by="admin@test")
    history = await cfg.get_audit_history(db, "FLAG_A")
    assert history[0]["action"] == "clear"
    assert history[0]["old_value"] == "1"
    assert history[0]["new_value"] is None


@pytest.mark.asyncio
async def test_audit_history_is_scoped_per_flag_name():
    db = _FakeDB()
    await cfg.set_override(db, "FLAG_A", "1", updated_by="a")
    await cfg.set_override(db, "FLAG_B", "2", updated_by="a")
    history_a = await cfg.get_audit_history(db, "FLAG_A")
    assert len(history_a) == 1
    assert history_a[0]["name"] == "FLAG_A"


# ═════════════════════════════════════════════════════════════════════════
# HTTP routes — real APIRouter + FastAPI + TestClient (Author Studio's
# "Platform Configuration" screen consumes these directly)
# ═════════════════════════════════════════════════════════════════════════
def _admin_dep_sync():
    async def _dep():
        return {"email": "admin@test"}
    return _dep


def _make_config_client(db):
    from fastapi import APIRouter, FastAPI
    from fastapi.testclient import TestClient
    app = FastAPI()
    api = APIRouter(prefix="/api")
    cfg.register_platform_config_routes(api, db, _admin_dep_sync())
    app.include_router(api)
    return TestClient(app)


def test_list_platform_config_route_returns_overrides():
    import asyncio
    db = _FakeDB()
    asyncio.run(cfg.set_override(db, "FLAG_A", "1", updated_by="admin@test"))
    client = _make_config_client(db)
    resp = client.get("/api/v1/platform-config")
    assert resp.status_code == 200
    assert resp.json()["overrides"][0]["_id"] == "FLAG_A"


def test_get_platform_config_route_reports_all_three_tiers(monkeypatch):
    monkeypatch.setenv("MY_ENV_FLAG", "from_env")
    db = _FakeDB()
    client = _make_config_client(db)
    resp = client.get("/api/v1/platform-config/MY_ENV_FLAG", params={"default": "fallback"})
    body = resp.json()
    assert body["effective_value"] == "from_env"
    assert body["source"] == "legacy"
    assert body["environment_fallback"] == "from_env"
    assert body["default_fallback"] == "fallback"
    assert body["published_override"] is None


def test_set_platform_config_route_creates_override():
    db = _FakeDB()
    client = _make_config_client(db)
    resp = client.post("/api/v1/platform-config/FLAG_A", json={"value": "on"})
    assert resp.status_code == 200
    assert resp.json()["override"]["value"] == "on"
    assert resp.json()["override"]["version"] == 1


def test_set_platform_config_route_requires_value_field():
    db = _FakeDB()
    client = _make_config_client(db)
    resp = client.post("/api/v1/platform-config/FLAG_A", json={})
    assert resp.status_code == 400


def test_clear_platform_config_route_removes_override():
    import asyncio
    db = _FakeDB()
    asyncio.run(cfg.set_override(db, "FLAG_A", "1", updated_by="admin@test"))
    client = _make_config_client(db)
    resp = client.delete("/api/v1/platform-config/FLAG_A")
    assert resp.status_code == 200
    assert resp.json()["cleared"] is True
    assert await_get(db, "FLAG_A") is None


def await_get(db, name):
    import asyncio
    return asyncio.run(db[cfg.COLL_CONFIG].find_one({"_id": name}))


def test_platform_config_history_route_returns_audit_trail():
    import asyncio
    db = _FakeDB()
    asyncio.run(cfg.set_override(db, "FLAG_A", "1", updated_by="admin@test"))
    asyncio.run(cfg.set_override(db, "FLAG_A", "0", updated_by="admin@test"))
    client = _make_config_client(db)
    resp = client.get("/api/v1/platform-config/FLAG_A/history")
    assert resp.status_code == 200
    history = resp.json()["history"]
    assert len(history) == 2
    assert history[0]["new_value"] == "0"
