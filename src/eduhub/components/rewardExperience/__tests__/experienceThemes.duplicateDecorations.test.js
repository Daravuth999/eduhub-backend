/**
 * experienceThemes.duplicateDecorations.test.js — regression guard for a
 * bug report: "the same artwork renders twice" in both the Author Studio
 * Designer preview and the live student popup.
 *
 * Root cause: every decoration is keyed by `d.id` when rendered
 * (RewardDecorationLayer's `.map()`, RewardExperiencePreview's edit
 * handles), but nothing ever collapsed two decoration objects that share
 * the same id. A React `key` only affects reconciliation identity — an
 * array with two entries sharing a key still renders two DOM nodes (React
 * only logs a console warning). `normalizeExperience()` now dedupes by id
 * (last one wins) so this can never reach the renderer.
 */
import { normalizeExperience } from "../experienceThemes";

describe("normalizeExperience — duplicate decoration ids", () => {
  test("two decorations sharing the same id collapse into one (last wins)", () => {
    const exp = normalizeExperience({
      environment: "morning_angkor",
      decorations: [
        { id: "dup1", kind: "builtin", asset: "angkor_tower", x: 50, y: 40, layer: "front" },
        { id: "dup1", kind: "builtin", asset: "angkor_tower", x: 50, y: 40, layer: "front", rotation: 12 },
      ],
    });
    expect(exp.decorations).toHaveLength(1);
    expect(exp.decorations[0].id).toBe("dup1");
    // last entry wins
    expect(exp.decorations[0].rotation).toBe(12);
  });

  test("decorations with distinct ids are all kept, in order", () => {
    const exp = normalizeExperience({
      environment: "morning_angkor",
      decorations: [
        { id: "a", kind: "builtin", asset: "lotus", layer: "back" },
        { id: "b", kind: "builtin", asset: "star", layer: "front" },
      ],
    });
    expect(exp.decorations.map((d) => d.id)).toEqual(["a", "b"]);
  });

  test("re-normalizing an already-deduped list stays stable (idempotent)", () => {
    const once = normalizeExperience({
      environment: "morning_angkor",
      decorations: [{ id: "x", kind: "builtin", asset: "trophy" }],
    });
    const twice = normalizeExperience(once);
    expect(twice.decorations).toHaveLength(1);
    expect(twice.decorations[0].id).toBe("x");
  });
});
