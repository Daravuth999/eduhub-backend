/**
 * particlePresets.js — platform-level ambient particle-field presets.
 *
 * Deterministic (fixed positions/delays, not randomized per-render) so
 * there is nothing to recompute on resize and server/client output never
 * mismatches. Pure divs — no canvas/WebGL, kept intentionally lightweight
 * for older mobile devices.
 */
export const particlePresets = {
  sparseStars: {
    label: "Sparse stars",
    kind: "twinkle",
    items: [
      { x: "8%", y: "18%", size: 2, delay: 0 },
      { x: "22%", y: "10%", size: 1.5, delay: 1.1 },
      { x: "78%", y: "14%", size: 2, delay: 0.6 },
      { x: "91%", y: "26%", size: 1.5, delay: 1.8 },
      { x: "52%", y: "8%", size: 1.5, delay: 2.4 },
      { x: "65%", y: "20%", size: 1, delay: 0.9 },
    ],
    twinkleDuration: 6,
    maxOpacity: 0.55,
  },
  floatingMotes: {
    label: "Floating motes",
    kind: "drift-up",
    items: [
      { x: "15%", size: 3, delay: 0, duration: 14 },
      { x: "38%", size: 2, delay: 4, duration: 18 },
      { x: "62%", size: 3, delay: 8, duration: 16 },
      { x: "85%", size: 2, delay: 2, duration: 20 },
    ],
    driftDistance: 140,
    maxOpacity: 0.5,
  },
  none: {
    label: "None",
    kind: "none",
    items: [],
    maxOpacity: 0,
  },
};

export function getParticlePreset(id) {
  return particlePresets[id] || particlePresets.none;
}

export default { particlePresets, getParticlePreset };
