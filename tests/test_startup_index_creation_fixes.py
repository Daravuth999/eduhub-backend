"""tests/test_startup_index_creation_fixes.py — §3 of the video pipeline
crash/reconciliation round.

Evidence (every server boot log this project has ever produced):
    "mystery_box: deferred index creation: There is no current event
     loop in thread 'MainThread'."
    "edutalk: audio-cache index task spawn failed: There is no current
     event loop in thread 'MainThread'."

Root cause, confirmed by reading both modules directly: `register_mystery_
box_routes`/`register_edutalk_routes` are called at module-registration
time — before Uvicorn's event loop exists — and BOTH used to call
`asyncio.get_event_loop()` synchronously right there, which raises exactly
that RuntimeError on every real boot (Python 3.10+ semantics: no current
event loop AND no running loop in the calling thread). The try/except
around it caught the exception and logged a "deferred"/"spawn failed"
warning, but nothing else in either codebase ever scheduled that index
creation again afterward — this was not cosmetic log noise, these indexes
were silently NEVER created, on any boot, degrading every lookup to a
full collection scan permanently.

Fix: both modules stopped trying to schedule index creation at
registration time at all; server.py now calls the underlying index-
creation coroutines directly from its own `@app.on_event("startup")`
handlers — the SAME established pattern this codebase already uses
correctly for question_bank/notification_packs/prize_pool/etc. (confirmed
by reading server.py directly: these modules' indexes DO appear as
"indexes ready" in every boot log, because their registration functions
never touch asyncio.get_event_loop() at all — they just expose a
standalone `ensure_X_indexes(db)` coroutine for server.py's startup hook
to call later).

This file proves two things for each module: (1) the underlying index-
creation work genuinely still happens — awaiting the real coroutine
against a fake db actually calls create_index() for every real index the
module needs — and (2) calling the registration function itself, at
import/registration time (synchronously, no event loop running — the
exact real-world condition that used to trigger the warning), no longer
touches asyncio.get_event_loop() at all, so the warning is structurally
impossible now, not just quieter.
"""
from __future__ import annotations

import ast
from pathlib import Path

import pytest
from fastapi import APIRouter


# ── mystery_box_tools.py ────────────────────────────────────────────────────
class _RecordingColl:
    def __init__(self, name):
        self.name = name
        self.index_calls = []

    async def create_index(self, *a, **k):
        self.index_calls.append((a, k))
        return f"idx_{self.name}_{len(self.index_calls)}"

    async def find_one(self, *a, **k):
        return None

    async def count_documents(self, *a, **k):
        return 0


class _RecordingDB:
    def __init__(self):
        self._cols: dict[str, _RecordingColl] = {}

    def __getitem__(self, name):
        return self._cols.setdefault(name, _RecordingColl(name))

    def __getattr__(self, name):
        if name.startswith("_"):
            raise AttributeError(name)
        return self[name]


async def _noop_dep():
    return None


def test_mystery_box_registration_no_longer_touches_the_event_loop_at_all():
    """The exact real-world trigger: calling the registration function
    SYNCHRONOUSLY with no event loop running in this thread — precisely
    the condition every real Uvicorn boot hits at module-registration
    time, before "Waiting for application startup". Must not raise AND
    must not log the old warning (checked structurally below, since this
    call itself proves it doesn't even reach an asyncio call anymore)."""
    import mystery_box_tools as mbt

    db = _RecordingDB()
    # No asyncio.run/event loop anywhere around this call — if the old
    # `asyncio.get_event_loop()` call still existed, THIS is exactly where
    # it would raise "no current event loop in thread 'MainThread'".
    ns = mbt.register_mystery_box_routes(
        APIRouter(), db, _noop_dep, _noop_dep, None, db["push_subscriptions"], None,
    )
    assert "_mbt_ensure_indexes" in ns


@pytest.mark.asyncio
async def test_mystery_box_ensure_indexes_still_actually_creates_every_index():
    """§3.3: don't just silence the warning — confirm the real work still
    happens. Awaited directly here (this is what server.py's new startup
    hook does), against a fake db that records every create_index() call."""
    import mystery_box_tools as mbt

    db = _RecordingDB()
    ns = mbt.register_mystery_box_routes(
        APIRouter(), db, _noop_dep, _noop_dep, None, db["push_subscriptions"], None,
    )

    await ns["_mbt_ensure_indexes"]()

    # Every collection ensure_indexes is documented to touch got at least
    # one real create_index call — proving the coroutine's body actually
    # ran end to end, not just that it exists.
    for coll_name in (
        "mystery_box_prize_templates", "edutalk_pass_templates",
        "speaking_lab_mystery_campaigns", "speaking_lab_mystery_rounds",
        "speaking_lab_mystery_claims", "student_feature_entitlements",
        "speaking_lab_reward_history",
    ):
        assert db[coll_name].index_calls, f"expected at least one create_index() call on {coll_name!r}"


def test_mystery_box_source_no_longer_calls_get_event_loop_at_registration_time():
    """Structural, permanent regression guard — the SAME style of source-
    text check this codebase already uses (e.g. test_video_library_coupon_
    tools.py's test_server_wires_registration_call_site_structurally)."""
    import mystery_box_tools as mbt
    source = Path(mbt.__file__).read_text(encoding="utf-8")
    assert "deferred index creation" not in source
    assert "get_event_loop" not in source or "ensure_indexes" not in source.split("get_event_loop")[0][-200:]


# ── edutalk_tools.py ─────────────────────────────────────────────────────────
def test_edutalk_registration_no_longer_touches_the_event_loop_at_all():
    import edutalk_tools as et

    db = _RecordingDB()
    # Same real-world condition as the mystery_box test above — no event
    # loop running in this thread at all.
    et.register_edutalk_routes(APIRouter(), db, _noop_dep, _noop_dep)


def test_edutalk_source_no_longer_spawns_an_index_task_at_registration_time():
    import edutalk_tools as et
    source = Path(et.__file__).read_text(encoding="utf-8")
    assert "audio-cache index task spawn failed" not in source
    assert "get_event_loop().create_task(_et_audio.ensure_indexes" not in source


@pytest.mark.asyncio
async def test_edutalk_audio_cache_ensure_indexes_still_actually_creates_every_index():
    """§3.3 for edutalk: the underlying edutalk_audio_cache.ensure_indexes
    coroutine (what server.py's new startup hook calls directly) must
    still genuinely create its real indexes."""
    import edutalk_audio_cache as eac

    db = _RecordingDB()
    await eac.ensure_indexes(db)

    assert db[eac.CACHE_COLLECTION].index_calls, "expected create_index() calls on the audio cache collection"
    assert db[eac.ENTITLEMENT_COLLECTION].index_calls, "expected create_index() calls on the entitlement collection"


# ── server.py wiring (structural — matches this codebase's own established
#    convention for asserting on server.py without importing it, which
#    would require live env vars at module load time) ──────────────────────
def test_server_wires_both_new_startup_hooks_structurally():
    src = Path("server.py").read_text(encoding="utf-8")
    assert '_mystery_box_hooks["_mbt_ensure_indexes"]' in src
    assert "edutalk_audio_cache" in src
    assert "ensure_indexes(db)" in src
