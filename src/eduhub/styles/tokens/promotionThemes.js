/**
 * promotionThemes.js — Promotion Experience Studio's preset library
 * (approved directive: "Promotion Experience Studio Phase 1-5").
 *
 * Own product-family personality, deliberately separate from
 * achievementThemes.js's celebration/recognition language: premium SaaS
 * banner — foundation of emerald / warm white / cream / champagne gold,
 * with ruby-red and sapphire-blue reserved as MICRO accents only (a CTA or
 * a single decoration tint, never a whole-surface color), per the approved
 * directive's "avoid excessive color, favor elegance over decoration."
 *
 * Reuses designTokens.js's radius/elevation scale for playerCard-equivalent
 * (ctaBar) sizing so Promotion still shares a physical scale with every
 * other experience surface, exactly like achievementThemes.js does.
 *
 * Preset count is deliberately modest (3, not 11) — the directive asked for
 * a premium day/night identity plus room for "future seasonal themes," not
 * a large preset library on day one. New presets are added the same way
 * achievementThemes.js's were: another entry in `promotionThemes`, zero
 * resolver/component changes required.
 */
import { radius, elevation } from "./designTokens";

export const PROMOTION_ACCENT_HUES = {
  champagneGold: "#D9B872",
  rubyRed: "#B23A48",
  sapphireBlue: "#3A6EA5",
};

export const CTA_STYLES = ["filled", "outline", "glass", "pill", "floating"];
export const CTA_ANIMATIONS = ["fade", "rise", "scale", "pulse"];
export const CTA_PLACEMENTS = ["stack", "center", "relative", "free"];
export const TEXT_ROLES = ["eyebrow", "headline", "subhead", "body"];
export const DECORATION_TYPES = [
  "sparkles", "academicParticles", "premiumDust", "ribbons", "confetti", "lightRays",
];

const NO_DECORATION = { enabled: false, intensity: "medium", colorOverride: null };

function decorations(overrides) {
  const base = {
    sparkles: { ...NO_DECORATION },
    academicParticles: { ...NO_DECORATION },
    premiumDust: { ...NO_DECORATION },
    ribbons: { ...NO_DECORATION },
    confetti: { ...NO_DECORATION },
    lightRays: { ...NO_DECORATION },
  };
  Object.entries(overrides || {}).forEach(([k, v]) => {
    if (base[k]) base[k] = { ...base[k], ...v };
  });
  return base;
}

function ctaDefaults(accent, over) {
  return {
    style: "filled",
    animation: "rise",
    placement: "stack",
    accent,
    cornerRadius: radius.pill,
    ...over,
  };
}

export const promotionThemes = {
  emeraldDay: {
    id: "emeraldDay",
    label: "Emerald Signature (Day)",
    mode: "day",
    surface:
      "radial-gradient(120% 100% at 100% 0%, rgba(217,184,114,0.14) 0%, transparent 55%)," +
      "linear-gradient(155deg, #FAF7EF 0%, #F3ECD9 45%, #E9E0C4 100%)",
    onSurface: "#0E1F18",
    onSurfaceSoft: "rgba(14,31,24,0.68)",
    accent: PROMOTION_ACCENT_HUES.champagneGold,
    borderColor: "rgba(14,31,24,0.10)",
    shadow: elevation.raised,
    overlay: { color: "#0E1F18", opacity: 18 },
    cta: ctaDefaults(PROMOTION_ACCENT_HUES.champagneGold),
    decorations: decorations(),
  },
  emeraldNight: {
    id: "emeraldNight",
    label: "Emerald Signature (Night)",
    mode: "night",
    surface:
      "radial-gradient(120% 100% at 100% 0%, rgba(217,184,114,0.12) 0%, transparent 55%)," +
      "linear-gradient(155deg, #0B1712 0%, #0E1F18 50%, #123F2C 100%)",
    onSurface: "#F4F0E2",
    onSurfaceSoft: "rgba(244,240,226,0.72)",
    accent: PROMOTION_ACCENT_HUES.champagneGold,
    borderColor: "rgba(255,255,255,0.10)",
    shadow: elevation.floating,
    overlay: { color: "#000000", opacity: 30 },
    cta: ctaDefaults(PROMOTION_ACCENT_HUES.champagneGold, { style: "glass" }),
    decorations: decorations(),
  },
  celebrationGold: {
    id: "celebrationGold",
    label: "Celebration Gold",
    mode: "day",
    surface:
      "radial-gradient(130% 110% at 0% 0%, rgba(178,58,72,0.10) 0%, transparent 50%)," +
      "linear-gradient(150deg, #1A1420 0%, #2D1F3E 55%, #1A1420 100%)",
    onSurface: "#F8EFD9",
    onSurfaceSoft: "rgba(248,239,217,0.75)",
    accent: PROMOTION_ACCENT_HUES.champagneGold,
    borderColor: "rgba(212,168,67,0.28)",
    shadow: elevation.floating,
    overlay: { color: "#1A1420", opacity: 22 },
    cta: ctaDefaults(PROMOTION_ACCENT_HUES.champagneGold, { style: "floating", animation: "pulse" }),
    decorations: decorations({
      sparkles: { enabled: true, intensity: "medium" },
      confetti: { enabled: true, intensity: "low" },
    }),
  },
};

export const PROMOTION_PRESET_IDS = Object.keys(promotionThemes);

export function getPromotionTheme(idOrLegacy) {
  return promotionThemes[idOrLegacy] || promotionThemes.emeraldDay;
}

/** Mirrors achievementThemes.js's resolveFollowWelcomeTheme contract exactly:
 * only the base Day/Night pair reacts to the app theme; any other preset an
 * admin picks explicitly always wins regardless of day/night. */
export function resolveFollowAppTheme(appTheme) {
  return appTheme === "dark" ? promotionThemes.emeraldNight : promotionThemes.emeraldDay;
}

export default {
  promotionThemes, PROMOTION_PRESET_IDS, PROMOTION_ACCENT_HUES,
  CTA_STYLES, CTA_ANIMATIONS, CTA_PLACEMENTS, TEXT_ROLES, DECORATION_TYPES,
  getPromotionTheme, resolveFollowAppTheme,
};
