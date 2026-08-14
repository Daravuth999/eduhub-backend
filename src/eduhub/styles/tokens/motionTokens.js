/**
 * motionTokens.js — platform-level motion tokens.
 *
 * Named easing curves, duration scale, and stagger presets. Any experience
 * animation reads these by name — no cubic-bezier arrays or magic
 * duration numbers should live inside a component.
 */

// ── Easing curves ──────────────────────────────────────────────────────
export const easing = {
  // Soft, premium ease-out with zero overshoot/bounce — the platform
  // default for anything that should feel calm and intentional.
  premiumEaseOut: [0.22, 1, 0.36, 1],
  // The app's pre-existing standard ease-out, kept available by name so
  // experiences that want the "snappier" pre-existing feel still can.
  standardEaseOut: [0.25, 0.8, 0.25, 1],
  linear: "linear",
};

// ── Duration scale (seconds) ──────────────────────────────────────────────
export const duration = {
  instant: 0,
  fast: 0.35,
  base: 0.55,
  slow: 0.9,
  cinematic: 3.5,
};

// ── Stagger presets (seconds between grouped items entering) ─────────────
export const stagger = {
  tight: 0.06,
  relaxed: 0.35,
  // RC2.5 — Page Load Choreography: delay between whole Dashboard sections
  // mounting in sequence (Header -> Hero -> Announcement -> ... ), distinct
  // from `tight`/`relaxed` which stagger items WITHIN one section.
  section: 0.08,
};

// ── Spring presets (RC2.5 Motion System) ──────────────────────────────────
// Physically-based feedback for taps/entrances, as an alternative to a
// fixed-duration tween where the spec calls for "spring transitions."
export const spring = {
  // Snappy, settled press feedback — cards, buttons, badges.
  tap: { type: "spring", stiffness: 400, damping: 28, mass: 0.7 },
  // Slightly looser settle for content entering (progress bars, counters).
  settle: { type: "spring", stiffness: 220, damping: 26 },
};

// ── Ambient cadence (RC2.5 Motion System) ──────────────────────────────────
// Named durations (seconds) for slow, continuous "is this thing alive"
// loops — breathing glows, light sweeps, sparkle twinkles, gentle floats.
// One shared cadence per effect type keeps every component's ambient
// motion feeling like the same system rather than independently-tuned
// timings. Every consumer gates these behind useAmbientActive() so they
// pause off-screen, on a hidden tab, or under prefers-reduced-motion.
export const ambient = {
  breathe: 6,
  sweep: 13,
  sparkle: 2.4,
  float: 4.5,
};

export default { easing, duration, stagger, spring, ambient };
