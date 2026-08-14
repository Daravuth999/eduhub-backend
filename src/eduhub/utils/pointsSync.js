/**
 * pointsSync.js — lightweight global points-refresh broadcaster
 * ==============================================================
 *
 * Purpose
 * -------
 * EduHub already has a strong points pipeline (AuthContext.refreshPoints +
 * RealtimeSyncBridge), but several screens that change the balance LOCALLY
 * (Send Points modal, EduTalk charges, top-up modal success, etc.) used to
 * only update their OWN state. As a result, sibling views that read
 * `useAuth().student.portalPoints` (Library wallet pill, header pill,
 * sidebar) sometimes lagged until the next 20 s safety-net poll.
 *
 * This utility introduces a single, dependency-free event bus on top of
 * the existing `window` object so any module can REQUEST a points refresh
 * without importing AuthContext or knowing where the source of truth lives.
 *
 * Events emitted
 * --------------
 *   • `eduhub:points-refresh-requested`
 *       — fire-and-forget signal that some local state just changed.
 *       — listened to by RealtimeSyncBridge, which debounces and calls
 *         AuthContext.refreshPoints() to reconcile against the server.
 *   • `eduhub:points-updated` (optional, informational)
 *       — broadcast AFTER a known balance is available (e.g. server-
 *         returned newBalance from Send Points). Consumers can use it for
 *         optimistic UI updates without touching AuthContext directly.
 *
 * Hard constraints honoured
 * -------------------------
 *   • Pure helper. Zero dependencies. SSR-safe (window guarded).
 *   • Never throws — every dispatch is wrapped in try/catch so a transient
 *     failure cannot break a payment / send / EduTalk flow.
 *   • Cooperates with the existing BroadcastChannel("eduhub-sync") bridge
 *     used by RealtimeSyncBridge for cross-tab fan-out.
 *   • Does NOT mutate AuthContext, does NOT register pollers, does NOT
 *     read or write localStorage. It is strictly a notification channel.
 *
 * File path: src/eduhub/utils/pointsSync.js
 */

export const POINTS_REFRESH_EVENT = "eduhub:points-refresh-requested";
export const POINTS_UPDATED_EVENT = "eduhub:points-updated";

/**
 * Request a points refresh from anywhere in the app.
 *
 * Listener (RealtimeSyncBridge) will debounce back-to-back calls into a
 * single round-trip, so it is safe to call this from multiple sources
 * for the same logical event (e.g. PointsPurchaseModal.onCredited AND
 * LibraryPage.onCredited may both fire — only one server call results).
 *
 * @param {string} origin  Short tag for diagnostics ("send_points",
 *                         "topup_credited", "edutalk_charge", ...).
 * @param {object} [detail] Optional payload (e.g. expected new balance).
 */
export function requestPointsRefresh(origin = "unknown", detail = {}) {
  if (typeof window === "undefined") return;
  try {
    window.dispatchEvent(
      new CustomEvent(POINTS_REFRESH_EVENT, {
        detail: { origin, ts: Date.now(), ...detail },
      }),
    );
  } catch {
    /* never let a bus dispatch break the caller */
  }
}

/**
 * Broadcast that a fresh balance is known locally (e.g. server returned
 * a confirmed newBalance). Optional — most callers should just use
 * `requestPointsRefresh()` and let AuthContext re-fetch.
 *
 * @param {number} points
 * @param {string} origin
 */
export function broadcastPointsUpdated(points, origin = "unknown") {
  if (typeof window === "undefined") return;
  if (typeof points !== "number" || !Number.isFinite(points)) return;
  try {
    window.dispatchEvent(
      new CustomEvent(POINTS_UPDATED_EVENT, {
        detail: { points: Math.max(0, Math.floor(points)), origin, ts: Date.now() },
      }),
    );
  } catch {
    /* never let a bus dispatch break the caller */
  }
}

/**
 * Subscribe to the refresh-requested signal. Returns an unsubscribe fn.
 *
 * @param {(detail: { origin: string, ts: number }) => void} fn
 * @returns {() => void}
 */
export function onPointsRefreshRequested(fn) {
  if (typeof window === "undefined" || typeof fn !== "function") return () => {};
  const handler = (e) => {
    try {
      fn((e && e.detail) || {});
    } catch {
      /* swallow listener errors */
    }
  };
  window.addEventListener(POINTS_REFRESH_EVENT, handler);
  return () => {
    try {
      window.removeEventListener(POINTS_REFRESH_EVENT, handler);
    } catch {
      /* ignore */
    }
  };
}

/**
 * Subscribe to known-balance updates. Returns an unsubscribe fn.
 *
 * @param {(detail: { points: number, origin: string, ts: number }) => void} fn
 * @returns {() => void}
 */
export function onPointsUpdated(fn) {
  if (typeof window === "undefined" || typeof fn !== "function") return () => {};
  const handler = (e) => {
    try {
      fn((e && e.detail) || {});
    } catch {
      /* swallow listener errors */
    }
  };
  window.addEventListener(POINTS_UPDATED_EVENT, handler);
  return () => {
    try {
      window.removeEventListener(POINTS_UPDATED_EVENT, handler);
    } catch {
      /* ignore */
    }
  };
}
