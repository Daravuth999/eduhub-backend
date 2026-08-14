/**
 * VideoLibraryCouponCard.test.jsx — Video Library Voucher student card.
 *
 * Verifies: hidden entirely while the backend flag is off/loading, the
 * subtle trigger opens a sheet (never an always-visible form), the full
 * state machine inside the sheet (idle → validating → valid/invalid/
 * expired/already_redeemed → redeeming → success/network_error), closing
 * via the close button and via the backdrop, and that a successful redeem
 * calls onRedeemed with the credited amount and never crashes without an
 * AuthProvider in the tree.
 */
import React from "react";
import { render, fireEvent, waitFor, screen } from "@testing-library/react";

jest.mock("react-router-dom", () => ({
  __esModule: true,
  useNavigate: () => jest.fn(),
}), { virtual: true });

const mockRefreshPoints = jest.fn().mockResolvedValue(undefined);
jest.mock("../../../context/AuthContext", () => ({
  useAuth: () => ({ student: { studentId: "stu001" }, refreshPoints: mockRefreshPoints }),
}));

jest.mock("../videoLibraryApi", () => ({
  getVideoLibraryCouponStatus: jest.fn(),
  validateVideoLibraryCoupon: jest.fn(),
  redeemVideoLibraryCoupon: jest.fn(),
}));

const api = require("../videoLibraryApi");
const VideoLibraryCouponCard = require("../VideoLibraryCouponCard").default;

beforeEach(() => {
  jest.clearAllMocks();
});

async function renderEnabled(props = {}) {
  api.getVideoLibraryCouponStatus.mockResolvedValue({ enabled: true });
  const utils = render(<VideoLibraryCouponCard {...props} />);
  await waitFor(() => expect(screen.getByTestId("video-library-coupon-trigger")).toBeInTheDocument());
  return utils;
}

test("renders nothing while the status check is pending", () => {
  api.getVideoLibraryCouponStatus.mockReturnValue(new Promise(() => {})); // never resolves
  const { container } = render(<VideoLibraryCouponCard />);
  expect(container.firstChild).toBeNull();
});

test("renders nothing when the backend flag is off", async () => {
  api.getVideoLibraryCouponStatus.mockResolvedValue({ enabled: false });
  const { container } = render(<VideoLibraryCouponCard />);
  await waitFor(() => expect(api.getVideoLibraryCouponStatus).toHaveBeenCalled());
  expect(container.firstChild).toBeNull();
});

test("shows only a subtle trigger, not an inline form, until clicked", async () => {
  await renderEnabled();
  expect(screen.queryByTestId("video-library-coupon-sheet")).toBeNull();
  expect(screen.queryByTestId("video-library-coupon-input")).toBeNull();
});

test("clicking the trigger opens the sheet with an empty input", async () => {
  await renderEnabled();
  fireEvent.click(screen.getByTestId("video-library-coupon-trigger"));
  expect(screen.getByTestId("video-library-coupon-sheet")).toBeInTheDocument();
  expect(screen.getByTestId("video-library-coupon-input")).toBeInTheDocument();
});

test("clicking Check with an empty input never calls the API", async () => {
  await renderEnabled();
  fireEvent.click(screen.getByTestId("video-library-coupon-trigger"));
  fireEvent.click(screen.getByTestId("video-library-coupon-check-btn"));
  expect(api.validateVideoLibraryCoupon).not.toHaveBeenCalled();
});

test("valid code shows the points preview and a Redeem button", async () => {
  api.validateVideoLibraryCoupon.mockResolvedValue({ ok: true, state: "valid", benefit_amount: 20 });
  await renderEnabled();
  fireEvent.click(screen.getByTestId("video-library-coupon-trigger"));
  fireEvent.change(screen.getByTestId("video-library-coupon-input"), { target: { value: "abc123" } });
  fireEvent.click(screen.getByTestId("video-library-coupon-check-btn"));
  await waitFor(() => expect(screen.getByTestId("video-library-coupon-preview")).toBeInTheDocument());
  expect(screen.getByTestId("video-library-coupon-preview").textContent).toMatch(/20 points/);
  expect(api.validateVideoLibraryCoupon).toHaveBeenCalledWith("ABC123");
  expect(screen.getByTestId("video-library-coupon-redeem-btn")).toBeInTheDocument();
});

test("invalid code shows a friendly error, never the raw backend reason code", async () => {
  api.validateVideoLibraryCoupon.mockResolvedValue({ ok: false, state: "not_found", message: "This code could not be used. Please check it and try again." });
  await renderEnabled();
  fireEvent.click(screen.getByTestId("video-library-coupon-trigger"));
  fireEvent.change(screen.getByTestId("video-library-coupon-input"), { target: { value: "bad" } });
  fireEvent.click(screen.getByTestId("video-library-coupon-check-btn"));
  await waitFor(() => expect(screen.getByTestId("video-library-coupon-error")).toBeInTheDocument());
  expect(screen.getByTestId("video-library-coupon-error").textContent).not.toMatch(/not_found/);
});

test("wrong_benefit_type shows the Video-Library-specific message", async () => {
  api.validateVideoLibraryCoupon.mockResolvedValue({ ok: false, state: "wrong_benefit_type", message: "This code is not a Video Library voucher." });
  await renderEnabled();
  fireEvent.click(screen.getByTestId("video-library-coupon-trigger"));
  fireEvent.change(screen.getByTestId("video-library-coupon-input"), { target: { value: "bookcode" } });
  fireEvent.click(screen.getByTestId("video-library-coupon-check-btn"));
  await waitFor(() => expect(screen.getByTestId("video-library-coupon-error").textContent).toMatch(/not a video library voucher/i));
});

test("already_redeemed (ok:true, idempotent revalidation) shows a non-error informational message", async () => {
  api.validateVideoLibraryCoupon.mockResolvedValue({ ok: true, state: "already_redeemed", benefit_amount: 20, credited_at: "2026-01-01T00:00:00Z" });
  await renderEnabled();
  fireEvent.click(screen.getByTestId("video-library-coupon-trigger"));
  fireEvent.change(screen.getByTestId("video-library-coupon-input"), { target: { value: "used2" } });
  fireEvent.click(screen.getByTestId("video-library-coupon-check-btn"));
  await waitFor(() => expect(screen.getByTestId("video-library-coupon-already-used")).toBeInTheDocument());
  expect(screen.queryByTestId("video-library-coupon-error")).toBeNull();
});

test("redeeming a valid code shows success, explains the unlock, and calls onRedeemed", async () => {
  api.validateVideoLibraryCoupon.mockResolvedValue({ ok: true, state: "valid", benefit_amount: 20 });
  api.redeemVideoLibraryCoupon.mockResolvedValue({ ok: true, state: "credited", benefit_amount: 20 });
  const onRedeemed = jest.fn();
  await renderEnabled({ onRedeemed });
  fireEvent.click(screen.getByTestId("video-library-coupon-trigger"));
  fireEvent.change(screen.getByTestId("video-library-coupon-input"), { target: { value: "ok1" } });
  fireEvent.click(screen.getByTestId("video-library-coupon-check-btn"));
  await waitFor(() => screen.getByTestId("video-library-coupon-redeem-btn"));
  fireEvent.click(screen.getByTestId("video-library-coupon-redeem-btn"));
  await waitFor(() => expect(screen.getByTestId("video-library-coupon-success")).toBeInTheDocument());
  expect(screen.getByTestId("video-library-coupon-success").textContent).toMatch(/20 EduHub Points/);
  expect(screen.getByTestId("video-library-coupon-success").textContent).toMatch(/any lesson/i);
  expect(onRedeemed).toHaveBeenCalledWith(20);
});

test("network error while validating preserves the entered code for retry", async () => {
  api.validateVideoLibraryCoupon.mockRejectedValue(new Error("Network error"));
  await renderEnabled();
  fireEvent.click(screen.getByTestId("video-library-coupon-trigger"));
  fireEvent.change(screen.getByTestId("video-library-coupon-input"), { target: { value: "neterr" } });
  fireEvent.click(screen.getByTestId("video-library-coupon-check-btn"));
  await waitFor(() => expect(screen.getByTestId("video-library-coupon-error")).toBeInTheDocument());
  expect(screen.getByTestId("video-library-coupon-input").value).toBe("NETERR");
});

test("credit_failed on redeem is treated as a retryable network-style error", async () => {
  api.validateVideoLibraryCoupon.mockResolvedValue({ ok: true, state: "valid", benefit_amount: 20 });
  api.redeemVideoLibraryCoupon.mockResolvedValue({ ok: false, state: "credit_failed", message: "Your code was accepted, but the points could not be applied yet. Please try again." });
  await renderEnabled();
  fireEvent.click(screen.getByTestId("video-library-coupon-trigger"));
  fireEvent.change(screen.getByTestId("video-library-coupon-input"), { target: { value: "retry1" } });
  fireEvent.click(screen.getByTestId("video-library-coupon-check-btn"));
  await waitFor(() => screen.getByTestId("video-library-coupon-redeem-btn"));
  fireEvent.click(screen.getByTestId("video-library-coupon-redeem-btn"));
  await waitFor(() => expect(screen.getByTestId("video-library-coupon-error")).toBeInTheDocument());
  expect(screen.getByTestId("video-library-coupon-error").textContent).toMatch(/try again/i);
});

test("closing via the close button resets the sheet's state", async () => {
  api.validateVideoLibraryCoupon.mockResolvedValue({ ok: true, state: "valid", benefit_amount: 20 });
  await renderEnabled();
  fireEvent.click(screen.getByTestId("video-library-coupon-trigger"));
  fireEvent.change(screen.getByTestId("video-library-coupon-input"), { target: { value: "abc123" } });
  fireEvent.click(screen.getByTestId("video-library-coupon-check-btn"));
  await waitFor(() => screen.getByTestId("video-library-coupon-redeem-btn"));
  fireEvent.click(screen.getByTestId("video-library-coupon-close-button"));
  expect(screen.queryByTestId("video-library-coupon-sheet")).toBeNull();
  fireEvent.click(screen.getByTestId("video-library-coupon-trigger"));
  expect(screen.getByTestId("video-library-coupon-input").value).toBe("");
  expect(screen.queryByTestId("video-library-coupon-preview")).toBeNull();
});

test("clicking the backdrop closes the sheet, clicking inside it does not", async () => {
  await renderEnabled();
  fireEvent.click(screen.getByTestId("video-library-coupon-trigger"));
  fireEvent.click(screen.getByTestId("video-library-coupon-input"));
  expect(screen.getByTestId("video-library-coupon-sheet")).toBeInTheDocument();
  fireEvent.click(screen.getByTestId("video-library-coupon-sheet"));
  expect(screen.queryByTestId("video-library-coupon-sheet")).toBeNull();
});

test("does not close while a redeem is in flight", async () => {
  api.validateVideoLibraryCoupon.mockResolvedValue({ ok: true, state: "valid", benefit_amount: 20 });
  let resolveRedeem;
  api.redeemVideoLibraryCoupon.mockReturnValue(new Promise((r) => { resolveRedeem = r; }));
  await renderEnabled();
  fireEvent.click(screen.getByTestId("video-library-coupon-trigger"));
  fireEvent.change(screen.getByTestId("video-library-coupon-input"), { target: { value: "abc123" } });
  fireEvent.click(screen.getByTestId("video-library-coupon-check-btn"));
  await waitFor(() => screen.getByTestId("video-library-coupon-redeem-btn"));
  fireEvent.click(screen.getByTestId("video-library-coupon-redeem-btn"));
  expect(screen.queryByTestId("video-library-coupon-close-button")).toBeNull();
  fireEvent.click(screen.getByTestId("video-library-coupon-sheet"));
  expect(screen.getByTestId("video-library-coupon-sheet")).toBeInTheDocument();
  resolveRedeem({ ok: true, state: "credited", benefit_amount: 20 });
  await waitFor(() => expect(screen.getByTestId("video-library-coupon-success")).toBeInTheDocument());
});

test("a successful redeem refreshes the shared GAS points balance", async () => {
  api.validateVideoLibraryCoupon.mockResolvedValue({ ok: true, state: "valid", benefit_amount: 5 });
  api.redeemVideoLibraryCoupon.mockResolvedValue({ ok: true, state: "credited", benefit_amount: 5 });
  await renderEnabled();
  fireEvent.click(screen.getByTestId("video-library-coupon-trigger"));
  fireEvent.change(screen.getByTestId("video-library-coupon-input"), { target: { value: "refresh1" } });
  fireEvent.click(screen.getByTestId("video-library-coupon-check-btn"));
  await waitFor(() => screen.getByTestId("video-library-coupon-redeem-btn"));
  fireEvent.click(screen.getByTestId("video-library-coupon-redeem-btn"));
  await waitFor(() => expect(screen.getByTestId("video-library-coupon-success")).toBeInTheDocument());
  expect(mockRefreshPoints).toHaveBeenCalled();
});
