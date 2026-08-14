/**
 * SmartTopUpTrigger.jsx — route + balance aware Top-Up modal mounter
 * ===================================================================
 * Mounted ONCE at the App.js root inside <AuthProvider>.
 *
 * Behaviour:
 *   • Watches `useLocation()` for /library, /game, /assistant, /portal.
 *   • Reads the student's PTS balance from useAuth().student.
 *   • Defers to `useTopUpAffordance` for all anti-spam logic
 *     (1× per session, 7-day snooze after 3 dismissals, 800 ms grace
 *      after route change, never overlap the existing post-login
 *      popup).
 *   • When the affordance says `shouldShow: true`, it mounts
 *     PointsPurchaseModal with the contextual `triggerReason`,
 *     `currentBalance`, and the recommended package.
 *   • Dismissing the modal stamps the dismiss log; reaching 3 within
 *     7 days auto-snoozes for 7 days.
 *   • Renders `null` whenever any guard fails — zero impact on the
 *     rendered tree of the rest of the app.
 *
 * Public contract:
 *   - This component has NO props.
 *   - Manual button paths (LibraryTopUpButton) keep working — they
 *     mount their own modal instance and never consult this trigger.
 */

import { lazy, Suspense, useCallback, useEffect, useMemo, useState } from "react";
import { useLocation } from "react-router-dom";
import { useAuth } from "../../context/AuthContext";
import {
  useTopUpAffordance,
  markTopUpAutoShown,
  recordTopUpDismiss,
  pickRecommendedPackage,
} from "./useTopUpAffordance";

const PointsPurchaseModal = lazy(() =>
  import("../../pages/portal/components/dashboard/PointsPurchaseModal")
);

const BACKEND = process.env.REACT_APP_BACKEND_URL || "";

function readBalance(student) {
  if (!student) return null;
  // Try the richest source first — the AuthContext exposes several aliases.
  const fromState =
    student.points ??
    student.portalPoints ??
    student?.portalData?.points ??
    student?.portalData?.Points ??
    null;
  if (typeof fromState === "number") return fromState;
  if (typeof fromState === "string" && fromState.trim() !== "") {
    const n = Number(fromState);
    return Number.isFinite(n) ? n : null;
  }
  return null;
}

export default function SmartTopUpTrigger() {
  const { student } = useAuth() || {};
  const location = useLocation();
  const [open, setOpen] = useState(false);
  const [packages, setPackages] = useState([]);

  const studentId = student?.studentId || student?.clean_id || student?.cleanId;
  const balance = readBalance(student);
  const enabled = !!studentId;

  const aff = useTopUpAffordance({
    pathname: location.pathname,
    balance,
    enabled,
  });

  // Lazy-load packages once a student is logged in. Cheap and cached
  // by the browser; reused if/when the modal opens.
  useEffect(() => {
    if (!enabled || packages.length > 0) return;
    let alive = true;
    fetch(`${BACKEND}/api/payments/packages/public`, { credentials: "omit" })
      .then((r) => (r.ok ? r.json() : { packages: [] }))
      .then((d) => { if (alive) setPackages((d?.packages || []).filter((p) => p.active)); })
      .catch(() => { /* silent — manual button path will refetch */ });
    return () => { alive = false; };
  }, [enabled, packages.length]);

  const recommended = useMemo(() => pickRecommendedPackage(packages), [packages]);

  // Fire when affordance allows.
  useEffect(() => {
    if (aff.shouldShow && !open) {
      setOpen(true);
      markTopUpAutoShown();
    }
  }, [aff.shouldShow, open]);

  const handleClose = useCallback(() => {
    setOpen(false);
    recordTopUpDismiss();
  }, []);

  const handleCredited = useCallback(() => {
    // The modal handles balance refresh itself via the existing
    // PointsCreditPushBridge / usePoints listener — we just close.
    setOpen(false);
  }, []);

  if (!enabled || !open || !studentId) return null;

  return (
    <Suspense fallback={null}>
      <PointsPurchaseModal
        studentId={studentId}
        onClose={handleClose}
        onCredited={handleCredited}
        triggerReason={aff.reason}
        contextHeadlineKm={aff.headlineKm}
        contextBodyKm={aff.bodyKm}
        currentBalance={balance}
        recommendedPackageId={recommended?._id}
      />
    </Suspense>
  );
}
