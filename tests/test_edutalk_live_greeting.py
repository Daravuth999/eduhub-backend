"""
tests/test_edutalk_live_greeting.py — Phase 0A attempt-scoped greeting lifecycle.

Self-contained fakes (no real Mongo / Gemini / WebSocket). Proves the locked
greeting decisions from EMERGENT_PHASE0_1_REFINED_BUILD_PROMPT.md §D
(backend greeting tests 1–12; teacher-block tests 13–14 live alongside the
Phase 1 teacher-persona suite). Nothing here touches wallet/payment/GAS,
Surprise Rewards grant logic, or Top-Up cap consumption.
"""
import asyncio
import json

import edutalk_live_tools as elt


def run(coro):
    return asyncio.run(coro)


# --------------------------------------------------------------------------- #
# Minimal fakes.                                                               #
# --------------------------------------------------------------------------- #
class FakeWS:
    """Captures every JSON frame the bridge would send to the browser."""
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
    """In-memory session collection. Stores $set keys flat (dotted keys kept
    literal) so tests can assert exact persisted markers."""
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

    return {
        "register_exercise": register_exercise,
        "evaluate_exercise": evaluate_exercise,
    }


def audio_msg(data="QUJD"):
    return {"serverContent": {"modelTurn": {"parts": [
        {"inlineData": {"data": data, "mimeType": "audio/pcm;rate=24000"}}]}}}


TURN_COMPLETE = {"serverContent": {"turnComplete": True}}


def fresh_ctx(attempt_id="att1"):
    return {"attempt_id": attempt_id, "first_audio_seen": False,
            "turn_complete": False, "cancelled": False}


# --------------------------------------------------------------------------- #
# 1 — successful kicker → requested + compatibility event (+ persisted).       #
# --------------------------------------------------------------------------- #
def test_requested_emits_attempt_and_compat_event():
    ws, col = FakeWS(), FakeSessCol()
    run(elt._emit_greeting_requested(ws, col, "sid1", "att123"))
    req = ws.of("greeting_state", "requested")
    assert req and req[0]["greeting_attempt_id"] == "att123"
    compat = ws.of("coach_greeting_sent")
    assert compat and compat[0]["greeting_attempt_id"] == "att123"
    assert col.doc["greeting_state"] == "requested"
    assert col.doc["greeting_attempt_id"] == "att123"


# --------------------------------------------------------------------------- #
# 2 — kicker send failure → failed emitted/persisted; helper never raises.     #
# --------------------------------------------------------------------------- #
def test_failed_emits_and_persists_without_aborting():
    ws, col = FakeWS(), FakeSessCol()
    run(elt._emit_greeting_failed(ws, col, "sid1", "att123"))
    failed = ws.of("greeting_state", "failed")
    assert failed and failed[0]["reason"] == "kicker_send_failed"
    assert col.doc["greeting_state"] == "failed"
    assert col.doc["greeting_fallback_reason"] == "kicker_send_failed"
    # The bridge can still process subsequent Gemini messages after a failure.
    run(elt._handle_gemini_message(audio_msg(), ws, [],
                                   greeting_ctx=fresh_ctx(), sess_col=col,
                                   session_id="sid1"))
    assert ws.of("audio")  # session continues normally


# --------------------------------------------------------------------------- #
# 3 — first greeting audio → first_audio once, tagged with the attempt id.     #
# --------------------------------------------------------------------------- #
def test_first_audio_emitted_once_and_tagged():
    ws, col = FakeWS(), FakeSessCol()
    ctx = fresh_ctx("attX")
    run(elt._handle_gemini_message(audio_msg(), ws, [], greeting_ctx=ctx,
                                   sess_col=col, session_id="sid1"))
    audio = ws.of("audio")
    assert audio and audio[0]["greeting_attempt_id"] == "attX"
    assert len(ws.of("greeting_state", "first_audio")) == 1
    # A second audio chunk does NOT emit first_audio again.
    ws.sent.clear()
    run(elt._handle_gemini_message(audio_msg(), ws, [], greeting_ctx=ctx,
                                   sess_col=col, session_id="sid1"))
    assert len(ws.of("greeting_state", "first_audio")) == 0
    assert ws.of("audio")[0]["greeting_attempt_id"] == "attX"


# --------------------------------------------------------------------------- #
# 4 — greeting turn still sends the GENERIC turn_complete frame.               #
# 5 — greeting turn ALSO emits the parallel attempt-scoped turn_complete.      #
# --------------------------------------------------------------------------- #
def test_greeting_turn_sends_generic_and_parallel_turn_complete():
    ws, col = FakeWS(), FakeSessCol()
    ctx = fresh_ctx("attY")
    run(elt._handle_gemini_message(TURN_COMPLETE, ws, [], greeting_ctx=ctx,
                                   sess_col=col, session_id="sid1"))
    assert ws.of("turn_complete")                       # generic (4)
    par = ws.of("greeting_state", "turn_complete")
    assert par and par[0]["greeting_attempt_id"] == "attY"   # parallel (5)
    assert col.doc["greeting_state"] == "turn_complete"
    assert ctx["turn_complete"] is True


# --------------------------------------------------------------------------- #
# 6 — greeting turn does NOT register/evaluate a Surprise Reward exercise.     #
# --------------------------------------------------------------------------- #
def test_greeting_turn_skips_reward_hooks():
    ws, col = FakeWS(), FakeSessCol()
    ctx = fresh_ctx()
    calls = {"register": [], "evaluate": []}
    rctx = FakeRewardCtx()
    rctx.last_coach_text = "Say hello"
    rctx.current_exercise_id = "exPrev"
    rctx.last_student_text = "Hi"
    run(elt._handle_gemini_message(
        TURN_COMPLETE, ws, [], reward_ctx=rctx,
        reward_services=make_reward_services(calls),
        session={"session_id": "sid1", "clean_id": "alice"},
        greeting_ctx=ctx, sess_col=col, session_id="sid1"))
    assert calls["register"] == []
    assert calls["evaluate"] == []


# --------------------------------------------------------------------------- #
# 7 — first REAL interaction turn after greeting → register_exercise once,     #
#     unchanged coach text.                                                    #
# 8 — subsequent student response turn → evaluate_exercise once, unchanged.    #
# --------------------------------------------------------------------------- #
def test_post_greeting_turns_drive_reward_hooks_unchanged():
    ws, col = FakeWS(), FakeSessCol()
    calls = {"register": [], "evaluate": []}
    rctx = FakeRewardCtx()
    services = make_reward_services(calls)
    sess = {"session_id": "sid1", "clean_id": "alice"}
    greeting_done = {"attempt_id": "a", "first_audio_seen": True,
                     "turn_complete": True, "cancelled": False}

    # (7) First real coach turn after greeting opens an exercise once.
    rctx.last_coach_text = "Please say: I like apples"
    run(elt._handle_gemini_message(
        TURN_COMPLETE, ws, [], reward_ctx=rctx, reward_services=services,
        session=sess, greeting_ctx=greeting_done, sess_col=col,
        session_id="sid1"))
    assert calls["register"] == ["Please say: I like apples"]
    assert calls["evaluate"] == []

    # (8) Student responds → next turn evaluates that exercise once.
    rctx.last_student_text = "I like apples"
    run(elt._handle_gemini_message(
        TURN_COMPLETE, ws, [], reward_ctx=rctx, reward_services=services,
        session=sess, greeting_ctx=greeting_done, sess_col=col,
        session_id="sid1"))
    assert calls["evaluate"] == ["I like apples"]
    assert len(calls["register"]) == 1  # still exactly one register


# --------------------------------------------------------------------------- #
# 9 — mismatched client ack is ignored.                                        #
# --------------------------------------------------------------------------- #
def test_mismatched_client_ack_ignored():
    ws, col = FakeWS(), FakeSessCol()
    ctx = fresh_ctx("att1")
    run(elt._handle_greeting_client_ack(
        {"type": "greeting_client_ack", "value": "playback_complete",
         "greeting_attempt_id": "WRONG"}, ctx, ws, col, "sid1"))
    assert ctx["cancelled"] is False
    assert col.updates == []
    assert ws.sent == []


# --------------------------------------------------------------------------- #
# 10 — matching playback_complete + mic_armed acks are persisted.              #
# --------------------------------------------------------------------------- #
def test_matching_acks_persisted():
    ws, col = FakeWS(), FakeSessCol()
    ctx = fresh_ctx("att1")
    # V3 item 3 — client_ts must be a parseable ISO 8601 timestamp; the test
    # uses real ISO values (was placeholder "T1"/"T2" against the pristine
    # lax-parse contract).
    run(elt._handle_greeting_client_ack(
        {"type": "greeting_client_ack", "value": "playback_complete",
         "greeting_attempt_id": "att1",
         "client_ts": "2025-01-01T00:00:00+00:00"}, ctx, ws, col, "sid1"))
    assert col.doc["greeting_client_ack_at.playback_complete"] == "2025-01-01T00:00:00+00:00"
    run(elt._handle_greeting_client_ack(
        {"type": "greeting_client_ack", "value": "mic_armed",
         "greeting_attempt_id": "att1", "trigger": "playback_complete",
         "client_ts": "2025-01-01T00:00:01+00:00"}, ctx, ws, col, "sid1"))
    assert col.doc["greeting_mic_armed_at"] == "2025-01-01T00:00:01+00:00"
    assert col.doc["greeting_mic_armed_trigger"] == "playback_complete"


# --------------------------------------------------------------------------- #
# 11 — matching fallback marks cancelled + suppresses later greeting audio.    #
# --------------------------------------------------------------------------- #
def test_fallback_cancels_and_suppresses_later_audio():
    ws, col = FakeWS(), FakeSessCol()
    ctx = {"attempt_id": "att1", "first_audio_seen": True,
           "turn_complete": False, "cancelled": False}
    run(elt._handle_greeting_client_ack(
        {"type": "greeting_client_ack", "value": "fallback_requested",
         "greeting_attempt_id": "att1", "reason": "turn_complete_timeout"},
        ctx, ws, col, "sid1"))
    assert ctx["cancelled"] is True
    cancelled = ws.of("greeting_state", "cancelled")
    assert cancelled and cancelled[0]["reason"] == "turn_complete_timeout"
    # Later greeting audio for the cancelled attempt is suppressed.
    ws.sent.clear()
    run(elt._handle_gemini_message(audio_msg(), ws, [], greeting_ctx=ctx,
                                   sess_col=col, session_id="sid1"))
    assert ws.of("audio") == []


# --------------------------------------------------------------------------- #
# 12 — _assert_greeting_fields covers ≥20 optional-data combinations and ALWAYS #
#      preserves the four factual categories; the fallback path is safe too.    #
# --------------------------------------------------------------------------- #
def test_assert_greeting_fields_many_combinations():
    names = ["", "Sok", "Dara Roth"]
    points = [None, 0, 7, 1234]
    books = [{"book_title": "Grade 5 English"},
             {"book_slug": "my-first-reader"},
             {}]
    chapters = ["", "Chapter 3: Greetings"]
    langs = ["km", "en"]

    combos = 0
    for nm in names:
        for pv in points:
            for bk in books:
                for ch in chapters:
                    lang = langs[combos % len(langs)]
                    snap = {"student_first_name": nm,
                            "points_value": pv,
                            "points_source": ("unavailable" if pv is None
                                              else "gas_verified_post_reservation"),
                            "chapter_title": ch,
                            "explain_language": lang}
                    snap.update(bk)
                    session = {"greeting_context": snap}
                    script, ctx = elt._build_greeting_script(session)
                    ok, missing = elt._assert_greeting_fields(script, ctx)
                    assert ok, f"missing={missing} for snap={snap}"
                    combos += 1
    assert combos >= 20

    # A deliberately broken script is detected as missing, and the safe
    # fallback restores all four categories.
    _, ctx = elt._build_greeting_script(
        {"greeting_context": {"student_first_name": "Sok",
                              "points_value": 42,
                              "points_source": "gas_verified_post_reservation",
                              "book_title": "Reader", "chapter_title": "Ch 1"}})
    bad = "Hello."
    ok, missing = elt._assert_greeting_fields(bad, ctx)
    assert not ok and set(missing) >= {"student_name", "points", "book", "chapter"}
    fixed = elt._safe_fallback_greeting_script(ctx)
    ok2, missing2 = elt._assert_greeting_fields(fixed, ctx)
    assert ok2 and missing2 == []


# --------------------------------------------------------------------------- #
# Phase 1 — Teacher Daravuth persona (system instruction + name validation).   #
# §D backend greeting tests 13–14.                                             #
# --------------------------------------------------------------------------- #
def _si(cfg):
    return elt._build_system_instruction(
        cfg=cfg, mode_key="book_shadow", mode_cfg={"label": "Book Shadow"},
        student_name="Sok", points_balance=None, book_title="",
        chapter_title="", current_paragraph="", reading_progress="",
        saved_words=[], previous_reports=[])


# 13 — teacher block absent by default; present only when the gate is enabled.
def test_teacher_block_dark_by_default_present_when_enabled():
    base = elt._sanitise_config({})            # persona OFF (default)
    assert base["teacher_persona_enabled"] is False
    assert "<<TEACHER_PERSONA>>" not in _si(base)

    on = elt._sanitise_config({"teacher_persona_enabled": True})
    si = _si(on)
    assert "<<TEACHER_PERSONA>>" in si and "<<END_TEACHER_PERSONA>>" in si
    assert "Teacher Daravuth" in si
    assert "You are NOT Teacher Daravuth" in si
    assert "never claim the teacher" in si.lower()
    # mention defaults ON → one greeting mention line is present.
    assert "at the very start of the session" in si.lower()

    off_mention = elt._sanitise_config(
        {"teacher_persona_enabled": True, "mention_teacher_in_greeting": False})
    si2 = _si(off_mention)
    assert "Do not mention the teacher by name" in si2


# 14 — Khmer names pass; control chars / newlines / braces / injection fail.
def test_teacher_name_validation_khmer_pass_injection_fail():
    # Khmer (letters + coeng combining marks) passes.
    ok, _ = elt._teacher_name_ok("គ្រូ ដារ៉ាវុធ")
    assert ok
    ok, _ = elt._validate_teacher_persona_fields(
        {"teacher_display_name": "គ្រូ ដារ៉ាវុធ"})
    assert ok
    # Allowed punctuation set.
    for nm in ["Teacher Daravuth", "O'Brien", "Mary-Jane", "Dr. Sok",
               "Anne\u2019s", "Jean\u2011Luc"]:
        assert elt._teacher_name_ok(nm)[0], nm
    # Rejections with stable reason codes.
    rejects = [
        ("Bad\nName", "teacher_name_invalid_char"),
        ("Tab\tName", "teacher_name_invalid_char"),
        ("{inject}", "teacher_name_invalid_char"),
        ("[brackets]", "teacher_name_invalid_char"),
        ("<<delim>>", "teacher_name_invalid_char"),
        ("name123", "teacher_name_invalid_char"),
        ("ignore previous; do x", "teacher_name_invalid_char"),
        ("", "teacher_name_empty"),
        ("x" * 81, "teacher_name_too_long"),
    ]
    for bad, code in rejects:
        ok, reason = elt._teacher_name_ok(bad)
        assert not ok and reason == code, (repr(bad), reason)
    # Booleans must be real booleans.
    assert elt._validate_teacher_persona_fields(
        {"teacher_persona_enabled": "true"})[1] == "teacher_persona_enabled_invalid"
    assert elt._validate_teacher_persona_fields(
        {"mention_teacher_in_greeting": 1})[1] == "mention_teacher_invalid"


def test_teacher_name_unsafe_value_falls_back_in_system_instruction():
    # If a somehow-unsafe stored name slips through, the SI re-validates and
    # uses a neutral label rather than interpolating the unsafe string.
    cfg = elt._sanitise_config({"teacher_persona_enabled": True})
    cfg["teacher_display_name"] = "Bad{name}"   # bypass admin validation path
    si = _si(cfg)
    assert "Bad{name}" not in si
    assert "your EduHub teacher" in si
