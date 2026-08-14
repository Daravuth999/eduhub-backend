/**
 * useExperienceConfigBootstrap.test.js — Dashboard Bootstrap addition to
 * useExperienceConfig: the published tier now seeds synchronously from
 * cache on first render instead of always starting from legacy/default
 * while the network fetch is in flight.
 *
 * IMPORTANT: legacySource objects must be hoisted to a stable const
 * OUTSIDE the renderHook() callback. The callback re-runs on every
 * render; an inline object literal gets a new reference each time, and
 * since adaptLegacyWelcomeSheetsConfig() always builds a fresh object
 * (see legacyWelcomeAdapter.js), that new reference makes the hook's
 * second effect believe the resolved config genuinely changed — causing
 * a real (test-only) infinite render loop. A well-behaved caller (e.g.
 * useDashboardBootstrap.js passing useEduHubConfig's referentially
 * stable `config` state) never hits this; only an inline literal does.
 */
import { renderHook } from "@testing-library/react";
import { useExperienceConfig } from "../useExperienceConfig";
import * as api from "../../lib/experienceConfig/experienceConfigApi";

jest.mock("../../lib/experienceConfig/experienceConfigApi");

afterEach(() => {
  jest.clearAllMocks();
});

test("first render resolves to the cached published config synchronously, before the network fetch resolves", () => {
  const cached = { experienceType: "welcome_dashboard", content: { title: "Cached Published" } };
  api.getCachedActiveExperienceConfig.mockReturnValue(cached);
  api.fetchActiveExperienceConfig.mockReturnValue(new Promise(() => {})); // never resolves in this test

  const { result } = renderHook(() => useExperienceConfig("welcome_dashboard", { legacySource: null }));

  expect(result.current.source).toBe("published");
  expect(result.current.config.content.title).toBe("Cached Published");
});

test("with no cache, first render falls through to legacy/default exactly as before", () => {
  api.getCachedActiveExperienceConfig.mockReturnValue(null);
  api.fetchActiveExperienceConfig.mockReturnValue(new Promise(() => {}));

  const legacySource = { title: "Sheets Title" }; // stable reference — see file header note
  const { result } = renderHook(() => useExperienceConfig("welcome_dashboard", { legacySource }));

  expect(result.current.source).toBe("legacy");
  expect(result.current.config.content.title).toBe("Sheets Title");
});

test("a live fetch that confirms a DIFFERENT published config replaces the cached guess once it resolves", async () => {
  api.getCachedActiveExperienceConfig.mockReturnValue({ experienceType: "welcome_dashboard", content: { title: "Old Cached" } });
  const fresh = { experienceType: "welcome_dashboard", content: { title: "Fresh From Network" } };
  api.fetchActiveExperienceConfig.mockResolvedValue(fresh);

  const { result, rerender } = renderHook(() => useExperienceConfig("welcome_dashboard", { legacySource: null }));
  expect(result.current.config.content.title).toBe("Old Cached");

  await new Promise((r) => setTimeout(r, 0));
  rerender();

  expect(result.current.config.content.title).toBe("Fresh From Network");
  expect(result.current.loading).toBe(false);
});

test("a live fetch confirming nothing is published falls back past the stale cached guess", async () => {
  api.getCachedActiveExperienceConfig.mockReturnValue({ experienceType: "welcome_dashboard", content: { title: "Stale Cached" } });
  api.fetchActiveExperienceConfig.mockResolvedValue(null);

  const legacySource = { title: "Sheets Title" }; // stable reference — see file header note
  const { result, rerender } = renderHook(() => useExperienceConfig("welcome_dashboard", { legacySource }));
  expect(result.current.config.content.title).toBe("Stale Cached");

  await new Promise((r) => setTimeout(r, 0));
  rerender();

  expect(result.current.source).toBe("legacy");
  expect(result.current.config.content.title).toBe("Sheets Title");
});
