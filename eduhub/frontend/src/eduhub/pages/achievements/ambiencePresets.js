// ambiencePresets.js — Trophy Ambience effect catalog (Achievement Center).
//
// 15 curated live-animation presets an admin can assign per trophy from
// Author Studio (reward.celebration_effect). Every preset is a PARAMETER SET
// consumed by the single TrophyAmbience engine — adding a preset never means
// new animation code, only new values. All motion is transform/opacity-only
// (GPU-composited) and gated by useAmbientActive().
//
// Preset shape:
//   label      Studio display name
//   motion     "rise" | "fall" | "orbit" | "twinkle" | "spiral"
//   colors     particle color pool (picked per particle)
//   count      particle count (kept ≤ 16 for mobile)
//   size       [min,max] px
//   duration   [min,max] seconds per loop
//   opacity    peak particle opacity
//   blur       px soft-focus on particles
//   glint      seconds between rare 4-point star glints (null = none)
//   halo       breathing halo color behind the trophy (null = none)
//   sweep      museum specular light sweep (bool)

export const PRESETS = {
  gold_dust: {
    label: "Gold Dust Ascension",
    motion: "rise", colors: ["#D9B872", "#F2DCA8", "#FFF6E0"],
    count: 12, size: [1.5, 3], duration: [5, 8], opacity: 0.6, blur: 0.5,
    glint: 5, halo: null, sweep: false,
  },
  silver_mist: {
    label: "Silver Mist",
    motion: "rise", colors: ["#C7CDD6", "#E8ECF2", "#FFFFFF"],
    count: 10, size: [1.5, 3.5], duration: [7, 11], opacity: 0.45, blur: 1,
    glint: 8, halo: null, sweep: false,
  },
  champagne_bubbles: {
    label: "Champagne Bubbles",
    motion: "rise", colors: ["#EFD9A7", "#F7EBCB", "#FFFDF5"],
    count: 14, size: [2, 4.5], duration: [4, 6.5], opacity: 0.55, blur: 0.3,
    glint: null, halo: null, sweep: false,
  },
  crystal_shimmer: {
    label: "Crystal Shimmer",
    motion: "twinkle", colors: ["#DDEBFF", "#F2F8FF", "#FFFFFF"],
    count: 14, size: [1.5, 3], duration: [2.2, 4], opacity: 0.85, blur: 0.3,
    glint: 4, halo: null, sweep: false,
  },
  royal_velvet: {
    label: "Royal Velvet",
    motion: "rise", colors: ["#B79CF2", "#D9B872", "#EFE4FF"],
    count: 12, size: [1.5, 3], duration: [5.5, 9], opacity: 0.5, blur: 0.6,
    glint: 6, halo: "rgba(139,92,246,0.16)", sweep: false,
  },
  firefly_orbit: {
    label: "Firefly Orbit",
    motion: "orbit", colors: ["#F5D889", "#FFE9B0", "#FFF8E3"],
    count: 7, size: [2, 3.5], duration: [9, 15], opacity: 0.7, blur: 0.4,
    glint: null, halo: null, sweep: false,
  },
  halo_glow: {
    label: "Halo Glow",
    motion: "rise", colors: ["#F2DCA8", "#FFF6E0"],
    count: 6, size: [1.5, 2.5], duration: [7, 10], opacity: 0.4, blur: 0.8,
    glint: null, halo: "rgba(217,184,114,0.22)", sweep: false,
  },
  light_sweep: {
    label: "Museum Light Sweep",
    motion: "twinkle", colors: ["#FFFFFF", "#FFF6E0"],
    count: 3, size: [1.5, 2.5], duration: [3, 5], opacity: 0.8, blur: 0.3,
    glint: 6, halo: null, sweep: true,
  },
  ember_rise: {
    label: "Ember Rise",
    motion: "rise", colors: ["#F2B06B", "#E8985A", "#FFDCAF"],
    count: 12, size: [1.5, 3], duration: [3.5, 6], opacity: 0.6, blur: 0.4,
    glint: null, halo: "rgba(242,176,107,0.14)", sweep: false,
  },
  petal_drift: {
    label: "Petal Drift",
    motion: "fall", colors: ["#F6C6D9", "#FBE3ED", "#FFF3F8"],
    count: 10, size: [2.5, 4.5], duration: [6, 10], opacity: 0.55, blur: 0.4,
    glint: null, halo: null, sweep: false,
  },
  starfield: {
    label: "Starfield Twinkle",
    motion: "twinkle", colors: ["#FFF6E0", "#E8ECF2", "#FFFFFF"],
    count: 16, size: [1, 2.5], duration: [1.8, 3.6], opacity: 0.8, blur: 0.2,
    glint: 7, halo: null, sweep: false,
  },
  aurora_veil: {
    label: "Aurora Veil",
    motion: "rise", colors: ["#9EE6C3", "#B79CF2", "#DDEBFF"],
    count: 8, size: [1.5, 3], duration: [6, 10], opacity: 0.45, blur: 0.8,
    glint: null, halo: "rgba(158,230,195,0.14)", sweep: true,
  },
  confetti_whisper: {
    label: "Confetti Whisper",
    motion: "fall", colors: ["#F6C6D9", "#B79CF2", "#9EE6C3", "#F2DCA8"],
    count: 12, size: [2, 3.5], duration: [5, 8], opacity: 0.5, blur: 0.2,
    glint: null, halo: null, sweep: false,
  },
  laurel_spiral: {
    label: "Laurel Spiral",
    motion: "spiral", colors: ["#CBD98E", "#E4EDBB", "#F2DCA8"],
    count: 10, size: [1.5, 3], duration: [5, 8.5], opacity: 0.55, blur: 0.4,
    glint: null, halo: null, sweep: false,
  },
  moonlight_pulse: {
    label: "Moonlight Pulse",
    motion: "twinkle", colors: ["#E8ECF2", "#FFFFFF"],
    count: 8, size: [1.5, 3], duration: [3, 5.5], opacity: 0.6, blur: 0.6,
    glint: 9, halo: "rgba(200,214,235,0.20)", sweep: false,
  },
};

export const DEFAULT_EFFECT = "gold_dust";

export const EFFECT_OPTIONS = Object.entries(PRESETS).map(([id, p]) => ({
  id,
  label: p.label,
}));
