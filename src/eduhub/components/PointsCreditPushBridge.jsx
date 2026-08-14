// PointsCreditPushBridge.jsx — invisible component that fires a server push
// whenever the student's portal points balance is credited (any source: P2P
// transfer, teacher reward, game bonus, manual sheet edit). It watches the
// localStorage key written by usePoints (`myportal-latest-reward:{studentId}`)
// across both same-tab and cross-tab writes, and POSTs a fire-and-forget
// notification request to `/api/push/notify-credit`.
//
// HARD CONSTRAINTS (per Option-3 spec):
//   • DO NOT modify usePoints.ts, rewardMemory.ts, or pointsMemory.ts.
//   • DO NOT modify usePushNotifications.js — VAPID/subscribe contract is
//     shared with Author Studio.
//   • Reads only — never writes the storage key it observes.
//   • Server renders the title/body. We never send copy from the client.
//   • Bails silently if Notification.permission !== "granted" (no point
//     firing — the recipient won't see anything anyway, and we save a
//     backend round-trip).
//   • Idempotent on the bridge side: a useRef-tracked lastFiredTs prevents
//     the same snapshot from firing twice even when both the storage event
//     and the polling tick observe it.
//   • Idempotent on the backend: when this fires for a credit the sender's
//     SendPointsModal already pushed (P2P primary path), the backend
//     short-circuits via its 60 s `credit-p2p` recipient+amount window,
//     so the recipient's phone vibrates exactly ONCE per transfer.
//
// File path: src/eduhub/components/PointsCreditPushBridge.jsx
// Mounted by: src/App.js (next to <CoverPrefetcher />, inside <AuthProvider>)
import { useEffect, useRef } from "react";
import { useAuth } from "../context/AuthContext";

const REWARD_KEY_PREFIX = "myportal-latest-reward:";
const FRESH_WINDOW_MS = 60_000;     // only fire for credits < 60 s old
const POLL_INTERVAL_MS = 2500;       // catches same-tab writes (storage event
                                     // does NOT fire in the writing tab)

function rewardKeyFor(studentId) {
  return REWARD_KEY_PREFIX + studentId;
}

function readSnapshot(studentId) {
  try {
    const raw = localStorage.getItem(rewardKeyFor(studentId));
    if (!raw) return null;
    const r = JSON.parse(raw);
    if (!r || typeof r !== "object") return null;
    if (typeof r.amount !== "number" || typeof r.ts !== "number") return null;
    return r;
  } catch {
    return null;
  }
}

export default function PointsCreditPushBridge() {
  const { student } = useAuth();
  const lastFiredTsRef = useRef(0);

  useEffect(() => {
    if (typeof window === "undefined") return undefined;
    const studentId = student?.studentId;
    const password = student?.password;
    if (!studentId || !password) return undefined;

    // Permission gate — silent bail-out. No UI, no log noise.
    if (
      typeof Notification === "undefined" ||
      Notification.permission !== "granted"
    ) {
      return undefined;
    }

    const backendUrl = process.env.REACT_APP_BACKEND_URL;
    if (!backendUrl) return undefined;

    // Seed lastFiredTs from the current snapshot so we don't re-fire an
    // already-stored historical reward when the bridge mounts.
    const seed = readSnapshot(studentId);
    if (seed && typeof seed.ts === "number") {
      lastFiredTsRef.current = seed.ts;
    }

    let cancelled = false;

    const checkAndFire = () => {
      if (cancelled) return;
      const snap = readSnapshot(studentId);
      if (!snap) return;
      if (snap.amount <= 0) return;
      if (snap.ts <= lastFiredTsRef.current) return;
      if (Date.now() - snap.ts > FRESH_WINDOW_MS) {
        lastFiredTsRef.current = snap.ts;
        return;
      }

      // Mark fired BEFORE the request — fire-and-forget semantics. If the
      // request fails the user simply doesn't get a push; usePoints will
      // still render the LatestRewardCard from local state, so the in-app
      // experience is unaffected.
      lastFiredTsRef.current = snap.ts;

      const transferId = `self-detect:${studentId}:${snap.ts}`;
      try {
        fetch(`${backendUrl}/api/push/notify-credit`, {
          method: "POST",
          credentials: "omit",
          headers: {
            "Content-Type": "application/json",
            "Idempotency-Key": transferId,
          },
          body: JSON.stringify({
            senderStudentId: studentId,
            senderPassword: password,
            recipientStudentId: studentId,
            amount: Math.max(1, Math.floor(snap.amount)),
            transferId,
          }),
        }).catch(() => {
          /* fire-and-forget */
        });
      } catch {
        /* ignore — never let push noise break the app */
      }
    };

    // Cross-tab coverage: storage events fire in OTHER tabs when the same
    // origin writes to localStorage.
    const onStorage = (e) => {
      if (!e || e.key !== rewardKeyFor(studentId)) return;
      checkAndFire();
    };
    window.addEventListener("storage", onStorage);

    // Same-tab coverage: storage events do NOT fire in the writing tab,
    // so a small interval picks up writes the current tab makes (the
    // common case — usePoints polls in this very tab).
    const intervalId = window.setInterval(checkAndFire, POLL_INTERVAL_MS);

    // Run once on mount in case a fresh snapshot already exists from a
    // recent credit before this component mounted.
    checkAndFire();

    return () => {
      cancelled = true;
      window.removeEventListener("storage", onStorage);
      window.clearInterval(intervalId);
    };
    // student.password is intentionally part of the dep set so re-login
    // re-arms the bridge with fresh credentials.
  }, [student?.studentId, student?.password]);

  return null;
}
