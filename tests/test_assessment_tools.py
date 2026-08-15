"""tests/test_assessment_tools.py
====================================
AI Assessment / Quiz Submission Lab — schema, scoring, DOCX extraction, and
route-level tests. Self-contained in-memory fakes (same approach as
tests/test_attendance_checkin.py / tests/test_achievement_claims.py).

The REAL_ANSWER_KEY fixture below is the verbatim content of the first
production test fixture supplied for this feature — a 30-item "Long & Short
Sound Listening Challenge" (word -> LONG/SHORT, 0.5 points each, 15 points
total) — not a synthetic placeholder. Using it end-to-end (normalize ->
validate -> score -> extract-from-docx) proves the pipeline against real
content, matching this feature's "no fake data" requirement.
"""
from __future__ import annotations

import asyncio
import copy
import io
import re

import pytest
from pymongo.errors import DuplicateKeyError

import assessment_ai_provider as ai
import assessment_tools as at
from assessment_scoring import score_submission
from assessment_schema import (
    normalize_extracted_answer_key,
    normalize_extracted_submission_answers,
    total_points,
    validate_assessment_document,
    build_assessment_document,
)


def run(c):
    return asyncio.run(c)


# ── real fixture (verbatim from the supplied teacher answer key) ─────────
REAL_ANSWER_KEY_ITEMS = [
    {"no": 1, "prompt": "sheep", "answer": "LONG", "points": 0.5},
    {"no": 2, "prompt": "ship", "answer": "SHORT", "points": 0.5},
    {"no": 3, "prompt": "cheap", "answer": "LONG", "points": 0.5},
    {"no": 4, "prompt": "chip", "answer": "SHORT", "points": 0.5},
    {"no": 5, "prompt": "seat", "answer": "LONG", "points": 0.5},
    {"no": 6, "prompt": "sit", "answer": "SHORT", "points": 0.5},
    {"no": 7, "prompt": "leave", "answer": "LONG", "points": 0.5},
    {"no": 8, "prompt": "live", "answer": "SHORT", "points": 0.5},
    {"no": 9, "prompt": "reach", "answer": "LONG", "points": 0.5},
    {"no": 10, "prompt": "rich", "answer": "SHORT", "points": 0.5},
    {"no": 11, "prompt": "feel", "answer": "LONG", "points": 0.5},
    {"no": 12, "prompt": "fill", "answer": "SHORT", "points": 0.5},
    {"no": 13, "prompt": "pool", "answer": "LONG", "points": 0.5},
    {"no": 14, "prompt": "pull", "answer": "SHORT", "points": 0.5},
    {"no": 15, "prompt": "fool", "answer": "LONG", "points": 0.5},
    {"no": 16, "prompt": "full", "answer": "SHORT", "points": 0.5},
    {"no": 17, "prompt": "food", "answer": "LONG", "points": 0.5},
    {"no": 18, "prompt": "good", "answer": "SHORT", "points": 0.5},
    {"no": 19, "prompt": "boot", "answer": "LONG", "points": 0.5},
    {"no": 20, "prompt": "book", "answer": "SHORT", "points": 0.5},
    {"no": 21, "prompt": "goose", "answer": "LONG", "points": 0.5},
    {"no": 22, "prompt": "look", "answer": "SHORT", "points": 0.5},
    {"no": 23, "prompt": "feet", "answer": "LONG", "points": 0.5},
    {"no": 24, "prompt": "fit", "answer": "SHORT", "points": 0.5},
    {"no": 25, "prompt": "green", "answer": "LONG", "points": 0.5},
    {"no": 26, "prompt": "grin", "answer": "SHORT", "points": 0.5},
    {"no": 27, "prompt": "peach", "answer": "LONG", "points": 0.5},
    {"no": 28, "prompt": "pitch", "answer": "SHORT", "points": 0.5},
    {"no": 29, "prompt": "sleep", "answer": "LONG", "points": 0.5},
    {"no": 30, "prompt": "slip", "answer": "SHORT", "points": 0.5},
]


# ── schema / scoring / docx tests (no fakes needed) ───────────────────────
def test_normalize_real_answer_key_produces_30_questions_worth_15_points():
    questions = normalize_extracted_answer_key(REAL_ANSWER_KEY_ITEMS)
    assert len(questions) == 30
    assert questions[0] == {"qid": "q1", "prompt": "sheep", "correctAnswer": "LONG", "points": 0.5}
    assert questions[-1]["correctAnswer"] == "SHORT"
    assert total_points(questions) == 15.0
    # alternating LONG/SHORT pattern preserved exactly
    for i, q in enumerate(questions):
        expected = "LONG" if i % 2 == 0 else "SHORT"
        assert q["correctAnswer"] == expected


def test_validate_assessment_document_accepts_real_fixture():
    questions = normalize_extracted_answer_key(REAL_ANSWER_KEY_ITEMS)
    doc = build_assessment_document(
        "asmt_test1", "Long & Short Sound Listening Challenge", questions,
        subject="Phonics", status="published", generated_at="2026-08-12T00:00:00Z",
    )
    ok, errors = validate_assessment_document(doc)
    assert ok, errors
    assert doc["totalPoints"] == 15.0


def test_score_submission_all_correct_yields_full_15_points():
    questions = normalize_extracted_answer_key(REAL_ANSWER_KEY_ITEMS)
    known_ids = [q["qid"] for q in questions]
    # Student answered every question correctly (case/whitespace variance,
    # since a real Gemini extraction of handwriting is never byte-exact).
    raw = [{"qid": q["qid"], "answer": f" {q['correctAnswer'].lower()} ", "confidence": 0.95} for q in questions]
    answers = normalize_extracted_submission_answers(raw, known_ids)
    result = score_submission(questions, answers)
    assert result["correct"] == 30
    assert result["total"] == 30
    assert result["scorePct"] == 100.0
    assert result["pointsEarned"] == 15.0
    assert result["needsReview"] is False


def test_score_submission_partial_and_blank_flags_needs_review():
    questions = normalize_extracted_answer_key(REAL_ANSWER_KEY_ITEMS)
    known_ids = [q["qid"] for q in questions]
    # First 20 correct, last 10 left blank (never extracted at all).
    raw = [{"qid": q["qid"], "answer": q["correctAnswer"], "confidence": 0.9} for q in questions[:20]]
    answers = normalize_extracted_submission_answers(raw, known_ids)
    result = score_submission(questions, answers)
    assert result["correct"] == 20
    assert result["pointsEarned"] == 10.0
    assert result["needsReview"] is True  # blanks trigger review
    blank_detail = result["details"][-1]
    assert blank_detail["givenAnswer"] is None
    assert blank_detail["correct"] is False


def test_normalize_submission_answers_drops_unknown_qid_gemini_invents():
    questions = normalize_extracted_answer_key(REAL_ANSWER_KEY_ITEMS[:3])
    known_ids = [q["qid"] for q in questions]
    raw = [
        {"qid": "q1", "answer": "LONG", "confidence": 0.9},
        {"qid": "q99_invented", "answer": "SHORT", "confidence": 0.9},  # not in known_ids
    ]
    answers = normalize_extracted_submission_answers(raw, known_ids)
    assert len(answers) == 1
    assert answers[0]["qid"] == "q1"


def test_extract_docx_text_pulls_table_rows():
    from docx import Document
    doc = Document()
    doc.add_paragraph("Teacher Script & IPA Answer Key")
    table = doc.add_table(rows=1, cols=3)
    table.rows[0].cells[0].text = "No."
    table.rows[0].cells[1].text = "Teacher says"
    table.rows[0].cells[2].text = "Answer"
    for item in REAL_ANSWER_KEY_ITEMS[:3]:
        row = table.add_row()
        row.cells[0].text = str(item["no"])
        row.cells[1].text = item["prompt"]
        row.cells[2].text = item["answer"]
    buf = io.BytesIO()
    doc.save(buf)
    text = at._extract_docx_text(buf.getvalue())
    assert "sheep" in text
    assert "LONG" in text
    assert "ship" in text
    assert "SHORT" in text


def test_mock_extract_answer_key_from_text_is_labeled_mock():
    # No GEMINI_API_KEY configured in the test environment -> mock mode,
    # matching video_ai_provider.py's MockVideoProvider precedent.
    result = run(ai.extract_answer_key(raw_text="1. sheep - LONG\n2. ship - SHORT"))
    assert result["ok"] is True
    assert result["engine"] == "mock"
    assert isinstance(result["items"], list) and result["items"]


# ── route-level fakes ──────────────────────────────────────────────────────
def _match(doc, q):
    for k, v in q.items():
        if k == "$or":
            if not any(_match(doc, sub) for sub in v):
                return False
            continue
        dv = doc.get(k)
        if isinstance(v, dict) and "$in" in v:
            if dv not in v["$in"]:
                return False
        elif dv != v:
            return False
    return True


class _Cursor:
    def __init__(self, d):
        self._d = d

    def sort(self, f, d=1):
        self._d.sort(key=lambda x: x.get(f) or "", reverse=(d == -1))
        return self

    async def to_list(self, n):
        return self._d[:n]


class _Coll:
    def __init__(self):
        self.docs = {}
        self._auto = 0

    async def create_index(self, *a, **k):
        return None

    async def find_one(self, q, p=None):
        for d in self.docs.values():
            if _match(d, q):
                o = copy.deepcopy(d)
                if p and p.get("_id") == 0:
                    o.pop("_id", None)
                return o
        return None

    async def insert_one(self, doc):
        key = (doc.get("submissionId") or doc.get("assessmentId") or doc.get("awardId")
               or doc.get("_id") or f"auto{self._auto}")
        self._auto += 1
        doc.setdefault("_id", key)
        self.docs[key] = copy.deepcopy(doc)
        return type("R", (), {"inserted_id": key})()

    async def update_one(self, q, up, upsert=False):
        for d in self.docs.values():
            if _match(d, q):
                if "$set" in up:
                    d.update(up["$set"])
                return type("R", (), {"matched_count": 1})()
        return type("R", (), {"matched_count": 0})()

    async def delete_one(self, q):
        for k, d in list(self.docs.items()):
            if _match(d, q):
                del self.docs[k]
                return type("R", (), {"deleted_count": 1})()
        return type("R", (), {"deleted_count": 0})()

    def find(self, q, p=None):
        out = []
        for d in self.docs.values():
            if _match(d, q):
                o = copy.deepcopy(d)
                if p and p.get("_id") == 0:
                    o.pop("_id", None)
                out.append(o)
        return _Cursor(out)


class _AwardsColl(_Coll):
    """Enforces the real unique submissionId index."""

    async def insert_one(self, doc):
        for d in self.docs.values():
            if d.get("submissionId") == doc.get("submissionId"):
                raise DuplicateKeyError("duplicate key: submissionId_1")
        return await super().insert_one(doc)


class _DB:
    def __init__(self):
        self._c = {
            at.COLL_ASSESSMENTS: _Coll(),
            at.COLL_SUBMISSIONS: _Coll(),
            at.COLL_AWARDS: _AwardsColl(),
        }

    def __getitem__(self, name):
        return self._c.setdefault(name, _Coll())


class _Router:
    def __init__(self):
        self.routes = {}

    def get(self, p):
        def d(fn):
            self.routes[("GET", p)] = fn
            return fn
        return d

    def post(self, p):
        def d(fn):
            self.routes[("POST", p)] = fn
            return fn
        return d

    def patch(self, p):
        def d(fn):
            self.routes[("PATCH", p)] = fn
            return fn
        return d

    def delete(self, p):
        def d(fn):
            self.routes[("DELETE", p)] = fn
            return fn
        return d


class _Student:
    def __init__(self, sid="stu_alice", clean="stu094"):
        self.student_id = sid
        self.clean_id = clean


class _Admin:
    email = "teacher@example.com"


class _Wallet:
    def __init__(self):
        self.seen = {}
        self.calls = 0
        self.fail = False

    async def credit(self, student_id, amount, *, source, source_ref=None,
                      idempotency_key=None, clean_id=None, **kw):
        self.calls += 1
        if self.fail:
            raise RuntimeError("simulated wallet failure")
        if idempotency_key in self.seen:
            return {"ok": True, "duplicate": True, "balance_after": self.seen[idempotency_key]}
        self.seen[idempotency_key] = amount
        return {"ok": True, "duplicate": False, "balance_after": amount}


class _UploadFile:
    def __init__(self, data: bytes, content_type: str):
        self._data = data
        self.content_type = content_type

    async def read(self):
        return self._data


def _call(router, method, path, **kw):
    return run(router.routes[(method, path)](**kw))


def _build(wallet=None, pushes=None):
    db = _DB()
    router = _Router()
    push_log = pushes if pushes is not None else []

    async def fan_out(query, title, body, url):
        push_log.append({"query": query, "title": title, "body": body, "url": url})
        return (1, 0)

    def build_q(target, ids, group):
        return {"target": target, "studentId": {"$in": list(ids or [])}}

    at.register_assessment_routes(
        router, db, lambda: None, lambda: None,
        wallet=wallet, fan_out_push=fan_out, build_target_query=build_q,
    )
    return db, router, push_log


def _patch_media_storage(monkeypatch):
    """Mocks a SUCCESSFUL R2 store for tests that aren't specifically
    about storage behavior (no real R2 credentials exist in the test
    environment). Matches _store_media's real (media_ref, media_key)
    return shape exactly, so every consumer of it downstream works
    unmodified in tests."""
    async def fake_store_media(raw, ext, content_type, prefix):
        key = at._content_addressed_key(raw, ext, prefix)
        return f"https://fake-r2.example/{key}", key

    monkeypatch.setattr(at, "_store_media", fake_store_media)


def _seed_published_assessment(db, questions=None):
    questions = questions or normalize_extracted_answer_key(REAL_ANSWER_KEY_ITEMS)
    doc = build_assessment_document(
        "asmt_fixed", "Long & Short Sound Listening Challenge", questions,
        subject="Phonics", status="published", generated_at="2026-08-12T00:00:00Z",
    )
    db[at.COLL_ASSESSMENTS].docs[doc["assessmentId"]] = dict(doc)
    return doc


# ── route tests ────────────────────────────────────────────────────────────
def test_admin_create_assessment_and_student_sees_only_published(monkeypatch):
    db, router, _ = _build()
    payload = {
        "title": "Long & Short Sound Listening Challenge",
        "subject": "Phonics",
        "questions": REAL_ANSWER_KEY_ITEMS[:2],
        "publish": False,
    }
    # admin_create_assessment expects build_question-shaped keys; adapt.
    payload["questions"] = [
        {"qid": f"q{i+1}", "prompt": it["prompt"], "correctAnswer": it["answer"], "points": it["points"]}
        for i, it in enumerate(REAL_ANSWER_KEY_ITEMS[:2])
    ]
    created = _call(router, "POST", "/admin/assessments", payload=payload, admin=_Admin())
    assert created["ok"] is True
    assert created["assessment"]["status"] == "draft"

    # draft assessment must not appear to students
    listed = _call(router, "GET", "/student/assessments", student=_Student())
    assert listed["assessments"] == []

    _call(router, "PATCH", "/admin/assessments/{assessment_id}",
          assessment_id=created["assessment"]["assessmentId"],
          payload={"publish": True}, admin=_Admin())
    listed = _call(router, "GET", "/student/assessments", student=_Student())
    assert len(listed["assessments"]) == 1
    assert listed["assessments"][0]["mySubmission"] is None


def test_student_submit_scores_against_real_answer_key(monkeypatch):
    _patch_media_storage(monkeypatch)
    db, router, _ = _build()
    asmt = _seed_published_assessment(db)

    async def fake_extract(media_bytes, content_type, questions):
        # Simulate a real, mostly-correct extraction: everything right
        # except the very last item is misread as the wrong choice.
        answers = [{"qid": q["qid"], "answer": q["correctAnswer"], "confidence": 0.93} for q in questions[:-1]]
        answers.append({"qid": questions[-1]["qid"], "answer": "LONG", "confidence": 0.4})
        return {"ok": True, "answers": answers, "engine": "mock"}

    monkeypatch.setattr(ai, "extract_submission_answers", fake_extract)

    file = _UploadFile(b"fake-jpeg-bytes", "image/jpeg")
    result = _call(
        router, "POST", "/student/assessments/submit",
        assessment_id=asmt["assessmentId"], file=file, student=_Student(),
    )
    assert result["ok"] is True
    sub = result["submission"]
    assert sub["status"] == "needs_review"  # last answer low-confidence
    assert sub["score"]["correct"] == 29
    assert sub["score"]["pointsEarned"] == 14.5
    assert sub["mediaRef"].startswith("https://fake-r2.example/")
    assert sub["mediaKey"]

    # student's own submission history reflects it
    mine = _call(router, "GET", "/student/assessments/submissions", student=_Student())
    assert len(mine["submissions"]) == 1
    assert mine["submissions"][0]["submissionId"] == sub["submissionId"]


def test_student_submit_rejects_unsupported_content_type(monkeypatch):
    _patch_media_storage(monkeypatch)
    db, router, _ = _build()
    asmt = _seed_published_assessment(db)
    file = _UploadFile(b"not-really-a-docx", "application/vnd.openxmlformats-officedocument.wordprocessingml.document")
    with pytest.raises(Exception) as exc_info:
        _call(router, "POST", "/student/assessments/submit",
              assessment_id=asmt["assessmentId"], file=file, student=_Student())
    assert "415" in str(exc_info.value) or "Unsupported" in str(exc_info.value)


def test_admin_correct_submission_recomputes_score(monkeypatch):
    _patch_media_storage(monkeypatch)
    db, router, _ = _build()
    asmt = _seed_published_assessment(db)

    async def fake_extract(media_bytes, content_type, questions):
        # Everything blank at first — an honest "extraction found nothing legible".
        return {"ok": True, "answers": [], "engine": "mock"}

    monkeypatch.setattr(ai, "extract_submission_answers", fake_extract)
    file = _UploadFile(b"bytes", "image/png")
    submitted = _call(router, "POST", "/student/assessments/submit",
                       assessment_id=asmt["assessmentId"], file=file, student=_Student())
    sub_id = submitted["submission"]["submissionId"]
    assert submitted["submission"]["score"]["correct"] == 0

    corrections = [{"qid": q["qid"], "answer": q["correctAnswer"]} for q in asmt["questions"][:5]]
    corrected = _call(router, "POST", "/admin/assessments/submissions/{submission_id}/correct",
                       submission_id=sub_id,
                       payload={"corrections": corrections}, admin=_Admin())
    assert corrected["ok"] is True
    assert corrected["score"]["correct"] == 5
    assert len(corrected["correctedQids"]) == 5

    stored = db[at.COLL_SUBMISSIONS].docs[sub_id]
    assert stored["status"] == "reviewed"
    assert stored["reviewedBy"] == "teacher@example.com"


def test_award_is_idempotent_on_double_click(monkeypatch):
    _patch_media_storage(monkeypatch)
    wallet = _Wallet()
    pushes = []
    db, router, pushes = _build(wallet=wallet, pushes=pushes)
    asmt = _seed_published_assessment(db)

    async def fake_extract(media_bytes, content_type, questions):
        return {"ok": True, "answers": [{"qid": q["qid"], "answer": q["correctAnswer"], "confidence": 0.9}
                                          for q in questions], "engine": "mock"}
    monkeypatch.setattr(ai, "extract_submission_answers", fake_extract)

    file = _UploadFile(b"bytes", "image/png")
    submitted = _call(router, "POST", "/student/assessments/submit",
                       assessment_id=asmt["assessmentId"], file=file, student=_Student())
    sub_id = submitted["submission"]["submissionId"]
    assert submitted["submission"]["score"]["pointsEarned"] == 15.0

    first = _call(router, "POST", "/admin/assessments/submissions/{submission_id}/award",
                  submission_id=sub_id, admin=_Admin())
    assert first["ok"] is True
    assert first["duplicate"] is False
    assert first["points"] == 15.0
    assert wallet.calls == 1
    assert len(pushes) == 1

    second = _call(router, "POST", "/admin/assessments/submissions/{submission_id}/award",
                    submission_id=sub_id, admin=_Admin())
    assert second["ok"] is True
    assert second["duplicate"] is True
    # A DOUBLE AWARD must never move points twice.
    assert wallet.calls == 1
    assert len(pushes) == 1

    assert db[at.COLL_SUBMISSIONS].docs[sub_id]["status"] == "awarded"


def test_bulk_award_awards_each_submission_once(monkeypatch):
    _patch_media_storage(monkeypatch)
    wallet = _Wallet()
    db, router, pushes = _build(wallet=wallet)
    asmt = _seed_published_assessment(db)

    async def fake_extract(media_bytes, content_type, questions):
        return {"ok": True, "answers": [{"qid": q["qid"], "answer": q["correctAnswer"], "confidence": 0.9}
                                          for q in questions], "engine": "mock"}
    monkeypatch.setattr(ai, "extract_submission_answers", fake_extract)

    sub_ids = []
    for sid in ("stu_a", "stu_b", "stu_c"):
        file = _UploadFile(b"bytes", "image/png")
        submitted = _call(router, "POST", "/student/assessments/submit",
                           assessment_id=asmt["assessmentId"], file=file, student=_Student(sid, sid))
        sub_ids.append(submitted["submission"]["submissionId"])

    result = _call(router, "POST", "/admin/assessments/submissions/bulk-award",
                    payload={"submissionIds": sub_ids}, admin=_Admin())
    assert result["ok"] is True
    assert result["awarded"] == 3
    assert result["failed"] == 0
    assert wallet.calls == 3
    for sid in sub_ids:
        assert db[at.COLL_SUBMISSIONS].docs[sid]["status"] == "awarded"


def test_award_without_wallet_configured_fails_cleanly(monkeypatch):
    _patch_media_storage(monkeypatch)
    db, router, _ = _build(wallet=None)
    asmt = _seed_published_assessment(db)

    async def fake_extract(media_bytes, content_type, questions):
        return {"ok": True, "answers": [], "engine": "mock"}
    monkeypatch.setattr(ai, "extract_submission_answers", fake_extract)

    file = _UploadFile(b"bytes", "image/png")
    submitted = _call(router, "POST", "/student/assessments/submit",
                       assessment_id=asmt["assessmentId"], file=file, student=_Student())
    sub_id = submitted["submission"]["submissionId"]

    with pytest.raises(Exception) as exc_info:
        _call(router, "POST", "/admin/assessments/submissions/{submission_id}/award",
              submission_id=sub_id, admin=_Admin())
    assert "wallet_unavailable" in str(exc_info.value) or "502" in str(exc_info.value)


# ── R2-only storage correction (2026-08): no GridFS/local-disk fallback ────
def test_no_gridfs_fallback_exists_anywhere_in_the_module():
    """The module must not even HAVE a GridFS code path any more — not
    just "unused", genuinely removed."""
    assert not hasattr(at, "get_media_bucket")
    assert not hasattr(at, "MEDIA_GRIDFS_BUCKET")
    assert "GridFSBucket" not in open(at.__file__, encoding="utf-8").read()


def test_content_addressed_key_is_deterministic_by_bytes_and_scoped_by_prefix():
    raw_a = b"identical worksheet photo bytes"
    raw_b = b"a completely different photo"
    key1 = at._content_addressed_key(raw_a, "png", "stu094")
    key2 = at._content_addressed_key(raw_a, "png", "stu094")
    assert key1 == key2  # same bytes, same prefix -> same key every time

    key_other_student = at._content_addressed_key(raw_a, "png", "stu095")
    assert key_other_student != key1  # scoped by prefix, not a global dedupe

    key_diff_bytes = at._content_addressed_key(raw_b, "png", "stu094")
    assert key_diff_bytes != key1  # different content -> different key
    assert key1.startswith("assessment-media/stu094/")
    assert key1.endswith(".png")


def test_store_media_raises_and_never_falls_back_when_r2_unavailable(monkeypatch):
    async def fake_upload_returns_none(raw, key, content_type):
        return None
    monkeypatch.setattr(at, "_upload_media_to_r2", fake_upload_returns_none)

    with pytest.raises(at.SubmissionStorageError):
        run(at._store_media(b"raw-bytes", "png", "image/png", "stu094"))


def test_submit_route_fails_honestly_with_no_fallback_when_r2_unavailable(monkeypatch):
    """R2 down (or unconfigured) must surface as a clean, retryable error —
    and must NEVER create an orphaned submission doc referencing a file
    that doesn't actually exist anywhere."""
    db, router, _ = _build()
    asmt = _seed_published_assessment(db)

    async def fake_upload_returns_none(raw, key, content_type):
        return None
    monkeypatch.setattr(at, "_upload_media_to_r2", fake_upload_returns_none)

    file = _UploadFile(b"worksheet-bytes", "image/png")
    with pytest.raises(Exception) as exc_info:
        _call(router, "POST", "/student/assessments/submit",
              assessment_id=asmt["assessmentId"], file=file, student=_Student())
    assert "503" in str(exc_info.value) or "temporarily unavailable" in str(exc_info.value)
    # No fallback write happened anywhere — the submission collection is
    # exactly as empty as before the failed attempt.
    assert db[at.COLL_SUBMISSIONS].docs == {}


def test_upload_to_r2_skips_put_when_content_addressed_object_already_exists(monkeypatch):
    """Proves the HEAD-before-PUT dedupe: retrying an upload of IDENTICAL
    bytes must not re-transfer/duplicate the object."""
    from botocore.exceptions import ClientError

    monkeypatch.setenv("R2_ACCOUNT_ID", "acct")
    monkeypatch.setenv("R2_ACCESS_KEY_ID", "key")
    monkeypatch.setenv("R2_SECRET_ACCESS_KEY", "secret")
    monkeypatch.setenv("R2_BUCKET_NAME", "bucket")
    monkeypatch.setenv("R2_PUBLIC_URL", "https://cdn.example.com")

    calls = {"head": 0, "put": 0}

    class _FakeClientAlreadyExists:
        def head_object(self, **kw):
            calls["head"] += 1
            return {}  # exists — no ClientError raised

        def put_object(self, **kw):
            calls["put"] += 1

    import boto3
    monkeypatch.setattr(boto3, "client", lambda *a, **kw: _FakeClientAlreadyExists())

    url = run(at._upload_media_to_r2(b"bytes", "assessment-media/stu094/abc.png", "image/png"))
    assert url == "https://cdn.example.com/assessment-media/stu094/abc.png"
    assert calls["head"] == 1
    assert calls["put"] == 0  # skipped — object already there, not duplicated


def test_upload_to_r2_puts_when_object_does_not_yet_exist(monkeypatch):
    from botocore.exceptions import ClientError

    monkeypatch.setenv("R2_ACCOUNT_ID", "acct")
    monkeypatch.setenv("R2_ACCESS_KEY_ID", "key")
    monkeypatch.setenv("R2_SECRET_ACCESS_KEY", "secret")
    monkeypatch.setenv("R2_BUCKET_NAME", "bucket")
    monkeypatch.setenv("R2_PUBLIC_URL", "https://cdn.example.com")

    calls = {"head": 0, "put": 0}

    class _FakeClientNotFound:
        def head_object(self, **kw):
            calls["head"] += 1
            raise ClientError({"Error": {"Code": "404", "Message": "Not Found"}}, "HeadObject")

        def put_object(self, **kw):
            calls["put"] += 1

    import boto3
    monkeypatch.setattr(boto3, "client", lambda *a, **kw: _FakeClientNotFound())

    url = run(at._upload_media_to_r2(b"bytes", "assessment-media/stu094/new.png", "image/png"))
    assert url == "https://cdn.example.com/assessment-media/stu094/new.png"
    assert calls["head"] == 1
    assert calls["put"] == 1


def test_delete_submission_deletes_r2_object_and_mongo_doc(monkeypatch):
    _patch_media_storage(monkeypatch)
    db, router, _ = _build()
    asmt = _seed_published_assessment(db)

    async def fake_extract(media_bytes, content_type, questions):
        return {"ok": True, "answers": [], "engine": "mock"}
    monkeypatch.setattr(ai, "extract_submission_answers", fake_extract)

    file = _UploadFile(b"bytes", "image/png")
    submitted = _call(router, "POST", "/student/assessments/submit",
                       assessment_id=asmt["assessmentId"], file=file, student=_Student())
    sub_id = submitted["submission"]["submissionId"]
    assert sub_id in db[at.COLL_SUBMISSIONS].docs

    deleted_keys = []
    async def fake_delete(key):
        deleted_keys.append(key)
        return True
    monkeypatch.setattr(at, "_delete_media_from_r2", fake_delete)

    result = _call(router, "DELETE", "/admin/assessments/submissions/{submission_id}",
                    submission_id=sub_id, admin=_Admin())
    assert result["ok"] is True
    assert result["mediaDeleted"] is True
    assert deleted_keys == [submitted["submission"]["mediaKey"]]
    assert sub_id not in db[at.COLL_SUBMISSIONS].docs


def test_delete_submission_blocked_once_already_awarded(monkeypatch):
    _patch_media_storage(monkeypatch)
    wallet = _Wallet()
    db, router, _ = _build(wallet=wallet)
    asmt = _seed_published_assessment(db)

    async def fake_extract(media_bytes, content_type, questions):
        return {"ok": True, "answers": [{"qid": q["qid"], "answer": q["correctAnswer"], "confidence": 0.9}
                                          for q in questions], "engine": "mock"}
    monkeypatch.setattr(ai, "extract_submission_answers", fake_extract)

    file = _UploadFile(b"bytes", "image/png")
    submitted = _call(router, "POST", "/student/assessments/submit",
                       assessment_id=asmt["assessmentId"], file=file, student=_Student())
    sub_id = submitted["submission"]["submissionId"]
    _call(router, "POST", "/admin/assessments/submissions/{submission_id}/award",
          submission_id=sub_id, admin=_Admin())
    assert db[at.COLL_SUBMISSIONS].docs[sub_id]["status"] == "awarded"

    with pytest.raises(Exception) as exc_info:
        _call(router, "DELETE", "/admin/assessments/submissions/{submission_id}",
              submission_id=sub_id, admin=_Admin())
    assert "409" in str(exc_info.value) or "already been awarded" in str(exc_info.value) or "already awarded" in str(exc_info.value)
    # The submission — the audit trail for the real point credit — must survive.
    assert sub_id in db[at.COLL_SUBMISSIONS].docs


# ── 2026-08 production incident regression: real 15/30 -> 7.5/15 flow ─────
# A real student submission on the live "Long & Short Sound Listening
# Challenge" assessment scored 0/30 despite a genuinely ~15/30-correct
# worksheet. This suite proves the FULL lifecycle — submit -> score ->
# Author Studio visibility -> award -> idempotent double-award -> the new
# extraction diagnostic metadata — using a MIXED (not all-correct,
# not all-wrong) extraction result built from the real answer key, exactly
# matching the reported scenario's shape.
def _mixed_extraction_15_of_30(questions):
    """15 correct, 15 wrong — flips every SECOND question's answer to the
    other real vocabulary value (LONG<->SHORT), never a placeholder."""
    out = []
    for i, q in enumerate(questions):
        correct = q["correctAnswer"]
        given = correct if i % 2 == 0 else ("SHORT" if correct == "LONG" else "LONG")
        out.append({"qid": q["qid"], "answer": given, "confidence": 0.93})
    return out


def test_real_15_of_30_submission_flows_through_the_full_lifecycle(monkeypatch):
    _patch_media_storage(monkeypatch)
    wallet = _Wallet()
    db, router, pushes = _build(wallet=wallet)
    asmt = _seed_published_assessment(db)

    async def fake_extract(media_bytes, content_type, questions):
        return {"ok": True, "answers": _mixed_extraction_15_of_30(questions), "engine": "gemini"}
    monkeypatch.setattr(ai, "extract_submission_answers", fake_extract)

    file = _UploadFile(b"real-worksheet-bytes", "image/jpeg")
    submitted = _call(router, "POST", "/student/assessments/submit",
                       assessment_id=asmt["assessmentId"], file=file, student=_Student())
    sub = submitted["submission"]
    assert sub["score"]["correct"] == 15
    assert sub["score"]["total"] == 30
    assert sub["score"]["pointsEarned"] == 7.5
    assert sub["status"] == "scored"
    # New diagnostic: Gemini genuinely returned 30 answers and all 30
    # survived the qid whitelist — distinguishes "extracted but half
    # wrong" from "extracted nothing" for exactly this failure class.
    # (Meta now also persists model/extractedAt/verification — audit trail.)
    assert sub["extraction"]["engine"] == "gemini"
    assert sub["extraction"]["rawAnswerCount"] == 30
    assert sub["extraction"]["normalizedAnswerCount"] == 30
    assert "extractedAt" in sub["extraction"]

    # Visible to Author Studio via the SAME query path production uses.
    listed = _call(router, "GET", "/admin/assessments/{assessment_id}/submissions",
                    assessment_id=asmt["assessmentId"], status=None, admin=_Admin())
    assert len(listed["submissions"]) == 1
    assert listed["submissions"][0]["score"]["pointsEarned"] == 7.5
    # Per-question breakdown is real and persisted, not fabricated —
    # exactly what Author Studio needs to render a given-vs-correct table.
    details = listed["submissions"][0]["score"]["details"]
    assert len(details) == 30
    assert sum(1 for d in details if d["correct"]) == 15

    sub_id = sub["submissionId"]
    award = _call(router, "POST", "/admin/assessments/submissions/{submission_id}/award",
                  submission_id=sub_id, admin=_Admin())
    assert award["points"] == 7.5
    assert wallet.calls == 1
    assert len(pushes) == 1

    # Idempotent: a second click must NOT award a second time.
    award2 = _call(router, "POST", "/admin/assessments/submissions/{submission_id}/award",
                   submission_id=sub_id, admin=_Admin())
    assert award2["duplicate"] is True
    assert wallet.calls == 1
    assert len(pushes) == 1


def test_extraction_failure_never_fabricates_a_score(monkeypatch):
    """Case: Gemini extraction itself fails (ok:false). Must land on
    status='failed' with NO score field — never a fabricated 0 that looks
    like a real (but wrong) grading result."""
    _patch_media_storage(monkeypatch)
    db, router, _ = _build()
    asmt = _seed_published_assessment(db)

    async def fake_extract_fails(media_bytes, content_type, questions):
        return {"ok": False, "reason": "provider_rejected: Gemini HTTP 500"}
    monkeypatch.setattr(ai, "extract_submission_answers", fake_extract_fails)

    file = _UploadFile(b"bytes", "image/png")
    result = _call(router, "POST", "/student/assessments/submit",
                    assessment_id=asmt["assessmentId"], file=file, student=_Student())
    assert result["submission"]["status"] == "failed"
    assert result["submission"].get("score") is None
    assert "extractionError" in result
    assert db[at.COLL_SUBMISSIONS].docs[result["submission"]["submissionId"]]["status"] == "failed"


def test_submitting_to_a_nonexistent_assessment_is_rejected_honestly(monkeypatch):
    _patch_media_storage(monkeypatch)
    db, router, _ = _build()
    file = _UploadFile(b"bytes", "image/png")
    with pytest.raises(Exception) as exc_info:
        _call(router, "POST", "/student/assessments/submit",
              assessment_id="asmt_does_not_exist", file=file, student=_Student())
    assert "404" in str(exc_info.value) or "not found" in str(exc_info.value).lower()


def test_duplicate_submission_is_rejected_before_creating_a_second_live_record(monkeypatch):
    """A double-tap or retried request must never create a second
    submission for the same (assessment, student) — the award endpoint is
    keyed by submissionId, so two live submissions would each be
    independently awardable, a real double-payment risk."""
    _patch_media_storage(monkeypatch)
    db, router, _ = _build()
    asmt = _seed_published_assessment(db)

    async def fake_extract(media_bytes, content_type, questions):
        return {"ok": True, "answers": [{"qid": q["qid"], "answer": q["correctAnswer"], "confidence": 0.9}
                                          for q in questions], "engine": "gemini"}
    monkeypatch.setattr(ai, "extract_submission_answers", fake_extract)

    file1 = _UploadFile(b"bytes", "image/png")
    first = _call(router, "POST", "/student/assessments/submit",
                  assessment_id=asmt["assessmentId"], file=file1, student=_Student())
    assert first["submission"]["status"] == "scored"

    file2 = _UploadFile(b"bytes2", "image/png")
    with pytest.raises(Exception) as exc_info:
        _call(router, "POST", "/student/assessments/submit",
              assessment_id=asmt["assessmentId"], file=file2, student=_Student())
    assert "409" in str(exc_info.value) or "already submitted" in str(exc_info.value).lower()
    # Exactly one submission exists for this (assessment, student).
    assert len(db[at.COLL_SUBMISSIONS].docs) == 1


def test_resubmission_after_a_failed_extraction_is_allowed(monkeypatch):
    """A 'failed' submission is the one case resubmission must be allowed
    — the student never got a real result the first time."""
    _patch_media_storage(monkeypatch)
    db, router, _ = _build()
    asmt = _seed_published_assessment(db)

    call_count = {"n": 0}

    async def fake_extract(media_bytes, content_type, questions):
        call_count["n"] += 1
        if call_count["n"] == 1:
            return {"ok": False, "reason": "bad_response"}
        return {"ok": True, "answers": [{"qid": q["qid"], "answer": q["correctAnswer"], "confidence": 0.9}
                                          for q in questions], "engine": "gemini"}
    monkeypatch.setattr(ai, "extract_submission_answers", fake_extract)

    file1 = _UploadFile(b"bytes", "image/png")
    first = _call(router, "POST", "/student/assessments/submit",
                  assessment_id=asmt["assessmentId"], file=file1, student=_Student())
    assert first["submission"]["status"] == "failed"

    file2 = _UploadFile(b"bytes2", "image/png")
    second = _call(router, "POST", "/student/assessments/submit",
                   assessment_id=asmt["assessmentId"], file=file2, student=_Student())
    assert second["submission"]["status"] == "scored"
    assert len(db[at.COLL_SUBMISSIONS].docs) == 2


def test_vocabulary_mismatched_extraction_scores_zero_but_diagnostic_reveals_data_was_received(monkeypatch):
    """The exact shape of the reported production incident: Gemini
    confidently (high confidence, every qid present) extracts something
    that doesn't match the answer key's vocabulary at all — must score 0
    honestly (never inflated), but the extraction diagnostic must prove
    data WAS received (rawAnswerCount=30), distinguishing this from "Gemini
    returned nothing"."""
    _patch_media_storage(monkeypatch)
    db, router, _ = _build()
    asmt = _seed_published_assessment(db)

    async def fake_extract_wrong_vocab(media_bytes, content_type, questions):
        # Echoes the PROMPT word instead of the LONG/SHORT classification —
        # the exact failure mode _answer_vocabulary_hint now guards against.
        return {"ok": True, "answers": [{"qid": q["qid"], "answer": q["prompt"], "confidence": 0.95}
                                          for q in questions], "engine": "gemini"}
    monkeypatch.setattr(ai, "extract_submission_answers", fake_extract_wrong_vocab)

    file = _UploadFile(b"bytes", "image/png")
    result = _call(router, "POST", "/student/assessments/submit",
                    assessment_id=asmt["assessmentId"], file=file, student=_Student())
    sub = result["submission"]
    assert sub["score"]["correct"] == 0
    assert sub["status"] == "scored"  # high confidence throughout -> not needs_review
    assert sub["extraction"]["rawAnswerCount"] == 30
    assert sub["extraction"]["normalizedAnswerCount"] == 30
    # The per-question detail proves exactly what was wrong — visible data,
    # not a silent zero.
    first_detail = sub["score"]["details"][0]
    assert first_detail["givenAnswer"] == "sheep"
    assert first_detail["correctAnswer"] == "LONG"


# ── production incident: "AWARDED" shown but student's visible points ─────
# never moved (2026-08). Root cause: WalletService.credit() — the real,
# canonical points ledger — succeeded correctly (confirmed by inspecting
# it against achievement_tools.py's identical, proven pattern), but the
# DEFAULT student-facing points display (usePoints.ts) polls the LEGACY
# GAS-backed balance, not points_wallets, unless REACT_APP_USE_RENDER_POINTS
# is explicitly flagged on. A Mongo-only credit is real but invisible
# there. These tests cover the fix: a best-effort legacy-visibility bridge
# (the SAME proven action=sendPoints treasury->student GAS call already
# used in production by Speaking Lab's /points/grant), which — critically —
# never blocks or reverses the wallet credit if it fails, and is always
# recorded honestly rather than silently assumed to have worked.
def _build_with_gas(monkeypatch, wallet=None, gas_ok=True, gas_error="GAS unreachable"):
    db, router, pushes = _build(wallet=wallet)
    calls = []

    async def fake_gas_sync(clean_id, points, *, gas_url, treasury_id, treasury_password):
        calls.append({"clean_id": clean_id, "points": points})
        return (gas_ok, "" if gas_ok else gas_error)

    monkeypatch.setattr(at, "_sync_award_to_gas", fake_gas_sync)
    return db, router, pushes, calls


def test_award_success_persists_wallet_proof_and_gas_sync_outcome_on_the_submission(monkeypatch):
    _patch_media_storage(monkeypatch)
    wallet = _Wallet()
    db, router, pushes, gas_calls = _build_with_gas(monkeypatch, wallet=wallet, gas_ok=True)
    asmt = _seed_published_assessment(db)

    async def fake_extract(media_bytes, content_type, questions):
        return {"ok": True, "answers": [{"qid": q["qid"], "answer": q["correctAnswer"], "confidence": 0.9}
                                          for q in questions], "engine": "mock"}
    monkeypatch.setattr(ai, "extract_submission_answers", fake_extract)

    file = _UploadFile(b"bytes", "image/png")
    submitted = _call(router, "POST", "/student/assessments/submit",
                       assessment_id=asmt["assessmentId"], file=file, student=_Student())
    sub_id = submitted["submission"]["submissionId"]

    result = _call(router, "POST", "/admin/assessments/submissions/{submission_id}/award",
                    submission_id=sub_id, admin=_Admin())
    assert result["ok"] is True
    assert result["pointsCredited"] == 15.0
    assert result["balanceAfter"] == 15.0  # _Wallet's fake balance_after == amount credited
    assert result["gasSynced"] is True
    assert len(gas_calls) == 1
    assert gas_calls[0]["clean_id"] == "stu094"  # _Student()'s clean_id
    assert gas_calls[0]["points"] == 15.0
    assert len(pushes) == 1

    stored = db[at.COLL_SUBMISSIONS].docs[sub_id]
    assert stored["status"] == "awarded"
    assert stored["award"]["pointsCredited"] == 15.0
    assert stored["award"]["balanceAfter"] == 15.0
    assert stored["award"]["gasSynced"] is True
    assert stored["award"]["notifiedAt"] is not None


def test_gas_sync_failure_never_blocks_or_reverses_the_real_wallet_credit(monkeypatch):
    """The exact reported production symptom's honest resolution: the
    wallet credit (the real, canonical points mutation) already succeeded
    by the time the legacy GAS bridge is even attempted — its failure
    must never undo that, never raise, and never silently claim success."""
    _patch_media_storage(monkeypatch)
    wallet = _Wallet()
    db, router, pushes, gas_calls = _build_with_gas(
        monkeypatch, wallet=wallet, gas_ok=False, gas_error="GAS unreachable",
    )
    asmt = _seed_published_assessment(db)

    async def fake_extract(media_bytes, content_type, questions):
        return {"ok": True, "answers": [{"qid": q["qid"], "answer": q["correctAnswer"], "confidence": 0.9}
                                          for q in questions], "engine": "mock"}
    monkeypatch.setattr(ai, "extract_submission_answers", fake_extract)

    file = _UploadFile(b"bytes", "image/png")
    submitted = _call(router, "POST", "/student/assessments/submit",
                       assessment_id=asmt["assessmentId"], file=file, student=_Student())
    sub_id = submitted["submission"]["submissionId"]

    result = _call(router, "POST", "/admin/assessments/submissions/{submission_id}/award",
                    submission_id=sub_id, admin=_Admin())
    # The award itself is still successful — the REAL ledger (WalletService)
    # was credited; only the legacy-visibility bridge failed.
    assert result["ok"] is True
    assert wallet.calls == 1
    assert result["balanceAfter"] == 15.0
    assert result["gasSynced"] is False
    assert "GAS unreachable" in result["gasSyncError"]

    stored = db[at.COLL_SUBMISSIONS].docs[sub_id]
    assert stored["status"] == "awarded"  # never blocked by the GAS failure
    assert stored["award"]["gasSynced"] is False
    assert "GAS unreachable" in stored["award"]["gasSyncError"]
    # A push notification is STILL sent — the real credit succeeded.
    assert len(pushes) == 1


def test_retry_gas_sync_resyncs_without_ever_recrediting_the_wallet(monkeypatch):
    _patch_media_storage(monkeypatch)
    wallet = _Wallet()
    db, router, pushes, gas_calls = _build_with_gas(monkeypatch, wallet=wallet, gas_ok=False)
    asmt = _seed_published_assessment(db)

    async def fake_extract(media_bytes, content_type, questions):
        return {"ok": True, "answers": [{"qid": q["qid"], "answer": q["correctAnswer"], "confidence": 0.9}
                                          for q in questions], "engine": "mock"}
    monkeypatch.setattr(ai, "extract_submission_answers", fake_extract)

    file = _UploadFile(b"bytes", "image/png")
    submitted = _call(router, "POST", "/student/assessments/submit",
                       assessment_id=asmt["assessmentId"], file=file, student=_Student())
    sub_id = submitted["submission"]["submissionId"]

    first = _call(router, "POST", "/admin/assessments/submissions/{submission_id}/award",
                  submission_id=sub_id, admin=_Admin())
    assert first["gasSynced"] is False
    assert wallet.calls == 1

    # GAS recovers — teacher clicks "Retry sync".
    async def fake_gas_sync_now_ok(clean_id, points, *, gas_url, treasury_id, treasury_password):
        gas_calls.append({"clean_id": clean_id, "points": points})
        return (True, "")
    monkeypatch.setattr(at, "_sync_award_to_gas", fake_gas_sync_now_ok)

    retried = _call(router, "POST", "/admin/assessments/submissions/{submission_id}/retry-gas-sync",
                     submission_id=sub_id, admin=_Admin())
    assert retried["ok"] is True
    assert retried["gasSynced"] is True
    # The wallet must NEVER be credited a second time by a sync retry.
    assert wallet.calls == 1

    stored = db[at.COLL_SUBMISSIONS].docs[sub_id]
    assert stored["award"]["gasSynced"] is True


def test_retry_gas_sync_rejects_a_submission_that_was_never_awarded(monkeypatch):
    _patch_media_storage(monkeypatch)
    db, router, pushes, gas_calls = _build_with_gas(monkeypatch, wallet=_Wallet())
    asmt = _seed_published_assessment(db)

    async def fake_extract(media_bytes, content_type, questions):
        return {"ok": True, "answers": [], "engine": "mock"}
    monkeypatch.setattr(ai, "extract_submission_answers", fake_extract)

    file = _UploadFile(b"bytes", "image/png")
    submitted = _call(router, "POST", "/student/assessments/submit",
                       assessment_id=asmt["assessmentId"], file=file, student=_Student())
    sub_id = submitted["submission"]["submissionId"]

    with pytest.raises(Exception) as exc_info:
        _call(router, "POST", "/admin/assessments/submissions/{submission_id}/retry-gas-sync",
              submission_id=sub_id, admin=_Admin())
    assert "409" in str(exc_info.value) or "not been awarded" in str(exc_info.value)


def test_admin_submission_list_resolves_real_student_display_name(monkeypatch):
    """Author Studio's submission list must show WHO a worksheet belongs
    to — a raw studentId/cleanId code is not enough for a teacher to
    recognize a student. Resolved from db.students (the same collection
    attendance_tools.py/tuition_tools.py already join against), batched
    for the whole page — never a fabricated or guessed name."""
    _patch_media_storage(monkeypatch)
    db, router, pushes = _build(wallet=_Wallet())
    asmt = _seed_published_assessment(db)
    db["students"].docs["s1"] = {
        "student_id": "stu_alice", "clean_id": "stu094", "display_name": "Alice Chan",
    }

    async def fake_extract(media_bytes, content_type, questions):
        return {"ok": True, "answers": [], "engine": "mock"}
    monkeypatch.setattr(ai, "extract_submission_answers", fake_extract)

    file = _UploadFile(b"bytes", "image/png")
    _call(router, "POST", "/student/assessments/submit",
          assessment_id=asmt["assessmentId"], file=file, student=_Student())

    listed = _call(router, "GET", "/admin/assessments/{assessment_id}/submissions",
                    assessment_id=asmt["assessmentId"], status=None, admin=_Admin())
    assert len(listed["submissions"]) == 1
    assert listed["submissions"][0]["studentName"] == "Alice Chan"


def test_admin_submission_list_never_fabricates_a_name_for_an_unknown_student(monkeypatch):
    _patch_media_storage(monkeypatch)
    db, router, pushes = _build(wallet=_Wallet())
    asmt = _seed_published_assessment(db)
    # No matching row in db.students at all — the submission's studentId/
    # cleanId genuinely has no resolvable name.

    async def fake_extract(media_bytes, content_type, questions):
        return {"ok": True, "answers": [], "engine": "mock"}
    monkeypatch.setattr(ai, "extract_submission_answers", fake_extract)

    file = _UploadFile(b"bytes", "image/png")
    _call(router, "POST", "/student/assessments/submit",
          assessment_id=asmt["assessmentId"], file=file, student=_Student())

    listed = _call(router, "GET", "/admin/assessments/{assessment_id}/submissions",
                    assessment_id=asmt["assessmentId"], status=None, admin=_Admin())
    assert not listed["submissions"][0].get("studentName")
    # The raw identity codes must still be present as the honest fallback.
    assert listed["submissions"][0]["cleanId"] == "stu094"


def test_real_gas_sync_helper_rounds_fractional_points_and_never_raises():
    """assessment scoring supports 0.5-point increments (0.5/question);
    GAS's legacy points ledger is integer-based (mirrors Speaking Lab's own
    /points/grant contract) — the sync helper must round for THIS leg only
    and never raise, even with no config at all."""
    ok, err = run(at._sync_award_to_gas(
        "stu094", 7.5, gas_url=None, treasury_id=None, treasury_password=None,
    ))
    assert ok is False
    assert err == "gas_sync_not_configured"
