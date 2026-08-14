# EduHub Assessment Lab — Final Surgical Repair

One surgical patch, isolated to the Assessment Lab and the single shared fix it genuinely
required (a one-function wallet amount-coercion bug). Apply the files in this ZIP onto the
same relative paths in your repositories.

---

## 1. ROOT CAUSE (evidence-based, from the actual repositories)

Four independent, confirmed defects combined to produce the reported behavior
(missed physical answers → misleading Author Studio data → dead `needs_review`
submissions → wrong/silently-truncated awards):

1. **Extraction prompt told Gemini to OMIT blank/illegible answers**
   (`assessment_ai_provider.py`, `_submission_prompt`: *"If a question was left blank or is
   illegible, omit it from the output rather than guessing"*). A question Gemini failed to
   read was therefore indistinguishable from a genuinely blank one, carried no uncertainty
   signal, and simply vanished from `extractedAnswers`. This is exactly the stu011 screenshot:
   `sheep — (blank) — 28/30 — NEEDS_REVIEW` with no way to know Gemini missed a real mark.

2. **Model:** submission extraction ran on `gemini-2.5-flash` (`DEFAULT_MODEL`), not
   Gemini 2.5 Pro, and the model used was never persisted in the extraction metadata.

3. **`WalletService._coerce_amount` silently truncated floats:** `int(13.5) == 13`.
   A 13.5-point calculated award credited 13 points with no error. (Verified against the
   real `WalletService` + real MongoDB in `tests/backend/test_assessment_award_real_wallet.py`.)

4. **`needs_review` was a dead end in Author Studio:** the Award button and the bulk-award
   checkbox only rendered for `scored`/`reviewed` (`AssessmentReviewStudio.jsx`), and the
   teacher-correction backend endpoint (`POST .../correct`) had **no UI at all**. Worse, a
   correction overwrote `extractedAnswers` in place, destroying the original Gemini
   extraction (no audit trail).

Additional confirmed UX defects: the student Assessment surface hardcoded `text-white`
utilities (unreadable in Day Mode), and the submission flow was a single anonymous spinner.

**Already correct in the repo (verified, NOT re-implemented):** R2-only immutable storage
with sha256 content-addressed keys (identical re-uploads never duplicate R2 objects,
HEAD-before-PUT), real R2 object deletion on submission delete, awarded-submission delete
guard (financial audit history preserved), award→wallet→push ordering (push fires only
after confirmed credit), wallet idempotency (`assessment_award:{submissionId}`),
deterministic scoring separate from Gemini.

---

## 2. CHANGED FILES

### backend/ (apply to backend repo root)
| File | Change |
|---|---|
| `assessment_ai_provider.py` | Gemini **2.5 Pro** for physical-worksheet extraction (`DEFAULT_SUBMISSION_MODEL="gemini-2.5-pro"`, env-overridable via `ASSESSMENT_AI_SUBMISSION_MODEL`); rewritten physical-evidence prompt (read marks, never infer; one entry per qid; `answer_state answered/blank/uncertain`; confidence); focused **verification second pass** for missing/uncertain/low-confidence qids only; returns `model` + `verification` metadata; mock updated. |
| `assessment_schema.py` | `ANSWER_STATES`; `normalize_extracted_submission_answers(..., fill_missing=True)` — every known qid explicitly represented (missing → `uncertain`, `source:"missing"`), qid-keyed (alignment-safe), ordered by the assessment's own question order; submission doc gains `originalExtractedAnswers` + `extraction`. |
| `assessment_scoring.py` | Answer-state-aware deterministic scoring: `blank` = definite incorrect (valid + awardable, no forced review); `uncertain`/missing = incorrect + `needsReview` (never scored correct even if the guess matches); low-confidence answered = scored + `needsReview`; adds `answeredCount/blankCount/uncertainCount`. Pure stdlib, fully reproducible from persisted data. |
| `assessment_tools.py` | Persists extraction audit (`engine`, `model`, `extractedAt`, raw/normalized counts, `verification`) and a frozen `originalExtractedAnswers`; teacher corrections now stored as full records `{qid, previousAnswer, previousState, answer, correctedBy, correctedAt}`, applied to `extractedAnswers` with `source:"teacher"`/confidence 1.0, immediate deterministic rescore, original Gemini extraction never touched; corrections locked after award (409); award path explicitly allows `needs_review`/`scored`/`reviewed` and rejects anything else (`not_awardable`, 409). |
| `wallet_service.py` | `_coerce_amount` only: whole points stay exact ints; **half-point values (13.5) preserved exactly** instead of silently truncated; any other fractional granularity still rejected. No other wallet code touched — idempotency, transactions, ledger untouched. |

### frontend/ (apply to frontend/PWA repo root)
| File | Change |
|---|---|
| `src/studio/AssessmentReviewStudio.jsx` | Per-question review table now shows given answer + physical `answer_state` badge + heat-colored confidence pill (`data-confidence-band` high/good/low/critical — weak readings jump out before awarding) + teacher-source badge; **inline "Apply Correction" editor** per row (calls `/correct`, auto-refreshes with the recalculated score); **correction-history timeline** (who changed what and when, legacy records tolerated); "View original paper (R2 evidence)" link; delete control (confirm dialog; hidden for awarded rows); Award button now on `needs_review` too and shows the exact amount ("Award 13.5 pts"); bulk-award checkbox enabled for `needs_review`; extraction meta line shows engine + model + timestamp + verification info; **"Real Extraction Check" staging panel** (upload a worksheet → one real Gemini 2.5 Pro read → real-vs-baseline comparison with mismatches/unreadable lists and score preview). |
| `src/studio/api.js` | Added `deleteAssessmentSubmission` and `runAssessmentExtractionCheck`. |
| `src/eduhub/pages/assessments/SubmitAssessmentModal.jsx` | Immersive staged submission journey (Uploading → Reading your answers → Checking → Calculating) with animated icons, shimmer progress, pulse rings — only the real server response ever ends the journey; honest result copy ("pts **calculated**", "Teacher review" pill, "waiting for your teacher's approval — nothing has been credited yet"); theme-token gold. |
| `src/eduhub/pages/assessments/AssessmentsListPage.jsx` | `asmt-theme` Day-Mode wrapper; token-based gold; "🎉 Points awarded" state label. |
| `src/eduhub/pages/assessments/assessments.css` | Day Mode fixed at the theme-system level: `.asmt-theme` remaps the feature's white-alpha utilities onto the app's real `--eh-ink-*` / `--eh-border-*` / `--eh-surface-*` tokens under `html[data-theme="light"]` (dark mode byte-identical); progress/shimmer/pop animations; full `prefers-reduced-motion` support. |

### tests/
- `tests/backend/test_assessment_lab_repair.py` (**new**, 15 tests) — the required regression suite: perfect 30/30→15; explicit blanks 28/30→14 valid+awardable; Gemini false negative → teacher corrects → 29/30→14.5→15 with original extraction preserved + teacher identity/timestamp; uncertain never auto-correct; **q8 unreadable never shifts q9**; multiple corrections; exact fractional award (wallet receives 13.5, never 13/15/27); `_coerce_amount` half-point contract; needs_review awardable + duplicate award credits zero; processing/failed not awardable; failed wallet credit → NOT awarded + NO notification → clean retry; corrections locked after award; extraction metadata (engine/model/timestamp); prompt demands physical evidence + per-qid states; verification pass re-checks only suspect qids; bulk award mixed statuses credits exact per-student amounts.
- `tests/backend/test_assessment_award_real_wallet.py` (**new**) — integration against the **real WalletService + real MongoDB**: credits exactly 13.5, duplicate credits zero, whole+half points coexist. (Auto-skips without a local MongoDB.)
- `tests/backend/test_assessment_tools.py` (updated: extraction-meta assertion now covers the richer audit shape) and `tests/backend/test_assessment_ai_provider_prompts.py` (unchanged, included for completeness).
- `tests/frontend/AssessmentReviewStudio.test.jsx` (updated + 4 new tests: needs_review has its own Award button; inline correction flow hits the backend and refreshes; R2 evidence link + model shown; delete asks confirmation, awarded rows have no delete control).
- `tests/frontend/SubmitAssessmentModal.test.jsx` (updated honest-copy assertions + new staged-progress test).

**Apply tests to:** backend repo `tests/`, frontend repo `src/studio/__tests__/` and
`src/eduhub/pages/assessments/__tests__/` respectively (paths in each file header).

---

## 3. ARCHITECTURE IMPACT

```
ORIGINAL STUDENT PAPER ──▶ R2 (immutable, sha256-deduped, teacher-visible evidence link)
        └▶ Gemini 2.5 Pro (read physical marks ONLY; never infer)
               └▶ STRUCTURED EXTRACTION (one entry per qid: answered|blank|uncertain + confidence)
                      └▶ VERIFICATION PASS (2.5 Pro, suspect qids only, auditable)
                             └▶ originalExtractedAnswers (frozen forever)
                                    └▶ TEACHER CORRECTION (full audit record) ─▶ extractedAnswers
                                           └▶ DETERMINISTIC SCORING (answer key = truth) ─▶ auto recalc
                                                  └▶ TEACHER APPROVAL (individual/bulk; needs_review included)
                                                         └▶ WalletService (exact points, idempotent)
                                                                └▶ PUSH (only after confirmed credit)
                                                                       └▶ STUDENT RESULT (honest states)
```
- No new collections, no new points system, no new notification system, no new storage path.
- Gemini never determines points; the frontend never computes points; AI scores are never authoritative.
- New optional env var: `ASSESSMENT_AI_SUBMISSION_MODEL` (defaults to `gemini-2.5-pro`).

## 4. MIGRATION REQUIREMENTS

None destructive. Existing submissions keep working:
- Docs without `answerState` score exactly as before (legacy branch in scoring).
- Docs without `originalExtractedAnswers` are backfilled from `extractedAnswers` on the
  first teacher correction.
- Wallet: no schema change; balances may now legitimately hold .5 values (Mongo numeric).

## 5. TEST RESULTS (verified locally — NOT against production)

- Backend full regression: **2711 passed, 65 skipped, 0 failed**
  (5 `test_video_render_tools.py` tests excluded — they require ffmpeg/ffprobe binaries
  absent in the sandbox; unrelated to this patch and unmodified).
- Backend assessment suites (`test_assessment_lab_repair.py` — now 17 tests incl. the
  extraction-check diagnostic — + `test_assessment_tools.py`
  + `test_assessment_ai_provider_prompts.py`): **56 passed**.
- Real-wallet integration (`test_assessment_award_real_wallet.py`): **1 passed** against a
  live local MongoDB — exact 13.5 credit + idempotent duplicate.
- Frontend Assessment + Author Studio suites: **49 passed, 0 failed**
  (`AssessmentsListPage`, `SubmitAssessmentModal`, `useAssessmentBadge`, `assessmentApi`,
  `AssessmentReviewStudio` — incl. confidence heatmap, correction-history timeline and
  extraction-check panel tests).
- Frontend full regression: **2529 tests / 188 suites passed**.
- Frontend production build: `yarn build` — compiled successfully (see report).

## 6. GEMINI TESTING MODE

Per instruction, Gemini calls were exercised via the deterministic mock/stub layer
(`ASSESSMENT_AI_MOCK` / monkeypatched `_call_gemini_json`) — no production key was used.
The production path is fully implemented for `gemini-2.5-pro` (both extraction and
verification passes) and the exact model used is persisted per submission in
`submission.extraction.model`.

## 7. KNOWN LIMITATIONS (genuine)

- **No live browser verification against production** — no production credentials/URLs were
  available. Live PWA/Author Studio flows were verified via component tests (jsdom), not a
  real authenticated browser session.
- **No real Gemini 2.5 Pro extraction was executed** (no API key, by instruction). Prompt
  behavior on real worksheets should be spot-checked on staging after deploy.
- **R2 verified via existing test doubles**, not against a live bucket (by instruction).
- Wallet fractional support is deliberately limited to **half-point granularity**; other
  fractions are still rejected — widen `_coerce_amount` if future assessments need it.
- Author Studio remains a dark-theme surface (as designed); the Day-Mode fix targets the
  student PWA Assessment surfaces which are theme-switchable.
- Commit hashes: not applicable — no git access was provided; this ZIP **is** the patch.

## 8. DEPLOYMENT NOTES

1. Copy `backend/*` over the backend repo root; copy `frontend/src/**` over the frontend repo.
2. Place tests as described above; run `pytest tests/ -q` and
   `CI=true craco test --watchAll=false`.
3. Optionally set `ASSESSMENT_AI_SUBMISSION_MODEL` (defaults to `gemini-2.5-pro`).
4. No DB migration, no dependency changes, no supervisor/config changes.
