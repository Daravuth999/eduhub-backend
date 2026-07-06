"""tests/test_interaction_progress_routes.py
==================================================
Checkpoint 1 foundation tests for interaction_progress_tools.py — route-level
auth/derivation, book-existence gating (reusing the REAL access rule), batch
limits, atomic monotonic conflict resolution ($max semantics), and flag
gating. Self-contained in-memory fake Mongo (supports $max, unlike the
lighter fake used by test_book_factory_jobs.py) — no real Mongo, no network.
"""
from __future__ import annotations

import asyncio
import copy

import pytest
from fastapi import APIRouter, FastAPI, HTTPException
from fastapi.testclient import TestClient

import interaction_progress_tools as ipt


def run(coro):
    return asyncio.run(coro)


# ── self-contained fake Mongo (adds $max on top of the familiar operators) ─
class _Coll:
    def __init__(self):
        self.docs: dict[str, dict] = {}

    async def find_one(self, q, projection=None):
        for d in self.docs.values():
            if all(d.get(k) == v for k, v in q.items()):
                return copy.deepcopy(d)
        return None

    async def update_one(self, q, update, upsert=False):
        _id = q.get("_id")
        doc = self.docs.get(_id)
        if doc is None:
            if not upsert:
                return
            doc = {"_id": _id}
            self.docs[_id] = doc
            for k, v in update.get("$setOnInsert", {}).items():
                doc[k] = v
        for k, v in update.get("$set", {}).items():
            doc[k] = v
        for k, v in update.get("$max", {}).items():
            cur = doc.get(k)
            doc[k] = v if cur is None else max(cur, v)
        for k, v in update.get("$inc", {}).items():
            doc[k] = (doc.get(k) or 0) + v

    def find(self, q, projection=None):
        rows = [copy.deepcopy(d) for d in self.docs.values()
                if all(d.get(k) == v for k, v in q.items())]
        return _Cursor(rows)


class _Cursor:
    def __init__(self, rows):
        self._rows = rows

    def __aiter__(self):
        self._i = 0
        return self

    async def __anext__(self):
        if self._i >= len(self._rows):
            raise StopAsyncIteration
        row = self._rows[self._i]
        self._i += 1
        return row


class _DB:
    def __init__(self):
        self._c: dict[str, _Coll] = {}

    def __getitem__(self, name):
        return self._c.setdefault(name, _Coll())


class _Student:
    def __init__(self, clean_id):
        self.clean_id = clean_id


def _seed_book(db, slug="my-book", revision=3, published=True):
    run(db["books"].update_one(
        {"_id": slug}, {"$set": {"slug": slug, "revision": revision, "published": published}}, upsert=True,
    ))


async def _admin_dep():
    return {"email": "admin@test"}


def _student_dep(student_id="stu1"):
    async def dep():
        return _Student(student_id)
    return dep


def _make_client(db, student_id="stu1"):
    app = FastAPI()
    api = APIRouter(prefix="/api")
    ipt.register_interaction_progress_routes(api, db, _admin_dep, _student_dep(student_id))
    app.include_router(api)
    return TestClient(app)


@pytest.fixture(autouse=True)
def _enable(monkeypatch):
    monkeypatch.setenv("BOOK_PREMIUM_INTERACTIONS_ENABLED", "true")


def _sync_body(**overrides):
    item = {
        "bookSlug": "my-book", "revision": 3, "chapterId": "ch1", "blockId": "vocab_01",
        "state": "explored", "attemptCount": 0, "hintLevel": 0,
    }
    item.update(overrides)
    return {"items": [item]}


# ── flag gating ──────────────────────────────────────────────────────────────
def test_flag_off_returns_503(monkeypatch):
    monkeypatch.setenv("BOOK_PREMIUM_INTERACTIONS_ENABLED", "false")
    db = _DB()
    _seed_book(db)
    client = _make_client(db)
    r = client.post("/api/student/interaction-progress/sync", json=_sync_body())
    assert r.status_code == 503
    r2 = client.get("/api/student/interaction-progress/my-book")
    assert r2.status_code == 503


# ── studentId derivation — never trusts the payload ────────────────────────
def test_student_id_derived_from_auth_never_from_payload():
    db = _DB()
    _seed_book(db)
    client = _make_client(db, student_id="real-student")
    body = _sync_body()
    body["items"][0]["studentId"] = "attacker-supplied-id"
    r = client.post("/api/student/interaction-progress/sync", json=body)
    assert r.status_code == 200
    stored = list(db[ipt.COL_INTERACTION_PROGRESS].docs.values())[0]
    assert stored["studentId"] == "real-student"


# ── book existence/publication check reuses the real access rule ──────────
def test_unknown_book_rejected_without_failing_whole_batch():
    db = _DB()
    _seed_book(db, slug="real-book")
    client = _make_client(db)
    body = {"items": [
        _sync_body()["items"][0] | {"bookSlug": "does-not-exist"},
        _sync_body()["items"][0] | {"bookSlug": "real-book", "revision": 3},
    ]}
    r = client.post("/api/student/interaction-progress/sync", json=body)
    assert r.status_code == 200
    results = r.json()["results"]
    assert results[0]["applied"] is False
    assert results[0]["reason"] == "book_not_found_or_not_published"
    assert results[1]["applied"] is True


def test_unpublished_book_rejected():
    db = _DB()
    _seed_book(db, slug="draft-book", published=False)
    client = _make_client(db)
    body = _sync_body(bookSlug="draft-book", revision=3)
    r = client.post("/api/student/interaction-progress/sync", json={"items": [body["items"][0]]})
    result = r.json()["results"][0]
    assert result["applied"] is False


# ── batch/payload limits ────────────────────────────────────────────────────
def test_batch_size_limit_enforced():
    db = _DB()
    _seed_book(db)
    client = _make_client(db)
    items = [_sync_body()["items"][0] for _ in range(ipt._MAX_BATCH_ITEMS + 1)]
    r = client.post("/api/student/interaction-progress/sync", json={"items": items})
    assert r.status_code == 400


def test_empty_items_rejected():
    db = _DB()
    client = _make_client(db)
    r = client.post("/api/student/interaction-progress/sync", json={"items": []})
    assert r.status_code == 400


def test_attempt_count_and_hint_level_clamped():
    db = _DB()
    _seed_book(db)
    client = _make_client(db)
    body = _sync_body(attemptCount=999, hintLevel=999)
    client.post("/api/student/interaction-progress/sync", json=body)
    stored = list(db[ipt.COL_INTERACTION_PROGRESS].docs.values())[0]
    assert stored["attemptCount"] == ipt._MAX_ATTEMPT_COUNT
    assert stored["hintLevel"] == ipt._MAX_HINT_LEVEL


# ── monotonic conflict resolution (§LOCKED CORRECTION 6) ───────────────────
def test_completed_can_never_regress_to_explored():
    db = _DB()
    _seed_book(db)
    client = _make_client(db)
    client.post("/api/student/interaction-progress/sync", json=_sync_body(state="completed"))
    # A stale/out-of-order "explored" request arrives after "completed".
    client.post("/api/student/interaction-progress/sync", json=_sync_body(state="explored"))
    r = client.get("/api/student/interaction-progress/my-book")
    items = r.json()["items"]
    assert items[0]["state"] == "completed"


def test_attempt_count_never_decreases_regardless_of_arrival_order():
    db = _DB()
    _seed_book(db)
    client = _make_client(db)
    client.post("/api/student/interaction-progress/sync", json=_sync_body(attemptCount=3))
    client.post("/api/student/interaction-progress/sync", json=_sync_body(attemptCount=1))  # stale/late
    r = client.get("/api/student/interaction-progress/my-book")
    assert r.json()["items"][0]["attemptCount"] == 3


def test_future_client_clock_cannot_poison_later_progress():
    """clientUpdatedAt is diagnostic-only — a device with a wrong future
    clock claiming a huge clientUpdatedAt must NOT let a lower-progress
    write win over a later, genuinely-more-advanced write."""
    db = _DB()
    _seed_book(db)
    client = _make_client(db)
    # "Future-clocked" device sends a low-progress update with a fake future timestamp.
    client.post("/api/student/interaction-progress/sync",
                json=_sync_body(attemptCount=1, clientUpdatedAt="2099-01-01T00:00:00+00:00"))
    # A normal device sends genuinely higher progress afterward.
    client.post("/api/student/interaction-progress/sync",
                json=_sync_body(attemptCount=5, clientUpdatedAt="2026-01-01T00:00:00+00:00"))
    r = client.get("/api/student/interaction-progress/my-book")
    assert r.json()["items"][0]["attemptCount"] == 5


def test_progress_version_increments_on_every_processed_write():
    db = _DB()
    _seed_book(db)
    client = _make_client(db)
    client.post("/api/student/interaction-progress/sync", json=_sync_body())
    client.post("/api/student/interaction-progress/sync", json=_sync_body())
    stored = list(db[ipt.COL_INTERACTION_PROGRESS].docs.values())[0]
    assert stored["progressVersion"] == 2


def test_selected_branch_is_last_write_wins():
    db = _DB()
    _seed_book(db)
    client = _make_client(db)
    client.post("/api/student/interaction-progress/sync",
                json=_sync_body(blockId="branch_01", selectedBranch="n1a"))
    client.post("/api/student/interaction-progress/sync",
                json=_sync_body(blockId="branch_01", selectedBranch="n1b"))
    r = client.get("/api/student/interaction-progress/my-book")
    assert r.json()["items"][0]["selectedBranch"] == "n1b"


# ── ownership isolation between students ───────────────────────────────────
def test_progress_scoped_per_student():
    db = _DB()
    _seed_book(db)
    client_a = _make_client(db, student_id="student-a")
    client_b = _make_client(db, student_id="student-b")
    client_a.post("/api/student/interaction-progress/sync", json=_sync_body(state="completed"))
    r_b = client_b.get("/api/student/interaction-progress/my-book")
    assert r_b.json()["items"] == []
    r_a = client_a.get("/api/student/interaction-progress/my-book")
    assert r_a.json()["items"][0]["state"] == "completed"


# ── wallet/reward/ownership isolation — no such collection is EVER touched ─
def test_no_wallet_or_reward_collection_is_ever_touched():
    db = _DB()
    _seed_book(db)
    client = _make_client(db)
    client.post("/api/student/interaction-progress/sync", json=_sync_body(state="completed"))
    assert "points_wallets" not in db._c
    assert "points_transactions" not in db._c
    assert "student_purchases" not in db._c
