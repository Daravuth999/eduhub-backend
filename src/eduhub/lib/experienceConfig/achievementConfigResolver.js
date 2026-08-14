/**
 * achievementConfigResolver.js — turns a raw `achievement_top_earner`
 * ExperienceConfig (content/appearance/motion/playback, same generic
 * shape every experience type uses) into a fully-resolved presentation
 * object TopEarnerPanel can render directly, exactly the same
 * responsibility resolveExperienceConfig.js has for the Welcome Hero.
 *
 * appearance shape (stored in experience_configs, experienceType=
 * "achievement_top_earner"):
 *   syncMode      "followWelcome" | "independent"
 *   themeId       preset id from achievementThemes.js — only read when
 *                 syncMode === "independent"
 *   overrides     optional partial field overrides layered on top of the
 *                 resolved base preset (see OVERRIDABLE_FIELDS below) —
 *                 this IS how an admin builds a "custom theme": duplicate
 *                 a preset config (existing generic duplicate endpoint),
 *                 then tweak fields via overrides. No free-form CSS
 *                 injection, no second theme-authoring system.
 *   artwork       optional heroArtworkSchema-shaped background artwork
 *                 (reuses the SAME schema/layout math as the Welcome
 *                 Hero's artwork — see heroArtworkSchema.js).
 *
 * "Follow Welcome Theme": per the directive, Day Mode should harmonize
 * with the ACTIVE Welcome experience and Night Mode should switch to a
 * matching dark variant. The Welcome Hero's own palette is an admin's
 * fixed choice (morningEmerald/auroraNight), not itself day/night-
 * reactive — the actual day/night SIGNAL both surfaces already share is
 * the app's resolved theme (useTheme()). So "follow Welcome" resolves to
 * the achievement pair member matching the app's current theme, the same
 * signal Hero, the header, and every other themed surface already uses —
 * not a literal read of the Welcome config's paletteId (which has no
 * day/night duality to follow).
 */
import { getAchievementTheme, resolveFollowWelcomeTheme } from "../../styles/tokens/achievementThemes";

const OVERRIDABLE_TOP_LEVEL = [
  "primary", "secondary", "accent", "surface", "glassIntensity",
  "borderColor", "borderGlow", "shadow",
  "headerColor", "nameColor", "labelColor", "scoreColor",
  "accentBarGradient", "goldAccent", "emeraldAccent", "onSurface", "onSurfaceSoft",
];

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

/** Merges a partial `overrides` object onto a fully-resolved base preset.
 * Every sub-object (liveBadge/trophy/playerCard/decorations/rankTile) is
 * merged shallowly per-field rather than replaced wholesale, so an admin
 * overriding e.g. just trophy.color never accidentally resets
 * trophy.winnerAnimation back to a default. */
export function mergeAchievementOverrides(base, overrides) {
  if (!overrides) return base;
  return {
    ...base,
    ...pickDefined(overrides, OVERRIDABLE_TOP_LEVEL),
    liveBadge: { ...base.liveBadge, ...(overrides.liveBadge || {}) },
    trophy: { ...base.trophy, ...(overrides.trophy || {}) },
    playerCard: { ...base.playerCard, ...(overrides.playerCard || {}) },
    rankTile: overrides.rankTile
      ? { ...base.rankTile, ...overrides.rankTile }
      : base.rankTile,
    decorations: mergeDecorations(base.decorations, overrides.decorations),
  };
}

/**
 * resolveAchievementPresentation(config, {appTheme}) -> a fully-resolved
 * theme object (same shape as an achievementThemes.js entry) plus the
 * artwork/scheduling-adjacent fields TopEarnerPanel also needs.
 *
 * `config` may be null (no published config yet, or resolver still
 * loading) — in that case this ALWAYS falls back to Follow-Welcome
 * behavior with no artwork, matching Phase E's pre-Studio behavior
 * exactly (backward compatible, never a broken/blank panel).
 */
export function resolveAchievementPresentation(config, { appTheme } = {}) {
  const appearance = config?.appearance || {};
  const syncMode = appearance.syncMode === "independent" ? "independent" : "followWelcome";

  const base = syncMode === "independent"
    ? getAchievementTheme(appearance.themeId || "emeraldAchievement")
    : resolveFollowWelcomeTheme(appTheme);

  const resolved = mergeAchievementOverrides(base, appearance.overrides);

  return {
    ...resolved,
    syncMode,
    artwork: appearance.artwork || null,
    visible: config?.content?.visible !== false,
  };
}

export default { resolveAchievementPresentation, mergeAchievementOverrides };
