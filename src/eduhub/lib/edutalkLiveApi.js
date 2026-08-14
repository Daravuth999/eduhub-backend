/**
 * edutalkLiveApi.js — student-side API client for EduTalk Live Coach.
 *
 * Talks ONLY to the new, isolated backend routes under
 * /api/student/edutalk-live/*. It NEVER touches the existing EduTalk
 * (edutalkPassApi / aiAssistantApi) clients, so the existing assistant,
 * narration audio and billing logic are completely unaffected.
 *
 * The Gemini key is NEVER seen here — the browser only ever connects to the
 * EduHub backend WebSocket, which proxies to Gemini server-side.
 *
 * AUTH FIX (Live Coach v1.3.1):
 *   Mirror the EXACT bearer-fallback pattern used by every other working
 *   student API client (edutalkPassApi.js, aiAssistantApi.js, voucherApi.js,
 *   loginRewardApi.js, EduTalkPanel.jsx _apiGet/_apiPost). Those modules
 *   read the FastAPI student session token from:
 *
 *       localStorage.getItem("student_session_token")
 *
 *   This is the token that `studentAuthService.js#studentLogin()` writes at
 *   login (line 71) and that the backend's `current_student()` dependency
 *   accepts as `Authorization: Bearer <token>` (server.py line 3317).
 *
 *   The previous implementation read `sessionStorage.getItem("eduhub_session_token")`
 *   which is a DIFFERENT system — that key is owned by `secureClient.js`
 *   and holds a Google-Apps-Script session token for the legacy GAS
 *   backend, NOT the FastAPI session token. As a result the Bearer
 *   fallback was empty on every browser where the cross-site
 *   `student_session` cookie was dropped (Safari ITP, installed PWA,
 *   some Chrome/Edge cross-site fetches), making
 *   GET /api/student/edutalk-live/config respond 401 → the component
 *   fell into the catch handler → `setConfig({ available: false })` →
 *   the launcher button was never rendered.
 *
 *   This fix is purely additive on top of the cookie auth: when the
 *   cross-site cookie is present, the backend uses it (Bearer ignored).
 *   When the cookie is dropped (PWA / Safari ITP), the Bearer header
 *   keeps the call authenticated — exactly like the existing purple
 *   EduTalk button and the working Login Rewards / Voucher endpoints.
 */

/* eslint-disable no-undef */
const API_BASE = (process.env.REACT_APP_BACKEND_URL || "").replace(/\/$/, "");
/* eslint-enable no-undef */

// Canonical FastAPI student-session token key (set by
// src/eduhub/auth/studentAuthService.js#studentLogin). DO NOT change —
// every other working student API client reads from this same key.
const LS_KEY = "student_session_token";

function authHeaders() {
  // Cookie auth first (httpOnly `student_session` from /api/auth/student/login),
  // Bearer fallback for Mobile Safari ITP and installed PWAs where the
  // cross-site cookie is silently dropped. Same token key the working
  // EduTalk / Voucher / Login-Rewards clients use.
  const h = { "Content-Type": "application/json" };
  try {
    const tok = localStorage.getItem(LS_KEY) || "";
    if (tok) h.Authorization = `Bearer ${tok}`;
  } catch {
    /* private mode — cookie still works */
  }
  return h;
}

// Coerce a FastAPI error body into a human-readable string. ``detail`` can be
// a string, a 422 validation array of {loc,msg,type}, or a structured object;
// passing a non-string into new Error() renders as "[object Object]" in the UI.
function _detailToMessage(data, status) {
  const d = data && data.detail;
  if (typeof d === "string" && d) return d;
  if (Array.isArray(d)) {
    const msgs = d
      .map((x) => (x && (x.msg || x.message)) || "")
      .filter(Boolean);
    if (msgs.length) return msgs.join("; ");
  } else if (d && typeof d === "object") {
    if (typeof d.msg === "string") return d.msg;
    if (typeof d.message === "string") return d.message;
    try { return JSON.stringify(d); } catch { /* noop */ }
  }
  return `HTTP ${status}`;
}

async function call(path, { method = "GET", body } = {}) {
  const res = await fetch(`${API_BASE}${path}`, {
    method,
    credentials: "include",
    headers: authHeaders(),
    body: body !== undefined ? JSON.stringify(body) : undefined,
  });
  let data = null;
  try {
    data = await res.json();
  } catch {
    /* ignore */
  }
  if (!res.ok) {
    const err = new Error(_detailToMessage(data, res.status));
    err.status = res.status;
    err.data = data;
    throw err;
  }
  return data;
}

export function getLiveConfig() {
  return call("/api/student/edutalk-live/config");
}

export function startLiveSession(payload) {
  return call("/api/student/edutalk-live/session/start", {
    method: "POST",
    body: payload,
  });
}

export function endLiveSession(payload) {
  return call("/api/student/edutalk-live/session/end", {
    method: "POST",
    body: payload,
  });
}

export function getLiveHistory(limit = 20) {
  return call(`/api/student/edutalk-live/history?limit=${limit}`);
}

export function getLiveReport(sessionId) {
  return call(`/api/student/edutalk-live/report/${encodeURIComponent(sessionId)}`);
}

/**
 * Phase 1 Smart Top-Up Nudge — fetch the Stage 3 FINALIZATION block that the
 * post-session report pill renders from. Returns report_eligible + the
 * finalized (settled) balance. The report pill renders ONLY from this value,
 * never from the session-start balance. Safe to call right after the report
 * appears (returns report_eligible=false until finalization is written).
 */
export function getTopupNudgeReport(sessionId) {
  return call(
    `/api/student/edutalk-live/topup-nudge/${encodeURIComponent(sessionId)}`,
  );
}

/**
 * Phase 0B — report a single normalized Top-Up pill VISIBILITY DECISION to the
 * backend (diagnostics only). This NEVER alters eligibility, cap, wallet,
 * payment, or session charging — it appends a bounded `pill_visibility_decision`
 * row to the student's existing nudge-log document. The caller dedups so one
 * stable decision is reported per relevant start/report state (not per render).
 * Fire-and-forget: a failure here must never affect the live session UX.
 */
export function reportTopupNudgeVisibility(payload) {
  return call("/api/student/edutalk-live/topup-nudge/visibility", {
    method: "POST",
    body: payload,
  });
}

/** Build the wss:// URL for the live bridge from the start response. */
export function buildWsUrl(wsPath, wsToken) {
  const base = API_BASE || "";
  const wsBase = base.replace(/^http/i, "ws"); // http→ws, https→wss
  return `${wsBase}${wsPath}?token=${encodeURIComponent(wsToken)}`;
}

// ─────────────────────────────────────────────────────────────────────────
// Phase 1 SURPRISE REWARDS — student-facing reward API.
// ─────────────────────────────────────────────────────────────────────────

/**
 * Claim a server-owned reward offer through the REST route. Backed by the
 * SAME claim service the WebSocket `claim_reward` command uses. Duplicate
 * calls always return the original persisted result — the backend never
 * double-grants.
 */
export function claimRewardOffer(offerId) {
  return call(
    `/api/edutalk/reward-offers/${encodeURIComponent(offerId)}/claim`,
    { method: "POST" },
  );
}

/** Fetch the student's currently-active reward offer for the GIVEN live
 * session. The corrected Phase 1 endpoint requires ``session_id`` so a
 * stale offer from a different session can never be re-attached. */
export function getActiveRewardOffer(sessionId) {
  if (!sessionId) return Promise.resolve({ success: true, offer: null });
  return call(
    `/api/edutalk/reward-offers/active?session_id=${encodeURIComponent(sessionId)}`,
  );
}

/** Hotfix v1 — fetch the backend-truth-driven, session-facing reward STATUS
 * for the persistent Surprise Reward panel. Returns the authoritative state
 * contract (disabled | unavailable | tracking | progressing | eligible |
 * claiming | confirmed | terminal | expired) plus safe presentation data.
 * NEVER returns the reward amount before a confirmed grant. */
export function getRewardStatus(sessionId) {
  if (!sessionId) {
    return Promise.resolve({
      success: true,
      operational: false,
      state: "unavailable",
      offer_id: null,
      reward_summary: null,
    });
  }
  return call(
    `/api/edutalk/reward-status?session_id=${encodeURIComponent(sessionId)}`,
  );
}

// ─────────────────────────────────────────────────────────────────────────
// Live Voice Coach Coupon — student code-entry redemption. Talks ONLY to the
// isolated /api/student/edutalk-live/coupon/* routes (edutalk_coupon_tools.py).
// Returns 503 with a friendly message while EDUTALK_COUPON_REDEMPTION_ENABLED
// is off (the default); the caller treats that exactly like "unavailable".
// ─────────────────────────────────────────────────────────────────────────

/** Validate a Live Voice Coach Coupon code without redeeming it. */
export function validateLiveCoachCoupon(code) {
  return call("/api/student/edutalk-live/coupon/validate", {
    method: "POST",
    body: { code },
  });
}

/** Redeem a Live Voice Coach Coupon code — credits points via the backend
 * treasury pipeline. Safe to retry: the backend never double-credits. */
export function redeemLiveCoachCoupon(code) {
  return call("/api/student/edutalk-live/coupon/redeem", {
    method: "POST",
    body: { code },
  });
}

// ─────────────────────────────────────────────────────────────────────────
// Correction 1 (final) — the delayed-confirmed Gemini congratulations is no
// longer requested through a REST endpoint that depended on an in-process
// live-context registry (which could miss the owning bridge when REST and
// WebSocket traffic reach different workers). The browser now sends a single
// ``{type:"announce_confirmed_reward", offer_id, session_id}`` frame over the
// ALREADY-OPEN authenticated live coach WebSocket, and the backend replies
// with a ``reward_announce_ack``. See EduTalkLiveCoach.jsx. The old
// REST announce helper and its route have therefore been removed.
// ─────────────────────────────────────────────────────────────────────────
