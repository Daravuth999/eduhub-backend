/**
 * videoLibraryApi.js — self-contained API client for the Video Factory
 * (Author Studio) and the Synchronization Review Studio.
 *
 * Follows bookFactoryApi.js's request()/auth-header convention exactly —
 * copied deliberately rather than imported, matching this codebase's own
 * established pattern of one small self-contained client per Studio
 * feature. All paths are /api-prefixed.
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

async function request(path, { method = "GET", body, signal, isFormData = false } = {}) {
  const headers = {};
  const tok = getToken();
  if (tok) headers.Authorization = `Bearer ${tok}`;
  const init = { method, credentials: "include", headers, signal };
  if (body !== undefined) {
    if (isFormData) {
      init.body = body; // browser sets multipart Content-Type + boundary
    } else {
      headers["Content-Type"] = "application/json";
      init.body = JSON.stringify(body);
    }
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

const ROOT = "/api/studio/video";

// ── Video Factory (admin) ───────────────────────────────────────────────
export async function listLessonsAdmin(status, signal) {
  const qs = status ? `?status=${encodeURIComponent(status)}` : "";
  const data = await request(`${ROOT}/lessons${qs}`, { signal });
  return (data && data.lessons) || [];
}

export async function createLesson(payload, signal) {
  const data = await request(`${ROOT}/lessons`, { method: "POST", body: payload, signal });
  return data && data.lesson;
}

export async function updateLesson(lessonId, payload, signal) {
  const data = await request(`${ROOT}/lessons/${encodeURIComponent(lessonId)}`, {
    method: "PATCH", body: payload, signal,
  });
  return data && data.lesson;
}

export async function publishLesson(lessonId, signal) {
  return updateLesson(lessonId, { status: "published" }, signal);
}

export async function unpublishLesson(lessonId, signal) {
  return updateLesson(lessonId, { status: "archived" }, signal);
}

/** Permanently removes a lesson. The backend refuses this (409) while the
 * lesson is published — unpublish first. Purchase/progress records are
 * retained server-side as the financial audit trail regardless. */
export async function deleteLesson(lessonId, signal) {
  return request(`${ROOT}/lessons/${encodeURIComponent(lessonId)}`, { method: "DELETE", signal });
}

/**
 * Uploads a lesson's video/audio with real progress reporting (XHR — fetch
 * still has no upload-progress events). The backend binds a syncId +
 * mediaRef AND automatically schedules the AI processing pipeline; poll
 * getPipeline() afterwards for transcription/analysis progress.
 */
export function uploadLessonMedia(lessonId, file, { onProgress } = {}) {
  return new Promise((resolve, reject) => {
    const xhr = new XMLHttpRequest();
    xhr.open("POST", url(`${ROOT}/lessons/${encodeURIComponent(lessonId)}/media`));
    const tok = getToken();
    if (tok) xhr.setRequestHeader("Authorization", `Bearer ${tok}`);
    xhr.withCredentials = true;
    xhr.upload.onprogress = (e) => {
      if (e.lengthComputable && onProgress) onProgress(e.loaded / e.total);
    };
    xhr.onload = () => {
      let data = null;
      try { data = JSON.parse(xhr.responseText); } catch { /* ignore */ }
      if (xhr.status >= 200 && xhr.status < 300) {
        resolve(data && data.lesson);
      } else {
        const err = new Error((data && data.detail) || `HTTP ${xhr.status}`);
        err.status = xhr.status;
        reject(err);
      }
    };
    xhr.onerror = () => reject(new Error("Network error during upload."));
    const form = new FormData();
    form.append("file", file);
    xhr.send(form);
  });
}

/** Uploads a lesson thumbnail image (jpeg/png/webp, ≤5 MB). */
export async function uploadThumbnail(lessonId, file, signal) {
  const form = new FormData();
  form.append("file", file);
  const data = await request(`${ROOT}/lessons/${encodeURIComponent(lessonId)}/thumbnail`, {
    method: "POST", body: form, isFormData: true, signal,
  });
  return data && data.lesson;
}

/** Removes a lesson's media (mediaRef + syncId + pipeline cleared). The
 * backend refuses (409) while the lesson is published. */
export async function deleteMedia(lessonId, signal) {
  const data = await request(`${ROOT}/lessons/${encodeURIComponent(lessonId)}/media`, {
    method: "DELETE", signal,
  });
  return data && data.lesson;
}

/** Production stats for one lesson — owners, revenue, learners,
 * completions, average progress, bookmarks. */
export async function getLessonStats(lessonId, signal) {
  const data = await request(`${ROOT}/lessons/${encodeURIComponent(lessonId)}/stats`, { signal });
  return data && data.stats;
}

// ── AI processing pipeline ──────────────────────────────────────────────
export async function getPipeline(lessonId, signal) {
  return request(`${ROOT}/lessons/${encodeURIComponent(lessonId)}/pipeline`, { signal });
}

export async function runPipeline(lessonId, signal) {
  return request(`${ROOT}/lessons/${encodeURIComponent(lessonId)}/pipeline/run`, {
    method: "POST", body: {}, signal,
  });
}

// ── Synchronization Review Studio ───────────────────────────────────────
export async function getSyncAdmin(syncId, signal) {
  const data = await request(`/api/studio/sync/${encodeURIComponent(syncId)}`, { signal });
  return data && data.sync;
}

/** Applies a batch of structural edit operations (edit_word,
 * set_word_timing, replace_sentence_text, split_sentence, merge_sentences,
 * set_sentence_speaker, rename_speaker). All-or-nothing server-side. */
export async function editSync(syncId, operations, signal) {
  const data = await request(`/api/studio/sync/${encodeURIComponent(syncId)}/edit`, {
    method: "POST", body: { operations }, signal,
  });
  return data && data.sync;
}

export async function transitionSyncReview(syncId, reviewStatus, extra = {}, signal) {
  const data = await request(`/api/studio/sync/${encodeURIComponent(syncId)}/review`, {
    method: "POST", body: { reviewStatus, ...extra }, signal,
  });
  return data && data.sync;
}

/** Review Studio undo — restores the most recent pre-edit snapshot. */
export async function undoSync(syncId, signal) {
  const data = await request(`/api/studio/sync/${encodeURIComponent(syncId)}/undo`, {
    method: "POST", body: {}, signal,
  });
  return data && data.sync;
}

/** Review Studio redo — reapplies the most recently undone state. */
export async function redoSync(syncId, signal) {
  const data = await request(`/api/studio/sync/${encodeURIComponent(syncId)}/redo`, {
    method: "POST", body: {}, signal,
  });
  return data && data.sync;
}

/** Approves a sync document, walking the required transition graph
 * (pending → in_review → approved) transparently. */
export async function approveSync(syncId, currentStatus, signal) {
  let status = currentStatus;
  if (status === "pending" || status === "rejected") {
    const doc = await transitionSyncReview(syncId, "in_review", {}, signal);
    status = doc.reviewStatus;
  }
  return transitionSyncReview(syncId, "approved", {}, signal);
}

export async function rejectSync(syncId, currentStatus, signal) {
  let status = currentStatus;
  if (status === "pending") {
    const doc = await transitionSyncReview(syncId, "in_review", {}, signal);
    status = doc.reviewStatus;
  }
  return transitionSyncReview(syncId, "rejected", {}, signal);
}

// ── AI Narration production engine ──────────────────────────────────────
// Reuses the SAME live ElevenLabs voice-listing route Book Factory already
// calls (/api/studio/voices, admin-gated, key never reaches the browser) —
// deliberately not duplicated as a video-specific endpoint.
export async function listVoices(signal) {
  const data = await request("/api/studio/voices", { signal });
  return (data && data.voices) || [];
}

/** Video Factory's Voice Production visibility/enabled flags — mirrors
 * bookFactoryApi.js's getStatus(), so Author Studio can stage/hide the AI
 * Narration production surface without deleting any code, exactly the way
 * Book Factory's own narration/conversation-audio automation is staged.
 * Always readable regardless of `enabled` (the backend never gates this
 * one route) so the Studio shell can decide what to render. */
export async function getVideoFactoryStatus(signal) {
  return request("/api/studio/video-factory/status", { signal });
}

export async function getNarration(lessonId, signal) {
  const data = await request(`${ROOT}/lessons/${encodeURIComponent(lessonId)}/narration`, { signal });
  return data && data.job;
}

export async function runStoryAnalysis(lessonId, signal) {
  const data = await request(`${ROOT}/lessons/${encodeURIComponent(lessonId)}/narration/story-analysis/run`, {
    method: "POST", body: {}, signal,
  });
  return data && data.job;
}

export async function runScriptBlueprint(lessonId, signal) {
  const data = await request(`${ROOT}/lessons/${encodeURIComponent(lessonId)}/narration/script-blueprint/run`, {
    method: "POST", body: {}, signal,
  });
  return data && data.job;
}

/** Admin correction pass over the Gemini-drafted script — full scenes
 * array replace, validated server-side against the known scene ids. */
export async function editScriptBlueprint(lessonId, scenes, signal) {
  const data = await request(`${ROOT}/lessons/${encodeURIComponent(lessonId)}/narration/script-blueprint`, {
    method: "PATCH", body: { scenes }, signal,
  });
  return data && data.job;
}

/** role (e.g. "Narrator", "Emma") -> ElevenLabs voiceId. Admin assignment
 * always wins over auto/round-robin defaults and is preserved across
 * regenerations. */
export async function setVoiceAssignments(lessonId, assignments, signal) {
  const data = await request(`${ROOT}/lessons/${encodeURIComponent(lessonId)}/narration/voice-assignments`, {
    method: "PUT", body: { assignments }, signal,
  });
  return data && data.job;
}

/** Generates one line's audio. Cost-safe: a no-op if already completed —
 * use resetLineVoice first to force a genuine regeneration. */
export async function generateLineVoice(lessonId, sceneId, lineId, signal) {
  const data = await request(
    `${ROOT}/lessons/${encodeURIComponent(lessonId)}/narration/voice-production/${encodeURIComponent(sceneId)}/${encodeURIComponent(lineId)}/generate`,
    { method: "POST", body: {}, signal },
  );
  return data && data.job;
}

/** Explicit, admin-confirmed reset — the only way a completed line can be
 * regenerated. Always costs a fresh ElevenLabs call once re-triggered. */
export async function resetLineVoice(lessonId, sceneId, lineId, signal) {
  const data = await request(
    `${ROOT}/lessons/${encodeURIComponent(lessonId)}/narration/voice-production/${encodeURIComponent(sceneId)}/${encodeURIComponent(lineId)}/reset`,
    { method: "POST", body: {}, signal },
  );
  return data && data.job;
}

/** Stitches every completed line into one additive narration track and
 * creates its canonical sync document. Requires every line completed. */
export async function assembleNarration(lessonId, signal) {
  const data = await request(`${ROOT}/lessons/${encodeURIComponent(lessonId)}/narration/assemble`, {
    method: "POST", body: {}, signal,
  });
  return data && data.job;
}

/** Generates ONE ElevenLabs Sound Effects asset for a scene, sourced from
 * Gemini's own audioObservations.sfx description for that scene — never an
 * invented sound. Cost-safe: a no-op if already generated for this scene. */
export async function generateSceneSfx(lessonId, sceneId, signal) {
  const data = await request(
    `${ROOT}/lessons/${encodeURIComponent(lessonId)}/narration/sfx/${encodeURIComponent(sceneId)}/generate`,
    { method: "POST", body: {}, signal },
  );
  return data && data.job;
}

/** Read-only structured reconstruction of the production timeline (narrator/
 * dialogue lines with real cumulative offsets once generated, SFX assets,
 * and the current source-audio treatment) — never a second source of truth. */
export async function getNarrationTimeline(lessonId, signal) {
  const data = await request(`${ROOT}/lessons/${encodeURIComponent(lessonId)}/narration/timeline`, { signal });
  return data && data.timeline;
}

/** How the ORIGINAL video's audio track is handled at render time: "mute"
 * (replace it entirely — the default), "duck" (keep it faint under the
 * narration), or "preserve" (keep it near-full alongside the narration).
 * Whole-track only — this stack has no audio source-separation capability
 * to act on a per-layer basis. Takes effect on the NEXT render, not
 * retroactively. */
export async function setSourceAudioTreatment(lessonId, treatment, signal) {
  const data = await request(`${ROOT}/lessons/${encodeURIComponent(lessonId)}/narration/source-audio-treatment`, {
    method: "PUT", body: { treatment }, signal,
  });
  return data && data.job;
}

/** Physically embeds the approved narration audio into the original video
 * (server-side ffmpeg mux — REPLACE mode) and stores the result as a new
 * master MP4. Requires assembly to be complete first. Cost-safe: a no-op
 * if a master was already rendered. May fail terminally if the backend
 * environment has no ffmpeg available — never fakes success. */
export async function renderNarrationMaster(lessonId, signal) {
  const data = await request(`${ROOT}/lessons/${encodeURIComponent(lessonId)}/narration/render`, {
    method: "POST", body: {}, signal,
  });
  return data && data.job;
}

/** The explicit human-approval gate — students see nothing until this is
 * called, regardless of how complete the assembled track is. */
export async function publishNarration(lessonId, signal) {
  const data = await request(`${ROOT}/lessons/${encodeURIComponent(lessonId)}/narration/publish`, {
    method: "POST", body: {}, signal,
  });
  return data && data.job;
}

/** Reversible — pulls the narration track back from students without
 * discarding any generated work. */
export async function unpublishNarration(lessonId, signal) {
  const data = await request(`${ROOT}/lessons/${encodeURIComponent(lessonId)}/narration/unpublish`, {
    method: "POST", body: {}, signal,
  });
  return data && data.job;
}

// ── Purchase reconciliation (ambiguous GAS outcomes) ────────────────────
/** Every purchase currently parked in `reconcile` — an ambiguous GAS
 * outcome that is never auto-resolved. An admin must confirm whether the
 * debit actually applied before this queue can clear. */
export async function listReconcilePurchases(signal) {
  const data = await request("/api/admin/video/purchases/reconcile", { signal });
  return (data && data.purchases) || [];
}

/** Resolves one reconcile-state purchase. `resolution` is "succeeded"
 * (the debit DID apply — grant ownership) or "failed" (it did NOT apply —
 * safe to let the student retry). */
export async function resolveReconcile(studentId, lessonId, resolution, signal) {
  const data = await request(
    `/api/admin/video/purchases/${encodeURIComponent(studentId)}/${encodeURIComponent(lessonId)}/reconcile`,
    { method: "POST", body: { resolution }, signal },
  );
  return data && data.purchase;
}

/** Resolves a mediaRef (R2 URL or gridfs://sync_media/{filename}) into a
 * playable src — same single mapping the student client uses. */
export function resolveMediaSrc(mediaRef) {
  if (!mediaRef || typeof mediaRef !== "string") return "";
  if (mediaRef.startsWith("gridfs://sync_media/")) {
    const filename = mediaRef.slice("gridfs://sync_media/".length);
    return url(`/api/sync/media/${encodeURIComponent(filename)}`);
  }
  return mediaRef;
}
