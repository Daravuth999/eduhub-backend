/**
 * experienceConfigApiCache.test.js — Dashboard Bootstrap caching added to
 * the Phase 1 experienceConfigApi.js transport. The un-cached transport
 * behavior is already covered by resolveExperienceConfig.test.js /
 * legacyWelcomeAdapter.test.js; this file covers only the new SWR layer.
 *
 * experienceConfigApi.js reads REACT_APP_BACKEND_URL into a module-level
 * constant at import time, so each test resets the module registry and
 * re-requires it AFTER setting the env var — setting process.env in
 * beforeEach alone has no effect on an already-imported module.
 */
const ORIGINAL_ENV = process.env.REACT_APP_BACKEND_URL;

function freshApi() {
  jest.resetModules();
  process.env.REACT_APP_BACKEND_URL = "https://backend.example";
  return require("../experienceConfigApi");
}

beforeEach(() => {
  localStorage.clear();
  global.fetch = jest.fn();
});

afterEach(() => {
  process.env.REACT_APP_BACKEND_URL = ORIGINAL_ENV;
  jest.restoreAllMocks();
});

describe("getCachedActiveExperienceConfig", () => {
  it("returns null when nothing has ever been fetched for this experienceType", () => {
    const { getCachedActiveExperienceConfig } = freshApi();
    expect(getCachedActiveExperienceConfig("welcome_dashboard")).toBeNull();
  });
});

describe("fetchActiveExperienceConfig — caching", () => {
  it("caches a successful published config so the next call's cache read sees it", async () => {
    const { fetchActiveExperienceConfig, getCachedActiveExperienceConfig } = freshApi();
    const config = { experienceType: "welcome_dashboard", content: { title: "Live" } };
    global.fetch.mockResolvedValue({ ok: true, json: async () => ({ config }) });

    const result = await fetchActiveExperienceConfig("welcome_dashboard");
    expect(result).toEqual(config);
    expect(getCachedActiveExperienceConfig("welcome_dashboard")).toEqual(config);
  });

  it("caches per experienceType — one type's cache never leaks into another's", async () => {
    const { fetchActiveExperienceConfig, getCachedActiveExperienceConfig } = freshApi();
    global.fetch.mockResolvedValue({ ok: true, json: async () => ({ config: { experienceType: "welcome_dashboard", content: { title: "A" } } }) });
    await fetchActiveExperienceConfig("welcome_dashboard");

    expect(getCachedActiveExperienceConfig("digital_books_hero")).toBeNull();
  });

  it("a confirmed 'nothing published' response clears any stale cache instead of keeping it forever", async () => {
    const { fetchActiveExperienceConfig, getCachedActiveExperienceConfig } = freshApi();
    global.fetch.mockResolvedValueOnce({ ok: true, json: async () => ({ config: { experienceType: "welcome_dashboard", content: { title: "Was live" } } }) });
    await fetchActiveExperienceConfig("welcome_dashboard");
    expect(getCachedActiveExperienceConfig("welcome_dashboard")).toBeTruthy();

    global.fetch.mockResolvedValueOnce({ ok: true, json: async () => ({ config: null }) });
    await fetchActiveExperienceConfig("welcome_dashboard");
    expect(getCachedActiveExperienceConfig("welcome_dashboard")).toBeNull();
  });

  it("a network failure never touches the cache — last known-good value survives", async () => {
    const { fetchActiveExperienceConfig, getCachedActiveExperienceConfig } = freshApi();
    global.fetch.mockResolvedValueOnce({ ok: true, json: async () => ({ config: { experienceType: "welcome_dashboard", content: { title: "Cached" } } }) });
    await fetchActiveExperienceConfig("welcome_dashboard");

    global.fetch.mockRejectedValueOnce(new Error("network down"));
    const result = await fetchActiveExperienceConfig("welcome_dashboard");

    expect(result).toBeNull(); // the live call result correctly reports failure
    expect(getCachedActiveExperienceConfig("welcome_dashboard").content.title).toBe("Cached"); // but cache is untouched
  });
});

describe("fetchActiveExperienceConfigList — multi-instance types (e.g. winner_showcase)", () => {
  it("returns [] when nothing has ever been fetched", () => {
    const { getCachedActiveExperienceConfigList } = freshApi();
    expect(getCachedActiveExperienceConfigList("winner_showcase")).toEqual([]);
  });

  it("fetches and caches every active config for the type", async () => {
    const { fetchActiveExperienceConfigList, getCachedActiveExperienceConfigList } = freshApi();
    const configs = [
      { key: "evt_1", content: { champion: "A" } },
      { key: "evt_2", content: { champion: "B" } },
    ];
    global.fetch.mockResolvedValue({ ok: true, json: async () => ({ configs }) });

    const result = await fetchActiveExperienceConfigList("winner_showcase");
    expect(result).toEqual(configs);
    expect(getCachedActiveExperienceConfigList("winner_showcase")).toEqual(configs);
  });

  it("returns [] and never throws on a network failure", async () => {
    const { fetchActiveExperienceConfigList } = freshApi();
    global.fetch.mockRejectedValueOnce(new Error("network down"));
    const result = await fetchActiveExperienceConfigList("winner_showcase");
    expect(result).toEqual([]);
  });

  it("returns [] on a non-ok response without touching the cache", async () => {
    const { fetchActiveExperienceConfigList, getCachedActiveExperienceConfigList } = freshApi();
    global.fetch.mockResolvedValueOnce({ ok: true, json: async () => ({ configs: [{ key: "evt_1" }] }) });
    await fetchActiveExperienceConfigList("winner_showcase");

    global.fetch.mockResolvedValueOnce({ ok: false });
    const result = await fetchActiveExperienceConfigList("winner_showcase");
    expect(result).toEqual([]);
    expect(getCachedActiveExperienceConfigList("winner_showcase")).toEqual([{ key: "evt_1" }]); // untouched
  });
});
