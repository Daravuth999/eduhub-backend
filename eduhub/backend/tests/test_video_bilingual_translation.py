"""tests/test_video_bilingual_translation.py — Video Library bilingual
(Khmer) translation layer: sync_schema.py's additive `translationKm` field,
sync_studio_tools.apply_sentence_translations, video_ai_provider's Gemini
prompt/response sanitization (normalize_sentence_translations,
sentences_from_sync_document, vocabulary/grammar Khmer fields), and — most
importantly — the karaoke-safety proofs the master directive explicitly
demands: translation can never carry its own timing, can never enter
word_timestamps, and never mutates a sentence's English words/start/end.

Fake DB (_Coll/_FakeDB) mirrors tests/test_sync_foundation.py exactly, kept
as an independent copy per this codebase's convention (test files don't
share fixture modules — see e.g. _FakeBucket duplicated per pipeline test
file) rather than a cross-file import.
"""
from __future__ import annotations

import json

import pytest

import sync_schema as schema
import sync_studio_tools as studio
import video_ai_provider as vap
import video_pipeline_tools as vpt


# ═════════════════════════════════════════════════════════════════════════
# sync_schema.py — translationKm is additive-only, never timing-bearing
# ═════════════════════════════════════════════════════════════════════════
def _words():
    return [
        schema.build_word("Daniel", 0.0, 0.4),
        schema.build_word("emailed", 0.4, 0.9),
    ]


def test_build_sentence_without_translation_is_byte_identical_to_before():
    """No `translation_km` argument at all -> no key, not even translationKm:
    None — every existing caller (Books/EduTalk included) must see zero
    shape change."""
    out = schema.build_sentence("s1", _words())
    assert "translationKm" not in out
    assert out == {
        "id": "s1", "start": 0.0, "end": 0.9, "confidence": {}, "words": _words(),
    }


def test_build_sentence_with_translation_adds_only_translationkm():
    with_km = schema.build_sentence("s1", _words(), translation_km="លោក David បានផ្ញើអ៊ីមែល។")
    without_km = schema.build_sentence("s1", _words())
    without_km_copy = dict(with_km)
    del without_km_copy["translationKm"]
    assert without_km_copy == without_km


def test_build_sentence_empty_string_translation_is_omitted_not_stored_blank():
    out = schema.build_sentence("s1", _words(), translation_km="")
    assert "translationKm" not in out


def test_build_sentence_translation_never_affects_derived_start_end():
    """The whole karaoke-safety guarantee at the schema level: start/end are
    derived from words alone, translation_km has no bearing on them."""
    a = schema.build_sentence("s1", _words())
    b = schema.build_sentence("s1", _words(), translation_km="ការបកប្រែ")
    assert a["start"] == b["start"] == 0.0
    assert a["end"] == b["end"] == 0.9
    assert a["words"] == b["words"]


def test_validate_sync_document_accepts_translationkm_present_or_absent():
    doc = schema.build_sync_document(
        media_ref="gridfs://x", provider_category="speech_recognition", provider_version="v1",
        generated_at="2026-01-01T00:00:00Z", duration_sec=1.0,
        paragraphs=[schema.build_paragraph("p1", [
            schema.build_sentence("s1", _words(), translation_km="មួយ"),
            schema.build_sentence("s2", _words()),
        ])],
    )
    ok, errors = schema.validate_sync_document(doc)
    assert ok, errors


# ═════════════════════════════════════════════════════════════════════════
# sync_studio_tools.apply_sentence_translations
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
        return dict(matches[0])

    async def update_one(self, query, update):
        for d in self.docs:
            if all(d.get(k) == v for k, v in (query or {}).items()):
                if "$set" in update:
                    d.update(update["$set"])
                return _Result(matched_count=1)
        return _Result(matched_count=0)


class _FakeDB:
    def __init__(self):
        self.chapter_sync = _Coll()

    def __getitem__(self, name):
        assert name == studio.CHAPTER_SYNC_COLL
        return self.chapter_sync


def _legacy_doc(sync_id="sync_1", review_status="approved"):
    """A pre-existing, real-shape document with NO translationKm anywhere —
    the exact legacy-lesson shape this whole feature must never break."""
    return {
        "syncId": sync_id,
        "mediaRef": "gridfs://vid_1.mp4",
        "syncVersion": schema.SYNC_VERSION,
        "providerVersion": "gemini-video-asr-v1",
        "alignmentVersion": 1,
        "generatedAt": "2026-01-01T00:00:00Z",
        "approvedAt": None,
        "durationSec": 3.0,
        "providerCategory": "speech_recognition",
        "reviewStatus": review_status,
        "alignmentStatus": "complete",
        "paragraphs": [
            {"id": "p1", "start": 0.0, "end": 1.5, "confidence": {}, "sentences": [
                {"id": "s1", "start": 0.0, "end": 0.9, "confidence": {},
                 "words": [{"word": "Daniel", "start": 0.0, "end": 0.4, "confidence": {}},
                           {"word": "emailed", "start": 0.4, "end": 0.9, "confidence": {}}]},
                {"id": "s2", "start": 0.9, "end": 1.5, "confidence": {},
                 "words": [{"word": "quietly", "start": 0.9, "end": 1.5, "confidence": {}}]},
            ]},
        ],
    }


@pytest.mark.asyncio
async def test_apply_sentence_translations_attaches_km_by_sentence_id():
    db = _FakeDB()
    await db.chapter_sync.insert_one(_legacy_doc())

    result = await studio.apply_sentence_translations(
        db, "sync_1", [{"sentenceId": "s1", "translationKm": "លោក David បានផ្ញើអ៊ីមែល។"}],
    )

    p1 = result["paragraphs"][0]
    assert p1["sentences"][0]["translationKm"] == "លោក David បានផ្ញើអ៊ីមែល។"
    assert "translationKm" not in p1["sentences"][1]  # untargeted sentence untouched


@pytest.mark.asyncio
async def test_apply_sentence_translations_never_touches_words_or_bounds():
    """The core karaoke-safety proof at the write boundary: attaching a
    translation must not change a single word, nor the sentence's own
    start/end, of the sentence it attaches to."""
    db = _FakeDB()
    await db.chapter_sync.insert_one(_legacy_doc())
    before = await studio.get_sync_document(db, "sync_1")
    before_sentence = json.loads(json.dumps(before["paragraphs"][0]["sentences"][0]))

    after = await studio.apply_sentence_translations(
        db, "sync_1", [{"sentenceId": "s1", "translationKm": "ការបកប្រែ"}],
    )
    after_sentence = after["paragraphs"][0]["sentences"][0]

    assert after_sentence["words"] == before_sentence["words"]
    assert after_sentence["start"] == before_sentence["start"]
    assert after_sentence["end"] == before_sentence["end"]


@pytest.mark.asyncio
async def test_apply_sentence_translations_unmatched_sentence_id_silently_skipped():
    db = _FakeDB()
    await db.chapter_sync.insert_one(_legacy_doc())

    result = await studio.apply_sentence_translations(
        db, "sync_1", [{"sentenceId": "s_invented_by_gemini", "translationKm": "should not attach"}],
    )

    for sentence in result["paragraphs"][0]["sentences"]:
        assert "translationKm" not in sentence


@pytest.mark.asyncio
async def test_apply_sentence_translations_empty_list_is_a_safe_noop():
    db = _FakeDB()
    await db.chapter_sync.insert_one(_legacy_doc())

    result = await studio.apply_sentence_translations(db, "sync_1", [])

    for sentence in result["paragraphs"][0]["sentences"]:
        assert "translationKm" not in sentence


@pytest.mark.asyncio
async def test_apply_sentence_translations_missing_sync_document_raises():
    db = _FakeDB()
    with pytest.raises(studio.SyncStudioError):
        await studio.apply_sentence_translations(db, "sync_missing", [{"sentenceId": "s1", "translationKm": "x"}])


@pytest.mark.asyncio
async def test_apply_sentence_translations_bypasses_approved_candidate_staging():
    """Unlike apply_alignment_result, translation is purely additive to
    already-reviewed English text — it must write straight to the top-level
    paragraphs on an approved doc, never stage a sibling candidate."""
    db = _FakeDB()
    await db.chapter_sync.insert_one(_legacy_doc(review_status="approved"))

    result = await studio.apply_sentence_translations(
        db, "sync_1", [{"sentenceId": "s1", "translationKm": "ការបកប្រែ"}],
    )

    assert "candidate" not in result
    fresh = await studio.get_sync_document(db, "sync_1")
    assert fresh["paragraphs"][0]["sentences"][0]["translationKm"] == "ការបកប្រែ"


@pytest.mark.asyncio
async def test_apply_sentence_translations_persists_to_the_stored_document():
    db = _FakeDB()
    await db.chapter_sync.insert_one(_legacy_doc())
    await studio.apply_sentence_translations(db, "sync_1", [{"sentenceId": "s2", "translationKm": "ស្ងាត់ៗ"}])

    stored = db.chapter_sync.docs[0]
    assert stored["paragraphs"][0]["sentences"][1]["translationKm"] == "ស្ងាត់ៗ"
    assert "translationKm" not in stored["paragraphs"][0]["sentences"][0]


# ═════════════════════════════════════════════════════════════════════════
# video_ai_provider.sentences_from_sync_document
# ═════════════════════════════════════════════════════════════════════════
def test_sentences_from_sync_document_extracts_id_and_joined_text():
    doc = _legacy_doc()
    out = vap.sentences_from_sync_document(doc)
    assert out == [
        {"id": "s1", "text": "Daniel emailed"},
        {"id": "s2", "text": "quietly"},
    ]


def test_sentences_from_sync_document_handles_none_and_malformed_input():
    assert vap.sentences_from_sync_document(None) == []
    assert vap.sentences_from_sync_document({}) == []
    assert vap.sentences_from_sync_document({"paragraphs": "not-a-list"}) == []
    assert vap.sentences_from_sync_document({"paragraphs": [{"sentences": "nope"}]}) == []


def test_sentences_from_sync_document_skips_sentences_with_no_words():
    doc = {"paragraphs": [{"sentences": [
        {"id": "s1", "words": []},
        {"id": "s2", "words": [{"word": "Hi", "start": 0.0, "end": 0.1}]},
    ]}]}
    assert vap.sentences_from_sync_document(doc) == [{"id": "s2", "text": "Hi"}]


def test_sentences_from_sync_document_respects_max_sentence_cap():
    sentences = [{"id": f"s{i}", "words": [{"word": "x", "start": 0.0, "end": 0.1}]}
                 for i in range(vap.MAX_TRANSLATION_SENTENCES + 20)]
    doc = {"paragraphs": [{"sentences": sentences}]}
    out = vap.sentences_from_sync_document(doc)
    assert len(out) == vap.MAX_TRANSLATION_SENTENCES


# ═════════════════════════════════════════════════════════════════════════
# video_ai_provider.normalize_sentence_translations — the Gemini-output
# sanitization boundary (directive §19's exact hazard list)
# ═════════════════════════════════════════════════════════════════════════
def test_normalize_sentence_translations_happy_path():
    out = vap.normalize_sentence_translations(
        [{"sentenceId": "s1", "translationKm": "មួយ"}, {"sentenceId": "s2", "translationKm": "ពីរ"}],
        {"s1", "s2"},
    )
    assert out == [{"sentenceId": "s1", "translationKm": "មួយ"}, {"sentenceId": "s2", "translationKm": "ពីរ"}]


def test_normalize_sentence_translations_drops_invented_sentence_id():
    """Gemini's own sentence splitting can diverge from ASR alignment — an
    id that doesn't correspond to a real sentence in THIS lesson must never
    be trusted, or it could attach a translation to the wrong sentence."""
    out = vap.normalize_sentence_translations(
        [{"sentenceId": "s_invented", "translationKm": "should be dropped"}], {"s1", "s2"},
    )
    assert out == []


def test_normalize_sentence_translations_drops_missing_or_empty_fields():
    out = vap.normalize_sentence_translations(
        [
            {"sentenceId": "s1"},  # missing translationKm
            {"translationKm": "no id"},  # missing sentenceId
            {"sentenceId": "s2", "translationKm": ""},  # empty translation
            {"sentenceId": "", "translationKm": "empty id"},
        ],
        {"s1", "s2"},
    )
    assert out == []


def test_normalize_sentence_translations_rejects_non_list_and_non_dict_entries():
    assert vap.normalize_sentence_translations(None, {"s1"}) == []
    assert vap.normalize_sentence_translations("not a list", {"s1"}) == []
    assert vap.normalize_sentence_translations([1, "x", None, {"sentenceId": "s1", "translationKm": "ok"}], {"s1"}) == [
        {"sentenceId": "s1", "translationKm": "ok"},
    ]


def test_normalize_sentence_translations_dedupes_repeated_sentence_id_keeps_first():
    out = vap.normalize_sentence_translations(
        [{"sentenceId": "s1", "translationKm": "first"}, {"sentenceId": "s1", "translationKm": "second"}],
        {"s1"},
    )
    assert out == [{"sentenceId": "s1", "translationKm": "first"}]


def test_normalize_sentence_translations_bounds_excessively_long_text():
    long_km = "ក" * (vap.MAX_TRANSLATION_CHARS + 500)
    out = vap.normalize_sentence_translations([{"sentenceId": "s1", "translationKm": long_km}], {"s1"})
    assert len(out[0]["translationKm"]) == vap.MAX_TRANSLATION_CHARS


def test_normalize_sentence_translations_bounds_total_count():
    valid_ids = {f"s{i}" for i in range(vap.MAX_TRANSLATION_SENTENCES + 50)}
    raw = [{"sentenceId": sid, "translationKm": "x"} for sid in sorted(valid_ids)]
    out = vap.normalize_sentence_translations(raw, valid_ids)
    assert len(out) == vap.MAX_TRANSLATION_SENTENCES


def test_normalize_sentence_translations_never_raises_on_garbage():
    garbage_inputs = [
        {"not": "a list"},
        [{"sentenceId": ["s1"], "translationKm": {"nested": True}}],
        [{"sentenceId": "s1", "translationKm": 12345}],
    ]
    for g in garbage_inputs:
        out = vap.normalize_sentence_translations(g, {"s1"})
        assert isinstance(out, list)


# ═════════════════════════════════════════════════════════════════════════
# video_ai_provider.analyze_transcript — cost-safe single-call translation,
# vocabulary/grammar Khmer fields, and "never a single point of failure"
# ═════════════════════════════════════════════════════════════════════════
@pytest.fixture(autouse=True)
def _no_real_env(monkeypatch):
    monkeypatch.delenv("VIDEO_AI_MODEL", raising=False)
    monkeypatch.delenv("VIDEO_ANALYSIS_MODEL", raising=False)
    monkeypatch.delenv("VIDEO_AI_MOCK", raising=False)


class _FakeHttpResponse:
    def __init__(self, status_code=200, payload=None, text=""):
        self.status_code = status_code
        self._payload = payload or {}
        self.text = text

    def json(self):
        return self._payload


def _gemini_json_response(payload: dict) -> _FakeHttpResponse:
    return _FakeHttpResponse(200, {
        "candidates": [{"content": {"parts": [{"text": json.dumps(payload)}]}}],
    })


class _RecordingGeminiClient:
    def __init__(self, response):
        self.calls: list[dict] = []
        self._response = response

    async def post(self, url, params=None, json=None, **kwargs):
        self.calls.append({"url": url, "body": json})
        return self._response


@pytest.mark.asyncio
async def test_analyze_transcript_mock_path_never_fabricates_translation(monkeypatch):
    monkeypatch.delenv("GEMINI_API_KEY", raising=False)
    result = await vap.analyze_transcript(
        "Daniel emailed quietly.", sentences=[{"id": "s1", "text": "Daniel emailed quietly."}], title="Test",
    )
    assert result["ok"] is True
    assert result["engine"] == "mock"
    assert result["sentenceTranslations"] == []  # no live Gemini -> no invented Khmer


@pytest.mark.asyncio
async def test_analyze_transcript_real_path_returns_sentence_translations_matched_by_id(monkeypatch):
    monkeypatch.setenv("GEMINI_API_KEY", "test-key")
    client = _RecordingGeminiClient(_gemini_json_response({
        "vocabulary": [{"word": "private", "definition": "not shared", "example": "a private email",
                         "meaningKm": "ផ្ទាល់ខ្លួន", "usageKm": "ប្រើនៅពេលនិយាយពីរឿងផ្ទាល់ខ្លួន"}],
        "grammarPoints": [{"point": "Past perfect", "explanation": "had + past participle",
                            "explanationKm": "ប្រើសម្រាប់សកម្មភាពដែលបានកើតឡើងមុនសកម្មភាពមួយផ្សេងទៀតក្នុងអតីតកាល"}],
        "sentenceTranslations": [
            {"sentenceId": "s1", "translationKm": "លោក David បានផ្ញើអ៊ីមែលមួយដោយស្ងាត់ៗ។"},
            {"sentenceId": "s_bogus", "translationKm": "should never survive normalization"},
        ],
    }))

    result = await vap.analyze_transcript(
        "Daniel emailed quietly.",
        sentences=[{"id": "s1", "text": "Daniel emailed quietly."}],
        title="Test", http_client=client,
    )

    assert result["ok"] is True
    assert result["engine"] == "gemini"
    assert result["sentenceTranslations"] == [
        {"sentenceId": "s1", "translationKm": "លោក David បានផ្ញើអ៊ីមែលមួយដោយស្ងាត់ៗ។"},
    ]
    assert result["learning"]["vocabulary"][0]["meaningKm"] == "ផ្ទាល់ខ្លួន"
    assert result["learning"]["grammarPoints"][0]["explanationKm"].startswith("ប្រើ")
    # the sentence ids actually given were embedded in the prompt sent to Gemini
    assert "s1: Daniel emailed quietly." in client.calls[0]["body"]["contents"][0]["parts"][0]["text"]


@pytest.mark.asyncio
async def test_analyze_transcript_without_sentences_still_returns_english_learning(monkeypatch):
    """Omitting `sentences` (e.g. no sync document yet) must not break the
    existing English-only contract — translation generation is simply
    skipped, never a hard failure."""
    monkeypatch.setenv("GEMINI_API_KEY", "test-key")
    client = _RecordingGeminiClient(_gemini_json_response({
        "vocabulary": [{"word": "order", "definition": "ask for", "example": "I order tea."}],
        "grammarPoints": [],
    }))

    result = await vap.analyze_transcript("I order tea.", title="Test", http_client=client)

    assert result["ok"] is True
    assert result["sentenceTranslations"] == []
    assert result["learning"]["vocabulary"][0]["word"] == "order"


@pytest.mark.asyncio
async def test_analyze_transcript_malformed_translation_never_takes_down_english_learning(monkeypatch):
    """Directive §19/§20: malformed Gemini translation output (wrong shape)
    must not sink the English `learning` content — the whole call still
    succeeds, translations just come back empty."""
    monkeypatch.setenv("GEMINI_API_KEY", "test-key")
    client = _RecordingGeminiClient(_gemini_json_response({
        "vocabulary": [{"word": "order", "definition": "ask for", "example": "I order tea."}],
        "grammarPoints": [],
        "sentenceTranslations": "not-a-list-at-all",
    }))

    result = await vap.analyze_transcript(
        "I order tea.", sentences=[{"id": "s1", "text": "I order tea."}], title="Test", http_client=client,
    )

    assert result["ok"] is True
    assert result["sentenceTranslations"] == []
    assert result["learning"]["vocabulary"][0]["word"] == "order"


@pytest.mark.asyncio
async def test_analyze_transcript_provider_http_error_fails_cleanly_without_partial_state(monkeypatch):
    monkeypatch.setenv("GEMINI_API_KEY", "test-key")
    client = _RecordingGeminiClient(_FakeHttpResponse(503, {}, text="overloaded"))

    result = await vap.analyze_transcript(
        "hi", sentences=[{"id": "s1", "text": "hi"}], title="Test", http_client=client,
    )

    assert result["ok"] is False
    assert "learning" not in result
    assert "sentenceTranslations" not in result


# ═════════════════════════════════════════════════════════════════════════
# FULL run_pipeline integration — the karaoke-safety proofs the master
# directive explicitly demands, exercised through the real pipeline code
# path (not just the unit boundaries above): translation ON doesn't change
# timestamps, translation OFF doesn't change timestamps, a translation-
# apply failure never sinks an already-successful English lesson.
# ═════════════════════════════════════════════════════════════════════════
class _Result2:
    def __init__(self, **kw):
        for k, v in kw.items():
            setattr(self, k, v)


def _get_dotted(doc, path):
    cur = doc
    for part in path.split("."):
        if not isinstance(cur, dict):
            return None
        cur = cur.get(part)
    return cur


def _set_dotted(doc, path, value):
    parts = path.split(".")
    cur = doc
    for part in parts[:-1]:
        cur = cur.setdefault(part, {})
    cur[parts[-1]] = value


def _match(doc, query):
    for k, v in query.items():
        if k == "$or":
            if not any(_match(doc, sub) for sub in v):
                return False
            continue
        if isinstance(v, dict) and "$ne" in v:
            if _get_dotted(doc, k) == v["$ne"]:
                return False
            continue
        if isinstance(v, dict) and "$lt" in v:
            actual = _get_dotted(doc, k)
            if actual is None or not (actual < v["$lt"]):
                return False
            continue
        if isinstance(v, dict) and "$in" in v:
            if _get_dotted(doc, k) not in v["$in"]:
                return False
            continue
        if _get_dotted(doc, k) != v:
            return False
    return True


class _LessonColl:
    """Dotted-path fake mirroring test_video_audio_extraction_pipeline.py's
    _Coll — video_lessons needs nested-path $set (pipeline.currentStep) and
    the same $or/$ne/$lt query operators run_pipeline's atomic claim uses."""
    def __init__(self):
        self.docs: dict = {}

    async def insert_one(self, doc):
        self.docs[doc["lessonId"]] = dict(doc)

    async def find_one(self, query, projection=None):
        for doc in self.docs.values():
            if _match(doc, query):
                out = dict(doc)
                if projection and projection.get("_id") == 0:
                    out.pop("_id", None)
                return out
        return None

    async def update_one(self, query, update):
        for doc in self.docs.values():
            if _match(doc, query):
                if "$set" in update:
                    for k, v in update["$set"].items():
                        _set_dotted(doc, k, v)
                if "$push" in update:
                    for k, v in update["$push"].items():
                        each = v.get("$each", [v]) if isinstance(v, dict) else [v]
                        cur = doc.setdefault(k, [])
                        cur.extend(each)
                return _Result2(matched_count=1)
        return _Result2(matched_count=0)

    async def find_one_and_update(self, query, update):
        for doc in self.docs.values():
            if _match(doc, query):
                if "$set" in update:
                    for k, v in update["$set"].items():
                        _set_dotted(doc, k, v)
                return dict(doc)
        return None


class _SyncColl:
    """Flat fake for chapter_sync — matches sync_studio_tools' own
    non-dotted {"syncId": ...} queries exactly."""
    def __init__(self):
        self.docs: list[dict] = []

    async def insert_one(self, doc):
        self.docs.append(dict(doc))

    async def find_one(self, query, projection=None, sort=None):
        matches = [d for d in self.docs if all(d.get(k) == v for k, v in (query or {}).items())]
        return dict(matches[0]) if matches else None

    async def update_one(self, query, update):
        for d in self.docs:
            if all(d.get(k) == v for k, v in (query or {}).items()):
                if "$set" in update:
                    d.update(update["$set"])
                return _Result2(matched_count=1)
        return _Result2(matched_count=0)


class _FullFakeDB:
    def __init__(self):
        self.video_lessons = _LessonColl()
        self.chapter_sync = _SyncColl()

    def __getitem__(self, name):
        if name == vpt.LESSONS_COLL:
            return self.video_lessons
        if name == studio.CHAPTER_SYNC_COLL:
            return self.chapter_sync
        raise AssertionError(f"unexpected collection: {name}")


class _FakeBucket:
    class _GridOut:
        def __init__(self, data, content_type):
            self._data = data
            self.metadata = {"contentType": content_type}

        async def read(self):
            return self._data

    def __init__(self, data: bytes, content_type: str):
        self._data = data
        self._content_type = content_type

    async def open_download_stream_by_name(self, filename):
        return self._GridOut(self._data, self._content_type)


class _RealSegmentProvider:
    """A speech-recognition stub whose `.align()` produces a REAL,
    honestly-timed sync fragment via the same segments_to_sync builder
    Gemini's real path uses — so the sentence ids/words this test asserts
    on are the actual production shape, not a hand-typed fixture."""
    category = "speech_recognition"
    provider_version = "test-asr-v1"

    async def align(self, media_bytes: bytes, content_type: str = "audio/mpeg") -> dict:
        sync = vap.segments_to_sync(
            [
                {"speaker": None, "start": 0.0, "end": 0.9, "text": "Daniel emailed quietly"},
                {"speaker": None, "start": 1.2, "end": 1.8, "text": "Nobody noticed"},
            ],
            provider_category=self.category, provider_version=self.provider_version,
            generated_at="2026-01-01T00:00:00Z",
        )
        return {"sync": sync, "transcriptText": "Daniel emailed quietly. Nobody noticed."}


LESSON2 = {
    "lessonId": "vid_1", "title": "The Wrong Email",
    "mediaRef": "gridfs://sync_media/vid_1.mp3", "syncId": "sync_1",
    "contentType": "audio/mpeg",  # audio-only: skips ffprobe/ffmpeg entirely, no real subprocess needed
}


def _pending_sync_doc():
    return schema.build_sync_document(
        sync_id="sync_1", media_ref=LESSON2["mediaRef"], provider_category="speech_recognition",
        provider_version="none-yet", generated_at="2026-01-01T00:00:00Z", duration_sec=0.0,
        paragraphs=[], review_status="pending",
    )


def _minimal_learning():
    return {
        "vocabulary": [], "grammarPoints": [], "phrasalVerbs": [], "idioms": [],
        "cefr": "B1", "summary": "", "speakerLabels": {},
    }


async def _run_full_pipeline(monkeypatch, *, translations, apply_raises=False):
    db = _FullFakeDB()
    await db.video_lessons.insert_one(dict(LESSON2))
    await db.chapter_sync.insert_one(_pending_sync_doc())
    monkeypatch.setattr(vpt.video_ai_provider, "get_video_ai_provider", lambda: _RealSegmentProvider())

    seen_sentences = {}

    async def _fake_analyze_transcript(transcript_text, *, sentences=None, title=""):
        seen_sentences["sentences"] = sentences
        return {"ok": True, "learning": _minimal_learning(), "sentenceTranslations": translations, "engine": "mock"}

    monkeypatch.setattr(vpt.video_ai_provider, "analyze_transcript", _fake_analyze_transcript)

    if apply_raises:
        async def _boom(db, sync_id, translations):
            raise RuntimeError("simulated translation-apply failure")
        monkeypatch.setattr(vpt.sync_studio_tools, "apply_sentence_translations", _boom)

    pipeline = await vpt.run_pipeline(db, "vid_1", _FakeBucket(b"fake-audio-bytes", "audio/mpeg"))
    sync_doc = await studio.get_sync_document(db, "sync_1")
    return pipeline, sync_doc, seen_sentences


def _all_words(sync_doc):
    return [w for p in sync_doc["paragraphs"] for s in p["sentences"] for w in s["words"]]


@pytest.mark.asyncio
async def test_full_pipeline_translation_on_attaches_km_without_touching_word_timestamps(monkeypatch):
    pipeline, sync_doc, seen = await _run_full_pipeline(
        monkeypatch,
        translations=[
            {"sentenceId": "s1", "translationKm": "លោក David បានផ្ញើអ៊ីមែលមួយដោយស្ងាត់ៗ។"},
            {"sentenceId": "s2", "translationKm": "គ្មាននរណាម្នាក់បានកត់សម្គាល់ឡើយ។"},
        ],
    )

    assert pipeline["state"] == "complete"
    assert pipeline["steps"]["educational_analysis"]["status"] == "complete"
    # Gemini was actually handed the REAL sentence ids/text from this lesson's own sync doc
    assert {s["id"] for s in seen["sentences"]} == {"s1", "s2"}

    sentences = sync_doc["paragraphs"][0]["sentences"]
    assert sentences[0]["translationKm"] == "លោក David បានផ្ញើអ៊ីមែលមួយដោយស្ងាត់ៗ។"
    assert sentences[1]["translationKm"] == "គ្មាននរណាម្នាក់បានកត់សម្គាល់ឡើយ។"

    # The exact karaoke-safety proof: every word's start/end/word text is
    # untouched by attaching a translation, and no word ever carries a
    # translationKm key.
    expected_words = vap.distribute_words("Daniel emailed quietly", 0.0, 0.9) + \
        vap.distribute_words("Nobody noticed", 1.2, 1.8)
    assert _all_words(sync_doc) == expected_words
    for w in _all_words(sync_doc):
        assert "translationKm" not in w


@pytest.mark.asyncio
async def test_full_pipeline_translation_off_leaves_identical_timestamps_as_translation_on(monkeypatch):
    """The exact same ASR output, but Gemini returns zero translations
    (the OFF/unavailable case) — the resulting English word timestamps
    must be byte-identical to the translation-ON run above."""
    _, sync_doc_off, _ = await _run_full_pipeline(monkeypatch, translations=[])

    for sentence in sync_doc_off["paragraphs"][0]["sentences"]:
        assert "translationKm" not in sentence

    expected_words = vap.distribute_words("Daniel emailed quietly", 0.0, 0.9) + \
        vap.distribute_words("Nobody noticed", 1.2, 1.8)
    assert _all_words(sync_doc_off) == expected_words


@pytest.mark.asyncio
async def test_full_pipeline_translation_apply_failure_never_sinks_the_english_lesson(monkeypatch):
    """Directive §19/§20 proven end-to-end: if applying the translation
    raises for any reason, the pipeline must still finish "complete" and
    educational_analysis must still read "complete" — English content
    already succeeded and stands on its own."""
    pipeline, sync_doc, _ = await _run_full_pipeline(
        monkeypatch, translations=[{"sentenceId": "s1", "translationKm": "x"}], apply_raises=True,
    )

    assert pipeline["state"] == "complete"
    assert pipeline["steps"]["educational_analysis"]["status"] == "complete"
    for sentence in sync_doc["paragraphs"][0]["sentences"]:
        assert "translationKm" not in sentence  # the failed apply left English content untouched


@pytest.mark.asyncio
async def test_full_pipeline_mismatched_sentence_id_from_gemini_never_attaches(monkeypatch):
    """An end-to-end proof of the exact hazard directive §19 names by
    example: Gemini invents/mis-copies a sentence id — it must never
    silently attach to the wrong (or any) real sentence."""
    _, sync_doc, _ = await _run_full_pipeline(
        monkeypatch, translations=[{"sentenceId": "s_does_not_exist", "translationKm": "wrong sentence"}],
    )

    for sentence in sync_doc["paragraphs"][0]["sentences"]:
        assert "translationKm" not in sentence
