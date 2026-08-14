/**
 * PurchaseService — v7.9.13 (OWNERSHIP-FIX, single-channel)
 *
 * Real-time server-side point deduction for library books, plus durable
 * cross-device unlock recording.
 *
 * v7.9.12 changes vs v7.9.9:
 *   • STATIC import of unlocksService — eliminates the silent
 *     dynamic-import failure mode where a missing/late chunk on the
 *     deployed bundle would skip cross-device persistence entirely.
 *   • Cross-device write is fired BEFORE the function returns, with
 *     its diagnostic summary surfaced via console.log so the operator
 *     can verify a row was dispatched in production DevTools.
 *
 * Strategy (unchanged):
 *   1) sendPoints transfer to treasury (atomic server-side debit)
 *   2) re-read authoritative balance
 *   3) record unlock locally (per-device ledger)
 *   4) record unlock cross-device (triple-channel, see unlocksService)
 */

import { api as portalApi } from "../../portal/lib/api";
// v7.9.12 — STATIC import. The previous `await import("./unlocksService.js")`
// inside step 4 was wrapped in an empty `catch{}` and would silently no-op
// on chunk-load failures (Vercel cache, network), so paid purchases never
// hit the cross-device write path. Static import is bundled with this
// module and cannot fail at runtime.
import { recordUnlock } from "./unlocksService.js";

/* eslint-disable no-undef */
// v7.9.14 — Treasury wallet ID corrected: stu092 is the official library
// treasury (stu001 is a regular student wallet, points were accidentally
// being credited to a student instead of the treasury). Override is still
// honoured via REACT_APP_LIBRARY_TREASURY_ID for staging/preview deploys.
const TREASURY_ID = (
  process.env.REACT_APP_LIBRARY_TREASURY_ID ||
  "stu092"
).toString().trim();
/* eslint-enable no-undef */

const KEY_PREFIX = "eduhub_lib_unlocks_";
const TAG = "[purchaseService v7.9.13]";

function keyFor(studentId) {
  return KEY_PREFIX + String(studentId || "guest");
}

function readLedger(studentId) {
  try {
    const raw = localStorage.getItem(keyFor(studentId));
    if (!raw) return [];
    const arr = JSON.parse(raw);
    return Array.isArray(arr) ? arr : [];
  } catch {
    return [];
  }
}

function writeLedger(studentId, list) {
  try {
    localStorage.setItem(keyFor(studentId), JSON.stringify(list));
  } catch {
    /* private mode / quota — ignore */
  }
}

function readCrossDeviceUnlocks(hydratedStudent, studentId) {
  const out = new Set();
  if (hydratedStudent) {
    const raw =
      (hydratedStudent.UnlockedBooks ?? hydratedStudent.unlockedBooks ??
       hydratedStudent.Inventory ?? hydratedStudent.inventory ?? "").toString();
    if (raw) raw.split(/[,\n;|]+/).map(s => s.trim()).filter(Boolean).forEach(s => out.add(s));
  }
  try {
    const raw = localStorage.getItem("eduhub_unlocks_cache_v1");
    if (raw && studentId) {
      const { byStudent } = JSON.parse(raw) || {};
      const list = byStudent?.[String(studentId).trim()] || [];
      list.forEach(s => out.add(s));
    }
  } catch { /* ignore */ }
  return [...out];
}

export function isUnlocked(studentId, book, hydratedStudent) {
  if (!book) return false;
  const price = Number(book.price) || 0;
  if (price <= 0) return true;
  const remote = readCrossDeviceUnlocks(hydratedStudent, studentId);
  if (remote.includes(book.slug)) return true;
  const local = readLedger(studentId);
  return local.some(
    (e) => e && e.slug === book.slug && e.mode === "server"
  );
}

export function listUnlocks(studentId, hydratedStudent) {
  const remote = readCrossDeviceUnlocks(hydratedStudent, studentId).map((slug) => ({
    slug,
    source: "server",
  }));
  const local = readLedger(studentId);
  const seen = new Set(remote.map((r) => r.slug));
  for (const e of local) {
    if (!seen.has(e.slug)) {
      remote.push(e);
      seen.add(e.slug);
    }
  }
  return remote;
}

export const TREASURY = TREASURY_ID;
export const HAS_TREASURY = !!TREASURY_ID;

export async function purchaseBook({ studentId, password, book, portalPoints }) {
  if (!studentId || !book) {
    return { success: false, reason: "INVALID", message: "Missing input." };
  }
  if (!password) {
    return {
      success: false,
      reason: "NO_AUTH",
      message: "Please sign in again to complete this purchase.",
    };
  }
  if (isUnlocked(studentId, book)) {
    return { success: false, reason: "ALREADY_OWNED", message: "You already own this book." };
  }

  const price = Math.max(0, Math.floor(Number(book.price) || 0));

  // Free book — record locally, fire cross-device write, done.
  if (price <= 0) {
    const ledger = readLedger(studentId);
    ledger.push({
      slug: book.slug,
      price: 0,
      unlockedAt: new Date().toISOString(),
      mode: "free",
    });
    writeLedger(studentId, ledger);
    // Note: free books skip cross-device write (matches v7.9.9 behaviour).
    return { success: true, mode: "server", newBalance: Math.max(0, Math.floor(Number(portalPoints) || 0)), price: 0 };
  }

  // Live balance fetch (authoritative).
  let bal = Math.max(0, Math.floor(Number(portalPoints) || 0));
  try {
    const pre = await portalApi.pointsLogin(studentId, password);
    if (pre && pre.success && typeof pre.points === "number") {
      bal = Math.max(0, Math.floor(pre.points));
    }
  } catch { /* fall through to optimistic gate */ }

  if (bal < price) {
    return {
      success: false,
      reason: "INSUFFICIENT",
      price,
      balance: bal,
      message: `You need ${price - bal} more points to unlock this book.`,
    };
  }

  if (!TREASURY_ID) {
    return {
      success: false,
      reason: "NO_TREASURY",
      message:
        "Library treasury is not configured. Ask your admin to set REACT_APP_LIBRARY_TREASURY_ID.",
    };
  }
  if (studentId === TREASURY_ID) {
    return {
      success: false,
      reason: "SELF_TREASURY",
      message:
        "This account is configured as the Library treasury and cannot purchase books.",
    };
  }

  // 1) Send points to treasury (real, atomic, server-validated debit).
  let sendRes;
  try {
    sendRes = await portalApi.sendPoints({
      id: studentId,
      password,
      receiverId: TREASURY_ID,
      amount: price,
    });
  } catch (e) {
    console.warn(`${TAG} sendPoints network error`, e);
    return {
      success: false,
      reason: "SERVER_ERROR",
      message: "Could not reach the points server. Please try again.",
    };
  }
  if (!sendRes || !sendRes.success) {
    return {
      success: false,
      reason: "SERVER_ERROR",
      message:
        (sendRes && (sendRes.message || sendRes.msg || sendRes.error)) ||
        "The server rejected the transaction. Please try again.",
    };
  }

  // 2) Re-read the authoritative balance.
  let newBalance = Math.max(0, bal - price);
  try {
    const balRes = await portalApi.pointsLogin(studentId, password);
    if (balRes && balRes.success && typeof balRes.points === "number") {
      newBalance = balRes.points;
    }
  } catch { /* fall back to optimistic */ }

  // 3) Record locally.
  const ledger = readLedger(studentId);
  ledger.push({
    slug: book.slug,
    price,
    unlockedAt: new Date().toISOString(),
    mode: "server",
    treasury: TREASURY_ID,
  });
  writeLedger(studentId, ledger);

  // 4) Cross-device persistence — STATIC import, dual-channel writer.
  //    v7.9.12: STATIC import (no silent dynamic-import skip).
  //    v7.9.14: recordUnlock now returns a structured diagnostic summary.
  //            We mirror it here AND inspect it so QA can confirm at
  //            least one channel attempted to fire. If BOTH channels
  //            failed silently, surface a console.warn so production
  //            DevTools shows it red.
  try {
    const summary = await recordUnlock(studentId, book.slug, price, password);
    const anyAttempted =
      (summary && (summary.appsScript?.attempted || summary.form?.attempted));
    if (!anyAttempted) {
      console.warn(
        `${TAG} cross-device write made NO attempt — check env vars: ` +
        `REACT_APP_UNLOCK_FORM_URL / *_ENTRY_STUDENT_ID / *_ENTRY_SLUG`,
        summary
      );
    } else {
      // eslint-disable-next-line no-console
      console.log(`${TAG} cross-device write summary`, summary);
    }
  } catch (e) {
    console.warn(`${TAG} cross-device write threw (local ledger still authoritative on this device)`, e);
  }

  // 5) Best-effort Portal column dual-write (audit).
  try {
    await portalApi.libraryUnlock?.(studentId, book.slug, password);
  } catch { /* ignore — local ledger is source of truth on this device */ }

  return { success: true, mode: "server", newBalance, price };
}

export function availableBalance(studentId, portalPoints /* , catalog */) {
  return Math.max(0, Math.floor(Number(portalPoints) || 0));
}

export function localSpent() { return 0; }
