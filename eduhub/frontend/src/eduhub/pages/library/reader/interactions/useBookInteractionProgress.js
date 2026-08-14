/**
 * useBookInteractionProgress.js — Signature Smart Interactive Book,
 * Checkpoint 1: two-layer (local cache + debounced server sync) progress
 * hook for the nine premium interaction block types.
 *
 * Cache key includes studentId + bookSlug + revision (never an anonymous
 * key shared across students on the same device). Server sync is debounced,
 * non-blocking, and best-effort — a failed sync never throws into the
 * reading flow and never blocks a card from responding locally. A stale
 * in-flight request is aborted whenever bookSlug/revision changes.
 *
 * When `enabled` is false (no premium interaction blocks in this book, or
 * the feature flag is off), this hook is a complete no-op: no localStorage
 * read/write, no network call, no timers — old books never pay any cost.
 */
import { useCallback, useEffect, useRef, useState } from "react";
import { syncProgress, getProgress } from "./bookInteractionProgressApi";

const CACHE_PREFIX = "eduhub_interaction_progress_v1";
const FLUSH_DEBOUNCE_MS = 2000;

function _cacheKey(studentId, bookSlug, revision) {
  return `${CACHE_PREFIX}:${studentId || "anon"}:${bookSlug || ""}:${revision ?? ""}`;
}

function _readCache(key) {
  try {
    const raw = localStorage.getItem(key);
    return raw ? JSON.parse(raw) : {};
  } catch {
    return {};
  }
}

function _writeCache(key, map) {
  try { localStorage.setItem(key, JSON.stringify(map)); } catch { /* ignore quota errors */ }
}

function _itemKey(chapterId, blockId) {
  return `${chapterId}:${blockId}`;
}

export function useBookInteractionProgress({ studentId, bookSlug, revision, enabled = true }) {
  const [cache, setCache] = useState({});
  const cacheKeyRef = useRef("");
  const dirtyRef = useRef(new Map()); // itemKey -> pending delta object
  const flushTimerRef = useRef(null);
  const abortRef = useRef(null);
  const mountedRef = useRef(true);

  useEffect(() => {
    mountedRef.current = true;
    return () => { mountedRef.current = false; };
  }, []);

  // Load local cache + best-effort server merge whenever the book/revision
  // identity changes. Any in-flight request from the PREVIOUS identity is
  // aborted first (§LOCKED CORRECTION 9: no stale cross-book request).
  useEffect(() => {
    abortRef.current?.abort();
    if (!enabled || !bookSlug) { setCache({}); return; }
    const key = _cacheKey(studentId, bookSlug, revision);
    cacheKeyRef.current = key;
    setCache(_readCache(key));

    const ac = new AbortController();
    abortRef.current = ac;
    (async () => {
      try {
        const res = await getProgress(bookSlug, revision, ac.signal);
        if (!mountedRef.current || ac.signal.aborted) return;
        const rows = (res && res.items) || [];
        if (!rows.length) return;
        setCache((prev) => {
          const merged = { ...prev };
          for (const row of rows) {
            const ik = _itemKey(row.chapterId, row.blockId);
            const local = merged[ik] || {};
            merged[ik] = {
              completed: Boolean(local.completed) || Boolean(row.state === "completed"),
              attemptCount: Math.max(local.attemptCount || 0, row.attemptCount || 0),
              hintLevel: Math.max(local.hintLevel || 0, row.hintLevel || 0),
              selectedBranch: row.selectedBranch ?? local.selectedBranch ?? null,
            };
          }
          _writeCache(key, merged);
          return merged;
        });
      } catch {
        // Best-effort merge only — never blocks local reading/interaction.
      }
    })();

    return () => { ac.abort(); };
  }, [enabled, studentId, bookSlug, revision]);

  const flushNow = useCallback(() => {
    if (!enabled || dirtyRef.current.size === 0) return;
    const items = Array.from(dirtyRef.current.values());
    dirtyRef.current = new Map();
    const ac = new AbortController();
    syncProgress(items, ac.signal).catch(() => {
      // Silent — a failed sync never blocks reading; the next local
      // mutation will re-include this item's latest state naturally since
      // the local cache (already updated optimistically) is the source of
      // truth for what the UI shows.
    });
  }, [enabled]);

  useEffect(() => () => {
    if (flushTimerRef.current) clearTimeout(flushTimerRef.current);
    flushNow(); // best-effort flush on unmount/navigation
  }, [flushNow]);

  const _scheduleFlush = useCallback(() => {
    if (flushTimerRef.current) clearTimeout(flushTimerRef.current);
    flushTimerRef.current = setTimeout(flushNow, FLUSH_DEBOUNCE_MS);
  }, [flushNow]);

  const _mutate = useCallback((chapterId, blockId, patch) => {
    if (!enabled || !bookSlug) return;
    const ik = _itemKey(chapterId, blockId);
    setCache((prev) => {
      const existing = prev[ik] || { completed: false, attemptCount: 0, hintLevel: 0, selectedBranch: null };
      const next = {
        completed: patch.completed !== undefined ? (existing.completed || patch.completed) : existing.completed,
        attemptCount: patch.attemptCount !== undefined ? Math.max(existing.attemptCount, patch.attemptCount) : existing.attemptCount,
        hintLevel: patch.hintLevel !== undefined ? Math.max(existing.hintLevel, patch.hintLevel) : existing.hintLevel,
        selectedBranch: patch.selectedBranch !== undefined ? patch.selectedBranch : existing.selectedBranch,
      };
      const updated = { ...prev, [ik]: next };
      _writeCache(cacheKeyRef.current, updated);
      dirtyRef.current.set(ik, {
        bookSlug, revision, chapterId, blockId,
        state: next.completed ? "completed" : "explored",
        attemptCount: next.attemptCount, hintLevel: next.hintLevel,
        selectedBranch: next.selectedBranch,
        clientUpdatedAt: new Date().toISOString(),
      });
      return updated;
    });
    _scheduleFlush();
  }, [enabled, bookSlug, revision, _scheduleFlush]);

  const getItemState = useCallback((chapterId, blockId) => (
    cache[_itemKey(chapterId, blockId)] || { completed: false, attemptCount: 0, hintLevel: 0, selectedBranch: null }
  ), [cache]);

  const markExplored = useCallback((chapterId, blockId) => _mutate(chapterId, blockId, {}), [_mutate]);
  const markCompleted = useCallback((chapterId, blockId) => _mutate(chapterId, blockId, { completed: true }), [_mutate]);
  const recordAttempt = useCallback((chapterId, blockId, attemptCount) => _mutate(chapterId, blockId, { attemptCount }), [_mutate]);
  const recordHint = useCallback((chapterId, blockId, hintLevel) => _mutate(chapterId, blockId, { hintLevel }), [_mutate]);
  const recordBranch = useCallback((chapterId, blockId, selectedBranch) => _mutate(chapterId, blockId, { selectedBranch }), [_mutate]);

  return { getItemState, markExplored, markCompleted, recordAttempt, recordHint, recordBranch, flushNow };
}

export default useBookInteractionProgress;
