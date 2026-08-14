/**
 * v9.5 Patch audit — unit tests for the AI voice transcript replay-sync fix.
 *
 * The bug: on replay, transcript word-highlighting could flash, freeze, or
 * desync because:
 *   1. AudioPlayerContext.onEnded reset React.currentTime to 0 but the
 *      underlying <audio> element kept currentTime === duration, so any
 *      stray `timeupdate` from the implicit rewind ran the React state
 *      back to ~duration for one frame.
 *   2. play() / toggle() relied on the browser's implicit rewind, whose
 *      event ordering is non-deterministic across browsers.
 *
 * These tests pin the corrected lifecycle behaviour in JSDOM. They don't
 * mount the React tree — JSDOM doesn't implement <audio> media pipelines.
 * Instead they exercise the same pure-logic invariants the patch
 * introduces, verifying we never reach a state where the React clock and
 * the DOM clock disagree across a replay boundary.
 *
 * Runnable via the standard CRA test harness (`craco test`).
 */

/* ─────────────── Fake <audio> element ─────────────── */

/**
 * Minimal fake matching the surface area the AudioPlayerContext uses:
 *   - currentTime (read/write)
 *   - duration (read)
 *   - paused, ended (read)
 *   - play() / pause() / load()
 *   - addEventListener / removeEventListener with timeupdate, play, pause,
 *     ended, seeked
 *
 * We expose a `simulate.*()` API so tests can drive the lifecycle without
 * needing a real audio pipeline.
 */
function makeFakeAudio(duration = 30) {
  const listeners = {};
  const el = {
    currentTime: 0,
    duration,
    paused: true,
    ended: false,
    readyState: 4,
    src: "https://example.test/audio.mp3",
    error: null,
    playbackRate: 1,
    volume: 1,
    addEventListener: (k, fn) => {
      (listeners[k] = listeners[k] || []).push(fn);
    },
    removeEventListener: (k, fn) => {
      if (!listeners[k]) return;
      listeners[k] = listeners[k].filter((f) => f !== fn);
    },
    play: async () => {
      el.paused = false;
      el.ended = false;
      (listeners.play || []).forEach((fn) => fn());
    },
    pause: () => {
      el.paused = true;
      (listeners.pause || []).forEach((fn) => fn());
    },
    load: () => {
      el.currentTime = 0;
    },
    remove: () => {},
    setAttribute: () => {},
    style: {},
  };
  el.simulate = {
    timeUpdate(t) {
      el.currentTime = t;
      (listeners.timeupdate || []).forEach((fn) => fn());
    },
    end() {
      el.currentTime = el.duration;
      el.paused = true;
      el.ended = true;
      (listeners.ended || []).forEach((fn) => fn());
    },
    seek(t) {
      el.currentTime = t;
      (listeners.seeked || []).forEach((fn) => fn());
    },
  };
  return el;
}

/* ─────────────── Replicas of the patched logic ─────────────── */

/**
 * Replica of the v9.5-patched `onEnded` behaviour. Verifies the contract
 * that DOM currentTime is rewound BEFORE React state is touched, so the
 * two clocks are coherent when the next play() is called.
 */
function patchedOnEnded(el, setReact) {
  try {
    if (el && Number.isFinite(el.duration)) {
      el.currentTime = 0;
    }
  } catch { /* ignore */ }
  setReact.setPlaying(false);
  setReact.setCurrentTime(0);
}

/**
 * Replica of the v9.5-patched `play()` behaviour. Returns a promise that
 * resolves after the explicit-rewind + play() chain completes.
 */
async function patchedPlay(el, setReact) {
  if (!el || !el.src) return;
  try {
    const dur = Number.isFinite(el.duration) ? el.duration : 0;
    if (dur > 0 && el.currentTime >= dur - 0.05) {
      el.currentTime = 0;
      setReact.setCurrentTime(0);
    }
  } catch { /* ignore */ }
  try { await el.play(); } catch { /* user-gesture */ }
}

/**
 * Replica of the v9.5-patched TranscriptParagraph weighted-estimation
 * branch. Returns the active word index given an audio snapshot.
 * Pure function — easy to unit-test the replay invariants.
 */
function computeActive({ wordCount, start, end, currentTime, playing }) {
  const t = currentTime;
  const s = Number.isFinite(start) ? start : 0;
  const e = Number.isFinite(end) ? end : 0;
  if (!playing && t === 0) return -1;        // replay-from-start reset
  if (e <= s)        return -1;
  if (t < s - 0.05)  return -1;
  if (t >= e)        return wordCount - 1;
  const frac = (t - s) / (e - s);
  return Math.max(0, Math.min(wordCount - 1, Math.floor(frac * wordCount)));
}

/* ─────────────── Tests ─────────────── */

describe("v9.5 — onEnded rewinds the DOM clock before React state", () => {
  test("onEnded sets el.currentTime back to 0 and clears React playing", () => {
    const el = makeFakeAudio(30);
    const react = { currentTime: 0, playing: false };
    const setReact = {
      setPlaying: (v) => (react.playing = v),
      setCurrentTime: (v) => (react.currentTime = v),
    };
    // Simulate end-of-track in the DOM.
    el.simulate.end();
    expect(el.currentTime).toBe(30); // pre-patch state

    patchedOnEnded(el, setReact);

    // The patch's invariant: DOM === React === 0.
    expect(el.currentTime).toBe(0);
    expect(react.currentTime).toBe(0);
    expect(react.playing).toBe(false);
  });

  test("onEnded is safe when duration is NaN (e.g. metadata not yet loaded)", () => {
    const el = makeFakeAudio(NaN);
    const react = { currentTime: 5, playing: true };
    const setReact = {
      setPlaying: (v) => (react.playing = v),
      setCurrentTime: (v) => (react.currentTime = v),
    };
    expect(() => patchedOnEnded(el, setReact)).not.toThrow();
    // Doesn't touch el.currentTime when duration is non-finite; still
    // resets React state so the UI shows a stopped player.
    expect(react.currentTime).toBe(0);
    expect(react.playing).toBe(false);
  });
});

describe("v9.5 — play() explicitly rewinds when at end-of-track", () => {
  test("rewinds when currentTime is at duration", async () => {
    const el = makeFakeAudio(30);
    el.currentTime = 30;
    const react = { currentTime: 30 };
    const setReact = {
      setCurrentTime: (v) => (react.currentTime = v),
    };
    await patchedPlay(el, setReact);
    expect(el.currentTime).toBe(0);
    expect(react.currentTime).toBe(0);
    expect(el.paused).toBe(false);
  });

  test("rewinds within the 0.05s end tolerance band", async () => {
    const el = makeFakeAudio(30);
    el.currentTime = 29.97; // inside the dur - 0.05 window
    const react = { currentTime: 29.97 };
    const setReact = { setCurrentTime: (v) => (react.currentTime = v) };
    await patchedPlay(el, setReact);
    expect(el.currentTime).toBe(0);
  });

  test("does NOT rewind mid-track on resume from pause", async () => {
    const el = makeFakeAudio(30);
    el.currentTime = 12.5;
    const react = { currentTime: 12.5 };
    const setReact = { setCurrentTime: (v) => (react.currentTime = v) };
    await patchedPlay(el, setReact);
    // The whole point of pause/resume: stay where you were.
    expect(el.currentTime).toBe(12.5);
    expect(react.currentTime).toBe(12.5);
    expect(el.paused).toBe(false);
  });

  test("no-op when src is empty", async () => {
    const el = makeFakeAudio(30);
    el.src = "";
    el.currentTime = 30;
    const setReact = { setCurrentTime: jest.fn() };
    await patchedPlay(el, setReact);
    expect(el.paused).toBe(true); // never started
    expect(setReact.setCurrentTime).not.toHaveBeenCalled();
  });
});

describe("v9.5 — TranscriptParagraph replay invariants (pure)", () => {
  // Hypothetical paragraph: 10 words, spans audio seconds 5–15.
  const PARAGRAPH = { wordCount: 10, start: 5, end: 15 };

  test("cleared (-1) when playback hasn't started and clock is at 0", () => {
    const idx = computeActive({ ...PARAGRAPH, currentTime: 0, playing: false });
    expect(idx).toBe(-1);
  });

  test("highlights last word when t exceeds end during playback", () => {
    const idx = computeActive({ ...PARAGRAPH, currentTime: 20, playing: true });
    expect(idx).toBe(PARAGRAPH.wordCount - 1);
  });

  test("after onEnded resets clock to 0, paragraph clears (replay primer)", () => {
    // Models the precise moment between playbacks: ended → onEnded ran,
    // React clock at 0, playing flipped to false. Pre-patch, this state
    // was unreachable when [start,end] sat near end of audio because the
    // late timeupdate at t≈duration kept active pinned to last word.
    const idx = computeActive({ ...PARAGRAPH, currentTime: 0, playing: false });
    expect(idx).toBe(-1);
  });

  test("preserves highlight when paused mid-paragraph (pause/resume UX)", () => {
    // Critical: don't clear the highlight on pause — the student needs to
    // see which word they paused on. The narrow `&& t === 0` predicate
    // protects this UX.
    const idx = computeActive({ ...PARAGRAPH, currentTime: 10, playing: false });
    expect(idx).toBeGreaterThanOrEqual(0);
    expect(idx).toBeLessThan(PARAGRAPH.wordCount);
  });

  test("paragraphs before playhead clear correctly during replay", () => {
    // During second playback at t=2 (before this paragraph's start=5),
    // the highlight should be cleared even though prior playback ended
    // with active pinned to last word.
    const idx = computeActive({ ...PARAGRAPH, currentTime: 2, playing: true });
    expect(idx).toBe(-1);
  });

  test("advances linearly through paragraph during playback", () => {
    // Sanity: at midpoint of the paragraph window, active should be
    // around the midpoint of the word array. Floor + 0.5 fraction = 5.
    const idx = computeActive({ ...PARAGRAPH, currentTime: 10, playing: true });
    expect(idx).toBe(5);
  });

  test("0.05s tolerance prevents flicker at paragraph boundary", () => {
    // t === s - 0.04 → still considered "before"? No — within tolerance.
    const idx = computeActive({ ...PARAGRAPH, currentTime: 4.97, playing: true });
    // 4.97 is within s - 0.05 (= 4.95), so NOT cleared. Falls through to
    // the linear branch with negative frac → clamped to 0.
    expect(idx).toBe(0);
  });
});

describe("v9.5 — replay lifecycle end-to-end (pure)", () => {
  test("full play → end → replay cycle leaves DOM and React clocks in sync", async () => {
    const el = makeFakeAudio(30);
    const react = { currentTime: 0, playing: false };
    const setReact = {
      setPlaying: (v) => (react.playing = v),
      setCurrentTime: (v) => (react.currentTime = v),
    };

    // 1. Playback starts.
    await patchedPlay(el, setReact);
    react.playing = true; // (the play event listener would set this)
    expect(el.paused).toBe(false);

    // 2. Various timeupdates fire mid-playback.
    el.simulate.timeUpdate(10);
    setReact.setCurrentTime(el.currentTime);
    expect(react.currentTime).toBe(10);

    el.simulate.timeUpdate(29.8);
    setReact.setCurrentTime(el.currentTime);
    expect(react.currentTime).toBe(29.8);

    // 3. Track ends.
    el.simulate.end();
    patchedOnEnded(el, setReact);

    // Post-end invariant: BOTH clocks at 0.
    expect(el.currentTime).toBe(0);
    expect(react.currentTime).toBe(0);
    expect(react.playing).toBe(false);

    // 4. Replay starts. At this point el.currentTime === 0 already, so the
    // explicit-rewind branch is a no-op — but importantly there is NO
    // stray timeupdate at t≈30 because the DOM was already rewound.
    await patchedPlay(el, setReact);
    react.playing = true;
    expect(el.paused).toBe(false);
    expect(el.currentTime).toBe(0);
    expect(react.currentTime).toBe(0);

    // 5. Transcript paragraphs spanning the start of the audio compute a
    // valid active index immediately — no flash to last-word.
    const para = { wordCount: 8, start: 0, end: 5 };
    el.simulate.timeUpdate(1);
    setReact.setCurrentTime(el.currentTime);
    const idx = computeActive({
      ...para,
      currentTime: react.currentTime,
      playing: react.playing,
    });
    expect(idx).toBeGreaterThanOrEqual(0);
    expect(idx).toBeLessThan(para.wordCount);
  });
});
