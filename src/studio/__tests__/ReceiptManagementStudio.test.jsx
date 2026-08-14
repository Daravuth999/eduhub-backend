import { render, screen, waitFor, fireEvent, act } from "@testing-library/react";
import ReceiptManagementStudio from "../ReceiptManagementStudio";
import {
  searchTuitionReceipts, regenerateTuitionReceiptFile, backfillInvoiceNumbers,
} from "../tuitionAdminApi";

jest.mock("../tuitionAdminApi", () => ({
  searchTuitionReceipts: jest.fn(),
  regenerateTuitionReceiptFile: jest.fn(),
  backfillInvoiceNumbers: jest.fn(),
  getToken: () => "test-token",
  url: (path) => `https://backend.test${path}`,
}));

const RECEIPT = {
  receipt_id: "rcpt_1",
  invoice_number: "INV-2026-000001",
  clean_id: "seyma.kann",
  amount_usd: 18,
  method: "khqr",
  confirmed_at: "2026-08-01T12:00:00Z",
};

beforeEach(() => {
  jest.clearAllMocks();
  searchTuitionReceipts.mockResolvedValue({ receipts: [RECEIPT], total: 1, unbackfilled: 0 });
  global.fetch = jest.fn().mockResolvedValue({
    ok: true,
    blob: async () => new Blob(["fake"], { type: "application/pdf" }),
  });
  global.URL.createObjectURL = jest.fn(() => "blob:mock-url");
  global.URL.revokeObjectURL = jest.fn();
});

async function renderPanel() {
  await act(async () => { render(<ReceiptManagementStudio />); });
  await waitFor(() => expect(screen.queryByText(/Loading receipts/i)).toBeNull());
}

test("loads and renders a receipt row with its invoice number", async () => {
  await renderPanel();
  expect(searchTuitionReceipts).toHaveBeenCalled();
  expect(screen.getByText("INV-2026-000001")).toBeInTheDocument();
  expect(screen.getByText("seyma.kann")).toBeInTheDocument();
});

test("empty result renders the honest empty state, not fake content", async () => {
  searchTuitionReceipts.mockResolvedValue({ receipts: [], total: 0, unbackfilled: 0 });
  await renderPanel();
  expect(screen.getByTestId("receipt-empty")).toBeInTheDocument();
});

test("failed search shows an error banner", async () => {
  searchTuitionReceipts.mockRejectedValue(new Error("network down"));
  await renderPanel();
  await waitFor(() => expect(screen.getByText("network down")).toBeInTheDocument());
});

test("changing a filter re-queries with the expected params", async () => {
  await renderPanel();
  fireEvent.change(screen.getByTestId("receipt-filter-student"), { target: { value: "sid42" } });
  await waitFor(() => {
    const lastCall = searchTuitionReceipts.mock.calls.at(-1)[0];
    expect(lastCall.student_id).toBe("sid42");
  });
});

test("backfill banner only renders when unbackfilled > 0", async () => {
  searchTuitionReceipts.mockResolvedValue({ receipts: [RECEIPT], total: 1, unbackfilled: 3 });
  await renderPanel();
  expect(screen.getByTestId("receipt-backfill-banner")).toBeInTheDocument();
  expect(screen.getByText(/3 receipts predate/)).toBeInTheDocument();
});

test("backfill banner is absent when unbackfilled is 0", async () => {
  await renderPanel();
  expect(screen.queryByTestId("receipt-backfill-banner")).not.toBeInTheDocument();
});

test("clicking Backfill Invoice Numbers calls the API and reloads", async () => {
  searchTuitionReceipts.mockResolvedValue({ receipts: [RECEIPT], total: 1, unbackfilled: 2 });
  backfillInvoiceNumbers.mockResolvedValue({ assigned: 2 });
  await renderPanel();
  await act(async () => { fireEvent.click(screen.getByTestId("receipt-backfill-btn")); });
  expect(backfillInvoiceNumbers).toHaveBeenCalled();
  await waitFor(() => expect(screen.getByText(/Assigned 2 invoice numbers/)).toBeInTheDocument());
});

test("download PDF fetches the authenticated binary endpoint and triggers a download", async () => {
  await renderPanel();
  await act(async () => { fireEvent.click(screen.getByTestId("receipt-download-pdf")); });
  await waitFor(() => expect(global.fetch).toHaveBeenCalledWith(
    "https://backend.test/api/admin/tuition/receipt/rcpt_1/pdf",
    expect.objectContaining({ headers: { Authorization: "Bearer test-token" } }),
  ));
  expect(global.URL.createObjectURL).toHaveBeenCalled();
});

test("regenerate calls the API and never sends any body (file-only, no financial fields)", async () => {
  regenerateTuitionReceiptFile.mockResolvedValue({ ok: true, pdf_bytes: 100, png_bytes: 200 });
  await renderPanel();
  await act(async () => { fireEvent.click(screen.getByTestId("receipt-regenerate")); });
  expect(regenerateTuitionReceiptFile).toHaveBeenCalledWith("rcpt_1");
  await waitFor(() => expect(searchTuitionReceipts).toHaveBeenCalledTimes(2)); // initial load + reload after regenerate
});

test("a failed download shows a row-level error without crashing the panel", async () => {
  global.fetch = jest.fn().mockResolvedValue({ ok: false, status: 404 });
  await renderPanel();
  await act(async () => { fireEvent.click(screen.getByTestId("receipt-download-pdf")); });
  await waitFor(() => expect(screen.getByText(/Failed to fetch PDF/)).toBeInTheDocument());
});
