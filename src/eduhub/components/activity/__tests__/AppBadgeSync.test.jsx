/**
 * AppBadgeSync.test.jsx — Home Screen app icon badge sync (Badging API).
 *
 * Proves: (1) setAppBadge is called with the unified total when it becomes
 * positive, (2) clearAppBadge is called when it returns to zero, (3) it
 * never re-fires for an unchanged total, and (4) it is a complete silent
 * no-op — no throw, no console error — when the Badging API doesn't exist
 * on `navigator` (the common case: most desktop browsers, non-installed
 * PWAs, unsupported platforms).
 */
import React from "react";
import { render, act } from "@testing-library/react";
import AppBadgeSync from "../AppBadgeSync";

let mockTotal = 0;
jest.mock("../../../hooks/useUnifiedBadges", () => ({
  useUnifiedBadges: () => ({ total: mockTotal, byModule: {} }),
}));

describe("AppBadgeSync", () => {
  afterEach(() => {
    delete navigator.setAppBadge;
    delete navigator.clearAppBadge;
    mockTotal = 0;
  });

  it("calls navigator.setAppBadge with the unread total when it is positive", () => {
    navigator.setAppBadge = jest.fn().mockResolvedValue(undefined);
    navigator.clearAppBadge = jest.fn().mockResolvedValue(undefined);
    mockTotal = 4;
    render(<AppBadgeSync />);
    expect(navigator.setAppBadge).toHaveBeenCalledWith(4);
    expect(navigator.clearAppBadge).not.toHaveBeenCalled();
  });

  it("calls navigator.clearAppBadge when the total is zero", () => {
    navigator.setAppBadge = jest.fn().mockResolvedValue(undefined);
    navigator.clearAppBadge = jest.fn().mockResolvedValue(undefined);
    mockTotal = 0;
    render(<AppBadgeSync />);
    expect(navigator.clearAppBadge).toHaveBeenCalled();
    expect(navigator.setAppBadge).not.toHaveBeenCalled();
  });

  it("does not re-sync when the total is unchanged across a re-render", () => {
    navigator.setAppBadge = jest.fn().mockResolvedValue(undefined);
    navigator.clearAppBadge = jest.fn().mockResolvedValue(undefined);
    mockTotal = 5;
    const { rerender } = render(<AppBadgeSync />);
    expect(navigator.setAppBadge).toHaveBeenCalledTimes(1);
    act(() => {
      rerender(<AppBadgeSync />);
    });
    expect(navigator.setAppBadge).toHaveBeenCalledTimes(1);
  });

  it("re-syncs when the total changes between renders", () => {
    navigator.setAppBadge = jest.fn().mockResolvedValue(undefined);
    navigator.clearAppBadge = jest.fn().mockResolvedValue(undefined);
    mockTotal = 2;
    const { rerender } = render(<AppBadgeSync />);
    expect(navigator.setAppBadge).toHaveBeenLastCalledWith(2);
    mockTotal = 9;
    rerender(<AppBadgeSync />);
    expect(navigator.setAppBadge).toHaveBeenLastCalledWith(9);
  });

  it("is a silent no-op when the Badging API does not exist on navigator", () => {
    // No setAppBadge / clearAppBadge defined at all — the common case.
    mockTotal = 3;
    expect(() => render(<AppBadgeSync />)).not.toThrow();
  });

  it("renders nothing (no DOM output)", () => {
    mockTotal = 1;
    const { container } = render(<AppBadgeSync />);
    expect(container.innerHTML).toBe("");
  });
});
