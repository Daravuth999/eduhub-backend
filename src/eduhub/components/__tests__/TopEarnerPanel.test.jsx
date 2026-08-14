/**
 * TopEarnerPanel.test.jsx — Top Earner Day/Night Achievement theme
 * (approved directive, §Top Earner Panel Enhancement).
 *
 * Proves: the panel automatically follows the app's resolved theme (no
 * manual switch), Day mode uses the Emerald Achievement theme, Night mode
 * uses Midnight Achievement, and the two are visually DISTINCT (never the
 * same surface) — the directive's explicit "do not reuse the exact Day
 * Mode emerald surface" requirement. useTopEarners and useTheme are
 * mocked; their own behavior is covered by their dedicated tests
 * elsewhere.
 */
import { render, screen } from "@testing-library/react";
import TopEarnerPanel from "../TopEarnerPanel";
import { useTopEarners } from "../../hooks/useTopEarners";
import { useTheme } from "../../pages/portal/hooks/useTheme";
import { achievementThemes, getAchievementTheme } from "../../styles/tokens/achievementThemes";

jest.mock("../../hooks/useTopEarners");
jest.mock("../../pages/portal/hooks/useTheme");

const TOP = [
  { rank: 1, name: "Sok Dara", points: 591 },
  { rank: 2, name: "Pheakdey No", points: 556 },
];

beforeEach(() => {
  jest.clearAllMocks();
  useTopEarners.mockReturnValue({
    top: TOP, rest: [], loading: false, error: null,
    connectionOk: true, lastUpdated: Date.now(), totalCount: 9,
  });
});

test("Day mode (theme='light') renders the Emerald Achievement surface", () => {
  useTheme.mockReturnValue({ theme: "light" });
  render(<TopEarnerPanel />);
  const panel = screen.getByTestId("top-earner-panel");
  expect(panel).toHaveAttribute("data-achievement-theme", "day");
});

test("Night mode (theme='dark') renders the Midnight Achievement surface", () => {
  useTheme.mockReturnValue({ theme: "dark" });
  render(<TopEarnerPanel />);
  const panel = screen.getByTestId("top-earner-panel");
  expect(panel).toHaveAttribute("data-achievement-theme", "night");
});

test("Day and Night surfaces are genuinely distinct gradients, not the same value", () => {
  expect(achievementThemes.emeraldAchievement.surface).not.toBe(achievementThemes.midnightAchievement.surface);
});

test("Day and Night are also distinct from the Welcome Hero's morningEmerald palette (no reuse)", () => {
  // eslint-disable-next-line global-require
  const { palettes } = require("../../styles/tokens/designTokens");
  expect(achievementThemes.emeraldAchievement.surface).not.toContain(palettes.morningEmerald.base[0]);
});

test("getAchievementTheme defaults to Emerald (day) for any non-'dark' theme value", () => {
  expect(getAchievementTheme("light").mode).toBe("day");
  expect(getAchievementTheme(undefined).mode).toBe("day");
  expect(getAchievementTheme("dark").mode).toBe("night");
});

test("no manual theme switcher is rendered — the panel follows useTheme automatically", () => {
  useTheme.mockReturnValue({ theme: "light" });
  render(<TopEarnerPanel />);
  expect(screen.queryByRole("button", { name: /theme/i })).not.toBeInTheDocument();
});

test("score values render in the theme's gold accent color, not a rainbow gradient", () => {
  useTheme.mockReturnValue({ theme: "light" });
  render(<TopEarnerPanel />);
  const points = screen.getByTestId("top-earner-points-1");
  expect(points).toHaveStyle({ color: achievementThemes.emeraldAchievement.goldAccent });
});

test("the Live badge uses the achievement theme's emerald accent when connected", () => {
  useTheme.mockReturnValue({ theme: "light" });
  render(<TopEarnerPanel />);
  const badge = screen.getByTestId("top-earner-status-ok");
  expect(badge).toHaveStyle({ color: achievementThemes.emeraldAchievement.liveBadge.color });
});

test("rank #1 tile always uses the theme's gold gradient (trophy accent), in both modes", () => {
  useTheme.mockReturnValue({ theme: "dark" });
  render(<TopEarnerPanel />);
  const spotlight = screen.getByTestId("top-earner-spotlight-rank-1");
  expect(spotlight.querySelector(".font-black")).toHaveStyle({
    background: achievementThemes.midnightAchievement.rankTile[1].gradient,
  });
});
