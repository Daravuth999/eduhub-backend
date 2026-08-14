/**
 * dashboardExperienceRegistry.js — the registry Dashboard Studio reads.
 *
 * This is the ONE file a future Dashboard experience type needs to touch
 * to appear inside Dashboard Studio. DashboardStudio.jsx itself is
 * generic over every entry here — it does not know what "Today's
 * Discovery" is, only that some experienceType has a label, an icon, a
 * default config shape, a form-fields component, and a preview component.
 *
 * Registering a new type does NOT touch:
 *   - the Experience Configuration Platform (CRUD/resolver/caching) —
 *     already generic over experienceType, per resolveExperienceConfig.js;
 *   - the backend — a brand-new experienceType with no entry in
 *     experienceDefaults.js already falls back to the generic empty
 *     default (see DiscoveryCard.jsx's header comment for the precedent);
 *   - Dashboard Studio's own shell (DashboardStudio.jsx) — it just reads
 *     one more entry from DASHBOARD_EXPERIENCE_TYPES below.
 *
 * Descriptor shape:
 *   id           string   — the experienceType key (matches what the
 *                            student-facing hook/resolver/renderer use)
 *   label        string   — shown in Dashboard Studio's type switcher
 *   Icon         component (lucide-react)
 *   description  string   — one line, shown under the type's header
 *   defaultConfig()       — returns a fresh {content, appearance, motion,
 *                            playback} object for "New config"
 *   FormFields   component({ config, onChange }) — edits `config` in
 *                place; onChange(nextConfig) replaces the whole object.
 *                Owns every field this type's content actually needs —
 *                Dashboard Studio's shell never inspects field shape.
 *   Preview      component({ config }) — renders the REAL student-facing
 *                component with `config` as a prop override, so what an
 *                admin sees here is provably what ships, never a mock.
 *   summarize?   (config) => string — one-line row summary in the config
 *                list; falls back to a generic "updated" line if omitted.
 */
import { Sparkles } from "lucide-react";
import DailyDiscoveryFields from "./DailyDiscoveryFields";
import DailyDiscoveryPreview from "./DailyDiscoveryPreview";

function defaultDailyDiscoveryConfig() {
  return {
    content: { title: "Today's Discovery", visible: true, items: [] },
    appearance: { paletteId: "morningEmerald" },
    motion: { presetId: "quickFade", lightingId: "none", particlesId: "none" },
    playback: {
      firstLaunchOfDay: true,
      firstLaunchPerSession: false,
      replayIntervalHours: 24,
      reducedMotionMode: "static",
      performanceMode: "auto",
    },
  };
}

function summarizeDailyDiscovery(config) {
  const items = config?.content?.items || [];
  if (!items.length) return "No items yet";
  const first = items[0]?.title || "(untitled item)";
  return items.length === 1 ? first : `${first} +${items.length - 1} more`;
}

export const DASHBOARD_EXPERIENCE_TYPES = [
  {
    id: "daily_discovery",
    label: "Today's Discovery",
    Icon: Sparkles,
    description:
      "The rotating \"Word of the Day\" style card on the Home Dashboard, " +
      "between Continue Learning and Community Pulse. No config published = section is hidden.",
    defaultConfig: defaultDailyDiscoveryConfig,
    FormFields: DailyDiscoveryFields,
    Preview: DailyDiscoveryPreview,
    summarize: summarizeDailyDiscovery,
  },
  // Future Dashboard experiences (Today's Journey, Promotional Banner,
  // Seasonal Artwork, Community Spotlight, Learning Challenge, Featured
  // Course, ...) register here the same way: one descriptor, reusing the
  // same CRUD/preview/asset-picker plumbing this file's header documents.
  // Today's Journey and Promotional Banner already have their OWN
  // dedicated Studio panels (WelcomeExperienceStudio, PromotionExperienceStudio)
  // predating this framework; migrating them here is a separate,
  // explicitly-scoped decision, not assumed by this registry's existence.
];

export function getDashboardExperienceType(id) {
  return DASHBOARD_EXPERIENCE_TYPES.find((t) => t.id === id) || null;
}

export default DASHBOARD_EXPERIENCE_TYPES;
