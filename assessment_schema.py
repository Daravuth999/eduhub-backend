"""assessment_schema.py — AI Assessment / Quiz Submission Lab, canonical schema.

Pure, stdlib-only, no Mongo/network — same purity discipline as
sync_schema.py / video_scene_schema.py. Defines the document shapes shared
by every producer (Gemini extraction, teacher manual entry, teacher
correction) and every consumer (scoring engine, Author Studio review,
routes). Nothing in this module calls Gemini or touches a database — see
assessment_ai_provider.py for the Gemini boundary and assessment_tools.py
for the Mongo-backed routes.

Three documents:
  assessment           — a worksheet/quiz definition: title + ordered
                          questions, each with its own correct answer and
                          point value (spec: "no fake data" — every field
                          here is either teacher-supplied or Gemini-
                          extracted-then-teacher-reviewed, never invented).
  submission            — one student's attempt: a reference to the
                          uploaded media, the answers Gemini extracted from
                          it, and the resulting score. `status` is the
                          single source of truth for where a submission
                          sits in its lifecycle (see VALID_SUBMISSION_
                          STATUSES) — Author Studio and the student PWA
                          both render directly off this field, never a
                          derived/duplicated flag.
  award                 — a point-award reservation for one submission.
                          Kept as its OWN tiny document (not a field on
                          submission) so the unique index that makes
                          awarding idempotent (one award per submission)
                          is trivial to reason about — mirrors achievement_
                          tools.py's claim-document pattern.

Every `normalize_*` function is the one gate raw Gemini output passes
through before it is trusted: bounded lengths, whitelisted question ids,
clamped confidence — Gemini's own invented ids/ordering are never trusted
verbatim, matching video_scene_schema.py's normalize_* convention.
"""
from __future__ import annotations

import uuid

ASSESSMENT_SCHEMA_VERSION = 1

VALID_ASSESSMENT_STATUSES = ("draft", "published", "archived")
VALID_SUBMISSION_STATUSES = (
    "processing",   # Gemini extraction in flight
    "needs_review", # extraction low-confidence / ambiguous — teacher must look
    "scored",       # deterministic score computed, awaiting teacher review
    "reviewed",     # teacher has looked at / corrected the submission
    "awarded",      # points credited — terminal
    "failed",       # extraction or scoring could not complete
)
VALID_AWARD_STATUSES = ("pending", "credited", "failed")
# Every extracted answer carries an explicit physical-evidence state — a
# question Gemini could not read stays explicitly represented (uncertain)
# instead of silently disappearing, so Q8 being unreadable can never shift
# Q9's answer into Q8's slot.
ANSWER_STATES = ("answered", "blank", "uncertain")

# ── post-award correction (reverse review) ──────────────────────────────
# Deliberately NOT a new value on VALID_SUBMISSION_STATUSES: `status`
# stays "awarded" (terminal) forever once a submission is awarded — a
# correction changes HOW MANY points were credited, never whether the
# submission is in the awarded state. `correctionState` is an orthogonal,
# narrowly-scoped secondary field (same pattern as `award.status` already
# living beside `submission.status`) that answers exactly one question:
# has this submission ever been corrected since it was awarded. Entering
# "review mode" in the teacher UI is a read-only, frontend-only phase (no
# persisted lock) — concurrent-correction safety comes from
# `correctionVersion` (optimistic concurrency, checked at apply time) and
# the wallet's own idempotency_key, not from a server-side lock.
CORRECTION_STATES = ("none", "applied")
CORRECTION_REASONS = (
    "teacher_grading_mistake",
    "student_evidence_accepted",
    "question_key_error",
    "gemini_interpretation_error",
    "listening_interpretation_error",
    "technical_issue",
    "other",
)
MAX_REASON_NOTE_LEN = 500

MAX_QUESTIONS = 100
MAX_ANSWER_LEN = 240
MAX_PROMPT_LEN = 240


def new_assessment_id() -> str:
    return "asmt_" + uuid.uuid4().hex[:16]


def new_submission_id() -> str:
    return "asub_" + uuid.uuid4().hex[:16]


def new_award_id() -> str:
    return "aawd_" + uuid.uuid4().hex[:16]


def new_correction_id() -> str:
    return "acor_" + uuid.uuid4().hex[:16]


# ── assessment (question set) ────────────────────────────────────────────
def build_question(qid: str, prompt: str, correct_answer: str, *,
                    points: float = 1.0, choices: list[str] | None = None) -> dict:
    q = {
        "qid": qid,
        "prompt": str(prompt or "")[:MAX_PROMPT_LEN],
        "correctAnswer": str(correct_answer or "")[:MAX_ANSWER_LEN],
        "points": max(0.0, round(float(points), 3)),
    }
    if choices:
        q["choices"] = [str(c)[:120] for c in choices[:8]]
    return q


def build_assessment_document(assessment_id: str, title: str, questions: list[dict], *,
                               subject: str = "", created_by: str = "",
                               source_ref: str | None = None,
                               status: str = "draft", generated_at: str = "") -> dict:
    return {
        "assessmentId": assessment_id,
        "schemaVersion": ASSESSMENT_SCHEMA_VERSION,
        "title": str(title or "")[:200],
        "subject": str(subject or "")[:80],
        "questions": questions,
        "totalPoints": total_points(questions),
        "createdBy": str(created_by or "")[:120],
        "sourceRef": source_ref,
        "status": status,
        "generatedAt": generated_at,
    }


def total_points(questions: list[dict]) -> float:
    return round(sum(float(q.get("points") or 0.0) for q in (questions or [])), 3)


def validate_assessment_document(doc: dict) -> tuple[bool, list[str]]:
    errors: list[str] = []
    if not isinstance(doc, dict):
        return False, ["document is not an object"]
    if not (doc.get("assessmentId") or "").strip():
        errors.append("assessmentId is required")
    if not (doc.get("title") or "").strip():
        errors.append("title is required")
    if doc.get("status") not in VALID_ASSESSMENT_STATUSES:
        errors.append(f"status must be one of {VALID_ASSESSMENT_STATUSES}")
    questions = doc.get("questions")
    if not isinstance(questions, list) or not questions:
        errors.append("questions must be a non-empty list")
        return not errors, errors
    if len(questions) > MAX_QUESTIONS:
        errors.append(f"too many questions (max {MAX_QUESTIONS})")
    seen_ids: set[str] = set()
    for i, q in enumerate(questions):
        if not isinstance(q, dict):
            errors.append(f"questions[{i}] is not an object")
            continue
        qid = str(q.get("qid") or "").strip()
        if not qid:
            errors.append(f"questions[{i}].qid is required")
        elif qid in seen_ids:
            errors.append(f"questions[{i}].qid {qid!r} is a duplicate")
        else:
            seen_ids.add(qid)
        if not str(q.get("correctAnswer") or "").strip():
            errors.append(f"questions[{i}].correctAnswer is required")
        try:
            if float(q.get("points") or 0) < 0:
                errors.append(f"questions[{i}].points must be >= 0")
        except (TypeError, ValueError):
            errors.append(f"questions[{i}].points must be a number")
    return not errors, errors


def normalize_extracted_answer_key(raw_items, *, max_items: int = MAX_QUESTIONS,
                                    default_points: float = 1.0) -> list[dict]:
    """Bounds a Gemini answer-key extraction into clean `build_question`
    dicts with freshly-generated sequential qids (q1..qN) — Gemini's own
    numbering is display-only (`no`), never trusted as the persisted id,
    so a re-extraction can never collide with or silently renumber a
    teacher's already-edited question set."""
    if not isinstance(raw_items, list):
        return []
    out: list[dict] = []
    for i, it in enumerate(raw_items[:max_items]):
        if not isinstance(it, dict):
            continue
        prompt = str(it.get("prompt") or it.get("word") or it.get("question") or "").strip()
        answer = str(it.get("answer") or it.get("correct_answer") or "").strip()
        if not prompt or not answer:
            continue
        try:
            points = float(it.get("points"))
            if points <= 0:
                points = default_points
        except (TypeError, ValueError):
            points = default_points
        out.append(build_question(f"q{len(out) + 1}", prompt, answer, points=points))
    return out


# ── submission ────────────────────────────────────────────────────────────
def build_submission_document(submission_id: str, assessment_id: str, *,
                               student_id: str, clean_id: str,
                               media_ref: str, content_type: str,
                               media_key: str = "",
                               status: str = "processing", generated_at: str = "") -> dict:
    return {
        "submissionId": submission_id,
        "schemaVersion": ASSESSMENT_SCHEMA_VERSION,
        "assessmentId": assessment_id,
        "studentId": student_id,
        "cleanId": clean_id,
        "mediaRef": media_ref,
        "mediaKey": media_key,
        "contentType": content_type,
        "status": status,
        "extractedAnswers": [],
        "originalExtractedAnswers": [],
        "extraction": None,
        "score": None,
        "teacherCorrections": [],
        "submittedAt": generated_at,
        "reviewedAt": None,
        "reviewedBy": None,
        # Post-award correction (reverse review) — see CORRECTION_STATES.
        "correctionState": "none",
        "correctionVersion": 0,
        "originalAward": None,
    }


def validate_submission_document(doc: dict) -> tuple[bool, list[str]]:
    errors: list[str] = []
    if not isinstance(doc, dict):
        return False, ["document is not an object"]
    if not (doc.get("submissionId") or "").strip():
        errors.append("submissionId is required")
    if not (doc.get("assessmentId") or "").strip():
        errors.append("assessmentId is required")
    if not (doc.get("studentId") or "").strip():
        errors.append("studentId is required")
    if not (doc.get("mediaRef") or "").strip():
        errors.append("mediaRef is required")
    if doc.get("status") not in VALID_SUBMISSION_STATUSES:
        errors.append(f"status must be one of {VALID_SUBMISSION_STATUSES}")
    return not errors, errors


def normalize_extracted_submission_answers(raw_items, known_question_ids, *,
                                            max_items: int = MAX_QUESTIONS,
                                            fill_missing: bool = False) -> list[dict]:
    """Bounds a Gemini submission-extraction into `{qid, answer,
    confidence, answerState, source}` dicts. Any qid Gemini invents that is
    NOT in the assessment's own known question-id set is dropped, never
    trusted — the same "whitelist against a known-valid set" discipline
    video_scene_schema.py's normalize_* functions use for scene/character
    ids. Answers are keyed by stable qid (never by list position), so one
    unreadable question can never shift subsequent answers.

    With `fill_missing=True` (the submission route's mode), every known qid
    absent from Gemini's output is explicitly represented as an `uncertain`
    entry instead of silently vanishing, and the result is returned in the
    assessment's own question order."""
    known_list = [str(k) for k in (known_question_ids or [])]
    known = set(known_list)
    if not isinstance(raw_items, list):
        raw_items = []
    out: list[dict] = []
    seen: set[str] = set()
    for it in raw_items[:max_items]:
        if not isinstance(it, dict):
            continue
        qid = str(it.get("qid") or "").strip()
        if not qid or qid not in known or qid in seen:
            continue
        seen.add(qid)
        answer = str(it.get("answer") or "").strip()[:MAX_ANSWER_LEN]
        try:
            confidence = float(it.get("confidence"))
            confidence = max(0.0, min(1.0, confidence))
        except (TypeError, ValueError):
            confidence = None
        state = str(it.get("answer_state") or it.get("answerState") or "").strip().lower()
        if state not in ANSWER_STATES:
            state = "answered" if answer else "blank"
        out.append({"qid": qid, "answer": answer, "confidence": confidence,
                    "answerState": state, "source": "gemini"})
    if fill_missing:
        for qid in known_list:
            if qid not in seen:
                out.append({"qid": qid, "answer": "", "confidence": None,
                            "answerState": "uncertain", "source": "missing"})
        order = {qid: i for i, qid in enumerate(known_list)}
        out.sort(key=lambda a: order.get(a["qid"], len(order)))
    return out


# ── award ─────────────────────────────────────────────────────────────────
def build_award_document(award_id: str, submission_id: str, assessment_id: str, *,
                          student_id: str, clean_id: str, points: float,
                          status: str = "pending", generated_at: str = "") -> dict:
    return {
        "awardId": award_id,
        "submissionId": submission_id,
        "assessmentId": assessment_id,
        "studentId": student_id,
        "cleanId": clean_id,
        "points": max(0.0, round(float(points), 3)),
        "status": status,
        "createdAt": generated_at,
        "creditedAt": None,
        "notifiedAt": None,
        "balanceAfter": None,
    }


# ── correction (post-award reverse-review audit record) ─────────────────
def build_correction_document(correction_id: str, submission_id: str, assessment_id: str, *,
                               student_id: str, clean_id: str, teacher_email: str,
                               reason: str, reason_note: str,
                               question_changes: list[dict],
                               original_score: dict, corrected_score: dict,
                               original_points: float, corrected_points: float,
                               wallet_adjustment: float,
                               wallet_shortfall: float = 0.0,
                               wallet_transaction_id: str | None = None,
                               idempotency_key: str = "", client_token: str = "",
                               status: str = "pending", generated_at: str = "") -> dict:
    """One append-only audit record per applied correction — never mutated
    after `status` moves from "pending" to "applied" except to attach
    `walletTransactionId`/`notifiedAt` (both write-once). The submission's
    OWN `score`/`award` fields are updated in place to reflect the CURRENT
    state (student-facing "what is true now"); this document is the
    permanent, reconstructable "what changed and why" trail — see
    assessment_tools.py's admin_apply_correction for the write order.

    `walletAdjustment` is the ACTUAL signed amount that moved in the
    wallet — for a downward correction this may be LESS than the academic
    delta (`correctedPoints - originalPoints`) if the student had already
    spent some or all of the originally-awarded points; the wallet is
    never debited below zero (see wallet_service.py's guarded debit()).
    `walletShortfall` (always >= 0) is the portion of a downward
    correction that could NOT be recovered from the wallet — recorded
    explicitly, never silently dropped. The academic correction
    (`correctedScore`/`correctedPoints`, and the submission's own score/
    award fields) is applied in full regardless of how much of the
    shortfall could be recovered — a wallet limitation never blocks the
    grading correction itself."""
    return {
        "correctionId": correction_id,
        "submissionId": submission_id,
        "assessmentId": assessment_id,
        "studentId": student_id,
        "cleanId": clean_id,
        "teacherEmail": teacher_email,
        "reason": reason,
        "reasonNote": str(reason_note or "")[:MAX_REASON_NOTE_LEN],
        "questionChanges": question_changes,
        "originalScore": original_score,
        "correctedScore": corrected_score,
        "originalPoints": round(float(original_points or 0.0), 3),
        "correctedPoints": round(float(corrected_points or 0.0), 3),
        "walletAdjustment": round(float(wallet_adjustment or 0.0), 3),
        "walletShortfall": round(float(wallet_shortfall or 0.0), 3),
        "walletTransactionId": wallet_transaction_id,
        "idempotencyKey": idempotency_key,
        "clientToken": client_token,
        "status": status,
        "notifiedAt": None,
        "createdAt": generated_at,
        "appliedAt": None,
    }
