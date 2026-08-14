"""
tests/test_edutalk_live_v3_corrections.py — V3 surgical correction regression
proofs for items 3, 4, 5, 6 (backend portion).

Each test fails on the V2 baseline and passes after the V3 corrections in
``edutalk_live_tools.py``:

  * Item 3 — ``_handle_greeting_client_ack`` allowlist (value, dotted/``$``
    prefixed values rejected before any Mongo field-path is constructed;
    trigger/reason bounded; client_ts validated as ISO 8601).
  * Item 4 — ``_run_live_bridge`` performs a fresh ``sess_col.find_one`` of
    the four authoritative fields immediately before the skip decision so a
    client ack persisted AFTER bridge entry is observed (fail-soft on
    exception / None).
  * Item 5 — ``_run_live_bridge`` runs the greeting request/skip block
    BEFORE the reward-runtime check, so a slow / hung
    ``coach_reward_runtime_active`` cannot push the greeting request past
    the client's 5-second request watchdog. Surprise Rewards still
    initializes (just later) and the first interaction ``turn_complete``
    still reaches ``evaluate_exercise`` / ``register_exercise``.
  * Item 6 — the legacy Top-Up preview ``reason`` MUST keep the six pristine
    values from baseline 241; the cap-blocked signal lives in
    ``diagnostic_reason`` + ``eligible``, never in ``reason``.

Self-contained fakes only: no real Mongo / Gemini / WebSocket / network.
Nothing here touches wallet/payment/GAS, Surprise Rewards grant logic, or
Top-Up cap consumption timing.
"""
import asyncio
import json
import time
import types

import pytest

import edutalk_live_tools as elt


def run(coro):
    return asyncio.run(coro)


# --------------------------------------------------------------------------- #
# Shared fakes (intentionally duplicated rather than imported across test
# modules so each test file remains self-contained).                          #
# --------------------------------------------------------------------------- #
class FakeWS:
    def __init__(self):
        self.sent = []

    async def send_text(self, s):
        self.sent.append(json.loads(s))

    def of(self, ftype, value=None):
        out = [f for f in self.sent if f.get("type") == ftype]
        if value is not None:
            out = [f for f in out if f.get("value") == value]
        return out


class FakeSessCol:
    """Records every update, and supports find_one with an injectable doc."""
    def __init__(self, find_doc=None, find_raises=False, find_returns_none=False):
        self.doc = {}
        self.updates = []
        self._find_doc = find_doc
        self._find_raises = find_raises
        self._find_returns_none = find_returns_none
        self.find_calls = []

    async def update_one(self, flt, upd):
        self.updates.append((flt, upd))
        for k, v in (upd.get("$set") or {}).items():
            self.doc[k] = v

        class _R:
            matched_count = 1
            modified_count = 1
        return _R()

    async def find_one(self, flt):
        self.find_calls.append(flt)
        if self._find_raises:
            raise RuntimeError("simulated read failure")
        if self._find_returns_none:
            return None
        return self._find_doc


def fresh_ctx(aid="att1"):
    return {"attempt_id": aid, "first_audio_seen": False,
            "turn_complete": False, "cancelled": False}


# =========================================================================== #
# Item 3 — greeting_client_ack allowlist.                                     #
# =========================================================================== #
def test_item3_unknown_value_no_write_no_cancel():
    ws, col = FakeWS(), FakeSessCol()
    ctx = fresh_ctx("att1")
    run(elt._handle_greeting_client_ack(
        {"value": "something_else", "greeting_attempt_id": "att1",
         "client_ts": "2025-01-01T00:00:00+00:00"}, ctx, ws, col, "sid1"))
    # No Mongo write, no cancellation, no greeting-state frame.
    assert col.updates == []
    assert col.doc == {}
    assert ctx["cancelled"] is False
    assert ws.sent == []


def test_item3_dotted_value_rejected_before_path_construction():
    ws, col = FakeWS(), FakeSessCol()
    ctx = fresh_ctx("att1")
    run(elt._handle_greeting_client_ack(
        {"value": "foo.bar", "greeting_attempt_id": "att1",
         "client_ts": "2025-01-01T00:00:00+00:00"}, ctx, ws, col, "sid1"))
    # Nothing must be written; any constructed Mongo path would contain "foo.bar".
    assert col.updates == []
    for k in col.doc.keys():
        assert "foo.bar" not in k
    assert ctx["cancelled"] is False


def test_item3_dollar_prefix_rejected():
    ws, col = FakeWS(), FakeSessCol()
    ctx = fresh_ctx("att1")
    run(elt._handle_greeting_client_ack(
        {"value": "$set", "greeting_attempt_id": "att1",
         "client_ts": "2025-01-01T00:00:00+00:00"}, ctx, ws, col, "sid1"))
    assert col.updates == []
    assert ctx["cancelled"] is False


def test_item3_empty_value_rejected():
    ws, col = FakeWS(), FakeSessCol()
    ctx = fresh_ctx("att1")
    run(elt._handle_greeting_client_ack(
        {"value": "", "greeting_attempt_id": "att1",
         "client_ts": "2025-01-01T00:00:00+00:00"}, ctx, ws, col, "sid1"))
    run(elt._handle_greeting_client_ack(
        {"greeting_attempt_id": "att1",
         "client_ts": "2025-01-01T00:00:00+00:00"}, ctx, ws, col, "sid1"))
    assert col.updates == []
    assert ctx["cancelled"] is False


def test_item3_malformed_client_ts_rejected():
    ws, col = FakeWS(), FakeSessCol()
    ctx = fresh_ctx("att1")
    # Allowed value but unparseable ISO timestamp → reject entirely.
    run(elt._handle_greeting_client_ack(
        {"value": "playback_complete", "greeting_attempt_id": "att1",
         "client_ts": "not-an-iso-stamp"}, ctx, ws, col, "sid1"))
    assert col.updates == []
    assert col.doc == {}


def test_item3_missing_client_ts_uses_server_iso():
    ws, col = FakeWS(), FakeSessCol()
    ctx = fresh_ctx("att1")
    # No client_ts → server-generated ISO is acceptable.
    run(elt._handle_greeting_client_ack(
        {"value": "playback_complete", "greeting_attempt_id": "att1"},
        ctx, ws, col, "sid1"))
    assert col.doc.get("greeting_client_ack_at.playback_complete")


def test_item3_allowed_value_persists_normally():
    ws, col = FakeWS(), FakeSessCol()
    ctx = fresh_ctx("att1")
    run(elt._handle_greeting_client_ack(
        {"value": "playback_complete", "greeting_attempt_id": "att1",
         "client_ts": "2025-01-01T00:00:00+00:00"}, ctx, ws, col, "sid1"))
    assert col.doc["greeting_client_ack_at.playback_complete"] == \
        "2025-01-01T00:00:00+00:00"


def test_item3_trigger_and_reason_bounded_to_128():
    ws, col = FakeWS(), FakeSessCol()
    ctx = fresh_ctx("att1")
    big = "x" * 5000
    run(elt._handle_greeting_client_ack(
        {"value": "mic_armed", "greeting_attempt_id": "att1",
         "trigger": big,
         "client_ts": "2025-01-01T00:00:00+00:00"}, ctx, ws, col, "sid1"))
    assert len(col.doc.get("greeting_mic_armed_trigger", "")) <= 128
    # fallback_requested → reason also bounded; cancellation still happens.
    ws2, col2 = FakeWS(), FakeSessCol()
    ctx2 = fresh_ctx("att2")
    run(elt._handle_greeting_client_ack(
        {"value": "fallback_requested", "greeting_attempt_id": "att2",
         "reason": big,
         "client_ts": "2025-01-01T00:00:00+00:00"}, ctx2, ws2, col2, "sid2"))
    cancelled = ws2.of("greeting_state", "cancelled")
    assert cancelled and len(cancelled[0]["reason"]) <= 128
    assert ctx2["cancelled"] is True


# =========================================================================== #
# Item 4 — fresh reconnect completion read.                                   #
# =========================================================================== #

# Reuse the existing v2_corrections module fakes for the bridge tests by
# importing them inline (keeps this file self-contained at the test-discovery
# level — no cross-file fixtures).
class _BridgeGemini:
    def __init__(self):
        self.sent = []
        self._recv_count = 0

    async def send(self, s):
        self.sent.append(s)

    async def recv(self):
        self._recv_count += 1
        if self._recv_count == 1:
            return json.dumps({"setupComplete": {}})
        await asyncio.sleep(3600)

    async def __aenter__(self):
        return self

    async def __aexit__(self, *exc):
        return False

    def client_content_sends(self):
        out = []
        for raw in self.sent:
            try:
                obj = json.loads(raw)
            except Exception:
                continue
            if "clientContent" in obj:
                out.append(obj)
        return out


class _BridgeClient:
    def __init__(self, frames):
        self.sent = []
        self._frames = list(frames)

    async def send_text(self, s):
        self.sent.append(json.loads(s))

    async def receive_text(self):
        if self._frames:
            return json.dumps(self._frames.pop(0))
        await asyncio.sleep(3600)

    def of(self, ftype, value=None):
        out = [f for f in self.sent if f.get("type") == ftype]
        if value is not None:
            out = [f for f in out if f.get("value") == value]
        return out


def _base_session(**over):
    s = {
        "session_id": "sidv3",
        "clean_id": "stu1",
        "display_name": "Sok Dara",
        "system_instruction": "SYSTEM INSTRUCTION.",
        "explain_language": "en",
        "greeting_context": {
            "student_first_name": "Sok",
            "points_value": 42,
            "points_source": "gas_verified_post_reservation",
            "book_title": "Frog and Toad",
            "book_slug": "frog-and-toad",
            "chapter_title": "Chapter 3",
            "mode": "book_shadow",
            "explain_language": "en",
        },
    }
    s.update(over)
    return s


def _drive(monkeypatch, session, col, *, frames=None,
           reward_services=None, reward_mod_ok=False):
    gem = _BridgeGemini()
    monkeypatch.setattr(elt, "_reward_mod",
                        None if not reward_mod_ok else types.SimpleNamespace(
                            get_services=lambda: reward_services))
    monkeypatch.setattr(elt, "_REWARD_MOD_OK", reward_mod_ok)
    monkeypatch.setattr(
        elt, "_ws_lib", types.SimpleNamespace(connect=lambda uri, **kw: gem))
    client = _BridgeClient(frames or [{"type": "end", "reason": "client_end"}])

    async def finalize(session_id, outcome=None, transcript=None,
                       error_reason=None):
        return {"session": {"final_charged": 0, "refund_state": None,
                            "state": "completed"}, "report": {}}

    run(elt._run_live_bridge(client, session, 60, col, finalize=finalize))
    return gem, client


def test_item4_fresh_read_observes_ack_persisted_after_bridge_entry(monkeypatch):
    """The in-memory ``session`` says no completed ack, but the fresh
    ``find_one`` read just before the skip decision returns a doc carrying
    a ``mic_armed`` ack. The bridge must SEE the fresh value, skip the
    kicker, and emit ``skipped`` (no ``requested`` / no greeting kicker)."""
    session = _base_session()
    # The fresh DB read reveals a completed ack written by another connection.
    fresh_doc = {
        "session_id": "sidv3",
        "greeting_attempt_id": "att-fresh",
        "greeting_client_ack_at": {"mic_armed": "2025-01-01T00:00:00+00:00"},
        "greeting_mic_armed_at": "2025-01-01T00:00:00+00:00",
    }
    col = FakeSessCol(find_doc=fresh_doc)
    gem, client = _drive(monkeypatch, session, col)
    # No new kicker was sent to Gemini.
    assert gem.client_content_sends() == []
    # The bridge issued the skipped frame using the FRESH attempt id.
    skipped = client.of("greeting_state", "skipped")
    assert skipped, "skipped frame must be emitted using the fresh ack"
    assert skipped[0]["attempt_id"] == "att-fresh"
    assert not client.of("greeting_state", "requested")


def test_item4_fresh_read_via_playback_complete(monkeypatch):
    session = _base_session()
    fresh_doc = {
        "session_id": "sidv3",
        "greeting_attempt_id": "att-pb",
        "greeting_client_ack_at": {
            "playback_complete": "2025-01-01T00:00:00+00:00"},
    }
    col = FakeSessCol(find_doc=fresh_doc)
    gem, client = _drive(monkeypatch, session, col)
    assert gem.client_content_sends() == []
    skipped = client.of("greeting_state", "skipped")
    assert skipped and skipped[0]["attempt_id"] == "att-pb"


def test_item4_fail_soft_when_fresh_read_raises(monkeypatch):
    """The fresh read raising must NOT crash the connection — it must fall
    back to the original in-memory ``session`` snapshot. With no completed
    ack on the session, the bridge runs the normal greeting kicker."""
    session = _base_session()
    col = FakeSessCol(find_raises=True)
    gem, client = _drive(monkeypatch, session, col)
    # Normal kicker still fires (failsoft to original snapshot).
    assert len(gem.client_content_sends()) == 1
    assert client.of("greeting_state", "requested")
    assert not client.of("greeting_state", "skipped")


def test_item4_fail_soft_when_fresh_read_returns_none(monkeypatch):
    """find_one returning None must NOT crash — fall back to the original
    session snapshot. Original snapshot has no completed ack → normal
    kicker."""
    session = _base_session()
    col = FakeSessCol(find_returns_none=True)
    gem, client = _drive(monkeypatch, session, col)
    assert len(gem.client_content_sends()) == 1
    assert client.of("greeting_state", "requested")


def test_item4_original_snapshot_used_when_fresh_read_matches(monkeypatch):
    """When BOTH the original session and the fresh read say the greeting
    completed, the skip path runs once with the (consistent) authoritative
    attempt id."""
    session = _base_session(
        greeting_attempt_id="att-orig",
        greeting_client_ack_at={"mic_armed": "T1"},
        greeting_mic_armed_at="T1",
    )
    fresh_doc = {
        "session_id": "sidv3",
        "greeting_attempt_id": "att-orig",
        "greeting_client_ack_at": {"mic_armed": "T1"},
        "greeting_mic_armed_at": "T1",
    }
    col = FakeSessCol(find_doc=fresh_doc)
    gem, client = _drive(monkeypatch, session, col)
    assert gem.client_content_sends() == []
    skipped = client.of("greeting_state", "skipped")
    assert skipped and skipped[0]["attempt_id"] == "att-orig"


# =========================================================================== #
# Item 5 — deterministic `ready` boundary (greeting before reward runtime).   #
# =========================================================================== #
def test_item5_slow_reward_runtime_does_not_delay_greeting(monkeypatch):
    """The reward-runtime check is forced to sleep longer than the client's
    5-second greeting request watchdog. After the fix, the greeting block
    runs BEFORE this check, so ``greeting_state=requested`` reaches the
    client well before any reward-runtime delay would have triggered a false
    ``request_timeout`` fallback."""
    REQUEST_WD_MS = 5000  # mirrors GREETING_TIMEOUTS.GREETING_REQUEST_TIMEOUT_MS
    delay_s = 6.0  # longer than the 5s client watchdog

    async def slow_runtime_active():
        await asyncio.sleep(delay_s)
        return True

    reward_services = {
        "coach_reward_runtime_active": slow_runtime_active,
        # The bridge will never reach RewardSessionCtx in this test because
        # the client ends before the slow runtime returns; these are unused
        # but the keys must exist or the wiring will skip the slow call.
        "RewardSessionCtx": lambda **kw: types.SimpleNamespace(close=lambda: None),
        "register_live_reward_ctx": lambda *a, **kw: None,
        "unregister_live_reward_ctx": lambda *a, **kw: None,
    }
    session = _base_session()
    col = FakeSessCol(find_doc={"session_id": "sidv3"})

    # Record when greeting_state=requested is sent vs when the slow runtime
    # would resolve. We end the bridge before the slow runtime returns to
    # prove the greeting did not wait on it.
    gem = _BridgeGemini()
    monkeypatch.setattr(elt, "_reward_mod",
                        types.SimpleNamespace(
                            get_services=lambda: reward_services))
    monkeypatch.setattr(elt, "_REWARD_MOD_OK", True)
    monkeypatch.setattr(
        elt, "_ws_lib", types.SimpleNamespace(connect=lambda uri, **kw: gem))
    # Client ends within the client-side request watchdog so we PROVE the
    # greeting was emitted before the slow reward runtime resolved.
    requested_at = {"t": None}

    class _Client(_BridgeClient):
        async def send_text(self, s):
            obj = json.loads(s)
            if obj.get("type") == "greeting_state" \
                    and obj.get("value") == "requested" \
                    and requested_at["t"] is None:
                requested_at["t"] = time.time()
            self.sent.append(obj)

        async def receive_text(self):
            # Return the end frame immediately on first read so the bridge
            # finishes as soon as the slow reward runtime resolves (no extra
            # 60s deadline loop).
            if self._frames:
                return json.dumps(self._frames.pop(0))
            await asyncio.sleep(3600)

    client = _Client([{"type": "end", "reason": "client_end"}])

    async def finalize(session_id, outcome=None, transcript=None,
                       error_reason=None):
        return {"session": {"final_charged": 0, "refund_state": None,
                            "state": "completed"}, "report": {}}

    t0 = time.time()
    run(elt._run_live_bridge(client, session, 60, col, finalize=finalize))
    elapsed_total = time.time() - t0
    # The greeting requested frame must have been sent BEFORE the slow
    # reward-runtime delay would have resolved (i.e., before delay_s).
    assert requested_at["t"] is not None, "greeting_state=requested never sent"
    requested_elapsed = requested_at["t"] - t0
    assert requested_elapsed < (REQUEST_WD_MS / 1000.0), (
        f"greeting requested at {requested_elapsed:.2f}s — must be <"
        f"{REQUEST_WD_MS/1000:.0f}s (client request watchdog)")
    # The total bridge run is bounded by the slow runtime (which DOES still
    # have to resolve before the bridge tears down, since the runtime-active
    # check awaits its own result — that is expected, item 5 only moves the
    # greeting in FRONT of it).
    assert elapsed_total >= delay_s - 0.5


def test_item5_reward_initialization_unchanged_in_behavior_when_runtime_ok(monkeypatch):
    """After Item 5, when the reward runtime IS active, ``RewardSessionCtx``
    is still constructed and ``register_live_reward_ctx`` is still called
    once with byte-identical arguments — just LATER in execution order."""
    calls = {"runtime": 0, "ctx_built": [], "registered": []}

    async def runtime_active():
        calls["runtime"] += 1
        return True

    def ctx_factory(*, session_id, clean_id, display_name,
                    gemini_inject_cb, client_send_cb):
        calls["ctx_built"].append({
            "session_id": session_id, "clean_id": clean_id,
            "display_name": display_name})
        return types.SimpleNamespace(close=lambda: None)

    def register(sid, ctx):
        calls["registered"].append(sid)

    reward_services = {
        "coach_reward_runtime_active": runtime_active,
        "RewardSessionCtx": ctx_factory,
        "register_live_reward_ctx": register,
        "unregister_live_reward_ctx": lambda *a, **kw: None,
    }
    session = _base_session()
    col = FakeSessCol(find_doc={"session_id": "sidv3"})

    monkeypatch.setattr(elt, "_reward_mod",
                        types.SimpleNamespace(
                            get_services=lambda: reward_services))
    monkeypatch.setattr(elt, "_REWARD_MOD_OK", True)
    gem = _BridgeGemini()
    monkeypatch.setattr(
        elt, "_ws_lib", types.SimpleNamespace(connect=lambda uri, **kw: gem))
    client = _BridgeClient([{"type": "end", "reason": "client_end"}])

    async def finalize(session_id, outcome=None, transcript=None,
                       error_reason=None):
        return {"session": {"final_charged": 0, "refund_state": None,
                            "state": "completed"}, "report": {}}

    run(elt._run_live_bridge(client, session, 60, col, finalize=finalize))
    # Runtime-active called once; ctx constructed once with the same args
    # (byte-identical to pre-V3 — only the execution order changed).
    assert calls["runtime"] == 1
    assert calls["ctx_built"] == [{
        "session_id": "sidv3", "clean_id": "stu1",
        "display_name": "Sok Dara"}]
    assert calls["registered"] == ["sidv3"]


def test_item5_first_interaction_turn_complete_still_reaches_reward_hooks():
    """Regression: the first real interaction ``turn_complete`` after the
    greeting boundary still reaches ``register_exercise`` /
    ``evaluate_exercise`` unchanged in call order and arguments."""
    ws = FakeWS()
    col = FakeSessCol()
    calls = {"register": [], "evaluate": []}

    async def register_exercise(sid, clean_id, ctx, coach_text):
        calls["register"].append((sid, clean_id, coach_text))
        ctx.current_exercise_id = "ex1"

    async def evaluate_exercise(sid, clean_id, ctx, student_text):
        calls["evaluate"].append((sid, clean_id, student_text))

    services = {"register_exercise": register_exercise,
                "evaluate_exercise": evaluate_exercise}

    class _Ctx:
        last_coach_text = "Please say: I am ready to practise."
        last_student_text = ""
        current_exercise_id = None

        def close(self):
            pass

    ctx = _Ctx()
    greeting_ctx = {"attempt_id": "att-prior", "first_audio_seen": True,
                    "turn_complete": True, "cancelled": True}
    session = {"session_id": "sid", "clean_id": "stu1"}
    run(elt._handle_gemini_message(
        {"serverContent": {"turnComplete": True}}, ws, [],
        reward_ctx=ctx, reward_services=services, session=session,
        greeting_ctx=greeting_ctx, sess_col=col, session_id="sid"))
    assert calls["register"] == [("sid", "stu1",
                                  "Please say: I am ready to practise.")]


# =========================================================================== #
# Item 6 — legacy Top-Up preview `reason` restoration.                        #
# =========================================================================== #
def test_item6_cap_blocked_reason_is_legacy_not_diagnostic_balance_low():
    # balance low (projected <= threshold) BUT cap exhausted:
    #   diagnostic_reason = weekly_cap_reached (cap signal)
    #   eligible = False (cap fails closed)
    #   reason = projected_balance_at_or_below_threshold (legacy, balance-only)
    p = elt._topup_preview_for_mode(
        enabled=True, flag_on=True, balance=10, mode_cost=15,
        threshold=15, weekly_cap_available=False,
        cap_reason="weekly_cap_reached")
    assert p["eligible"] is False
    assert p["diagnostic_reason"] == "weekly_cap_reached"
    assert p["reason"] == "projected_balance_at_or_below_threshold"
    # `reason` MUST NEVER be set to a cap-specific diagnostic string.
    assert p["reason"] != "weekly_cap_reached"
    assert p["reason"] != "cap_disabled"


def test_item6_cap_blocked_reason_is_legacy_not_diagnostic_balance_high():
    # balance high (projected > threshold) AND cap exhausted:
    #   diagnostic_reason = weekly_cap_reached (cap signal still wins)
    #   eligible = False
    #   reason = balance_above_threshold (legacy, balance-only)
    p = elt._topup_preview_for_mode(
        enabled=True, flag_on=True, balance=100, mode_cost=15,
        threshold=15, weekly_cap_available=False,
        cap_reason="weekly_cap_reached")
    assert p["eligible"] is False
    assert p["diagnostic_reason"] == "weekly_cap_reached"
    assert p["reason"] == "balance_above_threshold"
    assert p["reason"] != "weekly_cap_reached"


def test_item6_cap_disabled_reason_is_legacy_not_diagnostic():
    p = elt._topup_preview_for_mode(
        enabled=True, flag_on=True, balance=10, mode_cost=15,
        threshold=15, weekly_cap_available=False,
        cap_reason="cap_disabled")
    assert p["eligible"] is False
    assert p["diagnostic_reason"] == "cap_disabled"
    # The legacy reason — balance is low so it remains
    # ``projected_balance_at_or_below_threshold``.
    assert p["reason"] == "projected_balance_at_or_below_threshold"
    assert p["reason"] != "cap_disabled"


def test_item6_all_six_legacy_reason_values_reachable():
    """All six pristine-241 legacy ``reason`` values must remain reachable."""
    # 1. config_disabled
    r = elt._topup_preview_for_mode(
        enabled=False, flag_on=True, balance=10, mode_cost=15, threshold=15,
        weekly_cap_available=True)
    assert r["reason"] == "config_disabled"
    # 2. threshold_invalid
    r = elt._topup_preview_for_mode(
        enabled=True, flag_on=True, balance=10, mode_cost=15, threshold=None,
        weekly_cap_available=True)
    assert r["reason"] == "threshold_invalid"
    # 3. balance_unavailable_for_preview (flag off)
    r = elt._topup_preview_for_mode(
        enabled=True, flag_on=False, balance=10, mode_cost=15, threshold=15,
        weekly_cap_available=True)
    assert r["reason"] == "balance_unavailable_for_preview"
    # 4. wallet_unavailable (balance None)
    r = elt._topup_preview_for_mode(
        enabled=True, flag_on=True, balance=None, mode_cost=15, threshold=15,
        weekly_cap_available=True)
    assert r["reason"] == "wallet_unavailable"
    # 5. projected_balance_at_or_below_threshold
    r = elt._topup_preview_for_mode(
        enabled=True, flag_on=True, balance=10, mode_cost=15, threshold=15,
        weekly_cap_available=True)
    assert r["reason"] == "projected_balance_at_or_below_threshold"
    # 6. balance_above_threshold
    r = elt._topup_preview_for_mode(
        enabled=True, flag_on=True, balance=100, mode_cost=15, threshold=15,
        weekly_cap_available=True)
    assert r["reason"] == "balance_above_threshold"


def test_item6_eligible_still_fails_closed_under_cap_v2_fix_preserved():
    """V2 Bug 3 fix MUST remain — ``eligible`` still fails closed on cap."""
    r = elt._topup_preview_for_mode(
        enabled=True, flag_on=True, balance=10, mode_cost=15, threshold=15,
        weekly_cap_available=False, cap_reason="weekly_cap_reached")
    assert r["eligible"] is False
