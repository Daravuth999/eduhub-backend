import { resolvePromotionPresentation, mergePromotionOverrides } from "../promotionConfigResolver";
import { promotionThemes } from "../../../styles/tokens/promotionThemes";

describe("resolvePromotionPresentation", () => {
  test("null config -> Follow-Theme Day preset, empty text/CTA, visible true", () => {
    const resolved = resolvePromotionPresentation(null, { appTheme: "light" });
    expect(resolved.id).toBe("emeraldDay");
    expect(resolved.textLayers).toEqual([]);
    expect(resolved.ctaButtons).toEqual([]);
    expect(resolved.visible).toBe(true);
    expect(resolved.artwork).toBeNull();
  });

  test("followTheme sync mode tracks app theme (light -> Day, dark -> Night)", () => {
    const config = { appearance: { syncMode: "followTheme" } };
    expect(resolvePromotionPresentation(config, { appTheme: "light" }).id).toBe("emeraldDay");
    expect(resolvePromotionPresentation(config, { appTheme: "dark" }).id).toBe("emeraldNight");
  });

  test("independent sync mode selects the admin-chosen preset regardless of app theme", () => {
    const config = { appearance: { syncMode: "independent", themeId: "celebrationGold" } };
    const resolved = resolvePromotionPresentation(config, { appTheme: "dark" });
    expect(resolved.id).toBe("celebrationGold");
  });

  test("content.visible=false is respected", () => {
    const resolved = resolvePromotionPresentation({ content: { visible: false } }, {});
    expect(resolved.visible).toBe(false);
  });

  test("textLayers and ctaButtons pass through from content unchanged", () => {
    const layers = [{ id: "l1", role: "headline", content: "Hi" }];
    const buttons = [{ id: "b1", label: "Go", action: { type: "internal_route", value: "/library" } }];
    const resolved = resolvePromotionPresentation({ content: { textLayers: layers, ctaButtons: buttons } }, {});
    expect(resolved.textLayers).toEqual(layers);
    expect(resolved.ctaButtons).toEqual(buttons);
  });

  test("ctaPlacement falls back to the preset's own cta.placement when content doesn't set one", () => {
    const resolved = resolvePromotionPresentation({ appearance: { syncMode: "followTheme" } }, { appTheme: "light" });
    expect(resolved.ctaPlacement).toBe(promotionThemes.emeraldDay.cta.placement);
  });

  test("artwork passes through the heroArtworkSchema-shaped object unchanged", () => {
    const artwork = { url: "https://cdn/x.png", placement: "right", scale: 100 };
    const resolved = resolvePromotionPresentation({ appearance: { artwork } }, {});
    expect(resolved.artwork).toEqual(artwork);
  });

  test("motion defaults to fade + stagger when not configured", () => {
    const resolved = resolvePromotionPresentation({}, {});
    expect(resolved.motion).toEqual({ entrance: "fade", stagger: true });
  });
});

describe("mergePromotionOverrides", () => {
  const base = promotionThemes.emeraldDay;

  test("no overrides returns base unchanged", () => {
    expect(mergePromotionOverrides(base, null)).toBe(base);
  });

  test("top-level override replaces only the specified field", () => {
    const merged = mergePromotionOverrides(base, { accent: "#FF0000" });
    expect(merged.accent).toBe("#FF0000");
    expect(merged.onSurface).toBe(base.onSurface);
  });

  test("overlay override merges per-field, never wholesale-replacing the sub-object", () => {
    const merged = mergePromotionOverrides(base, { overlay: { opacity: 60 } });
    expect(merged.overlay.opacity).toBe(60);
    expect(merged.overlay.color).toBe(base.overlay.color); // untouched
  });

  test("cta override merges per-field", () => {
    const merged = mergePromotionOverrides(base, { cta: { style: "glass" } });
    expect(merged.cta.style).toBe("glass");
    expect(merged.cta.animation).toBe(base.cta.animation); // untouched
  });

  test("decorations override merges per-type, never wiping sibling decoration types", () => {
    const merged = mergePromotionOverrides(base, { decorations: { sparkles: { enabled: true } } });
    expect(merged.decorations.sparkles.enabled).toBe(true);
    expect(merged.decorations.sparkles.intensity).toBe("medium"); // untouched field on same type
    expect(merged.decorations.confetti).toEqual(base.decorations.confetti); // untouched sibling type
  });
});
