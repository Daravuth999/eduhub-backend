/**
 * PromotionExperienceStudio.test.jsx — Campaign Design Studio 2.0 (canvas
 * reconstruction of the form-era Promotion Experience Studio; same export,
 * same StudioPage tab, same generic experience-configs API contract).
 *
 * Mocks ./api entirely (network layer covered by the backend's own
 * experience-config test suite). Asserts the UI CONTRACT:
 *   • lists configs scoped to promotional_banner
 *   • creates campaigns as canvas v2 drafts via the real API functions
 *   • opens the canvas editor (stage + layers/assets/templates + inspector)
 *   • legacy (form-era) configs still open — converted non-destructively
 *   • publish/unpublish round-trips through the API
 */
import { render, screen, fireEvent, waitFor } from "@testing-library/react";
import PromotionExperienceStudio from "../PromotionExperienceStudio";
import * as api from "../api";

// react-router-dom's real package isn't resolvable under this project's
// Jest config (same virtualization the other studio tests use).
jest.mock("react-router-dom", () => ({ useNavigate: () => jest.fn() }), { virtual: true });
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

const CANVAS_CONFIG = {
  id: "camp-1",
  experienceType: "promotional_banner",
  key: "topup-march",
  status: "draft",
  version: 1,
  updatedAt: "2026-01-01T00:00:00Z",
  content: {
    visible: true,
    canvas: {
      schemaVersion: 2,
      aspect: "21/9",
      artworkMode: "composition",
      motion: { preset: "layeredElegant", enabled: true, idle: true },
      layers: [
        { id: "bg1", type: "background", name: "Background", visible: true, fill: { kind: "surface", surfaceId: "emeraldNight" }, image: { src: "" }, overlay: {} },
        { id: "txt1", type: "text", name: "Headline", text: "Top Up Bonus", styleId: "premiumLuxury", size: 7, frame: { x: 30, y: 40, w: 50 }, visible: true },
      ],
    },
  },
  appearance: {},
  activeWindow: { startsAt: null, endsAt: null, recurringAnnual: false },
};

const LEGACY_CONFIG = {
  id: "promo-legacy",
  experienceType: "promotional_banner",
  key: "legacy-banner",
  status: "published",
  version: 3,
  updatedAt: "2026-01-01T00:00:00Z",
  content: {
    visible: true,
    textLayers: [{ role: "headline", content: "Old Banner", align: "left" }],
    ctaButtons: [{ label: "Open", style: "primary", action: { type: "internal_route", value: "/library" } }],
    ctaPlacement: "stack",
  },
  appearance: { syncMode: "followTheme", themeId: "emeraldDay", overrides: {}, artwork: null },
  activeWindow: { startsAt: null, endsAt: null, recurringAnnual: false },
};

beforeEach(() => {
  jest.clearAllMocks();
  api.listExperienceConfigs.mockResolvedValue({ configs: [] });
  api.listHeroArtworkLibrary.mockResolvedValue({ assets: [] });
});

test("loads and lists campaigns scoped to promotional_banner on mount", async () => {
  api.listExperienceConfigs.mockResolvedValue({ configs: [CANVAS_CONFIG] });
  render(<PromotionExperienceStudio />);
  await waitFor(() => expect(api.listExperienceConfigs).toHaveBeenCalledWith("promotional_banner"));
  expect(await screen.findByTestId(`campaign-card-${CANVAS_CONFIG.key}`)).toBeInTheDocument();
});

test("shows an empty state when no campaigns exist yet", async () => {
  render(<PromotionExperienceStudio />);
  expect(await screen.findByText(/No campaigns yet/i)).toBeInTheDocument();
});

test("creates a new campaign as a canvas v2 draft and opens the editor", async () => {
  const created = { ...CANVAS_CONFIG, id: "camp-new", key: "my-key" };
  api.createExperienceConfig.mockResolvedValue({ config: created });
  render(<PromotionExperienceStudio />);
  fireEvent.change(await screen.findByTestId("campaign-new-key-input"), { target: { value: "my-key" } });
  fireEvent.click(screen.getByTestId("campaign-create-button"));
  await waitFor(() => expect(api.createExperienceConfig).toHaveBeenCalled());
  const payload = api.createExperienceConfig.mock.calls[0][0];
  expect(payload.experienceType).toBe("promotional_banner");
  expect(payload.key).toBe("my-key");
  expect(payload.content.canvas.schemaVersion).toBe(2);
  // editor opens: canvas stage + panels + topbar present
  expect(await screen.findByTestId("campaign-editor")).toBeInTheDocument();
  expect(screen.getByTestId("canvas-stage")).toBeInTheDocument();
  expect(screen.getByTestId("campaign-studio-publish-button")).toBeInTheDocument();
});

test("opens a canvas campaign in the editor with its layers on the stage", async () => {
  api.listExperienceConfigs.mockResolvedValue({ configs: [CANVAS_CONFIG] });
  render(<PromotionExperienceStudio />);
  fireEvent.click(await screen.findByTestId(`campaign-open-${CANVAS_CONFIG.key}`));
  expect(await screen.findByTestId("campaign-editor")).toBeInTheDocument();
  // the shared renderer draws the text layer inside the stage
  const stage = screen.getByTestId("canvas-stage");
  expect(stage).toHaveTextContent("Top Up Bonus");
  // layers tab lists both layers
  fireEvent.click(screen.getByTestId("campaign-left-tab-layers"));
  expect(screen.getByTestId("layers-panel-row-bg1")).toBeInTheDocument();
  expect(screen.getByTestId("layers-panel-row-txt1")).toBeInTheDocument();
});

test("legacy form-era configs open with a non-destructive canvas conversion", async () => {
  api.listExperienceConfigs.mockResolvedValue({ configs: [LEGACY_CONFIG] });
  render(<PromotionExperienceStudio />);
  fireEvent.click(await screen.findByTestId(`campaign-open-${LEGACY_CONFIG.key}`));
  expect(await screen.findByTestId("campaign-editor")).toBeInTheDocument();
  // migrated headline appears on the canvas; nothing persisted yet
  expect(screen.getByTestId("canvas-stage")).toHaveTextContent("Old Banner");
  expect(api.updateExperienceConfig).not.toHaveBeenCalled();
  // conversion notice shown
  expect(screen.getByTestId("campaign-editor-notice")).toHaveTextContent(/converted to canvas/i);
});

test("Save persists canvas v2 while PRESERVING legacy content fields", async () => {
  api.listExperienceConfigs.mockResolvedValue({ configs: [LEGACY_CONFIG] });
  api.updateExperienceConfig.mockResolvedValue({ config: { ...LEGACY_CONFIG, version: 4 } });
  render(<PromotionExperienceStudio />);
  fireEvent.click(await screen.findByTestId(`campaign-open-${LEGACY_CONFIG.key}`));
  fireEvent.click(await screen.findByTestId("campaign-studio-save-button"));
  await waitFor(() => expect(api.updateExperienceConfig).toHaveBeenCalled());
  const [id, payload] = api.updateExperienceConfig.mock.calls[0];
  expect(id).toBe(LEGACY_CONFIG.id);
  expect(payload.content.canvas.schemaVersion).toBe(2);
  // legacy fields preserved alongside the canvas document
  expect(payload.content.textLayers).toEqual(LEGACY_CONFIG.content.textLayers);
  expect(payload.content.ctaButtons).toEqual(LEGACY_CONFIG.content.ctaButtons);
});

test("Publish saves first, then publishes through the real API", async () => {
  api.listExperienceConfigs.mockResolvedValue({ configs: [CANVAS_CONFIG] });
  api.updateExperienceConfig.mockResolvedValue({ config: { ...CANVAS_CONFIG, version: 2 } });
  api.publishExperienceConfig.mockResolvedValue({ config: { ...CANVAS_CONFIG, status: "published" } });
  render(<PromotionExperienceStudio />);
  fireEvent.click(await screen.findByTestId(`campaign-open-${CANVAS_CONFIG.key}`));
  fireEvent.click(await screen.findByTestId("campaign-studio-publish-button"));
  await waitFor(() => expect(api.publishExperienceConfig).toHaveBeenCalledWith(CANVAS_CONFIG.id));
  expect(api.updateExperienceConfig).toHaveBeenCalled();
  // status pill flips to unpublish
  expect(await screen.findByTestId("campaign-studio-unpublish-button")).toBeInTheDocument();
});

test("Unpublish returns a live campaign to draft", async () => {
  const live = { ...CANVAS_CONFIG, status: "published" };
  api.listExperienceConfigs.mockResolvedValue({ configs: [live] });
  api.unpublishExperienceConfig.mockResolvedValue({ config: { ...live, status: "draft" } });
  render(<PromotionExperienceStudio />);
  fireEvent.click(await screen.findByTestId(`campaign-open-${live.key}`));
  fireEvent.click(await screen.findByTestId("campaign-studio-unpublish-button"));
  await waitFor(() => expect(api.unpublishExperienceConfig).toHaveBeenCalledWith(live.id));
  expect(await screen.findByTestId("campaign-studio-publish-button")).toBeInTheDocument();
});

test("selecting a layer opens its properties in the inspector", async () => {
  api.listExperienceConfigs.mockResolvedValue({ configs: [CANVAS_CONFIG] });
  render(<PromotionExperienceStudio />);
  fireEvent.click(await screen.findByTestId(`campaign-open-${CANVAS_CONFIG.key}`));
  fireEvent.click(await screen.findByTestId("campaign-left-tab-layers"));
  fireEvent.click(screen.getByTestId("layers-panel-row-txt1"));
  // inspector shows text controls for the selected typography layer
  expect(await screen.findByTestId("inspector-text-content")).toHaveValue("Top Up Bonus");
  expect(screen.getByTestId("inspector-textstyle-premiumLuxury")).toBeInTheDocument();
});
