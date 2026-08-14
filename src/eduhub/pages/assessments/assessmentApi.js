/**
 * assessmentApi.js — student-facing API client for the AI Assessment /
 * Quiz Submission Lab.
 *
 * Independent from src/studio/api.js (the admin client) — same one-
 * client-per-surface convention as videoLibraryApi.js: student session
 * cookie + student Bearer fallback (mobile Safari ITP), never the Studio
 * admin bearer token. Talks only to assessment_tools.py's /api/student/
 * assessments/* routes.
 */
/* eslint-disable no-undef */
const BASE = process.env.REACT_APP_BACKEND_URL;
/* eslint-enable no-undef */

const LS_TOKEN_KEY = "student_session_token";

function authHeaders() {
  try {
    const t = localStorage.getItem(LS_TOKEN_KEY);
    return t ? { Authorization: `Bearer ${t}` } : {};
  } catch {
    return {};
  }
}

function url(path) {
  if (!BASE) return path;
  return `${BASE.replace(/\/$/, "")}${path}`;
}

async function request(path, { method = "GET", body, signal } = {}) {
  const headers = { ...authHeaders() };
  const init = { method, credentials: "include", headers, signal };
  if (body instanceof FormData) {
    init.body = body;
  } else if (body !== undefined) {
    headers["Content-Type"] = "application/json";
    init.body = JSON.stringify(body);
  }
  const res = await fetch(url(path), init);
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

const ROOT = "/api/student/assessments";

export async function listAssessments(signal) {
  const data = await request(ROOT, { signal });
  return (data && data.assessments) || [];
}

export async function listMySubmissions(signal) {
  const data = await request(`${ROOT}/submissions`, { signal });
  return (data && data.submissions) || [];
}

/** Uploads a photo/PDF of a completed worksheet. `file` is a browser File. */
export async function submitAssessment(assessmentId, file, signal) {
  const form = new FormData();
  form.append("assessment_id", assessmentId);
  form.append("file", file);
  return request(`${ROOT}/submit`, { method: "POST", body: form, signal });
}
