"""tests/test_question_bank.py
=====================================================
Question Bank (architecture.md "Question Bank: categories/search/import/
export/versioning/publish, moved into Author Studio"). Covers
question_bank.py's pure functions (CRUD/lifecycle, search, category
listing, import/export including the legacy flat-shape conversion)
against an in-memory fake Mongo, plus the HTTP routes via a real
APIRouter + FastAPI + TestClient (matching the test_event_engine.py
pattern already established in this codebase).
"""
from __future__ import annotations

import pytest
from fastapi import APIRouter, FastAPI
from fastapi.testclient import TestClient

import question_bank as qb


# ── fake Mongo (same shape as test_event_engine.py's _Coll/_Cursor) ─────
class _Cursor:
    def __init__(self, docs):
        self._docs = list(docs)

    def sort(self, key, direction=None):
        self._docs = sorted(self._docs, key=lambda d: d.get(key) or "", reverse=True)
        return self

    def __aiter__(self):
        self._it = iter(self._docs)
        return self

    async def __anext__(self):
        try:
            return next(self._it)
        except StopIteration:
            raise StopAsyncIteration


class _Result:
    def __init__(self, **kw):
        for k, v in kw.items():
            setattr(self, k, v)


class _Coll:
    def __init__(self):
        self.docs: dict[str, dict] = {}

    async def insert_one(self, doc):
        self.docs[doc["_id"]] = dict(doc)
        return _Result(inserted_id=doc["_id"])

    async def find_one(self, query, projection=None):
        _id = query.get("_id")
        if _id is not None:
            doc = self.docs.get(_id)
            return dict(doc) if doc else None
        for d in self.docs.values():
            if all(d.get(k) == v for k, v in query.items()):
                return dict(d)
        return None

    async def update_one(self, query, update):
        _id = query.get("_id")
        target = self.docs.get(_id)
        if target is None:
            return _Result(matched_count=0)
        if "$set" in update:
            target.update(update["$set"])
        return _Result(matched_count=1)

    async def delete_one(self, query):
        _id = query.get("_id")
        if _id in self.docs:
            del self.docs[_id]
            return _Result(deleted_count=1)
        return _Result(deleted_count=0)

    def find(self, query=None, projection=None):
        query = dict(query or {})
        regex = query.pop("text", None)
        docs = [d for d in self.docs.values() if all(d.get(k) == v for k, v in query.items())]
        if isinstance(regex, dict) and "$regex" in regex:
            import re
            pattern = re.compile(regex["$regex"], re.IGNORECASE)
            docs = [d for d in docs if pattern.search(d.get("text", ""))]
        return _Cursor(docs)

    async def create_index(self, *a, **k):
        return None


class _FakeDB:
    def __init__(self):
        self.questions = _Coll()

    def __getitem__(self, name):
        assert name == qb.QUESTIONS_COLL
        return self.questions


# ═════════════════════════════════════════════════════════════════════════
# CRUD + lifecycle
# ═════════════════════════════════════════════════════════════════════════
@pytest.mark.asyncio
async def test_create_question_defaults_to_draft():
    db = _FakeDB()
    q = await qb.create_question(db, category="beginner", text="What is your name?", created_by="a")
    assert q["status"] == "draft"
    assert q["version"] == 1
    assert q["category"] == "beginner"


@pytest.mark.asyncio
async def test_create_question_rejects_empty_category_or_text():
    db = _FakeDB()
    with pytest.raises(qb.QuestionBankError) as exc:
        await qb.create_question(db, category="", text="X", created_by="a")
    assert exc.value.code == "invalid_category"

    with pytest.raises(qb.QuestionBankError) as exc:
        await qb.create_question(db, category="beginner", text="  ", created_by="a")
    assert exc.value.code == "invalid_text"


@pytest.mark.asyncio
async def test_update_question_only_while_draft():
    db = _FakeDB()
    q = await qb.create_question(db, category="beginner", text="A?", created_by="a")
    updated = await qb.update_question(db, q["_id"], {"text": "B?"}, updated_by="a")
    assert updated["text"] == "B?"
    assert updated["version"] == 2

    await qb.publish_question(db, q["_id"], updated_by="a")
    with pytest.raises(qb.QuestionBankError) as exc:
        await qb.update_question(db, q["_id"], {"text": "C?"}, updated_by="a")
    assert exc.value.code == "question_not_editable"


@pytest.mark.asyncio
async def test_publish_unpublish_archive_lifecycle():
    db = _FakeDB()
    q = await qb.create_question(db, category="beginner", text="A?", created_by="a")
    published = await qb.publish_question(db, q["_id"], updated_by="a")
    assert published["status"] == "published"
    assert published["published_at"] is not None

    reverted = await qb.unpublish_question(db, q["_id"], updated_by="a")
    assert reverted["status"] == "draft"

    archived = await qb.archive_question(db, q["_id"], updated_by="a")
    assert archived["status"] == "archived"

    with pytest.raises(qb.QuestionBankError) as exc:
        await qb.publish_question(db, q["_id"], updated_by="a")
    assert exc.value.code == "question_archived"


@pytest.mark.asyncio
async def test_delete_blocked_while_published():
    db = _FakeDB()
    q = await qb.create_question(db, category="beginner", text="A?", created_by="a")
    await qb.publish_question(db, q["_id"], updated_by="a")
    with pytest.raises(qb.QuestionBankError) as exc:
        await qb.delete_question(db, q["_id"])
    assert exc.value.code == "question_published"

    await qb.unpublish_question(db, q["_id"], updated_by="a")
    deleted = await qb.delete_question(db, q["_id"])
    assert deleted is True
    assert await qb.get_question(db, q["_id"]) is None


@pytest.mark.asyncio
async def test_delete_missing_question_raises_404():
    db = _FakeDB()
    with pytest.raises(qb.QuestionBankError) as exc:
        await qb.delete_question(db, "qb_missing")
    assert exc.value.http_status == 404


# ═════════════════════════════════════════════════════════════════════════
# Listing, search, categories
# ═════════════════════════════════════════════════════════════════════════
@pytest.mark.asyncio
async def test_list_questions_filters_by_category_and_status():
    db = _FakeDB()
    b1 = await qb.create_question(db, category="beginner", text="Hi?", created_by="a")
    i1 = await qb.create_question(db, category="intermediate", text="Explain?", created_by="a")
    await qb.publish_question(db, i1["_id"], updated_by="a")

    beginner = await qb.list_questions(db, category="beginner")
    assert [q["_id"] for q in beginner] == [b1["_id"]]

    published = await qb.list_questions(db, status="published")
    assert [q["_id"] for q in published] == [i1["_id"]]


@pytest.mark.asyncio
async def test_search_is_case_insensitive_substring():
    db = _FakeDB()
    q1 = await qb.create_question(db, category="beginner", text="What is your Favorite Color?", created_by="a")
    await qb.create_question(db, category="beginner", text="Where do you live?", created_by="a")

    results = await qb.list_questions(db, search="favorite color")
    assert [q["_id"] for q in results] == [q1["_id"]]


@pytest.mark.asyncio
async def test_search_escapes_regex_special_characters():
    db = _FakeDB()
    q1 = await qb.create_question(db, category="beginner", text="What is 2+2?", created_by="a")
    results = await qb.list_questions(db, search="2+2?")
    assert [q["_id"] for q in results] == [q1["_id"]]


@pytest.mark.asyncio
async def test_list_categories_counts_by_category():
    db = _FakeDB()
    await qb.create_question(db, category="beginner", text="A?", created_by="a")
    await qb.create_question(db, category="beginner", text="B?", created_by="a")
    await qb.create_question(db, category="intermediate", text="C?", created_by="a")

    cats = await qb.list_categories(db)
    assert cats == [
        {"category": "beginner", "count": 2},
        {"category": "intermediate", "count": 1},
    ]


# ═════════════════════════════════════════════════════════════════════════
# Import / export — including legacy flat-shape conversion
# ═════════════════════════════════════════════════════════════════════════
@pytest.mark.asyncio
async def test_import_new_shape():
    db = _FakeDB()
    result = await qb.import_questions(
        db,
        {"items": [
            {"category": "beginner", "text": "A?", "tags": ["intro"]},
            {"category": "intermediate", "text": "B?"},
        ]},
        created_by="a",
    )
    assert result["imported"] == 2
    assert result["skipped"] == 0
    all_qs = await qb.list_questions(db)
    assert len(all_qs) == 2


@pytest.mark.asyncio
async def test_import_legacy_flat_shape():
    db = _FakeDB()
    result = await qb.import_questions(
        db,
        {"beginner": ["What is your name?", "How old are you?"], "intermediate": ["Describe your city."]},
        created_by="a",
    )
    assert result["imported"] == 3
    beginner = await qb.list_questions(db, category="beginner")
    assert len(beginner) == 2
    intermediate = await qb.list_questions(db, category="intermediate")
    assert len(intermediate) == 1


@pytest.mark.asyncio
async def test_import_skips_invalid_items():
    db = _FakeDB()
    result = await qb.import_questions(
        db, {"items": [{"category": "", "text": "no category"}]}, created_by="a",
    )
    assert result["imported"] == 0
    assert result["skipped"] == 1


@pytest.mark.asyncio
async def test_export_round_trips_into_import():
    db = _FakeDB()
    await qb.import_questions(
        db, {"items": [{"category": "beginner", "text": "A?", "tags": ["x"]}]}, created_by="a",
    )
    exported = await qb.export_questions(db)
    assert exported["count"] == 1
    assert exported["items"] == [{"category": "beginner", "text": "A?", "tags": ["x"]}]

    db2 = _FakeDB()
    result = await qb.import_questions(db2, exported, created_by="b")
    assert result["imported"] == 1


@pytest.mark.asyncio
async def test_export_filters_by_category_and_status():
    db = _FakeDB()
    q1 = await qb.create_question(db, category="beginner", text="A?", created_by="a")
    await qb.create_question(db, category="intermediate", text="B?", created_by="a")
    await qb.publish_question(db, q1["_id"], updated_by="a")

    exported = await qb.export_questions(db, category="beginner")
    assert exported["count"] == 1

    exported_published = await qb.export_questions(db, status="published")
    assert exported_published["items"] == [{"category": "beginner", "text": "A?", "tags": []}]


# ═════════════════════════════════════════════════════════════════════════
# HTTP routes — real APIRouter + FastAPI + TestClient
# ═════════════════════════════════════════════════════════════════════════
class _Admin:
    email = "admin@test"


async def _admin_dep():
    return _Admin()


def _make_client(db):
    app = FastAPI()
    api = APIRouter(prefix="/api")
    qb.register_question_bank_routes(api, db, _admin_dep)
    app.include_router(api)
    return TestClient(app)


def test_create_list_get_routes():
    db = _FakeDB()
    client = _make_client(db)

    resp = client.post("/api/v1/question-bank", json={"category": "beginner", "text": "Hi?"})
    assert resp.status_code == 200
    qid = resp.json()["question"]["_id"]

    assert client.get("/api/v1/question-bank").json()["questions"][0]["_id"] == qid
    assert client.get(f"/api/v1/question-bank/{qid}").status_code == 200
    assert client.get("/api/v1/question-bank/qb_missing").status_code == 404


def test_publish_unpublish_archive_routes():
    db = _FakeDB()
    client = _make_client(db)
    qid = client.post("/api/v1/question-bank", json={"category": "beginner", "text": "Hi?"}).json()["question"]["_id"]

    resp = client.post(f"/api/v1/question-bank/{qid}/publish")
    assert resp.json()["question"]["status"] == "published"

    resp = client.patch(f"/api/v1/question-bank/{qid}", json={"text": "Nope"})
    assert resp.status_code == 400  # not editable while published

    resp = client.post(f"/api/v1/question-bank/{qid}/unpublish")
    assert resp.json()["question"]["status"] == "draft"

    resp = client.post(f"/api/v1/question-bank/{qid}/archive")
    assert resp.json()["question"]["status"] == "archived"


def test_import_export_routes():
    db = _FakeDB()
    client = _make_client(db)

    resp = client.post("/api/v1/question-bank/import", json={
        "beginner": ["What is your name?"], "intermediate": ["Describe your city."],
    })
    assert resp.json()["imported"] == 2

    resp = client.get("/api/v1/question-bank/export")
    assert resp.json()["count"] == 2

    resp = client.get("/api/v1/question-bank/categories")
    cats = {c["category"]: c["count"] for c in resp.json()["categories"]}
    assert cats == {"beginner": 1, "intermediate": 1}


def test_delete_route_blocked_while_published():
    db = _FakeDB()
    client = _make_client(db)
    qid = client.post("/api/v1/question-bank", json={"category": "beginner", "text": "Hi?"}).json()["question"]["_id"]
    client.post(f"/api/v1/question-bank/{qid}/publish")

    resp = client.delete(f"/api/v1/question-bank/{qid}")
    assert resp.status_code == 400

    client.post(f"/api/v1/question-bank/{qid}/unpublish")
    resp = client.delete(f"/api/v1/question-bank/{qid}")
    assert resp.status_code == 200
    assert resp.json()["deleted"] is True
