// pwaUpdateController.js — production update-detection + safe-reload system.
//
// v1.9.0 (incident: installed PWA "reverts to old version" seconds after
// launch) — this file is now the SINGLE owner of the controllerchange →
// reload behaviour. The duplicate inline listener in public/index.html was
// removed; two independent listeners double-fired the reload on every SW
// activation, exactly during the flakiest fetch window (activate/claim
// churn), which is when the old SW's per-URL HTML cache could answer with
// a stale shell. Additional guards added here:
//   • sessionStorage single-reload latch (RELOAD_LATCH_KEY): at most ONE
//     update reload per 10s per tab — a controllerchange storm can never
//     reload-loop the app.
//   • iOS OAuth deferral (preserved verbatim from the index.html hotfix,
//     2026-05): never reload while #session_id= is in the URL hash — the
//     Studio callback must finish its single-use token exchange first.
//   • critical-operation guard (unchanged): a payment, top-up, or Speaking
//     Lab join in flight defers the reload until it completes.
import { hasCriticalOperationInFlight } from "./criticalOperationRegistry";
import { logDiag } from "./__pwaDiag"; // TEMPORARY — see __pwaDiag.js for removal

const UPDATE_CHECK_INTERVAL_MS = 15 * 60 * 1000; // 15 min floor
const CRITICAL_OP_POLL_MS = 2000;
const CRITICAL_OP_MAX_WAIT_MS = 2 * 60 * 1000; // never wait forever — 2 min safety valve
const OAUTH_POLL_MS = 250;
const OAUTH_MAX_WAIT_MS = 15 * 1000; // same 15s cap as the original hotfix
const RELOAD_LATCH_KEY = "__pwa_update_reload_ts";
const RELOAD_LATCH_WINDOW_MS = 10 * 1000;

let controllerInitialized = false;
let reloadScheduled = false;

function isOAuthCallbackPending() {
  try {
    return /(^|[#&])session_id=/.test(window.location.hash || "");
  } catch {
    return false;
  }
}

function reloadLatchRemainingMs() {
  try {
    const last = Number(sessionStorage.getItem(RELOAD_LATCH_KEY) || 0);
    if (!last) return 0;
    const remaining = RELOAD_LATCH_WINDOW_MS - (Date.now() - last);
    return remaining > 0 ? remaining : 0;
  } catch {
    return 0;
  }
}

function setReloadLatch() {
  try { sessionStorage.setItem(RELOAD_LATCH_KEY, String(Date.now())); } catch { /* ignore */ }
}

function scheduleReloadWhenSafe() {
  if (reloadScheduled) return;
  reloadScheduled = true;
  const criticalDeadline = Date.now() + CRITICAL_OP_MAX_WAIT_MS;
  const oauthDeadline = Date.now() + OAUTH_MAX_WAIT_MS;
  const attempt = () => {
    // Single-reload latch: never reload more than once per 10s window per
    // tab — DELAY (not drop) so a rapid double SW swap still ends on the
    // newest version without ever reload-looping.
    const latchWait = reloadLatchRemainingMs();
    if (latchWait > 0) {
      logDiag("update_reload_delayed_by_latch", { latchWait });
      setTimeout(attempt, latchWait + 250);
      return;
    }
    if (isOAuthCallbackPending() && Date.now() < oauthDeadline) {
      logDiag("update_reload_deferred_oauth_in_flight");
      setTimeout(attempt, OAUTH_POLL_MS);
      return;
    }
    const blocked = hasCriticalOperationInFlight();
    if (blocked && Date.now() < criticalDeadline) {
      logDiag("update_reload_deferred_critical_op_in_flight");
      setTimeout(attempt, CRITICAL_OP_POLL_MS);
      return;
    }
    logDiag("update_reload_firing", { forcedBySafetyValve: blocked });
    setReloadLatch();
    window.location.reload();
  };
  attempt();
}

function checkForUpdate(reg) {
  if (!reg) return;
  reg.update().then(() => {
    logDiag("update_check_completed");
  }).catch(() => { /* offline / transient — next trigger retries */ });
}

export function initPwaUpdateController() {
  if (controllerInitialized) return; // idempotent — safe if called twice
  controllerInitialized = true;
  if (!("serviceWorker" in navigator)) return;

  // First-ever install: the page that triggered it came straight from the
  // network and IS the freshest copy — claiming it needs no reload. Only a
  // controller HANDOVER (old SW → new SW) warrants one.
  let hadController = !!navigator.serviceWorker.controller;

  // The one thing that reliably makes the browser re-check /sw.js: always
  // register, even when a registration already exists. updateViaCache:'none'
  // guarantees the sw.js fetch itself bypasses the HTTP cache.
  navigator.serviceWorker.register("/sw.js", { updateViaCache: "none" }).then((reg) => {
    logDiag("update_controller_registered", {
      activeScriptURL: reg.active ? reg.active.scriptURL : null,
    });
    checkForUpdate(reg);

    const recheck = () => checkForUpdate(reg);
    document.addEventListener("visibilitychange", () => {
      if (document.visibilityState === "visible") recheck();
    });
    window.addEventListener("focus", recheck);
    window.addEventListener("online", recheck);
    window.addEventListener("pageshow", (e) => { if (e && e.persisted) recheck(); });
    setInterval(recheck, UPDATE_CHECK_INTERVAL_MS);
  }).catch(() => { /* registration unsupported/blocked — offline-first features degrade, not fatal */ });

  // Fires the instant a NEW worker takes control — this is the actual
  // signal that an update is ready to apply, regardless of what triggered
  // the browser to install it (our own update() calls, or its own
  // background check).
  navigator.serviceWorker.addEventListener("controllerchange", () => {
    if (!hadController) {
      hadController = true;
      logDiag("update_reload_skipped_first_install");
      return;
    }
    scheduleReloadWhenSafe();
  });
}
