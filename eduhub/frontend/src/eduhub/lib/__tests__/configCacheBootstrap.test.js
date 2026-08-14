/**
 * configCacheBootstrap.test.js — Dashboard Bootstrap change to
 * lib/config.js's loadCache(): the cached Sheets config (title,
 * announcements, etc.) is now returned regardless of CACHE_TTL age.
 * REFRESH_INTERVAL still governs how often useEduHubConfig re-fetches;
 * this only concerns whether the cache is ever hidden.
 */
import { loadCache, saveCache, CACHE_KEY } from "../config";

beforeEach(() => {
  localStorage.clear();
});

test("a cache far older than CACHE_TTL (5 min) is still returned, not null", () => {
  const ancientTs = Date.now() - 999 * 24 * 3600 * 1000;
  localStorage.setItem(CACHE_KEY, JSON.stringify({ ts: ancientTs, data: { title: "Old Real Title" } }));
  expect(loadCache()).toEqual({ title: "Old Real Title" });
});

test("saveCache followed by loadCache round-trips regardless of elapsed time", () => {
  saveCache({ title: "Fresh Title" });
  expect(loadCache()).toEqual({ title: "Fresh Title" });
});

test("no cache at all still returns null", () => {
  expect(loadCache()).toBeNull();
});

test("corrupt cache JSON never throws, returns null", () => {
  localStorage.setItem(CACHE_KEY, "{not json");
  expect(() => loadCache()).not.toThrow();
  expect(loadCache()).toBeNull();
});
