/**
 * attendancePassport.js — pure, importable display helpers for the
 * Attendance "Passport" Home (UI v2.1). NEW file: presentation-only constants
 * and mappers. It introduces ZERO backend coupling — every value here is a
 * frontend display constant derived from the real /attendance/me response
 * shape (current_streak, longest_streak, reliability_tier, on_time_rate_rolling,
 * history[]) and the existing reward-tier thresholds mirrored in
 * attendanceSchema.defaultAttendanceSettings().
 */
import { defaultAttendanceSettings, TIERS } from "./attendanceSchema";

/**
 * §3.2 — pure frontend tier display mapping. The backend tier string values
 * (verified against attendance_tools.py: bronze / silver / gold / diamond)
 * are mapped to premium display names + a brass-on-ivory palette. Nothing
 * here changes any backend value.
 */
export const TIER_DISPLAY = {
  bronze: { label: "Bronze Starter", color: "#B0773D", soft: "#EBD9C4" },
  silver: { label: "Silver Pathfinder", color: "#7E8AA0", soft: "#DDE2EC" },
  gold: { label: "Gold Explorer", color: "#C2992E", soft: "#F1E2B4" },
  diamond: { label: "Diamond Champion", color: "#3F94A8", soft: "#CDE9EF" },
};

export function tierDisplay(tier) {
  return TIER_DISPLAY[tier] || TIER_DISPLAY.bronze;
}

/** Collectible-stamp visual language per attendance status. */
export const STAMP_META = {
  present_full: {
    key: "full", label: "Full", kh: "ពេញ", ink: "#2F7D5B", paper: "#E7F2EA",
  },
  late: {
    key: "late", label: "Late", kh: "យឺត", ink: "#B6822A", paper: "#F6ECD4",
  },
  present_partial: {
    key: "partial", label: "Partial", kh: "ខ្លះ", ink: "#5E6E96", paper: "#E5E9F3",
  },
  absent: {
    key: "absent", label: "Missed", kh: "ខកខាន", ink: "#9A9285", paper: "#EFEBE2",
  },
};

export function stampMeta(status) {
  return STAMP_META[status] || STAMP_META.absent;
}

/**
 * Adventure-Map chapters. §3.1: themed chapters are a PURE FRONTEND DISPLAY
 * CONSTANT acting only as background-art transitions behind a continuous run
 * of real per-session checkpoints. The count/boundaries are never tied to
 * anything backend — each checkpoint node is one real history entry.
 */
export const MAP_CHAPTERS = [
  { key: "camp", name: "Base Camp", tint: "#E9F0E6" },
  { key: "forest", name: "Forest Trail", tint: "#E3EEE5" },
  { key: "river", name: "River Crossing", tint: "#E2EDF1" },
  { key: "mountain", name: "Mountain Pass", tint: "#ECE7DD" },
  { key: "summit", name: "Summit", tint: "#EFE7D2" },
];

/** Which display chapter a checkpoint at index `i` of `total` belongs to. */
export function chapterForIndex(i, total) {
  if (total <= 0) return 0;
  const per = Math.ceil(total / MAP_CHAPTERS.length) || 1;
  return Math.min(MAP_CHAPTERS.length - 1, Math.floor(i / per));
}

/**
 * Build the ordered checkpoint list (oldest → newest) from /attendance/me
 * history (which arrives newest-first). One node per real history entry.
 */
export function buildCheckpoints(history) {
  const rows = [...(history || [])].reverse();
  return rows.map((h, i) => ({
    id: h.session_id || `c${i}`,
    index: i,
    status: h.status || "absent",
    at: h.checked_in_at || h.session_date || null,
    chapter: chapterForIndex(i, rows.length),
  }));
}

/**
 * Tier progress toward the NEXT reliability tier, using the rolling on-time
 * rate that the real /attendance/me response actually contains. Returns a
 * 0..1 fraction plus the human label of the next tier (or null at the top).
 */
export function tierProgress(me) {
  const tier = (me && me.reliability_tier) || "bronze";
  const rate = Math.max(0, Math.min(1, Number(me && me.on_time_rate_rolling) || 0));
  const idx = TIERS.indexOf(tier);
  const nextTier = idx >= 0 && idx < TIERS.length - 1 ? TIERS[idx + 1] : null;
  if (!nextTier) {
    return { atMax: true, fraction: 1, nextTier: null, rate, needed: null };
  }
  const tiers = defaultAttendanceSettings().reward_tiers;
  const needed = Number((tiers.find((t) => t.tier === nextTier) || {}).min_on_time_rate) || 0;
  const fraction = needed > 0 ? Math.max(0, Math.min(1, rate / needed)) : 1;
  return { atMax: false, fraction, nextTier, rate, needed };
}

/** Format an ISO timestamp into a short, locale-safe stamp date. */
export function shortDate(iso) {
  if (!iso) return "";
  try {
    const d = new Date(iso);
    if (Number.isNaN(d.getTime())) return "";
    return d.toLocaleDateString(undefined, { month: "short", day: "numeric" });
  } catch {
    return "";
  }
}
