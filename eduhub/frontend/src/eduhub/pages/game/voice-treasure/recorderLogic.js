/**
 * recorderLogic.js — pure (no DOM, no MediaRecorder) helpers for the voice
 * recorder, so the timing/cleanup/duplicate-submit rules are unit-testable
 * under the standard CRA test harness without a browser audio stack.
 */

export const REC_IDLE = "idle";
export const REC_REQUESTING = "requesting";
export const REC_PERMISSION_DENIED = "permission_denied";
export const REC_RECORDING = "recording";
export const REC_RECORDED = "recorded";
export const REC_SUBMITTING = "submitting";
export const REC_ERROR = "error";

export function formatDuration(totalSeconds) {
  const s = Math.max(0, Math.floor(totalSeconds || 0));
  const mm = String(Math.floor(s / 60)).padStart(2, "0");
  const ss = String(s % 60).padStart(2, "0");
  return `${mm}:${ss}`;
}

/** Stop is allowed only once the minimum duration is reached. */
export function canStop(elapsedSec, minSec) {
  return Number(elapsedSec) >= Number(minSec || 0);
}

/** Recording must auto-stop at the maximum duration. */
export function mustAutoStop(elapsedSec, maxSec) {
  return Number(maxSec) > 0 && Number(elapsedSec) >= Number(maxSec);
}

/** A submit may proceed only from `recorded` and only when not already
 *  submitting (duplicate-submit prevention). */
export function canSubmit({ status, submitting }) {
  return status === REC_RECORDED && !submitting;
}

/**
 * Orchestrate cleanup of all leak-prone resources. Pure: callers inject the
 * side-effecting fns so this is fully testable with spies. Safe to call
 * multiple times and with partial state.
 */
export function cleanupResources(res, fns) {
  const { stream, timerId, objectUrl } = res || {};
  const { stopTracks, clearTimer, revokeUrl } = fns || {};
  if (timerId != null && clearTimer) clearTimer(timerId);
  if (stream && stopTracks) stopTracks(stream);
  if (objectUrl && revokeUrl) revokeUrl(objectUrl);
}

/** Minimal state transition guard used by the hook's reducer. */
export function nextStatus(current, event) {
  const map = {
    [REC_IDLE]: { request: REC_REQUESTING },
    [REC_REQUESTING]: { granted: REC_RECORDING, denied: REC_PERMISSION_DENIED, fail: REC_ERROR },
    [REC_RECORDING]: { stopped: REC_RECORDED, fail: REC_ERROR },
    [REC_RECORDED]: { submit: REC_SUBMITTING, reset: REC_IDLE },
    [REC_SUBMITTING]: { done: REC_RECORDED, fail: REC_RECORDED, reset: REC_IDLE },
    [REC_PERMISSION_DENIED]: { request: REC_REQUESTING, reset: REC_IDLE },
    [REC_ERROR]: { reset: REC_IDLE, request: REC_REQUESTING },
  };
  return (map[current] && map[current][event]) || current;
}
