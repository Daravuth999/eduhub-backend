// GamePlay.jsx — protected /game/play; mounts the migrated LuckySpin
// pre-authenticated using credentials from AuthContext.
//
// v7.9.10 — two-part fix for the "Lucky Spin blank after login/refresh" bug:
//
//   (A) v7.9.8 stripped `password` from sessionStorage. On any page
//       refresh of /game/play, AuthContext's student is rehydrated from
//       sessionStorage and arrives WITHOUT a password. LuckySpin's
//       auto-rehydrate (pages/LuckySpin.tsx:240) bails out when the
//       cached session lacks a password, so the game rendered the
//       unauthenticated "Sign in to play · Enter Game" placeholder even
//       though AuthContext considered the user signed in.
//
//       Fix: when the bridge has no password to hand off, we redirect
//       to /login?redirect=/game/play so the user re-authenticates and
//       the fresh password flows into in-memory state. The session
//       stripping itself is preserved (security intent of v7.9.8).
//
//   (B) The previous implementation wiped `lucky-spin:session-v2` in a
//       useEffect cleanup. Combined with React 18 StrictMode's
//       mount → unmount → mount probe in dev, the cleanup ran AFTER
//       the initial bridge had written the session but BEFORE LuckySpin
//       could read it — leaving the game with an empty session and
//       `bridgedRef.current` already flipped to true, so no rewrite.
//       The cleanup also hurt SPA ergonomics in production: every
//       nav-away silently wiped the in-progress session.
//
//       Fix: we no longer clear localStorage on unmount. LuckySpin's
//       explicit Logout button already scrubs the session, which is
//       the right hook for "user intentionally left the game".
//
//   (C) The `bridgedRef` one-shot guard is removed. The bridge is now
//       re-applied on every render, so an AuthContext update
//       (e.g. points refresh, name change) always flows through to the
//       cached payload LuckySpin reads.
//
// Everything else about LuckySpin — the spin/redeem flow, session
// format, network contract — is untouched. This change is additive and
// confined to this single file.
import { useEffect } from "react";
import { Navigate } from "react-router-dom";
import { LuckySpin } from "./pages/LuckySpin";
import { ErrorBoundary } from "./components/ErrorBoundary";
import { useAuth } from "../../context/AuthContext";
import "./game-theme.css";

const SESSION_KEY = "lucky-spin:session-v2";

export default function GamePlay() {
  const { student } = useAuth();

  // Resolve the password once per render. After v7.9.8 the session
  // stored in sessionStorage no longer carries it, so the only reliable
  // source is the in-memory AuthContext state produced by a successful
  // login in this tab lifecycle. If the user refreshed the page we fall
  // through to the redirect below — clean re-auth instead of a silent
  // guest-view fallback.
  const password = student?.password || "";

  // Bridge AuthContext credentials into lucky-spin's localStorage schema
  // synchronously during render so LuckySpin's auto-rehydrate effect
  // (which fires before our parent effects) sees a fresh payload.
  // Guarded so we only ever write when we have BOTH id AND password —
  // writing an entry with an undefined password would actively hurt us
  // (LuckySpin bails on such entries, and the bad write would sit there
  // until an explicit logout).
  if (student?.studentId && password) {
    const payload = {
      id: student.studentId,
      password,
      name: student.gameName || student.name || student.studentId,
      points: student.gamePoints ?? 0,
      shopHistory: [],
    };
    try {
      window.localStorage.setItem(SESSION_KEY, JSON.stringify(payload));
    } catch {
      /* ignore quota / privacy mode */
    }
  }

  // Force the deep-violet game theme while open.
  useEffect(() => {
    document.body.setAttribute("data-game-theme", "true");
    return () => document.body.removeAttribute("data-game-theme");
  }, []);

  // ProtectedRoute already guarantees student is non-null here. But if
  // the stored session lost its password (post-refresh, post-v7.9.8),
  // we deliberately short-circuit to the login screen instead of
  // letting LuckySpin fall back to its unauthenticated placeholder —
  // that misled users into thinking the game was broken.
  if (!student?.studentId) return null;
  if (!password) {
    return <Navigate to="/login?redirect=/game/play" replace />;
  }

  return (
    <ErrorBoundary>
      <LuckySpin />
    </ErrorBoundary>
  );
}
