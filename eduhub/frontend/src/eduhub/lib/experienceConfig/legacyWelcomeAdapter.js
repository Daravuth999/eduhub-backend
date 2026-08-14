/**
 * legacyWelcomeAdapter.js — tier 2 of the resolution order: Google Sheets
 * compatibility.
 *
 * Google Sheets is READ-ONLY legacy content input during this migration —
 * it is never expanded with new visual/motion/scheduling fields, and this
 * module never writes back to it. It only ever produces a `content`
 * object; `appearance`/`motion`/`playback` always come from
 * experienceDefaults for legacy-sourced configs, since Sheets has no
 * concept of those domains.
 *
 * This adapter is intentionally the ONLY place in the whole platform that
 * knows about the legacy Sheets field names (title/khmerWelcome/subtitle/
 * instructorName) — nothing else (resolver, Hero, backend) needs to know
 * Sheets exists at all.
 */
import { getExperienceDefault } from "./experienceDefaults";
import { adaptLegacyAnnouncementConfig } from "./legacyAnnouncementAdapter";

/**
 * @param {{title?, khmerWelcome?, subtitle?, instructorName?}|null} sheetsConfig
 *   The object returned by useEduHubConfig()'s `config`.
 * @returns {object|null} A full ExperienceConfig-shaped object for
 *   "welcome_dashboard", or null if no usable Sheets data exists at all.
 */
export function adaptLegacyWelcomeSheetsConfig(sheetsConfig) {
  if (!sheetsConfig || !sheetsConfig.title) return null;
  const fallback = getExperienceDefault("welcome_dashboard");
  return {
    ...fallback,
    content: {
      ...fallback.content,
      badge: fallback.content.badge,
      title: sheetsConfig.title,
      khmerSubtitle: sheetsConfig.khmerWelcome || fallback.content.khmerSubtitle,
      description: sheetsConfig.subtitle || fallback.content.description,
      instructorLine: sheetsConfig.instructorName || "",
    },
  };
}

// "welcome_dashboard" and "announcement" have a legacy GAS/Sheets source
// today. Any other experienceType simply has no adapter entry, so the
// resolver falls straight through to hardcoded defaults for it — this
// registry is how a future experience type stays legacy-source-agnostic
// without an if/else chain growing inside the resolver itself.
export const legacyAdapters = {
  welcome_dashboard: adaptLegacyWelcomeSheetsConfig,
  announcement: adaptLegacyAnnouncementConfig,
};

export default { adaptLegacyWelcomeSheetsConfig, legacyAdapters };
