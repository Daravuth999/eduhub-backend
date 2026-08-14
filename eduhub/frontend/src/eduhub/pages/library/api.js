// Library API — dual-mode.
//   Sends legacy studentId/password for the un-upgraded backend, and
//   sessionToken (when present) for the secured backend.
import { secureGet, securePost, setSessionToken } from "../../lib/secureClient";

export const API_BASE_URL =
  "https://script.google.com/macros/s/AKfycbzgTmcWAwLw8ZlA6cmSgkxv-KvQwSHwTLgL3cwD4l3RI8iHIOYacJPbGke76Fo0ETR8kA/exec";

export async function loginRequest(studentId, password) {
  // v7.9.9 — DUAL-MODE (POST preferred, GET fallback).
  // The upgraded Library backend routes both verbs through the same
  // secureExecute pipeline, so POST keeps the password out of the URL
  // (audit item #8). The legacy pre-upgrade backend only understands
  // GET for `login`; during the upgrade window we retry via GET so
  // authentication never breaks while the operator is rolling out
  // `gas-backend/LibraryBackend.Code.gs`.
  const tryParse = async (res) => {
    try { return await res.json(); } catch { return null; }
  };

  // Attempt 1 — POST (password in body).
  try {
    const body = new URLSearchParams({ action: "login", studentId, password });
    const res = await fetch(API_BASE_URL, { method: "POST", body, redirect: "follow" });
    if (res.ok) {
      const json = await tryParse(res);
      if (json && json.success) {
        if (json.sessionToken) setSessionToken(json.sessionToken);
        return json;
      }
    }
  } catch { /* fall through */ }

  // Attempt 2 — GET (legacy contract).
  const url = `${API_BASE_URL}?action=login&studentId=${encodeURIComponent(
    studentId,
  )}&password=${encodeURIComponent(password)}`;
  const res = await fetch(url);
  const json = await res.json();
  if (json && json.success && json.sessionToken) setSessionToken(json.sessionToken);
  return json;
}

export function getContent() {
  return secureGet(API_BASE_URL, { action: "getContent" });
}

export function getStudentStats(studentId) {
  return secureGet(API_BASE_URL, { action: "getStudentStats", studentId });
}

export function completeLessonRequest(studentId, lessonTitle, lessonType) {
  return securePost(
    API_BASE_URL,
    { action: "completeLesson", studentId, lessonTitle, lessonType },
    { requireNonce: true },
  );
}
