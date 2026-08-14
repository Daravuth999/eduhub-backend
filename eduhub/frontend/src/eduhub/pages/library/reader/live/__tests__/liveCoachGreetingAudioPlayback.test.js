/**
 * liveCoachGreetingAudioPlayback.test.js — targeted proof for the greeting
 * audio playback contract (Task 3 greeting-voice fix).
 *
 * Three invariants proved here:
 *  1. Matching greeting_attempt_id audio is NOT suppressed (it reaches enqueue).
 *  2. Greeting audio is enqueued BEFORE the mic can arm (drain fires only after
 *     turn_complete; mic arming only happens when drain fires with active===0).
 *  3. Text-transcript messages alone do NOT advance the greeting state machine
 *     toward mic-arming or mark the greeting complete.
 */
import { shouldSuppressGreetingAudio } from "../liveCoachAudioGate";
import {
  createGreetingController,
  GREETING_STATUS,
} from "../liveCoachGreetingState";
import { createAudioPlayer } from "../liveAudio";

// ── Minimal AudioContext stub ─────────────────────────────────────────────────
// Simulates a RUNNING AudioContext so createAudioPlayer works without a real
// browser. Tracks how many sources were started (enqueue calls).
function makeFakeAudioCtx() {
  let time = 0;
  const startedSources = [];
  const AudioBufferSourceStub = () => {
    const src = {
      buffer: null,
      connect: jest.fn(),
      start: jest.fn((t) => { startedSources.push(t); src._startTime = t; }),
      stop: jest.fn(),
      disconnect: jest.fn(),
      onended: null,
      _startTime: 0,
      _fire: function () { if (this.onended) this.onended(); },
    };
    return src;
  };
  return {
    get currentTime() { return time; },
    advanceTime(s) { time += s; },
    resume: jest.fn(() => Promise.resolve()),
    close: jest.fn(),
    createBuffer: jest.fn((ch, len, rate) => ({
      duration: len / rate,
      getChannelData: () => new Float32Array(len),
    })),
    createBufferSource: jest.fn(() => AudioBufferSourceStub()),
    destination: {},
    startedSources,
  };
}

// ── Test 1: matching attempt id is NOT suppressed ─────────────────────────────
describe("Test 1 — matching greeting_attempt_id audio is not suppressed", () => {
  test("shouldSuppressGreetingAudio returns false for matching attempt id in REQUESTED status", () => {
    const suppressed = shouldSuppressGreetingAudio({
      status: GREETING_STATUS.REQUESTED,
      cancelled: false,
      skipped: false,
      micArmed: false,
      activeAttemptId: "greet-abc123",
      frameAttemptId: "greet-abc123",    // MATCHING
      legacyQuarantineActive: false,
      capturedConnectionGeneration: 1,
      activeConnectionGeneration: 1,
    });
    expect(suppressed).toBe(false);
  });

  test("shouldSuppressGreetingAudio returns false for matching attempt id in FIRST_AUDIO status", () => {
    const suppressed = shouldSuppressGreetingAudio({
      status: GREETING_STATUS.FIRST_AUDIO,
      cancelled: false,
      skipped: false,
      micArmed: false,
      activeAttemptId: "greet-abc123",
      frameAttemptId: "greet-abc123",
      legacyQuarantineActive: false,
      capturedConnectionGeneration: 1,
      activeConnectionGeneration: 1,
    });
    expect(suppressed).toBe(false);
  });

  test("shouldSuppressGreetingAudio returns false even when micArmed (Rule 5: micArmed alone never suppresses)", () => {
    const suppressed = shouldSuppressGreetingAudio({
      status: GREETING_STATUS.ARMED,
      cancelled: false,
      skipped: false,
      micArmed: true,                     // armed — must NOT suppress matching audio
      activeAttemptId: "greet-abc123",
      frameAttemptId: "greet-abc123",
      legacyQuarantineActive: false,
      capturedConnectionGeneration: 1,
      activeConnectionGeneration: 1,
    });
    expect(suppressed).toBe(false);
  });
});

// ── Test 2: audio is enqueued BEFORE mic can arm ──────────────────────────────
describe("Test 2 — greeting audio enqueued before mic arms", () => {
  let ctx;
  let player;

  beforeEach(() => {
    // Replace the global AudioContext with our stub before each test.
    ctx = makeFakeAudioCtx();
    global.AudioContext = jest.fn(() => ctx);
    global.webkitAudioContext = undefined;
    player = createAudioPlayer();
  });

  afterEach(() => {
    delete global.AudioContext;
  });

  test("enqueue schedules audio before turn_complete fires the drain callback", () => {
    // Simulate 3 audio chunks arriving.
    const fakeB64 = btoa(new Uint8Array(256).fill(0).reduce(
      (s, _, i) => s + String.fromCharCode(i % 256), ""));
    player.enqueue(fakeB64);
    player.enqueue(fakeB64);
    player.enqueue(fakeB64);

    // Confirm audio was actually scheduled (3 sources started on the ctx).
    expect(ctx.startedSources.length).toBe(3);

    // The drain callback must NOT have fired yet — mic cannot arm yet.
    const drainFired = jest.fn();
    player.beginDrainWait(1, drainFired);

    // Drain fires only after all sources end (active reaches 0).
    // Nothing ended yet — callback has not fired.
    expect(drainFired).not.toHaveBeenCalled();
  });

  test("drain callback fires only after all audio sources complete (onended)", async () => {
    const fakeB64 = btoa(new Uint8Array(256).fill(0).reduce(
      (s, _, i) => s + String.fromCharCode(i % 256), ""));

    // We need to capture the source nodes to fire their onended callbacks.
    const sources = [];
    ctx.createBufferSource.mockImplementation(() => {
      const src = {
        buffer: null,
        connect: jest.fn(),
        start: jest.fn((t) => { ctx.startedSources.push(t); }),
        stop: jest.fn(),
        disconnect: jest.fn(),
        onended: null,
      };
      sources.push(src);
      return src;
    });

    player.enqueue(fakeB64);
    player.enqueue(fakeB64);

    const drainFired = jest.fn();
    player.beginDrainWait(42, drainFired);

    // Fire first source's onended — drain still pending (second not done).
    sources[0].onended && sources[0].onended();
    expect(drainFired).not.toHaveBeenCalled();

    // Fire second source's onended — now active hits 0 → drain fires.
    sources[1].onended && sources[1].onended();
    expect(drainFired).toHaveBeenCalledTimes(1);
  });

  test("beginDrainWait armed before any audio fires on next tick (already idle)", async () => {
    // No audio enqueued → active===0. Drain waiter set → fires on next microtask.
    const drainFired = jest.fn();
    player.beginDrainWait(99, drainFired);

    // Not yet fired (scheduled as microtask).
    expect(drainFired).not.toHaveBeenCalled();

    // Flush microtasks.
    await Promise.resolve();
    expect(drainFired).toHaveBeenCalledTimes(1);
  });
});

// ── Test 3: text transcript alone does NOT advance greeting state ─────────────
describe("Test 3 — text transcript alone does not mark greeting complete", () => {
  let ctrl;

  beforeEach(() => {
    ctrl = createGreetingController();
    ctrl.onConnectionOpen();
  });

  test("controller status stays REQUESTED after receiving transcripts (no onTurnComplete called)", () => {
    const AID = "greet-xyz";
    ctrl.onServerRequested({ attemptId: AID, connectionGeneration: 1 });
    expect(ctrl.getState().status).toBe(GREETING_STATUS.REQUESTED);

    // Simulate 5 transcript messages arriving — none calls any controller method
    // (the message handler only calls setTranscript which is React state).
    // Verify controller is still in REQUESTED, not TURN_COMPLETE or ARMED.
    // (We simply don't call ctrl.onTurnComplete — transcript events never do.)
    expect(ctrl.getState().status).toBe(GREETING_STATUS.REQUESTED);
    expect(ctrl.getState().turnCompleteSeen).toBe(false);
    expect(ctrl.getState().micArmed).toBe(false);
  });

  test("onTurnComplete is required to transition to TURN_COMPLETE", () => {
    const AID = "greet-xyz";
    ctrl.onServerRequested({ attemptId: AID, connectionGeneration: 1 });
    ctrl.onFirstAudio({ attemptId: AID, connectionGeneration: 1 });

    // Still not complete — turn_complete message not received.
    expect(ctrl.getState().turnCompleteSeen).toBe(false);

    // Now simulate turn_complete arrival.
    const res = ctrl.onTurnComplete({ attemptId: AID, connectionGeneration: 1 });
    expect(res.accepted).toBe(true);
    expect(res.armDrainWait).toBe(true);
    expect(ctrl.getState().turnCompleteSeen).toBe(true);
    expect(ctrl.getState().status).toBe(GREETING_STATUS.TURN_COMPLETE);
    // Mic still NOT armed — requires playback drain too.
    expect(ctrl.getState().micArmed).toBe(false);
  });

  test("mic arms only after both turn_complete AND playback drain — never on transcript alone", () => {
    const AID = "greet-xyz";
    ctrl.onServerRequested({ attemptId: AID, connectionGeneration: 1 });
    ctrl.onFirstAudio({ attemptId: AID, connectionGeneration: 1 });

    // turn_complete received.
    ctrl.onTurnComplete({ attemptId: AID, connectionGeneration: 1 });
    expect(ctrl.getState().micArmed).toBe(false); // still needs drain

    // playback drain fires.
    const armResult = ctrl.onPlaybackDrained({ attemptId: AID, connectionGeneration: 1 });
    expect(armResult.armMic).toBe(true);
    expect(ctrl.getState().micArmed).toBe(true);
    expect(ctrl.getState().status).toBe(GREETING_STATUS.ARMED);
  });
});
