/**
 * eduhub/lib/notificationApi.js — Activity Center™ student API client.
 *
 * Same session model as voucherApi.js / studentAuthService.js: cookie
 * credentials + the mobile-Safari Bearer fallback from the
 * `student_session_token` localStorage key. REST for history / read state,
 * WebSocket (buildNotificationsWsUrl) for realtime delivery.
 *
 * NO mock data. Every payload comes from real backend events.
 */
/* eslint-disable no-undef */
const BASE = (process.env.REACT_APP_BACKEND_URL || "").replace(/\/$/, "");
/* eslint-enable no-undef */

const LS_KEY = "student_session_token";

export function getSessionToken() {
  try {
    return localStorage.getItem(LS_KEY) || "";
  } catch {
    return "";
  }
}

function bearer() {
  const t = getSessionToken();
  return t ? { Authorization: `Bearer ${t}` } : {};
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

/** List notifications. opts: { category, limit, before } */
export function listNotifications(opts = {}) {
  const p = new URLSearchParams();
  if (opts.category) p.set("category", opts.category);
  if (opts.limit) p.set("limit", String(opts.limit));
  if (opts.before) p.set("before", opts.before);
  const qs = p.toString();
  return fetchJson(`/api/notifications${qs ? `?${qs}` : ""}`);
}

export function getUnreadCount() {
  return fetchJson("/api/notifications/unread-count");
}

export function markNotificationRead(id) {
  return fetchJson(`/api/notifications/${encodeURIComponent(id)}/read`, {
    method: "POST",
  });
}

export function markAllNotificationsRead() {
  return fetchJson("/api/notifications/read-all", { method: "POST" });
}

/** wss:// URL for the isolated realtime layer (cookie also sent by browser). */
export function buildNotificationsWsUrl() {
  if (!BASE) return "";
  const wsBase = BASE.replace(/^http/i, "ws");
  const t = getSessionToken();
  return `${wsBase}/api/notifications/ws${t ? `?token=${encodeURIComponent(t)}` : ""}`;
}
