/**
 * HeroArtworkLayer.test.jsx — Phase C wiring: once a NEW artwork url is
 * confirmed cached offline, every OTHER cached entry (the asset/version it
 * replaced) must be evicted via clearStaleArtworkCache — previously
 * defined in heroArtworkCache.js but never actually called anywhere. Only
 * evict AFTER a successful preload, never before, so a failed preload
 * (offline, R2 hiccup) can't wipe the still-valid previous artwork out
 * from under an offline student.
 *
 * ../../lib/heroArtworkCache is mocked entirely — its own cache-storage
 * behavior is this module's concern, not HeroArtworkLayer's; this file
 * only proves the CALL CONTRACT between the two.
 */
import { render, waitFor } from "@testing-library/react";
import HeroArtworkLayer from "../HeroArtworkLayer";
import {
  preloadAndCacheArtwork,
  clearStaleArtworkCache,
  getCachedArtworkObjectUrl,
} from "../../lib/heroArtworkCache";

jest.mock("../../lib/heroArtworkCache", () => ({
  preloadAndCacheArtwork: jest.fn(),
  clearStaleArtworkCache: jest.fn(),
  getCachedArtworkObjectUrl: jest.fn(),
}));

beforeEach(() => {
  jest.clearAllMocks();
  // jsdom doesn't implement these — same stub pattern used by
  // studioPageHandoffSnapshot.test.jsx for other object-URL consumers.
  global.URL.createObjectURL = jest.fn(() => "blob:mock");
  global.URL.revokeObjectURL = jest.fn();
});

test("after a successful preload, clearStaleArtworkCache is called with the NEW url", async () => {
  preloadAndCacheArtwork.mockResolvedValue(true);
  render(<HeroArtworkLayer heroArtwork={{ url: "https://cdn/a.png" }} animateEnabled={false} />);

  await waitFor(() => expect(preloadAndCacheArtwork).toHaveBeenCalledWith("https://cdn/a.png"));
  await waitFor(() => expect(clearStaleArtworkCache).toHaveBeenCalledWith("https://cdn/a.png"));
});

test("a FAILED preload never evicts the previous cached artwork", async () => {
  preloadAndCacheArtwork.mockResolvedValue(false);
  render(<HeroArtworkLayer heroArtwork={{ url: "https://cdn/a.png" }} animateEnabled={false} />);

  await waitFor(() => expect(preloadAndCacheArtwork).toHaveBeenCalled());
  expect(clearStaleArtworkCache).not.toHaveBeenCalled();
});

test("publishing a new artwork (url change) repeats preload+evict with the NEW url", async () => {
  preloadAndCacheArtwork.mockResolvedValue(true);
  const { rerender } = render(<HeroArtworkLayer heroArtwork={{ url: "https://cdn/old.png" }} animateEnabled={false} />);
  await waitFor(() => expect(clearStaleArtworkCache).toHaveBeenCalledWith("https://cdn/old.png"));

  rerender(<HeroArtworkLayer heroArtwork={{ url: "https://cdn/new.png" }} animateEnabled={false} />);
  await waitFor(() => expect(clearStaleArtworkCache).toHaveBeenCalledWith("https://cdn/new.png"));
  expect(clearStaleArtworkCache).toHaveBeenCalledTimes(2);
});

test("no heroArtwork url — never calls preload or evict", () => {
  render(<HeroArtworkLayer heroArtwork={null} animateEnabled={false} />);
  expect(preloadAndCacheArtwork).not.toHaveBeenCalled();
  expect(clearStaleArtworkCache).not.toHaveBeenCalled();
});

test("an unmount before the preload resolves never triggers a post-unmount eviction call", async () => {
  let resolvePreload;
  preloadAndCacheArtwork.mockReturnValue(new Promise((res) => { resolvePreload = res; }));
  const { unmount } = render(<HeroArtworkLayer heroArtwork={{ url: "https://cdn/a.png" }} animateEnabled={false} />);

  unmount();
  resolvePreload(true);
  await Promise.resolve();
  await Promise.resolve();

  expect(clearStaleArtworkCache).not.toHaveBeenCalled();
});

test("an image load error falls back to the cached offline copy without crashing", async () => {
  preloadAndCacheArtwork.mockResolvedValue(true);
  getCachedArtworkObjectUrl.mockResolvedValue("blob:offline-copy");
  const { getByTestId } = render(<HeroArtworkLayer heroArtwork={{ url: "https://cdn/a.png" }} animateEnabled={false} />);

  const img = getByTestId("hero-artwork-image");
  img.dispatchEvent(new Event("error"));

  await waitFor(() => expect(getByTestId("hero-artwork-image")).toHaveAttribute("src", "blob:offline-copy"));
});
