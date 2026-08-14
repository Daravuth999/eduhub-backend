/**
 * tuitionPayment.test.js — Gate 11 frontend tests (source-inspection)
 *
 * TuitionPaymentModal — Gate 3 (sessionStorage stores receipt_id only)
 * TuitionReminderOverlay — Gate 2 (server-controlled eligibility)
 * TuitionStrip — Gate 3 (unacknowledged check + fetchReceiptById)
 */
import fs from "fs";
import path from "path";

const ROOT = path.resolve(__dirname, "../../../../../../../");
const DASH = "eduhub/pages/portal/components/dashboard";

function readSrc(relPath) {
  return fs.readFileSync(path.resolve(ROOT, "src", relPath), "utf8");
}

/* ═══════════════════════════════════════════════════════
   1. TuitionPaymentModal — Gate 3: sessionStorage contract
   ═══════════════════════════════════════════════════════ */
describe("1. TuitionPaymentModal — sessionStorage stores only receipt_id (Gate 3)", () => {
  let src;
  beforeAll(() => { src = readSrc(`${DASH}/TuitionPaymentModal.jsx`); });

  test("saveTuitionReceipt stores only receipt_id, not a full object", () => {
    // Must wrap the value in { receipt_id: receiptId }
    expect(src).toMatch(/saveTuitionReceipt\s*\(receiptId\)/);
    expect(src).toMatch(/receipt_id:\s*receiptId/);
    // Must NOT build a multi-field receipt object before calling setItem
    expect(src).not.toMatch(/amount_usd.*receipt_id.*method.*new_due_date/s);
  });

  test("consumeTuitionReceipt returns the receipt_id string, not the raw object", () => {
    // Must extract receipt_id from the parsed object
    expect(src).toMatch(/parsed\?\.receipt_id/);
  });

  // NOTE: startPoll/manualCheck/resumeIntent's three near-identical success
  // sequences (haptic + phase + sessionStorage + delayed onConfirmed) were
  // consolidated into one shared enterDone(receiptId) — added when the
  // success-reveal steps and haptic.success() call were introduced, so that
  // behavior lives in exactly one place. The contract these tests enforce
  // (receipt_id only, never a full object) is unchanged; they now verify it
  // through enterDone's own definition plus every call site feeding it.
  test("poll path calls enterDone(data.receipt_id) — receipt_id only, not a full object", () => {
    expect(src).toMatch(/enterDone\(data\.receipt_id\)/);
  });

  test("manual-check path also calls enterDone(data.receipt_id)", () => {
    // Two occurrences: one in startPoll, one in manualCheck — both feed the
    // same shared success handler with the receipt_id string only.
    const matches = (src.match(/enterDone\(data\.receipt_id\)/g) || []).length;
    expect(matches).toBeGreaterThanOrEqual(2);
  });

  test("enterDone saves receipt_id directly and calls onConfirmed with the receipt_id string, not a receipt object", () => {
    const idx = src.indexOf("const enterDone");
    const body = src.slice(idx, idx + 700);
    expect(body).toMatch(/saveTuitionReceipt\(receiptId\)/);
    expect(body).toMatch(/onConfirmed\?\.\(receiptId\)/);
  });

  test("no locally-constructed receipt object is passed to saveTuitionReceipt", () => {
    // Must not call saveTuitionReceipt(receipt) where receipt is a local object
    expect(src).not.toMatch(/saveTuitionReceipt\s*\(\s*receipt\s*\)/);
  });

  test("exports both saveTuitionReceipt and consumeTuitionReceipt", () => {
    expect(src).toMatch(/export function saveTuitionReceipt/);
    expect(src).toMatch(/export function consumeTuitionReceipt/);
  });
});

/* ═══════════════════════════════════════════════════════════════════
   2. TuitionReminderOverlay — Gate 2: server-controlled eligibility
   ═══════════════════════════════════════════════════════════════════ */
describe("2. TuitionReminderOverlay — server-controlled, full-screen (Gate 2)", () => {
  let src;
  beforeAll(() => { src = readSrc(`${DASH}/TuitionReminderOverlay.jsx`); });

  test("calls GET /api/tuition/reminder/me (not /api/student/tuition)", () => {
    expect(src).toMatch(/\/api\/tuition\/reminder\/me/);
    // Must NOT independently fetch raw tuition status for client-side eligibility
    expect(src).not.toMatch(/\/api\/student\/tuition['"`]/);
  });

  test("shows overlay only when server returns show: true", () => {
    expect(src).toMatch(/data\?\.show/);
    // Must check show before showing — not client-side eligibility logic
    expect(src).not.toMatch(/shouldShowReminder/);
  });

  test("does NOT implement client-side eligibility (no daysUntil, no SOON_DAYS)", () => {
    expect(src).not.toMatch(/function\s+shouldShowReminder/);
    expect(src).not.toMatch(/SOON_DAYS/);
    expect(src).not.toMatch(/function\s+daysUntil/);
  });

  test("renders server-provided bilingual copy (title_km, body_km, button_km)", () => {
    expect(src).toMatch(/payload\.title_km/);
    expect(src).toMatch(/payload\.body_km/);
    expect(src).toMatch(/payload\.button_km/);
  });

  test("dismiss_strategy=server calls POST /api/tuition/reminder/dismiss", () => {
    expect(src).toMatch(/dismiss_strategy/);
    expect(src).toMatch(/\/api\/tuition\/reminder\/dismiss/);
    expect(src).toMatch(/method:\s*["']POST["']/);
  });

  test("client snooze uses configurable snooze_hours from server payload", () => {
    expect(src).toMatch(/payload\?\.snooze_hours/);
  });

  test("is a full-screen takeover (fixed inset-0), not a bottom sheet", () => {
    expect(src).toMatch(/fixed inset-0/);
    // Must dim entire screen with backdrop
    expect(src).toMatch(/backdropFilter.*blur/);
  });

  test("accepts only isAuthed prop (no tuition data prop)", () => {
    expect(src).toMatch(/function TuitionReminderOverlay\s*\(\s*\{\s*isAuthed/);
    // Must NOT accept tuition or student props
    expect(src).not.toMatch(/function TuitionReminderOverlay.*tuition/);
  });

  test("does NOT store full receipt in sessionStorage", () => {
    expect(src).not.toMatch(/setItem.*receipt_id.*amount_usd/s);
  });
});

/* ════════════════════════════════════════════════════════════════
   3. TuitionStrip — Gate 3: API-fetched receipt, unacknowledged
   ════════════════════════════════════════════════════════════════ */
describe("3. TuitionStrip — Gate 3: fetchReceiptById + unacknowledged (Gate 3)", () => {
  let src;
  beforeAll(() => { src = readSrc(`${DASH}/TuitionStrip.tsx`); });

  test("defines fetchReceiptById helper that calls /api/student/tuition/receipt/{id}", () => {
    expect(src).toMatch(/async function fetchReceiptById/);
    expect(src).toMatch(/\/api\/student\/tuition\/receipt\//);
  });

  test("checks GET /api/student/tuition/unacknowledged on mount", () => {
    expect(src).toMatch(/\/api\/student\/tuition\/unacknowledged/);
  });

  test("consumeTuitionReceipt result feeds fetchReceiptById, not setReceipt directly", () => {
    // consumeTuitionReceipt now returns a string (receipt_id), not an object
    // So TuitionStrip must call fetchReceiptById with it
    expect(src).toMatch(/fetchReceiptById\s*\(\s*pendingId\s*\)/);
    // Must NOT call setReceipt(pending) with the raw sessionStorage value
    expect(src).not.toMatch(/setReceipt\s*\(\s*pending\s*\)/);
  });

  test("onConfirmed fetches receipt from API by receiptId", () => {
    expect(src).toMatch(/fetchReceiptById\s*\(\s*receiptId\s*\)/);
  });

  test("does NOT call consumeTuitionReceipt inside onConfirmed", () => {
    // The receipt_id is passed directly as the receiptId argument — no need
    // to re-read sessionStorage inside onConfirmed
    const onConfirmedBlock = src.slice(src.indexOf("onConfirmed="));
    const closeParen = onConfirmedBlock.indexOf("}}");
    const snippet = onConfirmedBlock.slice(0, closeParen + 2);
    expect(snippet).not.toMatch(/consumeTuitionReceipt/);
  });

  test("receipt state is populated from fetchReceiptById result, not from sessionStorage object", () => {
    // setReceipt must be called with the result of fetchReceiptById (wrapped in .then)
    expect(src).toMatch(/fetchReceiptById.*\.then.*setReceipt/s);
  });
});

/* ═══════════════════════════════════════════════════════════════════
   4. TuitionStrip — CTA state matrix and visual corrections
   ═══════════════════════════════════════════════════════════════════ */
describe("4. TuitionStrip — CTA state matrix and visual defect fixes", () => {
  let src;
  beforeAll(() => { src = readSrc(`${DASH}/TuitionStrip.tsx`); });

  /* ── No student-facing implementation labels ── */
  test("does not render GAS data label to student", () => {
    expect(src).not.toMatch(/GAS data/);
  });
  test("does not render mongo_shadow label to student", () => {
    expect(src).not.toMatch(/mongo_shadow/);
  });
  test("does not render 'Mongo data' label to student", () => {
    expect(src).not.toMatch(/["']Mongo data["']/);
  });
  test("uses student-facing subtitle: Monthly learning membership", () => {
    expect(src).toMatch(/Monthly learning membership/);
    expect(src).toMatch(/សមាជិកភាពសិក្សាប្រចាំខែ/);
  });

  /* ── No duplicate LearningAccessSection strip ── */
  test("does not JSX-render LearningAccessSection (eliminates duplicate paid strip)", () => {
    // JSX usage would re-introduce TuitionCountdown "TUITION: PAID" duplicate
    expect(src).not.toMatch(/<LearningAccessSection/);
  });
  test("does not import LearningAccessSection", () => {
    expect(src).not.toMatch(/import.*LearningAccessSection/);
  });

  /* ── payment_action is backend-authoritative ── */
  test("reads payment_action from backend mongo response", () => {
    expect(src).toMatch(/payment_action/);
    expect(src).toMatch(/mongo\?\.payment_action/);
  });
  test("canPay derives from payment_action pay_now — not from date math", () => {
    expect(src).toMatch(/canPay\s*=\s*paymentAction\s*===\s*["']pay_now["']/);
    // Must NOT use serverCanPay !== undefined fallback with isPaid logic
    expect(src).not.toMatch(/serverCanPay\s*!==\s*undefined/);
    expect(src).not.toMatch(/!\s*isPaid\s*\|\|\s*isNewCycle/);
  });
  test("no isNewCycle const used for payment authorization", () => {
    // isNewCycle must not appear as a payment gate (only inline in dayLabel is OK)
    expect(src).not.toMatch(/const\s+isNewCycle/);
    expect(src).not.toMatch(/canPay.*isNewCycle|isNewCycle.*canPay/s);
  });
  test("isOverdue used for display only, not for canPay authorization", () => {
    expect(src).toMatch(/isOverdue/); // still exists for badge color display
    // canPay assignment must not reference isOverdue
    expect(src).not.toMatch(/const\s+canPay\s*=.*isOverdue/);
  });
  test("canPayAhead derives from payment_action pay_early", () => {
    expect(src).toMatch(/canPayAhead\s*=\s*paymentAction\s*===\s*["']pay_early["']/);
  });
  test("hasPendingIntent derives from payment_action resume_payment", () => {
    expect(src).toMatch(/hasPendingIntent\s*=\s*paymentAction\s*===\s*["']resume_payment["']/);
  });
  test("isManualReview derives from payment_action under_review", () => {
    expect(src).toMatch(/isManualReview\s*=\s*paymentAction\s*===\s*["']under_review["']/);
  });

  /* ── CTA: overdue / due-soon / due-today shows Pay Tuition button ── */
  test("Pay Tuition CTA renders when canPay is true", () => {
    expect(src).toMatch(/canPay/);
    expect(src).toMatch(/tuition-pay-btn/);
    // Bilingual label
    expect(src).toMatch(/បង់ថ្លៃសិក្សា/);
    expect(src).toMatch(/Pay Tuition/);
  });
  test("Pay Tuition button opens TuitionPaymentModal (setPayOpen true)", () => {
    expect(src).toMatch(/setPayOpen\s*\(\s*true\s*\)/);
  });

  /* ── CTA: pending intent shows Resume Payment ── */
  test("pending intent renders Resume Payment CTA", () => {
    expect(src).toMatch(/hasPendingIntent/);
    expect(src).toMatch(/tuition-resume-payment-btn/);
    expect(src).toMatch(/Resume Payment/);
    expect(src).toMatch(/បន្តការបង់ប្រាក់/);
  });
  test("hasPendingIntent derives from payment_action resume_payment", () => {
    // payment_action is backend-authoritative — no client pending_intent_id check
    expect(src).toMatch(/hasPendingIntent\s*=\s*paymentAction\s*===\s*["']resume_payment["']/);
  });

  /* ── CTA: manual review prevents duplicate intent ── */
  test("manual review state shows notice (not a pay button)", () => {
    expect(src).toMatch(/isManualReview/);
    expect(src).toMatch(/tuition-manual-review-notice/);
    expect(src).toMatch(/Payment under review/);
  });
  test("manual review checks payment_action under_review", () => {
    expect(src).toMatch(/isManualReview\s*=\s*paymentAction\s*===\s*["']under_review["']/);
  });

  /* ── CTA: paid-ahead ── */
  test("canPayAhead state renders Pay Next Month Early CTA", () => {
    expect(src).toMatch(/tuition-pay-ahead-btn/);
    expect(src).toMatch(/Pay Next Month Early/);
  });

  /* ── CTA: paid current cycle, no advance ── */
  test("paid with no further action shows paid notice (not hidden silently)", () => {
    expect(src).toMatch(/tuition-paid-notice/);
    expect(src).toMatch(/Tuition paid for this cycle|Next payment available/);
  });

  /* ── feature_enabled gate ── */
  test("feature_enabled=false hides all CTAs", () => {
    expect(src).toMatch(/featureEnabled/);
    expect(src).toMatch(/feature_enabled/);
    // renderCTA returns null when !featureEnabled
    expect(src).toMatch(/if\s*\(\s*!featureEnabled\s*\)/);
  });

  /* ── ?tuition=pay deep-link opens modal ── */
  test("?tuition=pay deep-link opens TuitionPaymentModal", () => {
    expect(src).toMatch(/tuitionParam.*===.*["']pay["']/);
    expect(src).toMatch(/setPayOpen\s*\(\s*true\s*\)/);
  });

  /* ── Server-authoritative amount displayed ── */
  test("payment amount sourced from mongo with GAS fallback", () => {
    expect(src).toMatch(/mongo\?\.payment_amount.*student\.PaymentAmount|payment_amount.*PaymentAmount/s);
  });

  /* ── View Receipts secondary action ── */
  test("View Receipts secondary action is present", () => {
    expect(src).toMatch(/tuition-view-receipts-btn/);
    expect(src).toMatch(/View Receipts/);
    expect(src).toMatch(/មើលបង្កាន់ដៃ/);
  });

  /* ── Contrast: no near-white text on light surface ── */
  test("does not use rgba(248,250,252) muted text on light background", () => {
    // The old MUTED token caused white text on near-white surface
    expect(src).not.toMatch(/rgba\(248,250,252/);
  });
  test("uses accessible dark fallback for primary text", () => {
    // Must not use #f8fafc (near-white) as a text fallback
    expect(src).not.toMatch(/#f8fafc/);
    // Must use a dark fallback — either a hex color or a CSS variable (theme-adaptive)
    expect(src).toMatch(/#1e293b|#0f172a|#374151|var\(--color-ink\)/);
  });

  /* ── Minimum tap target ── */
  test("pay buttons have minHeight 44px or greater", () => {
    expect(src).toMatch(/minHeight.*4[48]|minHeight.*5[0-9]/);
  });

  /* ── Past due date with paid status — backend must return pay_now ── */
  test("paid+expired cycle shows overdue wording in dayLabel (display only)", () => {
    // dayLabel uses isPaid && days < 0 inline for wording, not for auth
    expect(src).toMatch(/isPaid.*&&.*days\s*<\s*0/);
    expect(src).toMatch(/new billing cycle/);
  });
});

/* ═══════════════════════════════════════════════════════════════════════════
   6. Gate 12: premium card + persistent receipt + NaN-safe date parsing
   ═══════════════════════════════════════════════════════════════════════════ */
describe("6. Gate 12 — premium card, NaN-safe dates, persistent receipt overlay", () => {
  let strip;
  let overlay;
  beforeAll(() => {
    strip   = readSrc(`${DASH}/TuitionStrip.tsx`);
    overlay = readSrc(`${DASH}/TuitionReceiptOverlay.jsx`);
  });

  /* ── TuitionStrip: NaN-safe date parsing ── */
  test("parseTuitionDate guards isNaN(d.getTime()) — no NaN propagation", () => {
    expect(strip).toMatch(/isNaN\s*\(\s*d\.getTime\(\)\s*\)/);
  });
  test("dayLabel returns 'Payment date unavailable' for null days", () => {
    expect(strip).toMatch(/Payment date unavailable/);
  });
  test("invalid date never produces NaN string in rendered output", () => {
    // Verify the guard exists and NaN string never appears
    expect(strip).not.toMatch(/NaN days/);
    expect(strip).not.toMatch(/"NaN"/);
    expect(strip).toMatch(/Payment date unavailable/);
  });
  test("formatDueDate returns 'Payment date unavailable' for unparseable date", () => {
    // formatDueDate must call parseTuitionDate and return the unavailable string
    expect(strip).toMatch(/return "Payment date unavailable"/);
  });

  /* ── TuitionStrip: unacknowledged endpoint fix ── */
  test("unacknowledged response parsed as data?.pending?.receipt_id (not flat)", () => {
    expect(strip).toMatch(/data\?\.pending\?\.receipt_id/);
    // Must NOT use flat data?.receipt_id anywhere (old bug)
    expect(strip).not.toMatch(/data\?\.receipt_id\b/);
  });

  /* ── TuitionStrip: framer-motion + premium design ── */
  test("useReducedMotion imported in TuitionStrip", () => {
    expect(strip).toMatch(/useReducedMotion/);
    expect(strip).toMatch(/from\s+["']framer-motion["']/);
  });
  test("animated gradient border uses motion.div with backgroundPosition", () => {
    expect(strip).toMatch(/backgroundPosition/);
    expect(strip).toMatch(/motion\.div/);
  });
  test("CTA pay buttons use motion.button for glow hover", () => {
    expect(strip).toMatch(/motion\.button/);
    expect(strip).toMatch(/whileHover/);
  });
  test("prefers-reduced-motion disables animations (reduce guard present)", () => {
    expect(strip).toMatch(/const\s+reduce\s*=\s*useReducedMotion/);
    expect(strip).toMatch(/reduce\s*\?\s*\{\}/);
  });

  /* ── TuitionStrip: billing_anchor_day on card ── */
  test("billing_anchor_day in MongoTuition interface", () => {
    expect(strip).toMatch(/billing_anchor_day\?/);
  });
  test("billingDay derived from mongo or nextDueDate fallback", () => {
    expect(strip).toMatch(/billing_anchor_day.*parseDayOfMonth|billingDay\s*=/s);
  });
  test("billing anchor day displayed on card (ordinal label)", () => {
    expect(strip).toMatch(/Billing day/);
    expect(strip).toMatch(/ordinal\s*\(/);
    expect(strip).toMatch(/of each month/);
  });

  /* ── TuitionStrip: no generic "Pay Now" label ── */
  test("no generic 'Pay Now' CTA label — only bilingual Pay Tuition", () => {
    expect(strip).not.toMatch(/["'>]Pay Now["'<]/);
    expect(strip).toMatch(/Pay Tuition/);
    expect(strip).toMatch(/បង់ថ្លៃសិក្សា/);
  });

  /* ── TuitionReceiptOverlay: X close does NOT acknowledge ── */
  test("handleClose does NOT call acknowledge (X just closes)", () => {
    // Find handleClose definition and verify no acknowledge call inside it
    const closeIdx = overlay.indexOf("const handleClose");
    expect(closeIdx).toBeGreaterThan(-1);
    // Grab the short block: up to the next const or 300 chars
    const snippet = overlay.slice(closeIdx, closeIdx + 300);
    expect(snippet).not.toMatch(/acknowledge\s*\(/);
    expect(snippet).toMatch(/onClose\?\.\s*\(\)/);
  });
  test("handleAcknowledge is separate function (only Confirm calls it)", () => {
    expect(overlay).toMatch(/const handleAcknowledge/);
    expect(overlay).toMatch(/await acknowledge\s*\(\s*receipt_id\s*\)/);
  });

  /* ── TuitionReceiptOverlay: premium design + all fields ── */
  test("useReducedMotion imported in TuitionReceiptOverlay", () => {
    expect(overlay).toMatch(/useReducedMotion/);
    expect(overlay).toMatch(/from\s+["']framer-motion["']/);
  });
  test("Confirm button text contains both Khmer and English", () => {
    expect(overlay).toMatch(/បញ្ជាក់/);
    expect(overlay).toMatch(/Confirm/);
    expect(overlay).toMatch(/tuition-receipt-confirm-btn/);
  });
  test("receipt overlay header: ការបង់ថ្លៃសិក្សាបានជោគជ័យ", () => {
    expect(overlay).toMatch(/ការបង់ថ្លៃសិក្សាបានជោគជ័យ/);
  });
  test("Tuition payment confirmed badge present", () => {
    expect(overlay).toMatch(/Tuition payment confirmed/);
  });
  test("billing_anchor_day displayed in receipt overlay", () => {
    expect(overlay).toMatch(/billing_anchor_day|billingAnchorDay/);
    expect(overlay).toMatch(/Billing day/);
    expect(overlay).toMatch(/ordinal\s*\(/);
    expect(overlay).toMatch(/of each month/);
  });
  test("prev_due_date displayed as billing period", () => {
    expect(overlay).toMatch(/prev_due_date/);
    expect(overlay).toMatch(/Billing period/);
  });
  test("reference field displayed in receipt", () => {
    expect(overlay).toMatch(/reference/);
    expect(overlay).toMatch(/Reference/);
  });
  test("On-time appreciation reward label present", () => {
    expect(overlay).toMatch(/On-time appreciation reward/);
  });
  test("reward_status field used (credited vs processing display)", () => {
    expect(overlay).toMatch(/reward_status/);
    expect(overlay).toMatch(/credited/);
    expect(overlay).toMatch(/[Pp]rocessing/);
  });
  test("receipt overlay does NOT use Top-Up wording", () => {
    expect(overlay).not.toMatch(/\bPackage\b/);
    expect(overlay).not.toMatch(/Base points/);
    expect(overlay).not.toMatch(/Bonus points/);
  });
  test("serrated receipt edge present (SerratedEdge SVG)", () => {
    expect(overlay).toMatch(/SerratedEdge/);
    expect(overlay).toMatch(/viewBox/);
  });
  test("light sweep animation in overlay", () => {
    expect(overlay).toMatch(/Light sweep|light sweep|skewX/i);
  });
  test("student clean_id displayed in receipt", () => {
    expect(overlay).toMatch(/clean_id/);
    expect(overlay).toMatch(/Student ID/);
  });
});

/* ═══════════════════════════════════════════════════════════════════════
   5. TuitionStrip — backend payment_action contract (Gate 11)
   ═══════════════════════════════════════════════════════════════════════ */
describe("5. TuitionStrip — backend payment_action contract", () => {
  let src;
  beforeAll(() => { src = readSrc(`${DASH}/TuitionStrip.tsx`); });

  /* ── Core contract: payment_action drives every CTA decision ── */
  test("paymentAction variable reads from mongo?.payment_action", () => {
    expect(src).toMatch(/const\s+paymentAction\s*=\s*mongo\?\.payment_action/);
  });

  test("no client-side canPay fallback using date arithmetic", () => {
    // Old pattern: canPay = serverCanPay !== undefined ? serverCanPay : (!isPaid || isNewCycle)
    // New pattern: canPay = paymentAction === "pay_now"  — no date math
    expect(src).not.toMatch(/serverCanPay\s*!==\s*undefined/);
    expect(src).not.toMatch(/!\s*isPaid\s*\|\|\s*isNewCycle/);
    expect(src).not.toMatch(/canPay.*serverCanPay.*undefined/s);
  });

  test("no isNewCycle const (authorization gate removed)", () => {
    // isNewCycle was the client-side authorization gate — must be gone
    expect(src).not.toMatch(/const\s+isNewCycle/);
  });

  test("isPaid && days < 0 only appears inside dayLabel display function", () => {
    // Verify the pattern exists somewhere (dayLabel wording — display only)
    expect(src).toMatch(/isPaid.*&&.*days\s*<\s*0/);
    // canPay assignment must not involve isPaid or day arithmetic (single-line check)
    expect(src).not.toMatch(/const\s+canPay\s*=.*isPaid/);
    expect(src).not.toMatch(/const\s+canPay\s*=.*days\s*<\s*0/);
  });

  /* ── Each payment_action maps to the correct testid ── */
  test("pay_now action renders tuition-pay-btn", () => {
    expect(src).toMatch(/paymentAction\s*===\s*["']pay_now["']/);
    expect(src).toMatch(/tuition-pay-btn/);
    expect(src).toMatch(/បង់ថ្លៃសិក្សា/);
    expect(src).toMatch(/Pay Tuition/);
  });

  test("pay_early action renders tuition-pay-ahead-btn", () => {
    expect(src).toMatch(/paymentAction\s*===\s*["']pay_early["']/);
    expect(src).toMatch(/tuition-pay-ahead-btn/);
    expect(src).toMatch(/Pay Next Month Early/);
  });

  test("resume_payment action renders tuition-resume-payment-btn", () => {
    expect(src).toMatch(/paymentAction\s*===\s*["']resume_payment["']/);
    expect(src).toMatch(/tuition-resume-payment-btn/);
    expect(src).toMatch(/Resume Payment/);
  });

  test("under_review action renders tuition-manual-review-notice", () => {
    expect(src).toMatch(/paymentAction\s*===\s*["']under_review["']/);
    expect(src).toMatch(/tuition-manual-review-notice/);
    expect(src).toMatch(/Payment under review/);
  });

  test("disabled action renders tuition-disabled-notice", () => {
    expect(src).toMatch(/paymentAction\s*===\s*["']disabled["']/);
    expect(src).toMatch(/tuition-disabled-notice/);
    expect(src).toMatch(/currently unavailable/);
  });

  test("unavailable or undefined falls through to tuition-paid-notice", () => {
    // The default/fallback branch (no matching payment_action) renders paid-notice
    expect(src).toMatch(/tuition-paid-notice/);
    expect(src).toMatch(/Tuition paid for this cycle|Next payment available/);
  });

  /* ── Intent safety: under_review must not open the payment modal ── */
  test("under_review notice has no onClick that opens modal", () => {
    // The manual-review div must not call setPayOpen
    const idx = src.indexOf("tuition-manual-review-notice");
    const snippet = src.slice(Math.max(0, idx - 200), idx + 300);
    expect(snippet).not.toMatch(/setPayOpen\s*\(\s*true\s*\)/);
  });

  test("disabled notice has no onClick that opens modal", () => {
    const idx = src.indexOf("tuition-disabled-notice");
    const snippet = src.slice(Math.max(0, idx - 200), idx + 300);
    expect(snippet).not.toMatch(/setPayOpen\s*\(\s*true\s*\)/);
  });

  /* ── Resume payment uses active_intent from backend ── */
  test("active_intent field is declared in MongoTuition interface", () => {
    expect(src).toMatch(/active_intent\?/);
  });

  /* ── payment_block_reason included in interface ── */
  test("payment_block_reason declared in MongoTuition interface", () => {
    expect(src).toMatch(/payment_block_reason/);
  });
});

/* ═══════════════════════════════════════════════════════════════════════
   6. TuitionStrip — state invariants, dark mode, receipt history (Gate 13)
   ═══════════════════════════════════════════════════════════════════════ */
describe("6. TuitionStrip — state invariants, dark mode, receipt history (Gate 13)", () => {
  let src;
  beforeAll(() => { src = readSrc(`${DASH}/TuitionStrip.tsx`); });

  /* ── Dark mode: CSS vars not hardcoded white ── */
  test("card surface uses var(--color-surface) for dark-mode adaptation", () => {
    expect(src).toMatch(/var\(--color-surface\)/);
    expect(src).not.toMatch(/rgba\(248,249,255,0\.97\)/);
  });

  test("primary text uses var(--color-ink)", () => {
    expect(src).toMatch(/var\(--color-ink\)/);
  });

  test("secondary text uses var(--color-ink-soft)", () => {
    expect(src).toMatch(/var\(--color-ink-soft\)/);
  });

  test("muted text / countdown fallback uses var(--color-ink-mute)", () => {
    expect(src).toMatch(/var\(--color-ink-mute\)/);
  });

  test("card header separator uses var(--color-line)", () => {
    expect(src).toMatch(/var\(--color-line\)/);
  });

  /* ── State invariants: unavailable is explicit, not the default ── */
  test("unavailable action has its own explicit branch with tuition-paid-notice", () => {
    expect(src).toMatch(/paymentAction\s*===\s*["']unavailable["']/);
    const unavIdx = src.indexOf('"unavailable"');
    const snippet  = src.slice(unavIdx, unavIdx + 600);
    expect(snippet).toMatch(/tuition-paid-notice/);
  });

  test("unavailable branch shows correct cycle-paid message", () => {
    expect(src).toMatch(/Paid for this cycle/);
  });

  /* ── Safety net: overdue + undefined paymentAction shows pay button ── */
  test("overdue safety net renders tuition-pay-btn when paymentAction is undefined", () => {
    // The final renderCTA fallback must check isOverdue before giving up
    expect(src).toMatch(/isOverdue[\s\S]{0,600}tuition-pay-btn/);
  });

  test("non-overdue unknown state renders tuition-retry-btn", () => {
    expect(src).toMatch(/tuition-retry-btn/);
  });

  /* ── CTA enhancements ── */
  test("pay_now CTA has champagne-gold inset edge highlight", () => {
    expect(src).toMatch(/rgba\(253,230,138/);
  });

  test("pay_now CTA has overdue pulse animation with Infinity repeat", () => {
    expect(src).toMatch(/isOverdue.*boxShadow|boxShadow.*isOverdue/s);
    expect(src).toMatch(/repeat:\s*Infinity/);
  });

  test("CTA_SHADOW and CTA_GOLD_EDGE constants defined", () => {
    expect(src).toMatch(/CTA_SHADOW/);
    expect(src).toMatch(/CTA_GOLD_EDGE/);
  });

  /* ── Receipt history ── */
  test("TuitionReceiptHistory is lazily imported", () => {
    expect(src).toMatch(/TuitionReceiptHistory/);
    expect(src).toMatch(/lazy\s*\(\s*\(\)\s*=>\s*import/);
  });

  test("View Receipts button opens history panel via setHistory(true)", () => {
    expect(src).toMatch(/setHistory\s*\(\s*true\s*\)/);
    expect(src).toMatch(/tuition-view-receipts-btn/);
  });

  test("historyOpen state declared alongside setHistory", () => {
    expect(src).toMatch(/historyOpen/);
    expect(src).toMatch(/setHistory/);
  });

  test("TuitionReceiptHistory rendered when historyOpen", () => {
    expect(src).toMatch(/historyOpen[\s\S]{0,200}TuitionReceiptHistory/);
  });

  test("onSelectReceipt callback fetches and shows receipt overlay", () => {
    expect(src).toMatch(/onSelectReceipt/);
    expect(src).toMatch(/fetchReceiptById/);
  });

  /* ── Interface completeness ── */
  test("gas_only declared in MongoTuition interface", () => {
    expect(src).toMatch(/gas_only\?/);
  });

  /* ── No contradictory state ── */
  test("under_review and disabled branches do not open payment modal", () => {
    const urIdx = src.indexOf("tuition-manual-review-notice");
    const urSnip = src.slice(Math.max(0, urIdx - 200), urIdx + 300);
    expect(urSnip).not.toMatch(/setPayOpen\s*\(\s*true\s*\)/);
    const disIdx = src.indexOf("tuition-disabled-notice");
    const disSnip = src.slice(Math.max(0, disIdx - 200), disIdx + 300);
    expect(disSnip).not.toMatch(/setPayOpen\s*\(\s*true\s*\)/);
  });
});

/* ═══════════════════════════════════════════════════════════════════════
   9. TuitionPaymentModal — apiFetch error message (fixes "[object Object]")
   ═══════════════════════════════════════════════════════════════════════ */
describe("11. TuitionPaymentModal - shared resumeIntent() (no dead-end error on 409)", () => {
  let src;
  beforeAll(() => { src = readSrc(`${DASH}/TuitionPaymentModal.jsx`); });

  test("createIntent's catch block checks for the INTENT_ACTIVE code and requires a truthy intent_id", () => {
    // TUITION_MANUAL_REVIEW never carries an intent_id in its detail body
    // (tuition_tools.py), so resumeIntentId is null there and this guard
    // must require a truthy intent_id, not just the right error code.
    expect(src).toMatch(/detail\?\.code === ["']INTENT_ACTIVE["'] && resumeIntentId/);
  });

  test("createIntent's 409 handler calls the shared resumeIntent(resumeIntentId), not its own inline fetch", () => {
    const idx = src.indexOf('detail?.code === "INTENT_ACTIVE"');
    const snippet = src.slice(idx, idx + 400);
    expect(snippet).toMatch(/await resumeIntent\(resumeIntentId\)/);
  });

  test("a resume failure from the 409 path falls through to the normal error display (never silently does nothing)", () => {
    const idx = src.indexOf('detail?.code === "INTENT_ACTIVE"');
    const manualCheckIdx = src.indexOf("const manualCheck", idx);
    const createIntentBlock = src.slice(idx, manualCheckIdx);
    expect(createIntentBlock).toMatch(/catch \{/);
    expect(createIntentBlock).toMatch(/setErrorMsg\(err\.message/);
    expect(createIntentBlock).toMatch(/setPhase\(["']error["']\)/);
  });

  test("resumeIntent fetches GET /api/student/tuition/intent/{id}, regenerating a real qr_image (never a bare status object)", () => {
    const idx = src.indexOf("const resumeIntent");
    const body = src.slice(idx, idx + 900);
    expect(body).toMatch(/apiFetch\(`\/api\/student\/tuition\/intent\/\$\{intentId\}`\)/);
    expect(body).toMatch(/resumed\.status === ["']pending["'] && resumed\.qr_image/);
    expect(body).toMatch(/setPhase\(["']qr["']\)/);
    expect(body).toMatch(/startPoll\(intentId\)/);
  });

  test("resumeIntent routes an already-completed intent straight to enterDone, not an error", () => {
    const idx = src.indexOf("const resumeIntent");
    const body = src.slice(idx, idx + 900);
    expect(body).toMatch(/resumed\.status === ["']completed["']/);
    expect(body).toMatch(/enterDone\(resumed\.receipt_id\)/);
  });

  test("resumeIntent routes an expired resumed intent to the expired phase, not idle", () => {
    const idx = src.indexOf("const resumeIntent");
    const body = src.slice(idx, idx + 1100);
    expect(body).toMatch(/resumed\.status === ["']expired["']/);
    const expiredIdx = body.indexOf('resumed.status === "expired"');
    const expiredSnippet = body.slice(expiredIdx, expiredIdx + 120);
    expect(expiredSnippet).toMatch(/setPhase\(["']expired["']\)/);
  });

  test("resumeIntent(fromMount) fails open to idle on error, never throws to an unhandled rejection", () => {
    const idx = src.indexOf("const resumeIntent");
    const body = src.slice(idx, idx + 1600);
    expect(body).toMatch(/if \(fromMount\) \{/);
    expect(body).toMatch(/setPhase\(["']idle["']\)/);
  });
});

describe("12. TuitionPaymentModal - mount-time auto-resume (Persistent Resume, Part 1)", () => {
  let src;
  beforeAll(() => { src = readSrc(`${DASH}/TuitionPaymentModal.jsx`); });

  test("accepts an activeIntent prop", () => {
    expect(src).toMatch(/activeIntent,/);
  });

  test("accepts a studentName prop", () => {
    expect(src).toMatch(/studentName,/);
  });

  test("initial phase is resuming when activeIntent.intent_id is present on first render (no idle flash)", () => {
    expect(src).toMatch(/useState\(activeIntent\?\.intent_id \? ["']resuming["'] : ["']idle["']\)/);
  });

  test("a mount effect calls resumeIntent with fromMount: true when activeIntent exists", () => {
    const idx = src.indexOf("useEffect(() => {\n    if (activeIntent?.intent_id)");
    expect(idx).toBeGreaterThan(-1);
    const snippet = src.slice(idx, idx + 300);
    expect(snippet).toMatch(/resumeIntent\(activeIntent\.intent_id, \{ fromMount: true \}\)/);
  });

  test("the mount effect has an empty dependency array (runs once, not on every activeIntent identity change)", () => {
    const idx = src.indexOf("resumeIntent(activeIntent.intent_id, { fromMount: true });");
    const createIntentIdx = src.indexOf("const createIntent = useCallback", idx);
    const snippet = src.slice(idx, createIntentIdx);
    expect(snippet).toMatch(/\}, \[\]\)/);
  });

  test("the resuming phase renders its own loading state, distinct from idle/creating", () => {
    expect(src).toMatch(/phase === ["']resuming["']/);
    expect(src).toMatch(/tuition-resuming/);
  });

  test("wasResumed gates a calm resume banner, never an alarming error dialog", () => {
    expect(src).toMatch(/wasResumed &&/);
    expect(src).toMatch(/tuition-resume-banner/);
    expect(src).toMatch(/Continue your pending tuition payment/);
  });

  test("wasResumed is only ever set true inside resumeIntent's pending branch, never by createIntent", () => {
    const createIntentIdx = src.indexOf("const createIntent = useCallback");
    const manualCheckIdx = src.indexOf("const manualCheck", createIntentIdx);
    const createIntentBody = src.slice(createIntentIdx, manualCheckIdx);
    expect(createIntentBody).not.toMatch(/setWasResumed\(true\)/);
    expect(createIntentBody).toMatch(/setWasResumed\(false\)/); // fresh generate clears any stale banner

    const resumeIntentIdx = src.indexOf("const resumeIntent = useCallback");
    const mountEffectIdx = src.indexOf("useEffect(() => {\n    if (activeIntent?.intent_id)");
    const resumeIntentBody = src.slice(resumeIntentIdx, mountEffectIdx);
    expect(resumeIntentBody).toMatch(/setWasResumed\(true\)/);
  });
});

describe("13. TuitionPaymentModal - premium KHQR presentation (Part 2)", () => {
  let src;
  beforeAll(() => { src = readSrc(`${DASH}/TuitionPaymentModal.jsx`); });

  test("qr phase renders a distinct premium card element", () => {
    expect(src).toMatch(/tuition-khqr-card/);
  });

  test("does not fabricate an invoice number on the pre-payment QR card (invoice_number does not exist until finalize)", () => {
    const idx = src.indexOf('data-testid="tuition-khqr-card"');
    const cardIdx = src.indexOf("</div>", src.indexOf("Dashed tear line", idx));
    // Scan the whole qr-card block (header through payment-info) for any invoice_number reference
    const blockStart = idx;
    const blockEnd = src.indexOf('data-testid="tuition-qr-status"', blockStart);
    const block = src.slice(blockStart, blockEnd);
    expect(block).not.toMatch(/invoice_number/);
  });

  test("does not reproduce a literal Bakong/KHQR logo asset — text/icon badge only", () => {
    expect(src).not.toMatch(/bakong-logo|khqr-logo|Bakong.*\.(png|svg|jpg)/i);
  });

  test("live status line reflects only real client-observable states (checking vs waiting), not fabricated backend sub-states", () => {
    expect(src).toMatch(/tuition-qr-status/);
    expect(src).toMatch(/checking\s*\n?\s*\?\s*"[^"]*Checking payment/);
    expect(src).toMatch(/Waiting for payment/);
  });

  test("expiry countdown is rendered inside the premium card, reusing the existing timeLeft/fmtTime (no new timer)", () => {
    expect(src).toMatch(/tuition-qr-countdown/);
    const countdownIdx = src.indexOf("tuition-qr-countdown");
    const snippet = src.slice(countdownIdx, countdownIdx + 500);
    expect(snippet).toMatch(/fmtTime\(timeLeft\)/);
  });

  test("QR image itself is unchanged — same intent.qr_image source, same testid", () => {
    expect(src).toMatch(/src=\{intent\.qr_image\}/);
    expect(src).toMatch(/tuition-qr-image/);
  });
});

describe("14. TuitionPaymentModal - success reveal + haptics (Part 2)", () => {
  let src;
  beforeAll(() => { src = readSrc(`${DASH}/TuitionPaymentModal.jsx`); });

  test("imports haptic from the existing shared haptics module (no new haptics implementation)", () => {
    expect(src).toMatch(/import \{ haptic \} from ["']\.\.\/\.\.\/\.\.\/\.\.\/lib\/haptics["']/);
  });

  test("enterDone fires haptic.success() exactly where phase transitions to done", () => {
    const idx = src.indexOf("const enterDone");
    const body = src.slice(idx, idx + 200);
    expect(body).toMatch(/haptic\.success\(\)/);
    expect(body).toMatch(/setPhase\(["']done["']\)/);
  });

  test("success steps are a fixed, honest list of already-known facts, not live incremental polling", () => {
    expect(src).toMatch(/const SUCCESS_STEPS = \[/);
    expect(src).toMatch(/Payment verified/);
    expect(src).toMatch(/Receipt created/);
    expect(src).toMatch(/Wallet updated/);
  });

  test("done phase renders the success steps container", () => {
    expect(src).toMatch(/tuition-success-steps/);
  });

  test("onConfirmed still fires exactly once after the success sequence, via enterDone's own timer", () => {
    const idx = src.indexOf("const enterDone");
    const body = src.slice(idx, idx + 700);
    expect(body).toMatch(/onConfirmed\?\.\(receiptId\)/);
  });
});

describe("9. TuitionPaymentModal — apiFetch surfaces the real backend message", () => {
  let src;
  beforeAll(() => { src = readSrc(`${DASH}/TuitionPaymentModal.jsx`); });

  test("no longer stringifies a dict `detail` via bare ||  (the [object Object] bug)", () => {
    expect(src).not.toMatch(/new Error\(data\.detail \|\|/);
  });

  test("extracts data.detail.message when detail is an object", () => {
    expect(src).toMatch(/data\.detail\s*&&\s*data\.detail\.message/);
  });

  test("falls back to the string form of detail, then HTTP status", () => {
    expect(src).toMatch(/typeof data\.detail === ["']string["']/);
    expect(src).toMatch(/`HTTP \$\{res\.status\}`/);
  });
});

/* ═══════════════════════════════════════════════════════════════════════
   10. Persistent Tuition Receipt Engine — Payment History additions (C6)
   ═══════════════════════════════════════════════════════════════════════ */
describe("10. TuitionReceiptHistory — invoice number is additive, never fabricated", () => {
  let src;
  beforeAll(() => { src = readSrc(`${DASH}/TuitionReceiptHistory.jsx`); });

  test("renders r.invoice_number when present", () => {
    expect(src).toMatch(/r\.invoice_number/);
  });

  test("invoice number line is conditional — nothing rendered for legacy receipts", () => {
    expect(src).toMatch(/\{r\.invoice_number &&/);
  });
});

describe("10. TuitionReceiptOverlay — invoice row + PDF/PNG downloads (C6)", () => {
  let overlay;
  beforeAll(() => { overlay = readSrc(`${DASH}/TuitionReceiptOverlay.jsx`); });

  test("destructures invoice_number from the receipt prop", () => {
    expect(overlay).toMatch(/invoice_number,/);
  });

  test("Invoice row is conditional on invoice_number and positioned near Reference", () => {
    expect(overlay).toMatch(/invoice_number &&[\s\S]{0,120}label="Invoice"/);
  });

  test("download buttons hit the student-scoped PDF/PNG routes with auth headers", () => {
    expect(overlay).toMatch(/\/api\/student\/tuition\/receipt\/\$\{encodeURIComponent\(receiptId\)\}\/\$\{fmt\}/);
    expect(overlay).toMatch(/fetchReceiptFile[\s\S]*authHeaders\(\)/);
  });

  test("download buttons have the required testids", () => {
    expect(overlay).toMatch(/tuition-receipt-download-pdf/);
    expect(overlay).toMatch(/tuition-receipt-download-png/);
  });

  test("download handler is entirely separate from acknowledge — never calls acknowledge()", () => {
    const idx = overlay.indexOf("const handleDownload");
    const snippet = overlay.slice(idx, idx + 700);
    expect(snippet).not.toMatch(/acknowledge\(/);
  });

  test("existing acknowledge/close flow is untouched by the download addition", () => {
    expect(overlay).toMatch(/const handleAcknowledge/);
    expect(overlay).toMatch(/const handleClose/);
  });
});

/* ═══════════════════════════════════════════════════════════════════════
   7. TuitionReceiptHistory (Gate 14)
   ═══════════════════════════════════════════════════════════════════════ */
describe("7. TuitionReceiptHistory — receipt history panel (Gate 14)", () => {
  let src;
  beforeAll(() => { src = readSrc(`${DASH}/TuitionReceiptHistory.jsx`); });

  test("fetches GET /api/student/tuition/receipts", () => {
    expect(src).toMatch(/\/api\/student\/tuition\/receipts/);
  });

  test("sends Authorization header from localStorage session token", () => {
    expect(src).toMatch(/student_session_token/);
    expect(src).toMatch(/Authorization/);
  });

  test("receipt list items have data-testid tuition-history-receipt-item", () => {
    expect(src).toMatch(/tuition-history-receipt-item/);
  });

  test("clicking a receipt calls onSelectReceipt with receipt_id", () => {
    expect(src).toMatch(/onSelectReceipt/);
    expect(src).toMatch(/receipt_id/);
  });

  test("empty state has tuition-history-empty testid", () => {
    expect(src).toMatch(/tuition-history-empty/);
  });

  test("empty state message indicates no digital receipts yet", () => {
    expect(src).toMatch(/No digital receipts/);
  });

  test("close button has tuition-history-close-btn testid", () => {
    expect(src).toMatch(/tuition-history-close-btn/);
  });

  test("shows payment amount (amount_usd) per receipt", () => {
    expect(src).toMatch(/amount_usd/);
  });

  test("shows confirmed_at date per receipt", () => {
    expect(src).toMatch(/confirmed_at/);
  });

  test("shows payment method per receipt", () => {
    expect(src).toMatch(/fmtMethod/);
  });

  test("shows reward_points and reward_status when credited", () => {
    expect(src).toMatch(/reward_status/);
    expect(src).toMatch(/reward_points/);
  });

  test("shows new_due_date (next payment date) per receipt", () => {
    expect(src).toMatch(/new_due_date/);
  });

  test("role=dialog and aria-modal for accessibility", () => {
    expect(src).toMatch(/role\s*=\s*["']dialog["']/);
    expect(src).toMatch(/aria-modal\s*=\s*["']true["']/);
  });

  test("loading state handled with spinner", () => {
    expect(src).toMatch(/loading/);
    expect(src).toMatch(/Loading receipts|loading/i);
  });

  test("error state shows friendly message", () => {
    expect(src).toMatch(/Could not load/);
  });

  test("legacy payments note present when receipts exist", () => {
    expect(src).toMatch(/without digital payment evidence/i);
  });

  test("onClose prop wires to close button", () => {
    expect(src).toMatch(/onClick\s*=\s*\{onClose\}/);
  });
});

/* ═══════════════════════════════════════════════════════════════════════
   8. TuitionReceiptOverlay — no X dismiss (Gate 14b)
   ═══════════════════════════════════════════════════════════════════════ */
describe("8. TuitionReceiptOverlay — no X dismiss, Confirm-only (Gate 14b)", () => {
  let overlay;
  beforeAll(() => { overlay = readSrc(`${DASH}/TuitionReceiptOverlay.jsx`); });

  test("X icon is NOT imported (button removed)", () => {
    // The X import was removed since the button is gone
    expect(overlay).not.toMatch(/import.*\bX\b.*from.*lucide/);
  });

  test("no X button in the rendered card body", () => {
    // No aria-label 'Close without confirming' in the overlay
    expect(overlay).not.toMatch(/Close without confirming/);
    expect(overlay).not.toMatch(/tuition-receipt-close/);
  });

  test("handleClose still defined (used by Confirm timeout)", () => {
    expect(overlay).toMatch(/handleClose/);
  });

  test("Confirm is the only interactive path that triggers acknowledge", () => {
    expect(overlay).toMatch(/handleAcknowledge/);
    // handleClose must not call acknowledge
    const closeIdx = overlay.indexOf("const handleClose");
    const snippet   = overlay.slice(closeIdx, closeIdx + 300);
    expect(snippet).not.toMatch(/acknowledge\s*\(/);
  });

  test("persistence note present in overlay", () => {
    expect(overlay).toMatch(/វិក្កយបត្រនេះ|persist|remains/i);
  });
});

/* ═══════════════════════════════════════════════════════════════════════
   15. TuitionStrip — passes activeIntent + studentName into the modal
       (Persistent Resume, Part 1 — the "whenever Tuition page opens"
       trigger is TuitionStrip's existing loadMongo() on mount; no new
       fetch or polling interval was added).
   ═══════════════════════════════════════════════════════════════════════ */
describe("15. TuitionStrip — activeIntent/studentName prop wiring into TuitionPaymentModal", () => {
  let src;
  beforeAll(() => { src = readSrc(`${DASH}/TuitionStrip.tsx`); });

  test("passes mongo?.active_intent as the activeIntent prop", () => {
    expect(src).toMatch(/activeIntent=\{mongo\?\.active_intent\}/);
  });

  test("passes student.Name as the studentName prop", () => {
    expect(src).toMatch(/studentName=\{student\.Name\}/);
  });

  test("both new props are on the same TuitionPaymentModal render site as the existing studentId/currentNdd props", () => {
    const idx = src.indexOf("<TuitionPaymentModal");
    const block = src.slice(idx, idx + 400);
    expect(block).toMatch(/studentId=\{student\.StudentID\}/);
    expect(block).toMatch(/currentNdd=\{nextDueDate\}/);
    expect(block).toMatch(/activeIntent=\{mongo\?\.active_intent\}/);
    expect(block).toMatch(/studentName=\{student\.Name\}/);
  });

  test("no new fetch or polling interval was introduced — mongo.active_intent comes from the existing loadMongo() call", () => {
    // active_intent already exists on MongoTuition's interface (backend
    // field, pre-existing) — TuitionStrip only needed to pass it through.
    expect(src).toMatch(/active_intent\?:\s*\{/);
    const setIntervalCount = (src.match(/setInterval/g) || []).length;
    expect(setIntervalCount).toBe(0);
  });
});
