/**
 * TopEarnerPanelConfigDriven.test.jsx — Achievement Experience Studio:
 * TopEarnerPanel consuming a resolved `achievement_top_earner`
 * ExperienceConfig via the new `achievementConfig` prop. Complements
 * TopEarnerPanel.test.jsx (which proves the no-config / Phase E backward-
 * compatible path is unchanged) with the NEW config-driven behavior:
 * preset selection, sync mode, decorations, artwork, trophy/card styling.
 *
 * Leaderboard data itself (useTopEarners) is mocked and untouched by any
 * of this — proving the directive's "do not modify points calculation,
 * rankings, live updates" constraint at the integration level.
 */
import { render, screen } from "@testing-library/react";
import TopEarnerPanel from "../TopEarnerPanel";
import { useTopEarners } from "../../hooks/useTopEarners";
import { useTheme } from "../../pages/portal/hooks/useTheme";
import { achievementThemes } from "../../styles/tokens/achievementThemes";

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
  useTheme.mockReturnValue({ theme: "light" });
});

test("no achievementConfig prop — falls back to Phase E Follow-Welcome behavior unchanged", () => {
  render(<TopEarnerPanel />);
  expect(screen.getByTestId("top-earner-panel")).toHaveAttribute("data-achievement-preset", "emeraldAchievement");
});

test("independent sync mode selects the admin-chosen preset regardless of app theme", () => {
  const config = { appearance: { syncMode: "independent", themeId: "halloween" } };
  render(<TopEarnerPanel achievementConfig={config} />);
  expect(screen.getByTestId("top-earner-panel")).toHaveAttribute("data-achievement-preset", "halloween");
});

test("followWelcome sync mode tracks the app theme even with a themeId set (ignored)", () => {
  const config = { appearance: { syncMode: "followWelcome", themeId: "halloween" } };
  useTheme.mockReturnValue({ theme: "dark" });
  render(<TopEarnerPanel achievementConfig={config} />);
  expect(screen.getByTestId("top-earner-panel")).toHaveAttribute("data-achievement-preset", "midnightAchievement");
});

test("content.visible=false renders nothing (matches Hero's visibility gate)", () => {
  const config = { content: { visible: false }, appearance: {} };
  const { container } = render(<TopEarnerPanel achievementConfig={config} />);
  expect(container.innerHTML).toBe("");
});

test("background artwork renders via the reused HeroArtworkLayer when configured", () => {
  const config = {
    appearance: { syncMode: "independent", themeId: "goldenCelebration",
      artwork: { url: "https://cdn.example/trophy.png", placement: "right", scale: 100, layerOrder: "behindText" } },
  };
  render(<TopEarnerPanel achievementConfig={config} />);
  expect(screen.getByTestId("hero-artwork-image")).toHaveAttribute("src", "https://cdn.example/trophy.png");
});

test("no artwork configured — no artwork layer rendered", () => {
  render(<TopEarnerPanel achievementConfig={{ appearance: { syncMode: "independent", themeId: "graduation" } }} />);
  expect(screen.queryByTestId("hero-artwork-layer")).not.toBeInTheDocument();
});

test("enabled decorations from the resolved preset render inside the panel", () => {
  const config = { appearance: { syncMode: "independent", themeId: "christmas" } }; // snow + seasonalOrnaments + sparkles
  render(<TopEarnerPanel achievementConfig={config} />);
  expect(screen.getByTestId("achievement-decorations")).toBeInTheDocument();
  expect(screen.getByTestId("achievement-decoration-snow")).toBeInTheDocument();
});

test("trophy.style selects the matching icon for rank #1", () => {
  const config = { appearance: { syncMode: "independent", themeId: "graduation" } }; // trophy.style = "medal"
  render(<TopEarnerPanel achievementConfig={config} />);
  expect(screen.getByTestId("top-earner-trophy-icon")).toBeInTheDocument();
});

test("field-level overrides apply on top of the base preset", () => {
  const config = {
    appearance: {
      syncMode: "independent", themeId: "emeraldAchievement",
      overrides: { scoreColor: "#123456" },
    },
  };
  render(<TopEarnerPanel achievementConfig={config} />);
  expect(screen.getByTestId("top-earner-points-1")).toHaveStyle({ color: "#123456" });
});

test("winnerEmphasis=false hides the 'On fire' flame for rank #1", () => {
  const config = {
    appearance: {
      syncMode: "independent", themeId: "emeraldAchievement",
      overrides: { playerCard: { winnerEmphasis: { enabled: false } } },
    },
  };
  render(<TopEarnerPanel achievementConfig={config} />);
  expect(screen.queryByText("On fire")).not.toBeInTheDocument();
});

test("leaderboard data (rank/name/points) is identical regardless of achievementConfig — presentation-only prop", () => {
  const withConfig = render(
    <TopEarnerPanel achievementConfig={{ appearance: { syncMode: "independent", themeId: "halloween" } }} />
  );
  expect(withConfig.getByTestId("top-earner-name-1")).toHaveTextContent("Sok Dara");
  expect(withConfig.getByTestId("top-earner-points-1")).toHaveTextContent("591");
  withConfig.unmount();

  const withoutConfig = render(<TopEarnerPanel />);
  expect(withoutConfig.getByTestId("top-earner-name-1")).toHaveTextContent("Sok Dara");
  expect(withoutConfig.getByTestId("top-earner-points-1")).toHaveTextContent("591");
});

test("every one of the 11 presets renders without crashing", () => {
  Object.keys(achievementThemes).forEach((id) => {
    const { unmount } = render(
      <TopEarnerPanel achievementConfig={{ appearance: { syncMode: "independent", themeId: id } }} />
    );
    expect(screen.getByTestId("top-earner-panel")).toHaveAttribute("data-achievement-preset", id);
    unmount();
  });
});
