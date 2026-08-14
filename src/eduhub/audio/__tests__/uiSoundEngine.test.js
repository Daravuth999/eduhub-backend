/**
 * uiSoundEngine.test.js — Premium UI Sound System core engine.
 *
 * No real Web Audio API in jsdom — follows the established per-test-file
 * fake-AudioContext pattern already used elsewhere in this codebase
 * (see src/eduhub/pages/library/reader/live/__tests__/
 * liveAudioContextRecovery.test.js), rather than inventing a new one.
 */
import { playUiSound, unlockAudio, setEngineVolumeMode, SOUND_NAMES, _resetForTests } from "../uiSoundEngine";

class FakeGain {
  constructor() {
    this.gain = { value: 1, setValueAtTime: jest.fn(), exponentialRampToValueAtTime: jest.fn() };
    this.connections = [];
  }
  connect(dest) { this.connections.push(dest); }
}

class FakeOscillator {
  constructor() {
    this.type = "sine";
    this.frequency = { setValueAtTime: jest.fn(), exponentialRampToValueAtTime: jest.fn() };
    this.started = false;
    this.stopped = false;
  }
  connect() {}
  start() { this.started = true; }
  stop() { this.stopped = true; }
}

class FakeAudioContext {
  constructor() {
    this.state = "suspended";
    this.currentTime = 0;
    this.destination = {};
    this.oscillatorsCreated = 0;
    this.gainsCreated = 0;
  }
  createOscillator() { this.oscillatorsCreated += 1; return new FakeOscillator(); }
  createGain() { this.gainsCreated += 1; return new FakeGain(); }
  resume() { this.state = "running"; return Promise.resolve(); }
  close() { this.state = "closed"; return Promise.resolve(); }
}

let lastCreatedContext;

beforeEach(() => {
  _resetForTests();
  lastCreatedContext = undefined;
  window.AudioContext = jest.fn().mockImplementation(() => {
    lastCreatedContext = new FakeAudioContext();
    return lastCreatedContext;
  });
  window.webkitAudioContext = window.AudioContext;
});

afterEach(() => {
  delete window.AudioContext;
  delete window.webkitAudioContext;
});

test("unlockAudio() creates the AudioContext and resumes it if suspended", () => {
  unlockAudio();
  expect(window.AudioContext).toHaveBeenCalledTimes(1);
  expect(lastCreatedContext.state).toBe("running");
});

test("playUiSound creates oscillators when mode is soft (default)", () => {
  playUiSound("click");
  expect(lastCreatedContext.oscillatorsCreated).toBeGreaterThan(0);
});

test("playUiSound never touches the AudioContext at all when mode is off", () => {
  setEngineVolumeMode("off");
  playUiSound("click");
  expect(window.AudioContext).not.toHaveBeenCalled();
});

test("playUiSound resumes context again once mode is switched back on", () => {
  setEngineVolumeMode("off");
  playUiSound("click");
  setEngineVolumeMode("normal");
  playUiSound("click");
  expect(window.AudioContext).toHaveBeenCalledTimes(1);
  expect(lastCreatedContext.oscillatorsCreated).toBeGreaterThan(0);
});

test("an unknown sound name is a safe no-op, never throws", () => {
  expect(() => playUiSound("not-a-real-sound")).not.toThrow();
  expect(window.AudioContext).not.toHaveBeenCalled();
});

test("every declared sound name plays without throwing", () => {
  SOUND_NAMES.forEach((name) => {
    expect(() => playUiSound(name)).not.toThrow();
  });
});

test("multi-note sounds (success, reward) create more than one oscillator", () => {
  playUiSound("reward");
  expect(lastCreatedContext.oscillatorsCreated).toBeGreaterThanOrEqual(3);
});

test("setEngineVolumeMode falls back to soft for an invalid mode", () => {
  setEngineVolumeMode("deafening"); // not a real mode
  playUiSound("click"); // must still create the context/oscillator (soft, not off)
  expect(lastCreatedContext.oscillatorsCreated).toBeGreaterThan(0);
});

test("does not throw when AudioContext is unavailable (SSR / unsupported browser)", () => {
  delete window.AudioContext;
  delete window.webkitAudioContext;
  expect(() => playUiSound("click")).not.toThrow();
  expect(() => unlockAudio()).not.toThrow();
});
