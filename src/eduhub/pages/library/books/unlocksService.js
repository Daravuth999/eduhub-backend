/**
 * unlocksService.js — v7.9.15 SURGICAL FIX (belt-and-braces)
 *
 *  Cross-device book ownership.
 *
 *  v7.9.15 vs v7.9.14:
 *   • HARDCODED FORM URL + ENTRY IDS as ultimate fallback defaults.
 *     If `.env` is missing/broken/inlined-as-empty (the real-world
 *     reason the form silently no-ops on stale Vercel bundles), the
 *     POST still fires. Operators can override via env vars at any
 *     time — the env values take priority over the defaults.
 *   • Multi-tab READ chain: configured tab → "Form responses 4" →
 *     "Form Responses 4" → default tab → first tab that matches
 *     unlock shape. Solves the "data lives in 'Form responses 4'
 *     not 'Unlocks'" bug — no Google-side change required.
 *   • Form POST always fires when configured (carried from v7.9.14).
 *   • Apps Script success requires explicit confirmation
 *     ({ ok:true, action:"unlockRecord" }) — carried from v7.9.14.
 *   • Loud diagnostic summary at every decision point.
 *
 * Sheet schema (any tab, headers in row 1):
 *     Timestamp | studentId | slug | price
 */

import { api as portalApi } from "../../portal/lib/api";

const TAG = "[unlocksService v7.9.15]";

/* ---------------------------------------------------------------------- *
 *  HARDCODED PRODUCTION FALLBACKS                                        *
 *                                                                        *
 *  These are the canonical Form URL + entry IDs for                      *
 *  app.daravuthenglish.online → spreadsheet 1DY8NSPc... → tab "Form     *
 *  responses 4". They are NOT secrets — Google Forms POST endpoints      *
 *  are public by design (anyone with the link can submit). Hardcoding   *
 *  them guarantees the cross-device write path works even when the      *
 *  deployed bundle was built before env vars were wired up.             *
 *                                                                        *
 *  Operators can override via .env at any time — env values win.        *
 * ---------------------------------------------------------------------- */
const DEFAULT_FORM_URL =
  "https://docs.google.com/forms/d/e/1FAIpQLSfajkiDkPGrCB_AAt_dLp1uUocRMsF12SYAebyrBMDrBAsUQQ/formResponse";
const DEFAULT_E_STUDENT = "entry.634357777";
const DEFAULT_E_SLUG    = "entry.2082036299";
const DEFAULT_E_PRICE   = "entry.1881286458";

const SHEET_ID  = process.env.REACT_APP_BOOKS_SHEET_ID || "";

const FORM_URL  = process.env.REACT_APP_UNLOCK_FORM_URL || DEFAULT_FORM_URL;

const E_STUDENT =
  process.env.REACT_APP_UNLOCK_ENTRY_STUDENT_ID ||
  process.env.REACT_APP_UNLOCK_FORM_ENTRY_STUDENT_ID ||
  DEFAULT_E_STUDENT;
const E_SLUG =
  process.env.REACT_APP_UNLOCK_ENTRY_SLUG ||
  process.env.REACT_APP_UNLOCK_FORM_ENTRY_SLUG ||
  DEFAULT_E_SLUG;
const E_PRICE =
  process.env.REACT_APP_UNLOCK_ENTRY_PRICE ||
  process.env.REACT_APP_UNLOCK_FORM_ENTRY_PRICE ||
  DEFAULT_E_PRICE;

const CONFIGURED_TAB = process.env.REACT_APP_UNLOCKS_SHEET_NAME || "";
const CACHE_KEY  = "eduhub_unlocks_cache_v1";
const CACHE_TTL  = 10_000; // 10 s

// v7.9.15 — multi-tab read order. We try each tab in turn and stop on
// the first one whose shape matches AND has at least one row. The
// `null` entry means "no `sheet=` param → default tab".
//
// Why the explicit "Form responses 4"? Google Form-linked spreadsheets
// auto-create a tab named after the form ("Form responses 4" in this
// deployment) and there is no public way to rename it without breaking
// the link. The default tab is whichever tab is left-most in the UI —
// fragile if the operator reorders. Trying the known name first is
// deterministic.
const READ_TABS_ORDER = [
  CONFIGURED_TAB,           // operator override (e.g. "Unlocks")
  "Unlocks",                // backwards compat
  "Form responses 4",       // production form-linked tab
  "Form Responses 4",       // case variant
  "Form responses 1",       // common defaults if operator re-creates form
  "Form Responses 1",
  null,                     // gviz default tab (whatever's left-most)
].filter((v, i, a) => v !== "" && a.indexOf(v) === i);

const gvizURL = (id, tab) => {
  const q = `tqx=out:json&headers=1&t=${Math.floor(Date.now()/CACHE_TTL)}`;
  return tab
    ? `https://docs.google.com/spreadsheets/d/${id}/gviz/tq?${q}&sheet=${encodeURIComponent(tab)}`
    : `https://docs.google.com/spreadsheets/d/${id}/gviz/tq?${q}`;
};

/* ------------------------------- cache --------------------------------- */
function loadCache() {
  try {
    const raw = localStorage.getItem(CACHE_KEY);
    if (!raw) return null;
    const { ts, byStudent } = JSON.parse(raw);
    if (Date.now() - ts < CACHE_TTL) return byStudent || {};
  } catch { /* ignore */ }
  return null;
}
function saveCache(byStudent) {
  try {
    localStorage.setItem(CACHE_KEY, JSON.stringify({ ts: Date.now(), byStudent }));
  } catch { /* ignore */ }
}

/* -------------------------------- READ --------------------------------- */
function parseGvizBody(text) {
  try {
    const json = JSON.parse(text.replace(/^[\s\S]*?setResponse\(/, "").replace(/\);?\s*$/, ""));
    const cols = (json.table?.cols || []).map((c) => String(c.label || c.id || "").trim().toLowerCase());
    const rows = json.table?.rows || [];
    return { cols, rows };
  } catch {
    return { cols: [], rows: [] };
  }
}

function hasUnlockShape(cols) {
  const hay = cols.join(",");
  return /\bstudentid\b/.test(hay) && /\bslug\b/.test(hay);
}

function rowsToByStudent(rows, cols) {
  const byStudent = {};
  for (const r of rows) {
    const obj = {};
    (r.c || []).forEach((cell, i) => {
      const k = cols[i]; if (!k) return;
      let v = cell ? cell.v : "";
      if (v === null || v === undefined) v = "";
      obj[k] = typeof v === "string" ? v.trim() : v;
    });
    const sid  = String(obj.studentid || obj.studentId || obj.id || "").trim();
    const slug = String(obj.slug || "").trim();
    if (!sid || !slug) continue;
    if (!byStudent[sid]) byStudent[sid] = [];
    if (!byStudent[sid].includes(slug)) byStudent[sid].push(slug);
  }
  return byStudent;
}

async function fetchAllUnlocks() {
  if (!SHEET_ID) return {};
  const triedTabs = [];
  let bestEmpty = null;       // shape OK but rows.length === 0
  let unionByStudent = {};    // merged result across tabs that have rows

  for (const tabName of READ_TABS_ORDER) {
    try {
      const r = await fetch(gvizURL(SHEET_ID, tabName));
      triedTabs.push({ tab: tabName || "(default)", httpOk: r.ok });
      if (!r.ok) continue;
      const body = await r.text();
      const { cols, rows } = parseGvizBody(body);
      if (!hasUnlockShape(cols)) continue;
      if (rows.length === 0) {
        bestEmpty = { tab: tabName, cols };
        continue;
      }
      // Merge — handles the case where rows are split across multiple
      // tabs (rare, but safe).
      const map = rowsToByStudent(rows, cols);
      Object.entries(map).forEach(([sid, slugs]) => {
        unionByStudent[sid] = unionByStudent[sid] || [];
        slugs.forEach((s) => {
          if (!unionByStudent[sid].includes(s)) unionByStudent[sid].push(s);
        });
      });
      // Stop after the first tab that yielded rows — common case is a
      // single tab holds everything (Form responses 4 in production).
      saveCache(unionByStudent);
      // eslint-disable-next-line no-console
      console.log(`${TAG} read OK from tab "${tabName || "(default)"}" — ${Object.keys(unionByStudent).length} student(s), ${rows.length} row(s)`);
      return unionByStudent;
    } catch (e) {
      triedTabs.push({ tab: tabName || "(default)", error: String(e?.message || e) });
    }
  }

  // No tab returned rows. If we saw a shape-correct empty tab, it's
  // legitimate (just no purchases yet). Otherwise log a warning so
  // the operator can investigate.
  if (!bestEmpty) {
    console.warn(`${TAG} read found NO tab with unlock shape — tried`, triedTabs);
  }
  saveCache(unionByStudent); // empty-but-fresh cache so we don't keep retrying for 10 s
  return unionByStudent;
}

export async function fetchUnlocksForStudent(studentId) {
  if (!studentId) return [];
  const cached = loadCache();
  const map = cached || (await fetchAllUnlocks());
  return map[String(studentId).trim()] || [];
}

/* -------------------------------- WRITE -------------------------------- */
/**
 * v7.9.14+ — Dual-channel write. Both fire in parallel; Form POST is
 * NOT gated by Apps Script success.
 *
 * Returns a structured diagnostic summary (see appsScript / form fields).
 */
export async function recordUnlock(studentId, slug, price = 0, password = "") {
  const summary = {
    version: "v7.9.15",
    studentId: String(studentId || ""),
    slug: String(slug || ""),
    price: Number(price) || 0,
    env: {
      hasFormUrl: !!FORM_URL,
      hasEStudent: !!E_STUDENT,
      hasESlug: !!E_SLUG,
      hasEPrice: !!E_PRICE,
      formUrlPreview: FORM_URL ? FORM_URL.slice(0, 56) + "…" : "",
      eStudent: E_STUDENT,
      eSlug: E_SLUG,
      ePrice: E_PRICE,
      usedDefaults: {
        formUrl: !process.env.REACT_APP_UNLOCK_FORM_URL,
        student: !(process.env.REACT_APP_UNLOCK_ENTRY_STUDENT_ID ||
                   process.env.REACT_APP_UNLOCK_FORM_ENTRY_STUDENT_ID),
        slug: !(process.env.REACT_APP_UNLOCK_ENTRY_SLUG ||
                process.env.REACT_APP_UNLOCK_FORM_ENTRY_SLUG),
        price: !(process.env.REACT_APP_UNLOCK_ENTRY_PRICE ||
                 process.env.REACT_APP_UNLOCK_FORM_ENTRY_PRICE),
      },
    },
    appsScript: { attempted: false, ok: false, response: null, error: null },
    form:       { attempted: false, posted: false, error: null },
    localCachePrimed: false,
  };

  if (!studentId || !slug) {
    console.warn(`${TAG} aborted — missing studentId or slug`, summary);
    return summary;
  }

  // ---- Channel A: Apps Script unlockRecord (fire-and-don't-trust) ----
  if (typeof portalApi.unlockRecord === "function") {
    summary.appsScript.attempted = true;
    try {
      const res = await portalApi.unlockRecord(studentId, slug, price, password);
      summary.appsScript.response = res || null;
      const ok =
        (res && res.ok === true && res.action === "unlockRecord") ||
        (res && res.success === true && Array.isArray(res.unlocked));
      summary.appsScript.ok = !!ok;
    } catch (e) {
      summary.appsScript.error = (e && e.message) || String(e);
    }
  }

  // ---- Channel B: Google Form (ALWAYS fires when configured) ----
  if (FORM_URL && E_STUDENT && E_SLUG) {
    summary.form.attempted = true;
    try {
      const fd = new FormData();
      fd.append(E_STUDENT, String(studentId));
      fd.append(E_SLUG,    String(slug));
      if (E_PRICE) fd.append(E_PRICE, String(price ?? 0));
      await fetch(FORM_URL, { method: "POST", mode: "no-cors", body: fd });
      summary.form.posted = true;
    } catch (e) {
      summary.form.error = (e && e.message) || String(e);
      console.warn(`${TAG} form fallback failed`, e);
    }
  }

  // ---- Optimistic cache prime ----
  try {
    const cached = loadCache() || {};
    const sid = String(studentId).trim();
    cached[sid] = cached[sid] || [];
    if (!cached[sid].includes(slug)) cached[sid].push(slug);
    saveCache(cached);
    summary.localCachePrimed = true;
  } catch { /* ignore */ }

  if (summary.appsScript.error || summary.form.error || (!summary.appsScript.ok && !summary.form.posted)) {
    console.warn(`${TAG} write summary (with errors)`, summary);
  } else {
    // eslint-disable-next-line no-console
    console.log(`${TAG} write summary`, summary);
  }

  return summary;
}

export const unlocksMeta = {
  version: "v7.9.15",
  configured: !!SHEET_ID,
  hasFormFallback: !!(FORM_URL && E_STUDENT && E_SLUG),
  envSnapshot: {
    hasFormUrl: !!FORM_URL,
    hasEStudent: !!E_STUDENT,
    hasESlug: !!E_SLUG,
    hasEPrice: !!E_PRICE,
  },
  tabsTriedInOrder: READ_TABS_ORDER.map((t) => t || "(default)"),
};
