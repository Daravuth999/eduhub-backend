# Assessment Lab — Verified Pipeline Map (from the actual repositories)

Student PWA (`AssessmentsListPage.jsx` → `SubmitAssessmentModal.jsx`)
     ↓  multipart POST /api/student/assessments/submit  (`assessmentApi.js`)
Upload API (`assessment_tools.py` :: student_submit)
     ↓  `_store_media` — R2-ONLY, sha256 content-addressed key (dedupe), HEAD-before-PUT,
     ↓  raises 503 on failure (never GridFS / Mongo / Render disk)
Cloudflare R2  (immutable original evidence; `mediaRef` public URL + `mediaKey` persisted)
     ↓
Gemini 2.5 Pro (`assessment_ai_provider.py` :: extract_submission_answers,
     ↓          model = ASSESSMENT_AI_SUBMISSION_MODEL || "gemini-2.5-pro")
STRUCTURED EXTRACTION — one entry per qid: {qid, answer, answer_state, confidence}
     ↓  physical-evidence-only prompt; never infers; never omits a qid
VERIFICATION PASS — same model, ONLY missing/uncertain/low-confidence qids, merged + audited
     ↓
Normalization (`assessment_schema.py` :: normalize_extracted_submission_answers,
     ↓          fill_missing=True → absent qids explicitly `uncertain`, qid-keyed = alignment-safe)
originalExtractedAnswers  (frozen forever)  +  extraction meta {engine, model, extractedAt, …}
     ↓
Deterministic Scoring (`assessment_scoring.py` :: score_submission — answer key is truth;
     ↓                 blank=definite incorrect; uncertain→needsReview; AI never grades)
Author Studio (`AssessmentReviewStudio.jsx`) — review table, R2 evidence link,
     ↓          inline teacher correction → POST /api/admin/assessments/submissions/{id}/correct
Teacher Correction (`assessment_tools.py` :: admin_correct_submission — full audit record,
     ↓             original Gemini extraction preserved, locked after award)
Automatic Recalculation (same deterministic engine, immediately re-persisted)
     ↓
Teacher Approval — award / bulk-award (needs_review, scored, reviewed all actionable)
     ↓
WalletService.credit  (exact persisted pointsEarned incl. half-points;
     ↓                idempotency_key = assessment_award:{submissionId})
Push Notification (`fan_out_push`) — fires ONLY after confirmed wallet credit
     ↓
Student Result (honest states: submitted/needs_review → "waiting for approval";
                awarded → "🎉 Points awarded" only after real credit)

Deletion: DELETE /api/admin/assessments/submissions/{id} → really deletes the R2 object,
refuses for awarded submissions (financial audit history preserved).
