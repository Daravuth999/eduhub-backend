/**
 * achievementConfigResolver.test.js — pure resolution logic for the
 * Achievement Experience Studio: sync-mode resolution, override merging,
 * and safe fallback when no config is published yet.
 */
import { resolveAchievementPresentation, mergeAchievementOverrides } from "../achievementConfigResolver";
import { achievementThemes, getAchievementTheme } from "../../../styles/tokens/achievementThemes";

describe("resolveAchievementPresentation — no config yet (backward compatible with pre-Studio Phase E)", () => {
  test("null config + light app theme -> Emerald Achievement, no artwork", () => {
    const r = resolveAchievementPresentation(null, { appTheme: "light" });
    expect(r.id).toBe("emeraldAchievement");
    expect(r.artwork).toBeNull();
    expect(r.visible).toBe(true);
  });

  test("null config + dark app theme -> Midnight Achievement", () => {
    const r = resolveAchievementPresentation(null, { appTheme: "dark" });
    expect(r.id).toBe("midnightAchievement");
  });
});

describe("sync mode", () => {
  test("followWelcome (default) tracks the app theme, ignoring any themeId", () => {
    const config = { appearance: { syncMode: "followWelcome", themeId: "halloween" } };
    expect(resolveAchievementPresentation(config, { appTheme: "light" }).id).toBe("emeraldAchievement");
    expect(resolveAchievementPresentation(config, { appTheme: "dark" }).id).toBe("midnightAchievement");
  });

  test("independent uses the admin-selected preset regardless of app theme", () => {
    const config = { appearance: { syncMode: "independent", themeId: "halloween" } };
    expect(resolveAchievementPresentation(config, { appTheme: "light" }).id).toBe("halloween");
    expect(resolveAchievementPresentation(config, { appTheme: "dark" }).id).toBe("halloween");
  });

  test("independent with no themeId falls back to Emerald Achievement, not a crash", () => {
    const config = { appearance: { syncMode: "independent" } };
    expect(resolveAchievementPresentation(config, { appTheme: "light" }).id).toBe("emeraldAchievement");
  });

  test("an unrecognized syncMode value defaults to followWelcome (fail safe, not fail open)", () => {
    const config = { appearance: { syncMode: "bogus", themeId: "halloween" } };
    expect(resolveAchievementPresentation(config, { appTheme: "dark" }).id).toBe("midnightAchievement");
  });
});

describe("visibility + artwork passthrough", () => {
  test("content.visible=false is surfaced on the resolved presentation", () => {
    const r = resolveAchievementPresentation({ content: { visible: false }, appearance: {} }, { appTheme: "light" });
    expect(r.visible).toBe(false);
  });

  test("appearance.artwork passes through untouched", () => {
    const artwork = { url: "https://cdn/x.png", placement: "right", scale: 100 };
    const r = resolveAchievementPresentation({ appearance: { artwork } }, { appTheme: "light" });
    expect(r.artwork).toEqual(artwork);
  });
});

describe("mergeAchievementOverrides", () => {
  const base = getAchievementTheme("emeraldAchievement");

  test("no overrides returns the base preset unchanged", () => {
    expect(mergeAchievementOverrides(base, null)).toBe(base);
  });

  test("top-level field overrides apply without touching untouched fields", () => {
    const merged = mergeAchievementOverrides(base, { primary: "#123456" });
    expect(merged.primary).toBe("#123456");
    expect(merged.secondary).toBe(base.secondary); // untouched
  });

  test("trophy overrides merge per-field, not replace-the-whole-object", () => {
    const merged = mergeAchievementOverrides(base, { trophy: { color: "#ABCDEF" } });
    expect(merged.trophy.color).toBe("#ABCDEF");
    expect(merged.trophy.style).toBe(base.trophy.style); // untouched, not wiped
    expect(merged.trophy.winnerAnimation).toBe(base.trophy.winnerAnimation);
  });

  test("playerCard overrides merge per-field", () => {
    const merged = mergeAchievementOverrides(base, { playerCard: { shape: "pill" } });
    expect(merged.playerCard.shape).toBe("pill");
    expect(merged.playerCard.cornerRadius).toBe(base.playerCard.cornerRadius);
  });

  test("decoration overrides toggle a SINGLE decoration without touching the others", () => {
    const merged = mergeAchievementOverrides(base, {
      decorations: { fireworks: { enabled: true, intensity: "high" } },
    });
    expect(merged.decorations.fireworks).toEqual({ enabled: true, intensity: "high", colorOverride: null });
    // Every other decoration matches the base preset exactly (e.g. base sparkles).
    expect(merged.decorations.sparkles).toEqual(base.decorations.sparkles);
    expect(merged.decorations.confetti).toEqual(base.decorations.confetti);
  });

  test("rankTile overrides replace only the specified rank entries", () => {
    const merged = mergeAchievementOverrides(base, { rankTile: { 1: { gradient: "red", glow: "red", on: "#fff" } } });
    expect(merged.rankTile[1].gradient).toBe("red");
    expect(merged.rankTile[2]).toEqual(base.rankTile[2]); // untouched
  });

  test("an unknown/typo'd override key is silently ignored, never crashes", () => {
    expect(() => mergeAchievementOverrides(base, { notARealField: 123 })).not.toThrow();
    const merged = mergeAchievementOverrides(base, { notARealField: 123 });
    expect(merged.notARealField).toBeUndefined();
  });
});

test("EVERY preset resolves cleanly through the full pipeline with a full override set", () => {
  Object.keys(achievementThemes).forEach((id) => {
    const config = {
      appearance: {
        syncMode: "independent",
        themeId: id,
        overrides: { primary: "#000000", trophy: { color: "#111111" }, decorations: { snow: { enabled: true } } },
      },
    };
    expect(() => resolveAchievementPresentation(config, { appTheme: "light" })).not.toThrow();
    const r = resolveAchievementPresentation(config, { appTheme: "light" });
    expect(r.id).toBe(id);
    expect(r.primary).toBe("#000000");
  });
});
