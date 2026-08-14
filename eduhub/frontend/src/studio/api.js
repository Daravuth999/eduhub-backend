/**
 * studio/api.js — thin API client for Author Studio calls.
 *
 * Uses REACT_APP_BACKEND_URL with cookie credentials so the Emergent Google
 * Auth session is sent automatically. All paths are `/api`-prefixed.
 *
 * v9.6 (2026-02) — Treasury credit additions (audit surgery).
 *   [SUPERSEDED — see v11.0 below. Kept for history only.]
 *
 * v11.0 (2026-07) — Platform Reconstruction Phase 1, item 1: client-side
 *   treasury credential removed. `treasuryCreditPoints()` (v9.6) read
 *   `REACT_APP_TREASURY_PASSWORD` via `process.env` — Create React App
 *   inlines REACT_APP_* vars into the built JS bundle at compile time, so
 *   that password shipped to every browser that ever loaded /studio (which
 *   is mounted in the SAME bundle as the student PWA — not behind any
 *   server-side gate). Anyone with dev tools open on a Studio session could
 *   read the credential that empties the treasury wallet.
 *
 *   Replaced with `grantTreasuryPoints({ studentId, amount })`, which calls
 *   the existing admin-gated `POST /api/points/grant` — the treasury
 *   password now lives ONLY as a server-side env var (SL_TREASURY_PASSWORD
 *   on Render) and is never sent to any browser. Same underlying GAS
 *   `sendPoints` transport and student-facing behavior; the only change is
 *   WHERE the credential lives. (Finishing the money migration so this
 *   stops being a GAS-password transport at all is tracked separately —
 *   see the Wallet/Ledger migration phase; this fix's job is only to close
 *   the browser-exposure hole.)
 *
 * v9.7 (2026-02) — Restriction sheet-write helper (RestrictionTab fix).
 *   New helper `patchStudentScores(studentId, fields)` calls the existing
 *   PATCH /api/teacher/students/{id}/scores route which is already deployed
 *   on eduhub-backend. RestrictionTab now writes restriction="TRUE" (or "")
 *   to column G of the Scores Sheet via this route BEFORE firing the push,
 *   so AuthContext's watchdog (which strictly matches the literal string
 *   "TRUE" in column G) actually sees the change and triggers the overlay.
 */
/* eslint-disable no-undef */
const BASE = process.env.REACT_APP_BACKEND_URL;
/* eslint-enable no-undef */

// v8.1 — Mobile Safari ITP blocks 3rd-party cookies between
// *.vercel.app and *.onrender.com even with SameSite=None+Secure.
// We cache the session token in localStorage and send it as a
// Bearer header so mobile devices still authenticate.
const TOKEN_KEY = "studio_session_token_v1";
export const setToken = (tok) => {
  try {
    if (tok) localStorage.setItem(TOKEN_KEY, tok);
    else localStorage.removeItem(TOKEN_KEY);
  } catch { /* ignore */ }
};
export const getToken = () => {
  try { return localStorage.getItem(TOKEN_KEY) || ""; } catch { return ""; }
};

function url(path) {
  if (!BASE) return path;
  return `${BASE.replace(/\/$/, "")}${path}`;
}

async function request(path, { method = "GET", body, headers } = {}) {
  const init = {
    method,
    credentials: "include",
    headers: { ...(headers || {}) },
  };
  // Attach Bearer header if we have a cached token (mobile fallback)
  const tok = getToken();
  if (tok && !init.headers.Authorization) {
    init.headers.Authorization = `Bearer ${tok}`;
  }
  if (body instanceof FormData) {
    init.body = body;
  } else if (body !== undefined) {
    init.headers["Content-Type"] = "application/json";
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

/* -------------------- auth -------------------- */
export const getMe = () => request("/api/auth/me");
export const exchangeSession = (session_id) =>
  request("/api/auth/google", { method: "POST", body: { session_id } });
export const logout = () => request("/api/auth/logout", { method: "POST" });

/* -------------------- books (public) -------------------- */
export const listPublicBooks = () => request("/api/books");

/* -------------------- Achievement Center (Trophy Tiers) -------------------- */
export const listAchievementTrophies = () => request("/api/admin/achievements/trophies");
export const updateAchievementTrophy = (trophyId, payload) =>
  request(`/api/admin/achievements/trophies/${encodeURIComponent(trophyId)}`, {
    method: "PUT",
    body: payload,
  });
export const listAchievementClaims = (limit = 50) =>
  request(`/api/admin/achievements/claims?limit=${limit}`);
export const getPublicBook = (slug) => request(`/api/books/${slug}`);

/* -------------------- studio -------------------- */
export const listStudioBooks = () => request("/api/studio/books");
export const getStudioBook = (slug) => request(`/api/studio/books/${slug}`);
export const saveStudioBook = (payload) =>
  request("/api/studio/books", { method: "POST", body: payload });
export const publishBook = (slug) =>
  request(`/api/studio/books/${slug}/publish`, { method: "POST" });
export const unpublishBook = (slug) =>
  request(`/api/studio/books/${slug}/unpublish`, { method: "POST" });
export const listVoices = () => request("/api/studio/voices");
export const generateAiVoice = (slug, payload) =>
  request(`/api/studio/books/${slug}/elevenlabs`, { method: "POST", body: payload });
export const generateConversationAudio = (slug, payload) =>
  request(`/api/studio/books/${slug}/conversation`, { method: "POST", body: payload });
export const deleteBook = (slug) =>
  request(`/api/studio/books/${slug}`, { method: "DELETE" });
export const parseRaw = (text, default_chapter = "Main") =>
  request("/api/studio/parse", { method: "POST", body: { text, default_chapter } });
export const uploadDoc = (file) => {
  const fd = new FormData();
  fd.append("file", file);
  return request("/api/studio/upload", { method: "POST", body: fd });
};
/* -------------------- teacher -------------------- */
export const teacherPushPoints = (studentId, delta) =>
  request(`/api/teacher/students/${studentId}/push-points`, { method: "POST", body: { delta } });

export const teacherPushRestriction = (studentId, message) =>
  request(`/api/teacher/students/${studentId}/push-restriction`, { method: "POST", body: { message } });

export const teacherPushReminder = (studentId, message) =>
  request(`/api/teacher/students/${studentId}/push-reminder`, { method: "POST", body: { message } });

/* -------------------- v11.0 · treasury credit (server-side only) -------------------- */
// Display-only — the treasury wallet ID is not a secret (it's already shown
// in the UI below), so it's fine to keep a cosmetic env override. The
// PASSWORD that actually authorizes the transfer never touches this bundle
// anymore; it lives exclusively as SL_TREASURY_PASSWORD on the backend.
/* eslint-disable no-undef */
export const TREASURY_ID = (
  process.env.REACT_APP_TREASURY_ID ||
  "stu092"
).toString().trim();
/* eslint-enable no-undef */

/**
 * grantTreasuryPoints — credits a student from the treasury wallet via the
 * existing admin-gated `POST /api/points/grant` route. The route performs
 * the same GAS `sendPoints` transfer the old client-side helper did; the
 * only change is that the treasury password is read server-side
 * (SL_TREASURY_PASSWORD on Render) and is never present in this bundle.
 *
 * Returns `{success, ...}` so callers can render the same UI as before.
 * A 503 from the server (password not configured) or any other API error
 * is normalized into `{success:false, message}` rather than thrown, so
 * existing callers that check `credit.success` keep working unchanged.
 */
export async function grantTreasuryPoints({ studentId, amount, description } = {}) {
  const cleanId = String(studentId || "").trim();
  const n = Math.floor(Number(amount));
  if (!cleanId) {
    return { success: false, reason: "INVALID", message: "Student ID is required." };
  }
  if (!Number.isFinite(n) || n <= 0) {
    return { success: false, reason: "INVALID", message: "Amount must be a positive integer." };
  }
  try {
    const res = await request("/api/points/grant", {
      method: "POST",
      body: { studentID: cleanId, points: n, source: "studio-teacher-tab", description: description || "" },
    });
    return { success: true, amount: n, treasury: TREASURY_ID, raw: res };
  } catch (err) {
    return {
      success: false,
      reason: err && err.status === 503 ? "NO_TREASURY_CREDS" : "SERVER_ERROR",
      message:
        (err && err.message) ||
        "The points server rejected the credit. Please try again.",
    };
  }
}


/* -------------------- v9.7 · restriction sheet-write (audit surgery) -------------------- */
/**
 * patchStudentScores — writes restriction fields directly to the Scores Sheet
 * GAS via ?action=updateStudent. The PATCH /api/teacher/students/{id}/scores
 * backend route does not exist in the current eduhub-backend deployment, so
 * we call GAS directly (same pattern as the treasury credit above).
 *
 *   fields shape:
 *     { restriction: "TRUE" | "",
 *       restrictionReason: string }
 */
const SCORES_GAS_URL =
  "https://script.google.com/macros/s/AKfycbw_hGdyYmWukTCzaZoxuKMv34mYpQMXd7JtSFzpMpRjGd947eM70u-a1xTUJYA894FwAQ/exec";

export async function patchStudentScores(studentId, fields) {
  const cleanId = String(studentId || "").trim();
  if (!cleanId) throw new Error("Student ID is required.");

  const params = new URLSearchParams({
    action: "updateStudent",
    studentId: cleanId,
    ...Object.fromEntries(
      Object.entries(fields).map(([k, v]) => [k, String(v)])
    ),
  });

  const res = await fetch(`${SCORES_GAS_URL}?${params.toString()}`, {
    method: "GET",
    redirect: "follow",
  });

  if (!res.ok) {
    const err = new Error(`GAS updateStudent failed: HTTP ${res.status}`);
    err.status = res.status;
    throw err;
  }

  let data = null;
  try { data = await res.json(); } catch { /* GAS sometimes returns HTML on redirect */ }

  if (data && data.success === false) {
    const err = new Error(data.message || data.error || "GAS returned success=false");
    err.data = data;
    throw err;
  }

  return data || { success: true };
}

/* -------------------- v10.0 · MongoDB-authoritative status workflow -------------------- */
/**
 * setStudentStatus — primary entrypoint for restrict / suspend / deactivate
 * / activate. Goes to Render (backed by `student_status` Mongo collection)
 * which mirrors the change to GAS automatically and fans out the push.
 *
 *   payload shape:
 *     { status: "active" | "restricted" | "suspended" | "deactivated",
 *       reason: string,
 *       liftAt?: ISO datetime }
 */
export const setStudentStatus = (studentId, payload) =>
  request(`/api/teacher/students/${encodeURIComponent(studentId)}/status`, {
    method: "PATCH",
    body: payload,
  });

/** getStudentStatus — teacher read-back (admin-only). */
export const getStudentStatus = (studentId) =>
  request(`/api/teacher/students/${encodeURIComponent(studentId)}/status`);

/* ── Coupon System API (v1.0) ─────────────────────────────────────────── */
export const listCoupons   = ()           => request("/api/coupons");
export const getCoupon     = (code)       => request(`/api/coupons/${code}`);
export const createCoupon  = (payload)    => request("/api/coupons",        { method: "POST",   body: payload });
export const updateCoupon  = (code, data) => request(`/api/coupons/${code}`, { method: "PATCH",  body: data    });
export const deleteCoupon  = (code)       => request(`/api/coupons/${code}`, { method: "DELETE"               });
export const validateCoupon = (payload)  => request("/api/coupons/validate", { method: "POST",  body: payload });
export const redeemCoupon   = (payload)  => request("/api/coupons/redeem",   { method: "POST",  body: payload });

/* ── AI Scene Builder API (v1.0) ────────────────────────────────────────── */
/**
 * checkAiSceneStatus — verify GEMINI_API_KEY is configured on the server.
 * Safe to call on mount — returns { enabled: bool, model: string|null }.
 */
export const checkAiSceneStatus = () =>
  request("/api/studio/ai-scene-status");

/**
 * generateAiScene — ask Gemini to generate a structured speaking-first scene.
 * Returns { success, sceneId, geminiRaw, previewBlocks, warnings, generatedAt }.
 *
 * payload shape:
 *   topic           string   — scene topic
 *   level           string   — "A1" | "A2" | "B1"
 *   style           string   — "Adventure" | "Funny" | "Mystery" | "Emotional" | "Classroom"
 *   includeKhmer    boolean  — store Khmer as hidden metadata (default: false)
 *   generateQuiz    boolean  — include MCQ block
 *   generateVocab   boolean  — include vocabulary block
 *   generateSpeaking boolean — include speaking prompt block
 */
export const generateAiScene = (slug, payload) =>
  request(`/api/studio/books/${slug}/ai-scene`, { method: "POST", body: payload });

/**
 * getAiScene — reload a previously generated scene by sceneId.
 * Returns the persisted ai_scene_jobs document.
 */
export const getAiScene = (sceneId) =>
  request(`/api/studio/ai-scene/${sceneId}`);

/* -------------------- Premium AI Tools (Phase 1) -------------------- */
// Author Studio AI Tools control panel.
export const getAiToolsConfig = () =>
  request("/api/admin/ai-tools-config");

export const saveAiToolsConfig = (payload) =>
  request("/api/admin/ai-tools-config", { method: "PUT", body: payload });

export const listAiUsageLogs = ({ limit = 100, skip = 0 } = {}) =>
  request(`/api/admin/ai-tools-usage?limit=${limit}&skip=${skip}`);

// Student-side helpers. Sent body contains the student's in-memory password
// because the existing GAS sendPoints contract requires it for a debit.
// The backend uses it ONCE to call GAS sendPoints AFTER Gemini succeeds and
// never persists it (no MongoDB, no log, no return value). This mirrors the
// existing purchaseBook flow in purchaseService.js.
export const studentGetAiConfig = () =>
  request("/api/student/premium/ai-config");

export const studentDecodeBlock = (body) =>
  request("/api/student/premium/decode-block", { method: "POST", body });

export const studentExecutiveUpgrade = (body) =>
  request("/api/student/premium/executive-upgrade", { method: "POST", body });

/* -------------------- EduTalk (Phase 2A) -------------------- */
// Author Studio EduTalk control panel — isolated from Phase 1 helpers above.
export const getEdutalkConfig = () =>
  request("/api/admin/edutalk-config");

export const saveEdutalkConfig = (payload) =>
  request("/api/admin/edutalk-config", { method: "PUT", body: payload });

/* -------------------- AI Assistant (Personal English Coach) -------------------- */
// Author Studio admin panel for the rebuilt AI Assistant (Gemini 2.5 Flash).
// Reuses the same admin auth dependency as the other Studio panels — the
// backend protects these routes via require_admin.
export const getAiAssistantConfig = () =>
  request("/api/admin/ai-assistant/config");

export const saveAiAssistantConfig = (payload) =>
  request("/api/admin/ai-assistant/config", { method: "POST", body: payload });

export const testAiAssistant = (payload) =>
  request("/api/admin/ai-assistant/test", { method: "POST", body: payload });


/* -------------------- AI Assistant Voice Missions + Coach Rewards (v1) -------------------- */
// Author Studio admin panel for Speech Coach voice missions, R2 voice
// storage, Coach Rewards, fraud rules and push notifications. Reuses the
// same admin auth dependency as other Studio panels (require_admin).
export const getAiAssistantVoiceRewardsConfig = () =>
  request("/api/admin/ai-assistant/voice-rewards/config");

export const saveAiAssistantVoiceRewardsConfig = (payload) =>
  request("/api/admin/ai-assistant/voice-rewards/config", {
    method: "POST",
    body: payload,
  });

export const listAiAssistantVoiceAttempts = ({
  limit = 50,
  student_id = "",
  mission_id = "",
} = {}) => {
  const q = new URLSearchParams();
  if (limit) q.set("limit", String(limit));
  if (student_id) q.set("student_id", student_id);
  if (mission_id) q.set("mission_id", mission_id);
  const qs = q.toString();
  return request(
    `/api/admin/ai-assistant/voice-attempts${qs ? `?${qs}` : ""}`,
  );
};



/* -------------------- Login Reward Campaigns (v11.0) -------------------- */
// Author Studio admin CRUD for the login-reward campaign system. Reuses the
// existing studio admin auth pattern (cookie + Bearer fallback via request()).
export const listLoginRewardCampaigns = () =>
  request("/api/admin/rewards/login-campaigns");

export const createLoginRewardCampaign = (payload) =>
  request("/api/admin/rewards/login-campaigns", { method: "POST", body: payload });

export const getLoginRewardCampaign = (id) =>
  request(`/api/admin/rewards/login-campaigns/${id}`);

export const updateLoginRewardCampaign = (id, payload) =>
  request(`/api/admin/rewards/login-campaigns/${id}`, { method: "PUT", body: payload });

export const deleteLoginRewardCampaign = (id) =>
  request(`/api/admin/rewards/login-campaigns/${id}`, { method: "DELETE" });

export const listLoginRewardClaims = (id) =>
  request(`/api/admin/rewards/login-campaigns/${id}/claims`);

// Smart Push Notification v1 — admin-triggered manual "Send Now". Reuses
// the existing backend push fan-out and the existing push_history audit
// log. `body` should carry the CURRENT editor values
// ({ title, body, target }); when omitted the backend falls back to the
// campaign's saved push_title/push_body/push_target. Returns
// { sent, failed, target }.
export const sendLoginRewardCampaignPushNow = (id, body) =>
  request(
    `/api/admin/rewards/login-campaigns/${id}/push/send-now`,
    { method: "POST", body: body || {} },
  );


/* -------------------- Mystery Box + EduTalk Passes (v1) -------------------- */
// Author Studio admin CRUD for the Speaking Lab Mystery Box reward system.
// Reuses the existing studio admin auth pattern (cookie + Bearer fallback).
// Voucher codes are NEVER returned by any of these endpoints — the backend
// reuses the existing login-reward voucher issuer so granted vouchers land
// in /api/student/vouchers privately.
export const listMysteryBoxPrizeTemplates = () =>
  request("/api/admin/mystery-box/prize-templates");
export const createMysteryBoxPrizeTemplate = (payload) =>
  request("/api/admin/mystery-box/prize-templates", { method: "POST", body: payload });
export const updateMysteryBoxPrizeTemplate = (id, payload) =>
  request(`/api/admin/mystery-box/prize-templates/${id}`, { method: "PUT", body: payload });
export const deleteMysteryBoxPrizeTemplate = (id) =>
  request(`/api/admin/mystery-box/prize-templates/${id}`, { method: "DELETE" });

export const listEduTalkPassTemplates = () =>
  request("/api/admin/edutalk-passes/templates");
export const createEduTalkPassTemplate = (payload) =>
  request("/api/admin/edutalk-passes/templates", { method: "POST", body: payload });
export const updateEduTalkPassTemplate = (id, payload) =>
  request(`/api/admin/edutalk-passes/templates/${id}`, { method: "PUT", body: payload });
export const deleteEduTalkPassTemplate = (id) =>
  request(`/api/admin/edutalk-passes/templates/${id}`, { method: "DELETE" });

export const listMysteryBoxCampaigns = () =>
  request("/api/admin/mystery-box/campaigns");
export const createMysteryBoxCampaign = (payload) =>
  request("/api/admin/mystery-box/campaigns", { method: "POST", body: payload });
export const updateMysteryBoxCampaign = (id, payload) =>
  request(`/api/admin/mystery-box/campaigns/${id}`, { method: "PUT", body: payload });
export const deleteMysteryBoxCampaign = (id) =>
  request(`/api/admin/mystery-box/campaigns/${id}`, { method: "DELETE" });



/* -------------------- Login Mystery Box Rewards (v12.0) -------------------- */
// Author Studio admin CRUD for the Login Mystery Box campaign system. Reuses
// the same Studio admin auth (require_admin) as every other admin panel. The
// backend never returns voucher codes or pass entitlement IDs from these
// endpoints — those are credited at /api/student/login-mystery/select time
// and surfaced privately through /api/student/vouchers and the EduTalk pass
// entitlement collection.
export const listLoginMysteryCampaigns = () =>
  request("/api/admin/login-mystery/campaigns");

export const createLoginMysteryCampaign = (payload) =>
  request("/api/admin/login-mystery/campaigns", { method: "POST", body: payload });

export const getLoginMysteryCampaign = (id) =>
  request(`/api/admin/login-mystery/campaigns/${id}`);

export const updateLoginMysteryCampaign = (id, payload) =>
  request(`/api/admin/login-mystery/campaigns/${id}`, { method: "PUT", body: payload });

export const deleteLoginMysteryCampaign = (id) =>
  request(`/api/admin/login-mystery/campaigns/${id}`, { method: "DELETE" });

export const listLoginMysteryClaims = ({ campaign_id = "", limit = 200 } = {}) => {
  const q = new URLSearchParams();
  if (campaign_id) q.set("campaign_id", campaign_id);
  if (limit) q.set("limit", String(limit));
  const qs = q.toString();
  return request(`/api/admin/login-mystery/claims${qs ? `?${qs}` : ""}`);
};

export const getLoginMysteryAnalytics = (campaignId) => {
  const q = new URLSearchParams();
  if (campaignId) q.set("campaign_id", campaignId);
  const qs = q.toString();
  return request(`/api/admin/login-mystery/analytics${qs ? `?${qs}` : ""}`);
};

/* -------------------- Voice Treasure (Phase 2 config) -------------------- */
// Admin config read/write. Uses the same request() helper (cookie + Bearer)
// every other Author Studio call uses. Student-safe public config is fetched
// separately by the student PWA, never from here.
export const getVoiceTreasureConfig = () =>
  request("/api/admin/voice-treasure/config");
export const saveVoiceTreasureConfig = (config) =>
  request("/api/admin/voice-treasure/config", { method: "PUT", body: { config } });

// Operational admin views (read-only except explicit reconcile)
export const getVoiceTreasureAnalytics = () =>
  request("/api/admin/voice-treasure/analytics");
export const getVoiceTreasureAttempts = (state) =>
  request(`/api/admin/voice-treasure/attempts${state ? `?state=${encodeURIComponent(state)}` : ""}`);
export const getVoiceTreasureEntries = (state) =>
  request(`/api/admin/voice-treasure/entries${state ? `?state=${encodeURIComponent(state)}` : ""}`);
export const getVoiceTreasureRewards = (state) =>
  request(`/api/admin/voice-treasure/rewards${state ? `?state=${encodeURIComponent(state)}` : ""}`);
export const getVoiceTreasureReconciliationQueue = () =>
  request("/api/admin/voice-treasure/reconciliation-queue");
export const reconcileVoiceTreasureReward = (rewardId, outcome, evidence) =>
  request(`/api/admin/voice-treasure/rewards/${encodeURIComponent(rewardId)}/reconcile`, {
    method: "POST",
    body: { outcome, evidence },
  });

// Bundled mission scene library management
export const getVoiceTreasureScenes = () =>
  request("/api/admin/voice-treasure/scenes");
export const updateVoiceTreasureScene = (sceneId, override) =>
  request(`/api/admin/voice-treasure/scenes/${encodeURIComponent(sceneId)}`, {
    method: "PUT",
    body: { override },
  });
// Resolve a stuck (ambiguous) paid entry — explicit + auditable.
export const reconcileVoiceTreasureEntry = (entryId, outcome, evidence) =>
  request(`/api/admin/voice-treasure/entries/${encodeURIComponent(entryId)}/reconcile`, {
    method: "POST",
    body: { outcome, evidence },
  });
// Paid-entry recovery (no GAS, no second charge) — audited.
export const reopenVoiceTreasureEntry = (entryId, reason) =>
  request(`/api/admin/voice-treasure/entries/${encodeURIComponent(entryId)}/reopen`, {
    method: "POST",
    body: { reason },
  });
export const replaceVoiceTreasureMission = (entryId, reason) =>
  request(`/api/admin/voice-treasure/entries/${encodeURIComponent(entryId)}/replace-mission`, {
    method: "POST",
    body: { reason },
  });

// ── Artwork Campaigns (Author Studio v1.0, additive) ──────────────────────
export const listArtworkCampaigns  = ()           => request("/api/artwork-campaigns");
export const createArtworkCampaign = (payload)    => request("/api/artwork-campaigns",        { method: "POST",   body: payload });
export const getArtworkCampaign    = (id)         => request(`/api/artwork-campaigns/${id}`);
export const updateArtworkCampaign = (id, payload)=> request(`/api/artwork-campaigns/${id}`,   { method: "PUT",    body: payload });
export const deleteArtworkCampaign = (id)         => request(`/api/artwork-campaigns/${id}`,   { method: "DELETE"               });

// ── Experience Configuration Platform (Author Studio, Phase 3) ────────────
// Admin CRUD + draft/published lifecycle for the generic `experience_configs`
// collection. Reuses the same admin auth (require_admin) as every other
// Studio panel. `experienceType` scopes everything — "welcome_dashboard" is
// the first of several planned experience types (see KNOWN_EXPERIENCE_TYPES
// in experience_config_tools.py on the backend).
export const listExperienceConfigs = (experienceType) =>
  request(`/api/experience-configs${experienceType ? `?type=${encodeURIComponent(experienceType)}` : ""}`);
export const createExperienceConfig = (payload) =>
  request("/api/experience-configs", { method: "POST", body: payload });
export const getExperienceConfig = (id) =>
  request(`/api/experience-configs/${encodeURIComponent(id)}`);
export const updateExperienceConfig = (id, payload) =>
  request(`/api/experience-configs/${encodeURIComponent(id)}`, { method: "PUT", body: payload });
export const publishExperienceConfig = (id) =>
  request(`/api/experience-configs/${encodeURIComponent(id)}/publish`, { method: "POST" });
export const unpublishExperienceConfig = (id) =>
  request(`/api/experience-configs/${encodeURIComponent(id)}/unpublish`, { method: "POST" });
export const duplicateExperienceConfig = (id, key) =>
  request(`/api/experience-configs/${encodeURIComponent(id)}/duplicate`, { method: "POST", body: key ? { key } : {} });
export const deleteExperienceConfig = (id, { force = false } = {}) =>
  request(`/api/experience-configs/${encodeURIComponent(id)}${force ? "?force=true" : ""}`, { method: "DELETE" });

// ── Event Engine (architecture.md §4.3 — Event Templates + Events) ────────
// Backend: event_engine.py. Speaking Lab is the first event_type; the
// template lifecycle (draft -> published -> archived, publish-immutable,
// duplicate-to-edit) mirrors the Experience Config Platform pattern above.
export const listEventTemplates = (status) =>
  request(`/api/v1/event-templates${status ? `?status=${encodeURIComponent(status)}` : ""}`);
export const getEventTemplate = (id) =>
  request(`/api/v1/event-templates/${encodeURIComponent(id)}`);
export const createEventTemplate = (payload) =>
  request("/api/v1/event-templates", { method: "POST", body: payload });
export const updateEventTemplate = (id, payload) =>
  request(`/api/v1/event-templates/${encodeURIComponent(id)}`, { method: "PATCH", body: payload });
export const publishEventTemplate = (id) =>
  request(`/api/v1/event-templates/${encodeURIComponent(id)}/publish`, { method: "POST" });
export const unpublishEventTemplate = (id) =>
  request(`/api/v1/event-templates/${encodeURIComponent(id)}/unpublish`, { method: "POST" });
export const archiveEventTemplate = (id) =>
  request(`/api/v1/event-templates/${encodeURIComponent(id)}/archive`, { method: "POST" });
export const duplicateEventTemplate = (id) =>
  request(`/api/v1/event-templates/${encodeURIComponent(id)}/duplicate`, { method: "POST" });

export const listEvents = (state) =>
  request(`/api/v1/events${state ? `?state=${encodeURIComponent(state)}` : ""}`);
export const getEvent = (id) =>
  request(`/api/v1/events/${encodeURIComponent(id)}`);
export const createEvent = (payload) =>
  request("/api/v1/events", { method: "POST", body: payload });
export const transitionEvent = (id, to) =>
  request(`/api/v1/events/${encodeURIComponent(id)}/transition`, { method: "POST", body: { to } });
export const getEventsRuntimeDashboard = () => request("/api/v1/events/dashboard");

// ── Reward Pool — the single admin configuration action ───────────────────
// One Save on the Event Templates screen: the backend creates + funds the
// underlying pool and auto-links it to every future session from the
// template. The admin never touches pool ids, linking, or funding flows.
export const getTemplateRewardPool = (id) =>
  request(`/api/v1/event-templates/${encodeURIComponent(id)}/reward-pool`);
export const setTemplateRewardPool = (id, payload) =>
  request(`/api/v1/event-templates/${encodeURIComponent(id)}/reward-pool`, { method: "POST", body: payload });

// ── Platform Configuration (eduhub_platform/config.py) ────────────────────
// The 3-tier flag resolver's admin surface: published override > env var >
// default. Author Studio's "Platform Configuration" screen.
export const listPlatformConfig = () => request("/api/v1/platform-config");
export const getPlatformConfig = (name, { envVar, defaultValue } = {}) => {
  const params = new URLSearchParams();
  if (envVar) params.set("env_var", envVar);
  if (defaultValue !== undefined && defaultValue !== null) params.set("default", defaultValue);
  const qs = params.toString();
  return request(`/api/v1/platform-config/${encodeURIComponent(name)}${qs ? `?${qs}` : ""}`);
};
export const setPlatformConfig = (name, value) =>
  request(`/api/v1/platform-config/${encodeURIComponent(name)}`, { method: "POST", body: { value } });
export const clearPlatformConfig = (name) =>
  request(`/api/v1/platform-config/${encodeURIComponent(name)}`, { method: "DELETE" });
export const getPlatformConfigHistory = (name) =>
  request(`/api/v1/platform-config/${encodeURIComponent(name)}/history`);

// ── Question Bank (question_bank.py) ───────────────────────────────────────
// Structured replacement for the Speaking Lab Console's localStorage-backed
// question editor: categories/search/import/export/draft-publish-archive
// lifecycle. Author Studio's "Question Bank" screen.
export const listQuestions = ({ category, status, search } = {}) => {
  const params = new URLSearchParams();
  if (category) params.set("category", category);
  if (status) params.set("status", status);
  if (search) params.set("search", search);
  const qs = params.toString();
  return request(`/api/v1/question-bank${qs ? `?${qs}` : ""}`);
};
export const listQuestionCategories = () => request("/api/v1/question-bank/categories");
export const getQuestion = (id) =>
  request(`/api/v1/question-bank/${encodeURIComponent(id)}`);
export const createQuestion = (payload) =>
  request("/api/v1/question-bank", { method: "POST", body: payload });
export const updateQuestion = (id, payload) =>
  request(`/api/v1/question-bank/${encodeURIComponent(id)}`, { method: "PATCH", body: payload });
export const publishQuestion = (id) =>
  request(`/api/v1/question-bank/${encodeURIComponent(id)}/publish`, { method: "POST" });
export const unpublishQuestion = (id) =>
  request(`/api/v1/question-bank/${encodeURIComponent(id)}/unpublish`, { method: "POST" });
export const archiveQuestion = (id) =>
  request(`/api/v1/question-bank/${encodeURIComponent(id)}/archive`, { method: "POST" });
export const deleteQuestion = (id) =>
  request(`/api/v1/question-bank/${encodeURIComponent(id)}`, { method: "DELETE" });
export const importQuestions = (payload) =>
  request("/api/v1/question-bank/import", { method: "POST", body: payload });
export const exportQuestions = ({ category, status } = {}) => {
  const params = new URLSearchParams();
  if (category) params.set("category", category);
  if (status) params.set("status", status);
  const qs = params.toString();
  return request(`/api/v1/question-bank/export${qs ? `?${qs}` : ""}`);
};

// ── Notification Packs (notification_packs.py) ─────────────────────────────
// Reusable {placeholder}-templated title/body/url packs that an Event
// Template's notification_pack_ref can point at. An authoring layer only —
// packs are never sent directly; notification_center.py's delivery pipeline
// is untouched. Author Studio's "Notification Packs" screen.
export const listNotificationPacks = ({ type, status } = {}) => {
  const params = new URLSearchParams();
  if (type) params.set("type", type);
  if (status) params.set("status", status);
  const qs = params.toString();
  return request(`/api/v1/notification-packs${qs ? `?${qs}` : ""}`);
};
export const getNotificationPack = (id) =>
  request(`/api/v1/notification-packs/${encodeURIComponent(id)}`);
export const createNotificationPack = (payload) =>
  request("/api/v1/notification-packs", { method: "POST", body: payload });
export const updateNotificationPack = (id, payload) =>
  request(`/api/v1/notification-packs/${encodeURIComponent(id)}`, { method: "PATCH", body: payload });
export const publishNotificationPack = (id) =>
  request(`/api/v1/notification-packs/${encodeURIComponent(id)}/publish`, { method: "POST" });
export const unpublishNotificationPack = (id) =>
  request(`/api/v1/notification-packs/${encodeURIComponent(id)}/unpublish`, { method: "POST" });
export const archiveNotificationPack = (id) =>
  request(`/api/v1/notification-packs/${encodeURIComponent(id)}/archive`, { method: "POST" });
export const deleteNotificationPack = (id) =>
  request(`/api/v1/notification-packs/${encodeURIComponent(id)}`, { method: "DELETE" });
export const previewNotificationPack = (id, context) =>
  request(`/api/v1/notification-packs/${encodeURIComponent(id)}/preview`, { method: "POST", body: { context } });

// ── Prize Pool Platform (prize_pool.py) ────────────────────────────────────
// Reusable pools any consumer (Event Engine, Weekly Rewards, Tournament,
// Promotion, Top-up Campaign, Referral Campaign, Seasonal Event) can
// contribute into / distribute from. No separate ledger — every balance and
// ledger entry here is a live read through the SAME wallet_service the
// student points wallet uses (pool funds live in a virtual `pool_<id>`
// wallet inside points_wallets/points_transactions). Author Studio's "Prize
// Pools" screen is an operational view: create pools, inspect balance/
// ledger, and drive the open -> locked -> settled/cancelled lifecycle.
export const listPrizePools = ({ ownerType, status } = {}) => {
  const params = new URLSearchParams();
  if (ownerType) params.set("owner_type", ownerType);
  if (status) params.set("status", status);
  const qs = params.toString();
  return request(`/api/v1/prize-pools${qs ? `?${qs}` : ""}`);
};
export const createPrizePool = (payload) =>
  request("/api/v1/prize-pools", { method: "POST", body: payload });
export const getPrizePool = (id) =>
  request(`/api/v1/prize-pools/${encodeURIComponent(id)}`);
export const getPrizePoolBalance = (id) =>
  request(`/api/v1/prize-pools/${encodeURIComponent(id)}/balance`);
export const getPrizePoolLedger = (id, { limit = 100 } = {}) =>
  request(`/api/v1/prize-pools/${encodeURIComponent(id)}/ledger?limit=${limit}`);
export const contributeToPrizePool = (id, payload) =>
  request(`/api/v1/prize-pools/${encodeURIComponent(id)}/contribute`, { method: "POST", body: payload });
export const distributeFromPrizePool = (id, payload) =>
  request(`/api/v1/prize-pools/${encodeURIComponent(id)}/distribute`, { method: "POST", body: payload });
export const lockPrizePool = (id) =>
  request(`/api/v1/prize-pools/${encodeURIComponent(id)}/lock`, { method: "POST" });
export const unlockPrizePool = (id) =>
  request(`/api/v1/prize-pools/${encodeURIComponent(id)}/unlock`, { method: "POST" });
export const settlePrizePool = (id) =>
  request(`/api/v1/prize-pools/${encodeURIComponent(id)}/settle`, { method: "POST" });
export const cancelPrizePool = (id) =>
  request(`/api/v1/prize-pools/${encodeURIComponent(id)}/cancel`, { method: "POST" });
// Speaking Lab funding-source migration — administrators fund pools
// directly (no student ever pays into one); fund_pool is a pure one-sided
// wallet credit on the backend (prize_pool.py), never a transfer out of
// any student's own wallet. link-session associates a pool with a
// specific speaking_lab_sessions doc (the field lucky_draw.py's
// _resolve_pool_total reads) so the Lucky Draw's split comes from the
// pool's live balance instead of summed entry fees.
export const fundPrizePool = (id, payload) =>
  request(`/api/v1/prize-pools/${encodeURIComponent(id)}/fund`, { method: "POST", body: payload });
export const linkPrizePoolToSession = (id, sessionId) =>
  request(`/api/v1/prize-pools/${encodeURIComponent(id)}/link-session`, { method: "POST", body: { session_id: sessionId } });
export const getPrizePoolForSession = (sessionId) =>
  request(`/api/v1/prize-pools/by-session/${encodeURIComponent(sessionId)}`);

// ── Hero Artwork (Welcome Experience Studio enhancement) ──────────────────
// Thin wrappers around the existing Phase A backend (hero_artwork_tools.py).
// No new routes — upload/list/delete already exist, admin-gated.
export const uploadHeroArtwork = (file) => {
  const fd = new FormData();
  fd.append("file", file);
  return request("/api/hero-artwork/upload", { method: "POST", body: fd });
};
export const listHeroArtworkLibrary = () => request("/api/hero-artwork/library");
export const deleteHeroArtworkAsset = (id) =>
  request(`/api/hero-artwork/library/${encodeURIComponent(id)}`, { method: "DELETE" });

// ── AI Assessment / Quiz Submission Lab (assessment_tools.py) ────────────
// Teacher review flow: extract an answer key from an upload, create/publish
// an assessment, review/correct student submissions, and award points
// (individually or in bulk) through the existing wallet — no new endpoints
// invented here beyond what assessment_tools.py registers.
export const extractAssessmentAnswerKey = (file) => {
  const fd = new FormData();
  fd.append("file", file);
  return request("/api/admin/assessments/extract-key", { method: "POST", body: fd });
};
export const createAssessment = (payload) =>
  request("/api/admin/assessments", { method: "POST", body: payload });
export const listAssessments = () => request("/api/admin/assessments");
export const getAssessment = (assessmentId) =>
  request(`/api/admin/assessments/${encodeURIComponent(assessmentId)}`);
export const updateAssessment = (assessmentId, payload) =>
  request(`/api/admin/assessments/${encodeURIComponent(assessmentId)}`, { method: "PATCH", body: payload });
export const listAssessmentSubmissions = (assessmentId, status) =>
  request(`/api/admin/assessments/${encodeURIComponent(assessmentId)}/submissions${status ? `?status=${encodeURIComponent(status)}` : ""}`);
export const getAssessmentSubmission = (submissionId) =>
  request(`/api/admin/assessments/submissions/${encodeURIComponent(submissionId)}`);
export const correctAssessmentSubmission = (submissionId, corrections) =>
  request(`/api/admin/assessments/submissions/${encodeURIComponent(submissionId)}/correct`, {
    method: "POST", body: { corrections },
  });
export const awardAssessmentSubmission = (submissionId) =>
  request(`/api/admin/assessments/submissions/${encodeURIComponent(submissionId)}/award`, { method: "POST" });
export const bulkAwardAssessmentSubmissions = (submissionIds) =>
  request("/api/admin/assessments/submissions/bulk-award", { method: "POST", body: { submissionIds } });
export const retryAssessmentGasSync = (submissionId) =>
  request(`/api/admin/assessments/submissions/${encodeURIComponent(submissionId)}/retry-gas-sync`, { method: "POST" });
export const deleteAssessmentSubmission = (submissionId) =>
  request(`/api/admin/assessments/submissions/${encodeURIComponent(submissionId)}`, { method: "DELETE" });
