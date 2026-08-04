"""tests/test_tuition_intent_reap.py
=====================================
Regression test for the "student stuck behind a permanent 409" bug.

Root cause: create_tuition_intent's duplicate-block query only checked
`status in [pending, ...]` — never `expires_at`. "pending" -> "expired" is
ONLY ever set as a side effect of a live poll_tuition_intent/webhook call.
If a student generated a QR and then closed the tab before polling again,
the intent doc sat at "pending" in Mongo forever (no TTL index, no
background sweep), and every future create_tuition_intent call — this
month and every month after — hit the duplicate block permanently, even
though the intent's own `expires_at` had long since passed.

Fix (tuition_tools.py):
  1. create_tuition_intent now reaps an expired-but-still-"pending" blocking
     intent (flips it to "expired" in Mongo) instead of blocking on it.
  2. poll_tuition_intent checks expiry locally FIRST (independent of the
     payment provider), so an expired intent transitions even if nobody
     ever open the QR again to re-poll it.
  3. poll_tuition_intent now regenerates qr_image (never persisted on the
     document) for a still-pending intent, so the frontend's new
     INTENT_ACTIVE-driven auto-resume has a real, displayable QR to show —
     not just a bare status object.

_ttn_is_expired and _ttn_render_qr_image are imported directly (pure,
no Mongo/FastAPI dependency). The reap DECISION wiring itself lives inside
a closure in register_tuition_routes and can't be cheaply unit-tested in
isolation without a heavy fake harness, so it's mirrored here against the
REAL _ttn_is_expired import — only the surrounding wiring is copied, per
this codebase's established convention (see test_tuition_concurrency.py).
"""
from __future__ import annotations

from datetime import datetime, timedelta, timezone

from tuition_tools import _ttn_is_expired, _ttn_render_qr_image


# ── _ttn_render_qr_image — real function, direct tests ──────────────────────

def test_render_qr_image_produces_a_valid_png_data_uri():
    img = _ttn_render_qr_image("00020101021229180014A000000677010112...")
    assert img.startswith("data:image/png;base64,")
    assert len(img) > 100


def test_render_qr_image_empty_payload_returns_empty_string():
    assert _ttn_render_qr_image("") == ""
    assert _ttn_render_qr_image(None) == ""


# ── Reap decision — mirrors create_tuition_intent's blocking-intent check ───
# (tuition_tools.py, "Block duplicate intent creation") against the REAL
# _ttn_is_expired import, so only the branch wiring is copied, not the
# expiry math itself.

def _reap_decision(blocking_intent: dict | None, now: datetime) -> tuple[bool, str | None]:
    """Returns (should_block, new_status_if_reaped)."""
    if blocking_intent and blocking_intent.get("status") == "pending":
        exp = blocking_intent.get("expires_at")
        if _ttn_is_expired(exp, now):
            return False, "expired"
    return bool(blocking_intent), None


def test_expired_pending_intent_is_reaped_not_blocking():
    now = datetime.now(timezone.utc)
    stale_intent = {"intent_id": "tui_old", "status": "pending", "expires_at": now - timedelta(minutes=30)}
    should_block, new_status = _reap_decision(stale_intent, now)
    assert should_block is False
    assert new_status == "expired"


def test_still_valid_pending_intent_still_blocks():
    now = datetime.now(timezone.utc)
    fresh_intent = {"intent_id": "tui_new", "status": "pending", "expires_at": now + timedelta(minutes=5)}
    should_block, new_status = _reap_decision(fresh_intent, now)
    assert should_block is True
    assert new_status is None


def test_manual_review_intent_always_blocks_regardless_of_any_expiry_field():
    now = datetime.now(timezone.utc)
    mr_intent = {"intent_id": "tui_mr", "status": "manual_review", "expires_at": now - timedelta(days=1)}
    should_block, new_status = _reap_decision(mr_intent, now)
    assert should_block is True
    assert new_status is None


def test_finalizing_intent_always_blocks_regardless_of_any_expiry_field():
    now = datetime.now(timezone.utc)
    fin_intent = {"intent_id": "tui_fin", "status": "finalizing", "expires_at": now - timedelta(days=1)}
    should_block, new_status = _reap_decision(fin_intent, now)
    assert should_block is True
    assert new_status is None


def test_no_blocking_intent_never_blocks():
    now = datetime.now(timezone.utc)
    should_block, new_status = _reap_decision(None, now)
    assert should_block is False
    assert new_status is None


def test_pending_intent_missing_expires_at_still_blocks_fail_safe():
    """No expires_at means _ttn_is_expired(None, now) is False (never
    expires) — a malformed/legacy doc without the field fails safe (still
    blocks a duplicate) rather than silently letting two intents coexist."""
    now = datetime.now(timezone.utc)
    intent_no_exp = {"intent_id": "tui_noexp", "status": "pending"}
    should_block, new_status = _reap_decision(intent_no_exp, now)
    assert should_block is True
    assert new_status is None


# ── poll response: qr_image is regenerated for a resumable intent ──────────

def _poll_response_shape(fresh_doc: dict) -> dict:
    """Mirrors poll_tuition_intent's post-fetch qr_image attach/strip step."""
    fresh = dict(fresh_doc)
    qr_payload = fresh.pop("qr_payload", None)
    if fresh.get("status") == "pending":
        fresh["qr_image"] = _ttn_render_qr_image(qr_payload or "")
    return fresh


def test_pending_intent_response_gets_a_real_qr_image_and_never_leaks_payload():
    doc = {"intent_id": "tui_1", "status": "pending", "qr_payload": "00020101021229180014A000000677010112..."}
    out = _poll_response_shape(doc)
    assert "qr_payload" not in out
    assert out["qr_image"].startswith("data:image/png;base64,")


def test_completed_intent_response_has_no_qr_image_field_added():
    doc = {"intent_id": "tui_1", "status": "completed", "receipt_id": "rcpt_1", "qr_payload": "xyz"}
    out = _poll_response_shape(doc)
    assert "qr_payload" not in out
    assert "qr_image" not in out


def test_expired_intent_response_has_no_qr_image_field_added():
    doc = {"intent_id": "tui_1", "status": "expired", "qr_payload": "xyz"}
    out = _poll_response_shape(doc)
    assert "qr_image" not in out
