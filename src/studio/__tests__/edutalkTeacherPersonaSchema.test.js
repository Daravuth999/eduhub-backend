/**
 * edutalkTeacherPersonaSchema.test.js — Phase 1 frontend validation proof for
 * the Teacher Daravuth persona admin fields. Mirrors the backend
 * _teacher_name_ok / _validate_teacher_persona_fields rules and reason codes.
 *
 * Covers EMERGENT_PHASE0_1_REFINED_BUILD_PROMPT.md §D (Studio panel tests:
 * teacher persona default off; name validation supports Khmer; blocks
 * injection/control characters; booleans must be real booleans).
 */
import {
  validateTeacherDisplayName,
  validateTeacherPersonaConfig,
  teacherPersonaReasonMessage,
  TEACHER_PERSONA_REASONS,
} from "../edutalkLive/edutalkTeacherPersonaSchema";

describe("validateTeacherDisplayName", () => {
  test("accepts Khmer (letters + coeng combining marks)", () => {
    expect(validateTeacherDisplayName("គ្រូ ដារ៉ាវុធ").ok).toBe(true);
    expect(validateTeacherDisplayName("ដារ៉ាវុធ").ok).toBe(true);
  });

  test("accepts the allowed punctuation set", () => {
    for (const nm of [
      "Teacher Daravuth", "O'Brien", "Mary-Jane", "Dr. Sok",
      "Anne\u2019s", "Jean\u2011Luc",
    ]) {
      expect(validateTeacherDisplayName(nm).ok).toBe(true);
    }
  });

  test("rejects empty / whitespace-only", () => {
    expect(validateTeacherDisplayName("").reason)
      .toBe(TEACHER_PERSONA_REASONS.NAME_EMPTY);
    expect(validateTeacherDisplayName("   ").reason)
      .toBe(TEACHER_PERSONA_REASONS.NAME_EMPTY);
  });

  test("rejects > 80 characters", () => {
    expect(validateTeacherDisplayName("x".repeat(81)).reason)
      .toBe(TEACHER_PERSONA_REASONS.NAME_TOO_LONG);
  });

  test("rejects control characters, newlines, tabs", () => {
    for (const bad of ["Bad\nName", "Bad\tName", "Bad\u0000Name", "Bad\rName"]) {
      expect(validateTeacherDisplayName(bad).reason)
        .toBe(TEACHER_PERSONA_REASONS.NAME_INVALID_CHAR);
    }
  });

  test("rejects braces/brackets and prompt-delimiter injection", () => {
    for (const bad of ["{inject}", "[brackets]", "<<delim>>",
      "ignore; do x", "name|pipe", "a:b", "100pts", "$money"]) {
      expect(validateTeacherDisplayName(bad).reason)
        .toBe(TEACHER_PERSONA_REASONS.NAME_INVALID_CHAR);
    }
  });

  test("rejects non-string", () => {
    expect(validateTeacherDisplayName(42).reason)
      .toBe(TEACHER_PERSONA_REASONS.NAME_INVALID);
    expect(validateTeacherDisplayName(null).reason)
      .toBe(TEACHER_PERSONA_REASONS.NAME_INVALID);
  });
});

describe("validateTeacherPersonaConfig", () => {
  test("default (dark) config with default name is valid", () => {
    const r = validateTeacherPersonaConfig({
      teacher_persona_enabled: false,
      teacher_display_name: "Teacher Daravuth",
      mention_teacher_in_greeting: true,
    });
    expect(r.ok).toBe(true);
  });

  test("booleans must be real booleans", () => {
    expect(validateTeacherPersonaConfig({ teacher_persona_enabled: "true" }))
      .toMatchObject({ ok: false,
        reason: TEACHER_PERSONA_REASONS.PERSONA_ENABLED_INVALID });
    expect(validateTeacherPersonaConfig({ mention_teacher_in_greeting: 1 }))
      .toMatchObject({ ok: false,
        reason: TEACHER_PERSONA_REASONS.MENTION_INVALID });
  });

  test("invalid name surfaces the name reason + field", () => {
    const r = validateTeacherPersonaConfig({
      teacher_persona_enabled: true, teacher_display_name: "Bad{name}" });
    expect(r.ok).toBe(false);
    expect(r.reason).toBe(TEACHER_PERSONA_REASONS.NAME_INVALID_CHAR);
    expect(r.field).toBe("teacher_display_name");
  });

  test("only validates fields that are present", () => {
    expect(validateTeacherPersonaConfig({}).ok).toBe(true);
  });
});

describe("teacherPersonaReasonMessage", () => {
  test("returns a non-empty message for each non-ok reason", () => {
    for (const reason of [
      TEACHER_PERSONA_REASONS.NAME_EMPTY,
      TEACHER_PERSONA_REASONS.NAME_TOO_LONG,
      TEACHER_PERSONA_REASONS.NAME_INVALID_CHAR,
      TEACHER_PERSONA_REASONS.NAME_INVALID,
      TEACHER_PERSONA_REASONS.PERSONA_ENABLED_INVALID,
      TEACHER_PERSONA_REASONS.MENTION_INVALID,
    ]) {
      expect(teacherPersonaReasonMessage(reason).length).toBeGreaterThan(0);
    }
    expect(teacherPersonaReasonMessage("")).toBe("");
  });
});

describe("Studio panel wiring (static)", () => {
  const fs = require("fs");
  const path = require("path");
  const panel = fs.readFileSync(
    path.join(__dirname, "../edutalkLive/EduTalkLivePanel.jsx"), "utf8");

  test("panel imports + uses the teacher persona schema and controls", () => {
    expect(panel).toMatch(/edutalkTeacherPersonaSchema/);
    expect(panel).toMatch(/live-teacher-persona-enabled/);
    expect(panel).toMatch(/live-teacher-display-name/);
    expect(panel).toMatch(/live-teacher-mention/);
    // Name/mention controls are subordinated while the master gate is off.
    expect(panel).toMatch(/disabled=\{!config\.teacher_persona_enabled\}/);
    // The reward section import remains untouched.
    expect(panel).toMatch(/EduTalkLiveRewardSection/);
  });
});
