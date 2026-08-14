/**
 * PromotionPanel.jsx — the Promotion Experience Studio's rendering engine
 * (approved directive, Phase 1-5). Composes Theme -> Artwork -> Overlay ->
 * Decoration -> Typography -> CTA -> Motion exactly per the accepted Phase 0
 * architecture, reusing HeroArtworkLayer, DecorationLayer, and
 * artworkClickAction.js unmodified rather than re-implementing any of them.
 *
 * SAFEST POSSIBLE CUTOVER MECHANISM (per the directive's regression
 * requirements — "additive, do not remove the current system until the
 * replacement is fully verified"): when there is no PUBLISHED
 * promotional_banner ExperienceConfig yet, this component renders the
 * EXISTING Artwork Campaign System v1.0 carousel internally, byte-for-byte
 * identical to what Dashboard.jsx rendered before this directive. Nothing
 * changes for students until an admin actually publishes a Promotion
 * config in the new Studio — day one behavior is unchanged by construction,
 * not by testing effort.
 *
 * @param {object} [promotionConfig] - resolved ExperienceConfig for
 *   experienceType="promotional_banner" (see useDashboardBootstrap /
 *   useExperienceConfig). Optional — same "absent = untouched legacy
 *   behavior" contract TopEarnerPanel established for achievementConfig.
 * @param {"light"|"dark"} [appThemeOverride] - Studio Live Preview only.
 *   When set, used INSTEAD OF the live app theme so an author can toggle
 *   Day/Night in the editor without touching the real app-wide theme
 *   preference. Omitted in every real (non-Studio) render.
 */
import { useMemo } from "react";
import { motion, useReducedMotion } from "framer-motion";
import { useNavigate } from "react-router-dom";
import { useTheme } from "../pages/portal/hooks/useTheme";
import { resolvePromotionPresentation } from "../lib/experienceConfig/promotionConfigResolver";
import { getArtworkLayout, getArtworkOverlayStyle } from "../lib/experienceConfig/heroArtworkSchema";
import HeroArtworkLayer from "./HeroArtworkLayer";
import DecorationLayer from "./decorations/DecorationLayer";
import PromotionTypography from "./promotion/PromotionTypography";
import PromotionCtaBar from "./promotion/PromotionCtaBar";
import ArtworkCarousel from "./artwork/ArtworkCarousel";
import ArtworkDefaultHero from "./artwork/ArtworkDefaultHero";
import useArtworkTopUp from "./artwork/useArtworkTopUp";
// Campaign Design Studio 2.0 — canvas rendering engine (schemaVersion 2).
// Additive: only used when the resolver detects content.canvas; every
// legacy config renders through the untouched path below.
import CampaignCanvasRenderer from "./campaign/CampaignCanvasRenderer";

const DASHBOARD_HERO_PLACEMENT = "dashboard_hero";

const ENTRANCE_VARIANTS = {
  fade: { initial: { opacity: 0 }, animate: { opacity: 1 } },
  slide: { initial: { opacity: 0, x: 24 }, animate: { opacity: 1, x: 0 } },
  float: { initial: { opacity: 0, y: 18 }, animate: { opacity: 1, y: 0 } },
  zoom: { initial: { opacity: 0, scale: 0.94 }, animate: { opacity: 1, scale: 1 } },
  // Entrance-only depth effect (a larger initial offset), NOT scroll-linked
  // parallax — the Phase 0 audit's performance section explicitly rules out
  // scroll listeners for this surface.
  parallax: { initial: { opacity: 0, y: 34, scale: 0.98 }, animate: { opacity: 1, y: 0, scale: 1 } },
};

export default function PromotionPanel({ promotionConfig, appThemeOverride } = {}) {
  const { theme: liveTheme } = useTheme();
  const theme = appThemeOverride || liveTheme;
  const prefersReducedMotion = useReducedMotion();
  const animateEnabled = !prefersReducedMotion;
  const navigate = useNavigate();
  const { openTopUp, topUpNode } = useArtworkTopUp();

  const resolved = useMemo(
    () => resolvePromotionPresentation(promotionConfig, { appTheme: theme }),
    [promotionConfig, theme],
  );

  // No published Promotion config yet -> fall back to the untouched legacy
  // system for this exact placement. See module docstring.
  if (!promotionConfig) {
    return (
      <ArtworkCarousel
        placement={DASHBOARD_HERO_PLACEMENT}
        showCaption
        fallback={<ArtworkDefaultHero />}
      />
    );
  }

  if (!resolved.visible) return null;

  // ── Campaign Design Studio 2.0 — canvas rendering branch ────────────────
  // A published canvas campaign renders through the SAME engine the Studio
  // canvas uses (CampaignCanvasRenderer), guaranteeing the dashboard matches
  // the author's canvas exactly. Legacy configs never reach this branch.
  if (resolved.canvas) {
    return (
      <motion.section
        {...(animateEnabled
          ? { initial: { opacity: 0, y: 14 }, animate: { opacity: 1, y: 0 }, transition: { duration: 0.5, ease: [0.25, 0.8, 0.25, 1] } }
          : { initial: false, animate: { opacity: 1 } })}
        className="relative overflow-hidden rounded-2xl"
        style={{ boxShadow: `${resolved.shadow || "0 14px 40px rgba(0,0,0,0.35)"}, 0 0 0 1px ${resolved.borderColor || "rgba(0,0,0,0.08)"}` }}
        data-testid="promotion-panel"
        data-promotion-canvas="2"
      >
        <CampaignCanvasRenderer
          canvas={resolved.canvas}
          appTheme={theme}
          animateEnabled={animateEnabled}
          interactive
          handlers={{ navigate, openTopUp }}
        />
        {topUpNode}
      </motion.section>
    );
  }

  const artwork = resolved.artwork;
  const hasArtwork = Boolean(artwork?.url);
  const artworkOverlayStyle = hasArtwork ? getArtworkOverlayStyle(artwork) : null;
  const artworkContainerStyle = hasArtwork ? getArtworkLayout(artwork).containerStyle : null;

  const entrance = ENTRANCE_VARIANTS[resolved.motion?.entrance] || ENTRANCE_VARIANTS.fade;
  const motionProps = animateEnabled
    ? { initial: entrance.initial, animate: entrance.animate, transition: { duration: 0.5, ease: [0.25, 0.8, 0.25, 1] } }
    : { initial: false, animate: entrance.animate };

  return (
    <motion.section
      {...motionProps}
      className="relative overflow-hidden rounded-2xl"
      style={{
        aspectRatio: "21 / 9",
        background: resolved.surface,
        boxShadow: `${resolved.shadow || "0 14px 40px rgba(0,0,0,0.35)"}, 0 0 0 1px ${resolved.borderColor || "rgba(0,0,0,0.08)"}`,
      }}
      data-testid="promotion-panel"
      data-promotion-theme={resolved.mode}
      data-promotion-preset={resolved.id}
    >
      {/* Artwork Layer — reuses the SAME compositing layer + offline cache
          as Welcome Hero and Achievement (heroArtworkSchema.js /
          HeroArtworkLayer.jsx), no duplicate infrastructure. */}
      {hasArtwork && <HeroArtworkLayer heroArtwork={artwork} animateEnabled={animateEnabled} />}

      {/* Overlay Layer — artwork-scoped color/gradient wash (legibility),
          positioned identically to the artwork it sits above. */}
      {hasArtwork && artworkOverlayStyle && (
        <div aria-hidden style={{ ...artworkContainerStyle, ...artworkOverlayStyle }} data-testid="promotion-artwork-overlay" />
      )}

      {/* Panel-wide overlay — the theme's own scrim, independent of whether
          artwork is present, so text always has a legible base. */}
      {resolved.overlay?.color && (
        <div
          aria-hidden
          className="absolute inset-0 pointer-events-none"
          style={{ background: resolved.overlay.color, opacity: (resolved.overlay.opacity ?? 20) / 100 }}
          data-testid="promotion-panel-overlay"
        />
      )}

      {/* Decorative Layer — shared with Achievement (DecorationLayer.jsx). */}
      <DecorationLayer decorations={resolved.decorations} animateEnabled={animateEnabled} testidPrefix="promotion" />

      {/* Typography + CTA — foreground content. */}
      <div className="relative h-full w-full flex flex-col justify-center gap-3 px-5 py-4 sm:px-8 sm:py-6">
        <PromotionTypography textLayers={resolved.textLayers} theme={resolved} animateEnabled={animateEnabled} />
        <PromotionCtaBar
          buttons={resolved.ctaButtons}
          theme={resolved}
          placement={resolved.ctaPlacement}
          animateEnabled={animateEnabled}
          navigate={navigate}
          openTopUp={openTopUp}
        />
      </div>

      {topUpNode}
    </motion.section>
  );
}
