/**
 * legacyAnnouncementAdapter.js — tier 2 of the resolution order for the
 * "announcement" experience type: Google Apps Script compatibility.
 *
 * Same discipline as legacyWelcomeAdapter.js: this is the ONLY place that
 * knows about the legacy `announcementMessages` field useEduHubConfig()
 * surfaces from GAS. It never writes back to that source, and it never
 * invents appearance/motion/playback — those always come from
 * experienceDefaults for legacy-sourced configs.
 */
import { getExperienceDefault } from "./experienceDefaults";

/**
 * @param {{announcementMessages?: string[]}|null} sheetsConfig
 *   The object returned by useEduHubConfig()'s `config`.
 * @returns {object|null} A full ExperienceConfig-shaped object for
 *   "announcement", or null if there are no usable messages at all.
 */
export function adaptLegacyAnnouncementConfig(sheetsConfig) {
  const messages = (sheetsConfig?.announcementMessages || []).filter(Boolean);
  if (!messages.length) return null;
  const fallback = getExperienceDefault("announcement");
  return {
    ...fallback,
    content: {
      ...fallback.content,
      announcementMessages: messages,
    },
  };
}

export default { adaptLegacyAnnouncementConfig };
