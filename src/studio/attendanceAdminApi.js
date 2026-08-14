/**
 * attendanceAdminApi.js — admin-side Attendance Studio API client.
 * Mirrors studio/api.js auth pattern (Bearer token + cookie).
 */
const BASE = process.env.REACT_APP_BACKEND_URL; // eslint-disable-line no-undef
const TOKEN_KEY = "studio_session_token_v1";

function getToken() {
  try { return localStorage.getItem(TOKEN_KEY) || ""; } catch { return ""; }
}

function url(path) {
  if (!BASE) return path;
  return `${BASE.replace(/\/$/, "")}${path}`;
}

async function request(path, { method = "GET", body } = {}) {
  const headers = {};
  const tok = getToken();
  if (tok) headers.Authorization = `Bearer ${tok}`;
  const init = { method, credentials: "include", headers };
  if (body !== undefined) {
    headers["Content-Type"] = "application/json";
    init.body = JSON.stringify(body);
  }
  const res = await fetch(url(path), init);
  let data = null;
  try { data = await res.json(); } catch { /* ignore */ }
  if (!res.ok) {
    // FastAPI validation errors return detail as an array of objects, not a string.
    const detail = data?.detail;
    const message = typeof detail === "string"
      ? detail
      : Array.isArray(detail)
        ? detail.map((d) => d.msg || JSON.stringify(d)).join("; ")
        : detail
          ? JSON.stringify(detail)
          : `HTTP ${res.status}`;
    const err = new Error(message);
    err.status = res.status;
    err.data = data;
    throw err;
  }
  return data;
}

// ── Settings ─────────────────────────────────────────────────────────────────
export const getSettings = () =>
  request("/api/admin/attendance/settings");

export const saveSettings = (settings) =>
  request("/api/admin/attendance/settings", { method: "PUT", body: { settings } });

// ── Classes ───────────────────────────────────────────────────────────────────
export const listClasses = () =>
  request("/api/admin/attendance/classes");

export const createClass = (data) =>
  request("/api/admin/attendance/classes", { method: "POST", body: data });

export const updateClass = (class_id, data) =>
  request(`/api/admin/attendance/classes/${class_id}`, { method: "PUT", body: data });

export const deleteClass = (class_id) =>
  request(`/api/admin/attendance/classes/${class_id}`, { method: "DELETE" });

// ── Sessions ──────────────────────────────────────────────────────────────────
export const listSessions = (class_id) =>
  request(`/api/admin/attendance/sessions${class_id ? `?class_id=${encodeURIComponent(class_id)}` : ""}`);

export const createSession = (data) =>
  request("/api/admin/attendance/sessions", { method: "POST", body: data });

export const updateSession = (session_id, data) =>
  request(`/api/admin/attendance/sessions/${session_id}`, { method: "PUT", body: data });

export const deleteSession = (session_id) =>
  request(`/api/admin/attendance/sessions/${session_id}`, { method: "DELETE" });

export const openSession = (session_id) =>
  request(`/api/admin/attendance/sessions/${session_id}/open`, { method: "POST" });

export const closeSession = (session_id) =>
  request(`/api/admin/attendance/sessions/${session_id}/close`, { method: "POST" });

export const closingSoonNudge = (session_id) =>
  request(`/api/admin/attendance/sessions/${session_id}/closing-soon-nudge`, { method: "POST" });

// ── At-risk ───────────────────────────────────────────────────────────────────
export const getAtRisk = () =>
  request("/api/admin/attendance/at-risk");

export const fireAtRiskNudge = () =>
  request("/api/admin/attendance/at-risk-nudge", { method: "POST" });

// ── Students (for roster picker) ─────────────────────────────────────────────
// Re-uses the existing /api/teacher/students route — same admin Bearer token.
export const listAllStudents = () =>
  request("/api/teacher/students");

// ── Reports ───────────────────────────────────────────────────────────────────
export const getReport = (month, class_id) => {
  const params = new URLSearchParams();
  if (month) params.set("month", month);
  if (class_id) params.set("class_id", class_id);
  const qs = params.toString();
  return request(`/api/admin/attendance/report${qs ? `?${qs}` : ""}`);
};
