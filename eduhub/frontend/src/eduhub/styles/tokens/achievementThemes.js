/**
 * achievementThemes.js — Achievement Experience Studio's preset library
 * (approved directive: "Top Earner Configuration Platform").
 *
 * Every preset is a SELF-CONTAINED, fully-specified theme — background,
 * palette, typography, trophy presentation, player card styling, and
 * default decorations. TopEarnerPanel never invents a color/gradient of
 * its own; it only reads a resolved preset (or a custom config built from
 * one, see achievementConfigSchema.js) exactly the same way Hero.jsx only
 * ever reads designTokens.js's palettes. Deliberately a SEPARATE token
 * set from designTokens.js's Hero palettes (own product-family personality:
 * achievement/recognition, not welcome/inspiration — see the directive's
 * "Design Philosophy" section), reusing the SAME radius/elevation scale
 * from designTokens.js for playerCard.cornerRadius/elevation so the two
 * surfaces still share a physical scale even while looking distinct.
 *
 * rankTile shape (trophy colors per rank): { gradient, glow, on }.
 * decoration entry shape: { enabled, intensity: "low"|"medium"|"high",
 * colorOverride: string|null } — "individually configurable" per the
 * directive without an unbounded number of per-decoration knobs.
 */
import { radius, elevation } from "./designTokens";

const NO_DECORATION = { enabled: false, intensity: "medium", colorOverride: null };

function decorations(overrides) {
  const base = {
    confetti: { ...NO_DECORATION },
    stars: { ...NO_DECORATION },
    sparkles: { ...NO_DECORATION },
    fireworks: { ...NO_DECORATION },
    snow: { ...NO_DECORATION },
    lanterns: { ...NO_DECORATION },
    balloons: { ...NO_DECORATION },
    flowers: { ...NO_DECORATION },
    ribbons: { ...NO_DECORATION },
    seasonalOrnaments: { ...NO_DECORATION },
  };
  Object.entries(overrides || {}).forEach(([k, v]) => {
    if (base[k]) base[k] = { ...base[k], ...v };
  });
  return base;
}

export const DECORATION_TYPES = [
  "confetti", "stars", "sparkles", "fireworks", "snow",
  "lanterns", "balloons", "flowers", "ribbons", "seasonalOrnaments",
];

export const TROPHY_STYLES = ["classic", "crownJewel", "medal", "star", "wreath"];
export const MEDAL_DESIGNS = ["circle", "shield", "ribbon", "star"];
export const WINNER_ANIMATIONS = ["bounce", "pulse", "shimmer", "none"];
export const CARD_SHAPES = ["rounded", "pill", "square"];

function trophy(style, color, over) {
  return {
    style, color, medalDesign: "circle",
    winnerRing: { enabled: true, color },
    championGlow: { enabled: true, color },
    winnerAnimation: "bounce",
    ...over,
  };
}

function playerCard(over) {
  return {
    shape: "rounded",
    cornerRadius: radius.lg,
    elevation: elevation.soft,
    borderStyle: "glow",
    activeHighlight: { enabled: true },
    hoverState: { enabled: true },
    winnerEmphasis: { enabled: true },
    ...over,
  };
}

function rank(gradient, glow, on) {
  return { gradient, glow, on };
}

export const achievementThemes = {
  emeraldAchievement: {
    id: "emeraldAchievement",
    label: "Emerald Achievement",
    mode: "day",
    surface:
      "radial-gradient(ellipse 90% 100% at 0% 0%, rgba(217,184,114,0.16) 0%, transparent 55%)," +
      "radial-gradient(ellipse 90% 100% at 100% 100%, rgba(40,199,79,0.16) 0%, transparent 55%)," +
      "linear-gradient(150deg, #0C1B15 0%, #123F2C 55%, #17573B 100%)",
    glassIntensity: "subtle",
    borderColor: "rgba(255,255,255,0.08)",
    borderGlow: "rgba(217,184,114,0.10)",
    shadow: "0 14px 40px rgba(0,0,0,0.35)",
    primary: "#E8CD8F",
    secondary: "#28C74F",
    accent: "#E8CD8F",
    accentBarGradient: "linear-gradient(180deg, #E8CD8F 0%, #D9B872 45%, #28C74F 100%)",
    goldAccent: "#E8CD8F",
    emeraldAccent: "#28C74F",
    onSurface: "#FFFFFF",
    onSurfaceSoft: "rgba(255,255,255,0.72)",
    headerColor: "#FFFFFF",
    nameColor: "#FFFFFF",
    labelColor: "#E8CD8F",
    scoreColor: "#E8CD8F",
    liveBadge: { color: "#3FE07E", bg: "rgba(40,199,79,0.14)", border: "rgba(40,199,79,0.45)" },
    rankTile: {
      1: rank("linear-gradient(135deg, #F4E5C1, #D9B872)", "rgba(217,184,114,0.5)", "#17301F"),
      2: rank("linear-gradient(135deg, #3FE07E, #1E8A4A)", "rgba(40,199,79,0.4)", "#0E1F18"),
      3: rank("linear-gradient(135deg, #28C74F, #145C33)", "rgba(40,199,79,0.35)", "#FFFFFF"),
      rest: rank("linear-gradient(135deg, rgba(40,199,79,0.4), rgba(217,184,114,0.32))", "rgba(40,199,79,0.3)", "#FFFFFF"),
    },
    trophy: trophy("crownJewel", "#E8CD8F"),
    playerCard: playerCard(),
    decorations: decorations({ sparkles: { enabled: true, intensity: "low" } }),
    surfaceCard: "rgba(255,255,255,0.04)",
    surfaceCardBorder: "rgba(255,255,255,0.08)",
    tickerBg: "rgba(6,16,11,0.5)",
    chipActiveBg: "rgba(217,184,114,0.16)",
    chipActiveBorder: "rgba(217,184,114,0.5)",
  },

  midnightAchievement: {
    id: "midnightAchievement",
    label: "Midnight Achievement",
    mode: "night",
    surface:
      "radial-gradient(ellipse 90% 100% at 0% 0%, rgba(217,184,114,0.10) 0%, transparent 55%)," +
      "radial-gradient(ellipse 90% 100% at 100% 100%, rgba(30,138,74,0.14) 0%, transparent 55%)," +
      "linear-gradient(150deg, #0A0C10 0%, #12151C 55%, #171B24 100%)",
    glassIntensity: "subtle",
    borderColor: "rgba(255,255,255,0.07)",
    borderGlow: "rgba(217,184,114,0.08)",
    shadow: "0 14px 40px rgba(0,0,0,0.45)",
    primary: "#D9B872",
    secondary: "#1E8A4A",
    accent: "#D9B872",
    accentBarGradient: "linear-gradient(180deg, #D9B872 0%, #B8935A 45%, #1E8A4A 100%)",
    goldAccent: "#D9B872",
    emeraldAccent: "#1E8A4A",
    onSurface: "#FFFFFF",
    onSurfaceSoft: "rgba(255,255,255,0.62)",
    headerColor: "#FFFFFF",
    nameColor: "#FFFFFF",
    labelColor: "#D9B872",
    scoreColor: "#D9B872",
    liveBadge: { color: "#3FCB7C", bg: "rgba(30,138,74,0.16)", border: "rgba(30,138,74,0.5)" },
    rankTile: {
      1: rank("linear-gradient(135deg, #D9B872, #B8935A)", "rgba(217,184,114,0.4)", "#14100A"),
      2: rank("linear-gradient(135deg, #3FCB7C, #1E8A4A)", "rgba(30,138,74,0.35)", "#0A140E"),
      3: rank("linear-gradient(135deg, #1E8A4A, #123A26)", "rgba(30,138,74,0.3)", "#FFFFFF"),
      rest: rank("linear-gradient(135deg, rgba(30,138,74,0.38), rgba(217,184,114,0.24))", "rgba(30,138,74,0.25)", "#FFFFFF"),
    },
    trophy: trophy("crownJewel", "#D9B872"),
    playerCard: playerCard({ elevation: elevation.raised }),
    decorations: decorations({ stars: { enabled: true, intensity: "low" } }),
    surfaceCard: "rgba(255,255,255,0.03)",
    surfaceCardBorder: "rgba(255,255,255,0.07)",
    tickerBg: "rgba(4,5,7,0.55)",
    chipActiveBg: "rgba(217,184,114,0.12)",
    chipActiveBorder: "rgba(217,184,114,0.42)",
  },

  goldenCelebration: {
    id: "goldenCelebration",
    label: "Golden Celebration",
    mode: "day",
    surface:
      "radial-gradient(ellipse 90% 100% at 0% 0%, rgba(255,214,133,0.22) 0%, transparent 55%)," +
      "radial-gradient(ellipse 90% 100% at 100% 100%, rgba(184,110,26,0.18) 0%, transparent 55%)," +
      "linear-gradient(150deg, #241505 0%, #4A2A0A 55%, #6B3D0F 100%)",
    glassIntensity: "strong",
    borderColor: "rgba(255,214,133,0.14)",
    borderGlow: "rgba(255,214,133,0.16)",
    shadow: "0 16px 44px rgba(60,30,0,0.4)",
    primary: "#FFD685", secondary: "#B86E1A", accent: "#FFEFC2",
    accentBarGradient: "linear-gradient(180deg, #FFEFC2 0%, #FFD685 45%, #B86E1A 100%)",
    goldAccent: "#FFD685", emeraldAccent: "#B86E1A",
    onSurface: "#FFFFFF", onSurfaceSoft: "rgba(255,255,255,0.75)",
    headerColor: "#FFFFFF", nameColor: "#FFFFFF", labelColor: "#FFD685", scoreColor: "#FFEFC2",
    liveBadge: { color: "#FFD685", bg: "rgba(255,214,133,0.16)", border: "rgba(255,214,133,0.5)" },
    rankTile: {
      1: rank("linear-gradient(135deg, #FFEFC2, #FFD685)", "rgba(255,214,133,0.55)", "#3A2205"),
      2: rank("linear-gradient(135deg, #FFD685, #C98A2E)", "rgba(255,214,133,0.4)", "#2A1704"),
      3: rank("linear-gradient(135deg, #B86E1A, #6B3D0F)", "rgba(184,110,26,0.35)", "#FFFFFF"),
      rest: rank("linear-gradient(135deg, rgba(184,110,26,0.42), rgba(255,214,133,0.3))", "rgba(184,110,26,0.3)", "#FFFFFF"),
    },
    trophy: trophy("crownJewel", "#FFD685", { medalDesign: "star" }),
    playerCard: playerCard({ borderStyle: "glow" }),
    decorations: decorations({
      confetti: { enabled: true, intensity: "medium", colorOverride: null },
      sparkles: { enabled: true, intensity: "medium" },
    }),
    surfaceCard: "rgba(255,255,255,0.05)", surfaceCardBorder: "rgba(255,214,133,0.12)",
    tickerBg: "rgba(30,16,3,0.55)",
    chipActiveBg: "rgba(255,214,133,0.18)", chipActiveBorder: "rgba(255,214,133,0.5)",
  },

  graduation: {
    id: "graduation",
    label: "Graduation",
    mode: "day",
    surface:
      "radial-gradient(ellipse 90% 100% at 0% 0%, rgba(212,168,67,0.14) 0%, transparent 55%)," +
      "radial-gradient(ellipse 90% 100% at 100% 100%, rgba(80,100,200,0.16) 0%, transparent 55%)," +
      "linear-gradient(150deg, #0A0E24 0%, #131A3E 55%, #1B234E 100%)",
    glassIntensity: "subtle",
    borderColor: "rgba(212,168,67,0.14)",
    borderGlow: "rgba(212,168,67,0.14)",
    shadow: "0 14px 40px rgba(5,8,25,0.5)",
    primary: "#D4A843", secondary: "#5064C8", accent: "#F4E5C1",
    accentBarGradient: "linear-gradient(180deg, #F4E5C1 0%, #D4A843 45%, #5064C8 100%)",
    goldAccent: "#D4A843", emeraldAccent: "#7C8CE8",
    onSurface: "#FFFFFF", onSurfaceSoft: "rgba(255,255,255,0.7)",
    headerColor: "#FFFFFF", nameColor: "#FFFFFF", labelColor: "#D4A843", scoreColor: "#F4E5C1",
    liveBadge: { color: "#8FA0FF", bg: "rgba(80,100,200,0.16)", border: "rgba(80,100,200,0.5)" },
    rankTile: {
      1: rank("linear-gradient(135deg, #F4E5C1, #D4A843)", "rgba(212,168,67,0.5)", "#1B1204"),
      2: rank("linear-gradient(135deg, #8FA0FF, #5064C8)", "rgba(80,100,200,0.4)", "#0A0E24"),
      3: rank("linear-gradient(135deg, #5064C8, #2C3480)", "rgba(80,100,200,0.35)", "#FFFFFF"),
      rest: rank("linear-gradient(135deg, rgba(80,100,200,0.4), rgba(212,168,67,0.28))", "rgba(80,100,200,0.3)", "#FFFFFF"),
    },
    trophy: trophy("medal", "#D4A843", { medalDesign: "ribbon" }),
    playerCard: playerCard({ shape: "rounded", cornerRadius: radius.md }),
    decorations: decorations({
      confetti: { enabled: true, intensity: "low" },
      ribbons: { enabled: true, intensity: "medium" },
    }),
    surfaceCard: "rgba(255,255,255,0.04)", surfaceCardBorder: "rgba(212,168,67,0.12)",
    tickerBg: "rgba(6,9,25,0.55)",
    chipActiveBg: "rgba(212,168,67,0.16)", chipActiveBorder: "rgba(212,168,67,0.48)",
  },

  khmerNewYear: {
    id: "khmerNewYear",
    label: "Khmer New Year",
    mode: "day",
    seasonalDefault: { startsAt: "04-13", endsAt: "04-16", recurringAnnual: true },
    surface:
      "radial-gradient(ellipse 90% 100% at 0% 0%, rgba(255,200,80,0.2) 0%, transparent 55%)," +
      "radial-gradient(ellipse 90% 100% at 100% 100%, rgba(214,50,50,0.22) 0%, transparent 55%)," +
      "linear-gradient(150deg, #3A0A0A 0%, #6B1414 55%, #8C1C1C 100%)",
    glassIntensity: "strong",
    borderColor: "rgba(255,200,80,0.16)",
    borderGlow: "rgba(255,200,80,0.18)",
    shadow: "0 16px 44px rgba(60,5,5,0.45)",
    primary: "#FFC850", secondary: "#D63232", accent: "#FFE3A0",
    accentBarGradient: "linear-gradient(180deg, #FFE3A0 0%, #FFC850 45%, #D63232 100%)",
    goldAccent: "#FFC850", emeraldAccent: "#FF6B6B",
    onSurface: "#FFFFFF", onSurfaceSoft: "rgba(255,255,255,0.78)",
    headerColor: "#FFFFFF", nameColor: "#FFFFFF", labelColor: "#FFC850", scoreColor: "#FFE3A0",
    liveBadge: { color: "#FFC850", bg: "rgba(255,200,80,0.16)", border: "rgba(255,200,80,0.5)" },
    rankTile: {
      1: rank("linear-gradient(135deg, #FFE3A0, #FFC850)", "rgba(255,200,80,0.55)", "#3A2000"),
      2: rank("linear-gradient(135deg, #FF8A8A, #D63232)", "rgba(214,50,50,0.4)", "#2A0505"),
      3: rank("linear-gradient(135deg, #D63232, #8C1C1C)", "rgba(214,50,50,0.35)", "#FFFFFF"),
      rest: rank("linear-gradient(135deg, rgba(214,50,50,0.42), rgba(255,200,80,0.3))", "rgba(214,50,50,0.3)", "#FFFFFF"),
    },
    trophy: trophy("crownJewel", "#FFC850"),
    playerCard: playerCard({ borderStyle: "glow" }),
    decorations: decorations({
      lanterns: { enabled: true, intensity: "medium" },
      flowers: { enabled: true, intensity: "low" },
      sparkles: { enabled: true, intensity: "low" },
    }),
    surfaceCard: "rgba(255,255,255,0.05)", surfaceCardBorder: "rgba(255,200,80,0.14)",
    tickerBg: "rgba(35,5,5,0.55)",
    chipActiveBg: "rgba(255,200,80,0.18)", chipActiveBorder: "rgba(255,200,80,0.5)",
  },

  christmas: {
    id: "christmas",
    label: "Christmas",
    mode: "night",
    seasonalDefault: { startsAt: "12-20", endsAt: "01-02", recurringAnnual: true },
    surface:
      "radial-gradient(ellipse 90% 100% at 0% 0%, rgba(220,60,70,0.16) 0%, transparent 55%)," +
      "radial-gradient(ellipse 90% 100% at 100% 100%, rgba(40,140,80,0.18) 0%, transparent 55%)," +
      "linear-gradient(150deg, #08130D 0%, #0F2A1B 55%, #123420 100%)",
    glassIntensity: "subtle",
    borderColor: "rgba(255,255,255,0.08)",
    borderGlow: "rgba(220,60,70,0.14)",
    shadow: "0 14px 40px rgba(0,10,5,0.5)",
    primary: "#E0EBE2", secondary: "#DC3C46", accent: "#2E9C5C",
    accentBarGradient: "linear-gradient(180deg, #DC3C46 0%, #E0EBE2 45%, #2E9C5C 100%)",
    goldAccent: "#E8CD8F", emeraldAccent: "#2E9C5C",
    onSurface: "#FFFFFF", onSurfaceSoft: "rgba(255,255,255,0.7)",
    headerColor: "#FFFFFF", nameColor: "#FFFFFF", labelColor: "#E8CD8F", scoreColor: "#F2716B",
    liveBadge: { color: "#4FCB7E", bg: "rgba(46,156,92,0.16)", border: "rgba(46,156,92,0.5)" },
    rankTile: {
      1: rank("linear-gradient(135deg, #F2E7CE, #E8CD8F)", "rgba(232,205,143,0.45)", "#241505"),
      2: rank("linear-gradient(135deg, #F2716B, #DC3C46)", "rgba(220,60,70,0.4)", "#1A0505"),
      3: rank("linear-gradient(135deg, #4FCB7E, #2E9C5C)", "rgba(46,156,92,0.35)", "#0A140E"),
      rest: rank("linear-gradient(135deg, rgba(220,60,70,0.35), rgba(46,156,92,0.3))", "rgba(46,156,92,0.28)", "#FFFFFF"),
    },
    trophy: trophy("star", "#E8CD8F", { medalDesign: "star" }),
    playerCard: playerCard(),
    decorations: decorations({
      snow: { enabled: true, intensity: "medium" },
      seasonalOrnaments: { enabled: true, intensity: "low" },
      sparkles: { enabled: true, intensity: "low" },
    }),
    surfaceCard: "rgba(255,255,255,0.04)", surfaceCardBorder: "rgba(255,255,255,0.08)",
    tickerBg: "rgba(4,12,8,0.55)",
    chipActiveBg: "rgba(220,60,70,0.14)", chipActiveBorder: "rgba(220,60,70,0.42)",
  },

  independenceDay: {
    id: "independenceDay",
    label: "Independence Day",
    mode: "night",
    seasonalDefault: { startsAt: "11-08", endsAt: "11-10", recurringAnnual: true },
    surface:
      "radial-gradient(ellipse 90% 100% at 0% 0%, rgba(60,100,220,0.18) 0%, transparent 55%)," +
      "radial-gradient(ellipse 90% 100% at 100% 100%, rgba(214,50,50,0.18) 0%, transparent 55%)," +
      "linear-gradient(150deg, #060A1E 0%, #0F1740 55%, #142058 100%)",
    glassIntensity: "strong",
    borderColor: "rgba(255,255,255,0.1)",
    borderGlow: "rgba(255,255,255,0.12)",
    shadow: "0 16px 44px rgba(2,4,20,0.5)",
    primary: "#FFFFFF", secondary: "#3C64DC", accent: "#D63232",
    accentBarGradient: "linear-gradient(180deg, #D63232 0%, #FFFFFF 45%, #3C64DC 100%)",
    goldAccent: "#FFE3A0", emeraldAccent: "#6E8CFF",
    onSurface: "#FFFFFF", onSurfaceSoft: "rgba(255,255,255,0.75)",
    headerColor: "#FFFFFF", nameColor: "#FFFFFF", labelColor: "#FFE3A0", scoreColor: "#FFE3A0",
    liveBadge: { color: "#6E8CFF", bg: "rgba(60,100,220,0.16)", border: "rgba(60,100,220,0.5)" },
    rankTile: {
      1: rank("linear-gradient(135deg, #FFE3A0, #D63232)", "rgba(214,50,50,0.45)", "#240505"),
      2: rank("linear-gradient(135deg, #FFFFFF, #A8B8FF)", "rgba(255,255,255,0.35)", "#0A0E24"),
      3: rank("linear-gradient(135deg, #6E8CFF, #3C64DC)", "rgba(60,100,220,0.35)", "#FFFFFF"),
      rest: rank("linear-gradient(135deg, rgba(60,100,220,0.4), rgba(214,50,50,0.28))", "rgba(60,100,220,0.3)", "#FFFFFF"),
    },
    trophy: trophy("crownJewel", "#FFE3A0"),
    playerCard: playerCard({ borderStyle: "glow" }),
    decorations: decorations({
      fireworks: { enabled: true, intensity: "high" },
      confetti: { enabled: true, intensity: "medium" },
    }),
    surfaceCard: "rgba(255,255,255,0.05)", surfaceCardBorder: "rgba(255,255,255,0.1)",
    tickerBg: "rgba(3,6,20,0.55)",
    chipActiveBg: "rgba(255,255,255,0.1)", chipActiveBorder: "rgba(255,255,255,0.32)",
  },

  teacherAppreciation: {
    id: "teacherAppreciation",
    label: "Teacher Appreciation",
    mode: "day",
    surface:
      "radial-gradient(ellipse 90% 100% at 0% 0%, rgba(224,150,190,0.18) 0%, transparent 55%)," +
      "radial-gradient(ellipse 90% 100% at 100% 100%, rgba(140,90,200,0.18) 0%, transparent 55%)," +
      "linear-gradient(150deg, #1E0E22 0%, #3A1B44 55%, #4E2460 100%)",
    glassIntensity: "subtle",
    borderColor: "rgba(224,150,190,0.14)",
    borderGlow: "rgba(224,150,190,0.16)",
    shadow: "0 14px 40px rgba(20,5,25,0.45)",
    primary: "#F0B8D6", secondary: "#9C5FC8", accent: "#F4D8E8",
    accentBarGradient: "linear-gradient(180deg, #F4D8E8 0%, #F0B8D6 45%, #9C5FC8 100%)",
    goldAccent: "#F0B8D6", emeraldAccent: "#9C5FC8",
    onSurface: "#FFFFFF", onSurfaceSoft: "rgba(255,255,255,0.72)",
    headerColor: "#FFFFFF", nameColor: "#FFFFFF", labelColor: "#F0B8D6", scoreColor: "#F4D8E8",
    liveBadge: { color: "#C89AE8", bg: "rgba(156,95,200,0.16)", border: "rgba(156,95,200,0.5)" },
    rankTile: {
      1: rank("linear-gradient(135deg, #F4D8E8, #F0B8D6)", "rgba(240,184,214,0.5)", "#3A1220"),
      2: rank("linear-gradient(135deg, #C89AE8, #9C5FC8)", "rgba(156,95,200,0.4)", "#20102A"),
      3: rank("linear-gradient(135deg, #9C5FC8, #5E3480)", "rgba(156,95,200,0.35)", "#FFFFFF"),
      rest: rank("linear-gradient(135deg, rgba(156,95,200,0.4), rgba(240,184,214,0.28))", "rgba(156,95,200,0.3)", "#FFFFFF"),
    },
    trophy: trophy("wreath", "#F0B8D6", { medalDesign: "ribbon" }),
    playerCard: playerCard({ shape: "rounded" }),
    decorations: decorations({
      flowers: { enabled: true, intensity: "medium" },
      sparkles: { enabled: true, intensity: "low" },
    }),
    surfaceCard: "rgba(255,255,255,0.04)", surfaceCardBorder: "rgba(224,150,190,0.12)",
    tickerBg: "rgba(20,8,24,0.55)",
    chipActiveBg: "rgba(224,150,190,0.16)", chipActiveBorder: "rgba(224,150,190,0.48)",
  },

  backToSchool: {
    id: "backToSchool",
    label: "Back To School",
    mode: "day",
    surface:
      "radial-gradient(ellipse 90% 100% at 0% 0%, rgba(90,190,220,0.18) 0%, transparent 55%)," +
      "radial-gradient(ellipse 90% 100% at 100% 100%, rgba(255,150,60,0.16) 0%, transparent 55%)," +
      "linear-gradient(150deg, #06181E 0%, #0E323C 55%, #12414D 100%)",
    glassIntensity: "subtle",
    borderColor: "rgba(90,190,220,0.14)",
    borderGlow: "rgba(90,190,220,0.16)",
    shadow: "0 14px 40px rgba(2,15,20,0.45)",
    primary: "#5ABEDC", secondary: "#FF965C", accent: "#B8ECFA",
    accentBarGradient: "linear-gradient(180deg, #B8ECFA 0%, #5ABEDC 45%, #FF965C 100%)",
    goldAccent: "#FFB985", emeraldAccent: "#5ABEDC",
    onSurface: "#FFFFFF", onSurfaceSoft: "rgba(255,255,255,0.72)",
    headerColor: "#FFFFFF", nameColor: "#FFFFFF", labelColor: "#B8ECFA", scoreColor: "#FFB985",
    liveBadge: { color: "#5ABEDC", bg: "rgba(90,190,220,0.16)", border: "rgba(90,190,220,0.5)" },
    rankTile: {
      1: rank("linear-gradient(135deg, #FFE0C2, #FF965C)", "rgba(255,150,92,0.5)", "#3A1E05"),
      2: rank("linear-gradient(135deg, #B8ECFA, #5ABEDC)", "rgba(90,190,220,0.4)", "#052029"),
      3: rank("linear-gradient(135deg, #5ABEDC, #2E7A94)", "rgba(90,190,220,0.35)", "#FFFFFF"),
      rest: rank("linear-gradient(135deg, rgba(90,190,220,0.4), rgba(255,150,92,0.28))", "rgba(90,190,220,0.3)", "#FFFFFF"),
    },
    trophy: trophy("medal", "#FFB985"),
    playerCard: playerCard({ cornerRadius: radius.md }),
    decorations: decorations({
      confetti: { enabled: true, intensity: "low" },
      sparkles: { enabled: true, intensity: "low" },
    }),
    surfaceCard: "rgba(255,255,255,0.04)", surfaceCardBorder: "rgba(90,190,220,0.12)",
    tickerBg: "rgba(4,16,20,0.55)",
    chipActiveBg: "rgba(90,190,220,0.16)", chipActiveBorder: "rgba(90,190,220,0.46)",
  },

  halloween: {
    id: "halloween",
    label: "Halloween",
    mode: "night",
    seasonalDefault: { startsAt: "10-25", endsAt: "11-01", recurringAnnual: true },
    surface:
      "radial-gradient(ellipse 90% 100% at 0% 0%, rgba(255,140,40,0.18) 0%, transparent 55%)," +
      "radial-gradient(ellipse 90% 100% at 100% 100%, rgba(120,50,180,0.2) 0%, transparent 55%)," +
      "linear-gradient(150deg, #0A0410 0%, #1C0E28 55%, #241236 100%)",
    glassIntensity: "strong",
    borderColor: "rgba(255,140,40,0.14)",
    borderGlow: "rgba(255,140,40,0.16)",
    shadow: "0 16px 44px rgba(5,0,10,0.55)",
    primary: "#FF8C28", secondary: "#7832B4", accent: "#FFB870",
    accentBarGradient: "linear-gradient(180deg, #FFB870 0%, #FF8C28 45%, #7832B4 100%)",
    goldAccent: "#FFB870", emeraldAccent: "#A25AE0",
    onSurface: "#FFFFFF", onSurfaceSoft: "rgba(255,255,255,0.7)",
    headerColor: "#FFFFFF", nameColor: "#FFFFFF", labelColor: "#FFB870", scoreColor: "#FF8C28",
    liveBadge: { color: "#A25AE0", bg: "rgba(120,50,180,0.18)", border: "rgba(120,50,180,0.5)" },
    rankTile: {
      1: rank("linear-gradient(135deg, #FFD9A8, #FF8C28)", "rgba(255,140,40,0.5)", "#301605"),
      2: rank("linear-gradient(135deg, #C58AF0, #7832B4)", "rgba(120,50,180,0.4)", "#1A0A26"),
      3: rank("linear-gradient(135deg, #7832B4, #481E70)", "rgba(120,50,180,0.35)", "#FFFFFF"),
      rest: rank("linear-gradient(135deg, rgba(120,50,180,0.42), rgba(255,140,40,0.3))", "rgba(120,50,180,0.3)", "#FFFFFF"),
    },
    trophy: trophy("star", "#FFB870"),
    playerCard: playerCard({ borderStyle: "glow" }),
    decorations: decorations({
      sparkles: { enabled: true, intensity: "medium", colorOverride: "#FF8C28" },
      stars: { enabled: true, intensity: "low", colorOverride: "#A25AE0" },
    }),
    surfaceCard: "rgba(255,255,255,0.05)", surfaceCardBorder: "rgba(255,140,40,0.12)",
    tickerBg: "rgba(10,4,14,0.6)",
    chipActiveBg: "rgba(255,140,40,0.16)", chipActiveBorder: "rgba(255,140,40,0.46)",
  },

  anniversaryCelebration: {
    id: "anniversaryCelebration",
    label: "Anniversary Celebration",
    mode: "night",
    surface:
      "radial-gradient(ellipse 90% 100% at 0% 0%, rgba(217,184,114,0.16) 0%, transparent 55%)," +
      "radial-gradient(ellipse 90% 100% at 100% 100%, rgba(120,60,200,0.2) 0%, transparent 55%)," +
      "linear-gradient(150deg, #100A20 0%, #1E1240 55%, #281858 100%)",
    glassIntensity: "strong",
    borderColor: "rgba(217,184,114,0.14)",
    borderGlow: "rgba(217,184,114,0.16)",
    shadow: "0 16px 44px rgba(5,2,20,0.5)",
    primary: "#D9B872", secondary: "#7C3CC8", accent: "#F4E5C1",
    accentBarGradient: "linear-gradient(180deg, #F4E5C1 0%, #D9B872 45%, #7C3CC8 100%)",
    goldAccent: "#D9B872", emeraldAccent: "#9C6AE0",
    onSurface: "#FFFFFF", onSurfaceSoft: "rgba(255,255,255,0.72)",
    headerColor: "#FFFFFF", nameColor: "#FFFFFF", labelColor: "#D9B872", scoreColor: "#F4E5C1",
    liveBadge: { color: "#9C6AE0", bg: "rgba(124,60,200,0.16)", border: "rgba(124,60,200,0.5)" },
    rankTile: {
      1: rank("linear-gradient(135deg, #F4E5C1, #D9B872)", "rgba(217,184,114,0.5)", "#241708"),
      2: rank("linear-gradient(135deg, #C29CF0, #7C3CC8)", "rgba(124,60,200,0.4)", "#150A28"),
      3: rank("linear-gradient(135deg, #7C3CC8, #4A2280)", "rgba(124,60,200,0.35)", "#FFFFFF"),
      rest: rank("linear-gradient(135deg, rgba(124,60,200,0.4), rgba(217,184,114,0.3))", "rgba(124,60,200,0.3)", "#FFFFFF"),
    },
    trophy: trophy("crownJewel", "#D9B872"),
    playerCard: playerCard({ borderStyle: "glow" }),
    decorations: decorations({
      confetti: { enabled: true, intensity: "medium" },
      balloons: { enabled: true, intensity: "low" },
      sparkles: { enabled: true, intensity: "medium" },
    }),
    surfaceCard: "rgba(255,255,255,0.05)", surfaceCardBorder: "rgba(217,184,114,0.12)",
    tickerBg: "rgba(8,4,18,0.55)",
    chipActiveBg: "rgba(217,184,114,0.16)", chipActiveBorder: "rgba(217,184,114,0.46)",
  },
};

export const ACHIEVEMENT_PRESET_IDS = Object.keys(achievementThemes);

export function getAchievementTheme(themeIdOrLegacyMode) {
  if (themeIdOrLegacyMode && achievementThemes[themeIdOrLegacyMode]) {
    return achievementThemes[themeIdOrLegacyMode];
  }
  // Legacy call shape (Phase E): getAchievementTheme("dark"|"light") from
  // the app's day/night theme value, before per-config theme selection
  // existed. Kept working so any not-yet-migrated caller is unaffected.
  return themeIdOrLegacyMode === "dark" ? achievementThemes.midnightAchievement : achievementThemes.emeraldAchievement;
}

/** Resolves a theme for "Follow Welcome Theme" sync mode — maps the app's
 * resolved day/night state to the matching Achievement pair member. Any
 * OTHER preset selected explicitly by an admin always wins regardless of
 * day/night (sync mode only applies to the base Emerald/Midnight pair). */
export function resolveFollowWelcomeTheme(appTheme) {
  return appTheme === "dark" ? achievementThemes.midnightAchievement : achievementThemes.emeraldAchievement;
}

export default {
  achievementThemes, ACHIEVEMENT_PRESET_IDS, DECORATION_TYPES,
  TROPHY_STYLES, MEDAL_DESIGNS, WINNER_ANIMATIONS, CARD_SHAPES,
  getAchievementTheme, resolveFollowWelcomeTheme,
};
