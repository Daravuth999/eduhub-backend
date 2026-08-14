/**
 * aiAssistantVoiceApi.js — student-side helpers for the EduHub Speech Coach
 * (AI Assistant Voice Missions + Coach Rewards).
 *
 * v1.1.0 — Speech Delivery Intelligence. No call-shape change; the same
 * /upload-attempt and /analyze endpoints now return additional fields:
 *   • speech_score (0..100)
 *   • score_label
 *   • score_delta (integer or null)
 *   • score_breakdown { pace, clarity, structure, confidence }
 *   • improvement_tip
 *   • wpm, filler_pct
 *   • filler_count, filler_by_word
 *   • prev_score, retry_bonus_applied
 *   • score_method, limitation_notice
 * Consumers that ignore unknown fields keep working unchanged.
 *
 * Talks to the FastAPI routes registered by ``ai_assistant_voice_tools.py``:
 *
 *   GET   /api/ai-assistant/voice/config-public
 *   POST  /api/ai-assistant/voice/start-mission         JSON
 *   POST  /api/ai-assistant/voice/upload-attempt        multipart/form-data
 *   POST  /api/ai-assistant/voice/analyze               JSON
 *   GET   /api/ai-assistant/rewards/status              ?mission_id=...
 *   POST  /api/ai-assistant/rewards/claim               JSON
 *
 * Auth model mirrors ``aiAssistantApi.js``: cookie credentials by default
 * with a Bearer fallback for Mobile Safari ITP cases. No new env var, no
 * new dependency, and no service-worker/push-subscription change.
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

async function jsonRequest(path, init = {}) {
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
    err.code = data && data.detail;
    err.data = data;
    throw err;
  }
  return data;
}

async function formRequest(path, formData) {
  // NOTE: do NOT set Content-Type — the browser will set the multipart
  // boundary automatically. Setting it manually breaks the upload.
  const res = await fetch(`${BASE}${path}`, {
    method: "POST",
    credentials: "include",
    headers: { ...bearer() },
    body: formData,
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
    err.code = data && data.detail;
    err.data = data;
    throw err;
  }
  return data;
}

/** Get the safe student-facing voice/rewards config (no credentials). */
export function getVoiceConfig() {
  return jsonRequest("/api/ai-assistant/voice/config-public");
}

/** Start a new speech mission. mode is one of:
 *    speaking_challenge | pronunciation_drill | friday_class_prep | sentence_delivery
 */
export function startMission({ mode, prompt } = {}) {
  return jsonRequest("/api/ai-assistant/voice/start-mission", {
    method: "POST",
    body: JSON.stringify({ mode, prompt: prompt || null }),
  });
}

/** Upload a recorded voice attempt (multipart/form-data).
 *
 *  audioBlob is a `Blob` produced by MediaRecorder (audio/webm preferred).
 *  durationSeconds is the measured wall-clock duration of the recording.
 *  transcript is the browser Web Speech API transcript (may be empty).
 */
export function uploadAttempt({
  missionId,
  audioBlob,
  transcript = "",
  durationSeconds = 0,
  filename = "attempt.webm",
}) {
  const fd = new FormData();
  fd.append("mission_id", String(missionId || ""));
  fd.append("transcript", String(transcript || ""));
  fd.append("duration_seconds", String(durationSeconds || 0));
  fd.append("audio", audioBlob, filename);
  return formRequest("/api/ai-assistant/voice/upload-attempt", fd);
}

/** Ask the server to run Gemini transcript analysis on the latest attempt. */
export function analyzeAttempt({ missionId, attemptId } = {}) {
  return jsonRequest("/api/ai-assistant/voice/analyze", {
    method: "POST",
    body: JSON.stringify({
      mission_id: missionId,
      attempt_id: attemptId || null,
    }),
  });
}

/** Read reward eligibility / cap-usage for a specific mission. */
export function getRewardStatus(missionId) {
  const q = encodeURIComponent(String(missionId || ""));
  return jsonRequest(`/api/ai-assistant/rewards/status?mission_id=${q}`);
}

/** Claim the Coach Reward for a mission once it is server-verified eligible. */
export function claimReward({ missionId, idempotencyKey } = {}) {
  return jsonRequest("/api/ai-assistant/rewards/claim", {
    method: "POST",
    body: JSON.stringify({
      mission_id: missionId,
      idempotency_key: idempotencyKey || null,
    }),
  });
}

/** Pick a safe MediaRecorder MIME type by probing the browser. Returns
 *  { mimeType, extension } or null when the device does not support any
 *  safe audio MIME. Callers should hide the recorder when this returns
 *  null and fall back to text-only practice.
 */
export function pickSafeMimeType() {
  if (typeof window === "undefined") return null;
  const MR = window.MediaRecorder;
  if (!MR || typeof MR.isTypeSupported !== "function") return null;
  const candidates = [
    { mimeType: "audio/webm;codecs=opus", extension: "webm" },
    { mimeType: "audio/webm",             extension: "webm" },
    { mimeType: "audio/mp4",              extension: "m4a"  },
    { mimeType: "audio/ogg;codecs=opus",  extension: "ogg"  },
    { mimeType: "audio/ogg",              extension: "ogg"  },
  ];
  for (const c of candidates) {
    try {
      if (MR.isTypeSupported(c.mimeType)) return c;
    } catch {
      /* ignore */
    }
  }
  return null;
}
