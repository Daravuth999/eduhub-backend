/**
 * formatPoints.js — the ONE shared display formatter for EduHub Points
 * values, everywhere they appear (Video Library, Dashboard, Portal,
 * Wallet, Books, and any future product).
 *
 * Backend balances are stored as raw floats and can carry binary
 * floating-point artifacts (e.g. 82.0200000000000001, or the
 * 154.15999999999988 that motivated this file's grouped variant below).
 * Neither function here ever modifies the stored/transmitted value — they
 * only control what's rendered: round to at most 2 decimal places, then
 * drop trailing zeros, never expose float noise.
 *
 * Two variants, both built on the same rounding core, because this
 * codebase already has two genuinely different, pre-existing display
 * conventions that both need to stay exactly as they were for their
 * existing callers:
 *
 * `formatPoints` — NO thousands separator (matches this app's original
 * plain-number point displays, e.g. Classroom Library's "82 PTS").
 * Unchanged behavior/signature from before this file grew a grouped
 * sibling — every existing caller and its test suite still passes as-is.
 *
 *   formatPoints(82.0200000000000001) -> "82.02"
 *   formatPoints(82)                  -> "82"
 *   formatPoints(105.5)               -> "105.5"
 *   formatPoints(1000)                -> "1000"
 *   formatPoints(null)                -> "0"
 *
 * `formatPointsGrouped` — locale-aware thousands separators, for premium
 * badges/pills where a wallet balance can plausibly run into the
 * thousands (this is what EduHubPointsPill uses internally).
 *
 *   formatPointsGrouped(154.15999999999988) -> "154.16"
 *   formatPointsGrouped(154.0000001)        -> "154"
 *   formatPointsGrouped(1200)               -> "1,200"
 *   formatPointsGrouped(18250)              -> "18,250"
 *   formatPointsGrouped(null)               -> "0"
 */
const POINTS_FORMATTER = new Intl.NumberFormat("en-US", {
  maximumFractionDigits: 2,
  useGrouping: false,
});

const POINTS_FORMATTER_GROUPED = new Intl.NumberFormat("en-US", {
  maximumFractionDigits: 2,
  useGrouping: true,
});

export function formatPoints(value) {
  const n = Number(value);
  if (!Number.isFinite(n)) return "0";
  return POINTS_FORMATTER.format(n);
}

export function formatPointsGrouped(value) {
  const n = Number(value);
  if (!Number.isFinite(n)) return "0";
  return POINTS_FORMATTER_GROUPED.format(n);
}

export default formatPoints;
