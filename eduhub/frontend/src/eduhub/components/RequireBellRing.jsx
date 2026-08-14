import { useEffect, useState } from "react";
import useBellRingPermission from "@/eduhub/hooks/useBellRingPermission";
import BellRingGate from "./bellring/BellRingGate";

/**
 * RequireBellRing — route guard for all progression routes.
 * v2.0 — HARD-BLOCK on every protected route.
 *
 * Previous behaviour (v1): children rendered BEHIND the gate (so the back
 * transition felt instant). The gate was soft — denying navigated the user
 * to "/". This meant a student could close the gate, land on "/", and then
 * navigate to any route WITHOUT notifications enabled as long as they were
 * fast enough.
 *
 * v2.0 behaviour:
 *   • permission === 'granted' (+ subscription)  → render children normally
 *   • permission === 'default' or 'denied'        → render NOTHING behind the
 *     gate. Content is null until the student enables notifications.
 *     Gate is hardBlock=true — no dismiss, no navigate-away.
 *   • permission === 'unsupported'               → render children (can't
 *     receive pushes at all; don't block these browsers).
 *
 * Smart re-detection:
 *   useBellRingPermission fires strictCheck on visibilitychange + focus so
 *   if the student disables push from OS Settings and returns to the tab,
 *   permission flips and the gate re-appears within milliseconds.
 */
export default function RequireBellRing({ children }) {
  const { permission, supported } = useBellRingPermission();
  const [open, setOpen] = useState(false);

  const isBlocked = supported && permission !== "granted";

  useEffect(() => {
    setOpen(isBlocked);
  }, [isBlocked]);

  // Unsupported browsers pass through — no gate.
  if (!supported) return <>{children}</>;

  // Granted — pass through immediately.
  if (!isBlocked) return <>{children}</>;

  // Blocked — render gate only, content is null until granted.
  return (
    <BellRingGate
      open={open}
      onClose={() => setOpen(false)}
      hardBlock={true}
    />
  );
}
