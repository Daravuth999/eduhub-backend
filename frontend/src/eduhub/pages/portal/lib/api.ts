import type {
  StudentData,
  CommentItem,
  PerformanceHistoryItem,
  PointsTransfer,
  CouponResult,
  PointsLogin,
  SendPointsResult,
} from "../types";
import {
  secureGet,
  securePost,
  setSessionToken,
} from "../../../lib/secureClient";

/* -------------------------------------------------------------------------- */
/*  Google Apps Script endpoints — URLs preserved EXACTLY.                    */
/*                                                                            */
/*  Dual-mode API: every helper sends the classic studentId/id/password       */
/*  params (so the un-upgraded GAS keeps working) AND piggy-backs the         */
/*  sessionToken (so the secured GAS authenticates via token when deployed).  */
/* -------------------------------------------------------------------------- */

export const SCRIPT_URL =
  "https://script.google.com/macros/s/AKfycbw_hGdyYmWukTCzaZoxuKMv34mYpQMXd7JtSFzpMpRjGd947eM70u-a1xTUJYA894FwAQ/exec";

export const POINTS_BACKEND_URL =
  "https://script.google.com/macros/s/AKfycbzRktKyql2I_FbPESNRpCrFDlse-qNd9_Opv9si-g-j2lcanOUPP49IzcyA59lFqVycdA/exec";

/* ----------------------------- network events ---------------------------- */
type Listener = (event: "ok" | "fail") => void;
const listeners = new Set<Listener>();
export function onNetworkEvent(listener: Listener) {
  listeners.add(listener);
  return () => listeners.delete(listener);
}
function emit(event: "ok" | "fail") {
  listeners.forEach((l) => l(event));
}
function trackOk<T>(p: Promise<T>) {
  return p.then(
    (v) => { emit("ok"); return v; },
    (e) => { emit("fail"); throw e; },
  );
}

/* ------------------------ modern login (new backend) --------------------- */
/** Fires `action=login` against the Portal backend. On the secured backend
 *  this returns a sessionToken; on the legacy backend it will return
 *  something else (or nothing useful) — callers treat a non-token result as
 *  a no-op and continue with the classic flow. */
export async function portalLogin(studentId: string, password: string) {
  const body = new URLSearchParams({ action: "login", studentId, password });
  const res = await fetch(SCRIPT_URL, { method: "POST", body, redirect: "follow" });
  if (!res.ok) { emit("fail"); throw new Error("HTTP " + res.status); }
  let json: any = null;
  try { json = await res.json(); } catch { /* legacy backend may return HTML */ }
  if (json && json.success && json.sessionToken) setSessionToken(json.sessionToken);
  emit("ok");
  return (json || {}) as { success?: boolean; sessionToken?: string; role?: string; name?: string };
}

/* ----------------------------- public api map ---------------------------- */

export const api = {
  studentData(studentId: string) {
    return trackOk(
      secureGet(SCRIPT_URL, { action: "getStudentData", studentId })
    ) as Promise<StudentData>;
  },

  passwordHint(studentId: string) {
    return trackOk(
      secureGet(SCRIPT_URL, { action: "getPasswordHint", studentId })
    ) as Promise<{ hint?: string; error?: string }>;
  },

  validateCoupon(couponCode: string, studentId: string) {
    return trackOk(
      securePost(
        SCRIPT_URL,
        { action: "validateCoupon", studentId, couponCode },
        { requireNonce: true },
      ),
    ) as Promise<CouponResult>;
  },

  comments(studentId: string) {
    return trackOk(
      secureGet(SCRIPT_URL, { action: "getStudentComments", studentId })
    ) as Promise<CommentItem[]>;
  },

  history(studentId: string) {
    return trackOk(
      secureGet(SCRIPT_URL, { action: "getPerformanceHistory", studentId })
    ) as Promise<PerformanceHistoryItem[]>;
  },

  /* Points — note: `id`, NOT `studentId` (kept for legacy compat).
   *
   * v7.9.9 — DUAL-MODE (POST preferred, GET fallback).
   *   The upgraded PointsBackend routes both verbs through the same
   *   secureExecute pipeline, so POST keeps the password out of the
   *   URL (issue #8 in the audit). The pre-upgrade legacy backend,
   *   however, only accepts GET for the `login` action (`POST login`
   *   returns "Invalid POST action"). Between cutting the frontend
   *   release and the operator finishing the GAS re-deploys, the live
   *   backend may still be legacy — and in that window a POST-only
   *   `pointsLogin` returns nothing, so `portalPoints` stays 0 and the
   *   wallet pill shows 0 for every student.
   *
   *   Strategy:
   *     1) POST (body-encoded, password NOT in URL) — preferred,
   *        works against the upgraded backend.
   *     2) If POST doesn't return `success:true` with a numeric
   *        `points`, retry once via GET (classic legacy contract).
   *     3) Either way, if a `sessionToken` comes back we capture it.
   *
   *   This keeps the audit's "password off the URL" fix active on
   *   the upgraded backend while gracefully preserving wallet /
   *   purchase flows during the upgrade window. */
  async pointsLogin(id: string, password: string) {
    const parseMaybeJson = async (res: Response) => {
      try { return await res.json(); } catch { return null; }
    };

    // Attempt 1 — POST (password in body, not URL).
    try {
      const body = new URLSearchParams({
        action: "login",
        id,
        password,
        t: String(Date.now()),
      });
      const res = await fetch(POINTS_BACKEND_URL, {
        method: "POST",
        body,
        redirect: "follow",
      });
      if (res.ok) {
        const json: any = await parseMaybeJson(res);
        if (json && json.success && typeof json.points === "number") {
          if (json.sessionToken) setSessionToken(json.sessionToken);
          emit("ok");
          return json as PointsLogin;
        }
      }
    } catch { /* fall through to GET retry */ }

    // Attempt 2 — GET (legacy pre-upgrade backend).
    try {
      const u = new URL(POINTS_BACKEND_URL);
      u.searchParams.set("action", "login");
      u.searchParams.set("id", id);
      u.searchParams.set("password", password);
      u.searchParams.set("t", String(Date.now()));
      const res = await fetch(u.toString(), {
        method: "GET",
        redirect: "follow",
      });
      if (!res.ok) { emit("fail"); throw new Error("HTTP " + res.status); }
      const json: any = await parseMaybeJson(res);
      if (json && json.success && json.sessionToken) setSessionToken(json.sessionToken);
      emit("ok");
      return (json || {}) as PointsLogin;
    } catch (err) {
      emit("fail");
      throw err;
    }
  },

  recentTransfers(id: string) {
    return trackOk(
      secureGet(POINTS_BACKEND_URL, { action: "getRecentTransfers", id })
    ) as Promise<{ success: boolean; history?: PointsTransfer[] }>;
  },

  sendPoints(args: {
    id: string;
    password: string;
    receiverId: string;
    amount: number;
  }) {
    return trackOk(
      securePost(
        POINTS_BACKEND_URL,
        {
          action: "sendPoints",
          id: args.id,
          password: args.password,    // legacy backend uses this
          receiverId: args.receiverId,
          amount: args.amount,        // secured backend ignores client-side amount calc; uses token-derived sender
        },
        { requireNonce: true },
      ),
    ) as Promise<SendPointsResult>;
  },

  /**
   * v7.9.4 — Cross-device library unlock persistence.
   *
   * Appends the book slug to the student's `UnlockedBooks` column in the
   * Portal sheet so the purchase survives logout / device swap / IP change.
   * Backend stub ships in `gas-backend/LibraryBackend.Code.gs`; frontend
   * silently tolerates a `"Invalid action"` response (old deployments).
   */
  libraryUnlock(studentId: string, slug: string, password?: string) {
    return trackOk(
      securePost(
        SCRIPT_URL,
        {
          action: "libraryUnlock",
          studentId,
          id: studentId,
          password: password || "",
          slug,
        },
        { requireNonce: true },
      ),
    ) as Promise<{ success?: boolean; unlocked?: string[]; error?: string }>;
  },

  /**
   * v7.9.10 — Append a purchase row to the `Unlocks` tab of the Books
   * spreadsheet. Replaces the legacy Google Form path. Backed by the new
   * `unlockRecord` action in PortalBackend.Code.gs (see gas-backend/).
   * Frontend silently tolerates `"Invalid action"` from old deployments —
   * the caller has a Form-based fallback in unlocksService.js.
   */
  unlockRecord(studentId: string, slug: string, price: number = 0, password?: string) {
    return trackOk(
      securePost(
        SCRIPT_URL,
        {
          action: "unlockRecord",
          studentId,
          id: studentId,
          password: password || "",
          slug,
          price: String(price ?? 0),
        },
        { requireNonce: true },
      ),
    ) as Promise<{ success?: boolean; ok?: boolean; error?: string }>;
  },
};
