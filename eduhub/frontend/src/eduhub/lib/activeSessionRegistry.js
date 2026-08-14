// activeSessionRegistry.js — tiny, framework-free "is a premium session
// live right now" signal, shared between EduTalk Live Voice Coach and any
// watcher that might otherwise force-logout a student mid-conversation
// (StatusEnforcer's hard-logout backstop, RestrictionGuard's auto-signout
// countdown).
//
// Design note: this mirrors the `criticalOperationRegistry.ts` pattern
// already used once in this codebase's history (the reverted PWA
// auto-update system registered points-send/top-up/Speaking-Lab-join
// against it so an auto-reload would never land mid-transaction). This is
// the same idea, scoped specifically to an active Live Coach session, and
// deliberately does NOT touch AuthContext.jsx, StatusEnforcer.jsx's
// restriction-detection logic, or RestrictionGuard.jsx's restriction
// detection — only the moment those paths decide to forcibly sign the
// student out.
//
// Not a security boundary: this only ever DEFERS an automatic logout by a
// few seconds while a session is active. A student who taps "Sign out
// now" (or a genuinely repeated/parallel poll on a still-bad status)
// always wins eventually — this never permanently blocks enforcement.

const activeSessionIds = new Set();

/** Mark a premium session (e.g. a live Voice Coach conversation) as
 * in-progress. Call once when it truly starts (WebSocket connected, live
 * phase entered) — not on every render. Idempotent. */
export function registerActiveSession(sessionKey) {
  if (!sessionKey) return;
  activeSessionIds.add(sessionKey);
}

/** Clear a session's active flag. Safe to call even if it was never
 * registered, or was already cleared (e.g. from more than one cleanup
 * path) — idempotent, never throws. */
export function unregisterActiveSession(sessionKey) {
  if (!sessionKey) return;
  activeSessionIds.delete(sessionKey);
}

/** True while at least one premium session is in-progress. */
export function hasActiveSession() {
  return activeSessionIds.size > 0;
}
