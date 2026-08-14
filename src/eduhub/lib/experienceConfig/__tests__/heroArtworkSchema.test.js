import { getArtworkLayout, getDefaultHeroArtwork, getArtworkOverlayStyle, DEFAULT_PADDING } from "../heroArtworkSchema";

describe("getDefaultHeroArtwork", () => {
  it("returns a full, valid default shape with no artwork attached", () => {
    const def = getDefaultHeroArtwork();
    expect(def.url).toBeNull();
    expect(def.layerOrder).toBe("behindText");
    expect(def.placement).toBe("right");
    expect(def.scale).toBe(100);
    expect(def.padding).toEqual(DEFAULT_PADDING);
  });
});

describe("getArtworkLayout", () => {
  it("returns default padding/box when heroArtwork is null", () => {
    const { containerStyle } = getArtworkLayout(null);
    expect(containerStyle.top).toBe(DEFAULT_PADDING.top);
    expect(containerStyle.overflow).toBe("hidden");
  });

  it("merges partial padding with defaults rather than dropping unspecified edges", () => {
    const { containerStyle } = getArtworkLayout({ padding: { top: 40 } });
    expect(containerStyle.top).toBe(40);
    expect(containerStyle.bottom).toBe(DEFAULT_PADDING.bottom);
    expect(containerStyle.left).toBe(DEFAULT_PADDING.left);
  });

  it.each([
    ["left", "flex-start", "center"],
    ["center", "center", "center"],
    ["right", "flex-end", "center"],
    ["topLeft", "flex-start", "flex-start"],
    ["topRight", "flex-end", "flex-start"],
    ["bottomLeft", "flex-start", "flex-end"],
    ["bottomRight", "flex-end", "flex-end"],
  ])("placement=%s maps to justifyContent=%s alignItems=%s", (placement, justify, align) => {
    const { containerStyle } = getArtworkLayout({ placement });
    expect(containerStyle.justifyContent).toBe(justify);
    expect(containerStyle.alignItems).toBe(align);
  });

  it("an unrecognized placement falls back to 'right' rather than crashing", () => {
    const { containerStyle } = getArtworkLayout({ placement: "diagonal-nonsense" });
    expect(containerStyle.justifyContent).toBe("flex-end");
  });

  it("custom placement positions the image absolutely via customX/customY percentages", () => {
    const { imgStyle } = getArtworkLayout({ placement: "custom", customX: 20, customY: 70 });
    expect(imgStyle.position).toBe("absolute");
    expect(imgStyle.left).toBe("20%");
    expect(imgStyle.top).toBe("70%");
  });

  it("custom placement with missing customX/customY defaults to 50/50 (center)", () => {
    const { imgStyle } = getArtworkLayout({ placement: "custom" });
    expect(imgStyle.left).toBe("50%");
    expect(imgStyle.top).toBe("50%");
  });

  it("scale is applied as a CSS transform, never mutating maxWidth/maxHeight (aspect ratio always preserved)", () => {
    const small = getArtworkLayout({ placement: "center", scale: 60 });
    const large = getArtworkLayout({ placement: "center", scale: 150 });
    expect(small.imgStyle.maxWidth).toBe(large.imgStyle.maxWidth);
    expect(small.imgStyle.maxHeight).toBe(large.imgStyle.maxHeight);
    expect(small.imgStyle.transform).toContain("scale(0.6)");
    expect(large.imgStyle.transform).toContain("scale(1.5)");
  });

  it("a non-finite scale falls back to 100% rather than producing NaN in the transform", () => {
    const { imgStyle } = getArtworkLayout({ placement: "center", scale: undefined });
    expect(imgStyle.transform).toContain("scale(1)");
  });

  it("allowOverflow=true switches the container to visible overflow", () => {
    const { containerStyle } = getArtworkLayout({ allowOverflow: true });
    expect(containerStyle.overflow).toBe("visible");
  });

  it("allowOverflow defaults to false (clipped) when unspecified", () => {
    const { containerStyle } = getArtworkLayout({});
    expect(containerStyle.overflow).toBe("hidden");
  });

  it("the artwork layer never intercepts pointer events, so it can never block clicks on Hero content", () => {
    const { containerStyle } = getArtworkLayout({ placement: "center" });
    expect(containerStyle.pointerEvents).toBe("none");
  });
});

// Promotion Experience Studio (Phase 1-5) — additive effects fields. Every
// existing Hero/Achievement config never sets these, so imgStyle must come
// out byte-identical to before this directive when they're absent.
describe("getArtworkLayout — additive effects (Promotion Experience Studio)", () => {
  it("no filter/opacity fields set -> imgStyle has no filter/opacity keys at all (backward compatible)", () => {
    const { imgStyle } = getArtworkLayout({ placement: "right" });
    expect(imgStyle.filter).toBeUndefined();
    expect(imgStyle.opacity).toBeUndefined();
  });

  it("brightness/contrast/blur combine into one CSS filter string", () => {
    const { imgStyle } = getArtworkLayout({ placement: "right", brightness: 120, contrast: 90, blur: 4 });
    expect(imgStyle.filter).toBe("brightness(120%) contrast(90%) blur(4px)");
  });

  it("brightness/contrast at neutral (100) are omitted from the filter string", () => {
    const { imgStyle } = getArtworkLayout({ placement: "right", brightness: 100, contrast: 100, blur: 0 });
    expect(imgStyle.filter).toBeUndefined();
  });

  it("opacity is normalized to a 0-1 CSS value and clamped to [0,100] input range", () => {
    const { imgStyle } = getArtworkLayout({ placement: "right", opacity: 60 });
    expect(imgStyle.opacity).toBe(0.6);
  });

  it("opacity at 100 (neutral) is omitted, matching the no-op contract", () => {
    const { imgStyle } = getArtworkLayout({ placement: "right", opacity: 100 });
    expect(imgStyle.opacity).toBeUndefined();
  });

  it("effects also apply on the custom-placement branch", () => {
    const { imgStyle } = getArtworkLayout({ placement: "custom", blur: 8 });
    expect(imgStyle.filter).toBe("blur(8px)");
    expect(imgStyle.position).toBe("absolute"); // custom-branch fields still present
  });
});

describe("getArtworkOverlayStyle", () => {
  it("returns null when neither overlay nor gradientOverlay is enabled", () => {
    expect(getArtworkOverlayStyle({})).toBeNull();
    expect(getArtworkOverlayStyle(null)).toBeNull();
  });

  it("flat overlay color renders a background + opacity", () => {
    const style = getArtworkOverlayStyle({ overlay: { enabled: true, color: "#000000", opacity: 50 } });
    expect(style.background).toBe("#000000");
    expect(style.opacity).toBe(0.5);
  });

  it("overlay opacity defaults to 40% when unspecified", () => {
    const style = getArtworkOverlayStyle({ overlay: { enabled: true, color: "#000000" } });
    expect(style.opacity).toBe(0.4);
  });

  it("gradientOverlay wins over a flat overlay color when both are enabled", () => {
    const style = getArtworkOverlayStyle({
      overlay: { enabled: true, color: "#000000", opacity: 50 },
      gradientOverlay: { enabled: true, css: "linear-gradient(180deg, transparent, black)" },
    });
    expect(style.background).toBe("linear-gradient(180deg, transparent, black)");
    expect(style.opacity).toBeUndefined();
  });

  it("the overlay never intercepts pointer events", () => {
    const style = getArtworkOverlayStyle({ overlay: { enabled: true, color: "#fff" } });
    expect(style.pointerEvents).toBe("none");
  });
});
