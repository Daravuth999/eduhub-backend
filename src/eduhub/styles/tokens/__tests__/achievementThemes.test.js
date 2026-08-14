/**
 * achievementThemes.test.js — Achievement Experience Studio preset library.
 * Structural/contract tests: every preset is complete and self-consistent
 * (nothing TopEarnerPanel needs is ever missing), the base Emerald/
 * Midnight pair stays backward-compatible with Phase E's shipped
 * getAchievementTheme("dark"|"light") call shape, and Follow-Welcome sync
 * resolution only ever picks between the base pair.
 */
import {
  achievementThemes,
  ACHIEVEMENT_PRESET_IDS,
  DECORATION_TYPES,
  getAchievementTheme,
  resolveFollowWelcomeTheme,
} from "../achievementThemes";

test("exposes all 11 presets from the approved directive", () => {
  expect(ACHIEVEMENT_PRESET_IDS).toHaveLength(11);
  expect(ACHIEVEMENT_PRESET_IDS).toEqual(expect.arrayContaining([
    "emeraldAchievement", "midnightAchievement", "goldenCelebration", "graduation",
    "khmerNewYear", "christmas", "independenceDay", "teacherAppreciation",
    "backToSchool", "halloween", "anniversaryCelebration",
  ]));
});

test("every preset defines a complete set of fields TopEarnerPanel depends on", () => {
  const REQUIRED = [
    "id", "label", "mode", "surface", "primary", "secondary", "accent",
    "accentBarGradient", "goldAccent", "emeraldAccent", "onSurface", "onSurfaceSoft",
    "headerColor", "nameColor", "labelColor", "scoreColor", "liveBadge",
    "rankTile", "trophy", "playerCard", "decorations",
    "surfaceCard", "surfaceCardBorder", "tickerBg", "chipActiveBg", "chipActiveBorder",
  ];
  Object.values(achievementThemes).forEach((theme) => {
    REQUIRED.forEach((field) => {
      expect(theme).toHaveProperty(field);
    });
    expect(theme.rankTile).toHaveProperty("1");
    expect(theme.rankTile).toHaveProperty("2");
    expect(theme.rankTile).toHaveProperty("3");
    expect(theme.rankTile).toHaveProperty("rest");
    [1, 2, 3, "rest"].forEach((k) => {
      expect(theme.rankTile[k]).toEqual(expect.objectContaining({ gradient: expect.any(String), glow: expect.any(String), on: expect.any(String) }));
    });
  });
});

test("every preset's decorations object covers all 10 decoration types, each toggleable independently", () => {
  expect(DECORATION_TYPES).toHaveLength(10);
  Object.values(achievementThemes).forEach((theme) => {
    DECORATION_TYPES.forEach((type) => {
      expect(theme.decorations).toHaveProperty(type);
      expect(theme.decorations[type]).toEqual(expect.objectContaining({
        enabled: expect.any(Boolean),
        intensity: expect.stringMatching(/^(low|medium|high)$/),
      }));
    });
  });
});

test("every preset defines trophy and playerCard customization per the directive", () => {
  Object.values(achievementThemes).forEach((theme) => {
    expect(theme.trophy).toEqual(expect.objectContaining({
      style: expect.any(String),
      color: expect.any(String),
      medalDesign: expect.any(String),
      winnerRing: expect.objectContaining({ enabled: expect.any(Boolean) }),
      championGlow: expect.objectContaining({ enabled: expect.any(Boolean) }),
      winnerAnimation: expect.any(String),
    }));
    expect(theme.playerCard).toEqual(expect.objectContaining({
      shape: expect.any(String),
      cornerRadius: expect.any(String),
      elevation: expect.any(String),
      borderStyle: expect.any(String),
    }));
  });
});

test("seasonal presets carry a suggested recurring-annual scheduling default", () => {
  expect(achievementThemes.khmerNewYear.seasonalDefault).toEqual({ startsAt: "04-13", endsAt: "04-16", recurringAnnual: true });
  expect(achievementThemes.christmas.seasonalDefault.recurringAnnual).toBe(true);
  expect(achievementThemes.independenceDay.seasonalDefault.recurringAnnual).toBe(true);
  expect(achievementThemes.halloween.seasonalDefault.recurringAnnual).toBe(true);
  // Non-seasonal presets have no forced schedule.
  expect(achievementThemes.emeraldAchievement.seasonalDefault).toBeUndefined();
  expect(achievementThemes.goldenCelebration.seasonalDefault).toBeUndefined();
});

test("no two presets share the exact same surface gradient (each is visually distinct)", () => {
  const surfaces = Object.values(achievementThemes).map((t) => t.surface);
  expect(new Set(surfaces).size).toBe(surfaces.length);
});

describe("getAchievementTheme — backward compatible with Phase E's legacy call shape", () => {
  test("a known preset id resolves directly", () => {
    expect(getAchievementTheme("goldenCelebration").id).toBe("goldenCelebration");
    expect(getAchievementTheme("halloween").id).toBe("halloween");
  });

  test("legacy 'dark'/'light' still resolve to the base pair (Phase E callers unaffected)", () => {
    expect(getAchievementTheme("dark").id).toBe("midnightAchievement");
    expect(getAchievementTheme("light").id).toBe("emeraldAchievement");
    expect(getAchievementTheme(undefined).id).toBe("emeraldAchievement");
  });
});

describe("resolveFollowWelcomeTheme — sync mode only ever picks the base pair", () => {
  test("day (light) app theme -> Emerald Achievement", () => {
    expect(resolveFollowWelcomeTheme("light").id).toBe("emeraldAchievement");
  });
  test("night (dark) app theme -> Midnight Achievement", () => {
    expect(resolveFollowWelcomeTheme("dark").id).toBe("midnightAchievement");
  });
});
