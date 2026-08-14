/**
 * CoverPrefetcher — warms the browser cache (and the service-worker
 * runtime cache) with every book cover the moment the student is
 * authenticated, so by the time they tap "Library" the images are
 * already local. No UI is rendered.
 *
 * Layered with the existing fixes it forms a 4-step defence against
 * cover-image flicker:
 *
 *   1. Stable React key in Bookshelf.jsx     — no mass remounts.
 *   2. SUCCESS_URL_CACHE in BookCard.jsx     — remounts skip dead variants.
 *   3. SW stale-while-revalidate (sw.js)     — second visit is instant.
 *   4. CoverPrefetcher (this file)           — first visit is instant too.
 *
 * Implementation notes:
 *   • Uses Image() not <img> — no DOM mutation, no layout reflow.
 *   • Throttled to PREFETCH_CONCURRENCY at a time so we don't saturate
 *     the network or trip Drive/Dropbox rate-limits.
 *   • Each fetch carries its own timeout — a stuck Drive request can't
 *     stall the queue.
 *   • Runs ONCE per logged-in identity per page lifetime (tracked by a
 *     ref, not state, so re-renders don't re-trigger).
 *   • Silent — never throws, never logs, never blocks auth.
 */

import { useEffect, useRef } from "react";
import { useAuth } from "../context/AuthContext";
import { getAllBooks } from "../pages/library/books/booksService";

const PREFETCH_CONCURRENCY = 4;
const PREFETCH_START_DELAY_MS = 250;
const PREFETCH_PER_IMAGE_TIMEOUT_MS = 8000;

export default function CoverPrefetcher() {
  const { isAuthenticated, student } = useAuth();
  const ranForRef = useRef(null);

  useEffect(() => {
    if (!isAuthenticated) return;
    const identity = student?.studentId || "anon";
    if (ranForRef.current === identity) return;
    ranForRef.current = identity;

    let cancelled = false;
    const timer = setTimeout(async () => {
      if (cancelled) return;
      try {
        const books = await getAllBooks({ isAuthenticated: true }).catch(() => []);
        if (cancelled || !Array.isArray(books)) return;
        const urls = books
          .map((b) => b && b.coverImage)
          .filter((u) => typeof u === "string" && u.length > 0);
        if (!urls.length) return;
        await prefetchInBatches(urls, PREFETCH_CONCURRENCY, () => cancelled);
      } catch {
        /* network / parse / quota — silent */
      }
    }, PREFETCH_START_DELAY_MS);

    return () => {
      cancelled = true;
      clearTimeout(timer);
    };
  }, [isAuthenticated, student?.studentId]);

  return null;
}

/**
 * Drains `urls` through `concurrency` parallel workers. Each worker
 * pulls the next index off a shared cursor — no batching gaps. Stops
 * the moment isCancelled() turns true.
 */
async function prefetchInBatches(urls, concurrency, isCancelled) {
  let cursor = 0;
  const workerCount = Math.min(concurrency, urls.length);
  const work = Array.from({ length: workerCount }, async () => {
    while (cursor < urls.length) {
      if (isCancelled()) return;
      const my = cursor++;
      await prefetchOne(urls[my]);
    }
  });
  await Promise.all(work);
}

/**
 * Fetches a single URL via an in-memory Image() so the browser caches
 * it. Resolves whether the load succeeds, fails, or times out — the
 * prefetcher must never reject, because there is no UI to surface
 * errors to.
 */
function prefetchOne(url) {
  return new Promise((resolve) => {
    if (!url) return resolve();
    let done = false;
    const finish = () => {
      if (done) return;
      done = true;
      resolve();
    };
    const img = new Image();
    img.decoding = "async";
    img.referrerPolicy = "no-referrer";
    const timer = setTimeout(finish, PREFETCH_PER_IMAGE_TIMEOUT_MS);
    img.onload = () => {
      clearTimeout(timer);
      finish();
    };
    img.onerror = () => {
      clearTimeout(timer);
      finish();
    };
    try {
      img.src = url;
    } catch {
      clearTimeout(timer);
      finish();
    }
  });
}
