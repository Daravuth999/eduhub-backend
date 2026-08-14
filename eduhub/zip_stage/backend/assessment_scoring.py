"""assessment_scoring.py — deterministic answer-key scoring for the AI
Assessment Lab.

Pure, stdlib-only. Follows chapter_quiz_tools.py's `quiz_submit` precedent
exactly: AI (Gemini, via assessment_ai_provider.py) is used ONLY to extract
what the student wrote from the uploaded photo/PDF — grading itself is
plain, deterministic, normalized string-equality against the assessment's
persisted `correctAnswer`. Gemini never grades in real time, so a score can
always be reproduced/audited from the persisted extractedAnswers alone.

Answer-state semantics (assessment_schema.ANSWER_STATES):
  answered   — physical mark read; compared against the answer key. Low
               confidence (< CONFIDENCE_REVIEW_THRESHOLD) still scores but
               flips needsReview so a teacher looks before points move.
  blank      — a DEFINITE physical observation: the student left it empty.
               Scores as incorrect and does NOT by itself force review —
               a genuinely blank answer is a valid, awardable outcome.
  uncertain  — Gemini could not read the paper reliably (or omitted the
               question entirely, filled in by normalize_*). Never scores
               as correct even if its best-guess text matches, and always
               flips needsReview: only a teacher may resolve uncertainty.

needsReview is a "teacher should inspect" signal, never a dead end — the
award path treats needs_review submissions as awardable with their exact
persisted calculated score.
"""
from __future__ import annotations

CONFIDENCE_REVIEW_THRESHOLD = 0.6


def _normalize(value) -> str:
    return str(value or "").strip().casefold()


def score_submission(questions: list[dict], extracted_answers: list[dict]) -> dict:
    """`questions` — the assessment's own `build_question` dicts (source of
    truth for qid/correctAnswer/points). `extracted_answers` — the
    assessment_schema.normalize_extracted_submission_answers output for
    this submission (already whitelisted against these same qids).

    Returns {correct, total, scorePct, pointsEarned, totalPoints,
    answeredCount, blankCount, uncertainCount, details, needsReview} —
    never raises; a question with no matching extracted answer is scored
    as incorrect (blank == wrong) rather than excluded from the total."""
    by_qid = {str(a.get("qid")): a for a in (extracted_answers or []) if isinstance(a, dict)}
    correct = 0
    points_earned = 0.0
    total_points = 0.0
    needs_review = False
    answered_count = 0
    blank_count = 0
    uncertain_count = 0
    details: list[dict] = []

    for q in questions or []:
        qid = str(q.get("qid") or "")
        correct_answer = q.get("correctAnswer")
        points = float(q.get("points") or 0.0)
        total_points += points

        found = by_qid.get(qid)
        given = found.get("answer") if found else None
        confidence = found.get("confidence") if found else None
        source = found.get("source") if found else None
        state = str((found or {}).get("answerState") or "").strip().lower()
        if found is not None and state not in ("answered", "blank", "uncertain"):
            # Legacy entries (pre answer-state) behave exactly as before.
            state = "answered"

        if found is None:
            state = "uncertain"
            needs_review = True
            ok = False
        elif state == "uncertain":
            # Only a teacher may resolve uncertainty — never scored correct.
            ok = False
            needs_review = True
        elif state == "blank":
            ok = False
        else:  # answered
            ok = _normalize(given) == _normalize(correct_answer)
            if confidence is not None and confidence < CONFIDENCE_REVIEW_THRESHOLD:
                needs_review = True

        if state == "answered":
            answered_count += 1
        elif state == "blank":
            blank_count += 1
        else:
            uncertain_count += 1

        if ok:
            correct += 1
            points_earned += points

        details.append({
            "qid": qid,
            "prompt": q.get("prompt"),
            "givenAnswer": (given if state == "answered" else (given or None)),
            "correctAnswer": correct_answer,
            "correct": ok,
            "points": points,
            "pointsEarned": points if ok else 0.0,
            "confidence": confidence,
            "answerState": state,
            "source": source,
        })

    total = len(questions or [])
    score_pct = round((correct / total) * 100, 1) if total else 0.0
    return {
        "correct": correct,
        "total": total,
        "scorePct": score_pct,
        "pointsEarned": round(points_earned, 3),
        "totalPoints": round(total_points, 3),
        "needsReview": needs_review,
        "answeredCount": answered_count,
        "blankCount": blank_count,
        "uncertainCount": uncertain_count,
        "details": details,
    }
