"""tests/test_voice_treasure_reward_integration.py
====================================================
Reward integration availability + "disabled cannot grant" tests.

Audits the existing 228 baseline:
  * Voucher reward routes through ``_lrc_issue_voucher_for_claim`` (login
    reward voucher issuer). The Voice Treasure adapter ``_vt_grant_voucher``
    lives in server.py and is wired by ``register_voice_treasure_reward_
    routes``.
  * EduTalk Pass reward routes through ``_mbt_grant_edutalk_pass`` (mystery
    box pass granter).
  * Both are double-gated by:
      env master switch  → VOICE_TREASURE_*_REWARD_ENABLED
      config gate        → rewards.voucher_reward_enabled / edutalk_pass_reward_enabled
      author studio rule → blocked when integration unavailable

This file proves the SAFETY contract — not the live grant. Live grants are
exercised by the existing login-reward + mystery-box test suites.
"""
from __future__ import annotations

import os

import pytest

import voice_treasure_config_tools as cfg


def _strip_env(monkeypatch):
    """Default-OFF environment."""
    for k in ("VOICE_TREASURE_VOUCHER_REWARD_ENABLED",
              "VOICE_TREASURE_EDUTALK_PASS_REWARD_ENABLED",
              "VOICE_TREASURE_POINTS_REWARD_ENABLED"):
        monkeypatch.delenv(k, raising=False)


# ── Master switches default OFF ────────────────────────────────────────────
def test_voucher_master_switch_default_off(monkeypatch):
    _strip_env(monkeypatch)
    assert cfg.master_voucher_reward_enabled() is False


def test_edutalk_master_switch_default_off(monkeypatch):
    _strip_env(monkeypatch)
    assert cfg.master_edutalk_pass_reward_enabled() is False


def test_points_master_switch_default_off(monkeypatch):
    _strip_env(monkeypatch)
    assert cfg.master_points_reward_enabled() is False


# ── Author Studio CANNOT override an OFF master switch ────────────────────
def test_apply_master_switch_ceiling_clamps_voucher_off(monkeypatch):
    _strip_env(monkeypatch)
    c = cfg.default_config()
    c["rewards"]["voucher_reward_enabled"] = True   # admin tried to enable
    out = cfg.apply_master_switch_ceiling(c)
    # Author Studio toggle is overridden because master is OFF.
    assert out["rewards"]["voucher_reward_enabled"] is False


def test_apply_master_switch_ceiling_clamps_edutalk_off(monkeypatch):
    _strip_env(monkeypatch)
    c = cfg.default_config()
    c["rewards"]["edutalk_pass_reward_enabled"] = True
    out = cfg.apply_master_switch_ceiling(c)
    assert out["rewards"]["edutalk_pass_reward_enabled"] is False


def test_apply_master_switch_ceiling_clamps_points_off(monkeypatch):
    _strip_env(monkeypatch)
    c = cfg.default_config()
    c["rewards"]["points_reward_enabled"] = True
    out = cfg.apply_master_switch_ceiling(c)
    assert out["rewards"]["points_reward_enabled"] is False


# ── Master switches honour explicit YES ───────────────────────────────────
def test_voucher_master_switch_honours_env_on(monkeypatch):
    monkeypatch.setenv("VOICE_TREASURE_VOUCHER_REWARD_ENABLED", "1")
    assert cfg.master_voucher_reward_enabled() is True


def test_edutalk_master_switch_honours_env_on(monkeypatch):
    monkeypatch.setenv("VOICE_TREASURE_EDUTALK_PASS_REWARD_ENABLED", "1")
    assert cfg.master_edutalk_pass_reward_enabled() is True


# ── Audit: voucher / edutalk grantor adapters are referenced in server ────
def test_server_registers_grantors_with_reward_routes():
    """Static read of server.py to prove the adapters are wired. We do not
    execute server.py here; this is a structural sanity check."""
    here = os.path.dirname(os.path.dirname(os.path.abspath(__file__)))
    server = os.path.join(here, "server.py")
    text = open(server, encoding="utf-8").read()
    assert "async def _vt_grant_voucher" in text
    assert "async def _vt_grant_edutalk_pass" in text
    assert "_lrc_issue_voucher_for_claim" in text
    assert "_mbt_grant_edutalk_pass" in text
    # Both grantors are passed into the VT reward route registrar.
    assert 'grantors={"voucher": _vt_grant_voucher,' in text
    assert '"edutalk_pass": _vt_grant_edutalk_pass' in text


# ── Public config redaction surface ────────────────────────────────────────
def test_public_config_does_not_leak_voucher_secrets():
    c = cfg.default_config()
    c["rewards"]["voucher_existing_code"] = "SECRET-COUPON-CODE-XYZ"
    public = cfg.public_projection(c, student_id="stu", groups=[])
    # The voucher_existing_code is an admin-only field; it must not appear
    # in the public student-facing view.
    assert "voucher_existing_code" not in str(public)
    assert "SECRET-COUPON-CODE-XYZ" not in str(public)


def test_public_config_does_not_leak_master_env_state():
    c = cfg.default_config()
    public = cfg.public_projection(c, student_id="stu", groups=[])
    # The "VOICE_TREASURE_*" env names must NEVER appear in the public view.
    s = str(public)
    assert "VOICE_TREASURE_POINTS_REWARD_ENABLED" not in s
    assert "VOICE_TREASURE_VOUCHER_REWARD_ENABLED" not in s
    assert "VOICE_TREASURE_EDUTALK_PASS_REWARD_ENABLED" not in s
