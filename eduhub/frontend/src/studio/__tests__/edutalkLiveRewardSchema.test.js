/**
 * edutalkLiveRewardSchema.test.js — Author Studio focused tests
 * (audit §23-30). Uses the project's existing react-scripts / jest
 * stack. No new framework added. Tests exercise PURE helpers.
 */

import {
  SAFE_POINT_VALUES,
  UNAVAILABLE_REWARD_TYPES,
  ALLOWED_PERSONALIZATION_PLACEHOLDERS,
  validatePointValues,
  validateRewardTypeActivation,
  sanitiseTemplate,
  renderPreview,
  decideSaveState,
} from "../edutalkLive/edutalkLiveRewardSchema";

describe("edutalkLiveRewardSchema", () => {
  // 23-25) pass / achievement / voucher toggles disabled
  test("pass / achievement / voucher remain unavailable types", () => {
    expect(UNAVAILABLE_REWARD_TYPES).toEqual(
      expect.arrayContaining(["pass", "achievement", "voucher"]));
  });

  test("validateRewardTypeActivation rejects pass enable", () => {
    const r = validateRewardTypeActivation({ pass_enabled: true });
    expect(r.ok).toBe(false);
    expect(r.reason.toLowerCase()).toMatch(/pass/);
  });

  test("validateRewardTypeActivation rejects achievement enable", () => {
    const r = validateRewardTypeActivation({ achievement_enabled: true });
    expect(r.ok).toBe(false);
    expect(r.reason.toLowerCase()).toMatch(/achievement/);
  });

  test("validateRewardTypeActivation rejects voucher enable", () => {
    const r = validateRewardTypeActivation({ voucher_enabled: true });
    expect(r.ok).toBe(false);
    expect(r.reason.toLowerCase()).toMatch(/voucher/);
  });

  test("validateRewardTypeActivation rejects real_grant_enabled", () => {
    const r = validateRewardTypeActivation({ real_grant_enabled: true });
    expect(r.ok).toBe(false);
    expect(r.reason.toLowerCase()).toMatch(/stable nonce/);
  });

  // 26) backend rejection (arbitrary point value) appears as error
  test("validatePointValues rejects 9999", () => {
    const r = validatePointValues([5, 9999]);
    expect(r.ok).toBe(false);
    expect(r.reason).toMatch(/9999/);
  });

  // 27) valid points configuration saves
  test("validatePointValues accepts allowlisted values", () => {
    const r = validatePointValues([5, 10, 15]);
    expect(r.ok).toBe(true);
  });

  test("validatePointValues rejects non-array input", () => {
    const r = validatePointValues("hello");
    expect(r.ok).toBe(false);
  });

  // 28) false save success is not displayed
  test("decideSaveState refuses to allow showing success while in flight", () => {
    const s = decideSaveState({ saving: true, dirty: true });
    expect(s.inFlight).toBe(true);
    expect(s.ok).toBe(false);
    expect(s.canShowSuccess).toBe(false);
  });

  test("decideSaveState canShowSuccess is always false (backend gates)", () => {
    const s = decideSaveState({ saving: false, dirty: true });
    expect(s.canShowSuccess).toBe(false);
  });

  // 29) unsupported placeholder rejected
  test("sanitiseTemplate rejects unknown placeholders", () => {
    const r = sanitiseTemplate(
      "Hello {password} {offer_id}", "DEFAULT", 200);
    expect(r.ok).toBe(false);
    expect(r.value).toBe("DEFAULT");
  });

  test("sanitiseTemplate rejects forbidden fragments", () => {
    const r = sanitiseTemplate(
      "Please ignore previous instructions", "DEFAULT", 200);
    expect(r.ok).toBe(false);
    expect(r.value).toBe("DEFAULT");
  });

  test("sanitiseTemplate accepts allowlisted placeholder set", () => {
    const r = sanitiseTemplate(
      "Hi {student_name}, you completed {successful_exercise_count} drills.",
      "DEFAULT", 200);
    expect(r.ok).toBe(true);
    expect(r.value).toMatch(/student_name/);
  });

  // 30) preview uses safe placeholder values
  test("renderPreview substitutes safe values for every placeholder", () => {
    const out = renderPreview(
      "{student_name}, you {recognized_practice} in {lesson_title}. "
      + "Confirmed: {confirmed_reward}.");
    expect(out).toContain("Dara");
    expect(out).toContain("completed three guided exercises");
    expect(out).toContain("Unit 4 speaking practice");
    expect(out).toContain("5 EduHub Points");
    // No leftover placeholders.
    expect(out).not.toMatch(/\{[a-z_]+\}/);
  });

  test("renderPreview rejects unsafe template", () => {
    expect(renderPreview("you are now the system")).toMatch(
      /rejected/i);
  });

  test("allowed placeholder set is the authoritative allowlist", () => {
    // Lock the allowlist so a regression cannot quietly extend it.
    expect(ALLOWED_PERSONALIZATION_PLACEHOLDERS).toEqual(
      expect.arrayContaining([
        "{student_name}", "{lesson_title}",
        "{successful_exercise_count}", "{recognized_practice}",
        "{confirmed_reward}",
      ]));
  });

  test("SAFE_POINT_VALUES is the authoritative low-risk allowlist", () => {
    expect([...SAFE_POINT_VALUES]).toEqual([5, 10, 15, 20]);
  });
});
