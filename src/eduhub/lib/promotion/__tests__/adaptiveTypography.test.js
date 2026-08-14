import { detectScript, getAdaptiveFontSize, getAdaptiveLineHeight, getSafeWrapStyle } from "../adaptiveTypography";

describe("detectScript", () => {
  test("pure English -> en", () => {
    expect(detectScript("Back to School Sale")).toBe("en");
  });

  test("pure Khmer -> km", () => {
    expect(detectScript("ថ្ងៃចូលឆ្នាំសាលា")).toBe("km");
  });

  test("mixed Khmer + English -> mixed", () => {
    expect(detectScript("Sale ថ្ងៃនេះ 50% Off")).toBe("mixed");
  });

  test("empty/falsy content defaults to en without throwing", () => {
    expect(detectScript("")).toBe("en");
    expect(detectScript(null)).toBe("en");
    expect(detectScript(undefined)).toBe("en");
  });

  test("numbers/punctuation only -> en (no false Khmer positive)", () => {
    expect(detectScript("50% — 2026")).toBe("en");
  });
});

describe("getAdaptiveFontSize", () => {
  test("returns a clamp() expression for every known role", () => {
    ["eyebrow", "headline", "subhead", "body"].forEach((role) => {
      expect(getAdaptiveFontSize(role)).toMatch(/^clamp\(/);
    });
  });

  test("unknown role falls back to body sizing", () => {
    expect(getAdaptiveFontSize("nonsense")).toBe(getAdaptiveFontSize("body"));
  });

  test("headline is visually larger than body at every clamp stop", () => {
    const headline = getAdaptiveFontSize("headline");
    const body = getAdaptiveFontSize("body");
    // clamp(min, preferred-vw, max) — only the min/max args are in rem, the
    // preferred arg is in vw, so exactly 2 "rem" numbers per clamp string.
    const nums = (s) => s.match(/[\d.]+rem/g).map(parseFloat);
    const [hMin, hMax] = nums(headline);
    const [bMin, bMax] = nums(body);
    expect(hMin).toBeGreaterThan(bMin);
    expect(hMax).toBeGreaterThan(bMax);
  });
});

describe("getAdaptiveLineHeight", () => {
  test("Khmer and mixed content get the taller 1.7 line-height (matches index.css :lang(km))", () => {
    expect(getAdaptiveLineHeight("km")).toBe(1.7);
    expect(getAdaptiveLineHeight("mixed")).toBe(1.7);
  });
  test("English-only content gets the tighter 1.3 line-height", () => {
    expect(getAdaptiveLineHeight("en")).toBe(1.3);
  });
});

describe("getSafeWrapStyle", () => {
  test("word-break stays 'normal' — never 'break-all' (would clip Khmer glyph clusters)", () => {
    const { style } = getSafeWrapStyle("headline", "ថ្ងៃចូលឆ្នាំសាលា");
    expect(style.wordBreak).toBe("normal");
  });

  test("overflow-wrap is 'anywhere' as the safety net for unbreakable tokens", () => {
    const { style } = getSafeWrapStyle("body", "hello");
    expect(style.overflowWrap).toBe("anywhere");
  });

  test("returns the detected script alongside the style so the caller can set lang/font-khmer", () => {
    const { script } = getSafeWrapStyle("headline", "ថ្ងៃចូលឆ្នាំសាលា");
    expect(script).toBe("km");
  });

  test("maxLines adds a webkit line-clamp without breaking when unset", () => {
    const clamped = getSafeWrapStyle("body", "long text", 2);
    expect(clamped.style.WebkitLineClamp).toBe(2);
    expect(clamped.style.overflow).toBe("hidden");

    const unclamped = getSafeWrapStyle("body", "long text");
    expect(unclamped.style.WebkitLineClamp).toBeUndefined();
  });
});
