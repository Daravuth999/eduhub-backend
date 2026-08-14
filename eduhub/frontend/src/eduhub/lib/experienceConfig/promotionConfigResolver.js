/**
 * promotionConfigResolver.js — turns a raw `promotional_banner`
 * ExperienceConfig (content/appearance/motion/playback, same generic shape
 * every experience type uses) into a fully-resolved presentation object
 * PromotionPanel can render directly. Mirrors
 * achievementConfigResolver.js's responsibility and merge discipline
 * exactly (approved Promotion Experience Studio directive, Phase 1-5).
 *
 * appearance shape (stored in experience_configs, experienceType=
 * "promotional_banner"):
 *   syncMode      "followTheme" | "independent" — named differently from
 *                 achievement's "followWelcome" because this surface has no
 *                 conceptual link to the Welcome Hero; it follows the SAME
 *                 day/night signal (useTheme()) achievement's "followWelcome"
 *                 already resolves to, just under an accurate name.
 *   themeId       preset id from promotionThemes.js — only read when
 *                 syncMode === "independent"
 *   overrides     partial field overrides layered on the resolved base
 *                 preset (top-level fields + overlay/cta/decorations merged
 *                 per sub-object, never wholesale-replaced)
 *   artwork       heroArtworkSchema-shaped object — SAME schema/layout math
 *                 (now extended with overlay/gradient/blur/brightness/
 *                 contrast) as Welcome Hero and Achievement's background
 *                 artwork. No duplicate artwork engine.
 *   motion        { entrance: "fade"|"slide"|"float"|"zoom"|"parallax",
 *                   stagger: boolean }
 *
 * content shape:
 *   visible       boolean, default true
 *   textLayers    [{ id, role, content, lang, align, color, gradient,
 *                    shadow, glass, stroke, maxLines }] — content AND
 *                 per-layer style live together deliberately (splitting
 *                 into parallel content/appearance arrays keyed by index
 *                 would risk index-drift between the two; every other
 *                 experience type's `content` only ever holds a handful of
 *                 flat fields, never an array, so there's no existing
 *                 convention this breaks).
 *   ctaButtons    [{ id, label, style, action: { type, value } }] — action
 *                 vocabulary is IDENTICAL to artworkClickAction.js's
 *                 existing 8 types, unchanged.
 *   ctaPlacement  "stack" | "center" | "relative" | "free"
 *
 * `config` may be null (no published config yet) — every resolved field
 * still has a safe default, but PromotionPanel treats a null `config`
 * itself (not any resolved field) as the signal to fall back to the
 * existing Artwork Campaign System v1.0 carousel — see PromotionPanel.jsx.
 */
import { getPromotionTheme, resolveFollowAppTheme } from "../../styles/tokens/promotionThemes";

const OVERRIDABLE_TOP_LEVEL = ["onSurface", "onSurfaceSoft", "accent", "borderColor", "shadow", "surface"];

function pickDefined(source, keys) {
  const out = {};
  keys.forEach((k) => {
    if (source && source[k] !== undefined) out[k] = source[k];
  });
  return out;
}

function mergeDecorations(baseDecorations, overrideDecorations) {
  if (!overrideDecorations) return baseDecorations;
  const merged = { ...baseDecorations };
  Object.entries(overrideDecorations).forEach(([type, patch]) => {
    if (merged[type]) merged[type] = { ...merged[type], ...patch };
  });
  return merged;
}

/** Merges a partial `overrides` object onto a fully-resolved base preset,
 * same per-sub-object discipline as mergeAchievementOverrides: overlay/cta/
 * decorations are merged shallowly per-field, never replaced wholesale. */
export function mergePromotionOverrides(base, overrides) {
  if (!overrides) return base;
  return {
    ...base,
    ...pickDefined(overrides, OVERRIDABLE_TOP_LEVEL),
    overlay: { ...base.overlay, ...(overrides.overlay || {}) },
    cta: { ...base.cta, ...(overrides.cta || {}) },
    decorations: mergeDecorations(base.decorations, overrides.decorations),
  };
}

/**
 * resolvePromotionPresentation(config, {appTheme}) -> a fully-resolved
 * theme object (same shape as a promotionThemes.js entry) plus the
 * artwork/text/CTA/motion fields PromotionPanel also needs.
 */
export function resolvePromotionPresentation(config, { appTheme } = {}) {
  const appearance = config?.appearance || {};
  const content = config?.content || {};
  const syncMode = appearance.syncMode === "independent" ? "independent" : "followTheme";

  const base = syncMode === "independent"
    ? getPromotionTheme(appearance.themeId || "emeraldDay")
    : resolveFollowAppTheme(appTheme);

  const resolved = mergePromotionOverrides(base, appearance.overrides);

  // Campaign Design Studio 2.0 — canvas documents (schemaVersion >= 2) take
  // the canvas rendering path in PromotionPanel. Additive: legacy configs
  // (no content.canvas) resolve byte-identically to before.
  const canvasDoc = content.canvas;
  const isCanvas = Number.isFinite(canvasDoc?.schemaVersion) && canvasDoc.schemaVersion >= 2;

  return {
    ...resolved,
    syncMode,
    canvas: isCanvas ? canvasDoc : null,
    artwork: appearance.artwork || null,
    motion: appearance.motion || { entrance: "fade", stagger: true },
    visible: content.visible !== false,
    textLayers: Array.isArray(content.textLayers) ? content.textLayers : [],
    ctaButtons: Array.isArray(content.ctaButtons) ? content.ctaButtons : [],
    ctaPlacement: content.ctaPlacement || resolved.cta?.placement || "stack",
  };
}

export default { resolvePromotionPresentation, mergePromotionOverrides };
