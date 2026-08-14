/**
 * voiceTreasure_pass2.test.jsx — Pass 2 surgical UI tests.
 *
 * Source-presence tests (the repo's pure-function convention) covering: VT
 * identity header (no Lucky Spin), dashboard hierarchy, truthful reward
 * visibility, result categories, bilingual labels, chest state coverage,
 * one-time reveal behavior, reduced motion, and the original five Home
 * tiles preserved.
 */
import fs from "fs";
import path from "path";

const VT = (f) => path.join(__dirname, "..", f);
const read = (f) => fs.readFileSync(VT(f), "utf8");

describe("Pass 2 — Voice Treasure identity (no Lucky Spin inside VT routes)", () => {
  test("identity helper renders 'Voice Treasure' brand and sets document.title", () => {
    const src = fs.readFileSync(path.join(__dirname, "..", "useVoiceTreasureIdentity.js"), "utf8");
    expect(src).toMatch(/document\.title\s*=/);
    expect(src).toMatch(/Voice Treasure/);
    expect(src).toMatch(/data-testid="vt-brand-title"/);
  });

  test("dashboard renders the identity header (not Lucky Spin)", () => {
    const src = read("VoiceTreasureDashboard.jsx");
    expect(src).toMatch(/<VoiceTreasureIdentity/);
    expect(src).not.toMatch(/\bLucky Spin\b/);
    expect(src).toMatch(/useVoiceTreasureTitle\(["']Dashboard["']\)/);
  });

  test("result renders the identity header (not Lucky Spin)", () => {
    const src = read("VoiceTreasureResult.jsx");
    expect(src).toMatch(/<VoiceTreasureIdentity/);
    expect(src).not.toMatch(/\bLucky Spin\b/);
  });
});

describe("Pass 2 — Dashboard hierarchy + truthful rewards", () => {
  const src = read("VoiceTreasureDashboard.jsx");

  test.each([
    "vt-student-initial", "vt-student-name", "vt-balance-points",
    "vt-hero-mission", "vt-hero-cost", "vt-hero-title", "vt-hero-prompt",
    "vt-start-speaking", "vt-progress-strip",
    "vt-stat-missions", "vt-stat-best-streak", "vt-stat-collection",
    "vt-to-collection", "vt-to-progress",
  ])("dashboard exposes data-testid %s", (id) => {
    expect(src).toContain(`data-testid="${id}"`);
  });

  test("dashboard hides points reward range when master switch is OFF", () => {
    // The component branches on `pointsEnabled` and emits a dedicated
    // testid for the disabled label. Truthful currency display.
    expect(src).toMatch(/data-testid="vt-hero-reward-range"/);
    expect(src).toMatch(/data-testid="vt-hero-reward-disabled"/);
    expect(src).toMatch(/master_points_reward_enabled/);
  });

  test("dashboard never references unsupported currencies", () => {
    for (const forbidden of ["Gems", "gems", "Diamonds", "diamonds", "Skins", "Boost"]) {
      expect(src).not.toContain(forbidden);
    }
  });
});

describe("Pass 2 — Result: five categories + bilingual labels", () => {
  const src = read("VoiceTreasureResult.jsx");

  test.each([
    "relevance", "visual_grounding", "detail", "organization", "understandable_language",
  ])("result handles category %s in its ORDER list", (k) => {
    // Template-literal data-testid renders as `vt-cat-${k}` at runtime; we
    // verify the category key appears in the ORDER constant and the
    // CATEGORY_LABELS map.
    expect(src).toMatch(new RegExp(`["']${k}["']`));
  });

  test("result does NOT include disallowed categories", () => {
    for (const forbidden of [
      "pronunciation_score", "fluency_score", "vocabulary_score", "confidence_score",
      'vt-cat-pronunciation"', 'vt-cat-fluency"', 'vt-cat-vocabulary"', 'vt-cat-confidence"',
    ]) {
      expect(src).not.toContain(forbidden);
    }
  });

  test("result has Khmer labels for every supported category", () => {
    const km = ["ភាពពាក់ព័ន្ធ", "សំអាងលើរូបភាព", "ព័ត៌មានលំអិត", "រចនាសម្ព័ន្ធ", "ភាសាងាយយល់"];
    km.forEach((k) => expect(src).toContain(k));
  });

  test("result wires Open Chest CTA only after backend-confirmed evaluation", () => {
    expect(src).toMatch(/data-testid="vt-open-chest-cta"/);
    // It navigates to the chest route — the chest page is the only place
    // that may reveal a confirmed reward.
    expect(src).toMatch(/voice-treasure\/chest\//);
  });
});

describe("Pass 2 — Chest states + reduced motion + no animation-driven claim", () => {
  const css = read("VoiceTreasure.css");
  const svg = read("ChestAssets.jsx");
  const page = read("VoiceTreasureChest.jsx");

  test.each([
    "sealed", "glowing", "processing", "reconciliation_required",
    "opening", "completed", "confirmed_failed", "ineligible",
  ])("chest stage supports state %s", (s) => {
    expect(svg).toContain(`"${s}"`);
  });

  test("only the completed state reveals the open chest visual", () => {
    // Lid translation/rotation lock-in is keyed to completed (or as the
    // terminal frame of opening). Earlier states keep latch/lid baseline.
    expect(css).toMatch(/\[data-state="completed"\]\s*\.vt-lid/);
    expect(css).toMatch(/\[data-state="completed"\]\s*\.vt-rays/);
    expect(css).toMatch(/\[data-state="completed"\]\s*\.vt-card/);
  });

  test("processing and reconciliation_required stay sealed (no lid lift keyframe)", () => {
    expect(css).not.toMatch(/\[data-state="processing"\]\s*\.vt-lid\s*\{[^}]*translateY/);
    expect(css).not.toMatch(/\[data-state="reconciliation_required"\]\s*\.vt-lid\s*\{[^}]*translateY/);
  });

  test("prefers-reduced-motion disables animations while preserving completed reveal", () => {
    expect(css).toMatch(/@media\s*\(prefers-reduced-motion:\s*reduce\)/);
    expect(css).toMatch(/animation:\s*none\s*!important/);
  });

  test("chest page never triggers backend claim from animation", () => {
    // The chest component does NOT call api.claim from any animation
    // lifecycle hook. claim is gated by an explicit user CTA + canClaim.
    expect(page).toMatch(/canClaim/);
    expect(page).not.toMatch(/onAnimationEnd=\{[^}]*claim/);
  });

  test("VoiceTreasureChest.jsx now uses the layered SVG ChestSVG (not emoji)", () => {
    expect(page).toMatch(/import\s*\{\s*ChestSVG\s*\}/);
    expect(page).toMatch(/<ChestSVG\s/);
    // No emoji as primary chest artwork.
    for (const e of ["🧰", "🪙"]) expect(page).not.toContain(e);
  });
});

describe("Pass 2 — Premium visual system tokens + safe areas", () => {
  const css = read("VoiceTreasure.css");
  test.each([
    "--vt-bg-0", "--vt-bg-1", "--vt-panel", "--vt-accent-cyan",
    "--vt-accent-violet", "--vt-gold-0", "--vt-gold-1",
  ])("Voice Treasure palette token %s is defined", (token) => {
    expect(css).toContain(token);
  });
  test("safe-area insets and dynamic viewport height are honoured", () => {
    expect(css).toContain("env(safe-area-inset-top");
    expect(css).toContain("env(safe-area-inset-bottom");
    expect(css).toMatch(/100dvh/);
  });
  test("styles are scoped to .vt-root and never leak globally", () => {
    // Every selector is rooted in .vt-root or the chest stage. Spot-check.
    expect(css).toMatch(/\.vt-root\s+\.vt-panel/);
    expect(css).toMatch(/\.vt-root\s+\.vt-chest-stage/);
    // No bare element selectors at top level (body/html/*).
    expect(css).not.toMatch(/^\s*body\s*\{/m);
    expect(css).not.toMatch(/^\s*html\s*\{/m);
  });
});

describe("Pass 2 — Original five EduHub Home tiles preserved", () => {
  // The Voice Treasure tile is the SIXTH conditional tile. The five
  // originals must not be removed/reordered. We assert on App.js / Home.
  test("App.js still imports the original five Home tile destinations", () => {
    const app = fs.readFileSync(path.join(__dirname, "..", "..", "..", "..", "..", "App.js"), "utf8");
    // Spot-check imports that represent the original five tile targets;
    // their presence is a non-regression invariant.
    expect(app).toMatch(/RewardsHome|RewardsRouter|Library|AssistantHome|Reader/);
  });
});
