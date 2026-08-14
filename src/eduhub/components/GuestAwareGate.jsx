// GuestAwareGate.jsx — conditionally applies the existing ProtectedRoute +
// RequireBellRing pair, instead of always requiring them.
//
// Used only on /library and /library/read/:slug, the two routes now open to
// guests (see the "Read Before You Sign In" guest reading experience). For
// an authenticated student this renders EXACTLY today's nesting — zero
// behavior change. For a guest, both gates are skipped entirely: redirecting
// an unauthenticated visitor to /login defeats the purpose of a guest-
// browsable Library, and RequireBellRing (a push-notification-permission
// gate meant for "everything past Home," with no auth dependency of its
// own) would be a jarring, out-of-place interruption before someone has even
// created an account.
//
// This is NOT a duplicate of ProtectedRoute — its job (decide whether to
// apply an existing gate pair, or not) is a different responsibility, and
// it is the smallest addition that lets these two routes stay open without
// touching ProtectedRoute or RequireBellRing themselves.
//
// HOTFIX (Aug 2026) — bootstrap-window regression, root-caused via direct
// git-diff audit, not guessed:
// `isAuthenticated` is `false` for EVERY caller — guest and already-logged-
// -in student alike — until AuthContext's mount-time session-restore
// round-trip resolves (`isLoading`/`studentLoading`; see ProtectedRoute.jsx,
// which already holds on exactly this window for the same reason). The
// original version here read `isAuthenticated` immediately and picked its
// return shape from it, so on every fresh load of these two routes a real
// student's `children` (ReaderPage/LibraryPage) mounted UNWRAPPED first
// (indistinguishable from guest mode for that window), then got torn down
// and remounted inside <ProtectedRoute> the instant bootstrap resolved —
// a full, jarring remount discarding whatever state had built up (an
// in-flight book fetch, reading position, WelcomeOverlay, pagination).
// Fixed by holding on the same bootstrap window ProtectedRoute already
// holds on, so the eventual tree shape is decided exactly once, with the
// same loading skeleton ProtectedRoute already uses elsewhere in this app
// (a brief, expected loading state — not the kind of interruption this
// component exists to avoid, which was specifically about login walls and
// push-permission prompts, not ordinary loading UI).
import { useAuth } from "../context/AuthContext";
import { motion } from "framer-motion";
import ProtectedRoute from "./ProtectedRoute";
import RequireBellRing from "./bellring/RequireBellRing";

export default function GuestAwareGate({ children }) {
  const { isAuthenticated, isLoading, isBootstrapping } = useAuth();

  if (isLoading || isBootstrapping) {
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

  if (!isAuthenticated) return children;
  return (
    <ProtectedRoute>
      <RequireBellRing>{children}</RequireBellRing>
    </ProtectedRoute>
  );
}
