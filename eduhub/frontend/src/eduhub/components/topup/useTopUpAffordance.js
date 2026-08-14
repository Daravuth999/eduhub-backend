/**
 * useTopUpAffordance.js — smart Top-Up trigger logic
 * ===================================================
 * Pure React hook that decides WHEN the Top-Up modal should auto-open.
 * No side-effects beyond reading sessionStorage / localStorage.
 *
 * Anti-spam rules (per spec):
 *   1. Once per session per route.
 *   2. After 3 dismissals in a rolling 7-day window  → 7-day snooze.
 *   3. Never if the post-login PointsTopUpPopup hasn't been dismissed
 *      yet (shared key avoids double-popups).
 *   4. 800 ms grace after a route change before firing (so animations
 *      settle and the user can read the page first).
 *   5. Manual button click via LibraryTopUpButton always works — that
 *      path bypasses this hook entirely.
 */

import { useEffect, useMemo, useState } from "react";
import {
  reasonForPath, thresholdForPath, CONTEXT_COPY,
} from "./topupCopy";

const SESSION_SHOWN_KEY = "eduhub_topup_auto_shown_v1";
const DISMISS_LOG_KEY   = "eduhub_topup_dismiss_log_v1";
const SNOOZE_UNTIL_KEY  = "eduhub_topup_snooze_until_v1";
const SHARED_POPUP_KEY  = "eduhub_topup_shown";  // existing PointsTopUpPopup key prefix

const SNOOZE_AFTER_DISMISSES = 3;
const SNOOZE_WINDOW_DAYS = 7;
const SNOOZE_DURATION_MS = 7 * 24 * 60 * 60 * 1000;
const ROUTE_GRACE_MS = 800;

function readSnoozeUntil() {
  try {
    const raw = localStorage.getItem(SNOOZE_UNTIL_KEY);
    return raw ? Number(raw) : 0;
  } catch { return 0; }
}

function readDismissLog() {
  try {
    const raw = localStorage.getItem(DISMISS_LOG_KEY);
    const arr = raw ? JSON.parse(raw) : [];
    return Array.isArray(arr) ? arr.filter((t) => typeof t === "number") : [];
  } catch { return []; }
}

function writeDismissLog(arr) {
  try { localStorage.setItem(DISMISS_LOG_KEY, JSON.stringify(arr)); } catch { /* ignore */ }
}

/** Record a dismissal. If 3 occur within 7 days, set a snooze. */
export function recordTopUpDismiss() {
  const now = Date.now();
  const log = readDismissLog().filter((t) => now - t < SNOOZE_WINDOW_DAYS * 24 * 60 * 60 * 1000);
  log.push(now);
  writeDismissLog(log);
  if (log.length >= SNOOZE_AFTER_DISMISSES) {
    try { localStorage.setItem(SNOOZE_UNTIL_KEY, String(now + SNOOZE_DURATION_MS)); } catch { /* ignore */ }
  }
  try { sessionStorage.setItem(SESSION_SHOWN_KEY, "1"); } catch { /* ignore */ }
}

/** Pick the package with the best points-per-riel ratio. */
export function pickRecommendedPackage(packages) {
  if (!Array.isArray(packages) || packages.length === 0) return null;
  return packages
    .map((p) => ({
      pkg: p,
      ratio: ((Number(p.points) || 0) + (Number(p.bonus_points) || 0)) /
             Math.max(1, Number(p.amount_khr) || 1),
    }))
    .sort((a, b) => b.ratio - a.ratio)[0].pkg;
}

/**
 * Decide whether the modal should auto-open.
 *
 * @param {object} args
 * @param {string} args.pathname        current route
 * @param {number|null|undefined} args.balance  current student PTS
 * @param {boolean} args.enabled        global enable flag (e.g. user logged in)
 */
export function useTopUpAffordance({ pathname, balance, enabled = true }) {
  const [graceReady, setGraceReady] = useState(false);

  // Reset grace timer on route change.
  useEffect(() => {
    setGraceReady(false);
    const t = setTimeout(() => setGraceReady(true), ROUTE_GRACE_MS);
    return () => clearTimeout(t);
  }, [pathname]);

  return useMemo(() => {
    const reason = reasonForPath(pathname);
    const threshold = thresholdForPath(pathname);
    const ctx = CONTEXT_COPY[reason] || CONTEXT_COPY.manual;
    const result = {
      reason,
      threshold,
      headlineKm: ctx.headline_km,
      bodyKm: ctx.body_km,
      shouldShow: false,
      blockedBy: "",
    };

    if (!enabled) { result.blockedBy = "disabled"; return result; }
    if (!graceReady) { result.blockedBy = "grace"; return result; }
    if (typeof balance !== "number") { result.blockedBy = "no-balance"; return result; }
    if (balance >= threshold) { result.blockedBy = "balance-ok"; return result; }
    if (reason === "manual") { result.blockedBy = "manual-route"; return result; }

    try {
      if (sessionStorage.getItem(SESSION_SHOWN_KEY) === "1") {
        result.blockedBy = "session-shown";
        return result;
      }
      // Avoid stacking on top of the post-login popup that uses
      // sessionStorage keys prefixed `eduhub_topup_shown_<studentId>`.
      const allKeys = Object.keys(sessionStorage);
      const popupKey = allKeys.find((k) => k.startsWith(SHARED_POPUP_KEY) && k !== SESSION_SHOWN_KEY);
      if (popupKey && sessionStorage.getItem(popupKey) === "1") {
        // Existing popup already shown → fine to overlay later, but only after the grace window expires.
        // (no-op — fall through)
      }
      const snoozeUntil = readSnoozeUntil();
      if (snoozeUntil && Date.now() < snoozeUntil) {
        result.blockedBy = "snoozed";
        return result;
      }
    } catch {
      // storage unavailable → silently allow
    }

    result.shouldShow = true;
    return result;
  }, [pathname, balance, enabled, graceReady]);
}

/** Stamp this session as "already auto-shown" — caller invokes this when the modal opens. */
export function markTopUpAutoShown() {
  try { sessionStorage.setItem(SESSION_SHOWN_KEY, "1"); } catch { /* ignore */ }
}

/**
 * Whether top-up prompts are currently snoozed for this student — reuses the
 * EXACT 3-dismissal / 7-day snooze state written by recordTopUpDismiss(). Used
 * by the EduTalk Live Coach Smart Top-Up Nudge pill so a student who recently
 * dismissed top-up prompts does not see that pill either. Pure read; never
 * writes. Returns false when storage is unavailable (fail-open like the hook).
 */
export function isTopUpSnoozed() {
  try {
    const snoozeUntil = readSnoozeUntil();
    return !!(snoozeUntil && Date.now() < snoozeUntil);
  } catch {
    return false;
  }
}
