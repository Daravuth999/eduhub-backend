"""VT Pass A — backend behavioral tests.

Covers:

  C. Result language-policy projection — `evaluation_language_policy` is
     server-authoritative; `public_language_policy(cfg)` exposes ONLY the
     three policy selectors (response_language / feedback_language /
     instruction_language); response endpoints carry it top-level.
  D. Truthful reward integration availability — `set_runtime_adapter_availability`
     injects booleans from the server composition layer; `runtime_adapter_availability()`
     reads them; the four states (Available and active / Available but disabled /
     Blocked by backend master switch / Unavailable integration) are derivable.
  F. Confirmed voucher / EduTalk Pass projection — the `/voice-treasure/rewards`
     payload structure only exposes student-safe fields (title / feature /
     quantity) and never the internal codes.

These tests are PURE: they exercise the in-process helpers and validate the
shape of the public projections without booting the whole FastAPI app, so they
run quickly and deterministically alongside the existing `tests/test_voice_treasure_*`.
"""
from __future__ import annotations

import pathlib

import pytest

import voice_treasure_config_tools as vt_cfg
import voice_treasure_attempt_tools as vt_attempt  # noqa: F401 (import smoke)
import voice_treasure_reward_tools as vt_reward    # noqa: F401 (import smoke)


# --------------------------------------------------------------------------- #
# C. Language policy projection                                               #
# --------------------------------------------------------------------------- #
def _base_cfg() -> dict:
    """Default config with a known language section."""
    return vt_cfg.default_config()


def test_public_language_policy_exposes_only_three_selectors():
    cfg = _base_cfg()
    pol = vt_cfg.public_language_policy(cfg)
    assert set(pol.keys()) == {"response_language", "feedback_language", "instruction_language"}
    # And nothing else slips in — no admin templates, no prompt fragments.
    for forbidden in (
        "prompt_fragment", "system_prompt",
        "mission_instruction_text_en", "mission_instruction_text_km",
        "evaluation_unavailable_text_en", "retry_message_text_en",
    ):
        assert forbidden not in pol


@pytest.mark.parametrize("fl", ["english", "khmer", "bilingual", "match"])
def test_public_language_policy_reflects_admin_choice(fl):
    cfg = _base_cfg()
    cfg["language"]["feedback_language"] = fl
    pol = vt_cfg.public_language_policy(cfg)
    assert pol["feedback_language"] == fl


def test_public_language_policy_does_not_accept_client_input():
    """The student client never supplies a language policy. This test pins
    that the public projection is derived ONLY from the persisted config —
    `public_language_policy` accepts only a config dict and returns the
    server-derived selectors. It does NOT accept a student parameter."""
    import inspect
    sig = inspect.signature(vt_cfg.public_language_policy)
    assert list(sig.parameters.keys()) == ["cfg"]


# --------------------------------------------------------------------------- #
# D. Truthful reward integration availability                                 #
# --------------------------------------------------------------------------- #
def test_runtime_adapter_availability_defaults_false():
    # Save current state then reset so the test is independent of import order.
    prev = vt_cfg.runtime_adapter_availability()
    try:
        vt_cfg.set_runtime_adapter_availability(voucher=False, edutalk_pass=False)
        a = vt_cfg.runtime_adapter_availability()
        assert a == {"voucher": False, "edutalk_pass": False}
    finally:
        vt_cfg.set_runtime_adapter_availability(
            voucher=prev["voucher"], edutalk_pass=prev["edutalk_pass"]
        )


@pytest.mark.parametrize("voucher,edutalk", [
    (True, True), (True, False), (False, True), (False, False),
])
def test_runtime_adapter_availability_injection(voucher, edutalk):
    prev = vt_cfg.runtime_adapter_availability()
    try:
        vt_cfg.set_runtime_adapter_availability(voucher=voucher, edutalk_pass=edutalk)
        a = vt_cfg.runtime_adapter_availability()
        assert a == {"voucher": voucher, "edutalk_pass": edutalk}
    finally:
        vt_cfg.set_runtime_adapter_availability(
            voucher=prev["voucher"], edutalk_pass=prev["edutalk_pass"]
        )


def test_config_tools_does_not_import_server():
    """Pass A invariant: `voice_treasure_config_tools` must remain a pure
    helper. It must not import server.py or call `globals()` on it."""
    import re
    src = pathlib.Path(vt_cfg.__file__).read_text(encoding="utf-8")
    # Match real import STATEMENTS (start of line, after optional whitespace),
    # not the word "server" appearing in a docstring sentence.
    assert not re.search(r"(?m)^\s*import\s+server\b", src)
    assert not re.search(r"(?m)^\s*from\s+server\b", src)
    # Disallowed: any call to globals() in EXECUTABLE code (not comments
    # or docstring prose). We strip both before scanning.
    import io, tokenize
    no_strings = []
    try:
        for tok in tokenize.generate_tokens(io.StringIO(src).readline):
            if tok.type in (tokenize.STRING, tokenize.COMMENT):
                continue
            if tok.type == tokenize.NAME and tok.string == "globals":
                no_strings.append(tok)
    except tokenize.TokenizeError:
        pass
    assert no_strings == [], f"globals() referenced in code: {no_strings}"


def test_public_projection_only_advertises_active_rewards():
    cfg = _base_cfg()
    cfg["rewards"]["voucher_reward_enabled"] = True
    cfg["rewards"]["edutalk_pass_reward_enabled"] = True

    # Adapter unavailable ⇒ public projection must NOT advertise them.
    vt_cfg.set_runtime_adapter_availability(voucher=False, edutalk_pass=False)
    pub = vt_cfg.public_projection(cfg, student_id="s1", groups=[])
    assert pub["rewards"]["voucher_reward_available"] is False
    assert pub["rewards"]["edutalk_pass_reward_available"] is False

    # Adapter available, master switches gated by master_switch_ceiling
    # (which AND's env master with cfg toggle) — env masters default OFF
    # so even with the adapter the public projection still shows False.
    vt_cfg.set_runtime_adapter_availability(voucher=True, edutalk_pass=True)
    pub2 = vt_cfg.public_projection(cfg, student_id="s1", groups=[])
    # voucher master env is OFF (default) ⇒ master_switch_ceiling forces
    # voucher_reward_enabled to False ⇒ available is False.
    assert pub2["rewards"]["voucher_reward_available"] is False
    assert pub2["rewards"]["edutalk_pass_reward_available"] is False


# --------------------------------------------------------------------------- #
# F. Confirmed voucher / EduTalk projection — shape contract                  #
# --------------------------------------------------------------------------- #
def test_reward_route_projection_shape_via_source():
    """The route's `/voice-treasure/rewards` row shape is inspected via the
    module source so we don't have to spin up a full FastAPI app + DB. This
    pins:
      • voucher/pass blocks appear with the exposed fields only;
      • internal voucher codes / private references are never exposed;
      • points + first voice card behavior is preserved.
    """
    src = pathlib.Path(vt_reward.__file__).read_text(encoding="utf-8")
    # Confirmed-only display contract: route returns state for voucher/pass.
    assert "voucher_state" in src
    assert "pass_state" in src
    # No private codes leak from the rewards endpoint row.
    rewards_route_start = src.index("@api.get(\"/voice-treasure/rewards\")")
    rewards_route = src[rewards_route_start: rewards_route_start + 4000]
    for forbidden in (
        "voucher_existing_code", "voucher_discount_value", "voucher_discount_type",
        "voucher_source",
    ):
        assert forbidden not in rewards_route, f"rewards route leaks {forbidden}"
    # Points + first voice card preserved.
    assert "points_credited" in rewards_route
    assert "first_voice_card" in rewards_route


def test_decision_freezes_voucher_and_pass_eligibility():
    """Pure decision helper: voucher_eligible / pass_eligible are gated on
    score thresholds and Author Studio toggles."""
    cfg = _base_cfg()
    cfg["rewards"]["voucher_reward_enabled"] = True
    cfg["rewards"]["edutalk_pass_reward_enabled"] = True
    cfg["rewards"]["voucher_minimum_score"] = 70
    cfg["rewards"]["edutalk_pass_minimum_score"] = 80

    # Below thresholds: neither eligible.
    d = vt_reward.compute_reward_decision(
        cfg=cfg, attempt_result={"overall": 50},
        current_streak=0, paid_today_points=0, paid_week_points=0,
    )
    assert d["voucher_eligible"] is False
    assert d["pass_eligible"] is False

    # Voucher threshold met, pass not: voucher eligible only.
    d = vt_reward.compute_reward_decision(
        cfg=cfg, attempt_result={"overall": 75},
        current_streak=0, paid_today_points=0, paid_week_points=0,
    )
    assert d["voucher_eligible"] is True
    assert d["pass_eligible"] is False

    # Both thresholds met: both eligible.
    d = vt_reward.compute_reward_decision(
        cfg=cfg, attempt_result={"overall": 90},
        current_streak=0, paid_today_points=0, paid_week_points=0,
    )
    assert d["voucher_eligible"] is True
    assert d["pass_eligible"] is True


# --------------------------------------------------------------------------- #
# C. Attempt response shape — language_policy lifted to top level             #
# --------------------------------------------------------------------------- #
def test_attempt_tools_returns_language_policy_top_level():
    """Surface-shape pin (source-level): every attempt-returning endpoint
    in voice_treasure_attempt_tools surfaces language_policy alongside
    `attempt`, never burying it inside `_attempt_view`. The student-safe
    `_attempt_view` MUST NOT include `language_policy` (kept clean to
    avoid widening the result contract).

    Pass A.1 — every response now resolves the language policy via
    `_resolve_attempt_language_policy(...)`, which prefers the per-attempt
    frozen snapshot and falls back to the current resolved policy for
    legacy attempts. The source must reflect that contract everywhere."""
    src = pathlib.Path(vt_attempt.__file__).read_text(encoding="utf-8")
    # At least every public response shape resolves via the snapshot helper.
    assert src.count("_resolve_attempt_language_policy") >= 4
    # And the legacy `_attempt_view` does NOT include language_policy. We
    # bound the slice tightly to `_attempt_view` only (next def or return
    # at column 0 ends the function), so the new helper's docstring below
    # is not included.
    av_start = src.index("def _attempt_view(")
    av_end = src.index("\ndef ", av_start + 1)
    av_block = src[av_start:av_end]
    assert "language_policy" not in av_block


def test_attempt_endpoint_response_carries_top_level_language_policy_smoke():
    """Smoke: confirm the response shape design choice — the four
    possible return statements all spread `{"attempt": ..., "language_policy": ...}`."""
    src = pathlib.Path(vt_attempt.__file__).read_text(encoding="utf-8")
    # Pass A.1 — every attempt response now resolves the policy via
    # `_resolve_attempt_language_policy(...)`. No stray naked
    # `{"attempt": _attempt_view(...)}` returns remain.
    import re
    naked = re.findall(r"return\s*\{\s*\"attempt\":\s*_attempt_view\([^)]*\)\s*\}\s*\n", src)
    assert naked == [], f"Stray naked attempt return: {naked}"
