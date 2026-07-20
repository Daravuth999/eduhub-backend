"""tests/test_edutalk_live_transcript_bound.py — re-audit hardening:
the in-memory `transcript` list accumulated by _run_live_bridge for the
whole duration of a live session previously had NO cap — only ever
truncated at SAVE time (transcript[:300] / used_transcript[:200]), well
after the list had already grown without bound in memory. A pathological
long-running or misbehaving session could grow this list indefinitely for
the life of the process.

Proves:
  * _bounded_transcript_append stops growing the list once
    _MAX_LIVE_TRANSCRIPT_ENTRIES is reached, but never raises;
  * a live student/coach transcript message is still forwarded to the
    CLIENT even once the in-memory accumulator itself is capped — the cap
    only protects the server-side memory footprint, it must never make
    the student's live captions silently stop appearing;
  * ordinary short/medium sessions (far under the cap) are byte-for-byte
    unaffected — every entry is still appended exactly as before.
"""
from __future__ import annotations

import asyncio

import edutalk_live_tools as elt


def run(coro):
    return asyncio.run(coro)


def test_bounded_transcript_append_stops_growing_at_the_cap():
    transcript = [{"role": "coach", "text": "x", "ts": "t"}] * elt._MAX_LIVE_TRANSCRIPT_ENTRIES
    assert len(transcript) == elt._MAX_LIVE_TRANSCRIPT_ENTRIES

    elt._bounded_transcript_append(transcript, {"role": "student", "text": "overflow", "ts": "t"})

    assert len(transcript) == elt._MAX_LIVE_TRANSCRIPT_ENTRIES
    assert transcript[-1]["text"] != "overflow"


def test_bounded_transcript_append_is_a_normal_append_under_the_cap():
    transcript = []
    for i in range(10):
        elt._bounded_transcript_append(transcript, {"role": "coach", "text": str(i), "ts": "t"})
    assert len(transcript) == 10
    assert [e["text"] for e in transcript] == [str(i) for i in range(10)]


class FakeClientWS:
    def __init__(self):
        self.sent = []

    async def send_text(self, s):
        import json
        self.sent.append(json.loads(s))


def test_client_still_receives_the_transcript_frame_even_once_the_accumulator_is_capped():
    """The cap must only affect the SERVER-side in-memory list — the
    student's live on-screen captions (forwarded via _ws_send on every
    message, independent of the accumulator) must never silently stop."""
    client = FakeClientWS()
    transcript = [{"role": "coach", "text": "x", "ts": "t"}] * elt._MAX_LIVE_TRANSCRIPT_ENTRIES
    msg = {"serverContent": {"inputTranscription": {"text": "hello after cap"}}}

    run(elt._handle_gemini_message(msg, client, transcript))

    assert len(transcript) == elt._MAX_LIVE_TRANSCRIPT_ENTRIES  # accumulator capped
    forwarded = [f for f in client.sent if f.get("type") == "transcript"]
    assert len(forwarded) == 1
    assert forwarded[0]["text"] == "hello after cap"  # client still sees it live
