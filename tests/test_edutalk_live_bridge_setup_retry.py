"""tests/test_edutalk_live_bridge_setup_retry.py — BUG 1 hardening
regression coverage: a single transient failure connecting to / handshaking
with Gemini's Live API must NOT immediately terminate a session the
student has already been charged for.

Root cause (see investigation): the frontend shows the "live" screen the
instant the REST reservation succeeds — before the WebSocket to Gemini is
even attempted. If that connect+setupComplete handshake then fails once
(network blip, momentary quota hiccup, cold-start latency), the OLD code
gave up immediately: refund + "Your session has ended. No report was
generated for this session." with zero retry. `_open_gemini_live_with_retry`
now retries that handshake once before giving up.

Follows this file family's established fake pattern (self-contained,
no real Mongo/Gemini/WebSocket/network) — see
tests/test_edutalk_live_v2_corrections.py for the FakeGeminiWS/FakeClientWS/
FakeSessCol/drive_bridge precedent this file mirrors.
"""
import asyncio
import json
import types

import pytest

import edutalk_live_tools as elt


def run(coro):
    return asyncio.run(coro)


class FakeGeminiWS:
    """Same async-context-manager contract as the real `websockets`
    connection AND as production code's `_ws_lib.connect(...)` usage —
    `__aenter__`/`__aexit__`, no `__await__`. `fail_setup=True` makes the
    first `recv()` (the setupComplete wait) raise instead of returning the
    ack, simulating a Gemini handshake failure."""

    def __init__(self, fail_setup=False):
        self.fail_setup = fail_setup
        self.sent = []
        self._recv_count = 0
        self.entered = False
        self.exited = False

    async def send(self, s):
        self.sent.append(s)

    async def recv(self):
        self._recv_count += 1
        if self._recv_count == 1:
            if self.fail_setup:
                raise ConnectionError("simulated Gemini setup rejection")
            return json.dumps({"setupComplete": {}})
        await asyncio.sleep(3600)

    async def __aenter__(self):
        self.entered = True
        return self

    async def __aexit__(self, *exc):
        self.exited = True
        return False


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

    async def update_one(self, flt, upd):
        for k, v in (upd.get("$set") or {}).items():
            self.doc[k] = v

        class _R:
            matched_count = 1
        return _R()


def base_session(**over):
    s = {
        "session_id": "sid-retry",
        "clean_id": "stu1",
        "display_name": "Sok Dara",
        "system_instruction": "SYSTEM INSTRUCTION.",
        "explain_language": "en",
        "greeting_context": {
            "student_first_name": "Sok", "points_value": 10,
            "points_source": "gas_verified_post_reservation",
            "book_title": "Book", "book_slug": "book",
            "chapter_title": "Ch 1", "mode": "book_shadow",
            "explain_language": "en", "teacher_persona_enabled": False,
            "teacher_display_name": "Teacher", "mention_teacher_in_greeting": False,
        },
    }
    s.update(over)
    return s


def _patch_common(monkeypatch, connect_fn):
    monkeypatch.setattr(elt, "_reward_mod", None)
    monkeypatch.setattr(elt, "_REWARD_MOD_OK", False)
    monkeypatch.setattr(elt, "_ws_lib", types.SimpleNamespace(connect=connect_fn))
    # Don't actually wait the real backoff duration in tests — and don't
    # monkeypatch asyncio.sleep globally either, since the fakes' OWN
    # "block forever until cancelled" sleeps (FakeGeminiWS.recv,
    # FakeClientWS.receive_text) rely on asyncio.sleep(3600) behaving
    # normally so the real asyncio.wait(..., FIRST_COMPLETED) race works.
    monkeypatch.setattr(elt, "_GEMINI_SETUP_RETRY_DELAY_S", 0)


def test_first_attempt_fails_second_succeeds_session_completes_normally(monkeypatch):
    """The exact BUG 1 fix: one transient setup failure must not sacrifice
    the session — it must transparently retry and continue as if nothing
    happened, producing a normal completed session with a real report."""
    gems = [FakeGeminiWS(fail_setup=True), FakeGeminiWS(fail_setup=False)]
    calls = []

    def fake_connect(uri, **kw):
        calls.append(uri)
        return gems[len(calls) - 1]

    _patch_common(monkeypatch, fake_connect)

    client = FakeClientWS([{"type": "end", "reason": "client_end"}])
    col = FakeSessCol()
    finalize_calls = []

    async def finalize(session_id, outcome=None, transcript=None, error_reason=None):
        finalize_calls.append({"outcome": outcome, "error_reason": error_reason})
        return {"session": {"final_charged": 10, "refund_state": None,
                            "state": "completed"}, "report": {"summary": "great job"}}

    run(elt._run_live_bridge(client, base_session(), 60, col, finalize=finalize))

    # Retried exactly once — two connect attempts total, not more.
    assert len(calls) == 2
    # The failed first connection was properly closed before retrying.
    assert gems[0].exited is True
    assert gems[0].entered is True
    # The second (successful) connection is the one actually used for the session.
    assert gems[1].entered is True

    # The client was told the session is ready — NOT that it errored/ended.
    assert client.of("ready")
    assert not client.of("error")
    # finalize was called with the REAL end reason (client_end), never
    # "failed"/"gemini_setup_failed" — the retry made the setup failure
    # invisible to the rest of the session lifecycle.
    assert len(finalize_calls) == 1
    assert finalize_calls[0]["outcome"] != "failed"
    # A real report reached the client.
    report_frames = client.of("report")
    assert report_frames
    assert report_frames[0]["report"] == {"summary": "great job"}


def test_both_attempts_fail_session_finalizes_as_failed_with_no_report(monkeypatch):
    """Exhausting the retry budget must still fail safe: refund (via the
    existing outcome="failed" path — unchanged, protected logic), no
    report, client told it errored. This is the existing, already-tested
    fallback behavior — this test proves the NEW retry wrapper doesn't
    accidentally retry forever or swallow a persistent failure."""
    gems = [FakeGeminiWS(fail_setup=True), FakeGeminiWS(fail_setup=True)]
    calls = []

    def fake_connect(uri, **kw):
        calls.append(uri)
        return gems[len(calls) - 1]

    _patch_common(monkeypatch, fake_connect)

    client = FakeClientWS([{"type": "end", "reason": "client_end"}])
    col = FakeSessCol()
    finalize_calls = []

    async def finalize(session_id, outcome=None, transcript=None, error_reason=None):
        finalize_calls.append({"outcome": outcome, "error_reason": error_reason})
        return {"session": {"final_charged": 0, "refund_state": "refunded",
                            "state": "failed_refunded"}, "report": None}

    run(elt._run_live_bridge(client, base_session(), 60, col, finalize=finalize))

    # Exactly the configured max attempts — never retries beyond the cap.
    assert len(calls) == elt._GEMINI_SETUP_MAX_ATTEMPTS == 2
    assert gems[0].exited is True
    assert gems[1].exited is True

    # Client was told it errored, never got a "ready".
    assert not client.of("ready")
    error_frames = client.of("error")
    assert error_frames
    assert error_frames[0]["reason"].startswith("gemini_setup_failed:")

    # finalize was called exactly once, with outcome="failed" — the
    # existing protected refund path, untouched by this change.
    assert len(finalize_calls) == 1
    assert finalize_calls[0]["outcome"] == "failed"
    assert finalize_calls[0]["error_reason"].startswith("gemini_setup_failed:")

    # This path sends only the "error" frame, never a "report" frame at
    # all (matches the existing, already-protected behavior — the RuntimeError
    # is caught by the OUTER handler, which never reaches the "report" send).
    assert not client.of("report")


def test_success_on_first_attempt_never_retries(monkeypatch):
    """The common/happy path must not pay any retry cost — exactly one
    connect call, no sleep."""
    gem = FakeGeminiWS(fail_setup=False)
    calls = []

    def fake_connect(uri, **kw):
        calls.append(uri)
        return gem

    _patch_common(monkeypatch, fake_connect)

    client = FakeClientWS([{"type": "end", "reason": "client_end"}])
    col = FakeSessCol()

    async def finalize(session_id, outcome=None, transcript=None, error_reason=None):
        return {"session": {"final_charged": 10, "refund_state": None,
                            "state": "completed"}, "report": {}}

    run(elt._run_live_bridge(client, base_session(), 60, col, finalize=finalize))

    assert len(calls) == 1
    assert client.of("ready")
