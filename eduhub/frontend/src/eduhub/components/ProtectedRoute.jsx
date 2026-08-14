// ProtectedRoute.jsx — gates the personal Portal/Game/embedded routes.
//
// Part 3 (Persistent Login / Safe Session Restore) — non-breaking fix
// ──────────────────────────────────────────────────────────────────────
// Symptom: on PWA cold-start / Add-to-Home-Screen reopen, the Render
// session cookie + Bearer survive on the server, but the client's
// sessionStorage `eduhub_student` cache is empty.  Until the mount-time
// `renderStudentMe()` call resolves (`studentLoading: true`),
// `isAuthenticated` is `false` because the legacy `student` is null AND
// the Render student hasn't been confirmed yet.  Before this fix,
// ProtectedRoute only respected `isLoading` (the *login form* spinner),
// so it redirected straight to /login during the bootstrap window.
//
// Fix: also wait for `studentLoading` — the new boolean already exposed
// by AuthContext.  Existing sessions are never forced out; if the
// confirmed session is missing after `studentLoading` settles, the
// redirect-to-login flow is unchanged.  The `redirect` query param is
// preserved so the intended route is restored after a fresh login.
//
// Hard rules respected:
//   • No backend rewrite, no cookie/TTL change, no token storage change.
//   • No new dependencies.
//   • Login UI / API path untouched.
//   • Falls back gracefully when `studentLoading` is undefined (older
//     AuthContext versions still work).
import { Navigate, useLocation } from "react-router-dom";
import { motion } from "framer-motion";
import { useAuth } from "../context/AuthContext";

export default function ProtectedRoute({ children }) {
  const { isAuthenticated, isLoading, studentLoading } = useAuth();
  const location = useLocation();

  // Bootstrap window: the Render `/api/auth/student/me` call is still in
  // flight.  We must NOT redirect to /login during this window — the
  // student may already have a valid server-side session that simply
  // hasn't been confirmed locally yet.  Falls back to false when
  // studentLoading is undefined so older AuthContext versions still
  // behave exactly as before.
  const bootstrapping = isLoading || studentLoading === true;

  if (bootstrapping) {
    return (
      <div
        className="flex min-h-[60vh] items-center justify-center"
        data-testid="auth-loading-skeleton"
      >
        <motion.div
          aria-hidden
          className="h-24 w-24 rounded-2xl skeleton border border-aurora-violet/30"
          animate={{ opacity: [0.4, 0.85, 0.4] }}
          transition={{ duration: 1.2, repeat: Infinity, ease: "easeInOut" }}
        />
      </div>
    );
  }

  if (!isAuthenticated) {
    const redirect = encodeURIComponent(location.pathname + location.search);
    return <Navigate to={`/login?redirect=${redirect}`} replace />;
  }

  return children;
}
