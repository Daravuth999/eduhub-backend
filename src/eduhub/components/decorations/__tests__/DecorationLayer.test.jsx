/**
 * DecorationLayer.test.jsx — the shared decoration renderer generalized
 * from AchievementDecorations.jsx (Promotion Experience Studio directive).
 * AchievementDecorations.test.jsx continues to cover the original 10
 * types + the achievement-specific testid contract unchanged (this file
 * is a generalization, not a replacement); this file covers the
 * `testidPrefix` mechanism and the 3 NEW types Promotion adds.
 */
import { render } from "@testing-library/react";
import DecorationLayer from "../DecorationLayer";

const OFF = { enabled: false, intensity: "medium", colorOverride: null };
const ON = { enabled: true, intensity: "medium", colorOverride: null };

test("defaults to testidPrefix='decoration' when not specified", () => {
  const { getByTestId } = render(<DecorationLayer decorations={{ sparkles: ON }} animateEnabled />);
  expect(getByTestId("decoration-decorations")).toBeInTheDocument();
  expect(getByTestId("decoration-decoration-sparkles")).toBeInTheDocument();
});

test("testidPrefix='promotion' produces promotion-scoped test ids", () => {
  const { getByTestId } = render(<DecorationLayer decorations={{ sparkles: ON }} animateEnabled testidPrefix="promotion" />);
  expect(getByTestId("promotion-decorations")).toBeInTheDocument();
  expect(getByTestId("promotion-decoration-sparkles")).toBeInTheDocument();
});

test("renders nothing when decorations is null or every type disabled", () => {
  const { container: c1 } = render(<DecorationLayer decorations={null} animateEnabled testidPrefix="promotion" />);
  expect(c1.innerHTML).toBe("");
  const { container: c2 } = render(<DecorationLayer decorations={{ sparkles: OFF }} animateEnabled testidPrefix="promotion" />);
  expect(c2.innerHTML).toBe("");
});

describe("the 3 new Promotion decoration types", () => {
  test("academicParticles renders as an ambient twinkle layer (survives reduced motion)", () => {
    const { queryByTestId } = render(
      <DecorationLayer decorations={{ academicParticles: ON }} animateEnabled={false} testidPrefix="promotion" />,
    );
    expect(queryByTestId("promotion-decoration-academicParticles")).toBeInTheDocument();
  });

  test("premiumDust renders as an ambient drift layer (survives reduced motion)", () => {
    const { queryByTestId } = render(
      <DecorationLayer decorations={{ premiumDust: ON }} animateEnabled={false} testidPrefix="promotion" />,
    );
    expect(queryByTestId("promotion-decoration-premiumDust")).toBeInTheDocument();
  });

  test("lightRays renders via its own dedicated (non-glyph) branch, and survives reduced motion", () => {
    const { getByTestId } = render(
      <DecorationLayer decorations={{ lightRays: ON }} animateEnabled={false} testidPrefix="promotion" />,
    );
    const layer = getByTestId("promotion-decoration-lightRays");
    expect(layer).toBeInTheDocument();
    expect(layer.querySelectorAll("span").length).toBeGreaterThan(0);
  });

  test("lightRays items use a gradient background, not a text glyph", () => {
    const { getByTestId } = render(
      <DecorationLayer decorations={{ lightRays: ON }} animateEnabled={false} testidPrefix="promotion" />,
    );
    const first = getByTestId("promotion-decoration-lightRays").querySelector("span");
    expect(first.textContent).toBe("");
    expect(first).toHaveStyle({ width: "2px" });
  });
});

test("intensity still controls item count for the new types", () => {
  const low = { premiumDust: { enabled: true, intensity: "low", colorOverride: null } };
  const high = { premiumDust: { enabled: true, intensity: "high", colorOverride: null } };
  const rLow = render(<DecorationLayer decorations={low} animateEnabled testidPrefix="promotion" />);
  const lowCount = rLow.getByTestId("promotion-decoration-premiumDust").querySelectorAll("span").length;
  rLow.unmount();
  const rHigh = render(<DecorationLayer decorations={high} animateEnabled testidPrefix="promotion" />);
  const highCount = rHigh.getByTestId("promotion-decoration-premiumDust").querySelectorAll("span").length;
  expect(highCount).toBeGreaterThan(lowCount);
});

test("decorations are never interactive (pointer-events: none)", () => {
  const { getByTestId } = render(<DecorationLayer decorations={{ sparkles: ON }} animateEnabled testidPrefix="promotion" />);
  expect(getByTestId("promotion-decorations")).toHaveStyle({ pointerEvents: "none" });
});
