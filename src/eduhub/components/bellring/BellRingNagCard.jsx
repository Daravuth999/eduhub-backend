import { useEffect, useState } from "react";
import { useLocation } from "react-router-dom";
import useBellRingPermission from "@/eduhub/hooks/useBellRingPermission";
import { useAuth } from "@/eduhub/context/AuthContext";
import BellRingGate from "./BellRingGate";

/**
 * BellRingNagCard — v4.0.0 HARD-BLOCK
 *
 * Replaces the soft "nag card" banner with an inescapable full-screen gate
 * that fires immediately after login and cannot be dismissed without granting
 * push notification permission.
 *
 * Rules:
 *   • Logged-out → renders nothing (visitors browse freely)
 *   • Logged-in + permission granted + subscription active → renders nothing
 *   • Logged-in + unsupported browser → renders nothing (don't punish old browsers)
 *   • Logged-in + permission default or denied → hard-block gate, no escape
 *
 * Auth state: uses `isAuthenticated` (covers both the Render-backed
 * `renderStudent` and the GAS-backed `student`) so the gate fires the
 * instant loginStudent() resolves, without waiting for GAS hydration.
 *
 * Smart re-detection:
 *   useBellRingPermission v2.2.0 runs `strictCheck` on every
 *   visibilitychange + focus event, reading live Notification.permission
 *   AND pushManager.getSubscription(). If a student disables notifications
 *   in OS Settings and returns to the tab, strictCheck fires, permission
 *   flips to "default" (or the hook detects no subscription), `needsEnable`
 *   becomes true, and this component immediately re-renders the gate.
 *   There is no poll interval needed — the browser event is instant.
 */
export default function BellRingNagCard() {
  const { pathname } = useLocation();
  const { permission, supported } = useBellRingPermission();
  const { isAuthenticated } = useAuth();
  const [gateOpen, setGateOpen] = useState(false);

  const onHome = pathname === "/" || pathname === "";
  const isLoggedIn = !!isAuthenticated;
  // "needsEnable" is true whenever permission is not fully granted with an
  // active push subscription (both must be true per useBellRingPermission v2.2.0).
  const needsEnable = supported && permission !== "granted";

  // Open the gate immediately whenever the conditions are met.
  // The gate itself is inescapable in hardBlock mode, so we only need to
  // track open/close to avoid React warnings — the gate never lets the user
  // close it without granting permission.
  useEffect(() => {
    if (onHome && isLoggedIn && needsEnable) {
      setGateOpen(true);
    } else {
      setGateOpen(false);
    }
  }, [onHome, isLoggedIn, needsEnable, permission]);

  // Nothing to render when conditions not met.
  if (!onHome || !isLoggedIn || !needsEnable) return null;

  return (
    <BellRingGate
      open={gateOpen}
      // onClose is called only after permission is truly granted (inside BellRingGate
      // on the "success" path, which reloads the page anyway). We keep the state
      // handler here for correctness but the reload makes it moot.
      onClose={() => setGateOpen(false)}
      hardBlock={true}
    />
  );
}
