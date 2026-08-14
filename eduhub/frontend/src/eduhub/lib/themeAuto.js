/**
 * themeAuto.js — Auto day/night controller
 *                v17 (2026-06, EduHub Premium UI Reconstruction)
 *
 * v17 changes (backward-compatible — all previous exports preserved):
 *   • "auto" now resolves via Asia/Phnom_Penh local time
 *     (06:00–18:00 → light, 18:00–06:00 → dark). This is the new
 *     DEFAULT for every user (including first-ever boot). Users who
 *     prefer a fixed palette still get it by explicitly selecting
 *     light or dark via the ThemeToggle — explicit choice wins.
 *   • "auto-cambodia" remains accepted as a synonym of "auto" so
 *     stored preferences from v16 continue to behave identically.
 *   • Re-evaluates on mount, visibility change, focus, and every
 *     5 minutes so the auto flip lands promptly at 06:00 / 18:00.
 *   • Public exports preserved verbatim:
 *       - startThemeAuto()
 *       - setThemePreference(pref)   // "auto" | "auto-cambodia" | "light" | "dark"
 *       - getThemeMode()
 *       - getActiveTheme()
 *       - cycleThemePreference()     // 3-state cycle (auto → light → dark → auto)
 */

const KEY_MODE = "eduhub.themeMode";   // "auto" | "auto-cambodia" | "light" | "dark"
const KEY_USER = "eduhub.themePref";

const LIGHT_HOUR_START = 6;
const LIGHT_HOUR_END = 18; // exclusive

/** Cambodia-aware hour (Asia/Phnom_Penh = UTC+7, no DST). */
function cambodiaHour() {
  try {
    const fmt = new Intl.DateTimeFormat("en-US", {
      timeZone: "Asia/Phnom_Penh",
      hour: "2-digit",
      hour12: false,
    });
    const parts = fmt.formatToParts(new Date());
    const h = parts.find((p) => p.type === "hour");
    if (h) return parseInt(h.value, 10);
  } catch (_) {
    /* Intl/timezone unavailable — fall through to UTC+7 fallback */
  }
  const utcMs = Date.now() + new Date().getTimezoneOffset() * 60000;
  return new Date(utcMs + 7 * 3600 * 1000).getHours();
}

function autoCambodia() {
  const h = cambodiaHour();
  return h >= LIGHT_HOUR_START && h < LIGHT_HOUR_END ? "light" : "dark";
}

/** v17 — "auto" IS Cambodia-time auto. */
function autoTheme() {
  return autoCambodia();
}

function apply(theme) {
  const html = document.documentElement;
  html.setAttribute("data-theme", theme);
  if (theme === "dark") html.classList.add("dark");
  else html.classList.remove("dark");
  let meta = document.querySelector('meta[name="theme-color"]');
  if (!meta) {
    meta = document.createElement("meta");
    meta.name = "theme-color";
    document.head.appendChild(meta);
  }
  // v18 — dark now matches manifest.json background_color (#050010),
  // fixing the pre-existing install-splash ≠ runtime mismatch; light
  // matches the new neutral #FAFAFA body (cream retired).
  meta.content = theme === "dark" ? "#050010" : "#FAFAFA";
}

function resolve() {
  const mode = localStorage.getItem(KEY_MODE) || "auto";
  if (mode === "light" || mode === "dark") return mode;
  // "auto" and "auto-cambodia" both resolve via Cambodia local time.
  return autoTheme();
}

let timerId = null;

export function startThemeAuto() {
  apply(resolve());
  const reapply = () => apply(resolve());
  document.addEventListener("visibilitychange", () => {
    if (!document.hidden) reapply();
  });
  window.addEventListener("focus", reapply);
  if (timerId) clearInterval(timerId);
  timerId = setInterval(reapply, 5 * 60 * 1000); // every 5 min
}

export function setThemePreference(pref) {
  if (
    pref !== "auto" &&
    pref !== "auto-cambodia" &&
    pref !== "light" &&
    pref !== "dark"
  ) {
    pref = "auto";
  }
  localStorage.setItem(KEY_MODE, pref);
  localStorage.setItem(KEY_USER, "1");
  apply(resolve());
}

export function getThemeMode() {
  return localStorage.getItem(KEY_MODE) || "auto";
}

export function getActiveTheme() {
  return document.documentElement.getAttribute("data-theme") || "dark";
}

/** v17 — 3-state cycle (auto-cambodia is folded into "auto"). */
export function cycleThemePreference() {
  const cur = getThemeMode();
  const order = ["auto", "light", "dark"];
  // Treat legacy "auto-cambodia" as "auto" for cycling purposes.
  const idx = order.indexOf(cur === "auto-cambodia" ? "auto" : cur);
  const next = order[(idx + 1) % order.length] || "auto";
  setThemePreference(next);
  return next;
}
