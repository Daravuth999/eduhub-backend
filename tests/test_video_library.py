"""tests/test_video_library.py
=====================================================
Video Library — independent product, backend-owned entitlement. Covers
video_schema.py's pure builders/validators, video_library_points_adapter.py
(mocked httpx — no real network call), and video_library_tools.py's
purchase state machine against an in-memory fake Mongo, including the one
property that matters most: concurrent purchase attempts can never both
succeed (structurally, via the atomic claim), never via a lucky race.
"""
from __future__ import annotations

import asyncio

import pytest

import video_schema as schema
import video_library_points_adapter as points
import video_library_tools as vlt


# ═════════════════════════════════════════════════════════════════════════
# video_schema.py
# ═════════════════════════════════════════════════════════════════════════
def test_build_video_lesson_defaults_and_ids():
    doc = schema.build_video_lesson(title="Ordering Coffee", price=50)
    assert doc["lessonId"].startswith("vid_")
    assert doc["status"] == "draft"
    assert doc["syncId"] is None
    assert doc["revision"] == 1


def test_build_video_lesson_rejects_negative_price():
    with pytest.raises(ValueError):
        schema.build_video_lesson(title="x", price=-1)


def test_build_video_lesson_rejects_invalid_status():
    with pytest.raises(ValueError):
        schema.build_video_lesson(title="x", price=0, status="deleted")


def test_validate_video_lesson_catches_missing_fields():
    ok, errors = schema.validate_video_lesson({"title": "x"})
    assert not ok
    assert any("price" in e for e in errors)


def test_build_purchase_record_starts_created_with_history():
    rec = schema.build_purchase_record(student_id="stu1", lesson_id="vid_1", price=50, created_at="t0")
    assert rec["state"] == "created"
    assert rec["stateHistory"] == [{"state": "created", "at": "t0"}]


@pytest.mark.parametrize(
    "state,expected",
    [("succeeded", True), ("created", False), ("initiating", False), ("failed", False), ("reconcile", False)],
)
def test_is_owned_only_true_for_succeeded(state, expected):
    assert schema.is_owned({"state": state}) is expected


def test_is_owned_false_for_none():
    assert schema.is_owned(None) is False


# ═════════════════════════════════════════════════════════════════════════
# video_library_points_adapter.py — mocked httpx, no real network call
# ═════════════════════════════════════════════════════════════════════════
class _FakeResponse:
    def __init__(self, status_code, body):
        self.status_code = status_code
        self._body = body

    def json(self):
        return self._body


class _FakeAsyncClient:
    def __init__(self, response, *, raise_exc=None):
        self._response = response
        self._raise_exc = raise_exc

    async def __aenter__(self):
        return self

    async def __aexit__(self, *a):
        return False

    async def post(self, url, data=None, params=None):
        if self._raise_exc:
            raise self._raise_exc
        return self._response

    async def get(self, url, params=None):
        if self._raise_exc:
            raise self._raise_exc
        return self._response


def test_gas_debit_configured_reflects_env(monkeypatch):
    monkeypatch.delenv("GAS_POINTS_LOGIN_URL", raising=False)
    assert points.gas_debit_configured() is False
    monkeypatch.setenv("GAS_POINTS_LOGIN_URL", "https://gas.example/exec")
    assert points.gas_debit_configured() is True


@pytest.mark.asyncio
async def test_debit_purchase_ok(monkeypatch):
    monkeypatch.setenv("GAS_POINTS_LOGIN_URL", "https://gas.example/exec")
    monkeypatch.setattr(points.httpx, "AsyncClient", lambda **kw: _FakeAsyncClient(_FakeResponse(200, {"success": True})))
    result = await points.debit_purchase("stu1", "pw", 50)
    assert result["outcome"] == points.OUTCOME_OK


@pytest.mark.asyncio
async def test_debit_purchase_rejected(monkeypatch):
    monkeypatch.setenv("GAS_POINTS_LOGIN_URL", "https://gas.example/exec")
    monkeypatch.setattr(points.httpx, "AsyncClient", lambda **kw: _FakeAsyncClient(_FakeResponse(200, {"success": False, "message": "insufficient"})))
    result = await points.debit_purchase("stu1", "pw", 50)
    assert result["outcome"] == points.OUTCOME_REJECTED


@pytest.mark.asyncio
async def test_debit_purchase_ambiguous_on_network_error(monkeypatch):
    monkeypatch.setenv("GAS_POINTS_LOGIN_URL", "https://gas.example/exec")
    import httpx as real_httpx
    monkeypatch.setattr(points.httpx, "AsyncClient", lambda **kw: _FakeAsyncClient(None, raise_exc=real_httpx.TimeoutException("timeout")))
    result = await points.debit_purchase("stu1", "pw", 50)
    assert result["outcome"] == points.OUTCOME_AMBIGUOUS


@pytest.mark.asyncio
async def test_debit_purchase_rejects_missing_password():
    result = await points.debit_purchase("stu1", "", 50)
    assert result["outcome"] == points.OUTCOME_REJECTED
    assert result["reason"] == "missing_password"


@pytest.mark.asyncio
async def test_debit_purchase_rejects_non_positive_amount(monkeypatch):
    monkeypatch.setenv("GAS_POINTS_LOGIN_URL", "https://gas.example/exec")
    result = await points.debit_purchase("stu1", "pw", 0)
    assert result["outcome"] == points.OUTCOME_REJECTED
    assert result["reason"] == "non_positive_amount"


# ═════════════════════════════════════════════════════════════════════════
# video_library_tools.py — fake Mongo supporting find_one_and_update
# ═════════════════════════════════════════════════════════════════════════
class _Result:
    def __init__(self, **kw):
        for k, v in kw.items():
            setattr(self, k, v)


class _Cursor:
    def __init__(self, docs):
        self._docs = list(docs)

    def sort(self, spec):
        for key, direction in reversed(spec):
            self._docs = sorted(self._docs, key=lambda d: d.get(key) or "", reverse=(direction == -1))
        return self

    async def to_list(self, length=None):
        return [dict(d) for d in self._docs[:length]]


def _matches(doc, query):
    for k, v in (query or {}).items():
        if isinstance(v, dict) and "$in" in v:
            if doc.get(k) not in v["$in"]:
                return False
        elif doc.get(k) != v:
            return False
    return True


class _Coll:
    def __init__(self):
        self.docs: dict = {}

    def _match_one(self, query):
        for doc in self.docs.values():
            if _matches(doc, query):
                return doc
        return None

    async def insert_one(self, doc):
        key = doc.get("_id") or doc.get("lessonId") or doc.get("purchaseId") or doc.get("syncId")
        self.docs[key] = dict(doc)
        return _Result(inserted_id=key)

    async def find_one(self, query, projection=None):
        doc = self._match_one(query)
        if not doc:
            return None
        out = dict(doc)
        if projection and projection.get("_id") == 0:
            out.pop("_id", None)
        return out

    async def update_one(self, query, update, upsert=False):
        doc = self._match_one(query)
        if doc is None:
            if upsert and "$setOnInsert" in update:
                new_doc = dict(update["$setOnInsert"])
                self.docs[new_doc["_id"]] = new_doc
                return _Result(matched_count=0, upserted_id=new_doc["_id"])
            if upsert and "$set" in update:
                new_doc = {**query, **update["$set"]}
                key = new_doc.get("_id") or query.get("_id")
                new_doc["_id"] = key
                self.docs[key] = new_doc
                return _Result(matched_count=0, upserted_id=key)
            return _Result(matched_count=0)
        if "$set" in update:
            doc.update(update["$set"])
        if "$push" in update:
            for k, v in update["$push"].items():
                doc.setdefault(k, []).append(v)
        return _Result(matched_count=1)

    async def find_one_and_update(self, query, update):
        doc = self._match_one(query)
        if doc is None:
            return None
        before = dict(doc)
        if "$set" in update:
            doc.update(update["$set"])
        if "$push" in update:
            for k, v in update["$push"].items():
                doc.setdefault(k, []).append(v)
        return before

    async def delete_one(self, query):
        for key, doc in list(self.docs.items()):
            if _matches(doc, query):
                del self.docs[key]
                return _Result(deleted_count=1)
        return _Result(deleted_count=0)

    def find(self, query=None, projection=None):
        return _Cursor([d for d in self.docs.values() if _matches(d, query or {})])


class _FakeDB:
    def __init__(self):
        self.video_lessons = _Coll()
        self.video_purchases = _Coll()
        self.video_progress = _Coll()
        self.video_bookmarks = _Coll()
        self.chapter_sync = _Coll()  # sync_studio_tools.py's collection — cross-module reuse test

    def __getitem__(self, name):
        if name == vlt.LESSONS_COLL:
            return self.video_lessons
        if name == vlt.PURCHASES_COLL:
            return self.video_purchases
        if name == vlt.PROGRESS_COLL:
            return self.video_progress
        if name == vlt.BOOKMARKS_COLL:
            return self.video_bookmarks
        if name == "chapter_sync":
            return self.chapter_sync
        raise AssertionError(f"unexpected collection: {name}")


async def _seed_published_lesson(db, *, price=50, lesson_id="vid_1", sync_id="sync_abc", media_ref="https://pub-x.r2.dev/vid.mp4"):
    lesson = schema.build_video_lesson(
        title="Ordering Coffee", price=price, lesson_id=lesson_id, sync_id=sync_id, media_ref=media_ref,
        status="published", created_at="t0",
    )
    await db[vlt.LESSONS_COLL].insert_one(lesson)
    return lesson


# ── lesson CRUD ──────────────────────────────────────────────────────────
@pytest.mark.asyncio
async def test_create_video_lesson_persists():
    db = _FakeDB()
    doc = await vlt.create_video_lesson(db, title="Hello", price=10, created_by="admin@x.com")
    assert doc["title"] == "Hello"
    assert await vlt.get_video_lesson(db, doc["lessonId"]) is not None


@pytest.mark.asyncio
async def test_update_video_lesson_bumps_revision_and_ignores_unsafe_keys():
    db = _FakeDB()
    doc = await vlt.create_video_lesson(db, title="Hello", price=10, created_by="a")
    updated = await vlt.update_video_lesson(db, doc["lessonId"], {"price": 20, "lessonId": "hacked"})
    assert updated["price"] == 20
    assert updated["lessonId"] == doc["lessonId"]  # unsafe key ignored
    assert updated["revision"] == 2


@pytest.mark.asyncio
async def test_update_video_lesson_not_found_raises():
    db = _FakeDB()
    with pytest.raises(vlt.VideoLibraryError) as exc:
        await vlt.update_video_lesson(db, "missing", {"price": 5})
    assert exc.value.http_status == 404


# ── media upload — reuses sync_studio_tools.py, no duplicated storage logic ─
class _FakeGridOut:
    def __init__(self, data, metadata):
        self._data, self._pos, self.metadata, self.length = data, 0, metadata, len(data)

    async def seek(self, pos):
        self._pos = pos

    async def read(self, n):
        chunk = self._data[self._pos:self._pos + n]
        self._pos += len(chunk)
        return chunk


class _FakeMediaBucket:
    def __init__(self):
        self.files: dict = {}

    async def upload_from_stream(self, filename, stream, metadata=None):
        self.files[filename] = (stream.read(), metadata or {})

    async def open_download_stream_by_name(self, filename):
        data, metadata = self.files[filename]
        return _FakeGridOut(data, metadata)


@pytest.mark.asyncio
async def test_attach_lesson_media_binds_sync_id_via_shared_engine():
    """Proves the reuse claim directly: attach_lesson_media never touches
    chapter_sync itself — it calls sync_studio_tools.create_sync_from_upload
    (the SAME function Books uses) and only binds the returned syncId onto
    the lesson document."""
    db = _FakeDB()
    lesson = await vlt.create_video_lesson(db, title="Ordering Coffee", price=50, created_by="admin@x.com")
    bucket = _FakeMediaBucket()

    updated = await vlt.attach_lesson_media(
        db, lesson["lessonId"], raw=b"fake-video-bytes",
        declared_content_type="video/mp4", media_bucket=bucket, uploaded_by="admin@x.com",
    )

    assert updated["syncId"] is not None
    assert updated["syncId"].startswith("sync_")
    sync_doc = db.chapter_sync.docs[updated["syncId"]]
    assert sync_doc["ownerRef"] == f"video_lesson:{lesson['lessonId']}"
    assert sync_doc["alignmentStatus"] == "awaiting_provider"
    # mediaRef is denormalized onto the lesson so playback never depends on
    # sync_schema.is_servable_to_students()'s alignment-readiness gate.
    assert updated["mediaRef"] == sync_doc["mediaRef"]
    assert updated["mediaRef"].startswith("gridfs://sync_media/")
    assert len(bucket.files) == 1  # stored via GridFS fallback (no R2 env vars in tests)


@pytest.mark.asyncio
async def test_attach_lesson_media_rejects_unsupported_type():
    db = _FakeDB()
    lesson = await vlt.create_video_lesson(db, title="X", price=10, created_by="a")
    with pytest.raises(vlt.VideoLibraryError) as exc:
        await vlt.attach_lesson_media(
            db, lesson["lessonId"], raw=b"x", declared_content_type="image/png", media_bucket=_FakeMediaBucket(),
        )
    assert exc.value.code == "unsupported_media_type"


@pytest.mark.asyncio
async def test_attach_lesson_media_lesson_not_found():
    db = _FakeDB()
    with pytest.raises(vlt.VideoLibraryError) as exc:
        await vlt.attach_lesson_media(
            db, "missing", raw=b"x", declared_content_type="video/mp4", media_bucket=_FakeMediaBucket(),
        )
    assert exc.value.http_status == 404


# ── ownership serialization ──────────────────────────────────────────────
@pytest.mark.asyncio
async def test_free_lesson_always_shows_owned_and_sync_id():
    db = _FakeDB()
    lesson = await _seed_published_lesson(db, price=0)
    out = await vlt.serialize_lesson_for_student(db, lesson, "stu1")
    assert out["owned"] is True
    assert out["syncId"] == "sync_abc"


@pytest.mark.asyncio
async def test_paid_lesson_hides_sync_id_when_not_owned():
    db = _FakeDB()
    lesson = await _seed_published_lesson(db, price=50)
    out = await vlt.serialize_lesson_for_student(db, lesson, "stu1")
    assert out["owned"] is False
    assert "syncId" not in out
    assert "mediaRef" not in out  # the playable video itself is also protected


@pytest.mark.asyncio
async def test_paid_lesson_shows_sync_id_when_owned():
    db = _FakeDB()
    lesson = await _seed_published_lesson(db, price=50, lesson_id="vid_2")
    await db[vlt.PURCHASES_COLL].insert_one({
        "_id": "stu1::vid_2", "purchaseId": "p1", "studentId": "stu1", "lessonId": "vid_2", "state": "succeeded",
    })
    out = await vlt.serialize_lesson_for_student(db, lesson, "stu1")
    assert out["owned"] is True
    assert out["syncId"] == "sync_abc"
    assert out["mediaRef"] == "https://pub-x.r2.dev/vid.mp4"


# ── purchase state machine ───────────────────────────────────────────────
@pytest.mark.asyncio
async def test_initiate_purchase_succeeds_and_grants_ownership(monkeypatch):
    db = _FakeDB()
    await _seed_published_lesson(db, price=50)

    async def fake_debit(student_id, password, amount):
        return {"outcome": points.OUTCOME_OK, "reason": "", "nonce": "n1"}

    async def fake_balance(student_id, password):
        return 450, ""

    monkeypatch.setattr(vlt.points, "debit_purchase", fake_debit)
    monkeypatch.setattr(vlt.points, "get_authoritative_balance", fake_balance)

    purchase = await vlt.initiate_purchase(db, student_id="stu1", lesson_id="vid_1", password="pw")
    assert purchase["state"] == "succeeded"
    assert purchase["pointsAfter"] == 450
    assert await vlt.student_owns_lesson(db, "stu1", "vid_1") is True


@pytest.mark.asyncio
async def test_initiate_purchase_rejected_allows_retry(monkeypatch):
    db = _FakeDB()
    await _seed_published_lesson(db, price=50)

    async def fake_debit_fail(student_id, password, amount):
        return {"outcome": points.OUTCOME_REJECTED, "reason": "insufficient_funds", "nonce": "n1"}

    monkeypatch.setattr(vlt.points, "debit_purchase", fake_debit_fail)
    first = await vlt.initiate_purchase(db, student_id="stu1", lesson_id="vid_1", password="pw")
    assert first["state"] == "failed"

    async def fake_debit_ok(student_id, password, amount):
        return {"outcome": points.OUTCOME_OK, "reason": "", "nonce": "n2"}

    async def fake_balance(student_id, password):
        return 100, ""

    monkeypatch.setattr(vlt.points, "debit_purchase", fake_debit_ok)
    monkeypatch.setattr(vlt.points, "get_authoritative_balance", fake_balance)
    second = await vlt.initiate_purchase(db, student_id="stu1", lesson_id="vid_1", password="pw")
    assert second["state"] == "succeeded"


@pytest.mark.asyncio
async def test_initiate_purchase_ambiguous_blocks_further_attempts(monkeypatch):
    db = _FakeDB()
    await _seed_published_lesson(db, price=50)

    async def fake_debit_ambiguous(student_id, password, amount):
        return {"outcome": points.OUTCOME_AMBIGUOUS, "reason": "network_TimeoutException", "nonce": "n1"}

    monkeypatch.setattr(vlt.points, "debit_purchase", fake_debit_ambiguous)
    purchase = await vlt.initiate_purchase(db, student_id="stu1", lesson_id="vid_1", password="pw")
    assert purchase["state"] == "reconcile"

    with pytest.raises(vlt.VideoLibraryError) as exc:
        await vlt.initiate_purchase(db, student_id="stu1", lesson_id="vid_1", password="pw")
    assert exc.value.code == "needs_reconciliation"


@pytest.mark.asyncio
async def test_initiate_purchase_already_owned_rejects_new_attempt(monkeypatch):
    db = _FakeDB()
    await _seed_published_lesson(db, price=50)

    async def fake_debit_ok(student_id, password, amount):
        return {"outcome": points.OUTCOME_OK, "reason": "", "nonce": "n1"}

    async def fake_balance(student_id, password):
        return 100, ""

    monkeypatch.setattr(vlt.points, "debit_purchase", fake_debit_ok)
    monkeypatch.setattr(vlt.points, "get_authoritative_balance", fake_balance)
    await vlt.initiate_purchase(db, student_id="stu1", lesson_id="vid_1", password="pw")

    with pytest.raises(vlt.VideoLibraryError) as exc:
        await vlt.initiate_purchase(db, student_id="stu1", lesson_id="vid_1", password="pw")
    assert exc.value.code == "already_owned"


@pytest.mark.asyncio
async def test_initiate_purchase_free_lesson_rejected():
    db = _FakeDB()
    await _seed_published_lesson(db, price=0)
    with pytest.raises(vlt.VideoLibraryError) as exc:
        await vlt.initiate_purchase(db, student_id="stu1", lesson_id="vid_1", password="pw")
    assert exc.value.code == "free_lesson"


@pytest.mark.asyncio
async def test_initiate_purchase_unpublished_lesson_not_found():
    db = _FakeDB()
    lesson = schema.build_video_lesson(title="Draft", price=10, lesson_id="vid_9", status="draft", created_at="t0")
    await db[vlt.LESSONS_COLL].insert_one(lesson)
    with pytest.raises(vlt.VideoLibraryError) as exc:
        await vlt.initiate_purchase(db, student_id="stu1", lesson_id="vid_9", password="pw")
    assert exc.value.http_status == 404


@pytest.mark.asyncio
async def test_concurrent_purchase_attempts_never_both_debit(monkeypatch):
    """The one property that matters most: the atomic claim ensures exactly
    one of two concurrent attempts ever reaches debit_purchase, regardless
    of interleaving — never a lucky race, structurally guaranteed by the
    find_one_and_update filter on RETRYABLE_STATES."""
    db = _FakeDB()
    await _seed_published_lesson(db, price=50)

    call_count = {"n": 0}

    async def fake_debit(student_id, password, amount):
        call_count["n"] += 1
        await asyncio.sleep(0.01)  # simulate network latency, widen the race window
        return {"outcome": points.OUTCOME_OK, "reason": "", "nonce": "n1"}

    async def fake_balance(student_id, password):
        return 100, ""

    monkeypatch.setattr(vlt.points, "debit_purchase", fake_debit)
    monkeypatch.setattr(vlt.points, "get_authoritative_balance", fake_balance)

    results = await asyncio.gather(
        vlt.initiate_purchase(db, student_id="stu1", lesson_id="vid_1", password="pw"),
        vlt.initiate_purchase(db, student_id="stu1", lesson_id="vid_1", password="pw"),
        return_exceptions=True,
    )

    assert call_count["n"] == 1  # exactly one attempt ever reached the debit call
    outcomes = [r["state"] if isinstance(r, dict) else type(r).__name__ for r in results]
    assert outcomes.count("succeeded") == 1
    assert any(isinstance(r, vlt.VideoLibraryError) for r in results)


# ── admin reconcile ──────────────────────────────────────────────────────
@pytest.mark.asyncio
async def test_admin_reconcile_succeeded_grants_ownership(monkeypatch):
    db = _FakeDB()
    await _seed_published_lesson(db, price=50)

    async def fake_debit_ambiguous(student_id, password, amount):
        return {"outcome": points.OUTCOME_AMBIGUOUS, "reason": "network_error", "nonce": "n1"}

    monkeypatch.setattr(vlt.points, "debit_purchase", fake_debit_ambiguous)
    await vlt.initiate_purchase(db, student_id="stu1", lesson_id="vid_1", password="pw")

    resolved = await vlt.admin_reconcile_purchase(db, "stu1", "vid_1", resolution="succeeded", actor="admin@x.com")
    assert resolved["state"] == "succeeded"
    assert await vlt.student_owns_lesson(db, "stu1", "vid_1") is True


@pytest.mark.asyncio
async def test_admin_reconcile_rejects_when_not_in_reconcile_state():
    db = _FakeDB()
    await _seed_published_lesson(db, price=50)
    await db[vlt.PURCHASES_COLL].insert_one(
        schema.build_purchase_record(student_id="stu1", lesson_id="vid_1", price=50, created_at="t0")
        | {"_id": "stu1::vid_1"}
    )
    with pytest.raises(vlt.VideoLibraryError) as exc:
        await vlt.admin_reconcile_purchase(db, "stu1", "vid_1", resolution="succeeded", actor="admin@x.com")
    assert exc.value.code == "not_reconcilable"


@pytest.mark.asyncio
async def test_admin_reconcile_rejects_invalid_resolution():
    db = _FakeDB()
    with pytest.raises(vlt.VideoLibraryError) as exc:
        await vlt.admin_reconcile_purchase(db, "stu1", "vid_1", resolution="maybe", actor="admin@x.com")
    assert exc.value.code == "invalid_resolution"


# ═════════════════════════════════════════════════════════════════════════
# video_schema.py — discovery metadata (product direction: standalone
# premium dashboard needs real category/level data)
# ═════════════════════════════════════════════════════════════════════════
def test_build_video_lesson_accepts_discovery_metadata():
    doc = schema.build_video_lesson(
        title="Ordering Coffee", price=50, instructor="Ms. Sopheak",
        category="conversation", difficulty="beginner", cefr_level="A2",
        estimated_study_minutes=15,
    )
    assert doc["instructor"] == "Ms. Sopheak"
    assert doc["category"] == "conversation"
    assert doc["difficulty"] == "beginner"
    assert doc["cefrLevel"] == "A2"
    assert doc["estimatedStudyMinutes"] == 15


def test_build_video_lesson_rejects_invalid_category():
    with pytest.raises(ValueError):
        schema.build_video_lesson(title="x", price=0, category="not_a_real_category")


def test_build_video_lesson_rejects_invalid_difficulty():
    with pytest.raises(ValueError):
        schema.build_video_lesson(title="x", price=0, difficulty="expert")


def test_build_video_lesson_rejects_invalid_cefr_level():
    with pytest.raises(ValueError):
        schema.build_video_lesson(title="x", price=0, cefr_level="Z9")


def test_validate_video_lesson_catches_invalid_discovery_metadata():
    doc = schema.build_video_lesson(title="x", price=0)
    doc["category"] = "not_real"
    ok, errors = schema.validate_video_lesson(doc)
    assert not ok
    assert any("category" in e for e in errors)


# ═════════════════════════════════════════════════════════════════════════
# video_schema.py — progress record
# ═════════════════════════════════════════════════════════════════════════
def test_build_progress_record_computes_completion_from_fraction():
    incomplete = schema.build_progress_record(student_id="s", lesson_id="l", position_sec=30, duration_sec=100)
    assert incomplete["completed"] is False
    complete = schema.build_progress_record(student_id="s", lesson_id="l", position_sec=95, duration_sec=100)
    assert complete["completed"] is True


def test_build_progress_record_zero_duration_never_marks_complete():
    doc = schema.build_progress_record(student_id="s", lesson_id="l", position_sec=0, duration_sec=0)
    assert doc["completed"] is False


# ═════════════════════════════════════════════════════════════════════════
# video_library_tools.py — discovery filters + progress ("Continue Learning")
# ═════════════════════════════════════════════════════════════════════════
@pytest.mark.asyncio
async def test_list_video_lessons_filters_by_category_and_difficulty():
    db = _FakeDB()
    await vlt.create_video_lesson(db, title="Coffee Chat", price=0, created_by="a", category="conversation", difficulty="beginner")
    await vlt.create_video_lesson(db, title="Boardroom English", price=0, created_by="a", category="business", difficulty="advanced")

    conv = await vlt.list_video_lessons(db, category="conversation")
    assert [l["title"] for l in conv] == ["Coffee Chat"]

    beginner = await vlt.list_video_lessons(db, difficulty="beginner")
    assert [l["title"] for l in beginner] == ["Coffee Chat"]


@pytest.mark.asyncio
async def test_create_lesson_route_payload_passthrough_via_service():
    db = _FakeDB()
    doc = await vlt.create_video_lesson(
        db, title="Storytime", price=0, created_by="a",
        instructor="Mr. Dara", category="storytelling", difficulty="intermediate",
        cefr_level="B1", estimated_study_minutes=20,
    )
    fetched = await vlt.get_video_lesson(db, doc["lessonId"])
    assert fetched["instructor"] == "Mr. Dara"
    assert fetched["cefrLevel"] == "B1"
    assert fetched["estimatedStudyMinutes"] == 20


@pytest.mark.asyncio
async def test_update_video_lesson_allows_discovery_metadata_fields():
    db = _FakeDB()
    doc = await vlt.create_video_lesson(db, title="X", price=0, created_by="a")
    updated = await vlt.update_video_lesson(db, doc["lessonId"], {
        "category": "pronunciation", "difficulty": "advanced", "cefrLevel": "C1", "instructor": "Ms. Rith",
    })
    assert updated["category"] == "pronunciation"
    assert updated["cefrLevel"] == "C1"
    assert updated["instructor"] == "Ms. Rith"


@pytest.mark.asyncio
async def test_record_progress_upserts_and_marks_completion():
    db = _FakeDB()
    doc = await vlt.record_progress(db, student_id="stu1", lesson_id="vid_1", position_sec=10, duration_sec=100)
    assert doc["completed"] is False
    assert await vlt.get_progress(db, "stu1", "vid_1") == doc

    updated = await vlt.record_progress(db, student_id="stu1", lesson_id="vid_1", position_sec=95, duration_sec=100)
    assert updated["completed"] is True
    # upsert, not append — still exactly one record for this (student, lesson)
    assert await vlt.get_progress(db, "stu1", "vid_1") == updated


@pytest.mark.asyncio
async def test_list_continue_watching_excludes_completed_and_other_students():
    db = _FakeDB()
    await vlt.record_progress(db, student_id="stu1", lesson_id="vid_1", position_sec=10, duration_sec=100)  # in progress
    await vlt.record_progress(db, student_id="stu1", lesson_id="vid_2", position_sec=99, duration_sec=100)  # completed
    await vlt.record_progress(db, student_id="stu2", lesson_id="vid_1", position_sec=10, duration_sec=100)  # different student

    result = await vlt.list_continue_watching(db, "stu1")
    assert [r["lessonId"] for r in result] == ["vid_1"]


@pytest.mark.asyncio
async def test_list_continue_watching_empty_for_student_with_no_progress():
    db = _FakeDB()
    result = await vlt.list_continue_watching(db, "stu1")
    assert result == []


# ═════════════════════════════════════════════════════════════════════════
# Featured flag (dashboard curation)
# ═════════════════════════════════════════════════════════════════════════
def test_build_video_lesson_featured_defaults_false_and_accepts_true():
    assert schema.build_video_lesson(title="x", price=0)["featured"] is False
    assert schema.build_video_lesson(title="x", price=0, featured=True)["featured"] is True


@pytest.mark.asyncio
async def test_update_video_lesson_allows_featured_flag():
    db = _FakeDB()
    lesson = await vlt.create_video_lesson(db, title="T", price=0, created_by="a@x")
    updated = await vlt.update_video_lesson(db, lesson["lessonId"], {"featured": True})
    assert updated["featured"] is True


# ═════════════════════════════════════════════════════════════════════════
# Lesson delete (Video Factory)
# ═════════════════════════════════════════════════════════════════════════
@pytest.mark.asyncio
async def test_delete_video_lesson_removes_draft():
    db = _FakeDB()
    lesson = await vlt.create_video_lesson(db, title="T", price=0, created_by="a@x")
    await vlt.delete_video_lesson(db, lesson["lessonId"])
    assert await vlt.get_video_lesson(db, lesson["lessonId"]) is None


@pytest.mark.asyncio
async def test_delete_video_lesson_refuses_published():
    db = _FakeDB()
    await _seed_published_lesson(db, lesson_id="vid_pub")
    with pytest.raises(vlt.VideoLibraryError) as exc:
        await vlt.delete_video_lesson(db, "vid_pub")
    assert exc.value.code == "lesson_published"
    assert await vlt.get_video_lesson(db, "vid_pub") is not None


@pytest.mark.asyncio
async def test_delete_video_lesson_not_found():
    db = _FakeDB()
    with pytest.raises(vlt.VideoLibraryError) as exc:
        await vlt.delete_video_lesson(db, "vid_missing")
    assert exc.value.code == "lesson_not_found"


# ═════════════════════════════════════════════════════════════════════════
# Bookmarks (saved lessons)
# ═════════════════════════════════════════════════════════════════════════
@pytest.mark.asyncio
async def test_toggle_bookmark_on_then_off():
    db = _FakeDB()
    await _seed_published_lesson(db, lesson_id="vid_b")
    on = await vlt.toggle_bookmark(db, student_id="stu1", lesson_id="vid_b")
    assert on == {"bookmarked": True, "lessonId": "vid_b"}
    marks = await vlt.list_bookmarks(db, "stu1")
    assert [m["lessonId"] for m in marks] == ["vid_b"]
    off = await vlt.toggle_bookmark(db, student_id="stu1", lesson_id="vid_b")
    assert off == {"bookmarked": False, "lessonId": "vid_b"}
    assert await vlt.list_bookmarks(db, "stu1") == []


@pytest.mark.asyncio
async def test_toggle_bookmark_rejects_unpublished_lesson():
    db = _FakeDB()
    lesson = await vlt.create_video_lesson(db, title="draft", price=0, created_by="a@x")
    with pytest.raises(vlt.VideoLibraryError) as exc:
        await vlt.toggle_bookmark(db, student_id="stu1", lesson_id=lesson["lessonId"])
    assert exc.value.code == "lesson_not_found"


@pytest.mark.asyncio
async def test_list_bookmarks_scoped_per_student():
    db = _FakeDB()
    await _seed_published_lesson(db, lesson_id="vid_b1")
    await _seed_published_lesson(db, lesson_id="vid_b2")
    await vlt.toggle_bookmark(db, student_id="stu1", lesson_id="vid_b1")
    await vlt.toggle_bookmark(db, student_id="stu2", lesson_id="vid_b2")
    assert [m["lessonId"] for m in await vlt.list_bookmarks(db, "stu1")] == ["vid_b1"]
    assert [m["lessonId"] for m in await vlt.list_bookmarks(db, "stu2")] == ["vid_b2"]
