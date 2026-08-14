/**
 * liveCoachTopupSnooze.js — EduTalk-Live-Coach-ONLY Smart Top-Up snooze.
 *
 * Phase 0B (see EMERGENT_PHASE0_1_REFINED_BUILD_PROMPT.md §B.10 "Separate
 * EduTalk-only snooze"). This file deliberately uses its OWN per-student keys
 * and NEVER reads or writes the shared app-wide keys owned by
 * `useTopUpAffordance.js` (`eduhub_topup_*_v1`). The shared app-wide popup must
 * remain byte-for-byte behaviourally unchanged.
 *
 * Deterministic non-migration decision: the old shared values are intentionally
 * NOT copied/migrated into these per-student keys because ownership is ambiguous
 * on shared devices (multiple students on one browser). Each student starts with
 * a clean EduTalk snooze ledger keyed by their normalized id.
 *
 * Mirrors the existing anti-spam rule: 3 dismissals in a rolling 7-day window →
 * a 7-day snooze. Pure reads never write; storage-unavailable fails open (no
 * snooze) exactly like the shared hook.
 */

const DISMISS_LOG_PREFIX = "eduhub_edutalk_topup_dismiss_log_v1";
const SNOOZE_UNTIL_PREFIX = "eduhub_edutalk_topup_snooze_until_v1";

const SNOOZE_AFTER_DISMISSES = 3;
const SNOOZE_WINDOW_DAYS = 7;
const SNOOZE_WINDOW_MS = SNOOZE_WINDOW_DAYS * 24 * 60 * 60 * 1000;
const SNOOZE_DURATION_MS = SNOOZE_WINDOW_MS;

/** Normalize a student id the same way the backend `clean_id` is normalized:
 *  trim + lowercase. Returns "" for empty/invalid so callers can no-op safely. */
export function normalizeStudentId(studentId) {
  if (studentId == null) return "";
  const s = String(studentId).trim().toLowerCase();
  return s.length > 0 && s.length <= 64 ? s : "";
}

/** Exact per-student key formats (exported for tests). */
export function dismissLogKey(studentId) {
  return `${DISMISS_LOG_PREFIX}:${normalizeStudentId(studentId)}`;
}
export function snoozeUntilKey(studentId) {
  return `${SNOOZE_UNTIL_PREFIX}:${normalizeStudentId(studentId)}`;
}

function readSnoozeUntil(studentId) {
  try {
    const raw = localStorage.getItem(snoozeUntilKey(studentId));
    return raw ? Number(raw) : 0;
  } catch {
    return 0;
  }
}

function readDismissLog(studentId) {
  try {
    const raw = localStorage.getItem(dismissLogKey(studentId));
    const arr = raw ? JSON.parse(raw) : [];
    return Array.isArray(arr) ? arr.filter((t) => typeof t === "number") : [];
  } catch {
    return [];
  }
}

function writeDismissLog(studentId, arr) {
  try {
    localStorage.setItem(dismissLogKey(studentId), JSON.stringify(arr));
  } catch {
    /* ignore */
  }
}

/**
 * Whether the EduTalk Live Coach Top-Up pill is currently snoozed for THIS
 * student. Pure read; never writes. Returns false for an unknown student id or
 * when storage is unavailable (fail-open, matching the shared hook).
 */
export function isEduTalkTopUpSnoozed(studentId) {
  const sid = normalizeStudentId(studentId);
  if (!sid) return false;
  try {
    const until = readSnoozeUntil(sid);
    return !!(until && Date.now() < until);
  } catch {
    return false;
  }
}

/**
 * Record an EduTalk pill dismissal for THIS student. After 3 dismissals in a
 * rolling 7-day window, set a 7-day per-student snooze. No-op for an unknown
 * student id. Never touches the shared app-wide keys.
 */
export function recordEduTalkTopUpDismiss(studentId) {
  const sid = normalizeStudentId(studentId);
  if (!sid) return;
  const now = Date.now();
  const log = readDismissLog(sid).filter((t) => now - t < SNOOZE_WINDOW_MS);
  log.push(now);
  writeDismissLog(sid, log);
  if (log.length >= SNOOZE_AFTER_DISMISSES) {
    try {
      localStorage.setItem(
        snoozeUntilKey(sid), String(now + SNOOZE_DURATION_MS));
    } catch {
      /* ignore */
    }
  }
}
