/**
 * api.js — Voice Treasure student API client.
 *
 * Mirrors the existing student client convention (aiAssistantVoiceApi.js):
 *   - base = REACT_APP_BACKEND_URL
 *   - credentials: "include" on every call
 *   - Bearer header ONLY when a non-empty session token exists
 *   - for FormData, Content-Type is NOT set manually (browser sets boundary)
 *   - the GAS password is passed in the request body for entry/confirm only,
 *     used once server-side; never logged, never stored here.
 */
const BASE = (process.env.REACT_APP_BACKEND_URL || "").replace(/\/$/, "");
const LS_TOKEN_KEY = "student_session_token";

function authHeaders() {
  try {
    const t = localStorage.getItem(LS_TOKEN_KEY);
    return t ? { Authorization: `Bearer ${t}` } : {};
  } catch {
    return {};
  }
}

async function _json(path, { method = "GET", body } = {}) {
  const res = await fetch(`${BASE}${path}`, {
    method,
    credentials: "include",
    headers: { "Content-Type": "application/json", ...authHeaders() },
    body: body != null ? JSON.stringify(body) : undefined,
  });
  return _parse(res);
}

async function _form(path, formData) {
  // IMPORTANT: do not set Content-Type for FormData.
  const res = await fetch(`${BASE}${path}`, {
    method: "POST",
    credentials: "include",
    headers: { ...authHeaders() },
    body: formData,
  });
  return _parse(res);
}

async function _parse(res) {
  let data = null;
  try {
    data = await res.json();
  } catch {
    data = null;
  }
  if (!res.ok) {
    const err = new Error((data && data.detail) || `HTTP ${res.status}`);
    err.status = res.status;
    err.data = data;
    throw err;
  }
  return data;
}

export const getConfigPublic = () => _json("/api/voice-treasure/config-public");
export const getToday = () => _json("/api/voice-treasure/today");

/** Read-only preview: returns authoritative balance + sufficiency, no charge. */
export const entryPreview = ({ password }) =>
  _json("/api/voice-treasure/entry/confirm", { method: "POST", body: { password } });

/** Commit: at-most-once GAS debit. Echoes the offer for staleness checks. */
export const entryConfirm = ({ password, missionId, expectedCost }) =>
  _json("/api/voice-treasure/entry/confirm", {
    method: "POST",
    body: { password, confirm: true, mission_id: missionId, expected_cost: expectedCost },
  });

export const getEntry = (entryId) =>
  _json(`/api/voice-treasure/entry/${encodeURIComponent(entryId)}`);

export const getMissionImage = (missionId) =>
  _json(`/api/voice-treasure/mission/${encodeURIComponent(missionId)}/image`);

export const submitAttempt = ({ entryId, audioBlob, filename = "attempt.webm" }) => {
  const fd = new FormData();
  fd.append("entry_id", entryId);
  fd.append("audio", audioBlob, filename);
  return _form("/api/voice-treasure/submit-attempt", fd);
};

export const getAttempt = (attemptId) =>
  _json(`/api/voice-treasure/attempt/${encodeURIComponent(attemptId)}`);

// Reward / chest / collection / progress
export const claim = (attemptId) =>
  _json("/api/voice-treasure/claim", { method: "POST", body: { attempt_id: attemptId } });

export const getClaimStatus = (attemptId) =>
  _json(`/api/voice-treasure/claim/${encodeURIComponent(attemptId)}`);

export const getRewards = () => _json("/api/voice-treasure/rewards");
export const getCollection = () => _json("/api/voice-treasure/collection");
export const getProgress = () => _json("/api/voice-treasure/progress");

export default {
  getConfigPublic, getToday, entryPreview, entryConfirm,
  getEntry, getMissionImage, submitAttempt, getAttempt,
  claim, getClaimStatus, getRewards, getCollection, getProgress,
};
