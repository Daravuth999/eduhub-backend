/**
 * liveCoachStartCardCouponSlot.test.jsx — LiveCoachStartCard.jsx has zero
 * mic/AudioContext/WebSocket/auth dependencies (unlike EduTalkLiveCoach.jsx),
 * so a REAL render is feasible and is stronger evidence than a static-source
 * assertion. Proves the exact required DOM order: mode selector -> benefit
 * checklist -> session summary/balance -> coupon slot -> Start button ->
 * refund note. Also proves the slot is a pure rendered node with zero
 * coupling to the Start button's onStart/disabled wiring.
 */
import React from "react";
import { render, screen } from "@testing-library/react";
import LiveCoachStartCard from "../LiveCoachStartCard";

const MODES = [
  { key: "quick", label: "Quick Chat", cost_points: 15, duration_seconds: 240 },
  { key: "deep", label: "Deep Dive", cost_points: 25, duration_seconds: 360 },
];

function renderCard(extraProps = {}) {
  return render(
    <LiveCoachStartCard
      modes={MODES}
      selectedMode="quick"
      onSelectMode={() => {}}
      balance={123}
      starting={false}
      error={null}
      freeTrialAvailable={false}
      onStart={() => {}}
      {...extraProps}
    />,
  );
}

test("without a couponSlot, layout is unchanged (no stray gap/element)", () => {
  const { container } = renderCard();
  expect(screen.getByTestId("live-start-btn")).toBeInTheDocument();
  expect(container.querySelector('[data-testid="live-coupon-slot-marker"]')).toBeNull();
});

test("couponSlot renders between the balance row and the Start button", () => {
  renderCard({
    couponSlot: <div data-testid="live-coupon-slot-marker">COUPON</div>,
  });
  const root = screen.getByTestId("live-start-card");
  const children = Array.from(root.querySelectorAll("*"));
  const balanceIdx = children.indexOf(screen.getByTestId("live-balance"));
  const couponIdx = children.indexOf(screen.getByTestId("live-coupon-slot-marker"));
  const startBtnIdx = children.indexOf(screen.getByTestId("live-start-btn"));
  expect(balanceIdx).toBeGreaterThan(-1);
  expect(couponIdx).toBeGreaterThan(balanceIdx);
  expect(startBtnIdx).toBeGreaterThan(couponIdx);
});

test("exact required order: mode selector -> checklist -> summary -> coupon -> Start button -> refund note", () => {
  renderCard({
    couponSlot: <div data-testid="live-coupon-slot-marker">COUPON</div>,
  });
  const root = screen.getByTestId("live-start-card");
  const modeGrid = root.querySelector(".etlc-modegrid");
  const valueList = screen.getByTestId("live-value-list");
  const balance = screen.getByTestId("live-balance");
  const coupon = screen.getByTestId("live-coupon-slot-marker");
  const startBtn = screen.getByTestId("live-start-btn");
  const note = root.querySelector(".etlc-note");

  const pos = (el) => {
    let n = el;
    let i = 0;
    while (n && n.previousElementSibling) { n = n.previousElementSibling; i++; }
    // fall back to compareDocumentPosition-based ordering for cross-branch nodes
    return el;
  };
  const order = (a, b) =>
    a.compareDocumentPosition(b) & Node.DOCUMENT_POSITION_FOLLOWING ? -1 : 1;

  const seq = [modeGrid, valueList, balance, coupon, startBtn, note];
  const sorted = [...seq].sort(order);
  expect(sorted).toEqual(seq);
});

test("couponSlot has zero coupling to the Start button's onStart/disabled wiring", () => {
  const onStart = jest.fn();
  renderCard({
    starting: false,
    couponSlot: <div data-testid="live-coupon-slot-marker">COUPON</div>,
    onStart,
  });
  const btn = screen.getByTestId("live-start-btn");
  expect(btn).not.toBeDisabled();
  btn.click();
  expect(onStart).toHaveBeenCalledTimes(1);
});

test("an absent couponSlot never blocks the Start button", () => {
  renderCard({ couponSlot: null });
  expect(screen.getByTestId("live-start-btn")).not.toBeDisabled();
});
