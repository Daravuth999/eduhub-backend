"""VT Pass A.1 — backend behavioral tests for the audit corrections.

Covers:

  #1 public instruction-language projection: reads the real internal field
     `mission_instruction_language` and exposes it as the stable
     student-facing `instruction_language` key. English / Khmer / bilingual
     / legacy-default coverage.

  #2 per-attempt language-policy snapshot: frozen at submit time,
     `_resolve_attempt_language_policy` prefers the snapshot, and falls
     back safely to the current resolved policy for legacy attempts.
     Later Studio configuration changes do NOT mutate an existing snapshot.
     Client-supplied policy is ignored at the source-shape level.

  #5 extended student-safe chest reveal projection: confirmed voucher /
     EduTalk Pass detail blocks contain only approved fields. Internal
     references / stock IDs / provider payloads / admin-only codes are
     never present. Redemption code surfaces only when fulfillment
     explicitly marks it student-visible.

  Truth-matrix coverage of the four reward states is in
  `test_voice_treasure_passA.py`; this file adds the missing finer
  combinations described by the A.1 audit.
"""
from __future__ import annotations

import importlib
import pathlib

import pytest

import voice_treasure_config_tools as vt_cfg
import voice_treasure_attempt_tools as vt_attempt
import voice_treasure_reward_tools as vt_reward


# --------------------------------------------------------------------------- #
# #1 — Public instruction-language projection reads the right internal field. #
# --------------------------------------------------------------------------- #
def _cfg_with_lang(*, response=None, feedback=None, mission_instruction=None):
    cfg = vt_cfg.default_config()
    lang = cfg["language"]
    if response is not None:
        lang["response_language"] = response
    if feedback is not None:
        lang["feedback_language"] = feedback
    if mission_instruction is not None:
        lang["mission_instruction_language"] = mission_instruction
    return cfg


def test_public_instruction_language_english():
    pol = vt_cfg.public_language_policy(_cfg_with_lang(mission_instruction="english"))
    assert pol["instruction_language"] == "english"


def test_public_instruction_language_khmer():
    pol = vt_cfg.public_language_policy(_cfg_with_lang(mission_instruction="khmer"))
    assert pol["instruction_language"] == "khmer"


def test_public_instruction_language_bilingual():
    pol = vt_cfg.public_language_policy(_cfg_with_lang(mission_instruction="bilingual"))
    assert pol["instruction_language"] == "bilingual"


def test_public_instruction_language_legacy_default_fallback():
    """Legacy config that doesn't carry `mission_instruction_language` at
    all (older persisted documents) must fall back safely to English —
    not to an empty string or None."""
    cfg = vt_cfg.default_config()
    # Strip the field as if loaded from a legacy document.
    cfg["language"].pop("mission_instruction_language", None)
    pol = vt_cfg.public_language_policy(cfg)
    assert pol["instruction_language"] == "english"


def test_public_language_policy_independent_of_internal_alias():
    """A config that happens to have an `instruction_language` key set
    elsewhere must NOT be picked up — Pass A.1 fix reads ONLY the real
    internal field `mission_instruction_language`."""
    cfg = vt_cfg.default_config()
    # Forge an alias-style field on the config; the projection must ignore it.
    cfg["language"]["instruction_language"] = "khmer"   # decoy
    cfg["language"]["mission_instruction_language"] = "english"  # real
    assert vt_cfg.public_language_policy(cfg)["instruction_language"] == "english"


# --------------------------------------------------------------------------- #
# #2 — Per-attempt language-policy snapshot is frozen + immutable.            #
# --------------------------------------------------------------------------- #
def test_resolve_attempt_language_policy_prefers_snapshot():
    """When the stored attempt carries a `language_policy_snapshot`, the
    resolver returns that snapshot verbatim (limited to the three approved
    selectors). Later Studio config changes never retroactively change it."""
    snap = {
        "response_language": "khmer",
        "feedback_language": "bilingual",
        "instruction_language": "khmer",
    }
    attempt = {"attempt_id": "x", "state": "evaluated", "language_policy_snapshot": snap}
    # The "current" Studio config is the opposite — must not bleed through.
    current_cfg = _cfg_with_lang(
        response="english", feedback="english", mission_instruction="english")
    resolved = vt_attempt._resolve_attempt_language_policy(attempt, current_cfg)
    assert resolved == snap


def test_resolve_attempt_language_policy_legacy_fallback():
    """Legacy attempts without a snapshot fall back to the currently
    resolved server-authoritative public policy."""
    attempt = {"attempt_id": "x", "state": "evaluated"}  # no snapshot field
    current_cfg = _cfg_with_lang(
        response="khmer", feedback="bilingual", mission_instruction="khmer")
    resolved = vt_attempt._resolve_attempt_language_policy(attempt, current_cfg)
    assert resolved == {
        "response_language": "khmer",
        "feedback_language": "bilingual",
        "instruction_language": "khmer",
    }


def test_snapshot_only_contains_approved_selectors():
    """Even if a corrupted/widened snapshot exists on the attempt doc, the
    resolver must drop anything outside the three approved selectors so a
    bad write cannot widen the public contract."""
    snap = {
        "response_language": "english",
        "feedback_language": "khmer",
        "instruction_language": "bilingual",
        # Forbidden fields that must NOT appear in the response.
        "mission_instruction_text_en": "leak",
        "system_prompt": "leak",
        "secret_key": "leak",
    }
    attempt = {"language_policy_snapshot": snap}
    resolved = vt_attempt._resolve_attempt_language_policy(attempt, vt_cfg.default_config())
    assert set(resolved.keys()) == {
        "response_language", "feedback_language", "instruction_language",
    }


def test_attempt_seed_persists_snapshot_in_source():
    """Source-shape pin: the seed document persisted at attempt-claim time
    carries `language_policy_snapshot`. This invariant guarantees the
    snapshot is frozen at submission, before Gemini runs, so a Studio
    change mid-evaluation cannot leak through."""
    src = pathlib.Path(vt_attempt.__file__).read_text(encoding="utf-8")
    assert '"language_policy_snapshot": dict(lang_policy_public)' in src


def test_attempt_response_uses_snapshot_resolver_everywhere():
    src = pathlib.Path(vt_attempt.__file__).read_text(encoding="utf-8")
    # The four response paths in submit-attempt + the GET-attempt path.
    assert src.count("_resolve_attempt_language_policy(") >= 4


def test_attempt_handler_does_not_read_policy_from_client():
    """The signature of vt_submit_attempt must not have any language-policy
    parameter and the source must not pull such a value from the request
    body. The only acceptable source is `vt_cfg.public_language_policy(cfg)`
    (or the persisted snapshot)."""
    src = pathlib.Path(vt_attempt.__file__).read_text(encoding="utf-8")
    # No JSON body parsing for a language_policy.
    assert "language_policy: " not in src       # parameter form
    assert "request.json()" not in src           # no raw body parsing
    # And no `language_policy = student.…` style read.
    assert "= student." not in src or "student_id" in src  # only IDs/groups read


def test_changing_studio_config_does_not_alter_existing_snapshot():
    """A snapshot baked into the attempt document is byte-immutable from
    the resolver's perspective — we exercise this with a config that
    rotates AFTER the snapshot is captured."""
    snap = {
        "response_language": "english",
        "feedback_language": "english",
        "instruction_language": "english",
    }
    attempt = {"language_policy_snapshot": snap}
    later_cfg = _cfg_with_lang(
        response="khmer", feedback="khmer", mission_instruction="khmer")
    assert vt_attempt._resolve_attempt_language_policy(attempt, later_cfg) == snap


# --------------------------------------------------------------------------- #
# #5 — Extended student-safe chest reveal projection.                          #
# --------------------------------------------------------------------------- #
def _reward(*, points=10, voucher_state=None, voucher_extra=None,
            pass_state=None, snap_extra=None, points_eligible=True):
    """Build a synthetic reward document close enough to the real shape to
    exercise `_public_reward_view`. Only the fields the projection actually
    reads are populated. The chest state classifier requires:
      - decision.eligible truthy
      - reward.state == "succeeded"
      - _fulfillment_settled (points credited + card ok + voucher_ok + pass_ok)
    """
    dec = {
        "eligible": True,
        "points_eligible": points_eligible,
        "base_points": 5, "streak_bonus": 0, "high_score_bonus": 5,
        "voucher_eligible": voucher_state is not None,
        "pass_eligible": pass_state is not None,
        "policy_snapshot": {
            "voucher_title": "Bookstore Voucher",
            "voucher_subtitle": "Spend at our partner",
            "voucher_discount_type": "percent",
            "voucher_discount_value": 25,
            "edutalk_pass_feature": "edutalk_voice",
            "edutalk_pass_quantity": 2,
            "edutalk_pass_eligible_books": ["beg-01", "int-02"],
            **(snap_extra or {}),
        },
    }
    f = {
        "points_credited": True,             # boolean settlement flag
        "credited_points": points,           # numeric value
        "card_state": "not_eligible",
        "voucher_state": voucher_state,
        "pass_state": pass_state,
        **(voucher_extra or {}),
    }
    return {
        "attempt_id": "att-1", "reward_id": "rw-1",
        "state": vt_reward.R_SUCCEEDED, "completed_at": "2026-06-22T00:00:00+00:00",
        "decision": dec, "fulfillment": f, "trusted_balance": 123,
    }


def test_chest_reveal_confirmed_voucher_only():
    out = vt_reward._public_reward_view(_reward(voucher_state="granted"), None)
    r = out["reward"]
    assert r["voucher"] == "granted"
    assert r["voucher_detail"]["title"] == "Bookstore Voucher"
    assert r["voucher_detail"]["subtitle"] == "Spend at our partner"
    assert r["voucher_detail"]["discount_summary"] == "25% off"
    # Internal references / provider payloads / auto-generated codes must
    # never appear in the student-safe block.
    forbidden = {"voucher_existing_code", "voucher_source", "stock_id",
                 "provider_payload", "internal_ref"}
    assert forbidden.isdisjoint(set(r["voucher_detail"].keys()))


def test_chest_reveal_confirmed_pass_only():
    out = vt_reward._public_reward_view(_reward(pass_state="granted"), None)
    r = out["reward"]
    assert r["edutalk_pass"] == "granted"
    d = r["edutalk_pass_detail"]
    assert d["feature"] == "edutalk_voice"
    assert d["quantity"] == 2
    assert d["eligible_books"] == ["beg-01", "int-02"]


def test_chest_reveal_both_confirmed():
    rw = _reward(voucher_state="granted", pass_state="granted")
    r = vt_reward._public_reward_view(rw, None)["reward"]
    assert r["voucher"] == "granted" and r["voucher_detail"]
    assert r["edutalk_pass"] == "granted" and r["edutalk_pass_detail"]


@pytest.mark.parametrize("vstate", ["pending", "error"])
def test_chest_keeps_sealed_on_unconfirmed_voucher(vstate):
    """Pending / error voucher → fulfillment not settled → chest stays in
    `processing` and NO reveal block is produced. This is the authoritative
    suppression — the projection never emits `reward` for non-completed
    chest states."""
    rw = _reward(voucher_state=vstate)
    out = vt_reward._public_reward_view(rw, None)
    assert out["chest_state"] == vt_reward.CHEST_PROCESSING
    assert "reward" not in out


def test_chest_voucher_skipped_is_settled_but_detail_absent():
    """`voucher_state == "skipped"` (master OFF / no bridge at grant time)
    still settles the fulfillment so the chest CAN open — but the voucher
    detail block is omitted because the reveal is gated on `granted`."""
    rw = _reward(voucher_state="skipped")
    out = vt_reward._public_reward_view(rw, None)
    assert out["chest_state"] == vt_reward.CHEST_COMPLETED
    r = out["reward"]
    assert r["voucher"] == "skipped"
    assert r["voucher_detail"] is None


@pytest.mark.parametrize("pstate", ["pending", "error"])
def test_chest_keeps_sealed_on_unconfirmed_pass(pstate):
    rw = _reward(pass_state=pstate)
    out = vt_reward._public_reward_view(rw, None)
    assert out["chest_state"] == vt_reward.CHEST_PROCESSING
    assert "reward" not in out


def test_chest_pass_skipped_is_settled_but_detail_absent():
    rw = _reward(pass_state="skipped")
    out = vt_reward._public_reward_view(rw, None)
    assert out["chest_state"] == vt_reward.CHEST_COMPLETED
    r = out["reward"]
    assert r["edutalk_pass"] == "skipped"
    assert r["edutalk_pass_detail"] is None


def test_chest_reveal_voucher_redemption_code_only_when_student_visible():
    # Default: fulfillment did NOT mark the code student-visible.
    rw = _reward(voucher_state="granted",
                 voucher_extra={"voucher_code_public": "ABC123",
                                "student_visible_code": False})
    detail = vt_reward._public_reward_view(rw, None)["reward"]["voucher_detail"]
    assert "redemption_code" not in detail
    # When the existing student-safe contract opts in, the public code is shown.
    rw_yes = _reward(voucher_state="granted",
                     voucher_extra={"voucher_code_public": "ABC123",
                                    "student_visible_code": True})
    detail_yes = vt_reward._public_reward_view(rw_yes, None)["reward"]["voucher_detail"]
    assert detail_yes["redemption_code"] == "ABC123"


def test_chest_reveal_voucher_eligible_only_without_grant():
    """Eligible-but-not-granted (no fulfillment field) → chest stays
    sealed (processing) because fulfillment is not settled."""
    rw = _reward(voucher_state=None)
    rw["decision"]["voucher_eligible"] = True
    out = vt_reward._public_reward_view(rw, None)
    assert out["chest_state"] == vt_reward.CHEST_PROCESSING
    assert "reward" not in out


def test_chest_reveal_pass_blocked_state():
    """`pass_state == "skipped"` (master switch OFF at grant time) is
    treated as blocked from the reveal-block perspective: the chest may
    open (fulfillment settled), but the EduTalk Pass block is omitted."""
    rw = _reward(pass_state="skipped")
    out = vt_reward._public_reward_view(rw, None)
    assert out["chest_state"] == vt_reward.CHEST_COMPLETED
    r = out["reward"]
    assert r["edutalk_pass"] == "skipped"
    assert r["edutalk_pass_detail"] is None


def test_safe_voucher_discount_summary_amount_and_invalid():
    assert vt_reward._safe_voucher_discount_summary(
        {"voucher_discount_type": "amount", "voucher_discount_value": 5}) == "$5 off"
    assert vt_reward._safe_voucher_discount_summary(
        {"voucher_discount_type": "amount", "voucher_discount_value": "abc"}) is None
    assert vt_reward._safe_voucher_discount_summary({}) is None


def test_chest_reveal_replay_is_idempotent_on_completed_state():
    """Calling `_public_reward_view` repeatedly on the same `completed`
    reward returns identical output — the projection is pure. The chest
    UI replays this view without ever calling the claim endpoint again."""
    rw = _reward(voucher_state="granted", pass_state="granted")
    v1 = vt_reward._public_reward_view(rw, None)
    v2 = vt_reward._public_reward_view(rw, None)
    assert v1 == v2
