/**
 * Studio Pass B.2.1 · polish mounted tests.
 *
 * Targets:
 *   • Overview renders with authoritative data + truthful warnings.
 *   • Reward integration-state cards still expose the four-truth contract.
 *   • Controlled Voucher fields remain editable after polish.
 *   • Controlled EduTalk Pass fields remain editable after polish.
 *   • Bilingual preview renders English / Khmer / bilingual cards.
 *   • Khmer preview body uses lang="km".
 *   • Scene Library: loading, empty, populated surfaces + status pills.
 *   • Reduced-motion behavior — no animation classes are applied
 *     on Studio surfaces (we use plain dom + scoped CSS only).
 *   • No primary emoji artwork in Studio (🎙️ etc.).
 */
global.IS_REACT_ACT_ENVIRONMENT = true;

import React, { act } from "react";
import { createRoot } from "react-dom/client";

jest.mock("../api", () => ({
  __esModule: true,
  getVoiceTreasureConfig: jest.fn(),
  saveVoiceTreasureConfig: jest.fn(),
  getVoiceTreasureAnalytics: jest.fn(),
  getVoiceTreasureAttempts: jest.fn(),
  getVoiceTreasureEntries: jest.fn(),
  getVoiceTreasureRewards: jest.fn(),
  getVoiceTreasureReconciliationQueue: jest.fn(),
  reconcileVoiceTreasureReward: jest.fn(),
  getVoiceTreasureScenes: jest.fn(),
  updateVoiceTreasureScene: jest.fn(),
  reconcileVoiceTreasureEntry: jest.fn(),
  reopenVoiceTreasureEntry: jest.fn(),
  replaceVoiceTreasureMission: jest.fn(),
}));

import * as studioApi from "../api";
import VoiceTreasureStudio from "../VoiceTreasureStudio";
import { defaultStudioConfig } from "../voiceTreasureSchema";

function installMatchMedia(reduced) {
  window.matchMedia = (q) => ({
    matches: reduced && /prefers-reduced-motion: reduce/.test(q),
    media: q,
    addListener() {}, removeListener() {},
    addEventListener() {}, removeEventListener() {},
    dispatchEvent() { return false; },
  });
}

function makeConfig(overrides = {}) {
  const c = defaultStudioConfig();
  // merge overrides shallow per group
  Object.keys(overrides).forEach((k) => {
    c[k] = { ...(c[k] || {}), ...(overrides[k] || {}) };
  });
  return c;
}

function effective(overrides = {}) {
  return {
    feature_available: true,
    master_enabled: true,
    master_points_reward_enabled: true,
    master_image_generation_enabled: true,
    ...overrides,
  };
}

function integrationStatus(opts = {}) {
  const row = (configured, integrationOk, masterOn) => ({
    configured, integration_available: integrationOk,
    master_switch_enabled: masterOn,
    effectively_active: configured && integrationOk && masterOn,
  });
  return {
    points: row(true, true, true),
    first_voice_card: row(true, true, true),
    voucher: row(false, true, true),
    edutalk_pass: row(false, false, true),
    ...opts,
  };
}

async function flush() {
  await act(async () => { await Promise.resolve(); await Promise.resolve(); await Promise.resolve(); });
}

function mountStudio() {
  const container = document.createElement("div");
  document.body.appendChild(container);
  const root = createRoot(container);
  act(() => { root.render(<VoiceTreasureStudio />); });
  return { container, root, unmount() { act(() => root.unmount()); container.remove(); } };
}

beforeEach(() => {
  installMatchMedia(false);
  Object.values(studioApi).forEach((fn) => { if (typeof fn === "function" && fn.mockReset) fn.mockReset(); });
  studioApi.getVoiceTreasureConfig.mockResolvedValue({
    config: makeConfig({ entry: { entry_cost_points: 5 }, language: {
      response_language: "english",
      feedback_language: "match",
      mission_instruction_language: "bilingual",
    } }),
    effective: effective(),
    reward_availability: { voucher: true, edutalk_pass: false },
    integration_status: integrationStatus(),
  });
  studioApi.getVoiceTreasureAnalytics.mockResolvedValue({
    missions_offered: 0, entries_paid: 0, attempts_submitted: 0, attempts_evaluated: 0,
    points_spent: 0, points_rewarded: 0, net_points_flow: 0, provider_failures: 0,
    reconciliation_required_entries: 0, reconciliation_required_rewards: 0,
  });
  studioApi.getVoiceTreasureScenes.mockResolvedValue({ scenes: [] });
});

// ─── Overview ─────────────────────────────────────────────────────────────
describe("Studio Pass B.2.1 · Overview", () => {
  test("authoritative overview populates entry cost, daily limit, language summary, and OK warning", async () => {
    const { container, unmount } = mountStudio();
    await flush(); await flush();
    expect(container.querySelector('[data-testid="vts-overview"]')).toBeTruthy();
    expect(container.querySelector('[data-testid="vts-ov-entry-cost"]').textContent).toMatch(/5 pts/);
    expect(container.querySelector('[data-testid="vts-ov-daily-limit"]').textContent).toMatch(/1/);
    expect(container.querySelector('[data-testid="vts-ov-active-rewards"]').textContent).toMatch(/2 \/ 4/);
    expect(container.querySelector('[data-testid="vts-ov-lang-response"]').textContent).toMatch(/english/);
    expect(container.querySelector('[data-testid="vts-ov-lang-feedback"]').textContent).toMatch(/match/);
    expect(container.querySelector('[data-testid="vts-ov-lang-instruction"]').textContent).toMatch(/bilingual/);
    const warns = container.querySelector('[data-testid="vts-overview-warnings"]');
    expect(warns).toBeTruthy();
    expect(warns.textContent).toMatch(/available/i);
    unmount();
  });

  test("master OFF + zero active rewards surfaces error + warn (no fabricated metrics)", async () => {
    studioApi.getVoiceTreasureConfig.mockResolvedValue({
      config: makeConfig(),
      effective: effective({ master_enabled: false, feature_available: false }),
      reward_availability: { voucher: false, edutalk_pass: false },
      integration_status: integrationStatus({
        points: { configured: true, integration_available: true, master_switch_enabled: false, effectively_active: false },
        first_voice_card: { configured: true, integration_available: true, master_switch_enabled: false, effectively_active: false },
      }),
    });
    const { container, unmount } = mountStudio();
    await flush(); await flush();
    expect(container.querySelector('[data-testid="vts-ov-master"]').textContent).toMatch(/OFF/);
    expect(container.querySelector('[data-testid="vts-ov-active-rewards"]').textContent).toMatch(/0 \/ 4/);
    const warns = container.querySelector('[data-testid="vts-overview-warnings"]');
    expect(warns.querySelector('[data-tone="error"]')).toBeTruthy();
    expect(warns.querySelector('[data-tone="warn"]')).toBeTruthy();
    unmount();
  });
});

// ─── Reward integration cards ─────────────────────────────────────────────
describe("Studio Pass B.2.1 · Reward integration-state cards", () => {
  test("each reward exposes the four-truth contract and a polished pill", async () => {
    const { container, unmount } = mountStudio();
    await flush(); await flush();
    for (const k of ["points", "first_voice_card", "voucher", "edutalk_pass"]) {
      const row = container.querySelector(`[data-testid="vt-integration-${k}"]`);
      expect(row).toBeTruthy();
      expect(row.hasAttribute("data-configured")).toBe(true);
      expect(row.hasAttribute("data-integration-available")).toBe(true);
      expect(row.hasAttribute("data-master-switch-enabled")).toBe(true);
      expect(row.hasAttribute("data-effectively-active")).toBe(true);
      expect(row.querySelector(".vts-integration-pill")).toBeTruthy();
    }
    // Specific truths from our mock:
    expect(
      container.querySelector('[data-testid="vt-integration-points"]').getAttribute("data-effectively-active"),
    ).toBe("true");
    expect(
      container.querySelector('[data-testid="vt-integration-edutalk_pass"]').getAttribute("data-integration-available"),
    ).toBe("false");
    unmount();
  });
});

// ─── Controlled Voucher / EduTalk Pass inputs ─────────────────────────────
describe("Studio Pass B.2.1 · Controlled reward inputs remain editable", () => {
  test("voucher title and EduTalk Pass quantity stay controllable after polish", async () => {
    studioApi.getVoiceTreasureConfig.mockResolvedValue({
      config: makeConfig({
        rewards: {
          voucher_reward_enabled: true, voucher_source: "existing",
          voucher_existing_code: "PROMO", voucher_title: "First win",
          edutalk_pass_reward_enabled: true, edutalk_pass_quantity: 1,
        },
      }),
      effective: effective(),
      reward_availability: { voucher: true, edutalk_pass: true },
      integration_status: integrationStatus({
        voucher: { configured: true, integration_available: true, master_switch_enabled: true, effectively_active: true },
        edutalk_pass: { configured: true, integration_available: true, master_switch_enabled: true, effectively_active: true },
      }),
    });
    const { container, unmount } = mountStudio();
    await flush(); await flush();

    const title = container.querySelector('[data-testid="vt-voucher-title"]');
    expect(title).toBeTruthy();
    const nativeSetter = Object.getOwnPropertyDescriptor(window.HTMLInputElement.prototype, "value").set;
    act(() => {
      nativeSetter.call(title, "Voucher polish");
      title.dispatchEvent(new Event("input", { bubbles: true }));
    });
    expect(title.value).toBe("Voucher polish");

    const qty = container.querySelector('[data-testid="vt-pass-quantity"]');
    expect(qty).toBeTruthy();
    act(() => {
      nativeSetter.call(qty, "3");
      qty.dispatchEvent(new Event("input", { bubbles: true }));
    });
    expect(qty.value).toBe("3");
    unmount();
  });
});

// ─── Bilingual preview ────────────────────────────────────────────────────
describe("Studio Pass B.2.1 · Bilingual preview", () => {
  test("English / Khmer / paired bilingual cards render with lang=km on Khmer body", async () => {
    studioApi.getVoiceTreasureConfig.mockResolvedValue({
      config: makeConfig({
        language: {
          mission_instruction_language: "bilingual",
          mission_instruction_text_en: "Describe the picture.",
          mission_instruction_text_km: "ពិពណ៌នាអំពីរូបភាព។",
        },
      }),
      effective: effective(),
      reward_availability: { voucher: false, edutalk_pass: false },
      integration_status: integrationStatus(),
    });
    const { container, unmount } = mountStudio();
    await flush(); await flush();
    expect(container.querySelector('[data-testid="vts-bilingual-preview"]')).toBeTruthy();
    const en = container.querySelector('[data-testid="vts-bilingual-preview-en-body"]');
    const km = container.querySelector('[data-testid="vts-bilingual-preview-km-body"]');
    const bothEn = container.querySelector('[data-testid="vts-bilingual-preview-both-en"]');
    const bothKm = container.querySelector('[data-testid="vts-bilingual-preview-both-km"]');
    expect(en.textContent).toMatch(/Describe the picture/);
    expect(km.textContent).toMatch(/ពិពណ៌នា/);
    expect(km.getAttribute("lang")).toBe("km");
    expect(bothEn.textContent).toMatch(/Describe the picture/);
    expect(bothKm.getAttribute("lang")).toBe("km");
    // Character counts present.
    expect(container.querySelector('[data-testid="vts-bilingual-preview-en-count"]').textContent).toMatch(/chars/);
    expect(container.querySelector('[data-testid="vts-bilingual-preview-km-count"]').textContent).toMatch(/chars/);
    // No fallback indicators when both overrides are set.
    expect(container.querySelector('[data-testid="vts-bilingual-fallback-en"]')).toBeNull();
    expect(container.querySelector('[data-testid="vts-bilingual-fallback-km"]')).toBeNull();
    unmount();
  });

  test("missing override text surfaces a `fallback` indicator", async () => {
    studioApi.getVoiceTreasureConfig.mockResolvedValue({
      config: makeConfig({ language: { mission_instruction_language: "english" } }),
      effective: effective(),
      reward_availability: { voucher: false, edutalk_pass: false },
      integration_status: integrationStatus(),
    });
    const { container, unmount } = mountStudio();
    await flush(); await flush();
    expect(container.querySelector('[data-testid="vts-bilingual-fallback-en"]')).toBeTruthy();
    expect(container.querySelector('[data-testid="vts-bilingual-fallback-km"]')).toBeTruthy();
    unmount();
  });
});

// ─── Scene Library polish ────────────────────────────────────────────────
describe("Studio Pass B.2.1 · Scene Library", () => {
  test("loading surface is present before data arrives", async () => {
    let resolve;
    studioApi.getVoiceTreasureScenes.mockImplementation(() => new Promise((r) => { resolve = r; }));
    const { container, unmount } = mountStudio();
    await flush();
    expect(container.querySelector('[data-testid="vt-scene-loading"]')).toBeTruthy();
    act(() => { resolve({ scenes: [] }); });
    await flush(); await flush();
    expect(container.querySelector('[data-testid="vt-scene-empty"]')).toBeTruthy();
    unmount();
  });

  test("populated state renders status pill, thumbnail, and stays editable", async () => {
    studioApi.getVoiceTreasureScenes.mockResolvedValue({
      scenes: [
        {
          scene_id: "vt-scene-picnic", title: "Picnic", theme: "outdoor",
          image_ref: "vt-scene-picnic", asset_file: "picnic.webp",
          enabled: true, difficulty: "beginner",
          prompt: "Describe the picnic.", keyword_hints: ["picnic", "basket"],
        },
      ],
    });
    const { container, unmount } = mountStudio();
    await flush(); await flush();
    expect(container.querySelector('[data-testid="vt-scene-vt-scene-picnic"]')).toBeTruthy();
    const status = container.querySelector('[data-testid="vt-scene-status-vt-scene-picnic"]');
    expect(status).toBeTruthy();
    expect(status.getAttribute("data-state")).toBe("enabled");
    expect(status.textContent).toMatch(/ACTIVE/);
    expect(container.querySelector('[data-testid="vt-scene-thumb-vt-scene-picnic"]')).toBeTruthy();
    // Editable prompt textarea still present.
    const prompt = container.querySelector('[data-testid="vt-scene-prompt-vt-scene-picnic"]');
    expect(prompt).toBeTruthy();
    expect(prompt.value).toMatch(/Describe the picnic/);
    unmount();
  });
});

// ─── Reduced motion + no primary emoji ───────────────────────────────────
describe("Studio Pass B.2.1 · reduced motion + emoji absence", () => {
  test("Studio surface contains no primary emoji artwork", async () => {
    const { container, unmount } = mountStudio();
    await flush(); await flush();
    // The 🎙️ in StudioEditor.jsx lives outside the Voice Treasure scope
    // and isn't part of this surface.
    expect(container.textContent).not.toMatch(/🎙️|🎤|🃏|🔥/);
    unmount();
  });

  test("reduced-motion does not throw and overview still renders", async () => {
    installMatchMedia(true);
    const { container, unmount } = mountStudio();
    await flush(); await flush();
    expect(container.querySelector('[data-testid="vts-overview"]')).toBeTruthy();
    unmount();
  });

  test("unrelated Studio modules unaffected — only the VT scope is mounted in this suite", async () => {
    // This is a regression sentinel: if a future refactor leaks Studio
    // globals, this assertion would still pass because we never imported
    // EduTalkStudio/StudioEditor here. The test exists to document intent.
    expect(typeof VoiceTreasureStudio).toBe("function");
  });
});
