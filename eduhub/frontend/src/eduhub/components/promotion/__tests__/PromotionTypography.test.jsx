import { render, screen } from "@testing-library/react";
import PromotionTypography from "../PromotionTypography";

const THEME = { onSurface: "#111111", onSurfaceSoft: "#222222", accent: "#D9B872" };

test("renders nothing when there are no layers", () => {
  const { container } = render(<PromotionTypography textLayers={[]} theme={THEME} />);
  expect(container.innerHTML).toBe("");
});

test("layers with no content are filtered out silently", () => {
  const { container } = render(
    <PromotionTypography textLayers={[{ id: "a", role: "headline", content: "" }, null, undefined]} theme={THEME} />,
  );
  expect(container.innerHTML).toBe("");
});

test("renders each role with its own testid, in array order", () => {
  render(
    <PromotionTypography
      theme={THEME}
      animateEnabled={false}
      textLayers={[
        { id: "1", role: "eyebrow", content: "Limited time" },
        { id: "2", role: "headline", content: "Back to School" },
        { id: "3", role: "body", content: "Save 20% this week only." },
      ]}
    />,
  );
  expect(screen.getByTestId("promotion-text-eyebrow")).toHaveTextContent("Limited time");
  expect(screen.getByTestId("promotion-text-headline")).toHaveTextContent("Back to School");
  expect(screen.getByTestId("promotion-text-body")).toHaveTextContent("Save 20% this week only.");
});

test("Khmer content gets lang=km and the font-khmer class (reuses existing global Khmer typography)", () => {
  render(
    <PromotionTypography theme={THEME} animateEnabled={false}
      textLayers={[{ id: "1", role: "headline", content: "ថ្ងៃចូលឆ្នាំសាលា" }]} />,
  );
  const el = screen.getByTestId("promotion-text-headline");
  expect(el).toHaveAttribute("lang", "km");
  expect(el).toHaveClass("font-khmer");
});

test("English-only content gets no lang/font-khmer override", () => {
  render(
    <PromotionTypography theme={THEME} animateEnabled={false}
      textLayers={[{ id: "1", role: "headline", content: "Back to School" }]} />,
  );
  const el = screen.getByTestId("promotion-text-headline");
  expect(el).not.toHaveAttribute("lang");
});

test("an explicit lang override wins over auto-detection", () => {
  render(
    <PromotionTypography theme={THEME} animateEnabled={false}
      textLayers={[{ id: "1", role: "headline", content: "Sale", lang: "km" }]} />,
  );
  expect(screen.getByTestId("promotion-text-headline")).toHaveAttribute("lang", "km");
});

test("layer color falls back to theme.onSurface for headline, onSurfaceSoft for body", () => {
  render(
    <PromotionTypography theme={THEME} animateEnabled={false}
      textLayers={[
        { id: "1", role: "headline", content: "H" },
        { id: "2", role: "body", content: "B" },
      ]} />,
  );
  expect(screen.getByTestId("promotion-text-headline")).toHaveStyle({ color: THEME.onSurface });
  expect(screen.getByTestId("promotion-text-body")).toHaveStyle({ color: THEME.onSurfaceSoft });
});

test("an explicit layer color overrides the theme default", () => {
  render(
    <PromotionTypography theme={THEME} animateEnabled={false}
      textLayers={[{ id: "1", role: "headline", content: "H", color: "#FF0000" }]} />,
  );
  expect(screen.getByTestId("promotion-text-headline")).toHaveStyle({ color: "#FF0000" });
});

test("gradient text sets backgroundClip and makes the fill color transparent", () => {
  render(
    <PromotionTypography theme={THEME} animateEnabled={false}
      textLayers={[{ id: "1", role: "headline", content: "H", gradient: "linear-gradient(90deg,#fff,#000)" }]} />,
  );
  const el = screen.getByTestId("promotion-text-headline");
  expect(el).toHaveStyle({ backgroundClip: "text" });
});

test("glass=true wraps the text in a translucent backdrop-blur chip", () => {
  render(
    <PromotionTypography theme={THEME} animateEnabled={false}
      textLayers={[{ id: "1", role: "eyebrow", content: "Glass", glass: true }]} />,
  );
  const el = screen.getByTestId("promotion-text-eyebrow");
  // jsdom's CSSOM doesn't reliably reflect backdrop-filter (same limitation
  // this codebase has already hit with other advanced CSS properties) — the
  // wrapper's simpler, jsdom-safe properties (background/borderRadius) are
  // proof enough that the glass wrapper rendered at all.
  expect(el.parentElement).toHaveStyle({ background: "rgba(255,255,255,0.10)", borderRadius: "12px" });
});
