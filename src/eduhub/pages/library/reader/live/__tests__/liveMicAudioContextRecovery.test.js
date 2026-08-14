/**
 * liveMicAudioContextRecovery.test.js — re-audit hardening regression
 * coverage: startMicCapture() must eagerly resume() an AudioContext that
 * is already suspended at creation time, AND automatically resume() it
 * whenever the browser suspends it mid-session — the exact same gap
 * already fixed for the PLAYBACK context (see
 * liveAudioContextRecovery.test.js) but, until this fix, never applied to
 * the MIC CAPTURE context. A suspended capture context doesn't throw; its
 * ScriptProcessorNode simply stops firing onaudioprocess, so mic audio
 * silently stops being sent with no error anywhere in the app.
 *
 * startMicCapture() is invoked from armMic(), triggered from an
 * onWsMessage handler well outside the original Start-button gesture
 * stack — several awaits and a network round-trip removed — which is
 * exactly the class of context that can land in "suspended" on iOS
 * Safari without ever having been resumed.
 */
import { startMicCapture } from "../liveAudio";

class FakeProcessor {
  connect() {}
  disconnect() {}
}

class FakeMediaStreamSource {
  connect() {}
  disconnect() {}
}

class FakeTrack {
  stop() {}
}

class FakeStream {
  getTracks() {
    return [new FakeTrack()];
  }
}

class FakeAudioContext {
  constructor(initialState) {
    this.sampleRate = 48000;
    this.destination = {};
    this.state = initialState || "running";
    this.onstatechange = null;
    this.resumeCalls = 0;
  }
  createMediaStreamSource() {
    return new FakeMediaStreamSource();
  }
  createScriptProcessor() {
    return new FakeProcessor();
  }
  resume() {
    this.resumeCalls += 1;
    return Promise.resolve();
  }
  close() { this.state = "closed"; }

  simulateBrowserSuspend() {
    this.state = "suspended";
    if (typeof this.onstatechange === "function") this.onstatechange();
  }
}

let ctxInstance;
let ctxInitialState;

beforeEach(() => {
  ctxInitialState = "running";
  global.window = global.window || {};
  window.AudioContext = function () {
    ctxInstance = new FakeAudioContext(ctxInitialState);
    return ctxInstance;
  };
  window.webkitAudioContext = window.AudioContext;

  global.navigator.mediaDevices = {
    getUserMedia: jest.fn().mockResolvedValue(new FakeStream()),
  };
});

test("registers an onstatechange handler on the mic capture AudioContext", async () => {
  await startMicCapture(() => {}, () => {});
  expect(typeof ctxInstance.onstatechange).toBe("function");
});

test("automatically calls resume() when the browser suspends the mic context mid-session", async () => {
  await startMicCapture(() => {}, () => {});
  expect(ctxInstance.resumeCalls).toBe(0);

  ctxInstance.simulateBrowserSuspend();

  expect(ctxInstance.resumeCalls).toBe(1);
});

test("eagerly resumes a context that is already suspended at creation time", async () => {
  ctxInitialState = "suspended";
  await startMicCapture(() => {}, () => {});

  expect(ctxInstance.resumeCalls).toBe(1);
});

test("does not call resume() when the context reports a non-suspended state change", async () => {
  await startMicCapture(() => {}, () => {});
  ctxInstance.state = "running";
  ctxInstance.onstatechange();
  expect(ctxInstance.resumeCalls).toBe(0);
});

test("a rejected resume() during auto-recovery never throws / crashes capture", async () => {
  await startMicCapture(() => {}, () => {});
  ctxInstance.resume = () => Promise.reject(new Error("gesture required"));

  expect(() => ctxInstance.simulateBrowserSuspend()).not.toThrow();
});

test("stop() still tears down processor, source, tracks, and context exactly as before", async () => {
  const stop = await startMicCapture(() => {}, () => {});
  expect(typeof stop).toBe("function");
  expect(() => stop()).not.toThrow();
  expect(ctxInstance.state).toBe("closed");
});

/**
 * P0-2 fix — the tests above prove the mic context self-heals via its OWN
 * onstatechange handler. That's necessary but, per liveAudio.js's own
 * comments, not sufficient on iOS Safari, where the PLAYBACK context
 * already gets a second, explicit resume attempt from
 * EduTalkLiveCoach.jsx's visibilitychange handler (defense-in-depth) — the
 * mic context previously had no way to receive that same second attempt,
 * because only the bare stop() function was ever exposed. These tests pin
 * the fix: stop() now carries a callable .resume property, so external
 * code (the visibilitychange handler) can reach into this closure.
 */
test("the returned stop() function exposes a callable .resume property (the P0-2 fix)", async () => {
  const stop = await startMicCapture(() => {}, () => {});
  expect(typeof stop.resume).toBe("function");
});

test("calling stop.resume() resumes the SAME underlying AudioContext instance stop() will later close", async () => {
  const stop = await startMicCapture(() => {}, () => {});
  ctxInstance.resumeCalls = 0; // isolate from any eager/onstatechange resumes above

  stop.resume();

  expect(ctxInstance.resumeCalls).toBe(1);
  expect(ctxInstance.state).not.toBe("closed"); // resume() must never itself close the context
});

test("a rejected stop.resume() (e.g. iOS 'gesture required') never throws", async () => {
  const stop = await startMicCapture(() => {}, () => {});
  ctxInstance.resume = () => Promise.reject(new Error("gesture required"));
  expect(() => stop.resume()).not.toThrow();
});

test("attaching .resume does not change stop()'s own teardown behavior", async () => {
  const stop = await startMicCapture(() => {}, () => {});
  expect(() => stop()).not.toThrow();
  expect(ctxInstance.state).toBe("closed");
});
