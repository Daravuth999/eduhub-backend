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

    def find(self, query=None, projection=None):
        return _Cursor([d for d in self.docs.values() if _matches(d, query or {})])


class _FakeDB:
    def __init__(self):
        self.video_lessons = _Coll()
        self.video_purchases = _Coll()
        self.chapter_sync = _Coll()  # sync_studio_tools.py's collection — cross-module reuse test

    def __getitem__(self, name):
        if name == vlt.LESSONS_COLL:
            return self.video_lessons
        if name == vlt.PURCHASES_COLL:
            return self.video_purchases
        if name == "chapter_sync":
            return self.chapter_sync
        raise AssertionError(f"unexpected collection: {name}")


async def _seed_published_lesson(db, *, price=50, lesson_id="vid_1", sync_id="sync_abc"):
    lesson = schema.build_video_lesson(
        title="Ordering Coffee", price=price, lesson_id=lesson_id, sync_id=sync_id,
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
