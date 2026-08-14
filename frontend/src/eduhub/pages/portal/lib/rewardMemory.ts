/**
 * Per-student persistent memory of the LATEST positive reward.
 * Powers the always-visible LatestRewardCard so a student returning
 * after days still sees "your last reward was +50 from a teacher".
 */

export interface RewardSnapshot {
  amount: number;
  /** Unix ms when the reward arrived. */
  ts: number;
  /** Stable copy variant (so the card doesn't change wording on refresh). */
  copy: string;
  /** Localized Khmer copy. */
  copyKm: string;
  /** Tier — drives the color/glow intensity. */
  tier: "tiny" | "nice" | "big" | "huge";
  /** Optional sender attribution for student-to-student transfers. */
  from?: string;
  /** True when the reward accrued between sessions. */
  whileAway?: boolean;
}

const KEY_PREFIX = "myportal-latest-reward:";
/** Older than this we still display, but with "long ago" copy. */
const STALE_AFTER_MS = 90 * 24 * 60 * 60_000; // 90 days

function key(studentId: string) {
  return KEY_PREFIX + studentId;
}

export function readLatestReward(studentId: string): RewardSnapshot | null {
  if (typeof window === "undefined") return null;
  try {
    const raw = localStorage.getItem(key(studentId));
    if (!raw) return null;
    const r = JSON.parse(raw) as RewardSnapshot;
    if (typeof r.amount !== "number" || typeof r.ts !== "number") return null;
    if (Date.now() - r.ts > STALE_AFTER_MS) return null;
    return r;
  } catch {
    return null;
  }
}

export function writeLatestReward(studentId: string, snap: RewardSnapshot) {
  if (typeof window === "undefined") return;
  try {
    localStorage.setItem(key(studentId), JSON.stringify(snap));
  } catch {
    /* ignore */
  }
}

/** "2h ago" / "Yesterday" / "3 days ago" — short, friendly. */
export function relativeTime(ts: number, lang: "en" | "km" = "en"): string {
  const diff = Date.now() - ts;
  const min = Math.floor(diff / 60_000);
  const hr = Math.floor(diff / 3_600_000);
  const day = Math.floor(diff / 86_400_000);
  if (lang === "km") {
    if (min < 1) return "មុននេះ";
    if (min < 60) return `${min} នាទី​មុន`;
    if (hr < 24) return `${hr} ម៉ោង​មុន`;
    if (day < 2) return "ម្សិលមិញ";
    if (day < 30) return `${day} ថ្ងៃ​មុន`;
    return `${Math.floor(day / 30)} ខែ​មុន`;
  }
  if (min < 1) return "just now";
  if (min < 60) return `${min}m ago`;
  if (hr < 24) return `${hr}h ago`;
  if (day < 2) return "yesterday";
  if (day < 30) return `${day} days ago`;
  return `${Math.floor(day / 30)} months ago`;
}
