/**
 * bookInteractionProgressApi.js — Signature Smart Interactive Book,
 * Checkpoint 1: thin API client for the new interaction-progress routes.
 *
 * Deliberately self-contained (does NOT import from src/studio/) so this
 * file — part of the student Reader bundle — never pulls Author Studio code
 * into the student-facing chunk (§LOCKED CORRECTION 8: separate bundles).
 * Mirrors EduTalkPanel.jsx's proven student-auth convention exactly:
 * REACT_APP_BACKEND_URL + student_session_token Bearer + credentials:include.
 */
/* eslint-disable no-undef */
const API_BASE = (process.env.REACT_APP_BACKEND_URL || "").replace(/\/$/, "");
/* eslint-enable no-undef */
const STUDENT_LS_KEY = "student_session_token";

function _studentBearer() {
  try {
    const t = localStorage.getItem(STUDENT_LS_KEY);
    return t ? { Authorization: `Bearer ${t}` } : {};
  } catch {
    return {};
  }
}

async function _request(path, { method = "GET", body, signal } = {}) {
  const headers = { ..._studentBearer() };
  const init = { method, credentials: "include", headers, signal };
  if (body !== undefined) {
    headers["Content-Type"] = "application/json";
    init.body = JSON.stringify(body);
  }
  const res = await fetch(`${API_BASE}${path}`, init);
  let data = null;
  try { data = await res.json(); } catch { /* non-JSON */ }
  if (!res.ok) {
    const err = new Error((data && data.detail) || `HTTP ${res.status}`);
    err.status = res.status;
    err.data = data;
    throw err;
  }
  return data;
}

/**
 * syncProgress — batched, debounced by the caller (useBookInteractionProgress).
 * `items` is an array of {bookSlug, revision, chapterId, blockId, state,
 * attemptCount, hintLevel, selectedBranch, clientUpdatedAt}. Never throws
 * synchronously into a reading flow — callers are expected to catch and
 * silently retry later (a failed sync must never block reading).
 */
export function syncProgress(items, signal) {
  return _request("/api/student/interaction-progress/sync", { method: "POST", body: { items }, signal });
}

export function getProgress(bookSlug, revision, signal) {
  const q = revision != null ? `?revision=${encodeURIComponent(revision)}` : "";
  return _request(`/api/student/interaction-progress/${encodeURIComponent(bookSlug)}${q}`, { signal });
}
