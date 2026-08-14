import { useEffect, useState } from "react";
import useBellRingPermission from "@/eduhub/hooks/useBellRingPermission";
// NOTE: BellRingGate.jsx lives inside a nested bellring/bellring/ folder
// in the current repo, so we import it via "./bellring/BellRingGate"
// from this file (which sits at src/eduhub/components/bellring/).
import BellRingGate from "./bellring/BellRingGate";

/**
 * RequireBellRing — route guard used on "progression" routes
 * (everything past the Home dashboard).
 *
 * Behavior per spec:
 *   • permission === 'granted'       → render children
 *   • permission === 'default'       → render children BUT show BellRingGate
 *     on top; if the student denies/ignores, the gate navigates them to "/"
 *     (Home), which keeps the Nag Card visible. Never a dead-end.
 *   • permission === 'denied'        → same overlay; "Allow" button will
 *     transition to the inline blocked-state hint then navigate home.
 *   • permission === 'unsupported'   → render children (don't punish
 *     students on older browsers that can't receive pushes).
 *
 * We render children BEHIND the gate (not null) so the navigation
 * transition back to Home feels instant — no blank frame.
 */
export default function RequireBellRing({ children }) {
  const { permission, supported } = useBellRingPermission();
  const [open, setOpen] = useState(false);

  useEffect(() => {
    if (!supported) {
      setOpen(false);
      return;
    }
    setOpen(permission !== "granted");
  }, [permission, supported]);

  return (
    <>
      {children}
      <BellRingGate
        open={open}
        onClose={() => setOpen(false)}
        redirectOnDeny="/"
      />
    </>
  );
}
