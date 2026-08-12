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


async def _fake_bucket_factory():
    class _Bucket:
        async def upload_from_stream(self, filename, stream, metadata=None):
            return None
    return _Bucket()


def _patch_media_storage(monkeypatch):
    """No R2 env vars are set in the test environment, so _upload_media_to_r2
    already returns None (real code path, not mocked) — only GridFS's real
    Motor bucket needs a fake, since the test DB isn't a real Motor client."""
    async def fake_get_bucket(db):
        class _Bucket:
            async def upload_from_stream(self, filename, stream, metadata=None):
                return None
        return _Bucket()

    async def fake_store_media(db, raw, ext, content_type, prefix):
        return f"gridfs://assessment_media/{prefix}-{ext}"

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
    assert sub["mediaRef"].startswith("gridfs://")

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
