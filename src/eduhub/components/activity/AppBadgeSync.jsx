/**
 * AppBadgeSync.jsx — syncs the unified unread total to the OS Home Screen
 * app icon badge (Badging API: navigator.setAppBadge / clearAppBadge).
 *
 * Renders nothing. Mounted once, inside NotificationProvider, alongside
 * ActivityDrawer (App.js). Reads the SAME unreadCount every other badge in
 * the app reads (via useUnifiedBadges → NotificationContext) — this is a
 * pure side-effect subscriber, not a second source of truth.
 *
 * Feature-detected: on a browser/platform without Badging API support
 * (most desktop browsers, non-installed PWAs, older iOS Safari), this is a
 * silent no-op. No polyfill, no warning, no behavior change for anyone who
 * doesn't have it.
 */
import { useEffect, useRef } from "react";
import { useUnifiedBadges } from "../../hooks/useUnifiedBadges";

export default function AppBadgeSync() {
  const { total } = useUnifiedBadges();
  const lastSyncedRef = useRef(null);

  useEffect(() => {
    if (typeof navigator === "undefined") return;
    if (lastSyncedRef.current === total) return;
    lastSyncedRef.current = total;

    try {
      if (total > 0 && typeof navigator.setAppBadge === "function") {
        navigator.setAppBadge(total).catch(() => {});
      } else if (total === 0 && typeof navigator.clearAppBadge === "function") {
        navigator.clearAppBadge().catch(() => {});
      }
    } catch {
      /* Badging API not supported here — silent no-op, never break the app. */
    }
  }, [total]);

  return null;
}
