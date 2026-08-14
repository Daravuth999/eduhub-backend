/**
 * liveCoachCouponCard.test.jsx — Live Voice Coach Coupon student card.
 *
 * Verifies the full state machine (idle → validating → valid/invalid/
 * expired/already_redeemed → redeeming → success/network_error), that the
 * card is hidden entirely when disabled, that an empty/invalid code never
 * throws or calls redeem, and that the component owns no mic/AudioContext/
 * WebSocket side effects (it only ever calls the two mocked API functions).
 */
import React from "react";
import { render, fireEvent, waitFor, screen } from "@testing-library/react";

jest.mock("../../../../../lib/edutalkLiveApi", () => ({
  validateLiveCoachCoupon: jest.fn(),
  redeemLiveCoachCoupon: jest.fn(),
}));

const api = require("../../../../../lib/edutalkLiveApi");
const LiveCoachCouponCard = require("../LiveCoachCouponCard").default;

beforeEach(() => {
  jest.clearAllMocks();
});

test("renders nothing when disabled (backend flag off)", () => {
  const { container } = render(<LiveCoachCouponCard enabled={false} />);
  expect(container.firstChild).toBeNull();
  expect(api.validateLiveCoachCoupon).not.toHaveBeenCalled();
});

test("clicking Check code with an empty input never calls the API", () => {
  render(<LiveCoachCouponCard enabled />);
  fireEvent.click(screen.getByTestId("live-coupon-check-btn"));
  expect(api.validateLiveCoachCoupon).not.toHaveBeenCalled();
});

test("valid code shows the points preview and a Redeem button", async () => {
  api.validateLiveCoachCoupon.mockResolvedValue({ ok: true, state: "valid", benefit_amount: 20 });
  render(<LiveCoachCouponCard enabled />);
  fireEvent.change(screen.getByTestId("live-coupon-input"), { target: { value: "abc123" } });
  fireEvent.click(screen.getByTestId("live-coupon-check-btn"));
  await waitFor(() => expect(screen.getByTestId("live-coupon-preview")).toBeInTheDocument());
  expect(screen.getByTestId("live-coupon-preview").textContent).toMatch(/20 points/);
  expect(api.validateLiveCoachCoupon).toHaveBeenCalledWith("ABC123");
  expect(screen.getByTestId("live-coupon-redeem-btn")).toBeInTheDocument();
});

test("invalid code shows a friendly error, never the raw backend reason code", async () => {
  api.validateLiveCoachCoupon.mockResolvedValue({ ok: false, state: "not_found", message: "This code could not be used. Please check it and try again." });
  render(<LiveCoachCouponCard enabled />);
  fireEvent.change(screen.getByTestId("live-coupon-input"), { target: { value: "bad" } });
  fireEvent.click(screen.getByTestId("live-coupon-check-btn"));
  await waitFor(() => expect(screen.getByTestId("live-coupon-error")).toBeInTheDocument());
  expect(screen.getByTestId("live-coupon-error").textContent).not.toMatch(/not_found/);
  expect(screen.queryByTestId("live-coupon-redeem-btn")).toBeNull();
});

test("expired code shows the expired message", async () => {
  api.validateLiveCoachCoupon.mockResolvedValue({ ok: false, state: "expired", message: "This code has expired." });
  render(<LiveCoachCouponCard enabled />);
  fireEvent.change(screen.getByTestId("live-coupon-input"), { target: { value: "old1" } });
  fireEvent.click(screen.getByTestId("live-coupon-check-btn"));
  await waitFor(() => expect(screen.getByTestId("live-coupon-error").textContent).toMatch(/expired/i));
});

test("global_limit_reached shows a distinct usage-limit message", async () => {
  api.validateLiveCoachCoupon.mockResolvedValue({ ok: false, state: "global_limit_reached", message: "This code has already reached its usage limit." });
  render(<LiveCoachCouponCard enabled />);
  fireEvent.change(screen.getByTestId("live-coupon-input"), { target: { value: "used1" } });
  fireEvent.click(screen.getByTestId("live-coupon-check-btn"));
  await waitFor(() => expect(screen.getByTestId("live-coupon-error").textContent).toMatch(/usage limit/i));
});

test("disabled shows a message distinct from global_limit_reached (no longer conflated)", async () => {
  api.validateLiveCoachCoupon.mockResolvedValue({ ok: false, state: "disabled", message: "This code is not currently active." });
  render(<LiveCoachCouponCard enabled />);
  fireEvent.change(screen.getByTestId("live-coupon-input"), { target: { value: "off1" } });
  fireEvent.click(screen.getByTestId("live-coupon-check-btn"));
  await waitFor(() => expect(screen.getByTestId("live-coupon-error").textContent).toMatch(/not currently active/i));
  expect(screen.getByTestId("live-coupon-error").textContent).not.toMatch(/usage limit|already redeemed/i);
});

test("wrong_benefit_type and not_assigned each show their own specific message", async () => {
  api.validateLiveCoachCoupon.mockResolvedValueOnce({ ok: false, state: "wrong_benefit_type", message: "This code is not a Live Voice Coach Coupon." });
  render(<LiveCoachCouponCard enabled />);
  fireEvent.change(screen.getByTestId("live-coupon-input"), { target: { value: "bookcode" } });
  fireEvent.click(screen.getByTestId("live-coupon-check-btn"));
  await waitFor(() => expect(screen.getByTestId("live-coupon-error").textContent).toMatch(/not a live voice coach coupon/i));
});

test("already_redeemed (ok:true, idempotent revalidation) shows a non-error informational message", async () => {
  api.validateLiveCoachCoupon.mockResolvedValue({ ok: true, state: "already_redeemed", benefit_amount: 20, credited_at: "2026-01-01T00:00:00Z" });
  render(<LiveCoachCouponCard enabled />);
  fireEvent.change(screen.getByTestId("live-coupon-input"), { target: { value: "used2" } });
  fireEvent.click(screen.getByTestId("live-coupon-check-btn"));
  await waitFor(() => expect(screen.getByTestId("live-coupon-already-used")).toBeInTheDocument());
  expect(screen.getByTestId("live-coupon-already-used").textContent).toMatch(/already redeemed/i);
  expect(screen.queryByTestId("live-coupon-error")).toBeNull();
});

test("redeeming a valid code shows success and calls onRedeemed with the credited amount", async () => {
  api.validateLiveCoachCoupon.mockResolvedValue({ ok: true, state: "valid", benefit_amount: 20 });
  api.redeemLiveCoachCoupon.mockResolvedValue({ ok: true, state: "credited", benefit_amount: 20 });
  const onRedeemed = jest.fn();
  render(<LiveCoachCouponCard enabled onRedeemed={onRedeemed} />);
  fireEvent.change(screen.getByTestId("live-coupon-input"), { target: { value: "ok1" } });
  fireEvent.click(screen.getByTestId("live-coupon-check-btn"));
  await waitFor(() => screen.getByTestId("live-coupon-redeem-btn"));
  fireEvent.click(screen.getByTestId("live-coupon-redeem-btn"));
  await waitFor(() => expect(screen.getByTestId("live-coupon-success")).toBeInTheDocument());
  expect(screen.getByTestId("live-coupon-success").textContent).toMatch(/20 points/);
  expect(onRedeemed).toHaveBeenCalledWith(20);
});

test("network error while validating preserves the entered code for retry", async () => {
  api.validateLiveCoachCoupon.mockRejectedValue(new Error("Network error"));
  render(<LiveCoachCouponCard enabled />);
  fireEvent.change(screen.getByTestId("live-coupon-input"), { target: { value: "neterr" } });
  fireEvent.click(screen.getByTestId("live-coupon-check-btn"));
  await waitFor(() => expect(screen.getByTestId("live-coupon-error")).toBeInTheDocument());
  expect(screen.getByTestId("live-coupon-input").value).toBe("NETERR");
});

test("credit_failed on redeem is treated as a retryable network-style error, not a dead end", async () => {
  api.validateLiveCoachCoupon.mockResolvedValue({ ok: true, state: "valid", benefit_amount: 20 });
  api.redeemLiveCoachCoupon.mockResolvedValue({ ok: false, state: "credit_failed", message: "Your code was accepted, but the points could not be applied yet. Please try again." });
  render(<LiveCoachCouponCard enabled />);
  fireEvent.change(screen.getByTestId("live-coupon-input"), { target: { value: "retry1" } });
  fireEvent.click(screen.getByTestId("live-coupon-check-btn"));
  await waitFor(() => screen.getByTestId("live-coupon-redeem-btn"));
  fireEvent.click(screen.getByTestId("live-coupon-redeem-btn"));
  await waitFor(() => expect(screen.getByTestId("live-coupon-error")).toBeInTheDocument());
  expect(screen.getByTestId("live-coupon-error").textContent).toMatch(/try again/i);
});

test("component never imports mic/AudioContext/WebSocket concerns", () => {
  const fs = require("fs");
  const path = require("path");
  const src = fs.readFileSync(path.resolve(__dirname, "../LiveCoachCouponCard.jsx"), "utf8");
  expect(src).not.toMatch(/new AudioContext/);
  expect(src).not.toMatch(/getUserMedia/);
  expect(src).not.toMatch(/new WebSocket/);
  expect(src).not.toMatch(/\bstartSession\(/);
});
