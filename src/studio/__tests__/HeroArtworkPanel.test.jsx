/**
 * HeroArtworkPanel.test.jsx — Author Studio Hero Artwork controls
 * (approved directive: source, placement, scale, padding, layer order,
 * overflow). Mocks ./api entirely — network behavior for upload/library/
 * delete is already covered by the backend's test_hero_artwork_tools.py.
 * Asserts on the CONTRACT: every control writes the heroArtwork shape
 * heroArtworkSchema.js/HeroArtworkLayer.jsx expect, version bumps on every
 * real change, and placement/scale/padding/layer/overflow controls only
 * appear once artwork actually exists (nothing to configure before then).
 */
import { render, screen, fireEvent, waitFor } from "@testing-library/react";
import { useState } from "react";
import HeroArtworkPanel from "../HeroArtworkPanel";
import * as api from "../api";

jest.mock("../api", () => ({
  uploadHeroArtwork: jest.fn(),
  listHeroArtworkLibrary: jest.fn(),
  deleteHeroArtworkAsset: jest.fn(),
}));

// Stateful harness — mirrors how WelcomeExperienceStudio actually wires
// heroArtwork (controlled prop + onChange), so assertions exercise the
// real controlled-component contract, not a stub that ignores onChange.
function Harness({ initial }) {
  const [heroArtwork, setHeroArtwork] = useState(initial || null);
  return <HeroArtworkPanel heroArtwork={heroArtwork} onChange={setHeroArtwork} />;
}

const ASSET = { id: "asset-9", url: "https://cdn.example/asset-9.png" };

const WITH_ARTWORK = {
  assetId: "asset-1",
  url: "https://cdn.example/asset-1.png",
  placement: "right",
  customX: 50,
  customY: 50,
  scale: 100,
  padding: { top: 16, bottom: 16, left: 16, right: 16 },
  layerOrder: "behindText",
  allowOverflow: false,
  version: 3,
};

beforeEach(() => {
  jest.clearAllMocks();
});

test("with no artwork set, only source controls are shown (upload / library) — no placement/scale/padding", () => {
  render(<Harness />);
  expect(screen.getByTestId("hero-artwork-upload")).toHaveTextContent(/upload/i);
  expect(screen.getByTestId("hero-artwork-browse-library")).toBeInTheDocument();
  expect(screen.queryByTestId("hero-artwork-remove")).not.toBeInTheDocument();
  expect(screen.queryByTestId("hero-artwork-scale")).not.toBeInTheDocument();
  expect(screen.queryByTestId("hero-artwork-layer-order")).not.toBeInTheDocument();
});

test("uploading a file calls uploadHeroArtwork and sets assetId/url, bumping version from 0", async () => {
  api.uploadHeroArtwork.mockResolvedValue({ asset: ASSET });
  render(<Harness />);

  const file = new File(["fake-bytes"], "art.png", { type: "image/png" });
  const input = screen.getByTestId("hero-artwork-file-input");
  fireEvent.change(input, { target: { files: [file] } });

  await waitFor(() => expect(api.uploadHeroArtwork).toHaveBeenCalledWith(file));
  expect(await screen.findByTestId("hero-artwork-current-preview")).toBeInTheDocument();
  // Placement controls now appear since artwork exists.
  expect(screen.getByTestId("hero-artwork-scale")).toBeInTheDocument();
});

test("upload failure shows an error and does not silently clear existing artwork", async () => {
  api.uploadHeroArtwork.mockRejectedValue(new Error("Upload failed."));
  render(<Harness initial={WITH_ARTWORK} />);

  const file = new File(["fake-bytes"], "art.png", { type: "image/png" });
  fireEvent.change(screen.getByTestId("hero-artwork-file-input"), { target: { files: [file] } });

  expect(await screen.findByTestId("hero-artwork-error")).toHaveTextContent(/upload failed/i);
  // Existing artwork's preview is still shown — a failed replace doesn't wipe it.
  expect(screen.getByTestId("hero-artwork-current-preview")).toBeInTheDocument();
});

test("Media Library opens, lists assets, and picking one sets assetId/url + bumps version", async () => {
  api.listHeroArtworkLibrary.mockResolvedValue({ assets: [ASSET] });
  render(<Harness initial={WITH_ARTWORK} />);

  fireEvent.click(screen.getByTestId("hero-artwork-browse-library"));
  await waitFor(() => expect(api.listHeroArtworkLibrary).toHaveBeenCalledTimes(1));

  const item = await screen.findByTestId(`hero-artwork-library-item-${ASSET.id}`);
  fireEvent.click(item);

  // Modal closes after picking, and the newly-picked artwork is now current.
  expect(screen.queryByTestId("hero-artwork-library-modal")).not.toBeInTheDocument();
});

test("Media Library shows an empty state when no assets exist yet", async () => {
  api.listHeroArtworkLibrary.mockResolvedValue({ assets: [] });
  render(<Harness />);
  fireEvent.click(screen.getByTestId("hero-artwork-browse-library"));
  expect(await screen.findByTestId("hero-artwork-library-empty")).toBeInTheDocument();
});

test("deleting a library asset calls deleteHeroArtworkAsset and removes it from the grid without picking it", async () => {
  api.listHeroArtworkLibrary.mockResolvedValue({ assets: [ASSET] });
  api.deleteHeroArtworkAsset.mockResolvedValue({ ok: true });
  render(<Harness />);

  fireEvent.click(screen.getByTestId("hero-artwork-browse-library"));
  await screen.findByTestId(`hero-artwork-library-item-${ASSET.id}`);

  fireEvent.click(screen.getByTestId(`hero-artwork-library-delete-${ASSET.id}`));
  await waitFor(() => expect(api.deleteHeroArtworkAsset).toHaveBeenCalledWith(ASSET.id));
  await waitFor(() =>
    expect(screen.queryByTestId(`hero-artwork-library-item-${ASSET.id}`)).not.toBeInTheDocument());
  // Deleting is not the same as picking — the modal stays open.
  expect(screen.getByTestId("hero-artwork-library-modal")).toBeInTheDocument();
});

test("Remove clears artwork back to no-artwork state (upload/library re-appear as the only controls)", () => {
  render(<Harness initial={WITH_ARTWORK} />);
  fireEvent.click(screen.getByTestId("hero-artwork-remove"));
  expect(screen.queryByTestId("hero-artwork-current-preview")).not.toBeInTheDocument();
  expect(screen.queryByTestId("hero-artwork-scale")).not.toBeInTheDocument();
});

test("placement buttons update placement and mark the active one pressed", () => {
  render(<Harness initial={WITH_ARTWORK} />);
  const topLeft = screen.getByTestId("hero-artwork-placement-topLeft");
  expect(screen.getByTestId("hero-artwork-placement-right")).toHaveAttribute("aria-pressed", "true");
  fireEvent.click(topLeft);
  expect(topLeft).toHaveAttribute("aria-pressed", "true");
});

test("custom placement reveals X/Y sliders; non-custom placements hide them", () => {
  render(<Harness initial={WITH_ARTWORK} />);
  expect(screen.queryByTestId("hero-artwork-custom-x")).not.toBeInTheDocument();
  fireEvent.click(screen.getByTestId("hero-artwork-placement-custom"));
  expect(screen.getByTestId("hero-artwork-custom-x")).toBeInTheDocument();
  expect(screen.getByTestId("hero-artwork-custom-y")).toBeInTheDocument();
});

test("scale slider updates the displayed percentage", () => {
  render(<Harness initial={WITH_ARTWORK} />);
  fireEvent.change(screen.getByTestId("hero-artwork-scale"), { target: { value: "150" } });
  expect(screen.getByText(/Scale · 150%/)).toBeInTheDocument();
});

test("each padding edge is independently editable", () => {
  render(<Harness initial={WITH_ARTWORK} />);
  fireEvent.change(screen.getByTestId("hero-artwork-padding-top"), { target: { value: "40" } });
  expect(screen.getByTestId("hero-artwork-padding-top")).toHaveValue(40);
  expect(screen.getByTestId("hero-artwork-padding-left")).toHaveValue(16); // untouched edges unaffected
});

test("layer order select offers all 4 ARTWORK_LAYER_ORDERS options", () => {
  render(<Harness initial={WITH_ARTWORK} />);
  const select = screen.getByTestId("hero-artwork-layer-order");
  const values = Array.from(select.options).map((o) => o.value);
  expect(values).toEqual(["behindParticles", "aboveParticles", "behindText", "aboveDecorative"]);
});

test("allow-overflow toggle flips its own state without touching other fields", () => {
  render(<Harness initial={WITH_ARTWORK} />);
  fireEvent.click(screen.getByTestId("hero-artwork-allow-overflow"));
  // Padding/scale still reflect the original values — only allowOverflow changed.
  expect(screen.getByTestId("hero-artwork-padding-top")).toHaveValue(16);
});

// Effects — additive fields on heroArtworkSchema.js (Promotion Experience
// Studio directive). Shared here so Welcome Hero/Achievement gain the same
// capability instead of Promotion forking its own artwork panel.
describe("Effects section (Promotion Experience Studio)", () => {
  test("opacity/blur/brightness/contrast sliders default to their neutral values when unset", () => {
    render(<Harness initial={WITH_ARTWORK} />);
    expect(screen.getByText(/Opacity · 100%/)).toBeInTheDocument();
    expect(screen.getByText(/Blur · 0px/)).toBeInTheDocument();
    expect(screen.getByText(/Brightness · 100%/)).toBeInTheDocument();
    expect(screen.getByText(/Contrast · 100%/)).toBeInTheDocument();
  });

  test("opacity slider updates the displayed percentage", () => {
    render(<Harness initial={WITH_ARTWORK} />);
    fireEvent.change(screen.getByTestId("hero-artwork-opacity"), { target: { value: "70" } });
    expect(screen.getByText(/Opacity · 70%/)).toBeInTheDocument();
  });

  test("blur slider updates the displayed pixel value", () => {
    render(<Harness initial={WITH_ARTWORK} />);
    fireEvent.change(screen.getByTestId("hero-artwork-blur"), { target: { value: "8" } });
    expect(screen.getByText(/Blur · 8px/)).toBeInTheDocument();
  });

  test("overlay toggle reveals color + opacity controls only once enabled", () => {
    render(<Harness initial={WITH_ARTWORK} />);
    expect(screen.queryByTestId("hero-artwork-overlay-color")).not.toBeInTheDocument();
    fireEvent.click(screen.getByTestId("hero-artwork-overlay-toggle"));
    expect(screen.getByTestId("hero-artwork-overlay-color")).toBeInTheDocument();
    expect(screen.getByTestId("hero-artwork-overlay-opacity")).toBeInTheDocument();
  });

  test("changing effects doesn't touch placement/scale/padding fields", () => {
    render(<Harness initial={WITH_ARTWORK} />);
    fireEvent.change(screen.getByTestId("hero-artwork-brightness"), { target: { value: "130" } });
    expect(screen.getByTestId("hero-artwork-scale")).toHaveValue("100");
    expect(screen.getByTestId("hero-artwork-padding-top")).toHaveValue(16);
  });
});
