"""assessment_scoring.py — deterministic answer-key scoring for the AI
Assessment Lab.

Pure, stdlib-only. Follows chapter_quiz_tools.py's `quiz_submit` precedent
exactly: AI (Gemini, via assessment_ai_provider.py) is used ONLY to extract
what the student wrote from the uploaded photo/PDF — grading itself is
plain, deterministic, normalized string-equality against the assessment's
persisted `correctAnswer`. Gemini never grades in real time, so a score can
always be reproduced/audited from the persisted extractedAnswers alone.

Low-confidence extractions are still recorded and scored (silence is worse
than an honest "needs review" flag) but flip `needs_review` on the overall
result so Author Studio surfaces the submission for a human look before any
points move — see CONFIDENCE_REVIEW_THRESHOLD.
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

    Returns {correct, total, scorePct, pointsEarned, totalPoints, details,
    needsReview} — never raises; a question with no matching extracted
    answer is scored as incorrect (blank == wrong, matching chapter_quiz_
    tools.py's `ok = False if true_ans is None else ...` shape) rather than
    excluded from the total."""
    by_qid = {str(a.get("qid")): a for a in (extracted_answers or []) if isinstance(a, dict)}
    correct = 0
    points_earned = 0.0
    total_points = 0.0
    needs_review = False
    details: list[dict] = []

    for q in questions or []:
        qid = str(q.get("qid") or "")
        correct_answer = q.get("correctAnswer")
        points = float(q.get("points") or 0.0)
        total_points += points

        found = by_qid.get(qid)
        given = found.get("answer") if found else None
        confidence = found.get("confidence") if found else None
        ok = found is not None and _normalize(given) == _normalize(correct_answer)
        if ok:
            correct += 1
            points_earned += points
        if found is None or (confidence is not None and confidence < CONFIDENCE_REVIEW_THRESHOLD):
            needs_review = True

        details.append({
            "qid": qid,
            "prompt": q.get("prompt"),
            "givenAnswer": given,
            "correctAnswer": correct_answer,
            "correct": ok,
            "points": points,
            "pointsEarned": points if ok else 0.0,
            "confidence": confidence,
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
        "details": details,
    }
