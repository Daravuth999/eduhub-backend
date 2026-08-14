/**
 * studioHomeApi.js — Studio OS command-center data aggregator.
 *
 * Every function here wraps an ENDPOINT/HELPER THAT ALREADY EXISTS and is
 * already used by its own tab — this file adds zero new backend routes. It
 * exists only to call several already-deployed reads once, from one place,
 * for Studio Home's cards.
 *
 * Two functions duplicate a small local fetch (payments dashboard, Live
 * Coach status) rather than importing across files, matching this
 * codebase's own established convention (see PaymentStudio.jsx's local
 * `apiFetch` and EduTalkLivePanel.jsx's local `apiGet` — both files
 * explicitly choose a duplicated inline fetch over a cross-file import).
 *
 * Every function fails silently (returns null / an empty shape) rather
 * than throwing — matching CLAUDE.md's "network calls fail silently for
 * non-critical popups" convention. A Home card whose data failed to load
 * renders an empty/quiet state, never an error that blocks the rest of
 * the dashboard.
 *
 * Deliberately NOT included, and why: Payments' own transaction LIST
 * (only its dashboard stats are reused), Attendance session-level detail
 * (only the existing at-risk aggregate is reused), and any "Teachers"
 * entity (this codebase has no data entity distinct from admin Studio
 * users — TeacherStudio manages STUDENTS, not a separate teacher record).
 */
import { getToken, listStudioBooks, listAiUsageLogs } from "./api";
import { getAtRisk } from "./attendanceAdminApi";
import { listPasswordResetRequests } from "../eduhub/auth/studentAuthService";

const BACKEND = process.env.REACT_APP_BACKEND_URL || "";

async function localFetch(path) {
  const url = BACKEND ? `${BACKEND.replace(/\/$/, "")}${path}` : path;
  const tok = getToken();
  const headers = { "Content-Type": "application/json" };
  if (tok) headers.Authorization = `Bearer ${tok}`;
  const r = await fetch(url, { credentials: "include", headers });
  const data = await r.json().catch(() => ({}));
  if (!r.ok) throw new Error(data.detail || `HTTP ${r.status}`);
  return data;
}

// Reframed from "students absent today" (no such signal exists) to what
// AttendanceStudio's own "Needs Encouragement" panel actually surfaces —
// students at/below the risk threshold. Real, already-used aggregate.
export async function getNeedsEncouragement() {
  try {
    const data = await getAtRisk();
    return { count: data?.students?.length || 0, threshold: data?.threshold ?? 70 };
  } catch {
    return null;
  }
}

// Same endpoint PaymentStudio's own Dashboard stats panel already calls.
export async function getPendingPayments() {
  try {
    const data = await localFetch("/api/payments/dashboard");
    return { count: data?.stats?.pending ?? 0 };
  } catch {
    return null;
  }
}

export async function getPendingPasswordResets() {
  try {
    const list = await listPasswordResetRequests();
    return { count: Array.isArray(list) ? list.length : 0 };
  } catch {
    return null;
  }
}

// AI Tools' own "Usage Logs" panel data, aggregated to "today" client-side
// (the endpoint itself has no date filter) — a real count, not a modeled
// "increased/decreased" trend, since a defensible trend would need a
// second, comparable historical window this endpoint doesn't expose.
export async function getAiUsageToday() {
  try {
    const res = await listAiUsageLogs({ limit: 100 });
    const logs = res?.logs || res?.items || (Array.isArray(res) ? res : []);
    const todayKey = new Date().toDateString();
    const count = logs.filter((l) => {
      const ts = l?.created_at || l?.timestamp || l?.ts;
      return ts && new Date(ts).toDateString() === todayKey;
    }).length;
    return { count, sampledFrom: logs.length };
  } catch {
    return null;
  }
}

// Same /api/admin/edutalk-live/config endpoint EduTalkLivePanel.jsx's own
// apiGet() calls — reads its `status` field only, never writes.
export async function getLiveCoachHealth() {
  try {
    const data = await localFetch("/api/admin/edutalk-live/config");
    const s = data?.status || {};
    const ready = !!(s.gemini_configured && s.websockets_lib_ok && s.points_helpers_ok);
    return { ready, status: s };
  } catch {
    return null;
  }
}

// Reframed from "recent publishing activity" to "publishing status" — the
// book list carries no created/updated timestamp anywhere in this
// codebase (verified: no updatedAt/publishedAt field is read by any
// existing Studio panel), so a true "recent" ordering isn't backed by
// real data. A live/draft count from the same list IS real and honest.
export async function getBookPublishingStatus() {
  try {
    const books = await listStudioBooks();
    const list = Array.isArray(books) ? books : books?.books || [];
    const live = list.filter((b) => b.published).length;
    return { live, draft: list.length - live, total: list.length };
  } catch {
    return null;
  }
}
