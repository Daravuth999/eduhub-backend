/**
 * Tiny haptic helper.
 *
 * Wraps `navigator.vibrate` so it:
 *   • Silently no-ops on iOS / desktop (where the API is missing).
 *   • Respects `prefers-reduced-motion` — bails out entirely.
 *   • Never throws — wrapped in try / catch.
 */

export const VibratePattern = {
  tiny: [30],
  nice: [50, 30, 50],
  big: [80, 40, 80, 40, 80],
  huge: [100, 50, 100, 50, 200],
  spend: [40, 20, 40],
  lowBalance: [20, 100, 20],
} as const;

export type VibratePatternKey = keyof typeof VibratePattern;

function prefersReducedMotion(): boolean {
  if (typeof window === "undefined" || typeof window.matchMedia !== "function") {
    return false;
  }
  try {
    return window.matchMedia("(prefers-reduced-motion: reduce)").matches;
  } catch {
    return false;
  }
}

export function vibrate(pattern: number | readonly number[]): void {
  try {
    if (typeof navigator === "undefined") return;
    if (typeof navigator.vibrate !== "function") return;
    if (prefersReducedMotion()) return;
    navigator.vibrate(pattern as number | number[]);
  } catch {
    /* never throws */
  }
}
