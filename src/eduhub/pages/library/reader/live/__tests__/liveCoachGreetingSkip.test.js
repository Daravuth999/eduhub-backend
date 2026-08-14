/**
 * liveCoachGreetingSkip.test.js — V2 Bug 6 (frontend) proof for the
 * authoritative reconnect-skip path on the pure greeting controller.
 *
 * The `greeting_state=skipped` frame must: adopt/validate the authoritative
 * attempt id for the current generation, arm the mic EXACTLY ONCE through the
 * explicit skip path, be idempotent, and a stale skipped frame from an old
 * socket generation must never arm.
 */
import { createGreetingController, GREETING_STATUS } from "../liveCoachGreetingState";

describe("greeting controller onSkipped (V2 Bug 6)", () => {
  test("completed reconnect skip arms mic exactly once and adopts attempt id", () => {
    const c = createGreetingController();
    const { connectionGeneration } = c.onConnectionOpen();
    const r = c.onSkipped({ attemptId: "att-prior", connectionGeneration });
    expect(r.armMic).toBe(true);
    expect(r.trigger).toBe("skip");
    expect(r.attemptId).toBe("att-prior");
    expect(c.micIsArmed()).toBe(true);
    expect(c.getAttemptId()).toBe("att-prior");
    expect(c.getState().status).toBe(GREETING_STATUS.ARMED);
    // Idempotent — a second skipped does not re-arm.
    const r2 = c.onSkipped({ attemptId: "att-prior", connectionGeneration });
    expect(r2.armMic).toBe(false);
    expect(r2.ignored).toBe(true);
  });

  test("stale skipped frame from an OLD generation cannot arm the mic", () => {
    const c = createGreetingController();
    c.onConnectionOpen();                 // generation 1
    const { connectionGeneration } = c.onConnectionOpen(); // generation 2
    const stale = c.onSkipped({ attemptId: "att-x", connectionGeneration: connectionGeneration - 1 });
    expect(stale.stale).toBe(true);
    expect(stale.armMic).toBe(false);
    expect(c.micIsArmed()).toBe(false);
  });

  test("after a skip a late greeting turn_complete cannot reopen the gate", () => {
    const c = createGreetingController();
    const { connectionGeneration } = c.onConnectionOpen();
    c.onSkipped({ attemptId: "att-prior", connectionGeneration });
    const tc = c.onTurnComplete({ attemptId: "att-prior", connectionGeneration });
    expect(tc.ignored).toBe(true);        // already armed
    expect(c.micIsArmed()).toBe(true);
  });

  test("skip does not arm a SECOND time even via playback drain", () => {
    const c = createGreetingController();
    const { connectionGeneration } = c.onConnectionOpen();
    c.onSkipped({ attemptId: "att-prior", connectionGeneration });
    // A drained callback that arrives after a skip must not re-arm.
    const d = c.onPlaybackDrained({ attemptId: "att-prior", connectionGeneration });
    expect(d.armMic).toBeFalsy();
  });
});
