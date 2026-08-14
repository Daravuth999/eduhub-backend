/**
 * heroArtworkCache.js — offline-durable cache for Hero Artwork IMAGE BYTES,
 * one layer below the URL/version metadata that's already covered by the
 * whole-config stale-while-revalidate cache (swrCache.js, wired through
 * experienceConfigApi.js). That existing cache answers "what URL should I
 * show" surviving app close/reopen; this module answers the harder
 * question — making the actual pixels available when there is truly no
 * network at all, which a cached URL string alone can't do.
 *
 * Uses the browser's own Cache Storage API DIRECTLY (cache.put/match), no
 * service-worker fetch interception involved — a genuinely offline-durable
 * store, but deliberately NOT touching sw.js. sw.js's own cacheFirst JS
 * bundle strategy previously caused a real staleness incident investigated
 * this session (stale bundles surviving a rebuild) — extending that same
 * file's scope for an unrelated concern (images) is exactly the kind of
 * change most likely to reintroduce it, so this stays a separate, narrow,
 * low-risk primitive instead.
 */

const CACHE_NAME = "eduhub-hero-artwork-v1";

function cacheStorageAvailable() {
  return typeof caches !== "undefined";
}

/**
 * Returns a blob: object URL for a previously-cached artwork image, or
 * null if it was never cached (or Cache Storage isn't available in this
 * environment). Caller is responsible for eventually calling
 * URL.revokeObjectURL on the result once it's no longer displayed.
 */
export async function getCachedArtworkObjectUrl(url) {
  if (!url || !cacheStorageAvailable()) return null;
  try {
    const cache = await caches.open(CACHE_NAME);
    const match = await cache.match(url);
    if (!match) return null;
    const blob = await match.blob();
    return URL.createObjectURL(blob);
  } catch {
    return null;
  }
}

/**
 * Fetches and stores `url`'s response in the offline artwork cache if it
 * isn't already present. Never throws — a failed preload just means the
 * NEXT offline launch won't have this artwork cached, not a broken
 * current session (the network `<img src>` still renders normally today).
 * Returns true if the artwork is cached after this call (already-cached
 * or freshly cached), false otherwise.
 */
export async function preloadAndCacheArtwork(url) {
  if (!url || !cacheStorageAvailable()) return false;
  try {
    const cache = await caches.open(CACHE_NAME);
    const existing = await cache.match(url);
    if (existing) return true;
    const res = await fetch(url, { mode: "cors" });
    if (!res.ok) return false;
    await cache.put(url, res.clone());
    return true;
  } catch {
    return false;
  }
}

/**
 * Drops every cached entry except `currentUrl` (or all entries if
 * `currentUrl` is falsy) — called when the published artwork changes
 * (version bump) so an old, no-longer-referenced asset doesn't sit in
 * the cache forever. Best-effort; failures are silent.
 */
export async function clearStaleArtworkCache(currentUrl) {
  if (!cacheStorageAvailable()) return;
  try {
    const cache = await caches.open(CACHE_NAME);
    const keys = await cache.keys();
    await Promise.all(
      keys
        .filter((req) => req.url !== currentUrl)
        .map((req) => cache.delete(req)),
    );
  } catch {
    /* best effort */
  }
}

export default { getCachedArtworkObjectUrl, preloadAndCacheArtwork, clearStaleArtworkCache };
