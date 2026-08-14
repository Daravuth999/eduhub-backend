/**
 * PromotionCtaBar.jsx — multi-button CTA bar for the Promotion Experience
 * Studio (approved directive, Phase 1-5).
 *
 * Reuses artworkClickAction.js's EXACT action vocabulary and handler
 * unchanged — "reuse existing click-action routing, do not create parallel
 * navigation." Each button's `action` is the same `{type, value}` shape a
 * campaign's `click_action` already used, so a migrated campaign's single
 * click action becomes button #1 with zero data transformation.
 */
import { motion } from "framer-motion";
import { makeArtworkClickHandler } from "../artwork/artworkClickAction";

const ENTRANCE_VARIANTS = {
  fade: { initial: { opacity: 0 }, animate: { opacity: 1 } },
  rise: { initial: { opacity: 0, y: 14 }, animate: { opacity: 1, y: 0 } },
  scale: { initial: { opacity: 0, scale: 0.85 }, animate: { opacity: 1, scale: 1 } },
  pulse: {
    initial: { opacity: 0, scale: 0.92 },
    animate: { opacity: 1, scale: [1, 1.035, 1] },
    transition: { scale: { duration: 1.6, repeat: Infinity, ease: "easeInOut" } },
  },
};

function buttonVisualStyle(style, accent, onSurface) {
  switch (style) {
    case "outline":
      return { background: "transparent", color: accent, border: `1.5px solid ${accent}` };
    case "glass":
      return {
        background: "rgba(255,255,255,0.12)",
        color: onSurface,
        border: "1px solid rgba(255,255,255,0.22)",
        backdropFilter: "blur(10px)",
        WebkitBackdropFilter: "blur(10px)",
      };
    case "pill":
      return { background: accent, color: "#171310", border: "none", borderRadius: 999 };
    case "floating":
      return {
        background: accent,
        color: "#171310",
        border: "none",
        boxShadow: `0 10px 28px ${accent}55`,
      };
    case "filled":
    default:
      return { background: accent, color: "#171310", border: "none" };
  }
}

function CtaButton({ btn, theme, animateEnabled, index, placement }) {
  const disabled = Boolean(btn.disabled);
  const cornerRadius = theme.cta?.cornerRadius || "999px";
  const visual = buttonVisualStyle(btn.style || theme.cta?.style || "filled", theme.accent, theme.onSurface);
  const entranceKey = btn.animation || theme.cta?.animation || "rise";
  const entrance = ENTRANCE_VARIANTS[entranceKey] || ENTRANCE_VARIANTS.rise;

  const handleClick = makeArtworkClickHandler({ click_action: btn.action }, btn._handlers || {});

  const positionStyle =
    placement === "free" && Number.isFinite(btn.x) && Number.isFinite(btn.y)
      ? { position: "absolute", left: `${btn.x}%`, top: `${btn.y}%`, transform: "translate(-50%, -50%)" }
      : null;

  const baseStyle = {
    ...visual,
    borderRadius: btn.style === "pill" ? 999 : cornerRadius,
    padding: "10px 20px",
    fontSize: 13,
    fontWeight: 700,
    letterSpacing: "0.02em",
    cursor: disabled ? "not-allowed" : "pointer",
    opacity: disabled ? 0.5 : 1,
    pointerEvents: disabled ? "none" : "auto",
    ...positionStyle,
  };

  const motionProps = animateEnabled
    ? {
        initial: entrance.initial,
        animate: entrance.animate,
        transition: { duration: 0.4, delay: index * 0.07, ease: [0.22, 1, 0.36, 1], ...(entrance.transition || {}) },
        whileHover: disabled ? undefined : { scale: 1.035 },
        whileTap: disabled ? undefined : { scale: 0.97 },
      }
    : {};

  return (
    <motion.button
      type="button"
      disabled={disabled}
      aria-disabled={disabled}
      onClick={disabled ? undefined : handleClick}
      data-testid={`promotion-cta-${btn.id || index}`}
      className="inline-flex items-center justify-center focus-visible:outline focus-visible:outline-2 focus-visible:outline-offset-2"
      style={{ ...baseStyle, outlineColor: theme.accent, minHeight: 40, minWidth: 44 }}
      {...motionProps}
    >
      {btn.label || "Learn more"}
    </motion.button>
  );
}

/**
 * @param {object[]} buttons - [{id, label, style, animation, action:{type,value}, disabled, x, y}]
 * @param {object} theme - resolved presentation object (resolvePromotionPresentation)
 * @param {string} placement - "stack" | "center" | "relative" | "free"
 * @param {object} handlers - { navigate, openTopUp } forwarded to artworkClickAction.js unchanged
 */
export default function PromotionCtaBar({ buttons, theme, placement = "stack", animateEnabled = true, navigate, openTopUp }) {
  const list = Array.isArray(buttons) ? buttons.filter((b) => b?.label) : [];
  if (!list.length) return null;

  const containerClass =
    placement === "stack"
      ? "flex flex-col items-start gap-2"
      : placement === "center"
        ? "flex flex-wrap items-center justify-center gap-2"
        : placement === "free"
          ? "relative w-full h-full"
          : "flex flex-wrap items-center gap-2"; // relative

  return (
    <div className={containerClass} data-testid="promotion-cta-bar">
      {list.map((btn, i) => (
        <CtaButton
          key={btn.id ?? i}
          btn={{ ...btn, _handlers: { navigate, openTopUp } }}
          theme={theme}
          animateEnabled={animateEnabled}
          index={i}
          placement={placement}
        />
      ))}
    </div>
  );
}
