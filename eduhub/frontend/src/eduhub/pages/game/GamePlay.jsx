// GamePlay.jsx — P0 Surgery E + 3-bug-fix v2 (Spin login persistence)
//
// Behavior contract (UNCHANGED):
//   • Same authentication-bridge: copies AuthContext credentials into
//     the lucky-spin:session-v2 localStorage entry so LuckySpin's
//     auto-rehydrate can read a valid id+password.
//   • Same v7.9.10 fix-set (A): redirect to /login?redirect=/game/play
//     only when neither AuthContext nor the lucky-spin localStorage
//     can supply a working password.
//   • Same v7.9.10 fix-set (B): NEVER clear lucky-spin:session-v2 on
//     unmount — only the explicit Logout button scrubs the session.
//   • Same v7.9.10 fix-set (C): the bridge re-applies on every render
//     so AuthContext updates (points refresh, name change) flow through.
//   • Same data-game-theme="true" body attribute toggle for the
//     deep-violet game theme.
//   • Same ProtectedRoute / ErrorBoundary / LuckySpin chain.
//
// 3-bug-fix v2 — Spin login persistence
// ────────────────────────────────────────────────────────────────────────
// Symptom: after the v12.0 30-day persistent-login patch, Library /
// Portal / Reader stayed logged in across PWA cold-starts because
// AuthContext rehydrates `student` from the localStorage profile cache
// (which is stripped of the password for security). But this file's
// password gate (`if (!password) return <Navigate to="/login" />`)
// fired synchronously on first render — bouncing the student to the
// login screen even though every OTHER feature still recognized them.
//
// Why this is safe to soften:
//   • LuckySpin owns its own persistent session at the
//     `lucky-spin:session-v2` localStorage key (written by this bridge
//     on every successful login and by LuckySpin's own login form).
//     That entry DOES carry the password — it's the canonical Spin
//     credential source. If that entry has a valid {id, password}
//     pair that matches the AuthContext student, we have everything
//     LuckySpin needs to render and re-auth in the background.
//   • LuckySpin already silently re-validates on mount via
//     shopLogin + apiLogin (see LuckySpin.tsx auto-rehydrate effect).
//     A truly stale credential will surface there and clear the
//     lucky-spin session as normal — we don't bypass any auth check.
//   • Real logout (logoutStudent + logout) clears BOTH the profile
//     cache AND nothing prevents the user from also tapping the Spin
//     "Logout" button which calls clearSession() on the lucky-spin
//     entry. So a genuine logged-out state still produces a login
//     screen on next mount.
//   • No AuthContext change. No security weakening. Read-only
//     alignment to the same persistent source Library/Portal use,
//     plus a fallback to the long-standing lucky-spin localStorage.
import { useEffect } from "react";
import { Navigate } from "react-router-dom";
import { LuckySpin } from "./pages/LuckySpin";
import { ErrorBoundary } from "./components/ErrorBoundary";
import { useAuth } from "../../context/AuthContext";
import "./game-theme.css";

const SESSION_KEY = "lucky-spin:session-v2";

// Read the lucky-spin's own persistent session (id + password) as a
// fallback when AuthContext's `student.password` is unavailable on
// cold-start. Read-only — never writes.
function readSpinSessionCache() {
  try {
    if (typeof window === "undefined") return null;
    const raw = window.localStorage.getItem(SESSION_KEY);
    if (!raw) return null;
    const parsed = JSON.parse(raw);
    if (!parsed || typeof parsed !== "object") return null;
    if (!parsed.id || !parsed.password) return null;
    return { id: String(parsed.id), password: String(parsed.password) };
  } catch {
    return null;
  }
}

export default function GamePlay() {
  const { student } = useAuth();

  // Resolve the password from AuthContext first (the same source
  // Library/Portal/Reader use after the 30-day persistent-login patch).
  // After PWA cold-start the AuthContext profile cache is stripped of
  // password by design, so we fall back to the lucky-spin's own
  // localStorage entry which DOES carry the credential needed for the
  // Spin/Shop GAS round-trips.
  const ctxPassword = student?.password || "";
  const studentId = student?.studentId;

  // Fallback only consulted when the AuthContext password is missing.
  // We require the cached id to match the currently authenticated
  // student so a stale cache from a different account never leaks.
  const spinCache = !ctxPassword ? readSpinSessionCache() : null;
  const hasSpinFallback =
    !!spinCache &&
    !!studentId &&
    spinCache.id === studentId &&
    !!spinCache.password;

  const password = ctxPassword || (hasSpinFallback ? spinCache.password : "");

  // Surgery E — bridge AuthContext credentials into lucky-spin's
  // localStorage schema in an effect, NOT in the render body.
  // Guarded so we only ever write when we have BOTH id AND password.
  // After the 3-bug-fix v2: when AuthContext password is missing but
  // the lucky-spin cache already holds a matching pair, we deliberately
  // skip the write (we have nothing fresh to add) — the existing entry
  // is left untouched, which is exactly what keeps Spin logged-in.
  const gameName = student?.gameName || student?.name || student?.studentId;
  const gamePoints = student?.gamePoints ?? 0;

  useEffect(() => {
    if (!studentId || !ctxPassword) return;
    const payload = {
      id: studentId,
      password: ctxPassword,
      name: gameName,
      points: gamePoints,
      shopHistory: [],
    };
    try {
      window.localStorage.setItem(SESSION_KEY, JSON.stringify(payload));
    } catch {
      /* ignore quota / privacy mode */
    }
  }, [studentId, ctxPassword, gameName, gamePoints]);

  // Force the deep-violet game theme while open.
  useEffect(() => {
    document.body.setAttribute("data-game-theme", "true");
    return () => document.body.removeAttribute("data-game-theme");
  }, []);

  // ProtectedRoute already guarantees student is non-null here. But if
  // BOTH the AuthContext password AND the lucky-spin fallback are
  // missing, we deliberately short-circuit to the login screen — the
  // Spin/Shop GAS endpoints can't function without a password and the
  // unauthenticated placeholder mislead users into thinking the game
  // was broken.
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
