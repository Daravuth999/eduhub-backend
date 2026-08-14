# EduHub Assessment Lab — Surgical Repair (PRD / Memory)

## Original Problem Statement
User supplied their full EduHub frontend/PWA + backend repos (ZIPs) and a physical
worksheet PDF ("Long–Short Sound", sheep/ship, 30 questions × 0.5 pts). Confirmed bug
class: Gemini missed physically-marked answers, extracted answers misrepresented the
paper, submissions stuck in needs_review with no actionable path, teacher corrections
missing in UI, awards must credit the exact deterministic score. Deliverable: ONE ZIP
(EduHub_Assessment_Lab_Final_Surgical_Repair.zip) — no GitHub access, no production
credentials; Gemini mocked (option C), R2 stubbed (option B), local Mongo for testing.

## Repos location in this pod
- /app/eduhub/backend (FastAPI, assessment_* modules, wallet_service.py, 2700+ tests)
- /app/eduhub/frontend (CRA/craco PWA, src/eduhub/pages/assessments, src/studio)
- ZIP staging: /app/eduhub/zip_stage ; final ZIP also at /app/frontend/public/

## Root causes found (2026-06-XX, verified in source)
1. Extraction prompt told Gemini to OMIT blank/illegible answers (no answer_state).
2. Submission extraction used gemini-2.5-flash; model never persisted.
3. WalletService._coerce_amount did int(13.5)==13 — silent fractional truncation.
4. needs_review dead end in Author Studio (award/checkbox only scored/reviewed);
   /correct endpoint had no UI; corrections destroyed original Gemini extraction.
5. Day Mode: hardcoded text-white utilities in student Assessment surfaces.

## Implemented (all verified locally)
- Gemini 2.5 Pro for submissions (ASSESSMENT_AI_SUBMISSION_MODEL env, default pro);
  physical-evidence-only prompt, one entry per qid, answered/blank/uncertain + confidence;
  verification second pass for suspect qids only; model+timestamp persisted.
- normalize fill_missing=True: every qid explicitly represented, qid-keyed (no shifting).
- Scoring: blank=definite incorrect (awardable); uncertain/missing=needsReview, never
  auto-correct; counts answered/blank/uncertain.
- originalExtractedAnswers frozen; teacherCorrections full audit records; corrections
  locked after award (409); auto rescore on correct.
- Award allows needs_review/scored/reviewed; exact fractional credit (wallet half-point
  support); idempotency intact; push only after confirmed credit (pre-existing, tested).
- Author Studio: inline correction UI, R2 evidence link, delete control (awarded rows
  protected), model shown, Award shows exact pts, bulk incl. needs_review.
- Student UX: staged progress journey, honest copy, Day Mode via .asmt-theme token remap.
- (Round 2) Real Extraction Check: POST /api/admin/assessments/{id}/extraction-check —
  staging-only real Gemini 2.5 Pro read vs answer-key baseline, read-only diagnostic,
  503 without credential; Studio panel with mismatches/unreadable/score preview.
- (Round 2) Confidence heatmap pills (high/good/low/critical bands) in review table.
- (Round 2) Correction-history timeline (who/what/when, legacy records tolerated).

## Test results
- Backend: 2709 passed / 65 skipped / 0 failed (5 ffmpeg-env video tests excluded).
- Real-wallet Mongo integration: 13.5 exact + idempotent duplicate — passed.
- Frontend: 2525 tests / 188 suites all passed; yarn build compiled successfully.

## Not verified (honest limitations)
- No production browser verification, no real Gemini call, no live R2 (per user options).

## Backlog / next
- P1: staging spot-check of real Gemini 2.5 Pro extraction on the supplied worksheet PDF.
- P2: teacher-facing side-by-side original-paper + answers overlay in Studio.
- P2: per-question confidence heatmap in Studio review table.
