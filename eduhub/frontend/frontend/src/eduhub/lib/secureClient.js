/**
 * secureClient.js — shared HTTP helpers for EduHub's GAS backends.
 *
 *   DUAL-MODE by design:
 *     • If a sessionToken is in sessionStorage (secured backend has been
 *       deployed), every request piggy-backs it — the server uses it as the
 *       authoritative identity, ignoring any password/studentId the client
 *       still sends.
 *     • If no sessionToken is present yet (legacy backend still in place),
 *       requests still carry the classic `studentId` / `id` / `password`
 *       parameters, so NOTHING BREAKS during the upgrade window.
 *
 *   → A single frontend build works against both backend versions. The
 *     moment you flip the GAS deployment, the security model engages
 *     automatically.
 */
const TOKEN_KEY = "eduhub_session_token";

/* ---------- token helpers ---------- */
export function getSessionToken() {
  try { return sessionStorage.getItem(TOKEN_KEY) || ""; } catch { return ""; }
}
export function setSessionToken(tok) {
  try {
    if (tok) sessionStorage.setItem(TOKEN_KEY, tok);
    else sessionStorage.removeItem(TOKEN_KEY);
  } catch { /* private mode */ }
}
export function clearSessionToken() { setSessionToken(""); }

/* ---------- nonce ---------- */
export function makeNonce() {
  const a = new Uint8Array(12);
  if (typeof crypto !== "undefined" && crypto.getRandomValues) crypto.getRandomValues(a);
  else for (let i = 0; i < a.length; i++) a[i] = Math.floor(Math.random() * 256);
  return Array.from(a).map((b) => b.toString(16).padStart(2, "0")).join("");
}

/* ---------- GET (params via querystring) ---------- */
export async function secureGet(base, params = {}) {
  const tok = getSessionToken();
  const u = new URL(base);
  Object.entries(params).forEach(([k, v]) => {
    if (v !== undefined && v !== null && v !== "") u.searchParams.append(k, String(v));
  });
  if (tok && !u.searchParams.has("sessionToken")) u.searchParams.append("sessionToken", tok);
  u.searchParams.append("t", String(Date.now()));   // cache buster (matches v6)
  const r = await fetch(u.toString(), { method: "GET", redirect: "follow" });
  if (!r.ok) throw new Error("HTTP " + r.status);
  return r.json();
}

/* ---------- POST (form-urlencoded — GAS-friendly, no preflight) ---------- */
export async function securePost(base, params = {}, opts = {}) {
  const tok = getSessionToken();
  const body = new URLSearchParams();
  Object.entries(params).forEach(([k, v]) => {
    if (v !== undefined && v !== null) body.append(k, String(v));
  });
  if (tok) body.append("sessionToken", tok);
  if (opts.requireNonce) body.append("nonce", makeNonce());
  const r = await fetch(base, { method: "POST", body, redirect: "follow" });
  if (!r.ok) throw new Error("HTTP " + r.status);
  return r.json();
}

/* ---------- expired-session detection (for the 401-equivalent) ---------- */
export function isAuthExpired(json) {
  return !!json && json.success === false &&
         (json.error === "AUTH_REQUIRED" || json.error === "BAD_TOKEN");
}
