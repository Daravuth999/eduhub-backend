/**
 * StatusEnforcer.jsx — v10.0 invisible real-time status guard.
 *
 * Polls the new Render-side /api/student/status/{id} endpoint every 3 s
 * (which reads from the MongoDB student_status collection — the new single
 * source of truth). Whenever the status flips away from "active" the
 * enforcer:
 *
 *   1. Dispatches a synthetic visibilitychange event so AuthContext's
 *      EXISTING 15-s watchdog re-reads its Google Sheet copy on the spot
 *      (the backend already mirrored Mongo → GAS during the PATCH, so GAS
 *      now also reads "TRUE"). This lights up the existing RestrictionGuard
 *      overlay + 3-s sign-out countdown without modifying AuthContext.
 *
 *   2. For statuses that should HARD logout immediately (suspended,
 *      deactivated) the enforcer also calls useAuth().logout() after a
 *      short grace period — purely as a backstop in case the GAS mirror
 *      had a transient failure.
 *
 *   3. Cross-tab sync via BroadcastChannel("eduhub-status") — a status
 *      change picked up in one PWA tab nudges siblings instantly.
 *
 * Hard constraints honoured (safeguards every currently functional piece):
 *   • DOES NOT modify AuthContext.jsx, RestrictionGuard.jsx, sw.js,
 *     RealtimeSyncBridge.jsx, usePoints.ts, useStudentData.ts,
 *     PointsCreditPushBridge.jsx, library / books / reader.
 *   • DOES NOT touch the existing 15-s GAS watchdog. It supplements it.
 *   • Read-only against the network (single GET per 3 s) — bails silently
 *     on every error so a transient outage never breaks the app.
 *   • Pauses when the tab is hidden — no battery / quota drain in the
 *     background.
 *
 * Mounted by: src/App.js — single instance inside <AuthProvider>, next to
 * RealtimeSyncBridge.
 */
import { useEffect, useRef } from "react";
import { useAuth } from "../context/AuthContext";
import { hasActiveSession } from "../lib/activeSessionRegistry";

// v1.8.1: raised 3s to 10s to cut backend request pressure ~3.3x and free
// HTTP/1.1 connection slots for audio Range requests on the single Render
// worker. Restriction changes still apply within one 10s poll cycle.
const POLL_INTERVAL_MS = 10_000;
const HARD_LOGOUT_GRACE_MS = 6_000;
const STATUS_CHANNEL_NAME = "eduhub-status";
const STORAGE_KEY = "eduhub_status_v1"; // diagnostic mirror, not auth

/* eslint-disable no-undef */
const API_BASE = (process.env.REACT_APP_BACKEND_URL || "").replace(/\/$/, "");
/* eslint-enable no-undef */

const HARD_LOGOUT_STATUSES = new Set(["suspended", "deactivated"]);
const SOFT_LOCK_STATUSES   = new Set(["restricted"]);

export default function StatusEnforcer() {
  const { student, isAuthenticated, logout } = useAuth();
  const lastSeenVersionRef = useRef(-1);
  const lastWakeAtRef      = useRef(0);
  const hardLogoutTimerRef = useRef(null);

  const wakeAuthWatchdog = useRef(() => {
    // Coalesce rapid wakes — at most one wake per 1.2 s.
    const now = Date.now();
    if (now - lastWakeAtRef.current < 1_200) return;
    lastWakeAtRef.current = now;
    try { document.dispatchEvent(new Event("visibilitychange")); } catch { /* ignore */ }
    try {
      if ("BroadcastChannel" in window) {
        const ch = new BroadcastChannel(STATUS_CHANNEL_NAME);
        ch.postMessage({ type: "STATUS_NUDGE", ts: now });
        setTimeout(() => { try { ch.close(); } catch { /* ignore */ } }, 100);
      }
    } catch { /* ignore */ }
    try {
      window.dispatchEvent(new CustomEvent("eduhub:status-change", {
        detail: { ts: now },
      }));
    } catch { /* ignore */ }
  });

  /* ──────────────────── poll loop ──────────────────── */
  useEffect(() => {
    if (!isAuthenticated || !student?.studentId) return undefined;
    if (!API_BASE) return undefined; // no backend configured — skip silently

    let cancelled = false;
    let intervalId = null;

    const url = `${API_BASE}/api/student/status/${encodeURIComponent(student.studentId)}`;

    const tick = async () => {
      if (cancelled) return;
      let res;
      try {
        // v1.8.1: removed the "X-Student-Id" custom header. A custom request
        // header forces a CORS preflight (OPTIONS) which the realtime status
        // endpoint answers with 400, flooding the console with CORS errors
        // and blocking the GET. The student id is already in the URL path
        // (/api/student/status/{id}) so the header was redundant. A plain GET
        // with no custom header is a CORS "simple request" - no preflight.
        res = await fetch(url, {
          method: "GET",
          credentials: "omit",
          cache: "no-store",
        });
      } catch {
        return; // offline — silent retry next tick
      }
      if (!res.ok) return; // 5xx / 404 — silent retry
      let doc;
      try { doc = await res.json(); } catch { return; }
      if (!doc || !doc.status) return;

      const ver = Number(doc.statusVersion || 0);
      if (ver === lastSeenVersionRef.current) return; // nothing changed

      // Auto-lift check (server already knows but the client is defensive).
      const liftAt = doc.liftAt ? new Date(doc.liftAt) : null;
      const liftedByClock =
        liftAt && !Number.isNaN(liftAt.getTime()) && liftAt.getTime() <= Date.now();
      const effectiveStatus = liftedByClock ? "active" : String(doc.status).toLowerCase();

      // Issue 4 fix — a hard-logout-eligible status observed while a
      // premium session (e.g. Live Voice Coach) is in progress is
      // DEFERRED, never dropped: `lastSeenVersionRef` is deliberately left
      // unadvanced, so this exact same version is re-evaluated from
      // scratch on the very next 10s poll tick instead of being silently
      // swallowed by the "nothing changed" fast-path above. The moment the
      // session ends, the next tick arms the timer normally. The
      // restriction overlay still surfaces immediately (wakeAuthWatchdog
      // still fires below) — only the AUTOMATIC sign-out is paused; a
      // student can always sign out immediately via RestrictionGuard's own
      // manual button regardless of this defer.
      if (HARD_LOGOUT_STATUSES.has(effectiveStatus) && hasActiveSession()) {
        wakeAuthWatchdog.current();
        return;
      }
      lastSeenVersionRef.current = ver;

      // Diagnostic mirror so DevTools / future tabs can see the last status.
      try {
        sessionStorage.setItem(STORAGE_KEY, JSON.stringify({
          ...doc,
          effectiveStatus,
          observedAt: Date.now(),
        }));
      } catch { /* ignore */ }

      if (effectiveStatus === "active") {
        // Cancel any pending hard-logout timer — status went green.
        if (hardLogoutTimerRef.current) {
          clearTimeout(hardLogoutTimerRef.current);
          hardLogoutTimerRef.current = null;
        }
        // Still nudge AuthContext so any UI showing a restriction clears.
        wakeAuthWatchdog.current();
        return;
      }

      // Non-active: nudge AuthContext immediately so its watchdog reads the
      // GAS mirror (which the backend just wrote) and lights up the
      // existing RestrictionGuard overlay with the correct copy.
      wakeAuthWatchdog.current();

      // Hard logout grace timer for suspended / deactivated as a backstop.
      if (HARD_LOGOUT_STATUSES.has(effectiveStatus)) {
        if (!hardLogoutTimerRef.current) {
          hardLogoutTimerRef.current = setTimeout(() => {
            hardLogoutTimerRef.current = null;
            // Re-audit fix: the timer is armed here (no active session at
            // arm time), but a premium session (e.g. Live Voice Coach) can
            // start at ANY point during the 6s grace window — this fires
            // unconditionally 6s later regardless. The tick-time defer
            // above (hasActiveSession() check before arming) only protects
            // sessions that were ALREADY active when the status was
            // observed; it can't protect a session that started after this
            // timer was already scheduled. Re-check right before acting so
            // an in-progress paid session is never killed mid-session —
            // matches the same "defer, never drop" contract as the
            // tick-time check: the next poll tick re-evaluates and re-arms
            // once the session actually ends.
            if (hasActiveSession()) return;
            try { logout(); } catch { /* AuthContext gone — last resort */
              try {
                sessionStorage.clear();
                window.location.assign("/");
              } catch { /* ignore */ }
            }
          }, HARD_LOGOUT_GRACE_MS);
        }
      }
    };

    const start = () => {
      stop();
      // Immediate tick + interval — hidden tabs throttle setInterval
      // anyway, and the visibilitychange handler resumes us.
      tick();
      intervalId = window.setInterval(tick, POLL_INTERVAL_MS);
    };
    const stop = () => {
      if (intervalId != null) {
        window.clearInterval(intervalId);
        intervalId = null;
      }
    };

    // Start when visible, pause when hidden — saves battery / quota.
    const onVis = () => {
      if (document.visibilityState === "visible") start();
      else stop();
    };

    if (document.visibilityState === "visible") start();
    document.addEventListener("visibilitychange", onVis);

    return () => {
      cancelled = true;
      stop();
      document.removeEventListener("visibilitychange", onVis);
      if (hardLogoutTimerRef.current) {
        clearTimeout(hardLogoutTimerRef.current);
        hardLogoutTimerRef.current = null;
      }
    };
  }, [isAuthenticated, student?.studentId, logout]);

  /* ──────────────────── cross-tab nudges ──────────────────── */
  useEffect(() => {
    if (typeof window === "undefined") return undefined;
    if (!("BroadcastChannel" in window)) return undefined;
    if (!isAuthenticated) return undefined;
    let ch;
    try { ch = new BroadcastChannel(STATUS_CHANNEL_NAME); } catch { return undefined; }
    const onMsg = (e) => {
      if (!e?.data || e.data.type !== "STATUS_NUDGE") return;
      // Sibling tab saw a status change — force a tick on this tab too.
      lastSeenVersionRef.current = -1;
      try { document.dispatchEvent(new Event("visibilitychange")); } catch { /* ignore */ }
    };
    ch.addEventListener("message", onMsg);
    return () => {
      try { ch.removeEventListener("message", onMsg); ch.close(); } catch { /* ignore */ }
    };
  }, [isAuthenticated]);

  return null;
}
