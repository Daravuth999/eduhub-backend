/**
 * typographyStyles.js — Campaign Design Studio 2.0 professional text-style
 * system. Each style is a complete, reusable typographic identity — font
 * family, weight, spacing, line height, shadow, glow, stroke, gradient,
 * glass background, padding, radius — applied to a text layer by styleId.
 *
 * Uses ONLY font families already shipped by public/index.html (Fraunces,
 * Geist, Bricolage Grotesque, JetBrains Mono, Noto Sans Khmer) — zero new
 * font network dependencies, and every stack ends in Khmer + system
 * fallbacks so bilingual campaigns stay balanced.
 *
 * Contract: getTypographyStyle(styleId).build({ cu, size, mode, align })
 * returns a ready-to-spread CSS object. `cu` = canvasWidth / 100 px;
 * `size` is the layer's font size in canvas units, so typography scales
 * identically in the Studio stage and the student Dashboard.
 */

const SERIF = "'Fraunces', 'Noto Serif Khmer', 'Noto Sans Khmer', serif";
const SANS = "'Geist', 'Noto Sans Khmer', system-ui, sans-serif";
const DISPLAY = "'Bricolage Grotesque', 'Noto Sans Khmer', system-ui, sans-serif";
const MONO = "'JetBrains Mono', 'Noto Sans Khmer', monospace";

const GOLD_GRADIENT = "linear-gradient(115deg, #FFE9B0 0%, #E4C06A 38%, #B98A2F 62%, #F4D88C 100%)";
const CRYSTAL_GRADIENT = "linear-gradient(180deg, #FFFFFF 0%, #DCE9E3 55%, #9FB8AC 100%)";
const EMERALD_GRADIENT = "linear-gradient(120deg, #2E7D5B 0%, #123F2C 60%, #0B1712 100%)";

function gradientText(css) {
  return {
    backgroundImage: css,
    WebkitBackgroundClip: "text",
    backgroundClip: "text",
    color: "transparent",
    WebkitTextFillColor: "transparent",
  };
}

/** mode = "day" | "night" (resolved campaign surface mode). */
export const TYPOGRAPHY_STYLES = {
  premiumLuxury: {
    id: "premiumLuxury",
    label: "Premium Luxury",
    hint: "Gilded serif — flagship offers",
    sample: "Golden Season",
    build: ({ cu, size, mode }) => ({
      fontFamily: SERIF,
      fontWeight: 700,
      letterSpacing: "-0.015em",
      lineHeight: 1.06,
      fontSize: cu * size,
      ...gradientText(GOLD_GRADIENT),
      filter: mode === "night"
        ? "drop-shadow(0 2px 14px rgba(212,168,67,0.35))"
        : "drop-shadow(0 2px 10px rgba(120,86,20,0.25))",
    }),
  },
  emeraldGlass: {
    id: "emeraldGlass",
    label: "Emerald Glass",
    hint: "Frosted label on glass",
    sample: "Fresh Arrival",
    build: ({ cu, size, mode }) => ({
      fontFamily: SANS,
      fontWeight: 600,
      letterSpacing: "0.01em",
      lineHeight: 1.25,
      fontSize: cu * size,
      color: mode === "night" ? "#EAF4EE" : "#0E1F18",
      background: mode === "night" ? "rgba(14,31,24,0.42)" : "rgba(250,247,239,0.55)",
      border: "1px solid rgba(212,168,67,0.30)",
      backdropFilter: "blur(10px)",
      WebkitBackdropFilter: "blur(10px)",
      padding: `${cu * 1.2}px ${cu * 2.6}px`,
      borderRadius: cu * 2.2,
      boxShadow: "0 8px 24px rgba(0,0,0,0.18)",
      display: "inline-block",
    }),
  },
  academic: {
    id: "academic",
    label: "Academic",
    hint: "Calm scholarly clarity",
    sample: "Scholarship 2026",
    build: ({ cu, size, mode }) => ({
      fontFamily: SANS,
      fontWeight: 600,
      letterSpacing: "0.005em",
      lineHeight: 1.3,
      fontSize: cu * size,
      color: mode === "night" ? "#F1EEE2" : "#14261D",
    }),
  },
  editorial: {
    id: "editorial",
    label: "Editorial",
    hint: "Serif authority, underline accent",
    sample: "The Reading Issue",
    build: ({ cu, size, mode }) => ({
      fontFamily: SERIF,
      fontWeight: 600,
      letterSpacing: "-0.01em",
      lineHeight: 1.14,
      fontSize: cu * size,
      color: mode === "night" ? "#F4F0E2" : "#101E17",
      borderBottom: `${Math.max(1, cu * 0.34)}px solid rgba(212,168,67,0.85)`,
      paddingBottom: cu * 0.8,
      display: "inline",
      boxDecorationBreak: "clone",
      WebkitBoxDecorationBreak: "clone",
    }),
  },
  financial: {
    id: "financial",
    label: "Financial",
    hint: "Tabular mono precision",
    sample: "+500 PTS",
    build: ({ cu, size, mode }) => ({
      fontFamily: MONO,
      fontWeight: 600,
      letterSpacing: "0.14em",
      textTransform: "uppercase",
      lineHeight: 1.3,
      fontVariantNumeric: "tabular-nums",
      fontSize: cu * size,
      color: mode === "night" ? "#D9E8DF" : "#123F2C",
    }),
  },
  magazine: {
    id: "magazine",
    label: "Magazine",
    hint: "Condensed display impact",
    sample: "BIG WEEK",
    build: ({ cu, size, mode }) => ({
      fontFamily: DISPLAY,
      fontWeight: 800,
      letterSpacing: "-0.02em",
      textTransform: "uppercase",
      lineHeight: 0.98,
      fontSize: cu * size,
      color: mode === "night" ? "#F6F2E6" : "#0E1F18",
    }),
  },
  appleInspired: {
    id: "appleInspired",
    label: "Apple Inspired",
    hint: "Quiet confidence, tight tracking",
    sample: "Learn different.",
    build: ({ cu, size, mode }) => ({
      fontFamily: SANS,
      fontWeight: 600,
      letterSpacing: "-0.022em",
      lineHeight: 1.08,
      fontSize: cu * size,
      color: mode === "night" ? "#F5F5F0" : "#1D1D1F",
    }),
  },
  marketingBold: {
    id: "marketingBold",
    label: "Marketing Bold",
    hint: "Loud offer callouts",
    sample: "50% OFF",
    build: ({ cu, size, mode }) => ({
      fontFamily: DISPLAY,
      fontWeight: 800,
      letterSpacing: "-0.01em",
      textTransform: "uppercase",
      lineHeight: 1.0,
      fontSize: cu * size,
      color: "#FFFFFF",
      WebkitTextStroke: mode === "night" ? "0" : `${Math.max(1, cu * 0.14)}px rgba(14,31,24,0.9)`,
      textShadow: mode === "night"
        ? "0 4px 22px rgba(178,58,72,0.55), 0 2px 4px rgba(0,0,0,0.5)"
        : "0 4px 18px rgba(178,58,72,0.35)",
    }),
  },
  elegantSerif: {
    id: "elegantSerif",
    label: "Elegant Serif",
    hint: "Airy, refined announcements",
    sample: "An Evening of Stories",
    build: ({ cu, size, mode }) => ({
      fontFamily: SERIF,
      fontWeight: 500,
      letterSpacing: "0.06em",
      lineHeight: 1.3,
      fontSize: cu * size,
      color: mode === "night" ? "#EFEAD8" : "#241D0F",
    }),
  },
  crystal: {
    id: "crystal",
    label: "Crystal",
    hint: "Icy gradient glow",
    sample: "Winter Awards",
    build: ({ cu, size }) => ({
      fontFamily: SANS,
      fontWeight: 700,
      letterSpacing: "0.01em",
      lineHeight: 1.08,
      fontSize: cu * size,
      ...gradientText(CRYSTAL_GRADIENT),
      filter: "drop-shadow(0 0 18px rgba(190,225,210,0.45)) drop-shadow(0 2px 4px rgba(0,0,0,0.35))",
    }),
  },
  minimal: {
    id: "minimal",
    label: "Minimal",
    hint: "Whisper-quiet caption",
    sample: "NEW · LIMITED",
    build: ({ cu, size, mode }) => ({
      fontFamily: SANS,
      fontWeight: 500,
      letterSpacing: "0.24em",
      textTransform: "uppercase",
      lineHeight: 1.5,
      fontSize: cu * size,
      color: mode === "night" ? "rgba(244,240,226,0.78)" : "rgba(14,31,24,0.66)",
    }),
  },
  emeraldStatement: {
    id: "emeraldStatement",
    label: "Emerald Statement",
    hint: "Deep emerald gradient serif",
    sample: "Grow Beyond",
    build: ({ cu, size, mode }) => ({
      fontFamily: SERIF,
      fontWeight: 700,
      letterSpacing: "-0.012em",
      lineHeight: 1.06,
      fontSize: cu * size,
      ...(mode === "night"
        ? { color: "#DFF2E7", textShadow: "0 2px 20px rgba(46,125,91,0.5)" }
        : gradientText(EMERALD_GRADIENT)),
    }),
  },
};

export const TYPOGRAPHY_STYLE_IDS = Object.keys(TYPOGRAPHY_STYLES);

export function getTypographyStyle(styleId) {
  return TYPOGRAPHY_STYLES[styleId] || TYPOGRAPHY_STYLES.premiumLuxury;
}

const typographyStyles = { TYPOGRAPHY_STYLES, TYPOGRAPHY_STYLE_IDS, getTypographyStyle };
export default typographyStyles;
