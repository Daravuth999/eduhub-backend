/**
 * experienceDefaults.js — hardcoded, per-experienceType fallback configs.
 *
 * Tier 3 of the resolution order (published config -> Sheets adapter ->
 * THIS). Only reached if both the backend and the legacy adapter have
 * nothing to offer — e.g. total backend outage on a brand new deployment.
 * Every experienceType gets its own entry; a type with no entry here
 * falls back to `genericDefault` rather than crashing a future consumer.
 */
const genericDefault = {
  experienceType: "unknown",
  content: { title: "", visible: true },
  appearance: { paletteId: "morningEmerald", radiusId: "lg" },
  motion: {
    presetId: "instant",
    lightingId: "none",
    particlesId: "none",
  },
  playback: {
    firstLaunchOfDay: true,
    firstLaunchPerSession: true,
    replayIntervalHours: 6,
    reducedMotionMode: "static",
    performanceMode: "auto",
  },
};

export const experienceDefaults = {
  welcome_dashboard: {
    ...genericDefault,
    experienceType: "welcome_dashboard",
    content: {
      badge: "Academic Learning Portal",
      title: "Welcome to Our Classroom",
      khmerSubtitle: "ស្វាគមន៍មកកាន់ថ្នាក់រៀន",
      description: "Interactive Learning Portal",
      instructorLine: "",
      cta: null,
      visible: true,
    },
    appearance: { paletteId: "morningEmerald", radiusId: "lg" },
    motion: {
      presetId: "cinematicRise",
      lightingId: "sunrise",
      particlesId: "sparseStars",
    },
    playback: {
      firstLaunchOfDay: true,
      firstLaunchPerSession: true,
      replayIntervalHours: 6,
      reducedMotionMode: "static",
      performanceMode: "auto",
    },
  },
  // Dashboard Showcases (architecture continuation) — the announcement
  // ticker's Author Studio-published/legacy-GAS/default resolution tier.
  // AnnouncementStrip.jsx reads content.announcementMessages directly, so
  // that's the only field this type's content needs.
  announcement: {
    ...genericDefault,
    experienceType: "announcement",
    content: { announcementMessages: [], visible: true },
  },
};

export function getExperienceDefault(experienceType) {
  return experienceDefaults[experienceType] || { ...genericDefault, experienceType };
}

export default { experienceDefaults, getExperienceDefault };
