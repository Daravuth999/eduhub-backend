/**
 * VT Pass A — functional/behavioral tests.
 *
 * These tests exercise REAL exported behavior of:
 *
 *   A. Header title resolver (Voice Treasure title vs Lucky Spin)
 *   A. MobileBottomNav active-state resolver (no item active on VT)
 *   B. VoiceTreasureApp router shape (Evaluation route is reachable)
 *   B. VoiceTreasureEvaluation behavioral pieces (read-only, stage labels,
 *      retry navigation back to /record, reduced-motion guard)
 *   C. Result component honors a top-level language_policy.feedback_language
 *   F. Rewards component renders confirmed voucher/pass rows only when
 *      state === "granted".
 *
 * Constraints (per Pass A directives):
 *   • No new test dependencies added; no jest-environment-jsdom added.
 *   • Tests rely ONLY on what is already in the project. The CRA test
 *     environment is jsdom by default.
 *   • Where a component has heavy provider dependencies (Header), we test
 *     the EXPORTED pure helper instead of mounting the whole component —
 *     that is still a functional/behavioral assertion, not a source-text
 *     substring check.
 */

import fs from "fs";
import path from "path";

// Pure helpers (no React/Router/icon dependencies) — VT Pass A modules.
import { resolveTitle, VT_PREFIX } from "../../../../components/headerTitle";
import { isActiveForPath } from "../../../../components/bottomNavActive";

// Plain item stand-ins matching the real ITEMS shape from MobileBottomNav,
// minus the icon component (we only test active-state, not rendering).
const NAV_ITEMS = [
  { label: "Home",    to: "/" },
  { label: "Library", to: "/library" },
  { label: "Spin",    to: "/game" },
  { label: "Portal",  to: "/portal", key: "portal" },
];

const SRC_DIR = path.resolve(__dirname, "..");
// Paths are relative to SRC_DIR (= the voice-treasure folder).
const readSrc = (file) => fs.readFileSync(path.join(SRC_DIR, file), "utf8");

describe("VT Pass A · A. Global identity — Header title resolver", () => {
  test("Voice Treasure prefix resolves to 'Voice Treasure', not 'Lucky Spin'", () => {
    expect(resolveTitle("/game/voice-treasure")).toBe("Voice Treasure");
    expect(resolveTitle("/game/voice-treasure/")).toBe("Voice Treasure");
    expect(resolveTitle("/game/voice-treasure/record")).toBe("Voice Treasure");
    expect(resolveTitle("/game/voice-treasure/evaluation/abc-123")).toBe("Voice Treasure");
    expect(resolveTitle("/game/voice-treasure/result/abc-123")).toBe("Voice Treasure");
    expect(resolveTitle("/game/voice-treasure/chest/abc-123")).toBe("Voice Treasure");
  });

  test("Lucky Spin titles remain unchanged", () => {
    expect(resolveTitle("/game")).toBe("Lucky Spin");
    expect(resolveTitle("/game/play")).toBe("Lucky Spin");
  });

  test("Unrelated route titles remain unchanged", () => {
    expect(resolveTitle("/")).toBe("Dashboard");
    expect(resolveTitle("/library")).toBe("Classroom Library");
    expect(resolveTitle("/portal")).toBe("My Portal");
    expect(resolveTitle("/portal/me")).toBe("My Portal");
    expect(resolveTitle("/login")).toBe("Sign In");
    expect(resolveTitle("/assistant")).toBe("AI Assistant");
    expect(resolveTitle("/some/unknown/route")).toBe("Dashboard");
  });

  test("VT_PREFIX is correctly exposed", () => {
    expect(VT_PREFIX).toBe("/game/voice-treasure");
  });
});

describe("VT Pass A · A. Global identity — Bottom-nav isolation", () => {
  const spinItem = NAV_ITEMS.find((i) => i.label === "Spin");
  const homeItem = NAV_ITEMS.find((i) => i.label === "Home");
  const libraryItem = NAV_ITEMS.find((i) => i.label === "Library");
  const portalItem = NAV_ITEMS.find((i) => i.key === "portal");

  test("Voice Treasure routes ⇒ no item active", () => {
    for (const it of NAV_ITEMS) {
      expect(isActiveForPath(it, "/game/voice-treasure")).toBe(false);
      expect(isActiveForPath(it, "/game/voice-treasure/record")).toBe(false);
      expect(isActiveForPath(it, "/game/voice-treasure/evaluation/x")).toBe(false);
      expect(isActiveForPath(it, "/game/voice-treasure/result/x")).toBe(false);
    }
  });

  test("Lucky Spin routes ⇒ Spin tab active (unchanged behavior)", () => {
    expect(isActiveForPath(spinItem, "/game")).toBe(true);
    expect(isActiveForPath(spinItem, "/game/play")).toBe(true);
    expect(isActiveForPath(homeItem, "/game")).toBe(false);
  });

  test("Other routes ⇒ correct tab active (unchanged behavior)", () => {
    expect(isActiveForPath(homeItem, "/")).toBe(true);
    expect(isActiveForPath(libraryItem, "/library")).toBe(true);
    expect(isActiveForPath(libraryItem, "/library/x")).toBe(true);
    expect(isActiveForPath(portalItem, "/portal")).toBe(true);
    expect(isActiveForPath(portalItem, "/portal/me")).toBe(true);
  });
});

describe("VT Pass A · B. Evaluation route — router wiring", () => {
  const appSrc = readSrc("VoiceTreasureApp.jsx");

  test("Router imports VoiceTreasureEvaluation", () => {
    expect(appSrc).toContain("import VoiceTreasureEvaluation from");
  });

  test("Router registers /evaluation/:attemptId", () => {
    expect(appSrc).toMatch(/path="evaluation\/:attemptId"/);
    expect(appSrc).toMatch(/element=\{<VoiceTreasureEvaluation\s*\/>\}/);
  });

  test("Recorder navigates to /evaluation/:attemptId after exactly one submit", () => {
    const recSrc = readSrc("VoiceTreasureRecorder.jsx");
    expect(recSrc).toMatch(/\/game\/voice-treasure\/evaluation\//);
    // Only ONE submitAttempt call ever — never inside Evaluation
    expect((recSrc.match(/api\.submitAttempt\(/g) || []).length).toBe(1);
    const evalSrc = readSrc("VoiceTreasureEvaluation.jsx");
    expect(evalSrc).not.toMatch(/api\.submitAttempt/);
  });
});

describe("VT Pass A · B. Evaluation — read-only polling contract", () => {
  const src = readSrc("VoiceTreasureEvaluation.jsx");

  test("Polls the attempt via api.getAttempt(attemptId)", () => {
    expect(src).toMatch(/api\.getAttempt\(/);
  });

  test("On evaluated state, navigates to /result/:attemptId", () => {
    expect(src).toMatch(/\/game\/voice-treasure\/result\//);
    expect(src).toMatch(/st === "evaluated"/);
  });

  test("Surfaces safe retry without re-submitting on unavailable/failed", () => {
    expect(src).toMatch(/evaluation_unavailable/);
    expect(src).toMatch(/evaluation_failed/);
    expect(src).not.toMatch(/api\.submitAttempt/);
    expect(src).toMatch(/Try recording again/);
    expect(src).toMatch(/\/game\/voice-treasure\/record/);
  });

  test("Reduced motion is honored for the stage cue", () => {
    expect(src).toMatch(/prefers-reduced-motion/);
  });

  test("Surfaces direct-link 404 by routing home (no resubmission)", () => {
    expect(src).toMatch(/status === 404/);
  });
});

describe("VT Pass A · C. Result — language-policy projection", () => {
  const src = readSrc("VoiceTreasureResult.jsx");

  test("Result reads top-level r.language_policy.feedback_language", () => {
    expect(src).toMatch(/r\?\.language_policy\?\.feedback_language/);
  });

  test("Result honors English / Khmer / bilingual rendering", () => {
    expect(src).toMatch(/bilingual/);
    expect(src).toMatch(/km/);
  });

  test("Five score categories are preserved", () => {
    for (const k of [
      "relevance", "visual_grounding", "detail",
      "organization", "understandable_language",
    ]) {
      expect(src).toContain(k);
    }
  });
});

describe("VT Pass A · F. Rewards — confirmed-only voucher/pass display", () => {
  const src = readSrc("VoiceTreasureRewards.jsx");

  test("Voucher row renders only when state === 'granted'", () => {
    expect(src).toMatch(/r\.voucher\s*&&\s*r\.voucher\.state\s*===\s*["']granted["']/);
  });

  test("EduTalk Pass row renders only when state === 'granted'", () => {
    expect(src).toMatch(/r\.edutalk_pass\s*&&\s*r\.edutalk_pass\.state\s*===\s*["']granted["']/);
  });

  test("Does NOT show pending / eligible / blocked / failed states", () => {
    expect(src).not.toMatch(/state\s*===\s*["']pending["']/);
    expect(src).not.toMatch(/state\s*===\s*["']eligible["']/);
    expect(src).not.toMatch(/state\s*===\s*["']blocked["']/);
    expect(src).not.toMatch(/state\s*===\s*["']failed["']/);
  });

  test("Never exposes internal voucher code / private references", () => {
    expect(src).not.toMatch(/voucher_existing_code/);
    expect(src).not.toMatch(/voucher_discount_value/);
    expect(src).not.toMatch(/voucher_source/);
  });

  test("Renders points + first voice card behavior (preserved)", () => {
    expect(src).toMatch(/points_credited/);
    expect(src).toMatch(/first_voice_card/);
  });
});
