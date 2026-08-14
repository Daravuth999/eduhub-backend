/**
 * focusZone.js — pure geometry for the Teleprompter's "center focus"
 * reading mode: the active sentence stays in a comfortable, STILL reading
 * zone while previous text recedes upward/fades and upcoming text
 * approaches from below (see Teleprompter.jsx's centerFocus rendering).
 *
 * Deliberately NOT a hardcoded percentage. computeFocusAnchorRatio derives
 * a fraction of the ACTUAL scroll container's height (already whatever is
 * left after the video, controls, and tab bar have taken their share on
 * THIS device) — a small iPhone and a large iPhone get different real
 * anchor pixel positions from calling the same function, because the
 * container height passed in already differs. Bilingual mode and larger
 * font sizes shift the ratio because they change how much vertical room
 * the active sentence itself needs.
 */

const MIN_RATIO = 0.22;
const MAX_RATIO = 0.46;
const BASE_RATIO = 0.34;

/** Fraction (0..1) of the scroll container's own clientHeight at which the
 * active sentence should be anchored. Pure — no DOM access, easy to unit
 * test independently of any specific device. */
export function computeFocusAnchorRatio({ bilingual = false, fontScale = 1 } = {}) {
  let ratio = BASE_RATIO;
  // Khmer adds a second line under the active sentence — anchoring a touch
  // higher leaves that line room to breathe without crowding the bottom
  // edge of the reading area.
  if (bilingual) ratio += 0.04;
  // A larger font makes the active sentence itself taller — anchor higher
  // so there's still comfortable room below for the words to sit before
  // the next sentence starts approaching.
  if (fontScale > 1.15) ratio -= 0.03;
  else if (fontScale < 0.9) ratio += 0.02;
  return Math.max(MIN_RATIO, Math.min(MAX_RATIO, ratio));
}

// Minimum trailing spacer, in px — a small breathing-room floor so the very
// end of a transcript never feels like it stops abruptly, even when no
// extra scroll room is actually needed (matches the visual weight of the
// generous bottom padding already used elsewhere in this component).
const MIN_TRAILING_SPACER_PX = 16;

/**
 * How tall the trailing spacer after the LAST sentence needs to be so that
 * sentence can still reach the center-focus anchor when it becomes active
 * — the presentation-only fix for useAutoFollow's existing
 * `Math.min(maxScroll, ...)` clamp running out of room right at the end of
 * a document. Pure geometry: given the reading area's own real height, the
 * anchor's real pixel position within it, and the last sentence's own
 * rendered height, returns exactly how much extra scrollable room is
 * needed — never more. A sentence that ALREADY sits far enough from the
 * end of its content needs no extra room at all, so this floors at
 * MIN_TRAILING_SPACER_PX rather than a large fixed value, which is what
 * keeps a short transcript (everything already fits on screen) from
 * gaining a wall of empty scrollable space it never had before.
 */
export function computeTrailingSpacerPx({ containerHeight, anchorPx, lastElementHeight = 0, minPx = MIN_TRAILING_SPACER_PX }) {
  if (!Number.isFinite(containerHeight) || !Number.isFinite(anchorPx)) return minPx;
  const needed = containerHeight - anchorPx - lastElementHeight / 2;
  return Math.max(minPx, Math.round(needed));
}

// Distance-based recede/approach styling. Clamped so a very long lesson
// never has to compute meaningfully distinct styles for dozens of
// off-screen sentences — anything beyond FAR_DISTANCE just renders at the
// same "far" resting value.
const FAR_DISTANCE = 4;

/**
 * Style for a sentence at `distance` sentences away from the active one
 * (negative = already spoken, positive = upcoming, 0 = active). Pure,
 * transform/opacity only (GPU-compositable, never triggers layout) —
 * safe to compute on every sentence-transition without causing reflow.
 */
export function focusZoneStyle(distance, { reducedMotion = false } = {}) {
  if (distance === 0) {
    return { opacity: 1, transform: "translateY(0px) scale(1)" };
  }
  const clamped = Math.max(-FAR_DISTANCE, Math.min(FAR_DISTANCE, distance));
  if (clamped < 0) {
    // Already spoken — recedes upward and fades the further back it is.
    const steps = -clamped;
    const opacity = Math.max(0.12, 0.62 - steps * 0.14);
    const rise = reducedMotion ? 0 : Math.min(14, steps * 5);
    return { opacity, transform: `translateY(${rise === 0 ? 0 : -rise}px) scale(1)` };
  }
  // Upcoming — dimmer the further ahead, drifts in slightly from below.
  const opacity = Math.max(0.32, 0.82 - clamped * 0.12);
  const drop = reducedMotion ? 0 : Math.min(10, clamped * 3);
  return { opacity, transform: `translateY(${drop}px) scale(1)` };
}
