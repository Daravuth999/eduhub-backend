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


def apply_teacher_overrides(score: dict, overrides: list[dict], questions: list[dict]) -> dict:
    """Post-award reverse-review layer: applies a teacher's per-question
    correctness/points overrides ON TOP OF an already-persisted `score`
    dict (this function's own prior output, or a previously-corrected
    result), WITHOUT touching `extractedAnswers` and WITHOUT re-running
    Gemini or the string-match comparison in `score_submission` above.

    This is the concrete mechanism behind "teacher/admin correction is
    authoritative" (Gemini may inform the decision but never silently
    overrides it): a teacher can mark a question correct/incorrect and
    set its exact awarded points directly — e.g. because the student
    provided evidence the AI's/answer-key's original read was wrong —
    independent of what the student physically wrote.

    `overrides` — list of {qid, correct?, points, note?}. A qid missing
    from `score["details"]` (stale/unknown) is silently ignored — the
    caller is responsible for validating qids against the assessment's
    own known-question set before calling this. `points` is clamped into
    [0, question.points] using `questions` (the assessment's own
    build_question dicts) as the source of the per-question max; falls
    back to the existing detail's own `points` ceiling if the qid is
    somehow absent from `questions` (defensive, should not happen since
    `questions` is the origin of `score["details"]` in the first place).

    Never mutates `score` or its nested `details` list — returns a new
    dict. `needsReview`/`answeredCount`/`blankCount`/`uncertainCount` are
    carried over unchanged (they describe the physical extraction, which
    a correctness override does not change)."""
    by_qid_q = {str(q.get("qid")): q for q in (questions or [])}
    ov_by_qid: dict[str, dict] = {}
    for o in overrides or []:
        if not isinstance(o, dict):
            continue
        qid = str(o.get("qid") or "")
        if qid:
            ov_by_qid[qid] = o

    new_details: list[dict] = []
    correct = 0
    points_earned = 0.0
    total_points = 0.0
    for d in score.get("details") or []:
        d = dict(d)
        qid = str(d.get("qid") or "")
        total_points += float(d.get("points") or 0.0)
        ov = ov_by_qid.get(qid)
        if ov is not None:
            q = by_qid_q.get(qid)
            max_points = float(q.get("points")) if q else float(d.get("points") or 0.0)
            try:
                pts = float(ov.get("points"))
            except (TypeError, ValueError):
                pts = max_points if ov.get("correct") else 0.0
            pts = max(0.0, min(max_points, round(pts, 3)))
            is_correct = bool(ov.get("correct")) if "correct" in ov else pts > 0
            d["correct"] = is_correct
            d["pointsEarned"] = pts
            d["teacherOverride"] = True
            note = ov.get("note")
            if note:
                d["overrideNote"] = str(note)[:240]
        if d.get("correct"):
            correct += 1
        points_earned += float(d.get("pointsEarned") or 0.0)
        new_details.append(d)

    total = len(new_details)
    score_pct = round((correct / total) * 100, 1) if total else 0.0
    out = dict(score)
    out["details"] = new_details
    out["correct"] = correct
    out["total"] = total
    out["scorePct"] = score_pct
    out["pointsEarned"] = round(points_earned, 3)
    out["totalPoints"] = round(total_points, 3)
    return out
