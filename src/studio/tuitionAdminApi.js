/**
 * tuitionAdminApi.js — admin-side Tuition Studio API client.
 *
 * Mirrors studio/api.js and attendanceAdminApi.js auth pattern:
 * cookie credentials + studio_session_token_v1 Bearer header fallback
 * (required for Mobile Safari ITP which blocks 3rd-party cookies).
 *
 * All functions throw Error with a user-readable message on failure.
 * Callers show e.message; console.error logs the technical detail.
 * 401/403 responses surface a session-expired message automatically.
 */
const BASE = process.env.REACT_APP_BACKEND_URL; // eslint-disable-line no-undef
const TOKEN_KEY = "studio_session_token_v1";

function getToken() {
  try { return localStorage.getItem(TOKEN_KEY) || ""; } catch { return ""; }
}

function url(path) {
  if (!BASE) return path;
  return `${BASE.replace(/\/$/, "")}${path}`;
}

// Exported so components can fetch binary (PDF/PNG) responses directly —
// request() below always parses JSON, which a binary body isn't.
export { getToken, url };

async function request(path, { method = "GET", body } = {}) {
  const headers = {};
  const tok = getToken();
  if (tok) headers.Authorization = `Bearer ${tok}`;
  const init = { method, credentials: "include", headers };
  if (body !== undefined) {
    headers["Content-Type"] = "application/json";
    init.body = JSON.stringify(body);
  }
  const res = await fetch(url(path), init);
  let data = null;
  try { data = await res.json(); } catch { /* ignore */ }
  if (!res.ok) {
    if (res.status === 401 || res.status === 403) {
      throw Object.assign(new Error("Session expired. Please sign in to Author Studio again."), { status: res.status, data });
    }
    const detail = data?.detail;
    const message = typeof detail === "string"
      ? detail
      : Array.isArray(detail)
        ? detail.map((d) => d.msg || JSON.stringify(d)).join("; ")
        : detail
          ? JSON.stringify(detail)
          : `Unable to complete request (HTTP ${res.status}). Please try again.`;
    throw Object.assign(new Error(message), { status: res.status, data });
  }
  return data;
}

// ── Accounts ──────────────────────────────────────────────────────────────────
export const getTuitionAccounts = () =>
  request("/api/admin/tuition/accounts");

export const updateTuitionAccount = (studentId, payload) =>
  request(`/api/admin/tuition/accounts/${encodeURIComponent(studentId)}`, {
    method: "PATCH",
    body: payload,
  });

// ── Global Config ─────────────────────────────────────────────────────────────
export const getTuitionConfig = () =>
  request("/api/admin/tuition/config");

export const saveTuitionConfig = (payload) =>
  request("/api/admin/tuition/config", { method: "PUT", body: payload });

// ── Reminder Config ───────────────────────────────────────────────────────────
export const getReminderConfig = () =>
  request("/api/admin/tuition/reminder/config");

export const saveReminderConfig = (payload) =>
  request("/api/admin/tuition/reminder/config", { method: "PUT", body: payload });

// ── Manual Payment ────────────────────────────────────────────────────────────
export const recordManualPayment = (payload) =>
  request("/api/admin/tuition/manual-payment", { method: "POST", body: payload });

// ── Dashboard ─────────────────────────────────────────────────────────────────
export const getTuitionDashboard = () =>
  request("/api/admin/tuition/dashboard");

export const getTuitionReceipts = () =>
  request("/api/admin/tuition/receipts");

export const getMigrationStatus = () =>
  request("/api/admin/tuition/migration-status");

// ── Migration ─────────────────────────────────────────────────────────────────
export const runMigrationDryRun = () =>
  request("/api/admin/tuition/migration/dry-run", { method: "POST", body: {} });

export const runMigrationImport = () =>
  request("/api/admin/tuition/migration/import", { method: "POST", body: {} });

export const runTuitionCutover = (payload) =>
  request("/api/admin/tuition/cutover", { method: "POST", body: payload });

// ── Receipt Management (Persistent Tuition Receipt Engine) ─────────────────────
export const searchTuitionReceipts = (params = {}) => {
  const qs = new URLSearchParams(
    Object.fromEntries(Object.entries(params).filter(([, v]) => v !== "" && v != null)),
  ).toString();
  return request(`/api/admin/tuition/receipts/search${qs ? `?${qs}` : ""}`);
};

export const regenerateTuitionReceiptFile = (receiptId) =>
  request(`/api/admin/tuition/receipt/${encodeURIComponent(receiptId)}/regenerate`, { method: "POST" });

export const backfillInvoiceNumbers = () =>
  request("/api/admin/tuition/receipts/backfill-invoice-numbers", { method: "POST" });

export const getReceiptTemplateConfig = () =>
  request("/api/admin/tuition/receipt-template-config");

export const saveReceiptTemplateConfig = (payload) =>
  request("/api/admin/tuition/receipt-template-config", { method: "PUT", body: payload });
