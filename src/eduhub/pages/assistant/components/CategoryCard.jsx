// CategoryCard.jsx — v2 premium learning tile for Free Chat landing
// and (with `compact`) the Speech Missions picker.
//
// PURELY PRESENTATIONAL — the parent's onSelect handler still receives
// the original card descriptor unchanged, preserving the mode+prompt
// contract and the runStarter / startMission flow.
//
// v2 direction:
//   • Soft matte surface with a subtle radial accent — no harsh neon
//     rectangle style, no on-white purple gradient.
//   • Original hand-authored SVG illustrations (from illustrations.jsx)
//     stay as the primary category identity — no icon-font glyphs as
//     the main visual, no emoji.
//   • Adapts to day/night automatically via the assistant-premium.css
//     tokens (`.ai-tile`, `--tile-accent`, `--tile-accent-ink`).
//
// data-testid: forwarded from the caller so existing Playwright
// selectors (ai-coach-starter-<key> / speech-mission-card-*) keep
// matching this node without modification.

import React from "react";
import { motion, useReducedMotion } from "framer-motion";
import { ArrowRight } from "lucide-react";
import { CATEGORY_ILLUSTRATION } from "./illustrations";

// Accent palette maps day- and night-friendly colours per category.
// Each pair (accent, accent-ink) is passed via CSS variables so the
// same class (.ai-tile) styles it consistently while the values
// automatically shift for higher-contrast in light mode.
const ACCENTS = {
  grammar:   { dark: "rgba(0,224,255,0.20)",   light: "rgba(10,143,179,0.14)",  ink: "#0a8fb3", inkDark: "#7defff" },
  writing:   { dark: "rgba(155,92,255,0.20)",  light: "rgba(106,62,216,0.14)",  ink: "#6a3ed8", inkDark: "#c9a8ff" },
  speaking:  { dark: "rgba(255,61,166,0.20)",  light: "rgba(200,31,120,0.14)",  ink: "#c81f78", inkDark: "#ff8fc7" },
  vocab:     { dark: "rgba(255,196,0,0.22)",   light: "rgba(163,105,14,0.14)",  ink: "#a3690e", inkDark: "#ffd24d" },
  ielts:     { dark: "rgba(80,220,160,0.22)",  light: "rgba(47,143,104,0.14)",  ink: "#2f8f68", inkDark: "#7af2c4" },
  pronounce: { dark: "rgba(120,180,255,0.22)", light: "rgba(60,110,200,0.14)",  ink: "#3c6ec8", inkDark: "#a8c8ff" },
};

function accentStyleFor(key) {
  const a = ACCENTS[key] || ACCENTS.grammar;
  // The accent variable is used by the radial glow via `.ai-tile::before`
  // and the mode label ink colour. Dark defaults win when data-theme is
  // absent (dark), the light overrides come in via the .light-theme
  // adjacent rule below.
  return {
    // CSS custom properties for the tile scope
    "--tile-accent": a.dark,
    "--tile-accent-ink": a.inkDark,
  };
}

export default function CategoryCard({
  card,
  onSelect,
  disabled,
  testId,
  compact = false,
}) {
  const reduced = useReducedMotion();
  const Illu = CATEGORY_ILLUSTRATION[card.key];

  return (
    <motion.button
      type="button"
      onClick={() => onSelect && onSelect(card)}
      disabled={disabled}
      data-testid={testId}
      whileTap={reduced || disabled ? undefined : { scale: 0.98 }}
      whileHover={reduced || disabled ? undefined : { y: -2 }}
      className={`ai-tile ai-tile--${card.key} ${compact ? "ai-tile--compact" : ""}`}
      style={{ ...accentStyleFor(card.key), padding: compact ? 12 : undefined }}
      data-category={card.key}
    >
      <span className="ai-tile__row">
        {Illu ? (
          <span className="ai-tile__art">
            <Illu size={compact ? 34 : 42} />
          </span>
        ) : null}

        <span className="ai-tile__body">
          <span className="ai-tile__mode">
            {card.mode || card.label}
          </span>
          <span className="ai-tile__title">
            {card.label}
          </span>
          {card.sub || card.blurb ? (
            <span className="ai-tile__sub">
              {card.sub || card.blurb}
            </span>
          ) : null}
        </span>

        <ArrowRight className="ai-tile__arrow" aria-hidden="true" />
      </span>
    </motion.button>
  );
}
