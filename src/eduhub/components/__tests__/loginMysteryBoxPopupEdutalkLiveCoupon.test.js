/**
 * loginMysteryBoxPopupEdutalkLiveCoupon.test.js — proves the Live Voice
 * Coach Coupon additions to LoginMysteryBoxPopup.jsx are present and
 * additive. Full render of this component requires router + auth context +
 * live backend polling, so (matching this codebase's established pattern
 * for heavy, dependency-laden components — see
 * liveCoachRewardResilience.test.js) this asserts against the real source
 * directly rather than reimplementing it.
 */
import fs from "fs";
import path from "path";

const SRC = fs.readFileSync(
  path.join(__dirname, "..", "LoginMysteryBoxPopup.jsx"), "utf8");

test("rewardTypeLabel maps edutalk_live_coupon to the user-facing label", () => {
  expect(SRC).toMatch(/case "edutalk_live_coupon": return "Live Voice Coach Coupon";/);
});

test("RewardIcon has a distinct case for edutalk_live_coupon", () => {
  const match = SRC.match(/function RewardIcon\(\{[\s\S]*?\n\}/);
  expect(match).not.toBeNull();
  expect(match[0]).toMatch(/t === "edutalk_live_coupon"/);
});

test("receipt render block shows the edutalk_live_coupon code, separate from the book-voucher code block", () => {
  expect(SRC).toMatch(/resp\.edutalk_live_coupon && resp\.edutalk_live_coupon\.coupon_code/);
  expect(SRC).toMatch(/login-mystery-edutalk-live-coupon-code/);
  // The existing book-voucher code block must remain untouched.
  expect(SRC).toMatch(/resp\.voucher && resp\.voucher\.coupon_code/);
  expect(SRC).toMatch(/login-mystery-voucher-code/);
});

test("never exposes the internal benefit_type/edutalk_points identifier to the student", () => {
  expect(SRC).not.toMatch(/benefit_type/);
  expect(SRC).not.toMatch(/edutalk_points/);
});
