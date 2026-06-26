"""
tests/test_edutalk_live_v2_corrections.py — V2 six-bug correction regression
groups (backend portion).

Controlled by EDUTALK_PHASE0_1_V2_FINAL_RECONCILIATION_ADDENDUM.md. These are
INTEGRATION-level tests that would have FAILED on the delivered v1 package:

  * Bug 5 — the actual greeting payload passed to ``gem.send`` through
    ``_run_live_bridge`` embeds the VALIDATED server-built greeting script
    exactly once (no independent re-derivation second path).
  * Bug 6 — a completed acknowledged reconnect SKIPS the actual kicker send and
    emits the explicit ``greeting_state=skipped`` frame; an incomplete prior
    greeting restarts with a fresh attempt; a first connection greets normally.
  * Integration closure — the first real interaction ``turn_complete`` after a
    skip still reaches the Surprise Rewards hooks unchanged.

Self-contained fakes: no real Mongo / Gemini / WebSocket / network. Nothing
here touches wallet/payment/GAS, Surprise Rewards grant logic, or Top-Up cap
consumption.
"""
import asyncio
import json
import types

import pytest

import edutalk_live_tools as elt


def run(coro):
    return asyncio.run(coro)


# --------------------------------------------------------------------------- #
# Fakes.                                                                       #
# --------------------------------------------------------------------------- #
class FakeGeminiWS:
    """Records every payload the bridge sends to Gemini. Acts as the async
    context manager returned by ``_ws_lib.connect``."""
    def __init__(self):
        self.sent = []
        self._recv_count = 0

    async def send(self, s):
        self.sent.append(s)

    async def recv(self):
        self._recv_count += 1
        if self._recv_count == 1:
            # setupComplete ack expected by the bridge before greeting.
            return json.dumps({"setupComplete": {}})
        # No further server messages in these tests — block until cancelled.
        await asyncio.sleep(3600)

    async def __aenter__(self):
        return self

    async def __aexit__(self, *exc):
        return False

    def client_content_sends(self):
        """The non-setup clientContent payloads actually sent to Gemini."""
        out = []
        for raw in self.sent:
            try:
                obj = json.loads(raw)
            except Exception:
                continue
            if "clientContent" in obj:
                out.append(obj)
        return out


class FakeClientWS:
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


class FakeSessCol:
    def __init__(self):
        self.doc = {}
        self.updates = []

    async def update_one(self, flt, upd):
        self.updates.append((flt, upd))
        for k, v in (upd.get("$set") or {}).items():
            self.doc[k] = v

        class _R:
            matched_count = 1
            modified_count = 1
        return _R()


class FakeRewardCtx:
    def __init__(self):
        self.last_coach_text = ""
        self.last_student_text = ""
        self.current_exercise_id = None

    def close(self):
        pass


def make_reward_services(calls):
    async def register_exercise(sid, clean_id, ctx, coach_text):
        calls["register"].append(coach_text)
        ctx.current_exercise_id = "ex1"

    async def evaluate_exercise(sid, clean_id, ctx, student_text):
        calls["evaluate"].append(student_text)

    return {"register_exercise": register_exercise,
            "evaluate_exercise": evaluate_exercise}


TURN_COMPLETE = {"serverContent": {"turnComplete": True}}


def base_session(**over):
    s = {
        "session_id": "sidv2",
        "clean_id": "stu1",
        "display_name": "Sok Dara",
        "system_instruction": "SYSTEM INSTRUCTION (may name the teacher).",
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
            "teacher_persona_enabled": False,
            "teacher_display_name": "Teacher Daravuth",
            "mention_teacher_in_greeting": True,
        },
    }
    s.update(over)
    return s


def drive_bridge(monkeypatch, session, *, client_frames=None):
    """Run the real ``_run_live_bridge`` with a fake Gemini + client WS, reward
    module disabled, and a no-op finalize. Returns (gem, client, col)."""
    gem = FakeGeminiWS()
    monkeypatch.setattr(elt, "_reward_mod", None)
    monkeypatch.setattr(elt, "_REWARD_MOD_OK", False)
    monkeypatch.setattr(
        elt, "_ws_lib", types.SimpleNamespace(connect=lambda uri, **kw: gem))
    client = FakeClientWS(client_frames or [{"type": "end",
                                             "reason": "client_end"}])
    col = FakeSessCol()

    async def finalize(session_id, outcome=None, transcript=None,
                       error_reason=None):
        return {"session": {"final_charged": 0, "refund_state": None,
                            "state": "completed"}, "report": {}}

    run(elt._run_live_bridge(client, session, 60, col, finalize=finalize))
    return gem, client, col


# =========================================================================== #
# Bug 5 — validated script reaches the actual gem.send exactly once.          #
# =========================================================================== #
def test_payload_builder_embeds_validated_script_exactly_once():
    session = base_session()
    payload, script, ctx = elt._build_validated_greeting_payload(session)
    text = payload["clientContent"]["turns"][0]["parts"][0]["text"]
    # Validated factual categories present.
    assert "Sok" in script and "42" in script
    assert "Frog and Toad" in script and "Chapter 3" in script
    # The validated script appears EXACTLY ONCE in the actual Gemini payload.
    assert text.count(script) == 1
    # turnComplete boundary preserved.
    assert payload["clientContent"]["turnComplete"] is True


def test_kicker_does_not_independently_re_derive():
    # The kicker must source its facts ONLY from the embedded validated script,
    # not a second derivation path. Embedding the script exactly once is the
    # contract; the points number must come from the script, not a separate
    # re-computation.
    session = base_session()
    script, _ctx = elt._build_greeting_script(session)
    kicker = elt._build_greeting_kicker(session, script)
    assert kicker.count(script) == 1
    # The only occurrence of the points figure comes from the single script.
    assert kicker.count("42") == script.count("42") == 1


def test_safe_fallback_script_still_embedded_once_when_fields_missing():
    # An empty snapshot yields generic-but-complete factual categories; the
    # builder must still embed exactly one validated/fallback script.
    session = {"session_id": "x", "explain_language": "km",
               "greeting_context": {}}
    payload, script, ctx = elt._build_validated_greeting_payload(session)
    text = payload["clientContent"]["turns"][0]["parts"][0]["text"]
    ok, missing = elt._assert_greeting_fields(script, ctx)
    assert ok, f"validated script missing fields: {missing}"
    assert text.count(script) == 1


def test_teacher_mention_once_in_script_and_kicker():
    ctx_snap = {
        "student_first_name": "Sok", "points_value": 42,
        "points_source": "gas_verified_post_reservation",
        "book_title": "Frog and Toad", "chapter_title": "Chapter 3",
        "explain_language": "en",
        "teacher_persona_enabled": True,
        "teacher_display_name": "Teacher Daravuth",
        "mention_teacher_in_greeting": True,
    }
    session = base_session(greeting_context=ctx_snap)
    script, _ = elt._build_greeting_script(session)
    # The server-built script contains exactly ONE natural teacher mention.
    assert script.count("Teacher Daravuth") == 1
    kicker = elt._build_greeting_kicker(session, script)
    # The kicker embeds that script exactly once → teacher named once in the
    # kicker. The kicker instruction itself never re-derives the teacher name.
    assert kicker.count(script) == 1
    assert kicker.count("Teacher Daravuth") == 1
    # The SYSTEM INSTRUCTION may legitimately name the teacher separately as
    # stewardship policy — that must NOT cause a duplicate-mention failure.
    si = elt._build_system_instruction(
        cfg={"teacher_persona_enabled": True,
             "teacher_display_name": "Teacher Daravuth",
             "mention_teacher_in_greeting": True},
        mode_key="book_shadow", mode_cfg={"label": "Book Shadow"},
        student_name="Sok", points_balance=42, book_title="Frog and Toad",
        chapter_title="Chapter 3", current_paragraph="", reading_progress="",
        saved_words=[], previous_reports=[], explain_language="en")
    assert "Teacher Daravuth" in si  # policy mention, independent of the script


def test_run_live_bridge_sends_validated_script_exactly_once(monkeypatch):
    session = base_session()
    expected_script, _ = elt._build_greeting_script(session)
    gem, client, col = drive_bridge(monkeypatch, session)
    greet = gem.client_content_sends()
    assert len(greet) == 1, "exactly one greeting kicker should be sent"
    text = greet[0]["clientContent"]["turns"][0]["parts"][0]["text"]
    assert text.count(expected_script) == 1
    for fact in ("Sok", "42", "Frog and Toad", "Chapter 3"):
        assert fact in text
    # The validated script was persisted and a `requested` frame emitted.
    assert col.doc.get("greeting_script") == expected_script
    assert client.of("greeting_state", "requested")
    assert not client.of("greeting_state", "skipped")


# =========================================================================== #
# Bug 6 — reconnect skip contract.                                            #
# =========================================================================== #
def test_completed_ack_detection():
    # mic_armed (top-level marker) → completed.
    s1 = {"greeting_attempt_id": "att-A", "greeting_mic_armed_at": "T"}
    assert elt._greeting_completed_ack(s1) == {"attempt_id": "att-A",
                                               "via": "mic_armed"}
    # mic_armed (nested ack map) → completed.
    s2 = {"greeting_attempt_id": "att-B",
          "greeting_client_ack_at": {"mic_armed": "T"}}
    assert elt._greeting_completed_ack(s2)["attempt_id"] == "att-B"
    # playback_complete only → completed.
    s3 = {"greeting_attempt_id": "att-C",
          "greeting_client_ack_at": {"playback_complete": "T"}}
    assert elt._greeting_completed_ack(s3) == {"attempt_id": "att-C",
                                               "via": "playback_complete"}
    # requested / first_audio / turn_complete WITHOUT a client ack → incomplete.
    for st in ("requested", "first_audio", "turn_complete"):
        s = {"greeting_attempt_id": "att-D", "greeting_state": st,
             "greeting_state_at": {st: "T"}}
        assert elt._greeting_completed_ack(s) is None
    # No attempt id → cannot skip.
    assert elt._greeting_completed_ack({"greeting_mic_armed_at": "T"}) is None
    assert elt._greeting_completed_ack({}) is None


def test_bridge_skips_kicker_on_completed_reconnect(monkeypatch):
    session = base_session(
        greeting_attempt_id="att-prior",
        greeting_client_ack_at={"mic_armed": "T1"},
        greeting_mic_armed_at="T1")
    gem, client, col = drive_bridge(monkeypatch, session)
    # No greeting kicker was sent to Gemini.
    assert gem.client_content_sends() == []
    # An explicit skipped frame was emitted with the persisted completed id.
    skipped = client.of("greeting_state", "skipped")
    assert skipped, "a skipped frame must be emitted on completed reconnect"
    assert skipped[0]["reason"] == "already_completed"
    assert skipped[0]["attempt_id"] == "att-prior"
    assert skipped[0]["greeting_attempt_id"] == "att-prior"
    # No new requested / kicker.
    assert not client.of("greeting_state", "requested")
    assert not client.of("coach_greeting_sent")
    assert col.doc.get("greeting_state") == "skipped"


def test_bridge_fresh_attempt_on_incomplete_reconnect(monkeypatch):
    # A prior `turn_complete` WITHOUT a client ack is incomplete → restart.
    session = base_session(
        greeting_attempt_id="att-old",
        greeting_state="turn_complete",
        greeting_state_at={"turn_complete": "T"})
    gem, client, col = drive_bridge(monkeypatch, session)
    assert len(gem.client_content_sends()) == 1   # a fresh kicker was sent
    assert client.of("greeting_state", "requested")
    assert not client.of("greeting_state", "skipped")
    # A NEW attempt id (not the stale incomplete one) was issued.
    assert col.doc.get("greeting_attempt_id") != "att-old"


def test_bridge_first_connection_normal_greeting(monkeypatch):
    session = base_session()
    gem, client, col = drive_bridge(monkeypatch, session)
    assert len(gem.client_content_sends()) == 1
    assert client.of("greeting_state", "requested")
    assert not client.of("greeting_state", "skipped")


# =========================================================================== #
# Integration closure — the first real turn after a skip still drives rewards. #
# =========================================================================== #
def test_first_interaction_turn_after_skip_reaches_rewards():
    ws = FakeClientWS([])
    col = FakeSessCol()
    calls = {"register": [], "evaluate": []}
    services = make_reward_services(calls)
    ctx = FakeRewardCtx()
    ctx.last_coach_text = "Please say: I am ready to practise."
    # Post-skip greeting_ctx: the greeting boundary is already complete, so the
    # NEXT turn_complete is a real interaction turn and must reach the reward
    # hooks unchanged.
    greeting_ctx = {"attempt_id": "att-prior", "first_audio_seen": True,
                    "turn_complete": True, "cancelled": True}
    session = {"session_id": "sid", "clean_id": "stu1"}
    run(elt._handle_gemini_message(
        TURN_COMPLETE, ws, [], reward_ctx=ctx, reward_services=services,
        session=session, greeting_ctx=greeting_ctx, sess_col=col,
        session_id="sid"))
    assert calls["register"] == ["Please say: I am ready to practise."]
