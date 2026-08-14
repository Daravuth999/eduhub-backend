/**
 * liveAudioContextRecovery.test.js — BUG 2 hardening regression coverage:
 * createAudioPlayer() must automatically resume() the AudioContext
 * whenever the browser suspends it mid-session (background tab, OS audio
 * focus loss, etc.), since a suspended context silently produces no
 * audible output without ever throwing — nothing else in this codebase
 * could have caught that.
 *
 * Uses the same FakeAudioContext pattern as liveAudioGreetingDrain.test.js.
 */
import { createAudioPlayer } from "../liveAudio";

class FakeBufferSource {
  connect() {}
  disconnect() {}
  start() {}
  stop() {}
}

class FakeAudioContext {
  constructor() {
    this.currentTime = 0;
    this.destination = {};
    this.state = "running";
    this.onstatechange = null;
    this.resumeCalls = 0;
  }
  createBuffer(ch, len) {
    return { duration: 0.1, getChannelData: () => new Float32Array(len) };
  }
  createBufferSource() {
    return new FakeBufferSource();
  }
  resume() {
    this.resumeCalls += 1;
    return Promise.resolve();
  }
  close() { this.state = "closed"; }

  // Test helper — simulates the browser suspending the context on its
  // own and firing the statechange event, exactly like a real AudioContext.
  simulateBrowserSuspend() {
    this.state = "suspended";
    if (typeof this.onstatechange === "function") this.onstatechange();
  }
}

let ctxInstance;

beforeEach(() => {
  global.window = global.window || {};
  window.AudioContext = function () {
    ctxInstance = new FakeAudioContext();
    return ctxInstance;
  };
  window.webkitAudioContext = window.AudioContext;
});

test("registers an onstatechange handler on the underlying AudioContext", () => {
  createAudioPlayer();
  expect(typeof ctxInstance.onstatechange).toBe("function");
});

test("automatically calls resume() when the browser suspends the context mid-session", () => {
  createAudioPlayer();
  expect(ctxInstance.resumeCalls).toBe(0);

  ctxInstance.simulateBrowserSuspend();

  expect(ctxInstance.resumeCalls).toBe(1);
});

test("does not call resume() when the context reports a non-suspended state change", () => {
  createAudioPlayer();
  ctxInstance.state = "running";
  ctxInstance.onstatechange();
  expect(ctxInstance.resumeCalls).toBe(0);
});

test("a rejected resume() during auto-recovery never throws / crashes the player", () => {
  createAudioPlayer();
  ctxInstance.resume = () => Promise.reject(new Error("gesture required"));

  expect(() => ctxInstance.simulateBrowserSuspend()).not.toThrow();
});

test("manual player.resume() still works exactly as before (unchanged happy path)", async () => {
  const player = createAudioPlayer();
  await player.resume();
  expect(ctxInstance.resumeCalls).toBe(1);
});
