/**
 * useWorkflowMemory.js — Studio OS workflow memory.
 *
 * Purely additive, client-side, localStorage-backed. Tracks which tools an
 * admin actually uses so Studio Home can surface "recent" and "frequent"
 * tools and let an admin pin favorites — none of this touches routing,
 * auth, or any backend contract. `recordVisit(key)` is meant to be called
 * from the SAME `handleTabChange` every existing tab button already calls;
 * it never replaces or wraps that function's own behavior (draft snapshot,
 * tab state), it only observes the key after the fact.
 */
import { useCallback, useEffect, useState } from "react";

const STORAGE_KEY = "studio_workflow_memory_v1";
const MAX_RECENT = 8;

function readStore() {
  try {
    const raw = localStorage.getItem(STORAGE_KEY);
    const parsed = raw ? JSON.parse(raw) : null;
    return {
      recent: Array.isArray(parsed?.recent) ? parsed.recent : [],
      frequency: parsed?.frequency && typeof parsed.frequency === "object" ? parsed.frequency : {},
      favorites: Array.isArray(parsed?.favorites) ? parsed.favorites : [],
    };
  } catch {
    return { recent: [], frequency: {}, favorites: [] };
  }
}

function writeStore(store) {
  try {
    localStorage.setItem(STORAGE_KEY, JSON.stringify(store));
  } catch {
    /* storage unavailable — memory simply doesn't persist this session */
  }
}

// Product-polish pass — "operating workspace, not a dashboard": an admin
// returning to Studio should resume where they left off, the way an OS
// restores your last app, rather than always being forced through a
// landing screen first. `recent[0]` (from the SAME store `recordVisit`
// already writes to) IS "the last tab visited" — no new tracking needed.
// Returns null on a genuinely first-ever visit (nothing recorded yet),
// so the caller can fall back to Home exactly once, ever, per device.
export function getLastVisitedTab() {
  return readStore().recent[0] || null;
}

export default function useWorkflowMemory() {
  const [store, setStore] = useState(readStore);

  // Re-sync if workflow memory changes in another tab.
  useEffect(() => {
    const onStorage = (e) => {
      if (e.key === STORAGE_KEY) setStore(readStore());
    };
    window.addEventListener("storage", onStorage);
    return () => window.removeEventListener("storage", onStorage);
  }, []);

  const recordVisit = useCallback((key) => {
    if (!key || key === "home") return; // visiting Home itself isn't a "workflow"
    setStore((prev) => {
      const recent = [key, ...prev.recent.filter((k) => k !== key)].slice(0, MAX_RECENT);
      const frequency = { ...prev.frequency, [key]: (prev.frequency[key] || 0) + 1 };
      const next = { ...prev, recent, frequency };
      writeStore(next);
      return next;
    });
  }, []);

  const toggleFavorite = useCallback((key) => {
    setStore((prev) => {
      const has = prev.favorites.includes(key);
      const favorites = has ? prev.favorites.filter((k) => k !== key) : [...prev.favorites, key];
      const next = { ...prev, favorites };
      writeStore(next);
      return next;
    });
  }, []);

  const isFavorite = useCallback((key) => store.favorites.includes(key), [store.favorites]);

  const frequent = Object.entries(store.frequency)
    .sort((a, b) => b[1] - a[1])
    .slice(0, MAX_RECENT)
    .map(([key]) => key);

  return {
    recent: store.recent,
    frequent,
    favorites: store.favorites,
    recordVisit,
    toggleFavorite,
    isFavorite,
  };
}
