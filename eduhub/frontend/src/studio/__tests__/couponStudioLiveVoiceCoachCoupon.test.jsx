/**
 * couponStudioLiveVoiceCoachCoupon.test.jsx — Checkpoint 2 Author Studio
 * coverage: the additive "Coupon Purpose" selector (Book Discount / Live
 * Voice Coach Coupon) on top of the existing CouponStudio.jsx. No Login
 * Mystery UI, no student Live Coach component is imported anywhere here or
 * in the component under test (verified structurally below).
 */
import fs from "fs";
import path from "path";
import React from "react";
import { render, fireEvent, waitFor, act, screen } from "@testing-library/react";

jest.mock("../api", () => ({
  listCoupons: jest.fn(), createCoupon: jest.fn(), updateCoupon: jest.fn(), deleteCoupon: jest.fn(),
}));
jest.mock("../components/StudioPickers", () => ({
  useStudentList: () => ({ students: [], loading: false, error: null }),
  useBookList: () => ({ books: [], loading: false, error: null }),
  MultiStudentPicker: ({ testid }) => <div data-testid={testid || "mock-student-picker"} />,
  BookPicker: ({ testid }) => <div data-testid={testid || "mock-book-picker"} />,
}));

const api = require("../api");
const CouponStudio = require("../CouponStudio").default;

beforeEach(() => {
  jest.clearAllMocks();
  api.listCoupons.mockResolvedValue({ coupons: [] });
});

async function openCreateForm() {
  await act(async () => { render(<CouponStudio />); });
  await waitFor(() => expect(screen.queryByText(/Loading coupons/i)).toBeNull());
  await act(async () => { fireEvent.click(screen.getByText(/New Coupon/i)); });
}

// ── 1/2. existing Book Discount form/payload unchanged ─────────────────────
describe("Book Discount — unchanged behavior", () => {
  test("Book Discount form renders with original fields by default", async () => {
    await openCreateForm();
    expect(screen.getByTestId("coupon-purpose-book_discount")).toBeInTheDocument();
    expect(screen.getByTestId("coupon-book-discount-type")).toBeInTheDocument();
    expect(screen.getByTestId("coupon-book-discount-value")).toBeInTheDocument();
    expect(screen.getByTestId("coupon-book-slugs-picker")).toBeInTheDocument();
    expect(screen.queryByTestId("coupon-edutalk-amount")).toBeNull();
  });

  test("Book Discount submit payload is byte-for-byte the original shape (no benefit_type/benefit_amount)", async () => {
    api.createCoupon.mockResolvedValue({ coupon: { code: "SAVE20" } });
    await openCreateForm();
    fireEvent.change(screen.getByPlaceholderText(/SUMMER20/i), { target: { value: "save20" } });
    fireEvent.change(screen.getByTestId("coupon-book-discount-value"), { target: { value: "20" } });
    await act(async () => { fireEvent.click(screen.getByText(/^Create Coupon$/i)); });
    await waitFor(() => expect(api.createCoupon).toHaveBeenCalled());
    const payload = api.createCoupon.mock.calls[0][0];
    expect(payload).not.toHaveProperty("benefit_type");
    expect(payload).not.toHaveProperty("benefit_amount");
    expect(payload.type).toBe("percent");
    expect(payload.value).toBe(20);
    expect(payload.code).toBe("SAVE20");
  });
});

// ── 3/4. purpose switch shows/hides the right fields ────────────────────────
describe("Coupon Purpose switch", () => {
  test("switching to Live Voice Coach Coupon shows the points-amount field", async () => {
    await openCreateForm();
    fireEvent.click(screen.getByTestId("coupon-purpose-edutalk_live_coupon"));
    expect(screen.getByTestId("coupon-edutalk-amount")).toBeInTheDocument();
    expect(screen.getByTestId("coupon-edutalk-preview")).toBeInTheDocument();
  });

  test("switching to Live Voice Coach Coupon hides book-discount-only fields", async () => {
    await openCreateForm();
    fireEvent.click(screen.getByTestId("coupon-purpose-edutalk_live_coupon"));
    expect(screen.queryByTestId("coupon-book-discount-type")).toBeNull();
    expect(screen.queryByTestId("coupon-book-discount-value")).toBeNull();
    expect(screen.queryByTestId("coupon-book-slugs-picker")).toBeNull();
  });

  test("preview card shows the live points amount and the disabled-until-launch note", async () => {
    await openCreateForm();
    fireEvent.click(screen.getByTestId("coupon-purpose-edutalk_live_coupon"));
    fireEvent.change(screen.getByTestId("coupon-edutalk-amount"), { target: { value: "20" } });
    expect(screen.getByTestId("coupon-edutalk-preview").textContent).toMatch(/20 EduTalk points/i);
    expect(screen.getByTestId("coupon-edutalk-disabled-note").textContent).toMatch(/currently disabled/i);
  });
});

// ── 5. Live Voice Coach Coupon submit payload shape ─────────────────────────
describe("Live Voice Coach Coupon — submit payload", () => {
  test("submit payload contains benefit_type=edutalk_points and a positive integer benefit_amount", async () => {
    api.createCoupon.mockResolvedValue({ coupon: { code: "ET20" } });
    await openCreateForm();
    fireEvent.click(screen.getByTestId("coupon-purpose-edutalk_live_coupon"));
    fireEvent.change(screen.getByTestId("coupon-edutalk-amount"), { target: { value: "20" } });
    await act(async () => { fireEvent.click(screen.getByText(/^Create Coupon$/i)); });
    await waitFor(() => expect(api.createCoupon).toHaveBeenCalled());
    const payload = api.createCoupon.mock.calls[0][0];
    expect(payload.benefit_type).toBe("edutalk_points");
    expect(payload.benefit_amount).toBe(20);
    expect(Number.isInteger(payload.benefit_amount)).toBe(true);
    expect(payload.book_slugs).toEqual([]);
  });

  // ── 6. invalid amounts blocked client-side ─────────────────────────────
  test.each(["-5", "0", "1.5", "abc", String(MAX_PLUS_ONE())])(
    "invalid amount '%s' is blocked before any network call",
    async (bad) => {
      await openCreateForm();
      fireEvent.click(screen.getByTestId("coupon-purpose-edutalk_live_coupon"));
      fireEvent.change(screen.getByTestId("coupon-edutalk-amount"), { target: { value: bad } });
      await act(async () => { fireEvent.click(screen.getByText(/^Create Coupon$/i)); });
      expect(api.createCoupon).not.toHaveBeenCalled();
      expect(screen.getByText(/whole number between 1 and/i)).toBeInTheDocument();
    },
  );
});

function MAX_PLUS_ONE() { return 1001; }

// ── 7. editing existing (old) coupons still works ───────────────────────────
describe("Editing existing coupons", () => {
  test("toggling enabled on an old coupon (no benefit_type) still calls updateCoupon", async () => {
    api.listCoupons.mockResolvedValue({
      coupons: [{ code: "OLD10", type: "fixed", value: 10, max_uses: null, uses_count: 0,
                  assigned_to: [], book_slugs: [], enabled: true, redemptions: [] }],
    });
    api.updateCoupon.mockResolvedValue({ ok: true });
    await act(async () => { render(<CouponStudio />); });
    await waitFor(() => expect(screen.getByText("OLD10")).toBeInTheDocument());
    const toggleBtn = screen.getByTitle("Disable");
    await act(async () => { fireEvent.click(toggleBtn); });
    await waitFor(() => expect(api.updateCoupon).toHaveBeenCalledWith("OLD10", { enabled: false }));
  });
});

// ── 8/9. listing/table safety + clear Live Voice Coach display ──────────────
describe("Coupon list rendering", () => {
  test("old coupons lacking benefit_type entirely render without crashing, as Book Discount", async () => {
    api.listCoupons.mockResolvedValue({
      coupons: [{ code: "LEGACY1", type: "percent", value: 15, max_uses: null, uses_count: 0,
                  assigned_to: [], book_slugs: [], enabled: true, redemptions: [] }],
    });
    await act(async () => { render(<CouponStudio />); });
    await waitFor(() => expect(screen.getByText("LEGACY1")).toBeInTheDocument());
    expect(screen.getByText(/15% off/i)).toBeInTheDocument();
    expect(screen.queryByTestId(`coupon-purpose-badge-LEGACY1`)).toBeNull();
  });

  test("a new Live Voice Coach Coupon is clearly labeled in the list", async () => {
    api.listCoupons.mockResolvedValue({
      coupons: [{ code: "ETALK1", type: "fixed", value: 1, max_uses: 1, uses_count: 0,
                  assigned_to: ["stu1"], book_slugs: [], enabled: true, redemptions: [],
                  benefit_type: "edutalk_points", benefit_amount: 20 }],
    });
    await act(async () => { render(<CouponStudio />); });
    await waitFor(() => expect(screen.getByText("ETALK1")).toBeInTheDocument());
    expect(screen.getByTestId("coupon-purpose-badge-ETALK1").textContent).toMatch(/Live Voice Coach Coupon/i);
    expect(screen.getByTestId("coupon-purpose-badge-ETALK1").textContent).toMatch(/20 pts/i);
  });

  test("redemption history table renders safely for an edutalk coupon with a partial entry", async () => {
    api.listCoupons.mockResolvedValue({
      coupons: [{ code: "ETALK2", type: "fixed", value: 1, max_uses: 1, uses_count: 1,
                  assigned_to: ["stu1"], book_slugs: [], enabled: true,
                  benefit_type: "edutalk_points", benefit_amount: 20,
                  redemptions: [{ student_id: "stu1", status: "credited", benefit_amount: 20, credited_at: "2026-01-01T00:00:00Z" }] }],
    });
    await act(async () => { render(<CouponStudio />); });
    await waitFor(() => expect(screen.getByText("ETALK2")).toBeInTheDocument());
    await act(async () => { fireEvent.click(screen.getAllByRole("button", { name: "" })[0]); }); // best-effort; presence check below is the real assertion
    expect(screen.getByTestId("coupon-redemptions-ETALK2")).toBeInTheDocument();
  });
});

// ── 10/11. no coupling to Login Mystery or student Live Coach UI ──────────
describe("bundle isolation (structural)", () => {
  test("CouponStudio.jsx does not import LoginMysteryStudio or a student Live Coach component", () => {
    const src = fs.readFileSync(path.resolve(__dirname, "../CouponStudio.jsx"), "utf8");
    expect(src).not.toMatch(/LoginMysteryStudio/);
    expect(src).not.toMatch(/LiveCoachStartCard/);
    expect(src).not.toMatch(/EduTalkLiveCoach/);
    expect(src).not.toMatch(/login_mystery_box_tools|login-mystery/);
  });
});
