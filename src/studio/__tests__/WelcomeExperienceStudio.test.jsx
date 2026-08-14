/**
 * WelcomeExperienceStudio.test.jsx — Author Studio Phase 3 management
 * screen. Mocks ./api entirely (network layer already covered by the
 * backend's own test_experience_config_admin_crud.py) and asserts on the
 * UI's CONTRACT: it lists configs, creates/edits via the real API
 * functions (not ad-hoc fetch calls), never exposes free-text fields for
 * anything that should be a token picker, and its live preview renders
 * the real Hero component rather than a bespoke mock-up.
 */
import { render, screen, fireEvent, waitFor, within } from "@testing-library/react";
import WelcomeExperienceStudio from "../WelcomeExperienceStudio";
import * as api from "../api";

jest.mock("../api", () => ({
  listExperienceConfigs: jest.fn(),
  createExperienceConfig: jest.fn(),
  updateExperienceConfig: jest.fn(),
  publishExperienceConfig: jest.fn(),
  unpublishExperienceConfig: jest.fn(),
  duplicateExperienceConfig: jest.fn(),
  deleteExperienceConfig: jest.fn(),
  // Hero Artwork enhancement — HeroArtworkPanel (rendered inside the form)
  // imports these; unused by tests below that never interact with it, but
  // must exist so the module import itself doesn't resolve to undefined.
  uploadHeroArtwork: jest.fn(),
  listHeroArtworkLibrary: jest.fn(),
  deleteHeroArtworkAsset: jest.fn(),
}));

const DRAFT_CONFIG = {
  id: "cfg-1",
  experienceType: "welcome_dashboard",
  key: "default",
  status: "draft",
  version: 1,
  updatedAt: "2026-01-01T00:00:00Z",
  content: { title: "My Draft Title", badge: "", khmerSubtitle: "", description: "", instructorLine: "", visible: true },
  appearance: { paletteId: "morningEmerald", radiusId: "lg" },
  motion: { presetId: "cinematicRise", lightingId: "sunrise", particlesId: "sparseStars" },
  playback: { firstLaunchOfDay: true, firstLaunchPerSession: true, replayIntervalHours: 6 },
  activeWindow: { startsAt: null, endsAt: null },
};

const PUBLISHED_CONFIG = { ...DRAFT_CONFIG, id: "cfg-2", key: "seasonal", status: "published", content: { ...DRAFT_CONFIG.content, title: "Live Title" } };

beforeEach(() => {
  jest.clearAllMocks();
  api.listExperienceConfigs.mockResolvedValue({ configs: [] });
});

test("loads and lists configs scoped to welcome_dashboard on mount", async () => {
  api.listExperienceConfigs.mockResolvedValue({ configs: [DRAFT_CONFIG] });
  render(<WelcomeExperienceStudio />);
  await waitFor(() => expect(api.listExperienceConfigs).toHaveBeenCalledWith("welcome_dashboard"));
  expect(await screen.findByText("My Draft Title")).toBeInTheDocument();
});

test("shows an empty state and explains the legacy Sheets fallback when no configs exist", async () => {
  render(<WelcomeExperienceStudio />);
  expect(await screen.findByTestId("welcomeexp-empty")).toHaveTextContent(/legacy Google Sheets/i);
});

test("draft configs show a Draft badge, published configs show a Live badge", async () => {
  api.listExperienceConfigs.mockResolvedValue({ configs: [DRAFT_CONFIG, PUBLISHED_CONFIG] });
  render(<WelcomeExperienceStudio />);
  const draftRow = await screen.findByTestId(`welcomeexp-row-${DRAFT_CONFIG.id}`);
  const liveRow = await screen.findByTestId(`welcomeexp-row-${PUBLISHED_CONFIG.id}`);
  expect(within(draftRow).getByText("Draft")).toBeInTheDocument();
  expect(within(liveRow).getByText("Live")).toBeInTheDocument();
});

test("New config opens a form with token-bound pickers, not free-text fields, for appearance/motion", async () => {
  render(<WelcomeExperienceStudio />);
  fireEvent.click(await screen.findByTestId("welcomeexp-new"));

  const palette = screen.getByTestId("welcomeexp-palette");
  const preset = screen.getByTestId("welcomeexp-preset");
  const lighting = screen.getByTestId("welcomeexp-lighting");
  const particles = screen.getByTestId("welcomeexp-particles");
  [palette, preset, lighting, particles].forEach((el) => expect(el.tagName).toBe("SELECT"));

  // Options are token ids, not arbitrary — every option value must be a
  // real key from the platform's token modules.
  const paletteValues = within(palette).getAllByRole("option").map((o) => o.value);
  expect(paletteValues).toEqual(expect.arrayContaining(["morningEmerald", "auroraNight"]));
});

test("creating a config calls createExperienceConfig with the entered title and current pickers", async () => {
  api.createExperienceConfig.mockResolvedValue({ config: DRAFT_CONFIG });
  render(<WelcomeExperienceStudio />);
  fireEvent.click(await screen.findByTestId("welcomeexp-new"));

  fireEvent.change(screen.getByTestId("welcomeexp-title"), { target: { value: "Fresh Title" } });
  fireEvent.click(screen.getByTestId("welcomeexp-save"));

  await waitFor(() => expect(api.createExperienceConfig).toHaveBeenCalledTimes(1));
  const payload = api.createExperienceConfig.mock.calls[0][0];
  expect(payload.experienceType).toBe("welcome_dashboard");
  expect(payload.content.title).toBe("Fresh Title");
  expect(payload.appearance.paletteId).toBe("morningEmerald");
});

test("empty title is rejected client-side without calling the API", async () => {
  render(<WelcomeExperienceStudio />);
  fireEvent.click(await screen.findByTestId("welcomeexp-new"));
  fireEvent.change(screen.getByTestId("welcomeexp-title"), { target: { value: "" } });
  fireEvent.click(screen.getByTestId("welcomeexp-save"));

  expect(await screen.findByTestId("welcomeexp-error")).toHaveTextContent(/title is required/i);
  expect(api.createExperienceConfig).not.toHaveBeenCalled();
});

test("editing an existing config calls updateExperienceConfig with its id, not createExperienceConfig", async () => {
  api.listExperienceConfigs.mockResolvedValue({ configs: [DRAFT_CONFIG] });
  api.updateExperienceConfig.mockResolvedValue({ config: DRAFT_CONFIG });
  render(<WelcomeExperienceStudio />);

  fireEvent.click(await screen.findByTestId(`welcomeexp-edit-${DRAFT_CONFIG.id}`));
  fireEvent.click(await screen.findByTestId("welcomeexp-save"));

  await waitFor(() => expect(api.updateExperienceConfig).toHaveBeenCalledWith(DRAFT_CONFIG.id, expect.any(Object)));
  expect(api.createExperienceConfig).not.toHaveBeenCalled();
});

test("Publish button calls publishExperienceConfig with the row's id, and only draft rows show it", async () => {
  api.listExperienceConfigs.mockResolvedValue({ configs: [DRAFT_CONFIG, PUBLISHED_CONFIG] });
  api.publishExperienceConfig.mockResolvedValue({ config: { ...DRAFT_CONFIG, status: "published" } });
  render(<WelcomeExperienceStudio />);

  expect(await screen.findByTestId(`welcomeexp-publish-${DRAFT_CONFIG.id}`)).toBeInTheDocument();
  expect(screen.queryByTestId(`welcomeexp-publish-${PUBLISHED_CONFIG.id}`)).not.toBeInTheDocument();
  expect(screen.getByTestId(`welcomeexp-unpublish-${PUBLISHED_CONFIG.id}`)).toBeInTheDocument();

  fireEvent.click(screen.getByTestId(`welcomeexp-publish-${DRAFT_CONFIG.id}`));
  await waitFor(() => expect(api.publishExperienceConfig).toHaveBeenCalledWith(DRAFT_CONFIG.id));
});

test("Unpublish button calls unpublishExperienceConfig with the row's id", async () => {
  api.listExperienceConfigs.mockResolvedValue({ configs: [PUBLISHED_CONFIG] });
  api.unpublishExperienceConfig.mockResolvedValue({ config: { ...PUBLISHED_CONFIG, status: "draft" } });
  render(<WelcomeExperienceStudio />);

  fireEvent.click(await screen.findByTestId(`welcomeexp-unpublish-${PUBLISHED_CONFIG.id}`));
  await waitFor(() => expect(api.unpublishExperienceConfig).toHaveBeenCalledWith(PUBLISHED_CONFIG.id));
});

test("Duplicate button calls duplicateExperienceConfig with the row's id", async () => {
  api.listExperienceConfigs.mockResolvedValue({ configs: [DRAFT_CONFIG] });
  api.duplicateExperienceConfig.mockResolvedValue({ config: { ...DRAFT_CONFIG, id: "cfg-3" } });
  render(<WelcomeExperienceStudio />);

  fireEvent.click(await screen.findByTestId(`welcomeexp-duplicate-${DRAFT_CONFIG.id}`));
  await waitFor(() => expect(api.duplicateExperienceConfig).toHaveBeenCalledWith(DRAFT_CONFIG.id));
});

test("Delete requires a confirm click, then calls deleteExperienceConfig; force is only passed for published rows", async () => {
  api.listExperienceConfigs.mockResolvedValue({ configs: [DRAFT_CONFIG, PUBLISHED_CONFIG] });
  api.deleteExperienceConfig.mockResolvedValue({ ok: true });
  render(<WelcomeExperienceStudio />);

  fireEvent.click(await screen.findByTestId(`welcomeexp-delete-${DRAFT_CONFIG.id}`));
  fireEvent.click(await screen.findByTestId(`welcomeexp-delete-confirm-${DRAFT_CONFIG.id}`));
  await waitFor(() => expect(api.deleteExperienceConfig).toHaveBeenCalledWith(DRAFT_CONFIG.id, { force: false }));

  fireEvent.click(screen.getByTestId(`welcomeexp-delete-${PUBLISHED_CONFIG.id}`));
  fireEvent.click(screen.getByTestId(`welcomeexp-delete-confirm-${PUBLISHED_CONFIG.id}`));
  await waitFor(() => expect(api.deleteExperienceConfig).toHaveBeenCalledWith(PUBLISHED_CONFIG.id, { force: true }));
});

test("live preview renders the real Hero component reflecting the current title field", async () => {
  render(<WelcomeExperienceStudio />);
  fireEvent.click(await screen.findByTestId("welcomeexp-new"));
  fireEvent.change(screen.getByTestId("welcomeexp-title"), { target: { value: "Preview Me" } });

  const preview = screen.getByTestId("welcomeexp-preview");
  expect(within(preview).getByTestId("hero")).toBeInTheDocument();
  expect(within(preview).getByTestId("hero-title")).toHaveTextContent("Preview Me");
});

// ── Hero Artwork enhancement (approved directive) ──────────────────────────
test("the Hero Artwork panel is mounted inside the Appearance column of the form", async () => {
  render(<WelcomeExperienceStudio />);
  fireEvent.click(await screen.findByTestId("welcomeexp-new"));
  expect(screen.getByTestId("hero-artwork-panel")).toBeInTheDocument();
});

test("a new config with no heroArtwork set shows no placement/scale/padding controls (nothing to configure yet)", async () => {
  render(<WelcomeExperienceStudio />);
  fireEvent.click(await screen.findByTestId("welcomeexp-new"));
  expect(screen.queryByTestId("hero-artwork-scale")).not.toBeInTheDocument();
  expect(screen.queryByTestId("hero-artwork-layer-order")).not.toBeInTheDocument();
  // But the source controls (upload / library) are always available.
  expect(screen.getByTestId("hero-artwork-upload")).toBeInTheDocument();
  expect(screen.getByTestId("hero-artwork-browse-library")).toBeInTheDocument();
});

test("picking artwork from the library flows heroArtwork into the save payload and the live preview", async () => {
  api.listHeroArtworkLibrary.mockResolvedValue({
    assets: [{ id: "asset-1", url: "https://cdn.example/asset-1.png" }],
  });
  api.createExperienceConfig.mockResolvedValue({ config: DRAFT_CONFIG });
  render(<WelcomeExperienceStudio />);
  fireEvent.click(await screen.findByTestId("welcomeexp-new"));

  fireEvent.click(screen.getByTestId("hero-artwork-browse-library"));
  fireEvent.click(await screen.findByTestId("hero-artwork-library-item-asset-1"));

  // Live preview picks it up immediately (no publish needed).
  const preview = screen.getByTestId("welcomeexp-preview");
  expect(await within(preview).findByTestId("hero-artwork-layer")).toBeInTheDocument();

  fireEvent.change(screen.getByTestId("welcomeexp-title"), { target: { value: "With Artwork" } });
  fireEvent.click(screen.getByTestId("welcomeexp-save"));

  await waitFor(() => expect(api.createExperienceConfig).toHaveBeenCalledTimes(1));
  const payload = api.createExperienceConfig.mock.calls[0][0];
  expect(payload.appearance.heroArtwork).toMatchObject({
    assetId: "asset-1",
    url: "https://cdn.example/asset-1.png",
  });
});
