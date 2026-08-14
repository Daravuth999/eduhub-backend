/**
 * useSyncHighlight.js — real-time karaoke highlight engine for the Video
 * Library (and any surface that owns a media element).
 *
 * The media element remains the ONLY playback clock: a
 * requestAnimationFrame loop samples `el.currentTime` while the media is
 * actually playing (started on play/playing, stopped on pause/ended and
 * when the page is hidden), and the active word/sentence indices are
 * derived with the existing, untouched syncConsumption.js binary search.
 *
 * Critically, the 60 Hz sampling path NEVER touches top-level React
 * state: indices live in a tiny external store and components subscribe
 * per-sentence via useSyncExternalStore, so a word transition re-renders
 * exactly the affected sentence(s) — not the whole player. This is the
 * fix for the observed 1–5 s highlight latency, which was caused by
 * ~4 Hz `timeupdate` sampling driving a full-tree re-render of every
 * transcript word span on each tick (a main-thread render storm on long
 * transcripts, especially on iPhone).
 *
 * A low-frequency `timeupdate` listener stays attached as a safety net
 * (covers paused seeks and any environment without rAF), and `seeked`/
 * `seeking`/`ratechange` recompute immediately so the transcript is never
 * left on an obsolete word after user interaction.
 *
 * When no media ref is available (Author Studio previews pass a plain
 * `currentTime` prop), the store falls back to prop-driven updates —
 * identical behavior to the previous implementation for those consumers.
 */
import { useEffect, useMemo, useRef, useSyncExternalStore } from "react";
import { computeActiveSentence, computeActiveWord, computeCurrentSpeaker } from "./syncConsumption";

export function createSyncHighlightStore() {
  let state = { wordIdx: -1, sentenceIdx: -1 };
  const listeners = new Set();
  return {
    getState: () => state,
    set(wordIdx, sentenceIdx) {
      if (state.wordIdx === wordIdx && state.sentenceIdx === sentenceIdx) return;
      state = { wordIdx, sentenceIdx };
      for (const l of Array.from(listeners)) l();
    },
    subscribe(l) {
      listeners.add(l);
      return () => listeners.delete(l);
    },
  };
}

/**
 * `externalStore` — when the caller already owns a live engine for this
 * exact media element (e.g. VideoLessonPlayer.jsx creates one for its
 * Transcript tab), pass it here instead of letting this hook create a
 * second, fully independent one. Teleprompter.jsx uses this so opening the
 * Teleprompter tab never spins up a duplicate rAF loop and a duplicate set
 * of media-element event listeners alongside the Transcript tab's engine —
 * both would otherwise sample the exact same el.currentTime redundantly.
 * Called unconditionally every render (required by the rules of hooks);
 * when `externalStore` is provided the internal store is simply never
 * subscribed to or driven, so its cost is one inert object allocation.
 */
export function useSyncHighlight(mediaRef, sync, fallbackTime, externalStore) {
  const ownStore = useMemo(createSyncHighlightStore, []);
  const store = externalStore || ownStore;
  const syncRef = useRef(sync);
  syncRef.current = sync;

  useEffect(() => {
    if (externalStore) return undefined; // parent already owns this engine
    const el = mediaRef && mediaRef.current;
    if (!el) return undefined;

    let rafId = 0;
    let running = false;
    let lastLoggedKey = "";
    const hasRaf = typeof requestAnimationFrame === "function";

    const compute = () => {
      const t = Number(el.currentTime) || 0;
      const { wordIdx, sentenceIdx } = computeIndices(syncRef.current, t);
      // Log only on an actual transition — the rAF loop samples up to 60/sec,
      // and logging every unchanged frame would flood devtools console
      // during exactly the window someone is trying to read it.
      const key = `${wordIdx}:${sentenceIdx}`;
      if (key !== lastLoggedKey) {
        lastLoggedKey = key;
        maybeLogKaraokeDebugFrame(el, syncRef.current, wordIdx, sentenceIdx);
      }
      store.set(wordIdx, sentenceIdx);
    };
    const loop = () => {
      compute();
      rafId = requestAnimationFrame(loop);
    };
    const start = () => {
      if (running || !hasRaf) return;
      running = true;
      rafId = requestAnimationFrame(loop);
    };
    const stop = () => {
      running = false;
      if (hasRaf) cancelAnimationFrame(rafId);
    };
    const onPlay = () => {
      if (typeof document === "undefined" || !document.hidden) start();
    };
    const onStop = () => {
      stop();
      compute();
    };
    const onVisibility = () => {
      if (document.hidden) {
        stop();
      } else {
        compute();
        if (!el.paused && !el.ended) start();
      }
    };

    el.addEventListener("play", onPlay);
    el.addEventListener("playing", onPlay);
    el.addEventListener("pause", onStop);
    el.addEventListener("ended", onStop);
    el.addEventListener("seeking", compute);
    el.addEventListener("seeked", compute);
    el.addEventListener("ratechange", compute);
    el.addEventListener("timeupdate", compute); // low-frequency safety net
    document.addEventListener("visibilitychange", onVisibility);

    compute();
    if (!el.paused && !el.ended) start();

    return () => {
      stop();
      el.removeEventListener("play", onPlay);
      el.removeEventListener("playing", onPlay);
      el.removeEventListener("pause", onStop);
      el.removeEventListener("ended", onStop);
      el.removeEventListener("seeking", compute);
      el.removeEventListener("seeked", compute);
      el.removeEventListener("ratechange", compute);
      el.removeEventListener("timeupdate", compute);
      document.removeEventListener("visibilitychange", onVisibility);
    };
  }, [mediaRef, sync, store, externalStore]);

  // Prop-driven fallback (Studio previews pass currentTime without a media ref).
  useEffect(() => {
    if (externalStore) return; // parent already owns this engine
    if (mediaRef && mediaRef.current) return;
    const t = Number(fallbackTime) || 0;
    const { wordIdx, sentenceIdx } = computeIndices(sync, t);
    store.set(wordIdx, sentenceIdx);
  }, [mediaRef, sync, fallbackTime, store, externalStore]);

  return store;
}

/** Flat index of the active sentence — subscribe at container level for scrolling. */
export function useActiveSentence(store) {
  return useSyncExternalStore(store.subscribe, () => store.getState().sentenceIdx);
}

/**
 * Per-sentence subscription. Returns:
 *   "past"   — this sentence has been spoken
 *   "future" — not reached yet
 *   number   — sentence is ACTIVE; value is the local word index inside it,
 *              or -1 when no word of THIS sentence is active (silence gap,
 *              or the sentence has no word-level timings — the calm
 *              sentence-level fallback: never sweep words that were never
 *              accurately timed).
 */
export function useSentenceState(store, sentenceIdx, wordOffset, wordCount) {
  return useSyncExternalStore(store.subscribe, () => {
    const { wordIdx, sentenceIdx: active } = store.getState();
    if (active < 0 || sentenceIdx > active) return "future";
    if (sentenceIdx < active) return "past";
    if (wordIdx >= wordOffset && wordIdx < wordOffset + wordCount) return wordIdx - wordOffset;
    return -1;
  });
}

// Center-focus reading mode clamps how far a rendered sentence's fade/rise
// style diverges from the active one — see focusZone.js's own FAR_DISTANCE.
// Kept in lockstep here so this hook never returns a raw value the style
// helper would silently re-clamp anyway.
const FOCUS_FAR_DISTANCE = 4;

/**
 * Center-focus reading mode only: how many sentences away `sentenceIdx` is
 * from the currently active sentence (negative = already spoken, positive
 * = upcoming, 0 = active, null = no sentence active yet). Subscribes to
 * the SAME store as useSentenceState via useSyncExternalStore, so on a
 * 60 Hz word tick the active sentence's own index doesn't change and this
 * selector's return value is referentially stable for every sentence —
 * no extra re-renders beyond what useSentenceState already causes. A real
 * sentence transition does change this value for every mounted sentence
 * (by design — the whole page recedes/approaches together), which is an
 * infrequent, natural-speech-paced event, not a per-frame one.
 */
export function useSentenceDistance(store, sentenceIdx) {
  return useSyncExternalStore(store.subscribe, () => {
    const { sentenceIdx: active } = store.getState();
    if (active < 0) return null;
    const raw = sentenceIdx - active;
    return Math.max(-FOCUS_FAR_DISTANCE, Math.min(FOCUS_FAR_DISTANCE, raw));
  });
}

/** Per-sentence metadata (flat index + global word offset) for a sync doc. */
export function buildSentenceMetas(sync) {
  const metas = [];
  let offset = 0;
  for (const p of sync?.paragraphs || []) {
    for (const s of p?.sentences || []) {
      const count = (s.words || []).length;
      metas.push({ s, paragraphId: p.id, wordOffset: offset, count });
      offset += count;
    }
  }
  return metas;
}

// sync objects are immutable in this codebase (see syncConsumption.js's
// identical WeakMap rationale) — cache per-reference sentence metas.
const _metaCache = new WeakMap();

function getMetas(sync) {
  if (!sync || typeof sync !== "object") return [];
  let m = _metaCache.get(sync);
  if (!m) {
    m = buildSentenceMetas(sync);
    _metaCache.set(sync, m);
  }
  return m;
}

/** Sentence flat-index owning a global word index — the fallback when a
 * document variant lacks sentence-level start/end timings. */
export function sentenceIndexForWord(sync, wordIdx) {
  if (wordIdx < 0) return -1;
  const metas = getMetas(sync);
  for (let i = 0; i < metas.length; i++) {
    if (wordIdx < metas[i].wordOffset + metas[i].count) return metas[i].count ? i : -1;
  }
  return -1;
}

function computeIndices(sync, t) {
  const wordIdx = computeActiveWord(sync, t);
  let sentenceIdx = computeActiveSentence(sync, t);
  if (sentenceIdx < 0 && wordIdx >= 0) sentenceIdx = sentenceIndexForWord(sync, wordIdx);
  return { wordIdx, sentenceIdx };
}

/** Flat, chronologically-real word list — the SAME array computeActiveWord's
 * binary search runs over — for the debug frame below. Pure, side-effect
 * free, safe to call from a browser devtools console. */
function flatWordsForDebug(sync) {
  const out = [];
  for (const p of sync?.paragraphs || []) for (const s of p?.sentences || []) for (const w of s?.words || []) out.push(w);
  return out;
}

/**
 * Live diagnostic snapshot of exactly the fields needed to root-cause a
 * karaoke desync report against a REAL lesson in production, without a
 * redeploy: video.currentTime, video.duration, the sync document's own
 * durationSec, the first/last word by ARRAY position (what a naive "is
 * this the end" check would have trusted before the ordering fix) and the
 * resolved active word. Pure — takes the media element and sync document
 * as plain values, never reads global state — so it is independently
 * testable and safe to call from a browser console for a live lesson:
 *   window.__eduhubKaraokeDebug = true   // before/while a lesson is open
 * then watch devtools console during playback. Left in permanently
 * (opt-in, zero cost when the flag is unset) rather than a throwaway
 * patch, since the exact failure mode this diagnoses (a sync document
 * whose real-time ordering doesn't match its array order) can only be
 * confirmed against real Gemini output, not fully eliminated by a client-
 * side test suite alone.
 */
export function describeKaraokeDebugFrame(el, sync, resolvedWordIdx, resolvedSentenceIdx) {
  const words = flatWordsForDebug(sync);
  const first = words[0] || null;
  const last = words[words.length - 1] || null;
  const active = resolvedWordIdx >= 0 ? words[resolvedWordIdx] || null : null;
  const t = Number(el?.currentTime);
  const speaker = Number.isFinite(t) ? computeCurrentSpeaker(sync, t) : null;
  return {
    videoCurrentTime: t,
    videoDuration: Number(el?.duration),
    syncDurationSec: sync?.durationSec ?? null,
    syncWordCount: words.length,
    // Whether the ARRAY (by position) is actually non-decreasing by
    // `start`, computed live against whatever document is actually
    // loaded — the exact invariant syncConsumption.js's binary search
    // assumes but never itself checks. `false` here against a real,
    // already-persisted document would mean the backend-side chronological
    // guard (sync_schema.validate_sync_document / assemble_narration_
    // track's per-line word sort) was bypassed for this specific document
    // — e.g. it was generated before those guards existed.
    isChronologicallySorted: words.every((w, i) => i === 0 || w.start >= words[i - 1].start - 0.01),
    firstWord: first && { word: first.word, start: first.start, end: first.end },
    lastWordByArrayPosition: last && { word: last.word, start: last.start, end: last.end },
    resolvedWordIdx,
    resolvedSentenceIdx,
    resolvedActiveWord: active && { word: active.word, start: active.start, end: active.end },
    activeSpeaker: speaker,
  };
}

function maybeLogKaraokeDebugFrame(el, sync, wordIdx, sentenceIdx) {
  if (typeof window === "undefined" || !window.__eduhubKaraokeDebug) return;
  // eslint-disable-next-line no-console
  console.log("[karaoke-debug]", describeKaraokeDebugFrame(el, sync, wordIdx, sentenceIdx));
}
