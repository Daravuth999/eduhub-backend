/**
 * studentAuthService.js — Student auth via Render backend.
 *
 * v10.0 — replaces the legacy GAS Web App URL for student login.
 *
 * Mobile Safari ITP fallback: in addition to the httpOnly cookie that
 * the backend sets, the JSON response carries `session_token`. We mirror
 * it into localStorage and send it back on every subsequent request as
 * an `Authorization: Bearer` header so the API remains usable in
 * Safari's third-party-cookie sandbox (where the cookie is dropped on
 * cross-site PWA fetches).
 *
 * The bearer fallback is purely additive — when the cookie is present
 * it takes precedence and the bearer is ignored by the backend.
 *
 * v10.0.1 (hotfix) — Teacher endpoints now also send the admin Bearer
 *   token cached by studio/api.js (`studio_session_token_v1`). Without
 *   this, the Students tab returned 401 on iOS Safari/Chrome (WebKit
 *   ITP drops cross-site cookies between *.vercel.app and *.onrender.com),
 *   producing "Failed to fetch students" on every iPhone. Desktop Chrome
 *   was unaffected because it still ships the cross-site cookie.
 *   Symmetric to the student-side `_bearerHeaders()` above — purely
 *   additive, no backend change.
 */
const BASE = (process.env.REACT_APP_BACKEND_URL || "").replace(/\/$/, "");
const LS_KEY = "student_session_token";
// v12.0 — /me response cache keys (stale-while-revalidate, 30-day TTL)
const ME_CACHE_KEY    = "eduhub_render_me_v1";
const ME_CACHE_TTL_MS = 30 * 24 * 60 * 60 * 1000; // 30 days

// Admin session token key — must stay in sync with studio/api.js TOKEN_KEY.
// Duplicated here (instead of imported) to avoid a circular module dep
// between studio/api.js and eduhub/auth/* during the React build.
const ADMIN_LS_KEY = "studio_session_token_v1";

function _bearerHeaders() {
  const t = localStorage.getItem(LS_KEY);
  return t ? { Authorization: `Bearer ${t}` } : {};
}

/**
 * Admin Bearer fallback used by all /api/teacher/* calls below.
 * Reads the studio session token that StudioCallback writes to
 * localStorage at login. On iOS Safari/Chrome the cross-site cookie
 * is silently dropped by ITP, so this header is the only thing that
 * authenticates the request.
 */
function _adminHeaders(extra = {}) {
  const t = localStorage.getItem(ADMIN_LS_KEY);
  return { ...extra, ...(t ? { Authorization: `Bearer ${t}` } : {}) };
}

/* ────────────────────────────  student auth  ───────────────────────────── */

export async function studentLogin({ cleanId, password, turnstileToken = "" }) {
  const res = await fetch(`${BASE}/api/auth/student/login`, {
    method: "POST",
    credentials: "include",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({
      clean_id: cleanId,
      password,
      turnstile_token: turnstileToken,
    }),
  });
  if (!res.ok) {
    const err = await res.json().catch(() => ({}));
    throw new Error(err.detail || "Login failed");
  }
  const data = await res.json();
  if (data.session_token) localStorage.setItem(LS_KEY, data.session_token);
  return data;
}

export async function studentMe() {
  // v12.1 — network-first with cache fallback.
  //
  // Return contract (AuthContext depends on this):
  //   success         → write ME_CACHE_KEY, return data     (setRenderStudent)
  //   401 / 403       → clear ME_CACHE_KEY, return null     (confirmed unauthorized → clearSession)
  //   network / 5xx   → return cached identity if valid TTL  (keep logged in during cold start)
  //   network / 5xx   → throw Error if no valid cache        (AuthContext .catch keeps existing state)
  //
  // The distinction between null (confirmed 401) and throw (network failure)
  // lets AuthContext.then() handle real logouts while .catch() handles
  // transient failures — never force-logging-out a student due to a blip.
  let networkOrServerError = false;
  try {
    const res = await fetch(`${BASE}/api/auth/student/me`, {
      credentials: "include",
      headers: { ..._bearerHeaders() },
    });
    if (res.ok) {
      const data = await res.json();
      if (data && data.clean_id) {
        try {
          localStorage.setItem(
            ME_CACHE_KEY,
            JSON.stringify({ ...data, _ts: Date.now() }),
          );
        } catch { /* quota / private mode */ }
      }
      return data;
    }
    // Confirmed unauthorized — session is definitively expired on the server.
    // Clear the /me cache AND the stale Bearer token so the next call
    // doesn't keep sending a dead `Authorization: Bearer …` header.
    // Returning null is the AuthContext signal to clearSession() + setStudent(null).
    if (res.status === 401 || res.status === 403) {
      try { localStorage.removeItem(ME_CACHE_KEY); } catch { /* ignore */ }
      // v1.3 — also evict the bearer-fallback token. Without this, any
      // subsequent fetch from a sibling module (Library, Portal, Game)
      // would still attach the dead token via _bearerHeaders(), causing
      // a noisy stream of 401s and confusing the points sync pipeline.
      // Safe to remove: the server already rejected it, so it's worthless.
      try { localStorage.removeItem(LS_KEY); } catch { /* ignore */ }
      return null;
    }
    // 5xx or unexpected status — transient server problem, fall through to cache.
    networkOrServerError = true;
  } catch {
    // Network error (offline, Render cold start timeout) — fall through to cache.
    networkOrServerError = true;
  }

  if (networkOrServerError) {
    // Try the cached /me response before giving up.
    try {
      const raw = localStorage.getItem(ME_CACHE_KEY);
      if (raw) {
        const cached = JSON.parse(raw);
        if (cached && cached.clean_id && Date.now() - (cached._ts || 0) < ME_CACHE_TTL_MS) {
          // Valid cache — return it so the student stays logged in during
          // a Render cold start or brief offline period.
          return cached;
        }
      }
    } catch { /* corrupt cache — fall through */ }
    // No valid cache and server unreachable — throw so AuthContext .catch()
    // handles it by keeping whatever state it already has (never force-logout).
    throw new Error("studentMe: network or server error, no valid cache");
  }

  return null;
}

export async function studentLogout() {
  try {
    await fetch(`${BASE}/api/auth/student/logout`, {
      method: "POST",
      credentials: "include",
      headers: { ..._bearerHeaders() },
    });
  } finally {
    localStorage.removeItem(LS_KEY);
    // v12.0 — clear the /me cache so the next app open shows login form.
    try { localStorage.removeItem(ME_CACHE_KEY); } catch { /* ignore */ }
  }
}

/* ──────────────────────  teacher / admin endpoints  ────────────────────── */

export async function createStudent({ cleanId, displayName, group = "" }) {
  const res = await fetch(`${BASE}/api/teacher/students`, {
    method: "POST",
    credentials: "include",
    headers: _adminHeaders({ "Content-Type": "application/json" }),
    body: JSON.stringify({
      clean_id: cleanId,
      display_name: displayName,
      group,
    }),
  });
  if (!res.ok) {
    const err = await res.json().catch(() => ({}));
    const e = new Error(err.detail || "Failed to create student");
    e.status = res.status;
    throw e;
  }
  return res.json(); // includes plain password — show once, never cache
}

export async function listStudents() {
  const res = await fetch(`${BASE}/api/teacher/students`, {
    credentials: "include",
    headers: _adminHeaders(),
  });
  if (!res.ok) throw new Error("Failed to fetch students");
  const data = await res.json();
  return data.students || [];
}

export async function updateStudent(studentId, { displayName, group }) {
  const body = {};
  if (displayName !== undefined) body.display_name = displayName;
  if (group !== undefined) body.group = group;
  const res = await fetch(`${BASE}/api/teacher/students/${studentId}`, {
    method: "PATCH",
    credentials: "include",
    headers: _adminHeaders({ "Content-Type": "application/json" }),
    body: JSON.stringify(body),
  });
  if (!res.ok) {
    const err = await res.json().catch(() => ({}));
    throw new Error(err.detail || "Failed to update student");
  }
  return res.json();
}

export async function resetStudentPassword(studentId) {
  const res = await fetch(
    `${BASE}/api/teacher/students/${studentId}/reset-password`,
    {
      method: "POST",
      credentials: "include",
      headers: _adminHeaders(),
    },
  );
  if (!res.ok) {
    const err = await res.json().catch(() => ({}));
    throw new Error(err.detail || "Failed to reset password");
  }
  return res.json(); // includes new plain password — show once
}

export async function deactivateStudent(studentId) {
  const res = await fetch(`${BASE}/api/teacher/students/${studentId}`, {
    method: "DELETE",
    credentials: "include",
    headers: _adminHeaders(),
  });
  if (!res.ok) {
    const err = await res.json().catch(() => ({}));
    throw new Error(err.detail || "Failed to deactivate student");
  }
  return res.json();
}

/* ───────────────  Milestone 4 — teacher-assisted password reset  ───────── */

// Student-facing: flags "I forgot my password" for a teacher to review.
// Always resolves the same generic { ok, message } regardless of whether
// cleanId is registered — never throws on a "not found" case, since the
// backend deliberately never reveals whether an ID exists.
export async function requestPasswordReset(cleanId, turnstileToken = "") {
  const res = await fetch(`${BASE}/api/auth/student/forgot-password`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ clean_id: cleanId, turnstile_token: turnstileToken }),
  });
  if (!res.ok) {
    const err = await res.json().catch(() => ({}));
    throw new Error(err.detail || "Request failed");
  }
  return res.json();
}

export async function listPasswordResetRequests() {
  const res = await fetch(`${BASE}/api/teacher/password-reset-requests`, {
    credentials: "include",
    headers: _adminHeaders(),
  });
  if (!res.ok) throw new Error("Failed to fetch password reset requests");
  const data = await res.json();
  return data.requests || [];
}

export async function dismissPasswordResetRequest(requestId) {
  const res = await fetch(
    `${BASE}/api/teacher/password-reset-requests/${requestId}/dismiss`,
    {
      method: "POST",
      credentials: "include",
      headers: _adminHeaders(),
    },
  );
  if (!res.ok) {
    const err = await res.json().catch(() => ({}));
    throw new Error(err.detail || "Failed to dismiss request");
  }
  return res.json();
}

/* ─────────────  Premium Student Profile & Settings — self-service  ─────── */

// Full profile snapshot (extends the 4-field /me contract AuthContext
// already caches — this is a separate, independent fetch used only by the
// Profile page, so AuthContext's existing caching/session-clearing
// behavior is never touched).
export async function getStudentProfile() {
  const res = await fetch(`${BASE}/api/auth/student/me`, {
    credentials: "include",
    headers: { ..._bearerHeaders() },
  });
  if (!res.ok) throw new Error("Failed to fetch profile");
  return res.json();
}

export async function changeStudentPassword(currentPassword, newPassword) {
  const res = await fetch(`${BASE}/api/auth/student/change-password`, {
    method: "POST",
    credentials: "include",
    headers: { "Content-Type": "application/json", ..._bearerHeaders() },
    body: JSON.stringify({
      current_password: currentPassword,
      new_password: newPassword,
    }),
  });
  if (!res.ok) {
    const err = await res.json().catch(() => ({}));
    throw new Error(err.detail || "Failed to change password");
  }
  return res.json();
}

// Bounded so a network hang (dead endpoint, Render cold start, dropped
// connection) can never leave the upload spinner running indefinitely —
// it always resolves to a clear error within this window instead. Uses
// a plain AbortController (not the newer AbortSignal.timeout() sugar)
// for broader runtime compatibility.
const AVATAR_REQUEST_TIMEOUT_MS = 30000;

async function _fetchWithTimeout(url, opts, timeoutMessage) {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), AVATAR_REQUEST_TIMEOUT_MS);
  try {
    return await fetch(url, { ...opts, signal: controller.signal });
  } catch (e) {
    if (e?.name === "AbortError") throw new Error(timeoutMessage);
    throw e;
  } finally {
    clearTimeout(timer);
  }
}

export async function uploadStudentAvatar(file) {
  const body = new FormData();
  body.append("file", file);
  const res = await _fetchWithTimeout(
    `${BASE}/api/auth/student/avatar`,
    {
      method: "POST",
      credentials: "include",
      headers: { ..._bearerHeaders() }, // no Content-Type — browser sets multipart boundary
      body,
    },
    "Upload timed out. Check your connection and try again.",
  );
  if (!res.ok) {
    const err = await res.json().catch(() => ({}));
    throw new Error(err.detail || "Failed to upload avatar");
  }
  return res.json();
}

export async function deleteStudentAvatar() {
  const res = await _fetchWithTimeout(
    `${BASE}/api/auth/student/avatar`,
    {
      method: "DELETE",
      credentials: "include",
      headers: { ..._bearerHeaders() },
    },
    "Request timed out. Check your connection and try again.",
  );
  if (!res.ok) {
    const err = await res.json().catch(() => ({}));
    throw new Error(err.detail || "Failed to remove avatar");
  }
  return res.json();
}
