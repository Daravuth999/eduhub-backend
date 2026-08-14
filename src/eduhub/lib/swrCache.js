/**
 * swrCache.js — one shared localStorage-backed stale-while-revalidate
 * primitive for the Dashboard Bootstrap layer (see hooks/useDashboardBootstrap.js).
 *
 * True SWR semantics: cached data is returned for as long as it exists,
 * regardless of age. Staleness never hides content — it's the caller's
 * job to kick a background refresh (which every Dashboard resource hook
 * already does unconditionally on mount); this primitive only answers
 * "what did we last successfully see?" so first paint is never blank.
 *
 * Every Dashboard resource (Welcome Experience, Artwork Campaign, Activity
 * Feed, Announcements) reads/writes through this ONE implementation
 * instead of each hand-rolling its own localStorage cache — the platform
 * token-module precedent (one design/motion language, not independent
 * per-feature implementations) applied to caching.
 */

export function readSwrCache(key) {
  try {
    const raw = localStorage.getItem(key);
    if (!raw) return null;
    const parsed = JSON.parse(raw);
    if (!parsed || typeof parsed !== "object" || !("data" in parsed)) return null;
    return { data: parsed.data, ts: parsed.ts || 0 };
  } catch {
    return null;
  }
}

export function writeSwrCache(key, data) {
  try {
    localStorage.setItem(key, JSON.stringify({ ts: Date.now(), data }));
  } catch {
    /* quota exceeded / private mode — cache is a nice-to-have, never fatal */
  }
}

export function clearSwrCache(key) {
  try {
    localStorage.removeItem(key);
  } catch {
    /* ignore */
  }
}

export default { readSwrCache, writeSwrCache, clearSwrCache };
