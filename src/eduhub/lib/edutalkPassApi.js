/**
 * eduhub/lib/edutalkPassApi.js — student-side EduTalk Pass API helper.
 *
 * Source of truth = MongoDB through GET /api/student/edutalk-passes.
 * Passes are GRANTED by the Speaking Lab Mystery Box reward system
 * (or other admin sources). This module ONLY lists what a student owns.
 * Consumption happens transparently inside the EduTalk session/voice
 * routes, so there is no client-side consume endpoint.
 *
 * Reuses the same auth surface as voucherApi.js: cookie credentials +
 * mobile-Safari Bearer fallback from the `student_session_token`
 * localStorage key.
 */
/* eslint-disable no-undef */
const BASE = (process.env.REACT_APP_BACKEND_URL || "").replace(/\/$/, "");
/* eslint-enable no-undef */

const LS_KEY = "student_session_token";

function bearer() {
  try {
    const t = localStorage.getItem(LS_KEY);
    return t ? { Authorization: `Bearer ${t}` } : {};
  } catch {
    return {};
  }
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
  try {
    data = await res.json();
  } catch {
    /* ignore */
  }
  if (!res.ok) {
    const err = new Error((data && data.detail) || `HTTP ${res.status}`);
    err.status = res.status;
    err.data = data;
    throw err;
  }
  return data;
}

/** Fetch the logged-in student's active EduTalk passes. */
export function listStudentEduTalkPasses() {
  return fetchJson("/api/student/edutalk-passes");
}

/** Fetch the student's Mystery Box reward history (safe display only). */
export function listStudentMysteryBoxHistory() {
  return fetchJson("/api/student/mystery-box/history");
}

export default {
  listStudentEduTalkPasses,
  listStudentMysteryBoxHistory,
};
