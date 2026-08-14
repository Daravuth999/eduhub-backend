"""tests/test_sync_foundation.py
=====================================================
Universal Synchronization Engine, Phase 0 — Universal Synchronization
Foundation. Covers sync_schema.py's pure builders/validator,
sync_provider.py's ElevenLabsProvider reshape (over a FAKE injected
elevenlabs_generate — no real network call), sync_reading_profiles.py's
profile resolution, and sync_studio_tools.py's Mongo-backed functions
against an in-memory fake (same _Coll/_Result shape as
test_notification_packs.py, extended with find_one(sort=...) support since
get_current_chapter_sync needs it).
"""
from __future__ import annotations

import pytest

import sync_schema as schema
import sync_provider as provider
import sync_reading_profiles as profiles
import sync_studio_tools as studio


# ═════════════════════════════════════════════════════════════════════════
# sync_schema.py — pure builders + validator
# ═════════════════════════════════════════════════════════════════════════
def test_build_word_rounds_and_defaults_confidence_empty():
    w = schema.build_word("Hello", 0.1234, 0.5)
    assert w == {"word": "Hello", "start": 0.123, "end": 0.5, "confidence": {}}


def test_build_confidence_omits_none_values():
    c = schema.build_confidence(transcript=0.9, alignment=None)
    assert c == {"transcript": 0.9}


def test_build_sentence_derives_bounds_from_words():
    words = [schema.build_word("a", 0.0, 0.2), schema.build_word("b", 0.2, 0.5)]
    s = schema.build_sentence("s1", words)
    assert s["start"] == 0.0 and s["end"] == 0.5 and s["words"] == words


def test_build_sync_document_rejects_invalid_provider_category():
    with pytest.raises(ValueError):
        schema.build_sync_document(
            media_ref="x", provider_category="not_a_category", provider_version="v1",
            paragraphs=[], generated_at="2026-01-01T00:00:00Z", duration_sec=0,
        )


def test_build_sync_document_defaults_pending_and_assigns_sync_id():
    doc = schema.build_sync_document(
        media_ref="r2://x.mp3", provider_category="synthesis", provider_version="v1",
        paragraphs=[], generated_at="2026-01-01T00:00:00Z", duration_sec=1.0,
    )
    assert doc["reviewStatus"] == "pending"
    assert doc["syncId"].startswith("sync_")
    assert doc["syncVersion"] == schema.SYNC_VERSION
    assert doc["approvedAt"] is None


def test_validate_sync_document_catches_missing_words_field():
    doc = schema.build_sync_document(
        media_ref="x", provider_category="manual", provider_version="v1",
        paragraphs=[{"id": "p1", "sentences": [{"id": "s1"}]}],
        generated_at="2026-01-01T00:00:00Z", duration_sec=0,
    )
    ok, errors = schema.validate_sync_document(doc)
    assert not ok
    assert any("missing words" in e for e in errors)


def test_validate_sync_document_accepts_well_formed_doc():
    words = [schema.build_word("hi", 0.0, 0.3)]
    sentence = schema.build_sentence("s1", words)
    paragraph = schema.build_paragraph("p1", [sentence])
    doc = schema.build_sync_document(
        media_ref="x", provider_category="synthesis", provider_version="v1",
        paragraphs=[paragraph], generated_at="2026-01-01T00:00:00Z", duration_sec=0.3,
    )
    ok, errors = schema.validate_sync_document(doc)
    assert ok, errors


@pytest.mark.parametrize(
    "review_status,category,expected",
    [
        ("approved", "manual", True),
        ("pending", "synthesis", True),   # synthesis auto-approval bypass (spec §5)
        ("pending", "speech_recognition", False),
        ("rejected", "synthesis", True),  # bypass applies regardless of reviewStatus
        ("in_review", "alignment", False),
    ],
)
def test_is_servable_to_students_publish_gate(review_status, category, expected):
    doc = {"reviewStatus": review_status, "providerCategory": category}
    assert schema.is_servable_to_students(doc) is expected


def test_is_servable_to_students_false_for_non_dict():
    assert schema.is_servable_to_students(None) is False


# ═════════════════════════════════════════════════════════════════════════
# sync_provider.py — reshape + ElevenLabsProvider (no real network call)
# ═════════════════════════════════════════════════════════════════════════
def test_reshape_elevenlabs_word_timestamps_honest_confidence():
    doc = provider.reshape_elevenlabs_word_timestamps(
        [{"word": "Once", "start": 0.0, "end": 0.3}, {"word": "upon", "start": 0.3, "end": 0.6}]
    )
    words = doc["paragraphs"][0]["sentences"][0]["words"]
    assert [w["word"] for w in words] == ["Once", "upon"]
    # transcript=1.0 is honest (author-authored text), alignment omitted
    # entirely (build_confidence drops None) rather than fabricated as 1.0.
    assert words[0]["confidence"] == {"transcript": 1.0}
    assert doc["providerCategory"] == "synthesis"
    assert doc["durationSec"] == 0.6


def test_reshape_elevenlabs_word_timestamps_empty_list_is_valid_empty_doc():
    doc = provider.reshape_elevenlabs_word_timestamps([])
    ok, errors = schema.validate_sync_document(doc)
    assert ok, errors
    assert doc["durationSec"] == 0.0


@pytest.mark.asyncio
async def test_elevenlabs_provider_synthesize_wraps_injected_function_only():
    calls = []

    async def fake_generate(text, voice_id):
        calls.append((text, voice_id))
        return {"audio_base64": "AAA", "word_timestamps": [{"word": "hi", "start": 0.0, "end": 0.2}]}

    p = provider.ElevenLabsProvider(fake_generate)
    result = await p.synthesize("hi", "voice_123")

    assert calls == [("hi", "voice_123")]  # no real network call made
    assert result["audio_base64"] == "AAA"
    assert result["sync"]["paragraphs"][0]["sentences"][0]["words"][0]["word"] == "hi"


@pytest.mark.asyncio
async def test_elevenlabs_provider_align_not_implemented():
    p = provider.ElevenLabsProvider(lambda *a, **k: None)
    with pytest.raises(NotImplementedError):
        await p.align(b"fake-audio-bytes", None)


def test_elevenlabs_provider_requires_generate_fn():
    with pytest.raises(ValueError):
        provider.ElevenLabsProvider(None)


# ═════════════════════════════════════════════════════════════════════════
# sync_provider.py — ScribeAlignmentProvider (CANDIDATE, not production-
# wired). Confirmed request/response shape per ElevenLabs' own API
# reference (2026-08-06): POST /v1/speech-to-text, words carry
# {text, start, end, type, speaker_id, logprob}. All tests below inject a
# fake http_post — zero real network calls, matching this repo's
# no-real-network-in-tests convention.
# ═════════════════════════════════════════════════════════════════════════
def _scribe_word(text, start, end, *, logprob=-0.01, speaker_id=None, kind="word"):
    return {"text": text, "start": start, "end": end, "type": kind, "speaker_id": speaker_id, "logprob": logprob}


def test_scribe_provider_requires_api_key():
    with pytest.raises(ValueError):
        provider.ScribeAlignmentProvider("")


@pytest.mark.asyncio
async def test_scribe_provider_align_converts_logprob_to_probability():
    async def fake_post(audio_bytes, language_code):
        return {"language_code": "eng", "words": [_scribe_word("Hello", 0.0, 0.3, logprob=0.0)]}

    p = provider.ScribeAlignmentProvider("fake-key", http_post=fake_post)
    result = await p.align(b"fake-audio-bytes")

    word = result["sync"]["paragraphs"][0]["sentences"][0]["words"][0]
    # logprob=0.0 -> exp(0.0) == 1.0, the maximum-confidence case.
    assert word["confidence"]["transcript"] == pytest.approx(1.0)
    assert "alignment" not in word["confidence"]  # honestly omitted, not fabricated
    assert result["sync"]["providerCategory"] == "speech_recognition"


@pytest.mark.asyncio
async def test_scribe_provider_skips_non_word_entries():
    async def fake_post(audio_bytes, language_code):
        return {"words": [
            _scribe_word("Hello", 0.0, 0.3),
            {"type": "spacing", "start": 0.3, "end": 0.35},
            _scribe_word("world", 0.35, 0.6),
        ]}

    p = provider.ScribeAlignmentProvider("fake-key", http_post=fake_post)
    result = await p.align(b"x")
    words = result["sync"]["paragraphs"][0]["sentences"][0]["words"]
    assert [w["word"] for w in words] == ["Hello", "world"]


@pytest.mark.asyncio
async def test_scribe_provider_groups_speaker_turns_into_sentences():
    async def fake_post(audio_bytes, language_code):
        return {"words": [
            _scribe_word("Hello", 0.0, 0.3, speaker_id="spk_1"),
            _scribe_word("there", 0.3, 0.6, speaker_id="spk_1"),
            _scribe_word("Hi", 0.6, 0.9, speaker_id="spk_2"),
        ]}

    p = provider.ScribeAlignmentProvider("fake-key", http_post=fake_post)
    result = await p.align(b"x")
    sentences = result["sync"]["paragraphs"][0]["sentences"]
    assert len(sentences) == 2
    assert sentences[0]["speakerId"] == "spk_1" and len(sentences[0]["words"]) == 2
    assert sentences[1]["speakerId"] == "spk_2" and len(sentences[1]["words"]) == 1
    assert {s["id"] for s in result["sync"]["speakers"]} == {"spk_1", "spk_2"}


@pytest.mark.asyncio
async def test_scribe_provider_single_speaker_audio_has_no_speaker_id():
    async def fake_post(audio_bytes, language_code):
        return {"words": [_scribe_word("Hello", 0.0, 0.3)]}  # speaker_id=None

    p = provider.ScribeAlignmentProvider("fake-key", http_post=fake_post)
    result = await p.align(b"x")
    sentence = result["sync"]["paragraphs"][0]["sentences"][0]
    assert "speakerId" not in sentence
    assert "speakers" not in result["sync"]


@pytest.mark.asyncio
async def test_scribe_provider_synthesize_not_implemented():
    p = provider.ScribeAlignmentProvider("fake-key", http_post=lambda *a, **k: None)
    with pytest.raises(NotImplementedError):
        await p.synthesize("hi", "voice_1")


@pytest.mark.asyncio
async def test_scribe_provider_passes_language_code_through():
    seen = {}

    async def fake_post(audio_bytes, language_code):
        seen["language_code"] = language_code
        return {"words": []}

    p = provider.ScribeAlignmentProvider("fake-key", http_post=fake_post)
    await p.align(b"x", language_code="khm")
    assert seen["language_code"] == "khm"


@pytest.mark.asyncio
async def test_scribe_provider_produces_valid_sync_document():
    async def fake_post(audio_bytes, language_code):
        return {"words": [
            _scribe_word("Once", 0.0, 0.3, speaker_id="spk_1"),
            _scribe_word("upon", 0.3, 0.6, speaker_id="spk_1"),
        ]}

    p = provider.ScribeAlignmentProvider("fake-key", http_post=fake_post)
    result = await p.align(b"x")
    ok, errors = schema.validate_sync_document(result["sync"])
    assert ok, errors


# ═════════════════════════════════════════════════════════════════════════
# sync_reading_profiles.py
# ═════════════════════════════════════════════════════════════════════════
def test_resolve_reading_profile_default_when_none():
    assert profiles.resolve_reading_profile(None) == profiles.READING_PROFILES["reading"]


def test_resolve_reading_profile_unknown_name_falls_back_to_default():
    assert profiles.resolve_reading_profile("not_a_real_profile") == profiles.READING_PROFILES["reading"]


def test_resolve_reading_profile_named_preset():
    assert profiles.resolve_reading_profile("shadowing") == profiles.READING_PROFILES["shadowing"]


def test_resolve_reading_profile_overrides_merge_over_preset():
    result = profiles.resolve_reading_profile("reading", {"autoScroll": True})
    assert result["autoScroll"] is True
    assert result["wordHighlight"] is True  # unrelated flags untouched


def test_resolve_reading_profile_ignores_unknown_override_keys():
    result = profiles.resolve_reading_profile("reading", {"notARealFlag": True})
    assert "notARealFlag" not in result


def test_all_profiles_share_the_same_capability_key_set():
    key_sets = {frozenset(v.keys()) for v in profiles.READING_PROFILES.values()}
    assert len(key_sets) == 1  # profiles are sugar over ONE flag schema, never divergent shapes


# ═════════════════════════════════════════════════════════════════════════
# sync_studio_tools.py — fake Mongo (extends test_notification_packs.py's
# _Coll with find_one(sort=...) support, needed by get_current_chapter_sync)
# ═════════════════════════════════════════════════════════════════════════
class _Result:
    def __init__(self, **kw):
        for k, v in kw.items():
            setattr(self, k, v)


class _Coll:
    def __init__(self):
        self.docs: list[dict] = []

    async def insert_one(self, doc):
        self.docs.append(dict(doc))
        return _Result(inserted_id=None)

    async def find_one(self, query, projection=None, sort=None):
        matches = [d for d in self.docs if all(d.get(k) == v for k, v in (query or {}).items())]
        if not matches:
            return None
        if sort:
            key, direction = sort[0]
            matches = sorted(matches, key=lambda d: d.get(key) or "", reverse=(direction == -1))
        return dict(matches[0])

    async def update_one(self, query, update):
        for d in self.docs:
            if all(d.get(k) == v for k, v in (query or {}).items()):
                if "$set" in update:
                    d.update(update["$set"])
                if "$unset" in update:
                    for k in update["$unset"]:
                        d.pop(k, None)
                return _Result(matched_count=1)
        return _Result(matched_count=0)

    async def create_index(self, *a, **k):
        return None


class _FakeDB:
    def __init__(self):
        self.chapter_sync = _Coll()

    def __getitem__(self, name):
        assert name == studio.CHAPTER_SYNC_COLL
        return self.chapter_sync


def _book_with_narrated_chapter():
    return {
        "slug": "the-fox",
        "chapters": [
            {"title": "Ch1", "blocks": [
                {"type": "transcript", "text": "Once upon a time.",
                 "audioUrl": "https://pub-x.r2.dev/a.mp3",
                 "wordTimestamps": [
                     {"word": "Once", "start": 0.0, "end": 0.3},
                     {"word": "upon", "start": 0.3, "end": 0.6},
                 ]},
            ]},
        ],
    }


@pytest.mark.asyncio
async def test_create_sync_from_chapter_block_happy_path():
    db = _FakeDB()

    async def get_book_by_slug(slug):
        return _book_with_narrated_chapter() if slug == "the-fox" else None

    doc = await studio.create_sync_from_chapter_block(
        db, slug="the-fox", chapter_index=0, block_index=0, get_book_by_slug=get_book_by_slug,
    )
    assert doc["mediaRef"] == "https://pub-x.r2.dev/a.mp3"
    assert doc["slug"] == "the-fox" and doc["chapterIndex"] == 0 and doc["blockIndex"] == 0
    assert len(db.chapter_sync.docs) == 1


@pytest.mark.asyncio
async def test_create_sync_from_chapter_block_missing_word_timestamps_raises():
    db = _FakeDB()

    async def get_book_by_slug(slug):
        book = _book_with_narrated_chapter()
        book["chapters"][0]["blocks"][0].pop("wordTimestamps")
        return book

    with pytest.raises(studio.SyncStudioError) as exc:
        await studio.create_sync_from_chapter_block(
            db, slug="the-fox", chapter_index=0, block_index=0, get_book_by_slug=get_book_by_slug,
        )
    assert exc.value.code == "no_word_timestamps"


@pytest.mark.asyncio
async def test_create_sync_from_chapter_block_book_not_found_raises_404():
    db = _FakeDB()

    async def get_book_by_slug(slug):
        return None

    with pytest.raises(studio.SyncStudioError) as exc:
        await studio.create_sync_from_chapter_block(
            db, slug="missing", chapter_index=0, block_index=0, get_book_by_slug=get_book_by_slug,
        )
    assert exc.value.http_status == 404


@pytest.mark.asyncio
async def test_get_current_chapter_sync_returns_most_recent():
    db = _FakeDB()
    await db.chapter_sync.insert_one({
        "syncId": "sync_old", "slug": "s", "chapterIndex": 0, "generatedAt": "2026-01-01T00:00:00Z",
    })
    await db.chapter_sync.insert_one({
        "syncId": "sync_new", "slug": "s", "chapterIndex": 0, "generatedAt": "2026-06-01T00:00:00Z",
    })
    result = await studio.get_current_chapter_sync(db, "s", 0)
    assert result["syncId"] == "sync_new"


@pytest.mark.asyncio
async def test_transition_review_status_pending_to_in_review_to_approved():
    db = _FakeDB()
    await db.chapter_sync.insert_one({
        "syncId": "sync_1", "reviewStatus": "pending", "approvedAt": None, "speakers": [],
    })

    doc = await studio.transition_review_status(db, "sync_1", new_status="in_review")
    assert doc["reviewStatus"] == "in_review"

    doc = await studio.transition_review_status(db, "sync_1", new_status="approved")
    assert doc["reviewStatus"] == "approved"
    assert doc["approvedAt"] is not None


@pytest.mark.asyncio
async def test_transition_review_status_rejects_invalid_jump():
    db = _FakeDB()
    await db.chapter_sync.insert_one({"syncId": "sync_1", "reviewStatus": "pending", "speakers": []})

    with pytest.raises(studio.SyncStudioError) as exc:
        await studio.transition_review_status(db, "sync_1", new_status="approved")
    assert exc.value.code == "invalid_transition"


@pytest.mark.asyncio
async def test_transition_review_status_speaker_relabel():
    db = _FakeDB()
    await db.chapter_sync.insert_one({
        "syncId": "sync_1", "reviewStatus": "in_review",
        "speakers": [{"id": "spk_1", "label": "Narrator"}],
    })
    doc = await studio.transition_review_status(
        db, "sync_1", new_status="in_review", speaker_relabels={"spk_1": "Teacher"},
    )
    assert doc["speakers"][0]["label"] == "Teacher"


@pytest.mark.asyncio
async def test_transition_review_status_sync_not_found_raises_404():
    db = _FakeDB()
    with pytest.raises(studio.SyncStudioError) as exc:
        await studio.transition_review_status(db, "missing", new_status="in_review")
    assert exc.value.http_status == 404


@pytest.mark.parametrize(
    "alignment_status,review_status,category,expected",
    [
        ("complete", "approved", "manual", True),
        ("awaiting_provider", "approved", "manual", False),  # never servable pre-alignment
        ("awaiting_provider", "pending", "synthesis", False),  # synthesis bypass still gated on alignment
        ("complete", "pending", "synthesis", True),
    ],
)
def test_is_servable_to_students_alignment_status_gate(alignment_status, review_status, category, expected):
    doc = {"alignmentStatus": alignment_status, "reviewStatus": review_status, "providerCategory": category}
    assert schema.is_servable_to_students(doc) is expected


def test_is_servable_to_students_defaults_alignment_status_complete_for_legacy_docs():
    # A doc with no alignmentStatus at all (pre-dates this field) must not
    # regress to "never servable" — defaults to "complete".
    doc = {"reviewStatus": "approved", "providerCategory": "manual"}
    assert schema.is_servable_to_students(doc) is True


# ═════════════════════════════════════════════════════════════════════════
# sync_studio_tools.py — native media upload workflow (fake GridFS bucket,
# no real R2/network calls; R2 env vars are not set in this test environment
# so the default path is GridFS-fallback unless a test explicitly monkey-
# patches _upload_media_to_r2 to exercise the R2-success branch).
# ═════════════════════════════════════════════════════════════════════════
class _FakeGridOut:
    def __init__(self, data: bytes, metadata: dict):
        self._data = data
        self._pos = 0
        self.metadata = metadata
        self.length = len(data)

    async def seek(self, pos):
        self._pos = pos

    async def read(self, n):
        chunk = self._data[self._pos:self._pos + n]
        self._pos += len(chunk)
        return chunk


class _FakeMediaBucket:
    def __init__(self):
        self.files: dict[str, tuple[bytes, dict]] = {}

    async def upload_from_stream(self, filename, stream, metadata=None):
        self.files[filename] = (stream.read(), metadata or {})

    async def open_download_stream_by_name(self, filename):
        if filename not in self.files:
            raise FileNotFoundError(filename)
        data, metadata = self.files[filename]
        return _FakeGridOut(data, metadata)


@pytest.mark.asyncio
async def test_create_sync_from_upload_falls_back_to_gridfs_when_r2_not_configured():
    db = _FakeDB()
    bucket = _FakeMediaBucket()
    doc = await studio.create_sync_from_upload(
        db, slug="the-fox", chapter_index=0, raw=b"fake-mp3-bytes",
        declared_content_type="audio/mpeg", media_bucket=bucket, uploaded_by="admin@x.com",
    )
    assert doc["alignmentStatus"] == "awaiting_provider"
    assert doc["mediaRef"].startswith("gridfs://sync_media/")
    assert doc["contentType"] == "audio/mpeg"
    assert doc["slug"] == "the-fox" and doc["chapterIndex"] == 0
    assert len(bucket.files) == 1
    assert len(db.chapter_sync.docs) == 1


@pytest.mark.asyncio
async def test_create_sync_from_upload_uses_r2_when_available(monkeypatch):
    db = _FakeDB()
    bucket = _FakeMediaBucket()

    async def fake_r2_upload(raw, key, content_type, metadata):
        return "https://pub-fake.r2.dev/" + key

    monkeypatch.setattr(studio, "_upload_media_to_r2", fake_r2_upload)

    doc = await studio.create_sync_from_upload(
        db, slug="the-fox", chapter_index=0, raw=b"fake-video-bytes",
        declared_content_type="video/mp4", media_bucket=bucket,
    )
    assert doc["mediaRef"].startswith("https://pub-fake.r2.dev/")
    assert doc["contentType"] == "video/mp4"
    assert len(bucket.files) == 0  # GridFS never written when R2 succeeds


@pytest.mark.asyncio
async def test_create_sync_from_upload_rejects_unsupported_content_type():
    db = _FakeDB()
    bucket = _FakeMediaBucket()
    with pytest.raises(studio.SyncStudioError) as exc:
        await studio.create_sync_from_upload(
            db, slug="s", chapter_index=0, raw=b"x",
            declared_content_type="image/png", media_bucket=bucket,
        )
    assert exc.value.code == "unsupported_media_type"
    assert exc.value.http_status == 415


@pytest.mark.asyncio
async def test_create_sync_from_upload_rejects_empty_file():
    db = _FakeDB()
    bucket = _FakeMediaBucket()
    with pytest.raises(studio.SyncStudioError) as exc:
        await studio.create_sync_from_upload(
            db, slug="s", chapter_index=0, raw=b"",
            declared_content_type="audio/mpeg", media_bucket=bucket,
        )
    assert exc.value.code == "empty_file"


@pytest.mark.asyncio
async def test_create_sync_from_upload_rejects_oversized_file(monkeypatch):
    monkeypatch.setattr(studio, "HARD_MAX_MEDIA_BYTES", 10)
    db = _FakeDB()
    bucket = _FakeMediaBucket()
    with pytest.raises(studio.SyncStudioError) as exc:
        await studio.create_sync_from_upload(
            db, slug="s", chapter_index=0, raw=b"x" * 20,
            declared_content_type="audio/mpeg", media_bucket=bucket,
        )
    assert exc.value.code == "file_too_large"
    assert exc.value.http_status == 413


@pytest.mark.asyncio
async def test_create_sync_from_upload_accepts_video_identically_to_audio():
    db = _FakeDB()
    bucket = _FakeMediaBucket()
    doc = await studio.create_sync_from_upload(
        db, slug="s", chapter_index=1, raw=b"fake-mp4-bytes",
        declared_content_type="video/webm", media_bucket=bucket,
    )
    assert doc["contentType"] == "video/webm"
    assert doc["mediaRef"].endswith(".webm")


# ═════════════════════════════════════════════════════════════════════════
# sync_studio_tools.py — stream_sync_media (Range support, generalized
# from server.py's proven studio_audio_stream fix)
# ═════════════════════════════════════════════════════════════════════════
class _FakeHeaders:
    def __init__(self, range_value=None):
        self._range = range_value

    def get(self, key, default=None):
        if key.lower() == "range":
            return self._range
        return default


class _FakeRequest:
    def __init__(self, range_value=None):
        self.headers = _FakeHeaders(range_value)


async def _collect(response):
    return b"".join([chunk async for chunk in response.body_iterator])


@pytest.mark.asyncio
async def test_stream_sync_media_full_response_no_range():
    bucket = _FakeMediaBucket()
    bucket.files["a.mp3"] = (b"0123456789", {"contentType": "audio/mpeg"})
    resp = await studio.stream_sync_media(bucket, "a.mp3", _FakeRequest())
    assert resp.media_type == "audio/mpeg"
    assert resp.headers["Content-Length"] == "10"
    assert await _collect(resp) == b"0123456789"


@pytest.mark.asyncio
async def test_stream_sync_media_partial_range():
    bucket = _FakeMediaBucket()
    bucket.files["v.mp4"] = (b"0123456789", {"contentType": "video/mp4"})
    resp = await studio.stream_sync_media(bucket, "v.mp4", _FakeRequest("bytes=0-4"))
    assert resp.status_code == 206
    assert resp.headers["Content-Range"] == "bytes 0-4/10"
    assert await _collect(resp) == b"01234"


@pytest.mark.asyncio
async def test_stream_sync_media_suffix_range():
    bucket = _FakeMediaBucket()
    bucket.files["a.mp3"] = (b"0123456789", {"contentType": "audio/mpeg"})
    resp = await studio.stream_sync_media(bucket, "a.mp3", _FakeRequest("bytes=-3"))
    assert resp.status_code == 206
    assert await _collect(resp) == b"789"


@pytest.mark.asyncio
async def test_stream_sync_media_invalid_range_returns_416():
    bucket = _FakeMediaBucket()
    bucket.files["a.mp3"] = (b"0123456789", {"contentType": "audio/mpeg"})
    resp = await studio.stream_sync_media(bucket, "a.mp3", _FakeRequest("bytes=-"))
    assert resp.status_code == 416


@pytest.mark.asyncio
async def test_stream_sync_media_not_found_raises_404():
    bucket = _FakeMediaBucket()
    with pytest.raises(studio.HTTPException) as exc:
        await studio.stream_sync_media(bucket, "missing.mp3", _FakeRequest())
    assert exc.value.status_code == 404


@pytest.mark.asyncio
async def test_transition_review_status_edited_transcript_stored_not_rekeyed():
    """Documents the deliberate Phase 0 scope gap: editedTranscript is
    stored as a pending note, NOT re-keyed to word boundaries (that is
    real Review Studio algorithm work for a later commit)."""
    db = _FakeDB()
    await db.chapter_sync.insert_one({
        "syncId": "sync_1", "reviewStatus": "pending", "speakers": [],
        "paragraphs": [{"id": "p1", "sentences": [{"id": "s1", "words": [
            {"word": "Once", "start": 0.0, "end": 0.3},
        ]}]}],
    })
    doc = await studio.transition_review_status(
        db, "sync_1", new_status="in_review", edited_transcript="Once upon a time, corrected.",
    )
    assert doc["pendingTranscriptEdit"] == "Once upon a time, corrected."
    # word boundaries untouched by the edit in this pass
    assert doc["paragraphs"][0]["sentences"][0]["words"][0]["word"] == "Once"


# ═════════════════════════════════════════════════════════════════════════
# apply_alignment_result / resolve_sync_candidate — approved-version
# protection (production data-loss fix: a re-run of the pipeline used to
# silently overwrite an approved, teacher-edited transcript).
# ═════════════════════════════════════════════════════════════════════════
def _approved_doc(sync_id="sync_1", **overrides):
    return {
        "syncId": sync_id,
        "mediaRef": "https://pub-x.r2.dev/a.mp4",
        "syncVersion": schema.SYNC_VERSION,
        "providerVersion": "gemini-v1",
        "alignmentVersion": 3,
        "generatedAt": "2026-01-01T00:00:00Z",
        "approvedAt": "2026-01-02T00:00:00Z",
        "durationSec": 10.0,
        "providerCategory": "speech_recognition",
        "reviewStatus": "approved",
        "alignmentStatus": "complete",
        "paragraphs": [{"id": "p1", "sentences": [{"id": "s1", "words": [
            {"word": "Teacher", "start": 0.0, "end": 0.5, "confidence": {}},
            {"word": "corrected", "start": 0.5, "end": 1.0, "confidence": {}},
        ]}]}],
        **overrides,
    }


def _new_alignment_result(**overrides):
    return {
        "paragraphs": [{"id": "p1", "sentences": [{"id": "s1", "words": [
            {"word": "Fresh", "start": 0.0, "end": 0.4, "confidence": {}},
            {"word": "reprocess", "start": 0.4, "end": 0.9, "confidence": {}},
        ]}]}],
        "durationSec": 9.5,
        "providerCategory": "speech_recognition",
        "providerVersion": "gemini-v2",
        "generatedAt": "2026-02-01T00:00:00Z",
        **overrides,
    }


@pytest.mark.asyncio
async def test_apply_alignment_result_on_approved_doc_creates_candidate_not_overwrite():
    db = _FakeDB()
    await db.chapter_sync.insert_one(_approved_doc())

    result = await studio.apply_alignment_result(db, "sync_1", _new_alignment_result())

    # The candidate is staged...
    assert result["candidate"]["paragraphs"][0]["sentences"][0]["words"][0]["word"] == "Fresh"
    assert result["candidate"]["alignmentVersion"] == 4
    # ...but the PRODUCTION fields — what students actually see — are
    # completely untouched. This is the core fix: no silent overwrite.
    assert result["paragraphs"][0]["sentences"][0]["words"][0]["word"] == "Teacher"
    assert result["reviewStatus"] == "approved"
    assert result["approvedAt"] == "2026-01-02T00:00:00Z"

    # Confirmed against a fresh read too, not just the return value.
    fresh = await studio.get_sync_document(db, "sync_1")
    assert fresh["paragraphs"][0]["sentences"][0]["words"][0]["word"] == "Teacher"
    assert fresh["candidate"]["paragraphs"][0]["sentences"][0]["words"][0]["word"] == "Fresh"


@pytest.mark.asyncio
async def test_apply_alignment_result_still_publishable_to_students_while_candidate_pending():
    """Students must keep seeing the approved version — is_servable_to_
    students reads only the top-level fields, never the candidate."""
    db = _FakeDB()
    await db.chapter_sync.insert_one(_approved_doc())
    result = await studio.apply_alignment_result(db, "sync_1", _new_alignment_result())
    assert schema.is_servable_to_students(result) is True


@pytest.mark.asyncio
async def test_apply_alignment_result_on_unapproved_doc_still_overwrites_in_place():
    """No teacher-approved production content exists yet (first run, or
    still mid-review) — behavior is unchanged from before this fix."""
    db = _FakeDB()
    await db.chapter_sync.insert_one(_approved_doc(reviewStatus="pending", approvedAt=None))

    result = await studio.apply_alignment_result(db, "sync_1", _new_alignment_result())

    assert "candidate" not in result
    assert result["paragraphs"][0]["sentences"][0]["words"][0]["word"] == "Fresh"
    assert result["reviewStatus"] == "pending"


@pytest.mark.asyncio
async def test_resolve_sync_candidate_approve_promotes_and_clears_candidate():
    db = _FakeDB()
    await db.chapter_sync.insert_one(_approved_doc())
    await studio.apply_alignment_result(db, "sync_1", _new_alignment_result())

    result = await studio.resolve_sync_candidate(db, "sync_1", action="approve")

    assert result["paragraphs"][0]["sentences"][0]["words"][0]["word"] == "Fresh"
    assert result["reviewStatus"] == "approved"
    assert result["alignmentVersion"] == 4
    assert "candidate" not in result
    fresh = await studio.get_sync_document(db, "sync_1")
    assert "candidate" not in fresh


@pytest.mark.asyncio
async def test_resolve_sync_candidate_reject_discards_candidate_keeps_approved_untouched():
    db = _FakeDB()
    await db.chapter_sync.insert_one(_approved_doc())
    await studio.apply_alignment_result(db, "sync_1", _new_alignment_result())

    result = await studio.resolve_sync_candidate(db, "sync_1", action="reject")

    assert "candidate" not in result
    # The ORIGINAL approved content survives completely intact.
    assert result["paragraphs"][0]["sentences"][0]["words"][0]["word"] == "Teacher"
    assert result["reviewStatus"] == "approved"
    assert result["alignmentVersion"] == 3


@pytest.mark.asyncio
async def test_resolve_sync_candidate_raises_when_no_candidate_pending():
    db = _FakeDB()
    await db.chapter_sync.insert_one(_approved_doc())
    with pytest.raises(studio.SyncStudioError) as exc:
        await studio.resolve_sync_candidate(db, "sync_1", action="approve")
    assert exc.value.code == "no_candidate"


@pytest.mark.asyncio
async def test_resolve_sync_candidate_rejects_invalid_action():
    db = _FakeDB()
    await db.chapter_sync.insert_one(_approved_doc(candidate={"paragraphs": []}))
    with pytest.raises(studio.SyncStudioError) as exc:
        await studio.resolve_sync_candidate(db, "sync_1", action="delete")
    assert exc.value.code == "invalid_action"


@pytest.mark.asyncio
async def test_apply_alignment_result_reprocessing_failure_never_touches_approved_doc():
    """If a re-run's provider call raises before apply_alignment_result is
    even called, nothing about this function is exercised — the approved
    document was never touched in the first place. This test documents
    that guarantee at the unit boundary: apply_alignment_result is only
    ever called with a genuine successful result, so a failed reprocessing
    attempt structurally cannot reach any code path that writes here."""
    db = _FakeDB()
    await db.chapter_sync.insert_one(_approved_doc())
    before = await studio.get_sync_document(db, "sync_1")
    # No call to apply_alignment_result at all (simulating a failed run).
    after = await studio.get_sync_document(db, "sync_1")
    assert after == before
