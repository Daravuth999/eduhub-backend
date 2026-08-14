import { useCallback, useEffect, useRef, useState } from "react";
import { useAuth } from "../context/AuthContext";
import usePushNotifications from "./usePushNotifications";

/**
 * useBellRingPermission — v2.2.0 (2026-05-08) AUTO-RESUBSCRIBE.
 *
 * v2.1.0 strict check required BOTH permission=granted AND active push
 * subscription. This caused existing users whose subscription was lost
 * (SW update, browser cache clear, backend expiry) to get re-gated even
 * though they already allowed notifications.
 *
 * v2.2.0 fix: if permission=granted but subscription is missing AND
 * studentId is known, silently re-subscribe before deciding gate state.
 * Existing users with valid subscriptions: ZERO change.
 * Existing users with lost subscriptions: auto-healed, gate stays closed.
 * New users: unchanged flow.
 */
export default function useBellRingPermission() {
  const { student } = useAuth();
  const studentId = student?.studentId;
  const group = student?.group || student?.batch || "default";

  const { supported, enable } = usePushNotifications(studentId, group);

  // Live strict state — recomputed on every focus/visibility event.
  const [permissionRaw, setPermissionRaw] = useState(() =>
    typeof Notification !== "undefined" ? Notification.permission : "unsupported"
  );
  const [hasSubscription, setHasSubscription] = useState(false);
  const aliveRef = useRef(true);

  // Run a fresh strict check: reads live Notification.permission AND
  // live pushManager.getSubscription(). Both must agree.
  // v2.2.0 — if subscription is missing but permission is granted and
  // student is authenticated, attempt silent re-subscribe before failing.
  const strictCheck = useCallback(async () => {
    if (!supported) return;
    if (typeof Notification === "undefined") return;
    const livePerm = Notification.permission;
    if (aliveRef.current) setPermissionRaw(livePerm);

    if (livePerm !== "granted") {
      if (aliveRef.current) setHasSubscription(false);
      return;
    }
    try {
      const reg = await navigator.serviceWorker.ready;
      let sub = await reg.pushManager.getSubscription();
      // v2.2.0 — auto-resubscribe existing users whose subscription was lost
      if (!sub && studentId) {
        try {
          const ok = await enable();
          sub = ok ? await reg.pushManager.getSubscription() : null;
        } catch {
          sub = null;
        }
      }
      if (aliveRef.current) setHasSubscription(!!sub);
    } catch {
      if (aliveRef.current) setHasSubscription(false);
    }
  }, [supported, studentId, enable]);

  // Mount + listeners. Strict re-check on every return-to-tab event.
  useEffect(() => {
    aliveRef.current = true;
    strictCheck();
    const onVis = () => {
      if (document.visibilityState === "visible") strictCheck();
    };
    const onFocus = () => strictCheck();
    document.addEventListener("visibilitychange", onVis);
    window.addEventListener("focus", onFocus);
    // Also react to the W3C pushsubscriptionchange event when the SW
    // signals the push subscription has changed under our feet.
    const onSubChange = () => strictCheck();
    if ("serviceWorker" in navigator && navigator.serviceWorker) {
      navigator.serviceWorker.addEventListener("message", onSubChange);
    }
    return () => {
      aliveRef.current = false;
      document.removeEventListener("visibilitychange", onVis);
      window.removeEventListener("focus", onFocus);
      if ("serviceWorker" in navigator && navigator.serviceWorker) {
        navigator.serviceWorker.removeEventListener("message", onSubChange);
      }
    };
  }, [strictCheck]);

  // Strict effective permission — gate consumes this directly.
  const effectivePermission = !supported
    ? "unsupported"
    : permissionRaw === "granted" && hasSubscription
    ? "granted"
    : permissionRaw === "denied"
    ? "denied"
    : "default";

  // request() — invoked when student taps "Allow Notifications" inside
  // the gate. Delegates the full flow to the existing enable() helper:
  //   1. Notification.requestPermission()
  //   2. fetch /api/push/vapid-public-key
  //   3. pushManager.subscribe(...)
  //   4. POST /api/push/subscribe to Render backend
  // Then re-runs the strict check so effectivePermission flips to
  // "granted" without waiting for the next focus event.
  const request = useCallback(async () => {
    if (!supported) return "unsupported";

    if (!studentId) {
      // Pre-auth fallback (e.g. nag card on Home before login resolves).
      // Just request permission; subscribe will happen automatically when
      // the student is authenticated and re-encounters the gate.
      try {
        const perm = await Notification.requestPermission();
        await strictCheck();
        return perm;
      } catch {
        return Notification.permission;
      }
    }

    const ok = await enable();
    await strictCheck();
    if (ok) return "granted";
    return Notification.permission;
  }, [supported, studentId, enable, strictCheck]);

  // Manual refresh hook for callers that need to force-revalidate.
  const refresh = useCallback(() => {
    strictCheck();
  }, [strictCheck]);

  // Local welcome notification — bilingual, matches Author Studio
  // remote push visual signature (icon-192 + vibrate [200,100,200]).
  // Silent on any failure; never blocks the gate flow.
  const fireWelcome = useCallback(async (studentName) => {
    if (typeof window === "undefined") return;
    if (!("Notification" in window)) return;
    if (Notification.permission !== "granted") return;
    if (!("serviceWorker" in navigator)) return;
    try {
      const reg = await navigator.serviceWorker.ready;
      const nameLine = studentName ? `${studentName}, ` : "";
      await reg.showNotification(
        "🔔 Bell Ring Enabled · បានបើកការជូនដំណឹង!",
        {
          body:
            `${nameLine}you'll now get class announcements, speaking feedback, and progress updates.\n` +
            `ចាប់ពីពេលនេះ អ្នកនឹងទទួលបានព័ត៌មានថ្មីៗពីថ្នាក់រៀន។`,
          icon: "/icons/icon-192.png",
          badge: "/icons/icon-192.png",
          vibrate: [200, 100, 200],
          data: { url: "/" },
          tag: "bellring-welcome",
        }
      );
    } catch (e) {
      /* swallow — never break onboarding */
    }
  }, []);

  return {
    permission: effectivePermission,
    supported,
    request,
    refresh,
    fireWelcome,
  };
}