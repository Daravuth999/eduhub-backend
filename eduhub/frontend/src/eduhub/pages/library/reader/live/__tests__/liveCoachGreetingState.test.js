/**
 * liveCoachGreetingState.test.js — pure controller proof for the attempt-scoped
 * greeting lifecycle. No React, no DOM, no sockets. Proves the locked state
 * transitions from EMERGENT_PHASE0_1_REFINED_BUILD_PROMPT.md §D (frontend
 * greeting tests 1–12).
 */
import {
  createGreetingController,
  GREETING_TIMEOUTS,
  GREETING_STATUS,
} from "../liveCoachGreetingState";

function openWithAuthoritativeRequest(c, attemptId = "att-1") {
  const { connectionGeneration } = c.onConnectionOpen();
  c.onServerRequested({ attemptId, connectionGeneration });
  return connectionGeneration;
}

describe("liveCoachGreetingState (pure controller)", () => {
  test("constants are present and ordered sanely", () => {
    expect(GREETING_TIMEOUTS.GREETING_REQUEST_TIMEOUT_MS).toBe(5000);
    expect(GREETING_TIMEOUTS.GREETING_FIRST_AUDIO_TIMEOUT_MS).toBe(8000);
    expect(GREETING_TIMEOUTS.GREETING_TURN_COMPLETE_TIMEOUT_MS).toBe(20000);
    expect(GREETING_TIMEOUTS.GREETING_PLAYBACK_DRAIN_TIMEOUT_MS).toBe(10000);
  });

  // 1
  test("legacy coach_greeting_sent maps to requested and never arms mic", () => {
    const c = createGreetingController();
    const { connectionGeneration } = c.onConnectionOpen();
    const r = c.onLegacyGreetingSent({ connectionGeneration });
    expect(r.treatedAs).toBe(GREETING_STATUS.REQUESTED);
    expect(c.getState().status).toBe(GREETING_STATUS.REQUESTED);
    expect(c.micIsArmed()).toBe(false);
    expect(c.getState().isAuthoritative).toBe(false);
  });

  test("legacy frame does not replace an active authoritative attempt", () => {
    const c = createGreetingController();
    const gen = openWithAuthoritativeRequest(c, "server-att");
    const r = c.onLegacyGreetingSent({ connectionGeneration: gen });
    expect(r.replaced).toBe(false);
    expect(c.getAttemptId()).toBe("server-att");
    expect(c.getState().isAuthoritative).toBe(true);
  });

  // 2
  test("requested alone does not arm", () => {
    const c = createGreetingController();
    openWithAuthoritativeRequest(c);
    expect(c.micIsArmed()).toBe(false);
    expect(c.getState().status).toBe(GREETING_STATUS.REQUESTED);
  });

  // 3
  test("first audio alone does not arm", () => {
    const c = createGreetingController();
    const gen = openWithAuthoritativeRequest(c);
    const r = c.onFirstAudio({ attemptId: "att-1", connectionGeneration: gen });
    expect(r.firstAudioSeen).toBe(true);
    expect(c.micIsArmed()).toBe(false);
  });

  // 4
  test("turn completion alone does not arm while playback is pending", () => {
    const c = createGreetingController();
    const gen = openWithAuthoritativeRequest(c);
    c.onFirstAudio({ attemptId: "att-1", connectionGeneration: gen });
    const r = c.onTurnComplete({ attemptId: "att-1", connectionGeneration: gen });
    expect(r.accepted).toBe(true);
    expect(r.armDrainWait).toBe(true);
    expect(c.micIsArmed()).toBe(false);
  });

  // 5
  test("playback drain before turn completion does not arm", () => {
    const c = createGreetingController();
    const gen = openWithAuthoritativeRequest(c);
    c.onFirstAudio({ attemptId: "att-1", connectionGeneration: gen });
    const r = c.onPlaybackDrained({ attemptId: "att-1", connectionGeneration: gen });
    expect(r.ignored).toBe(true);
    expect(r.reason).toBe("no_turn_complete");
    expect(c.micIsArmed()).toBe(false);
  });

  // 6
  test("matching turn completion plus safe drain arms exactly once", () => {
    const c = createGreetingController();
    const gen = openWithAuthoritativeRequest(c);
    c.onFirstAudio({ attemptId: "att-1", connectionGeneration: gen });
    c.onTurnComplete({ attemptId: "att-1", connectionGeneration: gen });
    const r1 = c.onPlaybackDrained({ attemptId: "att-1", connectionGeneration: gen });
    expect(r1.armMic).toBe(true);
    expect(r1.trigger).toBe("playback_complete");
    // Second drain cannot double-arm.
    const r2 = c.onPlaybackDrained({ attemptId: "att-1", connectionGeneration: gen });
    expect(r2.armMic).toBe(false);
    expect(c.micIsArmed()).toBe(true);
  });

  // 7
  test("stale attempt ID cannot arm", () => {
    const c = createGreetingController();
    const gen = openWithAuthoritativeRequest(c, "att-A");
    c.onFirstAudio({ attemptId: "att-A", connectionGeneration: gen });
    c.onTurnComplete({ attemptId: "att-A", connectionGeneration: gen });
    const r = c.onPlaybackDrained({ attemptId: "att-B", connectionGeneration: gen });
    expect(r.stale).toBe(true);
    expect(c.micIsArmed()).toBe(false);
  });

  // 8
  test("stale connection generation cannot arm", () => {
    const c = createGreetingController();
    const gen1 = openWithAuthoritativeRequest(c, "att-A");
    c.onFirstAudio({ attemptId: "att-A", connectionGeneration: gen1 });
    c.onTurnComplete({ attemptId: "att-A", connectionGeneration: gen1 });
    // A new socket opens (generation bumps); the old-generation drain is stale.
    const gen2 = c.onConnectionOpen().connectionGeneration;
    expect(gen2).not.toBe(gen1);
    const r = c.onPlaybackDrained({ attemptId: "att-A", connectionGeneration: gen1 });
    expect(r.stale).toBe(true);
    expect(c.micIsArmed()).toBe(false);
  });

  // 9
  test("repeated frames cannot double-arm", () => {
    const c = createGreetingController();
    const gen = openWithAuthoritativeRequest(c);
    c.onFirstAudio({ attemptId: "att-1", connectionGeneration: gen });
    c.onFirstAudio({ attemptId: "att-1", connectionGeneration: gen }); // repeat
    c.onTurnComplete({ attemptId: "att-1", connectionGeneration: gen });
    const dup = c.onTurnComplete({ attemptId: "att-1", connectionGeneration: gen });
    expect(dup.accepted).toBe(false);
    expect(dup.alreadyComplete).toBe(true);
    const a1 = c.onPlaybackDrained({ attemptId: "att-1", connectionGeneration: gen });
    expect(a1.armMic).toBe(true);
    const a2 = c.onPlaybackDrained({ attemptId: "att-1", connectionGeneration: gen });
    expect(a2.armMic).toBe(false);
  });

  // 10
  test("fallback requires playback cancellation before controlled arm (legacy path)", () => {
    const c = createGreetingController();
    const { connectionGeneration } = c.onConnectionOpen();
    // Legacy backend (no authoritative request) → request watchdog fallback.
    const fb = c.requestFallback({ reason: "request_timeout", connectionGeneration });
    expect(fb.needPlaybackCancel).toBe(true);
    expect(fb.awaitCancelAck).toBe(false);
    expect(c.micIsArmed()).toBe(false);
    const armed = c.onPlaybackCancelled({ connectionGeneration });
    expect(armed.armMic).toBe(true);
    expect(armed.trigger).toBe("controlled_fallback");
  });

  test("fallback on new backend waits for cancelled ack before arming", () => {
    const c = createGreetingController();
    const gen = openWithAuthoritativeRequest(c, "att-1");
    c.onFirstAudio({ attemptId: "att-1", connectionGeneration: gen });
    const fb = c.requestFallback({ reason: "turn_complete_timeout", connectionGeneration: gen });
    expect(fb.awaitCancelAck).toBe(true);
    // Local playback cancelled, but still awaiting server ack → no arm yet.
    const a1 = c.onPlaybackCancelled({ attemptId: "att-1", connectionGeneration: gen });
    expect(a1.armMic).toBe(false);
    // Server confirms cancellation → controlled arm.
    const a2 = c.onCancelledAck({ attemptId: "att-1", connectionGeneration: gen });
    expect(a2.armMic).toBe(true);
    expect(a2.trigger).toBe("controlled_fallback");
  });

  test("backend failed enters controlled fallback (no cancel-ack wait)", () => {
    const c = createGreetingController();
    const gen = openWithAuthoritativeRequest(c, "att-1");
    const r = c.onFailed({ attemptId: "att-1", reason: "kicker_send_failed", connectionGeneration: gen });
    expect(r.needPlaybackCancel).toBe(true);
    expect(r.awaitCancelAck).toBe(false);
    const armed = c.onPlaybackCancelled({ attemptId: "att-1", connectionGeneration: gen });
    expect(armed.armMic).toBe(true);
  });

  // 11
  test("interaction turn_complete after greeting cannot reopen the gate", () => {
    const c = createGreetingController();
    const gen = openWithAuthoritativeRequest(c);
    c.onFirstAudio({ attemptId: "att-1", connectionGeneration: gen });
    c.onTurnComplete({ attemptId: "att-1", connectionGeneration: gen });
    c.onPlaybackDrained({ attemptId: "att-1", connectionGeneration: gen });
    expect(c.micIsArmed()).toBe(true);
    // A later interaction turn_complete must be ignored, not re-open the gate.
    const r = c.onTurnComplete({ attemptId: "att-1", connectionGeneration: gen });
    expect(r.ignored).toBe(true);
    expect(c.micIsArmed()).toBe(true);
  });

  // 12
  test("cleanup invalidates timers/callbacks (stale generation rejected)", () => {
    const c = createGreetingController();
    const gen = openWithAuthoritativeRequest(c);
    c.onFirstAudio({ attemptId: "att-1", connectionGeneration: gen });
    c.onTurnComplete({ attemptId: "att-1", connectionGeneration: gen });
    c.cleanup();
    // Any callback fired after cleanup for the old generation is stale.
    const r = c.onPlaybackDrained({ attemptId: "att-1", connectionGeneration: gen });
    expect(r.stale).toBe(true);
    expect(c.micIsArmed()).toBe(false);
  });
});
