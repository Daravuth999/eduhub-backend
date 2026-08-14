/**
 * useArtworkCampaignsBootstrap.test.js — Dashboard Bootstrap change to
 * useArtworkCampaigns: localStorage cache is shown regardless of age (no
 * more 10-minute TTL cutoff to a blank/loading state). Each test uses a
 * unique placement string since the hook keeps module-level in-memory
 * caches that persist across tests in this file.
 */
import { renderHook, waitFor } from "@testing-library/react";
import useArtworkCampaigns from "../useArtworkCampaigns";

beforeEach(() => {
  localStorage.clear();
  global.fetch = jest.fn().mockReturnValue(new Promise(() => {})); // never resolves unless overridden
});

test("a cache older than the old 10-minute TTL is still shown immediately (no blank/loading flash)", () => {
  const placement = "bootstrap_test_old_cache";
  const ancientTs = Date.now() - 999 * 24 * 3600 * 1000; // ~999 days old
  localStorage.setItem(
    `eduhub_aw1_${placement}`,
    JSON.stringify({ campaigns: [{ id: "c1", image_url: "https://x/1.png" }], ts: ancientTs }),
  );

  const { result } = renderHook(() => useArtworkCampaigns(placement));

  expect(result.current.loading).toBe(false);
  expect(result.current.campaigns).toEqual([{ id: "c1", image_url: "https://x/1.png" }]);
});

test("no cache at all still starts loading=true with an empty array (cold first load, unchanged)", () => {
  const placement = "bootstrap_test_cold";
  const { result } = renderHook(() => useArtworkCampaigns(placement));
  expect(result.current.loading).toBe(true);
  expect(result.current.campaigns).toEqual([]);
});

test("a successful background fetch replaces stale cached campaigns once it resolves", async () => {
  const placement = "bootstrap_test_revalidate";
  localStorage.setItem(
    `eduhub_aw1_${placement}`,
    JSON.stringify({ campaigns: [{ id: "old", image_url: "https://x/old.png" }], ts: Date.now() - 999 * 24 * 3600 * 1000 }),
  );
  global.fetch.mockResolvedValue({
    json: async () => ({ ok: true, campaigns: [{ id: "new", image_url: "https://x/new.png" }] }),
  });

  const { result } = renderHook(() => useArtworkCampaigns(placement));
  expect(result.current.campaigns[0].id).toBe("old"); // stale shown immediately

  await waitFor(() => expect(result.current.campaigns[0].id).toBe("new"));
});

test("a failed background fetch keeps the stale cached campaigns instead of blanking them", async () => {
  const placement = "bootstrap_test_fail_keeps_stale";
  localStorage.setItem(
    `eduhub_aw1_${placement}`,
    JSON.stringify({ campaigns: [{ id: "still-here", image_url: "https://x/still.png" }], ts: Date.now() - 999 * 24 * 3600 * 1000 }),
  );
  global.fetch.mockRejectedValue(new Error("network down"));

  const { result } = renderHook(() => useArtworkCampaigns(placement));
  await waitFor(() => expect(result.current.loading).toBe(false));

  expect(result.current.campaigns).toEqual([{ id: "still-here", image_url: "https://x/still.png" }]);
});
