/**
 * liveAudioGreetingDrain.test.js — proves the race-safe greeting drain contract
 * added to createAudioPlayer() in liveAudio.js. Mocks AudioContext + buffer
 * sources so source completion is driven deterministically.
 *
 * Covers EMERGENT_PHASE0_1_REFINED_BUILD_PROMPT.md §D (frontend audio drain
 * tests 1–6).
 */
import { createAudioPlayer } from "../liveAudio";

// A base64 string that decodes to an even number of bytes (valid Int16Array).
const PCM_B64 = "AAAAAAAA"; // 8 base64 chars → 6 bytes → 3 samples

let createdSources = [];

class FakeBufferSource {
  constructor() {
    this.onended = null;
    this.started = false;
    this.stopped = false;
    this.disconnected = false;
  }
  connect() {}
  disconnect() { this.disconnected = true; }
  start() { this.started = true; }
  stop() { this.stopped = true; }
}

class FakeAudioContext {
  constructor() {
    this.currentTime = 0;
    this.destination = {};
    this.state = "running";
  }
  createBuffer(ch, len) {
    return { duration: 0.1, getChannelData: () => new Float32Array(len) };
  }
  createBufferSource() {
    const s = new FakeBufferSource();
    createdSources.push(s);
    return s;
  }
  resume() {}
  close() { this.state = "closed"; }
}

const flush = () => Promise.resolve().then(() => Promise.resolve());

beforeEach(() => {
  createdSources = [];
  global.window = global.window || {};
  window.AudioContext = FakeAudioContext;
  window.webkitAudioContext = FakeAudioContext;
});

function endSource(src) {
  if (src && typeof src.onended === "function") src.onended();
}

describe("liveAudio greeting drain contract", () => {
  // 6 (placed first as the baseline behaviour guard)
  test("normal onSpeaking(true/false) remains unchanged", () => {
    const player = createAudioPlayer();
    const calls = [];
    player.setOnSpeaking((v) => calls.push(v));
    player.enqueue(PCM_B64);
    expect(calls).toEqual([true]);          // speaking starts
    endSource(createdSources[0]);
    expect(calls).toEqual([true, false]);   // speaking stops when active hits 0
  });

  // 1
  test("active reaching zero before a drain waiter exists does not fire completion", async () => {
    const player = createAudioPlayer();
    player.enqueue(PCM_B64);
    endSource(createdSources[0]); // active → 0, but NO waiter exists yet
    let fired = false;
    // Only now (simulating BEFORE turn_complete) there is no waiter; ensure
    // nothing was scheduled.
    await flush();
    expect(fired).toBe(false);
    // Arming AFTER the fact (post turn_complete) with already-idle queue fires.
    player.beginDrainWait("tok", () => { fired = true; });
    await flush();
    expect(fired).toBe(true);
  });

  // 2
  test("waiter created after turn completion fires only after all tracked sources end", async () => {
    const player = createAudioPlayer();
    player.enqueue(PCM_B64);
    player.enqueue(PCM_B64);
    let fired = false;
    player.beginDrainWait("tok", () => { fired = true; }); // armed post turn_complete
    await flush();
    expect(fired).toBe(false);          // 2 sources still active
    endSource(createdSources[0]);
    expect(fired).toBe(false);          // 1 still active
    endSource(createdSources[1]);
    expect(fired).toBe(true);           // all ended → drained
  });

  // 3
  test("temporary chunk gap before turn completion cannot fire it", async () => {
    const player = createAudioPlayer();
    player.enqueue(PCM_B64);
    endSource(createdSources[0]);  // active momentarily 0 (gap between chunks)
    player.enqueue(PCM_B64);       // next chunk arrives → active 1 again
    let fired = false;
    // Waiter armed only now (turn_complete); the earlier gap must NOT count.
    player.beginDrainWait("tok", () => { fired = true; });
    await flush();
    expect(fired).toBe(false);
    endSource(createdSources[1]);
    expect(fired).toBe(true);
  });

  // 4
  test("cancellation stops sources, invalidates generation, prevents stale callback", async () => {
    const player = createAudioPlayer();
    const g0 = player.getGeneration();
    player.enqueue(PCM_B64);
    let fired = false;
    player.beginDrainWait("tok", () => { fired = true; });
    player.cancelPendingPlayback();
    expect(player.getGeneration()).toBe(g0 + 1);
    expect(createdSources[0].stopped).toBe(true);
    // A late onended from the stopped source must NOT fire the (cleared) waiter.
    endSource(createdSources[0]);
    await flush();
    expect(fired).toBe(false);
  });

  // 5
  test("close invalidates waiter and prevents callback", async () => {
    const player = createAudioPlayer();
    player.enqueue(PCM_B64);
    let fired = false;
    player.beginDrainWait("tok", () => { fired = true; });
    player.close();
    endSource(createdSources[0]);
    await flush();
    expect(fired).toBe(false);
  });

  test("cancelDrainWait cancels only the matching waiter", async () => {
    const player = createAudioPlayer();
    let fired = false;
    player.beginDrainWait("tok-1", () => { fired = true; });
    player.cancelDrainWait("tok-other"); // non-matching → no effect
    player.cancelDrainWait("tok-1");     // matching → cancels
    await flush();
    expect(fired).toBe(false);
  });
});
