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

import video_render_tools as vrt
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

    def limit(self, n):
        self._docs = self._docs[:n]
        return self

    async def to_list(self, length=None):
        return [dict(d) for d in self._docs[:length]]

    def __aiter__(self):
        self._iter = iter(self._docs)
        return self

    async def __anext__(self):
        try:
            return dict(next(self._iter))
        except StopIteration:
            raise StopAsyncIteration


def _matches(doc, query):
    for k, v in (query or {}).items():
        if isinstance(v, dict) and "$in" in v:
            if doc.get(k) not in v["$in"]:
                return False
        elif isinstance(v, dict) and "$regex" in v:
            if v["$regex"] not in (doc.get(k) or ""):
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
    def __init__(self, data, metadata, file_id):
        self._data, self._pos, self.metadata, self.length = data, 0, metadata, len(data)
        self._id = file_id

    async def seek(self, pos):
        self._pos = pos

    async def read(self, n=-1):
        chunk = self._data[self._pos:] if n is None or n < 0 else self._data[self._pos:self._pos + n]
        self._pos += len(chunk)
        return chunk


class _FakeMediaBucket:
    def __init__(self):
        self.files: dict = {}
        self.upload_count = 0

    async def upload_from_stream(self, filename, stream, metadata=None):
        self.upload_count += 1
        self.files[filename] = (stream.read(), metadata or {}, filename)

    async def open_download_stream_by_name(self, filename):
        data, metadata, file_id = self.files[filename]
        return _FakeGridOut(data, metadata, file_id)

    async def delete(self, file_id):
        for name, (_data, _meta, fid) in list(self.files.items()):
            if fid == file_id:
                del self.files[name]
                return
        raise KeyError(file_id)  # mirrors real GridFS: deleting an unknown id is an error


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


# ── storage lifecycle: content-hash dedup + reference-aware delete
#    (2026-09, Video Factory surgical bug-fix pass §2e/4e) ──────────────────
@pytest.mark.asyncio
async def test_reuploading_byte_identical_content_reuses_the_same_media_ref_no_new_storage_write():
    db = _FakeDB()
    lesson = await vlt.create_video_lesson(db, title="Ordering Coffee", price=50, created_by="a")
    bucket = _FakeMediaBucket()

    first = await vlt.attach_lesson_media(
        db, lesson["lessonId"], raw=b"identical-bytes", declared_content_type="audio/mpeg", media_bucket=bucket,
    )
    assert bucket.upload_count == 1

    second = await vlt.attach_lesson_media(
        db, lesson["lessonId"], raw=b"identical-bytes", declared_content_type="audio/mpeg", media_bucket=bucket,
    )
    assert second["mediaRef"] == first["mediaRef"]
    assert bucket.upload_count == 1  # NOT 2 — the second call never re-uploaded


@pytest.mark.asyncio
async def test_content_different_upload_still_uploads_normally():
    db = _FakeDB()
    lesson = await vlt.create_video_lesson(db, title="X", price=10, created_by="a")
    bucket = _FakeMediaBucket()

    first = await vlt.attach_lesson_media(
        db, lesson["lessonId"], raw=b"bytes-one", declared_content_type="audio/mpeg", media_bucket=bucket,
    )
    second = await vlt.attach_lesson_media(
        db, lesson["lessonId"], raw=b"bytes-two", declared_content_type="audio/mpeg", media_bucket=bucket,
    )
    assert second["mediaRef"] != first["mediaRef"]
    assert bucket.upload_count == 2


@pytest.mark.asyncio
async def test_replacing_a_lessons_media_retires_the_previous_object_when_unreferenced(monkeypatch):
    db = _FakeDB()
    lesson = await vlt.create_video_lesson(db, title="X", price=10, created_by="a")
    bucket = _FakeMediaBucket()
    monkeypatch.setattr(vlt.sync_studio_tools, "get_media_bucket", lambda _db: bucket)

    first = await vlt.attach_lesson_media(
        db, lesson["lessonId"], raw=b"old-content", declared_content_type="audio/mpeg", media_bucket=bucket,
    )
    old_sync_id = first["syncId"]
    assert db.chapter_sync.docs.get(old_sync_id) is not None
    assert len(bucket.files) == 1

    updated = await vlt.attach_lesson_media(
        db, lesson["lessonId"], raw=b"new-content", declared_content_type="audio/mpeg", media_bucket=bucket,
    )

    assert updated["mediaRef"] != first["mediaRef"]
    # The old chapter_sync document is gone (superseded, "latest wins")...
    assert db.chapter_sync.docs.get(old_sync_id) is None
    # ...and since nothing else referenced the old content, its storage
    # object was genuinely deleted, not left orphaned.
    assert len(bucket.files) == 1  # only the NEW file remains
    assert updated["mediaRef"].rsplit("/", 1)[-1] in bucket.files


@pytest.mark.asyncio
async def test_replacing_a_lessons_media_keeps_the_object_when_another_lesson_still_shares_it(monkeypatch):
    """Content-hash dedup means two lessons CAN legitimately share one
    storage object — replacing one lesson's media must never delete an
    object a different, still-live lesson depends on."""
    db = _FakeDB()
    lesson_a = await vlt.create_video_lesson(db, title="A", price=10, created_by="a")
    lesson_b = await vlt.create_video_lesson(db, title="B", price=10, created_by="a")
    bucket = _FakeMediaBucket()
    monkeypatch.setattr(vlt.sync_studio_tools, "get_media_bucket", lambda _db: bucket)

    shared = await vlt.attach_lesson_media(
        db, lesson_a["lessonId"], raw=b"shared-content", declared_content_type="audio/mpeg", media_bucket=bucket,
    )
    await vlt.attach_lesson_media(
        db, lesson_b["lessonId"], raw=b"shared-content", declared_content_type="audio/mpeg", media_bucket=bucket,
    )
    assert len(bucket.files) == 1  # deduped — one object, two lessons

    # Lesson A moves on to different media — the SHARED object must survive
    # because lesson B still points at it.
    await vlt.attach_lesson_media(
        db, lesson_a["lessonId"], raw=b"lesson-a-new-content", declared_content_type="audio/mpeg", media_bucket=bucket,
    )

    filename = shared["mediaRef"].rsplit("/", 1)[-1]
    assert filename in bucket.files, "shared object was wrongly deleted while lesson B still references it"
    lesson_b_after = await vlt.get_video_lesson(db, lesson_b["lessonId"])
    assert lesson_b_after["mediaRef"] == shared["mediaRef"]


@pytest.mark.asyncio
async def test_detaching_media_deletes_the_storage_object_and_the_chapter_sync_document(monkeypatch):
    db = _FakeDB()
    lesson = await vlt.create_video_lesson(db, title="X", price=10, created_by="a")
    bucket = _FakeMediaBucket()
    monkeypatch.setattr(vlt.sync_studio_tools, "get_media_bucket", lambda _db: bucket)

    attached = await vlt.attach_lesson_media(
        db, lesson["lessonId"], raw=b"detach-me", declared_content_type="audio/mpeg", media_bucket=bucket,
    )
    sync_id = attached["syncId"]
    assert len(bucket.files) == 1

    result = await vlt.detach_lesson_media(db, lesson["lessonId"])

    assert result["mediaRef"] is None
    assert result["syncId"] is None
    assert db.chapter_sync.docs.get(sync_id) is None
    assert len(bucket.files) == 0


@pytest.mark.asyncio
async def test_deleting_a_lesson_deletes_the_storage_object_and_the_chapter_sync_document(monkeypatch):
    db = _FakeDB()
    lesson = await vlt.create_video_lesson(db, title="X", price=10, created_by="a")
    bucket = _FakeMediaBucket()
    monkeypatch.setattr(vlt.sync_studio_tools, "get_media_bucket", lambda _db: bucket)

    attached = await vlt.attach_lesson_media(
        db, lesson["lessonId"], raw=b"delete-me", declared_content_type="audio/mpeg", media_bucket=bucket,
    )
    sync_id = attached["syncId"]

    await vlt.delete_video_lesson(db, lesson["lessonId"])

    assert await vlt.get_video_lesson(db, lesson["lessonId"]) is None
    assert db.chapter_sync.docs.get(sync_id) is None
    assert len(bucket.files) == 0


@pytest.mark.asyncio
async def test_a_storage_delete_failure_never_blocks_or_fails_detach_best_effort_only(monkeypatch):
    """assessment_tools.py's own best-effort/log-critical/never-block
    contract, applied here: a simulated GridFS delete failure must never
    propagate out of detach_lesson_media — the Mongo-side detach (the
    user-facing action) has already succeeded and must stay succeeded."""
    db = _FakeDB()
    lesson = await vlt.create_video_lesson(db, title="X", price=10, created_by="a")

    class _BrokenBucket(_FakeMediaBucket):
        async def delete(self, file_id):
            raise RuntimeError("simulated storage outage")

    bucket = _BrokenBucket()
    monkeypatch.setattr(vlt.sync_studio_tools, "get_media_bucket", lambda _db: bucket)

    await vlt.attach_lesson_media(
        db, lesson["lessonId"], raw=b"will-fail-to-delete", declared_content_type="audio/mpeg", media_bucket=bucket,
    )

    result = await vlt.detach_lesson_media(db, lesson["lessonId"])
    assert result["mediaRef"] is None  # detach itself still fully succeeded


# ── faststart backfill tool (2026-09, §2c/4b) — manual-trigger-only,
#    never run against real data in this pass; these tests are the only
#    verification it gets. ────────────────────────────────────────────────
def _mp4_box(box_type: bytes, payload: bytes = b"") -> bytes:
    size = 8 + len(payload)
    return size.to_bytes(4, "big") + box_type + payload


async def _seed_pre_existing_video_lesson(db, bucket, *, lesson_id, raw: bytes, filename: str):
    """Simulates a lesson uploaded BEFORE remux_faststart existed —
    directly seeds the lesson document, its chapter_sync counterpart (the
    real relationship attach_lesson_media always creates one of), and the
    storage object — bypassing attach_lesson_media entirely, since it now
    applies the fix to every NEW upload and can never be used to
    construct an un-fixed fixture."""
    media_ref = f"gridfs://sync_media/{filename}"
    sync_id = f"sync_{lesson_id}"
    lesson = schema.build_video_lesson(
        title="Pre-existing", price=10, lesson_id=lesson_id,
        sync_id=sync_id, media_ref=media_ref,
        status="draft", created_at="t0",
    )
    lesson["contentType"] = "video/mp4"
    await db[vlt.LESSONS_COLL].insert_one(lesson)
    await db.chapter_sync.insert_one({
        "syncId": sync_id, "mediaRef": media_ref, "ownerRef": f"video_lesson:{lesson_id}",
    })
    bucket.files[filename] = (raw, {"contentType": "video/mp4"}, filename)
    return lesson


@pytest.mark.asyncio
async def test_backfill_dry_run_reports_needs_fix_and_writes_nothing():
    db = _FakeDB()
    bucket = _FakeMediaBucket()
    mdat_first = _mp4_box(b"ftyp", b"isom") + _mp4_box(b"mdat", b"y" * 100) + _mp4_box(b"moov", b"x" * 20)
    lesson = await _seed_pre_existing_video_lesson(db, bucket, lesson_id="vid_needs_fix", raw=mdat_first, filename="needs-fix.mp4")
    starting_upload_count = bucket.upload_count

    row = await vlt.backfill_faststart_scan_lesson(db, lesson, bucket, dry_run=True)

    assert row["status"] == "needs_fix"
    assert bucket.upload_count == starting_upload_count  # dry run made ZERO storage writes
    unchanged = await vlt.get_video_lesson(db, lesson["lessonId"])
    assert unchanged["mediaRef"] == lesson["mediaRef"]  # nothing was repointed either


@pytest.mark.asyncio
async def test_backfill_reports_already_fixed_for_moov_first_content():
    db = _FakeDB()
    bucket = _FakeMediaBucket()
    moov_first = _mp4_box(b"ftyp", b"isom") + _mp4_box(b"moov", b"x" * 20) + _mp4_box(b"mdat", b"y" * 100)
    lesson = await _seed_pre_existing_video_lesson(db, bucket, lesson_id="vid_already_fixed", raw=moov_first, filename="already-fixed.mp4")

    row = await vlt.backfill_faststart_scan_lesson(db, lesson, bucket, dry_run=True)
    assert row["status"] == "already_fixed"

    # A real run for an already-fixed lesson must also be a complete no-op.
    starting_upload_count = bucket.upload_count
    row2 = await vlt.backfill_faststart_scan_lesson(db, await vlt.get_video_lesson(db, lesson["lessonId"]), bucket, dry_run=False)
    assert row2["status"] == "already_fixed"
    assert bucket.upload_count == starting_upload_count


@pytest.mark.asyncio
async def test_backfill_skips_non_video_lessons_honestly():
    db = _FakeDB()
    lesson = await vlt.create_video_lesson(db, title="X", price=10, created_by="a")
    bucket = _FakeMediaBucket()
    await vlt.attach_lesson_media(
        db, lesson["lessonId"], raw=b"audio-bytes-not-a-container", declared_content_type="audio/mpeg", media_bucket=bucket,
    )
    row = await vlt.backfill_faststart_scan_lesson(db, await vlt.get_video_lesson(db, lesson["lessonId"]), bucket, dry_run=True)
    assert row["status"] == "not_video"


@pytest.mark.asyncio
async def test_backfill_scan_all_is_batchable_and_summarizes_by_status():
    db = _FakeDB()
    bucket = _FakeMediaBucket()
    mdat_first = _mp4_box(b"ftyp", b"isom") + _mp4_box(b"mdat", b"y" * 100) + _mp4_box(b"moov", b"x" * 20)
    moov_first = _mp4_box(b"ftyp", b"isom") + _mp4_box(b"moov", b"x" * 20) + _mp4_box(b"mdat", b"y" * 100)
    await _seed_pre_existing_video_lesson(db, bucket, lesson_id="vid_needs", raw=mdat_first, filename="needs.mp4")
    await _seed_pre_existing_video_lesson(db, bucket, lesson_id="vid_fixed", raw=moov_first, filename="fixed.mp4")

    result = await vlt.backfill_faststart_scan_all(db, bucket, dry_run=True, limit=200)
    assert result["dryRun"] is True
    assert result["summary"]["scanned"] == 2
    assert result["summary"].get("needs_fix") == 1
    assert result["summary"].get("already_fixed") == 1


NO_FFMPEG_FOR_LIB_TEST = not vrt.ffmpeg_available()
NO_FFPROBE_FOR_LIB_TEST = not vrt.ffprobe_available()


async def _make_mdat_first_video_for_backfill(*, duration: float = 1.0) -> bytes:
    import os as _os
    import tempfile as _tempfile
    import uuid as _uuid
    path = _os.path.join(_tempfile.gettempdir(), f"vlt_backfill_{_uuid.uuid4().hex}.mp4")
    args = (
        vrt._resolve_ffmpeg(), "-y",
        "-f", "lavfi", "-i", f"color=c=red:s=160x120:d={duration}",
        "-c:v", "libx264", "-pix_fmt", "yuv420p", path,
    )
    loop = asyncio.get_running_loop()
    await loop.run_in_executor(vrt._executor, vrt._run_blocking, args, 30.0, False)
    with open(path, "rb") as f:
        data = f.read()
    _os.remove(path)
    return data


@pytest.mark.skipif(NO_FFMPEG_FOR_LIB_TEST or NO_FFPROBE_FOR_LIB_TEST, reason="ffmpeg/ffprobe not installed")
@pytest.mark.asyncio
async def test_backfill_real_run_fixes_verifies_and_retires_the_old_object(monkeypatch):
    db = _FakeDB()
    bucket = _FakeMediaBucket()
    monkeypatch.setattr(vlt.sync_studio_tools, "get_media_bucket", lambda _db: bucket)

    real_mdat_first = await _make_mdat_first_video_for_backfill()
    old_filename = "pre-existing-real.mp4"
    lesson = await _seed_pre_existing_video_lesson(
        db, bucket, lesson_id="vid_real_backfill", raw=real_mdat_first, filename=old_filename,
    )
    old_ref = lesson["mediaRef"]
    assert old_filename in bucket.files
    assert vrt.mp4_moov_before_mdat(real_mdat_first) is False, "fixture itself must genuinely need fixing"

    row = await vlt.backfill_faststart_scan_lesson(db, lesson, bucket, dry_run=False)

    assert row["status"] == "fixed"
    updated = await vlt.get_video_lesson(db, lesson["lessonId"])
    assert updated["mediaRef"] == row["mediaRef"]
    assert updated["mediaRef"] != old_ref
    # The chapter_sync document's own mediaRef was kept in sync.
    assert db.chapter_sync.docs[updated["syncId"]]["mediaRef"] == updated["mediaRef"]
    # The old object is gone (nothing else referenced it); only the new one remains.
    assert old_filename not in bucket.files
    assert updated["mediaRef"].rsplit("/", 1)[-1] in bucket.files
    assert len(bucket.files) == 1
    # The fixed file genuinely has moov before mdat now.
    new_filename = updated["mediaRef"].rsplit("/", 1)[-1]
    new_bytes = bucket.files[new_filename][0]
    assert vrt.mp4_moov_before_mdat(new_bytes) is True


@pytest.mark.asyncio
async def test_get_media_bucket_construction_failure_never_blocks_delete(monkeypatch):
    """Even a failure constructing the media bucket itself (e.g. against a
    test/fake db context) must never break the actual, already-committed
    lesson delete — only the best-effort storage cleanup is skipped."""
    db = _FakeDB()
    lesson = await vlt.create_video_lesson(db, title="X", price=10, created_by="a")

    def _boom(_db):
        raise TypeError("simulated bucket construction failure")

    monkeypatch.setattr(vlt.sync_studio_tools, "get_media_bucket", _boom)

    await vlt.delete_video_lesson(db, lesson["lessonId"])
    assert await vlt.get_video_lesson(db, lesson["lessonId"]) is None


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


# ── AI Narration track exposure (additive audio track, admin-gated) ──────
@pytest.mark.asyncio
async def test_narration_hidden_for_unowned_paid_lesson_even_if_published(monkeypatch):
    db = _FakeDB()
    lesson = await _seed_published_lesson(db, price=50, lesson_id="vid_n1")
    lesson["aiNarrationPublished"] = True
    lesson["aiNarrationSyncId"] = "sync_narr_1"
    lesson["aiNarrationMediaRef"] = "https://pub-x.r2.dev/narr.mp3"
    out = await vlt.serialize_lesson_for_student(db, lesson, "stu1")
    assert out["owned"] is False
    assert out["aiNarrationAvailable"] is False
    assert "aiNarrationSyncId" not in out
    assert "aiNarrationMediaRef" not in out
    assert "aiNarrationPublished" not in out  # internal flag never leaks raw


@pytest.mark.asyncio
async def test_narration_hidden_when_owned_but_not_yet_published():
    db = _FakeDB()
    lesson = await _seed_published_lesson(db, price=0, lesson_id="vid_n2")
    # Assembled but the admin has not clicked publish yet.
    lesson["aiNarrationSyncId"] = "sync_narr_2"
    lesson["aiNarrationMediaRef"] = "https://pub-x.r2.dev/narr2.mp3"
    out = await vlt.serialize_lesson_for_student(db, lesson, "stu1")
    assert out["owned"] is True
    assert out["aiNarrationAvailable"] is False
    assert "aiNarrationSyncId" not in out
    assert "aiNarrationMediaRef" not in out


@pytest.mark.asyncio
async def test_narration_visible_when_owned_and_published():
    db = _FakeDB()
    lesson = await _seed_published_lesson(db, price=0, lesson_id="vid_n3")
    lesson["aiNarrationPublished"] = True
    lesson["aiNarrationSyncId"] = "sync_narr_3"
    lesson["aiNarrationMediaRef"] = "https://pub-x.r2.dev/narr3.mp3"
    lesson["aiNarrationDurationSec"] = 42.0
    out = await vlt.serialize_lesson_for_student(db, lesson, "stu1")
    assert out["owned"] is True
    assert out["aiNarrationAvailable"] is True
    assert out["aiNarrationSyncId"] == "sync_narr_3"
    assert out["aiNarrationMediaRef"] == "https://pub-x.r2.dev/narr3.mp3"
    assert out["aiNarrationDurationSec"] == 42.0


@pytest.mark.asyncio
async def test_lesson_with_no_narration_at_all_shows_available_false():
    db = _FakeDB()
    lesson = await _seed_published_lesson(db, price=0, lesson_id="vid_n4")
    out = await vlt.serialize_lesson_for_student(db, lesson, "stu1")
    assert out["aiNarrationAvailable"] is False
    assert "aiNarrationSyncId" not in out


# ── Final-master exposure (physically embedded-audio MP4, optional upgrade
# over the audio-only additive track — most lessons won't have one) ───────
@pytest.mark.asyncio
async def test_master_available_when_published_narration_has_a_rendered_master():
    db = _FakeDB()
    lesson = await _seed_published_lesson(db, price=0, lesson_id="vid_n5")
    lesson["aiNarrationPublished"] = True
    lesson["aiNarrationSyncId"] = "sync_narr_5"
    lesson["aiNarrationMediaRef"] = "https://pub-x.r2.dev/narr5.mp3"
    lesson["aiNarrationMasterMediaRef"] = "https://pub-x.r2.dev/master5.mp4"
    out = await vlt.serialize_lesson_for_student(db, lesson, "stu1")
    assert out["aiNarrationAvailable"] is True
    assert out["aiNarrationMasterAvailable"] is True
    assert out["aiNarrationMasterMediaRef"] == "https://pub-x.r2.dev/master5.mp4"


@pytest.mark.asyncio
async def test_master_unavailable_when_only_the_additive_track_is_published():
    db = _FakeDB()
    lesson = await _seed_published_lesson(db, price=0, lesson_id="vid_n6")
    lesson["aiNarrationPublished"] = True
    lesson["aiNarrationSyncId"] = "sync_narr_6"
    lesson["aiNarrationMediaRef"] = "https://pub-x.r2.dev/narr6.mp3"
    out = await vlt.serialize_lesson_for_student(db, lesson, "stu1")
    assert out["aiNarrationAvailable"] is True
    assert out["aiNarrationMasterAvailable"] is False
    assert "aiNarrationMasterMediaRef" not in out


@pytest.mark.asyncio
async def test_master_hidden_for_unowned_paid_lesson_even_if_rendered():
    db = _FakeDB()
    lesson = await _seed_published_lesson(db, price=50, lesson_id="vid_n7")
    lesson["aiNarrationPublished"] = True
    lesson["aiNarrationMediaRef"] = "https://pub-x.r2.dev/narr7.mp3"
    lesson["aiNarrationMasterMediaRef"] = "https://pub-x.r2.dev/master7.mp4"
    out = await vlt.serialize_lesson_for_student(db, lesson, "stu1")
    assert out["owned"] is False
    assert "aiNarrationMasterMediaRef" not in out
    assert "aiNarrationMasterAvailable" not in out


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


@pytest.mark.asyncio
async def test_list_reconcile_purchases_returns_only_reconcile_state_enriched_with_lesson_title(monkeypatch):
    db = _FakeDB()
    await _seed_published_lesson(db, price=50, lesson_id="vid_1")
    await _seed_published_lesson(db, price=50, lesson_id="vid_2")

    async def fake_debit_ambiguous(student_id, password, amount):
        return {"outcome": points.OUTCOME_AMBIGUOUS, "reason": "network_error", "nonce": "n1"}

    monkeypatch.setattr(vlt.points, "debit_purchase", fake_debit_ambiguous)
    await vlt.initiate_purchase(db, student_id="stu1", lesson_id="vid_1", password="pw")  # -> reconcile
    await vlt.initiate_purchase(db, student_id="stu2", lesson_id="vid_2", password="pw")  # -> reconcile
    await vlt.admin_reconcile_purchase(db, "stu2", "vid_2", resolution="failed", actor="admin@x.com")  # resolved, no longer reconcile

    queue = await vlt.list_reconcile_purchases(db)
    assert len(queue) == 1
    assert queue[0]["studentId"] == "stu1"
    assert queue[0]["lessonTitle"] == "Ordering Coffee"


@pytest.mark.asyncio
async def test_list_reconcile_purchases_empty_when_nothing_pending():
    db = _FakeDB()
    assert await vlt.list_reconcile_purchases(db) == []


@pytest.mark.asyncio
async def test_list_my_purchases_scoped_per_student_newest_first():
    db = _FakeDB()
    await _seed_published_lesson(db, price=50, lesson_id="vid_1")
    await _seed_published_lesson(db, price=30, lesson_id="vid_2")
    await db[vlt.PURCHASES_COLL].insert_one(
        schema.build_purchase_record(student_id="stu1", lesson_id="vid_1", price=50, created_at="t0")
        | {"_id": "stu1::vid_1", "state": "succeeded", "updatedAt": "2026-01-01T00:00:00Z"}
    )
    await db[vlt.PURCHASES_COLL].insert_one(
        schema.build_purchase_record(student_id="stu1", lesson_id="vid_2", price=30, created_at="t0")
        | {"_id": "stu1::vid_2", "state": "succeeded", "updatedAt": "2026-02-01T00:00:00Z"}
    )
    await db[vlt.PURCHASES_COLL].insert_one(
        schema.build_purchase_record(student_id="stu2", lesson_id="vid_1", price=50, created_at="t0")
        | {"_id": "stu2::vid_1", "state": "succeeded", "updatedAt": "2026-01-15T00:00:00Z"}
    )
    mine = await vlt.list_my_purchases(db, "stu1")
    assert [p["lessonId"] for p in mine] == ["vid_2", "vid_1"]  # newest updatedAt first


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
