/**
 * chestView.js — pure helpers mapping the backend chest_state to UI behavior.
 * Keeps the "sealed until confirmed" + "poll only while processing" + "reveal
 * only when completed" rules testable without the DOM. The backend is always
 * the source of truth; these never invent reward data.
 */
export const CHEST_INELIGIBLE = "ineligible";
export const CHEST_ELIGIBLE = "eligible_unclaimed";
export const CHEST_PROCESSING = "processing";
export const CHEST_RECONCILE = "reconciliation_required";
export const CHEST_COMPLETED = "completed";
export const CHEST_FAILED = "confirmed_failed";

/** Only `completed` may show the opened chest + confirmed reward. */
export function revealsReward(state) {
  return state === CHEST_COMPLETED;
}

/** Sealed for everything except completed. */
export function isSealed(state) {
  return state !== CHEST_COMPLETED;
}

/** Status polling is allowed ONLY while processing (status route, no GAS). */
export function shouldPoll(state) {
  return state === CHEST_PROCESSING;
}

/** The Claim/Open action is offered only when eligible or explicitly retryable. */
export function canClaim(state) {
  return state === CHEST_ELIGIBLE || state === CHEST_FAILED;
}

/** Reward types that may appear in the student UI this release.
 *  Pass A.1 — voucher and EduTalk Pass are now student-visible WHEN the
 *  backend fulfillment confirms `state === "granted"`. They are NEVER shown
 *  for pending / eligible / blocked / failed / unavailable / reconciliation
 *  / absent states. The Chest reveal layer is the single gate (see
 *  `VoiceTreasureChest.jsx`); chestView remains a pure helper. */
export const STUDENT_VISIBLE_REWARD_TYPES = [
  "points", "first_voice_card", "voucher", "edutalk_pass",
];
/** Types still hidden in this release (premium / store / boost). */
export const HIDDEN_REWARD_TYPES = ["gems", "skins", "boosts", "premium_pass"];
/** Fields the completed reveal is permitted to render (no invented currencies). */
export const REVEAL_FIELDS = [
  "points_credited", "base_points", "streak_bonus", "high_score_bonus",
  "first_voice_card", "claimed_at", "balance",
  // Pass A.1 — confirmed-only voucher / EduTalk Pass detail blocks. The
  // backend gates each on `state === "granted"`; the chest re-checks.
  "voucher", "voucher_detail", "edutalk_pass", "edutalk_pass_detail",
];

/** Pass A.1 — confirmed-only voucher reveal gate. */
export function shouldRevealVoucher(reward) {
  return !!(reward && reward.voucher === "granted" && reward.voucher_detail);
}
/** Pass A.1 — confirmed-only EduTalk Pass reveal gate. */
export function shouldRevealEdutalkPass(reward) {
  return !!(reward && reward.edutalk_pass === "granted" && reward.edutalk_pass_detail);
}

export function chestPresentation(state) {
  switch (state) {
    case CHEST_ELIGIBLE:
      return { sealed: true, title: "Your treasure awaits", action: "Open chest", tone: "gold" };
    case CHEST_PROCESSING:
      return { sealed: true, title: "Opening…", action: null, tone: "cyan", poll: true };
    case CHEST_RECONCILE:
      return { sealed: true, title: "Confirming your reward", action: null, tone: "violet" };
    case CHEST_COMPLETED:
      return { sealed: false, title: "Reward unlocked!", action: null, tone: "gold" };
    case CHEST_FAILED:
      return { sealed: true, title: "Let's try that again", action: "Retry", tone: "violet" };
    case CHEST_INELIGIBLE:
    default:
      return { sealed: true, title: "Keep practicing", action: null, tone: "muted" };
  }
}
