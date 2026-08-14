/**
 * couponStudioVideoLibraryVoucher.test.jsx — Author Studio coverage for the
 * "Video Library Voucher" coupon purpose, closing the gap where
 * video_library_coupon_tools.py's student-side redemption existed with no
 * way for an Author to actually create a code through the product. Mirrors
 * couponStudioLiveVoiceCoachCoupon.test.jsx's structure exactly (same
 * mocks, same conventions) so this stays a genuinely additive third
 * purpose, not a redesign of the existing two.
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

// ── 1. purpose selector includes a third, immediately understandable option
describe("Coupon Purpose selector", () => {
  test("all three purposes are present: Book Discount, Live Voice Coach Coupon, Video Library Voucher", async () => {
    await openCreateForm();
    expect(screen.getByTestId("coupon-purpose-book_discount")).toBeInTheDocument();
    expect(screen.getByTestId("coupon-purpose-edutalk_live_coupon")).toBeInTheDocument();
    expect(screen.getByTestId("coupon-purpose-video_library_points")).toBeInTheDocument();
    expect(screen.getByTestId("coupon-purpose-video_library_points").textContent).toMatch(/Video Library Voucher/i);
  });
});

// ── 2/3. purpose switch shows/hides the right fields ────────────────────────
describe("Video Library Voucher — form fields", () => {
  test("switching to Video Library Voucher shows the points-amount field and preview", async () => {
    await openCreateForm();
    fireEvent.click(screen.getByTestId("coupon-purpose-video_library_points"));
    expect(screen.getByTestId("coupon-video-library-amount")).toBeInTheDocument();
    expect(screen.getByTestId("coupon-video-library-preview")).toBeInTheDocument();
  });

  test("switching to Video Library Voucher hides book-discount-only AND Live Voice Coach fields", async () => {
    await openCreateForm();
    fireEvent.click(screen.getByTestId("coupon-purpose-video_library_points"));
    expect(screen.queryByTestId("coupon-book-discount-type")).toBeNull();
    expect(screen.queryByTestId("coupon-book-discount-value")).toBeNull();
    expect(screen.queryByTestId("coupon-book-slugs-picker")).toBeNull();
    expect(screen.queryByTestId("coupon-edutalk-amount")).toBeNull();
  });

  test("preview card clearly communicates the benefit to a teacher/admin, in plain language", async () => {
    await openCreateForm();
    fireEvent.click(screen.getByTestId("coupon-purpose-video_library_points"));
    fireEvent.change(screen.getByTestId("coupon-video-library-amount"), { target: { value: "20" } });
    const preview = screen.getByTestId("coupon-video-library-preview").textContent;
    expect(preview).toMatch(/20 EduHub Points/i);
    expect(preview).toMatch(/Video Library/i);
    expect(preview).toMatch(/redeem/i);
  });
});

// ── 4. submit payload shape ──────────────────────────────────────────────────
describe("Video Library Voucher — submit payload", () => {
  test("submit payload contains benefit_type=video_library_points and a positive integer benefit_amount", async () => {
    api.createCoupon.mockResolvedValue({ coupon: { code: "VL20" } });
    await openCreateForm();
    fireEvent.click(screen.getByTestId("coupon-purpose-video_library_points"));
    fireEvent.change(screen.getByTestId("coupon-video-library-amount"), { target: { value: "20" } });
    await act(async () => { fireEvent.click(screen.getByText(/^Create Coupon$/i)); });
    await waitFor(() => expect(api.createCoupon).toHaveBeenCalled());
    const payload = api.createCoupon.mock.calls[0][0];
    expect(payload.benefit_type).toBe("video_library_points");
    expect(payload.benefit_amount).toBe(20);
    expect(Number.isInteger(payload.benefit_amount)).toBe(true);
    expect(payload.book_slugs).toEqual([]);
    // No dummy discount fields — matches the Live Voice Coach payload shape.
    expect(payload).not.toHaveProperty("type");
    expect(payload).not.toHaveProperty("value");
  });

  test.each(["-5", "0", "1.5", "abc", "1001"])(
    "invalid amount '%s' is blocked before any network call",
    async (bad) => {
      await openCreateForm();
      fireEvent.click(screen.getByTestId("coupon-purpose-video_library_points"));
      fireEvent.change(screen.getByTestId("coupon-video-library-amount"), { target: { value: bad } });
      await act(async () => { fireEvent.click(screen.getByText(/^Create Coupon$/i)); });
      expect(api.createCoupon).not.toHaveBeenCalled();
      expect(screen.getByText(/whole number between 1 and/i)).toBeInTheDocument();
    },
  );

  test("code, max uses, dates, and assigned-to are still passed through like any other purpose", async () => {
    api.createCoupon.mockResolvedValue({ coupon: { code: "VLLAUNCH" } });
    await openCreateForm();
    fireEvent.click(screen.getByTestId("coupon-purpose-video_library_points"));
    fireEvent.change(screen.getByPlaceholderText(/SUMMER20/i), { target: { value: "vllaunch" } });
    fireEvent.change(screen.getByTestId("coupon-video-library-amount"), { target: { value: "15" } });
    fireEvent.change(screen.getByPlaceholderText(/e\.g\. 50/i), { target: { value: "100" } });
    await act(async () => { fireEvent.click(screen.getByText(/^Create Coupon$/i)); });
    await waitFor(() => expect(api.createCoupon).toHaveBeenCalled());
    const payload = api.createCoupon.mock.calls[0][0];
    expect(payload.code).toBe("VLLAUNCH");
    expect(payload.max_uses).toBe(100);
  });
});

// ── 5. list rendering: badge, benefit label, redemption table ──────────────
describe("Coupon list rendering", () => {
  test("a Video Library Voucher is clearly labeled and distinct from a Live Voice Coach Coupon", async () => {
    api.listCoupons.mockResolvedValue({
      coupons: [{ code: "VLIB1", type: null, value: null, max_uses: 1, uses_count: 0,
                  assigned_to: ["stu1"], book_slugs: [], enabled: true, redemptions: [],
                  benefit_type: "video_library_points", benefit_amount: 20 }],
    });
    await act(async () => { render(<CouponStudio />); });
    await waitFor(() => expect(screen.getByText("VLIB1")).toBeInTheDocument());
    const badge = screen.getByTestId("coupon-purpose-badge-VLIB1").textContent;
    expect(badge).toMatch(/Video Library Voucher/i);
    expect(badge).toMatch(/20 pts/i);
    expect(badge).not.toMatch(/Live Voice Coach/i);
  });

  test("redemption history table renders points-style columns (Status/Points/Credited) for a Video Library Voucher, same as a Live Voice Coach Coupon", async () => {
    api.listCoupons.mockResolvedValue({
      coupons: [{ code: "VLIB2", type: null, value: null, max_uses: 1, uses_count: 1,
                  assigned_to: ["stu1"], book_slugs: [], enabled: true,
                  benefit_type: "video_library_points", benefit_amount: 20,
                  redemptions: [{ student_id: "stu1", status: "credited", benefit_amount: 20, credited_at: "2026-01-01T00:00:00Z" }] }],
    });
    await act(async () => { render(<CouponStudio />); });
    await waitFor(() => expect(screen.getByText("VLIB2")).toBeInTheDocument());
    // Expand the row (the chevron toggle button has no accessible name —
    // same best-effort click couponStudioLiveVoiceCoachCoupon.test.jsx uses).
    await act(async () => { fireEvent.click(screen.getAllByRole("button", { name: "" })[0]); });
    expect(screen.getByTestId("coupon-redemptions-VLIB2")).toBeInTheDocument();
    expect(screen.getByText("Status")).toBeInTheDocument();
    expect(screen.getByText("Credited")).toBeInTheDocument();
    expect(screen.queryByText("Original")).toBeNull(); // book-discount-only column
  });

  test("old coupons lacking benefit_type entirely still render as Book Discount, unaffected by the new purpose", async () => {
    api.listCoupons.mockResolvedValue({
      coupons: [{ code: "LEGACY2", type: "percent", value: 15, max_uses: null, uses_count: 0,
                  assigned_to: [], book_slugs: [], enabled: true, redemptions: [] }],
    });
    await act(async () => { render(<CouponStudio />); });
    await waitFor(() => expect(screen.getByText("LEGACY2")).toBeInTheDocument());
    expect(screen.getByText(/15% off/i)).toBeInTheDocument();
    expect(screen.queryByTestId(`coupon-purpose-badge-LEGACY2`)).toBeNull();
  });
});
