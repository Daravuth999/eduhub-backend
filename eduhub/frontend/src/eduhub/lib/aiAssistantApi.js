/**
 * aiAssistantApi.js — student-side helpers for the rebuilt AI Assistant.
 *
 * Calls the backend FastAPI routes registered by ai_assistant_tools.py:
 *
 *   GET  /api/ai-assistant/config-public   (cost, voice flag, modes, ...)
 *   POST /api/ai-assistant/chat            (single chat turn → Gemini)
 *
 * Auth model mirrors loginRewardApi.js: cookie credentials are sent by
 * default, with a `Bearer` fallback for Mobile Safari ITP scenarios.
 *
 * The student password lives only in-memory on the AuthContext. It is
 * sent in the `chat` body so the backend can call the existing GAS
 * sendPoints helper (same pattern as Premium AI Reader tools). It is
 * NEVER persisted to localStorage by this module.
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

async function request(path, init = {}) {
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

/** Read the safe student-facing config (no API key, no system prompt). */
export function getAssistantConfig() {
  return request("/api/ai-assistant/config-public");
}

/**
 * Send one chat turn.
 *
 * payload shape:
 *   { message: string,
 *     mode?: string,          // "General" | "Grammar" | ...
 *     history?: Array<{role: "user"|"assistant", content: string}>,
 *     password?: string }     // used ONCE for GAS debit; never persisted
 *
 * Response shape:
 *   { success, reply, model, points_deducted, cost_points,
 *     redirect_to_edutalk?, warning? }
 */
export function postAssistantChat(payload, { signal } = {}) {
  return request("/api/ai-assistant/chat", {
    method: "POST",
    body: JSON.stringify(payload || {}),
    signal,
  });
}
