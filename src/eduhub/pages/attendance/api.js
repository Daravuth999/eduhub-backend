/**
 * api.js — Smart Attendance student API client.
 *
 * Mirrors the existing student client convention
 * (eduhub/pages/game/voice-treasure/api.js):
 *   - base = REACT_APP_BACKEND_URL
 *   - credentials: "include" on every call
 *   - Bearer header ONLY when a non-empty session token exists
 *   - identity is the EduHub session (cookie / Bearer) — never Telegram/Google
 *
 * meet_url is only ever received from the checkin POST response (and only to
 * perform the redirect); it is never requested from any other endpoint.
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

export const getMe = () => _json("/api/attendance/me");
export const getLive = () => _json("/api/attendance/live");
export const getSessionBySlug = (slug) =>
  _json(`/api/attendance/session/by-slug/${encodeURIComponent(slug)}`);

/** Commit a check-in. ``asStudentId`` re-attributes via the "not you?" flow. */
export const checkin = ({ slug, asStudentId } = {}) =>
  _json("/api/attendance/checkin", {
    method: "POST",
    body: { slug, as_student_id: asStudentId || null },
  });

export const midSessionConfirm = (sessionId) =>
  _json("/api/attendance/mid-session-confirm", {
    method: "POST",
    body: { session_id: sessionId },
  });

export const missReason = (sessionId, reason) =>
  _json("/api/attendance/miss-reason", {
    method: "POST",
    body: { session_id: sessionId, reason },
  });

export const getRewardSummary = () => _json("/api/attendance/rewards/summary");

export const claimReward = () =>
  _json("/api/attendance/rewards/claim", { method: "POST" });

/**
 * checkinWithRetry — resilient check-in. A flaky connection must NEVER cause a
 * false absence or block the student from reaching class, so we retry the
 * commit a few times with backoff before surfacing failure. The backend
 * additionally degrades safely (it returns the meet_url even when its own
 * write fails), so a single successful round-trip is enough to reach Meet.
 *
 * ``checkinFn`` is injectable for testing. ``sleep`` likewise.
 */
export async function checkinWithRetry(
  args,
  { retries = 3, delays = [400, 900, 1800], checkinFn = checkin, sleep } = {},
) {
  const _sleep = sleep || ((ms) => new Promise((r) => setTimeout(r, ms)));
  let lastErr = null;
  for (let attempt = 0; attempt <= retries; attempt += 1) {
    try {
      return await checkinFn(args);
    } catch (e) {
      lastErr = e;
      if (attempt < retries) {
        await _sleep(delays[Math.min(attempt, delays.length - 1)]);
      }
    }
  }
  throw lastErr;
}

export default {
  getMe, getLive, getSessionBySlug, checkin, midSessionConfirm, missReason,
  checkinWithRetry, getRewardSummary, claimReward,
};
