"""tests/test_experience_config_active_resolution.py — Phase 1 coverage for
the Experience Configuration Platform's ONLY route:
GET /api/experience-configs/active?type=...

Covers: published-only filter, schedule-window activation/expiry, type
isolation (a config for one experienceType never leaks into another's
active-config response), "no config found" returns {"config": null} (never
a 404 -- an absent config is an expected migration-period state), and
picking the most-recently-updated candidate when more than one is
somehow active at once.

No live MongoDB -- mirrors the established in-process fake pattern from
test_notification_center_ws_auth.py / test_notification_center_unified_badges.py.
"""
from __future__ import annotations

from datetime import datetime, timedelta, timezone

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


NOW = datetime.now(timezone.utc)
PAST = (NOW - timedelta(days=1)).isoformat()
FUTURE = (NOW + timedelta(days=1)).isoformat()


def _doc(experienceType="welcome_dashboard", status="published", starts=None, ends=None, updatedAt=None, content=None):
    return {
        "experienceType": experienceType,
        "key": "default",
        "status": status,
        "activeWindow": {"startsAt": starts, "endsAt": ends},
        "content": content or {"title": "Doc"},
        "appearance": {}, "motion": {}, "playback": {},
        "version": 1,
        "updatedAt": updatedAt or NOW,
    }


def test_no_config_returns_null_not_404():
    client = _make_client([])
    resp = client.get("/api/experience-configs/active?type=welcome_dashboard")
    assert resp.status_code == 200
    assert resp.json() == {"config": None}


def test_draft_config_is_never_returned():
    docs = [_doc(status="draft")]
    client = _make_client(docs)
    resp = client.get("/api/experience-configs/active?type=welcome_dashboard")
    assert resp.json() == {"config": None}


def test_published_unbounded_window_is_active():
    docs = [_doc(status="published", content={"title": "Live"})]
    client = _make_client(docs)
    resp = client.get("/api/experience-configs/active?type=welcome_dashboard")
    assert resp.json()["config"]["content"]["title"] == "Live"


def test_published_but_not_yet_started_is_not_active():
    docs = [_doc(status="published", starts=FUTURE)]
    client = _make_client(docs)
    resp = client.get("/api/experience-configs/active?type=welcome_dashboard")
    assert resp.json() == {"config": None}


def test_published_but_expired_is_not_active():
    docs = [_doc(status="published", ends=PAST)]
    client = _make_client(docs)
    resp = client.get("/api/experience-configs/active?type=welcome_dashboard")
    assert resp.json() == {"config": None}


def test_published_within_window_is_active():
    docs = [_doc(status="published", starts=PAST, ends=FUTURE, content={"title": "Seasonal"})]
    client = _make_client(docs)
    resp = client.get("/api/experience-configs/active?type=welcome_dashboard")
    assert resp.json()["config"]["content"]["title"] == "Seasonal"


def test_config_for_a_different_experience_type_never_leaks():
    docs = [_doc(experienceType="digital_books_hero", content={"title": "Books"})]
    client = _make_client(docs)
    resp = client.get("/api/experience-configs/active?type=welcome_dashboard")
    assert resp.json() == {"config": None}
    resp2 = client.get("/api/experience-configs/active?type=digital_books_hero")
    assert resp2.json()["config"]["content"]["title"] == "Books"


def test_most_recently_updated_wins_when_multiple_active():
    older = _doc(content={"title": "Older"}, updatedAt=NOW - timedelta(hours=2))
    newer = _doc(content={"title": "Newer"}, updatedAt=NOW)
    client = _make_client([older, newer])
    resp = client.get("/api/experience-configs/active?type=welcome_dashboard")
    assert resp.json()["config"]["content"]["title"] == "Newer"


def test_missing_type_param_is_rejected():
    client = _make_client([])
    resp = client.get("/api/experience-configs/active")
    assert resp.status_code == 422
