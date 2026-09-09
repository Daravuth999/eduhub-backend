"""tests/test_r2_upload_contract.py — the Video Library's single R2 upload
choke point (sync_studio_tools._upload_media_to_r2, reused directly by
video_narration_tools.py's _store_audio/_store_video for every ElevenLabs
line, SFX asset, and final rendered master) exercised against a REAL local
S3-compatible HTTP server — not a mocked-away function. Real boto3 request
construction, real SigV4 signing, real PUT semantics.

Live Cloudflare R2 credentials are not available in this environment (see
this session's own investigation) — this cannot prove the real R2 bucket
works. What it proves: the exact same boto3 client construction and
put_object call this codebase makes in production genuinely round-trips
bytes/content-type/metadata through a real S3-compatible PUT, and genuinely
returns None (never raises) when the endpoint rejects the request — so the
caller's GridFS-fallback path is reachable, not merely assumed.

`endpoint_override` is a test-only parameter added to _upload_media_to_r2
specifically for this file — no production call site ever passes it.
"""
from __future__ import annotations

import http.server
import os
import tempfile
import threading

import pytest

import sync_studio_tools as sst


class _RecordingS3Handler(http.server.BaseHTTPRequestHandler):
    """Minimal S3-compatible PUT/HEAD handler: enough for boto3's
    put_object/head_object to behave like a real bucket, while recording
    exactly what was sent so tests can assert on the real request shape.

    2026-09 — do_HEAD added: sync_studio_tools._upload_media_to_r2 now
    HEAD-checks a key before PUTting (content-addressed dedup — see
    assess_speaker_continuity_quality's sibling change in the same pass).
    A real S3/R2 bucket answers HEAD with 404 for an unknown key and 200
    for one that's genuinely stored; this mock now does the same
    (tracking which paths have actually been PUT), rather than falling
    through to BaseHTTPRequestHandler's default 501 for an unimplemented
    method — which would have made boto3's head_object raise a non-404
    ClientError and incorrectly abort the whole upload as "R2 failed"."""
    requests: list[dict] = []
    status_to_return = 200
    stored_paths: set = set()

    def do_HEAD(self):
        if self.path in _RecordingS3Handler.stored_paths:
            self.send_response(200)
            self.send_header("ETag", '"deadbeef"')
            self.end_headers()
        else:
            self.send_response(404)
            self.end_headers()

    def do_PUT(self):
        length = int(self.headers.get("Content-Length", 0))
        body = self.rfile.read(length)
        _RecordingS3Handler.requests.append({
            "path": self.path, "body": body,
            "content_type": self.headers.get("Content-Type"),
            "metadata": {k[len("x-amz-meta-"):]: v for k, v in self.headers.items()
                         if k.lower().startswith("x-amz-meta-")},
        })
        if _RecordingS3Handler.status_to_return != 200:
            self.send_response(_RecordingS3Handler.status_to_return)
            self.end_headers()
            return
        _RecordingS3Handler.stored_paths.add(self.path)
        self.send_response(200)
        self.send_header("ETag", '"deadbeef"')
        self.end_headers()

    def log_message(self, *a):  # silence stdlib access logging during tests
        pass


@pytest.fixture
def mock_s3_server():
    _RecordingS3Handler.requests = []
    _RecordingS3Handler.status_to_return = 200
    _RecordingS3Handler.stored_paths = set()
    server = http.server.ThreadingHTTPServer(("127.0.0.1", 0), _RecordingS3Handler)
    thread = threading.Thread(target=server.serve_forever, daemon=True)
    thread.start()
    port = server.server_address[1]
    try:
        yield f"http://127.0.0.1:{port}", _RecordingS3Handler
    finally:
        server.shutdown()
        thread.join(timeout=5)


@pytest.fixture(autouse=True)
def _r2_env(monkeypatch):
    monkeypatch.setenv("R2_ACCOUNT_ID", "test-account")
    monkeypatch.setenv("R2_ACCESS_KEY_ID", "test-access-key")
    monkeypatch.setenv("R2_SECRET_ACCESS_KEY", "test-secret-key")
    monkeypatch.setenv("R2_BUCKET_NAME", "test-bucket")
    monkeypatch.setenv("R2_PUBLIC_URL", "https://media.example-cdn.test")


@pytest.mark.asyncio
async def test_real_put_object_round_trips_bytes_content_type_and_metadata(mock_s3_server):
    """The exact production request shape: bucket/key/body/content-type/
    metadata genuinely reach a real S3-compatible server via a real signed
    PUT — not merely constructed and never sent."""
    endpoint, handler = mock_s3_server
    key = "video-narration/vid_1/sc1/ln1/att1.mp3"
    raw = b"genuine-audio-bytes-not-a-placeholder"

    url = await sst._upload_media_to_r2(
        raw, key, "audio/mpeg", {"lessonId": "vid_1"}, endpoint_override=endpoint,
    )

    assert url == "https://media.example-cdn.test/" + key
    assert len(handler.requests) == 1
    req = handler.requests[0]
    assert req["path"] == f"/test-bucket/{key}"
    assert req["body"] == raw
    assert req["content_type"] == "audio/mpeg"
    assert {k.lower(): v for k, v in req["metadata"].items()}.get("lessonid") == "vid_1"


@pytest.mark.asyncio
async def test_generated_media_flows_through_upload_function_to_a_persisted_media_ref(mock_s3_server):
    """The full chain the Directive asks for: media bytes -> upload
    function -> object key -> public URL -> what the caller would persist
    as mediaRef. Two different keys must never collide or overwrite."""
    endpoint, handler = mock_s3_server
    audio_ref = await sst._upload_media_to_r2(
        b"line-audio-bytes", "video-narration/vid_1/sc1/ln1/att1.mp3", "audio/mpeg", {},
        endpoint_override=endpoint,
    )
    video_ref = await sst._upload_media_to_r2(
        b"final-master-bytes", "video-narration/vid_1/master/att1.mp4", "video/mp4", {},
        endpoint_override=endpoint,
    )
    assert audio_ref != video_ref
    assert audio_ref.endswith("att1.mp3")
    assert video_ref.endswith("att1.mp4")
    assert len(handler.requests) == 2
    assert handler.requests[0]["body"] == b"line-audio-bytes"
    assert handler.requests[1]["body"] == b"final-master-bytes"


@pytest.mark.asyncio
async def test_failure_behavior_never_raises_and_returns_none_for_the_caller_to_fall_back(mock_s3_server):
    """A real rejected upload (endpoint returns 5xx) must never raise —
    the whole point of this function's contract is that the caller
    (video_narration_tools._store_audio/_store_video) can transparently
    fall back to GridFS. Proven against a genuinely failing real server,
    not a raised exception standing in for one."""
    endpoint, handler = mock_s3_server
    handler.status_to_return = 500

    result = await sst._upload_media_to_r2(
        b"audio-bytes", "video-narration/vid_1/sc1/ln1/att1.mp3", "audio/mpeg", {},
        endpoint_override=endpoint,
    )
    assert result is None
    assert len(handler.requests) >= 1, "the request genuinely reached the server and was genuinely rejected"


@pytest.mark.asyncio
async def test_a_second_upload_to_the_same_key_is_skipped_via_head_check_dedup(mock_s3_server):
    """The actual content-hash-dedup contract (2026-09): a key that's
    already genuinely stored (a real prior PUT succeeded against this
    same mock server) must never be PUT again — HEAD confirms it exists
    and the function returns the same URL without a second network
    write."""
    endpoint, handler = mock_s3_server
    key = "sync-media/deadbeefdeadbeef.mp4"

    first = await sst._upload_media_to_r2(b"same-bytes", key, "video/mp4", {}, endpoint_override=endpoint)
    assert len(handler.requests) == 1  # the real PUT happened

    second = await sst._upload_media_to_r2(b"same-bytes", key, "video/mp4", {}, endpoint_override=endpoint)
    assert second == first
    assert len(handler.requests) == 1  # NOT 2 — the second call never PUT again


@pytest.mark.asyncio
async def test_file_path_upload_streams_the_real_file_content_not_a_second_buffer(mock_s3_server):
    """2026-09 large-upload OOM fix: _upload_media_to_r2 now accepts
    file_path= (raw=None) so create_sync_from_upload can stream a remuxed
    video straight from disk instead of holding a second full in-memory
    copy alongside the original upload buffer — see that function's
    docstring for the confirmed production crash this fixes. Proven
    against the REAL mock server (not a mocked-away boto3 call): a real
    on-disk file's exact bytes genuinely reach the server via a real
    signed PUT when passed as file_path instead of raw."""
    endpoint, handler = mock_s3_server
    key = "sync-media/streamed-from-disk.mp4"
    content = b"a-real-remuxed-video-payload-streamed-from-a-temp-file" * 1000

    fd, path = tempfile.mkstemp(suffix=".mp4")
    try:
        with os.fdopen(fd, "wb") as f:
            f.write(content)

        url = await sst._upload_media_to_r2(
            None, key, "video/mp4", {"backfill": "faststart"}, endpoint_override=endpoint, file_path=path,
        )
    finally:
        os.remove(path)

    assert url == "https://media.example-cdn.test/" + key
    assert len(handler.requests) == 1
    assert handler.requests[0]["body"] == content
    assert handler.requests[0]["content_type"] == "video/mp4"


@pytest.mark.asyncio
async def test_file_path_upload_also_participates_in_head_check_dedup(mock_s3_server):
    """The file_path path must go through the exact same HEAD-before-PUT
    dedup as the raw-bytes path — a second upload of an already-stored
    content-addressed key must never PUT again, whether the caller has
    the content as bytes or as a file on disk."""
    endpoint, handler = mock_s3_server
    key = "sync-media/streamed-dedup-check.mp4"
    content = b"identical-content-uploaded-twice-from-disk"

    fd, path = tempfile.mkstemp(suffix=".mp4")
    try:
        with os.fdopen(fd, "wb") as f:
            f.write(content)
        first = await sst._upload_media_to_r2(None, key, "video/mp4", {}, endpoint_override=endpoint, file_path=path)
    finally:
        os.remove(path)
    assert len(handler.requests) == 1

    fd2, path2 = tempfile.mkstemp(suffix=".mp4")
    try:
        with os.fdopen(fd2, "wb") as f:
            f.write(content)
        second = await sst._upload_media_to_r2(None, key, "video/mp4", {}, endpoint_override=endpoint, file_path=path2)
    finally:
        os.remove(path2)

    assert second == first
    assert len(handler.requests) == 1  # NOT 2 — HEAD found it already stored


@pytest.mark.asyncio
async def test_missing_r2_config_short_circuits_without_ever_touching_the_network(monkeypatch, mock_s3_server):
    endpoint, handler = mock_s3_server
    monkeypatch.delenv("R2_SECRET_ACCESS_KEY", raising=False)

    result = await sst._upload_media_to_r2(
        b"audio-bytes", "video-narration/vid_1/sc1/ln1/att1.mp3", "audio/mpeg", {},
        endpoint_override=endpoint,
    )
    assert result is None
    assert handler.requests == []
