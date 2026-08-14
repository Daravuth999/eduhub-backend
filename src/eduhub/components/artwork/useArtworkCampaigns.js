/**
 * useArtworkCampaigns.js — fetch live artwork campaigns for one placement.
 *
 * v1.0.3 — Dashboard Bootstrap / true stale-while-revalidate:
 *   • localStorage cache (keyed by placement) — survives app close/reopen.
 *     Cached campaigns are shown for as long as they exist, regardless of
 *     age — staleness never hides content, it only means "the background
 *     fetch below might update this." (Earlier v1.0.2 dropped the cache
 *     after a 10-minute TTL and fell back to an empty/loading state even
 *     though the last-known campaigns were still perfectly valid to show;
 *     that's exactly the flash this hook exists to avoid.)
 *   • Module-level in-memory cache — zero re-fetch on component remount within session
 *   • Background fetch on every mount updates the cache only on API success
 *     (failure keeps whatever is already shown, never blanks)
 *   • In-flight dedup — N placements mounting at once share one request per placement
 *   • Image preloading — image_url + fallback_url are pre-fetched by the browser
 *     after the first successful API response so images appear instantly on render
 */
import { useEffect, useState } from "react";

/* eslint-disable no-undef */
const BASE = process.env.REACT_APP_BACKEND_URL || "";
/* eslint-enable no-undef */

// ── Cache constants ──────────────────────────────────────────────────────────
const LS_KEY = (p) => `eduhub_aw1_${p}`;

// ── Module-level stores (survive component unmount / remount) ────────────────
/** In-memory cache: placement → { campaigns[], ts } */
const memCache = new Map();

/** In-flight dedup: placement → Promise<campaign[]|null> */
const inFlight = new Map();

// ── Helpers ──────────────────────────────────────────────────────────────────
function readLS(placement) {
  try {
    const raw = localStorage.getItem(LS_KEY(placement));
    if (!raw) return null;
    const { campaigns } = JSON.parse(raw);
    if (!Array.isArray(campaigns)) return null;
    return campaigns;
  } catch {
    return null;
  }
}

function writeLS(placement, campaigns) {
  try {
    localStorage.setItem(LS_KEY(placement), JSON.stringify({ campaigns, ts: Date.now() }));
  } catch { /* quota exceeded — silently skip */ }
}

function preloadImages(campaigns) {
  for (const c of campaigns) {
    if (c.image_url)    new Image().src = c.image_url;
    if (c.fallback_url) new Image().src = c.fallback_url;
  }
}

/** Returns cached campaigns (mem > localStorage > null), updates mem cache as side-effect. */
function seedCampaigns(placement) {
  const mem = memCache.get(placement);
  if (mem) return mem.campaigns;
  const ls = readLS(placement);
  if (ls) {
    // Promote to mem cache so subsequent mounts in the same session are instant.
    memCache.set(placement, { campaigns: ls, ts: Date.now() });
    return ls;
  }
  return null;
}

/**
 * Fetch campaigns from the public API.
 * Returns campaign[] on success, null on any error (network, parse, non-ok shape).
 * Deduplicates concurrent calls for the same placement.
 */
async function fetchCampaigns(placement) {
  if (inFlight.has(placement)) return inFlight.get(placement);

  const promise = (async () => {
    try {
      const url = `${BASE.replace(/\/$/, "")}/api/artwork-campaigns/active?placement=${encodeURIComponent(placement)}`;
      const res = await fetch(url, { credentials: "omit" });
      const data = await res.json();
      if (data && data.ok && Array.isArray(data.campaigns)) {
        const { campaigns } = data;
        memCache.set(placement, { campaigns, ts: Date.now() });
        writeLS(placement, campaigns);
        preloadImages(campaigns);
        return campaigns;
      }
      return null; // API returned but shape unexpected — treat as soft failure
    } catch {
      return null; // network / parse error — treat as soft failure
    } finally {
      inFlight.delete(placement);
    }
  })();

  inFlight.set(placement, promise);
  return promise;
}

// ── Hook ─────────────────────────────────────────────────────────────────────
export default function useArtworkCampaigns(placement) {
  // Seed synchronously from cache so first render already has data.
  const seed = placement ? seedCampaigns(placement) : null;

  const [campaigns, setCampaigns] = useState(seed || []);
  // loading=false when we already have cached data to show; true only on cold first load.
  const [loading, setLoading] = useState(!seed);

  useEffect(() => {
    if (!placement) {
      setLoading(false);
      return;
    }
    let cancelled = false;

    fetchCampaigns(placement).then((result) => {
      if (cancelled) return;
      // Only overwrite state on success. Null (error) keeps whatever is already shown.
      if (result !== null) setCampaigns(result);
      setLoading(false);
    });

    return () => { cancelled = true; };
  }, [placement]);

  return { campaigns, loading };
}
