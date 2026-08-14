/**
 * eduhub/lib/voucherApi.js — student-side Book Voucher API helpers.
 *
 * Source of truth = MongoDB through GET /api/student/vouchers. localStorage
 * is NEVER used for ownership, claim, used, expired, or discount value.
 *
 * Vouchers are ISSUED by the backend as part of the Login Reward campaign
 * claim (reward_kind = "voucher" | "points_voucher") — the claim response
 * carries the issued voucher, and this endpoint lists everything the
 * student owns. Redemption goes through the EXISTING /api/coupons flow.
 *
 * Uses the same student session as studentAuthService.js: cookie
 * credentials plus the mobile-Safari Bearer fallback from the
 * `student_session_token` localStorage key.
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
  try {
    data = await res.json();
  } catch {
    /* ignore */
  }
  if (!res.ok) {
    const err = new Error((data && data.detail) || `HTTP ${res.status}`);
    err.status = res.status;
    err.data = data;
    throw err;
  }
  return data;
}

/** Fetch the logged-in student's vouchers (backend computes live status). */
export function listStudentVouchers() {
  return fetchJson("/api/student/vouchers");
}

export default { listStudentVouchers };
