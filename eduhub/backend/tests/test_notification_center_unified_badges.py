"""tests/test_notification_center_unified_badges.py — v1.1 additive coverage
for the unified notification/badge platform work.

Covers exactly the new surface area added to notification_center.py:
  1. classify_event() explicit `category` override + fallback to inference
  2. _record_event() dedupe_key skips a duplicate event
  3. wrap_fan_out_push() forwards nothing extra to the original push sender
     and still works with the original 4-positional-arg call shape
  4. GET /notifications/unread-count returns a `byCategory` breakdown
     alongside the unchanged `count` total

No live MongoDB — mirrors the established in-process fake pattern from
test_notification_center_ws_auth.py, extended with insert/count/aggregate
support since this module's new code path uses aggregation.
"""
from __future__ import annotations

from datetime import datetime, timedelta, timezone

import pytest
from fastapi import APIRouter, FastAPI
from fastapi.testclient import TestClient

import notification_center as nc


# ─────────────────────────────────────────────────────────────────────────
# Minimal in-process Mongo-shaped fake (find_one / insert / count / aggregate)
# ─────────────────────────────────────────────────────────────────────────
class _FakeObjectId:
    _n = 0

    def __init__(self):
        _FakeObjectId._n += 1
        self._id = _FakeObjectId._n

    def __str__(self):
        return f"fakeid{self._id}"


def _match_value(doc_value, query_value):
    if isinstance(query_value, dict):
        if "$in" in query_value:
            return doc_value in query_value["$in"]
        if "$nin" in query_value:
            return doc_value not in query_value["$nin"]
        if "$ne" in query_value:
            return doc_value != query_value["$ne"]
    return doc_value == query_value


def _matches_query(doc, query):
    return all(_match_value(doc.get(k), v) for k, v in query.items())


class _InsertResult:
    def __init__(self, ids):
        self.inserted_id = ids[0] if len(ids) == 1 else None
        self.inserted_ids = ids


class _Cursor:
    def __init__(self, docs):
        self._docs = docs

    def sort(self, *a, **k):
        return self

    def limit(self, *a, **k):
        return self

    async def to_list(self, length=None):
        return list(self._docs)


class _AggCursor:
    def __init__(self, rows):
        self._rows = rows

    def __aiter__(self):
        return self._gen()

    async def _gen(self):
        for r in self._rows:
            yield r


class _Coll:
    def __init__(self, docs=None):
        self._docs = list(docs or [])

    async def find_one(self, q, projection=None):
        for doc in self._docs:
            if _matches_query(doc, q):
                return dict(doc)
        return None

    def find(self, q):
        return _Cursor([dict(d) for d in self._docs if _matches_query(d, q)])

    async def insert_one(self, doc):
        oid = _FakeObjectId()
        doc = dict(doc)
        doc["_id"] = oid
        self._docs.append(doc)
        return _InsertResult([oid])

    async def insert_many(self, docs):
        ids = []
        for d in docs:
            oid = _FakeObjectId()
            d["_id"] = oid
            self._docs.append(d)
            ids.append(oid)
        return _InsertResult(ids)

    async def count_documents(self, q):
        return sum(1 for d in self._docs if _matches_query(d, q))

    async def update_one(self, q, update):
        for d in self._docs:
            if _matches_query(d, q):
                _apply_update(d, update)
                return
        return None

    async def update_many(self, q, update):
        n = 0
        for d in self._docs:
            if _matches_query(d, q):
                _apply_update(d, update)
                n += 1

        class _R:
            modified_count = n

        return _R()

    def aggregate(self, pipeline):
        docs = [dict(d) for d in self._docs]
        for stage in pipeline:
            if "$match" in stage:
                docs = [d for d in docs if _matches_query(d, stage["$match"])]
            elif "$group" in stage:
                spec = stage["$group"]
                key_field = spec["_id"].lstrip("$") if isinstance(spec["_id"], str) else None
                buckets: dict = {}
                for d in docs:
                    k = d.get(key_field) if key_field else None
                    buckets.setdefault(k, 0)
                    buckets[k] += 1  # only {"$sum": 1} is used by this module
                docs = [{"_id": k, "n": v} for k, v in buckets.items()]
        return _AggCursor(docs)

    async def create_index(self, *a, **k):
        return "idx"

    async def distinct(self, field, q):
        return list({d.get(field) for d in self._docs if _matches_query(d, q)})


def _apply_update(doc, update):
    if "$set" in update:
        doc.update(update["$set"])
    if "$addToSet" in update:
        for k, v in update["$addToSet"].items():
            arr = doc.setdefault(k, [])
            if v not in arr:
                arr.append(v)


class _FakeDB:
    def __init__(self):
        self.activity_notifications = _Coll([])
        self.push_subscriptions = _Coll([])

    def __getitem__(self, name):
        return getattr(self, name)


class _Student:
    def __init__(self, clean_id):
        self.clean_id = clean_id
        self.student_id = clean_id


def _make_client(db):
    app = FastAPI()
    api = APIRouter(prefix="/api")

    async def _require_student():
        return _Student("stu094")

    app.dependency_overrides = {}
    nc.register_notification_center(api, app, db, _require_student)
    app.include_router(api)
    return TestClient(app)


# ─────────────────────────────────────────────────────────────────────────
# 1. classify_event — explicit override + fallback
# ─────────────────────────────────────────────────────────────────────────
def test_classify_event_explicit_category_wins():
    cat, _ = nc.classify_event("Random title", "unrelated body", "/somewhere", category="speaking_lab")
    assert cat == "speaking_lab"


def test_classify_event_invalid_category_falls_back_to_inference():
    cat, _ = nc.classify_event("Attendance reward", "You checked in", "/attendance/me", category="not_a_real_category")
    assert cat == "attendance"


def test_classify_event_no_category_arg_is_byte_identical_to_v1():
    cat, pri = nc.classify_event("Payment failed", "Try again", "/portal/me")
    cat2, pri2 = nc.classify_event("Payment failed", "Try again", "/portal/me", category=None)
    assert (cat, pri) == (cat2, pri2)


# ─────────────────────────────────────────────────────────────────────────
# 2. _record_event — dedupe_key
# ─────────────────────────────────────────────────────────────────────────
@pytest.mark.asyncio
async def test_dedupe_key_prevents_duplicate_event():
    db = _FakeDB()
    query = {"studentId": "stu094"}
    await nc._record_event(db, query, "Prize!", "You won", "/game", category="rewards", dedupe_key="lucky:evt1")
    await nc._record_event(db, query, "Prize!", "You won", "/game", category="rewards", dedupe_key="lucky:evt1")
    docs = [d for d in db.activity_notifications._docs if d.get("studentId") == "stu094"]
    assert len(docs) == 1


@pytest.mark.asyncio
async def test_different_dedupe_keys_both_recorded():
    db = _FakeDB()
    query = {"studentId": "stu094"}
    await nc._record_event(db, query, "Prize!", "You won", "/game", category="rewards", dedupe_key="lucky:evt1")
    await nc._record_event(db, query, "Prize!", "You won again", "/game", category="rewards", dedupe_key="lucky:evt2")
    docs = [d for d in db.activity_notifications._docs if d.get("studentId") == "stu094"]
    assert len(docs) == 2


@pytest.mark.asyncio
async def test_no_dedupe_key_records_every_call_v1_behaviour():
    db = _FakeDB()
    query = {"studentId": "stu094"}
    await nc._record_event(db, query, "Points credited", "+10", "/portal/me")
    await nc._record_event(db, query, "Points credited", "+10", "/portal/me")
    docs = [d for d in db.activity_notifications._docs if d.get("studentId") == "stu094"]
    assert len(docs) == 2  # no dedupe requested -> both recorded, unchanged from v1.0


# ─────────────────────────────────────────────────────────────────────────
# 3. wrap_fan_out_push — original push sender untouched
# ─────────────────────────────────────────────────────────────────────────
@pytest.mark.asyncio
async def test_wrapper_forwards_only_original_four_args():
    calls = []

    async def _original(subs_query, title, body, url):
        calls.append((subs_query, title, body, url))
        return (1, 0)

    db = _FakeDB()
    wrapped = nc.wrap_fan_out_push(_original, db)

    # Existing call sites call positionally with exactly 4 args — must
    # still work with zero changes.
    result = await wrapped({"studentId": "stu094"}, "Hi", "Body", "/x")
    assert result == (1, 0)
    assert calls == [({"studentId": "stu094"}, "Hi", "Body", "/x")]


@pytest.mark.asyncio
async def test_wrapper_new_kwargs_never_reach_original():
    async def _original(subs_query, title, body, url):
        return (1, 0)

    db = _FakeDB()
    wrapped = nc.wrap_fan_out_push(_original, db)
    # Would raise TypeError if category/dedupe_key were forwarded to
    # _original, since it only accepts 4 positional params.
    await wrapped({"studentId": "stu094"}, "Hi", "Body", "/x", category="speaking_lab", dedupe_key="k1")
    docs = [d for d in db.activity_notifications._docs if d.get("studentId") == "stu094"]
    assert docs[0]["category"] == "speaking_lab"
    assert docs[0]["dedupeKey"] == "k1"


# ─────────────────────────────────────────────────────────────────────────
# 4. GET /notifications/unread-count — byCategory breakdown
# ─────────────────────────────────────────────────────────────────────────
def _mk_doc(category, read=False):
    now = datetime.now(timezone.utc)
    return {
        "_id": _FakeObjectId(),
        "studentId": "stu094",
        "title": "t", "body": "b", "url": "/",
        "category": category, "priority": "normal",
        "read": read,
        "source": "push_fanout",
        "createdAt": now, "expiresAt": now + timedelta(days=30),
    }


def test_unread_count_returns_bycategory_breakdown():
    db = _FakeDB()
    db.activity_notifications._docs = [
        _mk_doc("speaking_lab"),
        _mk_doc("speaking_lab"),
        _mk_doc("points"),
        _mk_doc("attendance", read=True),  # read -> excluded
    ]
    client = _make_client(db)
    resp = client.get("/api/notifications/unread-count")
    assert resp.status_code == 200
    data = resp.json()
    assert data["count"] == 3
    assert data["byCategory"] == {"speaking_lab": 2, "points": 1}


def test_unread_count_shape_is_backward_compatible():
    """A caller reading only `.count` (the v1.0 contract) must see the same
    value it always would have — the new `byCategory` field must never
    change what `count` means."""
    db = _FakeDB()
    db.activity_notifications._docs = [_mk_doc("rewards"), _mk_doc("rewards"), _mk_doc("system")]
    client = _make_client(db)
    data = client.get("/api/notifications/unread-count").json()
    assert data["count"] == sum(data["byCategory"].values())
    assert data["count"] == 3
