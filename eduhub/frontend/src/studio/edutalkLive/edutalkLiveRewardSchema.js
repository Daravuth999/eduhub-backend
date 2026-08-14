/**
 * edutalkLiveRewardSchema.js — Pure validation + preview helpers for the
 * Author Studio's "Live Coach Surprise Rewards" section. Mirrors the
 * backend allow-list and template safety rules so the Studio surfaces
 * the same constraints the backend enforces.
 */

export const SAFE_POINT_VALUES = Object.freeze([5, 10, 15, 20]);

export const UNAVAILABLE_REWARD_TYPES = Object.freeze([
  "pass",
  "achievement",
  "voucher",
]);

export const ALLOWED_PERSONALIZATION_PLACEHOLDERS = Object.freeze([
  "{student_name}",
  "{lesson_title}",
  "{successful_exercise_count}",
  "{recognized_practice}",
  "{confirmed_reward}",
  "{offer_id}",
  "{reward_summary}",
  "{amount}",
]);

const FORBIDDEN_TEMPLATE_FRAGMENTS = [
  "ignore previous",
  "ignore the above",
  "system:",
  "<|",
  "|>",
  "override",
  "jailbreak",
  "reveal your",
  "you are now",
];

/**
 * Reject an arbitrary point value (not in the safe allowlist). Mirrors
 * the backend ``_validate_config_update`` rejection used by the Studio
 * to keep an admin from saving 9999.
 */
export function validatePointValues(values) {
  if (!Array.isArray(values)) return { ok: false, reason: "must be an array" };
  for (const v of values) {
    const iv = Number(v);
    if (!Number.isInteger(iv)) {
      return { ok: false, reason: `non-integer ${v}` };
    }
    if (!SAFE_POINT_VALUES.includes(iv)) {
      return {
        ok: false,
        reason: `${iv} is not an approved safe point value`,
      };
    }
  }
  return { ok: true, reason: "" };
}

/**
 * Reject pass / achievement / voucher activation. Returns the reason
 * the backend would surface for the rejected payload.
 */
export function validateRewardTypeActivation(payload) {
  if (!payload || typeof payload !== "object") return { ok: true, reason: "" };
  if (payload.voucher_enabled === true) {
    return { ok: false, reason: "Voucher rewards are not available" };
  }
  if (payload.pass_enabled === true) {
    return {
      ok: false,
      reason: "EduTalk pass rewards are not available in this release",
    };
  }
  if (payload.achievement_enabled === true) {
    return {
      ok: false,
      reason: "Achievement rewards are not available in this release",
    };
  }
  if (payload.real_grant_enabled === true) {
    return {
      ok: false,
      reason:
        "Real point granting cannot be enabled — provider does not yet "
        + "accept a stable nonce.",
    };
  }
  return { ok: true, reason: "" };
}

/**
 * Sanitise a Studio-supplied template. Returns ``{ok, value}`` —
 * ``value`` is the trimmed text on success or the default on failure.
 * Mirrors the backend rules: ≤ max_len, no control chars, no forbidden
 * fragments, only allowlisted placeholders.
 */
export function sanitiseTemplate(input, defaultValue, maxLen = 320) {
  if (typeof input !== "string") return { ok: true, value: defaultValue };
  let s = input.trim();
  if (!s) return { ok: true, value: defaultValue };
  // Strip control chars (except newline).
  s = Array.from(s)
    .filter((ch) => ch === "\n" || ch.charCodeAt(0) >= 32)
    .join("");
  if (s.length > maxLen) s = s.slice(0, maxLen);
  const low = s.toLowerCase();
  for (const bad of FORBIDDEN_TEMPLATE_FRAGMENTS) {
    if (low.includes(bad)) return { ok: false, value: defaultValue };
  }
  const tokens = s.match(/\{[A-Za-z_]+\}/g) || [];
  for (const tk of tokens) {
    if (!ALLOWED_PERSONALIZATION_PLACEHOLDERS.includes(tk)) {
      return { ok: false, value: defaultValue };
    }
  }
  return { ok: true, value: s };
}

/**
 * Render a personalization preview using safe placeholder values. Used
 * by the Studio "preview" pane so an admin sees roughly what the
 * student / Gemini would receive. Never accepts unrestricted input.
 */
export function renderPreview(template) {
  const safe = sanitiseTemplate(template, "", 520);
  if (!safe.ok) return "(template rejected by backend)";
  return safe.value
    .replaceAll("{student_name}", "Dara")
    .replaceAll("{lesson_title}", "Unit 4 speaking practice")
    .replaceAll("{successful_exercise_count}", "3")
    .replaceAll("{recognized_practice}",
                "completed three guided exercises")
    .replaceAll("{confirmed_reward}", "5 EduHub Points")
    .replaceAll("{reward_summary}", "5 EduHub Points")
    .replaceAll("{amount}", "5")
    .replaceAll("{offer_id}", "rwd_••••••");
}

/**
 * Whether a Studio save attempt should be considered "in progress".
 * Returned object includes ``ok`` (whether to send), ``inFlight`` (UI
 * indicator), and a stable ``saveKey`` to suppress accidental
 * duplicate clicks.
 */
export function decideSaveState({ saving, dirty }) {
  return {
    ok: !saving && !!dirty,
    inFlight: !!saving,
    canShowSuccess: false, // success may only render AFTER backend persists
  };
}
