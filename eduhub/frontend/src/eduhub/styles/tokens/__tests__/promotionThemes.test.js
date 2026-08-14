import {
  promotionThemes, PROMOTION_PRESET_IDS, PROMOTION_ACCENT_HUES,
  CTA_STYLES, CTA_ANIMATIONS, CTA_PLACEMENTS, DECORATION_TYPES,
  getPromotionTheme, resolveFollowAppTheme,
} from "../promotionThemes";

test("exposes 3 presets, each fully self-contained", () => {
  expect(PROMOTION_PRESET_IDS).toHaveLength(3);
  PROMOTION_PRESET_IDS.forEach((id) => {
    const preset = promotionThemes[id];
    expect(preset.id).toBe(id);
    expect(preset.surface).toEqual(expect.any(String));
    expect(preset.onSurface).toEqual(expect.any(String));
    expect(preset.accent).toEqual(expect.any(String));
    expect(preset.cta).toBeDefined();
    expect(preset.decorations).toBeDefined();
  });
});

test("every decoration type is present, disabled by default, on every preset except celebrationGold's opt-ins", () => {
  const emerald = promotionThemes.emeraldDay;
  DECORATION_TYPES.forEach((type) => {
    expect(emerald.decorations[type]).toEqual({ enabled: false, intensity: "medium", colorOverride: null });
  });
});

test("celebrationGold ships with sparkles + confetti pre-enabled (a celebratory preset)", () => {
  const gold = promotionThemes.celebrationGold;
  expect(gold.decorations.sparkles.enabled).toBe(true);
  expect(gold.decorations.confetti.enabled).toBe(true);
  expect(gold.decorations.lightRays.enabled).toBe(false);
});

test("getPromotionTheme falls back to emeraldDay for an unknown id", () => {
  expect(getPromotionTheme("does-not-exist").id).toBe("emeraldDay");
});

describe("resolveFollowAppTheme — sync mode only ever picks the base Day/Night pair", () => {
  test("light app theme -> Emerald Signature (Day)", () => {
    expect(resolveFollowAppTheme("light").id).toBe("emeraldDay");
  });
  test("dark app theme -> Emerald Signature (Night)", () => {
    expect(resolveFollowAppTheme("dark").id).toBe("emeraldNight");
  });
  test("undefined/unknown app theme defaults to Day", () => {
    expect(resolveFollowAppTheme(undefined).id).toBe("emeraldDay");
  });
});

test("ruby and sapphire are exposed as micro-accent hues, not full presets (directive: avoid excessive color)", () => {
  expect(PROMOTION_ACCENT_HUES.rubyRed).toEqual(expect.any(String));
  expect(PROMOTION_ACCENT_HUES.sapphireBlue).toEqual(expect.any(String));
  expect(PROMOTION_PRESET_IDS).not.toContain("rubyRed");
  expect(PROMOTION_PRESET_IDS).not.toContain("sapphireBlue");
});

test("CTA vocabulary matches the approved directive exactly", () => {
  expect(CTA_STYLES).toEqual(["filled", "outline", "glass", "pill", "floating"]);
  expect(CTA_ANIMATIONS).toEqual(["fade", "rise", "scale", "pulse"]);
  expect(CTA_PLACEMENTS).toEqual(["stack", "center", "relative", "free"]);
});

test("decoration vocabulary includes the 3 new types plus the 3 reused from Achievement", () => {
  expect(DECORATION_TYPES).toEqual(
    expect.arrayContaining(["sparkles", "ribbons", "confetti", "academicParticles", "premiumDust", "lightRays"]),
  );
  expect(DECORATION_TYPES).toHaveLength(6);
});
