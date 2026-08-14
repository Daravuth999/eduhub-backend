/**
 * edutalkTeacherPersonaSchema.js — Phase 1 frontend validation for the Teacher
 * Daravuth persona admin fields. Mirrors the backend
 * `_validate_teacher_persona_fields` / `_teacher_name_ok` in
 * edutalk_live_tools.py EXACTLY (same rules, same stable reason codes) so the
 * Studio panel rejects bad input client-side with no silent clamping, and the
 * backend remains the final authority.
 *
 * Rules:
 *   - teacher_persona_enabled / mention_teacher_in_greeting must be real
 *     booleans;
 *   - teacher_display_name: 1–80 chars after trimming; Unicode letters +
 *     combining marks allowed (Khmer consonants/vowels/coeng pass); a small
 *     punctuation allowlist (space . ' ’ - and non-breaking hyphen) allowed;
 *     control characters, tabs, line breaks, braces/brackets, prompt
 *     delimiters, digits and other punctuation are rejected.
 */

export const TEACHER_PERSONA_REASONS = Object.freeze({
  OK: "",
  NAME_EMPTY: "teacher_name_empty",
  NAME_TOO_LONG: "teacher_name_too_long",
  NAME_INVALID_CHAR: "teacher_name_invalid_char",
  NAME_INVALID: "teacher_name_invalid",
  PERSONA_ENABLED_INVALID: "teacher_persona_enabled_invalid",
  MENTION_INVALID: "mention_teacher_invalid",
});

// Mirror of the backend _TEACHER_NAME_ALLOWED_PUNCT.
const ALLOWED_PUNCT = new Set([
  " ",        // space
  ".",        // period
  "'",        // straight apostrophe (U+0027)
  "\u2019",   // right single quotation mark
  "-",        // hyphen-minus (U+002D)
  "\u2011",   // non-breaking hyphen
]);

// Unicode letter OR combining mark (covers Khmer letters + coeng stacking).
const LETTER_OR_MARK = /[\p{L}\p{M}]/u;

/** Validate a teacher display name. Returns { ok, reason }. */
export function validateTeacherDisplayName(name) {
  if (typeof name !== "string") {
    return { ok: false, reason: TEACHER_PERSONA_REASONS.NAME_INVALID };
  }
  const trimmed = name.trim();
  if (trimmed.length < 1) {
    return { ok: false, reason: TEACHER_PERSONA_REASONS.NAME_EMPTY };
  }
  if (trimmed.length > 80) {
    return { ok: false, reason: TEACHER_PERSONA_REASONS.NAME_TOO_LONG };
  }
  for (const ch of trimmed) {            // spread = code-point aware
    if (ALLOWED_PUNCT.has(ch)) continue;
    if (LETTER_OR_MARK.test(ch)) continue;
    return { ok: false, reason: TEACHER_PERSONA_REASONS.NAME_INVALID_CHAR };
  }
  return { ok: true, reason: TEACHER_PERSONA_REASONS.OK };
}

/**
 * Validate the three teacher-persona fields from a config object. Only checks
 * fields that are present (matching the backend's key-presence behaviour).
 * Returns { ok, reason, field }.
 */
export function validateTeacherPersonaConfig(cfg) {
  const c = cfg || {};
  if ("teacher_persona_enabled" in c &&
      typeof c.teacher_persona_enabled !== "boolean") {
    return { ok: false, reason: TEACHER_PERSONA_REASONS.PERSONA_ENABLED_INVALID,
      field: "teacher_persona_enabled" };
  }
  if ("mention_teacher_in_greeting" in c &&
      typeof c.mention_teacher_in_greeting !== "boolean") {
    return { ok: false, reason: TEACHER_PERSONA_REASONS.MENTION_INVALID,
      field: "mention_teacher_in_greeting" };
  }
  if ("teacher_display_name" in c) {
    const r = validateTeacherDisplayName(c.teacher_display_name);
    if (!r.ok) return { ok: false, reason: r.reason, field: "teacher_display_name" };
  }
  return { ok: true, reason: TEACHER_PERSONA_REASONS.OK, field: null };
}

/** Human-readable message for a reason code (shown inline in the panel). */
export function teacherPersonaReasonMessage(reason) {
  switch (reason) {
    case TEACHER_PERSONA_REASONS.NAME_EMPTY:
      return "Teacher name is required (1–80 characters).";
    case TEACHER_PERSONA_REASONS.NAME_TOO_LONG:
      return "Teacher name must be 80 characters or fewer.";
    case TEACHER_PERSONA_REASONS.NAME_INVALID_CHAR:
      return "Teacher name can use letters (including Khmer), spaces, period, apostrophe and hyphen only.";
    case TEACHER_PERSONA_REASONS.NAME_INVALID:
      return "Teacher name is invalid.";
    case TEACHER_PERSONA_REASONS.PERSONA_ENABLED_INVALID:
      return "Teacher persona toggle must be on or off.";
    case TEACHER_PERSONA_REASONS.MENTION_INVALID:
      return "Mention-in-greeting toggle must be on or off.";
    default:
      return "";
  }
}
