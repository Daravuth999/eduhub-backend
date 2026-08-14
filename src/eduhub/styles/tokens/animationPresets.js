/**
 * animationPresets.js — platform-level entrance-sequence presets.
 *
 * A preset composes motionTokens (easing/duration) + a lighting preset +
 * a particle preset into ONE named entrance sequence. An experience's
 * `motion` domain references a preset by id (`motion.presetId`) instead
 * of specifying raw timing — this is what lets a future experience with a
 * completely different number of content groups (e.g. 2 instead of 5)
 * reuse the exact same "cinematicRise" feel without redefining it.
 *
 * `typography.stagger(index)` is a PURE FUNCTION of group index, not a
 * fixed array — any experience's content can have any number of groups.
 */
import { duration, easing, stagger } from "./motionTokens";

function makeTypography({ start, gap, itemDuration }) {
  return {
    itemDuration,
    delayFor: (index) => start + index * gap,
  };
}

export const animationPresets = {
  // The full "Morning Awakening" reference timeline: ~0.5-10s, quiet
  // atmosphere -> staggered typography -> sunrise rise -> bloom -> settle.
  cinematicRise: {
    label: "Cinematic Rise",
    easingId: "premiumEaseOut",
    typography: makeTypography({ start: 0.5, gap: stagger.relaxed, itemDuration: 0.55 }),
    lighting: { start: 2.5, riseDuration: 3.5, bloomDuration: 2 },
    particles: { idleOnly: false },
    totalDuration: 10,
  },
  // Compressed version of the same beats for a same-session return —
  // never replays the full cinematic, but still feels alive, not abrupt.
  quickFade: {
    label: "Quick Fade",
    easingId: "premiumEaseOut",
    typography: makeTypography({ start: 0.05, gap: stagger.tight, itemDuration: 0.35 }),
    lighting: { start: 0.1, riseDuration: 0.9, bloomDuration: 0.6 },
    particles: { idleOnly: false },
    totalDuration: 2,
  },
  // No motion at all — the composed end-state renders immediately.
  // Used for prefers-reduced-motion and any performanceMode="low" config.
  instant: {
    label: "Instant",
    easingId: "premiumEaseOut",
    typography: makeTypography({ start: 0, gap: 0, itemDuration: duration.instant }),
    lighting: { start: 0, riseDuration: 0, bloomDuration: 0 },
    particles: { idleOnly: true },
    totalDuration: 0,
  },
};

export function getAnimationPreset(id) {
  return animationPresets[id] || animationPresets.instant;
}

export function getEasingCurve(id) {
  return easing[id] || easing.premiumEaseOut;
}

export default { animationPresets, getAnimationPreset, getEasingCurve };
