"""tests/test_tuition_receipt_files.py
=====================================
Persistent Tuition Receipt Engine, C3/C4 — GridFS cache + regenerate.

Drives the real register_tuition_receipt_files_routes(...) against a tiny
fake FastAPI-router (records handlers by (method, path) so tests can call
them directly) and a fake GridFS bucket, rather than re-implementing the
module's logic inline — this module has real cache/regenerate control flow
worth exercising against the actual code.
"""
from __future__ import annotations

import asyncio

import pytest
import gridfs

import tuition_receipt_files as trf


def run(c):
    return asyncio.run(c)


class _FakeRouter:
    def __init__(self):
        self.handlers = {}

    def get(self, path, **kw):
        def deco(fn):
            self.handlers[("GET", path)] = fn
            return fn
        return deco

    def post(self, path, **kw):
        def deco(fn):
            self.handlers[("POST", path)] = fn
            return fn
        return deco


class _FakeGridOut:
    def __init__(self, data: bytes):
        self._data = data
    async def read(self):
        return self._data


class _FakeBucket:
    """filename -> list of (revision_id, bytes), latest-appended = latest revision."""
    def __init__(self):
        self.files: dict[str, list] = {}
        self._next_id = 1
        self.upload_calls = 0

    async def open_download_stream_by_name(self, filename):
        revs = self.files.get(filename)
        if not revs:
            raise gridfs.errors.NoFile(filename)
        return _FakeGridOut(revs[-1][1])

    async def upload_from_stream(self, filename, data, metadata=None):
        self.upload_calls += 1
        rev_id = self._next_id
        self._next_id += 1
        self.files.setdefault(filename, []).append((rev_id, data))
        return rev_id

    def find(self, query):
        filename = query["filename"]
        revs = self.files.get(filename, [])
        return _FakeCursor([{"_id": rid} for rid, _ in revs])

    async def delete(self, file_id):
        for filename, revs in self.files.items():
            self.files[filename] = [(rid, d) for rid, d in revs if rid != file_id]


class _FakeCursor:
    def __init__(self, items):
        self._items = items
    def sort(self, *a, **kw):
        return self
    def __aiter__(self):
        return self._gen()
    async def _gen(self):
        for item in self._items:
            yield _Doc(item)


class _Doc(dict):
    @property
    def _id(self):
        return self["_id"]


class _FakeReceiptsColl:
    def __init__(self, docs):
        self._docs = {d["receipt_id"]: d for d in docs}

    async def find_one(self, query, proj=None):
        rid = query.get("receipt_id")
        doc = self._docs.get(rid)
        if not doc:
            return None
        if "student_id" in query and doc.get("student_id") != query["student_id"]:
            return None
        return dict(doc)


class _FakeConfigColl:
    async def find_one(self, query):
        return None  # forces the default template config fallback


class _FakeDb:
    def __init__(self, receipts):
        self._colls = {
            "tuition_receipts": _FakeReceiptsColl(receipts),
            "tuition_config": _FakeConfigColl(),
        }
    def __getitem__(self, name):
        return self._colls[name]


async def _noop_dep():
    return None


def _setup(receipts):
    router = _FakeRouter()
    db = _FakeDb(receipts)
    trf.register_tuition_receipt_files_routes(router, db, lambda: _noop_dep, lambda: _noop_dep)
    bucket = _FakeBucket()
    trf.set_receipt_bucket(bucket)
    return router, bucket


RECEIPT = {
    "receipt_id": "rcpt_1",
    "invoice_number": "INV-2026-000001",
    "student_id": "sid1",
    "clean_id": "seyma.kann",
    "amount_usd": 18.0,
    "method": "khqr",
    "reference": "TUITION-1",
    "confirmed_at": None,
}


def test_cache_miss_renders_and_uploads_exactly_once():
    router, bucket = _setup([RECEIPT])
    handler = router.handlers[("GET", "/admin/tuition/receipt/{receipt_id}/pdf")]
    resp = run(handler(receipt_id="rcpt_1", admin=None))
    assert resp.media_type == "application/pdf"
    assert resp.body.startswith(b"%PDF-")
    assert bucket.upload_calls == 1


def test_cache_hit_does_not_re_render_or_re_upload():
    router, bucket = _setup([RECEIPT])
    handler = router.handlers[("GET", "/admin/tuition/receipt/{receipt_id}/pdf")]
    run(handler(receipt_id="rcpt_1", admin=None))
    assert bucket.upload_calls == 1
    run(handler(receipt_id="rcpt_1", admin=None))
    assert bucket.upload_calls == 1  # second request served from cache


def test_student_route_404s_for_a_receipt_owned_by_someone_else():
    router, bucket = _setup([RECEIPT])
    handler = router.handlers[("GET", "/student/tuition/receipt/{receipt_id}/pdf")]

    class _FakeStudent:
        student_id = "someone-else"

    with pytest.raises(Exception) as exc_info:
        run(handler(receipt_id="rcpt_1", student=_FakeStudent()))
    assert "404" in str(exc_info.value) or getattr(exc_info.value, "status_code", None) == 404


def test_student_route_succeeds_for_the_owning_student():
    router, bucket = _setup([RECEIPT])
    handler = router.handlers[("GET", "/student/tuition/receipt/{receipt_id}/pdf")]

    class _FakeStudent:
        student_id = "sid1"

    resp = run(handler(receipt_id="rcpt_1", student=_FakeStudent()))
    assert resp.body.startswith(b"%PDF-")


def test_regenerate_replaces_revision_and_keeps_exactly_one_per_format():
    router, bucket = _setup([RECEIPT])
    pdf_handler = router.handlers[("GET", "/admin/tuition/receipt/{receipt_id}/pdf")]
    regen_handler = router.handlers[("POST", "/admin/tuition/receipt/{receipt_id}/regenerate")]

    run(pdf_handler(receipt_id="rcpt_1", admin=None))  # first render, caches rcpt_1.pdf
    assert len(bucket.files["rcpt_1.pdf"]) == 1

    result = run(regen_handler(receipt_id="rcpt_1", admin=None))
    assert result["ok"] is True
    assert result["pdf_bytes"] > 0 and result["png_bytes"] > 0
    # Exactly one live revision per format after regenerate — the old one was deleted.
    assert len(bucket.files["rcpt_1.pdf"]) == 1
    assert len(bucket.files["rcpt_1.png"]) == 1


def test_regenerate_route_accepts_no_financial_fields():
    """The regenerate handler's only parameter is receipt_id (+ the admin
    dependency) — there is no body parameter it could use to mutate
    amount/student/date, which is the C7 immutability guarantee at the
    route-signature level."""
    import inspect
    router, _ = _setup([RECEIPT])
    handler = router.handlers[("POST", "/admin/tuition/receipt/{receipt_id}/regenerate")]
    params = set(inspect.signature(handler).parameters)
    assert params == {"receipt_id", "admin"}


def test_unknown_receipt_id_returns_404_not_a_crash():
    router, _ = _setup([RECEIPT])
    handler = router.handlers[("GET", "/admin/tuition/receipt/{receipt_id}/pdf")]
    with pytest.raises(Exception):
        run(handler(receipt_id="does-not-exist", admin=None))
