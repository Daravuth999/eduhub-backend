/**
 * liveCoachAudioGate.js — PURE greeting-audio suppression decision for the
 * EduTalk Live Coach (V2 Bug 2).
 *
 * The defect being corrected: late/stale greeting audio could play over an
 * armed mic, while an over-broad rule ("suppress everything after micArmed")
 * wrongly blocked NORMAL interaction audio. This helper implements the narrow,
 * correct contract from the V2 reconciliation addendum §3:
 *
 *   1. Tagged audio with a NON-matching greeting_attempt_id during the greeting
 *      window → suppress (stale audio from a replaced attempt).
 *   2. Tagged audio for the CURRENT attempt after that attempt was cancelled,
 *      skipped, or replaced → suppress.
 *   3. Untagged legacy audio after a greeting fallback → suppress ONLY while the
 *      legacy greeting quarantine is active.
 *   4. Once the greeting boundary is complete and the controller is in normal
 *      interaction mode, all normal coach audio enqueues exactly as before.
 *   5. `micArmed === true` by itself is NEVER a global suppression condition.
 *   6. Every audio callback uses the socket generation CAPTURED when its socket
 *      handler was created, not a generation read later — so an old-socket frame
 *      can never masquerade as the current generation.
 *
 * NO React, NO timers, NO side effects — fully unit-testable.
 */
import { GREETING_STATUS } from "./liveCoachGreetingState";

/**
 * Decide whether a single inbound coach audio frame should be SUPPRESSED
 * (dropped before `player.enqueue`). Returns a boolean.
 *
 * @param {object} p
 * @param {string|null} p.status                       controller greeting status
 * @param {boolean} p.cancelled                        greeting attempt cancelled
 * @param {boolean} p.skipped                          greeting attempt skipped
 * @param {boolean} p.micArmed                         mic already armed (NOT used alone)
 * @param {string|null} p.activeAttemptId              controller's active attempt id
 * @param {string|null|undefined} p.frameAttemptId     this frame's greeting_attempt_id
 * @param {boolean} p.legacyQuarantineActive           legacy greeting quarantine flag
 * @param {number|null} p.capturedConnectionGeneration generation captured at socket creation
 * @param {number|null} p.activeConnectionGeneration   current controller generation
 */
export function shouldSuppressGreetingAudio({
  status,
  cancelled,
  skipped,
  // eslint-disable-next-line no-unused-vars
  micArmed, // intentionally unused: Rule 5 — never suppress on micArmed alone
  activeAttemptId,
  frameAttemptId,
  legacyQuarantineActive,
  capturedConnectionGeneration,
  activeConnectionGeneration,
} = {}) {
  // Rule 6 — an audio callback created by an OLD socket generation can never be
  // accepted as current-generation audio. If the captured generation does not
  // match the active generation, the frame belongs to a stale socket.
  if (
    capturedConnectionGeneration != null &&
    activeConnectionGeneration != null &&
    capturedConnectionGeneration !== activeConnectionGeneration
  ) {
    return true;
  }

  const hasFrameId = frameAttemptId != null && frameAttemptId !== "";
  const hasActiveId = activeAttemptId != null && activeAttemptId !== "";
  const greetingTerminated = cancelled === true || skipped === true;

  // Inside the greeting window until the controller reaches idle/armed (a
  // terminated attempt still counts as "had a greeting context").
  const inGreetingWindow =
    status != null &&
    status !== GREETING_STATUS.IDLE &&
    status !== GREETING_STATUS.ARMED;

  if (hasFrameId && hasActiveId) {
    if (frameAttemptId !== activeAttemptId) {
      // Rule 1 — stale tagged greeting audio from a different (replaced)
      // attempt. Suppress while a greeting context exists.
      if (inGreetingWindow || greetingTerminated) return true;
    } else if (greetingTerminated) {
      // Rule 2 — current-attempt greeting audio AFTER cancel/skip/replace.
      return true;
    }
  }

  // Rule 3 — untagged legacy late greeting audio: suppress ONLY during the
  // active legacy greeting quarantine.
  if (!hasFrameId && legacyQuarantineActive === true) {
    return true;
  }

  // Rule 4 / Rule 5 — normal interaction audio (and matching active greeting
  // audio that has not been terminated) enqueues exactly as before.
  return false;
}

export default shouldSuppressGreetingAudio;
