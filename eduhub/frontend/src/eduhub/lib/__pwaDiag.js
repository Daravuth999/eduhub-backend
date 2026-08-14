// __pwaDiag.js — TEMPORARY diagnostic instrumentation for the installed-PWA
// stale-version investigation and for verifying the fix in
// pwaUpdateController.js actually works on real devices across real deploys.
//
// NOT FOR PRODUCTION LONG-TERM. Once a few real-device deploy cycles have
// confirmed the fix (controllerchange fires, the app reloads onto the new
// version, no critical operation is ever interrupted), delete:
//   - this file (__pwaDiag.js)
//   - its import + initPwaDiag() call in index.js
//   - the logDiag() calls in usePushNotifications.js
//   - the SW_DIAG broadcastDiag() calls + relay in public/sw.js
//   - the /__pwa-debug route (App.js) and PwaDebugPage.jsx
//   - the `import { logDiag } from "./__pwaDiag"` + logDiag(...) calls
//     inside pwaUpdateController.js specifically (NOT the rest of that
//     file — pwaUpdateController.js and criticalOperationRegistry.js are
//     the permanent fix and must stay)
//
// Design: every event is written to localStorage IMMEDIATELY (not just to
// React state), because the exact event we're hunting for may itself be a
// full page reload that would wipe any in-memory log. localStorage survives
// that. The log is capped so it can never grow unbounded on a device that's
// never opened the debug page.
//
// Timeline correlates BOTH sides of the app:
//   - page-side events (boot, registration reuse/fresh, controllerchange)
//   - service-worker-side events, relayed to the page via postMessage,
//     since the SW's own console is a separate devtools context most
//     students'/operators' phones can't reach.
const LOG_KEY = "__pwa_diag_log_v1";
const MAX_ENTRIES = 300;

export function logDiag(event, extra) {
  try {
    const raw = localStorage.getItem(LOG_KEY);
    const arr = raw ? JSON.parse(raw) : [];
    arr.push({
      ts: Date.now(),
      iso: new Date().toISOString(),
      event,
      ...extra,
    });
    while (arr.length > MAX_ENTRIES) arr.shift();
    localStorage.setItem(LOG_KEY, JSON.stringify(arr));
  } catch {
    /* localStorage unavailable / quota — diagnostic only, never throw */
  }
}

export function readDiagLog() {
  try {
    const raw = localStorage.getItem(LOG_KEY);
    return raw ? JSON.parse(raw) : [];
  } catch {
    return [];
  }
}

export function clearDiagLog() {
  try { localStorage.removeItem(LOG_KEY); } catch { /* ignore */ }
}

// Call once, at app boot. Captures the state at THIS load, plus wires the
// two listeners that catch events happening WHILE this session is open.
export function initPwaDiag() {
  const controller = navigator.serviceWorker && navigator.serviceWorker.controller;
  logDiag("app_boot", {
    href: window.location.href,
    controllerScriptURL: controller ? controller.scriptURL : null,
    controllerState: controller ? controller.state : null,
    visibilityState: document.visibilityState,
    displayModeStandalone:
      window.matchMedia && window.matchMedia("(display-mode: standalone)").matches,
  });

  if (!("serviceWorker" in navigator)) return;

  // Fires when a NEW service worker takes over control of this page.
  // If this fires mid-session, whatever runs next is running under a
  // DIFFERENT worker than the one that served the initial load.
  navigator.serviceWorker.addEventListener("controllerchange", () => {
    const c = navigator.serviceWorker.controller;
    logDiag("page_controllerchange", {
      href: window.location.href,
      newControllerScriptURL: c ? c.scriptURL : null,
    });
  });

  // Relay channel: the SW posts its own lifecycle events here so they land
  // in the SAME timeline as the page-side events above.
  navigator.serviceWorker.addEventListener("message", (event) => {
    const data = event && event.data;
    if (!data || data.type !== "SW_DIAG") return;
    logDiag(`sw_${data.event}`, {
      href: window.location.href,
      swVersion: data.swVersion,
      url: data.url,
      cacheName: data.cacheName,
      fromCache: data.fromCache,
    });
  });

  // Snapshot every registration's active/waiting/installing script + state,
  // right now, at boot. If an OLD worker is sitting in "waiting" this is
  // where it shows up.
  navigator.serviceWorker.getRegistrations().then((regs) => {
    logDiag("registrations_snapshot", {
      count: regs.length,
      regs: regs.map((r) => ({
        scope: r.scope,
        active: r.active ? { url: r.active.scriptURL, state: r.active.state } : null,
        waiting: r.waiting ? { url: r.waiting.scriptURL, state: r.waiting.state } : null,
        installing: r.installing ? { url: r.installing.scriptURL, state: r.installing.state } : null,
      })),
    });
  }).catch(() => {});
}
