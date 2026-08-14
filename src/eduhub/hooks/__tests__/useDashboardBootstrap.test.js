/**
 * useDashboardBootstrap.test.js — the Dashboard Bootstrap composition
 * layer. Mocks all four underlying resource hooks/contexts (each has its
 * own dedicated cache/behavior tests elsewhere) and verifies this hook
 * composes them correctly and derives stable content-signature keys for
 * CrossfadeSwap.
 */
import { renderHook } from "@testing-library/react";
import useDashboardBootstrap from "../useDashboardBootstrap";
import { useEduHubConfig } from "../useEduHubConfig";
import useExperienceConfig from "../useExperienceConfig";
import useArtworkCampaigns from "../../components/artwork/useArtworkCampaigns";
import { useNotifications } from "../../context/NotificationContext";

jest.mock("../useEduHubConfig");
jest.mock("../useExperienceConfig");
jest.mock("../../components/artwork/useArtworkCampaigns");
jest.mock("../../context/NotificationContext", () => ({ useNotifications: jest.fn() }));

beforeEach(() => {
  useEduHubConfig.mockReturnValue({ config: { title: "Sheets Title" }, source: "cache", status: "cached", statusText: "Cached", retry: jest.fn() });
  useExperienceConfig.mockReturnValue({ config: null, source: "default", loading: true });
  useArtworkCampaigns.mockReturnValue({ campaigns: [], loading: true });
  useNotifications.mockReturnValue({ items: [], unreadCount: 0 });
});

test("passes useEduHubConfig's config through to useExperienceConfig as the legacy source", () => {
  renderHook(() => useDashboardBootstrap());
  expect(useExperienceConfig).toHaveBeenCalledWith(
    "welcome_dashboard",
    expect.objectContaining({ legacySource: { title: "Sheets Title" } }),
  );
});

test("fetches the dashboard_hero artwork placement", () => {
  renderHook(() => useDashboardBootstrap());
  expect(useArtworkCampaigns).toHaveBeenCalledWith("dashboard_hero");
});

test("welcomeKey is a stable 'empty' signature when there is no resolved config yet", () => {
  useExperienceConfig.mockReturnValue({ config: null, source: "default", loading: true });
  const { result } = renderHook(() => useDashboardBootstrap());
  expect(result.current.welcomeKey).toBe("empty");
});

test("welcomeKey changes when the resolved config's title/palette/preset actually changes", () => {
  useExperienceConfig.mockReturnValue({
    config: { content: { title: "A" }, appearance: { paletteId: "morningEmerald" }, motion: { presetId: "cinematicRise" } },
    source: "published",
    loading: false,
  });
  const { result, rerender } = renderHook(() => useDashboardBootstrap());
  const firstKey = result.current.welcomeKey;

  useExperienceConfig.mockReturnValue({
    config: { content: { title: "B" }, appearance: { paletteId: "morningEmerald" }, motion: { presetId: "cinematicRise" } },
    source: "published",
    loading: false,
  });
  rerender();

  expect(result.current.welcomeKey).not.toBe(firstKey);
});

test("welcomeKey stays the same when the resolved config's tracked fields are unchanged (no spurious crossfade)", () => {
  const config = { content: { title: "Same" }, appearance: { paletteId: "morningEmerald" }, motion: { presetId: "cinematicRise" } };
  useExperienceConfig.mockReturnValue({ config, source: "published", loading: false });
  const { result, rerender } = renderHook(() => useDashboardBootstrap());
  const firstKey = result.current.welcomeKey;

  // New object reference, same values — a common re-render case.
  useExperienceConfig.mockReturnValue({ config: { ...config }, source: "published", loading: false });
  rerender();

  expect(result.current.welcomeKey).toBe(firstKey);
});

test("welcomeKey changes when ONLY Hero Artwork changes — title/palette/preset identical (Phase C)", () => {
  const base = { content: { title: "Same" }, appearance: { paletteId: "morningEmerald", heroArtwork: { url: "https://cdn/a.png", version: 1 } }, motion: { presetId: "cinematicRise" } };
  useExperienceConfig.mockReturnValue({ config: base, source: "published", loading: false });
  const { result, rerender } = renderHook(() => useDashboardBootstrap());
  const firstKey = result.current.welcomeKey;

  useExperienceConfig.mockReturnValue({
    config: { ...base, appearance: { ...base.appearance, heroArtwork: { url: "https://cdn/a.png", version: 2 } } },
    source: "published",
    loading: false,
  });
  rerender();

  expect(result.current.welcomeKey).not.toBe(firstKey);
});

test("welcomeKey is unaffected by heroArtwork when it's absent (older configs, no regression)", () => {
  const config = { content: { title: "Same" }, appearance: { paletteId: "morningEmerald" }, motion: { presetId: "cinematicRise" } };
  useExperienceConfig.mockReturnValue({ config, source: "published", loading: false });
  const { result, rerender } = renderHook(() => useDashboardBootstrap());
  const firstKey = result.current.welcomeKey;

  useExperienceConfig.mockReturnValue({ config: { ...config }, source: "published", loading: false });
  rerender();

  expect(result.current.welcomeKey).toBe(firstKey);
});

describe("achievement (Top Earner) resource — Achievement Experience Studio", () => {
  test("fetches the achievement_top_earner experience type, with no legacy source", () => {
    renderHook(() => useDashboardBootstrap());
    expect(useExperienceConfig).toHaveBeenCalledWith("achievement_top_earner");
  });

  test("achievementKey is 'empty' when there is no resolved config yet", () => {
    const { result } = renderHook(() => useDashboardBootstrap());
    expect(result.current.achievementKey).toBe("empty");
  });

  test("achievementKey changes when the preset/syncMode actually changes", () => {
    useExperienceConfig.mockImplementation((type) => {
      if (type === "achievement_top_earner") {
        return { config: { appearance: { syncMode: "independent", themeId: "halloween" } }, source: "published", loading: false };
      }
      return { config: null, source: "default", loading: true };
    });
    const { result, rerender } = renderHook(() => useDashboardBootstrap());
    const firstKey = result.current.achievementKey;

    useExperienceConfig.mockImplementation((type) => {
      if (type === "achievement_top_earner") {
        return { config: { appearance: { syncMode: "independent", themeId: "christmas" } }, source: "published", loading: false };
      }
      return { config: null, source: "default", loading: true };
    });
    rerender();

    expect(result.current.achievementKey).not.toBe(firstKey);
  });

  test("achievementKey changes when ONLY artwork changes, preset identical", () => {
    const base = { syncMode: "independent", themeId: "goldenCelebration", artwork: { url: "https://cdn/a.png", version: 1 } };
    useExperienceConfig.mockImplementation((type) => {
      if (type === "achievement_top_earner") return { config: { appearance: base }, source: "published", loading: false };
      return { config: null, source: "default", loading: true };
    });
    const { result, rerender } = renderHook(() => useDashboardBootstrap());
    const firstKey = result.current.achievementKey;

    useExperienceConfig.mockImplementation((type) => {
      if (type === "achievement_top_earner") {
        return { config: { appearance: { ...base, artwork: { url: "https://cdn/a.png", version: 2 } } }, source: "published", loading: false };
      }
      return { config: null, source: "default", loading: true };
    });
    rerender();

    expect(result.current.achievementKey).not.toBe(firstKey);
  });

  test("exposes achievement resource state unmodified for TopEarnerPanel to consume", () => {
    const { result } = renderHook(() => useDashboardBootstrap());
    expect(result.current.achievement).toEqual(expect.objectContaining({ config: null, source: "default", loading: true }));
  });
});

describe("promotion resource — Promotion Experience Studio", () => {
  test("fetches the promotional_banner experience type, with no legacy source", () => {
    renderHook(() => useDashboardBootstrap());
    expect(useExperienceConfig).toHaveBeenCalledWith("promotional_banner");
  });

  test("promotionKey is 'empty' when there is no resolved config yet", () => {
    const { result } = renderHook(() => useDashboardBootstrap());
    expect(result.current.promotionKey).toBe("empty");
  });

  test("promotionKey changes when the preset/syncMode actually changes", () => {
    useExperienceConfig.mockImplementation((type) => {
      if (type === "promotional_banner") {
        return { config: { appearance: { syncMode: "independent", themeId: "emeraldDay" } }, source: "published", loading: false };
      }
      return { config: null, source: "default", loading: true };
    });
    const { result, rerender } = renderHook(() => useDashboardBootstrap());
    const firstKey = result.current.promotionKey;

    useExperienceConfig.mockImplementation((type) => {
      if (type === "promotional_banner") {
        return { config: { appearance: { syncMode: "independent", themeId: "celebrationGold" } }, source: "published", loading: false };
      }
      return { config: null, source: "default", loading: true };
    });
    rerender();

    expect(result.current.promotionKey).not.toBe(firstKey);
  });

  test("promotionKey changes when ONLY the text/CTA content changes, preset identical", () => {
    const appearance = { syncMode: "followTheme" };
    useExperienceConfig.mockImplementation((type) => {
      if (type === "promotional_banner") {
        return { config: { appearance, content: { textLayers: [{ id: "1", content: "A" }] } }, source: "published", loading: false };
      }
      return { config: null, source: "default", loading: true };
    });
    const { result, rerender } = renderHook(() => useDashboardBootstrap());
    const firstKey = result.current.promotionKey;

    useExperienceConfig.mockImplementation((type) => {
      if (type === "promotional_banner") {
        return { config: { appearance, content: { textLayers: [{ id: "1", content: "B" }] } }, source: "published", loading: false };
      }
      return { config: null, source: "default", loading: true };
    });
    rerender();

    expect(result.current.promotionKey).not.toBe(firstKey);
  });

  test("exposes promotion resource state unmodified for PromotionPanel to consume", () => {
    const { result } = renderHook(() => useDashboardBootstrap());
    expect(result.current.promotion).toEqual(expect.objectContaining({ config: null, source: "default", loading: true }));
  });
});

describe("announcement resource — Dashboard Showcases (architecture continuation)", () => {
  test("fetches the announcement experience type, with eduhub.config as the legacy source", () => {
    renderHook(() => useDashboardBootstrap());
    expect(useExperienceConfig).toHaveBeenCalledWith(
      "announcement",
      expect.objectContaining({ legacySource: { title: "Sheets Title" } }),
    );
  });

  test("exposes announcement resource state unmodified for AnnouncementStrip to consume", () => {
    useExperienceConfig.mockImplementation((type) => {
      if (type === "announcement") {
        return { config: { content: { announcementMessages: ["Hi"] } }, source: "published", loading: false };
      }
      return { config: null, source: "default", loading: true };
    });
    const { result } = renderHook(() => useDashboardBootstrap());
    expect(result.current.announcement).toEqual(
      expect.objectContaining({
        config: { content: { announcementMessages: ["Hi"] } },
        source: "published",
      }),
    );
  });
});

test("artworkKey is 'empty' when there are no campaigns", () => {
  useArtworkCampaigns.mockReturnValue({ campaigns: [], loading: false });
  const { result } = renderHook(() => useDashboardBootstrap());
  expect(result.current.artworkKey).toBe("empty");
});

test("artworkKey reflects the campaign ids + image urls", () => {
  useArtworkCampaigns.mockReturnValue({
    campaigns: [{ id: "c1", image_url: "https://x/1.png" }, { id: "c2", image_url: "https://x/2.png" }],
    loading: false,
  });
  const { result } = renderHook(() => useDashboardBootstrap());
  expect(result.current.artworkKey).toBe("c1:https://x/1.png|c2:https://x/2.png");
});

test("exposes eduhub, welcome, artwork, and notifications unmodified for consumers", () => {
  const { result } = renderHook(() => useDashboardBootstrap());
  expect(result.current.eduhub.source).toBe("cache");
  expect(result.current.welcome.source).toBe("default");
  expect(result.current.artwork).toEqual({ campaigns: [], loading: true });
  expect(result.current.notifications).toEqual({ items: [], unreadCount: 0 });
});
