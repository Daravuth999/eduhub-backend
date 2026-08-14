/**
 * VT Pass A · Studio tests covering:
 *
 *   D. Truthful reward integration availability — the Studio reads
 *      `integration_status` from the admin config response (four orthogonal
 *      truths per reward type) and surfaces every required label.
 *   E. Complete reward configuration — the schema exposes every backend
 *      validated field for points / first voice card / voucher / edutalk
 *      pass; defaults validate; and saveable while master switch is OFF
 *      (the schema does not gate `voucher_reward_enabled` on the env).
 */
import fs from "fs";
import path from "path";

import {
  defaultStudioConfig,
  validateStudioConfig,
  interpretSaveResult,
} from "../voiceTreasureSchema";

const SRC = path.resolve(__dirname, "..");
const studioSrc = fs.readFileSync(path.join(SRC, "VoiceTreasureStudio.jsx"), "utf8");

describe("VT Pass A · D. Truthful reward integration availability", () => {
  test("Studio renders the four integration-state labels", () => {
    expect(studioSrc).toContain("Available and active");
    expect(studioSrc).toContain("Available but disabled");
    expect(studioSrc).toContain("Blocked by backend master switch");
    expect(studioSrc).toContain("Unavailable integration");
  });

  test("Studio reads the truthful integration_status payload, not effective.*_available", () => {
    expect(studioSrc).toMatch(/integration_status/);
    expect(studioSrc).not.toMatch(/voucher_integration_available/);
    expect(studioSrc).not.toMatch(/edutalk_integration_available/);
  });

  test("All four reward types render a status row", () => {
    // The Studio renders these via `data-testid={`vt-integration-${key}`}` in
    // a JSX template literal — the iteration enumerates all four keys, so
    // we pin the template form in source AND the iteration list.
    expect(studioSrc).toMatch(/data-testid=\{`vt-integration-\$\{key\}`\}/);
    expect(studioSrc).toMatch(/\["points",\s*"first_voice_card",\s*"voucher",\s*"edutalk_pass"\]/);
  });

  test("Studio exposes the four orthogonal truths as data-* attributes", () => {
    expect(studioSrc).toMatch(/data-configured=/);
    expect(studioSrc).toMatch(/data-integration-available=/);
    expect(studioSrc).toMatch(/data-master-switch-enabled=/);
    expect(studioSrc).toMatch(/data-effectively-active=/);
  });
});

describe("VT Pass A · E. Complete Author Studio reward configuration", () => {
  const cfg = defaultStudioConfig();

  test("All backend-validated reward fields are present in defaults", () => {
    const required = [
      "points_reward_enabled", "base_points_reward", "maximum_points_reward",
      "minimum_eligible_score",
      "streak_reward_enabled", "streak_bonus_points", "streak_bonus_max",
      "high_score_bonus_threshold", "high_score_bonus_points",
      "first_voice_card_enabled",
      "voucher_reward_enabled", "voucher_minimum_score", "voucher_source",
      "voucher_existing_code", "voucher_discount_type", "voucher_discount_value",
      "voucher_title", "voucher_subtitle", "voucher_daily_cap",
      "edutalk_pass_reward_enabled", "edutalk_pass_minimum_score",
      "edutalk_pass_feature", "edutalk_pass_quantity",
      "edutalk_pass_expires_in_days", "edutalk_pass_eligible_books",
      "edutalk_pass_daily_cap",
      "daily_points_payout_cap", "weekly_points_payout_cap",
    ];
    for (const k of required) {
      expect(cfg.rewards).toHaveProperty(k);
    }
  });

  test("Default config validates cleanly", () => {
    expect(validateStudioConfig(cfg)).toEqual([]);
  });

  test("Voucher / EduTalk Pass toggles remain saveable when master switch is OFF (schema does not gate on env)", () => {
    const next = {
      ...cfg,
      rewards: {
        ...cfg.rewards,
        voucher_reward_enabled: true,
        edutalk_pass_reward_enabled: true,
      },
    };
    // Pure client-side validation must NOT reject; the backend re-clamps.
    expect(validateStudioConfig(next)).toEqual([]);
  });

  test("Invalid voucher_source / discount_type / minimum_score are rejected", () => {
    const next1 = { ...cfg, rewards: { ...cfg.rewards, voucher_source: "weird" } };
    expect(validateStudioConfig(next1).join(" ")).toMatch(/Voucher source/i);

    const next2 = { ...cfg, rewards: { ...cfg.rewards, voucher_discount_type: "fish" } };
    expect(validateStudioConfig(next2).join(" ")).toMatch(/Voucher discount type/i);

    const next3 = { ...cfg, rewards: { ...cfg.rewards, voucher_minimum_score: 200 } };
    expect(validateStudioConfig(next3).join(" ")).toMatch(/Voucher minimum score/i);
  });

  test("Invalid edutalk_pass_feature / quantity / expiry are rejected", () => {
    const next1 = { ...cfg, rewards: { ...cfg.rewards, edutalk_pass_feature: "weird" } };
    expect(validateStudioConfig(next1).join(" ")).toMatch(/EduTalk Pass feature/i);

    const next2 = { ...cfg, rewards: { ...cfg.rewards, edutalk_pass_quantity: 0 } };
    expect(validateStudioConfig(next2).join(" ")).toMatch(/EduTalk Pass quantity/i);

    const next3 = { ...cfg, rewards: { ...cfg.rewards, edutalk_pass_expires_in_days: 0 } };
    expect(validateStudioConfig(next3).join(" ")).toMatch(/EduTalk Pass expiry/i);
  });

  test("Save result is honest (saved only when saved:true)", () => {
    expect(interpretSaveResult({ resp: { saved: true, config: cfg, effective: {} } }).ok).toBe(true);
    expect(interpretSaveResult({ resp: {} }).ok).toBe(false);
    expect(interpretSaveResult({ err: Object.assign(new Error("HTTP 422"), { status: 422 }) }).kind).toBe("validation");
  });

  test("Studio renders real controlled inputs for every key voucher/pass field", () => {
    for (const id of [
      "vt-voucher-source", "vt-voucher-title", "vt-voucher-daily-cap",
      "vt-pass-feature", "vt-pass-quantity", "vt-pass-expires", "vt-pass-daily-cap",
      "vt-reward-streak-points", "vt-reward-streak-max",
      "vt-reward-hs-threshold", "vt-reward-hs-points",
    ]) {
      expect(studioSrc).toContain(`data-testid="${id}"`);
    }
  });

  test("Voucher / Pass toggles have real onChange handlers (no no-ops)", () => {
    // Verify the toggle setGroup calls exist in the Studio source.
    expect(studioSrc).toMatch(/setGroup\("rewards",\s*"voucher_reward_enabled"/);
    expect(studioSrc).toMatch(/setGroup\("rewards",\s*"edutalk_pass_reward_enabled"/);
    // The Toggle component is wired by `testId="vt-reward-voucher"` /
    // `testId="vt-reward-pass"` (the local Toggle helper component which
    // forwards data-testid). Confirm those exist and that the onChange in
    // the toggle props is NOT a no-op stub.
    const voucherIdx = studioSrc.indexOf('testId="vt-reward-voucher"');
    expect(voucherIdx).toBeGreaterThan(-1);
    const voucherSlice = studioSrc.slice(voucherIdx, voucherIdx + 600);
    expect(voucherSlice).not.toMatch(/onChange=\{\s*\(\)\s*=>\s*\{\}\s*\}/);
    const passIdx = studioSrc.indexOf('testId="vt-reward-pass"');
    expect(passIdx).toBeGreaterThan(-1);
    const passSlice = studioSrc.slice(passIdx, passIdx + 600);
    expect(passSlice).not.toMatch(/onChange=\{\s*\(\)\s*=>\s*\{\}\s*\}/);
  });
});
