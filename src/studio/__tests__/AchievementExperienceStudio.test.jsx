/**
 * AchievementExperienceStudio.test.jsx — Author Studio "Top Earner
 * Configuration Platform" management screen. Mocks ./api entirely
 * (network layer covered by the backend's own experience-config tests)
 * plus TopEarnerPanel's own data hooks (useTopEarners/useTheme) so the
 * live preview renders deterministically. Asserts on the UI's CONTRACT:
 * lists configs scoped to achievement_top_earner, creates/edits via the
 * real API functions, exposes preset/decoration/trophy/card/scheduling
 * controls, and its live preview renders the real TopEarnerPanel.
 */
import { render, screen, fireEvent, waitFor, within } from "@testing-library/react";
import AchievementExperienceStudio from "../AchievementExperienceStudio";
import * as api from "../api";
import { useTopEarners } from "../../eduhub/hooks/useTopEarners";
import { useTheme } from "../../eduhub/pages/portal/hooks/useTheme";

jest.mock("../api", () => ({
  listExperienceConfigs: jest.fn(),
  createExperienceConfig: jest.fn(),
  updateExperienceConfig: jest.fn(),
  publishExperienceConfig: jest.fn(),
  unpublishExperienceConfig: jest.fn(),
  duplicateExperienceConfig: jest.fn(),
  deleteExperienceConfig: jest.fn(),
  uploadHeroArtwork: jest.fn(),
  listHeroArtworkLibrary: jest.fn(),
  deleteHeroArtworkAsset: jest.fn(),
}));

jest.mock("../../eduhub/hooks/useTopEarners");
jest.mock("../../eduhub/pages/portal/hooks/useTheme");

const DRAFT_CONFIG = {
  id: "ach-1",
  experienceType: "achievement_top_earner",
  key: "default",
  status: "draft",
  version: 1,
  updatedAt: "2026-01-01T00:00:00Z",
  content: { visible: true },
  appearance: { syncMode: "followWelcome", themeId: "emeraldAchievement", overrides: {}, artwork: null },
  activeWindow: { startsAt: null, endsAt: null, recurringAnnual: false },
};

const PUBLISHED_KNY = {
  ...DRAFT_CONFIG, id: "ach-2", key: "khmer-new-year", status: "published",
  appearance: { syncMode: "independent", themeId: "khmerNewYear", overrides: {}, artwork: null },
  activeWindow: { startsAt: "2026-04-13T00:00:00Z", endsAt: "2026-04-16T23:59:00Z", recurringAnnual: true },
};

beforeEach(() => {
  jest.clearAllMocks();
  api.listExperienceConfigs.mockResolvedValue({ configs: [] });
  useTopEarners.mockReturnValue({
    top: [{ rank: 1, name: "Sok Dara", points: 591 }], rest: [], loading: false, error: null,
    connectionOk: true, lastUpdated: Date.now(), totalCount: 1,
  });
  useTheme.mockReturnValue({ theme: "light" });
});

test("loads and lists configs scoped to achievement_top_earner on mount", async () => {
  api.listExperienceConfigs.mockResolvedValue({ configs: [DRAFT_CONFIG] });
  render(<AchievementExperienceStudio />);
  await waitFor(() => expect(api.listExperienceConfigs).toHaveBeenCalledWith("achievement_top_earner"));
  expect(await screen.findByTestId(`achievementexp-row-${DRAFT_CONFIG.id}`)).toBeInTheDocument();
});

test("shows an empty state explaining the Day/Night auto-fallback when no configs exist", async () => {
  render(<AchievementExperienceStudio />);
  expect(await screen.findByTestId("achievementexp-empty")).toHaveTextContent(/Day\/Night theme/i);
});

test("draft configs show a Draft badge, published show Live, recurring windows show a Recurring badge", async () => {
  api.listExperienceConfigs.mockResolvedValue({ configs: [DRAFT_CONFIG, PUBLISHED_KNY] });
  render(<AchievementExperienceStudio />);
  const draftRow = await screen.findByTestId(`achievementexp-row-${DRAFT_CONFIG.id}`);
  const knyRow = await screen.findByTestId(`achievementexp-row-${PUBLISHED_KNY.id}`);
  expect(within(draftRow).getByText("Draft")).toBeInTheDocument();
  expect(within(knyRow).getByText("Live")).toBeInTheDocument();
  expect(within(knyRow).getByText("Recurring")).toBeInTheDocument();
  expect(within(draftRow).queryByText("Recurring")).not.toBeInTheDocument();
});

test("New config opens a form defaulting to Follow Welcome Theme sync mode (no preset grid shown)", async () => {
  render(<AchievementExperienceStudio />);
  fireEvent.click(await screen.findByTestId("achievementexp-new"));

  expect(screen.getByTestId("achievementexp-syncmode-followWelcome")).toHaveAttribute("aria-pressed", "true");
  expect(screen.queryByTestId("achievementexp-preset-grid")).not.toBeInTheDocument();
});

test("switching to Independent Theme reveals the preset grid with all 11 presets", async () => {
  render(<AchievementExperienceStudio />);
  fireEvent.click(await screen.findByTestId("achievementexp-new"));
  fireEvent.click(screen.getByTestId("achievementexp-syncmode-independent"));

  const grid = screen.getByTestId("achievementexp-preset-grid");
  expect(within(grid).getByTestId("achievementexp-preset-halloween")).toBeInTheDocument();
  expect(within(grid).getByTestId("achievementexp-preset-khmerNewYear")).toBeInTheDocument();
  expect(within(grid).getAllByRole("button")).toHaveLength(11);
});

test("all 10 decoration toggles are exposed, each independently", async () => {
  render(<AchievementExperienceStudio />);
  fireEvent.click(await screen.findByTestId("achievementexp-new"));

  const types = ["confetti", "stars", "sparkles", "fireworks", "snow", "lanterns", "balloons", "flowers", "ribbons", "seasonalOrnaments"];
  types.forEach((t) => {
    expect(screen.getByTestId(`achievementexp-decoration-toggle-${t}`)).toBeInTheDocument();
  });
});

test("toggling a decoration on reveals its intensity selector", async () => {
  render(<AchievementExperienceStudio />);
  fireEvent.click(await screen.findByTestId("achievementexp-new"));

  expect(screen.queryByTestId("achievementexp-decoration-intensity-confetti")).not.toBeInTheDocument();
  fireEvent.click(screen.getByTestId("achievementexp-decoration-toggle-confetti"));
  expect(screen.getByTestId("achievementexp-decoration-intensity-confetti")).toBeInTheDocument();
});

test("trophy style/medal/animation/color controls are present", async () => {
  render(<AchievementExperienceStudio />);
  fireEvent.click(await screen.findByTestId("achievementexp-new"));

  expect(screen.getByTestId("achievementexp-trophy-style").tagName).toBe("SELECT");
  expect(screen.getByTestId("achievementexp-trophy-medal").tagName).toBe("SELECT");
  expect(screen.getByTestId("achievementexp-trophy-animation").tagName).toBe("SELECT");
  expect(screen.getByTestId("achievementexp-trophy-color")).toHaveAttribute("type", "color");
});

test("player card shape/border controls are present", async () => {
  render(<AchievementExperienceStudio />);
  fireEvent.click(await screen.findByTestId("achievementexp-new"));

  expect(screen.getByTestId("achievementexp-card-shape").tagName).toBe("SELECT");
  expect(screen.getByTestId("achievementexp-card-border").tagName).toBe("SELECT");
});

test("the Hero Artwork panel is reused for background artwork (no duplicate upload UI)", async () => {
  render(<AchievementExperienceStudio />);
  fireEvent.click(await screen.findByTestId("achievementexp-new"));
  expect(screen.getByTestId("hero-artwork-panel")).toBeInTheDocument();
});

test("selecting a seasonal preset with a suggested schedule shows a one-click 'use suggested dates' action", async () => {
  render(<AchievementExperienceStudio />);
  fireEvent.click(await screen.findByTestId("achievementexp-new"));
  fireEvent.click(screen.getByTestId("achievementexp-syncmode-independent"));
  fireEvent.click(screen.getByTestId("achievementexp-preset-khmerNewYear"));

  const suggestBtn = screen.getByTestId("achievementexp-use-suggested-dates");
  fireEvent.click(suggestBtn);

  expect(screen.getByTestId("achievementexp-starts-at").value).toMatch(/-04-13T/);
  expect(screen.getByTestId("achievementexp-ends-at").value).toMatch(/-04-16T/);
  expect(screen.getByTestId("achievementexp-recurring-annual")).toHaveTextContent(/Repeat every year/i);
});

test("a non-seasonal preset shows no 'use suggested dates' shortcut", async () => {
  render(<AchievementExperienceStudio />);
  fireEvent.click(await screen.findByTestId("achievementexp-new"));
  fireEvent.click(screen.getByTestId("achievementexp-syncmode-independent"));
  fireEvent.click(screen.getByTestId("achievementexp-preset-goldenCelebration"));

  expect(screen.queryByTestId("achievementexp-use-suggested-dates")).not.toBeInTheDocument();
});

test("recurring-annual checkbox toggles independently of the date fields", async () => {
  render(<AchievementExperienceStudio />);
  fireEvent.click(await screen.findByTestId("achievementexp-new"));

  const toggle = screen.getByTestId("achievementexp-recurring-annual");
  expect(toggle).toHaveTextContent("Repeat every year");
  fireEvent.click(toggle);
  // Toggled without crashing / without requiring dates to be set first.
  expect(toggle).toBeInTheDocument();
});

test("creating a config calls createExperienceConfig with syncMode, preset, and scheduling incl. recurringAnnual", async () => {
  api.createExperienceConfig.mockResolvedValue({ config: DRAFT_CONFIG });
  render(<AchievementExperienceStudio />);
  fireEvent.click(await screen.findByTestId("achievementexp-new"));

  fireEvent.click(screen.getByTestId("achievementexp-syncmode-independent"));
  fireEvent.click(screen.getByTestId("achievementexp-preset-halloween"));
  fireEvent.click(screen.getByTestId("achievementexp-recurring-annual"));
  fireEvent.click(screen.getByTestId("achievementexp-save"));

  await waitFor(() => expect(api.createExperienceConfig).toHaveBeenCalledTimes(1));
  const payload = api.createExperienceConfig.mock.calls[0][0];
  expect(payload.experienceType).toBe("achievement_top_earner");
  expect(payload.appearance.syncMode).toBe("independent");
  expect(payload.appearance.themeId).toBe("halloween");
  expect(payload.activeWindow.recurringAnnual).toBe(true);
});

test("editing an existing config calls updateExperienceConfig with its id, not createExperienceConfig", async () => {
  api.listExperienceConfigs.mockResolvedValue({ configs: [DRAFT_CONFIG] });
  api.updateExperienceConfig.mockResolvedValue({ config: DRAFT_CONFIG });
  render(<AchievementExperienceStudio />);

  fireEvent.click(await screen.findByTestId(`achievementexp-edit-${DRAFT_CONFIG.id}`));
  fireEvent.click(await screen.findByTestId("achievementexp-save"));

  await waitFor(() => expect(api.updateExperienceConfig).toHaveBeenCalledWith(DRAFT_CONFIG.id, expect.any(Object)));
  expect(api.createExperienceConfig).not.toHaveBeenCalled();
});

test("Publish/Unpublish/Duplicate/Delete all call the shared generic experience-config API with the row's id", async () => {
  api.listExperienceConfigs.mockResolvedValue({ configs: [DRAFT_CONFIG, PUBLISHED_KNY] });
  api.publishExperienceConfig.mockResolvedValue({ config: DRAFT_CONFIG });
  api.unpublishExperienceConfig.mockResolvedValue({ config: PUBLISHED_KNY });
  api.duplicateExperienceConfig.mockResolvedValue({ config: { ...DRAFT_CONFIG, id: "ach-3" } });
  api.deleteExperienceConfig.mockResolvedValue({ ok: true });
  render(<AchievementExperienceStudio />);

  fireEvent.click(await screen.findByTestId(`achievementexp-publish-${DRAFT_CONFIG.id}`));
  await waitFor(() => expect(api.publishExperienceConfig).toHaveBeenCalledWith(DRAFT_CONFIG.id));

  fireEvent.click(screen.getByTestId(`achievementexp-unpublish-${PUBLISHED_KNY.id}`));
  await waitFor(() => expect(api.unpublishExperienceConfig).toHaveBeenCalledWith(PUBLISHED_KNY.id));

  fireEvent.click(screen.getByTestId(`achievementexp-duplicate-${DRAFT_CONFIG.id}`));
  await waitFor(() => expect(api.duplicateExperienceConfig).toHaveBeenCalledWith(DRAFT_CONFIG.id));

  fireEvent.click(screen.getByTestId(`achievementexp-delete-${DRAFT_CONFIG.id}`));
  fireEvent.click(screen.getByTestId(`achievementexp-delete-confirm-${DRAFT_CONFIG.id}`));
  await waitFor(() => expect(api.deleteExperienceConfig).toHaveBeenCalledWith(DRAFT_CONFIG.id, { force: false }));
});

test("live preview renders the real TopEarnerPanel reflecting the current preset", async () => {
  render(<AchievementExperienceStudio />);
  fireEvent.click(await screen.findByTestId("achievementexp-new"));
  fireEvent.click(screen.getByTestId("achievementexp-syncmode-independent"));
  fireEvent.click(screen.getByTestId("achievementexp-preset-christmas"));

  const preview = screen.getByTestId("achievementexp-preview");
  const panel = within(preview).getByTestId("top-earner-panel");
  expect(panel).toHaveAttribute("data-achievement-preset", "christmas");
  // The REAL live leaderboard data is shown — not a mock-up.
  expect(within(preview).getByTestId("top-earner-name-1")).toHaveTextContent("Sok Dara");
});
