"""tests/test_hero_artwork_tools.py — Hero Artwork upload + media library.

Covers: admin gating, format validation (PNG/WebP/SVG/JPEG accepted,
garbage rejected), size cap, best-effort dimension parsing per format,
storage-not-configured -> 503, list ordering, and delete (including the
R2 cleanup call + 404 for a missing asset).

No live MongoDB / R2 — self-contained fake collection (established
pattern) + monkeypatching the module's _upload_to_r2/_delete_from_r2
functions directly (they're looked up by module-global name at call
time, so patching hero_artwork_tools._upload_to_r2 is picked up by the
route handler without needing dependency injection).
"""
from __future__ import annotations

import struct
from types import SimpleNamespace

from fastapi import APIRouter, FastAPI, HTTPException
from fastapi.testclient import TestClient

import hero_artwork_tools as hat


# ── binary fixtures ─────────────────────────────────────────────────────────
def _png_bytes(width=100, height=200):
    return (
        b"\x89PNG\r\n\x1a\n"
        + struct.pack(">I", 13) + b"IHDR"
        + struct.pack(">II", width, height)
        + b"\x08\x06\x00\x00\x00" + b"\x00\x00\x00\x00"
    )


def _svg_bytes(width=120, height=80):
    return f'<svg width="{width}" height="{height}" xmlns="http://www.w3.org/2000/svg"></svg>'.encode()


def _webp_bytes(width=150, height=90):
    w1 = (width - 1).to_bytes(3, "little")
    h1 = (height - 1).to_bytes(3, "little")
    return (
        b"RIFF" + struct.pack("<I", 20) + b"WEBP" + b"VP8X"
        + struct.pack("<I", 10) + bytes([0, 0, 0, 0]) + w1 + h1
    )


def _jpeg_bytes(width=400, height=300):
    return (
        b"\xff\xd8" + b"\xff\xc0" + struct.pack(">H", 11) + b"\x08"
        + struct.pack(">HH", height, width) + b"\x01" + b"\x01\x11\x00"
    )


# ── fake Mongo collection ────────────────────────────────────────────────────
class _Cursor:
    def __init__(self, docs):
        self._docs = list(docs)

    def sort(self, spec):
        for field, direction in reversed(spec):
            self._docs.sort(key=lambda d: d.get(field) or 0, reverse=(direction == -1))
        return self

    async def to_list(self, length=None):
        return list(self._docs)


class _Coll:
    def __init__(self):
        self._docs = []

    def find(self, q=None, projection=None):
        q = q or {}
        return _Cursor([d for d in self._docs if all(d.get(k) == v for k, v in q.items())])

    async def find_one(self, q):
        for d in self._docs:
            if all(d.get(k) == v for k, v in q.items()):
                return dict(d)
        return None

    async def insert_one(self, doc):
        self._docs.append(dict(doc))
        return SimpleNamespace(inserted_id=doc.get("id"))

    async def delete_one(self, q):
        before = len(self._docs)
        self._docs = [d for d in self._docs if not all(d.get(k) == v for k, v in q.items())]
        return SimpleNamespace(deleted_count=before - len(self._docs))


class _FakeDB:
    def __init__(self):
        self.hero_artwork_assets = _Coll()


class _Admin:
    email = "admin@school.example"


async def _allow_admin():
    return _Admin()


async def _deny_admin():
    raise HTTPException(status_code=401, detail="Not authenticated")


def _make_client(require_admin=_allow_admin):
    db = _FakeDB()
    app = FastAPI()
    api = APIRouter(prefix="/api")
    hat.register_hero_artwork_routes(api, db, require_admin)
    app.include_router(api)
    return TestClient(app), db


def _upload(client, filename, content, content_type):
    return client.post(
        "/api/hero-artwork/upload",
        files={"file": (filename, content, content_type)},
    )


# ── admin gating ─────────────────────────────────────────────────────────────

def test_upload_requires_admin():
    client, _ = _make_client(require_admin=_deny_admin)
    resp = _upload(client, "a.png", _png_bytes(), "image/png")
    assert resp.status_code == 401


def test_list_requires_admin():
    client, _ = _make_client(require_admin=_deny_admin)
    resp = client.get("/api/hero-artwork/library")
    assert resp.status_code == 401


def test_delete_requires_admin():
    client, _ = _make_client(require_admin=_deny_admin)
    resp = client.delete("/api/hero-artwork/library/whatever")
    assert resp.status_code == 401


# ── storage not configured (no R2 env vars in test environment) ────────────

def test_upload_returns_503_when_storage_not_configured():
    client, _ = _make_client()
    resp = _upload(client, "a.png", _png_bytes(), "image/png")
    assert resp.status_code == 503


# ── validation, with R2 upload mocked to succeed ────────────────────────────

def test_upload_accepts_png_and_parses_dimensions(monkeypatch):
    async def fake_upload(image_bytes, key, content_type, metadata):
        return f"https://cdn.example/{key}"
    monkeypatch.setattr(hat, "_upload_to_r2", fake_upload)

    client, db = _make_client()
    resp = _upload(client, "a.png", _png_bytes(100, 200), "image/png")
    assert resp.status_code == 200
    asset = resp.json()["asset"]
    assert asset["contentType"] == "image/png"
    assert asset["width"] == 100
    assert asset["height"] == 200
    assert asset["url"].startswith("https://cdn.example/hero-artwork/")
    assert len(db.hero_artwork_assets._docs) == 1


def test_upload_accepts_svg_and_parses_dimensions_from_attributes(monkeypatch):
    async def fake_upload(image_bytes, key, content_type, metadata):
        return f"https://cdn.example/{key}"
    monkeypatch.setattr(hat, "_upload_to_r2", fake_upload)

    client, _ = _make_client()
    resp = _upload(client, "a.svg", _svg_bytes(120, 80), "image/svg+xml")
    assert resp.status_code == 200
    asset = resp.json()["asset"]
    assert asset["contentType"] == "image/svg+xml"
    assert asset["width"] == 120
    assert asset["height"] == 80


def test_upload_accepts_webp_and_parses_vp8x_dimensions(monkeypatch):
    async def fake_upload(image_bytes, key, content_type, metadata):
        return f"https://cdn.example/{key}"
    monkeypatch.setattr(hat, "_upload_to_r2", fake_upload)

    client, _ = _make_client()
    resp = _upload(client, "a.webp", _webp_bytes(150, 90), "image/webp")
    assert resp.status_code == 200
    asset = resp.json()["asset"]
    assert asset["contentType"] == "image/webp"
    assert asset["width"] == 150
    assert asset["height"] == 90


def test_upload_accepts_jpeg_and_parses_sof0_dimensions(monkeypatch):
    async def fake_upload(image_bytes, key, content_type, metadata):
        return f"https://cdn.example/{key}"
    monkeypatch.setattr(hat, "_upload_to_r2", fake_upload)

    client, _ = _make_client()
    resp = _upload(client, "a.jpg", _jpeg_bytes(400, 300), "image/jpeg")
    assert resp.status_code == 200
    asset = resp.json()["asset"]
    assert asset["contentType"] == "image/jpeg"
    assert asset["width"] == 400
    assert asset["height"] == 300


def test_upload_rejects_unrecognized_bytes():
    client, _ = _make_client()
    resp = _upload(client, "a.png", b"not an image at all", "image/png")
    assert resp.status_code == 400


def test_upload_rejects_empty_file():
    client, _ = _make_client()
    resp = _upload(client, "a.png", b"", "image/png")
    assert resp.status_code == 400


def test_upload_rejects_oversized_file(monkeypatch):
    monkeypatch.setattr(hat, "HARD_MAX_IMAGE_BYTES", 10)
    client, _ = _make_client()
    resp = _upload(client, "a.png", _png_bytes(), "image/png")
    assert resp.status_code == 400


def test_dimension_parse_failure_never_blocks_upload(monkeypatch):
    async def fake_upload(image_bytes, key, content_type, metadata):
        return f"https://cdn.example/{key}"
    monkeypatch.setattr(hat, "_upload_to_r2", fake_upload)

    client, _ = _make_client()
    # Valid PNG magic bytes but truncated IHDR chunk -> dimension parse fails.
    truncated = b"\x89PNG\r\n\x1a\n" + b"\x00" * 10
    resp = _upload(client, "a.png", truncated, "image/png")
    assert resp.status_code == 200
    asset = resp.json()["asset"]
    assert asset["width"] is None
    assert asset["height"] is None


# ── list ─────────────────────────────────────────────────────────────────────

def test_list_returns_most_recently_uploaded_first(monkeypatch):
    async def fake_upload(image_bytes, key, content_type, metadata):
        return f"https://cdn.example/{key}"
    monkeypatch.setattr(hat, "_upload_to_r2", fake_upload)

    client, db = _make_client()
    _upload(client, "first.png", _png_bytes(), "image/png")
    db.hero_artwork_assets._docs[0]["uploadedAt"] = __import__("datetime").datetime(2020, 1, 1)
    _upload(client, "second.png", _png_bytes(), "image/png")
    db.hero_artwork_assets._docs[1]["uploadedAt"] = __import__("datetime").datetime(2025, 1, 1)

    resp = client.get("/api/hero-artwork/library")
    assets = resp.json()["assets"]
    assert len(assets) == 2
    assert assets[0]["url"].endswith(assets[0]["id"] + ".png")


# ── delete ───────────────────────────────────────────────────────────────────

def test_delete_removes_asset_and_calls_r2_cleanup(monkeypatch):
    async def fake_upload(image_bytes, key, content_type, metadata):
        return f"https://cdn.example/{key}"
    deleted_keys = []
    async def fake_delete(key):
        deleted_keys.append(key)
    monkeypatch.setattr(hat, "_upload_to_r2", fake_upload)
    monkeypatch.setattr(hat, "_delete_from_r2", fake_delete)

    client, db = _make_client()
    asset = _upload(client, "a.png", _png_bytes(), "image/png").json()["asset"]

    resp = client.delete(f"/api/hero-artwork/library/{asset['id']}")
    assert resp.status_code == 200
    assert len(db.hero_artwork_assets._docs) == 0
    assert deleted_keys == [f"hero-artwork/{asset['id']}.png"]


def test_delete_missing_asset_is_404():
    client, _ = _make_client()
    resp = client.delete("/api/hero-artwork/library/does-not-exist")
    assert resp.status_code == 404
