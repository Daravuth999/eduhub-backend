/**
 * liveCoachTopupNudgeLogic.js — PURE decision helpers for the EduTalk Live
 * Coach "Smart Top-Up Nudge" pill.
 *
 * The pill renders ONLY in phase === "start" and phase === "report" — there is
 * ZERO logic here for phase === "live". The frontend NEVER recomputes
 * balance-minus-cost: the backend's per-mode preview already carries the
 * authoritative projected figure; these helpers only read flags it returns.
 *
 * Snooze: the pill must respect the SAME 3-dismissal / 7-day snooze the rest
 * of the Top-Up flow uses (useTopUpAffordance.js). The caller passes the
 * snoozed boolean (sourced from isTopUpSnoozed()) so this module stays pure
 * and unit-testable.
 */

/** Select the backend preview entry for the currently-selected mode. */
export function selectModePreview(previewsByMode, modeKey) {
  if (!previewsByMode || typeof previewsByMode !== "object") return null;
  if (!modeKey) return null;
  return previewsByMode[modeKey] || null;
}

/**
 * Decide whether the PRE-SESSION (phase === "start") pill should render.
 * Requires: feature enabled, not snoozed, and an eligible per-mode preview.
 */
export function shouldShowStartPill({ enabled, preview, snoozed }) {
  if (!enabled) return false;
  if (snoozed) return false;
  if (!preview || preview.enabled !== true || preview.eligible !== true) {
    return false;
  }
  return true;
}

/**
 * Decide whether the POST-SESSION (phase === "report") pill should render.
 * Requires: feature enabled, not snoozed, and a finalized report-eligible
 * record. Renders ONLY from the Stage 3 finalization block.
 */
export function shouldShowReportPill({ enabled, finalization, snoozed }) {
  if (!enabled) return false;
  if (snoozed) return false;
  if (!finalization || finalization.report_eligible !== true) return false;
  return true;
}

/**
 * The settled balance to push back into the app's displayed balance after a
 * session (via the existing AuthContext setBalance callback). Returns a number
 * only when the finalized figure is a real number — never a fabricated value.
 */
export function settledBalanceToApply(finalization) {
  const v = finalization && finalization.settled_balance;
  return typeof v === "number" && Number.isFinite(v) ? v : null;
}

// ─────────────────────────────────────────────────────────────────────────
// Phase 0B — normalized visibility-decision helpers (additive). These do NOT
// replace the boolean helpers above; the existing frontend/tests keep working.
// The normalized reason/source allowlists mirror the backend
// (edutalk_live_tools.py) so the bounded `pill_visibility_decision` rows the
// backend stores are truthful and never expose internal strings to students.
// ─────────────────────────────────────────────────────────────────────────

/** Normalized diagnostic reasons (allowlist — mirrors the backend). */
export const NUDGE_DIAGNOSTIC_REASONS = Object.freeze({
  ELIGIBLE: "eligible",
  CONFIG_DISABLED: "config_disabled",
  FEATURE_UNAVAILABLE: "feature_unavailable",
  THRESHOLD_INVALID: "threshold_invalid",
  BALANCE_TEMPORARILY_UNAVAILABLE: "balance_temporarily_unavailable",
  BALANCE_ABOVE_THRESHOLD: "balance_above_threshold",
  WEEKLY_CAP_REACHED: "weekly_cap_reached",
  CAP_DISABLED: "cap_disabled",
  CAP_LOCK_UNAVAILABLE: "cap_lock_unavailable",
  RESERVATION_NOT_COMPLETED: "reservation_not_completed",
  PENDING: "pending",
  SNOOZED: "snoozed",
});

/** Truthful balance-source labels (allowlist — mirrors the backend). */
export const NUDGE_BALANCE_SOURCES = Object.freeze({
  MONGO_WALLET: "mongo_wallet",
  MONGO_WALLET_UNAVAILABLE: "mongo_wallet_unavailable",
  CLIENT_DISPLAY_SNAPSHOT_REQUIRED: "client_display_snapshot_required",
  CLIENT_DISPLAY_SNAPSHOT: "client_display_snapshot",
  GAS_VERIFIED_PRE_RESERVATION: "gas_verified_pre_reservation",
  GAS_VERIFIED_POST_RESERVATION: "gas_verified_post_reservation",
  UNAVAILABLE: "unavailable",
});

const _ALLOWED_REASONS = new Set(Object.values(NUDGE_DIAGNOSTIC_REASONS));
const _ALLOWED_SOURCES = new Set(Object.values(NUDGE_BALANCE_SOURCES));

export function isAllowedNudgeReason(reason) {
  return _ALLOWED_REASONS.has(reason);
}
export function isAllowedBalanceSource(source) {
  return _ALLOWED_SOURCES.has(source);
}

// Map the LEGACY per-mode preview `reason` values to a normalized reason when
// the backend has not (yet) supplied a `diagnostic_reason` (version skew).
const _LEGACY_REASON_MAP = Object.freeze({
  config_disabled: NUDGE_DIAGNOSTIC_REASONS.CONFIG_DISABLED,
  threshold_invalid: NUDGE_DIAGNOSTIC_REASONS.THRESHOLD_INVALID,
  balance_unavailable_for_preview:
    NUDGE_DIAGNOSTIC_REASONS.BALANCE_TEMPORARILY_UNAVAILABLE,
  wallet_unavailable: NUDGE_DIAGNOSTIC_REASONS.BALANCE_TEMPORARILY_UNAVAILABLE,
  projected_balance_at_or_below_threshold: NUDGE_DIAGNOSTIC_REASONS.ELIGIBLE,
  balance_above_threshold: NUDGE_DIAGNOSTIC_REASONS.BALANCE_ABOVE_THRESHOLD,
});

/**
 * Decide the normalized visibility reason + truthful balance source for the
 * PRE-SESSION (start) pill. Pure; never renders strings to students.
 *
 * @returns {{ pill_shown: boolean, reason: string, balance_source: string }}
 */
export function normalizeStartVisibilityDecision({
  enabled, snoozed, preview, capReason,
}) {
  const balanceSource =
    (preview && isAllowedBalanceSource(preview.balance_source)
      ? preview.balance_source
      : NUDGE_BALANCE_SOURCES.UNAVAILABLE);

  if (!enabled) {
    return { pill_shown: false,
      reason: NUDGE_DIAGNOSTIC_REASONS.CONFIG_DISABLED, balance_source: balanceSource };
  }
  if (snoozed) {
    return { pill_shown: false,
      reason: NUDGE_DIAGNOSTIC_REASONS.SNOOZED, balance_source: balanceSource };
  }
  if (!preview) {
    return { pill_shown: false,
      reason: NUDGE_DIAGNOSTIC_REASONS.FEATURE_UNAVAILABLE, balance_source: balanceSource };
  }
  // Cap exhaustion / disabled fails closed regardless of projected balance.
  if (capReason === "weekly_cap_reached") {
    return { pill_shown: false,
      reason: NUDGE_DIAGNOSTIC_REASONS.WEEKLY_CAP_REACHED, balance_source: balanceSource };
  }
  if (capReason === "cap_disabled") {
    return { pill_shown: false,
      reason: NUDGE_DIAGNOSTIC_REASONS.CAP_DISABLED, balance_source: balanceSource };
  }
  // Prefer an explicit backend normalized reason; fall back to legacy mapping.
  let reason = preview.diagnostic_reason;
  if (!isAllowedNudgeReason(reason)) {
    reason = _LEGACY_REASON_MAP[preview.reason]
      || NUDGE_DIAGNOSTIC_REASONS.PENDING;
  }
  const pillShown = reason === NUDGE_DIAGNOSTIC_REASONS.ELIGIBLE
    && preview.eligible === true;
  return { pill_shown: pillShown, reason, balance_source: balanceSource };
}

/**
 * Decide the normalized visibility reason + source for the POST-SESSION
 * (report) pill from the Stage 3 finalization block. Pure.
 */
export function normalizeReportVisibilityDecision({
  enabled, snoozed, finalization,
}) {
  const balanceSource =
    (finalization && isAllowedBalanceSource(finalization.balance_source)
      ? finalization.balance_source
      : NUDGE_BALANCE_SOURCES.UNAVAILABLE);
  if (!enabled) {
    return { pill_shown: false,
      reason: NUDGE_DIAGNOSTIC_REASONS.CONFIG_DISABLED, balance_source: balanceSource };
  }
  if (snoozed) {
    return { pill_shown: false,
      reason: NUDGE_DIAGNOSTIC_REASONS.SNOOZED, balance_source: balanceSource };
  }
  if (!finalization) {
    return { pill_shown: false,
      reason: NUDGE_DIAGNOSTIC_REASONS.PENDING, balance_source: balanceSource };
  }
  let reason = finalization.diagnostic_reason;
  if (!isAllowedNudgeReason(reason)) {
    reason = finalization.report_eligible === true
      ? NUDGE_DIAGNOSTIC_REASONS.ELIGIBLE
      : NUDGE_DIAGNOSTIC_REASONS.BALANCE_ABOVE_THRESHOLD;
  }
  const pillShown = finalization.report_eligible === true
    && reason === NUDGE_DIAGNOSTIC_REASONS.ELIGIBLE;
  return { pill_shown: pillShown, reason, balance_source: balanceSource };
}

// ─────────────────────────────────────────────────────────────────────────
// V2 Bug 4 — ONE effective decision object for BOTH render and visibility
// logging. The defect: the start pill RENDERED from `clientFallback ?? preview`
// but the visibility decision LOGGED from `preview` only, so the actual pill
// and the reported decision could diverge. These helpers fold the real data
// source the UI uses (including the client display-snapshot fallback) into a
// single object whose `pill_shown` drives the render AND whose
// `reason`/`balance_source` drive the visibility POST. When the client fallback
// balance drives the decision, `balance_source` is `client_display_snapshot`.
// ─────────────────────────────────────────────────────────────────────────

/**
 * Build the single effective PRE-SESSION (start) decision.
 *
 * @param {object} p
 * @param {boolean} p.enabled
 * @param {boolean} p.snoozed
 * @param {object|null} p.preview        backend per-mode preview
 * @param {object|null} p.clientFallback client display-snapshot fallback
 *                                       ({ enabled, eligible }) or null
 * @param {string|undefined} p.capReason top-level weekly-cap reason
 * @returns {{ pill_shown:boolean, reason:string, balance_source:string, source:string }}
 */
export function buildEffectiveStartDecision({
  enabled, snoozed, preview, clientFallback, capReason,
}) {
  // The client display-snapshot fallback DRIVES the decision only when the
  // backend preview was balance-gated (the caller builds clientFallback only in
  // that case, and only after the weekly-cap gate already passed).
  if (clientFallback && clientFallback.enabled === true) {
    if (!enabled) {
      return { pill_shown: false, reason: NUDGE_DIAGNOSTIC_REASONS.CONFIG_DISABLED,
        balance_source: NUDGE_BALANCE_SOURCES.CLIENT_DISPLAY_SNAPSHOT,
        source: "client_fallback" };
    }
    if (snoozed) {
      return { pill_shown: false, reason: NUDGE_DIAGNOSTIC_REASONS.SNOOZED,
        balance_source: NUDGE_BALANCE_SOURCES.CLIENT_DISPLAY_SNAPSHOT,
        source: "client_fallback" };
    }
    const eligible = clientFallback.eligible === true;
    return {
      pill_shown: eligible,
      reason: eligible ? NUDGE_DIAGNOSTIC_REASONS.ELIGIBLE
        : NUDGE_DIAGNOSTIC_REASONS.BALANCE_ABOVE_THRESHOLD,
      balance_source: NUDGE_BALANCE_SOURCES.CLIENT_DISPLAY_SNAPSHOT,
      source: "client_fallback",
    };
  }
  const base = normalizeStartVisibilityDecision({
    enabled, snoozed, preview, capReason });
  // Bug 3 frontend fail-closed defense — if the preview diagnostic itself says
  // the weekly cap blocks the nudge, the pill must be hidden (and logged hidden
  // from the SAME object).
  const dr = preview && preview.diagnostic_reason;
  if (dr === NUDGE_DIAGNOSTIC_REASONS.WEEKLY_CAP_REACHED
      || dr === NUDGE_DIAGNOSTIC_REASONS.CAP_DISABLED) {
    return { ...base, pill_shown: false, reason: dr, source: "backend_preview" };
  }
  return { ...base, source: "backend_preview" };
}

/**
 * Build the single effective POST-SESSION (report) decision.
 *
 * @param {object} p
 * @param {boolean} p.enabled
 * @param {boolean} p.snoozed
 * @param {object|null} p.finalization   backend Stage 3 finalization
 * @param {object|null} p.clientFallback client display-snapshot finalization
 *                                       ({ report_eligible, settlement_reason }) or null
 */
export function buildEffectiveReportDecision({
  enabled, snoozed, finalization, clientFallback,
}) {
  if (clientFallback
      && (clientFallback.report_eligible === true
          || clientFallback.settlement_reason === "client_estimate")) {
    if (!enabled) {
      return { pill_shown: false, reason: NUDGE_DIAGNOSTIC_REASONS.CONFIG_DISABLED,
        balance_source: NUDGE_BALANCE_SOURCES.CLIENT_DISPLAY_SNAPSHOT,
        source: "client_fallback" };
    }
    if (snoozed) {
      return { pill_shown: false, reason: NUDGE_DIAGNOSTIC_REASONS.SNOOZED,
        balance_source: NUDGE_BALANCE_SOURCES.CLIENT_DISPLAY_SNAPSHOT,
        source: "client_fallback" };
    }
    const eligible = clientFallback.report_eligible === true;
    return {
      pill_shown: eligible,
      reason: eligible ? NUDGE_DIAGNOSTIC_REASONS.ELIGIBLE
        : NUDGE_DIAGNOSTIC_REASONS.BALANCE_ABOVE_THRESHOLD,
      balance_source: NUDGE_BALANCE_SOURCES.CLIENT_DISPLAY_SNAPSHOT,
      source: "client_fallback",
    };
  }
  return {
    ...normalizeReportVisibilityDecision({ enabled, snoozed, finalization }),
    source: "backend_finalization",
  };
}
