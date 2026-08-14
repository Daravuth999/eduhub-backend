/**
 * referralApi.js — Referral System v1 frontend client.
 *
 * Hits the new /api/referral/* and /api/admin/referral/* routes added by
 * backend/referral_tools.py. Cookie-credentialled like the rest of the
 * EduHub student API so the existing student/admin sessions are reused.
 *
 * Fails gracefully when the backend does not yet expose these routes
 * (404 / 401 / network error) so the dashboard never breaks if the
 * frontend deploys before the backend.
 *
 * v1.0.1 hotfix (eduhub_referral_auth_mobile_compat_hotfix_v1)
 * -----------------------------------------------------------
 * STUDENT_TOKEN_KEY was previously "eduhub_student_session_token_v1",
 * a key that is NEVER written anywhere in the EduHub codebase. The
 * canonical key used by studentAuthService.js (line 26) and by every
 * other authenticated student client (loginRewardApi.js, portal/lib/api.ts,
 * PremiumAiAction.jsx, EduTalkPanel.jsx, PointsPurchaseModal.jsx, etc.)
 * is "student_session_token". Because of this single-letter typo, the
 * Mobile-Safari Bearer fallback that the backend's `current_student`
 * dependency expects was never being sent on iPhone — so any device
 * where the cross-site `student_session` cookie is dropped by Safari
 * ITP (i.e. nearly all iOS Safari and embedded WebViews) received
 * HTTP 401 from /api/referral/stats and /api/referral/my-code, while
 * /api/auth/student/me succeeded because it reads the correct key.
 *
 * Aligning STUDENT_TOKEN_KEY with the canonical "student_session_token"
 * restores Bearer-based auth parity with the dashboard. No backend
 * change is required because backend already uses the same
 * `require_student` dependency for /api/referral/stats as it does
 * for /api/auth/student/me.
 */

/* eslint-disable no-undef */
const BASE = (process.env.REACT_APP_BACKEND_URL || "").replace(/\/$/, "");
/* eslint-enable no-undef */

const STUDIO_TOKEN_KEY = "studio_session_token_v1";
// Canonical student session token key — must stay in sync with
// src/eduhub/auth/studentAuthService.js (LS_KEY) and every other
// student API client. See hotfix note above.
const STUDENT_TOKEN_KEY = "student_session_token";

function tokenFromStorage(key) {
  try {
    return (typeof localStorage !== "undefined" && localStorage.getItem(key)) || "";
  } catch {
    return "";
  }
}

function withBearer(init) {
  // Prefer student session for /referral/* and admin/studio session for
  // /admin/referral/*. We try BOTH headers harmlessly so whichever the
  // backend accepts will succeed without leaking the wrong session.
  const headers = { ...(init.headers || {}) };
  if (!headers.Authorization) {
    const studentTok = tokenFromStorage(STUDENT_TOKEN_KEY);
    const studioTok = tokenFromStorage(STUDIO_TOKEN_KEY);
    const tok = studentTok || studioTok;
    if (tok) headers.Authorization = `Bearer ${tok}`;
  }
  return { ...init, headers };
}

async function request(path, opts = {}) {
  if (!BASE) {
    const err = new Error("REACT_APP_BACKEND_URL is not configured");
    err.code = "no_backend_url";
    throw err;
  }
  const init = withBearer({
    method: opts.method || "GET",
    credentials: "include",
    headers: { Accept: "application/json", ...(opts.headers || {}) },
  });
  if (opts.body !== undefined) {
    init.headers["Content-Type"] = "application/json";
    init.body = JSON.stringify(opts.body);
  }
  const res = await fetch(`${BASE}${path}`, init);
  let data = null;
  try { data = await res.json(); } catch { /* empty body */ }
  if (!res.ok) {
    const err = new Error((data && (data.detail || data.message)) || `HTTP ${res.status}`);
    err.status = res.status;
    err.data = data;
    throw err;
  }
  return data;
}

/* ── Student ─────────────────────────────────────────────────────────── */
export const getMyReferralCode = () => request("/api/referral/my-code");
export const getReferralStats  = () => request("/api/referral/stats");

/* ── Public lead capture (open endpoint, ?ref= modal) ────────────────── */
export const submitReferralLead = ({ referral_code, name, contact, interest }) =>
  request("/api/referral/leads", {
    method: "POST",
    body: { referral_code, name, contact, interest },
  });

/* ── Admin (Author Studio) ───────────────────────────────────────────── */
export const adminGetReferralConfig    = () => request("/api/admin/referral/config");
export const adminSetReferralConfig    = (cfg) =>
  request("/api/admin/referral/config", { method: "POST", body: cfg });
export const adminListReferralLeads    = ({ status, limit } = {}) => {
  const qs = new URLSearchParams();
  if (status) qs.set("status", status);
  if (limit)  qs.set("limit", String(limit));
  const tail = qs.toString();
  return request(`/api/admin/referral/leads${tail ? `?${tail}` : ""}`);
};
export const adminUpdateReferralLead   = (leadId, patch) =>
  request(`/api/admin/referral/leads/${encodeURIComponent(leadId)}`, {
    method: "PUT",
    body: patch,
  });
export const adminMarkClassPaid        = (leadId, payload) =>
  request(`/api/admin/referral/leads/${encodeURIComponent(leadId)}/mark-class-paid`, {
    method: "POST",
    body: payload,
  });
export const adminListReferralRewards  = ({ status, limit } = {}) => {
  const qs = new URLSearchParams();
  if (status) qs.set("status", status);
  if (limit)  qs.set("limit", String(limit));
  const tail = qs.toString();
  return request(`/api/admin/referral/rewards${tail ? `?${tail}` : ""}`);
};

/* Safe read helper — returns null on any error so UIs can hide silently. */
export async function safeRead(fn, fallback = null) {
  try { return await fn(); } catch { return fallback; }
}
