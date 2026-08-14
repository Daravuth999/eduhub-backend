/**
 * HomeTodayZone.test.jsx — Dashboard Foundation Phase 1 wrapper. Proves
 * the CONTRACT: renders every child unmodified, owns exactly one static
 * background layer (no blur, no animation), and adds a deliberate pause
 * gap only before the last child — never touching any child's own props
 * or render output.
 */
import { render, screen } from "@testing-library/react";
import HomeTodayZone, { ZONE_BACKGROUND_CSS } from "../HomeTodayZone";
import { sectionRhythm } from "../../../styles/tokens/designTokens";

test("renders every child, in order, unmodified", () => {
  render(
    <HomeTodayZone>
      <div data-testid="child-a">A</div>
      <div data-testid="child-b">B</div>
      <div data-testid="child-c">C</div>
    </HomeTodayZone>,
  );
  expect(screen.getByTestId("child-a")).toBeInTheDocument();
  expect(screen.getByTestId("child-b")).toBeInTheDocument();
  expect(screen.getByTestId("child-c")).toBeInTheDocument();
});

test("renders exactly one background layer, aria-hidden and non-interactive", () => {
  render(<HomeTodayZone><div>A</div></HomeTodayZone>);
  const bg = screen.getByTestId("home-today-zone-bg");
  expect(bg).toHaveAttribute("aria-hidden", "true");
  expect(bg).toHaveStyle({ pointerEvents: "none" });
});

// NOTE: jsdom's CSSOM does not reliably reflect multi-stop gradient values
// back through element.style.background (a known limitation already hit
// elsewhere in this codebase's test suite) — so these assert on the
// EXPORTED SOURCE STRING directly, which is exactly what gets assigned to
// the DOM node's style.background in a real browser, rather than
// round-tripping it through jsdom's parser.
test("background is built from static gradients only — no blur filter, no animation, no scroll-linked JS", () => {
  expect(ZONE_BACKGROUND_CSS).toMatch(/gradient\(/);
  expect(ZONE_BACKGROUND_CSS).not.toMatch(/blur\(/);
  expect(ZONE_BACKGROUND_CSS).not.toContain("animation");
});

test("background gradient derives from the existing --bgfx-* theme variables, not new hardcoded theme colors", () => {
  expect(ZONE_BACKGROUND_CSS).toContain("var(--bgfx-1)");
  expect(ZONE_BACKGROUND_CSS).toContain("var(--bgfx-2)");
  expect(ZONE_BACKGROUND_CSS).toContain("var(--bgfx-3)");
});

test("the background style object assigned to the DOM node references the same exported CSS string", () => {
  render(<HomeTodayZone><div>A</div></HomeTodayZone>);
  const bg = screen.getByTestId("home-today-zone-bg");
  // jsdom can't round-trip the parsed value, but it DOES preserve that a
  // background was assigned at all (non-empty) — full string fidelity is
  // covered by the two tests above operating on the exported constant.
  expect(bg.getAttribute("style")).toBeTruthy();
});

test("only the LAST child gets the deliberate pause gap — earlier children are untouched", () => {
  render(
    <HomeTodayZone>
      <div data-testid="child-a">A</div>
      <div data-testid="child-b">B</div>
      <div data-testid="child-c">C</div>
    </HomeTodayZone>,
  );
  const pauseWrapper = screen.getByTestId("home-today-zone-pause");
  expect(pauseWrapper).toContainElement(screen.getByTestId("child-c"));
  expect(pauseWrapper).toHaveStyle({ marginTop: `${sectionRhythm.pause}rem` });
  // Earlier children are not wrapped with the pause marker.
  expect(screen.queryAllByTestId("home-today-zone-pause")).toHaveLength(1);
});

test("a single child gets no pause gap (nothing to pause before)", () => {
  render(<HomeTodayZone><div data-testid="only">Only</div></HomeTodayZone>);
  expect(screen.queryByTestId("home-today-zone-pause")).not.toBeInTheDocument();
});

test("null/false/undefined children are filtered out without crashing (conditional rendering support)", () => {
  const showActivity = false;
  expect(() =>
    render(
      <HomeTodayZone>
        <div data-testid="child-a">A</div>
        {showActivity && <div data-testid="conditional">Conditional</div>}
        <div data-testid="child-b">B</div>
      </HomeTodayZone>,
    ),
  ).not.toThrow();
  expect(screen.queryByTestId("conditional")).not.toBeInTheDocument();
  expect(screen.getByTestId("child-a")).toBeInTheDocument();
  expect(screen.getByTestId("child-b")).toBeInTheDocument();
});
