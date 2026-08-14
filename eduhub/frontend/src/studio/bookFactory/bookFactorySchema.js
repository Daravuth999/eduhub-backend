/**
 * bookFactorySchema.js — Book Factory (Phase 1) config schema + constants.
 *
 * Pedagogy profile IDs here are IDENTICAL to the backend
 * (book_factory_jobs.KNOWN_PEDAGOGY_PROFILES / book_factory_gemini.PEDAGOGY_PROFILES).
 * Recipes are code-defined editable defaults (not Mongo-editable in Phase 1).
 *
 * Smart / Simple / Precise all resolve to ONE canonical config object; a pure
 * deterministic composer recommends values the author may edit before generation.
 */

// Verified Phase 1 intersection (Reader ∩ Editor palette). Mirrors backend
// book_factory_validator.ALLOWED_BLOCK_TYPES.
export const PHASE1_BLOCK_TYPES = Object.freeze([
  "heading", "paragraph", "quote", "markdown", "dialog", "mcq", "fillblank",
]);

export const SECTIONS = ["story", "conversation", "exercise"];
export const LEVELS = ["A1", "A2", "B1", "B2"];
export const MODES = ["smart", "simple", "precise"];
export const PRONUNCIATION_DEPTHS = ["none", "light", "standard", "deep"];
export const PARAGRAPH_GUIDANCE = ["short", "balanced", "detailed"];

export const TIERS = [
  { value: "free", label: "Free", priceHint: 0 },
  { value: "standard", label: "Standard", priceHint: 50 },
  { value: "premium", label: "Premium", priceHint: 250 },
  { value: "limited", label: "Limited", priceHint: 750 },
];

// §BLOCKER 1: pedagogy profiles — IDs MUST match the backend exactly.
export const PEDAGOGY_PROFILES = [
  {
    id: "general_english",
    label: "General English · communicative",
    description: "Balanced reading, everyday vocabulary, short dialogues and light speaking practice. No grammar lectures.",
  },
  {
    id: "daravuth_speaking_performance",
    label: "Daravuth · speaking & performance",
    description:
      "Pronunciation (with IPA for difficult words), word & sentence stress, linking and connected " +
      "speech, natural intonation, speaking confidence, storytelling & performance, and practical " +
      "workplace communication. No grammar lectures.",
  },
  {
    id: "pronunciation_focus",
    label: "Pronunciation focus",
    description: "Minimal pairs, word/sentence stress, IPA for difficult words, linking, intonation drills.",
  },
  {
    id: "workplace_communication",
    label: "Workplace communication",
    description: "Professional dialogues, meetings, email/phone register, polite requests, speaking confidence.",
  },
  {
    id: "storytelling_performance",
    label: "Storytelling & performance",
    description: "Narrative arcs, expressive read-aloud, intonation and pacing, confidence on stage.",
  },
  {
    id: "speaking_confidence",
    label: "Speaking confidence first",
    description: "High-frequency functional language, fluency over accuracy, low-anxiety speaking prompts.",
  },
];

export const PEDAGOGY_IDS = PEDAGOGY_PROFILES.map((p) => p.id);

// §HIGH 4: ONE canonical mirror of the backend hard safety bounds
// (book_factory_jobs: MAX_TOTAL_CHAPTERS / HARD_MAX_TOTAL_WORDS /
// HARD_MAX_TOTAL_EXERCISES + per-field integer bounds). The backend remains
// authoritative; this mirror only lets the UI keep composed values valid and
// block Generate before submission.
export const BACKEND_LIMITS = Object.freeze({
  maxTotalChapters: 20,
  readingMinutes: [1, 180],
  words: [50, 1000],
  maxTotalWords: 10000,       // chapterCount * maxWordsPerChapter must be <=
  maxTotalExercises: 300,     // totalChapters * (vocab+mcq+fillblank+speaking) <=
  perChapter: {
    dialogueTurnsPerChapter: [0, 20],
    vocabularyPerChapter: [0, 20],
    mcqPerChapter: [0, 10],
    fillblankPerChapter: [0, 10],
    speakingPerChapter: [0, 10],
  },
});

// Canonical config field set — every mode resolves to exactly these keys.
export function defaultConfig() {
  return {
    mode: "smart",
    recipeId: "",
    title: "",
    subtitle: "",
    author: "Classroom Library",
    topic: "",
    section: "story",
    level: "A2",
    tier: "free",
    price: 0,
    readingMinutes: 6,
    chapterCount: 5,
    includeReviewChapter: false,
    minWordsPerChapter: 120,
    maxWordsPerChapter: 320,
    paragraphGuidance: "balanced",
    dialogueTurnsPerChapter: 4,
    vocabularyPerChapter: 6,
    mcqPerChapter: 3,
    fillblankPerChapter: 2,
    speakingPerChapter: 1,
    pronunciationDepth: "standard",
    pedagogyProfile: "general_english",
    coverEmoji: "📖",
    coverGradient: "linear-gradient(155deg, #2a2140 0%, #4a3a6a 100%)",
    accent: "#D4A843",
  };
}

// Fields the author enters directly and that must survive a mode switch.
const AUTHOR_OWNED = ["title", "subtitle", "author", "topic", "section", "level",
                      "tier", "price", "readingMinutes", "pedagogyProfile",
                      "coverEmoji", "coverGradient", "accent"];

// §HIGH 11: Simple-mode presets fill the canonical (preset-derived) fields.
export const SIMPLE_PRESETS = {
  short: {
    label: "Short", chapterCount: 3, includeReviewChapter: false,
    minWordsPerChapter: 90, maxWordsPerChapter: 180, paragraphGuidance: "short",
    dialogueTurnsPerChapter: 3, vocabularyPerChapter: 4, mcqPerChapter: 2,
    fillblankPerChapter: 1, speakingPerChapter: 1, pronunciationDepth: "light",
  },
  balanced: {
    label: "Balanced", chapterCount: 5, includeReviewChapter: true,
    minWordsPerChapter: 120, maxWordsPerChapter: 320, paragraphGuidance: "balanced",
    dialogueTurnsPerChapter: 4, vocabularyPerChapter: 6, mcqPerChapter: 3,
    fillblankPerChapter: 2, speakingPerChapter: 1, pronunciationDepth: "standard",
  },
  deep: {
    label: "Deep", chapterCount: 8, includeReviewChapter: true,
    minWordsPerChapter: 180, maxWordsPerChapter: 420, paragraphGuidance: "detailed",
    dialogueTurnsPerChapter: 6, vocabularyPerChapter: 8, mcqPerChapter: 4,
    fillblankPerChapter: 3, speakingPerChapter: 2, pronunciationDepth: "deep",
  },
};

// §HIGH 12: code-defined editable-default recipes. They populate the canonical
// config and never touch wallet / ownership / purchase / rewards / publish.
export const RECIPES = [
  { id: "a1_short_story", label: "A1 · Short Story", patch: { section: "story", level: "A1", ...SIMPLE_PRESETS.short, pedagogyProfile: "general_english" } },
  { id: "a2_story_speaking", label: "A2 · Story + Speaking", patch: { section: "story", level: "A2", ...SIMPLE_PRESETS.balanced, speakingPerChapter: 2, pedagogyProfile: "speaking_confidence" } },
  { id: "b1_professional_convo", label: "B1 · Professional Conversation", patch: { section: "conversation", level: "B1", ...SIMPLE_PRESETS.balanced, dialogueTurnsPerChapter: 8, pedagogyProfile: "workplace_communication" } },
  { id: "standard_story_book", label: "Standard Story Book", patch: { section: "story", level: "A2", tier: "standard", ...SIMPLE_PRESETS.balanced, pedagogyProfile: "general_english" } },
  { id: "premium_full_practice", label: "Premium Full-Practice Book", patch: { section: "story", level: "B1", tier: "premium", ...SIMPLE_PRESETS.deep, pedagogyProfile: "daravuth_speaking_performance" } },
  { id: "limited_edition_narrative", label: "Limited Edition Narrative", patch: { section: "story", level: "B2", tier: "limited", ...SIMPLE_PRESETS.deep, pedagogyProfile: "storytelling_performance" } },
  { id: "exercise_review_book", label: "Exercise & Review Book", patch: { section: "exercise", level: "A2", includeReviewChapter: true, chapterCount: 6, mcqPerChapter: 5, fillblankPerChapter: 5, vocabularyPerChapter: 6, speakingPerChapter: 0, pedagogyProfile: "general_english" } },
];

const clampInt = (v, lo, hi, dflt) => {
  const n = Math.round(Number(v));
  if (!Number.isFinite(n)) return dflt;
  return Math.max(lo, Math.min(hi, n));
};

// §HIGH 5 SMART: pure deterministic recommendation from a few high-level inputs.
export function smartCompose(cfg) {
  const minutes = clampInt(cfg.readingMinutes, 1, 180, 6);
  const level = cfg.level || "A2";
  const density = { A1: 0.8, A2: 1, B1: 1.2, B2: 1.4 }[level] || 1;

  const chapterCount = clampInt(Math.max(3, Math.round(minutes / 2)), 1, 12, 5);
  const includeReviewChapter = chapterCount >= 4;
  // §PHASE D1: divide by totalChapterCount (including review) so the
  // word ceiling is never violated when a review chapter is included.
  const totalChapterCount = chapterCount + (includeReviewChapter ? 1 : 0);
  const minWordsPerChapter = clampInt(80 * density, 50, 1000, 120);
  // §HIGH 4: keep totalChapterCount * maxWordsPerChapter within the backend
  // word ceiling so a long reading duration can never produce a rejected config.
  const wordCeil = Math.max(
    minWordsPerChapter,
    Math.floor(BACKEND_LIMITS.maxTotalWords / Math.max(1, totalChapterCount)),
  );
  const maxWordsPerChapter = clampInt(
    200 * density + minutes * 6, minWordsPerChapter, Math.min(1000, wordCeil), 320,
  );
  const tierBoost = cfg.tier === "premium" || cfg.tier === "limited" ? 1 : 0;

  return {
    chapterCount,
    includeReviewChapter,
    minWordsPerChapter,
    maxWordsPerChapter,
    paragraphGuidance: level === "A1" ? "short" : level === "B2" ? "detailed" : "balanced",
    dialogueTurnsPerChapter: clampInt(3 + tierBoost * 2, 0, 20, 4),
    vocabularyPerChapter: clampInt(4 + Math.round(density * 2), 0, 20, 6),
    mcqPerChapter: clampInt(2 + tierBoost, 0, 10, 3),
    fillblankPerChapter: clampInt(1 + tierBoost, 0, 10, 2),
    speakingPerChapter: clampInt(1 + tierBoost, 0, 10, 1),
    pronunciationDepth: tierBoost ? "deep" : "standard",
  };
}

// §HIGH 5: Smart mode is REACTIVE and deterministic. Whenever any Smart INPUT
// (topic, section, level, tier, price, readingMinutes, pedagogyProfile) changes
// the derived resolved configuration is recomputed. Directly editing a derived
// field is treated as an explicit author override (no recompute).
export const SMART_INPUT_KEYS = [
  "topic", "section", "level", "tier", "price", "readingMinutes", "pedagogyProfile",
];

export function updateSmartInput(cfg, patch) {
  const next = { ...cfg, ...patch };
  if ((next.mode || "smart") !== "smart") return next;
  return { ...next, ...smartCompose(next) };
}

// Mode switch: preserve author-owned fields; replace preset/smart-derived fields.
export function applyMode(cfg, mode) {
  const base = { ...cfg, mode };
  if (mode === "smart") return { ...base, ...smartCompose(base) };
  if (mode === "simple") return { ...base, ...SIMPLE_PRESETS.balanced, _simplePreset: "balanced" };
  return base; // precise: expose current values, edit nothing automatically
}

export function applySimplePreset(cfg, presetKey) {
  const preset = SIMPLE_PRESETS[presetKey];
  if (!preset) return cfg;
  const { label, ...fields } = preset;
  return { ...cfg, ...fields, mode: "simple", _simplePreset: presetKey };
}

export function applyRecipe(cfg, recipeId) {
  const recipe = RECIPES.find((r) => r.id === recipeId);
  if (!recipe) return { ...cfg, recipeId: "" };
  // Recipe patches preset/derived fields; author-owned fields (title/topic) stay.
  const preserved = {};
  AUTHOR_OWNED.forEach((k) => { if (cfg[k] !== undefined && cfg[k] !== "" && k !== "section" && k !== "level" && k !== "tier") preserved[k] = cfg[k]; });
  return { ...cfg, ...recipe.patch, ...preserved, recipeId };
}

// §HIGH 13 STUDENT VALUE (advisory) — Low / Moderate / High / Rich.
export function studentValue(cfg) {
  const chapters = (Number(cfg.chapterCount) || 0) + (cfg.includeReviewChapter ? 1 : 0);
  const words = (Number(cfg.maxWordsPerChapter) || 0) * chapters;
  const practice = ((Number(cfg.mcqPerChapter) || 0) + (Number(cfg.fillblankPerChapter) || 0)) * chapters;
  const speaking = (Number(cfg.speakingPerChapter) || 0) * chapters;
  const pronBonus = { none: 0, light: 1, standard: 2, deep: 3 }[cfg.pronunciationDepth] || 0;
  const review = cfg.includeReviewChapter ? 2 : 0;

  const score = chapters + words / 400 + practice / 2 + speaking + pronBonus + review;
  const level = score >= 28 ? "Rich" : score >= 18 ? "High" : score >= 9 ? "Moderate" : "Low";
  return { level, score: Math.round(score) };
}

// §HIGH 13 PRODUCTION COST (advisory) — the ACTUAL Phase 1 normal pipeline:
// 1 blueprint call + N chapter calls. No MCQ-repair calls exist in Phase 1.
export function productionCost(cfg) {
  const chapters = (Number(cfg.chapterCount) || 0) + (cfg.includeReviewChapter ? 1 : 0);
  return {
    normalCalls: chapters + 1, // blueprint + chapters
    chapters,
    // Exceptional, bounded invalid-JSON retries are NOT included in the normal
    // estimate (shown separately as an exceptional worst case).
    exceptionalMaxCalls: (chapters + 1) * 2,
  };
}

export function validateConfig(cfg) {
  const errors = {};
  if (!cfg.title || !cfg.title.trim()) errors.title = "Title is required.";
  if (!cfg.topic || !cfg.topic.trim()) errors.topic = "Topic/theme is required.";
  const n = Number(cfg.chapterCount);
  const maxCh = BACKEND_LIMITS.maxTotalChapters;
  if (!Number.isInteger(n) || n < 1 || n > maxCh) errors.chapterCount = `1–${maxCh} chapters.`;
  const review = cfg.includeReviewChapter ? 1 : 0;
  const total = (Number.isInteger(n) ? n : 0) + review;
  if (Number.isInteger(n) && total > maxCh) errors.chapterCount = `chapters + review must be ≤ ${maxCh}.`;
  if (Number(cfg.price) < 0 || !Number.isFinite(Number(cfg.price))) errors.price = "Price must be a finite value ≥ 0.";
  const mn = Number(cfg.minWordsPerChapter), mx = Number(cfg.maxWordsPerChapter);
  if (Number.isFinite(mn) && Number.isFinite(mx) && mx < mn) errors.maxWordsPerChapter = "Max words must be ≥ min words.";
  // §HIGH 4: local mirror of the backend aggregate ceilings (backend remains
  // authoritative; this only prevents submitting a config the backend rejects).
  if (Number.isInteger(n) && Number.isFinite(mx) && n * mx > BACKEND_LIMITS.maxTotalWords) {
    errors.maxWordsPerChapter = `chapters × max words must be ≤ ${BACKEND_LIMITS.maxTotalWords}.`;
  }
  const perEx = (Number(cfg.vocabularyPerChapter) || 0) + (Number(cfg.mcqPerChapter) || 0)
    + (Number(cfg.fillblankPerChapter) || 0) + (Number(cfg.speakingPerChapter) || 0);
  if (total && perEx && total * perEx > BACKEND_LIMITS.maxTotalExercises) {
    errors.exercises = `total chapters × exercises per chapter must be ≤ ${BACKEND_LIMITS.maxTotalExercises}.`;
  }
  return errors;
}
