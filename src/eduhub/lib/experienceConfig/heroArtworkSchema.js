/**
 * heroArtworkSchema.js — the Hero Artwork sub-object shape (lives at
 * `config.appearance.heroArtwork`) plus the ONE layout function that turns
 * it into CSS. Hero.jsx (student-facing render) and WelcomeExperienceStudio's
 * live preview both render the ACTUAL Hero component, so this is the only
 * place placement/scale/padding math exists — no duplicate logic in the
 * Studio UI.
 *
 * heroArtwork shape:
 *   assetId       string|null   — hero_artwork_assets id (media library ref)
 *   url           string|null   — denormalized public URL (fast render, no
 *                                 second fetch to resolve assetId -> url)
 *   placement     one of ARTWORK_PLACEMENTS ids
 *   customX/customY  0-100 (%)  — only used when placement === "custom"
 *   scale         number, percent (100 = reference size)
 *   padding       { top, bottom, left, right } in px — keeps artwork off
 *                 the Hero's rounded corners, independent per edge
 *   layerOrder    one of ARTWORK_LAYER_ORDERS ids
 *   allowOverflow boolean — false clips artwork to the padded box
 *   version       number — bumped by the Studio whenever url/config
 *                 actually changes; consumed by the frontend artwork cache
 *                 to decide whether to re-fetch/re-cache (see
 *                 heroArtworkCache.js), never generated here
 *
 *   Promotion Experience Studio (Phase 1-5) additions — every field below
 *   is OPTIONAL and additive. Hero/Achievement configs that never set them
 *   are unaffected: getArtworkLayout() only appends filter/overlay styles
 *   when a field is actually present, so existing callers get byte-identical
 *   containerStyle/imgStyle output.
 *   opacity       0-100 (default 100) — image opacity
 *   brightness    0-200 (default 100 = neutral) — CSS filter brightness()
 *   contrast      0-200 (default 100 = neutral) — CSS filter contrast()
 *   blur          px, 0+ (default 0) — CSS filter blur()
 *   overlay       { enabled, color, opacity } — flat color wash above the
 *                 image (e.g. darken for text legibility)
 *   gradientOverlay { enabled, css } — a caller-supplied CSS gradient
 *                 string layered above the image (e.g.
 *                 "linear-gradient(180deg, transparent 0%, rgba(0,0,0,.6) 100%)")
 */

export const ARTWORK_PLACEMENTS = [
  { id: "left", label: "Left" },
  { id: "center", label: "Center" },
  { id: "right", label: "Right" },
  { id: "topLeft", label: "Top Left" },
  { id: "topRight", label: "Top Right" },
  { id: "bottomLeft", label: "Bottom Left" },
  { id: "bottomRight", label: "Bottom Right" },
  { id: "custom", label: "Custom" },
];

export const ARTWORK_LAYER_ORDERS = [
  { id: "behindParticles", label: "Behind particles" },
  { id: "aboveParticles", label: "Above particles" },
  { id: "behindText", label: "Behind text (default)" },
  { id: "aboveDecorative", label: "Above decorative elements" },
];

export const DEFAULT_PADDING = { top: 16, bottom: 16, left: 16, right: 16 };

const ALIGN = {
  left: { justifyContent: "flex-start", alignItems: "center", origin: "left center" },
  center: { justifyContent: "center", alignItems: "center", origin: "center center" },
  right: { justifyContent: "flex-end", alignItems: "center", origin: "right center" },
  topLeft: { justifyContent: "flex-start", alignItems: "flex-start", origin: "left top" },
  topRight: { justifyContent: "flex-end", alignItems: "flex-start", origin: "right top" },
  bottomLeft: { justifyContent: "flex-start", alignItems: "flex-end", origin: "left bottom" },
  bottomRight: { justifyContent: "flex-end", alignItems: "flex-end", origin: "right bottom" },
};

export function getDefaultHeroArtwork() {
  return {
    assetId: null,
    url: null,
    placement: "right",
    customX: 50,
    customY: 50,
    scale: 100,
    padding: { ...DEFAULT_PADDING },
    layerOrder: "behindText",
    allowOverflow: false,
    version: 0,
  };
}

// ── Promotion Experience Studio additions — additive filter/overlay layer.
// Deliberately NOT folded into baseImgStyle: only appends a `filter` /
// `opacity` entry when at least one effect field is actually set, so a
// heroArtwork object that never sets them (every Hero/Achievement config
// today) produces the exact same imgStyle as before this change.
function getArtworkFilterCss(a) {
  const parts = [];
  if (Number.isFinite(a.brightness) && a.brightness !== 100) parts.push(`brightness(${a.brightness}%)`);
  if (Number.isFinite(a.contrast) && a.contrast !== 100) parts.push(`contrast(${a.contrast}%)`);
  if (Number.isFinite(a.blur) && a.blur > 0) parts.push(`blur(${a.blur}px)`);
  return parts.length ? parts.join(" ") : null;
}

function applyArtworkEffects(a, imgStyle) {
  const filter = getArtworkFilterCss(a);
  const hasOpacity = Number.isFinite(a.opacity) && a.opacity !== 100;
  if (!filter && !hasOpacity) return imgStyle;
  return {
    ...imgStyle,
    ...(filter ? { filter } : null),
    ...(hasOpacity ? { opacity: Math.max(0, Math.min(100, a.opacity)) / 100 } : null),
  };
}

/**
 * Optional color-wash / gradient overlay rendered ABOVE the artwork image
 * (e.g. to keep text legible over a busy photo). Returns null when neither
 * `overlay` nor `gradientOverlay` is enabled, so callers that don't render
 * an overlay div today see no behavior change.
 */
export function getArtworkOverlayStyle(heroArtwork) {
  const a = heroArtwork || {};
  // gradientOverlay wins when both are enabled — it's the more expressive
  // of the two and an author enabling it clearly wants that exact CSS.
  const gradientCss = a.gradientOverlay?.enabled && a.gradientOverlay.css ? a.gradientOverlay.css : null;
  const flatColor = !gradientCss && a.overlay?.enabled && a.overlay.color ? a.overlay.color : null;
  if (!gradientCss && !flatColor) return null;

  const flatOpacity = Number.isFinite(a.overlay?.opacity) ? Math.max(0, Math.min(100, a.overlay.opacity)) / 100 : 0.4;
  return {
    position: "absolute",
    inset: 0,
    pointerEvents: "none",
    ...(gradientCss ? { background: gradientCss } : { background: flatColor, opacity: flatOpacity }),
  };
}

/**
 * Pure function: heroArtwork config -> { containerStyle, imgStyle }.
 * The container is a padded, flex-aligned inset box (this is what
 * "respect Hero safe margins" / "prevent clipping against rounded
 * corners" means structurally); the image is capped at a sane max
 * footprint (55%/75% of the padded box) so a single artwork asset can
 * never dominate the whole Hero regardless of its native resolution,
 * then `scale` adjusts from there, anchored at the placement's edge so
 * scaling grows/shrinks toward the anchor rather than the image's own
 * center (e.g. a right-anchored piece scaling up grows leftward, staying
 * pinned to the right edge).
 */
export function getArtworkLayout(heroArtwork) {
  const a = heroArtwork || {};
  const padding = { ...DEFAULT_PADDING, ...(a.padding || {}) };
  const scale = Number.isFinite(a.scale) ? a.scale : 100;
  const placement = a.placement || "right";
  const allowOverflow = Boolean(a.allowOverflow);

  const baseImgStyle = {
    maxWidth: "55%",
    maxHeight: "75%",
    width: "auto",
    height: "auto",
    objectFit: "contain",
  };

  if (placement === "custom") {
    const containerStyle = {
      position: "absolute",
      top: padding.top,
      right: padding.right,
      bottom: padding.bottom,
      left: padding.left,
      pointerEvents: "none",
      overflow: allowOverflow ? "visible" : "hidden",
    };
    const imgStyle = applyArtworkEffects(a, {
      ...baseImgStyle,
      position: "absolute",
      left: `${Number.isFinite(a.customX) ? a.customX : 50}%`,
      top: `${Number.isFinite(a.customY) ? a.customY : 50}%`,
      transform: `translate(-50%, -50%) scale(${scale / 100})`,
      transformOrigin: "center center",
    });
    return { containerStyle, imgStyle };
  }

  const align = ALIGN[placement] || ALIGN.right;
  const containerStyle = {
    position: "absolute",
    top: padding.top,
    right: padding.right,
    bottom: padding.bottom,
    left: padding.left,
    display: "flex",
    justifyContent: align.justifyContent,
    alignItems: align.alignItems,
    pointerEvents: "none",
    overflow: allowOverflow ? "visible" : "hidden",
  };
  const imgStyle = applyArtworkEffects(a, {
    ...baseImgStyle,
    transform: `scale(${scale / 100})`,
    transformOrigin: align.origin,
  });
  return { containerStyle, imgStyle };
}

export default {
  ARTWORK_PLACEMENTS, ARTWORK_LAYER_ORDERS, DEFAULT_PADDING,
  getDefaultHeroArtwork, getArtworkLayout, getArtworkOverlayStyle,
};
