/**
 * RealtimeSyncBridge.jsx — invisible component that wakes every isolated
 * polling loop the instant a Web Push arrives, plus a safety-net poll for
 * long-term reliability.
 *
 * WHY THIS EXISTS
 * ───────────────
 * The audit found that pushes for `points credited` and `account restricted`
 * fire correctly (the OS banner appears) — but the in-app state lags up to
 * 12 s (points) and 15 s (restriction) because:
 *   • AuthContext's restriction watchdog polls /studentData every 15 s.
 *   • usePoints (Portal Dashboard only) polls every 12 s.
 *   • student.portalPoints in AuthContext is set ONCE at login and only
 *     updated via a manual library purchase or page refresh.
 *   • The service worker NEVER tells the page that a push arrived.
 *
 * WHAT THIS BRIDGE DOES
 * ─────────────────────
 *   1) Listens for EDUHUB_PUSH_SYNC messages from the v1.4 service worker.
 *      Whenever a push lands, the SW broadcasts a same-origin postMessage
 *      to every open client. We intercept it and:
 *        • dispatch a synthetic visibilitychange event — this wakes the
 *          existing AuthContext restriction watchdog, the useStudentData
 *          poller, and usePoints.refresh, all of which already have a
 *          `if (document.visibilityState === "visible") tick()` listener.
 *        • directly call AuthContext.refreshPoints() so the app-wide
 *          student.portalPoints (used by the Sidebar/Header/Library wallet
 *          pill) is refreshed even on screens that don't mount usePoints.
 *
 *   2) Listens to BroadcastChannel("eduhub-sync") so a refresh in one tab
 *      ripples to every other open tab.
 *
 *   3) Provides a 20 s SAFETY-NET poll while the app is visible. If the SW
 *      message ever fails to land (Safari ITP, throttled background tabs,
 *      a future browser quirk) the bridge keeps state fresh on its own.
 *      The poll IS NOT a duplicate of usePoints — it ONLY refreshes the
 *      AuthContext-level balance + restriction watchdog (cheap calls,
 *      already cached server-side) and is paused when the tab is hidden.
 *
 *   4) Handles cold-start taps: when a user taps a push banner while the
 *      PWA is killed, the SW appends `?syncKind=…&syncTs=…` to the target
 *      URL. We detect that on first paint and fire an immediate refresh
 *      so the dashboard greets the student with up-to-date numbers.
 *
 * HARD CONSTRAINTS HONOURED
 * ─────────────────────────
 *   • DOES NOT modify backend services, APIs, or push delivery.
 *   • DOES NOT modify usePoints.ts, useStudentData.ts, AuthContext.jsx,
 *     PointsCreditPushBridge.jsx, RestrictionGuard.jsx, sw.js push
 *     subscription path, or any library/book-fetching code.
 *   • Read-only against existing state — uses public AuthContext methods
 *     only (refreshPoints) and synthesises events the existing pollers
 *     already listen to.
 *   • All side-effects are wrapped in try/catch so a transient failure
 *     never breaks the rest of the app.
 *
 * File path: src/eduhub/components/RealtimeSyncBridge.jsx
 * Mounted by: src/App.js (next to <PointsCreditPushBridge />, inside <AuthProvider>)
 */
import { useEffect, useRef } from "react";
import { useAuth } from "../context/AuthContext";
import { POINTS_REFRESH_EVENT } from "../utils/pointsSync";

// v1.8.1: raised 20s to 30s - lighter background refresh cadence.
const SAFETY_NET_INTERVAL_MS = 30_000;
// v1.8.1: raised 1.5s to 3s - collapses back-to-back event-driven
// refresh waves (pageshow + focus + visibilitychange) into one.
const MIN_REFRESH_GAP_MS     = 3_000;
const SYNC_CHANNEL_NAME      = "eduhub-sync";

export default function RealtimeSyncBridge() {
  const { isAuthenticated, refreshPoints, student } = useAuth();
  const lastRefreshAtRef = useRef(0);
  const inFlightRef      = useRef(false);

  /* ──────────────────── helpers ──────────────────── */

  // The single source of truth for "wake every poll loop". Coalesces
  // back-to-back triggers into a single refresh wave.
  const wakeAll = useRef(async (origin = "unknown") => {
    if (typeof document === "undefined") return;
    const now = Date.now();
    if (now - lastRefreshAtRef.current < MIN_REFRESH_GAP_MS) return;
    if (inFlightRef.current) return;
    lastRefreshAtRef.current = now;
    inFlightRef.current = true;
    try {
      // 1) Fire a synthetic visibilitychange — every existing poller
      //    (AuthContext restriction watchdog, useStudentData, usePoints,
      //    unlocksService hydrate) already gates its refresh on
      //    document.visibilityState === "visible", so this is a safe
      //    no-op when the tab is hidden.
      try {
        document.dispatchEvent(new Event("visibilitychange"));
      } catch { /* old browser fallback */ }

      // 2) Refresh the app-wide AuthContext points balance so screens
      //    OUTSIDE /portal/me (Sidebar, Header, Library wallet pill)
      //    update too.
      try {
        if (typeof refreshPoints === "function") {
          await refreshPoints();
        }
      } catch { /* refreshPoints already swallows server errors */ }

      // 3) Notify other tabs of this realtime sync — the receiving tab
      //    triggers ITS own wakeAll() so the entire installation stays
      //    in lock-step.
      try {
        if ("BroadcastChannel" in window) {
          const ch = new BroadcastChannel(SYNC_CHANNEL_NAME);
          ch.postMessage({ type: "WAKE", origin, ts: now });
          // Close immediately — channels are cheap, no reason to keep open.
          setTimeout(() => { try { ch.close(); } catch { /* ignore */ } }, 100);
        }
      } catch { /* ignore */ }

      // 4) Surface a window-level event for any future consumer that
       //    wants a hook (e.g. analytics, toast). Keeps the bridge
       //    composable without forcing every consumer to know about it.
      try {
        window.dispatchEvent(new CustomEvent("eduhub:realtime-sync", {
          detail: { origin, ts: now },
        }));
      } catch { /* ignore */ }
    } finally {
      inFlightRef.current = false;
    }
  });

  /* ──────────────────── effects ──────────────────── */

  // SW push messages — primary, sub-second realtime path.
  useEffect(() => {
    if (typeof navigator === "undefined") return undefined;
    if (!("serviceWorker" in navigator)) return undefined;
    if (!isAuthenticated) return undefined;

    const onMessage = (event) => {
      const data = event && event.data;
      if (!data || data.type !== "EDUHUB_PUSH_SYNC") return;
      // Fan-out trigger; debounced inside wakeAll.
      try { wakeAll.current(`push:${data.kind || "generic"}`); }
      catch { /* never let SW noise break the app */ }
    };

    try {
      navigator.serviceWorker.addEventListener("message", onMessage);
    } catch { /* old browsers — bail silently */ }
    return () => {
      try { navigator.serviceWorker.removeEventListener("message", onMessage); }
      catch { /* ignore */ }
    };
  }, [isAuthenticated]);

  // Cross-tab sync via BroadcastChannel.
  useEffect(() => {
    if (typeof window === "undefined") return undefined;
    if (!("BroadcastChannel" in window)) return undefined;
    if (!isAuthenticated) return undefined;

    let ch;
    try {
      ch = new BroadcastChannel(SYNC_CHANNEL_NAME);
    } catch { return undefined; }

    const onMsg = (e) => {
      const d = e && e.data;
      if (!d || d.type !== "WAKE") return;
      try { wakeAll.current("broadcast"); }
      catch { /* ignore */ }
    };
    ch.addEventListener("message", onMsg);
    return () => {
      try { ch.removeEventListener("message", onMsg); ch.close(); }
      catch { /* ignore */ }
    };
  }, [isAuthenticated]);

  // Cold-start tap detection — the SW appends ?syncKind=…&syncTs=… when
  // the user taps a push banner that wakes the PWA from a killed state.
  useEffect(() => {
    if (typeof window === "undefined") return;
    if (!isAuthenticated) return;
    try {
      const u = new URL(window.location.href);
      const kind = u.searchParams.get("syncKind");
      const ts   = u.searchParams.get("syncTs");
      if (!kind || !ts) return;
      const ageMs = Date.now() - Number(ts);
      // Only honour fresh syncs — stale URLs (deep-link share) are ignored.
      if (!Number.isFinite(ageMs) || ageMs < 0 || ageMs > 5 * 60_000) return;
      // Strip the params so a refresh doesn't double-fire.
      try {
        u.searchParams.delete("syncKind");
        u.searchParams.delete("syncTs");
        const cleanUrl = u.pathname + (u.search ? `?${u.searchParams.toString()}` : "") + (u.hash || "");
        window.history.replaceState({}, "", cleanUrl);
      } catch { /* ignore */ }
      // Slight delay so AuthContext finishes its login hydration first.
      setTimeout(() => {
        try { wakeAll.current(`coldstart:${kind}`); }
        catch { /* ignore */ }
      }, 400);
    } catch { /* invalid URL — silently bail */ }
  }, [isAuthenticated]);

  // Network reconnect — instantly refresh whatever was missed offline.
  useEffect(() => {
    if (typeof window === "undefined") return undefined;
    if (!isAuthenticated) return undefined;
    const onOnline = () => {
      try { wakeAll.current("online"); } catch { /* ignore */ }
    };
    window.addEventListener("online", onOnline);
    return () => window.removeEventListener("online", onOnline);
  }, [isAuthenticated]);

  // Tab focus / visibility — defensive sweep on any return-to-foreground.
  useEffect(() => {
    if (typeof window === "undefined") return undefined;
    if (!isAuthenticated) return undefined;
    const onPageShow = () => {
      try { wakeAll.current("pageshow"); } catch { /* ignore */ }
    };
    window.addEventListener("pageshow", onPageShow);
    window.addEventListener("focus", onPageShow);
    return () => {
      window.removeEventListener("pageshow", onPageShow);
      window.removeEventListener("focus", onPageShow);
    };
  }, [isAuthenticated]);

  // App-internal refresh requests — Send Points, Top-Up success, EduTalk
  // charges, and any future module can call `requestPointsRefresh(origin)`
  // from utils/pointsSync.js and the entire app reconciles via the same
  // debounced wakeAll pipeline. This is the Option-3 "reuse existing
  // pattern" wiring: no new poll, no new context, no protected file
  // touched — RealtimeSyncBridge becomes the single fan-out point.
  useEffect(() => {
    if (typeof window === "undefined") return undefined;
    if (!isAuthenticated) return undefined;
    const onLocalRequest = (e) => {
      const origin = (e && e.detail && e.detail.origin) || "local";
      try { wakeAll.current(`local:${origin}`); }
      catch { /* never let a local dispatch break the app */ }
    };
    window.addEventListener(POINTS_REFRESH_EVENT, onLocalRequest);
    return () => {
      try { window.removeEventListener(POINTS_REFRESH_EVENT, onLocalRequest); }
      catch { /* ignore */ }
    };
  }, [isAuthenticated]);

  // Long-term safety-net poll. Runs ONLY while the tab is visible and the
  // student is logged in. The poll is interval-based but defers to the
  // wakeAll debounce, so we never stampede.
  useEffect(() => {
    if (typeof document === "undefined") return undefined;
    if (!isAuthenticated || !student?.studentId) return undefined;

    let id = null;
    const start = () => {
      stop();
      id = window.setInterval(() => {
        try { wakeAll.current("safety-net"); } catch { /* ignore */ }
      }, SAFETY_NET_INTERVAL_MS);
    };
    const stop = () => {
      if (id != null) {
        window.clearInterval(id);
        id = null;
      }
    };
    const onVis = () => {
      if (document.visibilityState === "visible") start();
      else stop();
    };

    if (document.visibilityState === "visible") start();
    document.addEventListener("visibilitychange", onVis);
    return () => {
      stop();
      document.removeEventListener("visibilitychange", onVis);
    };
  }, [isAuthenticated, student?.studentId]);

  return null;
}
