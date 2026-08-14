"""tests/test_tuition_expiry_check.py
=====================================
Regression test for the intent-expiry check inside poll_tuition_intent
(tuition_tools.py ~line 863).

The original code:
    if exp and now_utc > exp.replace(tzinfo=timezone.utc) if exp.tzinfo is None else now_utc > exp:

parses (Python conditional-expression precedence is lower than `and`) as:
    (exp and X) if C else Y

which (a) dereferences exp.tzinfo even when exp could be None, and (b) drops
the `exp and` truthiness guard entirely in the false branch. Fixed to:
    if exp is not None and ((now_utc > exp.replace(tzinfo=timezone.utc)) if exp.tzinfo is None else (now_utc > exp)):

Copied inline (pure function, no Mongo/import server dependency) per this
codebase's established test convention (see test_tuition_billing.py).
"""
from __future__ import annotations

from datetime import datetime, timedelta, timezone


def _is_expired(exp, now_utc: datetime) -> bool:
    return exp is not None and (
        (now_utc > exp.replace(tzinfo=timezone.utc)) if exp.tzinfo is None
        else (now_utc > exp)
    )


def test_none_expiry_never_expired_and_does_not_raise():
    now = datetime.now(timezone.utc)
    assert _is_expired(None, now) is False


def test_naive_datetime_past_is_expired():
    now = datetime.now(timezone.utc)
    exp = (now - timedelta(minutes=5)).replace(tzinfo=None)
    assert _is_expired(exp, now) is True


def test_naive_datetime_future_is_not_expired():
    now = datetime.now(timezone.utc)
    exp = (now + timedelta(minutes=5)).replace(tzinfo=None)
    assert _is_expired(exp, now) is False


def test_aware_datetime_past_is_expired():
    now = datetime.now(timezone.utc)
    exp = now - timedelta(minutes=5)
    assert _is_expired(exp, now) is True


def test_aware_datetime_future_is_not_expired():
    now = datetime.now(timezone.utc)
    exp = now + timedelta(minutes=5)
    assert _is_expired(exp, now) is False
