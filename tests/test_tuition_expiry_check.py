"""tests/test_tuition_expiry_check.py
=====================================
Regression test for _ttn_is_expired (tuition_tools.py) — the shared,
correctly-parenthesized expiry check used by poll_tuition_intent's expiry
transition AND create_tuition_intent's duplicate-intent reap check.

The original inline version had a Python operator-precedence bug:
    if exp and now_utc > exp.replace(tzinfo=timezone.utc) if exp.tzinfo is None else now_utc > exp:
parses (conditional-expression precedence is lower than `and`) as
`(exp and X) if C else Y` — dereferencing exp.tzinfo even when exp could be
None, and dropping the `exp and` guard entirely in the false branch.

_ttn_is_expired has no Mongo/FastAPI dependency, so it's imported and
tested directly rather than copied inline.
"""
from __future__ import annotations

from datetime import datetime, timedelta, timezone

from tuition_tools import _ttn_is_expired


def test_none_expiry_never_expired_and_does_not_raise():
    now = datetime.now(timezone.utc)
    assert _ttn_is_expired(None, now) is False


def test_naive_datetime_past_is_expired():
    now = datetime.now(timezone.utc)
    exp = (now - timedelta(minutes=5)).replace(tzinfo=None)
    assert _ttn_is_expired(exp, now) is True


def test_naive_datetime_future_is_not_expired():
    now = datetime.now(timezone.utc)
    exp = (now + timedelta(minutes=5)).replace(tzinfo=None)
    assert _ttn_is_expired(exp, now) is False


def test_aware_datetime_past_is_expired():
    now = datetime.now(timezone.utc)
    exp = now - timedelta(minutes=5)
    assert _ttn_is_expired(exp, now) is True


def test_aware_datetime_future_is_not_expired():
    now = datetime.now(timezone.utc)
    exp = now + timedelta(minutes=5)
    assert _ttn_is_expired(exp, now) is False
