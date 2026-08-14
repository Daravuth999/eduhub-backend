/**
 * haptics.js — EduHub cross-platform haptic feedback (Achievement Center Phase 1 scope).
 *
 * One semantic API, three platform paths:
 *   • Android / Chromium PWA → navigator.vibrate() patterns (official Vibration API)
 *   • iOS Safari / home-screen PWA (17.4+) → the native `<input type="checkbox" switch>`
 *     Taptic tick, triggered through a linked <label> click (the only web-reachable
 *     haptic on iOS — one fixed subtle tick, no patterns)
 *   • Everything else → silent no-op (never throws, never logs)
 *
 * Haptics are an ENHANCEMENT, never a dependency: every call is fire-and-forget.
 *
 * Two independent gates, both must allow:
 *   1. Student preference — localStorage, editable in Profile → Preferences.
 *   2. Global Author Studio switch — platform-config flag HAPTICS_ENABLED
 *      (published override > env var > default true), read once per session
 *      via GET /api/achievements/haptics and cached in sessionStorage.
 */
import { useCallback, useState } from "react";

const BASE = (process.env.REACT_APP_BACKEND_URL || "").replace(/\/$/, "");
const LS_TOKEN_KEY = "student_session_token";
const PREF_KEY = "eduhub_haptics_pref";        // "on" (default) | "off"
const FLAG_KEY = "eduhub_haptics_flag_v1";     // sessionStorage: "1" | "0"

/* ── student preference ─────────────────────────────────────────────── */
export function getHapticsPref() {
  try { return localStorage.getItem(PREF_KEY) !== "off"; } catch { return true; }
}
export function setHapticsPref(on) {
  try { localStorage.setItem(PREF_KEY, on ? "on" : "off"); } catch { /* private mode */ }
}

/* ── global Author Studio flag (HAPTICS_ENABLED) ────────────────────── */
let flagFetchStarted = false;

function cachedFlag() {
  try {
    const v = sessionStorage.getItem(FLAG_KEY);
    return v === null ? null : v === "1";
  } catch { return null; }
}

function refreshFlagOnce() {
  if (flagFetchStarted || !BASE) return;
  flagFetchStarted = true;
  let headers = {};
  try {
    const t = localStorage.getItem(LS_TOKEN_KEY);
    if (t) headers = { Authorization: `Bearer ${t}` };
  } catch { /* ignore */ }
  fetch(`${BASE}/api/achievements/haptics`, { credentials: "include", headers })
    .then((r) => (r.ok ? r.json() : null))
    .then((d) => {
      if (d && typeof d.enabled === "boolean") {
        try { sessionStorage.setItem(FLAG_KEY, d.enabled ? "1" : "0"); } catch { /* ignore */ }
      }
    })
    .catch(() => { /* fail-open: keep cached/default */ });
}

/* ── platform capability ────────────────────────────────────────────── */
const canVibrate = () =>
  typeof navigator !== "undefined" && typeof navigator.vibrate === "function";

function isIOS() {
  if (typeof navigator === "undefined") return false;
  const ua = navigator.userAgent || "";
  return /iP(hone|ad|od)/.test(ua)
    || (navigator.platform === "MacIntel" && navigator.maxTouchPoints > 1); // iPadOS
}

// WebKit exposes the `switch` IDL attribute on HTMLInputElement when the
// native switch (and its haptic) is supported — Safari 17.4+.
const iosSwitchSupported = () => {
  try { return isIOS() && "switch" in document.createElement("input"); } catch { return false; }
};

export const hapticsSupported = () => canVibrate() || iosSwitchSupported();

/* ── iOS hidden switch (lazy singleton) ─────────────────────────────── */
let iosLabel = null;

function ensureIosSwitch() {
  if (iosLabel || typeof document === "undefined") return iosLabel;
  const input = document.createElement("input");
  input.type = "checkbox";
  input.setAttribute("switch", "");
  input.id = "eduhub-haptic-switch";
  input.tabIndex = -1;
  const label = document.createElement("label");
  label.htmlFor = input.id;
  label.tabIndex = -1;
  const host = document.createElement("div");
  host.setAttribute("aria-hidden", "true");
  host.style.cssText =
    "position:fixed;width:1px;height:1px;overflow:hidden;clip-path:inset(50%);pointer-events:none;opacity:0;";
  host.appendChild(input);
  host.appendChild(label);
  document.body.appendChild(host);
  iosLabel = label;
  return iosLabel;
}

function iosTick() {
  try { ensureIosSwitch()?.click(); } catch { /* never throw */ }
}

/* ── core fire ──────────────────────────────────────────────────────── */
function fire(pattern, iosTicks) {
  try {
    if (!getHapticsPref()) return;
    if (cachedFlag() === false) return;   // Author Studio kill-switch
    refreshFlagOnce();                    // background refresh, non-blocking
    if (canVibrate()) {
      navigator.vibrate(pattern);
    } else if (iosSwitchSupported()) {
      iosTick();
      for (let i = 1; i < iosTicks; i += 1) setTimeout(iosTick, 130 * i);
    }
  } catch { /* haptics must never break a flow */ }
}

/* ── semantic API ───────────────────────────────────────────────────── */
export const haptic = {
  tick:      () => fire(10, 1),                       // light selection tick
  select:    () => fire(16, 1),                       // stronger single tap
  success:   () => fire([14, 70, 28], 2),             // reward credited
  celebrate: () => fire([20, 45, 20, 45, 48], 3),     // big celebratory moment
};

/* ── settings hook (Profile → Preferences) ──────────────────────────── */
export function useHaptics() {
  const [enabled, setEnabledState] = useState(getHapticsPref);
  const setEnabled = useCallback((on) => {
    setHapticsPref(on);
    setEnabledState(on);
    if (on) haptic.tick(); // instant physical confirmation
  }, []);
  return { enabled, setEnabled, supported: hapticsSupported() };
}
