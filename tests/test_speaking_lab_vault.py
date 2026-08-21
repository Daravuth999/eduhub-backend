"""
Tests for speaking_lab_vault.py — the Friday Vault experience layer.

Exercises the real, unmodified register_speaking_lab_vault_routes() through
a lightweight fake FastAPI app + fake Mongo collection, proving:
  * hard-off-by-default (AND-gated flag) behavior
  * idempotent grant (no double-credit on retry/duplicate submit)
  * hard-capped numeric knobs regardless of what's stored in config
  * risk_reward's win/lose outcome never exceeds the same cap either way
  * a credit_via_treasury failure degrades to a clean, non-blocking response
  * weekly rule selection is stable across repeated calls in the same week
"""
import copy
import os

import pytest
from fastapi import APIRouter, FastAPI
from fastapi.testclient import TestClient

import speaking_lab_feature_flags as flags
import speaking_lab_vault as vault


# ── minimal fake Mongo collection/db ───────────────────────────────────────
def _match(doc, query):
    for k, v in query.items():
        if isinstance(v, dict) and "$ne" in v:
            if doc.get(k) == v["$ne"]:
                return False
        elif doc.get(k) != v:
            return False
    return True


class _Result:
    def __init__(self, matched=0):
        self.matched_count = matched


class _FakeCollection:
    def __init__(self):
        self._docs: list[dict] = []

    async def create_index(self, *a, **k):
        return "idx"

    async def insert_one(self, doc):
        key_fields = ("session_id", "round_key", "student_id_norm")
        if all(f in doc for f in key_fields):
            for d in self._docs:
                if all(d.get(f) == doc.get(f) for f in key_fields):
                    raise RuntimeError("duplicate key")
        self._docs.append(copy.deepcopy(doc))

    async def find_one(self, query, projection=None, sort=None):
        docs = [d for d in self._docs if _match(d, query)]
        if sort:
            for field, direction in reversed(sort):
                docs.sort(key=lambda d: d.get(field) or "", reverse=(direction < 0))
        return copy.deepcopy(docs[0]) if docs else None

    async def update_one(self, query, update, upsert=False):
        target = next((d for d in self._docs if _match(d, query)), None)
        if target is None:
            if upsert:
                nd = {k: v for k, v in query.items() if not isinstance(v, dict)}
                nd.update(update.get("$set", {}))
                self._docs.append(nd)
                return _Result(matched=1)
            return _Result()
        target.update(update.get("$set", {}))
        return _Result(matched=1)


class _FakeDB:
    def __init__(self):
        self._cols: dict[str, _FakeCollection] = {}

    def __getitem__(self, name):
        return self._cols.setdefault(name, _FakeCollection())


# ── fake admin dependency + app wiring ─────────────────────────────────────
class _FakeAdmin:
    email = "teacher@example.test"


async def _require_admin():
    return _FakeAdmin()


def _build_app(db, *, credit_calls, credit_should_fail=False, push_calls=None):
    async def _fake_credit(*, student_clean_id, points, campaign_id, campaign_name):
        credit_calls.append((student_clean_id, points, campaign_id, campaign_name))
        if credit_should_fail:
            return {"ok": False, "error": "simulated GAS failure"}
        return {"ok": True}

    async def _fake_push(student_id, title, body):
        if push_calls is not None:
            push_calls.append((student_id, title, body))
        return {"attempted": True, "sent": 1}

    router = APIRouter()
    vault.register_speaking_lab_vault_routes(
        router, db, _require_admin, credit_via_treasury=_fake_credit, push_notify=_fake_push,
    )
    app = FastAPI()
    app.include_router(router, prefix="/api")
    return TestClient(app)


@pytest.fixture(autouse=True)
def _clean_env():
    keys = ("SPEAKING_LAB_VAULT_ENABLED",)
    saved = {k: os.environ.get(k) for k in keys}
    yield
    for k, v in saved.items():
        if v is None:
            os.environ.pop(k, None)
        else:
            os.environ[k] = v


async def _enable(db):
    os.environ["SPEAKING_LAB_VAULT_ENABLED"] = "true"
    await db["speaking_lab_settings"].update_one(
        {"_id": "feature_flags"}, {"$set": {"speaking_lab_vault_enabled": True}}, upsert=True,
    )


# ═════════════════════════════════════════════════════════════════════════
def test_flag_off_by_default_grants_nothing():
    db = _FakeDB()
    credit_calls = []
    client = _build_app(db, credit_calls=credit_calls)

    res = client.post(
        "/api/speaking-lab/sessions/sess-1/vault/grant",
        json={"student_id": "stu001", "round_key": "r1"},
    )
    assert res.status_code == 200
    assert res.json() == {"enabled": False}
    assert credit_calls == []


@pytest.mark.asyncio
async def test_env_only_without_db_doc_stays_off():
    """AND-gate: env var alone is not enough — matches every other
    Speaking Lab financial flag's existing safety contract."""
    db = _FakeDB()
    os.environ["SPEAKING_LAB_VAULT_ENABLED"] = "true"
    assert await flags.vault_enabled(db) is False


@pytest.mark.asyncio
async def test_grant_is_real_and_capped():
    db = _FakeDB()
    await _enable(db)
    credit_calls = []
    client = _build_app(db, credit_calls=credit_calls)

    res = client.post(
        "/api/speaking-lab/sessions/sess-1/vault/grant",
        json={"student_id": "stu001", "student_name": "Sophea", "round_key": "r1"},
    )
    body = res.json()
    assert body["enabled"] is True
    assert body["granted"] is True
    assert body["rule_type"] in vault.VAULT_RULE_TYPES
    assert 0 <= body["amount"] <= vault.DEFAULT_BASE_MAX * vault.HARD_CAP_MULTIPLIER
    assert len(credit_calls) == 1
    assert credit_calls[0][0] == "stu001"


@pytest.mark.asyncio
async def test_duplicate_submit_never_double_credits():
    db = _FakeDB()
    await _enable(db)
    credit_calls = []
    client = _build_app(db, credit_calls=credit_calls)

    first = client.post(
        "/api/speaking-lab/sessions/sess-1/vault/grant",
        json={"student_id": "stu001", "round_key": "same-round"},
    ).json()
    second = client.post(
        "/api/speaking-lab/sessions/sess-1/vault/grant",
        json={"student_id": "stu001", "round_key": "same-round"},
    ).json()

    assert first["granted"] is True
    assert second["granted"] is True
    assert second.get("duplicate") is True
    assert second["amount"] == first["amount"]
    assert len(credit_calls) == 1  # exactly one real credit, ever


@pytest.mark.asyncio
async def test_different_rounds_grant_independently():
    db = _FakeDB()
    await _enable(db)
    credit_calls = []
    client = _build_app(db, credit_calls=credit_calls)

    client.post("/api/speaking-lab/sessions/sess-1/vault/grant",
                json={"student_id": "stu001", "round_key": "r1"})
    client.post("/api/speaking-lab/sessions/sess-1/vault/grant",
                json={"student_id": "stu001", "round_key": "r2"})

    assert len(credit_calls) == 2


@pytest.mark.asyncio
async def test_credit_failure_is_non_blocking_and_reports_cleanly():
    db = _FakeDB()
    await _enable(db)
    # Force the resolved amount to be > 0 deterministically isn't trivial
    # (server-random), so run enough attempts that at least one round has
    # amount > 0 and exercises the failure branch; a "lose"/zero round is
    # itself already a clean success path (see test below).
    credit_calls = []
    client = _build_app(db, credit_calls=credit_calls, credit_should_fail=True)

    saw_failure = False
    for i in range(20):
        res = client.post(
            "/api/speaking-lab/sessions/sess-1/vault/grant",
            json={"student_id": "stu001", "round_key": f"r{i}"},
        ).json()
        assert res["enabled"] is True
        if res["granted"] is False:
            assert "error" in res
            saw_failure = True
        else:
            # amount was 0 (risk_reward loss) — a real, valid, non-failure outcome
            assert res["amount"] == 0
    assert saw_failure, "expected at least one non-zero amount to hit the forced credit failure"


@pytest.mark.asyncio
async def test_weekly_rule_is_stable_across_calls():
    db = _FakeDB()
    config = await vault._read_config(db)
    first = await vault._resolve_weekly_rule(db, config)
    second = await vault._resolve_weekly_rule(db, config)
    assert first == second


@pytest.mark.asyncio
async def test_config_clamps_to_hard_caps_regardless_of_stored_values():
    db = _FakeDB()
    await db["speaking_lab_settings"].update_one(
        {"_id": "vault_config"},
        {"$set": {"multiplier": 999.0, "base_max": 99999}},
        upsert=True,
    )
    config = await vault._read_config(db)
    assert config["multiplier"] <= vault.HARD_CAP_MULTIPLIER
    assert config["base_max"] <= vault.HARD_CAP_BASE_MAX


@pytest.mark.asyncio
async def test_admin_config_round_trip():
    db = _FakeDB()
    credit_calls = []
    client = _build_app(db, credit_calls=credit_calls)

    put_res = client.put(
        "/api/admin/speaking-lab/vault-config",
        json={"enabled_types": ["risk_reward", "lucky_protection"], "rotation_mode": "manual",
              "manual_rule_type": "risk_reward", "base_min": 5, "base_max": 10},
    )
    assert put_res.status_code == 200
    body = put_res.json()
    assert set(body["enabled_types"]) == {"risk_reward", "lucky_protection"}
    assert body["this_week_rule_type"] == "risk_reward"
    # No raw enum-speak leaks into the admin-facing type list — every entry
    # carries a human label.
    for t in body["types"]:
        assert t["label"] and t["type"] in vault.VAULT_RULE_TYPES


@pytest.mark.asyncio
async def test_missing_fields_do_not_500():
    db = _FakeDB()
    await _enable(db)
    credit_calls = []
    client = _build_app(db, credit_calls=credit_calls)
    res = client.post("/api/speaking-lab/sessions/sess-1/vault/grant", json={"round_key": "r1"})
    assert res.status_code == 200
    assert res.json()["granted"] is False
