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

    def sort(self, *a, **k):
        self._docs = sorted(self._docs, key=lambda d: d.get("updated_at") or "", reverse=True)
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


class _FakeDB:
    def __init__(self):
        self._config = _FakeConfigCollection()

    def __getitem__(self, name):
        assert name == cfg.COLL_CONFIG
        return self._config


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
