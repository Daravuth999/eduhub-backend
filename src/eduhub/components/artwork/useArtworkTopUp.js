/**
 * useArtworkTopUp.js — render the EXISTING PointsPurchaseModal on demand.
 *
 * The "Open Top Up Modal" click action reuses the app's existing top-up
 * modal verbatim. No payment/wallet code is touched — we only toggle local
 * visibility and pass the authenticated studentId. If the student isn't
 * logged in, the click falls back to the login route.
 */
import { useCallback, useState } from "react";
import { useNavigate } from "react-router-dom";
import { useAuth } from "../../context/AuthContext";
import PointsPurchaseModal from "../../pages/portal/components/dashboard/PointsPurchaseModal";

export default function useArtworkTopUp() {
  const navigate = useNavigate();
  const auth = useAuth() || {};
  const student = auth.student;
  const refreshPoints = auth.refreshPoints;
  const [open, setOpen] = useState(false);

  const openTopUp = useCallback(() => {
    if (student?.studentId) {
      setOpen(true);
    } else {
      navigate("/login?redirect=/library");
    }
  }, [student?.studentId, navigate]);

  const topUpNode =
    open && student?.studentId ? (
      <PointsPurchaseModal
        studentId={student.studentId}
        onClose={() => setOpen(false)}
        onCredited={() => {
          try {
            refreshPoints?.();
          } catch {
            /* ignore */
          }
        }}
      />
    ) : null;

  return { openTopUp, topUpNode };
}
