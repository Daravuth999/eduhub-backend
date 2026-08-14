/**
 * resolveExperienceConfig.js — the ONE resolution function every experience
 * type shares. Pure, synchronous, no I/O — callers (useExperienceConfig)
 * own fetching; this module only decides which already-fetched candidate
 * wins.
 *
 * Priority (fixed, do not reorder — this is the compatibility guarantee
 * for the whole migration):
 *   1. publishedConfig   — an active, published experience_configs doc
 *   2. legacyConfig      — output of a legacyAdapters[experienceType] fn,
 *                          if one exists and produced usable content
 *   3. hardcoded default — experienceDefaults[experienceType]
 */
import { legacyAdapters } from "./legacyWelcomeAdapter";
import { getExperienceDefault } from "./experienceDefaults";

/**
 * @param {string} experienceType
 * @param {object|null} publishedConfig  raw response from
 *   fetchActiveExperienceConfig(experienceType) — already in
 *   ExperienceConfig shape, or null.
 * @param {*} legacySource  whatever raw legacy data source this
 *   experienceType's adapter (if any) expects — e.g. useEduHubConfig()'s
 *   `config` for "welcome_dashboard". Ignored for types with no adapter.
 * @returns {{ config: object, source: "published"|"legacy"|"default" }}
 */
export function resolveExperienceConfig(experienceType, publishedConfig, legacySource) {
  if (publishedConfig && publishedConfig.content) {
    return { config: publishedConfig, source: "published" };
  }

  const adapter = legacyAdapters[experienceType];
  if (adapter) {
    const legacyConfig = adapter(legacySource);
    if (legacyConfig) {
      return { config: legacyConfig, source: "legacy" };
    }
  }

  return { config: getExperienceDefault(experienceType), source: "default" };
}

export default { resolveExperienceConfig };
