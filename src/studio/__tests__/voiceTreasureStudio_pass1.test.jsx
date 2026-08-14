/**
 * voiceTreasureStudio_pass1.test.jsx — Pass 1 surgical Author Studio tests.
 *
 * Pure schema + source-presence tests (the repo's existing convention). No
 * @testing-library/render — keeps the suite fast and consistent with the
 * rest of the VT test suite under craco test.
 */
import fs from "fs";
import path from "path";
import {
  defaultStudioConfig,
  validateStudioConfig,
  RESPONSE_LANGUAGES,
  FEEDBACK_LANGUAGES,
  INSTRUCTION_LANGUAGES,
  LANG_TEMPLATE_MAX_LEN,
  VT_SECTIONS,
  REWARD_UNAVAILABLE,
} from "../voiceTreasureSchema";

describe("Pass 1 — Bilingual schema", () => {
  test("defaultStudioConfig includes language block with safe defaults", () => {
    const cfg = defaultStudioConfig();
    expect(cfg.language).toBeTruthy();
    expect(cfg.language.response_language).toBe("english");
    expect(cfg.language.feedback_language).toBe("english");
    expect(cfg.language.mission_instruction_language).toBe("english");
    // Templates default to empty strings, never null/undefined.
    for (const k of [
      "mission_instruction_text_en", "mission_instruction_text_km",
      "recording_guidance_text_en", "recording_guidance_text_km",
      "evaluation_unavailable_text_en", "evaluation_unavailable_text_km",
      "retry_message_text_en", "retry_message_text_km",
    ]) {
      expect(typeof cfg.language[k]).toBe("string");
    }
  });

  test.each(RESPONSE_LANGUAGES)("response_language=%s validates", (rl) => {
    const cfg = defaultStudioConfig();
    cfg.language.response_language = rl;
    expect(validateStudioConfig(cfg)).toEqual([]);
  });

  test.each(FEEDBACK_LANGUAGES)("feedback_language=%s validates", (fl) => {
    const cfg = defaultStudioConfig();
    cfg.language.feedback_language = fl;
    expect(validateStudioConfig(cfg)).toEqual([]);
  });

  test.each(INSTRUCTION_LANGUAGES)("mission_instruction_language=%s validates", (il) => {
    const cfg = defaultStudioConfig();
    cfg.language.mission_instruction_language = il;
    expect(validateStudioConfig(cfg)).toEqual([]);
  });

  test("invalid language values are rejected", () => {
    const cfg = defaultStudioConfig();
    cfg.language.response_language = "spanish";
    expect(validateStudioConfig(cfg)).toEqual(
      expect.arrayContaining([expect.stringContaining("Invalid response language")])
    );
  });

  test("admin template text is length-bounded", () => {
    const cfg = defaultStudioConfig();
    cfg.language.mission_instruction_text_en = "x".repeat(LANG_TEMPLATE_MAX_LEN + 1);
    expect(validateStudioConfig(cfg)).toEqual(
      expect.arrayContaining([expect.stringContaining("must be ≤ 600")])
    );
  });
});

describe("Pass 1 — Reward integration status & sections", () => {
  test("VT_SECTIONS now lists bilingual and integration_status", () => {
    const keys = VT_SECTIONS.map((s) => s.key);
    expect(keys).toEqual(expect.arrayContaining([
      "rewards", "bilingual", "integration_status", "safety",
    ]));
  });

  test("REWARD_UNAVAILABLE is empty — voucher/edutalk paths are surfaced via runtime status", () => {
    expect(REWARD_UNAVAILABLE).toEqual([]);
  });

  test("VoiceTreasureStudio source wires bilingual + integration-status panels", () => {
    const src = fs.readFileSync(
      path.join(__dirname, "..", "VoiceTreasureStudio.jsx"),
      "utf8",
    );
    expect(src).toMatch(/data-testid="vt-section-bilingual"/);
    expect(src).toMatch(/data-testid="vt-section-integration-status"/);
    // Four-state integration status labels are present.
    expect(src).toContain("Available and active");
    expect(src).toContain("Available but disabled");
    expect(src).toContain("Unavailable integration");
    expect(src).toContain("Blocked by backend master switch");
    // Server-authoritative bilingual selectors present.
    expect(src).toMatch(/data-testid="vt-lang-response"/);
    expect(src).toMatch(/data-testid="vt-lang-feedback"/);
    expect(src).toMatch(/data-testid="vt-lang-instruction"/);
  });
});
