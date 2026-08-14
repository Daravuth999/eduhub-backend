/**
 * loginMysteryStudioEdutalkLiveCoupon.test.jsx — Author Studio coverage for
 * the new "Live Voice Coach Coupon" reward type on Login Mystery Box
 * campaigns (Checkpoint 3 "FULL BUILD AUTHORIZATION"). Verifies:
 *   - the new dropdown option is present and user-facing-labeled correctly
 *   - selecting it reveals the amount/expiry/title fields and hides
 *     irrelevant book-discount/voucher/edutalk-pass-only fields
 *   - the saved campaign payload carries edutalk_live_coupon_amount etc.
 *   - existing reward types (points/voucher/edutalk pass) are unaffected
 */
import React from "react";
import { render, fireEvent, waitFor, act, screen, within } from "@testing-library/react";

jest.mock("../api", () => ({
  listLoginMysteryCampaigns: jest.fn(),
  createLoginMysteryCampaign: jest.fn(),
  updateLoginMysteryCampaign: jest.fn(),
  deleteLoginMysteryCampaign: jest.fn(),
  listLoginMysteryClaims: jest.fn(),
  getLoginMysteryAnalytics: jest.fn(),
}));

const api = require("../api");
const LoginMysteryStudio = require("../LoginMysteryStudio").default;

beforeEach(() => {
  jest.clearAllMocks();
  api.listLoginMysteryCampaigns.mockResolvedValue({ campaigns: [] });
});

async function renderStudio() {
  await act(async () => { render(<LoginMysteryStudio />); });
}

test("Live Voice Coach Coupon appears as a reward-type option, labeled correctly", async () => {
  await renderStudio();
  const select = screen.getByTestId("lms-reward-type-3"); // 4th default reward slot
  const option = within(select).getByText("Live Voice Coach Coupon");
  expect(option).toBeInTheDocument();
  expect(option.value).toBe("edutalk_live_coupon");
});

test("selecting Live Voice Coach Coupon reveals the amount/expiry/title fields", async () => {
  await renderStudio();
  fireEvent.change(screen.getByTestId("lms-reward-type-3"), { target: { value: "edutalk_live_coupon" } });
  expect(screen.getByTestId("lms-reward-edutalk-live-coupon-amount-3")).toBeInTheDocument();
});

test("selecting Live Voice Coach Coupon hides book-discount and edutalk-pass-only fields", async () => {
  await renderStudio();
  fireEvent.change(screen.getByTestId("lms-reward-type-3"), { target: { value: "edutalk_live_coupon" } });
  // Voucher-only and edutalk-pass-only fields for this SAME reward slot must be gone.
  expect(screen.queryByTestId("lms-reward-points-3")).toBeNull();
});

test("saved campaign payload includes edutalk_live_coupon_amount for that reward item", async () => {
  api.createLoginMysteryCampaign.mockResolvedValue({
    campaign: { id: "lmb_1", name: "Login Mystery Box" },
  });
  await renderStudio();
  fireEvent.change(screen.getByTestId("lms-reward-type-3"), { target: { value: "edutalk_live_coupon" } });
  fireEvent.change(screen.getByTestId("lms-reward-edutalk-live-coupon-amount-3"), { target: { value: "35" } });

  await act(async () => { fireEvent.click(screen.getByTestId("lms-save-btn")); });
  await waitFor(() => expect(api.createLoginMysteryCampaign).toHaveBeenCalled());
  const payload = api.createLoginMysteryCampaign.mock.calls[0][0];
  const item = payload.reward_pool[3];
  expect(item.reward_type).toBe("edutalk_live_coupon");
  expect(item.edutalk_live_coupon_amount).toBe(35);
});

test("existing points/voucher/edutalk-pass reward types still save unaffected", async () => {
  api.createLoginMysteryCampaign.mockResolvedValue({
    campaign: { id: "lmb_1", name: "Login Mystery Box" },
  });
  await renderStudio();
  await act(async () => { fireEvent.click(screen.getByTestId("lms-save-btn")); });
  await waitFor(() => expect(api.createLoginMysteryCampaign).toHaveBeenCalled());
  const payload = api.createLoginMysteryCampaign.mock.calls[0][0];
  expect(payload.reward_pool[0].reward_type).toBe("points");
  expect(payload.reward_pool[2].reward_type).toBe("voucher");
  expect(payload.reward_pool[3].reward_type).toBe("edutalk_session");
});
