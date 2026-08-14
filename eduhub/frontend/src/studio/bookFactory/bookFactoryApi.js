/**
 * bookFactoryApi.js — self-contained API client for the Book Factory.
 *
 * Follows studio/api.js's request()/auth-header conventions WITHOUT importing
 * it. All paths are /api-prefixed. EVERY call accepts an AbortSignal so the
 * Studio shell can abort in-flight requests when the author navigates away.
 */
/* eslint-disable no-undef */
const BASE = process.env.REACT_APP_BACKEND_URL;
/* eslint-enable no-undef */

const TOKEN_KEY = "studio_session_token_v1";

function getToken() {
  try { return localStorage.getItem(TOKEN_KEY) || ""; } catch { return ""; }
}

function url(path) {
  if (!BASE) return path;
  return `${BASE.replace(/\/$/, "")}${path}`;
}

async function request(path, { method = "GET", body, signal } = {}) {
  const headers = {};
  const tok = getToken();
  if (tok) headers.Authorization = `Bearer ${tok}`;
  const init = { method, credentials: "include", headers, signal };
  if (body !== undefined) {
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

const ROOT = "/api/studio/book-factory";

/**
 * getStatus — fail-closed status fetch. Resolves to {visible, enabled,
 * geminiEnabled}. On ANY error / non-200 / malformed response it resolves to
 * {visible:false, enabled:false, geminiEnabled:false} (never rejects).
 */
const _FAIL_CLOSED_STATUS = {
  visible: false, enabled: false, geminiEnabled: false,
  coverEnabled: false, coverProviderReady: false, coverStorageReady: false,
  narrationEnabled: false, conversationAudioEnabled: false, directPublishEnabled: false,
  premiumInteractionsEnabled: false,
};

export async function getStatus(signal) {
  try {
    const data = await request(`${ROOT}/status`, { signal });
    if (!data || typeof data !== "object") return { ..._FAIL_CLOSED_STATUS };
    return {
      visible: data.visible === true,
      enabled: data.enabled === true,
      geminiEnabled: data.geminiEnabled === true,
      coverEnabled: data.coverEnabled === true,
      coverProviderReady: data.coverProviderReady === true,
      coverStorageReady: data.coverStorageReady === true,
      narrationEnabled: data.narrationEnabled === true,
      conversationAudioEnabled: data.conversationAudioEnabled === true,
      directPublishEnabled: data.directPublishEnabled === true,
      premiumInteractionsEnabled: data.premiumInteractionsEnabled === true,
    };
  } catch {
    return { ..._FAIL_CLOSED_STATUS };
  }
}

export const createJob = (config, signal) =>
  request(`${ROOT}/jobs`, { method: "POST", body: { config }, signal });

export const listJobs = (limit = 20, signal) =>
  request(`${ROOT}/jobs?limit=${encodeURIComponent(limit)}`, { signal });

export const getJob = (jobId, signal) =>
  request(`${ROOT}/jobs/${jobId}`, { signal });

export const stepJob = (jobId, body, signal) =>
  request(`${ROOT}/jobs/${jobId}/step`, { method: "POST", body, signal });

export const approveJob = (jobId, signal) =>
  request(`${ROOT}/jobs/${jobId}/approve`, { method: "POST", signal });

export const retryChapter = (jobId, chapterId, signal) =>
  request(`${ROOT}/jobs/${jobId}/chapters/${chapterId}/retry`, { method: "POST", signal });

// §HOTFIX: explicit, teacher-confirmed recovery for a chapter that reached
// failed_terminal/unknown_outcome. Distinct from retryChapter (which only
// covers the automatic-eligible failed_retryable/unknown_outcome states).
export const retryFailedChapter = (jobId, chapterId, signal) =>
  request(`${ROOT}/jobs/${jobId}/chapters/${chapterId}/retry-failed`, { method: "POST", signal });

export const lockChapter = (jobId, chapterId, signal) =>
  request(`${ROOT}/jobs/${jobId}/chapters/${chapterId}/lock`, { method: "POST", signal });

export const unlockChapter = (jobId, chapterId, signal) =>
  request(`${ROOT}/jobs/${jobId}/chapters/${chapterId}/unlock`, { method: "POST", signal });

export const regenerateChapter = (jobId, chapterId, focusedInstruction, signal) =>
  request(`${ROOT}/jobs/${jobId}/chapters/${chapterId}/regenerate`,
          { method: "POST", body: { focusedInstruction: focusedInstruction || "" }, signal });

export const cancelJob = (jobId, signal) =>
  request(`${ROOT}/jobs/${jobId}/cancel`, { method: "POST", signal });

export const exportJob = (jobId, signal) =>
  request(`${ROOT}/jobs/${jobId}/export`, { signal });

// ── Phase A/B/C: server-authoritative save/publish/cover/narration ────────
// None of these accept a slug from the caller — the backend binds and reads
// the saved-book slug on the job itself (§AMENDMENT 2). The job returned in
// each response is the single source of truth for progress; the frontend
// never infers completion from localStorage.
export const saveDraft = (jobId, signal) =>
  request(`${ROOT}/jobs/${jobId}/save-draft`, { method: "POST", signal });

export const publishJob = (jobId, signal) =>
  request(`${ROOT}/jobs/${jobId}/publish`, { method: "POST", signal });

export const generateCover = (jobId, signal) =>
  request(`${ROOT}/jobs/${jobId}/cover/generate`, { method: "POST", signal });

export const regenerateCover = (jobId, signal) =>
  request(`${ROOT}/jobs/${jobId}/cover/regenerate`, { method: "POST", signal });

export const narrateChapter = (jobId, chapterId, { voice, syncedWords } = {}, signal) =>
  request(`${ROOT}/jobs/${jobId}/narration/${chapterId}`,
          { method: "POST", body: { voice: voice || "", syncedWords: !!syncedWords }, signal });

// ── Phase E: persisted line-level conversation-audio automation ───────────
// Zero-copy: no manual CVS text entry required for this path. Every call
// re-fetches the job (returned in the response) so the frontend never needs
// to guess whether a paid stage already ran — the backend is authoritative.
export const initConversationAudio = (jobId, chapterId, { voiceAssignments, pauseAfter } = {}, signal) =>
  request(`${ROOT}/jobs/${jobId}/conversation-audio/${chapterId}/init`,
          { method: "POST", body: { voiceAssignments: voiceAssignments || {}, pauseAfter: pauseAfter ?? 0.35 }, signal });

export const generateConversationLine = (jobId, chapterId, lineId, signal) =>
  request(`${ROOT}/jobs/${jobId}/conversation-audio/${chapterId}/lines/${lineId}/generate`,
          { method: "POST", signal });

export const retryConversationLine = (jobId, chapterId, lineId, signal) =>
  request(`${ROOT}/jobs/${jobId}/conversation-audio/${chapterId}/lines/${lineId}/retry`,
          { method: "POST", signal });

export const assembleConversationAudio = (jobId, chapterId, signal) =>
  request(`${ROOT}/jobs/${jobId}/conversation-audio/${chapterId}/assemble`,
          { method: "POST", signal });
