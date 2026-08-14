/**
 * VoiceTreasureStudio.test.jsx — Phase 2 Author Studio tests.
 *
 * Follows the repo's existing pure-function test convention (the project
 * does not depend on @testing-library, so tests target the importable
 * schema/save logic the panel renders from, not the DOM). Runnable with the
 * standard CRA harness: `craco test`.
 *
 * Covers the Phase 2 frontend checklist:
 *   - loads configuration (default shape the panel falls back to)
 *   - displays all sections (section descriptor the panel maps over)
 *   - saves valid settings (validation passes)
 *   - displays validation errors
 *   - voucher + EduTalk Pass rewards default disabled
 *   - server error does NOT falsely show save success
 */
import {
  VT_SECTIONS,
  REWARD_UNAVAILABLE,
  defaultStudioConfig,
  validateStudioConfig,
  interpretSaveResult,
} from "../voiceTreasureSchema";

describe("Voice Treasure Studio — sections + config load", () => {
  test("all Author Studio sections are present and ordered (Pass 1 added bilingual + integration_status)", () => {
    expect(VT_SECTIONS.map((s) => s.key)).toEqual([
      "access", "entry", "images", "speaking", "rewards",
      "bilingual", "integration_status", "safety",
    ]);
  });

  test("default config (panel's load fallback) has every section group", () => {
    const cfg = defaultStudioConfig();
    ["access", "entry", "images", "speaking", "rewards", "safety"].forEach((g) => {
      expect(cfg[g]).toBeTruthy();
    });
  });
});

describe("Voice Treasure Studio — reward defaults", () => {
  test("voucher and EduTalk Pass rewards default disabled", () => {
    const cfg = defaultStudioConfig();
    expect(cfg.rewards.voucher_reward_enabled).toBe(false);
    expect(cfg.rewards.edutalk_pass_reward_enabled).toBe(false);
  });

  test("voucher and EduTalk Pass static-unavailable list is empty in v6+ (228 has grant paths; runtime status surfaces availability)", () => {
    // Pre-Pass-1: these were statically disabled. In backend 228 + Pass 1,
    // the grant adapters `_vt_grant_voucher` and `_vt_grant_edutalk_pass`
    // exist and are wired via the reward routes; Author Studio surfaces
    // availability through the runtime `effective` projection and the new
    // integration-status panel rather than this static list.
    expect(REWARD_UNAVAILABLE).toEqual([]);
  });

  test("First Voice Card (VT-owned collectible) is allowed by default", () => {
    expect(defaultStudioConfig().rewards.first_voice_card_enabled).toBe(true);
  });
});

describe("Voice Treasure Studio — validation (save valid / show errors)", () => {
  test("default config saves clean (no validation errors)", () => {
    expect(validateStudioConfig(defaultStudioConfig())).toEqual([]);
  });

  test("negative entry cost surfaces a validation error", () => {
    const cfg = defaultStudioConfig();
    cfg.entry.entry_cost_points = -5;
    const errs = validateStudioConfig(cfg);
    expect(errs.length).toBeGreaterThan(0);
    expect(errs.join(" ")).toMatch(/entry cost/i);
  });

  test("max recording <= min recording surfaces an error", () => {
    const cfg = defaultStudioConfig();
    cfg.speaking.minimum_recording_seconds = 30;
    cfg.speaking.maximum_recording_seconds = 20;
    expect(validateStudioConfig(cfg).join(" ")).toMatch(/maximum recording/i);
  });

  test("maximum points reward below base surfaces an error", () => {
    const cfg = defaultStudioConfig();
    cfg.rewards.base_points_reward = 80;
    cfg.rewards.maximum_points_reward = 50;
    expect(validateStudioConfig(cfg).join(" ")).toMatch(/maximum points reward/i);
  });

  test("out-of-range eligible score surfaces an error", () => {
    const cfg = defaultStudioConfig();
    cfg.speaking.minimum_eligible_score = 150;
    expect(validateStudioConfig(cfg).join(" ")).toMatch(/score/i);
  });
});

describe("Voice Treasure Studio — honest save-result interpretation", () => {
  test("a successful saved response reports ok", () => {
    const r = interpretSaveResult({ resp: { saved: true, config: {}, effective: {} } });
    expect(r.ok).toBe(true);
    expect(r.kind).toBe("saved");
  });

  test("a 422 validation error is NOT shown as success", () => {
    const err = Object.assign(new Error("entry_cost_points must be >= 0"), {
      status: 422, data: { detail: "entry_cost_points must be >= 0" },
    });
    const r = interpretSaveResult({ err });
    expect(r.ok).toBe(false);
    expect(r.kind).toBe("validation");
  });

  test("a 500 server error is NOT shown as success", () => {
    const err = Object.assign(new Error("HTTP 500"), { status: 500 });
    const r = interpretSaveResult({ err });
    expect(r.ok).toBe(false);
    expect(r.kind).toBe("error");
  });

  test("a 2xx body without saved:true is NOT treated as success", () => {
    const r = interpretSaveResult({ resp: { config: {} } });
    expect(r.ok).toBe(false);
  });
});
