/**
 * useSyncHighlight.test.js — regression coverage for the Video Library's
 * real-time karaoke engine: media-clock sampling, event-driven recompute
 * (seek / rate change / pause), change-only notifications, and the
 * per-sentence state mapping including the calm no-word-timing fallback.
 */
import { renderHook, act } from "@testing-library/react";
import {
  createSyncHighlightStore, useSyncHighlight, useSentenceState, useActiveSentence, buildSentenceMetas,
  describeKaraokeDebugFrame, useSentenceDistance,
} from "../useSyncHighlight";

// jsdom (CRA's jest env) does not provide rAF — shim with timers.
beforeAll(() => {
  global.requestAnimationFrame = (cb) => setTimeout(() => cb(performance.now()), 16);
  global.cancelAnimationFrame = (id) => clearTimeout(id);
});

const SYNC = {
  paragraphs: [
    {
      id: "p1",
      sentences: [
        {
          id: "s1",
          start: 1.2, end: 1.68,
          words: [
            { word: "A", start: 1.20, end: 1.35 },
            { word: "B", start: 1.35, end: 1.51 },
            { word: "C", start: 1.51, end: 1.68 },
          ],
        },
        { id: "s2", start: 2.0, end: 3.0, words: [{ word: "D", start: 2.0, end: 3.0 }] },
      ],
    },
  ],
};

// A sentence with NO word timings must never fake word-level karaoke.
const SYNC_NO_WORDS = {
  paragraphs: [{ id: "p1", sentences: [{ id: "s1", start: 0, end: 2, words: [] }, { id: "s2", start: 2, end: 4, words: [{ word: "late", start: 2, end: 4 }] }] }],
};

describe("createSyncHighlightStore", () => {
  test("notifies only when indices actually change", () => {
    const store = createSyncHighlightStore();
    const listener = jest.fn();
    store.subscribe(listener);
    store.set(1, 0);
    store.set(1, 0); // identical — no notification
    store.set(2, 0);
    expect(listener).toHaveBeenCalledTimes(2);
    expect(store.getState()).toEqual({ wordIdx: 2, sentenceIdx: 0 });
  });
});

describe("buildSentenceMetas", () => {
  test("assigns cumulative word offsets across sentences", () => {
    const metas = buildSentenceMetas(SYNC);
    expect(metas).toHaveLength(2);
    expect(metas[0]).toMatchObject({ wordOffset: 0, count: 3, paragraphId: "p1" });
    expect(metas[1]).toMatchObject({ wordOffset: 3, count: 1 });
  });
});

describe("useSyncHighlight — media element clock", () => {
  function makeVideo() {
    const el = document.createElement("video");
    Object.defineProperty(el, "currentTime", { value: 0, writable: true });
    Object.defineProperty(el, "paused", { value: true, writable: true });
    Object.defineProperty(el, "ended", { value: false, writable: true });
    return el;
  }

  test("adjacent short words transition A → B → C as the clock advances (timeupdate net)", () => {
    const el = makeVideo();
    const ref = { current: el };
    const { result } = renderHook(() => useSyncHighlight(ref, SYNC, 0));
    const seen = [];
    result.current.subscribe(() => seen.push(result.current.getState().wordIdx));
    for (const t of [1.25, 1.40, 1.60]) {
      act(() => {
        el.currentTime = t;
        el.dispatchEvent(new Event("timeupdate"));
      });
    }
    expect(seen).toEqual([0, 1, 2]); // no skips, no stuck words
  });

  test("seeking recomputes immediately — never leaves an obsolete word active", () => {
    const el = makeVideo();
    const ref = { current: el };
    const { result } = renderHook(() => useSyncHighlight(ref, SYNC, 0));
    act(() => {
      el.currentTime = 2.5;
      el.dispatchEvent(new Event("seeked"));
    });
    expect(result.current.getState()).toEqual({ wordIdx: 3, sentenceIdx: 1 });
    act(() => {
      el.currentTime = 1.3;
      el.dispatchEvent(new Event("seeked"));
    });
    expect(result.current.getState()).toEqual({ wordIdx: 0, sentenceIdx: 0 });
  });

  test("rAF loop samples the media clock while playing and stops on pause", async () => {
    const el = makeVideo();
    const ref = { current: el };
    const { result } = renderHook(() => useSyncHighlight(ref, SYNC, 0));
    act(() => {
      el.paused = false;
      el.dispatchEvent(new Event("play"));
    });
    el.currentTime = 1.4; // no event dispatched — only the rAF loop can see this
    await act(() => new Promise((r) => setTimeout(r, 60)));
    expect(result.current.getState().wordIdx).toBe(1);
    act(() => {
      el.paused = true;
      el.dispatchEvent(new Event("pause"));
    });
    el.currentTime = 2.5; // loop stopped — nothing should observe this
    await act(() => new Promise((r) => setTimeout(r, 60)));
    expect(result.current.getState().wordIdx).toBe(1);
  });

  test("falls back to the currentTime prop when no media ref exists (Studio previews)", () => {
    const { result, rerender } = renderHook(
      ({ t }) => useSyncHighlight(undefined, SYNC, t),
      { initialProps: { t: 0 } },
    );
    rerender({ t: 1.4 });
    expect(result.current.getState()).toEqual({ wordIdx: 1, sentenceIdx: 0 });
  });
});

describe("useSentenceState", () => {
  test("maps past / active-with-local-word / future correctly", () => {
    const store = createSyncHighlightStore();
    const metas = buildSentenceMetas(SYNC);
    const { result: s0 } = renderHook(() => useSentenceState(store, 0, metas[0].wordOffset, metas[0].count));
    const { result: s1 } = renderHook(() => useSentenceState(store, 1, metas[1].wordOffset, metas[1].count));
    act(() => store.set(1, 0)); // word B active in sentence 0
    expect(s0.current).toBe(1);
    expect(s1.current).toBe("future");
    act(() => store.set(3, 1)); // word D active in sentence 1
    expect(s0.current).toBe("past");
    expect(s1.current).toBe(0);
  });

  test("a sentence without word timings stays calm: active but no word highlight", () => {
    const store = createSyncHighlightStore();
    const metas = buildSentenceMetas(SYNC_NO_WORDS);
    const { result } = renderHook(() => useSentenceState(store, 0, metas[0].wordOffset, metas[0].count));
    // At t≈1s the binary search holds no word (sentence 1 has none) — the
    // active sentence must NOT fake word-level karaoke.
    act(() => store.set(-1, 0));
    expect(result.current).toBe(-1);
  });

  test("a stale word from a previous sentence never bleeds into the active sentence", () => {
    const store = createSyncHighlightStore();
    const metas = buildSentenceMetas(SYNC);
    const { result } = renderHook(() => useSentenceState(store, 1, metas[1].wordOffset, metas[1].count));
    // Silence gap between sentences: binary search holds the LAST word of
    // sentence 0 (idx 2) while sentence 1 is already active.
    act(() => store.set(2, 1));
    expect(result.current).toBe(-1); // no foreign word highlighted
  });
});

describe("useActiveSentence", () => {
  test("tracks the store's sentence index", () => {
    const store = createSyncHighlightStore();
    const { result } = renderHook(() => useActiveSentence(store));
    expect(result.current).toBe(-1);
    act(() => store.set(0, 1));
    expect(result.current).toBe(1);
  });
});

describe("useSentenceDistance — center-focus reading mode", () => {
  test("returns null before any sentence is active", () => {
    const store = createSyncHighlightStore();
    const { result } = renderHook(() => useSentenceDistance(store, 2));
    expect(result.current).toBeNull();
  });

  test("returns 0 for the active sentence, negative for past, positive for upcoming", () => {
    const store = createSyncHighlightStore();
    const { result: past } = renderHook(() => useSentenceDistance(store, 0));
    const { result: active } = renderHook(() => useSentenceDistance(store, 2));
    const { result: future } = renderHook(() => useSentenceDistance(store, 5));
    act(() => store.set(0, 2));
    expect(past.current).toBe(-2);
    expect(active.current).toBe(0);
    expect(future.current).toBe(3);
  });

  test("clamps far distances instead of returning unbounded values", () => {
    const store = createSyncHighlightStore();
    const { result } = renderHook(() => useSentenceDistance(store, 40));
    act(() => store.set(0, 0));
    expect(result.current).toBe(4);
  });

  test("a sentence transition changes distance for a non-active sentence, but a same-sentence word tick does not", () => {
    const store = createSyncHighlightStore();
    const { result } = renderHook(() => useSentenceDistance(store, 3));
    act(() => store.set(0, 1)); // sentence 1 active — sentence 3 is +2 away
    expect(result.current).toBe(2);
    act(() => store.set(1, 1)); // word tick within the SAME active sentence
    expect(result.current).toBe(2); // unchanged — no spurious re-derivation
    act(() => store.set(0, 2)); // real sentence transition
    expect(result.current).toBe(1);
  });
});

describe("describeKaraokeDebugFrame — live diagnostic snapshot (Bug 2 investigation)", () => {
  function makeVideo(currentTime, duration) {
    const el = document.createElement("video");
    Object.defineProperty(el, "currentTime", { value: currentTime, writable: true });
    Object.defineProperty(el, "duration", { value: duration, writable: true });
    return el;
  }

  test("reports the exact fields requested for live root-causing: currentTime, duration, first/last word, resolved word", () => {
    const el = makeVideo(1.4, 3.0);
    const frame = describeKaraokeDebugFrame(el, SYNC, 1, 0);
    expect(frame).toEqual({
      videoCurrentTime: 1.4,
      videoDuration: 3.0,
      syncDurationSec: null,
      syncWordCount: 4,
      isChronologicallySorted: true,
      firstWord: { word: "A", start: 1.2, end: 1.35 },
      lastWordByArrayPosition: { word: "D", start: 2.0, end: 3.0 },
      resolvedWordIdx: 1,
      resolvedSentenceIdx: 0,
      resolvedActiveWord: { word: "B", start: 1.35, end: 1.51 },
      activeSpeaker: null,
    });
  });

  test("reports null resolvedActiveWord honestly when no word is active — never fabricates one", () => {
    const el = makeVideo(0, 3.0);
    const frame = describeKaraokeDebugFrame(el, SYNC, -1, -1);
    expect(frame.resolvedActiveWord).toBeNull();
  });

  test("never throws for a missing/empty sync document", () => {
    const el = makeVideo(0, 0);
    expect(() => describeKaraokeDebugFrame(el, null, -1, -1)).not.toThrow();
    expect(describeKaraokeDebugFrame(el, null, -1, -1).firstWord).toBeNull();
  });

  test("isChronologicallySorted is false for a document whose word array position does not match its own start values — the exact incident this diagnostic exists to catch", () => {
    const OUT_OF_ORDER_SYNC = {
      paragraphs: [{
        id: "p1",
        sentences: [{
          id: "s1", start: 0, end: 5,
          words: [
            { word: "final", start: 4.5, end: 5.0 },   // array position 0 — LATEST real time
            { word: "welcome", start: 0.0, end: 0.5 },  // array position 1 — EARLIEST real time
          ],
        }],
      }],
    };
    const el = makeVideo(0, 5.0);
    const frame = describeKaraokeDebugFrame(el, OUT_OF_ORDER_SYNC, 0, 0);
    expect(frame.isChronologicallySorted).toBe(false);
  });

  test("reports the real active speaker from the sync document's own speakerId, never fabricated", () => {
    const CONVERSATION_SYNC = {
      paragraphs: [{
        id: "p1",
        sentences: [
          { id: "s1", start: 0, end: 1, speakerId: "S1", words: [{ word: "Hi.", start: 0, end: 1 }] },
          { id: "s2", start: 1, end: 2, speakerId: "S2", words: [{ word: "Hey.", start: 1, end: 2 }] },
        ],
      }],
      speakers: [{ id: "S1", label: "S1" }, { id: "S2", label: "S2" }],
    };
    const el = makeVideo(1.5, 2.0);
    const frame = describeKaraokeDebugFrame(el, CONVERSATION_SYNC, 1, 1);
    expect(frame.activeSpeaker).toEqual({ id: "S2", label: "S2" });
  });
});
