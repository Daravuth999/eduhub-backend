/**
 * Per-student persistent memory of the last-known points balance.
 * Used so the celebration system can detect changes that happened
 * BETWEEN sessions (teacher rewards, game bonuses, sheet edits) — not
 * just changes during an active session.
 */

interface Snapshot {
  value: number;
  /** Unix ms when this snapshot was written. */
  ts: number;
}

const KEY_PREFIX = "myportal-points-last:";
/** Snapshots older than this are considered stale and ignored. */
const STALE_AFTER_MS = 30 * 24 * 60 * 60_000; // 30 days

function key(studentId: string) {
  return KEY_PREFIX + studentId;
}

export function readLastBalance(studentId: string): number | null {
  if (typeof window === "undefined") return null;
  try {
    const raw = localStorage.getItem(key(studentId));
    if (!raw) return null;
    const snap = JSON.parse(raw) as Snapshot;
    if (
      typeof snap.value !== "number" ||
      typeof snap.ts !== "number" ||
      Number.isNaN(snap.value)
    ) {
      return null;
    }
    if (Date.now() - snap.ts > STALE_AFTER_MS) return null;
    return snap.value;
  } catch {
    return null;
  }
}

export function writeLastBalance(studentId: string, value: number) {
  if (typeof window === "undefined") return;
  try {
    const snap: Snapshot = { value, ts: Date.now() };
    localStorage.setItem(key(studentId), JSON.stringify(snap));
  } catch {
    /* ignore quota / privacy errors */
  }
}

/** Returns the timestamp (ms) of the last write — for the debug panel. */
export function lastBalanceTimestamp(studentId: string): number | null {
  if (typeof window === "undefined") return null;
  try {
    const raw = localStorage.getItem(key(studentId));
    if (!raw) return null;
    const snap = JSON.parse(raw) as Snapshot;
    return typeof snap.ts === "number" ? snap.ts : null;
  } catch {
    return null;
  }
}
