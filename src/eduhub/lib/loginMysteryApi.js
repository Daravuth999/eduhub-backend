/**
 * loginMysteryApi.js — student-side helpers for the Login Mystery Box popup.
 *
 * Mirrors the existing `loginRewardApi.js` pattern: cookie credentials plus
 * a mobile-Safari Bearer fallback from `student_session_token` localStorage.
 *
 * All endpoints are backend-authoritative. The frontend NEVER decides which
 * box is the winner — it only animates and reveals what the server returns.
 */
/* eslint-disable no-undef */
const BASE = (process.env.REACT_APP_BACKEND_URL || "").replace(/\/$/, "");
/* eslint-enable no-undef */

const LS_KEY = "student_session_token";

function bearer() {
  try {
    const t = localStorage.getItem(LS_KEY);
    return t ? { Authorization: `Bearer ${t}` } : {};
  } catch { return {}; }
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
  try { data = await res.json(); } catch { /* ignore */ }
  if (!res.ok) {
    const err = new Error((data && data.detail) || `HTTP ${res.status}`);
    err.status = res.status;
    err.data = data;
    throw err;
  }
  return data;
}

/**
 * getMysteryBoxStatus — returns the student's current state. If an active
 * eligible campaign exists and the student has not claimed for the current
 * window, the backend will atomically lock the 4 box outcomes server-side
 * and return claim_id + 4 face-down boxes.
 *
 * Response shape:
 *   {
 *     eligible: boolean,
 *     reason: string,
 *     already_claimed: boolean,
 *     campaign: { id, name, title, subtitle, cta_text, ... } | null,
 *     claim_id: string,
 *     boxes: [{ box_index, status, reward_preview }, ...],
 *     selected_box_index: number | null,
 *     selected_reward: object | null,
 *     revealed_rewards: object[],
 *     box_count: 4,
 *   }
 */
export function getMysteryBoxStatus() {
  return fetchJson("/api/student/login-mystery/status");
}

/**
 * selectMysteryBox — student picks a single box. Backend credits ONLY the
 * selected reward and returns the full reveal payload (selected + 3 others).
 */
export function selectMysteryBox(boxIndex, claimId) {
  return fetchJson("/api/student/login-mystery/select", {
    method: "POST",
    body: JSON.stringify({
      box_index: Number(boxIndex),
      claim_id: claimId || undefined,
    }),
  });
}

/**
 * getMysteryBoxHistory — recent credited claims for the logged-in student.
 */
export function getMysteryBoxHistory(limit = 20) {
  return fetchJson(
    `/api/student/login-mystery/history?limit=${encodeURIComponent(limit)}`,
  );
}

/* ── dismiss memory (UI only — claim truth is backend) ─────────────────── */
const DISMISS_PREFIX = "login_mystery_dismissed_";

export function readMysteryDismiss(campaignId, windowKey) {
  try {
    const raw = localStorage.getItem(
      `${DISMISS_PREFIX}${campaignId}_${windowKey || "x"}`,
    );
    if (!raw) return null;
    const obj = JSON.parse(raw);
    if (!obj || typeof obj !== "object") return null;
    return obj;
  } catch { return null; }
}

export function writeMysteryDismiss(campaignId, windowKey) {
  try {
    localStorage.setItem(
      `${DISMISS_PREFIX}${campaignId}_${windowKey || "x"}`,
      JSON.stringify({ at: Date.now() }),
    );
  } catch { /* ignore */ }
}

export function clearMysteryDismiss(campaignId, windowKey) {
  try {
    localStorage.removeItem(`${DISMISS_PREFIX}${campaignId}_${windowKey || "x"}`);
  } catch { /* ignore */ }
}
