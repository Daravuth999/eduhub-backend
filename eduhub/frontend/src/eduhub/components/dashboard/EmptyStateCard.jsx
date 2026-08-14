// EmptyStateCard.jsx — shared premium empty-state card (Home Dashboard V4
// polish pass).
//
// Per the Final Acceptance Report: sections must never simply vanish just
// because production data hasn't been authored yet — but they must also
// never fabricate data to fill the gap. This is the ONE shared, honest
// "nothing here yet" presentation DiscoveryCard, ContinueLearningShelf and
// MyRankCard all reuse, so their empty states share one visual language
// instead of three independent, drifting implementations.
//
// `compact` picks the right token tier for where this card sits:
//   false (default) — a full-width, primary/hero-tier slot (Discovery),
//     matching MissionHero/DiscoveryCard's own radius.lg + larger badge.
//   true — a tile-tier slot (Continue Learning, MyRankCard) that replaces
//     a single ordinary tile (radius.md, smaller badge/type scale) rather
//     than looming larger than the tiles around it.
//
// Artwork is optional and comes from the SAME heroArtwork-shaped object
// (assetId/url + the shared HeroArtworkLayer) every other Dashboard
// artwork slot uses — never a hardcoded/embedded illustration. Callers
// that have no artwork simply omit the prop; the icon glyph carries the
// visual weight instead.
import { motion } from "framer-motion";
import { elevation, radius } from "../../styles/tokens/designTokens";
import { easing, duration, ambient } from "../../styles/tokens/motionTokens";
import useAmbientActive from "../../hooks/useAmbientActive";
import HeroArtworkLayer from "../HeroArtworkLayer";

export default function EmptyStateCard({
  Icon,
  title,
  subtitle,
  ctaLabel,
  ctaHref,
  onCtaClick,
  artwork,
  accent = "#8B5CF6",
  animateEnabled = true,
  compact = false,
  "data-testid": testId,
}) {
  const Cta = ctaHref ? "a" : "button";
  const badgeSize = compact ? "w-9 h-9" : "w-11 h-11";
  const iconSize = compact ? "w-4.5 h-4.5" : "w-5 h-5";
  const titleSize = compact ? "text-[0.85rem]" : "text-[0.95rem]";
  const padding = compact ? "px-4 py-5" : "px-5 py-6";
  // RC2.5 — "make an empty state still feel alive": one subtle breathing
  // scale on the icon badge, shared by every Dashboard empty state through
  // this one component. Gated the same as every other continuous loop.
  const { ref: ambientRef, active: ambientActive } = useAmbientActive();
  const ambientOn = animateEnabled && ambientActive;

  return (
    <motion.div
      ref={ambientRef}
      initial={animateEnabled ? { opacity: 0, y: 8 } : false}
      animate={{ opacity: 1, y: 0 }}
      transition={{ duration: duration.base, ease: easing.premiumEaseOut }}
      className={`relative overflow-hidden border border-zinc-200/70 dark:border-white/[0.08] bg-white dark:bg-white/[0.04] text-center ${padding}`}
      style={{
        // RC2 — a faint accent tint layered above the theme-aware base
        // surface above (was previously the ONLY background, fading to
        // fully transparent — reading as a near-blank box rather than a
        // premium card).
        background: `linear-gradient(160deg, ${accent}14 0%, transparent 60%)`,
        boxShadow: elevation.soft,
        borderRadius: compact ? radius.md : radius.lg,
      }}
      data-testid={testId}
    >
      {artwork?.url && <HeroArtworkLayer heroArtwork={artwork} animateEnabled={animateEnabled} />}

      <div className="relative flex flex-col items-center gap-2.5">
        {Icon && (
          <motion.span
            className={`${badgeSize} rounded-xl flex items-center justify-center`}
            style={{ background: `${accent}1A`, color: accent }}
            animate={ambientOn ? { scale: [1, 1.05, 1] } : undefined}
            transition={{ duration: ambient.breathe, repeat: Infinity, ease: "easeInOut" }}
          >
            <Icon className={iconSize} />
          </motion.span>
        )}
        {title && (
          <p className={`font-display font-bold ${titleSize} text-ink dark:text-white`} data-testid="empty-state-title">
            {title}
          </p>
        )}
        {subtitle && (
          <p className="text-[0.8rem] text-zinc-500 dark:text-white/50 max-w-[26ch]" data-testid="empty-state-subtitle">
            {subtitle}
          </p>
        )}
        {ctaLabel && (
          <Cta
            href={ctaHref}
            onClick={onCtaClick}
            className="inline-flex items-center gap-1.5 mt-1.5 px-4 py-2 rounded-full text-[0.78rem] font-bold text-white active:scale-[0.97] transition-transform"
            style={{ background: accent }}
            data-testid="empty-state-cta"
          >
            {ctaLabel}
          </Cta>
        )}
      </div>
    </motion.div>
  );
}
