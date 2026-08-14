/**
 * DecorationLayer.jsx — shared decoration/particle renderer, generalized
 * from AchievementDecorations.jsx (Achievement Experience Studio) so the
 * Promotion Experience Studio (approved directive, Phase 1-5) doesn't
 * introduce a THIRD parallel decoration implementation alongside this one
 * and Hero.jsx's separate token-driven particlePresets.js.
 *
 * AchievementDecorations.jsx now re-exports this component unchanged
 * (testidPrefix="achievement"), so every existing achievement_top_earner
 * config, and AchievementDecorations.test.jsx's exact data-testid contract
 * (`achievement-decoration-{type}`, `achievement-decorations`), keeps
 * working byte-for-byte — this file is a generalization, not a rewrite.
 *
 * Adds 3 types for Promotion: academicParticles, premiumDust, lightRays —
 * on top of the original 10 (confetti, stars, sparkles, fireworks, snow,
 * lanterns, balloons, flowers, ribbons, seasonalOrnaments).
 *
 * Same guarantees as before:
 *   - deterministic pseudo-random positioning (Math.sin()-based, never
 *     Math.random()) so a re-render never reshuffles the layout.
 *   - burst-only effects (confetti, fireworks, balloons) render NOTHING
 *     under prefers-reduced-motion; every other type renders a static,
 *     settled frame instead of freezing mid-animation.
 */
import { motion } from "framer-motion";

const INTENSITY_COUNT = { low: 4, medium: 8, high: 14 };

const GLYPH = {
  confetti: ["▮", "▯", "●"],
  stars: ["✦"],
  sparkles: ["✨"],
  fireworks: ["🎆"],
  snow: ["❄"],
  lanterns: ["🏮"],
  balloons: ["🎈"],
  flowers: ["🌸"],
  ribbons: ["🎗"],
  seasonalOrnaments: ["⭐", "🎄"],
  academicParticles: ["🎓", "📚", "✏️"],
  premiumDust: ["·", "✧"],
};

// Burst-only effects have no meaningful still frame — suppressed entirely
// under prefers-reduced-motion rather than shown frozen mid-burst.
const BURST_ONLY = new Set(["confetti", "fireworks", "balloons"]);

function seededItems(count, seedOffset) {
  const items = [];
  for (let i = 0; i < count; i++) {
    // Deterministic pseudo-spread via trig — same output every render,
    // no per-mount layout shuffle, no Math.random() dependency.
    const t = i + seedOffset;
    items.push({
      x: `${(Math.abs(Math.sin(t * 12.9898)) * 92 + 4).toFixed(1)}%`,
      y: `${(Math.abs(Math.sin(t * 78.233)) * 90 + 4).toFixed(1)}%`,
      delay: (Math.abs(Math.sin(t * 37.719)) * 3).toFixed(2),
      duration: 3 + (Math.abs(Math.sin(t * 4.671)) * 3),
      rotate: (Math.abs(Math.sin(t * 5.923)) * 60 - 30).toFixed(1),
      glyphIdx: i,
    });
  }
  return items;
}

function LightRayItem({ it, i, color, animateEnabled }) {
  const style = {
    position: "absolute",
    left: it.x,
    top: 0,
    width: 2,
    height: "140%",
    transformOrigin: "top center",
    background: `linear-gradient(180deg, ${color || "rgba(255,255,255,0.5)"} 0%, transparent 75%)`,
    transform: `rotate(${it.rotate}deg)`,
  };
  if (!animateEnabled) {
    return <span key={i} className="absolute select-none" style={{ ...style, opacity: 0.35 }} />;
  }
  return (
    <motion.span
      key={i}
      className="absolute select-none"
      style={style}
      initial={{ opacity: 0 }}
      animate={{ opacity: [0, 0.5, 0.15, 0.5] }}
      transition={{ duration: it.duration + 1, delay: Number(it.delay), repeat: Infinity, ease: "easeInOut" }}
    />
  );
}

function TypeLayer({ type, config, animateEnabled, testidPrefix }) {
  const count = INTENSITY_COUNT[config.intensity] || INTENSITY_COUNT.medium;

  if (!animateEnabled && BURST_ONLY.has(type)) return null;

  const items = seededItems(count, type.length);
  const color = config.colorOverride || undefined;

  return (
    <div
      aria-hidden
      className="absolute inset-0 overflow-hidden pointer-events-none"
      style={{ pointerEvents: "none" }}
      data-testid={`${testidPrefix}-decoration-${type}`}
    >
      {type === "lightRays"
        ? items.map((it, i) => (
            <LightRayItem key={i} it={it} i={i} color={color} animateEnabled={animateEnabled} />
          ))
        : items.map((it, i) => {
            const glyphs = GLYPH[type] || ["✦"];
            const glyph = glyphs[it.glyphIdx % glyphs.length];
            const className = "absolute select-none";
            const baseStyle = { left: it.x, top: it.y, color, fontSize: type === "fireworks" ? 18 : 12 };

            if (!animateEnabled) {
              // Ambient-only: settled, non-animated glyph.
              return <span key={i} className={className} style={{ ...baseStyle, opacity: 0.55 }}>{glyph}</span>;
            }
            if (type === "snow" || type === "balloons" || type === "flowers" || type === "premiumDust") {
              return (
                <motion.span
                  key={i}
                  className={className}
                  style={baseStyle}
                  initial={{ opacity: 0, y: type === "snow" || type === "premiumDust" ? "-10%" : "0%" }}
                  animate={{
                    opacity: [0, type === "premiumDust" ? 0.5 : 0.8, type === "premiumDust" ? 0.5 : 0.8, 0],
                    y: type === "snow" || type === "premiumDust" ? "110%" : "-40%",
                  }}
                  transition={{ duration: it.duration, delay: Number(it.delay), repeat: Infinity, ease: "linear" }}
                >
                  {glyph}
                </motion.span>
              );
            }
            if (type === "confetti" || type === "fireworks") {
              return (
                <motion.span
                  key={i}
                  className={className}
                  style={baseStyle}
                  initial={{ opacity: 0, scale: 0.4, rotate: 0 }}
                  animate={{ opacity: [0, 1, 0], scale: [0.4, 1, 0.6], rotate: 180 }}
                  transition={{ duration: 1.4, delay: Number(it.delay) % 2.5, repeat: Infinity, repeatDelay: it.duration }}
                >
                  {glyph}
                </motion.span>
              );
            }
            // stars / sparkles / lanterns / ribbons / seasonalOrnaments /
            // academicParticles — gentle twinkle/sway.
            return (
              <motion.span
                key={i}
                className={className}
                style={baseStyle}
                initial={{ opacity: 0 }}
                animate={{ opacity: [0, 0.85, 0.3, 0.85], rotate: type === "lanterns" ? [-4, 4, -4] : 0 }}
                transition={{ duration: it.duration, delay: Number(it.delay), repeat: Infinity, ease: "easeInOut" }}
              >
                {glyph}
              </motion.span>
            );
          })}
    </div>
  );
}

/** Renders every ENABLED decoration from a resolved config's `decorations`
 * object. `testidPrefix` lets each experience surface keep its own stable
 * test ids (e.g. "achievement", "promotion") without a component fork. */
export default function DecorationLayer({ decorations, animateEnabled, testidPrefix = "decoration" }) {
  if (!decorations) return null;
  const enabledTypes = Object.keys(decorations).filter((t) => decorations[t]?.enabled);
  if (!enabledTypes.length) return null;

  return (
    <div className="absolute inset-0 pointer-events-none" style={{ pointerEvents: "none" }} data-testid={`${testidPrefix}-decorations`}>
      {enabledTypes.map((type) => (
        <TypeLayer key={type} type={type} config={decorations[type]} animateEnabled={animateEnabled} testidPrefix={testidPrefix} />
      ))}
    </div>
  );
}
