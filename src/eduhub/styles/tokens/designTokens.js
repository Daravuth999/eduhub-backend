/**
 * designTokens.js — platform-level design tokens for EduHub's Experience
 * Configuration Platform.
 *
 * NOT Hero-specific. Any experience (Welcome Dashboard, Digital Books hero,
 * Speaking Lab landing, achievement celebrations, seasonal campaigns, ...)
 * references these by NAME from its `appearance` domain
 * (e.g. appearance.paletteId = "morningEmerald") instead of inlining hex
 * values — that's what makes the visual language reusable instead of
 * copy-pasted per feature.
 *
 * Adding a new palette/scale value here never requires touching a
 * component — components read tokens by key, they never hardcode colors.
 */

// ── Palettes ────────────────────────────────────────────────────────────
// Each palette is a complete, self-consistent set — base gradient stops,
// an accent, and a soft/glow color for typography and particles. New
// experiences pick a palette by id; they don't invent new hex values.
export const palettes = {
  morningEmerald: {
    label: "Morning Emerald",
    base: ["#0E1F18", "#134B34", "#1E6948"],
    baseAngle: 160,
    accent: "#D9B872",       // champagne gold
    bloom: "#28C74F",
    softGlow: "#DFFFE9",     // warm white/green halo
    onBase: "#FFFFFF",
    onBaseSoft: "rgba(255,255,255,0.70)",
  },
  auroraNight: {
    // The pre-existing RGB/aurora look, preserved as a named palette (not
    // deleted) so any experience that still wants it can reference it —
    // nothing about the old visual language is lost, only made optional.
    label: "Aurora Night",
    base: ["#1a0a3e", "#2a0a5e", "#0a1f4a"],
    baseAngle: 135,
    accent: "#ffc94d",
    bloom: "#00e0ff",
    softGlow: "#ff3da6",
    onBase: "#FFFFFF",
    onBaseSoft: "rgba(255,255,255,0.70)",
  },
};

// ── Spacing scale (rem) — shared rhythm across experience surfaces ───────
export const spacing = {
  xs: 0.25, sm: 0.5, md: 1, lg: 1.5, xl: 2, xxl: 3,
};

// ── Section rhythm (rem) — Dashboard Foundation Phase 1. Named vertical
// gaps a zone wrapper uses BETWEEN its children (never a child's own
// margin) so scrolling reads as intentional beats instead of uniform
// stacking. `tight` groups closely-related content (e.g. Hero -> the
// promotion that visually continues beneath it); `primary` is the default
// gap between adjacent sections in the same zone; `pause` is a deliberate
// breathing pause before a new content group starts (e.g. before an
// Achievement-tier section).
export const sectionRhythm = {
  tight: spacing.md,
  // RC3 §9 — Mobile-First Spacing: `primary` tightened from spacing.xl
  // (2rem/32px) to spacing.lg (1.5rem/24px). The Dashboard grew from 6 to
  // 8 top-level sections across RC2.5/RC2.9/RC3, so the SAME per-gap value
  // now compounds into noticeably more total scroll distance; a smaller
  // gap keeps sections visually distinct (still clearly more than `tight`)
  // while meaningfully reducing one-handed scroll length on a phone.
  primary: spacing.lg,
  // Campaign Design Studio 2.0 rhythm pass: the pre-Achievement breathing
  // pause was a full 3rem (xxl), which read as a disconnect between the
  // Activity group and the Leaderboard. 2.5rem (xl + sm) keeps a beat that
  // is still clearly larger than `primary` while pulling the zones into one
  // continuous premium flow.
  pause: spacing.xl + spacing.sm,
};

// ── Elevation / shadow scale ──────────────────────────────────────────────
// Named levels (Dashboard Foundation Phase 1) — one consistent language
// instead of every component inventing its own boxShadow string:
//   Level 0 flat      — background, never elevated
//   Level 1 soft       — ordinary containers
//   Level 2 raised      — featured cards
//   Level 3 floating     — floating controls (chips, pills, FABs)
//   Level 4 dialog      — dialogs / modals / sheets
export const elevation = {
  flat: "none",
  soft: "0 8px 24px rgba(9,28,20,0.18)",
  raised: "0 18px 44px rgba(9,28,20,0.35)",
  floating: "0 24px 60px rgba(9,28,20,0.45)",
  dialog: "0 32px 80px rgba(9,28,20,0.55)",
};

export const ELEVATION_LEVELS = [
  { level: 0, id: "flat", label: "Background" },
  { level: 1, id: "soft", label: "Containers" },
  { level: 2, id: "raised", label: "Featured cards" },
  { level: 3, id: "floating", label: "Floating controls" },
  { level: 4, id: "dialog", label: "Dialogs" },
];

// ── Corner radius scale ───────────────────────────────────────────────────
export const radius = {
  sm: "10px", md: "16px", lg: "20px", xl: "28px", pill: "999px",
};

// ── Glass-effect presets (backdrop treatment for chips/badges) ───────────
export const glass = {
  subtle: { background: "rgba(255,255,255,0.06)", border: "1px solid rgba(255,255,255,0.12)" },
  strong: { background: "rgba(255,255,255,0.10)", border: "1px solid rgba(255,255,255,0.18)" },
};

// ── Safe margins for responsive banner/hero surfaces (rem) ───────────────
export const safeMargins = {
  mobile: { x: 1, y: 1 },
  desktop: { x: 1.5, y: 1.5 },
};

export function getPalette(paletteId) {
  return palettes[paletteId] || palettes.morningEmerald;
}

export default {
  palettes, spacing, sectionRhythm, elevation, ELEVATION_LEVELS,
  radius, glass, safeMargins, getPalette,
};
