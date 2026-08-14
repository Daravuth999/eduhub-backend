/**
 * liveCoachAudioGate.test.js — V2 Bug 2 proof for the PURE greeting-audio
 * suppression decision. No React, no DOM, no sockets.
 *
 * Proves the narrow contract from the V2 reconciliation addendum §3: only
 * stale/cancelled GREETING audio is suppressed; normal interaction audio is
 * never blocked; `micArmed` alone never suppresses; and old-socket frames can
 * never be accepted as current-generation audio.
 */
import { shouldSuppressGreetingAudio } from "../liveCoachAudioGate";
import { GREETING_STATUS } from "../liveCoachGreetingState";

const base = {
  status: GREETING_STATUS.REQUESTED,
  cancelled: false,
  skipped: false,
  micArmed: false,
  activeAttemptId: "att-1",
  frameAttemptId: "att-1",
  legacyQuarantineActive: false,
  capturedConnectionGeneration: 2,
  activeConnectionGeneration: 2,
};

describe("shouldSuppressGreetingAudio (V2 Bug 2)", () => {
  test("stale tagged greeting audio (non-matching attempt id) is suppressed", () => {
    expect(shouldSuppressGreetingAudio({
      ...base, frameAttemptId: "att-OLD", status: GREETING_STATUS.FIRST_AUDIO,
    })).toBe(true);
  });

  test("matching active greeting audio is allowed", () => {
    expect(shouldSuppressGreetingAudio({
      ...base, frameAttemptId: "att-1", status: GREETING_STATUS.FIRST_AUDIO,
    })).toBe(false);
  });

  test("cancelled current-attempt greeting audio is suppressed", () => {
    expect(shouldSuppressGreetingAudio({
      ...base, cancelled: true, status: GREETING_STATUS.CANCELLED,
    })).toBe(true);
  });

  test("skipped current-attempt greeting audio is suppressed", () => {
    expect(shouldSuppressGreetingAudio({
      ...base, skipped: true, status: GREETING_STATUS.ARMED,
    })).toBe(true);
  });

  test("untagged legacy late greeting audio suppressed ONLY during quarantine", () => {
    const untagged = {
      ...base, frameAttemptId: undefined, activeAttemptId: null,
      status: GREETING_STATUS.CANCELLED,
    };
    expect(shouldSuppressGreetingAudio({ ...untagged, legacyQuarantineActive: true }))
      .toBe(true);
    expect(shouldSuppressGreetingAudio({ ...untagged, legacyQuarantineActive: false }))
      .toBe(false);
  });

  test("normal interaction audio after the greeting boundary is allowed", () => {
    // Untagged audio, armed status, no quarantine → normal interaction audio.
    expect(shouldSuppressGreetingAudio({
      ...base, status: GREETING_STATUS.ARMED, micArmed: true,
      frameAttemptId: undefined, activeAttemptId: "att-1",
      legacyQuarantineActive: false,
    })).toBe(false);
  });

  test("micArmed === true alone never suppresses audio", () => {
    expect(shouldSuppressGreetingAudio({
      ...base, micArmed: true, status: GREETING_STATUS.ARMED,
      frameAttemptId: undefined, legacyQuarantineActive: false,
    })).toBe(false);
  });

  test("old-socket audio cannot be accepted as current-generation audio", () => {
    expect(shouldSuppressGreetingAudio({
      ...base, capturedConnectionGeneration: 1, activeConnectionGeneration: 2,
      // even otherwise-allowable normal audio must be dropped on a stale socket
      frameAttemptId: undefined, status: GREETING_STATUS.ARMED,
    })).toBe(true);
  });
});
