/**
 * useWinnerShowcaseRotation.test.js — Automatic Winner Showcase (architecture
 * continuation). Proves: fetches the active-list on mount, rotates through
 * multiple simultaneous showcases on an interval, and never rotates when
 * there is 0 or 1 active showcase.
 */
import { act, renderHook, waitFor } from "@testing-library/react";
import useWinnerShowcaseRotation from "../useWinnerShowcaseRotation";
import * as api from "../../lib/experienceConfig/experienceConfigApi";

jest.mock("../../lib/experienceConfig/experienceConfigApi", () => ({
  fetchActiveExperienceConfigList: jest.fn(),
  getCachedActiveExperienceConfigList: jest.fn(() => []),
}));

const SHOWCASE_1 = { key: "evt_1", content: { champion: { display_name: "A" } } };
const SHOWCASE_2 = { key: "evt_2", content: { champion: { display_name: "B" } } };

beforeEach(() => {
  jest.clearAllMocks();
  jest.useFakeTimers();
  api.getCachedActiveExperienceConfigList.mockReturnValue([]);
  api.fetchActiveExperienceConfigList.mockResolvedValue([]);
});

afterEach(() => {
  jest.useRealTimers();
});

test("returns null current when no showcase is active", async () => {
  const { result } = renderHook(() => useWinnerShowcaseRotation());
  await waitFor(() => expect(api.fetchActiveExperienceConfigList).toHaveBeenCalledWith("winner_showcase"));
  expect(result.current.current).toBeNull();
  expect(result.current.count).toBe(0);
});

test("seeds first paint from the cached list before the network call resolves", () => {
  api.getCachedActiveExperienceConfigList.mockReturnValue([SHOWCASE_1]);
  api.fetchActiveExperienceConfigList.mockReturnValue(new Promise(() => {})); // never resolves in this test
  const { result } = renderHook(() => useWinnerShowcaseRotation());
  expect(result.current.current).toEqual(SHOWCASE_1);
});

test("resolves to the single active showcase and never rotates", async () => {
  api.fetchActiveExperienceConfigList.mockResolvedValue([SHOWCASE_1]);
  const { result } = renderHook(() => useWinnerShowcaseRotation());
  await waitFor(() => expect(result.current.current).toEqual(SHOWCASE_1));

  act(() => { jest.advanceTimersByTime(30000); });
  expect(result.current.current).toEqual(SHOWCASE_1);
  expect(result.current.count).toBe(1);
});

test("rotates through multiple simultaneous showcases on an interval", async () => {
  api.fetchActiveExperienceConfigList.mockResolvedValue([SHOWCASE_1, SHOWCASE_2]);
  const { result } = renderHook(() => useWinnerShowcaseRotation());
  await waitFor(() => expect(result.current.count).toBe(2));
  expect(result.current.current).toEqual(SHOWCASE_1);

  act(() => { jest.advanceTimersByTime(8000); });
  expect(result.current.current).toEqual(SHOWCASE_2);

  act(() => { jest.advanceTimersByTime(8000); });
  expect(result.current.current).toEqual(SHOWCASE_1);
});

test("setIndex lets a caller jump directly to a specific showcase", async () => {
  api.fetchActiveExperienceConfigList.mockResolvedValue([SHOWCASE_1, SHOWCASE_2]);
  const { result } = renderHook(() => useWinnerShowcaseRotation());
  await waitFor(() => expect(result.current.count).toBe(2));

  act(() => { result.current.setIndex(1); });
  expect(result.current.current).toEqual(SHOWCASE_2);
});
