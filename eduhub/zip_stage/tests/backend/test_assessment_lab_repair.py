"""tests/test_assessment_lab_repair.py — regression suite for the 2026-08
Assessment Lab surgical repair.

Covers the required regression cases from the repair specification:
perfect score, explicit blanks, Gemini false negative + teacher correction,
uncertain-mark resolution, question alignment (one unreadable question must
never shift its neighbors), multiple corrections, exact (fractional) award
through the wallet, duplicate-award idempotency, notification only after a
confirmed credit, needs_review never being a dead end, and preservation of
the original Gemini extraction as an immutable audit record.

Reuses the in-memory fakes from tests/test_assessment_tools.py — same
route-level harness, no second test infrastructure.
"""
from __future__ import annotations

import asyncio

import pytest

import assessment_ai_provider as ai
import assessment_tools as at
from assessment_schema import (
    build_assessment_document,
    normalize_extracted_answer_key,
    normalize_extracted_submission_answers,
)
from assessment_scoring import score_submission
from tests.test_assessment_tools import (
    REAL_ANSWER_KEY_ITEMS,
    _Admin,
    _Student,
    _UploadFile,
    _Wallet,
    _build,
    _call,
    _patch_media_storage,
    _seed_published_assessment,
)


def run(c):
    return asyncio.run(c)


def _questions():
    return normalize_extracted_answer_key(REAL_ANSWER_KEY_ITEMS)


def _extract_stub(answers):
    async def fake_extract(media_bytes, content_type, questions):
        return {"ok": True, "answers": answers, "engine": "gemini",
                "model": "gemini-2.5-pro", "verification": None}
    return fake_extract


def _submit(router, db, monkeypatch, answers, student=None):
    _patch_media_storage(monkeypatch)
    monkeypatch.setattr(ai, "extract_submission_answers", _extract_stub(answers))
    asmt = db[at.COLL_ASSESSMENTS].docs.get("asmt_fixed") or _seed_published_assessment(db)
    file = _UploadFile(b"worksheet-bytes", "image/jpeg")
    return _call(router, "POST", "/student/assessments/submit",
                 assessment_id="asmt_fixed", file=file, student=student or _Student())


def _all_correct(questions):
    return [{"qid": q["qid"], "answer": q["correctAnswer"],
             "answer_state": "answered", "confidence": 0.95} for q in questions]


# ── 1. perfect score ───────────────────────────────────────────────────────
def test_perfect_worksheet_scores_30_of_30_and_15_points(monkeypatch):
    db, router, _ = _build()
    asmt = _seed_published_assessment(db)
    result = _submit(router, db, monkeypatch, _all_correct(asmt["questions"]))
    sub = result["submission"]
    assert sub["status"] == "scored"
    assert sub["score"]["correct"] == 30
    assert sub["score"]["pointsEarned"] == 15.0
    assert sub["score"]["needsReview"] is False


# ── 2. explicit blanks are a valid, awardable outcome — not a dead state ──
def test_explicit_blanks_score_28_of_30_and_stay_awardable(monkeypatch):
    wallet = _Wallet()
    db, router, _ = _build(wallet=wallet)
    asmt = _seed_published_assessment(db)
    answers = _all_correct(asmt["questions"])
    answers[0] = {"qid": "q1", "answer": "", "answer_state": "blank", "confidence": 0.9}
    answers[16] = {"qid": "q17", "answer": "", "answer_state": "blank", "confidence": 0.9}
    result = _submit(router, db, monkeypatch, answers)
    sub = result["submission"]
    assert sub["score"]["correct"] == 28
    assert sub["score"]["pointsEarned"] == 14.0
    assert sub["score"]["blankCount"] == 2
    # A definite blank is NOT uncertainty — the submission is directly scored.
    assert sub["status"] == "scored"
    awarded = _call(router, "POST", "/admin/assessments/submissions/{submission_id}/award",
                    submission_id=sub["submissionId"], admin=_Admin())
    assert awarded["ok"] is True and awarded["points"] == 14.0


# ── 3. Gemini false negative -> teacher corrects -> score recalculates ────
def test_gemini_false_negative_teacher_correction_recalculates(monkeypatch):
    db, router, _ = _build()
    asmt = _seed_published_assessment(db)
    answers = _all_correct(asmt["questions"])
    # Physical mark exists but Gemini missed it: reported uncertain @31%.
    answers[0] = {"qid": "q1", "answer": "", "answer_state": "uncertain", "confidence": 0.31}
    result = _submit(router, db, monkeypatch, answers)
    sub = result["submission"]
    assert sub["status"] == "needs_review"
    assert sub["score"]["correct"] == 29
    assert sub["score"]["pointsEarned"] == 14.5

    corrected = _call(router, "POST", "/admin/assessments/submissions/{submission_id}/correct",
                      submission_id=sub["submissionId"],
                      payload={"corrections": [{"qid": "q1", "answer": "LONG"}]}, admin=_Admin())
    assert corrected["score"]["correct"] == 30
    assert corrected["score"]["pointsEarned"] == 15.0
    assert corrected["status"] == "reviewed"

    stored = db[at.COLL_SUBMISSIONS].docs[sub["submissionId"]]
    # The original Gemini extraction is never destroyed by a correction.
    original_q1 = next(a for a in stored["originalExtractedAnswers"] if a["qid"] == "q1")
    assert original_q1["answerState"] == "uncertain"
    assert original_q1["confidence"] == 0.31
    final_q1 = next(a for a in stored["extractedAnswers"] if a["qid"] == "q1")
    assert final_q1["answer"] == "LONG" and final_q1["source"] == "teacher"
    record = stored["teacherCorrections"][-1]
    assert record["qid"] == "q1"
    assert record["previousState"] == "uncertain"
    assert record["correctedBy"] == "teacher@example.com"
    assert record["correctedAt"]


# ── 4. uncertain is never scored correct, even if the guess matches ───────
def test_uncertain_reading_never_scores_correct_until_teacher_resolves():
    questions = _questions()
    answers = normalize_extracted_submission_answers(
        [{"qid": "q1", "answer": "LONG", "answer_state": "uncertain", "confidence": 0.4}],
        [q["qid"] for q in questions[:1]], fill_missing=True)
    result = score_submission(questions[:1], answers)
    assert result["correct"] == 0
    assert result["needsReview"] is True
    assert result["details"][0]["answerState"] == "uncertain"


# ── 5. question alignment: an unreadable Q8 never shifts Q9 ───────────────
def test_missing_question_stays_explicit_and_never_shifts_neighbors():
    questions = _questions()
    known = [q["qid"] for q in questions]
    raw = [{"qid": q["qid"], "answer": q["correctAnswer"], "answer_state": "answered", "confidence": 0.9}
           for q in questions if q["qid"] != "q8"]  # Gemini omitted q8 entirely
    answers = normalize_extracted_submission_answers(raw, known, fill_missing=True)
    assert len(answers) == 30
    by_qid = {a["qid"]: a for a in answers}
    assert by_qid["q8"]["answerState"] == "uncertain"
    assert by_qid["q8"]["source"] == "missing"
    # q9's answer stayed q9's — no positional shifting.
    q9 = next(q for q in questions if q["qid"] == "q9")
    assert by_qid["q9"]["answer"] == q9["correctAnswer"]
    result = score_submission(questions, answers)
    assert result["correct"] == 29
    assert result["needsReview"] is True
    assert result["uncertainCount"] == 1


# ── 6. multiple teacher corrections recalculate correctly ─────────────────
def test_multiple_corrections_each_recalculate(monkeypatch):
    db, router, _ = _build()
    asmt = _seed_published_assessment(db)
    answers = _all_correct(asmt["questions"])
    answers[0] = {"qid": "q1", "answer": "", "answer_state": "uncertain", "confidence": 0.2}
    answers[1] = {"qid": "q2", "answer": "LONG", "answer_state": "answered", "confidence": 0.9}  # wrong (key: SHORT)
    sub = _submit(router, db, monkeypatch, answers)["submission"]
    assert sub["score"]["correct"] == 28

    first = _call(router, "POST", "/admin/assessments/submissions/{submission_id}/correct",
                  submission_id=sub["submissionId"],
                  payload={"corrections": [{"qid": "q1", "answer": "LONG"}]}, admin=_Admin())
    assert first["score"]["correct"] == 29
    second = _call(router, "POST", "/admin/assessments/submissions/{submission_id}/correct",
                   submission_id=sub["submissionId"],
                   payload={"corrections": [{"qid": "q2", "answer": "SHORT"}]}, admin=_Admin())
    assert second["score"]["correct"] == 30
    stored = db[at.COLL_SUBMISSIONS].docs[sub["submissionId"]]
    assert len(stored["teacherCorrections"]) == 2
    # original extraction still shows the pre-correction values
    orig_q2 = next(a for a in stored["originalExtractedAnswers"] if a["qid"] == "q2")
    assert orig_q2["answer"] == "LONG"


# ── 7. exact fractional award reaches the wallet ───────────────────────────
def test_award_credits_the_exact_fractional_calculated_points(monkeypatch):
    wallet = _Wallet()
    db, router, pushes = _build(wallet=wallet)
    asmt = _seed_published_assessment(db)
    answers = _all_correct(asmt["questions"])
    answers[0] = {"qid": "q1", "answer": "", "answer_state": "blank", "confidence": 0.9}
    answers[1] = {"qid": "q2", "answer": "", "answer_state": "blank", "confidence": 0.9}
    answers[2] = {"qid": "q3", "answer": "SHORT", "answer_state": "answered", "confidence": 0.9}  # wrong
    sub = _submit(router, db, monkeypatch, answers)["submission"]
    assert sub["score"]["correct"] == 27
    assert sub["score"]["pointsEarned"] == 13.5

    awarded = _call(router, "POST", "/admin/assessments/submissions/{submission_id}/award",
                    submission_id=sub["submissionId"], admin=_Admin())
    assert awarded["ok"] is True
    assert awarded["points"] == 13.5  # never 13, 15, 27 or an AI-generated value
    idem_key = f"assessment_award:{sub['submissionId']}"
    assert wallet.seen[idem_key] == 13.5


def test_wallet_coerce_amount_preserves_half_points_exactly():
    from wallet_service import WalletError, _coerce_amount
    assert _coerce_amount(13.5) == 13.5
    assert _coerce_amount(14.0) == 14
    assert isinstance(_coerce_amount(14.0), int)
    assert _coerce_amount(15) == 15
    with pytest.raises(WalletError):
        _coerce_amount(13.7)  # unsupported granularity — still rejected
    with pytest.raises(WalletError):
        _coerce_amount(0)
    with pytest.raises(WalletError):
        _coerce_amount(True)


# ── 8/12. needs_review is never a dead end; duplicate award credits zero ──
def test_needs_review_submission_is_awardable_and_idempotent(monkeypatch):
    wallet = _Wallet()
    pushes = []
    db, router, pushes = _build(wallet=wallet, pushes=pushes)
    asmt = _seed_published_assessment(db)
    answers = _all_correct(asmt["questions"])
    answers[0] = {"qid": "q1", "answer": "", "answer_state": "uncertain", "confidence": 0.31}
    sub = _submit(router, db, monkeypatch, answers)["submission"]
    assert sub["status"] == "needs_review"

    first = _call(router, "POST", "/admin/assessments/submissions/{submission_id}/award",
                  submission_id=sub["submissionId"], admin=_Admin())
    assert first["ok"] is True and first["points"] == 14.5
    assert wallet.calls == 1 and len(pushes) == 1

    second = _call(router, "POST", "/admin/assessments/submissions/{submission_id}/award",
                   submission_id=sub["submissionId"], admin=_Admin())
    assert second["duplicate"] is True
    assert wallet.calls == 1 and len(pushes) == 1  # zero additional credit/notification


def test_processing_and_failed_submissions_are_not_awardable(monkeypatch):
    wallet = _Wallet()
    db, router, _ = _build(wallet=wallet)
    asmt = _seed_published_assessment(db)
    sub = _submit(router, db, monkeypatch, _all_correct(asmt["questions"]))["submission"]
    for bad_status in ("processing", "failed"):
        db[at.COLL_SUBMISSIONS].docs[sub["submissionId"]]["status"] = bad_status
        with pytest.raises(Exception) as exc_info:
            _call(router, "POST", "/admin/assessments/submissions/{submission_id}/award",
                  submission_id=sub["submissionId"], admin=_Admin())
        assert "not_awardable" in str(exc_info.value)
    assert wallet.calls == 0


# ── 9. notification fires ONLY after a confirmed wallet credit ────────────
def test_failed_wallet_credit_sends_no_notification_and_never_marks_awarded(monkeypatch):
    wallet = _Wallet()
    wallet.fail = True
    pushes = []
    db, router, pushes = _build(wallet=wallet, pushes=pushes)
    asmt = _seed_published_assessment(db)
    sub = _submit(router, db, monkeypatch, _all_correct(asmt["questions"]))["submission"]

    with pytest.raises(Exception):
        _call(router, "POST", "/admin/assessments/submissions/{submission_id}/award",
              submission_id=sub["submissionId"], admin=_Admin())
    stored = db[at.COLL_SUBMISSIONS].docs[sub["submissionId"]]
    assert stored["status"] != "awarded"
    assert len(pushes) == 0  # no false-positive "points credited" push

    # After the wallet recovers, the SAME submission can be awarded cleanly.
    wallet.fail = False
    retried = _call(router, "POST", "/admin/assessments/submissions/{submission_id}/award",
                    submission_id=sub["submissionId"], admin=_Admin())
    assert retried["ok"] is True
    assert len(pushes) == 1


# ── 10. corrections are locked once points were credited ──────────────────
def test_awarded_submission_answers_are_locked(monkeypatch):
    wallet = _Wallet()
    db, router, _ = _build(wallet=wallet)
    asmt = _seed_published_assessment(db)
    sub = _submit(router, db, monkeypatch, _all_correct(asmt["questions"]))["submission"]
    _call(router, "POST", "/admin/assessments/submissions/{submission_id}/award",
          submission_id=sub["submissionId"], admin=_Admin())
    with pytest.raises(Exception) as exc_info:
        _call(router, "POST", "/admin/assessments/submissions/{submission_id}/correct",
              submission_id=sub["submissionId"],
              payload={"corrections": [{"qid": "q1", "answer": "SHORT"}]}, admin=_Admin())
    assert "409" in str(exc_info.value) or "locked" in str(exc_info.value)


# ── 11. extraction metadata: engine + model + timestamp are persisted ─────
def test_extraction_metadata_persists_engine_model_and_timestamp(monkeypatch):
    db, router, _ = _build()
    asmt = _seed_published_assessment(db)
    sub = _submit(router, db, monkeypatch, _all_correct(asmt["questions"]))["submission"]
    meta = sub["extraction"]
    assert meta["engine"] == "gemini"
    assert meta["model"] == "gemini-2.5-pro"
    assert meta["extractedAt"]
    assert meta["rawAnswerCount"] == 30
    assert meta["normalizedAnswerCount"] == 30


def test_default_submission_model_is_gemini_2_5_pro_and_not_downgraded(monkeypatch):
    monkeypatch.delenv("ASSESSMENT_AI_SUBMISSION_MODEL", raising=False)
    assert ai._submission_model() == "gemini-2.5-pro"
    assert ai.DEFAULT_SUBMISSION_MODEL == "gemini-2.5-pro"


# ── 13. extraction prompt: physical evidence only, question-safe ──────────
def test_submission_prompt_demands_physical_evidence_and_per_qid_states():
    questions = _questions()
    prompt = ai._submission_prompt(questions)
    assert "PHYSICALLY" in prompt or "physically" in prompt
    assert "uncertain" in prompt
    assert "blank" in prompt
    assert "EVERY qid" in prompt
    assert "never shift an answer" in prompt
    assert "NOT infer" in prompt


# ── 14. verification pass re-checks only suspicious questions ─────────────
def test_verification_pass_rechecks_only_suspect_qids(monkeypatch):
    questions = _questions()[:5]
    calls = []

    async def fake_call(prompt, *, media_part=None, model=None):
        calls.append({"prompt": prompt, "model": model})
        if len(calls) == 1:
            answers = [{"qid": q["qid"], "answer": q["correctAnswer"],
                        "answer_state": "answered", "confidence": 0.95} for q in questions[:3]]
            answers.append({"qid": "q4", "answer": "", "answer_state": "uncertain", "confidence": 0.3})
            # q5 missing entirely
            return {"answers": answers}
        return {"answers": [
            {"qid": "q4", "answer": questions[3]["correctAnswer"], "answer_state": "answered", "confidence": 0.9},
            {"qid": "q5", "answer": "", "answer_state": "blank", "confidence": 0.85},
        ]}

    async def fake_media_part(api_key, media_bytes, content_type):
        return {"inline_data": {"mime_type": content_type, "data": ""}}

    monkeypatch.setenv("GEMINI_API_KEY", "test-key")
    monkeypatch.delenv("ASSESSMENT_AI_MOCK", raising=False)
    monkeypatch.setattr(ai, "_call_gemini_json", fake_call)
    monkeypatch.setattr(ai, "_media_part", fake_media_part)

    result = run(ai.extract_submission_answers(b"bytes", "image/jpeg", questions))
    assert result["ok"] is True
    assert result["model"] == "gemini-2.5-pro"
    assert len(calls) == 2
    # second call re-checked exactly the suspect qids (q4 uncertain, q5 missing)
    assert 'qid="q4"' in calls[1]["prompt"] and 'qid="q5"' in calls[1]["prompt"]
    assert 'qid="q1"' not in calls[1]["prompt"]  # high-confidence answers not reprocessed
    assert sorted(result["verification"]["checkedQids"]) == ["q4", "q5"]
    by_qid = {a["qid"]: a for a in result["answers"]}
    assert by_qid["q4"]["answer_state"] == "answered"
    assert by_qid["q5"]["answer_state"] == "blank"


# ── 15. bulk award: exact per-student amounts, mixed statuses ──────────────
def test_bulk_award_mixed_statuses_credits_exact_amounts(monkeypatch):
    wallet = _Wallet()
    db, router, _ = _build(wallet=wallet)
    asmt = _seed_published_assessment(db)

    # stu021: needs_review @13.5, stu022: scored @15, stu023: reviewed @12
    a1 = _all_correct(asmt["questions"])
    a1[0] = {"qid": "q1", "answer": "", "answer_state": "uncertain", "confidence": 0.3}
    a1[1] = {"qid": "q2", "answer": "LONG", "answer_state": "answered", "confidence": 0.9}
    a1[2] = {"qid": "q3", "answer": "SHORT", "answer_state": "answered", "confidence": 0.9}
    s1 = _submit(router, db, monkeypatch, a1, student=_Student("stu_21", "stu021"))["submission"]
    assert s1["status"] == "needs_review" and s1["score"]["pointsEarned"] == 13.5

    s2 = _submit(router, db, monkeypatch, _all_correct(asmt["questions"]),
                 student=_Student("stu_22", "stu022"))["submission"]
    assert s2["score"]["pointsEarned"] == 15.0

    a3 = _all_correct(asmt["questions"])
    for i in range(6):
        a3[i] = {"qid": f"q{i + 1}", "answer": "", "answer_state": "blank", "confidence": 0.9}
    s3 = _submit(router, db, monkeypatch, a3, student=_Student("stu_23", "stu023"))["submission"]
    assert s3["score"]["pointsEarned"] == 12.0
    _call(router, "POST", "/admin/assessments/submissions/{submission_id}/correct",
          submission_id=s3["submissionId"], payload={"corrections": []}, admin=_Admin())

    result = _call(router, "POST", "/admin/assessments/submissions/bulk-award",
                   payload={"submissionIds": [s1["submissionId"], s2["submissionId"], s3["submissionId"]]},
                   admin=_Admin())
    assert result["awarded"] == 3 and result["failed"] == 0
    assert wallet.seen[f"assessment_award:{s1['submissionId']}"] == 13.5
    assert wallet.seen[f"assessment_award:{s2['submissionId']}"] == 15.0
    assert wallet.seen[f"assessment_award:{s3['submissionId']}"] == 12.0
