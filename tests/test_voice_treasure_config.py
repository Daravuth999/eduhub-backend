"""tests/test_voice_treasure_config.py
======================================
Phase 2 tests for Voice Treasure configuration foundation.

Pure-logic + in-memory fake-Mongo tests. No real MongoDB, no network, no
env required (each test sets the master switches it needs). Covers the
Phase 2 testing checklist:

  * default configuration creation
  * admin-only config read / update happen through validated helpers
  * validation: negative entry cost, recording-duration bounds, reward caps
  * environment master switch overriding Author Studio
  * student-safe public config (no private leakage)
  * eligible / ineligible / suspended students
  * disabled state
  * voucher + EduTalk Pass reward types force-disabled

Run:  python -m pytest tests/test_voice_treasure_config.py -q
"""
from __future__ import annotations

import asyncio
import os

import pytest

import voice_treasure_config_tools as vt


# --------------------------------------------------------------------------- #
# Tiny async in-memory fake of the single Mongo collection we use.            #
# --------------------------------------------------------------------------- #
class _FakeCollection:
    def __init__(self):
        self._docs = {}

    async def find_one(self, query, projection=None):
        doc = self._docs.get(query.get("_id"))
        if doc is None:
            return None
        out = dict(doc)
        if projection and projection.get("_id") == 0:
            out.pop("_id", None)
        return out

    async def update_one(self, query, update, upsert=False):
        _id = query.get("_id")
        cur = self._docs.get(_id)
        if "$setOnInsert" in update:
            if cur is None:
                self._docs[_id] = dict(update["$setOnInsert"])
            return
        if "$set" in update:
            base = dict(cur) if cur else {"_id": _id}
            base.update(update["$set"])
            base["_id"] = _id
            self._docs[_id] = base


class _FakeDB:
    def __init__(self):
        self._cols = {}

    def __getitem__(self, name):
        return self._cols.setdefault(name, _FakeCollection())


class _FakeStudent:
    def __init__(self, sid, groups=None):
        self.student_id = sid
        self.clean_id = sid
        self.groups = groups or []


def run(coro):
    return asyncio.run(coro)


@pytest.fixture(autouse=True)
def _clear_master_switches(monkeypatch):
    # Start each test with master switches OFF unless the test sets them.
    for k in (
        "VOICE_TREASURE_ENABLED",
        "VOICE_TREASURE_POINTS_REWARD_ENABLED",
        "VOICE_TREASURE_IMAGE_GENERATION_ENABLED",
        "VOICE_TREASURE_IMAGE_MODEL",
    ):
        monkeypatch.delenv(k, raising=False)
    yield


def _on(monkeypatch, name):
    monkeypatch.setenv(name, "1")


# --------------------------------------------------------------------------- #
# Defaults / persistence                                                      #
# --------------------------------------------------------------------------- #
def test_default_config_shape():
    cfg = vt.default_config()
    for group in ("access", "entry", "images", "speaking", "rewards", "safety"):
        assert group in cfg
    # Feature OFF by default
    assert cfg["access"]["enabled"] is False
    assert cfg["access"]["show_home_tile"] is False
    # Unverified reward types default disabled
    assert cfg["rewards"]["voucher_reward_enabled"] is False
    assert cfg["rewards"]["edutalk_pass_reward_enabled"] is False
    # VT-owned collectible allowed
    assert cfg["rewards"]["first_voice_card_enabled"] is True


def test_ensure_indexes_seeds_once():
    db = _FakeDB()
    run(vt.ensure_voice_treasure_indexes(db))
    doc1 = run(db[vt.VT_CONFIG_COLLECTION].find_one({"_id": vt.VT_CONFIG_DOC_ID}))
    assert doc1 is not None
    # Mutate, then ensure again — must NOT reset.
    run(db[vt.VT_CONFIG_COLLECTION].update_one(
        {"_id": vt.VT_CONFIG_DOC_ID},
        {"$set": {"access": {**doc1["access"], "enabled": True}}},
    ))
    run(vt.ensure_voice_treasure_indexes(db))
    doc2 = run(db[vt.VT_CONFIG_COLLECTION].find_one({"_id": vt.VT_CONFIG_DOC_ID}))
    assert doc2["access"]["enabled"] is True  # preserved


def test_load_config_merges_defaults_over_partial_stored():
    db = _FakeDB()
    # Simulate an older stored doc missing a newer field.
    run(db[vt.VT_CONFIG_COLLECTION].update_one(
        {"_id": vt.VT_CONFIG_DOC_ID},
        {"$set": {"_id": vt.VT_CONFIG_DOC_ID, "access": {"enabled": True}}},
    ))
    cfg = run(vt.load_config(db))
    # Missing fields filled from defaults
    assert "daily_play_limit" in cfg["access"]
    assert cfg["entry"]["entry_cost_points"] == 10
    assert cfg["access"]["enabled"] is True


# --------------------------------------------------------------------------- #
# Validation                                                                  #
# --------------------------------------------------------------------------- #
def test_validation_rejects_negative_entry_cost():
    cfg = vt.default_config()
    cfg["entry"]["entry_cost_points"] = -1
    with pytest.raises(vt.VTValidationError):
        vt.validate_config(cfg)


def test_validation_recording_bounds():
    cfg = vt.default_config()
    cfg["speaking"]["minimum_recording_seconds"] = 30
    cfg["speaking"]["maximum_recording_seconds"] = 20  # max <= min
    with pytest.raises(vt.VTValidationError):
        vt.validate_config(cfg)

    cfg = vt.default_config()
    cfg["speaking"]["minimum_recording_seconds"] = 0
    with pytest.raises(vt.VTValidationError):
        vt.validate_config(cfg)


def test_validation_reward_caps():
    cfg = vt.default_config()
    cfg["rewards"]["base_points_reward"] = 80
    cfg["rewards"]["maximum_points_reward"] = 50  # max < base
    with pytest.raises(vt.VTValidationError):
        vt.validate_config(cfg)

    cfg = vt.default_config()
    cfg["rewards"]["daily_points_payout_cap"] = -5
    with pytest.raises(vt.VTValidationError):
        vt.validate_config(cfg)


def test_validation_score_and_enums():
    cfg = vt.default_config()
    cfg["speaking"]["minimum_eligible_score"] = 150
    with pytest.raises(vt.VTValidationError):
        vt.validate_config(cfg)

    cfg = vt.default_config()
    cfg["speaking"]["evaluation_categories"] = ["relevance", "pronunciation"]  # not allowed
    with pytest.raises(vt.VTValidationError):
        vt.validate_config(cfg)

    cfg = vt.default_config()
    cfg["entry"]["technical_failure_policy"] = "delete_everything"
    with pytest.raises(vt.VTValidationError):
        vt.validate_config(cfg)


def test_valid_config_passes():
    vt.validate_config(vt.default_config())  # must not raise


# --------------------------------------------------------------------------- #
# Master switch ceiling                                                        #
# --------------------------------------------------------------------------- #
def test_master_switch_forces_image_and_points_off(monkeypatch):
    cfg = vt.default_config()
    cfg["images"]["image_generation_enabled"] = True
    cfg["rewards"]["points_reward_enabled"] = True
    # Masters OFF (default in fixture)
    clamped = vt.apply_master_switch_ceiling(cfg)
    assert clamped["images"]["image_generation_enabled"] is False
    assert clamped["rewards"]["points_reward_enabled"] is False


def test_master_switch_allows_when_on(monkeypatch):
    _on(monkeypatch, "VOICE_TREASURE_POINTS_REWARD_ENABLED")
    _on(monkeypatch, "VOICE_TREASURE_IMAGE_GENERATION_ENABLED")
    cfg = vt.default_config()
    cfg["images"]["image_generation_enabled"] = True
    cfg["rewards"]["points_reward_enabled"] = True
    clamped = vt.apply_master_switch_ceiling(cfg)
    assert clamped["images"]["image_generation_enabled"] is True
    assert clamped["rewards"]["points_reward_enabled"] is True


def test_voucher_and_pass_always_forced_off(monkeypatch):
    # Even with every master switch ON, unverified reward types stay off.
    _on(monkeypatch, "VOICE_TREASURE_ENABLED")
    _on(monkeypatch, "VOICE_TREASURE_POINTS_REWARD_ENABLED")
    cfg = vt.default_config()
    cfg["rewards"]["voucher_reward_enabled"] = True
    cfg["rewards"]["edutalk_pass_reward_enabled"] = True
    clamped = vt.apply_master_switch_ceiling(cfg)
    assert clamped["rewards"]["voucher_reward_enabled"] is False
    assert clamped["rewards"]["edutalk_pass_reward_enabled"] is False


def test_save_config_clamps_to_master(monkeypatch):
    # Admin tries to enable everything while masters are OFF.
    db = _FakeDB()
    patch = {
        "access": {"enabled": True, "show_home_tile": True, "open_to_all": True},
        "images": {"image_generation_enabled": True},
        "rewards": {
            "points_reward_enabled": True,
            "voucher_reward_enabled": True,
            "edutalk_pass_reward_enabled": True,
        },
    }
    merged = run(vt.save_config(db, patch, updated_by="admin@test"))
    assert merged["images"]["image_generation_enabled"] is False
    assert merged["rewards"]["points_reward_enabled"] is False
    assert merged["rewards"]["voucher_reward_enabled"] is False
    # access.enabled is allowed (gated separately by master at availability time)
    assert merged["access"]["enabled"] is True


# --------------------------------------------------------------------------- #
# Effective state + availability                                              #
# --------------------------------------------------------------------------- #
def test_feature_unavailable_when_master_off(monkeypatch):
    cfg = vt.default_config()
    cfg["access"]["enabled"] = True
    eff = vt.effective_state(cfg)
    assert eff["master_enabled"] is False
    assert eff["feature_available"] is False  # master OFF wins


def test_feature_available_requires_both(monkeypatch):
    _on(monkeypatch, "VOICE_TREASURE_ENABLED")
    cfg = vt.default_config()
    cfg["access"]["enabled"] = True
    cfg["access"]["show_home_tile"] = True
    eff = vt.effective_state(cfg)
    assert eff["feature_available"] is True
    assert eff["show_home_tile"] is True


# --------------------------------------------------------------------------- #
# Public projection: eligibility + no leakage                                 #
# --------------------------------------------------------------------------- #
def _enabled_cfg():
    cfg = vt.default_config()
    cfg["access"]["enabled"] = True
    cfg["access"]["show_home_tile"] = True
    cfg["access"]["eligible_student_ids"] = ["stu_alice"]
    cfg["access"]["eligible_groups"] = ["grade5"]
    cfg["access"]["suspended_student_ids"] = ["stu_bob"]
    return cfg


def test_public_eligible_student(monkeypatch):
    _on(monkeypatch, "VOICE_TREASURE_ENABLED")
    pub = vt.public_projection(_enabled_cfg(), "stu_alice", groups=[])
    assert pub["available"] is True
    assert pub["show_home_tile"] is True
    assert pub["entry"]["entry_cost_points"] == 10


def test_public_eligible_by_group(monkeypatch):
    _on(monkeypatch, "VOICE_TREASURE_ENABLED")
    pub = vt.public_projection(_enabled_cfg(), "stu_carol", groups=["grade5"])
    assert pub["available"] is True


def test_public_ineligible_student(monkeypatch):
    _on(monkeypatch, "VOICE_TREASURE_ENABLED")
    pub = vt.public_projection(_enabled_cfg(), "stu_nobody", groups=["grade9"])
    assert pub["available"] is False
    assert pub["show_home_tile"] is False


def test_public_suspended_student(monkeypatch):
    _on(monkeypatch, "VOICE_TREASURE_ENABLED")
    pub = vt.public_projection(_enabled_cfg(), "stu_bob", groups=["grade5"])
    assert pub["available"] is False


def test_public_unavailable_when_disabled():
    # Master OFF and config disabled
    pub = vt.public_projection(_enabled_cfg(), "stu_alice", groups=[])
    assert pub["available"] is False


def test_public_projection_has_no_private_leakage(monkeypatch):
    _on(monkeypatch, "VOICE_TREASURE_ENABLED")
    monkeypatch.setenv("VOICE_TREASURE_IMAGE_MODEL", "secret-model-x")
    cfg = _enabled_cfg()
    cfg["images"]["image_model"] = "secret-model-x"
    cfg["images"]["blocked_themes"] = ["violence"]
    pub = vt.public_projection(cfg, "stu_alice", groups=[])
    flat = repr(pub)
    # None of these private values may appear anywhere in the public payload.
    assert "secret-model-x" not in flat
    assert "violence" not in flat
    assert "eligible_student_ids" not in flat
    assert "suspended_student_ids" not in flat
    assert "daily_points_payout_cap" not in flat
    assert "stu_bob" not in flat
    # Voucher / pass advertised only as unavailable
    assert pub["rewards"]["voucher_reward_available"] is False
    assert pub["rewards"]["edutalk_pass_reward_available"] is False


def test_open_to_all_eligibility(monkeypatch):
    _on(monkeypatch, "VOICE_TREASURE_ENABLED")
    cfg = vt.default_config()
    cfg["access"]["enabled"] = True
    cfg["access"]["open_to_all"] = True
    pub = vt.public_projection(cfg, "anyone", groups=[])
    assert pub["available"] is True


def test_daily_play_limit_clamped_to_one():
    cfg = vt.default_config()
    assert cfg["access"]["daily_play_limit"] == 1
    # any save above 1 is clamped to 1
    cfg["access"]["daily_play_limit"] = 5
    vt.validate_config(cfg)
    assert cfg["access"]["daily_play_limit"] == 1
