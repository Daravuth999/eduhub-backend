/**
 * loginRewardApi.js — student-side helpers for the Login Reward Campaign
 * popup. Uses the existing student session: cookie credentials and the
 * mobile-Safari Bearer fallback from `student_session_token` localStorage,
 * matching `studentAuthService.js`.
 *
 * All endpoints are backend-authoritative; the frontend only ever sends
 * the campaign_id when claiming.
 */
/* eslint-disable no-undef */
const BASE = (process.env.REACT_APP_BACKEND_URL || "").replace(/\/$/, "");
/* eslint-enable no-undef */

const LS_KEY = "student_session_token";

function bearer() {
  try {
    const t = localStorage.getItem(LS_KEY);
    return t ? { Authorization: `Bearer ${t}` } : {};
  } catch { return {}; }
}

async function fetchJson(path, init = {}) {
  const res = await fetch(`${BASE}${path}`, {
    credentials: "include",
    ...init,
    headers: {
      "Content-Type": "application/json",
      ...bearer(),
      ...(init.headers || {}),
    },
  });
  let data = null;
  try { data = await res.json(); } catch { /* ignore */ }
  if (!res.ok) {
    const err = new Error((data && data.detail) || `HTTP ${res.status}`);
    err.status = res.status;
    err.data = data;
    throw err;
  }
  return data;
}

export function getActiveLoginReward() {
  return fetchJson("/api/rewards/login-campaigns/active");
}

export function claimLoginReward(campaignId) {
  return fetchJson(`/api/rewards/login-campaigns/${encodeURIComponent(campaignId)}/claim`, {
    method: "POST",
  });
}

/* ── dismiss memory (UI only — claim truth is backend) ─────────────────── */
export function dismissKey(campaignId) {
  return `login_reward_dismissed_${campaignId}`;
}

export function readDismiss(campaignId) {
  try {
    const raw = localStorage.getItem(dismissKey(campaignId));
    if (!raw) return null;
    const obj = JSON.parse(raw);
    if (!obj || typeof obj !== "object") return null;
    return obj;
  } catch { return null; }
}

export function writeDismiss(campaignId, mode) {
  try {
    const obj = { at: Date.now(), mode: mode || "next_login" };
    localStorage.setItem(dismissKey(campaignId), JSON.stringify(obj));
  } catch { /* ignore */ }
}

export function clearDismiss(campaignId) {
  try { localStorage.removeItem(dismissKey(campaignId)); } catch { /* ignore */ }
}
