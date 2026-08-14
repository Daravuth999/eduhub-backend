/**
 * achievementApi.js — Achievement Center student API client.
 *
 * Mirrors the existing student client convention (eduhub/pages/attendance/api.js):
 *   - base = REACT_APP_BACKEND_URL
 *   - credentials: "include" on every call
 *   - Bearer header ONLY when a non-empty session token exists
 */
const BASE = (process.env.REACT_APP_BACKEND_URL || "").replace(/\/$/, "");
const LS_TOKEN_KEY = "student_session_token";

function authHeaders() {
  try {
    const t = localStorage.getItem(LS_TOKEN_KEY);
    return t ? { Authorization: `Bearer ${t}` } : {};
  } catch {
    return {};
  }
}

async function _json(path, { method = "GET", body } = {}) {
  const res = await fetch(`${BASE}${path}`, {
    method,
    credentials: "include",
    headers: { "Content-Type": "application/json", ...authHeaders() },
    body: body != null ? JSON.stringify(body) : undefined,
  });
  let data = null;
  try { data = await res.json(); } catch { data = null; }
  if (!res.ok) {
    const err = new Error((data && data.detail) || `HTTP ${res.status}`);
    err.status = res.status;
    err.data = data;
    throw err;
  }
  return data;
}

export const getAchievements = () => _json("/api/achievements/me");
export const claimReward = (trophyId) =>
  _json("/api/achievements/claim", { method: "POST", body: { trophy_id: trophyId } });
