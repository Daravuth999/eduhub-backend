/**
 * videoLibraryApi.js — student-facing API client for the Video Library.
 *
 * Independent from src/studio/videoFactory/videoLibraryApi.js (the admin
 * client) — different auth model (student session cookie + student Bearer
 * fallback, not the Studio admin bearer token), different base, matching
 * this codebase's established one-client-per-surface convention (see
 * bookFactoryApi.js's own header comment for the same reasoning applied
 * to Author Studio panels).
 *
 * Talks only to video_library_tools.py's /api/video/* student routes.
 * Never imports anything from the Books Library API surface
 * (src/eduhub/pages/library/books/*) — Video Library is an architecturally
 * independent product per explicit product direction.
 */
/* eslint-disable no-undef */
const BASE = process.env.REACT_APP_BACKEND_URL;
/* eslint-enable no-undef */

// Mobile Safari ITP fallback — same LS key and pattern every other
// student client in this codebase uses (achievementApi.js, attendance/api.js,
// studentAuthService.js's own _bearerHeaders()). Duplicated locally rather
// than imported, matching studentAuthService.js's own documented reasoning
// for the sibling admin key: the token is written once at login by
// studentAuthService.js and just needs to be read here. Without this,
// `/api/video/*` was cookie-only and 401'd in exactly the ITP-drops-cross-
// site-cookies scenario every other student route already guards against.
const LS_TOKEN_KEY = "student_session_token";

function authHeaders() {
  try {
    const t = localStorage.getItem(LS_TOKEN_KEY);
    return t ? { Authorization: `Bearer ${t}` } : {};
  } catch {
    return {};
  }
}

function url(path) {
  if (!BASE) return path;
  return `${BASE.replace(/\/$/, "")}${path}`;
}

async function request(path, { method = "GET", body, signal } = {}) {
  const headers = { ...authHeaders() };
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

const ROOT = "/api/video";

export async function listLessons({ category, difficulty, q } = {}, signal) {
  const params = new URLSearchParams();
  if (category) params.set("category", category);
  if (difficulty) params.set("difficulty", difficulty);
  if (q) params.set("q", q);
  const qs = params.toString() ? `?${params.toString()}` : "";
  const data = await request(`${ROOT}/lessons${qs}`, { signal });
  return (data && data.lessons) || [];
}

export async function getLesson(lessonId, signal) {
  const data = await request(`${ROOT}/lessons/${encodeURIComponent(lessonId)}`, { signal });
  return data && data.lesson;
}

/** Purchases a lesson. Mirrors the same student_id/password-per-request
 * pattern this codebase already uses everywhere a GAS wallet operation is
 * authorized (see purchaseService.js's purchaseBook, or Voice Treasure's
 * paid-entry flow) — the password authorizes ONE server-side debit and is
 * never stored. */
export async function purchaseLesson(lessonId, { password }, signal) {
  return request(`${ROOT}/lessons/${encodeURIComponent(lessonId)}/purchase`, {
    method: "POST", body: { password }, signal,
  });
}

export async function reportProgress(lessonId, { positionSec, durationSec }, signal) {
  const data = await request(`${ROOT}/lessons/${encodeURIComponent(lessonId)}/progress`, {
    method: "POST", body: { positionSec, durationSec }, signal,
  });
  return data && data.progress;
}

export async function listContinueWatching(signal) {
  const data = await request(`${ROOT}/progress/mine`, { signal });
  return (data && data.progress) || [];
}

/** Every progress record, newest-first (completed included) — powers the
 * dashboard's Recently Watched row. */
export async function listRecentlyWatched(signal) {
  const data = await request(`${ROOT}/progress/mine?all=1`, { signal });
  return (data && data.progress) || [];
}

/** Every purchase record for this student (all states, newest first) —
 * powers a "My Lessons" (purchased-only) view. */
export async function listMyPurchases(signal) {
  const data = await request(`${ROOT}/purchases/mine`, { signal });
  return (data && data.purchases) || [];
}

/** Backend-owned study notes (video_notes collection) — cross-device,
 * per (student, lesson). */
export async function getNote(lessonId, signal) {
  const data = await request(`${ROOT}/lessons/${encodeURIComponent(lessonId)}/notes`, { signal });
  return (data && data.note) || { lessonId, text: "" };
}

export async function saveNote(lessonId, text, signal) {
  const data = await request(`${ROOT}/lessons/${encodeURIComponent(lessonId)}/notes`, {
    method: "PUT", body: { text }, signal,
  });
  return data && data.note;
}

/** Toggles a saved/bookmarked lesson. Backend-owned (video_bookmarks
 * collection) — not the per-timestamp seek-markers VideoLessonPlayer
 * stores locally, which are a different concept (in-video chapter marks,
 * never sent to the server). */
export async function toggleBookmark(lessonId, signal) {
  const data = await request(`${ROOT}/lessons/${encodeURIComponent(lessonId)}/bookmark`, {
    method: "POST", signal,
  });
  return data;
}

export async function listBookmarks(signal) {
  const data = await request(`${ROOT}/bookmarks/mine`, { signal });
  return (data && data.bookmarks) || [];
}

/** Resolves a syncId's canonical synchronization document — the SAME
 * shared Universal Synchronization Engine endpoint Books uses
 * (GET /api/sync/{syncId}), never a Video-Library-specific duplicate. */
export async function getSyncDocument(syncId, signal) {
  if (!syncId) return null;
  try {
    const data = await request(`/api/sync/${encodeURIComponent(syncId)}`, { signal });
    return (data && data.sync) || null;
  } catch (e) {
    if (e.status === 404) return null; // not yet approved/aligned — honest empty state
    throw e;
  }
}

/**
 * Resolves a lesson's `mediaRef` into a playable <video>/<audio> src.
 * mediaRef is always one of exactly two shapes produced by the backend
 * (sync_studio_tools.py's create_sync_from_upload): a real R2 public URL,
 * or `gridfs://sync_media/{filename}` for the GridFS fallback path — this
 * function is the ONE place that maps the second shape to the real
 * streaming route, so the rest of the app never hand-builds that URL.
 */
export function resolveMediaSrc(mediaRef) {
  if (!mediaRef || typeof mediaRef !== "string") return "";
  if (mediaRef.startsWith("gridfs://sync_media/")) {
    const filename = mediaRef.slice("gridfs://sync_media/".length);
    return url(`/api/sync/media/${encodeURIComponent(filename)}`);
  }
  return mediaRef; // already a direct R2 URL
}

// ─────────────────────────────────────────────────────────────────────────
// Video Library Coupon — student code-entry redemption. Talks ONLY to the
// isolated /api/student/video-library/coupon/* routes
// (video_library_coupon_tools.py), mirroring edutalkLiveApi.js's
// validateLiveCoachCoupon/redeemLiveCoachCoupon exactly. Returns 503 with a
// friendly message while VIDEO_LIBRARY_COUPON_REDEMPTION_ENABLED is off
// (the default) — the caller treats that like "unavailable".
// ─────────────────────────────────────────────────────────────────────────
const COUPON_ROOT = "/api/student/video-library/coupon";

/** `{enabled: boolean}` — whether coupon redemption is switched on for
 * Video Library right now. Fails closed (enabled:false) on any error so a
 * flag-off backend or a transient network issue never renders the card. */
export async function getVideoLibraryCouponStatus(signal) {
  try {
    const data = await request(`${COUPON_ROOT}/status`, { signal });
    return { enabled: !!(data && data.enabled) };
  } catch {
    return { enabled: false };
  }
}

/** Validate a Video Library Coupon code without redeeming it. */
export function validateVideoLibraryCoupon(code, signal) {
  return request(`${COUPON_ROOT}/validate`, {
    method: "POST", body: { code }, signal,
  });
}

/** Redeem a Video Library Coupon code — credits GAS points via the backend
 * treasury pipeline (the same shared balance lesson purchases debit from).
 * Safe to retry: the backend never double-credits. */
export function redeemVideoLibraryCoupon(code, signal) {
  return request(`${COUPON_ROOT}/redeem`, {
    method: "POST", body: { code }, signal,
  });
}
