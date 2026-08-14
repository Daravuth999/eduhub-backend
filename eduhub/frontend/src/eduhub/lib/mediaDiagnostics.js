/**
 * mediaDiagnostics.js — honest playback failure/stall surfacing for
 * <video>/<audio> elements. Never masks a real problem behind a native
 * spinner: reports the browser's own MediaError when one exists, and flags
 * a genuine stall (buffering with no progress past a threshold) as a
 * distinct, honest state — never "pretend ready".
 */

const MEDIA_ERROR_MESSAGES = {
  1: "Loading was aborted.",
  2: "A network error interrupted loading.",
  3: "The media could not be decoded.",
  4: "This media format or source is not supported by your browser.",
};

/** Reads the real MediaError off a media element, or null if there is none. */
export function describeMediaError(el) {
  const err = el?.error;
  if (!err) return null;
  return MEDIA_ERROR_MESSAGES[err.code] || "The media failed to load.";
}

/** How long a "waiting" (buffering) event must persist before it's reported
 * as a stall rather than normal, brief rebuffering. */
export const STALL_THRESHOLD_MS = 8000;
