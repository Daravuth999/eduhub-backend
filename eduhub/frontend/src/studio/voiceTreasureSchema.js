/**
 * voiceTreasureSchema.js — shared, pure (no React) client-side schema for the
 * Voice Treasure Author Studio panel. Mirrors the backend contract in
 * voice_treasure_config_tools.py. Kept dependency-free so it is unit-testable
 * under the standard CRA/craco test harness (matching the repo's existing
 * pure-function test convention).
 *
 * The backend remains authoritative: it re-validates and clamps to master
 * switches on PUT. This client schema exists only for fast, friendly form
 * defaults + inline validation + honest save-result interpretation.
 */

/* The visible Author Studio sections the panel renders, in order. */
export const VT_SECTIONS = [
  { key: "access", label: "Access" },
  { key: "entry", label: "Entry Cost" },
  { key: "images", label: "Image Challenges" },
  { key: "speaking", label: "Speaking Rules" },
  { key: "rewards", label: "Rewards" },
  { key: "bilingual", label: "Bilingual" },
  { key: "integration_status", label: "Integration Status" },
  { key: "safety", label: "Safety" },
];

/* Reward types whose backend grant path availability must be checked at
 * runtime against the `effective` projection. Voucher + EduTalk Pass paths
 * are present in backend 228 (login_reward + mystery_box reuse) and are
 * surfaced by the integration-status panel — they are NOT statically
 * unavailable any more. The list is retained for back-compat consumers. */
export const REWARD_UNAVAILABLE = [];

/* Bilingual policy enums — mirror voice_treasure_config_tools server-side. */
export const RESPONSE_LANGUAGES = ["english", "khmer", "english_or_khmer", "mixed"];
export const FEEDBACK_LANGUAGES = ["english", "khmer", "match", "bilingual"];
export const INSTRUCTION_LANGUAGES = ["english", "khmer", "bilingual"];
export const LANG_TEMPLATE_MAX_LEN = 600;

export const TECH_FAIL_POLICIES = ["preserve_entry", "refund", "none"];
export const DIFFICULTY_MODES = ["beginner", "intermediate", "advanced", "adaptive"];
export const FEEDBACK_TONES = ["encouraging", "neutral", "strict"];
export const EVAL_CATEGORIES = [
  "relevance",
  "visual_grounding",
  "detail",
  "organization",
  "understandable_language",
];

/* Client-side default used only until the real config loads from the server. */
export function defaultStudioConfig() {
  return {
    access: {
      enabled: false,
      show_home_tile: false,
      eligible_student_ids: [],
      eligible_groups: [],
      open_to_all: false,
      suspended_student_ids: [],
      daily_play_limit: 1,
      free_first_play: false,
    },
    entry: {
      entry_cost_points: 10,
      minimum_balance_points: 0,
      reopen_paid_entry_without_recharge: true,
      technical_failure_policy: "preserve_entry",
    },
    images: {
      image_generation_enabled: false,
      image_model: "",
      allowed_themes: [],
      blocked_themes: [],
      difficulty_mode: "adaptive",
      personalization_enabled: true,
      fallback_mission_enabled: true,
    },
    speaking: {
      minimum_recording_seconds: 5,
      maximum_recording_seconds: 60,
      maximum_recording_retries: 2,
      audio_preview_enabled: true,
      evaluation_categories: [...EVAL_CATEGORIES],
      minimum_eligible_score: 60,
      feedback_tone: "encouraging",
    },
    rewards: {
      points_reward_enabled: false,
      base_points_reward: 5,
      maximum_points_reward: 50,
      minimum_eligible_score: 60,
      streak_reward_enabled: false,
      streak_bonus_points: 0,
      streak_bonus_max: 0,
      high_score_bonus_threshold: 90,
      high_score_bonus_points: 0,
      first_voice_card_enabled: true,
      voucher_reward_enabled: false,
      edutalk_pass_reward_enabled: false,
      daily_points_payout_cap: 100,
      weekly_points_payout_cap: 500,
      // Voucher (real backend fields validated by voice_treasure_config_tools)
      voucher_minimum_score: 70,
      voucher_source: "existing",          // "existing" | "auto"
      voucher_existing_code: "",
      voucher_discount_type: "percent",    // "percent" | "amount"
      voucher_discount_value: 0,
      voucher_title: "Voice Treasure Voucher",
      voucher_subtitle: "",
      voucher_daily_cap: 1,
      // EduTalk Pass (real backend fields)
      edutalk_pass_minimum_score: 70,
      edutalk_pass_feature: "edutalk_session", // "edutalk_session" | "edutalk_voice"
      edutalk_pass_quantity: 1,
      edutalk_pass_expires_in_days: 30,
      edutalk_pass_eligible_books: [],
      edutalk_pass_daily_cap: 1,
    },
    safety: {
      preserve_paid_entry_on_provider_failure: true,
      allow_evaluation_retry: true,
      manual_reconciliation_enabled: true,
    },
    language: {
      response_language: "english",
      feedback_language: "english",
      mission_instruction_language: "english",
      mission_instruction_text_en: "",
      mission_instruction_text_km: "",
      recording_guidance_text_en: "",
      recording_guidance_text_km: "",
      evaluation_unavailable_text_en: "",
      evaluation_unavailable_text_km: "",
      retry_message_text_en: "",
      retry_message_text_km: "",
    },
  };
}

const num = (v) => (typeof v === "number" ? v : parseInt(v, 10));

/**
 * Returns an array of human-readable validation errors (empty ⇒ valid).
 * Mirrors the backend's validate_config rules so the admin gets instant
 * feedback before the round-trip.
 */
export function validateStudioConfig(cfg) {
  const errors = [];
  if (!cfg) return ["config missing"];
  const { entry: e, speaking: sp, rewards: rw, access: a, images: im } = cfg;

  if (num(e.entry_cost_points) < 0) errors.push("Entry cost must be 0 or more.");
  if (num(e.minimum_balance_points) < 0) errors.push("Minimum balance must be 0 or more.");
  if (!TECH_FAIL_POLICIES.includes(e.technical_failure_policy))
    errors.push("Technical-failure policy is invalid.");

  if (num(a.daily_play_limit) < 0) errors.push("Daily play limit must be 0 or more.");

  const mn = num(sp.minimum_recording_seconds);
  const mx = num(sp.maximum_recording_seconds);
  if (mn < 1) errors.push("Minimum recording time must be at least 1 second.");
  if (mx <= mn) errors.push("Maximum recording time must be greater than the minimum.");
  if (mx > 600) errors.push("Maximum recording time must be 600 seconds or less.");
  if (num(sp.maximum_recording_retries) < 0) errors.push("Recording retries must be 0 or more.");
  const score = num(sp.minimum_eligible_score);
  if (score < 0 || score > 100) errors.push("Minimum eligible score must be between 0 and 100.");
  if (!FEEDBACK_TONES.includes(sp.feedback_tone)) errors.push("Feedback tone is invalid.");
  if (!Array.isArray(sp.evaluation_categories) || sp.evaluation_categories.length === 0)
    errors.push("At least one evaluation category is required.");
  else
    sp.evaluation_categories.forEach((c) => {
      if (!EVAL_CATEGORIES.includes(c)) errors.push(`Unknown evaluation category: ${c}`);
    });

  if (!DIFFICULTY_MODES.includes(im.difficulty_mode)) errors.push("Difficulty mode is invalid.");

  const baseR = num(rw.base_points_reward);
  const maxR = num(rw.maximum_points_reward);
  if (baseR < 0) errors.push("Base points reward must be 0 or more.");
  if (maxR < 0) errors.push("Maximum points reward must be 0 or more.");
  if (maxR < baseR) errors.push("Maximum points reward must be ≥ base points reward.");
  if (num(rw.daily_points_payout_cap) < 0) errors.push("Daily payout cap must be 0 or more.");
  if (num(rw.weekly_points_payout_cap) < 0) errors.push("Weekly payout cap must be 0 or more.");

  // Pass A — voucher / EduTalk Pass real validation (mirrors backend).
  const vScore = num(rw.voucher_minimum_score ?? 70);
  if (vScore < 0 || vScore > 100) errors.push("Voucher minimum score must be between 0 and 100.");
  if (rw.voucher_source && !["existing", "auto"].includes(rw.voucher_source))
    errors.push("Voucher source must be 'existing' or 'auto'.");
  if (rw.voucher_discount_type && !["percent", "amount"].includes(rw.voucher_discount_type))
    errors.push("Voucher discount type must be 'percent' or 'amount'.");
  if (Number(rw.voucher_discount_value ?? 0) < 0) errors.push("Voucher discount value must be 0 or more.");
  if (num(rw.voucher_daily_cap ?? 1) < 0) errors.push("Voucher daily cap must be 0 or more.");

  const pScore = num(rw.edutalk_pass_minimum_score ?? 70);
  if (pScore < 0 || pScore > 100) errors.push("EduTalk Pass minimum score must be between 0 and 100.");
  if (rw.edutalk_pass_feature && !["edutalk_session", "edutalk_voice"].includes(rw.edutalk_pass_feature))
    errors.push("EduTalk Pass feature must be 'edutalk_session' or 'edutalk_voice'.");
  if (num(rw.edutalk_pass_quantity ?? 1) < 1) errors.push("EduTalk Pass quantity must be 1 or more.");
  if (num(rw.edutalk_pass_expires_in_days ?? 30) < 1) errors.push("EduTalk Pass expiry must be 1 day or more.");
  if (num(rw.edutalk_pass_daily_cap ?? 1) < 0) errors.push("EduTalk Pass daily cap must be 0 or more.");

  // Bilingual policy validation (mirrors backend voice_treasure_config_tools).
  const lang = cfg.language || {};
  if (lang.response_language && !RESPONSE_LANGUAGES.includes(lang.response_language))
    errors.push(`Invalid response language: ${lang.response_language}`);
  if (lang.feedback_language && !FEEDBACK_LANGUAGES.includes(lang.feedback_language))
    errors.push(`Invalid feedback language: ${lang.feedback_language}`);
  if (lang.mission_instruction_language && !INSTRUCTION_LANGUAGES.includes(lang.mission_instruction_language))
    errors.push(`Invalid mission instruction language: ${lang.mission_instruction_language}`);
  for (const k of [
    "mission_instruction_text_en", "mission_instruction_text_km",
    "recording_guidance_text_en", "recording_guidance_text_km",
    "evaluation_unavailable_text_en", "evaluation_unavailable_text_km",
    "retry_message_text_en", "retry_message_text_km",
  ]) {
    const v = lang[k];
    if (v != null && typeof v !== "string") errors.push(`language.${k} must be a string`);
    if (typeof v === "string" && v.length > LANG_TEMPLATE_MAX_LEN)
      errors.push(`language.${k} must be ≤ ${LANG_TEMPLATE_MAX_LEN} characters`);
  }

  return errors;
}

/**
 * Honest interpretation of a save attempt. The component shows "Saved" ONLY
 * when this returns ok:true. A network/HTTP/validation error must NEVER be
 * reported as success.
 *   - resp: parsed JSON body on success (expects {saved:true,...})
 *   - err:  an Error thrown by request() on non-2xx (carries .status/.data)
 */
export function interpretSaveResult({ resp, err }) {
  if (err) {
    const status = err.status || 0;
    if (status === 422) {
      const detail = (err.data && err.data.detail) || err.message || "Validation failed";
      return { ok: false, kind: "validation", message: detail };
    }
    return { ok: false, kind: "error", message: err.message || `HTTP ${status}` };
  }
  if (resp && resp.saved === true) {
    return { ok: true, kind: "saved", config: resp.config, effective: resp.effective };
  }
  // Defensive: a 2xx without an explicit saved flag is NOT treated as success.
  return { ok: false, kind: "error", message: "Unexpected server response" };
}
