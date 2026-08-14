"""tests/test_voice_treasure_media.py — durable media storage + generated
mission flow + authenticated content delivery.

NO live provider call. The Gemini adapter is monkey-patched. GridFS is
exercised via Motor against an in-memory test database. mongomock-motor is
not available in this environment, so we use a tiny in-process fake bucket +
collection that satisfies the API surface used by the module under test.
"""
from __future__ import annotations

import asyncio
import hashlib
from types import SimpleNamespace

import pytest

import voice_treasure_media as media
import voice_treasure_entry_tools as vt_entry
import voice_treasure_scenes as vt_scenes


def run(c): return asyncio.run(c)


# ── A tiny in-memory shim that emulates the subset of Motor we need ─────────
class _Coll:
    def __init__(self): self._docs: dict[str, dict] = {}

    async def find_one(self, q, projection=None):
        # support {"_id": x} and {"object_key": x}
        for k, v in self._docs.items():
            for fk, fv in q.items():
                if (fk == "_id" and k == fv) or (v.get(fk) == fv):
                    return {kk: vv for kk, vv in v.items() if not (projection and projection.get(kk) == 0 and kk == "_id")}
        return None

    async def update_one(self, q, update, upsert=False):
        key = q.get("_id") or q.get("object_key")
        if "$setOnInsert" in update:
            if key not in self._docs:
                self._docs[key] = dict(update["$setOnInsert"])
        if "$set" in update:
            self._docs.setdefault(key, {}).update(update["$set"])
        return SimpleNamespace(matched_count=1, modified_count=1)

    async def create_index(self, *a, **k): return "idx"


class _GridDownload:
    def __init__(self, data: bytes): self._data = data
    async def read(self): return self._data


class _GridBucket:
    """In-memory GridFS substitute."""
    def __init__(self, db, bucket_name): self._store: dict[str, bytes] = {}; self._db = db
    async def upload_from_stream(self, name, fileobj, metadata=None):
        self._store[name] = fileobj.read()
        return "fakeid-" + name
    async def open_download_stream_by_name(self, name):
        if name not in self._store:
            raise FileNotFoundError(name)
        return _GridDownload(self._store[name])


class _DB:
    def __init__(self):
        self._colls: dict[str, _Coll] = {}
        # Single shared bucket per db so writes are readable.
        self._bucket: _GridBucket | None = None

    def __getitem__(self, name): return self._colls.setdefault(name, _Coll())


@pytest.fixture(autouse=True)
def _patch_bucket(monkeypatch):
    """Route media._bucket() to our in-memory bucket."""
    monkeypatch.setattr(media, "_bucket", lambda db: _shared_bucket_for(db))
    yield


_BUCKET_REGISTRY: dict[int, _GridBucket] = {}


def _shared_bucket_for(db) -> _GridBucket:
    bkey = id(db)
    if bkey not in _BUCKET_REGISTRY:
        _BUCKET_REGISTRY[bkey] = _GridBucket(db, media.GRIDFS_BUCKET_NAME)
    return _BUCKET_REGISTRY[bkey]


# ── core durable storage ────────────────────────────────────────────────────
PNG = b"\x89PNG\r\n\x1a\n" + b"opaque-bytes-1234567890"


def test_store_then_load_durable_roundtrip():
    db = _DB()
    desc = run(media.store_generated_image_durable(db, PNG, "image/png"))
    assert desc["object_key"].startswith("vtimg-")
    assert desc["mime"] == "image/png"
    assert desc["size"] == len(PNG)
    assert desc["sha256"] == hashlib.sha256(PNG).hexdigest()
    assert desc["backend"] == "gridfs"

    data, mime, meta = run(media.load_generated_image_durable(db, desc["object_key"]))
    assert data == PNG and mime == "image/png"
    assert meta["sha256"] == desc["sha256"]


def test_invalid_object_key_rejected():
    db = _DB()
    for bad in ("", "/etc/passwd", "../escape", "scene_balloon.svg", "nope"):
        with pytest.raises(media.MediaStorageError):
            run(media.load_generated_image_durable(db, bad))


def test_unsupported_mime_rejected():
    with pytest.raises(media.MediaStorageError):
        run(media.store_generated_image_durable(_DB(), b"x", "image/gif"))


def test_oversize_rejected():
    big = b"x" * (media.MAX_GENERATED_BYTES + 1)
    with pytest.raises(media.MediaStorageError):
        run(media.store_generated_image_durable(_DB(), big, "image/png"))


def test_size_mismatch_detected(monkeypatch):
    db = _DB()
    desc = run(media.store_generated_image_durable(db, PNG, "image/png"))
    # Corrupt the recorded size in the metadata collection so the next read
    # mismatches.
    db[media.COLL_MEDIA]._docs[desc["object_key"]]["size"] = len(PNG) + 1
    with pytest.raises(media.MediaStorageError):
        run(media.load_generated_image_durable(db, desc["object_key"]))


def test_hash_mismatch_detected():
    db = _DB()
    desc = run(media.store_generated_image_durable(db, PNG, "image/png"))
    db[media.COLL_MEDIA]._docs[desc["object_key"]]["sha256"] = "deadbeef" * 8
    with pytest.raises(media.MediaStorageError):
        run(media.load_generated_image_durable(db, desc["object_key"]))


# ── mission creation wires the generated path when the toggles are on ──────
def test_generated_mission_assignment_uses_durable_storage(monkeypatch):
    """`get_or_create_today_mission` calls the gemini adapter; on success the
    mission record carries `image_kind=generated` and the OPAQUE object_key
    (not a backend filesystem path, not the model name)."""
    db = _DB()

    # Pretend the master switches are ON and the adapter would succeed.
    monkeypatch.setenv("VOICE_TREASURE_IMAGE_GENERATION_ENABLED", "1")
    monkeypatch.setenv("VOICE_TREASURE_IMAGE_MODEL", "fake-model")
    monkeypatch.setenv("GEMINI_API_KEY", "fake-key")

    # Replace the adapter so the test doesn't perform a network call. The
    # adapter calls `store(ref, bytes, mime)` and returns IMG_GENERATED.
    import voice_treasure_gemini as gemini

    async def fake_prepare(*, theme, difficulty, store=None, reference=None,
                            image_model=None):
        opaque = store(reference or "vt-x", PNG, "image/png")
        return {"outcome": gemini.IMG_GENERATED, "image_kind": "generated",
                "image_ref": opaque, "stored_path": opaque, "image_mime": "image/png",
                "reason": None}

    monkeypatch.setattr(gemini, "prepare_mission_image", fake_prepare)

    cfg = {
        "images": {"image_generation_enabled": True, "difficulty_mode": "adaptive"},
    }
    mission = run(vt_entry.get_or_create_today_mission(db, "stu1", cfg))
    assert mission["image_kind"] == "generated"
    # image_ref MUST be the opaque object_key from our durable store
    assert mission["image_ref"].startswith("vtimg-")
    # and the bytes are loadable back
    data, mime, _ = run(media.load_generated_image_durable(db, mission["image_ref"]))
    assert data == PNG and mime == "image/png"


def test_generated_mission_falls_back_when_provider_fails(monkeypatch):
    """When prepare_mission_image returns IMG_FAILED, the mission must fall
    back to bundled — paid play is NEVER blocked by a provider outage."""
    db = _DB()
    monkeypatch.setenv("VOICE_TREASURE_IMAGE_GENERATION_ENABLED", "1")
    monkeypatch.setenv("VOICE_TREASURE_IMAGE_MODEL", "fake-model")
    monkeypatch.setenv("GEMINI_API_KEY", "fake-key")

    import voice_treasure_gemini as gemini

    async def fake_fail(*, theme, difficulty, store=None, reference=None,
                        image_model=None):
        return {"outcome": gemini.IMG_FAILED, "image_kind": "fallback",
                "image_ref": gemini.FALLBACK_IMAGE_REF, "reason": "provider_rejected"}

    monkeypatch.setattr(gemini, "prepare_mission_image", fake_fail)

    cfg = {"images": {"image_generation_enabled": True}}
    mission = run(vt_entry.get_or_create_today_mission(db, "stu2", cfg))
    assert mission["image_kind"] == "bundled"  # transparent fallback to scene
    assert mission["image_ref"].startswith("vt-scene-")


def test_generated_mission_disabled_keeps_bundled():
    db = _DB()
    cfg = {"images": {"image_generation_enabled": False}}
    mission = run(vt_entry.get_or_create_today_mission(db, "stu3", cfg))
    assert mission["image_kind"] == "bundled"
    assert mission["image_ref"].startswith("vt-scene-")
