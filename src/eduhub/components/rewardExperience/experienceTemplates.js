/**
 * experienceTemplates.js — reusable, editable experience templates.
 * Applying a template only populates the campaign's presentational
 * `experience` config; scheduling, audience and reward settings are
 * never touched.
 */
export const EXPERIENCE_TEMPLATES = [
  {
    id: "welcome_reward",
    label: "Welcome Reward",
    tagline: "Warm golden welcome",
    experience: {
      environment: "morning_angkor", reveal: "cinematic", particles: "dust",
      lighting: "morning",
      decorations: [
        { id: "t_w1", kind: "builtin", asset: "lotus", x: 12, y: 16, size: 54, glow: 0.4, layer: "front", anim: "float" },
        { id: "t_w2", kind: "builtin", asset: "khmer_kbach", x: 88, y: 84, size: 64, opacity: 0.7, layer: "back" },
      ],
    },
  },
  {
    id: "first_login",
    label: "First Login",
    tagline: "Fresh, focused start",
    experience: {
      environment: "modern_studio", reveal: "scale", particles: "dust", lighting: "studio",
      cta: { style: "gradient", animation: "shimmer" },
      decorations: [
        { id: "t_f1", kind: "builtin", asset: "lightbulb", x: 86, y: 20, size: 48, glow: 0.5, layer: "front", anim: "pulse" },
      ],
    },
  },
  {
    id: "vip_reward",
    label: "VIP Reward",
    tagline: "Black velvet & gold",
    experience: {
      environment: "vip_luxury", glass: "midnight", reveal: "bloom",
      particles: "sparkles", lighting: "spotlight",
      cta: { style: "gradient", glow: 0.7 },
      decorations: [
        { id: "t_v1", kind: "builtin", asset: "crown", x: 50, y: 8, size: 52, glow: 0.7, layer: "front", anim: "float" },
        { id: "t_v2", kind: "builtin", asset: "gold_corner", x: 8, y: 90, size: 74, opacity: 0.8, layer: "back" },
        { id: "t_v3", kind: "builtin", asset: "glass_orb", x: 90, y: 70, size: 60, opacity: 0.6, layer: "back", anim: "drift" },
      ],
    },
  },
  {
    id: "birthday_reward",
    label: "Birthday Reward",
    tagline: "Soft celebration",
    experience: {
      environment: "festival_celebration", reveal: "cinematic", particles: "confetti",
      decorations: [
        { id: "t_b1", kind: "builtin", asset: "balloon", x: 12, y: 24, size: 56, layer: "front", anim: "float" },
        { id: "t_b2", kind: "builtin", asset: "gift_box", x: 88, y: 78, size: 58, layer: "front", anim: "sway" },
        { id: "t_b3", kind: "builtin", asset: "party_flag", x: 50, y: 5, size: 120, layer: "front" },
      ],
    },
  },
  {
    id: "holiday_reward",
    label: "Holiday Reward",
    tagline: "Seasonal calm",
    experience: {
      environment: "lotus_garden", reveal: "fade", particles: "petals", lighting: "sunset",
      decorations: [
        { id: "t_h1", kind: "builtin", asset: "lotus", x: 14, y: 82, size: 66, layer: "back", anim: "sway" },
        { id: "t_h2", kind: "builtin", asset: "crescent_moon", x: 86, y: 14, size: 48, glow: 0.5, layer: "front" },
      ],
    },
  },
  {
    id: "academic_achievement",
    label: "Academic Achievement",
    tagline: "Scholarly honours",
    experience: {
      environment: "academic_hall", reveal: "cinematic", particles: "rays", lighting: "cool",
      typography: { title_font: "serif", title_weight: 800 },
      decorations: [
        { id: "t_a1", kind: "builtin", asset: "laurel_wreath", x: 50, y: 8, size: 66, glow: 0.4, layer: "front" },
        { id: "t_a2", kind: "builtin", asset: "grad_cap", x: 12, y: 78, size: 54, layer: "back", opacity: 0.75 },
        { id: "t_a3", kind: "builtin", asset: "certificate", x: 88, y: 82, size: 58, layer: "back", opacity: 0.75 },
      ],
    },
  },
  {
    id: "speaking_challenge",
    label: "Speaking Challenge",
    tagline: "Voice in the spotlight",
    experience: {
      environment: "modern_studio", reveal: "slide", particles: "fireflies", lighting: "studio",
      cta: { style: "glass" },
      decorations: [
        { id: "t_s1", kind: "builtin", asset: "microphone", x: 88, y: 22, size: 52, glow: 0.5, layer: "front", anim: "float" },
        { id: "t_s2", kind: "builtin", asset: "speech_bubble", x: 12, y: 76, size: 56, opacity: 0.8, layer: "back", anim: "drift" },
      ],
    },
  },
  {
    id: "special_campaign",
    label: "Special Campaign",
    tagline: "Royal heritage moment",
    experience: {
      environment: "royal_heritage", glass: "midnight", reveal: "bloom",
      particles: "sparkles", lighting: "golden",
      typography: { title_font: "display", title_shadow: 0.4 },
      decorations: [
        { id: "t_r1", kind: "builtin", asset: "angkor_tower", x: 10, y: 84, size: 78, opacity: 0.65, layer: "back" },
        { id: "t_r2", kind: "builtin", asset: "elegant_ribbon", x: 50, y: 6, size: 110, layer: "front" },
        { id: "t_r3", kind: "builtin", asset: "flourish_swirl", x: 90, y: 88, size: 64, opacity: 0.7, layer: "back", flip: true },
      ],
    },
  },
];
