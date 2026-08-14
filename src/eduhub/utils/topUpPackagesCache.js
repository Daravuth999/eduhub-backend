/**
 * topUpPackagesCache.js — Shared cache + in-flight dedupe for Top-Up packages
 * ===========================================================================
 * Source of truth for `GET /api/payments/packages/public`.
 *
 * Purpose (frontend-only):
 *   • Render the Top-Up modal instantly from a warm cache (no loading flash).
 *   • Guarantee that every modal-open also triggers ONE real background
 *     refresh, so Author Studio package changes surface immediately.
 *   • Deduplicate concurrent and rapid-repeat requests via a single
 *     shared in-flight promise.
 *   • Distinguish a network/API failure from a successful response that
 *     simply has zero active packages — so the modal can show a real
 *     retry button vs. a real empty state.
 *
 * Safety guarantees:
 *   • Never hardcodes packages — always reflects live backend values.
 *   • Never mutates / writes backend state.
 *   • Never bypasses verification, credit, wallet, receipt, or polling code.
 *   • Cached data is treated as "instant render only" — every modal open
 *     forces a network refresh and reconciles the rendered list.
 *
 * Public API:
 *   prefetchPackages()          → Promise (fire-and-forget; forced refresh)
 *   getCachedPackages()         → Package[] | null  (synchronous read)
 *   fetchPackages({force?})     → Promise<Package[]>
 *   refreshPackages()           → Promise<Package[]>  (alias: force=true)
 *   subscribePackages(fn)       → unsubscribe()
 *   getLastFetchError()         → Error | null
 */

const BACKEND = process.env.REACT_APP_BACKEND_URL || "";
const ENDPOINT = "/api/payments/packages/public";
// Soft TTL — used only as a hint by `fetchPackages({force:false})`. The
// modal always calls with force=true, so this TTL never blocks a refresh
// in the actual top-up flow.
const TTL_MS = 30 * 1000;

let _cache = null;          // last successful active-packages array
let _cachedAt = 0;          // timestamp of last successful fetch
let _inflight = null;       // shared in-flight promise (dedupes everything)
let _lastError = null;      // last fetch error (cleared on success)
const _subs = new Set();    // subscribers notified on every successful update

function _notify() {
  _subs.forEach((fn) => {
    try { fn(_cache); } catch (_e) { /* subscriber must not break cache */ }
  });
}

async function _rawFetch() {
  // Mirrors the modal's apiFetch contract for "/payments/packages/public":
  // public endpoint, no credentials, JSON.
  const r = await fetch(BACKEND + ENDPOINT, {
    credentials: "omit",
    headers: { "Content-Type": "application/json" },
  });
  const data = await r.json().catch(() => ({}));
  if (!r.ok) {
    const err = new Error(
      (data && data.detail && data.detail.message) ||
      (typeof data?.detail === "string" ? data.detail : "") ||
      `HTTP ${r.status}`,
    );
    err.status = r.status;
    throw err;
  }
  const active = ((data && data.packages) || []).filter((p) => p && p.active);
  return active;
}

/** Synchronous read of the last successful fetch. May be null or empty. */
export function getCachedPackages() {
  return _cache;
}

/** Last network/API error (cleared on next successful fetch). */
export function getLastFetchError() {
  return _lastError;
}

/**
 * Fetch packages.
 *   • If a request is already in flight, returns that SAME promise
 *     (true deduplication — no parallel duplicate calls, ever).
 *   • If `force` is false AND cache is fresh, resolves with cache.
 *   • If `force` is true (default for modal opens), always hits the
 *     network unless a fetch is already in flight.
 */
export function fetchPackages({ force = false } = {}) {
  if (_inflight) return _inflight;
  const fresh = _cache && Date.now() - _cachedAt < TTL_MS;
  if (!force && fresh) return Promise.resolve(_cache);

  _inflight = _rawFetch()
    .then((active) => {
      _cache = active;
      _cachedAt = Date.now();
      _lastError = null;
      _notify();
      return active;
    })
    .catch((err) => {
      _lastError = err;
      // Cache is intentionally NOT cleared on failure — callers may
      // continue to render the last known good list while the user retries.
      throw err;
    })
    .finally(() => {
      _inflight = null;
    });

  return _inflight;
}

/** Alias for clarity at call sites. */
export function refreshPackages() {
  return fetchPackages({ force: true });
}

/**
 * Fire-and-forget prefetch — forces a real background refresh.
 * Safe to call on every Library mount / Top-Up button mount: the shared
 * in-flight promise prevents duplicate network requests. Swallows errors;
 * the modal surfaces them via its retry UI when it actually opens.
 */
export function prefetchPackages() {
  return fetchPackages({ force: true }).catch(() => null);
}

/** Subscribe to successful cache updates. Returns an unsubscribe function. */
export function subscribePackages(fn) {
  _subs.add(fn);
  return () => _subs.delete(fn);
}
