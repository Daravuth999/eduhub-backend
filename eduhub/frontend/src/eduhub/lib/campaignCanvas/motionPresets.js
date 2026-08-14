/**
 * motionPresets.js — layered entrance motion for Campaign Design Studio 2.0.
 *
 * The directive's sequencing contract:
 *   Background -> Hero Artwork -> Decorations -> Typography -> Badges -> CTA
 *   -> Idle Motion
 * implemented as role-ordered stagger delays, elegant and never distracting.
 * Reduced-motion is handled by the caller (animateEnabled=false renders the
 * final frame with no animation — same convention as PromotionPanel).
 */

/** Sequencing rank per layer. Lower = earlier. */
export function getMotionRank(layer) {
  if (!layer) return 5;
  switch (layer.type) {
    case "background": return 0;
    case "image":
      return layer.role === "poster" ? 1 : layer.role === "decor" ? 2 : 1;
    case "effect": return 2;
    case "text": return 3;
    case "component":
      return layer.componentId === "ctaButton" ? 5 : 4;
    default: return 5;
  }
}

export const MOTION_PRESETS = {
  layeredElegant: {
    id: "layeredElegant",
    label: "Layered Elegant",
    baseDelay: 0.08,
    rankStagger: 0.14,
    withinRankStagger: 0.06,
    variant: (rank) => ({
      initial: rank === 0 ? { opacity: 0 } : { opacity: 0, y: 16, scale: 0.985 },
      animate: { opacity: 1, y: 0, scale: 1 },
      transition: { duration: 0.6, ease: [0.22, 1, 0.36, 1] },
    }),
  },
  softFade: {
    id: "softFade",
    label: "Soft Fade",
    baseDelay: 0.05,
    rankStagger: 0.09,
    withinRankStagger: 0.04,
    variant: () => ({
      initial: { opacity: 0 },
      animate: { opacity: 1 },
      transition: { duration: 0.7, ease: "easeOut" },
    }),
  },
  risingLuxury: {
    id: "risingLuxury",
    label: "Rising Luxury",
    baseDelay: 0.1,
    rankStagger: 0.18,
    withinRankStagger: 0.08,
    variant: (rank) => ({
      initial: rank === 0 ? { opacity: 0, scale: 1.02 } : { opacity: 0, y: 26 },
      animate: { opacity: 1, y: 0, scale: 1 },
      transition: { duration: 0.75, ease: [0.16, 1, 0.3, 1] },
    }),
  },
  cinematic: {
    id: "cinematic",
    label: "Cinematic",
    baseDelay: 0.12,
    rankStagger: 0.22,
    withinRankStagger: 0.1,
    variant: (rank) => ({
      initial: rank === 0
        ? { opacity: 0, scale: 1.04 }
        : rank <= 1 ? { opacity: 0, x: 30, scale: 0.98 } : { opacity: 0, y: 20 },
      animate: { opacity: 1, x: 0, y: 0, scale: 1 },
      transition: { duration: 0.85, ease: [0.22, 1, 0.36, 1] },
    }),
  },
  none: {
    id: "none",
    label: "No Motion",
    baseDelay: 0,
    rankStagger: 0,
    withinRankStagger: 0,
    variant: () => ({ initial: { opacity: 1 }, animate: { opacity: 1 }, transition: { duration: 0 } }),
  },
};

export const MOTION_PRESET_IDS = Object.keys(MOTION_PRESETS);

export function getMotionPreset(presetId) {
  return MOTION_PRESETS[presetId] || MOTION_PRESETS.layeredElegant;
}

/** Computes per-layer framer-motion props for the entrance sequence. */
export function getLayerEntrance(layer, indexWithinRank, preset) {
  const p = typeof preset === "string" ? getMotionPreset(preset) : preset || MOTION_PRESETS.layeredElegant;
  const rank = getMotionRank(layer);
  const v = p.variant(rank);
  return {
    initial: v.initial,
    animate: v.animate,
    transition: {
      ...v.transition,
      delay: p.baseDelay + rank * p.rankStagger + indexWithinRank * p.withinRankStagger,
    },
  };
}

/** Gentle idle motion for hero/decor artwork — subtle float, never
 * distracting. Only applied when canvas.motion.idle && animateEnabled. */
export function getIdleAnimation(layer, seedIndex = 0) {
  if (layer.type !== "image" || layer.role === "poster") return null;
  const dur = 5.5 + (seedIndex % 3) * 1.2;
  const dy = 4 + (seedIndex % 2) * 2;
  return {
    animate: { y: [0, -dy, 0] },
    transition: { duration: dur, repeat: Infinity, ease: "easeInOut", delay: 1.2 + seedIndex * 0.3 },
  };
}

const motionPresets = { MOTION_PRESETS, MOTION_PRESET_IDS, getMotionPreset, getMotionRank, getLayerEntrance, getIdleAnimation };
export default motionPresets;
