/**
 * lightingTokens.js — platform-level lighting/glow presets.
 *
 * A "lighting preset" describes where light originates and how it reads —
 * not a specific animation. The `motion` domain of an experience config
 * picks a lighting preset by id; `animationPresets.js` decides HOW it
 * animates in (rise/bloom/instant/etc).
 */
export const lightingPresets = {
  sunrise: {
    label: "Sunrise",
    origin: "bottom-center",
    // Color stops read outward from the light's core.
    stops: [
      { at: 0, colorVar: "onBase", alpha: 0.55 },
      { at: 30, colorVar: "softGlow", alpha: 0.30 },
      { at: 55, colorVar: "bloom", alpha: 0.14 },
      { at: 72, colorVar: "bloom", alpha: 0 },
    ],
    bloomScaleRange: [0.85, 1.05, 1],
  },
  spotlight: {
    label: "Spotlight",
    origin: "top-center",
    stops: [
      { at: 0, colorVar: "onBase", alpha: 0.45 },
      { at: 40, colorVar: "softGlow", alpha: 0.20 },
      { at: 70, colorVar: "bloom", alpha: 0 },
    ],
    bloomScaleRange: [0.9, 1, 1],
  },
  ambient: {
    label: "Ambient",
    origin: "center",
    stops: [
      { at: 0, colorVar: "softGlow", alpha: 0.18 },
      { at: 60, colorVar: "bloom", alpha: 0 },
    ],
    bloomScaleRange: [1, 1, 1],
  },
  none: {
    label: "None",
    origin: null,
    stops: [],
    bloomScaleRange: [1, 1, 1],
  },
};

export function getLightingPreset(id) {
  return lightingPresets[id] || lightingPresets.none;
}

export default { lightingPresets, getLightingPreset };
