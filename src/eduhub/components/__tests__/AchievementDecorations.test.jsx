/**
 * AchievementDecorations.test.jsx — 10 independently-toggleable decoration
 * types, reduced-motion contract (burst effects suppressed entirely,
 * ambient effects render statically), deterministic layout (no reshuffle
 * on re-render).
 */
import { render } from "@testing-library/react";
import AchievementDecorations from "../AchievementDecorations";
import { DECORATION_TYPES } from "../../styles/tokens/achievementThemes";

const ALL_OFF = Object.fromEntries(DECORATION_TYPES.map((t) => [t, { enabled: false, intensity: "medium", colorOverride: null }]));

function withEnabled(...types) {
  const d = { ...ALL_OFF };
  types.forEach((t) => { d[t] = { enabled: true, intensity: "medium", colorOverride: null }; });
  return d;
}

test("renders nothing when decorations is null/absent", () => {
  const { container } = render(<AchievementDecorations decorations={null} animateEnabled />);
  expect(container.innerHTML).toBe("");
});

test("renders nothing when every decoration is disabled", () => {
  const { container } = render(<AchievementDecorations decorations={ALL_OFF} animateEnabled />);
  expect(container.innerHTML).toBe("");
});

test("only the ENABLED decoration types render, each independently", () => {
  const { queryByTestId } = render(
    <AchievementDecorations decorations={withEnabled("confetti", "snow")} animateEnabled />
  );
  expect(queryByTestId("achievement-decoration-confetti")).toBeInTheDocument();
  expect(queryByTestId("achievement-decoration-snow")).toBeInTheDocument();
  expect(queryByTestId("achievement-decoration-stars")).not.toBeInTheDocument();
  expect(queryByTestId("achievement-decoration-fireworks")).not.toBeInTheDocument();
});

test("all 10 decoration types are independently renderable", () => {
  DECORATION_TYPES.forEach((type) => {
    const { queryByTestId, unmount } = render(
      <AchievementDecorations decorations={withEnabled(type)} animateEnabled />
    );
    expect(queryByTestId(`achievement-decoration-${type}`)).toBeInTheDocument();
    unmount();
  });
});

describe("reduced motion contract", () => {
  test("burst-only effects (confetti, fireworks, balloons) render NOTHING when animateEnabled=false", () => {
    const { queryByTestId } = render(
      <AchievementDecorations decorations={withEnabled("confetti", "fireworks", "balloons")} animateEnabled={false} />
    );
    expect(queryByTestId("achievement-decoration-confetti")).not.toBeInTheDocument();
    expect(queryByTestId("achievement-decoration-fireworks")).not.toBeInTheDocument();
    expect(queryByTestId("achievement-decoration-balloons")).not.toBeInTheDocument();
  });

  test("ambient effects (stars, snow, lanterns) still render statically when animateEnabled=false", () => {
    const { queryByTestId } = render(
      <AchievementDecorations decorations={withEnabled("stars", "snow", "lanterns")} animateEnabled={false} />
    );
    expect(queryByTestId("achievement-decoration-stars")).toBeInTheDocument();
    expect(queryByTestId("achievement-decoration-snow")).toBeInTheDocument();
    expect(queryByTestId("achievement-decoration-lanterns")).toBeInTheDocument();
  });
});

test("intensity controls item count (high renders more items than low)", () => {
  const low = { ...ALL_OFF, sparkles: { enabled: true, intensity: "low", colorOverride: null } };
  const high = { ...ALL_OFF, sparkles: { enabled: true, intensity: "high", colorOverride: null } };
  const rLow = render(<AchievementDecorations decorations={low} animateEnabled />);
  const lowCount = rLow.getByTestId("achievement-decoration-sparkles").querySelectorAll("span").length;
  rLow.unmount();

  const rHigh = render(<AchievementDecorations decorations={high} animateEnabled />);
  const highCount = rHigh.getByTestId("achievement-decoration-sparkles").querySelectorAll("span").length;
  expect(highCount).toBeGreaterThan(lowCount);
});

test("colorOverride is applied to rendered items when set", () => {
  const d = { ...ALL_OFF, stars: { enabled: true, intensity: "low", colorOverride: "#FF8C28" } };
  const { getByTestId } = render(<AchievementDecorations decorations={d} animateEnabled={false} />);
  const first = getByTestId("achievement-decoration-stars").querySelector("span");
  expect(first).toHaveStyle({ color: "#FF8C28" });
});

test("layout is deterministic — two renders of the same config produce the same item positions", () => {
  const d = withEnabled("sparkles");
  const a = render(<AchievementDecorations decorations={d} animateEnabled />);
  const posA = Array.from(a.getByTestId("achievement-decoration-sparkles").querySelectorAll("span")).map((el) => el.style.left);
  a.unmount();

  const b = render(<AchievementDecorations decorations={d} animateEnabled />);
  const posB = Array.from(b.getByTestId("achievement-decoration-sparkles").querySelectorAll("span")).map((el) => el.style.left);
  expect(posA).toEqual(posB);
});

test("decorations are never interactive (pointer-events: none)", () => {
  const { getByTestId } = render(<AchievementDecorations decorations={withEnabled("stars")} animateEnabled />);
  expect(getByTestId("achievement-decorations")).toHaveStyle({ pointerEvents: "none" });
});
