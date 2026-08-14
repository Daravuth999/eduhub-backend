/**
 * useUnifiedBadges.test.js — the category→module aggregation is the core
 * logic of the unified badge platform: every nav/dashboard/wallet badge in
 * the app ultimately reads this hook's `byModule` output. It must read
 * from NotificationContext ONLY (no second fetch) and must never crash
 * when the context is unavailable (logged out / provider not mounted).
 */
import React from "react";
import { render, screen } from "@testing-library/react";
import { useUnifiedBadges, CATEGORY_TO_MODULE } from "../useUnifiedBadges";

let mockNotifications;
jest.mock("../../context/NotificationContext", () => ({
  useNotifications: () => mockNotifications,
}));

function Probe() {
  const { total, byModule } = useUnifiedBadges();
  return (
    <div>
      <span data-testid="total">{total}</span>
      <span data-testid="wallet">{byModule.wallet}</span>
      <span data-testid="library">{byModule.library}</span>
      <span data-testid="speakingLab">{byModule.speakingLab}</span>
      <span data-testid="attendance">{byModule.attendance}</span>
      <span data-testid="system">{byModule.system}</span>
    </div>
  );
}

describe("useUnifiedBadges", () => {
  it("maps every backend category to exactly one module", () => {
    // Every category the backend can emit (notification_center.py CATEGORIES)
    // must resolve to a real module bucket — a category falling through to
    // `undefined` would silently vanish from every badge in the app.
    const CATEGORIES = ["rewards", "points", "vouchers", "payments", "classes", "speaking_lab", "attendance", "system"];
    for (const c of CATEGORIES) {
      expect(CATEGORY_TO_MODULE[c]).toBeTruthy();
    }
  });

  it("aggregates points+payments+vouchers+rewards into the single wallet module", () => {
    mockNotifications = {
      unreadCount: 7,
      unreadByCategory: { points: 2, payments: 1, vouchers: 1, rewards: 3 },
    };
    render(<Probe />);
    expect(screen.getByTestId("total").textContent).toBe("7");
    expect(screen.getByTestId("wallet").textContent).toBe("7");
    expect(screen.getByTestId("library").textContent).toBe("0");
  });

  it("keeps speaking_lab and attendance as their own independent modules", () => {
    mockNotifications = {
      unreadCount: 3,
      unreadByCategory: { speaking_lab: 2, attendance: 1 },
    };
    render(<Probe />);
    expect(screen.getByTestId("speakingLab").textContent).toBe("2");
    expect(screen.getByTestId("attendance").textContent).toBe("1");
    expect(screen.getByTestId("wallet").textContent).toBe("0");
  });

  it("maps classes -> library (new-book-published / EduTalk category today)", () => {
    mockNotifications = { unreadCount: 1, unreadByCategory: { classes: 1 } };
    render(<Probe />);
    expect(screen.getByTestId("library").textContent).toBe("1");
  });

  it("never crashes when NotificationContext is unavailable (logged out)", () => {
    mockNotifications = null;
    render(<Probe />);
    expect(screen.getByTestId("total").textContent).toBe("0");
    expect(screen.getByTestId("wallet").textContent).toBe("0");
  });

  it("ignores an unknown/future category rather than crashing", () => {
    mockNotifications = { unreadCount: 1, unreadByCategory: { some_future_category: 5 } };
    render(<Probe />);
    // total still reflects the server's own count (unchanged, untouched)
    expect(screen.getByTestId("total").textContent).toBe("1");
    // but no module bucket silently absorbs an unmapped category
    expect(screen.getByTestId("wallet").textContent).toBe("0");
    expect(screen.getByTestId("system").textContent).toBe("0");
  });
});
