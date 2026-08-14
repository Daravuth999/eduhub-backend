/**
 * usePlaybackMode.test.js — proves the "intelligent playback" tier
 * decision: first-launch-of-day/cold-launch -> full; same-session return
 * -> short; prefers-reduced-motion -> static (non-negotiable, overrides
 * everything else). Computed once per mount, matching the spec.
 */
import { renderHook } from "@testing-library/react";
import { usePlaybackMode } from "../usePlaybackMode";

let mockReducedMotion = false;
jest.mock("framer-motion", () => ({
  useReducedMotion: () => mockReducedMotion,
}));

const PLAYBACK = { firstLaunchOfDay: true, firstLaunchPerSession: true, replayIntervalHours: 6 };

beforeEach(() => {
  localStorage.clear();
  sessionStorage.clear();
  mockReducedMotion = false;
});

describe("usePlaybackMode", () => {
  it("plays 'full' on a genuinely fresh mount with no prior play recorded", () => {
    const { result } = renderHook(() => usePlaybackMode("welcome_dashboard", PLAYBACK));
    expect(result.current).toBe("full");
  });

  it("plays 'short' when the session already played once", () => {
    sessionStorage.setItem("eduhub_experience_welcome_dashboard_session_played_v1", "1");
    localStorage.setItem("eduhub_experience_welcome_dashboard_last_full_play_v1", new Date().toISOString());
    const { result } = renderHook(() => usePlaybackMode("welcome_dashboard", PLAYBACK));
    expect(result.current).toBe("short");
  });

  it("plays 'full' again after the replay interval has elapsed, even within the same session", () => {
    const eightHoursAgo = new Date(Date.now() - 8 * 60 * 60 * 1000).toISOString();
    localStorage.setItem("eduhub_experience_welcome_dashboard_last_full_play_v1", eightHoursAgo);
    const { result } = renderHook(() => usePlaybackMode("welcome_dashboard", PLAYBACK));
    expect(result.current).toBe("full");
  });

  it("always returns 'static' when the OS prefers reduced motion, regardless of storage state", () => {
    mockReducedMotion = true;
    const { result } = renderHook(() => usePlaybackMode("welcome_dashboard", PLAYBACK));
    expect(result.current).toBe("static");
  });

  it("respects firstLaunchPerSession=false by returning 'static' instead of 'short' on a repeat visit", () => {
    sessionStorage.setItem("eduhub_experience_welcome_dashboard_session_played_v1", "1");
    localStorage.setItem("eduhub_experience_welcome_dashboard_last_full_play_v1", new Date().toISOString());
    const { result } = renderHook(() =>
      usePlaybackMode("welcome_dashboard", { ...PLAYBACK, firstLaunchPerSession: false }),
    );
    expect(result.current).toBe("static");
  });

  it("is namespaced per experienceType — two different experiences never share playback state", () => {
    sessionStorage.setItem("eduhub_experience_welcome_dashboard_session_played_v1", "1");
    const { result } = renderHook(() => usePlaybackMode("digital_books_hero", PLAYBACK));
    expect(result.current).toBe("full");
  });
});
