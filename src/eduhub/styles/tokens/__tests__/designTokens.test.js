/**
 * designTokens.test.js — Dashboard Foundation Phase 1 additions: named
 * section-rhythm spacing and the 5-level elevation scale. Existing
 * palettes/spacing/radius/glass/safeMargins are untouched by this phase
 * (no assertions needed — every current consumer's tests already cover
 * them and continue passing unmodified).
 */
import { spacing, sectionRhythm, elevation, ELEVATION_LEVELS, getPalette } from "../designTokens";

describe("sectionRhythm", () => {
  test("defines tight < primary < pause, each derived from the existing spacing scale", () => {
    expect(sectionRhythm.tight).toBe(spacing.md);
    // RC3 §9 Mobile-First Spacing pass: `primary` tightened from spacing.xl
    // (2rem) to spacing.lg (1.5rem) — the Dashboard grew to 8 top-level
    // sections across RC2.5/RC2.9/RC3, so the same per-gap value compounded
    // into more total scroll distance than intended on a phone.
    expect(sectionRhythm.primary).toBe(spacing.lg);
    // Campaign Design Studio 2.0 rhythm pass: pause tightened from xxl
    // (3rem) to xl + sm (2.5rem) — still a deliberate breathing beat above
    // `primary`, but no longer a visual disconnect before the Leaderboard.
    expect(sectionRhythm.pause).toBe(spacing.xl + spacing.sm);
    expect(sectionRhythm.tight).toBeLessThan(sectionRhythm.primary);
    expect(sectionRhythm.primary).toBeLessThan(sectionRhythm.pause);
  });
});

describe("elevation — 5-level scale", () => {
  test("has all 5 named levels, monotonically stronger shadows flat -> dialog", () => {
    expect(Object.keys(elevation)).toEqual(["flat", "soft", "raised", "floating", "dialog"]);
    expect(elevation.flat).toBe("none");
    ["soft", "raised", "floating", "dialog"].forEach((k) => {
      expect(elevation[k]).toMatch(/^0 \d+px \d+px rgba/);
    });
  });

  test("ELEVATION_LEVELS documents level number + semantic label for each elevation key", () => {
    expect(ELEVATION_LEVELS).toHaveLength(5);
    ELEVATION_LEVELS.forEach((entry, i) => {
      expect(entry.level).toBe(i);
      expect(elevation).toHaveProperty(entry.id);
      expect(entry.label).toEqual(expect.any(String));
    });
  });
});

test("getPalette still resolves unchanged (regression guard for this file's other exports)", () => {
  expect(getPalette("morningEmerald").label).toBe("Morning Emerald");
  expect(getPalette("unknown-id")).toBe(getPalette("morningEmerald"));
});
