"""tests/test_experience_config_recurring_annual.py — Achievement Experience
Studio directive: "Seasonal Scheduling ... recurring annual events ... No
code deployment should be required to activate seasonal themes."

The existing activeWindow (startsAt/endsAt, exact-date match) already
covered one-off scheduling. This adds `activeWindow.recurringAnnual` —
when set, the SAME published config re-activates every year on the same
(month, day) range, with no admin action needed each year. Absent/false
must behave byte-identically to the pre-existing exact-date logic (no
regression for every config that predates this field).

Mirrors the established in-process fake pattern from
test_experience_config_active_resolution.py.
"""
from __future__ import annotations

from datetime import datetime, timezone

from fastapi import APIRouter, FastAPI
from fastapi.testclient import TestClient

import experience_config_tools as ect


class _Coll:
    def __init__(self, docs=None):
        self._docs = list(docs or [])

    def find(self, q):
        return _Cursor([d for d in self._docs if all(d.get(k) == v for k, v in q.items())])

    async def create_index(self, *a, **k):
        return "idx"


class _Cursor:
    def __init__(self, docs):
        self._docs = docs
        self._i = 0

    def __aiter__(self):
        return self

    async def __anext__(self):
        if self._i >= len(self._docs):
            raise StopAsyncIteration
        d = self._docs[self._i]
        self._i += 1
        return d


class _FakeDB:
    def __init__(self, docs):
        self.experience_configs = _Coll(docs)

    def __getitem__(self, name):
        return getattr(self, name)


def _make_client(docs):
    db = _FakeDB(docs)
    app = FastAPI()
    api = APIRouter(prefix="/api")
    ect.register_experience_config_routes(api, app, db)
    app.include_router(api)
    return TestClient(app)


def _doc(**over):
    d = {
        "id": "cfg-1",
        "experienceType": "achievement_top_earner",
        "key": "khmer-new-year",
        "status": "published",
        "activeWindow": {"startsAt": None, "endsAt": None, "recurringAnnual": False},
        "content": {},
        "appearance": {},
        "motion": {},
        "playback": {},
        "version": 1,
        "createdAt": None,
        "updatedAt": None,
    }
    d.update(over)
    return d


# ── pure function tests (year-agnostic month/day math) ─────────────────────
def test_non_wrapping_recurring_window_matches_any_year():
    starts = datetime(2020, 4, 13, tzinfo=timezone.utc)   # Apr 13 (Khmer New Year start)
    ends = datetime(2020, 4, 16, tzinfo=timezone.utc)     # Apr 16
    now_2026 = datetime(2026, 4, 14, tzinfo=timezone.utc)  # same days, different year
    assert ect._is_within_annual_window(starts, ends, now_2026) is True


def test_non_wrapping_recurring_window_rejects_outside_range():
    starts = datetime(2020, 4, 13, tzinfo=timezone.utc)
    ends = datetime(2020, 4, 16, tzinfo=timezone.utc)
    now_outside = datetime(2026, 5, 1, tzinfo=timezone.utc)
    assert ect._is_within_annual_window(starts, ends, now_outside) is False


def test_wrapping_recurring_window_across_new_year():
    # Christmas -> New Year's window: Dec 20 -> Jan 5.
    starts = datetime(2020, 12, 20, tzinfo=timezone.utc)
    ends = datetime(2020, 1, 5, tzinfo=timezone.utc)
    assert ect._is_within_annual_window(starts, ends, datetime(2026, 12, 25, tzinfo=timezone.utc)) is True
    assert ect._is_within_annual_window(starts, ends, datetime(2027, 1, 2, tzinfo=timezone.utc)) is True
    assert ect._is_within_annual_window(starts, ends, datetime(2026, 6, 15, tzinfo=timezone.utc)) is False


# ── route-level tests ───────────────────────────────────────────────────────
class _FixedDatetime(datetime):
    """Patches ect.datetime.now() to a controlled instant so the route-level
    test doesn't depend on (and flake around) the real wall clock."""
    _fixed = datetime(2026, 4, 14, tzinfo=timezone.utc)

    @classmethod
    def now(cls, tz=None):
        return cls._fixed


def test_recurring_config_is_active_on_the_matching_day_regardless_of_year(monkeypatch):
    monkeypatch.setattr(ect, "datetime", _FixedDatetime)
    doc = _doc(activeWindow={
        "startsAt": datetime(2019, 4, 13, tzinfo=timezone.utc).isoformat(),
        "endsAt": datetime(2019, 4, 16, tzinfo=timezone.utc).isoformat(),
        "recurringAnnual": True,
    })
    client = _make_client([doc])
    res = client.get("/api/experience-configs/active?type=achievement_top_earner")
    assert res.status_code == 200
    assert res.json()["config"] is not None
    assert res.json()["config"]["id"] == "cfg-1"


def test_recurring_config_is_inactive_outside_the_matching_window(monkeypatch):
    monkeypatch.setattr(ect, "datetime", _FixedDatetime)  # fixed at Apr 14
    doc = _doc(activeWindow={
        "startsAt": datetime(2019, 12, 20, tzinfo=timezone.utc).isoformat(),
        "endsAt": datetime(2019, 12, 31, tzinfo=timezone.utc).isoformat(),
        "recurringAnnual": True,
    })
    client = _make_client([doc])
    res = client.get("/api/experience-configs/active?type=achievement_top_earner")
    assert res.status_code == 200
    assert res.json()["config"] is None


def test_recurring_flag_absent_behaves_exactly_like_before_no_regression():
    """A config with NO recurringAnnual field (every config created before
    this feature existed) must still use exact-date matching, unchanged."""
    from datetime import timedelta
    now = datetime.now(timezone.utc)
    doc = _doc(activeWindow={
        "startsAt": (now - timedelta(days=1)).isoformat(),
        "endsAt": (now + timedelta(days=1)).isoformat(),
    })  # no recurringAnnual key at all
    assert ect._is_active_now(doc, now) is True

    expired_doc = _doc(activeWindow={
        "startsAt": (now - timedelta(days=10)).isoformat(),
        "endsAt": (now - timedelta(days=1)).isoformat(),
    })
    assert ect._is_active_now(expired_doc, now) is False


def test_recurring_true_but_missing_starts_or_ends_falls_back_to_exact_date_logic():
    """recurringAnnual=True with a missing bound is nonsensical for annual
    math — falls back to the existing exact-date path rather than crashing
    or silently treating it as always-active."""
    now = datetime.now(timezone.utc)
    doc = _doc(activeWindow={"startsAt": None, "endsAt": None, "recurringAnnual": True})
    # No bounds at all -> always active, same as a normal unbounded window.
    assert ect._is_active_now(doc, now) is True


def test_sanitize_active_window_persists_recurring_annual_flag():
    saved = ect._sanitize_active_window({
        "startsAt": "2026-04-13T00:00:00Z", "endsAt": "2026-04-16T00:00:00Z", "recurringAnnual": True,
    })
    assert saved["recurringAnnual"] is True

    default = ect._sanitize_active_window(None)
    assert default == {"startsAt": None, "endsAt": None, "recurringAnnual": False}


def test_sanitize_active_window_coerces_truthy_values_to_bool():
    saved = ect._sanitize_active_window({"startsAt": None, "endsAt": None, "recurringAnnual": "yes"})
    assert saved["recurringAnnual"] is True
    assert isinstance(saved["recurringAnnual"], bool)
