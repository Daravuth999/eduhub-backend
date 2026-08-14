/**
 * edutalkTopupNudgeSchema.js — Pure validation helpers for the Author Studio's
 * "Live Coach Smart Top-Up Nudge" fields. Mirrors the backend
 * _validate_topup_nudge_fields() allow-list so the Studio surfaces the SAME
 * constraints the backend enforces (REJECT invalid input — never silently
 * clamp). Follows the reject pattern established by edutalkLiveRewardSchema.js,
 * but uses FEATURE-SPECIFIC reason codes (never the Reward system's literals).
 */

// Feature-specific reason codes (kept in sync with the backend).
export const TOPUP_NUDGE_REASONS = Object.freeze({
  CONFIG_DISABLED: "config_disabled",
  THRESHOLD_INVALID: "threshold_invalid",
  WEEKLY_CAP_INVALID: "weekly_cap_invalid",
});

export const TOPUP_NUDGE_THRESHOLD_MIN = 0;
export const TOPUP_NUDGE_THRESHOLD_MAX = 100000;
export const TOPUP_NUDGE_CAP_MIN = 0;
export const TOPUP_NUDGE_CAP_MAX = 1000;

/** Strict integer parse — returns null for 1.5, "", "abc", NaN, booleans. */
export function strictInt(value) {
  if (typeof value === "boolean") return null;
  if (typeof value === "number") {
    return Number.isInteger(value) ? value : null;
  }
  if (typeof value === "string") {
    const s = value.trim();
    if (s === "") return null;
    const n = Number(s);
    if (!Number.isFinite(n)) return null;
    return Number.isInteger(n) ? n : null;
  }
  return null;
}

/**
 * Validate ONLY the three Smart Top-Up Nudge fields. Returns {ok, reason}
 * where reason is "" on success or a feature-specific reason code. Rejects
 * (does NOT clamp) out-of-range / non-integer input.
 */
export function validateTopupNudgeConfig(cfg) {
  const c = cfg || {};
  if ("topup_nudge_enabled" in c &&
      typeof c.topup_nudge_enabled !== "boolean") {
    return { ok: false, reason: TOPUP_NUDGE_REASONS.CONFIG_DISABLED };
  }
  if ("topup_nudge_threshold" in c) {
    const thr = strictInt(c.topup_nudge_threshold);
    if (thr === null || thr < TOPUP_NUDGE_THRESHOLD_MIN ||
        thr > TOPUP_NUDGE_THRESHOLD_MAX) {
      return { ok: false, reason: TOPUP_NUDGE_REASONS.THRESHOLD_INVALID };
    }
  }
  if ("topup_nudge_max_per_week" in c) {
    const cap = strictInt(c.topup_nudge_max_per_week);
    if (cap === null || cap < TOPUP_NUDGE_CAP_MIN || cap > TOPUP_NUDGE_CAP_MAX) {
      return { ok: false, reason: TOPUP_NUDGE_REASONS.WEEKLY_CAP_INVALID };
    }
  }
  return { ok: true, reason: "" };
}

/** Human-readable message for a reason code (Studio inline error). */
export function reasonMessage(reason) {
  switch (reason) {
    case TOPUP_NUDGE_REASONS.THRESHOLD_INVALID:
      return "Threshold must be a whole number between 0 and 100000.";
    case TOPUP_NUDGE_REASONS.WEEKLY_CAP_INVALID:
      return "Weekly cap must be a whole number between 0 and 1000 " +
             "(per student, across all their sessions, rolling 7 days).";
    case TOPUP_NUDGE_REASONS.CONFIG_DISABLED:
      return "Invalid enabled flag.";
    default:
      return "";
  }
}
