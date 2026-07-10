"""
Tests for the read-only GET /api/speaking-lab/feature-flags route added to
server.py (teacher UI state-display support). This route never mutates
anything — it only reports the current AND-gated flag states so the
teacher app can show a "Not enabled" badge on Combined A+B until a human
explicitly turns speaking_lab_ab_schedule_enabled on.

server.py itself requires live infra env vars at import time, so this test
exercises the identical logic (calling speaking_lab_feature_flags.all_flags)
through a minimal standalone FastAPI app, the same pattern already used by
test_speaking_lab_direct_join.py's /my-entry tests.
"""
import os

import pytest
from fastapi import Depends, FastAPI
from fastapi.testclient import TestClient

import speaking_lab_feature_flags as flags


def _build_app(db):
    app = FastAPI()

    async def _fake_require_admin():
        return {"email": "teacher@example.com"}

    @app.get("/api/speaking-lab/feature-flags")
    async def sl_feature_flags(admin=Depends(_fake_require_admin)):
        return await flags.all_flags(db)

    return app


class _FakeCollection:
    def __init__(self):
        self._doc = None

    async def find_one(self, query, projection=None):
        return self._doc


class _FakeDB:
    def __init__(self):
        self._settings = _FakeCollection()

    def __getitem__(self, name):
        return self._settings


@pytest.fixture(autouse=True)
def _clean_env():
    keys = (
        "SPEAKING_LAB_DIRECT_JOIN_ENABLED", "SPEAKING_LAB_WALLET_PAYOUT_ENABLED",
        "SPEAKING_LAB_WALLET_CUTOVER_ENABLED", "SPEAKING_LAB_AB_SCHEDULE_ENABLED",
    )
    saved = {k: os.environ.get(k) for k in keys}
    yield
    for k, v in saved.items():
        if v is None:
            os.environ.pop(k, None)
        else:
            os.environ[k] = v


def test_1_all_flags_default_off_with_no_env_and_no_db_doc():
    db = _FakeDB()
    app = _build_app(db)
    client = TestClient(app)

    resp = client.get("/api/speaking-lab/feature-flags")

    assert resp.status_code == 200
    body = resp.json()
    assert body == {
        "speaking_lab_direct_join_enabled": False,
        "speaking_lab_wallet_payout_enabled": False,
        "speaking_lab_wallet_cutover_enabled": False,
        "speaking_lab_ab_schedule_enabled": False,
    }


def test_2_ab_flag_stays_off_with_only_env_set_and_no_db_doc():
    os.environ["SPEAKING_LAB_AB_SCHEDULE_ENABLED"] = "true"
    db = _FakeDB()
    app = _build_app(db)
    client = TestClient(app)

    resp = client.get("/api/speaking-lab/feature-flags")

    assert resp.json()["speaking_lab_ab_schedule_enabled"] is False


def test_3_ab_flag_turns_on_only_with_both_env_and_db_doc():
    os.environ["SPEAKING_LAB_AB_SCHEDULE_ENABLED"] = "true"
    db = _FakeDB()
    db._settings._doc = {"speaking_lab_ab_schedule_enabled": True}
    app = _build_app(db)
    client = TestClient(app)

    resp = client.get("/api/speaking-lab/feature-flags")

    assert resp.json()["speaking_lab_ab_schedule_enabled"] is True
    # Other flags remain off — this DB doc only sets the AB field.
    assert resp.json()["speaking_lab_direct_join_enabled"] is False


def test_4_route_never_writes_to_the_settings_collection():
    db = _FakeDB()
    app = _build_app(db)
    client = TestClient(app)

    client.get("/api/speaking-lab/feature-flags")

    assert db._settings._doc is None  # still nothing written
